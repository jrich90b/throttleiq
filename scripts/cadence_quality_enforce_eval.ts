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
// On suppress the loop advances the cadence and skips the send — but it advances as a touch that
// NEVER HAPPENED. `stepIndex` moves (we tried this rung and had nothing worth saying) while
// lastSentAt/lastSentStep and the delivered-touch count do not, so a held message can never be read
// back as outreach. Before this, held rungs counted toward DISENGAGED_TAPER_AFTER_TOUCHES: measured
// on the live store 2026-08-04, 13 of 37 tapered leads had under 9 outbound messages of any kind,
// and only 2 of the 37 ever got the close-out. `endSequence` is the deliberate exception — holding
// the CLOSE-OUT still ends the ladder, because only the goodbye was withheld, not the decision.
assert.match(src, /enfDecision\?\.action === "suppress"[\s\S]{0,300}advanceFollowUpCadence\(conv, cfg\.timezone, \{ delivered: false, endSequence: disengagedCloseoutActive \}\)[\s\S]{0,40}continue;/, "on suppress the loop advances the cadence WITHOUT counting a touch, and skips the send");
assert.match(src, /if \(!isCadenceQualityEnforceEnabled\(\)\)\s*\n?\s*void runCadenceQualityJudgeShadow/, "the shadow fire-and-forget is skipped under enforce (no double-judge)");
// Window widened 120 -> 200: the signature grew an `enforcing?: boolean` opt (see the call-site pins below).
assert.match(src, /runCadenceQualityJudgeShadow[\s\S]{0,200}Promise<CadenceQualityGateDecision \| null>/, "the judge returns the gate decision so the caller can enforce");

// --- Each call site declares whether IT will honour a suppress (feeds cadenceQualityShadow.gateHeld) ---
// The persisted record must say whether the touch was actually held back, and only the CALLER knows:
// the awaited enforce call skips the send, the fire-and-forget shadow call never does. Both are inside
// this one cadence tick (which covers sms AND email via useEmail) — the inbound reply paths
// (/webhooks/twilio, /conversations/:id/regenerate) do not run this judge at all, so there is no third
// lane to keep in sync. If one is ever added it must choose an `enforcing` value deliberately, which is
// what these pins force. A wrong value here silently mislabels real customer-facing misses as "held".
{
  const marker = "runCadenceQualityJudgeShadow(";
  const sites = [...src.matchAll(/runCadenceQualityJudgeShadow\((?:[^;]|\n){0,400}?\)/g)]
    .map(m => m[0])
    .filter(s => !s.startsWith(`${marker}\n  conv: any`));
  assert.equal(sites.length, 2, `expected exactly 2 cadence-judge call sites, found ${sites.length}`);
  const awaited = sites.filter(s => /enforcing: true/.test(s));
  const shadowed = sites.filter(s => /enforcing: false/.test(s));
  assert.equal(awaited.length, 1, "exactly one call site declares it enforces (the awaited enforce gate)");
  assert.equal(shadowed.length, 1, "exactly one call site declares it does NOT enforce (the fire-and-forget shadow)");
  assert.match(src, /const enfDecision = await runCadenceQualityJudgeShadow[\s\S]{0,200}enforcing: true/, "the AWAITED enforce call is the one that claims to enforce");
  assert.match(src, /void runCadenceQualityJudgeShadow[\s\S]{0,200}enforcing: false/, "the fire-and-forget shadow call never claims to enforce");
  // The regenerate-path cadence composer is knowingly UN-judged; wiring it later must revisit this eval.
  assert.ok(
    !/buildCadenceRegeneratedDraft[\s\S]{0,600}runCadenceQualityJudgeShadow/.test(src),
    "the regenerate cadence composer does not run the judge — if that changes, it must pass `enforcing` deliberately"
  );
}

console.log("PASS cadence-quality enforce eval (gate floor + suppress-only + flag defaults + loop wiring)");
