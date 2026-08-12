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
// EQUIPMENT — "are the motorcycles provided?" (Joe, 2026-08-12)
//
// Ulises HernandezPerez (+17167857284) asked "are the motorcycle provided or do we need to bring our
// own?" and Joe typed the answer himself eight minutes later: "Should be able to answer this.
// Motorcycles are provided. They are Harley-Davidson X350 RA's."
//
// The class TABLE could never have answered him — a schedule says when and where, never what is
// provided — so this is a separate fact, and it comes from the dealer profile.
// ---------------------------------------------------------------------------
const PROVIDES = "H-D X350 RAs";
const equip = (over: Record<string, unknown> = {}) =>
  ask({ classLogisticsTopic: "equipment", courseProvides: PROVIDES, ...over });

const answered = equip();
ok(answered.handled === true && answered.needsTodo === false, "with the fact on file we answer, no task needed");
ok(answered.reply.includes(PROVIDES), "and the answer states the dealer's own words");
ok(answered.reply.startsWith("Good news, Maya"), "using the customer's name when we have it");
ok(equip({ firstName: null }).reply.startsWith("Good news -"), "and reading correctly without one");
// It answers the question it was asked and nothing more — no invented gear list, no invented time.
ok(
  !/helmet|gloves|boots|jacket|wear|[0-9]{1,2}\s*(am|pm)/i.test(answered.reply),
  "states what is provided and invents nothing else"
);
ok(!/\$|price|sign up|best place to start/i.test(answered.reply), "and still never quotes the sign-up price");

