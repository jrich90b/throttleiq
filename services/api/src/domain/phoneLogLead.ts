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
