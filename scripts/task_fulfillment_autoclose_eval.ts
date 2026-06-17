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

// --- Eligibility: all OPEN call + follow-up tasks ---
assert.equal(isAutoCloseEligibleTask({ status: "open", reason: "call" }), true, "open call task eligible");
assert.equal(
  isAutoCloseEligibleTask({ status: "open", reason: "other", taskClass: "followup" }),
  true,
  "open follow-up task eligible regardless of reason"
);
assert.equal(
  isAutoCloseEligibleTask({ status: "open", reason: "pricing", taskClass: "todo" }),
  false,
  "a plain todo (not call, not follow-up) is not eligible"
);
assert.equal(
  isAutoCloseEligibleTask({ status: "open", reason: "service", taskClass: "appointment" }),
  false,
  "an appointment task is not eligible"
);
assert.equal(isAutoCloseEligibleTask({ status: "done", reason: "call" }), false, "a done task is never eligible");
assert.equal(isAutoCloseEligibleTask({ status: "open", reason: "other" }), false, "open 'other' with no follow-up class not eligible");

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
