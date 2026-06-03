import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "dealer-payments-eval-"));
const storePath = path.join(tempDir, "dealer_payment_requests.json");
process.env.DEALER_PAYMENT_REQUESTS_PATH = storePath;

const {
  buildDealerPaymentSuggestedMessage,
  handleDealerPaymentStripeEvent,
  parseDealerPaymentAmountCents
} = await import("../services/api/src/domain/dealerPayments.ts");

assert.equal(parseDealerPaymentAmountCents("$250.75"), 25075);
assert.equal(parseDealerPaymentAmountCents("0"), 0);

await fs.writeFile(
  storePath,
  JSON.stringify(
    {
      requests: [
        {
          id: "req_eval_1",
          conversationId: "+17160000000",
          amountCents: 25000,
          currency: "usd",
          description: "Deposit for 2021 Street Glide",
          channel: "sms",
          status: "open",
          stripeAccountId: "acct_eval",
          stripeMode: "test",
          stripeCheckoutSessionId: "cs_eval_1",
          stripeCheckoutUrl: "https://checkout.stripe.com/c/pay/cs_eval_1",
          createdAt: "2026-06-03T12:00:00.000Z",
          updatedAt: "2026-06-03T12:00:00.000Z"
        }
      ]
    },
    null,
    2
  ),
  "utf8"
);

const eventResult = await handleDealerPaymentStripeEvent({
  id: "evt_eval_1",
  type: "checkout.session.completed",
  data: {
    object: {
      id: "cs_eval_1",
      status: "complete",
      payment_status: "paid",
      payment_intent: "pi_eval_1",
      metadata: { dealerPaymentRequestId: "req_eval_1" }
    }
  }
} as any);

assert.equal(eventResult?.dealerPaymentRequestId, "req_eval_1");
const updatedStore = JSON.parse(await fs.readFile(storePath, "utf8"));
assert.equal(updatedStore.requests[0].status, "paid");
assert.equal(updatedStore.requests[0].stripePaymentIntentId, "pi_eval_1");
assert.ok(updatedStore.requests[0].paidAt);

const suggested = buildDealerPaymentSuggestedMessage(updatedStore.requests[0]);
assert.match(suggested, /secure payment link/i);
assert.match(suggested, /Deposit for 2021 Street Glide/);
assert.match(suggested, /https:\/\/checkout\.stripe\.com/);

const domainSource = await fs.readFile(
  path.resolve("services/api/src/domain/dealerPayments.ts"),
  "utf8"
);
assert.match(
  domainSource,
  /stripeAccount:\s*status\.connectedAccountId/,
  "Checkout sessions must be created on the dealer connected Stripe account."
);
assert.match(
  domainSource,
  /dealerPaymentRequestId/,
  "Checkout and webhook metadata must include the dealer payment request id."
);

const pageSource = await fs.readFile(path.resolve("apps/web/src/app/page.tsx"), "utf8");
const createPaymentFn = pageSource.match(/async function createConversationPaymentRequest\(\)[\s\S]*?\n  \}/)?.[0] ?? "";
assert.ok(createPaymentFn, "createConversationPaymentRequest must exist in the UI.");
assert.match(createPaymentFn, /setSendBody\(json\.suggestedMessage\)/);
assert.doesNotMatch(
  createPaymentFn,
  /\/api\/conversations\/|doSend\(|send\(/,
  "Creating a payment request must draft the link only, not send it."
);

console.log("dealer_payment_requests_eval passed");
