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
import { promises as fsp } from "node:fs";
import path from "node:path";

process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "eval-no-live-key";

import {
  EQUIPMENT_ASSERTION_CONFIDENCE_MIN,
  EQUIPMENT_FEATURE_KEYS,
  buildEquipmentProfile,
  equipmentCacheKey,
  imageSetHash,
  matchesEquipmentQuery,
  modelEquipmentPrior,
  reconcileEquipmentWithPrior,
  // Phase B (canary): equipment SEARCH filter + fail-safe classification.
  classifyUnitForEquipmentQuery,
  partitionInventoryByEquipment,
  describeEquipmentQuery,
  equipmentQueryHasFeatures,
  type EquipmentProfile
} from "../services/api/src/domain/inventoryEquipmentVision.ts";
import { buildEquipmentRecommendationReply, selectEligibleInventory } from "../services/api/src/domain/inventoryRecommender.ts";
import { normalizeRequestedEquipment } from "../services/api/src/domain/llmDraft.ts";
import type { VehicleEquipmentDescription } from "../services/api/src/domain/llmDraft.ts";
import { checkMessage } from "./voice_charter_audit.ts";

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

// ===========================================================================
// PHASE B (canary, INVENTORY_EQUIPMENT_VISION_ENABLED off) — equipment SEARCH
// filter + fail-safe replies + both-paths wiring. The comprehension parser is
// env-gated off in ci (house style — see vehicle_recommendation:eval); we pin the
// parse SHAPE deterministically (normalizeRequestedEquipment) and the windshield≠
// fairing comprehension rule via a source guard on the parser few-shots, and we
// pin the governance-critical behavior deterministically at the filter + reply.
// ===========================================================================

// --- (e) requested-equipment parse shape. The normalizer maps snake→camel, keeps
//         only the TRUE keys, and NEVER invents fairing from a windshield ask (Joe). ---
{
  const q = normalizeRequestedEquipment({
    bags: true,
    windshield: true,
    fairing: false,
    backrest_sissybar: false,
    tourpak: false,
    forward_controls: false,
    ape_hangers: false,
    floorboards: false,
    crash_bars: false
  });
  assert.deepEqual(q, { bags: true, windshield: true }, "a bags+windshield ask maps to exactly those two keys");
  assert.equal((q as any).fairing, undefined, "a windshield ask NEVER sets fairing (Joe's ruling at the parse level)");
  assert.equal((q as any).windshield, true, "windshield is preserved as its own key");

  // The parse keys are the SAME set as the vision taxonomy (single source of truth).
  const full = normalizeRequestedEquipment(
    Object.fromEntries(
      ["bags", "windshield", "fairing", "backrest_sissybar", "tourpak", "forward_controls", "ape_hangers", "floorboards", "crash_bars"].map(k => [k, true])
    )
  );
  assert.equal(Object.keys(full).length, EQUIPMENT_FEATURE_KEYS.length, "every taxonomy feature is a requestable key");
  for (const k of EQUIPMENT_FEATURE_KEYS) assert.equal((full as any)[k], true, `requested key ${k} maps through`);

  assert.deepEqual(normalizeRequestedEquipment({}), {}, "no features asked => empty query");
  assert.deepEqual(normalizeRequestedEquipment(null), {}, "junk input => empty query (no throw)");
  assert.equal(equipmentQueryHasFeatures({ bags: true }), true, "hasFeatures true when a key is set");
  assert.equal(equipmentQueryHasFeatures({}), false, "hasFeatures false on empty query");
}

