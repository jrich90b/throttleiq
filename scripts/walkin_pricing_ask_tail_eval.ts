/**
 * walkin_pricing_ask_tail:eval — a walk-in note that states a PRICE follow-up must not be answered
 * with an availability/watch line.
 *
 * THE PRODUCTION TURN. Mike Marcaccio (+17165702519), Traffic Log Pro ref 11775, first touch
 * 2026-08-11T18:20Z. The salesperson's note and the text we actually sent:
 *
 *   note: "Mike was in on Saturday 8/8 talking with Brian. Asked if we had any used Street Glides
 *          in stock and showed him the 2023. Follow up on price (Step 2)"
 *   sent: "Hi Mike — this is Scott at American Harley-Davidson. Thanks for stopping in, it was nice
 *          chatting with you. I'll keep an eye out for Street Glide and let you know if one comes in."
 *
 * We had the bike, he had stood next to it, and the one open item was the number. The availability
 * tail had overwritten the pricing tail set a few lines above it in routes/sendgridInbound.ts,
 * because the block that writes it was gated on every walk-in signal except this one.
 *
 * WHY THE ASSERTIONS ARE SHAPED THIS WAY. Every one of them EXECUTES the function the route calls —
 * the ratchet trap is that un-wiring a guard leaves source-text assertions green (SKILL trap 2/3),
 * so the precedence lives in `shouldWalkInAvailabilityTailSpeak` and the phrase gate in
 * `hasWalkInPricingFollowUpPhrase` precisely so this file can run them. The note string below is
 * copied verbatim off the live store, not invented: a plausible-looking wording would have passed
 * against a predicate that never fires on the real one (SKILL: "the fixture IS the measurement").
 *
 * Deterministic — no clock, no network, no LLM.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  buildWalkInPricingFollowUpTail,
  hasWalkInPricingFollowUpPhrase,
  shouldWalkInAvailabilityTailSpeak
} from "../services/api/src/domain/walkInFollowUpTopic.ts";
import { buildWalkInSoftTimingAsk } from "../services/api/src/domain/visitFraming.ts";

/** Verbatim from the live store, conversation +17165702519, lead.inquiry. */
const MIKE_NOTE =
  "Mike was in on Saturday 8/8 talking with Brian. Asked if we had any used Street Glides in stock and showed him the 2023. Follow up on price (Step 2)";
/** Verbatim from the live store — the message that actually went out, and must not any more. */
const MIKE_SENT_TAIL = "I’ll keep an eye out for Street Glide and let you know if one comes in.";

const softAsk = buildWalkInSoftTimingAsk(true, false).trim();

// ---------------------------------------------------------------------------
// 1) The real note reads as a price follow-up. If this ever goes false, nothing
//    below it can fire in production and the whole fix is inert.
// ---------------------------------------------------------------------------
assert.equal(
  hasWalkInPricingFollowUpPhrase(MIKE_NOTE),
  true,
  "Mike's real note states a price follow-up"
);
assert.equal(
  hasWalkInPricingFollowUpPhrase("Rick was on for the back the blue ride and was asking about pricing on Road Glide 3. Needs follow up (Step 2)"),
  true,
  "price-then-follow-up order also reads as a price follow-up"
);
assert.equal(
  hasWalkInPricingFollowUpPhrase("Came in to look at trikes. Wants to think it over (Step 2)"),
  false,
  "a note with no price ask does not claim one"
);
assert.equal(hasWalkInPricingFollowUpPhrase(""), false, "an empty note claims nothing");

// ---------------------------------------------------------------------------
// 2) THE PRECEDENCE — the availability line is silenced by a stated price ask.
//    This is the single term that changed; the rest is the pre-existing guard,
//    asserted here so a later edit cannot quietly drop one.
// ---------------------------------------------------------------------------
const availabilityBase = {
  modelLabel: "Street Glide",
  hasPricingFollowupIntent: false,
  hasCompletedTestRideSignal: false,
  hasDealProgressSignal: false,
  hasHoldSignal: false,
  hasResumeHoldSignal: false,
  hasReminderRequest: false
};
assert.equal(
  shouldWalkInAvailabilityTailSpeak(availabilityBase),
  true,
  "with nothing else to say, the availability line still speaks"
);
assert.equal(
  shouldWalkInAvailabilityTailSpeak({ ...availabilityBase, hasPricingFollowupIntent: true }),
  false,
  "a stated price ask outranks the availability line — this is Mike's turn"
);
assert.equal(
  shouldWalkInAvailabilityTailSpeak({ ...availabilityBase, modelLabel: "" }),
  false,
  "no model resolved, nothing to be available"
);
for (const blocking of [
  "hasCompletedTestRideSignal",
  "hasDealProgressSignal",
  "hasHoldSignal",
  "hasResumeHoldSignal",
  "hasReminderRequest"
]) {
  assert.equal(
    shouldWalkInAvailabilityTailSpeak({ ...availabilityBase, [blocking]: true }),
    false,
    `the pre-existing guard still blocks on ${blocking}`
  );
}

