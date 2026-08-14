/**
 * Task due-date inheritance eval (pure, no LLM).
 *
 * Pins the "born overdue" Task Inbox bug, operator-reported twice on +17169400722
 * (Christopher Szczesny): "There was a task created and immediately was set to yesterday"
 * (8/12) and "Last message created a overdue task 2 days old" (2026-08-13 22:46Z).
 *
 * Mechanism: the todos endpoint (services/api/src/index.ts, the GET todos handler) stamps the
 * CONVERSATION's `appointmentWhenIso` onto EVERY task on that lead as row context. `taskTriage`
 * then fell through to it as a last-resort due date for ANY task class, so a "needs YOUR reply"
 * todo minted at 22:31 on 8/13 inherited that lead's Aug 11 9:30 AM appointment and rendered
 * "Overdue · 2 days ago" the instant it existed. The other direction is the same defect: a task
 * on a lead booked NEXT week gets dated into the future and sinks below today's real work.
 *
 * Measured on the live americanharley store 2026-08-14: 133 tasks minted into the inherited
 * bucket in 30d (51 born overdue, 82 future-dated); 3 open at the time of the fix, 2 of them
 * rendering falsely Overdue — including the exact task Joe reported.
 *
 * Layers:
 *   1. taskEffectiveDueMs — an appointment-class task still anchors to its event time; every
 *      other class ignores the lead's appointment and falls back only to its own dueAt/reminderAt.
 *   2. dueBucketFor — the reported artifact end to end: the real task shape must read `no_date`,
 *      never `overdue`.
 *   3. Cross-surface agreement — the console's overdue rule must match the API's, which counts
 *      only `dueAt` (services/api/src/domain/copilotInsights.ts).
 *
 * Run: npx tsx scripts/task_due_inheritance_eval.ts
 */
import { strict as assert } from "node:assert";

const { taskEffectiveDueMs, dueBucketFor } = await import("../apps/web/src/app/lib/taskTriage.ts");

// Pinned clock: the moment Joe filed the report. Never Date.now() — a wall-clock read makes this
// eval's verdict depend on the hour it runs (see the midnight-red trap).
const NOW = Date.parse("2026-08-13T22:46:18.029Z");

const PAST_APPT = "2026-08-11T13:30:00.000Z"; // the lead's real appointment — 2 days before NOW
const FUTURE_APPT = "2026-08-15T17:00:00.000Z"; // a lead booked later this week

// --- 1) The exact reported row: todo_6c6eeee7c1ad7, minted 22:31:12Z, no date of its own. ---
const reported = {
  taskClass: "todo",
  dueAt: null,
  reminderAt: null,
  appointmentWhenIso: PAST_APPT
};
assert.equal(
  taskEffectiveDueMs(reported),
  null,
  "a `todo` with no dueAt/reminderAt must NOT inherit the lead's appointment as its due time"
);
assert.equal(
  dueBucketFor(reported, NOW),
  "no_date",
  "the reported task must read no_date — it was rendering Overdue by 2 days"
);

// --- 2) The other direction: a future appointment must not date the task either. ---
const futureDated = { taskClass: "followup", dueAt: null, reminderAt: null, appointmentWhenIso: FUTURE_APPT };
assert.equal(taskEffectiveDueMs(futureDated), null, "a followup must not inherit a FUTURE appointment either");
assert.equal(
  dueBucketFor(futureDated, NOW),
  "no_date",
  "inheriting a future appointment sank fresh work below today's list — it must read no_date"
);

// Every non-appointment class behaves the same way; `appointment` is the only anchored one.
for (const cls of ["todo", "followup", "reminder", "", "unknown_future_class"]) {
  assert.equal(
    taskEffectiveDueMs({ taskClass: cls, dueAt: null, reminderAt: null, appointmentWhenIso: PAST_APPT }),
    null,
    `taskClass "${cls}" must not be appointment-anchored`
  );
}

// --- 3) The appointment task itself is UNCHANGED — it is genuinely anchored to its event. ---
assert.equal(
  taskEffectiveDueMs({ taskClass: "appointment", dueAt: null, reminderAt: null, appointmentWhenIso: PAST_APPT }),
  Date.parse(PAST_APPT),
  "an appointment task still anchors to its event time"
);
assert.equal(
  dueBucketFor({ taskClass: "appointment", appointmentWhenIso: PAST_APPT }, NOW),
  "overdue",
  "a missed appointment must still read overdue — this fix must not hide real overdue appointments"
);
assert.equal(
  taskEffectiveDueMs({ taskClass: "APPOINTMENT", appointmentWhenIso: PAST_APPT }),
  Date.parse(PAST_APPT),
  "the class match is case-insensitive"
);
// An appointment task with its OWN dueAt keeps preferring the event time (unchanged precedence).
assert.equal(
  taskEffectiveDueMs({
    taskClass: "appointment",
    dueAt: "2026-08-01T12:00:00.000Z",
    appointmentWhenIso: PAST_APPT
  }),
  Date.parse(PAST_APPT),
  "an appointment task prefers its event time over a stamped dueAt"
);

// --- 4) A task's OWN date is still honoured, for every class. ---
assert.equal(
  taskEffectiveDueMs({ taskClass: "todo", dueAt: "2026-08-13T12:00:00.000Z", appointmentWhenIso: FUTURE_APPT }),
  Date.parse("2026-08-13T12:00:00.000Z"),
  "an explicit dueAt wins over the lead's appointment"
);
assert.equal(
  dueBucketFor({ taskClass: "todo", dueAt: "2026-08-12T12:00:00.000Z" }, NOW),
  "overdue",
  "a genuinely past-due task must still read overdue"
);
assert.equal(
  taskEffectiveDueMs({ taskClass: "reminder", reminderAt: "2026-08-14T12:00:00.000Z", appointmentWhenIso: PAST_APPT }),
  Date.parse("2026-08-14T12:00:00.000Z"),
  "a reminder's own reminderAt wins over the lead's appointment"
);
// NB: assert only TZ-independent buckets here. `dueBucketFor`'s today/this_week boundary is the
// LOCAL end-of-day, so a fixed ISO instant lands in different buckets on different machines;
// `overdue` (due < now) and `no_date` are the two that are stable everywhere.
assert.notEqual(
  dueBucketFor({ taskClass: "reminder", reminderAt: "2026-08-14T12:00:00.000Z" }, NOW),
  "overdue",
  "a future reminder must not read overdue"
);

// --- 5) Cross-surface agreement with the API's overdue rule (copilotInsights counts dueAt only). ---
// Same fixture set, both rules: the console must not call anything overdue that the API would not.
const apiOverdue = (t: { dueAt?: string | null }) => {
  const ms = Date.parse(String(t.dueAt ?? ""));
  return Number.isFinite(ms) && ms < NOW;
};
const fixtures = [
  reported,
  futureDated,
  { taskClass: "todo", dueAt: "2026-08-12T12:00:00.000Z", appointmentWhenIso: PAST_APPT },
  { taskClass: "followup", dueAt: null, reminderAt: null, appointmentWhenIso: null }
];
for (const t of fixtures) {
  const consoleOverdue = dueBucketFor(t as any, NOW) === "overdue";
  assert.equal(
    consoleOverdue,
    apiOverdue(t as any),
    `console and API must agree on overdue for ${JSON.stringify(t)}`
  );
}

console.log("PASS task_due_inheritance_eval — appointment context no longer dates unrelated tasks");
