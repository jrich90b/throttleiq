/**
 * Dealer-ride thank-you stale-relatch eval.
 *
 * Root cause (+17168641440, corpus_replay_judge_fail, anomaly batch 2 2026-07-23): the
 * "already thanked" dedupe counted a STALE never-sent draft_ai thank-you as a delivered
 * thank-you. The 5/16 DLA demo-ride ADF drafted the thank-you, the draft went stale
 * unsent, and the 5/18 repeat ADF was deduped away (`dealer_ride_initial_thank_you_exists`)
 * — the rider was never thanked, permanently. Same class latch in
 * queueDealerRideOutcomeCustomerDraft (`customerFollowUpDraftedAt` held for the
 * conversation lifetime even when the latched draft never went out).
 *
 * Pins:
 *  1. The shared domain helper: stale drafts never count; sent messages and live pending
 *     drafts still do (the Ref 11182 already-thanked expected-silence ruling stays intact).
 *  2. classifyDraft (replay judge): the +17168641440 shape — repeat DLA ADF with only a
 *     stale thank-you — is a MISSING response, not expected silence; a genuinely sent
 *     thank-you keeps expected_no_response.
 *  3. Source pins: both production sites route through the shared helper (no drift back
 *     to an ad-hoc regex that re-counts stale drafts).
 *
 * Fail-direction: the fix fails toward one more staff-reviewed draft (suggest mode +
 * 24h duplicate-outbound guard), never toward customer silence.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  hasDeliveredOrPendingDealerRideThankYou,
  isDealerRideThankYouMessageText
} from "../services/api/src/domain/dealerRideThankYouDedup.ts";
import { classifyDraft } from "./inbound_shadow_replay.ts";

const THANK_YOU_BODY =
  "Hi John — This is Giovanni at American Harley-Davidson. Thanks again for coming in for the test ride. If any questions come up or you’d like to discuss options further, just text me anytime.";

// --- 1. Shared helper behavior ---

// The production +17168641440 shape: the only thank-you on the thread is a stale,
// never-sent draft — the customer was NOT thanked.
assert.equal(
  hasDeliveredOrPendingDealerRideThankYou([
    { direction: "in", provider: "sendgrid_adf", body: "WEB LEAD (ADF)\nSource: Dealer Lead App\nComments: completed a demo ride" },
    { direction: "out", provider: "draft_ai", draftStatus: "stale", body: THANK_YOU_BODY }
  ]),
  false,
  "a stale never-sent thank-you draft must NOT count as a delivered thank-you"
);

// A thank-you that actually went out (twilio) still counts.
assert.equal(
  hasDeliveredOrPendingDealerRideThankYou([
    { direction: "out", provider: "twilio", body: THANK_YOU_BODY }
  ]),
  true,
  "a sent thank-you must still count as already-thanked"
);

// A LIVE pending draft counts too — never double-draft while one awaits approval.
assert.equal(
  hasDeliveredOrPendingDealerRideThankYou([
    { direction: "out", provider: "draft_ai", draftStatus: "pending", body: THANK_YOU_BODY }
  ]),
  true,
  "a pending (non-stale) thank-you draft must still dedupe"
);

// Legacy/sent records without draft metadata (the Ref 11182 fixture shape) count.
assert.equal(
  hasDeliveredOrPendingDealerRideThankYou([
    { direction: "out", body: "Hi Terry — This is Joe at American Harley-Davidson. Thanks again for coming in for the test ride. If any questions come up, just text me." }
  ]),
  true,
  "an outbound thank-you without draft metadata must still count (Ref 11182 ruling)"
);

// Unrelated sent outbound (e.g. an event blast) never counts as the thank-you.
assert.equal(
  hasDeliveredOrPendingDealerRideThankYou([
    { direction: "out", provider: "twilio", body: "Join us Sat, July 18, 12–5PM at American Harley-Davidson for our 250 Years of Freedom party" }
  ]),
  false,
  "a non-thank-you outbound must not satisfy the dedupe"
);

// Inbound text can never satisfy an OUTBOUND dedupe.
assert.equal(
  hasDeliveredOrPendingDealerRideThankYou([{ direction: "in", body: THANK_YOU_BODY }]),
  false,
  "inbound messages never count"
);

assert.equal(isDealerRideThankYouMessageText(THANK_YOU_BODY), true, "canonical shape matches");
assert.equal(isDealerRideThankYouMessageText("Thanks for reaching out!"), false, "generic thanks does not match");

// --- 2. Replay-judge parity (classifyDraft) ---

const dlaDemoRideAdf = [
  "WEB LEAD (ADF)",
  "Source: Dealer Lead App",
  "Ref: 11261",
  "Name: John Bugyi",
  "Vehicle: Harley-Davidson Street Glide 3 Limited",
  "Event Name: Dealer Test Ride",
  "Comments: Customer completed a demo ride today."
].join("\n");

{
  // Stale-thank-you-only thread: silence on the repeat ADF is a MISS, never expected.
  const { verdict } = classifyDraft("sendgrid_adf", dlaDemoRideAdf, null, {
    mode: "suggest",
    messages: [{ direction: "out", provider: "draft_ai", draftStatus: "stale", body: THANK_YOU_BODY }]
  } as any);
  assert.equal(
    verdict,
    "missing_response",
    `repeat DLA ADF over a STALE thank-you draft must be missing_response, got ${verdict}`
  );
}

{
  // Actually-thanked thread: silence stays by design (the existing expected-silence ruling).
  const { verdict } = classifyDraft("sendgrid_adf", dlaDemoRideAdf, null, {
    mode: "suggest",
    messages: [{ direction: "out", provider: "twilio", body: THANK_YOU_BODY }]
  } as any);
  assert.equal(
    verdict,
    "expected_no_response",
    `repeat DLA ADF over a SENT thank-you must stay expected_no_response, got ${verdict}`
  );
}

// --- 3. Source pins: both production sites go through the shared helper ---

const sendgridRoute = fs.readFileSync(
  path.join(process.cwd(), "services/api/src/routes/sendgridInbound.ts"),
  "utf8"
);
const apiIndex = fs.readFileSync(path.join(process.cwd(), "services/api/src/index.ts"), "utf8");

assert.equal(
  /const hasDealerRideInitialThankYouDraft = \(\) =>[\s\S]{0,200}hasDeliveredOrPendingDealerRideThankYou\(conv\.messages\)/.test(
    sendgridRoute
  ),
  true,
  "live sendgrid dedupe must use hasDeliveredOrPendingDealerRideThankYou (stale drafts excluded)"
);

const latchStart = apiIndex.indexOf("customerFollowUpDraftedAt) {");
const latchBlock = latchStart >= 0 ? apiIndex.slice(latchStart, latchStart + 900) : "";
assert.equal(
  latchBlock.includes("hasDeliveredOrPendingDealerRideThankYou(conv.messages)") &&
    latchBlock.includes('reason: "already_drafted"'),
  true,
  "queueDealerRideOutcomeCustomerDraft latch must verify a delivered/pending thank-you before returning already_drafted"
);

console.log("All dealer-ride thank-you stale-relatch checks passed.");
