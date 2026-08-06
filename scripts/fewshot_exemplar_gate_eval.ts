/**
 * Few-shot exemplar gate eval (pure, no LLM).
 *
 * The corpus this gate feeds is injected into EVERY draft, so a bad exemplar is copied into every
 * message the agent writes. Two failure directions, both pinned here:
 *   STARVATION — selecting on `provider === "human"` matched 38 messages in the whole store inside a
 *   2-hour window, freezing the teaching set at six examples since 2026-07-21. The discriminator is
 *   the ACTOR STAMP (`isHumanAuthoredOutbound`); an approved AI draft sends via "twilio" too.
 *   CONTAMINATION — raw staff replies are not a teaching set. Over the full store on 2026-08-06 the
 *   miner considered 2,492 inbound→reply pairs and rejected 495 human-owned-thread sends, 39
 *   money-quoting replies, and 193 where one reply had been pasted onto several different customer
 *   messages.
 *
 * Run: npx tsx scripts/fewshot_exemplar_gate_eval.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  collectExemplarTurn,
  isStaffAuthoredReply,
  rejectExemplarReason
} from "../services/api/src/domain/fewShotExemplarGate.ts";

const staff = { direction: "out", provider: "twilio", actorUserName: "Joe Hartrich", body: "I can keep an eye out for a pre-owned Breakout." };

// --- 1) The discriminator: actor stamp, NOT provider. ---
assert.equal(isStaffAuthoredReply(staff), true, "an actor-stamped twilio send IS a staff reply — this is the 1,261 pool");
assert.equal(
  isStaffAuthoredReply({ ...staff, actorUserName: null, actorUserId: null }),
  false,
  "no actor stamp = an agent draft that went out over twilio, or a broadcast — never an exemplar"
);
assert.equal(
  isStaffAuthoredReply({ ...staff, actorUserName: null, actorUserId: "u_123" }),
  true,
  "either actor field alone is enough"
);
assert.equal(isStaffAuthoredReply({ ...staff, direction: "in" }), false, "an inbound is not a reply");
assert.equal(isStaffAuthoredReply({ ...staff, provider: "voice_call" }), false, "a call log is not a text exemplar");
assert.equal(isStaffAuthoredReply({ ...staff, provider: "draft_ai" }), false, "an unsent draft is not an exemplar");
// The old rule, kept as an explicit regression pin: provider-only selection is what starved it.
assert.equal(
  isStaffAuthoredReply({ direction: "out", provider: "human", actorUserName: null, actorUserId: null, body: "hi" }),
  false,
  "provider 'human' with NO actor stamp must not qualify — that rule is what froze the corpus"
);

// --- 2) The quality gate: what must never be taught. ---
const cases: [string, Parameters<typeof rejectExemplarReason>[0], ReturnType<typeof rejectExemplarReason>][] = [
  ["a normal advancing reply", { message: staff, threadMode: "active", isShortAck: false }, null],
  // The measured hazard: a rep quoted $21,495 on a unit with NO set price. Taught as a pattern it
  // becomes "volunteer a number" — the unsolicited-payment-quote class.
  ["quotes a dollar figure", { message: { ...staff, body: "We will probably ask $21,495" }, threadMode: "active", isShortAck: false }, "quotes_money"],
  ["quotes a monthly payment", { message: { ...staff, body: "You'd be around 497 a month on that one" }, threadMode: "active", isShortAck: false }, "quotes_money"],
  ["human-owned thread", { message: staff, threadMode: "manual_handoff", isShortAck: false }, "human_owned_thread"],
  ["human mode thread", { message: staff, threadMode: "human", isShortAck: false }, "human_owned_thread"],
  ["short ack", { message: staff, threadMode: "active", isShortAck: true }, "too_short"],
  ["agent draft that shipped over twilio", { message: { ...staff, actorUserName: null, actorUserId: null }, threadMode: "active", isShortAck: false }, "not_staff_authored"],
  // Both found in the promoted set on 2026-08-06 — artifacts, not messages.
  ["a draft that greets twice", { message: { ...staff, body: "Hi Patrick, Hey Patrick, it's Alexandra over at American Harley-Davidson." }, threadMode: "active", isShortAck: false }, "malformed_reply"],
  ["a pasted VIN/spec block", { message: { ...staff, body: "2011 HARLEY-DAVIDSON FLSTF FAT BOY 1HD1BX511BB030980 NO SECURITY SYSTEM" }, threadMode: "active", isShortAck: false }, "malformed_reply"],
  ["one greeting is normal", { message: { ...staff, body: "Hey John — I can get photos over to you today." }, threadMode: "active", isShortAck: false }, null]
];
for (const [label, input, want] of cases) {
  assert.equal(rejectExemplarReason(input), want, `${label}: expected ${want ?? "ACCEPT"}`);
}

// --- 3) One customer TURN, not N copies of one reply. ---
// Measured 2026-08-06 over the full store: 193 of 403 candidates were the same reply pasted onto
// 2+ different inbound messages. The worst was one "Ok, will do." attached to NINE questions,
// including "What do I have to do to reserve one" — teaching that a vague acknowledgment answers a
// direct question, which is the passivity at the top of the ranked comprehension backlog.
const T = (mins: number) => new Date(Date.UTC(2026, 7, 6, 12, mins, 0)).toISOString();

const burst = collectExemplarTurn({
  inbounds: [
    { at: T(0), body: "Do you still have the 2019 Street Glide" },
    { at: T(2), body: "And what's the mileage on it" }
  ],
  replyAt: T(20)
});
assert.ok(burst.ok, "a two-message burst answered once must produce an exemplar");
assert.equal(burst.ok && burst.messageCount, 2, "both customer messages belong to the turn");
assert.ok(
  burst.ok && burst.inboundText.includes("mileage") && burst.inboundText.includes("Street Glide"),
  "the exemplar must carry EVERYTHING the customer asked — that is the behaviour we want taught"
);
assert.ok(
  burst.ok && burst.inboundText.indexOf("Street Glide") < burst.inboundText.indexOf("mileage"),
  "messages must stay in the order the customer sent them"
);

// A reply a day and a half later is not an answer to that turn.
assert.equal(
  (collectExemplarTurn({
    inbounds: [{ at: T(0), body: "any word on the super glide?" }],
    replyAt: "2026-08-08T12:00:00.000Z"
  }) as any).reason,
  "reply_too_late",
  "a reply well outside the lag bound must not be recorded as answering that message"
);

// The nine-message case: older unanswered asks are their own turns, not things this reply covered.
const stale = collectExemplarTurn({
  inbounds: [
    { at: "2026-07-20T12:00:00.000Z", body: "What do I have to do to reserve one" },
    { at: T(0), body: "Any update?" }
  ],
  replyAt: T(10)
});
assert.ok(stale.ok, "the recent message still yields an exemplar");
assert.equal(stale.ok && stale.messageCount, 1, "the weeks-old unanswered question is NOT part of this turn");
assert.ok(
  stale.ok && !stale.inboundText.includes("reserve one"),
  "an unanswered older ask must not be presented as something this reply addressed"
);

assert.equal(
  (collectExemplarTurn({ inbounds: [], replyAt: T(10) }) as any).reason,
  "superseded_by_later_inbound",
  "no usable customer message means no exemplar"
);

// --- 4) Wiring: the miner must USE the gate, and must not still select on provider. ---
const miner = fs.readFileSync("scripts/language_corpus_mine.ts", "utf8");
// Reference, not call-syntax: pinning `foo(` breaks on every refactor and a sloppy re-pin guards
// nothing (eval_source_pin_ratchet). The behaviour is covered by the 14 executed cases above.
assert.ok(miner.includes("rejectExemplarReason"), "the miner must go through the gate");
assert.ok(
  !/nextOutProvider === "human"/.test(miner),
  "the miner must no longer select exemplars by provider — that is the rule that starved the corpus"
);
assert.ok(/fewShotRejections/.test(miner), "the miner must count rejections so starvation is visible, not silent");
// Counting them and then dropping them on the floor is the same silence. The first run of this
// change computed the map and never wrote it to the report.
assert.ok(
  miner.includes("fewShotRejectionsByReason"),
  "the rejection counts must reach the summary report — an uncounted drop is how this hid for 15 days"
);
assert.ok(miner.includes("collectExemplarTurn"), "the miner must build one exemplar per customer TURN");

console.log(
  `PASS few-shot exemplar gate eval — actor-stamp discriminator (7 cases) + ${cases.length} quality-gate cases + 8 turn-pairing assertions + miner wiring`
);
