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
 *
 * WHY `readLoopPrLedger` exists on top of that (2026-08-03): the two list functions above
 * collapse "gh looked and there are none" into "gh could not look" — both return []. That is
 * the RIGHT fail-direction for the BATCH partition (suppress nothing), but it is wrong for the
 * per-item `act_runner check-open-pr` triage call, which turns [] into the positive sentence
 * "NONE — no open or recently-merged PR covers this key" and exits 0. Measured that day: the
 * loop runner ran check-open-pr ON THE BOX (where every other STEP-2 command runs, and where
 * `gh` is not installed) for `+17162605541::human_correction_material`; it answered NONE while
 * PR #488 carried exactly that marker — the same key answered EXISTS #488 on the Mac one minute
 * later. A routine that trusts that NONE rebuilds a fix another routine already filed, which is
 * precisely the duplicate work ROUTINE_CONTRACT.md's dedup-first step exists to prevent.
 *
 * So this reader reports its SOURCE, and callers making a positive "nothing covers this" claim
 * must require `source === "gh"`. The asymmetry is deliberate and is the whole point:
 *   - a POSITIVE match is proof from any source (the PR exists; an old snapshot can only miss
 *     PRs, never invent one), so a file-sourced EXISTS/MERGED is trustworthy;
 *   - an ABSENCE is only provable from a COMPLETE, current view, i.e. a live gh read. The
 *     exported file ledger is written daily and freshness-guarded at 3 days, so it can be
 *     perfectly "fresh" by that rule and still predate the PR being asked about (the 8/3 box
 *     copy was generated 8/2 14:39, ~29h before PR #488 was opened).
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  parseLoopPrLedgerPayload,
  type OpenPrSummary,
  type MergedPrSummary
} from "../services/api/src/domain/loopPrDedup.ts";

/** `null` when gh could not be consulted at all (missing/unauthed/network), never [] for that case. */
function ghPrListJson<T>(args: string[]): T[] | null {
  try {
    const out = execFileSync("gh", args, { encoding: "utf8" });
    const parsed = JSON.parse(out);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return null;
  }
}

const OPEN_ARGS = ["pr", "list", "--state", "open", "--limit", "200", "--json", "number,title,body"];
const MERGED_ARGS = ["pr", "list", "--state", "merged", "--limit", "100", "--json", "number,title,body,mergedAt"];

export function listOpenLoopPrs(): OpenPrSummary[] {
  return ghPrListJson<OpenPrSummary>(OPEN_ARGS) ?? [];
}

export function listRecentlyMergedLoopPrs(): MergedPrSummary[] {
  return ghPrListJson<MergedPrSummary>(MERGED_ARGS) ?? [];
}

/**
 * Where a ledger read came from. Only "gh" is a COMPLETE, current view of the PR list — the
 * one source from which "no PR covers this key" is a provable claim rather than a guess.
 */
export type LoopPrLedgerSource = "gh" | "file" | "unavailable";

export type LoopPrLedgerRead = {
  openPrs: OpenPrSummary[];
  mergedPrs: MergedPrSummary[];
  source: LoopPrLedgerSource;
  /** True only for a live gh read: absence of a match is then real evidence of absence. */
  canProveAbsence: boolean;
  /** Human-readable provenance for the caller to print (why we can/can't be sure). */
  detail: string;
  /** Set when source === "file": when that export was written. */
  generatedAt?: string;
};

/**
 * Read the loop-PR ledger, preferring a live `gh` read and falling back to the exported
 * pr_ledger.json a gh-authed Mac routine ships to the box (loop_pr_ledger_export.ts) — the same
 * fallback anomaly_loop_detect already uses, freshness-guarded by parseLoopPrLedgerPayload.
 *
 * Never throws. When neither source is available the lists are empty AND `canProveAbsence` is
 * false, so a caller cannot mistake "could not look" for "looked and found nothing".
 */
export function readLoopPrLedger(opts?: { reportRoot?: string }): LoopPrLedgerRead {
  const open = ghPrListJson<OpenPrSummary>(OPEN_ARGS);
  const merged = ghPrListJson<MergedPrSummary>(MERGED_ARGS);
  if (open && merged) {
    return {
      openPrs: open,
      mergedPrs: merged,
      source: "gh",
      canProveAbsence: true,
      detail: `live gh (${open.length} open, ${merged.length} merged)`
    };
  }

  const reportRoot = opts?.reportRoot || process.env.REPORT_ROOT || path.resolve("reports");
  const ledgerPath = path.join(reportRoot, "anomaly_loop", "pr_ledger.json");
  try {
    if (fs.existsSync(ledgerPath)) {
      const payload = JSON.parse(fs.readFileSync(ledgerPath, "utf8"));
      const parsed = parseLoopPrLedgerPayload(payload);
      if (parsed) {
        const generatedAt = String((payload as any)?.generatedAt ?? "");
        const ageMs = Date.now() - Date.parse(generatedAt);
        const ageHours = Number.isFinite(ageMs) ? Math.round(ageMs / 3.6e6) : null;
        return {
          openPrs: parsed.openPrs,
          mergedPrs: parsed.mergedPrs,
          source: "file",
          // A snapshot cannot see PRs opened since it was written, so it can MATCH but never
          // prove the absence of a match.
          canProveAbsence: false,
          detail:
            `exported pr_ledger.json from ${generatedAt || "?"}` +
            (ageHours === null ? "" : ` (~${ageHours}h old)`) +
            ` — gh unavailable here; this snapshot cannot see PRs opened since`,
          generatedAt: generatedAt || undefined
        };
      }
    }
  } catch {
    // fall through to unavailable — a corrupt export is not coverage data
  }

  return {
    openPrs: [],
    mergedPrs: [],
    source: "unavailable",
    canProveAbsence: false,
    detail: `no gh on this host and no fresh ${ledgerPath} — coverage could not be checked at all`
  };
}
