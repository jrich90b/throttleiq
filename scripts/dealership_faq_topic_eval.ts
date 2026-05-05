import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseDealershipFaqTopicWithLLM,
  type DealershipFaqTopicParse
} from "../services/api/src/domain/llmDraft.ts";

type Topic = DealershipFaqTopicParse["topic"];

type Example = {
  id: string;
  text: string;
  history?: { direction: "in" | "out"; body: string }[];
  lead?: any;
  expected: {
    topic: Topic;
    topic_any?: Topic[];
    explicit_request: boolean;
  };
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataPath = process.argv[2] ?? path.join(__dirname, "dealership_faq_topic_examples.json");

const apiKey = process.env.OPENAI_API_KEY ?? "";
if (!apiKey || apiKey.trim() === "..." || apiKey.trim().length < 20) {
  console.error("OPENAI_API_KEY is missing or looks like a placeholder. Set a real key and re-run.");
  process.exit(1);
}

if (process.env.LLM_ENABLED !== "1" || process.env.LLM_FAQ_TOPIC_PARSER_ENABLED === "0") {
  console.error("LLM_ENABLED=1 and LLM_FAQ_TOPIC_PARSER_ENABLED!=0 are required for this eval.");
  process.exit(1);
}

const raw = await fs.readFile(dataPath, "utf8");
const examples = JSON.parse(raw) as Example[];

let topicOk = 0;
let explicitOk = 0;
let total = 0;
let nullCount = 0;
const mismatches: string[] = [];

for (const ex of examples) {
  total += 1;
  const result = await parseDealershipFaqTopicWithLLM({
    text: ex.text,
    history: ex.history,
    lead: ex.lead
  });

  if (!result) {
    nullCount += 1;
    mismatches.push(
      `[${ex.id}] parser returned null | expected topic=${ex.expected.topic} explicit=${ex.expected.explicit_request}`
    );
    continue;
  }

  const expectedTopics = ex.expected.topic_any?.length ? ex.expected.topic_any : [ex.expected.topic];
  const topicMatch = expectedTopics.includes(result.topic);
  const explicitMatch = result.explicitRequest === ex.expected.explicit_request;

  if (topicMatch) topicOk += 1;
  if (explicitMatch) explicitOk += 1;

  if (!topicMatch || !explicitMatch) {
    mismatches.push(
      [
        `[${ex.id}]`,
        `text="${ex.text}"`,
        `expected topic=${ex.expected.topic}${ex.expected.topic_any ? " (any)" : ""}`,
        `expected explicit=${ex.expected.explicit_request}`,
        `got topic=${result.topic}`,
        `got explicit=${result.explicitRequest}`,
        `got confidence=${String(result.confidence ?? null)}`
      ].join(" | ")
    );
  }
}

const pct = (n: number) => (total ? Math.round((n / total) * 1000) / 10 : 0);

console.log(`FAQ topic accuracy: ${topicOk}/${total} (${pct(topicOk)}%)`);
console.log(`Explicit accuracy: ${explicitOk}/${total} (${pct(explicitOk)}%)`);
console.log(`Null parses: ${nullCount}/${total}`);
console.log("");

if (mismatches.length) {
  console.log("Mismatches:");
  for (const line of mismatches) console.log(`- ${line}`);
  process.exit(1);
}

console.log("All checks passed.");
