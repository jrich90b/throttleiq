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
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const { classifyOutcomeAnomaly, suppressStaleFindings, suppressAlreadyShippedEchoes } = await import(
  "../services/api/src/domain/anomalyClassifier.ts"
);
type NamingCommit = { hash: string; subject: string; dateMs: number };

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

// Already-shipped ECHO suppression (the PERMANENT complement to the 14-day PR-ledger window above): the
// frozen-transcript detectors (human_correction_material, corpus_replay_judge_fail) grade a record that
// never changes, so once a per-case fix ages past the merged-PR window its ghost re-fires forever. Drop a
// scoped finding when an origin/main commit NAMES the case (phone digits) and landed AFTER the flagged
// event — the graded reply is provably pre-fix. A real post-fix regression has a NEW event dated after the
// commit, so it is never hidden. IO (git grep) is memoized by case token; any git error → [] → keep.
// Mirror of scripts/already_shipped_guard.ts (the per-item morning-routine tool), applied to the whole feed.
let suppressedShippedEcho: Array<{ convId: string; dimension: string; reason: string }> = [];
{
  const namingCache = new Map<string, NamingCommit[]>();
  const caseToken = (a: any): string => {
    const digits = String(a?.convId ?? a?.leadKey ?? "").replace(/\D/g, "");
    if (digits.length >= 7) return digits.slice(-10); // phone: the last-10 is the stable case key
    const raw = String(a?.convId ?? a?.leadKey ?? "").trim();
    return raw.length >= 4 ? raw : ""; // ref/other id; too-short/email → no reliable grep term
  };
  const namingCommitsFor = (a: any): NamingCommit[] => {
    const term = caseToken(a);
    if (!term) return [];
    const cached = namingCache.get(term);
    if (cached) return cached;
    let commits: NamingCommit[] = [];
    try {
      const raw = execFileSync(
        "git",
        ["log", "origin/main", "--since=180.days", "-i", `--grep=${term}`, "--format=%H\t%ct\t%s"],
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
      );
      commits = raw
        .split("\n")
        .map(line => {
          const [hash, ct, ...rest] = line.split("\t");
          return hash ? { hash: hash.slice(0, 8), subject: rest.join("\t"), dateMs: Number(ct) * 1000 } : null;
        })
        .filter((c): c is NamingCommit => !!c && Number.isFinite(c.dateMs));
    } catch {
      commits = []; // no repo / no origin/main / no match → keep the finding (fail-safe)
    }
    namingCache.set(term, commits);
    return commits;
  };
  const echo = suppressAlreadyShippedEchoes(anomalies as any, { namingCommitsFor });
  if (echo.suppressed.length) {
    anomalies.length = 0;
    anomalies.push(...echo.kept);
    suppressedShippedEcho = echo.suppressed.map(s => ({
      convId: String(s.anomaly.convId ?? ""),
      dimension: String(s.anomaly.dimension ?? ""),
      reason: s.reason
    }));
    console.log(`Suppressed ${echo.suppressed.length} already-shipped echo(es) — a naming fix commit postdates the flagged event:`);
    for (const s of echo.suppressed.slice(0, 20)) console.log(`   - ${s.anomaly.convId} ${s.anomaly.dimension} — ${s.reason}`);
  }
}

// 4th pass — AUTO-REPRODUCE confirmation (Joe, 2026-07-24: "run the triage in the routines so we
// don't have to burn down the report"). The three passes above are date/commit-name GUESSES; this
// one is behavioral. A bounded box sweep (scripts/reproduce_confirm_sweep.ts) re-replays the top-N
// eligible findings' pinned turns against the DEPLOYED dist, judges the new draft with the same
// intent-handled judge the flywheel uses, and writes reports/reproduce_confirm/latest.json listing
// findings that PASSED (no longer reproduce). We drop exactly those keys. Runs LAST so it only
// spends re-run signal on findings that survived the three cheap heuristics.
// Fail-safe + commit-bound: a stale sweep, a moved deploy commit, a malformed file, or any error →
// suppress NOTHING (parseReproduceConfirmPayload → null / the catch keeps every finding). We only
// ever drop a finding a clean multi-sample re-replay PROVED no longer reproduces.
let suppressedByReproduce: Array<{ convId: string; dimension: string; verdict?: string | null }> = [];
try {
  const { parseReproduceConfirmPayload, partitionByReproduceConfirm } = await import(
    "../services/api/src/domain/reproduceConfirm.ts"
  );
  const confirmPath = path.join(reportRoot, "reproduce_confirm", "latest.json");
  if (fs.existsSync(confirmPath)) {
    let deployedCommit: string | null = null;
    try {
      deployedCommit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    } catch {
      deployedCommit = null; // no repo → parse returns null → suppress nothing
    }
    const parsed = parseReproduceConfirmPayload(JSON.parse(fs.readFileSync(confirmPath, "utf8")), { deployedCommit });
    if (parsed && parsed.keys.size) {
      const part = partitionByReproduceConfirm(anomalies, { confirmedStaleKeys: parsed.keys, verdictByKey: parsed.verdictByKey });
      if (part.suppressed.length) {
        anomalies.length = 0;
        anomalies.push(...part.kept);
        suppressedByReproduce = part.suppressed.map(s => ({
          convId: String((s.anomaly as any).convId ?? ""),
          dimension: String((s.anomaly as any).dimension ?? ""),
          verdict: s.verdict ?? null
        }));
        console.log(`Suppressed ${part.suppressed.length} finding(s) confirmed stale by re-replay — the pinned turn no longer reproduces on the deployed code:`);
        for (const s of part.suppressed.slice(0, 20)) console.log(`   - ${s.key}${s.verdict ? ` (${s.verdict})` : ""}`);
      }
    }
  }
} catch {
  /* malformed sweep file / any error → keep every finding (fail toward surfacing, never toward hiding) */
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
  suppressedShippedEchoCount: suppressedShippedEcho.length,
  suppressedShippedEcho,
  suppressedByReproduceCount: suppressedByReproduce.length,
  suppressedByReproduce,
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
