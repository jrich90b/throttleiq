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
  // Equipment WATCHES + profile-on-arrival (this PR).
  watchEquipmentFireGate,
  profileArrivedUnitsForEquipment,
  type EquipmentProfile,
  type EquipmentCacheFile
} from "../services/api/src/domain/inventoryEquipmentVision.ts";
import { buildEquipmentRecommendationReply, buildEquipmentClarifyReply, selectEligibleInventory, classifyHarleySegment } from "../services/api/src/domain/inventoryRecommender.ts";
import { decideEquipmentClarifyTurn } from "../services/api/src/domain/routeStateReducer.ts";
import { normalizeRequestedEquipment } from "../services/api/src/domain/llmDraft.ts";
import type { VehicleEquipmentDescription } from "../services/api/src/domain/llmDraft.ts";
import { checkMessage } from "./voice_charter_audit.ts";

// Confidence floor is the documented default.
assert.equal(EQUIPMENT_ASSERTION_CONFIDENCE_MIN, 0.7, "assertion floor mirrors VISION_CONFIDENCE_MIN default (0.7)");
// 9 equipment/accessory features + 7 cholo-BUILD cues (whitewalls, fatSpokeWheels, fishtailExhaust,
// soloSeat, heavyChrome, lowStance, blackedOut) = 16. apeHangers is shared (an equipment feature reused
// as a cholo cue). blackedOut is the cholo DISQUALIFIER read (added 7/26 in the recalibration).
assert.equal(EQUIPMENT_FEATURE_KEYS.length, 16, "9 equipment features + 7 cholo-build cues = 16");

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
    whitewalls: feat(false, 0),
    fatSpokeWheels: feat(false, 0),
    fishtailExhaust: feat(false, 0),
    soloSeat: feat(false, 0),
    heavyChrome: feat(false, 0),
    lowStance: feat(false, 0),
    blackedOut: feat(false, 0),
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

  // The 9 shoppable EQUIPMENT features are a SUBSET of the vision taxonomy (which also carries the 7
  // vision-only cholo BUILD cues — those are never requestable via an equipment query). Every requestable
  // key must be a real taxonomy feature, and all 9 shoppable ones map through.
  const REQUESTABLE_EQUIPMENT_KEYS = [
    "bags",
    "windshield",
    "fairing",
    "backrestSissybar",
    "tourpak",
    "forwardControls",
    "apeHangers",
    "floorboards",
    "crashBars"
  ] as const;
  const full = normalizeRequestedEquipment(
    Object.fromEntries(
      ["bags", "windshield", "fairing", "backrest_sissybar", "tourpak", "forward_controls", "ape_hangers", "floorboards", "crash_bars"].map(k => [k, true])
    )
  );
  assert.equal(Object.keys(full).length, REQUESTABLE_EQUIPMENT_KEYS.length, "all 9 shoppable equipment features are requestable keys");
  for (const k of REQUESTABLE_EQUIPMENT_KEYS) {
    assert.equal((full as any)[k], true, `requested key ${k} maps through`);
    assert.ok((EQUIPMENT_FEATURE_KEYS as readonly string[]).includes(k), `requestable key ${k} is a real taxonomy feature`);
  }

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

// ===========================================================================
// EQUIPMENT WATCHES + PROFILE-ON-ARRIVAL (this PR). The equipment filter is an
// ADDITIONAL fire criterion that COMPOSES (ANDs) with the model/segment/year/
// condition criteria the watch already carries. All deterministic (no LLM/IO).
// ===========================================================================

