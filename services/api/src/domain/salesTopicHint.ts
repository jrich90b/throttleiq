import { hasSmsOptOutLanguage } from "./conversationStore.js";
import { isManualOutboundQuoteDeliveredText } from "./manualCadenceContext.js";

/**
 * The task inbox's money badge (Pricing / Financing / Availability) normally reads the task's own
 * `reason`/`action`. When those carry no signal — a cadence "call" task on a lead the ADF parser
 * already classified as a quote request — the web falls back to this hint, the lead's PARSED
 * classification CTA (+17169306602, operator-reported "should be tagged pricing"; #257).
 *
 * THE BUG THIS FIXES: `classification.cta` is stamped once at intake and never changes, so the
 * fallback made a lead's ORIGIN badge every later task forever. Tony Mooradian (+17165236994) asked
 * "Asking $ for #U888-21" on 2026-05-28 and Scott quoted $20,995 three minutes later; the pricing
 * TODO closed correctly, but from #257 (2026-07-23) on, his *scheduling* task wore a Pricing chip.
 * Operator, 2026-07-25: "Pricing was answered but the pricing flag still shows in the inbox."
 *
 * So the CTA opens the topic; delivering a quote closes it. We do not re-guess whether a quote
 * landed — we reuse the same detector the manual-quote cadence restart already runs on outbound
 * text (`isManualOutboundQuoteDeliveredText`, manualCadenceContext.ts) plus the referee's own
 * verdict when `activateManualQuoteDeliveredFollowUp` has already flipped `followUp`.
 *
 * BUCKET: structured extraction over OUR OWN stored signals (the parsed CTA, the follow-up reason,
 * our own outbound text) feeding a DISPLAY-ONLY badge. It sends nothing, closes nothing, and
 * changes no reply.
 *
 * FAIL DIRECTION: the badge disappears, which is exactly the pre-#257 behavior — the task still
 * shows, just without the money accent. Nothing here can add a badge that was not there before, and
 * a wrong read never reaches a customer.
 */
export type SalesTopicHint = "pricing" | "availability";

/**
 * Has this thread already told the customer a price?
 *
 * Bulk sends are excluded: a promo blast carrying "$4,000 off" is not an answer to THIS lead's
 * quote question ([[promo-note-borrowed-from-another-unit]]). We detect them by the SMS opt-out
 * footer every broadcast carries. The very first customer-facing SMS also carries that footer, so a
 * price delivered in the opening message reads as "still open" — conservative in the right
 * direction (the badge stays).
 */
export function hasDeliveredQuote(conv: any): boolean {
  if (String(conv?.followUp?.reason ?? "").trim().toLowerCase() === "manual_quote_delivered") {
    return true;
  }
  const messages = Array.isArray(conv?.messages) ? conv.messages : [];
  for (const message of messages) {
    if (message?.direction !== "out") continue;
    // Recorded but never sent — the customer never heard this price.
    if (message?.delivered === false) continue;
    const body = String(message?.body ?? "");
    if (hasSmsOptOutLanguage(body)) continue;
    const hasMedia = Array.isArray(message?.mediaUrls) && message.mediaUrls.length > 0;
    if (isManualOutboundQuoteDeliveredText(body, { hasMedia })) return true;
  }
  return false;
}

export function resolveSalesTopicHint(conv: any): SalesTopicHint | null {
  const cta = String(conv?.classification?.cta ?? "").trim();
  if (cta === "request_a_quote") return hasDeliveredQuote(conv) ? null : "pricing";
  if (cta === "check_availability") return "availability";
  return null;
}
