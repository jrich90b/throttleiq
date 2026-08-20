/**
 * courtesy_intensifier:eval — three words of emphasis must not turn a closing ack into a
 * customer waiting for an answer.
 *
 * THE MISS (Jason Roorda +17165104578, 2026-08-19). The agent signed off at 16:41Z: "I'll
 * pause my check-ins here so I'm not crowding your phone, Jason." He answered at 17:26Z:
 * "No problem at all". The agent was correctly silent — and five instruments disagreed:
 *   - the tone scorer graded `missing_response`, score 0, band `poor`;
 *   - the per-message tripwire minted a "needs a reply" task;
 *   - that task paged the manager phone at 18:36Z;
 *   - the inbox row lit "Awaiting your reply";
 *   - two operator complaints landed 46 seconds apart.
 * Plain "no problem" was handled correctly by every one of them. The whole defect was that
 * `at all` is TWO words: it survived the filler pass in `isBareAcknowledgementText` (which
 * skips a turn only when under two content words are left) and it is neither a vocative nor
 * a separator in `CLOSING_ACK_FULL_RE` (which is anchored `^…$`, so the match failed outright).
 *
 * ONE CAUSE, TWO IMPLEMENTATIONS. The staff complaints named the SYMPTOMS — the awaiting tag
 * and the task — which would have sent a builder to two unrelated files. Both consumers ask
 * the same upstream question, so this eval pins BOTH predicates and then EXECUTES both
 * consumer decisions on Jason's actual shape. Cf. the `reintro-rule-wired-to-one-builder`
 * lesson: split a report before building it, then fix the shared cause once.
 *
 * WHY A PHRASE AND NOT TOKENS. Adding `at` and `all` to FILLER_TOKENS is the obvious one-line
 * fix and it is wrong: it also empties "Thanks at 3" — a customer confirming a time — into a
 * courtesy closer nobody replies to. The intensifier is therefore stripped as a UNIT, and the
 * loose-token failure mode is asserted below in both directions.
 *
 * BLAST RADIUS, MEASURED on the live americanharley store (3,227 inbound turns, 2026-08-20):
 * exactly 2 turns change classification, and both are the literal defect ("No problem at all",
 * "No problem at all."). Zero collateral. The four short turns store-wide carrying any
 * intensifier are listed in the fixture below — including the two that must NOT flip.
 *
 * NOT ADDED, deliberately: "no worries". It is not a closer phrase in either matcher today,
 * and all 5 live "no worries" turns carry real content ("No worries, how about this coming
 * Tuesday…"). Widening the phrase LIST on no evidence is the habit that produced this defect;
 * the intensifier slot is what generalises, so every phrase already on the list inherits it.
 */
import assert from "node:assert/strict";
import { isBareAcknowledgementText, isShortAckText } from "../services/api/src/domain/bareAcknowledgement.js";
import { isClosingAckNoAction } from "../services/api/src/domain/scoringExclusions.js";
import { decideTurnResponseTripwire } from "../services/api/src/domain/turnResponseTripwire.js";
import { decideAwaitingReplyFlag } from "../services/api/src/domain/awaitingReply.js";

// ---------------------------------------------------------------------------
// 1. The hit itself, in every spelling the store holds.
// ---------------------------------------------------------------------------
for (const text of ["No problem at all", "No problem at all.", "no problem at all ", "No problem at all!"]) {
  assert.equal(isBareAcknowledgementText(text), true, `bare-ack must skip ${JSON.stringify(text)}`);
  assert.equal(isClosingAckNoAction(text), true, `tone scorer must skip ${JSON.stringify(text)}`);
}

// ---------------------------------------------------------------------------
// 2. THE NEAR-MISSES, not just the hit. A phrase list grows one live string at a time; the
//    intensifier slot exists so the NEXT emphasised closer costs nobody a manager page.
//    Every phrase below was already a recognised closer in its plain form.
// ---------------------------------------------------------------------------
const INTENSIFIED_CLOSERS = [
  "Thanks a lot",
  "thank you a lot",
  "Appreciate it a ton",
  "appreciate that a bunch",
  "no problem whatsoever",
  "Thanks a million",
  "No problem at all man", // intensifier AND vocative stack
  "sounds good at all"
];
for (const text of INTENSIFIED_CLOSERS) {
  assert.equal(isClosingAckNoAction(text), true, `tone scorer must skip ${JSON.stringify(text)}`);
}
for (const text of ["Thanks a lot", "Appreciate it a ton", "no problem whatsoever", "No problem at all man"]) {
  assert.equal(isBareAcknowledgementText(text), true, `bare-ack must skip ${JSON.stringify(text)}`);
}

// ---------------------------------------------------------------------------
// 3. THE GUARDS STILL RUN FIRST. An emphasised closer that also carries an ask, a question,
//    or a plan is a real turn and stays graded / stays flagged.
// ---------------------------------------------------------------------------
const STILL_SUBSTANTIVE = [
  "No problem at all, can you send the price?",       // question mark
  "No problem at all - what time do you close",       // actionable cue + question shape
  "No problem at all, I'll be there tomorrow",        // a plan: he is coming in
  "No problem at all. Can I get a payment quote",     // actionable cue
  "Thanks a lot for the info, I'll stop by tomorrow"  // cue survives the intensifier
];
for (const text of STILL_SUBSTANTIVE) {
  assert.equal(isBareAcknowledgementText(text), false, `bare-ack must NOT skip ${JSON.stringify(text)}`);
  assert.equal(isClosingAckNoAction(text), false, `tone scorer must NOT skip ${JSON.stringify(text)}`);
}

