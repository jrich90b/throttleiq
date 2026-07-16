/**
 * Scheduling-turn decision-table eval (Phase 0 of the routing-de-tangle program).
 *
 * `decideSchedulingTurn` (services/api/src/domain/routeStateReducer.ts) is the single
 * source of truth for the scheduling-cluster route precedence that used to live as a
 * chain of inline `if` blocks in the /webhooks/twilio handler. This eval pins that
 * precedence as a decision table so the centralization stays behavior-preserving and
 * the Todd Herian class of bug (a future-day visit commitment downgraded to the vague
 * arrival ack) cannot regress.
 *
 * Precedence under test: A (customer-ack) > B (appointment-timing) > C (visit
 * commitment), with a visit commitment preempting ONLY the arrival-window ack
 * (provide_arrival_window / arrival_update), and pricing suppressing A+B. (The handler
 * applies the top-level routeExec callback/pricing/availability gate to the
 * visit_commitment arm separately, where those flags are known.)
 */
import assert from "node:assert/strict";
import {
  decideSchedulingTurn,
  isExplicitSchedulingAskIntent
} from "../services/api/src/domain/routeStateReducer.ts";

type Row = {
  id: string;
  input: Parameters<typeof decideSchedulingTurn>[0];
  kind: string;
  visitCommitment?: boolean;
};

const base = {
  customerAckActionAccepted: false,
  customerAckAction: null as string | null,
  appointmentTimingAccepted: false,
  appointmentTimingIntent: null as string | null,
  parserScheduleStatusUpdate: false,
  pricingOrPaymentsIntent: false,
  scheduleDialogState: true,
  scheduleOfferContext: true
};

const VISIT = {
  parserScheduleStatusUpdate: true,
  scheduleDialogState: true,
  scheduleOfferContext: true
};

