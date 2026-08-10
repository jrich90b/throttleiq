// Unanswered inventory-watch alerts: stop texting, raise a person.
//
// Joseph (+17163308822) asked on 2026-05-05 to be told when a 2026 Road Glide landed, and then
// never wrote again. We kept our promise four more times — 05-07, 06-05, 07-03, 07-23 — each on a
// genuinely different arriving unit, each once, each inside the one-alert-per-day cap. Every
// individual send was correct; the SEQUENCE is what reads wrong. Nothing in the watch engine has
// ever asked "is anyone still on the other end of this?"
//
// The existing suppression stack is all EXPLICIT: the customer opted out (isInventoryWatchOptedOut),
// the number is suppressed (isSuppressed), the lead is held or paused (isProactiveContactPaused), or
// the same unit was already messaged (hasPriorInventoryWatchOutboundForItem). Silence is not any of
// those, so silence never stops us.
//
// This module supplies the missing read: how many watch alerts have we DELIVERED since the customer
// last said anything at all? At the limit the watches pause and a staff task is raised instead of a
// further text — the alert is not dropped, it changes hands.
//
// Two deliberate choices, both fail-direction:
//
// 1. DELIVERED, never drafted. Production runs in suggest mode, so a watch alert is written as a
//    `draft_ai` row that staff approve. A draft nobody approved never reached the customer, so it
//    cannot be evidence that they ignored us — counting it would mute someone we never actually
//    contacted. Only rows that really went out count (REAL delivery providers, not `stale`, not
//    `deliveredToCustomer === false`). This is the same distinction that makes a `draftStatus:
//    "stale"` row invisible to the watch dedupe in inventoryWatchDedup.ts.
//
// 2. Our OWN copy, matched exactly. The marker is the opt-off tail every watch-alert builder emits
//    (buildWatchAvailableReply / buildCholoWatchAvailableReply / buildWatchAvailableBundleReply),
//    plus the "you were watching for" claim those same builders make. This is structured detection
//    of a template WE generated, never a read of anything a customer wrote. It is deliberately
//    narrow: a looser shape ("good news" + "in stock") also matches an ordinary availability answer
//    to a customer's own question, which would pause a watch on a message that was never an alert.
//    The cost of the narrow marker is that watch alerts written in the pre-July copy (which said
//    "we just got X in stock" and carried neither phrase) do not count — measured on the live store
//    2026-08-10, that is 2 of Joseph's 4. Under-counting keeps the current behaviour; over-counting
//    would silence a customer on the strength of a message that was not an alert.
//
// watch_alert_unanswered_pause:eval pins both the counting rule and the fact that every builder's
// output still carries the marker, so a copy edit breaks the eval rather than silently blinding the
// detector.
//
// This module stays IMPORT-FREE on purpose: importing conversationStore would create the JSON store
// as a side effect of loading it, which would make the eval a shared-file barrier in the gate chain.
// The side-effecting half (applyUnansweredWatchAlertPause) therefore lives in conversationStore.ts,
// beside pauseInventoryWatches/addTodo, and calls decideUnansweredWatchAlertPause from here.

export const WATCH_ALERT_OPT_OFF_MARKER = "take you off the list";

// The availability claim shared by the single, bundle and cholo builders. Kept alongside the tail so
// an alert that predates the current tail wording is still recognised.
export const WATCH_ALERT_WATCHING_FOR_MARKER = "you were watching for";

// Providers that mean the text actually left the building. `draft_ai` is deliberately absent: it is
// a proposal awaiting staff approval, not a delivery.
const DELIVERED_PROVIDERS = new Set(["twilio", "sendgrid", "human"]);

export const DEFAULT_UNANSWERED_WATCH_ALERT_LIMIT = 3;

export type WatchAlertPauseMessage = {
  direction?: string | null;
  provider?: string | null;
  body?: string | null;
  at?: string | null;
  draftStatus?: string | null;
  deliveredToCustomer?: boolean | null;
};

export type WatchAlertPauseConversation = {
  messages?: WatchAlertPauseMessage[] | null;
};

/**
 * The close-out's own marker (buildUnansweredWatchCloseOutReply, agentVoice.ts). Two jobs: it keeps
 * the close-out from being counted as one more ignored ALERT, and it is how we know the close-out
 * has already gone, so it can never be sent twice.
 */
export const WATCH_CLOSE_OUT_MARKER = "pause those alerts for now";

