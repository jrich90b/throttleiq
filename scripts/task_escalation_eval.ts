/**
 * Task escalation eval — manager digest for rep task cards waiting past the
 * threshold during business hours (competitive parity with the 50-minute
 * manager ping, 2026-06-11). Decision logic is pure in
 * domain/taskEscalation.ts; this exercises it directly and pins the wiring.
 */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";

const {
  buildEscalationDigest,
  isClockWithinBusinessHours,
  parseBusinessMinutes,
  resolveEscalationCandidates
} = await import("../services/api/src/domain/taskEscalation.ts");

const nowMs = Date.parse("2026-06-12T15:00:00.000Z"); // 11:00 ET
const openClock = { minutesSinceMidnight: 11 * 60, openMinutes: 9 * 60, closeMinutes: 18 * 60 };

const mkTodo = (over: any = {}): any => ({
  id: over.id ?? "t1",
  convId: over.convId ?? "+1",
  leadKey: over.convId ?? "+1",
  reason: "call",
  summary: "Call customer to follow up on the Street Glide.",
  createdAt: new Date(nowMs - 2 * 60 * 60 * 1000).toISOString(),
  status: "open",
  ...over
});

// Waiting 2h with a 60-minute threshold during open hours: escalate.
const basic = resolveEscalationCandidates({ todos: [mkTodo()], nowMs, clock: openClock });
assert.equal(basic.length, 1, "stale open task escalates during business hours");
assert.ok(basic[0].waitingMinutes >= 119, `waited ~2h, got ${basic[0].waitingMinutes}m`);

// Outside business hours: never ping the manager.
const closedClock = { minutesSinceMidnight: 23 * 60, openMinutes: 9 * 60, closeMinutes: 18 * 60 };
assert.equal(
  resolveEscalationCandidates({ todos: [mkTodo()], nowMs, clock: closedClock }).length,
  0,
  "no escalations outside business hours"
);
assert.equal(
  resolveEscalationCandidates({
    todos: [mkTodo()],
    nowMs,
    clock: { minutesSinceMidnight: 11 * 60, openMinutes: null, closeMinutes: null }
  }).length,
  0,
  "no escalations on closed days"
);

// A task created overnight starts its clock at opening time.
const justOpened = { minutesSinceMidnight: 9 * 60 + 30, openMinutes: 9 * 60, closeMinutes: 18 * 60 };
const overnight = mkTodo({ createdAt: new Date(nowMs - 14 * 60 * 60 * 1000).toISOString() });
assert.equal(
  resolveEscalationCandidates({ todos: [overnight], nowMs, clock: justOpened }).length,
  0,
  "overnight task waits the threshold from opening, not from creation"
);

// Exclusions: notes, done tasks, already-escalated, future-due, stale legacy.
assert.equal(
  resolveEscalationCandidates({
    todos: [
      mkTodo({ reason: "note" }),
      mkTodo({ id: "t2", status: "done" }),
      mkTodo({ id: "t3", escalatedAt: "2026-06-12T13:00:00.000Z" }),
      mkTodo({ id: "t4", dueAt: new Date(nowMs + 60 * 60 * 1000).toISOString() }),
      mkTodo({ id: "t5", createdAt: new Date(nowMs - 80 * 60 * 60 * 1000).toISOString() })
    ],
    nowMs,
    clock: openClock
  }).length,
  0,
  "notes, done, escalated, not-yet-due, and legacy tasks are excluded"
);

// A reminder due 90 minutes ago escalates even if created days ago... within lookback.
const dueReminder = mkTodo({
  id: "t6",
  createdAt: new Date(nowMs - 40 * 60 * 60 * 1000).toISOString(),
  dueAt: new Date(nowMs - 90 * 60 * 1000).toISOString(),
  taskClass: "reminder"
});
const reminderResult = resolveEscalationCandidates({ todos: [dueReminder], nowMs, clock: openClock });
assert.equal(reminderResult.length, 1, "past-due reminder escalates");
assert.ok(reminderResult[0].waitingMinutes <= 91, "reminder clock anchors at dueAt, not createdAt");

// Digest copy: named, owner-attributed, capped.
const digest = buildEscalationDigest(
  [
    { todo: mkTodo({ ownerName: "Giovanni Boccabella" }), waitingMinutes: 125 },
    { todo: mkTodo({ id: "t7", convId: "+2", ownerName: "" }), waitingMinutes: 61 }
  ],
  new Map([["+1", "Garrett Castle"]]),
  60
);
assert.match(digest, /2 tasks have been waiting over 60 min/);
assert.match(digest, /Garrett Castle \(2h 5m, Giovanni Boccabella\)/);
assert.match(digest, /\+2 \(1h 1m, unassigned\)/);

// Helpers.
assert.equal(parseBusinessMinutes("09:00"), 540);
assert.equal(parseBusinessMinutes(""), null);
assert.equal(isClockWithinBusinessHours(openClock), true);
assert.equal(isClockWithinBusinessHours(closedClock), false);

// Wiring pins: tick registration in both runners + worker schedule + dispatch.
const apiSource = await fs.readFile(path.resolve("services/api/src/index.ts"), "utf8");
assert.match(apiSource, /"task-escalations": \(\) => processTaskEscalations\(\)/, "worker dispatch entry");
assert.match(
  apiSource,
  /runBackgroundTask\("task-escalations", processTaskEscalations\)/,
  "in-process tick registration"
);
assert.match(apiSource, /markTodoEscalated\(todo\.id\)/, "escalated todos are marked so they never repeat");
assert.match(apiSource, /TASK_ESCALATION_ENABLED/, "kill switch exists");
const workerTasks = await fs.readFile(path.resolve("services/api/src/domain/workerTasks.ts"), "utf8");
assert.match(workerTasks, /"task-escalations"/, "worker tick task registered");
const workerCfg = await fs.readFile(path.resolve("services/worker/src/config.ts"), "utf8");
assert.match(workerCfg, /"task-escalations"/, "worker schedule includes escalations");

console.log("PASS task escalation eval");
