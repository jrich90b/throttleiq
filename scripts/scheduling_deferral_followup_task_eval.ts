/**
 * Scheduling-deferral owner-follow-up-task eval (2026-06-28).
 *
 * When a scheduling turn DEFERS a requested time ("Sounds good — I'll check that time and follow
 * up.") without booking it and without offering alternatives, the agent must leave an OWNER
 * follow-up task so the salesperson actually confirms the time — instead of a silent promise.
 * Operator-reported 4× on +17167506588 ("I can come next week Saturday same time around 1 o'clock"
 * → "I'll check that time and follow up", no task created, request silently dropped).
 *
 * The task creation reads the live todo store + leadOwner, so it can't run end-to-end in CI; this
 * pins (1) the centralized pure decision and (2) the shared-helper + both-paths wiring via source
 * guards — the same approach the calendar-/IO-heavy scheduling evals use.
 *
 * Run: npx tsx scripts/scheduling_deferral_followup_task_eval.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { decideSchedulingDeferralFollowUpTask } from "../services/api/src/domain/routeStateReducer.ts";

// --- 1) Pure decision table. ---
const decide = (over: Partial<Parameters<typeof decideSchedulingDeferralFollowUpTask>[0]>) =>
  decideSchedulingDeferralFollowUpTask({
    deferred: true,
    booked: false,
    offeredAlternatives: false,
    hasRequestedPhrase: true,
    ...over
  }).createTask;

assert.equal(decide({}), true, "deferred + not booked + no alternatives => create the owner task");
assert.equal(decide({ booked: true }), false, "booked this turn => auto-book handled it, no task");
assert.equal(decide({ offeredAlternatives: true }), false, "offered alternatives => not a silent defer");
assert.equal(decide({ deferred: false }), false, "not a deferral turn => no task");
// Fail-direction: a missing/unresolved requested phrase must NOT suppress the task (still ping the owner).
assert.equal(decide({ hasRequestedPhrase: false }), true, "fail-direction: create even without a resolved phrase");

// --- 2) Shared helper + resolver wiring. ---
const api = fs.readFileSync("services/api/src/index.ts", "utf8");

// The shared resolver threads the deferral signals out ONCE (centralized), for both arms to consume.
assert.match(api, /needsOwnerFollowUpTask: boolean;/, "the resolver result carries the deferral flag");
assert.match(api, /requestedPhrase: string;/, "the resolver result carries the requested day/time phrase");
assert.match(api, /needsOwnerFollowUpTask: true,[\s\S]*?requestedPhrase:/, "a deferral branch flags an owner task + phrase");
assert.match(api, /needsOwnerFollowUpTask: false, \/\/ we offered alternatives/, "the offer-alternatives branch does NOT request a task");

// The shared helper gates on the pure decision, dedupes by summary marker, and creates a `call` task
// owned by the lead owner (top priority + survives sold-lead suppression).
assert.match(api, /function addSchedulingDeferralFollowUpTodo\(/, "the shared helper exists");
assert.match(api, /decideSchedulingDeferralFollowUpTask\(\{/, "the helper routes through the centralized pure decision");
assert.match(api, /\/Follow up to book reschedule\/i\.test\(String\(todo\.summary/, "it dedupes by the summary marker (survives regen re-runs)");
assert.match(
  api,
  /addTodo\(\s*conv,\s*"call",\s*`Follow up to book reschedule[\s\S]*?conv\?\.leadOwner/,
  "it creates a `call` task owned by the lead owner"
);

// --- 3) Both paths wired (live + regen), in sync. ---
const helperCalls = api.match(/addSchedulingDeferralFollowUpTodo\(/g) ?? [];
// 1 definition + 4 call sites (live provide_arrival_window, live arrival_update, regen ditto).
assert.ok(helperCalls.length >= 5, `helper must be wired at all four scheduling arms (found ${helperCalls.length} refs incl. def)`);
// Live arms feed event.body; regen arms feed (inbound as any)?.providerMessageId — assert both shapes exist.
assert.match(
  api,
  /addSchedulingDeferralFollowUpTodo\(\s*conv,[\s\S]*?event\.body,\s*event\.providerMessageId/,
  "the live arm passes the inbound + provider message id"
);
assert.match(
  api,
  /addSchedulingDeferralFollowUpTodo\(\s*conv,[\s\S]*?event\.body,\s*\(inbound as any\)\?\.providerMessageId/,
  "the regen arm passes the inbound + provider message id (parity)"
);
// The live arrival_update arm creates the task AFTER the resolve sweep so it isn't immediately closed.
assert.match(
  api,
  /markOpenTodosResolvedByCommunication\(conv, event\.body[\s\S]*?addSchedulingDeferralFollowUpTodo\(/,
  "the deferral task is created AFTER markOpenTodosResolvedByCommunication (survives the sweep)"
);

console.log("PASS scheduling-deferral owner-follow-up-task eval (decision + helper + both-paths wiring)");
