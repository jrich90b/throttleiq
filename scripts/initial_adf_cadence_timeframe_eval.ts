/**
 * Initial-ADF cadence-shape-by-purchase-timeframe eval.
 *
 * resolveInitialAdfCadenceKind (services/api/src/domain/conversationStore.ts) maps a lead's
 * STRUCTURED ADF purchase-timeframe field to the follow-up cadence kind applied at the Meta
 * promo initial-ADF cadence start (services/api/src/routes/sendgridInbound.ts): near-term and
 * unsure buyers keep the standard day-1 ramp; explicit "not interested at this time" and
 * far-out (7+ months / multi-year) horizons get the gentle long_term [30,90,180] nurture.
 * Rows cover every purchase-timeframe value seen in American Harley production traffic.
 */
import assert from "node:assert/strict";
import { resolveInitialAdfCadenceKind } from "../services/api/src/domain/conversationStore.ts";

type Row = { label: string; monthsStart?: number; kind: "standard" | "long_term" };

// monthsStart mirrors parseTimeframeMonths (sendgridInbound) output for month-range labels;
// year / unsure / free-text labels parse to no monthsStart.
const rows: Row[] = [
  // near-term / unsure / unparseable → standard (engage now)
  { label: "0-3 Months", monthsStart: 0, kind: "standard" },
  { label: "4-6 Months", monthsStart: 4, kind: "standard" },
  { label: "3-12 Months", monthsStart: 3, kind: "standard" },
  { label: "Unsure", kind: "standard" },
  { label: "Not sure", kind: "standard" },
  { label: "next week", kind: "standard" },
  { label: "summer", kind: "standard" },
  { label: "", kind: "standard" },
  // explicit cold / far-out → gentle long_term nurture
  { label: "I am not interested in purchasing at this time", kind: "long_term" },
  { label: "7-12 Months", monthsStart: 7, kind: "long_term" },
  { label: "1-3 Years", kind: "long_term" },
  { label: "Over 1 Year", kind: "long_term" },
  { label: "Over 4 Years", kind: "long_term" }
];

let passed = 0;
for (const r of rows) {
  const got = resolveInitialAdfCadenceKind({
    purchaseTimeframe: r.label,
    purchaseTimeframeMonthsStart: r.monthsStart
  });
  assert.equal(got, r.kind, `"${r.label}" expected ${r.kind}, got ${got}`);
  passed += 1;
}
console.log(`PASS initial-ADF cadence timeframe eval (${passed} rows)`);
