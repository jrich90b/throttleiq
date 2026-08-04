/**
 * appointment_confirm_record:eval — ONE referee for "when we stamp an appointment `confirmed`,
 * what else does the record get: is the customer's word on file (`acknowledged`), and does the
 * reschedule latch clear?"
 *
 * WHAT WAS FIGHTING. Three independent places stamp `appointment.status = "confirmed"`, each
 * deciding the companion fields for itself:
 *
 *   confirmAppointmentIfMatchesSuggested   customer's TEXT matched a suggested slot — no calendar
 *                                          write happens there (3 branches, all consistent)
 *   the confirm-book path (index.ts)       customer's ack booked a real calendar event
 *   the voice post-summary path (index.ts) a rep's call produced an exact slot; calendar booked
 *
 * THE DIVERGENCES, PINNED AS-IS (preserved by the un-stacking, NOT fixed by it):
 *
 *   1. `acknowledged` — TRUE on the booked lanes, FALSE on slot-match. Correct and load-bearing:
 *      `acknowledged` suppresses the automatic 24h "Reply YES to confirm or NO to reschedule"
 *      reminder (transitionSafety, the Peter Meredith ruling 2026-07-20). The booked lanes hold a
 *      real event the customer just agreed to; the slot-match confirm is provisional — no calendar
 *      event exists yet, and pre-acknowledging would suppress the reminder for the EVENTUAL real
 *      booking with a stamp made before that booking existed. Fail direction: false costs one
 *      extra reminder; a wrong true means a half-committed customer is never nudged and no-shows.
 *
 *   2. the `reschedulePending` latch — CLEARED by the booked lanes, LEFT STANDING by slot-match.
 *      So a mid-reschedule lead whose text matches a slot ends up `confirmed` with
 *      `reschedulePending=true` at once — the stale-latch state two downstream guards already
 *      carry local armor against. Named on the decision so the follow-up ruling has an anchor.
 *
 * FAIL DIRECTION. Refusing to stamp is the SAFE answer: an unconfirmed appointment costs at most
 * a re-ask; a wrong confirm tells a customer "you're all set" for a slot nothing holds. An
 * unrecognized lane refuses. (The two booked WRITE SITES deliberately do not re-check `confirm` —
 * their calendar event is already written by then, and stranding a real booking without a record
 * would be worse; the lane is static there.)
 *
 * Behavior assertions only — no source-text pins (see eval_source_pin_ratchet:eval).
 *
 * Run: npx tsx scripts/appointment_confirm_record_eval.ts
 */
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";

process.env.CONVERSATIONS_DB_PATH =
  process.env.CONVERSATIONS_DB_PATH ||
  path.join(os.tmpdir(), `appointment-confirm-record-eval-${Date.now()}.json`);

const { decideAppointmentConfirmRecord } = await import(
  "../services/api/src/domain/routeStateReducer.ts"
);
const { confirmAppointmentIfMatchesSuggested, applyAppointmentConfirmRecord, markAppointmentAcknowledged } =
  await import(
  "../services/api/src/domain/conversationStore.ts"
);

let checks = 0;
const eq = (actual: unknown, expected: unknown, message: string) => {
  assert.deepEqual(actual, expected, message);
  checks++;
};

// =================================================================================================
// THE REFEREE — the arbitration itself
// =================================================================================================

// --- the two booked lanes: word on file, latch cleared -------------------------------------------
for (const lane of ["customer_confirm_booking", "voice_summary_booking"] as const) {
  const d = decideAppointmentConfirmRecord({ lane, reschedulePending: true });
  eq(d.confirm, true, `${lane} stamps the record`);
  eq(d.acknowledged, true, `${lane}: a real calendar event means the customer's word is on file`);
  eq(d.clearReschedulePending, true, `${lane}: booking settles the reschedule — the latch clears`);
  eq(d.confirmedBy, "customer", `${lane}: the time is the customer's own, even when a rep books it`);
  eq(d.divergence, null, `${lane}: clearing the latch is the agreeing majority, not a divergence`);
}

