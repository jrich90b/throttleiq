/**
 * Confirm-booking decision eval (2026-06-25).
 *
 * `decideCustomerAckConfirmBooking` (routeStateReducer) is the PURE branching behind the auto-book-on-
 * confirm flow (resolveCustomerAckConfirmBooking, index.ts). It was extracted from index.ts so the
 * highest-risk EXTERNAL-WRITE branches are unit-testable WITHOUT booting the server or hitting Google
 * Calendar (the audit's P0.1 blind spot — the booking path was previously only source-guarded).
 *
 * The branches that must never regress:
 *   - a calendar write that FAILED must NOT yield a "you're all set" confirm  (book && slotFree && !bookSucceeded => fall_back)
 *   - a TAKEN slot offers alternatives, never a fabricated confirm
 *   - the regen draft path (book=false) never claims a booking (no calendar write)
 *   - a service-dept ask never books a sales visit
 *
 * Run: npx tsx scripts/confirm_booking_decision_eval.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { decideCustomerAckConfirmBooking } from "../services/api/src/domain/routeStateReducer.ts";

// A fully-"go" input (live, config present, concrete time, calendar checked, slot free, write OK).
const go = {
  serviceContext: false,
  hasConfig: true,
  hasExistingBooking: false,
  requestedResolved: true,
  availabilityChecked: true,
  slotFree: true,
  book: true,
  bookSucceeded: true,
  hasAlternatives: false
};
let n = 0;
const k = (over: Partial<typeof go>, expected: string, msg: string) => {
  const out = decideCustomerAckConfirmBooking({ ...go, ...over });
  assert.equal(out.kind, expected, `${msg} (got ${out.kind})`);
  n++;
};

// --- The external-write safety branches (the whole point of extracting this). ---
k({ book: true, slotFree: true, bookSucceeded: false }, "fall_back", "live write FAILED => fall_back, NO false confirm");
k({ book: true, slotFree: true, bookSucceeded: true }, "booked", "live write succeeded => booked");
k({ slotFree: false, hasAlternatives: true }, "offer_alternatives", "taken slot + alts => offer_alternatives");
k({ slotFree: false, hasAlternatives: false }, "offer_alternatives", "taken slot, no alts => offer_alternatives (no confirm)");
assert.equal(
  (decideCustomerAckConfirmBooking({ ...go, slotFree: false, hasAlternatives: true }) as any).hasAlternatives,
  true,
  "offer_alternatives carries hasAlternatives"
);
n++;
k({ book: false, slotFree: true }, "regen_lock_in", "regen (book:false) on a free slot => lock-in draft, no write");

// --- Early fall-throughs (caller returns null → lock-in ask). ---
k({ serviceContext: true }, "fall_back", "service-dept ask => fall_back (never books a sales visit)");
k({ hasConfig: false }, "fall_back", "no scheduler config => fall_back");
k({ requestedResolved: false }, "fall_back", "no concrete day+time => fall_back");
k({ availabilityChecked: false }, "fall_back", "availability lookup failed => fall_back");

// --- Already booked reflects the existing appointment. ---
k({ hasExistingBooking: true }, "already_booked", "existing confirmed appt => reflect it");

// --- RANGE-CONSTRAINT VETO (Kody +17163975098, 2026-07-16): an open-ended bound ("after 3")
// is never a bookable clock time — even a fully-"go" input must fall back, and no other flag
// may rescue it into a booked/lock-in confirm. (The caller's IO also skips the write.) ---
k({ rangeConstrained: true }, "fall_back", "bounded window => fall_back, never booked AT the bound");
k({ rangeConstrained: true, book: false }, "fall_back", "bounded window on regen => no lock-in draft either");
k({ rangeConstrained: true, hasAlternatives: true }, "fall_back", "alternatives don't rescue a bounded window into a confirm");
k({ rangeConstrained: true, hasExistingBooking: true }, "already_booked", "an existing booking still just gets reflected (no new write)");

// --- Precedence: service beats everything; existing-booking beats requested/availability. ---
k({ serviceContext: true, hasExistingBooking: true, slotFree: true }, "fall_back", "service context outranks an existing booking");
k({ hasExistingBooking: true, requestedResolved: false, availabilityChecked: false }, "already_booked", "existing booking outranks missing time/availability");
// A failed write must NOT be rescued into a confirm by any other flag.
k({ book: true, slotFree: true, bookSucceeded: false, hasAlternatives: true }, "fall_back", "failed write stays fall_back even if alternatives exist");

// --- Source guard: index.ts delegates to the pure decision (not an inline if-chain). ---
const api = fs.readFileSync("services/api/src/index.ts", "utf8");
assert.match(api, /const outcome = decideCustomerAckConfirmBooking\(\{/, "resolveCustomerAckConfirmBooking delegates to the pure decision");
assert.match(api, /case "fall_back":\s*\n\s*return null;/, "fall_back => caller returns null (lock-in ask)");
n += 2;

console.log(`PASS confirm-booking decision eval (${n} assertions)`);
