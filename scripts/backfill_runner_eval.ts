/**
 * Backfill harness eval. Pins the safety contract: planBackfill NEVER mutates (dry-run), applyBackfill
 * does, the cap bounds proposals, and the report renders. The agent-watch loop relies on this to ship a
 * dry-run report in a fix PR and gate the apply on a human.
 *
 * Deterministic — always runs. Run: npx tsx scripts/backfill_runner_eval.ts
 */
import assert from "node:assert/strict";
import { planBackfill, applyBackfill, renderBackfillReport } from "../services/api/src/domain/backfillRunner.ts";

// A toy "fix": close a task that should have auto-closed (the Douglas class).
const conversations: any[] = [
  { id: "c1", leadKey: "+1555000001", task: { open: true, kind: "call" } },
  { id: "c2", leadKey: "+1555000002", task: { open: false } },
  { id: "c3", leadKey: "+1555000003", task: { open: true, kind: "call" } }
];
const correct = (conv: any) =>
  conv?.task?.open
    ? { summary: `close stale ${conv.task.kind} task`, mutate: () => { conv.task.open = false; conv.task.closedByBackfill = true; } }
    : null;

// 1) Dry-run plans 2 changes and MUTATES NOTHING.
const plan = planBackfill({ conversations, correct });
assert.equal(plan.changes.length, 2, "should plan 2 changes (c1, c3)");
assert.equal(plan.scanned, 3);
assert.equal(conversations[0].task.open, true, "dry-run must NOT mutate c1");
assert.equal(conversations[2].task.open, true, "dry-run must NOT mutate c3");
assert.ok(/DRY-RUN/.test(renderBackfillReport(plan, { title: "task autoclose" })), "report shows DRY-RUN by default");
assert.ok(/close stale call task/.test(renderBackfillReport(plan)), "report lists the summaries");

// 2) Apply mutates exactly the planned changes.
const applied = applyBackfill(plan);
assert.equal(applied, 2);
assert.equal(conversations[0].task.open, false, "apply closes c1");
assert.equal(conversations[0].task.closedByBackfill, true);
assert.equal(conversations[2].task.open, false, "apply closes c3");
assert.equal(conversations[1].task.open, false, "c2 untouched (was already closed)");
assert.ok(/APPLIED/.test(renderBackfillReport(plan, { applied: true })));

// 3) Cap bounds proposals.
const many = Array.from({ length: 10 }, (_, i) => ({ id: `m${i}`, leadKey: `+${i}`, task: { open: true, kind: "call" } }));
const capped = planBackfill({ conversations: many, correct, cap: 3 });
assert.equal(capped.changes.length, 3, "cap limits proposals to 3");
assert.equal(capped.capped, true, "capped flag set");

// 4) A throwing correct() never aborts the plan.
const safe = planBackfill({ conversations: [{ id: "x", leadKey: "y" }], correct: () => { throw new Error("boom"); } });
assert.equal(safe.changes.length, 0, "a throwing predicate is swallowed per-conv");

console.log("PASS backfill runner eval (dry-run no-mutate + apply + cap + error-safe)");
