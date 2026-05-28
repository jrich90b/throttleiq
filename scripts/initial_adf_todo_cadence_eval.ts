import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const tmpDir = await mkdtemp(path.join(tmpdir(), "initial-adf-todo-cadence-"));
const dbPath = path.join(tmpDir, "conversations.json");
process.env.CONVERSATIONS_DB_PATH = dbPath;

await writeFile(
  dbPath,
  JSON.stringify({ version: 1, conversations: [], todos: [], questions: [] }),
  "utf8"
);

const store = await import("../services/api/src/domain/conversationStore.ts");
await store.reloadConversationStore();

const makeConversation = (id: string) =>
  ({
    id,
    leadKey: id,
    status: "open",
    messages: [],
    lead: {},
    updatedAt: new Date().toISOString()
  }) as any;

const openTodosFor = (convId: string) =>
  store.listOpenTodos().filter((task: any) => task.convId === convId);

const noCadence = makeConversation("adf-no-cadence");
const noCadenceTodo = store.addCallTodoIfMissing(
  noCadence,
  "Call customer (initial reply sent)."
);
assert.ok(noCadenceTodo, "generic initial ADF call todo should be kept when no cadence exists");
assert.equal(noCadenceTodo?.taskClass, "followup");
assert.equal(openTodosFor(noCadence.id).length, 1);

const withCadence = makeConversation("adf-with-cadence");
store.startFollowUpCadence(withCadence, "2026-05-28T16:00:00.000Z", "America/New_York");
const suppressedTodo = store.addCallTodoIfMissing(
  withCadence,
  "Call customer (initial reply sent)."
);
assert.equal(suppressedTodo, null, "active cadence should suppress only the generic initial call todo");
assert.equal(openTodosFor(withCadence.id).length, 0);

const phonePreferred = makeConversation("adf-phone-preferred");
store.startFollowUpCadence(phonePreferred, "2026-05-28T16:00:00.000Z", "America/New_York");
const phoneTodo = store.addCallTodoIfMissing(
  phonePreferred,
  "Preferred contact method is phone. Call customer (no auto text/email)."
);
assert.ok(phoneTodo, "phone-preferred leads still need a human call task");
assert.equal(openTodosFor(phonePreferred.id).length, 1);

await store.flushConversationStore();

console.log("PASS initial ADF todo/cadence eval");
