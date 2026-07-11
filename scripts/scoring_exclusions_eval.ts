/**
 * Scoring exclusions eval — quality scorers must skip shadow-replay traffic,
 * automated senders, and non-sales threads (release-gate honesty).
 */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";

import {
  isAutomatedSenderInbound,
  isBareEmoticonReaction,
  isCadenceHeldByIndefiniteDeferral,
  isClosingAckNoAction,
  isHumanRewrittenOutbound,
  isIndefiniteDeferralNoActionableAsk,
  isIndefiniteFollowUpDeferralText,
  isLeadIntakeRenotificationOnEngagedThread,
  isJustifiedLongTermCadencePark,
  isNonSalesConversation,
  isOptOutKeywordInbound,
  isShadowReplayMessage,
  isTestLeadEmail,
  isYearRolloverParkFingerprint
} from "../services/api/src/domain/scoringExclusions.ts";

// Indefinite follow-up deferral (the engine's cadence-tick hold; John Miller
// +15857657010 dirtied the gate daily 7/1-7/7 because the stalled detector
// couldn't see this hold).
assert.equal(
  isIndefiniteFollowUpDeferralText("Thank you for reaching out Alexander I will let you know if I need anything"),
  true
); // live case
assert.equal(isIndefiniteFollowUpDeferralText("I'll let you know"), true);
assert.equal(isIndefiniteFollowUpDeferralText("We will reach out when we're ready"), true);
assert.equal(isIndefiniteFollowUpDeferralText("I'll get back to you next week"), true);
assert.equal(isIndefiniteFollowUpDeferralText("Can you let me know when it arrives?"), false); // customer asks US to reach out
assert.equal(isIndefiniteFollowUpDeferralText("What colors do you have?"), false);
assert.equal(isIndefiniteFollowUpDeferralText(""), false);
// Conversation level: only the LAST non-empty inbound counts (a new customer
// message clears the hold by becoming the new last inbound).
assert.equal(
  isCadenceHeldByIndefiniteDeferral({
    messages: [
      { direction: "out", body: "Thanks for signing up!" },
      { direction: "in", body: "I will let you know if I need anything" }
    ]
  }),
  true
);
assert.equal(
  isCadenceHeldByIndefiniteDeferral({
    messages: [
      { direction: "in", body: "I will let you know if I need anything" },
      { direction: "in", body: "Actually — is the Fat Boy still available?" }
    ]
  }),
  false
);
assert.equal(isCadenceHeldByIndefiniteDeferral({ messages: [] }), false);

// Pure indefinite-deferral inbound (Gary Shapiro +17167069902 7/7: "I'll let you
// know. I'm in no rush." graded a phantom missing_response because hasActionableCue
// misfired on the deferral-context "tomorrow"/"next week"). The tone scorer must
// skip these one turn earlier than the cadence hold.
assert.equal(
  isIndefiniteDeferralNoActionableAsk(
    "I'll see how tomorrow goes. I'll be tied up for a while. I'll let you know. I'm in no rush. if we can't do this week I'll try for next week,"
  ),
  true
); // live case
assert.equal(isIndefiniteDeferralNoActionableAsk("I'll let you know, no rush"), true);
assert.equal(isIndefiniteDeferralNoActionableAsk("We'll reach out when we're ready, thanks"), true);
// Fail-direction guards: a deferral that ALSO carries a real ask must STILL score.
assert.equal(isIndefiniteDeferralNoActionableAsk("I'll let you know — but what's the price?"), false); // question
assert.equal(isIndefiniteDeferralNoActionableAsk("I'll let you know. Just send me the price first"), false); // transactional cue
assert.equal(isIndefiniteDeferralNoActionableAsk("I'll get back to you, can you hold it for me"), false); // request cue
assert.equal(isIndefiniteDeferralNoActionableAsk("What colors do you have?"), false); // not a deferral at all
assert.equal(isIndefiniteDeferralNoActionableAsk(""), false);

