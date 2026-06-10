import type { Pool } from "pg";

/**
 * Postgres persistence backend for the conversation store.
 *
 * Design: docs/postgres_store_swap.md
 *
 * The conversation store keeps its in-memory Map and mutate-in-place
 * semantics; this module only swaps where the debounced flush lands.
 * Nothing outside conversationStore.ts (and the pg:* ops scripts) should
 * import the read/write functions here.
 *
 * DATA_BACKEND=file (default) never touches this module's pool, so evals,
 * CI, and local dev run without a database.
 */

export type DataBackend = "file" | "dual_write" | "postgres";

export type ConversationStorePayload = {
  conversations: any[];
  todos: any[];
  questions: any[];
};

export function getDataBackend(): DataBackend {
  const raw = String(process.env.DATA_BACKEND ?? "").trim().toLowerCase();
  if (raw === "postgres" || raw === "pg") return "postgres";
  if (raw === "dual_write" || raw === "dual" || raw === "dualwrite" || raw === "dual-write") {
    return "dual_write";
  }
  return "file";
}

export function getDealerId(): string {
  return (
    process.env.DEALER_ID?.trim() ||
    process.env.DEALER_SLUG?.trim() ||
    "americanharley"
  );
}

export function isFileSnapshotEnabled(): boolean {
  return String(process.env.FILE_SNAPSHOT ?? "").trim() === "1";
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS conversations (
  dealer_id  text        NOT NULL,
  id         text        NOT NULL,
  lead_key   text        NOT NULL DEFAULT '',
  payload    jsonb       NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (dealer_id, id)
);
CREATE INDEX IF NOT EXISTS conversations_lead_key_idx
  ON conversations (dealer_id, lead_key);
CREATE TABLE IF NOT EXISTS store_documents (
  dealer_id  text        NOT NULL,
  store      text        NOT NULL,
  id         text        NOT NULL,
  payload    jsonb       NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (dealer_id, store, id)
);
`;

let pool: Pool | null = null;
let schemaReady = false;

function resolvePoolSsl(): { rejectUnauthorized: boolean } | undefined {
  const raw = String(process.env.PG_SSL ?? "").trim();
  if (raw === "1" || raw.toLowerCase() === "true") return { rejectUnauthorized: false };
  // Otherwise defer to DATABASE_URL params (e.g. ?sslmode=require).
  return undefined;
}

async function getPool(): Promise<Pool> {
  if (pool) return pool;
  const url = process.env.DATABASE_URL?.trim();
  if (!url) {
    throw new Error("DATABASE_URL is required when DATA_BACKEND is not 'file'");
  }
  const { Pool: PgPool } = await import("pg");
  pool = new PgPool({
    connectionString: url,
    max: Number(process.env.PG_POOL_MAX ?? 5),
    connectionTimeoutMillis: Number(process.env.PG_CONNECT_TIMEOUT_MS ?? 10_000),
    ssl: resolvePoolSsl()
  });
  return pool;
}

export async function ensureStoreSchema(): Promise<void> {
  if (schemaReady) return;
  const db = await getPool();
  await db.query(SCHEMA_SQL);
  schemaReady = true;
}

export async function loadConversationStoreFromPostgres(): Promise<ConversationStorePayload> {
  await ensureStoreSchema();
  const db = await getPool();
  const dealerId = getDealerId();
  const convRes = await db.query(
    "SELECT payload FROM conversations WHERE dealer_id = $1",
    [dealerId]
  );
  const docRes = await db.query(
    "SELECT store, payload FROM store_documents WHERE dealer_id = $1 AND store = ANY($2) AND id = 'all'",
    [dealerId, ["todos", "questions"]]
  );
  let todos: any[] = [];
  let questions: any[] = [];
  for (const row of docRes.rows) {
    if (row.store === "todos" && Array.isArray(row.payload)) todos = row.payload;
    if (row.store === "questions" && Array.isArray(row.payload)) questions = row.payload;
  }
  notePostgresSuccess();
  return {
    conversations: convRes.rows.map(r => r.payload),
    todos,
    questions
  };
}

export type ConversationUpsertRow = {
  id: string;
  leadKey: string;
  /** Pre-serialized JSON so the snapshot is taken synchronously at flush time. */
  payloadJson: string;
};

export async function persistConversationStoreToPostgres(args: {
  rows: ConversationUpsertRow[];
  removedIds: string[];
  todosJson: string;
  questionsJson: string;
}): Promise<void> {
  await ensureStoreSchema();
  const db = await getPool();
  const dealerId = getDealerId();
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    for (const row of args.rows) {
      await client.query(
        `INSERT INTO conversations (dealer_id, id, lead_key, payload, updated_at)
         VALUES ($1, $2, $3, $4::jsonb, now())
         ON CONFLICT (dealer_id, id)
         DO UPDATE SET lead_key = EXCLUDED.lead_key, payload = EXCLUDED.payload, updated_at = now()`,
        [dealerId, row.id, row.leadKey, row.payloadJson]
      );
    }
    if (args.removedIds.length) {
      await client.query(
        "DELETE FROM conversations WHERE dealer_id = $1 AND id = ANY($2)",
        [dealerId, args.removedIds]
      );
    }
    for (const [store, payloadJson] of [
      ["todos", args.todosJson],
      ["questions", args.questionsJson]
    ] as const) {
      await client.query(
        `INSERT INTO store_documents (dealer_id, store, id, payload, updated_at)
         VALUES ($1, $2, 'all', $3::jsonb, now())
         ON CONFLICT (dealer_id, store, id)
         DO UPDATE SET payload = EXCLUDED.payload, updated_at = now()`,
        [dealerId, store, payloadJson]
      );
    }
    await client.query("COMMIT");
    notePostgresSuccess();
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // connection-level failures can make ROLLBACK itself fail; ignore.
    }
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Degraded-mode tracking: when Postgres has been failing for longer than
 * PG_DEGRADED_AFTER_MS (default 2 minutes), the store forces JSON file
 * snapshots back on so an outage never leaves writes memory-only.
 */
let firstFailureAtMs: number | null = null;

export function notePostgresFailure(): void {
  if (firstFailureAtMs == null) firstFailureAtMs = Date.now();
}

export function notePostgresSuccess(): void {
  firstFailureAtMs = null;
}

export function isPostgresDegraded(): boolean {
  if (firstFailureAtMs == null) return false;
  const thresholdMs = Number(process.env.PG_DEGRADED_AFTER_MS ?? 120_000);
  return Date.now() - firstFailureAtMs >= thresholdMs;
}

/** For ops scripts; the API process keeps its pool for its lifetime. */
export async function closeStorePersistence(): Promise<void> {
  const p = pool;
  pool = null;
  schemaReady = false;
  if (p) await p.end();
}

/**
 * Phase 2: generic single-document JSON stores (docs/postgres_store_swap.md).
 *
 * Each small store file maps to one row in store_documents
 * (dealer_id, store, 'all'). Store modules call readJsonStoreText /
 * writeJsonStoreText instead of fs directly; backend dispatch matches the
 * conversation store: file (default, fs only), dual_write (fs + best-effort
 * Postgres mirror), postgres (Postgres first, file fallback/snapshot).
 */

/** Store-document name -> default DATA_DIR filename. Used by pg:import/export/parity. */
export const STORE_DOCUMENT_FILES: ReadonlyArray<{ store: string; filename: string }> = [
  { store: "contacts", filename: "contacts.json" },
  { store: "contact_lists", filename: "contact_lists.json" },
  { store: "campaigns", filename: "campaigns.json" },
  { store: "users", filename: "users.json" },
  { store: "sessions", filename: "sessions.json" },
  { store: "password_resets", filename: "password_resets.json" },
  { store: "settings", filename: "settings.json" },
  { store: "suppressions", filename: "suppressions.json" },
  { store: "agent_tasks", filename: "agent_tasks.json" },
  { store: "dealer_setups", filename: "dealer_setups.json" },
  { store: "active_clients", filename: "active_clients.json" },
  { store: "mdf_claims", filename: "mdf_claims.json" }
];

async function readFileTextOrNull(filePath: string): Promise<string | null> {
  const { promises: fs } = await import("node:fs");
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (err: any) {
    if (err?.code === "ENOENT") return null;
    throw err;
  }
}

async function writeFileTextAtomic(filePath: string, text: string): Promise<void> {
  const { promises: fs } = await import("node:fs");
  const path = await import("node:path");
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  await fs.writeFile(tmp, text, "utf8");
  await fs.rename(tmp, filePath);
}

export async function readStoreDocumentText(store: string): Promise<string | null> {
  await ensureStoreSchema();
  const db = await getPool();
  const res = await db.query(
    "SELECT payload FROM store_documents WHERE dealer_id = $1 AND store = $2 AND id = 'all'",
    [getDealerId(), store]
  );
  if (!res.rows.length) return null;
  notePostgresSuccess();
  return JSON.stringify(res.rows[0].payload);
}

export async function writeStoreDocumentText(store: string, payloadJson: string): Promise<void> {
  await ensureStoreSchema();
  const db = await getPool();
  await db.query(
    `INSERT INTO store_documents (dealer_id, store, id, payload, updated_at)
     VALUES ($1, $2, 'all', $3::jsonb, now())
     ON CONFLICT (dealer_id, store, id)
     DO UPDATE SET payload = EXCLUDED.payload, updated_at = now()`,
    [getDealerId(), store, payloadJson]
  );
  notePostgresSuccess();
}

/**
 * Read a JSON store: returns the raw JSON text or null when the store has no
 * data yet (missing file / missing row). Callers keep their existing
 * parse + default-on-missing logic.
 */
export async function readJsonStoreText(args: {
  store: string;
  filePath: string;
}): Promise<string | null> {
  if (getDataBackend() !== "postgres") {
    return readFileTextOrNull(args.filePath);
  }
  try {
    const fromPg = await readStoreDocumentText(args.store);
    if (fromPg != null) return fromPg;
    // No row yet (store not seeded): fall back to the file so first deploys
    // after enabling postgres mode never lose existing data.
    return await readFileTextOrNull(args.filePath);
  } catch (err: any) {
    notePostgresFailure();
    console.warn(
      `⚠️ Postgres read failed for store '${args.store}'; falling back to file:`,
      err?.message ?? err
    );
    return readFileTextOrNull(args.filePath);
  }
}

/**
 * Write a JSON store document. The text must be valid JSON.
 * file: atomic file write. dual_write: file write + best-effort Postgres
 * mirror. postgres: Postgres write + file snapshot when FILE_SNAPSHOT=1,
 * degraded, or the Postgres write failed.
 */
export async function writeJsonStoreText(args: {
  store: string;
  filePath: string;
  text: string;
}): Promise<void> {
  const backend = getDataBackend();
  if (backend === "file") {
    await writeFileTextAtomic(args.filePath, args.text);
    return;
  }
  if (backend === "dual_write") {
    await writeFileTextAtomic(args.filePath, args.text);
    try {
      await writeStoreDocumentText(args.store, args.text);
    } catch (err: any) {
      notePostgresFailure();
      console.warn(
        `⚠️ Postgres mirror write failed for store '${args.store}' (file saved):`,
        err?.message ?? err
      );
    }
    return;
  }
  // backend === "postgres"
  let pgOk = true;
  try {
    await writeStoreDocumentText(args.store, args.text);
  } catch (err: any) {
    pgOk = false;
    notePostgresFailure();
    console.warn(
      `⚠️ Postgres write failed for store '${args.store}'; writing file fallback:`,
      err?.message ?? err
    );
  }
  if (!pgOk || isFileSnapshotEnabled() || isPostgresDegraded()) {
    await writeFileTextAtomic(args.filePath, args.text);
  }
}
