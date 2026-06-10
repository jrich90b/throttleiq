import { promises as fs } from "node:fs";
import * as path from "node:path";

/**
 * Seed Postgres from the live conversations JSON file.
 * docs/postgres_store_swap.md — rollout step 3. Idempotent; re-runnable.
 *
 * Usage:
 *   DATABASE_URL=postgres://... DEALER_ID=americanharley npm run pg:import
 *   npm run pg:import -- --file /path/to/conversations.json
 */
async function main() {
  const args = process.argv.slice(2);
  const fileArgIdx = args.indexOf("--file");
  const filePath = path.resolve(
    (fileArgIdx >= 0 ? args[fileArgIdx + 1] : "") ||
      process.env.CONVERSATIONS_DB_PATH ||
      path.join(process.env.DATA_DIR || path.resolve(process.cwd(), "services/api/data"), "conversations.json")
  );

  const {
    ensureStoreSchema,
    persistConversationStoreToPostgres,
    closeStorePersistence,
    getDealerId
  } = await import("../services/api/src/domain/storePersistence.ts");

  const raw = await fs.readFile(filePath, "utf8");
  const parsed = JSON.parse(raw) as { conversations?: any[]; todos?: any[]; questions?: any[] };
  const conversations = Array.isArray(parsed?.conversations)
    ? parsed.conversations
    : Object.values(parsed?.conversations ?? {});
  const todos = Array.isArray(parsed?.todos) ? parsed.todos : Object.values(parsed?.todos ?? {});
  const questions = Array.isArray(parsed?.questions)
    ? parsed.questions
    : Object.values(parsed?.questions ?? {});

  const rows = conversations
    .filter(c => String(c?.id ?? "").trim())
    .map(c => ({
      id: String(c.id),
      leadKey: String(c.leadKey ?? ""),
      payloadJson: JSON.stringify(c)
    }));

  await ensureStoreSchema();
  await persistConversationStoreToPostgres({
    rows,
    removedIds: [],
    todosJson: JSON.stringify(todos),
    questionsJson: JSON.stringify(questions)
  });
  await closeStorePersistence();

  console.log(
    `pg:import ok dealer=${getDealerId()} file=${filePath} conversations=${rows.length} todos=${todos.length} questions=${questions.length}`
  );
}

main().catch(err => {
  console.error("pg:import failed:", err?.message ?? err);
  process.exit(1);
});
