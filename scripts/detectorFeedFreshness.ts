/**
 * Detector-feed FRESHNESS — "is this work order built on feeds that actually ran today?"
 *
 * WHY THIS EXISTS (measured 2026-08-18). `anomaly_loop_detect` reads one primary feed
 * (reports/outcome_audit/latest.json) and merges up to nine sibling detector feeds, then stamps the
 * work order `generatedAt: <now>`. Nothing anywhere recorded how old any INPUT was. On 2026-08-18 the
 * 08:50-08:54 UTC detector crons all died inside a deploy's `npm install` window (`npx tsx` →
 * "tsx: not found", because the checkout's node_modules/.bin is transiently gone), so at 13:40 UTC:
 *
 *   outcome_audit  8/17 08:50  (29h — THE PRIMARY FEED)   thumbs_down_action  8/18 08:42  (5h)
 *   open_critic    8/17 08:52  (29h)                      mdf_health          8/18 08:58  (4.7h)
 *   watch_fire_miss 8/17 08:53 (29h)                      fabricated_frame    8/18 08:21  (5.3h)
 *   ops_anomaly    8/17 08:54  (29h)                      corpus_replay       8/18 09:56  (3.7h)
 *   intent_handled 8/13 12:35  (5 DAYS)
 *
 * …while `next.json` read `generatedAt: 2026-08-18T09:01:58Z` and `act_runner list` printed a clean
 * queue. Two consecutive loop ticks triaged a dead feed believing it was current, and every finding
 * filed after 8/17 08:50 — including 18 draft-reviewer reports filed on 8/17 — was structurally
 * invisible. The detector chain going quiet and the world going quiet are indistinguishable without
 * this. This module makes them distinguishable.
 *
 * FAIL DIRECTION — deliberately toward WARNING, which is the opposite of the send-path default.
 * This is an INSTRUMENT, not a customer-facing gate: a false "stale" alarm costs one look at a
 * timestamp, while a false "fresh" reading is the exact failure above. So a present feed whose age
 * cannot be established at all is reported STALE, not fresh. Nothing here suppresses, demotes or
 * reorders a single finding — it only reports provenance.
 *
 * Pure and scripts-only: no conversation-store access, no `services/api/src` imports, no side
 * effects. Consumed by `scripts/anomaly_loop_detect.ts` (writes the provenance) and
 * `scripts/act_runner.ts` (prints the banner); pinned by `scripts/detector_feed_freshness_eval.ts`.
 */

/** A daily feed that has missed a full daily cycle. All nine feeds are daily; the healthy ones on
 *  the box sit at 3.7-5.3h, so 26h flags a skipped day with a wide margin and no false alarm. */
export const DETECTOR_FEED_STALE_HOURS_DEFAULT = 26;

export type DetectorFeedInput = {
  /** Human label used in the banner, e.g. "operator-reported (ops anomaly)". */
  name: string;
  /** Absolute path the merge read (or would have read). */
  file: string;
  /** False when the file is absent — an optional feed that never ran on this box. */
  present: boolean;
  /** The feed's own `generatedAt` stamp when it carries one. */
  generatedAt?: string | null;
  /** File mtime, the universal fallback when a feed carries no stamp. */
  mtimeMs?: number | null;
  /** How many findings this feed contributed to the merge. */
  findings?: number | null;
};

export type DetectorFeedSource = {
  name: string;
  file: string;
  present: boolean;
  /** The timestamp the age was computed from, whatever its origin. Null ⇒ undatable. */
  stampedAt: string | null;
  stampSource: "generatedAt" | "mtime" | null;
  findings: number | null;
  ageHours: number | null;
  stale: boolean;
  /** Plain-words reason, present only when `stale`. */
  staleReason?: string;
};

function parseMs(value: unknown): number | null {
  const ms = Date.parse(String(value ?? ""));
  return Number.isFinite(ms) ? ms : null;
}

function roundHours(ms: number): number {
  return Math.round((ms / (1000 * 60 * 60)) * 10) / 10;
}

/**
 * Describe ONE feed. An absent optional feed is never stale — it contributed nothing and claims
 * nothing. A PRESENT feed with no usable timestamp IS stale (see the fail-direction note above).
 */
