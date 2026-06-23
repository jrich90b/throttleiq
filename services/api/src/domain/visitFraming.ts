/**
 * Phantom-visit guard — the single biggest "answering out of context" cluster in production (a
 * full-store sweep found 19+ conversations / 25+ AI drafts asserting "thanks again for coming in /
 * for the test ride / coming to see us" on leads where NO physical visit happened). The framing was
 * hardcoded into four draft builders (buildDealerLeadAppPostRideReply ×2, buildDealerRideOutcomeCustomerDraft,
 * the post-sale cadence) regardless of whether the customer actually came in.
 *
 * KEY LESSON (Steven Knighton + 5 others): `sold` / credit-app / post-sale do NOT imply a physical
 * visit — HDFS online deals get "thanks for coming to see us" with no visit. So the confirmed-visit
 * signal must key on an ACTUAL visit: a SHOWED appointment/ride outcome, a walk-in, or the customer's
 * own words — never the sale flag.
 *
 * This module is the pure decision (visit confirmed?) + the dark flag. Fail-direction is safe: when
 * unsure it returns false (no visit), so a draft falls back to a visit-neutral intro rather than
 * fabricating a visit. Ships DARK behind PHANTOM_VISIT_GUARD (the live context-fidelity hold already
 * backstops these drafts; this fixes them at the source so the customer gets a correct initial touch).
 */

/** Customer's own words that confirm they physically came in / completed a ride. */
const CUSTOMER_CONFIRMED_VISIT =
  /\b(i (stopped|came) (in|by)|stopped in|came in (today|yesterday|earlier)|was (in|there) (today|yesterday)|test ?rode|test ?drove|rode it|came down|made it in)\b/i;

/**
 * Did the customer physically visit / complete a ride? Precise by design — a SHOWED appointment-or-ride
 * outcome (sold/hold imply showed), a walk-in, or the customer saying so. A merely-booked appointment,
 * a sale, a credit app, or a post-sale state are NOT visits (the Knighton class). Pure.
 */
export function customerVisitConfirmed(conv: any): boolean {
  const outcome = conv?.appointment?.staffNotify?.outcome ?? null;
  const primary = String(outcome?.primaryStatus ?? "").trim().toLowerCase();
  const status = String(outcome?.status ?? "").trim().toLowerCase();
  if (primary === "showed" || status === "showed" || status === "showed_up") return true;

  if (String(conv?.dialogState?.name ?? "") === "walk_in_active") return true;
  if (/walk[\s_-]*in|traffic log pro|dealership visit/i.test(String(conv?.lead?.source ?? ""))) return true;

  const msgs = Array.isArray(conv?.messages) ? conv.messages : [];
  if (msgs.some((m: any) => m?.direction === "in" && CUSTOMER_CONFIRMED_VISIT.test(String(m?.body ?? "")))) return true;

  return false;
}

/** A recorded dealer-ride / appointment OUTCOME implies the customer showed (you can only sell/hold/
 *  decline-finance after they came in for the ride). Used by the outcome-draft builder, which has the
 *  outcome in hand. `did_not_show` / `cancelled` are NOT a visit. */
export function rideOutcomeImpliesVisit(primaryStatus?: string | null, secondaryStatus?: string | null, legacy?: string | null): boolean {
  const p = String(primaryStatus ?? "").trim().toLowerCase();
  if (p === "showed" || p === "showed_up") return true;
  const s = String(secondaryStatus ?? "").trim().toLowerCase();
  const l = String(legacy ?? "").trim().toLowerCase();
  return ["sold", "hold", "finance_not_approved", "financing_declined"].some(k => s === k || l === k);
}

/** Reads PHANTOM_VISIT_GUARD. Default OFF (dark) — the live cutover is approve-first. When off, the
 *  builders keep their original (phantom) intro, identical to today. */
export function phantomVisitGuardEnabled(): boolean {
  const raw = String(process.env.PHANTOM_VISIT_GUARD ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}
