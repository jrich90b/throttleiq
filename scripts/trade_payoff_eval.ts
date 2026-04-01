import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseTradePayoffWithLLM } from "../services/api/src/domain/llmDraft.ts";

type PayoffStatus = "unknown" | "no_lien" | "has_lien";

type Example = {
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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataPath = process.argv[2] ?? path.join(__dirname, "trade_payoff_examples.json");

const apiKey = process.env.OPENAI_API_KEY ?? "";
if (!apiKey || apiKey.trim() === "..." || apiKey.trim().length < 20) {
  console.error("OPENAI_API_KEY is missing or looks like a placeholder. Set a real key and re-run.");
  process.exit(1);
}

if (process.env.LLM_ENABLED !== "1" || process.env.LLM_TRADE_PAYOFF_PARSER_ENABLED !== "1") {
  console.error("LLM_ENABLED=1 and LLM_TRADE_PAYOFF_PARSER_ENABLED=1 are required for this eval.");
  process.exit(1);
}

const raw = await fs.readFile(dataPath, "utf8");
const examples = JSON.parse(raw) as Example[];

let payoffOk = 0;
let needsInfoOk = 0;
let providesInfoOk = 0;
let total = 0;
let nullCount = 0;

const mismatches: string[] = [];

for (const ex of examples) {
  total += 1;
  const result = await parseTradePayoffWithLLM({
    text: ex.text,
    history: ex.history,
    lead: ex.lead,
    tradePayoff: ex.tradePayoff
  });

  if (!result) {
    nullCount += 1;
    mismatches.push(
      `[${ex.id}] parser returned null | expected payoff=${ex.expected.payoff_status} needs_info=${ex.expected.needs_lien_holder_info} provides_info=${ex.expected.provides_lien_holder_info}`
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
        `[${ex.id}]`,
        `text="${ex.text}"`,
        `expected payoff=${ex.expected.payoff_status}${ex.expected.payoff_status_any ? " (any)" : ""}`,
        `expected needs_lien_holder_info=${ex.expected.needs_lien_holder_info}`,
        `expected provides_lien_holder_info=${ex.expected.provides_lien_holder_info}`,
        `got payoff=${result.payoffStatus}`,
        `got needs_lien_holder_info=${result.needsLienHolderInfo}`,
        `got provides_lien_holder_info=${result.providesLienHolderInfo}`,
        `got confidence=${String(result.confidence ?? null)}`
      ].join(" | ")
    );
  }
}

const pct = (n: number) => (total ? Math.round((n / total) * 1000) / 10 : 0);

console.log(`Payoff status accuracy: ${payoffOk}/${total} (${pct(payoffOk)}%)`);
console.log(`Needs-lien-info accuracy: ${needsInfoOk}/${total} (${pct(needsInfoOk)}%)`);
console.log(`Provides-lien-info accuracy: ${providesInfoOk}/${total} (${pct(providesInfoOk)}%)`);
console.log(`Null parses: ${nullCount}/${total}`);
console.log("");

if (mismatches.length) {
  console.log("Mismatches:");
  for (const line of mismatches) console.log(`- ${line}`);
} else {
  console.log("All checks passed.");
}
