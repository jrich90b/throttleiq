/**
 * Cholo-style build-vision eval — Phase A governance + composite (DARK, 2026-07-25).
 *
 * Pins the cholo BUILD-signature rules and governance WITHOUT any photos or a live LLM (the vision read
 * is passed in, exactly like the equipment eval). Pure, deterministic. It pins:
 *
 *  (1) BUILD SIGNATURE, not one part (Joe ruling 1; RECALIBRATED 7/26 off the gold pair): a unit is cholo
 *      ONLY when its build shows tall ape hangers AND the MANDATORY chrome/whitewall FINISH (heavy chrome
 *      OR whitewalls) AND a distinct period cue (fishtail OR whitewalls OR fat CHROME spokes) — ≥2 distinct
 *      non-ape cues — and is NOT blacked-out. Chrome is the essence; a murdered-out bike is disqualified.
 *      Gold negative: a blacked-out stock Street Bob. Gold positives: a chrome Softail + a cholo Road King.
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
  CHOLO_FINISH_CUES,
  CHOLO_PERIOD_CUES,
  isCholoCanvasModel,
  buildEquipmentProfile,
  deriveCholoBuild,
  watchCholoFireGate,
  buildCholoConfirmLine,
  choloStyleVisionEnabled,
  matchesEquipmentQuery,
  type EquipmentProfile
} from "../services/api/src/domain/inventoryEquipmentVision.ts";
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
// (1) BUILD SIGNATURE (recalibrated 2026-07-26) — tall apes + the MANDATORY chrome/whitewall FINISH +
//     a period cue + ≥2 distinct non-ape cues, and NEVER blacked-out. Not one part; chrome is the essence.
// ===========================================================================
{
  // One cue alone is NEVER cholo.
  assert.equal(deriveCholoBuild(profileFrom("Softail", read({ apeHangers: feat(true, HI) }))).isCholo, false, "ape hangers ALONE is not cholo");
  assert.equal(profileFrom("Softail", read({ whitewalls: feat(true, HI) })).cholo.isCholo, false, "whitewalls alone is not cholo");
  assert.equal(profileFrom("Softail", read({ heavyChrome: feat(true, HI) })).cholo.isCholo, false, "heavy chrome alone is not cholo");

  // THE GOLD NEGATIVE (Joe 7/26): a blacked-out stock 2020 Street Bob — apes + BLACK fat spokes + solo
  // seat + low stance, but NO chrome/whitewall finish and blacked-out. This was the false positive that
  // triggered the recalibration. It must read NOT cholo for BOTH reasons.
  const blackedOutStreetBob = profileFrom("Street Bob", read({
    apeHangers: feat(true, 0.9), fatSpokeWheels: feat(true, 0.95), soloSeat: feat(true, 0.95),
    lowStance: feat(true, 0.8), blackedOut: feat(true, 0.9)
  }));
  assert.equal(blackedOutStreetBob.cholo.isCholo, false, "GOLD NEGATIVE: a blacked-out Street Bob (apes+black spokes+solo seat) is NOT cholo");

  // Even WITHOUT the blacked-out flag, that same build lacks the mandatory chrome/whitewall finish → not cholo.
  const noFinish = profileFrom("Street Bob", read({ apeHangers: feat(true, HI), fatSpokeWheels: feat(true, HI), soloSeat: feat(true, HI), lowStance: feat(true, HI) }));
  assert.equal(noFinish.cholo.isCholo, false, "no chrome/whitewall FINISH → not cholo (solo seat + black spokes don't make cholo)");

  // The MANDATORY finish (chrome OR whitewalls) is required even with apes + a period cue.
  assert.equal(
    profileFrom("Softail", read({ apeHangers: feat(true, HI), fatSpokeWheels: feat(true, HI) })).cholo.isCholo,
    false,
    "apes + fat spokes but NO chrome/whitewall finish is not cholo"
  );
  // A blacked-out DISQUALIFIER kills an otherwise-passing build.
  assert.equal(
    profileFrom("Softail", read({ apeHangers: feat(true, HI), heavyChrome: feat(true, HI), fishtailExhaust: feat(true, HI), blackedOut: feat(true, HI) })).cholo.isCholo,
    false,
    "blacked-out disqualifies even a chrome+fishtail build"
  );
  // Whitewalls must NOT double-count as the whole signature (it's in both lists) — need ≥2 distinct non-ape cues.
  assert.equal(
    profileFrom("Softail", read({ apeHangers: feat(true, HI), whitewalls: feat(true, HI) })).cholo.isCholo,
    false,
    "apes + whitewalls ALONE (one non-ape cue) is not cholo — need a second old-school cue"
  );

  // THE GOLD POSITIVES (Joe 7/26): real cholo builds — chrome finish + apes + period cue, not blacked-out.
  // (a) Chrome Softail: chrome apes + heavy chrome + fishtails + chrome spokes + whitewall + low.
  const choloSoftail = profileFrom("Heritage Softail Classic", read({
    apeHangers: feat(true, 0.9), heavyChrome: feat(true, 0.92), fishtailExhaust: feat(true, 0.9),
    fatSpokeWheels: feat(true, 0.9), whitewalls: feat(true, 0.85), lowStance: feat(true, 0.85)
  }));
  assert.equal(choloSoftail.cholo.isCholo, true, "GOLD POSITIVE: a chrome cholo Softail is cholo");
  assert.ok(choloSoftail.cholo.confidence >= EQUIPMENT_ASSERTION_CONFIDENCE_MIN, "a cholo build's confidence is at/above the floor");
  // (b) Cholo Road King: chrome apes + whitewalls + chrome spoke wheel + chrome.
  const choloRoadKing = profileFrom("Road King", read({
    apeHangers: feat(true, 0.9), whitewalls: feat(true, 0.9), fatSpokeWheels: feat(true, 0.9), heavyChrome: feat(true, 0.9)
  }));
  assert.equal(choloRoadKing.cholo.isCholo, true, "GOLD POSITIVE: a cholo Road King is cholo");

  // Minimum true cholo — apes + whitewalls(finish) + fishtail(distinct period) = 2 distinct non-ape cues.
  const minimal = profileFrom("Softail", read({ apeHangers: feat(true, HI), whitewalls: feat(true, HI), fishtailExhaust: feat(true, HI) }));
  assert.equal(minimal.cholo.isCholo, true, "apes + whitewalls + fishtail (2 distinct cues) = cholo");
  // chrome(finish) + fat spokes(period) also works.
  assert.equal(profileFrom("Softail", read({ apeHangers: feat(true, HI), heavyChrome: feat(true, HI), fatSpokeWheels: feat(true, HI) })).cholo.isCholo, true, "apes + chrome + chrome spokes = cholo");

  // Each contributing cue must be ASSERTED. A below-floor finish does not complete it.
  assert.equal(
    profileFrom("Softail", read({ apeHangers: feat(true, HI), heavyChrome: feat(true, LO), fishtailExhaust: feat(true, HI) })).cholo.isCholo,
    false,
    "a below-threshold finish cue does NOT complete the build (fail toward confirm)"
  );

  // low stance is a SUPPORTING cue only — never a finish or period leg.
  assert.equal(
    profileFrom("Softail", read({ apeHangers: feat(true, HI), whitewalls: feat(true, HI), lowStance: feat(true, HI) })).cholo.isCholo,
    false,
    "low stance does NOT stand in for a distinct period cue (supporting only)"
  );
  assert.ok(minimal.cholo.cues.includes("apeHangers"), "the contributing cues are recorded");
}

// ===========================================================================
// (2) NEVER from base model — the build decides; the canvas model is only a SOFT prior.
// ===========================================================================
{
  // A stock Heritage (a canvas model!) with a windshield and NO cholo cues is NOT cholo.
  const stockHeritage = profileFrom("Heritage Classic", read({ windshield: feat(true, HI) }));
  assert.equal(stockHeritage.cholo.isCholo, false, "a stock Heritage is NOT cholo (never from the base model, even a canvas one)");

  // A Sportster (NOT a canvas model) WITH a real chrome cholo build IS cholo — model never blocks it.
  const choloSportster = profileFrom("Sportster Iron 883", read({ apeHangers: feat(true, HI), heavyChrome: feat(true, HI), whitewalls: feat(true, HI) }));
  assert.equal(choloSportster.cholo.isCholo, true, "a chrome cholo build on a non-canvas Sportster is STILL cholo (model never blocks)");
  assert.equal(choloSportster.cholo.baseModelIsCholoCanvas, false, "the Sportster is not flagged a canvas model");

  // The canvas prior is informational + a bounded confidence nudge, and NEVER flips isCholo.
  assert.equal(isCholoCanvasModel("Heritage Softail Classic"), true, "Heritage is a cholo canvas model");
  assert.equal(isCholoCanvasModel("Softail Deluxe"), true, "Deluxe is a cholo canvas model");
  assert.equal(isCholoCanvasModel("Road King"), true, "Road King is a cholo canvas model");
  assert.equal(isCholoCanvasModel("Street Bob"), false, "Street Bob is not a canvas model");
  const onCanvas = profileFrom("Road King", read({ apeHangers: feat(true, 0.9), heavyChrome: feat(true, 0.9), whitewalls: feat(true, 0.9) }));
  const offCanvas = profileFrom("Nightster", read({ apeHangers: feat(true, 0.9), heavyChrome: feat(true, 0.9), whitewalls: feat(true, 0.9) }));
  assert.equal(onCanvas.cholo.isCholo, true, "canvas base + chrome build = cholo");
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
// (5) Watch fires ONLY at the confident threshold (fail-safe otherwise).
// ===========================================================================
{
  const confidentCholo = profileFrom("Softail Deluxe", read({ apeHangers: feat(true, HI), heavyChrome: feat(true, HI), fishtailExhaust: feat(true, HI) }));
  assert.equal(watchCholoFireGate(confidentCholo), true, "a confident cholo build fires the watch");

  const shakyCholo = profileFrom("Softail Deluxe", read({ apeHangers: feat(true, HI), heavyChrome: feat(true, LO), fishtailExhaust: feat(true, HI) }));
  assert.equal(watchCholoFireGate(shakyCholo), false, "a below-threshold finish cue means no fire (fail toward confirm)");

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
  // The recalibrated cholo cue legs are configured as documented (7/26): chrome/whitewall FINISH is
  // mandatory; the period cue is a distinct old-school signal.
  assert.deepEqual(CHOLO_FINISH_CUES, ["heavyChrome", "whitewalls"], "finish leg (MANDATORY) = heavy chrome OR whitewalls");
  assert.deepEqual(CHOLO_PERIOD_CUES, ["fishtailExhaust", "whitewalls", "fatSpokeWheels"], "period leg = fishtail OR whitewalls OR fat chrome spokes");

  // An equipment "bags + windshield" query is UNAFFECTED by the added cholo cues — a bagger with a
  // windshield (and, incidentally, ape hangers) still matches; the cholo cues never enter the query.
  const bagger = profileFrom("Road King", read({ bags: { present: true, confidence: HI, bagType: "hard" }, windshield: feat(true, HI), apeHangers: feat(true, HI) }));
  assert.equal(matchesEquipmentQuery(bagger, { bags: true, windshield: true }), true, "the equipment query still matches a real bagger — cholo cues don't interfere");
  // And a cholo build with NO bags does not match a bags query (the cues are orthogonal to the query).
  const choloNoBags = profileFrom("Softail", read({ apeHangers: feat(true, HI), whitewalls: feat(true, HI), heavyChrome: feat(true, HI) }));
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
}

console.log("PASS cholo_style_vision — build-signature, never-from-model, all-words→cholo, confirm-not-claim, confident-only fire, both-paths wiring, regression");
