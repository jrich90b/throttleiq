import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseUnifiedSemanticSlotsWithLLM } from "../services/api/src/domain/llmDraft.ts";

type WatchAction = "set_watch" | "stop_watch" | "none";
type DepartmentIntent = "service" | "parts" | "apparel" | "none";
type PayoffStatus = "unknown" | "no_lien" | "has_lien";

type SemanticExample = {
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

type TradeExample = {
  id: string;
  text: string;
  history?: { direction: "in" | "out"; body: string }[];
  lead?: any;
  tradePayoff?: any;
  expected: {
    payoff_status: PayoffStatus;
    payoff_status_any?: PayoffStatus[];
    needs_lien_holder_info: boolean;
    provides_lien_holder_info: boolean;
  };
};

function norm(value: string | null | undefined): string {
  return String(value ?? "").trim().toLowerCase();
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const semanticPath = process.argv[2] ?? path.join(__dirname, "semantic_slot_examples.json");
const tradePath = process.argv[3] ?? path.join(__dirname, "trade_payoff_examples.json");

const apiKey = process.env.OPENAI_API_KEY ?? "";
if (!apiKey || apiKey.trim() === "..." || apiKey.trim().length < 20) {
  console.error("OPENAI_API_KEY is missing or looks like a placeholder. Set a real key and re-run.");
  process.exit(1);
}
if (process.env.LLM_ENABLED !== "1" || process.env.LLM_UNIFIED_SLOT_PARSER_ENABLED !== "1") {
  console.error("LLM_ENABLED=1 and LLM_UNIFIED_SLOT_PARSER_ENABLED=1 are required for this eval.");
  process.exit(1);
}

const [semanticRaw, tradeRaw] = await Promise.all([
  fs.readFile(semanticPath, "utf8"),
  fs.readFile(tradePath, "utf8")
]);
const semanticExamples = JSON.parse(semanticRaw) as SemanticExample[];
const tradeExamples = JSON.parse(tradeRaw) as TradeExample[];

let watchActionOk = 0;
let departmentOk = 0;
let modelOk = 0;
let colorOk = 0;
let conditionOk = 0;
let semanticTotal = 0;
let semanticNullCount = 0;
let modelAsserts = 0;
let colorAsserts = 0;
let conditionAsserts = 0;

let payoffOk = 0;
let needsInfoOk = 0;
let providesInfoOk = 0;
let tradeTotal = 0;
let tradeNullCount = 0;

const mismatches: string[] = [];

for (const ex of semanticExamples) {
  semanticTotal += 1;
  const result = await parseUnifiedSemanticSlotsWithLLM({
    text: ex.text,
    history: ex.history
  });
  if (!result) {
    semanticNullCount += 1;
    mismatches.push(
      `[semantic:${ex.id}] parser returned null | expected watch_action=${ex.expected.watch_action} department_intent=${ex.expected.department_intent}`
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
        `[semantic:${ex.id}]`,
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
        `got confidence=${String(result.watchConfidence ?? result.confidence ?? null)}`
      ]
        .filter(Boolean)
        .join(" | ")
    );
  }
}

for (const ex of tradeExamples) {
  tradeTotal += 1;
  const result = await parseUnifiedSemanticSlotsWithLLM({
    text: ex.text,
    history: ex.history,
    lead: ex.lead,
    tradePayoff: ex.tradePayoff
  });
  if (!result) {
    tradeNullCount += 1;
    mismatches.push(
      `[trade:${ex.id}] parser returned null | expected payoff=${ex.expected.payoff_status} needs_info=${ex.expected.needs_lien_holder_info} provides_info=${ex.expected.provides_lien_holder_info}`
    );
    continue;
  }

  const expectedPayoff = ex.expected.payoff_status_any?.length
    ? ex.expected.payoff_status_any
    : [ex.expected.payoff_status];
  const payoffMatch = expectedPayoff.includes(result.payoffStatus);
  const needsInfoMatch = result.needsLienHolderInfo === ex.expected.needs_lien_holder_info;
  const providesInfoMatch =
    result.providesLienHolderInfo === ex.expected.provides_lien_holder_info;

  if (payoffMatch) payoffOk += 1;
  if (needsInfoMatch) needsInfoOk += 1;
  if (providesInfoMatch) providesInfoOk += 1;

  if (!payoffMatch || !needsInfoMatch || !providesInfoMatch) {
    mismatches.push(
      [
        `[trade:${ex.id}]`,
        `text="${ex.text}"`,
        `expected payoff=${ex.expected.payoff_status}${ex.expected.payoff_status_any ? " (any)" : ""}`,
        `expected needs_lien_holder_info=${ex.expected.needs_lien_holder_info}`,
        `expected provides_lien_holder_info=${ex.expected.provides_lien_holder_info}`,
        `got payoff=${result.payoffStatus}`,
        `got needs_lien_holder_info=${result.needsLienHolderInfo}`,
        `got provides_lien_holder_info=${result.providesLienHolderInfo}`,
        `got confidence=${String(result.payoffConfidence ?? result.confidence ?? null)}`
      ].join(" | ")
    );
  }
}

const pct = (n: number, d: number) => (d ? Math.round((n / d) * 1000) / 10 : 0);

console.log(
  `Semantic watch-action accuracy: ${watchActionOk}/${semanticTotal} (${pct(watchActionOk, semanticTotal)}%)`
);
console.log(`Semantic department accuracy: ${departmentOk}/${semanticTotal} (${pct(departmentOk, semanticTotal)}%)`);
if (modelAsserts > 0) {
  console.log(`Semantic watch model match: ${modelOk}/${modelAsserts} (${pct(modelOk, modelAsserts)}%)`);
}
if (colorAsserts > 0) {
  console.log(`Semantic watch color match: ${colorOk}/${colorAsserts} (${pct(colorOk, colorAsserts)}%)`);
}
if (conditionAsserts > 0) {
  console.log(
    `Semantic watch condition match: ${conditionOk}/${conditionAsserts} (${pct(conditionOk, conditionAsserts)}%)`
  );
}
console.log(`Semantic null parses: ${semanticNullCount}/${semanticTotal}`);
console.log(`Trade payoff status accuracy: ${payoffOk}/${tradeTotal} (${pct(payoffOk, tradeTotal)}%)`);
console.log(`Trade needs-lien-info accuracy: ${needsInfoOk}/${tradeTotal} (${pct(needsInfoOk, tradeTotal)}%)`);
console.log(
  `Trade provides-lien-info accuracy: ${providesInfoOk}/${tradeTotal} (${pct(providesInfoOk, tradeTotal)}%)`
);
console.log(`Trade null parses: ${tradeNullCount}/${tradeTotal}`);
console.log("");

if (mismatches.length) {
  console.log("Mismatches:");
  for (const line of mismatches) console.log(`- ${line}`);
} else {
  console.log("All unified slot checks passed.");
}

