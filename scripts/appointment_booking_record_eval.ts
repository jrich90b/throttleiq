/**
 * appointment_booking_record:eval — ONE referee for "a booking endpoint just created the calendar
 * event; what does the appointment record become?"
 *
 * WHAT WAS FIGHTING. Three HTTP endpoints book a real Google event and then write the record, each
 * running its own hand-maintained copy of the same eleven-line field list:
 *
 *   POST /scheduler/book                 the booking widget — the customer picked one of our slots
 *   POST /public/booking/book            the public booking link we text a lead
 *   POST /conversations/:id/appointment  the console — a salesperson books the lead in by hand
 *
 * The lists had drifted apart. This is the SIBLING question to appointment_confirm_record:eval,
 * which owns the three CONVERSATION-TURN lanes that stamp `confirmed`; these three are endpoints.
 *
 * THE TWO DIVERGENCES the un-stacking found — one now FIXED, one still preserved:
 *
 *   1. The `reschedulePending` LATCH — **FIXED 2026-08-02, all three lanes now clear it.** The
 *      staff lane always did; the two customer lanes left it standing. That latch is what routes a
 *      lead's NEXT message into the reschedule arm, so a lead who was mid-reschedule and then
 *      booked a new time through the public link stayed flagged as owing a rebook — her next
 *      message carrying a time-ish word could be answered as "let's find you another time" for the
 *      appointment she just made. The principle was already settled by the sibling referee
 *      `decideAppointmentConfirmRecord`: a lane holding a REAL calendar event clears the latch, and
 *      "leave it standing" belongs to the provisional slot-match lane that has no event yet. All
 *      three of these hold an event. Blast radius on the live corpus: 13 of 800 leads carry the
 *      latch, and ZERO have ever booked through a customer lane (`bookedBy.channel ===
 *      "public_booking"` is unused at this dealer today) — so this is a PORTABILITY fix that first
 *      bites when a dealer switches the public booking link on. Ruling 4 in the rulings ledger.
 *
 *   2. `matchedSlot` — STILL PRESERVED. The staff lane records which salesperson/calendar window
 *      was taken; the two customer lanes do not. A breadcrumb, never asserted to a customer.
 *
 * FAIL DIRECTION. Refusing to stamp is the SAFE answer: an unrecorded booking costs a re-ask, while
 * a wrong "confirmed" tells a customer they are on the calendar when nothing holds the slot. So an
 * unrecognized lane must REFUSE, and a recognized lane must never leave the record half-written.
 *
 * Behavior assertions only — no source-text pins (see eval_source_pin_ratchet:eval).
 *
 * Run: npx tsx scripts/appointment_booking_record_eval.ts
 */
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";

process.env.CONVERSATIONS_DB_PATH =
  process.env.CONVERSATIONS_DB_PATH ||
  path.join(os.tmpdir(), `appointment-booking-record-eval-${Date.now()}.json`);

