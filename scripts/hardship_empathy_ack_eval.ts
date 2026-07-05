/**
 * Hardship-empathy acknowledgment eval (deterministic — no LLM).
 *
 * Pins the hardship-empathy fix: when the LLM affect parser confidently flags a personal hardship
 * (needsEmpathy), the orchestrator finalize step LEADS the reply with a short acknowledgment before
 * any business — covering a normal sales/logistics turn that carries a hardship disclosure (the
 * Nicholas Braun case: a deposit/hold request texted from a hospital bed, replied to with a
 * tone-deaf "those limited runs move quick"). Generation-only.
 *
 * Pins: (1) the pure helper (prepend + double-ack guard), (2) that the orchestrator finalize
 * prepends it gated on ctx.needsEmpathy and suppresses the visit invite on the same turn, and
 * (3) that BOTH the live and regenerate ctx sites thread the affect parser's needsEmpathy in
 * (parser-first-in-both-paths).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  HARDSHIP_EMPATHY_ACK,
  draftAlreadyAcknowledgesHardship,
  prependHardshipAck,
  shouldPrependHardshipAck
} from "../services/api/src/domain/hardshipEmpathyAck.ts";
import {
  customerDisclosedHardship,
  outboundAcknowledgesHardship,
  evaluateTurnToneQuality
} from "./lib/toneQuality.ts";

// ---- Pure helper: prepend + no-op safety ----
const sales = "We have a few ways to hold it for you — happy to walk you through them.";
assert.equal(
  prependHardshipAck(sales),
  `${HARDSHIP_EMPATHY_ACK} ${sales}`,
  "prepends the acknowledgment, empathy leads"
);
assert.equal(prependHardshipAck(""), HARDSHIP_EMPATHY_ACK, "empty draft → ack alone (no leading space)");
assert.equal(prependHardshipAck("  hi"), `${HARDSHIP_EMPATHY_ACK} hi`, "trims leading whitespace before prefixing");

// ---- Double-ack guard: never prepend when the draft already opens with an empathy beat ----
for (const already of [
  "I'm so sorry to hear that — take your time.",
  "Sorry to hear you're going through this.",
  "Oh no, that's really tough. Whenever you're ready.",
  "Hope you're doing okay — no rush at all.",
  "Wishing you a speedy recovery."
]) {
  assert.ok(draftAlreadyAcknowledgesHardship(already), `recognizes existing ack: "${already}"`);
  assert.equal(
    shouldPrependHardshipAck({ needsEmpathy: true, shouldRespond: true, draft: already, wrongContext: false }),
    false,
    "no double-ack when draft already acknowledges"
  );
}
assert.ok(
  !draftAlreadyAcknowledgesHardship("Those limited runs move quick — I'll have Stone reach out."),
  "a tone-deaf sales push is NOT an acknowledgment"
);

// ---- Gating ----
const toneDeaf = "Those limited runs move quick — I'll have Stone reach out.";
assert.ok(
  shouldPrependHardshipAck({ needsEmpathy: true, shouldRespond: true, draft: toneDeaf, wrongContext: false }),
  "prepends on a confident hardship turn with an unacknowledged reply"
);
assert.equal(
  shouldPrependHardshipAck({ needsEmpathy: false, shouldRespond: true, draft: toneDeaf, wrongContext: false }),
  false,
  "no prepend when affect parser did not flag hardship"
);
assert.equal(
  shouldPrependHardshipAck({ needsEmpathy: true, shouldRespond: false, draft: toneDeaf, wrongContext: false }),
  false,
  "no prepend when not responding"
);
assert.equal(
  shouldPrependHardshipAck({ needsEmpathy: true, shouldRespond: true, draft: toneDeaf, wrongContext: true }),
  false,
  "no prepend in a wrong context (e.g. manual handoff owns its own empathy)"
);
assert.equal(
  shouldPrependHardshipAck({ needsEmpathy: true, shouldRespond: true, draft: "   ", wrongContext: false }),
  false,
  "no prepend on an empty draft"
);

// ---- Source guard: orchestrator finalize prepends, gated, and suppresses the invite ----
const orch = fs.readFileSync("services/api/src/domain/orchestrator.ts", "utf8");
assert.ok(/prependHardshipAck/.test(orch) && /shouldPrependHardshipAck/.test(orch), "orchestrator uses the helper");
assert.ok(/needsEmpathy:\s*!!ctx\?\.needsEmpathy/.test(orch), "prepend is gated on ctx.needsEmpathy");
assert.ok(
  /Don't nudge a booking[\s\S]*?!!ctx\?\.needsEmpathy/.test(orch),
  "the proactive visit invite is suppressed when needsEmpathy (no booking nudge during hardship)"
);

// ---- Source guard: the LLM draft prompt gets a hardship instruction gated on needsEmpathy ----
const draft = fs.readFileSync("services/api/src/domain/llmDraft.ts", "utf8");
assert.ok(/needsEmpathy\??:\s*boolean/.test(draft), "DraftContext carries a needsEmpathy flag");
assert.ok(/const hardshipRules = ctx\.needsEmpathy/.test(draft), "the prompt builds a hardship block gated on ctx.needsEmpathy");
assert.ok(/\$\{hardshipRules\}/.test(draft), "the hardship block is interpolated into the instructions");
assert.ok(/needsEmpathy:\s*ctx\?\.needsEmpathy\s*\?\?\s*null/.test(orch), "orchestrator threads needsEmpathy into generateDraftWithLLM");

// ---- Source guard: BOTH index.ts ctx sites thread the affect parser's needsEmpathy in ----
const idx = fs.readFileSync("services/api/src/index.ts", "utf8");
assert.ok(
  /needsEmpathy:\s*acceptedAffect\?\.needsEmpathy\s*\?\?\s*null/.test(idx),
  "live (/webhooks/twilio) ctx threads acceptedAffect.needsEmpathy"
);
assert.ok(
  /needsEmpathy:\s*regenAcceptedAffect\?\.needsEmpathy\s*\?\?\s*null/.test(idx),
  "regenerate ctx threads regenAcceptedAffect.needsEmpathy"
);

// ---- Detection net (tone scorer) ----
const hardshipInbound =
  "Thank you Joe I am still very much interested and want to hold it, I've had a medical emergency since we've talked and I'm currently still in the hospital, is there a way I can send the money to hold it?";
assert.ok(customerDisclosedHardship(hardshipInbound), "scorer detects the medical-emergency disclosure");
assert.ok(
  !customerDisclosedHardship("That bike is sick! Killer deal too."),
  "scorer does NOT fire on slang ('sick' bike / 'killer' deal)"
);
assert.ok(outboundAcknowledgesHardship("I'm really sorry to hear that. We can hold it for you."), "ack recognized");
assert.ok(
  !outboundAcknowledgesHardship("Those limited runs move quick — I'll have Stone reach out."),
  "tone-deaf push is not an acknowledgment"
);

const failed = evaluateTurnToneQuality({
  inboundText: hardshipInbound,
  outboundText: "Love it — those limited runs move quick. I'll have Stone reach out to get one reserved for you."
});
assert.ok(
  failed.issues.some(i => i.code === "hardship_ack_missing"),
  "unacknowledged hardship reply is flagged hardship_ack_missing"
);

const acknowledged = evaluateTurnToneQuality({
  inboundText: hardshipInbound,
  outboundText:
    "I'm really sorry to hear that — take all the time you need. Yes, we can absolutely hold it; I'll get a hold of you tomorrow about a deposit."
});
assert.ok(
  !acknowledged.issues.some(i => i.code === "hardship_ack_missing"),
  "an acknowledged hardship reply does NOT flag hardship_ack_missing"
);

console.log("PASS hardship empathy ack eval");
