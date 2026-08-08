/**
 * RIDING ACADEMY: the whole status lane (2026-08-07).
 *
 * Maya Iversen (+15854782032) signed up Wednesday night and was wait-listed. On Thursday the school
 * filed a SECOND record moving her to Enrolled for the 8/15 class. That record never reached the
 * Riding Academy branch at all — it was gated on `isInitialAdf`, which is false the moment any
 * outbound exists — so generic sales routing answered it with *"I can ballpark payments once I
 * confirm the exact price. If you'd like to stop in, what day and time works best?"*, to someone
 * whose own form says she has never been on a motorcycle, even as a passenger.
 *
 * H-D's Lead Source List (8.15) closes the vocabulary — three sources, all in
 * services/api/data/lead_sources/hdmc.json: 2843 ENROLLED, 2844 COMPLETE, 2978 Wait List. COMPLETE
 * was never handled; Joe chose its copy on 2026-08-07: congratulate, and stop.
 *
 * Run: npx tsx scripts/riding_academy_status_lane_eval.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const R = await import("../services/api/src/domain/routeStateReducer.ts");
const A = await import("../services/api/src/domain/agentVoice.ts");
const RA = await import("../services/api/src/domain/ridingAcademy.ts");

let n = 0;
const ok = (cond: boolean, msg: string) => {
  assert.equal(cond, true, msg);
  n++;
};

const WL = "Enrollment Status: Wait List-Course: New Rider Course - eCourse + Range-Class Start Date: 8/15/2026";
const EN = "Enrollment Status: Enrolled-Course: New Rider Course - eCourse + Range-Class Start Date: 8/15/2026";
const CO = "Enrollment Status: Complete-Course: New Rider Course - eCourse + Range";
const kind = (inquiry: string, priorStatus?: string | null, leadSource = "Riding Academy - Wait List") =>
  R.decideRidingAcademyTurn({ leadSource, inquiry, priorStatus }).kind;

// ---------------------------------------------------------------------------
// PART 1 — the decision, over the closed vocabulary
// ---------------------------------------------------------------------------
ok(kind(WL) === "riding_academy_waitlist_ack", "Wait List (2978) -> waitlist ack");
ok(kind(EN) === "riding_academy_enrollment_ack", "Enrolled (2843) with no prior record -> enrollment ack");
ok(
  kind(EN, "wait list") === "riding_academy_waitlist_to_enrolled_ack",
  "Enrolled AFTER wait list -> the transition ack (Maya's real turn)"
);
ok(kind(CO) === "riding_academy_completion_ack", "Complete (2844) -> completion ack, no longer falls through");

// The safety net. Every one of these used to return `none`, i.e. generic SALES routing.
for (const status of ["Cancelled", "Withdrawn", "Transferred", "No Show", "Refunded", "Pending Payment"]) {
  ok(
    kind(`Enrollment Status: ${status}-Course: New Rider Course`) === "riding_academy_unknown_status",
    `an unknown status (${status}) is held for a human, never answered as a sales lead`
  );
}
ok(
  kind("Course: New Rider Course", null, "Riding Academy") === "riding_academy_unknown_status",
  "on the lane with no status at all is also unknown, not a sales lead"
);

// Off the lane is untouched — this must not swallow ordinary leads.
ok(
  R.decideRidingAcademyTurn({ leadSource: "HDMC New Vehicle - Inventory", inquiry: "interested in a Street Bob" }).kind ===
    "none",
  "a normal sales lead is still `none`"
);
ok(
  R.decideRidingAcademyTurn({ leadSource: "HD.com Request a Quote", inquiry: "" }).kind === "none",
  "an unrelated ADF is still `none`"
);
// The source suffix works when the body carries no record (2843/2844 arrive upper-case).
ok(
  kind("", null, "RIDING ACADEMY - COMPLETE") === "riding_academy_completion_ack",
  "reads the status off the SOURCE suffix, case-insensitively"
);
// A prior status only matters for the enrolled transition.
ok(kind(WL, "wait list") === "riding_academy_waitlist_ack", "wait list after wait list is still just wait list");
ok(kind(CO, "enrolled") === "riding_academy_completion_ack", "a prior enrollment does not change a completion");

// ---------------------------------------------------------------------------
// PART 2 — the prior-status reader (the thread's history, not the customer's words)
// ---------------------------------------------------------------------------
const adf = (body: string, id: string) => ({ direction: "in", provider: "sendgrid_adf", body, providerMessageId: id });
const thread = [adf(WL, "a1"), { direction: "out", provider: "draft_ai", body: "..." }, adf(EN, "a2")];
ok(
  RA.readPriorRidingAcademyStatus({ messages: thread, excludeProviderMessageId: "a2" }) === "wait list",
  "the prior record's status is found by id"
);
ok(
  RA.readPriorRidingAcademyStatus({ messages: thread }) === "wait list",
  "and without an id, by dropping the newest record"
);
ok(
  RA.readPriorRidingAcademyStatus({ messages: [adf(WL, "a1")], excludeProviderMessageId: "a1" }) === null,
  "a lone record has no prior status"
);
ok(RA.readPriorRidingAcademyStatus({ messages: [] }) === null, "no messages -> no prior status");
ok(RA.readPriorRidingAcademyStatus({ messages: null }) === null, "unusable input -> no prior status");
ok(
  RA.readPriorRidingAcademyStatus({
    messages: [{ direction: "in", provider: "twilio", body: "Enrollment Status: Enrolled" }, adf(EN, "a2")],
    excludeProviderMessageId: "a2"
  }) === null,
  "a CUSTOMER text is never read as an enrollment record"
);

// ---------------------------------------------------------------------------
// PART 3 — the copy Joe approved
// ---------------------------------------------------------------------------
const NOTE = "Our riding academy manager will send you your e-course link.";
const trans = (introduce: boolean) =>
  A.buildRidingAcademyWaitlistToEnrolledAck("Maya", "Alexandra", "American Harley-Davidson", {
    course: "New Rider Course",
    startDate: "8/15/2026",
    registrationNote: NOTE,
    introduce
  });

ok(trans(true).includes("it's Alexandra over at American Harley-Davidson"), "first contact introduces the agent");
// Joe, 2026-08-07, twice over: "If it's a 2nd touch it should not say I'm your contact again", and
// "We already told her the agent is her contact - maybe just say I'm here if you need anything."
// This message ONLY ever follows a wait-list ack, which already carries the role sentence in full, so
// the light line replaces it in BOTH variants — not only when the intro is suppressed.
ok(!trans(false).includes("over at American Harley-Davidson"), "a second touch does not re-announce the dealership");
ok(trans(false).startsWith("Hey Maya, good news"), "it still opens warmly, lower-case after the comma");
for (const introduce of [true, false]) {
  const t = trans(introduce);
  ok(!t.includes("I'm your contact"), "never repeats the contact-role sentence the wait-list ack already sent");
  ok(t.includes("I'm here if you need anything."), "says the light line Joe chose instead");
  ok(t.includes("a seat opened up and you're registered"), "the news is that the wait ended");
  ok(t.includes("the New Rider Course starting 8/15/2026"), "names the class and date off the record");
  ok(t.includes(NOTE), "carries the dealer's e-course sentence — the same registration moment");
  ok(!/\$|price|payment|test ride|stop in/i.test(t), "no money and no pitch");
}
// Nothing invented when the record is thin.
const thin = A.buildRidingAcademyWaitlistToEnrolledAck("Maya", "Alexandra", "AH-D", { introduce: true });
ok(thin.includes("registered for the Riding Academy"), "no class named when the record names none");
ok(!thin.includes("starting"), "and no date invented");
ok(!thin.endsWith(" "), "no trailing space when the profile note is blank");

const done = (introduce: boolean) =>
  A.buildRidingAcademyCompletionAck("Maya", "Alexandra", "American Harley-Davidson", {
    course: "New Rider Course",
    introduce
  });
ok(done(true).includes("Congratulations on finishing the New Rider Course"), "completion congratulates");
ok(done(false).includes("congratulations on finishing"), "lower-case after 'Hey Maya,' on a second touch");
ok(!done(false).includes("Hey Maya, Congratulations"), "never 'Hey Maya, Congratulations'");
for (const introduce of [true, false]) {
  const t = done(introduce);
  // Joe chose option 1 of three: congratulate, and STOP.
  ok(!/\$|price|payment|finance|test ride|stop in|which model|come in/i.test(t), "no pitch on a completion");
  ok(!/first bike|looking for a bike|shopping/i.test(t), "and no soft sell either");
}

// ---------------------------------------------------------------------------
// PART 4 — the wiring, in BOTH paths (route-parity law)
// ---------------------------------------------------------------------------
const here = path.dirname(fileURLToPath(import.meta.url));
const live = fs.readFileSync(path.join(here, "../services/api/src/routes/sendgridInbound.ts"), "utf8");

ok(
  !/isInitialAdf &&\s*\n\s*decideEventPromoTurn\(\{[^}]*\}\)\.kind !== "event_promo_ack" &&\s*\n\s*decideRidingAcademyTurn/.test(
    live
  ),
  "the live Riding Academy branch is no longer gated on isInitialAdf — that gate is what dropped Maya's record"
);
// RE-PINNED 2026-08-08: these two asserted the inline shapes `const ridingAcademyLaneOpen = …` and
// `priorStatus: readPriorRidingAcademyStatus({ … })` in the live file. Both moved into the shared
// resolver when the course-price branch stopped outranking an enrolled student, so both pins went
// stale describing code that had legitimately moved. The PROPERTIES they were protecting are what
// matter, and those are executed below instead of read.
const adfRecord = (status: string, id: string) => ({
  direction: "in",
  provider: "sendgrid_adf",
  providerMessageId: id,
  body: `WEB LEAD (ADF)\nSource: Riding Academy - ${status}\n\nInquiry:\nEnrollment Status: ${status}-Course: New Rider Course-Class Start Date: 8/22/2026`
});
const laneClaim = (over: Record<string, unknown> = {}) =>
  RA.resolveRidingAcademyAdfLaneClaim({
    provider: "sendgrid_adf",
    messages: [adfRecord("Enrolled", "adf_1")],
    excludeProviderMessageId: "adf_1",
    eventPromoKind: null,
    leadSource: "Riding Academy - Enrolled",
    inquiry: "Enrollment Status: Enrolled-Course: New Rider Course-Class Start Date: 8/22/2026",
    ...over
  });

// "Has the CUSTOMER replied yet" — not "has anything been sent", which is the gate that dropped
// Maya's second record. An outbound of ours must NOT close the lane; a customer SMS must.
ok(laneClaim().laneOpen === true, "a school record with no customer reply keeps the lane open");
ok(
  laneClaim({ messages: [adfRecord("Enrolled", "adf_1"), { direction: "out", provider: "draft_ai", body: "Hi" }] })
    .laneOpen === true,
  "an outbound of OURS does not close the lane — that is the isInitialAdf gate that lost Maya"
);
ok(
  laneClaim({ messages: [adfRecord("Enrolled", "adf_1"), { direction: "in", provider: "twilio", body: "how much?" }] })
    .laneOpen === false,
  "once the CUSTOMER texts back, normal routing answers"
);
// The thread's PRIOR status is read, and the record being answered is excluded from it — otherwise
// a second record reads its own status as the prior one and the transition disappears.
ok(
  laneClaim({
    messages: [adfRecord("Wait List", "adf_1"), adfRecord("Enrolled", "adf_2")],
    excludeProviderMessageId: "adf_2"
  }).kind === "riding_academy_waitlist_to_enrolled_ack",
  "wait list -> Enrolled is read as the TRANSITION, using the thread's prior record"
);
// The exclusion has to work by ID, not by "drop the newest row". Live, the record being answered IS
// the newest, so the two are indistinguishable — but REGENERATE re-runs an older record, and there
// the id is the only thing that identifies it. A fixture where the answered record is not last is
// the only one that can tell a real exclusion from the positional fallback.
// A deliberately synthetic thread — the answered record is in the MIDDLE, and the rows on either
// side carry different statuses. It is a mechanism test, not a customer journey: excluding by ID
// reads "wait list" from the row after it, while the positional "drop the newest" fallback would
// read "enrolled" from the row before. Any fixture whose answered record is last cannot tell those
// two apart, which is why an earlier version of this survived having the exclusion deleted.
ok(
  laneClaim({
    messages: [adfRecord("Enrolled", "adf_1"), adfRecord("Enrolled", "adf_2"), adfRecord("Wait List", "adf_3")],
    excludeProviderMessageId: "adf_2"
  }).kind === "riding_academy_waitlist_to_enrolled_ack",
  "excluding by ID is what makes regenerating an OLDER record read the right prior status"
);
ok(
  /introduce: shouldIntroduceOnAdfTouch\(\{ isAdfEvent: true, messages: conv\.messages \}\)/.test(live),
  "and keys the intro off what the customer RECEIVED (Joe 2026-07-16), not off the ADF count"
);
ok(
  live.includes('academyAdfClaim.kind === "riding_academy_unknown_status"') && live.includes("addTodo("),
  "an unknown status raises a staff task"
);
ok(
  laneClaim({ inquiry: "Enrollment Status: Cancelled-Course: New Rider Course" }).kind ===
    "riding_academy_unknown_status",
  "and an unrecognised status is what reaches that branch"
);

const shared = fs.readFileSync(path.join(here, "../services/api/src/domain/ridingAcademy.ts"), "utf8");
// Both paths or neither: the regen resolver DELEGATES to the same lane claim the live path uses, so
// there is exactly one place the prior status is read and one decision to keep correct.
ok(
  shared.split("decideRidingAcademyTurn({").length - 1 === 1,
  "exactly ONE riding-academy decision in the module — two is how the paths drifted"
);
ok(
  shared.includes("const academy = resolveRidingAcademyAdfLaneClaim({"),
  "the REGEN path reaches it through the same resolver as live"
);
ok(
  /if \(academy\.kind !== "none"\) \{\s*\n\s*return \{ isAdfFirstTouch, kind: academy\.kind \};/.test(shared),
  "regen forwards every riding-academy kind, not just the two it used to know"
);
for (const k of ["riding_academy_waitlist_to_enrolled_ack", "riding_academy_completion_ack"]) {
  ok(shared.includes(`kind === "${k}"`), `buildAdfFirstTouchAck can build ${k}`);
}

console.log(`riding_academy_status_lane_eval: PASS (${n} assertions)`);
