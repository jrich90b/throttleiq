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

/**
 * A closing acknowledgment is a short, non-actionable customer turn made up
 * ENTIRELY of info-ack / gratitude / sign-off clauses — e.g. "Good to know.
 * Thank you!", "Makes sense, appreciate it", "Thanks 👍". Staying silent on
 * these is the designed closeout behavior (decideConversationCloseoutTurn:
 * reciprocate-once-then-stop), so a quality scorer must NOT grade them as a
 * `missing_response`. The single-token short-ack matcher in the tone scorer
 * misses multi-clause closers and emoji-suffixed acks; this catches those.
 *
 * Deliberately conservative (fail-direction: skipping a turn that DID need a
 * reply would HIDE a real miss): bounded length, no question mark, no
 * actionable cue, EVERY clause must be a known closer, and at least one clause
 * must be a substantive gratitude/acknowledgment (so a bare "ok" — already
 * handled by the short-ack matcher — does not newly qualify here).
 */
const CLOSING_ACK_ACTIONABLE_CUE_RE =
  /\b(available|in stock|price|pricing|payment|payments|apr|finance|financing|monthly|down payment|term|months|come in|stop by|schedule|appointment|call me|callback|text me|tomorrow|today|next week|when)\b/i;
// A single closer phrase: an info-ack, a thanks, or a sign-off.
const CLOSING_ACK_PHRASE =
  "(?:ok(?:ay)?|kk?|got it|sounds good|thank you(?: so| very)?(?: much)?|thanks(?: so| very)?(?: much)?|thx|ty|perfect|awesome|cool|great|will do|good to know|good to hear(?: that)?|good deal|makes sense|noted|understood|appreciate (?:it|that|you)|much appreciated|no problem|np|all good|all set|fair enough|you too|you as well|same to you|cheers|have a (?:good|great) (?:one|day|weekend|night))";
// A familiar term of address that may trail a closer ("thanks man", "appreciate
// it brother", "thanks battle buddy"). These never carry an ask on their own —
// they are vocatives — so a closer followed by one stays a no-reply-needed
// closer. The actionable-cue / question-mark guards below still apply, so
// "thanks man call me" is unaffected (it trips the cue guard before this runs).
const CLOSING_ACK_VOCATIVE =
  "(?:man|bud(?:dy|y)?|bro(?:ther|tha)?|dude|sir|ma'?am|boss|pal|friend|champ|chief|mate|fam|homie|hun|hon|partner|amigo|guys?|battle bud(?:dy|y)|my (?:friend|man|guy))";
// Separator between stacked closers: punctuation/whitespace, optional "and"/"&".
const CLOSING_ACK_SEP = "(?:[\\s.!,]+(?:and |& )?)";
const CLOSING_ACK_FULL_RE = new RegExp(
  `^${CLOSING_ACK_SEP}?(?:${CLOSING_ACK_PHRASE}(?:\\s+${CLOSING_ACK_VOCATIVE})?${CLOSING_ACK_SEP}?)+$`,
  "i"
);
// Requires at least one substantive gratitude/acknowledgment, so a bare "ok" /
// "cool" reaction (handled by the short-ack matcher) does not newly qualify.
const CLOSING_ACK_SUBSTANTIVE_RE =
  /(thank|thx|\bty\b|appreciate|cheers|good to (?:know|hear)|good deal|no problem|all (?:good|set)|will do|sounds good|makes sense|noted|understood|fair enough|you (?:too|as well)|same to you|have a (?:good|great))/i;

export function isClosingAckNoAction(text: string | null | undefined): boolean {
  const raw = String(text ?? "").trim();
  if (!raw) return false;
  if (raw.length > 60) return false;
  if (/\?/.test(raw)) return false;
  const normalized = raw
    .replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu, " ")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return false;
  if (CLOSING_ACK_ACTIONABLE_CUE_RE.test(normalized)) return false;
  if (!CLOSING_ACK_FULL_RE.test(normalized)) return false;
  return CLOSING_ACK_SUBSTANTIVE_RE.test(normalized);
}

/**
 * A bare ASCII-emoticon reaction — ":)", ";-)", ":D", "=)", "<3", "^_^" — is a
 * pure no-reply-needed reaction, the ASCII twin of the Unicode-emoji-only turn
 * the tone scorer's short-ack matcher already skips. That matcher's emoji branch
 * is Unicode-only (`\p{Emoji}`), so a customer who texts a typed ":)" leaks
 * through and is wrongly graded `missing_response` (a phantom miss). Bounded
 * length and a strict emoticon-token shape keep this fail-safe: a turn that
 * carries any real word (an ask, a model, a question) cannot match.
 */
const ASCII_EMOTICON_TOKEN_RE =
  /^(?:[:;=8xX]['"`]?[-o^*]?[)\]}>(\[{<dDpP3cC|/\\]+|<3+|\^_?\^|x[dD])$/;
export function isBareEmoticonReaction(text: string | null | undefined): boolean {
  const t = String(text ?? "").trim();
  if (!t) return false;
  if (t.length > 24) return false;
  const tokens = t.split(/\s+/);
  if (tokens.length === 0 || tokens.length > 4) return false;
  return tokens.every(tok => ASCII_EMOTICON_TOKEN_RE.test(tok));
}

export function isNonSalesConversation(conv: {
  followUp?: { reason?: string | null } | null;
}): boolean {
  const reason = String(conv?.followUp?.reason ?? "").trim().toLowerCase();
  return NON_SALES_FOLLOWUP_REASONS.has(reason);
}

/**
 * A human-rewritten outbound — the agent drafted X (captured in
 * `originalDraftBody`) but a staff member SENT a different body — is not the
 * agent's customer-facing reply. Quality scorers (tone QA) measure the AGENT, so
 * grading it on a staff member's hand-typed text is a phantom miss.
 *
 * Production case (2026-06-29, Gary Busenlehner +17163168664): the agent drafted
 * "Sure. what time on tomorrow works best?" — a clean scheduling answer to "Can
 * you get it ready for tomorrow" — but Scott sent "You can take the bike but
 * unfortunately it wont have the accessories installed". The tone scorer flagged
 * the AGENT with `intent_mismatch` + `question_not_answered_first` on Scott's
 * words, tanking the release-gate tone pass rate on a turn the agent handled
 * correctly.
 *
 * `originalDraftBody` is stamped ONLY when a human EDITS a draft before sending
 * (verbatim-approved drafts and automated agent sends carry no
 * `originalDraftBody`), so requiring a NON-EMPTY draft that DIFFERS from the sent
 * body makes this fail-safe: it can never misfire on an agent's own send and so
 * cannot hide a real agent miss. The agent's draft-quality on edited sends is
 * already measured by the edit-feedback miner, so skipping here loses no signal.
 */
export function isHumanRewrittenOutbound(msg: {
  body?: string | null;
  originalDraftBody?: string | null;
}): boolean {
  const draft = String(msg?.originalDraftBody ?? "").replace(/\s+/g, " ").trim();
  if (!draft) return false;
  const sent = String(msg?.body ?? "").replace(/\s+/g, " ").trim();
  if (!sent) return false;
  return sent.toLowerCase() !== draft.toLowerCase();
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
