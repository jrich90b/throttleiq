/**
 * Disclaimed payment-estimate eval (2026-06-24).
 *
 * Joe's call: once a payment-focused lead gives a down payment, the agent may share a ROUGH monthly
 * RANGE for the recommended units (s R Gurajala). Refines payment-honesty: never a single fabricated
 * $/mo, but a DISCLAIMED RANGE is OK. Pins: deterministic amortization (a low–high range), the
 * mandatory disclaimer, estimate-on-(price−down) (real number lands at/above the range), null when not
 * estimable, and that the reply NEVER states a single non-ranged monthly number.
 *
 * Run: npx tsx scripts/payment_estimate_eval.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  estimateMonthlyPaymentRange,
  buildRecommendedUnitsPaymentEstimateReply,
  PAYMENT_ESTIMATE_DISCLAIMER
} from "../services/api/src/domain/paymentEstimate.ts";

// --- 1) Pure amortized range. ---
const r = estimateMonthlyPaymentRange({ price: 10299, downPayment: 500, termMonths: 72, aprLowPct: 9, aprHighPct: 16 })!;
assert.ok(r, "a priced unit with a down payment yields a range");
assert.ok(r.low > 0 && r.high >= r.low, "low–high ordered, positive");
assert.equal(r.low % 5, 0, "low rounds to $5");
assert.equal(r.high % 5, 0, "high rounds to $5");
assert.ok(r.low >= 150 && r.high <= 260, `Nightster $500-down 72mo range sane (~$175–215), got ${r.low}-${r.high}`);
// Higher APR => higher payment (monotonic): a wider band widens the range.
const wide = estimateMonthlyPaymentRange({ price: 10299, downPayment: 500, termMonths: 72, aprLowPct: 5, aprHighPct: 20 })!;
assert.ok(wide.high >= r.high && wide.low <= r.low, "wider APR band => wider range");
// 0% APR => simple division (financed / term), still a valid range.
const zero = estimateMonthlyPaymentRange({ price: 7295, downPayment: 0, termMonths: 60, aprLowPct: 0, aprHighPct: 0 })!;
assert.equal(zero.low, Math.floor(7295 / 60 / 5) * 5, "0% APR = financed/term");
// Not estimable: no price, or down >= price.
assert.equal(estimateMonthlyPaymentRange({ price: null, downPayment: 500 }), null, "no price => null");
assert.equal(estimateMonthlyPaymentRange({ price: 5000, downPayment: 5000 }), null, "down covers price => null");

// --- 2) Reply: ranges only, always disclaimed, null when nothing priced. ---
const reply = buildRecommendedUnitsPaymentEstimateReply({
  firstName: "s R",
  downPayment: 500,
  termMonths: 72,
  units: [
    { year: "2026", model: "Nightster", price: 10299 } as any,
    { year: "2022", model: "Forty-Eight", price: 8995 } as any,
    { year: "2013", model: "1200 Custom", price: null } as any // no price => skipped
  ]
})!;
assert.ok(reply, "a reply is built");
assert.ok(reply.includes(PAYMENT_ESTIMATE_DISCLAIMER), "the disclaimer is always present");
assert.match(reply, /\$500 down/, "states the down payment used");
assert.match(reply, /2026 Nightster: ~\$\d+–\d+\/mo/, "Nightster shown as a RANGE");
assert.match(reply, /2022 Forty-Eight: ~\$\d+–\d+\/mo/, "Forty-Eight shown as a range");
assert.ok(!reply.includes("1200 Custom"), "a unit with no price is skipped (no fabricated estimate)");
// Honesty guard: every monthly figure must be a RANGE (~$x–y/mo), never a lone $N/mo.
const loneMonthly = reply.match(/\$\d+\/mo/g) ?? [];
assert.equal(loneMonthly.length, 0, "no single non-ranged $/mo figure (only disclaimed ranges)");
// No priced units => null (caller falls back to the human-quote handoff).
assert.equal(
  buildRecommendedUnitsPaymentEstimateReply({ units: [{ model: "Nightster", price: null } as any], downPayment: 500 }),
  null,
  "no priced units => null"
);

// --- 3) Source guard: wired in both paths, gated on a down payment + priced recommended units. ---
const api = fs.readFileSync("services/api/src/index.ts", "utf8");
assert.match(api, /function resolveRecommendedUnitsPaymentEstimateReply/, "estimate resolver exists");
assert.match(api, /if \(downPayment == null\) return null;/, "only estimates once a down payment is given");
assert.match(api, /findRecentInboundPaymentBudgetContext\(conv\)/, "reuses the existing down-payment extractor (parser-first, not new regex)");
assert.match(api, /if \(conv\.paymentEstimateSentForDown === downPayment\) return null;/, "offer-once per down-payment value (no re-fire on later turns)");
assert.equal(
  (api.match(/resolveRecommendedUnitsPaymentEstimateReply\(conv, "(live|regen)"\)/g) ?? []).length,
  2,
  "wired in BOTH the live and regenerate paths"
);

console.log("PASS payment estimate eval (disclaimed ranges only + both-paths wiring)");
