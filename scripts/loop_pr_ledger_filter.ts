/**
 * loop_pr_ledger_filter — batch-drop already-filed findings from a next.json work order.
 *
 * WHY (2026-07-09, Joe: "keys — wire it"): the per-item `act_runner check-open-pr` dedup is only
 * run by a routine right before it builds a PR, so the WORK ORDER / morning digest still lists
 * findings that an OPEN or recently-MERGED loop PR already covers (a whole run's worth of #148/#168/
 * #172/#173/#175 stale echoes surfaced this way). anomaly_loop_detect now self-filters — but it runs
 * on the box, which has NO gh, so its ledger pass is a fail-safe no-op there. This CLI closes that gap:
 * the routine fetches next.json from the box and runs THIS locally (Mac, gh authed) to strip covered
 * findings before writing the digest.
 *
 * Exact-key only (convId::dimension), so it never hides a live miss. gh error / empty lists → drop
 * NOTHING. Pure core (applyLedgerToPayload) is pinned by loop_pr_ledger_suppression:eval.
 *
 * Usage:
 *   npx tsx scripts/loop_pr_ledger_filter.ts [--in reports/anomaly_loop/next.json] [--out <path>]
 *     --in   defaults to $REPORT_ROOT/anomaly_loop/next.json (or ./reports/...)
 *     --out  defaults to --in (rewrite in place)
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { partitionWorkOrdersByLoopPr, type LoopWorkOrder } from "../services/api/src/domain/loopPrDedup.ts";
import type { OpenPrSummary, MergedPrSummary } from "../services/api/src/domain/loopPrDedup.ts";
import { listOpenLoopPrs, listRecentlyMergedLoopPrs } from "./loopPrLedger.ts";

export type LedgerFilterResult = {
  payload: Record<string, unknown>;
  suppressed: Array<{ convId: string; dimension: string; prNumber: number; state: string; mergedAt?: string | null }>;
};

/**
 * Pure: given a next.json payload and the current open/merged loop PRs, return a new payload with
 * PR-covered work orders removed and its summary counts recomputed over the KEPT work orders. The
 * dropped findings are recorded under `suppressedByOpenPr` so nothing is hidden from the digest.
 */
export function applyLedgerToPayload(
  payload: Record<string, unknown>,
  args: { openPrs?: OpenPrSummary[] | null; mergedPrs?: MergedPrSummary[] | null; nowMs?: number; windowDays?: number }
): LedgerFilterResult {
  const workOrders: LoopWorkOrder[] = Array.isArray((payload as any)?.workOrders) ? (payload as any).workOrders : [];
  const { kept, suppressed } = partitionWorkOrdersByLoopPr(workOrders, args);

  const byTier: Record<string, number> = { "0": 0, "1": 0, "2": 0 };
  const byAction: Record<string, number> = {};
  let notifyCount = 0;
  for (const w of kept as any[]) {
    const t = String(w?.tier ?? "");
    if (t in byTier) byTier[t] += 1;
    else byTier[t] = (byTier[t] ?? 0) + 1;
    const a = String(w?.action ?? "unknown");
    byAction[a] = (byAction[a] ?? 0) + 1;
    if (w?.notify) notifyCount += 1;
  }

  const priorSuppressed = Array.isArray((payload as any)?.suppressedByOpenPr) ? (payload as any).suppressedByOpenPr : [];
  const newlySuppressed = suppressed.map(s => ({
    convId: String(s.workOrder.convId ?? ""),
    dimension: String(s.workOrder.dimension ?? ""),
    prNumber: s.prNumber,
    state: s.state,
    mergedAt: s.mergedAt ?? null
  }));
  const suppressedByOpenPr = [...priorSuppressed, ...newlySuppressed];

  const outPayload: Record<string, unknown> = {
    ...payload,
    workOrders: kept,
    workOrderCount: kept.length,
    byTier,
    byAction,
    notifyCount,
    suppressedByOpenPrCount: suppressedByOpenPr.length,
    suppressedByOpenPr,
    stop: kept.length === 0
  };
  return { payload: outPayload, suppressed: newlySuppressed };
}

function arg(name: string, fallback = ""): string {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? String(process.argv[i + 1]) : fallback;
}

function main(): void {
  const reportRoot = process.env.REPORT_ROOT || path.resolve("reports");
  const inPath = arg("--in") || path.join(reportRoot, "anomaly_loop", "next.json");
  const outPath = arg("--out") || inPath;
  if (!fs.existsSync(inPath)) {
    console.error(`No next.json at ${inPath} — nothing to filter.`);
    process.exit(2);
  }
  const payload = JSON.parse(fs.readFileSync(inPath, "utf8"));
  const before = Array.isArray(payload?.workOrders) ? payload.workOrders.length : 0;
  const { payload: out, suppressed } = applyLedgerToPayload(payload, {
    openPrs: listOpenLoopPrs(),
    mergedPrs: listRecentlyMergedLoopPrs()
  });
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log(`loop_pr_ledger_filter — ${before} → ${(out as any).workOrderCount} work order(s); dropped ${suppressed.length} already covered by a loop PR.`);
  for (const s of suppressed.slice(0, 30)) console.log(`   - ${s.convId}::${s.dimension} → PR #${s.prNumber} (${s.state})`);
}

// Run the CLI only when invoked directly — importing the module (e.g. from the eval) must not
// execute main(). Robust across tsx/node ESM: compare the resolved entry path to this file's URL.
const isEntry = !!process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntry) main();
