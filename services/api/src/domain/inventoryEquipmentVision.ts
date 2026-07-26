/**
 * Inventory equipment vision — Phase A (DARK, 2026-07-25).
 *
 * "Shop the used lot by how the bikes are actually equipped." A customer says
 * "something with bags and a windshield." The factory model name can't tell you
 * whether a USED bike has those (someone may have bolted them onto a bare Street
 * Bob), and the feed carries NO equipment field — only photos. This module turns
 * a unit's photos into a typed, per-feature, confidence-scored EQUIPMENT PROFILE.
 *
 * Phase A is DARK: this builds the vision pass + the per-unit cache + the pure
 * governance/prior/search-predicate helpers, and runs a dark sweep to prove
 * accuracy. It is NOT wired into inventoryRecommender / search / any customer
 * reply (that is Phase B). Behind INVENTORY_EQUIPMENT_VISION_ENABLED (default
 * off) + a per-run cap; kill switch = leave the flag unset.
 *
 * Governance (AGENTS.md never-fabricate, applied to equipment): per-feature
 * confidence; a feature is only ASSERTED at/above the threshold (default 0.7,
 * mirroring VISION_CONFIDENCE_MIN). Below threshold, or on a bad photo angle
 * that hides a bag, we fail toward "looks like / let me confirm" — never a false
 * yes. Nothing customer-facing here anyway.
 *
 * JOE'S RULING (windshield ≠ fairing): a windshield is a separate clear shield
 * on brackets; a fairing is fixed bodywork (batwing / sharknose). They are
 * DISTINCT — a fairing bike is NOT a windshield match. `matchesEquipmentQuery`
 * enforces it (a windshield request excludes fairing units); the model-level
 * prior (batwing/sharknose = fairing models) sanity-checks the vision read.
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";

import { dataPath } from "./dataDir.js";
import {
  describeUnitEquipmentWithLLM,
  type VehicleEquipmentDescription
} from "./llmDraft.js";
import type { InventoryFeedItem } from "./inventoryFeed.js";

// ---------------------------------------------------------------------------
// Feature taxonomy (Joe's fuller v1 set, spec §3 + Joe answers 2026-07-25).
// ---------------------------------------------------------------------------
export const EQUIPMENT_FEATURE_KEYS = [
  "bags",
  "windshield",
  "fairing",
  "backrestSissybar",
  "tourpak",
  "forwardControls",
  "apeHangers",
  "floorboards",
  "crashBars",
  // Cholo-BUILD cues (Cholo style vision, 2026-07-25, DARK). These are the extra vision reads the
  // cholo composite scores; apeHangers (above) is REUSED as the biggest single cue. They live in the
  // same feature record so the vision read + cache carry them, but they are NEVER shopped by an
  // equipment query (RequestedEquipmentQuery has no such keys → normalizeRequestedEquipment never
  // produces them, so matchesEquipmentQuery / classifyUnitForEquipmentQuery skip them). Populated only
  // when CHOLO_STYLE_VISION_ENABLED is on (else the vision omits them → present:false, confidence:0).
  "whitewalls",
  "fatSpokeWheels",
  "fishtailExhaust",
  "soloSeat",
  "heavyChrome",
  "lowStance",
  // blackedOut is a DISQUALIFIER, not a cholo cue: a predominantly dark/blacked-out bike (black
  // brightwork, black wheels, black pipes — e.g. a stock murdered-out Street Bob) is NEVER cholo,
  // no matter its bars/wheels. Cholo is a CHROME-and-whitewall lowrider look. Joe ruling 2026-07-26
  // off the gold negative (blacked-out 2020 Street Bob U598-20 was a false positive).
  "blackedOut"
] as const;
export type EquipmentFeatureKey = (typeof EQUIPMENT_FEATURE_KEYS)[number];

export const EQUIPMENT_ASSERTION_CONFIDENCE_MIN = Number(
  process.env.INVENTORY_EQUIPMENT_ASSERTION_CONFIDENCE_MIN ?? 0.7
);

export type EquipmentFeatureProfile = {
  /** Vision saw it AND cleared the assertion threshold (post model-prior reconcile). */
  asserted: boolean;
  /** Raw vision "present" read, regardless of confidence. */
  detected: boolean;
  /** Per-feature confidence, 0..1, after any model-prior penalty. */
  confidence: number;
};

export type EquipmentModelPrior = {
  /** Does the model name imply a fixed fairing? */
  fairing: "expected" | "unexpected" | "unknown";
  fairingType: "batwing" | "sharknose" | "unknown";
  /** Does the model name imply a separate windshield (and NOT a fairing)? */
  windshield: "expected" | "unexpected" | "unknown";
  reason: string;
};

