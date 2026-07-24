/**
 * Per-CONVERSATION daily watch-alert cap + pending-bundle queue (Joe ruling 2026-07-23).
 *
 * The watch-fire cooldown was per-WATCH only, so a customer with several watches got several
 * alert texts in one day — MD (+19292685345) set up 8 watches from one call and received 2 texts
 * on 7/22 and 3 more on 7/23, two of them minutes apart. Joe's ruling: max ONE watch-alert text
 * per customer per day; multiple same-day matches bundle into a single message; the remainder
 * queues and goes out (bundled) the next day.
 *
 * Bucket: SIDE-EFFECT guard (deterministic by design — this throttles a send, it reads no
 * customer language). Fail direction: HOLD BACK — the worst case is a delayed alert; the queue +
 * the group-aware watch_fire_miss detector are the recovery net. It can never produce an extra
 * or wrong send.
 *
 * Pure helpers only — the engine (index.ts) owns the send side effects. Pinned by
 * watch_alert_daily_cap:eval.
 */
import type { PendingWatchAlert } from "./conversationStore.js";
import { collectInventoryWatches } from "./conversationStore.js";

/** One alert text per conversation per rolling day. */
export const WATCH_ALERT_DAILY_CAP_MS = 24 * 60 * 60 * 1000;

/**
 * A queued alert older than this is dropped at delivery time instead of sent — after days in the
 * queue "just came in" would be a lie and the unit's status is stale. The availability recheck at
 * delivery (still in feed, not hold/sold) is the primary honesty gate; this is the backstop.
 */
export const PENDING_WATCH_ALERT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Hard cap on queued alerts per conversation (dedup should keep it far below this). */
export const PENDING_WATCH_ALERT_MAX = 12;

/**
 * The most recent watch-alert moment for the CONVERSATION. Unions the conversation-level stamp
 * with every watch's own lastNotifiedAt so the cap works retroactively for conversations whose
 * alerts predate the conv-level field (MD's watches carry only per-watch stamps) — no migration
 * needed.
 */
export function lastConversationWatchAlertMs(conv: any): number | null {
  let latest: number | null = null;
  const consider = (value: unknown) => {
    if (!value) return;
    const ms = new Date(String(value)).getTime();
    if (!Number.isFinite(ms)) return;
    if (latest == null || ms > latest) latest = ms;
  };
  consider(conv?.lastWatchAlertAt);
  for (const w of collectInventoryWatches(conv)) consider(w?.lastNotifiedAt);
  return latest;
}

/** True while the conversation is inside its daily watch-alert window — no further alert text today. */
export function conversationWatchAlertBlocked(conv: any, nowMs: number): boolean {
  const last = lastConversationWatchAlertMs(conv);
  return last != null && nowMs - last < WATCH_ALERT_DAILY_CAP_MS;
}

/** Stamp the conversation-level "we sent a watch-alert text" moment. Call on EVERY alert send. */
export function recordConversationWatchAlert(conv: any, nowIso: string): void {
  conv.lastWatchAlertAt = nowIso;
}

/** Identity for dedup: stockId, else VIN, else model+year. */
export function pendingWatchAlertKey(entry: Pick<PendingWatchAlert, "stockId" | "vin" | "model" | "year">): string {
  const stockId = String(entry?.stockId ?? "").trim().toLowerCase();
  if (stockId) return `stock:${stockId}`;
  const vin = String(entry?.vin ?? "").trim().toLowerCase();
  if (vin) return `vin:${vin}`;
  return `model:${String(entry?.model ?? "").trim().toLowerCase()}:${String(entry?.year ?? "").trim()}`;
}

export type QueuePendingWatchAlertResult = "queued" | "duplicate" | "capped";

/**
 * Queue a capped-off match for next-day bundled delivery. Dedupes on unit identity (the same
 * arrival re-matching on every 5-minute sweep must queue once), and hard-caps the queue length.
 */
export function queuePendingWatchAlert(conv: any, entry: PendingWatchAlert): QueuePendingWatchAlertResult {
  const queue: PendingWatchAlert[] = Array.isArray(conv.pendingWatchAlerts) ? conv.pendingWatchAlerts : [];
  const key = pendingWatchAlertKey(entry);
  if (queue.some(existing => pendingWatchAlertKey(existing) === key)) return "duplicate";
  if (queue.length >= PENDING_WATCH_ALERT_MAX) return "capped";
  queue.push(entry);
  conv.pendingWatchAlerts = queue;
  return "queued";
}

/**
 * Drain the queue for delivery. Returns [] (and leaves the queue untouched) while the daily cap
 * is still in effect; once the window has expired it removes and returns every non-expired entry
 * (expired ones are silently dropped — TTL backstop). The caller must still recheck availability
 * per entry and stamp recordConversationWatchAlert on the actual send.
 */
export function takeDuePendingWatchAlerts(conv: any, nowMs: number): PendingWatchAlert[] {
  const queue: PendingWatchAlert[] = Array.isArray(conv.pendingWatchAlerts) ? conv.pendingWatchAlerts : [];
  if (!queue.length) return [];
  if (conversationWatchAlertBlocked(conv, nowMs)) return [];
  const fresh = queue.filter(entry => {
    const queuedMs = new Date(String(entry?.queuedAt ?? "")).getTime();
    return Number.isFinite(queuedMs) && nowMs - queuedMs <= PENDING_WATCH_ALERT_TTL_MS;
  });
  conv.pendingWatchAlerts = [];
  return fresh;
}

/** True when the conversation has queued watch alerts (used to keep the flush sweep cheap). */
export function hasPendingWatchAlerts(conv: any): boolean {
  return Array.isArray(conv?.pendingWatchAlerts) && conv.pendingWatchAlerts.length > 0;
}
