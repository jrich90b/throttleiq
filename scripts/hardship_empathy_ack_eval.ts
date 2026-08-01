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
  applyHardshipAckToHandoffTemplate,
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

// ---- Department/handoff templates opt IN (Wesley Buzzard +17162913658, 2026-07-30 21:10Z) ----
// Room58 Contact-Us ADF: "Can u please send me a 2xl shirt please for my mom's birthday this year.
// I just lost her feb 11. It was the worst thing in my life to deal with." — the apparel arm sent
// the bare template. These arms early-return before orchestrator finalize AND set manual_handoff,
// so the generic wrongContext veto would suppress the ack; they carry no empathy beat of their own.
const APPAREL_TEMPLATE = "Thanks — I’ve received your apparel request. I’ll have our apparel team reach out shortly.";
assert.equal(
  applyHardshipAckToHandoffTemplate({ draft: APPAREL_TEMPLATE, needsEmpathy: true }),
  `${HARDSHIP_EMPATHY_ACK} ${APPAREL_TEMPLATE}`,
  "apparel handoff template leads with the hardship ack (manual_handoff must NOT swallow it)"
);
assert.equal(
  applyHardshipAckToHandoffTemplate({ draft: APPAREL_TEMPLATE, needsEmpathy: false }),
  APPAREL_TEMPLATE,
  "no affect signal → the template is byte-identical (no copy drift)"
);
assert.equal(
  (applyHardshipAckToHandoffTemplate({ draft: APPAREL_TEMPLATE, needsEmpathy: true }).match(
    /really sorry to hear that/gi
  ) ?? []).length,
  1,
  "exactly one acknowledgment"
);
assert.equal(
  applyHardshipAckToHandoffTemplate({
    draft: `${HARDSHIP_EMPATHY_ACK} ${APPAREL_TEMPLATE}`,
    needsEmpathy: true
  }),
  `${HARDSHIP_EMPATHY_ACK} ${APPAREL_TEMPLATE}`,
  "already-acknowledged template is left alone (no double-ack)"
);
// INTRO ORDERING: applyInitialAdfPrefix runs BEFORE the publish funnel, so the ack must land after
// the agent introduction — never "I'm really sorry to hear that. Hey Wesley, it's Alexandra …".
for (const intro of [
  "Hey Wesley, it’s Alexandra over at American Harley-Davidson.",
  "Hi Wesley — This is Alexandra at American Harley-Davidson."
]) {
  assert.equal(
    applyHardshipAckToHandoffTemplate({ draft: `${intro} ${APPAREL_TEMPLATE}`, needsEmpathy: true }),
    `${intro} ${HARDSHIP_EMPATHY_ACK} ${APPAREL_TEMPLATE}`,
    `ack follows the agent intro: "${intro}"`
  );
}
assert.equal(
  applyHardshipAckToHandoffTemplate({ draft: "   ", needsEmpathy: true }),
  "   ",
  "blank draft is returned untouched"
);

// ---- Source guards: all THREE lanes wire the shared applier (parser-first in both paths) ----
const sendgrid = fs.readFileSync("services/api/src/routes/sendgridInbound.ts", "utf8");
assert.ok(
  /parseAffectWithLLM/.test(sendgrid),
  "the ADF/email lane runs the affect parser (it never did — +17162913658)"
);
assert.ok(
  /applyHardshipAckToHandoffTemplate/.test(sendgrid),
  "the ADF publish funnels apply the handoff hardship ack"
);
assert.ok(
  (idx.match(/withDepartmentHardshipAck/g) ?? []).length >= 2,
  "BOTH /webhooks/twilio and /conversations/:id/regenerate department arms apply it"
);
assert.ok(
  /hardshipWrongContext\s*=\s*String\(ctx\?\.followUp\?\.mode[\s\S]{0,40}===\s*"manual_handoff"/.test(orch),
  "the orchestrator's generic manual_handoff suppression is UNCHANGED (mention-handoff owns its own ack)"
);

// ---- Detection net (tone scorer) ----
const hardshipInbound =
  "Thank you Joe I am still very much interested and want to hold it, I've had a medical emergency since we've talked and I'm currently still in the hospital, is there a way I can send the money to hold it?";
assert.ok(customerDisclosedHardship(hardshipInbound), "scorer detects the medical-emergency disclosure");
assert.ok(
  !customerDisclosedHardship("That bike is sick! Killer deal too."),
  "scorer does NOT fire on slang ('sick' bike / 'killer' deal)"
);
// The gap that let Wesley's turn through the nightly: every bereavement pattern required the
// RELATION to be named ("lost my mother"), but once a customer has said who they mean, the next
// clause is a pronoun. His exact production text is the fixture.
const WESLEY_TURN =
  "Can u please send me a 2xl shirt please for my mom's birthday this year. " +
  "I just lost her feb 11. It was the worst thing in my life to deal with.";
assert.ok(
  customerDisclosedHardship(WESLEY_TURN),
  "scorer detects bereavement stated with a pronoun object (+17162913658, 2026-07-30)"
);
for (const positive of [
  "I just lost him last month, so I've been slow to get back to you.",
  "we recently lost her and I'm selling the bike",
  "lost him to cancer in the spring",
  "my late wife loved that bike",
  "my mom passed in february",
  "the celebration of life is Saturday so I can't make it in",
  "I lost my grandma last week",
  "lost my best friend in a crash"
]) {
  assert.ok(customerDisclosedHardship(positive), `scorer detects hardship: "${positive}"`);
}
// The ambiguity guard: "her" doubles as a possessive, and "lost them" is often objects. These
// must stay silent — a scorer that cries wolf on lost paperwork gets ignored on real grief.
for (const negative of [
  "I lost her number, can you resend it?",
  "I just lost her paperwork somewhere in the truck",
  "I lost my keys and had to get a new fob",
  "we lost them to another buyer last week",
  "I lost my title and need a duplicate",
  "That bike is sick! Killer deal too."
]) {
  assert.ok(!customerDisclosedHardship(negative), `scorer stays silent on: "${negative}"`);
}

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

// END-TO-END on the real miss: Wesley's turn + the bare apparel template is exactly what went
// out on 2026-07-30, and the nightly scored it CLEAN because the disclosure was invisible. This
// is the pin that proves the detection net would now catch a repeat — the runtime fix (PR #397)
// and this scorer are the two independent halves, and both were blind at the same time.
const wesleyScored = evaluateTurnToneQuality({
  inboundText: WESLEY_TURN,
  outboundText: "Thanks — I've received your apparel request. I'll have our apparel team reach out shortly."
});
assert.ok(
  wesleyScored.issues.some(i => i.code === "hardship_ack_missing"),
  "the apparel-handoff miss is now flagged hardship_ack_missing (it scored clean on 2026-07-30)"
);
const wesleyFixed = evaluateTurnToneQuality({
  inboundText: WESLEY_TURN,
  outboundText:
    "Hey Wesley, it's Alexandra over at American Harley-Davidson. I'm really sorry to hear that. Thanks — I've received your apparel request. I'll have our apparel team reach out shortly."
});
assert.ok(
  !wesleyFixed.issues.some(i => i.code === "hardship_ack_missing"),
  "the reply the deployed fix now produces scores clean"
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
