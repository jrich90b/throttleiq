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

// ── The approved email must actually SURVIVE the draft-state invariants.
//
// +17169941544 (2026-07-28): that ADF body literally contained "credit application", which sets
// hasExplicitFinanceActionSignal => financePriority. The email's own booking line ("you can book
// here: <url>") trips looksLikeSchedulingPromptDraft on the bare word "book", so
// finance_priority_schedule_prompt_guard killed the whole email and converted it into a "Review ADF
// reply before sending" todo — the approved message never reached the customer, on roughly 1 in 6
// credit leads. That guard's target is MODEL-composed scheduling pressure, not a booking link Joe
// ruled in on 2026-07-25.
{
  const { applyDraftStateInvariants } = await import(
    "../services/api/src/domain/draftStateInvariants.ts"
  );
  const FINANCE_ADF_BODY =
    "WEB LEAD (ADF) Source: HDFS COA Online Inquiry: submitted a credit application";
  const approvedEmail = buildCreditLeadEmailDraft({
    firstName: "Donald",
    dealerName: "American Harley-Davidson",
    agentName: "Alexandra",
    bookingUrl: BOOKING,
    isPrequal: false
  });

  const blocked = applyDraftStateInvariants({
    inboundText: FINANCE_ADF_BODY,
    draftText: approvedEmail,
    // Exact live state read off the box for +17169941544: dialogState "payments_handoff" satisfies
    // hasFinanceContext(), and the ADF body supplies hasExplicitFinanceActionSignal() — together
    // financePriority. The inbound carries no scheduling language, so schedulingSignal is false.
    dialogState: "payments_handoff",
    classificationBucket: "finance_prequal",
    classificationCta: "hdfs_coa"
  });
  assert.equal(
    blocked.allow,
    false,
    "regression pin: without the exemption the approved credit email IS blocked (this was the live bug)"
  );
  assert.equal(blocked.reason, "finance_priority_schedule_prompt_guard");

  const allowed = applyDraftStateInvariants({
    inboundText: FINANCE_ADF_BODY,
    draftText: approvedEmail,
    // Exact live state read off the box for +17169941544: dialogState "payments_handoff" satisfies
    // hasFinanceContext(), and the ADF body supplies hasExplicitFinanceActionSignal() — together
    // financePriority. The inbound carries no scheduling language, so schedulingSignal is false.
    dialogState: "payments_handoff",
    classificationBucket: "finance_prequal",
    classificationCta: "hdfs_coa",
    approvedDeterministicTemplate: true
  });
  assert.equal(
    allowed.allow,
    true,
    "the approved deterministic credit-lead template must publish despite the finance scheduling guard"
  );
  assert.match(allowed.draftText, /book/i, "the booking line survives intact");

  // The exemption is NARROW — every other invariant still applies with the flag set.
  const emptyDraft = applyDraftStateInvariants({
    inboundText: FINANCE_ADF_BODY,
    draftText: "   ",
    // Exact live state read off the box for +17169941544: dialogState "payments_handoff" satisfies
    // hasFinanceContext(), and the ADF body supplies hasExplicitFinanceActionSignal() — together
    // financePriority. The inbound carries no scheduling language, so schedulingSignal is false.
    dialogState: "payments_handoff",
    classificationBucket: "finance_prequal",
    classificationCta: "hdfs_coa",
    approvedDeterministicTemplate: true
  });
  assert.equal(emptyDraft.allow, false, "the exemption does not disable the other invariants");
  assert.equal(emptyDraft.reason, "empty_draft");
}

// Source pins: exactly ONE invariant consults the flag, and it is passed on the credit-lead email
// publish call. If it ever appears on an LLM-composed path, the count assertion fails.
{
  const invariantSrc = fs.readFileSync(
    path.join(process.cwd(), "services/api/src/domain/draftStateInvariants.ts"),
    "utf8"
  );
  assert.equal(
    (invariantSrc.match(/approvedDeterministicTemplate !== true/g) ?? []).length,
    1,
    "exactly one invariant may be exempted by the approved-template flag"
  );
  assert.ok(
    /finance_priority_schedule_prompt_guard/.test(
      invariantSrc.slice(
        invariantSrc.indexOf("approvedDeterministicTemplate !== true"),
        invariantSrc.indexOf("approvedDeterministicTemplate !== true") + 260
      )
    ),
    "the exempted invariant is finance_priority_schedule_prompt_guard specifically"
  );
  assert.ok(
    /buildCreditLeadEmailDraft\(\{[\s\S]{0,600}\}\),[\s\S]{0,400}\btrue\b/.test(live),
    "the approved-template flag is passed on the credit-lead email publish call"
  );
}

console.log("PASS credit_lead_email eval — credit-app/prequal leads get a booking-link email (email format), fail-safe on no URL, both paths in parity, and the approved template survives the finance scheduling guard.");
