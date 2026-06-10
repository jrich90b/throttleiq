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
