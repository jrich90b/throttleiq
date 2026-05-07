import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

type Example = {
  id: string;
  selectedInboundText: string;
  lastDraftText: string;
  history?: { direction: "in" | "out"; body: string }[];
  hasInventoryWatch?: boolean;
  hasAppointment?: boolean;
  expected: {
    state: string;
    allow_generic_cadence: boolean;
  };
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataPath = process.argv[2] ?? path.join(__dirname, "cadence_regenerate_context_examples.json");

const apiKey = process.env.OPENAI_API_KEY ?? "";
if (!apiKey || apiKey.trim() === "..." || apiKey.trim().length < 20) {
  console.error("OPENAI_API_KEY is missing or looks like a placeholder. Set a real key and re-run.");
  process.exit(1);
}

if (
  process.env.LLM_ENABLED !== "1" ||
  process.env.LLM_CADENCE_REGENERATE_CONTEXT_PARSER_ENABLED === "0"
) {
  console.error(
    "LLM_ENABLED=1 and LLM_CADENCE_REGENERATE_CONTEXT_PARSER_ENABLED!=0 are required for this eval."
  );
  process.exit(1);
}

const raw = await fs.readFile(dataPath, "utf8");
const examples = JSON.parse(raw) as Example[];
const { parseCadenceRegenerateContextWithLLM } = await import("../services/api/src/domain/llmDraft.ts");

let total = 0;
let stateOk = 0;
let allowOk = 0;
let nullCount = 0;
const mismatches: string[] = [];

for (const ex of examples) {
  total += 1;
  const result = await parseCadenceRegenerateContextWithLLM({
    selectedInboundText: ex.selectedInboundText,
    lastDraftText: ex.lastDraftText,
    history: ex.history,
    hasInventoryWatch: ex.hasInventoryWatch,
    hasAppointment: ex.hasAppointment,
    dialogState: "inventory_init",
    followUpMode: "active"
  });

  if (!result) {
    nullCount += 1;
    mismatches.push(`[${ex.id}] parser returned null`);
    continue;
  }

  const stateMatch = result.state === ex.expected.state;
  const allowMatch = result.allowGenericCadence === ex.expected.allow_generic_cadence;
  if (stateMatch) stateOk += 1;
  if (allowMatch) allowOk += 1;

  if (!stateMatch || !allowMatch) {
    mismatches.push(
      [
        `[${ex.id}]`,
        `expected=${JSON.stringify(ex.expected)}`,
        `got=${JSON.stringify(result)}`
      ].join(" | ")
    );
  }
}

const pct = (n: number) => (total ? Math.round((n / total) * 1000) / 10 : 0);

console.log(`Cadence regenerate state accuracy: ${stateOk}/${total} (${pct(stateOk)}%)`);
console.log(`Generic cadence allow match: ${allowOk}/${total} (${pct(allowOk)}%)`);
console.log(`Null parses: ${nullCount}/${total}`);
console.log("");

if (mismatches.length) {
  console.log("Mismatches:");
  for (const line of mismatches) console.log(`- ${line}`);
  process.exit(1);
}

console.log("All checks passed.");
