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

// ---------------------------------------------------------------------------
// REPLY-OWED deterministic closer (Joe ruling 2026-07-23, part 1 of 3).
//
// A "needs YOUR reply" task exists for exactly one reason: the customer wrote in on a thread staff
// owns, and staff owes them a reply (human-mode re-engagement PR #223, and owner-thread step-back).
// For THAT task the reply ITSELF is the accomplishment — there is no separate objective to judge.
// The LLM fulfillment judge kept them open on a promise-shaped reply: Curtis Samuel (+17163812367,
// 2026-07-23) — task created 17:46:46, Joe replied 17:47:41 ("Ok, we will try to call and see if
// they can do a 2nd review on the app. Ill let you know how we make out."), verdict came back
// not_fulfilled ("Dealer did not directly…") and the task sat open. So close these
// DETERMINISTICALLY on the first real staff outbound after creation, no judge — mirroring the
// first-touch closer (#253) and the context-fidelity held-flag clear-on-send.
//
// AGENTS.md bucket: SIDE-EFFECT / STATE gate (deterministic is allowed; this reads OUR OWN task
// summary, never customer intent). Fail direction: closing on a real staff send IS the objective,
// and any further customer inbound mints a fresh reply-owed task — so an early close can never
// silently drop a live lead. The failure we are fixing (task nags after staff already replied) is
// the costly one.
// ---------------------------------------------------------------------------

/**
 * Marker substrings for the reply-owed family. There are FOUR generators in index.ts, not two:
 *   "… replied while you have this thread: \"X\" — needs YOUR reply."            (index.ts ~61499)
 *   "… replied to your thread (addressed you by name): \"X\" — needs YOUR reply" (index.ts ~60107)
 *   "Deal in process — <name> replied: \"X\" — needs your answer."               (index.ts ~60014)
 *   "Deal in process (<signal>) — <name> said: \"X\" — needs your answer."       (index.ts ~60066)
 *
 * The original constant matched only the first two, so the in-process-deal pair never reached the
 * deterministic closer and fell through to the LLM fulfillment judge — which keeps saying
 * "not fulfilled" on an ordinary human reply, exactly the Curtis Samuel failure this closer exists
 * to prevent. Tim Williams (+17163741119): task open, Joe replied 2026-07-29T19:56:06Z, task still
 * nagging at 20:08 when he filed the report; it only cleared at 21:11. Live counts at the time of
 * this fix: `needs YOUR reply` 43 ever / 0 open (median close 2.7 min), `needs your answer`
 * 11 ever / 2 STILL OPEN.
 *
 * Matched here rather than by renaming the copy: the operator-visible "needs your answer" wording
 * is pinned by in_process_deal:eval, and the two phrasings say different things to staff.
 */
export const REPLY_OWED_TODO_MARKER = "needs YOUR reply";
/** The in-process-deal phrasing of the same "staff owes this customer a reply" task. */
export const REPLY_OWED_TODO_MARKER_DEAL = "needs your answer";

export function isReplyOwedTask(task: { status?: string | null; summary?: string | null }): boolean {
  if (String(task?.status ?? "") !== "open") return false;
  const summary = String(task?.summary ?? "");
  return summary.includes(REPLY_OWED_TODO_MARKER) || summary.includes(REPLY_OWED_TODO_MARKER_DEAL);
}

export type ReplyOwedCloseDecision = { close: boolean; reason: string };

/**
 * Pure. A reply-owed task closes on the first REAL staff/agent outbound sent AFTER it was created.
 * Not a staff outbound, or an outbound that predates the task, leaves it open.
 */
export function decideReplyOwedTaskClose(input: {
  task: { status?: string | null; summary?: string | null; createdAt?: string | null };
  /** true only for a delivered staff/agent OUTBOUND (SMS/email) — never an inbound trigger. */
  isStaffOutbound: boolean;
  outboundAtMs: number;
}): ReplyOwedCloseDecision {
  if (!isReplyOwedTask(input.task)) return { close: false, reason: "not_reply_owed" };
  if (!input.isStaffOutbound) return { close: false, reason: "not_staff_outbound" };
  if (!Number.isFinite(input.outboundAtMs)) return { close: false, reason: "no_outbound_time" };
  const createdMs = input.task?.createdAt ? Date.parse(String(input.task.createdAt)) : NaN;
  if (Number.isFinite(createdMs) && input.outboundAtMs <= createdMs) {
    return { close: false, reason: "outbound_not_after_creation" };
  }
  return { close: true, reason: "staff_reply_is_accomplishment" };
}

