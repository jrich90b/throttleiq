/**
 * Thumbs-down staff-worklist × disposition-ledger eval.
 *
 * WHAT BROKE. `reports/thumbs_down_action/latest.json` is generated INDEPENDENTLY of
 * `anomaly_loop_detect`, and only detect read `dispositions.json`. So a 👎 note a routine had
 * explicitly disposed kept reappearing in the 7:30 digest's staff worklist every single morning.
 * MEASURED 2026-08-12: the lane showed 21 "open" items; all 21 had already been actioned (1-13
 * staff outbounds after the 👎, ages 6-20 days), and 20 of the 21 keys were already in the ledger
 * — which is exactly why not one of them appeared in the digest's work orders. Two reports, one
 * ledger, and only one of them read it. Two consecutive mornings burned re-verifying finished work.
 *
 * WHY THIS EXECUTES THE SCRIPT rather than asserting on its source. `tsc` does not cover
 * `scripts/`, and a source-text pin cannot prove the suppression still RUNS — the sweep's own
 * `--self-test` is wiring-only by design. So this builds a synthetic store + ledger on disk, runs
 * the real sweep as a child process, and reads the JSON it wrote. It needs no network: with
 * LLM_ENABLED=0 `parseThumbsDownNoteWithLLM` returns null and `decideThumbsDownNoteRouting`
 * fails toward `staff_action`, which is the shape we want to see suppressed.
 *
 * WHAT IT PINS. A disposed key is dropped; an undisposed one survives; and a CODE-STATE
 * disposition whose finding re-occurred after the fix boundary comes back tagged
 * `regressionOfDisposed` instead of being eaten — the fail-direction the whole ledger is built on.
 *
 * Clock-safe: every timestamp is derived from now.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const now = Date.now();
const iso = (msAgo: number) => new Date(now - msAgo).toISOString();
const DAY = 24 * 60 * 60 * 1000;

const root = fs.mkdtempSync(path.join(os.tmpdir(), "thumbs-down-disposition-"));
const storePath = path.join(root, "conversations.json");
const reportRoot = path.join(root, "reports");
fs.mkdirSync(path.join(reportRoot, "anomaly_loop"), { recursive: true });

const downRated = (at: string, note: string) => ({
  direction: "out",
  provider: "twilio",
  at,
  body: "Thanks — I'll keep you posted.",
  feedback: { rating: "down", note, at }
});

fs.writeFileSync(
  storePath,
  JSON.stringify({
    version: 1,
    conversations: [
      {
        // Already disposed no-action (POLICY — timeless). Must NOT reach the worklist.
        id: "+15550000001",
        leadKey: "+15550000001",
        messages: [
          { direction: "in", provider: "twilio", at: iso(3 * DAY), body: "Any update on the CVO?" },
          downRated(iso(3 * DAY - 60_000), "tell him we still need to notify when the cvo gets here")
        ]
      },
      {
        // Never disposed. Must survive — this lane exists for exactly this row.
        id: "+15550000002",
        leadKey: "+15550000002",
        messages: [
          { direction: "in", provider: "twilio", at: iso(2 * DAY), body: "Can you book me in Saturday?" },
          downRated(iso(2 * DAY - 60_000), "Book him in at 9:30 today")
        ]
      },
      {
        // Disposed "fixed" with a boundary 5 days ago, but the 👎 landed 1 day ago — the fix did
        // not hold. Must come back TAGGED, never silently eaten.
        id: "+15550000003",
        leadKey: "+15550000003",
        messages: [
          { direction: "in", provider: "twilio", at: iso(1 * DAY), body: "Still waiting on that quote" },
          downRated(iso(1 * DAY - 60_000), "get him the quote today")
        ]
      }
    ],
    todos: [],
    questions: []
  })
);

fs.writeFileSync(
  path.join(reportRoot, "anomaly_loop", "dispositions.json"),
  JSON.stringify({
    version: 1,
    records: [
      {
        key: "+15550000001::thumbs_down_action_request",
        disposition: "no-action",
        at: iso(6 * DAY),
        by: "agent-loop",
        note: "staff outbound after the 👎 performed the exact ask"
      },
      {
        key: "+15550000003::thumbs_down_action_request",
        disposition: "fixed",
        at: iso(5 * DAY),
        deployTs: iso(5 * DAY),
        by: "agent-loop",
        note: "shipped the notify path"
      }
    ]
  })
);

execFileSync("npx", ["tsx", "scripts/thumbs_down_action_sweep.ts", "--age-days", "21"], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    // The sweep's module graph builds an OpenAI client at import time, so a key must EXIST.
    // LLM_ENABLED=0 is what guarantees no call is ever made — the parser returns null and the
    // routing fails toward staff_action, which is the row we want to watch get suppressed.
    LLM_ENABLED: "0",
    OPENAI_API_KEY: "test-key-never-used",
    CONVERSATIONS_DB_PATH: storePath,
    REPORT_ROOT: reportRoot
  },
  stdio: "pipe"
});

const out = JSON.parse(fs.readFileSync(path.join(reportRoot, "thumbs_down_action", "latest.json"), "utf8"));
const ids: string[] = (out.anomalies ?? []).map((a: any) => String(a.convId)).sort();

assert.equal(out.summary.scanned, 3, `all three 👎 notes should be scanned, got ${out.summary.scanned}`);
assert.deepEqual(
  ids,
  ["+15550000002", "+15550000003"],
  `worklist should hold the undisposed note and the regression only, got ${JSON.stringify(ids)}`
);
assert.equal(
  ids.includes("+15550000001"),
  false,
  "a note a routine already disposed must not be re-presented as open staff work"
);
assert.equal(out.summary.suppressedByDisposition, 1, `expected 1 suppressed, got ${out.summary.suppressedByDisposition}`);
assert.equal(out.summary.staffAction, 2, `staffAction must count what actually SURVIVED, got ${out.summary.staffAction}`);

const regression = (out.anomalies ?? []).find((a: any) => String(a.convId) === "+15550000003");
assert.ok(regression, "the post-boundary re-occurrence must still be in the feed");
assert.equal(
  regression.regressionOfDisposed,
  true,
  "a disposed finding that came back after its fix boundary must be TAGGED, never silently dropped"
);

// Fail-open: a malformed ledger must never hide work. Same direction detect keeps.
fs.writeFileSync(path.join(reportRoot, "anomaly_loop", "dispositions.json"), "{ not json");
execFileSync("npx", ["tsx", "scripts/thumbs_down_action_sweep.ts", "--age-days", "21"], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    LLM_ENABLED: "0",
    OPENAI_API_KEY: "test-key-never-used",
    CONVERSATIONS_DB_PATH: storePath,
    REPORT_ROOT: reportRoot
  },
  stdio: "pipe"
});
const openOut = JSON.parse(fs.readFileSync(path.join(reportRoot, "thumbs_down_action", "latest.json"), "utf8"));
assert.equal(
  (openOut.anomalies ?? []).length,
  3,
  "a malformed ledger must keep every finding — fail toward surfacing, never toward hiding"
);

fs.rmSync(root, { recursive: true, force: true });
console.log("PASS thumbs-down action disposition eval");
