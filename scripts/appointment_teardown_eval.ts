/**
 * appointment_teardown:eval — ONE referee for "when an appointment stops being an appointment,
 * what actually gets cleared?"
 *
 * WHAT WAS FIGHTING. Five places in index.ts un-booked an appointment, each with its own
 * hand-written list of fields to null out:
 *
 *   cancelBookedAppointmentForConversation   the customer texted "cancel"
 *   the calendar reconcile sweep             the Google event vanished out from under us
 *   the staff event-edit endpoint            staff cancelled / marked no-show in the console
 *   manual-outbound schedule (confirm path)  staff set a time, the calendar refused it
 *   manual-outbound schedule (parse path)    same, other branch of the same handler
 *
 * Nothing arbitrated, so the lists drifted apart. Three clear the whole record; the two
 * manual-outbound paths clear the BOOKING but leave the REQUESTED TIME behind.
 *
 * THE DIVERGENCE, PINNED AS-IS (preserved by the un-stacking, NOT fixed by it). After a
 * manual-outbound booking failure the record reads status "none" with no event id, yet still
 * carries whenText ("Saturday at 2:00 PM"), confirmedBy "salesperson" and matchedSlot.
 * buildAppointmentStatusReply falls back to whenText when there is no whenIso, so that customer
 * asking "are we still on?" is told "I'm seeing an appointment note for Saturday at 2:00 PM,
 * but I'll have the team confirm it" — a half-affirmed time nobody ever booked. The same lead
 * torn down by any of the other four causes gets the neutral "I'll have the team confirm your
 * appointment status." Flagged for Joe; pinned here so it cannot drift further meanwhile.
 *
 * FAIL DIRECTION. Clearing too LITTLE leaves a phantom appointment we may assert to a customer or
 * count in the funnel. Clearing too MUCH loses a requested time that the staff call todo also
 * carries. So an unrecognized cause must CLEAR EVERYTHING, and a teardown must NEVER leave a
 * booked event id or a whenIso behind.
 *
 * Behavior assertions only — no source-text pins (see eval_source_pin_ratchet:eval).
 *
 * Run: npx tsx scripts/appointment_teardown_eval.ts
 */
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";

process.env.CONVERSATIONS_DB_PATH =
  process.env.CONVERSATIONS_DB_PATH ||
  path.join(os.tmpdir(), `appointment-teardown-eval-${Date.now()}.json`);

const { decideAppointmentTeardown } = await import(
  "../services/api/src/domain/routeStateReducer.ts"
);
const { applyAppointmentTeardown, clearAppointmentStaffPromptState } = await import(
  "../services/api/src/domain/conversationStore.ts"
);

let checks = 0;
const ok = (condition: boolean, message: string) => {
  assert.equal(condition, true, message);
  checks++;
};
const eq = (actual: unknown, expected: unknown, message: string) => {
  assert.deepEqual(actual, expected, message);
  checks++;
};

/** A fully booked appointment, as the store holds one just before a teardown. */
const bookedAppointment = () => ({
  status: "confirmed",
  whenText: "Saturday at 2:00 PM",
  whenIso: "2026-08-08T18:00:00.000Z",
  confirmedBy: "salesperson",
  bookedEventId: "evt_abc123",
  bookedEventLink: "https://calendar.google.com/evt_abc123",
  bookedSalespersonId: "sp_1",
  bookedSalespersonName: "Stone",
  bookedCalendarId: "cal_1",
  matchedSlot: { calendarId: "cal_1", start: "2026-08-08T18:00:00.000Z", end: "2026-08-08T19:00:00.000Z" },
  reschedulePending: false,
  acknowledged: true,
  staffNotify: {
    bookedSentAt: "2026-08-01T12:00:00.000Z",
    followUpSentAt: "2026-08-01T12:05:00.000Z",
    lastEventId: "evt_abc123",
    outcomeToken: "tok_xyz",
    outcome: { status: "financing_declined", updatedAt: "2026-08-01T12:10:00.000Z" }
  }
});

const ALL_CAUSES = [
  "customer_cancelled",
  "calendar_event_gone",
  "staff_cancelled",
  "staff_no_show",
  "manual_outbound_book_failed"
] as const;

// --- the invariant every cause must satisfy: a torn-down appointment is never still booked ------
for (const cause of ALL_CAUSES) {
  const appt = bookedAppointment();
  applyAppointmentTeardown(appt, cause === "customer_cancelled"
    ? { cause, reschedulePendingOverride: false }
    : { cause });

  eq(appt.status, "none", `${cause}: status is torn down to none`);
  eq(appt.whenIso, null, `${cause}: the booked time is gone — nothing may re-assert it`);
  eq(appt.bookedEventId, null, `${cause}: the calendar event id is gone`);
  eq(appt.bookedEventLink, null, `${cause}: the calendar link is gone`);
  eq(appt.bookedSalespersonId, null, `${cause}: the booked rep id is gone`);
  eq(appt.bookedSalespersonName, null, `${cause}: the booked rep name is gone`);
  eq(appt.bookedCalendarId, null, `${cause}: the booked calendar id is gone`);

  // Staff prompt bookkeeping always goes: those markers gate re-notifying the rep, and an
  // outcome token that outlives its appointment lets a stale reply land on a dead record.
  ok(!("bookedSentAt" in appt.staffNotify), `${cause}: bookedSentAt cleared`);
  ok(!("followUpSentAt" in appt.staffNotify), `${cause}: followUpSentAt cleared`);
  ok(!("lastEventId" in appt.staffNotify), `${cause}: lastEventId cleared`);
  ok(!("outcomeToken" in appt.staffNotify), `${cause}: the outcome token cleared`);
  // ...but a RECORDED outcome is history and survives.
  ok(!!appt.staffNotify.outcome, `${cause}: a recorded outcome is history and is not wiped`);
}

