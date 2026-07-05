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
assert.match(initialAdfReply, /taking in on trade/i);
assert.doesNotMatch(initialAdfReply, /not seeing|in stock right now|similar options|browse/i);

const task = buildPendingIncomingInventoryTaskSummary({
  pending,
  customerName: "Don Pagels"
});
assert.equal(task, "Notify Don Pagels when the 2016 Freewheeler trade arrives or is ready to show.");

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
assert.equal(isPendingIncomingInventoryNotifyTodoSummary(task), true, "legacy trade task still recognized");

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
// A USED unit with a placeholder label keeps the trade framing but still suppresses the placeholder.
const phTrade = { model: "Harley-Davidson Full Line", year: 2026, condition: "used", label: "2026 Full Line", status: "pending" } as any;
const phTradeAck = buildPendingIncomingInventoryCustomerAck(phTrade);
assert.doesNotMatch(phTradeAck, /full\s*line/i, "the 'Full Line' placeholder must not leak");
assert.match(phTradeAck, /the incoming trade/i);

console.log("PASS pending incoming inventory eval");
