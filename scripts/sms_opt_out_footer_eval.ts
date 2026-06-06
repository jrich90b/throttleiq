import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "sms-opt-out-footer-eval-"));
process.env.CONVERSATIONS_DB_PATH = path.join(tempDir, "conversations.json");

const {
  INITIAL_SMS_OPTOUT_FOOTER,
  appendOutbound,
  ensureInitialSmsOptOutFooter,
  finalizeDraftAsSent,
  hasSmsOptOutLanguage,
  upsertConversationByLeadKey
} = await import("../services/api/src/domain/conversationStore.ts");

const firstSms = "Hi Sam — This is Alexandra at American Harley-Davidson. Thanks for reaching out.";
const secondSms = "I can send options over shortly.";

const firstDraftConv = upsertConversationByLeadKey("+17165550101", "suggest");
const firstDraft = appendOutbound(firstDraftConv, "salesperson", firstDraftConv.leadKey, firstSms, "draft_ai");
assert.ok(firstDraft, "first SMS draft should be stored");
assert.match(firstDraft!.body, /Reply STOP to opt out\.$/);
assert.equal(hasSmsOptOutLanguage(firstDraft!.body), true);

const secondDraft = appendOutbound(firstDraftConv, "salesperson", firstDraftConv.leadKey, secondSms, "draft_ai");
assert.ok(secondDraft, "second SMS draft should be stored");
assert.match(
  secondDraft!.body,
  /Reply STOP to opt out\.$/,
  "unsent drafts should not suppress first-touch opt-out language on later drafts"
);

const finalizeConv = upsertConversationByLeadKey("+17165550102", "suggest");
const draftToSend = appendOutbound(finalizeConv, "salesperson", finalizeConv.leadKey, firstSms, "draft_ai");
assert.ok(draftToSend, "draft to finalize should be stored");
const finalized = finalizeDraftAsSent(
  finalizeConv,
  draftToSend!.id,
  firstSms,
  "twilio",
  "SM_eval_opt_out"
);
assert.equal(finalized.usedDraft, true);
assert.match(finalizeConv.messages[0].body, /Reply STOP to opt out\.$/);
assert.equal(finalizeConv.messages[0].provider, "twilio");

const sentConv = upsertConversationByLeadKey("+17165550103", "suggest");
const prepared = ensureInitialSmsOptOutFooter(sentConv, firstSms, {
  provider: "twilio",
  from: "+17165550000",
  to: sentConv.leadKey
});
assert.equal(prepared.endsWith(INITIAL_SMS_OPTOUT_FOOTER), true);
const sent = appendOutbound(sentConv, "+17165550000", sentConv.leadKey, prepared, "twilio", "SM_eval_sent");
assert.equal(sent?.body, prepared, "prepared Twilio send text and stored timeline text should match");
const afterSent = appendOutbound(
  sentConv,
  "+17165550000",
  sentConv.leadKey,
  "I can send options over shortly.",
  "twilio",
  "SM_eval_after_sent"
);
assert.doesNotMatch(
  afterSent?.body ?? "",
  /Reply STOP to opt out\./,
  "later Twilio-sent SMS should not repeat the opt-out footer after a sent SMS already exists"
);

const existingLanguageConv = upsertConversationByLeadKey("+17165550104", "suggest");
const alreadyCompliant = ensureInitialSmsOptOutFooter(
  existingLanguageConv,
  "Thanks for reaching out. Reply STOP to unsubscribe.",
  { provider: "twilio", from: "+17165550000", to: existingLanguageConv.leadKey }
);
assert.equal(
  (alreadyCompliant.match(/reply stop/gi) ?? []).length,
  1,
  "existing opt-out language should not be duplicated"
);

const emailConv = upsertConversationByLeadKey("sam@example.com", "suggest");
appendOutbound(emailConv, "sales@example.com", "sam@example.com", firstSms, "draft_ai");
assert.ok(emailConv.emailDraft, "email-thread draft should remain an email draft");
assert.doesNotMatch(emailConv.emailDraft!, /Reply STOP to opt out\./);

const apiSource = await fs.readFile(path.resolve("services/api/src/index.ts"), "utf8");
assert.match(
  apiSource,
  /let smsBody = formatSmsLayout\(body\);[\s\S]*?smsBody = ensureInitialSmsOptOutFooter\(/,
  "manual SMS send must prepare first-touch opt-out copy before duplicate checks and Twilio send"
);
assert.match(
  apiSource,
  /function resolveManualSmsDestination\(conv: Conversation\): string \{[\s\S]*?conv\.lead\?\.phone[\s\S]*?conv\.leadKey[\s\S]*?conv\.id/,
  "manual SMS destination must prefer the saved lead/contact phone before falling back to conversation keys"
);
assert.match(
  apiSource,
  /const to = resolveManualSmsDestination\(conv\);/,
  "manual SMS send must use the resolved destination helper"
);
assert.match(
  apiSource,
  /async function sendTwilioOutboundSmsOrMms[\s\S]*?mediaUrls\.length > 1 \? mediaUrls\.map\(url => \[url\]\) : \[mediaUrls\]/,
  "manual MMS sends must split multiple attachments into separate Twilio requests"
);
assert.match(
  apiSource,
  /const msg = await sendTwilioOutboundSmsOrMms\({[\s\S]*?mediaUrls,[\s\S]*?timeoutMs: outboundSendTimeoutMs[\s\S]*?}\);/,
  "manual SMS route must use the split-capable Twilio send helper"
);
const invalidManualSmsBranch = apiSource.match(/if \(!to\.startsWith\("\+"\)\) \{[\s\S]*?error: "lead has no valid phone number for SMS send"[\s\S]*?\n  \}/)?.[0] ?? "";
assert.ok(invalidManualSmsBranch, "manual SMS invalid-phone branch should return a clear missing-phone error");
assert.doesNotMatch(
  invalidManualSmsBranch,
  /appendOutbound|finalizeDraftAsSent|reconcileManualSmsSendState/,
  "manual SMS invalid-phone branch must not store a failed send as a normal outbound message"
);
assert.match(
  apiSource,
  /const smsMessage = ensureInitialSmsOptOutFooter\(conv, message,[\s\S]*?body: smsMessage/,
  "scheduled SMS sends must send the prepared opt-out copy"
);
assert.match(
  apiSource,
  /publishedText = ensureInitialSmsOptOutFooter\(conv, publishedText,[\s\S]*?twilioMessageWebhookResponse\(publishedText/,
  "live Twilio autopilot replies must return the prepared opt-out copy"
);
assert.match(
  apiSource,
  /const body = conv[\s\S]*?ensureInitialSmsOptOutFooter\(conv, message\.body,[\s\S]*?body,/,
  "async Twilio autopilot delivery must use the prepared opt-out copy"
);

console.log("sms_opt_out_footer_eval passed");
