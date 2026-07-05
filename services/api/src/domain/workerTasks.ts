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
  "gate-blocker-digest"
] as const;

export type WorkerTickTask = (typeof WORKER_TICK_TASKS)[number];

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
