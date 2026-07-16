/**
 * Auto-book-on-confirm eval (2026-06-25).
 *
 * When a customer confirms a CONCRETE time the agent didn't pre-offer ("Ya 10 will work",
 * "Around 1pm", "Is 10:45 good?"), the agent must check the calendar and ACTUALLY book it
 * (live) — or offer the nearest alternatives if it's taken — instead of deflecting with
 * "I'll check that time and follow up." (Nicholas Braun / s R Gurajala class: a concrete
 * time discussed, nothing ever scheduled.)
 *
 * The booking itself writes to Google Calendar, so it can't run in CI; this pins (1) the
 * centralized route decision (decideSchedulingTurn `confirm_appointment`, also covered by
 * scheduling_turn_decision_eval) and (2) the live/regen wiring + booking semantics via
 * source guards, the same way the calendar-/IO-heavy reconcile evals do.
 *
 * Run: npx tsx scripts/scheduling_auto_book_on_confirm_eval.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { decideSchedulingTurn } from "../services/api/src/domain/routeStateReducer.ts";

// --- 1) Route decision: a cleared-to-book confirm routes to the auto-book arm; vague does not. ---
const base = {
  customerAckActionAccepted: true,
  customerAckAction: "confirm_proposed_appointment",
  appointmentTimingAccepted: false,
  appointmentTimingIntent: null as string | null,
  parserScheduleStatusUpdate: false,
  pricingOrPaymentsIntent: false,
  scheduleDialogState: true,
  scheduleOfferContext: true
};
assert.equal(decideSchedulingTurn({ ...base, customerAckShouldBook: true }).kind, "confirm_appointment", "shouldBook confirm => auto-book arm");
assert.equal(decideSchedulingTurn({ ...base, customerAckShouldBook: false }).kind, "none", "confirm without shouldBook never auto-books");
assert.equal(
  decideSchedulingTurn({ ...base, customerAckShouldBook: true, pricingOrPaymentsIntent: true }).kind,
  "none",
  "pricing/payments suppresses the auto-book arm"
);

// --- 2) Helper semantics: book on a free slot, alternatives if taken, NEVER a false confirm. ---
const api = fs.readFileSync("services/api/src/index.ts", "utf8");

// bookConfirmedAppointmentSlot creates the event + persists a CUSTOMER-confirmed appointment so the
// staff "New appointment booked" SMS sweep fires on bookedEventId.
assert.match(api, /async function bookConfirmedAppointmentSlot\(/, "the shared booking helper exists");
assert.match(api, /const created = await insertEvent\(/, "it inserts a real calendar event");
assert.match(api, /conv\.appointment\.bookedEventId = eventIdToPersist;/, "it persists bookedEventId");
assert.match(api, /conv\.appointment\.confirmedBy = "customer";/, "the appointment is customer-confirmed");
assert.match(api, /onAppointmentBooked\(conv\);\n  return \{ booked: true/, "it finalizes via onAppointmentBooked");
assert.match(api, /return \{ booked: false, whenText: "", repName: null \};/, "a failed calendar write => booked:false (no fabricated confirm)");

// resolveCustomerAckConfirmBooking: does the IO (service check, config, day/time, availability, write)
// then delegates the BRANCHING to the pure decideCustomerAckConfirmBooking (behaviorally pinned by
// confirm_booking_decision_eval). The composed replies live here.
assert.match(api, /async function resolveCustomerAckConfirmBooking\(/, "the confirm-booking resolver exists");
assert.match(api, /const serviceContext = isServiceDepartmentSchedulingRequest\(conv, args\.rawText\);/, "a service-dept ask is detected (the decision defers it)");
assert.match(api, /findRequestedAppointmentSlotAvailability\(\{ conv, requested, appointmentType \}\)/, "it checks calendar availability");
assert.match(api, /const outcome = decideCustomerAckConfirmBooking\(\{/, "branching is delegated to the pure decision");
// Only writes the calendar on a live, free-slot turn (never on regen / taken / no-time).
assert.match(api, /availability\?\.available && availability\.exactSlot && args\.book\) \{[\s\S]*?bookConfirmedAppointmentSlot\(\{/, "books ONLY when slot is free AND book:true (live)");
assert.match(api, /you’re all set for \$\{bookResult!\.whenText\}/, "a booked slot => 'you're all set for <time>' confirm");
assert.match(api, /buildRequestedSlotUnavailableReply\(availability!\.requestedLabel, availability!\.alternatives\)/, "a taken slot => offer alternatives");
assert.match(api, /I’ll get you locked in and confirm\./, "regen (book:false) free slot => honest lock-in draft, no calendar write");

// --- 3) Both paths route through the resolver (live books, regen draft-only) — in sync. ---
// Live: gate includes confirm_appointment and calls the resolver with book:true.
assert.match(api, /sched\.kind === "confirm_appointment" \|\|/, "live gate includes the confirm-appointment kind");
assert.match(
  api,
  /if \(sched\.kind === "confirm_appointment"\) \{[\s\S]*?resolveCustomerAckConfirmBooking\(\{[\s\S]*?book: true,/,
  "live handler books for real (book:true)"
);
assert.match(api, /customer_ack_confirm_\$\{result\.booked \? "auto_booked"/, "live records the booked/alts/unavailable outcome");
// Regen: the confirm handler calls the resolver with book:false (no calendar write on a draft).
assert.match(
  api,
  /confirm_proposed_appointment" && regenCustomerAckActionParse\?\.shouldBook\) \{[\s\S]*?resolveCustomerAckConfirmBooking\(\{[\s\S]*?book: false,/,
  "regen handler is availability-check only (book:false)"
);
// The centralized decision is fed shouldBook in the live path.
assert.match(api, /customerAckShouldBook: customerAckActionParse\?\.shouldBook \?\? false,/, "live feeds shouldBook into the route decision");

// --- 4) propose_booking: a customer-PROPOSED concrete day+time (no prior offer) books too. ---
// Mark Ezell +17169904133 ("Tomorrow at 930am?"): the appointment-timing provide_new_time proposal
// had no booking arm, so it fell through to the orchestrator and improvised (9:30/9:40/today).
// It now routes to the SAME resolver as a confirm — book:true live, book:false regen — sourcing the
// day/time from the appointment-timing parse. Both paths + the concrete-day+time gate are pinned.
assert.equal(
  decideSchedulingTurn({ ...base, customerAckActionAccepted: false, customerAckAction: null, appointmentTimingAccepted: true, appointmentTimingIntent: "provide_new_time", appointmentTimingHasConcreteDayTime: true }).kind,
  "propose_booking",
  "a concrete provide_new_time proposal routes to the book-or-offer arm"
);
assert.equal(
  decideSchedulingTurn({ ...base, customerAckActionAccepted: false, customerAckAction: null, appointmentTimingAccepted: true, appointmentTimingIntent: "provide_new_time", appointmentTimingHasConcreteDayTime: false }).kind,
  "none",
  "a day-ONLY provide_new_time keeps its slot-offer path (#203), not propose_booking"
);
// Live: gate includes propose_booking and calls the resolver with book:true + the timing day/time override.
assert.match(api, /sched\.kind === "propose_booking"\) \{[\s\S]*?resolveCustomerAckConfirmBooking\(\{[\s\S]*?book: true,[\s\S]*?requestedOverride: \{/, "live propose_booking books for real (book:true) from the appointment-timing day/time");
assert.match(api, /appointment_timing_propose_\$\{result\.booked \? "auto_booked"/, "live records the propose booked/alts/unavailable outcome");
// Regen: propose_booking is availability-check only (book:false) — live/regen parity.
assert.match(api, /regenSched\.kind === "propose_booking"\) \{[\s\S]*?resolveCustomerAckConfirmBooking\(\{[\s\S]*?book: false,[\s\S]*?requestedOverride: \{/, "regen propose_booking is availability-check only (book:false)");
// The concrete-day+time signal is fed into the route decision in BOTH paths.
assert.match(api, /appointmentTimingHasConcreteDayTime:\n\s*!!appointmentTimingParse\?\.requested\?\.day && !!appointmentTimingParse\?\.requested\?\.timeText,/, "live feeds the concrete day+time gate");
assert.match(api, /appointmentTimingHasConcreteDayTime:\n\s*!!regenAppointmentTimingParse\?\.requested\?\.day && !!regenAppointmentTimingParse\?\.requested\?\.timeText,/, "regen feeds the concrete day+time gate");

console.log("PASS auto-book-on-confirm eval (route decision + booking semantics + live/regen wiring)");
