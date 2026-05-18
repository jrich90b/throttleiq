import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseInventoryEntitiesWithLLM } from "../services/api/src/domain/llmDraft.ts";

type Example = {
  id: string;
  text: string;
  history?: { direction: "in" | "out"; body: string }[];
  lead?: any;
  expected: {
    target_type?: string | null;
    is_availability_question?: boolean | null;
    is_test_ride_context?: boolean | null;
    model_contains?: string | null;
    model_not_contains?: string | null;
    year?: number | null;
    color_contains?: string | null;
    stock_id?: string | null;
    condition?: "new" | "used" | "unknown" | null;
    max_price?: number | null;
  };
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataPath = process.argv[2] ?? path.join(__dirname, "inventory_entity_examples.json");

const apiKey = process.env.OPENAI_API_KEY ?? "";
if (!apiKey || apiKey.trim() === "..." || apiKey.trim().length < 20) {
  console.error("OPENAI_API_KEY is missing or looks like a placeholder. Set a real key and re-run.");
  process.exit(1);
}

if (process.env.LLM_ENABLED !== "1" || process.env.LLM_INVENTORY_ENTITY_PARSER_ENABLED === "0") {
  console.error("LLM_ENABLED=1 and LLM_INVENTORY_ENTITY_PARSER_ENABLED!=0 are required for this eval.");
  process.exit(1);
}

const raw = await fs.readFile(dataPath, "utf8");
const examples = JSON.parse(raw) as Example[];

let total = 0;
let ok = 0;
let nullCount = 0;
const mismatches: string[] = [];

const norm = (value: unknown) => String(value ?? "").trim().toLowerCase();

for (const ex of examples) {
  total += 1;
  const result = await parseInventoryEntitiesWithLLM({
    text: ex.text,
    history: ex.history,
    lead: ex.lead
  });

  if (!result) {
    nullCount += 1;
    mismatches.push(`[${ex.id}] parser returned null`);
    continue;
  }

  const checks: boolean[] = [];
  const expected = ex.expected;

  if (Object.hasOwn(expected, "model_contains")) {
    checks.push(
      expected.model_contains == null
        ? !result.model
        : norm(result.model).includes(norm(expected.model_contains))
    );
  }
  if (Object.hasOwn(expected, "model_not_contains")) {
    checks.push(
      expected.model_not_contains == null
        ? true
        : !norm(result.model).includes(norm(expected.model_not_contains))
    );
  }
  if (Object.hasOwn(expected, "target_type")) {
    checks.push(norm(result.targetType) === norm(expected.target_type));
  }
  if (Object.hasOwn(expected, "is_availability_question")) {
    checks.push((result.isAvailabilityQuestion ?? null) === expected.is_availability_question);
  }
  if (Object.hasOwn(expected, "is_test_ride_context")) {
    checks.push((result.isTestRideContext ?? null) === expected.is_test_ride_context);
  }
  if (Object.hasOwn(expected, "year")) {
    checks.push((result.year ?? null) === expected.year);
  }
  if (Object.hasOwn(expected, "color_contains")) {
    checks.push(
      expected.color_contains == null
        ? !result.color
        : norm(result.color).includes(norm(expected.color_contains))
    );
  }
  if (Object.hasOwn(expected, "stock_id")) {
    checks.push(norm(result.stockId) === norm(expected.stock_id));
  }
  if (Object.hasOwn(expected, "condition")) {
    checks.push((result.condition ?? null) === expected.condition);
  }
  if (Object.hasOwn(expected, "max_price")) {
    checks.push((result.maxPrice ?? null) === expected.max_price);
  }

  if (checks.every(Boolean)) {
    ok += 1;
  } else {
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

console.log(`Inventory entity match: ${ok}/${total} (${pct(ok)}%)`);
console.log(`Null parses: ${nullCount}/${total}`);
console.log("");

if (mismatches.length) {
  console.log("Mismatches:");
  for (const line of mismatches) console.log(`- ${line}`);
  process.exit(1);
}

console.log("All checks passed.");
