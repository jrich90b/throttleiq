/**
 * Drift monitor runner (nightly). Ingests the freshest context_fidelity_summary.json (the out-of-context
 * sensor), appends a point to a persisted time-series, and calls evaluateDrift. Exits 2 when it alerts so
 * a cron/agent-watch wrapper can notify. Reuses the existing sensor — no new scoring here.
 *
 *   1) npm run context_fidelity:audit   (writes REPORT_ROOT/context_fidelity/context_fidelity_summary.json)
 *   2) npx tsx scripts/drift_monitor.ts [--summary=PATH] [--series=PATH]
 */
import fs from "node:fs";
import path from "node:path";

import { evaluateDrift, DEFAULT_DRIFT_THRESHOLDS, type DriftPoint } from "../services/api/src/domain/driftMonitor.ts";

const arg = (k: string) => process.argv.find(a => a.startsWith(`--${k}=`))?.split("=")[1];
const summaryPath =
  arg("summary") ||
  path.join(process.env.REPORT_ROOT || "reports", "context_fidelity", "context_fidelity_summary.json");
const seriesPath = arg("series") || path.join(process.env.REPORT_ROOT || "reports", "drift", "context_fidelity_series.json");

if (!fs.existsSync(summaryPath)) {
  console.error(`drift_monitor: no summary at ${summaryPath} — run context_fidelity:audit first.`);
  process.exit(1);
}
const summary = JSON.parse(fs.readFileSync(summaryPath, "utf8"));
const latest: DriftPoint = {
  at: new Date().toISOString(),
  scored: Number(summary.scored ?? 0),
  major: Number(summary.major ?? 0),
  byFrame: summary.byFrame ?? {}
};

const series: DriftPoint[] = fs.existsSync(seriesPath) ? JSON.parse(fs.readFileSync(seriesPath, "utf8")) : [];
const result = evaluateDrift(series, latest, DEFAULT_DRIFT_THRESHOLDS);

fs.mkdirSync(path.dirname(seriesPath), { recursive: true });
fs.writeFileSync(seriesPath, JSON.stringify([...series, latest].slice(-120), null, 2));

const rate = result.rate == null ? "n/a" : `${(result.rate * 100).toFixed(1)}%`;
const base = result.baselineRate == null ? "n/a" : `${(result.baselineRate * 100).toFixed(1)}%`;
console.log(`drift_monitor: wrong-answer rate ${rate} (baseline ${base}); ${result.alerts.length} alert(s).`);
for (const a of result.alerts) console.log(`  [DRIFT:${a.kind}] ${a.detail}`);
process.exit(result.alerts.length ? 2 : 0);
