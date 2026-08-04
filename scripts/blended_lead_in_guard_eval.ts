/**
 * blended_lead_in_guard:eval — pins isFabricatedGratitudeLeadIn (leadInGuards.ts) + its wiring
 * into generateBlendedLeadInWithLLM. The blended lead-in LLM acknowledges a customer's chatter
 * before the business reply; it must NOT respond to thanks the customer never gave. Real miss
 * (mike jaglowski, 6/16): "I absolutely love my bike, was more curiosity of what the value is" ->
 * "You're welcome." (affection, not gratitude). The guard drops a gratitude-style lead-in unless
 * the customer's turn actually thanked.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  LEAD_IN_MAX_INBOUND_AGE_MS,
  customerSpokenText,
  hasCustomerGratitude,
  hasCustomerPositiveExperience,
  isFabricatedGratitudeLeadIn,
  resolveLeadInSourceText
} from "../services/api/src/domain/leadInGuards.ts";

// The reproduced production miss: gratitude lead-in, no thanks in the customer turn -> fabricated.
assert.equal(
  isFabricatedGratitudeLeadIn("You're welcome.", "I have to be honest I absolutely love my bike, was more curiosity of what the value is"),
  true,
  "the mike jaglowski miss: 'You're welcome' on affection (no thanks) -> fabricated"
);
assert.equal(isFabricatedGratitudeLeadIn("No problem.", "Can you send pics of the bike?"), true, "'No problem' with no thanks -> fabricated");
assert.equal(isFabricatedGratitudeLeadIn("Happy to help!", "what's my trade worth"), true, "'Happy to help' with no thanks -> fabricated");
assert.equal(isFabricatedGratitudeLeadIn("Anytime.", "do you have any tri glides"), true, "'Anytime' with no thanks -> fabricated");

// A genuine thank-you keeps the gratitude lead-in allowed.
assert.equal(isFabricatedGratitudeLeadIn("You're welcome.", "Thanks so much for the help!"), false, "real thanks -> gratitude lead-in is fine");
assert.equal(isFabricatedGratitudeLeadIn("You're welcome.", "appreciate it"), false, "'appreciate it' is gratitude -> allowed");
assert.equal(isFabricatedGratitudeLeadIn("Happy to help.", "thank you"), false, "'thank you' -> allowed");

// Non-gratitude lead-ins are never touched by this guard.
assert.equal(isFabricatedGratitudeLeadIn("Love that.", "I absolutely love my bike"), false, "warm non-gratitude lead-in -> not flagged");
assert.equal(isFabricatedGratitudeLeadIn("Great question.", "what's the price"), false, "'Great question' -> not a gratitude lead-in");
assert.equal(isFabricatedGratitudeLeadIn("Haha, fair one.", "lol you guys could hire me"), false, "humor lead-in -> not flagged");
assert.equal(isFabricatedGratitudeLeadIn("", "thanks"), false, "empty lead-in -> not flagged");

// Wiring: the blended lead-in generator applies the guard at BOTH filter sites, with the prompt rule.
const draftSrc = fs.readFileSync(path.resolve("services/api/src/domain/llmDraft.ts"), "utf8");
const guardSites = (draftSrc.match(/!isFabricatedGratitudeLeadIn\(leadIn, text\)/g) ?? []).length;
assert.ok(guardSites >= 2, `both lead-in filter sites must apply the gratitude guard (found ${guardSites})`);
assert.ok(/never say 'You're welcome'/i.test(draftSrc) || /respond to thanks the customer did not give/i.test(draftSrc), "the lead-in prompt must forbid fabricated thanks");

// ---------------------------------------------------------------------------
// LEAD-IN SOURCE guard — the DETERMINISTIC twin (pickLeadInVariant / normalizeGotItLeadIn in
// conversationStore). Reproduced production miss: dominic +17169309966, 2026-07-20T10:37Z. A
// cadence ack "Sounds good — I'll be here when you're ready…" shipped as "You're welcome. I'll
// be here when you're ready…" — Joe thumbed it down ("Should have never said you're welcome"),
// the customer replied "??", and staff had to send "Sorry Dominic, didn't mean to send that
// last text". Root cause: the picker read "thank you" spoken by OUR agent inside a 93-day-old
// VOICE TRANSCRIPT. Every assertion below fails SAFE (a fired guard drops only the lead-in
// fragment; the business sentence still ships).

// 1. SPEAKER — a voice transcript is a two-speaker script; only the Customer: lines are theirs.
const DOMINIC_TRANSCRIPT = "Customer: Go ahead.\nAgent: Thank you.";
assert.equal(
  customerSpokenText(DOMINIC_TRANSCRIPT, "voice_transcript"),
  "Go ahead.",
  "the dominic miss: our own agent's 'Thank you.' is not the customer's words"
);
assert.equal(
  hasCustomerGratitude(customerSpokenText(DOMINIC_TRANSCRIPT, "voice_transcript")),
  false,
  "the dominic miss: no customer gratitude survives -> no 'You're welcome.'"
);
assert.equal(
  hasCustomerGratitude(DOMINIC_TRANSCRIPT),
  true,
  "guard rail: the RAW transcript still reads as gratitude — proving the speaker split is what fixes it"
);
assert.equal(
  customerSpokenText("Customer: Thanks a lot.\nAgent: Of course.", "voice_transcript"),
  "Thanks a lot.",
  "real customer gratitude inside a transcript is preserved"
);
assert.equal(
  customerSpokenText("Agent: Thank you for calling.", "voice_transcript"),
  "",
  "an agent-only transcript yields no customer text (fail-safe: no lead-in)"
);
assert.equal(
  customerSpokenText("thanks for the pics", "twilio"),
  "thanks for the pics",
  "a normal SMS inbound is the customer's own words, untouched"
);

// 2. STALENESS — an inbound from months ago can never frame a fresh send.
const NOW = "2026-07-20T10:37:28.601Z";
assert.equal(
  resolveLeadInSourceText({
    body: DOMINIC_TRANSCRIPT,
    provider: "voice_transcript",
    at: "2026-04-18T19:10:44.582Z",
    now: NOW
  }),
  "",
  "the dominic miss end-to-end: 93-day-old transcript contributes no lead-in source at all"
);
assert.equal(
  resolveLeadInSourceText({ body: "thanks!", provider: "twilio", at: "2026-07-20T10:00:00.000Z", now: NOW }),
  "thanks!",
  "a live thread (37 minutes old) still frames the lead-in normally"
);
assert.equal(
  resolveLeadInSourceText({ body: "thanks!", provider: "twilio", at: "2026-07-01T10:00:00.000Z", now: NOW }),
  "",
  "a 19-day-old inbound is past the staleness bound"
);
assert.equal(
  resolveLeadInSourceText({ body: "thanks!", provider: "twilio", at: null, now: NOW }),
  "thanks!",
  "fail-safe: an inbound with no usable timestamp keeps today's behavior"
);
assert.ok(LEAD_IN_MAX_INBOUND_AGE_MS >= 24 * 60 * 60 * 1000, "the staleness bound must stay generous enough for real reply threads");

// 3. WORD BOUNDS — the old picker matched "ty" as a substring, so ordinary words earned thanks.
for (const notThanks of [
  "what's the warranty?",
  "how much is the extended warranty",
  "pretty nice bike",
  "twenty grand is my max",
  "what about safety features",
  "quality of the paint"
]) {
  assert.equal(hasCustomerGratitude(notThanks), false, `substring footgun: ${JSON.stringify(notThanks)} is not gratitude`);
}
for (const realThanks of ["thanks man", "thank you!", "ty", "appreciate it"]) {
  assert.equal(hasCustomerGratitude(realThanks), true, `real gratitude still reads as thanks: ${JSON.stringify(realThanks)}`);
}

// 4. WIRING — the deterministic path must actually consult the guards (both are easy to drop).
const storeSrc = fs.readFileSync(path.resolve("services/api/src/domain/conversationStore.ts"), "utf8");
assert.ok(
  /resolveLeadInSourceText\(\{/.test(storeSrc),
  "appendOutbound must derive the lead-in from resolveLeadInSourceText, not the raw last inbound"
);
assert.ok(
  /hasCustomerGratitude\(t\)/.test(storeSrc),
  "pickLeadInVariant must use the shared word-bounded gratitude test"
);
assert.ok(
  /isFabricatedGratitudeLeadIn\(leadIn, source\)/.test(storeSrc),
  "normalizeGotItLeadIn must apply the fabricated-gratitude guard to the picked lead-in"
);

// 5. POST-SALE WARMTH (2026-08-04) — the third fabricated-frame site, found by the corpus replay.
// The production turn, pinned verbatim (conv +17164182619, msg_49ab66cab6d22_1783616788874). It
// reproduced 3/3 byte-identical on the deployed build as
// "Love hearing that — glad the ride home went great. Thanks — I'll check on the key ...".
const JEFF_TURN =
  "Hey Scott, it's Jeff. I'm gonna swing in on Saturday because I have that lien release. Did you call the old owner about the second key?";
assert.equal(
  hasCustomerPositiveExperience(JEFF_TURN),
  false,
  "the Jeff miss: a lien-release + spare-key logistics turn reports no positive experience -> no warmth frame"
);

// The defect was that the test ALSO read recent thread context, which carries our own outbound
// copy. Our standard post-sale outbound must never earn the frame on the customer's behalf.
for (const ourOwnCopy of [
  "Thanks again for coming to see us for your bike. If you need anything, just let me know.",
  "Great — you're all set for Saturday at 2.",
  "Love hearing that — glad the ride home went great."
]) {
  assert.equal(
    hasCustomerPositiveExperience(ourOwnCopy),
    true,
    `sanity: our own copy is positive text (${JSON.stringify(ourOwnCopy.slice(0, 24))}) — which is exactly why it must never be fed in as the customer's turn`
  );
}

// A genuinely delighted customer still earns the warmth frame.
for (const delighted of ["Bike is amazing, thank you!", "she rides great", "Love it so far", "priceless, all smiles"]) {
  assert.equal(hasCustomerPositiveExperience(delighted), true, `real delight keeps the frame: ${JSON.stringify(delighted)}`);
}
// Word-bounded, like its gratitude sibling — no substring footguns.
for (const neutral of ["what's the warranty?", "greatly delayed?", "I need the title paperwork", "dropping off the backseat"]) {
  assert.equal(hasCustomerPositiveExperience(neutral), false, `neutral logistics is not delight: ${JSON.stringify(neutral)}`);
}
// Two-speaker voice transcripts: only the customer's lines can earn it.
assert.equal(
  hasCustomerPositiveExperience("Customer: Just the key.\nAgent: Great, thanks so much!", "voice_transcript"),
  false,
  "an agent-spoken 'great/thanks' in a transcript must not earn the warmth frame"
);

// WIRING — index.ts must consult the guard, and must no longer assert the ride home.
const indexSrc = fs.readFileSync(path.resolve("services/api/src/index.ts"), "utf8");
assert.ok(
  /hasCustomerPositiveExperience\(args\.text\)/.test(indexSrc),
  "buildPurchaseDeliveryLogisticsReply must gate the warmth prefix on the customer's OWN turn"
);
assert.ok(
  !/ride home went great/.test(indexSrc),
  "the warmth prefix must not assert a ride home the customer never mentioned"
);

console.log("PASS blended-lead-in gratitude guard eval (helper + wiring + deterministic lead-in source + post-sale warmth)");