// --- (f) per-unit fail-safe classification. The three reused profiles from above:
//         streetGlide (fairing+bags asserted), softailWithShield (bags+windshield, no
//         fairing), shakyShield (bags asserted, 0.55 windshield NOT asserted). ---
{
  const wsQuery = { bags: true, windshield: true };

  // Joe's ruling: a fairing bike is EXCLUDED from a windshield search (confident non-match).
  assert.equal(
    classifyUnitForEquipmentQuery(streetGlide, wsQuery),
    "excluded",
    "a fairing unit is EXCLUDED from a bags+windshield search (windshield≠fairing)"
  );

  // A true windshield bagger with no fairing is a confident ASSERTED match.
  assert.equal(
    classifyUnitForEquipmentQuery(softailWithShield, wsQuery),
    "asserted",
    "a genuine bags+windshield bagger is asserted"
  );

  // A below-threshold windshield read (bad angle) is UNCERTAIN — never a false yes, never wrongly excluded.
  assert.equal(
    classifyUnitForEquipmentQuery(shakyShield, wsQuery),
    "uncertain",
    "a shaky windshield read is uncertain (fail toward confirm), not asserted and not excluded"
  );

  // NO PROFILE YET → uncertain: an unprofiled unit is never falsely asserted, never silently dropped.
  assert.equal(
    classifyUnitForEquipmentQuery(null, wsQuery),
    "uncertain",
    "an unprofiled unit is uncertain (fail toward confirm), never asserted"
  );

  // CONFIDENTLY ABSENT: vision confidently saw NO bags → the unit is excluded from a bags search.
  const noBags = buildEquipmentProfile({
    item: { stockId: "TEST-NOBAGS", vin: null, model: "Iron 883", year: "2020", condition: "used", images: ["z.jpg"] },
    desc: desc({ bags: { present: false, confidence: 0.95, bagType: "unknown" } }),
    imageHash: "hash-nobags",
    imageCount: 1
  });
  assert.equal(
    classifyUnitForEquipmentQuery(noBags, { bags: true }),
    "excluded",
    "a unit vision is confident has NO bags is excluded from a bags search"
  );
}

// --- (g) partition = the three buckets, and the fail-safe REPLY copy. ---
{
  const wsQuery = { bags: true, windshield: true };
  type U = { model: string; year: string; price: number };
  const asItem = (model: string, price: number): U => ({ model, year: "2021", price });

  const parts = partitionInventoryByEquipment<U>(
    [
      { item: asItem("Road King", 18995), profile: softailWithShieldFor("Road King") }, // asserted
      { item: asItem("Street Glide", 21995), profile: streetGlide }, // excluded (fairing)
      { item: asItem("Street Bob", 12995), profile: null } // uncertain (unprofiled)
    ],
    wsQuery
  );
  assert.deepEqual(parts.asserted.map(u => u.model), ["Road King"], "asserted bucket = the confident match");
  assert.deepEqual(parts.excluded.map(u => u.model), ["Street Glide"], "excluded bucket = the fairing bike");
  assert.deepEqual(parts.uncertain.map(u => u.model), ["Street Bob"], "uncertain bucket = the unprofiled unit");

  // Phrase helper.
  assert.equal(describeEquipmentQuery(wsQuery), "bags and a windshield", "two-feature phrase");
  assert.equal(describeEquipmentQuery({ bags: true }), "bags", "one-feature phrase");
  assert.equal(
    describeEquipmentQuery({ bags: true, windshield: true, floorboards: true }),
    "bags, a windshield, and floorboards",
    "three-feature phrase (oxford)"
  );

  // ASSERTED reply presents units factually.
  const assertedReply = buildEquipmentRecommendationReply({
    firstName: "Jordan",
    equipmentPhrase: "bags and a windshield",
    asserted: [{ model: "Road King", year: "2021", price: 18995 } as any],
    uncertain: []
  });
  assert.ok(assertedReply, "asserted reply is produced");
  assert.ok(/with bags and a windshield/i.test(assertedReply!), "asserted reply names the equipment as present");

  // UNCERTAIN-ONLY reply HEDGES — never a definite "has X"; offers to confirm before the trip.
  const uncertainReply = buildEquipmentRecommendationReply({
    firstName: "Jordan",
    equipmentPhrase: "bags and a windshield",
    asserted: [],
    uncertain: [{ model: "Street Bob", year: "2021", price: 12995 } as any]
  });
  assert.ok(uncertainReply, "uncertain reply is produced");
  assert.ok(/look like/i.test(uncertainReply!), "uncertain reply HEDGES with 'look like' (never a false yes)");
  assert.ok(/confirm|double-?check/i.test(uncertainReply!), "uncertain reply offers to confirm before the customer comes out");
  assert.ok(
    !/\bhas bags\b|\bhas a windshield\b|\bcomes with\b/i.test(uncertainReply!),
    "uncertain reply never asserts the feature as a definite fact"
  );

  // Nothing to present → null (caller commits to follow-up instead of listing non-matching bikes).
  assert.equal(
    buildEquipmentRecommendationReply({ firstName: "Jordan", equipmentPhrase: "bags and a windshield", asserted: [], uncertain: [] }),
    null,
    "no asserted and no uncertain units => null (caller follows up; never lists random bikes)"
  );

  // Both replies pass the voice charter (em-dash cap, no banned phrases).
  for (const r of [assertedReply!, uncertainReply!]) {
    const violations = checkMessage(r, { firstOutbound: false, smsLike: true, staffHasSent: false });
    assert.deepEqual(violations, [], `equipment reply must be charter-clean: "${r}"`);
  }
}

