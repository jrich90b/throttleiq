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
