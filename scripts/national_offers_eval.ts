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
import { stripHtmlToText, isNationalOffersEnabled, DEFAULT_NATIONAL_OFFERS_URL } from "../services/api/src/domain/nationalOffers.ts";

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

if (failures.length) {
  console.error("FAIL national_offers eval:");
  for (const f of failures) console.error(f);
  process.exit(1);
}
console.log("PASS national_offers eval — value gate (11 decision cases), HTML strip, dark-by-default flag + parser source guards");
