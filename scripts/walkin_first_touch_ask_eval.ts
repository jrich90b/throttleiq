/**
 * Walk-in first-touch ask eval (pure, no LLM).
 *
 * Pins `appendWalkInFirstTouchAsk` (services/api/src/domain/walkInFollowUpTopic.ts) — the policy
 * that decides whether a walk-in's FIRST TEXT ends by asking them back in, or by promising to call.
 *
 * WHY: the ladder-health sweep alarmed on `Traffic Log Pro` for five consecutive runs — **15
 * agent-owned first touches, 0 asked anything**. Every reply body below is VERBATIM from the live
 * americanharley store (2026-07-15 .. 2026-07-28), because the whole defect is what these exact
 * sentences do and do not say. #655 built the ask; it was wired at one call site and this lane —
 * the one carrying the volume — never got it.
 *
 * The eval asserts the DECISION (does the reply gain a question?) and never a copy spelling: the
 * ask string is `buildWalkInSoftTimingAsk`'s, passed in by the caller, and is pinned by its own
 * eval. Executes the real function — a source-text assertion cannot prove a route still asks
 * (the ratchet trap that put `shouldWalkInAvailabilityTailSpeak` in this module in the first place).
 *
 * Run: npx tsx scripts/walkin_first_touch_ask_eval.ts
 */
import { strict as assert } from "node:assert";
import fs from "node:fs";

const { appendWalkInFirstTouchAsk } = await import("../services/api/src/domain/walkInFollowUpTopic.ts");
const { buildWalkInSoftTimingAsk } = await import("../services/api/src/domain/visitFraming.ts");

// The real sentence, from the real builder — never a hand-typed copy of it.
const ASK = buildWalkInSoftTimingAsk(true, false);
assert.ok(ASK.includes("?"), "the walk-in soft ask must actually be a question");
assert.ok(/stop back in/i.test(ASK), "a walk-in has already been here — the wording is 'stop BACK in' (Joe ruling 31)");

// --- 1) The alarmed population: verbatim first touches that asked nothing. -------------------
const SILENT: Array<[string, string]> = [
  [
    "Larry Godzich +17164327329",
    "Hi Larry — this is Scott at American Harley-Davidson. Thanks for stopping in today - I'll follow up about pre-owned trikes."
  ],
  [
    "Mike Zimmerman +17165100025",
    "Hi Mike — this is Scott at American Harley-Davidson. Thanks for stopping in today - I'll follow up about the new and pre-owned trikes you looked at."
  ],
  [
    "Thomas Qualey +17168638237",
    "Hi Thomas — this is Giovanni at American Harley-Davidson. Thanks for stopping in today - I'll follow up about his 2018 Heritage that was here for inspection."
  ],
  [
    "Peter Arnoldo +17166887637",
    "Hi Peter — this is Scott at American Harley-Davidson. Thanks for stopping in today - I'll check back in soon like we discussed."
  ]
];
for (const [who, reply] of SILENT) {
  assert.ok(!reply.includes("?"), `${who}: the shipped reply really did ask nothing (that is the bug)`);
  const out = appendWalkInFirstTouchAsk({ reply, step: 2, softAsk: ASK });
  assert.ok(out.includes("?"), `${who}: the first touch must now end by asking something`);
  assert.ok(out.startsWith(reply), `${who}: the existing reply must be preserved exactly, ask appended`);
  assert.ok(out.trimEnd().endsWith(ASK.trim()), `${who}: the question must land LAST, after any recap/addendum`);
}

// --- 2) The suppressions, each with the measured reason it exists. ---------------------------
const WATCH_REPLY =
  "Hi Tom — this is Joe at American Harley-Davidson. Thanks for stopping in, it was nice chatting with you. I'll keep an eye out for Road King and let you know if one comes in.";
assert.equal(
  appendWalkInFirstTouchAsk({ reply: WATCH_REPLY, step: 2, softAsk: ASK, suppressed: true }),
  WATCH_REPLY,
  "an inventory-watch reply must NOT invite them in — there is nothing here to come and see"
);
// Committed return visit (#681, Ed Szulist / Paul Harrigan): they already named the day.
const COMMITTED = "Hi Ed — this is Stone at American Harley-Davidson. Thanks again for your time. See you Tuesday.";
assert.equal(
  appendWalkInFirstTouchAsk({ reply: COMMITTED, step: 2, softAsk: ASK, suppressed: true }),
  COMMITTED,
  "never ask 'want to set up a time?' of a customer who already named one"
);

