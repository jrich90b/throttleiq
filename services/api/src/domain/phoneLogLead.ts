import type { Conversation } from "./conversationStore.js";

export const PHONE_LOG_SOURCE_TYPE = "phone_log";

const TRAFFIC_LOG_PRO_RE = /traffic\s*log\s*pro/i;
const PHONE_LOG_TEXT_RE =
  /\b(?:called|customer\s+called|phone\s+call|call\s+log|spoke\s+(?:to|with)|talked\s+(?:to|with)|left\s+(?:a\s+)?voicemail|voicemail)\b/i;

function compactText(value?: string | null): string {
  return String(value ?? "")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function isTrafficLogProSource(value?: string | null): boolean {
  return TRAFFIC_LOG_PRO_RE.test(String(value ?? ""));
}

export function hasPhoneLogText(value?: string | null): boolean {
  return PHONE_LOG_TEXT_RE.test(compactText(value));
}

export function isTrafficLogProPhoneLog(args: {
  leadSource?: string | null;
  sourceFromId?: string | null;
  inquiry?: string | null;
  comment?: string | null;
  body?: string | null;
}): boolean {
  if (!isTrafficLogProSource(args.leadSource) && !isTrafficLogProSource(args.sourceFromId)) {
    return false;
  }
  return hasPhoneLogText([args.comment, args.inquiry, args.body].map(compactText).filter(Boolean).join(" "));
}

export function shouldSuppressPhoneLogEmail(args: {
  isPhoneLog: boolean;
}): boolean {
  return args.isPhoneLog;
}

/**
 * A Traffic Log Pro phone-log re-notification sets a GENERIC
 * `traffic_log_pro_phone_log` manual-handoff reason. When one lands on a
 * conversation that is ALREADY in a manual handoff for a MORE-SPECIFIC finance /
 * credit reason (e.g. a finance outcome recorded `credit_app_needs_info`), it
 * must NOT downgrade that reason — a duplicate/late phone-log re-sync would
 * otherwise erase the finance-handoff context (Kody Erhard +17163975098, 7/10: a
 * 21:25 duplicate PHONE LOG (ADF) clobbered the 15:53 `credit_app_needs_info`
 * handoff, tripping the outcome-QA `finance_needs_info_missing_manual_handoff`
 * gate finding). Both are manual_handoff (staff-owned) either way, so preserving
 * the specific reason never makes the conversation less safe — it only keeps the
 * finance context staff routes on. The phone-log todo is still added regardless,
 * so staff still see the callback.
 */
const PRESERVE_HANDOFF_REASONS = new Set([
  "credit_app_needs_info",
  "credit_app_needs_info_voice_hold",
  "credit_app_cosigner",
  "credit_app_approved",
  "financing_declined"
]);

export function shouldPreserveHandoffReasonOverPhoneLog(args: {
  existingMode?: string | null;
  existingReason?: string | null;
}): boolean {
  const mode = String(args?.existingMode ?? "").trim().toLowerCase();
  const reason = String(args?.existingReason ?? "").trim().toLowerCase();
  if (mode !== "manual_handoff") return false;
  return PRESERVE_HANDOFF_REASONS.has(reason);
}

export function buildTrafficLogProPhoneLogLeadKey(leadRef?: string | null): string {
  const ref = String(leadRef ?? "").trim();
  return ref ? `tlp_phone_log_${ref}` : `tlp_phone_log_${Date.now()}`;
}

export function isPhoneLogConversation(conv?: Conversation | null): boolean {
  if (!conv) return false;
  const lead: any = conv.lead ?? {};
  if (lead.phoneLog === true || lead.sourceType === PHONE_LOG_SOURCE_TYPE) return true;
  const bodyText = (conv.messages ?? [])
    .filter(m => String(m.provider ?? "").toLowerCase() === "sendgrid_adf")
    .map(m => String(m.body ?? ""))
    .join(" ");
  return isTrafficLogProPhoneLog({
    leadSource: lead.source ?? (conv as any).leadSource,
    sourceFromId: String(lead.sourceId ?? ""),
    inquiry: lead.inquiry ?? lead.walkInComment,
    body: bodyText
  });
}
