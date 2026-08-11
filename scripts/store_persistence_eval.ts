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

  // Backend selection defaults + the dealer-id invariant guard (soft blocker
  // B5): the dealer-id default is file-mode only; a database-backed mode with
  // no explicit dealer must fail loudly, never silently share another
  // dealer's rows.
  const envBackup = { DATA_BACKEND: process.env.DATA_BACKEND, DEALER_ID: process.env.DEALER_ID, DEALER_SLUG: process.env.DEALER_SLUG };
  try {
    delete process.env.DATA_BACKEND;
    delete process.env.DEALER_ID;
    delete process.env.DEALER_SLUG;
    assert.equal(getDataBackend(), "file", "DATA_BACKEND unset must default to file");
    process.env.DATA_BACKEND = "dual";
    assert.equal(getDataBackend(), "dual_write");
    process.env.DATA_BACKEND = "postgres";
    assert.equal(getDataBackend(), "postgres");
    process.env.DATA_BACKEND = "nonsense";
    assert.equal(getDataBackend(), "file", "unknown DATA_BACKEND must fall back to file");

    // (a) file mode + no dealer env -> default ok (evals/local dev, zero env).
    delete process.env.DATA_BACKEND;
    assert.equal(getDealerId(), "americanharley", "file mode must default the dealer id");

    for (const backend of ["dual_write", "postgres"] as const) {
      process.env.DATA_BACKEND = backend;

      // (b) database-backed mode + explicit dealer env -> used verbatim.
      process.env.DEALER_ID = "dealer_two";
      assert.equal(getDealerId(), "dealer_two", `${backend} must use the explicit DEALER_ID`);
      delete process.env.DEALER_ID;
      process.env.DEALER_SLUG = "dealer_two_slug";
      assert.equal(getDealerId(), "dealer_two_slug", `${backend} must accept DEALER_SLUG`);
      delete process.env.DEALER_SLUG;

      // (c) database-backed mode + no dealer env -> throws naming the required
      // env var; whitespace-only counts as unset.
      process.env.DEALER_ID = "   ";
      assert.throws(
        () => getDealerId(),
        (err: unknown) =>
          err instanceof Error &&
          err.message.includes("DEALER_ID") &&
          err.message.includes(backend),
        `${backend} with no DEALER_ID must fail loudly, not default`
      );
      delete process.env.DEALER_ID;
      assert.throws(
        () => getDealerId(),
        (err: unknown) =>
          err instanceof Error &&
          err.message.includes("DEALER_ID") &&
          err.message.includes(backend),
        `${backend} with no dealer env at all must fail loudly, not default`
      );
    }
  } finally {
    for (const [k, v] of Object.entries(envBackup)) {
      if (v == null) delete process.env[k];
      else process.env[k] = v;
    }
  }

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

  // Phase 2 document-store helpers: file-mode round trip (no DB needed).
  {
    const { readJsonStoreText, writeJsonStoreText } = await import(
      "../services/api/src/domain/storePersistence.ts"
    );
    const docDir = await fs.mkdtemp(path.join(os.tmpdir(), "store-persistence-doc-"));
    const docPath = path.join(docDir, "settings.json");
    delete process.env.DATA_BACKEND;
    assert.equal(
      await readJsonStoreText({ store: "settings", filePath: docPath }),
      null,
      "missing doc store must read as null"
    );
    const docText = JSON.stringify({ version: 1, mode: "autopilot" }, null, 2);
    await writeJsonStoreText({ store: "settings", filePath: docPath, text: docText });
    assert.equal(
      await readJsonStoreText({ store: "settings", filePath: docPath }),
      docText,
      "file-mode doc store must round-trip exact text"
    );
    console.log("document store file round trip ok");
  }

  // --- concurrent writes to ONE store must not lose writes -----------------------------------
  // A fixed `<file>.tmp` name is not atomic when two writes to the same store overlap: both open the
  // same temp path, one rename publishes the other's bytes, and the loser fails
  // `ENOENT: ... rename '<file>.tmp' -> '<file>'`. Measured on the pre-fix code at 12 concurrent
  // writes: 11 of 12 REJECTED — eleven writes lost — and because these writes are fired without a
  // catch, each rejection was also an unhandled promise rejection in the API process. The production
  // error log carried 44 of them for sessions.json and 25 for twilio_inbound_jobs.json (2026-08-10).
  // This drives the real writer, so it fails if the fix is unwired, not merely if its source changes.
  {
    const { writeJsonStoreText } = await import(
      "../services/api/src/domain/storePersistence.ts"
    );
    const raceDir = await fs.mkdtemp(path.join(os.tmpdir(), "store-persistence-race-"));
    const racePath = path.join(raceDir, "sessions.json");
    const backendBefore = process.env.DATA_BACKEND;
    delete process.env.DATA_BACKEND; // file mode: no database needed
    try {
      const writes = 12;
      // Big enough that a write cannot land inside a single event-loop turn, which is what makes the
      // overlap real rather than accidental.
      const settled = await Promise.allSettled(
        Array.from({ length: writes }, (_, i) =>
          writeJsonStoreText({
            store: "sessions",
            filePath: racePath,
            text: JSON.stringify({ n: i, pad: "x".repeat(20000) })
          })
        )
      );
      const rejected = settled.filter(r => r.status === "rejected");
      const firstReason =
        rejected.length > 0
          ? String((rejected[0] as PromiseRejectedResult).reason?.message ?? "").slice(0, 160)
          : "";
      assert.equal(
        rejected.length,
        0,
        `concurrent writes to one store must all succeed; ${rejected.length}/${writes} were lost: ${firstReason}`
      );

      const finalText = await fs.readFile(racePath, "utf8");
      let parsed: any = null;
      try {
        parsed = JSON.parse(finalText);
      } catch {
        assert.fail("a concurrent burst must leave whole JSON behind, never a half-written file");
      }
      // Writes to one path are serialised, so the LAST one queued is the one on disk. Without the
      // serialisation half of the fix the winner is whichever rename happens to land last.
      assert.equal(
        parsed?.n,
        writes - 1,
        "writes to one store apply in the order they were made — the last one queued wins"
      );

      const leftovers = (await fs.readdir(raceDir)).filter(name => name.includes(".tmp"));
      assert.deepEqual(
        leftovers,
        [],
        `no temp files may be left behind (found ${leftovers.join(", ")})`
      );
      console.log(`concurrent store writes ok (${writes} writes, 0 lost, no temp files left)`);
    } finally {
      if (backendBefore == null) delete process.env.DATA_BACKEND;
      else process.env.DATA_BACKEND = backendBefore;
    }
  }

  // --- the same race, on the inbound-SMS job queue ---------------------------------------------
  // `twilio_inbound_jobs.json` is the queue of inbound customer texts, so a lost write is a message
  // we may never answer. Its debounced save timer and an awaited `flushTwilioInboundJobs()` overlap
  // in normal operation, which is how it produced 25 of the production ENOENTs. Driven through the
  // store's real exported API.
  {
    const jobsDir = await fs.mkdtemp(path.join(os.tmpdir(), "twilio-inbound-jobs-race-"));
    const jobsPath = path.join(jobsDir, "twilio_inbound_jobs.json");
    const pathBefore = process.env.TWILIO_INBOUND_JOBS_PATH;
    process.env.TWILIO_INBOUND_JOBS_PATH = jobsPath; // read at module import, so set it first
    try {
      const jobs = await import("../services/api/src/domain/twilioInboundJobStore.ts");
      const enqueued = 6;
      for (let i = 0; i < enqueued; i += 1) {
        await jobs.enqueueTwilioInboundJob({
          payload: { From: `+1716555${String(1000 + i)}`, Body: `race ${i}`, MessageSid: `SM_race_${i}` }
        } as any);
      }
      const flushes = await Promise.allSettled(
        Array.from({ length: 8 }, () => jobs.flushTwilioInboundJobs())
      );
      const failedFlushes = flushes.filter(r => r.status === "rejected");
      const firstReason =
        failedFlushes.length > 0
          ? String((failedFlushes[0] as PromiseRejectedResult).reason?.message ?? "").slice(0, 160)
          : "";
      assert.equal(
        failedFlushes.length,
        0,
        `overlapping inbound-job saves must all succeed; ${failedFlushes.length} failed: ${firstReason}`
      );

      const rows = JSON.parse(await fs.readFile(jobsPath, "utf8"));
      assert.ok(Array.isArray(rows), "the inbound job store must be a whole JSON array on disk");
      assert.equal(rows.length, enqueued, "every enqueued inbound job survives an overlapping save");
      const leftovers = (await fs.readdir(jobsDir)).filter(name => name.includes(".tmp"));
      assert.deepEqual(
        leftovers,
        [],
        `no temp files may be left behind (found ${leftovers.join(", ")})`
      );
      console.log(`inbound job store concurrent save ok (${enqueued} jobs kept, 0 saves lost)`);
    } finally {
      if (pathBefore == null) delete process.env.TWILIO_INBOUND_JOBS_PATH;
      else process.env.TWILIO_INBOUND_JOBS_PATH = pathBefore;
    }
  }

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

    // Phase 2 document-store helpers against real Postgres.
    {
      const sp = await import("../services/api/src/domain/storePersistence.ts");
      const envBefore = {
        DATA_BACKEND: process.env.DATA_BACKEND,
        DATABASE_URL: process.env.DATABASE_URL,
        DEALER_ID: process.env.DEALER_ID
      };
      const docDealer = `store_persistence_eval_docs_${Date.now()}`;
      process.env.DATABASE_URL = testDbUrl;
      process.env.DEALER_ID = docDealer;
      const docDir = await fs.mkdtemp(path.join(os.tmpdir(), "store-persistence-doc-pg-"));
      const docPath = path.join(docDir, "settings.json");
      const docText = JSON.stringify({ version: 1, mode: "autopilot" });

      process.env.DATA_BACKEND = "dual_write";
      await sp.writeJsonStoreText({ store: "settings", filePath: docPath, text: docText });
      const fileCopy = await fs.readFile(docPath, "utf8");
      assert.equal(fileCopy, docText, "dual_write must write the file copy");

      process.env.DATA_BACKEND = "postgres";
      await fs.rm(docPath); // pg must satisfy the read on its own
      const fromPg = await sp.readJsonStoreText({ store: "settings", filePath: docPath });
      assert.ok(fromPg, "postgres-mode doc read must come from the database");
      assert.deepEqual(JSON.parse(String(fromPg)), JSON.parse(docText));

      for (const [k, v] of Object.entries(envBefore)) {
        if (v == null) delete process.env[k];
        else process.env[k] = v;
      }
      await sp.closeStorePersistence();
      console.log(`document store postgres round trip ok (dealer=${docDealer})`);
    }
  } else {
    console.log("postgres round trip skipped (DATABASE_URL_TEST not set)");
  }

  console.log("PASS store persistence eval");
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
