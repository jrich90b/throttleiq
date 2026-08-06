/**
 * Few-shot exemplar gate eval (pure, no LLM).
 *
 * The corpus this gate feeds is injected into EVERY draft, so a bad exemplar is copied into every
 * message the agent writes. Two failure directions, both pinned here:
 *   STARVATION — selecting on `provider === "human"` matched 38 messages in the whole store inside a
 *   2-hour window, freezing the teaching set at six examples since 2026-07-21. The discriminator is
 *   the ACTOR STAMP (`isHumanAuthoredOutbound`); an approved AI draft sends via "twilio" too.
 *   CONTAMINATION — 1,261 raw staff replies is not a teaching set. Measured over the live store this
 *   gate rejects 325 human-owned-thread sends and 16 money-quoting replies, and accepts 199.
 *
 * Run: npx tsx scripts/fewshot_exemplar_gate_eval.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { isStaffAuthoredReply, rejectExemplarReason } from "../services/api/src/domain/fewShotExemplarGate.ts";

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
  ["agent draft that shipped over twilio", { message: { ...staff, actorUserName: null, actorUserId: null }, threadMode: "active", isShortAck: false }, "not_staff_authored"]
];
for (const [label, input, want] of cases) {
  assert.equal(rejectExemplarReason(input), want, `${label}: expected ${want ?? "ACCEPT"}`);
}

// --- 3) Wiring: the miner must USE the gate, and must not still select on provider. ---
const miner = fs.readFileSync("scripts/language_corpus_mine.ts", "utf8");
// Reference, not call-syntax: pinning `foo(` breaks on every refactor and a sloppy re-pin guards
// nothing (eval_source_pin_ratchet). The behaviour is covered by the 14 executed cases above.
assert.ok(miner.includes("rejectExemplarReason"), "the miner must go through the gate");
assert.ok(
  !/nextOutProvider === "human"/.test(miner),
  "the miner must no longer select exemplars by provider — that is the rule that starved the corpus"
);
assert.ok(/fewShotRejections/.test(miner), "the miner must count rejections so starvation is visible, not silent");

console.log(
  `PASS few-shot exemplar gate eval — actor-stamp discriminator (7 cases) + ${cases.length} quality-gate cases + miner wiring`
);
