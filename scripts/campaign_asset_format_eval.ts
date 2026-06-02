import { strict as assert } from "node:assert";
import {
  campaignAssetFramePromptLines,
  campaignAssetFrameSpec,
  campaignOpenAiImageSizeForTarget,
  campaignTargetReferenceImageUrls,
  campaignUsesPrimaryStyleAnchor
} from "../services/api/src/domain/campaignAssetFormats.js";

function assertFrame(
  target: Parameters<typeof campaignAssetFrameSpec>[0],
  expected: { width: number; height: number }
) {
  const frame = campaignAssetFrameSpec(target);
  assert.equal(frame.width, expected.width, `${target} width`);
  assert.equal(frame.height, expected.height, `${target} height`);
  assert.ok(frame.safeInsetX > 0, `${target} safeInsetX`);
  assert.ok(frame.safeInsetY > 0, `${target} safeInsetY`);
  assert.ok(frame.safeInsetX < frame.width / 2, `${target} safeInsetX usable`);
  assert.ok(frame.safeInsetY < frame.height / 2, `${target} safeInsetY usable`);
}

assertFrame("sms", { width: 1080, height: 1350 });
assertFrame("facebook_post", { width: 1080, height: 1080 });
assertFrame("instagram_post", { width: 1080, height: 1080 });
assertFrame("instagram_story", { width: 1080, height: 1920 });

const defaultBanner = campaignAssetFrameSpec("web_banner");
assert.equal(defaultBanner.width, 1920);
assert.equal(defaultBanner.height, 600);

const dealerBanner = campaignAssetFrameSpec("web_banner", {
  campaign: { webBannerWidth: 2400, webBannerHeight: 1079 }
});
assert.equal(dealerBanner.width, 2400);
assert.equal(dealerBanner.height, 1079);

assert.equal(campaignOpenAiImageSizeForTarget("facebook_post"), "1024x1024");
assert.equal(campaignOpenAiImageSizeForTarget("instagram_post"), "1024x1024");
assert.equal(campaignOpenAiImageSizeForTarget("instagram_story"), "1024x1536");
assert.equal(campaignOpenAiImageSizeForTarget("flyer_8_5x11"), "1024x1536");
assert.equal(campaignOpenAiImageSizeForTarget("web_banner"), "1536x1024");

const instagramPrompt = campaignAssetFramePromptLines("instagram_post").join("\n");
assert.match(instagramPrompt, /1080x1080/);
assert.match(instagramPrompt, /Live content box/);
assert.match(instagramPrompt, /Good layout example/);
assert.match(instagramPrompt, /Bad layout example/);
assert.match(instagramPrompt, /footer\/URL text is pinned to the bottom edge/);

const storyPrompt = campaignAssetFramePromptLines("instagram_story").join("\n");
assert.match(storyPrompt, /1080x1920/);
assert.match(storyPrompt, /Story UI safety/);

const referenceOrder = campaignTargetReferenceImageUrls({
  inspirationContextImageUrls: ["/uploads/campaigns/reference-style.jpg"],
  styleLockRefUrl: "/uploads/campaigns/generated-anchor.jpg",
  designImageUrls: ["/uploads/campaigns/dealer-logo.png", "/uploads/campaigns/reference-style.jpg"]
});
assert.deepEqual(referenceOrder, [
  "/uploads/campaigns/reference-style.jpg",
  "/uploads/campaigns/generated-anchor.jpg",
  "/uploads/campaigns/dealer-logo.png"
]);
assert.equal(campaignUsesPrimaryStyleAnchor(referenceOrder), true);
assert.equal(campaignUsesPrimaryStyleAnchor([]), false);

console.log("Campaign asset format checks passed.");
