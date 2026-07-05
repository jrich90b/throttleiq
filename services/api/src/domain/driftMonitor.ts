/**
 * Drift monitor — pure evaluation core. The nightly job runs the existing sensors
 * (context_fidelity_audit out-of-context rate + the takeover genuine-error rate), appends a point to a
 * time-series, and calls evaluateDrift to decide whether to alert. Three drift types:
 *   - behavior_ceiling   — the wrong-answer (major out-of-context) rate exceeds an absolute ceiling.
 *   - behavior_delta     — it jumped vs the trailing baseline (a regression: model/prompt change, new
 *                          lead source) even if still under the ceiling.
 *   - distribution       — the live frame mix moved away from baseline (a new failure cluster emerged
 *                          -> the golden set is under-covered there; harvest new cases).
 *
 * Pure + I/O-free so it's unit-testable (drift_monitor:eval). Small-N points are ignored (noisy).
 */

export type DriftPoint = {
  at: string; // ISO timestamp (stamped by the runner; never new Date() here)
  scored: number; // turns scored in the window
  major: number; // major out-of-context (the wrong-answer count)
  byFrame?: Record<string, number>; // frame -> count, for distribution drift
};

export type DriftThresholds = {
  majorRateCeiling: number; // absolute ceiling on major/scored (e.g. 0.25)
  majorRateDeltaPts: number; // alert if latest rate exceeds the baseline by > this (e.g. 0.08)
  frameShareDeltaPts: number; // alert if any frame's share moved > this vs baseline (e.g. 0.15)
  baselineWindow: number; // trailing points used for the baseline (e.g. 7)
  minScored: number; // ignore points with fewer scored turns than this (e.g. 10)
};

export const DEFAULT_DRIFT_THRESHOLDS: DriftThresholds = {
  majorRateCeiling: 0.25,
  majorRateDeltaPts: 0.08,
  frameShareDeltaPts: 0.15,
  baselineWindow: 7,
  minScored: 10
};

export type DriftAlert = {
  kind: "behavior_ceiling" | "behavior_delta" | "distribution";
  detail: string;
  value: number;
};

export type DriftResult = {
  rate: number | null; // latest major rate (null if under minScored)
  baselineRate: number | null;
  alerts: DriftAlert[];
};

const median = (xs: number[]): number | null => {
  const a = xs.filter(x => Number.isFinite(x)).sort((x, y) => x - y);
  if (!a.length) return null;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};

const rateOf = (p: DriftPoint): number | null => (p.scored >= 1 ? p.major / p.scored : null);
const frameShare = (p: DriftPoint, frame: string): number =>
  p.scored >= 1 ? (p.byFrame?.[frame] ?? 0) / p.scored : 0;

/**
 * Pure. Given the prior time-series (oldest..newest, NOT including `latest`) and the latest point,
 * return the latest rate, the trailing-baseline rate, and any drift alerts.
 */
export function evaluateDrift(history: DriftPoint[], latest: DriftPoint, t: DriftThresholds = DEFAULT_DRIFT_THRESHOLDS): DriftResult {
  const alerts: DriftAlert[] = [];
  if (latest.scored < t.minScored) {
    return { rate: rateOf(latest), baselineRate: null, alerts }; // too few to judge — no alert
  }
  const rate = rateOf(latest)!;

  const basePts = history.filter(p => p.scored >= t.minScored).slice(-t.baselineWindow);
  const baselineRate = median(basePts.map(p => rateOf(p)!).filter((x): x is number => x != null));

  // 1) behavior ceiling — absolute.
  if (rate > t.majorRateCeiling) {
    alerts.push({ kind: "behavior_ceiling", detail: `major wrong-answer rate ${(rate * 100).toFixed(1)}% > ceiling ${(t.majorRateCeiling * 100).toFixed(0)}%`, value: rate });
  }
  // 2) behavior delta — regression vs trailing baseline.
  if (baselineRate != null && rate - baselineRate > t.majorRateDeltaPts) {
    alerts.push({ kind: "behavior_delta", detail: `rate ${(rate * 100).toFixed(1)}% jumped +${((rate - baselineRate) * 100).toFixed(1)}pts vs baseline ${(baselineRate * 100).toFixed(1)}%`, value: rate - baselineRate });
  }
  // 3) distribution drift — any frame's share moved materially vs baseline.
  if (basePts.length) {
    const frames = new Set<string>();
    for (const f of Object.keys(latest.byFrame ?? {})) frames.add(f);
    for (const p of basePts) for (const f of Object.keys(p.byFrame ?? {})) frames.add(f);
    for (const f of frames) {
      const latestShare = frameShare(latest, f);
      const baseShare = median(basePts.map(p => frameShare(p, f)));
      if (baseShare != null && Math.abs(latestShare - baseShare) > t.frameShareDeltaPts) {
        alerts.push({ kind: "distribution", detail: `frame "${f}" share ${(latestShare * 100).toFixed(0)}% vs baseline ${(baseShare * 100).toFixed(0)}% (Δ${((latestShare - baseShare) * 100).toFixed(0)}pts)`, value: latestShare - baseShare });
      }
    }
  }
  return { rate, baselineRate, alerts };
}
