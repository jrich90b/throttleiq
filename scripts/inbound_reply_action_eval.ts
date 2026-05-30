import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseInboundReplyActionWithLLM } from "../services/api/src/domain/llmDraft.ts";

type Action =
  | "dealer_location_question"
  | "explicit_callback_request"
  | "schedule_context_status_update"
  | "inventory_watch_acknowledgement"
  | "none";

type Example = {
  id: string;
  text: string;
  history?: { direction: "in" | "out"; body: string }[];
  hasActiveInventoryWatch?: boolean;
  dialogState?: string | null;
  expected: {
    action: Action;
    explicit_action: boolean;
    should_reply: boolean;
  };
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataPath = process.argv[2] ?? path.join(__dirname, "inbound_reply_action_examples.json");

const apiKey = process.env.OPENAI_API_KEY ?? "";
if (!apiKey || apiKey.trim() === "..." || apiKey.trim().length < 20) {
  console.error("OPENAI_API_KEY is missing or looks like a placeholder. Set a real key and re-run.");
  process.exit(1);
}

if (process.env.LLM_ENABLED !== "1" || process.env.LLM_INBOUND_REPLY_ACTION_PARSER_ENABLED === "0") {
  console.error("LLM_ENABLED=1 and LLM_INBOUND_REPLY_ACTION_PARSER_ENABLED!=0 are required for this eval.");
  process.exit(1);
}

const raw = await fs.readFile(dataPath, "utf8");
const examples = JSON.parse(raw) as Example[];

let total = 0;
let actionOk = 0;
let explicitOk = 0;
let replyOk = 0;
let nullCount = 0;
const mismatches: string[] = [];

for (const ex of examples) {
  total += 1;
  const result = await parseInboundReplyActionWithLLM({
    text: ex.text,
    history: ex.history,
    dialogState: ex.dialogState,
    hasActiveInventoryWatch: !!ex.hasActiveInventoryWatch
  });

  if (!result) {
    nullCount += 1;
    mismatches.push(`[${ex.id}] parser returned null`);
    continue;
  }

  const actionMatch = result.action === ex.expected.action;
  const explicitMatch = result.explicitAction === ex.expected.explicit_action;
  const replyMatch = result.shouldReply === ex.expected.should_reply;

  if (actionMatch) actionOk += 1;
  if (explicitMatch) explicitOk += 1;
  if (replyMatch) replyOk += 1;

  if (!actionMatch || !explicitMatch || !replyMatch) {
    mismatches.push(
      `[${ex.id}] text=${JSON.stringify(ex.text)} | expected=${JSON.stringify(ex.expected)} | got=${JSON.stringify({
        action: result.action,
        explicitAction: result.explicitAction,
        shouldReply: result.shouldReply,
        normalizedText: result.normalizedText,
        reason: result.reason,
        confidence: result.confidence
      })}`
    );
  }
}

const pct = (n: number) => `${((n / Math.max(total, 1)) * 100).toFixed(1)}%`;
console.log(`Inbound reply action accuracy: ${actionOk}/${total} (${pct(actionOk)})`);
console.log(`Explicit-action match: ${explicitOk}/${total} (${pct(explicitOk)})`);
console.log(`Should-reply match: ${replyOk}/${total} (${pct(replyOk)})`);
console.log(`Null parses: ${nullCount}/${total}`);

if (mismatches.length) {
  console.error("\nMismatches:");
  for (const mismatch of mismatches) console.error(`- ${mismatch}`);
  process.exit(1);
}

console.log("\nAll checks passed.");
