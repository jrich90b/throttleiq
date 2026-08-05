/**
 * Console Copilot LLM lanes (Phases 1-2, docs/console_copilot_phase1.md / _phase2.md).
 * Lives outside llmDraft.ts per the source-size ratchet; uses llmDraft's shared
 * requestStructuredJson so usage logging + capture ride along.
 *
 * - answerCopilotQuestionWithLLM: answers ONLY from the deterministic snapshot text; conv
 *   ids ride in [brackets] so leadRefs can't be invented.
 * - parseMarketingListRequestWithLLM: translates the MANAGER'S plain-English list
 *   description into typed filters; the list itself is built deterministically
 *   (domain/marketingLists.ts) with the compliance exclusions. The parser only narrows an
 *   audience — it can never bypass an opt-out.
 */
import { requestStructuredJson } from "./llmDraft.js";

const COPILOT_ANSWER_JSON_SCHEMA: { [key: string]: unknown } = {
  type: "object",
  additionalProperties: false,
  required: ["answer", "leadRefs"],
  properties: {
    answer: { type: "string" },
    leadRefs: { type: "array", items: { type: "string" } }
  }
};

export async function answerCopilotQuestionWithLLM(args: {
  question: string;
  snapshotText: string;
}): Promise<{ answer: string; leadRefs: string[] } | null> {
  const useLLM = process.env.LLM_ENABLED === "1" && !!process.env.OPENAI_API_KEY;
  if (!useLLM) return null;
  const model = process.env.OPENAI_MODEL || "gpt-5-mini";
  const prompt = [
    "You are the manager's copilot for a motorcycle dealership's lead console.",
    "Answer the manager's question using ONLY the facts and numbers in the snapshot below.",
    "Never invent counts, names, or leads that are not in the snapshot. If the snapshot cannot answer the question, say so plainly and name what is missing.",
    "Keep the answer short and concrete. leadRefs = the conversation ids (shown in [brackets] in the snapshot) of any leads your answer cites; [] when none.",
    "",
    `SNAPSHOT:\n${args.snapshotText}`,
    "",
    `MANAGER QUESTION: ${args.question}`
  ].join("\n");
  try {
    const parsed = await requestStructuredJson({
      model,
      prompt,
      schemaName: "copilot_answer",
      schema: COPILOT_ANSWER_JSON_SCHEMA,
      maxOutputTokens: 400,
      debugTag: "copilot_ask"
    });
    if (!parsed || typeof parsed.answer !== "string" || !parsed.answer.trim()) return null;
    const leadRefs = Array.isArray(parsed.leadRefs)
      ? parsed.leadRefs.filter((x: unknown): x is string => typeof x === "string")
      : [];
    return { answer: parsed.answer.trim(), leadRefs };
  } catch {
    return null;
  }
}

const MARKETING_LIST_FILTER_JSON_SCHEMA: { [key: string]: unknown } = {
  type: "object",
  additionalProperties: false,
  required: ["channel", "modelQuery", "condition", "source", "activeWithinDays", "includeClosed"],
  properties: {
    channel: { type: "string", enum: ["sms", "email"] },
    modelQuery: { type: ["string", "null"] },
    condition: { type: ["string", "null"], description: "new | used | null" },
    source: { type: ["string", "null"] },
    activeWithinDays: { type: ["integer", "null"] },
    includeClosed: { type: "boolean" }
  }
};

export async function parseMarketingListRequestWithLLM(args: {
  request: string;
}): Promise<{
  channel: "sms" | "email";
  modelQuery: string | null;
  condition: string | null;
  source: string | null;
  activeWithinDays: number | null;
  includeClosed: boolean;
} | null> {
  const useLLM = process.env.LLM_ENABLED === "1" && !!process.env.OPENAI_API_KEY;
  if (!useLLM) return null;
  const model = process.env.OPENAI_MODEL || "gpt-5-mini";
  const prompt = [
    "A motorcycle dealership manager is describing a marketing list to build from the lead database.",
    "Translate the description into filters. Rules:",
    "- channel: sms unless the manager says email.",
    "- modelQuery: the bike model/family named (e.g. \"street glide\", \"touring\"), else null.",
    "- condition: \"new\" or \"used\" only when stated, else null.",
    "- source: a lead source named (e.g. \"Facebook\"), else null.",
    "- activeWithinDays: a stated recency window in days (\"last 90 days\" = 90), else null.",
    "- includeClosed: true only if the manager asks to include closed/lost/old leads.",
    "",
    `DESCRIPTION: ${args.request}`
  ].join("\n");
  try {
    const parsed = await requestStructuredJson({
      model,
      prompt,
      schemaName: "marketing_list_filters",
      schema: MARKETING_LIST_FILTER_JSON_SCHEMA,
      maxOutputTokens: 120,
      debugTag: "copilot_marketing_list"
    });
    if (!parsed || (parsed.channel !== "sms" && parsed.channel !== "email")) return null;
    return {
      channel: parsed.channel,
      modelQuery: typeof parsed.modelQuery === "string" ? parsed.modelQuery : null,
      condition: typeof parsed.condition === "string" ? parsed.condition : null,
      source: typeof parsed.source === "string" ? parsed.source : null,
      activeWithinDays: Number.isFinite(parsed.activeWithinDays) ? Number(parsed.activeWithinDays) : null,
      includeClosed: parsed.includeClosed === true
    };
  } catch {
    return null;
  }
}
