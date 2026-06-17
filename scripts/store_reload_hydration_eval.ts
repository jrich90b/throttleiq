import { strict as assert } from "node:assert";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Conversation-store hydration-serialization eval.
 *
 * Pins the fix for the voice_call_followup eval flake: hydrateParsedStore()
 * clear-and-replaces the shared in-memory maps, so the module-import boot load
 * and an explicit reloadConversationStore() must not race. Before the fix,
 * reloadConversationStore() awaited only its own load; under threadpool
 * contention the boot load's fs.readFile could resolve LATE and wipe rows
 * written after the reload had already returned (a freshly-added call follow-up
 * todo vanishing between two assertions). With serialized hydration, a reload
 * transitively awaits any in-flight boot load and nothing mutates the store
 * after it resolves.
 *
 * This eval reproduces the exact import -> reload -> write preamble shared by
 * voice_call_followup / initial_adf_todo_cadence / the meta-promo backfills, and
 * asserts a write made after reloadConversationStore() resolves survives an
 * extended run of macrotasks (the window a dangling boot load would have fired
 * in). It is deterministically green with the fix; reverting the fix makes both
 * this eval and voice_call_followup flake again under full-chain load.
 *
 * File mode runs unconditionally (no database needed). DATA_BACKEND is pinned to
 * "file" so the postgres full-sweep timer never activates regardless of ambient
 * env.
 */

process.env.DATA_BACKEND = "file";
process.env.LLM_ENABLED = "0";

const tmpDir = await mkdtemp(path.join(tmpdir(), "store-reload-hydration-eval-"));
const dbPath = path.join(tmpDir, "conversations.json");
process.env.CONVERSATIONS_DB_PATH = dbPath;

await writeFile(
  dbPath,
  JSON.stringify({ version: 1, conversations: [], todos: [], questions: [] }),
  "utf8"
);

// Importing the store kicks off the module-import boot hydration; the reload
// immediately after is the preamble that flaked.
const store = await import("../services/api/src/domain/conversationStore.ts");
await store.reloadConversationStore();

const macrotask = () => new Promise<void>(resolve => setTimeout(resolve, 0));
const pumpMacrotasks = async (n: number) => {
  for (let i = 0; i < n; i++) await macrotask();
};

function makeConv(id: string, phone: string) {
  return {
    id,
    leadKey: phone,
    status: "open",
    mode: "suggest",
    messages: [],
    lead: { firstName: "Reload", phone },
    updatedAt: new Date().toISOString()
  } as any;
}

const openCallTodos = (convId: string) =>
  store
    .listOpenTodos()
    .filter((task: any) => task.convId === convId && task.reason === "call").length;

// --- Scenario A: write after a single reload survives a late boot hydration ---
const convA = makeConv("reload-hydration-conv-a", "+17160000091");
store.addTodo(
  convA,
  "call",
  "Call follow-up should survive a late boot hydration.",
  "src_reload_a",
  undefined,
  undefined,
  "followup"
);

assert.equal(openCallTodos(convA.id), 1, "todo should be present immediately after addTodo");

// Give any in-flight hydration ample opportunity to fire. Before the fix this is
// where a late boot load would clear the maps and drop the todo.
await pumpMacrotasks(40);

assert.equal(
  openCallTodos(convA.id),
  1,
  "call follow-up must survive any in-flight hydration after reloadConversationStore() resolved"
);

// --- Scenario B: overlapping reloads serialize; an interleaved write is kept ---
// Start two reloads without directly awaiting the first. With serialized
// hydration the second reload chains after the first, so awaiting store
// readiness (the latest load) transitively awaits the first — nothing dangles.
const r1 = store.reloadConversationStore();
const r2 = store.reloadConversationStore();
// r2 is awaited via whenConversationStoreReady (it is the latest load); mark r1
// handled so a floating promise can never surface as an unhandled rejection.
r1.catch(() => {});
r2.catch(() => {});
await store.whenConversationStoreReady();

const convB = makeConv("reload-hydration-conv-b", "+17160000092");
store.addTodo(
  convB,
  "call",
  "Call follow-up after overlapping reloads.",
  "src_reload_b",
  undefined,
  undefined,
  "followup"
);

await pumpMacrotasks(40);

assert.equal(
  openCallTodos(convB.id),
  1,
  "a write after overlapping reloads must not be clobbered by an earlier in-flight reload"
);

console.log("PASS store reload hydration eval");
