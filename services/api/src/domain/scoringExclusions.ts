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

/**
 * Year-rollover park fingerprint. The fixed-but-must-stay-caught cadence bug
 * (parsePauseUntil / bumpCadenceNextDueAt parking a lead a year out) lands on
 * the FIRST of a month at a round 9-o'clock boundary: 09:00 UTC (`{month}-01T09:00Z`,
 * the original signature) or 09:00 America/New_York (13:00Z EDT / 14:00Z EST,
 * e.g. the 2027-05-01T13:00:00Z parks). Legit long-term cadence math anchors to
 * the original lead time, so its dates carry non-zero minutes and non-first days
 * — they never hit this fingerprint. We use it to make sure the long-term-park
 * exclusion below can never accidentally excuse a rollover bug.
 */
const ROLLOVER_FINGERPRINT_HOURS_UTC = new Set([9, 13, 14]);
export function isYearRolloverParkFingerprint(nextDueAtIso: string | null | undefined): boolean {
  const iso = String(nextDueAtIso ?? "").trim();
  if (!iso) return false;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return false;
  const d = new Date(ms);
  return (
    d.getUTCDate() === 1 &&
    d.getUTCMinutes() === 0 &&
    d.getUTCSeconds() === 0 &&
    ROLLOVER_FINGERPRINT_HOURS_UTC.has(d.getUTCHours())
  );
}

/**
 * A far-future cadence park is JUSTIFIED — a deliberate long-term touch, not an
 * audit offender — when the cadence kind is "long_term" AND it carries a
 * deferred message (the park is message-bearing, e.g. Courtney Ward's 4-6-month
 * "reach out when the time is right" step, or a ride-challenge final-mileage
 * touch). The year-rollover bug must STILL be flagged even on a long_term
 * cadence, so a park whose nextDueAt matches the rollover fingerprint is never
 * excused. Keeping this central (not inline in the actions audit) so tone QA /
 * release gate / actions audit all classify long-term parks the same way.
 */
export function isJustifiedLongTermCadencePark(cadence: {
  kind?: string | null;
  nextDueAt?: string | null;
  deferredMessage?: unknown;
} | null | undefined): boolean {
  if (!cadence) return false;
  if (String(cadence.kind ?? "") !== "long_term") return false;
  const deferred = cadence.deferredMessage;
  const hasDeferredMessage =
    typeof deferred === "string" ? deferred.trim().length > 0 : deferred != null;
  if (!hasDeferredMessage) return false;
  if (isYearRolloverParkFingerprint(cadence.nextDueAt)) return false;
  return true;
}
