/**
 * Corpus-replay opt-out silence eval.
 *
 * When the customer's inbound is a bare carrier opt-out keyword ("STOP",
 * "UNSUBSCRIBE", "CANCEL", …), Twilio itself opts the number out, sends the
 * compliance confirmation, and BLOCKS further outbound — so LeadRider producing
 * NO draft is the only legal behavior, never a miss (the opt-out-is-Twilio
 * ruling). The shadow-replay classifier (`classifyDraft`) used to score that
 * silence as verdict `no_response` (unexpected silence), which the flywheel
 * folds into a `corpus_replay_judge_fail` — dirtying the anomaly work order with
 * phantom opt-out failures (12 on the 2026-07-17 sweep).
 *
 * This pins: a bare opt-out with no draft => `expected_no_response`; a REAL,
 * answerable message that merely contains "stop" ("stop texting me about the
 * road glide") is NOT suppressed and still scores as `no_response` when no draft
 * is produced; and an ordinary drafted reply is unaffected.
 */
import assert from "node:assert/strict";

import { classifyDraft } from "./inbound_shadow_replay.ts";

// Bare carrier opt-out keywords (whole-message) → expected silence, not a miss.
for (const kw of ["Stop", "STOP", "stop.", "unsubscribe", "Cancel", "END", "quit", "opt out", "opt-out"]) {
  const { verdict } = classifyDraft("twilio", kw, null, { mode: "suggest" } as any);
  assert.equal(
    verdict,
    "expected_no_response",
    `bare opt-out "${kw}" with no draft must be expected_no_response, got ${verdict}`
  );
}

// A real, answerable message that merely contains "stop" is NOT an opt-out: with
// no draft it stays an unexpected `no_response` (a genuine miss we must still surface).
assert.equal(
  classifyDraft("twilio", "stop texting me about the road glide", null, { mode: "suggest" } as any).verdict,
  "no_response",
  "answerable 'stop texting me about the road glide' must NOT be suppressed as opt-out"
);
assert.equal(
  classifyDraft("twilio", "Can you stop by tomorrow?", null, { mode: "suggest" } as any).verdict,
  "no_response",
  "'Can you stop by tomorrow?' is a scheduling ask, not an opt-out"
);

// An ordinary drafted reply is unaffected by the opt-out branch (only fires on empty draft).
const drafted = classifyDraft(
  "twilio",
  "Do you have the 2024 Street Glide in stock?",
  "Yes — we have one on the floor. Want to stop in and see it?",
  { mode: "suggest" } as any
);
assert.notEqual(drafted.verdict, "expected_no_response", "a real drafted answer must not be graded expected_no_response");
assert.notEqual(drafted.verdict, "no_response", "a real drafted answer must not be graded no_response");

console.log("PASS corpus replay opt-out silence eval");