// helper: a bags+windshield-asserting profile for an arbitrary (windshield) model.
function softailWithShieldFor(model: string): EquipmentProfile {
  return buildEquipmentProfile({
    item: { stockId: `TEST-${model}`, vin: null, model, year: "2021", condition: "used", images: ["q.jpg"] },
    desc: desc({
      bags: { present: true, confidence: 0.9, bagType: "hard" },
      windshield: feat(true, 0.9),
      fairing: { present: false, confidence: 0.1, fairingType: "unknown" }
    }),
    imageHash: `hash-${model}`,
    imageCount: 1
  });
}

// --- (h) eligible-pool selection keeps the per-UNIT pool (no one-per-model dedupe)
//         so two same-model units, one equipped and one not, are both reachable. ---
{
  const feedPool = [
    { model: "Street Bob", year: "2021", price: 12995, condition: "used" },
    { model: "Street Bob", year: "2020", price: 11995, condition: "used" }, // same model, cheaper
    { model: "Road King", year: "2019", price: 15995, condition: "used" }
  ] as any[];
  const pool = selectEligibleInventory(feedPool, { condition: "used" });
  assert.equal(pool.length, 3, "eligible pool keeps EVERY priced unit (no one-per-model cap for equipment)");
  assert.equal(pool[0].price, 11995, "eligible pool is price-sorted ascending");
}

// ===========================================================================
// (i) Both-paths + governance SOURCE GUARDS (route-parity law; flag-off canary).
// ===========================================================================
{
  const repoRoot = path.resolve(new URL("..", import.meta.url).pathname);
  const indexSrc = await fsp.readFile(path.join(repoRoot, "services/api/src/index.ts"), "utf8");
  const llmSrc = await fsp.readFile(path.join(repoRoot, "services/api/src/domain/llmDraft.ts"), "utf8");

  // The equipment filter runs INSIDE the shared recommendation resolver → live + regen share it.
  assert.ok(
    /resolveEquipmentRecommendationReply/.test(indexSrc),
    "index.ts defines/calls the shared equipment resolver"
  );
  assert.ok(
    /inventoryEquipmentVisionEnabled\(\)\s*&&\s*equipmentQueryHasFeatures/.test(indexSrc),
    "the equipment path is gated behind the flag (canary, off) + a real feature query"
  );
  // The shared resolver is the ONLY caller-facing recommendation entry, invoked from BOTH paths.
  const sharedCalls = (indexSrc.match(/resolveVehicleRecommendationReply\(/g) ?? []).length;
  assert.ok(sharedCalls >= 3, "resolveVehicleRecommendationReply is defined + called from both live and regen (>=3 refs)");

  // The parser carries the requested_equipment slot + the windshield≠fairing comprehension rule.
  assert.ok(/requested_equipment/.test(llmSrc), "the recommendation parser schema has a requested_equipment slot");
  assert.ok(
    /a WINDSHIELD is NOT a FAIRING/i.test(llmSrc),
    "the parser prompt spells out the windshield≠fairing ruling"
  );
  assert.ok(
    /"requested_equipment":\{"bags":true,"windshield":true\}/.test(llmSrc),
    "a bags+windshield few-shot pins the parse (windshield set, fairing NOT)"
  );
}

console.log("inventory_equipment_vision:eval PASS");