// Shadow replay markers (scripts/inbound_shadow_replay.ts id formats).
assert.equal(isShadowReplayMessage({ providerMessageId: "SMshadow1781172955abc123" }), true);
assert.equal(isShadowReplayMessage({ providerMessageId: "adf_shadow_1781172955_x1y2z3" }), true);
assert.equal(isShadowReplayMessage({ from: "shadow-replay@leadrider.ai" }), true);
assert.equal(isShadowReplayMessage({ providerMessageId: "SM16cffd94acd340ba7746e936" }), false);
assert.equal(isShadowReplayMessage({ providerMessageId: "MMbd063b253b1db761aa7ef89e" }), false);

// Automated senders (autosender@trafficlogpro.com produced a phantom miss 6/9).
assert.equal(
  isAutomatedSenderInbound({ from: "autosender@trafficlogpro.com", body: "anything" }),
  true
);
assert.equal(isAutomatedSenderInbound({ convId: "autosender@trafficlogpro.com" }), true);
assert.equal(
  isAutomatedSenderInbound({
    from: "someone@yahoo.com",
    body: "This email contains HTML formatted content, please be sure to view it in an HTML capable email client."
  }),
  true
);
assert.equal(isAutomatedSenderInbound({ from: "noreply@hd.com", body: "Lead notification" }), true);
assert.equal(
  isAutomatedSenderInbound({ from: "jacksoncharles32@yahoo.com", body: "Is the Nightster available?" }),
  false
);

// Non-sales threads (Jim Serio hiring thread scored as a customer miss 6/11).
assert.equal(isNonSalesConversation({ followUp: { reason: "hiring_manager_inquiry" } }), true);
assert.equal(isNonSalesConversation({ followUp: { reason: "post_sale" } }), false);
assert.equal(isNonSalesConversation({}), false);

// Placeholder / DLA test-harness leads (2026-07-01: 3 of 6 "tone missing" turns
// were `test@` Dealer Lead App submissions the runtime correctly didn't draft).
assert.equal(isTestLeadEmail("test@hotmail.com"), true); // live case
assert.equal(isTestLeadEmail("test@icloud.com"), true); // live case
assert.equal(isTestLeadEmail("TEST@Hotmail.com"), true); // case-insensitive
assert.equal(isTestLeadEmail("test+dla@gmail.com"), true); // plus-tagged
assert.equal(isTestLeadEmail("test.11@gmail.com"), true); // dotted-suffix variant
assert.equal(isTestLeadEmail("kevin@example.com"), true); // reserved test domain (was inline)
assert.equal(isTestLeadEmail("kevin@example.net"), true);
assert.equal(isTestLeadEmail("contestwinner@yahoo.com"), false); // "test" is a substring, not the local-part
assert.equal(isTestLeadEmail("greatest@gmail.com"), false);
assert.equal(isTestLeadEmail("flhtharlet@roadrunner.com"), false); // real lead (Angelo)
assert.equal(isTestLeadEmail("+17162667396"), false); // a phone convId is not an email
assert.equal(isTestLeadEmail(""), false);
assert.equal(isTestLeadEmail(null), false);

// Carrier opt-out keywords (Tom Kraft +17165237203 6/30: bare "Stop" — Twilio
// opts out + blocks outbound, so agent silence is the only legal behavior, not
// a missing_response). Matches ONLY the whole-message bare keyword.
assert.equal(isOptOutKeywordInbound("Stop"), true);
assert.equal(isOptOutKeywordInbound("STOP"), true);
assert.equal(isOptOutKeywordInbound("stop."), true);
assert.equal(isOptOutKeywordInbound("unsubscribe"), true);
assert.equal(isOptOutKeywordInbound("Cancel"), true);
assert.equal(isOptOutKeywordInbound("opt out"), true);
assert.equal(isOptOutKeywordInbound("opt-out"), true);
assert.equal(isOptOutKeywordInbound("stop texting me about the road glide"), false); // real, answerable
assert.equal(isOptOutKeywordInbound("Can you stop by tomorrow?"), false);
assert.equal(isOptOutKeywordInbound("I need to cancel my appointment for Friday"), false);
assert.equal(isOptOutKeywordInbound(""), false);

