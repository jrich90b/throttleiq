/**
 * Proactive visit invite (booking-steering: move the "never offered" funnel leak → offered).
 *
 * North star: answer questions → book appointments. The booking funnel showed ~42% of engaged
 * sales leads were never offered a visit. This appends a soft, on-brand test-ride invite AFTER a
 * sales-info answer (pricing / payments / availability) when we have not already offered — turning
 * an answered question into a gentle nudge toward a booking.
 *
 * CONSERVATIVE + purely additive (generation-only — no routing/state/side-effects):
 *  - only sales-INFO intents (PRICING / PAYMENTS / AVAILABILITY); never SCHEDULING/FINANCING/GENERAL,
 *  - never if the draft already contains an offer, or we offered earlier in the conversation
 *    (so it can NEVER nag — the invite copy itself matches the scheduling-offer detector, so once
 *    appended it registers as "offered" on the next turn),
 *  - never in a wrong context (manual handoff, holding inventory, already booked).
 * Deliberately NOT gated on the reactive `allowSchedulingOffer` flag — that's true only when the
 * customer ASKED to schedule; the whole point here is to offer when they did not. Pinned by
 * scripts/proactive_visit_invite_eval.ts.
 */

const SALES_INFO_INTENTS = new Set(["PRICING", "PAYMENTS", "AVAILABILITY"]);

/** The soft invite. MUST match bookingFunnel's SCHEDULING_OFFER_OUTBOUND ("grab a time") so that
 * once appended it counts as an offer next turn and the once-per-conversation guard holds. */
export const PROACTIVE_VISIT_INVITE =
  "Happy to line up a test ride whenever works for you — want me to grab a time?";

export function shouldAppendVisitInvite(args: {
  intent: string;
  shouldRespond: boolean;
  draft: string;
  draftAlreadyOffers: boolean; // the composed reply already contains a scheduling offer
  alreadyOfferedThisConversation: boolean; // we offered a time/visit on an earlier turn
  wrongContext: boolean; // manual handoff / holding inventory / already booked / not a moment to push
}): boolean {
  if (!args.shouldRespond) return false;
  if (!String(args.draft ?? "").trim()) return false;
  if (!SALES_INFO_INTENTS.has(args.intent)) return false;
  if (args.draftAlreadyOffers) return false;
  if (args.alreadyOfferedThisConversation) return false;
  if (args.wrongContext) return false;
  return true;
}

/** Append the invite to a composed reply (no-op-safe: returns the invite alone if draft empty). */
export function appendVisitInvite(draft: string): string {
  const base = String(draft ?? "").trimEnd();
  return base ? `${base} ${PROACTIVE_VISIT_INVITE}` : PROACTIVE_VISIT_INVITE;
}