// --- the slot-match lane: provisional — reminder stays armed, latch untouched --------------------
{
  const d = decideAppointmentConfirmRecord({ lane: "customer_slot_match", reschedulePending: false });
  eq(d.confirm, true, "slot-match stamps the record");
  eq(d.acknowledged, false, "slot-match: no calendar event yet — the 24h reminder must stay armed");
  eq(d.clearReschedulePending, false, "slot-match: the latch is not this lane's to clear");
  eq(d.divergence, null, "no divergence when no latch was standing");
}

// --- DIVERGENCE 2 is NAMED exactly when the contradiction actually occurs ------------------------
{
  const latched = decideAppointmentConfirmRecord({
    lane: "customer_slot_match",
    reschedulePending: true
  });
  eq(
    latched.divergence,
    "slot_match_confirm_leaves_the_reschedule_latch_standing",
    "a slot-match confirm over a standing latch is NAMED — confirmed + reschedule-pending at once"
  );
  eq(latched.clearReschedulePending, false, "...and today's behaviour is preserved: latch stands");
}

// --- FAIL DIRECTION: an unrecognized lane refuses -------------------------------------------------
{
  const d = decideAppointmentConfirmRecord({ lane: "something_nobody_wired", reschedulePending: false });
  eq(d.confirm, false, "an unrecognized lane refuses — never stamp a confirm nothing holds");
}

// --- SECOND SLICE (2026-08-04): the two STAFF lanes ----------------------------------------------
// Divergence 3: the manual-outbound path used to ask on the CUSTOMER lane and then overwrite both
// answers it got back. It has its own lane now, and the answer it always applied is the one pinned.
{
  const d = decideAppointmentConfirmRecord({ lane: "salesperson_manual_booking", reschedulePending: true });
  eq(d.confirm, true, "salesperson_manual_booking stamps the record");
  eq(d.confirmedBy, "salesperson", "the rep typed the words — crediting the customer for them is false");
  eq(d.acknowledged, true, "a human pressed send on that time, so the robotic YES/NO re-ask stays off");
  eq(d.clearReschedulePending, false, "no calendar event on this path either — the latch is left alone");
  eq(
    d.divergence,
    "slot_match_confirm_leaves_the_reschedule_latch_standing",
    "...and the standing-latch contradiction is still named, exactly as on the customer lane"
  );
}
// Divergence 4 — none: the manual-send lane already agreed with the referee. It may only put the
// word on file for a record that is ALREADY confirmed, and it never touches WHO confirmed it.
{
  const confirmed = { lane: "salesperson_manual_send", currentStatus: "confirmed" } as const;
  const d = decideAppointmentConfirmRecord(confirmed);
  eq(d.confirm, true, "staff sending on a confirmed thread may put the word on file");
  eq(d.acknowledged, true, "...which is what stands the automatic re-ask down");
  eq(d.confirmedBy, null, "...but this lane has NO view on who confirmed — the credit is left alone");
  eq(d.clearReschedulePending, false, "...and it never clears the reschedule latch");
}
eq(
  decideAppointmentConfirmRecord({ lane: "salesperson_manual_send", currentStatus: "pending" }).confirm,
  false,
  "a manual send must NOT stamp a confirm into existence — nothing was agreed yet"
);
eq(
  decideAppointmentConfirmRecord({ lane: "salesperson_manual_send", currentStatus: null }).confirm,
  false,
  "...and with no appointment at all there is nothing to acknowledge"
);
eq(
  decideAppointmentConfirmRecord({
    lane: "salesperson_manual_send",
    currentStatus: "confirmed",
    currentAcknowledged: true
  }).confirm,
  false,
  "already acknowledged — nothing to restamp, so no needless save"
);

// =================================================================================================
// THE WRITE SITE — the store's slot-match function actually asks the referee
// (the two index.ts booked sites are covered by the registry + decision equivalence; they cannot
// run here without booting Google Calendar)
// =================================================================================================

