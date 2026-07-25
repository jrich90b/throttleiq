/**
 * Inventory equipment vision eval — Phase A governance + plumbing (DARK, 2026-07-25).
 *
 * Pins the equipment-vision pass's RULES and GOVERNANCE without needing any photos
 * (the vision LLM output is passed in). Pure, no IO/LLM. Measures nothing about a
 * real model's accuracy — it pins the deterministic scaffolding around it:
 *
 *  (a) windshield ≠ fairing (Joe's ruling): a profile whose fairing is asserted can
 *      NEVER count as a windshield match — matchesEquipmentQuery({bags, windshield})
 *      excludes fairing units even when vision also (wrongly) flagged a windshield.
 *  (b) below-threshold governance: a feature under the 0.7 assertion floor is NOT
 *      asserted → it fails toward "looks like / let me confirm", never a false yes.
 *  (c) model-prior sanity: a Street Glide expects a fairing (batwing), not a
 *      windshield; a Road Glide unit that vision misreads as a windshield gets that
 *      windshield knocked below the assertion floor by the prior reconcile.
 *  (d) schema/shape: the 9-feature taxonomy, cache-key + image-hash behavior.
 *
 * Run: npx tsx scripts/inventory_equipment_vision_eval.ts
 */
import assert from "node:assert/strict";

import {
  EQUIPMENT_ASSERTION_CONFIDENCE_MIN,
  EQUIPMENT_FEATURE_KEYS,
  buildEquipmentProfile,
  equipmentCacheKey,
  imageSetHash,
  matchesEquipmentQuery,
  modelEquipmentPrior,
  reconcileEquipmentWithPrior
} from "../services/api/src/domain/inventoryEquipmentVision.ts";
import type { VehicleEquipmentDescription } from "../services/api/src/domain/llmDraft.ts";

// Confidence floor is the documented default.
assert.equal(EQUIPMENT_ASSERTION_CONFIDENCE_MIN, 0.7, "assertion floor mirrors VISION_CONFIDENCE_MIN default (0.7)");
assert.equal(EQUIPMENT_FEATURE_KEYS.length, 9, "the fuller v1 taxonomy has 9 features");

// --- helper: build a full vision read with sane defaults ---
function feat(present: boolean, confidence: number) {
  return { present, confidence };
}
function desc(overrides: Partial<VehicleEquipmentDescription>): VehicleEquipmentDescription {
  return {
    isMotorcycle: true,
    bags: { present: false, confidence: 0, bagType: "unknown" },
    windshield: feat(false, 0),
    fairing: { present: false, confidence: 0, fairingType: "unknown" },
    backrestSissybar: feat(false, 0),
    tourpak: feat(false, 0),
    forwardControls: feat(false, 0),
    apeHangers: feat(false, 0),
    floorboards: feat(false, 0),
    crashBars: feat(false, 0),
    overallConfidence: 0.8,
    notes: "",
    ...overrides
  };
}

// ===========================================================================
// (c) Model-prior sanity
// ===========================================================================
{
  const sg = modelEquipmentPrior("Street Glide");
  assert.equal(sg.fairing, "expected", "Street Glide expects a fairing");
  assert.equal(sg.fairingType, "batwing", "Street Glide fairing is batwing");
  assert.equal(sg.windshield, "unexpected", "Street Glide does NOT expect a separate windshield");

  const rg = modelEquipmentPrior("Road Glide Special");
  assert.equal(rg.fairing, "expected", "Road Glide expects a fairing");
  assert.equal(rg.fairingType, "sharknose", "Road Glide fairing is sharknose (frame-mounted)");
  assert.equal(rg.windshield, "unexpected", "Road Glide does NOT expect a separate windshield");

  const rk = modelEquipmentPrior("Road King");
  assert.equal(rk.windshield, "expected", "Road King is a separate-windshield model");
  assert.equal(rk.fairing, "unexpected", "Road King has no fixed fairing");

  const unknown = modelEquipmentPrior("Fat Boy");
  assert.equal(unknown.fairing, "unknown", "a cruiser has no fairing/windshield prior");
  assert.equal(unknown.windshield, "unknown", "a cruiser has no fairing/windshield prior");

  const blank = modelEquipmentPrior("");
  assert.equal(blank.fairing, "unknown", "no label → prior infers nothing");
}

// Prior reconcile: a Road Glide (fairing model) whose vision misreads a WINDSHIELD
// gets that windshield penalized below the assertion floor (the wrong-match trap).
{
  const rgPrior = modelEquipmentPrior("Road Glide");
  const misread = desc({ windshield: feat(true, 0.9), fairing: { present: false, confidence: 0.2, fairingType: "unknown" } });
  const rec = reconcileEquipmentWithPrior(misread, rgPrior);
  assert.equal(rec.agreement, "disagree", "fairing model reading a windshield disagrees with the prior");
  assert.ok(rec.windshield.confidence < EQUIPMENT_ASSERTION_CONFIDENCE_MIN, "misread windshield is knocked below the floor");

  // And when vision agrees with the prior (sees the fairing), nothing is penalized.
  const agree = desc({ fairing: { present: true, confidence: 0.9, fairingType: "sharknose" } });
  const rec2 = reconcileEquipmentWithPrior(agree, rgPrior);
  assert.equal(rec2.agreement, "agree", "fairing model + vision sees the fairing => agree");
  assert.equal(rec2.fairing.confidence, 0.9, "an agreeing fairing read is not penalized");
}

