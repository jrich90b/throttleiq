import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseCompositeSalesInquiryWithLLM } from "../services/api/src/domain/llmDraft.ts";

type Example = {
  id: string;
  text: string;
  history?: { direction: "in" | "out"; body: string }[];
  lead?: any;
  expected: {
    explicit_request: boolean;
    asks_out_the_door_price: boolean;
    asks_accessory_quote: boolean;
    accessory_item_contains?: string;
    has_fit_or_weight_concern: boolean;
    has_financing_concern: boolean;
  };
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataPath = process.argv[2] ?? path.join(__dirname, "composite_sales_inquiry_examples.json");

const apiKey = process.env.OPENAI_API_KEY ?? "";
if (!apiKey || apiKey.trim() === "..." || apiKey.trim().length < 20) {
  console.error("OPENAI_API_KEY is missing or looks like a placeholder. Set a real key and re-run.");
  process.exit(1);
}

if (process.env.LLM_ENABLED !== "1" || process.env.LLM_COMPOSITE_SALES_INQUIRY_PARSER_ENABLED === "0") {
  console.error("LLM_ENABLED=1 and LLM_COMPOSITE_SALES_INQUIRY_PARSER_ENABLED!=0 are required for this eval.");
  process.exit(1);
}

const raw = await fs.readFile(dataPath, "utf8");
const examples = JSON.parse(raw) as Example[];

let total = 0;
let passed = 0;
const mismatches: string[] = [];
const norm = (value: unknown) => String(value ?? "").trim().toLowerCase();

for (const ex of examples) {
  total += 1;
  const result = await parseCompositeSalesInquiryWithLLM({
    text: ex.text,
    history: ex.history,
    lead: ex.lead
  });
  if (!result) {
    mismatches.push(`[${ex.id}] parser returned null`);
    continue;
  }
  const expected = ex.expected;
  const accessoryOk = expected.accessory_item_contains
    ? result.accessoryItems.some(item => norm(item).includes(norm(expected.accessory_item_contains)))
    : true;
  const ok =
    result.explicitRequest === expected.explicit_request &&
    result.asksOutTheDoorPrice === expected.asks_out_the_door_price &&
    result.asksAccessoryQuote === expected.asks_accessory_quote &&
    result.hasFitOrWeightConcern === expected.has_fit_or_weight_concern &&
    result.hasFinancingConcern === expected.has_financing_concern &&
    accessoryOk;
  if (ok) {
    passed += 1;
    console.log(`PASS ${ex.id}`);
  } else {
    mismatches.push(`[${ex.id}] expected=${JSON.stringify(expected)} got=${JSON.stringify(result)}`);
  }
}

if (mismatches.length) {
  console.log(`Composite sales inquiry parser accuracy: ${passed}/${total}`);
  for (const mismatch of mismatches) console.log(`- ${mismatch}`);
  process.exit(1);
}

console.log(`Composite sales inquiry parser accuracy: ${passed}/${total}`);
console.log("All checks passed.");
