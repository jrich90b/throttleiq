/**
 * RIDER-COURSE SCHEDULE TABLE eval (2026-08-07).
 *
 * The school sends a class DATE and never a time (measured across every enrollment ADF in the live
 * store). Times and places vary by class AND between the days of one class — the initial meeting is
 * at the dealership, the range day is at Niagara Wheatfield High School. So the dealer maintains a
 * small table, and the agent answers from the student's own class date.
 *
 * Joe's question when he approved it was "what if it changes?" — every assertion below is an answer
 * to that. The table must FAIL QUIET, never fail confident: a class it does not know, a row nobody
 * has confirmed lately, or a class already run must all produce a hand-off, because a wrong start
 * time means a student misses a course they paid $321 for.
 *
 * Clock-safe: every timestamp is derived from a pinned NOW.
 *
 * Run: npx tsx scripts/rider_course_schedule_eval.ts
 */
import assert from "node:assert/strict";

const S = await import("../services/api/src/domain/riderCourseSchedule.ts");

let n = 0;
const ok = (cond: boolean, msg: string) => {
  assert.equal(cond, true, msg);
  n++;
};

const NOW = Date.parse("2026-08-07T20:00:00Z");
const DAY = 86_400_000;
const ago = (days: number) => new Date(NOW - days * DAY).toISOString();

const CLASS = {
  date: "8/22/2026",
  updatedAt: ago(2),
  sessions: [
    { date: "8/22/2026", startTime: "8:00 AM", endTime: "4:00 PM", location: "American Harley-Davidson, front parking lot", label: "classroom" },
    { date: "8/23/2026", startTime: "7:30 AM", endTime: "3:30 PM", location: "Niagara Wheatfield High School, Sanborn NY", label: "range" }
  ]
};
const decide = (over: Record<string, unknown> = {}) =>
  S.decideRiderCourseScheduleAnswer({ rows: [CLASS], studentClassDate: "8/22/2026", nowMs: NOW, ...over });

// --- the happy path: per-DAY facts, which is the whole reason for the session model ---
const good = decide();
ok(good.kind === "answer", "a confirmed row for this student's class answers");
ok(good.sessions.length === 2, "both days are available, not one blended answer");
ok(good.firstSession?.startTime === "8:00 AM", "the first day is the one they show up to");
ok(
  String(good.firstSession?.location).includes("American Harley-Davidson"),
  "Joe 2026-08-07: the INITIAL meeting place is the dealership"
);
ok(
  String(good.sessions[1].location).includes("Niagara Wheatfield"),
  "the RANGE day is a different place — answering it with the dealership sends a student 20 minutes wrong"
);
ok(good.sessions[1].startTime === "7:30 AM", "and a different time — days within one class vary");

// --- Defence 1: a class that has already run is never quoted ---
ok(decide({ nowMs: Date.parse("2026-09-01T00:00:00Z") }).kind === "handoff", "a class already run hands off");
ok(decide({ nowMs: Date.parse("2026-08-22T23:00:00Z") }).kind === "answer", "but the day OF the class still answers");

// --- Defence 2: never answer from a neighbouring row ---
const other = decide({ studentClassDate: "8/15/2026" });
ok(other.kind === "handoff", "a class not in the table hands off — never the nearest row");
ok(other.row === null && other.sessions.length === 0, "and carries no facts at all");
ok(decide({ studentClassDate: "" }).kind === "handoff", "no class date on the student hands off");
ok(decide({ rows: [] }).kind === "handoff", "an empty table hands off");
ok(decide({ rows: null }).kind === "handoff", "a missing table hands off");

