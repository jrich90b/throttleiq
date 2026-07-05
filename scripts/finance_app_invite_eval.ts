/**
 * Finance-app + soft-visit offer eval (2026-06-24).
 *
 * A payment-focused lead, once they engage with numbers (the manual-quote-details moment), gets the
 * dealer's credit-app link + a soft visit invite — ONCE. Pins: the deterministic line builder (exact
 * URL, never fabricated) and the wiring (all manual-quote-details replies route through the offer
 * helper, which is offer-once via conv.financeAppInviteSentAt).
 *
 * Run: npx tsx scripts/finance_app_invite_eval.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { buildFinanceAppInviteLine } from "../services/api/src/domain/financeAppInvite.ts";

// --- 1) Deterministic line builder. ---
const full = buildFinanceAppInviteLine({
  creditAppUrl: "https://creditapplication.harley-davidson.com/us/en/?dealerid=3436",
  bookingUrl: "https://americanharley.leadrider.ai/book?token=abc"
})!;
assert.ok(full, "a credit-app URL yields an offer line");
assert.match(full, /get pre-approved/i, "offers pre-approval");
assert.match(full, /creditapplication\.harley-davidson\.com\/us\/en\/\?dealerid=3436/, "exact credit-app URL");
assert.match(full, /swing by/i, "includes a soft visit invite");
assert.match(full, /americanharley\.leadrider\.ai\/book\?token=abc/, "includes the booking URL when present");

// Booking optional — still offers the visit, just no link.
const noBooking = buildFinanceAppInviteLine({ creditAppUrl: "https://x.com/app" })!;
assert.match(noBooking, /x\.com\/app/, "credit-app URL present");
assert.match(noBooking, /swing by/i, "soft visit without a booking link");

// No real credit-app URL => null (never fabricate a link; caller omits the offer).
assert.equal(buildFinanceAppInviteLine({ creditAppUrl: "" }), null, "no credit-app URL => no offer");
assert.equal(buildFinanceAppInviteLine({ creditAppUrl: "not-a-url" }), null, "non-URL => no offer");

// --- 2) Wiring: every manual-quote-details reply routes through the offer helper, offer-once. ---
const api = fs.readFileSync("services/api/src/index.ts", "utf8");
assert.match(
  api,
  /async function buildManualQuoteDetailsReceivedReplyWithFinanceOffer/,
  "the offer helper must exist"
);
assert.match(api, /if \(conv\.financeAppInviteSentAt\) return reply;/, "offer must be once-per-conversation");
assert.match(api, /conv\.financeAppInviteSentAt = new Date\(\)\.toISOString\(\)/, "the offer-once marker is set when offered");
assert.match(api, /buildFinanceAppInviteLine\(/, "the helper uses the deterministic line builder");
// No bare manual-quote reply should ship without going through the offer helper (all 3 call sites).
const bareCalls = (api.match(/publishLiveTwilioReply\(buildManualQuoteDetailsReceivedReply\(\)/g) ?? []).length
  + (api.match(/respondWithSmsRegeneratedDraft\(\s*buildManualQuoteDetailsReceivedReply\(\)/g) ?? []).length;
assert.equal(bareCalls, 0, "no manual-quote-details reply may bypass the finance-offer helper");
assert.equal(
  (api.match(/buildManualQuoteDetailsReceivedReplyWithFinanceOffer\(conv\)/g) ?? []).length >= 3,
  true,
  "the offer helper must be used at all manual-quote-details reply sites (live, live-precheck, regen)"
);

console.log("PASS finance app invite eval (deterministic link + offer-once wiring, both paths)");
