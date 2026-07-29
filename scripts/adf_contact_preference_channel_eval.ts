/**
 * adf_contact_preference_channel:eval — pins Joe's 2026-07-26 ruling #5 on which CHANNEL an
 * ADF sales lead's arrival draft goes out on:
 *
 *   "ADF sales leads: TEXT-FIRST unless the lead's preferred/recommended contact method is
 *    EMAIL, in which case generate an email draft."
 *
 * Why this eval exists. Operators filed a recurring "Did not generate email upon lead arrival"
 * report — 5 on 2026-07-24 and 4 more on 2026-07-25 (+17162636134 Alexandra Meinhold,
 * +12707344947 Micheal Simon, +17162658201 Ryan Benedict, +17163528695 Luis Bracero). Every one
 * of those leads has an email address on file but NO declared contact preference
 * (`lead.preferredContactMethod === undefined`), so SMS-first is the ruled-correct behavior and
 * the reports are an expectation gap, not a defect. The email arm itself has existed since
 * 2026-05-27 (`e8169105`) but was never pinned, so nothing stopped a future change from either
 * (a) dropping the email arm or (b) over-correcting into "has an email address => email draft",
 * which is precisely what Joe ruled against. This eval pins BOTH directions.
 *
 * Source-guard pins (same style as call_only_lead_silence:eval / marketplace_relay_no_draft:eval,
 * which pin the sibling arms of the same publish gate):
 *  1. The channel choice keys off the DECLARED preference (`preferredContactMethod === "email"`),
 *     never off the presence of an email address.
 *  2. publishAdfDraftForPreferredContact routes an email-preferred lead to setEmailDraft.
 *  3. The email arm sits AFTER applyAdfReplyInvariant (an email-preferred lead is still subject
 *     to the draft-state invariant) and BEFORE the SMS appendOutbound — so exactly one channel
 *     is published per arrival, never both.
 *  4. Default with no declared preference is the SMS draft_ai path (TEXT-FIRST).
 *  5. Precedence is unchanged: phone-preferred silence and marketplace-relay suppression both
 *     still outrank the email arm (they return before it).
 *
 * Functional pin (parser side — AGENTS.md "ADF preferred-contact parser must recognize both
 * phrasing variants"): an ADF declaring email preference actually resolves to "email", and an
 * ADF that merely carries an email address does NOT.
 *
 * FAIL DIRECTION: an unparseable / absent preference falls through to SMS-first — the lead is
 * still contacted on the channel the dealership can actually deliver on, never dropped.
 *
 * Run: npx tsx scripts/adf_contact_preference_channel_eval.ts
 */
import fs from "node:fs";
import path from "node:path";

import { parseAdfXml } from "../services/api/src/domain/adfParser.ts";

type Check = { id: string; actual: unknown; expected: unknown };
const check = (id: string, actual: unknown, expected: unknown): Check => ({ id, actual, expected });

const route = fs.readFileSync(path.join(process.cwd(), "services/api/src/routes/sendgridInbound.ts"), "utf8");

// --- 1. the preference flag is derived from the DECLARED method, not from "has an email" ---
const prefersEmailDerivedFromDeclaredMethod =
  /const prefersEmailOnly = conv\.lead\?\.preferredContactMethod === "email";/.test(route);
// Guard the exact over-correction the operator reports asked for: an email-address presence test
// must never become the channel switch.
const noEmailAddressPresenceChannelSwitch =
  !/const prefersEmailOnly\s*=\s*[^;]*lead\?\.(email|emailAddress)\b/.test(route);

// --- 2..5. the publish gate: arm order and the one-channel-per-arrival invariant ---
const publishStart = route.indexOf("const publishAdfDraftForPreferredContact");
const publishBlock = publishStart >= 0 ? route.slice(publishStart, publishStart + 2400) : "";

const emailArmPublishesEmailDraft =
  /if \(prefersEmailOnly\) \{\s*\n\s*setEmailDraft\(conv, invariant\.draftText\);\s*\n\s*return \{ ok: true, draft: conv\.emailDraft \};\s*\n\s*\}/.test(
    publishBlock
  );

