import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseSemanticSlotsWithLLM } from "../services/api/src/domain/llmDraft.ts";

type WatchAction = "set_watch" | "stop_watch" | "none";
type DepartmentIntent = "service" | "parts" | "apparel" | "none";

type Example = {
  id: string;
  text: string;
  history?: { direction: "in" | "out"; body: string }[];
  expected: {
    watch_action: WatchAction;
    watch_action_any?: WatchAction[];
    department_intent: DepartmentIntent;
    department_intent_any?: DepartmentIntent[];
    watch_model_contains?: string;
    watch_color_contains?: string;
    watch_condition?: "new" | "used" | "any" | "unknown";
  };
};

function norm(value: string | null | undefined): string {
  return String(value ?? "").trim().toLowerCase();
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataPath = process.argv[2] ?? path.join(__dirname, "semantic_slot_examples.json");

const apiKey = process.env.OPENAI_API_KEY ?? "";
if (!apiKey || apiKey.trim() === "..." || apiKey.trim().length < 20) {
  console.error("OPENAI_API_KEY is missing or looks like a placeholder. Set a real key and re-run.");
  process.exit(1);
}

if (process.env.LLM_ENABLED !== "1" || process.env.LLM_SEMANTIC_SLOT_PARSER_ENABLED !== "1") {
  console.error("LLM_ENABLED=1 and LLM_SEMANTIC_SLOT_PARSER_ENABLED=1 are required for this eval.");
  process.exit(1);
}

const raw = await fs.readFile(dataPath, "utf8");
const examples = JSON.parse(raw) as Example[];

let watchActionOk = 0;
let departmentOk = 0;
let modelOk = 0;
let colorOk = 0;
let conditionOk = 0;
let total = 0;
let nullCount = 0;
let modelAsserts = 0;
let colorAsserts = 0;
let conditionAsserts = 0;

const mismatches: string[] = [];

for (const ex of examples) {
  total += 1;
  const result = await parseSemanticSlotsWithLLM({
    text: ex.text,
    history: ex.history
  });

  if (!result) {
    nullCount += 1;
    mismatches.push(
      `[${ex.id}] parser returned null | expected watch_action=${ex.expected.watch_action} department_intent=${ex.expected.department_intent}`
    );
    continue;
  }

  const expectedWatchActions = ex.expected.watch_action_any?.length
    ? ex.expected.watch_action_any
    : [ex.expected.watch_action];
  const expectedDepartmentIntents = ex.expected.department_intent_any?.length
    ? ex.expected.department_intent_any
    : [ex.expected.department_intent];

  const watchActionMatch = expectedWatchActions.includes(result.watchAction);
  const departmentMatch = expectedDepartmentIntents.includes(result.departmentIntent);

  if (watchActionMatch) watchActionOk += 1;
  if (departmentMatch) departmentOk += 1;

  let modelMatch = true;
  if (ex.expected.watch_model_contains) {
    modelAsserts += 1;
    modelMatch = norm(result.watch?.model).includes(norm(ex.expected.watch_model_contains));
    if (modelMatch) modelOk += 1;
  }

  let colorMatch = true;
  if (ex.expected.watch_color_contains) {
    colorAsserts += 1;
    colorMatch = norm(result.watch?.color).includes(norm(ex.expected.watch_color_contains));
    if (colorMatch) colorOk += 1;
  }

  let conditionMatch = true;
  if (ex.expected.watch_condition) {
    conditionAsserts += 1;
    conditionMatch = norm(result.watch?.condition) === norm(ex.expected.watch_condition);
    if (conditionMatch) conditionOk += 1;
  }

  if (!watchActionMatch || !departmentMatch || !modelMatch || !colorMatch || !conditionMatch) {
    mismatches.push(
      [
        `[${ex.id}]`,
        `text="${ex.text}"`,
        `expected watch_action=${ex.expected.watch_action}${ex.expected.watch_action_any ? " (any)" : ""}`,
        `expected department_intent=${ex.expected.department_intent}${ex.expected.department_intent_any ? " (any)" : ""}`,
        ex.expected.watch_model_contains
          ? `expected watch_model_contains=${ex.expected.watch_model_contains}`
          : "",
        ex.expected.watch_color_contains
          ? `expected watch_color_contains=${ex.expected.watch_color_contains}`
          : "",
        ex.expected.watch_condition ? `expected watch_condition=${ex.expected.watch_condition}` : "",
        `got watch_action=${result.watchAction}`,
        `got department_intent=${result.departmentIntent}`,
        `got watch=${JSON.stringify(result.watch ?? null)}`,
        `got confidence=${String(result.confidence ?? null)}`
      ]
        .filter(Boolean)
        .join(" | ")
    );
  }
}

const pct = (n: number, d: number) => (d ? Math.round((n / d) * 1000) / 10 : 0);

console.log(`Watch-action accuracy: ${watchActionOk}/${total} (${pct(watchActionOk, total)}%)`);
console.log(`Department accuracy: ${departmentOk}/${total} (${pct(departmentOk, total)}%)`);
if (modelAsserts > 0) {
  console.log(`Watch model match: ${modelOk}/${modelAsserts} (${pct(modelOk, modelAsserts)}%)`);
}
if (colorAsserts > 0) {
  console.log(`Watch color match: ${colorOk}/${colorAsserts} (${pct(colorOk, colorAsserts)}%)`);
}
if (conditionAsserts > 0) {
  console.log(
    `Watch condition match: ${conditionOk}/${conditionAsserts} (${pct(conditionOk, conditionAsserts)}%)`
  );
}
console.log(`Null parses: ${nullCount}/${total}`);
console.log("");

if (mismatches.length) {
  console.log("Mismatches:");
  for (const line of mismatches) console.log(`- ${line}`);
} else {
  console.log("All checks passed.");
}
