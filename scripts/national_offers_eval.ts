/**
 * national_offers:eval — pins the high-quality-cadence value gate + the national-offers ingestion
 * being DARK by default (Joe 2026-07-20: later cadences must be value-gated, never spam).
 *
 * 1. decideProactiveCadenceValue decision-table: early touches always fire; a LATER touch fires ONLY
 *    on a genuine value trigger (matching inventory / national offer / test-ride / price drop) with the
 *    documented precedence, else STAYS QUIET (the anti-spam behavior).
 * 2. stripHtmlToText is deterministic + safe.
 * 3. Source guards: both typed parsers are gated by NATIONAL_OFFERS_ENABLED (default OFF), the module
 *    returns [] / null when disabled, and the source is the H-D NATIONAL offers page. The feature ships
 *    dark — nothing changes live until the flag is flipped.
 */
import fs from "node:fs";
import path from "node:path";
import { decideProactiveCadenceValue } from "../services/api/src/domain/routeStateReducer.ts";
import {
  stripHtmlToText,
  isNationalOffersEnabled,
  DEFAULT_NATIONAL_OFFERS_URL,
  leadUnitConditionForOfferMatch,
  offerExplicitlyCoversUsed,
  filterOffersForLeadCondition,
  type NationalOffer
} from "../services/api/src/domain/nationalOffers.ts";

