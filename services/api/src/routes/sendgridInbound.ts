import type { Request, Response } from "express";
import multer from "multer";
import twilio from "twilio";
import { XMLParser } from "fast-xml-parser";
import { extractAdfXmlFromEmail, parseAdfXml } from "../domain/adfParser.js";
import {
  upsertConversationByLeadKey,
  createConversationForLeadKey,
  appendInbound,
  isDuplicateInboundEvent,
  appendOutbound,
  mergeConversationLead,
  setConversationClassification,
  updateHoldingFromInbound,
  confirmAppointmentIfMatchesSuggested,
  startFollowUpCadence,
  scheduleLongTermFollowUp,
  discardPendingDrafts,
  getAllConversations,
  findConversationsByLeadKey,
  getPricingAttempts,
  incrementPricingAttempt,
  addTodo,
  addCallTodoIfMissing,
  setFollowUpMode,
  pauseFollowUpCadence,
  stopFollowUpCadence,
  markPricingEscalated,
  closeConversation,
  setContactPreference,
  normalizeLeadKey,
  getConversation,
  saveConversation,
  flushConversationStore,
  listOpenQuestions,
  markQuestionDone
} from "../domain/conversationStore.js";
import type { InventoryWatch } from "../domain/conversationStore.js";
import { orchestrateInbound } from "../domain/orchestrator.js";
import { resolveChannel, resolveLeadRule } from "../domain/leadSourceRules.js";
import {
  parseDialogActWithLLM,
  parseInventoryEntitiesWithLLM,
  parseIntentWithLLM,
  parseResponseControlWithLLM,
  parseJourneyIntentWithLLM,
  parseWalkInOutcomeWithLLM
} from "../domain/llmDraft.js";
import type { InboundMessageEvent } from "../domain/types.js";
import { getSchedulerConfig, getPreferredSalespeople } from "../domain/schedulerConfig.js";
import { getAuthedCalendarClient, insertEvent, queryFreeBusy } from "../domain/googleCalendar.js";
import {
  expandBusyBlocks,
  findExactSlotForSalesperson,
  formatSlotLocal,
  generateCandidateSlots,
  localPartsToUtcDate
} from "../domain/schedulerEngine.js";
import { getDealerProfile } from "../domain/dealerProfile.js";
import { getInventoryNote } from "../domain/inventoryNotes.js";
import { getInventoryFeed, hasInventoryForModelYear, findInventoryMatches } from "../domain/inventoryFeed.js";
import { resolveInventoryUrlByStock } from "../domain/inventoryUrlResolver.js";
import { getAllModels } from "../domain/modelsByYear.js";
import { shouldRouteRoom58PriceHandoff } from "../domain/adfPolicy.js";
import { isResponseControlParserAccepted } from "../domain/transitionSafety.js";
import { listUsers } from "../domain/userStore.js";

function base64UrlDecode(input: string): string | null {
  try {
    const padded = input.replace(/-/g, "+").replace(/_/g, "/");
    const padLen = padded.length % 4;
    const withPad = padLen ? padded + "=".repeat(4 - padLen) : padded;
    return Buffer.from(withPad, "base64").toString("utf8");
  } catch {
    return null;
  }
}

function base64UrlEncode(input: string): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/=+$/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function extractLeadKeyFromTaggedEmail(addr?: string | null): string | null {
  if (!addr) return null;
  const email = extractEmailAddress(addr);
  if (!email) return null;
  const m = email.match(/^([^+]+)\+([^@]+)@(.+)$/);
  if (!m) return null;
  const domain = m[3].toLowerCase();
  if (domain !== "inbound.leadrider.ai") return null;
  return base64UrlDecode(m[2]);
}

function maybeTagReplyTo(replyTo: string | undefined, conv: any): string | undefined {
  if (!replyTo) return replyTo;
  if (!/@inbound\.leadrider\.ai$/i.test(replyTo)) return replyTo;
  const id = String(conv?.id ?? conv?.leadKey ?? "").trim();
  if (!id) return replyTo;
  const tag = base64UrlEncode(id);
  const [local, domain] = replyTo.split("@");
  if (!local || !domain) return replyTo;
  return `${local}+${tag}@${domain}`;
}

function normalizeModelToken(raw: string): string {
  return String(raw ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function toTitleCase(input: string): string {
  return input
    .toLowerCase()
    .replace(/\b\w/g, char => char.toUpperCase());
}

function normalizeDisplayCase(raw?: string | null): string {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed) return "";
  const letters = trimmed.replace(/[^A-Za-z]/g, "");
  if (!letters) return trimmed;
  return letters === letters.toUpperCase() ? toTitleCase(trimmed) : trimmed;
}

function pickFirstToken(raw: string | null | undefined): string {
  return String(raw ?? "")
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)[0] ?? "";
}

function normalizePhoneE164(raw: string | null | undefined): string {
  const digits = String(raw ?? "").replace(/\D/g, "");
  if (!digits) return "";
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.startsWith("+")) return digits;
  return digits.length >= 11 ? `+${digits}` : "";
}

async function sendInternalSalespersonSms(
  toNumberRaw: string | null | undefined,
  body: string
): Promise<{ sent: boolean; sid?: string; reason?: string }> {
  const to = normalizePhoneE164(toNumberRaw);
  const from = normalizePhoneE164(String(process.env.TWILIO_FROM_NUMBER ?? "").trim());
  const accountSid = String(process.env.TWILIO_ACCOUNT_SID ?? "").trim();
  const authToken = String(process.env.TWILIO_AUTH_TOKEN ?? "").trim();
  if (!to || !to.startsWith("+")) return { sent: false, reason: "invalid_to_number" };
  if (!from || !from.startsWith("+") || !accountSid || !authToken) {
    return { sent: false, reason: "twilio_not_configured" };
  }
  try {
    const client = twilio(accountSid, authToken);
    const msg = await client.messages.create({ from, to, body: String(body ?? "").trim() });
    return { sent: true, sid: String(msg.sid ?? "") || undefined };
  } catch (e: any) {
    return { sent: false, reason: String(e?.message ?? "send_failed") };
  }
}

function isStickyClosedJourney(conv: any): boolean {
  const closedReason = String(conv?.closedReason ?? "").toLowerCase();
  return (
    conv?.status === "closed" &&
    (closedReason === "sold" ||
      /\bhold\b/.test(closedReason) ||
      !!conv?.sale?.soldAt ||
      !!conv?.hold?.key ||
      conv?.followUpCadence?.kind === "post_sale")
  );
}

function isStrictSalesTradeBucket(bucket?: string | null): boolean {
  const normalized = String(bucket ?? "").trim().toLowerCase();
  return (
    normalized === "inventory_interest" ||
    normalized === "trade_in_sell" ||
    normalized === "test_ride" ||
    normalized === "finance_prequal"
  );
}

function normalizeModelForMatch(modelRaw: string, makeRaw?: string | null): string {
  const base = normalizeModelToken(modelRaw);
  if (!base) return "";
  const makeNorm = normalizeModelToken(makeRaw ?? "");
  if (!makeNorm) return base;
  const makeTokens = new Set(makeNorm.split(" ").filter(Boolean));
  const filtered = base
    .split(" ")
    .filter(t => t && !makeTokens.has(t))
    .join(" ")
    .trim();
  return filtered || base;
}

function isGenericLeadModel(modelText: string): boolean {
  const t = modelText.trim().toLowerCase();
  return !t || /^(other|full line|full lineup|null)$/.test(t);
}

const MODEL_NOISE_TOKENS = new Set([
  "a",
  "an",
  "the",
  "and",
  "or",
  "for",
  "with",
  "on",
  "in",
  "about",
  "all",
  "pricing",
  "price",
  "details",
  "detail",
  "request",
  "quote",
  "interested",
  "looking",
  "like",
  "want",
  "would",
  "please",
  "just",
  "bike",
  "motorcycle",
  "color",
  "trim",
  "black",
  "white",
  "gray",
  "grey",
  "blue",
  "red",
  "orange"
]);

const MODEL_VARIANT_TOKENS = new Set([
  "cvo",
  "st",
  "special",
  "limited",
  "classic",
  "anniversary",
  "anv",
  "se",
  "trim",
  "chrome",
  "black",
  "blacked",
  "blackedout",
  "edition"
]);

let knownModelByKeyCache: Map<string, string> | null = null;

function tokenizeModelWords(input?: string | null): string[] {
  if (!input) return [];
  return String(input)
    .toLowerCase()
    .replace(/\bharley[-\s]?davidson\b/g, " ")
    .replace(/\bh[-\s]?d\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .map(tok => tok.trim())
    .filter(Boolean)
    .filter(tok => !MODEL_NOISE_TOKENS.has(tok));
}

function canonicalModelKeyFromTokens(tokens: string[]): string {
  if (!tokens.length) return "";
  const uniq = Array.from(new Set(tokens.map(t => t.trim()).filter(Boolean)));
  if (!uniq.length) return "";
  return uniq.sort((a, b) => a.localeCompare(b)).join(" ");
}

function canonicalModelKey(input?: string | null): string {
  return canonicalModelKeyFromTokens(tokenizeModelWords(input));
}

function normalizeModelBaseTokens(input?: string | null): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const tok of tokenizeModelWords(input)) {
    if (!tok) continue;
    if (/^\d+$/.test(tok)) continue;
    if (MODEL_VARIANT_TOKENS.has(tok)) continue;
    if (seen.has(tok)) continue;
    seen.add(tok);
    out.push(tok);
  }
  return out;
}

function modelsLikelySameFamilyForAdfMismatch(
  leadModel?: string | null,
  inquiryModel?: string | null
): boolean {
  const leadKey = canonicalModelKey(leadModel);
  const inquiryKey = canonicalModelKey(inquiryModel);
  if (leadKey && inquiryKey && leadKey === inquiryKey) return true;

  const leadBase = normalizeModelBaseTokens(leadModel);
  const inquiryBase = normalizeModelBaseTokens(inquiryModel);
  if (!leadBase.length || !inquiryBase.length) return false;

  const leadSet = new Set(leadBase);
  const inquirySet = new Set(inquiryBase);
  const leadInInquiry = leadBase.every(tok => inquirySet.has(tok));
  const inquiryInLead = inquiryBase.every(tok => leadSet.has(tok));

  if (leadInInquiry && inquiryInLead) return true;

  const shorterLen = Math.min(leadBase.length, inquiryBase.length);
  if (shorterLen >= 2 && (leadInInquiry || inquiryInLead)) return true;

  if (shorterLen === 1 && (leadInInquiry || inquiryInLead)) {
    const token = leadBase.length === 1 ? leadBase[0] : inquiryBase[0];
    if (token.length >= 7) return true;
  }

  return false;
}

function getKnownModelByKey(): Map<string, string> {
  if (knownModelByKeyCache) return knownModelByKeyCache;
  const byKey = new Map<string, string>();
  for (const rawModel of getAllModels()) {
    const clean = normalizeVehicleModel(rawModel, null) ?? normalizeDisplayCase(rawModel);
    if (!clean || isGenericLeadModel(clean)) continue;
    const key = canonicalModelKey(clean);
    if (!key) continue;
    const current = byKey.get(key);
    if (!current || clean.length > current.length) {
      byKey.set(key, clean);
    }
  }
  knownModelByKeyCache = byKey;
  return byKey;
}

function extractInquiryModelMentions(inquiry?: string | null): Array<{ key: string; label: string; index: number; len: number }> {
  const tokens = tokenizeModelWords(inquiry);
  if (!tokens.length) return [];
  const modelsByKey = getKnownModelByKey();
  if (!modelsByKey.size) return [];
  const mentions = new Map<string, { key: string; label: string; index: number; len: number }>();
  const maxNgram = Math.min(5, tokens.length);
  for (let i = 0; i < tokens.length; i += 1) {
    for (let len = 1; len <= maxNgram && i + len <= tokens.length; len += 1) {
      const key = canonicalModelKeyFromTokens(tokens.slice(i, i + len));
      if (!key) continue;
      const label = modelsByKey.get(key);
      if (!label) continue;
      const current = mentions.get(key);
      if (!current || len > current.len || (len === current.len && i < current.index)) {
        mentions.set(key, { key, label, index: i, len });
      }
    }
  }
  return Array.from(mentions.values()).sort((a, b) => b.len - a.len || a.index - b.index);
}

function detectInitialAdfModelMismatch(args: {
  leadModel?: string | null;
  leadMake?: string | null;
  inquiry?: string | null;
}): { leadModel: string; inquiryModel: string } | null {
  const leadModelNormalized =
    normalizeVehicleModel(args.leadModel ?? "", args.leadMake ?? null) ??
    normalizeDisplayCase(args.leadModel ?? "");
  if (!leadModelNormalized || isGenericLeadModel(leadModelNormalized)) return null;
  const leadKey = canonicalModelKey(leadModelNormalized);
  if (!leadKey) return null;
  const mentions = extractInquiryModelMentions(args.inquiry);
  if (!mentions.length) return null;
  const mismatch = mentions.find(
    m => m.key !== leadKey && !modelsLikelySameFamilyForAdfMismatch(leadModelNormalized, m.label)
  );
  if (!mismatch) return null;
  return { leadModel: leadModelNormalized, inquiryModel: mismatch.label };
}

function extractDayPartRequest(text: string): { dayLabel: string; dayPart: string } | null {
  const t = String(text ?? "").toLowerCase();
  const dayMatch = t.match(/\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/);
  const partMatch = t.match(/\b(morning|afternoon|evening|tonight)\b/);
  if (!dayMatch || !partMatch) return null;
  const dayLabel = dayMatch[1].replace(/^\w/, c => c.toUpperCase());
  let dayPart = partMatch[1];
  if (dayPart === "tonight") dayPart = "evening";
  return { dayLabel, dayPart };
}

type LeadInventoryMediaPick = {
  mediaUrls: string[];
  year?: string;
  model?: string;
  color?: string;
};

