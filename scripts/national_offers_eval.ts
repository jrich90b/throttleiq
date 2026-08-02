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
  offerRequiresRiderTrainingEligibility,
  leadRiderTrainingEligibilityForOffer,
  filterOffersForRiderEligibility,
  filterOffersForDedup,
  resolveMatchedOffer,
  filterOffersForMoneyInterest,
  offerQuotesFinancingTerms,
  leadShowedMoneyInterest,
  leadFinanceDeclined,
  filterOffersForFinanceDeclined,
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
eq("later_offer_fires", D({ isLaterStage: true, hasNationalOfferMatch: true, customerEverEngaged: true }), { fire: true, valueKind: "national_offer", reason: "matching_national_offer" });
eq("later_testride_fires", D({ isLaterStage: true, hasTestRideOffer: true }), { fire: true, valueKind: "test_ride", reason: "test_ride_opportunity" });
eq("later_pricedrop_fires", D({ isLaterStage: true, hasPriceDrop: true }), { fire: true, valueKind: "price_drop", reason: "price_drop" });
// precedence: inventory > offer > test_ride > price_drop
eq("precedence_inventory_over_offer", D({ isLaterStage: true, hasNewInventoryMatch: true, hasNationalOfferMatch: true, hasTestRideOffer: true }).valueKind, "new_inventory");
eq("precedence_offer_over_testride", D({ isLaterStage: true, hasNationalOfferMatch: true, hasTestRideOffer: true, hasPriceDrop: true, customerEverEngaged: true }).valueKind, "national_offer");
eq("precedence_testride_over_pricedrop", D({ isLaterStage: true, hasTestRideOffer: true, hasPriceDrop: true }).valueKind, "test_ride");

// --- 1a. a NEVER-ENGAGED lead is never volunteered payment figures --------------------------
// Production miss +16102170861 (Seth Farrand), open-critic unsolicited_financing_quote_on_trade_lead:
// a "Trade Accelerator - Trade In" lead asked what his 2018 Street Glide S was WORTH, never wrote
// back once, and was texted "from $406/month with 10% down for up to 96 months" on 7/21 (sent) and
// again on 8/1 (drafted) — because the offer matched the BUY-side bike on his lead card (a 2026
// Road Glide, a touring model). Live-verified on the box: customerEngagedWithCadence(conv) === false
// (the ADF is provider sendgrid_adf, and his only call went to voicemail), yet the gate fired.
// The national-offer arm is the ONLY value kind that quotes money, so it is the only one gated.
eq(
  "never_engaged_lead_no_offer_touch",
  D({ isLaterStage: true, hasNationalOfferMatch: true, customerEverEngaged: false }),
  { fire: false, valueKind: null, reason: "no_value_trigger_stay_quiet" }
);
// Fail-safe default: an omitted engagement signal reads as NOT engaged (quiet), never as engaged.
eq(
  "missing_engagement_signal_defaults_quiet",
  D({ isLaterStage: true, hasNationalOfferMatch: true }),
  { fire: false, valueKind: null, reason: "no_value_trigger_stay_quiet" }
);
// Scoped to the money arm only — a silent lead still hears about real inventory, a test ride and
// a price drop. Over-gating here would re-create the taper/ghosting failure, not fix it.
eq("never_engaged_still_gets_inventory", D({ isLaterStage: true, hasNewInventoryMatch: true, customerEverEngaged: false }).valueKind, "new_inventory");
eq("never_engaged_still_gets_testride", D({ isLaterStage: true, hasNationalOfferMatch: true, hasTestRideOffer: true, customerEverEngaged: false }).valueKind, "test_ride");
eq("never_engaged_still_gets_pricedrop", D({ isLaterStage: true, hasNationalOfferMatch: true, hasPriceDrop: true, customerEverEngaged: false }).valueKind, "price_drop");
// Engagement is not a bypass of the OTHER guards: an early touch is still ungated, and an engaged
// lead with no offer match still stays quiet.
eq("engaged_lead_no_match_still_quiet", D({ isLaterStage: true, hasNationalOfferMatch: false, customerEverEngaged: true }).fire, false);

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

