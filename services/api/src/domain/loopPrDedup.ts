/**
 * Cross-routine PR de-duplication for the self-healing loop.
 *
 * Multiple routines open fix PRs off the SAME unified work order — the unattended
 * throttleiq-loop-runner, the leadrider-daily-anomaly-pr-review builder, and the
 * supervised morning routine. A finding "still reproduces on main" until its PR is
 * MERGED, so an unmerged-but-open PR was getting rebuilt as a DUPLICATE on the next
 * run (the "still reproduces?" check only skips findings already fixed ON main, not
 * ones with an open PR awaiting review). We stamp every loop PR body with a stable,
 * machine-readable finding key and skip building a new PR when an OPEN PR already
 * carries that key — so the routines know what the others have already filed.
 *
 * Fail-direction: an empty/malformed key never dedups (fail toward building the PR,
 * never toward silently dropping a real fix).
 */
export type OpenPrSummary = { number: number; title?: string; body?: string };

/** Stable per-finding key: `convId::dimension` (mirrors act_runner's keyOf). */
export function findingKeyOf(convId: string | null | undefined, dimension: string | null | undefined): string {
  return `${String(convId ?? "").trim()}::${String(dimension ?? "").trim()}`;
}

/** Machine-readable marker embedded in a loop PR body for cross-routine dedup. */
export function findingKeyMarker(key: string): string {
  return `<!-- loop-finding-key: ${String(key ?? "").trim()} -->`;
}

/** A key is meaningful only if it has a convId or a dimension (not just "::"). */
export function isMeaningfulFindingKey(key: string | null | undefined): boolean {
  return String(key ?? "").replace(/::/g, "").trim().length > 0;
}

/**
 * The first OPEN PR whose body carries this finding key, or null. Used to skip
 * re-filing a fix that already has a PR awaiting review.
 */
export function findOpenPrForFindingKey(
  openPrs: OpenPrSummary[] | null | undefined,
  key: string
): OpenPrSummary | null {
  if (!isMeaningfulFindingKey(key)) return null;
  const marker = findingKeyMarker(key);
  for (const pr of openPrs ?? []) {
    if (typeof pr?.body === "string" && pr.body.includes(marker)) return pr;
  }
  return null;
}

export type MergedPrSummary = OpenPrSummary & { mergedAt?: string | null };

/**
 * The first RECENTLY-MERGED PR whose body carries this finding key, or null (Joe,
 * 2026-07-02: "sometimes I see double work in two different routines"). The open-PR
 * dedup above stops working the moment a fix MERGES — but the finding keeps appearing
 * in the work order until its report regenerates (or forever, for findings computed
 * over old conversations), so the NEXT routine re-investigates and sometimes re-fixes
 * it. A finding whose key sits in a PR merged within the window is COVERED: report it
 * as fixed-awaiting-report-refresh instead of rebuilding it.
 *
 * Fail-direction unchanged: empty/malformed key, missing mergedAt, or a merge older
 * than the window never dedups (fail toward building the fix, never toward silently
 * dropping a real regression — a REAL post-fix recurrence carries a fresh occurredAt
 * and its report row survives the refresh, so it comes back next cycle regardless).
 */
export function findMergedPrForFindingKey(
  mergedPrs: MergedPrSummary[] | null | undefined,
  key: string,
  opts?: { nowMs?: number; windowDays?: number }
): MergedPrSummary | null {
  if (!isMeaningfulFindingKey(key)) return null;
  const marker = findingKeyMarker(key);
  const nowMs = opts?.nowMs ?? Date.now();
  const windowMs = (opts?.windowDays ?? 14) * 24 * 60 * 60 * 1000;
  for (const pr of mergedPrs ?? []) {
    if (typeof pr?.body !== "string" || !pr.body.includes(marker)) continue;
    const mergedMs = Date.parse(String(pr.mergedAt ?? ""));
    if (!Number.isFinite(mergedMs)) continue; // can't prove recency → keep building
    if (nowMs - mergedMs <= windowMs) return pr;
  }
  return null;
}
