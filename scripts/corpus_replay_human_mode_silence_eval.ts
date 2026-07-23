/**
 * Corpus-replay human-mode silence eval.
 *
 * The shadow-replay harness force-overwrites conv.mode to the replay mode
 * (autopilot for Twilio) in prepareCaseData BEFORE classifyDraft reads the
 * replayed conversation — so the existing human-mode expected-silence carve-out
 * keyed on conv.mode was DEAD CODE for every default Twilio replay. A staff-owned
 * (mode:"human") thread whose replay produced no draft scored as verdict
 * `no_response` (unexpected silence) and folded into a `corpus_replay_judge_fail`,
 * dirtying the anomaly work order with phantom failures (5 on the 2026-07-23
 * sweep: +17169982451 sold, +17163083346 wrong-number, +17168683017 sold,
 * +17165259267 inventory-watch, +17168619251 owner-greeting — all mode:"human"
 * in the live store).
 *
 * The fix plumbs the SOURCE conversation's pre-override mode into classifyDraft
 * (the per-row `sourceConversationMode` the report already emits), mirroring the
 * release-gate human-mode skips (c5ae6e32/acbede8d shape). While there, the
 * wrong-number carve-out learned to trust conv.closedReason === "wrong_number"
 * directly (the state proves the disposition) and the text matcher gained the
 * "Wrong #" shorthand.
 *
 * Fail-direction: every carve-out here only converts a SILENCE on a thread the
 * live system would never auto-reply to (staff-owned / confirmed wrong number)
 * from phantom-fail to by-design. A produced DRAFT is never excused, and silence
 * on an agent-owned thread still scores as a miss.
 */
import assert from "node:assert/strict";

import { classifyDraft } from "./inbound_shadow_replay.ts";

// ---- Human-owned source thread: silence is by design -------------------------------------------

// The primary reproduction shape (+17169982451): sold, human-mode thread; the replay forces the
// temp copy to autopilot, so convAfter says "autopilot" — the SOURCE mode must carry the carve-out.
assert.equal(
  classifyDraft("twilio", "Thanks again, loving the new bike!", null, { mode: "autopilot", status: "closed", closedReason: "sold" } as any, "human").verdict,
  "expected_no_response",
  "silence on a human-owned SOURCE thread must be expected_no_response even though the replay forced conv.mode=autopilot"
);

// Owner-greeting shape (+17168619251): staff-owned thread, casual inbound, no draft.
assert.equal(
  classifyDraft("twilio", "Hey Stone, when do you work next?", null, { mode: "autopilot" } as any, "human").verdict,
  "expected_no_response",
  "owner-greeting silence on a human-owned source thread is by design"
);

// An explicit --modes human replay (conv.mode itself is "human") still gets the carve-out
// even when no source mode is plumbed (the pre-existing behavior must not regress).
assert.equal(
  classifyDraft("twilio", "Can I get pics of that trike?", null, { mode: "human" } as any).verdict,
  "expected_no_response",
  "an explicit human-mode replay keeps the conv.mode carve-out"
);

// ---- Wrong-number: the conversation state alone proves the disposition -------------------------

// "Wrong #" shorthand (+17163083346 shape): the old \bwrong\s+number\b matcher missed it.
assert.equal(
  classifyDraft("twilio", "Wrong #", null, { mode: "autopilot", status: "closed", closedReason: "wrong_number" } as any, "autopilot").verdict,
  "expected_no_response",
  "'Wrong #' shorthand with a wrong_number disposition must be expected_no_response"
);

// State-trusted: closedReason === wrong_number accepts silence regardless of the inbound text.
assert.equal(
  classifyDraft("twilio", "leave me alone", null, { mode: "autopilot", closedReason: "wrong_number" } as any, "autopilot").verdict,
  "expected_no_response",
  "closedReason wrong_number alone proves the disposition — any silence toward that number is by design"
);

// ---- Fail-direction guards: the carve-outs must not over-broaden -------------------------------

// Silence on an agent-owned (autopilot source) thread is STILL an unexpected miss.
assert.equal(
  classifyDraft("twilio", "is the low rider st still available?", null, { mode: "autopilot" } as any, "autopilot").verdict,
  "no_response",
  "agent-owned silence must still surface as an unexpected no_response"
);

// A suggest-mode source is agent-owned too — no free pass.
assert.equal(
  classifyDraft("twilio", "what's the OTD price?", null, { mode: "autopilot" } as any, "suggest").verdict,
  "no_response",
  "suggest-mode source silence must still surface as an unexpected no_response"
);

// A wrong-number TEXT alone (no closed state) is not excused — the live system should still act.
assert.equal(
  classifyDraft("twilio", "you have the wrong number", null, { mode: "autopilot", status: "active" } as any, "autopilot").verdict,
  "no_response",
  "a wrong-number text on an OPEN conversation is not auto-excused (the suppression should have closed it)"
);

// The human-mode carve-out is SILENCE-only: a produced draft on a human-owned source thread is
// still classified on its own merits (never auto-passed).
const humanDraft = classifyDraft(
  "twilio",
  "what's the monthly payment on the street glide?",
  "It'd be around $310/mo with nothing down.",
  { mode: "autopilot" } as any,
  "human"
);
assert.notEqual(humanDraft.verdict, "expected_no_response", "a produced draft is never excused by the human-mode carve-out");
assert.ok(
  humanDraft.reasons.includes("finance/pricing-sensitive inbound"),
  "a draft on a human-owned thread still runs the full sensitive-topic classification"
);

console.log("PASS corpus replay human-mode silence eval");
