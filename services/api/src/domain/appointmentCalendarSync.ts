/**
 * Booked-appointment ↔ Google Calendar reconcile — pure decision. LeadRider's store is only
 * updated by its OWN edit paths (console PATCH, booking flows); an edit made DIRECTLY in Google
 * Calendar (dragging the event to a new time, deleting it) never reached the store, so the task
 * card and any appointment-status answer kept asserting the old slot (operator-reported,
 * +17163975098 Kody: calendar moved 3:00→4:00 PM, the task still said 3:00). The tick's sweep
 * reads each FUTURE booked event back from Google and applies this decision.
 *
 * FAIL DIRECTION: this only reconciles OUR OWN booked event against the calendar that staff
 * treat as the source of truth. Anything uncertain (unparseable start, missing status, fetch
 * failure upstream) resolves to "noop" — a stale display is strictly better than wrongly
 * clearing a real appointment. "clear_cancelled" fires only on an explicit cancelled status.
 */

export type CalendarEventReconcile =
  | { kind: "noop"; reason: string }
  | { kind: "update_time"; whenIso: string }
  | { kind: "clear_cancelled" };

/** Tolerance below which a start-time difference is clock noise, not an edit. */
export const CALENDAR_SYNC_MIN_DRIFT_MS = 60_000;

export function decideCalendarEventReconcile(input: {
  storedWhenIso: string | null | undefined;
  eventStartIso: string | null | undefined;
  eventStatus: string | null | undefined; // Google event.status: confirmed | tentative | cancelled
}): CalendarEventReconcile {
  const status = String(input.eventStatus ?? "").trim().toLowerCase();
  if (status === "cancelled") return { kind: "clear_cancelled" };
  const storedMs = Date.parse(String(input.storedWhenIso ?? ""));
  const eventMs = Date.parse(String(input.eventStartIso ?? ""));
  if (!Number.isFinite(storedMs) || !Number.isFinite(eventMs)) {
    return { kind: "noop", reason: "unparseable_time" };
  }
  if (Math.abs(eventMs - storedMs) < CALENDAR_SYNC_MIN_DRIFT_MS) {
    return { kind: "noop", reason: "in_sync" };
  }
  return { kind: "update_time", whenIso: new Date(eventMs).toISOString() };
}
