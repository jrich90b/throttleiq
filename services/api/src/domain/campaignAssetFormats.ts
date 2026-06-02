import type { CampaignAssetTarget } from "./campaignStore.js";

export type CampaignOpenAiImageSize =
  | "auto"
  | "1024x1024"
  | "1536x1024"
  | "1024x1536";

export type CampaignAssetFrameSpec = {
  target: CampaignAssetTarget;
  label: string;
  width: number;
  height: number;
  safeInsetX: number;
  safeInsetY: number;
};

function boundedNumber(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number(value);
  const candidate = Number.isFinite(n) ? n : fallback;
  return Math.max(min, Math.min(max, Math.round(candidate)));
}

function profileNumber(profile: unknown, campaignKey: string, legacyKey: string): number | null {
  const p = profile as any;
  const fromProfile = Number(p?.campaign?.[campaignKey]);
  if (Number.isFinite(fromProfile)) return fromProfile;
  const fromLegacy = Number(p?.[legacyKey]);
  if (Number.isFinite(fromLegacy)) return fromLegacy;
  return null;
}

function safeInset(width: number, height: number, xPct: number, yPct = xPct): { safeInsetX: number; safeInsetY: number } {
  return {
    safeInsetX: Math.max(24, Math.round(width * xPct)),
    safeInsetY: Math.max(24, Math.round(height * yPct))
  };
}

export function campaignAssetFrameSpec(
  target: CampaignAssetTarget,
  dealerProfile?: unknown
): CampaignAssetFrameSpec {
  if (target === "sms") {
    const width = boundedNumber(process.env.CAMPAIGN_MMS_IMAGE_WIDTH, 1080, 320, 2048);
    const height = boundedNumber(process.env.CAMPAIGN_MMS_IMAGE_HEIGHT, 1350, 320, 3072);
    return { target, label: "SMS/MMS image", width, height, ...safeInset(width, height, 0.1) };
  }

  if (target === "email") {
    const width = boundedNumber(process.env.CAMPAIGN_EMAIL_IMAGE_WIDTH, 1200, 480, 2400);
    return { target, label: "Email image", width, height: width, ...safeInset(width, width, 0.08) };
  }

  if (target === "facebook_post") {
    const width = boundedNumber(process.env.CAMPAIGN_FACEBOOK_POST_WIDTH, 1080, 640, 4096);
    const height = boundedNumber(process.env.CAMPAIGN_FACEBOOK_POST_HEIGHT, 1080, 640, 4096);
    return { target, label: "Facebook post", width, height, ...safeInset(width, height, 0.1) };
  }

  if (target === "instagram_post") {
    const width = boundedNumber(process.env.CAMPAIGN_INSTAGRAM_POST_WIDTH, 1080, 640, 4096);
    const height = boundedNumber(process.env.CAMPAIGN_INSTAGRAM_POST_HEIGHT, 1080, 640, 4096);
    return { target, label: "Instagram post", width, height, ...safeInset(width, height, 0.1) };
  }

  if (target === "instagram_story") {
    const width = boundedNumber(process.env.CAMPAIGN_INSTAGRAM_STORY_WIDTH, 1080, 640, 4096);
    const height = boundedNumber(process.env.CAMPAIGN_INSTAGRAM_STORY_HEIGHT, 1920, 960, 6144);
    return { target, label: "Instagram story", width, height, ...safeInset(width, height, 0.1, 0.14) };
  }

  if (target === "web_banner") {
    const profileWidth = profileNumber(dealerProfile, "webBannerWidth", "webBannerWidth");
    const profileHeight = profileNumber(dealerProfile, "webBannerHeight", "webBannerHeight");
    const width = boundedNumber(profileWidth ?? process.env.CAMPAIGN_WEB_BANNER_WIDTH, 1920, 640, 6000);
    const height = boundedNumber(profileHeight ?? process.env.CAMPAIGN_WEB_BANNER_HEIGHT, 600, 120, 3000);
    return { target, label: "Web banner", width, height, ...safeInset(width, height, 0.12, 0.18) };
  }

  const trimWidth = boundedNumber(process.env.CAMPAIGN_FLYER_8_5X11_WIDTH, 2550, 850, 6000);
  const trimHeight = boundedNumber(process.env.CAMPAIGN_FLYER_8_5X11_HEIGHT, 3300, 1100, 7000);
  const bleedInches = Math.max(0, Math.min(0.5, Number(process.env.CAMPAIGN_FLYER_BLEED_INCHES ?? 0.125)));
  const width = Math.round((8.5 + bleedInches * 2) * (trimWidth / 8.5));
  const height = Math.round((11 + bleedInches * 2) * (trimHeight / 11));
  return { target, label: "Flyer (8.5x11)", width, height, ...safeInset(width, height, 0.12) };
}

export function campaignOpenAiImageSizeForTarget(target: CampaignAssetTarget | null | undefined): CampaignOpenAiImageSize {
  if (target === "web_banner") return "1536x1024";
  if (target === "sms" || target === "instagram_story" || target === "flyer_8_5x11") return "1024x1536";
  if (target === "facebook_post" || target === "instagram_post" || target === "email") return "1024x1024";
  return "1024x1024";
}

export function campaignAssetFramePromptLines(
  target: CampaignAssetTarget,
  dealerProfile?: unknown
): string[] {
  const frame = campaignAssetFrameSpec(target, dealerProfile);
  const ratio = (frame.width / Math.max(1, frame.height)).toFixed(3);
  const liveLeft = frame.safeInsetX;
  const liveRight = frame.width - frame.safeInsetX;
  const liveTop = frame.safeInsetY;
  const liveBottom = frame.height - frame.safeInsetY;
  const storyUiLine =
    target === "instagram_story"
      ? "- Story UI safety: avoid the top and bottom app-control zones; keep headline, CTA, dealer name, faces, bikes, and logos inside the live content box."
      : null;
  const bannerLine =
    target === "web_banner"
      ? "- Banner edge rule: background/photo/texture may fill the full frame, but text, logos, buttons, bikes, and faces must stay inside the live content box."
      : "- Edge rule: background/artwork may fill the full frame, but readable text, logos, badges, bikes, faces, CTAs, and footer copy must stay inside the live content box.";

  return [
    "Output framing requirements (critical):",
    `- Compose exactly for ${frame.label} at ${frame.width}x${frame.height} (~${ratio}:1).`,
    "- Use the full canvas edge-to-edge with no border, no white strip, no gutter, no letterboxing, and no detached poster-on-background layout.",
    `- Live content box: x=${liveLeft}..${liveRight}, y=${liveTop}..${liveBottom}.`,
    bannerLine,
    storyUiLine,
    "- Leave visible padding/breathing room around the full design. Do not let headline letters, logos, badges, motorcycle tires, faces, CTA buttons, website text, or footer lines approach the canvas edge.",
    "- Do not place a website, tiny footer, disclaimer, sponsor line, logo, or decorative badge directly on any edge or in a corner unless it fits completely inside the live content box.",
    "- If space is tight, simplify copy, omit optional footer/website text, and reduce type size before moving key content toward an edge.",
    "- Good layout example: headline and subject are centered with clear top/side margin; event details and CTA sit above the bottom live boundary with visible breathing room.",
    "- Bad layout example: top headline touches the edge, side text is cropped, a logo sits half in a corner, or footer/URL text is pinned to the bottom edge."
  ].filter((line): line is string => Boolean(line));
}
