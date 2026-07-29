/**
 * Backfill — WHOLE-LOT equipment profiling (2026-07-29, Jason Marshall +17165230421).
 *
 * THE GAP THIS CLOSES. Equipment profiling has only ever run profile-on-ARRIVAL
 * (profileArrivedUnitsForEquipment): brand-new stockIds only, capped at
 * INVENTORY_EQUIPMENT_ARRIVAL_VISION_CAP (default 8) per sweep, and ONLY when a conversation is
 * already waiting (convWaitsForVisionProfile). Profiling the units ALREADY on the lot was written
 * down as a follow-up and never built. Verified on the americanharley box 2026-07-29: there is no
 * inventory_equipment_profiles.json AT ALL — zero units have ever been profiled.
 *
 * WHY IT MATTERS. watchEquipmentFireGate is fail-safe: an unprofiled unit does NOT fire. With an
 * empty cache that makes EVERY watch carrying requestedEquipment silently unfireable, for every
 * bike, forever — which is exactly how Jason's {tourpak:true} watch was dead on arrival. The same
 * emptiness would neuter the finish filter (watchFinishFireGate), so the lot must be profiled
 * BEFORE finish filtering means anything.
 *
 * COST. One vision call per unprofiled unit that has photos (up to
 * INVENTORY_EQUIPMENT_VISION_MAX_IMAGES images per call, default 4). Cached units are free — the
 * cache key is stockId/vin + an image-set hash, so re-runs only pay for genuinely new or
 * re-photographed units. --cap bounds the spend on any single run; re-run to continue.
 *
 * SAFETY. Writes ONLY the equipment-profile cache. It never touches conversations, watches, or
 * customer state, and it never sends anything. Dry-run by default.
 *
 *   self-test (deterministic, no network/LLM — runs in ci:eval):
 *     npx tsx scripts/backfill_inventory_equipment_profiles.ts --self-test
 *   dry-run (counts what WOULD be profiled and what it would cost — no vision calls):
 *     npx tsx scripts/backfill_inventory_equipment_profiles.ts
 *   APPLY (spends vision calls, writes the cache — approve-first):
 *     npx tsx scripts/backfill_inventory_equipment_profiles.ts --apply --cap 100
 */
import assert from "node:assert/strict";
// NOTE: this script deliberately imports ONLY primitives that exist on `main`, so it can be run
// against the deployed checkout to profile the lot BEFORE the finish-filtering code ships. The
// finish gate's own fail-direction cases live in inventory_equipment_vision_eval.ts.
import {
  loadEquipmentCache,
  saveEquipmentCache,
  getUnitEquipmentProfile,
  equipmentCacheKey,
  type EquipmentCacheFile,
  type EquipmentProfile
} from "../services/api/src/domain/inventoryEquipmentVision.ts";
import { getInventoryFeed, type InventoryFeedItem } from "../services/api/src/domain/inventoryFeed.ts";

type Plan = {
  total: number;
  withPhotos: number;
  noPhotos: number;
  alreadyCached: number;
  toProfile: InventoryFeedItem[];
};

/** PURE: decide what a run would do. Separated from the IO so the self-test can pin it. */
export function planLotProfiling(items: InventoryFeedItem[], cache: EquipmentCacheFile | null): Plan {
  const plan: Plan = { total: 0, withPhotos: 0, noPhotos: 0, alreadyCached: 0, toProfile: [] };
  for (const item of items ?? []) {
    plan.total++;
    const images = (item.images ?? []).filter(Boolean);
    if (!images.length) {
      plan.noPhotos++;
      continue; // no photos → nothing for vision to read; never counted as spend
    }
    plan.withPhotos++;
    const key = equipmentCacheKey(item);
    if (key && cache?.profiles?.[key]) {
      plan.alreadyCached++; // cache hit — free
      continue;
    }
    plan.toProfile.push(item);
  }
  return plan;
}

