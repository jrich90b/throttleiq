/**
 * canary_watch — watch a deploy, and say plainly whether it hurt anyone.
 *
 * Joe, 2026-08-01: "Is there a way to continuously work without me approving PRs."
 *
 * This is the other half of that answer. `decision_equivalence` proves a change is safe to ship;
 * this checks whether it WAS, by comparing what the agent actually did to customers before and
 * after. Autonomy is not made safe by a gate in front — it is made safe by being reversible with
 * detection behind. See services/api/src/domain/canaryHealth.ts for the reasoning and fail
 * direction.
 *
 * SHADOW BY DEFAULT. `judge` prints the verdict and, when something regressed, the exact rollback
 * commands, and stops there. `judge --act` carries the rollback out — that is the readiness loop's
 * delegated deploy authority (Joe, 2026-08-01: hands-off), never something a bare run does by
 * accident. The rollback is a `git revert` of the one commit, NOT a checkout of an older tree, so
 * anything merged after the bad deploy survives it.
 *
 * THE HALF THAT WAS MISSING UNTIL 2026-08-02. `baseline`/`check` take file paths, and every run
 * pointed them at /tmp — so a baseline captured at deploy time was gone before its window closed,
 * and NO deploy was ever actually judged. The canary watched, and then forgot. `arm`/`judge`/
 * `status` are the same machinery with somewhere durable to keep the answer, which is what makes
 * the loop's rate limit real: no second BEHAVIOUR deploy until the previous one comes back HEALTHY.
 *
 *   # at deploy time
 *   REPORT_ROOT=... CONVERSATIONS_DB_PATH=/tmp/c.json npx tsx scripts/canary_watch.ts arm
 *   # once the window (default 48h — this store sends ~26/day) has elapsed
 *   REPORT_ROOT=... CONVERSATIONS_DB_PATH=/tmp/c.json npx tsx scripts/canary_watch.ts judge [--act]
 *   # "may another behaviour deploy go out?" — exit 0 = yes, anything else = no
 *   REPORT_ROOT=... npx tsx scripts/canary_watch.ts status
 *
 * The one-shot file forms are kept for ad-hoc use:
 *   npx tsx scripts/canary_watch.ts baseline --out /tmp/canary.json
 *   npx tsx scripts/canary_watch.ts check --baseline /tmp/canary.json
 *
 * NEVER point CONVERSATIONS_DB_PATH at the live store: copy it, read the copy, delete the copy. It
 * is customer PII.
 *
 * EXIT CODES: 0 healthy · 1 regressed · 2 unknown/blocked. UNKNOWN is deliberately NOT 0 — a run
 * that concluded nothing must never be scriptable as success.
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  computeCanaryCounters,
  decideCanaryVerdict,
  detectRunaway,
  findDeadCounters,
  typicalPeakOutboundPerHour,
  buildRevertPlan,
  decideCanaryGate,
  DEFAULT_CANARY_THRESHOLDS,
  type CanaryCounters,
  type CanaryVerdict
} from "../services/api/src/domain/canaryHealth.ts";

type BaselineFile = {
  takenAtMs: number;
  windowMs: number;
  deployedSha: string;
  counters: CanaryCounters;
  /** The store's own busiest hour, so the fast tripwire scales with the dealership. */
  typicalPeakOutboundPerHour: number;
};

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

// -------------------------------------------------------------------------------------------------
// THE CANARY'S MEMORY.
//
// `baseline`/`check` take file paths, and every run so far pointed them at /tmp — so a baseline
// captured at deploy time was gone before its window closed and NO deploy was ever actually judged.
// `arm`/`judge`/`status` are the same machinery with somewhere durable to keep the answer:
//
//   <report root>/canary/pending.json    the deploy currently being watched (absent = none)
//   <report root>/canary/history.jsonl   one line per judged deploy, append-only
//
// Report root follows the same env var the other reports use, so on the box this lands beside them.
// -------------------------------------------------------------------------------------------------
function canaryDir(): string {
  const root =
    arg("report-root") || process.env.REPORT_ROOT || path.resolve("reports");
  return path.join(root, "canary");
}
const pendingPath = () => path.join(canaryDir(), "pending.json");
const historyPath = () => path.join(canaryDir(), "history.jsonl");

function readPending(): BaselineFile | null {
  const p = pendingPath();
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    // A corrupt pending file must NOT read as "nothing pending" — that would open the gate.
    console.error(`canary_watch: ${p} is unreadable. Treating it as an OPEN canary, not a clear one.`);
    return { takenAtMs: 0, windowMs: Number.MAX_SAFE_INTEGER, deployedSha: "", counters: {} as CanaryCounters, typicalPeakOutboundPerHour: 0 };
  }
}

