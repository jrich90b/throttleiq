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
// Expanded trigger set (behind VISIT_INVITE_EXPANDED): also invite after a TRADE answer — a trade
// estimate is a sales-intent turn that should pivot to an in-person appraisal visit, and the booking
// funnel shows trade leads sitting un-offered (e.g. Laricuss Nelson). TEST_RIDE/SCHEDULING are
// intentionally NOT added — those already route through the reactive scheduling-offer path.
const VISIT_INVITE_INTENTS_EXPANDED = new Set([...SALES_INFO_INTENTS, "TRADE"]);

/**
 * VISIT_INVITE_EXPANDED — default OFF (behavior byte-identical to today). When ON:
 *  - the trigger broadens to VISIT_INVITE_INTENTS_EXPANDED (adds TRADE), and
 *  - a disengagement guard applies: NEVER append the invite when the customer has stepped back /
 *    is keeping their current bike / is selling on their own (parser-set disposition), so we can't
 *    nag a lead who just said "I'm all set" — the exact failure mode the cadence work fixed.
 * Measured/reversible: the booking funnel's offered-rate is the metric; unset to roll back.
 */
export function visitInviteExpandedEnabled(): boolean {
  const raw = String(process.env.VISIT_INVITE_EXPANDED ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

// Parser-set dispositions that mean the customer disengaged — never steer them to a visit.
const DISENGAGED_DISPOSITIONS = new Set([
  "customer_stepping_back",
  "customer_keep_current_bike",
  "customer_sell_on_own"
]);

/** Is this a disengaged disposition (from the disposition parser's dialogState)? */
export function isDisengagedDisposition(dispositionName?: string | null): boolean {
  return DISENGAGED_DISPOSITIONS.has(String(dispositionName ?? "").trim());
}

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
  expanded?: boolean; // VISIT_INVITE_EXPANDED: broaden the trigger + apply the disengagement guard
  customerDisengaged?: boolean; // parser-set disposition says the customer stepped back — never nag
}): boolean {
  if (!args.shouldRespond) return false;
  if (!String(args.draft ?? "").trim()) return false;
  const intents = args.expanded ? VISIT_INVITE_INTENTS_EXPANDED : SALES_INFO_INTENTS;
  if (!intents.has(args.intent)) return false;
  if (args.draftAlreadyOffers) return false;
  if (args.alreadyOfferedThisConversation) return false;
  if (args.wrongContext) return false;
  // Disengagement guard (expanded only): a lead who stepped back / is keeping their bike must never
  // be steered to a visit — fail-safe against re-nagging (the cadence lesson).
  if (args.expanded && args.customerDisengaged) return false;
  return true;
}

/** Append the invite to a composed reply (no-op-safe: returns the invite alone if draft empty). */
export function appendVisitInvite(draft: string): string {
  const base = String(draft ?? "").trimEnd();
  return base ? `${base} ${PROACTIVE_VISIT_INVITE}` : PROACTIVE_VISIT_INVITE;
}
