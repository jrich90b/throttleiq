import { promises as fs } from "node:fs";
import * as path from "node:path";

/**
 * Export the Postgres conversation store back to a JSON snapshot file.
 * docs/postgres_store_swap.md — rollback path after file snapshots stop.
 *
 * Usage:
 *   DATABASE_URL=postgres://... npm run pg:export -- --out /tmp/conversations.from_pg.json
 *
 * Refuses to overwrite the live conversations.json unless --force is passed.
 */
async function main() {
  const args = process.argv.slice(2);
  const outIdx = args.indexOf("--out");
  const force = args.includes("--force");
  const dataDir = process.env.DATA_DIR || path.resolve(process.cwd(), "services/api/data");
  const outPath = path.resolve(
    (outIdx >= 0 ? args[outIdx + 1] : "") || path.join(dataDir, "conversations.from_pg.json")
  );
  const livePath = path.resolve(process.env.CONVERSATIONS_DB_PATH || path.join(dataDir, "conversations.json"));
  if (outPath === livePath && !force) {
    console.error(
      `pg:export refusing to overwrite the live store at ${livePath}; pass --force for a deliberate restore.`
    );
    process.exit(1);
  }

  const {
    loadConversationStoreFromPostgres,
    readStoreDocumentText,
    STORE_DOCUMENT_FILES,
    closeStorePersistence,
    getDealerId
  } = await import("../services/api/src/domain/storePersistence.ts");

  const store = await loadConversationStoreFromPostgres();

  const payload = {
    version: 1,
    savedAt: new Date().toISOString(),
    conversations: store.conversations,
    todos: store.todos,
    questions: store.questions
  };
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, JSON.stringify(payload, null, 2), "utf8");

  // Phase 2 documents: export each store document next to the main file as
  // <filename>.from_pg.json so a restore is an explicit rename.
  const exportedDocs: string[] = [];
  for (const { store: docStore, filename } of STORE_DOCUMENT_FILES) {
    const text = await readStoreDocumentText(docStore);
    if (text == null) continue;
    const docOut = path.join(path.dirname(outPath), `${filename.replace(/\.json$/, "")}.from_pg.json`);
    await fs.writeFile(docOut, text, "utf8");
    exportedDocs.push(docStore);
  }
  await closeStorePersistence();

  console.log(
    `pg:export ok dealer=${getDealerId()} out=${outPath} conversations=${store.conversations.length} todos=${store.todos.length} questions=${store.questions.length} docs=[${exportedDocs.join(",")}]`
  );
}

main().catch(err => {
  console.error("pg:export failed:", err?.message ?? err);
  process.exit(1);
});
