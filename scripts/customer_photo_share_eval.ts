/**
 * Customer photo share eval — parser-first handling for "here's a photo of the
 * bike I like" turns. Fixture: Mustafa +17164368801, 2026-06-10.
 */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";

import {
  buildCustomerPhotoShareTodoSummary,
  buildCustomerVehiclePhotoShareReply,
  detectCustomerVehiclePhotoShareText,
  isSalesPhotoShareContext
} from "../services/api/src/domain/customerPhotoShare.ts";
import { checkMessage } from "./voice_charter_audit.ts";

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

// The shared inventory-status availability route (live + regen) must hand
// unit-less image_availability_check turns to photo-share handling instead of
// the generic "I'll have the team check current options" punt.
assert.match(
  apiSource,
  /intent === "image_availability_check"\) \{[\s\S]{0,1600}buildCustomerVehiclePhotoShareReply/,
  "image_availability_check with no identifiable unit must route to photo-share handling"
);

const llmSource = await fs.readFile(path.resolve("services/api/src/domain/llmDraft.ts"), "utf8");
assert.match(llmSource, /"customer_shared_vehicle_photo"/, "parser union/schema must include the action");
assert.match(
  llmSource,
  /Here is a photo of the HD I like\./,
  "parser few-shots must include the Mustafa production fixture"
);

console.log("PASS customer photo share eval");
