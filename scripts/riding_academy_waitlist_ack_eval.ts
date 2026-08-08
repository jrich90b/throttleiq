/**
 * Riding Academy WAIT LIST ack eval (pure, no LLM).
 *
 * THE LEAD (igor yuzbashev, +17164442120, 2026-08-06). Record:
 *   Enrollment Status: Wait List-Course: New Rider Course - eCourse + Range-Class Start Date:
 *   8/15/2026-Gender: Male-Motivation: Learn to ride-Motorcycle Riding History: I have ridden only
 *   as a passenger-Training Experience: No-...
 *
 * The agent drafted: "Thanks — I saw you want to do the Jumpstart experience before the course."
 *
 * He never said that. Two FIELD LABELS — "Motivation: Learn to ride" and "Training Experience: No" —
 * satisfied a keyword rule written for customer prose, so the form's schema became his request. And
 * the wait-list status was ignored entirely: the reply spoke as though the seat was his.
 *
 * Joe's ruling, 2026-08-06: fix the claim, KEEP the invite. His record does read beginner (ridden
 * only as a passenger, no training), so the Jumpstart is right — as OUR offer, never as his ask.
 *
 * Run: npx tsx scripts/riding_academy_waitlist_ack_eval.ts
 */
import assert from "node:assert/strict";
import { decideRidingAcademyTurn } from "../services/api/src/domain/routeStateReducer.ts";
import {
  isJumpStartExperienceRequestText,
  readRidingAcademyRecordFields,
  resolveRidingAcademyAdfLaneClaim,
  buildAdfFirstTouchAck,
  resolveEnrollmentAckExtras
} from "../services/api/src/domain/ridingAcademy.ts";
import { buildRidingAcademyWaitlistAck, buildJumpstartRegistrationInvite } from "../services/api/src/domain/agentVoice.ts";

const IGOR =
  "Enrollment Status: Wait List-Course: New Rider Course - eCourse + Range-Class Start Date: 8/15/2026-" +
  "Gender: Male-Motivation: Learn to ride-Motorcycle Riding History: I have ridden only as a passenger-" +
  "Training Experience: No-Future Motorcycle Purchase Expectation: Yes in less than 3 months-" +
  "Future Motorcycle Purchase Brand: Harley-Davidson-Accepted Terms and Conditions: true";

// --- 1) A form's field labels are not a customer request. ---
assert.equal(
  isJumpStartExperienceRequestText(IGOR),
  false,
  "THE BUG: 'Motivation: Learn to ride' + 'Training Experience: No' are LABELS — they must not read as a Jumpstart request"
);
assert.equal(
  isJumpStartExperienceRequestText("Riding Academy - Wait List"),
  false,
  "the lead source alone is not a request either"
);
// The explicit ask must still be honoured — including inside a record, where a customer note can land.
assert.equal(
  isJumpStartExperienceRequestText("Enrollment Status: Wait List-Notes: can I try the jumpstart first?"),
  true,
  "an explicit Jumpstart mention still counts, record or not"
);
assert.equal(
  isJumpStartExperienceRequestText("I'd like to get some practice in at the riding academy before my class"),
  true,
  "genuine customer prose must still route to the Jumpstart lane"
);

