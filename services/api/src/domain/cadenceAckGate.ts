// Cadence-ack suppression gate.
//
// The console "pause / stop cadence" button (`POST /conversations/:id/followup-action`)
// intentionally texts the customer a warm closer ("I'll be here when you're ready. If
// anything changes, just let me know.") via `buildCadenceAck` — the right touch when a
// customer says "I'll get back to you later" and staff pause the cadence.
//
// But it fired blindly even when a HUMAN was mid-conversation. Production case
// (Bill / +17166090270, 2026-07-17): a rep manually texted the seller "send some pictures
// of the bike and the front/back of the title" and hit pause 9 seconds later — so the
// customer got "no rush, here when you're ready" right after a person actively asked him
// for something. Tonally contradictory, and unwanted while a human drives the thread.
//
// This is a pure side-effect gate (not customer-comprehension): suppress the auto-ack when
// a staff member is actively handling the thread — i.e. a human/manual outbound landed
// within the last few minutes. Fail-direction is SAFE: suppressing an automated closer
// while a person is at the keyboard cannot cause a missed/wrong customer answer (the human
// says what they want); worst case the customer simply doesn't get an extra auto-line. The
// warm closer is preserved for the intended case (customer defers, staff pause without
// having just texted). Single call site (the console-only endpoint), so no both-paths rule.
//
// SECOND suppression reason — no customer turn to acknowledge (Dominic / +17169309966,
// 2026-07-20). Staff hit pause on a thread whose newest customer message was 17 days old
// and had already been answered by a later outbound (a watch alert). The ack fired anyway,
// and `normalizeGotItLeadIn` (conversationStore.ts) rewrote its "Sounds good — " opener off
// that stale inbound's "thanks", so the customer received:
//   "You're welcome. I'll be here when you're ready. If anything changes, just let me know."
// He replied "??" 23 minutes later and a rep had to text "Sorry Dominic, didn't mean to send
// that last text". The warm closer only reads as a closer when it ANSWERS an unanswered
// customer turn; with no such turn it fabricates a conversational frame the customer never
// opened (the fabricated-frame class). Fail-direction is SAFE in the same way: the gate only
// ever withholds a message that answers nothing — it is not on any reply path, writes no
// state, and a staff member is at the keyboard at that exact moment.

interface AckGateMessage {
  direction?: string | null;
  provider?: string | null;
  at?: string | null;
}

interface AckGateConversation {
  messages?: AckGateMessage[] | null;
  manualContext?: { source?: string | null; updatedAt?: string | null } | null;
}

// A staff member is "actively handling" the thread when a human/manual outbound (a rep's
// hand-typed SMS lands with provider "human") happened within this window of the pause.
export const CADENCE_ACK_ACTIVE_HUMAN_WINDOW_MS = 10 * 60 * 1000; // 10 minutes

function parseMs(value?: string | null): number {
  const ms = new Date(String(value ?? "")).getTime();
  return Number.isNaN(ms) ? NaN : ms;
}

/**
 * True when the cadence pause/resume ack text should be SUPPRESSED because a human is
 * actively driving the conversation — a recent manual/human outbound within the window.
 * Deterministic side-effect gate; `nowMs` is injected for testability.
 */
export function shouldSuppressCadenceAck(
  conv: AckGateConversation | null | undefined,
  nowMs: number,
  windowMs: number = CADENCE_ACK_ACTIVE_HUMAN_WINDOW_MS
): boolean {
  if (!conv) return false;

  const recentHumanOutbound = (conv.messages ?? []).some(m => {
    if (m?.direction !== "out" || m?.provider !== "human") return false;
    const atMs = parseMs(m?.at);
    if (Number.isNaN(atMs)) return false;
    return nowMs - atMs >= 0 && nowMs - atMs <= windowMs;
  });
  if (recentHumanOutbound) return true;

  // Secondary signal: a manual-outbound context stamped within the window (covers manual
  // sends that recorded context even if the message row's provider tag differs).
  const mc = conv.manualContext;
  if (mc && String(mc.source ?? "") === "manual_outbound") {
    const mcMs = parseMs(mc.updatedAt);
    if (!Number.isNaN(mcMs) && nowMs - mcMs >= 0 && nowMs - mcMs <= windowMs) return true;
  }

  return false;
}

/**
 * True when the thread has NO unanswered customer turn for the warm closer to acknowledge:
 * the newest inbound is older than our newest outbound, or there is no inbound at all.
 *
 * Compares TIMESTAMPS, never array position — message rows are not guaranteed to be stored
 * in chronological order. Rows with a missing/unparseable `at` are ignored.
 *
 * Deterministic structural predicate over conversation state (no comprehension, no regex).
 */
export function hasNoCustomerTurnToAcknowledge(
  conv: AckGateConversation | null | undefined
): boolean {
  if (!conv) return false;

  let newestInbound = NaN;
  let newestOutbound = NaN;
  for (const m of conv.messages ?? []) {
    const atMs = parseMs(m?.at);
    if (Number.isNaN(atMs)) continue;
    if (m?.direction === "in") {
      if (Number.isNaN(newestInbound) || atMs > newestInbound) newestInbound = atMs;
    } else if (m?.direction === "out") {
      if (Number.isNaN(newestOutbound) || atMs > newestOutbound) newestOutbound = atMs;
    }
  }

  // Nothing we ever sent: an inbound-first thread still has a live customer turn — send.
  if (Number.isNaN(newestOutbound)) return false;
  // We have spoken and the customer never has: nothing to acknowledge — suppress.
  if (Number.isNaN(newestInbound)) return true;
  // Ties fail toward today's behavior (send).
  return newestInbound < newestOutbound;
}

export type CadenceAckSuppressReason = "active_human_thread" | "no_customer_turn";

/**
 * Resolve whether the cadence pause/resume ack should be suppressed, and why.
 * `active_human_thread` takes precedence so the reported reason stays stable for the case
 * the gate originally shipped for. `nowMs` is injected for testability.
 */
export function resolveCadenceAckSuppression(
  conv: AckGateConversation | null | undefined,
  nowMs: number,
  windowMs: number = CADENCE_ACK_ACTIVE_HUMAN_WINDOW_MS
): { suppress: boolean; reason: CadenceAckSuppressReason | null } {
  if (shouldSuppressCadenceAck(conv, nowMs, windowMs)) {
    return { suppress: true, reason: "active_human_thread" };
  }
  if (hasNoCustomerTurnToAcknowledge(conv)) {
    return { suppress: true, reason: "no_customer_turn" };
  }
  return { suppress: false, reason: null };
}
