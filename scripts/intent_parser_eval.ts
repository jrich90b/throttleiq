import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseIntentWithLLM } from "../services/api/src/domain/llmDraft.ts";

type Example = {
  id: string;
  text: string;
  history?: { direction: "in" | "out"; body: string }[];
  lead?: any;
  expected: {
    intent: "callback" | "test_ride" | "availability" | "none";
    intent_any?: Array<"callback" | "test_ride" | "availability" | "none">;
    explicit_request: boolean;
    availability?: {
      model?: string;
      year?: string;
      color?: string;
      stock_id?: string;
      condition?: "new" | "used" | "unknown";
    };
  };
};

function normalizeStr(value: string | null | undefined): string {
  return String(value ?? "").trim().toLowerCase();
}

function availabilityMatches(expected: Example["expected"]["availability"], actual: any): boolean {
  if (!expected) return true;
  if (!actual || typeof actual !== "object") return false;
  const checks: Array<[string, string | undefined, string | null | undefined]> = [
    ["model", expected.model, actual.model],
    ["year", expected.year, actual.year],
    ["color", expected.color, actual.color],
    ["stock_id", expected.stock_id, actual.stockId ?? actual.stock_id],
    ["condition", expected.condition, actual.condition]
  ];
  for (const [key, expectedVal, actualVal] of checks) {
    if (!expectedVal) continue;
    const exp = normalizeStr(expectedVal);
    const act = normalizeStr(actualVal);
    if (!act) return false;
    if (key === "year") {
      if (exp !== act) return false;
    } else if (!act.includes(exp)) {
      return false;
    }
  }
  return true;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataPath = process.argv[2] ?? path.join(__dirname, "intent_parser_examples.json");

const apiKey = process.env.OPENAI_API_KEY ?? "";
if (!apiKey || apiKey.trim() === "..." || apiKey.trim().length < 20) {
  console.error("OPENAI_API_KEY is missing or looks like a placeholder. Set a real key and re-run.");
  process.exit(1);
}

if (process.env.LLM_ENABLED !== "1" || process.env.LLM_INTENT_PARSER_ENABLED !== "1") {
  console.error("LLM_ENABLED=1 and LLM_INTENT_PARSER_ENABLED=1 are required for this eval.");
  process.exit(1);
}

const raw = await fs.readFile(dataPath, "utf8");
const examples = JSON.parse(raw) as Example[];

let intentOk = 0;
let explicitOk = 0;
let availOk = 0;
let total = 0;
let nullCount = 0;

const mismatches: string[] = [];

for (const ex of examples) {
  total += 1;
  const result = await parseIntentWithLLM({
    text: ex.text,
    history: ex.history,
    lead: ex.lead
  });

  if (!result) {
    nullCount += 1;
    mismatches.push(
      `[${ex.id}] parser returned null | expected intent=${ex.expected.intent} explicit=${ex.expected.explicit_request}`
    );
    continue;
  }

  const expectedIntents = ex.expected.intent_any?.length ? ex.expected.intent_any : [ex.expected.intent];
  const intentMatch = expectedIntents.includes(result.intent);
  const explicitMatch = result.explicitRequest === ex.expected.explicit_request;
  const availabilityMatch = availabilityMatches(ex.expected.availability, result.availability);

  if (intentMatch) intentOk += 1;
  if (explicitMatch) explicitOk += 1;
  if (availabilityMatch) availOk += 1;

  if (!intentMatch || !explicitMatch || !availabilityMatch) {
    mismatches.push(
      [
        `[${ex.id}]`,
        `text="${ex.text}"`,
        `expected intent=${ex.expected.intent}${ex.expected.intent_any ? " (any)" : ""}`,
        `expected explicit=${ex.expected.explicit_request}`,
        `got intent=${result.intent}`,
        `got explicit=${result.explicitRequest}`,
        `got availability=${JSON.stringify(result.availability ?? null)}`
      ].join(" | ")
    );
  }
}

const pct = (n: number) => (total ? Math.round((n / total) * 1000) / 10 : 0);

console.log(`Intent accuracy: ${intentOk}/${total} (${pct(intentOk)}%)`);
console.log(`Explicit accuracy: ${explicitOk}/${total} (${pct(explicitOk)}%)`);
console.log(`Availability field match: ${availOk}/${total} (${pct(availOk)}%)`);
console.log(`Null parses: ${nullCount}/${total}`);
console.log("");

if (mismatches.length) {
  console.log("Mismatches:");
  for (const line of mismatches) console.log(`- ${line}`);
} else {
  console.log("All checks passed.");
}
