/**
 * Trike-class model family eval (Joe's rule, 2026-07-04): a trike is a different FAMILY
 * from its two-wheel namesake — "Road Glide 3" (FLTRT, TRIKE) is NOT a "Road Glide"
 * (touring) sibling. Pins:
 *   1. isTrikeClassModel — catalog-driven trike/two-wheel/unknown resolution, including
 *      the umbrella-alias subtlety (the base "road glide" alias contains FLTRT but is
 *      NOT trike-class; the specific "road glide 3" alias is).
 *   2. trikeClassConflict — symmetric, null-infers-nothing.
 *   3. The watch matcher integration: a base-model watch must NEVER fire on a
 *      cross-family (trike) arrival — even when openToOtherTrims — while same-family
 *      trim behavior (strict blocks, openToOtherTrims fires) is unchanged. Without this
 *      guard a base "Road Glide" watch fires on an arriving "Road Glide 3" ("3" is not a
 *      distinct-trim token and the model string substring-matches).
 */
import assert from "node:assert/strict";
import { isTrikeClassModel, trikeClassConflict } from "../services/api/src/domain/modelFamily.ts";
import { inventoryItemMatchesWatch } from "../services/api/src/domain/watchFireMiss.ts";
import type { InventoryWatch } from "../services/api/src/domain/conversationStore.ts";
import type { InventoryFeedItem } from "../services/api/src/domain/inventoryFeed.ts";

// --- 1) Trike-class resolution. ---
const trike: Array<string> = [
  "Road Glide 3",
  "Road Glide III",
  "Road Glide Trike",
  "2026 Road Glide® 3",
  "Street Glide 3",
  "Street Glide 3 Limited",
  "Tri Glide",
  "Tri Glide Ultra",
  "Freewheeler",
  "FLTRT"
];
const twoWheel: Array<string> = [
  "Road Glide",
  "Road Glide Special",
  "Road Glide Limited",
  "Road Glide ST",
  "CVO Road Glide",
  "Street Glide",
  "Street Glide Special",
  "Fat Boy",
  "Sportster",
  "FLHX"
];
for (const m of trike) assert.equal(isTrikeClassModel(m), true, `"${m}" must be trike-class`);
for (const m of twoWheel) assert.equal(isTrikeClassModel(m), false, `"${m}" must be two-wheel`);
assert.equal(isTrikeClassModel(""), null, "empty resolves to null");
assert.equal(isTrikeClassModel("Some Unknown Bike"), null, "unknown text resolves to null (infers nothing)");

// --- 2) Cross-family conflict. ---
assert.equal(trikeClassConflict("Road Glide 3", "Road Glide"), true, "RG3 vs RG conflict");
assert.equal(trikeClassConflict("Road Glide", "Road Glide 3"), true, "symmetric");
assert.equal(trikeClassConflict("Street Glide 3 Limited", "Street Glide"), true, "SG3 vs SG conflict");
assert.equal(trikeClassConflict("Road Glide Special", "Road Glide"), false, "same-family trims do not conflict");
assert.equal(trikeClassConflict("Tri Glide", "Road Glide 3"), false, "trike vs trike does not conflict");
assert.equal(trikeClassConflict("Road Glide", "Some Unknown Bike"), false, "unknown side infers nothing");

// --- 3) Watch matcher integration (Raysean class, +15136149740: a base "Road Glide" watch
//        must stay silent on an arriving "Road Glide 3" trike). ---
const baseWatch = (over?: Partial<InventoryWatch>): InventoryWatch => ({
  model: "Road Glide",
  createdAt: "2026-07-01T00:00:00.000Z",
  ...over
});
const unit = (model: string): InventoryFeedItem => ({ model } as InventoryFeedItem);

// The bug class: cross-family arrival never fires — strict OR open to trims.
assert.equal(inventoryItemMatchesWatch(unit("Road Glide 3"), baseWatch()), false, "strict RG watch must not fire on RG3");
assert.equal(
  inventoryItemMatchesWatch(unit("Road Glide 3"), baseWatch({ openToOtherTrims: true })),
  false,
  "openToOtherTrims widens TRIMS, never form factor — RG3 still must not fire"
);
assert.equal(
  inventoryItemMatchesWatch(unit("Street Glide 3 Limited"), { model: "Street Glide", createdAt: "2026-07-01T00:00:00.000Z" }),
  false,
  "SG watch must not fire on a Street Glide 3 Limited trike"
);

// Trike watchers still get their trikes (the guard is symmetric, not a trike ban).
assert.equal(
  inventoryItemMatchesWatch(unit("Road Glide 3"), { model: "Road Glide 3", createdAt: "2026-07-01T00:00:00.000Z" }),
  true,
  "an RG3 watch fires on an RG3 arrival"
);

// Same-family trim behavior unchanged (PR #129): strict blocks, openToOtherTrims fires.
assert.equal(inventoryItemMatchesWatch(unit("Road Glide Special"), baseWatch()), false, "strict blocks a sibling trim");
assert.equal(
  inventoryItemMatchesWatch(unit("Road Glide Special"), baseWatch({ openToOtherTrims: true })),
  true,
  "openToOtherTrims fires on a same-family sibling trim"
);
assert.equal(inventoryItemMatchesWatch(unit("Road Glide"), baseWatch()), true, "exact base still fires");

console.log("PASS model family eval");
