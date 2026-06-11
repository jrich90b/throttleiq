/**
 * Customer photo share eval — parser-first handling for "here's a photo of the
 * bike I like" turns. Fixture: Mustafa +17164368801, 2026-06-10.
 */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";

import { checkMessage } from "./voice_charter_audit.ts";

// customerPhotoShare imports llmDraft, whose module scope constructs the
// OpenAI client and throws without a key (same constraint the shadow replay
// documents). The eval never makes LLM calls — vision is env-gated off.
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "eval-no-live-key";
const {
  buildCustomerPhotoShareTodoSummary,
  buildCustomerVehiclePhotoShareReply,
  buildIdentifiedPhotoShareReply,
  detectCustomerVehiclePhotoShareText,
  findNearestInboundImageUrls,
  isSalesPhotoShareContext,
  isSalesPhotoShareConversation,
  resolveUploadLocalPath,
  shouldUseVisionIdentification,
  visionFamilyCandidates
} = await import("../services/api/src/domain/customerPhotoShare.ts");

// Detector: production fixture and neighbors.
assert.equal(
  detectCustomerVehiclePhotoShareText({ text: "Here is a photo of the HD I like.", hasInboundMedia: false }),
  true,
  "Mustafa's literal turn must detect"
);
assert.equal(
  detectCustomerVehiclePhotoShareText({ text: "I just sent you a pic of the bike I want", hasInboundMedia: false }),
  true
);
assert.equal(
  detectCustomerVehiclePhotoShareText({ text: "", hasInboundMedia: true }),
  true,
  "bare MMS image counts"
);
assert.equal(
  detectCustomerVehiclePhotoShareText({ text: "Check this one out", hasInboundMedia: true }),
  true,
  "short caption with image counts"
);
assert.equal(
  detectCustomerVehiclePhotoShareText({ text: "Can you send me pictures of the Road Glide?", hasInboundMedia: false }),
  false,
  "asking US for photos is the media-request flow"
);
assert.equal(
  detectCustomerVehiclePhotoShareText({ text: "Please send a photo of the Nightster", hasInboundMedia: false }),
  false
);
assert.equal(
  detectCustomerVehiclePhotoShareText({
    text: "What time do you close today? Also is the Iron 883 still there?",
    hasInboundMedia: true
  }),
  false,
  "question-bearing turns are not photo shares even with media"
);

// Context gate: paperwork/status images in delivery/finance flows are not bike matches.
assert.equal(isSalesPhotoShareContext("purchase_delivery"), false);
assert.equal(
  isSalesPhotoShareConversation({ closedReason: "sold", dialogState: { name: "small_talk" } }),
  false,
  "sold customers' photos are proud-owner moments, not inventory matches"
);
assert.equal(
  isSalesPhotoShareConversation({ followUpCadence: { kind: "post_sale" }, dialogState: { name: "small_talk" } }),
  false
);
assert.equal(
  isSalesPhotoShareConversation({ dialogState: { name: "small_talk" } }),
  true
);
assert.equal(isSalesPhotoShareContext("finance_docs"), false);
assert.equal(isSalesPhotoShareContext("small_talk"), true);
assert.equal(isSalesPhotoShareContext("inventory_init"), true);
assert.equal(isSalesPhotoShareContext(null), true);

// Reply builder: charter-clean in all shapes.
for (const args of [
  { firstName: "Mustafa", mentionedModel: null },
  { firstName: null, mentionedModel: null },
  { firstName: "Sam", mentionedModel: "Ultra Limited" }
]) {
  const reply = buildCustomerVehiclePhotoShareReply(args as any);
  const violations = checkMessage(reply, { firstOutbound: false, smsLike: true, staffHasSent: false });
  assert.deepEqual(violations, [], `photo reply must be charter-clean: "${reply}" -> ${JSON.stringify(violations)}`);
  assert.match(reply, /Thanks for sending that over/);
  assert.match(reply, /in stock|coming in/);
  assert.match(reply, /today/);
}
assert.match(buildCustomerPhotoShareTodoSummary("Mustafa"), /^Mustafa texted a photo/);

// Vision phase 2 deterministic pieces.
assert.equal(
  resolveUploadLocalPath(
    "https://api.americanharley.leadrider.ai/uploads/mms/MMbd063b/0.jpg",
    "/data"
  ),
  "/data/uploads/mms/MMbd063b/0.jpg"
);
assert.equal(resolveUploadLocalPath("https://example.com/external.jpg", "/data"), null);
assert.equal(
  resolveUploadLocalPath("https://x/uploads/../../etc/passwd", "/data"),
  "/data/uploads//etc/passwd".replace("//", "/"),
  "path traversal stripped"
);

const photoConv = {
  messages: [
    { direction: "in", at: "2026-06-10T18:01:07.000Z", mediaUrls: [] },
    { direction: "in", at: "2026-06-10T18:01:27.000Z", mediaUrls: ["https://x/uploads/mms/A/0.jpg"] },
    { direction: "out", at: "2026-06-11T09:45:08.000Z", mediaUrls: ["https://x/uploads/messages/out.jpg"] }
  ]
};
assert.deepEqual(
  findNearestInboundImageUrls(photoConv as any, "2026-06-10T18:01:07.000Z"),
  ["https://x/uploads/mms/A/0.jpg"],
  "nearest inbound image within window is found; outbound media ignored"
);
assert.deepEqual(
  findNearestInboundImageUrls(photoConv as any, "2026-06-12T18:01:07.000Z"),
  [],
  "media outside the 30-minute window is not trusted"
);

