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
  /** Dealer ENGAGED the objective but it now awaits the CUSTOMER (e.g. the dept responded / quoted a
   *  wait time, but the customer hasn't booked/decided). NOT fulfilled, but the dealer did their part —
   *  drives soft-close + nudge (re-surface) instead of leaving a department task nagging in the inbox. */
  engagedPendingCustomer?: boolean;
  /** Best-effort ISO date the dealer's reply implies for the next natural touch ("booking into late
   *  July" -> ~2026-07-27), or null/empty when none was named. Drives the nudge date. */
  deferUntil?: string | null;
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

// ---------------------------------------------------------------------------
// Department-handoff SOFT-CLOSE + NUDGE.
//
// A service/parts/apparel handoff task where the department RESPONDED but the customer hasn't booked
// (e.g. Danny Bostic, 2026-06-24: "we'd be happy to look at it but we're booking into the last week of
// July" — verdict not_fulfilled, correctly, because nothing was scheduled) would otherwise nag in the
// active inbox indefinitely. Joe's policy: SOFT-CLOSE it (snooze out of the urgent view) but NUDGE —
// re-surface it as a staff follow-up if the customer still hasn't booked by the window. No automatic
// customer message (suggest-mode safe). Reuses the snooze primitive: push dueAt to the nudge date; it
// drops out of overdue/today and auto-re-surfaces when the date passes. Booking closes it via the
// appointment-outcome flow before then. PURE; fail-safe (a wrong soft-close only delays a task ~3 days,
// and it always comes back). Ships DARK behind DEPARTMENT_TASK_SOFT_CLOSE_NUDGE.
// ---------------------------------------------------------------------------

/** Department-handoff task reasons eligible for soft-close + nudge. */
const DEPARTMENT_HANDOFF_REASONS = new Set(["service", "parts", "apparel"]);

export function isDepartmentHandoffTask(task: { reason?: string | null }): boolean {
  return DEPARTMENT_HANDOFF_REASONS.has(String(task?.reason ?? "").trim().toLowerCase());
}

/** Confidence floor to soft-close. Lower than the close floor (0.85) because a wrong soft-close is
 *  cheap (a ~3-day snooze that always re-surfaces), whereas a wrong close silently drops a follow-up. */
export const TASK_SOFT_CLOSE_MIN_CONFIDENCE = 0.8;

const SOFT_CLOSE_DAY_MS = 86_400_000;
const SOFT_CLOSE_DEFAULT_BUSINESS_DAYS = 3;
const SOFT_CLOSE_MIN_DAYS = 2;
const SOFT_CLOSE_MAX_DAYS = 45;

/** now + N business days (skips Sat/Sun). Pure; operates in UTC. */
export function addBusinessDays(now: Date, days: number): Date {
  const d = new Date(now.getTime());
  let added = 0;
  while (added < days) {
    d.setUTCDate(d.getUTCDate() + 1);
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) added += 1;
  }
  return d;
}

/**
 * The nudge (re-surface) date: the dealer's quoted timeframe when it's sane, else +N business days.
 * Clamped to [now+MIN, now+MAX] so we never nudge too soon (a same-day quote) or snooze a task into
 * oblivion (an absurd far-future parse). Pure.
 */
export function computeSoftCloseNudgeAt(deferUntilIso: string | null | undefined, now: Date): string {
  const minMs = now.getTime() + SOFT_CLOSE_MIN_DAYS * SOFT_CLOSE_DAY_MS;
  const maxMs = now.getTime() + SOFT_CLOSE_MAX_DAYS * SOFT_CLOSE_DAY_MS;
  const parsed = deferUntilIso ? new Date(String(deferUntilIso).trim()).getTime() : NaN;
  if (Number.isFinite(parsed)) {
    if (parsed >= minMs && parsed <= maxMs) return new Date(parsed).toISOString();
    if (parsed > maxMs) return new Date(maxMs).toISOString();
    // too soon (or in the past) -> fall through to the default window
  }
  return addBusinessDays(now, SOFT_CLOSE_DEFAULT_BUSINESS_DAYS).toISOString();
}

export type DepartmentSoftCloseDecision = { softClose: boolean; reason: string; nudgeAt: string | null };

/**
 * Pure. Returns softClose=true ONLY for: enabled flag + an OPEN department-handoff task not already
 * soft-closed + not already booked + a verdict that is NOT fulfilled but IS engaged-pending-customer at
 * or above the confidence floor. When it WOULD soft-close but the flag is off, returns softClose=false
 * with reason "shadow_would_soft_close" (+ the nudgeAt it would have used) so the caller can log it.
 * Runs AFTER decideTaskAutoClose returns not-close (a fulfilled task closes outright instead).
 */
export function decideDepartmentTaskSoftClose(input: {
  enabled: boolean;
  task: { status?: string | null; reason?: string | null; autoSoftCloseAt?: string | null };
  verdict: TaskFulfillmentVerdict | null;
  appointmentBooked: boolean;
  now: Date;
  minConfidence?: number;
}): DepartmentSoftCloseDecision {
  const min = input.minConfidence ?? TASK_SOFT_CLOSE_MIN_CONFIDENCE;
  if (String(input.task?.status ?? "") !== "open") return { softClose: false, reason: "not_open", nudgeAt: null };
  // Soft-close + nudge ONCE per task: when it re-surfaces at the nudge date it stays a normal active
  // task for staff to act on (no infinite snooze loop).
  if (input.task?.autoSoftCloseAt) return { softClose: false, reason: "already_soft_closed", nudgeAt: null };
  if (!isDepartmentHandoffTask(input.task)) return { softClose: false, reason: "not_department_task", nudgeAt: null };
  if (input.appointmentBooked) return { softClose: false, reason: "already_booked", nudgeAt: null };
  const v = input.verdict;
  if (!v) return { softClose: false, reason: "no_verdict", nudgeAt: null };
  if (v.fulfilled) return { softClose: false, reason: "fulfilled_closes_instead", nudgeAt: null };
  if (!v.engagedPendingCustomer) return { softClose: false, reason: "not_engaged_pending", nudgeAt: null };
  if (!(typeof v.confidence === "number" && v.confidence >= min)) {
    return { softClose: false, reason: "below_confidence", nudgeAt: null };
  }
  const nudgeAt = computeSoftCloseNudgeAt(v.deferUntil ?? null, input.now);
  if (!input.enabled) return { softClose: false, reason: "shadow_would_soft_close", nudgeAt };
  return { softClose: true, reason: "engaged_pending_soft_close", nudgeAt };
}

/** Reads DEPARTMENT_TASK_SOFT_CLOSE_NUDGE. Default OFF (dark). */
export function isDepartmentTaskSoftCloseEnabled(): boolean {
  const raw = String(process.env.DEPARTMENT_TASK_SOFT_CLOSE_NUDGE ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}
