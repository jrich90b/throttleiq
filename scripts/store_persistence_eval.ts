import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Conversation-store persistence eval (docs/postgres_store_swap.md).
 *
 * File mode runs unconditionally (no database needed) and covers:
 * - backend/env selection defaults
 * - write -> flush -> fresh-process load round trip (create, todo, delete)
 * - malformed-row hydration parity (missing messages array coerced to [])
 *
 * Postgres mode runs the same round trip only when DATABASE_URL_TEST is set,
 * so CI never requires a database.
 *
 * Phases run in subprocesses because the store hydrates once at module import.
 */

const SELF = fileURLToPath(import.meta.url);

function runPhase(phase: string, env: Record<string, string | undefined>): void {
  const res = spawnSync("npx", ["tsx", SELF, "--phase", phase], {
    encoding: "utf8",
    env: { ...process.env, ...env }
  });
  if (res.status !== 0) {
    console.error(`phase=${phase} stdout:\n${res.stdout}`);
    console.error(`phase=${phase} stderr:\n${res.stderr}`);
    throw new Error(`store persistence eval phase '${phase}' failed (exit ${res.status})`);
  }
}

async function phaseWrite(): Promise<void> {
  const store = await import("../services/api/src/domain/conversationStore.ts");
  await store.whenConversationStoreReady();
  const kept = store.createConversationForLeadKey("+17165550101");
  (kept.lead as any) = { firstName: "Parity", lastName: "Test" };
  store.saveConversation(kept);
  const todo = store.addTodo(kept, "call", "Store persistence eval follow-up");
  assert.ok(todo, "addTodo should create a task");
  const removed = store.createConversationForLeadKey("+17165550102");
  assert.ok(store.deleteConversation(removed.id), "deleteConversation should remove the row");
  await store.flushConversationStore();
  console.log(`write ok kept=${kept.id}`);
}

async function phaseRead(): Promise<void> {
  const store = await import("../services/api/src/domain/conversationStore.ts");
  await store.whenConversationStoreReady();
  const all = store.getAllConversations();
  assert.equal(all.length, 1, `expected 1 conversation after round trip, got ${all.length}`);
  assert.equal(all[0]?.leadKey, "+17165550101");
  assert.equal((all[0]?.lead as any)?.firstName, "Parity");
  const todos = store.listOpenTodos();
  assert.equal(todos.length, 1, `expected 1 open todo after round trip, got ${todos.length}`);
  console.log("read ok");
}

async function phaseReadMalformed(): Promise<void> {
  const store = await import("../services/api/src/domain/conversationStore.ts");
  await store.whenConversationStoreReady();
  const all = store.getAllConversations();
  assert.equal(all.length, 1, "malformed store should still hydrate the valid row");
  assert.ok(Array.isArray(all[0]?.messages), "missing messages must be coerced to an array");
  console.log("read-malformed ok");
}

