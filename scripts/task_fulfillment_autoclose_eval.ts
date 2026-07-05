/**
 * Task-fulfillment auto-close — deterministic gate eval.
 *
 * The "did this follow-up fulfill the task?" judgement is an LLM parser
 * (classifyTaskFulfillmentWithLLM, verified by the shadow backfill report). THIS
 * eval pins the pure, deterministic gate around that verdict: which tasks are
 * eligible (all open call + follow-up tasks, per Joe 2026-06-17) and whether a
 * verdict is strong enough — and ALLOWED by the dark flag — to actually close.
 *
 * Fail direction: a wrong CLOSE silently drops a customer follow-up, so the gate
 * must bias hard toward NOT closing — flag-off and any uncertainty => no close.
 */
import assert from "node:assert/strict";
import {
  isAutoCloseEligibleTask,
  decideTaskAutoClose,
  TASK_AUTO_CLOSE_MIN_CONFIDENCE
} from "../services/api/src/domain/taskFulfillmentAutoClose.ts";

// --- Eligibility: the 0.85 classifier decides for ANY customer-facing task. Only structurally
// non-fulfillable types are excluded: internal `note` + `appointment` taskClass (outcome flow).
// (Paul Foley 6/22: a parts AVAILABILITY question answered by text must be closeable.) ---
for (const reason of ["call", "pricing", "payments", "parts", "service", "apparel", "approval", "manager", "other"]) {
  assert.equal(
    isAutoCloseEligibleTask({ status: "open", reason, taskClass: "todo" }),
    true,
    `open ${reason} task is eligible — the classifier judges whether the objective was accomplished`
  );
}
assert.equal(
  isAutoCloseEligibleTask({ status: "open", reason: "other", taskClass: "followup" }),
  true,
  "open follow-up task eligible"
);
// Structural exclusions:
assert.equal(
  isAutoCloseEligibleTask({ status: "open", reason: "note", taskClass: "todo" }),
  false,
  "an internal note is not a customer task — not auto-closeable"
);
assert.equal(
  isAutoCloseEligibleTask({ status: "open", reason: "call", taskClass: "appointment" }),
  false,
  "an appointment task closes via its outcome flow, not fulfillment"
);
assert.equal(isAutoCloseEligibleTask({ status: "done", reason: "call" }), false, "a done task is never eligible");

// --- Gate: only enabled + eligible + fulfilled + confident closes ---
const fulfilledHigh = { taskId: "t1", fulfilled: true, confidence: 0.95, evidence: "x" };

assert.deepEqual(
  decideTaskAutoClose({ enabled: true, eligible: false, verdict: fulfilledHigh }),
  { close: false, reason: "ineligible_task" },
  "ineligible task never closes"
);
assert.deepEqual(
  decideTaskAutoClose({ enabled: true, eligible: true, verdict: null }),
  { close: false, reason: "no_verdict" },
  "no verdict => no close"
);
assert.deepEqual(
  decideTaskAutoClose({ enabled: true, eligible: true, verdict: { taskId: "t1", fulfilled: false, confidence: 0.99 } }),
  { close: false, reason: "not_fulfilled" },
  "not fulfilled => no close even at high confidence"
);
assert.deepEqual(
  decideTaskAutoClose({ enabled: true, eligible: true, verdict: { taskId: "t1", fulfilled: true, confidence: 0.5 } }),
  { close: false, reason: "below_confidence" },
  "fulfilled but low confidence => no close"
);

// Flag OFF (dark) — even a strong fulfilled verdict only SHADOWS.
assert.deepEqual(
  decideTaskAutoClose({ enabled: false, eligible: true, verdict: fulfilledHigh }),
  { close: false, reason: "shadow_would_close" },
  "dark: strong verdict reports shadow_would_close, never closes"
);

// Flag ON — strong verdict closes.
assert.deepEqual(
  decideTaskAutoClose({ enabled: true, eligible: true, verdict: fulfilledHigh }),
  { close: true, reason: "fulfilled_high_confidence" },
  "enabled + eligible + fulfilled + confident => close"
);

// Confidence floor is inclusive.
assert.equal(
  decideTaskAutoClose({
    enabled: true,
    eligible: true,
    verdict: { taskId: "t1", fulfilled: true, confidence: TASK_AUTO_CLOSE_MIN_CONFIDENCE }
  }).close,
  true,
  "confidence exactly at the floor closes"
);
assert.equal(
  decideTaskAutoClose({
    enabled: true,
    eligible: true,
    verdict: { taskId: "t1", fulfilled: true, confidence: TASK_AUTO_CLOSE_MIN_CONFIDENCE - 0.001 }
  }).close,
  false,
  "just below the floor does not close"
);

// Caller can raise (never silently lower) the floor.
assert.equal(
  decideTaskAutoClose({
    enabled: true,
    eligible: true,
    verdict: { taskId: "t1", fulfilled: true, confidence: 0.9 },
    minConfidence: 0.97
  }).close,
  false,
  "a stricter minConfidence is honored"
);

console.log("PASS task fulfillment auto-close gate eval");
