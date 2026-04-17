import OpenAI from "openai";
import type {
  CampaignBuildMode,
  CampaignChannel,
  CampaignEntry,
  CampaignSourceHit,
  CampaignTag
} from "./campaignStore.js";
import type { DealerProfile } from "./dealerProfile.js";
import { searchGoogleCse } from "./webFallback.js";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const TAG_SEARCH_HINTS: Record<CampaignTag, string> = {
  sales: "motorcycle deals pricing inventory",
  parts: "motorcycle parts accessories specials",
  apparel: "motorcycle riding gear apparel promotion",
  service: "motorcycle service maintenance offer",
  financing: "motorcycle financing specials APR customer cash",
  national_campaign: "manufacturer national motorcycle campaign",
  dealer_event: "motorcycle dealer event open house demo day"
};

const TAG_LABELS: Record<CampaignTag, string> = {
  sales: "Sales",
  parts: "Parts",
  apparel: "Apparel",
  service: "Service",
  financing: "Financing",
  national_campaign: "National Campaign",
  dealer_event: "Dealer Event"
};

export type GenerateCampaignInput = {
  name: string;
  buildMode: CampaignBuildMode;
  channel: CampaignChannel;
  tags: CampaignTag[];
  prompt?: string;
  description?: string;
  inspirationImageUrls?: string[];
  assetImageUrls?: string[];
  dealerProfile?: DealerProfile | null;
};

export type GenerateCampaignOutput = {
  status: "generated";
  smsBody?: string;
  emailSubject?: string;
  emailBodyText?: string;
  emailBodyHtml?: string;
  sourceHits: CampaignSourceHit[];
  generatedBy: CampaignEntry["generatedBy"];
  metadata: Record<string, unknown>;
};

function normalizeText(value: unknown): string {
  return String(value ?? "").trim();
}

function normalizeUrls(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return Array.from(
    new Set(
      values
        .map(v => normalizeText(v))
        .filter(Boolean)
    )
  );
}

