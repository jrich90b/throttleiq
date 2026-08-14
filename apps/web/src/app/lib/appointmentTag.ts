// "Appointment" inbox pill visibility.
//
// WHY THIS EXISTS. Booking appointments is the job, and until now the inbox list could not say
// who was booked. Every pill on an inbox row (Walk-in, Call only, Closed/Sold, On hold, Campaign
// sent/reply, Outcome) describes some other state; a confirmed appointment showed up ONLY in the
// conversation header, after you opened the thread. Staff reported it twice on the same lead
// (+17165230421, 2026-08-13: "It did make an appointment but just did not show the appointment
// scheduled tag in the inbox"). Measured on the live store the same day: 4 open threads carried a
// confirmed upcoming appointment — one of them later THAT DAY — and every one of the four also had
// zero open tasks, so the row rendered no due-chip either. Four leads coming in, invisible.
//
// FAIL DIRECTION: show nothing rather than something wrong. This pill only ever asserts an
// appointment that is (a) explicitly confirmed, (b) parseable, and (c) still in the future. A
// missing pill is the status quo staff already live with; a pill claiming a visit that was
// cancelled, never confirmed, or already happened is worse than no pill, because staff would plan
// their day around it. Everything unrecognised therefore reads as "no pill".
//
// The post-appointment half of the story is deliberately NOT ours: once the slot passes, the
// existing "Outcome" pill (hasOutcomeReminderSent / dealer-ride outcome) owns the row, and two
// pills competing to describe the same appointment is how a row stops being readable.

/** Statuses that mean "this visit is on the books". Anything else — "none", a cancel, an unknown
 *  future value — deliberately renders nothing. */
const BOOKED_STATUSES = new Set(["confirmed", "booked"]);

export type AppointmentTag = {
  /** Short pill text, e.g. "Appointment · in 4 days". */
  label: string;
  /** Hover text carrying the full stored time, e.g. "Appointment: Tue, Aug 18, 4:30 PM". */
  title: string;
};

/**
 * Resolve the inbox row's appointment pill, or null when the row should show nothing.
 *
 * `relativeLabel` is injected (the caller passes `relativeDueLabel` from lib/taskTriage) so this
 * stays a pure, executable predicate the eval can drive without pulling in the console's clock.
 */
export function resolveAppointmentTag(
  conversation: any,
  nowMs: number,
  relativeLabel?: (whenMs: number, nowMs: number) => string
): AppointmentTag | null {
  // A closed thread is history — the Closed/Sold pill already says what happened to it.
  if (String(conversation?.status ?? "").trim().toLowerCase() === "closed") return null;

  const appointment = conversation?.appointment;
  if (!appointment) return null;

  const status = String(appointment.status ?? "").trim().toLowerCase();
  if (!BOOKED_STATUSES.has(status)) return null;

  const whenIso = String(appointment.whenIso ?? "").trim();
  if (!whenIso) return null;
  const whenMs = new Date(whenIso).getTime();
  if (!Number.isFinite(whenMs)) return null;

  // Already happened ⇒ the Outcome pill's territory, not ours.
  if (whenMs <= nowMs) return null;

  const rel = relativeLabel ? String(relativeLabel(whenMs, nowMs) ?? "").trim() : "";
  const whenText = String(appointment.whenText ?? "").trim();

  return {
    label: rel ? `Appointment · ${rel}` : "Appointment",
    title: whenText ? `Appointment: ${whenText}` : "Appointment booked"
  };
}

/**
 * Does the appointment PILL already say what this task says?
 *
 * WHY (Joe, 2026-08-14, on Brent Marshall `+17169941544`: "why does Brent Marshall have two tags
 * in it for appointments in the inbox"). Booking a lead writes an `appointment` record AND an open
 * `taskClass: "appointment"` todo. The row's task chip has always shown the most urgent open task,
 * so that todo rendered as "Appointment task · tomorrow". Adding the pill the same morning made
 * the row say the same visit twice, side by side, both stamped with the same relative time. On the
 * live store every single booked row was doubled (4 of 4).
 *
 * This module's own header already warns that "two pills competing to describe the same
 * appointment is how a row stops being readable" — it guarded the Outcome pill and missed the task
 * chip. This closes that.
 *
 * FAIL DIRECTION: hiding real work is far worse than a duplicate tag, so this suppresses ONLY when
 * the task is provably about the appointment the pill is already showing:
 *   - the pill is actually rendering (no pill ⇒ the chip is the only surface, never suppress), AND
 *   - the task is appointment-class, AND
 *   - the task's OWN due time equals the appointment's time, to the millisecond.
 *
 * That last clause is deliberately exact rather than fuzzy. If the two disagree, they are
 * describing DIFFERENT times, and staff need to see both — that disagreement is a real defect we
 * have hit before (an appointment whose `whenText` and booked slot differ), and a tolerant match
 * would hide it. Read the task's own `dueAt`: `appointmentWhenIso` is stamped onto every task on a
 * booked conversation as row CONTEXT, so keying on it would suppress unrelated tasks.
 */
export function isTaskCoveredByAppointmentTag(
  task: any,
  conversation: any,
  hasAppointmentTag: boolean
): boolean {
  if (!hasAppointmentTag) return false;
  if (String(task?.taskClass ?? "").trim().toLowerCase() !== "appointment") return false;

  const apptMs = new Date(String(conversation?.appointment?.whenIso ?? "").trim()).getTime();
  if (!Number.isFinite(apptMs)) return false;

  const dueMs = new Date(String(task?.dueAt ?? "").trim()).getTime();
  if (!Number.isFinite(dueMs)) return false;

  return dueMs === apptMs;
}
