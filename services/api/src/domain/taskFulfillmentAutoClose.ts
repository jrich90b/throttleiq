/**
 * Task-fulfillment auto-close — pure eligibility + gating decision.
 *
 * When staff follow up with a customer (SMS, email, or a logged call) in a way
 * that ACCOMPLISHES an open task's objective, that task should close itself.
 * Example (Don Pagels, Lead Ref 11384): an open call task "Notify Don when the
 * 2016 Freewheeler trade arrives or is ready to show" stayed Open even after the
 * outbound text "we got that deal finalized on the freewheeler, so it is
 * available" fulfilled it. Today only a REACHED voice attempt closes call tasks
 * (markOpenCallTodosDoneForCompletedVoiceAttempt) — bluntly, and SMS/email close
 * nothing.
 *
 * Whether an action fulfills a task is COMPREHENSION — a typed LLM parser
 * (classifyTaskFulfillmentWithLLM) reads the task objective + the action and
 * returns a per-task verdict. This module is the deterministic gate around that
 * verdict: which tasks are eligible, and whether a verdict is strong enough to
 * close.
 *
 * PURE + fail-safe: a wrong CLOSE silently drops a customer follow-up, so any
 * uncertainty resolves to close=false (leave the task open; staff close it by
 * hand). SHIPS DARK: with TASK_FULFILLMENT_AUTOCLOSE unset/0, `enabled` is false
 * ⇒ close=false always (the decision is still computed + logged in shadow). The
 * live cutover (flag on) is approve-first.
 */

/** Eligible task reasons/classes the user opted in to: all open call + follow-up tasks. */
export function isAutoCloseEligibleTask(task: {
  status?: string | null;
  reason?: string | null;
  taskClass?: string | null;
}): boolean {
  if (String(task?.status ?? "") !== "open") return false;
  const reason = String(task?.reason ?? "");
  const taskClass = String(task?.taskClass ?? "");
  // Let the parser-first fulfillment classifier (0.85, accomplished-not-promised) decide for
  // ANY customer-facing task. A blunt reason allowlist was making the comprehension call and
  // wrongly KEEPING answered questions open — Paul Foley (6/22): a parts AVAILABILITY question
  // ("do you have a Saddlemen Road Sofa seat?") answered "ya we have some" stayed open because
  // reason=parts was excluded. The classifier already separates an answered question (close)
  // from a promise / work-not-done ("we'll order it" => stays open), so eligibility should not
  // pre-judge by reason. Only exclude structurally non-fulfillable types: an internal `note`,
  // and `appointment` tasks (which close via the appointment OUTCOME flow — showed/no-show/
  // sold — not via fulfillment).
  if (reason === "note") return false;
  if (taskClass === "appointment") return false;
  return true;
}

export type TaskFulfillmentVerdict = {
  taskId: string;
  /** Did the action accomplish the task's objective (not merely promise to)? */
  fulfilled: boolean;
  /** 0..1. */
  confidence: number;
  evidence?: string;
};

/** Minimum confidence to auto-close. High by design — biased toward leaving open. */
export const TASK_AUTO_CLOSE_MIN_CONFIDENCE = 0.85;

export type TaskAutoCloseDecision = { close: boolean; reason: string };

/**
 * Pure. Returns close=true ONLY for an enabled flag + eligible task + a fulfilled
 * verdict at/above the confidence floor. When the verdict WOULD close but the flag
 * is off, returns close=false with reason "shadow_would_close" so the caller can
 * log exactly what a live cutover would have done. Every other state is a plain
 * no-close.
 */
export function decideTaskAutoClose(input: {
  enabled: boolean;
  eligible: boolean;
  verdict: TaskFulfillmentVerdict | null;
  minConfidence?: number;
}): TaskAutoCloseDecision {
  const min = input.minConfidence ?? TASK_AUTO_CLOSE_MIN_CONFIDENCE;
  if (!input.eligible) return { close: false, reason: "ineligible_task" };
  if (!input.verdict) return { close: false, reason: "no_verdict" };
  if (!input.verdict.fulfilled) return { close: false, reason: "not_fulfilled" };
  if (!(typeof input.verdict.confidence === "number" && input.verdict.confidence >= min)) {
    return { close: false, reason: "below_confidence" };
  }
  if (!input.enabled) return { close: false, reason: "shadow_would_close" };
  return { close: true, reason: "fulfilled_high_confidence" };
}

/** Reads TASK_FULFILLMENT_AUTOCLOSE. Default OFF (dark). */
export function isTaskFulfillmentAutoCloseEnabled(): boolean {
  const raw = String(process.env.TASK_FULFILLMENT_AUTOCLOSE ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

/**
 * Reads TASK_FULFILLMENT_AUTOCLOSE_SHADOW. Default ON so the live hook records what
 * it WOULD close while dark; set to 0 to silence the shadow parser entirely.
 */
export function taskFulfillmentAutoCloseShadowEnabled(): boolean {
  const raw = String(process.env.TASK_FULFILLMENT_AUTOCLOSE_SHADOW ?? "1").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}