// --- 3) The band: first touch only. ----------------------------------------------------------
const DEEP = "Hi Mark — this is Scott at American Harley-Davidson. Thanks again for sitting down with me. I'll follow up with the numbers we discussed and next steps.";
for (const step of [5, 6, 7, 8, 9]) {
  assert.equal(
    appendWalkInFirstTouchAsk({ reply: DEEP, step, softAsk: ASK }),
    DEEP,
    `step ${step} is mid-deal or post-sale — a soft "want to stop back in?" is noise there`
  );
}
for (const step of [1, 2, 3, 4]) {
  assert.ok(
    appendWalkInFirstTouchAsk({ reply: SILENT[0][1], step, softAsk: ASK }).includes("?"),
    `step ${step} is the first-touch band and must ask`
  );
}
// A lane with no ladder step at all (the route passes 0) never asks.
assert.equal(
  appendWalkInFirstTouchAsk({ reply: SILENT[0][1], step: 0, softAsk: ASK }),
  SILENT[0][1],
  "step 0 means this is not a Traffic Log Pro walk-in — behaviour must be untouched"
);

// --- 4) Never two questions. -----------------------------------------------------------------
const ALREADY_ASKS =
  "Hi Mike — this is Scott at American Harley-Davidson. I'll get you the numbers on the 2023 Street Glide. Want to set up a time to stop back in and go over it?";
assert.equal(
  appendWalkInFirstTouchAsk({ reply: ALREADY_ASKS, step: 2, softAsk: ASK }),
  ALREADY_ASKS,
  "a reply that already asks keeps its own question — one advancing question, never a stacked pair"
);
assert.equal(
  (appendWalkInFirstTouchAsk({ reply: SILENT[1][1], step: 2, softAsk: ASK }).match(/\?/g) || []).length,
  1,
  "exactly one question mark in the result"
);

// --- 5) Degenerate inputs fail toward today's behaviour. -------------------------------------
assert.equal(appendWalkInFirstTouchAsk({ reply: SILENT[0][1], step: 2, softAsk: "" }), SILENT[0][1], "no ask string ⇒ unchanged");
assert.equal(appendWalkInFirstTouchAsk({ reply: SILENT[0][1], step: 2 }), SILENT[0][1], "missing ask ⇒ unchanged");
assert.equal(appendWalkInFirstTouchAsk({ reply: "", step: 2, softAsk: ASK }), "", "empty reply ⇒ unchanged");
assert.equal(appendWalkInFirstTouchAsk({ reply: null, step: 2, softAsk: ASK }), "", "null reply ⇒ empty, never the bare ask");
assert.equal(
  appendWalkInFirstTouchAsk({ reply: SILENT[0][1], step: Number.NaN, softAsk: ASK }),
  SILENT[0][1],
  "an unparseable step ⇒ unchanged (never guess into a customer-facing send)"
);

// --- 6) The route must actually route its assembled reply through this policy. ---------------
// Source guard, deliberately: a pure unit test cannot see the wiring, and this lane's whole
// history is a builder that existed and was wired at only one of its call sites.
const route = fs.readFileSync("services/api/src/routes/sendgridInbound.ts", "utf8");
const calls = route.split("appendWalkInFirstTouchAsk(").length - 1;
assert.equal(calls, 1, `the walk-in reply assembly must call the ask policy exactly once (found ${calls})`);
assert.ok(
  /appendWalkInFirstTouchAsk\(\{[\s\S]{0,600}softAsk: buildWalkInSoftTimingAsk\(true, false\)/.test(route),
  "the route must pass the ALREADY-VISITED soft ask (walk-ins have been here — 'stop back in')"
);
assert.ok(
  /appendWalkInFirstTouchAsk\(\{[\s\S]{0,900}suppressed:[\s\S]{0,300}walkInWatchSet/.test(route),
  "the route must pass the inventory-watch signal into the suppression set"
);

console.log("PASS walkin_first_touch_ask_eval — the walk-in first touch asks them back in");
