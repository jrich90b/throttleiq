/**
 * intent-handled REPORT_ROOT eval — pins that this audit writes where the loop actually reads.
 *
 * THE MISS (measured on the box 2026-08-18). Every sibling sweep resolves its output from
 * `REPORT_ROOT`, and `anomaly_loop_detect` merges this net's findings from
 * `$REPORT_ROOT/intent_handled/anomalies.json`. But `intent_handled_audit.ts` read only
 * `INTENT_HANDLED_OUT_DIR`, then fell through to `cwd/reports/intent_handled`. So the box cron and
 * the loop's daily block — both of which set REPORT_ROOT and neither of which sets
 * INTENT_HANDLED_OUT_DIR — wrote INSIDE the repo checkout, where nothing looks.
 *
 * The failure was silent in the worst way: every run printed success. The loop's copy sat frozen at
 * 2026-08-13 12:35 for FIVE DAYS while a fresh run in the same minute landed in
 * /home/ubuntu/leadrider-api/americanharley/reports/intent_handled/. A semantic comprehension net
 * was dark and its own logs said it was fine.
 *
 * This eval EXECUTES the resolver and the script (SKILL trap 3: a source-text assertion cannot
 * prove a script still runs). No network, no LLM, no store.
 *
 * Run: npx tsx scripts/intent_handled_report_root_eval.ts
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";

import { resolveIntentHandledOutDir } from "./intent_handled_audit.ts";

const CWD = "/repo";
const at = (env: Record<string, string | undefined>, outDirArg?: string) =>
  resolveIntentHandledOutDir({ outDirArg, env, cwd: CWD });

// THE FIX: REPORT_ROOT alone is enough, and it lands exactly where anomaly_loop_detect reads.
assert.equal(
  at({ REPORT_ROOT: "/runtime/reports" }),
  path.join("/runtime/reports", "intent_handled"),
  "REPORT_ROOT alone must place the feed where anomaly_loop_detect merges it — this is the whole bug"
);

// THE REGRESSION SHAPE: with REPORT_ROOT set, it must NOT fall through to the checkout.
assert.notEqual(
  at({ REPORT_ROOT: "/runtime/reports" }),
  path.resolve(CWD, "reports", "intent_handled"),
  "with REPORT_ROOT set, writing into the repo checkout is the five-day-dark failure"
);

// Precedence, most explicit first — every pre-existing rung keeps winning where it used to.
assert.equal(
  at({ REPORT_ROOT: "/runtime/reports", INTENT_HANDLED_OUT_DIR: "/explicit/env" }, "/explicit/flag"),
  "/explicit/flag",
  "--out-dir beats everything"
);
assert.equal(
  at({ REPORT_ROOT: "/runtime/reports", INTENT_HANDLED_OUT_DIR: "/explicit/env" }),
  "/explicit/env",
  "the pre-existing per-script override still beats REPORT_ROOT (no existing caller changes behaviour)"
);
assert.equal(
  at({}),
  path.resolve(CWD, "reports", "intent_handled"),
  "with nothing set, the original local-dev default is unchanged"
);

// Blank/whitespace env vars are NOT a value — they must fall through, not resolve to "/intent_handled".
assert.equal(at({ REPORT_ROOT: "   " }), path.resolve(CWD, "reports", "intent_handled"), "a blank REPORT_ROOT falls through");
assert.equal(
  at({ REPORT_ROOT: "/runtime/reports", INTENT_HANDLED_OUT_DIR: "" }),
  path.join("/runtime/reports", "intent_handled"),
  "an empty per-script override falls through to REPORT_ROOT rather than swallowing it"
);
assert.equal(at({ REPORT_ROOT: "/runtime/reports" }, "  "), path.join("/runtime/reports", "intent_handled"), "a blank --out-dir falls through");

// EXECUTION: the script itself must still run. Its --self-test exercises the pure scaffolding with a
// stub judge and never touches the network, so this is safe and cheap inside the gate.
const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const r = spawnSync("npx", ["tsx", path.join(repoRoot, "scripts", "intent_handled_audit.ts"), "--self-test"], {
  encoding: "utf8",
  cwd: repoRoot,
  env: { ...process.env }
});
assert.equal(r.status, 0, `intent_handled_audit --self-test must still RUN — exit ${r.status}\n${r.stderr}`);
assert.match(String(r.stdout), /PASS intent-handled audit self-test/, "…and still pass its own scaffolding self-test");

console.log("intent_handled_report_root_eval: PASS — the audit writes where anomaly_loop_detect reads");
