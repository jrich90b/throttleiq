// POLICY FLIP (Joe-approved 2026-07-02, Angelo Balistrieri +17169123294): a DLA demo-ride ADF now
// ALWAYS yields one customer thank-you draft (guarded: confirmed-demo check, already-thanked
// dedupe, draft-state invariant) while the outcome + follow-up stay with the salesperson. The
// assertions below pin the NEW behavior; the old "no customer reply by design" policy is retired.
// 2026-07-07 (agent-watch, corpus replay Refs 11182/11251): a CONFIRMED APPOINTMENT must NOT
// suppress the customer thank-you — the appointment-outcome flow only messages staff, so the
// old appointment_outcome_wins early-return left booked-appointment riders with total silence
// (and broke live/regen parity: regen always drafted). The guard still dedupes STAFF prompts.
import fs from "node:fs";
import path from "node:path";

type Check = {
  id: string;
  actual: unknown;
  expected: unknown;
};

function check(id: string, actual: unknown, expected: unknown): Check {
  return { id, actual, expected };
}

const apiRoute = fs.readFileSync(path.join(process.cwd(), "services/api/src/routes/sendgridInbound.ts"), "utf8");
const apiIndex = fs.readFileSync(path.join(process.cwd(), "services/api/src/index.ts"), "utf8");
const shadowReplay = fs.readFileSync(path.join(process.cwd(), "scripts/inbound_shadow_replay.ts"), "utf8");

const noPurchaseStart = apiRoute.indexOf("if (isDealerRideEventLead && isNoPurchaseNow)");
const noPurchaseBlock = noPurchaseStart >= 0 ? apiRoute.slice(noPurchaseStart, noPurchaseStart + 5000) : "";
const generalDealerRideStart = apiRoute.indexOf("if (isDealerRideEventLead)", Math.max(noPurchaseStart + 1, 0));
const generalDealerRideBlock =
  generalDealerRideStart >= 0 ? apiRoute.slice(generalDealerRideStart, generalDealerRideStart + 1200) : "";
const liveDealerRideLeadStart = apiRoute.indexOf("const dealerLeadAppConfirmedDemoRide");
const liveDealerRideLeadBlock =
  liveDealerRideLeadStart >= 0 ? apiRoute.slice(liveDealerRideLeadStart, liveDealerRideLeadStart + 900) : "";
const noDemoOverrideBlock = apiRoute.includes("dealerLeadAppWithoutConfirmedDemoRide")
  ? apiRoute.slice(apiRoute.indexOf("dealerLeadAppWithoutConfirmedDemoRide"), apiRoute.indexOf("dealerLeadAppWithoutConfirmedDemoRide") + 2000)
  : "";
const thankYouHelperStart = apiRoute.indexOf("const publishDealerRideInitialThankYouDraft");
const thankYouHelperBlock =
  thankYouHelperStart >= 0 ? apiRoute.slice(thankYouHelperStart, thankYouHelperStart + 2200) : "";
const regenDealerRideLeadStart = apiIndex.indexOf("const regenDealerRideEventLead");
const regenDealerRideLeadBlock =
  regenDealerRideLeadStart >= 0 ? apiIndex.slice(regenDealerRideLeadStart, regenDealerRideLeadStart + 400) : "";
const regenPendingStart = apiIndex.indexOf("if (!dealerRideOutcome?.status)");
const regenPendingBlock = regenPendingStart >= 0 ? apiIndex.slice(regenPendingStart, regenPendingStart + 1200) : "";

