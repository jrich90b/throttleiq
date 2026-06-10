import "dotenv/config";
import { PgBoss, type Job } from "pg-boss";
import { WORKER_SCHEDULES, getWorkerApiBaseUrl, getWorkerInternalToken } from "./config.js";
import { dispatchTick } from "./tick.js";

/**
 * LeadRider dispatcher worker (docs/worker_queue_extraction.md).
 *
 * Durable scheduling on pg-boss (Postgres) replacing the API's in-process
 * setInterval ticks. The worker holds no domain state and never touches the
 * conversation store: each job POSTs task names to the API's
 * /internal/worker/tick endpoint, preserving the single-writer invariant.
 *
 * Enablement requires the API process to run with WORKER_DRIVEN_TICKS=1 so
 * ticks are not executed twice. Until then this process can run idle-safe:
 * dispatched ticks are idempotent (the API keeps its overlap locks), just
 * redundant.
 */

function resolveSsl(): { rejectUnauthorized: boolean } | undefined {
  const raw = String(process.env.PG_SSL ?? "").trim();
  if (raw === "1" || raw.toLowerCase() === "true") return { rejectUnauthorized: false };
  return undefined;
}

async function main() {
  const connectionString = (process.env.WORKER_DATABASE_URL ?? process.env.DATABASE_URL ?? "").trim();
  if (!connectionString) {
    console.error("[worker] DATABASE_URL (or WORKER_DATABASE_URL) is required");
    process.exit(1);
  }
  if (!getWorkerInternalToken()) {
    console.error("[worker] WORKER_INTERNAL_TOKEN (or AUTOMATION_RUN_WRITE_TOKEN) is required");
    process.exit(1);
  }
  const timezone = (process.env.WORKER_TZ ?? "America/New_York").trim();

  const boss = new PgBoss({
    connectionString,
    ssl: resolveSsl(),
    schema: process.env.PGBOSS_SCHEMA ?? "pgboss",
    max: Number(process.env.WORKER_PG_POOL_MAX ?? 3)
  });
  boss.on("error", (err: unknown) =>
    console.error("[worker] pg-boss error:", (err as any)?.message ?? err)
  );

  await boss.start();
  console.log(`[worker] started api=${getWorkerApiBaseUrl()} tz=${timezone}`);

  for (const schedule of WORKER_SCHEDULES) {
    await boss.createQueue(schedule.queue, {
      retryLimit: Number(process.env.WORKER_RETRY_LIMIT ?? 2),
      retryDelay: Number(process.env.WORKER_RETRY_DELAY_SECONDS ?? 30),
      expireInSeconds: Math.max(60, Math.ceil(schedule.requestTimeoutMs / 1000) + 60)
    });
    await boss.schedule(schedule.queue, schedule.cron, { tasks: schedule.tasks }, { tz: timezone });
    await boss.work(schedule.queue, { pollingIntervalSeconds: 10 }, async (jobs: Job[]) => {
      for (const job of jobs) {
        const startedAt = Date.now();
        await dispatchTick(schedule);
        console.log(
          `[worker] ${schedule.queue} ok in ${Date.now() - startedAt}ms (job=${job.id})`
        );
      }
    });
    console.log(
      `[worker] scheduled ${schedule.queue} cron="${schedule.cron}" tasks=[${schedule.tasks.join(",")}]`
    );
  }

  const shutdown = async (signal: string) => {
    console.log(`[worker] ${signal} received; stopping`);
    try {
      await boss.stop({ graceful: true, timeout: 15_000 });
    } catch (err: any) {
      console.warn("[worker] stop error:", err?.message ?? err);
    }
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch(err => {
  console.error("[worker] fatal:", err?.message ?? err);
  process.exit(1);
});
