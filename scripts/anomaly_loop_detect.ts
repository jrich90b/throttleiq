/**
 * Anomaly-loop DETECT → CLASSIFY (Phase 3, docs/autonomous_coding_loop.md).
 *
 * Reads the unified outcome-audit feed (reports/outcome_audit/latest.json), classifies every anomaly by
 * TIER via the pure classifyOutcomeAnomaly (the AGENTS.md tier contract as code), tracks persistence
 * across runs (a `healed` anomaly that re-appears = a reconcile-heal gap → escalate), and writes the
 * ranked, tier-tagged WORK ORDER the orchestrator (PLAN→BUILD→VERIFY→PR) consumes:
 *   reports/anomaly_loop/next.json
 *
 * Read-only re: the conversation store. Graduated autonomy: nothing here merges or deploys — it produces
 * a work order. A category earns auto-merge only via the ledger (reports/auto_loop/category_ledger.json);
 * until then every work order is PR + (when behavioral) notify.
 *
 * Run: REPORT_ROOT=/path/to/reports npx tsx scripts/anomaly_loop_detect.ts
 */
import fs from "node:fs";
import path from "node:path";

const { classifyOutcomeAnomaly } = await import("../services/api/src/domain/anomalyClassifier.ts");

const reportRoot = process.env.REPORT_ROOT || path.resolve("reports");
const feedPath = path.join(reportRoot, "outcome_audit", "latest.json");
const outDir = path.join(reportRoot, "anomaly_loop");
const prevPath = path.join(outDir, "prev_keys.json");

if (!fs.existsSync(feedPath)) {
  console.error(`No outcome-audit feed at ${feedPath} — run conversation_outcome_audit first.`);
  process.exit(2);
}
const feed = JSON.parse(fs.readFileSync(feedPath, "utf8"));
const anomalies: any[] = Array.isArray(feed?.anomalies) ? feed.anomalies : [];

// Merge the Net 3 open-critic feed (reports/open_critic/latest.json) when present — the open-ended
// critic writes the SAME OutcomeAnomaly shape (category="discovery") into a sibling file so the
// deterministic sweep stays pure. Optional: absent on a deterministic-only run.
for (const sib of [
  { name: "open-critic (discovery)", file: path.join(reportRoot, "open_critic", "latest.json") },
  { name: "watch-fire-miss", file: path.join(reportRoot, "watch_fire_miss", "latest.json") },
  // The intent-handled semantic net (fluent-but-wrong-intent misses the keyword scorers can't catch).
  // Emits major misses as comprehension OutcomeAnomaly entries via decideIntentHandledAnomaly.
  { name: "intent-handled (comprehension)", file: path.join(reportRoot, "intent_handled", "anomalies.json") }
]) {
  if (!fs.existsSync(sib.file)) continue;
  try {
    const s = JSON.parse(fs.readFileSync(sib.file, "utf8"));
    if (Array.isArray(s?.anomalies)) {
      anomalies.push(...s.anomalies);
      console.log(`Merged ${s.anomalies.length} ${sib.name} finding(s) from ${sib.file}`);
    }
  } catch {
    /* a malformed sibling feed must never break the deterministic loop */
  }
}

// Persistence: an anomaly seen in the PRIOR run too (same convId+dimension). Used to flag a `healed`
// dimension that the reconcile tick never actually clears (a heal gap) rather than a one-tick transient.
const keyOf = (a: any) => `${a?.convId ?? ""}::${a?.dimension ?? ""}`;
const prevKeys: Set<string> = new Set(
  fs.existsSync(prevPath) ? (JSON.parse(fs.readFileSync(prevPath, "utf8"))?.keys ?? []) : []
);

const graduatedCategories: Set<string> = new Set(
  (() => {
    const ledger = path.join(reportRoot, "auto_loop", "category_ledger.json");
    if (!fs.existsSync(ledger)) return [] as string[];
    try {
      const j = JSON.parse(fs.readFileSync(ledger, "utf8"));
      return Object.entries(j?.categories ?? {})
        .filter(([, v]: any) => v?.autoMerge === true)
        .map(([k]) => k);
    } catch {
      return [] as string[];
    }
  })()
);

const classified = anomalies.map(a => {
  const persistent = prevKeys.has(keyOf(a));
  const cls = classifyOutcomeAnomaly(a, { persistent, graduatedCategories });
  return { ...a, persistent, ...cls };
});

// Work order = anything the orchestrator must act on (tier 0 / reconcile-handled drops out).
const TIER_RANK: Record<number, number> = { 2: 0, 1: 1, 0: 2 };
const SEV_RANK: Record<string, number> = { P1: 0, P2: 1, P3: 2 };
const workOrders = classified
  .filter(c => c.workOrder)
  .sort((a, b) => (TIER_RANK[a.tier] - TIER_RANK[b.tier]) || (SEV_RANK[a.severity] ?? 9) - (SEV_RANK[b.severity] ?? 9));

const byAction: Record<string, number> = {};
const byTier: Record<string, number> = { "0": 0, "1": 0, "2": 0 };
for (const c of classified) {
  byAction[c.action] = (byAction[c.action] ?? 0) + 1;
  byTier[String(c.tier)] += 1;
}
const notify = workOrders.filter(c => c.notify);

fs.mkdirSync(outDir, { recursive: true });
const payload = {
  generatedAt: new Date().toISOString(),
  feedGeneratedAt: feed?.generatedAt ?? null,
  totalAnomalies: anomalies.length,
  workOrderCount: workOrders.length,
  byTier,
  byAction,
  notifyCount: notify.length,
  workOrders,
  stop: workOrders.length === 0
};
fs.writeFileSync(path.join(outDir, "next.json"), JSON.stringify(payload, null, 2));
fs.writeFileSync(prevPath, JSON.stringify({ keys: anomalies.map(keyOf) }, null, 2));

console.log(`Anomaly-loop DETECT — ${anomalies.length} anomalies → ${workOrders.length} work order(s)`);
console.log(`By tier: 0 ${byTier["0"]} (reconcile-handled) / 1 ${byTier["1"]} / 2 ${byTier["2"]}; needs-Joe (notify): ${notify.length}`);
for (const [action, n] of Object.entries(byAction).sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)}  ${action}`);
for (const c of workOrders.slice(0, 20)) {
  console.log(`   - [T${c.tier}${c.persistent ? "/persistent" : ""}${c.notify ? "/notify" : ""}] ${c.action} ${c.dimension} ${c.convId} — ${c.rationale}`);
}
console.log(payload.stop ? "\nstop:true — nothing to act on (system healthy)." : `\nWork order: ${path.join(outDir, "next.json")}`);
