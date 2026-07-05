/**
 * MDF assistant health sweep — folds MDF portal-runner failures into the unified anomaly feed.
 *
 * MDF runs aren't conversations, so (like watch_fire_miss) this is a SIBLING sweep: it reads the
 * AgentTask store (kind "mdf_portal"), runs findMdfPortalFailures (blocked / stuck-running / fell-back-
 * because-it-didn't-load), and writes OutcomeAnomaly entries with synthetic `mdf:<taskId>` ids that
 * anomaly_loop_detect merges into reports/anomaly_loop/next.json. Deterministic, read-only, no network.
 *
 * Run (on the box, before anomaly_loop_detect):
 *   CONVERSATIONS_DB_PATH=.../data/conversations.json REPORT_ROOT=.../reports npm run mdf_portal_health_sweep
 */
import fs from "node:fs";
import path from "node:path";

// agent_tasks.json lives in the same data dir as the conversation store (AGENT_TASKS_PATH overrides).
const dbPath = path.resolve(process.env.CONVERSATIONS_DB_PATH || "data/conversations.json");
const tasksPath = path.resolve(
  process.env.AGENT_TASKS_PATH || path.join(path.dirname(dbPath), "agent_tasks.json")
);

let tasks: any[] = [];
try {
  const raw = JSON.parse(fs.readFileSync(tasksPath, "utf8"));
  tasks = Array.isArray(raw) ? raw : Array.isArray(raw?.tasks) ? raw.tasks : Object.values(raw ?? {});
} catch {
  tasks = []; // missing store → 0 failures (safe; never breaks the loop)
}

const { findMdfPortalFailures } = await import("../services/api/src/domain/mdfPortalHealth.ts");
const anomalies = findMdfPortalFailures({
  tasks,
  windowDays: Number(process.env.MDF_HEALTH_WINDOW_DAYS ?? 7),
  stuckMinutes: Number(process.env.MDF_HEALTH_STUCK_MINUTES ?? 30)
});

const mdfCount = tasks.filter(t => String(t?.kind ?? "") === "mdf_portal").length;
const reportRoot = process.env.REPORT_ROOT || path.resolve("reports");
const outDir = path.join(reportRoot, "mdf_health");
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(
  path.join(outDir, "latest.json"),
  JSON.stringify(
    { generatedAt: new Date().toISOString(), source: tasksPath, summary: { mdfTasks: mdfCount, failures: anomalies.length }, anomalies },
    null,
    2
  )
);

console.log(`MDF assistant health sweep — ${mdfCount} mdf_portal task(s), ${anomalies.length} active failure(s)`);
for (const a of anomalies.slice(0, 25)) console.log(`   - [${a.severity}] ${a.dimension} ${a.convId} | ${a.detail}`);
console.log(`\nFeed written: ${path.join(outDir, "latest.json")}`);
