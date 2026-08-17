/**
 * Cadence-quality judge — the REALITY the judge grades a proactive touch against.
 *
 * The judge's `state_fit` axis asks "does this message match reality? Fails if it references
 * the wrong ... unit". The only unit fact it was ever handed was the LEAD's vehicle of
 * INTEREST (the ADF inquiry). On a post-sale thread that is the wrong bike surprisingly
 * often — a customer walks in about one unit and rides out on another — so a *correct*
 * message naming the bike they actually bought read as a mismatch and the touch was killed.
 *
 * LIVE CASE (+17168614216, judged 2026-08-01T14:30:38Z, suppress @0.90 confidence):
 * ADF interest "2024 Street Glide"; `sale.label` "2025 Harley-Davidson Breakout". The
 * post-sale check-in correctly said "...for your Breakout" — resolvePostSaleModelLabel
 * (postSaleCadence.ts) reads `sale.label` FIRST, exactly as intended — and the judge
 * suppressed it: "customer came for a 2024 Street Glide (not a Breakout)". The copy was
 * right; the grader was blind. A GRADER PHANTOM, not an agent defect.
 *
 * FAIL DIRECTION: a judge that cannot see the purchase fails toward SILENCE at the moment a
 * customer has just bought a motorcycle — the single worst moment to go quiet. Handing it the
 * purchase can only make `state_fit` MORE accurate in both directions: it also lets the judge
 * catch the inverse error (pitching a unit to someone who already bought one).
 *
 * This module is pure formatting + the shared placeholder screen. No comprehension lives here
 * (the judge itself is the typed LLM parser); that keeps it fully unit-testable, which is what
 * `cadence_quality_sold_unit:eval` pins.
 */
import { isPlaceholderModel } from "./modelDeflection.js";

export type CadenceQualityLeadFacts = {
  vehicle?: { model?: string | null; description?: string | null } | null;
  source?: string | null;
} | null;

export type CadenceQualitySaleFacts = {
  label?: string | null;
  year?: string | null;
  make?: string | null;
  model?: string | null;
  trim?: string | null;
  color?: string | null;
} | null;

/**
 * The unit the customer actually PURCHASED, or null when the sale record names none.
 *
 * Same candidate order and the same `isPlaceholderModel` screen `resolvePostSaleModelLabel`
 * uses, so the judge is told the identical unit the post-sale COPY is built from — if those
 * two ever disagreed, the judge would be grading a message against a different bike, which is
 * the very bug this module exists to close. Differs in one deliberate way: an unknown unit
 * returns null (omit the fact) rather than the copy's generic "bike" fallback — asserting
 * "the customer purchased a bike" to a grader is noise, not a fact.
 */
export function resolvePurchasedUnitLabel(sale?: CadenceQualitySaleFacts): string | null {
  const candidate =
    String(sale?.label ?? "").trim() ||
    [sale?.year, sale?.make, sale?.model, sale?.trim, sale?.color]
      .filter(Boolean)
      .join(" ")
      .trim();
  if (!candidate || isPlaceholderModel(candidate)) return null;
  return candidate;
}

/**
 * The unit-facts block handed to the cadence-quality judge. The inquiry vehicle keeps its
 * long-standing JSON shape (so the judge's existing calibration on that line is unchanged);
 * the purchase, when there is one, is added as an explicitly AUTHORITATIVE second line.
 */
