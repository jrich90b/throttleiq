/**
 * schedule_request_confirmed_appointment:eval
 *
 * Paul Harrigan +17169467451, 2026-08-17. He had already ridden the bike and SHOWED for a booked
 * visit. He wrote "sounds great thanks again for everything I'll keep you posted when that loan check
 * comes in!" and the next draft asked "Sounds good, what time Friday works best?" — a scheduling
 * question he never asked and the rep had explicitly deferred one turn earlier.
 *
 * The parser was RIGHT (intent=none, explicit_request=false, 4/4 on the real text). The STATE was
 * stale: dialogState had been pinned to `schedule_request` two days before and nothing un-pins it.
 *
 * The obvious fix — adding `schedule_request` to `stickyDialogStates` in reduceStaleStateForInbound —
 * is UNSAFE, and this eval is here to keep it that way. isSchedulingLeakConversation
 * (domain/conversationStore.ts) reads exactly {schedule_soft, schedule_request, schedule_offer_sent}
 * to find "was mid-scheduling, never booked" leads. That is the booking-funnel leak detector, on the
 * metric that binds. Blanking the state on every manual_handoff thread makes that whole population
 * invisible to it.
 *
 * So the referee clears it only under the one carve-out that is PROVABLY invisible to the detector:
 * an appointment already `confirmed`, which the detector's own early return drops before it ever
 * looks at the dialog state. Section 2 below does not take that on trust — it EXECUTES the detector
 * on the carve-out shape and asserts it was already blind to it.
 *
 * Measured on the live store 2026-08-20: 58 manual_handoff threads carry a sticky schedule_request,
 * 7 with a confirmed appointment. The detector flags 8 conversations store-wide and NONE of those 7,
 * so the change leaves its population at 8.
 *
 * WIDENED 2026-08-22. The arm originally also required followUp.mode === "manual_handoff". That was
 * never part of the proof — isSchedulingLeakConversation does not read followUp.mode at any point, so
 * "a confirmed appointment is already invisible to the detector" holds in every mode. The narrowing
 * only reflected the population #767 was measuring, and left the same stale-state bug live elsewhere.
 *
 * Measured 2026-08-22 by executing the reducer over 883 live conversations: 118 sticky
 * schedule_request, 28 with a confirmed appointment; the arm fired on 8 and now fires on 22 (the 14
 * added are 11 active + 3 with no follow-up mode), every one with an appointment 9.6-121.5 days in
 * the PAST. 11 of the 14 are closed, so live reach goes from 3 to 6 OPEN threads and the rest is
 * latent. The detector's flagged population, executed before and after: 8 -> 8, delta 0.
 *
 * NOTE for future triage: +17163160886 (Mark) surfaced this class in the 8/21 feed, but he is
 * followUp.mode "manual_handoff" and was ALREADY covered by #767 — do not cite him as the uncovered
 * instance. An earlier note claiming he was "active" did not survive execution against the store.
 */
import assert from "node:assert/strict";

const { reduceStaleStateForInbound } = await import("../services/api/src/domain/routeStateReducer.ts");
const { isSchedulingLeakConversation } = await import("../services/api/src/domain/conversationStore.ts");

type Row = {
  name: string;
  input: Parameters<typeof reduceStaleStateForInbound>[0];
  clearsDialogState: boolean;
  /** Present only when the clear must be attributed to THIS arm, not a neighbouring one. */
  reason?: string;
};

const CONFIRMED = { appointmentStatus: "confirmed" as const };