// --- (j) the watch FIRE gate. ASSERTED equipment fires; a fairing bike is excluded from a
//         windshield ask; a shaky/unprofiled unit does NOT fire (fail-safe); and — the critical
//         regression — a MODEL-ONLY watch (no requestedEquipment) is a NO-OP and fires exactly as today. ---
{
  const wsQuery = { bags: true, windshield: true };

  // A genuine bags+windshield bagger (no fairing) → the equipment watch FIRES.
  assert.equal(watchEquipmentFireGate(softailWithShield, wsQuery), true, "asserted bags+windshield unit fires the equipment watch");

  // windshield≠fairing: an arriving fairing bike does NOT fire a bags+windshield equipment watch.
  assert.equal(watchEquipmentFireGate(streetGlide, wsQuery), false, "a fairing bike does NOT fire a bags+windshield watch (windshield≠fairing)");

  // FAIL-SAFE: a below-threshold read is not asserted → no fire (never a false 'your bike came in').
  assert.equal(watchEquipmentFireGate(shakyShield, { windshield: true }), false, "a shaky/below-threshold read does NOT fire (fail-safe)");

  // FAIL-SAFE: an UNPROFILED arrival (no cached profile yet) does NOT fire an equipment watch.
  assert.equal(watchEquipmentFireGate(null, wsQuery), false, "an unprofiled arrival does NOT fire an equipment watch (fail-safe)");
  assert.equal(watchEquipmentFireGate(undefined, { bags: true }), false, "a missing profile does NOT fire (fail-safe)");

  // MODEL-ONLY WATCH UNCHANGED (regression pin): no requestedEquipment → the gate is a pure no-op,
  // so the unit fires on the model criteria alone exactly as a plain watch does today — REGARDLESS of
  // whatever the unit's equipment profile looks like (or whether it even has one).
  assert.equal(watchEquipmentFireGate(streetGlide, undefined), true, "model-only watch (no equipment) fires unchanged — even on a fairing bike");
  assert.equal(watchEquipmentFireGate(null, undefined), true, "model-only watch fires unchanged even with no profile at all");
  assert.equal(watchEquipmentFireGate(softailWithShield, {}), true, "an empty equipment query is a no-op (model-only behavior)");

  // Partial asserted: a bags-only ask on the bagger fires; a bags-only ask on a confidently-no-bags unit does not.
  assert.equal(watchEquipmentFireGate(softailWithShield, { bags: true }), true, "bags-only ask fires on a unit with asserted bags");
}

// --- (k) COMPOSE: a compound "cruiser with bags and a windshield" narrows by SEGMENT first
//         (selectEligibleInventory), THEN filters by equipment — and the fairing bike is excluded at
//         BOTH layers. Pins that equipment is an additional filter, never an equipment-only modality. ---
{
  // Segment classification underpins the narrow: Street Glide is TOURING, not a cruiser.
  assert.equal(classifyHarleySegment("Fat Boy"), "cruiser", "Fat Boy classifies as a cruiser");
  assert.equal(classifyHarleySegment("Street Bob"), "cruiser", "Street Bob classifies as a cruiser");
  assert.equal(classifyHarleySegment("Street Glide"), "touring", "Street Glide classifies as touring (fairing bagger)");

  const feed = [
    { model: "Fat Boy", year: "2021", price: 18995, condition: "used" },
    { model: "Street Bob", year: "2020", price: 13995, condition: "used" },
    { model: "Street Glide", year: "2022", price: 24995, condition: "used" } // touring — dropped by the cruiser narrow
  ] as any[];

  // LAYER 1 — SEGMENT NARROW: only cruisers survive (the touring Street Glide is dropped).
  const narrowed = selectEligibleInventory(feed, { includeSegments: ["cruiser"] });
  assert.deepEqual(narrowed.map(u => u.model).sort(), ["Fat Boy", "Street Bob"], "segment narrows to cruisers only (fairing bagger dropped)");

  // LAYER 2 — EQUIPMENT FILTER over the narrowed pool: Fat Boy asserts bags+windshield, Street Bob unprofiled.
  const fatBoyProfile = softailWithShieldFor("Fat Boy"); // bags+windshield asserted, no fairing
  const parts = partitionInventoryByEquipment(
    narrowed.map(u => ({ item: u, profile: u.model === "Fat Boy" ? fatBoyProfile : null })),
    { bags: true, windshield: true }
  );
  assert.deepEqual(parts.asserted.map(u => u.model), ["Fat Boy"], "compose: cruiser + asserted bags+windshield surfaces the Fat Boy");
  assert.deepEqual(parts.uncertain.map(u => u.model), ["Street Bob"], "compose: an unprofiled cruiser is uncertain (confirm), never dropped");
  assert.equal(parts.excluded.length, 0, "compose: nothing wrongly excluded in the narrowed cruiser pool");

  // And a fairing bike that (hypothetically) reached the equipment layer is still excluded there too.
  const withFairing = partitionInventoryByEquipment([{ item: { model: "Street Glide" }, profile: streetGlide }], { bags: true, windshield: true });
  assert.deepEqual(withFairing.excluded.map((u: any) => u.model), ["Street Glide"], "a fairing bike is excluded at the equipment layer as well (belt + suspenders)");
}

