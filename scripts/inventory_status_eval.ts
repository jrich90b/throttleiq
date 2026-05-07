import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseInventoryStatusWithLLM } from "../services/api/src/domain/llmDraft.ts";

type Example = {
  id: string;
  text: string;
  has_inbound_media?: boolean;
  history?: { direction: "in" | "out"; body: string }[];
  lead?: any;
  expected: {
    intent: string;
    explicit_request: boolean;
    model_contains?: string | null;
    year?: number | null;
    color_contains?: string | null;
    stock_id?: string | null;
  };
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataPath = process.argv[2] ?? path.join(__dirname, "inventory_status_examples.json");

const apiKey = process.env.OPENAI_API_KEY ?? "";
if (!apiKey || apiKey.trim() === "..." || apiKey.trim().length < 20) {
  console.error("OPENAI_API_KEY is missing or looks like a placeholder. Set a real key and re-run.");
  process.exit(1);
}

if (process.env.LLM_ENABLED !== "1" || process.env.LLM_INVENTORY_STATUS_PARSER_ENABLED === "0") {
  console.error("LLM_ENABLED=1 and LLM_INVENTORY_STATUS_PARSER_ENABLED!=0 are required for this eval.");
  process.exit(1);
}

const raw = await fs.readFile(dataPath, "utf8");
const examples = JSON.parse(raw) as Example[];

let total = 0;
let intentOk = 0;
let explicitOk = 0;
let entityOk = 0;
let nullCount = 0;
const mismatches: string[] = [];

const norm = (value: unknown) => String(value ?? "").trim().toLowerCase();

for (const ex of examples) {
  total += 1;
  const result = await parseInventoryStatusWithLLM({
    text: ex.text,
    history: ex.history,
    lead: ex.lead,
    hasInboundMedia: !!ex.has_inbound_media
  });

  if (!result) {
    nullCount += 1;
    mismatches.push(`[${ex.id}] parser returned null`);
    continue;
  }

  const expected = ex.expected;
  const intentMatch = result.intent === expected.intent;
  const explicitMatch = result.explicitRequest === expected.explicit_request;
  const entityChecks: boolean[] = [];

  if (Object.hasOwn(expected, "model_contains")) {
    entityChecks.push(
      expected.model_contains == null
        ? !result.target?.model
        : norm(result.target?.model).includes(norm(expected.model_contains))
    );
  }
  if (Object.hasOwn(expected, "year")) {
    entityChecks.push((result.target?.year ?? null) === expected.year);
  }
  if (Object.hasOwn(expected, "color_contains")) {
    entityChecks.push(
      expected.color_contains == null
        ? !result.target?.color
        : norm(result.target?.color).includes(norm(expected.color_contains))
    );
  }
  if (Object.hasOwn(expected, "stock_id")) {
    entityChecks.push(norm(result.target?.stockId) === norm(expected.stock_id));
  }
  const entityMatch = entityChecks.every(Boolean);

  if (intentMatch) intentOk += 1;
  if (explicitMatch) explicitOk += 1;
  if (entityMatch) entityOk += 1;

  if (!intentMatch || !explicitMatch || !entityMatch) {
    mismatches.push(
      [
        `[${ex.id}]`,
        `text="${ex.text}"`,
        `expected=${JSON.stringify(expected)}`,
        `got=${JSON.stringify(result)}`
      ].join(" | ")
    );
  }
}

const pct = (n: number) => (total ? Math.round((n / total) * 1000) / 10 : 0);

console.log(`Inventory status intent accuracy: ${intentOk}/${total} (${pct(intentOk)}%)`);
console.log(`Explicit accuracy: ${explicitOk}/${total} (${pct(explicitOk)}%)`);
console.log(`Inventory status entity match: ${entityOk}/${total} (${pct(entityOk)}%)`);
console.log(`Null parses: ${nullCount}/${total}`);
console.log("");

if (mismatches.length) {
  console.log("Mismatches:");
  for (const line of mismatches) console.log(`- ${line}`);
  process.exit(1);
}

console.log("All checks passed.");
