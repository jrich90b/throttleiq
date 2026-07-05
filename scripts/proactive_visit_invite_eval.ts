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
  shouldAppendVisitInvite,
  visitInviteExpandedEnabled,
  isDisengagedDisposition
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

// --- EXPANDED trigger (VISIT_INVITE_EXPANDED), default OFF ---
// Default (expanded falsy): behaves exactly as today — TRADE does NOT fire, disengagement not applied.
assert.equal(shouldAppendVisitInvite({ ...base, intent: "TRADE" }), false, "default: TRADE does not fire (byte-identical to today)");
assert.equal(
  shouldAppendVisitInvite({ ...base, intent: "PRICING", customerDisengaged: true }),
  true,
  "default: disengagement guard is NOT applied when expanded is off (preserves today's behavior)"
);
// Expanded ON: TRADE fires; sales-info still fires; disengagement suppresses across intents.
assert.equal(shouldAppendVisitInvite({ ...base, intent: "TRADE", expanded: true }), true, "expanded: TRADE fires (trade estimate → appraisal visit)");
assert.equal(shouldAppendVisitInvite({ ...base, intent: "PRICING", expanded: true }), true, "expanded: sales-info still fires");
assert.equal(
  shouldAppendVisitInvite({ ...base, intent: "PRICING", expanded: true, customerDisengaged: true }),
  false,
  "expanded: a disengaged customer is NEVER steered to a visit (no nag) — even on a sales-info answer"
);
assert.equal(
  shouldAppendVisitInvite({ ...base, intent: "TRADE", expanded: true, customerDisengaged: true }),
  false,
  "expanded: disengagement suppresses the TRADE invite too"
);
// Expanded does NOT open the door to off-target intents (GENERAL/SCHEDULING/FINANCING stay out).
for (const intent of ["GENERAL", "SCHEDULING", "FINANCING", "TEST_RIDE"]) {
  assert.equal(shouldAppendVisitInvite({ ...base, intent, expanded: true }), false, `expanded: ${intent} still must NOT fire`);
}

// isDisengagedDisposition: the three disposition-parser states, nothing else.
for (const d of ["customer_stepping_back", "customer_keep_current_bike", "customer_sell_on_own"]) {
  assert.equal(isDisengagedDisposition(d), true, `${d} is disengaged`);
}
for (const d of ["inventory_init", "schedule_request", "pricing_answered", "", null, undefined]) {
  assert.equal(isDisengagedDisposition(d), false, `${String(d)} is NOT disengaged`);
}

// Flag defaults OFF (opt-in, reversible).
const saved = process.env.VISIT_INVITE_EXPANDED;
delete process.env.VISIT_INVITE_EXPANDED;
assert.equal(visitInviteExpandedEnabled(), false, "VISIT_INVITE_EXPANDED defaults OFF");
process.env.VISIT_INVITE_EXPANDED = "1";
assert.equal(visitInviteExpandedEnabled(), true, "VISIT_INVITE_EXPANDED=1 enables the expansion");
if (saved === undefined) delete process.env.VISIT_INVITE_EXPANDED; else process.env.VISIT_INVITE_EXPANDED = saved;

// Source guard: the orchestrator finalize wires both helpers + the flag + the disengagement signal.
const orch = fs.readFileSync("services/api/src/domain/orchestrator.ts", "utf8");
assert.ok(
  /shouldAppendVisitInvite\(/.test(orch) && /appendVisitInvite\(/.test(orch),
  "orchestrator finalize must use the invite helpers"
);
assert.ok(
  /expanded: visitInviteExpandedEnabled\(\)/.test(orch) && /customerDisengaged: isDisengagedDisposition\(ctx\?\.disposition\)/.test(orch),
  "finalize must pass the flag + the parser-set disengagement signal"
);
// Both-paths parity: live (twilio_inbound) AND regen pass conv.dialogState.name as the disposition.
const idx = fs.readFileSync("services/api/src/index.ts", "utf8");
assert.equal(
  (idx.match(/disposition: conv\.dialogState\?\.name \?\? null/g) ?? []).length >= 2,
  true,
  "both /webhooks/twilio and /conversations/:id/regenerate must plumb the disposition"
);

console.log("PASS proactive visit invite eval (base + expanded TRADE + disengagement guard + flag default + both-path wiring)");
