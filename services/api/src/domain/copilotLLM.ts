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
  required: [
    "channel",
    "modelQuery",
    "excludeModelQuery",
    "condition",
    "source",
    "activeWithinDays",
    "includeClosed",
    "unsupportedCriteria"
  ],
  properties: {
    channel: { type: "string", enum: ["sms", "email"] },
    modelQuery: { type: ["string", "null"] },
    excludeModelQuery: {
      type: ["string", "null"],
      description: "a model or class the manager wants KEPT OUT, else null"
    },
    condition: { type: ["string", "null"], description: "new | used | null" },
    source: { type: ["string", "null"] },
    activeWithinDays: { type: ["integer", "null"] },
    includeClosed: { type: "boolean" },
    unsupportedCriteria: {
      type: ["string", "null"],
      description:
        "The part of the request that CANNOT be expressed by the filters above, quoted back in the manager's own words. Null only when every part of the request is covered."
    }
  }
};

export async function parseMarketingListRequestWithLLM(args: {
  request: string;
}): Promise<{
  channel: "sms" | "email";
  modelQuery: string | null;
  excludeModelQuery: string | null;
  condition: string | null;
  source: string | null;
  activeWithinDays: number | null;
  includeClosed: boolean;
  unsupportedCriteria: string | null;
} | null> {
  const useLLM = process.env.LLM_ENABLED === "1" && !!process.env.OPENAI_API_KEY;
  if (!useLLM) return null;
  const model = process.env.OPENAI_MODEL || "gpt-5-mini";
  const prompt = [
    "A motorcycle dealership manager is describing a marketing list to build from the lead database.",
    "Translate the description into filters. Rules:",
    "- channel: sms unless the manager says email.",
    "- modelQuery: the bike model/family named (e.g. \"street glide\", \"touring\"), else null.",
    "  When the manager asks for a whole CLASS of bike rather than a model, answer with the one",
    "  catalog word for that class, because the filter matches a class against the model catalog",
    "  instead of by name (a Street Glide 3 Limited does not contain the word \"trike\", and a",
    "  Street Glide does not contain the word \"touring\", so a text search finds neither):",
    "    three-wheelers / trikes / three wheel bikes  -> \"trike\"",
    "    touring bikes / baggers / full dressers      -> \"touring\"",
    "  Only those two classes are supported. Any other grouping is a model name, so pass the words",
    "  the manager used and let the filter match by name.",
    "- excludeModelQuery: a model or class the manager wants KEPT OUT — \"but not trikes\",",
    "  \"except touring bikes\", \"no baggers\" — using the same class words as modelQuery. Null",
    "  unless something is explicitly excluded. A description can use both: \"everyone from the",
    "  last 90 days except touring bikes\" is modelQuery null + excludeModelQuery \"touring\".",
    "- condition: \"new\" or \"used\" only when stated, else null.",
    "- source: a lead source named (e.g. \"Facebook\"), else null.",
    "- activeWithinDays: a stated recency window in days (\"last 90 days\" = 90), else null.",
    "- includeClosed: true only if the manager asks to include closed/lost/old leads.",
    "- unsupportedCriteria: THE MOST IMPORTANT FIELD. The filters above are the ONLY things this",
    "  system can search on. If any part of the description asks for something they cannot express",
    "  — a credit or approval status, whether someone bought, a budget or payment amount, a licence",
    "  or riding experience, a location, a trade-in, an appointment or test ride, anything at all",
    "  that is not one of the fields above — quote that part back here in the manager's own words.",
    "  Null ONLY when every part of the request is genuinely covered by the fields above.",
    "  A deliberately broad request (\"everyone\", \"all my leads\") IS covered: that is null.",
    "  WHEN IN DOUBT, FILL THIS IN. Saying we cannot do something costs the manager one message;",
    "  staying silent hands them a list of every customer in the database labelled as their answer.",
    "",
    `DESCRIPTION: ${args.request}`
  ].join("\n");
  try {
    const parsed = await requestStructuredJson({
      model,
      prompt,
      schemaName: "marketing_list_filters",
      schema: MARKETING_LIST_FILTER_JSON_SCHEMA,
      maxOutputTokens: 160,
      debugTag: "copilot_marketing_list"
    });
    if (!parsed || (parsed.channel !== "sms" && parsed.channel !== "email")) return null;
    return {
      channel: parsed.channel,
      modelQuery: typeof parsed.modelQuery === "string" ? parsed.modelQuery : null,
      excludeModelQuery:
        typeof parsed.excludeModelQuery === "string" ? parsed.excludeModelQuery : null,
      condition: typeof parsed.condition === "string" ? parsed.condition : null,
      source: typeof parsed.source === "string" ? parsed.source : null,
      activeWithinDays: Number.isFinite(parsed.activeWithinDays) ? Number(parsed.activeWithinDays) : null,
      includeClosed: parsed.includeClosed === true,
      unsupportedCriteria:
        typeof parsed.unsupportedCriteria === "string" && parsed.unsupportedCriteria.trim()
          ? parsed.unsupportedCriteria.trim()
          : null
    };
  } catch {
    return null;
  }
}
