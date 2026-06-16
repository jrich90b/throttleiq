/**
 * Initial-ADF cadence-plan-by-purchase-timeframe eval.
 *
 * resolveInitialAdfCadencePlan (services/api/src/domain/conversationStore.ts) maps a lead's
 * STRUCTURED ADF purchase-timeframe field to the follow-up plan applied at the Meta promo
 * initial-ADF cadence start (services/api/src/routes/sendgridInbound.ts):
 *   - "suppress"  — explicit "not interested at this time": opener only, no follow-ups
 *                   (the caller sets a deliberate paused_indefinite state).
 *   - "long_term" — 4+ months out / multi-year: gentle [30,90,180] nurture (soft-invite
 *                   opener, then long-term — never the aggressive day-1 ramp).
 *   - "standard"  — 0-3mo / unsure / unparseable: the standard day-1 ramp.
 * Rows cover every purchase-timeframe value seen in American Harley production traffic.
 */
import assert from "node:assert/strict";
import { resolveInitialAdfCadencePlan } from "../services/api/src/domain/conversationStore.ts";

type Row = {
  label: string;
  monthsStart?: number;
  plan: "standard" | "long_term" | "suppress";
};

// monthsStart mirrors parseTimeframeMonths (sendgridInbound) output for month-range labels;
// year / unsure / free-text labels parse to no monthsStart.
const rows: Row[] = [
  // near-term (0-3mo) / unsure / unparseable → standard (engage now)
  { label: "0-3 Months", monthsStart: 0, plan: "standard" },
  { label: "3-12 Months", monthsStart: 3, plan: "standard" }, // starts at month 3 (< 4) -> still standard
  { label: "Unsure", plan: "standard" },
  { label: "Not sure", plan: "standard" },
  { label: "next week", plan: "standard" },
  { label: "summer", plan: "standard" },
  { label: "", plan: "standard" },
  // 4+ months out → gentle long_term nurture (Joe, 2026-06-16: 4-6mo moved off the day-1 ramp)
  { label: "4-6 Months", monthsStart: 4, plan: "long_term" },
  { label: "7-12 Months", monthsStart: 7, plan: "long_term" },
  { label: "1-3 Years", plan: "long_term" },
  { label: "Over 1 Year", plan: "long_term" },
  { label: "Over 4 Years", plan: "long_term" },
  // explicit "not interested at this time" → opener only, no follow-ups
  { label: "I am not interested in purchasing at this time", plan: "suppress" }
];

let passed = 0;
for (const r of rows) {
  const got = resolveInitialAdfCadencePlan({
    purchaseTimeframe: r.label,
    purchaseTimeframeMonthsStart: r.monthsStart
  });
  assert.equal(got, r.plan, `"${r.label}" expected ${r.plan}, got ${got}`);
  passed += 1;
}
console.log(`PASS initial-ADF cadence timeframe eval (${passed} rows)`);
