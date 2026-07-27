/**
 * Cholo-style build-vision eval — Phase A governance + composite (DARK, 2026-07-25).
 *
 * Pins the cholo BUILD-signature rules and governance WITHOUT any photos or a live LLM (the vision read
 * is passed in, exactly like the equipment eval). Pure, deterministic. It pins:
 *
 *  (1) BUILD SIGNATURE — FINISH-AGNOSTIC (Joe 7/25-7/26 gold set): a unit is cholo ONLY when its build
 *      shows tall APE HANGERS AND FAT SPOKE WHEELS (the two signature custom parts) AND ≥1 DELIBERATE-BUILD
 *      detail (heavy chrome, whitewalls, fishtails, custom paint, or bags). Cholo can be CHROME or
 *      BLACKED-OUT — color never decides. A STOCK bike is not cholo because it lacks the deliberate-build
 *      details, NOT because it's black. Gold NEGATIVE: stock blacked-out Street Bob (no details). Gold
 *      POSITIVES: chrome Softail, chrome Road King, AND a BLACKED-OUT custom cholo (apes+fat spokes+custom
 *      paint+bags in black). blackedOut is informational (shaves confidence toward confirm), never a gate.
 *  (2) NEVER from base model (Joe ruling 1): a stock Heritage with no cues is NOT cholo; a Sportster with
 *      the full combo IS cholo. The model name never decides it.
 *  (3) ALL of Joe's words → segment=cholo (Joe ruling 2): cholo, cholo style, chicano, chicano style,
 *      lowrider, viclas, west coast style, OG style. Parser-first — pinned at the parser prompt + schema
 *      (the model is INSTRUCTED to map every word to style_segments:["cholo"]) + the canonical normalizer.
 *  (4) ALWAYS CONFIRM, never hard-claim (Joe ruling 3): the near-threshold customer copy says "looks
 *      like … let me confirm", never a flat "it is cholo".
 *  (5) Watch fires ONLY at the confident threshold: watchCholoFireGate is true for a confident full-combo
 *      profile, false for a below-threshold combo, false for an unprofiled (null) arrival — fail-safe.
 *  (6) REGRESSION: the 9 original equipment features + behavior are unchanged; a non-cholo/stock bike is
 *      not cholo; an equipment "bags + windshield" query is unaffected by the added cues.
 *
 * Run: npx tsx scripts/cholo_style_vision_eval.ts
 */
import assert from "node:assert/strict";
import { promises as fsp } from "node:fs";
import path from "node:path";

process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "eval-no-live-key";

import {
  EQUIPMENT_ASSERTION_CONFIDENCE_MIN,
  EQUIPMENT_FEATURE_KEYS,
  CHOLO_REQUIRED_BONES,
  CHOLO_DETAIL_CUES,
  isCholoCanvasModel,
  isCholoExcludedPlatform,
  buildEquipmentProfile,
  deriveCholoBuild,
  watchCholoFireGate,
  buildCholoConfirmLine,
  choloStyleVisionEnabled,
  // buildCholoWatchAvailableReply lives in agentVoice; imported below for the alert-copy test.
  matchesEquipmentQuery,
  type EquipmentProfile
} from "../services/api/src/domain/inventoryEquipmentVision.ts";
import { buildCholoWatchAvailableReply } from "../services/api/src/domain/agentVoice.ts";
import type { VehicleEquipmentDescription } from "../services/api/src/domain/llmDraft.ts";
import type { InventoryWatch } from "../services/api/src/domain/conversationStore.ts";
import { checkMessage } from "./voice_charter_audit.ts";

// A confident read is at/above the assertion floor; a shaky one is below it.
const HI = 0.9;
const LO = 0.5;
assert.ok(HI >= EQUIPMENT_ASSERTION_CONFIDENCE_MIN && LO < EQUIPMENT_ASSERTION_CONFIDENCE_MIN, "test confidences bracket the floor");

function feat(present: boolean, confidence: number) {
  return { present, confidence };
}

// A full equipment vision read with sane all-false defaults; overrides set the cues under test.
function read(overrides: Partial<VehicleEquipmentDescription>): VehicleEquipmentDescription {
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
    customPaint: feat(false, 0),
    blackedOut: feat(false, 0),
    overallConfidence: 0.85,
    notes: "",
    ...overrides
  };
}

