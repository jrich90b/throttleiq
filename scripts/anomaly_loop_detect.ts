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

const { classifyOutcomeAnomaly, suppressStaleFindings } = await import(
  "../services/api/src/domain/anomalyClassifier.ts"
);

// The set of eval scripts wired into ci:eval — a dimension's fix counts as "shipped" (so its stale
// pre-fix findings can be suppressed) only if its guarding eval is in this chain. Can't read it →
// empty set → suppress NOTHING (fail-safe: keep every finding).
function ciEvalScriptSet(): ReadonlySet<string> {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.resolve("package.json"), "utf8"));
    const chain = String(pkg?.scripts?.["ci:eval"] ?? "");
    const set = new Set<string>();
    for (const m of chain.matchAll(/npm run ([\w:-]+)/g)) set.add(m[1]);
    return set;
  } catch {
    return new Set<string>();
  }
}

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
  { name: "intent-handled (comprehension)", file: path.join(reportRoot, "intent_handled", "anomalies.json") },
  // Operator "Report issue" reports (opsAnomalyStore) → reported_issue. The explicit-human-flag net:
  // agent-behavior reports (routing/cadence/appointment/task/handoff/other) the operator filed by hand.
  { name: "operator-reported (ops anomaly)", file: path.join(reportRoot, "ops_anomaly", "latest.json") },
  // Thumbs-down NOTES that are staff INSTRUCTIONS for a live customer ("book him in at 9:30"), not
  // code defects (thumbs_down_action_request). The 👎 loop used to bury these; they belong in the
  // staff-action lane so the customer stops waiting. (thumbs_down_action_sweep.ts.)
  { name: "thumbs-down staff action", file: path.join(reportRoot, "thumbs_down_action", "latest.json") },
  // MDF assistant (Ansira co-op portal runner) failures — blocked/stuck/fell-back-because-it-didn't-load
  // runs (mdf_assistant_failure / mdf_assistant_stuck), synthetic mdf:<taskId> ids. Integration-diagnosis.
  { name: "mdf-portal-health", file: path.join(reportRoot, "mdf_health", "latest.json") },
  // Fabricated-frame: a SENT reply that opened with a frame the customer's turn didn't warrant
  // ("You're welcome" with no thanks). A customer-facing comprehension miss that was previously
  // visible only in the morning digest — fold it in so the autonomous loop + daily PR-review see it too.
  { name: "fabricated-frame (comprehension)", file: path.join(reportRoot, "fabricated_frame", "latest.json") },
  // Corpus replay flywheel (offline readiness): the nightly sandbox sweep replays every
  // conversation's last inbound through the DEPLOYED code and judges the drafts — regressions
  // (a turn that passed before, on a changed draft) and judge-major misses land here so the
  // loop consumes offline findings exactly like live ones (corpus_replay_nightly.ts, 05:00 UTC).
  { name: "corpus-replay (offline flywheel)", file: path.join(reportRoot, "corpus_replay", "latest.json") }
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

// Stale-finding suppression (never re-fix a ghost): drop findings whose dimension is eval-guarded AND
// whose triggering event predates the deployed fix. Conservative — keeps anything it can't prove stale.
const rawAnomalyCount = anomalies.length;
const { kept, suppressed } = suppressStaleFindings(anomalies, { guardingEvals: ciEvalScriptSet() });
anomalies.length = 0;
anomalies.push(...kept);
if (suppressed.length) {
  console.log(`Suppressed ${suppressed.length} stale finding(s) — root cause fixed + eval-guarded + event predates the fix:`);
  for (const s of suppressed.slice(0, 20)) console.log(`   - ${s.anomaly.convId} ${s.anomaly.dimension} — ${s.reason}`);
}

