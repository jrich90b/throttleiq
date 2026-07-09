/**
 * loopPrLedger — the gh IO half of cross-routine PR dedup.
 *
 * The PURE matching/partition logic lives in services/api/src/domain/loopPrDedup.ts
 * (unit-tested, no IO). This module is the thin `gh pr list` reader that feeds it, shared
 * by every routine that needs the ledger: act_runner (per-item check-open-pr / open-pr),
 * anomaly_loop_detect (self-filter the work order), and loop_pr_ledger_filter (batch-filter
 * a box-produced next.json where gh is authed).
 *
 * Fail-direction: ANY gh error (not installed, not authed, network) returns [] — the pure
 * partition then suppresses NOTHING (keep every finding). We never drop a finding we can't
 * prove a PR covers. The box has no gh, so a detector run there is a harmless no-op; the
 * routine re-runs the filter on the Mac where gh is authed.
 */
import { execFileSync } from "node:child_process";
import type { OpenPrSummary, MergedPrSummary } from "../services/api/src/domain/loopPrDedup.ts";

export function listOpenLoopPrs(): OpenPrSummary[] {
  try {
    const out = execFileSync(
      "gh",
      ["pr", "list", "--state", "open", "--limit", "200", "--json", "number,title,body"],
      { encoding: "utf8" }
    );
    const parsed = JSON.parse(out);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function listRecentlyMergedLoopPrs(): MergedPrSummary[] {
  try {
    const out = execFileSync(
      "gh",
      ["pr", "list", "--state", "merged", "--limit", "100", "--json", "number,title,body,mergedAt"],
      { encoding: "utf8" }
    );
    const parsed = JSON.parse(out);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
