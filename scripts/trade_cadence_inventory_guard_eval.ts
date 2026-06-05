import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { isTradeSellCadenceContext } from "../services/api/src/domain/cadenceInventoryGuard.ts";

const markPalmerStyleTradeLead = {
  id: "conv_mark_palmer",
  leadKey: "+17168304817",
  lead: {
    source: "Trade Accelerator - Trade In",
    vehicle: {
      year: "2026",
      make: "HARLEY-DAVIDSON",
      model: "Street Glide Limited"
    },
    tradeVehicle: {
      year: "2021",
      make: "HARLEY-DAVIDSON",
      model: "FLHX Street Glide"
    }
  },
  classification: {
    bucket: "trade_in_sell",
    cta: "value_my_trade"
  },
  followUpCadence: {
    status: "active",
    contextTag: "sell:pickup",
    usedVariants: {
      "sell:pickup:0": true
    }
  },
  messages: [
    {
      direction: "out",
      provider: "twilio",
      body:
        "Just checking in - if you want us to pick up your 2021 FLHX Street Glide for a trade evaluation, let me know where you're located."
    }
  ]
};

const normalInventoryLead = {
  id: "conv_inventory_buyer",
  leadKey: "+17160000000",
  lead: {
    source: "Website Inventory",
    vehicle: {
      year: "2021",
      make: "HARLEY-DAVIDSON",
      model: "Street Glide Special",
      color: "Gauntlet Gray Metallic - Black Finish"
    }
  },
  classification: {
    bucket: "inventory_interest",
    cta: "check_availability"
  },
  followUpCadence: {
    status: "active",
    contextTag: "inventory_interest"
  }
};

const mixedTradeInBuyerLead = {
  id: "conv_mixed_trade_buyer",
  leadKey: "+17160000001",
  lead: {
    source: "Trade Accelerator - Trade In",
    vehicle: {
      year: "2021",
      make: "HARLEY-DAVIDSON",
      model: "Street Glide Special"
    },
    tradeVehicle: {
      year: "2018",
      make: "HARLEY-DAVIDSON",
      model: "Heritage Classic"
    }
  },
  classification: {
    bucket: "inventory_interest",
    cta: "request_a_quote"
  },
  followUpCadence: {
    status: "active",
    contextTag: "inventory_interest"
  }
};

const privateSellerLead = {
  id: "conv_private_seller",
  lead: {
    source: "Manual outbound"
  },
  classification: {
    bucket: "trade_in_sell",
    cta: "sell_my_bike"
  },
  followUp: {
    mode: "manual_handoff",
    reason: "seller_photo_details_request"
  }
};

assert.equal(
  isTradeSellCadenceContext(markPalmerStyleTradeLead),
  true,
  "trade-in cadence should not be eligible for held-inventory watch overrides"
);
assert.equal(
  isTradeSellCadenceContext(normalInventoryLead),
  false,
  "normal buyer inventory cadence should still be eligible for held/sold availability overrides"
);
assert.equal(
  isTradeSellCadenceContext(mixedTradeInBuyerLead),
  false,
  "trade-in platform leads that are classified as inventory buyers should not be blocked by source alone"
);
assert.equal(
  isTradeSellCadenceContext(privateSellerLead),
  true,
  "private seller/sell-my-bike cadence should not create customer inventory watches"
);

const apiSource = await fs.readFile(path.resolve("services/api/src/index.ts"), "utf8");
const heldOverride = apiSource.match(
  /async function buildCadenceHeldInventoryOverride[\s\S]*?const parserContext = await getParserCadenceInventoryTargetContext/
)?.[0];
assert.ok(heldOverride, "held inventory override function should be present");
assert.match(
  heldOverride,
  /isTradeSellCadenceContext\(conv\)[\s\S]*?return null;/,
  "held inventory override must skip trade/sell cadence before parser or deterministic vehicle context runs"
);

console.log("PASS trade cadence inventory guard eval");