// --- (l) PROFILE-ON-ARRIVAL only touches NEW stockIds and is bounded. With a fully-populated cache
//         it runs ZERO vision (cache hits are free); a photoless unit is skipped. (The new-vision path
//         needs an LLM, so it is exercised live, not here — we pin the no-vision governance.) ---
{
  const arrival = { stockId: "ARR-1", vin: null, model: "Road King", year: "2021", condition: "used", images: ["ph1.jpg", "ph2.jpg"] } as any;
  const noPhotos = { stockId: "ARR-2", vin: null, model: "Softail Slim", year: "2020", condition: "used", images: [] as string[] } as any;

  // Pre-populate the cache for the photographed arrival → it is already profiled (a "new stockId" only
  // runs vision on a genuine cache MISS).
  const cache: EquipmentCacheFile = {
    version: 1,
    profiles: { [equipmentCacheKey(arrival)]: softailWithShieldFor("Road King") }
  };
  const stats = await profileArrivedUnitsForEquipment([arrival, noPhotos], cache, { runCap: 8 });
  assert.equal(stats.visionRuns, 0, "profile-on-arrival runs NO vision when the arrival is already cached (touches new stockIds only)");
  assert.equal(stats.cacheHits, 1, "the already-profiled arrival is a free cache hit");
  assert.equal(stats.skippedNoPhotos, 1, "a photoless unit is skipped (nothing to profile)");
  assert.equal(stats.capped, false, "under the run cap → not capped");

  // A zero run-cap makes an uncached arrival immediately 'capped' WITHOUT running vision (hard cost bound).
  const emptyCache: EquipmentCacheFile = { version: 1, profiles: {} };
  const capped = await profileArrivedUnitsForEquipment([arrival], emptyCache, { runCap: 0 });
  assert.equal(capped.visionRuns, 0, "runCap 0 → no vision runs (bounded)");
  assert.equal(capped.capped, true, "runCap 0 → the uncached arrival is reported capped, not silently profiled");
}