export type EquipmentProfile = {
  stockId: string | null;
  vin: string | null;
  model: string | null;
  year: string | null;
  condition: string | null;
  imageHash: string;
  imageCount: number;
  computedAt: string;
  isMotorcycle: boolean;
  overallConfidence: number;
  bagType: "hard" | "leather" | "soft" | "unknown";
  fairingType: "batwing" | "sharknose" | "unknown";
  features: Record<EquipmentFeatureKey, EquipmentFeatureProfile>;
  modelPrior: EquipmentModelPrior;
  /** How the vision read squares with the model-name prior. */
  priorAgreement: "agree" | "disagree" | "na";
  priorNote: string;
  notes: string;
  /**
   * Cholo BUILD signature (Cholo style vision, DARK). Computed from the asserted cues via
   * deriveCholoBuild — NEVER from the base model (a stock Heritage is not cholo). Present on every
   * profile; isCholo is false unless the composite crosses Joe's combination bar. Only meaningful when
   * CHOLO_STYLE_VISION_ENABLED populated the cues; otherwise all cues are absent → isCholo:false.
   */
  cholo: CholoBuild;
};

/** Result of the cholo build-signature composite (Joe ruling 1, 2026-07-25). */
export type CholoBuild = {
  /** The build crosses the cholo combination bar with every contributing cue ASSERTED (confident). */
  isCholo: boolean;
  /** Composite confidence — the weakest-link (min) of the required legs' cue confidences; 0 when not cholo. */
  confidence: number;
  /** The asserted cues that fed the decision (audit + the dark report). */
  cues: string[];
  /**
   * SOFT PRIOR (Joe 2026-07-26): cholo builds are USUALLY on a Heritage Softail / Softail Deluxe /
   * Road King (valanced-fender, chrome-friendly canvases). This is informational + a confidence nudge
   * ONLY — it never creates or blocks cholo (never-from-model law): a real cholo build on an odd base
   * still counts, and a bare canvas model is still not cholo. Surfaced in the dark report.
   */
  baseModelIsCholoCanvas: boolean;
};

/**
 * The base models cholo builds are USUALLY built on (Joe 2026-07-26). A SOFT prior, not a gate.
 * Valanced-fender / chrome-friendly cruisers: Heritage (Softail Classic), Softail Deluxe, Road King,
 * plus the close cousins that share the canvas (Fat Boy, Softail Slim, Springer). Matched loosely on
 * the model LABEL only (never customer text).
 */
export const CHOLO_CANVAS_MODEL_PATTERNS: RegExp[] = [
  /\bheritage\b/i,
  /\bdeluxe\b/i,
  /\broad\s*king\b/i,
  /\bfat\s*boy\b/i,
  /\bsoftail\s+slim\b/i,
  /\bspringer\b/i
];

export function isCholoCanvasModel(model: string | null | undefined): boolean {
  const m = (model ?? "").trim();
  if (!m) return false;
  return CHOLO_CANVAS_MODEL_PATTERNS.some((re) => re.test(m));
}

