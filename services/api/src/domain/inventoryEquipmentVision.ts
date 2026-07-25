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
  "crashBars"
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
};

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

  if (prior.fairing === "expected") {
    // Model says fairing. Vision calling it a windshield is the wrong-match trap → penalize windshield.
    if (windshield.present && !fairing.present) {
      windshield = penalize(windshield);
      return {
        windshield,
        fairing,
        agreement: "disagree",
        note: "model is a fairing bike but vision read a windshield — windshield confidence lowered"
      };
    }
    if (fairing.present) return { windshield, fairing, agreement: "agree", note: "fairing model + vision saw a fairing" };
    return { windshield, fairing, agreement: "na", note: "fairing model but vision saw neither clearly" };
  }

  if (prior.windshield === "expected") {
    // Model is a separate-windshield bike. Vision calling it a fairing disagrees → penalize fairing.
    if (fairing.present && !windshield.present) {
      fairing = penalize(fairing);
      return {
        windshield,
        fairing,
        agreement: "disagree",
        note: "windshield model but vision read a fairing — fairing confidence lowered"
      };
    }
    if (windshield.present) return { windshield, fairing, agreement: "agree", note: "windshield model + vision saw a windshield" };
    return { windshield, fairing, agreement: "na", note: "windshield model but vision saw neither clearly" };
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
    crashBars: assertedFeature(desc.crashBars)
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
    notes: desc.notes
  };
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

type EquipmentCacheFile = { version: number; profiles: Record<string, EquipmentProfile> };

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