export function formatCadenceQualityUnitFacts(input: {
  lead?: CadenceQualityLeadFacts;
  sale?: CadenceQualitySaleFacts;
  inventory?: CadenceQualityInventoryFacts | null;
}): string {
  const lead = input?.lead ?? {};
  const lines = [
    `Known lead (the vehicle they INQUIRED about): ${JSON.stringify({
      model: lead?.vehicle?.model ?? lead?.vehicle?.description ?? null,
      source: lead?.source ?? null
    })}`
  ];
  // `null` means NOBODY LOOKED (the lead names no stock#/VIN, so `resolveCadenceQualityInventoryFacts`
  // returned null so the caller could OMIT the block) — it is NOT the same as "we looked and missed",
  // which is `{ matched: false }`. The guard used to be `!== undefined`, and `null !== undefined` is
  // true, so the never-looked case fell into `formatCadenceQualityInventoryFacts`'s `!inv` branch and
  // the judge was handed a manufactured "NOT_MATCHED — you know NOTHING, any claim is unsupported"
  // on 99 of 109 live judge records (2026-08-17). It held a TRUE in-stock claim about a unit that is
  // in the feed at 0.9 (+17169013675, 2026 Low Rider S, stock S7-26). Omit the block instead: an
  // auditor told nothing grades on the rest of the evidence; an auditor told a fabricated fact
  // condemns the truth.
  if (input?.inventory != null) lines.push(formatCadenceQualityInventoryFacts(input.inventory));
  const purchased = resolvePurchasedUnitLabel(input?.sale);
  if (purchased) {
    lines.push(
      `Unit the customer ACTUALLY PURCHASED: ${purchased}. This is the authoritative unit for ` +
        `this thread. A message naming it is CORRECT even when it differs from the inquiry ` +
        `vehicle above — do not treat that difference as a state mismatch.`
    );
  }
  return lines.join("\n");
}

/**
 * Whole days since the customer last actually said something (an inbound message with a body).
 * Moved verbatim out of index.ts's runCadenceQualityJudgeShadow so the judge's whole input
 * assembly sits in one testable place — and so the source-size ratchet on index.ts ratchets
 * DOWN rather than up (the mechanism `source_size_ratchet:eval` asks for). `now` is injectable
 * for the eval; behavior is unchanged: floor to whole days, never negative, null when there is
 * no readable inbound timestamp.
 */
export function daysSinceLastCustomerReply(
  conv: { messages?: { direction?: string; body?: string; at?: string }[] } | null | undefined,
  now: number = Date.now()
): number | null {
  const lastInbound = [...(conv?.messages ?? [])].reverse().find(m => m?.direction === "in" && m?.body);
  const lastMs = lastInbound?.at ? Date.parse(String(lastInbound.at)) : NaN;
  if (!Number.isFinite(lastMs)) return null;
  return Math.max(0, Math.floor((now - lastMs) / 86_400_000));
}

// ---------------------------------------------------------------------------------------------
// INVENTORY GROUND TRUTH for the cadence-quality judge (Joe, 2026-08-06).
//
// WHY. The judge scored "Save $4,000 off list price" on a USED 2017 unit as good@0.9, and "I'm not
// seeing a Freewheeler available" as good@0.9 two turns after we said we were taking one in next
// week. That is not a reasoning failure — the judge was handed no inventory facts at all, so there
// was nothing to check the claims against. Asking it to audit a price claim without these is asking
// an auditor to verify an expense report with no bank statement.
//
// DELIBERATELY NOT INCLUDED: the internal target-price note. The judge needs to know whether a
// price EXISTS (so it can protect an honest deferral) — it does not need the number we are hoping
// to get. Passing an internal figure into a prompt whose output is graded against customer copy is
// a leak vector for no auditing benefit. See human-correction-steering-can-be-unsafe: a rep quoting
// $21,495 on an unpriced unit is the exact hazard, and the fix is to not put the figure in reach.
// ---------------------------------------------------------------------------------------------

import { findInventoryPrice } from "./inventoryFeed.js";
import { listInventoryHolds, normalizeInventoryHoldKey } from "./inventoryHolds.js";
import { listInventorySolds, normalizeInventorySoldKey } from "./inventorySolds.js";

export type CadenceQualityInventoryFacts = {
  /** Did we match the lead's unit in the feed at all? */
  matched: boolean;
  status: "available" | "on_hold" | "sold" | "unknown";
  /** Public list price from the feed. null when the unit is matched but carries no price. */
  listPrice: number | null;
};

/**
 * "Matched but unpriced" and "never matched" are DIFFERENT STATES and must never collapse into one
 * sentinel. Matched-with-no-price means deferring a quote is CORRECT and the judge must protect it;
 * never-matched means the judge knows nothing and must not read silence as evidence either way.
 * Collapsing them grades an unmatched unit as if we had confirmed it unpriced.
 */
