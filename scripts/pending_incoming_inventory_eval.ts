import assert from "node:assert/strict";
import {
  buildPendingIncomingInventoryCustomerAck,
  buildPendingIncomingInventoryFromConversation,
  buildPendingIncomingInventoryInitialAdfReply,
  buildPendingIncomingInventoryTaskSummary,
  hasPendingIncomingInventoryContext,
  hasPendingIncomingInventorySignal,
  isPendingIncomingInventoryAcknowledgementText,
  isPendingIncomingInventoryNotifyTodoSummary,
  shouldHandlePendingIncomingInventoryTurn
} from "../services/api/src/domain/pendingIncomingInventory.ts";
import type { Conversation } from "../services/api/src/domain/conversationStore.ts";

const now = "2026-06-06T17:23:12.000Z";

const conv = {
  id: "test",
  leadKey: "+17166819667",
  mode: "human",
  status: "open",
  createdAt: now,
  updatedAt: now,
  messages: [
    {
      id: "m1",
      direction: "out",
      provider: "twilio",
      from: "+17166927200",
      to: "+17166819667",
      body: "Here are pictures of the 2016 Freewheeler we are taking in on trade.",
      at: now
    }
  ],
  lead: {
    name: "Don Pagels",
    vehicle: {
      year: "2016",
      make: "Harley-Davidson",
      model: "Trike Freewheeler",
      condition: "used"
    }
  }
} as Conversation;

assert.equal(hasPendingIncomingInventorySignal("Interested in 2016 Freewheeler we are taking in on trade."), true);
assert.equal(hasPendingIncomingInventorySignal("I'm not seeing an Iron 883 in stock right now."), false);
assert.equal(isPendingIncomingInventoryAcknowledgementText("Yes, let me know when it's available. Thank you"), true);
assert.equal(isPendingIncomingInventoryAcknowledgementText("Stop"), false);

const pending = buildPendingIncomingInventoryFromConversation({
  conv,
  sourceText: "Interested in 2016 Freewheeler we are taking in on trade.",
  source: "adf",
  nowIso: now
});

assert.ok(pending);
assert.equal(pending?.model, "Freewheeler");
assert.equal(pending?.year, 2016);
assert.equal(pending?.status, "pending");

const pendingConv = { ...conv, pendingIncomingInventory: pending } as Conversation;
assert.equal(hasPendingIncomingInventoryContext(pendingConv), true);
assert.equal(
  shouldHandlePendingIncomingInventoryTurn({
    conv: pendingConv,
    inboundText: "Yes, let me know when it's available. Thank you",
    lastOutboundText: conv.messages[0]?.body
  }),
  true
);

const ack = buildPendingIncomingInventoryCustomerAck(pending);
assert.match(ack, /2016 Freewheeler/);
assert.doesNotMatch(ack, /not seeing|in stock right now|similar options/i);

const initialAdfReply = buildPendingIncomingInventoryInitialAdfReply(pending);
assert.match(initialAdfReply, /2016 Freewheeler/);
// No COMPREHENDED purpose on the record => the neutral "coming in" copy. We no longer guess "trade"
// from `used` alone (Joe 2026-07-16, Bill Indelicato +17163591526: a bike the dealer was SOURCING for
// the buyer was called "the 2015 Road King trade"). "coming in" is true either way.
assert.match(initialAdfReply, /coming in/i);
assert.doesNotMatch(initialAdfReply, /\btrade\b/i, "an un-comprehended incoming unit must never be called a trade");
assert.doesNotMatch(initialAdfReply, /not seeing|in stock right now|similar options|browse/i);

const task = buildPendingIncomingInventoryTaskSummary({
  pending,
  customerName: "Don Pagels"
});
assert.equal(task, "Notify Don Pagels when the 2016 Freewheeler arrives or is ready to show.");
assert.doesNotMatch(task, /\btrade\b/i);

// --- Purpose-aware copy (parseIncomingInventoryPurposeWithLLM -> decideIncomingInventoryPurpose). ---
// trade_in: the customer's OWN bike => the trade framing is correct and stays.
const tradeInPending = { ...(pending as any), purpose: "trade_in" };
const tradeInAck = buildPendingIncomingInventoryCustomerAck(tradeInPending);
assert.match(tradeInAck, /2016 Freewheeler trade/i, "a comprehended trade_in keeps the trade framing");
const tradeInInitial = buildPendingIncomingInventoryInitialAdfReply(tradeInPending);
assert.match(tradeInInitial, /taking in on trade/i);
const tradeInTask = buildPendingIncomingInventoryTaskSummary({ pending: tradeInPending, customerName: "Don Pagels" });
assert.equal(tradeInTask, "Notify Don Pagels when the 2016 Freewheeler trade arrives or is ready to show.");
assert.equal(isPendingIncomingInventoryNotifyTodoSummary(tradeInTask), true, "trade task still recognized by the dedup matcher");

