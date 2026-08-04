/**
 * appointment_booking_record:eval — ONE referee for "a calendar write just put a real event on this
 * lead's books; what does the appointment record become?"
 *
 * WHAT WAS FIGHTING. Five places write a real Google event and then write the record, each running
 * its own hand-maintained copy of the same field list:
 *
 *   POST /scheduler/book                 the booking widget — the customer picked one of our slots
 *   POST /public/booking/book            the public booking link we text a lead
 *   POST /conversations/:id/appointment  the console — a salesperson books the lead in by hand
 *   (manual outbound send)               staff texted a time; we book the event behind the message
 *   PATCH /calendar/events/:cal/:event   staff EDITED the event straight on the calendar
 *
 * The lists had drifted apart. This is the SIBLING question to appointment_confirm_record:eval,
 * which owns the CONVERSATION-TURN lanes that stamp `confirmed`; these five hold a calendar event.
 * The last two joined 2026-08-04 — see divergences 3 and 4.
 *
 * THE FOUR DIVERGENCES the un-stacking found — one FIXED, three preserved:
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
 *   3. Does the lane STAMP `confirmedBy` at all? — PRESERVED. The two joining lanes do not: both
 *      call `setAppointmentBookedBy` themselves, and `confirmedBy` is only the FALLBACK that
 *      `decideAppointmentAttribution` reads when nobody handed in an actor. It also feeds the KPI
 *      appointment-SETTER label (salesperson vs ai_sms), so stamping it would move a reported
 *      number — not a centralization's call to make.
 *
 *   4. Does the lane put the customer's word on file (`acknowledged`)? — PRESERVED. Every lane that
 *      CREATES an event does; `staff_calendar_edit` does not, because staff dragging an event to a
 *      new hour is not the customer agreeing to the new hour. Traced to its only consumer before
 *      preserving: `shouldSuppressAppointmentConfirmationReminder` (transitionSafety.ts). Leaving
 *      it alone is the fail-SAFE half — an unacknowledged appointment still gets its 24h reminder.
 *      The OTHER half is a real gap and is deliberately NOT fixed here: a customer who acknowledged
 *      the OLD time stays acknowledged after staff move it, so she is never re-asked about the new
 *      one. That is a behavior fix and belongs in its own PR, not inside a cleanup.
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
const MANUAL_OUTBOUND_LANE = "manual_outbound_schedule_booking";
const EDIT_LANE = "staff_calendar_edit";
/** The three ENDPOINT lanes the referee started with — the ones whose answers must not move. */
const ALL_LANES = [...CUSTOMER_LANES, STAFF_LANE] as const;
/** Every lane that CREATES a calendar event. The edit lane patches one someone else made. */
const CREATING_LANES = [...ALL_LANES, MANUAL_OUTBOUND_LANE] as const;
const EVERY_LANE = [...CREATING_LANES, EDIT_LANE] as const;

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
// 1. THE SHARED ANSWER — everything the lanes agree on stays agreed.
// ---------------------------------------------------------------------------------------------
for (const lane of EVERY_LANE) {
  const d = decideAppointmentBookingRecord({ lane, reschedulePending: false, hasBookedTime: true });
  ok(d.record === true, `${lane}: a recognized booking lane must record`);
  eq(d.status, "confirmed", `${lane}: a booked calendar event is confirmed`);
}
for (const lane of CREATING_LANES) {
  const d = decideAppointmentBookingRecord({ lane, reschedulePending: false });
  ok(
    d.acknowledged === true && d.stampAcknowledged === true,
    `${lane}: a lane that CREATES a real event holds a time the customer or rep chose, so the 24h ` +
      "YES/NO reminder stays suppressed"
  );
  ok(
    d.stampBookedTime === true,
    `${lane}: a creating lane always carries a time, so it always stamps one`
  );
  ok(
    d.stampBookedEvent === true,
    `${lane}: a creating lane owns the booked-event ids — a missing one clears, never lingers`
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
for (const lane of EVERY_LANE) {
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
// 6b. THE TWO LANES THAT JOINED 2026-08-04 — the manual-outbound send that books a texted time,
//     and the staff calendar edit. Both wrote their own copy of this field list before.
// ---------------------------------------------------------------------------------------------

// DIVERGENCE 3, PRESERVED — neither of the two stamps `confirmedBy`. Both call
// `setAppointmentBookedBy` themselves, and `confirmedBy` is what the KPI appointment-SETTER label
// falls back to; stamping it here would move a reported number, which a centralization may not do.
for (const lane of [MANUAL_OUTBOUND_LANE, EDIT_LANE] as const) {
  ok(
    decideAppointmentBookingRecord({ lane, hasBookedTime: true }).stampConfirmedBy === false,
    `${lane}: PRESERVED — leaves confirmedBy to its own attribution writer`
  );
}
for (const lane of ALL_LANES) {
  ok(
    decideAppointmentBookingRecord({ lane }).stampConfirmedBy === true,
    `${lane}: the three endpoint lanes still stamp confirmedBy — unchanged`
  );
}
// The manual-outbound lane must not silently overwrite a confirmedBy already on the record.
{
  const conv = latchedLead();
  conv.appointment.confirmedBy = "customer";
  applyAppointmentBookingRecord(conv, bookingInput(MANUAL_OUTBOUND_LANE, true) as any);
  eq(
    conv.appointment.confirmedBy,
    "customer",
    "manual-outbound booking leaves the stored confirmedBy exactly as it found it"
  );
  eq(conv.appointment.status, "confirmed", "...and the lead is still stamped on the calendar");
  eq(conv.appointment.acknowledged, true, "...and staff booked a chosen time, so her word is on file");
  eq(conv.appointment.matchedSlot, SLOT, "...and the slot it took is recorded, like the staff lane");
  eq(conv.appointment.reschedulePending, false, "...and it no longer owes a rebook");
  eq(conv.appointment.bookedEventId, "evt_abc123", "...and the event it created is on the record");
}

// DIVERGENCE 4, PRESERVED — staff dragging an event to a new hour is NOT the customer agreeing to
// the new hour, so the edit lane never touches `acknowledged`. This is the half that fails SAFE:
// an unacknowledged appointment still gets its 24h reminder.
ok(
  decideAppointmentBookingRecord({ lane: EDIT_LANE, hasBookedTime: true }).stampAcknowledged === false,
  "staff_calendar_edit: PRESERVED — a staff move does not put the customer's word on file"
);
eq(
  decideAppointmentBookingRecord({ lane: EDIT_LANE, hasBookedTime: true }).divergence,
  "staff_calendar_edit_does_not_refresh_the_customers_acknowledgement_of_the_new_time",
  "the gap that can cost a customer a visit is NAMED on every edit, not buried"
);
{
  const conv = latchedLead();
  conv.appointment.acknowledged = false;
  applyAppointmentBookingRecord(conv, {
    lane: EDIT_LANE,
    whenIso: SLOT.start,
    whenText: SLOT.startLocal
  } as any);
  eq(
    conv.appointment.acknowledged,
    false,
    "a staff calendar move leaves an UNacknowledged appointment unacknowledged, so it still gets " +
      "its 24h YES/NO reminder"
  );
  eq(conv.appointment.status, "confirmed", "the moved event is still a confirmed appointment");
  eq(conv.appointment.whenIso, SLOT.start, "the new hour is on the record");
  eq(conv.appointment.reschedulePending, false, "and the reschedule latch is cleared");
}

// The edit lane OWNS its booked-event ids: it patches what Google returned, so the referee must not
// clear them. A staff retitle that returns no id must never wipe the event off the record — that
// would strand the appointment with no way back to the calendar entry.
{
  const conv = latchedLead();
  conv.appointment.bookedEventId = "evt_LIVE";
  conv.appointment.bookedEventLink = "https://calendar.google.com/evt_LIVE";
  conv.appointment.bookedSalespersonId = "sp_LIVE";
  applyAppointmentBookingRecord(conv, {
    lane: EDIT_LANE,
    whenIso: SLOT.start,
    whenText: SLOT.startLocal
  } as any);
  eq(conv.appointment.bookedEventId, "evt_LIVE", "the edit lane never clears the live event id");
  eq(
    conv.appointment.bookedEventLink,
    "https://calendar.google.com/evt_LIVE",
    "...nor the live event link"
  );
  eq(conv.appointment.bookedSalespersonId, "sp_LIVE", "...nor who the event sits with");
}

// A METADATA-ONLY edit (staff recoloured or retitled; no hour moved) must not restamp the record.
// Fail direction: an appointment nobody rebooked must not come out of a colour change looking newly
// confirmed for a time that never changed.
{
  const d = decideAppointmentBookingRecord({ lane: EDIT_LANE, hasBookedTime: false });
  ok(d.record === true, "a metadata-only edit is still a recognized lane");
  ok(d.stampBookedTime === false, "...but it stamps no time and no status");
  ok(d.clearReschedulePending === true, "...while still clearing the latch, exactly as before");
}
{
  const conv = latchedLead();
  conv.appointment.status = "requested";
  conv.appointment.whenText = "Thursday at 10:00 AM";
  applyAppointmentBookingRecord(conv, { lane: EDIT_LANE } as any);
  eq(conv.appointment.status, "requested", "a colour change does not promote a request to confirmed");
  eq(conv.appointment.whenText, "Thursday at 10:00 AM", "...and does not touch the requested time");
  eq(conv.appointment.reschedulePending, false, "...but the latch still clears, as it always did");
}
// hasBookedTime is the EDIT lane's input alone — it must never move a creating lane's answer, or
// this cleanup would have quietly changed three live endpoints.
for (const lane of CREATING_LANES) {
  for (const hasBookedTime of [true, false, undefined]) {
    ok(
      decideAppointmentBookingRecord({ lane, hasBookedTime: hasBookedTime as any }).stampBookedTime ===
        true,
      `${lane}: always stamps the time regardless of hasBookedTime=${String(hasBookedTime)}`
    );
  }
}

// ---------------------------------------------------------------------------------------------
// 7. PURITY — the referee must be a function of its inputs alone, or the equivalence harness that
//    lets this ship without a human reading the diff is measuring nothing.
// ---------------------------------------------------------------------------------------------
for (const lane of EVERY_LANE) {
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
  for (const lane of [MANUAL_OUTBOUND_LANE, EDIT_LANE] as const) {
    for (const suffix of ["timed", "untimed"] as const) {
      ok(
        registry.some((entry: any) => entry.name === `appointmentBookingRecord:${lane}:${suffix}`),
        `the registry samples the ${lane} lane (${suffix}) by name — an un-stacking nobody ` +
          'fingerprints ships with no evidence behind its "IDENTICAL" verdict'
      );
    }
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
