/**
 * appointment_outcome_rescheduled:eval — "the appointment moved" is a recordable outcome, and it
 * can never be mistaken for a customer who failed to turn up.
 *
 * WHY THIS EXISTS (Joe, 2026-08-18, +17165230421 Jason Marshall). The Attendance dropdown offered
 * Showed / Did not show / Cancelled. Jason had a Tue 4:30 PM visit booked on the CVO Road Glide ST;
 * that morning he wrote he was free "today and tomorrow", staff answered "if you have availability
 * for tomorrow, let's shoot for then" and promised to call in the morning with a time. At 5:45 PM
 * the outcome nag fired for the 4:30 slot and **none of the three options was true**.
 *
 * Picking the nearest wrong one is not cosmetic. `did_not_show` and `cancelled` are the two values
 * that (a) `isMissedAppointmentOutcome` reads, which is what lets the agent tell a customer we
 * missed them, and (b) gate `maybeQueueAppointmentOutcomeRescheduleDraft`, which DRAFTS A TEXT to
 * the customer. So the missing word would have produced a "sorry we missed you, want to rebook?"
 * message to a man who is coming in tomorrow.
 *
 * WHAT IS PINNED — behaviour of the pure vocabulary, executed:
 *   1. the value round-trips (the form posts it, the normalizer accepts it);
 *   2. its legacy status is `follow_up` — NEVER `no_show`/`cancelled`, because the visit moved
 *      rather than died;
 *   3. attendance reads "unknown", so `canAssertMissedAppointment` can never assert a miss off it;
 *   4. its disposition list is the narrow one (a moved visit cannot be "not ready" or "lost");
 *   5. the negative that matters most — the three OTHER primaries keep their exact meaning, so
 *      adding a word did not move anyone else's answer.
 *
 * Rules 2 and 3 are the fail-direction guards. They are asserted here rather than trusted to the
 * allow-list shape of the readers, because that shape is exactly the kind of thing a later refactor
 * flips to a deny-list without noticing.
 */
import assert from "node:assert/strict";
import {
  APPOINTMENT_SECONDARY_OPTIONS,
  mapPrimarySecondaryToLegacy,
  normalizeAppointmentPrimaryOutcome,
  normalizeAppointmentSecondaryOutcome
} from "../services/api/src/domain/appointmentOutcome.js";
import { readAppointmentAttendance } from "../services/api/src/domain/routeStateReducer.js";

let failures = 0;
function check(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`  FAIL  ${name}: ${(err as Error).message}`);
  }
}

// 1. The form's value survives the round trip.
check("the form value 'rescheduled' normalizes to the rescheduled outcome", () => {
  assert.equal(normalizeAppointmentPrimaryOutcome("rescheduled"), "rescheduled");
  assert.equal(normalizeAppointmentPrimaryOutcome("Rescheduled"), "rescheduled");
  assert.equal(normalizeAppointmentPrimaryOutcome("re-scheduled"), "rescheduled");
  assert.equal(normalizeAppointmentPrimaryOutcome("reschedule"), "rescheduled");
});

check("an unknown attendance word is still rejected rather than guessed", () => {
  assert.equal(normalizeAppointmentPrimaryOutcome("moved"), null);
  assert.equal(normalizeAppointmentPrimaryOutcome(""), null);
});

// 2. FAIL DIRECTION: a moved visit must never land on a legacy status that reads as a failed one.
check("rescheduled maps to the legacy follow_up, never no_show or cancelled", () => {
  for (const secondary of ["needs_follow_up", "other"] as const) {
    const legacy = mapPrimarySecondaryToLegacy("rescheduled", secondary);
    assert.equal(legacy, "follow_up", `secondary ${secondary} produced ${legacy}`);
    assert.notEqual(legacy, "no_show");
    assert.notEqual(legacy, "cancelled");
  }
});

// 3. FAIL DIRECTION: nothing may ASSERT a miss (or a show) off a rescheduled appointment. This is
//    the guard that keeps "sorry you couldn't make it" away from a customer who is coming tomorrow.
check("attendance on a rescheduled outcome reads unknown - never missed, never showed", () => {
  assert.equal(readAppointmentAttendance({ primaryStatus: "rescheduled", status: "follow_up" }), "unknown");
  assert.equal(readAppointmentAttendance({ primaryStatus: "rescheduled", status: null }), "unknown");
});

check("the three existing attendance answers are unchanged", () => {
  assert.equal(readAppointmentAttendance({ primaryStatus: "showed" }), "showed");
  assert.equal(readAppointmentAttendance({ primaryStatus: "did_not_show" }), "missed");
  assert.equal(readAppointmentAttendance({ primaryStatus: "cancelled" }), "missed");
  assert.equal(mapPrimarySecondaryToLegacy("did_not_show", "needs_follow_up"), "no_show");
  assert.equal(mapPrimarySecondaryToLegacy("cancelled", "needs_follow_up"), "cancelled");
  assert.equal(mapPrimarySecondaryToLegacy("showed", "sold"), "sold");
});

// 4. A moved visit is still a live lead, so its disposition list is deliberately narrow.
check("rescheduled offers only the still-working-it dispositions", () => {
  const allowed = APPOINTMENT_SECONDARY_OPTIONS.rescheduled;
  assert.ok(allowed, "rescheduled must have a disposition list");
  assert.ok(allowed.has("needs_follow_up"));
  assert.ok(allowed.has("other"));
  assert.ok(!allowed.has("lost"), "a visit that has not happened cannot be lost");
  assert.ok(!allowed.has("not_ready"), "a visit that has not happened cannot be not_ready");
  assert.ok(!allowed.has("sold"), "a visit that has not happened cannot be sold");
});

check("every rescheduled disposition the form offers is accepted by the normalizer", () => {
  for (const value of ["needs_follow_up", "other"]) {
    const normalized = normalizeAppointmentSecondaryOutcome(value);
    assert.ok(normalized, `${value} must normalize`);
    assert.ok(
      APPOINTMENT_SECONDARY_OPTIONS.rescheduled.has(normalized),
      `${value} must be allowed for rescheduled`
    );
  }
});

// 5. The other primaries kept their exact option sets — adding a word moved nobody else's answer.
check("the existing primaries keep their disposition lists", () => {
  assert.deepEqual([...APPOINTMENT_SECONDARY_OPTIONS.did_not_show].sort(), [
    "lost",
    "needs_follow_up",
    "not_ready",
    "other"
  ]);
  assert.deepEqual([...APPOINTMENT_SECONDARY_OPTIONS.cancelled].sort(), [
    "lost",
    "needs_follow_up",
    "not_ready",
    "other"
  ]);
  assert.ok(APPOINTMENT_SECONDARY_OPTIONS.showed.has("sold"));
});

if (failures) {
  console.error(`appointment_outcome_rescheduled:eval FAILED (${failures} case(s))`);
  process.exit(1);
}
console.log("appointment_outcome_rescheduled:eval OK (8 case(s))");
