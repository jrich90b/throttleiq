/**
 * Customer vehicle photo share — parser-first handling for "here's a photo of
 * the bike I like" turns (and bare MMS images in sales contexts).
 *
 * Production case (AGENTS.md / voice charter): Mustafa +17164368801,
 * 2026-06-10 — customer fulfilled staff's "send me pictures of bikes you like"
 * ask and the turn was classified small_talk; drafts asked discovery questions
 * the photo already answered, and regenerate fell through to stale cadence
 * overrides about an unrelated sold unit.
 */

import fs from "node:fs";
import path from "node:path";

import { describeVehicleImageWithLLM } from "./llmDraft.js";
import { findInventoryMatches } from "./inventoryFeed.js";

const MEDIA_NOUN_RE = /\b(photo|photos|picture|pictures|pic|pics|image|images|screenshot|screenshots)\b/i;
const SHARE_VERB_RE = /\b(here(?:'s| is| are)|i (?:just )?sent|sending|attached|i'?m sharing|sent you)\b/i;
const PHOTO_REQUEST_RE = /\b(can you|could you|would you|please)\b[\s\S]{0,40}\b(send|text|share)\b|\bsend me\b/i;

export function detectCustomerVehiclePhotoShareText(args: {
  text: string;
  hasInboundMedia: boolean;
}): boolean {
  const text = String(args.text ?? "").trim();
  // Customer asking US for photos is the photo-request flow, not a share.
  if (PHOTO_REQUEST_RE.test(text)) return false;
  if (MEDIA_NOUN_RE.test(text) && SHARE_VERB_RE.test(text)) return true;
  // Bare or near-bare MMS: the image is the message.
  if (args.hasInboundMedia && text.length <= 80 && !/\?/.test(text)) return true;
  return false;
}

// Dialog states where a bare inbound image is usually paperwork or status
// documentation, not a bike the customer wants matched.
const NON_SALES_PHOTO_DIALOG_STATES = new Set([
  "purchase_delivery",
  "finance_docs",
  "credit_app",
  "service_request"
]);

export function isSalesPhotoShareContext(dialogState: string | null | undefined): boolean {
  const state = String(dialogState ?? "").trim().toLowerCase();
  if (!state) return true;
  return !NON_SALES_PHOTO_DIALOG_STATES.has(state);
}

/**
 * Post-sale photos are proud-owner moments, not inventory-match requests
 * (audit 2026-06-11: post-sale customers texting photos of the bike they
 * bought would have been offered an inventory match).
 */
export function isSalesPhotoShareConversation(conv: {
  closedReason?: string | null;
  sale?: { soldAt?: string | null } | null;
  followUpCadence?: { kind?: string | null } | null;
  dialogState?: { name?: string | null } | null;
}): boolean {
  if (conv?.closedReason === "sold") return false;
  if (conv?.sale?.soldAt) return false;
  if (String(conv?.followUpCadence?.kind ?? "") === "post_sale") return false;
  return isSalesPhotoShareContext(conv?.dialogState?.name ?? null);
}

export function buildCustomerVehiclePhotoShareReply(args: {
  firstName?: string | null;
  mentionedModel?: string | null;
}): string {
  const name = String(args.firstName ?? "").trim();
  const model = String(args.mentionedModel ?? "").trim();
  const opener = name ? `Thanks for sending that over, ${name}!` : "Thanks for sending that over!";
  if (model) {
    return `${opener} That ${model} is a great look. Let me check what we've got in stock and coming in that matches it, and I'll text you what I find today.`;
  }
  return `${opener} Let me match it against what we've got in stock and coming in, and I'll text you what I find today.`;
}

/**
 * Map a stored upload URL (https://.../uploads/mms/MM.../0.jpg) to its local
 * file under DATA_DIR/uploads. Returns null for non-upload or remote URLs.
 */
export function resolveUploadLocalPath(url: string, dataDir: string): string | null {
  const raw = String(url ?? "").trim();
  if (!raw) return null;
  const match = raw.match(/\/uploads\/(.+)$/);
  if (!match) return null;
  const rel = match[1].replace(/\.\./g, "");
  return path.join(dataDir, "uploads", rel);
}

/**
 * Find the inbound image URLs nearest the selected turn — the photo usually
 * arrives as a separate bare MMS within seconds of the "here's a photo" text.
 */
export function findNearestInboundImageUrls(
  conv: { messages?: Array<{ direction?: string; at?: string; mediaUrls?: string[] }> },
  aroundAtIso?: string | null
): string[] {
  const messages = Array.isArray(conv?.messages) ? conv.messages : [];
  const anchorMs = Date.parse(String(aroundAtIso ?? "")) || Number.NaN;
  let best: { urls: string[]; distanceMs: number } | null = null;
  for (const m of messages) {
    if (m?.direction !== "in") continue;
    const urls = Array.isArray(m?.mediaUrls) ? m.mediaUrls.filter(Boolean) : [];
    if (!urls.length) continue;
    const atMs = Date.parse(String(m?.at ?? ""));
    if (!Number.isFinite(atMs)) continue;
    const distanceMs = Number.isFinite(anchorMs) ? Math.abs(atMs - anchorMs) : 0;
    if (!best || distanceMs <= best.distanceMs) best = { urls, distanceMs };
  }
  if (!best) return [];
  // Only trust media within 30 minutes of the anchor turn (or latest when no anchor).
  if (Number.isFinite(anchorMs) && best.distanceMs > 30 * 60 * 1000) return [];
  return best.urls;
}

const VISION_CONFIDENCE_MIN = Number(process.env.VEHICLE_IMAGE_VISION_CONFIDENCE_MIN ?? 0.7);

export type PhotoShareInventoryMatch = {
  year?: string | null;
  model?: string | null;
  color?: string | null;
  price?: number | null;
  condition?: string | null;
};

export function buildIdentifiedPhotoShareReply(args: {
  firstName?: string | null;
  modelFamily: string;
  matches: PhotoShareInventoryMatch[];
}): string {
  const name = String(args.firstName ?? "").trim();
  const opener = name ? `Thanks for sending that over, ${name}!` : "Thanks for sending that over!";
  const family = args.modelFamily.trim();
  const units = (args.matches ?? []).slice(0, 2);
  if (!units.length) {
    return `${opener} That looks like ${withArticle(family)}. We don't have one on the floor right this second, but I'll keep an eye out and text you the moment one lands. Want me to send a couple close options in the meantime?`;
  }
  const unitText = units
    .map(u => {
      const bits = [String(u.year ?? "").trim(), String(u.color ?? "").trim()].filter(Boolean).join(" ");
      const priceNum = Number(u.price);
      const price = Number.isFinite(priceNum) && priceNum > 0 ? ` at $${Math.round(priceNum).toLocaleString("en-US")}` : "";
      return `${bits ? `a ${bits} ` : "one "}${u.model ?? family}${price}`.replace(/\s+/g, " ").trim();
    })
    .join(" and ");
  return `${opener} That looks like ${withArticle(family)}. We've actually got ${unitText} here right now. Want me to send photos and details?`;
}

function withArticle(family: string): string {
  return /^[aeiou]/i.test(family) ? `an ${family}` : `a ${family}`;
}

/**
 * Vision sometimes returns compound families ("Electra Glide / Ultra Limited
 * (Touring)"). Split into match candidates so feed matching can try each.
 */
export function visionFamilyCandidates(family: string): string[] {
  return String(family ?? "")
    .split(/[\/,]|\bor\b/i)
    .map(s => s.replace(/\(.*?\)/g, "").trim())
    .filter(s => s.length >= 3);
}

export function shouldUseVisionIdentification(description: {
  isMotorcycle: boolean;
  modelFamily: string;
  confidence: number;
} | null): boolean {
  if (!description) return false;
  if (!description.isMotorcycle) return false;
  if (!description.modelFamily.trim()) return false;
  return description.confidence >= VISION_CONFIDENCE_MIN;
}

export const CUSTOMER_PHOTO_SHARE_AGENT_CONTEXT =
  "Customer texted a photo of a bike they like (image attached in the thread). Identify the bike and match it against current and incoming inventory before any other follow-up. Do not restart style/budget discovery questions.";

const MAX_VISION_IMAGE_BYTES = 6 * 1024 * 1024;

/**
 * Reply when vision recognized the shared image is NOT a motorcycle (a fish, a pet, a meme,
 * a screenshot). Never claim to "match it against inventory" — that's the embarrassing miss
 * (a customer's fish photo answered with "let me match it against what we've got in stock").
 * A light, fail-safe clarification: acknowledge, and invite the bike photo. Pinned by
 * customer_photo_share:eval.
 */
export function buildNonMotorcyclePhotoShareReply(firstName?: string | null): string {
  const name = String(firstName ?? "").trim();
  const greeting = name ? `Thanks ${name}! ` : "Thanks! ";
  return `${greeting}I'm not seeing a motorcycle in that one — did you mean to send a photo of a bike you're interested in? Send it over and I'll match it up.`;
}

/**
 * Full photo-share reply: resolve the customer's image, identify the model
 * family with vision (confidence-gated), match against the live inventory
 * feed, and answer with real units. Falls back to the match-commit reply on
 * any miss — never guesses a model to a rider. When vision recognizes the
 * image is NOT a motorcycle, diverts to a clarification (never the match reply).
 */
export async function buildPhotoShareReplyWithVision(args: {
  conv: { messages?: any[]; lead?: any };
  firstName?: string | null;
  mentionedModel?: string | null;
  anchorAtIso?: string | null;
  dataDir: string;
  contextText?: string;
}): Promise<{ reply: string; identifiedFamily: string | null; todoSummary: string }> {
  const fallback = {
    reply: buildCustomerVehiclePhotoShareReply({
      firstName: args.firstName,
      mentionedModel: args.mentionedModel
    }),
    identifiedFamily: null as string | null,
    todoSummary: buildCustomerPhotoShareTodoSummary(args.firstName)
  };
  try {
    const urls = findNearestInboundImageUrls(args.conv as any, args.anchorAtIso ?? null);
    const localPath = urls.map(u => resolveUploadLocalPath(u, args.dataDir)).find(p => p && fs.existsSync(p));
    if (!localPath) return fallback;
    const stat = fs.statSync(localPath);
    if (!stat.isFile() || stat.size === 0 || stat.size > MAX_VISION_IMAGE_BYTES) return fallback;
    const mime = /\.png$/i.test(localPath) ? "image/png" : "image/jpeg";
    const imageBase64 = fs.readFileSync(localPath).toString("base64");
    const description = await describeVehicleImageWithLLM({
      imageBase64,
      mimeType: mime,
      contextText: args.contextText
    });
    // Vision SUCCESSFULLY recognized the image is not a motorcycle (a fish, a pet, a meme,
    // a screenshot) — divert to a clarification instead of the "match it against stock"
    // reply. Fail-safe: only fires on an explicit is_motorcycle=false; a vision error/null
    // (the catch / a missing description) still falls through to the existing bike-match fallback.
    if (description && description.isMotorcycle === false) {
      const who = String(args.firstName ?? "").trim() || "Customer";
      return {
        reply: buildNonMotorcyclePhotoShareReply(args.firstName),
        identifiedFamily: null,
        todoSummary: `${who} sent a photo that doesn't look like a motorcycle — take a look in the thread and clarify what they're after.`
      };
    }
    if (!shouldUseVisionIdentification(description)) return fallback;
    const candidates = visionFamilyCandidates(description!.modelFamily);
    if (!candidates.length) return fallback;
    let family = candidates[0];
    let matches: PhotoShareInventoryMatch[] = [];
    for (const candidate of candidates) {
      try {
        const items = await findInventoryMatches({ year: null, model: candidate });
        if (items?.length) {
          family = candidate;
          matches = items.slice(0, 2).map((i: any) => ({
            year: i?.year ?? null,
            model: i?.model ?? null,
            color: i?.color ?? null,
            price: i?.price ?? null,
            condition: i?.condition ?? null
          }));
          break;
        }
      } catch {
        // try the next candidate
      }
    }
    const who = String(args.firstName ?? "").trim() || "Customer";
    return {
      reply: buildIdentifiedPhotoShareReply({ firstName: args.firstName, modelFamily: family, matches }),
      identifiedFamily: family,
      todoSummary: `${who} texted a photo of a bike they like. Vision says it looks like ${family} (${Math.round(
        (description!.confidence ?? 0) * 100
      )}%). Confirm from the image in the thread and follow up with matching units.`
    };
  } catch {
    return fallback;
  }
}

export function buildCustomerPhotoShareTodoSummary(name?: string | null): string {
  const who = String(name ?? "").trim() || "Customer";
  return `${who} texted a photo of a bike they like. Open the image in the thread, identify the bike, and reply with matching in-stock or incoming units.`;
}