// ---------------------------------------------------------------------------
// 4. THE LOOSE-TOKEN FAILURE MODE. If `at` / `all` are ever added to FILLER_TOKENS instead of
//    stripping the intensifier as a phrase, these flip and a customer confirming a time goes
//    silent. This is the assertion that fails on the tempting one-line "fix".
// ---------------------------------------------------------------------------
assert.equal(isBareAcknowledgementText("Thanks at 3"), false, "a time confirmation is not a courtesy closer");
assert.equal(isBareAcknowledgementText("thanks all set at 4"), false, "a time confirmation is not a courtesy closer");
assert.equal(isBareAcknowledgementText("ok great see you at 2"), false, "a time confirmation is not a courtesy closer");
// The intensifier can never QUALIFY a turn on its own — a real courtesy word is still required.
assert.equal(isBareAcknowledgementText("Not at all what I ordered"), false, "an intensifier alone is not an ack");
assert.equal(isClosingAckNoAction("at all"), false, "an intensifier alone is not a closer");
assert.equal(isClosingAckNoAction("a lot"), false, "an intensifier alone is not a closer");

// ---------------------------------------------------------------------------
// 5. THE FOUR LIVE TURNS. Every short inbound turn in the americanharley store carrying an
//    intensifier, 2026-08-20 — the two that must flip and the two that must not.
// ---------------------------------------------------------------------------
const LIVE_TURNS: Array<[string, boolean]> = [
  ["No problem at all ", true],
  ["No problem at all. ", true],
  ["For sure, thanks a lot for today! Definitely gonna stay in touch ", false],
  ["Sorry, I have a lot going on right now. Can I get back to you?", false]
];
for (const [text, expected] of LIVE_TURNS) {
  assert.equal(isBareAcknowledgementText(text), expected, `live turn ${JSON.stringify(text)}`);
}

// ---------------------------------------------------------------------------
// 6. THE CONSUMER DECISIONS, EXECUTED. Pinning the predicate is not enough — what cost the
//    manager page was the tripwire's fire and the inbox flag, so assert those OUTCOMES on
//    Jason's real shape: an agent sign-off, his answer 45 minutes later, nothing since.
// ---------------------------------------------------------------------------
const INBOUND_AT = "2026-08-19T17:26:00.000Z";
const NOW_MS = Date.parse("2026-08-19T18:36:00.000Z"); // when the manager phone actually buzzed

const jasonMessages = [
  {
    direction: "out",
    provider: "twilio",
    body: "I'll pause my check-ins here so I'm not crowding your phone, Jason.",
    at: "2026-08-19T16:41:00.000Z"
  },
  { direction: "in", provider: "twilio", body: "No problem at all", at: INBOUND_AT, id: "msg-jason-1" }
];

const tripwire = decideTurnResponseTripwire({
  nowMs: NOW_MS,
  conversationStatus: "open",
  mode: "agent",
  suppressed: false,
  lastMessage: jasonMessages[1],
  hasResponseArtifact: false
});
assert.equal(tripwire.fire, false, "the tripwire must not mint a task on an emphasised closing ack");
assert.equal((tripwire as { reason: string }).reason, "bare_acknowledgement");

const awaiting = decideAwaitingReplyFlag({
  nowMs: NOW_MS,
  status: "open",
  suppressed: false,
  draftHeld: null,
  hasPendingDraft: false,
  messages: jasonMessages
});
assert.equal(awaiting.awaiting, false, "the inbox must not light 'Awaiting your reply' on an emphasised closing ack");
assert.equal((awaiting as { reason: string }).reason, "courtesy_closer");

// And the mirror: the SAME turn carrying a real ask still fires both, so this fix never buys
// its silence by blinding the instruments.
const askMessages = [
  jasonMessages[0],
  {
    direction: "in",
    provider: "twilio",
    body: "No problem at all, can you send the price?",
    at: INBOUND_AT,
    id: "msg-jason-2"
  }
];
const tripwireAsk = decideTurnResponseTripwire({
  nowMs: NOW_MS,
  conversationStatus: "open",
  mode: "agent",
  suppressed: false,
  lastMessage: askMessages[1],
  hasResponseArtifact: false
});
assert.equal(tripwireAsk.fire, true, "an emphasised closer carrying a question must still fire the tripwire");
const awaitingAsk = decideAwaitingReplyFlag({
  nowMs: NOW_MS,
  status: "open",
  suppressed: false,
  draftHeld: null,
  hasPendingDraft: false,
  messages: askMessages
});
assert.equal(awaitingAsk.awaiting, true, "an emphasised closer carrying a question must still flag the inbox");

// ---------------------------------------------------------------------------
// 7. NOTHING THAT WORKED BEFORE STOPPED WORKING. The plain forms, and the cheap cost gate
//    (`isShortAckText`) which this change deliberately does not touch.
// ---------------------------------------------------------------------------
for (const text of ["no problem", "No problem!", "thanks so much", "Thank you very much", "thanks man"]) {
  assert.equal(isBareAcknowledgementText(text), true, `plain closer regression: ${JSON.stringify(text)}`);
  assert.equal(isClosingAckNoAction(text), true, `plain closer regression: ${JSON.stringify(text)}`);
}
assert.equal(isShortAckText("No problem at all"), true);
assert.equal(isShortAckText("Found a better offer. Thanks"), true); // unchanged: the cost gate is broad by design
assert.equal(isBareAcknowledgementText("Found a better offer. Thanks"), false); // and the narrow one still is not

console.log(
  "PASS courtesy_intensifier:eval — 4 spellings + 8 near-misses + 5 guard holds + 3 loose-token holds + 4 live turns + 4 executed consumer decisions"
);