const { decideAppointmentBookingRecord } = await import(
  "../services/api/src/domain/routeStateReducer.ts"
);
const { applyAppointmentBookingRecord } = await import(
  "../services/api/src/domain/conversationStore.ts"
);
const { buildDecisionRegistry } = await import(
  "../services/api/src/domain/decisionFingerprint.ts"
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

const CUSTOMER_LANES = ["scheduler_widget_booking", "public_link_booking"] as const;
const STAFF_LANE = "staff_console_booking";
const ALL_LANES = [...CUSTOMER_LANES, STAFF_LANE] as const;

const SLOT = {
  salespersonId: "sp_1",
  salespersonName: "Stone",
  calendarId: "cal_1",
  start: "2026-08-08T18:00:00.000Z",
  end: "2026-08-08T19:00:00.000Z",
  startLocal: "Saturday, August 8 at 2:00 PM",
  endLocal: "Saturday, August 8 at 3:00 PM",
  appointmentType: "inventory_visit"
};

/** A lead mid-reschedule: the latch is standing and there is no booking on the record. */
const latchedLead = () => ({
  id: "conv_latched",
  leadKey: "+15550000001",
  appointment: {
    status: "none",
    updatedAt: "2026-08-01T12:00:00.000Z",
    reschedulePending: true,
    whenText: "Thursday at 10:00 AM",
    whenIso: null,
    bookedEventId: null
  }
}) as any;

const bookingInput = (lane: string, withSlot = false) => ({
  lane,
  whenText: SLOT.startLocal,
  whenIso: SLOT.start,
  bookedEventId: "evt_abc123",
  bookedEventLink: "https://calendar.google.com/evt_abc123",
  bookedSalespersonId: SLOT.salespersonId,
  ...(withSlot ? { matchedSlot: SLOT } : {})
});

// ---------------------------------------------------------------------------------------------
// 1. THE SHARED ANSWER — everything the three lanes agree on stays agreed.
// ---------------------------------------------------------------------------------------------
for (const lane of ALL_LANES) {
  const d = decideAppointmentBookingRecord({ lane, reschedulePending: false });
  ok(d.record === true, `${lane}: a recognized booking lane must record`);
  eq(d.status, "confirmed", `${lane}: a booked calendar event is confirmed`);
  ok(
    d.acknowledged === true,
    `${lane}: all three lanes hold a real event the customer or rep chose, so the 24h YES/NO ` +
      "reminder stays suppressed"
  );
}

// ---------------------------------------------------------------------------------------------
// 2. FAIL DIRECTION — an unrecognized lane REFUSES, and refusing writes nothing.
// ---------------------------------------------------------------------------------------------
for (const lane of ["", "  ", "customer_slot_match", "voice_summary_booking", "made_up_lane"]) {
  const d = decideAppointmentBookingRecord({ lane, reschedulePending: true });
  ok(d.record === false, `unrecognized lane "${lane}" must refuse to stamp`);
  ok(
    d.clearReschedulePending === false && d.recordMatchedSlot === false,
    `unrecognized lane "${lane}" must not authorize any companion write either`
  );
  ok(d.divergence === null, `unrecognized lane "${lane}" is a refusal, not a divergence`);
  ok(/refused/.test(d.why), `unrecognized lane "${lane}" must say it refused`);
}
// The confirm-lane names belong to the SIBLING referee. Crossing them over would silently apply the
// wrong arbitration, so they must land in the refusal branch above, not be quietly accepted.

const untouched = latchedLead();
const before = JSON.parse(JSON.stringify(untouched.appointment));
const refused = applyAppointmentBookingRecord(untouched, bookingInput("made_up_lane", true) as any);
ok(refused.record === false, "the applier reports the refusal");
eq(untouched.appointment, before, "a refused lane must leave the stored record byte-identical");

// ---------------------------------------------------------------------------------------------
// 3. DIVERGENCE 1, NOW FIXED — every lane that holds a real calendar event clears the latch.
// ---------------------------------------------------------------------------------------------
for (const lane of ALL_LANES) {
  for (const latch of [true, false, null, undefined]) {
    ok(
      decideAppointmentBookingRecord({ lane, reschedulePending: latch as any })
        .clearReschedulePending === true,
      `${lane}: a lane holding a real calendar event clears the latch (stored latch=${String(latch)})`
    );
  }
}
// The FIX stated as the failure it prevents: a lead mid-reschedule who books herself in must not
// come out of it still owing a rebook, or her next message gets read as "move my appointment".
{
  const conv = latchedLead();
  applyAppointmentBookingRecord(conv, bookingInput("public_link_booking") as any);
  eq(
    conv.appointment.reschedulePending,
    false,
    "a customer who books through the public link no longer owes a rebook — the bug this fixes"
  );
  eq(conv.appointment.status, "confirmed", "...and she is on the calendar");
}
// An unrecognized lane still authorizes nothing, the latch included.
ok(
  decideAppointmentBookingRecord({ lane: "made_up_lane", reschedulePending: true })
    .clearReschedulePending === false,
  "a refused lane may not clear the latch either"
);

// ---------------------------------------------------------------------------------------------
// 4. DIVERGENCE 2, STILL PRESERVED — staff records the slot taken; the customer lanes do not.
// ---------------------------------------------------------------------------------------------
for (const lane of CUSTOMER_LANES) {
  ok(
    decideAppointmentBookingRecord({ lane }).recordMatchedSlot === false,
    `${lane}: PRESERVED divergence — a customer-driven booking does not record the matched slot`
  );
  eq(
    decideAppointmentBookingRecord({ lane, hasMatchedSlot: true }).divergence,
    "customer_lane_booking_does_not_record_the_matched_slot",
    `${lane}: the surviving disagreement is NAMED when there is actually a slot to record`
  );
  ok(
    decideAppointmentBookingRecord({ lane, hasMatchedSlot: false }).divergence === null,
    `${lane}: no slot passed means no gap to name`
  );
}
ok(
  decideAppointmentBookingRecord({ lane: STAFF_LANE, hasMatchedSlot: true }).recordMatchedSlot === true,
  "the staff console lane records which slot it took"
);
ok(
  decideAppointmentBookingRecord({ lane: STAFF_LANE, hasMatchedSlot: true }).divergence === null,
  "the staff lane records the slot, so it is not the odd one out"
);

// ---------------------------------------------------------------------------------------------
// 5. confirmedBy is the lane's INPUT, not a disagreement — but it must not drift.
// ---------------------------------------------------------------------------------------------
for (const lane of CUSTOMER_LANES) {
  eq(
    decideAppointmentBookingRecord({ lane }).confirmedBy,
    "customer",
    `${lane}: the customer chose the time, so the record says so`
  );
}
eq(
  decideAppointmentBookingRecord({ lane: STAFF_LANE }).confirmedBy,
  "salesperson",
  "the console lane records that a salesperson booked it"
);

// ---------------------------------------------------------------------------------------------
// 6. THE APPLIER WRITES WHAT THE REFEREE DECIDED — including the two divergences, end to end.
// ---------------------------------------------------------------------------------------------
for (const lane of CUSTOMER_LANES) {
  const conv = latchedLead();
  const d = applyAppointmentBookingRecord(conv, bookingInput(lane, true) as any);
  const appt = conv.appointment;
  ok(d.record === true, `${lane}: applier recorded the booking`);
  eq(appt.status, "confirmed", `${lane}: status stamped`);
  eq(appt.whenIso, SLOT.start, `${lane}: the booked time is on the record`);
  eq(appt.whenText, SLOT.startLocal, `${lane}: the human-readable time is on the record`);
  eq(appt.confirmedBy, "customer", `${lane}: confirmedBy follows the lane`);
  eq(appt.acknowledged, true, `${lane}: the customer's word is on file`);
  eq(appt.bookedEventId, "evt_abc123", `${lane}: the calendar event id is on the record`);
  eq(appt.bookedEventLink, "https://calendar.google.com/evt_abc123", `${lane}: event link stored`);
  eq(appt.bookedSalespersonId, SLOT.salespersonId, `${lane}: the booked salesperson is stored`);
  eq(
    appt.reschedulePending,
    false,
    `${lane}: FIXED — a customer who books herself in no longer owes a rebook, so her next ` +
      'message is not read as "move my appointment"'
  );
  ok(
    appt.matchedSlot === undefined,
    `${lane}: PRESERVED — a customer-driven booking stores no matched slot even when one is passed`
  );
}
{
  const conv = latchedLead();
  applyAppointmentBookingRecord(conv, bookingInput(STAFF_LANE, true) as any);
  const appt = conv.appointment;
  eq(appt.confirmedBy, "salesperson", "staff lane: confirmedBy follows the lane");
  eq(appt.reschedulePending, false, "staff lane: the reschedule latch is cleared");
  eq(appt.matchedSlot, SLOT, "staff lane: the taken slot is recorded verbatim");
}
// A staff booking with no slot to record must not invent one.
{
  const conv = latchedLead();
  applyAppointmentBookingRecord(conv, bookingInput(STAFF_LANE, false) as any);
  ok(
    conv.appointment.matchedSlot === undefined,
    "staff lane: recordMatchedSlot never fabricates a slot the caller did not pass"
  );
  eq(conv.appointment.reschedulePending, false, "staff lane still clears the latch without a slot");
}

// A booking on a lead with NO appointment record yet must create one rather than throwing.
{
  const conv = { id: "conv_fresh", leadKey: "+15550000002" } as any;
  const d = applyAppointmentBookingRecord(conv, bookingInput("public_link_booking") as any);
  ok(d.record === true, "a lead with no appointment record can still be booked");
  eq(conv.appointment.status, "confirmed", "the fresh record is stamped confirmed");
  eq(conv.appointment.whenIso, SLOT.start, "the fresh record carries the booked time");
  ok(d.divergence === null, "no stored latch means no divergence to name");
}

// Missing ids must land as explicit nulls, never as a stale value left over from a prior booking.
{
  const conv = latchedLead();
  conv.appointment.bookedEventId = "evt_STALE";
  conv.appointment.bookedEventLink = "https://calendar.google.com/evt_STALE";
  conv.appointment.bookedSalespersonId = "sp_STALE";
  applyAppointmentBookingRecord(conv, {
    lane: STAFF_LANE,
    whenText: SLOT.startLocal,
    whenIso: SLOT.start
  } as any);
  eq(conv.appointment.bookedEventId, null, "a booking with no event id clears the stale one");
  eq(conv.appointment.bookedEventLink, null, "a booking with no event link clears the stale one");
  eq(conv.appointment.bookedSalespersonId, null, "a booking with no salesperson clears the stale one");
}

// ---------------------------------------------------------------------------------------------
// 7. PURITY — the referee must be a function of its inputs alone, or the equivalence harness that
//    lets this ship without a human reading the diff is measuring nothing.
// ---------------------------------------------------------------------------------------------
for (const lane of ALL_LANES) {
  for (const latch of [true, false]) {
    const a = decideAppointmentBookingRecord({ lane, reschedulePending: latch });
    const b = decideAppointmentBookingRecord({ lane, reschedulePending: latch });
    eq(a, b, `${lane}/${latch}: the referee is pure — same inputs, same decision`);
  }
}

// ---------------------------------------------------------------------------------------------
// 8. THE REGISTRY MUST SAMPLE IT — an un-stacking whose referee nobody fingerprints ships with no
//    evidence behind its "IDENTICAL" verdict. Sampled PER LANE, since the lanes disagree.
// ---------------------------------------------------------------------------------------------
{
  const reducer = await import("../services/api/src/domain/routeStateReducer.ts");
  const registry = buildDecisionRegistry(reducer);
  const clock = { nowMs: Date.parse("2026-08-02T12:00:00.000Z"), timeZone: "America/New_York" };
  ok(registry.length > 0, "the decision registry is non-empty");
  for (const lane of ALL_LANES) {
    ok(
      registry.some((entry: any) => entry.name === `appointmentBookingRecord:${lane}`),
      `the registry samples the ${lane} lane by name`
    );
  }
  const covered = registry.some((entry: any) =>
    (entry.covers ?? []).includes("decideAppointmentBookingRecord")
  );
  ok(covered, "the registry declares that it covers decideAppointmentBookingRecord");

  // And the sample must actually PRODUCE the arbitration on a real-shaped lead, not early-return.
  const conv = latchedLead();
  const staffSample = registry.find(
    (entry: any) => entry.name === `appointmentBookingRecord:${STAFF_LANE}`
  ) as any;
  const customerSample = registry.find(
    (entry: any) => entry.name === "appointmentBookingRecord:public_link_booking"
  ) as any;
  const staffProjection = staffSample.sample(conv, clock) as any;
  const customerProjection = customerSample.sample(conv, clock) as any;
  ok(
    staffProjection?.recordMatchedSlot === true && customerProjection?.recordMatchedSlot === false,
    "the two samples project the SURVIVING disagreement — the harness can still see this referee move"
  );
  ok(
    staffProjection?.clearReschedulePending === true &&
      customerProjection?.clearReschedulePending === true,
    "...and both project the now-agreed latch answer, so a regression back to the split is visible"
  );
  eq(
    customerProjection?.divergence,
    "customer_lane_booking_does_not_record_the_matched_slot",
    "the customer-lane sample carries the surviving divergence into the fingerprint"
  );
}

console.log(`appointment_booking_record:eval PASS — ${checks} checks`);