export function formatCadenceQualityInventoryFacts(inv?: CadenceQualityInventoryFacts | null): string {
  if (!inv || !inv.matched) {
    return (
      "Inventory facts for the lead's unit: NOT_MATCHED — we could not find this unit in the feed. " +
      "You know NOTHING about its price or availability. Do NOT treat that as evidence in either " +
      "direction: a claim about it is unsupported, and so is a denial."
    );
  }
  const price =
    typeof inv.listPrice === "number" && inv.listPrice > 0
      ? `list price $${inv.listPrice.toLocaleString("en-US")}`
      : "UNPRICED_NO_SET_PRICE (no public price exists yet — DEFERRING a price question is the " +
        "CORRECT and safe reply here; do not fail a message for declining to quote)";
  return `Inventory facts for the lead's unit (treat as authoritative): status ${inv.status}, ${price}.`;
}

/**
 * Resolve the lead's unit against the live feed + hold/sold ledgers. Mirrors the lookup
 * `buildCadenceLeadUnitAvailabilityOverride` already does on this same cadence path, so the judge
 * grades against the same picture the sender uses.
 *
 * Returns null when the lead names no unit at all (no stock# and no VIN) — there is nothing to
 * resolve, and the caller omits the block rather than asserting a false NOT_MATCHED.
 *
 * FAIL DIRECTION: any lookup error resolves to `matched: false` (the "you know nothing" branch),
 * never to a confident availability or price. A feed hiccup must not become evidence.
 */
export async function resolveCadenceQualityInventoryFacts(
  lead: any
): Promise<CadenceQualityInventoryFacts | null> {
  const stockId =
    String(lead?.vehicle?.stockId ?? lead?.vehicle?.stock ?? lead?.stockId ?? "").trim() || null;
  const vin = String(lead?.vehicle?.vin ?? lead?.vin ?? "").trim() || null;
  if (!stockId && !vin) return null;
  try {
    const [hit, holds, solds] = await Promise.all([
      findInventoryPrice({ stockId, vin }),
      listInventoryHolds(),
      listInventorySolds()
    ]);
    const soldKey = normalizeInventorySoldKey(stockId, vin);
    const holdKey = normalizeInventoryHoldKey(stockId, vin);
    const sold = soldKey ? solds?.[soldKey] : null;
    const hold = holdKey ? holds?.[holdKey] : null;
    if (!hit?.item && !sold && !hold) return { matched: false, status: "unknown", listPrice: null };
    const price = typeof hit?.price === "number" && hit.price > 0 ? hit.price : null;
    const status = sold ? "sold" : hold ? "on_hold" : hit?.item ? "available" : "unknown";
    return { matched: true, status, listPrice: price };
  } catch {
    return { matched: false, status: "unknown", listPrice: null };
  }
}

/**
 * Assemble everything the cadence-quality judge is asked to grade against. Lives here so the
 * judge's whole input — unit facts, live inventory, thread, days-since-reply — sits in one testable
 * place rather than being hand-built at the call site (and so index.ts pays for its own growth
 * under source_size_ratchet:eval).
 *
 * The inventory lookup happens ONCE, here — not inside the consensus closure, which runs up to N
 * times per judgement and would otherwise multiply the feed reads by the sample count.
 */
export async function buildCadenceQualityJudgeArgs(input: {
  conv: any;
  message: string;
  channel: "sms" | "email";
  cadenceKind?: string | null;
  history?: { direction: "in" | "out"; body: string }[];
}): Promise<{
  message: string;
  channel: "sms" | "email";
  cadenceKind?: string | null;
  history?: { direction: "in" | "out"; body: string }[];
  lead: any;
  sale: any;
  daysSinceLastInbound: number | null;
  inventory: CadenceQualityInventoryFacts | null;
}> {
  const conv = input.conv;
  return {
    message: input.message,
    channel: input.channel,
    cadenceKind: input.cadenceKind ?? null,
    history: input.history,
    lead: conv?.lead,
    sale: conv?.sale,
    daysSinceLastInbound: daysSinceLastCustomerReply(conv),
    inventory: await resolveCadenceQualityInventoryFacts(conv?.lead)
  };
}
