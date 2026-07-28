/**
 * Photo-realness vision eval (Phase 2, DARK — Joe 2026-07-27/28).
 *
 * The photo-request path (Phase 1, #312) uses a photo-COUNT heuristic to tell a real dealer gallery
 * from a stock studio shot. Phase 2 adds the equipment/cholo VISION viewer's real-vs-stock judgment
 * (per-unit, CACHED, fingerprinted on the image set) as the authoritative override. Ships DARK behind
 * PHOTO_REALNESS_VISION_ENABLED (+ the equipment-vision flag) — off => the count heuristic stands, so
 * merging changes nothing.
 *
 * Pins: the pure verdict helpers (threshold), the cache-only reader, the flag gate, the buildProfile
 * default, the vision schema/prompt (conditional), and the resolver override wiring. In ci:eval.
 * Run: npx tsx scripts/photo_realness_vision_eval.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  profilePhotosLookStock,
  profilePhotosLookReal,
  photoRealnessVisionEnabled,
  getCachedUnitEquipmentProfile,
  equipmentCacheKey,
  PHOTO_REALNESS_CONFIDENCE_MIN
} from "../services/api/src/domain/inventoryEquipmentVision.ts";

const prof = (verdict: string, confidence: number) => ({ photoRealness: { verdict, confidence } }) as any;

// --- 1) Pure verdict helpers (confidence-thresholded). ---
assert.equal(profilePhotosLookStock(prof("stock", 0.9)), true, "confident stock => looks stock");
assert.equal(profilePhotosLookStock(prof("stock", PHOTO_REALNESS_CONFIDENCE_MIN - 0.01)), false, "below-threshold stock => not asserted");
assert.equal(profilePhotosLookStock(prof("real", 0.99)), false, "a real verdict is not stock");
assert.equal(profilePhotosLookStock(prof("unknown", 0.99)), false, "unknown is never stock (fail-safe)");
assert.equal(profilePhotosLookStock(null), false, "no profile => not stock");
assert.equal(profilePhotosLookReal(prof("real", 0.9)), true, "confident real => looks real");
assert.equal(profilePhotosLookReal(prof("real", PHOTO_REALNESS_CONFIDENCE_MIN - 0.01)), false, "below-threshold real => not asserted");
assert.equal(profilePhotosLookReal(prof("stock", 0.99)), false, "a stock verdict is not real");
assert.equal(profilePhotosLookReal(null), false, "no profile => not real");

// --- 2) Cache-only reader: hit on the same image set, MISS when the photos change (fingerprint). ---
const item = { stockId: "U127-18", vin: null, images: ["https://cdn/a.jpg", "https://cdn/b.jpg"] };
const cache = { version: 1, profiles: { [equipmentCacheKey(item)]: prof("stock", 0.9) } } as any;
assert.ok(getCachedUnitEquipmentProfile(item, cache), "cache hit on the same stock + image set");
assert.equal(
  getCachedUnitEquipmentProfile({ ...item, images: ["https://cdn/NEW.jpg", "https://cdn/b.jpg"] }, cache),
  null,
  "a changed photo set is a cache MISS (re-reads on the next sweep — Joe's stock->real update concern)"
);
assert.equal(getCachedUnitEquipmentProfile(item, null), null, "no cache => null (=> caller uses the count heuristic)");

// --- 3) Flag gate (dark by default). ---
{
  const prevA = process.env.PHOTO_REALNESS_VISION_ENABLED;
  const prevB = process.env.INVENTORY_EQUIPMENT_VISION_ENABLED;
  process.env.PHOTO_REALNESS_VISION_ENABLED = "1";
  process.env.INVENTORY_EQUIPMENT_VISION_ENABLED = "0";
  assert.equal(photoRealnessVisionEnabled(), false, "needs BOTH flags (equipment-vision off => off)");
  process.env.INVENTORY_EQUIPMENT_VISION_ENABLED = "1";
  assert.equal(photoRealnessVisionEnabled(), true, "both on => enabled");
  process.env.PHOTO_REALNESS_VISION_ENABLED = "0";
  assert.equal(photoRealnessVisionEnabled(), false, "own flag off => off");
  if (prevA === undefined) delete process.env.PHOTO_REALNESS_VISION_ENABLED; else process.env.PHOTO_REALNESS_VISION_ENABLED = prevA;
  if (prevB === undefined) delete process.env.INVENTORY_EQUIPMENT_VISION_ENABLED; else process.env.INVENTORY_EQUIPMENT_VISION_ENABLED = prevB;
}

// --- 4) Source guards: vision read is conditional (dark), profile defaults, resolver override. ---
const llm = fs.readFileSync("services/api/src/domain/llmDraft.ts", "utf8");
assert.match(llm, /const photoRealnessOn\s*=/, "the vision read gates photo_realness behind its flag");
assert.match(llm, /\.\.\.\(photoRealnessOn \? \["photo_realness"\] : \[\]\)/, "photo_realness is only required when the flag is on (dark otherwise)");
assert.match(llm, /photoRealness: \{[\s\S]{0,120}?verdict:/, "the vision read maps photo_realness");

const vision = fs.readFileSync("services/api/src/domain/inventoryEquipmentVision.ts", "utf8");
assert.match(vision, /photoRealness: desc\.photoRealness \?\? \{ verdict: "unknown", confidence: 0 \}/, "buildEquipmentProfile defaults to unknown when the read omits it (flag off)");

const api = fs.readFileSync("services/api/src/index.ts", "utf8");
assert.match(api, /if \(photoRealnessVisionEnabled\(\)\) \{/, "the resolver only consults vision when the flag is on");
assert.match(api, /profilePhotosLookStock\(profile\)\) return false/, "a stock verdict makes the unit a task (not sendable)");
assert.match(api, /profilePhotosLookReal\(profile\)\) return true/, "a real verdict makes the unit sendable");
assert.match(api, /return unitHasRealPhotos\(u\); \/\/ fallback: deterministic photo-count heuristic/, "falls back to the count heuristic when vision is silent");
assert.match(api, /attachable: unitHasSendablePhotos/, "the reply builder attaches photos per the vision-aware predicate (never a stock shot)");

const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
assert.ok(String(pkg.scripts?.["ci:eval"] ?? "").includes("photo_realness_vision:eval"), "photo_realness_vision:eval is wired into ci:eval");

console.log("PASS photo-realness vision eval (verdict helpers + cache-only fingerprint read + flag gate + dark source guards + resolver override)");
