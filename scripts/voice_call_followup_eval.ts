import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const tmpDir = await mkdtemp(path.join(tmpdir(), "voice-call-followup-eval-"));
const dbPath = path.join(tmpDir, "conversations.json");
process.env.CONVERSATIONS_DB_PATH = dbPath;

await writeFile(
  dbPath,
  JSON.stringify({ version: 1, conversations: [], todos: [], questions: [] }),
  "utf8"
);

const store = await import("../services/api/src/domain/conversationStore.ts");
await store.reloadConversationStore();

const now = new Date().toISOString();
const conv = {
  id: "voice-followup-conv",
  leadKey: "+17160000001",
  status: "open",
  mode: "suggest",
  messages: [],
  lead: { firstName: "Voice", phone: "+17160000001" },
  updatedAt: now
} as any;

store.addTodo(
  conv,
  "call",
  "Call customer (follow-up): confirm next steps.",
  "source_call_followup",
  undefined,
  undefined,
  "followup"
);
store.addTodo(
  conv,
  "other",
  "Internal paperwork task should not close from a voice attempt.",
  "source_other",
  undefined,
  undefined,
  "todo",
  { skipMerge: true }
);

assert.equal(
  store.listOpenTodos().filter((task: any) => task.convId === conv.id && task.reason === "call").length,
  1,
  "setup should have one open call follow-up"
);

const apiSource = await readFile(path.join(process.cwd(), "services/api/src/index.ts"), "utf8");
const callRouteStart = apiSource.indexOf('app.post("/conversations/:id/call"');
const callRouteEnd = apiSource.indexOf("const asyncTwilioWorkerSecret", callRouteStart);
assert.ok(callRouteStart > 0 && callRouteEnd > callRouteStart, "call route source block should be found");
const callRoute = apiSource.slice(callRouteStart, callRouteEnd);
assert.ok(
  !/listOpenTodos\(\)[\s\S]{0,200}reason\s*===\s*"call"[\s\S]{0,200}markTodoDone/.test(callRoute),
  "starting a chat-window call must not close open call follow-up tasks"
);

assert.equal(
  store.listOpenTodos().filter((task: any) => task.convId === conv.id && task.reason === "call").length,
  1,
  "call follow-up should remain open until a completed voice attempt is processed"
);

const closed = store.markOpenCallTodosDoneForCompletedVoiceAttempt(conv.id);
assert.equal(closed, 1, "completed outbound voice attempt should close the open call follow-up");
assert.equal(
  store.listOpenTodos().filter((task: any) => task.convId === conv.id && task.reason === "call").length,
  0,
  "call follow-up should be closed after completed voice attempt"
);
assert.equal(
  store.listOpenTodos().filter((task: any) => task.convId === conv.id && task.reason !== "call").length,
  1,
  "completed voice attempt should not close unrelated non-call tasks"
);

assert.ok(
  /if \(!inboundCall\)\s*\{\s*markOpenCallTodosDoneForCompletedVoiceAttempt\(conv\.id\);/.test(apiSource),
  "voice recording handler should close call follow-ups for completed outbound calls, including voicemail"
);

console.log("PASS voice call follow-up eval");
