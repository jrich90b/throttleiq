import { promises as fs } from "node:fs";
import * as path from "node:path";

/**
 * Compare the JSON file store against Postgres during the dual-write shadow
 * window. docs/postgres_store_swap.md — rollout step 4; any mismatch is a
 * stop-the-line signal before flipping reads.
 *
 * Usage:
 *   DATABASE_URL=postgres://... npm run pg:parity
 *   npm run pg:parity -- --out /path/report.json
 *
 * Exits 1 on mismatch.
 */

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

async function main() {
  const args = process.argv.slice(2);
  const outIdx = args.indexOf("--out");
  const dataDir = process.env.DATA_DIR || path.resolve(process.cwd(), "services/api/data");
  const filePath = path.resolve(
    process.env.CONVERSATIONS_DB_PATH || path.join(dataDir, "conversations.json")
  );
  const reportRoot = process.env.REPORT_ROOT || path.resolve(process.cwd(), "reports");
  const outPath = path.resolve(
    (outIdx >= 0 ? args[outIdx + 1] : "") || path.join(reportRoot, "pg_parity", "pg_parity_report.json")
  );

  const {
    loadConversationStoreFromPostgres,
    readStoreDocumentText,
    STORE_DOCUMENT_FILES,
    closeStorePersistence,
    getDealerId
  } = await import("../services/api/src/domain/storePersistence.ts");

  const raw = await fs.readFile(filePath, "utf8");
  const parsed = JSON.parse(raw) as { conversations?: any[]; todos?: any[]; questions?: any[] };
  const fileConversations: any[] = Array.isArray(parsed?.conversations)
    ? parsed.conversations
    : Object.values(parsed?.conversations ?? {});
  const fileTodos = Array.isArray(parsed?.todos) ? parsed.todos : Object.values(parsed?.todos ?? {});
  const fileQuestions = Array.isArray(parsed?.questions)
    ? parsed.questions
    : Object.values(parsed?.questions ?? {});

  const pg = await loadConversationStoreFromPostgres();

  // Phase 2 documents: compare each store file against its Postgres mirror.
  const docResults: Array<{ store: string; status: "match" | "mismatch" | "missing_in_pg" | "missing_file" | "absent" }> = [];
  for (const { store, filename } of STORE_DOCUMENT_FILES) {
    const docFilePath = path.join(path.dirname(filePath), filename);
    let fileText: string | null = null;
    try {
      fileText = await fs.readFile(docFilePath, "utf8");
    } catch (err: any) {
      if (err?.code !== "ENOENT") throw err;
    }
    const pgText = await readStoreDocumentText(store);
    if (fileText == null && pgText == null) {
      docResults.push({ store, status: "absent" });
    } else if (pgText == null) {
      docResults.push({ store, status: "missing_in_pg" });
    } else if (fileText == null) {
      docResults.push({ store, status: "missing_file" });
    } else {
      const match = stableStringify(JSON.parse(fileText)) === stableStringify(JSON.parse(pgText));
      docResults.push({ store, status: match ? "match" : "mismatch" });
    }
  }
  await closeStorePersistence();
  const docsOk = docResults.every(r => r.status === "match" || r.status === "absent");

  const fileById = new Map<string, any>(
    fileConversations.filter(c => String(c?.id ?? "").trim()).map(c => [String(c.id), c])
  );
  const pgById = new Map<string, any>(
    pg.conversations.filter(c => String(c?.id ?? "").trim()).map(c => [String(c.id), c])
  );

  const missingInPg: string[] = [];
  const changed: string[] = [];
  for (const [id, conv] of fileById) {
    const other = pgById.get(id);
    if (!other) {
      missingInPg.push(id);
      continue;
    }
    if (stableStringify(conv) !== stableStringify(other)) changed.push(id);
  }
  const extraInPg = Array.from(pgById.keys()).filter(id => !fileById.has(id));
  const todosMatch = stableStringify(fileTodos) === stableStringify(pg.todos);
  const questionsMatch = stableStringify(fileQuestions) === stableStringify(pg.questions);

  const ok =
    missingInPg.length === 0 &&
    extraInPg.length === 0 &&
    changed.length === 0 &&
    todosMatch &&
    questionsMatch &&
    docsOk;

  const report = {
    generatedAt: new Date().toISOString(),
    dealerId: getDealerId(),
    filePath,
    ok,
    counts: {
      fileConversations: fileById.size,
      pgConversations: pgById.size,
      fileTodos: fileTodos.length,
      pgTodos: pg.todos.length,
      fileQuestions: fileQuestions.length,
      pgQuestions: pg.questions.length
    },
    missingInPg: missingInPg.slice(0, 20),
    extraInPg: extraInPg.slice(0, 20),
    changed: changed.slice(0, 20),
    todosMatch,
    questionsMatch,
    documents: docResults
  };

  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, JSON.stringify(report, null, 2), "utf8");
  const docSummary = docResults
    .filter(r => r.status !== "absent")
    .map(r => `${r.store}=${r.status}`)
    .join(",");
  console.log(
    `pg:parity ${ok ? "OK" : "MISMATCH"} file=${fileById.size} pg=${pgById.size} missingInPg=${missingInPg.length} extraInPg=${extraInPg.length} changed=${changed.length} todosMatch=${todosMatch} questionsMatch=${questionsMatch} docs=[${docSummary}] report=${outPath}`
  );
  if (!ok) process.exit(1);
}

main().catch(err => {
  console.error("pg:parity failed:", err?.message ?? err);
  process.exit(1);
});
