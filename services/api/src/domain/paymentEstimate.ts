/**
 * Disclaimed monthly-payment estimate (2026-06-24).
 *
 * Joe's call: once a payment-focused lead gives a down payment, the agent may share a ROUGH monthly
 * RANGE for the recommended units (s R Gurajala: Joe hand-computed "$500 down → ~$190–220/mo" twice).
 * This refines the payment-honesty rule: never a single fabricated $/mo, but a DISCLAIMED RANGE is OK
 * when we have price + down + a standard term. Pure deterministic amortization (allowed) — every reply
 * carries the "rough, before tax/fees, APR-dependent — not a quote" disclaimer, and we estimate on
 * (price − down) only (so the real, tax/fee-inclusive number lands at or above the range — honest).
 */
import type { InventoryFeedItem } from "./inventoryFeed.js";
import { buildVehicleRecommendationReply, type RecommendedUnit } from "./inventoryRecommender.js";

const DEFAULT_TERM_MONTHS = Number(process.env.PAYMENT_ESTIMATE_TERM_MONTHS ?? 72);
const DEFAULT_APR_LOW = Number(process.env.PAYMENT_ESTIMATE_APR_LOW_PCT ?? 9);
const DEFAULT_APR_HIGH = Number(process.env.PAYMENT_ESTIMATE_APR_HIGH_PCT ?? 16);
export const PAYMENT_ESTIMATE_DISCLAIMER = "rough, before tax/fees, APR-dependent — not a quote";

function amortizedMonthly(financed: number, aprPct: number, termMonths: number): number {
  if (!(financed > 0) || !(termMonths > 0)) return 0;
  const r = aprPct / 100 / 12;
  if (r <= 0) return financed / termMonths;
  return (financed * r) / (1 - Math.pow(1 + r, -termMonths));
}

/**
 * Monthly payment RANGE for one unit. Estimates on (price − down); returns null when we can't (no
 * price, or the down covers the price). Rounds the low DOWN and the high UP to the nearest $5.
 */
export function estimateMonthlyPaymentRange(args: {
  price?: number | null;
  downPayment?: number | null;
  termMonths?: number;
  aprLowPct?: number;
  aprHighPct?: number;
}): { low: number; high: number } | null {
  const price = Number(args.price);
  if (!Number.isFinite(price) || price <= 0) return null;
  const down = Math.max(0, Number(args.downPayment) || 0);
  const financed = price - down;
  if (financed <= 0) return null;
  const term = args.termMonths && args.termMonths > 0 ? args.termMonths : DEFAULT_TERM_MONTHS;
  const aprLow = args.aprLowPct ?? DEFAULT_APR_LOW;
  const aprHigh = args.aprHighPct ?? DEFAULT_APR_HIGH;
  const low = Math.floor(amortizedMonthly(financed, aprLow, term) / 5) * 5;
  const high = Math.ceil(amortizedMonthly(financed, aprHigh, term) / 5) * 5;
  if (!(low > 0) || !(high >= low)) return null;
  return { low, high };
}

function unitName(u: RecommendedUnit): string {
  return [String(u.year ?? "").trim(), String(u.model ?? "").trim()].filter(Boolean).join(" ").trim() || "that one";
}

/**
 * Reply with disclaimed monthly ranges for the recommended units that have a price. Returns null when
 * no unit can be estimated (caller falls back to the existing "I'll have someone run exact numbers").
 */
export function buildRecommendedUnitsPaymentEstimateReply(args: {
  firstName?: string | null;
  units: RecommendedUnit[];
  downPayment?: number | null;
  termMonths?: number;
  // Omit the leading "Sure thing, {name}." opener — used when appending this estimate to a reply that
  // already greeted (recommend-and-quote in one turn), so we don't double the opener.
  omitOpener?: boolean;
}): string | null {
  const term = args.termMonths && args.termMonths > 0 ? args.termMonths : DEFAULT_TERM_MONTHS;
  const lines: string[] = [];
  for (const u of args.units ?? []) {
    const range = estimateMonthlyPaymentRange({ price: u.price, downPayment: args.downPayment, termMonths: term });
    if (!range) continue;
    lines.push(`• ${unitName(u)}: ~$${range.low}–${range.high}/mo`);
    if (lines.length >= 3) break;
  }
  if (!lines.length) return null;
  const name = String(args.firstName ?? "").trim();
  const down = Math.max(0, Number(args.downPayment) || 0);
  const head = down > 0 ? `With $${down.toLocaleString("en-US")} down (~${term} mo)` : `Rough monthly (~${term} mo)`;
  const body = `${head} — ${PAYMENT_ESTIMATE_DISCLAIMER}:\n${lines.join("\n")}\nWant me to lock in exact numbers on one?`;
  if (args.omitOpener) return body;
  const opener = name ? `Sure thing, ${name}.` : "Sure thing.";
  return `${opener} ${body}`;
}

/**
 * Recommend AND quote in ONE reply. When a customer hands over a full budget profile (style + a down
 * payment) the agent should suggest matching in-stock units AND show the disclaimed monthly range for
 * them right away — not list bikes and make the customer ask "what's the payment?" a turn later
 * (Tyrone Woods, 6/26: gave used-cruiser + $1.8–2k down + $450–550/mo and got another clarifying
 * question instead of options + numbers). Pure composition of the two existing builders:
 *   - no down payment given  => just the recommendation list (with its own "run numbers?" CTA).
 *   - down payment + priced units => recommendation list (CTA suppressed) + the disclaimed estimate.
 * `quoted` tells the caller whether the estimate was included (so it can mark paymentEstimateSentForDown
 * and not double-fire the standalone estimate path).
 */
export function buildRecommendationWithEstimateReply(args: {
  firstName?: string | null;
  matches: InventoryFeedItem[];
  recommendedUnits: RecommendedUnit[];
  monthlyBudget?: number | null;
  downPayment?: number | null;
  termMonths?: number;
}): { reply: string; quoted: boolean } {
  const priced = (args.recommendedUnits ?? []).filter(
    u => Number.isFinite(Number(u?.price)) && Number(u?.price) > 0
  );
  const estimate =
    args.downPayment != null && priced.length
      ? buildRecommendedUnitsPaymentEstimateReply({
          units: priced,
          downPayment: args.downPayment,
          termMonths: args.termMonths,
          omitOpener: true
        })
      : null;
  const recommendation = buildVehicleRecommendationReply({
    firstName: args.firstName,
    matches: args.matches,
    monthlyBudget: args.monthlyBudget,
    omitNumbersCta: !!estimate
  });
  if (!estimate) return { reply: recommendation, quoted: false };
  return { reply: `${recommendation}\n\n${estimate}`, quoted: true };
}