function lastJudgedStatus(): CanaryVerdict["status"] | null {
  const p = historyPath();
  if (!fs.existsSync(p)) return null;
  const lines = fs.readFileSync(p, "utf8").trim().split("\n").filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const row = JSON.parse(lines[i]);
      if (row?.status) return row.status;
    } catch {
      /* skip a torn line and keep looking back */
    }
  }
  return null;
}

function appendHistory(row: Record<string, unknown>): void {
  fs.mkdirSync(canaryDir(), { recursive: true });
  fs.appendFileSync(historyPath(), `${JSON.stringify(row)}\n`);
}

function loadConversations(): any[] {
  const dbPath =
    process.env.CONVERSATIONS_DB_PATH ||
    (process.env.DATA_DIR
      ? path.join(process.env.DATA_DIR, "conversations.json")
      : path.resolve("services/api/data/conversations.json"));
  if (!fs.existsSync(dbPath)) {
    console.error(`canary_watch: conversations store not found at ${dbPath}`);
    process.exit(2);
  }
  const raw = JSON.parse(fs.readFileSync(dbPath, "utf8"));
  const convs: any[] = Array.isArray(raw) ? raw : (raw?.conversations ?? []);
  if (!convs.length) {
    // Fail closed: an empty store cannot clear a deploy.
    console.error("canary_watch: the store is empty — a canary that measured nothing proves nothing");
    process.exit(2);
  }
  return convs;
}