// Human-rewritten outbound (Gary Busenlehner +17163168664 6/29: agent drafted a
// clean scheduling answer, Scott sent different text, tone scorer graded the
// AGENT on Scott's words). A non-empty originalDraftBody that DIFFERS from the
// sent body means a human rewrote the draft — not the agent's reply.
assert.equal(
  isHumanRewrittenOutbound({
    body: "You can take the bike but unfortunately it wont have the accessories installed",
    originalDraftBody: "Sure. what time on tomorrow works best?"
  }),
  true
);
// Verbatim-approved draft (body matches the draft, modulo whitespace) IS the
// agent's reply — must still be graded.
assert.equal(
  isHumanRewrittenOutbound({ body: "Sounds good, see you then!", originalDraftBody: "Sounds good, see you then!" }),
  false
);
assert.equal(
  isHumanRewrittenOutbound({ body: "Sounds good,  see you then!", originalDraftBody: "Sounds good, see you then!" }),
  false
); // whitespace-only difference is not a rewrite
// Automated/agent send with no draft snapshot — never excluded (fail-safe: a
// real agent miss can never be hidden by this classifier).
assert.equal(isHumanRewrittenOutbound({ body: "Great — we'll see you then." }), false);
assert.equal(isHumanRewrittenOutbound({ body: "Great — we'll see you then.", originalDraftBody: "" }), false);
assert.equal(isHumanRewrittenOutbound({ body: "", originalDraftBody: "some draft" }), false);

// Year-rollover park fingerprint (the cadence bug that must stay flagged):
// 1st of a month at a round 9-o'clock boundary (09:00Z, or 09:00 ET = 13:00Z/14:00Z).
assert.equal(isYearRolloverParkFingerprint("2027-06-01T09:00:00.000Z"), true); // original signature
assert.equal(isYearRolloverParkFingerprint("2027-05-01T13:00:00.000Z"), true); // 09:00 EDT
assert.equal(isYearRolloverParkFingerprint("2027-01-01T14:00:00.000Z"), true); // 09:00 EST
assert.equal(isYearRolloverParkFingerprint("2027-02-16T16:57:00.000Z"), false); // legit long-term date
assert.equal(isYearRolloverParkFingerprint("2026-09-15T14:30:00.000Z"), false); // non-zero minutes
assert.equal(isYearRolloverParkFingerprint("2027-05-01T18:00:00.000Z"), false); // 1st but not a 9-o'clock hour
assert.equal(isYearRolloverParkFingerprint(null), false);

// Closing acknowledgments — silence is the designed closeout behavior, so the
// tone scorer must not grade them as missing_response (Ethan Mouyeos's "Good to
// know. Thank you!" to a post-sale cadence info push was a phantom miss 6/19).
assert.equal(isClosingAckNoAction("Good to know. Thank you!"), true);
assert.equal(isClosingAckNoAction("Makes sense, appreciate it"), true);
assert.equal(isClosingAckNoAction("Thanks 👍"), true);
assert.equal(isClosingAckNoAction("Good to hear that, thanks so much!"), true);
assert.equal(isClosingAckNoAction("ok thank you"), true);
assert.equal(isClosingAckNoAction("You too, have a great weekend"), true);
// Fail-direction guards: anything carrying an actual ask must STILL be graded.
assert.equal(isClosingAckNoAction("Good to know. Can you send the price?"), false); // question
assert.equal(isClosingAckNoAction("Thanks! When can I come in?"), false); // question
assert.equal(isClosingAckNoAction("Good to know, what's the monthly payment"), false); // actionable cue
assert.equal(isClosingAckNoAction("thanks, is the street glide still available"), false); // actionable cue
assert.equal(isClosingAckNoAction("Thanks for the info, I'll stop by tomorrow"), false); // actionable cue
assert.equal(isClosingAckNoAction("Cool 😎"), false); // bare reaction, no substantive closer
assert.equal(isClosingAckNoAction(""), false);
// A gratitude closer trailed by a familiar vocative is still a closer ("Thanks
// battle budy" was a phantom missing_response 6/26 — typed sign-off, no ask).
assert.equal(isClosingAckNoAction("Thanks battle budy"), true);
assert.equal(isClosingAckNoAction("thanks man"), true);
assert.equal(isClosingAckNoAction("appreciate it brother"), true);
assert.equal(isClosingAckNoAction("thank you boss"), true);
assert.equal(isClosingAckNoAction("thanks guys"), true);
assert.equal(isClosingAckNoAction("thanks man, call me when you can"), false); // actionable cue survives the vocative
assert.equal(isClosingAckNoAction("thanks man, when can I come in?"), false); // question survives the vocative