// --- 1e. MONEY INTEREST: never quote a rate/payment to a lead who never raised money -----------
// The engagement gate (1a) catches total strangers, but 3 of the 5 leads who DID reply and still
// got a money pitch were engaged. Measured on the live store 2026-08-01:
//   +16813891971 "just shopping around... what would I get for my dirtbike"  bucket trade_in_sell
//   +12109976639 "trade it in for a road glide and cover the difference outright"  inventory_interest
//   +17169079662 (near-empty reply)                                           bucket trade_in_sell
// …vs the two legitimate finance leads, which MUST keep getting offers:
//   +17164812815 bucket finance_prequal, lastIntent pricing (she asked for the payment #)
//   +17163812367 bucket finance_prequal (arrived on a credit application)
// NOTE (2026-08-02): +17163812367 passes THIS gate and always should — he did raise money. He was
// later declined, and 1f below is the separate gate that stops the rate quote. Interest and outcome
// are different questions; don't collapse them into this one.
// Signal is persisted structured state only — no new parser, no customer prose.
const M = leadShowedMoneyInterest;
eq("money_finance_prequal_bucket", M({ classification: { bucket: "finance_prequal" } }), true);
eq("money_last_intent_pricing", M({ lastIntent: { name: "pricing" } }), true);
eq("money_last_intent_payments", M({ lastIntent: { name: "payments" } }), true);
eq("money_stated_budget", M({ paymentBudgetContext: { monthly: 400 } }), true);
// The three production misses, by their REAL persisted state:
eq("money_trade_in_sell_lead_is_not_money", M({ classification: { bucket: "trade_in_sell" }, lastIntent: { name: "small_talk" } }), false);
eq("money_inventory_interest_lead_is_not_money", M({ classification: { bucket: "inventory_interest" } }), false);
eq("money_scheduling_intent_is_not_money", M({ classification: { bucket: "trade_in_sell" }, lastIntent: { name: "scheduling" } }), false);
eq("money_empty_conv_is_not_money", M({}), false);
// Our own pitch must never authorize the next one — only the CUSTOMER raising money counts.
eq("money_our_finance_invite_does_not_count", M({ classification: { bucket: "trade_in_sell" }, financeAppInviteSentAt: "2026-07-21T00:00:00Z" } as any), false);

// offerType splits "quotes financing terms" from "straight discount".
const Q = offerQuotesFinancingTerms;
eq("quotes_terms_monthly_payment", Q({ offerType: "monthly_payment" } as NationalOffer), true);
eq("quotes_terms_financing_apr", Q({ offerType: "financing_apr" } as NationalOffer), true);
eq("discount_customer_cash_is_not_terms", Q({ offerType: "customer_cash" } as NationalOffer), false);
eq("discount_rebate_is_not_terms", Q({ offerType: "rebate_credit" } as NationalOffer), false);
// FAIL DIRECTION: an offer we can't classify gets the STRICTER treatment (treated as quoting money).
eq("unknown_offer_type_treated_as_terms", Q({ offerType: "other" } as NationalOffer), true);
eq("blank_offer_type_treated_as_terms", Q({ offerType: "" } as NationalOffer), true);

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

