/**
 * "AWAITING YOUR REPLY" — the inbox flag for a customer nobody has answered (Joe, 2026-08-18:
 * *"I've noticed a few times now I'm almost missing responding. Is there any way to have a flag of
 * 'awaiting response' if the ai agent is not going to generate a response?"*).
 *
 * WHY THE ROW WAS BLANK. The inbox card can show three states and all three are about a DRAFT:
 * "Draft ready" (`pendingDraft`), "Being fixed" (`draftHeld`, quality hold) and "Needs your reply"
 * (`draftHeld` with `heldKind: context_fidelity` — the agent tried and the gate blocked it). When
 * the agent produces nothing at all there is no draft to describe, so the card rendered NOTHING —
 * visually identical to a finished conversation.
 *
 * MEASURED on the live store the day this was written: **20** open threads whose newest message is
 * a customer text with nothing waiting in the approval box. **All 20 showed no flag of any kind** —
 * 0 held, 0 pending. 16 of the 20 are `mode: human`.
 *
 * WHY HUMAN MODE IS THE WHOLE PROBLEM, not an edge case. Three nets are supposed to cover this and
 * on a human-owned thread every one of them misses:
 *   1. the card — needs a draft to exist (above);
 *   2. `turnResponseTripwire` — skips `mode: human` BY DESIGN, deferring to the per-inbound
 *      reply-needed backstop;
 *   3. that backstop — `human_mode_reengagement_reply_needed` fired **0 times** on 8/16, 8/17 and
 *      8/18, and `humanModeWatchClaim.ts` records it firing for nobody 7/25→8/14. It is dead, and
 *      the tripwire is standing down in favour of something that is not running.
 * The open tasks on those threads were checked too: every one is `reason: "call"` — a call
 * reminder, not "reply to this text". So there is currently NO signal anywhere. Fixing the dead
 * backstop is a separate change on purpose (one behaviour change per deploy, so a regression has
 * one suspect).
 *
 * FAIL DIRECTION — deliberately the opposite of the tripwire's. The tripwire mints a TASK, a side
 * effect, so it fails toward silence. This flag paints a word on a row Joe is already reading: a
 * wrong flag costs a two-second glance, a missing one costs the customer. So anything uncertain
 * FLAGS. The single exception is the pure courtesy closer, and that exception is Joe's own ruling
 * (2026-08-13, Christopher +17169400722): *"Why did this create a task when the customer just said
 * awesome?"* — a flag that lights up on "thanks!" is a flag he learns to ignore, which converts
 * straight back into missed customers. `isBareAcknowledgementText` is reused rather than
 * re-invented precisely so there is ONE definition of "nothing but a courtesy word" (it strips
 * courtesy tokens and filler and asks whether any content is LEFT, so "Found a better offer.
 * Thanks" is not bare).
 *
 * This is a DISPLAY predicate: it writes nothing, sends nothing and closes nothing. Pure so the
 * eval can execute it. Pinned by `awaiting_reply_flag:eval`.
 */
import { isBareAcknowledgementText } from "./bareAcknowledgement.js";
import { isQuotedReactionInboundText } from "./regenerateSelection.js";

/** Providers that represent a customer TEXT sitting unanswered on someone's phone. */
const CUSTOMER_TEXT_PROVIDERS: ReadonlySet<string> = new Set(["twilio", "web_widget"]);

/** A human being reached them by phone counts as an answer, even though it is not a message. */
const VOICE_PROVIDERS: ReadonlySet<string> = new Set(["voice_call", "voice_transcript"]);

export type AwaitingReplyRow = {
  direction?: string | null;
  provider?: string | null;
  body?: string | null;
  at?: string | null;
  draftStatus?: string | null;
};

export type AwaitingReplyDecision =
  | { awaiting: false; reason: string }
  | { awaiting: true; sinceIso: string | null; ageMinutes: number | null; excerpt: string };

/**
 * The last thing that actually HAPPENED on the thread.
 *
 * Draft rows are skipped whatever their status: a draft is not something the customer received.
 * A `stale` draft especially — it renders like a send in some surfaces and never reached anyone
 * (the 2026-07-20 inbox-preview ruling made the same call for the row preview).
 */
export function findLastRealEvent(messages: AwaitingReplyRow[] | null | undefined): AwaitingReplyRow | null {
  const rows = Array.isArray(messages) ? messages : [];
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const m = rows[i];
    if (!m) continue;
    if (String(m.provider ?? "") === "draft_ai") continue;
    if (String(m.draftStatus ?? "").trim()) continue;
    if (!String(m.body ?? "").trim()) continue;
    return m;
  }
  return null;
}

export function decideAwaitingReplyFlag(input: {
  nowMs: number;
  status?: string | null;
  suppressed?: boolean | null;
  /** Truthy when a held draft already gives the row its own badge ("Needs your reply" / "Being fixed"). */
  draftHeld?: unknown;
  /** True when a draft is waiting in the approval box ("Draft ready" already shows). */
  hasPendingDraft?: boolean | null;
  messages?: AwaitingReplyRow[] | null;
}): AwaitingReplyDecision {
  if (String(input.status ?? "").toLowerCase() === "closed") return { awaiting: false, reason: "closed" };
  if (input.suppressed) return { awaiting: false, reason: "suppressed" };
  // Both of these already put a word on the row. A second flag would be the double-badge the
  // 2026-08-14 appointment-pill fix existed to remove.
  if (input.draftHeld) return { awaiting: false, reason: "draft_held_has_its_own_badge" };
  if (input.hasPendingDraft) return { awaiting: false, reason: "draft_ready_has_its_own_badge" };

  const last = findLastRealEvent(input.messages);
  if (!last) return { awaiting: false, reason: "no_messages" };
  if (last.direction === "out") return { awaiting: false, reason: "we_answered_last" };
  const provider = String(last.provider ?? "");
  if (VOICE_PROVIDERS.has(provider)) return { awaiting: false, reason: "voice_contact_last" };
  if (last.direction !== "in") return { awaiting: false, reason: "last_event_not_inbound" };
  // Scoped to customer TEXTS for this first cut, matching the tripwire's own scope. An unanswered
  // ADF web-lead form is a real gap too, but it is a different population with a different fix
  // (the first-touch pipeline), and shipping it inside this flag would blur which change moved the
  // number.
  if (!CUSTOMER_TEXT_PROVIDERS.has(provider)) return { awaiting: false, reason: `provider_${provider || "none"}` };

  const body = String(last.body ?? "");
  // Joe's 2026-08-13 ruling. Note the asymmetry that keeps this safe: a message this MISSES gets
  // flagged (the loud, cheap error), and only a message it is confident carries no content at all
  // goes quiet.
  if (isBareAcknowledgementText(body)) return { awaiting: false, reason: "courtesy_closer" };
  if (isQuotedReactionInboundText(body)) return { awaiting: false, reason: "tapback_reaction" };

  const atMs = Date.parse(String(last.at ?? ""));
  const dated = Number.isFinite(atMs);
  return {
    awaiting: true,
    sinceIso: dated ? new Date(atMs).toISOString() : null,
    // Undatable rows still flag — the flag is the point; only the "how long" is unknown.
    ageMinutes: dated ? Math.max(0, Math.round((input.nowMs - atMs) / 60_000)) : null,
    excerpt: body.replace(/\s+/g, " ").slice(0, 140)
  };
}
