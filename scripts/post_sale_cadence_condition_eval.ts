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
