/**
 * Finance/pricing-turn decision-table eval (routing de-tangle program).
 *
 * `decideFinancePricingTurn` (services/api/src/domain/routeStateReducer.ts) is the
 * single source of truth for the pricing-CONTINUATION precedence that lives as a
 * pair of inline `if` blocks in the /webhooks/twilio handler: a manual-quote-details
 * state update vs the finance follow-up continuation, both gated by the parser
 * pricing route (routeExecPricing) and a scheduling-suppression guard. This eval
 * pins that precedence + gate as a decision table so centralizing it stays
 * behavior-preserving and identical across the live and regenerate paths.
 *
 * Scope: the contiguous pricing-continuation pair only. The affordability /
 * lien-holder / payment-numbers arms are non-contiguous early-return guards
 * evaluated upstream and are intentionally NOT part of this decision (folding them
 * in would reorder them relative to interleaved non-finance routing).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  decideFinancePricingTurn,
  resolveFinanceFollowUpContinuation
} from "../services/api/src/domain/routeStateReducer.ts";

type Row = {
  id: string;
  input: Parameters<typeof decideFinancePricingTurn>[0];
  kind: string;
};

const base = {
  routeExecPricing: true,
  availabilitySignal: false,
  schedulingDayTime: false,
  schedulingDayOnlyRequest: false,
  schedulingDayOnlyAvailability: false,
  explicitScheduleSignal: false,
  manualQuoteDetailsReceived: false,
  financeFollowUpContinuation: false
};

const rows: Row[] = [
  // --- arms under the pricing route with no live scheduling signal ---
  { id: "manual_quote_details", input: { ...base, manualQuoteDetailsReceived: true }, kind: "manual_quote_details" },
  { id: "finance_followup", input: { ...base, financeFollowUpContinuation: true }, kind: "finance_followup_continuation" },

  // --- precedence: manual-quote-details outranks finance follow-up continuation ---
  { id: "manual_quote_beats_followup", input: { ...base, manualQuoteDetailsReceived: true, financeFollowUpContinuation: true }, kind: "manual_quote_details" },

  // --- gate: off the pricing route → no pricing-continuation arm fires ---
  { id: "no_pricing_route", input: { ...base, routeExecPricing: false, manualQuoteDetailsReceived: true, financeFollowUpContinuation: true }, kind: "none" },

  // --- scheduling-suppression: any live scheduling/availability signal defers ---
  { id: "defer_on_availability", input: { ...base, financeFollowUpContinuation: true, availabilitySignal: true }, kind: "none" },
  { id: "defer_on_day_time", input: { ...base, financeFollowUpContinuation: true, schedulingDayTime: true }, kind: "none" },
  { id: "defer_on_day_only_request", input: { ...base, manualQuoteDetailsReceived: true, schedulingDayOnlyRequest: true }, kind: "none" },
  { id: "defer_on_day_only_availability", input: { ...base, manualQuoteDetailsReceived: true, schedulingDayOnlyAvailability: true }, kind: "none" },
  { id: "defer_on_explicit_schedule", input: { ...base, financeFollowUpContinuation: true, explicitScheduleSignal: true }, kind: "none" },

  // --- no arm signal on the pricing route → none ---
  { id: "no_arm_signal", input: { ...base }, kind: "none" }
];

let passed = 0;
for (const row of rows) {
  const out = decideFinancePricingTurn(row.input);
  assert.equal(out.kind, row.kind, `${row.id}: expected kind ${row.kind}, got ${out.kind}`);
  passed += 1;
}

// --- resolveFinanceFollowUpContinuation: the SHARED parser-led continuation signal --------------
// Centralized so the live (/webhooks/twilio) and regenerate paths compute the financeFollowUpContinuation
// arm identically. This replaced the regen path's askedDownRecently regex (which read our own last
// outbound). Parser-led: a payments-specific intent OR payment-budget context + a pricing/payments route.
const ffuBase = {
  paymentsIntent: false,
  financeSignal: false,
  downProvided: false,
  monthlyProvided: false,
  termProvided: false
};
const ffuRows: Array<{ id: string; input: Parameters<typeof resolveFinanceFollowUpContinuation>[0]; want: boolean }> = [
  { id: "payments_intent_alone", input: { ...ffuBase, paymentsIntent: true }, want: true },
  { id: "down_plus_finance_signal", input: { ...ffuBase, downProvided: true, financeSignal: true }, want: true },
  { id: "monthly_plus_finance_signal", input: { ...ffuBase, monthlyProvided: true, financeSignal: true }, want: true },
  { id: "term_plus_finance_signal", input: { ...ffuBase, termProvided: true, financeSignal: true }, want: true },
  { id: "budget_without_finance_signal", input: { ...ffuBase, downProvided: true }, want: false },
  { id: "finance_signal_without_budget", input: { ...ffuBase, financeSignal: true }, want: false },
  { id: "all_false", input: { ...ffuBase }, want: false }
];
for (const row of ffuRows) {
  assert.equal(
    resolveFinanceFollowUpContinuation(row.input),
    row.want,
    `ffu ${row.id}: expected ${row.want}`
  );
  passed += 1;
}

// --- both-paths source guards -------------------------------------------------------------------
const indexSrc = fs.readFileSync(path.resolve("services/api/src/index.ts"), "utf8");
const ffuCalls = indexSrc.split("resolveFinanceFollowUpContinuation(").length - 1;
assert.ok(
  ffuCalls >= 2,
  `both the live and regenerate paths must call resolveFinanceFollowUpContinuation (found ${ffuCalls})`
);
assert.ok(
  !/regenDownProvided && askedDownRecently/.test(indexSrc),
  "regen path must NOT use the old regenDownProvided && askedDownRecently regex trigger"
);
assert.ok(
  // "about how much down" was unique to the removed askedDownRecently regex (a broader finance
  // detector at ~22886 shares other tokens, so key on this one).
  !/about how much down/.test(indexSrc),
  "the askedDownRecently down-payment regex must be removed from the regen path"
);

console.log(`PASS finance-pricing-turn decision eval (${passed} rows; incl. continuation signal + both-paths guards)`);