// ---------------------------------------------------------------------------------------------
// 1. The decision table. What matters is whether the dialog state gets blanked, not the wording of
//    any label — but where an arm's identity is the point, the reason string is asserted too.
// ---------------------------------------------------------------------------------------------
const ROWS: Row[] = [
  {
    name: "Paul: manual_handoff + sticky schedule_request + the visit already confirmed => clear",
    input: { followUpMode: "manual_handoff", followUpReason: "dealer_ride_outcome_pending", dialogState: "schedule_request", ...CONFIRMED },
    clearsDialogState: true,
    reason: "clear_schedule_request_appointment_confirmed"
  },
  {
    name: "the SAME thread with no appointment on the books stays visible to the leak detector",
    input: { followUpMode: "manual_handoff", followUpReason: "dealer_ride_outcome_pending", dialogState: "schedule_request" },
    clearsDialogState: false
  },
  {
    name: "appointment status none is not a confirmation",
    input: { followUpMode: "manual_handoff", dialogState: "schedule_request", appointmentStatus: "none" },
    clearsDialogState: false
  },
  {
    name: "a PROPOSED time is not a booking — still mid-scheduling, still the detector's business",
    input: { followUpMode: "manual_handoff", dialogState: "schedule_request", appointmentStatus: "proposed" },
    clearsDialogState: false
  },
  {
    name: "a reschedule in flight is CURRENT state, not stale state => keep it",
    input: { followUpMode: "manual_handoff", dialogState: "schedule_request", ...CONFIRMED, appointmentReschedulePending: true },
    clearsDialogState: false
  },
  {
    name: "the customer raised scheduling THIS turn => keep it; the scheduling arm owns the turn",
    input: { followUpMode: "manual_handoff", dialogState: "schedule_request", ...CONFIRMED, hasSchedulingIntent: true },
    clearsDialogState: false
  },
  // The follow-up mode is NOT part of the safety proof, and these rows are what says so. Until
  // 2026-08-22 the arm also required manual_handoff, and this eval pinned "active => do not clear" —
  // pinning the population #767 happened to measure rather than the argument that made it safe.
  // isSchedulingLeakConversation never reads followUp.mode, so a confirmed appointment is invisible
  // to it in EVERY mode. Mark +17163160886 (active, appointment confirmed, state pinned 2026-08-15)
  // is the instance that flushed this out. If a future change re-narrows the arm to one mode, these
  // rows fail and that is the alarm.
  {
    name: "active thread with the visit already confirmed => clear (the mode is not the proof)",
    input: { followUpMode: "active", dialogState: "schedule_request", ...CONFIRMED },
    clearsDialogState: true,
    reason: "clear_schedule_request_appointment_confirmed"
  },
  {
    name: "holding_inventory + confirmed visit => clear",
    input: { followUpMode: "holding_inventory", dialogState: "schedule_request", ...CONFIRMED },
    clearsDialogState: true,
    reason: "clear_schedule_request_appointment_confirmed"
  },
  {
    name: "paused_indefinite + confirmed visit => clear",
    input: { followUpMode: "paused_indefinite", dialogState: "schedule_request", ...CONFIRMED },
    clearsDialogState: true,
    reason: "clear_schedule_request_appointment_confirmed"
  },
  {
    name: "no follow-up mode recorded at all + confirmed visit => clear (6 of the 20 live threads)",
    input: { followUpMode: "", dialogState: "schedule_request", ...CONFIRMED },
    clearsDialogState: true,
    reason: "clear_schedule_request_appointment_confirmed"
  },
  // The two guards have to survive the widening in the modes it newly reaches, not just in
  // manual_handoff — otherwise widening the arm would quietly widen the guard-bypass with it.
  {
    name: "active + a reschedule in flight => keep the state, the visit is being moved",
    input: { followUpMode: "active", dialogState: "schedule_request", ...CONFIRMED, appointmentReschedulePending: true },
    clearsDialogState: false
  },
  {
    name: "active + the customer raised scheduling THIS turn => keep it",
    input: { followUpMode: "active", dialogState: "schedule_request", ...CONFIRMED, hasSchedulingIntent: true },
    clearsDialogState: false
  },
  {
    name: "active + schedule_request but NOTHING booked => untouched, still the detector's business",
    input: { followUpMode: "active", dialogState: "schedule_request" },
    clearsDialogState: false
  },
  {
    name: "schedule_offer_sent is NOT in the carve-out — we offered times and nobody booked",
    input: { followUpMode: "manual_handoff", dialogState: "schedule_offer_sent", ...CONFIRMED },
    clearsDialogState: false
  },
  {
    name: "schedule_soft was already cleared on manual_handoff and still is (pre-existing arm)",
    input: { followUpMode: "manual_handoff", dialogState: "schedule_soft" },
    clearsDialogState: true,
    reason: "clear_sticky_dialog_state:schedule_soft"
  },
  {
    name: "schedule_booked is not a pending state and needs no clearing",
    input: { followUpMode: "manual_handoff", dialogState: "schedule_booked", ...CONFIRMED },
    clearsDialogState: false
  }
];