// --- the four agreeing causes clear the record completely ---------------------------------------
for (const cause of ["customer_cancelled", "calendar_event_gone", "staff_cancelled", "staff_no_show"] as const) {
  const appt = bookedAppointment();
  const decision = applyAppointmentTeardown(appt, cause === "customer_cancelled"
    ? { cause, reschedulePendingOverride: false }
    : { cause });

  eq(appt.whenText, undefined, `${cause}: the human-readable time is cleared`);
  eq(appt.confirmedBy, undefined, `${cause}: who confirmed it is cleared`);
  eq(appt.matchedSlot, undefined, `${cause}: the matched calendar slot is cleared`);
  eq(decision.divergence, null, `${cause}: agrees with the majority — no divergence to name`);
  eq(decision.closeAppointmentTodos, true, `${cause}: open appointment todos get closed`);
}

// --- THE PRESERVED DIVERGENCE -------------------------------------------------------------------
// The manual-outbound booking-failure paths keep the requested time. This is today's live
// behavior and the un-stacking must not silently "fix" it.
{
  const appt = bookedAppointment();
  const decision = applyAppointmentTeardown(appt, { cause: "manual_outbound_book_failed" });

  eq(appt.whenText, "Saturday at 2:00 PM", "book-failed KEEPS the requested time (divergence, as-is)");
  eq(appt.confirmedBy, "salesperson", "book-failed KEEPS confirmedBy (divergence, as-is)");
  ok(!!appt.matchedSlot, "book-failed KEEPS the matched slot (divergence, as-is)");
  eq(
    decision.divergence,
    "manual_outbound_book_failed_retains_requested_time",
    "the disagreement is NAMED on the decision, not buried in a branch"
  );
  eq(
    decision.closeAppointmentTodos,
    false,
    "book-failed does not close appointment todos — its caller OPENS a staff call todo instead"
  );
  // Even the diverging path must still drop the booking itself.
  eq(appt.bookedEventId, null, "book-failed still drops the calendar event id");
  eq(appt.whenIso, null, "book-failed still drops the machine-readable time");
}

// --- reschedulePending: the one answer that genuinely differs by cause ---------------------------
eq(
  decideAppointmentTeardown({ cause: "customer_cancelled", reschedulePendingOverride: false }).reschedulePending,
  false,
  "a customer cancelling outright is not pending a reschedule"
);
eq(
  decideAppointmentTeardown({ cause: "customer_cancelled", reschedulePendingOverride: true }).reschedulePending,
  true,
  "the customer-cancel caller may say a reschedule IS pending"
);
eq(
  decideAppointmentTeardown({ cause: "staff_no_show" }).reschedulePending,
  false,
  "a no-show is not a pending reschedule — nobody asked for a new time"
);
for (const cause of ["calendar_event_gone", "staff_cancelled", "manual_outbound_book_failed"] as const) {
  eq(
    decideAppointmentTeardown({ cause }).reschedulePending,
    true,
    `${cause}: the customer still wants to come in — a reschedule is pending`
  );
}

// --- FAIL DIRECTION: an unrecognized cause clears everything -------------------------------------
{
  const decision = decideAppointmentTeardown({ cause: "some_future_cause" as any });
  eq(decision.clearRequestedTime, true, "unknown cause clears the requested time (no phantom)");
  eq(decision.clearMatchedSlot, true, "unknown cause clears the matched slot");
  eq(decision.clearBookedEvent, true, "unknown cause clears the booking");
  eq(decision.clearStaffPromptState, true, "unknown cause clears staff prompt state");
  eq(decision.status, "none", "unknown cause still tears the appointment down");
}

// --- the referee is PURE: same input, same answer, no clock ------------------------------------
eq(
  decideAppointmentTeardown({ cause: "staff_cancelled" }),
  decideAppointmentTeardown({ cause: "staff_cancelled" }),
  "the referee is pure — identical input gives an identical decision"
);

// --- the applier tolerates a missing appointment (callers reach it via optional state) -----------
ok(
  decideAppointmentTeardown({ cause: "calendar_event_gone" }).status === "none" &&
    applyAppointmentTeardown(null, { cause: "calendar_event_gone" }).status === "none",
  "a missing appointment does not throw — the decision still comes back"
);

// --- the staff-prompt helper is a no-op on a record that has none --------------------------------
eq(
  clearAppointmentStaffPromptState({ status: "none" }),
  false,
  "nothing to clear reports no change"
);

console.log(`appointment_teardown:eval OK — ${checks} checks`);