// ---------------------------------------------------------------------------
// 3) THE TAIL Mike gets instead. Named bike, no figure, exactly one question.
// ---------------------------------------------------------------------------
const mikeTail = buildWalkInPricingFollowUpTail({
  modelLabel: "Street Glide",
  yearLabel: "2023",
  condition: "used",
  softAsk
});
assert.ok(mikeTail.includes("2023 Street Glide"), "the tail names the bike the note named");
assert.ok(mikeTail.includes("pre-owned"), "a used walk-in hears its condition back");
assert.ok(mikeTail.includes("get you the numbers"), "the tail answers the price ask");
assert.ok(mikeTail.includes("stop back in"), "already-visited wording, ruling 31");
assert.ok(!mikeTail.includes("keep an eye out"), "the availability claim is gone");
assert.notEqual(mikeTail, MIKE_SENT_TAIL, "the sentence that shipped is not the sentence any more");

// It must never quote money, and it must never carry the internal staff log.
assert.ok(!/\$/.test(mikeTail), "the tail never states a figure");
assert.ok(!/\bBrian\b/.test(mikeTail), "note prose never reaches the customer");
assert.ok(!/\bshowed him\b/i.test(mikeTail), "third-person staff-log phrasing never reaches the customer");

// Exactly one question mark: the lane's whole defect is asking nothing, and two asks is its own bug.
assert.equal(
  mikeTail.split("?").length - 1,
  1,
  "one advancing question, no more"
);

// ---------------------------------------------------------------------------
// 4) FAIL DIRECTION — with no model it degrades to the exact line that ships
//    today, plus the ask. Never a bare invented promise.
// ---------------------------------------------------------------------------
const noModel = buildWalkInPricingFollowUpTail({ modelLabel: "", softAsk });
assert.ok(
  noModel.startsWith("I’ll follow up with pricing details and next steps."),
  "no model resolved falls back to today's pricing line"
);
assert.ok(noModel.includes("stop back in"), "the fallback still asks");
assert.equal(
  buildWalkInPricingFollowUpTail({ modelLabel: "bike", softAsk }),
  noModel,
  "the no-model-resolved placeholder is not a model name"
);
assert.equal(
  buildWalkInPricingFollowUpTail({ modelLabel: "Street Glide", yearLabel: "2023", condition: "used" }),
  "I’ll get you the numbers on the pre-owned 2023 Street Glide.",
  "with no ask supplied the tail is a bare statement, never a dangling space"
);

// A model label that already carries its year must not say the year twice.
assert.equal(
  buildWalkInPricingFollowUpTail({ modelLabel: "2021 Road Glide Special", yearLabel: "2021" }),
  "I’ll get you the numbers on the 2021 Road Glide Special.",
  "the year is never repeated"
);

// ---------------------------------------------------------------------------
// 5) WIRING. Everything above proves the three functions behave; none of it can
//    prove the route still CALLS them — sabotaging the call site to
//    `const pricingFollowupIntentFromText = false;` left every assertion above
//    green (SKILL trap 2: the ratchet cannot prove wiring). The handler is an
//    Express route that cannot be executed here, so the honest available proof
//    is the exact call shape. Written with .includes() on purpose: a pin
//    containing an escaped paren is counted as a source-text assertion by
//    eval_source_pin_ratchet even when it is checking wiring.
// ---------------------------------------------------------------------------
const routeSource = readFileSync(
  new URL("../services/api/src/routes/sendgridInbound.ts", import.meta.url),
  "utf8"
);
assert.ok(
  routeSource.includes("hasWalkInPricingFollowUpPhrase(walkInCleanedComment)"),
  "the route reads the price ask off the note through the shared gate"
);
assert.ok(
  !routeSource.includes("circle back|touch base)\\b[\\s\\S]{0,40}\\b(pricing"),
  "the inline copy of the phrase regex is gone, so it cannot drift from the one under test"
);
assert.ok(
  routeSource.includes("buildWalkInPricingFollowUpTail({"),
  "the route builds the pricing tail here, not a literal"
);

const availabilityCall = routeSource.slice(
  routeSource.indexOf("shouldWalkInAvailabilityTailSpeak({")
);
assert.ok(
  availabilityCall.startsWith("shouldWalkInAvailabilityTailSpeak({"),
  "the availability block asks the predicate rather than an inline condition"
);
const availabilityArgs = availabilityCall.slice(0, availabilityCall.indexOf("})"));
for (const signal of [
  "modelLabel",
  "hasPricingFollowupIntent",
  "hasCompletedTestRideSignal",
  "hasDealProgressSignal",
  "hasHoldSignal",
  "hasResumeHoldSignal",
  "hasReminderRequest"
]) {
  assert.ok(
    availabilityArgs.includes(signal),
    `the availability predicate is handed ${signal} — a dropped argument reads as false and silently widens the guard`
  );
}

console.log("walkin_pricing_ask_tail:eval PASS");