function safeParseJson(raw: string): any | null {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function extractJsonObject(raw: string): any | null {
  const direct = safeParseJson(raw);
  if (direct && typeof direct === "object") return direct;
  const firstBrace = raw.indexOf("{");
  const lastBrace = raw.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return safeParseJson(raw.slice(firstBrace, lastBrace + 1));
  }
  return null;
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

function optionalTextVerbosity(model: string): Record<string, { verbosity: "low" }> {
  return isGpt5Model(model) ? { text: { verbosity: "low" } } : {};
}

function toSourceHits(result: Awaited<ReturnType<typeof searchGoogleCse>>): CampaignSourceHit[] {
  if (!result?.hits?.length) return [];
  return result.hits.slice(0, 8).map(hit => ({
    title: normalizeText(hit.title),
    snippet: normalizeText(hit.snippet),
    url: normalizeText(hit.url),
    domain: normalizeText(hit.domain)
  }));
}

function buildSearchQuery(input: GenerateCampaignInput): string {
  const parts = [
    normalizeText(input.description),
    normalizeText(input.prompt),
    normalizeText(input.name),
    ...input.tags.map(tag => TAG_SEARCH_HINTS[tag] ?? "")
  ]
    .map(v => v.trim())
    .filter(Boolean);

  const base = parts.join(" ").slice(0, 420).trim();
  if (base) return base;
  if (input.tags.includes("financing")) return "motorcycle financing specials";
  if (input.tags.includes("service")) return "motorcycle service offers";
  if (input.tags.includes("parts")) return "motorcycle parts specials";
  if (input.tags.includes("apparel")) return "motorcycle apparel promotion";
  return "motorcycle dealer promotion";
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function textToHtml(text: string, sourceHits: CampaignSourceHit[]): string {
  const paragraphs = text
    .split(/\n{2,}/)
    .map(p => p.trim())
    .filter(Boolean)
    .map(p => `<p style="margin:0 0 12px 0;line-height:1.5;">${escapeHtml(p).replace(/\n/g, "<br/>")}</p>`)
    .join("");
  if (!sourceHits.length) return paragraphs;
  const links = sourceHits
    .slice(0, 4)
    .filter(hit => hit.url)
    .map(hit => {
      const label = escapeHtml(hit.title || hit.domain || hit.url || "Reference");
      const href = escapeHtml(hit.url || "");
      return `<li style="margin:0 0 6px 0;"><a href="${href}" target="_blank" rel="noopener noreferrer">${label}</a></li>`;
    })
    .join("");
  if (!links) return paragraphs;
  return `${paragraphs}<p style="margin:10px 0 6px 0;font-weight:600;">References</p><ul style="margin:0 0 0 18px;padding:0;">${links}</ul>`;
}

function buildTemplateOutput(
  input: GenerateCampaignInput,
  sourceHits: CampaignSourceHit[],
  searchQuery: string
): GenerateCampaignOutput {
  const dealerName = normalizeText(input.dealerProfile?.dealerName) || "our dealership";
  const tagLabels = input.tags.map(tag => TAG_LABELS[tag]).join(", ") || "General";
  const topic = normalizeText(input.description) || normalizeText(input.prompt) || normalizeText(input.name) || "current offers";
  const referenceLine = sourceHits[0]?.url
    ? `You can review details here: ${sourceHits[0].url}`
    : "Reply here and I can share details that fit what you're shopping for.";
  const smsBody = `Quick update from ${dealerName}: ${topic}. ${referenceLine}`;
  const emailSubject = `${dealerName} | ${topic.slice(0, 80)}`;
  const emailBodyText = [
    `Hi there,`,
    ``,
    `Quick campaign update from ${dealerName}.`,
    `${topic}`,
    ``,
    sourceHits[0]?.url ? `Reference: ${sourceHits[0].url}` : "Reply and we can send specific options.",
    ``,
    `Tags: ${tagLabels}`
  ]
    .filter(Boolean)
    .join("\n");

  return {
    status: "generated",
    smsBody,
    emailSubject,
    emailBodyText,
    emailBodyHtml: textToHtml(emailBodyText, sourceHits),
    sourceHits,
    generatedBy: "template",
    metadata: {
      searchQuery,
      sourceCount: sourceHits.length,
      generator: "template"
    }
  };
}

async function tryGenerateWithLlm(args: {
  input: GenerateCampaignInput;
  sourceHits: CampaignSourceHit[];
  searchQuery: string;
}): Promise<GenerateCampaignOutput | null> {
  if (process.env.LLM_ENABLED !== "1" || !process.env.OPENAI_API_KEY) return null;
  const model = process.env.OPENAI_MODEL || "gpt-5-mini";
  const dealerName = normalizeText(args.input.dealerProfile?.dealerName) || "the dealership";
  const website = normalizeText(args.input.dealerProfile?.website);
  const phone = normalizeText(args.input.dealerProfile?.phone);
  const bookingUrl = normalizeText(args.input.dealerProfile?.bookingUrl);
  const tags = args.input.tags.map(tag => TAG_LABELS[tag]).join(", ") || "General";
  const sourceBlock = args.sourceHits.length
    ? args.sourceHits
        .slice(0, 6)
        .map((hit, idx) => `${idx + 1}. ${hit.title || hit.domain || "Reference"} | ${hit.url || ""} | ${hit.snippet || ""}`)
        .join("\n")
    : "(No web references were found)";

  const schema: { [key: string]: unknown } = {
    type: "object",
    additionalProperties: false,
    required: ["sms_body", "email_subject", "email_body_text"],
    properties: {
      sms_body: { type: "string" },
      email_subject: { type: "string" },
      email_body_text: { type: "string" }
    }
  };

  const prompt = [
    "You are creating dealership campaign copy for SMS and Email.",
    "Return only JSON that matches the schema.",
    "Tone: dealership-friendly, human, concise, no hypey spam language.",
    "Do not invent promo details not grounded in the provided context/reference list.",
    "If details are uncertain, say programs vary by approval/term and invite reply.",
    "No emojis unless explicitly in prompt.",
    "",
    `Dealer: ${dealerName}`,
    `Website: ${website || "(not provided)"}`,
    `Phone: ${phone || "(not provided)"}`,
    `Booking URL: ${bookingUrl || "(not provided)"}`,
    `Build mode: ${args.input.buildMode}`,
    `Channel: ${args.input.channel}`,
    `Tags: ${tags}`,
    `Campaign name: ${normalizeText(args.input.name) || "(untitled)"}`,
    `Description: ${normalizeText(args.input.description) || "(none)"}`,
    `Prompt: ${normalizeText(args.input.prompt) || "(none)"}`,
    `Inspiration images: ${normalizeUrls(args.input.inspirationImageUrls).join(", ") || "(none)"}`,
    `Asset images: ${normalizeUrls(args.input.assetImageUrls).join(", ") || "(none)"}`,
    `Web search query: ${args.searchQuery}`,
    "",
    "Reference hits:",
    sourceBlock,
    "",
    "Output requirements:",
    "- sms_body: 1-2 short sentences.",
    "- email_subject: under 75 chars.",
    "- email_body_text: plain text email body with clear CTA."
  ].join("\n");

  const parseObject = (raw: string): any | null => {
    const parsed = extractJsonObject(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  };

  try {
    const parsedResp = await client.responses.parse({
      model,
      input: prompt,
      ...optionalReasoning(model),
      ...optionalTemperature(model, 0.2),
      max_output_tokens: 700,
      text: {
        format: {
          type: "json_schema",
          name: "campaign_copy",
          schema,
          strict: true
        }
      }
    });
    const parsed = ((parsedResp as any)?.output_parsed as any) || parseObject(parsedResp.output_text ?? "");
    if (parsed?.sms_body || parsed?.email_subject || parsed?.email_body_text) {
      const smsBody = normalizeText(parsed.sms_body);
      const emailSubject = normalizeText(parsed.email_subject);
      const emailBodyText = normalizeText(parsed.email_body_text);
      if (smsBody || emailSubject || emailBodyText) {
        return {
          status: "generated",
          smsBody: smsBody || undefined,
          emailSubject: emailSubject || undefined,
          emailBodyText: emailBodyText || undefined,
          emailBodyHtml: emailBodyText ? textToHtml(emailBodyText, args.sourceHits) : undefined,
          sourceHits: args.sourceHits,
          generatedBy: "llm_fallback",
          metadata: {
            searchQuery: args.searchQuery,
            sourceCount: args.sourceHits.length,
            generator: "llm_fallback",
            model
          }
        };
      }
    }
  } catch {
    // fall through to compatibility response call below
  }

  try {
    const resp = await client.responses.create({
      model,
      input: prompt,
      ...optionalReasoning(model),
      ...optionalTextVerbosity(model),
      ...optionalTemperature(model, 0.2),
      max_output_tokens: 700
    });
    const parsed = parseObject(resp.output_text ?? "");
    if (parsed?.sms_body || parsed?.email_subject || parsed?.email_body_text) {
      const smsBody = normalizeText(parsed.sms_body);
      const emailSubject = normalizeText(parsed.email_subject);
      const emailBodyText = normalizeText(parsed.email_body_text);
      if (smsBody || emailSubject || emailBodyText) {
        return {
          status: "generated",
          smsBody: smsBody || undefined,
          emailSubject: emailSubject || undefined,
          emailBodyText: emailBodyText || undefined,
          emailBodyHtml: emailBodyText ? textToHtml(emailBodyText, args.sourceHits) : undefined,
          sourceHits: args.sourceHits,
          generatedBy: "llm_fallback",
          metadata: {
            searchQuery: args.searchQuery,
            sourceCount: args.sourceHits.length,
            generator: "llm_fallback",
            model
          }
        };
      }
    }
  } catch {
    return null;
  }

  return null;
}

export async function generateCampaignContent(input: GenerateCampaignInput): Promise<GenerateCampaignOutput> {
  const searchQuery = buildSearchQuery(input);
  const searchResult = searchQuery
    ? await searchGoogleCse({
        query: searchQuery,
        profile: input.dealerProfile ?? undefined,
        maxResults: 6
      })
    : null;
  const sourceHits = toSourceHits(searchResult);

  const llm = await tryGenerateWithLlm({ input, sourceHits, searchQuery });
  if (llm) return llm;

  return buildTemplateOutput(input, sourceHits, searchQuery);
}