// Bare ASCII-emoticon reactions — the typed twin of an emoji-only turn — are
// no-reply-needed reactions, not missing responses (":)" was a phantom miss 6/26).
assert.equal(isBareEmoticonReaction(":)"), true);
assert.equal(isBareEmoticonReaction(":-)"), true);
assert.equal(isBareEmoticonReaction(";)"), true);
assert.equal(isBareEmoticonReaction(":D"), true);
assert.equal(isBareEmoticonReaction("=)"), true);
assert.equal(isBareEmoticonReaction("<3"), true);
assert.equal(isBareEmoticonReaction("^_^"), true);
assert.equal(isBareEmoticonReaction(":) :)"), true);
// Fail-direction guards: anything with a real word/ask is NOT a bare reaction.
assert.equal(isBareEmoticonReaction("8 bikes?"), false);
assert.equal(isBareEmoticonReaction("ok"), false); // a word, not an emoticon
assert.equal(isBareEmoticonReaction("can I come at 12"), false);
assert.equal(isBareEmoticonReaction(""), false);

// Justified long-term parks (the Courtney Ward / ride-challenge class) are
// excluded from the far-future actions audit, but the rollover bug never is.
assert.equal(
  isJustifiedLongTermCadencePark({
    kind: "long_term",
    nextDueAt: "2027-02-16T16:57:00.000Z",
    deferredMessage: "You mentioned a 4-6 Months timeline. Reach out when the time is right."
  }),
  true
);
assert.equal(
  isJustifiedLongTermCadencePark({
    kind: "long_term",
    nextDueAt: "2026-09-15T14:30:00.000Z",
    deferredMessage: "ride_challenge_final_mileage"
  }),
  true
);
// Rollover fingerprint is never excused, even on a long_term cadence.
assert.equal(
  isJustifiedLongTermCadencePark({
    kind: "long_term",
    nextDueAt: "2027-05-01T13:00:00.000Z",
    deferredMessage: "stand-in"
  }),
  false
);
// Non-long_term kinds and message-less long_term parks stay flagged.
assert.equal(
  isJustifiedLongTermCadencePark({ kind: "standard", nextDueAt: "2027-02-16T16:57:00.000Z", deferredMessage: "x" }),
  false
);
assert.equal(
  isJustifiedLongTermCadencePark({ kind: "long_term", nextDueAt: "2027-03-10T12:34:00.000Z" }),
  false
);
assert.equal(isJustifiedLongTermCadencePark(null), false);

