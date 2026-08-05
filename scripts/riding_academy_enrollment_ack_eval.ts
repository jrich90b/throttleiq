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

// Live intake (this is the lane these actually arrive on): decided from BOTH structured fields,
// gated to the first touch, and it is what sets the draft.
assert.ok(
  /decideRidingAcademyTurn\(\{\s*leadSource: conv\.lead\?\.source,\s*inquiry: effectiveInquiry\s*\}\)\.kind === "riding_academy_enrollment_ack"/.test(
    sendgrid
  ),
  "live intake must decide from the lead source AND the enrollment record, by exact call shape"
);
assert.ok(
  /isInitialAdf/.test(sendgrid) && /draft = buildRidingAcademyEnrollmentAck\(/.test(sendgrid),
  "live intake must override the initial-ADF draft with the enrollment ack, first touch only"
);
// Regen twin: same decision, gated to an ADF first touch with no customer SMS reply yet. The gate
// and the reply choice live in domain/ridingAcademy.ts (the source-size ratchet keeps new logic out
// of index.ts), so the wiring is asserted across BOTH files, by exact call shape in each.
const adfFirstTouch = fs.readFileSync("services/api/src/domain/ridingAcademy.ts", "utf8");
assert.ok(
  /const regenAdfFirstTouchKind = resolveAdfFirstTouchAckKind\(\{[\s\S]{0,240}leadSource: conv\.lead\?\.source,[\s\S]{0,240}\}\);/.test(
    index
  ) && /const regenIsRidingAcademyEnrollment = regenAdfFirstTouchKind === "riding_academy_enrollment_ack";/.test(index),
  "the regen path must resolve the enrollment ack through the shared first-touch resolver"
);
assert.ok(
  /decideRidingAcademyTurn\(\{ leadSource: input\.leadSource, inquiry: input\.inquiry \}\)\.kind ===\s*"riding_academy_enrollment_ack"/.test(
    adfFirstTouch
  ) && /buildRidingAcademyEnrollmentAck\(args\.firstName, args\.agentName, args\.dealerName\)/.test(adfFirstTouch),
  "the shared resolver must decide from the reducer and build the approved enrollment copy"
);
// Precedence: the enrollment ack is checked BEFORE the non-buyer survey ack.
assert.ok(
  adfFirstTouch.indexOf("riding_academy_enrollment_ack") < adfFirstTouch.indexOf("decideNonBuyerSurveyTurn"),
  "the enrollment ack must be resolved ahead of the non-buyer survey ack"
);
assert.ok(
  /isAdfFirstTouchRegen\(\{ provider: event\.provider, messages: conv\.messages \}\)/.test(index) &&
    /!== "sendgrid_adf"\) return false/.test(adfFirstTouch) &&
    /m\?\.provider \?\? ""\)\.toLowerCase\(\) === "twilio"/.test(adfFirstTouch),
  "the regen gate must require an ADF first touch with no customer SMS reply yet"
);
assert.ok(
  /recordRouteOutcome\("regen", regenAdfFirstTouchKind/.test(index),
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
assert.equal(
  callSites(sendgrid),
  1,
  "the live path must call decideRidingAcademyTurn exactly once — no second inline copy"
);
assert.ok(
  callSites(index) === 0 && /from "\.\/domain\/ridingAcademy\.js"/.test(index),
  "the regen path must reach the reducer through domain/ridingAcademy.ts, not re-implement the test"
);
assert.equal(callSites(adfFirstTouch), 1, "the shared resolver must call decideRidingAcademyTurn exactly once");

const ackCount = rows.filter(r => r.ack).length;
console.log(
  `PASS riding-academy enrollment ack eval — ${rows.length} decision cases (${ackCount} ack / ${rows.length - ackCount} not), cadence cap parity, ack safety + portability, both-path first-touch source guard`
);
