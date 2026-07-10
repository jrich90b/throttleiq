/**
 * Pending-incoming notify-todo dedup eval.
 *
 * Pins the fix for duplicate "Notify <customer> when the <label> trade arrives or is ready to
 * show" tasks (Nicholas Braun: 4 open copies on one conversation, 2026-06-23). Root cause:
 * addTodo dedups by `taskClass`, but the SAME singleton objective lands in different class
 * buckets — applyPendingIncomingInventoryState forces `taskClass: "followup"`, while
 * inferTodoTaskClass classifies that exact summary as "todo" — so copies never merged.
 *
 * The fix deduplicates CLASS-AGNOSTICALLY by the task's template signature:
 *  - applyPendingIncomingInventoryState upserts via upsertPendingIncomingInventoryNotifyTodo
 *    (write-time prevention; both live + regenerate paths funnel through it), and
 *  - the maintenance tick collapses any pre-existing pile via healPendingIncomingNotifyTodoDuplicates.
 *
 * Layers:
 *  1) Source guard (no LLM): the producer no longer bare-addTodos the notify task; it upserts.
 *     The store exposes the upsert + heal. The reconcile tick calls the heal.
 *  2) Pure predicate coverage: the template matcher recognizes our own notify task (incl. a
 *     compound summary) and rejects unrelated tasks.
 *  3) Pure planner coverage: pick one survivor (richest), retire the rest; idempotent on 0/1.
 *
 * Run: npx tsx scripts/pending_incoming_todo_dedup_eval.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  isPendingIncomingInventoryNotifyTodoSummary,
  planPendingIncomingNotifyDedup
} from "../services/api/src/domain/pendingIncomingInventory.ts";

// --- 1) Source guard (no LLM). ---
const index = fs.readFileSync("services/api/src/index.ts", "utf8");
const store = fs.readFileSync("services/api/src/domain/conversationStore.ts", "utf8");

assert.ok(
  /export function upsertPendingIncomingInventoryNotifyTodo/.test(store),
  "the class-agnostic upsert must be exported from conversationStore.ts"
);
assert.ok(
  /export function healPendingIncomingNotifyTodoDuplicates/.test(store),
  "the dedup heal must be exported from conversationStore.ts"
);
// The producer must upsert (singleton), not bare-addTodo the notify task into a class bucket.
assert.ok(
  /upsertPendingIncomingInventoryNotifyTodo\(\s*conv,\s*\n\s*buildPendingIncomingInventoryTaskSummary/.test(index),
  "applyPendingIncomingInventoryState must upsert the notify task (not bare addTodo)"
);
// The maintenance reconcile tick must heal any pre-existing duplicate pile.
assert.ok(
  /healPendingIncomingNotifyTodoDuplicates\(conv\)/.test(index),
  "the maintenance reconcile must collapse duplicate notify todos"
);

// --- 2) Pure predicate coverage. ---
const bare = "Notify Don Pagels when the 2016 Freewheeler trade arrives or is ready to show.";
const compound =
  "Notify Nicholas Braun when the 2026 Other trade arrives or is ready to show. Confirm color for Harley-Davidson Other. Customer asked: Looking for the quarter fairing kit part # 57001615EYO online";
assert.equal(isPendingIncomingInventoryNotifyTodoSummary(bare), true, "bare notify template should match");
assert.equal(isPendingIncomingInventoryNotifyTodoSummary(compound), true, "compound notify summary should match");
assert.equal(
  isPendingIncomingInventoryNotifyTodoSummary(bare.toUpperCase()),
  true,
  "matcher must be case-insensitive"
);
for (const neg of [
  "",
  null,
  undefined,
  "Call customer (follow-up): checking back on the Road Glide.",
  "Customer wants to RESERVE a unit (limited run). Call with reservation steps.",
  "Call requested: Sat, Jun 20, 9:00 AM.",
  "Confirm color for Harley-Davidson Other."
]) {
  assert.equal(
    isPendingIncomingInventoryNotifyTodoSummary(neg as any),
    false,
    `unrelated/empty summary must NOT match: ${JSON.stringify(neg)}`
  );
}

// --- 3) Pure planner coverage. ---
// No matches → nothing to do.
assert.deepEqual(planPendingIncomingNotifyDedup([]), { keepId: null, retireIds: [], adoptDueAt: null });
assert.deepEqual(
  planPendingIncomingNotifyDedup([{ id: "x", summary: "Call requested: Sat." }]),
  { keepId: null, retireIds: [], adoptDueAt: null },
  "a conversation with no notify task is untouched"
);

// Exactly one → keep it, retire none (idempotent: re-running never churns).
assert.deepEqual(
  planPendingIncomingNotifyDedup([{ id: "only", summary: bare }]),
  { keepId: "only", retireIds: [], adoptDueAt: null }
);

// Braun's real shape: 3 bare copies + 1 compound. Keep the richest (compound), retire the 3 bare.
const braun = planPendingIncomingNotifyDedup([
  { id: "t1", summary: bare },
  { id: "t2", summary: compound },
  { id: "t3", summary: bare },
  { id: "t4", summary: bare }
]);
assert.equal(braun.keepId, "t2", "the compound (longest) copy survives so no appended ask is lost");
assert.deepEqual(new Set(braun.retireIds), new Set(["t1", "t3", "t4"]));

// Non-notify tasks on the same conversation are ignored (never retired).
const mixed = planPendingIncomingNotifyDedup([
  { id: "n1", summary: bare },
  { id: "other", summary: "Confirm color for Harley-Davidson Other." },
  { id: "n2", summary: compound }
]);
assert.equal(mixed.keepId, "n2");
assert.deepEqual(mixed.retireIds, ["n1"], "only the duplicate notify task is retired, not the unrelated one");

// Tie-break is deterministic: equal-length copies keep the first.
const tie = planPendingIncomingNotifyDedup([
  { id: "a", summary: bare },
  { id: "b", summary: bare }
]);
assert.equal(tie.keepId, "a", "equal-length copies keep the first (stable)");
assert.deepEqual(tie.retireIds, ["b"]);

// --- 4) Generic arrival-notify family (Joe ruling 2026-07-09, Dante Turello +17169085899):
// the template task AND a staff-written reminder with different words are the SAME objective. ---
const danteTemplate = "Notify Dante Turello when the 2023 Low Rider S trade arrives or is ready to show.";
const danteStaff = "contact customer when the low rider s gets here from the auction";
assert.equal(isPendingIncomingInventoryNotifyTodoSummary(danteStaff), true, "staff-worded arrival reminder matches the family");
assert.equal(
  isPendingIncomingInventoryNotifyTodoSummary("Call customer about the trade appraisal."),
  false,
  "an action verb WITHOUT arrival phrasing does not match (conservative)"
);
assert.equal(
  isPendingIncomingInventoryNotifyTodoSummary("The bike arrives tomorrow."),
  false,
  "arrival phrasing WITHOUT an action verb does not match (conservative)"
);
const dante = planPendingIncomingNotifyDedup([
  { id: "tpl", summary: danteTemplate },
  { id: "staff", summary: danteStaff, dueAt: "2026-07-10T22:01:00.000Z" }
]);
assert.equal(dante.keepId, "tpl", "richest copy survives");
assert.deepEqual(dante.retireIds, ["staff"]);
assert.equal(dante.adoptDueAt, "2026-07-10T22:01:00.000Z", "survivor adopts the retiree's due date so the schedule isn't lost");
// A survivor that already has a due date keeps it (no adoption).
const keepOwnDue = planPendingIncomingNotifyDedup([
  { id: "tpl", summary: danteTemplate, dueAt: "2026-07-09T15:00:00.000Z" },
  { id: "staff", summary: danteStaff, dueAt: "2026-07-10T22:01:00.000Z" }
]);
assert.equal(keepOwnDue.adoptDueAt, null, "survivor with its own dueAt adopts nothing");

console.log("PASS pending-incoming notify-todo dedup eval (source guard + predicate + planner + arrival-notify family)");
