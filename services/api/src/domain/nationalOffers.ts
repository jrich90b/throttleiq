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
  opts?: {
    excludeTitles?: string[];
    firstName?: string | null;
    /** Lead unit condition (leadUnitConditionForOfferMatch). Omitted = "unknown" = treated like used. */
    condition?: LeadUnitCondition;
    /**
     * Rider-training-graduate eligibility (leadRiderTrainingEligibilityForOffer). Omitted =
     * "not_evident" = the lead never sees a rider-training grad offer (Joe ruling 2026-07-23).
     */
    riderEligibility?: RiderTrainingEligibility;
    /**
     * The lead has raised money themselves (leadShowedMoneyInterest). Omitted = they haven't, and
     * only non-financing offers (a straight discount) can apply.
     */
    showedMoneyInterest?: boolean;
  }
): Promise<NationalOfferMatch | null> {
  if (!isNationalOffersEnabled()) return null;
  const veh = String(vehicle ?? "").trim();
  if (!veh) return null;
  const condition: LeadUnitCondition = opts?.condition ?? "unknown";
  // Deterministic pre-filters BEFORE the LLM sees the offer list (fail direction = fewer offers):
  // - Dedup: a promotion already texted to this lead never fires again (Joe 2026-07-20).
  // - NEW-bike promo scope (Joe 2026-07-22): a used/unknown-condition lead only ever sees explicitly-used offers.
  // - Rider-training grad scope (Joe 2026-07-23): a lead without affirmative rider-training eligibility
  //   never sees a Riding Academy graduate offer (the +17164812815 grad-APR miss).
  // - Money scope (2026-08-01): a lead who never raised financing/payments/budget themselves only
  //   sees straight discounts, never an offer quoting a rate or a monthly payment.
  const offers = filterOffersForMoneyInterest(
    filterOffersForRiderEligibility(
      filterOffersForLeadCondition(
        filterOffersForDedup(await getNationalOffers(), opts?.excludeTitles ?? []),
        condition
      ),
      opts?.riderEligibility ?? "not_evident"
    ),
    // Omitted = never raised money = only straight discounts survive (fail toward quiet).
    !!opts?.showedMoneyInterest
  );
  if (offers.length === 0) return null;
  const match = await matchNationalOfferToLeadWithLLM({
    vehicle: veh,
    offers,
    firstName: opts?.firstName,
    condition
  });
  if (!match || !match.applies || !match.message) return null;
  // IDENTITY SNAP-BACK. The ledger that stops a promo repeating is keyed on the offer title, but the
  // title the model writes is free text and drifts run to run: +16102170861 banked "Select Grand
  // American Touring Models Extended-Term Monthly Payment" on 7/21 and "Grand American Touring models
  // Extended Term Monthly Payment" on 8/1 — one promo, two keys, so it never matched itself and the
  // same payment quote went out twice (+17163812367 got it on consecutive days). Resolve the model's
  // pick back to the offer we actually sent it and bank THAT title, so the ledger compares like with
  // like. Fail direction: an unresolvable pick returns null (stay quiet) rather than firing a promo
  // we cannot remember having sent.
  const canonical = resolveMatchedOffer(match, offers);
  if (!canonical) return null;
  return { ...match, offerTitle: canonical.title };
}

/**
 * Resolve the model's pick back to one of the offers we actually gave it. Index first (an integer
 * cannot drift); normalized title only as a fallback for a model that omitted the index. Returns
 * null when the pick matches nothing — the caller then stays quiet.
 */
