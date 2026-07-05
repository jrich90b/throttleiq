import { strict as assert } from "node:assert";
import os from "node:os";
import * as path from "node:path";
import { promises as fs, rmSync } from "node:fs";

/**
 * Task snooze eval — staff "I'll deal with it later" pushes a task's due time
 * forward without losing the task. Pins the store mutator snoozeTodo:
 *   - the new dueAt is applied,
 *   - reminderAt is shifted to keep the same lead before the new due time,
 *   - the reminder is re-armed (reminderSentAt cleared) so it fires again,
 *   - the task stays OPEN (snooze defers, never closes),
 *   - bad input / unknown ids are rejected with no mutation.
 * Deterministic; no LLM. Backs the Task Inbox quick-action Snooze control.
 */

// Isolate the store on a throwaway file so the eval never touches real data.
const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "task-snooze-eval-"));
process.env.CONVERSATIONS_DB_PATH = path.join(tmpDir, "conversations.json");

const store = await import("../services/api/src/domain/conversationStore.ts");
await store.whenConversationStoreReady();

const conv = store.createConversationForLeadKey("+17165550190");
const overdueDue = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 1h overdue
const todo = store.addTodo(conv, "call", "Call customer about the Road Glide", undefined, undefined, {
  dueAt: overdueDue,
  reminderAt: new Date(Date.parse(overdueDue) - 30 * 60 * 1000).toISOString(),
  reminderLeadMinutes: 30
});
assert.ok(todo, "addTodo should create the task");

// Pretend the reminder already fired so we can prove snooze re-arms it.
(todo as any).reminderSentAt = new Date().toISOString();

const target = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
target.setHours(9, 0, 0, 0);
const targetIso = target.toISOString();

const snoozed = store.snoozeTodo(conv.id, todo!.id, targetIso);
assert.ok(snoozed, "snoozeTodo should return the updated task");
assert.equal(snoozed!.dueAt, targetIso, "dueAt is moved to the snooze target");
assert.equal(
  snoozed!.reminderAt,
  new Date(target.getTime() - 30 * 60 * 1000).toISOString(),
  "reminderAt keeps the 30-minute lead before the new due time"
);
assert.equal(snoozed!.reminderSentAt, undefined, "reminder is re-armed so it fires again");

// The task stays open and is no longer overdue (deferred, not lost).
const open = store.listOpenTodos().filter(t => t.convId === conv.id);
assert.equal(open.length, 1, "snoozed task remains open");
assert.ok(Date.parse(open[0].dueAt!) > Date.now(), "snoozed task is no longer overdue");

// Invalid dueAt is rejected and leaves the task untouched.
const before = snoozed!.dueAt;
assert.equal(store.snoozeTodo(conv.id, todo!.id, "not-a-date"), null, "invalid dueAt is rejected");
assert.equal(
  store.listOpenTodos().find(t => t.id === todo!.id)?.dueAt,
  before,
  "rejected snooze leaves dueAt unchanged"
);

// Unknown todo id is a no-op.
assert.equal(
  store.snoozeTodo(conv.id, "does-not-exist", targetIso),
  null,
  "unknown todo id returns null"
);

// rmSync (not async fs.rm): a synchronous remove can't yield the event loop
// mid-delete, so the conversation store's pending async flush can't re-write
// conversations.json between the unlink and rmdir and race us to ENOTEMPTY.
rmSync(tmpDir, { recursive: true, force: true });
console.log("task_snooze:eval ok");
