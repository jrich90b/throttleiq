/**
 * credit_lead_email:eval — pins Joe's 2026-07-25 ruling: credit-application and
 * finance-prequalification leads get an EMAIL draft (email format) with a booking link, in
 * ADDITION to the SMS ack. Before this, the `isCreditLead` branch returned an SMS-only ack and
 * skipped the email lane. The email body is finance-specific (never the product "check out the
 * bike" copy), reassures that finance will reach out, and offers a booking link when one exists.
 *
 * Layer 1 — behavior via the shared pure helper (domain/creditLeadEmail.ts).
 * Layer 2 — source guards that BOTH draft paths (live handleSendgridInbound + regenerate) build
 * the email via that helper, so they stay in parity.
 *
 * Fail-direction: no booking URL → no booking line (never a dangling "book here:"); no email
 * address / phone-only lead → the live path skips the email entirely (suppress, keep the handoff).
 *
 * Run: npx tsx scripts/credit_lead_email_eval.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { buildCreditLeadEmailDraft } from "../services/api/src/domain/creditLeadEmail.ts";

const BOOKING = "https://americanharley.leadrider.ai/book?token=abc&type=finance_discussion&firstName=Donald&leadKey=%2B17165551234";

// --- credit application, with a booking URL ---
{
  const email = buildCreditLeadEmailDraft({
    firstName: "Donald",
    fullName: "Donald Schuler",
    dealerName: "American Harley-Davidson",
    agentName: "Alexandra",
    bookingUrl: BOOKING,
    isPrequal: false
  });
  assert.match(email, /^Hi Donald,/, "greets the customer by first name");
  assert.match(email, /online credit application/i, "acknowledges the credit application");
  assert.match(email, /It's Alexandra over at American Harley-Davidson\./, "carries the email-format intro");
  assert.match(email, /finance team will reach out/i, "reassures that finance will follow up");
  assert.ok(email.includes(BOOKING), "includes the booking link URL");
  assert.match(email, /you can book here:/i, "offers the booking line");
}

// --- prequalification, with a booking URL: prequal-specific thanks ---
{
  const email = buildCreditLeadEmailDraft({
    firstName: "Micheal",
    dealerName: "American Harley-Davidson",
    agentName: "Alexandra",
    bookingUrl: BOOKING,
    isPrequal: true
  });
  assert.match(email, /pre-qualification submission/i, "prequal uses the pre-qualification wording");
  assert.ok(!/online credit application/i.test(email), "prequal is NOT called a credit application");
  assert.ok(email.includes(BOOKING), "prequal email still includes the booking link");
}

// --- fail-safe: no booking URL → no booking line, body still valid ---
{
  const email = buildCreditLeadEmailDraft({
    firstName: "Ryan",
    dealerName: "American Harley-Davidson",
    agentName: "Alexandra",
    bookingUrl: null,
    isPrequal: false
  });
  assert.ok(!/book here|book an appointment/i.test(email), "no dangling booking line when there is no URL");
  assert.match(email, /finance team will reach out/i, "still acknowledges + reassures without a URL");
  assert.match(email, /^Hi Ryan,/, "greeting still present");
}

// --- name fallback: no name → neutral greeting ---
{
  const email = buildCreditLeadEmailDraft({ agentName: "Alexandra", bookingUrl: BOOKING, isPrequal: false });
  assert.match(email, /^Hi there,/, "falls back to a neutral greeting when no name is given");
}

// --- Source guard: BOTH paths build the credit email via the shared helper ---
const live = fs.readFileSync(path.join(process.cwd(), "services/api/src/routes/sendgridInbound.ts"), "utf8");
const regen = fs.readFileSync(path.join(process.cwd(), "services/api/src/index.ts"), "utf8");

assert.ok(
  /if \(conv\.lead\?\.email && !prefersPhoneOnly\) \{[\s\S]{0,500}publishAdfEmailDraft\(\s*buildCreditLeadEmailDraft\(/.test(
    live
  ),
  "live isCreditLead block must publish a buildCreditLeadEmailDraft email, gated on email + not-phone-only"
);
assert.match(
  live,
  /bookingUrl: buildBookingUrlForLead\(creditProfile\?\.bookingUrl, conv\)/,
  "live credit email must carry a booking link"
);

const regenEmailBranch = regen.indexOf('return respondWithEmailRegeneratedDraft(\n        buildCreditLeadEmailDraft(');
assert.ok(regenEmailBranch >= 0, "regen credit-app email branch must build via buildCreditLeadEmailDraft");
const regenBlock = regen.slice(regenEmailBranch, regenEmailBranch + 400);
assert.match(
  regenBlock,
  /bookingUrl: buildBookingUrlForLead\(dealerProfile\?\.bookingUrl, conv\)/,
  "regen credit email must carry a booking link too (two-path parity)"
);

console.log("PASS credit_lead_email eval — credit-app/prequal leads get a booking-link email (email format), fail-safe on no URL, both paths in parity.");
