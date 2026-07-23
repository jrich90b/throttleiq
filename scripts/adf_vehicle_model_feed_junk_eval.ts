import { strict as assert } from "node:assert";
import { promises as fs } from "node:fs";

/**
 * ADF vehicle-model feed-junk eval — marketplace-relay ADF feeds (AutoDealers.Digital)
 * glue the whole inventory line into the vehicle "model" field:
 *   "Freewheeler 2016 FLRT U893-16 Vivid Black"
 * i.e. model name + model YEAR + OEM code + dealer STOCK code + color/trim — all of which
 * the intake has ALREADY extracted into their own lead.vehicle fields. Echoed raw, the
 * customer intro read "Thanks for your inquiry about the 2026 Road Glide 2026 FLTRX T24-26
 * Dark Billiard Gray Black Trim" (adf_ref_11421, sent to a real customer; also
 * adf_ref_11665/11655/11654/11642/11634 — corpus replay 2026-07-23).
 *
 * stripFeedInventoryTailFromModel (adfParser.ts) cuts the glued tail at the first
 * model-year or stock-code token; normalizeVehicleModel (sendgridInbound.ts) must run it so
 * both the STORED lead.vehicle.model and every composed bike label are clean. Real numeric
 * model suffixes (Iron 883, Road Glide 3, Super Meteor 650, …) must survive untouched.
 * Deterministic; no LLM.
 */

const { stripFeedInventoryTailFromModel } = await import("../services/api/src/domain/adfParser.ts");

const cases: Array<[string | null | undefined, string | undefined]> = [
  // ---- production feed shapes (pinned from the live americanharley store, 2026-07-23) ----
  // adf_ref_11655 / 11665 — used H-D, U-prefixed stock
  ["Freewheeler 2016 FLRT U893-16 Vivid Black", "Freewheeler"],
  // adf_ref_11421 — new H-D with trim suffix, T-prefixed stock
  ["Road Glide 2026 FLTRX T24-26 Dark Billiard Gray Black Trim", "Road Glide"],
  // adf_ref_11634 — non-Harley (Royal Enfield) with a "#650" displacement token; the real
  // numeric model suffix "650" BEFORE the year must survive, the tail after it must not
  ["Super Meteor 650 2026 #650 U595-26 Celestial Blue", "Super Meteor 650"],
  // adf_ref_11642 — hyphenated finish descriptor in the tail
  ["Street Glide 2024 FLHX U902-24 Vivid Black - Black Finish", "Street Glide"],
  // adf_ref_11654
  ["Softail Slim 2017 FLS U594-17 Black Denim", "Softail Slim"],
  // year-less variant: the stock-code token alone anchors the cut
  ["Freewheeler FLRT U893-16 Vivid Black", "Freewheeler FLRT"],
  ["Road King #1450 Vivid Black", "Road King"],

  // ---- real model names must NOT be stripped ----
  ["Iron 883", "Iron 883"],
  ["Sportster 1200 Custom", "Sportster 1200 Custom"],
  ["Fat Bob 114", "Fat Bob 114"],
  ["Road Glide 3", "Road Glide 3"],
  ["Pan America 1250 Special", "Pan America 1250 Special"],
  ["Super Meteor 650", "Super Meteor 650"],
  ["CVO Road Glide ST", "CVO Road Glide ST"],
  ["Street Glide", "Street Glide"],
  ["Low Rider ST", "Low Rider ST"],

  // ---- anchor is never token 0: a leading year stays (callers pair year separately) ----
  ["2016 Freewheeler", "2016 Freewheeler"],
  ["2026 Road Glide 2026 FLTRX T24-26 Gray", "2026 Road Glide"],

  // ---- whitespace + empties ----
  ["  Street   Bob  ", "Street Bob"],
  ["", undefined],
  [null, undefined],
  [undefined, undefined]
];

for (const [input, expected] of cases) {
  const got = stripFeedInventoryTailFromModel(input);
  assert.equal(
    got,
    expected,
    `stripFeedInventoryTailFromModel(${JSON.stringify(input)}) => ${JSON.stringify(got)}, expected ${JSON.stringify(expected)}`
  );
}

// Source guard: the customer-copy model path (normalizeVehicleModel in sendgridInbound) must
// run the cleaner — it is the single choke point for BOTH the stored lead.vehicle.model at
// ADF intake and the composed bike labels in the initial-ADF drafts (live + regenerate both
// read the same stored vehicle context downstream).
const route = await fs.readFile("services/api/src/routes/sendgridInbound.ts", "utf8");
assert.ok(
  /function normalizeVehicleModel[\s\S]{0,1200}stripFeedInventoryTailFromModel\(/.test(route),
  "normalizeVehicleModel (sendgridInbound.ts) must run stripFeedInventoryTailFromModel so ADF feed junk never reaches stored models or customer drafts"
);

console.log("adf_vehicle_model_feed_junk:eval ok");