function profileFrom(model: string, desc: VehicleEquipmentDescription): EquipmentProfile {
  return buildEquipmentProfile({
    item: { stockId: "TEST-CHOLO", vin: null, model, year: "2021", condition: "used", images: ["a.jpg"] },
    desc,
    imageHash: "hash-cholo",
    imageCount: 1
  });
}

// ===========================================================================
// (1) BUILD SIGNATURE — FINISH-AGNOSTIC (Joe 7/26): tall apes + fat spoke wheels + ≥1 deliberate-build
//     detail (chrome / whitewalls / fishtails / custom paint / bags). Chrome OR blacked-out both count.
// ===========================================================================
{
  // Neither signature bone alone is cholo.
  assert.equal(deriveCholoBuild(profileFrom("Softail", read({ apeHangers: feat(true, HI) }))).isCholo, false, "ape hangers ALONE is not cholo");
  assert.equal(profileFrom("Softail", read({ fatSpokeWheels: feat(true, HI) })).cholo.isCholo, false, "fat spokes alone is not cholo");
  // Both bones but NO deliberate-build detail → not cholo (a bare custom-ish bike is not yet cholo).
  assert.equal(
    profileFrom("Softail", read({ apeHangers: feat(true, HI), fatSpokeWheels: feat(true, HI) })).cholo.isCholo,
    false,
    "apes + fat spokes but NO deliberate-build detail is not cholo"
  );
  // A detail without BOTH bones is not cholo (needs the signature parts).
  assert.equal(
    profileFrom("Softail", read({ apeHangers: feat(true, HI), heavyChrome: feat(true, HI) })).cholo.isCholo,
    false,
    "apes + chrome but no fat spoke wheels is not cholo"
  );

  // THE GOLD NEGATIVE (Joe 7/26): a STOCK blacked-out 2020 Street Bob — apes + fat spokes + solo seat +
  // low stance + blacked-out, but NO deliberate-build detail. Not cholo (no details).
  const stockStreetBob = profileFrom("Street Bob", read({
    apeHangers: feat(true, 0.9), fatSpokeWheels: feat(true, 0.95), soloSeat: feat(true, 0.95),
    lowStance: feat(true, 0.8), blackedOut: feat(true, 0.9)
  }));
  assert.equal(stockStreetBob.cholo.isCholo, false, "GOLD NEGATIVE: a STOCK blacked-out Street Bob (no build details) is NOT cholo");

  // BOBBER EXCLUSION (Joe 7/26: "Street Bobs will never really be considered a cholo — that's a bobber").
  // Even a Street Bob WITH the full build + deliberate details (whitewalls etc.) is NOT cholo — the bobber
  // platform is hard-excluded. This is the U591-18 case (blacked-out Street Bob w/ whitewalls + apes).
  assert.equal(isCholoExcludedPlatform("Street Bob"), true, "Street Bob is an excluded bobber platform");
  assert.equal(isCholoExcludedPlatform("Street Bob 114"), true, "Street Bob variants are excluded too");
  assert.equal(isCholoExcludedPlatform("Road King"), false, "a Road King is NOT an excluded platform");
  const builtStreetBob = profileFrom("Street Bob", read({
    apeHangers: feat(true, 0.95), fatSpokeWheels: feat(true, 0.9), whitewalls: feat(true, 0.99),
    soloSeat: feat(true, 0.98), lowStance: feat(true, 0.8), blackedOut: feat(true, 0.95)
  }));
  assert.equal(builtStreetBob.cholo.isCholo, false, "a Street Bob WITH whitewalls+apes is STILL not cholo (bobber platform excluded)");

  // THE GOLD POSITIVES.
  // (a) Chrome Softail — apes + fat spokes + heavy chrome + fishtails + whitewalls + low.
  const choloSoftail = profileFrom("Heritage Softail Classic", read({
    apeHangers: feat(true, 0.9), fatSpokeWheels: feat(true, 0.9), heavyChrome: feat(true, 0.92),
    fishtailExhaust: feat(true, 0.9), whitewalls: feat(true, 0.85), lowStance: feat(true, 0.85)
  }));
  assert.equal(choloSoftail.cholo.isCholo, true, "GOLD POSITIVE: a chrome cholo Softail is cholo");
  assert.ok(choloSoftail.cholo.confidence >= EQUIPMENT_ASSERTION_CONFIDENCE_MIN, "a cholo build's confidence is at/above the floor");
  // (b) Chrome Road King — apes + fat spokes + whitewalls + chrome + bags.
  const choloRoadKing = profileFrom("Road King", read({
    apeHangers: feat(true, 0.9), fatSpokeWheels: feat(true, 0.9), whitewalls: feat(true, 0.9),
    heavyChrome: feat(true, 0.9), bags: { present: true, confidence: 0.9, bagType: "hard" }
  }));
  assert.equal(choloRoadKing.cholo.isCholo, true, "GOLD POSITIVE: a chrome cholo Road King is cholo");
  // (c) THE BLACKED-OUT CHOLO (Joe 7/26, IMG_1875): tall apes + fat spokes + custom paint + bags + slammed,
  // all in BLACK. Finish-agnostic → this IS cholo even though blacked-out.
  const blackedOutCholo = profileFrom("Road King", read({
    apeHangers: feat(true, 0.92), fatSpokeWheels: feat(true, 0.95), customPaint: feat(true, 0.85),
    bags: { present: true, confidence: 0.9, bagType: "hard" }, soloSeat: feat(true, 0.9),
    lowStance: feat(true, 0.9), blackedOut: feat(true, 0.9)
  }));
  assert.equal(blackedOutCholo.cholo.isCholo, true, "GOLD POSITIVE: a BLACKED-OUT custom cholo (apes+fat spokes+custom paint+bags) IS cholo");
  // ...and the blacked-out finish shaves its confidence toward 'confirm' vs the same build in chrome (never flips it).
  const sameInChrome = profileFrom("Road King", read({
    apeHangers: feat(true, 0.92), fatSpokeWheels: feat(true, 0.95), customPaint: feat(true, 0.85),
    bags: { present: true, confidence: 0.9, bagType: "hard" }, soloSeat: feat(true, 0.9), lowStance: feat(true, 0.9)
  }));
  assert.ok(sameInChrome.cholo.confidence > blackedOutCholo.cholo.confidence, "a blacked-out cholo reads lower-confidence (lean on confirm) than the same build not blacked-out");

  // A single deliberate-build detail is enough with both bones.
  assert.equal(profileFrom("Softail", read({ apeHangers: feat(true, HI), fatSpokeWheels: feat(true, HI), whitewalls: feat(true, HI) })).cholo.isCholo, true, "apes + fat spokes + whitewalls = cholo");
  assert.equal(profileFrom("Softail", read({ apeHangers: feat(true, HI), fatSpokeWheels: feat(true, HI), customPaint: feat(true, HI) })).cholo.isCholo, true, "apes + fat spokes + custom paint = cholo");
  assert.equal(profileFrom("Softail", read({ apeHangers: feat(true, HI), fatSpokeWheels: feat(true, HI), bags: { present: true, confidence: HI, bagType: "hard" } })).cholo.isCholo, true, "apes + fat spokes + bags = cholo");

  // Each deciding cue must be ASSERTED — a below-floor bone or detail does not qualify.
  assert.equal(
    profileFrom("Softail", read({ apeHangers: feat(true, LO), fatSpokeWheels: feat(true, HI), heavyChrome: feat(true, HI) })).cholo.isCholo,
    false,
    "a below-threshold ape read does NOT satisfy the bone (fail toward confirm)"
  );
  assert.equal(
    profileFrom("Softail", read({ apeHangers: feat(true, HI), fatSpokeWheels: feat(true, HI), heavyChrome: feat(true, LO) })).cholo.isCholo,
    false,
    "a below-threshold detail does NOT complete the build (fail toward confirm)"
  );

  // solo seat + low stance are SUPPORTING only — never the deliberate-build detail (too common/stock).
  assert.equal(
    profileFrom("Softail", read({ apeHangers: feat(true, HI), fatSpokeWheels: feat(true, HI), soloSeat: feat(true, HI), lowStance: feat(true, HI) })).cholo.isCholo,
    false,
    "solo seat + low stance do NOT count as a deliberate-build detail (supporting only)"
  );
  assert.ok(choloSoftail.cholo.cues.includes("apeHangers") && choloSoftail.cholo.cues.includes("fatSpokeWheels"), "the signature bones are recorded in cues");
}