// --- Defence 3: THE ANSWER TO "what if it changes" — a stale row stops answering ---
ok(
  S.decideRiderCourseScheduleAnswer({ rows: [{ ...CLASS, updatedAt: ago(45) }], studentClassDate: "8/22/2026", nowMs: NOW })
    .kind === "handoff",
  "a row nobody confirmed inside the window STOPS ANSWERING rather than quoting a time that may have moved"
);
ok(
  S.decideRiderCourseScheduleAnswer({ rows: [{ ...CLASS, updatedAt: ago(29) }], studentClassDate: "8/22/2026", nowMs: NOW })
    .kind === "answer",
  "a recently confirmed row still answers"
);
ok(
  S.decideRiderCourseScheduleAnswer({ rows: [{ ...CLASS, updatedAt: null }], studentClassDate: "8/22/2026", nowMs: NOW })
    .kind === "handoff",
  "a row never confirmed by a human is treated as stale, not as fresh"
);
ok(
  S.decideRiderCourseScheduleAnswer({ rows: [{ ...CLASS, updatedAt: "not-a-date" }], studentClassDate: "8/22/2026", nowMs: NOW })
    .kind === "handoff",
  "an unreadable confirmation stamp is stale — absence of proof is not proof"
);
ok(
  S.decideRiderCourseScheduleAnswer({ rows: [{ ...CLASS, updatedAt: ago(45) }], studentClassDate: "8/22/2026", nowMs: NOW, staleAfterDays: 90 })
    .kind === "answer",
  "the staleness window is configurable"
);

// --- Defence 4: blanks are never filled in ---
ok(
  S.decideRiderCourseScheduleAnswer({
    rows: [{ ...CLASS, sessions: [{ date: "8/22/2026", location: "the dealership" }] }],
    studentClassDate: "8/22/2026",
    nowMs: NOW
  }).firstSession?.startTime == null,
  "a session with a place but no time answers the place and leaves the time blank — never invented"
);
ok(
  S.decideRiderCourseScheduleAnswer({
    rows: [{ ...CLASS, sessions: [{ date: "8/22/2026" }] }],
    studentClassDate: "8/22/2026",
    nowMs: NOW
  }).kind === "handoff",
  "a session with neither a time nor a place is the same as no row"
);
ok(
  S.decideRiderCourseScheduleAnswer({ rows: [{ ...CLASS, sessions: [] }], studentClassDate: "8/22/2026", nowMs: NOW })
    .kind === "handoff",
  "a class with no sessions hands off"
);

// --- date shapes: the school writes 8/15/2026; a dealer may type 2026-08-15 ---
for (const [a, b] of [["8/22/2026", "2026-08-22"], ["08/22/2026", "8/22/2026"], ["8/22/26", "8/22/2026"]] as const) {
  ok(S.normalizeClassDate(a) === S.normalizeClassDate(b), `${a} and ${b} are the same class`);
}
ok(decide({ studentClassDate: "2026-08-22" }).kind === "answer", "an ISO date on the student still matches the table");
ok(S.normalizeClassDate("next Saturday") === "", "prose is not a date");
ok(S.normalizeClassDate(null) === "", "null is not a date");
ok(decide({ nowMs: Number.NaN }).kind === "handoff", "an unusable clock hands off");

// --- the fail direction, stated once: this module can only ever REPLACE a hand-off with a given fact
ok(
  ["answer", "handoff"].includes(decide({ rows: [{}] as never }).kind),
  "a junk row never throws — it degrades to a decision"
);
ok(decide({ rows: [{}] as never }).kind === "handoff", "and that decision is hand-off");

// ---------------------------------------------------------------------------
// THE REPLY — the live defect this fixes, and it needs no schedule data
// ---------------------------------------------------------------------------
const ask = (over: Record<string, unknown> = {}) =>
  S.resolveRiderCourseLogisticsReply({
    intent: "enrolled_class_logistics",
    firstName: "Maya",
    rows: [],
    studentClassDate: "8/15/2026",
    nowMs: NOW,
    ...over
  });

