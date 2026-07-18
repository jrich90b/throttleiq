/**
 * vendor_html_notice_no_draft:eval — a machine "view this in an HTML-capable email client"
 * notice is vendor noise, not a customer message, and must produce NO conversation and NO draft.
 *
 * Origin (americanharley, 2026-07-18): a non-ADF email from `autosender@trafficlogpro.com`
 * arrived HTML-only; its plain-text alternative was just the boilerplate
 *   "This email contains HTML formatted content, please be sure to view it in an HTML capable
 *    email client."
 * `cleanInboundEmailText` returned that verbatim, the pipeline drafted a generic reply, and the
 * quality gate held it after ~14 wasted self-heal round-trips. Joe confirmed the sender is a
 * vendor notification (no customer to answer).
 *
 * Pins:
 *  1. isHtmlClientNoticeOnly is TRUE only when the notice is the WHOLE body (fail-safe: a real
 *     customer message — even one that also contains the phrase — is never suppressed).
 *  2. sendgridInbound.ts drops such a body BEFORE creating a conversation, returning
 *     reason "non_actionable_html_client_notice".
 */
import fs from "node:fs";
import path from "node:path";
import { isHtmlClientNoticeOnly } from "../services/api/src/domain/inboundMailActionability.ts";

type Case = { id: string; body: string; expected: boolean };

// The exact plain-text body that landed on 2026-07-18, plus phrasing/casing/whitespace variants.
const cases: Case[] = [
  {
    id: "exact_trafficlogpro_notice",
    body: "This email contains HTML formatted content, please be sure to view it in an HTML capable email client.",
    expected: true
  },
  {
    id: "notice_with_surrounding_whitespace",
    body: "\n\n  This email contains HTML formatted content, please be sure to view it in an HTML capable email client.  \n",
    expected: true
  },
  { id: "notice_lowercase_no_period", body: "this email contains html formatted content please view this in an html-capable email client", expected: true },
  // --- fail-direction: real customer content must NEVER be suppressed ---
  { id: "real_customer_used_bike", body: "Hi, do you have any used Road Glides in stock?", expected: false },
  {
    id: "real_words_alongside_the_notice",
    body: "I want to see the 2024 Street Glide. (This email contains HTML formatted content, please view it in an HTML capable email client.)",
    expected: false
  },
  { id: "empty_body", body: "", expected: false },
  { id: "whitespace_only", body: "   \n  ", expected: false },
  { id: "unrelated_short_reply", body: "Sounds good, thanks!", expected: false }
];

const failures: string[] = [];
for (const c of cases) {
  const actual = isHtmlClientNoticeOnly(c.body);
  if (actual !== c.expected) failures.push(`  - ${c.id}: expected ${c.expected}, got ${actual}`);
}

// --- source-guard: the inbound handler is actually wired to drop it (both the import + the gate) ---
const route = fs.readFileSync(path.join(process.cwd(), "services/api/src/routes/sendgridInbound.ts"), "utf8");
if (!route.includes('import { isHtmlClientNoticeOnly } from "../domain/inboundMailActionability.js"')) {
  failures.push("  - sendgridInbound.ts does not import isHtmlClientNoticeOnly");
}
const gateWired =
  /if \(isHtmlClientNoticeOnly\(body\)\) \{[\s\S]{0,400}?reason: "non_actionable_html_client_notice"/.test(route);
if (!gateWired) failures.push("  - sendgridInbound.ts has no early return dropping the notice before conversation creation");
// the gate must sit before the conversation upsert so no junk lead is created
const gateIdx = route.indexOf("isHtmlClientNoticeOnly(body)");
const upsertIdx = route.indexOf("upsertConversationByLeadKey(leadKey");
if (gateIdx < 0 || upsertIdx < 0 || gateIdx > upsertIdx) {
  failures.push("  - the notice gate must run BEFORE upsertConversationByLeadKey (no conversation for vendor noise)");
}

if (failures.length) {
  console.error("FAIL vendor_html_notice_no_draft eval:");
  for (const f of failures) console.error(f);
  process.exit(1);
}
console.log(
  `PASS vendor_html_notice_no_draft eval (${cases.length} classifier cases + 3 wiring guards) — an HTML-client notice is dropped with no conversation and no draft; real customer messages are never suppressed`
);
