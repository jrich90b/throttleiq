/**
 * Weekly stale-task digest for the manager (Joe ruling 2026-07-31: "Weekly to manager").
 *
 * THE GAP THIS CLOSES. The manager escalation ping (taskEscalation.ts) watches a task for its
 * first 48 hours and texts ONCE — `resolveEscalationCandidates` skips anything carrying
 * `escalatedAt` and anything older than `lookbackHours` (48). After two days a task is invisible
 * to every push notification the system has. Measured on the live store 2026-07-31: 30 of 41 open
 * tasks (73%) were past that window — 25 had already spent their single ping, 5 never got one —
 * while historically 580 of 1,901 cleared tasks (31%) took LONGER than 48h to clear (median 6.9
 * days, p90 28 days). A third of the real work happens after the system stops asking. The oldest
 * open task was 34 days ("Follow up with Nico — handed off, sell my bike review").
 *
 * SCOPE — the salesperson side is deliberately NOT here. Joe (2026-07-31): "there is a morning
 * window that pops up with inclosed tasks". `apps/web/src/app/lib/morningDigest.ts` already shows
 * each rep their open tasks once per day at login, urgency-grouped, with >14d-overdue items
 * demoted to a trailing group so the same card can't nag every morning. A daily rep SMS would
 * duplicate a better surface and is exactly the alert fatigue that makes digests get ignored. What
 * has no surface is the MANAGER's aggregate view of the backlog — that is all this adds.
 *
 * SURFACING ONLY. Nothing here closes, reassigns, or silences a task. The fail direction on a
 * stalled lead must be "someone is told", never "it quietly disappears" — which is also why Joe
 * declined auto-closing cold handoffs. The hourly urgent ping is untouched.
 *
 * Pure so the selection, the send window, and the copy are eval-pinned without a clock, a phone,
 * or the API. The runner in index.ts owns clock resolution, manager lookup, SMS, and the durable
 * already-sent marker.
 */
import type { TodoTask } from "./conversationStore.js";
import { isClockWithinBusinessHours, type BusinessClock } from "./taskEscalation.js";

/** A task open longer than this belongs in the weekly digest. */
export const STALE_TASK_DAYS = 7;

/** Cap per message so an SMS stays readable; the head line always states the true total. */
export const MAX_DIGEST_LINES = 8;

const DAY_MS = 24 * 60 * 60 * 1000;

export type DigestCandidate = { todo: TodoTask; ageDays: number };

/**
 * Everything open past the stale threshold, oldest first, regardless of owner — INCLUDING
 * unassigned tasks, which belong to no rep's morning window by construction.
 */
export function selectStaleTasks(
  todos: readonly TodoTask[] | null | undefined,
  nowMs: number,
  opts?: { staleDays?: number }
): DigestCandidate[] {
  const staleDays = Math.max(1, Math.floor(opts?.staleDays ?? STALE_TASK_DAYS));
  const out: DigestCandidate[] = [];
  for (const todo of todos ?? []) {
    if (!todo || todo.status !== "open") continue;
    // Same carve-out the escalation ping makes: an internal `note` is an informational card on the
    // conversation, not a job someone owes. Including them pads the digest with reading material.
    if (String(todo.reason ?? "") === "note") continue;
    const createdMs = Date.parse(String(todo.createdAt ?? ""));
    if (!Number.isFinite(createdMs)) continue;
    const ageDays = Math.floor((nowMs - createdMs) / DAY_MS);
    if (ageDays < staleDays) continue;
    out.push({ todo, ageDays });
  }
  out.sort((a, b) => b.ageDays - a.ageDays);
  return out;
}

/**
 * Fire once per period, at or after opening, on a day the dealership is actually open.
 *
 * `lastSentKey` is the period key the runner durably recorded. Fail-direction: an UNKNOWN key
 * SENDS — a duplicate weekly list is a nuisance, a silently skipped week is the exact failure this
 * module exists to fix.
 */
export function shouldSendDigestNow(args: {
  clock: BusinessClock;
  periodKey: string;
  lastSentKey?: string | null;
}): boolean {
  if (!args.periodKey) return false;
  if (!isClockWithinBusinessHours(args.clock)) return false;
  return String(args.lastSentKey ?? "").trim() !== args.periodKey;
}

/** Local calendar day, e.g. "2026-07-31". Sending on one weekday makes this the week key too. */
export function localDayKey(parts: { year: number; month: number; day: number }): string {
  return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

function ageLabel(days: number): string {
  return days === 1 ? "1 day" : `${days} days`;
}

/**
 * The manager's Monday backlog — the tasks the hourly ping stopped watching days ago. Age leads
 * each line because age IS the finding; owner follows so the next question ("who has this?") is
 * answered without opening the console.
 */
export function buildStaleTaskDigest(
  candidates: DigestCandidate[],
  leadNameByConvId: Map<string, string>,
  staleDays: number = STALE_TASK_DAYS
): string {
  if (!candidates.length) return "";
  const head =
    candidates.length === 1
      ? `LeadRider weekly: 1 task has been open more than ${staleDays} days:`
      : `LeadRider weekly: ${candidates.length} tasks have been open more than ${staleDays} days:`;
  const shown = candidates.slice(0, MAX_DIGEST_LINES);
  const lines = shown.map(c => {
    const name =
      String(leadNameByConvId.get(String(c.todo.convId)) ?? "").trim() ||
      String(c.todo.leadKey ?? c.todo.convId ?? "").trim() ||
      "Lead";
    const owner = String((c.todo as any).ownerName ?? "").trim() || "unassigned";
    const summary = String(c.todo.summary ?? "").replace(/\s+/g, " ").trim().slice(0, 64);
    return `• ${name} (${ageLabel(c.ageDays)}, ${owner}): ${summary}`;
  });
  const more = candidates.length - shown.length;
  if (more > 0) lines.push(`• …and ${more} more in the console.`);
  return [head, ...lines].join("\n");
}