const initialRouteBlock = /const publishDealerRideInitialThankYouDraft = async \(\) => \{[\s\S]{0,1800}buildDealerLeadAppPostRideReply[\s\S]{0,260}publishEarlyAdfSmsDraft\(draft\);/.test(apiRoute);
const noPurchasePublishesDraft =
  noPurchaseBlock.includes("publishDealerRideInitialThankYouDraft()") &&
  noPurchaseBlock.includes("dealer_ride_outcome_pending_customer_draft");
const noPurchaseWaitsForOutcome =
  noPurchaseBlock.includes("dealer_ride_outcome_pending_no_customer_reply") &&
  noPurchaseBlock.includes('reason: "dealer_ride_outcome_pending"');
const generalDealerRidePublishesDraft =
  generalDealerRideBlock.includes("publishDealerRideInitialThankYouDraft()") &&
  generalDealerRideBlock.includes("dealer_ride_outcome_pending_customer_draft");
const generalDealerRideWaitsForOutcome =
  generalDealerRideBlock.includes("dealer_ride_outcome_pending_no_customer_reply") &&
  generalDealerRideBlock.includes('reason: "dealer_ride_outcome_pending"');
const regenPendingDrafts =
  regenPendingBlock.includes("buildDealerLeadAppPostRideReply") &&
  regenPendingBlock.includes("respondWithSmsRegeneratedDraft(thankYou)");
const regenPendingSkips =
  regenPendingBlock.includes('respondRegenerateSkipped("dealer_ride_outcome_pending")') &&
  !regenPendingDrafts;
const initialBuilderPrefersLeadOwner =
  apiRoute.includes("args.conv?.leadOwner?.name") &&
  apiRoute.includes("args.conv?.leadOwner?.firstName") &&
  apiRoute.includes("This is ${senderFirst} at ${dealerName}");
const regenBuilderPrefersLeadOwner =
  apiIndex.includes("args.conv?.leadOwner?.name") &&
  apiIndex.includes("args.conv?.leadOwner?.firstName") &&
  apiIndex.includes("This is ${senderFirst} at ${dealerName}");

const checks: Check[] = [
  check("initial_adf_has_guarded_customer_thank_you_helper", initialRouteBlock, true),
  check(
    "initial_thank_you_not_blocked_by_confirmed_appointment",
    thankYouHelperBlock.includes("publishEarlyAdfSmsDraft(draft)") &&
      !thankYouHelperBlock.includes('reason: "appointment_outcome_wins"'),
    true
  ),
  check(
    "staff_outcome_prompt_still_defers_to_appointment_outcome",
    apiRoute.includes("if (!appointmentOutcomeWins && !hasDealerRideOutcomeRecordedOrRequested(conv))") &&
      apiRoute.includes("if (!appointmentOutcomeWins && !dealerRideOutcomeAlreadyRequested)"),
    true
  ),
  check(
    "initial_publish_blocks_unconfirmed_dla_demo",
    apiRoute.includes('reason: "dealer_ride_no_confirmed_demo"') &&
      apiRoute.includes("isDealerLeadAppConfirmedDemoRideAdfText(dealerLeadAppText)"),
    true
  ),
  check(
    "live_dla_route_requires_confirmed_demo_not_source_only",
    liveDealerRideLeadBlock.includes("isDealerLeadAppConfirmedDemoRideAdfText(dealerRideEventText)") &&
      !liveDealerRideLeadBlock.includes('leadSourceLower.includes("dealer lead app")'),
    true
  ),
  check(
    "live_dla_no_demo_overrides_test_ride_classification",
    noDemoOverrideBlock.includes("isDealerLeadAppWithoutConfirmedDemoRideAdfText") &&
      noDemoOverrideBlock.includes('inferredBucket = "general_inquiry"') &&
      noDemoOverrideBlock.includes('inferredCta = "contact_us"'),
    true
  ),
  check(
    "regen_dla_route_requires_confirmed_demo_not_source_only",
    regenDealerRideLeadBlock.includes("isDealerLeadAppConfirmedDemoRideAdfText(event.body)") &&
      !regenDealerRideLeadBlock.includes("/source:\\s*dealer lead app"),
    true
  ),
  check("no_purchase_dla_initial_path_publishes_thank_you_draft", noPurchasePublishesDraft, true),
  check("no_purchase_dla_initial_path_no_longer_withholds_the_thank_you", noPurchaseWaitsForOutcome, false),
  check("general_dla_initial_path_publishes_thank_you_draft", generalDealerRidePublishesDraft, true),
  check("general_dla_initial_path_no_longer_withholds_the_thank_you", generalDealerRideWaitsForOutcome, false),
  check("regenerate_pending_dla_path_publishes_thank_you_draft", regenPendingDrafts, true),
  check("regenerate_pending_dla_path_no_longer_skips", regenPendingSkips, false),
  check("initial_dla_thank_you_prefers_lead_owner_name", initialBuilderPrefersLeadOwner, true),
  check("regen_dla_thank_you_prefers_lead_owner_name", regenBuilderPrefersLeadOwner, true),
  check(
    "pending_dla_notes_the_customer_draft",
    apiRoute.includes("dealer_ride_outcome_pending_customer_draft") &&
      !apiRoute.includes("dealer_ride_outcome_pending_no_customer_reply"),
    true
  ),
  check(
    "regenerate_no_longer_skips_pending_dla",
    apiIndex.includes('respondRegenerateSkipped("dealer_ride_outcome_pending")'),
    false
  ),
  check(
    "shadow_replay_expects_the_thank_you_draft",
    shadowReplay.includes("Dealer Lead App demo-ride ADF should produce a customer thank-you draft"),
    true
  ),
  check(
    "shadow_replay_dropped_the_no_reply_expectation",
    shadowReplay.includes("Dealer Lead App outcome/task ADF has no customer-facing auto-reply by design"),
    false
  )
];

let passed = 0;
for (const c of checks) {
  const ok = JSON.stringify(c.actual) === JSON.stringify(c.expected);
  if (ok) passed += 1;
  console.log(
    `${ok ? "PASS" : "FAIL"} ${c.id} expected=${JSON.stringify(c.expected)} actual=${JSON.stringify(c.actual)}`
  );
}

if (passed !== checks.length) {
  console.error(`\n${checks.length - passed} failures out of ${checks.length} dealer ride initial draft checks`);
  process.exit(1);
}

console.log(`\nAll ${checks.length} dealer ride initial draft checks passed.`);
