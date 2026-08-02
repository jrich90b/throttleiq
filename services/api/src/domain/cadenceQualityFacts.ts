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
}): string {
  const lead = input?.lead ?? {};
  const lines = [
    `Known lead (the vehicle they INQUIRED about): ${JSON.stringify({
      model: lead?.vehicle?.model ?? lead?.vehicle?.description ?? null,
      source: lead?.source ?? null
    })}`
  ];
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
