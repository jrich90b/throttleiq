/**
 * Background-task registry shared between the API and services/worker
 * (docs/worker_queue_extraction.md).
 *
 * The worker never executes domain logic itself; it dispatches these task
 * names to POST /internal/worker/tick, and the API runs the matching
 * functions in-process so the single-writer invariant on the conversation
 * store holds. Adding a task here requires wiring its function into the
 * dispatch map in services/api/src/index.ts.
 */

export const WORKER_TICK_TASKS = [
  "follow-ups",
  "appt-confirm",
  "staff-appt-notify",
  "appt-questions",
  "inventory-watch",
  "inventory-holds",
  "task-escalations",
  "staff-task-digests",
  "gate-blocker-digest",
  "photo-delivery",
  "turn-tripwire",
  "claude-draft-review"
] as const;

export type WorkerTickTask = (typeof WORKER_TICK_TASKS)[number];

/**
 * The MINUTE lane, in ONE place. Until 2026-08-14 this list was hand-mirrored between the
 * worker's schedule (services/worker/src/config.ts) and the API's in-process setInterval
 * (index.ts) — the exact two-copies drift the worker cutover doc warns about. Both sides now
 * read this. "turn-tripwire" (Joe's per-message tripwire ruling, 8/14) joins the minute lane:
 * its window opens at 10 minutes, so minute granularity keeps detection ~1 min after eligibility.
 */
export const WORKER_MINUTE_LANE_TASKS: readonly WorkerTickTask[] = [
  "follow-ups",
  "appt-confirm",
  "staff-appt-notify",
  "appt-questions",
  "task-escalations",
  "staff-task-digests",
  "gate-blocker-digest",
  "photo-delivery",
  "turn-tripwire",
  // Joe's instant second opinion (2026-08-14 late): Claude reviews each new pending draft within
  // ~60s and supersedes clearly-wrong ones in the approval box. Minute lane so "fix a draft"
  // never waits half an hour.
  "claude-draft-review"
];

export function isWorkerTickTask(value: unknown): value is WorkerTickTask {
  return (WORKER_TICK_TASKS as readonly string[]).includes(String(value ?? ""));
}

/**
 * When WORKER_DRIVEN_TICKS=1, the API stops running its own background
 * setInterval ticks and relies on the worker's pg-boss schedules hitting
 * /internal/worker/tick. Default (unset) keeps today's in-process intervals.
 */
export function isWorkerDrivenTicks(): boolean {
  return String(process.env.WORKER_DRIVEN_TICKS ?? "").trim() === "1";
}