const rows: Row[] = [
  // --- Block A: customer-ack actions (top precedence) ---
  { id: "ack_accept_tentative", input: { ...base, customerAckActionAccepted: true, customerAckAction: "accept_tentative_appointment" }, kind: "accept_tentative" },
  { id: "ack_ask_times", input: { ...base, customerAckActionAccepted: true, customerAckAction: "ask_for_available_times" }, kind: "ask_available_times" },
  { id: "ack_status_q", input: { ...base, customerAckActionAccepted: true, customerAckAction: "appointment_status_question" }, kind: "appointment_status_question" },
  { id: "ack_arrival_window", input: { ...base, customerAckActionAccepted: true, customerAckAction: "provide_arrival_window" }, kind: "arrival_window" },
  { id: "ack_immediate", input: { ...base, customerAckActionAccepted: true, customerAckAction: "immediate_arrival_request" }, kind: "immediate_arrival" },
  { id: "ack_purchase_delivery", input: { ...base, customerAckActionAccepted: true, customerAckAction: "purchase_delivery_update" }, kind: "purchase_delivery" },

  // --- confirm_proposed_appointment: a concrete confirm the agent didn't pre-offer ---
  // shouldBook cleared by the parser => route to the auto-book arm.
  { id: "ack_confirm_books", input: { ...base, customerAckActionAccepted: true, customerAckAction: "confirm_proposed_appointment", customerAckShouldBook: true }, kind: "confirm_appointment" },
  // shouldBook NOT set => never auto-book on a vague signal; falls through (none here).
  { id: "ack_confirm_no_book_falls_through", input: { ...base, customerAckActionAccepted: true, customerAckAction: "confirm_proposed_appointment", customerAckShouldBook: false }, kind: "none" },
  // confirm-to-book outranks a competing appointment-timing read (A over B).
  { id: "confirm_beats_appt_timing", input: { ...base, customerAckActionAccepted: true, customerAckAction: "confirm_proposed_appointment", customerAckShouldBook: true, appointmentTimingAccepted: true, appointmentTimingIntent: "decline_time" }, kind: "confirm_appointment" },
  // pricing/payments suppresses the confirm-to-book arm (Block A is gated on !pricing).
  { id: "confirm_book_suppressed_by_pricing", input: { ...base, pricingOrPaymentsIntent: true, customerAckActionAccepted: true, customerAckAction: "confirm_proposed_appointment", customerAckShouldBook: true }, kind: "none" },

  // --- A precedence over B ---
  { id: "ack_beats_appt_timing", input: { ...base, customerAckActionAccepted: true, customerAckAction: "accept_tentative_appointment", appointmentTimingAccepted: true, appointmentTimingIntent: "decline_time" }, kind: "accept_tentative" },

  // --- confirm_proposed_appointment WITHOUT shouldBook falls through to B ---
  { id: "noncluster_ack_falls_to_timing", input: { ...base, customerAckActionAccepted: true, customerAckAction: "confirm_proposed_appointment", appointmentTimingAccepted: true, appointmentTimingIntent: "tentative_time_window" }, kind: "tentative_window" },

  // --- Block B: appointment-timing intents ---
  { id: "timing_arrival_update", input: { ...base, appointmentTimingAccepted: true, appointmentTimingIntent: "arrival_update" }, kind: "arrival_update" },
  { id: "timing_tentative", input: { ...base, appointmentTimingAccepted: true, appointmentTimingIntent: "tentative_time_window" }, kind: "tentative_window" },
  { id: "timing_decline", input: { ...base, appointmentTimingAccepted: true, appointmentTimingIntent: "decline_time" }, kind: "decline_time" },

  // --- provide_new_time: a customer-PROPOSED time (no prior dealer offer, so Block A never fired) ---
  // Concrete day+time => route to the book-or-offer resolver (propose_booking), not a bare deflection.
  // Mark Ezell +17169904133 ("Tomorrow at 930am?") — the routing hole that let the orchestrator improvise.
  { id: "timing_provide_new_time_concrete_daytime", input: { ...base, appointmentTimingAccepted: true, appointmentTimingIntent: "provide_new_time", appointmentTimingHasConcreteDayTime: true }, kind: "propose_booking" },
  // Day-ONLY proposal ("I'll come Saturday") is NOT booked here — it keeps its slot-offer path (#203).
  { id: "timing_provide_new_time_day_only", input: { ...base, appointmentTimingAccepted: true, appointmentTimingIntent: "provide_new_time", appointmentTimingHasConcreteDayTime: false }, kind: "none" },
  // A customer-ack confirm still OUTRANKS a competing provide_new_time (A over B).
  { id: "confirm_beats_provide_new_time", input: { ...base, customerAckActionAccepted: true, customerAckAction: "confirm_proposed_appointment", customerAckShouldBook: true, appointmentTimingAccepted: true, appointmentTimingIntent: "provide_new_time", appointmentTimingHasConcreteDayTime: true }, kind: "confirm_appointment" },
  // Pricing/payments suppresses Block B, so a concrete proposal does not book mid-pricing thread.
  { id: "provide_new_time_suppressed_by_pricing", input: { ...base, pricingOrPaymentsIntent: true, appointmentTimingAccepted: true, appointmentTimingIntent: "provide_new_time", appointmentTimingHasConcreteDayTime: true }, kind: "none" },

  // --- Block C: visit commitment, and the Todd preemption rules ---
  { id: "visit_commitment_plain", input: { ...base, ...VISIT }, kind: "visit_commitment", visitCommitment: true },
  {
    // Todd Herian production turn: appointment-timing read it as arrival_update, but a
    // recognized visit commitment must win and confirm the day.
    id: "todd_visit_beats_arrival_update",
    input: { ...base, ...VISIT, appointmentTimingAccepted: true, appointmentTimingIntent: "arrival_update" },
    kind: "visit_commitment",
    visitCommitment: true
  },
  { id: "visit_beats_ack_arrival_window", input: { ...base, ...VISIT, customerAckActionAccepted: true, customerAckAction: "provide_arrival_window" }, kind: "visit_commitment", visitCommitment: true },
  // Visit preempts ONLY the arrival ack — other A/B arms still win over the visit commitment.
  { id: "visit_does_not_beat_accept_tentative", input: { ...base, ...VISIT, customerAckActionAccepted: true, customerAckAction: "accept_tentative_appointment" }, kind: "accept_tentative", visitCommitment: true },
  { id: "visit_does_not_beat_tentative_timing", input: { ...base, ...VISIT, customerAckActionAccepted: true, customerAckAction: "provide_arrival_window", appointmentTimingAccepted: true, appointmentTimingIntent: "tentative_time_window" }, kind: "tentative_window", visitCommitment: true },

  // --- visit commitment requires parser signal AND active schedule context ---
  { id: "no_context_no_visit", input: { ...base, customerAckActionAccepted: true, customerAckAction: "provide_arrival_window", parserScheduleStatusUpdate: true, scheduleDialogState: false, scheduleOfferContext: false }, kind: "arrival_window", visitCommitment: false },

  // --- pricing suppresses A and B (visit_commitment recognition still surfaces; the
  //     handler's routeExec pricing gate suppresses the arm downstream) ---
  { id: "pricing_suppresses_ack_arrival", input: { ...base, pricingOrPaymentsIntent: true, customerAckActionAccepted: true, customerAckAction: "provide_arrival_window" }, kind: "none" },
  { id: "pricing_suppresses_timing", input: { ...base, pricingOrPaymentsIntent: true, appointmentTimingAccepted: true, appointmentTimingIntent: "arrival_update" }, kind: "none" },
  { id: "pricing_with_visit_still_recognized", input: { ...base, ...VISIT, pricingOrPaymentsIntent: true, appointmentTimingAccepted: true, appointmentTimingIntent: "arrival_update" }, kind: "visit_commitment", visitCommitment: true },

  // --- nothing ---
  { id: "none", input: { ...base, scheduleDialogState: false, scheduleOfferContext: false }, kind: "none", visitCommitment: false }
];