// Cross-routine PR-ledger suppression (batch the per-item act_runner check-open-pr): drop findings
// whose convId::dimension already has an OPEN loop PR (fix awaiting review) or a recently-MERGED one
// (fix landed — a stale echo until the report refreshes). Exact-key only, so we never hide a live miss.
// gh-authed machines use live `gh pr list`; the BOX (no gh — where the emailed digest is generated)
// falls back to the pr_ledger.json a Mac routine exports daily (loop_pr_ledger_export.ts), freshness-
// guarded by parseLoopPrLedgerPayload (stale/malformed → null → suppress nothing). Any error → keep everything.
let suppressedByOpenPr: Array<{ convId: string; dimension: string; prNumber: number; state: string; mergedAt?: string | null }> = [];
try {
  const { partitionWorkOrdersByLoopPr, parseLoopPrLedgerPayload } = await import(
    "../services/api/src/domain/loopPrDedup.ts"
  );
  const { listOpenLoopPrs, listRecentlyMergedLoopPrs } = await import("./loopPrLedger.ts");
  let openPrs = listOpenLoopPrs();
  let mergedPrs = listRecentlyMergedLoopPrs();
  if (!openPrs.length && !mergedPrs.length) {
    const ledgerPath = path.join(outDir, "pr_ledger.json");
    if (fs.existsSync(ledgerPath)) {
      const fileLedger = parseLoopPrLedgerPayload(JSON.parse(fs.readFileSync(ledgerPath, "utf8")));
      if (fileLedger) {
        openPrs = fileLedger.openPrs;
        mergedPrs = fileLedger.mergedPrs;
        console.log(`PR ledger: gh unavailable — using exported ${ledgerPath} (${openPrs.length} open / ${mergedPrs.length} merged)`);
      }
    }
  }
  const part = partitionWorkOrdersByLoopPr(anomalies, {
    openPrs,
    mergedPrs
  });
  if (part.suppressed.length) {
    anomalies.length = 0;
    anomalies.push(...part.kept);
    suppressedByOpenPr = part.suppressed.map(s => ({
      convId: String(s.workOrder.convId ?? ""),
      dimension: String(s.workOrder.dimension ?? ""),
      prNumber: s.prNumber,
      state: s.state,
      mergedAt: s.mergedAt ?? null
    }));
    console.log(`Suppressed ${part.suppressed.length} finding(s) already covered by an open/merged loop PR:`);
    for (const s of part.suppressed.slice(0, 20)) console.log(`   - ${s.key} → PR #${s.prNumber} (${s.state})`);
  }
} catch {
  /* gh unavailable / any error → keep every finding (fail toward surfacing, never toward hiding) */
}

// Persistence: an anomaly seen in the PRIOR run too (same convId+dimension). Used to flag a `healed`
// dimension that the reconcile tick never actually clears (a heal gap) rather than a one-tick transient.
const keyOf = (a: any) => `${a?.convId ?? ""}::${a?.dimension ?? ""}`;
const prevPayload: any = fs.existsSync(prevPath) ? JSON.parse(fs.readFileSync(prevPath, "utf8")) : {};
const prevKeys: Set<string> = new Set(prevPayload?.keys ?? []);
// First-seen ledger (the AGE CLOCK, Joe 2026-07-09: "they just keep building in the reports and
// aren't touched for a while"): every finding key remembers when it FIRST appeared, so the digest
// can lead with "oldest untouched: N days" and mark >48h items OVERDUE instead of re-listing them
// agelessly forever. Keys that stop appearing are dropped (resolved), so the ledger self-prunes.
const prevFirstSeen: Record<string, string> =
  prevPayload && typeof prevPayload.firstSeen === "object" && prevPayload.firstSeen ? prevPayload.firstSeen : {};
const nowIsoForAges = new Date().toISOString();
const firstSeen: Record<string, string> = {};
for (const a of anomalies) {
  const k = keyOf(a);
  firstSeen[k] = prevFirstSeen[k] ?? nowIsoForAges;
}
const ageDaysOf = (k: string): number => {
  const t = Date.parse(firstSeen[k] ?? "");
  if (!Number.isFinite(t)) return 0;
  return Math.max(0, Math.floor((Date.parse(nowIsoForAges) - t) / (24 * 60 * 60 * 1000)));
};

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
  return { ...a, persistent, firstSeenAt: firstSeen[keyOf(a)], ageDays: ageDaysOf(keyOf(a)), ...cls };
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
  rawAnomalyCount,
  suppressedStaleCount: suppressed.length,
  suppressedStale: suppressed.map(s => ({ convId: s.anomaly.convId, dimension: s.anomaly.dimension, reason: s.reason })),
  suppressedByOpenPrCount: suppressedByOpenPr.length,
  suppressedByOpenPr,
  workOrderCount: workOrders.length,
  byTier,
  byAction,
  notifyCount: notify.length,
  workOrders,
  stop: workOrders.length === 0
};
fs.writeFileSync(path.join(outDir, "next.json"), JSON.stringify(payload, null, 2));
fs.writeFileSync(prevPath, JSON.stringify({ keys: anomalies.map(keyOf), firstSeen }, null, 2));

console.log(`Anomaly-loop DETECT — ${anomalies.length} anomalies → ${workOrders.length} work order(s)`);
console.log(`By tier: 0 ${byTier["0"]} (reconcile-handled) / 1 ${byTier["1"]} / 2 ${byTier["2"]}; needs-Joe (notify): ${notify.length}`);
for (const [action, n] of Object.entries(byAction).sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)}  ${action}`);
for (const c of workOrders.slice(0, 20)) {
  console.log(`   - [T${c.tier}${c.persistent ? "/persistent" : ""}${c.notify ? "/notify" : ""}] ${c.action} ${c.dimension} ${c.convId} — ${c.rationale}`);
}
console.log(payload.stop ? "\nstop:true — nothing to act on (system healthy)." : `\nWork order: ${path.join(outDir, "next.json")}`);
