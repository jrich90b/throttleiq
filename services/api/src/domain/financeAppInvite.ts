/**
 * Finance-app + soft-visit offer (2026-06-24).
 *
 * A payment-focused lead (asked about monthly/down payment) should EVENTUALLY be moved toward getting
 * pre-approved — sent the dealer's credit-app link, with a low-pressure "or come in" (Joe, 2026-06-24:
 * s R Gurajala asked about ~$200/mo). We offer it once, AFTER the customer engages with numbers (the
 * manual-quote-details moment), so it's natural, not pushy.
 *
 * The link is assembled deterministically from dealerProfile.creditAppUrl / bookingUrl — a customer-
 * facing URL must be exact, never LLM-composed (AGENTS.md: structured output is deterministic). Returns
 * null when there is no real credit-app URL (we never fabricate a link; the caller just omits the offer).
 */
export function buildFinanceAppInviteLine(args: {
  creditAppUrl?: string | null;
  bookingUrl?: string | null;
}): string | null {
  const credit = String(args.creditAppUrl ?? "").trim();
  if (!/^https?:\/\//i.test(credit)) return null;
  const booking = String(args.bookingUrl ?? "").trim();
  const visit = /^https?:\/\//i.test(booking)
    ? ` Or swing by and we'll run it with you: ${booking}.`
    : " Or swing by and we'll run it with you.";
  return `Want to get pre-approved? Quick app here: ${credit}.${visit}`;
}