for (const row of ROWS) {
  const decision = reduceStaleStateForInbound(row.input);
  assert.equal(decision.setDialogStateToNone, row.clearsDialogState, `setDialogStateToNone wrong for: ${row.name}`);
  if (row.reason) {
    assert.equal(decision.reasons.includes(row.reason), true, `missing reason "${row.reason}" for: ${row.name}`);
  }
  if (!row.clearsDialogState) {
    assert.equal(
      decision.reasons.includes("clear_schedule_request_appointment_confirmed"),
      false,
      `the confirmed-appointment arm fired when it must not for: ${row.name}`
    );
  }
}

// ---------------------------------------------------------------------------------------------
// 2. The safety proof, EXECUTED rather than asserted in prose: the shape this arm clears was already
//    invisible to the scheduling-leak detector, so clearing it cannot cost the detector a lead. If a
//    future change makes the detector look past a confirmed appointment, this fails and the carve-out
//    has to be rethought — that is exactly the alarm we want.
// ---------------------------------------------------------------------------------------------
const NOW = new Date("2026-08-20T12:00:00.000Z");
const stalledScheduling = [
  { direction: "in", body: "I'm shooting for Friday", at: "2026-08-19T21:05:00.000Z" },
  { direction: "out", body: "Sounds good — I'll plan for Friday.", at: "2026-08-19T21:21:00.000Z" }
];

const mk = (appointment: Record<string, unknown> | null) => ({
  messages: stalledScheduling,
  dialogState: { name: "schedule_request", updatedAt: "2026-08-19T21:05:00.000Z" },
  appointment,
  closedAt: null,
  closedReason: null
});

// The population the detector is FOR: mid-scheduling, nothing booked, gone quiet. The referee leaves
// these alone (row 2 above), so the detector keeps seeing them.
assert.equal(
  isSchedulingLeakConversation(mk(null) as any, NOW),
  true,
  "a stalled schedule_request with no appointment must stay a leak the detector can see"
);
assert.equal(
  isSchedulingLeakConversation(mk({ status: "proposed" }) as any, NOW),
  true,
  "a proposed-but-unbooked time must stay a leak the detector can see"
);

// The carve-out population: the detector was ALREADY blind to it before this change, so the referee
// blanking the state changes nothing it could ever have reported.
assert.equal(
  isSchedulingLeakConversation(mk({ status: "confirmed", whenIso: "2026-08-15T16:00:00.000Z" }) as any, NOW),
  false,
  "a conversation with a confirmed appointment was already invisible to the leak detector"
);

// And after the referee blanks it, it is still invisible — the clear is a no-op for the detector in
// both directions, which is the whole reason this arm is safe.
const cleared = { ...mk({ status: "confirmed", whenIso: "2026-08-15T16:00:00.000Z" }), dialogState: { name: "none", updatedAt: NOW.toISOString() } };
assert.equal(
  isSchedulingLeakConversation(cleared as any, NOW),
  false,
  "clearing the dialog state must not change what the leak detector reports for this conversation"
);

// The widening rests entirely on the detector being blind to followUp.mode. Assert that by
// EXECUTING it across every mode the store actually carries: if some future change teaches the
// detector to care about the follow-up mode, the carve-out stops being provably free and this fails
// before the arm can silently start costing the booking-funnel detector leads.
for (const followUpMode of ["manual_handoff", "active", "holding_inventory", "paused_indefinite", ""]) {
  const withMode = (appointment: Record<string, unknown> | null) => ({
    ...mk(appointment),
    followUp: { mode: followUpMode, reason: null }
  });
  assert.equal(
    isSchedulingLeakConversation(withMode({ status: "confirmed", whenIso: "2026-08-15T16:00:00.000Z" }) as any, NOW),
    false,
    `a confirmed appointment must be invisible to the leak detector in followUp.mode "${followUpMode}"`
  );
  assert.equal(
    isSchedulingLeakConversation(withMode(null) as any, NOW),
    true,
    `an unbooked stalled schedule_request must stay VISIBLE in followUp.mode "${followUpMode}"`
  );
}

console.log(`schedule_request_confirmed_appointment:eval — PASS (${ROWS.length} decision rows + 14 leak-detector invariants)`);