// --- 1d. OFFER IDENTITY: the ledger key must survive the model re-wording the title ------------
// +16102170861 banked "Select Grand American Touring Models Extended-Term Monthly Payment" (7/21)
// and "Grand American Touring models Extended Term Monthly Payment" (8/1) for ONE promo, so the
// never-repeat ledger never matched itself and the same $406/mo quote went out twice.
// +17163812367 got the same thing on CONSECUTIVE DAYS (7/25, 7/26). Identity is now the INDEX of
// the offer in the list we sent the model; the banked title is snapped back to that offer's own.
const touringOffer = offer({ title: "Grand American Touring from $406/mo extended terms", appliesTo: "Grand American Touring models" });
const cashOffer = offer({ title: "$1,000 Customer Cash on 2025-2026 Low Rider S/ST", appliesTo: "Low Rider S/ST" });
const twoOffers = [cashOffer, touringOffer];
const R = resolveMatchedOffer;
// The production drift: a re-worded title still resolves, because the INDEX carries the identity.
eq(
  "reworded_title_resolves_by_index",
  R({ offerIndex: 1, offerTitle: "Select Grand American Touring Models Extended-Term Monthly Payment" }, twoOffers)?.title,
  "Grand American Touring from $406/mo extended terms"
);
eq("index_zero_resolves", R({ offerIndex: 0, offerTitle: "whatever the model felt like" }, twoOffers)?.title, cashOffer.title);
// Fallback path: no index (older/degraded response) → exact normalized title still resolves.
eq("no_index_exact_title_resolves", R({ offerIndex: null, offerTitle: "$1,000 customer cash on 2025-2026 low rider s/st" }, twoOffers)?.title, cashOffer.title);
// FAIL DIRECTION: an unusable pick resolves to null so the caller stays quiet — we never fire a
// promo we cannot bank, because an unbankable promo is one that can repeat forever.
eq("out_of_range_index_is_null", R({ offerIndex: 7, offerTitle: "" }, twoOffers), null);
eq("negative_index_is_null", R({ offerIndex: -1, offerTitle: "" }, twoOffers), null);
eq("no_index_and_reworded_title_is_null", R({ offerIndex: null, offerTitle: "Some Invented Promo Name" }, twoOffers), null);
eq("empty_offer_list_is_null", R({ offerIndex: 0, offerTitle: "x" }, []), null);
// The point of the whole fix: once the canonical title is banked, the ledger filters it next time.
eq(
  "canonical_title_dedups_next_run",
  filterOffersForDedup(twoOffers, [R({ offerIndex: 1, offerTitle: "Grand American Touring models Extended Term Monthly Payment" }, twoOffers)!.title]).map(o => o.title),
  [cashOffer.title]
);
// …and the pre-fix behavior is pinned as BROKEN, so nobody "simplifies" back to trusting the title.
eq(
  "raw_model_title_would_not_have_deduped",
  filterOffersForDedup(twoOffers, ["Grand American Touring models Extended Term Monthly Payment"]).length,
  2
);

// The filter itself: a no-money lead keeps only straight discounts; a money lead keeps everything.
const cashPromo = offer({ title: "$1,000 Customer Cash on Low Rider S/ST", offerType: "customer_cash" });
const termsPromo = offer({ title: "Grand American Touring from $406/mo extended terms", offerType: "monthly_payment" });
eq("money_filter_no_interest_keeps_only_discounts", filterOffersForMoneyInterest([cashPromo, termsPromo], false).map(o => o.title), [cashPromo.title]);
eq("money_filter_with_interest_keeps_all", filterOffersForMoneyInterest([cashPromo, termsPromo], true).length, 2);
// Good news is still sayable to a quiet lead — this gate mutes RATES, not the whole promo channel.
eq("money_filter_discount_survives_for_quiet_lead", filterOffersForMoneyInterest([cashPromo], false).length, 1);
eq("money_filter_empty_list_safe", filterOffersForMoneyInterest([], false), []);
eq("offer_used_detected_in_applies_to", offerExplicitlyCoversUsed(usedPromo), true);
eq("offer_preowned_detected", offerExplicitlyCoversUsed(offer({ appliesTo: "pre-owned Softail models" })), true);
eq("offer_new_promo_not_used", offerExplicitlyCoversUsed(newPromo), false);
// The filter: NEW lead sees everything; USED/UNKNOWN lead sees only explicitly-used offers.
eq("filter_new_lead_sees_all", filterOffersForLeadCondition([newPromo, usedPromo], "new").length, 2);
eq("filter_used_lead_only_used_offers", filterOffersForLeadCondition([newPromo, usedPromo], "used").map(o => o.title), ["Rider Training Graduate Used APR"]);
// Fail direction: unknown condition is treated like used — quieter, never a misapplied promo.
eq("filter_unknown_treated_as_used", filterOffersForLeadCondition([newPromo, usedPromo], "unknown").map(o => o.title), ["Rider Training Graduate Used APR"]);
eq("filter_used_lead_no_used_offers_empty", filterOffersForLeadCondition([newPromo], "used"), []);

