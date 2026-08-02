/**
 * Appointment calendar-sync eval (decideCalendarEventReconcile + the tick sweep wiring).
 *
 * An appointment edited DIRECTLY in Google Calendar (dragged to a new time, or deleted) never
 * reached the LeadRider store — the console PATCH path syncs, but a native Google edit has no
 * hook — so the task card kept asserting the old slot (+17163975098 Kody, operator-reported:
 * calendar moved 3:00→4:00 PM, the task still said 3:00 PM). The reconcile tick now reads each
 * FUTURE booked event back every ~15 min and applies the pure decision.
 *
 * FAIL DIRECTION pinned here: anything uncertain is a noop — a stale display beats wrongly
 * clearing a real appointment. Only an explicit `cancelled` status clears.
 *
 * Run: npx tsx scripts/appointment_calendar_sync_eval.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  decideCalendarEventReconcile,
  CALENDAR_SYNC_MIN_DRIFT_MS
} from "../services/api/src/domain/appointmentCalendarSync.ts";
import { decideAppointmentTeardown } from "../services/api/src/domain/routeStateReducer.ts";

const T3PM = "2026-07-17T19:00:00.000Z";
const T4PM = "2026-07-17T20:00:00.000Z";

// THE KODY CASE: event moved an hour in Google → store updates to the calendar's time.
{
  const d = decideCalendarEventReconcile({ storedWhenIso: T3PM, eventStartIso: T4PM, eventStatus: "confirmed" });
  assert.equal(d.kind, "update_time", "an externally-moved event must update the store");
  assert.equal((d as any).whenIso, T4PM, "the calendar is the source of truth for the new time");
}
// In sync (sub-minute drift is clock noise, not an edit).
assert.equal(CALENDAR_SYNC_MIN_DRIFT_MS, 60_000);
assert.equal(
  decideCalendarEventReconcile({
    storedWhenIso: T3PM,
    eventStartIso: new Date(Date.parse(T3PM) + 20_000).toISOString(),
    eventStatus: "confirmed"
  }).kind,
  "noop",
  "sub-minute drift is not an edit"
);
// Explicit cancellation clears (mirrors the console PATCH-cancel arm).
assert.equal(
  decideCalendarEventReconcile({ storedWhenIso: T3PM, eventStartIso: T3PM, eventStatus: "cancelled" }).kind,
  "clear_cancelled",
  "a Google-side delete/cancel clears the stored appointment"
);
// Uncertainty resolves to noop — never clear on bad data.
assert.equal(
  decideCalendarEventReconcile({ storedWhenIso: T3PM, eventStartIso: null, eventStatus: "confirmed" }).kind,
  "noop",
  "a missing event start never mutates the store"
);
assert.equal(
  decideCalendarEventReconcile({ storedWhenIso: null, eventStartIso: T4PM, eventStatus: "confirmed" }).kind,
  "noop",
  "no stored time => nothing to reconcile"
);
assert.equal(
  decideCalendarEventReconcile({ storedWhenIso: T3PM, eventStartIso: "garbage", eventStatus: "tentative" }).kind,
  "noop",
  "unparseable event data never mutates the store"
);

// --- Source guards: the tick runs the sweep with the safety shape intact. ---
const idx = fs.readFileSync("services/api/src/index.ts", "utf8");
assert.match(idx, /decideCalendarEventReconcile\(\{/, "the reconcile tick must apply the pure decision");
assert.match(idx, /APPOINTMENT_CALENDAR_SYNC_INTERVAL_MS/, "the sweep is throttled (not a per-tick Google poll)");
assert.match(idx, /APPOINTMENT_CALENDAR_SYNC_MAX_PER_SWEEP/, "the sweep is capped per pass");
assert.match(
  idx,
  /catch \{\s*\n?\s*continue; \/\/ fetch failure => noop for this conv; never clear on a read error/,
  "a fetch failure must skip the conversation, never clear it"
);
// The cancel arm closes the appointment-class todos, like the console PATCH does.
//
// RE-PINNED TO BEHAVIOR 2026-08-01 (appointment-teardown un-stacking). This used to match an exact
// two-line source layout, which broke the moment the five teardown sites were centralized behind
// one referee — the behavior was unchanged, only the shape. Asserted now as (a) the referee's
// actual answer for THIS cause and (b) the sweep's ORDERING, which is the technique the
// source-pin ratchet asks for. Verified by deleting the todo-close from the sweep: still red.
assert.equal(
  decideAppointmentTeardown({ cause: "calendar_event_gone" }).closeAppointmentTodos,
  true,
  "a Google-side cancel closes the appointment-class todos like the console PATCH does"
);
const sweepTeardownAt = idx.indexOf('applyAppointmentTeardown(appt, { cause: "calendar_event_gone" })');
assert.ok(sweepTeardownAt > 0, "the reconcile sweep tears the appointment down through the shared referee");
const sweepTodoCloseAt = idx.indexOf(
  'markOpenTodosDoneForConversationByClass(conv.id, ["appointment"])',
  sweepTeardownAt
);
const sweepStampAt = idx.indexOf("appt.updatedAt = now.toISOString()", sweepTeardownAt);
assert.ok(sweepStampAt > sweepTeardownAt, "the sweep stamps updatedAt after tearing the appointment down");
assert.ok(
  sweepTodoCloseAt > sweepTeardownAt && sweepTodoCloseAt < sweepStampAt,
  "the cancel arm closes the appointment-class todos before it stamps updatedAt"
);

console.log("PASS appointment calendar-sync eval (Kody move case + drift/cancel/uncertainty table + throttled capped sweep wiring)");