async function pickLeadInventoryMedia(conv: any): Promise<LeadInventoryMediaPick | undefined> {
  try {
    const modelRaw =
      conv?.lead?.vehicle?.model ??
      conv?.lead?.vehicle?.description ??
      (conv?.lead as any)?.vehicleDescription ??
      "";
    const modelText = String(modelRaw ?? "").trim();
    if (isGenericLeadModel(modelText)) return undefined;

    const items = await getInventoryFeed();
    if (!items.length) return undefined;

    const leadStock = String(conv?.lead?.vehicle?.stockId ?? "").trim().toLowerCase();
    const leadVin = String(conv?.lead?.vehicle?.vin ?? "").trim().toLowerCase();
    if (leadStock || leadVin) {
      const direct = items.find(
        i =>
          (leadStock && (i.stockId ?? "").toLowerCase() === leadStock) ||
          (leadVin && (i.vin ?? "").toLowerCase() === leadVin)
      );
      const url = direct?.images?.find(u => /^https?:\/\//i.test(u));
      if (url) {
        return {
          mediaUrls: [url],
          year: direct?.year,
          model: direct?.model,
          color: direct?.color
        };
      }
    }

    const modelNorm = normalizeModelForMatch(modelText, conv?.lead?.vehicle?.make ?? "");
    if (!modelNorm) return undefined;
    const makeNorm = normalizeModelToken(conv?.lead?.vehicle?.make ?? "");
    const yearText = String(conv?.lead?.vehicle?.year ?? "").trim();
    const colorNorm = normalizeModelToken(conv?.lead?.vehicle?.color ?? "");

    let best: { score: number; url: string; item: any } | null = null;
    for (const item of items) {
      const itemModel = String(item.model ?? "").trim();
      if (!itemModel) continue;
      const itemModelNorm = normalizeModelForMatch(itemModel, item.make ?? "");
      if (!itemModelNorm) continue;
      const hasImages = Array.isArray(item.images) && item.images.length > 0;
      if (!hasImages) continue;

      let score = 0;
      if (itemModelNorm === modelNorm) score += 4;
      else continue;

      if (yearText) {
        if (String(item.year ?? "").trim() !== yearText) continue;
        score += 1;
      }
      if (makeNorm) {
        const itemMakeNorm = normalizeModelToken(item.make ?? "");
        if (itemMakeNorm && (itemMakeNorm.includes(makeNorm) || makeNorm.includes(itemMakeNorm))) {
          score += 1;
        }
      }
      if (colorNorm) {
        const itemColorNorm = normalizeModelToken(item.color ?? "");
        if (itemColorNorm && itemColorNorm.includes(colorNorm)) score += 1;
      }

      const url = item.images?.find(u => /^https?:\/\//i.test(u));
      if (!url) continue;
      if (!best || score > best.score) {
        best = { score, url, item };
      }
    }

    if (!best?.url) return undefined;
    return {
      mediaUrls: [best.url],
      year: best.item?.year,
      model: best.item?.model,
      color: best.item?.color
    };
  } catch {
    return undefined;
  }
}

function buildInitialPhotoLine(conv: any, pick?: LeadInventoryMediaPick): string | null {
  if (!pick?.mediaUrls?.length) return null;
  const modelRaw =
    pick.model ??
    conv?.lead?.vehicle?.model ??
    conv?.lead?.vehicle?.description ??
    (conv?.lead as any)?.vehicleDescription ??
    "";
  const modelText = String(modelRaw ?? "").trim();
  if (isGenericLeadModel(modelText)) return null;
  const yearText = String(pick.year ?? conv?.lead?.vehicle?.year ?? "").trim();
  const colorText = String(pick.color ?? conv?.lead?.vehicle?.color ?? "").trim();
  const label = [yearText, modelText].filter(Boolean).join(" ").trim();
  if (!label) return null;
  const colorPart = colorText ? ` in ${colorText}` : "";
  return `Here’s a photo of a ${label}${colorPart} we have in stock.`;
}

function inferAppointmentTypeFromConv(conv: any): string | null {
  const bucket = conv?.classification?.bucket ?? "";
  const cta = conv?.classification?.cta ?? "";
  if (bucket === "test_ride" || cta === "schedule_test_ride") return "test_ride";
  if (bucket === "trade_in_sell" || cta === "value_my_trade" || cta === "trade_in_value") return "trade_appraisal";
  if (bucket === "finance_prequal" || /prequal|credit|finance|hdfs/i.test(cta)) return "finance_discussion";
  return "inventory_visit";
}

function buildBookingUrlForLead(baseUrl: string | undefined | null, conv: any): string | null {
  const raw = (baseUrl ?? "").trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    const proto = String(url.protocol ?? "").toLowerCase();
    if (proto !== "http:" && proto !== "https:") return null;
    const pathLower = String(url.pathname ?? "").toLowerCase();
    if (/\/(?:api\/)?auth\/me\/?$/.test(pathLower)) return null;
    if (/^\/api\//.test(pathLower)) return null;
    const type = inferAppointmentTypeFromConv(conv);
    const firstName = conv?.lead?.firstName ?? "";
    const lastName = conv?.lead?.lastName ?? "";
    const email = conv?.lead?.email ?? "";
    const phone = conv?.lead?.phone ?? "";
    const leadKey = conv?.leadKey ?? "";
    if (type) url.searchParams.set("type", type);
    if (firstName) url.searchParams.set("firstName", firstName);
    if (lastName) url.searchParams.set("lastName", lastName);
    if (email) url.searchParams.set("email", email);
    if (phone) url.searchParams.set("phone", phone);
    if (leadKey) url.searchParams.set("leadKey", leadKey);
    return url.toString();
  } catch {
    return null;
  }
}

function formatModelLabel(year?: string | null, model?: string | null): string | null {
  if (!model) return null;
  const clean = normalizeDisplayCase(model);
  if (!clean || /full line|other/i.test(clean)) return null;
  return year ? `${year} ${clean}` : clean;
}

async function getLeadInventoryMatchStatus(
  conv: any
): Promise<"in_stock" | "not_found" | "unknown"> {
  try {
    const modelRaw =
      conv?.lead?.vehicle?.model ??
      conv?.lead?.vehicle?.description ??
      (conv?.lead as any)?.vehicleDescription ??
      "";
    const modelText = String(modelRaw ?? "").trim();
    if (isGenericLeadModel(modelText)) return "unknown";
    const items = await getInventoryFeed();
    if (!items.length) return "unknown";

    const leadStock = String(conv?.lead?.vehicle?.stockId ?? "").trim().toLowerCase();
    const leadVin = String(conv?.lead?.vehicle?.vin ?? "").trim().toLowerCase();
    if (leadStock || leadVin) {
      const direct = items.find(
        i =>
          (leadStock && (i.stockId ?? "").toLowerCase() === leadStock) ||
          (leadVin && (i.vin ?? "").toLowerCase() === leadVin)
      );
      if (direct) return "in_stock";
      if (leadStock) {
        try {
          const resolved = await resolveInventoryUrlByStock(leadStock);
          if (resolved.ok) return "in_stock";
        } catch {}
      }
      return "not_found";
    }

    const modelNorm = normalizeModelForMatch(modelText, conv?.lead?.vehicle?.make ?? "");
    if (!modelNorm) return "unknown";
    const yearText = String(conv?.lead?.vehicle?.year ?? "").trim();
    const matches = items.filter(item => {
      const itemModel = String(item.model ?? "").trim();
      if (!itemModel) return false;
      const itemModelNorm = normalizeModelForMatch(itemModel, item.make ?? "");
      if (!itemModelNorm) return false;
      if (itemModelNorm !== modelNorm) return false;
      if (yearText) return String(item.year ?? "").trim() === yearText;
      return true;
    });
    return matches.length ? "in_stock" : "not_found";
  } catch {
    return "unknown";
  }
}

function buildInitialAvailabilityLine(
  status: "in_stock" | "not_found" | "unknown",
  conv: any
): string | null {
  if (status === "unknown") return null;
  const modelLabel = formatModelLabel(
    conv?.lead?.vehicle?.year ?? conv?.lead?.year ?? null,
    conv?.lead?.vehicle?.model ?? conv?.lead?.vehicle?.description ?? null
  );
  if (!modelLabel) return null;
  if (status === "in_stock") {
    return `I saw you wanted to learn more about the ${modelLabel}. Are you interested in checking it out?`;
  }
  return `I’m not seeing a ${modelLabel} in stock right now. If you want to stop in, I can go over options, or I can keep an eye out for you.`;
}

function isTestRideSeason(profile: any, now: Date): boolean {
  const enabled = profile?.followUp?.testRideEnabled;
  if (enabled === false) return false;
  const months: number[] = Array.isArray(profile?.followUp?.testRideMonths)
    ? profile.followUp.testRideMonths
    : [4, 5, 6, 7, 8, 9, 10];
  const current = now.getMonth() + 1;
  return months.includes(current);
}

function parsePreferredDateOnly(value: string | null | undefined): Date | null {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const m = raw.match(/^(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?$/);
  if (!m) return null;
  const month = Number(m[1]);
  const day = Number(m[2]);
  let year = m[3] ? Number(m[3]) : new Date().getUTCFullYear();
  if (m[3] && m[3].length === 2) year = 2000 + year;
  if (
    !Number.isFinite(month) ||
    !Number.isFinite(day) ||
    !Number.isFinite(year) ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31
  ) {
    return null;
  }
  return new Date(Date.UTC(year, month - 1, day, 12, 0, 0, 0));
}

function buildInitialEmailDraft(
  conv: any,
  dealerProfile: any,
  inventoryNote?: string | null,
  buildInventoryAvailable?: boolean | null
): string {
  const rawName =
    normalizeDisplayCase(conv?.lead?.firstName) ||
    normalizeDisplayCase(conv?.lead?.name) ||
    "there";
  const name = rawName.split(" ")[0] || "there";
  const dealerName = dealerProfile?.dealerName ?? "American Harley-Davidson";
  const agentName = dealerProfile?.agentName ?? "our team";
  const bookingUrl = buildBookingUrlForLead(dealerProfile?.bookingUrl, conv);
  const model = formatModelLabel(conv?.lead?.vehicle?.year ?? conv?.lead?.year, conv?.lead?.vehicle?.model ?? conv?.lead?.vehicle?.description);
  const leadSourceLower = (conv?.lead?.source ?? conv?.leadSource ?? "").toLowerCase();
  const isCustomBuild = /custom build/.test(leadSourceLower);
  const isTestRide =
    conv?.classification?.bucket === "test_ride" || conv?.classification?.cta === "schedule_test_ride";
  const thanks = isTestRide
    ? model
      ? `Thanks for your interest in a test ride on the ${model}.`
      : "Thanks for your interest in a test ride."
    : isCustomBuild
      ? model
        ? `Thanks for building your ${model} online.`
        : "Thanks for your custom build request."
      : model
        ? `Thanks for your interest in the ${model}.`
        : "Thanks for your interest.";
  const intro = `This is ${agentName} at ${dealerName}.`;
  const help = "I’m happy to help with pricing, options, and availability.";
  const noteLine = inventoryNote ? `Right now there’s ${inventoryNote} available.` : "";
  const buildLine = isCustomBuild
    ? buildInventoryAvailable
      ? "We do have one in stock if you’d like to check it out. I can also walk you through build options and next steps."
      : "I can walk you through build options and next steps."
    : "";
  const visit = isCustomBuild
    ? buildInventoryAvailable
      ? "If you want to stop in to check it out and go over build options, you can book an appointment below."
      : "If you want to stop in to go over build options, you can book an appointment below."
    : model
      ? "If you want to stop in to check out the bike and go over options, you can book an appointment below."
      : "If you want to stop in to go over options, you can book an appointment below.";
  const bookingLine = bookingUrl
    ? `You can book an appointment here: ${bookingUrl}`
    : "Just reply with a day and time that works for you.";
  const extra = "If a walkaround or extra photos would help, just let me know.";

  return `Hi ${name},\n\n${thanks} ${intro} ${help} ${noteLine} ${buildLine} ${visit}\n\n${bookingLine}\n\n${extra}`.replace(/\s+\n/g, "\n").trim();
}

function appendFallbackEmailSignoff(body: string, profile: any): string {
  const text = String(body ?? "").trim();
  if (!text) return text;
  const agent = String(profile?.agentName ?? "").trim() || "Sales Team";
  const dealer = String(profile?.dealerName ?? "").trim() || "American Harley-Davidson";
  if (/\n\s*(best|thanks|thank you|regards|sincerely)\s*,?\s*$/i.test(text)) {
    return `${text}\n${agent}\n${dealer}`;
  }
  return `${text}\n\nBest,\n${agent}\n${dealer}`;
}
import { getSystemMode } from "../domain/settingsStore.js";
import { sendEmail } from "../domain/emailSender.js";
import { upsertContact } from "../domain/contactsStore.js";

const upload = multer({ storage: multer.memoryStorage() });
export const sendgridInboundMiddleware = upload.any();

function text(v: any): string | undefined {
  if (v == null) return undefined;
  if (typeof v === "string") return v.trim();
  if (typeof v === "number") return String(v);
  if (typeof v === "object" && typeof v["#text"] === "string") return v["#text"].trim();
  return undefined;
}

function attr(v: any, name: string): string | undefined {
  if (!v || typeof v !== "object") return undefined;
  const direct = v[`@_${name}`] ?? v[name];
  if (typeof direct === "string") return direct.trim();
  return undefined;
}

function pickNameValue(v: any): string | undefined {
  if (!v) return undefined;
  const list = Array.isArray(v) ? v : [v];
  for (const n of list) {
    if (typeof n === "string") return n.trim();
    if (typeof n === "object") {
      if (typeof n["#text"] === "string") return n["#text"].trim();
      if (typeof n.full === "string") return n.full.trim();
      if (typeof n.first === "string" || typeof n.last === "string") {
        const f = typeof n.first === "string" ? n.first.trim() : "";
        const l = typeof n.last === "string" ? n.last.trim() : "";
        const joined = `${f} ${l}`.trim();
        if (joined) return joined;
      }
    }
  }
  return undefined;
}

function decodeQuotedPrintable(input: string): string {
  if (!input) return "";
  const softBreak = input.replace(/=\s*\r?\n/g, "");
  return softBreak.replace(/=([A-Fa-f0-9]{2})/g, (_m, hex) =>
    String.fromCharCode(parseInt(hex, 16))
  );
}

function fixMojibake(input?: string | null): string {
  if (!input) return "";
  if (!/[ÃÂâ\u0080-\u009f]/.test(input)) return input;
  try {
    return Buffer.from(input, "latin1").toString("utf8");
  } catch {
    return input;
  }
}

function extractYearRangeFromText(text?: string | null): { min: number; max: number } | null {
  if (!text) return null;
  const t = String(text).toLowerCase();
  const range = t.match(/\b(20\d{2})\s*(?:-|to)\s*(20\d{2})\b/);
  if (range) {
    const a = Number(range[1]);
    const b = Number(range[2]);
    if (Number.isFinite(a) && Number.isFinite(b)) {
      return { min: Math.min(a, b), max: Math.max(a, b) };
    }
  }
  const shortRange = t.match(/\b(20\d{2})\s*-\s*(\d{2})\b/);
  if (shortRange) {
    const a = Number(shortRange[1]);
    const b = Number(`20${shortRange[2]}`);
    if (Number.isFinite(a) && Number.isFinite(b)) {
      return { min: Math.min(a, b), max: Math.max(a, b) };
    }
  }
  const years = Array.from(t.matchAll(/\b(20\d{2})\b/g)).map(m => Number(m[1]));
  if (years.length >= 2) {
    const min = Math.min(...years);
    const max = Math.max(...years);
    if (Number.isFinite(min) && Number.isFinite(max)) return { min, max };
  }
  return null;
}

function extractSingleYearFromText(text?: string | null): number | undefined {
  if (!text) return undefined;
  const t = String(text).toLowerCase();
  const m = t.match(/\b(20\d{2})\b/);
  if (!m) return undefined;
  const year = Number(m[1]);
  if (!Number.isFinite(year)) return undefined;
  return year;
}

function isoDaysFromNow(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + Math.max(1, Math.round(days)));
  return d.toISOString();
}

function parsePriceToken(raw?: string | null): number | null {
  if (!raw) return null;
  const t = String(raw).toLowerCase().replace(/[$,\s]/g, "");
  const m = t.match(/^(\d+(?:\.\d+)?)(k)?$/);
  if (!m) return null;
  const base = Number(m[1]);
  if (!Number.isFinite(base)) return null;
  return Math.round((m[2] ? base * 1000 : base));
}

function extractPriceRangeFromText(text?: string | null): { minPrice?: number; maxPrice?: number } | null {
  if (!text) return null;
  const t = String(text).toLowerCase();

  const between = t.match(
    /\b(?:between|from)\s*\$?\s*(\d+(?:[.,]\d+)?\s*k?)\s*(?:and|to|-)\s*\$?\s*(\d+(?:[.,]\d+)?\s*k?)\b/
  );
  if (between) {
    const a = parsePriceToken(between[1].replace(",", ""));
    const b = parsePriceToken(between[2].replace(",", ""));
    if (a && b) {
      return { minPrice: Math.min(a, b), maxPrice: Math.max(a, b) };
    }
  }

  const under = t.match(/\b(?:under|below|up to|max(?:imum)?|no more than)\s*\$?\s*(\d+(?:[.,]\d+)?\s*k?)\b/);
  if (under) {
    const p = parsePriceToken(under[1].replace(",", ""));
    if (p) return { maxPrice: p };
  }
  const trailingMax = t.match(/\$?\s*(\d+(?:[.,]\d+)?\s*k?)\s*(?:max(?:imum)?|or less|or under|or below)\b/);
  if (trailingMax) {
    const p = parsePriceToken(trailingMax[1].replace(",", ""));
    if (p) return { maxPrice: p };
  }

  const over = t.match(/\b(?:over|above|at least|min(?:imum)?|starting at)\s*\$?\s*(\d+(?:[.,]\d+)?\s*k?)\b/);
  if (over) {
    const p = parsePriceToken(over[1].replace(",", ""));
    if (p) return { minPrice: p };
  }
  const around = t.match(
    /\b(?:around|about|roughly|close to|near|in the)\s*\$?\s*(\d+(?:[.,]\d+)?\s*k?)\s*(?:range)?\b/
  );
  if (around) {
    const p = parsePriceToken(around[1].replace(",", ""));
    if (p && p > 0) {
      const spread = Math.max(1000, Math.round(p * 0.1));
      return { minPrice: Math.max(0, p - spread), maxPrice: p + spread };
    }
  }

  const dollar = t.match(/\$\s*(\d{2,3}(?:,\d{3})+|\d{4,6})\b/);
  if (dollar) {
    const p = parsePriceToken(dollar[1].replace(",", ""));
    if (p) return { maxPrice: p };
  }
  return null;
}

function extractWalkInModelHint(text?: string | null): string | undefined {
  const t = String(text ?? "").toLowerCase();
  if (!t) return undefined;
  if (/\b(sportster|xl883c|xl\s*883|883)\b/.test(t)) return "Sportster";
  if (/\b(road glide\s*(3|iii)|fltrt)\b/.test(t)) return "Road Glide 3";
  if (/\b(street glide\s*(3|iii)|flhlt)\b/.test(t)) return "Street Glide 3 Limited";
  return undefined;
}

function extractTrimFromText(text?: string | null): string | undefined {
  if (!text) return undefined;
  const t = String(text).toLowerCase();
  const m = t.match(/\b(cvo|st|special|limited|ultra|anniversary|standard|blacked[-\s]?out|chrome)\b/);
  if (!m) return undefined;
  const raw = m[1].replace(/\s+/g, " ").trim();
  if (raw === "blackedout" || raw === "blacked-out") return "blacked-out";
  return raw;
}

function extractColorFromText(text?: string | null): string | undefined {
  if (!text) return undefined;
  const t = String(text).toLowerCase();
  const colorTokens = [
    "black",
    "white",
    "red",
    "blue",
    "green",
    "gray",
    "grey",
    "silver",
    "orange",
    "yellow",
    "brown",
    "tan"
  ];
  for (const color of colorTokens) {
    if (new RegExp(`\\b${color}\\b`, "i").test(t)) return color === "grey" ? "gray" : color;
  }
  const m = t.match(/\bcolor\s*(?:is|:)?\s*([a-z]+)\b/);
  if (m?.[1]) return m[1];
  return undefined;
}

function extractEmailAddress(input?: string): string | undefined {
  if (!input) return undefined;
  const m = String(input)
    .trim()
    .match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return m?.[0]?.toLowerCase();
}

function stripHtml(input?: string): string | undefined {
  if (!input) return undefined;
  const withBreaks = input.replace(/<\s*br\s*\/?>/gi, "\n").replace(/<\/p>/gi, "\n");
  const stripped = withBreaks.replace(/<[^>]+>/g, " ").replace(/\s+\n/g, "\n");
  const cleaned = stripped.replace(/\n{3,}/g, "\n\n").trim();
  return cleaned || undefined;
}

function looksLikeMime(raw?: string | null): boolean {
  if (!raw) return false;
  return /(received:|arc-|dkim-|mime-version:|content-type:|content-transfer-encoding:|message-id:)/i.test(raw);
}

function extractPlainTextFromMime(raw?: string | null): string | null {
  if (!raw) return null;
  const boundaryMatch =
    raw.match(/boundary="([^"]+)"/i) || raw.match(/boundary=([^\s;]+)/i);
  const boundary = boundaryMatch?.[1];
  if (!boundary) return null;
  const parts = raw.split(new RegExp(`\\r?\\n--${boundary}`));
  for (const part of parts) {
    if (!/content-type:\s*text\/plain/i.test(part)) continue;
    let bodyStart = part.indexOf("\r\n\r\n");
    if (bodyStart >= 0) bodyStart += 4;
    else {
      bodyStart = part.indexOf("\n\n");
      if (bodyStart >= 0) bodyStart += 2;
    }
    const bodyRaw = bodyStart > 0 ? part.slice(bodyStart) : part;
    const decoded = /quoted-printable/i.test(part)
      ? decodeQuotedPrintable(bodyRaw)
      : bodyRaw;
    const cleaned = decoded.replace(/\r\n/g, "\n").trim();
    if (cleaned) return cleaned;
  }
  return null;
}

function stripQuotedReply(input?: string | null): string {
  if (!input) return "";
  const lines = input.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let inHeaderBlock = false;
  const joined = lines.join(" ");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      if (inHeaderBlock) {
        inHeaderBlock = false;
      } else {
        out.push("");
      }
      continue;
    }
    if (/^>/.test(trimmed)) break;
    if (/^on .+wrote:$/i.test(trimmed)) break;
    if (/^-----original message-----/i.test(trimmed)) break;
    if (/^from:\s.+/i.test(trimmed) && /sent:\s.+/i.test(joined)) break;
    if (/^(subject|received|arc-|dkim-|mime-version|content-type|content-transfer-encoding|message-id|from|to|cc|date):/i.test(trimmed)) {
      inHeaderBlock = true;
      continue;
    }
    if (inHeaderBlock && /^\s/.test(line)) continue;
    if (inHeaderBlock) inHeaderBlock = false;
    out.push(line);
  }
  return out
    .join("\n")
    .replace(/^(subject|received|arc-|dkim-|mime-version|content-type|content-transfer-encoding|message-id|from|to|cc|date):.*$/gim, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function cleanInboundEmailText(
  textBody?: string,
  htmlBody?: string,
  emailBody?: string
): string {
  const plain = textBody?.trim();
  if (plain && !looksLikeMime(plain)) {
    const decodedPlain = /=[A-Fa-f0-9]{2}/.test(plain) ? decodeQuotedPrintable(plain) : plain;
    return fixMojibake(stripQuotedReply(decodedPlain));
  }
  const mimeCandidate = emailBody || textBody || "";
  const extracted = extractPlainTextFromMime(mimeCandidate);
  if (extracted) return fixMojibake(stripQuotedReply(extracted));
  const htmlText = stripHtml(htmlBody) ?? stripHtml(emailBody);
  return fixMojibake(stripQuotedReply(htmlText?.trim() || plain || ""));
}

function isCallOnlyText(input?: string | null): boolean {
  if (!input) return false;
  return /\b(call only|phone only|call me only|no text|do not text|don't text|text me not)\b/i.test(
    input
  );
}

function buildHumanEmailReplyTodoSummary(body?: string | null): string {
  const text = String(body ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return "Customer replied by email. Follow up directly.";
  const snippet = text.length > 240 ? `${text.slice(0, 237).trimEnd()}...` : text;
  return `Customer replied by email. Follow up directly.\n${snippet}`;
}

function isReplyToSalespersonEmailThread(conv: any): boolean {
  const msgs = Array.isArray(conv?.messages) ? conv.messages : [];
  const lastOutbound = [...msgs].reverse().find(m => m?.direction === "out");
  if (!lastOutbound) return false;
  const from = String(lastOutbound.from ?? "");
  const to = String(lastOutbound.to ?? "");
  const looksLikeEmail = from.includes("@") || to.includes("@");
  if (!looksLikeEmail) return false;
  return lastOutbound.provider === "human";
}

function getLeadIdentifiers(conv: any, fromEmail?: string) {
  const email =
    (conv?.lead?.email ?? fromEmail ?? (conv?.leadKey?.includes?.("@") ? conv.leadKey : ""))
      ?.toString()
      .trim()
      .toLowerCase() || undefined;
  const phoneRaw =
    conv?.lead?.phone ?? (!conv?.leadKey?.includes?.("@") ? conv?.leadKey : undefined);
  const phone = phoneRaw ? normalizeLeadKey(String(phoneRaw)) : undefined;
  return { email, phone };
}

function pauseRelatedCadencesOnInbound(conv: any, fromEmail?: string) {
  const { email, phone } = getLeadIdentifiers(conv, fromEmail);
  if (!email && !phone) return;
  const pauseUntil = new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString();
  for (const other of getAllConversations()) {
    if (!other || other.id === conv.id) continue;
    const ids = getLeadIdentifiers(other);
    const emailMatch = email && ids.email && ids.email === email;
    const phoneMatch = phone && ids.phone && ids.phone === phone;
    if (!emailMatch && !phoneMatch) continue;
    pauseFollowUpCadence(other, pauseUntil, "cross_channel_inbound");
  }
  pauseFollowUpCadence(conv, pauseUntil, "inbound_email");
}

function extractLeadMeta(adfXml: string): { leadSource?: string; model?: string; vendorContactName?: string } {
  try {
    const cleaned = decodeQuotedPrintable(adfXml);
    const parser = new XMLParser({ ignoreAttributes: false });
    const doc = parser.parse(cleaned);
    const adf = doc?.adf ?? doc;
    const prospect = adf?.prospect ?? {};

    const sourceFromId = text(attr(prospect?.id, "source"));
    const providerName =
      pickNameValue(prospect?.provider?.name) ??
      text(prospect?.provider) ??
      pickNameValue(adf?.provider?.name) ??
      text(adf?.provider);
    const vendorName =
      pickNameValue(prospect?.vendor?.name) ??
      text(prospect?.vendor) ??
      pickNameValue(adf?.vendor?.name) ??
      text(adf?.vendor);
    const vendorContactName =
      pickNameValue(prospect?.vendor?.contact?.name) ??
      pickNameValue(adf?.vendor?.contact?.name);

    let leadSource = [providerName, vendorName, sourceFromId].find(v => v && v.length > 0);
    if (!leadSource) {
      const providerMatch = cleaned.match(
        /<provider[^>]*>[\s\S]*?<name[^>]*>([^<]+)<\/name>/i
      );
      const vendorMatch = cleaned.match(
        /<vendor[^>]*>[\s\S]*?<vendorname[^>]*>([^<]+)<\/vendorname>/i
      );
      const idSourceMatch = cleaned.match(/<id[^>]*source=["']([^"']+)["'][^>]*>/i);
      leadSource = providerMatch?.[1]?.trim() ?? vendorMatch?.[1]?.trim() ?? idSourceMatch?.[1]?.trim();
    }

    const vehicle = prospect?.vehicle ?? prospect?.request?.vehicle ?? adf?.vehicle ?? {};
    const model = text(vehicle?.model);

    return { leadSource, model, vendorContactName };
  } catch {
    return {};
  }
}

function normalizeVehicleCondition(raw?: string | null): "new" | "used" | undefined {
  if (!raw) return undefined;
  const t = String(raw).toLowerCase();
  if (t.includes("used") || t.includes("pre-owned") || t.includes("preowned")) return "used";
  if (t.includes("new")) return "new";
  return undefined;
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeVehicleModel(raw?: string | null, make?: string | null): string | undefined {
  let model = raw ? String(raw).trim() : "";
  if (!model) return undefined;
  const makeClean = make ? String(make).trim() : "";
  if (makeClean) {
    const re = new RegExp(`^${escapeRegExp(makeClean)}\\s+`, "i");
    model = model.replace(re, "").trim();
  }
  model = model.replace(/\bharley[-\s]?davidson\b/gi, "").replace(/\bh[-\s]?d\b/gi, "").trim();
  model = model.replace(/^[\s\-–—:,]+|[\s\-–—:,]+$/g, "").trim();
  const normalized = model.toLowerCase();
  // Collapse known Harley code/name aliases to one canonical label so watch matching
  // and UI state do not split equivalent models into separate entries.
  if (/\bfltrt\b/.test(normalized) || /\broad glide\s*(?:3|iii)\b/.test(normalized)) {
    return "Road Glide 3";
  }
  if (/\bflhlt(?:se)?\b/.test(normalized) || /\bstreet glide\s*(?:3|iii)\b/.test(normalized)) {
    return "Street Glide 3 Limited";
  }
  if (/\bflhtcutg\b/.test(normalized) || /\btri glide(?:\s+ultra)?\b/.test(normalized)) {
    return "Tri Glide Ultra";
  }
  if (/\bflhxxx\b/.test(normalized) || /\bstreet glide trike\b/.test(normalized)) {
    return "Street Glide Trike";
  }
  if (/\bra1250st\b/.test(normalized) || /\bpan america(?:\s+1250)?\s+st\b/.test(normalized)) {
    return "Pan America 1250 ST";
  }
  if (/\bra1250s\b/.test(normalized) || /\bpan america(?:\s+1250)?\s+special\b/.test(normalized)) {
    return "Pan America Special";
  }
  if (/\bra1250l\b/.test(normalized) || /\bpan america(?:\s+1250)?\s+l(?:imited)?\b/.test(normalized)) {
    return "Pan America 1250 L";
  }
  if (/\brh1250s\b/.test(normalized) || /\bsportster\s+s\b/.test(normalized)) {
    return "Sportster S";
  }
  if (/\brh975s\b/.test(normalized) || /\bnightster\s+special\b/.test(normalized)) {
    return "Nightster Special";
  }
  if (/\brh975\b/.test(normalized) || /\bnightster\b/.test(normalized)) {
    return "Nightster";
  }
  return model || undefined;
}

function parseTimeframeMonths(raw?: string): { start?: number; end?: number } | null {
  if (!raw) return null;
  const t = raw.toLowerCase();
  if (/unsure|not sure|unknown/.test(t)) return null;
  if (/over\s*\d+\s*year/.test(t) || /over\s*a\s*year/.test(t) || /over\s*one\s*year/.test(t)) {
    return { start: 12 };
  }
  if (/\byear\b/.test(t)) {
    const years = t.match(/(\d+)\s*year/);
    if (years) {
      const y = Number(years[1]);
      if (!Number.isNaN(y)) return { start: y * 12 };
    }
    return { start: 12 };
  }
  const range = t.match(/(\d+)\s*[-to]+\s*(\d+)\s*month/);
  if (range) {
    const a = Number(range[1]);
    const b = Number(range[2]);
    if (!Number.isNaN(a) && !Number.isNaN(b)) {
      return { start: Math.min(a, b), end: Math.max(a, b) };
    }
  }
  const single = t.match(/(\d+)\s*month/);
  if (single) {
    const a = Number(single[1]);
    if (!Number.isNaN(a)) return { start: a };
  }
  return null;
}

function buildLongTermMessage(timeframe?: string, hasLicense?: boolean) {
  const tf = timeframe ? timeframe.trim() : "a future";
  if (hasLicense === true) {
    return `Hi, this is Brooke at American Harley-Davidson. You mentioned a ${tf} timeline. I’m happy to help when you’re ready. Just reach out when the time is right.`;
  }
  return `Hi, this is Brooke at American Harley-Davidson. You mentioned a ${tf} timeline. I’m happy to help when you’re ready. Just reach out when the time is right.`;
}

function isPricingPaymentInquiry(text?: string | null): boolean {
  const t = String(text ?? "").toLowerCase();
  if (!t) return false;
  return (
    /\b(payment|payments|monthly|per month|apr|rate|interest|down payment|downpayment|put down|how much down|budget)\b/.test(
      t
    ) ||
    /\b(finance|financing|quote|price|pricing|out the door|\botd\b)\b/.test(t) ||
    /\/\s*mo\b|\/\s*month\b/.test(t)
  );
}

export async function handleSendgridInbound(req: Request, res: Response) {
  console.log("[sendgrid inbound] meta:", {
    contentType: req.header("content-type"),
    contentLength: req.header("content-length"),
    files: Array.isArray(req.files) ? req.files.length : 0
  });
  console.log("[sendgrid inbound] keys:", Object.keys(req.body));
  if (req.body?.email) {
    const sample = [];
    for (let i = 0; i < Math.min(10, req.body.email.length); i++) {
      sample.push(req.body.email[i]);
    }
    console.log("[sendgrid inbound] email body sample:", sample);
  }

  const textBody = typeof req.body?.text === "string" ? req.body.text : undefined;
  const htmlBody = typeof req.body?.html === "string" ? req.body.html : undefined;
  const emailBody = typeof req.body?.email === "string" ? req.body.email : undefined;

  let adfXml = extractAdfXmlFromEmail(textBody, htmlBody);

  // Some SendGrid configurations provide the full MIME in "email"
  if (!adfXml && emailBody) {
    adfXml = extractAdfXmlFromEmail(emailBody, undefined);
  }

  // Try raw MIME payload (SendGrid’s full MIME when enabled)
  const rawMime = typeof req.body?.raw === "string" ? req.body.raw : undefined;
  if (!adfXml && rawMime) {
    try {
      const decoded = Buffer.from(rawMime, "base64").toString("utf8");
      console.log("[sendgrid inbound] raw decoded sample:", decoded.slice(0, 200).replace(/\s+/g, " "));
      adfXml = extractAdfXmlFromEmail(decoded, undefined);
    } catch {
      adfXml = null;
    }
  }

  // Try attachments (any type) for embedded ADF XML
  if (!adfXml && Array.isArray(req.files)) {
    for (const f of req.files as Express.Multer.File[]) {
      const s = f.buffer.toString("utf8");
      const found = extractAdfXmlFromEmail(s, undefined);
      if (found) {
        adfXml = found;
        break;
      }
    }
  }

  if (!adfXml) {
    const envelopeRaw = req.body?.envelope;
    let envelope: any = null;
    if (typeof envelopeRaw === "string") {
      try {
        envelope = JSON.parse(envelopeRaw);
      } catch {
        envelope = null;
      }
    }
    const fromEmail =
      extractEmailAddress(req.body?.from) ?? extractEmailAddress(envelope?.from) ?? undefined;
    const toEmail =
      extractEmailAddress(req.body?.to) ??
      (Array.isArray(envelope?.to) ? extractEmailAddress(envelope?.to[0]) : undefined) ??
      extractEmailAddress(envelope?.to) ??
      "dealership";
    const taggedLeadKey =
      extractLeadKeyFromTaggedEmail(req.body?.to) ??
      (Array.isArray(envelope?.to)
        ? extractLeadKeyFromTaggedEmail(envelope?.to[0])
        : extractLeadKeyFromTaggedEmail(envelope?.to));
    const subject = typeof req.body?.subject === "string" ? req.body.subject.trim() : "";
    const bodyText = cleanInboundEmailText(textBody, htmlBody, emailBody);
    const body = bodyText?.trim() || subject || "";

    if (!fromEmail) {
      console.warn("[sendgrid inbound] No ADF found and no from email", {
        subject: req.body?.subject,
        from: req.body?.from
      });
      return res.status(200).json({ ok: true, parsed: false, reason: "no_adf_found" });
    }

    const existingByTag = taggedLeadKey ? getConversation(taggedLeadKey) : null;
    const existingConv =
      existingByTag ??
      getAllConversations().find(c => {
        const email =
          (c?.lead?.email ?? (c?.leadKey?.includes?.("@") ? c.leadKey : ""))?.toString().toLowerCase();
        return !!email && email === fromEmail;
      });
    const leadKey = existingConv?.leadKey ?? taggedLeadKey ?? fromEmail;
    const conv = existingConv ?? upsertConversationByLeadKey(leadKey, "suggest");
    mergeConversationLead(conv, {
      email: fromEmail
    });
    if (!conv.classification?.channel) {
      setConversationClassification(conv, {
        bucket: conv.classification?.bucket ?? "general_inquiry",
        cta: conv.classification?.cta ?? "unknown",
        channel: "email",
        ruleName: conv.classification?.ruleName ?? "email_reply"
      });
    }

    upsertContact({
      leadKey: conv.leadKey,
      conversationId: conv.id,
      email: fromEmail
    });

    const event: InboundMessageEvent = {
      channel: "email",
      provider: "sendgrid",
      from: fromEmail,
      to: toEmail || "dealership",
      body: body || "(no content)",
      providerMessageId: String(req.body?.MessageID ?? req.body?.message_id ?? ""),
      receivedAt: new Date().toISOString()
    };

    if (isDuplicateInboundEvent(conv, event, { windowMs: 15 * 60 * 1000 })) {
      console.log("[sendgrid inbound] duplicate ignored", {
        convId: conv.id,
        providerMessageId: event.providerMessageId
      });
      return res.status(200).json({ ok: true, parsed: true, duplicate: true, leadKey });
    }

    appendInbound(conv, event);
    discardPendingDrafts(conv, "new_inbound");
    confirmAppointmentIfMatchesSuggested(conv, event.body, event.providerMessageId);
    updateHoldingFromInbound(conv, event.body);
    pauseRelatedCadencesOnInbound(conv, fromEmail);

    if (conv.contactPreference === "call_only" || isCallOnlyText(body)) {
      setContactPreference(conv, "call_only");
      addTodo(conv, "other", event.body ?? "Call only requested", event.providerMessageId);
      setFollowUpMode(conv, "manual_handoff", "call_only");
      stopFollowUpCadence(conv, "manual_handoff");
      return res.status(200).json({
        ok: true,
        parsed: true,
        leadKey,
        lead: conv.lead,
        channel: "email",
        note: "call_only_no_email_draft"
      });
    }

    if (conv.mode === "human" || isReplyToSalespersonEmailThread(conv)) {
      addTodo(
        conv,
        "note",
        buildHumanEmailReplyTodoSummary(event.body),
        event.providerMessageId
      );
      setFollowUpMode(conv, "manual_handoff", "human_email_reply");
      stopFollowUpCadence(conv, "manual_handoff");
      delete conv.emailDraft;
      saveConversation(conv);
      await flushConversationStore();
      return res.status(200).json({
        ok: true,
        parsed: true,
        leadKey,
        lead: conv.lead,
        channel: "email",
        note:
          conv.mode === "human"
            ? "human_mode_todo_created"
            : "salesperson_thread_todo_created"
      });
    }

    const history = conv.messages.slice(-20).map(m => ({ direction: m.direction, body: m.body }));
    const allowSchedulingOffer =
      /(appointment|appt|schedule|book|reserve|come in|stop in|stop by|visit|test ride|demo ride|\b\d{1,2}(:\d{2})?\s*(am|pm)\b)/i.test(
        event.body ?? ""
      );
    const result = await orchestrateInbound(event, history, {
      appointment: conv.appointment,
      followUp: conv.followUp,
      lead: conv.lead,
      leadSource: conv.lead?.source ?? null,
      bucket: conv.classification?.bucket ?? null,
      cta: conv.classification?.cta ?? null,
      pricingAttempts: getPricingAttempts(conv),
      allowSchedulingOffer
    });

    if (result.handoff?.required) {
      addTodo(conv, result.handoff.reason, event.body, event.providerMessageId);
      setFollowUpMode(conv, "manual_handoff", `handoff:${result.handoff.reason}`);
      stopFollowUpCadence(conv, "manual_handoff");
      if (result.handoff.reason === "pricing" || result.handoff.reason === "payments") {
        markPricingEscalated(conv);
      }
      conv.emailDraft = result.handoff.ack;
    } else if (result.autoClose?.reason) {
      closeConversation(conv, result.autoClose.reason);
      conv.emailDraft = result.draft;
    } else {
      conv.emailDraft = result.draft;
    }

    saveConversation(conv);
    await flushConversationStore();

    return res.status(200).json({ ok: true, parsed: true, type: "email_reply", draft: conv.emailDraft });
  }

  console.log("[sendgrid inbound] to:", req.body?.to);
  console.log("[sendgrid inbound] envelope:", req.body?.envelope);
  console.log(
    "[sendgrid inbound] adf snippet:",
    adfXml.slice(0, 200).replace(/\s+/g, " ")
  );

  const lead = parseAdfXml(adfXml);
  const leadRefFallback =
    adfXml.match(/<prospect[^>]*>[\s\S]*?<id[^>]*>([^<]+)<\/id>/i)?.[1]?.trim() ??
    undefined;
  const leadRef = lead.leadRef ?? leadRefFallback;
  console.log("[sendgrid inbound] parsed lead:", {
    leadRef,
    firstName: lead.firstName,
    lastName: lead.lastName,
    email: lead.email,
    phone: lead.phone,
    stockId: lead.stockId,
    vin: lead.vin,
    year: lead.year,
    inquiry: lead.inquiry
  });
  const meta = extractLeadMeta(adfXml);
  const leadSource = meta.leadSource?.trim() || undefined;
  const leadSourceLower = (leadSource ?? "").toLowerCase();
  const vendorContactName = meta.vendorContactName?.trim() || "";
  const leadSourceId = lead.leadSourceId ?? undefined;
  const timeframeInfo = parseTimeframeMonths(lead.purchaseTimeframe);
  const make = lead.vehicleMake ?? undefined;
  const model = normalizeVehicleModel(
    lead.vehicleModel ?? meta.model ?? lead.vehicleDescription ?? undefined,
    make ?? null
  );
  const isMarketplaceRelaySource =
    leadSourceLower.includes("autodealers.digital") ||
    leadSourceLower.includes("autodealersdigital.com") ||
    leadSourceLower.includes("facebook marketplace");
  const leadPhone = lead.phone?.trim() || undefined;
  const leadEmail = lead.email?.trim() || undefined;
  const leadEmailForConversation = isMarketplaceRelaySource ? undefined : leadEmail;
  const relayOnlyMarketplaceLead = isMarketplaceRelaySource && !leadPhone;
  const rule = resolveLeadRule(leadSource, leadSourceId);
  const journeyText = [lead.comment, lead.inquiry].filter(Boolean).join(" ").trim();

  // Choose a stable conversation key
  const leadKey =
    leadPhone ||
    leadEmailForConversation ||
    (isMarketplaceRelaySource && leadRef ? `adf_ref_${leadRef}` : "") ||
    `unknown_${Date.now()}`;

  const existingByLead = findConversationsByLeadKey(leadKey);
  const latestByLead = existingByLead[0];
  let conv =
    latestByLead ??
    upsertConversationByLeadKey(leadKey, "suggest");
  if (latestByLead && isStickyClosedJourney(latestByLead)) {
    const parsedJourney = await parseJourneyIntentWithLLM({
      text: journeyText,
      history: (latestByLead.messages ?? [])
        .slice(-12)
        .map(m => ({ direction: m.direction, body: m.body })),
      lead: latestByLead.lead
    });
    const explicitSalesReengagement =
      parsedJourney?.journeyIntent === "sale_trade" &&
      parsedJourney?.explicitRequest === true &&
      Number(parsedJourney?.confidence ?? 0) >= 0.68;
    const strictSalesTrade = isStrictSalesTradeBucket(rule.bucket) || explicitSalesReengagement;
    if (strictSalesTrade) {
      conv = createConversationForLeadKey(leadKey, latestByLead.mode ?? "suggest");
      conv.leadOwner = latestByLead.leadOwner ? { ...latestByLead.leadOwner } : undefined;
    }
  }
  if (!conv.leadOwner?.id) {
    const users = await listUsers();
    const manager = users.find(u => u.role === "manager") ?? null;
    const vendorFirst = pickFirstToken(vendorContactName);
    const rawSalespersonFromComment =
      String(lead.comment ?? lead.inquiry ?? "").match(
        /\bsalesperson\s*:\s*([a-z][a-z\s.'-]{1,40})/i
      )?.[1] ?? "";
    const salespersonFirst = pickFirstToken(rawSalespersonFromComment);
    const matchedSalesperson =
      users.find(u => {
        if (u.role !== "salesperson") return false;
        const first = pickFirstToken(u.firstName);
        const nameFirst = pickFirstToken(u.name);
        return !!salespersonFirst && (salespersonFirst === first || salespersonFirst === nameFirst);
      }) ??
      users.find(u => {
        if (u.role !== "salesperson") return false;
        const first = pickFirstToken(u.firstName);
        const nameFirst = pickFirstToken(u.name);
        return !!vendorFirst && (vendorFirst === first || vendorFirst === nameFirst);
      }) ??
      null;
    const owner = matchedSalesperson ?? manager;
    if (owner) {
      conv.leadOwner = {
        id: owner.id,
        name: owner.name ?? owner.firstName ?? owner.email ?? "Salesperson",
        assignedAt: new Date().toISOString()
      };
    }
  }
  mergeConversationLead(conv, {
    leadRef,
    source: leadSource,
    sourceId: leadSourceId,
    firstName: lead.firstName,
    lastName: lead.lastName,
    preferredDate: lead.preferredDate,
    preferredTime: lead.preferredTime,
    email: leadEmailForConversation,
    phone: leadPhone,
    street: lead.street,
    city: lead.city,
    region: lead.region,
    postal: lead.postal,
    purchaseTimeframe: lead.purchaseTimeframe,
    purchaseTimeframeMonthsStart: timeframeInfo?.start,
    purchaseTimeframeMonthsEnd: timeframeInfo?.end,
    hasMotoLicense: lead.hasMotoLicense,
    emailOptIn: lead.emailOptIn,
    smsOptIn: lead.smsOptIn,
    phoneOptIn: lead.phoneOptIn,
    sellOption: lead.sellOption,
    vehicle: {
      stockId: lead.stockId,
      vin: lead.vin,
      year: lead.year,
      make,
      model,
      trim: lead.vehicleTrim,
      color: lead.vehicleColor,
      condition: lead.vehicleCondition,
      description: lead.vehicleDescription,
      mileage: lead.mileage
    },
    tradeVehicle: lead.tradeVehicle
  });
  const stockId = lead.stockId?.trim() || undefined;
  conv.lead = conv.lead ?? {};
  conv.lead.vehicle = conv.lead.vehicle ?? {};
  if (stockId) conv.lead.vehicle.stockId = stockId;
  const parsedCondition = normalizeVehicleCondition(lead.vehicleCondition);
  if (parsedCondition) {
    conv.lead.vehicle.condition = parsedCondition;
  } else if (stockId) {
    conv.lead.vehicle.condition = /^u/i.test(stockId) ? "used" : "new";
  } else {
    conv.lead.vehicle.condition = "new_model_interest";
  }

  upsertContact({
    leadKey: conv.leadKey,
    conversationId: conv.id,
    leadRef,
    leadSource,
    leadSourceId,
    firstName: lead.firstName,
    lastName: lead.lastName,
    name: [lead.firstName, lead.lastName].filter(Boolean).join(" ").trim() || undefined,
    email: leadEmailForConversation,
    phone: leadPhone,
    vehicleDescription: lead.vehicleDescription ?? meta.model,
    stockId: lead.stockId,
    vin: lead.vin,
    year: lead.year,
    make,
    vehicle: model ?? meta.model,
    model: model ?? meta.model,
    trim: lead.vehicleTrim,
    color: lead.vehicleColor,
    condition: conv.lead?.vehicle?.condition ?? parsedCondition ?? undefined,
    inquiry: lead.inquiry,
    lastAdfAt: new Date().toISOString()
  });

  const rawComment = String(lead.comment ?? "");
  const cleanedComment = rawComment.replace(/<br\s*\/?/gi, " ").replace(/\s+/g, " ").trim();
  const inquiryRaw = lead.inquiry ?? "";
  const combinedInquiry = [cleanedComment, inquiryRaw].filter(Boolean).join(" ").trim();
  const effectiveInquiry = combinedInquiry || inquiryRaw;
  lead.inquiry = effectiveInquiry;
  const inquiryText = String(effectiveInquiry).toLowerCase();
  const adfHistory = (conv.messages ?? [])
    .slice(-6)
    .map(m => ({ direction: m.direction as "in" | "out", body: String(m.body ?? "") }));
  const llmDialogAct = await parseDialogActWithLLM({
    text: effectiveInquiry,
    history: adfHistory,
    lead: conv.lead
  });
  const llmIntent = await parseIntentWithLLM({
    text: effectiveInquiry,
    history: adfHistory,
    lead: conv.lead
  });
  const llmInventoryEntities = await parseInventoryEntitiesWithLLM({
    text: effectiveInquiry,
    history: adfHistory,
    lead: conv.lead
  });
  const llmResponseControl = await parseResponseControlWithLLM({
    text: effectiveInquiry,
    history: adfHistory,
    lead: conv.lead
  });
  const llmWalkInOutcome = await parseWalkInOutcomeWithLLM({
    text: effectiveInquiry,
    history: adfHistory,
    lead: conv.lead
  });
  const dialogActConfidenceMin = Number(process.env.LLM_DIALOG_ACT_CONFIDENCE_MIN ?? 0.68);
  const intentConfidenceMin = Number(process.env.LLM_INTENT_CONFIDENCE_MIN ?? 0.75);
  const pricingInquiryIntentFromParser =
    !!llmDialogAct &&
    llmDialogAct.topic === "pricing" &&
    llmDialogAct.explicitRequest === true &&
    Number(llmDialogAct.confidence ?? 0) >= dialogActConfidenceMin;
  const pricingInquiryIntent = pricingInquiryIntentFromParser || isPricingPaymentInquiry(inquiryText);
  const inventoryEntityConfidence =
    typeof llmInventoryEntities?.confidence === "number" ? llmInventoryEntities.confidence : 0;
  const inventoryEntityConfidenceMin = Number(process.env.LLM_INVENTORY_ENTITY_CONFIDENCE_MIN ?? 0.68);
  const inventoryEntityAccepted = !!llmInventoryEntities && inventoryEntityConfidence >= inventoryEntityConfidenceMin;
  const availabilityIntentFromParser =
    !!llmIntent &&
    llmIntent.intent === "availability" &&
    llmIntent.explicitRequest === true &&
    Number(llmIntent.confidence ?? 0) >= intentConfidenceMin;
  const responseControlAccepted = isResponseControlParserAccepted(llmResponseControl);
  const scheduleIntentFromParser =
    responseControlAccepted && llmResponseControl?.intent === "schedule_request";
  const serviceIntentFromParser =
    !!llmDialogAct &&
    llmDialogAct.topic === "service" &&
    llmDialogAct.explicitRequest === true &&
    Number(llmDialogAct.confidence ?? 0) >= dialogActConfidenceMin;
  const tradeIntentFromParser =
    !!llmDialogAct &&
    llmDialogAct.topic === "trade" &&
    llmDialogAct.explicitRequest === true &&
    Number(llmDialogAct.confidence ?? 0) >= dialogActConfidenceMin;
  const inquiryDayPart = extractDayPartRequest(effectiveInquiry);
  const serviceVinRequest =
    /registration\s+or\s+vin\s+number/i.test(lead.comment ?? "") ||
    /registration\s+or\s+vin\s+number/i.test(lead.inquiry ?? "");
  const hasStockIntent =
    !!lead.stockId || !!lead.vin || inquiryText.includes("available") || availabilityIntentFromParser;

  let inferredBucket = rule.bucket;
  let inferredCta = rule.cta;
  if (!leadSource || rule.ruleName === "default") {
    if (hasStockIntent) {
      inferredBucket = "inventory_interest";
      inferredCta = "check_availability";
    } else if (
      inquiryText.includes("test ride") ||
      inquiryText.includes("demo") ||
      (!!llmIntent &&
        llmIntent.intent === "test_ride" &&
        llmIntent.explicitRequest === true &&
        Number(llmIntent.confidence ?? 0) >= intentConfidenceMin)
    ) {
      inferredBucket = "test_ride";
      inferredCta = "schedule_test_ride";
    } else if (
      scheduleIntentFromParser ||
      inquiryText.includes("prequal") ||
      inquiryText.includes("credit") ||
      inquiryText.includes("finance")
    ) {
      if (scheduleIntentFromParser) {
        inferredBucket = "test_ride";
        inferredCta = "schedule_test_ride";
      } else {
        inferredBucket = "finance_prequal";
        inferredCta = inquiryText.includes("prequal") ? "prequalify" : "prequalify";
      }
    } else if (
      tradeIntentFromParser ||
      inquiryText.includes("value my trade") ||
      inquiryText.includes("trade") ||
      inquiryText.includes("sell")
    ) {
      inferredBucket = "trade_in_sell";
      inferredCta = inquiryText.includes("sell") ? "sell_my_bike" : "value_my_trade";
    } else if (serviceIntentFromParser || inquiryText.includes("service") || serviceVinRequest) {
      inferredBucket = "service";
      inferredCta = "service_request";
    } else {
      inferredBucket = "general_inquiry";
      inferredCta = "unknown";
    }
  }
  const forcedTestRide = leadSourceLower.includes("test ride") || leadSourceLower.includes("book test ride");
  if (forcedTestRide) {
    inferredBucket = "test_ride";
    inferredCta = "schedule_test_ride";
  }
  const forcedTradeIn =
    leadSourceLower.includes("trade accelerator") ||
    /\btrade[-\s]?in\b/.test(leadSourceLower);
  if (forcedTradeIn) {
    inferredBucket = "trade_in_sell";
    inferredCta = "value_my_trade";
  }
  if (
    pricingInquiryIntent &&
    inferredBucket !== "trade_in_sell" &&
    inferredBucket !== "service" &&
    inferredBucket !== "test_ride"
  ) {
    inferredCta = "request_a_quote";
  }
  const channel = resolveChannel({
    leadSource,
    sourceId: leadSourceId,
    hasSms: !!lead.phone,
    hasEmail: !!lead.email,
    hasFacebook:
      leadSourceLower.includes("facebook") ||
      leadSourceLower.includes("autodealers.digital") ||
      leadSourceLower.includes("autodealersdigital.com")
  });
  console.log("[sendgrid inbound] classification", {
    leadSource,
    leadSourceId,
    inferredBucket,
    inferredCta,
    forcedTestRide
  });
  setConversationClassification(conv, {
    bucket: inferredBucket,
    cta: inferredCta,
    channel,
    ruleName: forcedTestRide ? "room58_book_test_ride_forced" : rule.ruleName
  });
  if (!conv.dialogState?.name || conv.dialogState.name === "none") {
    if (inferredBucket === "inventory_interest") {
      conv.dialogState = { name: "inventory_init", updatedAt: new Date().toISOString() };
    } else if (pricingInquiryIntent) {
      conv.dialogState = { name: "pricing_init", updatedAt: new Date().toISOString() };
    } else if (inferredBucket === "trade_in_sell" || inferredCta === "sell_my_bike") {
      conv.dialogState = { name: "trade_init", updatedAt: new Date().toISOString() };
    } else if (inferredBucket === "service" || inferredCta === "service_request") {
      conv.dialogState = { name: "service_request", updatedAt: new Date().toISOString() };
    }
  }

  const inboundBody =
    [
      `WEB LEAD (ADF)`,
      leadSource ? `Source: ${leadSource}` : null,
      leadRef ? `Ref: ${leadRef}` : null,
      lead.firstName || lead.lastName ? `Name: ${(lead.firstName ?? "").trim()} ${(lead.lastName ?? "").trim()}`.trim() : null,
      lead.email ? `Email: ${lead.email}` : null,
      lead.phone ? `Phone: ${lead.phone}` : null,
      lead.stockId ? `Stock: ${lead.stockId}` : null,
      lead.vin ? `VIN: ${lead.vin}` : null,
      lead.year ? `Year: ${lead.year}` : null,
      lead.vehicleDescription ? `Vehicle: ${lead.vehicleDescription}` : null,
      lead.tradeVehicle?.description || lead.tradeVehicle?.year
        ? `Trade-In: ${[lead.tradeVehicle?.year, lead.tradeVehicle?.description ?? lead.tradeVehicle?.model]
            .filter(Boolean)
            .join(" ")}`
        : null,
      "",
      `Inquiry:`,
      inquiryText
    ]
      .filter(v => v !== null)
      .join("\n");

  const event: InboundMessageEvent = {
    channel: "email",
    provider: "sendgrid_adf",
    from: leadEmailForConversation || leadPhone || leadKey || "unknown_sender",
    to: "dealership",
    body: inboundBody,
    providerMessageId: String(req.body?.MessageID ?? req.body?.message_id ?? ""),
    receivedAt: new Date().toISOString()
  };

  if (isDuplicateInboundEvent(conv, event, { windowMs: 15 * 60 * 1000 })) {
    console.log("[sendgrid inbound] duplicate ignored", {
      convId: conv.id,
      providerMessageId: event.providerMessageId
    });
    return res.status(200).json({ ok: true, parsed: true, duplicate: true, leadKey });
  }

  const callOnlyRequested = isCallOnlyText(inquiryText);

  let creditTodoCreated = false;
  const isCreditLead =
    inferredBucket === "finance_prequal" ||
    inferredCta === "hdfs_coa" ||
    inferredCta === "prequalify" ||
    /coa|credit application|apply for credit|finance application|prequal/i.test(leadSourceLower);
  if (isCreditLead) {
    if (!creditTodoCreated) {
      addTodo(conv, "approval", event.body ?? "Credit application", event.providerMessageId);
    }
    creditTodoCreated = true;
    setFollowUpMode(conv, "manual_handoff", "credit_app");
    stopFollowUpCadence(conv, "manual_handoff");
  }

  appendInbound(conv, event);
  discardPendingDrafts(conv, "new_inbound");
  confirmAppointmentIfMatchesSuggested(conv, event.body, event.providerMessageId);
  updateHoldingFromInbound(conv, event.body);

  if (relayOnlyMarketplaceLead) {
    if (conv.followUp?.reason !== "marketplace_relay") {
      addTodo(
        conv,
        "other",
        "Marketplace relay lead: reply in the marketplace inbox (no direct SMS/email channel on this lead).",
        event.providerMessageId
      );
    }
    setFollowUpMode(conv, "manual_handoff", "marketplace_relay");
    stopFollowUpCadence(conv, "manual_handoff");
  }

  if (callOnlyRequested) {
    setContactPreference(conv, "call_only");
    addTodo(conv, "other", event.body ?? "Call only requested", event.providerMessageId);
    setFollowUpMode(conv, "manual_handoff", "call_only");
    stopFollowUpCadence(conv, "manual_handoff");
    return res.status(200).json({
      ok: true,
      parsed: true,
      leadKey,
      lead,
      leadSource,
      bucket: inferredBucket,
      cta: inferredCta,
      channel,
      intent: "GENERAL",
      stage: "ENGAGED",
      note: "call_only_no_text"
    });
  }

  const timeframeLower = String(lead.purchaseTimeframe ?? "").toLowerCase();
  const isDealerRideEventLead =
    event.provider === "sendgrid_adf" &&
    !(conv.messages ?? []).some((m: any) => m.direction === "out") &&
    (leadSourceLower.includes("dealer lead app") ||
      /event name:\s*dealer test ride|demo bikes ridden|dealer lead app/i.test(effectiveInquiry));
  if (isDealerRideEventLead) {
    const appt = conv.appointment;
    const apptType = String(appt?.appointmentType ?? appt?.matchedSlot?.appointmentType ?? "").toLowerCase();
    const isBookedTestRide =
      !!appt?.bookedEventId &&
      (apptType === "test_ride" || inferredBucket === "test_ride" || inferredCta === "schedule_test_ride");
    if (isBookedTestRide) {
      const nowIso = new Date().toISOString();
      appt.staffNotify = appt.staffNotify ?? {};
      if (!appt.staffNotify.outcome) {
        appt.staffNotify.outcome = {
          status: "showed_up",
          note: "Auto-marked from Dealer Lead App demo-ride submission.",
          updatedAt: nowIso
        };
      }
      appt.staffNotify.followUpSentAt = appt.staffNotify.followUpSentAt ?? nowIso;
      appt.attendanceQuestionedAt = appt.attendanceQuestionedAt ?? nowIso;
      const openAttendance = listOpenQuestions().filter(
        q => q.convId === conv.id && q.status === "open" && q.type === "attendance"
      );
      for (const q of openAttendance) {
        markQuestionDone(conv.id, q.id, "showed_up", "dealer_lead_app");
      }
    }
  }
  const isNoPurchaseNow =
    /not interested in purchasing at this time/.test(timeframeLower) ||
    /purchase timeframe:\s*i am not interested in purchasing at this time/.test(inquiryText) ||
    /do you expect to make a motorcycle purchase in the near future\?\s*no/.test(inquiryText) ||
    /not interested in purchasing at this time/.test(inquiryText);
  if (isDealerRideEventLead && isNoPurchaseNow) {
    conv.dialogState = { name: "test_ride_booked", updatedAt: new Date().toISOString() };
    addCallTodoIfMissing(
      conv,
      "Dealer ride follow-up needed: thank customer, confirm how to proceed, and update lead status."
    );
    const users = await listUsers();
    const ownerId = String(conv.leadOwner?.id ?? "").trim();
    const owner =
      users.find(u => u.id === ownerId) ??
      users.find(u => {
        const ownerFirst = String(conv.leadOwner?.name ?? "")
          .trim()
          .toLowerCase()
          .split(/\s+/)
          .filter(Boolean)[0];
        const first = String(u.firstName ?? "").trim().toLowerCase();
        const nameFirst = String(u.name ?? "")
          .trim()
          .toLowerCase()
          .split(/\s+/)
          .filter(Boolean)[0];
        return !!ownerFirst && (ownerFirst === first || ownerFirst === nameFirst);
      }) ??
      null;
    const ownerName =
      String(owner?.firstName ?? "").trim() ||
      String(owner?.name ?? "").trim() ||
      String(conv.leadOwner?.name ?? "").trim() ||
      "salesperson";
    const customerName =
      [conv.lead?.firstName, conv.lead?.lastName].filter(Boolean).join(" ").trim() || conv.leadKey || "customer";
    const leadSummary =
      `Dealer ride update needed for ${customerName}. ` +
      `DLA shows "not interested in purchasing at this time". ` +
      `Please send status/next-step update in Leadrider.`;
    const staffSms = await sendInternalSalespersonSms(owner?.phone, leadSummary);
    addTodo(
      conv,
      "note",
      staffSms.sent
        ? `Salesperson SMS sent to ${ownerName}${staffSms.sid ? ` (SID ${staffSms.sid})` : ""}.`
        : `Salesperson SMS failed for ${ownerName}: ${staffSms.reason ?? "unknown_error"}.`
    );
    setFollowUpMode(conv, "manual_handoff", "dealer_ride_no_purchase");
    stopFollowUpCadence(conv, "manual_handoff");
    return res.status(200).json({
      ok: true,
      parsed: true,
      leadKey,
      lead,
      leadSource,
      bucket: inferredBucket,
      cta: inferredCta,
      channel,
      intent: "GENERAL",
      stage: "ENGAGED",
      note: "dealer_ride_no_purchase_manual_handoff",
      staffSms
    });
  }

  const isInitialAdf =
    event.provider === "sendgrid_adf" &&
    !(conv.messages ?? []).some((m: any) => m.direction === "out");
  const applyInitialAdfPrefix = async (text: string) => {
    if (!isInitialAdf) return text;
    const profile = await getDealerProfile();
    const dealerName = profile?.dealerName ?? "American Harley-Davidson";
    const agentName = profile?.agentName ?? "Brooke";
    const firstName = normalizeDisplayCase(conv.lead?.firstName);
    const greeting = firstName ? `Hi ${firstName} — ` : "Hi — ";
    const prefix = `${greeting}This is ${agentName} at ${dealerName}. `;
    const prefixLower = prefix.toLowerCase();
    let body = String(text ?? "").trim();
    if (body.toLowerCase().startsWith(prefixLower)) return body;
    const leadSourceLower = String(conv.lead?.source ?? "").toLowerCase();
    const isMetaLead = /meta/.test(leadSourceLower);
    const modelLabel = formatModelLabel(
      conv?.lead?.vehicle?.year ?? null,
      conv?.lead?.vehicle?.model ?? conv?.lead?.vehicle?.description ?? null
    );
    body = body.replace(/^hi\s+[^—]+—\s*/i, "");
    body = body.replace(/^i (just )?saw[^.]*\.\s*/i, "");
    if (isMetaLead) {
      body = body.replace(/^thanks\s*[-—]\s*i saw you wanted to learn more about[^.]*\.\s*/i, "");
      body = body.replace(/^thanks\s*[-—]\s*/i, "");
      if (!/\bmeta\b/i.test(body)) {
        const metaLine = modelLabel
          ? `I saw your Meta inquiry come over for the ${modelLabel}.`
          : "I saw your Meta inquiry come over.";
        body = `${metaLine} ${body}`.trim();
      }
    }
    const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const agentEsc = esc(agentName);
    const dealerEsc = esc(dealerName);
    body = body.replace(new RegExp(`\\bthis is\\s+${agentEsc}\\s+at\\s+${dealerEsc}\\.?\\s*`, "ig"), "");
    return `${prefix}${body}`.trim();
  };

  const isServiceLead = inferredBucket === "service" || inferredCta === "service_request" || serviceVinRequest;
  const room58Source = /room58/i.test(String(conv.lead?.source ?? ""));
  const isRoom58Standard =
    leadSourceLower.includes("room58 - standard") || rule.ruleName === "room58_standard";
  const metaOfferRawModel = conv.lead?.vehicle?.model ?? conv.lead?.vehicle?.description ?? "";
  const isMetaPromoOffer = /meta promo offer/i.test(leadSourceLower);
  const skipAvailabilityLine =
    isServiceLead ||
    isRoom58Standard ||
    (isMetaPromoOffer && /^(other|full line)$/i.test(metaOfferRawModel.trim()));
  let initialMedia =
    isInitialAdf && !isServiceLead && !room58Source
      ? await pickLeadInventoryMedia(conv)
      : undefined;
  let initialMediaUrls = initialMedia?.mediaUrls;
  const initialPhotoLine = buildInitialPhotoLine(conv, initialMedia);
  const initialAvailability =
    isInitialAdf && !skipAvailabilityLine ? await getLeadInventoryMatchStatus(conv) : "unknown";
  const initialAvailabilityLine = buildInitialAvailabilityLine(initialAvailability, conv);
  const withInitialPhoto = (text: string) => {
    if (!initialPhotoLine) return text;
    if (/here['’]s a photo/i.test(text)) return text;
    return `${text} ${initialPhotoLine}`.trim();
  };
  const withInitialAvailabilityLine = (text: string) => {
    if (!initialAvailabilityLine) return text;
    const lower = text.toLowerCase();
    if (/which model|what model|trim or color/i.test(lower)) return text;
    if (/i (just )?saw you wanted to learn more|interested in checking it out/i.test(lower)) return text;
    if (/\b(checking it out|come by|stop in|stop by|take a look|in stock|available)\b/i.test(lower)) {
      return text;
    }
    return `${text} ${initialAvailabilityLine}`.trim();
  };
  const maybeAddInitialCallTodo = () => {
    if (!isInitialAdf) return;
    addCallTodoIfMissing(conv, "Call customer (initial reply sent).");
  };
  if (isServiceLead) {
    let ack =
      "Thanks — I’ve received your service request. I’ll have our service department reach out shortly.";
    ack = await applyInitialAdfPrefix(ack);
    ack = withInitialPhoto(ack);
    ack = withInitialAvailabilityLine(ack);
    conv.dialogState = { name: "service_handoff", updatedAt: new Date().toISOString() };
    addTodo(conv, "service", event.body, event.providerMessageId);
    setFollowUpMode(conv, "manual_handoff", "service_request");
    stopFollowUpCadence(conv, "manual_handoff");
    appendOutbound(conv, "dealership", leadKey, ack, "draft_ai", undefined, initialMediaUrls);
    maybeAddInitialCallTodo();
    return res.status(200).json({
      ok: true,
      parsed: true,
      leadKey,
      lead,
      leadSource,
      bucket: inferredBucket,
      cta: inferredCta,
      channel,
      intent: "GENERAL",
      stage: "ENGAGED",
      draft: ack
    });
  }

  if (isCreditLead) {
    const firstName = normalizeDisplayCase(conv.lead?.firstName);
    let ack = isInitialAdf
      ? "Thanks — I received your credit application. I’ll have our finance team reach out shortly."
      : firstName
        ? `Thanks ${firstName} — we just received your online credit application. Our finance team will reach out shortly to go over options.`
        : "Thanks — we just received your online credit application. Our finance team will reach out shortly to go over options.";
    if (isInitialAdf) {
      ack = await applyInitialAdfPrefix(ack);
    }
    addTodo(conv, "approval", event.body ?? "Credit application", event.providerMessageId);
    setFollowUpMode(conv, "manual_handoff", "credit_app");
    stopFollowUpCadence(conv, "manual_handoff");
    appendOutbound(conv, "dealership", leadKey, ack, "draft_ai");
    maybeAddInitialCallTodo();
    return res.status(200).json({
      ok: true,
      parsed: true,
      leadKey,
      lead,
      leadSource,
      bucket: inferredBucket,
      cta: inferredCta,
      channel,
      intent: "GENERAL",
      stage: "ENGAGED",
      draft: ack
    });
  }

  const walkInRawComment = String(lead.comment ?? lead.inquiry ?? "");
  const walkInCleanedComment = walkInRawComment.replace(/<br\s*\/?>/gi, " ").replace(/\s+/g, " ").trim();
  const commentLower = walkInCleanedComment.toLowerCase();
  const emailLower = (lead.email ?? "").toLowerCase();
  const isWalkInLead = isInitialAdf && /traffic log pro/i.test(leadSourceLower);
  if (isWalkInLead) {
    initialMedia = undefined;
    initialMediaUrls = undefined;
    const profile = await getDealerProfile();
    const dealerName = profile?.dealerName ?? "American Harley-Davidson";
    const agentName = profile?.agentName ?? "Brooke";
    const firstName = normalizeDisplayCase(conv.lead?.firstName) || "there";
    if (conv.lead) conv.lead.walkIn = true;
    const vendorFirst = vendorContactName.split(/\s+/).filter(Boolean)[0] || "";
    if (!conv.leadOwner?.id && vendorFirst) {
      try {
        const users = await listUsers();
        const vendorToken = vendorFirst.toLowerCase();
        const owner = users.find(u => {
          if (u.role !== "salesperson") return false;
          const first = String(u.firstName ?? "").trim().toLowerCase();
          const nameFirst = String(u.name ?? "")
            .trim()
            .split(/\s+/)
            .filter(Boolean)[0]
            ?.toLowerCase();
          return first === vendorToken || nameFirst === vendorToken;
        });
        if (owner) {
          conv.leadOwner = {
            id: owner.id,
            name: owner.name ?? owner.firstName ?? owner.email ?? vendorFirst,
            assignedAt: new Date().toISOString()
          };
        }
      } catch (e) {
        console.warn("[sendgrid inbound] walk-in owner resolve failed:", (e as any)?.message ?? e);
      }
    }
    const leadOwnerName = String(conv.leadOwner?.name ?? "").trim();
    const leadOwnerFirst = leadOwnerName ? leadOwnerName.split(/\s+/).filter(Boolean)[0] ?? "" : "";
    const salespersonName = leadOwnerFirst || vendorFirst || agentName;
    const modelRaw =
      conv.lead?.vehicle?.model ??
      conv.lead?.vehicle?.description ??
      meta.model ??
      "";
    const walkInModelHint = extractWalkInModelHint(walkInCleanedComment);
    const parserModel =
      inventoryEntityAccepted && llmInventoryEntities?.model
        ? normalizeVehicleModel(llmInventoryEntities.model, conv.lead?.vehicle?.make ?? null)
        : undefined;
    const modelLabel =
      walkInModelHint ||
      parserModel ||
      normalizeVehicleModel(String(modelRaw ?? ""), conv.lead?.vehicle?.make ?? null);
    const hasWatchIntentFromParser =
      !!llmIntent &&
      llmIntent.intent === "availability" &&
      llmIntent.explicitRequest === true &&
      Number(llmIntent.confidence ?? 0) >= intentConfidenceMin;
    const hasWatchIntent =
      hasWatchIntentFromParser ||
      /\b(keep an eye out|watch for|let me know when|notify me when|if you get|when you get|reach out when)\b/.test(
        commentLower
      );
    const wantsUsed =
      conv.lead?.vehicle?.condition === "used" ||
      /pre[-\s]?owned|used/.test(commentLower);
    const wantsNew =
      /\bnew\b/.test(commentLower) ||
      (/looking for|interested in|want/.test(commentLower) && !wantsUsed);
    const parserYearRange =
      inventoryEntityAccepted &&
      llmInventoryEntities?.yearMin &&
      llmInventoryEntities?.yearMax
        ? {
            min: Math.min(llmInventoryEntities.yearMin, llmInventoryEntities.yearMax),
            max: Math.max(llmInventoryEntities.yearMin, llmInventoryEntities.yearMax)
          }
        : null;
    const yearRange = parserYearRange ?? extractYearRangeFromText(lead.comment ?? lead.inquiry ?? "");
    const singleYear =
      !yearRange
        ? (inventoryEntityAccepted ? (llmInventoryEntities?.year ?? undefined) : undefined) ??
          extractSingleYearFromText(lead.comment ?? lead.inquiry ?? "")
        : undefined;
    const regexPriceRange = extractPriceRangeFromText(lead.comment ?? lead.inquiry ?? "");
    const priceRange =
      inventoryEntityAccepted &&
      (llmInventoryEntities?.minPrice || llmInventoryEntities?.maxPrice)
        ? {
            minPrice: llmInventoryEntities?.minPrice ?? undefined,
            maxPrice: llmInventoryEntities?.maxPrice ?? undefined
          }
        : regexPriceRange;
    const desiredColor =
      (inventoryEntityAccepted ? llmInventoryEntities?.color ?? undefined : undefined) ??
      extractColorFromText(lead.comment ?? lead.inquiry ?? "");
    const desiredTrim =
      (inventoryEntityAccepted ? llmInventoryEntities?.trim ?? undefined : undefined) ??
      extractTrimFromText(lead.comment ?? lead.inquiry ?? "");
    const rangeLabel = yearRange ? `${yearRange.min}-${yearRange.max} ` : "";
    let hasUsedMatch = false;
    let hasNewMatch = false;
    if (modelLabel) {
      try {
        const matches = await findInventoryMatches({ year: null, model: modelLabel });
        if (matches.length) {
          hasUsedMatch = matches.some(m => String(m.condition ?? "").toLowerCase().includes("used"));
          hasNewMatch = matches.some(
            m =>
              !String(m.condition ?? "")
                .toLowerCase()
                .includes("used")
          );
        }
      } catch {}
    }
    if (!conv.lead) {
      conv.lead = {};
    }
    if (walkInCleanedComment) {
      conv.lead.walkInComment = walkInCleanedComment;
      conv.lead.walkInCommentUsedAt = undefined;
      conv.updatedAt = new Date().toISOString();
      saveConversation(conv);
    }
    const walkInOutcomeConfidence =
      typeof llmWalkInOutcome?.confidence === "number" ? llmWalkInOutcome.confidence : 0;
    const walkInOutcomeConfidenceMin = Number(process.env.LLM_WALKIN_OUTCOME_CONFIDENCE_MIN ?? 0.72);
    const walkInOutcomeAccepted =
      !!llmWalkInOutcome &&
      walkInOutcomeConfidence >= walkInOutcomeConfidenceMin &&
      llmWalkInOutcome.explicitState;
    const walkInState = walkInOutcomeAccepted ? llmWalkInOutcome?.state ?? "none" : "none";

    const hasDepositSignal =
      walkInState === "deposit_left" ||
      (!walkInOutcomeAccepted &&
        (/\b(left|put|placed|took|received)\s+(a\s+)?deposit\b/.test(commentLower) ||
          /\bdeposit\s+(left|taken|received|put|placed)\b/.test(commentLower)));
    const hasSoldSignal =
      walkInState === "sold_delivered" ||
      (!walkInOutcomeAccepted && /\b(sold|delivered|picked up)\b/.test(commentLower));
    const hasCreditCosignerSignal =
      walkInState === "cosigner_required" ||
      (!walkInOutcomeAccepted &&
        ((/\b(credit app|credit application|finance app|finance application|ran credit)\b/.test(commentLower) &&
          /\b(co[-\s]?signer|cosigner)\b/.test(commentLower)) ||
          /\bneeds?\s+(a\s+)?co[-\s]?signer\b/.test(commentLower)));
    const hasCompletedTestRideSignal =
      walkInState === "test_ride_completed" ||
      (!walkInOutcomeAccepted &&
        (/\b(took|completed|did|finished)\s+(a\s+)?(test ride|demo ride)\b/.test(commentLower) ||
          /\b(test ride|demo ride)\s+(completed|done)\b/.test(commentLower)));
    const hasDecisionPendingSignal =
      walkInState === "decision_pending" ||
      (!walkInOutcomeAccepted &&
        /\b(thinking it over|think it over|sleep on it|not ready|not ready yet|will let (you|us) know|get back to (you|us)|reach back out)\b/.test(
          commentLower
        ));
    const hasOutsideFinancingPendingSignal =
      walkInState === "outside_financing_pending" ||
      (!walkInOutcomeAccepted &&
        /\b(credit union|cu financing|bank loan|bank financing|outside financing|waiting on (the )?(bank|credit union)|waiting on approval)\b/.test(
          commentLower
        ));
    const hasDownPaymentPendingSignal =
      walkInState === "down_payment_pending" ||
      (!walkInOutcomeAccepted &&
        /\b(waiting for down payment|saving up for down payment|save up for down payment|don'?t have enough down|need more down|down payment)\b/.test(
          commentLower
        ));
    const hasTradeEquityPendingSignal =
      walkInState === "trade_equity_pending" ||
      (!walkInOutcomeAccepted &&
        /\b(sell my bike first|sell it first|trade value|waiting on trade value|upside down|negative equity|payoff)\b/.test(
          commentLower
        ));
    const hasTimingDeferWindowSignal =
      walkInState === "timing_defer_window" ||
      (!walkInOutcomeAccepted &&
        /\b(after winter|next month|after tax return|after taxes|after bonus|later this year|next season)\b/.test(
          commentLower
        ));
    const hasHouseholdApprovalPendingSignal =
      walkInState === "household_approval_pending" ||
      (!walkInOutcomeAccepted &&
        /\b(talk to (my )?(wife|husband|spouse|partner)|wife needs to approve|husband needs to approve|spouse decision|partner decision)\b/.test(
          commentLower
        ));
    const hasDocsOrInsurancePendingSignal =
      walkInState === "docs_or_insurance_pending" ||
      (!walkInOutcomeAccepted &&
        /\b(waiting on insurance|insurance quote|need (the )?title|need docs|paperwork first|registration first|dmv first)\b/.test(
          commentLower
        ));
    const hasHoldSignal =
      /\b(mark|set|put|place)\b.{0,24}\b(on\s+)?hold\b/.test(commentLower) ||
      /\bhold until\b/.test(commentLower) ||
      /\bstatus\s*[:\-]?\s*hold\b/.test(commentLower) ||
      /\bon hold\b/.test(commentLower);
    const hasResumeHoldSignal =
      /\b(clear|remove|release|take off)\b.{0,24}\bhold\b/.test(commentLower) ||
      /\bunhold\b/.test(commentLower) ||
      /\bresume\b/.test(commentLower) ||
      /\breopen\b/.test(commentLower) ||
      /\breactivate\b/.test(commentLower);

    if (hasCreditCosignerSignal) {
      conv.dialogState = { name: "payments_handoff", updatedAt: new Date().toISOString() };
      addTodo(conv, "approval", event.body ?? walkInCleanedComment, event.providerMessageId);
      setFollowUpMode(conv, "manual_handoff", "credit_app_cosigner");
      stopFollowUpCadence(conv, "manual_handoff");
    }
    if (hasDepositSignal || hasSoldSignal) {
      conv.dialogState = { name: "schedule_booked", updatedAt: new Date().toISOString() };
      addTodo(conv, "other", event.body ?? walkInCleanedComment, event.providerMessageId);
      setFollowUpMode(conv, "manual_handoff", hasSoldSignal ? "sold_walkin_note" : "deposit_walkin_note");
      stopFollowUpCadence(conv, "manual_handoff");
      if (hasSoldSignal) {
        closeConversation(conv, "sold_walkin_note");
      }
    } else if (hasCompletedTestRideSignal) {
      conv.dialogState = { name: "test_ride_booked", updatedAt: new Date().toISOString() };
      addCallTodoIfMissing(
        conv,
        "Post-test-ride update needed: contact customer, confirm next step, and update lead status."
      );
      setFollowUpMode(conv, "manual_handoff", "test_ride_completed_walkin");
      stopFollowUpCadence(conv, "manual_handoff");
    } else if (hasHoldSignal) {
      const nowIso = new Date().toISOString();
      const createdAt = conv.hold?.createdAt ?? nowIso;
      conv.status = "open";
      if (conv.closedReason && /\bhold\b/i.test(String(conv.closedReason))) {
        conv.closedReason = undefined;
        conv.closedAt = undefined;
      }
      conv.hold = {
        ...conv.hold,
        note: walkInCleanedComment || event.body || "Walk-in hold note",
        reason: "manual_hold",
        createdAt,
        updatedAt: nowIso
      };
      setFollowUpMode(conv, "paused_indefinite", "manual_hold");
      stopFollowUpCadence(conv, "manual_hold");
    } else if (hasResumeHoldSignal) {
      conv.hold = undefined;
      conv.status = "open";
      if (conv.closedReason && /\bhold\b/i.test(String(conv.closedReason))) {
        conv.closedReason = undefined;
        conv.closedAt = undefined;
      }
      setFollowUpMode(conv, "active", "manual_hold_clear");
      if (conv.followUpCadence?.status === "stopped") {
        conv.followUpCadence = undefined;
      }
      const cfg = await getSchedulerConfig();
      if (!conv.followUpCadence) {
        startFollowUpCadence(conv, new Date().toISOString(), cfg.timezone);
      } else {
        conv.followUpCadence.status = "active";
        conv.followUpCadence.pausedUntil = undefined;
        conv.followUpCadence.pauseReason = undefined;
      }
    }
    let walkInDelayReason: string | null = null;
    let walkInDelayDays: number | null = null;
    if (!(hasDepositSignal || hasSoldSignal || hasCreditCosignerSignal || hasHoldSignal || hasResumeHoldSignal)) {
      if (hasOutsideFinancingPendingSignal) {
        walkInDelayReason = "outside_financing_pending";
        walkInDelayDays = 5;
      } else if (hasDownPaymentPendingSignal) {
        walkInDelayReason = "down_payment_pending";
        walkInDelayDays = 21;
      } else if (hasTradeEquityPendingSignal) {
        walkInDelayReason = "trade_equity_pending";
        walkInDelayDays = 7;
      } else if (hasTimingDeferWindowSignal) {
        walkInDelayReason = "timing_defer_window";
        walkInDelayDays = 14;
      } else if (hasHouseholdApprovalPendingSignal) {
        walkInDelayReason = "household_approval_pending";
        walkInDelayDays = 4;
      } else if (hasDocsOrInsurancePendingSignal) {
        walkInDelayReason = "docs_or_insurance_pending";
        walkInDelayDays = 5;
      } else if (hasDecisionPendingSignal) {
        walkInDelayReason = "decision_pending";
        walkInDelayDays = 5;
      }
    }
    let tail = "I’ll keep an eye out and let you know if one comes in.";
    if (hasCreditCosignerSignal) {
      tail = "I saw the credit app note and I’ll have our finance team follow up about the co-signer.";
    } else if (hasDepositSignal || hasSoldSignal) {
      tail = hasSoldSignal
        ? "Thanks again — we’ll take it from here and follow up if anything is needed."
        : "Thanks for the deposit note — we’ll follow up with next steps.";
    } else if (hasCompletedTestRideSignal) {
      tail = "Thanks again for taking the test ride today. What feels like the best next step for you?";
    } else if (walkInDelayReason === "outside_financing_pending") {
      tail = "Sounds good — once you hear back from your credit union, text me and I’ll help with next steps.";
    } else if (walkInDelayReason === "down_payment_pending") {
      tail = "Got it — keep me posted as you save for down payment and I can run options when you’re ready.";
    } else if (walkInDelayReason === "trade_equity_pending") {
      tail = "Understood — once you have your trade/payoff numbers, send them over and I’ll tighten your options.";
    } else if (walkInDelayReason === "timing_defer_window") {
      tail = "Sounds good — I’ll circle back around your timing window and keep this easy.";
    } else if (walkInDelayReason === "household_approval_pending") {
      tail = "No problem — talk it over and text me when you want to move forward.";
    } else if (walkInDelayReason === "docs_or_insurance_pending") {
      tail = "Makes sense — once docs/insurance are lined up, I can help you finish this out.";
    } else if (walkInDelayReason === "decision_pending") {
      tail = "No rush — think it over and I’m here when you’re ready.";
    } else if (hasHoldSignal) {
      tail = "Understood — I marked this lead on hold and paused automated follow-up.";
    } else if (hasResumeHoldSignal) {
      tail = "Sounds good — I cleared the hold and reactivated follow-up.";
    }
    const walkInTestRideRequested =
      (walkInOutcomeAccepted && !!llmWalkInOutcome?.testRideRequested) ||
      /(test ride|demo ride)/i.test(walkInCleanedComment);
    const walkInWeatherSensitive =
      (walkInOutcomeAccepted && !!llmWalkInOutcome?.weatherSensitive) ||
      /weather/i.test(walkInCleanedComment);
    const walkInFollowUpWindowHint = String(llmWalkInOutcome?.followUpWindowText ?? "").trim();
    const walkInHasNextWeekWindow =
      (walkInOutcomeAccepted && /next week/i.test(walkInFollowUpWindowHint)) ||
      /(next week|check back|reach out|follow up)/i.test(walkInCleanedComment);

    if (!hasCompletedTestRideSignal) {
      if (walkInTestRideRequested && walkInWeatherSensitive) {
        tail = "I’ll reach back when the weather looks better and we can line up your test ride.";
      } else if (walkInTestRideRequested && walkInHasNextWeekWindow) {
        tail = "I’ll check back next week and we can line up your test ride.";
      }
    }
    if (modelLabel && !hasCompletedTestRideSignal) {
      if (wantsUsed) {
        const usedLabel = `used ${rangeLabel}${modelLabel}`;
        tail = hasUsedMatch
          ? `We do have a ${usedLabel} in stock right now — want me to send details?`
          : `I’ll keep an eye out for a ${usedLabel} and let you know if one comes in.`;
      } else if (wantsNew && hasWatchIntent) {
        const newLabel = `new ${rangeLabel}${modelLabel}`;
        tail = hasNewMatch
          ? `We do have a ${newLabel} in stock right now — want me to send details?`
          : `I’ll keep an eye out for a ${newLabel} and let you know when one comes in.`;
      } else {
        const label = `${rangeLabel}${modelLabel}`;
        tail = `I’ll keep an eye out for a ${label} and let you know if one comes in.`;
      }
      if (walkInTestRideRequested && walkInWeatherSensitive) {
        const rideLabel = wantsUsed
          ? `used ${rangeLabel}${modelLabel}`
          : wantsNew
            ? `new ${rangeLabel}${modelLabel}`
            : `${rangeLabel}${modelLabel}`;
        tail = `I’ll reach back when the weather looks better and we can line up your test ride on ${rideLabel}.`;
      } else if (walkInTestRideRequested && walkInHasNextWeekWindow) {
        const rideLabel = wantsUsed
          ? `used ${rangeLabel}${modelLabel}`
          : wantsNew
            ? `new ${rangeLabel}${modelLabel}`
            : `${rangeLabel}${modelLabel}`;
        tail = `I’ll check back next week and we can line up your test ride on ${rideLabel}.`;
      }
    }
    const hasDirectedTestRidePlan = /line up your test ride|reach back when the weather looks better|check back next week/i.test(
      tail
    );
    const buildWalkInAddendum = () => {
      if (!walkInCleanedComment) return "";
      const followUpHint = /(follow\s*up|check\s*back|reach\s*out).{0,40}\b(next\s+week|next\s+month|this\s+week|this\s+month|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i.exec(walkInCleanedComment);
      const parserWindow = walkInOutcomeAccepted ? walkInFollowUpWindowHint : "";
      const followUpWindow = parserWindow || (followUpHint?.[2] ?? "");
      if (followUpWindow) {
        return `I’ll plan to follow up ${followUpWindow.toLowerCase()}.`;
      }
      if (/(thinking it over|think it over|sleep on it|not ready|no rush|not ready yet|just looking)/i.test(walkInCleanedComment)) {
        return "No rush — I’m here whenever you’re ready.";
      }
      if (/(order|factory order|place an order|put an order)/i.test(walkInCleanedComment)) {
        return "If you decide to place an order, I can help with next steps.";
      }
      if (walkInTestRideRequested) {
        if (hasDirectedTestRidePlan) return "";
        return "If you want a test ride, just let me know.";
      }
      return "";
    };
    const addendum = buildWalkInAddendum();
    const ack =
      `Hi ${firstName} — this is ${salespersonName} at ${dealerName}. ` +
      "Thanks for stopping in, it was nice chatting with you. " +
      tail +
      (addendum ? ` ${addendum}` : "");
    const suppressWalkInAutoAck = hasCompletedTestRideSignal || hasHoldSignal || hasResumeHoldSignal;

    if (
      modelLabel &&
      wantsUsed &&
      !hasUsedMatch &&
      !(hasDepositSignal || hasSoldSignal || hasCreditCosignerSignal)
    ) {
      const watch: InventoryWatch = {
        model: modelLabel,
        condition: "used",
        year: singleYear,
        yearMin: yearRange?.min,
        yearMax: yearRange?.max,
        color: desiredColor,
        trim: desiredTrim,
        minPrice: priceRange?.minPrice,
        maxPrice: priceRange?.maxPrice,
        exactness: "model_only",
        status: "active",
        createdAt: new Date().toISOString(),
        note: "walk_in"
      };
      if (watch.yearMin && watch.yearMax) {
        watch.exactness = "model_range";
      } else if (watch.year) {
        watch.exactness = "year_model";
      }
      conv.inventoryWatch = watch;
      conv.inventoryWatches = [watch];
      conv.inventoryWatchPending = undefined;
      conv.dialogState = { name: "inventory_watch_active", updatedAt: new Date().toISOString() };
      setFollowUpMode(conv, "holding_inventory", "inventory_watch");
      stopFollowUpCadence(conv, "inventory_watch");
    } else if (
      modelLabel &&
      wantsNew &&
      hasWatchIntent &&
      !hasNewMatch &&
      !(hasDepositSignal || hasSoldSignal || hasCreditCosignerSignal)
    ) {
      const watch: InventoryWatch = {
        model: modelLabel,
        condition: "new",
        year: singleYear,
        yearMin: yearRange?.min,
        yearMax: yearRange?.max,
        color: desiredColor,
        trim: desiredTrim,
        minPrice: priceRange?.minPrice,
        maxPrice: priceRange?.maxPrice,
        exactness: "model_only",
        status: "active",
        createdAt: new Date().toISOString(),
        note: "walk_in_new"
      };
      if (watch.yearMin && watch.yearMax) {
        watch.exactness = "model_range";
      } else if (watch.year) {
        watch.exactness = "year_model";
      }
      conv.inventoryWatch = watch;
      conv.inventoryWatches = [watch];
      conv.inventoryWatchPending = undefined;
      conv.dialogState = { name: "inventory_watch_active", updatedAt: new Date().toISOString() };
      setFollowUpMode(conv, "holding_inventory", "inventory_watch");
      stopFollowUpCadence(conv, "inventory_watch");
    }

    if (!suppressWalkInAutoAck) {
      appendOutbound(conv, "dealership", leadKey, ack, "draft_ai", undefined, initialMediaUrls);
    }
    if (walkInDelayReason && walkInDelayDays && !hasCreditCosignerSignal && !(hasDepositSignal || hasSoldSignal)) {
      const cfg = await getSchedulerConfig();
      if (!conv.followUpCadence?.status) {
        startFollowUpCadence(conv, new Date().toISOString(), cfg.timezone);
      }
      pauseFollowUpCadence(conv, isoDaysFromNow(walkInDelayDays), walkInDelayReason);
      setFollowUpMode(conv, "active", walkInDelayReason);
      if (walkInDelayReason === "trade_equity_pending") {
        addTodo(conv, "payments", event.body ?? walkInCleanedComment, event.providerMessageId);
      }
    }
    const shouldStartWalkInCadence =
      !conv.followUpCadence?.status &&
      !conv.appointment?.bookedEventId &&
      conv.followUp?.mode !== "holding_inventory" &&
      conv.followUp?.mode !== "manual_handoff" &&
      conv.followUp?.mode !== "paused_indefinite" &&
      !hasCompletedTestRideSignal &&
      !hasHoldSignal &&
      !hasResumeHoldSignal &&
      !hasDepositSignal &&
      !hasSoldSignal &&
      !hasCreditCosignerSignal;
    if (shouldStartWalkInCadence) {
      const cfg = await getSchedulerConfig();
      startFollowUpCadence(conv, new Date().toISOString(), cfg.timezone);
    }
    return res.status(200).json({
      ok: true,
      parsed: true,
      leadKey,
      lead,
      leadSource,
      bucket: inferredBucket,
      cta: inferredCta,
      channel,
      intent: "GENERAL",
      stage: "ENGAGED",
      draft: ack
    });
  }

  const isUsed =
    conv.lead?.vehicle?.condition === "used" ||
    (!!conv.lead?.vehicle?.stockId && /^u/i.test(conv.lead?.vehicle?.stockId ?? "")) ||
    /\bU[A-Z0-9]{0,4}-\d{1,4}\b/i.test(event.body);
  const isPendingComplaint = /sale pending|still pending|been pending|pending for|pending too long|what is going on/i.test(
    event.body
  );
  if (isUsed && isPendingComplaint) {
    let ack =
      "Thanks — I’ll check the sale‑pending status and follow up soon.";
    ack = await applyInitialAdfPrefix(ack);
    ack = withInitialPhoto(ack);
    ack = withInitialAvailabilityLine(ack);
    addTodo(conv, "other", event.body, event.providerMessageId);
    setFollowUpMode(conv, "manual_handoff", "pending_used_followup");
    stopFollowUpCadence(conv, "manual_handoff");
    appendOutbound(conv, "dealership", leadKey, ack, "draft_ai", undefined, initialMediaUrls);
    maybeAddInitialCallTodo();
    return res.status(200).json({
      ok: true,
      parsed: true,
      leadKey,
      lead,
      leadSource,
      bucket: inferredBucket,
      cta: inferredCta,
      channel,
      intent: "GENERAL",
      stage: "ENGAGED",
      draft: ack
    });
  }

  const isRoom58Sell =
    /room58/i.test(leadSourceLower) && /(sell|sell your vehicle|sell your bike)/i.test(leadSourceLower);
  const isMarketplaceSell = /marketplace/i.test(leadSourceLower) && /sell/.test(leadSourceLower);
  const isSellLead = inferredBucket === "trade_in_sell" || inferredCta === "sell_my_bike";
  if ((isRoom58Sell || isMarketplaceSell) && isSellLead) {
    const profile = await getDealerProfile();
    const dealerName = profile?.dealerName ?? "American Harley-Davidson";
    const agentName = profile?.agentName ?? "Brooke";
    const buyingUsedEnabled = profile?.buying?.usedBikesEnabled !== false;
    const sellOption = conv.lead?.sellOption;
    const tradeIntent = sellOption === "trade" || sellOption === "either";
    const blockPurchase = !buyingUsedEnabled && !tradeIntent;
    const firstName = normalizeDisplayCase(conv.lead?.firstName);
    const modelLabel = normalizeVehicleModel(
      conv.lead?.vehicle?.model ?? conv.lead?.vehicle?.description ?? "",
      conv.lead?.vehicle?.make ?? null
    );
    const yearLabel = conv.lead?.vehicle?.year ? `${conv.lead?.vehicle?.year} ` : "";
    const bikeLabel = modelLabel ? `${yearLabel}${modelLabel}`.trim() : "your bike";
    const sellLabel = bikeLabel.startsWith("your ") ? bikeLabel.slice(5) : bikeLabel;
    let ack = "";
    let emailDraft = "";
    if (blockPurchase) {
      ack =
        `Thanks — I got your note about selling your ${sellLabel}. ` +
        `This is ${agentName} at ${dealerName}. ` +
        "Just a heads‑up: we’re not purchasing used bikes outright at the moment. " +
        "If you’re open to a trade‑in, I’m happy to help.";
      ack = await applyInitialAdfPrefix(ack);
      const rawName =
        firstName || normalizeDisplayCase(conv.lead?.name) || "there";
      const name = rawName.split(" ")[0] || "there";
      emailDraft =
        `Hi ${name},\n\nThanks for reaching out about selling your ${sellLabel}. ` +
        `This is ${agentName} at ${dealerName}. ` +
        "Just a heads‑up: we’re not purchasing used bikes outright at the moment. " +
        "If you’re open to a trade‑in, I’m happy to help.\n\nThanks,";
      setFollowUpMode(conv, "paused_indefinite", "not_buying_used");
      stopFollowUpCadence(conv, "not_buying_used");
    } else {
      ack =
        `Thanks — I got your note about selling your ${sellLabel}. ` +
        `This is ${agentName} at ${dealerName}. ` +
        "We can do a quick in‑person appraisal and give you a firm offer. " +
        "If you’re open to stopping by, what day and time works best?";
      ack = await applyInitialAdfPrefix(ack);
      const bookingUrl = buildBookingUrlForLead(profile?.bookingUrl, conv);
      const bookingLine = bookingUrl
        ? `You can book an appointment here: ${bookingUrl}`
        : "Just reply with a day and time that works for you.";
      const rawName =
        firstName || normalizeDisplayCase(conv.lead?.name) || "there";
      const name = rawName.split(" ")[0] || "there";
      emailDraft =
        `Hi ${name},\n\nThanks for reaching out about selling your ${sellLabel}. ` +
        `This is ${agentName} at ${dealerName}. ` +
        "We can do a quick in‑person appraisal and give you a firm offer. " +
        `If you’d like to stop in, ${bookingLine}\n\nThanks,`;
    }
    conv.emailDraft = emailDraft;
    const systemMode = getSystemMode();
    const emailTo = conv.lead?.email?.trim();
    const canSendEmail = systemMode !== "suggest" && !!emailTo && conv.lead?.emailOptIn === true;
    if (canSendEmail) {
      const { from: emailFrom, replyTo: emailReplyTo, signature } = {
        from: (profile?.fromEmail ?? process.env.SENDGRID_FROM_EMAIL ?? "").trim(),
        replyTo: (profile?.replyToEmail ?? process.env.SENDGRID_REPLY_TO ?? "").trim(),
        signature: String(profile?.emailSignature ?? "").trim() || undefined
      };
      const replyTo = maybeTagReplyTo(emailReplyTo || undefined, conv);
      if (emailFrom) {
        try {
          const subject = `Thanks for your inquiry at ${dealerName}`;
          const signed =
            signature
              ? `${emailDraft}\n\n${signature}${profile?.logoUrl ? `\n\n${profile.logoUrl}` : ""}`
              : appendFallbackEmailSignoff(emailDraft, profile);
          await sendEmail({
            to: emailTo!,
            subject,
            text: signed,
            from: emailFrom,
            replyTo
          });
          appendOutbound(conv, emailFrom, emailTo!, signed, "sendgrid");
        } catch (e: any) {
          console.log("[sendgrid inbound] email send failed:", e?.message ?? e);
        }
      }
    }
    appendOutbound(conv, "dealership", leadKey, ack, "draft_ai", undefined, initialMediaUrls);
    maybeAddInitialCallTodo();
    return res.status(200).json({
      ok: true,
      parsed: true,
      leadKey,
      lead,
      leadSource,
      bucket: inferredBucket,
      cta: inferredCta,
      channel,
      intent: "GENERAL",
      stage: "ENGAGED",
      draft: ack
    });
  }

  if (isRoom58Standard) {
    const profile = await getDealerProfile();
    const dealerName = profile?.dealerName ?? "American Harley-Davidson";
    const agentName = profile?.agentName ?? "Brooke";
    const firstName = normalizeDisplayCase(conv.lead?.firstName);
    const greeting = firstName ? `Hi ${firstName} — ` : "Hi — ";
    let ack = `${greeting}Thanks — I got your inquiry. This is ${agentName} at ${dealerName}. I’ll make sure the team follows up soon.`;
    ack = await applyInitialAdfPrefix(ack);
    ack = withInitialPhoto(ack);
    ack = withInitialAvailabilityLine(ack);

    addTodo(conv, "other", event.body, event.providerMessageId);
    setFollowUpMode(conv, "manual_handoff", "room58_standard");
    stopFollowUpCadence(conv, "manual_handoff");
    appendOutbound(conv, "dealership", leadKey, ack, "draft_ai", undefined, initialMediaUrls);
    maybeAddInitialCallTodo();
    return res.status(200).json({
      ok: true,
      parsed: true,
      leadKey,
      lead,
      leadSource,
      bucket: inferredBucket,
      cta: inferredCta,
      channel,
      intent: "GENERAL",
      stage: "ENGAGED",
      draft: ack
    });
  }

  const inquiryTextRaw = String(lead.inquiry ?? inquiryRaw ?? "").trim();
  const hasInventoryIdentifiers = !!conv.lead?.vehicle?.stockId || !!conv.lead?.vehicle?.vin;
  const routeRoom58PriceHandoff = shouldRouteRoom58PriceHandoff({
    isInitialAdf,
    leadSourceLower,
    inquiryRaw: inquiryTextRaw,
    hasInventoryIdentifiers,
    pricingInquiryIntent
  });
  if (routeRoom58PriceHandoff) {
    const profile = await getDealerProfile();
    const dealerName = profile?.dealerName ?? "American Harley-Davidson";
    const agentName = profile?.agentName ?? "Brooke";
    const firstName = normalizeDisplayCase(conv.lead?.firstName);
    const modelLabel = normalizeVehicleModel(
      conv.lead?.vehicle?.model ?? conv.lead?.vehicle?.description ?? "",
      conv.lead?.vehicle?.make ?? null
    );
    const yearLabel = conv.lead?.vehicle?.year ? `${conv.lead?.vehicle?.year} ` : "";
    const bikeLabel = modelLabel ? `${yearLabel}${modelLabel}`.trim() : "that bike";
    const greeting = firstName ? `Hi ${firstName} — ` : "Hi — ";
    let ack =
      `${greeting}This is ${agentName} at ${dealerName}. ` +
      `Thanks for asking about pricing on the ${bikeLabel}. ` +
      "I’ll have our team confirm the current price and send it over shortly.";
    ack = await applyInitialAdfPrefix(ack);
    ack = withInitialPhoto(ack);
    addTodo(conv, "pricing", event.body, event.providerMessageId);
    setFollowUpMode(conv, "manual_handoff", "room58_price_confirm");
    stopFollowUpCadence(conv, "manual_handoff");
    markPricingEscalated(conv);
    appendOutbound(conv, "dealership", leadKey, ack, "draft_ai", undefined, initialMediaUrls);
    maybeAddInitialCallTodo();
    return res.status(200).json({
      ok: true,
      parsed: true,
      leadKey,
      lead,
      leadSource,
      bucket: inferredBucket,
      cta: inferredCta,
      channel,
      intent: "GENERAL",
      stage: "ENGAGED",
      draft: ack
    });
  }

  if (isMetaPromoOffer && /^(other|full line)$/i.test(metaOfferRawModel.trim())) {
    const profile = await getDealerProfile();
    const dealerName = profile?.dealerName ?? "American Harley-Davidson";
    const agentName = profile?.agentName ?? "Brooke";
    const firstName = normalizeDisplayCase(conv.lead?.firstName);
    const greeting = firstName ? `Hi ${firstName} — ` : "Hi — ";
    let ack =
      `${greeting}Thanks — I got your H‑D Meta promo offer request. ` +
      `This is ${agentName} at ${dealerName}. ` +
      `I can help with pricing — which model are you interested in, and any trim or color?`;
    ack = await applyInitialAdfPrefix(ack);
    ack = withInitialPhoto(ack);
    ack = withInitialAvailabilityLine(ack);

    appendOutbound(conv, "dealership", leadKey, ack, "draft_ai", undefined, initialMediaUrls);
    maybeAddInitialCallTodo();
    const emailGreeting = firstName ? `Hi ${firstName},` : "Hi,";
    conv.emailDraft = [
      emailGreeting,
      "",
      "Thanks for your H-D Meta promo offer request.",
      `This is ${agentName} at ${dealerName}.`,
      "I can help with pricing and availability.",
      "Which model are you interested in, and do you have a preferred trim or color?"
    ].join("\n");
    return res.status(200).json({
      ok: true,
      parsed: true,
      leadKey,
      lead,
      leadSource,
      bucket: inferredBucket,
      cta: inferredCta,
      channel,
      intent: "GENERAL",
      stage: "ENGAGED",
      draft: ack
    });
  }

  const modelMismatch = isInitialAdf
    ? detectInitialAdfModelMismatch({
        leadModel: conv.lead?.vehicle?.model ?? conv.lead?.vehicle?.description ?? null,
        leadMake: conv.lead?.vehicle?.make ?? null,
        inquiry: lead.inquiry ?? inquiryRaw
      })
    : null;
  if (modelMismatch) {
    let ack =
      `Thanks for the details. I want to make sure I quote the right bike: ` +
      `I saw ${modelMismatch.leadModel} on the lead and ${modelMismatch.inquiryModel} in your message. ` +
      "Which one would you like pricing on?";
    ack = await applyInitialAdfPrefix(ack);
    appendOutbound(conv, "dealership", leadKey, ack, "draft_ai");
    maybeAddInitialCallTodo();
    conv.emailDraft = ack;
    return res.status(200).json({
      ok: true,
      parsed: true,
      leadKey,
      lead,
      leadSource,
      bucket: inferredBucket,
      cta: inferredCta,
      channel,
      intent: "GENERAL",
      stage: "ENGAGED",
      draft: ack,
      modelMismatch
    });
  }

  const history = conv.messages.slice(-20).map(m => ({ direction: m.direction, body: m.body }));
  const result = await orchestrateInbound(event, history, {
    appointment: conv.appointment,
    followUp: conv.followUp,
    lead: conv.lead,
    leadSource: conv.lead?.source ?? null,
    bucket: conv.classification?.bucket ?? null,
    cta: conv.classification?.cta ?? null,
    pricingAttempts: getPricingAttempts(conv),
    allowSchedulingOffer: true
  });
  console.log("[sendgrid inbound] requestedTime", result.requestedTime);

  const setDialogState = (name: string) => {
    const updatedAt = new Date().toISOString();
    if (conv.dialogState?.name === name) {
      conv.dialogState.updatedAt = updatedAt;
      return;
    }
    conv.dialogState = { name, updatedAt } as any;
  };
  const draftText = String(result.draft ?? "");
  if (/(still available|in stock right now|not seeing .* in stock|checking availability)/i.test(draftText)) {
    setDialogState("inventory_answered");
  }
  if (
    !conv.appointment?.bookedEventId &&
    /(what time works best|what day and time works best|what time were you thinking|reserve that time)/i.test(
      draftText
    )
  ) {
    setDialogState("schedule_request");
  }

  if (result.handoff?.required) {
    const reason = result.handoff.reason;
    let ack = await applyInitialAdfPrefix(result.handoff.ack);
    ack = withInitialPhoto(ack);
    ack = withInitialAvailabilityLine(ack);
    if (!creditTodoCreated) {
      addTodo(conv, reason, event.body, event.providerMessageId);
    }
    setFollowUpMode(conv, "manual_handoff", `handoff:${reason}`);
    stopFollowUpCadence(conv, "manual_handoff");
    if (reason === "pricing" || reason === "payments") {
      markPricingEscalated(conv);
    }
    appendOutbound(conv, "dealership", leadKey, ack, "draft_ai", undefined, initialMediaUrls);
    maybeAddInitialCallTodo();
    conv.emailDraft = ack;
    return res.status(200).json({
      ok: true,
      parsed: true,
      leadKey,
      lead,
      leadSource,
      bucket: inferredBucket,
      cta: inferredCta,
      channel,
      intent: result.intent,
      stage: result.stage,
      draft: ack,
      handoff: { ...result.handoff, ack }
    });
  }

  if (result.autoClose?.reason) {
    let ack = await applyInitialAdfPrefix(result.draft);
    ack = withInitialPhoto(ack);
    ack = withInitialAvailabilityLine(ack);
    closeConversation(conv, result.autoClose.reason);
    appendOutbound(conv, "dealership", leadKey, ack, "draft_ai", undefined, initialMediaUrls);
    maybeAddInitialCallTodo();
    conv.emailDraft = ack;
    return res.status(200).json({
      ok: true,
      parsed: true,
      leadKey,
      lead,
      leadSource,
      bucket: inferredBucket,
      cta: inferredCta,
      channel,
      intent: result.intent,
      stage: result.stage,
      draft: ack,
      autoClose: result.autoClose
    });
  }

  if (result.pricingAttempted) {
    incrementPricingAttempt(conv);
  }

  if (isInitialAdf) {
    const profile = await getDealerProfile();
    const stockForNote = conv.lead?.vehicle?.stockId ?? null;
    const vinForNote = conv.lead?.vehicle?.vin ?? null;
    const inventoryNote = await getInventoryNote(stockForNote, vinForNote);
    const leadSourceLower = (conv.lead?.source ?? "").toLowerCase();
    let buildInventoryAvailable: boolean | null = null;
    if (leadSourceLower.includes("custom build")) {
      const modelForBuild = conv.lead?.vehicle?.model ?? conv.lead?.vehicle?.description ?? null;
      const yearForBuild = conv.lead?.vehicle?.year ?? null;
      if (modelForBuild && !/full line|other/i.test(modelForBuild)) {
        buildInventoryAvailable = await hasInventoryForModelYear({
          model: modelForBuild,
          year: yearForBuild,
          yearDelta: 1
        });
      } else {
        buildInventoryAvailable = false;
      }
    }
    conv.emailDraft = buildInitialEmailDraft(conv, profile, inventoryNote, buildInventoryAvailable);
  } else {
    conv.emailDraft = result.draft;
  }

  if (result.requestedTime && !conv.appointment?.bookedEventId) {
    try {
      const cfg = await getSchedulerConfig();
      console.log("[sendgrid inbound] scheduler cfg", {
        salespeople: (cfg.salespeople ?? []).length,
        preferred: (cfg.preferredSalespeople ?? []).length,
        timezone: cfg.timezone,
        appointmentTypes: Object.keys(cfg.appointmentTypes ?? {})
      });
      const appointmentTypes = cfg.appointmentTypes ?? { inventory_visit: { durationMinutes: 60 } };
      const preferredSalespeople = getPreferredSalespeople(cfg);
      const salespeople = cfg.salespeople ?? [];
      const gapMinutes = cfg.minGapBetweenAppointmentsMinutes ?? 60;
      const appointmentType = String(result.requestedAppointmentType ?? "inventory_visit");
      const durationMinutes = appointmentTypes[appointmentType]?.durationMinutes ?? 60;

      const cal = await getAuthedCalendarClient();
      const now = new Date();
      const timeMin = new Date(now).toISOString();
      const requestedDaysOut =
        result.requestedTime
          ? Math.ceil(
              (Date.UTC(
                result.requestedTime.year,
                result.requestedTime.month - 1,
                result.requestedTime.day,
                result.requestedTime.hour24,
                result.requestedTime.minute
              ) - now.getTime()) /
                (24 * 60 * 60 * 1000)
            )
          : null;
      const schedulingSearchDays = Math.max(
        14,
        Math.min(90, requestedDaysOut != null ? requestedDaysOut + 3 : 14)
      );
      const timeMax = new Date(now.getTime() + schedulingSearchDays * 24 * 60 * 60 * 1000).toISOString();

      for (const salespersonId of preferredSalespeople) {
        const sp = salespeople.find((p: any) => p.id === salespersonId);
        if (!sp) continue;

        const fb = await queryFreeBusy(cal, [sp.calendarId], timeMin, timeMax, cfg.timezone);
        const busy = (fb.calendars?.[sp.calendarId]?.busy ?? []) as any;
        const expanded = expandBusyBlocks(busy, gapMinutes);

        let exact = findExactSlotForSalesperson(
          cfg,
          sp.id,
          sp.calendarId,
          result.requestedTime,
          durationMinutes,
          expanded
        );
        if (!exact) {
          const requested = result.requestedTime!;
          const requestedStartUtc = localPartsToUtcDate(cfg.timezone, requested);
          const candidatesByDay = generateCandidateSlots(
            cfg,
            now,
            durationMinutes,
            schedulingSearchDays
          );
          const matchesSameDay = (d: Date) => {
            const fmt = new Intl.DateTimeFormat("en-US", {
              timeZone: cfg.timezone,
              year: "numeric",
              month: "2-digit",
              day: "2-digit"
            });
            const parts = fmt.formatToParts(d);
            const map: Record<string, string> = {};
            for (const p of parts) {
              if (p.type !== "literal") map[p.type] = p.value;
            }
            return (
              Number(map.year) === requested.year &&
              Number(map.month) === requested.month &&
              Number(map.day) === requested.day
            );
          };
          const candidate = candidatesByDay
            .flatMap(d => d.candidates)
            .find(c => matchesSameDay(c.start) && c.start.getTime() === requestedStartUtc.getTime());
          if (candidate) {
            const blocked = expanded.some(b => candidate.start < b.end && b.start < candidate.end);
            if (!blocked) {
              exact = {
                salespersonId: sp.id,
                calendarId: sp.calendarId,
                start: candidate.start.toISOString(),
                end: candidate.end.toISOString()
              };
            }
          }
        }
        if (!exact) {
          console.log("[sendgrid inbound] exact slot not found", {
            salespersonId: sp.id,
            calendarId: sp.calendarId,
            requestedTime: result.requestedTime
          });
        }

        if (exact) {
          const stockId = conv.lead?.vehicle?.stockId ?? null;
          const leadNameRaw = conv.lead?.name?.trim() ?? "";
          const firstName = normalizeDisplayCase(conv.lead?.firstName);
          const lastName = conv.lead?.lastName ?? "";
          const leadName = leadNameRaw || [firstName, lastName].filter(Boolean).join(" ").trim() || conv.leadKey;

          const summary = `Appt: ${appointmentType} – ${leadName}${stockId ? ` – ${stockId}` : ""}`;
          const description = [
            `LeadKey: ${conv.leadKey}`,
            `Phone: ${conv.lead?.phone ?? conv.leadKey}`,
            `Email: ${conv.lead?.email ?? ""}`,
            `Stock: ${stockId ?? ""}`,
            `VIN: ${conv.lead?.vehicle?.vin ?? ""}`,
            `Source: ${conv.lead?.source ?? ""}`
          ]
            .filter(Boolean)
            .join("\n");

          const eventObj = await insertEvent(
            cal,
            exact.calendarId,
            cfg.timezone,
            summary,
            description,
            exact.start,
            exact.end
          );

          conv.appointment = conv.appointment ?? { status: "none", updatedAt: new Date().toISOString() };
          conv.appointment.status = "confirmed";
          conv.appointment.whenText = formatSlotLocal(exact.start, cfg.timezone);
          conv.appointment.whenIso = exact.start;
          conv.appointment.confirmedBy = "customer";
          conv.appointment.updatedAt = new Date().toISOString();
          conv.appointment.acknowledged = true;
          conv.appointment.bookedEventId = eventObj.id ?? null;
          conv.appointment.bookedEventLink = eventObj.htmlLink ?? null;
          conv.appointment.bookedSalespersonId = exact.salespersonId ?? null;
          stopFollowUpCadence(conv, "appointment_booked");

          if (conv.scheduler) {
            conv.scheduler.lastSuggestedSlots = [];
            conv.scheduler.updatedAt = new Date().toISOString();
          }

          const profile = await getDealerProfile();
          const dealerName = String(profile?.dealerName ?? "").trim() || "American Harley-Davidson";
          const agentName = String(profile?.agentName ?? "").trim() || "Brooke";
          const addrLine1 = String(profile?.address?.line1 ?? "").trim();
          const addrCity = String(profile?.address?.city ?? "").trim();
          const addrState = String(profile?.address?.state ?? "").trim();
          const addrZip = String(profile?.address?.zip ?? "").trim();
          const cityState = [addrCity, addrState].filter(Boolean).join(", ");
          const addressLine =
            [addrLine1, cityState, addrZip].filter(Boolean).join(" ").trim() ||
            "1149 Erie Ave., North Tonawanda, NY 14120";
          const when = formatSlotLocal(exact.start, cfg.timezone);
          const repName = String(sp.name ?? "").trim() ? ` with ${String(sp.name).trim()}` : "";
          const firstNameGreeting = conv.lead?.firstName ?? "";
          const rawModel = conv.lead?.vehicle?.model ?? conv.lead?.vehicle?.description ?? "";
          const model = /full line/i.test(rawModel) ? "" : rawModel;
          const greeting = firstNameGreeting
            ? `Hi ${firstNameGreeting} — thanks for booking a test ride${model ? ` on the ${model}` : ""}. `
            : `Thanks for booking a test ride${model ? ` on the ${model}` : ""}. `;
          const intro = `This is ${agentName} at ${dealerName}. `;
          const confirmText =
            `${greeting}${intro}` +
            `You’re booked for ${when}${repName}. ` +
            `${dealerName} is at ${addressLine}.`;

          appendOutbound(conv, "dealership", leadKey, confirmText, "draft_ai", eventObj.id ?? undefined);
          maybeAddInitialCallTodo();
          saveConversation(conv);
          await flushConversationStore();
          return res.status(200).json({
            ok: true,
            parsed: true,
            leadKey,
            lead,
            leadSource,
            bucket: inferredBucket,
            cta: inferredCta,
            channel,
            intent: result.intent,
            stage: result.stage,
            draft: confirmText,
            booked: true
          });
        }
      }
    } catch (e: any) {
      console.log("[exact-book] failed:", e?.message ?? e);
      // fall through to normal draft behavior
    }
  }

  const dealerProfile = await getDealerProfile();
  const requestedRideDate =
    result.requestedTime
      ? new Date(
          Date.UTC(
            result.requestedTime.year,
            result.requestedTime.month - 1,
            result.requestedTime.day,
            12,
            0,
            0,
            0
          )
        )
      : parsePreferredDateOnly(conv.lead?.preferredDate);
  const testRideInSeason = isTestRideSeason(dealerProfile, requestedRideDate ?? new Date());
  let draft = result.shouldRespond ? result.draft : "Thanks — I’ll follow up shortly.";
  let suppressAvailabilityAppend = false;
  if (isInitialAdf && inquiryDayPart) {
    const dayPhrase = `${inquiryDayPart.dayLabel} ${inquiryDayPart.dayPart}`;
    if (initialAvailability === "in_stock") {
      draft = `Thanks — yes, it’s still available. If you want to come by ${dayPhrase}, what time works best?`;
    } else if (initialAvailability === "not_found") {
      draft = `Thanks — I’m not seeing that in stock right now, but I can double‑check. If you still want to come by ${dayPhrase}, what time works best?`;
    } else {
      draft = `If you want to come by ${dayPhrase}, what time works best?`;
    }
  }
  if (inferredBucket === "test_ride" && !testRideInSeason) {
    const modelLabel = formatModelLabel(
      conv.lead?.vehicle?.year ?? null,
      conv.lead?.vehicle?.model ?? conv.lead?.vehicle?.description ?? null
    );
    const modelClause = modelLabel ? ` on the ${modelLabel}` : "";
    draft =
      `Thanks — I saw you’re interested in a test ride${modelClause}. ` +
      "We’re not scheduling test rides right now, but I’m happy to help with pricing or set one up when we reopen. " +
      "If you want to stop by to check it out, just let me know.";
  }
  const isPurchaseIntentLead =
    isInitialAdf &&
    !isServiceLead &&
    !isSellLead &&
    !isCreditLead &&
    !isWalkInLead &&
    !pricingInquiryIntent &&
    inferredBucket !== "trade_in_sell" &&
    inferredBucket !== "finance_prequal" &&
    inferredBucket !== "service" &&
    inferredBucket !== "test_ride";
  if (isPurchaseIntentLead) {
    const modelLabel = normalizeVehicleModel(
      conv.lead?.vehicle?.model ?? conv.lead?.vehicle?.description ?? "",
      conv.lead?.vehicle?.make ?? null
    );
    const yearLabel = conv.lead?.vehicle?.year ? `${conv.lead?.vehicle?.year} ` : "";
    const bikeLabel = modelLabel ? `${yearLabel}${modelLabel}`.trim() : "the bike";
    const hasIdentifiers = !!conv.lead?.vehicle?.stockId || !!conv.lead?.vehicle?.vin;
    const isRequestDetails = /request details/i.test(leadSourceLower);
    const questionTail = isRequestDetails ? " Any specific questions about the bike?" : "";
    if (initialAvailability === "in_stock") {
      draft =
        `Thanks for your inquiry about the ${bikeLabel}. ` +
        `If you’d like to stop in and check it out, just say the word.${questionTail ? " Any specific questions I can answer?" : ""}`;
    } else if (!hasIdentifiers) {
      draft = `Thanks — I saw you wanted to learn more about the ${bikeLabel}.${isRequestDetails ? " Any specific questions about the bike?" : ""} I’m here to help.`;
      suppressAvailabilityAppend = true;
    }
  }
  if (
    isInitialAdf &&
    pricingInquiryIntent &&
    typeof draft === "string" &&
    !/\b(payment|monthly|apr|down|budget|finance|credit app|term)\b/i.test(draft)
  ) {
    const modelLabel = normalizeVehicleModel(
      conv.lead?.vehicle?.model ?? conv.lead?.vehicle?.description ?? "",
      conv.lead?.vehicle?.make ?? null
    );
    const yearLabel = conv.lead?.vehicle?.year ? `${conv.lead?.vehicle?.year} ` : "";
    const bikeLabel = modelLabel ? `${yearLabel}${modelLabel}`.trim() : "the bike";
    draft =
      `Thanks for your question on the ${bikeLabel}. ` +
      "I can help with a payment estimate. What monthly payment feels comfortable for you, about how much down, and were you thinking 60, 72, or 84 months?";
  }
  if (
    inferredBucket === "test_ride" &&
    typeof draft === "string" &&
    /^Hi [^—]+— /i.test(draft)
  ) {
    const m = draft.match(/^Hi ([^—]+)—\s*([^.]*)\.\s*(.*)$/i);
    if (m) {
      const name = m[1];
      const rest = m[3] ?? "";
      draft = `Hi ${name} — thanks for your interest in a test ride. ${rest}`.trim();
    }
  }
  const rawModel = conv.lead?.vehicle?.model ?? conv.lead?.vehicle?.description ?? "";
  if (/full line/i.test(rawModel) && typeof draft === "string") {
    draft = draft
      .replace(/\s+in the\s+\d{4}\s+harley-davidson\s+full line\b/gi, "")
      .replace(/\s+for the\s+\d{4}\s+harley-davidson\s+full line\b/gi, "")
      .replace(/\s+on the\s+\d{4}\s+harley-davidson\s+full line\b/gi, "");
  }
  if (
    result.requestedTime &&
    typeof draft === "string" &&
    /I have .*— which works best\?/i.test(draft) &&
    !/already taken|booked up|closed/i.test(draft)
  ) {
    const introMatch = draft.match(/^(.*?\bThis is [^.]+\. )(.+)$/i);
    if (introMatch) {
      const head = introMatch[1];
      const tail = introMatch[2];
      draft = `${head}That time is already taken, but ${tail.charAt(0).toLowerCase()}${tail.slice(1)}`;
    } else if (draft.startsWith("Hi ")) {
      const marker = ". ";
      const idx = draft.indexOf(marker);
      if (idx > -1) {
        const head = draft.slice(0, idx + marker.length);
        const tail = draft.slice(idx + marker.length);
        draft = `${head}That time is already taken, but ${tail.charAt(0).toLowerCase()}${tail.slice(1)}`;
      } else {
        draft = `That time is already taken, but ${draft.charAt(0).toLowerCase()}${draft.slice(1)}`;
      }
    } else {
      draft = `That time is already taken, but ${draft.charAt(0).toLowerCase()}${draft.slice(1)}`;
    }
  }

  draft = await applyInitialAdfPrefix(draft);
  draft = withInitialPhoto(draft);
  if (!suppressAvailabilityAppend) {
    draft = withInitialAvailabilityLine(draft);
  }

  const systemMode = getSystemMode();
  const emailTo = lead.email?.trim();
  const useEmail = channel === "email" && !!emailTo && lead.emailOptIn === true;

  if (systemMode !== "suggest" && useEmail) {
    const dealerName = dealerProfile?.dealerName ?? "Dealership";
    const { from: emailFrom, replyTo: emailReplyTo, signature } = {
      from: (dealerProfile?.fromEmail ?? process.env.SENDGRID_FROM_EMAIL ?? "").trim(),
      replyTo: (dealerProfile?.replyToEmail ?? process.env.SENDGRID_REPLY_TO ?? "").trim(),
      signature: String(dealerProfile?.emailSignature ?? "").trim() || undefined
    };
    const replyTo = maybeTagReplyTo(emailReplyTo || undefined, conv);
    if (emailFrom) {
      try {
        const subject = `Thanks for your inquiry at ${dealerName}`;
        const signed =
          signature
            ? `${draft}\n\n${signature}${dealerProfile?.logoUrl ? `\n\n${dealerProfile.logoUrl}` : ""}`
            : appendFallbackEmailSignoff(draft, dealerProfile);
        await sendEmail({
          to: emailTo!,
          subject,
          text: signed,
          from: emailFrom,
          replyTo
        });
        appendOutbound(conv, emailFrom, emailTo!, signed, "sendgrid");
        maybeAddInitialCallTodo();
        saveConversation(conv);
        await flushConversationStore();
      } catch (e: any) {
        console.log("[sendgrid inbound] email send failed:", e?.message ?? e);
        appendOutbound(conv, "dealership", leadKey, draft, "draft_ai", undefined, initialMediaUrls);
        maybeAddInitialCallTodo();
      }
    } else {
      appendOutbound(conv, "dealership", leadKey, draft, "draft_ai", undefined, initialMediaUrls);
      maybeAddInitialCallTodo();
    }
  } else {
    // Store the draft as an outbound message (suggest-only for now)
    appendOutbound(conv, "dealership", leadKey, draft, "draft_ai", undefined, initialMediaUrls);
    maybeAddInitialCallTodo();
  }
  if (conv.classification?.bucket === "event_promo") {
    closeConversation(conv, "event_promo_no_cadence");
    stopFollowUpCadence(conv, "manual_handoff");
  }
  const purchaseTimeframeRaw = String(conv.lead?.purchaseTimeframe ?? "").toLowerCase();
  const notReadyTimeframe =
    /\b(not interested|not ready|not (yet|right now)|not in the market|not looking)\b/i.test(
      purchaseTimeframeRaw
    );
  const shouldStartCadence =
    !conv.followUpCadence?.status &&
    !conv.appointment?.bookedEventId &&
    conv.followUp?.mode !== "manual_handoff" &&
    conv.followUp?.mode !== "paused_indefinite" &&
    conv.classification?.bucket !== "finance_prequal" &&
    conv.classification?.bucket !== "service" &&
    conv.classification?.bucket !== "event_promo" &&
    conv.classification?.cta !== "hdfs_coa" &&
    conv.classification?.cta !== "prequalify" &&
    !notReadyTimeframe;
  if (shouldStartCadence) {
    const cfg = await getSchedulerConfig();
    const monthsStart = conv.lead?.purchaseTimeframeMonthsStart;
    if (monthsStart && monthsStart >= 1) {
      const due = new Date();
      due.setMonth(due.getMonth() + monthsStart);
      due.setHours(10, 30, 0, 0);
      const msg = buildLongTermMessage(conv.lead?.purchaseTimeframe, conv.lead?.hasMotoLicense);
      scheduleLongTermFollowUp(conv, due.toISOString(), msg);
    } else {
      startFollowUpCadence(conv, new Date().toISOString(), cfg.timezone);
    }
  } else if (notReadyTimeframe) {
    stopFollowUpCadence(conv, "not_ready_no_timeframe");
    setFollowUpMode(conv, "paused_indefinite", "not_ready_no_timeframe");
  }

  return res.status(200).json({
    ok: true,
    parsed: true,
    leadKey,
    lead,
    leadSource,
    bucket: inferredBucket,
    cta: inferredCta,
    channel,
    intent: result.intent,
    stage: result.stage,
    draft
  });
}
