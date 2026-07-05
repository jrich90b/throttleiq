/**
 * cadence_quality_enforce:eval — pins the SHADOW→ENFORCE flip for the cadence-quality judge.
 *
 * A 45-day backtest (scripts/cadence_judge_backtest.ts) found ~40% of proactive cadence touches were
 * low-value repeats/contentless pings, and the judge reliably kept the concrete ones (it correctly
 * suppressed a re-sent new-arrival alert to a stepped-back lead). ENFORCE (flag-gated, default off)
 * holds back a touch the judge verdicts `suppress` at >= the floor (default 0.90). First flip is
 * SUPPRESS-ONLY — hold/regenerate stay shadow. Fail-direction: default off = zero behavior change;
 * on, it only ever WITHHOLDS a proactive touch (never sends more), and the deterministic floor bounds it.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  decideCadenceQualityGate,
  isCadenceQualityEnforceEnabled,
  cadenceQualityEnforceFloor
} from "../services/api/src/domain/draftQualityGate.ts";

const v = (over: Record<string, unknown> = {}) => ({
  overall: "suppress",
  confidence: 0.9,
  sendWorthy: false,
  stateFit: true,
  toneOk: true,
  dispositionOk: true,
  reason: "contentless repeat",
  ...over
}) as any;

// --- ENFORCE gate decision (enabled=true, floor 0.90) ---
{
  const d = decideCadenceQualityGate({ enabled: true, verdict: v({ confidence: 0.9 }), minConfidence: 0.9 });
  assert.equal(d.action, "suppress", "suppress @0.90 with floor 0.90 → suppress");
  assert.equal(d.live, true, "enforce enabled → live");
}
{
  const d = decideCadenceQualityGate({ enabled: true, verdict: v({ confidence: 0.88 }), minConfidence: 0.9 });
  assert.equal(d.action, "pass", "suppress @0.88 below the 0.90 floor → pass (not enforced)");
  assert.equal(d.reason, "below_confidence");
}
{
  const d = decideCadenceQualityGate({ enabled: true, verdict: v({ overall: "good", confidence: 0.99 }), minConfidence: 0.9 });
  assert.equal(d.action, "pass", "a good touch always passes");
}
{
  // hold/regenerate must NOT be enforced by the suppress-only first flip.
  const hold = decideCadenceQualityGate({ enabled: true, verdict: v({ overall: "hold", confidence: 0.95 }), minConfidence: 0.9 });
  assert.equal(hold.action, "hold", "hold verdict → hold (the caller only suppresses on action === suppress)");
  const regen = decideCadenceQualityGate({ enabled: true, verdict: v({ overall: "needs_regenerate", confidence: 0.95 }), minConfidence: 0.9 });
  assert.equal(regen.action, "regenerate", "regenerate verdict → regenerate (not suppressed by the first flip)");
}

// --- Flag defaults: OFF (shadow) and floor 0.90 ---
const savedEnforce = process.env.CADENCE_QUALITY_ENFORCE;
const savedFloor = process.env.CADENCE_QUALITY_ENFORCE_MIN_CONFIDENCE;
delete process.env.CADENCE_QUALITY_ENFORCE;
delete process.env.CADENCE_QUALITY_ENFORCE_MIN_CONFIDENCE;
assert.equal(isCadenceQualityEnforceEnabled(), false, "CADENCE_QUALITY_ENFORCE defaults OFF (shadow, no behavior change)");
assert.equal(cadenceQualityEnforceFloor(), 0.9, "enforce floor defaults to 0.90 (the backtest breakpoint)");
process.env.CADENCE_QUALITY_ENFORCE = "1";
assert.equal(isCadenceQualityEnforceEnabled(), true, "CADENCE_QUALITY_ENFORCE=1 enables enforcement");
process.env.CADENCE_QUALITY_ENFORCE_MIN_CONFIDENCE = "0.92";
assert.equal(cadenceQualityEnforceFloor(), 0.92, "the floor is env-tunable");
process.env.CADENCE_QUALITY_ENFORCE_MIN_CONFIDENCE = "bogus";
assert.equal(cadenceQualityEnforceFloor(), 0.9, "an invalid floor falls back to 0.90");
if (savedEnforce === undefined) delete process.env.CADENCE_QUALITY_ENFORCE; else process.env.CADENCE_QUALITY_ENFORCE = savedEnforce;
if (savedFloor === undefined) delete process.env.CADENCE_QUALITY_ENFORCE_MIN_CONFIDENCE; else process.env.CADENCE_QUALITY_ENFORCE_MIN_CONFIDENCE = savedFloor;

// --- Wiring in the cadence loop (index.ts) ---
const src = fs.readFileSync(path.resolve("services/api/src/index.ts"), "utf8");
assert.match(src, /if \(isCadenceQualityEnforceEnabled\(\)\) \{[\s\S]{0,400}enfDecision\?\.action === "suppress"/, "the cadence loop must gate on enforce + a suppress decision before the send branches");
assert.match(src, /\[followup\]\[cadence-quality-enforce\] suppressed low-value proactive touch/, "a suppressed touch is logged");
assert.match(src, /enfDecision\?\.action === "suppress"[\s\S]{0,200}advanceFollowUpCadence\(conv, cfg\.timezone\)[\s\S]{0,40}continue;/, "on suppress the loop advances the cadence and skips the send");
assert.match(src, /if \(!isCadenceQualityEnforceEnabled\(\)\)\s*\n?\s*void runCadenceQualityJudgeShadow/, "the shadow fire-and-forget is skipped under enforce (no double-judge)");
assert.match(src, /runCadenceQualityJudgeShadow[\s\S]{0,120}Promise<CadenceQualityGateDecision \| null>/, "the judge returns the gate decision so the caller can enforce");

console.log("PASS cadence-quality enforce eval (gate floor + suppress-only + flag defaults + loop wiring)");
