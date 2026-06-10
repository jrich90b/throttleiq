/**
 * Worker dispatch schedules (docs/worker_queue_extraction.md).
 *
 * Each schedule is a pg-boss cron queue whose handler POSTs the listed task
 * names to the API's /internal/worker/tick endpoint. Task names must exist
 * in WORKER_TICK_TASKS (services/api/src/domain/workerTasks.ts) — the
 * worker_dispatch eval enforces that.
 *
 * This module must stay import-safe with no environment requirements:
 * evals import it without a database or a running API.
 */

export type WorkerSchedule = {
  queue: string;
  /** 5-field cron, evaluated in WORKER_TZ (default America/New_York). */
  cron: string;
  tasks: string[];
  /** Abort the API call if it exceeds this budget. */
  requestTimeoutMs: number;
};

export const WORKER_SCHEDULES: WorkerSchedule[] = [
  {
    queue: "tick-followups",
    cron: "* * * * *",
    tasks: ["follow-ups", "appt-confirm", "staff-appt-notify", "appt-questions"],
    requestTimeoutMs: 5 * 60_000
  },
  {
    queue: "tick-inventory",
    cron: "*/5 * * * *",
    tasks: ["inventory-watch", "inventory-holds"],
    requestTimeoutMs: 10 * 60_000
  }
];

export function getWorkerApiBaseUrl(): string {
  return (process.env.WORKER_API_BASE_URL ?? "http://127.0.0.1:3001").trim().replace(/\/$/, "");
}

export function getWorkerInternalToken(): string {
  return String(
    process.env.WORKER_INTERNAL_TOKEN ?? process.env.AUTOMATION_RUN_WRITE_TOKEN ?? ""
  ).trim();
}
