/**
 * Post-sale cadence NEW-vs-PRE-OWNED eval (deterministic — no LLM).
 *
 * Pins that the Custom Coverage / factory-warranty accessory reminder only goes to NEW-bike
 * purchases, and pre-owned buyers get a warm no-warranty-claim check-in. postSaleVehicleIsNew
 * must fail SAFE (unknown condition => pre-owned), so a false "full factory warranty" claim
 * can't reach a pre-owned buyer. Origin: Marcy got the factory-warranty reminder post-sale.
 */
import assert from "node:assert/strict";
import {
  postSaleVehicleIsNew,
  postSaleAccessoryOrEnjoyMessage
} from "../services/api/src/domain/postSaleCadence.ts";

// --- postSaleVehicleIsNew: confident NEW only, else pre-owned ---
assert.equal(postSaleVehicleIsNew({ sale: { condition: "new" } }), true, "sale.condition=new => new");
assert.equal(postSaleVehicleIsNew({ lead: { vehicle: { condition: "new" } } }), true, "lead vehicle new => new");
assert.equal(postSaleVehicleIsNew({ inventoryContext: { condition: "new" } }), true, "inventoryContext new => new");
assert.equal(postSaleVehicleIsNew({ sale: { condition: "new", label: "2025 Street Glide" } }), true, "new + clean label => new");

assert.equal(postSaleVehicleIsNew({}), false, "unknown condition => pre-owned (fail-safe)");
assert.equal(postSaleVehicleIsNew({ lead: { vehicle: { condition: "used" } } }), false, "lead vehicle used => pre-owned");
assert.equal(postSaleVehicleIsNew({ sale: { label: "Pre-Owned 2020 Road Glide" } }), false, "pre-owned label => pre-owned");
assert.equal(postSaleVehicleIsNew({ sale: { label: "Used 2019 Street Glide" } }), false, "used label => pre-owned");
assert.equal(
  postSaleVehicleIsNew({ sale: { condition: "new", label: "Certified Pre-Owned Fat Boy" } }),
  false,
  "used label hint overrides a stray new condition => pre-owned (no false warranty claim)"
);

// --- model-year sanity (Joe ruling 2026-07-09, Kellen +17167995197): a lying ADF
// condition:"new" on a bike whose model year is 3+ years older than the sale flips to
// pre-owned; genuine non-current new stock (gap <= 2) stays new. ---
assert.equal(
  postSaleVehicleIsNew({
    lead: { vehicle: { condition: "new", year: "2019", model: "Electra Glide Ultra Classic" } },
    closedAt: "2026-05-04T13:23:15.029Z"
  }),
  false,
  "Kellen class: 2019 bike sold 2026 with condition:new => pre-owned (ADF field lies)"
);
assert.equal(
  postSaleVehicleIsNew({
    lead: { vehicle: { condition: "new", year: "2024", model: "Low Rider S" } },
    closedAt: "2026-06-30T12:00:00.000Z"
  }),
  true,
  "non-current new stock: new 2024 sold 2026 (gap 2) stays NEW"
);
assert.equal(
  postSaleVehicleIsNew({
    sale: { condition: "new", year: 2026, soldAt: "2026-07-01T12:00:00.000Z" }
  }),
  true,
  "current-year new sale stays NEW (sale.year + sale.soldAt path)"
);
assert.equal(
  postSaleVehicleIsNew({ lead: { vehicle: { condition: "new", year: "not-a-year" } }, closedAt: "2026-05-04T00:00:00Z" }),
  true,
  "unparseable year => no year override (condition signal stands)"
);

// --- the condition-specific message (cadence step 2) ---
const newMsg = postSaleAccessoryOrEnjoyMessage({
  firstName: "Marcy", repName: "Giovanni", dealerName: "American Harley-Davidson", bikeModel: "Street Glide", isNewBike: true
});
assert.ok(/Custom Coverage/.test(newMsg) && /full factory warranty/.test(newMsg), "NEW bike => Custom Coverage / factory warranty reminder");

const preownedMsg = postSaleAccessoryOrEnjoyMessage({
  firstName: "Marcy", repName: "Giovanni", dealerName: "American Harley-Davidson", bikeModel: "Street Glide", isNewBike: false
});
assert.ok(!/Custom Coverage/i.test(preownedMsg), "PRE-OWNED => no Custom Coverage pitch");
assert.ok(!/factory warranty/i.test(preownedMsg), "PRE-OWNED => no factory-warranty claim");
assert.ok(/enjoying the Street Glide/i.test(preownedMsg) && /just let me know/i.test(preownedMsg), "PRE-OWNED => warm 'enjoying it / anything you need' check-in naming the bike");
// charter: at most one em-dash in the message (the intro), no doubled em-dash list
assert.ok((preownedMsg.match(/—/g) || []).length <= 1, "pre-owned message keeps the em-dash diet (<=1)");

// charter long_brand_repeat: a post-sale touch is NOT a first outbound, so the full brand
// name must be framed as a re-intro ("this is {rep} at {dealer}") to clear the check.
// Origin: Weston (+17167439566) 2026-07-05 — "Giovanni at American Harley-Davidson" tripped it.
assert.ok(/this is Giovanni at American Harley-Davidson/.test(preownedMsg), "PRE-OWNED => re-intro phrasing clears charter long_brand_repeat");
assert.ok(/this is Giovanni at American Harley-Davidson/.test(newMsg), "NEW => re-intro phrasing clears charter long_brand_repeat");

console.log("PASS post-sale cadence condition eval");