const idxPhoneArm = publishBlock.indexOf("if (prefersPhoneOnly)");
const idxRelayArm = publishBlock.indexOf("if (relayOnlyMarketplaceLead)");
const idxInvariant = publishBlock.indexOf("const invariant = applyAdfReplyInvariant(text);");
const idxEmailArm = publishBlock.indexOf("if (prefersEmailOnly)");
const idxSmsAppend = publishBlock.indexOf('appendOutbound(conv, "dealership", leadKey, invariant.draftText, "draft_ai"');

const allArmsPresent = [idxPhoneArm, idxRelayArm, idxInvariant, idxEmailArm, idxSmsAppend].every(i => i >= 0);
// phone-preferred silence and relay suppression outrank the channel choice; the invariant is
// applied before either draft is written; the email arm returns before the SMS append.
const armOrderHolds =
  allArmsPresent &&
  idxPhoneArm < idxRelayArm &&
  idxRelayArm < idxInvariant &&
  idxInvariant < idxEmailArm &&
  idxEmailArm < idxSmsAppend;

// --- functional: the ADF parser resolves a declared email preference, and only that ---
const emailPreferredAdf = `<?xml version="1.0"?>
<adf>
 <prospect>
   <requestdate>2026-07-25T10:00:00-04:00</requestdate>
   <vehicle interest="buy" status="new">
     <year>2026</year>
     <make>Harley-Davidson</make>
     <model>Street Glide</model>
   </vehicle>
   <customer>
     <contact>
       <name part="first">Dana</name>
       <name part="last">Whitfield</name>
       <email>dana.whitfield@example.com</email>
       <phone type="voice">7165550143</phone>
       <comment><![CDATA[Preferred contact method: Email. Please send details on the Street Glide.]]></comment>
     </contact>
   </customer>
   <provider><name part="full" type="individual">Room58 - Request details</name></provider>
 </prospect>
</adf>`;

// The operator-reported shape: an email address on file, NO declared preference. Joe ruled this
// stays TEXT-FIRST (+17162636134 / +12707344947 / +17162658201 / +17163528695, 2026-07-25).
const emailAddressOnlyAdf = emailPreferredAdf.replace(
  "Preferred contact method: Email. Please send details on the Street Glide.",
  "Please send details on the Street Glide."
);

// The spaced label variant AGENTS.md requires alongside the colon form.
const emailPreferredDashVariantAdf = emailPreferredAdf.replace(
  "Preferred contact method: Email.",
  "Preferred method of contact - Email."
);

const emailPreferredLead = parseAdfXml(emailPreferredAdf);
const emailAddressOnlyLead = parseAdfXml(emailAddressOnlyAdf);
const emailPreferredDashLead = parseAdfXml(emailPreferredDashVariantAdf);

const checks: Check[] = [
  check("prefers_email_derived_from_declared_method", prefersEmailDerivedFromDeclaredMethod, true),
  check("email_address_presence_is_not_the_channel_switch", noEmailAddressPresenceChannelSwitch, true),
  check("email_preferred_lead_gets_an_email_draft", emailArmPublishesEmailDraft, true),
  check("arm_order_phone_relay_invariant_email_sms", armOrderHolds, true),
  check("sms_first_default_append_present", idxSmsAppend >= 0, true),
  check("declared_email_preference_parses_colon_variant", emailPreferredLead.preferredContactMethod, "email"),
  check("declared_email_preference_parses_dash_variant", emailPreferredDashLead.preferredContactMethod, "email"),
  check("email_address_alone_declares_no_preference", emailAddressOnlyLead.preferredContactMethod, undefined),
  check("email_address_alone_still_has_the_address", emailAddressOnlyLead.email, "dana.whitfield@example.com")
];

const failures = checks.filter(c => JSON.stringify(c.actual) !== JSON.stringify(c.expected));
if (failures.length) {
  console.error("FAIL adf_contact_preference_channel eval:");
  for (const f of failures) console.error(`  - ${f.id}: expected ${JSON.stringify(f.expected)}, got ${JSON.stringify(f.actual)}`);
  process.exit(1);
}
console.log(
  `PASS ADF contact-preference channel eval (${checks.length} assertions) — text-first unless the lead DECLARED email preference`
);