const SLOT = {
  start: "2026-08-05T15:00:00.000Z",
  end: "2026-08-05T15:30:00.000Z",
  startLocal: "Wed Aug 5, 11:00 AM",
  endLocal: "Wed Aug 5, 11:30 AM",
  salespersonId: "sp1",
  salespersonName: "Alex",
  calendarId: "cal1"
};

// --- an exact match stamps a provisional confirm --------------------------------------------------
{
  const conv: any = {
    id: "a1",
    status: "open",
    scheduler: { lastSuggestedSlots: [SLOT] },
    appointment: { status: "none", updatedAt: "2026-08-01T00:00:00.000Z", reschedulePending: true }
  };
  const matched = confirmAppointmentIfMatchesSuggested(conv, "Wed Aug 5, 11:00 AM works for me");
  eq(matched, true, "the customer's text matched the suggested slot");
  eq(conv.appointment.status, "confirmed", "the appointment is stamped confirmed");
  eq(conv.appointment.confirmedBy, "customer", "...by the customer");
  eq(conv.appointment.acknowledged, false, "...provisionally — the 24h reminder stays armed");
  eq(conv.appointment.reschedulePending, true, "...and the standing latch is LEFT AS-IS (pinned)");
  eq(conv.appointment.whenIso, SLOT.start, "...at the matched slot's time");
}

// --- no match, no stamp ---------------------------------------------------------------------------
{
  const conv: any = {
    id: "a2",
    status: "open",
    scheduler: { lastSuggestedSlots: [SLOT] },
    appointment: { status: "none", updatedAt: "2026-08-01T00:00:00.000Z" }
  };
  const matched = confirmAppointmentIfMatchesSuggested(conv, "what colors does it come in?");
  eq(matched, false, "an unrelated text matches nothing");
  eq(conv.appointment.status, "none", "...and the record is untouched");
}

// --- the manual-outbound lane: the rep's OWN send matched the slot --------------------------------
{
  const conv: any = {
    id: "a3",
    status: "open",
    scheduler: { lastSuggestedSlots: [SLOT] },
    appointment: { status: "none", updatedAt: "2026-08-01T00:00:00.000Z", reschedulePending: true }
  };
  const matched = confirmAppointmentIfMatchesSuggested(
    conv,
    "See you Wed Aug 5, 11:00 AM",
    undefined,
    { lane: "salesperson_manual_booking" }
  );
  eq(matched, true, "the rep's own outbound matched the suggested slot");
  eq(conv.appointment.confirmedBy, "salesperson", "the credit goes to the rep who typed it");
  eq(conv.appointment.acknowledged, true, "...and the automatic re-ask stands down");
  eq(conv.appointment.reschedulePending, true, "...while the standing latch is still LEFT AS-IS");
}

// --- markAppointmentAcknowledged: staff sent something on a confirmed thread ----------------------
{
  const conv: any = {
    id: "a4",
    status: "open",
    appointment: {
      status: "confirmed",
      confirmedBy: "customer",
      acknowledged: false,
      reschedulePending: true,
      updatedAt: "2026-08-01T00:00:00.000Z"
    }
  };
  markAppointmentAcknowledged(conv);
  eq(conv.appointment.acknowledged, true, "a manual send puts the word on file");
  eq(conv.appointment.confirmedBy, "customer", "...WITHOUT stealing the credit from the customer");
  eq(conv.appointment.reschedulePending, true, "...and without clearing the reschedule latch");
}
{
  const conv: any = {
    id: "a5",
    status: "open",
    appointment: { status: "pending", acknowledged: false, updatedAt: "2026-08-01T00:00:00.000Z" }
  };
  markAppointmentAcknowledged(conv);
  eq(conv.appointment.status, "pending", "an unconfirmed appointment is NOT confirmed by a manual send");
  eq(conv.appointment.acknowledged, false, "...and nothing is put on file for it");
}
{
  const conv: any = { id: "a6", status: "open" };
  markAppointmentAcknowledged(conv);
  eq(conv.appointment, undefined, "no appointment at all: a manual send must not create one");
}

