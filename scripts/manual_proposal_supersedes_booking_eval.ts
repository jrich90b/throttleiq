/**
 * manual_proposal_supersedes_booking:eval — a staff proposal landing on a DIFFERENT day than the
 * booked visit is a reschedule, and the reconciler must stop swallowing it.
 *
 * WHY THIS EXISTS (Joe, 2026-08-18, Jason Marshall +17165230421, CVO Road Glide ST):
 *   "The conversation should have picked up that he is going to come in tomorrow."
 *
 * A Tue 8/18 4:30 PM visit was booked on 8/12. That morning Jason wrote he was free "today and
 * tomorrow"; staff answered "if you have availability for tomorrow, let's shoot for then". Route
 * audit, 12:53:45Z: `manual_outbound_schedule_offer_only`, `state: proposed_time`, confidence 0.9 —
 * and then nothing. The appointment stayed `confirmed`, the calendar event stayed on Tuesday, and at
 * 21:45Z the outcome nag asked staff to grade a visit both sides had agreed that morning to move.
 *
 * THE PARSE WAS RIGHT. "let's shoot for" is `proposed_time` by the prompt's own named rule. The
 * reconciler simply returned at its offer-only guard, several statements before the reschedule
 * branch that already writes exactly the right task ("Manual reschedule requested. Customer shared
 * the day but not a time yet."). It never asked the question whose answer is not in the message:
 * is a visit already booked, on a different day?
 *
 * ⚠️ THE MEASUREMENT THAT SHAPED THIS, and the reason it is not built on the obvious resolver.
 * The natural wiring is "resolve the day out of the message text". Executed against the real
 * strings, `parseRequestedDayTime` (and `buildAppointmentTodoSchedule`, which wraps it) returns
 * **null** for every one of them — it needs a day AND a time, and "tomorrow" carries no time:
 *
 *     "…if you have availability for tomorrow, let's shoot for then."   -> null
 *     "I'll get a hold of you tomorrow morning and we will set it up"   -> null
 *     "Ok sounds good, see you Tuesday at 4:30"                         -> {2026-08-25 16:30}
 *
 * Built that way this fix would have SHIPPED INERT on the exact case it was written for. The day
 * therefore comes from the parser's own `requested.day` field through
 * `resolveUpcomingDateFromDayLabel`, which does resolve "tomorrow" — and whose own gaps
 * ("next tuesday", "tomorrow morning" -> null) land on the safe side, as case 4 pins.
 *
 * WHAT IS PINNED — the referee's behaviour, executed, plus the ORDER of the guards it feeds.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  dealerLocalDayKey,
  decideManualProposalSupersedesBooking
} from "../services/api/src/domain/routeStateReducer.js";
import { resolveUpcomingDateFromDayLabel } from "../services/api/src/domain/softVisitSignal.js";

const TZ = "America/New_York";
/** Jason's booked slot: Tue 2026-08-18, 4:30 PM local. */
const BOOKED = "2026-08-18T20:30:00.000Z";
/** The moment staff wrote "let's shoot for tomorrow". */
const AT_THE_MISS = new Date("2026-08-18T12:53:45.115Z");

let failures = 0;
function check(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`  FAIL  ${name}: ${(err as Error).message}`);
  }
}

// 1. The production case, end to end from the parser's own day label.
check("Jason's case: booked Tuesday, staff proposes 'tomorrow' => supersedes", () => {
  const proposed = resolveUpcomingDateFromDayLabel("tomorrow", AT_THE_MISS);
  assert.ok(proposed, "'tomorrow' must resolve — the whole fix depends on it");
  const decision = decideManualProposalSupersedesBooking({
    hasBookedEvent: true,
    bookedWhenIso: BOOKED,
    proposedWhenIso: proposed!.toISOString(),
    timeZone: TZ
  });
  assert.equal(decision.supersedes, true);
  assert.match(decision.why, /booked_2026-08-18_proposed_2026-08-19/);
});

// 2. The same-day case is a CONFIRMATION, not a move. Routing it to the reschedule branch would
//    re-open an appointment that is settled.
check("staff proposing the day already booked is not a move", () => {
  const proposed = resolveUpcomingDateFromDayLabel("today", AT_THE_MISS);
  assert.ok(proposed);
  const decision = decideManualProposalSupersedesBooking({
    hasBookedEvent: true,
    bookedWhenIso: BOOKED,
    proposedWhenIso: proposed!.toISOString(),
    timeZone: TZ
  });
  assert.equal(decision.supersedes, false);
  assert.match(decision.why, /^same_day:2026-08-18$/);
});