// ===========================================================================
// (2) NEVER from base model — the build decides; the canvas model is only a SOFT prior.
// ===========================================================================
{
  // A stock Heritage (a canvas model!) with a windshield and NO cholo cues is NOT cholo.
  const stockHeritage = profileFrom("Heritage Classic", read({ windshield: feat(true, HI) }));
  assert.equal(stockHeritage.cholo.isCholo, false, "a stock Heritage is NOT cholo (never from the base model, even a canvas one)");

  // A non-canvas, non-EXCLUDED model WITH a real cholo build IS cholo — a non-canvas model never blocks
  // (only the bobber-platform exclusion does). Generic Softail: not a named canvas, not a bobber.
  const choloGenericSoftail = profileFrom("Softail", read({ apeHangers: feat(true, HI), fatSpokeWheels: feat(true, HI), heavyChrome: feat(true, HI) }));
  assert.equal(choloGenericSoftail.cholo.isCholo, true, "a cholo build on a non-canvas (non-bobber) model is STILL cholo (canvas is only a soft prior)");
  assert.equal(choloGenericSoftail.cholo.baseModelIsCholoCanvas, false, "a generic Softail is not flagged a named canvas model");

  // The canvas prior is informational + a bounded confidence nudge, and NEVER flips isCholo.
  assert.equal(isCholoCanvasModel("Heritage Softail Classic"), true, "Heritage is a cholo canvas model");
  assert.equal(isCholoCanvasModel("Softail Deluxe"), true, "Deluxe is a cholo canvas model");
  assert.equal(isCholoCanvasModel("Road King"), true, "Road King is a cholo canvas model");
  assert.equal(isCholoCanvasModel("Street Bob"), false, "Street Bob is not a canvas model");
  const onCanvas = profileFrom("Road King", read({ apeHangers: feat(true, 0.9), fatSpokeWheels: feat(true, 0.9), heavyChrome: feat(true, 0.9) }));
  const offCanvas = profileFrom("Nightster", read({ apeHangers: feat(true, 0.9), fatSpokeWheels: feat(true, 0.9), heavyChrome: feat(true, 0.9) }));
  assert.equal(onCanvas.cholo.isCholo, true, "canvas base + cholo build = cholo");
  assert.equal(offCanvas.cholo.isCholo, true, "same build on a non-canvas base is STILL cholo (prior never flips it)");
  assert.ok(onCanvas.cholo.confidence > offCanvas.cholo.confidence, "the canvas prior nudges confidence up vs an atypical base (soft signal only)");
}

