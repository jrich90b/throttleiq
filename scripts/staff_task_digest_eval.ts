/**
 * Weekly stale-task digest eval (2026-07-31, Joe ruling "Weekly to manager").
 *
 * WHY THIS EXISTS. The manager escalation ping watches a task for its first 48 hours and texts
 * ONCE. Measured on the live store: 30 of 41 open tasks (73%) were past that window, while 31% of
 * all cleared tasks historically took longer than 48h (median 6.9d, p90 28d). So a third of real
 * task work happens after the system has stopped asking, and the oldest open task was 34 days.
 *
 * Pins, in fail-direction order:
 *   1. selection — what counts as stale, unassigned tasks INCLUDED, notes excluded, oldest first;
 *   2. the send window — once per period, at opening, and UNKNOWN state SENDS (never skip a week);
 *   3. the copy — count, age, owner, and honest truncation;
 *   4. the wiring — registered as a worker tick on the minute lane, and the rep half deliberately
 *      NOT built (the console morning window already owns it).
 *
 * Run: npx tsx scripts/staff_task_digest_eval.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  buildStaleTaskDigest,
  localDayKey,
  selectStaleTasks,
  shouldSendDigestNow,
  MAX_DIGEST_LINES,
  STALE_TASK_DAYS
} from "../services/api/src/domain/staffTaskDigest.ts";

let n = 0;
const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 6, 31, 14, 0);
const daysAgo = (d: number) => new Date(NOW - d * DAY).toISOString();
const T = (over: any = {}) => ({
  id: `t_${Math.random().toString(36).slice(2)}`,
  convId: "+15550001111",
  leadKey: "+15550001111",
  reason: "call",
  summary: "Follow up with Nico — handed off (sell my bike review)",
  status: "open",
  taskClass: "followup",
  createdAt: daysAgo(10),
  ...over
}) as any;

// --- 1. SELECTION --------------------------------------------------------------------------------
{
  const todos = [
    T({ createdAt: daysAgo(34), summary: "oldest" }),
    T({ createdAt: daysAgo(10), summary: "stale" }),
    T({ createdAt: daysAgo(6), summary: "not yet stale" }),
    T({ createdAt: daysAgo(0), summary: "brand new" })
  ];
  const stale = selectStaleTasks(todos, NOW);
  assert.equal(stale.length, 2, "only tasks past the threshold are included");
  assert.equal(stale[0].todo.summary, "oldest", "oldest first — age is the finding");
  assert.equal(stale[0].ageDays, 34, "age in whole days");
  n += 3;

  // Exactly-at-threshold is stale (a 7-day-old task has been open a week).
  assert.equal(selectStaleTasks([T({ createdAt: daysAgo(STALE_TASK_DAYS) })], NOW).length, 1,
    "a task exactly at the threshold counts");
  assert.equal(selectStaleTasks([T({ createdAt: daysAgo(STALE_TASK_DAYS - 1) })], NOW).length, 0,
    "a task one day under does not");
  n += 2;

  // UNASSIGNED tasks are the whole point of a manager digest: they belong to no rep's morning
  // window, so if this filtered by owner they would be seen by nobody.
  const unassigned = selectStaleTasks([T({ ownerId: undefined, ownerName: undefined })], NOW);
  assert.equal(unassigned.length, 1, "an unassigned stale task is INCLUDED");
  n += 1;

  // Notes are informational cards, not jobs — same carve-out the escalation ping makes.
  assert.equal(selectStaleTasks([T({ reason: "note" })], NOW).length, 0, "internal notes excluded");
  // Closed work never resurfaces.
  assert.equal(selectStaleTasks([T({ status: "done" })], NOW).length, 0, "done tasks excluded");
  assert.equal(selectStaleTasks([T({ createdAt: "not-a-date" })], NOW).length, 0,
    "an undatable task cannot be aged, so it is not claimed as stale");
  assert.equal(selectStaleTasks([], NOW).length, 0, "empty input");
  assert.equal(selectStaleTasks(null, NOW).length, 0, "null input");
  n += 5;

  // The threshold is configurable and honoured.
  assert.equal(selectStaleTasks(todos, NOW, { staleDays: 30 }).length, 1, "a wider threshold narrows the list");
  n += 1;
}

// --- 2. THE SEND WINDOW --------------------------------------------------------------------------
{
  const open = { minutesSinceMidnight: 9 * 60 + 5, openMinutes: 9 * 60, closeMinutes: 15 * 60 };
  const beforeOpen = { ...open, minutesSinceMidnight: 7 * 60 };
  const closedDay = { minutesSinceMidnight: 10 * 60, openMinutes: null, closeMinutes: null };

  assert.equal(shouldSendDigestNow({ clock: open, periodKey: "2026-07-31", lastSentKey: null }), true,
    "sends at opening when nothing is recorded");
  assert.equal(shouldSendDigestNow({ clock: open, periodKey: "2026-07-31", lastSentKey: "2026-07-31" }), false,
    "does not send twice in the same period");
  assert.equal(shouldSendDigestNow({ clock: open, periodKey: "2026-07-31", lastSentKey: "2026-07-24" }), true,
    "a previous period's key does not suppress this one");
  assert.equal(shouldSendDigestNow({ clock: beforeOpen, periodKey: "2026-07-31", lastSentKey: null }), false,
    "never before the store opens");
  assert.equal(shouldSendDigestNow({ clock: closedDay, periodKey: "2026-07-31", lastSentKey: null }), false,
    "never on a day the store is closed");
  n += 5;

  // FAIL-DIRECTION: unknown state SENDS. A duplicate digest is a nuisance; a skipped week is the
  // exact failure this whole module exists to fix.
  assert.equal(shouldSendDigestNow({ clock: open, periodKey: "2026-07-31", lastSentKey: undefined }), true,
    "an unreadable marker sends rather than skipping");
  assert.equal(shouldSendDigestNow({ clock: open, periodKey: "2026-07-31", lastSentKey: "  " }), true,
    "a blank marker sends");
  // A missing period key is a runner bug, not a reason to text — that one fails closed.
  assert.equal(shouldSendDigestNow({ clock: open, periodKey: "", lastSentKey: null }), false,
    "no period key means we cannot record a send, so we do not send");
  n += 3;

  assert.equal(localDayKey({ year: 2026, month: 7, day: 31 }), "2026-07-31", "zero-padded day key");
  assert.equal(localDayKey({ year: 2026, month: 12, day: 5 }), "2026-12-05", "zero-padded month key");
  n += 2;
}

// --- 3. THE COPY ---------------------------------------------------------------------------------
{
  const names = new Map([["+15550001111", "Nico Alvarez"]]);
  const one = buildStaleTaskDigest(selectStaleTasks([T({ createdAt: daysAgo(34), ownerName: "Stone Giuga" })], NOW), names);
  assert.match(one, /1 task has been open more than 7 days/, "singular head");
  assert.match(one, /Nico Alvarez/, "names the lead, not just the phone number");
  assert.match(one, /34 days/, "leads with the age");
  assert.match(one, /Stone Giuga/, "names the owner so the manager knows who to ask");
  n += 4;

  const unowned = buildStaleTaskDigest(selectStaleTasks([T({ createdAt: daysAgo(9) })], NOW), new Map());
  assert.match(unowned, /unassigned/, "an ownerless task says so rather than showing a blank");
  assert.match(unowned, /\+15550001111/, "falls back to the lead key when no name is known");
  n += 2;

  const many = Array.from({ length: MAX_DIGEST_LINES + 5 }, (_, i) => T({ createdAt: daysAgo(10 + i) }));
  const big = buildStaleTaskDigest(selectStaleTasks(many, NOW), new Map());
  assert.match(big, new RegExp(`${MAX_DIGEST_LINES + 5} tasks have been open`), "the head states the TRUE total");
  assert.equal(big.split("\n").length, MAX_DIGEST_LINES + 2, "head + capped lines + one overflow line");
  assert.match(big, /…and 5 more in the console/, "truncation is disclosed, never silent");
  n += 3;

  // Nothing stale is not a message.
  assert.equal(buildStaleTaskDigest([], new Map()), "", "an empty backlog produces no SMS");
  n += 1;

  // A digest must never carry an opt-out footer or read as customer copy — it is internal.
  assert.ok(!/reply stop/i.test(big), "internal staff SMS carries no customer opt-out footer");
  n += 1;
}

// --- 4. THE WIRING -------------------------------------------------------------------------------
{
  const tasks = fs.readFileSync("services/api/src/domain/workerTasks.ts", "utf8");
  assert.match(tasks, /"staff-task-digests"/, "registered in WORKER_TICK_TASKS");
  const cfgSrc = fs.readFileSync("services/worker/src/config.ts", "utf8");
  assert.match(cfgSrc, /"staff-task-digests"/, "scheduled by the worker");
  // Cadence parity: the same lane as the other digest jobs, so a worker-driven tick behaves like
  // the in-process interval (the photo-delivery lesson from the 7/30 worker cutover).
  const minuteLane = cfgSrc.slice(cfgSrc.indexOf('queue: "tick-followups"'), cfgSrc.indexOf('queue: "tick-inventory"'));
  assert.ok(minuteLane.includes('"staff-task-digests"'), "on the minute lane beside task-escalations");
  const api = fs.readFileSync("services/api/src/index.ts", "utf8");
  assert.match(api, /"staff-task-digests": \(\) => processStaffTaskDigests\(\)/, "wired into the dispatch map");
  // 2026-08-14: the minute lane is data (WORKER_MINUTE_LANE_TASKS) iterated in one loop —
// in-process registration is lane membership, executed here.
assert.ok(
  ((await import("../services/api/src/domain/workerTasks.ts")).WORKER_MINUTE_LANE_TASKS as readonly string[]).includes("staff-task-digests"),
  "staff-task-digests is on the in-process minute lane"
);
  n += 5;

  // The rep half is deliberately NOT built — the console morning window already owns it, and a
  // daily rep SMS would duplicate a better surface. Pin the absence so nobody "completes" it.
  assert.ok(!/buildOwnerDailyDigest|selectOwnerDailyTasks/.test(api),
    "no per-rep daily SMS — apps/web morningDigest.ts is that surface");
  assert.ok(fs.existsSync("apps/web/src/app/lib/morningDigest.ts"),
    "the rep-facing morning window this defers to must still exist");
  n += 2;

  // Surfacing only: the digest path must never close, reassign, or silence a task.
  const runner = api.slice(api.indexOf("async function processStaffTaskDigests"), api.indexOf("Manager escalation digest for rep task cards"));
  assert.ok(!/status\s*=\s*["']done["']|doneAt|escalatedAt\s*=/.test(runner),
    "the weekly digest never mutates task state");
  n += 1;
}

console.log(`PASS staff task digest eval (${n} assertions)`);
