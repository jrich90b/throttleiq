/**
 * Cholo-style build-vision eval — Phase A governance + composite (DARK, 2026-07-25).
 *
 * Pins the cholo BUILD-signature rules and governance WITHOUT any photos or a live LLM (the vision read
 * is passed in, exactly like the equipment eval). Pure, deterministic. It pins:
 *
 *  (1) BUILD SIGNATURE, not one part (Joe ruling 1): a unit is cholo ONLY when its build crosses the
 *      COMBINATION bar — ape hangers AND (whitewalls OR fat spoke wheels) AND (fishtail OR solo seat OR
 *      heavy chrome). One cue alone ≠ cholo; the full combo = cholo. Each leg must be ASSERTED (confident).
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
  CHOLO_WHEEL_CUES,
  CHOLO_FINISH_CUES,
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
// (1) BUILD SIGNATURE — the combination bar, not one part.
// ===========================================================================
{
  // One cue alone is NEVER cholo. Pin BOTH deriveCholoBuild(...) directly and the profile.cholo block.
  assert.equal(deriveCholoBuild(profileFrom("Softail", read({ apeHangers: feat(true, HI) }))).isCholo, false, "ape hangers ALONE is not cholo (deriveCholoBuild)");
  assert.equal(profileFrom("Softail", read({ apeHangers: feat(true, HI) })).cholo.isCholo, false, "ape hangers alone → profile.cholo false");
  assert.equal(profileFrom("Softail", read({ whitewalls: feat(true, HI) })).cholo.isCholo, false, "whitewalls alone is not cholo");
  assert.equal(profileFrom("Softail", read({ fishtailExhaust: feat(true, HI) })).cholo.isCholo, false, "fishtail alone is not cholo");
  assert.equal(profileFrom("Softail", read({ soloSeat: feat(true, HI) })).cholo.isCholo, false, "solo seat alone is not cholo");
  assert.equal(profileFrom("Softail", read({ heavyChrome: feat(true, HI) })).cholo.isCholo, false, "heavy chrome alone is not cholo");

  // TWO of three legs is still not enough (missing the finish leg).
  assert.equal(
    profileFrom("Softail", read({ apeHangers: feat(true, HI), whitewalls: feat(true, HI) })).cholo.isCholo,
    false,
    "ape + whitewalls but no finish leg is not cholo"
  );
  // Missing the ape-hanger anchor leg.
  assert.equal(
    profileFrom("Softail", read({ whitewalls: feat(true, HI), fishtailExhaust: feat(true, HI) })).cholo.isCholo,
    false,
    "wheels + finish but no ape hangers is not cholo"
  );

  // The FULL combo IS cholo — ape + (a wheel cue) + (a finish cue).
  const full = profileFrom("Softail", read({
    apeHangers: feat(true, HI),
    whitewalls: feat(true, HI),
    fishtailExhaust: feat(true, HI)
  }));
  assert.equal(full.cholo.isCholo, true, "ape + whitewalls + fishtail = cholo");
  assert.ok(full.cholo.confidence >= EQUIPMENT_ASSERTION_CONFIDENCE_MIN, "a cholo build's composite confidence is at/above the floor");
  assert.ok(full.cholo.cues.includes("apeHangers") && full.cholo.cues.includes("whitewalls") && full.cholo.cues.includes("fishtailExhaust"), "the contributing cues are recorded");

  // The OTHER leg members also satisfy their leg (fat spoke wheels for the wheel leg; solo seat / heavy chrome for finish).
  assert.equal(profileFrom("Softail", read({ apeHangers: feat(true, HI), fatSpokeWheels: feat(true, HI), soloSeat: feat(true, HI) })).cholo.isCholo, true, "ape + fat spokes + solo seat = cholo");
  assert.equal(profileFrom("Softail", read({ apeHangers: feat(true, HI), fatSpokeWheels: feat(true, HI), heavyChrome: feat(true, HI) })).cholo.isCholo, true, "ape + fat spokes + heavy chrome = cholo");

  // Each contributing cue must be ASSERTED (confident). A full combo where the finish leg is BELOW the
  // floor does not cross the bar — fail toward "let me check".
  assert.equal(
    profileFrom("Softail", read({ apeHangers: feat(true, HI), whitewalls: feat(true, HI), fishtailExhaust: feat(true, LO) })).cholo.isCholo,
    false,
    "a below-threshold finish cue does NOT complete the combo (fail toward confirm)"
  );

  // Composite confidence is the weakest-link (min) of the legs.
  const weakLeg = profileFrom("Softail", read({ apeHangers: feat(true, 0.95), whitewalls: feat(true, 0.72), fishtailExhaust: feat(true, 0.9) }));
  assert.equal(weakLeg.cholo.isCholo, true, "0.72 whitewalls still clears the 0.7 floor → cholo");
  assert.ok(Math.abs(weakLeg.cholo.confidence - 0.72) < 1e-9, "composite confidence = weakest asserted leg (0.72)");

  // low stance is a SUPPORTING cue only — it never completes the bar on its own, but rides along in cues.
  assert.equal(
    profileFrom("Softail", read({ apeHangers: feat(true, HI), whitewalls: feat(true, HI), lowStance: feat(true, HI) })).cholo.isCholo,
    false,
    "low stance does NOT count as a finish leg (supporting cue only)"
  );
  assert.ok(full.cholo.cues.length > 0 && !full.cholo.cues.includes("lowStance"), "lowStance only appears in cues when asserted");
  const withStance = profileFrom("Softail", read({ apeHangers: feat(true, HI), whitewalls: feat(true, HI), fishtailExhaust: feat(true, HI), lowStance: feat(true, HI) }));
  assert.ok(withStance.cholo.cues.includes("lowStance"), "an asserted low stance is recorded as a supporting cue");
}

// ===========================================================================
// (2) NEVER from base model — the build decides, not the model name.
// ===========================================================================
{
  // A stock Heritage with a windshield and NO cholo cues is NOT cholo (the classic "stock Heritage" case).
  const stockHeritage = profileFrom("Heritage Classic", read({ windshield: feat(true, HI) }));
  assert.equal(stockHeritage.cholo.isCholo, false, "a stock Heritage is NOT cholo (ruling 1: never from the base model)");

  // A Sportster (not a common cholo base) WITH the full combo IS cholo — the model is irrelevant.
  const choloSportster = profileFrom("Sportster Iron 883", read({ apeHangers: feat(true, HI), whitewalls: feat(true, HI), soloSeat: feat(true, HI) }));
  assert.equal(choloSportster.cholo.isCholo, true, "the build, not the model, makes it cholo (a Sportster can be a cholo build)");

  // Same features, empty-model unit — build-based, so still cholo.
  const noModel = profileFrom("", read({ apeHangers: feat(true, HI), fatSpokeWheels: feat(true, HI), fishtailExhaust: feat(true, HI) }));
  assert.equal(noModel.cholo.isCholo, true, "cholo is build-derived — an unknown model with the combo still reads cholo");
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
  const confidentCholo = profileFrom("Softail Deluxe", read({ apeHangers: feat(true, HI), whitewalls: feat(true, HI), fishtailExhaust: feat(true, HI) }));
  assert.equal(watchCholoFireGate(confidentCholo), true, "a confident cholo build fires the watch");

  const shakyCholo = profileFrom("Softail Deluxe", read({ apeHangers: feat(true, HI), whitewalls: feat(true, LO), fishtailExhaust: feat(true, HI) }));
  assert.equal(watchCholoFireGate(shakyCholo), false, "a below-threshold cue means no fire (fail toward confirm)");

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
  // The cholo cue legs are configured as documented.
  assert.deepEqual(CHOLO_WHEEL_CUES, ["whitewalls", "fatSpokeWheels"], "wheel leg = whitewalls OR fat spoke wheels");
  assert.deepEqual(CHOLO_FINISH_CUES, ["fishtailExhaust", "soloSeat", "heavyChrome"], "finish leg = fishtail OR solo seat OR heavy chrome");

  // An equipment "bags + windshield" query is UNAFFECTED by the added cholo cues — a bagger with a
  // windshield (and, incidentally, ape hangers) still matches; the cholo cues never enter the query.
  const bagger = profileFrom("Road King", read({ bags: { present: true, confidence: HI, bagType: "hard" }, windshield: feat(true, HI), apeHangers: feat(true, HI) }));
  assert.equal(matchesEquipmentQuery(bagger, { bags: true, windshield: true }), true, "the equipment query still matches a real bagger — cholo cues don't interfere");
  // And a cholo build with NO bags does not match a bags query (the cues are orthogonal to the query).
  const choloNoBags = profileFrom("Softail", read({ apeHangers: feat(true, HI), whitewalls: feat(true, HI), soloSeat: feat(true, HI) }));
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
