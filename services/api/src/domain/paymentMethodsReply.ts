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
