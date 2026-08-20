/**
 * Riding Academy ENROLLMENT acknowledgement eval (pure, no LLM).
 *
 * Pins Joe's 2026-08-05 ruling. The rider-training school files an ADF when someone REGISTERS for
 * a course — `Source: Riding Academy - Enrolled` plus a machine enrollment record ("Enrollment
 * Status: Enrolled-Course: …-Class Start Date: …-Payment Status: …"). The first two ever
 * (Savannah Niver +13155211619 and Donald Rawson +17165344986, both 2026-08-04) each got the
 * generic ADF opener: "Thanks for asking about our Riding Academy course. Course details and
 * pricing are here: <link>" — quoting the price to two people who had already bought a seat — and
 * Donald, whose record says he expects to buy nothing, was lined up for the standard day-1 sales
 * ramp behind it.
 *
 * JOE'S SPEC, and the entire content of the reply: an introduction, a thank-you, and that the
 * agent is here to help with anything about the course. No selling, and NO payment reference —
 * `Payment Status` is on the record ("Failed" / "Awaiting Payment at Dealer") and whether an
 * unpaid seat is ever raised over SMS is Joe's decision, not the agent's.
 *
 * Structured routing off fixed ADF enum fields (lead source + the record's own status), NOT
 * free-text comprehension — there is no customer prose on this lead at all. Same family as
 * decideNonBuyerSurveyTurn / decideEventPromoTurn.
 *
 * Layers:
 *   1. Decision table — the two REAL bodies divert; a completion/cancellation/waitlist and every
 *      ordinary sales lead do not.
 *   2. Cadence/reply parity — the same lead that fires the ack is capped to the gentle long_term
 *      nurture by resolveInitialAdfCadencePlan, so the opener and the follow-ups agree.
 *   3. Ack safety — identifies agent + dealer and carries NO price/payment reference, bike pitch,
 *      availability claim, "which model?" ask, stop-in push, class-date claim, or "new rider"
 *      assumption (this lane carries skills-refresher students too).
 *   4. Source guard — wired at the initial-ADF draft in BOTH paths, gated to the first touch,
 *      pinned to the exact call shape (not a loose substring).
 *
 * Run: npx tsx scripts/riding_academy_enrollment_ack_eval.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";

import { decideRidingAcademyTurn } from "../services/api/src/domain/routeStateReducer.ts";
import { buildRidingAcademyEnrollmentAck } from "../services/api/src/domain/agentVoice.ts";
import { resolveAdfAckFirstName } from "../services/api/src/domain/agentVoice.ts";
import {
  resolveEnrollmentJumpstartInvite,
  resolveEnrollmentAckExtras,
  resolveRidingAcademyAdfLaneClaim,
  buildAdfFirstTouchAck,
  readRidingAcademyRecordFields
} from "../services/api/src/domain/ridingAcademy.ts";
import { resolveInitialAdfCadencePlan } from "../services/api/src/domain/conversationStore.ts";

// The two real enrollment bodies, byte-for-byte from the americanharley store (2026-08-04).
const SAVANNAH_INQUIRY =
  "Enrollment Status: Enrolled-Course: New Rider Course - eCourse + Range-Class Start Date: 8/15/2026-Gender: Female-Motivation: Obtain a license-Motorcycle Riding History: I have operated an on-road motorcycle within the last 12 months-Training Experience: No-Payment Status: Failed-Future Motorcycle Purchase Expectation: Yes in 1-3 years-Future Motorcycle Purchase Brand: Honda-Accepted Terms and Conditions: true-Brand of Bike Owned:Honda";
const DONALD_INQUIRY =
  "Enrollment Status: Enrolled-Course: New Rider Course - eCourse + Range-Class Start Date: 8/15/2026-Gender: Male-Motivation: Skills refresher-Motorcycle Riding History: I have operated an on-road motorcycle within the last 12 months-Training Experience: Yes, State Operated Course-Payment Status: Awaiting Payment at Dealer-Future Motorcycle Purchase Expectation: No-Future Motorcycle Purchase Brand: None-Accepted Terms and Conditions: true-Brand of Bike Owned:Aprilia";

// --- 1) Decision table (pure). ---
type Row = { id: string; source: string | null; inquiry: string | null; ack: boolean };
const rows: Row[] = [
  // The bug, both real leads.
  { id: "savannah_enrolled", source: "Riding Academy - Enrolled", inquiry: SAVANNAH_INQUIRY, ack: true },
  { id: "donald_enrolled", source: "Riding Academy - Enrolled", inquiry: DONALD_INQUIRY, ack: true },
  // The record alone is enough, even if the source line is missing or renamed.
  { id: "record_without_source", source: null, inquiry: SAVANNAH_INQUIRY, ack: true },
  { id: "source_alone_enrolled", source: "Riding Academy - Enrolled", inquiry: null, ack: true },
  { id: "case_insensitive", source: "RIDING ACADEMY - ENROLLED", inquiry: null, ack: true },
  // Every OTHER status in this lane routes normally — completion copy is still Joe's to write,
  // and no completion ADF has ever arrived, so we never guess a fingerprint we have not seen.
  {
    id: "completed_does_not_divert",
    source: "Riding Academy - Completed",
    inquiry: "Enrollment Status: Completed-Course: New Rider Course - eCourse + Range",
    ack: false
  },
  {
    id: "cancelled_does_not_divert",
    source: "Riding Academy - Cancelled",
    inquiry: "Enrollment Status: Cancelled-Course: New Rider Course",
    ack: false
  },
  { id: "waitlisted_does_not_divert", source: "Riding Academy - Waitlisted", inquiry: null, ack: false },
  { id: "riding_academy_no_status", source: "Riding Academy", inquiry: null, ack: false },
  // Ordinary sales leads are untouched.
  { id: "room58_test_ride", source: "Room58 - Book test ride", inquiry: "Interested in a Street Glide", ack: false },
  {
    id: "prose_merely_mentioning_the_academy",
    source: "Room58 - Request details",
    inquiry: "Do you still run the riding academy classes? Also what does a Road King cost?",
    ack: false
  },
  { id: "empty", source: null, inquiry: null, ack: false },
  { id: "blank", source: "", inquiry: "", ack: false }
];
for (const r of rows) {
  const kind = decideRidingAcademyTurn({ leadSource: r.source, inquiry: r.inquiry }).kind;
  assert.equal(
    kind === "riding_academy_enrollment_ack",
    r.ack,
    `decideRidingAcademyTurn[${r.id}] expected ack=${r.ack}, got kind=${kind}`
  );
}

// --- 2) Cadence/reply parity. An enrollment must never land on the aggressive day-1 sales ramp:
//        Donald's timeframe field is the bare string "No", which matches none of the timeframe
//        branches, so before this change he resolved to "standard" — the full press, right behind
//        an opener promising help with his COURSE. ---
for (const tf of [null, "No", "Yes in 1-3 years", "0-3 months", "Ready to buy now", ""]) {
  assert.equal(
    resolveInitialAdfCadencePlan({
      purchaseTimeframe: tf,
      purchaseTimeframeMonthsStart: 1,
      leadSource: "Riding Academy - Enrolled"
    }),
    "long_term",
    `an enrollment lead must be capped to the gentle nurture regardless of its timeframe field (${tf})`
  );
}
// An explicit non-buyer still wins with the QUIETER answer (suppress beats long_term).
assert.equal(
  resolveInitialAdfCadencePlan({
    purchaseTimeframe: "I am not interested in purchasing at this time",
    leadSource: "Riding Academy - Enrolled"
  }),
  "suppress",
  "suppress must still win over the riding-academy cap — fail toward FEWER touches"
);
// Non-academy leads keep today's plan exactly (this must not move anyone else).
assert.equal(
  resolveInitialAdfCadencePlan({ purchaseTimeframe: "0-3 months", purchaseTimeframeMonthsStart: 1 }),
  "standard",
  "an ordinary near-term buyer must still get the standard ramp"
);
assert.equal(
  resolveInitialAdfCadencePlan({ purchaseTimeframe: "1-2 years" }),
  "long_term",
  "an ordinary multi-year lead must still get the long_term nurture"
);

// --- 3) Ack safety (pure). ---
const ack = buildRidingAcademyEnrollmentAck("Savannah", "Alexandra", "American Harley-Davidson");
assert.ok(
  /Savannah/.test(ack) && /Alexandra/.test(ack) && /American Harley-Davidson/.test(ack),
  "ack must identify lead + agent + dealer"
);
assert.ok(/course/i.test(ack), "ack must say it is about the course — that is the whole point of it");
const BANNED: { label: string; re: RegExp }[] = [
  // The bug: quoting price/payment to someone who already paid for a seat. Money stays with Joe.
  { label: "price or payment reference", re: /\bpric(e|ing)|cost|payment|\$|tuition|deposit|owe|unpaid|balance\b/i },
  { label: "bike pitch / which-model ask", re: /\bwhich (bike|model)|what bike|in stock|still available|test ride|trade-in\b/i },
  { label: "stop-in / appointment push", re: /\bstop in|come in|swing by|what day|what time|set up a time|schedule\b/i },
  // We assert nothing we would have to be right about.
  { label: "class date or logistics claim", re: /\b(class starts|starts on|\d{1,2}\/\d{1,2}\/\d{2,4}|bring your|be sure to bring)\b/i },
  // The lane carries skills-refresher students, not just first-timers (Donald).
  { label: "new-rider assumption", re: /\bfirst bike|new rider|never ridden|first step|learning to ride\b/i }
];
for (const b of BANNED) {
  assert.ok(!b.re.test(ack), `enrollment ack must not contain a ${b.label}: "${ack}"`);
}
const ackNoName = buildRidingAcademyEnrollmentAck(null, "Alexandra", "American Harley-Davidson");
assert.ok(!/undefined|null/.test(ackNoName), "ack must handle a missing first name cleanly");
// The JUMPSTART variant (Joe, 2026-08-05, second ruling): a store with a Jumpstart offers it right
// here in the registration reply. Same guarantees as the plain intro — nothing about price or
// payment, no bike pitch — plus: the plain reply must be untouched when the store has none.
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "eval-no-live-key";
const { exceedsSmsBrevityBudget } = await import("../services/api/src/domain/llmDraft.ts");
const jumpstartOffer = resolveEnrollmentJumpstartInvite(
  { policies: { firstTimeRider: { jumpstartEnabled: true } } },
  SAVANNAH_INQUIRY
);
assert.ok(jumpstartOffer, "the fixture dealer has a Jumpstart, so the offer must resolve");
const ackWithJumpstart = buildRidingAcademyEnrollmentAck(
  "Savannah",
  "Alexandra",
  "American Harley-Davidson",
  jumpstartOffer
);
assert.ok(/Jumpstart/.test(ackWithJumpstart), "a Jumpstart dealer's registration reply must offer it");
assert.ok(
  /one-on-one|1-on-1/i.test(ackWithJumpstart),
  "the registration reply must offer 1-on-1 time, which is the whole point of the offer"
);
for (const b of BANNED) {
  assert.ok(!b.re.test(ackWithJumpstart), `the Jumpstart registration reply must not contain a ${b.label}`);
}
assert.equal(
  exceedsSmsBrevityBudget(ackWithJumpstart),
  false,
  `the registration reply carrying the offer must stay inside the SMS brevity budget: "${ackWithJumpstart}"`
);
assert.ok(
  (ackWithJumpstart.match(/\?/g) ?? []).length <= 1,
  "the registration reply must not ask two questions at once"
);
// The offer REPLACES the generic tail rather than being appended. Pinned on the PROPERTY (no
// vague "text me" standing next to a concrete offer), not on one exact sentence — a sabotage that
// merely reworded the tail slipped past the literal version on 2026-08-05.
assert.ok(
  !/\btext me\b/i.test(ackWithJumpstart),
  `the offer must replace the generic "text me" tail, not stand beside it: "${ackWithJumpstart}"`
);
assert.ok(
  ackWithJumpstart.length < ack.length + jumpstartOffer.length,
  "the Jumpstart registration reply must be shorter than the plain reply plus the offer"
);
// A dealer with no Jumpstart keeps the reply Joe approved, byte for byte.
assert.equal(
  buildRidingAcademyEnrollmentAck("Savannah", "Alexandra", "American Harley-Davidson", ""),
  ack,
  "no Jumpstart at this store ⇒ the registration reply is unchanged, byte for byte"
);
assert.ok(!/Jumpstart/.test(ack), "the plain registration reply must not mention a Jumpstart");

// --- The DEALER-CONFIGURED registration extras (Joe, 2026-08-05) --------------------------------
// Three rulings land in this one message: the dealer's own e-course note ("maybe each dealer can
// type their template message in their profile"), the unpaid-seat line ("can be paid at the dealer
// or over the phone if the payment fails"), and the Jumpstart offer. All four together measure 501
// chars / 5 sentences against the REAL budget helper, so the ack carries the note plus EXACTLY ONE
// of unpaid/Jumpstart — unpaid wins, because a class date is a deadline and an invite is not.
const AH_PROFILE = {
  policies: {
    firstTimeRider: {
      jumpstartEnabled: true,
      registrationNote:
        "Our riding academy manager will send you your e-course link that just needs to be completed prior to your course.",
      unpaidSeatPaymentMethods: "at the dealership or over the phone"
    }
  }
};
const PAID_INQUIRY = SAVANNAH_INQUIRY.replace("Payment Status: Failed", "Payment Status: Paid");
const compose = (profile: any, inquiry: string) =>
  buildRidingAcademyEnrollmentAck("Savannah", "Alexandra", "American Harley-Davidson", resolveEnrollmentAckExtras(profile, inquiry));

const unpaidMsg = compose(AH_PROFILE, SAVANNAH_INQUIRY);
const paidMsg = compose(AH_PROFILE, PAID_INQUIRY);
const bareMsg = compose({ policies: { firstTimeRider: {} } }, SAVANNAH_INQUIRY);

// The dealer's note is inserted VERBATIM, in both the unpaid and paid shapes.
for (const [label, msg] of [["unpaid", unpaidMsg], ["paid", paidMsg]] as const) {
  assert.ok(
    msg.includes(AH_PROFILE.policies.firstTimeRider.registrationNote),
    `[${label}] the dealer's registration note must appear word for word`
  );
  assert.equal(exceedsSmsBrevityBudget(msg), false, `[${label}] must stay inside the SMS brevity budget: "${msg}"`);
  assert.ok((msg.match(/\?/g) ?? []).length <= 1, `[${label}] one question per text`);
}
// PRECEDENCE: unpaid wins; the Jumpstart never rides alongside it.
assert.ok(/isn't showing as paid yet/.test(unpaidMsg), "an unpaid seat must be flagged");
assert.ok(
  unpaidMsg.includes("at the dealership or over the phone"),
  "the unpaid line must use the DEALER'S words for how to settle it"
);
assert.ok(!/Jumpstart/i.test(unpaidMsg), "the Jumpstart must NOT ride alongside the unpaid-seat line");
// A settled seat gets the Jumpstart instead.
assert.ok(/Jumpstart/i.test(paidMsg), "a settled seat at a Jumpstart dealer gets the offer");
assert.ok(!/paid yet/.test(paidMsg), "a settled seat must never be told its payment is outstanding");
// NEVER an amount, in any shape.
for (const [label, msg] of [["unpaid", unpaidMsg], ["paid", paidMsg]] as const) {
  assert.ok(
    !/\$|\b\d+(\.\d{2})?\s*(dollars|usd)\b/i.test(msg),
    `[${label}] the registration reply must never state an amount: "${msg}"`
  );
}
// Nothing configured ⇒ the plain intro, byte for byte.
assert.equal(bareMsg, ack, "an unconfigured dealer must get the plain approved intro, unchanged");

// Portability: the copy itself must not hard-code this dealer (dealer #2 readiness).
const ackOtherDealer = buildRidingAcademyEnrollmentAck("Pat", "Sales Team", "Queen City Harley-Davidson");
assert.ok(
  !/American Harley/i.test(ackOtherDealer) && /Queen City Harley-Davidson/.test(ackOtherDealer),
  "the ack must carry the caller's dealer name, never a pinned one"
);

// --- 4) Source guard — wired at the initial-ADF draft in BOTH paths, exact call shape. ---
const index = fs.readFileSync("services/api/src/index.ts", "utf8");
const sendgrid = fs.readFileSync("services/api/src/routes/sendgridInbound.ts", "utf8");
const store = fs.readFileSync("services/api/src/domain/conversationStore.ts", "utf8");

// Live intake (this is the lane these actually arrive on): decided from BOTH structured fields, and
// it is what sets the draft.
//
// RE-PINNED 2026-08-07, deliberately. The gate was `isInitialAdf` and the shape asserted here was an
// inline `decideRidingAcademyTurn({...}).kind === "riding_academy_enrollment_ack"`. `isInitialAdf` is
// false as soon as ANY outbound exists, so the school's SECOND record (wait list -> Enrolled) never
// reached this branch and Maya Iversen (+15854782032) was answered with a payments question. The lane
// now opens on `isAdfFirstTouchRegen` — "has the CUSTOMER replied yet" — which is the guard the
// comment always described and the one the regen path already used, so this also closes a two-path
// drift. Full behaviour pinned by scripts/riding_academy_status_lane_eval.ts.
//
// RE-PINNED AGAIN 2026-08-08. The two assertions here pinned the inline call shape
// `decideRidingAcademyTurn({ leadSource: …, inquiry: … })` in this file. The live path now reaches
// that reducer through the shared resolver instead — the same one regen uses — so both pins went
// stale describing code that had legitimately moved. Same trap as the 4,000-character window in
// jumpstart_invite:eval: a pin on WHERE code sits cannot survive the code sitting somewhere better.
// What matters is that live intake feeds the resolver BOTH structured fields and nothing else, which
// is asserted on the call itself; the decision's own shape is asserted in domain/ridingAcademy.ts
// below, and the resulting BEHAVIOUR is executed further down.
const liveClaimCall = sendgrid.slice(
  sendgrid.indexOf("const academyAdfClaim = resolveRidingAcademyAdfLaneClaim({"),
  // The GUARDED branch specifically — `if (initialAdfRiderCourseDecision` alone first matches an
  // unrelated line ~3,700 lines earlier and slices an empty string, which passes nothing.
  sendgrid.indexOf("if (initialAdfRiderCourseDecision && !academyAdfClaim.liveReplyKind) {")
);
assert.ok(liveClaimCall.length > 0, "the claim must be resolved before the branch it guards");
// RE-PINNED 2026-08-20 — the requirement is unchanged (a lead source AND the record), but the
// source is now the EVENT's own, not the first form the customer arrived on. A COMPLETE record
// carries no `Enrollment Status:` field, so the stale source WAS the whole decision, and two
// graduates were answered as signups on 2026-08-19. Behaviour is pinned by
// `riding_academy_status_lane:eval` PART 1b/PART 4; this stays a shape pin on the call.
assert.ok(
  liveClaimCall.includes("leadSource: leadSource ?? conv.lead?.source,") &&
    liveClaimCall.includes("inquiry: effectiveInquiry"),
  "live intake must decide from the ANSWERED record's lead source AND the enrollment record"
);
assert.ok(
  liveClaimCall.includes("excludeProviderMessageId: event.providerMessageId"),
  "and must exclude the record being answered, or a second record reads its own status as the prior one"
);
assert.ok(
  sendgrid.includes("draft = buildAdfFirstTouchAck(academyAdfClaim.liveReplyKind,"),
  "live intake must override the draft with the ack from that same claim"
);
// Regen twin: same decision, gated to an ADF first touch with no customer SMS reply yet. The gate
// and the reply choice live in domain/ridingAcademy.ts (the source-size ratchet keeps new logic out
// of index.ts), so the wiring is asserted across BOTH files, by exact call shape in each.
const adfFirstTouch = fs.readFileSync("services/api/src/domain/ridingAcademy.ts", "utf8");
assert.ok(
  // The profiles, not a pre-picked source: the resolver decides WHICH form the turn is about
  // (`resolveLatestAdfLeadProfile`) — pinned by `regen_latest_adf_form:eval`.
  /const regenAdfFirstTouch = resolveAdfFirstTouchAckKind\(\{[\s\S]{0,400}lead: conv\.lead,[\s\S]{0,60}latestLead: conv\.latestLead,[\s\S]{0,240}\}\);/.test(
    index
  ) && /if \(regenAdfFirstTouch\.kind !== "none"\) \{/.test(index),
  "the regen path must resolve the enrollment ack through the shared first-touch resolver"
);
assert.ok(
  // Pins the DECISION SOURCE and the copy, not the statement's shape: this originally required
  // `decideRidingAcademyTurn(...).kind === "riding_academy_enrollment_ack"` as one adjacent
  // expression, and broke when the wait-list branch (2026-08-06) hoisted the call into a local. A
  // pin that fails on a refactor it does not care about trains people to loosen pins.
  /decideRidingAcademyTurn\(\{\s*leadSource: input\.leadSource,\s*inquiry: input\.inquiry,/.test(adfFirstTouch) &&
    /"riding_academy_enrollment_ack"/.test(adfFirstTouch) &&
    /buildRidingAcademyEnrollmentAck\(args\.firstName, args\.agentName, args\.dealerName, \{/.test(adfFirstTouch),
  "the shared resolver must decide from the reducer and build the approved enrollment copy"
);
// Precedence: the enrollment ack is checked BEFORE the non-buyer survey ack.
assert.ok(
  adfFirstTouch.indexOf("riding_academy_enrollment_ack") < adfFirstTouch.indexOf("decideNonBuyerSurveyTurn"),
  "the enrollment ack must be resolved ahead of the non-buyer survey ack"
);
assert.ok(
  /provider: event\.provider,\s*\n\s*messages: conv\.messages,/.test(index) &&
    /isAdfFirstTouchRegen\(\{ provider: input\.provider, messages: input\.messages \}\)/.test(adfFirstTouch) &&
    /!== "sendgrid_adf"\) return false/.test(adfFirstTouch) &&
    /m\?\.provider \?\? ""\)\.toLowerCase\(\) === "twilio"/.test(adfFirstTouch),
  "the regen gate must require an ADF first touch with no customer SMS reply yet"
);
assert.ok(
  /recordRouteOutcome\("regen", regenAdfFirstTouch\.kind/.test(index),
  "the regen branch must record its route outcome under the resolved ack kind"
);
// The cadence cap lives in the ONE referee, not a fresh inline writer.
assert.ok(
  /leadSource\?: string \| null;/.test(store) && /riding academy\/i\.test\(String\(input\.leadSource/.test(store.replace(/\\/g, "")),
  "the cadence cap must live inside resolveInitialAdfCadencePlan (one source of truth)"
);
// Both paths must reach the ONE reducer: the live lane calls it directly, the regen lane through
// the shared resolver. Neither may grow a second copy of the enrollment test.
const callSites = (src: string) => src.split("decideRidingAcademyTurn({").length - 1;
// The live path used to call the reducer inline. It now reaches it through the SAME shared resolver
// the regen path uses (resolveRidingAcademyAdfLaneClaim), which is what makes the two paths unable
// to disagree — so zero direct call sites here is the correct number, not a missing one.
assert.equal(
  callSites(sendgrid),
  0,
  "the live path must reach the reducer through domain/ridingAcademy.ts, not an inline copy"
);
assert.equal(
  sendgrid.split("resolveRidingAcademyAdfLaneClaim({").length - 1,
  1,
  "and it must resolve the academy claim exactly ONCE per turn — two calls is how the guard and the reply drift"
);
assert.ok(
  callSites(index) === 0 && /from "\.\/domain\/ridingAcademy\.js"/.test(index),
  "the regen path must reach the reducer through domain/ridingAcademy.ts, not re-implement the test"
);
assert.equal(callSites(adfFirstTouch), 1, "the shared resolver must call decideRidingAcademyTurn exactly once");

// ---------------------------------------------------------------------------
// THE COURSE-PRICE BRANCH MUST NOT OUTRANK AN ENROLLMENT (Ulises HernandezPerez +17167857284,
// 2026-08-08). His registration — payment FAILED — was answered with "Thanks for asking about our
// Riding Academy course. The current price is $321." Five of the six riding-academy leads we have
// ever had got that same sign-up pitch, because the live intake path answers a rider-course
// question and RETURNS ~960 lines before the academy ack is composed. Executed here, not grepped.
// ---------------------------------------------------------------------------
const ULISES_RECORD =
  "Enrollment Status: Enrolled-Course: New Rider Course - eCourse + Range-Class Start Date: 8/22/2026-" +
  "Gender: Male-Motivation: Obtain a license-Motorcycle Riding History: I have operated an on-road " +
  "motorcycle within the last 12 months-Training Experience: Yes, Other Program-Payment Status: Failed-" +
  "Future Motorcycle Purchase Expectation: Yes in 3-12 months-Accepted Terms and Conditions: true";
const adfRow = (body: string, id = "adf_1") => ({
  direction: "in",
  provider: "sendgrid_adf",
  providerMessageId: id,
  body: `WEB LEAD (ADF)\nSource: Riding Academy - Enrolled\n\nInquiry:\n${body}`
});
const claim = (over: Record<string, unknown> = {}) =>
  resolveRidingAcademyAdfLaneClaim({
    provider: "sendgrid_adf",
    messages: [adfRow(ULISES_RECORD)],
    excludeProviderMessageId: "adf_1",
    eventPromoKind: null,
    leadSource: "Riding Academy - Enrolled",
    inquiry: ULISES_RECORD,
    ...over
  });

const enrolled = claim();
assert.equal(
  enrolled.liveReplyKind,
  "riding_academy_enrollment_ack",
  "an Enrolled record OWNS the live reply — the course-price branch must not answer it"
);

// Joe, 2026-08-08: "Tell them how to settle it." A seat the school marked unpaid must carry the
// dealer's own settlement wording — and it must come from the profile, never invented here.
const settlementProfile = {
  policies: {
    firstTimeRider: {
      riderCourseName: "Riding Academy course",
      riderCoursePrice: "$321",
      unpaidSeatPaymentMethods: "at the dealership or over the phone"
    }
  }
};
const enrolledReply = buildAdfFirstTouchAck(enrolled.liveReplyKind!, {
  firstName: "Ulises",
  agentName: "Alexandra",
  dealerName: "Dealer Motorcycles",
  course: readRidingAcademyRecordFields(ULISES_RECORD).course,
  startDate: readRidingAcademyRecordFields(ULISES_RECORD).startDate,
  introduce: true,
  ...resolveEnrollmentAckExtras(settlementProfile, ULISES_RECORD)
});
assert.ok(
  enrolledReply.includes("isn't showing as paid yet"),
  "an unpaid seat is flagged to the student (Joe, 2026-08-08)"
);
assert.ok(
  enrolledReply.includes("at the dealership or over the phone"),
  "and settled the way the DEALER PROFILE says, never a method this code made up"
);
assert.ok(
  !enrolledReply.includes("$321") && !enrolledReply.includes("best place to start"),
  "and it still never quotes the sign-up price at somebody already enrolled"
);
// A paid seat says nothing about money at all.
const paidRecord = ULISES_RECORD.replace("Payment Status: Failed", "Payment Status: Paid");
assert.ok(
  !buildAdfFirstTouchAck("riding_academy_enrollment_ack", {
    firstName: "Ulises",
    agentName: "Alexandra",
    dealerName: "Dealer Motorcycles",
    introduce: true,
    ...resolveEnrollmentAckExtras(settlementProfile, paidRecord)
  }).includes("paid yet"),
  "a settled seat is never told about payment"
);
// A dealer who has not written a settlement method never has words put in its mouth.
assert.ok(
  !buildAdfFirstTouchAck("riding_academy_enrollment_ack", {
    firstName: "Ulises",
    agentName: "Alexandra",
    dealerName: "Dealer Motorcycles",
    introduce: true,
    ...resolveEnrollmentAckExtras({ policies: { firstTimeRider: {} } }, ULISES_RECORD)
  }).includes("paid yet"),
  "portability: with no settlement method configured the agent raises payment not at all"
);

// Everything the claim must NOT take over — each one keeps today's behaviour exactly.
// Wait List joined the owning kinds on 2026-08-08 (Joe: "build it"). It was excluded for exactly one
// deploy on the false premise that the live path had no wait-list copy — it always had.
// The wait-list reply's own content is pinned by riding_academy_waitlist_ack:eval.
assert.equal(
  claim({ inquiry: ULISES_RECORD.replace("Enrolled-Course", "Wait List-Course"), leadSource: "Riding Academy - Wait List" })
    .liveReplyKind,
  "riding_academy_waitlist_ack",
  "a Wait List record owns the live reply too — otherwise the course-price branch answers it"
);
const cancelled = claim({ inquiry: ULISES_RECORD.replace("Enrolled-Course", "Cancelled-Course") });
assert.equal(cancelled.kind, "riding_academy_unknown_status", "an unrecognised status stays unknown");
assert.equal(cancelled.liveReplyKind, null, "and composes no reply — it only raises a task");
assert.equal(cancelled.laneOpen, true, "but the lane is still OPEN, so that task is still raised");
assert.equal(
  claim({ messages: [adfRow(ULISES_RECORD), { direction: "in", provider: "twilio", body: "how much?" }] }).liveReplyKind,
  null,
  "once the CUSTOMER has texted back, normal routing answers — this is a first-touch lane only"
);
assert.equal(claim({ eventPromoKind: "event_promo_ack" }).liveReplyKind, null, "event_promo still outranks");
assert.equal(claim({ provider: "twilio" }).liveReplyKind, null, "a non-ADF event is not a first touch");
assert.equal(
  claim({ leadSource: "Room58 - Book test ride", inquiry: "Test ride request for Road Glide." }).liveReplyKind,
  null,
  "an ordinary sales ADF is untouched"
);

// THE ORDERING. The claim has to be resolved BEFORE the rider-course branch that returns, and that
// branch has to be guarded on it — otherwise the reply above is composed and never reached.
const claimIdx = sendgrid.indexOf("const academyAdfClaim = resolveRidingAcademyAdfLaneClaim({");
const courseBranchIdx = sendgrid.indexOf("if (initialAdfRiderCourseDecision && !academyAdfClaim.liveReplyKind) {");
assert.ok(claimIdx > 0, "the live path resolves the academy claim");
assert.ok(courseBranchIdx > 0, "and the rider-course branch is guarded on it");
assert.ok(claimIdx < courseBranchIdx, "the claim must be resolved BEFORE the branch that returns");
assert.ok(
  sendgrid.indexOf("if (academyAdfClaim.liveReplyKind) {") > courseBranchIdx,
  "and the ack itself is still composed downstream, from the SAME claim object"
);

// ---------------------------------------------------------------------------
// THE ACK MUST GREET THEM BY NAME. Verifying the fix above on the box produced "Hey there, it's
// Alexandra…" for Ulises, whose record plainly carries firstName "Ulises": the ack branches read
// `lead.name`, which the ADF parser never writes. 255 of the 825 leads in the live store have a
// firstName and NO name, and the intro prefix on the very same message reads firstName — so two
// readers of one fact disagreed, and about a third of ADF leads were greeted by nobody.
// ---------------------------------------------------------------------------
assert.equal(
  resolveAdfAckFirstName({ firstName: "Ulises", lastName: "HernandezPerez" }),
  "Ulises",
  "the ack reads the field the ADF parser actually writes"
);
assert.equal(
  resolveAdfAckFirstName({ firstName: "", name: "Donald Rawson" }),
  "Donald",
  "a record that only has `name` still works — this adds a reader, it does not swap one"
);
assert.equal(resolveAdfAckFirstName({ firstName: "ULISES" }), "Ulises", "a shouting ADF is not shouted back at");
assert.equal(resolveAdfAckFirstName({ firstName: "  Maya  " }), "Maya", "padding is trimmed");
assert.equal(resolveAdfAckFirstName({}), null, "no name at all stays null, so the copy says 'Hey there'");
assert.equal(resolveAdfAckFirstName(null), null, "and a missing lead does not throw");
assert.ok(
  sendgrid.includes("const adfAckFirstName = () => resolveAdfAckFirstName(activeAdfLeadProfile ?? conv.lead)"),
  "all three ADF ack branches share that ONE resolver, off the same profile the intro prefix reads"
);

const ackCount = rows.filter(r => r.ack).length;
console.log(
  `PASS riding-academy enrollment ack eval — ${rows.length} decision cases (${ackCount} ack / ${rows.length - ackCount} not), cadence cap parity, ack safety + portability, both-path first-touch source guard`
);