// --- 2) Wait List is its own state, not a near-enrollment and not nothing. ---
assert.equal(
  decideRidingAcademyTurn({ leadSource: "Riding Academy - Wait List", inquiry: IGOR }).kind,
  "riding_academy_waitlist_ack",
  "a wait-list registration must get its own ack instead of falling through to the generic ADF path"
);
assert.equal(
  decideRidingAcademyTurn({ leadSource: "Riding Academy - Enrolled", inquiry: "Enrollment Status: Enrolled-Course: New Rider Course" }).kind,
  "riding_academy_enrollment_ack",
  "enrolled behaviour is unchanged"
);
// SUPERSEDED 2026-08-07 by Joe's ruling, and the reason is worth keeping. This used to assert a
// completion returns "none", so the 2026-08-06 wait-list change could not swallow it — correct then,
// because no completion copy existed and none had ever arrived. Joe has since chosen that copy
// (congratulate, and stop) and, more importantly, "none" turned out NOT to be neutral: it hands the
// turn to generic SALES routing, which is how Maya Iversen's status change was answered with a
// payments question. Full lane pinned by scripts/riding_academy_status_lane_eval.ts.
assert.equal(
  decideRidingAcademyTurn({ leadSource: "Riding Academy - Completed", inquiry: "Enrollment Status: Completed" }).kind,
  "riding_academy_completion_ack",
  "a completion gets its own congratulation — never a sales opener"
);
assert.equal(
  decideRidingAcademyTurn({ leadSource: "HDMC New Vehicle - Inventory", inquiry: "looking at a Street Bob" }).kind,
  "none",
  "and an ordinary sales lead is still untouched — this must not swallow the rest of the funnel"
);

// --- 3) The record's own fields, never invented. ---
const fields = readRidingAcademyRecordFields(IGOR);
assert.equal(fields.course, "New Rider Course - eCourse + Range", "course must survive the hyphens inside its own value");
assert.equal(fields.startDate, "8/15/2026");
assert.deepEqual(
  readRidingAcademyRecordFields("Enrollment Status: Wait List"),
  { course: null, startDate: null },
  "a bare record yields nulls — the reply then says 'the Riding Academy' rather than inventing a class"
);

// --- 4) The reply: honest about the seat, and the Jumpstart offered, not attributed. ---
const reply = buildRidingAcademyWaitlistAck("igor", "Alexandra", "American Harley-Davidson", {
  course: fields.course,
  startDate: fields.startDate,
  jumpstartInvite: buildJumpstartRegistrationInvite()
});
assert.ok(/wait list/i.test(reply), `must say he is on the wait list: ${reply}`);
assert.ok(reply.includes("8/15/2026") && reply.includes("New Rider Course"), `must name the class off the record: ${reply}`);
assert.ok(/jumpstart/i.test(reply), "Joe's ruling: KEEP the invite");
// Joe, 2026-08-06: "you can say we will follow up." Commit to following up — do NOT promise to
// watch the list and catch the moment a seat frees, which is a trigger nobody owns.
assert.ok(/follow up/i.test(reply), `must commit to following up: ${reply}`);
assert.ok(
  !/as soon as a seat opens|the moment a seat|when a seat frees/i.test(reply),
  `must not promise to watch the wait list for a seat opening: ${reply}`
);
assert.ok(
  !/i saw you want|you wanted|you asked/i.test(reply),
  `must not attribute a request he never made: ${reply}`
);
assert.ok(/want me to|would you like|can i set/i.test(reply), `the Jumpstart must read as an OFFER: ${reply}`);
assert.ok(
  !/you're all set|you're enrolled|see you in class|your seat/i.test(reply),
  `must not imply he has a seat: ${reply}`
);

// Without the Jumpstart (dealer has none, or the rider does not read beginner) it is still honest.
const plain = buildRidingAcademyWaitlistAck("igor", "Alexandra", "American Harley-Davidson", {
  course: fields.course,
  startDate: fields.startDate
});
assert.ok(/wait list/i.test(plain) && !/jumpstart/i.test(plain), `no Jumpstart configured ⇒ no Jumpstart sentence: ${plain}`);

