/**
 * JUMPSTART 1-on-1 invite eval (pure, no LLM).
 *
 * Pins Joe's rule (2026-08-05): *if the dealer HAS a Jumpstart — noted in the profile — and the
 * customer has no-to-little riding experience, the agent invites them in for a 1-on-1 ride on it.*
 *
 * The Jumpstart is a real bike locked to a stationary rig: clutch, throttle and gears with the
 * engine running, no license and no road. Before this, the agent only ever mentioned it when the
 * CUSTOMER raised it first, and it never checked whether the store owned one.
 *
 * Comprehension stays where it belongs: WHO is a beginner is read by the existing typed
 * `first_time_rider_guidance` parser, and this eval feeds that parser's own output shape into the
 * pure decision. The one non-parser source is the rider-training enrollment record's
 * `Motorcycle Riding History:` field — a machine enum inside a machine record.
 *
 * Layers:
 *   1. Capability gate — no Jumpstart in the profile ⇒ never offered, whatever the customer says.
 *      Absent / false / truthy-but-not-true all read as NO.
 *   2. Experience table — only an EXPLICIT beginner signal invites; unknown and experienced do not.
 *   3. Copy safety — no price, no test-ride/road-ride promise, no day or time, no claim that it
 *      replaces a license or training.
 *   4. Wiring — the invite reaches the beginner-facing replies in BOTH paths and is absent from the
 *      course-price and endorsed-rider replies.
 *
 * Run: npx tsx scripts/jumpstart_invite_eval.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  decideJumpstartInviteTurn,
  resolveRiderExperienceLevel
} from "../services/api/src/domain/routeStateReducer.ts";
import {
  buildJumpstartOneOnOneInvite,
  buildFirstTimeRiderBeginnerReply
} from "../services/api/src/domain/agentVoice.ts";
import {
  readFirstTimeRiderPolicy,
  readEnrollmentRidingHistory,
  readEnrollmentCourseName
} from "../services/api/src/domain/firstTimeRiderPolicy.ts";
import { resolveEnrollmentJumpstartInvite } from "../services/api/src/domain/ridingAcademy.ts";

const BEGINNER = { riderIntent: "first_time_rider", hasEndorsement: null };

// --- 1) Capability gate. The dealer must SAY it has one. ---
const capabilityRows: { id: string; profile: any; hasJumpstart: boolean }[] = [
  { id: "explicit_true", profile: { policies: { firstTimeRider: { jumpstartEnabled: true } } }, hasJumpstart: true },
  { id: "explicit_false", profile: { policies: { firstTimeRider: { jumpstartEnabled: false } } }, hasJumpstart: false },
  { id: "field_absent", profile: { policies: { firstTimeRider: { riderCourseName: "Riding Academy course" } } }, hasJumpstart: false },
  { id: "no_first_time_policy", profile: { policies: {} }, hasJumpstart: false },
  { id: "no_policies", profile: {}, hasJumpstart: false },
  { id: "no_profile", profile: null, hasJumpstart: false },
  // A truthy non-boolean is NOT a yes — a config typo must never put a customer on equipment.
  { id: "string_true_is_not_true", profile: { policies: { firstTimeRider: { jumpstartEnabled: "true" } } }, hasJumpstart: false },
  { id: "number_one_is_not_true", profile: { policies: { firstTimeRider: { jumpstartEnabled: 1 } } }, hasJumpstart: false }
];
for (const r of capabilityRows) {
  const policy = readFirstTimeRiderPolicy(r.profile);
  assert.equal(policy.jumpstartEnabled, r.hasJumpstart, `readFirstTimeRiderPolicy[${r.id}] jumpstartEnabled`);
  // The capability gate is decisive: a confirmed beginner is still not offered a rig we lack.
  assert.equal(
    decideJumpstartInviteTurn({ dealerHasJumpstart: policy.jumpstartEnabled, ...BEGINNER }).kind ===
      "jumpstart_one_on_one_invite",
    r.hasJumpstart,
    `decideJumpstartInviteTurn[${r.id}] must follow the profile, not the customer`
  );
}

// --- 2) Experience table. Only an explicit beginner signal invites. ---
type ExpRow = {
  id: string;
  riderIntent?: string | null;
  hasEndorsement?: boolean | null;
  ridingHistory?: string | null;
  enrolledCourse?: string | null;
  level: "none_or_little" | "experienced" | "unknown";
};
const expRows: ExpRow[] = [
  { id: "parser_first_time_rider", riderIntent: "first_time_rider", level: "none_or_little" },
  { id: "parser_no_endorsement", riderIntent: "no_motorcycle_endorsement", level: "none_or_little" },
  { id: "endorsement_false", riderIntent: "beginner_bike_advice", hasEndorsement: false, level: "none_or_little" },
  // An endorsement in hand outranks the intent label — an endorsed rider asking a beginner-bike
  // question is a rider, and telling him we think he is a novice is the insult this guards against.
  { id: "endorsed_beats_beginner_intent", riderIntent: "first_time_rider", hasEndorsement: true, level: "experienced" },
  { id: "endorsement_true", riderIntent: "beginner_bike_advice", hasEndorsement: true, level: "experienced" },
  // Asking what a course costs says nothing about how much you have ridden.
  { id: "course_info_alone_is_unknown", riderIntent: "rider_course_info", level: "unknown" },
  { id: "beginner_bike_advice_alone_is_unknown", riderIntent: "beginner_bike_advice", level: "unknown" },
  { id: "no_signal_at_all", level: "unknown" },
  // The enrollment record's machine enum.
  {
    id: "enrollment_has_ridden_recently",
    ridingHistory: "I have operated an on-road motorcycle within the last 12 months",
    level: "experienced"
  },
  {
    id: "enrollment_never_operated",
    ridingHistory: "I have never operated an on-road motorcycle",
    level: "none_or_little"
  },
  {
    id: "enrollment_have_not_operated",
    ridingHistory: "I have not operated an on-road motorcycle",
    level: "none_or_little"
  },
  // A wording we have never seen is NOT a guess.
  { id: "enrollment_unrecognised_wording", ridingHistory: "Prefer not to say", level: "unknown" },
  // The COURSE they signed up for (Joe, 2026-08-05 — the offer belongs in the registration reply).
  // Paying to be taught the basics outranks a vague "have operated a motorcycle in 12 months",
  // which is why both real enrollees qualify despite that field.
  {
    id: "new_rider_course_outranks_riding_history",
    enrolledCourse: "New Rider Course - eCourse + Range",
    ridingHistory: "I have operated an on-road motorcycle within the last 12 months",
    level: "none_or_little"
  },
  { id: "basic_rider_course", enrolledCourse: "Basic Rider Course", level: "none_or_little" },
  { id: "learn_to_ride_course", enrolledCourse: "Learn To Ride — Weekend", level: "none_or_little" },
  // An advanced / returning-rider course is NOT a beginner signal; it falls through to the
  // history field, so those students are never handed a beginner rig.
  {
    id: "advanced_course_falls_through_to_history",
    enrolledCourse: "Advanced Rider Course",
    ridingHistory: "I have operated an on-road motorcycle within the last 12 months",
    level: "experienced"
  },
  { id: "returning_rider_course_alone_is_unknown", enrolledCourse: "Returning Rider Course", level: "unknown" },
  // An endorsement still outranks everything, course included.
  {
    id: "endorsed_beats_new_rider_course",
    enrolledCourse: "New Rider Course - eCourse + Range",
    hasEndorsement: true,
    level: "experienced"
  }
];
for (const r of expRows) {
  assert.equal(
    resolveRiderExperienceLevel({
      riderIntent: r.riderIntent ?? null,
      hasEndorsement: r.hasEndorsement ?? null,
      ridingHistory: r.ridingHistory ?? null,
      enrolledCourse: r.enrolledCourse ?? null
    }),
    r.level,
    `resolveRiderExperienceLevel[${r.id}]`
  );
  assert.equal(
    decideJumpstartInviteTurn({
      dealerHasJumpstart: true,
      riderIntent: r.riderIntent ?? null,
      hasEndorsement: r.hasEndorsement ?? null,
      ridingHistory: r.ridingHistory ?? null,
      enrolledCourse: r.enrolledCourse ?? null
    }).kind === "jumpstart_one_on_one_invite",
    r.level === "none_or_little",
    `decideJumpstartInviteTurn[${r.id}] must invite only an explicit beginner`
  );
}

// One-shot: having offered once, we do not keep asking.
assert.equal(
  decideJumpstartInviteTurn({ dealerHasJumpstart: true, ...BEGINNER, alreadyOffered: true }).kind,
  "none",
  "the invite is one-shot — an offer already made is not repeated"
);

// The real enrollment bodies (Savannah Niver +13155211619, Donald Rawson +17165344986, 2026-08-04):
// both say they HAVE ridden within 12 months, so neither is offered the Jumpstart on that field.
const SAVANNAH =
  "Enrollment Status: Enrolled-Course: New Rider Course - eCourse + Range-Class Start Date: 8/15/2026-Gender: Female-Motivation: Obtain a license-Motorcycle Riding History: I have operated an on-road motorcycle within the last 12 months-Training Experience: No-Payment Status: Failed";
assert.equal(
  readEnrollmentRidingHistory(SAVANNAH),
  "I have operated an on-road motorcycle within the last 12 months",
  "the riding-history field is read to the next FIELD boundary, not the next hyphen ('on-road')"
);
assert.equal(
  decideJumpstartInviteTurn({ dealerHasJumpstart: true, ridingHistory: readEnrollmentRidingHistory(SAVANNAH) }).kind,
  "none",
  "a student who has ridden within 12 months is not offered a beginner rig on that field alone"
);
assert.equal(readEnrollmentRidingHistory("Interested in a Street Glide"), "", "a lead with no enrollment record reads empty");
assert.equal(
  readEnrollmentCourseName(SAVANNAH),
  "New Rider Course - eCourse + Range",
  "the course field is read to the next FIELD boundary, keeping its internal hyphen"
);

// END TO END on the REGISTRATION reply (Joe, 2026-08-05): the whole record, through the one
// resolver both the live intake and the regen path call.
assert.ok(
  resolveEnrollmentJumpstartInvite({ policies: { firstTimeRider: { jumpstartEnabled: true } } }, SAVANNAH).includes(
    "Jumpstart"
  ),
  "a New Rider Course registration at a Jumpstart dealer must carry the offer"
);
assert.equal(
  resolveEnrollmentJumpstartInvite({ policies: { firstTimeRider: {} } }, SAVANNAH),
  "",
  "the same registration at a dealer with no Jumpstart must carry nothing"
);
assert.equal(
  resolveEnrollmentJumpstartInvite(
    { policies: { firstTimeRider: { jumpstartEnabled: true } } },
    "Enrollment Status: Enrolled-Course: Advanced Rider Course-Motorcycle Riding History: I have operated an on-road motorcycle within the last 12 months"
  ),
  "",
  "an ADVANCED-course student at a Jumpstart dealer is not offered a beginner rig"
);
assert.equal(
  resolveEnrollmentJumpstartInvite({ policies: { firstTimeRider: { jumpstartEnabled: true } } }, "Interested in a Street Glide"),
  "",
  "an ordinary sales lead is not an enrollment and gets nothing"
);

// --- 3) Copy safety. ---
const invite = buildJumpstartOneOnOneInvite();
assert.ok(/jumpstart/i.test(invite), "the invite must name the Jumpstart");
assert.ok(/one-on-one|1-on-1/i.test(invite), "the invite must offer 1-on-1 time, which is the whole ask");
const BANNED: { label: string; re: RegExp }[] = [
  { label: "price", re: /\$|\bprice|pricing|cost|fee|free\b/i },
  { label: "test-ride or road-ride promise", re: /\btest ride|road ride|out on the road|ride it home\b/i },
  { label: "specific day or time", re: /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|\d{1,2}\s?(am|pm))\b/i },
  { label: "claim it replaces training or a license", re: /\b(instead of|replaces|no need for) (a |the )?(course|class|training|license|licence|endorsement)\b/i }
];
for (const b of BANNED) {
  assert.ok(!b.re.test(invite), `the Jumpstart invite must not contain a ${b.label}: "${invite}"`);
}
// It must say the license point the RIGHT way round — no license needed FOR THE RIG, not in general.
assert.ok(/no license needed/i.test(invite), "the invite must say the rig itself needs no license");

// --- 4) Wiring — both paths, and only the beginner-facing replies. ---
const index = fs.readFileSync("services/api/src/index.ts", "utf8");
const reducer = fs.readFileSync("services/api/src/domain/routeStateReducer.ts", "utf8");
const policyMod = fs.readFileSync("services/api/src/domain/firstTimeRiderPolicy.ts", "utf8");

assert.ok(
  /decideJumpstartInviteTurn\(\{\s*dealerHasJumpstart: policy\.jumpstartEnabled,/.test(index),
  "the reply builder must ask the reducer, gated on the profile capability, by exact call shape"
);
assert.ok(
  /jumpstartEnabled: p\.jumpstartEnabled === true/.test(policyMod),
  "the capability must require an explicit boolean true"
);
// The first-time-rider lane runs in the live SMS path, the ADF/regen path, and the regen SMS path;
// all three build their reply through these two builders, so the invite reaches every path.
assert.equal(
  index.split("ridingHistory: readEnrollmentRidingHistory(conv.lead?.inquiry)").length - 1,
  3,
  "all three first-time-rider reply call sites must pass the enrollment riding-history field"
);
// The invite rides on the beginner branches only — never on the course-price answer, and never on
// the reply to someone who already told us they are endorsed.
const beginnerBranch = index.slice(index.indexOf("function buildFirstTimeRiderGuidanceReply"));
// Only the endorsed-rider RETURN LINE itself — slicing further runs into the beginner branches
// below it, which do carry the invite.
const endorsedReply = beginnerBranch
  .split("\n")
  .find(line => line.includes("Since you have your endorsement"));
assert.ok(endorsedReply, "the endorsed-rider reply must still exist");
assert.ok(
  !/\$\{jumpstartInvite\}/.test(String(endorsedReply)),
  "the endorsed-rider reply must not carry the Jumpstart invite"
);
// Nor may the course-price answer, which is a question about money, not about experience.
const coursePriceReply = beginnerBranch
  .split("\n")
  .find(line => line.includes("is the best place to start."));
assert.ok(coursePriceReply, "the course-info reply must still exist");
assert.ok(
  !/\$\{jumpstartInvite\}/.test(String(coursePriceReply)),
  "the course-price reply must not carry the Jumpstart invite"
);
assert.equal(
  (beginnerBranch.slice(0, 4000).match(/buildFirstTimeRiderBeginnerReply\(\{/g) ?? []).length,
  3,
  "exactly the three beginner-facing replies are composed through the shared builder"
);
// --- 5) The composition itself, RUN rather than grepped. -----------------------------------------
// A grep-only version of this section passed a sabotage that APPENDED the invite instead of
// substituting it (2026-08-05), so the three beginner bodies live in agentVoice and are executed
// here. Two properties per branch: without a Jumpstart the reply is today's wording byte for byte,
// and with one the invite REPLACES the clause it improves on and the result stays inside the SMS
// brevity budget.
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "eval-no-live-key";
const { exceedsSmsBrevityBudget } = await import("../services/api/src/domain/llmDraft.ts");

const BRANCHES = [
  {
    branch: "no_endorsement" as const,
    args: { requirement: "For test rides, we do need a motorcycle endorsement.", courseText: "a motorcycle safety course" },
    // The clause the invite must REPLACE, not join.
    replaced: "We can still help you sit on a few bikes and talk through beginner-friendly options."
  },
  { branch: "asks_test_ride" as const, args: {}, replaced: "Do you already have your motorcycle endorsement?" },
  { branch: "general" as const, args: {}, replaced: "Do you already have your motorcycle endorsement, or are you still getting started?" }
];
for (const b of BRANCHES) {
  const without = buildFirstTimeRiderBeginnerReply({ branch: b.branch, jumpstartInvite: "", ...b.args });
  const withJs = buildFirstTimeRiderBeginnerReply({ branch: b.branch, jumpstartInvite: invite, ...b.args });
  assert.ok(
    without.includes(b.replaced),
    `[${b.branch}] a dealer with no Jumpstart must keep today's exact wording`
  );
  assert.ok(!without.includes("Jumpstart"), `[${b.branch}] no Jumpstart in the profile ⇒ no Jumpstart in the reply`);
  assert.ok(withJs.includes("Jumpstart"), `[${b.branch}] a Jumpstart dealer must actually offer it`);
  // THE SABOTAGE THAT GOT THROUGH: appending leaves the replaced clause in place.
  assert.ok(
    !withJs.includes(b.replaced),
    `[${b.branch}] the invite must REPLACE "${b.replaced}", not be appended alongside it`
  );
  assert.equal(
    exceedsSmsBrevityBudget(withJs),
    false,
    `[${b.branch}] the reply carrying the invite must stay inside the SMS brevity budget: "${withJs}"`
  );
  // One ask per text: the invite already ends in a question.
  assert.ok(
    (withJs.match(/\?/g) ?? []).length <= 1,
    `[${b.branch}] the reply must not ask the customer two questions at once: "${withJs}"`
  );
}
// The rule lives in the reducer, not inline in the router.
assert.ok(
  /export function decideJumpstartInviteTurn/.test(reducer) &&
    /export function resolveRiderExperienceLevel/.test(reducer),
  "the rule must live in routeStateReducer, not inline in index.ts"
);

console.log(
  `PASS jumpstart invite eval — ${capabilityRows.length} capability cases, ${expRows.length} experience cases, one-shot, copy safety + both-path wiring`
);
