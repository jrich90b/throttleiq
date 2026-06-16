// The accepted-payment-methods answer for the payment_methods FAQ topic (Bobby Kindred,
// "Do I have to have cash or can I use debit"). Many dealers cap card payments on a vehicle
// (processing fees), so the credit-card clause is dealer-configurable via
// dealerProfile.payments.creditCardCapUsd — set it and the agent states the cap; leave it
// unset and it stays the generic "credit cards". Pure so it's unit-testable.
export function buildPaymentMethodsReply(opts: { creditCardCapUsd?: number | null } = {}): string {
  const cap = Number(opts.creditCardCapUsd);
  const cardClause =
    Number.isFinite(cap) && cap > 0
      ? `credit cards (up to $${cap.toLocaleString("en-US")})`
      : "credit cards";
  return `No cash required — debit works great. We also take ${cardClause}, a certified check, or we can set up financing. Whatever’s easiest for you!`;
}