// Mutual exclusivity (the row-15 batwing-over-detection fix): a WINDSHIELD-model
// (Heritage Classic) where vision wrongly reported BOTH a windshield AND a batwing
// fairing. The contradicting fairing must be penalized below the floor even though a
// windshield was also seen — a bike's front is a windshield OR a fairing, never both.
{
  const heritagePrior = modelEquipmentPrior("Heritage Classic");
  assert.equal(heritagePrior.windshield, "expected", "Heritage Classic is a separate-windshield model");
  assert.equal(heritagePrior.fairing, "unexpected", "Heritage Classic does NOT expect a fixed fairing");
  const bothSeen = desc({
    windshield: feat(true, 0.95),
    fairing: { present: true, confidence: 0.9, fairingType: "batwing" }
  });
  const rec = reconcileEquipmentWithPrior(bothSeen, heritagePrior);
  assert.ok(rec.windshield.confidence >= EQUIPMENT_ASSERTION_CONFIDENCE_MIN, "the real windshield stays asserted");
  assert.ok(
    rec.fairing.confidence < EQUIPMENT_ASSERTION_CONFIDENCE_MIN,
    "the contradicting batwing on a windshield-model is knocked below the floor (row-15 fix)"
  );
  assert.equal(rec.agreement, "agree", "windshield model + a real windshield => agree (with the fairing lowered)");

  // No-prior mutual exclusivity: a cruiser with no prior where vision saw both — the
  // weaker of the two is penalized so they can't both be asserted.
  const noPrior = modelEquipmentPrior("Fat Boy");
  const bothNoPrior = desc({
    windshield: feat(true, 0.92),
    fairing: { present: true, confidence: 0.78, fairingType: "batwing" }
  });
  const recNp = reconcileEquipmentWithPrior(bothNoPrior, noPrior);
  assert.ok(recNp.windshield.confidence >= EQUIPMENT_ASSERTION_CONFIDENCE_MIN, "no-prior: the stronger windshield stays");
  assert.ok(recNp.fairing.confidence < EQUIPMENT_ASSERTION_CONFIDENCE_MIN, "no-prior: the weaker fairing is penalized (mutual exclusivity)");
}

// Joe's ruling (2026-07-25): ONLY big touring fairings count as "has_fairing". A Low Rider S/ST
// has a small quarter/sport fairing that must NOT register — the model prior marks it
// fairing:unexpected and a big-fairing vision read is penalized below the assertion floor.
{
  const lrs = modelEquipmentPrior("Low Rider S");
  assert.equal(lrs.fairing, "unexpected", "Low Rider S: a big touring fairing is not expected");
  assert.equal(lrs.windshield, "unknown", "Low Rider S: windshield stays unknown (could be an aftermarket shield)");
  const lrst = modelEquipmentPrior("Low Rider ST");
  assert.equal(lrst.fairing, "unexpected", "Low Rider ST sport fairing is not a big touring fairing (Joe: only big touring counts)");

  // Vision (wrongly, per the ruling) called the Low Rider S shroud a fairing → penalized below the floor.
  const lrsRead = desc({ fairing: { present: true, confidence: 0.95, fairingType: "unknown" } });
  const rec = reconcileEquipmentWithPrior(lrsRead, lrs);
  assert.equal(rec.agreement, "disagree", "a big-fairing read on a Low Rider disagrees with the prior");
  assert.ok(rec.fairing.confidence < EQUIPMENT_ASSERTION_CONFIDENCE_MIN, "the small-fairing read is knocked below the floor");

  const lrsProfile = buildEquipmentProfile({
    item: { stockId: "TEST-LRS", vin: null, model: "Low Rider S", year: "2023", condition: "used", images: ["x.jpg"] },
    desc: lrsRead,
    imageHash: "hash-lrs",
    imageCount: 1
  });
  assert.equal(lrsProfile.features.fairing.asserted, false, "the Low Rider S does NOT assert a fairing (only big touring fairings count)");
}

// ===========================================================================
// (a) windshield ≠ fairing  +  (b) below-threshold governance
// ===========================================================================

