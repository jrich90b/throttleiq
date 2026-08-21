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
  return findOpenPrsForFindingKey(openPrs, key)[0] ?? null;
}

/**
 * EVERY open PR carrying this key. A PR fixes ONE finding, so the COUNT is what the batch
 * partitioner needs when several distinct findings share a key (see `partitionWorkOrdersByLoopPr`).
 */
export function findOpenPrsForFindingKey(
  openPrs: OpenPrSummary[] | null | undefined,
  key: string
): OpenPrSummary[] {
  if (!isMeaningfulFindingKey(key)) return [];
  const marker = findingKeyMarker(key);
  return (openPrs ?? []).filter(pr => typeof pr?.body === "string" && pr.body.includes(marker));
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
  return findMergedPrsForFindingKey(mergedPrs, key, opts)[0] ?? null;
}

/** EVERY in-window merged PR carrying this key — the count feeds the same coverage cap. */
export function findMergedPrsForFindingKey(
  mergedPrs: MergedPrSummary[] | null | undefined,
  key: string,
  opts?: { nowMs?: number; windowDays?: number }
): MergedPrSummary[] {
  if (!isMeaningfulFindingKey(key)) return [];
  const marker = findingKeyMarker(key);
  const nowMs = opts?.nowMs ?? Date.now();
  const windowMs = (opts?.windowDays ?? 14) * 24 * 60 * 60 * 1000;
  return (mergedPrs ?? []).filter(pr => {
    if (typeof pr?.body !== "string" || !pr.body.includes(marker)) return false;
    const mergedMs = Date.parse(String(pr.mergedAt ?? ""));
    if (!Number.isFinite(mergedMs)) return false; // can't prove recency → keep building
    return nowMs - mergedMs <= windowMs;
  });
}

/** A work-order / anomaly row — anything carrying a convId + dimension we can key on. */
export type LoopWorkOrder = {
  convId?: string | null;
  dimension?: string | null;
  /**
   * Set by the BOX when a disposed key recurred AFTER its `--deploy-ts` boundary: the fix we already
   * claimed did not hold. See `regressionKept` in `partitionWorkOrdersByLoopPr` for why it can never
   * be suppressed by PR coverage.
   */
  regressionOfDisposed?: boolean;
  [k: string]: unknown;
};

/**
 * A finding the box tagged `regressionOfDisposed` — kept unconditionally, whatever the PR ledger says.
 */
export type LoopPrRegressionKept = { workOrder: LoopWorkOrder; key: string; prNumbers: number[] };

export type LoopPrSuppression = {
  workOrder: LoopWorkOrder;
  key: string;
  prNumber: number;
  state: "open" | "merged";
  mergedAt?: string | null;
};

/**
 * A key that MORE findings share than PRs cover: the PR proves one of them is filed, but not
 * which, so all of them are KEPT and reported here for manual triage.
 */
export type LoopPrAmbiguousCoverage = {
  workOrder: LoopWorkOrder;
  key: string;
  findingCount: number;
  prCount: number;
  prNumbers: number[];
};

/**
 * Batch the per-item check-open-pr dedup so the WORK ORDER (next.json) is pre-filtered
 * instead of every routine re-discovering the same already-filed finding per item.
 * Drops a work order when an OPEN loop PR carries its `convId::dimension` key (a fix is
 * awaiting review) or a RECENTLY-MERGED one does (the fix already landed — the finding is
 * a stale echo until its report refreshes). This is the same signal `act_runner check-open-pr`
 * emits, applied to the whole list at detect time.
 *
 * Fail-direction (unchanged from the single-item helpers): an empty/malformed key, or
 * absent/empty PR lists (e.g. gh unavailable → the caller passes `[]`), suppresses NOTHING —
 * every finding is KEPT. We only ever drop a finding we can PROVE a PR already covers, so we
 * never silently hide a live miss (incl. state anomalies: a watch_fire_miss is dropped only if
 * a PR was literally stamped `<phone>::watch_fire_miss`, i.e. someone already filed it).
 *
 * COVERAGE CAP (2026-08-04). `convId::dimension` is not unique: one conversation can carry SEVERAL
 * DISTINCT findings in the same dimension — Tony Mooradian +17165236994 filed two separate operator
 * reports, "Pricing was answered but the pricing flag still shows in the inbox" and "I don't think
 * this one should have been closed", both `reported_issue`. PR #507 fixed the FIRST; the key match
 * then dropped BOTH, so the wrongful-close report vanished from the work order with no trace but a
 * "covered by #507" line. A PR covers ONE finding, so suppression is capped at the number of PRs
 * carrying the key: when more findings share a key than PRs cover it, every one of them is KEPT and
 * listed in `ambiguous` for manual triage. Same fail-direction as the rest of this module — we drop
 * a finding only when we can prove coverage, and "some PR covers one of these three" is not proof.
 *
 * REGRESSION-OF-DISPOSED IS NEVER SUPPRESSED (2026-08-21). The box's dispositions ledger tags a work
 * order `regressionOfDisposed` when a key it already disposed `fixed`/`stale-echo` RECURRED after the
 * `--deploy-ts` boundary — i.e. the very claim "a PR covers this" is the claim the recurrence refutes.
 * This filter runs LOCALLY, after the box has restored those rows, and it was silently re-eating them:
 * measured 2026-08-21, `+17169467451::corpus_replay_judge_fail` (Paul Harrigan) was dropped as
 * "covered by PR #681 (merged)" while carrying `regressionOfDisposed: true`. The agent-loop SKILL
 * carried a hand-diff workaround for exactly this ("PUT BACK any dropped row tagged
 * regressionOfDisposed") — that step is now a no-op. Same fail-direction as everything else here: we
 * only ever drop what we can PROVE is covered, and a post-boundary recurrence is proof of the opposite.
 */
