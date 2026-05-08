import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

type Example = {
  id: string;
  text: string;
  history?: { direction: "in" | "out"; body: string }[];
  expected: {
    action: string;
    should_reply: boolean;
    should_book: boolean;
    day_contains?: string | null;
    time_contains?: string | null;
  };
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataPath = process.argv[2] ?? path.join(__dirname, "customer_ack_action_examples.json");

const apiKey = process.env.OPENAI_API_KEY ?? "";
if (!apiKey || apiKey.trim() === "..." || apiKey.trim().length < 20) {
  console.error("OPENAI_API_KEY is missing or looks like a placeholder. Set a real key and re-run.");
  process.exit(1);
}

if (process.env.LLM_ENABLED !== "1" || process.env.LLM_CUSTOMER_ACK_ACTION_PARSER_ENABLED === "0") {
  console.error("LLM_ENABLED=1 and LLM_CUSTOMER_ACK_ACTION_PARSER_ENABLED!=0 are required for this eval.");
  process.exit(1);
}

const raw = await fs.readFile(dataPath, "utf8");
const examples = JSON.parse(raw) as Example[];
const { parseCustomerAckActionWithLLM } = await import("../services/api/src/domain/llmDraft.ts");

let total = 0;
let actionOk = 0;
let replyOk = 0;
let bookOk = 0;
let fieldOk = 0;
let nullCount = 0;
const mismatches: string[] = [];

const norm = (value: unknown) => String(value ?? "").trim().toLowerCase();

for (const ex of examples) {
  total += 1;
  const result = await parseCustomerAckActionWithLLM({
    text: ex.text,
    history: ex.history,
    lastSuggestedSlots: [
      { startLocal: "Fri, May 8, 11:00 AM" },
      { startLocal: "Sat, May 9, 2:00 PM" }
    ]
  });

  if (!result) {
    nullCount += 1;
    mismatches.push(`[${ex.id}] parser returned null`);
    continue;
  }

  const expected = ex.expected;
  const actionMatch = result.action === expected.action;
  const replyMatch = result.shouldReply === expected.should_reply;
  const bookMatch = result.shouldBook === expected.should_book;
  const fieldChecks: boolean[] = [];

  if (Object.hasOwn(expected, "day_contains")) {
    fieldChecks.push(
      expected.day_contains == null
        ? !result.requested?.day
        : norm(result.requested?.day).includes(norm(expected.day_contains)) ||
            norm(result.normalizedText).includes(norm(expected.day_contains))
    );
  }
  if (Object.hasOwn(expected, "time_contains")) {
    fieldChecks.push(
      expected.time_contains == null
        ? !result.requested?.timeText
        : norm(result.requested?.timeText).includes(norm(expected.time_contains)) ||
            norm(result.normalizedText).includes(norm(expected.time_contains))
    );
  }
  const fieldsMatch = fieldChecks.every(Boolean);

  if (actionMatch) actionOk += 1;
  if (replyMatch) replyOk += 1;
  if (bookMatch) bookOk += 1;
  if (fieldsMatch) fieldOk += 1;

  if (!actionMatch || !replyMatch || !bookMatch || !fieldsMatch) {
    mismatches.push(
      `[${ex.id}] text=${JSON.stringify(ex.text)} | expected=${JSON.stringify(expected)} | got=${JSON.stringify({
        action: result.action,
        shouldReply: result.shouldReply,
        shouldBook: result.shouldBook,
        requested: result.requested,
        normalizedText: result.normalizedText,
        confidence: result.confidence
      })}`
    );
  }
}

const pct = (n: number) => `${((n / Math.max(total, 1)) * 100).toFixed(1)}%`;
console.log(`Customer ack action accuracy: ${actionOk}/${total} (${pct(actionOk)})`);
console.log(`Should-reply match: ${replyOk}/${total} (${pct(replyOk)})`);
console.log(`Should-book match: ${bookOk}/${total} (${pct(bookOk)})`);
console.log(`Requested field match: ${fieldOk}/${total} (${pct(fieldOk)})`);
console.log(`Null parses: ${nullCount}/${total}`);

if (mismatches.length) {
  console.error("\nMismatches:");
  for (const mismatch of mismatches) console.error(`- ${mismatch}`);
  process.exit(1);
}

console.log("\nAll checks passed.");
