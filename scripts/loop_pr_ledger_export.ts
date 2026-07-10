/**
 * loop_pr_ledger_export — write the open/merged loop-PR lists to a JSON file the gh-less BOX
 * can consume (Joe, 2026-07-09: the emailed agent-watch digest is generated on the box, which
 * has no gh, so #177's ledger suppression was a no-op there and the email still showed ghost
 * findings). A gh-authed machine (the Mac routines) runs this daily and ships the file to
 * REPORT_ROOT/anomaly_loop/pr_ledger.json on the box; anomaly_loop_detect falls back to it
 * when live gh returns nothing. Freshness-guarded at read time (parseLoopPrLedgerPayload,
 * default 3 days) — a stale export suppresses NOTHING.
 *
 * Usage: npx tsx scripts/loop_pr_ledger_export.ts [--out reports/anomaly_loop/pr_ledger.json]
 */
import fs from "node:fs";
import path from "node:path";
import { listOpenLoopPrs, listRecentlyMergedLoopPrs } from "./loopPrLedger.ts";

function arg(name: string, fallback = ""): string {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? String(process.argv[i + 1]) : fallback;
}

const reportRoot = process.env.REPORT_ROOT || path.resolve("reports");
const outPath = arg("--out") || path.join(reportRoot, "anomaly_loop", "pr_ledger.json");

const openPrs = listOpenLoopPrs();
const mergedPrs = listRecentlyMergedLoopPrs();
if (!openPrs.length && !mergedPrs.length) {
  // gh unavailable or empty repo — write nothing rather than shipping an empty ledger that
  // would look "fresh" while carrying no coverage (the reader treats absence as no-op anyway).
  console.error("loop_pr_ledger_export — gh returned no PRs (not installed/authed?); not writing a ledger.");
  process.exit(2);
}
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(
  outPath,
  JSON.stringify({ generatedAt: new Date().toISOString(), openPrs, mergedPrs }, null, 2)
);
console.log(`loop_pr_ledger_export — wrote ${openPrs.length} open + ${mergedPrs.length} merged loop PR(s) to ${outPath}`);
