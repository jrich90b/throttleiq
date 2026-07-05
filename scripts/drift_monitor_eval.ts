/**
 * Drift-monitor eval (pure, no LLM) — pins evaluateDrift's three alert types + the no-alert paths.
 * Run: npx tsx scripts/drift_monitor_eval.ts
 */
import assert from "node:assert/strict";

import {
  evaluateDrift,
  DEFAULT_DRIFT_THRESHOLDS,
  type DriftPoint
} from "../services/api/src/domain/driftMonitor.ts";

const T = DEFAULT_DRIFT_THRESHOLDS; // ceiling 0.25, delta 0.08, frameΔ 0.15, window 7, minScored 10
const stableFrames = { stale_intent: 6, over_attached_model: 2, dropped_anchor: 2 };
const histStable: DriftPoint[] = Array.from({ length: 7 }, (_, i) => ({ at: `d${i}`, scored: 40, major: 4, byFrame: stableFrames })); // ~10% rate

// 1) Stable + latest in-line -> NO alerts.
{
  const r = evaluateDrift(histStable, { at: "now", scored: 40, major: 4, byFrame: stableFrames }, T);
  assert.equal(r.alerts.length, 0, `stable should not alert, got ${JSON.stringify(r.alerts)}`);
  assert.ok(r.baselineRate != null && Math.abs(r.baselineRate - 0.1) < 1e-9, "baseline ~10%");
}
// 2) Latest above the absolute ceiling -> behavior_ceiling.
{
  const r = evaluateDrift(histStable, { at: "now", scored: 40, major: 12, byFrame: stableFrames }, T); // 30%
  assert.ok(r.alerts.some(a => a.kind === "behavior_ceiling"), "30% must trip the ceiling");
}
// 3) Jump vs baseline but UNDER ceiling -> behavior_delta (not ceiling).
{
  const r = evaluateDrift(histStable, { at: "now", scored: 40, major: 9, byFrame: stableFrames }, T); // 22.5% vs 10% baseline (+12.5pts)
  assert.ok(r.alerts.some(a => a.kind === "behavior_delta"), "a +12.5pt jump must alert");
  assert.ok(!r.alerts.some(a => a.kind === "behavior_ceiling"), "22.5% is under the 25% ceiling");
}
// 4) Distribution drift — a new dominant frame, same overall rate.
{
  const skew = { stale_intent: 1, over_attached_model: 1, wrong_lead_type: 9 }; // wrong_lead_type share 22.5% vs ~0 baseline
  const r = evaluateDrift(histStable, { at: "now", scored: 40, major: 4, byFrame: skew }, T);
  assert.ok(r.alerts.some(a => a.kind === "distribution"), "a new dominant frame must alert distribution drift");
}
// 5) Too-few-scored latest -> NO alerts (noisy small N ignored).
{
  const r = evaluateDrift(histStable, { at: "now", scored: 5, major: 4, byFrame: stableFrames }, T); // 80% but N=5
  assert.equal(r.alerts.length, 0, "small-N points must not alert");
}
// 6) No baseline history yet -> ceiling can still fire, delta cannot.
{
  const r = evaluateDrift([], { at: "now", scored: 40, major: 14, byFrame: stableFrames }, T); // 35%
  assert.ok(r.alerts.some(a => a.kind === "behavior_ceiling"), "ceiling fires without history");
  assert.ok(!r.alerts.some(a => a.kind === "behavior_delta"), "delta needs a baseline");
  assert.equal(r.baselineRate, null, "no baseline with empty history");
}

console.log("PASS drift-monitor — 6 cases (stable, ceiling, delta, distribution, small-N, no-history); 3 alert types pinned.");