// ---------------------------------------------------------------------------
// AND IT HAS TO REACH A CUSTOMER (Joe, 2026-08-08: "build it").
//
// All of the above was true and none of it shipped. On LIVE intake the wait-list ack was not in the
// set of kinds allowed to compose the reply, so a rider-course branch answered first and returned:
// Maya Iversen (+15854782032, 8/06) and Andrei Kavalchuk (+15853170121, 8/07) both went on the wait
// list and were told the course costs $321 — Andrei's actually SENT. The regen path had been
// building this ack correctly the whole time.
// ---------------------------------------------------------------------------
// The same wait-list record, plus the payment field the live extras key off.
const UNPAID_WAITLIST_RECORD = `${IGOR}-Payment Status: Failed`;
const seatExtras = resolveEnrollmentAckExtras(
  { policies: { firstTimeRider: { unpaidSeatPaymentMethods: "at the dealership or over the phone" } } },
  UNPAID_WAITLIST_RECORD
);
assert.ok(
  seatExtras.unpaidSeatLine.includes("paid yet"),
  "the fixture must actually PRODUCE a settlement line, or the assertions below prove nothing"
);

const waitlistRow = (id: string) => ({
  direction: "in",
  provider: "sendgrid_adf",
  providerMessageId: id,
  body: `WEB LEAD (ADF)\nSource: Riding Academy - Wait List\n\nInquiry:\n${IGOR}`
});
const waitlistClaim = (over: Record<string, unknown> = {}) =>
  resolveRidingAcademyAdfLaneClaim({
    provider: "sendgrid_adf",
    messages: [waitlistRow("adf_1")],
    excludeProviderMessageId: "adf_1",
    eventPromoKind: null,
    leadSource: "Riding Academy - Wait List",
    inquiry: IGOR,
    ...over
  });

assert.equal(
  waitlistClaim().liveReplyKind,
  "riding_academy_waitlist_ack",
  "a wait-list record OWNS the live reply — otherwise the course-price branch answers it first"
);

// The whole reply, composed the way live intake composes it — including the extras it passes.
const liveWaitlistReply = buildAdfFirstTouchAck(waitlistClaim().liveReplyKind!, {
  firstName: "Igor",
  agentName: "Alexandra",
  dealerName: "Dealer Motorcycles",
  course: fields.course,
  startDate: fields.startDate,
  introduce: true,
  // UNPAID on purpose. igor's real record carries no Payment Status at all, so extras.unpaidSeatLine
  // would be "" and every "no payment talk" assertion below would pass with nothing to leak — the
  // vacuous-fixture trap. This variant forces the line to EXIST so dropping it is what gets tested.
  ...resolveEnrollmentAckExtras(
    {
      policies: {
        firstTimeRider: {
          riderCourseName: "Riding Academy course",
          riderCoursePrice: "$321",
          unpaidSeatPaymentMethods: "at the dealership or over the phone",
          registrationNote: "Our Riding Academy Manager will send your e-course link."
        }
      }
    },
    UNPAID_WAITLIST_RECORD
  )
});
assert.ok(!liveWaitlistReply.includes("$321"), "a wait-listed rider is never quoted the sign-up price");
assert.ok(/wait list/i.test(liveWaitlistReply), "they are told plainly that they are on the wait list");
// The extras are for a seat. He has not got one, so neither may reach him — the live path passes
// them all in regardless, so this is the assertion that keeps that safe.
assert.ok(
  !/paid yet|take care of that/i.test(liveWaitlistReply),
  "no seat means no payment talk — he is not being asked to settle something he does not have"
);
assert.ok(
  !/e-course link/i.test(liveWaitlistReply),
  "and no registration note either, which is written for somebody who is IN the class"
);

// The two kinds that must NOT have changed with it.
assert.equal(
  waitlistClaim({ inquiry: IGOR.replace("Wait List", "Cancelled"), leadSource: "Riding Academy - Cancelled" })
    .liveReplyKind,
  null,
  "an unrecognised status still composes nothing — it raises a task and leaves the reply alone"
);
assert.equal(
  waitlistClaim({ messages: [waitlistRow("adf_1"), { direction: "in", provider: "twilio", body: "hi" }] })
    .liveReplyKind,
  null,
  "and once the customer has texted back, normal routing answers"
);

console.log("PASS riding academy waitlist ack eval — field labels are not a request, wait list is its own state, invite offered not attributed");
console.log(`   reply: ${reply}`);