function currentSha(): string {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

const nowMs = (() => {
  const override = arg("now");
  if (!override) return Date.now();
  const t = Date.parse(override);
  if (!Number.isFinite(t)) {
    console.error(`canary_watch: --now "${override}" is not a valid ISO timestamp`);
    process.exit(2);
  }
  return t;
})();

const mode = process.argv[2];

/** Capture the "before" counters. Shared by `baseline` (file out) and `arm` (durable). */
function captureBaseline(hours: number): BaselineFile {
  const windowMs = Math.max(1, hours) * 3_600_000;
  const conversations = loadConversations();

  // FAIL CLOSED on broken instrumentation. A counter reading zero across the whole store is not a
  // quiet period, it is a counter wired to the wrong field — which is exactly how the first version
  // of this tool shipped counting nothing while passing its own tests.
  const dead = findDeadCounters(conversations);
  if (dead.length) {
    console.error(
      `canary_watch: these counters read ZERO across the ENTIRE store: ${dead.join(", ")}.\n` +
        "  That is unwired instrumentation, not a quiet period. A baseline built on dead counters\n" +
        "  would clear any deploy. Fix the projection in domain/canaryHealth.ts before using this."
    );
    process.exit(2);
  }

  return {
    takenAtMs: nowMs,
    windowMs,
    deployedSha: arg("sha") ?? currentSha(),
    counters: computeCanaryCounters(conversations, { startMs: nowMs - windowMs, endMs: nowMs }),
    typicalPeakOutboundPerHour: typicalPeakOutboundPerHour(conversations)
  };
}

if (mode === "baseline") {
  const out = arg("out");
  if (!out) {
    console.error("canary_watch baseline --out <file> [--hours N] [--now <iso>]");
    process.exit(2);
  }
  // 48h, not 6: this store sends ~26 customer messages a DAY (36 over 48h, 10 over a quiet 24h), so
  // anything shorter routinely falls under the 20-send floor and abstains. Measured, not assumed.
  const hours = Number(arg("hours") ?? 48) || 48;
  const payload = captureBaseline(hours);
  const counters = payload.counters;
  fs.writeFileSync(out, JSON.stringify(payload, null, 2));
  console.log(
    `canary baseline over the ${hours}h before the deploy -> ${out}\n` +
      `  sends=${counters.outboundToCustomer} drafts=${counters.draftsProduced} ` +
      `closed=${counters.conversationsClosed} held=${counters.draftsHeld} ` +
      `convs=${counters.activeConversations} · typical busy hour=${payload.typicalPeakOutboundPerHour}/h`
  );
  if (counters.outboundToCustomer < DEFAULT_CANARY_THRESHOLDS.minBaselineOutbound) {
    console.log(
      "  NOTE: too quiet to judge a deploy against " +
        `(${counters.outboundToCustomer} < ${DEFAULT_CANARY_THRESHOLDS.minBaselineOutbound} sends). ` +
        "The slow check will return UNKNOWN — widen --hours. The fast runaway tripwire still works."
    );
  }
  process.exit(0);
}

/**
 * Judge a captured baseline against what has happened since, and PRINT the comparison.
 * Returns null when the window has not elapsed — not-yet-ready is never a verdict.
 */
function judgeBaseline(baseline: BaselineFile): CanaryVerdict | null {
  const watchEndMs = baseline.takenAtMs + baseline.windowMs;

  // Judging a half-elapsed window would compare a partial period against a full one and invent a
  // "collapse" every time. Not yet ready is UNKNOWN, never healthy.
  if (nowMs < watchEndMs) {
    const minsLeft = Math.ceil((watchEndMs - nowMs) / 60_000);
    console.log(
      `canary: UNKNOWN — the watch window has not elapsed (${minsLeft} min left).\n` +
        "  A partial window compared against a full one reads as a collapse. Re-run later."
    );
    return null;
  }

  const conversations = loadConversations();
  const current = computeCanaryCounters(conversations, {
    startMs: baseline.takenAtMs,
    endMs: watchEndMs
  });
  const runaway = detectRunaway(
    current.outboundToCustomer,
    baseline.windowMs,
    baseline.typicalPeakOutboundPerHour ?? typicalPeakOutboundPerHour(conversations)
  );
  const verdict = decideCanaryVerdict(baseline.counters, current, DEFAULT_CANARY_THRESHOLDS, runaway);

  const row = (label: string, c: CanaryCounters) =>
    `  ${label.padEnd(7)} sends=${c.outboundToCustomer} drafts=${c.draftsProduced} ` +
    `closed=${c.conversationsClosed} held=${c.draftsHeld} convs=${c.activeConversations}`;
  console.log(
    `canary check — ${baseline.windowMs / 3_600_000}h window, sha ${baseline.deployedSha.slice(0, 8) || "(unrecorded)"}` +
      ` · ${runaway.perHour}/h vs runaway ceiling ${runaway.limit}/h`
  );
  console.log(row("before", baseline.counters));
  console.log(row("after", current));
  console.log();

  if (verdict.status === "unknown") {
    console.log("canary: UNKNOWN — this is NOT a clean bill of health.");
    for (const b of verdict.blockers) console.log(`  - ${b}`);
  } else if (verdict.status === "regressed") {
    console.log("canary: REGRESSED — the deploy moved guarded counters past their limits:");
    for (const b of verdict.breaches) console.log(`  - [${b.kind}] ${b.detail}`);
  } else {
    console.log(`canary: HEALTHY — ${verdict.reason}`);
  }
  return verdict;
}

if (mode === "check") {
  const baselinePath = arg("baseline");
  if (!baselinePath || !fs.existsSync(baselinePath)) {
    console.error("canary_watch check --baseline <file> [--now <iso>]");
    process.exit(2);
  }
  const baseline: BaselineFile = JSON.parse(fs.readFileSync(baselinePath, "utf8"));
  const verdict = judgeBaseline(baseline);
  if (!verdict) process.exit(2);
  if (verdict.status === "unknown") process.exit(2);
  if (verdict.status === "regressed") {
    console.log("\nROLLBACK PLAN (shadow mode — NOT executed):");
    for (const line of buildRevertPlan(verdict, baseline.deployedSha)) console.log(`  ${line}`);
    process.exit(1);
  }
  process.exit(0);
}

// -------------------------------------------------------------------------------------------------
// arm — capture the baseline AND remember it, so something can come back and judge this deploy.
// -------------------------------------------------------------------------------------------------
if (mode === "arm") {
  const existing = readPending();
  if (existing && !flag("replace")) {
    const gate = decideCanaryGate({ pending: existing, nowMs });
    console.error(
      `canary_watch arm: refusing — ${gate.reason}.\n` +
        "  Judge it first (`canary_watch judge`). Arming over an open canary would discard the only\n" +
        "  record of what the previous deploy was being measured against. Pass --replace to override."
    );
    process.exit(2);
  }
  const hours = Number(arg("hours") ?? 48) || 48;
  const payload = captureBaseline(hours);
  fs.mkdirSync(canaryDir(), { recursive: true });
  fs.writeFileSync(pendingPath(), JSON.stringify(payload, null, 2));
  const c = payload.counters;
  console.log(
    `canary ARMED on ${payload.deployedSha.slice(0, 8) || "(unrecorded)"} — ${hours}h window -> ${pendingPath()}\n` +
      `  before: sends=${c.outboundToCustomer} drafts=${c.draftsProduced} closed=${c.conversationsClosed} ` +
      `held=${c.draftsHeld} convs=${c.activeConversations} · typical busy hour=${payload.typicalPeakOutboundPerHour}/h`
  );
  if (c.outboundToCustomer < DEFAULT_CANARY_THRESHOLDS.minBaselineOutbound) {
    console.log(
      "  NOTE: too quiet to judge a deploy against " +
        `(${c.outboundToCustomer} < ${DEFAULT_CANARY_THRESHOLDS.minBaselineOutbound} sends). ` +
        "The judgement will return UNKNOWN — widen --hours."
    );
  }
  process.exit(0);
}

// -------------------------------------------------------------------------------------------------
// judge — the half that never existed. Read the pending canary, decide, RECORD the verdict, and on
// REGRESSED either print the rollback (default) or carry it out (--act).
// -------------------------------------------------------------------------------------------------
if (mode === "judge") {
  const baseline = readPending();
  if (!baseline) {
    console.error("canary_watch judge: nothing is pending — no deploy is being watched.");
    process.exit(2);
  }
  const verdict = judgeBaseline(baseline);
  if (!verdict) process.exit(2); // window still open; pending stays exactly where it is

  appendHistory({
    judgedAtMs: nowMs,
    judgedAtIso: new Date(nowMs).toISOString(),
    deployedSha: baseline.deployedSha,
    windowHours: baseline.windowMs / 3_600_000,
    status: verdict.status,
    reason: verdict.reason,
    breaches: verdict.breaches,
    blockers: verdict.blockers,
    reverted: false
  });

  if (verdict.status === "healthy") {
    // Only a HEALTHY verdict clears the deck for the next behaviour deploy.
    fs.rmSync(pendingPath(), { force: true });
    console.log("\ncanary: recorded HEALTHY — the gate is open for the next behaviour deploy.");
    process.exit(0);
  }

  if (verdict.status === "unknown") {
    // Deliberately KEEPS pending: an unjudged deploy stays unjudged, and the gate stays shut.
    console.log(
      "\ncanary: recorded UNKNOWN. The pending canary is KEPT — a run that concluded nothing must\n" +
        "  not clear the gate. Widen the window or wait for more traffic, then judge again."
    );
    process.exit(2);
  }

  // REGRESSED.
  const plan = buildRevertPlan(verdict, baseline.deployedSha);
  if (!flag("act")) {
    console.log("\nROLLBACK PLAN (shadow — NOT executed; pass --act to carry it out):");
    for (const line of plan) console.log(`  ${line}`);
    process.exit(1);
  }

  console.log("\nROLLBACK — executing (--act):");
  const sha = String(baseline.deployedSha ?? "").trim();
  if (!sha) {
    console.error("  BLOCKED: the deployed commit was not recorded — there is nothing to revert.");
    process.exit(1);
  }
  // `git revert` of the one commit, NOT a checkout of an older tree: anything merged after this
  // deploy belongs to someone else and must survive the rollback.
  const run = (cmd: string, args: string[]) => {
    console.log(`  $ ${cmd} ${args.join(" ")}`);
    execFileSync(cmd, args, { stdio: "inherit" });
  };
  try {
    run("git", ["revert", "--no-edit", sha]);
    run("git", ["push", "origin", "HEAD"]);
    run("npm", ["run", "deploy:api"]);
  } catch (err) {
    console.error(`  ROLLBACK FAILED: ${(err as Error)?.message ?? err}`);
    console.error("  The pending canary is KEPT so this stays visible. Carry out the plan by hand.");
    process.exit(1);
  }
  appendHistory({
    judgedAtMs: nowMs,
    judgedAtIso: new Date(nowMs).toISOString(),
    deployedSha: sha,
    status: "regressed",
    reason: "auto-reverted",
    reverted: true
  });
  fs.rmSync(pendingPath(), { force: true });
  console.log("\ncanary: REGRESSED and REVERTED. The revert is live.");
  process.exit(1);
}

// -------------------------------------------------------------------------------------------------
// status — "may another behaviour deploy go out?" The one question the readiness loop asks.
// EXIT 0 = yes. Anything else = no. Silence is never a yes.
// -------------------------------------------------------------------------------------------------
if (mode === "status") {
  const gate = decideCanaryGate({
    pending: readPending(),
    lastVerdictStatus: lastJudgedStatus(),
    nowMs
  });
  console.log(
    JSON.stringify(
      {
        mayDeployBehaviour: gate.mayDeployBehaviour,
        pendingReady: gate.pendingReady,
        minutesRemaining: gate.minutesRemaining,
        reason: gate.reason
      },
      null,
      2
    )
  );
  process.exit(gate.mayDeployBehaviour ? 0 : 2);
}

console.error(
  "Usage: canary_watch.ts <arm [--hours N] | judge [--act] | status | baseline --out <f> | check --baseline <f>> [--now <iso>] [--report-root DIR]"
);
process.exit(2);