// ===========================================================================
// (3) ALL of Joe's words → segment=cholo (parser-first). Pinned at the parser
//     prompt + schema (the model is instructed to map each word) — no live LLM.
// ===========================================================================
{
  const llmDraftSrc = await fsp.readFile(path.join("services", "api", "src", "domain", "llmDraft.ts"), "utf8");
  // The style-segment schema enum carries the canonical value.
  assert.ok(/style_segments/.test(llmDraftSrc), "the recommendation parser exposes a style_segments slot");
  assert.ok(/enum:\s*\["cholo"\]/.test(llmDraftSrc), "style_segments schema enum is ['cholo']");
  // Every one of Joe's words appears in the parser instruction so the LLM maps them all to cholo.
  const JOE_WORDS = ["cholo", "chicano", "lowrider", "low rider", "viclas", "west", "coast", "og style"];
  for (const w of JOE_WORDS) {
    assert.ok(new RegExp(w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i").test(llmDraftSrc), `parser prompt names Joe's cholo word: "${w}"`);
  }
  // The style parser is told to keep the STYLE distinct from the "Low Rider" MODEL (parser-first disambiguation).
  assert.ok(/Low Rider S/.test(llmDraftSrc), "the parser is told to keep the cholo STYLE distinct from the Low Rider MODEL");
  // And at least one cholo few-shot maps a Joe-word phrase to style_segments:["cholo"].
  assert.ok(/style_segments":\["cholo"\]/.test(llmDraftSrc), "a few-shot maps a cholo phrase to style_segments:['cholo']");
}

// InventoryWatch.segments accepts "cholo" (type-level pin — must compile).
{
  const choloWatch: InventoryWatch = {
    model: "Cholo build (style)",
    segments: ["cholo"],
    make: "Harley-Davidson",
    status: "active",
    createdAt: new Date().toISOString()
  };
  assert.deepEqual(choloWatch.segments, ["cholo"], "a cholo build-segment watch is representable");
}

// ===========================================================================
// (4) ALWAYS CONFIRM, never hard-claim.
// ===========================================================================
{
  const line = buildCholoConfirmLine("2021 Softail");
  assert.ok(/looks like/i.test(line), "confirm copy hedges with 'looks like'");
  assert.ok(/confirm/i.test(line), "confirm copy asks to confirm");
  assert.ok(!/\bit is a? ?cholo\b/i.test(line) && !/\bthis is a cholo\b/i.test(line), "confirm copy is NEVER a flat claim");
  // It also passes the voice charter (no AI-tells / banned phrasing).
  const charter = checkMessage(line, { firstOutbound: false, smsLike: true, staffHasSent: false });
  assert.equal(charter.length, 0, `confirm line passes the voice charter (${charter.map(v => v.check).join("; ")})`);
  // Works with no unit label too.
  assert.ok(/looks like/i.test(buildCholoConfirmLine()) && /confirm/i.test(buildCholoConfirmLine()), "confirm copy hedges even with no unit label");
}

// ===========================================================================
// (4b) The LIVE cholo WATCH ALERT copy (buildCholoWatchAvailableReply) — the message a firing cholo
//      watch actually sends. Names the STYLE (not a model the customer never asked for), keeps the
//      "let me double-check" hedge, names the real unit, offers pics/a visit + the opt-out.
// ===========================================================================
{
  const alert = buildCholoWatchAvailableReply({ firstName: "Mike", bikeLabel: "2020 Harley-Davidson Road King", unitColor: "Vivid Black", availability: "new" });
  assert.ok(/cholo/i.test(alert), "the alert names the CHOLO style the customer watched for");
  assert.ok(/double-check|confirm|let me/i.test(alert), "the alert keeps the always-confirm hedge (never a flat claim)");
  assert.ok(/2020 Harley-Davidson Road King/.test(alert), "the alert names the real arriving unit");
  assert.ok(/Vivid Black/.test(alert), "the unit's feed color is stated as the UNIT's color");
  // NEVER claims the customer 'was watching for' that specific MODEL (they watched a style, not a model).
  assert.ok(!/Road King you were watching for/i.test(alert), "the alert does NOT claim the customer watched for the specific model");
  assert.ok(/pics|photos|come see|time/i.test(alert) && /off the list/i.test(alert), "the alert offers pics/a visit and the opt-out");
  // Passes the voice charter (texting-a-friend, no AI-tells / banned phrasing).
  const alertCharter = checkMessage(alert, { firstOutbound: false, smsLike: true, staffHasSent: false });
  assert.equal(alertCharter.length, 0, `cholo watch alert passes the voice charter (${alertCharter.map(v => v.check).join("; ")})`);
  // Graceful with no name / no color / no unit label.
  const bare = buildCholoWatchAvailableReply({ availability: "again" });
  assert.ok(/cholo/i.test(bare) && /double-check|let me/i.test(bare), "bare alert still names cholo + hedges");
}

// ===========================================================================
// (5) Watch fires ONLY at the confident threshold (fail-safe otherwise).
// ===========================================================================
{
  const confidentCholo = profileFrom("Softail Deluxe", read({ apeHangers: feat(true, HI), fatSpokeWheels: feat(true, HI), heavyChrome: feat(true, HI) }));
  assert.equal(watchCholoFireGate(confidentCholo), true, "a confident cholo build fires the watch");

  const shakyCholo = profileFrom("Softail Deluxe", read({ apeHangers: feat(true, HI), fatSpokeWheels: feat(true, LO), heavyChrome: feat(true, HI) }));
  assert.equal(watchCholoFireGate(shakyCholo), false, "a below-threshold signature bone means no fire (fail toward confirm)");

  const notCholo = profileFrom("Road King", read({ windshield: feat(true, HI) }));
  assert.equal(watchCholoFireGate(notCholo), false, "a non-cholo unit never fires a cholo watch");

  // FAIL-SAFE: an unprofiled arrival (null profile) never fires — never a false 'a cholo build came in'.
  assert.equal(watchCholoFireGate(null), false, "an unprofiled unit does NOT fire (fail-safe)");
  assert.equal(watchCholoFireGate(undefined), false, "a missing profile does NOT fire (fail-safe)");
}

// Flag gating: with no env, the cholo path is dark.
{
  const prev = process.env.CHOLO_STYLE_VISION_ENABLED;
  const prevEq = process.env.INVENTORY_EQUIPMENT_VISION_ENABLED;
  delete process.env.CHOLO_STYLE_VISION_ENABLED;
  assert.equal(choloStyleVisionEnabled(), false, "cholo vision is OFF by default (dark)");
  process.env.CHOLO_STYLE_VISION_ENABLED = "1";
  delete process.env.INVENTORY_EQUIPMENT_VISION_ENABLED;
  assert.equal(choloStyleVisionEnabled(), false, "cholo requires the equipment-vision flag too (off → still dark)");
  process.env.INVENTORY_EQUIPMENT_VISION_ENABLED = "1";
  assert.equal(choloStyleVisionEnabled(), true, "cholo is on only when BOTH flags are set");
  if (prev === undefined) delete process.env.CHOLO_STYLE_VISION_ENABLED;
  else process.env.CHOLO_STYLE_VISION_ENABLED = prev;
  if (prevEq === undefined) delete process.env.INVENTORY_EQUIPMENT_VISION_ENABLED;
  else process.env.INVENTORY_EQUIPMENT_VISION_ENABLED = prevEq;
}

// ===========================================================================
// (6) REGRESSION — original equipment features + behavior unchanged.
// ===========================================================================
{
  // The 9 original equipment keys are all still present (cholo cues were ADDED, not swapped).
  for (const k of ["bags", "windshield", "fairing", "backrestSissybar", "tourpak", "forwardControls", "apeHangers", "floorboards", "crashBars"] as const) {
    assert.ok((EQUIPMENT_FEATURE_KEYS as readonly string[]).includes(k), `original equipment key preserved: ${k}`);
  }
  // The finish-agnostic cholo signature is configured as documented (7/26): two signature bones + ≥1
  // deliberate-build detail (bags is a shared equipment key reused as a cholo detail).
  assert.deepEqual(CHOLO_REQUIRED_BONES, ["apeHangers", "fatSpokeWheels"], "signature bones = tall apes + fat spoke wheels");
  assert.deepEqual(CHOLO_DETAIL_CUES, ["heavyChrome", "whitewalls", "fishtailExhaust", "customPaint", "bags"], "deliberate-build details = chrome / whitewalls / fishtails / custom paint / bags");

  // An equipment "bags + windshield" query is UNAFFECTED by the added cholo cues — a bagger with a
  // windshield (and, incidentally, ape hangers) still matches; the cholo cues never enter the query.
  const bagger = profileFrom("Road King", read({ bags: { present: true, confidence: HI, bagType: "hard" }, windshield: feat(true, HI), apeHangers: feat(true, HI) }));
  assert.equal(matchesEquipmentQuery(bagger, { bags: true, windshield: true }), true, "the equipment query still matches a real bagger — cholo cues don't interfere");
  // And a cholo build with NO bags does not match a bags query (the cues are orthogonal to the query).
  const choloNoBags = profileFrom("Softail", read({ apeHangers: feat(true, HI), fatSpokeWheels: feat(true, HI), heavyChrome: feat(true, HI) }));
  assert.equal(matchesEquipmentQuery(choloNoBags, { bags: true }), false, "a cholo build without bags does not satisfy a bags query");
}

// ===========================================================================
// WIRING (source-grep): the cholo fire gate is defined + applied in BOTH fire paths, kept behind the
// cholo flag, and creation is parser-driven (never a keyword regex verdict) — the same discipline the
// equipment/segment watches use. deriveContextNoteWatches is ONE shared builder invoked in both the
// live-inbound and regenerate paths, so two-path parity is inherent (no separate regen mirror).
// ===========================================================================
{
  const indexSrc = await fsp.readFile(path.join("services", "api", "src", "index.ts"), "utf8");

  // Defined once + applied in BOTH fire paths (>=3 refs: def + cron + hold-release).
  const gateRefs = (indexSrc.match(/watchPassesCholoGate\(/g) ?? []).length;
  assert.ok(gateRefs >= 3, "watchPassesCholoGate is defined and applied in BOTH fire paths (cron + hold-release)");

  // Flag-gated: a cholo watch is inert without the cholo flag (dark until flipped), and inert without the
  // equipment-vision flag (which choloStyleVisionEnabled requires).
  assert.ok(
    /if \(watchHasCholoSegment\(watch\) && !choloStyleVisionEnabled\(\)\) return false;/.test(indexSrc),
    "the segment branch keeps a cholo watch inert until CHOLO_STYLE_VISION_ENABLED is flipped"
  );
  assert.ok(
    /if \(!choloStyleVisionEnabled\(\)\) return false;/.test(indexSrc),
    "the cholo fire gate returns false (inert) when the flag is off"
  );

  // The gate is ANDed AFTER the base match in BOTH paths (never a replacement).
  assert.ok(
    /if \(!inventoryItemMatchesWatch\(i, watch\)\) return false;[\s\S]{0,700}watchPassesCholoGate\(i, watch, equipmentCache\)/.test(indexSrc),
    "cron: cholo gate runs AFTER inventoryItemMatchesWatch (ANDed)"
  );
  assert.ok(
    /if \(!inventoryItemMatchesWatch\(matchedItem, watch\)\) return false;[\s\S]{0,700}watchPassesCholoGate\(matchedItem, watch, equipmentCache\)/.test(indexSrc),
    "hold-release: cholo gate runs AFTER inventoryItemMatchesWatch (ANDed)"
  );

  // Creation is PARSER-driven (style_segments), flag-gated, and never mints on a keyword-regex verdict —
  // the CHOLO_WATCH_HINT_RE is only a cost pre-filter that gates whether to run the parse.
  assert.ok(/note: "context_note_cholo_watch"/.test(indexSrc), "creation mints a cholo build-segment watch record");
  assert.ok(/segments: \["cholo"\]/.test(indexSrc), "the cholo watch carries segments:['cholo']");
  assert.ok(/recParse!?\.styleSegments\.includes\("cholo"\)/.test(indexSrc), "the cholo watch is minted from the parser's style_segments (never a regex verdict)");
  assert.ok(/CHOLO_WATCH_HINT_RE = /.test(indexSrc), "the cholo hint is a documented cost pre-filter, not a comprehension gate");

  // The fire gate reads the SAME EquipmentProfile cache the equipment gate uses (profile-on-arrival covers it).
  assert.ok(/convHasActiveCholoWatch/.test(indexSrc), "profile-on-arrival accounts for cholo watchers");

  // ALERT COPY: a firing cholo watch sends the cholo-specific reply (buildCholoWatchAvailableReply),
  // branched on watchHasCholoSegment, in BOTH single-fire paths (cron + hold-release) — NOT the generic
  // model reply. >=2 usages (one per path).
  const choloReplyRefs = (indexSrc.match(/buildCholoWatchAvailableReply\(/g) ?? []).length;
  assert.ok(choloReplyRefs >= 2, "buildCholoWatchAvailableReply is used at BOTH single-fire sites (cron + hold-release)");
  assert.ok(
    /watchHasCholoSegment\(matchedWatch\)\s*\?\s*buildCholoWatchAvailableReply\(/.test(indexSrc),
    "the fire sites branch to the cholo reply on watchHasCholoSegment (else the generic reply)"
  );
}

console.log("PASS cholo_style_vision — build-signature, never-from-model, all-words→cholo, confirm-not-claim, confident-only fire, both-paths wiring, regression");
