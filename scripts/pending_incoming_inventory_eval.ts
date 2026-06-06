import assert from "node:assert/strict";
import {
  buildPendingIncomingInventoryCustomerAck,
  buildPendingIncomingInventoryFromConversation,
  buildPendingIncomingInventoryInitialAdfReply,
  buildPendingIncomingInventoryTaskSummary,
  hasPendingIncomingInventoryContext,
  hasPendingIncomingInventorySignal,
  isPendingIncomingInventoryAcknowledgementText,
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

console.log("PASS pending incoming inventory eval");
