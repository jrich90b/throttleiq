// services/api/src/domain/llmDraft.ts
import fs from "node:fs";
import OpenAI from "openai";
import type { Conversation } from "./conversationStore.js";
import { dataPath } from "./dataDir.js";

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

export type CadencePersonalizationParse = {
  line: string;
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
  intent: "opt_out" | "not_interested" | "schedule_request" | "compliment_only" | "none";
  explicitRequest: boolean;
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
  confidence?: number;
};

export type RoutingDecisionParse = {
  primaryIntent: "pricing_payments" | "scheduling" | "callback" | "availability" | "general" | "none";
  explicitRequest: boolean;
  fallbackAction: "none" | "clarify" | "no_response";
  clarifyPrompt?: string | null;
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
    | "new_vs_used"
    | "none";
  explicitRequest: boolean;
  confidence?: number;
};

export type InventoryEntityParse = {
  model?: string | null;
  year?: number | null;
  yearMin?: number | null;
  yearMax?: number | null;
  color?: string | null;
  trim?: string | null;
  minPrice?: number | null;
  maxPrice?: number | null;
  monthlyBudget?: number | null;
  downPayment?: number | null;
  confidence?: number;
};

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
    | "service_request"
    | "parts_request"
    | "apparel_request"
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
    | "service_request"
    | "parts_request"
    | "apparel_request"
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
    /\b(after|before|around|between)\b/.test(v)
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
      enum: ["opt_out", "not_interested", "schedule_request", "compliment_only", "none"]
    },
    explicit_request: { type: "boolean" },
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
    "model",
    "year",
    "year_min",
    "year_max",
    "color",
    "trim",
    "min_price",
    "max_price",
    "monthly_budget",
    "down_payment",
    "confidence"
  ],
  properties: {
    model: { type: "string" },
    year: { type: "integer" },
    year_min: { type: "integer" },
    year_max: { type: "integer" },
    color: { type: "string" },
    trim: { type: "string" },
    min_price: { type: "number" },
    max_price: { type: "number" },
    monthly_budget: { type: "number" },
    down_payment: { type: "number" },
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
        "service_request",
        "parts_request",
        "apparel_request",
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
      enum: ["credit_app", "service_request", "parts_request", "apparel_request", "none"]
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
    const parsed = safeParseJson(raw);
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
    'input: "Customer: yes saturday at 930 works" output: {"intent":"schedule","explicit_request":true,"requested":{"day":"saturday","time_text":"9:30","time_window":"exact"},"reference":"last_suggested","normalized_text":"saturday 9:30","confidence":0.96}',
    'input: "Customer: saturday works for me" output: {"intent":"schedule","explicit_request":true,"requested":{"day":"saturday","time_text":"","time_window":"unknown"},"reference":"last_suggested","normalized_text":"saturday","confidence":0.93}',
    'input: "Customer: 11am can you send photos of street glide limited" output: {"intent":"none","explicit_request":false,"requested":{"day":"","time_text":"","time_window":"unknown"},"reference":"none","normalized_text":"","confidence":0.96}',
    'input: "Customer: never mind photo. test ride street glide limited 3. thanks" output: {"intent":"none","explicit_request":false,"requested":{"day":"","time_text":"","time_window":"unknown"},"reference":"none","normalized_text":"","confidence":0.95}',
    'input: "Customer: 9ish works" output: {"intent":"schedule","explicit_request":true,"requested":{"day":"","time_text":"9ish","time_window":"range"},"reference":"last_suggested","normalized_text":"9ish","confidence":0.9}',
    'input: "Customer: after 4 is best" output: {"intent":"schedule","explicit_request":true,"requested":{"day":"","time_text":"after 4","time_window":"range"},"reference":"last_suggested","normalized_text":"after 4","confidence":0.91}',
    'input: "Customer: can we move that to saturday morning?" output: {"intent":"reschedule","explicit_request":true,"requested":{"day":"saturday","time_text":"morning","time_window":"range"},"reference":"last_appointment","normalized_text":"saturday morning","confidence":0.94}',
    'input: "Customer: can you move me later than that time?" output: {"intent":"reschedule","explicit_request":true,"requested":{"day":"","time_text":"later","time_window":"range"},"reference":"last_suggested","normalized_text":"later than last suggested","confidence":0.9}',
    'input: "Customer: what openings do you have friday?" output: {"intent":"availability","explicit_request":true,"requested":{"day":"friday","time_text":"","time_window":"unknown"},"reference":"none","normalized_text":"friday","confidence":0.95}',
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
    "- If the customer gives a day without a time, set requested.day and set time_text to an empty string.",
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
    String(args.appointment?.status ?? "none").toLowerCase() !== "none"
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
  const voiceExamples = [
    'input: "Customer: can you call me after 4?" output: {"intent":"callback","explicit_request":true,"availability":{"model":"","year":"","color":"","stock_id":"","condition":"unknown"},"callback":{"requested":true,"time_text":"after 4","phone":""},"confidence":0.97}',
    'input: "Customer: if you call me around 1-2pm i should be up. i work night shift." output: {"intent":"callback","explicit_request":true,"availability":{"model":"","year":"","color":"","stock_id":"","condition":"unknown"},"callback":{"requested":true,"time_text":"around 1-2pm","phone":""},"confidence":0.98}',
    'input: "Customer: do you have any black street glides in stock?" output: {"intent":"availability","explicit_request":true,"availability":{"model":"Street Glide","year":"","color":"black","stock_id":"","condition":"unknown"},"callback":{"requested":false,"time_text":"","phone":""},"confidence":0.97}',
    'input: "Customer: can i test ride one this week?" output: {"intent":"test_ride","explicit_request":true,"availability":{"model":"","year":"","color":"","stock_id":"","condition":"unknown"},"callback":{"requested":false,"time_text":"","phone":""},"confidence":0.95}',
    'input: "Customer: I begin my riding academy next Monday and was told you do the jumpstart experience prior." output: {"intent":"none","explicit_request":false,"availability":{"model":"","year":"","color":"","stock_id":"","condition":"unknown"},"callback":{"requested":false,"time_text":"","phone":""},"confidence":0.95}',
    'input: "Customer: how about a triglycerides instead. it would have to be on a saturday." output: {"intent":"none","explicit_request":false,"availability":{"model":"Street Glide 3 Limited","year":"","color":"","stock_id":"","condition":"unknown"},"callback":{"requested":false,"time_text":"","phone":""},"confidence":0.94}',
    'input: "Customer: saturday works for me on a tri glide. does the morning work?" output: {"intent":"none","explicit_request":false,"availability":{"model":"Street Glide 3 Limited","year":"","color":"","stock_id":"","condition":"unknown"},"callback":{"requested":false,"time_text":"","phone":""},"confidence":0.95}',
    'input: "Customer: 11am can you send photos of street glide limited" output: {"intent":"none","explicit_request":false,"availability":{"model":"Street Glide Limited","year":"","color":"","stock_id":"","condition":"unknown"},"callback":{"requested":false,"time_text":"","phone":""},"confidence":0.95}',
    'input: "Customer: do you have brake pads in stock for a 2018 street glide?" output: {"intent":"none","explicit_request":false,"availability":{"model":"","year":"","color":"","stock_id":"","condition":"unknown"},"callback":{"requested":false,"time_text":"","phone":""},"confidence":0.96}',
    'input: "Customer: is the orange hoodie in stock in xl?" output: {"intent":"none","explicit_request":false,"availability":{"model":"","year":"","color":"","stock_id":"","condition":"unknown"},"callback":{"requested":false,"time_text":"","phone":""},"confidence":0.96}',
    'input: "Customer: never mind photo. test ride street glide limited 3. thanks" output: {"intent":"test_ride","explicit_request":true,"availability":{"model":"Street Glide 3 Limited","year":"","color":"","stock_id":"","condition":"unknown"},"callback":{"requested":false,"time_text":"","phone":""},"confidence":0.96}',
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
    "- jump start / jumpstart / riding-academy prep messages are not inventory availability requests; do not set intent=test_ride for those.",
    "- intent=callback if they ask for a call or ask you to call them.",
    "- If message is about appointment/schedule availability (day/time/openings), intent=none and explicit_request=false.",
    "- If no clear request, intent=none and explicit_request=false.",
    "- Use empty strings for unknown availability fields (model/year/color/stock_id).",
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
    ? {
        model: cleanOptionalString(availabilityRaw.model),
        year: cleanOptionalString(availabilityRaw.year),
        color: cleanOptionalString(availabilityRaw.color),
        stockId: cleanOptionalString(availabilityRaw.stock_id),
        condition:
          availabilityRaw.condition === "new" || availabilityRaw.condition === "used"
            ? availabilityRaw.condition
            : "unknown"
      }
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
output: {"disposition":"keep_current_bike","explicit_disposition":true,"timeframe_text":"next month","confidence":0.92}`
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
    "- not_interested: customer clearly declines buying/follow-up for now.",
    "- schedule_request: customer explicitly asks to book/schedule/pick a day/time.",
    "- compliment_only: customer only compliments the bike/team without request/action.",
    "- none: anything else.",
    "",
    "Rules:",
    "- Choose only one intent.",
    "- If customer says STOP/unsubscribe/no more texts => opt_out.",
    "- If customer says not interested / pass / no thanks / not moving forward => not_interested.",
    "- schedule_request only for explicit scheduling intent (appointment/time/day availability).",
    "- compliment_only only if no other request/intent is present.",
    "- If uncertain, intent=none and explicit_request=false.",
    "- confidence is 0..1.",
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
    intentRaw === "not_interested" ||
    intentRaw === "schedule_request" ||
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
output: {"intent":"payments","explicit_request":true,"asks_monthly_target":false,"asks_down_payment":false,"asks_apr_or_term":false,"confidence":0.97}`,
    `EXAMPLE B
inbound: "I want to stay under $500/month."
output: {"intent":"payments","explicit_request":true,"asks_monthly_target":true,"asks_down_payment":false,"asks_apr_or_term":false,"confidence":0.98}`,
    `EXAMPLE C
inbound: "I have $2,500 down and want under $500/mo."
output: {"intent":"payments","explicit_request":true,"asks_monthly_target":true,"asks_down_payment":true,"asks_apr_or_term":false,"confidence":0.98}`,
    `EXAMPLE D
inbound: "Can you run it for 72 months?"
output: {"intent":"payments","explicit_request":true,"asks_monthly_target":false,"asks_down_payment":false,"asks_apr_or_term":true,"confidence":0.97}`,
    `EXAMPLE E
inbound: "I don't want to put anything down."
output: {"intent":"payments","explicit_request":true,"asks_monthly_target":false,"asks_down_payment":true,"asks_apr_or_term":false,"confidence":0.96}`,
    `EXAMPLE F
inbound: "Any deals or finance specials right now?"
output: {"intent":"pricing","explicit_request":true,"asks_monthly_target":false,"asks_down_payment":false,"asks_apr_or_term":false,"confidence":0.95}`,
    `EXAMPLE G
inbound: "What is your best out-the-door price?"
output: {"intent":"pricing","explicit_request":true,"asks_monthly_target":false,"asks_down_payment":false,"asks_apr_or_term":false,"confidence":0.97}`,
    `EXAMPLE H
inbound: "Do you have any black street glides in stock?"
output: {"intent":"none","explicit_request":false,"asks_monthly_target":false,"asks_down_payment":false,"asks_apr_or_term":false,"confidence":0.96}`,
    `EXAMPLE I
inbound: "Can I come in Wednesday at 1?"
output: {"intent":"none","explicit_request":false,"asks_monthly_target":false,"asks_down_payment":false,"asks_apr_or_term":false,"confidence":0.97}`,
    `EXAMPLE J
inbound: "Before I come in, what do I need to bring for financing?"
output: {"intent":"payments","explicit_request":true,"asks_monthly_target":false,"asks_down_payment":false,"asks_apr_or_term":false,"confidence":0.94}`
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
    "- If user asks 'how much down', '$300/month', 'monthly', 'APR', or term => payments.",
    "- Do not classify scheduling/appointment messages as pricing/payments.",
    "- If mixed but payment structure is present, prefer payments.",
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
    "- callback: customer asks for a phone call.",
    "- general: clear request but not one of the above.",
    "- none: no actionable request.",
    "",
    "Rules:",
    "- Use the latest inbound ask as source of truth even if prior turns were different.",
    "- If inbound is short acknowledgment only, use primary_intent=none and fallback_action=no_response.",
    "- Use fallback_action=clarify only when message is ambiguous and not safely routable.",
    "- Only choose callback when the customer explicitly asks for a phone call (e.g., call me, have X call me, can you call).",
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
    "- factory_order_timing: asks how long factory order takes.",
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
    "- new_vs_used: asks whether new or used is better.",
    "- none: not an FAQ-style question above.",
    "",
    "Rules:",
    "- If message is a transactional request (specific availability, exact payment calc, scheduling), choose none.",
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

  const topicRaw = String(parsed.topic ?? "").toLowerCase();
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
output: {"state":"none","explicit_state":false,"test_ride_requested":false,"weather_sensitive":false,"follow_up_window_text":"5/23/26","confidence":0.88}`
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
  const voiceExamples = [
    'input: "Customer: can service quote an LED headlight install?" output: {"state_intent":"service_request","corporate_topic":"none","department_intent":"service","explicit_request":true,"clear_inventory_watch_pending":true,"clear_pricing_need_model":true,"manual_handoff_reason":"service_request","confidence":0.97}',
    'input: "Customer: can parts order drag specialties for me?" output: {"state_intent":"parts_request","corporate_topic":"none","department_intent":"parts","explicit_request":true,"clear_inventory_watch_pending":true,"clear_pricing_need_model":true,"manual_handoff_reason":"parts_request","confidence":0.97}',
    'input: "Customer: can service call me saturday morning around 10?" output: {"state_intent":"service_request","corporate_topic":"none","department_intent":"service","explicit_request":true,"clear_inventory_watch_pending":true,"clear_pricing_need_model":true,"manual_handoff_reason":"service_request","confidence":0.97}',
    'input: "Customer: i need parts for my 572 fl. can someone call me saturday around ten?" output: {"state_intent":"parts_request","corporate_topic":"none","department_intent":"parts","explicit_request":true,"clear_inventory_watch_pending":true,"clear_pricing_need_model":true,"manual_handoff_reason":"parts_request","confidence":0.96}',
    'input: "Customer: keep an eye out for a black road glide and text me when one lands" output: {"state_intent":"inventory_watch","corporate_topic":"none","department_intent":"none","explicit_request":true,"clear_inventory_watch_pending":false,"clear_pricing_need_model":true,"manual_handoff_reason":"none","confidence":0.96}',
    'input: "Customer: tuesday around 4 works for me" output: {"state_intent":"scheduling","corporate_topic":"none","department_intent":"none","explicit_request":true,"clear_inventory_watch_pending":true,"clear_pricing_need_model":true,"manual_handoff_reason":"none","confidence":0.94}',
    'input: "Customer: saturday morning works. does 9:30 work for you?" output: {"state_intent":"scheduling","corporate_topic":"none","department_intent":"none","explicit_request":true,"clear_inventory_watch_pending":true,"clear_pricing_need_model":true,"manual_handoff_reason":"none","confidence":0.95}',
    'input: "Customer: how about a tri glide instead. it has to be saturday morning." output: {"state_intent":"scheduling","corporate_topic":"none","department_intent":"none","explicit_request":true,"clear_inventory_watch_pending":true,"clear_pricing_need_model":true,"manual_handoff_reason":"none","confidence":0.95}',
    'input: "Customer: how about a triglycerides instead. let me know about saturday." output: {"state_intent":"scheduling","corporate_topic":"none","department_intent":"none","explicit_request":true,"clear_inventory_watch_pending":true,"clear_pricing_need_model":true,"manual_handoff_reason":"none","confidence":0.93}',
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
    "- service_request / parts_request / apparel_request: department handoff intents.",
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
    "- For corporate-misroute messages, set explicit_request=true even when phrased as a statement (for example: 'just letting you know about another dealership experience').",
    "",
    "Department intent rules:",
    "- service/parts/apparel only when explicitly requested or clearly implied.",
    "",
    "State hygiene rules:",
    "- clear_inventory_watch_pending=true when current message clearly shifts away from watch flow (especially into service/parts/apparel or finance docs).",
    "- clear_pricing_need_model=true when message is not asking pricing anymore and is clearly another workflow.",
    "",
    "manual_handoff_reason rules:",
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
    /\b(parts? department|parts? counter|parts? desk|order (a )?part|need (a )?part|part number|oem parts?|aftermarket parts?|parts? for my|do you (have|carry|stock)\b.{0,28}\bparts?)\b/.test(
      textLower
    );
  const apparelCue =
    /\b(apparel|merch|merchandise|clothing|jacket|hoodie|t-?shirt|tee shirt|helmet|gloves?|boots?|riding gear|gear)\b/.test(
      textLower
    );
  const explicitServiceRequest = serviceCue && hasRequestSignal;
  const explicitPartsRequest = partsCue && hasRequestSignal;
  const explicitApparelRequest = apparelCue && hasRequestSignal;

  const stateRaw = String(parsed.state_intent ?? "").toLowerCase();
  let stateIntent: ConversationStateParse["stateIntent"] =
    stateRaw === "finance_docs" ||
    stateRaw === "inventory_watch" ||
    stateRaw === "service_request" ||
    stateRaw === "parts_request" ||
    stateRaw === "apparel_request" ||
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
    handoffRaw === "service_request" ||
    handoffRaw === "parts_request" ||
    handoffRaw === "apparel_request"
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
  if (stateIntent === "service_request" && !explicitServiceRequest) {
    stateIntent = "general";
  }
  if (stateIntent === "parts_request" && !explicitPartsRequest) {
    stateIntent = "general";
  }
  if (stateIntent === "apparel_request" && !explicitApparelRequest) {
    stateIntent = "general";
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
    'input: "Customer: do you have any black street glides in stock?" output: {"model":"Street Glide","year":0,"year_min":0,"year_max":0,"color":"black","trim":"","min_price":0,"max_price":0,"monthly_budget":0,"down_payment":0,"confidence":0.97}',
    'input: "Customer: looking for a 2026 road glide limited in vivid black" output: {"model":"Road Glide Limited","year":2026,"year_min":0,"year_max":0,"color":"vivid black","trim":"","min_price":0,"max_price":0,"monthly_budget":0,"down_payment":0,"confidence":0.97}',
    'input: "Customer: how about a tri glide instead?" output: {"model":"Street Glide 3 Limited","year":0,"year_min":0,"year_max":0,"color":"","trim":"","min_price":0,"max_price":0,"monthly_budget":0,"down_payment":0,"confidence":0.95}',
    'input: "Customer: how about a triglycerides instead?" output: {"model":"Street Glide 3 Limited","year":0,"year_min":0,"year_max":0,"color":"","trim":"","min_price":0,"max_price":0,"monthly_budget":0,"down_payment":0,"confidence":0.93}',
    'input: "Customer: if i can stay around 500 a month with 2500 down id do it" output: {"model":"","year":0,"year_min":0,"year_max":0,"color":"","trim":"","min_price":0,"max_price":0,"monthly_budget":500,"down_payment":2500,"confidence":0.95}',
    'input: "Customer: anything between 2021 and 2023 under 20k?" output: {"model":"","year":0,"year_min":2021,"year_max":2023,"color":"","trim":"","min_price":0,"max_price":20000,"monthly_budget":0,"down_payment":0,"confidence":0.94}',
    'input: "Customer: im after a black trim cvo street glide st" output: {"model":"CVO Street Glide ST","year":0,"year_min":0,"year_max":0,"color":"","trim":"black trim","min_price":0,"max_price":0,"monthly_budget":0,"down_payment":0,"confidence":0.93}',
    'input: "Customer: tuesday at 4 works for me" output: {"model":"","year":0,"year_min":0,"year_max":0,"color":"","trim":"","min_price":0,"max_price":0,"monthly_budget":0,"down_payment":0,"confidence":0.92}'
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
    "- min_price/max_price: explicit numeric price range only; else 0.",
    "- monthly_budget/down_payment: explicit numeric monthly/down values only; else 0.",
    "- Do not infer values not in the message.",
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

  return {
    model: cleanOptionalString(parsed.model),
    year: toYear(parsed.year),
    yearMin: toYear(parsed.year_min),
    yearMax: toYear(parsed.year_max),
    color: cleanOptionalString(parsed.color),
    trim: cleanOptionalString(parsed.trim),
    minPrice: toNum(parsed.min_price),
    maxPrice: toNum(parsed.max_price),
    monthlyBudget: toNum(parsed.monthly_budget),
    downPayment: toNum(parsed.down_payment),
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
    'input: "Customer: if one lands, shoot me a text please" output: {"watch_action":"set_watch","watch":{"model":"","year":"","year_min":0,"year_max":0,"color":"","condition":"unknown","min_price":0,"max_price":0,"monthly_budget":0,"down_payment":0},"department_intent":"none","contact_preference_intent":"none","media_intent":"none","service_records_intent":false,"confidence":0.94}',
    'input: "Customer: do you have any black street glides in stock?" output: {"watch_action":"none","watch":{"model":"Street Glide","year":"","year_min":0,"year_max":0,"color":"black","condition":"unknown","min_price":0,"max_price":0,"monthly_budget":0,"down_payment":0},"department_intent":"none","contact_preference_intent":"none","media_intent":"none","service_records_intent":false,"confidence":0.95}',
    'input: "Customer: do you have brake pads in stock for my 2018 street glide?" output: {"watch_action":"none","watch":{"model":"Street Glide","year":"2018","year_min":0,"year_max":0,"color":"","condition":"unknown","min_price":0,"max_price":0,"monthly_budget":0,"down_payment":0},"department_intent":"parts","contact_preference_intent":"none","media_intent":"none","service_records_intent":false,"confidence":0.97}',
    'input: "Customer: stop the watch alerts for the road glide please" output: {"watch_action":"stop_watch","watch":{"model":"Road Glide","year":"","year_min":0,"year_max":0,"color":"","condition":"unknown","min_price":0,"max_price":0,"monthly_budget":0,"down_payment":0},"department_intent":"none","contact_preference_intent":"none","media_intent":"none","service_records_intent":false,"confidence":0.96}',
    'input: "Customer: I found one already, stop looking for me." output: {"watch_action":"stop_watch","watch":{"model":"","year":"","year_min":0,"year_max":0,"color":"","condition":"unknown","min_price":0,"max_price":0,"monthly_budget":0,"down_payment":0},"department_intent":"none","contact_preference_intent":"none","media_intent":"none","service_records_intent":false,"confidence":0.95}',
    'input: "Customer: left a 1000 deposit and I am coming in saturday to finalize" output: {"watch_action":"none","watch":{"model":"","year":"","year_min":0,"year_max":0,"color":"","condition":"unknown","min_price":0,"max_price":0,"monthly_budget":0,"down_payment":0},"department_intent":"none","contact_preference_intent":"none","media_intent":"none","service_records_intent":false,"confidence":0.94}',
    'input: "Customer: can service quote an LED headlight install?" output: {"watch_action":"none","watch":{"model":"","year":"","year_min":0,"year_max":0,"color":"","condition":"unknown","min_price":0,"max_price":0,"monthly_budget":0,"down_payment":0},"department_intent":"service","contact_preference_intent":"none","media_intent":"none","service_records_intent":false,"confidence":0.97}',
    'input: "Customer: can you send a walkaround video?" output: {"watch_action":"none","watch":{"model":"","year":"","year_min":0,"year_max":0,"color":"","condition":"unknown","min_price":0,"max_price":0,"monthly_budget":0,"down_payment":0},"department_intent":"none","contact_preference_intent":"none","media_intent":"video","service_records_intent":false,"confidence":0.95}',
    'input: "Customer: 11am can you send photos of street glide limited" output: {"watch_action":"none","watch":{"model":"Street Glide Limited","year":"","year_min":0,"year_max":0,"color":"","condition":"unknown","min_price":0,"max_price":0,"monthly_budget":0,"down_payment":0},"department_intent":"none","contact_preference_intent":"none","media_intent":"photos","service_records_intent":false,"confidence":0.95}',
    'input: "Customer: never mind photo. test ride street glide limited 3. thanks" output: {"watch_action":"none","watch":{"model":"Street Glide 3 Limited","year":"","year_min":0,"year_max":0,"color":"","condition":"unknown","min_price":0,"max_price":0,"monthly_budget":0,"down_payment":0},"department_intent":"none","contact_preference_intent":"none","media_intent":"none","service_records_intent":false,"confidence":0.95}',
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
    "- watch_action=none for general inventory questions without watch request.",
    "- Never set watch_action from standalone time tokens or media requests. For 'send photos/video' requests, keep watch_action=none and set media_intent accordingly.",
    "- department_intent=service/parts/apparel only when customer explicitly requests that department/category help.",
    "- department_intent=parts for parts/part-number/OEM/brake pads/tires/accessory fitment questions, even if the text says 'in stock' and includes a bike model.",
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
    (/\b(lmk|let me know|keep me posted|keep an eye out|watch for|notify me|text me|shoot me (a )?text|send (one|it) my way)\b/.test(
      textLower
    ) &&
      /\b(if|when|once|as soon as|get|got|comes? in|lands?|in stock|available)\b/.test(textLower)) ||
    /\bwatch for\b/.test(textLower) ||
    (/\b(jot me down|mark it down|write me down|keep me in mind)\b/.test(textLower) &&
      /\b(used|pre[- ]?owned|street glide|road glide|low rider|sportster|softail|inventory|comes? in|price range|spend)\b/.test(
        textLower
      ));
  const hasWatchStopAction =
    /\b(stop|cancel|remove|delete|turn off|pause|disable|end|no more|don't|dont|do not)\b/.test(
      textLower
    );
  const hasWatchStopContext =
    /\b(watch|alerts?|updates?|notifications?|inventory|availability|looking)\b/.test(textLower) ||
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
  const hasPartsCue =
    /\b(parts? department|parts? counter|parts? desk|order (a )?part|need (a )?part|part number|oem parts?|aftermarket parts?|brake pads?|tires?|accessory fitment|fitment)\b/.test(
      textLower
    );
  const hasApparelCue =
    /\b(apparel|merch|merchandise|clothing|jacket|hoodie|t-?shirt|helmet|gloves?|boots?|riding gear|gear)\b/.test(
      textLower
    );
  if (departmentIntent === "service" && !hasServiceCue) departmentIntent = "none";
  if (departmentIntent === "parts" && !hasPartsCue) departmentIntent = "none";
  if (departmentIntent === "apparel" && !hasApparelCue) departmentIntent = "none";
  if (departmentIntent === "none" && hasPartsCue) departmentIntent = "parts";
  if (departmentIntent === "none" && hasServiceCue) departmentIntent = "service";
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

  let draft = (response.output_text || "").trim();
  if (ctx.channel === "sms") {
    draft = sanitizeSmsDraftNoEmail(draft, userAskedForEmail(ctx));
  }
  draft = sanitizePhotoAsk(draft);
  return draft;
}