// ---------------------------------------------------------------------------
// Model-prior sanity: cross-check vision against what the MODEL NAME tells us.
// A Street Glide / Road Glide is a fairing model → fairing expected, windshield
// unexpected. A Road King / Switchback is a windshield model. Deterministic
// structured classification over the inventory model LABEL (never customer free
// text) — allowed deterministic per AGENTS.md. Fail direction: an unknown model
// → all "unknown" and the prior infers nothing (vision stands on its own).
// ---------------------------------------------------------------------------
function normalizeModelText(model: string | null | undefined): string {
  return String(model ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Frame-mounted sharknose fairing family (dual headlights).
const SHARKNOSE_FAIRING_RES: RegExp[] = [/\broad glide\b/];
// Fork-mounted batwing fairing families.
const BATWING_FAIRING_RES: RegExp[] = [
  /\bstreet glide\b/,
  /\belectra glide\b/,
  /\bultra\b/, // Ultra / Ultra Limited / Ultra Classic
  /\btri glide\b/
];
// Separate-windshield stock models (round headlight, detachable shield — NOT a fairing).
const WINDSHIELD_MODEL_RES: RegExp[] = [
  /\broad king\b/,
  /\bswitchback\b/,
  /\bheritage\b/, // Heritage Classic ships a detachable windshield
  /\bfreewheeler\b/
];
// Small/sport-fairing models: their only front element is a small quarter/'speed screen' shroud or a
// sport fairing — per JOE'S RULING (2026-07-25) that does NOT count as "has a fairing" (only BIG TOURING
// fairings do). A big-fairing detection on these is a false positive → penalized. Windshield stays
// "unknown" (a used one could carry an aftermarket shield — don't penalize that).
const SMALL_OR_NO_FAIRING_MODEL_RES: RegExp[] = [
  /\blow rider\b/ // Low Rider / Low Rider S (quarter shroud) / Low Rider ST (sport fairing)
];

export function modelEquipmentPrior(model: string | null | undefined): EquipmentModelPrior {
  const key = normalizeModelText(model);
  if (!key) {
    return { fairing: "unknown", fairingType: "unknown", windshield: "unknown", reason: "no model label" };
  }
  if (SHARKNOSE_FAIRING_RES.some(re => re.test(key))) {
    return {
      fairing: "expected",
      fairingType: "sharknose",
      windshield: "unexpected",
      reason: "Road Glide = frame-mounted sharknose fairing model"
    };
  }
  if (BATWING_FAIRING_RES.some(re => re.test(key))) {
    return {
      fairing: "expected",
      fairingType: "batwing",
      windshield: "unexpected",
      reason: "batwing fairing model (Street/Electra/Ultra/Tri Glide)"
    };
  }
  if (WINDSHIELD_MODEL_RES.some(re => re.test(key))) {
    return {
      fairing: "unexpected",
      fairingType: "unknown",
      windshield: "expected",
      reason: "separate-windshield stock model (no fixed fairing)"
    };
  }
  if (SMALL_OR_NO_FAIRING_MODEL_RES.some(re => re.test(key))) {
    return {
      fairing: "unexpected",
      fairingType: "unknown",
      windshield: "unknown", // could carry an aftermarket shield — don't penalize windshield
      reason: "small/sport-fairing model — a big touring fairing is not expected (Joe: only big touring fairings count)"
    };
  }
  return { fairing: "unknown", fairingType: "unknown", windshield: "unknown", reason: "model has no fairing/windshield prior" };
}

// ---------------------------------------------------------------------------
// Reconcile vision vs the model prior. STRONG disagreement lowers confidence so
// we don't assert on a shaky read (parser-first: don't over-claim). The classic
// failure mode is calling a fairing bike's front a "windshield" — Joe's ruling
// makes that a wrong match, so a fairing-model unit reading windshield=true gets
// its windshield confidence knocked below the assertion floor.
// ---------------------------------------------------------------------------
const PRIOR_DISAGREE_PENALTY = Number(process.env.INVENTORY_EQUIPMENT_PRIOR_PENALTY ?? 0.4);

type ReconciledFeature = { present: boolean; confidence: number };

function penalize(read: ReconciledFeature): ReconciledFeature {
  return { present: read.present, confidence: Math.max(0, read.confidence - PRIOR_DISAGREE_PENALTY) };
}

export function reconcileEquipmentWithPrior(
  desc: VehicleEquipmentDescription,
  prior: EquipmentModelPrior
): {
  windshield: ReconciledFeature;
  fairing: ReconciledFeature;
  agreement: "agree" | "disagree" | "na";
  note: string;
} {
  let windshield: ReconciledFeature = { present: desc.windshield.present, confidence: desc.windshield.confidence };
  let fairing: ReconciledFeature = { present: desc.fairing.present, confidence: desc.fairing.confidence };

  // Mutual exclusivity: a bike's front is EITHER a clear windshield OR a fixed fairing, never both.
  // The model prior decides which one is the wrong-match trap to penalize — even when vision (wrongly)
  // reported BOTH (the batwing-on-a-Heritage false positive: windshield 95% + batwing 90% on a
  // separate-windshield cruiser). Penalizing the contradicting feature drops it below the assertion floor.
  if (prior.fairing === "expected") {
    // Fairing model → a separate-windshield reading contradicts the model; penalize it regardless of fairing.
    if (windshield.present) windshield = penalize(windshield);
    if (fairing.present) {
      return {
        windshield,
        fairing,
        agreement: "agree",
        note: desc.windshield.present
          ? "fairing model + vision saw a fairing; contradicting windshield lowered"
          : "fairing model + vision saw a fairing"
      };
    }
    if (desc.windshield.present) {
      return { windshield, fairing, agreement: "disagree", note: "fairing model but vision read a windshield — windshield confidence lowered" };
    }
    return { windshield, fairing, agreement: "na", note: "fairing model but vision saw neither clearly" };
  }

  if (prior.windshield === "expected") {
    // Windshield model → a fixed-fairing reading contradicts the model; penalize it regardless of windshield.
    if (fairing.present) fairing = penalize(fairing);
    if (windshield.present) {
      return {
        windshield,
        fairing,
        agreement: "agree",
        note: desc.fairing.present
          ? "windshield model + vision saw a windshield; contradicting fairing lowered"
          : "windshield model + vision saw a windshield"
      };
    }
    if (desc.fairing.present) {
      return { windshield, fairing, agreement: "disagree", note: "windshield model but vision read a fairing — fairing confidence lowered" };
    }
    return { windshield, fairing, agreement: "na", note: "windshield model but vision saw neither clearly" };
  }

  if (prior.fairing === "unexpected") {
    // Small/sport-fairing model (e.g. Low Rider S/ST) whose windshield is "unknown": its little shroud is
    // NOT a big touring fairing, so a detected big fairing contradicts Joe's "only big touring fairings
    // count" ruling → penalize it below the floor. (Windshield-expected models were handled above.)
    if (fairing.present) {
      fairing = penalize(fairing);
      return {
        windshield,
        fairing,
        agreement: "disagree",
        note: "small/sport-fairing model but vision read a big fairing — fairing confidence lowered (only big touring fairings count)"
      };
    }
    return { windshield, fairing, agreement: "na", note: "small/sport-fairing model; no big touring fairing seen" };
  }

  // No model prior: still enforce mutual exclusivity — if vision reported BOTH, keep the higher-confidence
  // one and penalize the weaker (they can't coexist on one bike).
  if (windshield.present && fairing.present) {
    if (windshield.confidence >= fairing.confidence) fairing = penalize(fairing);
    else windshield = penalize(windshield);
    return {
      windshield,
      fairing,
      agreement: "na",
      note: "no prior; vision saw both windshield+fairing — weaker one penalized (mutual exclusivity)"
    };
  }

  return { windshield, fairing, agreement: "na", note: "no model prior" };
}

// ---------------------------------------------------------------------------
// Build the governed EquipmentProfile from a raw vision read + the item.
// ---------------------------------------------------------------------------
function assertedFeature(read: ReconciledFeature): EquipmentFeatureProfile {
  return {
    detected: read.present,
    confidence: read.confidence,
    asserted: read.present && read.confidence >= EQUIPMENT_ASSERTION_CONFIDENCE_MIN
  };
}

export function buildEquipmentProfile(args: {
  item: Pick<InventoryFeedItem, "stockId" | "vin" | "model" | "year" | "condition" | "images">;
  desc: VehicleEquipmentDescription;
  imageHash: string;
  imageCount: number;
  now?: string;
}): EquipmentProfile {
  const { item, desc } = args;
  const prior = modelEquipmentPrior(item.model);
  const reconciled = reconcileEquipmentWithPrior(desc, prior);

  const features: Record<EquipmentFeatureKey, EquipmentFeatureProfile> = {
    bags: assertedFeature(desc.bags),
    windshield: assertedFeature(reconciled.windshield),
    fairing: assertedFeature(reconciled.fairing),
    backrestSissybar: assertedFeature(desc.backrestSissybar),
    tourpak: assertedFeature(desc.tourpak),
    forwardControls: assertedFeature(desc.forwardControls),
    apeHangers: assertedFeature(desc.apeHangers),
    floorboards: assertedFeature(desc.floorboards),
    crashBars: assertedFeature(desc.crashBars),
    // Cholo cues — reconcile-free (no windshield≠fairing interplay); a plain assertion at the floor.
    whitewalls: assertedFeature(desc.whitewalls),
    fatSpokeWheels: assertedFeature(desc.fatSpokeWheels),
    fishtailExhaust: assertedFeature(desc.fishtailExhaust),
    soloSeat: assertedFeature(desc.soloSeat),
    heavyChrome: assertedFeature(desc.heavyChrome),
    lowStance: assertedFeature(desc.lowStance),
    blackedOut: assertedFeature(desc.blackedOut)
  };

  return {
    stockId: item.stockId ?? null,
    vin: item.vin ?? null,
    model: item.model ?? null,
    year: item.year ?? null,
    condition: item.condition ?? null,
    imageHash: args.imageHash,
    imageCount: args.imageCount,
    computedAt: args.now ?? new Date().toISOString(),
    isMotorcycle: desc.isMotorcycle,
    overallConfidence: desc.overallConfidence,
    bagType: features.bags.asserted ? desc.bags.bagType : "unknown",
    fairingType: features.fairing.asserted ? desc.fairing.fairingType : "unknown",
    features,
    modelPrior: prior,
    priorAgreement: reconciled.agreement,
    priorNote: reconciled.note,
    notes: desc.notes,
    cholo: deriveCholoBuild({ features, model: item.model ?? null })
  };
}

// ---------------------------------------------------------------------------
// CHOLO BUILD SIGNATURE (Cholo style vision, DARK). Joe rulings 2026-07-25 (build-signature, not one
// part; never from base model) + RECALIBRATED 2026-07-26 off the gold pair below. A unit is "cholo"
// only when ALL of these hold:
//
//   (1) ape hangers  — tall apes, the anchor
//   (2) THE CHROME / WHITEWALL LOWRIDER FINISH (MANDATORY)  — heavy chrome OR whitewalls. This is the
//       essence of cholo: the old-school SHINE. Without it a bike is not cholo, full stop.
//   (3) a period cue  — fishtail exhaust OR whitewalls OR fat CHROME spoke wheels
//   (4) NOT blacked-out — a murdered-out / dark-finish bike is disqualified outright.
//
// Why the recalibration: the first rule counted a plain SOLO SEAT and BLACK spoke wheels as a cholo
// signal, so a stock blacked-out 2020 Street Bob (U598-20 — apes + black fat spokes + solo seat) was a
// FALSE POSITIVE. The discriminator between Joe's "not cholo" (blacked-out Street Bob) and his "this IS
// cholo" (chrome Softail: chrome apes + chrome fishtails + chrome spoke wheels + whitewall) is CHROME.
// So the finish (chrome/whitewalls) is now MANDATORY, blacked-out is a hard disqualifier, and solo seat
// is dropped as a finish signal (it means nothing on its own — half the lot has one).
//
// Each contributing cue must be ASSERTED (vision read cleared EQUIPMENT_ASSERTION_CONFIDENCE_MIN). low
// stance is a supporting cue only (rides along in `cues`, never decides). Confidence = weakest-link (min)
// of the deciding legs. Fail direction (ruling 3): below/near the bar → isCholo=false → nothing tagged,
// no watch fires; near-threshold copy is "looks like a cholo build — let me confirm", never a flat claim.
// ---------------------------------------------------------------------------

/** The chrome/whitewall lowrider FINISH — MANDATORY (recalibrated 7/26). This is what makes a bike cholo. */
export const CHOLO_FINISH_CUES: EquipmentFeatureKey[] = ["heavyChrome", "whitewalls"];
/** A period cue — an old-school lowrider signal beyond the finish. */
export const CHOLO_PERIOD_CUES: EquipmentFeatureKey[] = ["fishtailExhaust", "whitewalls", "fatSpokeWheels"];

export function deriveCholoBuild(profile: Pick<EquipmentProfile, "features" | "model">): CholoBuild {
  const f = profile.features;
  const isAsserted = (k: EquipmentFeatureKey): boolean => f[k]?.asserted === true;
  const conf = (k: EquipmentFeatureKey): number => f[k]?.confidence ?? 0;

  const hasApe = isAsserted("apeHangers");
  const blackedOut = isAsserted("blackedOut");
  const finishCues = CHOLO_FINISH_CUES.filter(isAsserted);
  const periodCues = CHOLO_PERIOD_CUES.filter(isAsserted);
  // Distinct non-ape deciding cues — whitewalls lives in BOTH lists, so it must not double-count as the
  // whole signature. A real cholo build shows tall apes + the chrome/whitewall FINISH + at least one MORE
  // old-school cue → at least 2 distinct non-ape cues (never "one part").
  const distinctNonApe = new Set<EquipmentFeatureKey>([...finishCues, ...periodCues]);

  // The BUILD decides — MANDATORY chrome/whitewall finish + a period cue + ≥2 distinct non-ape cues +
  // tall apes, and NEVER a blacked-out bike. The base model is a SOFT prior only (below) — it NEVER
  // creates or blocks cholo.
  const isCholo =
    hasApe && finishCues.length > 0 && periodCues.length > 0 && distinctNonApe.size >= 2 && !blackedOut;

  const baseModelIsCholoCanvas = isCholoCanvasModel(profile.model);

  const cues: string[] = [];
  if (hasApe) cues.push("apeHangers");
  // de-duped union of the deciding cues, in a stable order
  for (const k of [...CHOLO_FINISH_CUES, ...CHOLO_PERIOD_CUES]) {
    if (isAsserted(k) && !cues.includes(k)) cues.push(k);
  }
  if (isAsserted("lowStance")) cues.push("lowStance");
  if (blackedOut) cues.push("blackedOut(disqualifier)");
  if (baseModelIsCholoCanvas) cues.push("canvas:" + (profile.model ?? "").trim());

  let confidence = 0;
  if (isCholo) {
    const finishConf = Math.max(...finishCues.map(conf));
    const periodConf = Math.max(...periodCues.map(conf));
    confidence = Math.min(conf("apeHangers"), finishConf, periodConf);
    // Soft prior nudge: a typical cholo canvas (Heritage/Deluxe/Road King...) reinforces the read; an
    // atypical base shaves confidence toward "confirm". Bounded, and it can never flip isCholo.
    confidence = Math.max(0, Math.min(1, confidence + (baseModelIsCholoCanvas ? 0.03 : -0.05)));
  }

  return { isCholo, confidence, cues, baseModelIsCholoCanvas };
}

// The cholo WATCH fire gate (pure, mirrors watchEquipmentFireGate). An arriving unit fires a standing
// cholo watch ONLY when its cached profile's build crosses the confident cholo bar. FAIL-SAFE: a null
// profile (unprofiled arrival) or a below-bar build is NOT a fire — deriveCholoBuild returns isCholo:false,
// so the engine holds off rather than sending a false "a cholo build just came in." NEVER model-based.
export function watchCholoFireGate(profile: EquipmentProfile | null | undefined): boolean {
  if (!profile) return false;
  return deriveCholoBuild(profile).isCholo;
}

// Customer-facing CONFIRM copy (Joe ruling 3 — always confirm, never hard-claim). Even at/above the
// confident bar the alert says "looks like a cholo build — let me confirm", never "it is cholo": style
// is subjective and a human confirms before the customer drives out. Pure; the fire path composes it.
export function buildCholoConfirmLine(unitLabel?: string | null): string {
  const bike = String(unitLabel ?? "").trim();
  const subject = bike ? `this ${bike}` : "one";
  return `Looks like ${subject} might be a cholo-style build — let me confirm the details before you head over.`;
}

export function choloStyleVisionEnabled(): boolean {
  // Cholo tagging/fire rides INSIDE the equipment-vision canary: it requires BOTH its own flag AND the
  // equipment-vision flag (the vision primitive + cache it reuses). Either off → 100% today's behavior.
  return process.env.CHOLO_STYLE_VISION_ENABLED === "1" && inventoryEquipmentVisionEnabled();
}

// ---------------------------------------------------------------------------
// Search predicate (Phase B will call this; Phase A only pins it in the eval).
// A unit matches when EVERY requested feature is ASSERTED true. Joe's ruling is
// baked in: a windshield request additionally EXCLUDES any unit whose fairing is
// asserted (a fairing bike is NOT a windshield match), even if vision also
// (wrongly) flagged a windshield.
// ---------------------------------------------------------------------------
export type EquipmentQuery = Partial<Record<EquipmentFeatureKey, boolean>>;

export function matchesEquipmentQuery(profile: EquipmentProfile, query: EquipmentQuery): boolean {
  for (const key of EQUIPMENT_FEATURE_KEYS) {
    const want = query[key];
    if (want !== true) continue;
    const feat = profile.features[key];
    if (!feat?.asserted) return false;
    // Windshield ≠ fairing: a fairing unit can never satisfy a windshield ask.
    if (key === "windshield" && profile.features.fairing.asserted) return false;
  }
  return true;
}

// True when a query names at least one feature to shop by.
export function equipmentQueryHasFeatures(query: EquipmentQuery | null | undefined): boolean {
  if (!query) return false;
  return EQUIPMENT_FEATURE_KEYS.some(k => query[k] === true);
}

// ---------------------------------------------------------------------------
// Phase B — per-unit fail-safe classification for an equipment SEARCH. Governance
// (AGENTS.md never-fabricate, applied to equipment): we present a unit as "has X"
// ONLY when its cached profile ASSERTS every requested feature. Anything less than
// a confident assertion fails toward "looks like / let me confirm", never a false
// yes — and we never silently drop a possible match on a shaky/missing read.
//
//  - "asserted": profile present AND every requested feature is asserted true (and,
//    per Joe's windshield≠fairing ruling, no asserted fairing when a windshield was
//    requested). Safe to present.
//  - "excluded": profile present AND we are CONFIDENT the unit does NOT qualify — a
//    requested feature is confidently ABSENT (vision saw it absent at/above the
//    assertion floor), OR a windshield was requested and the unit's fairing is
//    asserted (a fairing bike is not a windshield match, Joe's ruling). Never shown.
//  - "uncertain": everything else — no profile yet, or a requested feature read
//    below the confidence floor. We may surface it ONLY with "looks like / let me
//    confirm" copy, never as a definite yes. Fail-safe: a bad photo angle that hides
//    a bag lands here, not in "excluded".
// ---------------------------------------------------------------------------
export type EquipmentMatchClass = "asserted" | "uncertain" | "excluded";

function confidentlyAbsent(feat: EquipmentFeatureProfile | undefined): boolean {
  return !!feat && !feat.detected && feat.confidence >= EQUIPMENT_ASSERTION_CONFIDENCE_MIN;
}

export function classifyUnitForEquipmentQuery(
  profile: EquipmentProfile | null | undefined,
  query: EquipmentQuery
): EquipmentMatchClass {
  // No profile → unknown. Don't assert, don't exclude a possible match (fail toward confirm).
  if (!profile) return "uncertain";
  let anyUncertain = false;
  for (const key of EQUIPMENT_FEATURE_KEYS) {
    if (query[key] !== true) continue;
    // Joe's ruling: a windshield ask on a unit whose fairing is asserted is a confident NON-match.
    if (key === "windshield" && profile.features.fairing.asserted) return "excluded";
    const feat = profile.features[key];
    if (feat?.asserted) continue; // confidently present
    if (confidentlyAbsent(feat)) return "excluded"; // confidently absent → not a match
    anyUncertain = true; // present-but-shaky or unseen → let me confirm
  }
  return anyUncertain ? "uncertain" : "asserted";
}

// Partition a set of candidate units (each paired with its resolved profile-or-null) into the three
// buckets for the reply. Pure; the caller resolves profiles (cache/on-demand) and owns the reply copy.
export type EquipmentCandidate<T> = { item: T; profile: EquipmentProfile | null };

export function partitionInventoryByEquipment<T>(
  candidates: EquipmentCandidate<T>[],
  query: EquipmentQuery
): { asserted: T[]; uncertain: T[]; excluded: T[] } {
  const asserted: T[] = [];
  const uncertain: T[] = [];
  const excluded: T[] = [];
  for (const c of candidates ?? []) {
    const cls = classifyUnitForEquipmentQuery(c.profile, query);
    if (cls === "asserted") asserted.push(c.item);
    else if (cls === "excluded") excluded.push(c.item);
    else uncertain.push(c.item);
  }
  return { asserted, uncertain, excluded };
}

// Human phrase for a query ("bags and a windshield"), for the reply copy. Order follows the taxonomy.
const EQUIPMENT_FEATURE_LABELS: Record<EquipmentFeatureKey, string> = {
  bags: "bags",
  windshield: "a windshield",
  fairing: "a fairing",
  backrestSissybar: "a backrest",
  tourpak: "a tour-pak",
  forwardControls: "forward controls",
  apeHangers: "ape hangers",
  floorboards: "floorboards",
  crashBars: "crash bars",
  // Cholo cues are never part of a shoppable equipment query, but the Record must be total.
  whitewalls: "whitewall tires",
  fatSpokeWheels: "fat spoke wheels",
  fishtailExhaust: "fishtail exhaust",
  soloSeat: "a solo seat",
  heavyChrome: "heavy chrome",
  lowStance: "a low stance",
  blackedOut: "a blacked-out finish"
};

export function describeEquipmentQuery(query: EquipmentQuery): string {
  const parts = EQUIPMENT_FEATURE_KEYS.filter(k => query[k] === true).map(k => EQUIPMENT_FEATURE_LABELS[k]);
  if (!parts.length) return "";
  if (parts.length === 1) return parts[0];
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join(", ")}, and ${parts[parts.length - 1]}`;
}

// ---------------------------------------------------------------------------
// Per-unit cache — keyed by stockId + a hash of the image-URL SET, so vision
// re-runs ONLY when a unit's photos change (the cost control, spec §6).
// Persisted alongside the feed cache under DATA_DIR.
// ---------------------------------------------------------------------------
export function imageSetHash(urls: string[] | undefined): string {
  const list = (Array.isArray(urls) ? urls : [])
    .map(u => String(u ?? "").trim())
    .filter(Boolean)
    .sort();
  return crypto.createHash("sha1").update(list.join("\n")).digest("hex").slice(0, 16);
}

export function equipmentCacheKey(item: Pick<InventoryFeedItem, "stockId" | "vin" | "images">): string {
  const id = String(item.stockId ?? item.vin ?? "").trim().toLowerCase() || "no-id";
  return `${id}::${imageSetHash(item.images)}`;
}

export type EquipmentCacheFile = { version: number; profiles: Record<string, EquipmentProfile> };

const EQUIPMENT_CACHE_FILE = "inventory_equipment_profiles.json";
const EQUIPMENT_CACHE_VERSION = 1;

export function equipmentCachePath(): string {
  return process.env.INVENTORY_EQUIPMENT_CACHE_PATH?.trim() || dataPath(EQUIPMENT_CACHE_FILE);
}

export async function loadEquipmentCache(): Promise<EquipmentCacheFile> {
  try {
    const raw = await fs.readFile(equipmentCachePath(), "utf8");
    const parsed = JSON.parse(raw) as EquipmentCacheFile;
    if (parsed && typeof parsed === "object" && parsed.profiles) {
      return { version: EQUIPMENT_CACHE_VERSION, profiles: parsed.profiles };
    }
  } catch (err: any) {
    if (err?.code !== "ENOENT") {
      console.warn("[inventory-equipment-vision] cache load failed", { message: err?.message ?? String(err) });
    }
  }
  return { version: EQUIPMENT_CACHE_VERSION, profiles: {} };
}

export async function saveEquipmentCache(cache: EquipmentCacheFile): Promise<void> {
  try {
    await fs.writeFile(equipmentCachePath(), JSON.stringify(cache, null, 2), "utf8");
  } catch (err: any) {
    console.warn("[inventory-equipment-vision] cache save failed", { message: err?.message ?? String(err) });
  }
}

export function inventoryEquipmentVisionEnabled(): boolean {
  return process.env.INVENTORY_EQUIPMENT_VISION_ENABLED === "1";
}

/**
 * Compute (or read from cache) the equipment profile for ONE unit. Vision runs
 * only on a cache miss (new stockId or a changed image set). Returns null when a
 * unit has no photos, when vision is disabled, or when the vision call fails —
 * the fail-safe: no profile ⇒ nothing is asserted downstream.
 */
export async function getUnitEquipmentProfile(
  item: InventoryFeedItem,
  opts?: { cache?: EquipmentCacheFile; forceRefresh?: boolean }
): Promise<{ profile: EquipmentProfile | null; cached: boolean; ranVision: boolean }> {
  const images = (item.images ?? []).filter(Boolean);
  if (!images.length) return { profile: null, cached: false, ranVision: false };
  const key = equipmentCacheKey(item);
  const cache = opts?.cache;
  if (!opts?.forceRefresh && cache?.profiles?.[key]) {
    return { profile: cache.profiles[key], cached: true, ranVision: false };
  }
  const desc = await describeUnitEquipmentWithLLM({ imageUrls: images, modelText: item.model ?? null });
  if (!desc) return { profile: null, cached: false, ranVision: true };
  const profile = buildEquipmentProfile({
    item,
    desc,
    imageHash: imageSetHash(item.images),
    imageCount: images.length
  });
  if (cache) cache.profiles[key] = profile;
  return { profile, cached: false, ranVision: true };
}

/**
 * DARK batch pass over the lot (spec §8 Phase A). Gated by
 * INVENTORY_EQUIPMENT_VISION_ENABLED + a per-run cap so a sweep can never run
 * away on cost. Refreshes only cache misses; persists the cache. Returns the
 * computed profiles + counters for the report. NOT wired to any customer path.
 */
export async function runEquipmentVisionPass(
  items: InventoryFeedItem[],
  opts?: { runCap?: number; forceRefresh?: boolean; persist?: boolean }
): Promise<{
  profiles: EquipmentProfile[];
  scanned: number;
  cacheHits: number;
  visionRuns: number;
  skippedNoPhotos: number;
  visionFailures: number;
  capped: boolean;
}> {
  const runCap = Math.max(0, opts?.runCap ?? Number(process.env.INVENTORY_EQUIPMENT_VISION_RUN_CAP ?? 25));
  const cache = await loadEquipmentCache();
  const profiles: EquipmentProfile[] = [];
  let cacheHits = 0;
  let visionRuns = 0;
  let skippedNoPhotos = 0;
  let visionFailures = 0;
  let capped = false;

  for (const item of items) {
    if (!(item.images ?? []).filter(Boolean).length) {
      skippedNoPhotos++;
      continue;
    }
    // Cache hits are free — always take them. Only NEW vision calls count against the cap.
    const key = equipmentCacheKey(item);
    const willRunVision = opts?.forceRefresh || !cache.profiles[key];
    if (willRunVision && visionRuns >= runCap) {
      capped = true;
      continue;
    }
    const res = await getUnitEquipmentProfile(item, { cache, forceRefresh: opts?.forceRefresh });
    if (res.cached) cacheHits++;
    if (res.ranVision) visionRuns++;
    if (res.ranVision && !res.profile) visionFailures++;
    if (res.profile) profiles.push(res.profile);
  }

  if (opts?.persist !== false) await saveEquipmentCache(cache);
  return {
    profiles,
    scanned: profiles.length,
    cacheHits,
    visionRuns,
    skippedNoPhotos,
    visionFailures,
    capped
  };
}

// ---------------------------------------------------------------------------
// Equipment WATCHES — profile-on-arrival + the fire-match gate (canary).
// ---------------------------------------------------------------------------

/**
 * PROFILE-ON-ARRIVAL. Called by the watch-fire engine's arrival sweep so a NEWLY-arrived unit gets
 * an equipment profile BEFORE its watches are evaluated — the prerequisite for an equipment watch to
 * fire on arrival. Bounded to the arrival set the caller passes (NEW stockIds only), per-run capped,
 * and free on cache hits (vision runs ONLY on a genuinely new stockId / changed photo set). The
 * caller flag-gates this (INVENTORY_EQUIPMENT_VISION_ENABLED). This is NOT the whole-lot background
 * refresh (that is a separate follow-up) — it only touches the arrivals handed to it. Fail-safe: a
 * vision failure leaves the unit unprofiled, so nothing is asserted and no equipment watch fires on it.
 */
export async function profileArrivedUnitsForEquipment(
  arrivedItems: InventoryFeedItem[],
  cache: EquipmentCacheFile,
  opts?: { runCap?: number }
): Promise<{ profiled: number; visionRuns: number; capped: boolean; skippedNoPhotos: number; cacheHits: number }> {
  const runCap = Math.max(0, opts?.runCap ?? Number(process.env.INVENTORY_EQUIPMENT_ARRIVAL_VISION_CAP ?? 8));
  let profiled = 0;
  let visionRuns = 0;
  let capped = false;
  let skippedNoPhotos = 0;
  let cacheHits = 0;
  for (const item of arrivedItems ?? []) {
    if (!(item.images ?? []).filter(Boolean).length) {
      skippedNoPhotos++;
      continue;
    }
    const key = equipmentCacheKey(item);
    if (cache.profiles?.[key]) {
      cacheHits++; // already profiled — free, no vision
      continue;
    }
    if (visionRuns >= runCap) {
      capped = true;
      continue;
    }
    const res = await getUnitEquipmentProfile(item, { cache });
    if (res.ranVision) visionRuns++;
    if (res.profile) profiled++;
  }
  return { profiled, visionRuns, capped, skippedNoPhotos, cacheHits };
}

/**
 * The equipment FIRE-MATCH gate (pure). An arriving unit passes when the watch carries no equipment
 * (a model-only watch — the gate is a NO-OP, behavior UNCHANGED) OR its cached profile ASSERTS every
 * requested feature. FAIL-SAFE: an unprofiled unit (profile null) or a below-assertion-threshold read
 * is NOT a fire — classifyUnitForEquipmentQuery returns "uncertain"/"excluded", so this returns false
 * and the engine holds off rather than sending a false "your bike came in." windshield≠fairing is
 * enforced inside classifyUnitForEquipmentQuery (a fairing unit never satisfies a windshield ask).
 *
 * This is ANDed with the existing model/family/year/condition/price match (inventoryItemMatchesWatch),
 * never a replacement for it — an equipment watch still must match the model/segment criteria first.
 * The caller flag-gates it: with the flag off the gate is skipped entirely and the watch fires as a
 * plain model watch (equipment ignored), so model-only watches are unaffected either way.
 */
export function watchEquipmentFireGate(
  profile: EquipmentProfile | null | undefined,
  requestedEquipment: EquipmentQuery | null | undefined
): boolean {
  if (!equipmentQueryHasFeatures(requestedEquipment)) return true; // model-only watch → no-op
  return classifyUnitForEquipmentQuery(profile ?? null, requestedEquipment as EquipmentQuery) === "asserted";
}
