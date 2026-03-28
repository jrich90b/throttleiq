import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseDialogActWithLLM } from "../services/api/src/domain/llmDraft.ts";

type Act = "trust_concern" | "frustration" | "objection" | "preference" | "clarification" | "none";
type Topic = "used_inventory" | "new_inventory" | "pricing" | "trade" | "scheduling" | "service" | "general";
type NextAction = "reassure_then_clarify" | "empathize_then_offer_help" | "ask_one_clarifier" | "normal_flow";

type Example = {
  id: string;
  text: string;
  history?: { direction: "in" | "out"; body: string }[];
  lead?: any;
  expected: {
    act: Act;
    act_any?: Act[];
    topic?: Topic;
    topic_any?: Topic[];
    explicit_request: boolean;
    next_action?: NextAction;
    next_action_any?: NextAction[];
  };
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataPath = process.argv[2] ?? path.join(__dirname, "dialog_act_examples.json");

const apiKey = process.env.OPENAI_API_KEY ?? "";
if (!apiKey || apiKey.trim() === "..." || apiKey.trim().length < 20) {
  console.error("OPENAI_API_KEY is missing or looks like a placeholder. Set a real key and re-run.");
  process.exit(1);
}
if (process.env.LLM_ENABLED !== "1" || process.env.LLM_DIALOG_ACT_PARSER_ENABLED !== "1") {
  console.error("LLM_ENABLED=1 and LLM_DIALOG_ACT_PARSER_ENABLED=1 are required for this eval.");
  process.exit(1);
}

const raw = await fs.readFile(dataPath, "utf8");
const examples = JSON.parse(raw) as Example[];

let actOk = 0;
let topicOk = 0;
let explicitOk = 0;
let actionOk = 0;
let total = 0;
let nullCount = 0;

const mismatches: string[] = [];

for (const ex of examples) {
  total += 1;
  const result = await parseDialogActWithLLM({
    text: ex.text,
    history: ex.history,
    lead: ex.lead
  });

  if (!result) {
    nullCount += 1;
    mismatches.push(
      `[${ex.id}] parser returned null | expected act=${ex.expected.act} explicit=${ex.expected.explicit_request}`
    );
    continue;
  }

  const expectedActs = ex.expected.act_any?.length ? ex.expected.act_any : [ex.expected.act];
  const expectedTopics = ex.expected.topic_any?.length
    ? ex.expected.topic_any
    : ex.expected.topic
      ? [ex.expected.topic]
      : [];
  const expectedActions = ex.expected.next_action_any?.length
    ? ex.expected.next_action_any
    : ex.expected.next_action
      ? [ex.expected.next_action]
      : [];

  const actMatch = expectedActs.includes(result.act);
  const topicMatch = expectedTopics.length ? expectedTopics.includes(result.topic) : true;
  const explicitMatch = result.explicitRequest === ex.expected.explicit_request;
  const actionMatch = expectedActions.length ? expectedActions.includes(result.nextAction) : true;

  if (actMatch) actOk += 1;
  if (topicMatch) topicOk += 1;
  if (explicitMatch) explicitOk += 1;
  if (actionMatch) actionOk += 1;

  if (!actMatch || !topicMatch || !explicitMatch || !actionMatch) {
    mismatches.push(
      [
        `[${ex.id}]`,
        `text="${ex.text}"`,
        `expected act=${ex.expected.act}${ex.expected.act_any ? " (any)" : ""}`,
        `expected topic=${String(ex.expected.topic ?? ex.expected.topic_any ?? "(not asserted)")}`,
        `expected explicit=${ex.expected.explicit_request}`,
        `expected next_action=${String(ex.expected.next_action ?? ex.expected.next_action_any ?? "(not asserted)")}`,
        `got act=${result.act}`,
        `got topic=${result.topic}`,
        `got explicit=${result.explicitRequest}`,
        `got next_action=${result.nextAction}`,
        `got confidence=${String(result.confidence ?? null)}`
      ].join(" | ")
    );
  }
}

const pct = (n: number) => (total ? Math.round((n / total) * 1000) / 10 : 0);

console.log(`Act accuracy: ${actOk}/${total} (${pct(actOk)}%)`);
console.log(`Topic accuracy: ${topicOk}/${total} (${pct(topicOk)}%)`);
console.log(`Explicit accuracy: ${explicitOk}/${total} (${pct(explicitOk)}%)`);
console.log(`Next-action accuracy: ${actionOk}/${total} (${pct(actionOk)}%)`);
console.log(`Null parses: ${nullCount}/${total}`);
console.log("");

if (mismatches.length) {
  console.log("Mismatches:");
  for (const line of mismatches) console.log(`- ${line}`);
} else {
  console.log("All checks passed.");
}
