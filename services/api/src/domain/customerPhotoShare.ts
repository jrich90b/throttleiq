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

export const CUSTOMER_PHOTO_SHARE_AGENT_CONTEXT =
  "Customer texted a photo of a bike they like (image attached in the thread). Identify the bike and match it against current and incoming inventory before any other follow-up. Do not restart style/budget discovery questions.";

export function buildCustomerPhotoShareTodoSummary(name?: string | null): string {
  const who = String(name ?? "").trim() || "Customer";
  return `${who} texted a photo of a bike they like. Open the image in the thread, identify the bike, and reply with matching in-stock or incoming units.`;
}