export function describeDetectorFeed(
  input: DetectorFeedInput,
  opts?: { nowMs?: number; staleHours?: number }
): DetectorFeedSource {
  const nowMs = opts?.nowMs ?? Date.now();
  const staleHours = opts?.staleHours ?? DETECTOR_FEED_STALE_HOURS_DEFAULT;
  const base = {
    name: String(input.name ?? ""),
    file: String(input.file ?? ""),
    present: Boolean(input.present),
    findings: typeof input.findings === "number" ? input.findings : null
  };
  if (!base.present) {
    return { ...base, stampedAt: null, stampSource: null, ageHours: null, stale: false };
  }
  const stampedMs = parseMs(input.generatedAt);
  const mtimeMs = typeof input.mtimeMs === "number" && Number.isFinite(input.mtimeMs) ? input.mtimeMs : null;
  const usedMs = stampedMs ?? mtimeMs;
  const stampSource: DetectorFeedSource["stampSource"] = stampedMs != null ? "generatedAt" : mtimeMs != null ? "mtime" : null;
  if (usedMs == null) {
    return {
      ...base,
      stampedAt: null,
      stampSource: null,
      ageHours: null,
      stale: true,
      staleReason: "present but undatable (no generatedAt, no readable mtime) — cannot prove it ran"
    };
  }
  // A stamp in the FUTURE is a broken clock, not freshness. Clamp to 0 rather than reading negative.
  const ageHours = roundHours(Math.max(0, nowMs - usedMs));
  const stale = ageHours > staleHours;
  return {
    ...base,
    stampedAt: new Date(usedMs).toISOString(),
    stampSource,
    ageHours,
    stale,
    ...(stale ? { staleReason: `last wrote ${ageHours}h ago (over the ${staleHours}h daily bound)` } : {})
  };
}

export type DetectorFeedSummary = {
  sources: DetectorFeedSource[];
  staleSources: DetectorFeedSource[];
  /** Age of the OLDEST present feed — the honest age of the work order as a whole. */
  oldestAgeHours: number | null;
  staleHours: number;
};

export function summarizeDetectorFeeds(
  inputs: DetectorFeedInput[],
  opts?: { nowMs?: number; staleHours?: number }
): DetectorFeedSummary {
  const staleHours = opts?.staleHours ?? DETECTOR_FEED_STALE_HOURS_DEFAULT;
  const sources = (inputs ?? []).map(i => describeDetectorFeed(i, { nowMs: opts?.nowMs, staleHours }));
  const ages = sources.filter(s => s.present && s.ageHours != null).map(s => s.ageHours as number);
  return {
    sources,
    staleSources: sources.filter(s => s.stale),
    oldestAgeHours: ages.length ? Math.max(...ages) : null,
    staleHours
  };
}

/** Read the threshold from the environment so a dealer with a slower cron can widen it without a
 *  code change. A junk value falls back to the default rather than disabling the check. */
export function resolveStaleHours(env: Record<string, string | undefined> = process.env): number {
  const raw = Number(env.DETECTOR_FEED_STALE_HOURS);
  return Number.isFinite(raw) && raw > 0 ? raw : DETECTOR_FEED_STALE_HOURS_DEFAULT;
}

/**
 * The loud, unmissable banner — same shape as the pre-deploy-grade warning next to it, because it
 * carries the same instruction: what you are about to read does not describe now. Returns null when
 * every feed is fresh, so a healthy run stays quiet.
 */
export function formatStaleDetectorFeedBanner(summary: DetectorFeedSummary | null | undefined): string | null {
  const stale = summary?.staleSources ?? [];
  if (!stale.length) return null;
  const lines = stale.map(s => `     - ${s.name}: ${s.staleReason ?? "stale"} (${s.file})`);
  return (
    `\n!! DETECTOR FEEDS ARE STALE — ${stale.length} of ${summary?.sources.length ?? 0} input feed(s) did not run.\n` +
    `   This work order's own timestamp is NOW, but it was built from feeds that are not:\n` +
    lines.join("\n") +
    `\n   Anything those detectors found since is INVISIBLE here — an empty queue is not evidence of a\n` +
    `   quiet store. Re-run the missing sweeps (check the cron logs for a deploy-window crash) before\n` +
    `   concluding there is no work.\n`
  );
}
