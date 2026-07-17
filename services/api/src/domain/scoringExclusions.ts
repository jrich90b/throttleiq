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
 * A structured lead-intake payload — an ADF (`PHONE LOG (ADF)`, `WEB LEAD (ADF)`)
 * or a website widget envelope (`WEB TEXT WIDGET`) delivered by the lead provider
 * (Traffic Log Pro, HDFS COA, the dealer site) — is a SYSTEM re-sync of lead
 * data, not a customer-authored question. A human never types "(ADF)" or "WEB
 * TEXT WIDGET"; these carry Source/Ref/Inquiry/Vehicle/Department fields, not a
 * request awaiting a reply. When such a payload lands on a conversation that is
 * ALREADY engaged (a prior outbound exists), the customer is not waiting on a
 * reply to the payload text, so a tone scorer must not grade it `missing_response`.
 * (Kody Erhard +17163975098, 7/10: a duplicate `PHONE LOG (ADF)` re-notification
 * arrived mid-live-finance-deal and was wrongly counted a missed reply, dirtying
 * the release gate's `toneMissingResponses`.)
 *
 * Fail-direction guard: the `hasPriorOutbound` requirement means a genuinely NEW
 * lead's FIRST intake payload (no outbound yet) is NEVER skipped — so a real
 * "never responded to a new lead" miss is still caught (e.g. +17168610158, "there
 * was never an initial response generated for this lead"). Only a duplicate /
 * follow-on intake payload on an active thread is excluded. Both a marker AND a
 * structured field are required so a customer who merely mentions "adf" cannot
 * match.
 */
const LEAD_INTAKE_MARKER_RE = /(PHONE LOG \(ADF\)|WEB LEAD \(ADF\)|WEB TEXT WIDGET|\(ADF\))/i;
const LEAD_INTAKE_FIELD_RE = /\b(Source|Ref|Inquiry|Vehicle|Department|PreQual|Lead|Page|URL)\s*:/i;

export function isLeadIntakeRenotificationOnEngagedThread(args: {
  body?: string | null;
  hasPriorOutbound?: boolean | null;
}): boolean {
  if (!args?.hasPriorOutbound) return false;
  const body = String(args?.body ?? "").replace(/\s+/g, " ").trim();
  if (!body) return false;
  if (!LEAD_INTAKE_MARKER_RE.test(body)) return false;
  return LEAD_INTAKE_FIELD_RE.test(body);
}

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

/**
 * Strip emoji decoration so a matcher grades what the customer SAID, not how
 * they dressed it up ("Thanks 👍" is the turn "Thanks").
 *
 * Covers pictographs plus the skin-tone modifiers, variation selectors and ZWJ
 * that ride along with them. Deliberately NOT `\p{Emoji}` / `\p{Emoji_Component}`:
 * those also match plain digits and `#`/`*`, so stripping them would silently
 * rewrite "ok 2" into "ok" and mask real content.
 */
function stripEmojiDecoration(text: string): string {
  return text.replace(/[\p{Extended_Pictographic}\p{Emoji_Modifier}\u{FE0F}\u{200D}]/gu, " ");
}

export function isClosingAckNoAction(text: string | null | undefined): boolean {
  const raw = String(text ?? "").trim();
  if (!raw) return false;
  if (raw.length > 60) return false;
  if (/\?/.test(raw)) return false;
  const normalized = stripEmojiDecoration(raw)
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return false;
  if (CLOSING_ACK_ACTIONABLE_CUE_RE.test(normalized)) return false;
  if (!CLOSING_ACK_FULL_RE.test(normalized)) return false;
  return CLOSING_ACK_SUBSTANTIVE_RE.test(normalized);
}

// Forward-looking excitement with no ask — "can't wait", "so excited",
// "looking forward to it", "stoked". These are the future-tense twin of a
// closing ack: the customer is expressing anticipation about a plan already in
// motion (an appointment, an event they RSVP'd to), not opening a new thread.
const ENTHUSIASM_ACK_RE =
  /(?:can'?t wait|cant wait|so excited|super excited|really excited|looking forward|look forward|counting down|pumped|stoked|thrilled|see you (?:then|there|soon|saturday|sunday|monday|tuesday|wednesday|thursday|friday|tomorrow)|let'?s (?:go|do it)|woo+ho+|yes+)/i;

/**
 * A short, forward-looking enthusiasm reply carries no question and asks nothing
 * of us — replying "great, see you then!" to "Can't wait" is filler that makes
 * the agent read as a bot. So the agent is correctly silent, and grading that
 * silence is a phantom miss (the +15857657010 "Can't wait" reaction to the 7/16
 * event blast was one of the turns that dirtied the release gate; a bare
 * short-ack matcher never covered it because "can't wait" is not an ack phrase).
 *
 * Fail-direction: this HIDES turns from scoring, so over-firing masks a real
 * miss. Kept fail-safe by a length ceiling, a question-mark guard, and the SAME
 * actionable-cue guard the closing-ack matcher uses — "can't wait, what's the
 * price?" or "so excited — when can I come in?" still get graded.
 */
export function isEnthusiasmAckNoAction(text: string | null | undefined): boolean {
  const raw = String(text ?? "").trim();
  if (!raw) return false;
  if (raw.length > 60) return false;
  if (/\?/.test(raw)) return false;
  const normalized = stripEmojiDecoration(raw)
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return false;
  if (CLOSING_ACK_ACTIONABLE_CUE_RE.test(normalized)) return false;
  return ENTHUSIASM_ACK_RE.test(normalized);
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

/**
 * A bare short ack — "ok", "thanks", "awesome", "👍", "Awesome 👍" — carries no
 * ask, so the agent is correctly silent on it. Grading that silence as a
 * `missing_response` manufactures a phantom miss.
 *
 * Every scorer used to keep its own inline copy of this matcher (tone quality,
 * reply-coverage intake, conversation audit) and all three drifted apart while
 * sharing one gap: the ack list was matched against RAW text, so a trailing
 * emoji defeated it. Bare "Awesome" was skipped but "Awesome 👍" was graded a
 * miss — on 2026-07-17 exactly two such turns ("Awesome 👍", one emoji-tailed
 * ack) dirtied the release gate's tone-missing count. `isClosingAckNoAction`
 * above already strips pictographs before matching; this now does the same, so
 * decoration no longer changes the verdict.
 *
 * Fail-direction: this HIDES turns from scoring, so over-firing would mask a
 * real miss. It stays fail-safe via a length ceiling and a question-mark guard
 * ("ok?" is a question, not an ack) — both strictly NARROWER than the inline
 * copies this replaces, two of which had neither.
 */
const SHORT_ACK_PHRASE_RE =
  /^(?:ok(?:ay)?|kk?|got it|sounds (?:good|great)|thanks|thank you|thx|ty|perfect|awesome|cool|great|will do|yep|yup|sure|no problem)[.!\s]*$/i;

export function isShortAckNoAction(text: string | null | undefined): boolean {
  const raw = String(text ?? "").trim();
  if (!raw) return false;
  if (raw.length > 80) return false;
  // A question is never a bare ack, however short ("ok?", "cool?").
  if (/\?/.test(raw)) return false;
  if (isBareEmoticonReaction(raw)) return true;
  const normalized = stripEmojiDecoration(raw)
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
  // Nothing but emoji survived the strip — a pure reaction turn.
  if (!normalized) return true;
  return SHORT_ACK_PHRASE_RE.test(normalized);
}

export function isNonSalesConversation(conv: {
  followUp?: { reason?: string | null } | null;
}): boolean {
  const reason = String(conv?.followUp?.reason ?? "").trim().toLowerCase();
  return NON_SALES_FOLLOWUP_REASONS.has(reason);
}

/**
 * A placeholder / test-harness lead identity. The Dealer Lead App (DLA) ships
 * canned test submissions the dealer fires to sanity-check the pipeline — e.g.
 * `test@hotmail.com` / `test@icloud.com` ("KEVIN Test 111 Dla Cooper"). The
 * runtime correctly declines to draft a first touch for these, but the tone
 * scorer then counted each as a `missing_response`, inflating the release
 * gate's tone-missing failure (2026-07-01: 3 of 6 "missing" turns were DLA
 * `test@` submissions). The pre-existing inline `@example.com` skip missed them
 * because they use real consumer domains.
 *
 * Fail-direction is safe: a genuine sales lead never uses the bare local-part
 * `test` (or a `test+tag` / `test.<n>` variant), and `@example.com` /
 * `@example.*` are reserved test domains — so this can never hide a real
 * customer miss. Deliberately narrow: it matches the local-part shape, NOT any
 * email merely containing "test" (e.g. `contestwinner@…` stays a real lead).
 */
const TEST_LEAD_LOCALPART_RE = /^test(?:[+._-]\w+)?$/i;
const RESERVED_TEST_DOMAIN_RE = /@example\.(?:com|net|org)$/i;
export function isTestLeadEmail(email: string | null | undefined): boolean {
  const e = String(email ?? "").trim().toLowerCase();
  if (!e || !e.includes("@")) return false;
  if (RESERVED_TEST_DOMAIN_RE.test(e)) return true;
  const localPart = e.slice(0, e.indexOf("@"));
  return TEST_LEAD_LOCALPART_RE.test(localPart);
}

/**
 * A standalone carrier opt-out keyword — "STOP", "STOPALL", "UNSUBSCRIBE",
 * "CANCEL", "END", "QUIT" (Twilio's default STOP-keyword set). When a customer
 * texts one of these, Twilio itself opts the number out, sends the compliance
 * confirmation, and BLOCKS further outbound — so the agent staying silent is
 * the only legal behavior, not a miss. The tone scorer graded Tom Kraft
 * (+17165237203, 2026-07-01: bare "Stop") as a `missing_response`; a reply
 * there would be a compliance violation, and the platform wouldn't have
 * delivered it anyway.
 *
 * Fail-direction is safe: it matches ONLY a message that IS the bare keyword
 * (optional trailing punctuation), mirroring Twilio's own whole-message match —
 * "stop texting me about the road glide" is NOT an opt-out and still scores.
 */
const OPT_OUT_KEYWORD_RE = /^(?:stop|stopall|unsubscribe|cancel|end|quit|opt[\s-]?out)[.!\s]*$/i;
export function isOptOutKeywordInbound(text: string | null | undefined): boolean {
  const t = String(text ?? "").trim();
  if (!t) return false;
  return OPT_OUT_KEYWORD_RE.test(t);
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

/**
 * Indefinite follow-up deferral: the customer said THEY will re-initiate
 * ("I'll let you know", "we'll reach out", "I'll get back to you").
 *
 * KEEP-class deterministic safety gate (fail-direction: toward NOT contacting).
 * The cadence tick (index.ts parsePauseUntil) holds every proactive touch while
 * the conversation's LAST inbound matches this — correct behavior per Joe's
 * policy (don't nag an opted-down customer; any new inbound clears the hold by
 * becoming the new last inbound). This is the ENGINE's live gate, exported so
 * detectors share the exact predicate and can never drift from it.
 */
export function isIndefiniteFollowUpDeferralText(text: string | null | undefined): boolean {
  const t = String(text ?? "").toLowerCase();
  return /((i|we)('| )?ll let you know|(i|we) will let you know|(i|we)('| )?ll reach out|(i|we) will reach out|(i|we)('| )?ll get back to you|(i|we) will get back to you)/.test(
    t
  );
}

/**
 * A PURE indefinite-deferral inbound — the customer said THEY will re-initiate
 * ("I'll let you know", "I'll reach out", "I'll get back to you") and asked us
 * for NOTHING actionable this turn. The reply pipeline correctly stays silent
 * (the engine holds cadence on exactly this — isCadenceHeldByIndefiniteDeferral),
 * so the tone scorer must not grade it as a `missing_response`.
 *
 * Production case (2026-07-07, Gary Shapiro +17167069902): "I'll see how tomorrow
 * goes. I'll be tied up for a while. I'll let you know. I'm in no rush. if we
 * can't do this week I'll try for next week" — a textbook no-rush deferral graded
 * a phantom missing_response, dirtying the release gate's tone-missing count. The
 * scorer's `hasActionableCue` misfired on the deferral-context temporal words
 * ("tomorrow", "next week"), so the `human_mode_non_actionable` skip didn't catch
 * it. Mirrors the John-Miller cadence-hold fix (isCadenceHeldByIndefiniteDeferral),
 * one turn earlier.
 *
 * Fail-direction is safe (toward STILL grading): it requires the deferral phrase
 * AND no question mark AND none of the hard transactional / contact-me cues
 * (price/pricing/payment/apr/finance/monthly/available/in stock/quote/call me/
 * callback/text me/email me/send me/can-you/could-you/would-you) — so a deferral
 * that ALSO carries a real ask ("I'll let you know — but send me the price") still
 * scores. Strictly narrower than the engine's own live gate.
 */
const DEFERRAL_ACTIONABLE_REQUEST_RE =
  /\b(available|in stock|price|pricing|payment|payments|apr|finance|financing|monthly|down payment|quote|call me|callback|text me|email me|send me|can you|could you|would you)\b/i;
export function isIndefiniteDeferralNoActionableAsk(text: string | null | undefined): boolean {
  const t = String(text ?? "").trim();
  if (!t) return false;
  if (!isIndefiniteFollowUpDeferralText(t)) return false;
  if (/\?/.test(t)) return false;
  if (DEFERRAL_ACTIONABLE_REQUEST_RE.test(t)) return false;
  return true;
}

/**
 * The engine's indefinite-deferral hold, at conversation level: the LAST
 * inbound message says the customer will re-initiate, so the cadence tick
 * skips this conversation every pass — by design — while nextDueAt stays
 * frozen in the past. The actions audit's "cadence_stalled" check must model
 * this hold or a correctly-held cadence dirties the release gate every day
 * (John Miller +15857657010, flagged 2026-07-01→07-07). Mirrors the tick's
 * getLastInbound: newest message with direction "in" and a non-empty body.
 */
export function isCadenceHeldByIndefiniteDeferral(conv: {
  messages?: Array<{ direction?: string | null; body?: string | null }> | null;
} | null | undefined): boolean {
  const msgs = Array.isArray(conv?.messages) ? conv.messages : [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m?.direction !== "in") continue;
    const body = String(m?.body ?? "").trim();
    if (!body) continue;
    return isIndefiniteFollowUpDeferralText(body);
  }
  return false;
}

/**
 * A campaign-broadcast send is a staff-composed mass-marketing SMS/email blast
 * fired from Campaign Studio (`POST /contacts/broadcast`), NOT the agent's 1:1
 * conversational voice. The broadcast handler tags the conversation with a
 * `campaignThread` (campaignId + first/lastSentAt) and appends the outbound at
 * ~the same instant; a genuine 1:1 agent reply lives on a thread with no
 * campaignThread (or lands minutes/hours from any send). We identify a broadcast
 * send by that correlation — a message on a campaign-tagged thread whose `at`
 * sits within a few seconds of a campaignThread send timestamp.
 *
 * Why exclude it from the Agent Voice Charter: the charter grades the AGENT's
 * conversational tone (banned filler, brand-repeat, persona re-intro). A
 * marketing blast legitimately LEADS with the full dealer brand ("American
 * Harley-Davidson: $1,000 Customer Cash…") for recipient identification, so the
 * `long_brand_repeat` check fires 10× on one blast and dirties the release gate
 * with a false-positive class. (2026-07-15: a single "Customer Cash Low Rider S
 * & ST" blast to 10 numbers drove the charter rate to 17.2%.)
 *
 * Fail-direction: this is a REPORT-ONLY scorer exclusion — it can never change a
 * customer-facing send, close, route, or task; the worst case is under-counting
 * a charter nit on a staff-composed blast. The correlation is tight (campaignId
 * required + a ±10s window around a recorded send), so a real 1:1 agent reply is
 * never excused: the opt-out footer alone is NOT used (agent first-touch intros
 * carry it too and must still be graded).
 */
const CAMPAIGN_BROADCAST_MATCH_TOLERANCE_MS = 10_000;
export function isCampaignBroadcastSend(
  msg: { at?: string | null; direction?: string | null } | null | undefined,
  campaignThread:
    | { campaignId?: string | null; firstSentAt?: string | null; lastSentAt?: string | null }
    | null
    | undefined
): boolean {
  if (!campaignThread) return false;
  if (!String(campaignThread.campaignId ?? "").trim()) return false;
  const atMs = Date.parse(String(msg?.at ?? "").trim());
  if (!Number.isFinite(atMs)) return false;
  for (const iso of [campaignThread.firstSentAt, campaignThread.lastSentAt]) {
    const sentMs = Date.parse(String(iso ?? "").trim());
    if (Number.isFinite(sentMs) && Math.abs(atMs - sentMs) <= CAMPAIGN_BROADCAST_MATCH_TOLERANCE_MS) {
      return true;
    }
  }
  return false;
}
