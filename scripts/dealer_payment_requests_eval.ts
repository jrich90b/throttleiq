import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "dealer-payments-eval-"));
const storePath = path.join(tempDir, "dealer_payment_requests.json");
process.env.DEALER_PAYMENT_REQUESTS_PATH = storePath;
process.env.PUBLIC_BASE_URL = "https://api.americanharley.leadrider.ai";

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
          stripeCheckoutSessionId: "cs_eval_1".padEnd(150, "x"),
          stripeCheckoutUrl: `https://checkout.stripe.com/c/pay/${"cs_eval_1".padEnd(950, "x")}#fidkdWxOYHwnPyd1blpxYHZxWjA0`,
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
assert.match(suggested, /https:\/\/api\.americanharley\.leadrider\.ai\/public\/pay\/req_eval_1/);
assert.doesNotMatch(
  suggested,
  /https:\/\/checkout\.stripe\.com/,
  "Customer-facing SMS drafts must use a short LeadRider payment link, not the raw long Stripe Checkout URL."
);

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
  /card_payments:\s*\{\s*requested:\s*true\s*\}/,
  "Dealer Stripe Connect setup must request the card_payments capability."
);
assert.match(
  domainSource,
  /transfers:\s*\{\s*requested:\s*true\s*\}/,
  "Dealer Stripe Connect setup must request the transfers capability."
);
assert.match(
  domainSource,
  /card_payments capability active/,
  "Dealer payment readiness must require active card_payments capability."
);
assert.match(
  domainSource,
  /dealerPaymentRequestId/,
  "Checkout and webhook metadata must include the dealer payment request id."
);
assert.match(
  domainSource,
  /dealerPaymentPublicUrl/,
  "Payment messages must use a short public redirect URL so phones linkify the full payment link."
);
assert.match(
  domainSource,
  /syncDealerPaymentRequestsWithStripe/,
  "Open dealer payment requests must sync paid Checkout status from Stripe as a webhook fallback."
);

const apiSource = await fs.readFile(path.resolve("services/api/src/index.ts"), "utf8");
assert.match(apiSource, /app\.get\("\/public\/pay\/:id"/);
assert.match(apiSource, /checkout\.stripe\.com/);
assert.match(
  apiSource,
  /notifyDealerPaymentIfPaid/,
  "Paid dealer payment requests must create a dealer-visible notification."
);
assert.match(
  apiSource,
  /Payment received:/,
  "Dealer payment notifications must be labeled clearly in the conversation timeline."
);
assert.match(
  apiSource,
  /provider:\s*"payment_event"/,
  "Paid dealer payment requests must write a payment event into the conversation timeline."
);
assert.match(
  apiSource,
  /message => message\.provider === "payment_event" && message\.providerMessageId === providerMessageId/,
  "Dealer payment timeline events must be deduped by Stripe/request id."
);
assert.doesNotMatch(
  apiSource,
  /addTodo\([\s\S]{0,500}Payment received:/,
  "Paid dealer payment receipts must not create generic task inbox todos."
);
assert.doesNotMatch(
  apiSource,
  /Verify the deal\/account balance/,
  "Paid dealer payment receipts must not create outcome-style task copy."
);
assert.match(
  apiSource,
  /for \(const request of synced\.requests\)/,
  "Dealer payment request listing must notify paid requests even if they were synced earlier."
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

const ensureComposeFn = pageSource.match(/async function ensureComposeConversation\(\)[\s\S]*?\n  \}/)?.[0] ?? "";
assert.ok(ensureComposeFn, "Compose SMS payment requests must prepare or reuse a conversation.");
assert.match(ensureComposeFn, /composeConversation\?\.id/);
assert.match(ensureComposeFn, /\/api\/conversations\/compose/);

const createComposePaymentFn = pageSource.match(/async function createComposePaymentRequest\(\)[\s\S]*?\n  \}/)?.[0] ?? "";
assert.ok(createComposePaymentFn, "Compose SMS must expose payment request creation.");
assert.match(createComposePaymentFn, /const conv = await ensureComposeConversation\(\)/);
assert.match(createComposePaymentFn, /\/api\/dealer-payments\/requests/);
assert.match(createComposePaymentFn, /setComposeBody\(json\.suggestedMessage\)/);
assert.doesNotMatch(
  createComposePaymentFn,
  /\/send|sendCompose\(|doSend\(/,
  "Compose payment requests must draft the link only, not send the SMS."
);

const sendComposeFn = pageSource.match(/async function sendCompose\(\)[\s\S]*?\n  \}/)?.[0] ?? "";
assert.ok(sendComposeFn, "sendCompose must exist.");
assert.match(sendComposeFn, /const conv = await ensureComposeConversation\(\)/);

console.log("dealer_payment_requests_eval passed");