export function isInventoryWatchCloseOutBody(body: unknown): boolean {
  const normalized = String(body ?? "").toLowerCase().replace(/\s+/g, " ");
  if (!normalized) return false;
  return normalized.includes(WATCH_CLOSE_OUT_MARKER);
}

export function isInventoryWatchAlertBody(body: unknown): boolean {
  const normalized = String(body ?? "").toLowerCase().replace(/\s+/g, " ");
  if (!normalized) return false;
  // The close-out is OUR sign-off, not an alert. Counting it would let the goodbye text itself
  // extend the unanswered run, and on a lead that never writes back it would read as a 4th alert.
  if (normalized.includes(WATCH_CLOSE_OUT_MARKER)) return false;
  return normalized.includes(WATCH_ALERT_OPT_OFF_MARKER) || normalized.includes(WATCH_ALERT_WATCHING_FOR_MARKER);
}

/** Has the close-out already gone out on this thread (delivered, or still awaiting approval)? */
export function hasSentWatchCloseOut(conv: WatchAlertPauseConversation): boolean {
  for (const message of conv?.messages ?? []) {
    if (message?.direction !== "out") continue;
    if (String(message?.draftStatus ?? "").toLowerCase() === "stale") continue;
    if (isInventoryWatchCloseOutBody(message.body)) return true;
  }
  return false;
}

function isDeliveredOutbound(message: WatchAlertPauseMessage): boolean {
  if (message?.direction !== "out") return false;
  if (String(message?.draftStatus ?? "").toLowerCase() === "stale") return false;
  if (message?.deliveredToCustomer === false) return false;
  return DELIVERED_PROVIDERS.has(String(message?.provider ?? "").toLowerCase().trim());
}

// The timestamp of the customer's last inbound message, or "" when they have never written (an
// ADF/web lead we opened the conversation on). "" sorts before every ISO date, so on such a lead
// every delivered alert counts — which is right: they have never answered anything.
export function lastInboundAt(conv: WatchAlertPauseConversation): string {
  let latest = "";
  for (const message of conv?.messages ?? []) {
    if (message?.direction !== "in") continue;
    const at = String(message?.at ?? "");
    if (at && at > latest) latest = at;
  }
  return latest;
}

/**
 * How many watch alerts have we delivered since the customer last said anything?
 */
export function countUnansweredDeliveredWatchAlerts(conv: WatchAlertPauseConversation): number {
  const messages = Array.isArray(conv?.messages) ? conv.messages : [];
  if (!messages.length) return 0;
  const since = lastInboundAt(conv);
  let count = 0;
  for (const message of messages) {
    if (!isDeliveredOutbound(message)) continue;
    if (!isInventoryWatchAlertBody(message.body)) continue;
    if (String(message.at ?? "") <= since) continue;
    count += 1;
  }
  return count;
}

export function unansweredWatchAlertLimit(env?: Record<string, string | undefined>): number {
  const raw = Number((env ?? process.env).WATCH_UNANSWERED_ALERT_PAUSE_LIMIT);
  if (!Number.isFinite(raw) || raw < 1) return DEFAULT_UNANSWERED_WATCH_ALERT_LIMIT;
  return Math.floor(raw);
}

export type UnansweredWatchAlertDecision = {
  /** True once the delivered-and-unanswered run has reached the limit: pause, do not text again. */
  pause: boolean;
  delivered: number;
  limit: number;
  /** Staff-task copy — states the count and the date we last heard from them. */
  summary: string;
};

/**
 * PURE. Decides whether this conversation's watches have run out of answers.
 *
 * Fail direction: the only thing this can do is STOP an outbound text and hand the lead to a person.
 * It can never cause a send, and it never touches a watch that has already been answered — one
 * inbound message of any kind resets the run to zero, because `since` moves with it.
 */
export function decideUnansweredWatchAlertPause(
  conv: WatchAlertPauseConversation,
  opts?: { limit?: number }
): UnansweredWatchAlertDecision {
  const limit = opts?.limit ?? unansweredWatchAlertLimit();
  const delivered = countUnansweredDeliveredWatchAlerts(conv);
  const since = lastInboundAt(conv);
  const heard = since ? since.slice(0, 10) : "never";
  return {
    pause: delivered >= limit,
    delivered,
    limit,
    summary:
      `Inventory watch paused — ${delivered} alerts sent with no reply (last heard from them: ${heard}). ` +
      "Give them a call or close the watch out; texting again is off the table until they answer."
  };
}