// ---------------------------------------------------------------------------
// MEDIA-ONLY outbound visibility (Joe ruling 2026-07-23, part 2 of 3).
//
// A picture-only MMS has an EMPTY body, so it was invisible to the fulfillment auto-closer twice
// over: the runner bailed on an empty action text, and the activity window it hands the classifier
// drops empty-body messages. Safvan (+18728882220, 2026-07-22): the salesman sent 3 pictures against
// the task "Manual follow-up: send photos for the unlisted/back-room bike" and the verdict came back
// "No photos/details were delivered." — because the closer literally could not see them.
//
// This renders OUR OWN outbound media as a short structured line so the classifier can judge it. The
// fulfillment verdict itself stays with the parser (comprehension); this is structured description of
// our own send, not customer-intent detection. Fail direction: a missing/zero count just yields "" and
// the closer behaves exactly as before.
// ---------------------------------------------------------------------------

/** Structured one-liner describing media attached to one of OUR outbound messages. "" when none. */
export function describeOutboundMedia(mediaCount: number | null | undefined): string {
  const raw = Number(mediaCount);
  if (!Number.isFinite(raw) || raw <= 0) return "";
  const n = Math.round(raw);
  return `[dealer sent ${n} photo${n === 1 ? "" : "s"} (picture-only message, no text)]`;
}

/** Activity/action text for one of OUR outbound messages, folding in media when the body is empty. */
export function outboundActivityText(body: string | null | undefined, mediaCount?: number | null): string {
  const text = String(body ?? "").replace(/\s+/g, " ").trim();
  const media = describeOutboundMedia(mediaCount);
  if (text && media) return `${text} ${media}`;
  return text || media;
}

export type TaskFulfillmentActivityItem = { direction: "in" | "out"; channel: "sms" | "email" | "call"; text: string };

/** Provider -> the channel the classifier reasons about. */
export function activityChannelForProvider(provider: string | null | undefined): "sms" | "email" | "call" {
  const p = String(provider ?? "");
  if (p === "sendgrid" || p === "sendgrid_adf") return "email";
  return p.startsWith("voice") ? "call" : "sms";
}

/**
 * The window the fulfillment classifier judges, plus WHEN that window ends. Lifted out of index.ts
 * verbatim so it sits beside `decideTaskAutoClose`, whose `latestActivityAtMs` guard is a statement
 * ABOUT this window: the judge may only close a task that is older than the newest thing it read.
 * Keeping the two apart is how the window silently drifted past the guard in the first place.
 *
 * `latestActivityAtMs` is the newest parsed message timestamp in the WHOLE thread, not just the
 * 8-message slice — an older slice can only ever make the guard stricter, never looser, and reading
 * the true newest message is what makes "nothing has happened since" mean what it says. NaN when the
 * thread carries no parseable timestamp, which switches the guard off rather than guessing.
 */