const failures: string[] = [];
const eq = (id: string, actual: unknown, expected: unknown) => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    failures.push(`  - ${id}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
};

// --- 1. decision-table -------------------------------------------------------
const D = decideProactiveCadenceValue;
eq("early_touch_always_fires", D({ isLaterStage: false }), { fire: true, valueKind: null, reason: "early_stage_touch" });
eq("early_touch_fires_even_with_no_value", D({ isLaterStage: false, hasNationalOfferMatch: false }), { fire: true, valueKind: null, reason: "early_stage_touch" });
eq("later_no_value_stays_quiet", D({ isLaterStage: true }), { fire: false, valueKind: null, reason: "no_value_trigger_stay_quiet" });
eq("later_all_false_stays_quiet", D({ isLaterStage: true, hasNewInventoryMatch: false, hasNationalOfferMatch: false, hasTestRideOffer: false, hasPriceDrop: false }), { fire: false, valueKind: null, reason: "no_value_trigger_stay_quiet" });
eq("later_inventory_fires", D({ isLaterStage: true, hasNewInventoryMatch: true }), { fire: true, valueKind: "new_inventory", reason: "matching_inventory" });
eq("later_offer_fires", D({ isLaterStage: true, hasNationalOfferMatch: true }), { fire: true, valueKind: "national_offer", reason: "matching_national_offer" });
eq("later_testride_fires", D({ isLaterStage: true, hasTestRideOffer: true }), { fire: true, valueKind: "test_ride", reason: "test_ride_opportunity" });
eq("later_pricedrop_fires", D({ isLaterStage: true, hasPriceDrop: true }), { fire: true, valueKind: "price_drop", reason: "price_drop" });
// precedence: inventory > offer > test_ride > price_drop
eq("precedence_inventory_over_offer", D({ isLaterStage: true, hasNewInventoryMatch: true, hasNationalOfferMatch: true, hasTestRideOffer: true }).valueKind, "new_inventory");
eq("precedence_offer_over_testride", D({ isLaterStage: true, hasNationalOfferMatch: true, hasTestRideOffer: true, hasPriceDrop: true }).valueKind, "national_offer");
eq("precedence_testride_over_pricedrop", D({ isLaterStage: true, hasTestRideOffer: true, hasPriceDrop: true }).valueKind, "test_ride");

// --- 1b. NEW-bike promo scope (Joe 2026-07-22): national promo offers only reach a
//         lead whose unit is NEW; used/unknown-condition leads only see offers that
//         EXPLICITLY cover used bikes. Pins the miss verbatim: "$406/month with 10%
//         down" (a new-bike touring promo) was texted onto a USED 2021 Street Glide
//         Special (+17165104578). ------------------------------------------------
const C = leadUnitConditionForOfferMatch;
eq("cond_new", C({ lead: { vehicle: { condition: "new" } } }), "new");
eq("cond_new_model_interest", C({ lead: { vehicle: { condition: "new_model_interest" } } }), "new");
eq("cond_used", C({ lead: { vehicle: { condition: "used" } } }), "used");
// The Joe-ruled miss: lead + inventoryContext both say used (+17165104578).
eq("cond_used_flagged_lead", C({ lead: { vehicle: { condition: "used" } }, inventoryContext: { condition: "used" } }), "used");
eq("cond_preowned_variant", C({ lead: { vehicle: { condition: "Pre-Owned" } } }), "used");
eq("cond_inventory_context_fallback", C({ lead: {}, inventoryContext: { condition: "used" } }), "used");
eq("cond_missing_is_unknown", C({ lead: { vehicle: {} } }), "unknown");
eq("cond_empty_conv", C({}), "unknown");

const offer = (over: Partial<NationalOffer>): NationalOffer => ({
  title: "Offer",
  appliesTo: "",
  offerType: "financing_apr",
  terms: "",
  eligibility: "",
  expiration: "",
  ...over
} as NationalOffer);
const newPromo = offer({ title: "Select Grand American Touring Models Extended Terms", appliesTo: "Grand American Touring models", terms: "from $406/mo" });
const usedPromo = offer({ title: "Rider Training Graduate Used APR", appliesTo: "used motorcycles", terms: "6.64% APR", eligibility: "Riding Academy graduates" });
eq("offer_used_detected_in_applies_to", offerExplicitlyCoversUsed(usedPromo), true);
eq("offer_preowned_detected", offerExplicitlyCoversUsed(offer({ appliesTo: "pre-owned Softail models" })), true);
eq("offer_new_promo_not_used", offerExplicitlyCoversUsed(newPromo), false);
// The filter: NEW lead sees everything; USED/UNKNOWN lead sees only explicitly-used offers.
eq("filter_new_lead_sees_all", filterOffersForLeadCondition([newPromo, usedPromo], "new").length, 2);
eq("filter_used_lead_only_used_offers", filterOffersForLeadCondition([newPromo, usedPromo], "used").map(o => o.title), ["Rider Training Graduate Used APR"]);
// Fail direction: unknown condition is treated like used — quieter, never a misapplied promo.
eq("filter_unknown_treated_as_used", filterOffersForLeadCondition([newPromo, usedPromo], "unknown").map(o => o.title), ["Rider Training Graduate Used APR"]);
eq("filter_used_lead_no_used_offers_empty", filterOffersForLeadCondition([newPromo], "used"), []);

// --- 2. stripHtmlToText ------------------------------------------------------
eq("strip_removes_tags_and_scripts", stripHtmlToText("<div>Hello <script>var x=1</script>&amp; <b>world</b></div>"), "Hello & world");
eq("strip_collapses_whitespace", stripHtmlToText("  a\n\n  b   c "), "a b c");
eq("strip_empty", stripHtmlToText(""), "");

// --- 3. feature is dark by default ------------------------------------------
const prev = process.env.NATIONAL_OFFERS_ENABLED;
delete process.env.NATIONAL_OFFERS_ENABLED;
eq("disabled_by_default", isNationalOffersEnabled(), false);
process.env.NATIONAL_OFFERS_ENABLED = "1";
eq("enabled_when_flag_on", isNationalOffersEnabled(), true);
if (prev === undefined) delete process.env.NATIONAL_OFFERS_ENABLED;
else process.env.NATIONAL_OFFERS_ENABLED = prev;
eq("source_is_hd_national_offers_page", /harley-davidson\.com\/us\/en\/tools\/offers/.test(DEFAULT_NATIONAL_OFFERS_URL), true);

// --- source guards: parsers gated OFF-by-default, matcher fail-safe ----------
const llm = fs.readFileSync(path.join(process.cwd(), "services/api/src/domain/llmDraft.ts"), "utf8");
const gatedOff = (fn: string) => {
  const i = llm.indexOf(`export async function ${fn}`);
  const block = i >= 0 ? llm.slice(i, i + 700) : "";
  return /NATIONAL_OFFERS_ENABLED \?\? "0"/.test(block);
};
eq("parse_parser_default_off", gatedOff("parseNationalOffersWithLLM"), true);
eq("match_parser_default_off", gatedOff("matchNationalOfferToLeadWithLLM"), true);
const mod = fs.readFileSync(path.join(process.cwd(), "services/api/src/domain/nationalOffers.ts"), "utf8");
eq("module_returns_empty_when_disabled", /if \(!isNationalOffersEnabled\(\)\) return \[\];/.test(mod), true);
eq("matcher_null_when_no_apply", /if \(!match \|\| !match\.applies \|\| !match\.message\) return null;/.test(mod), true);
// NEW-bike promo scope wiring (Joe 2026-07-22): the deterministic condition filter must sit
// in the shared funnel BEFORE the LLM matcher, and BOTH paths (live cadence tick + regen
// mirror) must pass the lead's condition — two-path parity by construction.
eq("funnel_filters_by_condition_before_llm", /filterOffersForLeadCondition\(\s*filterOffersForDedup/.test(mod), true);
eq("matcher_receives_condition", /matchNationalOfferToLeadWithLLM\(\{[\s\S]{0,200}?condition/.test(mod), true);
eq("prompt_hard_rule_new_bike_scope", /NEW motorcycles unless the offer EXPLICITLY says used\/pre-owned/.test(llm), true);
const indexSrc = fs.readFileSync(path.join(process.cwd(), "services/api/src/index.ts"), "utf8");
eq(
  "both_paths_pass_vehicle_condition",
  (indexSrc.match(/vehicleCondition: leadUnitConditionForOfferMatch\(conv\)/g) ?? []).length,
  2
);

if (failures.length) {
  console.error("FAIL national_offers eval:");
  for (const f of failures) console.error(f);
  process.exit(1);
}
console.log("PASS national_offers eval — value gate (11 decision cases), NEW-bike promo scope (condition resolver + offer filter + two-path wiring), HTML strip, dark-by-default flag + parser source guards");
