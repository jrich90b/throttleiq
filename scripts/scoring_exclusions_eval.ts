/**
 * Scoring exclusions eval — quality scorers must skip shadow-replay traffic,
 * automated senders, and non-sales threads (release-gate honesty).
 */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";

import {
  isAutomatedSenderInbound,
  isClosingAckNoAction,
  isJustifiedLongTermCadencePark,
  isNonSalesConversation,
  isShadowReplayMessage,
  isYearRolloverParkFingerprint
} from "../services/api/src/domain/scoringExclusions.ts";

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

// Scorers must be wired to the shared module.
const wiring: Array<[string, RegExp[]]> = [
  [
    "scripts/tone_quality_eval.ts",
    [/isShadowReplayMessage\(inbound\)/, /isAutomatedSenderInbound\(/, /isNonSalesConversation\(conv\)/]
  ],
  ["scripts/voice_charter_audit.ts", [/isShadowReplayMessage\(m\)/],],
  [
    "scripts/route_audit_watchdog.ts",
    [/isShadowReplayMessage\(m\)/, /isAutomatedSenderInbound\(/, /isNonSalesConversation\(conv\)/]
  ]
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