// TODAY: no table configured. This is the state that ships.
const handoff = ask();
ok(handoff.handled === true, "a class-logistics question is handled here, not by the sign-up branch");
ok(handoff.needsTodo === true, "and raises a task — the promise of a person has to be made true");
ok(/I don't want to guess/.test(handoff.reply), "the hand-off says plainly that it will not guess");
ok(handoff.reply.startsWith("Good question, Maya"), "uses the customer's name when we have it");
// The whole point: no price, no sign-up copy, and no invented logistics.
ok(!/\$|price|sign up|best place to start/i.test(handoff.reply), "never quotes the price at an enrolled student");
ok(
  !/bring|helmet|gloves|boots|park|arrive|[0-9]{1,2}\s*(am|pm)/i.test(handoff.reply),
  "and never invents gear, a place or a time"
);
// Portability: no dealer-specific job title baked into the copy.
ok(!/Riding Academy Manager|American Harley/i.test(handoff.reply), "copy is dealer-agnostic");
ok(ask({ firstName: null }).reply.startsWith("Good question -"), "reads correctly with no name");

// Everything that is NOT a class-logistics question must be untouched.
for (const intent of ["rider_course_info", "first_time_rider", "beginner_bike_advice", "no_motorcycle_endorsement", "none"]) {
  const r = ask({ intent });
  ok(r.handled === false, `${intent} is left to its existing branch`);
  ok(r.reply === "" && r.needsTodo === false, `${intent} produces nothing here`);
}
ok(ask({ intent: "none", asksClassLogistics: true }).handled === true, "the boolean alone is enough to catch it");

// IF a feed ever fills the table: the same call answers, with no other change.
const fed = ask({ rows: [CLASS], studentClassDate: "8/22/2026" });
ok(fed.handled === true && fed.needsTodo === false, "a confirmed class answers and needs no task");
ok(/8:00 AM/.test(fed.reply) && /front parking lot/.test(fed.reply), "states the first day from the row");
ok(/Niagara Wheatfield/.test(fed.reply), "and the range day, which is a different place");
// ...and if that feed goes stale, it reverts to the hand-off rather than serving old times.
const stale = ask({ rows: [{ ...CLASS, updatedAt: ago(45) }], studentClassDate: "8/22/2026" });
ok(stale.needsTodo === true && /I don't want to guess/.test(stale.reply), "a stale feed reverts to a person");

// ---------------------------------------------------------------------------
// THE WIRING — checked BEFORE the sign-up branch, in the shared builder
// ---------------------------------------------------------------------------
const fs = await import("node:fs");
const api = fs.readFileSync(new URL("../services/api/src/index.ts", import.meta.url), "utf8");

ok(
  api.includes('import { resolveRiderCourseLogisticsReply } from "./domain/riderCourseSchedule.js";'),
  "index.ts imports the resolver"
);
const callIdx = api.indexOf("const classLogistics = resolveRiderCourseLogisticsReply({");
const signupIdx = api.indexOf('if (parsed.intent === "rider_course_info" || parsed.asksRiderCourse) {');
ok(callIdx > 0, "the shared guidance builder calls it");
ok(
  callIdx < signupIdx,
  "and calls it BEFORE the rider_course_info branch — otherwise the price answer wins and nothing changes"
);
ok(
  /if \(classLogistics\.handled\) return classLogistics\.reply;/.test(api),
  "the result is consumed — a decision nothing returns is the bug, not the fix"
);
ok(
  api.split("resolveRiderCourseLogisticsReply(").length - 1 === 1,
  "exactly ONE call site — both reply paths reach it through the one shared builder, so they cannot drift"
);
// The task must fire wherever the hand-off can, in BOTH paths (route-parity law).
ok(
  api.split("Riding Academy student asked about their class").length - 1 === 2,
  "the task is raised at BOTH call sites — live and regenerate"
);
ok(
  /studentClassDate: readRidingAcademyRecordFields\(conv\.lead\?\.inquiry\)\.startDate/.test(api),
  "the student's own class date is threaded in, so a feed could match their class"
);

console.log(`rider_course_schedule_eval: PASS (${n} assertions)`);