// =================================================================================================
// THE APPLIER — what the two index.ts booked lanes actually call (they cannot run here without
// booting Google Calendar, so the applier that carries their share of the arbitration is pinned
// directly)
// =================================================================================================

// --- a booked lane through the applier: word on file, latch cleared -------------------------------
{
  const conv: any = {
    id: "b1",
    status: "open",
    appointment: {
      status: "pending",
      updatedAt: "2026-08-01T00:00:00.000Z",
      reschedulePending: true
    }
  };
  const decision = applyAppointmentConfirmRecord(conv, "customer_confirm_booking");
  eq(decision.confirm, true, "the applier stamped the booked confirm");
  eq(conv.appointment.status, "confirmed", "the record reads confirmed");
  eq(conv.appointment.confirmedBy, "customer", "...by the customer");
  eq(conv.appointment.acknowledged, true, "...word on file — the 24h reminder is satisfied");
  eq(conv.appointment.reschedulePending, false, "...and the reschedule latch cleared");
}

// --- the applier creates the record when none exists -----------------------------------------------
{
  const conv: any = { id: "b2", status: "open" };
  applyAppointmentConfirmRecord(conv, "voice_summary_booking");
  eq(conv.appointment.status, "confirmed", "a missing record is created and stamped");
  eq(conv.appointment.acknowledged, true, "...acknowledged, since a real event was booked");
}

// --- the applier does not stamp updatedAt: its callers own the save --------------------------------
{
  const conv: any = {
    id: "b3",
    status: "open",
    appointment: { status: "pending", updatedAt: "2026-01-01T00:00:00.000Z" }
  };
  applyAppointmentConfirmRecord(conv, "customer_confirm_booking");
  eq(conv.appointment.updatedAt, "2026-01-01T00:00:00.000Z", "the applier leaves the save to its caller");
}

// --- 8/3 wiring triage (theme B3): the four SELF-BOOKING lanes actually CALL the referee ----------
// Three live-SMS lanes + the email lane booked a real calendar event, hand-stamped
// status/confirmedBy/acknowledged, and never cleared the reschedule latch — so a customer who just
// booked kept `reschedulePending: true`, and their next day/time text was answered with "let's
// find you another time" for the appointment they had just made. The referee (divergence 2, RULED
// 8/2) clears the latch for booked lanes; these pins keep the lanes routed through it.
{
  const fsMod = await import("node:fs");
  const api = fsMod.readFileSync("services/api/src/index.ts", "utf8");
  const sendgrid = fsMod.readFileSync("services/api/src/routes/sendgridInbound.ts", "utf8");

  const apiRefereeCalls = api.match(/applyAppointmentConfirmRecord\(conv, "customer_confirm_booking"\)/g) ?? [];
  eq(
    apiRefereeCalls.length >= 4,
    true,
    `index.ts must route the customer-booking confirms through the referee (found ${apiRefereeCalls.length}, need >= 4: the confirm-book path + the three self-booking lanes)`
  );
  const sgRefereeCalls = sendgrid.match(/applyAppointmentConfirmRecord\(conv, "customer_confirm_booking"\)/g) ?? [];
  eq(sgRefereeCalls.length >= 1, true, "the email lane's self-booking must route through the referee too");

  // Ratchet, down-only: the remaining hand-rolled confirm stamps. The 6 leftovers are the
  // reschedule-confirm/auto-book lanes that DO clear the latch themselves (the un-stack loop's
  // future work). Raising this number means a NEW lane hand-stamped a confirm instead of asking
  // the referee — do not raise it.
  const handRolled = api.match(/conv\.appointment\.confirmedBy = "customer"/g) ?? [];
  eq(
    handRolled.length <= 6,
    true,
    `hand-rolled confirmedBy stamps in index.ts must not grow (found ${handRolled.length}, ceiling 6)`
  );
  eq(
    (sendgrid.match(/conv\.appointment\.confirmedBy = "customer"/g) ?? []).length,
    0,
    "the email lane must have ZERO hand-rolled confirm stamps"
  );
  checks += 4;
}

console.log(`appointment_confirm_record:eval OK — ${checks} checks`);
