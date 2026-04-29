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
    watch_year?: string;
    watch_year_min?: number;
    watch_year_max?: number;
    watch_color_contains?: string;
    watch_condition?: "new" | "used" | "any" | "unknown";
    watch_min_price?: number;
    watch_max_price?: number;
    watch_monthly_budget?: number;
    watch_down_payment?: number;
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

function num(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
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
let yearOk = 0;
let yearMinOk = 0;
let yearMaxOk = 0;
let minPriceOk = 0;
let maxPriceOk = 0;
let monthlyBudgetOk = 0;
let downPaymentOk = 0;
let semanticTotal = 0;
let semanticNullCount = 0;
let modelAsserts = 0;
let colorAsserts = 0;
let conditionAsserts = 0;
let yearAsserts = 0;
let yearMinAsserts = 0;
let yearMaxAsserts = 0;
let minPriceAsserts = 0;
let maxPriceAsserts = 0;
let monthlyBudgetAsserts = 0;
let downPaymentAsserts = 0;

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

  let yearMatch = true;
  if (ex.expected.watch_year) {
    yearAsserts += 1;
    yearMatch = norm(result.watch?.year) === norm(ex.expected.watch_year);
    if (yearMatch) yearOk += 1;
  }

  let yearMinMatch = true;
  if (ex.expected.watch_year_min != null) {
    yearMinAsserts += 1;
    yearMinMatch = num((result.watch as any)?.yearMin) === ex.expected.watch_year_min;
    if (yearMinMatch) yearMinOk += 1;
  }

  let yearMaxMatch = true;
  if (ex.expected.watch_year_max != null) {
    yearMaxAsserts += 1;
    yearMaxMatch = num((result.watch as any)?.yearMax) === ex.expected.watch_year_max;
    if (yearMaxMatch) yearMaxOk += 1;
  }

  let minPriceMatch = true;
  if (ex.expected.watch_min_price != null) {
    minPriceAsserts += 1;
    minPriceMatch = num((result.watch as any)?.minPrice) === ex.expected.watch_min_price;
    if (minPriceMatch) minPriceOk += 1;
  }

  let maxPriceMatch = true;
  if (ex.expected.watch_max_price != null) {
    maxPriceAsserts += 1;
    maxPriceMatch = num((result.watch as any)?.maxPrice) === ex.expected.watch_max_price;
    if (maxPriceMatch) maxPriceOk += 1;
  }

  let monthlyBudgetMatch = true;
  if (ex.expected.watch_monthly_budget != null) {
    monthlyBudgetAsserts += 1;
    monthlyBudgetMatch = num((result.watch as any)?.monthlyBudget) === ex.expected.watch_monthly_budget;
    if (monthlyBudgetMatch) monthlyBudgetOk += 1;
  }

  let downPaymentMatch = true;
  if (ex.expected.watch_down_payment != null) {
    downPaymentAsserts += 1;
    downPaymentMatch = num((result.watch as any)?.downPayment) === ex.expected.watch_down_payment;
    if (downPaymentMatch) downPaymentOk += 1;
  }

  if (
    !watchActionMatch ||
    !departmentMatch ||
    !modelMatch ||
    !colorMatch ||
    !conditionMatch ||
    !yearMatch ||
    !yearMinMatch ||
    !yearMaxMatch ||
    !minPriceMatch ||
    !maxPriceMatch ||
    !monthlyBudgetMatch ||
    !downPaymentMatch
  ) {
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
        ex.expected.watch_year ? `expected watch_year=${ex.expected.watch_year}` : "",
        ex.expected.watch_year_min != null ? `expected watch_year_min=${ex.expected.watch_year_min}` : "",
        ex.expected.watch_year_max != null ? `expected watch_year_max=${ex.expected.watch_year_max}` : "",
        ex.expected.watch_min_price != null ? `expected watch_min_price=${ex.expected.watch_min_price}` : "",
        ex.expected.watch_max_price != null ? `expected watch_max_price=${ex.expected.watch_max_price}` : "",
        ex.expected.watch_monthly_budget != null
          ? `expected watch_monthly_budget=${ex.expected.watch_monthly_budget}`
          : "",
        ex.expected.watch_down_payment != null
          ? `expected watch_down_payment=${ex.expected.watch_down_payment}`
          : "",
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
if (yearAsserts > 0) {
  console.log(`Semantic watch year match: ${yearOk}/${yearAsserts} (${pct(yearOk, yearAsserts)}%)`);
}
if (yearMinAsserts > 0) {
  console.log(`Semantic watch year-min match: ${yearMinOk}/${yearMinAsserts} (${pct(yearMinOk, yearMinAsserts)}%)`);
}
if (yearMaxAsserts > 0) {
  console.log(`Semantic watch year-max match: ${yearMaxOk}/${yearMaxAsserts} (${pct(yearMaxOk, yearMaxAsserts)}%)`);
}
if (minPriceAsserts > 0) {
  console.log(`Semantic watch min-price match: ${minPriceOk}/${minPriceAsserts} (${pct(minPriceOk, minPriceAsserts)}%)`);
}
if (maxPriceAsserts > 0) {
  console.log(`Semantic watch max-price match: ${maxPriceOk}/${maxPriceAsserts} (${pct(maxPriceOk, maxPriceAsserts)}%)`);
}
if (monthlyBudgetAsserts > 0) {
  console.log(
    `Semantic watch monthly-budget match: ${monthlyBudgetOk}/${monthlyBudgetAsserts} (${pct(monthlyBudgetOk, monthlyBudgetAsserts)}%)`
  );
}
if (downPaymentAsserts > 0) {
  console.log(
    `Semantic watch down-payment match: ${downPaymentOk}/${downPaymentAsserts} (${pct(downPaymentOk, downPaymentAsserts)}%)`
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
