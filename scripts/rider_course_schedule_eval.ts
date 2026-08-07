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

console.log(`rider_course_schedule_eval: PASS (${n} assertions)`);
