/**
 * appointment_outcome_record:eval — ONE referee for "what happened at the visit, and may a new
 * answer overwrite the one already on the record?"
 *
 * WHAT WAS FIGHTING. Nine places in index.ts wrote `appointment.staffNotify.outcome` (or its
 * dealer-ride twin), each hand-building the record and each assigning it WHOLESALE:
 *
 *   the conversation-header outcome form   staff picks primary + secondary in the console
 *   the public tokenized outcome form      the link we text the rep after the appointment
 *   the todo-done modal                    staff closes the appointment todo with an outcome
 *   the dealer-ride staff SMS reply        the rep answers the outcome prompt by text
 *   the finance signal ×3                  declined / needs-more-info / approved
 *   the context-note booking read          a staff note read as cancel / reschedule
 *   the context-note outcome read          a staff note read as an attendance outcome
 *
 * Nothing arbitrated, so the records drifted into two SHAPES: three lanes store the modern
 * `primaryStatus` + `secondaryStatus` pair, six store a bare `{ status, note, updatedAt }`.
 *
 * THE DIVERGENCE, PINNED AS-IS (preserved by the un-stacking, NOT fixed by it). Every attendance
 * reader — isShowedAppointmentOutcome / canAssertMissedAppointment in routeStateReducer, and
 * customerVisitConfirmed in visitFraming — asks `primaryStatus` first and falls back to the legacy
 * `status` only when the pair is blank. Because each writer replaces the whole object, a bare write
 * DELETES a recorded attendance and hands the question to the legacy fallback, which can answer the
 * other way. Staff click "Did not show"; a finance call then lands declined; the attendance answer
 * flips MISSED -> SHOWED because "financing_declined" sits in the legacy showed-family list, and we
 * lose the ability to acknowledge the miss to the customer. The reverse runs too: a context note
 * parsed "cancelled" over a recorded sold flips SHOWED -> MISSED, which is licence to tell a
 * customer who bought a bike that he failed to appear.
 *
 * And the readers do not even agree with each other on the resulting record: visitFraming's legacy
 * list accepts only showed/showed_up, so the same overwritten record reads SHOWED to the
 * settled-appointment guard and NOT-A-VISIT to the phantom-visit guard. Pinned below.
 *
 * FAIL DIRECTION. The referee only SHAPES a record staff explicitly asked us to store — it never
 * invents, suppresses or infers an outcome. An unrecognized status is kept verbatim and reported as
 * attendance "unknown" rather than guessed, and a blank or unknown NEVER counts as a flip (so the
 * divergence signal cannot be manufactured out of missing data). Over-reporting a flip would send a
 * false alarm to Joe; under-reporting one hides the live defect — so both directions are pinned.
 *
 * Behavior assertions only — no source-text pins (see eval_source_pin_ratchet:eval).
 *
 * Run: npx tsx scripts/appointment_outcome_record_eval.ts
 */
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";

process.env.CONVERSATIONS_DB_PATH =
  process.env.CONVERSATIONS_DB_PATH ||
  path.join(os.tmpdir(), `appointment-outcome-record-eval-${Date.now()}.json`);

const { decideAppointmentOutcomeRecord, readAppointmentAttendance, canAssertMissedAppointment } =
  await import("../services/api/src/domain/routeStateReducer.ts");
const { customerVisitConfirmed } = await import("../services/api/src/domain/visitFraming.ts");

let checks = 0;
const ok = (condition: boolean, message: string) => {
  assert.equal(condition, true, message);
  checks++;
};
const eq = (actual: unknown, expected: unknown, message: string) => {
  assert.deepEqual(actual, expected, message);
  checks++;
};

const NOW = "2026-08-01T18:00:00.000Z";

/** The three lanes that store the modern pair, and the six that store the bare legacy shape. */
const NORMALIZED_SOURCES = ["staff_console_header", "staff_outcome_link", "staff_todo_modal"] as const;
const BARE_SOURCES = [
  "staff_outcome_sms",
  "finance_signal",
  "context_note_booking",
  "context_note_outcome"
] as const;

// --- the record itself: full replacement, exactly as the nine sites wrote it ---------------------
{
  const decision = decideAppointmentOutcomeRecord({
    source: "staff_console_header",
    existing: { status: "no_show", primaryStatus: "did_not_show", secondaryStatus: "needs_follow_up" },
    incoming: {
      status: "sold",
      primaryStatus: "showed",
      secondaryStatus: "sold",
      note: "Bought the Street Glide."
    },
    nowIso: NOW
  });
  eq(
    decision.record,
    {
      status: "sold",
      primaryStatus: "showed",
      secondaryStatus: "sold",
      note: "Bought the Street Glide.",
      updatedAt: NOW
    },
    "the normalized lane stores status + the modern pair + the note, stamped now"
  );
  ok(!decision.bareLegacyShape, "a lane that supplies primaryStatus is not the bare shape");
}