export function buildTaskFulfillmentActivityWindow(
  messages: readonly any[] | null | undefined,
  action: { channel: "sms" | "email" | "call"; text: string; direction?: "out" | "in"; mediaCount?: number | null },
  actionText: string
): { activity: TaskFulfillmentActivityItem[]; latestActivityAtMs: number } {
  const list = Array.isArray(messages) ? messages : [];
  const activity = list
    .slice(-8)
    .map((m: any) => ({
      direction: (m?.direction === "in" ? "in" : "out") as "in" | "out",
      channel: activityChannelForProvider(m?.provider),
      // Outbound media-only messages carry no body — describe them, or the classifier concludes
      // "no photos were delivered" while the salesman was staring at 3 sent pictures.
      text:
        m?.direction === "in"
          ? String(m?.body ?? "")
          : outboundActivityText(m?.body, Array.isArray(m?.mediaUrls) ? m.mediaUrls.length : 0)
    }))
    .filter(a => a.text.trim());
  // For an OUTBOUND trigger (a staff/agent send), make sure that just-sent message is the final item
  // even if message-append timing differs. For an INBOUND trigger (a customer closure like "I'm all
  // set"), the window already ends with that inbound — do NOT push it as an out action; the
  // classifier still requires a prior dealer OUT in the window to have fulfilled anything.
  if (
    (action.direction ?? "out") !== "in" &&
    (!activity.length || activity[activity.length - 1].text.replace(/\s+/g, " ").trim() !== actionText)
  ) {
    activity.push({ direction: "out", channel: action.channel, text: actionText });
  }
  let latestActivityAtMs = NaN;
  for (const m of list) {
    const t = Date.parse(String(m?.at ?? ""));
    if (Number.isFinite(t) && (!Number.isFinite(latestActivityAtMs) || t > latestActivityAtMs)) latestActivityAtMs = t;
  }
  return { activity, latestActivityAtMs };
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

// ---------------------------------------------------------------------------
// QUIET-TRIGGERED tasks may only be closed by NEW dealer activity (+19074412693, reported 7/19).
//
// Three task generators mint a task precisely BECAUSE the thread has gone quiet — the stale-handoff
// safety net ("no activity in N days"), the in-process-deal nudge ("quiet since <date>") and the
// no-reply call prompt ("No reply after N texts"). Each one ASSERTS, at creation, that everything
// already in the thread failed to move the lead. But the fulfillment closer judges a task against a
// window of the last 8 messages with no lower time bound, and the auto-close BACKFILL sweeps in the
// SAME maintenance tick that mints them — so the task was created at second 0 and closed at second 6
// by the very message whose silence created it.
//
// Live evidence (AH store, 2026-08-03): 143 of 400 high-confidence auto-closes fired within 120s of
// their task's creation, dominated by these three families — e.g. "Follow up with Kt — handed off
// (apparel request), no activity in 19 days" closed 3.3s later by a 19-day-old message, and Roger
// McCleskey (+19074412693) whose credit-app handoff task and both later nudges were each closed in
// under 10s by the same 7/18 "I received your credit application" text. That is what the operator
// reported as "i don't see the finance outcome task anymore on this lead".
//
// Rule: a quiet-triggered task closes only on a fresh dealer OUTBOUND trigger. An inbound trigger or
// a backfill re-check cannot introduce dealer activity the task did not already discount — if a
// pre-existing outbound HAD fulfilled it, that outbound's own trigger would have closed it before
// the quiet sweep ever minted the task.
//
// AGENTS.md bucket: SIDE-EFFECT / STATE gate (deterministic allowed; it reads OUR OWN task summary,
// never customer intent) — same shape as decideReplyOwedTaskClose's "outbound_not_after_creation".
// FAIL DIRECTION: this only ever REFUSES a close, so it fails toward a task staying in the inbox for
// staff, never toward silently dropping a live lead. Staff's next real send closes it normally.
// ---------------------------------------------------------------------------

/**
 * Marker substrings for the quiet-triggered family, matched against OUR OWN generated summaries:
 *   "Follow up with <who> — handed off (<x>), no activity in <n> days …" (index.ts ~32739)
 *   "Nudge <who>? Deal in process (<x>), quiet since <date> …"           (index.ts ~33095)
 *   "No reply after <n> texts - worth a quick call."                     (index.ts ~34454)
 */
export const QUIET_TRIGGERED_TODO_MARKERS = ["no activity in ", "quiet since ", "No reply after "] as const;

export function isQuietTriggeredTask(task: { summary?: string | null }): boolean {
  const summary = String(task?.summary ?? "");
  return QUIET_TRIGGERED_TODO_MARKERS.some(marker => summary.includes(marker));
}

// ---------------------------------------------------------------------------
// A "book this visit" task closes on the CALENDAR, never on the conversation (+17168603628,
// reported 2026-08-20).
//
// The scheduling-leak safety net mints exactly one task per stalled thread: "Schedule the visit for
// <who> — a time was discussed but nothing is booked. Confirm a time (check availability) and put it
// on the calendar." Its objective is a STATE FACT (an appointment exists), not a conversational one,
// and it already HAS a purpose-built closer: the state-reconcile pass retires it the moment
// isSchedulingLeakConversation goes false — once the visit is booked, the lead closes, or it ages out.
//
// The LLM fulfillment judge is a second, competing closer that reads the last 8 messages and closes
// the task when the TALK looks settled. Lance Scarafia (+17168603628, 2026-08-17): the rep asked
// "Would you like to schedule your 1,000 mile service for Thursday 9/3?", Lance replied "Yes", the
// rep said "Thank you!" — and the judge closed the booking task at 0.90 ("customer replied 'Yes' and
// dealer acknowledged"). `conv.appointment` is absent to this day. Three days later the leak detector
// re-minted the task (scheduling_leak_flagged, 2026-08-20T19:17Z) and the cycle restarts.
//
// MEASURED on the live store (route audit, 181 daily files): of 545 auto-closes, 39 were this task
// family across 21 conversations — and 18 of the 21 have NO appointment record at all. The 3 that DID
// book would have been retired by the reconcile pass regardless, so refusing them here costs nothing.
//
// AGENTS.md bucket: INVARIANT GUARD / side-effect gate (deterministic allowed; it matches OUR OWN
// generated task summary and reads OUR OWN appointment state, never customer intent). FAIL DIRECTION:
// it can only ever REFUSE a close, so it fails toward a "book this visit" task staying in the staff
// inbox — never toward a discussed-but-unbooked visit going quiet. That is the direction the booking
// funnel needs.
//
// Deliberately NOT gated on isSchedulingLeakConversation: that predicate requires the thread to be
// IDLE for hours, and this hook runs seconds after a message — the guard would have shipped inert.
// ---------------------------------------------------------------------------

/**
 * The scheduling-leak task's summary marker. Owned here rather than inline in index.ts so the
 * generator, the reconcile-pass retirement, and this guard all read ONE spelling — two copies of a
 * marker is how a family silently stops matching on one side of the fence.
 */
export const SCHEDULING_LEAK_TODO_MARKER = "a time was discussed but nothing is booked";

export function isSchedulingLeakTask(task: { summary?: string | null }): boolean {
  return String(task?.summary ?? "").includes(SCHEDULING_LEAK_TODO_MARKER);
}

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
  /** The task itself, when the caller has it — required to apply the quiet-triggered guard. */
  task?: { summary?: string | null } | null;
  /** true only when this run was triggered by a fresh dealer OUTBOUND (not an inbound / backfill). */
  dealerOutboundTrigger?: boolean;
  /**
   * Is the visit actually on the books? Same expression the sibling soft-close referee uses
   * (`!!conv.appointment?.bookedEventId`). Required to close a scheduling-leak task; a
   * console-confirmed appointment with no calendar event still retires via the reconcile pass, so
   * a strict reading here strands nothing.
   */
  appointmentBooked?: boolean;
  /**
   * When the task was created, and the newest message in the window this verdict was drawn from.
   *
   * WHY (live defect, 2026-08-22, +17163164302 Robert Guarino): Joe brought PARTS into the thread at
   * 15:55:29Z, the task was minted the same second, and the backfill re-check closed it 54 seconds
   * later at 0.90 — citing photos the customer sent at 13:43Z and a reply at 14:04Z, two hours
   * BEFORE the task existed. Nobody from Parts had touched it, and Brandon opened the console to an
   * empty list. The window is built ONCE per run from the last 8 messages and judged against every
   * eligible task, so a task minted after that history is graded on evidence that cannot be about it.
   *
   * The deterministic sibling closer has always had exactly this rule
   * (`outbound_not_after_creation`, decideReplyOwedAutoClose above). The LLM path did not. Measured
   * over every department task ever filed (37): 9 were auto-closed by this judge, and Robert's 54
   * seconds is the fastest by two orders of magnitude (next 620s, median 6.2h) because his invite
   * landed on a thread whose relevant exchange had already happened.
   *
   * Both are optional and the guard is `Number.isFinite`-gated on BOTH: a caller that cannot supply
   * them reproduces the pre-2026-08-22 behaviour exactly, rather than stranding every task forever.
   */
  taskCreatedAtMs?: number;
  latestActivityAtMs?: number;
}): TaskAutoCloseDecision {
  const min = input.minConfidence ?? TASK_AUTO_CLOSE_MIN_CONFIDENCE;
  if (!input.eligible) return { close: false, reason: "ineligible_task" };
  if (!input.verdict) return { close: false, reason: "no_verdict" };
  if (!input.verdict.fulfilled) return { close: false, reason: "not_fulfilled" };
  if (!(typeof input.verdict.confidence === "number" && input.verdict.confidence >= min)) {
    return { close: false, reason: "below_confidence" };
  }
  // A task minted BECAUSE the thread went quiet cannot be fulfilled by what was already in the
  // thread. Reported BEFORE the flag check so the shadow log shows the real blocker.
  if (input.task && isQuietTriggeredTask(input.task) && !input.dealerOutboundTrigger) {
    return { close: false, reason: "quiet_task_needs_new_outbound" };
  }
  // A "put it on the calendar" task is fulfilled by an appointment, not by a settled-sounding
  // conversation. Reported BEFORE the flag check, same as the quiet guard, so the shadow log names
  // the real blocker.
  if (input.task && isSchedulingLeakTask(input.task) && !input.appointmentBooked) {
    return { close: false, reason: "booking_task_needs_a_booked_appointment" };
  }
  // NOTHING has happened since this task was minted, so every word the judge read predates it and
  // cannot be about it. Reported BEFORE the flag check, same as the two guards above, so the shadow
  // log names the real blocker. Applies to EVERY task class on purpose: the defect is a property of
  // the window, not of any one family.
  if (
    Number.isFinite(input.taskCreatedAtMs as number) &&
    Number.isFinite(input.latestActivityAtMs as number) &&
    (input.latestActivityAtMs as number) <= (input.taskCreatedAtMs as number)
  ) {
    return { close: false, reason: "task_newer_than_its_evidence" };
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
