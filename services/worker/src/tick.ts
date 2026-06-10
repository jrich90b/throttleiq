import { getWorkerApiBaseUrl, getWorkerInternalToken, type WorkerSchedule } from "./config.js";

export type TickResult = {
  ok: boolean;
  status: number;
  results?: Array<{ task: string; ok: boolean; error?: string }>;
};

/**
 * Dispatch one schedule's tasks to the API. Throws on transport errors,
 * non-2xx responses, and per-task failures so pg-boss retries the job.
 */
export async function dispatchTick(
  schedule: Pick<WorkerSchedule, "queue" | "tasks" | "requestTimeoutMs">,
  opts?: { fetchImpl?: typeof fetch; baseUrl?: string; token?: string }
): Promise<TickResult> {
  const fetchImpl = opts?.fetchImpl ?? fetch;
  const baseUrl = (opts?.baseUrl ?? getWorkerApiBaseUrl()).replace(/\/$/, "");
  const token = opts?.token ?? getWorkerInternalToken();
  if (!token) {
    throw new Error("WORKER_INTERNAL_TOKEN (or AUTOMATION_RUN_WRITE_TOKEN) is required");
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), schedule.requestTimeoutMs);
  try {
    const res = await fetchImpl(`${baseUrl}/internal/worker/tick`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-worker-token": token
      },
      body: JSON.stringify({ source: schedule.queue, tasks: schedule.tasks }),
      signal: controller.signal
    });
    const body = (await res.json().catch(() => ({}))) as Partial<TickResult>;
    if (!res.ok) {
      throw new Error(`tick ${schedule.queue} failed: HTTP ${res.status}`);
    }
    const failed = (body.results ?? []).filter(r => !r.ok);
    if (failed.length) {
      throw new Error(
        `tick ${schedule.queue} task failures: ${failed.map(f => `${f.task}: ${f.error ?? "unknown"}`).join("; ")}`
      );
    }
    return { ok: true, status: res.status, results: body.results };
  } finally {
    clearTimeout(timer);
  }
}
