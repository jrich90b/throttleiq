// Morning digest — the once-a-day "here's your day" popup for salespeople
// (Joe, 2026-07-14). Pure, deterministic helpers so the show/don't-show rule and
// the task ordering are pinned by morning_digest:eval, not left to the component.
//
// The digest LISTS tasks and offers call/message shortcuts; it deliberately has
// no bulk "mark all done" — completion detection belongs to the task-fulfillment
// auto-close engine (the agent notices the rep actually did the task, anywhere,
// and closes it). Fail-direction of a digest bug is cosmetic: worst case the
// popup shows twice or not at all — it never touches task state or a customer.

import { dueBucketFor, dueBucketRank, isStaleOverdueTask, taskEffectiveDueMs, type DueBucket } from "./taskTriage";
import { salesCriticalKind } from "./taskReason";

/** Local calendar-day key ("2026-07-14") — the digest shows at most once per key. */
export function morningDigestDayKey(nowMs: number): string {
  const d = new Date(nowMs);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

export const MORNING_DIGEST_START_HOUR = 6;

/**
 * Show the digest when it's a working hour (>= startHour local — a 2am login
 * shouldn't burn the day's one showing before the morning), there is at least
 * one open task to show, and it hasn't already been shown today (lastShownDayKey
 * is the persisted key from the previous showing; null/mismatch = not yet today).
 */
export function shouldShowMorningDigest(args: {
  nowMs: number;
  lastShownDayKey: string | null | undefined;
  openTaskCount: number;
  startHour?: number;
}): boolean {
  const startHour = args.startHour ?? MORNING_DIGEST_START_HOUR;
  if (!Number.isFinite(args.nowMs)) return false;
  if ((args.openTaskCount ?? 0) <= 0) return false;
  if (new Date(args.nowMs).getHours() < startHour) return false;
  return String(args.lastShownDayKey ?? "") !== morningDigestDayKey(args.nowMs);
}

export type DigestGroup = { bucket: DueBucket; tasks: any[]; stale?: boolean };

/**
 * Order tasks for the digest: urgency bucket first (overdue → today → this week
 * → later → no date), money tasks (pricing/financing/availability) rise within a
 * bucket, then earliest due time. Empty buckets are omitted. Same ranking rules
 * as the Task Inbox so the two surfaces never disagree about what's urgent.
 */
export function groupTasksForDigest(todos: any[], nowMs: number): DigestGroup[] {
  const groups = new Map<DueBucket, any[]>();
  // Stale demotion (Phase 2): overdue >14d re-surfaced at the TOP of the digest every single
  // morning with no way to act on it from the popup (UX audit 7/22) — the same item greeting
  // the rep daily reads as noise and trains them to ignore the digest. Stale items still show,
  // but in a trailing "worth a review" group instead of leading the day.
  const staleTasks: any[] = [];
  for (const t of todos ?? []) {
    if (isStaleOverdueTask(t, nowMs)) {
      staleTasks.push(t);
      continue;
    }
    const bucket = dueBucketFor(t, nowMs);
    let list = groups.get(bucket);
    if (!list) {
      list = [];
      groups.set(bucket, list);
    }
    list.push(t);
  }
  const ordered: DigestGroup[] = [];
  for (const [bucket, tasks] of groups.entries()) {
    tasks.sort((a, b) => {
      const critA = salesCriticalKind(a) != null;
      const critB = salesCriticalKind(b) != null;
      if (critA !== critB) return critA ? -1 : 1;
      const da = taskEffectiveDueMs(a);
      const db = taskEffectiveDueMs(b);
      if (da != null && db != null && da !== db) return da - db;
      if (da == null && db != null) return 1;
      if (da != null && db == null) return -1;
      return 0;
    });
    ordered.push({ bucket, tasks });
  }
  ordered.sort((a, b) => dueBucketRank(a.bucket) - dueBucketRank(b.bucket));
  if (staleTasks.length) {
    staleTasks.sort((a, b) => (taskEffectiveDueMs(b) ?? 0) - (taskEffectiveDueMs(a) ?? 0)); // least-ancient first
    ordered.push({ bucket: "overdue", stale: true, tasks: staleTasks });
  }
  return ordered;
}

/** "3 need you today" — overdue + due-today count for the digest header. */
export function digestAttentionCount(todos: any[], nowMs: number): number {
  let n = 0;
  for (const t of todos ?? []) {
    // A stale-overdue item is a review candidate, not one of today's "N need you today" —
    // counting it forever inflated the header and dulled the number's meaning.
    if (isStaleOverdueTask(t, nowMs)) continue;
    const bucket = dueBucketFor(t, nowMs);
    if (bucket === "overdue" || bucket === "today") n += 1;
  }
  return n;
}

export type MorningDigestUiEvent = "dismiss" | "act" | "reopen";
export type MorningDigestUiState = { open: boolean; minimized: boolean; writeDayKey: boolean };

/**
 * What closing/reopening the digest does (Joe, 2026-07-14: "when you hit message
 * or call does it disappear and you won't see it again?" — it must NOT).
 *
 *  - "act" (Call/Message on a task): close the popup so the rep can work the
 *    conversation, but do NOT write the shown-today key — a floating reopen pill
 *    stays up so the remaining tasks are one click away all day.
 *  - "dismiss" (X / "Got it" / jumping to the full Task Inbox): done for the day —
 *    write the day key, no pill, the digest returns tomorrow morning.
 *  - "reopen" (the pill): bring the popup back, still without burning the day.
 */
export function nextMorningDigestUiState(event: MorningDigestUiEvent): MorningDigestUiState {
  switch (event) {
    case "act":
      return { open: false, minimized: true, writeDayKey: false };
    case "reopen":
      return { open: true, minimized: false, writeDayKey: false };
    default:
      return { open: false, minimized: false, writeDayKey: true };
  }
}