async function main(): Promise<void> {
  const phaseIdx = process.argv.indexOf("--phase");
  const phase = phaseIdx >= 0 ? process.argv[phaseIdx + 1] : "";
  if (phase === "write") return phaseWrite();
  if (phase === "read") return phaseRead();
  if (phase === "read-malformed") return phaseReadMalformed();

  // --- orchestrator ---
  const { getDataBackend, getDealerId } = await import(
    "../services/api/src/domain/storePersistence.ts"
  );

  // Backend selection defaults
  const envBackup = { DATA_BACKEND: process.env.DATA_BACKEND, DEALER_ID: process.env.DEALER_ID, DEALER_SLUG: process.env.DEALER_SLUG };
  delete process.env.DATA_BACKEND;
  assert.equal(getDataBackend(), "file", "DATA_BACKEND unset must default to file");
  process.env.DATA_BACKEND = "dual";
  assert.equal(getDataBackend(), "dual_write");
  process.env.DATA_BACKEND = "postgres";
  assert.equal(getDataBackend(), "postgres");
  process.env.DATA_BACKEND = "nonsense";
  assert.equal(getDataBackend(), "file", "unknown DATA_BACKEND must fall back to file");
  delete process.env.DEALER_ID;
  delete process.env.DEALER_SLUG;
  assert.equal(getDealerId(), "americanharley", "DEALER_ID must default to americanharley");
  process.env.DATA_BACKEND = envBackup.DATA_BACKEND ?? "";
  if (!envBackup.DATA_BACKEND) delete process.env.DATA_BACKEND;
  if (envBackup.DEALER_ID) process.env.DEALER_ID = envBackup.DEALER_ID;
  if (envBackup.DEALER_SLUG) process.env.DEALER_SLUG = envBackup.DEALER_SLUG;

  // File-mode round trip in a fresh DATA_DIR
  const fileDir = await fs.mkdtemp(path.join(os.tmpdir(), "store-persistence-file-"));
  const fileEnv = {
    DATA_DIR: fileDir,
    CONVERSATIONS_DB_PATH: undefined,
    DATA_BACKEND: "file",
    LLM_ENABLED: "0"
  };
  runPhase("write", fileEnv);
  runPhase("read", fileEnv);

  // Malformed-row hydration
  const malformedDir = await fs.mkdtemp(path.join(os.tmpdir(), "store-persistence-malformed-"));
  await fs.writeFile(
    path.join(malformedDir, "conversations.json"),
    JSON.stringify({
      version: 1,
      conversations: [
        { id: "conv_malformed_1", leadKey: "+17165550199" },
        { leadKey: "" }
      ],
      todos: [],
      questions: []
    }),
    "utf8"
  );
  runPhase("read-malformed", {
    DATA_DIR: malformedDir,
    CONVERSATIONS_DB_PATH: undefined,
    DATA_BACKEND: "file",
    LLM_ENABLED: "0"
  });

  // Optional Postgres round trip (skipped without DATABASE_URL_TEST)
  const testDbUrl = String(process.env.DATABASE_URL_TEST ?? "").trim();
  if (testDbUrl) {
    const pgDir = await fs.mkdtemp(path.join(os.tmpdir(), "store-persistence-pg-"));
    const dealer = `store_persistence_eval_${Date.now()}`;
    const pgEnv = {
      DATA_DIR: pgDir,
      CONVERSATIONS_DB_PATH: undefined,
      DATA_BACKEND: "postgres",
      DATABASE_URL: testDbUrl,
      DEALER_ID: dealer,
      LLM_ENABLED: "0"
    };
    runPhase("write", pgEnv);
    // Point the read at an empty DATA_DIR so only Postgres can satisfy it.
    const pgReadDir = await fs.mkdtemp(path.join(os.tmpdir(), "store-persistence-pg-read-"));
    runPhase("read", { ...pgEnv, DATA_DIR: pgReadDir });
    console.log(`postgres round trip ok (dealer=${dealer})`);

    // dual_write: file stays source of truth, Postgres shadows every flush.
    const dualDir = await fs.mkdtemp(path.join(os.tmpdir(), "store-persistence-dual-"));
    const dualDealer = `store_persistence_eval_dual_${Date.now()}`;
    const dualEnv = {
      DATA_DIR: dualDir,
      CONVERSATIONS_DB_PATH: undefined,
      DATA_BACKEND: "dual_write",
      DATABASE_URL: testDbUrl,
      DEALER_ID: dualDealer,
      LLM_ENABLED: "0"
    };
    runPhase("write", dualEnv);
    runPhase("read", { ...dualEnv, DATA_BACKEND: "file" });
    const dualPgReadDir = await fs.mkdtemp(path.join(os.tmpdir(), "store-persistence-dual-pg-read-"));
    runPhase("read", { ...dualEnv, DATA_BACKEND: "postgres", DATA_DIR: dualPgReadDir });
    console.log(`dual_write round trip ok (dealer=${dualDealer})`);
  } else {
    console.log("postgres round trip skipped (DATABASE_URL_TEST not set)");
  }

  console.log("PASS store persistence eval");
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
