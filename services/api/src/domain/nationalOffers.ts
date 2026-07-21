/**
 * National Offers — the value source for high-quality proactive cadences (Joe 2026-07-20).
 *
 * The later proactive cadence must be VALUE-gated, never generic "just checking in" spam. One of the
 * value triggers is a real, model-specific Harley-Davidson NATIONAL offer on the lead's bike of
 * interest. This module owns the ingestion side: fetch the H-D national offers page, comprehend it
 * with a typed parser (parseNationalOffersWithLLM), cache the structured result, and expose a matcher
 * (matchNationalOfferToLeadWithLLM) so the cadence can send "you can get on a Grand American Touring
 * model like your Electra Glide for under $406/mo" instead of a filler nudge.
 *
 * Source choice (2026-07-20 investigation): the DEALER promotions page
 * (americanharley-davidson.com/promotions) is Cloudflare + JS-blocked and has no feed. The H-D
 * NATIONAL offers page is fetchable server-side (plain GET, offers in the raw HTML) and its offers
 * are national — they apply to every dealer's leads. So national is the reliable source; a small
 * dealer-maintained list can supplement LOCAL-only promos later.
 *
 * DARK BY DEFAULT: everything here is gated by NATIONAL_OFFERS_ENABLED (unset/"0" = off). With the
 * flag off, getNationalOffers() returns [] and the cadence value-gate sees no offer trigger — zero
 * behavior change until cutover. Fail direction is always "no offer" (stay quiet), never fabricate.
 */
import {
  parseNationalOffersWithLLM,
  matchNationalOfferToLeadWithLLM,
  type NationalOffer,
  type NationalOfferMatch
} from "./llmDraft.js";

export type { NationalOffer, NationalOfferMatch };

/** H-D national offers page (Joe's pointer). Override with NATIONAL_OFFERS_URL. */
export const DEFAULT_NATIONAL_OFFERS_URL = "https://www.harley-davidson.com/us/en/tools/offers.html";

// Offers change ~monthly; a 12h cache keeps us fresh without hammering the page. Stale served on error.
const CACHE_TTL_MS = 12 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 15000;
const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

let cache: { offers: NationalOffer[]; loadedAt: number } | null = null;

