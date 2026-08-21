/**
 * THE APPOINTMENTS REPORT — pins the four ways a commission number can lie.
 *
 * Joe asked for "who set the appointment and if they showed or not" (2026-08-21). Money hangs on
 * the answer, so this eval is written against the FAIL DIRECTIONS rather than against the happy
 * path: every assertion below is a case where a plausible implementation would silently credit or
 * dock a salesperson, and nobody reading the table would be able to tell.
 *
 * 1. An appointment nobody graded must read `not_logged` — never `showed`. Roughly one in four
 *    appointments in the real store has no outcome recorded.
 * 2. An explicit `did_not_show` must beat an outcome status that merely IMPLIES attendance. The
 *    KPI's long-standing OR would call that row "showed"; the report must not.
 * 3. A FUTURE appointment must read `upcoming`, not an ungraded gap — otherwise every report run
 *    mid-period invents chores out of appointments that have not happened yet.
 * 4. The date range must key on the APPOINTMENT date, not the lead-creation date the KPI tab uses.
 *
 * Plus the setter-attribution rule that motivated the whole build: when the system does not know
 * WHICH human booked it, the report must say so rather than fall back to the calendar owner.
 */
import assert from "node:assert/strict";

import {
  buildAppointmentReport,
  resolveAppointmentSetter
} from "../services/api/src/domain/appointmentSetterReport.ts";
import { resolveAppointmentAttendance } from "../services/api/src/domain/kpiAnalytics.ts";
import type { Conversation } from "../services/api/src/domain/conversationStore.ts";

const NOW = Date.parse("2026-08-21T13:00:00.000Z");

function conv(id: string, appointment: any, lead: any = {}): Conversation {
  return {
    id,
    leadKey: `+1716555${id.padStart(4, "0")}`,
    lead: { name: `Lead ${id}`, phone: `+1716555${id.padStart(4, "0")}`, ...lead },
    messages: [],
    appointment
  } as unknown as Conversation;
}

function appt(over: any = {}) {
  return {
    status: "confirmed",
    whenIso: "2026-08-15T17:00:00.000Z",
    updatedAt: "2026-08-10T12:00:00.000Z",
    bookedSalespersonName: "Scott Hartrich",
    ...over
  };
}

/* ─── 1. AN UNGRADED APPOINTMENT IS NEVER A SHOW ──────────────────────────────────────────── */

const ungraded = conv("1", appt({ staffNotify: { userId: "u1" } }));
assert.equal(
  resolveAppointmentAttendance(ungraded, NOW).state,
  "not_logged",
  "A past appointment with no outcome recorded must read not_logged, never showed — an unrecorded outcome is a gap somebody has to fill, not a paid visit"
);

/* ─── 2. AN EXPLICIT NO-SHOW BEATS AN IMPLYING OUTCOME STATUS ─────────────────────────────── */

const contradictory = conv(
  "2",
  appt({
    staffNotify: { outcome: { status: "follow_up", primaryStatus: "did_not_show" } }
  })
);
const contradictoryAttendance = resolveAppointmentAttendance(contradictory, NOW);
assert.equal(
  contradictoryAttendance.state,
  "no_show",
  "When the rep explicitly marked did_not_show, the report must say no_show even though the outcome status (follow_up) implies attendance"
);
assert.equal(
  contradictoryAttendance.showedForKpi,
  true,
  "The legacy KPI OR is preserved verbatim — extracting this resolver must not move a number on the KPI Overview Joe already reads"
);
assert.equal(
  contradictoryAttendance.conflict,
  true,
  "A record that contradicts itself must be FLAGGED so it surfaces in the report, not silently resolved either way"
);

/* ─── 3. A FUTURE APPOINTMENT IS `upcoming`, NOT A MISSING OUTCOME ────────────────────────── */

const future = conv("3", appt({ whenIso: "2026-08-22T15:00:00.000Z", staffNotify: {} }));
assert.equal(
  resolveAppointmentAttendance(future, NOW).state,
  "upcoming",
  "An appointment that has not happened yet must read upcoming — grading it as an unlogged gap invents a chore"
);

/* ─── 4. THE RANGE KEYS ON THE APPOINTMENT DATE, NOT LEAD CREATION ────────────────────────── */