// A blank note is OMITTED, not stored as an empty string — that is what `note || undefined` did.
{
  const record = decideAppointmentOutcomeRecord({
    source: "finance_signal",
    existing: null,
    incoming: { status: "financing_declined", note: "   " },
    nowIso: NOW
  }).record;
  eq(record, { status: "financing_declined", updatedAt: NOW }, "a blank note leaves no note key behind");
  ok(!("primaryStatus" in record), "a bare-shape write stores NO primaryStatus key (preserved as-is)");
  ok(!("secondaryStatus" in record), "a bare-shape write stores NO secondaryStatus key (preserved as-is)");
}

// The referee NEVER carries the old pair forward. That is today's behavior and the whole point of
// preserving it: the un-stacking must not silently fix the defect it exposes.
for (const source of BARE_SOURCES) {
  const record = decideAppointmentOutcomeRecord({
    source,
    existing: { status: "no_show", primaryStatus: "did_not_show", secondaryStatus: "needs_follow_up" },
    incoming: { status: "follow_up" },
    nowIso: NOW
  }).record;
  eq(record.primaryStatus, "did_not_show", `${source}: CARRIES the rep's answer forward (Joe 8/1)`);
  ok(!("secondaryStatus" in record), `${source}: the sub-status is NOT carried — only the attendance answer is`);
}

// --- THE RULING: a bare write can no longer erase what the rep recorded --------------------------
// Joe, 2026-08-01: "the reps click wins." A rep clicks "did not show"; that lead's finance
// application later comes back declined; the bare finance write used to overwrite the rep and the
// system then believed he DID come in, losing our ability to say "sorry you couldn't make it".
{
  const decision = decideAppointmentOutcomeRecord({
    source: "finance_signal",
    existing: { status: "no_show", primaryStatus: "did_not_show", secondaryStatus: "needs_follow_up" },
    incoming: { status: "financing_declined", note: "Lender turned it down." },
    nowIso: NOW
  });
  eq(decision.attendanceBefore, "missed", "staff had recorded that he did not show");
  eq(decision.attendanceAfter, "missed", "and the finance result no longer changes that");
  eq(decision.attendanceFlipped, false, "nothing flipped — the rep's click survived");
  eq(decision.dropsRecordedAttendance, false, "and the recorded answer was not dropped");
  eq(decision.divergence, null, "so there is no disagreement left to name");
  // The incoming write still lands everything it actually knew.
  eq(decision.record.status, "financing_declined", "the finance result is recorded");
  eq(decision.record.note, "Lender turned it down.", "and its note");
  eq(decision.record.primaryStatus, "did_not_show", "alongside — not instead of — the rep's answer");

  // The downstream consequence, which is the whole point: we can still tell him he missed it.
  eq(
    canAssertMissedAppointment({
      whenIso: "2026-08-01T14:00:00.000Z",
      nowMs: Date.parse(NOW),
      outcomePrimaryStatus: "did_not_show",
      outcomeLegacyStatus: "no_show"
    }),
    true,
    "before the finance write we may tell him he missed it"
  );
  eq(
    canAssertMissedAppointment({
      whenIso: "2026-08-01T14:00:00.000Z",
      nowMs: Date.parse(NOW),
      outcomePrimaryStatus: decision.record.primaryStatus ?? null,
      outcomeLegacyStatus: decision.record.status
    }),
    true,
    "and after it we STILL can — that capability used to be silently lost here"
  );
}

// --- the mirror image: a cancelled context note lands on a recorded sold -------------------------
{
  const decision = decideAppointmentOutcomeRecord({
    source: "context_note_outcome",
    existing: { status: "sold", primaryStatus: "showed", secondaryStatus: "sold" },
    incoming: { status: "cancelled", note: "Customer note says cancelled." },
    nowIso: NOW
  });
  eq(decision.attendanceBefore, "showed", "he had showed and bought");
  eq(decision.attendanceAfter, "showed", "and a note read as 'cancelled' no longer un-does that");
  eq(decision.attendanceFlipped, false, "the dangerous reverse flip is gone too");
  eq(decision.divergence, null, "nothing left to name in this direction either");
  eq(
    customerVisitConfirmed({ appointment: { staffNotify: { outcome: decision.record } } }),
    true,
    "we can never tell a customer who just bought a bike that he failed to appear"
  );
}

// --- a bare write that DROPS the pair without flipping the answer is named separately ------------
{
  const decision = decideAppointmentOutcomeRecord({
    source: "finance_signal",
    existing: { status: "sold", primaryStatus: "showed", secondaryStatus: "sold" },
    incoming: { status: "financing_declined" },
    nowIso: NOW
  });
  eq(decision.attendanceBefore, "showed", "showed before");
  eq(decision.attendanceAfter, "showed", "showed after");
  eq(decision.attendanceFlipped, false, "no flip");
  eq(decision.dropsRecordedAttendance, false, "and the explicit answer is no longer lost either");
  eq(decision.record.primaryStatus, "showed", "it is carried forward on the new record");
  eq(decision.divergence, null, "nothing to report");
}

