// services/api/src/domain/llmDraft.ts
import fs from "node:fs";
import OpenAI from "openai";
import type { Conversation } from "./conversationStore.js";
import { dataPath } from "./dataDir.js";
import { recordOpenAIUsage } from "./openaiUsageLogger.js";
import { buildPartsCatalogParserHint, matchPartsCatalogLexicon } from "./partsCatalogLexicon.js";
import { isDemoDayEventQuestionText } from "./workflowRegressionGuards.js";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

type ManualReplyExample = {
  inboundText?: string;
  reply?: string;
  count?: number;
  observedAt?: string;
};

type ManualReplyExamplesFile = {
  byIntent?: Record<string, ManualReplyExample[]>;
};

type LoadedManualReplyExamples = {
  sourcePath: string;
  loadedAtMs: number;
  mtimeMs: number;
  byIntent: Record<string, Array<{ inboundText: string; reply: string }>>;
};

const MANUAL_REPLY_EXAMPLES_CACHE_MS = (() => {
  const raw = Number(process.env.MANUAL_REPLY_EXAMPLES_CACHE_MS ?? "60000");
  if (!Number.isFinite(raw) || raw <= 0) return 60000;
  return Math.floor(raw);
})();

let manualReplyExamplesCache: LoadedManualReplyExamples | null = null;

function normalizeManualText(input: unknown): string {
  return String(input ?? "").replace(/\s+/g, " ").trim();
}

function resolveManualReplyExamplesPath(): string {
  const configured = normalizeManualText(process.env.MANUAL_REPLY_EXAMPLES_PATH);
  return configured || dataPath("manual_reply_examples.json");
}

function normalizeManualIntentHint(input: unknown): string {
  const text = normalizeManualText(input).toLowerCase();
  if (text === "pricing_payments") return "pricing_payments";
  if (text === "availability") return "availability";
  if (text === "scheduling") return "scheduling";
  if (text === "callback") return "callback";
  return "general";
}

function loadManualReplyExamples(): LoadedManualReplyExamples | null {
  const sourcePath = resolveManualReplyExamplesPath();
  const nowMs = Date.now();
  if (
    manualReplyExamplesCache &&
    manualReplyExamplesCache.sourcePath === sourcePath &&
    nowMs - manualReplyExamplesCache.loadedAtMs < MANUAL_REPLY_EXAMPLES_CACHE_MS
  ) {
    return manualReplyExamplesCache;
  }

  let mtimeMs = -1;
  try {
    mtimeMs = fs.statSync(sourcePath).mtimeMs;
  } catch {
    manualReplyExamplesCache = {
      sourcePath,
      loadedAtMs: nowMs,
      mtimeMs: -1,
      byIntent: {}
    };
    return manualReplyExamplesCache;
  }

  if (
    manualReplyExamplesCache &&
    manualReplyExamplesCache.sourcePath === sourcePath &&
    manualReplyExamplesCache.mtimeMs === mtimeMs
  ) {
    manualReplyExamplesCache.loadedAtMs = nowMs;
    return manualReplyExamplesCache;
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(sourcePath, "utf8")) as ManualReplyExamplesFile;
    const byIntent: Record<string, Array<{ inboundText: string; reply: string }>> = {};
    const buckets = parsed?.byIntent && typeof parsed.byIntent === "object" ? parsed.byIntent : {};
    for (const [intentHint, rows] of Object.entries(buckets)) {
      if (!Array.isArray(rows)) continue;
      const normalizedRows = rows
        .map(row => ({
          inboundText: normalizeManualText(row?.inboundText),
          reply: normalizeManualText(row?.reply)
        }))
        .filter(row => row.inboundText && row.reply && row.reply.length <= 500)
        .slice(0, 8);
      if (!normalizedRows.length) continue;
      byIntent[normalizeManualIntentHint(intentHint)] = normalizedRows;
    }
    manualReplyExamplesCache = {
      sourcePath,
      loadedAtMs: nowMs,
      mtimeMs,
      byIntent
    };
  } catch {
    manualReplyExamplesCache = {
      sourcePath,
      loadedAtMs: nowMs,
      mtimeMs,
      byIntent: {}
    };
  }

  return manualReplyExamplesCache;
}

function hasWord(text: string, pattern: RegExp): boolean {
  return pattern.test(String(text ?? "").toLowerCase());
}

function inferManualIntentHintFromDraftContext(ctx: DraftContext): string {
  const bucket = String(ctx.bucket ?? "").toLowerCase();
  const cta = String(ctx.cta ?? "").toLowerCase();
  const inquiry = String(ctx.inquiry ?? "").toLowerCase();
  if (ctx.callbackRequest || hasWord(inquiry, /\b(call me|give me a call|please call|can you call)\b/)) {
    return "callback";
  }
  if (
    ctx.pricingIntent ||
    bucket === "pricing" ||
    bucket === "finance_prequal" ||
    hasWord(cta, /\b(quote|price|pricing|finance|payment|prequal)\b/) ||
    hasWord(inquiry, /\b(apr|rate|payment|payments|monthly|down payment|finance|credit)\b/)
  ) {
    return "pricing_payments";
  }
  if (
    bucket === "test_ride" ||
    hasWord(cta, /\b(schedule|appointment|book|test_ride)\b/) ||
    hasWord(inquiry, /\b(schedule|appointment|book|stop in|come in|time works|today|tomorrow)\b/)
  ) {
    return "scheduling";
  }
  if (
    bucket === "inventory_interest" ||
    hasWord(cta, /\b(availability|in_stock|inventory|request_details)\b/) ||
    hasWord(inquiry, /\b(in stock|available|availability|do you have|still available|have any)\b/)
  ) {
    return "availability";
  }
  return "general";
}

function buildManualReplyExamplesPromptBlock(intentHint: string): string {
  const loaded = loadManualReplyExamples();
  if (!loaded) return "none";
  const byIntent = loaded.byIntent ?? {};
  const selected = [
    ...(Array.isArray(byIntent[intentHint]) ? byIntent[intentHint].slice(0, 3) : []),
    ...(intentHint !== "general" && Array.isArray(byIntent.general) ? byIntent.general.slice(0, 1) : [])
  ];
  if (!selected.length) return "none";
  return selected
    .map((row, idx) => `${idx + 1}) inbound: "${row.inboundText}"\n   reply: "${row.reply}"`)
    .join("\n");
}

function isGpt5Model(model: string): boolean {
  return /^gpt-5/i.test(String(model ?? "").trim());
}

function modelSupportsTemperature(model: string): boolean {
  return !isGpt5Model(model);
}

function optionalTemperature(model: string, temperature: number): Record<string, number> {
  return modelSupportsTemperature(model) ? { temperature } : {};
}

function optionalReasoning(model: string): Record<string, { effort: "minimal" }> {
  return isGpt5Model(model) ? { reasoning: { effort: "minimal" } } : {};
}

function optionalCreateTextConfig(
  model: string
): Record<string, { effort: "minimal" } | { verbosity: "low" }> {
  if (!isGpt5Model(model)) return {};
  return {
    reasoning: { effort: "minimal" },
    text: { verbosity: "low" }
  };
}

export type DraftContext = {
  channel: "sms" | "email" | "facebook_messenger" | "task";
  leadSource?: string | null;
  bucket?: string | null;
  cta?: string | null;
  leadKey: string;
  lead?: Conversation["lead"];
  handoff?: { required: boolean; reason: string } | null;
  callbackRequest?: boolean;
  dealerProfile?: any;
  today?: string;
  dealerTimeZone?: string;
  dealerClosedToday?: boolean;
  dealerHoursToday?: string | null;
  appointment?: any;
  followUp?: any;
  suggestedSlots?: any[];
  pricingAttempts?: number;
  pricingIntent?: boolean;
  inquiry: string;
  history: { direction: "in" | "out"; body: string }[];
  voiceSummary?: string | null;
  memorySummary?: string | null;
  pickup?: any;
  weather?: any;

  // Inventory verification inputs (optional)
  stockId?: string | null;
  inventoryUrl?: string | null;
  inventoryStatus?: "AVAILABLE" | "PENDING" | "UNKNOWN" | null;
  inventoryNote?: string | null;
};

function userAskedForEmail(ctx: DraftContext): boolean {
  const parts = [ctx.inquiry, ...(ctx.history ?? []).filter(h => h.direction === "in").map(h => h.body)];
  const text = parts.filter(Boolean).join(" ").toLowerCase();
  return (
    /\b(e-?mail|email)\b/.test(text) ||
    /\b(mail me|email me|send (me )?an? email|send (me )?e-?mail)\b/.test(text)
  );
}

function sanitizeSmsDraftNoEmail(draft: string, allowEmail: boolean): string {
  if (allowEmail) return draft;
  if (!/\b(e-?mail|email)\b/i.test(draft)) return draft;
  let out = draft;
  out = out.replace(/\b(i'?ll|i will|we will|we'll|can)\s+e-?mail\b/gi, "$1 text");
  out = out.replace(/\bemail the details to you\b/gi, "text the details to you");
  out = out.replace(/\bemail the details\b/gi, "text the details");
  out = out.replace(/\bemail you\b/gi, "text you");
  out = out.replace(/\be-?mail\b/gi, "text");
  out = out.replace(/\btext\b([^.]*)\band text\b/gi, "text$1and reach out");
  out = out.replace(/\btext\b\s+\btext\b/gi, "text");
  return out;
}

function sanitizePhotoAsk(draft: string): string {
  if (!draft) return draft;
  let out = draft;
  // Remove "exterior, cockpit, and close-ups" style photo triage requests.
  out = out.replace(
    /[^.?!]*\bexterior\b[^.?!]*\bcockpit\b[^.?!]*\bclose[-\s]?ups?\b[^.?!]*(?:[.?!]|$)/gi,
    "I can send photos if you'd like."
  );
  // Remove any photo triage that includes cockpit/close-ups.
  out = out.replace(
    /[^.?!]*\b(photos?|pics?|shots?)\b[^.?!]*\b(cockpit|close[-\s]?ups?|exterior)\b[^.?!]*(?:[.?!]|$)/gi,
    "I can send photos if you'd like."
  );
  out = out.replace(
    /[^.?!]*\b(cockpit|close[-\s]?ups?)\b[^.?!]*\b(photos?|pics?|shots?)\b[^.?!]*(?:[.?!]|$)/gi,
    "I can send photos if you'd like."
  );
  return out;
}

export async function classifySchedulingIntent(input: string): Promise<boolean> {
  const useLLM = process.env.LLM_ENABLED === "1" && !!process.env.OPENAI_API_KEY;
  if (!useLLM) return false;
  const model = process.env.OPENAI_MODEL || "gpt-5-mini";
  const text = String(input ?? "").trim();
  if (!text) return false;
  const schema: { [key: string]: unknown } = {
    type: "object",
    additionalProperties: false,
    required: ["is_schedule", "confidence"],
    properties: {
      is_schedule: { type: "boolean" },
      confidence: { type: "number" }
    }
  };
  const prompt = [
    "You are a classifier for dealership SMS.",
    "Return only JSON that matches the schema.",
    "Question: Is the customer trying to schedule or pick an appointment time?",
    "is_schedule=true only when there is a clear scheduling intent.",
    "confidence is 0 to 1.",
    "",
    `Message: ${text}`
  ].join("\n");
  try {
    const parsed = await requestStructuredJson({
      model,
      prompt,
      schemaName: "scheduling_intent_classifier",
      schema,
      maxOutputTokens: 80,
      debugTag: "llm-scheduling-classifier"
    });
    if (!parsed || typeof parsed !== "object") return false;
    return !!parsed.is_schedule;
  } catch {
    return false;
  }
}

export async function classifySmallTalkWithLLM(args: {
  text: string;
  history?: { direction: "in" | "out"; body: string }[];
}): Promise<{ smallTalk: boolean; confidence?: number } | null> {
  const useLLM = process.env.LLM_ENABLED === "1" && !!process.env.OPENAI_API_KEY;
  if (!useLLM) return null;
  const model = process.env.OPENAI_MODEL || "gpt-5-mini";
  const text = String(args.text ?? "").trim();
  if (!text) return null;
  const history = (args.history ?? []).slice(-4).map(h => `${h.direction}: ${h.body}`);
  const schema: { [key: string]: unknown } = {
    type: "object",
    additionalProperties: false,
    required: ["small_talk", "confidence"],
    properties: {
      small_talk: { type: "boolean" },
      confidence: { type: "number" }
    }
  };
  const prompt = [
    "You are a classifier for dealership SMS. Return only JSON that matches the schema.",
    "Decide if the message is small talk/pleasantry with no actionable intent.",
    "",
    "Guidelines:",
    "- small_talk=true only for acknowledgements, thanks, emojis, or brief pleasantries.",
    "- small_talk=true for off-topic conversational chatter/banter with no dealership action, even when phrased as a question.",
    "- small_talk=false if the message asks the dealership to do something or needs a concrete business answer.",
    "- small_talk=false if it mentions scheduling, pricing, payments, availability, trade-in, test ride, callback, or hours.",
    "",
    "Examples:",
    "- \"Did you watch the Sabres game last night?\" => small_talk=true",
    "- \"You ready for NHL playoffs?\" => small_talk=true",
    "- \"Do you have any black street glides in stock?\" => small_talk=false",
    "- \"Can I come in Saturday at 9:30?\" => small_talk=false",
    "",
    history.length ? `Recent messages:\n${history.join("\n")}` : "Recent messages: (none)",
    `Message: ${text}`
  ].join("\n");
  const normalizeConfidence = (value: unknown, fallback: number = 0.8): number =>
    typeof value === "number" && Number.isFinite(value)
      ? Math.max(0, Math.min(1, value))
      : fallback;

  try {
    const parsed = await requestStructuredJson({
      model,
      prompt,
      schemaName: "small_talk_classifier",
      schema,
      maxOutputTokens: 120,
      debugTag: "llm-smalltalk-classifier"
    });
    if (parsed && typeof parsed === "object") {
      return {
        smallTalk: !!parsed.small_talk,
        confidence: normalizeConfidence(parsed.confidence, 0.8)
      };
    }
  } catch {}

  // LLM backup classification path (still model-based, no lexical regex fallback).
  try {
    const fallbackResp = await client.responses.create({
      model,
      instructions:
        "Classify dealership SMS. Return exactly one token: SMALL_TALK or NOT_SMALL_TALK. " +
        "SMALL_TALK means off-topic or pleasantry with no dealership action request.",
      input: [
        history.length ? `Recent messages:\n${history.join("\n")}` : "Recent messages: (none)",
        `Message: ${text}`
      ].join("\n"),
      ...optionalCreateTextConfig(model),
      ...optionalTemperature(model, 0),
      max_output_tokens: 12
    });
    recordOpenAIUsage(fallbackResp, {
      feature: "llm_classifier",
      operation: "small_talk_fallback",
      requestKind: "responses.create",
      model
    });
    const out = String(fallbackResp.output_text ?? "")
      .trim()
      .toUpperCase();
    if (/\bNOT[\s_-]*SMALL[\s_-]*TALK\b/.test(out)) return { smallTalk: false, confidence: 0.8 };
    if (/\bSMALL[\s_-]*TALK\b/.test(out)) return { smallTalk: true, confidence: 0.8 };
  } catch {}

  return null;
}

export async function classifyBlendedChatterWithLLM(args: {
  text: string;
  history?: { direction: "in" | "out"; body: string }[];
}): Promise<{ hasChatter: boolean; confidence?: number } | null> {
  const useLLM = process.env.LLM_ENABLED === "1" && !!process.env.OPENAI_API_KEY;
  if (!useLLM) return null;
  const model = process.env.OPENAI_MODEL || "gpt-5-mini";
  const text = String(args.text ?? "").trim();
  if (!text) return null;
  const history = (args.history ?? []).slice(-4).map(h => `${h.direction}: ${h.body}`);
  const schema: { [key: string]: unknown } = {
    type: "object",
    additionalProperties: false,
    required: ["has_chatter", "confidence"],
    properties: {
      has_chatter: { type: "boolean" },
      confidence: { type: "number" }
    }
  };
  const prompt = [
    "You are a classifier for dealership SMS.",
    "Return only JSON that matches the schema.",
    "Question: Does this message include conversational chatter/banter style, even if it also includes a real dealership ask?",
    "",
    "Guidelines:",
    "- has_chatter=true when the message includes joking, banter, sports talk, or social chatter tone.",
    "- has_chatter=true for mixed messages that include both chatter and business intent.",
    "- has_chatter=false for purely transactional/business-only messages.",
    "",
    "Examples:",
    "- \"Did you watch the Sabres game, and what are payments?\" => has_chatter=true",
    "- \"haha can I come in Saturday at 9:30?\" => has_chatter=true",
    "- \"What are payments with 5000 down at 72 months?\" => has_chatter=false",
    "- \"Do you have black Street Glides in stock?\" => has_chatter=false",
    "",
    history.length ? `Recent messages:\n${history.join("\n")}` : "Recent messages: (none)",
    `Message: ${text}`
  ].join("\n");
  const normalizeConfidence = (value: unknown, fallback: number = 0.75): number =>
    typeof value === "number" && Number.isFinite(value)
      ? Math.max(0, Math.min(1, value))
      : fallback;

  try {
    const parsed = await requestStructuredJson({
      model,
      prompt,
      schemaName: "blended_chatter_classifier",
      schema,
      maxOutputTokens: 120,
      debugTag: "llm-blended-chatter-classifier"
    });
    if (parsed && typeof parsed === "object") {
      return {
        hasChatter: !!parsed.has_chatter,
        confidence: normalizeConfidence(parsed.confidence, 0.75)
      };
    }
  } catch {}

  try {
    const fallbackResp = await client.responses.create({
      model,
      instructions:
        "Classify dealership SMS. Return exactly one token: CHATTY or NOT_CHATTY. " +
        "CHATTY includes banter/social chatter tone, including mixed chatter + business asks.",
      input: [
        history.length ? `Recent messages:\n${history.join("\n")}` : "Recent messages: (none)",
        `Message: ${text}`
      ].join("\n"),
      ...optionalCreateTextConfig(model),
      ...optionalTemperature(model, 0),
      max_output_tokens: 12
    });
    recordOpenAIUsage(fallbackResp, {
      feature: "llm_classifier",
      operation: "blended_chatter_fallback",
      requestKind: "responses.create",
      model
    });
    const out = String(fallbackResp.output_text ?? "")
      .trim()
      .toUpperCase();
    if (/\bNOT[\s_-]*CHATTY\b/.test(out)) return { hasChatter: false, confidence: 0.75 };
    if (/\bCHATTY\b/.test(out)) return { hasChatter: true, confidence: 0.75 };
  } catch {}

  return null;
}

export async function generateSmallTalkReplyWithLLM(args: {
  text: string;
  history?: { direction: "in" | "out"; body: string }[];
  hasHumorHint?: boolean;
  allowBikePivotHint?: boolean;
  smallTalkStreakHint?: number | null;
}): Promise<{ reply: string; confidence?: number; source?: "structured" | "freeform" } | null> {
  const useLLM = process.env.LLM_ENABLED === "1" && !!process.env.OPENAI_API_KEY;
  if (!useLLM) return null;
  const model = process.env.OPENAI_MODEL || "gpt-5-mini";
  const text = String(args.text ?? "").trim();
  if (!text) return null;
  const hasHumorHint = !!args.hasHumorHint;
  const allowBikePivotHint = args.allowBikePivotHint !== false;
  const smallTalkStreakHint =
    typeof args.smallTalkStreakHint === "number" && Number.isFinite(args.smallTalkStreakHint)
      ? Math.max(0, Math.trunc(args.smallTalkStreakHint))
      : null;
  const history = (args.history ?? []).slice(-4).map(h => `${h.direction}: ${h.body}`);
  const schema: { [key: string]: unknown } = {
    type: "object",
    additionalProperties: false,
    required: ["reply", "confidence"],
    properties: {
      reply: { type: "string" },
      confidence: { type: "number" }
    }
  };
  const prompt = [
    "You write one short SMS reply for dealership small talk/off-topic chatter.",
    "Return only JSON that matches the schema.",
    "",
    "Rules:",
    "- Keep it natural, friendly, and concise (1 sentence, max ~10 words).",
    "- Sound like a real person texting, not a support bot.",
    "- Do NOT claim personal real-world experiences you cannot verify (e.g., don't say you watched a game).",
    "- Acknowledge the message with conversational tone.",
    "- Do NOT mention emojis, reactions, or 'thumbs up' explicitly.",
    allowBikePivotHint
      ? "- You MAY lightly keep the door open for bike help in the same sentence."
      : "- Do NOT pivot back to bikes in this reply.",
    allowBikePivotHint
      ? "- If relevant, lightly mirror their topic (e.g., game/playoffs) before a soft bike pivot."
      : "- Keep this as pure off-topic small-talk acknowledgment.",
    "- Do NOT switch into pricing/availability/scheduling unless asked.",
    "- Avoid stiff fallback phrases like 'I'm checking that now'.",
    "- Do NOT use phrases like 'I'm here if you need anything' or 'Got it.' as the main reply.",
    "",
    "Good examples:",
    allowBikePivotHint
      ? "- \"Haha, fair one - if you want to jump back into bikes, I can help anytime.\""
      : "- \"Haha, fair one - that one had everyone talking.\"",
    allowBikePivotHint
      ? "- \"Playoff energy is real - whenever you want, we can hop back into bike details.\""
      : "- \"Playoff energy is real this week.\"",
    allowBikePivotHint
      ? "- \"Good one - when you want to get back to bikes, I’ve got you.\""
      : "- \"Good one - sounds like everyone was locked in.\"",
    "",
    history.length ? `Recent messages:\n${history.join("\n")}` : "Recent messages: (none)",
    `Humor hint: ${hasHumorHint ? "true" : "false"}`,
    `Allow bike pivot in this reply: ${allowBikePivotHint ? "true" : "false"}`,
    smallTalkStreakHint != null ? `Current small-talk streak: ${smallTalkStreakHint}` : null,
    `Customer message: ${text}`
  ]
    .filter(Boolean)
    .join("\n");
  const genericPatterns = [
    /\bim here if you need anything\b/,
    /\bi am here if you need anything\b/,
    /\bi m here if you need anything\b/,
    /\bhere if you need anything\b/,
    /\bgot it\b/,
    /\bi m checking that now\b/,
    /\bim checking that now\b/
  ];
  const normalizeReply = (input: string) =>
    String(input ?? "")
      .trim()
      .replace(/^["'`]+|["'`]+$/g, "")
      .replace(/\s+/g, " ");
  const toShortOneLiner = (input: string, maxWords = 10): string => {
    const normalized = normalizeReply(input);
    if (!normalized) return "";
    let sentence = normalized;
    const sentenceSplit = sentence.split(/(?<=[.!?])\s+/).filter(Boolean);
    if (sentenceSplit.length) sentence = sentenceSplit[0];
    // Trim common trailing filler so the line stays punchy and conversational.
    sentence = sentence
      .replace(/\bfor\s+(?:easy|comfortable|comfort|long|longer|daily)\b[^.!?]*$/i, "")
      .replace(/\band\s+(?:comfort|easy rides?)\b[^.!?]*$/i, "")
      .trim();
    if (!sentence) return "";
    const words = sentence.split(/\s+/).filter(Boolean);
    if (words.length > maxWords) {
      sentence = words.slice(0, maxWords).join(" ");
      sentence = sentence.replace(/[,\-:;]+$/g, "").trim();
    }
    return sentence;
  };
  const isTooGeneric = (input: string) => {
    const normalized = input
      .toLowerCase()
      .replace(/[^\w\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    return genericPatterns.some(rx => rx.test(normalized));
  };

  const tryFreeformBackup = async (): Promise<string | null> => {
    try {
      const resp = await client.responses.create({
        model,
        instructions: [
          "Write one short, natural SMS reply (max 1 sentence, <= 20 words).",
          "The customer sent off-topic small talk/chatter.",
          allowBikePivotHint
            ? "Acknowledge casually and you may lightly keep the door open for bike help."
            : "Acknowledge casually without pivoting back to bikes.",
          "Do not mention emojis, reactions, or 'thumbs up'.",
          "Do not say you're checking anything.",
          "Do not use: 'I'm here if you need anything.'",
          "Do not switch into pricing/availability/scheduling."
        ].join(" "),
        input: [
          history.length ? `Recent messages:\n${history.join("\n")}` : "Recent messages: (none)",
          `Humor hint: ${hasHumorHint ? "true" : "false"}`,
          `Customer message: ${text}`
        ].join("\n"),
        ...optionalCreateTextConfig(model),
        ...optionalTemperature(model, 0.2),
        max_output_tokens: 60
      });
      recordOpenAIUsage(resp, {
        feature: "llm_reply",
        operation: "small_talk_freeform_backup",
        requestKind: "responses.create",
        model
      });
      const freeform = toShortOneLiner(resp.output_text ?? "");
      if (!freeform) return null;
      if (isTooGeneric(freeform)) return null;
      return freeform;
    } catch {
      return null;
    }
  };

  try {
    const parsed = await requestStructuredJson({
      model,
      prompt,
      schemaName: "small_talk_reply_generator",
      schema,
      maxOutputTokens: 120,
      debugTag: "llm-smalltalk-reply-generator"
    });
    if (parsed && typeof parsed === "object") {
      const reply = toShortOneLiner(parsed.reply ?? "");
      if (reply && !isTooGeneric(reply)) {
        const confidence =
          typeof parsed.confidence === "number" && Number.isFinite(parsed.confidence)
            ? Math.max(0, Math.min(1, parsed.confidence))
            : undefined;
        return { reply, confidence, source: "structured" };
      }
    }
  } catch {
    // continue to freeform backup below
  }

  const freeformReply = await tryFreeformBackup();
  if (freeformReply) {
    return { reply: freeformReply, confidence: 0.75, source: "freeform" };
  }
  return null;
}

export async function generateBlendedLeadInWithLLM(args: {
  text: string;
  history?: { direction: "in" | "out"; body: string }[];
  hasHumorHint?: boolean;
}): Promise<{ leadIn: string; confidence?: number; source?: "structured" | "freeform" } | null> {
  const useLLM = process.env.LLM_ENABLED === "1" && !!process.env.OPENAI_API_KEY;
  if (!useLLM) return null;
  const model = process.env.OPENAI_MODEL || "gpt-5-mini";
  const text = String(args.text ?? "").trim();
  if (!text) return null;
  const hasHumorHint = !!args.hasHumorHint;
  const history = (args.history ?? []).slice(-4).map(h => `${h.direction}: ${h.body}`);
  const schema: { [key: string]: unknown } = {
    type: "object",
    additionalProperties: false,
    required: ["lead_in", "confidence"],
    properties: {
      lead_in: { type: "string" },
      confidence: { type: "number" }
    }
  };
  const prompt = [
    "Write a short conversational lead-in for a blended dealership SMS response.",
    "The full message will answer the business question separately; you only write the opening phrase.",
    "Return only JSON that matches the schema.",
    "",
    "Rules:",
    "- Keep it very short (2-8 words).",
    "- It should sound natural and human.",
    "- Do not ask a question.",
    "- Do not promise follow-up/checking.",
    "- Do not mention pricing/scheduling/availability directly.",
    "- Avoid generic phrases like 'Got it.' or 'I’m here if you need anything.'",
    "",
    "Good examples:",
    "- \"Haha, fair one.\"",
    "- \"Good one.\"",
    "- \"Love it.\"",
    "- \"Great question.\"",
    "",
    history.length ? `Recent messages:\n${history.join("\n")}` : "Recent messages: (none)",
    `Humor hint: ${hasHumorHint ? "true" : "false"}`,
    `Customer message: ${text}`
  ].join("\n");
  const normalizeLeadIn = (input: string) =>
    String(input ?? "")
      .trim()
      .replace(/^["'`]+|["'`]+$/g, "")
      .replace(/\s+/g, " ");
  const isGeneric = (input: string) => {
    const normalized = input
      .toLowerCase()
      .replace(/[^\w\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    return (
      /\bgot it\b/.test(normalized) ||
      /\bi m here if you need anything\b/.test(normalized) ||
      /\bim here if you need anything\b/.test(normalized) ||
      /\bi am here if you need anything\b/.test(normalized) ||
      /\bhere if you need anything\b/.test(normalized) ||
      /\bchecking that now\b/.test(normalized)
    );
  };

  try {
    const parsed = await requestStructuredJson({
      model,
      prompt,
      schemaName: "blended_lead_in_generator",
      schema,
      maxOutputTokens: 80,
      debugTag: "llm-blended-lead-in-generator"
    });
    if (parsed && typeof parsed === "object") {
      const leadIn = normalizeLeadIn(parsed.lead_in ?? "");
      if (leadIn && !isGeneric(leadIn) && !/\?/.test(leadIn)) {
        const confidence =
          typeof parsed.confidence === "number" && Number.isFinite(parsed.confidence)
            ? Math.max(0, Math.min(1, parsed.confidence))
            : undefined;
        return { leadIn, confidence, source: "structured" };
      }
    }
  } catch {}

  try {
    const resp = await client.responses.create({
      model,
      instructions: [
        "Write one short conversational lead-in for a dealership SMS reply.",
        "2-8 words, no question.",
        "No checking/follow-up wording.",
        "Avoid generic phrases like 'Got it.'"
      ].join(" "),
      input: [
        history.length ? `Recent messages:\n${history.join("\n")}` : "Recent messages: (none)",
        `Humor hint: ${hasHumorHint ? "true" : "false"}`,
        `Customer message: ${text}`
      ].join("\n"),
      ...optionalCreateTextConfig(model),
      ...optionalTemperature(model, 0.2),
      max_output_tokens: 40
    });
    recordOpenAIUsage(resp, {
      feature: "llm_reply",
      operation: "blended_lead_in_freeform_backup",
      requestKind: "responses.create",
      model
    });
    const leadIn = normalizeLeadIn(resp.output_text ?? "");
    if (leadIn && !isGeneric(leadIn) && !/\?/.test(leadIn)) {
      return { leadIn, confidence: 0.75, source: "freeform" };
    }
  } catch {}

  return null;
}

export async function generateEmpathySupportReplyWithLLM(args: {
  text: string;
  history?: { direction: "in" | "out"; body: string }[];
  topicHint?: string | null;
}): Promise<EmpathySupportReplyParse | null> {
  const useLLM = process.env.LLM_ENABLED === "1" && !!process.env.OPENAI_API_KEY;
  if (!useLLM) return null;
  const model = process.env.OPENAI_MODEL || "gpt-5-mini";
  const text = String(args.text ?? "").trim();
  if (!text) return null;
  const history = (args.history ?? []).slice(-4).map(h => `${h.direction}: ${h.body}`);
  const topicHint = String(args.topicHint ?? "").trim();
  const schema: { [key: string]: unknown } = {
    type: "object",
    additionalProperties: false,
    required: ["reply", "confidence"],
    properties: {
      reply: { type: "string" },
      confidence: { type: "number" }
    }
  };
  const prompt = [
    "You write one short dealership SMS reply for a frustrated customer message.",
    "Return only JSON that matches the schema.",
    "",
    "Rules:",
    "- 1 sentence preferred (2 max), concise and human.",
    "- Acknowledge frustration/emotion directly.",
    "- Do not pivot to inventory, pricing, or scheduling unless the customer explicitly asked.",
    "- Do not say 'I'm checking that now'.",
    "- Do not promise department handoff unless asked.",
    "- Keep tone calm, helpful, and conversational.",
    "",
    "Good examples:",
    "- \"Yeah, I hear you — a few riders have said the same thing about that.\"",
    "- \"Totally get it — that can be frustrating, and you’re not the only one who’s run into it.\"",
    "",
    topicHint ? `Topic hint: ${topicHint}` : null,
    history.length ? `Recent messages:\n${history.join("\n")}` : "Recent messages: (none)",
    `Customer message: ${text}`
  ]
    .filter(Boolean)
    .join("\n");

  try {
    const parsed = await requestStructuredJson({
      model,
      prompt,
      schemaName: "empathy_support_reply",
      schema,
      maxOutputTokens: 120,
      debugTag: "llm-empathy-support-reply"
    });
    if (parsed && typeof parsed === "object") {
      const reply = String(parsed.reply ?? "")
        .trim()
        .replace(/^["'`]+|["'`]+$/g, "")
        .replace(/\s+/g, " ");
      if (!reply) return null;
      const confidence =
        typeof parsed.confidence === "number" && Number.isFinite(parsed.confidence)
          ? Math.max(0, Math.min(1, parsed.confidence))
          : undefined;
      return { reply, confidence };
    }
  } catch {}
  return null;
}

export async function generateWebFallbackReplyWithLLM(args: {
  question: string;
  results: { title: string; snippet: string; url: string }[];
  history?: { direction: "in" | "out"; body: string }[];
}): Promise<WebFallbackReplyParse | null> {
  const useLLM = process.env.LLM_ENABLED === "1" && !!process.env.OPENAI_API_KEY;
  if (!useLLM) return null;
  const model = process.env.OPENAI_MODEL || "gpt-5-mini";
  const question = String(args.question ?? "").trim();
  if (!question) return null;
  const results = (args.results ?? [])
    .slice(0, 5)
    .map((r, idx) => {
      const title = String(r?.title ?? "").trim();
      const snippet = String(r?.snippet ?? "").trim();
      const url = String(r?.url ?? "").trim();
      return `${idx + 1}. ${title}\nSnippet: ${snippet}\nURL: ${url}`;
    })
    .filter(Boolean);
  if (!results.length) return null;
  const history = (args.history ?? []).slice(-4).map(h => `${h.direction}: ${h.body}`);
  const schema: { [key: string]: unknown } = {
    type: "object",
    additionalProperties: false,
    required: ["reply", "answerable", "needs_follow_up", "confidence"],
    properties: {
      reply: { type: "string" },
      answerable: { type: "boolean" },
      needs_follow_up: { type: "boolean" },
      confidence: { type: "number" }
    }
  };
  const prompt = [
    "You write one concise dealership SMS answer using ONLY the provided search snippets.",
    "Return only JSON that matches the schema.",
    "",
    "Rules:",
    "- If snippets are insufficient or uncertain, set answerable=false and needs_follow_up=true.",
    "- If answerable=true, provide a direct helpful answer in 1-2 short sentences.",
    "- Keep tone conversational and human.",
    "- Do not mention internal tools, confidence, or uncertainty percentages.",
    "- Do not invent facts beyond snippets.",
    "",
    history.length ? `Recent messages:\n${history.join("\n")}` : "Recent messages: (none)",
    `Customer question: ${question}`,
    "Search snippets:",
    results.join("\n\n")
  ].join("\n");

  try {
    const parsed = await requestStructuredJson({
      model,
      prompt,
      schemaName: "web_fallback_reply",
      schema,
      maxOutputTokens: 220,
      debugTag: "llm-web-fallback-reply"
    });
    if (!parsed || typeof parsed !== "object") return null;
    const reply = String(parsed.reply ?? "")
      .trim()
      .replace(/^["'`]+|["'`]+$/g, "")
      .replace(/\s+/g, " ");
    if (!reply) return null;
    const confidence =
      typeof parsed.confidence === "number" && Number.isFinite(parsed.confidence)
        ? Math.max(0, Math.min(1, parsed.confidence))
        : undefined;
    return {
      reply,
      answerable: !!parsed.answerable,
      needsFollowUp: !!parsed.needs_follow_up,
      confidence
    };
  } catch {
    return null;
  }
}

export async function classifyEmpathyNeedWithLLM(args: {
  text: string;
  history?: { direction: "in" | "out"; body: string }[];
}): Promise<boolean | null> {
  const useLLM = process.env.LLM_ENABLED === "1" && !!process.env.OPENAI_API_KEY;
  if (!useLLM) return null;
  const model = process.env.OPENAI_MODEL || "gpt-5-mini";
  const text = String(args.text ?? "").trim();
  if (!text) return null;
  const history = (args.history ?? []).slice(-2).map(h => `${h.direction}: ${h.body}`);
  const schema: { [key: string]: unknown } = {
    type: "object",
    additionalProperties: false,
    required: ["needs_empathy", "confidence"],
    properties: {
      needs_empathy: { type: "boolean" },
      confidence: { type: "number" }
    }
  };
  const prompt = [
    "You are a classifier for dealership SMS.",
    "Return only JSON that matches the schema.",
    "Question: Does this message describe a personal hardship or serious situation where empathy is appropriate?",
    "needs_empathy=true only when empathy is clearly appropriate.",
    "confidence is 0 to 1.",
    "",
    history.length ? `Recent messages:\n${history.join("\n")}` : "Recent messages: (none)",
    `Message: ${text}`
  ].join("\n");
  try {
    const parsed = await requestStructuredJson({
      model,
      prompt,
      schemaName: "empathy_need_classifier",
      schema,
      maxOutputTokens: 80,
      debugTag: "llm-empathy-classifier"
    });
    if (!parsed || typeof parsed !== "object") return null;
    return !!parsed.needs_empathy;
  } catch {
    return null;
  }
}

export async function classifyComplimentWithLLM(args: {
  text: string;
  history?: { direction: "in" | "out"; body: string }[];
}): Promise<boolean | null> {
  const useLLM = process.env.LLM_ENABLED === "1" && !!process.env.OPENAI_API_KEY;
  if (!useLLM) return null;
  const model = process.env.OPENAI_MODEL || "gpt-5-mini";
  const text = String(args.text ?? "").trim();
  if (!text) return null;
  const history = (args.history ?? []).slice(-2).map(h => `${h.direction}: ${h.body}`);
  const schema: { [key: string]: unknown } = {
    type: "object",
    additionalProperties: false,
    required: ["is_compliment", "confidence"],
    properties: {
      is_compliment: { type: "boolean" },
      confidence: { type: "number" }
    }
  };
  const prompt = [
    "You are a classifier for dealership SMS.",
    "Return only JSON that matches the schema.",
    "Question: Is this message a compliment or positive remark about the bike or its features (e.g., love the wheels, nice exhaust, looks great)?",
    "is_compliment=true only when the message has a clear compliment.",
    "confidence is 0 to 1.",
    "",
    history.length ? `Recent messages:\n${history.join("\n")}` : "Recent messages: (none)",
    `Message: ${text}`
  ].join("\n");
  try {
    const parsed = await requestStructuredJson({
      model,
      prompt,
      schemaName: "compliment_classifier",
      schema,
      maxOutputTokens: 80,
      debugTag: "llm-compliment-classifier"
    });
    if (!parsed || typeof parsed !== "object") return null;
    return !!parsed.is_compliment;
  } catch {
    return null;
  }
}

export async function classifyCadenceContextWithLLM(args: {
  history: { direction: "in" | "out"; body: string }[];
}): Promise<string | null> {
  const useLLM = process.env.LLM_ENABLED === "1" && !!process.env.OPENAI_API_KEY;
  if (!useLLM) return null;
  const model = process.env.OPENAI_MODEL || "gpt-5-mini";
  const history = (args.history ?? []).slice(-6).map(h => `${h.direction}: ${h.body}`);
  if (!history.length) return null;
  const schema: { [key: string]: unknown } = {
    type: "object",
    additionalProperties: false,
    required: ["label", "confidence"],
    properties: {
      label: {
        type: "string",
        enum: ["trade", "pricing", "payments", "finance_docs", "inventory", "scheduling", "general"]
      },
      confidence: { type: "number" }
    }
  };
  const prompt = [
    "You are a classifier for dealership follow-up context.",
    "Return only JSON that matches the schema.",
    "label must be one of: trade, pricing, payments, finance_docs, inventory, scheduling, general.",
    "",
    "Guidelines:",
    "- trade: trade-in, appraisal, sell my bike, cash offer, payoff/lien.",
    "- pricing: MSRP, price, OTD, quote, rebates.",
    "- payments: monthly payment, APR, term, down payment, financing numbers.",
    "- finance_docs: lender contingencies / pending docs (references, pay stubs, proof of residence, co-signer, missing paperwork).",
    "- inventory: availability, in stock, model/trim/color/finish questions.",
    "- scheduling: appointment time, stop in, visit, test ride scheduling.",
    "- general: none of the above.",
    "",
    `Recent messages:\n${history.join("\n")}`
  ].join("\n");
  try {
    const parsed = await requestStructuredJson({
      model,
      prompt,
      schemaName: "cadence_context_classifier",
      schema,
      maxOutputTokens: 80,
      debugTag: "llm-cadence-context-classifier"
    });
    const label = String(parsed?.label ?? "").toLowerCase().trim();
    if (["trade", "pricing", "payments", "finance_docs", "inventory", "scheduling", "general"].includes(label))
      return label;
    return null;
  } catch {
    return null;
  }
}

const CADENCE_REGENERATE_CONTEXT_PARSER_JSON_SCHEMA: { [key: string]: unknown } = {
  type: "object",
  additionalProperties: false,
  required: ["state", "allow_generic_cadence", "reason", "confidence"],
  properties: {
    state: {
      type: "string",
      enum: [
        "active_test_ride",
        "held_inventory_update",
        "sold_inventory_update",
        "purchase_delivery",
        "trade_appraisal",
        "watch_active",
        "soft_exit",
        "no_response_needed",
        "generic_followup"
      ]
    },
    allow_generic_cadence: { type: "boolean" },
    reason: { type: "string" },
    confidence: { type: "number" }
  }
};

export async function parseCadenceRegenerateContextWithLLM(args: {
  selectedInboundText?: string | null;
  lastDraftText?: string | null;
  history?: { direction: "in" | "out"; body: string }[];
  lead?: Conversation["lead"];
  dialogState?: string | null;
  followUpMode?: string | null;
  followUpReason?: string | null;
  hasInventoryWatch?: boolean;
  hasAppointment?: boolean;
}): Promise<CadenceRegenerateContextParse | null> {
  const useLLM =
    process.env.LLM_ENABLED === "1" &&
    process.env.LLM_CADENCE_REGENERATE_CONTEXT_PARSER_ENABLED !== "0" &&
    !!process.env.OPENAI_API_KEY;
  if (!useLLM) return null;

  const debug = process.env.LLM_CADENCE_REGENERATE_CONTEXT_PARSER_DEBUG === "1";
  const primaryModel =
    process.env.OPENAI_CADENCE_REGENERATE_CONTEXT_PARSER_MODEL ||
    process.env.OPENAI_CONVERSATION_STATE_PARSER_MODEL ||
    process.env.OPENAI_MODEL ||
    "gpt-5-mini";
  const fallbackModel =
    process.env.OPENAI_CADENCE_REGENERATE_CONTEXT_PARSER_MODEL_FALLBACK ||
    process.env.OPENAI_CONVERSATION_STATE_PARSER_MODEL_FALLBACK ||
    (primaryModel === "gpt-5-mini" ? "gpt-4o-mini" : "");

  const selectedInboundText = String(args.selectedInboundText ?? "").trim();
  const lastDraftText = String(args.lastDraftText ?? "").trim();
  const history = (args.history ?? []).slice(-10).map(h => `${h.direction}: ${h.body}`);
  if (!selectedInboundText && !lastDraftText && !history.length) return null;

  const lead = args.lead ?? {};
  const examples = [
    'selected_inbound: "Customer Comments: Preferred method of contact - email-" last_draft: "Hey James, checking back about the CVO Road Glide ST. If helpful, I can send a simple compare and next-step options." context: "bike on hold" output: {"state":"held_inventory_update","allow_generic_cadence":false,"reason":"requested unit appears unavailable; do not use generic check-in","confidence":0.94}',
    'selected_inbound: "1-2 o clock ish" history: "out: What time works for you today? in: loans finalized" output: {"state":"purchase_delivery","allow_generic_cadence":false,"reason":"pickup/delivery timing, not a generic follow-up","confidence":0.95}',
    'selected_inbound: "Ok no problem" history: "out: Just let me know when you have a better idea of time" output: {"state":"no_response_needed","allow_generic_cadence":false,"reason":"short acknowledgement after staff reply","confidence":0.92}',
    'selected_inbound: "I thought I was signing up for a demo day" last_draft: "Hey Joe, good news, a Road Glide came in" output: {"state":"active_test_ride","allow_generic_cadence":false,"reason":"test ride/demo day topic should route through scheduling or demo-day handling","confidence":0.93}',
    'selected_inbound: "Can you get me numbers on the orange ST" last_draft: "Hey Gary, just checking in on the 2025 CVO Road Glide ST" output: {"state":"held_inventory_update","allow_generic_cadence":false,"reason":"specific inventory/pricing target, not generic cadence","confidence":0.9}',
    'selected_inbound: "I am not ready right now, maybe later" last_draft: "Just checking in" output: {"state":"soft_exit","allow_generic_cadence":false,"reason":"customer is stepping back","confidence":0.9}',
    'selected_inbound: "Do you have any Street Bob coming in?" last_draft: "I’ll check on the status of the Street Bob" output: {"state":"watch_active","allow_generic_cadence":false,"reason":"inventory watch/factory timing state should not use generic cadence","confidence":0.9}',
    'selected_inbound: "trade-in appraisal request" last_draft: "Just checking in on your trade-in estimate" output: {"state":"trade_appraisal","allow_generic_cadence":false,"reason":"trade appraisal flow should use trade follow-up","confidence":0.9}',
    'selected_inbound: "WEB LEAD (ADF) Customer Comments: Preferred method of contact - email-" last_draft: "Hey Sally, checking back. If helpful, I can send options." output: {"state":"generic_followup","allow_generic_cadence":true,"reason":"no newer actionable state visible","confidence":0.86}'
  ];

  const prompt = [
    "You are a safety parser for dealership cadence draft regeneration.",
    "Return only JSON matching the schema.",
    "",
    "Goal: decide whether it is safe to regenerate a generic follow-up cadence draft, or whether a specific state should block generic cadence and let routing handle the selected inbound.",
    "",
    "States:",
    "- active_test_ride: test ride/demo day/scheduling context needs appointment/test-ride handling.",
    "- held_inventory_update: customer or draft targets a specific bike that is on hold/unavailable or mentions hold/sold risk.",
    "- sold_inventory_update: customer or draft targets a specific bike that sold/no longer available.",
    "- purchase_delivery: loan, bank, certified check, insurance, title, pickup/delivery arrival, taking bike home.",
    "- trade_appraisal: trade-in, appraisal, bring trade, sell bike, cash offer.",
    "- watch_active: keep an eye out / incoming inventory / factory/order timing / watch state.",
    "- soft_exit: customer is stepping back, not ready, later, no pressure.",
    "- no_response_needed: short acknowledgement/signoff with no useful reply needed.",
    "- generic_followup: only when no specific state applies and a generic check-in is safe.",
    "",
    "Rules:",
    "- allow_generic_cadence must be false for every state except generic_followup.",
    "- If there is purchase/delivery timing, choose purchase_delivery even if the original lead was trade/appraisal.",
    "- If the customer asks a concrete question or gives a concrete timing/status update, do not choose generic_followup.",
    "- If uncertain, choose the specific state when there is clear evidence; otherwise generic_followup with lower confidence.",
    "- confidence is 0..1.",
    "",
    `Lead: ${JSON.stringify({
      source: lead?.source ?? null,
      model: lead?.vehicle?.model ?? lead?.vehicle?.description ?? null,
      year: lead?.vehicle?.year ?? null,
      stockId: lead?.vehicle?.stockId ?? null
    })}`,
    `Dialog state: ${args.dialogState ?? "none"}`,
    `Follow-up mode: ${args.followUpMode ?? "none"}`,
    `Follow-up reason: ${args.followUpReason ?? "none"}`,
    `Has inventory watch: ${args.hasInventoryWatch ? "yes" : "no"}`,
    `Has appointment: ${args.hasAppointment ? "yes" : "no"}`,
    history.length ? `Recent messages:\n${history.join("\n")}` : "Recent messages: (none)",
    `Selected inbound: ${selectedInboundText || "(none)"}`,
    `Last draft: ${lastDraftText || "(none)"}`,
    "Examples:",
    ...examples
  ].join("\n");

  const runParse = async (model: string): Promise<any | null> =>
    requestStructuredJson({
      model,
      prompt,
      schemaName: "cadence_regenerate_context_parser",
      schema: CADENCE_REGENERATE_CONTEXT_PARSER_JSON_SCHEMA,
      maxOutputTokens: 160,
      debugTag: "llm-cadence-regenerate-context-parser",
      debug
    });

  const parsedPrimary = await runParse(primaryModel);
  const parsed =
    parsedPrimary ??
    (fallbackModel && fallbackModel !== primaryModel ? await runParse(fallbackModel) : null);
  if (!parsed) return null;

  const rawState = String(parsed.state ?? "").toLowerCase();
  const state: CadenceRegenerateContextParse["state"] =
    rawState === "active_test_ride" ||
    rawState === "held_inventory_update" ||
    rawState === "sold_inventory_update" ||
    rawState === "purchase_delivery" ||
    rawState === "trade_appraisal" ||
    rawState === "watch_active" ||
    rawState === "soft_exit" ||
    rawState === "no_response_needed"
      ? rawState
      : "generic_followup";
  const confidence =
    typeof parsed.confidence === "number" && Number.isFinite(parsed.confidence)
      ? Math.max(0, Math.min(1, parsed.confidence))
      : undefined;

  return {
    state,
    allowGenericCadence: state === "generic_followup" ? !!parsed.allow_generic_cadence : false,
    reason: cleanOptionalString(parsed.reason),
    confidence
  };
}

export type CadencePersonalizationParse = {
  line: string;
  confidence?: number;
};

export type CadenceRegenerateContextState =
  | "active_test_ride"
  | "held_inventory_update"
  | "sold_inventory_update"
  | "purchase_delivery"
  | "trade_appraisal"
  | "watch_active"
  | "soft_exit"
  | "no_response_needed"
  | "generic_followup";

export type CadenceRegenerateContextParse = {
  state: CadenceRegenerateContextState;
  allowGenericCadence: boolean;
  reason?: string | null;
  confidence?: number;
};

export async function parseCadencePersonalizationLineWithLLM(args: {
  history: { direction: "in" | "out"; body: string }[];
}): Promise<CadencePersonalizationParse | null> {
  const useLLM = process.env.LLM_ENABLED === "1" && !!process.env.OPENAI_API_KEY;
  if (!useLLM) return null;
  const model = process.env.OPENAI_MODEL || "gpt-5-mini";
  const history = (args.history ?? []).slice(-10).map(h => `${h.direction}: ${h.body}`);
  if (!history.length) return null;
  const schema: { [key: string]: unknown } = {
    type: "object",
    additionalProperties: false,
    required: ["line", "confidence"],
    properties: {
      line: { type: "string" },
      confidence: { type: "number" }
    }
  };
  const prompt = [
    "You write one optional, human, follow-up personalization line for dealership SMS.",
    "Return only JSON matching the schema.",
    "",
    "Goal:",
    "- Use a concrete personal/situational detail from recent conversation/context when available.",
    "- Example style: \"Hope training in Boston went well.\"",
    "",
    "Rules:",
    "- line must be a single sentence, natural tone, 4-16 words.",
    "- If no safe/relevant detail exists, return line as empty string.",
    "- Do not invent facts.",
    "- Do not include pricing/inventory asks, links, calls-to-action, or appointment prompts.",
    "- Do not say a photo/video/picture helped, was sent, was attached, or was received.",
    "- Avoid sensitive details (medical/legal/financial specifics).",
    "- Do not reference family milestones/events (birthday, party, graduation, wedding, anniversary) even if mentioned in passing.",
    "- Be tense-safe: if timing is uncertain or likely past, prefer past/neutral phrasing like \"went well\" or \"hope everything's going smoothly.\"",
    "- Avoid assuming an ongoing event is still happening.",
    "- Do not use weather or riding-condition small talk.",
    "",
    `Recent messages/context:\n${history.join("\n")}`
  ].join("\n");
  try {
    const parsed = await requestStructuredJson({
      model,
      prompt,
      schemaName: "cadence_personalization_line",
      schema,
      maxOutputTokens: 80,
      debugTag: "llm-cadence-personalization"
    });
    const line = String(parsed?.line ?? "").replace(/\s+/g, " ").trim();
    const confidence =
      typeof parsed?.confidence === "number" && Number.isFinite(parsed.confidence)
        ? Math.max(0, Math.min(1, parsed.confidence))
        : undefined;
    return { line, confidence };
  } catch {
    return null;
  }
}

export async function parseAffectWithLLM(args: {
  text: string;
  history?: { direction: "in" | "out"; body: string }[];
  lead?: Conversation["lead"];
}): Promise<AffectParse | null> {
  const useLLM =
    process.env.LLM_ENABLED === "1" &&
    process.env.LLM_AFFECT_PARSER_ENABLED !== "0" &&
    !!process.env.OPENAI_API_KEY;
  if (!useLLM) return null;

  const debug = process.env.LLM_AFFECT_PARSER_DEBUG === "1";
  const primaryModel = process.env.OPENAI_AFFECT_PARSER_MODEL || process.env.OPENAI_MODEL || "gpt-5-mini";
  const fallbackModel =
    process.env.OPENAI_AFFECT_PARSER_MODEL_FALLBACK ||
    (primaryModel === "gpt-5-mini" ? "gpt-4o-mini" : "");
  const text = String(args.text ?? "").trim();
  if (!text) return null;

  const history = (args.history ?? []).slice(-6).map(h => `${h.direction}: ${h.body}`);
  const lead = args.lead ?? {};
  const prompt = [
    "You parse customer affect for dealership conversations.",
    "Return only JSON matching the schema.",
    "",
    "Output fields:",
    "- primary_affect: one of neutral, frustrated, excited, humorous, confused, anxious, angry, urgent, none.",
    "- explicit_affect: true only when affect is clearly expressed in the message.",
    "- needs_empathy: true when a short empathy acknowledgment is appropriate.",
    "- has_humor: true when message includes joking/light humor.",
    "- has_positive_energy: true for excitement/positive enthusiasm.",
    "- has_negative_sentiment: true for frustration, anger, anxiety, or disappointment.",
    "- tone_intensity: 0..1 strength of tone in the latest inbound message.",
    "- confidence: 0..1.",
    "",
    "Rules:",
    "- Focus on the latest inbound message first; use history only to disambiguate.",
    "- If uncertain, choose primary_affect=none with lower confidence.",
    "- A short acknowledgment like 'ok thanks' is usually neutral unless clear frustration/excitement appears.",
    "",
    `Known lead info: ${JSON.stringify({
      model: lead?.vehicle?.model ?? lead?.vehicle?.description ?? null,
      year: lead?.vehicle?.year ?? null
    })}`,
    history.length ? `Recent messages:\n${history.join("\n")}` : "Recent messages: (none)",
    `Message: ${text}`
  ].join("\n");

  const runParse = async (model: string): Promise<any | null> =>
    requestStructuredJson({
      model,
      prompt,
      schemaName: "affect_parser",
      schema: AFFECT_PARSER_JSON_SCHEMA,
      maxOutputTokens: 180,
      debugTag: "llm-affect-parser",
      debug
    });

  const parsedPrimary = await runParse(primaryModel);
  const parsed =
    parsedPrimary ??
    (fallbackModel && fallbackModel !== primaryModel ? await runParse(fallbackModel) : null);
  if (!parsed) return null;

  const primaryAffectRaw = String(parsed.primary_affect ?? "").toLowerCase();
  const primaryAffect: AffectParse["primaryAffect"] =
    primaryAffectRaw === "neutral" ||
    primaryAffectRaw === "frustrated" ||
    primaryAffectRaw === "excited" ||
    primaryAffectRaw === "humorous" ||
    primaryAffectRaw === "confused" ||
    primaryAffectRaw === "anxious" ||
    primaryAffectRaw === "angry" ||
    primaryAffectRaw === "urgent"
      ? primaryAffectRaw
      : "none";
  const toneIntensity =
    typeof parsed.tone_intensity === "number" && Number.isFinite(parsed.tone_intensity)
      ? Math.max(0, Math.min(1, parsed.tone_intensity))
      : undefined;
  const confidence =
    typeof parsed.confidence === "number" && Number.isFinite(parsed.confidence)
      ? Math.max(0, Math.min(1, parsed.confidence))
      : undefined;

  return {
    primaryAffect,
    explicitAffect: !!parsed.explicit_affect,
    needsEmpathy: !!parsed.needs_empathy,
    hasHumor: !!parsed.has_humor,
    hasPositiveEnergy: !!parsed.has_positive_energy,
    hasNegativeSentiment: !!parsed.has_negative_sentiment,
    toneIntensity,
    confidence
  };
}

export async function summarizeSalespersonNoteWithLLM(args: {
  text: string;
  history?: { direction: "in" | "out"; body: string }[];
}): Promise<string | null> {
  const useLLM = process.env.LLM_ENABLED === "1" && !!process.env.OPENAI_API_KEY;
  if (!useLLM) return null;
  const model = process.env.OPENAI_MODEL || "gpt-5-mini";
  const text = String(args.text ?? "").trim();
  if (!text) return null;
  const history = (args.history ?? []).slice(-2).map(h => `${h.direction}: ${h.body}`);
  const prompt = [
    "Summarize the customer's message for internal salesperson context.",
    "- 1 sentence max.",
    "- Focus on the key update or request.",
    "- Do not add advice or next steps.",
    "Return only the summary.",
    "",
    history.length ? `Recent messages:\n${history.join("\n")}` : "Recent messages: (none)",
    `Message: ${text}`
  ].join("\n");
  try {
    const resp = await client.responses.create({
      model,
      input: prompt,
      ...optionalCreateTextConfig(model),
      ...optionalTemperature(model, 0.2),
      max_output_tokens: 80
    });
    recordOpenAIUsage(resp, {
      feature: "llm_summary",
      operation: "salesperson_note",
      requestKind: "responses.create",
      model
    });
    const out = resp.output_text?.trim() ?? "";
    return out || null;
  } catch {
    return null;
  }
}

export type BookingParse = {
  intent: "schedule" | "reschedule" | "cancel" | "availability" | "question" | "none";
  explicitRequest: boolean;
  requested?: {
    day?: string | null;
    timeText?: string | null;
    timeWindow?: "exact" | "range" | "unknown";
  };
  reference?: "last_suggested" | "last_appointment" | "none";
  normalizedText?: string | null;
  confidence?: number;
};

export type AppointmentTimingIntent =
  | "accept_proposed_time"
  | "provide_new_time"
  | "tentative_time_window"
  | "arrival_update"
  | "ask_for_times"
  | "decline_time"
  | "none";

export type AppointmentTimingParse = {
  intent: AppointmentTimingIntent;
  explicitRequest: boolean;
  requested?: {
    day?: string | null;
    timeText?: string | null;
    timeWindow?: "exact" | "range" | "unknown";
  };
  reference?: "last_suggested" | "last_appointment" | "none";
  normalizedText?: string | null;
  confidence?: number;
};

export type CustomerAckAction =
  | "confirm_proposed_appointment"
  | "accept_tentative_appointment"
  | "ask_for_available_times"
  | "customer_will_provide_time"
  | "provide_arrival_window"
  | "purchase_delivery_update"
  | "no_response_needed"
  | "neutral_ack"
  | "none";

export type CustomerAckActionParse = {
  action: CustomerAckAction;
  explicitAction: boolean;
  shouldReply: boolean;
  shouldBook: boolean;
  requested?: {
    day?: string | null;
    timeText?: string | null;
    timeWindow?: "exact" | "range" | "unknown";
  };
  reference?: "last_outbound" | "last_suggested" | "last_appointment" | "none";
  normalizedText?: string | null;
  confidence?: number;
};

export type ManualOutboundAppointmentState =
  | "confirmed_booking"
  | "proposed_time"
  | "asks_for_time"
  | "slot_offer"
  | "reschedule_request"
  | "none";

export type ManualOutboundAppointmentParse = {
  state: ManualOutboundAppointmentState;
  explicitState: boolean;
  requested?: {
    day?: string | null;
    timeText?: string | null;
    timeWindow?: "exact" | "range" | "unknown";
  };
  reference?: "last_suggested" | "last_appointment" | "none";
  normalizedText?: string | null;
  confidence?: number;
};

export type IntentParse = {
  intent: "callback" | "test_ride" | "availability" | "none";
  explicitRequest: boolean;
  availability?: {
    model?: string | null;
    year?: string | null;
    color?: string | null;
    stockId?: string | null;
    condition?: "new" | "used" | "unknown";
  };
  callback?: {
    requested?: boolean;
    timeText?: string | null;
    phone?: string | null;
  };
  confidence?: number;
};

export type DialogActParse = {
  act: "trust_concern" | "frustration" | "objection" | "preference" | "clarification" | "none";
  topic: "used_inventory" | "new_inventory" | "pricing" | "trade" | "scheduling" | "service" | "general";
  explicitRequest: boolean;
  nextAction: "reassure_then_clarify" | "empathize_then_offer_help" | "ask_one_clarifier" | "normal_flow";
  askFocus?: "model" | "budget" | "timing" | "condition" | "other" | null;
  confidence?: number;
};

export type CustomerDispositionParse = {
  disposition:
    | "none"
    | "sell_on_own"
    | "keep_current_bike"
    | "stepping_back"
    | "defer_no_window"
    | "defer_with_window";
  explicitDisposition: boolean;
  timeframeText?: string | null;
  confidence?: number;
};

export type FirstTimeRiderGuidanceParse = {
  intent:
    | "first_time_rider"
    | "no_motorcycle_endorsement"
    | "beginner_bike_advice"
    | "rider_course_info"
    | "none";
  explicitRequest: boolean;
  hasEndorsement?: boolean | null;
  asksTestRide?: boolean;
  asksBeginnerBike?: boolean;
  asksRiderCourse?: boolean;
  confidence?: number;
};

export type DealerTransactionPolicyParse = {
  intent:
    | "rider_to_rider_financing"
    | "private_seller_facilitation"
    | "external_dealer_facilitation"
    | "rider_to_rider_and_third_party"
    | "none";
  explicitRequest: boolean;
  asksRiderToRiderFinancing?: boolean;
  asksPrivateSellerFacilitation?: boolean;
  asksExternalDealerFacilitation?: boolean;
  confidence?: number;
};

export type TradePayoffParse = {
  payoffStatus: "unknown" | "no_lien" | "has_lien";
  needsLienHolderInfo: boolean;
  providesLienHolderInfo: boolean;
  confidence?: number;
};

export type TradeTargetValueParse = {
  hasTargetValue: boolean;
  amount?: number | null;
  rawText?: string | null;
  confidence?: number;
};

export type ResponseControlParse = {
  intent:
    | "opt_out"
    | "wrong_number"
    | "not_interested"
    | "schedule_request"
    | "compliment_only"
    | "no_response"
    | "none";
  explicitRequest: boolean;
  confidence?: number;
};

export type PurchaseDeliveryLogisticsParse = {
  intent: "delivery_progress" | "delivery_timing" | "docs_status" | "post_sale_item_pickup" | "none";
  explicitRequest: boolean;
  timingText?: string | null;
  confidence?: number;
};

export type SalespersonMentionParse = {
  intent: "handoff_request" | "context_reference" | "none";
  explicitRequest: boolean;
  targetFirstName?: string | null;
  confidence?: number;
};

export type AffectParse = {
  primaryAffect:
    | "neutral"
    | "frustrated"
    | "excited"
    | "humorous"
    | "confused"
    | "anxious"
    | "angry"
    | "urgent"
    | "none";
  explicitAffect: boolean;
  needsEmpathy: boolean;
  hasHumor: boolean;
  hasPositiveEnergy: boolean;
  hasNegativeSentiment: boolean;
  toneIntensity?: number;
  confidence?: number;
};

export type PricingPaymentsIntentParse = {
  intent: "pricing" | "payments" | "none";
  explicitRequest: boolean;
  asksMonthlyTarget: boolean;
  asksDownPayment: boolean;
  asksAprOrTerm: boolean;
  asksExternalApprovalTransfer: boolean;
  asksRiderToRiderFinancing: boolean;
  asksThirdPartyPurchaseFacilitation: boolean;
  confidence?: number;
};

export type RoutingDecisionParse = {
  primaryIntent: "pricing_payments" | "scheduling" | "callback" | "availability" | "general" | "none";
  explicitRequest: boolean;
  fallbackAction: "none" | "clarify" | "no_response";
  clarifyPrompt?: string | null;
  confidence?: number;
};

export type AccessoryRequestParse = {
  action: "can_install" | "status_check" | "demo_request" | "pricing_request" | "none";
  explicitRequest: boolean;
  item?: string | null;
  hasHumor?: boolean;
  confidence?: number;
};

export type VehicleFactQuestionParse = {
  questionType:
    | "year"
    | "price"
    | "otd_total"
    | "engine_feature"
    | "mileage"
    | "color"
    | "service_status"
    | "service_records"
    | "availability"
    | "hold_timing"
    | "finance_program_eligibility"
    | "none";
  explicitRequest: boolean;
  requestedFields?: string[];
  confidence?: number;
};

export type VehicleInfoRequestParse = {
  intent: "specs" | "compare" | "none";
  explicitRequest: boolean;
  focus: "engine" | "features" | "dimensions" | "accessories" | "general" | "unknown";
  format: "full" | "highlights" | "unknown";
  confidence?: number;
};

export type CompositeSalesInquiryParse = {
  explicitRequest: boolean;
  asksOutTheDoorPrice: boolean;
  asksAccessoryQuote: boolean;
  accessoryItems: string[];
  hasFitOrWeightConcern: boolean;
  hasFinancingConcern: boolean;
  hasGeneralChatter: boolean;
  confidence?: number;
};

export type EmpathySupportReplyParse = {
  reply: string;
  confidence?: number;
};

export type WebFallbackReplyParse = {
  reply: string;
  answerable: boolean;
  needsFollowUp: boolean;
  confidence?: number;
};

export type DealershipFaqTopicParse = {
  topic:
    | "pricing_cost_range"
    | "price_negotiation"
    | "fees_out_the_door"
    | "model_availability"
    | "custom_order"
    | "factory_order_timing"
    | "finance_approval"
    | "credit_score"
    | "finance_specials"
    | "no_money_down"
    | "trade_in"
    | "trade_tax_advantage"
    | "registration_requirements"
    | "street_legal"
    | "inspection_requirements"
    | "insurance_cost"
    | "insurance_required"
    | "warranty"
    | "authorized_dealer_benefits"
    | "test_ride"
    | "test_ride_eligibility"
    | "new_vs_used"
    | "none";
  explicitRequest: boolean;
  confidence?: number;
};

export type InventoryEntityParse = {
  targetType?:
    | "stock_id"
    | "vin"
    | "exact_year_model"
    | "model_only"
    | "color_model"
    | "alternate_request"
    | "generic_inventory"
    | "image_reference"
    | "none"
    | null;
  isAvailabilityQuestion?: boolean | null;
  isTestRideContext?: boolean | null;
  model?: string | null;
  year?: number | null;
  yearMin?: number | null;
  yearMax?: number | null;
  color?: string | null;
  trim?: string | null;
  stockId?: string | null;
  condition?: "new" | "used" | "unknown" | null;
  minPrice?: number | null;
  maxPrice?: number | null;
  monthlyBudget?: number | null;
  downPayment?: number | null;
  confidence?: number;
};

export type InventoryStatusIntent =
  | "availability_check"
  | "hold_status_question"
  | "incoming_status_question"
  | "factory_order_eta"
  | "unlisted_inventory_followup"
  | "alternate_inventory_request"
  | "image_availability_check"
  | "none";

export type InventoryStatusParse = {
  intent: InventoryStatusIntent;
  explicitRequest: boolean;
  target: InventoryEntityParse;
  confidence?: number;
};

function inferModelYearFromStockId(stockId: string | null | undefined): number | null {
  const raw = String(stockId ?? "").trim().toUpperCase();
  const match = raw.match(/(?:^|[-_\s])(\d{2})$/);
  if (!match) return null;
  const suffix = Number(match[1]);
  if (!Number.isFinite(suffix)) return null;
  const currentTwoDigitYear = new Date().getFullYear() % 100;
  return suffix <= currentTwoDigitYear + 1 ? 2000 + suffix : 1900 + suffix;
}

function isIncomingInventoryFaqQuestion(textRaw: string | null | undefined): boolean {
  const text = String(textRaw ?? "").toLowerCase();
  if (!text.trim()) return false;
  if (/\b(?:i'?m|i am|i’ll|i will|we'?re|we are)\s+coming in\b/.test(text)) return false;
  if (/\b(?:in stock|currently available|available right now|on the floor|have one now)\b/.test(text)) return false;
  return (
    /\b(?:do you|do u|you guys|are you|will you|can you)\b[\s\S]{0,100}\b(?:have|get|gettin'?g|receive|order)\b[\s\S]{0,100}\b(?:coming in|incoming|inbound|on order|arriv(?:e|es|ing))\b/.test(
      text
    ) ||
    /\b(?:do you|do u|you guys|are you|will you|can you)\b[\s\S]{0,100}\b(?:coming in|incoming|inbound|on order|arriv(?:e|es|ing))\b/.test(
      text
    ) ||
    /\b(?:any|any more|anything|models?|bikes?|units?)\b[\s\S]{0,80}\b(?:coming in|incoming|inbound|on order|arriv(?:e|es|ing))\b/.test(
      text
    )
  );
}

export type WalkInOutcomeParse = {
  state:
    | "none"
    | "deal_finalizing"
    | "deposit_left"
    | "sold_delivered"
    | "hold_requested"
    | "hold_cleared"
    | "cosigner_required"
    | "test_ride_completed"
    | "decision_pending"
    | "outside_financing_pending"
    | "down_payment_pending"
    | "trade_equity_pending"
    | "timing_defer_window"
    | "household_approval_pending"
    | "docs_or_insurance_pending";
  explicitState: boolean;
  testRideRequested: boolean;
  weatherSensitive: boolean;
  followUpWindowText?: string | null;
  confidence?: number;
};

export type JourneyIntentParse = {
  journeyIntent: "sale_trade" | "service_support" | "marketing_event" | "none";
  explicitRequest: boolean;
  confidence?: number;
};

export type StaffOutcomeUpdateParse = {
  outcome: "showed_up" | "no_show" | "sold" | "hold" | "follow_up" | "lost" | "other" | "none";
  explicitOutcome: boolean;
  followUpWindowText?: string | null;
  unitOnOrder?: boolean;
  unitStockId?: string | null;
  unitVin?: string | null;
  unitYear?: number | null;
  unitMake?: string | null;
  unitModel?: string | null;
  unitTrim?: string | null;
  confidence?: number;
};

export type AppointmentOutcomeFollowUpPlanParse = {
  followUpNeeded: boolean;
  customerStatus:
    | "interested"
    | "uncertain"
    | "not_ready"
    | "needs_more_info"
    | "comparing_options"
    | "finance_pending"
    | "lost"
    | "unknown";
  primaryConcern:
    | "bike_fit"
    | "comfort_confidence"
    | "price_payment"
    | "trade"
    | "financing"
    | "timing"
    | "availability"
    | "needs_spouse_or_friend"
    | "none"
    | "unknown";
  recommendedAction:
    | "invite_back"
    | "offer_alternative_ride"
    | "send_numbers"
    | "send_photos_or_video"
    | "call_customer"
    | "check_inventory"
    | "manager_follow_up"
    | "finance_follow_up"
    | "soft_check_in"
    | "no_follow_up";
  targetVehicleModel?: string | null;
  targetVehicleYear?: string | null;
  targetVehicleCondition?: "new" | "used" | "any" | "unknown" | null;
  originalVehicleModel?: string | null;
  followUpWindowText?: string | null;
  followUpDateText?: string | null;
  messageAngle:
    | "compare_alternative"
    | "confidence_reassurance"
    | "numbers_next_step"
    | "inventory_options"
    | "appointment_invite"
    | "soft_check_in"
    | "no_message";
  urgency: "now" | "today" | "tomorrow" | "this_week" | "next_week" | "later" | "unknown";
  draftSms?: string | null;
  reasoning?: string | null;
  confidence?: number;
};

export type FinanceOutcomeFromCallParse = {
  outcome: "approved" | "declined" | "needs_more_info" | "none";
  explicitOutcome: boolean;
  confidence?: number;
  reasonText?: string | null;
};

export type SemanticSlotParse = {
  watchAction: "set_watch" | "stop_watch" | "none";
  watch?: {
    model?: string | null;
    year?: string | null;
    yearMin?: number | null;
    yearMax?: number | null;
    color?: string | null;
    condition?: "new" | "used" | "any" | "unknown" | null;
    minPrice?: number | null;
    maxPrice?: number | null;
    monthlyBudget?: number | null;
    downPayment?: number | null;
  };
  departmentIntent: "service" | "parts" | "apparel" | "none";
  contactPreferenceIntent?: "call_only" | "none";
  mediaIntent?: "video" | "photos" | "either" | "none";
  serviceRecordsIntent?: boolean;
  confidence?: number;
};

export type UnifiedSemanticSlotParse = {
  watchAction: "set_watch" | "stop_watch" | "none";
  watch?: {
    model?: string | null;
    year?: string | null;
    yearMin?: number | null;
    yearMax?: number | null;
    color?: string | null;
    condition?: "new" | "used" | "any" | "unknown" | null;
    minPrice?: number | null;
    maxPrice?: number | null;
    monthlyBudget?: number | null;
    downPayment?: number | null;
  };
  departmentIntent: "service" | "parts" | "apparel" | "none";
  contactPreferenceIntent?: "call_only" | "none";
  mediaIntent?: "video" | "photos" | "either" | "none";
  serviceRecordsIntent?: boolean;
  payoffStatus: "unknown" | "no_lien" | "has_lien";
  needsLienHolderInfo: boolean;
  providesLienHolderInfo: boolean;
  tradeTargetValue?: {
    amount: number;
    raw?: string | null;
  } | null;
  watchConfidence?: number;
  payoffConfidence?: number;
  tradeTargetConfidence?: number;
  confidence?: number;
};

export type ConversationStateParse = {
  stateIntent:
    | "finance_docs"
    | "inventory_watch"
    | "used_low_mileage_watch"
    | "service_request"
    | "parts_request"
    | "apparel_request"
    | "hiring_manager"
    | "corporate_misroute"
    | "scheduling"
    | "pricing"
    | "general"
    | "none";
  corporateTopic:
    | "other_dealer_experience"
    | "vehicle_documents_or_warranty"
    | "investor_or_corporate_culture"
    | "internship_or_careers"
    | "international_support"
    | "none";
  departmentIntent: "service" | "parts" | "apparel" | "none";
  explicitRequest: boolean;
  clearInventoryWatchPending: boolean;
  clearPricingNeedModel: boolean;
  manualHandoffReason:
    | "credit_app"
    | "used_low_mileage_watch"
    | "service_request"
    | "parts_request"
    | "apparel_request"
    | "hiring_manager_inquiry"
    | "none";
  confidence?: number;
};

function safeParseJson(text: string): any | null {
  const raw = String(text ?? "").trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {}
  const first = raw.indexOf("{");
  const last = raw.lastIndexOf("}");
  if (first >= 0 && last > first) {
    try {
      return JSON.parse(raw.slice(first, last + 1));
    } catch {}
  }
  return null;
}

function cleanOptionalString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value.trim();
  return cleaned || null;
}

function extractDayToken(text: string): string | null {
  const source = String(text ?? "");
  const match = source.match(
    /\b(today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|this week|next week|this weekend|weekend)\b/i
  );
  return match?.[0] ? match[0].toLowerCase() : null;
}

function extractTimePhrase(text: string): string | null {
  const source = String(text ?? "").trim();
  if (!source) return null;

  const exact =
    source.match(/\b(?:around|about|between|from)?\s*\d{1,2}(?::\d{2})?\s*(?:am|pm)?\s*(?:-|to|and|\/)\s*\d{1,2}(?::\d{2})?\s*(?:am|pm)?\b/i)?.[0] ??
    source.match(/\b\d{1,2}:\d{2}\s*(?:am|pm)?\b/i)?.[0] ??
    source.match(/\b\d{1,2}\s*(?:am|pm)\b/i)?.[0] ??
    null;
  if (exact) return exact;

  const relative = source.match(/\b(?:after|before|around|by)\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?\b/i)?.[0] ?? null;
  if (relative) return relative;

  const broad = source.match(/\b(morning|afternoon|evening|tonight|noon|night)\b/i)?.[0] ?? null;
  if (broad) return broad;

  return null;
}

function inferTimeWindow(value: string | null): "exact" | "range" | "unknown" {
  const v = String(value ?? "").trim().toLowerCase();
  if (!v) return "unknown";
  if (
    /\b(morning|afternoon|evening|tonight|noon|night)\b/.test(v) ||
    /\b(after|before|around|between)\b/.test(v) ||
    /\b\d{1,2}(?::\d{2})?\s*(?:am|pm)?\s*(?:-|to|and|\/)\s*\d{1,2}(?::\d{2})?\s*(?:am|pm)?\b/.test(v)
  ) {
    return "range";
  }
  if (/\b\d{1,2}:\d{2}\s*(am|pm)?\b/.test(v) || /\b\d{1,2}\s*(am|pm)\b/.test(v)) {
    return "exact";
  }
  return "unknown";
}

const BOOKING_PARSER_JSON_SCHEMA: { [key: string]: unknown } = {
  type: "object",
  additionalProperties: false,
  required: ["intent", "explicit_request", "requested", "reference", "normalized_text", "confidence"],
  properties: {
    intent: {
      type: "string",
      enum: ["schedule", "reschedule", "cancel", "availability", "question", "none"]
    },
    explicit_request: { type: "boolean" },
    requested: {
      type: "object",
      additionalProperties: false,
      required: ["day", "time_text", "time_window"],
      properties: {
        day: { type: "string" },
        time_text: { type: "string" },
        time_window: { type: "string", enum: ["exact", "range", "unknown"] }
      }
    },
    reference: { type: "string", enum: ["last_suggested", "last_appointment", "none"] },
    normalized_text: { type: "string" },
    confidence: { type: "number" }
  }
};

const APPOINTMENT_TIMING_PARSER_JSON_SCHEMA: { [key: string]: unknown } = {
  type: "object",
  additionalProperties: false,
  required: ["intent", "explicit_request", "requested", "reference", "normalized_text", "confidence"],
  properties: {
    intent: {
      type: "string",
      enum: [
        "accept_proposed_time",
        "provide_new_time",
        "tentative_time_window",
        "arrival_update",
        "ask_for_times",
        "decline_time",
        "none"
      ]
    },
    explicit_request: { type: "boolean" },
    requested: {
      type: "object",
      additionalProperties: false,
      required: ["day", "time_text", "time_window"],
      properties: {
        day: { type: "string" },
        time_text: { type: "string" },
        time_window: { type: "string", enum: ["exact", "range", "unknown"] }
      }
    },
    reference: { type: "string", enum: ["last_suggested", "last_appointment", "none"] },
    normalized_text: { type: "string" },
    confidence: { type: "number" }
  }
};

const CUSTOMER_ACK_ACTION_PARSER_JSON_SCHEMA: { [key: string]: unknown } = {
  type: "object",
  additionalProperties: false,
  required: [
    "action",
    "explicit_action",
    "should_reply",
    "should_book",
    "requested",
    "reference",
    "normalized_text",
    "confidence"
  ],
  properties: {
    action: {
      type: "string",
      enum: [
        "confirm_proposed_appointment",
        "accept_tentative_appointment",
        "ask_for_available_times",
        "customer_will_provide_time",
        "provide_arrival_window",
        "purchase_delivery_update",
        "no_response_needed",
        "neutral_ack",
        "none"
      ]
    },
    explicit_action: { type: "boolean" },
    should_reply: { type: "boolean" },
    should_book: { type: "boolean" },
    requested: {
      type: "object",
      additionalProperties: false,
      required: ["day", "time_text", "time_window"],
      properties: {
        day: { type: "string" },
        time_text: { type: "string" },
        time_window: { type: "string", enum: ["exact", "range", "unknown"] }
      }
    },
    reference: {
      type: "string",
      enum: ["last_outbound", "last_suggested", "last_appointment", "none"]
    },
    normalized_text: { type: "string" },
    confidence: { type: "number" }
  }
};

const MANUAL_OUTBOUND_APPOINTMENT_PARSER_JSON_SCHEMA: { [key: string]: unknown } = {
  type: "object",
  additionalProperties: false,
  required: ["state", "explicit_state", "requested", "reference", "normalized_text", "confidence"],
  properties: {
    state: {
      type: "string",
      enum: [
        "confirmed_booking",
        "proposed_time",
        "asks_for_time",
        "slot_offer",
        "reschedule_request",
        "none"
      ]
    },
    explicit_state: { type: "boolean" },
    requested: {
      type: "object",
      additionalProperties: false,
      required: ["day", "time_text", "time_window"],
      properties: {
        day: { type: "string" },
        time_text: { type: "string" },
        time_window: { type: "string", enum: ["exact", "range", "unknown"] }
      }
    },
    reference: { type: "string", enum: ["last_suggested", "last_appointment", "none"] },
    normalized_text: { type: "string" },
    confidence: { type: "number" }
  }
};

const WALK_IN_OUTCOME_PARSER_JSON_SCHEMA: { [key: string]: unknown } = {
  type: "object",
  additionalProperties: false,
  required: [
    "state",
    "explicit_state",
    "test_ride_requested",
    "weather_sensitive",
    "follow_up_window_text",
    "confidence"
  ],
  properties: {
    state: {
      type: "string",
      enum: [
        "none",
        "deal_finalizing",
        "deposit_left",
        "sold_delivered",
        "hold_requested",
        "hold_cleared",
        "cosigner_required",
        "test_ride_completed",
        "decision_pending",
        "outside_financing_pending",
        "down_payment_pending",
        "trade_equity_pending",
        "timing_defer_window",
        "household_approval_pending",
        "docs_or_insurance_pending"
      ]
    },
    explicit_state: { type: "boolean" },
    test_ride_requested: { type: "boolean" },
    weather_sensitive: { type: "boolean" },
    follow_up_window_text: { type: "string" },
    confidence: { type: "number" }
  }
};

const INTENT_PARSER_JSON_SCHEMA: { [key: string]: unknown } = {
  type: "object",
  additionalProperties: false,
  required: ["intent", "explicit_request", "availability", "callback", "confidence"],
  properties: {
    intent: {
      type: "string",
      enum: ["callback", "test_ride", "availability", "none"]
    },
    explicit_request: { type: "boolean" },
    availability: {
      type: "object",
      additionalProperties: false,
      required: ["model", "year", "color", "stock_id", "condition"],
      properties: {
        model: { type: "string" },
        year: { type: "string" },
        color: { type: "string" },
        stock_id: { type: "string" },
        condition: { type: "string", enum: ["new", "used", "unknown"] }
      }
    },
    callback: {
      type: "object",
      additionalProperties: false,
      required: ["requested", "time_text", "phone"],
      properties: {
        requested: { type: "boolean" },
        time_text: { type: "string" },
        phone: { type: "string" }
      }
    },
    confidence: { type: "number" }
  }
};

const DIALOG_ACT_PARSER_JSON_SCHEMA: { [key: string]: unknown } = {
  type: "object",
  additionalProperties: false,
  required: ["act", "topic", "explicit_request", "next_action", "ask_focus", "confidence"],
  properties: {
    act: {
      type: "string",
      enum: ["trust_concern", "frustration", "objection", "preference", "clarification", "none"]
    },
    topic: {
      type: "string",
      enum: ["used_inventory", "new_inventory", "pricing", "trade", "scheduling", "service", "general"]
    },
    explicit_request: { type: "boolean" },
    next_action: {
      type: "string",
      enum: ["reassure_then_clarify", "empathize_then_offer_help", "ask_one_clarifier", "normal_flow"]
    },
    ask_focus: {
      type: "string",
      enum: ["model", "budget", "timing", "condition", "other", "none"]
    },
    confidence: { type: "number" }
  }
};

const VEHICLE_INFO_REQUEST_PARSER_JSON_SCHEMA: { [key: string]: unknown } = {
  type: "object",
  additionalProperties: false,
  required: ["intent", "explicit_request", "focus", "format", "confidence"],
  properties: {
    intent: {
      type: "string",
      enum: ["specs", "compare", "none"]
    },
    explicit_request: { type: "boolean" },
    focus: {
      type: "string",
      enum: ["engine", "features", "dimensions", "accessories", "general", "unknown"]
    },
    format: {
      type: "string",
      enum: ["full", "highlights", "unknown"]
    },
    confidence: { type: "number" }
  }
};

const COMPOSITE_SALES_INQUIRY_PARSER_JSON_SCHEMA: { [key: string]: unknown } = {
  type: "object",
  additionalProperties: false,
  required: [
    "explicit_request",
    "asks_out_the_door_price",
    "asks_accessory_quote",
    "accessory_items",
    "has_fit_or_weight_concern",
    "has_financing_concern",
    "has_general_chatter",
    "confidence"
  ],
  properties: {
    explicit_request: { type: "boolean" },
    asks_out_the_door_price: { type: "boolean" },
    asks_accessory_quote: { type: "boolean" },
    accessory_items: { type: "array", items: { type: "string" } },
    has_fit_or_weight_concern: { type: "boolean" },
    has_financing_concern: { type: "boolean" },
    has_general_chatter: { type: "boolean" },
    confidence: { type: "number" }
  }
};

const CUSTOMER_DISPOSITION_PARSER_JSON_SCHEMA: { [key: string]: unknown } = {
  type: "object",
  additionalProperties: false,
  required: ["disposition", "explicit_disposition", "timeframe_text", "confidence"],
  properties: {
    disposition: {
      type: "string",
      enum: [
        "none",
        "sell_on_own",
        "keep_current_bike",
        "stepping_back",
        "defer_no_window",
        "defer_with_window"
      ]
    },
    explicit_disposition: { type: "boolean" },
    timeframe_text: { type: "string" },
    confidence: { type: "number" }
  }
};

const FIRST_TIME_RIDER_GUIDANCE_PARSER_JSON_SCHEMA: { [key: string]: unknown } = {
  type: "object",
  additionalProperties: false,
  required: [
    "intent",
    "explicit_request",
    "endorsement_status",
    "asks_test_ride",
    "asks_beginner_bike",
    "asks_rider_course",
    "confidence"
  ],
  properties: {
    intent: {
      type: "string",
      enum: [
        "first_time_rider",
        "no_motorcycle_endorsement",
        "beginner_bike_advice",
        "rider_course_info",
        "none"
      ]
    },
    explicit_request: { type: "boolean" },
    endorsement_status: { type: "string", enum: ["yes", "no", "unknown"] },
    asks_test_ride: { type: "boolean" },
    asks_beginner_bike: { type: "boolean" },
    asks_rider_course: { type: "boolean" },
    confidence: { type: "number" }
  }
};

const DEALER_TRANSACTION_POLICY_PARSER_JSON_SCHEMA: { [key: string]: unknown } = {
  type: "object",
  additionalProperties: false,
  required: [
    "intent",
    "explicit_request",
    "asks_rider_to_rider_financing",
    "asks_private_seller_facilitation",
    "asks_external_dealer_facilitation",
    "confidence"
  ],
  properties: {
    intent: {
      type: "string",
      enum: [
        "rider_to_rider_financing",
        "private_seller_facilitation",
        "external_dealer_facilitation",
        "rider_to_rider_and_third_party",
        "none"
      ]
    },
    explicit_request: { type: "boolean" },
    asks_rider_to_rider_financing: { type: "boolean" },
    asks_private_seller_facilitation: { type: "boolean" },
    asks_external_dealer_facilitation: { type: "boolean" },
    confidence: { type: "number" }
  }
};

const TRADE_PAYOFF_PARSER_JSON_SCHEMA: { [key: string]: unknown } = {
  type: "object",
  additionalProperties: false,
  required: ["payoff_status", "needs_lien_holder_info", "provides_lien_holder_info", "confidence"],
  properties: {
    payoff_status: {
      type: "string",
      enum: ["unknown", "no_lien", "has_lien"]
    },
    needs_lien_holder_info: { type: "boolean" },
    provides_lien_holder_info: { type: "boolean" },
    confidence: { type: "number" }
  }
};

const TRADE_TARGET_VALUE_PARSER_JSON_SCHEMA: { [key: string]: unknown } = {
  type: "object",
  additionalProperties: false,
  required: ["has_target_value", "amount", "raw_text", "confidence"],
  properties: {
    has_target_value: { type: "boolean" },
    amount: { type: "number" },
    raw_text: { type: "string" },
    confidence: { type: "number" }
  }
};

const RESPONSE_CONTROL_PARSER_JSON_SCHEMA: { [key: string]: unknown } = {
  type: "object",
  additionalProperties: false,
  required: ["intent", "explicit_request", "confidence"],
  properties: {
    intent: {
      type: "string",
      enum: [
        "opt_out",
        "wrong_number",
        "not_interested",
        "schedule_request",
        "compliment_only",
        "no_response",
        "none"
      ]
    },
    explicit_request: { type: "boolean" },
    confidence: { type: "number" }
  }
};

const PURCHASE_DELIVERY_LOGISTICS_PARSER_JSON_SCHEMA: { [key: string]: unknown } = {
  type: "object",
  additionalProperties: false,
  required: ["intent", "explicit_request", "timing_text", "confidence"],
  properties: {
    intent: {
      type: "string",
      enum: ["delivery_progress", "delivery_timing", "docs_status", "post_sale_item_pickup", "none"]
    },
    explicit_request: { type: "boolean" },
    timing_text: { type: "string" },
    confidence: { type: "number" }
  }
};

const SALESPERSON_MENTION_PARSER_JSON_SCHEMA: { [key: string]: unknown } = {
  type: "object",
  additionalProperties: false,
  required: ["intent", "explicit_request", "target_first_name", "confidence"],
  properties: {
    intent: {
      type: "string",
      enum: ["handoff_request", "context_reference", "none"]
    },
    explicit_request: { type: "boolean" },
    target_first_name: { type: "string" },
    confidence: { type: "number" }
  }
};

const AFFECT_PARSER_JSON_SCHEMA: { [key: string]: unknown } = {
  type: "object",
  additionalProperties: false,
  required: [
    "primary_affect",
    "explicit_affect",
    "needs_empathy",
    "has_humor",
    "has_positive_energy",
    "has_negative_sentiment",
    "tone_intensity",
    "confidence"
  ],
  properties: {
    primary_affect: {
      type: "string",
      enum: ["neutral", "frustrated", "excited", "humorous", "confused", "anxious", "angry", "urgent", "none"]
    },
    explicit_affect: { type: "boolean" },
    needs_empathy: { type: "boolean" },
    has_humor: { type: "boolean" },
    has_positive_energy: { type: "boolean" },
    has_negative_sentiment: { type: "boolean" },
    tone_intensity: { type: "number" },
    confidence: { type: "number" }
  }
};

const PRICING_PAYMENTS_INTENT_PARSER_JSON_SCHEMA: { [key: string]: unknown } = {
  type: "object",
  additionalProperties: false,
  required: [
    "intent",
    "explicit_request",
    "asks_monthly_target",
    "asks_down_payment",
    "asks_apr_or_term",
    "asks_external_approval_transfer",
    "asks_rider_to_rider_financing",
    "asks_third_party_purchase_facilitation",
    "confidence"
  ],
  properties: {
    intent: {
      type: "string",
      enum: ["pricing", "payments", "none"]
    },
    explicit_request: { type: "boolean" },
    asks_monthly_target: { type: "boolean" },
    asks_down_payment: { type: "boolean" },
    asks_apr_or_term: { type: "boolean" },
    asks_external_approval_transfer: { type: "boolean" },
    asks_rider_to_rider_financing: { type: "boolean" },
    asks_third_party_purchase_facilitation: { type: "boolean" },
    confidence: { type: "number" }
  }
};

const ROUTING_DECISION_PARSER_JSON_SCHEMA: { [key: string]: unknown } = {
  type: "object",
  additionalProperties: false,
  required: ["primary_intent", "explicit_request", "fallback_action", "clarify_prompt", "confidence"],
  properties: {
    primary_intent: {
      type: "string",
      enum: ["pricing_payments", "scheduling", "callback", "availability", "general", "none"]
    },
    explicit_request: { type: "boolean" },
    fallback_action: { type: "string", enum: ["none", "clarify", "no_response"] },
    clarify_prompt: { type: "string" },
    confidence: { type: "number" }
  }
};

const ACCESSORY_REQUEST_PARSER_JSON_SCHEMA: { [key: string]: unknown } = {
  type: "object",
  additionalProperties: false,
  required: ["action", "explicit_request", "item", "has_humor", "confidence"],
  properties: {
    action: {
      type: "string",
      enum: ["can_install", "status_check", "demo_request", "pricing_request", "none"]
    },
    explicit_request: { type: "boolean" },
    item: { type: "string" },
    has_humor: { type: "boolean" },
    confidence: { type: "number" }
  }
};

const VEHICLE_FACT_QUESTION_PARSER_JSON_SCHEMA: { [key: string]: unknown } = {
  type: "object",
  additionalProperties: false,
  required: ["question_type", "explicit_request", "requested_fields", "confidence"],
  properties: {
    question_type: {
      type: "string",
      enum: [
        "year",
        "price",
        "otd_total",
        "engine_feature",
        "mileage",
        "color",
        "service_status",
        "service_records",
        "availability",
        "hold_timing",
        "finance_program_eligibility",
        "none"
      ]
    },
    explicit_request: { type: "boolean" },
    requested_fields: { type: "array", items: { type: "string" } },
    confidence: { type: "number" }
  }
};

const DEALERSHIP_FAQ_TOPIC_PARSER_JSON_SCHEMA: { [key: string]: unknown } = {
  type: "object",
  additionalProperties: false,
  required: ["topic", "explicit_request", "confidence"],
  properties: {
    topic: {
      type: "string",
      enum: [
        "pricing_cost_range",
        "price_negotiation",
        "fees_out_the_door",
        "model_availability",
        "custom_order",
        "factory_order_timing",
        "finance_approval",
        "credit_score",
        "finance_specials",
        "no_money_down",
        "trade_in",
        "trade_tax_advantage",
        "registration_requirements",
        "street_legal",
        "inspection_requirements",
        "insurance_cost",
        "insurance_required",
        "warranty",
        "authorized_dealer_benefits",
        "test_ride",
        "test_ride_eligibility",
        "new_vs_used",
        "none"
      ]
    },
    explicit_request: { type: "boolean" },
    confidence: { type: "number" }
  }
};

const INVENTORY_ENTITY_PARSER_JSON_SCHEMA: { [key: string]: unknown } = {
  type: "object",
  additionalProperties: false,
  required: [
    "target_type",
    "is_availability_question",
    "is_test_ride_context",
    "model",
    "year",
    "year_min",
    "year_max",
    "color",
    "trim",
    "stock_id",
    "condition",
    "min_price",
    "max_price",
    "monthly_budget",
    "down_payment",
    "confidence"
  ],
  properties: {
    target_type: {
      type: "string",
      enum: [
        "stock_id",
        "vin",
        "exact_year_model",
        "model_only",
        "color_model",
        "alternate_request",
        "generic_inventory",
        "image_reference",
        "none"
      ]
    },
    is_availability_question: { type: "boolean" },
    is_test_ride_context: { type: "boolean" },
    model: { type: "string" },
    year: { type: "integer" },
    year_min: { type: "integer" },
    year_max: { type: "integer" },
    color: { type: "string" },
    trim: { type: "string" },
    stock_id: { type: "string" },
    condition: { type: "string", enum: ["new", "used", "unknown"] },
    min_price: { type: "number" },
    max_price: { type: "number" },
    monthly_budget: { type: "number" },
    down_payment: { type: "number" },
    confidence: { type: "number" }
  }
};

const INVENTORY_STATUS_PARSER_JSON_SCHEMA: { [key: string]: unknown } = {
  type: "object",
  additionalProperties: false,
  required: [
    "intent",
    "explicit_request",
    "model",
    "year",
    "year_min",
    "year_max",
    "color",
    "trim",
    "stock_id",
    "condition",
    "confidence"
  ],
  properties: {
    intent: {
      type: "string",
      enum: [
        "availability_check",
        "hold_status_question",
        "incoming_status_question",
        "factory_order_eta",
        "unlisted_inventory_followup",
        "alternate_inventory_request",
        "image_availability_check",
        "none"
      ]
    },
    explicit_request: { type: "boolean" },
    model: { type: "string" },
    year: { type: "integer" },
    year_min: { type: "integer" },
    year_max: { type: "integer" },
    color: { type: "string" },
    trim: { type: "string" },
    stock_id: { type: "string" },
    condition: { type: "string", enum: ["new", "used", "unknown"] },
    confidence: { type: "number" }
  }
};

const JOURNEY_INTENT_PARSER_JSON_SCHEMA: { [key: string]: unknown } = {
  type: "object",
  additionalProperties: false,
  required: ["journey_intent", "explicit_request", "confidence"],
  properties: {
    journey_intent: {
      type: "string",
      enum: ["sale_trade", "service_support", "marketing_event", "none"]
    },
    explicit_request: { type: "boolean" },
    confidence: { type: "number" }
  }
};

const STAFF_OUTCOME_UPDATE_PARSER_JSON_SCHEMA: { [key: string]: unknown } = {
  type: "object",
  additionalProperties: false,
  required: [
    "outcome",
    "explicit_outcome",
    "follow_up_window_text",
    "unit_stock_id",
    "unit_vin",
    "unit_on_order",
    "unit_year",
    "unit_make",
    "unit_model",
    "unit_trim",
    "confidence"
  ],
  properties: {
    outcome: {
      type: "string",
      enum: ["showed_up", "no_show", "sold", "hold", "follow_up", "lost", "other", "none"]
    },
    explicit_outcome: { type: "boolean" },
    follow_up_window_text: { type: "string" },
    unit_stock_id: { type: "string" },
    unit_vin: { type: "string" },
    unit_on_order: { type: "boolean" },
    unit_year: { type: "integer", minimum: 0, maximum: 3000 },
    unit_make: { type: "string" },
    unit_model: { type: "string" },
    unit_trim: { type: "string" },
    confidence: { type: "number", minimum: 0, maximum: 1 }
  }
};

const APPOINTMENT_OUTCOME_FOLLOW_UP_PLAN_JSON_SCHEMA: { [key: string]: unknown } = {
  type: "object",
  additionalProperties: false,
  required: [
    "follow_up_needed",
    "customer_status",
    "primary_concern",
    "recommended_action",
    "target_vehicle_model",
    "target_vehicle_year",
    "target_vehicle_condition",
    "original_vehicle_model",
    "follow_up_window_text",
    "follow_up_date_text",
    "message_angle",
    "urgency",
    "draft_sms",
    "reasoning",
    "confidence"
  ],
  properties: {
    follow_up_needed: { type: "boolean" },
    customer_status: {
      type: "string",
      enum: [
        "interested",
        "uncertain",
        "not_ready",
        "needs_more_info",
        "comparing_options",
        "finance_pending",
        "lost",
        "unknown"
      ]
    },
    primary_concern: {
      type: "string",
      enum: [
        "bike_fit",
        "comfort_confidence",
        "price_payment",
        "trade",
        "financing",
        "timing",
        "availability",
        "needs_spouse_or_friend",
        "none",
        "unknown"
      ]
    },
    recommended_action: {
      type: "string",
      enum: [
        "invite_back",
        "offer_alternative_ride",
        "send_numbers",
        "send_photos_or_video",
        "call_customer",
        "check_inventory",
        "manager_follow_up",
        "finance_follow_up",
        "soft_check_in",
        "no_follow_up"
      ]
    },
    target_vehicle_model: { type: "string" },
    target_vehicle_year: { type: "string" },
    target_vehicle_condition: { type: "string", enum: ["new", "used", "any", "unknown"] },
    original_vehicle_model: { type: "string" },
    follow_up_window_text: { type: "string" },
    follow_up_date_text: { type: "string" },
    message_angle: {
      type: "string",
      enum: [
        "compare_alternative",
        "confidence_reassurance",
        "numbers_next_step",
        "inventory_options",
        "appointment_invite",
        "soft_check_in",
        "no_message"
      ]
    },
    urgency: { type: "string", enum: ["now", "today", "tomorrow", "this_week", "next_week", "later", "unknown"] },
    draft_sms: { type: "string" },
    reasoning: { type: "string" },
    confidence: { type: "number", minimum: 0, maximum: 1 }
  }
};

const FINANCE_OUTCOME_FROM_CALL_JSON_SCHEMA: { [key: string]: unknown } = {
  type: "object",
  additionalProperties: false,
  required: ["outcome", "explicit_outcome", "confidence", "reason_text"],
  properties: {
    outcome: { type: "string", enum: ["approved", "declined", "needs_more_info", "none"] },
    explicit_outcome: { type: "boolean" },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    reason_text: { type: "string" }
  }
};

const SEMANTIC_SLOT_PARSER_JSON_SCHEMA: { [key: string]: unknown } = {
  type: "object",
  additionalProperties: false,
  required: [
    "watch_action",
    "watch",
    "department_intent",
    "contact_preference_intent",
    "media_intent",
    "service_records_intent",
    "confidence"
  ],
  properties: {
    watch_action: {
      type: "string",
      enum: ["set_watch", "stop_watch", "none"]
    },
    watch: {
      type: "object",
      additionalProperties: false,
      required: [
        "model",
        "year",
        "year_min",
        "year_max",
        "color",
        "condition",
        "min_price",
        "max_price",
        "monthly_budget",
        "down_payment"
      ],
      properties: {
        model: { type: "string" },
        year: { type: "string" },
        year_min: { type: "integer" },
        year_max: { type: "integer" },
        color: { type: "string" },
        condition: { type: "string", enum: ["new", "used", "any", "unknown"] },
        min_price: { type: "number" },
        max_price: { type: "number" },
        monthly_budget: { type: "number" },
        down_payment: { type: "number" }
      }
    },
    department_intent: {
      type: "string",
      enum: ["service", "parts", "apparel", "none"]
    },
    contact_preference_intent: {
      type: "string",
      enum: ["call_only", "none"]
    },
    media_intent: {
      type: "string",
      enum: ["video", "photos", "either", "none"]
    },
    service_records_intent: {
      type: "boolean"
    },
    confidence: { type: "number" }
  }
};

const CONVERSATION_STATE_PARSER_JSON_SCHEMA: { [key: string]: unknown } = {
  type: "object",
  additionalProperties: false,
  required: [
    "state_intent",
    "corporate_topic",
    "department_intent",
    "explicit_request",
    "clear_inventory_watch_pending",
    "clear_pricing_need_model",
    "manual_handoff_reason",
    "confidence"
  ],
  properties: {
    state_intent: {
      type: "string",
      enum: [
        "finance_docs",
        "inventory_watch",
        "used_low_mileage_watch",
        "service_request",
        "parts_request",
        "apparel_request",
        "hiring_manager",
        "corporate_misroute",
        "scheduling",
        "pricing",
        "general",
        "none"
      ]
    },
    corporate_topic: {
      type: "string",
      enum: [
        "other_dealer_experience",
        "vehicle_documents_or_warranty",
        "investor_or_corporate_culture",
        "internship_or_careers",
        "international_support",
        "none"
      ]
    },
    department_intent: {
      type: "string",
      enum: ["service", "parts", "apparel", "none"]
    },
    explicit_request: { type: "boolean" },
    clear_inventory_watch_pending: { type: "boolean" },
    clear_pricing_need_model: { type: "boolean" },
    manual_handoff_reason: {
      type: "string",
      enum: [
        "credit_app",
        "used_low_mileage_watch",
        "service_request",
        "parts_request",
        "apparel_request",
        "hiring_manager_inquiry",
        "none"
      ]
    },
    confidence: { type: "number", minimum: 0, maximum: 1 }
  }
};

async function requestStructuredJson(args: {
  model: string;
  prompt: string;
  schemaName: string;
  schema: { [key: string]: unknown };
  maxOutputTokens?: number;
  debugTag?: string;
  debug?: boolean;
}): Promise<any | null> {
  const parseObject = (raw: string): any | null => {
    const trimmed = raw.trim();
    const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)?.[1]?.trim();
    const parsed = safeParseJson(fenced ?? trimmed);
    return parsed && typeof parsed === "object" ? parsed : null;
  };

  try {
    const resp = await client.responses.parse({
      model: args.model,
      input: args.prompt,
      ...optionalReasoning(args.model),
      max_output_tokens: args.maxOutputTokens ?? 220,
      text: {
        format: {
          type: "json_schema",
          name: args.schemaName,
          schema: args.schema,
          strict: true
        }
      }
    });
    recordOpenAIUsage(resp, {
      feature: "llm_parser",
      operation: args.schemaName,
      requestKind: "responses.parse",
      model: args.model,
      metadata: { debugTag: args.debugTag ?? null }
    });
    const parsedFromApi = (resp as any)?.output_parsed;
    if (parsedFromApi && typeof parsedFromApi === "object") {
      return parsedFromApi;
    }
    const raw = resp.output_text?.trim() ?? "";
    const parsed = parseObject(raw);
    if (parsed) return parsed;
    if (args.debug) {
      console.warn(`[${args.debugTag ?? "llm-json-parser"}] structured parse failed`, {
        model: args.model,
        raw,
        hasOutputParsed: !!parsedFromApi
      });
    }
  } catch (error) {
    if (args.debug) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[${args.debugTag ?? "llm-json-parser"}] structured request failed`, {
        model: args.model,
        error: message
      });
    }
  }

  // Compatibility fallback for models/configs that reject strict structured outputs.
  try {
    const resp = await client.responses.create({
      model: args.model,
      input: args.prompt,
      ...optionalCreateTextConfig(args.model),
      max_output_tokens: args.maxOutputTokens ?? 220
    });
    recordOpenAIUsage(resp, {
      feature: "llm_parser",
      operation: `${args.schemaName}_fallback`,
      requestKind: "responses.create",
      model: args.model,
      metadata: { debugTag: args.debugTag ?? null }
    });
    const raw = resp.output_text?.trim() ?? "";
    const parsed = parseObject(raw);
    if (parsed) return parsed;
    if (args.debug) {
      console.warn(`[${args.debugTag ?? "llm-json-parser"}] fallback parse failed`, {
        model: args.model,
        raw
      });
    }
  } catch (error) {
    if (args.debug) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[${args.debugTag ?? "llm-json-parser"}] fallback request failed`, {
        model: args.model,
        error: message
      });
    }
  }

  return null;
}

export async function parseBookingIntentWithLLM(args: {
  text: string;
  history?: { direction: "in" | "out"; body: string }[];
  lastSuggestedSlots?: { startLocal?: string | null }[];
  appointment?: any;
}): Promise<BookingParse | null> {
  const isScheduleDeferralWithoutAsk = (input: string): boolean => {
    const t = String(input ?? "").toLowerCase().trim();
    if (!t) return false;
    const firstPersonDeferral =
      /\b(i(?:'|’)?ll|i\s+will|we(?:'|’)?ll|we\s+will)\s+(?:let\s+you\s+know|get\s+back\s+to\s+you|reach\s+out|text\s+you|call\s+you)\b/.test(
        t
      ) ||
      (/\blet\s+you\s+know\b/.test(t) &&
        /\b(later|later today|later tonight|tomorrow|next week|when i know|when i can|once i know|once i can)\b/.test(
          t
        ));
    const explicitScheduleAsk =
      /\b(can\s+we|could\s+we|what\s+time|what\s+day|does\s+\w+\s+work|works?\s+for\s+you|schedule|book|appointment|available|openings?|come\s+in|stop\s+in)\b/.test(
        t
      ) ||
      /\b(can|could)\s+\w+\s+work\b/.test(t) ||
      /\?\s*$/.test(t);
    return firstPersonDeferral && !explicitScheduleAsk;
  };
  const isHealthUpdateWithoutScheduleAsk = (input: string): boolean => {
    const t = String(input ?? "").toLowerCase().trim();
    if (!t) return false;
    const healthContext =
      /\b(hip replaced|knee replaced|replacement surgery|surgery|surgical|hospital|recovering|recovery|doctor|medical)\b/.test(
        t
      );
    if (!healthContext) return false;
    const explicitScheduleAsk =
      /\b(can i|can we|could i|could we|schedule|book|appointment|appt|what time|what day|available|openings?|does .* work|works? for you)\b/.test(
        t
      ) || /\?\s*$/.test(t);
    return !explicitScheduleAsk;
  };

  const useLLM =
    process.env.LLM_ENABLED === "1" &&
    process.env.LLM_BOOKING_PARSER_ENABLED === "1" &&
    !!process.env.OPENAI_API_KEY;
  if (!useLLM) return null;

  const debug = process.env.LLM_BOOKING_PARSER_DEBUG === "1";
  const primaryModel =
    process.env.OPENAI_BOOKING_PARSER_MODEL || process.env.OPENAI_MODEL || "gpt-5-mini";
  const fallbackModel =
    process.env.OPENAI_BOOKING_PARSER_MODEL_FALLBACK ||
    (primaryModel === "gpt-5-mini" ? "gpt-4o-mini" : "");
  const text = String(args.text ?? "").trim();
  if (!text) return null;

  const history = (args.history ?? []).slice(-6).map(h => `${h.direction}: ${h.body}`);
  const lastSlots = (args.lastSuggestedSlots ?? [])
    .map(s => s.startLocal)
    .filter(Boolean)
    .slice(0, 2)
    .join(" | ");
  const apptStatus = args.appointment?.status ?? "none";
  const voiceExamples = [
    'input: "Customer: can we do Tuesday around 4?" output: {"intent":"schedule","explicit_request":true,"requested":{"day":"tuesday","time_text":"around 4","time_window":"range"},"reference":"none","normalized_text":"tuesday around 4","confidence":0.96}',
    'input: "Customer: i can come in next week sometime afternoon" output: {"intent":"schedule","explicit_request":true,"requested":{"day":"next week","time_text":"afternoon","time_window":"range"},"reference":"none","normalized_text":"next week afternoon","confidence":0.92}',
    'input: "Customer: i work m-f 7/4... does sat morning work 4 u" output: {"intent":"schedule","explicit_request":true,"requested":{"day":"saturday","time_text":"morning","time_window":"range"},"reference":"none","normalized_text":"saturday morning","confidence":0.95}',
    'input: "Customer: how about a tri glide instead. can it be saturday morning?" output: {"intent":"schedule","explicit_request":true,"requested":{"day":"saturday","time_text":"morning","time_window":"range"},"reference":"none","normalized_text":"saturday morning","confidence":0.96}',
    'input: "Customer: how about a triglycerides instead. it has to be on a saturday." output: {"intent":"schedule","explicit_request":true,"requested":{"day":"saturday","time_text":"","time_window":"unknown"},"reference":"none","normalized_text":"saturday","confidence":0.92}',
    'input: "Customer: can i come in saturday at 9:30?" output: {"intent":"schedule","explicit_request":true,"requested":{"day":"saturday","time_text":"9:30","time_window":"exact"},"reference":"none","normalized_text":"saturday 9:30","confidence":0.97}',
    'input: "Customer: Either the 9th after 1:30 or any time on the 16th" output: {"intent":"availability","explicit_request":true,"requested":{"day":"9th","time_text":"after 1:30","time_window":"range"},"reference":"none","normalized_text":"9th after 1:30 or 16th any time","confidence":0.95}',
    'input: "Customer: tomorrow around 11/12 would work best for me" output: {"intent":"schedule","explicit_request":true,"requested":{"day":"tomorrow","time_text":"around 11/12","time_window":"range"},"reference":"last_suggested","normalized_text":"tomorrow around 11/12","confidence":0.95}',
    'input: "Customer: yes saturday at 930 works" output: {"intent":"schedule","explicit_request":true,"requested":{"day":"saturday","time_text":"9:30","time_window":"exact"},"reference":"last_suggested","normalized_text":"saturday 9:30","confidence":0.96}',
    'input: "Customer: saturday works for me" output: {"intent":"schedule","explicit_request":true,"requested":{"day":"saturday","time_text":"","time_window":"unknown"},"reference":"last_suggested","normalized_text":"saturday","confidence":0.93}',
    'input: "Customer: 11am can you send photos of street glide limited" output: {"intent":"none","explicit_request":false,"requested":{"day":"","time_text":"","time_window":"unknown"},"reference":"none","normalized_text":"","confidence":0.96}',
    'input: "Customer: never mind photo. test ride street glide limited 3. thanks" output: {"intent":"none","explicit_request":false,"requested":{"day":"","time_text":"","time_window":"unknown"},"reference":"none","normalized_text":"","confidence":0.95}',
    'input: "Customer: 9ish works" output: {"intent":"schedule","explicit_request":true,"requested":{"day":"","time_text":"9ish","time_window":"range"},"reference":"last_suggested","normalized_text":"9ish","confidence":0.9}',
    'input: "Customer: after 4 is best" output: {"intent":"schedule","explicit_request":true,"requested":{"day":"","time_text":"after 4","time_window":"range"},"reference":"last_suggested","normalized_text":"after 4","confidence":0.91}',
    'input: "Customer: Thanks for info. And any appointments later this month same time." output: {"intent":"availability","explicit_request":true,"requested":{"day":"later this month","time_text":"same time","time_window":"range"},"reference":"last_suggested","normalized_text":"later this month same time","confidence":0.92}',
    'input: "Customer: can we move that to saturday morning?" output: {"intent":"reschedule","explicit_request":true,"requested":{"day":"saturday","time_text":"morning","time_window":"range"},"reference":"last_appointment","normalized_text":"saturday morning","confidence":0.94}',
    'input: "Customer: I will have to reschedule unfortunately" output: {"intent":"reschedule","explicit_request":true,"requested":{"day":"","time_text":"","time_window":"unknown"},"reference":"last_appointment","normalized_text":"","confidence":0.94}',
    'input: "Customer: I couldn’t make it yesterday. How does half an hour sound? I can get there before the weather gets bad." output: {"intent":"schedule","explicit_request":true,"requested":{"day":"","time_text":"in half an hour","time_window":"range"},"reference":"none","normalized_text":"in half an hour","confidence":0.93}',
    'input: "Customer: wrong place actually. Supposed to be Cartersville, Georgia" output: {"intent":"cancel","explicit_request":true,"requested":{"day":"","time_text":"","time_window":"unknown"},"reference":"last_appointment","normalized_text":"wrong location","confidence":0.95}',
    'input: "Customer: that appointment is for the wrong dealership" output: {"intent":"cancel","explicit_request":true,"requested":{"day":"","time_text":"","time_window":"unknown"},"reference":"last_appointment","normalized_text":"wrong dealership","confidence":0.95}',
    'input: "Customer: hey! Could we do 9:30-10" output: {"intent":"reschedule","explicit_request":true,"requested":{"day":"","time_text":"9:30-10","time_window":"range"},"reference":"last_appointment","normalized_text":"9:30-10","confidence":0.94}',
    'input: "Customer: can you move me later than that time?" output: {"intent":"reschedule","explicit_request":true,"requested":{"day":"","time_text":"later","time_window":"range"},"reference":"last_suggested","normalized_text":"later than last suggested","confidence":0.9}',
    'input: "Customer: what openings do you have friday?" output: {"intent":"availability","explicit_request":true,"requested":{"day":"friday","time_text":"","time_window":"unknown"},"reference":"none","normalized_text":"friday","confidence":0.95}',
    'input: "Customer: Ooh that looks sharp! Friday morning, early afternoon, or anytime Saturday I can come out and take a look" output: {"intent":"schedule","explicit_request":true,"requested":{"day":"friday","time_text":"morning","time_window":"range"},"reference":"none","normalized_text":"friday morning or saturday any time","confidence":0.94}',
    'input: "Customer: i will let you know a time later today" output: {"intent":"none","explicit_request":false,"requested":{"day":"","time_text":"","time_window":"unknown"},"reference":"none","normalized_text":"","confidence":0.95}',
    'input: "Customer: I just filled out the paperwork to get the free hat. Talked to Scott the other day, told him I would probably come in shortly with a couple friends they can ride, but I can’t. I had my hip replaced last Thursday." output: {"intent":"none","explicit_request":false,"requested":{"day":"","time_text":"","time_window":"unknown"},"reference":"none","normalized_text":"","confidence":0.96}',
    'input: "Customer: payments are too high right now" output: {"intent":"none","explicit_request":false,"requested":{"day":"","time_text":"","time_window":"unknown"},"reference":"none","normalized_text":"","confidence":0.93}'
  ];

  const prompt = [
    "You are a scheduling parser for dealership SMS.",
    "Return only JSON that matches the provided schema.",
    "Do not invent dates.",
    "",
    "Guidelines:",
    "- explicit_request is true only if the customer is asking to schedule/stop in/reschedule/cancel.",
    "- If an appointment exists and the customer says it is the wrong place, wrong dealer, wrong dealership, wrong store, or meant for another location, classify as cancel with reference last_appointment.",
    "- If the customer gives a day without a time, set requested.day and set time_text to an empty string.",
    "- If the customer gives multiple acceptable windows, use the first acceptable window in requested and keep the other option in normalized_text.",
    "- Ordinal dates like 'the 9th' or '16th' are real date requests; keep requested.day as '9th' / '16th'.",
    "- If the customer references a prior offer (e.g., 'that time', 'earlier', 'later'), set reference to last_suggested.",
    "- normalized_text should be a compact day/time phrase when possible; otherwise empty string.",
    "- Use empty strings for unknown requested.day and requested.time_text.",
    "- confidence is a number from 0 to 1.",
    "",
    `Appointment status: ${apptStatus}`,
    history.length ? `Recent messages:\n${history.join("\n")}` : "Recent messages: (none)",
    lastSlots ? `Last suggested slots: ${lastSlots}` : "Last suggested slots: (none)",
    "Voice-style examples:",
    ...voiceExamples,
    `Message: ${text}`
  ].join("\n");

  const runParse = async (model: string): Promise<any | null> => {
    return requestStructuredJson({
      model,
      prompt,
      schemaName: "booking_intent_parser",
      schema: BOOKING_PARSER_JSON_SCHEMA,
      maxOutputTokens: 220,
      debugTag: "llm-booking-parser",
      debug
    });
  };

  const parsedPrimary = await runParse(primaryModel);
  const parsed =
    parsedPrimary ??
    (fallbackModel && fallbackModel !== primaryModel ? await runParse(fallbackModel) : null);
  if (!parsed) return null;

  const intentRaw = String(parsed.intent ?? "").toLowerCase();
  let intent: BookingParse["intent"] =
    intentRaw === "schedule" ||
    intentRaw === "reschedule" ||
    intentRaw === "cancel" ||
    intentRaw === "availability" ||
    intentRaw === "question"
      ? intentRaw
      : "none";
  const messageText = String(args.text ?? "");
  const messageLower = messageText.toLowerCase();
  const hasExistingAppointment =
    String(args.appointment?.status ?? "none").toLowerCase() !== "none";
  const explicitRescheduleCue =
    /\b(reschedule|re-?schedule|move (?:my appointment|it|me|that)|change (?:my appointment|the appointment|the time|it|that)|push (?:my appointment|it|that)|different time|another time)\b/i.test(
      messageText
    );
  const existingAppointmentAdjustmentCue =
    hasExistingAppointment &&
    /\b(?:can|could|would)\s+we\s+do\b/i.test(messageText) &&
    /\b\d{1,2}(?::\d{2})?\s*(?:am|pm)?\s*(?:-|to|and|\/)\s*\d{1,2}(?::\d{2})?\s*(?:am|pm)?\b/i.test(messageText);
  if (intent === "schedule" && existingAppointmentAdjustmentCue) {
    intent = "reschedule";
  }
  if (intent === "reschedule" && !hasExistingAppointment && !explicitRescheduleCue) {
    intent = "schedule";
  }
  if (
    intent === "question" &&
    /\b(price|pricing|otd|out[-\s]?the[-\s]?door|payment|payments|monthly|apr|finance|financing)\b/i.test(
      messageText
    )
  ) {
    intent = "none";
  }

  let explicitRequest = !!parsed.explicit_request;
  if (
    !explicitRequest &&
    (intent === "schedule" || intent === "reschedule" || intent === "cancel" || intent === "availability")
  ) {
    const hasRequestCue =
      /\b(schedule|book|appointment|appt|reschedule|cancel|availability|available|openings?|what times|any time|move my appointment|are you open)\b/i.test(
        messageText
      ) || /\?$/.test(messageText.trim());
    if (hasRequestCue) explicitRequest = true;
  }

  const requested = parsed.requested && typeof parsed.requested === "object" ? parsed.requested : null;
  let day = cleanOptionalString(requested?.day);
  let timeText = cleanOptionalString(requested?.time_text);
  const timeWindowRaw = typeof requested?.time_window === "string" ? requested.time_window : "unknown";
  let timeWindow: "exact" | "range" | "unknown" =
    timeWindowRaw === "exact" || timeWindowRaw === "range" ? timeWindowRaw : "unknown";
  const referenceRaw = typeof parsed.reference === "string" ? parsed.reference : "none";
  let reference: BookingParse["reference"] =
    referenceRaw === "last_suggested" || referenceRaw === "last_appointment" ? referenceRaw : "none";
  const normalizedTextRaw = cleanOptionalString(parsed.normalized_text) ?? "";
  let normalizedText = normalizedTextRaw;
  if (!normalizedText && day) {
    normalizedText = timeText ? `${day} at ${timeText}` : day;
  }

  if (!day) {
    day = extractDayToken(normalizedText || messageText);
  }
  if (!timeText) {
    timeText = extractTimePhrase(normalizedText || messageText);
  }
  if (timeWindow === "unknown") {
    const inferred = inferTimeWindow(timeText);
    if (inferred !== "unknown") {
      timeWindow = inferred;
    } else if (/\b(any time|openings?|available|availability)\b/i.test(messageLower)) {
      timeWindow = "range";
    }
  }
  if (
    reference === "none" &&
    intent === "reschedule" &&
    hasExistingAppointment
  ) {
    reference = "last_appointment";
  }
  if (
    reference === "none" &&
    (args.lastSuggestedSlots?.length ?? 0) > 0 &&
    /\b(that|this|earlier|later|same time|that time|that one)\b/i.test(messageLower)
  ) {
    reference = "last_suggested";
  }

  const confidence =
    typeof parsed.confidence === "number" && Number.isFinite(parsed.confidence)
      ? Math.max(0, Math.min(1, parsed.confidence))
      : undefined;

  // Guardrail: first-person deferrals ("I'll let you know later today") are not schedule asks.
  if (isScheduleDeferralWithoutAsk(messageText)) {
    intent = "none";
    explicitRequest = false;
    day = null;
    timeText = null;
    timeWindow = "unknown";
    reference = "none";
    normalizedText = "";
  }
  if (isHealthUpdateWithoutScheduleAsk(messageText)) {
    intent = "none";
    explicitRequest = false;
    day = null;
    timeText = null;
    timeWindow = "unknown";
    reference = "none";
    normalizedText = "";
  }

  return {
    intent,
    explicitRequest,
    requested: { day, timeText, timeWindow },
    reference,
    normalizedText: normalizedText || null,
    confidence
  };
}

export async function parseAppointmentTimingWithLLM(args: {
  text: string;
  history?: { direction: "in" | "out"; body: string }[];
  lastSuggestedSlots?: { startLocal?: string | null }[];
  appointment?: any;
}): Promise<AppointmentTimingParse | null> {
  const useLLM =
    process.env.LLM_ENABLED === "1" &&
    process.env.LLM_APPOINTMENT_TIMING_PARSER_ENABLED !== "0" &&
    !!process.env.OPENAI_API_KEY;
  if (!useLLM) return null;

  const debug = process.env.LLM_APPOINTMENT_TIMING_PARSER_DEBUG === "1";
  const primaryModel =
    process.env.OPENAI_APPOINTMENT_TIMING_PARSER_MODEL ||
    process.env.OPENAI_BOOKING_PARSER_MODEL ||
    process.env.OPENAI_MODEL ||
    "gpt-5-mini";
  const fallbackModel =
    process.env.OPENAI_APPOINTMENT_TIMING_PARSER_MODEL_FALLBACK ||
    process.env.OPENAI_BOOKING_PARSER_MODEL_FALLBACK ||
    (primaryModel === "gpt-5-mini" ? "gpt-4o-mini" : "");
  const text = String(args.text ?? "").trim();
  if (!text) return null;

  const history = (args.history ?? []).slice(-8).map(h => `${h.direction}: ${h.body}`);
  const lastSlots = (args.lastSuggestedSlots ?? [])
    .map(s => s.startLocal)
    .filter(Boolean)
    .slice(0, 4)
    .join(" | ");
  const apptStatus = args.appointment?.status ?? "none";

  const examples = [
    'input: "Customer: tomorrow around 11/12 would work best for me" output: {"intent":"provide_new_time","explicit_request":true,"requested":{"day":"tomorrow","time_text":"around 11/12","time_window":"range"},"reference":"last_suggested","normalized_text":"tomorrow around 11/12","confidence":0.96}',
    'input: "Customer: alright, sounds good man. thank you." history: "out: I will schedule you in between 11-12 tomorrow" output: {"intent":"accept_proposed_time","explicit_request":true,"requested":{"day":"tomorrow","time_text":"11-12","time_window":"range"},"reference":"last_suggested","normalized_text":"tomorrow 11-12","confidence":0.91}',
    'input: "Customer: Ok." history: "out: Tuesday between 9:30 and 10:00 can work." output: {"intent":"accept_proposed_time","explicit_request":true,"requested":{"day":"tuesday","time_text":"9:30-10:00","time_window":"range"},"reference":"last_suggested","normalized_text":"tuesday 9:30-10:00","confidence":0.88}',
    'input: "Customer: On my way doing my best to be there by 530" output: {"intent":"arrival_update","explicit_request":true,"requested":{"day":"","time_text":"by 5:30","time_window":"range"},"reference":"none","normalized_text":"on my way by 5:30","confidence":0.96}',
    'input: "Customer: Early afternoon ish, wife just has to be home to get kids off the bus" output: {"intent":"tentative_time_window","explicit_request":true,"requested":{"day":"","time_text":"early afternoon-ish","time_window":"range"},"reference":"last_suggested","normalized_text":"early afternoon-ish","confidence":0.93}',
    'input: "Customer: Cool. Ill try to stop by the 15th or 16th. Never know because of my work schedule. Thanks" output: {"intent":"tentative_time_window","explicit_request":true,"requested":{"day":"15th or 16th","time_text":"","time_window":"range"},"reference":"none","normalized_text":"15th or 16th","confidence":0.94}',
    'input: "Customer: Good morning saturday would work best. let me know what time works for you." output: {"intent":"ask_for_times","explicit_request":true,"requested":{"day":"saturday","time_text":"","time_window":"unknown"},"reference":"none","normalized_text":"saturday","confidence":0.95}',
    'input: "Customer: Thanks for info. And any appointments later this month same time." output: {"intent":"ask_for_times","explicit_request":true,"requested":{"day":"later this month","time_text":"same time","time_window":"range"},"reference":"last_suggested","normalized_text":"later this month same time","confidence":0.94}',
    'input: "Customer: Friday morning, early afternoon, or anytime Saturday I can come out and take a look" output: {"intent":"provide_new_time","explicit_request":true,"requested":{"day":"friday","time_text":"morning or early afternoon","time_window":"range"},"reference":"none","normalized_text":"friday morning or early afternoon, or saturday any time","confidence":0.94}',
    'input: "Customer: I can’t do that time" output: {"intent":"decline_time","explicit_request":true,"requested":{"day":"","time_text":"","time_window":"unknown"},"reference":"last_suggested","normalized_text":"","confidence":0.9}',
    'input: "Customer: It is raining" history: "out: You’re scheduled for today at 2:00 PM." output: {"intent":"decline_time","explicit_request":true,"requested":{"day":"","time_text":"","time_window":"unknown"},"reference":"last_appointment","normalized_text":"weather issue for appointment","confidence":0.9}',
    'input: "Customer: I couldn’t make it yesterday. How does half an hour sound? I can get there before the weather gets bad." output: {"intent":"provide_new_time","explicit_request":true,"requested":{"day":"","time_text":"in half an hour","time_window":"range"},"reference":"last_appointment","normalized_text":"in half an hour","confidence":0.93}',
    'input: "Customer: Let me know because I start driving on Friday morning" output: {"intent":"arrival_update","explicit_request":true,"requested":{"day":"friday","time_text":"morning","time_window":"range"},"reference":"none","normalized_text":"driving friday morning","confidence":0.93}',
    'input: "Customer: Can you send pictures?" output: {"intent":"none","explicit_request":false,"requested":{"day":"","time_text":"","time_window":"unknown"},"reference":"none","normalized_text":"","confidence":0.95}'
  ];

  const prompt = [
    "You parse dealership appointment timing turns.",
    "Return only JSON matching the schema.",
    "",
    "Intent mapping:",
    "- accept_proposed_time: customer accepts a previously proposed exact or windowed time.",
    "- provide_new_time: customer gives a day/time or usable appointment window.",
    "- tentative_time_window: customer gives a loose arrival window but indicates uncertainty; do not treat as a confirmed booking.",
    "- A soft visit plan like 'I'll try to stop by the 15th or 16th' with work/schedule uncertainty is tentative_time_window.",
    "- arrival_update: customer says they are on the way, leaving, driving in, or already headed to the dealership.",
    "- ask_for_times: customer asks the dealership what times are available or says a day works and asks what time works.",
    "- decline_time: customer rejects a proposed time.",
    "- none: no appointment timing state.",
    "",
    "Rules:",
    "- Do not classify product years or model numbers as appointment times.",
    "- Arrival updates are not schedule requests and should not produce new slot offers.",
    "- If customer says 'around 11/12', keep that full range as time_text.",
    "- If customer says 'later this month same time', preserve later_this_month/same time context.",
    "- Use empty strings for unknown requested.day and requested.time_text.",
    "- confidence is 0 to 1.",
    "",
    `Appointment status: ${apptStatus}`,
    history.length ? `Recent messages:\n${history.join("\n")}` : "Recent messages: (none)",
    lastSlots ? `Last suggested slots: ${lastSlots}` : "Last suggested slots: (none)",
    "Examples:",
    ...examples,
    `Message: ${text}`
  ].join("\n");

  const runParse = async (model: string): Promise<any | null> =>
    requestStructuredJson({
      model,
      prompt,
      schemaName: "appointment_timing_parser",
      schema: APPOINTMENT_TIMING_PARSER_JSON_SCHEMA,
      maxOutputTokens: 220,
      debugTag: "llm-appointment-timing-parser",
      debug
    });

  const parsedPrimary = await runParse(primaryModel);
  const parsed =
    parsedPrimary ??
    (fallbackModel && fallbackModel !== primaryModel ? await runParse(fallbackModel) : null);
  if (!parsed) return null;

  const rawIntent = String(parsed.intent ?? "").toLowerCase();
  const intent: AppointmentTimingParse["intent"] =
    rawIntent === "accept_proposed_time" ||
    rawIntent === "provide_new_time" ||
    rawIntent === "tentative_time_window" ||
    rawIntent === "arrival_update" ||
    rawIntent === "ask_for_times" ||
    rawIntent === "decline_time"
      ? rawIntent
      : "none";

  const requested = parsed.requested && typeof parsed.requested === "object" ? parsed.requested : {};
  const day = cleanOptionalString(requested?.day);
  const timeText = cleanOptionalString(requested?.time_text);
  const timeWindowRaw = String(requested?.time_window ?? "unknown").toLowerCase();
  const timeWindow: "exact" | "range" | "unknown" =
    timeWindowRaw === "exact" || timeWindowRaw === "range" ? timeWindowRaw : "unknown";
  const referenceRaw = String(parsed.reference ?? "none").toLowerCase();
  const reference: AppointmentTimingParse["reference"] =
    referenceRaw === "last_suggested" || referenceRaw === "last_appointment" ? referenceRaw : "none";
  const confidence =
    typeof parsed.confidence === "number" && Number.isFinite(parsed.confidence)
      ? Math.max(0, Math.min(1, parsed.confidence))
      : undefined;

  return {
    intent,
    explicitRequest: !!parsed.explicit_request,
    requested: { day, timeText, timeWindow },
    reference,
    normalizedText: cleanOptionalString(parsed.normalized_text) ?? null,
    confidence
  };
}

export async function parseCustomerAckActionWithLLM(args: {
  text: string;
  history?: { direction: "in" | "out"; body: string }[];
  lastSuggestedSlots?: { startLocal?: string | null }[];
  appointment?: any;
  lead?: Conversation["lead"];
}): Promise<CustomerAckActionParse | null> {
  const useLLM =
    process.env.LLM_ENABLED === "1" &&
    process.env.LLM_CUSTOMER_ACK_ACTION_PARSER_ENABLED !== "0" &&
    !!process.env.OPENAI_API_KEY;
  if (!useLLM) return null;

  const debug = process.env.LLM_CUSTOMER_ACK_ACTION_PARSER_DEBUG === "1";
  const primaryModel =
    process.env.OPENAI_CUSTOMER_ACK_ACTION_PARSER_MODEL ||
    process.env.OPENAI_APPOINTMENT_TIMING_PARSER_MODEL ||
    process.env.OPENAI_MODEL ||
    "gpt-5-mini";
  const fallbackModel =
    process.env.OPENAI_CUSTOMER_ACK_ACTION_PARSER_MODEL_FALLBACK ||
    process.env.OPENAI_APPOINTMENT_TIMING_PARSER_MODEL_FALLBACK ||
    (primaryModel === "gpt-5-mini" ? "gpt-4o-mini" : "");
  const text = String(args.text ?? "").trim();
  if (!text) return null;

  const history = (args.history ?? []).slice(-10).map(h => `${h.direction}: ${h.body}`);
  const lastSlots = (args.lastSuggestedSlots ?? [])
    .map(s => s.startLocal)
    .filter(Boolean)
    .slice(0, 4)
    .join(" | ");
  const lead = args.lead ?? {};

  const examples = [
    'input: "Customer: Sounds perfect" history: "out: I have Sat, May 9, 2:00 PM does that work?" output: {"action":"confirm_proposed_appointment","explicit_action":true,"should_reply":true,"should_book":true,"requested":{"day":"sat may 9","time_text":"2:00 PM","time_window":"exact"},"reference":"last_outbound","normalized_text":"sat may 9 2:00 PM","confidence":0.96}',
    'input: "Customer: alright, sounds good man. thank you." history: "out: Hey Rafael, sorry, that would work ill schedule you in between 11-12 tomorrow" output: {"action":"confirm_proposed_appointment","explicit_action":true,"should_reply":false,"should_book":true,"requested":{"day":"tomorrow","time_text":"11-12","time_window":"range"},"reference":"last_outbound","normalized_text":"tomorrow 11-12","confidence":0.94}',
    'input: "Customer: Ok." history: "out: Tuesday between 9:30 and 10:00 can work." output: {"action":"accept_tentative_appointment","explicit_action":true,"should_reply":true,"should_book":false,"requested":{"day":"tuesday","time_text":"9:30-10:00","time_window":"range"},"reference":"last_outbound","normalized_text":"tuesday 9:30-10:00","confidence":0.92}',
    'input: "Customer: Good morning saturday would work best. let me know what time works for you." output: {"action":"ask_for_available_times","explicit_action":true,"should_reply":true,"should_book":false,"requested":{"day":"saturday","time_text":"","time_window":"unknown"},"reference":"none","normalized_text":"saturday","confidence":0.95}',
    'input: "Customer: tomorrow around 11/12 would work best for me" output: {"action":"ask_for_available_times","explicit_action":true,"should_reply":true,"should_book":false,"requested":{"day":"tomorrow","time_text":"around 11/12","time_window":"range"},"reference":"none","normalized_text":"tomorrow around 11/12","confidence":0.94}',
    'input: "Customer: Thursday looks like the next nice day, let me find a ride and I’ll give you a time frame" history: "out: What day/time works for you to come in and pick it up?" output: {"action":"customer_will_provide_time","explicit_action":true,"should_reply":false,"should_book":false,"requested":{"day":"thursday","time_text":"","time_window":"unknown"},"reference":"none","normalized_text":"thursday, customer will give time frame","confidence":0.96}',
    'input: "Customer: Let me do some figuring out and will let you know soon" history: "out: What day/time works for you to come in and pick it up?" output: {"action":"customer_will_provide_time","explicit_action":true,"should_reply":false,"should_book":false,"requested":{"day":"","time_text":"","time_window":"unknown"},"reference":"none","normalized_text":"customer will let us know soon","confidence":0.95}',
    'input: "Customer: 1-2 o’clock ish" history: "out: What time works for you today?" output: {"action":"purchase_delivery_update","explicit_action":true,"should_reply":true,"should_book":false,"requested":{"day":"","time_text":"1-2 o’clock-ish","time_window":"range"},"reference":"last_outbound","normalized_text":"1-2 o’clock-ish","confidence":0.93}',
    'input: "Customer: be there at nine am" history: "out: ok I am around tomorrow or Friday just give me a heads up" output: {"action":"purchase_delivery_update","explicit_action":true,"should_reply":true,"should_book":false,"requested":{"day":"","time_text":"9:00 AM","time_window":"exact"},"reference":"last_outbound","normalized_text":"be there at 9:00 AM","confidence":0.96}',
    'input: "Customer: On my way doing my best to be there by 530" output: {"action":"provide_arrival_window","explicit_action":true,"should_reply":true,"should_book":false,"requested":{"day":"","time_text":"by 5:30","time_window":"range"},"reference":"none","normalized_text":"on my way by 5:30","confidence":0.95}',
    'input: "Customer: Talk soon!" history: "out: You’re welcome — happy to help, talk soon!" output: {"action":"no_response_needed","explicit_action":false,"should_reply":false,"should_book":false,"requested":{"day":"","time_text":"","time_window":"unknown"},"reference":"none","normalized_text":"","confidence":0.97}',
    'input: "Customer: Cool" history: "out: Sounds good — thanks for the update." output: {"action":"no_response_needed","explicit_action":false,"should_reply":false,"should_book":false,"requested":{"day":"","time_text":"","time_window":"unknown"},"reference":"none","normalized_text":"","confidence":0.96}',
    'input: "Customer: Ok great!" history: "out: I’ll keep you posted." output: {"action":"no_response_needed","explicit_action":false,"should_reply":false,"should_book":false,"requested":{"day":"","time_text":"","time_window":"unknown"},"reference":"none","normalized_text":"","confidence":0.96}',
    'input: "Customer: Perfect." history: "out: Awesome, glad that works for you!" output: {"action":"no_response_needed","explicit_action":false,"should_reply":false,"should_book":false,"requested":{"day":"","time_text":"","time_window":"unknown"},"reference":"none","normalized_text":"","confidence":0.95}',
    'input: "Customer: Ok 👍" history: "out: Sounds good. Thanks for letting me know." output: {"action":"no_response_needed","explicit_action":false,"should_reply":false,"should_book":false,"requested":{"day":"","time_text":"","time_window":"unknown"},"reference":"none","normalized_text":"","confidence":0.96}',
    'input: "Customer: Thanks, can you send photos?" output: {"action":"none","explicit_action":true,"should_reply":true,"should_book":false,"requested":{"day":"","time_text":"","time_window":"unknown"},"reference":"none","normalized_text":"","confidence":0.9}'
  ];

  const prompt = [
    "You parse a customer acknowledgement/action turn in a dealership text conversation.",
    "Return only JSON matching the schema.",
    "",
    "Action mapping:",
    "- confirm_proposed_appointment: customer accepts a specific slot/time that the dealer already offered or said they would schedule.",
    "- accept_tentative_appointment: customer acknowledges a loose 'can work / should work / if that works' proposal, but the dealer still needs permission to lock it in.",
    "- ask_for_available_times: customer asks the dealer what time works or gives a day/window and wants available options.",
    "- customer_will_provide_time: customer says they need to figure out timing, find a ride, or will let the dealer know a timeframe later. Do not ask for the time again.",
    "- provide_arrival_window: customer says they are on the way, leaving, driving, or gives a casual ETA.",
    "- purchase_delivery_update: customer gives arrival/pickup timing in an active purchase/delivery/docs context; do not treat as a trade appraisal or new appointment slot offer.",
    "- no_response_needed: short acknowledgement/signoff with no question, no requested action, and no appointment confirmation.",
    "- neutral_ack: acknowledgement that may deserve a brief response but does not book or change state.",
    "- none: a substantive request that should be routed elsewhere.",
    "",
    "Rules:",
    "- Use recent outbound context. The same 'Ok' can mean no response, appointment confirmation, or tentative acceptance.",
    "- should_book=true only when the customer confirms a concrete slot/time already offered or staff explicitly said they will schedule it.",
    "- If the last dealer message only says 'can work' or 'if that works', set accept_tentative_appointment and should_book=false.",
    "- If the customer asks what time works, do not ask them for a time again; set ask_for_available_times.",
    "- If the customer says they will give/send/provide/let you know the time later, set customer_will_provide_time and should_reply=false.",
    "- If the customer is buying/picking up/taking delivery and gives '1-2ish', classify purchase_delivery_update, not trade appraisal scheduling.",
    "- If the customer says they will be there at a concrete time after a pickup/paperwork/delivery coordination message, classify purchase_delivery_update and acknowledge the arrival time.",
    "- Do not classify document/media proof acknowledgements as photo requests just because the word 'like' appears.",
    "- confidence is 0 to 1.",
    "",
    `Known lead info: ${JSON.stringify({
      model: lead?.vehicle?.model ?? lead?.vehicle?.description ?? null,
      year: lead?.vehicle?.year ?? null,
      stockId: lead?.vehicle?.stockId ?? null
    })}`,
    `Appointment status: ${args.appointment?.status ?? "none"}`,
    lastSlots ? `Last suggested slots: ${lastSlots}` : "Last suggested slots: (none)",
    history.length ? `Recent messages:\n${history.join("\n")}` : "Recent messages: (none)",
    "Examples:",
    ...examples,
    `Message: ${text}`
  ].join("\n");

  const runParse = async (model: string): Promise<any | null> =>
    requestStructuredJson({
      model,
      prompt,
      schemaName: "customer_ack_action_parser",
      schema: CUSTOMER_ACK_ACTION_PARSER_JSON_SCHEMA,
      maxOutputTokens: 240,
      debugTag: "llm-customer-ack-action-parser",
      debug
    });

  const parsedPrimary = await runParse(primaryModel);
  const parsed =
    parsedPrimary ??
    (fallbackModel && fallbackModel !== primaryModel ? await runParse(fallbackModel) : null);
  if (!parsed) return null;

  const rawAction = String(parsed.action ?? "").toLowerCase();
  const action: CustomerAckActionParse["action"] =
    rawAction === "confirm_proposed_appointment" ||
    rawAction === "accept_tentative_appointment" ||
    rawAction === "ask_for_available_times" ||
    rawAction === "customer_will_provide_time" ||
    rawAction === "provide_arrival_window" ||
    rawAction === "purchase_delivery_update" ||
    rawAction === "no_response_needed" ||
    rawAction === "neutral_ack"
      ? rawAction
      : "none";
  const requested = parsed.requested && typeof parsed.requested === "object" ? parsed.requested : {};
  const day = cleanOptionalString(requested?.day);
  const timeText = cleanOptionalString(requested?.time_text);
  const timeWindowRaw = String(requested?.time_window ?? "unknown").toLowerCase();
  const timeWindow: "exact" | "range" | "unknown" =
    timeWindowRaw === "exact" || timeWindowRaw === "range" ? timeWindowRaw : "unknown";
  const referenceRaw = String(parsed.reference ?? "none").toLowerCase();
  const reference: CustomerAckActionParse["reference"] =
    referenceRaw === "last_outbound" ||
    referenceRaw === "last_suggested" ||
    referenceRaw === "last_appointment"
      ? referenceRaw
      : "none";
  const confidence =
    typeof parsed.confidence === "number" && Number.isFinite(parsed.confidence)
      ? Math.max(0, Math.min(1, parsed.confidence))
      : undefined;

  return {
    action,
    explicitAction: !!parsed.explicit_action,
    shouldReply: !!parsed.should_reply,
    shouldBook: !!parsed.should_book,
    requested: { day, timeText, timeWindow },
    reference,
    normalizedText: cleanOptionalString(parsed.normalized_text) ?? null,
    confidence
  };
}

export async function parseManualOutboundAppointmentWithLLM(args: {
  text: string;
  history?: { direction: "in" | "out"; body: string }[];
  lastSuggestedSlots?: { startLocal?: string | null }[];
  appointment?: any;
}): Promise<ManualOutboundAppointmentParse | null> {
  const useLLM =
    process.env.LLM_ENABLED === "1" &&
    process.env.LLM_MANUAL_OUTBOUND_APPOINTMENT_PARSER_ENABLED !== "0" &&
    !!process.env.OPENAI_API_KEY;
  if (!useLLM) return null;

  const debug = process.env.LLM_MANUAL_OUTBOUND_APPOINTMENT_PARSER_DEBUG === "1";
  const primaryModel =
    process.env.OPENAI_MANUAL_OUTBOUND_APPOINTMENT_PARSER_MODEL ||
    process.env.OPENAI_APPOINTMENT_TIMING_PARSER_MODEL ||
    process.env.OPENAI_BOOKING_PARSER_MODEL ||
    process.env.OPENAI_MODEL ||
    "gpt-5-mini";
  const fallbackModel =
    process.env.OPENAI_MANUAL_OUTBOUND_APPOINTMENT_PARSER_MODEL_FALLBACK ||
    process.env.OPENAI_APPOINTMENT_TIMING_PARSER_MODEL_FALLBACK ||
    process.env.OPENAI_BOOKING_PARSER_MODEL_FALLBACK ||
    (primaryModel === "gpt-5-mini" ? "gpt-4o-mini" : "");
  const text = String(args.text ?? "").trim();
  if (!text) return null;

  const history = (args.history ?? []).slice(-8).map(h => `${h.direction}: ${h.body}`);
  const lastSlots = (args.lastSuggestedSlots ?? [])
    .map(s => s.startLocal)
    .filter(Boolean)
    .slice(0, 4)
    .join(" | ");
  const apptStatus = args.appointment?.status ?? "none";

  const examples = [
    'input: "Staff: I will schedule an inspection for the 12th at noon for you" output: {"state":"confirmed_booking","explicit_state":true,"requested":{"day":"12th","time_text":"noon","time_window":"exact"},"reference":"none","normalized_text":"12th at noon","confidence":0.96}',
    'input: "Staff: Hey Rafael, sorry, that would work ill schedule you in between 11-12 tomorrow" output: {"state":"confirmed_booking","explicit_state":true,"requested":{"day":"tomorrow","time_text":"between 11-12","time_window":"range"},"reference":"none","normalized_text":"tomorrow between 11-12","confidence":0.96}',
    'input: "Staff: I will have you meet with Giovanni tomorrow around 4:30-5:00" output: {"state":"confirmed_booking","explicit_state":true,"requested":{"day":"tomorrow","time_text":"around 4:30-5:00","time_window":"range"},"reference":"none","normalized_text":"tomorrow around 4:30-5:00","confidence":0.96}',
    'input: "Staff: Hey Jen, lets shoot for 9:30 if that works" output: {"state":"proposed_time","explicit_state":true,"requested":{"day":"","time_text":"9:30","time_window":"exact"},"reference":"none","normalized_text":"9:30 if that works","confidence":0.96}',
    'input: "Staff: I’ll schedule you in at 9:30 if that works" output: {"state":"proposed_time","explicit_state":true,"requested":{"day":"","time_text":"9:30","time_window":"exact"},"reference":"none","normalized_text":"9:30 if that works","confidence":0.95}',
    'input: "Staff: I have Thu, May 7, 9:30 AM or Thu, May 7, 11:30 AM — do either work?" output: {"state":"slot_offer","explicit_state":true,"requested":{"day":"Thu, May 7","time_text":"9:30 AM or 11:30 AM","time_window":"range"},"reference":"none","normalized_text":"Thu, May 7 9:30 AM or 11:30 AM","confidence":0.96}',
    'input: "Staff: What time tomorrow are you thinking?" output: {"state":"asks_for_time","explicit_state":true,"requested":{"day":"tomorrow","time_text":"","time_window":"unknown"},"reference":"none","normalized_text":"tomorrow","confidence":0.95}',
    'input: "Staff: We can reschedule that for next week" output: {"state":"reschedule_request","explicit_state":true,"requested":{"day":"next week","time_text":"","time_window":"unknown"},"reference":"last_appointment","normalized_text":"next week","confidence":0.92}',
    'input: "Staff: That works!" output: {"state":"none","explicit_state":false,"requested":{"day":"","time_text":"","time_window":"unknown"},"reference":"none","normalized_text":"","confidence":0.93}',
    'input: "Staff: Can you call me?" output: {"state":"none","explicit_state":false,"requested":{"day":"","time_text":"","time_window":"unknown"},"reference":"none","normalized_text":"","confidence":0.95}'
  ];

  const prompt = [
    "You parse dealership staff-authored outbound appointment state.",
    "Return only JSON matching the schema.",
    "",
    "State mapping:",
    "- confirmed_booking: staff clearly says the customer is scheduled, booked, set, or will be scheduled for a concrete day/time.",
    "- proposed_time: staff proposes a time but needs customer confirmation, especially phrases like 'if that works', 'would that work', 'let's shoot for'.",
    "- asks_for_time: staff asks the customer what day/time works.",
    "- slot_offer: staff offers one or more appointment slots and asks the customer to choose/confirm.",
    "- reschedule_request: staff asks to change/move an already booked appointment.",
    "- none: no appointment state should be changed.",
    "",
    "Rules:",
    "- Do not mark proposed_time as confirmed_booking.",
    "- 'if that works' means proposed_time unless the staff also says the customer already confirmed.",
    "- 'That works' alone is not a booking confirmation because it lacks the appointment details.",
    "- Keep time ranges like 11-12 or 4:30-5:00 as ranges.",
    "- Do not classify phone calls, inventory, parts, service, or pricing replies as appointment state.",
    "- Use empty strings for unknown requested.day and requested.time_text.",
    "- confidence is 0 to 1.",
    "",
    `Appointment status: ${apptStatus}`,
    history.length ? `Recent messages:\n${history.join("\n")}` : "Recent messages: (none)",
    lastSlots ? `Last suggested slots: ${lastSlots}` : "Last suggested slots: (none)",
    "Examples:",
    ...examples,
    `Message: ${text}`
  ].join("\n");

  const runParse = async (model: string): Promise<any | null> =>
    requestStructuredJson({
      model,
      prompt,
      schemaName: "manual_outbound_appointment_parser",
      schema: MANUAL_OUTBOUND_APPOINTMENT_PARSER_JSON_SCHEMA,
      maxOutputTokens: 220,
      debugTag: "llm-manual-outbound-appointment-parser",
      debug
    });

  const parsedPrimary = await runParse(primaryModel);
  const parsed =
    parsedPrimary ??
    (fallbackModel && fallbackModel !== primaryModel ? await runParse(fallbackModel) : null);
  if (!parsed) return null;

  const rawState = String(parsed.state ?? "").toLowerCase();
  const state: ManualOutboundAppointmentParse["state"] =
    rawState === "confirmed_booking" ||
    rawState === "proposed_time" ||
    rawState === "asks_for_time" ||
    rawState === "slot_offer" ||
    rawState === "reschedule_request"
      ? rawState
      : "none";
  const requested = parsed.requested && typeof parsed.requested === "object" ? parsed.requested : {};
  const day = cleanOptionalString(requested?.day);
  const timeText = cleanOptionalString(requested?.time_text);
  const timeWindowRaw = String(requested?.time_window ?? "unknown").toLowerCase();
  const timeWindow: "exact" | "range" | "unknown" =
    timeWindowRaw === "exact" || timeWindowRaw === "range" ? timeWindowRaw : "unknown";
  const referenceRaw = String(parsed.reference ?? "none").toLowerCase();
  const reference: ManualOutboundAppointmentParse["reference"] =
    referenceRaw === "last_suggested" || referenceRaw === "last_appointment" ? referenceRaw : "none";
  const confidence =
    typeof parsed.confidence === "number" && Number.isFinite(parsed.confidence)
      ? Math.max(0, Math.min(1, parsed.confidence))
      : undefined;

  return {
    state,
    explicitState: !!parsed.explicit_state,
    requested: { day, timeText, timeWindow },
    reference,
    normalizedText: cleanOptionalString(parsed.normalized_text) ?? null,
    confidence
  };
}

export async function parseIntentWithLLM(args: {
  text: string;
  history?: { direction: "in" | "out"; body: string }[];
  lead?: Conversation["lead"];
}): Promise<IntentParse | null> {
  const useLLM =
    process.env.LLM_ENABLED === "1" &&
    process.env.LLM_INTENT_PARSER_ENABLED === "1" &&
    !!process.env.OPENAI_API_KEY;
  if (!useLLM) return null;

  const debug = process.env.LLM_INTENT_PARSER_DEBUG === "1";
  const primaryModel = process.env.OPENAI_INTENT_PARSER_MODEL || process.env.OPENAI_MODEL || "gpt-5-mini";
  const fallbackModel =
    process.env.OPENAI_INTENT_PARSER_MODEL_FALLBACK ||
    (primaryModel === "gpt-5-mini" ? "gpt-4o-mini" : "");
  const text = String(args.text ?? "").trim();
  if (!text) return null;

  const history = (args.history ?? []).slice(-6).map(h => `${h.direction}: ${h.body}`);
  const lead = args.lead ?? {};
  const noCallPreference = /\b(?:prefer|rather|only)\s+(?:text|sms|message)|\b(?:please\s+)?(?:do\s+not|don'?t)\s+call\b|\bno\s+calls?\b/i.test(
    text
  );
  const inferBikeFromText = (value: string): { model: string; year: string } | null => {
    const lower = String(value ?? "").toLowerCase();
    const year = lower.match(/\b(20\d{2})\b/)?.[1] ?? "";
    const modelPatterns: Array<[RegExp, string]> = [
      [/\bstreet\s+glide\s+3\s+limited\b|\bstreet\s+glide\s+limited\s+iii\b/i, "Street Glide 3 Limited"],
      [/\btri\s+glides?\b|\btri\s*glyc(?:eride|erides|erid(?:es)?)\b|\bflhtcutg\b/i, "Tri Glide"],
      [/\bcvo\s+road\s+glide\s+st\b/i, "CVO Road Glide ST"],
      [/\bcvo\s+street\s+glide\b/i, "CVO Street Glide"],
      [/\bstreet\s+glide\s+limited\b/i, "Street Glide Limited"],
      [/\broad\s+glide\s+limited\b/i, "Road Glide Limited"],
      [/\bstreet\s+glides?\b/i, "Street Glide"],
      [/\broad\s+glides?\b/i, "Road Glide"],
      [/\blow\s+rider\s+s\b|\blrs\b|\bfxlrs\b/i, "Low Rider S"],
      [/\blow\s+rider\s+st\b/i, "Low Rider ST"],
      [/\biron\s+883s?\b|\bsportster\s+iron\s+883\b/i, "Iron 883"],
      [/\bsportsters?\b/i, "Sportster"],
      [/\bnightsters?\b/i, "Nightster"],
      [/\bbreakouts?\b/i, "Breakout"],
      [/\bfat\s+boy\b/i, "Fat Boy"],
      [/\bheritage\s+classic\b/i, "Heritage Classic"],
      [/\bpan\s+america\b/i, "Pan America"],
      [/\btrikes?\b|\btri\s+glides?\b/i, "Tri Glide"]
    ];
    const hit = modelPatterns.find(([pattern]) => pattern.test(lower));
    if (!hit) return null;
    return { model: hit[1], year };
  };
  const voiceExamples = [
    'input: "Customer: can you call me after 4?" output: {"intent":"callback","explicit_request":true,"availability":{"model":"","year":"","color":"","stock_id":"","condition":"unknown"},"callback":{"requested":true,"time_text":"after 4","phone":""},"confidence":0.97}',
    'input: "Customer: if you call me around 1-2pm i should be up. i work night shift." output: {"intent":"callback","explicit_request":true,"availability":{"model":"","year":"","color":"","stock_id":"","condition":"unknown"},"callback":{"requested":true,"time_text":"around 1-2pm","phone":""},"confidence":0.98}',
    'input: "Customer: Hi Joe, I’m available to chat right now if that works for you." output: {"intent":"callback","explicit_request":true,"availability":{"model":"","year":"","color":"","stock_id":"","condition":"unknown"},"callback":{"requested":true,"time_text":"right now","phone":""},"confidence":0.94}',
    'input: "Customer: I prefer text, please don’t call." output: {"intent":"none","explicit_request":false,"availability":{"model":"","year":"","color":"","stock_id":"","condition":"unknown"},"callback":{"requested":false,"time_text":"","phone":""},"confidence":0.98}',
    'input: "Customer: do you have any black street glides in stock?" output: {"intent":"availability","explicit_request":true,"availability":{"model":"Street Glide","year":"","color":"black","stock_id":"","condition":"unknown"},"callback":{"requested":false,"time_text":"","phone":""},"confidence":0.97}',
    'input: "Customer: can i test ride one this week?" output: {"intent":"test_ride","explicit_request":true,"availability":{"model":"","year":"","color":"","stock_id":"","condition":"unknown"},"callback":{"requested":false,"time_text":"","phone":""},"confidence":0.95}',
    'input: "Customer: I begin my riding academy next Monday and was told you do the jumpstart experience prior." output: {"intent":"none","explicit_request":false,"availability":{"model":"","year":"","color":"","stock_id":"","condition":"unknown"},"callback":{"requested":false,"time_text":"","phone":""},"confidence":0.95}',
    'input: "Customer: how about a triglycerides instead. it would have to be on a saturday." output: {"intent":"none","explicit_request":false,"availability":{"model":"Tri Glide","year":"","color":"","stock_id":"","condition":"unknown"},"callback":{"requested":false,"time_text":"","phone":""},"confidence":0.94}',
    'input: "Customer: saturday works for me on a tri glide. does the morning work?" output: {"intent":"none","explicit_request":false,"availability":{"model":"Tri Glide","year":"","color":"","stock_id":"","condition":"unknown"},"callback":{"requested":false,"time_text":"","phone":""},"confidence":0.95}',
    'input: "Customer: Road King, any Street Glide, OR Large CC Pan American, would be great." history: "in: I want to test ride something similar." output: {"intent":"test_ride","explicit_request":true,"availability":{"model":"Street Glide","year":"","color":"","stock_id":"","condition":"unknown"},"callback":{"requested":false,"time_text":"","phone":""},"confidence":0.94}',
    'input: "Customer: 11am can you send photos of street glide limited" output: {"intent":"none","explicit_request":false,"availability":{"model":"Street Glide Limited","year":"","color":"","stock_id":"","condition":"unknown"},"callback":{"requested":false,"time_text":"","phone":""},"confidence":0.95}',
    'input: "Customer: do you have brake pads in stock for a 2018 street glide?" output: {"intent":"none","explicit_request":false,"availability":{"model":"","year":"","color":"","stock_id":"","condition":"unknown"},"callback":{"requested":false,"time_text":"","phone":""},"confidence":0.96}',
    'input: "Customer: is the orange hoodie in stock in xl?" output: {"intent":"none","explicit_request":false,"availability":{"model":"","year":"","color":"","stock_id":"","condition":"unknown"},"callback":{"requested":false,"time_text":"","phone":""},"confidence":0.96}',
    'input: "Customer: never mind photo. test ride street glide limited 3. thanks" output: {"intent":"test_ride","explicit_request":true,"availability":{"model":"Street Glide 3 Limited","year":"","color":"","stock_id":"","condition":"unknown"},"callback":{"requested":false,"time_text":"","phone":""},"confidence":0.96}',
    'input: "Customer: I guess maybe the 2025 breakouts? Not too picky about the color for a test ride" output: {"intent":"test_ride","explicit_request":true,"availability":{"model":"Breakout","year":"2025","color":"","stock_id":"","condition":"unknown"},"callback":{"requested":false,"time_text":"","phone":""},"confidence":0.96}',
    'input: "Customer: Or maybe that 2022 iron 883 for the test ride" output: {"intent":"test_ride","explicit_request":true,"availability":{"model":"Iron 883","year":"2022","color":"","stock_id":"","condition":"unknown"},"callback":{"requested":false,"time_text":"","phone":""},"confidence":0.95}',
    'input: "Customer: i can come in tuesday at 3:45" output: {"intent":"none","explicit_request":false,"availability":{"model":"","year":"","color":"","stock_id":"","condition":"unknown"},"callback":{"requested":false,"time_text":"","phone":""},"confidence":0.94}',
    'input: "Customer: im trying to stay under 500 a month" output: {"intent":"none","explicit_request":false,"availability":{"model":"","year":"","color":"","stock_id":"","condition":"unknown"},"callback":{"requested":false,"time_text":"","phone":""},"confidence":0.94}'
  ];

  const prompt = [
    "You are a parser for dealership SMS.",
    "Return only JSON that matches the provided schema.",
    "Do not invent details.",
    "",
    "Guidelines:",
    "- explicit_request is true only if the customer is asking for a call back, test ride, or availability.",
    "- intent=availability only for inventory availability (bike in stock/still there/sold?).",
    "- Parts, apparel, service, accessories, gear, clothing, helmets, hoodies, gloves, brake pads, tires, inspections, maintenance, and repair questions are not motorcycle inventory availability; set intent=none.",
    "- intent=test_ride if they ask to test ride or demo the bike.",
    "- If recent messages are about a test ride and the current customer message is only a bike/model alternate (for example \"or maybe that 2022 Iron 883\"), keep intent=test_ride and explicit_request=true.",
    "- jump start / jumpstart / riding-academy prep messages are not inventory availability requests; do not set intent=test_ride for those.",
    "- intent=callback if they ask for a call, ask you to call them, or say they are available/free to chat/talk right now.",
    "- If the customer says they prefer text, says text only, or says do not call/don't call/no calls, intent=none and explicit_request=false. Do not classify that as callback.",
    "- If message is about appointment/schedule availability (day/time/openings), intent=none and explicit_request=false.",
    "- If no clear request, intent=none and explicit_request=false.",
    "- Use empty strings for unknown availability fields (model/year/color/stock_id).",
    "- Street Glide 3 Limited is a 2026+ model. Do not return Street Glide 3 Limited with a 2025-or-earlier year.",
    "- Use callback.requested=false and empty strings for callback.time_text/callback.phone when unknown.",
    "- confidence is a number from 0 to 1.",
    "",
    `Known lead info: ${JSON.stringify({
      model: lead?.vehicle?.model ?? lead?.vehicle?.description ?? null,
      year: lead?.vehicle?.year ?? null,
      color: lead?.vehicle?.color ?? null,
      stockId: lead?.vehicle?.stockId ?? null
    })}`,
    history.length ? `Recent messages:\n${history.join("\n")}` : "Recent messages: (none)",
    "Voice-style examples:",
    ...voiceExamples,
    `Message: ${text}`
  ].join("\n");

  const runParse = async (model: string): Promise<any | null> => {
    return requestStructuredJson({
      model,
      prompt,
      schemaName: "intent_parser",
      schema: INTENT_PARSER_JSON_SCHEMA,
      maxOutputTokens: 220,
      debugTag: "llm-intent-parser",
      debug
    });
  };

  const parsedPrimary = await runParse(primaryModel);
  const parsed =
    parsedPrimary ??
    (fallbackModel && fallbackModel !== primaryModel ? await runParse(fallbackModel) : null);
  if (!parsed) return null;

  const intentRaw = String(parsed.intent ?? "").toLowerCase();
  const intent: IntentParse["intent"] =
    intentRaw === "callback" || intentRaw === "test_ride" || intentRaw === "availability"
      ? intentRaw
      : "none";
  const explicitRequest = !!parsed.explicit_request;

  const availabilityRaw = parsed.availability && typeof parsed.availability === "object"
    ? parsed.availability
    : null;
  const availability = availabilityRaw
    ? (() => {
        const year = cleanOptionalString(availabilityRaw.year);
        const rawModel = cleanOptionalString(availabilityRaw.model);
        const yearNum = Number(year);
        const model =
          Number.isFinite(yearNum) && yearNum < 2026 && /^street glide 3 limited$/i.test(rawModel ?? "")
            ? "Street Glide"
            : rawModel;
        return {
          model,
          year,
          color: cleanOptionalString(availabilityRaw.color),
          stockId: cleanOptionalString(availabilityRaw.stock_id),
          condition:
            availabilityRaw.condition === "new" || availabilityRaw.condition === "used"
              ? availabilityRaw.condition
              : "unknown"
        };
      })()
    : undefined;

  const callbackRaw = parsed.callback && typeof parsed.callback === "object" ? parsed.callback : null;
  const callback = callbackRaw
    ? {
        requested: typeof callbackRaw.requested === "boolean" ? callbackRaw.requested : undefined,
        timeText: cleanOptionalString(callbackRaw.time_text),
        phone: cleanOptionalString(callbackRaw.phone)
      }
    : undefined;

  const confidence =
    typeof parsed.confidence === "number" && Number.isFinite(parsed.confidence)
      ? Math.max(0, Math.min(1, parsed.confidence))
      : undefined;

  if (noCallPreference) {
    return {
      intent: "none",
      explicitRequest: false,
      availability,
      callback: {
        requested: false,
        timeText: undefined,
        phone: undefined
      },
      confidence: Math.max(confidence ?? 0, 0.98)
    };
  }

  const inferredBike = inferBikeFromText(text);
  const inferredBikeYearNum = Number(inferredBike?.year ?? "");
  const inferredBikeModel =
    inferredBike &&
    Number.isFinite(inferredBikeYearNum) &&
    inferredBikeYearNum < 2026 &&
    /^street glide 3 limited$/i.test(inferredBike.model)
      ? "Street Glide"
      : inferredBike?.model;
  const recentTestRideContext = /\b(test ride|demo ride|line up (?:the )?(?:test )?ride|set up (?:a )?(?:test )?ride)\b/i.test(
    history.join("\n")
  );
  if (
    intent === "none" &&
    !explicitRequest &&
    recentTestRideContext &&
    inferredBike &&
    !/\b(price|pricing|payment|payments|monthly|finance|financing|available|availability|in stock|photos?|pictures?|specs?)\b/i.test(
      text
    )
  ) {
    return {
      intent: "test_ride",
      explicitRequest: true,
      availability: {
        model: inferredBikeModel,
        year: inferredBike.year || undefined,
        color: availability?.color,
        stockId: availability?.stockId,
        condition: availability?.condition ?? "unknown"
      },
      callback,
      confidence: Math.max(confidence ?? 0, 0.95)
    };
  }

  return {
    intent,
    explicitRequest,
    availability,
    callback,
    confidence
  };
}

export async function parseDialogActWithLLM(args: {
  text: string;
  history?: { direction: "in" | "out"; body: string }[];
  lead?: Conversation["lead"];
}): Promise<DialogActParse | null> {
  const useLLM =
    process.env.LLM_ENABLED === "1" &&
    process.env.LLM_DIALOG_ACT_PARSER_ENABLED === "1" &&
    !!process.env.OPENAI_API_KEY;
  if (!useLLM) return null;

  const debug = process.env.LLM_DIALOG_ACT_PARSER_DEBUG === "1";
  const primaryModel = process.env.OPENAI_DIALOG_ACT_PARSER_MODEL || process.env.OPENAI_MODEL || "gpt-5-mini";
  const fallbackModel =
    process.env.OPENAI_DIALOG_ACT_PARSER_MODEL_FALLBACK ||
    (primaryModel === "gpt-5-mini" ? "gpt-4o-mini" : "");
  const text = String(args.text ?? "").trim();
  if (!text) return null;

  const history = (args.history ?? []).slice(-4).map(h => `${h.direction}: ${h.body}`);
  const lead = args.lead ?? {};
  const prompt = [
    "You are a dialog-act classifier for dealership inbound messages.",
    "Return only JSON that matches the provided schema.",
    "",
    "Guidelines:",
    "- explicit_request=true only when the customer directly asks for an action or asks a question needing a concrete answer.",
    "- trust_concern covers safety/credibility concerns (e.g., private-party is sketchy, wants dealer peace of mind).",
    "- frustration covers disappointment or annoyance without a direct ask.",
    "- objection covers pushback/resistance (price pressure, skepticism, refusal) without a direct ask.",
    "- preference covers non-question preferences (used vs new, color/style, financing preference).",
    "- clarification covers uncertain/ambiguous statements asking for understanding but not a concrete inventory/pricing/scheduling ask.",
    "- If message contains a direct inventory/pricing/scheduling/trade/service request, set explicit_request=true and next_action=normal_flow.",
    "- ask_focus should point to the single best follow-up clarifier for no-request statements.",
    "- confidence is a number from 0 to 1.",
    "",
    `Known lead info: ${JSON.stringify({
      model: lead?.vehicle?.model ?? lead?.vehicle?.description ?? null,
      year: lead?.vehicle?.year ?? null,
      condition: lead?.vehicle?.condition ?? null
    })}`,
    history.length ? `Recent messages:\n${history.join("\n")}` : "Recent messages: (none)",
    `Message: ${text}`
  ].join("\n");

  const runParse = async (model: string): Promise<any | null> => {
    return requestStructuredJson({
      model,
      prompt,
      schemaName: "dialog_act_parser",
      schema: DIALOG_ACT_PARSER_JSON_SCHEMA,
      maxOutputTokens: 180,
      debugTag: "llm-dialog-act-parser",
      debug
    });
  };

  const parsedPrimary = await runParse(primaryModel);
  const parsed =
    parsedPrimary ??
    (fallbackModel && fallbackModel !== primaryModel ? await runParse(fallbackModel) : null);
  if (!parsed) return null;

  const actRaw = String(parsed.act ?? "").toLowerCase();
  const act: DialogActParse["act"] =
    actRaw === "trust_concern" ||
    actRaw === "frustration" ||
    actRaw === "objection" ||
    actRaw === "preference" ||
    actRaw === "clarification"
      ? actRaw
      : "none";

  const topicRaw = String(parsed.topic ?? "").toLowerCase();
  const topic: DialogActParse["topic"] =
    topicRaw === "used_inventory" ||
    topicRaw === "new_inventory" ||
    topicRaw === "pricing" ||
    topicRaw === "trade" ||
    topicRaw === "scheduling" ||
    topicRaw === "service"
      ? topicRaw
      : "general";

  const nextActionRaw = String(parsed.next_action ?? "").toLowerCase();
  const nextAction: DialogActParse["nextAction"] =
    nextActionRaw === "reassure_then_clarify" ||
    nextActionRaw === "empathize_then_offer_help" ||
    nextActionRaw === "ask_one_clarifier"
      ? nextActionRaw
      : "normal_flow";

  const askFocusRaw = String(parsed.ask_focus ?? "").toLowerCase();
  const askFocus: DialogActParse["askFocus"] =
    askFocusRaw === "model" ||
    askFocusRaw === "budget" ||
    askFocusRaw === "timing" ||
    askFocusRaw === "condition" ||
    askFocusRaw === "other"
      ? askFocusRaw
      : null;

  const confidence =
    typeof parsed.confidence === "number" && Number.isFinite(parsed.confidence)
      ? Math.max(0, Math.min(1, parsed.confidence))
      : undefined;

  return {
    act,
    topic,
    explicitRequest: !!parsed.explicit_request,
    nextAction,
    askFocus,
    confidence
  };
}

export async function parseVehicleInfoRequestWithLLM(args: {
  text: string;
  history?: { direction: "in" | "out"; body: string }[];
  lead?: Conversation["lead"];
}): Promise<VehicleInfoRequestParse | null> {
  const useLLM =
    process.env.LLM_ENABLED === "1" &&
    process.env.LLM_VEHICLE_INFO_PARSER_ENABLED !== "0" &&
    !!process.env.OPENAI_API_KEY;
  if (!useLLM) return null;

  const debug = process.env.LLM_VEHICLE_INFO_PARSER_DEBUG === "1";
  const primaryModel =
    process.env.OPENAI_VEHICLE_INFO_PARSER_MODEL || process.env.OPENAI_MODEL || "gpt-5-mini";
  const fallbackModel =
    process.env.OPENAI_VEHICLE_INFO_PARSER_MODEL_FALLBACK ||
    (primaryModel === "gpt-5-mini" ? "gpt-4o-mini" : "");
  const text = String(args.text ?? "").trim();
  if (!text) return null;

  const history = (args.history ?? []).slice(-8).map(h => `${h.direction}: ${h.body}`);
  const lead = args.lead ?? {};
  const examples = [
    `EXAMPLE A
inbound: "Can you send me the specs on that Road Glide?"
output: {"intent":"specs","explicit_request":true,"focus":"general","format":"full","confidence":0.97}`,
    `EXAMPLE B
inbound: "What are the quick highlights?"
output: {"intent":"specs","explicit_request":true,"focus":"general","format":"highlights","confidence":0.95}`,
    `EXAMPLE C
inbound: "What does it have for stereo and screen?"
output: {"intent":"specs","explicit_request":true,"focus":"features","format":"unknown","confidence":0.96}`,
    `EXAMPLE D
inbound: "How heavy is it and what is the seat height?"
output: {"intent":"specs","explicit_request":true,"focus":"dimensions","format":"unknown","confidence":0.97}`,
    `EXAMPLE E
inbound: "Can you compare the Road Glide and Street Glide?"
output: {"intent":"compare","explicit_request":true,"focus":"general","format":"unknown","confidence":0.97}`,
    `EXAMPLE F
inbound: "full spec sheets please"
output: {"intent":"specs","explicit_request":true,"focus":"general","format":"full","confidence":0.94}`,
    `EXAMPLE F2
inbound: "Fuel economy 0.02 mpg"
output: {"intent":"specs","explicit_request":true,"focus":"engine","format":"unknown","confidence":0.93}`,
    `EXAMPLE F3
inbound: "What kind of mpg does that bike get?"
output: {"intent":"specs","explicit_request":true,"focus":"engine","format":"unknown","confidence":0.95}`,
    `EXAMPLE G
inbound: "Thanks for info. Any appointments later this month same time."
output: {"intent":"none","explicit_request":true,"focus":"unknown","format":"unknown","confidence":0.98}`,
    `EXAMPLE H
inbound: "Tuesday around 11am would work great"
output: {"intent":"none","explicit_request":false,"focus":"unknown","format":"unknown","confidence":0.98}`,
    `EXAMPLE I
inbound: "Do you have any Sportster or Nightster in stock?"
output: {"intent":"none","explicit_request":true,"focus":"unknown","format":"unknown","confidence":0.98}`
  ];
  const prompt = [
    "You are a strict parser for customer requests for vehicle specs, feature info, or model comparisons.",
    "Return only JSON matching the schema.",
    "",
    "Intent choices:",
    "- specs: asks for specifications, spec sheet, details, features, highlights, engine/tech/dimensions/accessory info about a bike.",
    "- compare: asks to compare two or more models/bikes, or asks difference/vs/versus.",
    "- none: scheduling, availability/in-stock, pricing/payment, trade, callback, acknowledgement, or general conversation.",
    "",
    "Focus:",
    "- engine: engine, power, torque, horsepower, displacement, transmission, mpg, fuel economy.",
    "- features: tech, electronics, stereo, audio, infotainment, screen, navigation, safety, brakes, suspension.",
    "- dimensions: weight, seat height, length, wheelbase, tank/fuel capacity.",
    "- accessories: trim, finish, bars, grips, seat, add-ons, packages.",
    "- general: broad specs/details/highlights without a narrower focus.",
    "- unknown: use with intent none.",
    "",
    "Rules:",
    "- The word 'info' by itself is not enough if the actual ask is appointments, scheduling, availability, pricing, or trade.",
    "- Do not classify inventory availability questions as specs or compare.",
    "- Do not classify appointment dates/times as specs.",
    "- Treat ADF-style fragments like 'Fuel economy 0.02 mpg' as a specs request, even without a question mark.",
    "- explicit_request=true only when the customer directly asks for information or a comparison.",
    "- confidence is 0..1.",
    "",
    ...examples,
    "",
    `Known lead info: ${JSON.stringify({
      model: lead?.vehicle?.model ?? lead?.vehicle?.description ?? null,
      year: lead?.vehicle?.year ?? null,
      condition: lead?.vehicle?.condition ?? null
    })}`,
    history.length ? `Recent messages:\n${history.join("\n")}` : "Recent messages: (none)",
    `Message: ${text}`
  ].join("\n");

  const runParse = async (model: string): Promise<any | null> =>
    requestStructuredJson({
      model,
      prompt,
      schemaName: "vehicle_info_request_parser",
      schema: VEHICLE_INFO_REQUEST_PARSER_JSON_SCHEMA,
      maxOutputTokens: 160,
      debugTag: "llm-vehicle-info-request-parser",
      debug
    });

  const parsedPrimary = await runParse(primaryModel);
  const parsed =
    parsedPrimary ??
    (fallbackModel && fallbackModel !== primaryModel ? await runParse(fallbackModel) : null);
  if (!parsed) return null;

  const intentRaw = String(parsed.intent ?? "").toLowerCase();
  const intent: VehicleInfoRequestParse["intent"] =
    intentRaw === "specs" || intentRaw === "compare" ? intentRaw : "none";
  const focusRaw = String(parsed.focus ?? "").toLowerCase();
  const focus: VehicleInfoRequestParse["focus"] =
    focusRaw === "engine" ||
    focusRaw === "features" ||
    focusRaw === "dimensions" ||
    focusRaw === "accessories" ||
    focusRaw === "general"
      ? focusRaw
      : "unknown";
  const formatRaw = String(parsed.format ?? "").toLowerCase();
  const format: VehicleInfoRequestParse["format"] =
    formatRaw === "full" || formatRaw === "highlights" ? formatRaw : "unknown";
  const confidence =
    typeof parsed.confidence === "number" && Number.isFinite(parsed.confidence)
      ? Math.max(0, Math.min(1, parsed.confidence))
      : undefined;

  return {
    intent,
    explicitRequest: !!parsed.explicit_request,
    focus,
    format,
    confidence
  };
}

export async function parseCompositeSalesInquiryWithLLM(args: {
  text: string;
  history?: { direction: "in" | "out"; body: string }[];
  lead?: Conversation["lead"];
}): Promise<CompositeSalesInquiryParse | null> {
  const useLLM =
    process.env.LLM_ENABLED === "1" &&
    process.env.LLM_COMPOSITE_SALES_INQUIRY_PARSER_ENABLED !== "0" &&
    !!process.env.OPENAI_API_KEY;
  if (!useLLM) return null;

  const debug = process.env.LLM_COMPOSITE_SALES_INQUIRY_PARSER_DEBUG === "1";
  const primaryModel =
    process.env.OPENAI_COMPOSITE_SALES_INQUIRY_PARSER_MODEL || process.env.OPENAI_MODEL || "gpt-5-mini";
  const fallbackModel =
    process.env.OPENAI_COMPOSITE_SALES_INQUIRY_PARSER_MODEL_FALLBACK ||
    (primaryModel === "gpt-5-mini" ? "gpt-4o-mini" : "");
  const text = String(args.text ?? "").trim();
  if (!text) return null;

  const history = (args.history ?? []).slice(-8).map(h => `${h.direction}: ${h.body}`);
  const lead = args.lead ?? {};
  const examples = [
    `EXAMPLE A
inbound: "Saw the Breakout on your floor at the Friday Mother's Day affair. What would it cost out the door? What would it cost with front and rear case guards. looks very interesting to me. Could I handle the weight? Maybe. Could I handle the financing? Maybe but still looks interesting."
output: {"explicit_request":true,"asks_out_the_door_price":true,"asks_accessory_quote":true,"accessory_items":["front and rear case guards"],"has_fit_or_weight_concern":true,"has_financing_concern":true,"has_general_chatter":true,"confidence":0.98}`,
    `EXAMPLE B
inbound: "What is the out the door number with heated grips and a backrest? Also not sure if it is too heavy for me."
output: {"explicit_request":true,"asks_out_the_door_price":true,"asks_accessory_quote":true,"accessory_items":["heated grips","backrest"],"has_fit_or_weight_concern":true,"has_financing_concern":false,"has_general_chatter":false,"confidence":0.97}`,
    `EXAMPLE C
inbound: "Can you get me a payment estimate?"
output: {"explicit_request":true,"asks_out_the_door_price":false,"asks_accessory_quote":false,"accessory_items":[],"has_fit_or_weight_concern":false,"has_financing_concern":true,"has_general_chatter":false,"confidence":0.96}`,
    `EXAMPLE D
inbound: "What would it cost with pipes and a sissy bar?"
output: {"explicit_request":true,"asks_out_the_door_price":false,"asks_accessory_quote":true,"accessory_items":["pipes","sissy bar"],"has_fit_or_weight_concern":false,"has_financing_concern":false,"has_general_chatter":false,"confidence":0.96}`,
    `EXAMPLE E
inbound: "What is the out the door price?"
output: {"explicit_request":true,"asks_out_the_door_price":true,"asks_accessory_quote":false,"accessory_items":[],"has_fit_or_weight_concern":false,"has_financing_concern":false,"has_general_chatter":false,"confidence":0.96}`,
    `EXAMPLE F
inbound: "Looks interesting, maybe."
output: {"explicit_request":false,"asks_out_the_door_price":false,"asks_accessory_quote":false,"accessory_items":[],"has_fit_or_weight_concern":false,"has_financing_concern":false,"has_general_chatter":true,"confidence":0.95}`
  ];
  const prompt = [
    "You are a strict parser for multi-intent sales inquiries at a Harley-Davidson dealership.",
    "Return only JSON matching the schema.",
    "",
    "Detect whether the customer combined several sales questions in one message.",
    "Fields:",
    "- asks_out_the_door_price: exact OTD/all-in/final cost question, including tax/fees.",
    "- asks_accessory_quote: asks what the bike would cost with accessories, parts, labor, add-ons, guards, bars, grips, seat, pipes, etc.",
    "- accessory_items: normalized accessory item phrases explicitly mentioned.",
    "- has_fit_or_weight_concern: asks or worries about weight, handling, seat height, fit, comfort, balance, or whether they can handle the bike.",
    "- has_financing_concern: asks or worries about financing, payments, approval, affordability, APR, term, down payment, or whether they can handle the financing.",
    "- has_general_chatter: includes non-actionable commentary or soft interest alongside the questions.",
    "- explicit_request: true only when at least one actionable question/request is present.",
    "",
    "Rules:",
    "- This parser may return true for a single intent, but it is mainly used when two or more fields are true.",
    "- Do not invent accessory items from the lead; only extract items in the customer message.",
    "- confidence is 0..1.",
    "",
    ...examples,
    "",
    `Known lead info: ${JSON.stringify({
      model: lead?.vehicle?.model ?? lead?.vehicle?.description ?? null,
      year: lead?.vehicle?.year ?? null,
      source: lead?.source ?? null
    })}`,
    history.length ? `Recent messages:\n${history.join("\n")}` : "Recent messages: (none)",
    `Message: ${text}`
  ].join("\n");

  const runParse = async (model: string): Promise<any | null> =>
    requestStructuredJson({
      model,
      prompt,
      schemaName: "composite_sales_inquiry_parser",
      schema: COMPOSITE_SALES_INQUIRY_PARSER_JSON_SCHEMA,
      maxOutputTokens: 260,
      debugTag: "llm-composite-sales-inquiry-parser",
      debug
    });

  const parsedPrimary = await runParse(primaryModel);
  const parsed =
    parsedPrimary ??
    (fallbackModel && fallbackModel !== primaryModel ? await runParse(fallbackModel) : null);
  if (!parsed) return null;

  const confidence =
    typeof parsed.confidence === "number" && Number.isFinite(parsed.confidence)
      ? Math.max(0, Math.min(1, parsed.confidence))
      : undefined;
  const accessoryItems = Array.isArray(parsed.accessory_items)
    ? parsed.accessory_items.map((item: unknown) => String(item ?? "").trim()).filter(Boolean)
    : [];

  return {
    explicitRequest: !!parsed.explicit_request,
    asksOutTheDoorPrice: !!parsed.asks_out_the_door_price,
    asksAccessoryQuote: !!parsed.asks_accessory_quote,
    accessoryItems,
    hasFitOrWeightConcern: !!parsed.has_fit_or_weight_concern,
    hasFinancingConcern: !!parsed.has_financing_concern,
    hasGeneralChatter: !!parsed.has_general_chatter,
    confidence
  };
}

export async function parseCustomerDispositionWithLLM(args: {
  text: string;
  history?: { direction: "in" | "out"; body: string }[];
  lead?: Conversation["lead"];
}): Promise<CustomerDispositionParse | null> {
  const useLLM =
    process.env.LLM_ENABLED === "1" &&
    process.env.LLM_CUSTOMER_DISPOSITION_PARSER_ENABLED !== "0" &&
    !!process.env.OPENAI_API_KEY;
  if (!useLLM) return null;

  const debug = process.env.LLM_CUSTOMER_DISPOSITION_PARSER_DEBUG === "1";
  const primaryModel =
    process.env.OPENAI_CUSTOMER_DISPOSITION_PARSER_MODEL || process.env.OPENAI_MODEL || "gpt-5-mini";
  const fallbackModel =
    process.env.OPENAI_CUSTOMER_DISPOSITION_PARSER_MODEL_FALLBACK ||
    (primaryModel === "gpt-5-mini" ? "gpt-4o-mini" : "");
  const text = String(args.text ?? "").trim();
  if (!text) return null;

  const history = (args.history ?? []).slice(-6).map(h => `${h.direction}: ${h.body}`);
  const lead = args.lead ?? {};
  const examples = [
    `EXAMPLE A
inbound: "I think I'm going to keep my bike and hold off for now."
output: {"disposition":"keep_current_bike","explicit_disposition":true,"timeframe_text":"","confidence":0.96}`,
    `EXAMPLE B
inbound: "I'm just going to sell it myself."
output: {"disposition":"sell_on_own","explicit_disposition":true,"timeframe_text":"","confidence":0.97}`,
    `EXAMPLE C
inbound: "Price is too high right now, maybe after tax return."
output: {"disposition":"defer_with_window","explicit_disposition":true,"timeframe_text":"after tax return","confidence":0.93}`,
    `EXAMPLE D
inbound: "I need to talk to my wife first."
output: {"disposition":"none","explicit_disposition":false,"timeframe_text":"","confidence":0.86}`,
    `EXAMPLE E
inbound: "I have $2,500 down and want to stay under $500/month."
output: {"disposition":"none","explicit_disposition":false,"timeframe_text":"","confidence":0.96}`,
    `EXAMPLE F
inbound: "Do you have any black Street Glides in stock?"
output: {"disposition":"none","explicit_disposition":false,"timeframe_text":"","confidence":0.96}`,
    `EXAMPLE G
inbound: "I'm going to keep mine for now, but can you call me next month?"
output: {"disposition":"keep_current_bike","explicit_disposition":true,"timeframe_text":"next month","confidence":0.92}`,
    `EXAMPLE H
inbound: "You can hold off. Thanks"
output: {"disposition":"stepping_back","explicit_disposition":true,"timeframe_text":"","confidence":0.95}`,
    `EXAMPLE I
inbound: "I'll pass man. I just like to ride the new models and check them out. Not a big deal. Thx"
output: {"disposition":"stepping_back","explicit_disposition":true,"timeframe_text":"","confidence":0.94}`,
    `EXAMPLE J
inbound: "I have to cancel coming to you Tuesday. I'm having service done on the bike and inspection. I need to do a few more things before I can sell. I'll get back to you."
output: {"disposition":"defer_no_window","explicit_disposition":true,"timeframe_text":"","confidence":0.93}`,
    `EXAMPLE K
inbound: "Thanks Joe. I'm all set on the bike search for the time being. Appreciate your help. I'll reach out when I'm looking again."
output: {"disposition":"defer_no_window","explicit_disposition":true,"timeframe_text":"","confidence":0.94}`,
    `EXAMPLE L
inbound: "I'm not looking right now but I'll get a hold of you when I'm ready."
output: {"disposition":"defer_no_window","explicit_disposition":true,"timeframe_text":"","confidence":0.93}`
  ];

  const prompt = [
    "You are a parser for dealership customer disposition in inbound SMS.",
    "Return only JSON that matches the provided schema.",
    "",
    "Disposition rules:",
    "- sell_on_own: customer says they will sell their bike on their own / themselves.",
    "- keep_current_bike: customer says they are going to keep their current bike.",
    "- stepping_back: customer indicates they are passing or holding off now without specific sell/keep wording.",
    "- defer_no_window: customer defers with no concrete timeframe (e.g., 'not ready', 'maybe later').",
    "- defer_with_window: customer defers and gives a concrete timeframe (e.g., next month/spring).",
    "- none: no clear disposition intent.",
    "",
    "Important:",
    "- If message contains compliments plus a disposition, disposition still applies.",
    "- If customer says price/payment is too high or they can't afford it right now, treat as defer_no_window unless they provide a clear timeframe.",
    "- explicit_disposition=true only when disposition is clearly expressed.",
    "- timeframe_text should contain the raw timeframe phrase when disposition is defer_with_window; otherwise empty string.",
    "- If a clear disposition is mixed with another active request, still parse the disposition but preserve any raw timeframe phrase.",
    "- confidence is 0..1.",
    "",
    ...examples,
    "",
    `Known lead info: ${JSON.stringify({
      model: lead?.vehicle?.model ?? lead?.vehicle?.description ?? null,
      year: lead?.vehicle?.year ?? null
    })}`,
    history.length ? `Recent messages:\n${history.join("\n")}` : "Recent messages: (none)",
    `Message: ${text}`
  ].join("\n");

  const runParse = async (model: string): Promise<any | null> => {
    return requestStructuredJson({
      model,
      prompt,
      schemaName: "customer_disposition_parser",
      schema: CUSTOMER_DISPOSITION_PARSER_JSON_SCHEMA,
      maxOutputTokens: 180,
      debugTag: "llm-customer-disposition-parser",
      debug
    });
  };

  const parsedPrimary = await runParse(primaryModel);
  const parsed =
    parsedPrimary ??
    (fallbackModel && fallbackModel !== primaryModel ? await runParse(fallbackModel) : null);
  if (!parsed) return null;

  const dispositionRaw = String(parsed.disposition ?? "").toLowerCase();
  const disposition: CustomerDispositionParse["disposition"] =
    dispositionRaw === "sell_on_own" ||
    dispositionRaw === "keep_current_bike" ||
    dispositionRaw === "stepping_back" ||
    dispositionRaw === "defer_no_window" ||
    dispositionRaw === "defer_with_window"
      ? dispositionRaw
      : "none";
  const explicitDisposition = !!parsed.explicit_disposition;
  const timeframeText = cleanOptionalString(parsed.timeframe_text);
  const confidence =
    typeof parsed.confidence === "number" && Number.isFinite(parsed.confidence)
      ? Math.max(0, Math.min(1, parsed.confidence))
      : undefined;

  return {
    disposition,
    explicitDisposition,
    timeframeText,
    confidence
  };
}

export async function parseFirstTimeRiderGuidanceWithLLM(args: {
  text: string;
  history?: { direction: "in" | "out"; body: string }[];
  lead?: Conversation["lead"];
}): Promise<FirstTimeRiderGuidanceParse | null> {
  const useLLM =
    process.env.LLM_ENABLED === "1" &&
    process.env.LLM_FIRST_TIME_RIDER_GUIDANCE_PARSER_ENABLED !== "0" &&
    !!process.env.OPENAI_API_KEY;
  if (!useLLM) return null;

  const debug = process.env.LLM_FIRST_TIME_RIDER_GUIDANCE_PARSER_DEBUG === "1";
  const primaryModel =
    process.env.OPENAI_FIRST_TIME_RIDER_GUIDANCE_PARSER_MODEL || process.env.OPENAI_MODEL || "gpt-5-mini";
  const fallbackModel =
    process.env.OPENAI_FIRST_TIME_RIDER_GUIDANCE_PARSER_MODEL_FALLBACK ||
    (primaryModel === "gpt-5-mini" ? "gpt-4o-mini" : "");
  const text = String(args.text ?? "").trim();
  if (!text) return null;

  const history = (args.history ?? []).slice(-8).map(h => `${h.direction}: ${h.body}`);
  const lead = args.lead ?? {};
  const examples = [
    `EXAMPLE A
inbound: "This would be my first bike. What do you recommend?"
output: {"intent":"first_time_rider","explicit_request":true,"endorsement_status":"unknown","asks_test_ride":false,"asks_beginner_bike":true,"asks_rider_course":false,"confidence":0.97}`,
    `EXAMPLE B
inbound: "I've never ridden before but can I test ride the Nightster?"
output: {"intent":"first_time_rider","explicit_request":true,"endorsement_status":"unknown","asks_test_ride":true,"asks_beginner_bike":false,"asks_rider_course":false,"confidence":0.98}`,
    `EXAMPLE C
inbound: "I don't have my motorcycle license yet. Can I ride it?"
output: {"intent":"no_motorcycle_endorsement","explicit_request":true,"endorsement_status":"no","asks_test_ride":true,"asks_beginner_bike":false,"asks_rider_course":false,"confidence":0.98}`,
    `EXAMPLE D
inbound: "Do you know where I can take the rider course?"
output: {"intent":"rider_course_info","explicit_request":true,"endorsement_status":"unknown","asks_test_ride":false,"asks_beginner_bike":false,"asks_rider_course":true,"confidence":0.96}`,
    `EXAMPLE D2
inbound: "Your course and price"
output: {"intent":"rider_course_info","explicit_request":true,"endorsement_status":"unknown","asks_test_ride":false,"asks_beginner_bike":false,"asks_rider_course":true,"confidence":0.97}`,
    `EXAMPLE D3
inbound: "How much is the Riding Academy course?"
output: {"intent":"rider_course_info","explicit_request":true,"endorsement_status":"unknown","asks_test_ride":false,"asks_beginner_bike":false,"asks_rider_course":true,"confidence":0.98}`,
    `EXAMPLE D4
inbound: "Yes, I'm looking for a course motorcycle so I can get my license."
output: {"intent":"rider_course_info","explicit_request":true,"endorsement_status":"no","asks_test_ride":false,"asks_beginner_bike":false,"asks_rider_course":true,"confidence":0.97}`,
    `EXAMPLE D5
inbound: "I need a motorcycle course to get my license."
output: {"intent":"rider_course_info","explicit_request":true,"endorsement_status":"no","asks_test_ride":false,"asks_beginner_bike":false,"asks_rider_course":true,"confidence":0.98}`,
    `EXAMPLE E
inbound: "I have my endorsement but I'm a new rider and want something manageable."
output: {"intent":"beginner_bike_advice","explicit_request":true,"endorsement_status":"yes","asks_test_ride":false,"asks_beginner_bike":true,"asks_rider_course":false,"confidence":0.97}`,
    `EXAMPLE F
inbound: "I used to ride years ago and want to get back into it."
output: {"intent":"none","explicit_request":false,"endorsement_status":"unknown","asks_test_ride":false,"asks_beginner_bike":false,"asks_rider_course":false,"confidence":0.82}`
  ];

  const prompt = [
    "You are a strict parser for first-time motorcycle rider guidance at a Harley-Davidson dealership.",
    "Return only JSON matching the schema.",
    "",
    "Intent rules:",
    "- first_time_rider: customer says this is their first bike, first motorcycle, first time riding, or they have never ridden.",
    "- no_motorcycle_endorsement: customer says they do not have a motorcycle license, motorcycle endorsement, permit, or are not licensed yet.",
    "- beginner_bike_advice: customer asks for a good beginner/first bike, manageable bike, easy bike, low seat/weight, or rider fit advice.",
    "- rider_course_info: customer asks about learning to ride, riding school, MSF, Riding Academy, a license class, or a course.",
    "- none: message is not about first-time rider guidance.",
    "",
    "Fields:",
    "- explicit_request true when the customer is asking for guidance, a test ride, a course, or next step related to being new.",
    '- endorsement_status is "yes" only when they clearly say they have a motorcycle endorsement/license, "no" only when they clearly do not, otherwise "unknown".',
    "- asks_test_ride true when they ask to test ride/demo/ride the bike.",
    "- asks_beginner_bike true when they ask for beginner/first-bike/manageable fit advice.",
    "- asks_rider_course true when they ask about training/course/school/academy, including awkward phrasing like \"course motorcycle\" or \"course so I can get my license\".",
    "- Do not classify returning riders as first-time riders unless they explicitly say they are new or never rode.",
    "- confidence is 0..1.",
    "",
    ...examples,
    "",
    `Known lead info: ${JSON.stringify({
      model: lead?.vehicle?.model ?? lead?.vehicle?.description ?? null,
      year: lead?.vehicle?.year ?? null,
      source: lead?.source ?? null,
      hasMotoLicense: lead?.hasMotoLicense ?? null
    })}`,
    history.length ? `Recent messages:\n${history.join("\n")}` : "Recent messages: (none)",
    `Message: ${text}`
  ].join("\n");

  const runParse = async (model: string): Promise<any | null> =>
    requestStructuredJson({
      model,
      prompt,
      schemaName: "first_time_rider_guidance_parser",
      schema: FIRST_TIME_RIDER_GUIDANCE_PARSER_JSON_SCHEMA,
      maxOutputTokens: 220,
      debugTag: "llm-first-time-rider-guidance-parser",
      debug
    });

  const parsedPrimary = await runParse(primaryModel);
  const parsed =
    parsedPrimary ??
    (fallbackModel && fallbackModel !== primaryModel ? await runParse(fallbackModel) : null);
  if (!parsed) return null;

  const rawIntent = String(parsed.intent ?? "").toLowerCase();
  const intent: FirstTimeRiderGuidanceParse["intent"] =
    rawIntent === "first_time_rider" ||
    rawIntent === "no_motorcycle_endorsement" ||
    rawIntent === "beginner_bike_advice" ||
    rawIntent === "rider_course_info"
      ? rawIntent
      : "none";
  const endorsementStatus = String(parsed.endorsement_status ?? "unknown").toLowerCase();
  const hasEndorsement = endorsementStatus === "yes" ? true : endorsementStatus === "no" ? false : null;
  const confidence =
    typeof parsed.confidence === "number" && Number.isFinite(parsed.confidence)
      ? Math.max(0, Math.min(1, parsed.confidence))
      : undefined;

  return {
    intent,
    explicitRequest: !!parsed.explicit_request,
    hasEndorsement,
    asksTestRide: !!parsed.asks_test_ride,
    asksBeginnerBike: !!parsed.asks_beginner_bike,
    asksRiderCourse: !!parsed.asks_rider_course,
    confidence
  };
}

export async function parseDealerTransactionPolicyWithLLM(args: {
  text: string;
  history?: { direction: "in" | "out"; body: string }[];
  lead?: Conversation["lead"];
}): Promise<DealerTransactionPolicyParse | null> {
  const useLLM =
    process.env.LLM_ENABLED === "1" &&
    process.env.LLM_DEALER_TRANSACTION_POLICY_PARSER_ENABLED !== "0" &&
    !!process.env.OPENAI_API_KEY;
  if (!useLLM) return null;

  const debug = process.env.LLM_DEALER_TRANSACTION_POLICY_PARSER_DEBUG === "1";
  const primaryModel =
    process.env.OPENAI_DEALER_TRANSACTION_POLICY_PARSER_MODEL || process.env.OPENAI_MODEL || "gpt-5-mini";
  const fallbackModel =
    process.env.OPENAI_DEALER_TRANSACTION_POLICY_PARSER_MODEL_FALLBACK ||
    (primaryModel === "gpt-5-mini" ? "gpt-4o-mini" : "");
  const text = String(args.text ?? "").trim();
  if (!text) return null;

  const history = (args.history ?? []).slice(-8).map(h => `${h.direction}: ${h.body}`);
  const lead = args.lead ?? {};
  const examples = [
    `EXAMPLE A
inbound: "Hi Joe, sorry to text you after hours but had a quick question. Would you be able to facilitate a trade for a used bike I found with a private seller? Would the rider to rider program work for something like this?"
output: {"intent":"rider_to_rider_and_third_party","explicit_request":true,"asks_rider_to_rider_financing":true,"asks_private_seller_facilitation":true,"asks_external_dealer_facilitation":false,"confidence":0.98}`,
    `EXAMPLE B
inbound: "Do you participate in Rider to Rider financing?"
output: {"intent":"rider_to_rider_financing","explicit_request":true,"asks_rider_to_rider_financing":true,"asks_private_seller_facilitation":false,"asks_external_dealer_facilitation":false,"confidence":0.97}`,
    `EXAMPLE C
inbound: "Can you broker a private party sale for a bike I found on marketplace?"
output: {"intent":"private_seller_facilitation","explicit_request":true,"asks_rider_to_rider_financing":false,"asks_private_seller_facilitation":true,"asks_external_dealer_facilitation":false,"confidence":0.96}`,
    `EXAMPLE D
inbound: "Can you facilitate getting me a used bike from another dealer?"
output: {"intent":"external_dealer_facilitation","explicit_request":true,"asks_rider_to_rider_financing":false,"asks_private_seller_facilitation":false,"asks_external_dealer_facilitation":true,"confidence":0.95}`,
    `EXAMPLE E
inbound: "Can I trade my bike in on that Street Glide?"
output: {"intent":"none","explicit_request":true,"asks_rider_to_rider_financing":false,"asks_private_seller_facilitation":false,"asks_external_dealer_facilitation":false,"confidence":0.95}`,
    `EXAMPLE F
inbound: "Can I finance a used bike you have in stock?"
output: {"intent":"none","explicit_request":true,"asks_rider_to_rider_financing":false,"asks_private_seller_facilitation":false,"asks_external_dealer_facilitation":false,"confidence":0.95}`,
    `EXAMPLE G
recent messages:
in: "Would you be able to facilitate a trade for a used bike I found with a private seller? Would the rider to rider program work for something like this?"
out: "We do not participate in Rider to Rider financing, and we generally cannot facilitate a trade or purchase for a bike owned by a private seller."
inbound: "Fair enough. I'm more interested in the trade part than financing anyways. Would it be possible for you guys to buy this bike for an agreed amount and then I trade mine on it?"
output: {"intent":"private_seller_facilitation","explicit_request":true,"asks_rider_to_rider_financing":false,"asks_private_seller_facilitation":true,"asks_external_dealer_facilitation":false,"confidence":0.97}`
  ];

  const prompt = [
    "You are a strict parser for dealership transaction-policy questions.",
    "Return only JSON matching the schema.",
    "",
    "Intent rules:",
    "- rider_to_rider_financing: customer asks whether the dealership participates in Rider to Rider, R2R, or rider-to-rider financing.",
    "- private_seller_facilitation: customer asks whether the dealership can broker, handle, facilitate, process, finance, or trade a bike owned by a private seller/private party/marketplace seller.",
    "- external_dealer_facilitation: customer asks whether the dealership can facilitate a trade, purchase, or transfer for a used bike owned by another dealer.",
    "- rider_to_rider_and_third_party: both Rider to Rider financing and a private-seller/third-party/external-dealer facilitation request appear in the same message.",
    "- none: normal financing, trade-in, price, inventory, or appointment questions on dealership-owned inventory.",
    "",
    "Important:",
    "- Do not classify a normal trade-in question as private_seller_facilitation.",
    "- Do not classify a normal financing/payment question as rider_to_rider_financing unless Rider to Rider/R2R is explicitly mentioned.",
    "- Use recent messages for continuity: if the prior context was a private seller or Rider-to-Rider question, a follow-up asking about 'the trade part', 'buy this bike', or 'trade mine on it' is private_seller_facilitation.",
    "- explicit_request=true when the customer asks what the dealership can do or whether a program/process applies.",
    "- confidence is 0..1.",
    "",
    ...examples,
    "",
    `Known lead info: ${JSON.stringify({
      model: lead?.vehicle?.model ?? lead?.vehicle?.description ?? null,
      year: lead?.vehicle?.year ?? null,
      source: lead?.source ?? null
    })}`,
    history.length ? `Recent messages:\n${history.join("\n")}` : "Recent messages: (none)",
    `Message: ${text}`
  ].join("\n");

  const runParse = async (model: string): Promise<any | null> =>
    requestStructuredJson({
      model,
      prompt,
      schemaName: "dealer_transaction_policy_parser",
      schema: DEALER_TRANSACTION_POLICY_PARSER_JSON_SCHEMA,
      maxOutputTokens: 220,
      debugTag: "llm-dealer-transaction-policy-parser",
      debug
    });

  const parsedPrimary = await runParse(primaryModel);
  const parsed =
    parsedPrimary ??
    (fallbackModel && fallbackModel !== primaryModel ? await runParse(fallbackModel) : null);
  if (!parsed) return null;

  const rawIntent = String(parsed.intent ?? "").toLowerCase();
  const intent: DealerTransactionPolicyParse["intent"] =
    rawIntent === "rider_to_rider_financing" ||
    rawIntent === "private_seller_facilitation" ||
    rawIntent === "external_dealer_facilitation" ||
    rawIntent === "rider_to_rider_and_third_party"
      ? rawIntent
      : "none";
  const confidence =
    typeof parsed.confidence === "number" && Number.isFinite(parsed.confidence)
      ? Math.max(0, Math.min(1, parsed.confidence))
      : undefined;

  return {
    intent,
    explicitRequest: !!parsed.explicit_request,
    asksRiderToRiderFinancing: !!parsed.asks_rider_to_rider_financing,
    asksPrivateSellerFacilitation: !!parsed.asks_private_seller_facilitation,
    asksExternalDealerFacilitation: !!parsed.asks_external_dealer_facilitation,
    confidence
  };
}

export async function parseTradePayoffWithLLM(args: {
  text: string;
  history?: { direction: "in" | "out"; body: string }[];
  lead?: Conversation["lead"];
  tradePayoff?: Conversation["tradePayoff"];
}): Promise<TradePayoffParse | null> {
  const useLLM =
    process.env.LLM_ENABLED === "1" &&
    (process.env.LLM_TRADE_PAYOFF_PARSER_ENABLED === "1" ||
      process.env.LLM_UNIFIED_SLOT_PARSER_ENABLED === "1") &&
    !!process.env.OPENAI_API_KEY;
  if (!useLLM) return null;

  const debug = process.env.LLM_TRADE_PAYOFF_PARSER_DEBUG === "1";
  const primaryModel =
    process.env.OPENAI_TRADE_PAYOFF_PARSER_MODEL || process.env.OPENAI_MODEL || "gpt-5-mini";
  const fallbackModel =
    process.env.OPENAI_TRADE_PAYOFF_PARSER_MODEL_FALLBACK ||
    (primaryModel === "gpt-5-mini" ? "gpt-4o-mini" : "");
  const text = String(args.text ?? "").trim();
  if (!text) return null;

  const history = (args.history ?? []).slice(-6).map(h => `${h.direction}: ${h.body}`);
  const lead = args.lead ?? {};
  const existing = args.tradePayoff ?? null;
  const prompt = [
    "You are a parser for dealership trade-in lien/payoff messages.",
    "Return only JSON that matches the provided schema.",
    "",
    "Interpret the customer's latest message for trade payoff state.",
    "Guidelines:",
    "- payoff_status=no_lien when customer says they own it, have title, no lien/payoff/loan.",
    "- payoff_status=has_lien when customer indicates they still owe, have a lien/payoff/lender/bank loan.",
    "- payoff_status=unknown when neither is clearly stated.",
    "- needs_lien_holder_info=true when customer asks for lien holder/payoff address/info/details/name.",
    "- provides_lien_holder_info=true when customer provides lender/lien holder/payoff details.",
    "- Spelling mistakes are common (e.g., lein).",
    "- If message is unrelated to liens/payoff, return unknown/false/false with lower confidence.",
    "- confidence is 0..1.",
    "",
    `Known lead info: ${JSON.stringify({
      vehicle: lead?.vehicle?.model ?? lead?.vehicle?.description ?? null,
      tradeVehicle: lead?.tradeVehicle?.model ?? null
    })}`,
    `Existing trade payoff state: ${JSON.stringify(existing ?? {})}`,
    history.length ? `Recent messages:\n${history.join("\n")}` : "Recent messages: (none)",
    `Message: ${text}`
  ].join("\n");

  const runParse = async (model: string): Promise<any | null> => {
    return requestStructuredJson({
      model,
      prompt,
      schemaName: "trade_payoff_parser",
      schema: TRADE_PAYOFF_PARSER_JSON_SCHEMA,
      maxOutputTokens: 160,
      debugTag: "llm-trade-payoff-parser",
      debug
    });
  };

  const parsedPrimary = await runParse(primaryModel);
  const parsed =
    parsedPrimary ??
    (fallbackModel && fallbackModel !== primaryModel ? await runParse(fallbackModel) : null);
  if (!parsed) return null;

  const payoffRaw = String(parsed.payoff_status ?? "").toLowerCase();
  let payoffStatus: TradePayoffParse["payoffStatus"] =
    payoffRaw === "no_lien" || payoffRaw === "has_lien" ? payoffRaw : "unknown";
  let needsLienHolderInfo = !!parsed.needs_lien_holder_info;
  let providesLienHolderInfo = !!parsed.provides_lien_holder_info;
  const textLower = text.toLowerCase();

  // Deterministic normalization on top of LLM output to reduce brittle phrasing misses.
  const explicitNoLien =
    /\b(no lien|no payoff|no loan|paid off|paid it off|own it|have (the )?title|title in hand)\b/i.test(
      textLower
    );
  const explicitHasLien =
    /\b(still owe|owe on it|have a lien|has a lien|lien on it|payoff|lender|loan|financed|finance|bank)\b/i.test(
      textLower
    );
  const asksLienHolderInfo =
    /\b(lien|lein|lender|payoff)\b/i.test(textLower) &&
    /\b(address|info|information|details|name)\b/i.test(textLower) &&
    /[?]|\b(do you have|can you|need|what(?:'s| is)|send|provide)\b/i.test(textLower);
  const providesLienHolderInfoStrong =
    /\b(lien holder|lender|bank)\s*(is|:)\b/i.test(textLower) ||
    /\bp\.?\s*o\.?\s*box\b/i.test(textLower) ||
    /\b\d{5}(?:-\d{4})?\b/.test(textLower) ||
    /\b\d{1,5}\s+[a-z0-9'.-]+\s+(st|street|ave|avenue|rd|road|blvd|boulevard|dr|drive|ln|lane|ct|court|way)\b/i.test(
      textLower
    );

  if (explicitNoLien) {
    payoffStatus = "no_lien";
    needsLienHolderInfo = false;
    providesLienHolderInfo = false;
  } else {
    if (explicitHasLien || needsLienHolderInfo || providesLienHolderInfo || asksLienHolderInfo) {
      payoffStatus = "has_lien";
    }
    if (asksLienHolderInfo && !providesLienHolderInfoStrong) {
      needsLienHolderInfo = true;
      providesLienHolderInfo = false;
    }
    if (providesLienHolderInfo && !providesLienHolderInfoStrong) {
      providesLienHolderInfo = false;
    }
    if (providesLienHolderInfo) {
      needsLienHolderInfo = false;
      payoffStatus = "has_lien";
    }
  }

  const confidence =
    typeof parsed.confidence === "number" && Number.isFinite(parsed.confidence)
      ? Math.max(0, Math.min(1, parsed.confidence))
      : undefined;

  return {
    payoffStatus,
    needsLienHolderInfo,
    providesLienHolderInfo,
    confidence
  };
}

export async function parseTradeTargetValueWithLLM(args: {
  text: string;
  history?: { direction: "in" | "out"; body: string }[];
  lead?: Conversation["lead"];
}): Promise<TradeTargetValueParse | null> {
  const useLLM =
    process.env.LLM_ENABLED === "1" &&
    (process.env.LLM_TRADE_TARGET_VALUE_PARSER_ENABLED === "1" ||
      process.env.LLM_UNIFIED_SLOT_PARSER_ENABLED === "1") &&
    !!process.env.OPENAI_API_KEY;
  if (!useLLM) return null;

  const debug = process.env.LLM_TRADE_TARGET_VALUE_PARSER_DEBUG === "1";
  const primaryModel =
    process.env.OPENAI_TRADE_TARGET_VALUE_PARSER_MODEL || process.env.OPENAI_MODEL || "gpt-5-mini";
  const fallbackModel =
    process.env.OPENAI_TRADE_TARGET_VALUE_PARSER_MODEL_FALLBACK ||
    (primaryModel === "gpt-5-mini" ? "gpt-4o-mini" : "");
  const text = String(args.text ?? "").trim();
  if (!text) return null;

  const history = (args.history ?? []).slice(-6).map(h => `${h.direction}: ${h.body}`);
  const lead = args.lead ?? {};
  const prompt = [
    "You are a parser for trade-in target value requests in dealership SMS.",
    "Return only JSON that matches the provided schema.",
    "",
    "Goal:",
    "- Detect when customer states a specific trade value target for their bike.",
    "",
    "Examples that SHOULD set has_target_value=true:",
    "- \"am i anywhere close to 7k\"",
    "- \"I would need 7000 for my bike\"",
    "- \"if i'm not at 7,000 it won't make sense\"",
    "- \"i'd have to get at least $8,500\"",
    "",
    "Examples that SHOULD set has_target_value=false:",
    "- \"what can you give me for my bike?\" (no concrete number)",
    "- \"i want top dollar\" (no concrete number)",
    "- unrelated pricing/payment questions for the bike they're buying.",
    "",
    "Rules:",
    "- amount must be numeric dollars when present (convert shorthand like 7k -> 7000).",
    "- raw_text should contain the customer phrase indicating their target.",
    "- If no clear target amount is present, use has_target_value=false and amount=0.",
    "- confidence is 0..1.",
    "",
    `Known lead info: ${JSON.stringify({
      vehicle: lead?.vehicle?.model ?? lead?.vehicle?.description ?? null,
      tradeVehicle: lead?.tradeVehicle?.model ?? null,
      leadSource: lead?.source ?? null
    })}`,
    history.length ? `Recent messages:\n${history.join("\n")}` : "Recent messages: (none)",
    `Message: ${text}`
  ].join("\n");

  const runParse = async (model: string): Promise<any | null> => {
    return requestStructuredJson({
      model,
      prompt,
      schemaName: "trade_target_value_parser",
      schema: TRADE_TARGET_VALUE_PARSER_JSON_SCHEMA,
      maxOutputTokens: 160,
      debugTag: "llm-trade-target-value-parser",
      debug
    });
  };

  const parsedPrimary = await runParse(primaryModel);
  const parsed =
    parsedPrimary ??
    (fallbackModel && fallbackModel !== primaryModel ? await runParse(fallbackModel) : null);
  if (!parsed) return null;

  const hasTargetValue = !!parsed.has_target_value;
  const parsedAmount = Number(parsed.amount);
  const amount =
    Number.isFinite(parsedAmount) && parsedAmount > 0 ? Math.round(parsedAmount) : null;
  const rawText = cleanOptionalString(parsed.raw_text);
  const confidence =
    typeof parsed.confidence === "number" && Number.isFinite(parsed.confidence)
      ? Math.max(0, Math.min(1, parsed.confidence))
      : undefined;

  const textLower = text.toLowerCase();
  const hasTradeContextCue =
    /\b(trade|bike|for it|for my bike|value|offer|appraisal)\b/.test(textLower) ||
    /\b(won't make sense|waste (our|both of our) time)\b/.test(textLower);
  const hasAmountCue =
    /\$\s*\d[\d,]*(?:\.\d+)?\b/.test(textLower) ||
    /\b\d[\d,]*(?:\.\d+)?\s*k\b/.test(textLower) ||
    /\b\d{3,6}\b/.test(textLower);
  const hasTargetLanguageCue =
    /\b(close to|around|about|at least|need|have to be|would have to get|get at|be at|if i'm not at|if im not at)\b/.test(
      textLower
    );

  if (!hasTradeContextCue || !hasAmountCue || (!hasTargetLanguageCue && !hasTargetValue)) {
    return {
      hasTargetValue: false,
      amount: null,
      rawText: null,
      confidence
    };
  }

  return {
    hasTargetValue: hasTargetValue && !!amount,
    amount: hasTargetValue && amount ? amount : null,
    rawText,
    confidence
  };
}

export async function parseResponseControlWithLLM(args: {
  text: string;
  history?: { direction: "in" | "out"; body: string }[];
  lead?: Conversation["lead"];
}): Promise<ResponseControlParse | null> {
  const useLLM =
    process.env.LLM_ENABLED === "1" &&
    process.env.LLM_RESPONSE_CONTROL_PARSER_ENABLED !== "0" &&
    !!process.env.OPENAI_API_KEY;
  if (!useLLM) return null;

  const debug = process.env.LLM_RESPONSE_CONTROL_PARSER_DEBUG === "1";
  const primaryModel =
    process.env.OPENAI_RESPONSE_CONTROL_PARSER_MODEL || process.env.OPENAI_MODEL || "gpt-5-mini";
  const fallbackModel =
    process.env.OPENAI_RESPONSE_CONTROL_PARSER_MODEL_FALLBACK ||
    (primaryModel === "gpt-5-mini" ? "gpt-4o-mini" : "");
  const text = String(args.text ?? "").trim();
  if (!text) return null;

  const history = (args.history ?? []).slice(-6).map(h => `${h.direction}: ${h.body}`);
  const lead = args.lead ?? {};

  const prompt = [
    "You are a strict control-intent parser for dealership inbound SMS.",
    "Return only JSON that matches the provided schema.",
    "",
    "Classify message intent as one of:",
    "- opt_out: customer requests no texts/messages or asks to stop/cancel/end messages.",
    "- wrong_number: recipient says this is the wrong number, not them, or asks who this is because the message reached the wrong person.",
    "- not_interested: customer clearly declines buying/follow-up for now.",
    "- schedule_request: customer explicitly asks to book/schedule/pick a day/time.",
    "- compliment_only: customer only compliments the bike/team without request/action.",
    "- no_response: customer only acknowledges/signs off and no useful customer-facing reply is needed.",
    "- none: anything else.",
    "",
    "Rules:",
    "- Choose only one intent.",
    "- If customer says STOP/unsubscribe/no more texts => opt_out.",
    "- If customer says wrong number / you have the wrong number / this is not me / who is this because they are not the intended person => wrong_number.",
    "- If customer says not interested / pass / no thanks / not moving forward => not_interested.",
    "- schedule_request only for explicit scheduling intent (appointment/time/day availability).",
    "- compliment_only only if no other request/intent is present.",
    "- no_response for short acknowledgements/signoffs like Perfect, Sounds good, Talk soon, Ok, thumbs-up text, when there is no question or requested action.",
    "- Do not classify phrasing like 'like I said' as compliment_only; that is conversational context, not praise.",
    "- If the customer attaches media while giving paperwork/proof/status, use intent=none unless the text is only praise.",
    "- If uncertain, intent=none and explicit_request=false.",
    "- confidence is 0..1.",
    "",
    "Examples:",
    'input: "That bike looks awesome" output: {"intent":"compliment_only","explicit_request":true,"confidence":0.94}',
    'input: "Like I said, I am legit" output: {"intent":"none","explicit_request":false,"confidence":0.92}',
    'input: "Looks great, can I come Tuesday?" output: {"intent":"schedule_request","explicit_request":true,"confidence":0.95}',
    'input: "Talk soon!" output: {"intent":"no_response","explicit_request":false,"confidence":0.96}',
    'input: "Ok 👍" output: {"intent":"no_response","explicit_request":false,"confidence":0.96}',
    'input: "Perfect" output: {"intent":"no_response","explicit_request":false,"confidence":0.96}',
    'input: "Perfect." output: {"intent":"no_response","explicit_request":false,"confidence":0.94}',
    'input: "Cool" output: {"intent":"no_response","explicit_request":false,"confidence":0.95}',
    'input: "Ok great!" output: {"intent":"no_response","explicit_request":false,"confidence":0.95}',
    'input: "Wrong number?" output: {"intent":"wrong_number","explicit_request":true,"confidence":0.98}',
    'input: "You have the wrong number" output: {"intent":"wrong_number","explicit_request":true,"confidence":0.98}',
    'input: "You can hold off. Thanks" output: {"intent":"not_interested","explicit_request":true,"confidence":0.94}',
    'input: "I’ll pass man. I just like to ride the new models and check them out. Not a big deal. Thx" output: {"intent":"not_interested","explicit_request":true,"confidence":0.94}',
    'input: "Here is my insurance card" output: {"intent":"none","explicit_request":false,"confidence":0.91}',
    "",
    `Known lead info: ${JSON.stringify({
      model: lead?.vehicle?.model ?? lead?.vehicle?.description ?? null,
      year: lead?.vehicle?.year ?? null
    })}`,
    history.length ? `Recent messages:\n${history.join("\n")}` : "Recent messages: (none)",
    `Message: ${text}`
  ].join("\n");

  const runParse = async (model: string): Promise<any | null> => {
    return requestStructuredJson({
      model,
      prompt,
      schemaName: "response_control_parser",
      schema: RESPONSE_CONTROL_PARSER_JSON_SCHEMA,
      maxOutputTokens: 140,
      debugTag: "llm-response-control-parser",
      debug
    });
  };

  const parsedPrimary = await runParse(primaryModel);
  const parsed =
    parsedPrimary ??
    (fallbackModel && fallbackModel !== primaryModel ? await runParse(fallbackModel) : null);
  if (!parsed) return null;

  const intentRaw = String(parsed.intent ?? "").toLowerCase();
  const intent: ResponseControlParse["intent"] =
    intentRaw === "opt_out" ||
    intentRaw === "wrong_number" ||
    intentRaw === "not_interested" ||
    intentRaw === "schedule_request" ||
    intentRaw === "no_response" ||
    intentRaw === "compliment_only"
      ? intentRaw
      : "none";
  const explicitRequest = !!parsed.explicit_request;
  const confidence =
    typeof parsed.confidence === "number" && Number.isFinite(parsed.confidence)
      ? Math.max(0, Math.min(1, parsed.confidence))
      : undefined;

  return {
    intent,
    explicitRequest,
    confidence
  };
}

export async function parsePurchaseDeliveryLogisticsWithLLM(args: {
  text: string;
  history?: { direction: "in" | "out"; body: string }[];
  lead?: Conversation["lead"];
}): Promise<PurchaseDeliveryLogisticsParse | null> {
  const useLLM =
    process.env.LLM_ENABLED === "1" &&
    process.env.LLM_PURCHASE_DELIVERY_LOGISTICS_PARSER_ENABLED !== "0" &&
    !!process.env.OPENAI_API_KEY;
  if (!useLLM) return null;

  const debug = process.env.LLM_PURCHASE_DELIVERY_LOGISTICS_PARSER_DEBUG === "1";
  const primaryModel =
    process.env.OPENAI_PURCHASE_DELIVERY_LOGISTICS_PARSER_MODEL ||
    process.env.OPENAI_MODEL ||
    "gpt-5-mini";
  const fallbackModel =
    process.env.OPENAI_PURCHASE_DELIVERY_LOGISTICS_PARSER_MODEL_FALLBACK ||
    (primaryModel === "gpt-5-mini" ? "gpt-4o-mini" : "");
  const text = String(args.text ?? "").trim();
  if (!text) return null;

  const history = (args.history ?? []).slice(-10).map(h => `${h.direction}: ${h.body}`);
  const lead = args.lead ?? {};
  const prompt = [
    "You are a strict parser for motorcycle purchase/delivery logistics in dealership SMS.",
    "Return only JSON matching the schema.",
    "",
    "Classify exactly one intent:",
    "- delivery_progress: customer gives progress/status about finalizing purchase, loan, bank, check, insurance, title, paperwork, or travel toward pickup/delivery.",
    "- delivery_timing: customer gives an arrival or pickup window for an already active purchase/delivery context.",
    "- docs_status: customer sends/mentions paperwork, insurance card, license, title, PDF, check, or proof documents.",
    "- post_sale_item_pickup: after purchase/delivery, customer mentions someone coming by for leftover/take-off/stock parts or accessories that did not fit during pickup.",
    "- none: shopping, trade appraisal scheduling, test ride scheduling, inventory availability, generic appointment setting, compliments, or unrelated chat.",
    "",
    "Rules:",
    "- This parser is for active purchase/delivery logistics, not ordinary appointments.",
    "- delivery_timing requires recent context that the customer is buying/picking up/taking delivery or sending purchase docs.",
    "- If the message combines a happy post-sale note with arranging pickup for stock exhaust/parts/accessories, use post_sale_item_pickup, not inventory availability.",
    "- If the customer says they are coming to inspect/appraise a trade or test ride, intent=none.",
    "- timing_text should contain the arrival/pickup timing phrase if present, else empty string.",
    "- explicit_request is true only when the customer asks a question/action; status updates can be false.",
    "- confidence is 0..1.",
    "",
    "Examples:",
    'input: "Speaking with bank now, finalizing loan" output: {"intent":"delivery_progress","explicit_request":false,"timing_text":"","confidence":0.96}',
    'input: "Loans finalized just need to send them insurance paperwork" output: {"intent":"delivery_progress","explicit_request":false,"timing_text":"","confidence":0.97}',
    'input: "Certified check has been made for the motorcycle" output: {"intent":"delivery_progress","explicit_request":false,"timing_text":"","confidence":0.96}',
    'input: "Insured already too" output: {"intent":"docs_status","explicit_request":false,"timing_text":"","confidence":0.93}',
    'input: "Here is the insurance card" output: {"intent":"docs_status","explicit_request":false,"timing_text":"","confidence":0.95}',
    'input: "Like I said. I am legit" output: {"intent":"docs_status","explicit_request":false,"timing_text":"","confidence":0.88}',
    'input: "Let me know because I start driving on Friday morning. Please" output: {"intent":"delivery_progress","explicit_request":true,"timing_text":"Friday morning","confidence":0.94}',
    'input: "On my way doing my best to be there by 530" output: {"intent":"delivery_progress","explicit_request":false,"timing_text":"by 530","confidence":0.97}',
    'input: "be there at nine am" history: "out: ok I am around tomorrow or Friday just give me a heads up" output: {"intent":"delivery_timing","explicit_request":false,"timing_text":"9:00 AM","confidence":0.95}',
    'input: "Early afternoon ish, wife just has to be home to get kids off the bus" output: {"intent":"delivery_timing","explicit_request":false,"timing_text":"early afternoon-ish","confidence":0.93}',
    'input: "1-2 o clock ish" output: {"intent":"delivery_timing","explicit_request":false,"timing_text":"1-2 o clock-ish","confidence":0.94}',
    'input: "Working on having someone come by for the stock exhaust I just couldn\'t fit everything yesterday" output: {"intent":"post_sale_item_pickup","explicit_request":false,"timing_text":"stock exhaust pickup","confidence":0.96}',
    'input: "Ride home was amazing. I will have my buddy stop in to grab the stock pipes that would not fit" output: {"intent":"post_sale_item_pickup","explicit_request":false,"timing_text":"stock pipes pickup","confidence":0.95}',
    'input: "Can I come in Friday morning to look at it?" output: {"intent":"none","explicit_request":true,"timing_text":"","confidence":0.95}',
    'input: "Tuesday around 11am would work for a test ride" output: {"intent":"none","explicit_request":true,"timing_text":"","confidence":0.97}',
    "",
    `Known lead info: ${JSON.stringify({
      model: lead?.vehicle?.model ?? lead?.vehicle?.description ?? null,
      year: lead?.vehicle?.year ?? null,
      source: lead?.source ?? null
    })}`,
    history.length ? `Recent messages:\n${history.join("\n")}` : "Recent messages: (none)",
    `Message: ${text}`
  ].join("\n");

  const runParse = async (model: string): Promise<any | null> =>
    requestStructuredJson({
      model,
      prompt,
      schemaName: "purchase_delivery_logistics_parser",
      schema: PURCHASE_DELIVERY_LOGISTICS_PARSER_JSON_SCHEMA,
      maxOutputTokens: 160,
      debugTag: "llm-purchase-delivery-logistics-parser",
      debug
    });

  const parsedPrimary = await runParse(primaryModel);
  const parsed =
    parsedPrimary ??
    (fallbackModel && fallbackModel !== primaryModel ? await runParse(fallbackModel) : null);
  if (!parsed) return null;

  const intentRaw = String(parsed.intent ?? "").toLowerCase();
  const intent: PurchaseDeliveryLogisticsParse["intent"] =
    intentRaw === "delivery_progress" ||
    intentRaw === "delivery_timing" ||
    intentRaw === "docs_status" ||
    intentRaw === "post_sale_item_pickup"
      ? intentRaw
      : "none";
  const confidence =
    typeof parsed.confidence === "number" && Number.isFinite(parsed.confidence)
      ? Math.max(0, Math.min(1, parsed.confidence))
      : undefined;

  return {
    intent,
    explicitRequest: !!parsed.explicit_request,
    timingText: cleanOptionalString(parsed.timing_text),
    confidence
  };
}

export async function parseSalespersonMentionWithLLM(args: {
  text: string;
  history?: { direction: "in" | "out"; body: string }[];
  rosterFirstNames?: string[];
}): Promise<SalespersonMentionParse | null> {
  const useLLM =
    process.env.LLM_ENABLED === "1" &&
    process.env.LLM_SALESPERSON_MENTION_PARSER_ENABLED !== "0" &&
    !!process.env.OPENAI_API_KEY;
  if (!useLLM) return null;

  const debug = process.env.LLM_SALESPERSON_MENTION_PARSER_DEBUG === "1";
  const primaryModel =
    process.env.OPENAI_SALESPERSON_MENTION_PARSER_MODEL || process.env.OPENAI_MODEL || "gpt-5-mini";
  const fallbackModel =
    process.env.OPENAI_SALESPERSON_MENTION_PARSER_MODEL_FALLBACK ||
    (primaryModel === "gpt-5-mini" ? "gpt-4o-mini" : "");
  const text = String(args.text ?? "").trim();
  if (!text) return null;

  const history = (args.history ?? []).slice(-6).map(h => `${h.direction}: ${h.body}`);
  const roster = Array.from(
    new Set(
      (args.rosterFirstNames ?? [])
        .map(v => String(v ?? "").trim())
        .filter(Boolean)
    )
  ).slice(0, 20);
  const examples = [
    `EXAMPLE A
inbound: "Can Scott call me after 3?"
output: {"intent":"handoff_request","explicit_request":true,"target_first_name":"Scott","confidence":0.97}`,
    `EXAMPLE B
inbound: "Please have Joe reach out when my bike lands."
output: {"intent":"handoff_request","explicit_request":true,"target_first_name":"Joe","confidence":0.96}`,
    `EXAMPLE C
inbound: "Scott should have the insurance cards and binder from Progressive."
output: {"intent":"context_reference","explicit_request":false,"target_first_name":"Scott","confidence":0.95}`,
    `EXAMPLE D
inbound: "Joe, thank you for your help today. Scott should have insurance cards. Can we bump pickup to Tuesday around 11 to 11:30?"
output: {"intent":"context_reference","explicit_request":false,"target_first_name":"Scott","confidence":0.94}`,
    `EXAMPLE E
inbound: "Thanks Joe"
output: {"intent":"context_reference","explicit_request":false,"target_first_name":"Joe","confidence":0.9}`,
    `EXAMPLE E2
inbound: "Did G run the numbers yet?"
output: {"intent":"handoff_request","explicit_request":true,"target_first_name":"Giovanni","confidence":0.88}`,
    `EXAMPLE F
inbound: "Is this still available?"
output: {"intent":"none","explicit_request":false,"target_first_name":"","confidence":0.98}`
  ];

  const prompt = [
    "You parse salesperson-name mentions in dealership customer messages.",
    "Return only JSON matching the schema.",
    "",
    "Classify intent:",
    "- handoff_request: customer is asking a specific teammate to call/text/follow up (for example: 'tell Scott to call me', 'have Joe reach out').",
    "- context_reference: teammate name is context only (for example updates like 'Scott has the insurance cards') while primary ask is something else.",
    "- none: no teammate-name mention.",
    "",
    "Rules:",
    "- explicit_request=true only when the customer explicitly asks for teammate action.",
    "- target_first_name must be one roster first name when clearly referenced; else empty string.",
    "- If ambiguous/uncertain, keep target_first_name empty.",
    "- confidence is 0..1.",
    "",
    ...examples,
    "",
    `Team roster first names: ${roster.length ? roster.join(", ") : "(none provided)"}`,
    history.length ? `Recent messages:\n${history.join("\n")}` : "Recent messages: (none)",
    `Message: ${text}`
  ].join("\n");

  const runParse = async (model: string): Promise<any | null> => {
    return requestStructuredJson({
      model,
      prompt,
      schemaName: "salesperson_mention_parser",
      schema: SALESPERSON_MENTION_PARSER_JSON_SCHEMA,
      maxOutputTokens: 140,
      debugTag: "llm-salesperson-mention-parser",
      debug
    });
  };

  const parsedPrimary = await runParse(primaryModel);
  const parsed =
    parsedPrimary ??
    (fallbackModel && fallbackModel !== primaryModel ? await runParse(fallbackModel) : null);
  if (!parsed) return null;

  const intentRaw = String(parsed.intent ?? "").toLowerCase();
  const intent: SalespersonMentionParse["intent"] =
    intentRaw === "handoff_request" || intentRaw === "context_reference" ? intentRaw : "none";
  const explicitRequest = !!parsed.explicit_request;
  let targetFirstName = cleanOptionalString(parsed.target_first_name);
  if (targetFirstName && roster.length) {
    const normalized = targetFirstName.toLowerCase();
    const exact = roster.find(name => name.toLowerCase() === normalized);
    if (exact) {
      targetFirstName = exact;
    } else {
      targetFirstName = null;
    }
  }
  const confidence =
    typeof parsed.confidence === "number" && Number.isFinite(parsed.confidence)
      ? Math.max(0, Math.min(1, parsed.confidence))
      : undefined;

  return {
    intent,
    explicitRequest,
    targetFirstName: targetFirstName ?? null,
    confidence
  };
}

export async function parsePricingPaymentsIntentWithLLM(args: {
  text: string;
  history?: { direction: "in" | "out"; body: string }[];
  lead?: Conversation["lead"];
}): Promise<PricingPaymentsIntentParse | null> {
  const useLLM =
    process.env.LLM_ENABLED === "1" &&
    process.env.LLM_PRICING_PAYMENTS_PARSER_ENABLED !== "0" &&
    !!process.env.OPENAI_API_KEY;
  if (!useLLM) return null;

  const debug = process.env.LLM_PRICING_PAYMENTS_PARSER_DEBUG === "1";
  const primaryModel =
    process.env.OPENAI_PRICING_PAYMENTS_PARSER_MODEL || process.env.OPENAI_MODEL || "gpt-5-mini";
  const fallbackModel =
    process.env.OPENAI_PRICING_PAYMENTS_PARSER_MODEL_FALLBACK ||
    (primaryModel === "gpt-5-mini" ? "gpt-4o-mini" : "");
  const text = String(args.text ?? "").trim();
  if (!text) return null;

  const history = (args.history ?? []).slice(-6).map(h => `${h.direction}: ${h.body}`);
  const lead = args.lead ?? {};
  const examples = [
    `EXAMPLE A
inbound: "What would payments be on this bike?"
output: {"intent":"payments","explicit_request":true,"asks_monthly_target":false,"asks_down_payment":false,"asks_apr_or_term":false,"asks_external_approval_transfer":false,"asks_rider_to_rider_financing":false,"asks_third_party_purchase_facilitation":false,"confidence":0.97}`,
    `EXAMPLE B
inbound: "I want to stay under $500/month."
output: {"intent":"payments","explicit_request":true,"asks_monthly_target":true,"asks_down_payment":false,"asks_apr_or_term":false,"asks_external_approval_transfer":false,"asks_rider_to_rider_financing":false,"asks_third_party_purchase_facilitation":false,"confidence":0.98}`,
    `EXAMPLE C
inbound: "I have $2,500 down and want under $500/mo."
output: {"intent":"payments","explicit_request":true,"asks_monthly_target":true,"asks_down_payment":true,"asks_apr_or_term":false,"asks_external_approval_transfer":false,"asks_rider_to_rider_financing":false,"asks_third_party_purchase_facilitation":false,"confidence":0.98}`,
    `EXAMPLE D
inbound: "Can you run it for 72 months?"
output: {"intent":"payments","explicit_request":true,"asks_monthly_target":false,"asks_down_payment":false,"asks_apr_or_term":true,"asks_external_approval_transfer":false,"asks_rider_to_rider_financing":false,"asks_third_party_purchase_facilitation":false,"confidence":0.97}`,
    `EXAMPLE D2
inbound: "What is the longest term I can go with on the loan?"
output: {"intent":"payments","explicit_request":true,"asks_monthly_target":false,"asks_down_payment":false,"asks_apr_or_term":true,"asks_external_approval_transfer":false,"asks_rider_to_rider_financing":false,"asks_third_party_purchase_facilitation":false,"confidence":0.98}`,
    `EXAMPLE E
inbound: "I don't want to put anything down."
output: {"intent":"payments","explicit_request":true,"asks_monthly_target":false,"asks_down_payment":true,"asks_apr_or_term":false,"asks_external_approval_transfer":false,"asks_rider_to_rider_financing":false,"asks_third_party_purchase_facilitation":false,"confidence":0.96}`,
    `EXAMPLE F
inbound: "Any deals or finance specials right now?"
output: {"intent":"pricing","explicit_request":true,"asks_monthly_target":false,"asks_down_payment":false,"asks_apr_or_term":false,"asks_external_approval_transfer":false,"asks_rider_to_rider_financing":false,"asks_third_party_purchase_facilitation":false,"confidence":0.95}`,
    `EXAMPLE G
inbound: "What is your best out-the-door price?"
output: {"intent":"pricing","explicit_request":true,"asks_monthly_target":false,"asks_down_payment":false,"asks_apr_or_term":false,"asks_external_approval_transfer":false,"asks_rider_to_rider_financing":false,"asks_third_party_purchase_facilitation":false,"confidence":0.97}`,
    `EXAMPLE H
inbound: "Do you have any black street glides in stock?"
output: {"intent":"none","explicit_request":false,"asks_monthly_target":false,"asks_down_payment":false,"asks_apr_or_term":false,"asks_external_approval_transfer":false,"asks_rider_to_rider_financing":false,"asks_third_party_purchase_facilitation":false,"confidence":0.96}`,
    `EXAMPLE I
inbound: "Can I come in Wednesday at 1?"
output: {"intent":"none","explicit_request":false,"asks_monthly_target":false,"asks_down_payment":false,"asks_apr_or_term":false,"asks_external_approval_transfer":false,"asks_rider_to_rider_financing":false,"asks_third_party_purchase_facilitation":false,"confidence":0.97}`,
    `EXAMPLE J
inbound: "Before I come in, what do I need to bring for financing?"
output: {"intent":"payments","explicit_request":true,"asks_monthly_target":false,"asks_down_payment":false,"asks_apr_or_term":false,"asks_external_approval_transfer":false,"asks_rider_to_rider_financing":false,"asks_third_party_purchase_facilitation":false,"confidence":0.94}`,
    `EXAMPLE K
inbound: "I'm already approved through my credit union."
output: {"intent":"none","explicit_request":false,"asks_monthly_target":false,"asks_down_payment":false,"asks_apr_or_term":false,"asks_external_approval_transfer":false,"asks_rider_to_rider_financing":false,"asks_third_party_purchase_facilitation":false,"confidence":0.96}`,
    `EXAMPLE L
inbound: "I can put down 5000"
output: {"intent":"payments","explicit_request":true,"asks_monthly_target":false,"asks_down_payment":true,"asks_apr_or_term":false,"asks_external_approval_transfer":false,"asks_rider_to_rider_financing":false,"asks_third_party_purchase_facilitation":false,"confidence":0.94}`,
    `EXAMPLE M
inbound: "How much to switch my headlight bulb to LED?"
output: {"intent":"none","explicit_request":false,"asks_monthly_target":false,"asks_down_payment":false,"asks_apr_or_term":false,"asks_external_approval_transfer":false,"asks_rider_to_rider_financing":false,"asks_third_party_purchase_facilitation":false,"confidence":0.95}`,
    `EXAMPLE N
inbound: "If financing approved at Buffalo Harley is it good at your store?"
output: {"intent":"payments","explicit_request":true,"asks_monthly_target":false,"asks_down_payment":false,"asks_apr_or_term":false,"asks_external_approval_transfer":true,"asks_rider_to_rider_financing":false,"asks_third_party_purchase_facilitation":false,"confidence":0.98}`,
    `EXAMPLE O
inbound: "I got approved at another Harley dealer. Does that transfer to you?"
output: {"intent":"payments","explicit_request":true,"asks_monthly_target":false,"asks_down_payment":false,"asks_apr_or_term":false,"asks_external_approval_transfer":true,"asks_rider_to_rider_financing":false,"asks_third_party_purchase_facilitation":false,"confidence":0.98}`,
    `EXAMPLE O2
inbound: "Would you be able to facilitate a trade for a used bike I found with a private seller? Would the rider to rider program work for something like this?"
output: {"intent":"payments","explicit_request":true,"asks_monthly_target":false,"asks_down_payment":false,"asks_apr_or_term":false,"asks_external_approval_transfer":false,"asks_rider_to_rider_financing":true,"asks_third_party_purchase_facilitation":true,"confidence":0.98}`,
    `EXAMPLE O3
inbound: "Can your store handle the paperwork if I buy a bike from a private seller?"
output: {"intent":"payments","explicit_request":true,"asks_monthly_target":false,"asks_down_payment":false,"asks_apr_or_term":false,"asks_external_approval_transfer":false,"asks_rider_to_rider_financing":false,"asks_third_party_purchase_facilitation":true,"confidence":0.96}`,
    `EXAMPLE P
inbound: "Did G run the numbers yet?"
output: {"intent":"payments","explicit_request":true,"asks_monthly_target":false,"asks_down_payment":false,"asks_apr_or_term":false,"asks_external_approval_transfer":false,"asks_rider_to_rider_financing":false,"asks_third_party_purchase_facilitation":false,"confidence":0.92}`
  ];
  const prompt = [
    "You parse dealership inbound intent for pricing/payments routing.",
    "Return only JSON matching the schema.",
    "",
    "Choose one intent:",
    "- payments: monthly payment target, down payment, APR, term, finance structure questions.",
    "- pricing: total price/OTD/quote/rebate/discount questions not centered on monthly structure.",
    "- none: no clear pricing or payment ask.",
    "",
    "Rules:",
    "- If user asks 'how much down', '$300/month', 'monthly', 'APR', longest/max loan term, or term => payments.",
    "- If user asks whether a financing approval from another Harley-Davidson dealer/store transfers or is good at this store, choose payments and asks_external_approval_transfer=true.",
    "- If user asks about Rider-to-Rider / rider 2 rider / R2R financing, choose payments and asks_rider_to_rider_financing=true.",
    "- If user asks whether the dealership can broker, facilitate, trade for, or handle paperwork/financing on a private-seller or other-dealer used bike, choose payments and asks_third_party_purchase_facilitation=true.",
    "- Do not let phrases like 'after hours' turn a concrete finance/private-seller question into an hours question.",
    "- In payment context, a customer-provided down-payment number is an explicit payments turn.",
    "- A statement that the customer is already approved through their own bank/credit union is not a pricing/payments request by itself.",
    "- Do not classify scheduling/appointment messages as pricing/payments.",
    "- If mixed but payment structure is present, prefer payments.",
    "- Service, parts, apparel, or install-labor price questions are none for this sales pricing parser.",
    "- explicit_request=true only when they clearly ask a question or request numbers.",
    "- confidence is 0..1.",
    "",
    ...examples,
    "",
    `Known lead info: ${JSON.stringify({
      model: lead?.vehicle?.model ?? lead?.vehicle?.description ?? null,
      year: lead?.vehicle?.year ?? null
    })}`,
    history.length ? `Recent messages:\n${history.join("\n")}` : "Recent messages: (none)",
    `Message: ${text}`
  ].join("\n");

  const runParse = async (model: string): Promise<any | null> =>
    requestStructuredJson({
      model,
      prompt,
      schemaName: "pricing_payments_intent_parser",
      schema: PRICING_PAYMENTS_INTENT_PARSER_JSON_SCHEMA,
      maxOutputTokens: 170,
      debugTag: "llm-pricing-payments-parser",
      debug
    });

  const parsedPrimary = await runParse(primaryModel);
  const parsed =
    parsedPrimary ??
    (fallbackModel && fallbackModel !== primaryModel ? await runParse(fallbackModel) : null);
  if (!parsed) return null;

  const intentRaw = String(parsed.intent ?? "").toLowerCase();
  const intent: PricingPaymentsIntentParse["intent"] =
    intentRaw === "pricing" || intentRaw === "payments" ? intentRaw : "none";
  const confidence =
    typeof parsed.confidence === "number" && Number.isFinite(parsed.confidence)
      ? Math.max(0, Math.min(1, parsed.confidence))
      : undefined;

  return {
    intent,
    explicitRequest: !!parsed.explicit_request,
    asksMonthlyTarget: !!parsed.asks_monthly_target,
    asksDownPayment: !!parsed.asks_down_payment,
    asksAprOrTerm: !!parsed.asks_apr_or_term,
    asksExternalApprovalTransfer: !!parsed.asks_external_approval_transfer,
    asksRiderToRiderFinancing: !!parsed.asks_rider_to_rider_financing,
    asksThirdPartyPurchaseFacilitation: !!parsed.asks_third_party_purchase_facilitation,
    confidence
  };
}

export async function parseRoutingDecisionWithLLM(args: {
  text: string;
  history?: { direction: "in" | "out"; body: string }[];
  lead?: Conversation["lead"];
  followUp?: any;
  dialogState?: string | null;
  classification?: { bucket?: string | null; cta?: string | null } | null;
}): Promise<RoutingDecisionParse | null> {
  const useLLM =
    process.env.LLM_ENABLED === "1" &&
    process.env.LLM_ROUTING_PARSER_ENABLED !== "0" &&
    !!process.env.OPENAI_API_KEY;
  if (!useLLM) return null;

  const debug = process.env.LLM_ROUTING_PARSER_DEBUG === "1";
  const primaryModel = process.env.OPENAI_ROUTING_PARSER_MODEL || process.env.OPENAI_MODEL || "gpt-5-mini";
  const fallbackModel =
    process.env.OPENAI_ROUTING_PARSER_MODEL_FALLBACK ||
    (primaryModel === "gpt-5-mini" ? "gpt-4o-mini" : "");
  const text = String(args.text ?? "").trim();
  if (!text) return null;

  const history = (args.history ?? []).slice(-8).map(h => `${h.direction}: ${h.body}`);
  const lead = args.lead ?? {};
  const followUp = args.followUp ?? {};
  const examples = [
    `EXAMPLE A
inbound: "Do you have any black street glides in stock?"
output: {"primary_intent":"availability","explicit_request":true,"fallback_action":"none","clarify_prompt":"","confidence":0.97}`,
    `EXAMPLE B
inbound: "I have $2,500 down and want to stay under $500/mo"
output: {"primary_intent":"pricing_payments","explicit_request":true,"fallback_action":"none","clarify_prompt":"","confidence":0.97}`,
    `EXAMPLE C
inbound: "Can I come in Wednesday at 1?"
output: {"primary_intent":"scheduling","explicit_request":true,"fallback_action":"none","clarify_prompt":"","confidence":0.98}`,
    `EXAMPLE C2
inbound: "I begin my riding academy next Monday and was told you do the jumpstart experience prior."
output: {"primary_intent":"scheduling","explicit_request":true,"fallback_action":"none","clarify_prompt":"","confidence":0.97}`,
    `EXAMPLE D
inbound: "Can you call me after 3?"
output: {"primary_intent":"callback","explicit_request":true,"fallback_action":"none","clarify_prompt":"","confidence":0.95}`,
    `EXAMPLE D2
inbound: "If you call me around 1-2pm I should be up. I work night shift."
output: {"primary_intent":"callback","explicit_request":true,"fallback_action":"none","clarify_prompt":"","confidence":0.98}`,
    `EXAMPLE D3
inbound: "Hi Joe, I'm available to chat right now if that works for you."
output: {"primary_intent":"callback","explicit_request":true,"fallback_action":"none","clarify_prompt":"","confidence":0.94}`,
    `EXAMPLE E
inbound: "Ok thanks"
output: {"primary_intent":"none","explicit_request":false,"fallback_action":"no_response","clarify_prompt":"","confidence":0.96}`,
    `EXAMPLE F
inbound: "Yeah maybe"
output: {"primary_intent":"none","explicit_request":false,"fallback_action":"clarify","clarify_prompt":"Quick check — are you asking about payments, availability, or setting a time to come in?","confidence":0.86}`
    ,
    `EXAMPLE G
inbound: "I have $2,500 down and want to stay under $500/mo."
output: {"primary_intent":"pricing_payments","explicit_request":true,"fallback_action":"none","clarify_prompt":"","confidence":0.98}`,
    `EXAMPLE H
inbound: "Can you run it at 84 months with no money down?"
output: {"primary_intent":"pricing_payments","explicit_request":true,"fallback_action":"none","clarify_prompt":"","confidence":0.98}`,
    `EXAMPLE I
inbound: "Do you have any black street glides in stock?"
output: {"primary_intent":"availability","explicit_request":true,"fallback_action":"none","clarify_prompt":"","confidence":0.98}`,
    `EXAMPLE J
inbound: "What size motor is in this one?"
output: {"primary_intent":"general","explicit_request":true,"fallback_action":"none","clarify_prompt":"","confidence":0.9}`,
    `EXAMPLE K
inbound: "Any deals or finance specials right now?"
output: {"primary_intent":"pricing_payments","explicit_request":true,"fallback_action":"none","clarify_prompt":"","confidence":0.96}`,
    `EXAMPLE K1
inbound: "Sorry to text after hours but quick question. Would you be able to facilitate a trade for a used bike I found with a private seller? Would rider to rider work?"
output: {"primary_intent":"pricing_payments","explicit_request":true,"fallback_action":"none","clarify_prompt":"","confidence":0.98}`,
    `EXAMPLE K2
inbound: "I have cash. coming to look at the orange street glide tomorrow. let's make a deal"
output: {"primary_intent":"scheduling","explicit_request":true,"fallback_action":"none","clarify_prompt":"","confidence":0.97}`,
    `EXAMPLE K3
inbound: "i have cash and can come in tomorrow for that 2017 orange street glide"
output: {"primary_intent":"scheduling","explicit_request":true,"fallback_action":"none","clarify_prompt":"","confidence":0.98}`,
    `EXAMPLE K4
inbound: "ready to buy. i can stop by saturday morning"
output: {"primary_intent":"scheduling","explicit_request":true,"fallback_action":"none","clarify_prompt":"","confidence":0.97}`,
    `EXAMPLE K5
inbound: "let's make a deal tomorrow on the street glide"
output: {"primary_intent":"scheduling","explicit_request":true,"fallback_action":"none","clarify_prompt":"","confidence":0.96}`,
    `EXAMPLE L
inbound: "Ok sounds great"
output: {"primary_intent":"none","explicit_request":false,"fallback_action":"no_response","clarify_prompt":"","confidence":0.97}`
    ,
    `EXAMPLE L2
inbound: "Okay. Thank you. The bike would be for my husband but I'm doing the financing, hopefully."
output: {"primary_intent":"none","explicit_request":false,"fallback_action":"no_response","clarify_prompt":"","confidence":0.94}`
    ,
    `EXAMPLE M
inbound: "Hi Gio, I received all my paperwork yesterday. I am going to the notary/DMV this afternoon."
output: {"primary_intent":"general","explicit_request":true,"fallback_action":"none","clarify_prompt":"","confidence":0.93}`
    ,
    `EXAMPLE N
inbound: "Did you watch the Sabres game last night?"
output: {"primary_intent":"general","explicit_request":true,"fallback_action":"none","clarify_prompt":"","confidence":0.92}`,
    `EXAMPLE O
inbound: "You ready for nhl playoffs?"
output: {"primary_intent":"general","explicit_request":true,"fallback_action":"none","clarify_prompt":"","confidence":0.91}`,
    `EXAMPLE P
inbound: "Actually do you have any black street glides in stock?"
output: {"primary_intent":"availability","explicit_request":true,"fallback_action":"none","clarify_prompt":"","confidence":0.97}`,
    `EXAMPLE Q
inbound: "Ignore payments for now — what black options do you have in stock?"
output: {"primary_intent":"availability","explicit_request":true,"fallback_action":"none","clarify_prompt":"","confidence":0.97}`
    ,
    `EXAMPLE R
inbound: "Well only partly. Not happy about the lack of navigating or being able to put my Android maps on display."
output: {"primary_intent":"general","explicit_request":true,"fallback_action":"none","clarify_prompt":"","confidence":0.95}`,
    `EXAMPLE S
inbound: "Android Auto won’t connect and I’m pretty frustrated with this infotainment."
output: {"primary_intent":"general","explicit_request":true,"fallback_action":"none","clarify_prompt":"","confidence":0.95}`,
    `EXAMPLE T
inbound: "I’m annoyed this thing won’t show Google Maps from my phone."
output: {"primary_intent":"general","explicit_request":true,"fallback_action":"none","clarify_prompt":"","confidence":0.94}`,
    `EXAMPLE U
inbound: "Thinking ab 72 months with about 1000 down"
output: {"primary_intent":"pricing_payments","explicit_request":true,"fallback_action":"none","clarify_prompt":"","confidence":0.97}`,
    `EXAMPLE V
inbound: "Joe, thank you for your help today. Scott should have insurance cards and insurance binder. Can we bump pickup to Tuesday between 11:00 and 11:30?"
output: {"primary_intent":"scheduling","explicit_request":true,"fallback_action":"none","clarify_prompt":"","confidence":0.97}`,
    `EXAMPLE W
inbound: "Scott should have insurance cards and the binder from Progressive."
output: {"primary_intent":"general","explicit_request":true,"fallback_action":"none","clarify_prompt":"","confidence":0.9}`,
    `EXAMPLE X
inbound: "No need, I called and spoke with them already. Thanks Alexandra."
output: {"primary_intent":"none","explicit_request":false,"fallback_action":"no_response","clarify_prompt":"","confidence":0.95}`,
    `EXAMPLE Y
inbound: "Sorry it took so long."
output: {"primary_intent":"none","explicit_request":false,"fallback_action":"no_response","clarify_prompt":"","confidence":0.9}`
  ];
  const prompt = [
    "You are a strict routing parser for dealership inbound messages.",
    "Return only JSON matching the schema.",
    "",
    "Choose one primary_intent:",
    "- pricing_payments: price, payments, APR, term, down payment, or explicit finance promos/specials/incentives.",
    "- availability: in stock, still available, colors/trims/years inventory availability.",
    "- scheduling: appointment/day/time/come in/stop by requests.",
    "- callback: customer asks for a phone call or says they are available/free to chat/talk right now.",
    "- general: clear request but not one of the above.",
    "- none: no actionable request.",
    "",
    "Rules:",
    "- Use the latest inbound ask as source of truth even if prior turns were different.",
    "- If inbound is a short acknowledgment or an informational finance/context update with no ask, use primary_intent=none and fallback_action=no_response.",
    "- If a message mentions 'after hours' but then asks a finance/private-seller/Rider-to-Rider question, route the real ask, not business hours.",
    "- Rider-to-Rider, R2R, private-seller financing/paperwork, or dealership-facilitated third-party purchase questions route to pricing_payments.",
    "- Use fallback_action=clarify only when message is ambiguous and not safely routable.",
    "- Only choose callback when the customer explicitly asks for a phone call (e.g., call me, have X call me, can you call) or says they are available/free to chat/talk right now.",
    "- If message says cash-ready / ready to buy / make a deal and includes a visit timing cue (today/tomorrow/day/time/coming in), choose scheduling, not callback.",
    "- Jump start / jumpstart / riding-academy prep requests should route to scheduling (in-store stop-in), not availability or pricing by default.",
    "- Dissatisfaction/complaint about feature behavior (for example Android maps, infotainment, navigation, connectivity) without a clear inventory/pricing/scheduling/callback ask should route to general with fallback_action=none.",
    "- For clear complaint/support messages, set explicit_request=true even if phrased as a statement.",
    "- confidence is 0..1.",
    "",
    ...examples,
    "",
    `Known lead info: ${JSON.stringify({
      model: lead?.vehicle?.model ?? lead?.vehicle?.description ?? null,
      year: lead?.vehicle?.year ?? null,
      source: lead?.source ?? null
    })}`,
    `Known workflow state: ${JSON.stringify({
      followUpMode: followUp?.mode ?? null,
      followUpReason: followUp?.reason ?? null,
      dialogState: args.dialogState ?? null,
      bucket: args.classification?.bucket ?? null,
      cta: args.classification?.cta ?? null
    })}`,
    history.length ? `Recent messages:\n${history.join("\n")}` : "Recent messages: (none)",
    `Message: ${text}`
  ].join("\n");

  const runParse = async (model: string): Promise<any | null> =>
    requestStructuredJson({
      model,
      prompt,
      schemaName: "routing_decision_parser",
      schema: ROUTING_DECISION_PARSER_JSON_SCHEMA,
      maxOutputTokens: 240,
      debugTag: "llm-routing-parser",
      debug
    });

  const parsedPrimary = await runParse(primaryModel);
  const parsed =
    parsedPrimary ??
    (fallbackModel && fallbackModel !== primaryModel ? await runParse(fallbackModel) : null);
  if (!parsed) return null;

  const primaryIntentRaw = String(parsed.primary_intent ?? "").toLowerCase();
  const primaryIntent: RoutingDecisionParse["primaryIntent"] =
    primaryIntentRaw === "pricing_payments" ||
    primaryIntentRaw === "scheduling" ||
    primaryIntentRaw === "callback" ||
    primaryIntentRaw === "availability" ||
    primaryIntentRaw === "general"
      ? primaryIntentRaw
      : "none";
  const fallbackActionRaw = String(parsed.fallback_action ?? "").toLowerCase();
  const fallbackAction: RoutingDecisionParse["fallbackAction"] =
    fallbackActionRaw === "clarify" || fallbackActionRaw === "no_response"
      ? fallbackActionRaw
      : "none";
  const confidence =
    typeof parsed.confidence === "number" && Number.isFinite(parsed.confidence)
      ? Math.max(0, Math.min(1, parsed.confidence))
      : undefined;

  return {
    primaryIntent,
    explicitRequest: !!parsed.explicit_request,
    fallbackAction,
    clarifyPrompt: cleanOptionalString(parsed.clarify_prompt),
    confidence
  };
}

export async function parseAccessoryRequestWithLLM(args: {
  text: string;
  history?: { direction: "in" | "out"; body: string }[];
  lead?: Conversation["lead"];
}): Promise<AccessoryRequestParse | null> {
  const useLLM =
    process.env.LLM_ENABLED === "1" &&
    process.env.LLM_ACCESSORY_REQUEST_PARSER_ENABLED !== "0" &&
    !!process.env.OPENAI_API_KEY;
  if (!useLLM) return null;

  const debug = process.env.LLM_ACCESSORY_REQUEST_PARSER_DEBUG === "1";
  const primaryModel =
    process.env.OPENAI_ACCESSORY_REQUEST_PARSER_MODEL || process.env.OPENAI_MODEL || "gpt-5-mini";
  const fallbackModel =
    process.env.OPENAI_ACCESSORY_REQUEST_PARSER_MODEL_FALLBACK ||
    (primaryModel === "gpt-5-mini" ? "gpt-4o-mini" : "");
  const text = String(args.text ?? "").trim();
  if (!text) return null;

  const history = (args.history ?? []).slice(-8).map(h => `${h.direction}: ${h.body}`);
  const lead = args.lead ?? {};
  const examples = [
    `EXAMPLE A
inbound: "Are you able to change handbars not a fan of the ones on there"
output: {"action":"can_install","explicit_request":true,"item":"handlebars","has_humor":false,"confidence":0.98}`,
    `EXAMPLE B
inbound: "Can heated grips and seat be added?"
output: {"action":"can_install","explicit_request":true,"item":"heated grips and seat","has_humor":false,"confidence":0.98}`,
    `EXAMPLE C
inbound: "Did you get a stereo for me to hear yet?"
output: {"action":"status_check","explicit_request":true,"item":"stereo","has_humor":false,"confidence":0.97}`,
    `EXAMPLE D
inbound: "Do you have pipes I can hear before I pick?"
output: {"action":"demo_request","explicit_request":true,"item":"pipes","has_humor":false,"confidence":0.96}`,
    `EXAMPLE E
inbound: "How much to add a better seat?"
output: {"action":"pricing_request","explicit_request":true,"item":"seat","has_humor":false,"confidence":0.97}`,
    `EXAMPLE F
inbound: "\\"Off of work, and off my meds\\" lol just kidding. I am off tomorrow"
output: {"action":"none","explicit_request":false,"item":"","has_humor":true,"confidence":0.96}`,
    `EXAMPLE G
inbound: "Do you have any Street Bob coming in?"
output: {"action":"none","explicit_request":false,"item":"","has_humor":false,"confidence":0.98}`,
    `EXAMPLE H
inbound: "Tuesday around 11am would work great"
output: {"action":"none","explicit_request":false,"item":"","has_humor":false,"confidence":0.98}`
  ];
  const prompt = [
    "You are a strict parser for Harley-Davidson dealership accessory/customization requests.",
    "Return only JSON matching the schema.",
    "",
    "Classify only questions or requests about dealer-installed accessories, parts/customization, or hearing/demoing accessory sound.",
    "Actions:",
    "- can_install: asks whether the dealer can add/change/install/swap an accessory or customization.",
    "- status_check: asks whether staff got/found/checked an accessory item or demo setup.",
    "- demo_request: asks to hear/see/demo an accessory or accessory setup.",
    "- pricing_request: asks cost/pricing/labor for an accessory or customization.",
    "- none: inventory availability, factory/order timing, appointment scheduling, trade, finance, generic acknowledgement, or jokes with no accessory request.",
    "",
    "Rules:",
    "- explicit_request=true only for an explicit accessory/customization request.",
    "- item should be the normalized accessory noun phrase, such as handlebars, heated grips, seat, stereo, speakers, pipes, exhaust.",
    "- has_humor=true if the message contains an obvious joke/lol/jk, even when action is none.",
    "- Do not classify motorcycle model availability questions as accessory requests.",
    "- confidence is 0..1.",
    "",
    ...examples,
    "",
    `Known lead info: ${JSON.stringify({
      model: lead?.vehicle?.model ?? lead?.vehicle?.description ?? null,
      year: lead?.vehicle?.year ?? null,
      source: lead?.source ?? null
    })}`,
    history.length ? `Recent messages:\n${history.join("\n")}` : "Recent messages: (none)",
    `Message: ${text}`
  ].join("\n");

  const runParse = async (model: string): Promise<any | null> =>
    requestStructuredJson({
      model,
      prompt,
      schemaName: "accessory_request_parser",
      schema: ACCESSORY_REQUEST_PARSER_JSON_SCHEMA,
      maxOutputTokens: 180,
      debugTag: "llm-accessory-request-parser",
      debug
    });

  const parsedPrimary = await runParse(primaryModel);
  const parsed =
    parsedPrimary ??
    (fallbackModel && fallbackModel !== primaryModel ? await runParse(fallbackModel) : null);
  if (!parsed) return null;

  const actionRaw = String(parsed.action ?? "").toLowerCase();
  const action: AccessoryRequestParse["action"] =
    actionRaw === "can_install" ||
    actionRaw === "status_check" ||
    actionRaw === "demo_request" ||
    actionRaw === "pricing_request"
      ? actionRaw
      : "none";
  const confidence =
    typeof parsed.confidence === "number" && Number.isFinite(parsed.confidence)
      ? Math.max(0, Math.min(1, parsed.confidence))
      : undefined;

  return {
    action,
    explicitRequest: !!parsed.explicit_request,
    item: String(parsed.item ?? "").trim() || null,
    hasHumor: !!parsed.has_humor,
    confidence
  };
}

export async function parseVehicleFactQuestionWithLLM(args: {
  text: string;
  history?: { direction: "in" | "out"; body: string }[];
  lead?: Conversation["lead"];
}): Promise<VehicleFactQuestionParse | null> {
  const useLLM =
    process.env.LLM_ENABLED === "1" &&
    process.env.LLM_VEHICLE_FACT_PARSER_ENABLED !== "0" &&
    !!process.env.OPENAI_API_KEY;
  if (!useLLM) return null;

  const debug = process.env.LLM_VEHICLE_FACT_PARSER_DEBUG === "1";
  const primaryModel =
    process.env.OPENAI_VEHICLE_FACT_PARSER_MODEL || process.env.OPENAI_MODEL || "gpt-5-mini";
  const fallbackModel =
    process.env.OPENAI_VEHICLE_FACT_PARSER_MODEL_FALLBACK ||
    (primaryModel === "gpt-5-mini" ? "gpt-4o-mini" : "");
  const text = String(args.text ?? "").trim();
  if (!text) return null;

  const history = (args.history ?? []).slice(-10).map(h => `${h.direction}: ${h.body}`);
  const lead = args.lead ?? {};
  const examples = [
    `EXAMPLE A
inbound: "Year ?"
output: {"question_type":"year","explicit_request":true,"requested_fields":["year"],"confidence":0.99}`,
    `EXAMPLE B
inbound: "Total price ?"
output: {"question_type":"price","explicit_request":true,"requested_fields":["price"],"confidence":0.98}`,
    `EXAMPLE C
inbound: "What is the out the door total?"
output: {"question_type":"otd_total","explicit_request":true,"requested_fields":["out_the_door_total"],"confidence":0.98}`,
    `EXAMPLE D
inbound: "Hello yes.. is that unit fuel injection"
output: {"question_type":"engine_feature","explicit_request":true,"requested_fields":["fuel_injection"],"confidence":0.97}`,
    `EXAMPLE E
inbound: "Mileage?"
output: {"question_type":"mileage","explicit_request":true,"requested_fields":["mileage"],"confidence":0.98}`,
    `EXAMPLE F
inbound: "What color is it?"
output: {"question_type":"color","explicit_request":true,"requested_fields":["color"],"confidence":0.97}`,
    `EXAMPLE G
inbound: "Has it been serviced yet?"
output: {"question_type":"service_status","explicit_request":true,"requested_fields":["service_status"],"confidence":0.97}`,
    `EXAMPLE H
inbound: "Any service records?"
output: {"question_type":"service_records","explicit_request":true,"requested_fields":["service_records"],"confidence":0.97}`,
    `EXAMPLE I
inbound: "Is that still available?"
output: {"question_type":"availability","explicit_request":true,"requested_fields":["availability"],"confidence":0.97}`,
    `EXAMPLE I2
inbound: "Really? How long is it on hold for"
output: {"question_type":"hold_timing","explicit_request":true,"requested_fields":["hold_timing"],"confidence":0.97}`,
    `EXAMPLE I3
inbound: "Does this bike qualify for low interest?"
output: {"question_type":"finance_program_eligibility","explicit_request":true,"requested_fields":["finance_program_eligibility"],"confidence":0.97}`,
    `EXAMPLE I4
inbound: "Do you have any new bikes that qualify for 2.99 interest under 25000"
output: {"question_type":"finance_program_eligibility","explicit_request":true,"requested_fields":["finance_program_eligibility","apr","price_cap"],"confidence":0.97}`,
    `EXAMPLE J
inbound: "Tuesday around 11am would work great"
output: {"question_type":"none","explicit_request":false,"requested_fields":[],"confidence":0.98}`,
    `EXAMPLE K
inbound: "Thanks talk soon"
output: {"question_type":"none","explicit_request":false,"requested_fields":[],"confidence":0.98}`
  ];
  const prompt = [
    "You are a strict parser for short factual questions about a specific motorcycle already being discussed.",
    "Return only JSON matching the schema.",
    "",
    "Classify only direct questions asking for a concrete vehicle fact or availability status.",
    "Question types:",
    "- year: asks what year the unit is.",
    "- price: asks price, asking price, sale price, or total price before exact fees/tax are known.",
    "- otd_total: asks exact out-the-door total, final total, tax/fees included, or all-in number.",
    "- engine_feature: asks whether the bike has a mechanical/equipment feature like fuel injection.",
    "- mileage: asks mileage or miles.",
    "- color: asks color/paint.",
    "- service_status: asks whether it has been serviced, inspected, or ready.",
    "- service_records: asks for service history/records, tire/battery age, maintenance records.",
    "- availability: asks whether the currently discussed unit is still available/in stock/on hold.",
    "- hold_timing: asks how long a currently-held unit is on hold for, when the hold expires, or when it may free up.",
    "- finance_program_eligibility: asks whether a specific unit or inventory set qualifies for a finance/APR/interest program, rate, or price-capped finance special.",
    "- none: scheduling, trade appraisal, finance, generic acknowledgements, jokes, or broad inventory shopping.",
    "",
    "Rules:",
    "- explicit_request=true only when the customer explicitly asks for the fact.",
    "- A short fragment like 'Year ?' or 'Total price ?' is explicit when recent history discusses a unit.",
    "- Do not classify appointment times as vehicle facts.",
    "- confidence is 0..1.",
    "",
    ...examples,
    "",
    `Known lead info: ${JSON.stringify({
      model: lead?.vehicle?.model ?? lead?.vehicle?.description ?? null,
      year: lead?.vehicle?.year ?? null,
      stockId: lead?.vehicle?.stockId ?? null,
      vin: lead?.vehicle?.vin ?? null,
      color: lead?.vehicle?.color ?? null,
      source: lead?.source ?? null
    })}`,
    history.length ? `Recent messages:\n${history.join("\n")}` : "Recent messages: (none)",
    `Message: ${text}`
  ].join("\n");

  const runParse = async (model: string): Promise<any | null> =>
    requestStructuredJson({
      model,
      prompt,
      schemaName: "vehicle_fact_question_parser",
      schema: VEHICLE_FACT_QUESTION_PARSER_JSON_SCHEMA,
      maxOutputTokens: 160,
      debugTag: "llm-vehicle-fact-question-parser",
      debug
    });

  const parsedPrimary = await runParse(primaryModel);
  const parsed =
    parsedPrimary ??
    (fallbackModel && fallbackModel !== primaryModel ? await runParse(fallbackModel) : null);
  if (!parsed) return null;

  const raw = String(parsed.question_type ?? "").toLowerCase();
  const questionType: VehicleFactQuestionParse["questionType"] =
    raw === "year" ||
    raw === "price" ||
    raw === "otd_total" ||
    raw === "engine_feature" ||
    raw === "mileage" ||
    raw === "color" ||
    raw === "service_status" ||
    raw === "service_records" ||
    raw === "availability" ||
    raw === "hold_timing" ||
    raw === "finance_program_eligibility"
      ? raw
      : "none";
  const confidence =
    typeof parsed.confidence === "number" && Number.isFinite(parsed.confidence)
      ? Math.max(0, Math.min(1, parsed.confidence))
      : undefined;
  const requestedFields = Array.isArray(parsed.requested_fields)
    ? parsed.requested_fields.map((field: unknown) => String(field ?? "").trim()).filter(Boolean)
    : [];

  return {
    questionType,
    explicitRequest: !!parsed.explicit_request,
    requestedFields,
    confidence
  };
}

export async function parseDealershipFaqTopicWithLLM(args: {
  text: string;
  history?: { direction: "in" | "out"; body: string }[];
  lead?: Conversation["lead"];
}): Promise<DealershipFaqTopicParse | null> {
  const useLLM =
    process.env.LLM_ENABLED === "1" &&
    process.env.LLM_FAQ_TOPIC_PARSER_ENABLED !== "0" &&
    !!process.env.OPENAI_API_KEY;
  if (!useLLM) return null;

  const debug = process.env.LLM_FAQ_TOPIC_PARSER_DEBUG === "1";
  const primaryModel = process.env.OPENAI_FAQ_TOPIC_PARSER_MODEL || process.env.OPENAI_MODEL || "gpt-5-mini";
  const fallbackModel =
    process.env.OPENAI_FAQ_TOPIC_PARSER_MODEL_FALLBACK ||
    (primaryModel === "gpt-5-mini" ? "gpt-4o-mini" : "");
  const text = String(args.text ?? "").trim();
  if (!text) return null;

  const history = (args.history ?? []).slice(-6).map(h => `${h.direction}: ${h.body}`);
  const lead = args.lead ?? {};
  const examples = [
    `EXAMPLE A
inbound: "How much does a new Harley usually cost?"
output: {"topic":"pricing_cost_range","explicit_request":true,"confidence":0.97}`,
    `EXAMPLE B
inbound: "Can you negotiate on price?"
output: {"topic":"price_negotiation","explicit_request":true,"confidence":0.97}`,
    `EXAMPLE C
inbound: "What fees are included in out the door?"
output: {"topic":"fees_out_the_door","explicit_request":true,"confidence":0.98}`,
    `EXAMPLE D
inbound: "Can I custom order one with different bars and seat?"
output: {"topic":"custom_order","explicit_request":true,"confidence":0.97}`,
    `EXAMPLE E
inbound: "How long does factory order usually take?"
output: {"topic":"factory_order_timing","explicit_request":true,"confidence":0.96}`,
    `EXAMPLE E2
inbound: "when can i order a harley 750?"
output: {"topic":"factory_order_timing","explicit_request":true,"confidence":0.96}`,
    `EXAMPLE E3
inbound: "Do you have any Street Bob coming in?"
output: {"topic":"factory_order_timing","explicit_request":true,"confidence":0.96}`,
    `EXAMPLE E4
inbound: "Hi! Do you have any Street Bob coming in."
output: {"topic":"factory_order_timing","explicit_request":true,"confidence":0.96}`,
    `EXAMPLE E5
inbound: "Are you getting any Heritage Classics in brilliant red?"
output: {"topic":"factory_order_timing","explicit_request":true,"confidence":0.96}`,
    `EXAMPLE F
inbound: "Can I finance through the dealership?"
output: {"topic":"finance_approval","explicit_request":true,"confidence":0.97}`,
    `EXAMPLE G
inbound: "What credit score do I need?"
output: {"topic":"credit_score","explicit_request":true,"confidence":0.97}`,
    `EXAMPLE H
inbound: "Any low APR specials right now?"
output: {"topic":"finance_specials","explicit_request":true,"confidence":0.97}`,
    `EXAMPLE I
inbound: "Can I do no money down?"
output: {"topic":"no_money_down","explicit_request":true,"confidence":0.97}`,
    `EXAMPLE J
inbound: "Can I trade my bike in?"
output: {"topic":"trade_in","explicit_request":true,"confidence":0.98}`,
    `EXAMPLE K
inbound: "Do I need insurance before I can take delivery?"
output: {"topic":"insurance_required","explicit_request":true,"confidence":0.98}`,
    `EXAMPLE L
inbound: "What warranty comes with a new Harley?"
output: {"topic":"warranty","explicit_request":true,"confidence":0.98}`,
    `EXAMPLE L2
inbound: "Is it only the 2026 models that are eligible for the test ride or any model year bike you currently have in stock?"
output: {"topic":"test_ride_eligibility","explicit_request":true,"confidence":0.98}`,
    `EXAMPLE L3
inbound: "Can I test ride any bike you have in stock or just new ones?"
output: {"topic":"test_ride_eligibility","explicit_request":true,"confidence":0.98}`,
    `EXAMPLE M
inbound: "Do you have any black Street Glides in stock?"
output: {"topic":"none","explicit_request":true,"confidence":0.99}`,
    `EXAMPLE N
inbound: "Run this at 72 months with $5,000 down."
output: {"topic":"none","explicit_request":true,"confidence":0.99}`,
    `EXAMPLE O
inbound: "Can I come in Wednesday at 1?"
output: {"topic":"none","explicit_request":true,"confidence":0.99}`
  ];
  const prompt = [
    "You are a strict parser for dealership FAQ-style questions.",
    "Return only JSON matching the schema.",
    "",
    "Pick exactly one topic:",
    "- pricing_cost_range: broad cost range questions for new Harley bikes.",
    "- price_negotiation: asks if pricing is negotiable.",
    "- fees_out_the_door: asks about fees/OTD/tax/docs/freight/setup.",
    "- model_availability: asks what models are available right now.",
    "- custom_order: asks about custom/factory ordering.",
    "- factory_order_timing: asks how long factory order takes OR asks whether a model/unit is coming in, incoming, inbound, on order, arriving, or whether the dealer is getting one.",
    "- finance_approval: asks if financing is available.",
    "- credit_score: asks what credit score is needed.",
    "- finance_specials: asks about APR promotions/deals/specials.",
    "- no_money_down: asks about zero/low down payment.",
    "- trade_in: asks if trade-ins are accepted.",
    "- trade_tax_advantage: asks if trade lowers taxable amount.",
    "- registration_requirements: asks what docs are needed to buy/register.",
    "- street_legal: asks if bikes are street legal from factory.",
    "- inspection_requirements: asks about inspection before riding.",
    "- insurance_cost: asks how much insurance costs.",
    "- insurance_required: asks if insurance is required before delivery.",
    "- warranty: asks about factory warranty or extended coverage.",
    "- authorized_dealer_benefits: asks why buy from authorized dealer.",
    "- test_ride: asks if test rides are available.",
    "- test_ride_eligibility: asks which model years, new/used bikes, or in-stock bikes are eligible for test rides.",
    "- new_vs_used: asks whether new or used is better.",
    "- none: not an FAQ-style question above.",
    "",
    "Rules:",
    "- If message is a transactional request (specific availability, exact payment calc, scheduling), choose none.",
    "- Current in-stock availability (for example \"in stock right now\") is none; future/incoming availability (for example \"coming in\", \"getting any\", \"on order\") is factory_order_timing.",
    "- explicit_request=true only when user clearly asks a question/request.",
    "- confidence is 0..1.",
    "",
    ...examples,
    "",
    `Known lead info: ${JSON.stringify({
      model: lead?.vehicle?.model ?? lead?.vehicle?.description ?? null,
      year: lead?.vehicle?.year ?? null,
      source: lead?.source ?? null
    })}`,
    history.length ? `Recent messages:\n${history.join("\n")}` : "Recent messages: (none)",
    `Message: ${text}`
  ].join("\n");

  const runParse = async (model: string): Promise<any | null> =>
    requestStructuredJson({
      model,
      prompt,
      schemaName: "dealership_faq_topic_parser",
      schema: DEALERSHIP_FAQ_TOPIC_PARSER_JSON_SCHEMA,
      maxOutputTokens: 180,
      debugTag: "llm-faq-topic-parser",
      debug
    });

  const parsedPrimary = await runParse(primaryModel);
  const parsed =
    parsedPrimary ??
    (fallbackModel && fallbackModel !== primaryModel ? await runParse(fallbackModel) : null);
  if (!parsed) return null;

  let topicRaw = String(parsed.topic ?? "").toLowerCase();
  if (topicRaw === "none" && isIncomingInventoryFaqQuestion(text)) {
    topicRaw = "factory_order_timing";
  }
  const topic: DealershipFaqTopicParse["topic"] =
    topicRaw === "pricing_cost_range" ||
    topicRaw === "price_negotiation" ||
    topicRaw === "fees_out_the_door" ||
    topicRaw === "model_availability" ||
    topicRaw === "custom_order" ||
    topicRaw === "factory_order_timing" ||
    topicRaw === "finance_approval" ||
    topicRaw === "credit_score" ||
    topicRaw === "finance_specials" ||
    topicRaw === "no_money_down" ||
    topicRaw === "trade_in" ||
    topicRaw === "trade_tax_advantage" ||
    topicRaw === "registration_requirements" ||
    topicRaw === "street_legal" ||
    topicRaw === "inspection_requirements" ||
    topicRaw === "insurance_cost" ||
    topicRaw === "insurance_required" ||
    topicRaw === "warranty" ||
    topicRaw === "authorized_dealer_benefits" ||
    topicRaw === "test_ride" ||
    topicRaw === "test_ride_eligibility" ||
    topicRaw === "new_vs_used"
      ? topicRaw
      : "none";
  const confidence =
    typeof parsed.confidence === "number" && Number.isFinite(parsed.confidence)
      ? Math.max(0, Math.min(1, parsed.confidence))
      : undefined;

  return {
    topic,
    explicitRequest: !!parsed.explicit_request,
    confidence
  };
}

export async function parseJourneyIntentWithLLM(args: {
  text: string;
  history?: { direction: "in" | "out"; body: string }[];
  lead?: Conversation["lead"];
}): Promise<JourneyIntentParse | null> {
  const useLLM =
    process.env.LLM_ENABLED === "1" &&
    process.env.LLM_JOURNEY_INTENT_PARSER_ENABLED !== "0" &&
    !!process.env.OPENAI_API_KEY;
  if (!useLLM) return null;

  const debug = process.env.LLM_JOURNEY_INTENT_PARSER_DEBUG === "1";
  const primaryModel =
    process.env.OPENAI_JOURNEY_INTENT_PARSER_MODEL || process.env.OPENAI_MODEL || "gpt-5-mini";
  const fallbackModel =
    process.env.OPENAI_JOURNEY_INTENT_PARSER_MODEL_FALLBACK ||
    (primaryModel === "gpt-5-mini" ? "gpt-4o-mini" : "");
  const text = String(args.text ?? "").trim();
  if (!text) return null;

  const history = (args.history ?? []).slice(-6).map(h => `${h.direction}: ${h.body}`);
  const lead = args.lead ?? {};
  const prompt = [
    "You are a parser for inbound dealership customer messages.",
    "Return only JSON that matches the provided schema.",
    "",
    "Classify the message intent at the journey level:",
    "- sale_trade: customer is explicitly shopping again, wants to buy, asks for trade/appraisal value, asks about availability/pricing/test ride for purchase.",
    "- service_support: customer asks for service/repair/parts/help with current unit ownership.",
    "- marketing_event: customer references event RSVP/sweepstakes/challenge/promo participation.",
    "- none: everything else, including courtesy acknowledgements.",
    "",
    "Rules:",
    "- Use sale_trade only for clear sales or trade-in intent.",
    "- If uncertain between sale_trade and anything else, choose none.",
    "- explicit_request=true only when the customer clearly asks for action.",
    "- confidence is 0..1.",
    "",
    `Known lead info: ${JSON.stringify({
      model: lead?.vehicle?.model ?? lead?.vehicle?.description ?? null,
      year: lead?.vehicle?.year ?? null,
      source: lead?.source ?? null
    })}`,
    history.length ? `Recent messages:\n${history.join("\n")}` : "Recent messages: (none)",
    `Message: ${text}`
  ].join("\n");

  const runParse = async (model: string): Promise<any | null> => {
    return requestStructuredJson({
      model,
      prompt,
      schemaName: "journey_intent_parser",
      schema: JOURNEY_INTENT_PARSER_JSON_SCHEMA,
      maxOutputTokens: 160,
      debugTag: "llm-journey-intent-parser",
      debug
    });
  };

  const parsedPrimary = await runParse(primaryModel);
  const parsed =
    parsedPrimary ??
    (fallbackModel && fallbackModel !== primaryModel ? await runParse(fallbackModel) : null);
  if (!parsed) return null;

  const intentRaw = String(parsed.journey_intent ?? "").toLowerCase();
  const journeyIntent: JourneyIntentParse["journeyIntent"] =
    intentRaw === "sale_trade" ||
    intentRaw === "service_support" ||
    intentRaw === "marketing_event"
      ? intentRaw
      : "none";
  const explicitRequest = !!parsed.explicit_request;
  const confidence =
    typeof parsed.confidence === "number" && Number.isFinite(parsed.confidence)
      ? Math.max(0, Math.min(1, parsed.confidence))
      : undefined;

  return {
    journeyIntent,
    explicitRequest,
    confidence
  };
}

export async function parseStaffOutcomeUpdateWithLLM(args: {
  text: string;
  history?: { direction: "in" | "out"; body: string }[];
  lead?: Conversation["lead"];
}): Promise<StaffOutcomeUpdateParse | null> {
  const useLLM =
    process.env.LLM_ENABLED === "1" &&
    process.env.LLM_STAFF_OUTCOME_PARSER_ENABLED !== "0" &&
    !!process.env.OPENAI_API_KEY;
  if (!useLLM) return null;

  const debug = process.env.LLM_STAFF_OUTCOME_PARSER_DEBUG === "1";
  const primaryModel =
    process.env.OPENAI_STAFF_OUTCOME_PARSER_MODEL || process.env.OPENAI_MODEL || "gpt-5-mini";
  const fallbackModel =
    process.env.OPENAI_STAFF_OUTCOME_PARSER_MODEL_FALLBACK ||
    (primaryModel === "gpt-5-mini" ? "gpt-4o-mini" : "");
  const text = String(args.text ?? "").trim();
  if (!text) return null;

  const history = (args.history ?? []).slice(-6).map(h => `${h.direction}: ${h.body}`);
  const lead = args.lead ?? {};
  const prompt = [
    "You parse internal salesperson SMS updates about post-ride/test-ride outcomes.",
    "Return only JSON matching the schema.",
    "",
    "Outcome mapping:",
    "- showed_up: customer came in / arrived / met / completed visit or ride.",
    "- no_show: customer did not show / no-show / missed appointment.",
    "- sold: sold/delivered/picked up/deal done.",
    "- hold: hold/paused/waiting with a clear defer window.",
    "- follow_up: still working, follow-up needed, call/text next week, waiting on financing/down payment/cosigner/docs/insurance/trade.",
    "- lost: customer passed, bought elsewhere, no deal.",
    "- other: explicit update that does not fit above.",
    "- none: no clear outcome.",
    "",
    "Unit extraction:",
    "- Extract stock/VIN/year/make/model/trim only if explicitly provided in text.",
    "- Do not invent unit identifiers.",
    "- Set unit_on_order=true when hold is for incoming/on-order/not-in-stock unit.",
    "",
    "Rules:",
    "- If sold + another state appear, choose sold.",
    "- If no_show + follow-up appear, choose no_show.",
    "- If hold + follow-up appear, choose hold.",
    "- If uncertain, choose none with low confidence.",
    "",
    `Known lead info: ${JSON.stringify({
      leadRef: lead?.leadRef ?? null,
      model: lead?.vehicle?.model ?? lead?.vehicle?.description ?? null,
      year: lead?.vehicle?.year ?? null
    })}`,
    history.length ? `Recent messages:\n${history.join("\n")}` : "Recent messages: (none)",
    `Update text: ${text}`
  ].join("\n");

  const runParse = async (model: string): Promise<any | null> =>
    requestStructuredJson({
      model,
      prompt,
      schemaName: "staff_outcome_update_parser",
      schema: STAFF_OUTCOME_UPDATE_PARSER_JSON_SCHEMA,
      maxOutputTokens: 240,
      debugTag: "llm-staff-outcome-parser",
      debug
    });

  const parsedPrimary = await runParse(primaryModel);
  const parsed =
    parsedPrimary ??
    (fallbackModel && fallbackModel !== primaryModel ? await runParse(fallbackModel) : null);
  if (!parsed) return null;

  const outcomeRaw = String(parsed.outcome ?? "").toLowerCase();
  const outcome: StaffOutcomeUpdateParse["outcome"] =
    outcomeRaw === "showed_up" ||
    outcomeRaw === "no_show" ||
    outcomeRaw === "sold" ||
    outcomeRaw === "hold" ||
    outcomeRaw === "follow_up" ||
    outcomeRaw === "lost" ||
    outcomeRaw === "other"
      ? outcomeRaw
      : "none";
  const confidence =
    typeof parsed.confidence === "number" && Number.isFinite(parsed.confidence)
      ? Math.max(0, Math.min(1, parsed.confidence))
      : undefined;

  return {
    outcome,
    explicitOutcome: !!parsed.explicit_outcome,
    followUpWindowText: cleanOptionalString(parsed.follow_up_window_text),
    unitOnOrder: typeof parsed.unit_on_order === "boolean" ? parsed.unit_on_order : undefined,
    unitStockId: cleanOptionalString(parsed.unit_stock_id),
    unitVin: cleanOptionalString(parsed.unit_vin),
    unitYear:
      typeof parsed.unit_year === "number" && Number.isFinite(parsed.unit_year)
        ? Math.max(0, Math.min(3000, Math.trunc(parsed.unit_year)))
        : null,
    unitMake: cleanOptionalString(parsed.unit_make),
    unitModel: cleanOptionalString(parsed.unit_model),
    unitTrim: cleanOptionalString(parsed.unit_trim),
    confidence
  };
}

export async function parseAppointmentOutcomeFollowUpPlanWithLLM(args: {
  note: string;
  primaryStatus?: string | null;
  secondaryStatus?: string | null;
  history?: { direction: "in" | "out"; body: string }[];
  lead?: Conversation["lead"];
}): Promise<AppointmentOutcomeFollowUpPlanParse | null> {
  const useLLM =
    process.env.LLM_ENABLED === "1" &&
    process.env.LLM_APPOINTMENT_OUTCOME_PLAN_PARSER_ENABLED !== "0" &&
    !!process.env.OPENAI_API_KEY;
  if (!useLLM) return null;

  const note = String(args.note ?? "").trim();
  if (!note) return null;
  const debug = process.env.LLM_APPOINTMENT_OUTCOME_PLAN_PARSER_DEBUG === "1";
  const primaryModel =
    process.env.OPENAI_APPOINTMENT_OUTCOME_PLAN_PARSER_MODEL || process.env.OPENAI_MODEL || "gpt-5-mini";
  const fallbackModel =
    process.env.OPENAI_APPOINTMENT_OUTCOME_PLAN_PARSER_MODEL_FALLBACK ||
    (primaryModel === "gpt-5-mini" ? "gpt-4o-mini" : "");
  const history = (args.history ?? []).slice(-8).map(h => `${h.direction}: ${h.body}`);
  const lead = args.lead ?? {};
  const prompt = [
    "You parse messy salesperson appointment/test-ride outcome notes into an actionable follow-up plan.",
    "Return only JSON matching the schema.",
    "",
    "Common notes and expected interpretation:",
    '- "Needs a little getting used to the trike. Not sure if he is really interested. Invite him back to ride a Heritage Softail" -> follow_up_needed=true, customer_status=uncertain, primary_concern=comfort_confidence, recommended_action=offer_alternative_ride, target_vehicle_model=Heritage Softail, message_angle=compare_alternative.',
    '- "Loved the bike but payment was high, wants numbers with 2k down" -> recommended_action=send_numbers, primary_concern=price_payment, message_angle=numbers_next_step.',
    '- "No showed, call tomorrow" -> recommended_action=call_customer, urgency=tomorrow.',
    '- "Reach back out on 5/22" -> follow_up_window_text=5/22, follow_up_date_text=5/22, urgency=this_week.',
    '- "Wife needs to see it, bring her back Saturday" -> primary_concern=needs_spouse_or_friend, recommended_action=invite_back, urgency=this_week.',
    '- "Bought elsewhere" -> follow_up_needed=false, customer_status=lost, recommended_action=no_follow_up.',
    "",
    "Rules:",
    "- Do not invent stock numbers or facts.",
    "- Extract the alternative target vehicle if the note asks to invite/ride/compare a different bike.",
    "- Extract a specific requested follow-up date into follow_up_date_text when present, such as 5/22, 05/22/2026, Friday, tomorrow, or next Tuesday.",
    "- draft_sms should be a short salesperson SMS, under 280 chars, no hard promise unless the note has one.",
    "- If the note is ambiguous but says needs follow-up, choose soft_check_in.",
    "- If there is no clear follow-up needed, set follow_up_needed=false and draft_sms empty.",
    "",
    `Outcome selection: ${JSON.stringify({
      primaryStatus: args.primaryStatus ?? null,
      secondaryStatus: args.secondaryStatus ?? null
    })}`,
    `Known lead info: ${JSON.stringify({
      leadRef: lead?.leadRef ?? null,
      model: lead?.vehicle?.model ?? lead?.vehicle?.description ?? null,
      year: lead?.vehicle?.year ?? null,
      source: lead?.source ?? null
    })}`,
    history.length ? `Recent messages:\n${history.join("\n")}` : "Recent messages: (none)",
    `Salesperson outcome note: ${note}`
  ].join("\n");

  const runParse = async (model: string): Promise<any | null> =>
    requestStructuredJson({
      model,
      prompt,
      schemaName: "appointment_outcome_follow_up_plan_parser",
      schema: APPOINTMENT_OUTCOME_FOLLOW_UP_PLAN_JSON_SCHEMA,
      maxOutputTokens: 420,
      debugTag: "llm-appointment-outcome-plan-parser",
      debug
    });

  const parsedPrimary = await runParse(primaryModel);
  const parsed =
    parsedPrimary ??
    (fallbackModel && fallbackModel !== primaryModel ? await runParse(fallbackModel) : null);
  if (!parsed) return null;

  const enumValue = <T extends string>(raw: unknown, allowed: readonly T[], fallback: T): T => {
    const value = String(raw ?? "").trim().toLowerCase();
    return (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
  };
  const confidence =
    typeof parsed.confidence === "number" && Number.isFinite(parsed.confidence)
      ? Math.max(0, Math.min(1, parsed.confidence))
      : undefined;

  return {
    followUpNeeded: !!parsed.follow_up_needed,
    customerStatus: enumValue(
      parsed.customer_status,
      ["interested", "uncertain", "not_ready", "needs_more_info", "comparing_options", "finance_pending", "lost", "unknown"] as const,
      "unknown"
    ),
    primaryConcern: enumValue(
      parsed.primary_concern,
      ["bike_fit", "comfort_confidence", "price_payment", "trade", "financing", "timing", "availability", "needs_spouse_or_friend", "none", "unknown"] as const,
      "unknown"
    ),
    recommendedAction: enumValue(
      parsed.recommended_action,
      ["invite_back", "offer_alternative_ride", "send_numbers", "send_photos_or_video", "call_customer", "check_inventory", "manager_follow_up", "finance_follow_up", "soft_check_in", "no_follow_up"] as const,
      "soft_check_in"
    ),
    targetVehicleModel: cleanOptionalString(parsed.target_vehicle_model),
    targetVehicleYear: cleanOptionalString(parsed.target_vehicle_year),
    targetVehicleCondition: enumValue(
      parsed.target_vehicle_condition,
      ["new", "used", "any", "unknown"] as const,
      "unknown"
    ),
    originalVehicleModel: cleanOptionalString(parsed.original_vehicle_model),
    followUpWindowText: cleanOptionalString(parsed.follow_up_window_text),
    followUpDateText: cleanOptionalString(parsed.follow_up_date_text),
    messageAngle: enumValue(
      parsed.message_angle,
      ["compare_alternative", "confidence_reassurance", "numbers_next_step", "inventory_options", "appointment_invite", "soft_check_in", "no_message"] as const,
      "soft_check_in"
    ),
    urgency: enumValue(
      parsed.urgency,
      ["now", "today", "tomorrow", "this_week", "next_week", "later", "unknown"] as const,
      "unknown"
    ),
    draftSms: cleanOptionalString(parsed.draft_sms),
    reasoning: cleanOptionalString(parsed.reasoning),
    confidence
  };
}

export async function parseFinanceOutcomeFromCallWithLLM(args: {
  text: string;
  summary?: string;
  history?: { direction: "in" | "out"; body: string }[];
  lead?: Conversation["lead"];
}): Promise<FinanceOutcomeFromCallParse | null> {
  const useLLM =
    process.env.LLM_ENABLED === "1" &&
    process.env.LLM_FINANCE_OUTCOME_PARSER_ENABLED !== "0" &&
    !!process.env.OPENAI_API_KEY;
  if (!useLLM) return null;

  const debug = process.env.LLM_FINANCE_OUTCOME_PARSER_DEBUG === "1";
  const primaryModel =
    process.env.OPENAI_FINANCE_OUTCOME_PARSER_MODEL || process.env.OPENAI_MODEL || "gpt-5-mini";
  const fallbackModel =
    process.env.OPENAI_FINANCE_OUTCOME_PARSER_MODEL_FALLBACK ||
    (primaryModel === "gpt-5-mini" ? "gpt-4o-mini" : "");
  const text = String(args.text ?? "").trim();
  const summary = String(args.summary ?? "").trim();
  if (!text && !summary) return null;

  const history = (args.history ?? []).slice(-6).map(h => `${h.direction}: ${h.body}`);
  const lead = args.lead ?? {};
  const prompt = [
    "You parse dealership call transcripts/summaries for finance outcome.",
    "Return only JSON matching the schema.",
    "",
    "Outcome mapping:",
    "- approved: explicit approval/pre-approval/funded/clear to buy/approved with terms.",
    "- declined: explicit not approved/declined/denied/couldn't approve/unable to approve.",
    "- needs_more_info: lender needs additional contingencies (e.g., co-signer, pay stubs, references, proof/clarification of address, residence history, insurance/docs).",
    "- none: no explicit finance outcome.",
    "",
    "Rules:",
    "- Do not infer outcome from generic discussion about rates/payments alone.",
    "- 'Needs cosigner' or 'waiting on docs' should map to needs_more_info unless explicitly 'not approved/declined'.",
    "- explicit_outcome=true only when clearly stated.",
    "- reason_text should be short phrase from transcript/summary when approved/declined/needs_more_info; else empty string.",
    "",
    `Known lead info: ${JSON.stringify({
      leadRef: lead?.leadRef ?? null,
      source: lead?.source ?? null,
      model: lead?.vehicle?.model ?? lead?.vehicle?.description ?? null
    })}`,
    history.length ? `Recent messages:\n${history.join("\n")}` : "Recent messages: (none)",
    summary ? `Call summary: ${summary}` : "Call summary: (none)",
    text ? `Transcript excerpt: ${text}` : "Transcript excerpt: (none)"
  ].join("\n");

  const runParse = async (model: string): Promise<any | null> =>
    requestStructuredJson({
      model,
      prompt,
      schemaName: "finance_outcome_from_call_parser",
      schema: FINANCE_OUTCOME_FROM_CALL_JSON_SCHEMA,
      maxOutputTokens: 160,
      debugTag: "llm-finance-outcome-call-parser",
      debug
    });

  const parsedPrimary = await runParse(primaryModel);
  const parsed =
    parsedPrimary ??
    (fallbackModel && fallbackModel !== primaryModel ? await runParse(fallbackModel) : null);
  if (!parsed) return null;

  const outcomeRaw = String(parsed.outcome ?? "").toLowerCase();
  const outcome: FinanceOutcomeFromCallParse["outcome"] =
    outcomeRaw === "approved" || outcomeRaw === "declined" || outcomeRaw === "needs_more_info"
      ? outcomeRaw
      : "none";
  const confidence =
    typeof parsed.confidence === "number" && Number.isFinite(parsed.confidence)
      ? Math.max(0, Math.min(1, parsed.confidence))
      : undefined;

  return {
    outcome,
    explicitOutcome: !!parsed.explicit_outcome,
    confidence,
    reasonText: cleanOptionalString(parsed.reason_text)
  };
}

export async function parseWalkInOutcomeWithLLM(args: {
  text: string;
  history?: { direction: "in" | "out"; body: string }[];
  lead?: Conversation["lead"];
}): Promise<WalkInOutcomeParse | null> {
  const useLLM =
    process.env.LLM_ENABLED === "1" &&
    process.env.LLM_WALKIN_OUTCOME_PARSER_ENABLED !== "0" &&
    !!process.env.OPENAI_API_KEY;
  if (!useLLM) return null;

  const debug = process.env.LLM_WALKIN_OUTCOME_PARSER_DEBUG === "1";
  const primaryModel =
    process.env.OPENAI_WALKIN_OUTCOME_PARSER_MODEL || process.env.OPENAI_MODEL || "gpt-5-mini";
  const fallbackModel =
    process.env.OPENAI_WALKIN_OUTCOME_PARSER_MODEL_FALLBACK ||
    (primaryModel === "gpt-5-mini" ? "gpt-4o-mini" : "");
  const text = String(args.text ?? "").trim();
  if (!text) return null;

  const history = (args.history ?? []).slice(-6).map(h => `${h.direction}: ${h.body}`);
  const lead = args.lead ?? {};
  const examples = [
    `EXAMPLE A
comment: "left $1,000 deposit on motorcycle. coming in 4/6 at 4:00pm to finalize deal. (step 6)"
output: {"state":"deposit_left","explicit_state":true,"test_ride_requested":false,"weather_sensitive":false,"follow_up_window_text":"","confidence":0.98}`,
    `EXAMPLE B
comment: "thinking it over, will let you know next week"
output: {"state":"decision_pending","explicit_state":true,"test_ride_requested":false,"weather_sensitive":false,"follow_up_window_text":"next week","confidence":0.95}`,
    `EXAMPLE C
comment: "wants a test ride next week when weather is better"
 output: {"state":"timing_defer_window","explicit_state":true,"test_ride_requested":true,"weather_sensitive":true,"follow_up_window_text":"next week","confidence":0.9}`,
    `EXAMPLE D
comment: "mark this lead on hold until next Friday"
output: {"state":"hold_requested","explicit_state":true,"test_ride_requested":false,"weather_sensitive":false,"follow_up_window_text":"next Friday","confidence":0.94}`,
    `EXAMPLE E
comment: "clear hold and resume follow up"
output: {"state":"hold_cleared","explicit_state":true,"test_ride_requested":false,"weather_sensitive":false,"follow_up_window_text":"","confidence":0.94}`,
    `EXAMPLE F
comment: "coming in tomorrow to finalize paperwork"
output: {"state":"deal_finalizing","explicit_state":true,"test_ride_requested":false,"weather_sensitive":false,"follow_up_window_text":"tomorrow","confidence":0.93}`,
    `EXAMPLE G
comment: "Sean is looking for a 2026 Dark Billiard Gray Street Glide Limited, we need to order one for him. would like to get a commitment and put an order in for him."
output: {"state":"deal_finalizing","explicit_state":true,"test_ride_requested":false,"weather_sensitive":false,"follow_up_window_text":"","confidence":0.9}`,
    `EXAMPLE H
comment: "going to credit union this week, waiting on approval"
output: {"state":"outside_financing_pending","explicit_state":true,"test_ride_requested":false,"weather_sensitive":false,"follow_up_window_text":"this week","confidence":0.93}`,
    `EXAMPLE I
comment: "saving up for down payment, should be ready in a few weeks"
output: {"state":"down_payment_pending","explicit_state":true,"test_ride_requested":false,"weather_sensitive":false,"follow_up_window_text":"few weeks","confidence":0.92}`,
    `EXAMPLE J
comment: "need to sell my bike first before moving forward"
output: {"state":"trade_equity_pending","explicit_state":true,"test_ride_requested":false,"weather_sensitive":false,"follow_up_window_text":"","confidence":0.93}`,
    `EXAMPLE K
comment: "need to talk to my wife first"
output: {"state":"household_approval_pending","explicit_state":true,"test_ride_requested":false,"weather_sensitive":false,"follow_up_window_text":"","confidence":0.93}`,
    `EXAMPLE L
comment: "picked out accessories and wants to go over final numbers this week"
output: {"state":"deal_finalizing","explicit_state":true,"test_ride_requested":false,"weather_sensitive":false,"follow_up_window_text":"this week","confidence":0.9}`,
    `EXAMPLE M
comment: "looking for a 2026 Street Glide Limited in Dark Billiard Gray, please watch and let me know when one comes in"
output: {"state":"none","explicit_state":false,"test_ride_requested":false,"weather_sensitive":false,"follow_up_window_text":"","confidence":0.78}`,
    `EXAMPLE N
comment: "Gary was a walk in and is buying 2026 Street Glide Limited. Trading in 2016 Ultra Limited and 2024 Pan Am Special. Had to discount bike to close deal. Plans on closing 4/24 (Step 6)"
output: {"state":"deal_finalizing","explicit_state":true,"test_ride_requested":false,"weather_sensitive":false,"follow_up_window_text":"4/24","confidence":0.96}`,
    `EXAMPLE O
comment: "Thank for coming in and tell him it was nice working with him. I will be in touch about delivery and parts status. (Step 8)"
output: {"state":"deal_finalizing","explicit_state":true,"test_ride_requested":false,"weather_sensitive":false,"follow_up_window_text":"","confidence":0.95}`,
    `EXAMPLE P
comment: "Stopped in, really liked the dark billiard and gray 2026 Street Glide. Would also like to watch for a 2024-2025 pre-owned street glide. Reach follow up on 5/23/26. (Step 2)"
output: {"state":"none","explicit_state":false,"test_ride_requested":false,"weather_sensitive":false,"follow_up_window_text":"5/23/26","confidence":0.88}`,
    `EXAMPLE Q
comment: "Would like to take some time to go over finances. Going on a trip end of the month. Definitely interested in the bike."
output: {"state":"decision_pending","explicit_state":true,"test_ride_requested":false,"weather_sensitive":false,"follow_up_window_text":"","confidence":0.9}`
  ];
  const prompt = [
    "You parse walk-in salesperson comments from dealership ADF leads.",
    "Return only JSON that matches the schema.",
    "",
    "Choose exactly one primary state:",
    "- deal_finalizing: finalizing paperwork/deal soon but not explicitly sold yet.",
    "- deposit_left: left/placed/took deposit.",
    "- sold_delivered: sold, delivered, or picked up.",
    "- hold_requested: explicitly asks to mark/set/put lead on hold.",
    "- hold_cleared: explicitly asks to clear/release hold or resume.",
    "- cosigner_required: needs co-signer / credit app waiting for co-signer.",
    "- test_ride_completed: customer already took/completed test ride.",
    "- decision_pending: thinking it over / not ready / will let us know.",
    "- outside_financing_pending: waiting on credit union or bank financing.",
    "- down_payment_pending: saving/waiting for down payment.",
    "- trade_equity_pending: needs to sell bike first / waiting trade value / upside down.",
    "- timing_defer_window: defer with broad window (after winter/next month/after taxes/bonus).",
    "- household_approval_pending: needs spouse/partner approval.",
    "- docs_or_insurance_pending: waiting on title/docs/registration/insurance quote/DMV.",
    "- none: no clear state.",
    "",
    "Additional fields:",
    "- explicit_state=true only when state is clearly stated.",
    "- test_ride_requested=true when they want to schedule/line up a test ride (even if not immediate).",
    "- weather_sensitive=true when timing depends on weather being nicer/warmer.",
    "- follow_up_window_text: short raw window phrase like 'next week' or 'after winter'; empty string if none.",
    "- confidence is 0..1.",
    "",
    "Rules:",
    "- If both sold/delivered and another pending state appear, prefer sold_delivered.",
    "- If deposit and pending state both appear, prefer deposit_left.",
    "- If finalizing language appears without explicit sold/delivered, choose deal_finalizing.",
    "- Phrases like 'left $X deposit' and high pipeline notes such as '(step 6)' usually indicate deposit_left unless sold/delivered is explicit.",
    "- Do not set follow_up_window_text for incidental customer availability/travel timing (for example 'going on a trip end of month') unless the note explicitly asks to call, text, reach out, or follow up at that time.",
    "- If uncertain, return state=none, explicit_state=false, low confidence.",
    "",
    ...examples,
    "",
    `Known lead info: ${JSON.stringify({
      model: lead?.vehicle?.model ?? lead?.vehicle?.description ?? null,
      year: lead?.vehicle?.year ?? null,
      source: lead?.source ?? null
    })}`,
    history.length ? `Recent messages:\n${history.join("\n")}` : "Recent messages: (none)",
    `Comment: ${text}`
  ].join("\n");

  const runParse = async (model: string): Promise<any | null> =>
    requestStructuredJson({
      model,
      prompt,
      schemaName: "walkin_outcome_parser",
      schema: WALK_IN_OUTCOME_PARSER_JSON_SCHEMA,
      maxOutputTokens: 220,
      debugTag: "llm-walkin-outcome-parser",
      debug
    });

  const parsedPrimary = await runParse(primaryModel);
  const parsed =
    parsedPrimary ??
    (fallbackModel && fallbackModel !== primaryModel ? await runParse(fallbackModel) : null);
  if (!parsed) return null;

  const stateRaw = String(parsed.state ?? "").toLowerCase();
  const state: WalkInOutcomeParse["state"] =
    stateRaw === "deal_finalizing" ||
    stateRaw === "deposit_left" ||
    stateRaw === "sold_delivered" ||
    stateRaw === "hold_requested" ||
    stateRaw === "hold_cleared" ||
    stateRaw === "cosigner_required" ||
    stateRaw === "test_ride_completed" ||
    stateRaw === "decision_pending" ||
    stateRaw === "outside_financing_pending" ||
    stateRaw === "down_payment_pending" ||
    stateRaw === "trade_equity_pending" ||
    stateRaw === "timing_defer_window" ||
    stateRaw === "household_approval_pending" ||
    stateRaw === "docs_or_insurance_pending"
      ? stateRaw
      : "none";
  const confidence =
    typeof parsed.confidence === "number" && Number.isFinite(parsed.confidence)
      ? Math.max(0, Math.min(1, parsed.confidence))
      : undefined;

  return {
    state,
    explicitState: !!parsed.explicit_state,
    testRideRequested: !!parsed.test_ride_requested,
    weatherSensitive: !!parsed.weather_sensitive,
    followUpWindowText: cleanOptionalString(parsed.follow_up_window_text),
    confidence
  };
}

export async function parseConversationStateWithLLM(args: {
  text: string;
  history?: { direction: "in" | "out"; body: string }[];
  lead?: Conversation["lead"];
  followUp?: Conversation["followUp"] | null;
  dialogState?: string | null;
  inventoryWatchPending?: Conversation["inventoryWatchPending"] | null;
}): Promise<ConversationStateParse | null> {
  const useLLM =
    process.env.LLM_ENABLED === "1" &&
    process.env.LLM_CONVERSATION_STATE_PARSER_ENABLED !== "0" &&
    !!process.env.OPENAI_API_KEY;
  if (!useLLM) return null;

  const debug = process.env.LLM_CONVERSATION_STATE_PARSER_DEBUG === "1";
  const primaryModel =
    process.env.OPENAI_CONVERSATION_STATE_PARSER_MODEL || process.env.OPENAI_MODEL || "gpt-5-mini";
  const fallbackModel =
    process.env.OPENAI_CONVERSATION_STATE_PARSER_MODEL_FALLBACK ||
    (primaryModel === "gpt-5-mini" ? "gpt-4o-mini" : "");
  const text = String(args.text ?? "").trim();
  if (!text) return null;

  const history = (args.history ?? []).slice(-8).map(h => `${h.direction}: ${h.body}`);
  const lead = args.lead ?? {};
  const catalogHint = buildPartsCatalogParserHint(text);
  const voiceExamples = [
    'input: "Customer: can service quote an LED headlight install?" output: {"state_intent":"service_request","corporate_topic":"none","department_intent":"service","explicit_request":true,"clear_inventory_watch_pending":true,"clear_pricing_need_model":true,"manual_handoff_reason":"service_request","confidence":0.97}',
    'input: "Customer: can parts order drag specialties for me?" output: {"state_intent":"parts_request","corporate_topic":"none","department_intent":"parts","explicit_request":true,"clear_inventory_watch_pending":true,"clear_pricing_need_model":true,"manual_handoff_reason":"parts_request","confidence":0.97}',
    'input: "Customer: can you order a sissy bar for my Low Rider ST?" output: {"state_intent":"parts_request","corporate_topic":"none","department_intent":"parts","explicit_request":true,"clear_inventory_watch_pending":true,"clear_pricing_need_model":true,"manual_handoff_reason":"parts_request","confidence":0.97}',
    'input: "Customer: do you have a modular helmet in XL?" output: {"state_intent":"apparel_request","corporate_topic":"none","department_intent":"apparel","explicit_request":true,"clear_inventory_watch_pending":true,"clear_pricing_need_model":true,"manual_handoff_reason":"apparel_request","confidence":0.97}',
    'input: "Customer: If you get anyone yanking out their 114/117 M-8 to upgrade let me know as I am in the market for one." output: {"state_intent":"parts_request","corporate_topic":"none","department_intent":"parts","explicit_request":true,"clear_inventory_watch_pending":true,"clear_pricing_need_model":true,"manual_handoff_reason":"parts_request","confidence":0.97}',
    'input: "Customer: Who is the hiring manager for American Harley Davidson?" output: {"state_intent":"hiring_manager","corporate_topic":"none","department_intent":"none","explicit_request":true,"clear_inventory_watch_pending":true,"clear_pricing_need_model":true,"manual_handoff_reason":"hiring_manager_inquiry","confidence":0.97}',
    'input: "Customer: I wanted to apply for a job at your dealership. Who should I talk to?" output: {"state_intent":"hiring_manager","corporate_topic":"none","department_intent":"none","explicit_request":true,"clear_inventory_watch_pending":true,"clear_pricing_need_model":true,"manual_handoff_reason":"hiring_manager_inquiry","confidence":0.96}',
    'input: "Customer: Are you hiring?" output: {"state_intent":"hiring_manager","corporate_topic":"none","department_intent":"none","explicit_request":true,"clear_inventory_watch_pending":true,"clear_pricing_need_model":true,"manual_handoff_reason":"hiring_manager_inquiry","confidence":0.96}',
    'input: "Customer: Where do I send a resume?" output: {"state_intent":"hiring_manager","corporate_topic":"none","department_intent":"none","explicit_request":true,"clear_inventory_watch_pending":true,"clear_pricing_need_model":true,"manual_handoff_reason":"hiring_manager_inquiry","confidence":0.96}',
    'input: "Customer: I applied online, who handles that?" output: {"state_intent":"hiring_manager","corporate_topic":"none","department_intent":"none","explicit_request":true,"clear_inventory_watch_pending":true,"clear_pricing_need_model":true,"manual_handoff_reason":"hiring_manager_inquiry","confidence":0.94}',
    'input: "Customer: PreQual: N, PreQualified Amount; $0 Please note non-prequalified customers can still be considered for approval with a completed credit application." output: {"state_intent":"finance_docs","corporate_topic":"none","department_intent":"none","explicit_request":false,"clear_inventory_watch_pending":true,"clear_pricing_need_model":true,"manual_handoff_reason":"credit_app","confidence":0.96}',
    'input: "Customer: can service call me saturday morning around 10?" output: {"state_intent":"service_request","corporate_topic":"none","department_intent":"service","explicit_request":true,"clear_inventory_watch_pending":true,"clear_pricing_need_model":true,"manual_handoff_reason":"service_request","confidence":0.97}',
    'input: "Customer: i need parts for my 572 fl. can someone call me saturday around ten?" output: {"state_intent":"parts_request","corporate_topic":"none","department_intent":"parts","explicit_request":true,"clear_inventory_watch_pending":true,"clear_pricing_need_model":true,"manual_handoff_reason":"parts_request","confidence":0.96}',
    'input: "Customer: keep an eye out for a black road glide and text me when one lands" output: {"state_intent":"inventory_watch","corporate_topic":"none","department_intent":"none","explicit_request":true,"clear_inventory_watch_pending":false,"clear_pricing_need_model":true,"manual_handoff_reason":"none","confidence":0.96}',
    'input: "Customer: I do not want to waste your time. I am looking for a low mileage used one, not new." output: {"state_intent":"used_low_mileage_watch","corporate_topic":"none","department_intent":"none","explicit_request":true,"clear_inventory_watch_pending":false,"clear_pricing_need_model":true,"manual_handoff_reason":"used_low_mileage_watch","confidence":0.96}',
    'input: "Customer: I want a pre owned breakout with low miles, not a new one." output: {"state_intent":"used_low_mileage_watch","corporate_topic":"none","department_intent":"none","explicit_request":true,"clear_inventory_watch_pending":false,"clear_pricing_need_model":true,"manual_handoff_reason":"used_low_mileage_watch","confidence":0.97}',
    'input: "Customer: tuesday around 4 works for me" output: {"state_intent":"scheduling","corporate_topic":"none","department_intent":"none","explicit_request":true,"clear_inventory_watch_pending":true,"clear_pricing_need_model":true,"manual_handoff_reason":"none","confidence":0.94}',
    'input: "Customer: saturday morning works. does 9:30 work for you?" output: {"state_intent":"scheduling","corporate_topic":"none","department_intent":"none","explicit_request":true,"clear_inventory_watch_pending":true,"clear_pricing_need_model":true,"manual_handoff_reason":"none","confidence":0.95}',
    'input: "Customer: how about a tri glide instead. it has to be saturday morning." output: {"state_intent":"scheduling","corporate_topic":"none","department_intent":"none","explicit_request":true,"clear_inventory_watch_pending":true,"clear_pricing_need_model":true,"manual_handoff_reason":"none","confidence":0.95}',
    'input: "Customer: how about a triglycerides instead. let me know about saturday." output: {"state_intent":"scheduling","corporate_topic":"none","department_intent":"none","explicit_request":true,"clear_inventory_watch_pending":true,"clear_pricing_need_model":true,"manual_handoff_reason":"none","confidence":0.93}',
    'input: "Customer: I have to cancel coming to you Tuesday. I am having service done on the bike and inspection. I need to do a few more things before I can sell. I will get back to you." output: {"state_intent":"general","corporate_topic":"none","department_intent":"none","explicit_request":false,"clear_inventory_watch_pending":false,"clear_pricing_need_model":true,"manual_handoff_reason":"none","confidence":0.92}',
    'input: "Customer: we still have to service and detail the bike before delivery" output: {"state_intent":"general","corporate_topic":"none","department_intent":"none","explicit_request":false,"clear_inventory_watch_pending":false,"clear_pricing_need_model":false,"manual_handoff_reason":"none","confidence":0.9}',
    'input: "Customer: i can do 2500 down and want to stay under 500 monthly" output: {"state_intent":"pricing","corporate_topic":"none","department_intent":"none","explicit_request":true,"clear_inventory_watch_pending":true,"clear_pricing_need_model":false,"manual_handoff_reason":"none","confidence":0.95}',
    'input: "Customer: i had a bad experience at another harley dealer and need corporate to step in" output: {"state_intent":"corporate_misroute","corporate_topic":"other_dealer_experience","department_intent":"none","explicit_request":true,"clear_inventory_watch_pending":true,"clear_pricing_need_model":true,"manual_handoff_reason":"none","confidence":0.95}',
    'input: "Customer: hi i just want to let you know about an experience i had at dealership abc" output: {"state_intent":"corporate_misroute","corporate_topic":"other_dealer_experience","department_intent":"none","explicit_request":true,"clear_inventory_watch_pending":true,"clear_pricing_need_model":true,"manual_handoff_reason":"none","confidence":0.92}',
    'input: "Customer: is this bike still under harley factory warranty?" output: {"state_intent":"general","corporate_topic":"none","department_intent":"none","explicit_request":true,"clear_inventory_watch_pending":false,"clear_pricing_need_model":false,"manual_handoff_reason":"none","confidence":0.9}',
    'input: "Customer: ok sounds good thanks" output: {"state_intent":"general","corporate_topic":"none","department_intent":"none","explicit_request":false,"clear_inventory_watch_pending":false,"clear_pricing_need_model":true,"manual_handoff_reason":"none","confidence":0.9}'
  ];
  const prompt = [
    "You parse inbound dealership messages into conversation state transitions.",
    "Return only JSON matching the schema.",
    "",
    "Choose a primary state intent:",
    "- finance_docs: credit app/docs/lien holder/binder/e-sign flow.",
    "- inventory_watch: watch/notify me when available language.",
    "- used_low_mileage_watch: customer is narrowing the search to a used/pre-owned low-mileage bike and explicitly does not want a new one; this should trigger a salesperson handoff to refine or create a watch.",
    "- service_request / parts_request / apparel_request: department handoff intents.",
    "- hiring_manager: customer asks about local dealership hiring, job openings, applying for a job, employment, or the hiring manager at this dealership.",
    "- corporate_misroute: customer clearly intends Harley-Davidson Motor Company or another dealership/corporate process (not this dealership workflow).",
    "- scheduling: appointment timing/day/time selection.",
    "- pricing: pricing/payment/apr/down/term questions.",
    "- general: neutral update or acknowledgement.",
    "- none: unknown.",
    "",
    "Corporate misroute topic rules (only when state_intent=corporate_misroute):",
    "- other_dealer_experience: complaint/escalation about another dealer experience.",
    "- vehicle_documents_or_warranty: asks for HDMC-level vehicle docs/warranty ownership support outside normal dealer workflow.",
    "- investor_or_corporate_culture: investor, stock, corporate culture, headquarters questions.",
    "- internship_or_careers: internship/careers with HDMC corporate.",
    "- international_support: non-US or country-level corporate support requests.",
    "- IMPORTANT: If the customer asks normal dealership sales/service questions (inventory, pricing, test ride, finance, warranty on this bike), do NOT use corporate_misroute.",
    "- IMPORTANT: If the customer asks who handles hiring at this dealership, use state_intent=hiring_manager, not corporate_misroute.",
    "- IMPORTANT: PreQual, prequalified amount, credit app, financing, approval, and HDFS/COA messages are finance_docs, never hiring_manager.",
    "- For corporate-misroute messages, set explicit_request=true even when phrased as a statement (for example: 'just letting you know about another dealership experience').",
    "",
    "Department intent rules:",
    "- service/parts/apparel only when explicitly requested or clearly implied.",
    "- Catalog vocabulary can indicate Parts or MotorClothes/Apparel, but terms alone are not enough. Use the full message context.",
    "- Route catalog accessory terms to parts when the customer asks about availability, price, ordering, fitment, install, or status.",
    "- Route helmet/jacket/glove/boot/clothing/size terms to apparel when the customer asks about availability, size, price, ordering, or status.",
    "",
    "State hygiene rules:",
    "- clear_inventory_watch_pending=true when current message clearly shifts away from watch flow (especially into service/parts/apparel or finance docs).",
    "- clear_pricing_need_model=true when message is not asking pricing anymore and is clearly another workflow.",
    "",
    "manual_handoff_reason rules:",
    "- used_low_mileage_watch when customer is narrowing to a low-mileage used/pre-owned bike and needs salesperson watch refinement or follow-up.",
    "- credit_app for finance docs flow, department-specific values for department flows, else none.",
    "",
    `Current context: ${JSON.stringify({
      followUpMode: args.followUp?.mode ?? null,
      followUpReason: args.followUp?.reason ?? null,
      dialogState: args.dialogState ?? null,
      hasInventoryWatchPending: !!args.inventoryWatchPending,
      leadModel: lead?.vehicle?.model ?? lead?.vehicle?.description ?? null,
      leadYear: lead?.vehicle?.year ?? null,
      leadSource: lead?.source ?? null
    })}`,
    catalogHint || "Catalog vocabulary hint: (none)",
    history.length ? `Recent messages:\n${history.join("\n")}` : "Recent messages: (none)",
    "Voice-style examples:",
    ...voiceExamples,
    `Inbound message: ${text}`
  ].join("\n");

  const runParse = async (model: string): Promise<any | null> =>
    requestStructuredJson({
      model,
      prompt,
      schemaName: "conversation_state_parser",
      schema: CONVERSATION_STATE_PARSER_JSON_SCHEMA,
      maxOutputTokens: 220,
      debugTag: "llm-conversation-state-parser",
      debug
    });

  const parsedPrimary = await runParse(primaryModel);
  const parsed =
    parsedPrimary ??
    (fallbackModel && fallbackModel !== primaryModel ? await runParse(fallbackModel) : null);
  if (!parsed) return null;

  const textLower = text.toLowerCase();
  const hasRequestSignal =
    /\?/.test(text) ||
    /\b(can you|could you|would you|can i|please|need|i need|i want|help|reach out|call me|text me|let me know|quote|how much|order|do you have|schedule)\b/.test(
      textLower
    );
  const serviceCue =
    /\b(service|inspection|oil change|maintenance|repair|service department|service writer|warranty work|headlight|tail ?light|turn signal|led|light bulb|bulb|install|replace|swap|upgrade|detail)\b/.test(
      textLower
    );
  const partsCue =
    /\b(parts? department|parts? counter|parts? desk|parts?\s+order|order (a )?part|need (a )?part|part number|oem parts?|aftermarket parts?|parts? for my|do you (have|carry|stock)\b.{0,28}\bparts?)\b/.test(
      textLower
    ) ||
    (/\b(?:m[\s-]?8|milwaukee[\s-]?eight|114\s*\/\s*117|117\s*\/\s*114)\b/.test(textLower) &&
      /\b(engine|motor|take[-\s]?off|takeout|pull(?:ed|ing)?|yank(?:ed|ing)?|swap(?:ped|ping)?|upgrade)\b/.test(
        textLower
      ));
  const catalogMatch = matchPartsCatalogLexicon(textLower);
  const catalogPartsCue = catalogMatch.partsTerms.length > 0;
  const catalogApparelCue = catalogMatch.apparelTerms.length > 0;
  const catalogDepartmentActionSignal =
    /\b(can you|could you|do you|would you|need|want|looking for|order|get|price|pricing|cost|quote|fit|fits|fitment|install|stock|in stock|available|carry|have|part number|size)\b/.test(
      textLower
    );
  const apparelCue =
    /\b(apparel|merch|merchandise|clothing|jacket|hoodie|t-?shirt|tee shirt|helmet|gloves?|boots?|riding gear|gear)\b/.test(
      textLower
    );
  const financeCue =
    /\b(prequal|pre[-\s]?qualified|credit app|credit application|finance application|approval|hdfs|coa|lien|binder|e-?sign)\b/.test(
      textLower
    );
  const lowMileageUsedCue =
    /\blow\s*mileage\b|\blow\s*miles\b/.test(textLower) &&
    (/\bused\b|\bpre[-\s]?owned\b/.test(textLower) || /\bnot\s+new\b/.test(textLower));
  const hiringCue =
    /\b(hiring manager|hiring|job openings?|jobs?|careers?|career opportunity|employment|apply for (?:a )?(?:job|position)|application for employment|resume)\b/.test(
      textLower
    ) ||
    /\b(?:applied|submitted)\s+(?:online|an application)\b[\s\S]{0,80}\b(?:who|hiring|job|position|resume|manager|handles?)\b/.test(
      textLower
    );
  const explicitServiceRequest = serviceCue && hasRequestSignal;
  const explicitPartsRequest =
    (partsCue && hasRequestSignal) || (catalogPartsCue && catalogDepartmentActionSignal);
  const explicitApparelRequest =
    (apparelCue && hasRequestSignal) || (catalogApparelCue && catalogDepartmentActionSignal);
  const explicitHiringRequest = hiringCue && !financeCue && hasRequestSignal;

  const stateRaw = String(parsed.state_intent ?? "").toLowerCase();
  let stateIntent: ConversationStateParse["stateIntent"] =
    stateRaw === "finance_docs" ||
    stateRaw === "inventory_watch" ||
    stateRaw === "used_low_mileage_watch" ||
    stateRaw === "service_request" ||
    stateRaw === "parts_request" ||
    stateRaw === "apparel_request" ||
    stateRaw === "hiring_manager" ||
    stateRaw === "corporate_misroute" ||
    stateRaw === "scheduling" ||
    stateRaw === "pricing" ||
    stateRaw === "general"
      ? stateRaw
      : "none";
  const corporateTopicRaw = String(parsed.corporate_topic ?? "").toLowerCase();
  const corporateTopic: ConversationStateParse["corporateTopic"] =
    corporateTopicRaw === "other_dealer_experience" ||
    corporateTopicRaw === "vehicle_documents_or_warranty" ||
    corporateTopicRaw === "investor_or_corporate_culture" ||
    corporateTopicRaw === "internship_or_careers" ||
    corporateTopicRaw === "international_support"
      ? corporateTopicRaw
      : "none";
  const deptRaw = String(parsed.department_intent ?? "").toLowerCase();
  let departmentIntent: ConversationStateParse["departmentIntent"] =
    deptRaw === "service" || deptRaw === "parts" || deptRaw === "apparel" ? deptRaw : "none";
  const handoffRaw = String(parsed.manual_handoff_reason ?? "").toLowerCase();
  let manualHandoffReason: ConversationStateParse["manualHandoffReason"] =
    handoffRaw === "credit_app" ||
    handoffRaw === "used_low_mileage_watch" ||
    handoffRaw === "service_request" ||
    handoffRaw === "parts_request" ||
    handoffRaw === "apparel_request" ||
    handoffRaw === "hiring_manager_inquiry"
      ? handoffRaw
      : "none";
  if (departmentIntent === "service" && !explicitServiceRequest) {
    departmentIntent = "none";
  }
  if (departmentIntent === "parts" && !explicitPartsRequest) {
    departmentIntent = "none";
  }
  if (departmentIntent === "apparel" && !explicitApparelRequest) {
    departmentIntent = "none";
  }
  if (manualHandoffReason === "service_request" && !explicitServiceRequest) {
    manualHandoffReason = "none";
  }
  if (manualHandoffReason === "parts_request" && !explicitPartsRequest) {
    manualHandoffReason = "none";
  }
  if (manualHandoffReason === "apparel_request" && !explicitApparelRequest) {
    manualHandoffReason = "none";
  }
  if (manualHandoffReason === "hiring_manager_inquiry" && !explicitHiringRequest) {
    manualHandoffReason = "none";
  }
  if (manualHandoffReason === "used_low_mileage_watch" && !lowMileageUsedCue) {
    manualHandoffReason = "none";
  }
  if (stateIntent === "service_request" && !explicitServiceRequest) {
    stateIntent = "general";
  }
  if (stateIntent === "parts_request" && !explicitPartsRequest) {
    stateIntent = "general";
  }
  if (stateIntent === "apparel_request" && !explicitApparelRequest) {
    stateIntent = "general";
  }
  if (stateIntent === "hiring_manager" && !explicitHiringRequest) {
    stateIntent = financeCue ? "finance_docs" : "general";
  }
  if (stateIntent === "used_low_mileage_watch" && !lowMileageUsedCue) {
    stateIntent = "general";
  }
  if (stateIntent === "general" || stateIntent === "none") {
    if (departmentIntent === "service" && explicitServiceRequest) {
      stateIntent = "service_request";
    } else if (departmentIntent === "parts" && explicitPartsRequest) {
      stateIntent = "parts_request";
    } else if (departmentIntent === "apparel" && explicitApparelRequest) {
      stateIntent = "apparel_request";
    } else if (lowMileageUsedCue) {
      stateIntent = "used_low_mileage_watch";
      manualHandoffReason = "used_low_mileage_watch";
    }
  }
  const confidence =
    typeof parsed.confidence === "number" && Number.isFinite(parsed.confidence)
      ? Math.max(0, Math.min(1, parsed.confidence))
      : undefined;

  return {
    stateIntent,
    corporateTopic,
    departmentIntent,
    explicitRequest: !!parsed.explicit_request,
    clearInventoryWatchPending: !!parsed.clear_inventory_watch_pending,
    clearPricingNeedModel: !!parsed.clear_pricing_need_model,
    manualHandoffReason,
    confidence
  };
}

export async function parseInventoryEntitiesWithLLM(args: {
  text: string;
  history?: { direction: "in" | "out"; body: string }[];
  lead?: Conversation["lead"];
}): Promise<InventoryEntityParse | null> {
  const useLLM =
    process.env.LLM_ENABLED === "1" &&
    process.env.LLM_INVENTORY_ENTITY_PARSER_ENABLED !== "0" &&
    !!process.env.OPENAI_API_KEY;
  if (!useLLM) return null;

  const debug = process.env.LLM_INVENTORY_ENTITY_PARSER_DEBUG === "1";
  const primaryModel =
    process.env.OPENAI_INVENTORY_ENTITY_PARSER_MODEL || process.env.OPENAI_MODEL || "gpt-5-mini";
  const fallbackModel =
    process.env.OPENAI_INVENTORY_ENTITY_PARSER_MODEL_FALLBACK ||
    (primaryModel === "gpt-5-mini" ? "gpt-4o-mini" : "");
  const text = String(args.text ?? "").trim();
  if (!text) return null;

  const history = (args.history ?? []).slice(-6).map(h => `${h.direction}: ${h.body}`);
  const lead = args.lead ?? {};
  const voiceExamples = [
    'input: "Customer: do you have any black street glides in stock?" output: {"target_type":"color_model","is_availability_question":true,"is_test_ride_context":false,"model":"Street Glide","year":0,"year_min":0,"year_max":0,"color":"black","trim":"","stock_id":"","condition":"unknown","min_price":0,"max_price":0,"monthly_budget":0,"down_payment":0,"confidence":0.97}',
    'input: "Customer: looking for a 2026 road glide limited in vivid black" output: {"target_type":"color_model","is_availability_question":true,"is_test_ride_context":false,"model":"Road Glide Limited","year":2026,"year_min":0,"year_max":0,"color":"vivid black","trim":"","stock_id":"","condition":"unknown","min_price":0,"max_price":0,"monthly_budget":0,"down_payment":0,"confidence":0.97}',
    'input: "Customer: Very interested in thw T10-26 street glide !!" output: {"target_type":"stock_id","is_availability_question":true,"is_test_ride_context":false,"model":"Street Glide","year":2026,"year_min":0,"year_max":0,"color":"","trim":"","stock_id":"T10-26","condition":"unknown","min_price":0,"max_price":0,"monthly_budget":0,"down_payment":0,"confidence":0.97}',
    'input: "Customer: do you have the 26 heritage classic in brilliant red?" output: {"target_type":"color_model","is_availability_question":true,"is_test_ride_context":false,"model":"Heritage Classic","year":2026,"year_min":0,"year_max":0,"color":"brilliant red","trim":"","stock_id":"","condition":"unknown","min_price":0,"max_price":0,"monthly_budget":0,"down_payment":0,"confidence":0.97}',
    'input: "Customer: Road King, any Street Glide, OR Large CC Pan America, would be great." output: {"target_type":"alternate_request","is_availability_question":true,"is_test_ride_context":true,"model":"Road King","year":0,"year_min":0,"year_max":0,"color":"","trim":"","stock_id":"","condition":"unknown","min_price":0,"max_price":0,"monthly_budget":0,"down_payment":0,"confidence":0.94}',
    'input: "Customer: Is this available as well? [MMS image attachment]" output: {"target_type":"image_reference","is_availability_question":true,"is_test_ride_context":false,"model":"","year":0,"year_min":0,"year_max":0,"color":"","trim":"","stock_id":"","condition":"unknown","min_price":0,"max_price":0,"monthly_budget":0,"down_payment":0,"confidence":0.94}',
    'input: "Customer: any pre-owned street glides around 13 to 14 thousand?" output: {"target_type":"model_only","is_availability_question":true,"is_test_ride_context":false,"model":"Street Glide","year":0,"year_min":0,"year_max":0,"color":"","trim":"","stock_id":"","condition":"used","min_price":13000,"max_price":14000,"monthly_budget":0,"down_payment":0,"confidence":0.96}',
    'input: "Customer: Ken lives in Silver Creek and is looking at a 2026 Street Glide 3 Limited in Iron Horse with Chrome trim. Trade is a 2015 Tri Glide." output: {"target_type":"color_model","is_availability_question":true,"is_test_ride_context":false,"model":"Street Glide 3 Limited","year":2026,"year_min":0,"year_max":0,"color":"Iron Horse","trim":"Chrome trim","stock_id":"","condition":"unknown","min_price":0,"max_price":0,"monthly_budget":0,"down_payment":0,"confidence":0.94}',
    'input: "Customer: how about a tri glide instead?" output: {"target_type":"alternate_request","is_availability_question":true,"is_test_ride_context":false,"model":"Tri Glide","year":0,"year_min":0,"year_max":0,"color":"","trim":"","stock_id":"","condition":"unknown","min_price":0,"max_price":0,"monthly_budget":0,"down_payment":0,"confidence":0.95}',
    'input: "Customer: how about a triglycerides instead?" output: {"target_type":"alternate_request","is_availability_question":true,"is_test_ride_context":false,"model":"Tri Glide","year":0,"year_min":0,"year_max":0,"color":"","trim":"","stock_id":"","condition":"unknown","min_price":0,"max_price":0,"monthly_budget":0,"down_payment":0,"confidence":0.93}',
    'input: "Customer: if i can stay around 500 a month with 2500 down id do it" output: {"target_type":"none","is_availability_question":false,"is_test_ride_context":false,"model":"","year":0,"year_min":0,"year_max":0,"color":"","trim":"","stock_id":"","condition":"unknown","min_price":0,"max_price":0,"monthly_budget":500,"down_payment":2500,"confidence":0.95}',
    'input: "Customer: anything between 2021 and 2023 under 20k?" output: {"target_type":"generic_inventory","is_availability_question":true,"is_test_ride_context":false,"model":"","year":0,"year_min":2021,"year_max":2023,"color":"","trim":"","stock_id":"","condition":"unknown","min_price":0,"max_price":20000,"monthly_budget":0,"down_payment":0,"confidence":0.94}',
    'input: "Customer: im after a black trim cvo street glide st" output: {"target_type":"color_model","is_availability_question":true,"is_test_ride_context":false,"model":"CVO Street Glide ST","year":0,"year_min":0,"year_max":0,"color":"","trim":"black trim","stock_id":"","condition":"unknown","min_price":0,"max_price":0,"monthly_budget":0,"down_payment":0,"confidence":0.93}',
    'input: "Customer: tuesday at 4 works for me" output: {"target_type":"none","is_availability_question":false,"is_test_ride_context":false,"model":"","year":0,"year_min":0,"year_max":0,"color":"","trim":"","stock_id":"","condition":"unknown","min_price":0,"max_price":0,"monthly_budget":0,"down_payment":0,"confidence":0.92}'
  ];
  const prompt = [
    "You extract structured motorcycle shopping entities from dealership inbound text.",
    "Return only JSON matching the schema.",
    "",
    "Entity rules:",
    "- model: explicit model mention only; else empty string.",
    "- year: single explicit model year if present; else 0.",
    "- year_min/year_max: explicit range if present (e.g. 2021-2023); else 0/0.",
    "- color: explicit color request only; else empty string.",
    "- trim: explicit trim/style/finish token only; else empty string.",
    "- stock_id: explicit stock/unit number or VIN only, preserving dealer format such as T10-26, U570-24, or the VIN text; else empty string.",
    "- condition: explicit new/used/pre-owned request only; use unknown when not explicit.",
    "- min_price/max_price: explicit numeric price range only; else 0.",
    "- monthly_budget/down_payment: explicit numeric monthly/down values only; else 0.",
    "- target_type: stock_id for explicit stock/unit number; vin for explicit VIN; exact_year_model for a specific year/model; color_model for specific model plus color/finish; model_only for model without year/color; alternate_request for alternative choices after a prior option; generic_inventory for broad filters without a model; image_reference for availability questions about an attached image/screenshot; none for no inventory target.",
    "- is_availability_question: true when the customer is asking about availability, options, in-stock status, or expressing inventory interest in a concrete target; false for pure scheduling, thanks, humor, finance-only, or paperwork updates.",
    "- is_test_ride_context: true when the message or recent history indicates the target is for a test ride/demo ride.",
    "- Do not infer values not in the message.",
    "- Use current message as source of truth over prior lead vehicle. Prior lead/history only helps interpret alternates/test-ride context.",
    "- Street Glide 3 Limited is a 2026+ model. Do not return Street Glide 3 Limited with a 2025-or-earlier year.",
    "- Do not treat locations as colors (e.g. Silver Creek is not silver).",
    "- Do not treat trade-in vehicle year/model as the shopping target unless the customer explicitly says they want another one.",
    "- confidence is 0..1.",
    "",
    `Known lead: ${JSON.stringify({
      model: lead?.vehicle?.model ?? lead?.vehicle?.description ?? null,
      year: lead?.vehicle?.year ?? null
    })}`,
    history.length ? `Recent messages:\n${history.join("\n")}` : "Recent messages: (none)",
    "Voice-style examples:",
    ...voiceExamples,
    `Message: ${text}`
  ].join("\n");

  const runParse = async (model: string): Promise<any | null> =>
    requestStructuredJson({
      model,
      prompt,
      schemaName: "inventory_entity_parser",
      schema: INVENTORY_ENTITY_PARSER_JSON_SCHEMA,
      maxOutputTokens: 220,
      debugTag: "llm-inventory-entity-parser",
      debug
    });

  const parsedPrimary = await runParse(primaryModel);
  const parsed =
    parsedPrimary ??
    (fallbackModel && fallbackModel !== primaryModel ? await runParse(fallbackModel) : null);
  if (!parsed) return null;

  const toNum = (v: unknown): number | null => {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) return null;
    return n;
  };
  const toYear = (v: unknown): number | null => {
    const n = Number(v);
    if (!Number.isFinite(n)) return null;
    const yr = Math.trunc(n);
    return yr >= 1900 && yr <= 2100 ? yr : null;
  };
  const confidence =
    typeof parsed.confidence === "number" && Number.isFinite(parsed.confidence)
      ? Math.max(0, Math.min(1, parsed.confidence))
      : undefined;
  const targetTypeRaw = String(parsed.target_type ?? "").trim();
  const validTargetTypes: NonNullable<InventoryEntityParse["targetType"]>[] = [
    "stock_id",
    "vin",
    "exact_year_model",
    "model_only",
    "color_model",
    "alternate_request",
    "generic_inventory",
    "image_reference",
    "none"
  ];
  const stockId = cleanOptionalString(parsed.stock_id);
  const year = toYear(parsed.year) ?? inferModelYearFromStockId(stockId);
  const parsedModel = cleanOptionalString(parsed.model);
  const model =
    year && year < 2026 && /^street glide 3 limited$/i.test(parsedModel ?? "")
      ? "Street Glide"
      : parsedModel;

  return {
    targetType: validTargetTypes.includes(targetTypeRaw as NonNullable<InventoryEntityParse["targetType"]>)
      ? (targetTypeRaw as NonNullable<InventoryEntityParse["targetType"]>)
      : "none",
    isAvailabilityQuestion: !!parsed.is_availability_question,
    isTestRideContext: !!parsed.is_test_ride_context,
    model,
    year,
    yearMin: toYear(parsed.year_min),
    yearMax: toYear(parsed.year_max),
    color: cleanOptionalString(parsed.color),
    trim: cleanOptionalString(parsed.trim),
    stockId,
    condition:
      parsed.condition === "new" || parsed.condition === "used" || parsed.condition === "unknown"
        ? parsed.condition
        : "unknown",
    minPrice: toNum(parsed.min_price),
    maxPrice: toNum(parsed.max_price),
    monthlyBudget: toNum(parsed.monthly_budget),
    downPayment: toNum(parsed.down_payment),
    confidence
  };
}

export async function parseInventoryStatusWithLLM(args: {
  text: string;
  history?: { direction: "in" | "out"; body: string }[];
  lead?: Conversation["lead"];
  hasInboundMedia?: boolean;
}): Promise<InventoryStatusParse | null> {
  const useLLM =
    process.env.LLM_ENABLED === "1" &&
    process.env.LLM_INVENTORY_STATUS_PARSER_ENABLED !== "0" &&
    !!process.env.OPENAI_API_KEY;
  if (!useLLM) return null;

  const debug = process.env.LLM_INVENTORY_STATUS_PARSER_DEBUG === "1";
  const primaryModel =
    process.env.OPENAI_INVENTORY_STATUS_PARSER_MODEL ||
    process.env.OPENAI_INVENTORY_ENTITY_PARSER_MODEL ||
    process.env.OPENAI_MODEL ||
    "gpt-5-mini";
  const fallbackModel =
    process.env.OPENAI_INVENTORY_STATUS_PARSER_MODEL_FALLBACK ||
    (primaryModel === "gpt-5-mini" ? "gpt-4o-mini" : "");
  const text = String(args.text ?? "").trim();
  if (!text) return null;

  const history = (args.history ?? []).slice(-8).map(h => `${h.direction}: ${h.body}`);
  const lead = args.lead ?? {};
  const examples = [
    'input: "Customer: do you have the 26 heritage classic in brilliant red?" output: {"intent":"availability_check","explicit_request":true,"model":"Heritage Classic","year":2026,"year_min":0,"year_max":0,"color":"brilliant red","trim":"","stock_id":"","condition":"unknown","confidence":0.97}',
    'input: "Customer: Very interested in thw T10-26 street glide !!" output: {"intent":"availability_check","explicit_request":true,"model":"Street Glide","year":2026,"year_min":0,"year_max":0,"color":"","trim":"","stock_id":"T10-26","condition":"unknown","confidence":0.97}',
    'input: "Customer: Really? How long is it on hold for" output: {"intent":"hold_status_question","explicit_request":true,"model":"","year":0,"year_min":0,"year_max":0,"color":"","trim":"","stock_id":"","condition":"unknown","confidence":0.96}',
    'input: "Customer: Hi! Do you have any Street Bob coming in." output: {"intent":"incoming_status_question","explicit_request":true,"model":"Street Bob","year":0,"year_min":0,"year_max":0,"color":"","trim":"","stock_id":"","condition":"unknown","confidence":0.96}',
    'input: "Customer: Hey Gio.. is there anything in the back that we looked at that would fit my budget?" output: {"intent":"incoming_status_question","explicit_request":true,"model":"","year":0,"year_min":0,"year_max":0,"color":"","trim":"","stock_id":"","condition":"unknown","confidence":0.96}',
    'input: "Customer: anything not listed online yet around my payment range?" output: {"intent":"incoming_status_question","explicit_request":true,"model":"","year":0,"year_min":0,"year_max":0,"color":"","trim":"","stock_id":"","condition":"unknown","confidence":0.95}',
    'history: "in: did you happen to run those numbers for that bike in the back?" input: "Customer: Can you send me some pics. I wont be able to make it today" output: {"intent":"unlisted_inventory_followup","explicit_request":true,"model":"","year":0,"year_min":0,"year_max":0,"color":"","trim":"","stock_id":"","condition":"unknown","confidence":0.96}',
    'history: "in: is that bike in the back listed yet?" input: "Customer: Did G run numbers on it?" output: {"intent":"unlisted_inventory_followup","explicit_request":true,"model":"","year":0,"year_min":0,"year_max":0,"color":"","trim":"","stock_id":"","condition":"unknown","confidence":0.95}',
    'input: "Customer: how long would it take to get a 2026 nightster in" output: {"intent":"factory_order_eta","explicit_request":true,"model":"Nightster","year":2026,"year_min":0,"year_max":0,"color":"","trim":"","stock_id":"","condition":"unknown","confidence":0.96}',
    'input: "Customer: Do you the sportster or nightster in stock? Or something a bit lighter than the low rider" output: {"intent":"alternate_inventory_request","explicit_request":true,"model":"Sportster","year":0,"year_min":0,"year_max":0,"color":"","trim":"","stock_id":"","condition":"unknown","confidence":0.95}',
    'input: "Customer: Is this available as well? [MMS image attachment]" output: {"intent":"image_availability_check","explicit_request":true,"model":"","year":0,"year_min":0,"year_max":0,"color":"","trim":"","stock_id":"","condition":"unknown","confidence":0.95}',
    'input: "Customer: On my way doing my best to be there by 530" output: {"intent":"none","explicit_request":false,"model":"","year":0,"year_min":0,"year_max":0,"color":"","trim":"","stock_id":"","condition":"unknown","confidence":0.96}',
    'input: "Customer: Perfect." output: {"intent":"none","explicit_request":false,"model":"","year":0,"year_min":0,"year_max":0,"color":"","trim":"","stock_id":"","condition":"unknown","confidence":0.96}'
  ];
  const prompt = [
    "You are an inventory-status router for dealership SMS.",
    "Return only JSON matching the schema.",
    "",
    "Intent rules:",
    "- availability_check: asks if a specific bike/model/stock/color is available or in stock now.",
    "- hold_status_question: asks about a bike already described as on hold, including how long it is on hold.",
    "- incoming_status_question: asks whether a model is coming in, inbound, on order, expected soon, in the back/back room, or not listed/posted online yet.",
    "- factory_order_eta: asks how long it takes to get/order a model from the factory.",
    "- unlisted_inventory_followup: current message asks for photos/pictures/video or numbers/payments on a bike that recent history identifies as in the back/back room or not listed online yet.",
    "- alternate_inventory_request: asks for alternatives or multiple models/options after a prior bike was too big/unavailable.",
    "- image_availability_check: asks if an attached/screenshot bike is available.",
    "- none: no inventory status request.",
    "- explicit_request is true only for a customer ask that should receive an inventory/status answer.",
    "- Extract target fields only when explicit in the customer message; do not infer from history except that hold_status_question may have empty target.",
    "- For unlisted_inventory_followup, use recent history only to determine that 'it/that bike' refers to a back-room or unlisted bike; do not answer from public inventory.",
    "- If hasInboundMedia is true and text says this/that/it available, use image_availability_check.",
    "",
    `Has inbound media: ${args.hasInboundMedia ? "yes" : "no"}`,
    `Known lead: ${JSON.stringify({
      model: lead?.vehicle?.model ?? lead?.vehicle?.description ?? null,
      year: lead?.vehicle?.year ?? null,
      stockId: lead?.vehicle?.stockId ?? null
    })}`,
    history.length ? `Recent messages:\n${history.join("\n")}` : "Recent messages: (none)",
    "Examples:",
    ...examples,
    `Message: ${text}`
  ].join("\n");

  const runParse = async (model: string): Promise<any | null> =>
    requestStructuredJson({
      model,
      prompt,
      schemaName: "inventory_status_parser",
      schema: INVENTORY_STATUS_PARSER_JSON_SCHEMA,
      maxOutputTokens: 220,
      debugTag: "llm-inventory-status-parser",
      debug
    });

  const parsedPrimary = await runParse(primaryModel);
  const parsed =
    parsedPrimary ??
    (fallbackModel && fallbackModel !== primaryModel ? await runParse(fallbackModel) : null);
  if (!parsed) return null;

  const toNum = (v: unknown): number | null => {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) return null;
    return Math.round(n);
  };
  const toYear = (v: unknown): number | null => {
    const n = toNum(v);
    return n && n >= 1900 && n <= 2100 ? n : null;
  };
  const intentRaw = String(parsed.intent ?? "").trim();
  const validIntents: InventoryStatusIntent[] = [
    "availability_check",
    "hold_status_question",
    "incoming_status_question",
    "factory_order_eta",
    "unlisted_inventory_followup",
    "alternate_inventory_request",
    "image_availability_check",
    "none"
  ];
  const intent = validIntents.includes(intentRaw as InventoryStatusIntent)
    ? (intentRaw as InventoryStatusIntent)
    : "none";
  const confidence =
    typeof parsed.confidence === "number" && Number.isFinite(parsed.confidence)
      ? Math.max(0, Math.min(1, parsed.confidence))
      : undefined;
  return {
    intent,
    explicitRequest: !!parsed.explicit_request,
    target: {
      model: cleanOptionalString(parsed.model),
      year: toYear(parsed.year),
      yearMin: toYear(parsed.year_min),
      yearMax: toYear(parsed.year_max),
      color: cleanOptionalString(parsed.color),
      trim: cleanOptionalString(parsed.trim),
      stockId: cleanOptionalString(parsed.stock_id),
      condition:
        parsed.condition === "new" || parsed.condition === "used" || parsed.condition === "unknown"
          ? parsed.condition
          : "unknown",
      confidence
    },
    confidence
  };
}

export async function parseUnifiedSemanticSlotsWithLLM(args: {
  text: string;
  history?: { direction: "in" | "out"; body: string }[];
  lead?: Conversation["lead"];
  inventoryWatch?: Conversation["inventoryWatch"];
  inventoryWatchPending?: Conversation["inventoryWatchPending"];
  tradePayoff?: Conversation["tradePayoff"];
  dialogState?: string;
}): Promise<UnifiedSemanticSlotParse | null> {
  const useLLM =
    process.env.LLM_ENABLED === "1" &&
    process.env.LLM_UNIFIED_SLOT_PARSER_ENABLED === "1" &&
    !!process.env.OPENAI_API_KEY;
  if (!useLLM) return null;

  const [semantic, trade, tradeTarget] = await Promise.all([
    parseSemanticSlotsWithLLM({
      text: args.text,
      history: args.history,
      lead: args.lead,
      inventoryWatch: args.inventoryWatch,
      inventoryWatchPending: args.inventoryWatchPending,
      dialogState: args.dialogState
    }),
    parseTradePayoffWithLLM({
      text: args.text,
      history: args.history,
      lead: args.lead,
      tradePayoff: args.tradePayoff
    }),
    parseTradeTargetValueWithLLM({
      text: args.text,
      history: args.history,
      lead: args.lead
    })
  ]);
  if (!semantic && !trade && !tradeTarget) return null;

  const watchConfidence =
    typeof semantic?.confidence === "number" && Number.isFinite(semantic.confidence)
      ? Math.max(0, Math.min(1, semantic.confidence))
      : undefined;
  const payoffConfidence =
    typeof trade?.confidence === "number" && Number.isFinite(trade.confidence)
      ? Math.max(0, Math.min(1, trade.confidence))
      : undefined;
  const tradeTargetConfidence =
    typeof tradeTarget?.confidence === "number" && Number.isFinite(tradeTarget.confidence)
      ? Math.max(0, Math.min(1, tradeTarget.confidence))
      : undefined;
  const confidenceCandidates = [watchConfidence, payoffConfidence, tradeTargetConfidence].filter(
    (value): value is number => typeof value === "number"
  );
  const confidence = confidenceCandidates.length
    ? Math.min(...confidenceCandidates)
    : undefined;
  const tradeTargetAmount =
    tradeTarget?.hasTargetValue && Number.isFinite(Number(tradeTarget.amount))
      ? Math.round(Number(tradeTarget.amount))
      : null;

  return {
    watchAction: semantic?.watchAction ?? "none",
    watch: semantic?.watch,
    departmentIntent: semantic?.departmentIntent ?? "none",
    contactPreferenceIntent: semantic?.contactPreferenceIntent ?? "none",
    mediaIntent: semantic?.mediaIntent ?? "none",
    serviceRecordsIntent: !!semantic?.serviceRecordsIntent,
    payoffStatus: trade?.payoffStatus ?? "unknown",
    needsLienHolderInfo: !!trade?.needsLienHolderInfo,
    providesLienHolderInfo: !!trade?.providesLienHolderInfo,
    tradeTargetValue: tradeTargetAmount
      ? {
          amount: tradeTargetAmount,
          raw: tradeTarget?.rawText ?? null
        }
      : null,
    watchConfidence,
    payoffConfidence,
    tradeTargetConfidence,
    confidence
  };
}

export async function parseSemanticSlotsWithLLM(args: {
  text: string;
  history?: { direction: "in" | "out"; body: string }[];
  lead?: Conversation["lead"];
  inventoryWatch?: Conversation["inventoryWatch"];
  inventoryWatchPending?: Conversation["inventoryWatchPending"];
  dialogState?: string;
}): Promise<SemanticSlotParse | null> {
  const useLLM =
    process.env.LLM_ENABLED === "1" &&
    (process.env.LLM_SEMANTIC_SLOT_PARSER_ENABLED === "1" ||
      process.env.LLM_UNIFIED_SLOT_PARSER_ENABLED === "1") &&
    !!process.env.OPENAI_API_KEY;
  if (!useLLM) return null;

  const debug = process.env.LLM_SEMANTIC_SLOT_PARSER_DEBUG === "1";
  const primaryModel =
    process.env.OPENAI_SEMANTIC_SLOT_PARSER_MODEL || process.env.OPENAI_MODEL || "gpt-5-mini";
  const fallbackModel =
    process.env.OPENAI_SEMANTIC_SLOT_PARSER_MODEL_FALLBACK ||
    (primaryModel === "gpt-5-mini" ? "gpt-4o-mini" : "");
  const text = String(args.text ?? "").trim();
  if (!text) return null;

  const history = (args.history ?? []).slice(-6).map(h => `${h.direction}: ${h.body}`);
  const lead = args.lead ?? {};
  const watch = args.inventoryWatch ?? null;
  const pending = args.inventoryWatchPending ?? null;
  const dialogState = String(args.dialogState ?? "").trim();
  const voiceExamples = [
    'input: "Customer: keep an eye out for a 2026 road glide 3 in black and text me when one hits" output: {"watch_action":"set_watch","watch":{"model":"Road Glide 3","year":"2026","year_min":0,"year_max":0,"color":"black","condition":"new","min_price":0,"max_price":0,"monthly_budget":0,"down_payment":0},"department_intent":"none","contact_preference_intent":"none","media_intent":"none","service_records_intent":false,"confidence":0.97}',
    'input: "Customer: if a black street glide comes in let me know" output: {"watch_action":"set_watch","watch":{"model":"Street Glide","year":"","year_min":0,"year_max":0,"color":"black","condition":"unknown","min_price":0,"max_price":0,"monthly_budget":0,"down_payment":0},"department_intent":"none","contact_preference_intent":"none","media_intent":"none","service_records_intent":false,"confidence":0.95}',
    'input: "Customer: can you lmk when you get the 23 lrs?" output: {"watch_action":"set_watch","watch":{"model":"Low Rider S","year":"2023","year_min":0,"year_max":0,"color":"","condition":"unknown","min_price":0,"max_price":0,"monthly_budget":0,"down_payment":0},"department_intent":"none","contact_preference_intent":"none","media_intent":"none","service_records_intent":false,"confidence":0.95}',
    'input: "Customer: lmk if you get a 23 lrs in black" output: {"watch_action":"set_watch","watch":{"model":"Low Rider S","year":"2023","year_min":0,"year_max":0,"color":"black","condition":"unknown","min_price":0,"max_price":0,"monthly_budget":0,"down_payment":0},"department_intent":"none","contact_preference_intent":"none","media_intent":"none","service_records_intent":false,"confidence":0.96}',
    'input: "Customer: watch for fxlrs in vivid black" output: {"watch_action":"set_watch","watch":{"model":"Low Rider S","year":"","year_min":0,"year_max":0,"color":"vivid black","condition":"unknown","min_price":0,"max_price":0,"monthly_budget":0,"down_payment":0},"department_intent":"none","contact_preference_intent":"none","media_intent":"none","service_records_intent":false,"confidence":0.96}',
    'input: "Customer: lmk when a 2023 low rider s comes in" output: {"watch_action":"set_watch","watch":{"model":"Low Rider S","year":"2023","year_min":0,"year_max":0,"color":"","condition":"unknown","min_price":0,"max_price":0,"monthly_budget":0,"down_payment":0},"department_intent":"none","contact_preference_intent":"none","media_intent":"none","service_records_intent":false,"confidence":0.96}',
    'input: "Customer: text me if a 2021-2023 street glide in silver comes in between 15k and 20k" output: {"watch_action":"set_watch","watch":{"model":"Street Glide","year":"","year_min":2021,"year_max":2023,"color":"silver","condition":"unknown","min_price":15000,"max_price":20000,"monthly_budget":0,"down_payment":0},"department_intent":"none","contact_preference_intent":"none","media_intent":"none","service_records_intent":false,"confidence":0.96}',
    'input: "Customer: you got any street glides that are used right now? probably thirteen, fourteen maybe. if you wanna jot me down and keep me in mind that would be sweet." output: {"watch_action":"set_watch","watch":{"model":"Street Glide","year":"","year_min":0,"year_max":0,"color":"","condition":"used","min_price":13000,"max_price":14000,"monthly_budget":0,"down_payment":0},"department_intent":"none","contact_preference_intent":"none","media_intent":"none","service_records_intent":false,"confidence":0.96}',
    'input: "Customer: Looking for a pre owned street glide special or road glide special in the $14,000-$16,000 price range. Likes black on black." output: {"watch_action":"set_watch","watch":{"model":"Street Glide Special","year":"","year_min":0,"year_max":0,"color":"black","condition":"used","min_price":14000,"max_price":16000,"monthly_budget":0,"down_payment":0},"department_intent":"none","contact_preference_intent":"none","media_intent":"none","service_records_intent":false,"confidence":0.96}',
    'input: "Customer: if one lands, shoot me a text please" output: {"watch_action":"set_watch","watch":{"model":"","year":"","year_min":0,"year_max":0,"color":"","condition":"unknown","min_price":0,"max_price":0,"monthly_budget":0,"down_payment":0},"department_intent":"none","contact_preference_intent":"none","media_intent":"none","service_records_intent":false,"confidence":0.94}',
    'input: "Customer: do you have any black street glides in stock?" output: {"watch_action":"none","watch":{"model":"Street Glide","year":"","year_min":0,"year_max":0,"color":"black","condition":"unknown","min_price":0,"max_price":0,"monthly_budget":0,"down_payment":0},"department_intent":"none","contact_preference_intent":"none","media_intent":"none","service_records_intent":false,"confidence":0.95}',
    'input: "Customer: do you have brake pads in stock for my 2018 street glide?" output: {"watch_action":"none","watch":{"model":"Street Glide","year":"2018","year_min":0,"year_max":0,"color":"","condition":"unknown","min_price":0,"max_price":0,"monthly_budget":0,"down_payment":0},"department_intent":"parts","contact_preference_intent":"none","media_intent":"none","service_records_intent":false,"confidence":0.97}',
    'input: "Customer: If you get anyone yanking out their 114/117 M-8 to upgrade let me know as I am in the market for one." output: {"watch_action":"none","watch":{"model":"","year":"","year_min":0,"year_max":0,"color":"","condition":"unknown","min_price":0,"max_price":0,"monthly_budget":0,"down_payment":0},"department_intent":"parts","contact_preference_intent":"none","media_intent":"none","service_records_intent":false,"confidence":0.97}',
    'input: "Customer: stop the watch alerts for the road glide please" output: {"watch_action":"stop_watch","watch":{"model":"Road Glide","year":"","year_min":0,"year_max":0,"color":"","condition":"unknown","min_price":0,"max_price":0,"monthly_budget":0,"down_payment":0},"department_intent":"none","contact_preference_intent":"none","media_intent":"none","service_records_intent":false,"confidence":0.96}',
    'input: "Customer: I found one already, stop looking for me." output: {"watch_action":"stop_watch","watch":{"model":"","year":"","year_min":0,"year_max":0,"color":"","condition":"unknown","min_price":0,"max_price":0,"monthly_budget":0,"down_payment":0},"department_intent":"none","contact_preference_intent":"none","media_intent":"none","service_records_intent":false,"confidence":0.95}',
    'input: "Customer: Thanks Joe. I am all set on the bike search for now. I will reach out when I am looking again." output: {"watch_action":"stop_watch","watch":{"model":"","year":"","year_min":0,"year_max":0,"color":"","condition":"unknown","min_price":0,"max_price":0,"monthly_budget":0,"down_payment":0},"department_intent":"none","contact_preference_intent":"none","media_intent":"none","service_records_intent":false,"confidence":0.96}',
    'input: "Customer: I am all set on the bike search for the time being. I appreciate your help and will reach out later." output: {"watch_action":"stop_watch","watch":{"model":"","year":"","year_min":0,"year_max":0,"color":"","condition":"unknown","min_price":0,"max_price":0,"monthly_budget":0,"down_payment":0},"department_intent":"none","contact_preference_intent":"none","media_intent":"none","service_records_intent":false,"confidence":0.96}',
    'input: "Customer: left a 1000 deposit and I am coming in saturday to finalize" output: {"watch_action":"none","watch":{"model":"","year":"","year_min":0,"year_max":0,"color":"","condition":"unknown","min_price":0,"max_price":0,"monthly_budget":0,"down_payment":0},"department_intent":"none","contact_preference_intent":"none","media_intent":"none","service_records_intent":false,"confidence":0.94}',
    'input: "Customer: can service quote an LED headlight install?" output: {"watch_action":"none","watch":{"model":"","year":"","year_min":0,"year_max":0,"color":"","condition":"unknown","min_price":0,"max_price":0,"monthly_budget":0,"down_payment":0},"department_intent":"service","contact_preference_intent":"none","media_intent":"none","service_records_intent":false,"confidence":0.97}',
    'input: "Customer: I have to cancel coming to you Tuesday. I am having service done on the bike and inspection. I need to do a few more things before I can sell. I will get back to you." output: {"watch_action":"none","watch":{"model":"","year":"","year_min":0,"year_max":0,"color":"","condition":"unknown","min_price":0,"max_price":0,"monthly_budget":0,"down_payment":0},"department_intent":"none","contact_preference_intent":"none","media_intent":"none","service_records_intent":false,"confidence":0.94}',
    'input: "Customer: can you send a walkaround video?" output: {"watch_action":"none","watch":{"model":"","year":"","year_min":0,"year_max":0,"color":"","condition":"unknown","min_price":0,"max_price":0,"monthly_budget":0,"down_payment":0},"department_intent":"none","contact_preference_intent":"none","media_intent":"video","service_records_intent":false,"confidence":0.95}',
    'input: "Customer: 11am can you send photos of street glide limited" output: {"watch_action":"none","watch":{"model":"Street Glide Limited","year":"","year_min":0,"year_max":0,"color":"","condition":"unknown","min_price":0,"max_price":0,"monthly_budget":0,"down_payment":0},"department_intent":"none","contact_preference_intent":"none","media_intent":"photos","service_records_intent":false,"confidence":0.95}',
    'input: "Customer: never mind photo. test ride street glide limited 3. thanks" output: {"watch_action":"none","watch":{"model":"Street Glide 3 Limited","year":"","year_min":0,"year_max":0,"color":"","condition":"unknown","min_price":0,"max_price":0,"monthly_budget":0,"down_payment":0},"department_intent":"none","contact_preference_intent":"none","media_intent":"none","service_records_intent":false,"confidence":0.95}',
    'input: "Customer: let me know if you guys have a demo day like Kawasaki" output: {"watch_action":"none","watch":{"model":"","year":"","year_min":0,"year_max":0,"color":"","condition":"unknown","min_price":0,"max_price":0,"monthly_budget":0,"down_payment":0},"department_intent":"none","contact_preference_intent":"none","media_intent":"none","service_records_intent":false,"confidence":0.96}',
    'input: "Customer: do you guys have demo days?" output: {"watch_action":"none","watch":{"model":"","year":"","year_min":0,"year_max":0,"color":"","condition":"unknown","min_price":0,"max_price":0,"monthly_budget":0,"down_payment":0},"department_intent":"none","contact_preference_intent":"none","media_intent":"none","service_records_intent":false,"confidence":0.96}',
    'input: "Customer: can I get a call instead of texts?" output: {"watch_action":"none","watch":{"model":"","year":"","year_min":0,"year_max":0,"color":"","condition":"unknown","min_price":0,"max_price":0,"monthly_budget":0,"down_payment":0},"department_intent":"none","contact_preference_intent":"call_only","media_intent":"none","service_records_intent":false,"confidence":0.93}',
    'input: "Customer: do you have service records on that bike?" output: {"watch_action":"none","watch":{"model":"","year":"","year_min":0,"year_max":0,"color":"","condition":"unknown","min_price":0,"max_price":0,"monthly_budget":0,"down_payment":0},"department_intent":"none","contact_preference_intent":"none","media_intent":"none","service_records_intent":true,"confidence":0.94}'
  ];
  const prompt = [
    "You are a semantic slot parser for dealership SMS.",
    "Return only JSON that matches the provided schema.",
    "",
    "Extract only these slots:",
    "- watch_action: set_watch / stop_watch / none",
    "- watch: model/year/year_min/year_max/color/condition/min_price/max_price/monthly_budget/down_payment if explicitly present",
    "- department_intent: service / parts / apparel / none",
    "- contact_preference_intent: call_only / none",
    "- media_intent: video / photos / either / none",
    "- service_records_intent: true/false",
    "",
    "Rules:",
    "- watch_action=set_watch only when the customer asks to be notified/updated if inventory comes in or becomes available.",
    "- Treat shorthand as valid intent/model cues (e.g., 'lmk' = let me know, 'lrs'/'fxlrs' = Low Rider S).",
    "- Phrases like 'if one lands', 'if one comes in', 'when one lands', or 'shoot me a text' are set_watch when recent history, lead vehicle, existing watch, or pending watch provides the model context.",
    "- Explicit 'watch for fxlrs/lrs' is set_watch and should normalize the model to Low Rider S.",
    "- watch_action=stop_watch only when customer asks to stop those watch alerts/updates (not global STOP opt-out unless watch context is explicit).",
    "- Phrases like 'found one already, stop looking' mean stop_watch.",
    "- In an existing watch context, phrases like 'all set on the bike search', 'set for the time being', or 'I will reach out when I am looking again' mean stop_watch.",
    "- watch_action=none for general inventory questions without watch request.",
    "- Never set watch_action from standalone time tokens or media requests. For 'send photos/video' requests, keep watch_action=none and set media_intent accordingly.",
    "- department_intent=service/parts/apparel only when customer explicitly requests that department/category help.",
    "- department_intent=parts for parts/part-number/OEM/brake pads/tires/accessory fitment questions, even if the text says 'in stock' and includes a bike model.",
    "- department_intent=parts for engine/motor sourcing requests, including take-off Milwaukee-Eight / M-8 114 or 117 engines from customer upgrades.",
    "- department_intent=service for install/repair price questions like headlight bulb to LED, light replacement, wiring/fitment labor.",
    "- Use department_intent=none for general sales messages.",
    "- contact_preference_intent=call_only only when customer explicitly asks for calls only / no texts.",
    "- media_intent=video/photos/either only when the customer explicitly asks for media (walkaround, pics, photos, video).",
    "- service_records_intent=true only when customer explicitly asks for service/maintenance records/history, battery/tires condition history, or similar records-check request.",
    "- watch.model should be normalized human model text when possible; else empty string.",
    "- watch.year should be empty string unless explicitly provided.",
    "- watch.year_min/year_max are only for explicit year ranges like 2021-2023 or 2021 to 2023; otherwise 0.",
    "- watch.color should be empty string unless explicitly provided.",
    "- watch.condition should be one of new/used/any/unknown.",
    "- min_price/max_price are explicit bike-price constraints only; parse k/grand as thousands; otherwise 0.",
    "- monthly_budget/down_payment are explicit monthly/down values only; otherwise 0.",
    "- confidence is 0..1.",
    "",
    `Lead vehicle: ${JSON.stringify({
      year: lead?.vehicle?.year ?? null,
      model: lead?.vehicle?.model ?? lead?.vehicle?.description ?? null,
      color: lead?.vehicle?.color ?? null,
      condition: lead?.vehicle?.condition ?? null
    })}`,
    `Existing watch: ${JSON.stringify(watch ?? {})}`,
    `Pending watch: ${JSON.stringify(pending ?? {})}`,
    `Dialog state: ${dialogState || "none"}`,
    history.length ? `Recent messages:\n${history.join("\n")}` : "Recent messages: (none)",
    "Voice-style examples:",
    ...voiceExamples,
    `Message: ${text}`
  ].join("\n");

  const runParse = async (model: string): Promise<any | null> => {
    return requestStructuredJson({
      model,
      prompt,
      schemaName: "semantic_slot_parser",
      schema: SEMANTIC_SLOT_PARSER_JSON_SCHEMA,
      maxOutputTokens: 200,
      debugTag: "llm-semantic-slot-parser",
      debug
    });
  };

  const parsedPrimary = await runParse(primaryModel);
  const parsed =
    parsedPrimary ??
    (fallbackModel && fallbackModel !== primaryModel ? await runParse(fallbackModel) : null);
  if (!parsed) return null;

  const textLower = text.toLowerCase();
  const watchActionRaw = String(parsed.watch_action ?? "").toLowerCase();
  let watchAction: SemanticSlotParse["watchAction"] =
    watchActionRaw === "set_watch" || watchActionRaw === "stop_watch" ? watchActionRaw : "none";

  const deptRaw = String(parsed.department_intent ?? "").toLowerCase();
  let departmentIntent: SemanticSlotParse["departmentIntent"] =
    deptRaw === "service" || deptRaw === "parts" || deptRaw === "apparel" ? deptRaw : "none";
  const contactPrefRaw = String(parsed.contact_preference_intent ?? "").toLowerCase();
  let contactPreferenceIntent: SemanticSlotParse["contactPreferenceIntent"] =
    contactPrefRaw === "call_only" ? "call_only" : "none";
  const mediaRaw = String(parsed.media_intent ?? "").toLowerCase();
  let mediaIntent: SemanticSlotParse["mediaIntent"] =
    mediaRaw === "video" || mediaRaw === "photos" || mediaRaw === "either" ? mediaRaw : "none";
  let serviceRecordsIntent = !!parsed.service_records_intent;

  const watchObj = parsed.watch && typeof parsed.watch === "object" ? parsed.watch : {};
  let model = cleanOptionalString(watchObj.model);
  const year = cleanOptionalString(watchObj.year);
  const toPositiveNum = (value: unknown): number | null => {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return null;
    return Math.round(n);
  };
  const color = cleanOptionalString(watchObj.color);
  const conditionRaw = String(watchObj.condition ?? "").toLowerCase();
  const condition: NonNullable<SemanticSlotParse["watch"]>["condition"] =
    conditionRaw === "new" || conditionRaw === "used" || conditionRaw === "any"
      ? conditionRaw
      : "unknown";

  // Guard against risky false positives.
  const hasWatchSetCue =
    !isDemoDayEventQuestionText(text) &&
    ((/\b(lmk|let me know|keep me posted|keep an eye out|watch for|notify me|text me|shoot me (a )?text|send (one|it) my way)\b/.test(
        textLower
      ) &&
        /\b(if|when|once|as soon as|get|got|comes? in|lands?|in stock|available)\b/.test(textLower)) ||
      /\bwatch for\b/.test(textLower) ||
      (/\b(jot me down|mark it down|write me down|keep me in mind)\b/.test(textLower) &&
        /\b(used|pre[- ]?owned|street glide|road glide|low rider|sportster|softail|inventory|comes? in|price range|spend)\b/.test(
          textLower
        )));
  const hasWatchStopAction =
    /\b(stop|cancel|remove|delete|turn off|pause|disable|end|no more|don't|dont|do not)\b/.test(
      textLower
    );
  const hasWatchStopContext =
    /\b(watch|alerts?|updates?|notifications?|inventory|availability|looking)\b/.test(textLower) ||
    /\b(bike search|all set|set for (the )?time being|looking again|reach out when)\b/.test(textLower) ||
    /\b(keep(?:ing)? an eye out|watch for|notify me|text me)\b/.test(textLower) ||
    /\bfound one already\b/.test(textLower) ||
    /\b(if|when|once|as soon as)\b[\s\w-]{0,28}\b(comes in|in stock|available|lands)\b/.test(
      textLower
    );
  const hasWatchStopCue = hasWatchStopAction && hasWatchStopContext;
  if (watchAction === "none" && hasWatchSetCue) {
    watchAction = "set_watch";
  }
  if (watchAction === "set_watch" && !hasWatchSetCue && !watch && !pending) {
    watchAction = "none";
  }
  if (watchAction === "none" && hasWatchStopCue) {
    watchAction = "stop_watch";
  }
  if (watchAction === "stop_watch" && !hasWatchStopCue && !watch && !pending) {
    watchAction = "none";
  }

  const hasServiceCue =
    /\b(service|inspection|oil change|maintenance|repair|service department|service writer|warranty|headlight|tail ?light|turn signal|led|light bulb|bulb|install|replace|swap|upgrade)\b/.test(
      textLower
    );
  const serviceContextOnlyCue =
    /\b(cancel|can't come|cannot come|won't make|will not make|have to reschedule)\b/.test(textLower) &&
    /\b(service done|having service done|inspection)\b/.test(textLower) &&
    /\b(before i can sell|before selling|i'll get back|i will get back|let you know)\b/.test(textLower);
  const semanticCatalogMatch = matchPartsCatalogLexicon(textLower);
  const semanticCatalogDepartmentActionSignal =
    /\b(can you|could you|do you|would you|need|want|looking for|order|get|price|pricing|cost|quote|fit|fits|fitment|install|stock|in stock|available|carry|have|part number|size)\b/.test(
      textLower
    );
  const hasPartsCue =
    /\b(parts? department|parts? counter|parts? desk|order (a )?part|need (a )?part|part number|oem parts?|aftermarket parts?|brake pads?|tires?|accessory fitment|fitment)\b/.test(
      textLower
    ) ||
    (/\b(?:m[\s-]?8|milwaukee[\s-]?eight|114\s*\/\s*117|117\s*\/\s*114)\b/.test(textLower) &&
      /\b(engine|motor|take[-\s]?off|takeout|pull(?:ed|ing)?|yank(?:ed|ing)?|swap(?:ped|ping)?|upgrade)\b/.test(
        textLower
      )) ||
    (semanticCatalogMatch.partsTerms.length > 0 && semanticCatalogDepartmentActionSignal);
  const hasApparelCue =
    /\b(apparel|merch|merchandise|clothing|jacket|hoodie|t-?shirt|helmet|gloves?|boots?|riding gear|gear)\b/.test(
      textLower
    ) || (semanticCatalogMatch.apparelTerms.length > 0 && semanticCatalogDepartmentActionSignal);
  if (departmentIntent === "service" && !hasServiceCue) departmentIntent = "none";
  if (departmentIntent === "service" && serviceContextOnlyCue) departmentIntent = "none";
  if (departmentIntent === "parts" && !hasPartsCue) departmentIntent = "none";
  if (departmentIntent === "apparel" && !hasApparelCue) departmentIntent = "none";
  if (departmentIntent === "none" && hasPartsCue) departmentIntent = "parts";
  if (departmentIntent === "none" && hasServiceCue && !serviceContextOnlyCue) departmentIntent = "service";
  if (departmentIntent === "none" && hasApparelCue) departmentIntent = "apparel";
  if (watchAction === "set_watch" && !model) {
    const historyText = history.join("\n").toLowerCase();
    const contextText = `${historyText}\n${lead?.vehicle?.model ?? ""}\n${lead?.vehicle?.description ?? ""}`;
    if (/\broad glide\b/.test(contextText)) model = "Road Glide";
    else if (/\bstreet glide\b/.test(contextText)) model = "Street Glide";
    else if (/\blow rider s\b|\bfxlrs\b|\blrs\b/.test(contextText)) model = "Low Rider S";
    else if (/\biron 883\b|\b883\b/.test(contextText)) model = "Iron 883";
  }
  const hasCallOnlyCue =
    /\b(call only|phone only|call me only|no text|do not text|don't text|text me not)\b/.test(textLower);
  if (contactPreferenceIntent === "call_only" && !hasCallOnlyCue) {
    contactPreferenceIntent = "none";
  }
  const hasVideoCue =
    /\b(video|walkaround|walk around|walk-through|walkthrough|clip)\b/.test(textLower);
  const hasPhotoCue = /\b(photo|photos|pic|pics|images?)\b/.test(textLower);
  const hasMediaCue = hasVideoCue || hasPhotoCue;
  if (mediaIntent === "video" && !hasVideoCue) mediaIntent = "none";
  if (mediaIntent === "photos" && !hasPhotoCue) mediaIntent = "none";
  if (mediaIntent === "either" && !hasMediaCue) mediaIntent = "none";
  const hasServiceRecordsCue =
    /(service records?|service history|maintenance records?|maintenance history)/.test(textLower) ||
    /\b(battery|tires?|tire age)\b/.test(textLower);
  if (serviceRecordsIntent && !hasServiceRecordsCue) {
    serviceRecordsIntent = false;
  }

  const confidence =
    typeof parsed.confidence === "number" && Number.isFinite(parsed.confidence)
      ? Math.max(0, Math.min(1, parsed.confidence))
      : undefined;

  return {
    watchAction,
    watch: {
      model,
      year,
      yearMin: toPositiveNum(watchObj.year_min),
      yearMax: toPositiveNum(watchObj.year_max),
      color,
      condition,
      minPrice: toPositiveNum(watchObj.min_price),
      maxPrice: toPositiveNum(watchObj.max_price),
      monthlyBudget: toPositiveNum(watchObj.monthly_budget),
      downPayment: toPositiveNum(watchObj.down_payment)
    },
    departmentIntent,
    contactPreferenceIntent,
    mediaIntent,
    serviceRecordsIntent,
    confidence
  };
}

export async function summarizeVoiceTranscriptWithLLM(args: {
  transcript: string;
  lead?: Conversation["lead"];
}): Promise<string | null> {
  const buildFallbackSummary = (transcriptRaw: string, lead?: Conversation["lead"]): string | null => {
    const lines = String(transcriptRaw ?? "")
      .split(/\n+/)
      .map(s => s.trim())
      .filter(Boolean);
    if (!lines.length) return null;

    const stripSpeaker = (line: string) =>
      line
        .replace(
          /^(customer|agent|speaker\s*\d+|[A-Za-z][A-Za-z .'-]{1,40}):\s*/i,
          ""
        )
        .trim();
    const compact = (text: string, max = 180) => {
      const cleaned = text.replace(/\s+/g, " ").trim();
      if (cleaned.length <= max) return cleaned;
      return `${cleaned.slice(0, max - 1).trimEnd()}…`;
    };

    const customerLines = lines
      .filter(line => /^customer:/i.test(line))
      .map(stripSpeaker)
      .filter(Boolean);
    const allLines = lines.map(stripSpeaker).filter(Boolean);
    const topicLine =
      customerLines.find(line => line.length >= 18) ||
      allLines.find(line => line.length >= 18) ||
      "";

    const textLower = String(transcriptRaw ?? "").toLowerCase();
    const weekdayOrTimeMention =
      /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|today)\b/i.test(textLower) ||
      /\b\d{1,2}(:\d{2})?\s?(am|pm)\b/i.test(textLower);
    const scheduleIntent =
      weekdayOrTimeMention &&
      /\b(come in|stop by|available|works|work(s)? for you|see you|saturday morning)\b/i.test(textLower);
    const wrongDealerIntent =
      /\b(wrong dealership|wrong dealer|mistake|accidentally|out of area|new mexico|different state)\b/i.test(
        textLower
      );

    if (wrongDealerIntent) {
      return "Customer said this inquiry was for a different/out-of-area dealership and is not moving forward with this store.";
    }
    if (scheduleIntent) {
      return "Customer discussed bike options and indicated a plan to come in; confirm the exact visit time and next steps.";
    }

    const leadModel =
      String(lead?.vehicle?.model ?? lead?.vehicle?.description ?? "")
        .replace(/\s+/g, " ")
        .trim() || "the bike";
    if (topicLine) {
      return `Customer discussed ${leadModel}: ${compact(topicLine)}.`;
    }
    return `Customer and salesperson discussed ${leadModel} and next steps.`;
  };

  const voiceSummarizerEnabledRaw = String(
    process.env.LLM_VOICE_SUMMARIZER_ENABLED ?? "1"
  ).trim();
  const voiceSummarizerEnabled =
    voiceSummarizerEnabledRaw !== "0" &&
    !/^(false|off|no)$/i.test(voiceSummarizerEnabledRaw);
  const useLLM =
    process.env.LLM_ENABLED === "1" &&
    voiceSummarizerEnabled &&
    !!process.env.OPENAI_API_KEY;

  const raw = String(args.transcript ?? "").trim();
  if (!raw) return null;
  if (!useLLM) return buildFallbackSummary(raw, args.lead);

  const model =
    process.env.OPENAI_VOICE_SUMMARIZER_MODEL ||
    process.env.OPENAI_MODEL ||
    "gpt-4o-mini";

  const clipped = raw.length > 4000 ? raw.slice(-4000) : raw;
  const lead = args.lead ?? {};

  const instructions = `
Summarize the phone call transcript for internal sales context.
- 2–3 sentences max.
- Focus on what the customer wants and key constraints (model/year/trim/color, timing, pricing, trade, test ride, callback).
- Include any clear next action or commitment.
- Use ONLY facts stated in the transcript.
- Do NOT invent or infer details (no guesswork).
- Do NOT convert spoken numbers into different values (e.g., "ninety five" must not become "2025").
- If a number or amount is unclear/ambiguous, omit it.
- Only say "callback" if the customer explicitly asked for a callback.
- Only say "scheduled/booked" if a specific time was clearly agreed to.
- Do NOT mention that this is a summary.
Return only the summary text.
`.trim();

  const input = `
Known lead info (may help resolve model names):
${JSON.stringify(
    {
      model: lead?.vehicle?.model ?? lead?.vehicle?.description ?? null,
      year: lead?.vehicle?.year ?? null,
      color: lead?.vehicle?.color ?? null,
      stockId: lead?.vehicle?.stockId ?? null
    },
    null,
    2
  )}

Transcript:
${clipped}
`.trim();

  const stripUnknownYears = (summary: string, transcriptText: string) => {
    const transcriptYears = new Set<string>();
    const yearRe = /\b(19|20)\d{2}\b/g;
    let match: RegExpExecArray | null;
    while ((match = yearRe.exec(transcriptText)) !== null) {
      transcriptYears.add(match[0]);
    }
    const cleaned = summary.replace(yearRe, value =>
      transcriptYears.size > 0 && transcriptYears.has(value) ? value : ""
    );
    return cleaned
      .replace(/\s{2,}/g, " ")
      .replace(/\s+([,.;:])/g, "$1")
      .trim();
  };

  try {
    const resp = await client.responses.create({
      model,
      instructions,
      input,
      ...optionalCreateTextConfig(model),
      ...optionalTemperature(model, 0),
      max_output_tokens: 180
    });
    recordOpenAIUsage(resp, {
      feature: "llm_summary",
      operation: "voice_call_transcript",
      requestKind: "responses.create",
      model
    });
    const out = resp.output_text?.trim() ?? "";
    const cleaned = stripUnknownYears(out, raw);
    return cleaned || buildFallbackSummary(raw, args.lead);
  } catch {
    return buildFallbackSummary(raw, args.lead);
  }
}

export async function summarizeConversationMemoryWithLLM(args: {
  existingSummary?: string | null;
  lead?: Conversation["lead"] | null;
  appointment?: any;
  followUp?: any;
  hold?: Conversation["hold"] | null;
  sale?: Conversation["sale"] | null;
  inventoryWatch?: Conversation["inventoryWatch"] | null;
  inventoryWatches?: Conversation["inventoryWatches"] | null;
  history: { direction: "in" | "out"; body: string }[];
}): Promise<string | null> {
  const useLLM = process.env.LLM_ENABLED === "1" && !!process.env.OPENAI_API_KEY;
  if (!useLLM) return null;
  const model = process.env.OPENAI_MODEL || "gpt-5-mini";
  const history = args.history ?? [];
  if (history.length < 2) return null;

  const instructions = `
Summarize this conversation for internal memory.
- Output 4–6 short lines, each "Label: value".
- Use ONLY facts from the provided data.
- If a field is unknown or unclear, omit that line.
- Do NOT invent dates, numbers, or names.
- Do NOT mention this is a summary.
- Keep it concise.

Preferred labels:
- Intent
- Vehicle
- Trade-in
- Timing
- Preferences
- Status

Status should mention watch/hold/sold/appointment only if clearly present.
`.trim();

  const input = `
Existing memory (if any):
${args.existingSummary ?? "none"}

Lead info:
${JSON.stringify(args.lead ?? {}, null, 2)}

Appointment:
${JSON.stringify(args.appointment ?? {}, null, 2)}

Follow-up:
${JSON.stringify(args.followUp ?? {}, null, 2)}

Hold:
${JSON.stringify(args.hold ?? null, null, 2)}

Sale:
${JSON.stringify(args.sale ?? null, null, 2)}

Inventory watch:
${JSON.stringify(args.inventoryWatches ?? args.inventoryWatch ?? null, null, 2)}

Recent history:
${history.map(h => `${h.direction.toUpperCase()}: ${h.body}`).join("\n")}
`.trim();

  try {
    const resp = await client.responses.create({
      model,
      instructions,
      input,
      ...optionalCreateTextConfig(model),
      ...optionalTemperature(model, 0),
      max_output_tokens: 220
    });
    recordOpenAIUsage(resp, {
      feature: "llm_summary",
      operation: "conversation_memory",
      requestKind: "responses.create",
      model,
      leadRef: args.lead?.leadRef ?? null
    });
    const out = resp.output_text?.trim() ?? "";
    return out || null;
  } catch {
    return null;
  }
}

export async function generateDraftWithLLM(ctx: DraftContext): Promise<string> {
  const model = process.env.OPENAI_MODEL || "gpt-5-mini";
  const manualIntentHint = inferManualIntentHintFromDraftContext(ctx);
  const manualReplyExamplesBlock = buildManualReplyExamplesPromptBlock(manualIntentHint);

  const isEmail = ctx.channel === "email";
  const channelRules = isEmail
    ? `
EMAIL RULES (strict):
- 4–6 sentences. Warm, professional, complete sentences.
- No emojis. No bullet lists.
- Do NOT include a signature; the system will append it.
- If dealerProfile.bookingUrl exists, include exactly: "You can book an appointment here: <bookingUrl>".
- If not first outbound, do NOT repeat the intro.
`
    : `
SMS RULES (strict):
- 1–3 short paragraphs (1–5 sentences). Natural SMS tone.
- No signatures.
- If not first outbound, do NOT repeat the intro.
- Do NOT offer appointment times unless the customer explicitly asks to schedule or stop in.
- Do NOT mention email unless the customer explicitly asked to email.
- If the customer says "later/next month/next year/I’ll let you know", acknowledge and say you’re here when they’re ready. Do NOT ask to set reminders.
- If the customer asks for a phone call today/now and dealerClosedToday is true, say we’re closed today and someone will call tomorrow. Do NOT offer appointment times.
- If the customer asks for a phone call today/now and dealerClosedToday is false, acknowledge and confirm someone can call today.
`;

  const instructions = `
You write dealership sales replies for a Harley-Davidson dealership.

VOICE / STYLE (strict):
- Friendly, professional, concise.
- Sound like a real dealership rep: warm, confident, low‑pressure.
- Use "I" language (not "we") unless dealerProfile.voice explicitly says otherwise.
- Do NOT use the customer’s last name.
- Write at about a 7th–8th grade reading level.
- Keep sentences short (aim under ~18 words).
- Avoid jargon and long, complex clauses.
- Use light, natural acknowledgments (e.g., "Gotcha", "Totally fair", "That makes sense") when appropriate.
- If the customer sounds frustrated or confused, add one short empathy line ("I get that" / "I know that's frustrating") and move on.
${channelRules}

CONTROLLED VARIATIONS (use these to sound human):
- Use ONE variant per response section. Do not repeat the same variant if it already appeared in the thread.
- Prefer natural contractions (I'm, you're, that's).
- Keep variations subtle; do not invent new phrases beyond the lists below.

SMS VARIATIONS:
- Intro (first outbound only):
  1) "Hi {firstName} — thanks for your inquiry. This is {agentName} at {dealerName}."
  2) "Hi {firstName} — this is {agentName} at {dealerName}. Thanks for reaching out."
  3) "Hi {firstName} — thanks for checking in. This is {agentName} at {dealerName}."
- Acknowledge:
  1) "Got it."
  2) "Thanks for the details."
  3) "Understood."
- Offer scheduling (only if they asked to schedule):
  1) "I can set up a time to stop in."
  2) "I can get you on the calendar."
  3) "I can line up a time to come by."
- Two-time close (when offering two options):
  1) "Do any of these times work?"
  2) "Which works best?"
- Reminder offer (when they say later / next month / I’ll let you know):
  1) "No rush — I’m here when you’re ready. Just reach out when the time is right."
  2) "Totally fine. I’ll be here when you’re ready — just reach out when you’re ready to move forward."
- Soft scheduling when timing is uncertain (only if they asked to schedule):
  1) "I can pencil you in and we can adjust if needed."
  2) "If you want, I can hold a time and we can move it if needed."
- If asked “Are you AI?” (or similar), respond briefly and move forward:
  1) "Nope—real person here at the dealership. I handle online inquiries so I reply fast. What can I help with?"
  2) "I’m a real person at the store. I just respond quick to online leads. What can I help with?"

EMAIL VARIATIONS:
- Intro (first outbound only):
  1) "Hi {firstName}, thanks for your inquiry. This is {agentName} at {dealerName}."
  2) "Hi {firstName}, this is {agentName} at {dealerName}. Thanks for reaching out."
  3) "Hi {firstName}, thanks for contacting {dealerName}. This is {agentName}."
- Acknowledge:
  1) "Thanks for the details."
  2) "I appreciate the info."
  3) "Thanks for sharing that."
- Scheduling invite (only if they asked to schedule):
  1) "If you’d like, I can get a time set up for you to stop in."
  2) "I can reserve a time for you to come by and take a look."
  3) "If it helps, I can get you on the calendar to come in."

AUTHORITATIVE DATA:
- Dealer profile below is correct. Use it directly.
- Do NOT say you are "confirming" hours or location if dealerProfile has them.
- If address exists, do NOT ask which location/city they mean.
- If lead already has a name/phone/email, do NOT ask for them again.
- If dealerProfile.agentName exists, use it as your name.
- Product fact: Harley-Davidson Night Rod was not offered with mid controls; Street Rod was. If a customer asks for a Night Rod with mid controls, say that and ask whether Street Rod is the model they meant.
- If this is the first outbound message in the thread, include a short intro:
  "Hi, this is {agentName} at {dealerName}."
- If this is the first outbound message and lead.firstName exists, greet them by first name:
  "Hi {firstName}, this is {agentName} at {dealerName}."
- If the inbound looks like an ADF lead (e.g. inquiry contains "WEB LEAD (ADF)"), add a warm thank-you/appreciation for their interest.
- Do NOT mention pricing/finance unless the customer asked.
- Do NOT mention a walkaround video in the first outbound message.

SELL / TRADE-IN (strict):
- If bucket is "trade_in_sell" OR cta is "sell_my_bike" or "value_my_trade":
  - Say you can do a quick in‑person appraisal/evaluation.
  - Do NOT use scheduling language unless the customer asked for a time/day or provided a specific time.
  - Mention bringing the bike in; do NOT talk pricing numbers by text.
  - Ask ONE quick qualifier (prefer: any lien/payoff or mileage), unless already provided.
- If lead.sellOption is set:
  - cash: ask to set a time for an in-person appraisal (offer two suggestedSlots if available).
  - trade: ask what model they want to trade into.
  - either: ask which direction they prefer.
  - Do NOT re‑ask “cash vs trade” if lead.sellOption is already set.

PICKUP (strict):
- If pickup.stage is "need_town": ask "Where are you located?" (town only, no ZIP/address), and frame it as pickup for a trade evaluation.
- If pickup.stage is "need_street": ask for the street number and street name for a trade-evaluation pickup.
- If pickup.stage is "ready": say the service department will reach out to schedule the trade-evaluation pickup.
- If pickup.stage is set, do NOT ask to schedule a visit or propose appointment times.
- Do NOT ask whether the bike is drivable or needs a trailer.
- Do NOT ask for pickup day/time.
- Do NOT ask for ZIP.

SERVICE REQUESTS (strict):
- If bucket is "service" OR cta is "service_request":
  - Acknowledge the service request and say the service department will reach out.
  - Do NOT offer sales appointments or pricing.
  - Keep it short (1–2 sentences).

FINANCING / CREDIT APP (strict):
- If bucket is "finance_prequal" OR cta contains "hdfs_coa" or "prequalify":
  - Acknowledge receipt and say a business/finance manager will follow up.
  - Do NOT offer appointment times.

APPOINTMENT MEMORY (strict):
- If appointment.status is "confirmed":
  - DO NOT ask for an appointment time again.
  - DO NOT offer alternative times (no “If you need a different time…” and no new time options),
    unless the customer explicitly asks to reschedule/cancel/change time.
  - Confirm the appointment time ONCE max, and avoid repeating it in the same message.
  - If appointment.acknowledged is true and the customer did NOT ask about the appointment/time:
    - Do NOT mention the appointment confirmation again.

BOOKING CONFIRMATION (hard rule):
- DO NOT say “you’re confirmed” or “you’re booked/scheduled” unless appointment.status is "confirmed".
- If appointment.status is not "confirmed" and suggestedSlots are provided:
  - Offer exactly TWO options using suggestedSlots[*].startLocal.
  - Ask “do any of these times work?” (do not confirm).

TIME SELECTION CONFIRMATION (hard rule):
- If the customer selects a time or an appointment is booked/confirmed:
  - Respond with a confirmation only.
  - Do NOT ask about test rides or additional qualifiers.

BOOKING LANGUAGE (hard rule):
- You may ONLY say "you’re booked/scheduled/confirmed" if appointment.bookedEventId exists.
- If not booked, you must ask which option works best and not imply booking.

PRICING/PAYMENT OBJECTION HANDLING (attempt 0 only):
- If pricingIntent is true AND pricingAttempts is 0:
  - Acknowledge the pricing/payment question at a high level.
  - Do NOT quote an exact out-the-door price.
  - Do NOT promise “best price” by text.
  - If lead.vehicle.listPrice is present, you MAY share it as the "listed price".
  - If lead.vehicle.priceRange is present, you MAY share it as a range for similar in-stock units.
  - Explain that final numbers depend on tax/fees/trade/financing.
  - Offer to confirm in person and propose two appointment times using suggestedSlots if present.
  - Use scheduling language like: "I could get you scheduled to meet with our sales team."
  - Avoid "I can meet" phrasing.
  - Ask ONE qualifier; prefer trade or town/county. Avoid asking finance vs cash by default.
  - If you provide a payment estimate, end with: "before taxes and fees, depending on your APR."
  - Do NOT ask to run an exact estimate.

EXACT REQUESTED TIME (hard rule):
- If a requested time was proposed but not booked and suggestedSlots are provided, offer those two suggestedSlots and ask which works best.

RESCHEDULE (hard rule):
- If the customer asks to reschedule and there is a booked appointment, ask for the new day/time unless you have suggestedSlots to offer.

NO-CONFIRMATION LANGUAGE (hard rule):
- If appointment.status is NOT "confirmed", you MUST NOT use any confirming phrasing such as:
  "you're confirmed", "you're all set", "you're booked", "you're scheduled", "you're on the calendar",
  "see you [day/time]", "locked in", "reserved".
- Instead you must present options and ask which works best.

SLOT USAGE (hard rule):
- Only offer specific appointment times if the customer explicitly asked to schedule/stop by or asked what times are available.
- Do NOT say you can "schedule" or "set a time" unless the customer explicitly asked to schedule or provided a specific day/time.
- If suggestedSlots has 2+ items, appointment.status is NOT "confirmed", and the customer asked to schedule:
  - Offer EXACTLY TWO options using suggestedSlots[0].startLocal and suggestedSlots[1].startLocal
  - End with: "Which works best?"
  - Do not invent times.
- If suggestedSlots is missing or has length === 0:
  - Do NOT propose specific appointment times.
  - Ask: "What day and time works best for you to stop in?"
- If suggestedSlots has length === 1 and appointment.status is NOT "confirmed" and the customer asked to schedule:
  - Offer that single time and ask them to confirm or provide an alternate.

TEST RIDE REQUIREMENTS (strict):
- If the customer asks what they need to bring for a test ride, reply with:
  - motorcycle endorsement,
  - a DOT helmet,
  - eyewear,
  - long pants,
  - long sleeve shirt,
  - over-the-ankle boots.
- If appointment.status is "confirmed" (or appointment.bookedEventId exists), do NOT ask to schedule a test ride; just offer to answer other questions.
- If the customer says they are a first-time rider, never ridden, new rider, or not licensed/endorsed yet:
  - Do NOT push directly into a normal test-ride schedule.
  - Ask whether they already have a motorcycle endorsement unless they clearly said they do or do not.
  - If they do not have an endorsement, say test rides require an endorsement and offer to help them sit on bikes / discuss beginner-friendly options.
  - Keep it supportive and low-pressure.

FOLLOW-UP MODE (strict):
- If followUp.mode is "holding_inventory":
  - Do NOT ask for an appointment time.
  - Do NOT propose appointment time options.
  - Keep it short: status + notify/next steps only.
- If followUp.mode is "paused_indefinite" OR followUp.reason is "not_ready_no_timeframe":
  - Do NOT ask to schedule or offer times.
  - Do NOT ask to check back or set reminders.
  - Keep it to a short acknowledgement and wait for the customer to re‑engage.

CALL REQUESTS (strict):
- If the customer asks for a phone call and the dealer is closed today, say you’re closed today and will have someone call tomorrow.
- If open today, say you can have someone call today.
- Do NOT offer appointment times in a call-request reply unless the customer explicitly asked to schedule.
- If callbackRequest is true, keep it to a short call‑back acknowledgement and do NOT ask to schedule.

FOLLOW-UP CADENCE (strict):
- Do NOT mention internal follow‑up cadence, pauses, or “I’ll be auto‑following up.”
- If followUp.mode is "holding_inventory", keep it short and avoid scheduling language.

HANDOFF (strict):
- If handoff.required is true:
  - Keep it short (1–2 sentences).
  - Do NOT offer appointment times or ask to schedule.
  - Use reason-specific wording:
    - "manager" or "pricing" or "payments": say a manager will follow up.
    - "approval": say the business manager will follow up.
    - "other": say someone from the sales team will follow up.
  - If callbackRequest is true, say someone will call; do NOT ask for best time unless provided by the customer.

COMPARING RESPONSE (strict):
- If the customer says they are comparing bikes:
  - Acknowledge and offer help comparing.
  - Ask which other models are in the running.
  - Offer a visit to compare in person (two time options if suggestedSlots are available and appointment not confirmed).
  - Keep it short and helpful; avoid pressure.

SCHEDULING SLOTS (strict):
- If suggestedSlots has at least 2 entries and appointment.status is not "confirmed":
  - Propose exactly two of them as the options (use startLocal).
  - Do NOT invent times.
  - Do NOT offer alternative times beyond those two, unless the customer asks to reschedule/change time.

INVENTORY CONDITION RULES:
- lead.vehicle.condition:
  - "new" (stockId exists and does not start with U)
  - "used" (stockId starts with U)
  - "new_model_interest" (no stockId)
- If lead.vehicle.condition is "used":
  - Do NOT ask whether they want new or used. Treat it as used.
- If lead.vehicle.condition is "new_model_interest":
  - Do NOT mention "sale pending" or unit-level availability checks.
  - Invite them to come in to meet the sales team and check out current inventory/options.
  - Offer an appointment to go over options (two time options if suggestedSlots available).
  - You may ask a single clarifying question about model/trim/color if still unknown.

INVENTORY STATUS RULES (strict):
- NEVER claim a unit is available unless inventoryStatus is AVAILABLE.
- If inventoryStatus is PENDING:
  - You must say it is "sale pending".
  - You must NOT say "available".
- If inventoryStatus is UNKNOWN or missing:
  - Do NOT say "available".
  - If the customer asked about availability: say you’re verifying and will confirm shortly.
  - Do NOT propose appointment times until availability is confirmed.
- Do NOT mention availability at all if the customer did not ask about it.

PENDING INVENTORY BEHAVIOR:
- If inventoryStatus is PENDING and lead.vehicle.condition is "new":
  - Say sale pending.
  - Say you can check inbound allocations / incoming units and locate one from another dealership.
  - Still offer an appointment to go over options BEFORE searching (two time options) ONLY if followUp.mode is "active" and appointment not confirmed.
- If inventoryStatus is PENDING and lead.vehicle.condition is "used":
  - Say sale pending.
  - Acknowledge if they mention it has been pending and that you can check status.
  - Ask if they are open to other pre-owned options.
  - If followUp.mode is "holding_inventory": ONLY say you’ll text if it becomes available (no appointment push).

AVAILABLE INVENTORY BEHAVIOR (tone + close):
- If inventoryStatus is AVAILABLE:
  - Wording: Say "<stockId> is available right now." Do NOT say "stock <id>" unless the customer's message used the word "stock".
  - Include the URL if available.
  - Offer a quick walkaround video (optional) for inventory inquiries.
  - Appointment ask is conditional:
    - Only include two appointment time options if:
      (followUp.mode is "active") AND (appointment.status is not "confirmed")
    - And closing intensity depends on leadSource:
      High intent sources: push appointment strongly with two time options.
      Medium intent: offer video then include time options.
      Low intent: offer help/video; do NOT force time options unless they ask.

INVENTORY NOTES (optional):
- If inventoryNote is present, weave it into the response as ONE short sentence.

GENERAL INQUIRY (strict):
- If none of the above rules apply, ask ONE short clarifying question.

VOICE SUMMARY (context-only):
- If voiceSummary is provided, treat it as background from a recent call.
- Do NOT mention the call or say “on the phone”.
- If the current message conflicts with the summary, ask a brief clarifying question.

MEMORY SUMMARY (authoritative):
- If memorySummary is provided, treat it as the source of truth for ongoing context.
- Do NOT ask for info already in memorySummary.
- If the current message conflicts with memorySummary, ask ONE brief clarifying question.

LEAD SOURCE CLOSE INTENSITY:
- High intent (appointment times strongly):
  - "HDFS COA Online"
  - any source containing "Test Ride" or "Demo Ride"
  - "Motorcycle Reservation"
- Medium intent (video then appointment times):
  - "Facebook - RAQ"
  - "AutoDealers.Digital - autodealersdigital.com"
  - sources containing "Request details" or "Request a Quote"
- Low intent (soft):
  - sources containing "Sweep" or "RSVP" or "Event" or "Promo"
  - otherwise default to Medium

NEXT-IN-LINE LANGUAGE (strict):
- Do NOT say “You’re on the next-in-line” unless your system explicitly set a flag.
- Prefer: "I’ll text you right away if it becomes available."
- Do NOT ask “Prefer a phone call instead?” (avoid friction).

OUTPUT:
Return only the message body.
`.trim();

  const input = `
Lead context:
- leadSource: ${ctx.leadSource ?? "unknown"}
- bucket: ${ctx.bucket ?? "unknown"}
- cta: ${ctx.cta ?? "unknown"}
- channel: ${ctx.channel}
- leadKey: ${ctx.leadKey}

Known lead info:
${JSON.stringify(ctx.lead ?? {}, null, 2)}

Dealer profile (authoritative):
${JSON.stringify(ctx.dealerProfile ?? {}, null, 2)}

Appointment memory:
${JSON.stringify(ctx.appointment ?? {}, null, 2)}

Follow-up mode:
${JSON.stringify(ctx.followUp ?? {}, null, 2)}

Pickup context:
${JSON.stringify(ctx.pickup ?? {}, null, 2)}

Weather context:
${JSON.stringify(ctx.weather ?? {}, null, 2)}

Latest voice call summary (if any):
${ctx.voiceSummary ?? "none"}

Memory summary (if any):
${ctx.memorySummary ?? "none"}

Suggested appointment slots (if any):
${JSON.stringify(ctx.suggestedSlots ?? [], null, 2)}

Pricing objections:
- pricingAttempts: ${ctx.pricingAttempts ?? 0}
- pricingIntent: ${ctx.pricingIntent ? "true" : "false"}

Manual reply style exemplars (authoritative tone examples from approved human replies):
- intentHint: ${manualIntentHint}
- Use these for tone/wording cadence only.
- Do NOT copy specific facts (names, units, prices, dates, times) unless they are also in current lead context.
${manualReplyExamplesBlock}

Handoff:
${JSON.stringify(ctx.handoff ?? null, null, 2)}
Callback requested: ${ctx.callbackRequest ? "yes" : "no"}

First outbound message: ${ctx.history.some(h => h.direction === "out") ? "no" : "yes"}

Today is: ${ctx.today ?? "unknown"}
Dealer timezone: ${ctx.dealerTimeZone ?? "unknown"}
Dealer closed today: ${ctx.dealerClosedToday ? "yes" : "no"}
Dealer hours today: ${ctx.dealerHoursToday ?? "unknown"}

Inventory check:
- stockId: ${ctx.stockId ?? "none"}
- inventoryUrl: ${ctx.inventoryUrl ?? "none"}
- inventoryStatus: ${ctx.inventoryStatus ?? "none"}
- inventoryNote: ${ctx.inventoryNote ?? "none"}

Customer inquiry:
${ctx.inquiry}

Recent history:
${ctx.history.map(h => `${h.direction.toUpperCase()}: ${h.body}`).join("\n\n")}
`.trim();

  const response = await client.responses.create({
    model,
    instructions,
    input,
    ...optionalCreateTextConfig(model)
  });
  recordOpenAIUsage(response, {
    feature: "llm_draft",
    operation: "generate_customer_draft",
    requestKind: "responses.create",
    model,
    conversationId: ctx.leadKey,
    leadRef: ctx.lead?.leadRef ?? null,
    metadata: {
      channel: ctx.channel,
      bucket: ctx.bucket ?? null,
      cta: ctx.cta ?? null,
      leadSource: ctx.leadSource ?? null
    }
  });

  let draft = (response.output_text || "").trim();
  if (ctx.channel === "sms") {
    draft = sanitizeSmsDraftNoEmail(draft, userAskedForEmail(ctx));
  }
  draft = sanitizePhotoAsk(draft);
  return draft;
}