const julyAppointment = conv("4", appt({ whenIso: "2026-07-25T18:00:00.000Z" }), {
  createdAt: "2026-08-02T10:00:00.000Z"
});
const augustReport = buildAppointmentReport([julyAppointment], {
  from: "2026-08-01T00:00:00.000Z",
  to: "2026-08-31T23:59:59.999Z",
  nowMs: NOW
});
assert.equal(
  augustReport.totals.booked,
  0,
  "A July appointment must NOT appear in an August range even though the lead is an August lead — this is exactly the axis the KPI tab gets wrong for a pay period"
);

/* ─── 5. SETTER ATTRIBUTION — NAME IT, OR ADMIT WE DO NOT KNOW ────────────────────────────── */

const bookedInConsole = conv(
  "5",
  appt({ bookedBy: { actor: "human", channel: "manual", userId: "u9", userName: "Joe Hartrich" } })
);
const consoleSetter = resolveAppointmentSetter(bookedInConsole);
assert.equal(consoleSetter.kind, "staff_named");
assert.equal(consoleSetter.name, "Joe Hartrich", "A console booking carries the signed-in user and must name them");

const inferredFromText = conv(
  "6",
  appt({ bookedBy: { actor: "human", channel: "sms", inferred: true } })
);
const inferredSetter = resolveAppointmentSetter(inferredFromText);
assert.equal(
  inferredSetter.kind,
  "staff_unattributed",
  "A booking inferred from a text on the shared dealership number knows a human did it but not which one"
);
assert.equal(
  inferredSetter.name,
  null,
  "The setter must be null rather than falling back to the calendar owner — measured 2026-08-21, that fallback is wrong on 2 of the 15 attributed bookings"
);

const byAgent = conv("7", appt({ bookedBy: { actor: "ai", channel: "sms" } }));
assert.equal(resolveAppointmentSetter(byAgent).kind, "ai", "An agent-set appointment is its own category");

const legacySalesperson = conv("8", appt({ confirmedBy: "salesperson" }));
assert.equal(
  resolveAppointmentSetter(legacySalesperson).kind,
  "staff_unattributed",
  "A pre-attribution record says a salesperson did it but not who — that is unattributed, not unknown"
);

/* ─── 6. SHOW RATE IS COMPUTED OVER GRADED APPOINTMENTS ONLY ──────────────────────────────── */

const mixed = buildAppointmentReport(
  [
    conv("a", appt({ staffNotify: { outcome: { primaryStatus: "showed", status: "sold" } } })),
    conv("b", appt({ staffNotify: { outcome: { primaryStatus: "did_not_show", status: "no_show" } } })),
    conv("c", appt({ staffNotify: {} })), // ungraded
    conv("d", appt({ staffNotify: { outcome: { primaryStatus: "cancelled", status: "cancelled" } } })),
    conv("e", appt({ whenIso: "2026-08-25T15:00:00.000Z", staffNotify: {} })) // upcoming
  ],
  { from: "2026-08-01T00:00:00.000Z", to: "2026-08-31T23:59:59.999Z", nowMs: NOW }
);
assert.equal(mixed.totals.booked, 5);
assert.equal(mixed.totals.showed, 1);
assert.equal(mixed.totals.noShow, 1);
assert.equal(mixed.totals.cancelled, 1);
assert.equal(mixed.totals.notLogged, 1);
assert.equal(mixed.totals.upcoming, 1);
assert.equal(
  mixed.totals.showRatePct,
  50,
  "Show rate must divide by GRADED appointments (showed + no-show) only — folding cancellations or ungraded rows into the denominator docks a rep for something that is not their result"
);

/* ─── 7. UNDATED RECORDS ARE COUNTED, NOT SILENTLY DROPPED ────────────────────────────────── */

const undated = buildAppointmentReport([conv("9", appt({ whenIso: null }))], {
  from: "2026-08-01T00:00:00.000Z",
  to: "2026-08-31T23:59:59.999Z",
  nowMs: NOW
});
assert.equal(undated.totals.booked, 0);
assert.equal(
  undated.skippedUndated,
  1,
  "An appointment with no usable date cannot be placed in a pay period, but it must be REPORTED as skipped — a commission report that quietly loses rows is worse than one that admits to them"
);

/* ─── 8. A CLEARED APPOINTMENT IS NOT AN APPOINTMENT ──────────────────────────────────────── */

const cleared = buildAppointmentReport([conv("10", appt({ status: "none" }))], {
  from: "2026-08-01T00:00:00.000Z",
  to: "2026-08-31T23:59:59.999Z",
  nowMs: NOW
});
assert.equal(cleared.totals.booked, 0, "status:none means the appointment was cleared — it must not be counted or skipped-as-undated");

console.log("appointment_setter_report:eval OK — 8 fail-direction groups pinned");
