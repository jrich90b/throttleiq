/**
 * Committed-buyer availability re-pitch suppression — decision-table eval.
 *
 * `shouldSuppressCommittedBuyerAvailabilityRepitch` (services/api/src/domain/routeStateReducer.ts)
 * is the single source of truth for the precedence rule: a customer who has ALREADY committed to a
 * specific unit and is arranging paperwork/pickup/delivery (the conversation is in an active
 * purchase_delivery / sold / post-sale state) must NOT be routed into the availability re-pitch arm
 * ("Yes — we have one in stock right now … Want to come check it out? Here is photo.").
 *
 * Origin: Kody (+17163975098, 2026-07-16). After committing in person to the 2024 Low Rider S in
 * Red Rock, "And to hopefully pick it up tomorrow as well" fell through the purchase-delivery
 * logistics parser and hit the availability arm, which re-sold him the bike he'd already chosen and
 * ignored the paperwork/pickup/Friday ask. dialogState was purchase_delivery at the time.
 *
 * The guard is applied identically in the live (/webhooks/twilio) and regenerate paths; this eval
 * pins the precedence so the two never drift and the re-pitch cannot regress. Carve-out under test:
 * an explicit availability question this turn ("is it still there?") is still answered mid-deal.
 */
import assert from "node:assert/strict";
import { shouldSuppressCommittedBuyerAvailabilityRepitch } from "../services/api/src/domain/routeStateReducer.ts";

type Row = {
  id: string;
  input: Parameters<typeof shouldSuppressCommittedBuyerAvailabilityRepitch>[0];
  suppress: boolean;
};

const rows: Row[] = [
  // The Kody case: committed buyer, availability arm would fire, bare pickup (not a direct question).
  {
    id: "committed_buyer_bare_pickup_suppresses_repitch",
    input: { activePurchaseDeliveryState: true, availabilityArmWouldFire: true, directAvailabilityQuestionThisTurn: false },
    suppress: true
  },
  // Carve-out: an explicit "is it still available?" this turn is legitimate even mid-deal — answer it.
  {
    id: "committed_buyer_explicit_availability_question_not_suppressed",
    input: { activePurchaseDeliveryState: true, availabilityArmWouldFire: true, directAvailabilityQuestionThisTurn: true },
    suppress: false
  },
  // Normal shopper (not mid-deal): availability answering is preserved untouched.
  {
    id: "non_committed_availability_answer_preserved",
    input: { activePurchaseDeliveryState: false, availabilityArmWouldFire: true, directAvailabilityQuestionThisTurn: false },
    suppress: false
  },
  // Nothing to suppress: the availability arm was not going to fire anyway.
  {
    id: "no_availability_arm_nothing_to_suppress",
    input: { activePurchaseDeliveryState: true, availabilityArmWouldFire: false, directAvailabilityQuestionThisTurn: false },
    suppress: false
  },
  // Post-sale / sold conversations flow through the same active-state flag (set by the caller).
  {
    id: "post_sale_bare_logistics_suppresses_repitch",
    input: { activePurchaseDeliveryState: true, availabilityArmWouldFire: true, directAvailabilityQuestionThisTurn: false },
    suppress: true
  },
  // Belt-and-suspenders: not committed AND a direct question => normal answer (no suppression).
  {
    id: "non_committed_direct_question_answered",
    input: { activePurchaseDeliveryState: false, availabilityArmWouldFire: true, directAvailabilityQuestionThisTurn: true },
    suppress: false
  }
];

let passed = 0;
for (const row of rows) {
  const out = shouldSuppressCommittedBuyerAvailabilityRepitch(row.input);
  assert.equal(out, row.suppress, `${row.id}: expected suppress=${row.suppress}, got ${out}`);
  passed += 1;
}

console.log(`PASS committed-buyer availability suppression eval (${passed} rows)`);
