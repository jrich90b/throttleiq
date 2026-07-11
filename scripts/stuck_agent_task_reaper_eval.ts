import { strict as assert } from "node:assert";
import fs from "node:fs";

/**
 * stuck_agent_task_reaper:eval — a runner (esp. MDF portal) that DIED leaves its task pinned in
 * "running" forever; the mdf_portal_health sweep detects it but never clears it, so the same orphan
 * re-fires nightly (2026-07-10: one 3.5 days old, one 3 weeks old). selectStuckAgentTasks picks the
 * dead ones to fail. This pins its FAIL-SAFETY — the reaper must never race a live run.
 */

const { selectStuckAgentTasks, STUCK_AGENT_TASK_TIMEOUT_MIN } = await import(
  "../services/api/src/domain/agentTaskStore.ts"
);

const NOW = Date.parse("2026-07-10T12:00:00.000Z");
const minsAgo = (m: number) => new Date(NOW - m * 60000).toISOString();
const task = (over: any = {}) => ({ id: "t", status: "running", kind: "mdf_portal", updatedAt: minsAgo(9999), ...over });

// A genuinely stuck runner (days old) IS reaped.
{
  const stuck = selectStuckAgentTasks([task({ id: "orphan", updatedAt: minsAgo(60 * 24 * 3) })], { nowMs: NOW });
  assert.equal(stuck.length, 1, "3-day-old running task is stuck");
  assert.equal(stuck[0].id, "orphan", "returns the id");
  assert.ok(stuck[0].ageMinutes > 4000, "reports the age");
}

// FAIL-SAFE: a task within the run window is NEVER reaped (real MDF runs are minutes).
assert.equal(
  selectStuckAgentTasks([task({ updatedAt: minsAgo(5) })], { nowMs: NOW }).length,
  0,
  "a 5-minute-old running task is a plausible live run — never reaped"
);
assert.equal(
  selectStuckAgentTasks([task({ updatedAt: minsAgo(STUCK_AGENT_TASK_TIMEOUT_MIN - 1) })], { nowMs: NOW }).length,
  0,
  "just under the timeout → kept"
);
assert.equal(
  selectStuckAgentTasks([task({ updatedAt: minsAgo(STUCK_AGENT_TASK_TIMEOUT_MIN + 1) })], { nowMs: NOW }).length,
  1,
  "just over the timeout → reaped"
);

// FAIL-SAFE: only status==="running" is ever a candidate — a dead runner is the only source of a
// falsely-live task. Every other status is left untouched.
for (const status of ["queued", "needs_approval", "completed", "failed", "blocked"]) {
  assert.equal(
    selectStuckAgentTasks([task({ status, updatedAt: minsAgo(99999) })], { nowMs: NOW }).length,
    0,
    `status "${status}" is never reaped (only a stuck "running" is a dead runner)`
  );
}

// FAIL-SAFE: an unparseable/absent updatedAt is left alone (never reap on a guess).
assert.equal(selectStuckAgentTasks([task({ updatedAt: "" })], { nowMs: NOW }).length, 0, "no timestamp → keep");
assert.equal(selectStuckAgentTasks([task({ updatedAt: "not-a-date" })], { nowMs: NOW }).length, 0, "bad timestamp → keep");

// The conservative default keeps the reaper well clear of real runs (minutes), so it can't race one.
assert.ok(STUCK_AGENT_TASK_TIMEOUT_MIN >= 120, "default timeout is conservative (>= 2h)");

// Wiring: the reaper runs inside the periodic state-reconcile heal (processDueFollowUpsUnlocked).
const idx = fs.readFileSync("services/api/src/index.ts", "utf8");
assert.match(idx, /await reapStuckAgentTasks\(\{ nowMs: now\.getTime\(\) \}\)/, "reaper is wired into the reconcile heal");
assert.match(idx, /\[state-reconcile\] failed \$\{reapedStuckTaskIds\.length\} stuck agent task/, "logs what it reaped");

console.log("PASS stuck_agent_task_reaper eval — reaps dead runners, never races a live run");
