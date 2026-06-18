/**
 * Financial-empathy acknowledgment (Scott's car-intake rule, dealer-adapted).
 *
 * Rule: when a customer talks in MONTHLY payments, acknowledge that number FIRST, then let
 * the reply's existing price/payment ballpark serve as the out-the-door reference. Today the
 * payment-ballpark path (buildMonthlyPaymentLine in orchestrator.ts) states a monthly range
 * without acknowledging the target the customer just gave — which can read as ignoring them
 * (it may even quote a number above their target with no nod to it).
 *
 * This is a GENERATION-only helper — a warm prefix prepended to the ballpark line when a
 * monthly target is present. It does no routing/state/side-effects, and returns "" for a
 * missing/invalid target so the caller can prepend it unconditionally. Pinned by
 * scripts/financial_empathy_line_eval.ts.
 */

/** A short, on-brand acknowledgment of the customer's stated monthly target, or "" if none. */
export function buildMonthlyTargetAck(monthlyTarget: number | null | undefined): string {
  const value = Number(monthlyTarget);
  if (!Number.isFinite(value) || value <= 0) return "";
  return `Got it — aiming for around $${Math.round(value)}/mo. `;
}
