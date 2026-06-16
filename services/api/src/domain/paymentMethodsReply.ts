// The accepted-payment-methods answer for the payment_methods FAQ topic (Bobby Kindred,
// "Do I have to have cash or can I use debit"). Many dealers cap CARD payments on a vehicle
// (processing fees) — and that limit applies to BOTH debit and credit cards. The cap is
// dealer-configurable via dealerProfile.payments.creditCardCapUsd: set it (>0) and the agent
// states "debit and credit cards up to $X"; leave it unset (or 0) and both card types read as
// unlimited. Pure so it's unit-testable.
export function buildPaymentMethodsReply(opts: { creditCardCapUsd?: number | null } = {}): string {
  const cap = Number(opts.creditCardCapUsd);
  const cardClause =
    Number.isFinite(cap) && cap > 0
      ? `we take debit and credit cards up to $${cap.toLocaleString("en-US")}, plus a certified check or financing`
      : "debit and credit cards both work, plus a certified check or financing";
  return `No cash required — ${cardClause}. Whatever’s easiest for you!`;
}

// Cheap pre-filter that decides whether a turn is worth spending the FAQ topic classifier on
// for a TENDER (accepted-payment-method) question — "do I have to have cash", "can I use debit",
// "do you take cards", "cash only?". This is NOT the comprehension decision: the LLM classifier
// (parseDealershipFaqTopicWithLLM) makes the actual payment_methods call. The hint only bounds
// the LLM round-trip so we don't classify every turn. Fail-direction is safe both ways: a missed
// hint falls back to the existing LLM draft, and an over-firing hint just spends one classifier
// call that returns a non-payment topic. Requires a tender INSTRUMENT (cash/debit/credit card/
// check/money order) so it does NOT fire on monthly-payment/financing turns ("what are my
// payments", "can I make payments") that carry no tender instrument.
export function hasPaymentMethodsTenderHint(text: string | null | undefined): boolean {
  const lower = String(text ?? "").toLowerCase();
  if (!lower.trim()) return false;
  // Explicit tender-meta phrasing ("what forms of payment do you accept", "ways to pay") carries
  // no specific instrument but is unambiguously a tender question.
  const tenderMetaPhrase =
    /\b(forms?\s+of\s+payment|methods?\s+of\s+payment|payment\s+(?:options?|types?|methods?)|ways?\s+to\s+pay|how\s+(?:do|can|should)\s+i\s+pay|accept(?:ed)?\s+payment)\b/i.test(
      lower
    );
  if (tenderMetaPhrase) return true;
  // Otherwise require a tender INSTRUMENT (cash/card/check/...) so the hint does NOT fire on
  // monthly-payment/financing turns ("what are my payments", "can I make payments") with no tender.
  const tenderInstrument =
    /\b(cash|debit(?:\s*cards?)?|credit\s*cards?|gift\s*cards?|cards?|certified\s*check|cashier'?s?\s*check|money\s*order|e[-\s]?check|venmo|zelle|cash\s*app|apple\s*pay|google\s*pay|paypal)\b/i.test(
      lower
    );
  if (!tenderInstrument) return false;
  const tenderFrame =
    /\b(do(?:es)?\s+(?:you|u)|take|takes|accept|accepts|can\s+i|could\s+i|able\s+to|have\s+to|need(?:\s+to)?|pay\s+(?:with|by|in)|paid\s+(?:with|by|in)|use|using|put\s+down|only)\b/i.test(
      lower
    );
  return tenderFrame;
}
