import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseVehicleInfoRequestWithLLM } from "../services/api/src/domain/llmDraft.ts";

type Expected = {
  intent: "specs" | "compare" | "none";
  explicit_request: boolean;
  focus?: "engine" | "features" | "dimensions" | "accessories" | "general" | "unknown";
  format?: "full" | "highlights" | "unknown";
};

type Fixture = {
  id: string;
  text: string;
  history?: { direction: "in" | "out"; body: string }[];
  lead?: any;
  expected: Expected;
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataPath = process.argv[2] ?? path.join(__dirname, "vehicle_info_request_examples.json");

const apiKey = process.env.OPENAI_API_KEY ?? "";
if (!apiKey || apiKey.trim() === "..." || apiKey.trim().length < 20) {
  console.error("OPENAI_API_KEY is missing or looks like a placeholder. Set a real key and re-run.");
  process.exit(1);
}

if (process.env.LLM_ENABLED !== "1" || process.env.LLM_VEHICLE_INFO_PARSER_ENABLED === "0") {
  console.error("LLM_ENABLED=1 and LLM_VEHICLE_INFO_PARSER_ENABLED!=0 are required for this eval.");
  process.exit(1);
}

const raw = await fs.readFile(dataPath, "utf8");
const fixtures = JSON.parse(raw) as Fixture[];

let intentOk = 0;
let explicitOk = 0;
let focusOk = 0;
let formatOk = 0;
let nullCount = 0;
const mismatches: string[] = [];

for (const fixture of fixtures) {
  const parsed = await parseVehicleInfoRequestWithLLM({
    text: fixture.text,
    history: fixture.history,
    lead: fixture.lead
  });

  if (!parsed) {
    nullCount += 1;
    mismatches.push(
      `[${fixture.id}] parser returned null | expected intent=${fixture.expected.intent} explicit=${fixture.expected.explicit_request}`
    );
    continue;
  }

  const intentMatch = parsed.intent === fixture.expected.intent;
  const explicitMatch = parsed.explicitRequest === fixture.expected.explicit_request;
  const focusMatch = !fixture.expected.focus || parsed.focus === fixture.expected.focus;
  const formatMatch = !fixture.expected.format || parsed.format === fixture.expected.format;

  if (intentMatch) intentOk += 1;
  if (explicitMatch) explicitOk += 1;
  if (focusMatch) focusOk += 1;
  if (formatMatch) formatOk += 1;

  if (!intentMatch || !explicitMatch || !focusMatch || !formatMatch) {
    mismatches.push(
      [
        `[${fixture.id}]`,
        `text="${fixture.text}"`,
        `expected intent=${fixture.expected.intent}`,
        `expected explicit=${fixture.expected.explicit_request}`,
        fixture.expected.focus ? `expected focus=${fixture.expected.focus}` : null,
        fixture.expected.format ? `expected format=${fixture.expected.format}` : null,
        `got intent=${parsed.intent}`,
        `got explicit=${parsed.explicitRequest}`,
        `got focus=${parsed.focus}`,
        `got format=${parsed.format}`,
        `got confidence=${parsed.confidence ?? null}`
      ]
        .filter(Boolean)
        .join(" | ")
    );
  }
}

const total = fixtures.length;
const pct = (n: number) => (total ? Math.round((n / total) * 1000) / 10 : 0);

console.log(`Vehicle info intent accuracy: ${intentOk}/${total} (${pct(intentOk)}%)`);
console.log(`Explicit accuracy: ${explicitOk}/${total} (${pct(explicitOk)}%)`);
console.log(`Focus match: ${focusOk}/${total} (${pct(focusOk)}%)`);
console.log(`Format match: ${formatOk}/${total} (${pct(formatOk)}%)`);
console.log(`Null parses: ${nullCount}/${total}`);
console.log("");

if (mismatches.length) {
  console.log("Mismatches:");
  for (const mismatch of mismatches) console.log(`- ${mismatch}`);
  process.exit(1);
}

console.log("All checks passed.");
