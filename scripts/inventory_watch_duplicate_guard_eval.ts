import { strict as assert } from "node:assert";
import { hasPriorInventoryWatchOutboundForItem } from "../services/api/src/domain/inventoryWatchDedup.js";

const breakout = {
  stockId: "U590-17",
  vin: "1HDTESTBREAKOUT17",
  url: "https://americanharley-davidson.com/inventory/988002/2017-harley-davidson-breakout-custom-colour-laguna-orange"
};

const priorSent = {
  messages: [
    {
      direction: "out",
      provider: "twilio",
      body:
        "Hey Mark, good news - we just got 2017 Harley-Davidson Breakout in Custom Colour Laguna Orange in stock. Want details or a time to check it out?\n" +
        breakout.url
    }
  ]
};

assert.equal(
  hasPriorInventoryWatchOutboundForItem(
    priorSent,
    breakout,
    `Hey Mark, good news - we just got 2017 Harley-Davidson Breakout in Custom Colour Laguna Orange in stock. Want details or a time to check it out?\n${breakout.url}`
  ),
  true,
  "same listing URL should block a duplicate watch alert"
);

assert.equal(
  hasPriorInventoryWatchOutboundForItem(
    {
      messages: [
        {
          direction: "out",
          provider: "draft_ai",
          body: "Good news - stock U590-17 is available. Want details?"
        }
      ]
    },
    breakout,
    "Good news - the Breakout is available."
  ),
  true,
  "same stock number should block a duplicate watch alert"
);

assert.equal(
  hasPriorInventoryWatchOutboundForItem(
    {
      messages: [
        {
          direction: "out",
          provider: "draft_ai",
          draftStatus: "stale",
          body: `Good news - ${breakout.url}`
        }
      ]
    },
    breakout,
    "Good news - the Breakout is available."
  ),
  false,
  "stale drafts should not block a fresh alert"
);

assert.equal(
  hasPriorInventoryWatchOutboundForItem(
    priorSent,
    {
      stockId: "S9-25",
      vin: "1HDTESTBREAKOUT25",
      url: "https://americanharley-davidson.com/inventory/825003/2025-harley-davidson-breakout-billiard-gray"
    },
    "Good news - we have a 2025 Breakout in stock."
  ),
  false,
  "different stock/link in the same model family should still be allowed"
);

console.log("Inventory watch duplicate guard checks passed.");
