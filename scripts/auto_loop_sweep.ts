/**
 * Tight-window agent-quality sweep — the fresh-signal front of the autonomous
 * coding loop (docs/autonomous_coding_loop.md).
 *
 * Iteration 2's lesson: a 30-day audit buries new regressions under
 * already-fixed history, so the loop chased ghosts. This runs the deterministic
 * answer_correctness audit over a TIGHT recent window (default 48h) against the
 * live store, writes the summary where DETECT reads it, then runs DETECT and
 * reports whether the loop has genuinely NEW codeable work. Run it daily (cron)
 * so a real regression surfaces within a day, not buried in a month.
 *
 * Read-only: it grades conversations, never writes the store. DATA_DIR is
 * pinned to the store's own directory so the conversation-store module never
 * auto-creates a stray empty store (the bug from iteration 2).
 *
 * Usage (on the instance, where the live store lives):
 *   CONVERSATIONS_DB_PATH=/home/ubuntu/leadrider-runtime/<dealer>/data/conversations.json \
 *     npm run auto_loop:sweep
 *   npx tsx scripts/auto_loop_sweep.ts --store <path> --window-hours 48
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const store =
  arg("--store") ||
  process.env.CONVERSATIONS_DB_PATH ||
  path.join(process.env.DATA_DIR || "data", "conversations.json");
const windowHours = Number(arg("--window-hours") || process.env.SWEEP_WINDOW_HOURS || 48) || 48;
const reportRoot = arg("--report-root") || process.env.REPORT_ROOT || path.resolve("reports");

if (!fs.existsSync(store)) {
  console.error(`[auto-loop-sweep] conversation store not found: ${store}`);
  process.exit(1);
}

// Pin DATA_DIR to the store's own dir so module-load never creates a stray store.
const env = { ...process.env, DATA_DIR: path.dirname(path.resolve(store)), REPORT_ROOT: reportRoot };
const acOutDir = path.join(reportRoot, "answer_correctness");

console.log(`[auto-loop-sweep] window=${windowHours}h store=${store}`);

// 1) Tight-window deterministic agent-quality audit.
try {
  execSync(
    `npx tsx scripts/answer_correctness_audit.ts --store ${JSON.stringify(store)} --since-hours ${windowHours} --out-dir ${JSON.stringify(acOutDir)}`,
    { stdio: "inherit", env }
  );
} catch (e: any) {
  console.error(`[auto-loop-sweep] answer_correctness audit failed: ${e?.message ?? e} (DETECT will use existing signal)`);
}

// 2) DETECT against the fresh signal (eval-aware: skips guarded/stale checks).
try {
  execSync(`npx tsx scripts/auto_loop_next_task.ts`, { stdio: "ignore", env });
} catch (e: any) {
  console.error(`[auto-loop-sweep] DETECT failed: ${e?.message ?? e}`);
  process.exit(1);
}

// 3) Report whether the loop has new codeable work.
const nextTaskPath = path.join(reportRoot, "auto_loop", "next_task.json");
const result = fs.existsSync(nextTaskPath) ? JSON.parse(fs.readFileSync(nextTaskPath, "utf8")) : null;
if (!result) {
  console.error("[auto-loop-sweep] no next_task.json produced");
  process.exit(1);
}

console.log("\n[auto-loop-sweep] ── loop signal ──");
if (result.skippedSweepChecks?.length) {
  console.log("  skipped (stale/guarded):");
  for (const s of result.skippedSweepChecks) console.log(`    - ${s}`);
}
if (result.stop) {
  console.log(`  NO NEW CODEABLE WORK — ${result.stopReason}`);
} else {
  const t = result.task ?? {};
  console.log(`  ▶ NEW WORK: ${t.id} [${t.priority}] — ${t.title}`);
  if (t.evidence?.convId) console.log(`    repro: conv ${t.evidence.convId}`);
}
console.log(`  (full work order: ${nextTaskPath})`);
