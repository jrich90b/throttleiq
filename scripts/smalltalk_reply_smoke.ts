import { generateSmallTalkReplyWithLLM } from "../services/api/src/domain/llmDraft.ts";

const samples = [
  "Did you watch the Sabres game?",
  "You ready for nhl playoffs?",
  "lol fair enough",
  "thanks man",
  "Do you have any black street glides in stock?"
];

async function main() {
  const llmEnabled = process.env.LLM_ENABLED === "1";
  const hasKey = !!process.env.OPENAI_API_KEY;
  console.log(JSON.stringify({ llmEnabled, hasKey, model: process.env.OPENAI_MODEL || "gpt-5-mini" }, null, 2));
  for (const text of samples) {
    const out = await generateSmallTalkReplyWithLLM({
      text,
      history: [
        { direction: "out", body: "Ballpark, on about $24,999, you’re around $550–$570/mo at 60 months before taxes and fees." },
        { direction: "in", body: text }
      ],
      hasHumorHint: /\b(lol|haha|playoffs|sabres)\b/i.test(text)
    });
    console.log("\n---");
    console.log("in:", text);
    console.log("out:", out?.reply ?? null);
    console.log("confidence:", out?.confidence ?? null);
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});

