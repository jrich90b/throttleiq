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
  readRidingAcademyRecordFields
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
assert.equal(
  decideRidingAcademyTurn({ leadSource: "Riding Academy - Completed", inquiry: "Enrollment Status: Completed" }).kind,
  "none",
  "completions still route normally — this change must not swallow them"
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

console.log("PASS riding academy waitlist ack eval — field labels are not a request, wait list is its own state, invite offered not attributed");
console.log(`   reply: ${reply}`);