// --- the quiet, correct case: a normalized lane overwriting with the same attendance -------------
for (const source of NORMALIZED_SOURCES) {
  const decision = decideAppointmentOutcomeRecord({
    source,
    existing: { status: "showed_up", primaryStatus: "showed", secondaryStatus: "needs_follow_up" },
    incoming: { status: "sold", primaryStatus: "showed", secondaryStatus: "sold", note: "Sold it." },
    nowIso: NOW
  });
  eq(decision.attendanceFlipped, false, `${source}: showed -> showed is not a flip`);
  eq(decision.dropsRecordedAttendance, false, `${source}: the pair is supplied, nothing is dropped`);
  eq(decision.divergence, null, `${source}: nothing to report — no disagreement here`);
}

// --- FAIL DIRECTION: unknown/blank is reported, never guessed, and never counts as a flip --------
{
  eq(readAppointmentAttendance(null), "unknown", "no record at all is unknown, not showed");
  eq(readAppointmentAttendance({}), "unknown", "an empty record is unknown");
  eq(readAppointmentAttendance({ status: "   " }), "unknown", "a blank status is unknown");
  eq(
    readAppointmentAttendance({ status: "some_future_status" }),
    "unknown",
    "an unrecognized status is unknown — never guessed into showed or missed"
  );

  // A first-ever outcome (nothing recorded before) must never be reported as a flip: there was no
  // prior answer to contradict, and a false alarm here would send Joe chasing a non-defect.
  const first = decideAppointmentOutcomeRecord({
    source: "finance_signal",
    existing: null,
    incoming: { status: "financing_declined" },
    nowIso: NOW
  });
  eq(first.attendanceBefore, "unknown", "nothing was recorded before");
  eq(first.attendanceFlipped, false, "a first outcome is not a flip");
  eq(first.dropsRecordedAttendance, false, "nothing was dropped — there was no pair");
  eq(first.divergence, null, "and so nothing is reported");

  // An UNRECOGNIZED incoming status is the strongest case for the ruling: we cannot read it, so it
  // certainly is not a statement about whether the customer walked in. The rep's answer survives it.
  const opaque = decideAppointmentOutcomeRecord({
    source: "context_note_outcome",
    existing: { status: "no_show", primaryStatus: "did_not_show" },
    incoming: { status: "some_future_status" },
    nowIso: NOW
  });
  eq(opaque.attendanceAfter, "missed", "a status we cannot read does not get to erase the rep's answer");
  eq(opaque.attendanceFlipped, false, "unknown is never a flip — we do not invent a contradiction");
  eq(opaque.dropsRecordedAttendance, false, "the recorded answer is kept, not dropped");
  eq(opaque.record.primaryStatus, "did_not_show", "it rides forward onto the new record");
  eq(opaque.divergence, null, "nothing left to report");

  // The caller's status is kept verbatim — the referee is a shaper, never a classifier.
  eq(opaque.record.status, "some_future_status", "an unknown status is stored as-is, not normalized away");
}

// --- an existing record with NO pair cannot report a drop ----------------------------------------
{
  const decision = decideAppointmentOutcomeRecord({
    source: "finance_signal",
    existing: { status: "no_show" },
    incoming: { status: "financing_declined" },
    nowIso: NOW
  });
  eq(decision.attendanceBefore, "missed", "the legacy-only record still answers the question");
  eq(decision.attendanceAfter, "showed", "and the overwrite still flips it");
  eq(decision.dropsRecordedAttendance, false, "but there was no explicit pair to drop");
  eq(
    decision.divergence,
    "outcome_write_flips_recorded_attendance",
    "a legacy-over-legacy flip is named without the bare_ prefix"
  );
}

// --- an explicit primary beats the legacy field, exactly as the readers do it --------------------
eq(
  readAppointmentAttendance({ status: "sold", primaryStatus: "did_not_show" }),
  "missed",
  "an explicit did_not_show wins over a legacy sold — the pair is authoritative"
);
eq(
  readAppointmentAttendance({ status: "no_show", primaryStatus: "showed" }),
  "showed",
  "and the same in the other direction"
);

// --- the referee is PURE: same input, same answer, no clock --------------------------------------
{
  const args = {
    source: "finance_signal" as const,
    existing: { status: "no_show", primaryStatus: "did_not_show" },
    incoming: { status: "financing_declined", note: "same" },
    nowIso: NOW
  };
  eq(
    decideAppointmentOutcomeRecord(args),
    decideAppointmentOutcomeRecord(args),
    "the referee is pure — identical input gives an identical decision"
  );
}

// --- the referee never mutates the record it was handed -----------------------------------------
{
  const existing = { status: "no_show", primaryStatus: "did_not_show", secondaryStatus: "needs_follow_up" };
  const snapshot = JSON.stringify(existing);
  decideAppointmentOutcomeRecord({
    source: "finance_signal",
    existing,
    incoming: { status: "financing_declined" },
    nowIso: NOW
  });
  eq(JSON.stringify(existing), snapshot, "the prior record is read, never written through");
}

console.log(`appointment_outcome_record:eval OK — ${checks} checks`);
