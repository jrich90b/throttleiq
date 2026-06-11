import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "outbound-lead-in-eval-"));
process.env.CONVERSATIONS_DB_PATH = path.join(tempDir, "conversations.json");

const { appendInbound, appendOutbound, upsertConversationByLeadKey } = await import(
  "../services/api/src/domain/conversationStore.ts"
);

let convSeq = 0;
function convWithInbound(inboundBody: string) {
  convSeq += 1;
  const conv = upsertConversationByLeadKey(`+1716555${String(2000 + convSeq)}`, "suggest");
  appendInbound(conv, {
    from: conv.leadKey,
    to: "+17165550000",
    body: inboundBody,
    receivedAt: new Date().toISOString(),
    provider: "twilio",
    providerMessageId: `SM_eval_in_${convSeq}`
  });
  return conv;
}

// Photo share + draft that already acknowledges the photo: drop the agreement
// opener instead of stacking "Sounds good." in front of it (Mustafa 2026-06-10).
const photoAckConv = convWithInbound("Here is a photo of the HD I like.");
const photoAck = appendOutbound(
  photoAckConv,
  "salesperson",
  photoAckConv.leadKey,
  "Got it. Thanks for the photo — that helps a lot. What do you like most about that bike (style, power, riding position)?",
  "twilio",
  "SM_eval_photo_ack"
);
assert.ok(photoAck, "photo ack outbound should be stored");
assert.match(photoAck!.body, /^Thanks for the photo/);
assert.doesNotMatch(photoAck!.body, /^(Sounds good|Got it)/);
assert.doesNotMatch(photoAck!.body, /Thanks for sending that over\.\s*Thanks/);

// Photo share + draft with no acknowledgment of its own: contextual lead-in.
const photoLeadConv = convWithInbound("I just sent a picture of the bike I want.");
const photoLead = appendOutbound(
  photoLeadConv,
  "salesperson",
  photoLeadConv.leadKey,
  "Got it. Happy to help narrow it down.",
  "twilio",
  "SM_eval_photo_lead"
);
assert.ok(photoLead, "photo lead outbound should be stored");
assert.match(photoLead!.body, /^Thanks for sending that over\. Happy to help narrow it down\./);

// Plain statement inbound: no branch matches, so the filler opener is dropped
// entirely instead of defaulting to "Sounds good."
const statementConv = convWithInbound("I'll swing by Saturday afternoon.");
const statement = appendOutbound(
  statementConv,
  "salesperson",
  statementConv.leadKey,
  "Got it — see you then.",
  "twilio",
  "SM_eval_statement"
);
assert.ok(statement, "statement outbound should be stored");
assert.match(statement!.body, /^See you then\./);
assert.doesNotMatch(statement!.body, /^Sounds good/);

// Thanks inbound keeps its contextual lead-in.
const thanksConv = convWithInbound("Thanks for the help today");
const thanks = appendOutbound(
  thanksConv,
  "salesperson",
  thanksConv.leadKey,
  "Got it. Anytime.",
  "twilio",
  "SM_eval_thanks"
);
assert.ok(thanks, "thanks outbound should be stored");
assert.match(thanks!.body, /^You're welcome\. Anytime\./);

// Question inbound keeps the "Sure." lead-in path.
const questionConv = convWithInbound("Can you send pictures of the Road Glide?");
const question = appendOutbound(
  questionConv,
  "salesperson",
  questionConv.leadKey,
  "Got it — sending those over shortly.",
  "twilio",
  "SM_eval_question"
);
assert.ok(question, "question outbound should be stored");
assert.match(question!.body, /^Sure\./);

// Whole-body "Got it." with an unmatched inbound keeps the original text rather
// than inventing an agreement that nothing in the inbound supports.
const wholeBodyConv = convWithInbound("I'll be there around noon.");
const wholeBody = appendOutbound(
  wholeBodyConv,
  "salesperson",
  wholeBodyConv.leadKey,
  "Got it.",
  "twilio",
  "SM_eval_whole_body"
);
assert.ok(wholeBody, "whole-body outbound should be stored");
assert.match(wholeBody!.body, /^Got it\./);

// A draft that natively opens with "Sounds good." gets the same treatment as a
// "Got it." opener — no blind agreement when the customer shared a photo.
const nativeConv = convWithInbound("Here is a photo of the HD I like.");
const native = appendOutbound(
  nativeConv,
  "salesperson",
  nativeConv.leadKey,
  "Sounds good. Thanks for the photo — that helps.",
  "twilio",
  "SM_eval_native"
);
assert.ok(native, "native sounds-good outbound should be stored");
assert.match(native!.body, /^Thanks for the photo — that helps\./);

console.log("outbound_lead_in_eval passed");
