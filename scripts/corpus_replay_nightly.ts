/**
 * Corpus replay flywheel — nightly BOX orchestrator (Joe-approved 2026-07-05).
 *
 * Runs the offline readiness sweep ON THE INSTANCE so it survives without a laptop session:
 *   1. SKIP-IF-UNCHANGED: a sweep measures code readiness — if the deployed commit hasn't moved
 *      since the last sweep, there's nothing new to measure (judge re-rolls only add noise and
 *      cost). Forced weekly (UTC Monday = Sunday night ET) or with FORCE=1.
 *   2. Snapshot the store LOCALLY (cp within the box — PII never leaves the instance).
 *   3. Replay every conversation's last inbound through the DEPLOYED dist via
 *      inbound_shadow_replay --last-turn-only (the box OOMs on tsc builds; the deploy already
 *      ships services/api/dist, so no build happens here — the replay errors out cleanly if
 *      dist is missing).
 *   4. Judge + score via corpus_replay_flywheel (judge cache under REPORT_ROOT makes unchanged
 *      drafts free; MAX_JUDGE caps LLM spend).
 *   5. Findings land in REPORT_ROOT/corpus_replay/latest.json (OutcomeAnomaly shape) — the
 *      8:55 UTC anomaly_loop_detect merges them into next.json like every other sibling feed,
 *      so the autonomous loop consumes flywheel findings with no human in the loop.
 *
 * Cron (documented in docs/autonomous_coding_loop.md):
 *   0 5 * * * — 05:00 UTC (1:00am ET): store quiet, hours before the 8:15-8:56 report crons.
 *
 * Usage:
 *   npx tsx scripts/corpus_replay_nightly.ts [--self-test]
 *   env: REPORT_ROOT (required), DATA_DIR (required), FORCE=1 (skip the skip),
 *        MAX_JUDGE (default 600), REPLAY_LIMIT (default 700), LLM_ENABLED=1 + OPENAI_API_KEY
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

export type SweepGate = {
  run: boolean;
  reason: string;
};

/**
 * Pure gate: run when the deployed commit moved since the last sweep, when forced, or on the
 * weekly confirmation day (UTC Monday = Sunday night ET). Fail-direction: an unreadable last-sweep
 * record or missing commit RUNS the sweep (never silently skip on uncertainty).
 */
export function shouldRunSweep(args: {
  headCommit: string | null;
  lastSweepCommit: string | null;
  forced: boolean;
  utcDay: number; // 0=Sun..6=Sat
}): SweepGate {
  if (args.forced) return { run: true, reason: "forced (FORCE=1)" };
  if (args.utcDay === 1) return { run: true, reason: "weekly confirmation sweep (UTC Monday = Sunday night ET)" };
  if (!args.headCommit) return { run: true, reason: "cannot resolve HEAD — fail toward measuring" };
  if (!args.lastSweepCommit) return { run: true, reason: "no prior sweep recorded" };
  if (args.headCommit !== args.lastSweepCommit) {
    return { run: true, reason: `code moved since last sweep (${args.lastSweepCommit.slice(0, 8)} -> ${args.headCommit.slice(0, 8)})` };
  }
  return { run: false, reason: `unchanged since last sweep (${args.headCommit.slice(0, 8)}) — nothing new to measure` };
}

function sh(cmd: string, cmdArgs: string[], opts: { env?: NodeJS.ProcessEnv; cwd?: string } = {}): string {
  return execFileSync(cmd, cmdArgs, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, ...(opts.env ?? {}) },
    cwd: opts.cwd
  });
}