let passed = 0;
for (const row of rows) {
  const out = decideSchedulingTurn(row.input);
  assert.equal(out.kind, row.kind, `${row.id}: expected kind ${row.kind}, got ${out.kind}`);
  if (row.visitCommitment !== undefined) {
    assert.equal(out.visitCommitment, row.visitCommitment, `${row.id}: expected visitCommitment ${row.visitCommitment}, got ${out.visitCommitment}`);
  }
  passed += 1;
}

// Explicit-scheduling-ask predicate — the mentioned-user/callback shortcut in both
// /webhooks/twilio and /conversations/:id/regenerate is suppressed when this is true, so
// a scheduling ask that merely greets the rep by name routes to scheduling instead of a
// spurious callback. Origin: Jeffrey +17164182619 (2026-06-15) — "Good morning Scott… the
// bike is finally paid off… would Saturday be a possibility?" parsed as appointment-timing
// ask_for_times but the "Good morning Scott" greeting hijacked the turn into a callback-to-
// Scott + a bare "Thanks for the update." ack, dropping the Saturday request.
assert.equal(isExplicitSchedulingAskIntent("ask_for_times"), true, "ask_for_times is an explicit scheduling ask");
assert.equal(isExplicitSchedulingAskIntent("provide_new_time"), true, "provide_new_time is an explicit scheduling ask");
assert.equal(isExplicitSchedulingAskIntent("accept_proposed_time"), false, "accept (confirmation) is not the ask gate");
assert.equal(isExplicitSchedulingAskIntent("arrival_update"), false, "arrival_update must not suppress the mention shortcut");
assert.equal(isExplicitSchedulingAskIntent("tentative_time_window"), false, "tentative window is not an explicit ask");
assert.equal(isExplicitSchedulingAskIntent("none"), false, "no scheduling ask");
assert.equal(isExplicitSchedulingAskIntent(null), false, "null intent");
assert.equal(isExplicitSchedulingAskIntent(undefined), false, "undefined intent");
passed += 8;

console.log(`PASS scheduling-turn decision eval (${passed} rows)`);
