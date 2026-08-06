/**
 * The canary must not fail a slice on a ratio it cannot support.
 *
 * WHY (measured, 2026-08-04 watch on `66e072eb`): this store produces ~2.3 drafts in an 8h slice.
 * A x2 increase bound therefore trips on THREE extra drafts, and the watch logged
 * `draftsProduced 2.33 -> 5 (x2.15, limit x2)` as a FAILURE against a healthy build. With
 * `failureLimit: 2`, two such false alarms auto-revert a good commit — the wolf-crying the
 * thresholds themselves name as the real failure mode. That watch sat at exactly 2 failures, one
 * slice away from reverting good work.
 *
 * This EXECUTES `decideCanaryVerdict` (scripts/ is not covered by tsc, and a source-text
 * assertion cannot prove a comparison still returns the right verdict). Both directions are pinned:
 * the false alarm must be gone AND every genuinely dangerous shape must still breach.
 */
import {
  decideCanaryVerdict,
  DEFAULT_CANARY_THRESHOLDS
} from "../services/api/src/domain/canaryHealth.ts";

type Case = { name: string; actual: unknown; expected: unknown };
const cases: Case[] = [];

// Baseline must clear `minBaselineOutbound` (20) and `minBaselineConversations` (8) or the verdict
// short-circuits to UNKNOWN before any comparison runs. Drafts stay at the store's real ~2.3/slice,
// which is the small denominator this eval is about.
const counters = (over: Record<string, number> = {}) => ({
  outboundToCustomer: 24,
  draftsProduced: 2.33,
  conversationsClosed: 1.2,
  draftsHeld: 0,
  activeConversations: 10,
  inboundFromCustomer: 18,
  ...over
});

const breachMetrics = (baseline: any, current: any): string[] => {
  const out = decideCanaryVerdict(baseline, current, DEFAULT_CANARY_THRESHOLDS);
  return (out.breaches ?? [])
    .filter((b: any) => b.kind === "increase")
    .map((b: any) => b.metric)
    .sort();
};

// ---- THE FALSE ALARM: the exact numbers off the 8/4 watch -------------------------------------
cases.push({
  name: "drafts 2.33 -> 5 (the observed false alarm) no longer breaches",
  actual: breachMetrics(counters(), counters({ draftsProduced: 5 })),
  expected: []
});

// A slightly bigger jump on the same tiny counter is still noise, not a revert-worthy event.
cases.push({
  name: "drafts 2.33 -> 7 is still under the absolute floor",
  actual: breachMetrics(counters(), counters({ draftsProduced: 7 })),
  expected: []
});

// ---- STILL FIRES: a genuine draft runaway clears both the ratio AND the floor -------------------
cases.push({
  name: "drafts 2.33 -> 30 still breaches",
  actual: breachMetrics(counters(), counters({ draftsProduced: 30 })),
  expected: ["draftsProduced"]
});

// ---- STILL FIRES: sending into SILENCE (no inbound => raw comparison, the strict path) ----------
cases.push({
  name: "sends 24 -> 59 into silence still breaches",
  actual: breachMetrics(
    counters({ inboundFromCustomer: 0 }),
    counters({ outboundToCustomer: 59, inboundFromCustomer: 0 })
  ),
  expected: ["outboundToCustomer"]
});

// ---- STILL FIRES: double-texting at FLAT volume. This is why the guard is NOT on the rate rule.
// 27 sends against 3 inbound is 9.0/inbound vs a baseline of 1.33 — the absolute delta is only
// +3, under the floor, so a delta guard on the rate path would have masked it.
cases.push({
  name: "double-texting at flat volume still breaches via the per-inbound rate",
  actual: breachMetrics(
    counters(),
    counters({ outboundToCustomer: 27, inboundFromCustomer: 3 })
  ),
  expected: ["outboundToCustomer"]
});

// ---- The busy-morning case the rate rule already fixed must stay fixed --------------------------
cases.push({
  name: "busy morning (70 sends, 50 inbound) still passes",
  actual: breachMetrics(
    counters(),
    counters({ outboundToCustomer: 70, inboundFromCustomer: 50, activeConversations: 18 })
  ),
  expected: []
});

// ---- A zero baseline still has no ratio ---------------------------------------------------------
cases.push({
  name: "0 -> 4 on a zero baseline still does not breach",
  actual: breachMetrics(counters({ draftsHeld: 0 }), counters({ draftsHeld: 4 })),
  expected: []
});

// ---- The threshold is wired, not just declared ---------------------------------------------------
cases.push({
  name: "minIncreaseDelta is set on the shipped defaults",
  actual: typeof DEFAULT_CANARY_THRESHOLDS.minIncreaseDelta === "number" &&
    DEFAULT_CANARY_THRESHOLDS.minIncreaseDelta > 0,
  expected: true
});

let failed = 0;
for (const c of cases) {
  const ok = JSON.stringify(c.actual) === JSON.stringify(c.expected);
  if (!ok) failed++;
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${c.name}${ok ? "" : ` — expected ${JSON.stringify(c.expected)}, got ${JSON.stringify(c.actual)}`}`
  );
}
console.log(`\ncanary_small_denominator: ${cases.length - failed}/${cases.length} passed`);
if (failed) process.exit(1);