export function isNationalOffersEnabled(): boolean {
  const v = String(process.env.NATIONAL_OFFERS_ENABLED ?? "0").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

function resolveOffersUrl(): string {
  return String(process.env.NATIONAL_OFFERS_URL ?? "").trim() || DEFAULT_NATIONAL_OFFERS_URL;
}

/** Strip an HTML page to visible text for the typed parser (deterministic; extraction, not comprehension). */
export function stripHtmlToText(html: string): string {
  const noScript = String(html ?? "").replace(/<(script|style|noscript)[^>]*>[\s\S]*?<\/\1>/gi, " ");
  const noTags = noScript.replace(/<[^>]+>/g, " ");
  const decoded = noTags
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#\d+;/g, " ")
    .replace(/&[a-z]+;/gi, " ");
  return decoded.replace(/\s+/g, " ").trim();
}

async function fetchOffersText(url: string): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      headers: { "User-Agent": BROWSER_UA, Accept: "text/html,application/xhtml+xml,*/*" },
      signal: controller.signal
    });
    if (!r.ok) {
      console.warn("[national-offers] fetch failed", { status: r.status, url });
      return null;
    }
    const html = await r.text();
    const text = stripHtmlToText(html);
    return text.length >= 40 ? text : null;
  } catch (err: any) {
    console.warn("[national-offers] fetch error", {
      reason: err?.name === "AbortError" ? "timeout" : "fetch_error",
      message: err?.message ?? String(err)
    });
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Current structured national offers (cached). Returns [] when the feature is off, the fetch fails
 * with no cached copy, or the parser can't read the page — the safe empty result. On refresh error a
 * previously-cached set is served stale rather than dropping to empty.
 */
export async function getNationalOffers(opts?: { bypassCache?: boolean }): Promise<NationalOffer[]> {
  if (!isNationalOffersEnabled()) return [];
  const now = Date.now();
  if (!opts?.bypassCache && cache && now - cache.loadedAt < CACHE_TTL_MS) return cache.offers;
  const stale = cache?.offers ?? [];
  const text = await fetchOffersText(resolveOffersUrl());
  if (!text) return stale;
  const offers = await parseNationalOffersWithLLM(text);
  if (!offers || offers.length === 0) return stale;
  cache = { offers, loadedAt: now };
  return offers;
}

/**
 * Match the current national offers to a lead's bike of interest. Returns a NationalOfferMatch when a
 * genuine, model-specific offer applies (with the on-voice message), or null when nothing applies /
 * the feature is off / inputs are thin — in which case the cadence simply has no national-offer value
 * trigger this turn (it stays quiet unless another trigger fires).
 */
export async function findNationalOfferForVehicle(
  vehicle: string,
  opts?: { excludeTitles?: string[]; firstName?: string | null }
): Promise<NationalOfferMatch | null> {
  if (!isNationalOffersEnabled()) return null;
  const veh = String(vehicle ?? "").trim();
  if (!veh) return null;
  const offers = filterOffersForDedup(await getNationalOffers(), opts?.excludeTitles ?? []);
  if (offers.length === 0) return null;
  const match = await matchNationalOfferToLeadWithLLM({ vehicle: veh, offers, firstName: opts?.firstName });
  if (!match || !match.applies || !match.message) return null;
  return match;
}

/**
 * Dedup (Joe 2026-07-20): the SAME promotion is never texted to a lead twice — a DIFFERENT one may
 * fire. Key = the normalized offer title, so a re-worded page tweak of the same promo still dedups
 * while a genuinely new offer passes.
 */
export function normalizeOfferTitle(title: string): string {
  return String(title ?? "")
    .toLowerCase()
    .replace(/(\d),(\d)/g, "$1$2") // "$1,000" and "$1000" are the same promotion
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function filterOffersForDedup(offers: NationalOffer[], sentTitles: string[]): NationalOffer[] {
  const sent = new Set(sentTitles.map(normalizeOfferTitle).filter(Boolean));
  if (sent.size === 0) return offers;
  return offers.filter(o => !sent.has(normalizeOfferTitle(o.title)));
}

/** Test seam: reset the module cache (used by the report/eval to force a fresh read). */
export function __resetNationalOffersCache(): void {
  cache = null;
}

// === The cadence value gate — the SHARED applier both paths call (route-parity law) ==============
// decideProactiveCadenceValue (routeStateReducer.ts) is the pure precedence decision; this helper is
// the single composition both /webhooks/twilio's cadence tick and /conversations/:id/regenerate's
// cadence builder invoke, so the two paths cannot drift (same pattern as decideFinancePricingTurn).
import { decideProactiveCadenceValue } from "./routeStateReducer.js";

/** Go-live switch for the anti-spam behavior itself (suppress filler / inject offers). Default OFF. */
export function isCadenceValueGateEnabled(): boolean {
  const v = String(process.env.CADENCE_VALUE_GATE_ENABLED ?? "0").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

/**
 * First value-gated step. Steps 0-2 (the day 1/2/3 engagement sequence) always fire; from this step
 * on (day-5+ in FOLLOW_UP_DAY_OFFSETS) a proactive touch needs a genuine value trigger.
 */
export function cadenceValueGateMinStep(): number {
  const raw = String(process.env.CADENCE_VALUE_GATE_MIN_STEP ?? "").trim();
  if (!raw) return 3; // Number("") is 0, not NaN — an unset env must fall to the default, never gate step 0
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 3;
}

/** The lead's bike-of-interest label for offer matching (lead vehicle, else the inventory watch). */
export function vehicleLabelForOfferMatch(conv: { lead?: any; inventoryWatch?: any }): string {
  const v = (conv?.lead?.vehicle ?? {}) as any;
  let label = ["year", "make", "model", "trim"]
    .map(k => String(v?.[k] ?? "").trim())
    .join(" ")
    .trim();
  if (!label) {
    const w = (conv?.inventoryWatch ?? {}) as any;
    label = ["make", "model"].map(k => String(w?.[k] ?? "").trim()).join(" ").trim();
  }
  return label.replace(/\s+/g, " ").trim();
}

export type CadenceValueGateResult =
  | { action: "send"; reason: string }
  | { action: "replace"; kind: "national_offer" | "price_drop"; message: string; offerTitle: string; reason: string }
  | { action: "suppress"; reason: string };

/**
 * Evaluate a due proactive cadence touch against the value gate.
 * - Gate off / early step / an existing value override (lead-unit availability, held-inventory,
 *   manual test-ride) → "send" (unchanged behavior).
 * - Later step with a live test-ride context → "send" (the contextual scheduling invite IS the value).
 * - Later filler step + a genuine national offer on their bike (not already sent — dedup by title)
 *   → "replace" with the offer message; + a price drop on their unit → "replace" with the drop.
 * - Later filler step + no value trigger → "suppress" (stay quiet — the anti-spam outcome).
 * Precedence lives in decideProactiveCadenceValue (routeStateReducer): inventory > national offer >
 * test-ride > price drop. The LLM matcher runs ONLY on later filler steps, and only when
 * NATIONAL_OFFERS_ENABLED is on; with offers dark the gate suppresses filler with zero LLM calls.
 * Fail direction on any matcher failure: no offer → suppress (silence), never a fabricated offer.
 */
export async function evaluateProactiveCadenceValueGate(args: {
  stepIndex: number;
  isPostSale: boolean;
  hasValueOverride: boolean;
  vehicleLabel: string;
  firstName?: string | null;
  /** Offer titles already texted to this lead (conv.nationalOfferTouches) — same promo never repeats. */
  alreadySentOfferTitles?: string[];
  /** Live test-ride context (wants a ride, nothing booked) — the contextual invite is a value touch. */
  hasTestRideOffer?: boolean;
  /** A fired price drop on their unit of interest (priceDropWatch.resolveInterestUnitPriceDrop). */
  priceDropMessage?: string | null;
}): Promise<CadenceValueGateResult> {
  if (!isCadenceValueGateEnabled()) return { action: "send", reason: "gate_disabled" };
  if (args.isPostSale) return { action: "send", reason: "post_sale_exempt" };
  const isLaterStage = Number(args.stepIndex ?? 0) >= cadenceValueGateMinStep();
  if (!isLaterStage) return { action: "send", reason: "early_stage_touch" };
  if (args.hasValueOverride) return { action: "send", reason: "existing_value_override" };
  const offer = await findNationalOfferForVehicle(args.vehicleLabel, {
    excludeTitles: args.alreadySentOfferTitles ?? [],
    firstName: args.firstName
  });
  const decision = decideProactiveCadenceValue({
    isLaterStage: true,
    hasNationalOfferMatch: !!offer,
    hasTestRideOffer: !!args.hasTestRideOffer,
    hasPriceDrop: !!String(args.priceDropMessage ?? "").trim()
  });
  if (!decision.fire) return { action: "suppress", reason: decision.reason };
  if (decision.valueKind === "national_offer" && offer) {
    return { action: "replace", kind: "national_offer", message: offer.message, offerTitle: offer.offerTitle, reason: decision.reason };
  }
  if (decision.valueKind === "price_drop") {
    return {
      action: "replace",
      kind: "price_drop",
      message: String(args.priceDropMessage ?? "").trim(),
      offerTitle: "",
      reason: decision.reason
    };
  }
  // test_ride (the existing contextual invite is the message) — let the touch through unchanged.
  return { action: "send", reason: decision.reason };
}
