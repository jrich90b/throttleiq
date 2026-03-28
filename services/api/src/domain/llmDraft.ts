// services/api/src/domain/llmDraft.ts
import OpenAI from "openai";
import type { Conversation } from "./conversationStore.js";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

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
  const prompt = [
    "You are a classifier for dealership SMS.",
    "Question: Is the customer trying to schedule or pick an appointment time?",
    "Answer with only YES or NO.",
    "",
    `Message: ${text}`
  ].join("\n");
  try {
    const resp = await client.responses.create({
      model,
      input: prompt
    });
    const out = resp.output_text?.trim().toLowerCase() ?? "";
    return out.startsWith("y");
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
  const prompt = [
    "You are a classifier for dealership SMS. Return ONLY valid JSON.",
    "Decide if the message is small talk/pleasantry with no actionable intent.",
    "",
    "JSON SCHEMA:",
    "{",
    '  \"small_talk\": true|false,',
    '  \"confidence\": 0.0',
    "}",
    "",
    "Guidelines:",
    "- small_talk=true only for acknowledgements, thanks, emojis, or brief pleasantries.",
    "- small_talk=false if the message asks a question or contains a request.",
    "- small_talk=false if it mentions scheduling, pricing, payments, availability, trade-in, test ride, callback, or hours.",
    "",
    history.length ? `Recent messages:\n${history.join("\n")}` : "Recent messages: (none)",
    `Message: ${text}`
  ].join("\n");
  try {
    const resp = await client.responses.create({
      model,
      input: prompt,
      temperature: 0,
      max_output_tokens: 120
    });
    const raw = resp.output_text?.trim() ?? "";
    const parsed = safeParseJson(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const smallTalk = !!parsed.small_talk;
    const confidence =
      typeof parsed.confidence === "number" && Number.isFinite(parsed.confidence)
        ? Math.max(0, Math.min(1, parsed.confidence))
        : undefined;
    return { smallTalk, confidence };
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
  const prompt = [
    "You are a classifier for dealership SMS.",
    "Question: Does this message describe a personal hardship or serious situation where empathy is appropriate?",
    "Answer with only YES or NO.",
    "",
    history.length ? `Recent messages:\n${history.join("\n")}` : "Recent messages: (none)",
    `Message: ${text}`
  ].join("\n");
  try {
    const resp = await client.responses.create({
      model,
      input: prompt,
      temperature: 0,
      max_output_tokens: 20
    });
    const out = resp.output_text?.trim().toLowerCase() ?? "";
    if (!out) return null;
    return out.startsWith("y");
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
  const prompt = [
    "You are a classifier for dealership SMS.",
    "Question: Is this message a compliment or positive remark about the bike or its features (e.g., love the wheels, nice exhaust, looks great)?",
    "Answer with only YES or NO.",
    "",
    history.length ? `Recent messages:\n${history.join("\n")}` : "Recent messages: (none)",
    `Message: ${text}`
  ].join("\n");
  try {
    const resp = await client.responses.create({
      model,
      input: prompt,
      temperature: 0,
      max_output_tokens: 20
    });
    const out = resp.output_text?.trim().toLowerCase() ?? "";
    if (!out) return null;
    return out.startsWith("y");
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
  const prompt = [
    "You are a classifier for dealership follow-up context.",
    "Return ONLY one label from this list:",
    "trade, pricing, payments, inventory, scheduling, general",
    "",
    "Guidelines:",
    "- trade: trade-in, appraisal, sell my bike, cash offer, payoff/lien.",
    "- pricing: MSRP, price, OTD, quote, rebates.",
    "- payments: monthly payment, APR, term, down payment, financing numbers.",
    "- inventory: availability, in stock, model/trim/color/finish questions.",
    "- scheduling: appointment time, stop in, visit, test ride scheduling.",
    "- general: none of the above.",
    "",
    `Recent messages:\n${history.join("\n")}`
  ].join("\n");
  try {
    const resp = await client.responses.create({
      model,
      input: prompt,
      temperature: 0,
      max_output_tokens: 20
    });
    const out = resp.output_text?.trim().toLowerCase() ?? "";
    const label = out.split(/\s+/)[0];
    if (["trade", "pricing", "payments", "inventory", "scheduling", "general"].includes(label)) {
      return label;
    }
    return null;
  } catch {
    return null;
  }
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
      temperature: 0.2,
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

export async function parseBookingIntentWithLLM(args: {
  text: string;
  history?: { direction: "in" | "out"; body: string }[];
  lastSuggestedSlots?: { startLocal?: string | null }[];
  appointment?: any;
}): Promise<BookingParse | null> {
  const useLLM =
    process.env.LLM_ENABLED === "1" &&
    process.env.LLM_BOOKING_PARSER_ENABLED === "1" &&
    !!process.env.OPENAI_API_KEY;
  if (!useLLM) return null;

  const model = process.env.OPENAI_BOOKING_PARSER_MODEL || process.env.OPENAI_MODEL || "gpt-5-mini";
  const text = String(args.text ?? "").trim();
  if (!text) return null;

  const history = (args.history ?? []).slice(-6).map(h => `${h.direction}: ${h.body}`);
  const lastSlots = (args.lastSuggestedSlots ?? [])
    .map(s => s.startLocal)
    .filter(Boolean)
    .slice(0, 2)
    .join(" | ");
  const apptStatus = args.appointment?.status ?? "none";

  const prompt = [
    "You are a scheduling parser for dealership SMS. Return ONLY valid JSON.",
    "Do not include extra text. Do not invent dates. Use day-of-week or today/tomorrow.",
    "",
    "JSON SCHEMA:",
    "{",
    '  "intent": "schedule|reschedule|cancel|availability|question|none",',
    '  "explicit_request": true|false,',
    '  "requested": { "day": "monday|tuesday|wednesday|thursday|friday|saturday|sunday|today|tomorrow|this week|next week|weekend|this weekend", "time_text": "4pm", "time_window": "exact|range|unknown" },',
    '  "reference": "last_suggested|last_appointment|none",',
    '  "normalized_text": "friday at 4 pm",',
    '  "confidence": 0.0',
    "}",
    "",
    "Guidelines:",
    "- explicit_request is true only if the customer is asking to schedule/stop in/reschedule/cancel.",
    "- If the customer gives a day without a time, set requested.day and leave time_text empty.",
    "- If the customer references a prior offer (e.g., 'that time', 'earlier', 'later'), set reference to last_suggested.",
    "- normalized_text should be a compact day/time phrase when possible; otherwise empty string.",
    "",
    `Appointment status: ${apptStatus}`,
    history.length ? `Recent messages:\n${history.join("\n")}` : "Recent messages: (none)",
    lastSlots ? `Last suggested slots: ${lastSlots}` : "Last suggested slots: (none)",
    `Message: ${text}`
  ].join("\n");

  try {
    const resp = await client.responses.create({
      model,
      input: prompt,
      temperature: 0,
      max_output_tokens: 220
    });
    const raw = resp.output_text?.trim() ?? "";
    const parsed = safeParseJson(raw);
    if (!parsed || typeof parsed !== "object") return null;

    const intentRaw = String(parsed.intent ?? "").toLowerCase();
    const intent: BookingParse["intent"] =
      intentRaw === "schedule" ||
      intentRaw === "reschedule" ||
      intentRaw === "cancel" ||
      intentRaw === "availability" ||
      intentRaw === "question"
        ? intentRaw
        : "none";
    const explicitRequest = !!parsed.explicit_request;
    const requested = parsed.requested && typeof parsed.requested === "object" ? parsed.requested : null;
    const day = typeof requested?.day === "string" ? requested.day.trim() : null;
    const timeText = typeof requested?.time_text === "string" ? requested.time_text.trim() : null;
    const timeWindowRaw = typeof requested?.time_window === "string" ? requested.time_window : "unknown";
    const timeWindow: "exact" | "range" | "unknown" =
      timeWindowRaw === "exact" || timeWindowRaw === "range" ? timeWindowRaw : "unknown";
    const referenceRaw = typeof parsed.reference === "string" ? parsed.reference : "none";
    const reference: BookingParse["reference"] =
      referenceRaw === "last_suggested" || referenceRaw === "last_appointment" ? referenceRaw : "none";
    const normalizedTextRaw =
      typeof parsed.normalized_text === "string" ? parsed.normalized_text.trim() : "";
    let normalizedText = normalizedTextRaw;
    if (!normalizedText && day) {
      normalizedText = timeText ? `${day} at ${timeText}` : day;
    }
    const confidence =
      typeof parsed.confidence === "number" && Number.isFinite(parsed.confidence)
        ? Math.max(0, Math.min(1, parsed.confidence))
        : undefined;

    return {
      intent,
      explicitRequest,
      requested: { day, timeText, timeWindow },
      reference,
      normalizedText: normalizedText || null,
      confidence
    };
  } catch {
    return null;
  }
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

  const prompt = [
    "You are a parser for dealership SMS. Return ONLY valid JSON.",
    "Do not include extra text. Do not invent details.",
    "",
    "JSON SCHEMA:",
    "{",
    '  \"intent\": \"callback|test_ride|availability|none\",',
    '  \"explicit_request\": true|false,',
    '  \"availability\": {',
    '    \"model\": \"Road Glide\",',
    '    \"year\": \"2025\",',
    '    \"color\": \"purple\",',
    '    \"stock_id\": \"U123-456\",',
    '    \"condition\": \"new|used|unknown\"',
    "  },",
    '  \"callback\": {',
    '    \"requested\": true|false,',
    '    \"time_text\": \"after 5\",',
    '    \"phone\": \"+15551234567\"',
    "  },",
    '  \"confidence\": 0.0',
    "}",
    "",
    "Guidelines:",
    "- explicit_request is true only if the customer is asking for a call back, test ride, or availability.",
    "- intent=availability if they ask if a bike is available/in stock/still there.",
    "- intent=test_ride if they ask to test ride or demo the bike.",
    "- intent=callback if they ask for a call or ask you to call them.",
    "- If no clear request, intent=none and explicit_request=false.",
    "",
    `Known lead info: ${JSON.stringify({
      model: lead?.vehicle?.model ?? lead?.vehicle?.description ?? null,
      year: lead?.vehicle?.year ?? null,
      color: lead?.vehicle?.color ?? null,
      stockId: lead?.vehicle?.stockId ?? null
    })}`,
    history.length ? `Recent messages:\n${history.join("\n")}` : "Recent messages: (none)",
    `Message: ${text}`
  ].join("\n");

  const runParse = async (model: string): Promise<any | null> => {
    try {
      const resp = await client.responses.create({
        model,
        input: prompt,
        temperature: 0,
        max_output_tokens: 220
      });
      const raw = resp.output_text?.trim() ?? "";
      const parsed = safeParseJson(raw);
      if (!parsed || typeof parsed !== "object") {
        if (debug) {
          console.warn("[llm-intent-parser] parse failed", { model, raw });
        }
        return null;
      }
      return parsed;
    } catch (error) {
      if (debug) {
        const message = error instanceof Error ? error.message : String(error);
        console.error("[llm-intent-parser] request failed", { model, error: message });
      }
      return null;
    }
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
        model: typeof availabilityRaw.model === "string" ? availabilityRaw.model.trim() : null,
        year: typeof availabilityRaw.year === "string" ? availabilityRaw.year.trim() : null,
        color: typeof availabilityRaw.color === "string" ? availabilityRaw.color.trim() : null,
        stockId: typeof availabilityRaw.stock_id === "string" ? availabilityRaw.stock_id.trim() : null,
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
        timeText: typeof callbackRaw.time_text === "string" ? callbackRaw.time_text.trim() : null,
        phone: typeof callbackRaw.phone === "string" ? callbackRaw.phone.trim() : null
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

export async function summarizeVoiceTranscriptWithLLM(args: {
  transcript: string;
  lead?: Conversation["lead"];
}): Promise<string | null> {
  const useLLM =
    process.env.LLM_ENABLED === "1" &&
    process.env.LLM_VOICE_SUMMARIZER_ENABLED === "1" &&
    !!process.env.OPENAI_API_KEY;
  if (!useLLM) return null;

  const raw = String(args.transcript ?? "").trim();
  if (!raw) return null;

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
      temperature: 0,
      max_output_tokens: 180
    });
    const out = resp.output_text?.trim() ?? "";
    const cleaned = stripUnknownYears(out, raw);
    return cleaned || null;
  } catch {
    return null;
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
      temperature: 0,
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
    input
  });

  let draft = (response.output_text || "").trim();
  if (ctx.channel === "sms") {
    draft = sanitizeSmsDraftNoEmail(draft, userAskedForEmail(ctx));
  }
  draft = sanitizePhotoAsk(draft);
  return draft;
}