async function main() {
  const reportRoot = String(process.env.REPORT_ROOT ?? "").trim();
  const dataDir = String(process.env.DATA_DIR ?? "").trim();
  if (!reportRoot || !dataDir) {
    console.error("corpus_replay_nightly needs REPORT_ROOT and DATA_DIR.");
    process.exit(2);
  }
  if (process.env.LLM_ENABLED !== "1" || !process.env.OPENAI_API_KEY) {
    console.error("corpus_replay_nightly needs LLM_ENABLED=1 and OPENAI_API_KEY (judge).");
    process.exit(2);
  }
  const outDir = path.join(reportRoot, "corpus_replay");
  fs.mkdirSync(outDir, { recursive: true });

  // 1) Skip-if-unchanged gate.
  let headCommit: string | null = null;
  try {
    headCommit = sh("git", ["rev-parse", "HEAD"]).trim() || null;
  } catch {
    headCommit = null;
  }
  const lastSweepPath = path.join(outDir, "last_sweep.json");
  let lastSweepCommit: string | null = null;
  try {
    lastSweepCommit = JSON.parse(fs.readFileSync(lastSweepPath, "utf8"))?.commit ?? null;
  } catch {
    lastSweepCommit = null;
  }
  const gate = shouldRunSweep({
    headCommit,
    lastSweepCommit,
    forced: process.env.FORCE === "1",
    utcDay: new Date().getUTCDay()
  });
  console.log(`[flywheel-nightly] gate: ${gate.reason}`);
  if (!gate.run) return;

  // 2) Local snapshot (PII stays on the instance; cleaned up in finally).
  const snapDir = fs.mkdtempSync(path.join(os.tmpdir(), "corpus-replay-snap-"));
  try {
    fs.copyFileSync(path.join(dataDir, "conversations.json"), path.join(snapDir, "conversations.json"));
    const settingsSrc = path.join(dataDir, "settings.json");
    if (fs.existsSync(settingsSrc)) fs.copyFileSync(settingsSrc, path.join(snapDir, "settings.json"));

    // 3) Replay against the DEPLOYED dist (no build on the box).
    const distPath = path.join("services", "api", "dist", "index.js");
    if (!fs.existsSync(distPath)) {
      console.error(`[flywheel-nightly] ${distPath} missing — deploy ships it; aborting without a sweep.`);
      process.exit(1);
    }
    const replayLimit = String(Number(process.env.REPLAY_LIMIT ?? 700) || 700);
    const replaysDir = path.join(outDir, "replays");
    sh("npx", [
      "tsx",
      "scripts/inbound_shadow_replay.ts",
      "--data-dir",
      snapDir,
      "--since-days",
      "3650",
      "--limit",
      replayLimit,
      "--last-turn-only",
      "--out-dir",
      replaysDir
    ]);
    const newest = fs
      .readdirSync(replaysDir)
      .filter(f => f.startsWith("inbound-shadow-") && f.endsWith(".json"))
      .sort()
      .pop();
    if (!newest) {
      console.error("[flywheel-nightly] replay produced no report; aborting.");
      process.exit(1);
    }

    // 4) Judge + score (cache under outDir keeps unchanged drafts free).
    const maxJudge = String(Number(process.env.MAX_JUDGE ?? 600) || 600);
    sh("npx", [
      "tsx",
      "scripts/corpus_replay_flywheel.ts",
      "--replay-json",
      path.join(replaysDir, newest),
      "--data-dir",
      snapDir,
      "--out-dir",
      outDir,
      "--max-judge",
      maxJudge
    ]);

    // 5) Record the sweep (drives the next skip-if-unchanged decision).
    let summary: any = null;
    try {
      summary = JSON.parse(fs.readFileSync(path.join(outDir, "summary.json"), "utf8"));
    } catch {
      summary = null;
    }
    fs.writeFileSync(
      lastSweepPath,
      `${JSON.stringify({ commit: headCommit, generatedAt: new Date().toISOString(), replay: newest, thresholds: summary?.thresholds ?? null, passRate: summary?.passRate ?? null }, null, 2)}\n`
    );
    console.log(`[flywheel-nightly] sweep complete @ ${headCommit?.slice(0, 8)} — findings in ${path.join(outDir, "latest.json")}`);
  } finally {
    fs.rmSync(snapDir, { recursive: true, force: true });
  }
}

function selfTest() {
  const fail = (label: string) => {
    console.error(`SELF-TEST FAIL: ${label}`);
    process.exit(1);
  };
  const base = { headCommit: "aaaa1111", lastSweepCommit: "aaaa1111", forced: false, utcDay: 3 };
  if (shouldRunSweep(base).run) fail("unchanged commit on a weekday must skip");
  if (!shouldRunSweep({ ...base, headCommit: "bbbb2222" }).run) fail("moved commit must run");
  if (!shouldRunSweep({ ...base, forced: true }).run) fail("FORCE=1 must run");
  if (!shouldRunSweep({ ...base, utcDay: 1 }).run) fail("UTC Monday (Sunday night ET) must run the weekly confirmation");
  if (!shouldRunSweep({ ...base, headCommit: null }).run) fail("unresolvable HEAD must fail toward measuring");
  if (!shouldRunSweep({ ...base, lastSweepCommit: null }).run) fail("missing last-sweep record must run");
  console.log("corpus replay nightly self-test OK (sweep gate table)");
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  if (process.argv.includes("--self-test")) {
    selfTest();
  } else {
    main().catch(err => {
      console.error(err?.stack ?? err?.message ?? err);
      process.exit(1);
    });
  }
}
