/**
 * Department-handoff SOFT-CLOSE + NUDGE eval (pure, no LLM).
 *
 * Policy (Joe, 2026-06-24): a service/parts/apparel handoff task where the department RESPONDED but the
 * customer hasn't booked (Danny Bostic: "we're booking into the last week of July" — not_fulfilled, no
 * appointment) should SOFT-CLOSE (snooze out of the urgent inbox) and NUDGE — re-surface as a staff
 * follow-up at the window if still un-booked. No customer message. Re-uses the snooze primitive.
 *
 * Layers:
 *  1) Pure decision table — decideDepartmentTaskSoftClose: the soft-close case + the shadow case + every
 *     exclusion (not-open / already-soft-closed / not-a-dept-task / booked / no-verdict / fulfilled /
 *     not-engaged-pending / below-confidence). Plus parts + apparel eligibility.
 *  2) Nudge-date math — computeSoftCloseNudgeAt clamps to [now+2d, now+45d]; quoted-wait wins when sane,
 *     else +3 business days; addBusinessDays skips weekends.
 *  3) Source guard — the classifier exposes engaged_pending_customer + defer_until; index.ts wires the
 *     decision + snooze + the soft-close marker into the auto-close hook; the flag ships DARK.
 *
 * Run: npx tsx scripts/department_task_soft_close_eval.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  decideDepartmentTaskSoftClose,
  computeSoftCloseNudgeAt,
  addBusinessDays,
  isDepartmentHandoffTask,
  isDepartmentTaskSoftCloseEnabled,
  TASK_SOFT_CLOSE_MIN_CONFIDENCE,
  type TaskFulfillmentVerdict
} from "../services/api/src/domain/taskFulfillmentAutoClose.ts";

const NOW = new Date("2026-06-24T12:00:00.000Z"); // a Wednesday

const verdict = (over: Partial<TaskFulfillmentVerdict>): TaskFulfillmentVerdict => ({
  taskId: "t1",
  fulfilled: false,
  confidence: 0.9,
  engagedPendingCustomer: true,
  deferUntil: null,
  ...over
});

// --- 1) Decision table. ---
type Case = {
  id: string;
  enabled: boolean;
  task: { status?: string; reason?: string; autoSoftCloseAt?: string };
  verdict: TaskFulfillmentVerdict | null;
  booked?: boolean;
  softClose: boolean;
  reason: string;
  nudge: boolean; // whether nudgeAt should be set
};
const cases: Case[] = [
  // The soft-close: enabled + open service task + engaged-pending + confident + not booked.
  { id: "service_soft_close", enabled: true, task: { status: "open", reason: "service" }, verdict: verdict({}), softClose: true, reason: "engaged_pending_soft_close", nudge: true },
  { id: "parts_soft_close", enabled: true, task: { status: "open", reason: "parts" }, verdict: verdict({}), softClose: true, reason: "engaged_pending_soft_close", nudge: true },
  { id: "apparel_soft_close", enabled: true, task: { status: "open", reason: "apparel" }, verdict: verdict({}), softClose: true, reason: "engaged_pending_soft_close", nudge: true },
  // Shadow (flag off): would soft-close, nudgeAt computed, but softClose=false.
  { id: "shadow_would_soft_close", enabled: false, task: { status: "open", reason: "service" }, verdict: verdict({}), softClose: false, reason: "shadow_would_soft_close", nudge: true },
  // Exclusions:
  { id: "not_open", enabled: true, task: { status: "done", reason: "service" }, verdict: verdict({}), softClose: false, reason: "not_open", nudge: false },
  { id: "already_soft_closed", enabled: true, task: { status: "open", reason: "service", autoSoftCloseAt: "2026-06-20T00:00:00Z" }, verdict: verdict({}), softClose: false, reason: "already_soft_closed", nudge: false },
  { id: "not_department_task", enabled: true, task: { status: "open", reason: "call" }, verdict: verdict({}), softClose: false, reason: "not_department_task", nudge: false },
  { id: "already_booked", enabled: true, task: { status: "open", reason: "service" }, verdict: verdict({}), booked: true, softClose: false, reason: "already_booked", nudge: false },
  { id: "no_verdict", enabled: true, task: { status: "open", reason: "service" }, verdict: null, softClose: false, reason: "no_verdict", nudge: false },
  { id: "fulfilled_closes_instead", enabled: true, task: { status: "open", reason: "service" }, verdict: verdict({ fulfilled: true }), softClose: false, reason: "fulfilled_closes_instead", nudge: false },
  { id: "not_engaged_pending", enabled: true, task: { status: "open", reason: "service" }, verdict: verdict({ engagedPendingCustomer: false }), softClose: false, reason: "not_engaged_pending", nudge: false },
  { id: "below_confidence", enabled: true, task: { status: "open", reason: "service" }, verdict: verdict({ confidence: 0.6 }), softClose: false, reason: "below_confidence", nudge: false }
];

for (const c of cases) {
  const got = decideDepartmentTaskSoftClose({
    enabled: c.enabled,
    task: c.task,
    verdict: c.verdict,
    appointmentBooked: !!c.booked,
    now: NOW
  });
  assert.equal(got.softClose, c.softClose, `decide[${c.id}] softClose expected ${c.softClose}, got ${got.softClose}`);
  assert.equal(got.reason, c.reason, `decide[${c.id}] reason expected ${c.reason}, got ${got.reason}`);
  assert.equal(got.nudgeAt != null, c.nudge, `decide[${c.id}] nudgeAt presence expected ${c.nudge}`);
}

// Confidence bar: exactly the floor soft-closes, just under does not.
assert.equal(
  decideDepartmentTaskSoftClose({ enabled: true, task: { status: "open", reason: "service" }, verdict: verdict({ confidence: TASK_SOFT_CLOSE_MIN_CONFIDENCE }), appointmentBooked: false, now: NOW }).softClose,
  true,
  "at the confidence floor -> soft-close"
);
assert.equal(
  decideDepartmentTaskSoftClose({ enabled: true, task: { status: "open", reason: "service" }, verdict: verdict({ confidence: TASK_SOFT_CLOSE_MIN_CONFIDENCE - 0.01 }), appointmentBooked: false, now: NOW }).reason,
  "below_confidence",
  "just under the floor -> below_confidence"
);

// --- 2) Nudge-date math. ---
// +3 business days from Wed 6/24 = Mon 6/29 (skips Sat/Sun).
assert.equal(addBusinessDays(NOW, 3).toISOString(), "2026-06-29T12:00:00.000Z", "+3 business days skips the weekend");
// A sane quoted wait inside the window wins.
assert.equal(computeSoftCloseNudgeAt("2026-07-10", NOW), new Date("2026-07-10").toISOString(), "quoted wait inside window is used");
// Too soon (today) -> default +3 business days.
assert.equal(computeSoftCloseNudgeAt("2026-06-24", NOW), "2026-06-29T12:00:00.000Z", "too-soon quote -> default window");
// Past -> default window.
assert.equal(computeSoftCloseNudgeAt("2026-06-01", NOW), "2026-06-29T12:00:00.000Z", "past quote -> default window");
// Absurd far-future -> clamped to now+45d (2026-08-08).
assert.equal(computeSoftCloseNudgeAt("2026-12-31", NOW), new Date(NOW.getTime() + 45 * 86_400_000).toISOString(), "far-future quote clamped to +45d");
// Empty / null -> default window.
assert.equal(computeSoftCloseNudgeAt("", NOW), "2026-06-29T12:00:00.000Z", "no quote -> default window");
assert.equal(computeSoftCloseNudgeAt(null, NOW), "2026-06-29T12:00:00.000Z", "null quote -> default window");

// isDepartmentHandoffTask
for (const r of ["service", "parts", "apparel", "SERVICE"]) assert.equal(isDepartmentHandoffTask({ reason: r }), true, `${r} is a dept handoff`);
for (const r of ["call", "note", "pricing", "approval", ""]) assert.equal(isDepartmentHandoffTask({ reason: r }), false, `${r} is not a dept handoff`);

// Flag ships DARK.
assert.equal(isDepartmentTaskSoftCloseEnabled(), false, "DEPARTMENT_TASK_SOFT_CLOSE_NUDGE defaults OFF");

// --- 3) Source guards. ---
const llm = fs.readFileSync("services/api/src/domain/llmDraft.ts", "utf8");
assert.ok(/engaged_pending_customer/.test(llm) && /defer_until/.test(llm), "the fulfillment classifier must expose engaged_pending_customer + defer_until");
const index = fs.readFileSync("services/api/src/index.ts", "utf8");
assert.ok(/decideDepartmentTaskSoftClose\(/.test(index), "index.ts must call decideDepartmentTaskSoftClose in the auto-close hook");
assert.ok(/isDepartmentTaskSoftCloseEnabled\(\)/.test(index), "the soft-close must be gated by the dark flag");
assert.ok(/setTodoAutoSoftClose\(/.test(index) && /snoozeTodo\(conv\.id, task\.id, soft\.nudgeAt\)/.test(index), "index.ts must snooze (soft-close) + mark the task on a soft-close");
assert.ok(/task_autoclose\.soft_closed/.test(index), "index.ts must record the soft-close decision trace");

console.log(`PASS department-task soft-close + nudge eval — ${cases.length} decision cases + nudge-date math + source guards`);
