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
const regenPendingStart = apiIndex.indexOf("if (!dealerRideOutcome?.status)");
const regenPendingBlock = regenPendingStart >= 0 ? apiIndex.slice(regenPendingStart, regenPendingStart + 1200) : "";

const initialRouteBlock = /const publishDealerRideInitialThankYouDraft = async \(\) => \{[\s\S]{0,900}buildDealerLeadAppPostRideReply[\s\S]{0,260}publishEarlyAdfSmsDraft\(draft\);/.test(apiRoute);
const noPurchasePublishesDraft =
  noPurchaseBlock.includes("publishDealerRideInitialThankYouDraft()") &&
  noPurchaseBlock.includes("dealer_ride_outcome_pending_customer_draft");
const generalDealerRidePublishesDraft =
  generalDealerRideBlock.includes("publishDealerRideInitialThankYouDraft()") &&
  generalDealerRideBlock.includes("dealer_ride_outcome_pending_customer_draft");
const regenPendingDrafts =
  regenPendingBlock.includes("buildDealerLeadAppPostRideReply") &&
  regenPendingBlock.includes("respondWithSmsRegeneratedDraft(reply)");

const checks: Check[] = [
  check("initial_adf_has_guarded_customer_thank_you_helper", initialRouteBlock, true),
  check("no_purchase_dla_initial_path_publishes_customer_draft", noPurchasePublishesDraft, true),
  check("general_dla_initial_path_publishes_customer_draft", generalDealerRidePublishesDraft, true),
  check("regenerate_pending_dla_path_publishes_customer_draft", regenPendingDrafts, true),
  check(
    "legacy_no_customer_reply_note_removed",
    apiRoute.includes("dealer_ride_outcome_pending_no_customer_reply"),
    false
  ),
  check(
    "regenerate_no_longer_skips_pending_dla",
    apiIndex.includes('respondRegenerateSkipped("dealer_ride_outcome_pending")'),
    false
  ),
  check(
    "shadow_replay_flags_missing_dla_customer_draft",
    shadowReplay.includes("Dealer Lead App demo-ride ADF should produce a customer thank-you draft"),
    true
  ),
  check(
    "shadow_replay_no_longer_expects_no_dla_response",
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
