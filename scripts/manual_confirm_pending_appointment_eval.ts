/**
 * Manual staff-confirm → book decision eval (decideManualConfirmPendingAppointment,
 * routeStateReducer).
 *
 * The William case (+17163591526, operator-reported 7/22): customer requested "thursday 9a"
 * (open "Appointment requested." todo), staff replied "Sounds good! See you then" — and nothing
 * got booked, because the inline gate required existingBookedAppointmentIsPast, i.e. it only
 * worked as a REBOOK after an old appointment. A FIRST booking (no appointment at all) fell
 * through, leaving the customer believing they're booked while the calendar shows nothing.
 *
 * Decision table (pure) + source guards that the manual-outbound path runs it and that the
 * requested-time fallback reads the PENDING request when the staff text names no time.
 *
 * Run: npx tsx scripts/manual_confirm_pending_appointment_eval.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { decideManualConfirmPendingAppointment } from "../services/api/src/domain/routeStateReducer.ts";

const base = {
  hasPendingRequestText: true,
  hasBookedEvent: false,
  existingBookedAppointmentIsPast: false,
  hasAffirmativeAck: true,
  hasQuestionMark: false
};

// THE WILLIAM CASE: pending request + affirmative staff ack + NO existing booking => confirm/book.
assert.equal(
  decideManualConfirmPendingAppointment(base).confirm,
  true,
  "first booking: pending request + staff 'Sounds good' with no prior appointment must confirm"
);
// The original rebook case still works: an old, PAST booking does not block a re-confirm.
assert.equal(
  decideManualConfirmPendingAppointment({ ...base, hasBookedEvent: true, existingBookedAppointmentIsPast: true })
    .confirm,
  true,
  "rebook: a stale past booking does not block confirming the new pending request"
);
// A LIVE future booking hard-excludes — never silently rebook over it from a casual ack.
assert.equal(
  decideManualConfirmPendingAppointment({ ...base, hasBookedEvent: true }).confirm,
  false,
  "a live future booking must never be rebooked from an affirmative text"
);
// No pending request => nothing to confirm (an ack with no requested slot books nothing).
assert.equal(
  decideManualConfirmPendingAppointment({ ...base, hasPendingRequestText: false }).confirm,
  false,
  "no pending 'Appointment requested' => no confirm"
);
// No affirmative phrase => not a confirmation.
assert.equal(
  decideManualConfirmPendingAppointment({ ...base, hasAffirmativeAck: false }).confirm,
  false,
  "a staff text without an affirmative is not a confirmation"
);
// A question is a question ("does thursday 9 work for you?") — never a confirm.
assert.equal(
  decideManualConfirmPendingAppointment({ ...base, hasQuestionMark: true }).confirm,
  false,
  "an affirmative WITH a question mark is a question, not a confirm"
);

// --- Source guards: the manual-outbound path uses the pure decision, and the requested-time
// source falls back to the PENDING request when the staff text itself names no day/time. ---
const idx = fs.readFileSync("services/api/src/index.ts", "utf8");
assert.match(
  idx,
  /decideManualConfirmPendingAppointment\(\{/,
  "the manual-outbound reconcile must call the pure decision"
);
assert.ok(
  !/confirmsPendingAppointmentRequest =\s*!!pendingAppointmentRequestText &&\s*existingBookedAppointmentIsPast/.test(
    idx
  ),
  "the old inline past-booking-only gate (the William bug) must be gone"
);
assert.match(
  idx,
  /\(explicitBookingStatement \? parseRequestedDayTime\(text, schedulerTimezone\) : null\) \?\?/,
  "an unparseable explicit-confirm staff text must fall through to the pending request's time"
);

console.log(
  "PASS manual confirm-pending-appointment eval (first-booking confirm + rebook + live-booking guard + question guard + fallback wiring)"
);
