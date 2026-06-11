/**
 * Shared exclusion classifiers for quality scoring (tone QA, voice charter,
 * route watchdog, release gate). These keep nightly reports honest: scorers
 * must never count shadow-replay traffic, automated senders, or non-sales
 * threads as customer-quality misses.
 */

const SHADOW_PROVIDER_MESSAGE_ID_RE = /^(SMshadow|MMshadow|adf_shadow_)/i;
const SHADOW_SENDER_RE = /shadow-replay@/i;

export function isShadowReplayMessage(msg: {
  providerMessageId?: string | null;
  from?: string | null;
}): boolean {
  if (SHADOW_PROVIDER_MESSAGE_ID_RE.test(String(msg?.providerMessageId ?? "").trim())) return true;
  if (SHADOW_SENDER_RE.test(String(msg?.from ?? "").trim())) return true;
  return false;
}

const AUTOMATED_SENDER_RE =
  /^(autosender|auto-sender|noreply|no-reply|donotreply|do-not-reply|mailer-daemon|postmaster|notifications?)@/i;
const AUTOMATED_BODY_RE = /^this email contains html formatted content/i;

export function isAutomatedSenderInbound(args: {
  from?: string | null;
  body?: string | null;
  convId?: string | null;
}): boolean {
  const from = String(args?.from ?? "").trim();
  const convId = String(args?.convId ?? "").trim();
  if (AUTOMATED_SENDER_RE.test(from) || AUTOMATED_SENDER_RE.test(convId)) return true;
  const body = String(args?.body ?? "").replace(/\s+/g, " ").trim();
  if (AUTOMATED_BODY_RE.test(body)) return true;
  return false;
}

const NON_SALES_FOLLOWUP_REASONS = new Set(["hiring_manager_inquiry", "vendor_inquiry", "spam"]);

export function isNonSalesConversation(conv: {
  followUp?: { reason?: string | null } | null;
}): boolean {
  const reason = String(conv?.followUp?.reason ?? "").trim().toLowerCase();
  return NON_SALES_FOLLOWUP_REASONS.has(reason);
}
