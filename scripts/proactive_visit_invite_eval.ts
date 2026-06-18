/**
 * Proactive visit-invite eval (deterministic — no LLM).
 *
 * Pins the booking-steering invite: after a sales-info answer (pricing/payments/availability)
 * with no offer yet, append a soft test-ride invite — conservative, generation-only, and
 * once-per-conversation. Origin: the booking funnel showed ~42% of engaged sales leads were
 * never offered a visit. Pins the gate truth table, that the invite registers as an offer (so it
 * can never re-nag), and that the orchestrator finalize wires it.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  appendVisitInvite,
  PROACTIVE_VISIT_INVITE,
  shouldAppendVisitInvite
} from "../services/api/src/domain/proactiveVisitInvite.ts";
import { textContainsSchedulingOffer } from "../services/api/src/domain/bookingFunnel.ts";

const base = {
  shouldRespond: true,
  draft: "The 2026 Road Glide is $28,999.",
  draftAlreadyOffers: false,
  alreadyOfferedThisConversation: false,
  wrongContext: false
};

// Fires on sales-info intents with no offer yet.
for (const intent of ["PRICING", "PAYMENTS", "AVAILABILITY"]) {
  assert.equal(shouldAppendVisitInvite({ ...base, intent }), true, `${intent}: should append the invite`);
}
// Never on non-sales-info intents (scheduling already offers; finance/general are off-target).
for (const intent of ["SCHEDULING", "FINANCING", "GENERAL", "TRADE_IN", ""]) {
  assert.equal(shouldAppendVisitInvite({ ...base, intent }), false, `${intent}: must NOT append`);
}
// Each suppressor independently blocks.
assert.equal(shouldAppendVisitInvite({ ...base, intent: "PRICING", draftAlreadyOffers: true }), false, "draft already offers → no double-offer");
assert.equal(shouldAppendVisitInvite({ ...base, intent: "PRICING", alreadyOfferedThisConversation: true }), false, "offered earlier → never nag");
assert.equal(shouldAppendVisitInvite({ ...base, intent: "PRICING", wrongContext: true }), false, "wrong context (handoff/booked) → no");
assert.equal(shouldAppendVisitInvite({ ...base, intent: "PRICING", shouldRespond: false }), false, "no response → no");
assert.equal(shouldAppendVisitInvite({ ...base, intent: "PRICING", draft: "   " }), false, "empty draft → no");

// appendVisitInvite preserves the answer + appends the invite.
const appended = appendVisitInvite("The 2026 Road Glide is $28,999.");
assert.ok(appended.startsWith("The 2026 Road Glide is $28,999."), "original answer preserved");
assert.ok(appended.includes(PROACTIVE_VISIT_INVITE), "invite is appended");

// THE once-per-conversation guarantee: the invite itself must register as a scheduling offer, so
// agentOfferedATime sees it next turn and we never re-nag.
assert.ok(textContainsSchedulingOffer(PROACTIVE_VISIT_INVITE), "invite registers as a scheduling offer (never re-nags)");

// Source guard: the orchestrator finalize wires both helpers.
const orch = fs.readFileSync("services/api/src/domain/orchestrator.ts", "utf8");
assert.ok(
  /shouldAppendVisitInvite\(/.test(orch) && /appendVisitInvite\(/.test(orch),
  "orchestrator finalize must use the invite helpers"
);

console.log("PASS proactive visit invite eval");
