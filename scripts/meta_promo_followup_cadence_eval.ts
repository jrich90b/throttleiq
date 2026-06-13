/**
 * Meta-promo initial-ADF follow-up cadence guard. Production fixture: Jason
 * +17162801172 (Ref 11453) and +17163614796 — H-D Meta Promo Offer ADF leads
 * that got Alexandra's opener and then nothing: followUp/followUpCadence/
 * dialogState all null. Cause: the isMetaPromoOffer generic-offer branch in
 * sendgridInbound.ts returned after queueing the reply without ever calling
 * startFollowUpCadence, unlike every other initial-ADF branch. This guards that
 * the branch starts a cadence before it returns.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const src = fs.readFileSync(
  path.resolve("services/api/src/routes/sendgridInbound.ts"),
  "utf8"
);

const branchIdx = src.indexOf("if (isMetaPromoOffer && isGenericMetaOfferModel(metaOfferRawModel)) {");
assert.ok(branchIdx >= 0, "the Meta promo offer generic-offer branch must exist");

// The branch's initial reply is queued at the next queueInitialDraftForPreferredContact.
const queueIdx = src.indexOf("queueInitialDraftForPreferredContact(ack, initialMediaUrls)", branchIdx);
assert.ok(queueIdx > branchIdx, "the branch must queue an initial draft");

const branchBody = src.slice(branchIdx, queueIdx);
assert.match(
  branchBody,
  /startFollowUpCadence\(/,
  "Meta promo offer initial-ADF branch must start a re-engagement cadence before returning (Jason regression)"
);
// And it must be guarded so it never overrides a handoff/booked/existing cadence.
assert.match(
  branchBody,
  /!conv\.followUpCadence\?\.status[\s\S]*manual_handoff/,
  "cadence start must be guarded (no existing cadence / not a handoff / not booked)"
);

console.log("PASS meta promo follow-up cadence eval");