export function partitionWorkOrdersByLoopPr(
  workOrders: LoopWorkOrder[] | null | undefined,
  args: {
    openPrs?: OpenPrSummary[] | null;
    mergedPrs?: MergedPrSummary[] | null;
    nowMs?: number;
    windowDays?: number;
  }
): {
  kept: LoopWorkOrder[];
  suppressed: LoopPrSuppression[];
  ambiguous: LoopPrAmbiguousCoverage[];
  regressionKept: LoopPrRegressionKept[];
} {
  const kept: LoopWorkOrder[] = [];
  const suppressed: LoopPrSuppression[] = [];
  const ambiguous: LoopPrAmbiguousCoverage[] = [];
  const regressionKept: LoopPrRegressionKept[] = [];

  const findingCounts = new Map<string, number>();
  for (const wo of workOrders ?? []) {
    const key = findingKeyOf(wo?.convId ?? null, wo?.dimension ?? null);
    if (!isMeaningfulFindingKey(key)) continue;
    findingCounts.set(key, (findingCounts.get(key) ?? 0) + 1);
  }

  for (const wo of workOrders ?? []) {
    const key = findingKeyOf(wo?.convId ?? null, wo?.dimension ?? null);
    if (!isMeaningfulFindingKey(key)) {
      kept.push(wo);
      continue;
    }
    const opens = findOpenPrsForFindingKey(args.openPrs, key);
    const mergeds = findMergedPrsForFindingKey(args.mergedPrs, key, {
      nowMs: args.nowMs,
      windowDays: args.windowDays
    });
    const prNumbers = [...new Set([...opens, ...mergeds].map(pr => pr.number))];
    if (prNumbers.length === 0) {
      kept.push(wo);
      continue;
    }
    if (wo?.regressionOfDisposed === true) {
      // The fix we already claimed did not hold. PR coverage cannot dispose of that.
      regressionKept.push({ workOrder: wo, key, prNumbers });
      kept.push(wo);
      continue;
    }
    const findingCount = findingCounts.get(key) ?? 1;
    if (prNumbers.length < findingCount) {
      // More distinct findings than filed PRs: we cannot tell which one is covered → keep them all.
      ambiguous.push({ workOrder: wo, key, findingCount, prCount: prNumbers.length, prNumbers });
      kept.push(wo);
      continue;
    }
    const open = opens[0];
    if (open) {
      suppressed.push({ workOrder: wo, key, prNumber: open.number, state: "open" });
      continue;
    }
    const merged = mergeds[0];
    suppressed.push({ workOrder: wo, key, prNumber: merged.number, state: "merged", mergedAt: merged.mergedAt ?? null });
  }
  return { kept, suppressed, ambiguous, regressionKept };
}


/**
 * Parse a PR-ledger FILE payload (reports/anomaly_loop/pr_ledger.json) — the gh-less box's
 * substitute for live `gh pr list` (the box digest is generated where gh doesn't exist, so a
 * gh-authed machine exports the open/merged loop-PR lists daily and ships this file over).
 * Returns the lists only when the payload is well-formed and FRESH (generatedAt within
 * maxAgeDays, default 3); stale or malformed → null, and the caller suppresses NOTHING
 * (fail toward surfacing findings, never toward hiding one on old coverage data).
 */
export function parseLoopPrLedgerPayload(
  payload: unknown,
  opts?: { nowMs?: number; maxAgeDays?: number }
): { openPrs: OpenPrSummary[]; mergedPrs: MergedPrSummary[] } | null {
  const p = payload as any;
  if (!p || typeof p !== "object") return null;
  const generatedMs = Date.parse(String(p.generatedAt ?? ""));
  if (!Number.isFinite(generatedMs)) return null;
  const nowMs = opts?.nowMs ?? Date.now();
  const maxAgeMs = (opts?.maxAgeDays ?? 3) * 24 * 60 * 60 * 1000;
  if (nowMs - generatedMs > maxAgeMs) return null; // stale export: don't trust coverage
  const openPrs = Array.isArray(p.openPrs) ? p.openPrs.filter((x: any) => x && typeof x.number === "number") : [];
  const mergedPrs = Array.isArray(p.mergedPrs) ? p.mergedPrs.filter((x: any) => x && typeof x.number === "number") : [];
  return { openPrs, mergedPrs };
}