// --- 1c. Rider-training-graduate eligibility gate (Joe 2026-07-23): a Riding Academy /
//         rider-training GRADUATE offer (a beginner-rider financing program) may pitch ONLY to a
//         lead affirmatively known to be a new/unlicensed rider OR who referenced the Academy.
//         Pins the miss verbatim: +17164812815 (Selviana) got the 6.64% grad used-APR pitch on a
//         used 2025 Street Bob and replied she's ridden for years with a license. -----------------
const gradOffer = usedPromo; // "Rider Training Graduate Used APR", eligibility "Riding Academy graduates"
const plainUsedOffer = offer({ title: "Used Bike APR Special", appliesTo: "used motorcycles", terms: "5.99% APR" });
eq("offer_grad_detected_by_title", offerRequiresRiderTrainingEligibility(gradOffer), true);
eq("offer_grad_detected_by_eligibility", offerRequiresRiderTrainingEligibility(offer({ eligibility: "MSF course graduates only" })), true);
eq("offer_grad_detected_rider_training", offerRequiresRiderTrainingEligibility(offer({ appliesTo: "Rider Training program grads" })), true);
eq("offer_plain_used_not_grad", offerRequiresRiderTrainingEligibility(plainUsedOffer), false);
eq("offer_new_promo_not_grad", offerRequiresRiderTrainingEligibility(newPromo), false);
// Lead-side eligibility: structured hasMotoLicense===false OR a persisted rider-course/first-timer state.
const E = leadRiderTrainingEligibilityForOffer;
eq("elig_unlicensed_is_eligible", E({ lead: { hasMotoLicense: false } }), "eligible");
eq("elig_first_time_rider_state", E({ dialogState: { name: "first_time_rider" } }), "eligible");
eq("elig_rider_course_state", E({ dialogState: { name: "rider_course_info" } }), "eligible");
// The miss: licensed, experienced rider, no Academy reference → not eligible for a grad offer.
eq("elig_licensed_not_evident", E({ lead: { hasMotoLicense: true } }), "not_evident");
eq("elig_no_evidence_not_evident", E({ lead: { firstName: "Selviana", vehicle: { condition: "used" } } }), "not_evident");
eq("elig_empty_conv_not_evident", E({}), "not_evident");
// The filter: an eligible lead sees the grad offer; a not-evident lead never does; plain used offers
// always survive (they aren't grad-scoped). Fail direction: absent evidence → drop the grad offer.
eq("rider_filter_eligible_sees_grad", filterOffersForRiderEligibility([gradOffer, plainUsedOffer], "eligible").map(o => o.title), ["Rider Training Graduate Used APR", "Used Bike APR Special"]);
eq("rider_filter_not_evident_drops_grad", filterOffersForRiderEligibility([gradOffer, plainUsedOffer], "not_evident").map(o => o.title), ["Used Bike APR Special"]);
eq("rider_filter_not_evident_only_grad_empty", filterOffersForRiderEligibility([gradOffer], "not_evident"), []);

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
// Rider-training grad scope wiring (Joe 2026-07-23): the deterministic eligibility filter wraps the
// condition filter in the shared funnel, and BOTH paths pass the lead's eligibility → parity by construction.
eq("funnel_filters_by_rider_eligibility_before_llm", /filterOffersForRiderEligibility\(\s*filterOffersForLeadCondition/.test(mod), true);
eq("funnel_rider_eligibility_defaults_not_evident", /opts\?\.riderEligibility \?\? "not_evident"/.test(mod), true);
eq("matcher_receives_condition", /matchNationalOfferToLeadWithLLM\(\{[\s\S]{0,200}?condition/.test(mod), true);
eq("prompt_hard_rule_new_bike_scope", /NEW motorcycles unless the offer EXPLICITLY says used\/pre-owned/.test(llm), true);
// Model-specific offer scope (Joe 2026-07-25, +15854890786): a model-named offer covers ONLY its
// named models, not the whole family — the Breakout / Low Rider S/ST miss. Pin the HARD RULE + the
// exact negative few-shot so the matcher keeps refusing the same-family over-stretch.
eq("prompt_hard_rule_model_specific_scope", /When an offer names SPECIFIC MODELS[\s\S]{0,200}NOT to other models in the SAME family/.test(llm), true);
eq("prompt_fewshot_breakout_not_low_rider_offer", /"2026 Breakout"[\s\S]{0,120}Low Rider S\/ST[\s\S]{0,120}"applies":false/.test(llm), true);
// --- 1f. DECLINED FINANCE: never re-quote a rate to a lead we already turned down ---------------
// Production miss (operator-reported 2026-08-02, +17163812367 Curtis Samuel). He arrived on an HDFS
// credit application; on 7/23 Joe texted "Looks like we did not get an approval through Harley...
// not enough credit history. Is a qualified co-signer an option?" and Curtis replied "No". The
// thread's financeOutcome went to {"status":"declined","updatedAt":"2026-07-23T16:16:05.182Z"}.
// The cadence then sent the used-finance promo TWICE (nationalOfferTouches 7/25 15:00Z and 7/26
// 14:53Z): "that 2018 Street Glide qualifies for used financing starting at 7.29% APR with $0 down".
// Every prior pre-filter passed him — engaged, bucket finance_prequal (so leadShowedMoneyInterest is
// TRUE, and 1e above deliberately pins him as a legitimate finance lead), used unit. Interest was
// never the issue; the OUTCOME was. Fail direction: suppress → quiet, never a fabricated approval.
const FD = leadFinanceDeclined;
eq("declined_reads_persisted_outcome", FD({ financeOutcome: { status: "declined" } }), true);
eq("declined_curtis_real_persisted_state", FD({
  financeOutcome: { status: "declined", updatedAt: "2026-07-23T16:16:05.182Z", reasonText: "asked the customer if they had a co-signer" }
} as any), true);
eq("approved_is_not_declined", FD({ financeOutcome: { status: "approved" } }), false);
// Still working the deal — the lender is waiting on documents, not a turn-down. Its own checklist
// task owns that lane; widening the gate here would silence a live finance conversation.
eq("needs_more_info_is_not_declined", FD({ financeOutcome: { status: "needs_more_info" } }), false);
eq("no_finance_outcome_is_not_declined", FD({}), false);
eq("null_finance_outcome_is_not_declined", FD({ financeOutcome: null }), false);

// The filter drops rate/payment offers for a declined lead; a straight discount still passes,
// because the bike really is cheaper and that says nothing about their credit.
const OFFERS_MIXED = [
  { title: "Used Motorcycle Financing (7.29% APR)", offerType: "financing_apr" },
  { title: "Grand American Touring Monthly Payment", offerType: "monthly_payment" },
  { title: "$1,000 Customer Cash", offerType: "customer_cash" }
] as NationalOffer[];
eq(
  "declined_lead_sees_only_straight_discounts",
  filterOffersForFinanceDeclined(OFFERS_MIXED, true).map(o => o.title),
  ["$1,000 Customer Cash"]
);
eq(
  "not_declined_lead_sees_every_offer",
  filterOffersForFinanceDeclined(OFFERS_MIXED, false).map(o => o.title),
  OFFERS_MIXED.map(o => o.title)
);
// The exact promo Curtis got, against his exact state — the regression this eval exists to stop.
eq(
  "curtis_never_sees_the_729_apr_promo_again",
  filterOffersForFinanceDeclined(
    [{ title: "Used Motorcycle Financing (7.29% APR)", offerType: "financing_apr" } as NationalOffer],
    FD({ financeOutcome: { status: "declined" } })
  ).length,
  0
);
// Self-releasing: an approval restores the offers, so a rescued deal is not silenced forever.
eq(
  "approval_restores_offers",
  filterOffersForFinanceDeclined(OFFERS_MIXED, FD({ financeOutcome: { status: "approved" } })).length,
  3
);
// FAIL DIRECTION: an unclassifiable offer is treated as quoting money, so it is dropped too.
eq(
  "declined_lead_drops_unclassified_offer",
  filterOffersForFinanceDeclined([{ title: "Mystery", offerType: "" } as NationalOffer], true).length,
  0
);

const indexSrc = fs.readFileSync(path.join(process.cwd(), "services/api/src/index.ts"), "utf8");
eq(
  "both_paths_pass_vehicle_condition",
  (indexSrc.match(/vehicleCondition: leadUnitConditionForOfferMatch\(conv\)/g) ?? []).length,
  2
);
eq(
  "both_paths_pass_rider_eligibility",
  (indexSrc.match(/riderEligibility: leadRiderTrainingEligibilityForOffer\(conv\)/g) ?? []).length,
  2
);
// Route parity: the live follow-up tick AND /conversations/:id/regenerate must both read the
// declined outcome, or a regenerated draft re-quotes the rate the live tick refused to send.
eq(
  "both_paths_pass_finance_declined",
  (indexSrc.match(/financeDeclined: leadFinanceDeclined\(conv\)/g) ?? []).length,
  2
);

if (failures.length) {
  console.error("FAIL national_offers eval:");
  for (const f of failures) console.error(f);
  process.exit(1);
}
console.log("PASS national_offers eval — value gate (11 decision cases), NEW-bike promo scope (condition resolver + offer filter + two-path wiring), rider-training grad scope (offer detector + lead eligibility + filter + two-path wiring), declined-finance scope (outcome reader + offer filter + two-path wiring), HTML strip, dark-by-default flag + parser source guards");