export function resolveMatchedOffer(
  match: { offerIndex?: number | null; offerTitle?: string },
  offers: NationalOffer[]
): NationalOffer | null {
  const list = Array.isArray(offers) ? offers : [];
  const idx = match?.offerIndex;
  if (typeof idx === "number" && Number.isInteger(idx) && idx >= 0 && idx < list.length) return list[idx];
  const wanted = normalizeOfferTitle(String(match?.offerTitle ?? ""));
  if (!wanted) return null;
  return list.find(o => normalizeOfferTitle(o.title) === wanted) ?? null;
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

/**
 * Go-live switch for the anti-spam behavior itself (suppress filler / inject offers).
 * Default ON since 2026-07-23 (graduated after the 7-conversation cadence_quality_suppressed
 * stream showed the judge repeatedly eating exactly the filler this gate suppresses at the
 * source). Kill switch: set CADENCE_VALUE_GATE_ENABLED=0 in the runtime env + redeploy.
 */
export function isCadenceValueGateEnabled(): boolean {
  const v = String(process.env.CADENCE_VALUE_GATE_ENABLED ?? "1").trim().toLowerCase();
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

/**
 * First value-gated step for an ENGAGED cadence (the customer replied, then went quiet —
 * stepIndex resets to 0 on a substantive inbound). The standard min-step (3) does NOT cover
 * early engaged filler: +17165146963 got a contentless "If the timing shifted, all good..."
 * bump at engaged step ~1, two days after their last reply, which the cadence-quality judge
 * suppressed as spam. Step 0 (the day-1 contextual pick-the-thread-back-up bump) still always
 * fires; from step 1 on, an engaged touch needs a genuine value trigger like any later touch.
 */
export function cadenceValueGateEngagedMinStep(): number {
  const raw = String(process.env.CADENCE_VALUE_GATE_ENGAGED_MIN_STEP ?? "").trim();
  if (!raw) return 1; // unset env falls to the default; step 0 is never gated by default
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 1;
}

/**
 * The lead's bike-of-interest CONDITION for offer matching (Joe ruling, 2026-07-22):
 * H-D national promotional offers are written for NEW motorcycles unless they say otherwise,
 * and one was texted onto a USED 2021 Street Glide Special (+17165104578, "$406/month with
 * 10% down"). Structured extraction, not comprehension: reads the lead vehicle's parsed
 * condition (adfParser normalizeCondition), else the inventory context's.
 *
 * "new_model_interest" (a classification the intake writes for new-lineup shoppers) counts
 * as new. Anything unrecognized — including a missing condition — is "unknown", which the
 * filter below treats like used (fail toward staying quiet, the same conservative default
 * as the post-sale cadence's new-vs-preowned rule).
 */
export type LeadUnitCondition = "new" | "used" | "unknown";

export function leadUnitConditionForOfferMatch(conv: {
  lead?: any;
  inventoryContext?: any;
}): LeadUnitCondition {
  const raw =
    [
      (conv?.lead?.vehicle as any)?.condition,
      (conv?.inventoryContext as any)?.condition
    ]
      .map(v => String(v ?? "").trim().toLowerCase())
      .find(Boolean) ?? "";
  if (raw === "new" || raw === "new_model_interest") return "new";
  if (/used|pre-?owned/.test(raw)) return "used";
  return "unknown";
}

/** Does the offer's own parsed text explicitly say it covers used/pre-owned bikes? */
export function offerExplicitlyCoversUsed(offer: NationalOffer): boolean {
  const hay = [offer?.title, offer?.appliesTo, offer?.terms, offer?.eligibility]
    .map(v => String(v ?? ""))
    .join(" ");
  return /\b(used|pre-?owned)\b/i.test(hay);
}

/**
 * NEW-bike promo scope (Joe, 2026-07-22): a lead on a NEW unit may see every offer; a lead
 * on a USED (or unknown-condition) unit may only see offers that EXPLICITLY cover used bikes
 * (e.g. the Riding Academy graduate used-APR offer). Deterministic pre-filter ahead of the
 * LLM matcher — the fail direction is "fewer offers → quieter", never a misapplied promo.
 */
export function filterOffersForLeadCondition(
  offers: NationalOffer[],
  condition: LeadUnitCondition
): NationalOffer[] {
  if (condition === "new") return offers;
  return offers.filter(offerExplicitlyCoversUsed);
}

// === Rider-training-graduate eligibility gate (Joe ruling 2026-07-23) =============================
// A national offer scoped to Riding Academy / rider-training GRADUATES (a beginner-rider financing
// program, e.g. the 6.64% grad used-APR) may ONLY be pitched to a lead affirmatively known to be a
// new/unlicensed rider OR who referenced the Academy / rider course. Production miss: +17164812815
// (Selviana) got the grad-APR pitch on 7/22 and replied she's ridden for years with a license.
// This mirrors the new-vs-used condition gate: a deterministic pre-filter ahead of the LLM matcher.
// Fail direction is "no offer": ABSENT affirmative eligibility evidence, the grad offer is dropped
// (stay quiet), never pitched to an unknown/experienced rider.

/** Affirmative eligibility evidence for a rider-training-graduate offer, or "not_evident" (absent). */
export type RiderTrainingEligibility = "eligible" | "not_evident";

/**
 * Does the offer's OWN parsed text scope it to rider-training / Riding Academy graduates (a
 * beginner-rider financing program)? Deterministic read of our parsed offer format
 * (title/appliesTo/terms/eligibility) — structured extraction, the same shape as
 * offerExplicitlyCoversUsed, not a read of any customer message.
 */
export function offerRequiresRiderTrainingEligibility(offer: NationalOffer): boolean {
  const hay = [offer?.title, offer?.appliesTo, offer?.terms, offer?.eligibility]
    .map(v => String(v ?? ""))
    .join(" ");
  return /\b(riding academy|rider training|rider(?:'s)? course|rider education|msf(?: course)?|graduate)\b/i.test(hay);
}

/**
 * The lead's rider-training-graduate eligibility, from structured lead data + persisted parser
 * signals (never a fresh regex over customer text — parser-first law):
 *  - lead.hasMotoLicense === false → explicitly unlicensed → a new rider → "eligible";
 *  - the thread's persisted dialogState is first_time_rider or rider_course_info (the intent
 *    classifier's output — they referenced the rider course / are a first-timer) → "eligible".
 * Anything else — including no evidence either way — is "not_evident" (fail toward NOT pitching a
 * beginner offer to an experienced rider).
 */
export function leadRiderTrainingEligibilityForOffer(conv: {
  lead?: any;
  dialogState?: { name?: string } | null;
}): RiderTrainingEligibility {
  if ((conv?.lead as any)?.hasMotoLicense === false) return "eligible";
  const state = String(conv?.dialogState?.name ?? "").trim().toLowerCase();
  if (state === "first_time_rider" || state === "rider_course_info") return "eligible";
  return "not_evident";
}

/**
 * A lead without affirmative rider-training eligibility never sees a rider-training-graduate offer.
 * Deterministic pre-filter ahead of the LLM matcher; fail direction is "fewer offers → quieter".
 */
export function filterOffersForRiderEligibility(
  offers: NationalOffer[],
  eligibility: RiderTrainingEligibility
): NationalOffer[] {
  if (eligibility === "eligible") return offers;
  return offers.filter(o => !offerRequiresRiderTrainingEligibility(o));
}

/**
 * Does this offer QUOTE FINANCING TERMS (a monthly payment, a rate) as opposed to being a straight
 * discount? The distinction matters because the two are different speech acts: "$1,000 off that
 * bike" is good news anyone shopping wants; "$406/month with 10% down for 96 months" presumes the
 * customer is financing and is the thing we were volunteering at people who never raised money.
 *
 * FAIL DIRECTION: an unrecognized/blank offerType counts as financing terms — an offer we can't
 * classify gets the stricter gate, so we err toward quiet rather than toward quoting money.
 */
export function offerQuotesFinancingTerms(offer: NationalOffer): boolean {
  const t = String(offer?.offerType ?? "").trim().toLowerCase();
  return t !== "customer_cash" && t !== "rebate_credit" && t !== "discount";
}

/**
 * Has this lead ever shown us they're thinking about MONEY — financing, payments, or a budget?
 * Reads only structured state the parsers already persisted (never customer prose):
 *   - classification.bucket "finance_prequal" — they came in on a credit app / finance lead;
 *   - lastIntent "pricing"/"payments" — a parsed money turn;
 *   - paymentBudgetContext — they told us a monthly budget.
 * Deliberately EXCLUDES financeAppInviteSentAt: that records US offering, not them asking, and
 * using it would let one unsolicited pitch authorize the next.
 *
 * Measured against every lead that has ever received an offer touch (2026-08-01): this separates
 * the three real misses (+16813891971 "just shopping around", +12109976639 "cover the difference
 * outright", +17169079662) from the two legitimate finance leads (+17164812815, +17163812367).
 */
export function leadShowedMoneyInterest(conv: {
  classification?: { bucket?: string } | null;
  lastIntent?: { name?: string } | null;
  paymentBudgetContext?: unknown;
}): boolean {
  if (String(conv?.classification?.bucket ?? "").trim().toLowerCase() === "finance_prequal") return true;
  const intent = String(conv?.lastIntent?.name ?? "").trim().toLowerCase();
  if (intent === "pricing" || intent === "payments") return true;
  return !!conv?.paymentBudgetContext;
}

/**
 * A lead who has never raised money never sees an offer that quotes financing terms — a straight
 * discount still passes. Deterministic pre-filter ahead of the LLM matcher, same shape as the
 * condition and rider-eligibility filters above; fail direction is "fewer offers → quieter".
 */
export function filterOffersForMoneyInterest(
  offers: NationalOffer[],
  showedMoneyInterest: boolean
): NationalOffer[] {
  if (showedMoneyInterest) return offers;
  return offers.filter(o => !offerQuotesFinancingTerms(o));
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
  /**
   * The persisted followUpCadence.kind ("standard" | "engaged" | ...). An "engaged" cadence
   * (step counter re-anchored to the customer's last reply) is value-gated from
   * cadenceValueGateEngagedMinStep (default 1) instead of the standard min step (default 3),
   * because a contentless bump 2 days after the customer's own reply is exactly the filler
   * the judge suppresses. Omitted/unknown kinds keep the standard scoping.
   */
  cadenceKind?: string | null;
  /** Lead unit condition (leadUnitConditionForOfferMatch) — used/unknown leads only see explicitly-used offers. */
  vehicleCondition?: LeadUnitCondition;
  /**
   * Rider-training-graduate eligibility (leadRiderTrainingEligibilityForOffer) — a lead without
   * affirmative eligibility never sees a Riding Academy grad offer (Joe ruling 2026-07-23).
   */
  riderEligibility?: RiderTrainingEligibility;
  firstName?: string | null;
  /** Offer titles already texted to this lead (conv.nationalOfferTouches) — same promo never repeats. */
  alreadySentOfferTitles?: string[];
  /** Live test-ride context (wants a ride, nothing booked) — the contextual invite is a value touch. */
  hasTestRideOffer?: boolean;
  /** A fired price drop on their unit of interest (priceDropWatch.resolveInterestUnitPriceDrop). */
  priceDropMessage?: string | null;
  /**
   * The lead's exact unit of interest is on HOLD or SOLD (leadUnitUnavailableForValueGate).
   *
   * Joe ruling 2026-07-28 — Jason Roorda +17165104578: the agent disclosed on 6/20 that his 2021
   * Street Glide Special was on hold, and then pitched that same bike's numbers on 7/20, 7/21 and
   * in a 7/26 draft ("that 2021 Street Glide Special qualifies for the used financing program…
   * want me to run a payment estimate?"). Open-critic caught it as promised_unit_not_in_stock.
   *
   * The disclosure path is not the bug — it correctly says "it's gone" ONCE and then goes quiet so
   * the customer isn't nagged. The bug is that going quiet about the hold let the VALUE gate go on
   * pitching the unit as though it were available. A national offer and a price drop are both
   * unit-specific by construction, so neither is sayable about a bike we can't sell.
   */
  leadUnitUnavailable?: boolean;
  /**
   * The customer has ever engaged (customerEngagedWithCadence) — any real inbound message, or a
   * voice call they actually took part in. A national offer quotes PAYMENT FIGURES, so we only
   * volunteer one to a lead who has spoken to us at least once (+16102170861, Seth Farrand: a
   * never-replied trade-appraisal lead was texted "$406/month with 10% down for 96 months").
   * Omitted = not engaged: fail toward quiet, never toward an unsolicited money claim.
   */
  customerEverEngaged?: boolean;
  /**
   * The lead has raised financing/payments/budget themselves (leadShowedMoneyInterest). Omitted =
   * they haven't, and an offer that QUOTES FINANCING TERMS is filtered out before the matcher —
   * a straight discount still gets through. Engagement and money-interest are different questions:
   * +16813891971 replied ("just shopping around, what would I get for my dirtbike") so he is
   * engaged, and still had no business being quoted a rate.
   */
  showedMoneyInterest?: boolean;
}): Promise<CadenceValueGateResult> {
  if (!isCadenceValueGateEnabled()) return { action: "send", reason: "gate_disabled" };
  if (args.isPostSale) return { action: "send", reason: "post_sale_exempt" };
  const isEngagedCadence = String(args.cadenceKind ?? "").trim().toLowerCase() === "engaged";
  const minStep = isEngagedCadence ? cadenceValueGateEngagedMinStep() : cadenceValueGateMinStep();
  const isLaterStage = Number(args.stepIndex ?? 0) >= minStep;
  if (!isLaterStage) return { action: "send", reason: "early_stage_touch" };
  if (args.hasValueOverride) return { action: "send", reason: "existing_value_override" };
  // A held/sold unit of interest kills BOTH unit-specific value kinds (offer and price drop) —
  // suppress before the matcher runs, so we also spend no LLM call pricing a bike we can't sell.
  // Ordered AFTER hasValueOverride on purpose: the availability/held-inventory overrides ARE the
  // correct thing to say about a gone unit, and they own that turn when they fire.
  if (args.leadUnitUnavailable) return { action: "suppress", reason: "lead_unit_unavailable" };
  // A never-engaged lead is never pitched payment figures, so skip the matcher entirely — same
  // reason the held-unit guard sits above it: we spend no LLM call quoting a lead we won't quote.
  const offer = args.customerEverEngaged
    ? await findNationalOfferForVehicle(args.vehicleLabel, {
        excludeTitles: args.alreadySentOfferTitles ?? [],
        firstName: args.firstName,
        condition: args.vehicleCondition ?? "unknown",
        riderEligibility: args.riderEligibility ?? "not_evident",
        showedMoneyInterest: !!args.showedMoneyInterest
      })
    : null;
  const decision = decideProactiveCadenceValue({
    isLaterStage: true,
    hasNationalOfferMatch: !!offer,
    customerEverEngaged: !!args.customerEverEngaged,
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