// A Street Glide where vision (wrongly) flagged BOTH a windshield and the fairing,
// plus real hard bags. The fairing is asserted, so a "bags + windshield" search must
// EXCLUDE it — a fairing bike is not a windshield match.
const streetGlide = buildEquipmentProfile({
  item: { stockId: "TEST-SG", vin: null, model: "Street Glide", year: "2022", condition: "used", images: ["a.jpg", "b.jpg"] },
  desc: desc({
    bags: { present: true, confidence: 0.92, bagType: "hard" },
    windshield: feat(true, 0.85),
    fairing: { present: true, confidence: 0.95, fairingType: "batwing" }
  }),
  imageHash: "hash-sg",
  imageCount: 2
});
assert.ok(streetGlide.features.fairing.asserted, "the Street Glide fairing is asserted");
assert.ok(streetGlide.features.bags.asserted, "the Street Glide bags are asserted");
assert.equal(
  matchesEquipmentQuery(streetGlide, { bags: true, windshield: true }),
  false,
  "windshield ≠ fairing: a fairing unit is EXCLUDED from a bags+windshield search"
);
assert.equal(matchesEquipmentQuery(streetGlide, { bags: true, fairing: true }), true, "it DOES match a bags+fairing search");

// A real bagger with a genuine separate windshield (bare Softail + aftermarket shield),
// no fairing → this is the correct bags+windshield match.
const softailWithShield = buildEquipmentProfile({
  item: { stockId: "TEST-ST", vin: null, model: "Softail Slim", year: "2019", condition: "used", images: ["c.jpg"] },
  desc: desc({
    bags: { present: true, confidence: 0.9, bagType: "leather" },
    windshield: feat(true, 0.88),
    fairing: { present: false, confidence: 0.1, fairingType: "unknown" }
  }),
  imageHash: "hash-st",
  imageCount: 1
});
assert.equal(matchesEquipmentQuery(softailWithShield, { bags: true, windshield: true }), true, "a true windshield bagger matches");
assert.equal(softailWithShield.bagType, "leather", "asserted bag type is surfaced");

// Below-threshold governance: a low-confidence windshield read (bad angle) is NOT
// asserted → it fails safe out of a windshield search.
const shakyShield = buildEquipmentProfile({
  item: { stockId: "TEST-LOW", vin: null, model: "Heritage Classic", year: "2020", condition: "used", images: ["d.jpg"] },
  desc: desc({
    bags: { present: true, confidence: 0.9, bagType: "hard" },
    windshield: feat(true, 0.55) // present, but not confident enough
  }),
  imageHash: "hash-low",
  imageCount: 1
});
assert.equal(shakyShield.features.windshield.detected, true, "vision still records the raw detection");
assert.equal(shakyShield.features.windshield.asserted, false, "a 0.55 windshield is NOT asserted (fail-safe)");
assert.equal(matchesEquipmentQuery(shakyShield, { windshield: true }), false, "a below-threshold windshield does not match");
assert.equal(matchesEquipmentQuery(shakyShield, { bags: true }), true, "the confident bags still match");

// ===========================================================================
// (d) schema / shape + cache keying
// ===========================================================================
{
  // Every taxonomy key exists on the profile with the governed sub-shape.
  for (const key of EQUIPMENT_FEATURE_KEYS) {
    const f = streetGlide.features[key];
    assert.ok(f && typeof f.asserted === "boolean" && typeof f.detected === "boolean" && typeof f.confidence === "number", `feature ${key} has the governed shape`);
  }
  // Profile is JSON-serializable (it is persisted to the cache file).
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(streetGlide)), "profile round-trips through JSON");

  // Image-set hash is order-independent and set-sensitive.
  assert.equal(imageSetHash(["x.jpg", "y.jpg"]), imageSetHash(["y.jpg", "x.jpg"]), "hash is order-independent");
  assert.notEqual(imageSetHash(["x.jpg"]), imageSetHash(["x.jpg", "y.jpg"]), "adding a photo changes the hash (vision re-runs)");
  assert.equal(imageSetHash([]), imageSetHash(undefined), "empty and missing image sets hash alike");

  // Cache key = id + image-set hash, so a re-photographed unit gets a fresh key.
  const k1 = equipmentCacheKey({ stockId: "U100", vin: null, images: ["1.jpg"] });
  const k2 = equipmentCacheKey({ stockId: "U100", vin: null, images: ["1.jpg", "2.jpg"] });
  assert.notEqual(k1, k2, "a changed photo set => a new cache key (vision re-runs only on photo change)");
  assert.equal(k1, equipmentCacheKey({ stockId: "u100", vin: null, images: ["1.jpg"] }), "cache key is case-insensitive on id");
  assert.ok(equipmentCacheKey({ stockId: null, vin: "VIN9", images: [] }).startsWith("vin9::"), "falls back to VIN when no stockId");

  // A non-motorcycle vision read asserts nothing.
  const notABike = buildEquipmentProfile({
    item: { stockId: "TEST-NB", vin: null, model: "Street Glide", year: "2022", condition: "used", images: ["e.jpg"] },
    desc: desc({ isMotorcycle: false }),
    imageHash: "hash-nb",
    imageCount: 1
  });
  assert.equal(EQUIPMENT_FEATURE_KEYS.every(k => !notABike.features[k].asserted), true, "a non-bike photo asserts no equipment");
}

console.log("inventory_equipment_vision:eval PASS");