// --------------------------------------------------------------------------
// self-test — pure, no network, no LLM. Wired into ci:eval.
// --------------------------------------------------------------------------
if (process.argv.includes("--self-test")) {
  const withPhotos = (stockId: string, images: string[]): InventoryFeedItem =>
    ({ stockId, vin: `VIN${stockId}`, model: "Road Glide", images }) as any as InventoryFeedItem;

  const a = withPhotos("A1", ["https://x/1.jpg", "https://x/2.jpg"]);
  const b = withPhotos("B2", ["https://x/3.jpg"]);
  const noPics = withPhotos("C3", []);

  // Empty cache = the live 2026-07-29 state: everything with photos needs profiling.
  const cold = planLotProfiling([a, b, noPics], { profiles: {} } as EquipmentCacheFile);
  assert.equal(cold.total, 3);
  assert.equal(cold.withPhotos, 2, "only units carrying photos are profilable");
  assert.equal(cold.noPhotos, 1, "a photoless unit is skipped, never billed");
  assert.equal(cold.toProfile.length, 2, "a cold cache profiles every photo-bearing unit");

  // A warm cache must be FREE for units already profiled (re-runs must not re-bill).
  const warm = { profiles: { [equipmentCacheKey(a)]: {} as EquipmentProfile } } as EquipmentCacheFile;
  const second = planLotProfiling([a, b, noPics], warm);
  assert.equal(second.alreadyCached, 1, "an already-profiled unit is a free cache hit");
  assert.equal(second.toProfile.length, 1, "only the un-profiled unit is billed on a re-run");
  assert.equal(second.toProfile[0].stockId, "B2");

  // A null cache behaves like a cold one (never crashes into "nothing to do").
  assert.equal(planLotProfiling([a, b], null).toProfile.length, 2, "a missing cache file profiles everything");
  assert.equal(planLotProfiling([], { profiles: {} } as EquipmentCacheFile).toProfile.length, 0, "an empty feed is a no-op");

  // COST GUARD: a photoless unit must never be counted as spend, and a re-run must never re-bill.
  const reRun = planLotProfiling([a, b, noPics], {
    profiles: { [equipmentCacheKey(a)]: {} as EquipmentProfile, [equipmentCacheKey(b)]: {} as EquipmentProfile }
  } as EquipmentCacheFile);
  assert.equal(reRun.toProfile.length, 0, "a fully-warm cache costs NOTHING on a re-run");
  assert.equal(reRun.alreadyCached, 2, "both photo-bearing units are free cache hits");

  console.log("PASS backfill inventory equipment profiles (self-test: 7 plan/cost cases)");
  process.exit(0);
}

// --------------------------------------------------------------------------
// real run
// --------------------------------------------------------------------------
const apply = process.argv.includes("--apply");
const capArg = process.argv.indexOf("--cap");
const cap = capArg >= 0 ? Math.max(1, Number(process.argv[capArg + 1] ?? 0) || 0) : Number.POSITIVE_INFINITY;

const items = await getInventoryFeed({ bypassCache: true });
if (!items.length) {
  console.error("Inventory feed returned 0 units — check INVENTORY_FEED_URL. Nothing to do.");
  process.exit(2);
}
const cache = await loadEquipmentCache();
const plan = planLotProfiling(items, cache);

console.log(`# Whole-lot equipment profiling — ${apply ? "APPLY" : "DRY-RUN (no vision calls, nothing written)"}`);
console.log(`  units in feed:        ${plan.total}`);
console.log(`  carrying photos:      ${plan.withPhotos}`);
console.log(`  no photos (skipped):  ${plan.noPhotos}`);
console.log(`  already profiled:     ${plan.alreadyCached} (free)`);
console.log(`  WOULD PROFILE:        ${plan.toProfile.length}${Number.isFinite(cap) ? ` (capped at ${cap} this run)` : ""}`);
console.log(`  => ~${Math.min(plan.toProfile.length, Number.isFinite(cap) ? cap : plan.toProfile.length)} vision call(s)`);

if (!apply) {
  console.log("\n(dry-run — re-run with --apply to profile; add --cap N to bound the spend)");
  process.exit(0);
}

let profiled = 0;
let visionRuns = 0;
let failed = 0;
for (const item of plan.toProfile) {
  if (visionRuns >= cap) {
    console.log(`\nCAPPED at ${cap} vision call(s) — re-run to continue.`);
    break;
  }
  try {
    const res = await getUnitEquipmentProfile(item, { cache });
    if (res.ranVision) visionRuns++;
    if (res.profile) profiled++;
    else failed++;
    if ((profiled + failed) % 10 === 0) {
      // Persist incrementally: a mid-run crash must never throw away calls already paid for.
      await saveEquipmentCache(cache);
      console.log(`  ... ${profiled} profiled, ${failed} failed, ${visionRuns} vision call(s)`);
    }
  } catch (err: any) {
    failed++;
    console.log(`  ! ${item.stockId ?? item.vin ?? "?"} failed: ${err?.message ?? err}`);
  }
}
await saveEquipmentCache(cache);
console.log(`\nDONE — profiled ${profiled}, failed ${failed}, ${visionRuns} vision call(s). Cache written.`);