assert.deepEqual(
  visionFamilyCandidates("Electra Glide / Ultra Limited (Touring)"),
  ["Electra Glide", "Ultra Limited"],
  "compound vision families split into match candidates"
);
assert.deepEqual(visionFamilyCandidates("Fat Boy"), ["Fat Boy"]);
assert.deepEqual(visionFamilyCandidates("Street Glide or Road Glide"), ["Street Glide", "Road Glide"]);

assert.equal(shouldUseVisionIdentification(null), false);
assert.equal(
  shouldUseVisionIdentification({ isMotorcycle: true, modelFamily: "Ultra Limited", confidence: 0.85 }),
  true
);
assert.equal(
  shouldUseVisionIdentification({ isMotorcycle: true, modelFamily: "", confidence: 0.95 }),
  false,
  "no family = no identification"
);
assert.equal(
  shouldUseVisionIdentification({ isMotorcycle: false, modelFamily: "Ultra Limited", confidence: 0.95 }),
  false,
  "paperwork photos never identify"
);
assert.equal(
  shouldUseVisionIdentification({ isMotorcycle: true, modelFamily: "Ultra Limited", confidence: 0.5 }),
  false,
  "low confidence falls back"
);

const identified = buildIdentifiedPhotoShareReply({
  firstName: "Mustafa",
  modelFamily: "Ultra Limited",
  matches: [
    { year: "2021", model: "Ultra Limited", color: "Billiard Red/Vivid Black", price: null },
    { year: "2022", model: "Ultra Limited", color: "Vivid Black", price: 20995 }
  ]
});
assert.match(identified, /looks like an Ultra Limited/);
assert.match(identified, /2021 Billiard Red\/Vivid Black Ultra Limited/);
assert.match(identified, /\$20,995/);
const noStock = buildIdentifiedPhotoShareReply({ firstName: "Sam", modelFamily: "Fat Boy", matches: [] });
assert.match(noStock, /looks like a Fat Boy/);
assert.match(noStock, /keep an eye out/);
for (const reply of [identified, noStock]) {
  const violations = checkMessage(reply, { firstOutbound: false, smsLike: true, staffHasSent: false });
  assert.deepEqual(violations, [], `identified reply must be charter-clean: "${reply}"`);
}

// Live + regenerate parity (AGENTS.md parser-first rule).
const apiSource = await fs.readFile(path.resolve("services/api/src/index.ts"), "utf8");
assert.ok(
  (apiSource.match(/customer_shared_vehicle_photo/g) ?? []).length >= 5,
  "both live and regen paths must route customer_shared_vehicle_photo (consts, handlers, blocker list, route outcomes)"
);
assert.match(
  apiSource,
  /recordRouteOutcome\("live", "customer_shared_vehicle_photo"/,
  "live twilio path must record the photo-share route outcome"
);
assert.match(
  apiSource,
  /recordRouteOutcome\("regen", "customer_shared_vehicle_photo"/,
  "regenerate path must record the photo-share route outcome"
);
assert.match(
  apiSource,
  /customerPhotoShareAccepted[\s\S]{0,1200}setDialogState\(conv, "inventory_init"\)/,
  "live photo-share handler must move dialog state off small_talk"
);
assert.match(
  apiSource,
  /regenCustomerPhotoShare[\s\S]{0,1200}setDialogState\(conv, "inventory_init"\)/,
  "regen photo-share handler must move dialog state off small_talk"
);

// Cadence regeneration must never outrank a photo-share turn (the third path
// that hijacked Mustafa's regenerate: a cadence nudge pitching a sold unit).
assert.match(
  apiSource,
  /regeneratePhotoShareTurn[\s\S]{0,400}skipCadenceContextualRegenerate[\s\S]{0,200}regeneratePhotoShareTurn/,
  "photo-share turns must skip cadence contextual regeneration"
);

// The shared inventory-status availability route (live + regen) must hand
// unit-less image_availability_check turns to photo-share handling instead of
// the generic "I'll have the team check current options" punt.
assert.match(
  apiSource,
  /intent === "image_availability_check"\) \{[\s\S]{0,1800}buildPhotoShareReplyWithVision/,
  "image_availability_check with no identifiable unit must route to photo-share handling"
);
assert.equal(
  (apiSource.match(/buildPhotoShareReplyWithVision\(\{/g) ?? []).length,
  3,
  "all three photo-share convergence points must use the vision-enriched reply"
);

const llmSource = await fs.readFile(path.resolve("services/api/src/domain/llmDraft.ts"), "utf8");
assert.match(llmSource, /"customer_shared_vehicle_photo"/, "parser union/schema must include the action");
assert.match(
  llmSource,
  /Here is a photo of the HD I like\./,
  "parser few-shots must include the Mustafa production fixture"
);

console.log("PASS customer photo share eval");