// Structured lead-intake re-notification on an already-engaged thread (Kody
// Erhard +17163975098 7/10: a duplicate `PHONE LOG (ADF)` re-sync arrived
// mid-live-finance-deal and was wrongly graded `missing_response`, dirtying the
// gate's toneMissingResponses). Skipped ONLY when a prior outbound exists, so a
// genuinely-new lead's first intake payload still gets graded.
assert.equal(
  isLeadIntakeRenotificationOnEngagedThread({
    body:
      "PHONE LOG (ADF) Source: Traffic Log Pro Ref: 11610 Name: Kody Phone: 7163975098 Year: 2026 Vehicle: Harley-Davidson Full Line Inquiry: PreQual: N",
    hasPriorOutbound: true
  }),
  true
); // duplicate ADF on an engaged thread → not a customer question
assert.equal(
  isLeadIntakeRenotificationOnEngagedThread({
    body: "WEB LEAD (ADF) Source: HDFS COA Online Ref: 11608 Name: Kody Erhard",
    hasPriorOutbound: true
  }),
  true
);
assert.equal(
  isLeadIntakeRenotificationOnEngagedThread({
    body: "WEB TEXT WIDGET Department: Sales Name: natik soni Page: Street 750 URL: https://x",
    hasPriorOutbound: true
  }),
  true
);
// Fail-direction: a NEW lead's FIRST intake payload (no prior outbound) is never
// skipped — a real "never responded to a new lead" miss must still be caught.
assert.equal(
  isLeadIntakeRenotificationOnEngagedThread({
    body:
      "PHONE LOG (ADF) Source: Traffic Log Pro Ref: 11610 Name: Kody Phone: 7163975098 Inquiry: PreQual: N",
    hasPriorOutbound: false
  }),
  false
);
// A real customer message never matches (no ADF/widget marker), even mid-thread.
assert.equal(
  isLeadIntakeRenotificationOnEngagedThread({
    body: "Is that price including an esp?",
    hasPriorOutbound: true
  }),
  false
);
assert.equal(
  isLeadIntakeRenotificationOnEngagedThread({
    body: "Can you check the adf source on that lead for me?",
    hasPriorOutbound: true
  }),
  false
); // mentions "adf" but no marker+field structure
assert.equal(isLeadIntakeRenotificationOnEngagedThread({ body: "", hasPriorOutbound: true }), false);

// Scorers must be wired to the shared module.
const wiring: Array<[string, RegExp[]]> = [
  [
    "scripts/tone_quality_eval.ts",
    [
      /isShadowReplayMessage\(inbound\)/,
      /isAutomatedSenderInbound\(/,
      /isNonSalesConversation\(conv\)/,
      /isIndefiniteDeferralNoActionableAsk\(inboundText\)/,
      /isLeadIntakeRenotificationOnEngagedThread\(/
    ]
  ],
  ["scripts/voice_charter_audit.ts", [/isShadowReplayMessage\(m\)/],],
  [
    "scripts/route_audit_watchdog.ts",
    [/isShadowReplayMessage\(m\)/, /isAutomatedSenderInbound\(/, /isNonSalesConversation\(conv\)/]
  ],
  // The engine's cadence tick and the actions audit must share ONE indefinite-
  // deferral predicate — if either side re-inlines its own copy they drift and
  // the John Miller class (correct hold flagged "stalled" daily) comes back.
  ["services/api/src/index.ts", [/isIndefiniteFollowUpDeferralText\(t\)/]],
  ["scripts/agent_actions_audit.ts", [/isCadenceHeldByIndefiniteDeferral\(conv\)/]]
];
for (const [file, patterns] of wiring) {
  const src = await fs.readFile(path.resolve(file), "utf8");
  for (const re of patterns) {
    assert.match(src, re, `${file} must use ${re}`);
  }
}

// Shadow replay hermeticity: the spawned shadow API must override the
// loop-exported live-store paths, or it reads/writes production data.
const replaySrc = await fs.readFile(path.resolve("scripts/inbound_shadow_replay.ts"), "utf8");
assert.match(
  replaySrc,
  /CONVERSATIONS_DB_PATH: path\.join\(args\.dataDir, "conversations\.json"\)/,
  "shadow replay must pin CONVERSATIONS_DB_PATH to the shadow data copy"
);

console.log("PASS scoring exclusions eval");
