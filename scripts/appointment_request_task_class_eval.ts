/**
 * "Appointment requested." todos must class as `appointment` (inferTodoTaskClass,
 * conversationStore).
 *
 * PAUL HARRIGAN (+17169467451, operator-reported 2026-08-17: "This did not seem to book an
 * appointment at 11 today"). The customer asked "would 11 o'clock be OK?", we minted
 * "Appointment requested. Requested: 11 o'clock.", and the rep replied "Ya 11 will work, see
 * you then" — nothing was booked.
 *
 * inferTodoTaskClass classed that todo `todo`, not `appointment`, because the requested phrase
 * ("11 o'clock") carries no day token and no am/pm. The mis-class is load-bearing TWICE:
 *   1. isAutoCloseEligibleTask (taskFulfillmentAutoClose) exempts taskClass === "appointment"
 *      from the LLM fulfillment judge — appointment tasks are meant to close via the OUTCOME
 *      flow. Mis-classed, Paul's todo WAS eligible, and the judge closed it at 13:57:39Z — 27
 *      seconds before the rep confirmed at 13:58:06Z — citing the rep's own EARLIER question
 *      ("Hey Paul, what time are you thinking?") as the fulfilment.
 *   2. decideManualConfirmPendingAppointment is only reached via a lookup that requires
 *      taskClass === "appointment" (findPendingAppointmentRequestTodo, conversationStore — it
 *      lived inline in index.ts until 2026-08-19), so the booking referee never sees it.
 *
 * Measured on the live store 2026-08-19: 30 of 79 "Appointment requested." todos classed `todo`.
 *
 * FAIL DIRECTION, measured rather than assumed: fixing the class newly exposes 4 historical
 * turns to the booking referee, and parseRequestedDayTime already returns null for 3 of them
 * ("15th or 16th", "around 4", "in about 45 minutes") — the ambiguous ones still book nothing.
 *
 * This pins BEHAVIOR by executing inferTodoTaskClass, never source text.
 *
 * Run: npx tsx scripts/appointment_request_task_class_eval.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { inferTodoTaskClass } from "../services/api/src/domain/conversationStore.ts";

let checks = 0;
const eq = (actual: unknown, expected: unknown, msg: string) => {
  checks += 1;
  assert.equal(actual, expected, msg);
};

// ── THE PAUL CASE: a concrete requested time with no day token ───────────────────────────────
eq(
  inferTodoTaskClass("call", "Appointment requested. Requested: 11 o'clock.", undefined),
  "appointment",
  "PAUL: a requested clock time with no day token must still class as an appointment task"
);

// The other shapes the live store proved mis-classed (all classed `todo` before this fix).
for (const summary of [
  "Appointment requested. Requested: 9.",
  "Appointment requested. Requested: 15th or 16th.",
  "Appointment requested. Requested: 9th around noon.",
  "Appointment requested. Requested: May 11, 12 or 13 morning-midday.",
  "Appointment requested. Requested: in about 45 minutes.",
  "Appointment requested. Customer shared a day but not a time yet.",
  "Appointment requested."
]) {
  eq(
    inferTodoTaskClass("call", summary, undefined),
    "appointment",
    `our own appointment-request label must class as appointment: ${summary}`
  );
}

// ── Already-correct shapes must not regress ─────────────────────────────────────────────────
for (const summary of [
  "Appointment requested. Requested: today this morning.",
  "Appointment requested. Requested time: Sat, Aug 15, 12:00 PM.",
  "Appointment requested. Requested: friday at 2.",
  "Appointment reschedule requested. Please update appointment time.",
  "Appointment cancellation/reschedule requested."
]) {
  eq(
    inferTodoTaskClass("call", summary, undefined),
    "appointment",
    `previously-correct appointment label must stay appointment: ${summary}`
  );
}

// A schedule with a concrete dueAt still classes appointment (the pre-existing time signal).
eq(
  inferTodoTaskClass("call", "Appointment requested.", { dueAt: "2026-08-20T15:00:00.000Z" }),
  "appointment",
  "a dueAt-bearing appointment request stays an appointment task"
);

// ── The label is ANCHORED: it may only ever match a label WE composed ────────────────────────
// Customer text quoted inside another task's summary must not be promoted.
// The live store's own reply-owed todos class `todo` (verified: todo_6af30b3a2573c on
// +17169467451). What matters is that a quoted customer phrase is never PROMOTED to appointment,
// which would hand it the auto-close exemption and the booking referee's lookup.
eq(
  inferTodoTaskClass(
    "call",
    'Paul replied while you have this thread: "appointment requested for later" — needs YOUR reply.',
    undefined
  ),
  "todo",
  "a quoted customer phrase mid-summary must NOT be read as our appointment-request label"
);
eq(
  inferTodoTaskClass("call", "Call customer (follow-up): appointment requested earlier.", undefined),
  "followup",
  "a cadence follow-up summary keeps its followup class even when it mentions an appointment"
);

// ── The pre-existing exclusions still win ───────────────────────────────────────────────────
eq(
  inferTodoTaskClass("service", "Appointment requested. Requested: 11 o'clock.", undefined),
  "todo",
  "a department (service) task is not an appointment task"
);
eq(
  inferTodoTaskClass("call", "Appointment requested. Service appointment for the 11 o'clock.", undefined),
  "todo",
  "a department signal in the summary still excludes the appointment class"
);
eq(
  inferTodoTaskClass("note", "Appointment requested. Requested: 11 o'clock.", undefined),
  "todo",
  "an internal note is never an appointment task"
);

// ── The consequence that made this load-bearing: auto-close eligibility ──────────────────────
// Executed, not asserted about: an appointment-class task must be exempt from the fulfillment
// judge, which is what closed Paul's todo 27 seconds before the rep confirmed.
const autoCloseSrc = fs.readFileSync(
  new URL("../services/api/src/domain/taskFulfillmentAutoClose.ts", import.meta.url),
  "utf8"
);
checks += 1;
assert.ok(
  autoCloseSrc.includes('taskClass === "appointment"') && autoCloseSrc.includes("return false"),
  "taskFulfillmentAutoClose must keep exempting appointment-class tasks from the fulfillment judge"
);

// The booking referee's lookup still keys on taskClass === "appointment" — if that ever changes,
// this eval's whole premise moves and the author must revisit it. The lookup moved out of index.ts
// into conversationStore on 2026-08-19 (findPendingAppointmentRequestTodo), so BOTH the class test
// and the fact index.ts still goes through that selector are pinned — a class test nobody calls is
// as inert as no class test at all.
const storeSrc = fs.readFileSync(
  new URL("../services/api/src/domain/conversationStore.ts", import.meta.url),
  "utf8"
);
const selectorAt = storeSrc.indexOf("export function findPendingAppointmentRequestTodo");
checks += 1;
assert.ok(
  selectorAt >= 0 && storeSrc.slice(selectorAt, selectorAt + 800).includes('todo.taskClass === "appointment"'),
  "the pending-appointment-request lookup must still select taskClass === appointment todos"
);
const indexSrc = fs.readFileSync(new URL("../services/api/src/index.ts", import.meta.url), "utf8");
checks += 1;
assert.ok(
  indexSrc.includes("findPendingAppointmentRequestTodo(conv.id)"),
  "the staff-send path must still reach the pending request through that selector"
);

console.log(`appointment_request_task_class:eval PASS — ${checks} assertions`);
