import { strict as assert } from "node:assert";
import { shouldBlockConversationStoreShrink } from "../services/api/src/domain/conversationStore.js";

assert.equal(
  shouldBlockConversationStoreShrink(473, 2),
  true,
  "large production store must not be overwritten by a tiny in-memory store"
);

assert.equal(
  shouldBlockConversationStoreShrink(473, 470),
  false,
  "normal small count changes should be allowed"
);

assert.equal(
  shouldBlockConversationStoreShrink(10, 2),
  false,
  "small test stores should not trip the production shrink guard"
);

assert.equal(
  shouldBlockConversationStoreShrink(100, 60),
  false,
  "less than half shrink should be allowed by the default guard"
);

assert.equal(
  shouldBlockConversationStoreShrink(100, 49),
  true,
  "more than half shrink should be blocked by the default guard"
);

console.log("Conversation store shrink guard checks passed.");
