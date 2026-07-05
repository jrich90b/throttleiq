/**
 * Ops-anomaly loop sweep — feeds the operator "Report issue" reports (opsAnomalyStore, the dashboard
 * button reps already use) into the self-healing loop. Reads ops_anomalies.json, maps each AGENT-BEHAVIOR
 * report into a `reported_issue` OutcomeAnomaly via decideOpsAnomalyReportedIssue, and writes the sibling
 * feed anomaly_loop_detect merges:
 *   reports/ops_anomaly/latest.json
 *
 * Only routing/cadence/appointment/task_inbox/handoff/other cross (the loop's only tool is an agent-behavior
 * code fix); tone (covered by 👎 + the voice layer) and the infra types (inventory/integration/ui) stay in
 * the existing support-ticket lane, untouched. Read-only; this only ADDS the code-loop feed.
 *
 * Run (on the box, against a dealer store):
 *   OPS_ANOMALIES_PATH=/home/ubuntu/leadrider-runtime/americanharley/data/ops_anomalies.json \
 *   REPORT_ROOT=/home/ubuntu/leadrider-runtime/americanharley/reports \
 *   npx tsx scripts/ops_anomaly_loop_sweep.ts
 */
import fs from "node:fs";
import path from "node:path";

const { decideOpsAnomalyReportedIssue } = await import("../services/api/src/domain/conversationOutcomeAudit.ts");

const storePath =
  process.env.OPS_ANOMALIES_PATH ||
  (process.env.DATA_DIR
    ? path.join(process.env.DATA_DIR, "ops_anomalies.json")
    : path.resolve("services/api/data/ops_anomalies.json"));
const reportRoot = process.env.REPORT_ROOT || path.resolve("reports");
const outDir = path.join(reportRoot, "ops_anomaly");

let rows: any[] = [];
try {
  const raw = JSON.parse(fs.readFileSync(storePath, "utf8"));
  rows = Array.isArray(raw) ? raw : Array.isArray(raw?.anomalies) ? raw.anomalies : Array.isArray(raw?.rows) ? raw.rows : [];
} catch {
  rows = []; // missing/malformed store must never break the loop
}

const anomalies = rows.map(r => decideOpsAnomalyReportedIssue(r)).filter(Boolean);

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(
  path.join(outDir, "latest.json"),
  JSON.stringify(
    { generatedAt: new Date().toISOString(), source: storePath, summary: { rows: rows.length, emitted: anomalies.length }, anomalies },
    null,
    2
  )
);

console.log(`ops-anomaly loop sweep — ${rows.length} report(s), ${anomalies.length} agent-behavior → ${path.join(outDir, "latest.json")}`);
for (const a of anomalies.slice(0, 20)) console.log(`   - ${(a as any).convId} | ${(a as any).detail}`);
