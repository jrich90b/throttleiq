/**
 * Which staff replies are safe to TEACH the draft generator.
 *
 * WHY THIS EXISTS. `language_corpus_mine.ts` harvests exemplars for the few-shot corpus that is
 * injected into EVERY draft. It selected them with `provider === "human"` — which matches 38
 * messages in the entire store, inside a rolling 2-hour window, so the teaching set has been frozen
 * at six examples since 2026-07-21. The real pool is 1,261: a staff-written send is identified by an
 * ACTOR STAMP, not a provider (an approved AI draft sends via "twilio" too). The codebase already
 * says so in `isHumanAuthoredOutbound` — the miner never got the memo.
 *
 * BUT VOLUME IS NOT QUALITY. Promoting raw staff replies as exemplars teaches whatever they contain,
 * and this codebase has already measured that some of them are unsafe to copy:
 *  - a rep quoting "$21,495" on a unit with NO set price (human-correction-steering-can-be-unsafe);
 *    taught as a pattern that becomes "volunteer a number", which is the unsolicited-payment-quote
 *    class (#401) and the rate-quoting policy;
 *  - "corrections" on human-owned threads, which are a staff member driving their own conversation,
 *    not a correction of the agent (human-correction-on-human-owned-thread).
 *
 * FAIL DIRECTION: exclude when unsure. A missed exemplar costs nothing — there are 1,261 of them.
 * A bad one is copied into every draft the agent writes.
 */

export type ExemplarCandidate = {
  actorUserId?: string | null;
  actorUserName?: string | null;
  direction?: string | null;
  provider?: string | null;
  body?: string | null;
};

/** Channels a customer actually receives text on. Voice logs and drafts are not exemplars. */
const DELIVERED_TEXT_PROVIDERS = new Set(["twilio", "sendgrid", "human"]);

/**
 * A staff-authored 1:1 send. The discriminator is the ACTOR STAMP, matching
 * `isHumanAuthoredOutbound` (conversationOutcomeAudit.ts) — not the provider.
 *
 * A Campaign Studio BROADCAST carries no actor stamp, so it is excluded by construction, which is
 * what we want: a mass send is not an example of talking to one customer.
 */
export function isStaffAuthoredReply(m: ExemplarCandidate | null | undefined): boolean {
  if (!m || m.direction !== "out") return false;
  if (!DELIVERED_TEXT_PROVIDERS.has(String(m.provider ?? "").trim().toLowerCase())) return false;
  return Boolean(String(m.actorUserName ?? "").trim() || String(m.actorUserId ?? "").trim());
}

/** Money figures we cannot verify at mine time — teaching a number risks the model reusing it. */
const MONEY_RE = /\$\s?\d|(\b\d[\d,]{2,}\b\s*(?:dollars|down|\/mo|per month|a month))/i;

export type ExemplarRejection =
  | "not_staff_authored"
  | "human_owned_thread"
  | "quotes_money"
  | "too_short"
  | "reply_too_late"
  | "superseded_by_later_inbound"
  | null;

/**
 * Why this reply must NOT become a teaching example — or null when it is safe to promote.
 * `threadMode` is the conversation's own mode; a human-owned thread is a rep driving their own
 * conversation, and copying it teaches the agent to imitate a takeover.
 */
export function rejectExemplarReason(input: {
  message: ExemplarCandidate | null | undefined;
  threadMode?: string | null;
  isShortAck?: boolean;
}): ExemplarRejection {
  if (!isStaffAuthoredReply(input.message)) return "not_staff_authored";
  const mode = String(input.threadMode ?? "").trim().toLowerCase();
  if (mode === "human" || mode === "manual_handoff") return "human_owned_thread";
  if (input.isShortAck) return "too_short";
  if (MONEY_RE.test(String(input.message?.body ?? ""))) return "quotes_money";
  return null;
}

/**
 * ONE CUSTOMER TURN, NOT N COPIES OF ONE REPLY.
 *
 * The miner pairs each inbound with "the next outbound". When a customer sends several messages and
 * we answer once — or worse, when messages go unanswered and a rep finally replies much later —
 * that single reply was harvested once PER inbound. Measured over the full store on 2026-08-06:
 * 193 of 403 candidates were the same reply pasted onto 2+ different customer messages, the worst
 * being one "Ok, will do." attached to NINE questions including "What do I have to do to reserve
 * one". Teaching that teaches the agent that a vague acknowledgment answers a direct question —
 * precisely the passivity at the top of the ranked comprehension backlog.
 *
 * So an exemplar is built from the customer's whole turn: the run of consecutive inbounds that the
 * reply actually responded to. Two bounds keep that run honest:
 *  - REPLY_MAX_LAG — a reply a day and a half later is not an answer to that turn;
 *  - TURN_SPAN — messages far older than the last one belong to earlier, unanswered turns and must
 *    not be presented as things this reply addressed.
 * Both fail the same way the rest of this module does: when the pairing is doubtful, drop it.
 */
export const EXEMPLAR_REPLY_MAX_LAG_MS = 24 * 60 * 60 * 1000;
export const EXEMPLAR_TURN_SPAN_MS = 2 * 60 * 60 * 1000;

export type ExemplarTurnInput = {
  /** Consecutive inbounds ending with the last one before the reply, oldest first. */
  inbounds: { at?: string | null; body?: string | null }[];
  replyAt?: string | null;
};

export type ExemplarTurn =
  | { ok: true; inboundText: string; messageCount: number }
  | { ok: false; reason: Exclude<ExemplarRejection, null> };

/**
 * Merge a customer's consecutive messages into the single turn a reply answered, or say why this
 * pairing is not usable. Returns the messages joined newest-last, the order they were sent.
 */
export function collectExemplarTurn(input: ExemplarTurnInput): ExemplarTurn {
  const msgs = (input.inbounds ?? [])
    .map(m => ({ ms: Date.parse(String(m?.at ?? "")), body: String(m?.body ?? "").trim() }))
    .filter(m => m.body && Number.isFinite(m.ms))
    .sort((a, b) => a.ms - b.ms);
  if (!msgs.length) return { ok: false, reason: "superseded_by_later_inbound" };

  const replyMs = Date.parse(String(input.replyAt ?? ""));
  const lastMs = msgs[msgs.length - 1].ms;
  if (!Number.isFinite(replyMs) || replyMs - lastMs > EXEMPLAR_REPLY_MAX_LAG_MS) {
    return { ok: false, reason: "reply_too_late" };
  }

  const turn = msgs.filter(m => lastMs - m.ms <= EXEMPLAR_TURN_SPAN_MS);
  return { ok: true, inboundText: turn.map(m => m.body).join("\n"), messageCount: turn.length };
}
