/**
 * cadence_watch_offer_instock_guard:eval (universal, deterministic) — runs inside ci:eval.
 *
 * Pins Joe's 2026-07-19 ruling (+17164184478 Chris Duchon): the proactive cadence copy offered
 * to "keep an eye on the Fltrx Road Glide" — a model that is amply IN STOCK. You never offer an
 * availability watch on a bike that's already on the lot; you invite the customer in. Both
 * cadence builders (the live send path `processDueFollowUpsUnlocked` and the regen twin
 * `buildCadenceRegeneratedDraft`) must drop the watch-offer variant when the model is confirmed
 * in stock — and must do so via the SAME shared guard so live/regen can't drift (route-parity).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  isWatchOfferCadenceVariant,
  excludeWatchOfferWhenInStock
} from "../services/api/src/domain/cadenceInventoryGuard.ts";

// The exact production inventory[2] pool from ENGAGED_FOLLOW_UP_VARIANTS_NO_SLOTS.inventory.
const WATCH_OFFER = "{name}, want me to keep an eye on the {model} for you?";
const SIBLING = "Still interested in{label} or looking at other options?";
const SCHEDULING = "{name}, want to set a time for the {model}?";
const VIDEO = "{name}, I can send a walkaround video of{label}.";

// (a) The detector flags the watch-offer line and nothing benign.
assert.equal(isWatchOfferCadenceVariant(WATCH_OFFER), true, "must flag the keep-an-eye-on watch offer");
assert.equal(
  isWatchOfferCadenceVariant("I'll text you when one comes in that fits."),
  true,
  "must flag the 'text you when one comes in' watch-offer phrasing"
);
assert.equal(isWatchOfferCadenceVariant(SIBLING), false, "the 'still interested / other options' sibling is NOT a watch offer");
assert.equal(isWatchOfferCadenceVariant(SCHEDULING), false, "a scheduling invite is NOT a watch offer");
assert.equal(isWatchOfferCadenceVariant(VIDEO), false, "a walkaround-video offer is NOT a watch offer");
assert.equal(isWatchOfferCadenceVariant(""), false);
assert.equal(isWatchOfferCadenceVariant(undefined), false);

// (b) When the model is in stock, the pool drops the watch offer and keeps the sibling.
const inventoryPool = [SIBLING, WATCH_OFFER];
const inStockPool = excludeWatchOfferWhenInStock(inventoryPool, true);
assert.deepEqual(inStockPool, [SIBLING], "in-stock => watch offer removed, sibling survives");
assert.ok(
  !inStockPool.some(isWatchOfferCadenceVariant),
  "no watch offer may survive when the model is in stock"
);

// (c) When NOT in stock (or feed unknown/false), the pool is unchanged — a legitimate
// out-of-stock watch offer is never wrongly suppressed (safe fail-direction).
assert.deepEqual(
  excludeWatchOfferWhenInStock(inventoryPool, false),
  inventoryPool,
  "not in stock => pool unchanged, watch offer preserved"
);

// (d) Never return an empty pool — a pool that is ONLY watch offers is kept so a cadence
// touch still sends (we degrade to a slightly-wrong offer rather than going silent).
const onlyWatch = [WATCH_OFFER];
assert.deepEqual(
  excludeWatchOfferWhenInStock(onlyWatch, true),
  onlyWatch,
  "a watch-only pool must not be emptied by the guard"
);

// (e) Both reply paths apply the SAME guard on the SAME in-stock signal (no live/regen drift).
{
  const src = readFileSync("services/api/src/index.ts", "utf8");
  for (const fn of ["async function processDueFollowUpsUnlocked", "async function buildCadenceRegeneratedDraft"]) {
    const start = src.indexOf(fn);
    assert.ok(start >= 0, `${fn} must exist in index.ts`);
    // Scan a generous window for the in-stock computation + guard call.
    const body = src.slice(start, start + 90000);
    assert.match(
      body,
      /followUpModelInStock/,
      `${fn} must compute the in-stock signal (followUpModelInStock)`
    );
    assert.match(
      body,
      /excludeWatchOfferWhenInStock\(/,
      `${fn} must gate the watch-offer variant via excludeWatchOfferWhenInStock (parity)`
    );
  }
}

console.log("cadence_watch_offer_instock_guard_eval passed");
