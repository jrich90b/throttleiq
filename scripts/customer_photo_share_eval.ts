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
  buildNonMotorcyclePhotoShareReply,
  buildMotorcyclePartPhotoShareReply,
  sanitizeSocialPhotoReply,
  detectCustomerVehiclePhotoShareText,
  findNearestInboundImageUrls,
  isSalesPhotoShareContext,
  isSalesPhotoShareConversation,
  isTradePhotoShareConversation,
  buildTradePhotoShareReply,
  buildTradePhotoShareTodoSummary,
  resolveUploadLocalPath,
  shouldUseVisionIdentification,
  visionFamilyCandidates,
  isVinPhotoHandlingEnabled,
  isConfidentVinRead,
  buildVinPlatePhotoShareReply,
  buildVinPlatePhotoShareTodoSummary,
  captureVinPlateOnConversation
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

// Non-motorcycle photo: NEVER claim to match it against inventory; respond like a human.
// (a) True chatter — vision composed a warm one-liner ("Haha, nice catch!") -> reciprocate it.
const chatterReply = buildNonMotorcyclePhotoShareReply("Bobby", "Haha, nice catch!");
assert.match(chatterReply, /nice catch/i, "a friendly fish/pet photo gets the warm vision ack, not a sales pivot");
// (b) Document / unclear image — no safe social line -> a neutral acknowledgement (not gushing, not sales).
const neutralReply = buildNonMotorcyclePhotoShareReply("Bobby");
assert.match(neutralReply, /Bobby/, "neutral non-motorcycle reply greets by name");
assert.match(neutralReply, /thanks for sending/i, "neutral reply just acknowledges");
// (c) The guard drops a vision line that pivots to sales/bikes or asks a question.
assert.equal(sanitizeSocialPhotoReply("Haha, nice catch!"), "Haha, nice catch!", "a clean social ack passes");
assert.equal(sanitizeSocialPhotoReply("Let me match it against what we've got in stock"), "", "sales pivot is dropped");
assert.equal(sanitizeSocialPhotoReply("Is that a bike you're interested in?"), "", "a bike question is dropped");
assert.equal(sanitizeSocialPhotoReply(""), "", "empty stays empty");
assert.equal(
  buildNonMotorcyclePhotoShareReply("Bobby", "Let me match it against stock"),
  "Thanks for sending that over, Bobby!",
  "an unsafe vision line falls back to the neutral acknowledgement"
);
// No non-motorcycle reply ever claims to match inventory.
for (const reply of [chatterReply, neutralReply]) {
  for (const banned of [/match it against/i, /in stock/i, /coming in/i, /what we'?ve got/i]) {
    assert.ok(!banned.test(reply), `non-motorcycle reply must not claim to match inventory (${banned})`);
  }
}

// Motorcycle PART/accessory: route to parts/service — never an inventory match, never chatter.
const partReply = buildMotorcyclePartPhotoShareReply("Bobby");
assert.match(partReply, /Bobby/, "part reply greets by name");
assert.match(partReply, /\bpart\b/i, "part reply recognizes it's a part");
assert.match(partReply, /grab|put on|install/i, "part reply lets the customer disambiguate buy vs install");
for (const banned of [/match it against/i, /in stock/i, /coming in/i, /what we'?ve got/i]) {
  assert.ok(!banned.test(partReply), `part reply must not claim to match inventory (${banned})`);
}

// Source guard: the vision flow diverts an is_motorcycle=false image away from the bike-match
// reply (only on an explicit false — fail-safe), passing the vision social line through, AND
// routes a part photo (checked first) to the parts reply.
const photoShareSource = await fs.readFile(
  path.resolve("services/api/src/domain/customerPhotoShare.ts"),
  "utf8"
);
assert.match(
  photoShareSource,
  /description\.isMotorcyclePart === true[\s\S]{0,300}buildMotorcyclePartPhotoShareReply[\s\S]{0,400}kind: "part"/,
  "buildPhotoShareReplyWithVision must route an is_motorcycle_part image to the parts reply with kind=part"
);
assert.match(
  photoShareSource,
  /description\.isMotorcycle === false[\s\S]{0,300}buildNonMotorcyclePhotoShareReply\(args\.firstName, description\.socialReply\)/,
  "buildPhotoShareReplyWithVision must divert an is_motorcycle=false image to the social/neutral reply with the vision line"
);
// The part branch must come BEFORE the generic non-motorcycle branch (a part is is_motorcycle=false too).
assert.ok(
  photoShareSource.indexOf("description.isMotorcyclePart === true") <
    photoShareSource.indexOf("description.isMotorcycle === false"),
  "the part branch must be checked before the generic non-motorcycle branch"
);
// Caller parity: both paths re-point the agent context to parts/service for a part photo.
const apiSourcePart = await fs.readFile(path.resolve("services/api/src/index.ts"), "utf8");
assert.ok(
  (apiSourcePart.match(/photoShare\.kind === "part"[\s\S]{0,140}CUSTOMER_PHOTO_SHARE_PART_AGENT_CONTEXT/g) ?? []).length >= 3,
  "all three photo-share convergence points must re-point the context to parts for a part photo"
);

// --- Trade-in photo framing (Jessica Ornce +17167134728, 2026-06-23). ---
// A photo in a TRADE conversation is the customer's trade unit to appraise, not a bike to match
// against our stock. Each of these signals (any one) must flip the conversation to the trade frame.
for (const tradeConv of [
  { classification: { bucket: "trade_in_sell", cta: "value_my_trade" } }, // Jessica's exact shape
  { classification: { cta: "sell_my_bike" } },
  { followUp: { reason: "non_motorcycle_trade" } },
  { dialogState: { name: "trade_init" } },
  { lead: { source: "Trade Accelerator - Trade In" } }
]) {
  assert.equal(
    isTradePhotoShareConversation(tradeConv as any),
    true,
    `trade signal must flip to the trade frame: ${JSON.stringify(tradeConv)}`
  );
}
// A buyer sharing a bike they like is NOT a trade — keep the inventory-match path.
assert.equal(
  isTradePhotoShareConversation({ dialogState: { name: "small_talk" }, classification: { bucket: "inventory_interest" } } as any),
  false,
  "a buyer photo-share must stay on the inventory-match path"
);
assert.equal(isTradePhotoShareConversation({} as any), false, "no trade signal = not a trade frame");
assert.equal(
  isTradePhotoShareConversation({ lead: { source: "Trade Show Booth" } } as any),
  false,
  "a 'Trade Show' lead is not a trade-IN — must not flip to the trade frame"
);

// Trade reply: warm, routes to the appraiser, and NEVER pivots to an inventory match or a number.
const tradeReply = buildTradePhotoShareReply("Jessica");
assert.match(tradeReply, /Thanks for sending those over, Jessica!/);
assert.match(tradeReply, /appraiser/i, "trade reply routes to appraisal");
{
  const violations = checkMessage(tradeReply, { firstOutbound: false, smsLike: true, staffHasSent: false });
  assert.deepEqual(violations, [], `trade reply must be charter-clean: "${tradeReply}"`);
}
for (const banned of [/match it against/i, /in stock/i, /coming in/i, /what we'?ve got/i, /\$\d/]) {
  assert.ok(!banned.test(tradeReply), `trade reply must not pivot to inventory/price (${banned})`);
}

// Trade todo: appraisal handoff, not "reply with matching in-stock units"; vision hint is optional.
const tradeTodoBare = buildTradePhotoShareTodoSummary({ firstName: "Jessica" });
assert.match(tradeTodoBare, /^Jessica sent photo\(s\) of their trade-in/);
assert.match(tradeTodoBare, /appraiser/i);
assert.ok(!/matching in-stock|in-stock or incoming units/i.test(tradeTodoBare), "trade todo must not say to match inventory");
const tradeTodoHint = buildTradePhotoShareTodoSummary({ firstName: "Jessica", visionHint: "a black motorcycle (spoke wheels)" });
assert.match(tradeTodoHint, /Vision \(unconfirmed\): a black motorcycle \(spoke wheels\)\./);

// Source guards: the vision flow diverts a trade conversation, and none of the 3 convergence
// points set the inventory dialog/agent context for a trade-in photo.
assert.match(
  photoShareSource,
  /isTradePhotoShareConversation\(args\.conv as any\)[\s\S]{0,120}buildTradePhotoShareResult/,
  "buildPhotoShareReplyWithVision must divert a trade conversation to the trade frame"
);
assert.equal(
  (apiSource.match(/isTradePhotoShareConversation\(/g) ?? []).length >= 3,
  true,
  "all 3 photo-share convergence points must gate inventory framing on the trade check"
);
for (const guard of [
  /tradePhotoContext = isTradePhotoShareConversation\(args\.conv\)[\s\S]{0,160}if \(!tradePhotoContext\) \{[\s\S]{0,140}setDialogState\(args\.conv, "inventory_init"\)/,
  /regenTradePhotoContext = isTradePhotoShareConversation\(conv\)[\s\S]{0,160}if \(!regenTradePhotoContext\) \{[\s\S]{0,140}setDialogState\(conv, "inventory_init"\)/,
  /liveTradePhotoContext = isTradePhotoShareConversation\(conv\)[\s\S]{0,160}if \(!liveTradePhotoContext\) \{[\s\S]{0,140}setDialogState\(conv, "inventory_init"\)/
]) {
  assert.match(apiSource, guard, `a trade-in photo must not set the inventory dialog/agent context (${guard})`);
}

// --- VIN-plate photo handling (flag-gated: recognize + route, never assert). -------------------
// A customer photographs the VIN/data plate on their bike — a hot trade-in signal that today
// drops into the generic "document/unclear" neutral ack. Behind VIN_PHOTO_HANDLING_ENABLED we
// recognize the plate, route by thread context, capture the VIN, and seed a STAFF hint — while
// NEVER asserting the VIN, a decoded model, or a value to the customer.

// (e) Flag governance: default OFF; only "1" turns it on. Off => today's behavior.
const savedVinFlag = process.env.VIN_PHOTO_HANDLING_ENABLED;
delete process.env.VIN_PHOTO_HANDLING_ENABLED;
assert.equal(isVinPhotoHandlingEnabled(), false, "VIN photo handling defaults OFF (dark)");
process.env.VIN_PHOTO_HANDLING_ENABLED = "0";
assert.equal(isVinPhotoHandlingEnabled(), false, "explicit 0 stays OFF");
process.env.VIN_PHOTO_HANDLING_ENABLED = "1";
assert.equal(isVinPhotoHandlingEnabled(), true, "1 turns it ON");
if (savedVinFlag === undefined) delete process.env.VIN_PHOTO_HANDLING_ENABLED;
else process.env.VIN_PHOTO_HANDLING_ENABLED = savedVinFlag;

// Confidence gate: a full 17-char VIN above the floor is confident; a partial/blank/low read is not.
const CONFIDENT_VIN = { vin: "1HD1KB4197Y612345", vinConfidence: 0.9, vinDecodeHint: "2007 Street Glide" };
assert.equal(isConfidentVinRead(CONFIDENT_VIN), true, "a full VIN read above the floor is confident");
assert.equal(isConfidentVinRead({ vin: "", vinConfidence: 0.2 }), false, "a blurry/blank read is not confident");
assert.equal(
  isConfidentVinRead({ vin: "1HD1KB41", vinConfidence: 0.95 }),
  false,
  "a partial (non-17-char) VIN is never confident, even at high vision confidence"
);
assert.equal(isConfidentVinRead(null), false);

// (a) High-confidence VIN plate, TRADE context: warm recognize-ack -> appraiser; NO customer-facing
//     VIN/model/value; the STAFF todo carries the VIN + the unconfirmed decode hint.
const vinTradeReply = buildVinPlatePhotoShareReply({ firstName: "Jorge", tradeContext: true });
assert.match(vinTradeReply, /Thanks for sending that over, Jorge!/);
assert.match(vinTradeReply, /appraiser/i, "trade VIN reply routes to the appraiser");
assert.match(vinTradeReply, /VIN/, "the reply recognizes it as their VIN");
// General (non-trade) context recognize-ack.
const vinGeneralReply = buildVinPlatePhotoShareReply({ firstName: null, tradeContext: false });
assert.match(vinGeneralReply, /Thanks for sending that over!/);
assert.match(vinGeneralReply, /pull it up|follow up/i, "general VIN reply routes to a human handoff");
// (f) Governance + charter: the CUSTOMER reply NEVER reads the VIN digits back, names a decoded
//     model, quotes a value, or pivots to an inventory match — and passes the voice-charter guard.
for (const reply of [vinTradeReply, vinGeneralReply]) {
  const violations = checkMessage(reply, { firstOutbound: false, smsLike: true, staffHasSent: false });
  assert.deepEqual(violations, [], `VIN reply must be charter-clean: "${reply}" -> ${JSON.stringify(violations)}`);
  assert.ok(!/1HD1KB4197Y612345/i.test(reply), "reply must never read the VIN digits back to the customer");
  assert.ok(!/street glide|road glide|\bmodel\b/i.test(reply), "reply must never assert a decoded model");
  for (const banned of [/match it against/i, /in stock/i, /coming in/i, /what we'?ve got/i, /\$\d/]) {
    assert.ok(!banned.test(reply), `VIN reply must not pivot to inventory/price (${banned})`);
  }
}

// Staff todo (INTERNAL): high-confidence read carries the VIN string + "VIN suggests ... — verify".
const vinTodoConfident = buildVinPlatePhotoShareTodoSummary({
  firstName: "Jorge",
  tradeContext: true,
  read: CONFIDENT_VIN
});
assert.match(vinTodoConfident, /VIN read: 1HD1KB4197Y612345/, "staff todo captures the read VIN");
assert.match(vinTodoConfident, /VIN suggests a 2007 Street Glide — verify/, "decode is an unconfirmed staff hint");
assert.match(vinTodoConfident, /appraiser/i, "trade VIN todo routes to appraisal");
// (b) Low-confidence read: recognize ONLY — the todo names NO VIN digits and NO decode.
const vinTodoLow = buildVinPlatePhotoShareTodoSummary({
  firstName: "Jorge",
  tradeContext: true,
  read: { vin: "", vinConfidence: 0.2, vinDecodeHint: "" }
});
assert.match(vinTodoLow, /couldn't be read with confidence/i, "low-confidence todo says the plate wasn't read");
assert.ok(!/VIN read:/.test(vinTodoLow), "low-confidence todo must not assert any VIN digits");
assert.ok(!/suggests a/i.test(vinTodoLow), "low-confidence todo must not decode");
// A partial (non-17-char) read at high vision confidence is still treated as low: no digits/decode.
const vinTodoPartial = buildVinPlatePhotoShareTodoSummary({
  firstName: "Jorge",
  tradeContext: false,
  read: { vin: "1HD1KB41", vinConfidence: 0.95, vinDecodeHint: "2007 Street Glide" }
});
assert.ok(!/VIN read:/.test(vinTodoPartial), "a partial VIN is never read back onto the staff record");
assert.ok(!/suggests a/i.test(vinTodoPartial), "a partial VIN is never decoded");

// VIN capture on the conversation: high confidence persists the VIN + decode (read:true); a low /
// partial read persists the record but with BLANK digits/decode (read:false) — never an untrusted VIN.
const convHigh: any = {};
const capHigh = captureVinPlateOnConversation(convHigh, { read: CONFIDENT_VIN, tradeContext: true });
assert.equal(capHigh.vin, "1HD1KB4197Y612345", "high-confidence VIN captured on the conversation");
assert.equal(capHigh.decodeHint, "2007 Street Glide");
assert.equal(capHigh.read, true);
assert.equal(capHigh.context, "trade");
assert.equal(convHigh.vinPlateCapture.vin, "1HD1KB4197Y612345", "capture is written onto the conversation");
const convLow: any = {};
const capLow = captureVinPlateOnConversation(convLow, {
  read: { vin: "1HD1KB41", vinConfidence: 0.95, vinDecodeHint: "2007 Street Glide" },
  tradeContext: false
});
assert.equal(capLow.vin, "", "a partial/low-confidence VIN is NOT persisted as authoritative");
assert.equal(capLow.decodeHint, "", "no decode persisted on a low-confidence read");
assert.equal(capLow.read, false);
assert.equal(convLow.vinPlateCapture.read, false, "the capture record still exists, flagged unread");

// Source guards — buildPhotoShareReplyWithVision routing:
//  - the VIN branch is FLAG-GATED and checked BEFORE the generic non-motorcycle branch;
//  - it fires on an explicit description.isVinPlate === true and returns kind:"vin_plate".
assert.match(
  photoShareSource,
  /isVinPhotoHandlingEnabled\(\) && description && description\.isVinPlate === true[\s\S]{0,200}buildVinPlatePhotoShareResult/,
  "the non-trade VIN branch must be flag-gated and return the VIN result"
);
assert.ok(
  photoShareSource.indexOf("description.isVinPlate === true") <
    photoShareSource.indexOf("description.isMotorcyclePart === true"),
  "the VIN branch must be checked before the part/non-motorcycle branches"
);
// The trade branch also recognizes a VIN plate (flag-gated) rather than the "non-motorcycle item" hint.
assert.match(
  photoShareSource,
  /isVinPhotoHandlingEnabled\(\) && description && description\.isVinPlate === true[\s\S]{0,240}tradeContext: true/,
  "a VIN plate inside a trade thread must route to the VIN result (trade context)"
);
// Vision schema/prompt carries the VIN classification (parser-first, strict JSON).
assert.match(llmSource, /is_vin_plate/, "vision schema must include the is_vin_plate classification");
assert.match(llmSource, /"vin"/, "vision schema must include the read vin string");
assert.match(llmSource, /vin_confidence/, "vision schema must include a per-field VIN confidence");
// Caller parity: all three convergence points re-point the agent context for a VIN plate (both paths).
assert.ok(
  (apiSource.match(/photoShare\.kind === "vin_plate"[\s\S]{0,320}CUSTOMER_PHOTO_SHARE_VIN_AGENT_CONTEXT/g) ?? []).length >= 3,
  "all three photo-share convergence points must re-point the context for a VIN-plate photo"
);
// The VIN agent context must never invite an inventory match or a customer-facing decode/value.
assert.match(
  photoShareSource,
  /CUSTOMER_PHOTO_SHARE_VIN_AGENT_CONTEXT[\s\S]{0,400}Do NOT match it against bike inventory/,
  "the VIN agent context must steer the next turn off inventory framing"
);

console.log("PASS customer photo share eval");