// --- (m) WATCH wiring SOURCE GUARDS: the equipment gate is applied in BOTH fire paths (cron sweep +
//         hold-release) after inventoryItemMatchesWatch; profile-on-arrival is flag-gated; creation
//         attaches requestedEquipment via the shared builder; the type carries the optional field. ---
{
  const repoRoot = path.resolve(new URL("..", import.meta.url).pathname);
  const indexSrc = await fsp.readFile(path.join(repoRoot, "services/api/src/index.ts"), "utf8");
  const storeSrc = await fsp.readFile(path.join(repoRoot, "services/api/src/domain/conversationStore.ts"), "utf8");

  // The InventoryWatch type carries the OPTIONAL equipment filter.
  assert.ok(/requestedEquipment\?:/.test(storeSrc), "InventoryWatch has the optional requestedEquipment field");

  // The sync gate is DEFINED and applied in BOTH fire paths (>=3 refs: def + cron + hold-release).
  const gateRefs = (indexSrc.match(/watchPassesEquipmentGate\(/g) ?? []).length;
  assert.ok(gateRefs >= 3, "watchPassesEquipmentGate is defined and applied in BOTH fire paths (cron + hold-release)");

  // The gate is ANDed AFTER the base model match, never a replacement.
  assert.ok(
    /if \(!inventoryItemMatchesWatch\(i, watch\)\) return false;[\s\S]{0,260}watchPassesEquipmentGate\(i, watch, equipmentCache\)/.test(indexSrc),
    "cron: equipment gate runs AFTER inventoryItemMatchesWatch (ANDed, not a replacement)"
  );
  assert.ok(
    /if \(!inventoryItemMatchesWatch\(matchedItem, watch\)\) return false;[\s\S]{0,260}watchPassesEquipmentGate\(matchedItem, watch, equipmentCache\)/.test(indexSrc),
    "hold-release: equipment gate runs AFTER inventoryItemMatchesWatch (ANDed, not a replacement)"
  );

  // Profile-on-arrival is flag-gated and bounded to arrivals (not a whole-lot job).
  assert.ok(
    /inventoryEquipmentVisionEnabled\(\)[\s\S]{0,600}profileArrivedUnitsForEquipment\(/.test(indexSrc),
    "profile-on-arrival is invoked behind the flag in the arrival sweep"
  );

  // Creation attaches requestedEquipment via the shared deriveContextNoteWatches builder (both paths).
  assert.ok(/w\.requestedEquipment = eq/.test(indexSrc), "watch creation attaches the parsed requestedEquipment to the watch");
  // Equipment-watch creation stays flag-gated + hint-gated (the combined equipment+segment block).
  assert.ok(
    /if \(inventoryEquipmentVisionEnabled\(\)\) \{[\s\S]{0,400}const noteNamesEquipment = EQUIPMENT_WATCH_HINT_RE\.test\(note\);/.test(indexSrc),
    "creation is flag-gated and the equipment path is still hint-gated on EQUIPMENT_WATCH_HINT_RE (cost pre-filter)"
  );
  assert.ok(
    /const needParse =\s*\(watches\.length && noteNamesEquipment\)/.test(indexSrc),
    "the equipment attach still requires an anchored model watch + the equipment hint"
  );
}

// ===========================================================================
// SEGMENT-LEVEL equipment watches (THIS stacked PR). Joe's literal case: "let me know when a cruiser
// with bags and a windshield comes in." A SEGMENT is a broad code GROUP the glossary resolves — it
// NARROWS the lot rather than naming one bike. The model half of the fire test becomes SEGMENT
// MEMBERSHIP (classifyHarleySegment(unit.model) ∈ watch.segments); #292's watchEquipmentFireGate
// composes the equipment half unchanged. All deterministic (no LLM/IO).
// ===========================================================================

// A faithful, deterministic re-creation of the segment watch's fire DECISION using the exported
// primitives — the model half (segment membership) ANDed with #292's equipment gate. Mirrors the
// composition index.ts performs (inventoryItemMatchesSegmentWatch → inventoryItemPassesNonModelCriteria,
// then watchPassesEquipmentGate). Lets us pin the governance without exporting the server internals.
function segmentWatchFires(args: {
  segments: ("cruiser" | "touring" | "sport" | "adventure" | "trike")[];
  unitModel: string;
  requestedEquipment?: Record<string, boolean>;
  profile?: EquipmentProfile | null;
}): boolean {
  const seg = classifyHarleySegment(args.unitModel);
  // NARROW: an "unknown"-segment unit, or one outside the watched group, never fires.
  if (seg === "unknown" || !args.segments.includes(seg as any)) return false;
  // Equipment half: #292's gate (no-op when no equipment requested; fail-safe on unprofiled/below-thr).
  return watchEquipmentFireGate(args.profile ?? null, args.requestedEquipment ?? undefined);
}

// --- (n) SEGMENT MEMBERSHIP: a cruiser watch fires on a cruiser-group arrival, NOT on a touring one. ---
{
  // Bare segment watch (no equipment): a cruiser watch fires on any cruiser-group unit.
  assert.equal(
    segmentWatchFires({ segments: ["cruiser"], unitModel: "Fat Boy" }),
    true,
    "cruiser watch fires on a cruiser-group arrival (Fat Boy)"
  );
  assert.equal(
    segmentWatchFires({ segments: ["cruiser"], unitModel: "Street Bob" }),
    true,
    "cruiser watch fires on another cruiser-group arrival (Street Bob)"
  );
  // NARROW: a touring-group arrival does NOT fire a cruiser watch.
  assert.equal(
    segmentWatchFires({ segments: ["cruiser"], unitModel: "Street Glide" }),
    false,
    "cruiser watch does NOT fire on a touring-group arrival (Street Glide) — a segment never fires outside its group"
  );
  assert.equal(
    segmentWatchFires({ segments: ["cruiser"], unitModel: "Road King" }),
    false,
    "cruiser watch does NOT fire on a touring Road King"
  );
  // A multi-segment watch (cruiser OR touring) fires on either group but still not on sport.
  assert.equal(segmentWatchFires({ segments: ["cruiser", "touring"], unitModel: "Road King" }), true, "cruiser+touring watch fires on a touring unit");
  assert.equal(segmentWatchFires({ segments: ["cruiser", "touring"], unitModel: "Iron 883" }), false, "cruiser+touring watch does NOT fire on a sport unit");
  // A model the glossary can't place ("unknown") never fires (fail-safe narrow).
  assert.equal(segmentWatchFires({ segments: ["cruiser"], unitModel: "Zephyr 9000" }), false, "an unknown-segment unit never fires a segment watch");
}

// --- (o) COMPOUND: "cruiser with bags and a windshield" fires ONLY on a cruiser WITH asserted
//         bags+windshield, and excludes fairing bikes at BOTH the segment and equipment layers. ---
{
  const wsQuery = { bags: true, windshield: true };
  const cruiserBagged = softailWithShieldFor("Fat Boy"); // cruiser, bags+windshield asserted, no fairing

  // Fires: a cruiser whose profile asserts bags+windshield.
  assert.equal(
    segmentWatchFires({ segments: ["cruiser"], unitModel: "Fat Boy", requestedEquipment: wsQuery, profile: cruiserBagged }),
    true,
    "compound cruiser+bags+windshield FIRES on a cruiser with asserted bags+windshield"
  );
  // Excluded at the SEGMENT layer: a Street Glide is touring → out of the cruiser group (never reaches equipment).
  assert.equal(
    segmentWatchFires({ segments: ["cruiser"], unitModel: "Street Glide", requestedEquipment: wsQuery, profile: streetGlide }),
    false,
    "a fairing touring bike is excluded at the SEGMENT layer (not a cruiser)"
  );
  // Excluded at the EQUIPMENT layer: a cruiser whose FRONT reads as a fairing fails windshield≠fairing.
  const cruiserWithFairing = buildEquipmentProfile({
    item: { stockId: "CF-1", vin: null, model: "Fat Boy", year: "2021", condition: "used", images: ["x.jpg"] },
    desc: desc({ bags: feat(true, 0.95), fairing: feat(true, 0.95), windshield: feat(false, 0.9) }),
    imageHash: "cf",
    imageCount: 1
  });
  assert.equal(
    segmentWatchFires({ segments: ["cruiser"], unitModel: "Fat Boy", requestedEquipment: wsQuery, profile: cruiserWithFairing }),
    false,
    "a cruiser reading a FAIRING is excluded at the equipment layer (windshield≠fairing)"
  );
  // FAIL-SAFE: an unprofiled cruiser arrival does NOT fire the equipment-bearing segment watch.
  assert.equal(
    segmentWatchFires({ segments: ["cruiser"], unitModel: "Fat Boy", requestedEquipment: wsQuery, profile: null }),
    false,
    "an UNPROFILED cruiser arrival does NOT fire an equipment-bearing segment watch (fail-safe)"
  );
  // A BARE segment watch (no equipment) still fires on an unprofiled cruiser — the equipment gate is a no-op.
  assert.equal(
    segmentWatchFires({ segments: ["cruiser"], unitModel: "Fat Boy", profile: null }),
    true,
    "a bare (no-equipment) cruiser watch fires on a cruiser even with no equipment profile"
  );
}

// --- (p) WIRING SOURCE GUARDS: segment watches route through the SAME fire entry (so the daily cap +
//         dedup + opt-out that wrap it still apply), are flag-gated + NARROW, reuse the shared criteria,
//         leave MODEL/FAMILY watches untouched, and are minted by the shared creation builder. ---
{
  const repoRoot = path.resolve(new URL("..", import.meta.url).pathname);
  const indexSrc = await fsp.readFile(path.join(repoRoot, "services/api/src/index.ts"), "utf8");
  const storeSrc = await fsp.readFile(path.join(repoRoot, "services/api/src/domain/conversationStore.ts"), "utf8");

  // The InventoryWatch type carries the OPTIONAL segment target.
  assert.ok(/segments\?:\s*\("cruiser"/.test(storeSrc), "InventoryWatch has the optional segments target field");

  // The segment branch sits at the TOP of inventoryItemMatchesWatch (the SINGLE fire entry both paths
  // call) — so segment watches ride the SAME match loop, and the per-conversation DAILY CAP,
  // stockId dedup, opt-out and pause guards that wrap that loop apply unchanged. No separate send path.
  assert.ok(
    /function inventoryItemMatchesWatch\(item: any, watch: InventoryWatch\): boolean \{[\s\S]{0,900}?if \(watchIsSegmentWatch\(watch\)\) \{/.test(indexSrc),
    "segment watches route through inventoryItemMatchesWatch (the shared fire entry — daily cap/dedup/opt-out still wrap it)"
  );

  // FLAG-GATED: with the equipment-vision canary flag OFF a segment watch is INERT (returns false). A
  // cholo build segment additionally requires the cholo flag (dark until flipped) — an optional extra
  // guard line before the segment-matcher return.
  assert.ok(
    /if \(watchIsSegmentWatch\(watch\)\) \{\s*if \(!inventoryEquipmentVisionEnabled\(\)\) return false;[\s\S]{0,500}?return inventoryItemMatchesSegmentWatch\(item, watch\);/.test(indexSrc),
    "flag OFF → a segment watch is inert (never fires); flag ON → routed to the segment matcher"
  );

  // NARROW: the segment matcher fires only on IN-GROUP membership (classifyHarleySegment), never outside.
  assert.ok(
    /function inventoryItemMatchesSegmentWatch[\s\S]{0,700}classifyHarleySegment\(item\.model\)[\s\S]{0,200}if \(seg === "unknown" \|\| !segments\.includes\(seg\)\) return false;/.test(indexSrc),
    "segment matcher requires in-group membership (unknown / out-of-group → no fire — NARROW)"
  );

  // Reuses the EXACT shared non-model criteria (year/condition/price/color) — no drift from model watches.
  assert.ok(
    /function inventoryItemMatchesSegmentWatch[\s\S]{0,1000}return inventoryItemPassesNonModelCriteria\(item, watch\);/.test(indexSrc),
    "segment matcher reuses inventoryItemPassesNonModelCriteria (shared with model watches — no second copy)"
  );
  assert.ok(
    /if \(!directMatch && !familyMatch && !catalogCodeMatch\) return false;\s*\/\/[\s\S]{0,120}return inventoryItemPassesNonModelCriteria\(item, watch\);/.test(indexSrc),
    "model/family watches run the SAME extracted criteria after their (unchanged) model match — regression-safe"
  );

  // Creation mints a SEGMENT watch (flag+hint gated), reusing the parser's include_segments.
  assert.ok(/note: "context_note_segment_watch"/.test(indexSrc), "creation mints a segment watch record");
  assert.ok(/recParse\?\.includeSegments/.test(indexSrc), "the segment watch reuses the parser's include_segments (glossary layer — no regex over intent)");
  assert.ok(
    /const noteNamesSegment = SEGMENT_WATCH_HINT_RE\.test\(note\);/.test(indexSrc),
    "segment-watch creation is hint-gated (cost pre-filter) on SEGMENT_WATCH_HINT_RE"
  );
  // Precedence: a segment watch is only minted when NO concrete model watch already anchored the ask.
  assert.ok(
    /if \(!watches\.length && wantsWatchIntent\) \{[\s\S]{0,1500}formatSegmentWatchLabel\(segments\)/.test(indexSrc),
    "a segment watch is minted only when no concrete model watch anchored the ask (model watch wins)"
  );
}

// ===========================================================================
// UNDER-SPECIFIED EQUIPMENT ASK → CLARIFY (Joe, 2026-07-25). A PURE equipment ask with NO bike type
// ("something with bags and a windshield" — no model, family, or segment) should CLARIFY up to a
// style/type (ask cruiser vs bagger + new/used), NOT drop it, NOT mint a whole-inventory watch, and
// NOT run a whole-lot equipment vision search. The decision is a PURE reducer over parser slots
// (requested_equipment features + include_segments + named-model), NEVER a regex over intent. It
// sits inside the SHARED resolveVehicleRecommendationReply so live + regen behave identically.
// ===========================================================================

// --- (q) the CLARIFY decision fires ONLY when equipment is named with ZERO bike type. ---
{
  const on = { visionEnabled: true };

  // (a) equipment + NO bike type → CLARIFY (the under-specified case).
  assert.equal(
    decideEquipmentClarifyTurn({ ...on, hasEquipmentFeatures: true, hasSegment: false, hasModel: false, hasFamily: false }).kind,
    "clarify",
    "equipment named with no model/family/segment → clarify up to a style"
  );

  // (b) equipment + a SEGMENT ("a cruiser with bags") → NOT clarified; the anchored ask proceeds.
  assert.equal(
    decideEquipmentClarifyTurn({ ...on, hasEquipmentFeatures: true, hasSegment: true, hasModel: false, hasFamily: false }).kind,
    "none",
    "equipment + a style/segment ('a cruiser with bags') proceeds — never clarified (regression)"
  );

  // Governance: equipment + a MODEL or a FAMILY is also anchored → not clarified (proceeds to search/#292).
  assert.equal(
    decideEquipmentClarifyTurn({ ...on, hasEquipmentFeatures: true, hasSegment: false, hasModel: true, hasFamily: false }).kind,
    "none",
    "equipment + a named model ('a Road King with bags') proceeds — never clarified"
  );
  assert.equal(
    decideEquipmentClarifyTurn({ ...on, hasEquipmentFeatures: true, hasSegment: false, hasModel: false, hasFamily: true }).kind,
    "none",
    "equipment + a family ('a Softail with bags') proceeds — never clarified"
  );

  // (c) a bike type with NO equipment → untouched (the plain budget/style recommender owns it).
  assert.equal(
    decideEquipmentClarifyTurn({ ...on, hasEquipmentFeatures: false, hasSegment: true, hasModel: false, hasFamily: false }).kind,
    "none",
    "a bike type with no equipment is untouched by the clarify gate"
  );
  assert.equal(
    decideEquipmentClarifyTurn({ ...on, hasEquipmentFeatures: false, hasSegment: false, hasModel: false, hasFamily: false }).kind,
    "none",
    "no equipment and no type → nothing to clarify"
  );

  // (d) FLAG OFF → the clarify NEVER fires, even in the exact under-specified shape (today's behavior).
  assert.equal(
    decideEquipmentClarifyTurn({ visionEnabled: false, hasEquipmentFeatures: true, hasSegment: false, hasModel: false, hasFamily: false }).kind,
    "none",
    "flag off → clarify never fires (canary-gated, no change to current behavior)"
  );
}

// --- (r) the CLARIFY reply copy: asks for style + condition, charter-clean, fabricates nothing. ---
{
  const reply = buildEquipmentClarifyReply("Jordan");
  assert.ok(/style/i.test(reply), "clarify asks what STYLE/type of bike (narrows up to a segment)");
  assert.ok(/cruiser|bagger/i.test(reply), "clarify offers concrete plain-English style examples");
  assert.ok(/new or used|new vs used|new or pre-?owned/i.test(reply), "clarify also asks new vs used (turns it into a segment+condition request)");
  assert.ok(/\?/.test(reply), "clarify is phrased as a question (it asks, it does not answer)");
  // Never asserts a specific unit / equipment as present (nothing to fabricate — we're asking).
  assert.ok(
    !/here are|in stock|\bhas bags\b|\bhas a windshield\b|\bcomes with\b/i.test(reply),
    "clarify never lists inventory or asserts equipment (no fabrication)"
  );
  // Voice charter (texting a friend): no banned AI-tells, em-dash cap, no dropped verbs.
  for (const name of ["Jordan", null]) {
    const r = buildEquipmentClarifyReply(name);
    const violations = checkMessage(r, { firstOutbound: false, smsLike: true, staffHasSent: false });
    assert.deepEqual(violations, [], `clarify reply must be charter-clean: "${r}"`);
  }
}

// --- (s) WIRING SOURCE GUARDS: the clarify is centralized (decideEquipmentClarifyTurn), applied in
//         the SHARED resolver BEFORE the equipment search (so no whole-lot vision runs), and reads
//         parser slots (requested_equipment + include_segments), not a regex over intent. ---
{
  const repoRoot = path.resolve(new URL("..", import.meta.url).pathname);
  const indexSrc = await fsp.readFile(path.join(repoRoot, "services/api/src/index.ts"), "utf8");

  // The decision is the centralized reducer, computed inside the shared recommendation resolver.
  assert.ok(/decideEquipmentClarifyTurn\(/.test(indexSrc), "index.ts computes the centralized clarify decision");
  // It runs BEFORE resolveEquipmentRecommendationReply (the whole-lot equipment search) — an
  // under-specified ask returns the clarify and never reaches the search.
  assert.ok(
    /if \(clarifyDecision\.kind === "clarify"\) \{[\s\S]{0,260}return buildEquipmentClarifyReply\(firstName\);\s*\}\s*if \(inventoryEquipmentVisionEnabled\(\) && equipmentQueryHasFeatures\(equipmentQuery\)\) \{/.test(indexSrc),
    "the clarify returns BEFORE the equipment search branch (no whole-lot vision on an under-specified ask)"
  );
  // Parser-first: the decision inputs come from the parse slots, not a regex over the customer's words.
  assert.ok(
    /hasEquipmentFeatures: equipmentQueryHasFeatures\(equipmentQuery\)/.test(indexSrc),
    "clarify detection reads the requested_equipment parse slot (parser-first, no regex over intent)"
  );
  assert.ok(
    /hasSegment: equipmentIncludeSegments\.length > 0/.test(indexSrc),
    "clarify detection reads the include_segments parse slot for the bike-type signal"
  );
  // Both-paths: the clarify lives in resolveVehicleRecommendationReply, the SINGLE shared entry both
  // /webhooks/twilio and /conversations/:id/regenerate call (no hand-mirrored regen local).
  const sharedCalls = (indexSrc.match(/resolveVehicleRecommendationReply\(/g) ?? []).length;
  assert.ok(sharedCalls >= 3, "the clarify rides the shared resolver called from BOTH live and regen (>=3 refs)");
}

console.log("inventory_equipment_vision:eval PASS");