// BOTH halves are required. Either one missing falls back to today's promise-a-person hand-off,
// which is the safe direction: never guess about somebody's class.
for (const over of [{ courseProvides: "" }, { courseProvides: null }, { courseProvides: "   " }]) {
  const r = equip(over);
  ok(/I don't want to guess/.test(r.reply) && r.needsTodo === true, "no dealer fact ⇒ hand off to a person");
  ok(!r.reply.includes(PROVIDES), "…and obviously never states a fact we do not hold");
}
// A SCHEDULE question must not be answered with the equipment fact — that is the bug this shape
// exists to prevent, and it is why the topic comes from the parser rather than the question's words.
const sched = ask({ classLogisticsTopic: "schedule", courseProvides: PROVIDES });
ok(!sched.reply.includes(PROVIDES), "a when/where question is never answered with what is provided");
ok(/I don't want to guess/.test(sched.reply), "it hands off, exactly as before");
// Same for "other", and for a parse that carries no topic at all (an older model, or a miss).
for (const topic of ["other", "", null, undefined, "EQUIPMENT_TYPO"]) {
  const r = ask({ classLogisticsTopic: topic, courseProvides: PROVIDES });
  ok(!r.reply.includes(PROVIDES), `topic ${String(topic)} does not unlock the equipment answer`);
  ok(/I don't want to guess/.test(r.reply), `topic ${String(topic)} keeps today's hand-off`);
}
// And a confirmed class table still answers the schedule question — equipment did not shadow it.
ok(
  /8:00 AM/.test(ask({ classLogisticsTopic: "schedule", courseProvides: PROVIDES, rows: [CLASS], studentClassDate: "8/22/2026" }).reply),
  "a fed schedule still answers a when/where question"
);

// ⚠️ PORTABILITY. The value is DEALER DATA and must never be a literal in the API source — the
// AH-literal ratchet only goes down, and this is the exact shape that raises it.
const srcFs = await import("node:fs");
const policySrc = srcFs.readFileSync(new URL("../services/api/src/domain/firstTimeRiderPolicy.ts", import.meta.url), "utf8");
const replySrc = srcFs.readFileSync(new URL("../services/api/src/domain/riderCourseSchedule.ts", import.meta.url), "utf8");
for (const [name, src] of [["firstTimeRiderPolicy", policySrc], ["riderCourseSchedule", replySrc]] as const) {
  const code = src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/.*$/gm, " ");
  ok(!/X350/i.test(code), `${name} carries no dealer bike model in CODE (comments may cite the report)`);
}

// ---------------------------------------------------------------------------
// THE WIRING — EXECUTED, not read. The shared builder is what the live path and the regenerate
// path both call, so running it here runs the real decision. (An earlier draft of this section
// asserted on index.ts source text; source text cannot prove a branch ordering actually holds,
// and it goes stale the moment the function is moved — which is exactly what happened.)
// ---------------------------------------------------------------------------
const R = await import("../services/api/src/domain/firstTimeRiderReply.ts");

/**
 * A dealer who HAS published sign-up facts — the configuration that produced the original bug.
 * KEY NAMES ARE THE REAL ONES read by readFirstTimeRiderPolicy (`riderCoursePrice`, not
 * `coursePrice`): with invented keys the price is blank, and every "never quotes the price"
 * assertion below passes because there is no price to quote. The fixture IS the measurement.
 */
const PROFILE_WITH_SIGNUP_COPY = {
  policies: {
    firstTimeRider: {
      riderCourseName: "Riding Academy course",
      riderCoursePrice: "$321",
      riderCourseUrl: "https://example-dealer.test/riding-academy"
    }
  }
};
const guidance = (parsed: Record<string, unknown>, text = "what do I need to bring to class?") =>
  R.buildFirstTimeRiderGuidanceReply({
    parsed: { explicitRequest: true, ...parsed } as never,
    dealerProfile: PROFILE_WITH_SIGNUP_COPY,
    text,
    firstName: "Maya",
    studentClassDate: null
  });

// The bug, reproduced through the real builder: an enrolled student asking about their class.
const enrolled = guidance({ intent: "enrolled_class_logistics", asksClassLogistics: true });
ok(!enrolled.includes("$321"), "an enrolled student is never quoted the sign-up price");
ok(!/best place to start/.test(enrolled), "and never gets the sign-up pitch");
ok(/I don't want to guess/.test(enrolled), "they get the hand-off instead");

// ORDERING, executed: a turn the sign-up branch would ALSO claim still hands off. If the
// class-logistics check ran after it, the price answer would win and nothing would change.
const both = guidance({ intent: "enrolled_class_logistics", asksClassLogistics: true, asksRiderCourse: true });
ok(/I don't want to guess/.test(both) && !both.includes("$321"), "class-logistics outranks the sign-up branch");

// ...and someone genuinely SIGNING UP is untouched: they still get the price.
const signup = guidance({ intent: "rider_course_info", asksRiderCourse: true }, "how much is the riding academy?");
ok(signup.includes("$321"), "a real sign-up question still gets the price");

// The ADF variant funnels into the same builder, so it inherits the same ordering.
const adfEnrolled = R.buildInitialAdfFirstTimeRiderGuidanceReply({
  parsed: { explicitRequest: true, intent: "enrolled_class_logistics", asksClassLogistics: true } as never,
  dealerProfile: PROFILE_WITH_SIGNUP_COPY,
  text: "what do I need to bring to class?"
});
ok(!adfEnrolled.includes("$321"), "the ADF first-touch variant does not quote the price either");

// The task that makes the hand-off's promise true.
ok(R.asksRiderCourseLogistics({ intent: "enrolled_class_logistics" }) === true, "the hand-off mints a staff task");
ok(R.asksRiderCourseLogistics({ intent: "none", asksClassLogistics: true }) === true, "the boolean alone is enough");
ok(R.asksRiderCourseLogistics({ intent: "rider_course_info" }) === false, "and no other intent does");
ok(R.asksRiderCourseLogistics(null) === false, "a missing decision mints nothing");
ok(/Riding Academy student/.test(R.RIDER_COURSE_LOGISTICS_TODO), "the task names the class, so staff know what to confirm");

// EQUIPMENT through the REAL builder, with the REAL profile key. ⚠️ `riderCourseProvides` is the key
// readFirstTimeRiderPolicy actually reads — with an invented key the fact is blank and every
// assertion below would pass against a hand-off. The fixture IS the measurement.
const PROFILE_WITH_PROVIDES = {
  policies: {
    firstTimeRider: {
      ...PROFILE_WITH_SIGNUP_COPY.policies.firstTimeRider,
      riderCourseProvides: "H-D X350 RAs"
    }
  }
};
const guidanceProvides = (parsed: Record<string, unknown>, text: string) =>
  R.buildFirstTimeRiderGuidanceReply({
    parsed: { explicitRequest: true, ...parsed } as never,
    dealerProfile: PROFILE_WITH_PROVIDES,
    text,
    firstName: "Ulises",
    studentClassDate: null
  });

// Ulises's real message, through the path the live webhook and regenerate both call.
const ulises = guidanceProvides(
  { intent: "enrolled_class_logistics", asksClassLogistics: true, classLogisticsTopic: "equipment" },
  "Hi, I'm so sorry to bother, question, are the motorcycle provided or do we need to bring our own? Thanks."
);
ok(ulises.includes("H-D X350 RAs"), "the enrolled student finally gets the answer");
ok(!ulises.includes("$321"), "…and still not the sign-up price");
ok(!/I don't want to guess/.test(ulises), "…and no longer a promise to get back to them");

// The same dealer, the same profile, a WHEN question: still a hand-off, because we hold no schedule.
const ulisesWhen = guidanceProvides(
  { intent: "enrolled_class_logistics", asksClassLogistics: true, classLogisticsTopic: "schedule" },
  "what time do I show up?"
);
ok(/I don't want to guess/.test(ulisesWhen) && !ulisesWhen.includes("X350"), "a when question is unchanged");

// A dealer who has NOT supplied the fact keeps today's behaviour, unchanged in every respect.
const noFact = guidance({ intent: "enrolled_class_logistics", asksClassLogistics: true, classLogisticsTopic: "equipment" });
ok(/I don't want to guess/.test(noFact), "a dealer without the fact still promises a person");

// The profile reader itself — the fact has to survive the read, and a blank one must stay blank.
const P = await import("../services/api/src/domain/firstTimeRiderPolicy.ts");
ok(P.readFirstTimeRiderPolicy(PROFILE_WITH_PROVIDES).courseProvides === "H-D X350 RAs", "the reader carries the fact");
ok(P.readFirstTimeRiderPolicy(PROFILE_WITH_SIGNUP_COPY).courseProvides === "", "and an unset fact reads blank");
ok(P.readFirstTimeRiderPolicy({}).courseProvides === "", "…as does a profile with no policies at all");

// The SHIPPED American Harley profile carries Joe's fact, or none of this reaches a customer.
const shipped = JSON.parse(
  srcFs.readFileSync(new URL("../services/api/data/dealer_profile.json", import.meta.url), "utf8")
);
ok(
  P.readFirstTimeRiderPolicy(shipped).courseProvides.length > 0,
  "the dealer profile actually carries what the class provides"
);

// Route-parity law: the task has to fire in BOTH paths. Only source can count call SITES.
const fs = await import("node:fs");
const api = fs.readFileSync(new URL("../services/api/src/index.ts", import.meta.url), "utf8");
ok(
  api.split("asksRiderCourseLogistics(").length - 1 === 2,
  "the predicate is CALLED exactly twice — live and regenerate (the import carries no paren)"
);
ok(
  api.split("RIDER_COURSE_LOGISTICS_TODO,").length - 1 === 2,
  "and both paths raise the SAME task text — one constant, so they cannot drift"
);
ok(
  api.split("readRidingAcademyRecordFields(conv.lead?.inquiry).startDate").length - 1 === 2,
  "the student's own class date is threaded in from both paths, so a feed could match their class"
);

console.log(`rider_course_schedule_eval: PASS (${n} assertions)`);