// 3. No booking to supersede — the arm must be inert on a lead with no appointment.
check("no booked event => never supersedes", () => {
  const decision = decideManualProposalSupersedesBooking({
    hasBookedEvent: false,
    bookedWhenIso: BOOKED,
    proposedWhenIso: "2026-08-19T16:00:00.000Z",
    timeZone: TZ
  });
  assert.equal(decision.supersedes, false);
  assert.equal(decision.why, "no_booked_event");
});

// 4. FAIL DIRECTION. Every unknown returns false and preserves today's exact behaviour. The first
//    two are the REAL gaps in resolveUpcomingDateFromDayLabel, measured — not invented shapes.
check("an unresolvable day label leaves behaviour exactly as it is", () => {
  for (const label of ["next tuesday", "tomorrow morning", ""]) {
    const proposed = resolveUpcomingDateFromDayLabel(label, AT_THE_MISS);
    assert.equal(proposed, null, `${label} is expected to be an unresolved gap`);
    const decision = decideManualProposalSupersedesBooking({
      hasBookedEvent: true,
      bookedWhenIso: BOOKED,
      proposedWhenIso: proposed ? (proposed as Date).toISOString() : null,
      timeZone: TZ
    });
    assert.equal(decision.supersedes, false);
    assert.equal(decision.why, "proposed_day_unresolved");
  }
});

// The `why` is a label; `supersedes` is what the reconciler branches on. Assert BOTH — a sabotage
// that flipped only the decision on an unparseable stamp slipped through a why-only version of this
// case, which is precisely the miss that matters (a garbled timestamp inventing a reschedule).
check("unparseable stamps never guess", () => {
  const bookedBad = decideManualProposalSupersedesBooking({
    hasBookedEvent: true,
    bookedWhenIso: "not-a-date",
    proposedWhenIso: "2026-08-19T16:00:00.000Z",
    timeZone: TZ
  });
  assert.equal(bookedBad.supersedes, false, "an unparseable booking must never read as a move");
  assert.equal(bookedBad.why, "booked_when_unparseable");

  const proposedBad = decideManualProposalSupersedesBooking({
    hasBookedEvent: true,
    bookedWhenIso: BOOKED,
    proposedWhenIso: "not-a-date",
    timeZone: TZ
  });
  assert.equal(proposedBad.supersedes, false, "an unparseable proposal must never read as a move");
  assert.equal(proposedBad.why, "proposed_day_unparseable");
});

// 5. The comparison is on the DEALER-LOCAL day, not UTC. Jason's 4:30 PM slot is 20:30Z — an
//    appointment late enough in the local evening lands on the NEXT UTC day, and comparing in UTC
//    would call a same-day confirmation a reschedule.
check("the day comparison is dealer-local, not UTC", () => {
  const lateLocal = "2026-08-19T03:00:00.000Z"; // Tue 8/18, 11:00 PM in New York
  assert.equal(dealerLocalDayKey(new Date(lateLocal), TZ), "2026-08-18");
  assert.equal(dealerLocalDayKey(new Date(lateLocal), "UTC"), "2026-08-19");
  const decision = decideManualProposalSupersedesBooking({
    hasBookedEvent: true,
    bookedWhenIso: BOOKED,
    proposedWhenIso: lateLocal,
    timeZone: TZ
  });
  assert.equal(decision.supersedes, false, "same local day must not read as a move");
});

// 6. THE WIRING, asserted on the source of the guard the miss actually fell through. The referee
//    being right is worth nothing if the offer-only guard still returns first — that is exactly the
//    shape of this bug, and a ratchet cannot prove wiring.
check("the offer-only guard yields to a reschedule cue, and the cue includes the supersede", () => {
  const src = readFileSync("services/api/src/index.ts", "utf8");
  const cue = src.match(/const explicitRescheduleCue =\n([\s\S]{0,220}?);/);
  assert.ok(cue, "explicitRescheduleCue must still be a single declaration");
  assert.ok(
    cue![1].includes("proposalSupersedesBooking"),
    "the supersede decision must feed explicitRescheduleCue"
  );
  assert.ok(
    src.includes(
      "if ((scheduleOfferOnly || tentativeScheduleOffer) && !explicitBookingStatement && !explicitRescheduleCue) {"
    ),
    "the offer-only guard must not return ahead of a reschedule cue"
  );
  const guardAt = src.indexOf("manual_outbound_schedule_offer_only");
  const rescheduleAt = src.indexOf("manual_outbound_reschedule_request_todo");
  assert.ok(guardAt > 0 && rescheduleAt > guardAt, "the reschedule branch still follows the guard");
});

if (failures) {
  console.error(`manual_proposal_supersedes_booking:eval FAILED (${failures} case(s))`);
  process.exit(1);
}
console.log("manual_proposal_supersedes_booking:eval OK (7 case(s))");
