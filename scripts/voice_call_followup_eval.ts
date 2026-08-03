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

// Call-attempt cadence (2026-06-13, Merton Kreps): a completed outbound call
// only resolves the call follow-up when the customer was actually REACHED. A
// voicemail / no answer keeps the lead on the follow-up cadence and bumps the
// attempt counter instead of closing the task.
assert.ok(
  /if \(!inboundCall && contactedValue === "YES"\)\s*\{[\s\S]{0,200}markOpenCallTodosDoneForCompletedVoiceAttempt\(conv\.id\);/.test(
    apiSource
  ),
  "voice recording handler closes call follow-ups only when contacted=YES (a voicemail keeps following up)"
);
assert.ok(
  /if \(contactedValue === "YES"\) registerContactReached\(conv\);\s*\n\s*else registerMissedContactAttempt\(conv\);/.test(
    apiSource
  ),
  "voice recording handler registers reached vs missed contact attempt up front"
);



// --- Voicemail 2nd-attempt generalization (Joe-approved 2026-07-02, Brian Serena class): a
//     voicemail-only OUTBOUND call creates a 2nd-attempt call task on ANY conversation — the
//     old behavior suppressed it for every non-finance-handoff conv. Source guard: the
//     non-finance branch must create the scheduled task and only suppress on an existing one.
{
  const fs = await import("node:fs");
  const index = fs.readFileSync("services/api/src/index.ts", "utf8");
  const start = index.indexOf("voicemail_second_attempt_task_created");
  assert.ok(start > 0, "the non-finance voicemail branch must create the 2nd-attempt call task");
  const branch = index.slice(Math.max(0, start - 2200), start + 400);
  assert.ok(
    /buildDefaultCallbackFallbackSchedule\(timezone\)/.test(branch),
    "the 2nd-attempt task carries the scheduled dueAt/reminder (same schedule as the finance flow)"
  );
  assert.ok(
    /voicemail_call_todo_suppressed_outbound/.test(index.slice(start)),
    "suppression remains ONLY for convs that already have an open call/follow-up task"
  );
}

// --- A connected call does not deliver a bike that hasn't shipped yet (Joe Catalano,
//     +17164324480, operator-reported 2026-08-01 "Should this have created a watch?").
//     His arrival-notify task was correctly created and dated off the unit's 8/25 ship date; a
//     call that connected on 8/1 ran the blunt closer and marked the 8/25 reminder done 24 days
//     early — even though the fulfillment judge had ruled `not_fulfilled` that same morning.
//     Nothing was left to fire when the bike lands. Pinned BOTH ways: a future-dated arrival
//     reminder survives, an ordinary call-back task due tomorrow still closes.
{
  const { shouldVoiceAttemptKeepArrivalNotifyTaskOpen } = await import(
    "../services/api/src/domain/pendingIncomingInventory.ts"
  );
  const nowMs = Date.parse("2026-08-01T14:54:08.919Z");
  assert.equal(
    shouldVoiceAttemptKeepArrivalNotifyTaskOpen({
      summary: "Notify Joe Catalano when the 2026 FLHXSE CVO Street Glide arrives or is ready to show.",
      dueAt: "2026-08-25T13:00:00.000Z",
      nowMs
    }),
    true,
    "an arrival-notify task still dated in the future survives a reached call"
  );
  assert.equal(
    shouldVoiceAttemptKeepArrivalNotifyTaskOpen({
      summary: "Notify Joe Catalano when the 2026 FLHXSE CVO Street Glide arrives or is ready to show.",
      dueAt: "2026-07-25T13:00:00.000Z",
      nowMs
    }),
    false,
    "once the arrival date has passed, a reached call closes the notify task exactly as before"
  );
  assert.equal(
    shouldVoiceAttemptKeepArrivalNotifyTaskOpen({
      summary: "Notify Joe Catalano when the 2026 FLHXSE CVO Street Glide arrives or is ready to show.",
      dueAt: null,
      nowMs
    }),
    false,
    "an UNDATED arrival-notify task keeps today's behavior (the guard only protects a dated window)"
  );
  assert.equal(
    shouldVoiceAttemptKeepArrivalNotifyTaskOpen({
      summary: "Call requested: get off at three thirty.",
      dueAt: "2026-08-02T13:00:00.000Z",
      nowMs
    }),
    false,
    "an ordinary call-back task due tomorrow is genuinely fulfilled by the call and still closes"
  );

  const arrivalConv = {
    id: "voice-arrival-conv",
    leadKey: "+17164324480",
    status: "open",
    mode: "suggest",
    messages: [],
    lead: { firstName: "Joe", phone: "+17164324480" },
    updatedAt: new Date().toISOString()
  } as any;
  const farFuture = new Date(Date.now() + 24 * 24 * 60 * 60 * 1000).toISOString();
  const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  store.addTodo(
    arrivalConv,
    "call",
    "Notify Joe Catalano when the 2026 FLHXSE CVO Street Glide arrives or is ready to show.",
    "source_arrival_notify",
    undefined,
    { dueAt: farFuture },
    "followup",
    { skipMerge: true }
  );
  store.addTodo(
    arrivalConv,
    "call",
    "Call requested: get off at three thirty.",
    "source_callback",
    undefined,
    { dueAt: tomorrow },
    "todo",
    { skipMerge: true }
  );
  const arrivalClosed = store.markOpenCallTodosDoneForCompletedVoiceAttempt(arrivalConv.id);
  assert.equal(arrivalClosed, 1, "a reached call closes the call-back task only");
  const stillOpen = store
    .listOpenTodos()
    .filter((task: any) => task.convId === arrivalConv.id)
    .map((task: any) => String(task.summary ?? ""));
  assert.equal(stillOpen.length, 1, "exactly one task survives the reached call");
  assert.ok(
    /arrives or is ready to show/i.test(stillOpen[0]),
    "the surviving task is the future-dated arrival reminder, not the call-back"
  );
}

console.log("PASS voice call follow-up eval");
