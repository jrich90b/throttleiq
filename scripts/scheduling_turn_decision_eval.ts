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
import { decideSchedulingTurn } from "../services/api/src/domain/routeStateReducer.ts";

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

  // --- A precedence over B ---
  { id: "ack_beats_appt_timing", input: { ...base, customerAckActionAccepted: true, customerAckAction: "accept_tentative_appointment", appointmentTimingAccepted: true, appointmentTimingIntent: "decline_time" }, kind: "accept_tentative" },

  // --- non-cluster ack action falls through to B ---
  { id: "noncluster_ack_falls_to_timing", input: { ...base, customerAckActionAccepted: true, customerAckAction: "confirm_proposed_appointment", appointmentTimingAccepted: true, appointmentTimingIntent: "tentative_time_window" }, kind: "tentative_window" },

  // --- Block B: appointment-timing intents ---
  { id: "timing_arrival_update", input: { ...base, appointmentTimingAccepted: true, appointmentTimingIntent: "arrival_update" }, kind: "arrival_update" },
  { id: "timing_tentative", input: { ...base, appointmentTimingAccepted: true, appointmentTimingIntent: "tentative_time_window" }, kind: "tentative_window" },
  { id: "timing_decline", input: { ...base, appointmentTimingAccepted: true, appointmentTimingIntent: "decline_time" }, kind: "decline_time" },

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

console.log(`PASS scheduling-turn decision eval (${passed} rows)`);