// sourced_for_purchase: the BILL INDELICATO case — a used bike the dealer is bringing in for the
// customer to BUY must NEVER be called their trade.
const buyerPending = { ...(pending as any), purpose: "sourced_for_purchase" };
const buyerAck = buildPendingIncomingInventoryCustomerAck(buyerPending);
assert.match(buyerAck, /2016 Freewheeler/);
assert.match(buyerAck, /coming in/i);
assert.doesNotMatch(buyerAck, /\btrade\b/i, "a bike the customer is BUYING must never be called a trade");
const buyerInitial = buildPendingIncomingInventoryInitialAdfReply(buyerPending);
assert.doesNotMatch(buyerInitial, /\btrade\b/i);
const buyerTask = buildPendingIncomingInventoryTaskSummary({ pending: buyerPending, customerName: "Bill Indelicato" });
assert.doesNotMatch(buyerTask, /\btrade\b/i);
assert.equal(isPendingIncomingInventoryNotifyTodoSummary(buyerTask), true, "sourced task still recognized by the dedup matcher");

// factory_order purpose => the on-order framing even if `condition` is missing.
const orderPurposeAck = buildPendingIncomingInventoryCustomerAck({ ...(pending as any), purpose: "factory_order" });
assert.match(orderPurposeAck, /on order/i);
assert.doesNotMatch(orderPurposeAck, /\btrade\b/i);

// unclear => the same safe neutral copy as no purpose at all.
const unclearAck = buildPendingIncomingInventoryCustomerAck({ ...(pending as any), purpose: "unclear" });
assert.match(unclearAck, /coming in/i);
assert.doesNotMatch(unclearAck, /\btrade\b/i);

// --- Kind-aware copy: a NEW factory pre-order is "on order", NOT a "trade" (Nicholas Braun fix). ---
const orderPending = {
  model: "Street Bob",
  year: 2026,
  make: "Harley-Davidson",
  condition: "new",
  label: "2026 Street Bob",
  status: "pending"
} as any;
const orderAck = buildPendingIncomingInventoryCustomerAck(orderPending);
assert.match(orderAck, /2026 Street Bob/);
assert.match(orderAck, /on order/i);
assert.doesNotMatch(orderAck, /\btrade\b/i, "a NEW on-order unit must never be called a trade");
const orderInitial = buildPendingIncomingInventoryInitialAdfReply(orderPending);
assert.match(orderInitial, /on order/i);
assert.doesNotMatch(orderInitial, /taking in on trade/i);
const orderTask = buildPendingIncomingInventoryTaskSummary({ pending: orderPending, customerName: "Nicholas Braun" });
assert.equal(orderTask, "Notify Nicholas Braun when the 2026 Street Bob (on order) arrives or is ready to show.");
assert.doesNotMatch(orderTask, /\btrade\b/i);
// The dedup matcher must still recognize the NEW on-order task (stable tail, not "trade arrives").
assert.equal(isPendingIncomingInventoryNotifyTodoSummary(orderTask), true);
assert.equal(isPendingIncomingInventoryNotifyTodoSummary(task), true, "neutral incoming task still recognized");
// The legacy "…trade arrives or is ready to show" copy (records written before the purpose fix) must
// STILL be recognized by the dedup matcher, so old tasks keep collapsing instead of piling up.
assert.equal(
  isPendingIncomingInventoryNotifyTodoSummary("Notify Don Pagels when the 2016 Freewheeler trade arrives or is ready to show."),
  true,
  "legacy trade task copy still recognized"
);

// --- Placeholder suppression: "Other"/"Full Line" must NOT leak into customer/task copy. ---
const placeholderOrder = {
  model: "Harley-Davidson Other",
  year: 2026,
  condition: "new",
  label: "2026 Other",
  status: "pending"
} as any;
const phAck = buildPendingIncomingInventoryCustomerAck(placeholderOrder);
assert.doesNotMatch(phAck, /\bother\b/i, "the 'Other' placeholder must not leak into the ack");
assert.doesNotMatch(phAck, /\btrade\b/i);
assert.match(phAck, /the bike you've got on order/i);
const phTask = buildPendingIncomingInventoryTaskSummary({ pending: placeholderOrder, customerName: "Nicholas Braun" });
assert.equal(phTask, "Notify Nicholas Braun when the ordered bike arrives or is ready to show.");
assert.doesNotMatch(phTask, /\bother\b|\btrade\b/i);
// A USED unit with a placeholder label and NO comprehended purpose: neutral copy, placeholder still
// suppressed, and no invented "trade" claim.
const phTrade = { model: "Harley-Davidson Full Line", year: 2026, condition: "used", label: "2026 Full Line", status: "pending" } as any;
const phTradeAck = buildPendingIncomingInventoryCustomerAck(phTrade);
assert.doesNotMatch(phTradeAck, /full\s*line/i, "the 'Full Line' placeholder must not leak");
assert.doesNotMatch(phTradeAck, /\btrade\b/i, "no purpose => no trade claim");
assert.match(phTradeAck, /the bike we've got coming in/i);
// A comprehended trade_in with a placeholder label still gets the trade framing, placeholder suppressed.
const phTradeIn = buildPendingIncomingInventoryCustomerAck({ ...phTrade, purpose: "trade_in" });
assert.doesNotMatch(phTradeIn, /full\s*line/i);
assert.match(phTradeIn, /the incoming trade/i);

console.log("PASS pending incoming inventory eval");
