import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import http from "node:http";
import * as path from "node:path";

/**
 * Worker dispatch eval (docs/worker_queue_extraction.md). No database or
 * running API needed — safe for ci:eval.
 *
 * Covers:
 * - every worker schedule task exists in the API's WORKER_TICK_TASKS registry
 * - schedule shape sanity (unique queues, 5-field cron, timeout budgets)
 * - dispatchTick HTTP contract against a stub API (token header, payload,
 *   per-task failure propagation, missing-token guard)
 * - source-level drift guards: the API wires a dispatch entry for every task,
 *   exposes /internal/worker/tick, and exempts it from session auth
 */

async function main() {
  const { WORKER_SCHEDULES } = await import("../services/worker/src/config.ts");
  const { dispatchTick } = await import("../services/worker/src/tick.ts");
  const { WORKER_TICK_TASKS } = await import("../services/api/src/domain/workerTasks.ts");

  // Registry containment + schedule sanity
  const registry = new Set<string>(WORKER_TICK_TASKS);
  const queues = new Set<string>();
  for (const schedule of WORKER_SCHEDULES) {
    assert.ok(!queues.has(schedule.queue), `duplicate queue ${schedule.queue}`);
    queues.add(schedule.queue);
    assert.equal(schedule.cron.trim().split(/\s+/).length, 5, `cron must be 5 fields: ${schedule.queue}`);
    assert.ok(schedule.tasks.length > 0, `schedule ${schedule.queue} has no tasks`);
    for (const task of schedule.tasks) {
      assert.ok(registry.has(task), `schedule ${schedule.queue} references unknown task '${task}'`);
    }
    assert.ok(schedule.requestTimeoutMs >= 30_000, `timeout too small for ${schedule.queue}`);
  }
  const scheduledTasks = new Set(WORKER_SCHEDULES.flatMap(s => s.tasks));
  for (const task of WORKER_TICK_TASKS) {
    assert.ok(scheduledTasks.has(task), `registry task '${task}' is not on any schedule`);
  }
  console.log(`schedules ok (${WORKER_SCHEDULES.length} queues, ${scheduledTasks.size} tasks)`);

  // HTTP contract against a stub API
  const seen: any[] = [];
  let respondWith: (tasks: string[]) => any = tasks => ({
    ok: true,
    results: tasks.map(task => ({ task, ok: true, ms: 1 }))
  });
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", c => (body += c));
    req.on("end", () => {
      const parsed = JSON.parse(body || "{}");
      seen.push({ url: req.url, token: req.headers["x-worker-token"], body: parsed });
      if (req.headers["x-worker-token"] !== "eval-token") {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(respondWith(parsed.tasks ?? [])));
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as any).port;
  const baseUrl = `http://127.0.0.1:${port}`;
  const schedule = { queue: "tick-eval", tasks: ["follow-ups", "inventory-watch"], requestTimeoutMs: 30_000 };

  const okResult = await dispatchTick(schedule, { baseUrl, token: "eval-token" });
  assert.equal(okResult.ok, true);
  assert.equal(seen[0].url, "/internal/worker/tick");
  assert.equal(seen[0].token, "eval-token");
  assert.deepEqual(seen[0].body.tasks, schedule.tasks);
  assert.equal(seen[0].body.source, "tick-eval");

  respondWith = tasks => ({
    ok: false,
    results: tasks.map((task, i) => ({ task, ok: i === 0, error: i === 0 ? undefined : "boom" }))
  });
  await assert.rejects(
    dispatchTick(schedule, { baseUrl, token: "eval-token" }),
    /task failures/,
    "per-task failure must throw so pg-boss retries"
  );
  await assert.rejects(
    dispatchTick(schedule, { baseUrl, token: "" }),
    /required/,
    "missing token must throw before any request"
  );
  server.close();
  console.log("dispatch http contract ok");

  // Source-level drift guards on the API
  const indexSource = readFileSync(
    path.join(process.cwd(), "services/api/src/index.ts"),
    "utf8"
  );
  for (const task of WORKER_TICK_TASKS) {
    assert.ok(
      indexSource.includes(`"${task}": () =>`),
      `API dispatch map missing entry for '${task}'`
    );
  }
  assert.ok(indexSource.includes('app.post("/internal/worker/tick"'), "tick route missing");
  assert.ok(indexSource.includes('pathname.startsWith("/internal/worker")'), "auth exemption missing");
  assert.ok(indexSource.includes("isWorkerDrivenTicks()"), "WORKER_DRIVEN_TICKS gate missing");
  console.log("api wiring guards ok");

  // CADENCE PARITY (Joe, 2026-07-30) — flipping WORKER_DRIVEN_TICKS=1 must be a NO-OP for
  // customers, not just for coverage. Task-set parity was already checked above; this pins the
  // FREQUENCY too. `photo-delivery` had drifted onto the 5-minute inventory queue while the API
  // ran it every 60s, so the cutover would have quietly made someone who asked to see a bike wait
  // up to 5 minutes instead of 1 — grouped by subject ("photos of a bike") rather than by urgency.
  // A task the API runs every minute must be on an every-minute worker queue.
  const everyMinuteBlock = indexSource.slice(
    indexSource.indexOf("isWorkerDrivenTicks()"),
    indexSource.indexOf("app.get(\"/health\"")
  );
  const apiEveryMinuteTasks = [...everyMinuteBlock.matchAll(/runBackgroundTask\("([\w-]+)"/g)].map(m => m[1]);
  assert.ok(apiEveryMinuteTasks.length > 0, "could not read the API's every-minute tick group");
  const minuteQueueTasks = new Set(
    WORKER_SCHEDULES.filter(s => s.cron.trim() === "* * * * *").flatMap(s => s.tasks)
  );
  for (const task of apiEveryMinuteTasks) {
    assert.ok(
      minuteQueueTasks.has(task),
      `cadence drift: the API runs '${task}' every minute, but no every-minute worker queue schedules it — ` +
        `flipping WORKER_DRIVEN_TICKS would silently slow it down`
    );
  }
  console.log(`cadence parity ok (${apiEveryMinuteTasks.length} every-minute tasks match)`);

  console.log("PASS worker dispatch eval");
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
