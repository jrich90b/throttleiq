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

const TRADE_INTENT_CTAS = new Set(["value_my_trade", "sell_my_bike", "trade_in_value", "trade_in_sell"]);
const TRADE_DIALOG_STATES = new Set(["trade_init", "trade_cash", "trade_trade", "trade_either"]);

/**
 * Is this a TRADE-in conversation — the customer is showing us THEIR unit to value, not a bike
 * they like that we'd match against our inventory? A photo here is the trade unit, so the buy-intent
 * "let me match it against what we've got in stock" reply (and its "reply with matching in-stock
 * units" todo) is the wrong frame (Jessica Ornce +17167134728, 2026-06-23: a Trade-Accelerator lead
 * sent photos of her Victory Vegas + camper trailer and drew the inventory-match draft + todo).
 *
 * Reads ALREADY-classified structured state (bucket / CTA / handoff reason / dialog / lead source) —
 * the comprehension that set these ran earlier via the intent parsers, so this is a deterministic
 * route read, not a re-comprehension of the customer's text.
 */
export function isTradePhotoShareConversation(conv: {
  classification?: { bucket?: string | null; cta?: string | null } | null;
  followUp?: { reason?: string | null } | null;
  dialogState?: { name?: string | null } | null;
  lead?: { source?: string | null } | null;
}): boolean {
  const bucket = String(conv?.classification?.bucket ?? "").trim().toLowerCase();
  if (bucket === "trade_in_sell") return true;
  const cta = String(conv?.classification?.cta ?? "").trim().toLowerCase();
  if (TRADE_INTENT_CTAS.has(cta)) return true;
  const followReason = String(conv?.followUp?.reason ?? "").trim().toLowerCase();
  if (followReason === "non_motorcycle_trade" || followReason.includes("trade")) return true;
  const dialog = String(conv?.dialogState?.name ?? "").trim().toLowerCase();
  if (TRADE_DIALOG_STATES.has(dialog)) return true;
  // Trade-IN intent specifically — not a "Trade Show" booth lead. Jessica's source is
  // "Trade Accelerator - Trade In".
  const source = String(conv?.lead?.source ?? "").trim().toLowerCase();
  if (/\btrade[\s-]?in\b|trade accelerator/.test(source)) return true;
  return false;
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
 * Trade-in photo reply. The customer is showing us a unit they want to trade — acknowledge and
 * route to the appraiser. NEVER claim to "match it against our stock" (that's the buy-intent miss)
 * and NEVER quote a trade number (we value in person; AGENTS.md). Unit-agnostic on purpose: vision
 * is Harley-biased, so naming the make (a Victory, an Indian) risks fabrication — the appraiser
 * confirms from the photos in the thread.
 */
export function buildTradePhotoShareReply(firstName?: string | null): string {
  const name = String(firstName ?? "").trim();
  const opener = name ? `Thanks for sending those over, ${name}!` : "Thanks for sending those over!";
  return `${opener} I'll get these in front of our appraiser and follow up with numbers.`;
}

/**
 * Appraisal-handoff todo for a trade-in photo. Seeds the human with a best-effort vision hint
 * (observational only — color/features or "non-motorcycle item" — never an asserted make/model).
 */
export function buildTradePhotoShareTodoSummary(args: {
  firstName?: string | null;
  visionHint?: string | null;
}): string {
  const who = String(args.firstName ?? "").trim() || "Customer";
  const hint = String(args.visionHint ?? "").trim();
  const core = `${who} sent photo(s) of their trade-in. Open the thread, confirm the unit(s), and get them to the appraiser for a firm number.`;
  return hint ? `${core} Vision (unconfirmed): ${hint}.` : core;
}

// Observational, brand-free hint for the appraiser. Vision's make/model_family is Harley-biased
// and unreliable on a trade (could be a Victory/Indian), so we surface only color + features, or
// flag a non-motorcycle item (which the non_motorcycle_trade handoff already routes separately).
function tradeUnitVisionHint(d: {
  isMotorcycle: boolean;
  color?: string | null;
  distinctiveFeatures?: string | null;
}): string {
  if (!d.isMotorcycle) return "the photo looks like a non-motorcycle item (e.g. a trailer or vehicle)";
  const color = String(d.color ?? "").trim();
  const features = String(d.distinctiveFeatures ?? "").trim();
  const base = [color, "motorcycle"].filter(Boolean).join(" ");
  return features ? `a ${base} (${features})` : `a ${base}`;
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

// --- VIN-plate photo handling (flag-gated, DARK by default). ---------------
// A customer photographs the VIN / data plate on their bike — almost always a HOT trade-in
// signal (or confirming a unit). Today vision returns is_motorcycle=false and the image drops
// into the generic "document/unclear" neutral ack. Behind this flag we RECOGNIZE the plate,
// route by thread context (trade → appraiser; else → general handoff), capture the read VIN on
// the conversation, and seed a STAFF task with an UNCONFIRMED decode hint. Governance (hard):
// NEVER assert the VIN, a decoded model, or any value to the customer — fail toward "got it,
// passing it to the team." Flag OFF → the VIN branch is skipped and a VIN plate falls through
// to today's exact non-motorcycle document behavior.
export function isVinPhotoHandlingEnabled(): boolean {
  return String(process.env.VIN_PHOTO_HANDLING_ENABLED ?? "0").trim() === "1";
}

// Confidence floor for reading the VIN digits back onto the staff record + decoding. Below it we
// still recognize the plate + drop a staff todo, but capture NO digits and NO decode (fail-safe).
const VIN_PLATE_CONFIDENCE_MIN = Number(process.env.VIN_PLATE_VISION_CONFIDENCE_MIN ?? 0.7);

// A VIN string is only trustworthy at 17 chars (full VIN). Anything shorter is a partial read →
// treat as low-confidence (recognize only), never captured as authoritative.
function isCompleteVin(vin: string): boolean {
  return /^[A-HJ-NPR-Z0-9]{17}$/i.test(String(vin ?? "").trim());
}

export type VinPlateVisionRead = {
  vin?: string | null;
  vinConfidence?: number | null;
  vinDecodeHint?: string | null;
};

// A VIN read is "confident" only when the plate read cleared the confidence floor AND the VIN is
// a full 17 chars. Drives whether we read digits back onto the staff record / attach a decode.
export function isConfidentVinRead(read: VinPlateVisionRead | null | undefined): boolean {
  if (!read) return false;
  const vin = String(read.vin ?? "").trim();
  const conf = Number(read.vinConfidence ?? 0);
  return isCompleteVin(vin) && conf >= VIN_PLATE_CONFIDENCE_MIN;
}

// Overrides the bike-match agent context after a VIN-plate photo: the next turn is a staff
// handoff (appraiser / pull-up-the-unit), NOT an inventory match — never re-pitch stock.
export const CUSTOMER_PHOTO_SHARE_VIN_AGENT_CONTEXT =
  "Customer texted a photo of their VIN/data plate (a trade-in or unit-lookup signal, not a bike to match against inventory). A human has the VIN + any decode hint on a staff task. Do NOT match it against bike inventory, do NOT read the VIN or a decoded model back to the customer, and do NOT quote any trade value. Keep it warm and let the team follow up.";

/**
 * Recognize-ack reply for a VIN/data-plate photo. Warm, gets it to a human fast, and NEVER reads
 * the VIN digits back or names a decoded model/value (governance: trades valued in person; never
 * assert a decode). Trade context routes to the appraiser; everything else to a general handoff.
 */
export function buildVinPlatePhotoShareReply(args: {
  firstName?: string | null;
  tradeContext: boolean;
}): string {
  const name = String(args.firstName ?? "").trim();
  const opener = name ? `Thanks for sending that over, ${name}!` : "Thanks for sending that over!";
  if (args.tradeContext) {
    return `${opener} I'll get your VIN over to our appraiser and follow up with numbers.`;
  }
  return `${opener} Let me get your VIN to the team to pull it up, and someone will follow up shortly.`;
}

/**
 * STAFF task summary for a VIN-plate photo. Staff-facing (internal), so the read VIN digits + an
 * UNCONFIRMED decode hint may appear here — mirrors the tradeUnitVisionHint "Vision (unconfirmed)"
 * pattern. On a low-confidence / partial read we capture NO digits and NO decode: recognize only.
 */
export function buildVinPlatePhotoShareTodoSummary(args: {
  firstName?: string | null;
  tradeContext: boolean;
  read: VinPlateVisionRead | null;
}): string {
  const who = String(args.firstName ?? "").trim() || "Customer";
  const tail = args.tradeContext
    ? "Open the thread, confirm the unit, and get them to the appraiser for a firm number."
    : "Open the thread, pull up the unit, and follow up.";
  if (!isConfidentVinRead(args.read)) {
    return `${who} sent a photo of their VIN/data plate${
      args.tradeContext ? " (trade-in)" : ""
    }, but it couldn't be read with confidence. Read the plate directly in the thread, then follow up.`;
  }
  const vin = String(args.read?.vin ?? "").trim().toUpperCase();
  const decode = String(args.read?.vinDecodeHint ?? "").trim();
  const decodeLine = decode ? ` VIN suggests a ${decode} — verify.` : "";
  return `${who} sent a photo of their VIN/data plate${
    args.tradeContext ? " (trade-in)" : ""
  }. VIN read: ${vin}.${decodeLine} ${tail}`;
}

// Durable record of a VIN captured from a customer's data-plate photo. On a low-confidence /
// partial read the digits + decode are deliberately BLANK (read:false) — we never persist an
// untrusted VIN the staff might act on (fail toward "got it, passing it to the team").
export type VinPlateCapture = {
  vin: string;
  confidence: number;
  decodeHint: string;
  context: "trade" | "general";
  capturedAt: string;
  read: boolean;
};

export function captureVinPlateOnConversation(
  conv: { vinPlateCapture?: VinPlateCapture } | null | undefined,
  args: { read: VinPlateVisionRead | null; tradeContext: boolean }
): VinPlateCapture {
  const confident = isConfidentVinRead(args.read);
  const capture: VinPlateCapture = {
    vin: confident ? String(args.read?.vin ?? "").trim().toUpperCase() : "",
    confidence: Number(args.read?.vinConfidence ?? 0),
    decodeHint: confident ? String(args.read?.vinDecodeHint ?? "").trim() : "",
    context: args.tradeContext ? "trade" : "general",
    capturedAt: new Date().toISOString(),
    read: confident
  };
  if (conv && typeof conv === "object") conv.vinPlateCapture = capture;
  return capture;
}

/**
 * Shared VIN-plate result: recognize-ack reply + context-routed staff todo + VIN captured on the
 * conversation. Called from BOTH the trade branch and the general (non-trade) branch of
 * buildPhotoShareReplyWithVision, so trade→appraiser and everything-else→general handoff share
 * one implementation (no divergence). Never customer-facing digits/decode/value.
 */
function buildVinPlatePhotoShareResult(args: {
  conv: { vinPlateCapture?: VinPlateCapture } | null | undefined;
  firstName?: string | null;
  read: VinPlateVisionRead | null;
  tradeContext: boolean;
}): { reply: string; identifiedFamily: string | null; todoSummary: string; kind: "vin_plate" } {
  captureVinPlateOnConversation(args.conv, { read: args.read, tradeContext: args.tradeContext });
  return {
    reply: buildVinPlatePhotoShareReply({ firstName: args.firstName, tradeContext: args.tradeContext }),
    identifiedFamily: null,
    todoSummary: buildVinPlatePhotoShareTodoSummary({
      firstName: args.firstName,
      tradeContext: args.tradeContext,
      read: args.read
    }),
    kind: "vin_plate"
  };
}

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

// Overrides the bike-match context above when the photo is a PART/accessory, so the next
// turn routes to parts/service instead of matching it against bike inventory.
export const CUSTOMER_PHOTO_SHARE_PART_AGENT_CONTEXT =
  "Customer texted a photo of a motorcycle PART or accessory (not a whole bike). Route to parts/service — do NOT match it against bike inventory. Clarify whether they want to buy the part or have it installed.";

/**
 * Reply when vision recognized the shared image is a motorcycle PART/accessory (exhaust, seat,
 * wheel, a part in a box, a part-number label, a broken component) — NOT a whole bike to match
 * against inventory and NOT chatter. Recognize the part, let the customer disambiguate
 * buy-vs-install, and hand off to the right person. Pinned by customer_photo_share:eval.
 */
export function buildMotorcyclePartPhotoShareReply(firstName?: string | null): string {
  const name = String(firstName ?? "").trim();
  const greeting = name ? `Thanks ${name}! ` : "Thanks! ";
  return `${greeting}Looks like a part there — are you looking to grab one, or get it put on? Either way I'll get the right person on it.`;
}

const MAX_VISION_IMAGE_BYTES = 6 * 1024 * 1024;

// A vision-composed social one-liner is customer-facing, so it passes a deterministic guard:
// brief, no question, and NO sales/inventory/bike-pivot language (in case vision ignores the
// prompt). Anything that fails the guard is dropped to the neutral acknowledgement.
export function sanitizeSocialPhotoReply(text?: string | null): string {
  const t = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!t || t.length > 90) return "";
  if (/\?/.test(t)) return ""; // a social ack reciprocates; it does not interrogate
  if (
    /\b(bike|motorcycle|model|stock|inventory|match|price|pricing|payment|finance|test ride|stop in|schedule|appointment|deal|coming in|in stock)\b/i.test(
      t
    )
  ) {
    return "";
  }
  return t;
}

/**
 * Reply when vision recognized the shared image is NOT a motorcycle. Never claim to "match it
 * against inventory" — that's the embarrassing miss (a customer's fish photo answered with "let
 * me match it against what we've got in stock"). Two cases:
 *  - friendly chatter (a fish someone caught, a pet, scenery): vision composed a warm one-liner
 *    ("Haha, nice catch!") — reciprocate like a real salesperson would (guarded; see sanitizer).
 *  - a document / screenshot / unclear image (no safe social line): a neutral acknowledgement,
 *    NOT a gushing one and NOT a sales pivot.
 * Pinned by customer_photo_share:eval.
 */
export function buildNonMotorcyclePhotoShareReply(
  firstName?: string | null,
  visionSocialReply?: string | null
): string {
  const social = sanitizeSocialPhotoReply(visionSocialReply);
  if (social) return social;
  const name = String(firstName ?? "").trim();
  return name ? `Thanks for sending that over, ${name}!` : "Thanks for sending that over!";
}

/**
 * Full photo-share reply: resolve the customer's image, identify the model
 * family with vision (confidence-gated), match against the live inventory
 * feed, and answer with real units. Falls back to the match-commit reply on
 * any miss — never guesses a model to a rider. When vision recognizes the
 * image is NOT a motorcycle, diverts to a clarification (never the match reply).
 */
async function buildTradePhotoShareResult(args: {
  conv: { messages?: any[]; lead?: any };
  firstName?: string | null;
  anchorAtIso?: string | null;
  dataDir: string;
}): Promise<{ reply: string; identifiedFamily: string | null; todoSummary: string; kind?: "vin_plate" }> {
  let visionHint = "";
  try {
    const urls = findNearestInboundImageUrls(args.conv as any, args.anchorAtIso ?? null);
    const localPath = urls.map(u => resolveUploadLocalPath(u, args.dataDir)).find(p => p && fs.existsSync(p));
    if (localPath) {
      const stat = fs.statSync(localPath);
      if (stat.isFile() && stat.size > 0 && stat.size <= MAX_VISION_IMAGE_BYTES) {
        const mime = /\.png$/i.test(localPath) ? "image/png" : "image/jpeg";
        const imageBase64 = fs.readFileSync(localPath).toString("base64");
        const description = await describeVehicleImageWithLLM({
          imageBase64,
          mimeType: mime,
          contextText: "Customer is showing a unit they want to trade in."
        });
        // VIN/data-plate photo inside a trade thread: recognize the plate + route to the
        // appraiser with the captured VIN, instead of a "non-motorcycle item" hint that would
        // read as a trailer/car. Flag-gated; off → the plate keeps the plain trade-hint path.
        if (isVinPhotoHandlingEnabled() && description && description.isVinPlate === true) {
          return buildVinPlatePhotoShareResult({
            conv: args.conv as any,
            firstName: args.firstName,
            read: description,
            tradeContext: true
          });
        }
        if (description) visionHint = tradeUnitVisionHint(description);
      }
    }
  } catch {
    // best-effort — the trade frame + appraisal todo stand without a vision hint
  }
  return {
    reply: buildTradePhotoShareReply(args.firstName),
    identifiedFamily: null,
    todoSummary: buildTradePhotoShareTodoSummary({ firstName: args.firstName, visionHint })
  };
}

export async function buildPhotoShareReplyWithVision(args: {
  conv: { messages?: any[]; lead?: any };
  firstName?: string | null;
  mentionedModel?: string | null;
  anchorAtIso?: string | null;
  dataDir: string;
  contextText?: string;
}): Promise<{
  reply: string;
  identifiedFamily: string | null;
  todoSummary: string;
  kind?: "bike_match" | "part" | "non_motorcycle" | "vin_plate";
}> {
  // Trade-in photo: the customer is showing us their unit to appraise, not a bike they like to
  // match against our stock. Divert to the trade frame + appraisal handoff (covers all photo-share
  // convergence points + both live and regenerate paths, which all funnel through this function).
  // Wins over the part branch below: a part photo from a trade lead still goes to the appraiser
  // (fail-safe — a human sees it).
  if (isTradePhotoShareConversation(args.conv as any)) {
    return buildTradePhotoShareResult(args);
  }
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
    // VIN / data-plate photo (flag-gated) — recognize the plate + route to a staff handoff with
    // the captured VIN, instead of the generic "document/unclear" neutral ack that drops a hot
    // trade-in signal. Checked FIRST: a VIN plate is is_motorcycle=false AND is_motorcycle_part=
    // false, so without this it would fall into the non-motorcycle document branch below. Flag
    // OFF → skipped entirely → today's exact document-ack behavior.
    if (isVinPhotoHandlingEnabled() && description && description.isVinPlate === true) {
      return buildVinPlatePhotoShareResult({
        conv: args.conv as any,
        firstName: args.firstName,
        read: description,
        tradeContext: false
      });
    }
    // Vision SUCCESSFULLY recognized the image is not a motorcycle (a fish, a pet, a meme,
    // a screenshot) — divert to a clarification instead of the "match it against stock"
    // reply. Fail-safe: only fires on an explicit is_motorcycle=false; a vision error/null
    // (the catch / a missing description) still falls through to the existing bike-match fallback.
    // A motorcycle PART/accessory — route to parts/service, never bike inventory or chatter.
    // Checked before the generic non-motorcycle branch (a part is is_motorcycle=false too).
    if (description && description.isMotorcyclePart === true) {
      const who = String(args.firstName ?? "").trim() || "Customer";
      return {
        reply: buildMotorcyclePartPhotoShareReply(args.firstName),
        identifiedFamily: null,
        todoSummary: `${who} sent a photo of a motorcycle PART/accessory — route to parts/service (buy vs install). Do NOT match it against bike inventory.`,
        kind: "part"
      };
    }
    if (description && description.isMotorcycle === false) {
      const who = String(args.firstName ?? "").trim() || "Customer";
      const isChatter = !!sanitizeSocialPhotoReply(description.socialReply);
      return {
        reply: buildNonMotorcyclePhotoShareReply(args.firstName, description.socialReply),
        identifiedFamily: null,
        todoSummary: isChatter
          ? `${who} shared a friendly non-motorcycle photo (chatter) — the agent acknowledged it socially. No bike action needed.`
          : `${who} sent a non-motorcycle photo (document/unclear) — take a look in the thread and follow up if needed.`,
        kind: "non_motorcycle"
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
