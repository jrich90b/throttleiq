/**
 * Deploy health budget — the post-restart wait must outlast a real boot. EXECUTED, not grepped.
 *
 * MEASURED 2026-08-20. The API takes ~65s to serve after a restart (it loads 879 conversations from
 * a 13.5 MB store before it listens). The budget was 15 attempts x 3s = 45s, so BOTH deploys that
 * day printed "API health check failed after deploy" and exited 23 on deploys that were healthy
 * seconds later — once for #770, once for #772.
 *
 * WHY THAT IS WORTH A GATE. A false failure is more dangerous than a slow true one. It invites
 * someone to revert a working deploy (the standing advice in `deploy-exit-23-is-a-slow-boot-not-a-
 * bad-build` exists precisely because this already happened), and every repetition trains the team
 * to stop reading deploy output — at which point a REAL failure goes unread too. The fail direction
 * of this guard is therefore "wait longer", never "wait less".
 *
 * WHY IT EXECUTES THE SHELL. `tsc` does not cover `scripts/`, and asserting on source text cannot
 * prove the value the script actually RESOLVES — the number survives profile files, env overrides,
 * CLI flags and a defensive re-default inside the remote heredoc. This runs the REAL script and
 * reads the window off its own banner, so it measures the resolved value the way a deploy would.
 * Same approach as backup_retention_daily_eval.ts.
 *
 * HERMETIC. `--dry-run` alone is NOT safe for a gate: it git-fetches, runs a full tsc build, and
 * SSHes to the production box to compare commits. So every external (`ssh`, `git`, `curl`, `rsync`,
 * `npm`, `pm2`) is stubbed onto PATH first and the script is run under a short timeout. The banner
 * prints before any of them are reached, so the exit code is deliberately ignored — this eval asks
 * one question (what window did it resolve?) and must never depend on the network to answer it.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const script = path.join(repoRoot, "scripts", "deploy_api_lightsail.sh");
const profile = path.join(repoRoot, "infra", "deploy", "americanharley.api.env.example");
assert.ok(fs.existsSync(script), "deploy script must exist");
assert.ok(fs.existsSync(profile), "the americanharley profile the npm script uses must exist");

let checks = 0;
const ok = (cond: boolean, m: string) => { assert.ok(cond, m); checks++; };

/** Stub every external the script may reach for, so the gate never touches the network or the box. */
const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), "deploy-health-stubs-"));
for (const bin of ["ssh", "git", "curl", "rsync", "npm", "pm2", "scp"]) {
  const f = path.join(stubDir, bin);
  fs.writeFileSync(f, "#!/bin/sh\nexit 0\n");
  fs.chmodSync(f, 0o755);
}

function bannerWindowSeconds(env: NodeJS.ProcessEnv = {}): { attempts: number; windowSeconds: number } {
  let out = "";
  try {
    out = execFileSync("bash", [script, "--dry-run", "--profile", profile], {
      cwd: repoRoot,
      encoding: "utf8",
      env: { ...process.env, ...env, PATH: `${stubDir}:${process.env.PATH ?? ""}` },
      timeout: 30_000
    });
  } catch (err: any) {
    // Expected: with externals stubbed the script cannot complete. The banner is printed long
    // before that, and the banner is the only thing this eval reads.
    out = String(err?.stdout ?? "");
  }
  const line = out.split("\n").find(l => l.includes("attempts:"));
  assert.ok(line, "the deploy banner must report its health attempts");
  const m = line!.match(/attempts:\s*(\d+)\s*\(~(\d+)s window\)/);
  assert.ok(m, `the banner must state the computed window, got: ${line!.trim()}`);
  return { attempts: Number(m![1]), windowSeconds: Number(m![2]) };
}

// ── The budget must outlast a real boot, with headroom ────────────────────────
const MEASURED_BOOT_SECONDS = 65; // 2026-08-20, both deploys
const FLOOR_SECONDS = 180;

const base = bannerWindowSeconds();
ok(
  base.windowSeconds >= FLOOR_SECONDS,
  `the health budget must be >= ${FLOOR_SECONDS}s; got ${base.windowSeconds}s. A 45s budget failed ` +
    `two healthy deploys on 2026-08-20 — do NOT lower this to make a deploy fail faster.`
);
ok(
  base.windowSeconds >= MEASURED_BOOT_SECONDS * 2,
  `the budget must carry at least 2x the measured ~${MEASURED_BOOT_SECONDS}s boot; got ${base.windowSeconds}s`
);
ok(base.attempts > 1, "more than one attempt (a single probe cannot ride out a slow boot)");

// ── The window is still operator-overridable, in BOTH directions ──────────────
// A bigger box or a bad day must be tunable without editing the script.
const longer = bannerWindowSeconds({ DEPLOY_HEALTH_ATTEMPTS: "120" });
ok(longer.attempts === 120, "DEPLOY_HEALTH_ATTEMPTS override is honoured");
ok(longer.windowSeconds > base.windowSeconds, "…and a larger attempt count really widens the window");

const slower = bannerWindowSeconds({ DEPLOY_HEALTH_RETRY_SLEEP_SECONDS: "5" });
ok(
  slower.windowSeconds === base.attempts * 5,
  `the retry sleep is a real multiplier, not decoration; expected ${base.attempts * 5}s, got ${slower.windowSeconds}s`
);

// ── The give-up message must not read as "the build is bad" ───────────────────
// This is the whole failure mode: the message is what makes someone revert a healthy deploy.
const src = fs.readFileSync(script, "utf8");
ok(
  /CHECK THE PUBLIC HEALTH URL yourself/.test(src),
  "the timeout message must tell the operator to check the public health URL before concluding the build is bad"
);
ok(
  /waited ~\$\(\(DEPLOY_HEALTH_ATTEMPTS \* DEPLOY_HEALTH_RETRY_SLEEP_SECONDS\)\)s/.test(src),
  "the timeout message must state how long it actually waited, so the budget can be judged"
);
// The remote heredoc re-defaults defensively; that fallback must not reintroduce the 45s budget.
ok(
  !/DEPLOY_HEALTH_ATTEMPTS=15\b/.test(src),
  "no path may fall back to the 15-attempt (45s) budget that failed two healthy deploys"
);

console.log(`PASS deploy health budget eval (${checks} checks; window ${base.windowSeconds}s over a ~${MEASURED_BOOT_SECONDS}s boot)`);
