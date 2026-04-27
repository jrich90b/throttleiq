import type { Request, Response } from "express";
import multer from "multer";
import twilio from "twilio";
import crypto from "node:crypto";
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
  setConversationSoftTag,
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
  computeFollowUpDueAt,
  markPricingEscalated,
  closeConversation,
  setContactPreference,
  parseRequestedDayTime,
  normalizeLeadKey,
  getConversation,
  saveConversation,
  flushConversationStore,
  listOpenQuestions,
  markQuestionDone
} from "../domain/conversationStore.js";
import type { InventoryWatch } from "../domain/conversationStore.js";
import { orchestrateInbound } from "../domain/orchestrator.js";
import { buildEffectiveHistory } from "../domain/effectiveContext.js";
import { resolveChannel, resolveLeadRule, type LeadBucket, type LeadCTA } from "../domain/leadSourceRules.js";
import {
  parseDealershipFaqTopicWithLLM,
  parseDialogActWithLLM,
  parseInventoryEntitiesWithLLM,
  parseIntentWithLLM,
  parseSemanticSlotsWithLLM,
  parseRoutingDecisionWithLLM,
  parseResponseControlWithLLM,
  parseBookingIntentWithLLM,
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
import { getDealerWeatherStatus } from "../domain/weather.js";
import { getInventoryNote } from "../domain/inventoryNotes.js";
import { getInventoryFeed, hasInventoryForModelYear, findInventoryMatches } from "../domain/inventoryFeed.js";
import { resolveInventoryUrlByStock } from "../domain/inventoryUrlResolver.js";
import { listInventoryHolds, normalizeInventoryHoldKey } from "../domain/inventoryHolds.js";
import { listInventorySolds, normalizeInventorySoldKey } from "../domain/inventorySolds.js";
import { getAllModels, isModelInRecentYearsForMake } from "../domain/modelsByYear.js";
import { shouldRouteRoom58PriceHandoff } from "../domain/adfPolicy.js";
import { isResponseControlParserAccepted } from "../domain/transitionSafety.js";
import { resolveRoutingParserDecision } from "../domain/routerV2.js";
import { listUsers } from "../domain/userStore.js";
import { formatEmailLayout } from "../domain/tone.js";
import { buildOffersLine, resolveOffersUrl } from "../domain/offers.js";

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

async function getDealerWeatherStatusSafe() {
  try {
    const profile = await getDealerProfile();
    return await getDealerWeatherStatus(profile);
  } catch {
    return null;
  }
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

function isRiderToRiderFinanceLeadSource(raw?: string | null): boolean {
  const text = String(raw ?? "").toLowerCase();
  if (!text) return false;
  const hasRiderPhrase = /\b(?:rider\s*(?:to|2|-)?\s*rider|r2r)\b/.test(text);
  const hasFinancePhrase = /\b(finance|financing)\b/.test(text);
  return hasRiderPhrase && hasFinancePhrase;
}

function dealerOffersRiderToRiderFinancing(profile: any): boolean {
  if (!profile || typeof profile !== "object") return false;
  const policies = profile?.policies && typeof profile.policies === "object" ? profile.policies : {};
  const candidates = [
    policies.riderToRiderFinancingEnabled,
    policies.riderToRiderFinanceEnabled,
    policies.offersRiderToRiderFinancing,
    profile.riderToRiderFinancingEnabled,
    profile.riderToRiderFinanceEnabled
  ];
  for (const value of candidates) {
    if (typeof value === "boolean") return value;
  }
  return false;
}

function buildRiderToRiderFinanceLeadReply(args: {
  firstName?: string | null;
  isInitialAdf: boolean;
  dealerOffersProgram: boolean;
}): string {
  const firstName = normalizeDisplayCase(args.firstName);
  if (args.dealerOffersProgram) {
    if (args.isInitialAdf) {
      return (
        "Thanks - we received your Rider to Rider financing inquiry. " +
        "I'll have our business manager reach out shortly. " +
        "If you also want a quick inventory check on the bike from your inquiry, I can confirm that too."
      );
    }
    return firstName
      ? `Thanks ${firstName} - we received your Rider to Rider financing inquiry. Our business manager will reach out shortly. If you also want a quick inventory check on the bike from your inquiry, I can confirm that too.`
      : "Thanks - we received your Rider to Rider financing inquiry. Our business manager will reach out shortly. If you also want a quick inventory check on the bike from your inquiry, I can confirm that too.";
  }
  if (args.isInitialAdf) {
    return (
      "Thanks for reaching out about Rider to Rider financing. " +
      "We don't participate in Rider to Rider financing, but we can review similar financing options we do offer. " +
      "If you also want a quick inventory check on the bike from your inquiry, I can confirm that too."
    );
  }
  return firstName
    ? `Thanks ${firstName} - we don't participate in Rider to Rider financing, but we can review similar financing options we do offer. If you also want a quick inventory check on the bike from your inquiry, I can confirm that too.`
    : "Thanks - we don't participate in Rider to Rider financing, but we can review similar financing options we do offer. If you also want a quick inventory check on the bike from your inquiry, I can confirm that too.";
}

function pickFirstToken(raw: string | null | undefined): string {
  return String(raw ?? "")
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)[0] ?? "";
}

function extractExplicitSalespersonName(raw: string | null | undefined): string {
  const text = String(raw ?? "");
  if (!text) return "";
  const patterns = [
    /\bsales\s*person\s*:\s*([a-z][a-z\s.'-]{1,40})/i,
    /\bsalesperson\s*:\s*([a-z][a-z\s.'-]{1,40})/i,
    /\bowner\s*:\s*([a-z][a-z\s.'-]{1,40})/i,
    /\bassigned\s*(?:to)?\s*:\s*([a-z][a-z\s.'-]{1,40})/i
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) return match[1].trim();
  }
  return "";
}

function normalizePhoneE164(raw: string | null | undefined): string {
  const digits = String(raw ?? "").replace(/\D/g, "");
  if (!digits) return "";
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.startsWith("+")) return digits;
  return digits.length >= 11 ? `+${digits}` : "";
}

function pickUserPhone(user: any): string {
  if (!user || typeof user !== "object") return "";
  const candidates = [
    user.phone,
    user.mobilePhone,
    user.mobile_phone,
    user.cellPhone,
    user.cellphone,
    user.cell,
    user.mobile,
    user.smsPhone,
    user.sms_phone
  ];
  for (const raw of candidates) {
    const normalized = normalizePhoneE164(String(raw ?? "").trim());
    if (normalized) return normalized;
  }
  return "";
}

function getCallbackReminderLeadMinutes(): number {
  const raw = Number(process.env.CALLBACK_REMINDER_LEAD_MINUTES ?? 30);
  if (!Number.isFinite(raw)) return 30;
  return Math.max(5, Math.min(24 * 60, Math.round(raw)));
}

function getZonedDateTimeParts(
  timezone: string,
  at: Date = new Date()
): { year: number; month: number; day: number; hour24: number; minute: number; weekday: string } | null {
  try {
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      weekday: "short",
      hour12: false
    });
    const parts = fmt.formatToParts(at);
    const map: Record<string, string> = {};
    for (const p of parts) {
      if (p.type !== "literal") map[p.type] = p.value;
    }
    const year = Number(map.year);
    const month = Number(map.month);
    const day = Number(map.day);
    const hour24 = Number(map.hour);
    const minute = Number(map.minute);
    const weekday = String(map.weekday ?? "").slice(0, 3).toLowerCase();
    if (
      !Number.isFinite(year) ||
      !Number.isFinite(month) ||
      !Number.isFinite(day) ||
      !Number.isFinite(hour24) ||
      !Number.isFinite(minute)
    ) {
      return null;
    }
    return { year, month, day, hour24, minute, weekday };
  } catch {
    return null;
  }
}

function toHour24(hourRaw: number, minuteRaw: number, meridiemRaw: string | undefined, sourceText: string): {
  hour24: number;
  minute: number;
} | null {
  if (!Number.isFinite(hourRaw) || !Number.isFinite(minuteRaw)) return null;
  if (hourRaw < 0 || hourRaw > 23 || minuteRaw < 0 || minuteRaw > 59) return null;
  const meridiem = String(meridiemRaw ?? "").toLowerCase();
  if (meridiem && meridiem !== "am" && meridiem !== "pm") return null;
  if (meridiem && (hourRaw < 1 || hourRaw > 12)) return null;
  if (meridiem) {
    const hour24 = meridiem === "am" ? (hourRaw === 12 ? 0 : hourRaw) : hourRaw === 12 ? 12 : hourRaw + 12;
    return { hour24, minute: minuteRaw };
  }
  if (hourRaw >= 0 && hourRaw <= 23) {
    if (hourRaw > 12) return { hour24: hourRaw, minute: minuteRaw };
    const source = sourceText.toLowerCase();
    if (/\b(morning)\b/.test(source)) return { hour24: hourRaw === 12 ? 0 : hourRaw, minute: minuteRaw };
    if (/\b(afternoon|evening|night|tonight)\b/.test(source))
      return { hour24: hourRaw === 12 ? 12 : hourRaw + 12, minute: minuteRaw };
    // Ambiguous bare-hour fallback.
    return { hour24: hourRaw <= 7 ? hourRaw + 12 : hourRaw, minute: minuteRaw };
  }
  return null;
}

function parseCallbackClockHint(source: string): { hour24: number; minute: number } | null {
  const text = String(source ?? "").trim();
  if (!text) return null;
  if (/\bnoon\b/i.test(text)) return { hour24: 12, minute: 0 };
  if (/\bmidnight\b/i.test(text)) return { hour24: 0, minute: 0 };
  const range =
    text.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:-|–|to)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i) ??
    text.match(
      /\b(?:around|about|between|from)\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:-|–|to)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i
    );
  if (range) {
    const hourRaw = Number(range[1]);
    const minuteRaw = Number(range[2] ?? 0);
    const firstMeridiem = String(range[3] ?? "").trim().toLowerCase();
    const secondMeridiem = String(range[6] ?? "").trim().toLowerCase();
    return toHour24(hourRaw, minuteRaw, firstMeridiem || secondMeridiem || undefined, text);
  }
  const single = text.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i);
  if (single) {
    return toHour24(Number(single[1]), Number(single[2] ?? 0), single[3], text);
  }
  const barePrefixed = text.match(/\b(?:at|around|about|by|after|before)\s+(\d{1,2})(?::(\d{2}))?\b/i);
  if (barePrefixed) {
    return toHour24(Number(barePrefixed[1]), Number(barePrefixed[2] ?? 0), undefined, text);
  }
  return null;
}

function callbackRelativeDayOffset(source: string, timezone: string): number {
  const text = String(source ?? "").toLowerCase();
  if (/\btomorrow\b/.test(text)) return 1;
  if (/\btoday\b/.test(text)) return 0;
  const weekdayMatch = text.match(/\b(mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:rsday)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)\b/);
  if (!weekdayMatch) return 0;
  const weekdayToken = weekdayMatch[1].slice(0, 3).toLowerCase();
  const order: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
  const target = order[weekdayToken];
  if (!Number.isFinite(target)) return 0;
  const nowParts = getZonedDateTimeParts(timezone);
  if (!nowParts) return 0;
  const today = order[nowParts.weekday];
  if (!Number.isFinite(today)) return 0;
  let delta = (target - today + 7) % 7;
  if (delta === 0) delta = 7;
  return delta;
}

function extractCallbackTimeHintFromText(text: string): string {
  const source = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!source) return "";
  const dayAndTime = source.match(
    /\b(?:today|tomorrow|monday|mon|tuesday|tue|wednesday|wed|thursday|thu|friday|fri|saturday|sat|sunday|sun)[^.!?\n]{0,64}\b(?:\d{1,2}(?::\d{2})?\s*(?:am|pm)\b|noon\b|midnight\b)/i
  );
  if (dayAndTime) return dayAndTime[0].trim();
  const range = source.match(
    /\b(?:around|about|between|from)?\s*\d{1,2}(?::\d{2})?\s*(?:am|pm)?\s*(?:-|–|to)\s*\d{1,2}(?::\d{2})?\s*(?:am|pm)\b/i
  );
  if (range) return range[0].trim();
  const single = source.match(/\b(?:around|about|at|by|after|before)?\s*(?:\d{1,2}(?::\d{2})?\s*(?:am|pm)\b|noon\b|midnight\b)/i);
  return single ? single[0].trim() : "";
}

function buildCallbackTodoSchedule(
  callbackTimeHint: string,
  timezone: string
): { dueAt?: string; reminderAt?: string; reminderLeadMinutes?: number } {
  const source = String(callbackTimeHint ?? "").trim();
  if (!source) return {};
  const hasDayToken = /\b(today|tomorrow|monday|mon|tuesday|tue|wednesday|wed|thursday|thu|friday|fri|saturday|sat|sunday|sun)\b/i.test(source);
  const hasTimeToken =
    /\b(\d{1,2}(:\d{2})?\s*(am|pm)\b|noon\b|midnight\b|\b(?:at|around|about|after|before|by)\s+\d{1,2}(?::\d{2})?\b)/i.test(
      source
    );
  let requested = parseRequestedDayTime(source, timezone);
  let defaultedToNineAm = false;
  if (!requested && hasDayToken && !hasTimeToken) {
    requested = parseRequestedDayTime(`${source} at 9am`, timezone);
    defaultedToNineAm = !!requested;
  }
  if (!requested && hasTimeToken) {
    const clock = parseCallbackClockHint(source);
    const nowParts = getZonedDateTimeParts(timezone);
    if (clock && nowParts) {
      const base = new Date(Date.UTC(nowParts.year, nowParts.month - 1, nowParts.day, 12, 0, 0, 0));
      const dayOffset = callbackRelativeDayOffset(source, timezone);
      if (dayOffset > 0) {
        base.setUTCDate(base.getUTCDate() + dayOffset);
      }
      requested = {
        year: base.getUTCFullYear(),
        month: base.getUTCMonth() + 1,
        day: base.getUTCDate(),
        hour24: clock.hour24,
        minute: clock.minute,
        dayOfWeek: ""
      };
      const candidate = localPartsToUtcDate(timezone, requested);
      if (candidate.getTime() <= Date.now() + 5 * 60_000) {
        base.setUTCDate(base.getUTCDate() + 1);
        requested = {
          year: base.getUTCFullYear(),
          month: base.getUTCMonth() + 1,
          day: base.getUTCDate(),
          hour24: clock.hour24,
          minute: clock.minute,
          dayOfWeek: ""
        };
      }
    }
  }
  if (!requested) return {};
  const dueAtDate = localPartsToUtcDate(timezone, requested);
  const dueAtMs = dueAtDate.getTime();
  if (!Number.isFinite(dueAtMs)) return {};
  const reminderLeadMinutes = getCallbackReminderLeadMinutes();
  const reminderAt = defaultedToNineAm ? new Date(dueAtMs) : new Date(dueAtMs - reminderLeadMinutes * 60 * 1000);
  return {
    dueAt: dueAtDate.toISOString(),
    reminderAt: reminderAt.toISOString(),
    reminderLeadMinutes: defaultedToNineAm ? 0 : reminderLeadMinutes
  };
}

function pickUserForRole(
  users: any[],
  role: string,
  preferredFirstToken?: string | null
): any | null {
  const token = pickFirstToken(preferredFirstToken ?? "");
  const byPreferred =
    users.find(u => {
      if (String(u?.role ?? "").trim().toLowerCase() !== role) return false;
      if (!token) return false;
      const first = pickFirstToken(u?.firstName);
      const nameFirst = pickFirstToken(u?.name);
      return token === first || token === nameFirst;
    }) ?? null;
  if (byPreferred) return byPreferred;
  return users.find(u => String(u?.role ?? "").trim().toLowerCase() === role) ?? null;
}

function isDepartmentUserRole(role: string | null | undefined): boolean {
  const normalized = String(role ?? "").trim().toLowerCase();
  return normalized === "service" || normalized === "parts" || normalized === "apparel";
}

function isLikelyDepartmentOwnerName(name: string | null | undefined): boolean {
  const normalized = String(name ?? "").trim().toLowerCase();
  if (!normalized) return false;
  return /\b(service|parts?|apparel|motorclothes)\b/.test(normalized);
}

function pickSalesOwner(
  users: any[],
  preferredFirstToken?: string | null
): any | null {
  const token = pickFirstToken(preferredFirstToken ?? "");
  const byPreferred =
    users.find(u => {
      if (String(u?.role ?? "").trim().toLowerCase() !== "salesperson") return false;
      if (!token) return false;
      const first = pickFirstToken(u?.firstName);
      const nameFirst = pickFirstToken(u?.name);
      return token === first || token === nameFirst;
    }) ?? null;
  if (byPreferred) return byPreferred;
  return users.find(u => String(u?.role ?? "").trim().toLowerCase() === "salesperson") ?? null;
}

function normalizeAdfIdentityToken(raw?: string | null): string {
  return String(raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function normalizeAdfRequestDate(raw?: string | null): string {
  const normalized = normalizeAdfIdentityToken(raw);
  if (!normalized) return "";
  const ms = Date.parse(normalized);
  if (!Number.isFinite(ms)) return normalized;
  return new Date(ms).toISOString();
}

function extractAdfRequestDate(adfXml: string): string {
  return adfXml.match(/<requestdate[^>]*>([^<]+)<\/requestdate>/i)?.[1]?.trim() ?? "";
}

function buildSyntheticAdfProviderMessageId(args: {
  requestDate?: string | null;
  leadRef?: string | null;
  leadSource?: string | null;
  phone?: string | null;
  email?: string | null;
  stockId?: string | null;
  vin?: string | null;
  inquiry?: string | null;
}): string {
  const parts = [
    normalizeAdfRequestDate(args.requestDate),
    normalizeAdfIdentityToken(args.leadRef),
    normalizeAdfIdentityToken(args.leadSource),
    normalizePhoneE164(args.phone),
    normalizeAdfIdentityToken(args.email),
    normalizeAdfIdentityToken(args.stockId),
    normalizeAdfIdentityToken(args.vin),
    normalizeAdfIdentityToken(args.inquiry).slice(0, 256)
  ];
  const seed = parts.join("|");
  const digest = crypto.createHash("sha1").update(seed).digest("hex").slice(0, 24);
  return `adf_${digest}`;
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

function buildStaffOutcomeLink(token: string): string | null {
  const base = String(process.env.PUBLIC_BASE_URL ?? "").trim().replace(/\/+$/, "");
  if (!base) return null;
  return `${base}/public/appointment/outcome?token=${encodeURIComponent(token)}`;
}

function ensureDealerRideOutcomeToken(conv: any): string {
  conv.dealerRide = conv.dealerRide ?? {};
  conv.dealerRide.staffNotify = conv.dealerRide.staffNotify ?? {};
  if (conv.dealerRide.staffNotify.outcomeToken) return conv.dealerRide.staffNotify.outcomeToken;
  const token = crypto.randomBytes(12).toString("hex");
  conv.dealerRide.staffNotify.outcomeToken = token;
  return token;
}

function isDealerLeadAppAdfBody(body: string | null | undefined): boolean {
  return /event name:\s*dealer test ride|demo bikes ridden|dealer lead app/i.test(String(body ?? ""));
}

function getDlaAutoReplyRepeatMinDays(): number {
  const raw = Number(process.env.DLA_AUTO_REPLY_REPEAT_MIN_DAYS ?? 183);
  if (!Number.isFinite(raw) || raw <= 0) return 183;
  return Math.max(30, Math.round(raw));
}

function shouldSendDealerLeadCustomerReply(
  conv: any,
  event: InboundMessageEvent
): { allow: boolean; reason: string; lastAt?: string; gapDays?: number } {
  const messages = Array.isArray(conv?.messages) ? conv.messages : [];
  if (!messages.length) return { allow: true, reason: "first_dla_in_thread" };
  const priorInboundDla = messages
    .slice(0, -1)
    .filter(
      (m: any) =>
        m &&
        m.direction === "in" &&
        String(m.provider ?? "").toLowerCase() === "sendgrid_adf" &&
        isDealerLeadAppAdfBody(String(m.body ?? ""))
    );
  if (!priorInboundDla.length) return { allow: true, reason: "first_dla_in_thread" };
  const last = priorInboundDla[priorInboundDla.length - 1];
  const lastMs = new Date(String(last?.at ?? "")).getTime();
  const currentMs = new Date(String(event.receivedAt ?? "")).getTime();
  const minGapDays = getDlaAutoReplyRepeatMinDays();
  const minGapMs = minGapDays * 24 * 60 * 60 * 1000;
  if (!Number.isFinite(lastMs) || !Number.isFinite(currentMs)) {
    return { allow: false, reason: "dla_recent_repeat_unknown_time", lastAt: String(last?.at ?? "") || undefined };
  }
  const gapDays = (currentMs - lastMs) / (24 * 60 * 60 * 1000);
  if (currentMs - lastMs >= minGapMs) {
    return { allow: true, reason: "dla_repeat_after_gap", lastAt: String(last?.at ?? "") || undefined, gapDays };
  }
  return { allow: false, reason: "dla_recent_repeat", lastAt: String(last?.at ?? "") || undefined, gapDays };
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
let modelTokenKeyIndexCache: Map<string, Set<string>> | null = null;

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
    if (
      isUnambiguousSingleTokenAliasForModelKey(token, leadKey) ||
      isUnambiguousSingleTokenAliasForModelKey(token, inquiryKey)
    ) {
      return true;
    }
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

function getModelTokenKeyIndex(): Map<string, Set<string>> {
  if (modelTokenKeyIndexCache) return modelTokenKeyIndexCache;
  const out = new Map<string, Set<string>>();
  for (const key of getKnownModelByKey().keys()) {
    for (const tok of key.split(" ").map(t => t.trim()).filter(Boolean)) {
      const bucket = out.get(tok);
      if (bucket) {
        bucket.add(key);
      } else {
        out.set(tok, new Set([key]));
      }
    }
  }
  modelTokenKeyIndexCache = out;
  return out;
}

function isUnambiguousSingleTokenAliasForModelKey(token: string, key: string): boolean {
  const cleanToken = String(token ?? "").trim().toLowerCase();
  const cleanKey = String(key ?? "").trim().toLowerCase();
  if (!cleanToken || !cleanKey) return false;
  const tokenIndex = getModelTokenKeyIndex();
  const keys = tokenIndex.get(cleanToken);
  if (!keys || keys.size !== 1) return false;
  return keys.has(cleanKey);
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

function extractInquiryModelHint(inquiry?: string | null): string | undefined {
  const mentions = extractInquiryModelMentions(inquiry);
  if (!mentions.length) return undefined;
  return mentions[0]?.label ? normalizeDisplayCase(mentions[0].label) : undefined;
}

function extractInquiryYearHint(inquiry?: string | null): string | undefined {
  const raw = String(inquiry ?? "").trim();
  if (!raw) return undefined;
  const full = raw.match(/\b(20\d{2})\b/);
  if (full?.[1]) return full[1];
  const short = raw.match(
    /\b'?(\d{2})\s+(?:(?:new|used|orange|black|white|blue|red|gray|grey|silver|vivid|dark|bright|inferno|citrus|billiard|matte|metallic)\s+){0,4}(?:harley|cvo|street|road|glide|softail|sportster|nightster|pan|fat|breakout|heritage|ultra|trike|tri|freewheeler)\b/i
  );
  if (!short?.[1]) return undefined;
  const yy = Number(short[1]);
  if (!Number.isFinite(yy)) return undefined;
  const nowYear = new Date().getFullYear();
  const nowYY = nowYear % 100;
  const fullYear = yy <= nowYY + 1 ? 2000 + yy : 1900 + yy;
  if (fullYear < 1980 || fullYear > nowYear + 1) return undefined;
  return String(fullYear);
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
  const jumpStartLead =
    isJumpStartExperienceText(conv?.lead?.inquiry ?? null) ||
    isJumpStartExperienceText(conv?.lead?.source ?? null) ||
    isJumpStartExperienceText(conv?.lead?.vehicle?.description ?? null);
  if (jumpStartLead) return "inventory_visit";
  const bucket = conv?.classification?.bucket ?? "";
  const cta = conv?.classification?.cta ?? "";
  if (bucket === "test_ride" || cta === "schedule_test_ride") return "test_ride";
  if (bucket === "trade_in_sell" || cta === "value_my_trade" || cta === "trade_in_value") return "trade_appraisal";
  if (bucket === "finance_prequal" || /prequal|credit|finance|hdfs/i.test(cta)) return "finance_discussion";
  return "inventory_visit";
}

function isJumpStartExperienceText(text: string | null | undefined): boolean {
  const t = String(text ?? "").toLowerCase();
  if (!t.trim()) return false;
  if (/\bjump\s*start\b|\bjumpstart\b|\bjump-start\b/.test(t)) return true;
  return (
    /\b(riding academy|rider academy|learn to ride)\b/.test(t) &&
    /\b(prior|before|prep|practice|experience)\b/.test(t)
  );
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

function normalizeHttpUrl(raw?: string | null): string | null {
  const text = String(raw ?? "").trim();
  if (!text) return null;
  try {
    const parsed = new URL(text);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

function inventoryListUrlsFromEnv(): string[] {
  const raw = String(process.env.INVENTORY_LIST_URLS ?? "").trim();
  if (!raw) return [];
  return raw
    .split(",")
    .map(v => normalizeHttpUrl(v))
    .filter((v): v is string => !!v);
}

function resolveInventoryBrowseUrl(dealerProfile: any): string | null {
  const fromEnv = inventoryListUrlsFromEnv();
  if (fromEnv.length) return fromEnv[0];
  return (
    normalizeHttpUrl(dealerProfile?.website) ??
    normalizeHttpUrl(dealerProfile?.usedInventoryUrl) ??
    normalizeHttpUrl(dealerProfile?.preownedInventoryUrl) ??
    null
  );
}

function formatModelLabel(year?: string | null, model?: string | null): string | null {
  if (!model) return null;
  const clean = normalizeDisplayCase(model);
  if (!clean || /full line|other/i.test(clean)) return null;
  return year ? `${year} ${clean}` : clean;
}

async function getLeadInventoryMatchStatus(
  conv: any
): Promise<"in_stock" | "on_hold" | "sold" | "not_found" | "unknown"> {
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
    const [holds, solds] = await Promise.all([listInventoryHolds(), listInventorySolds()]);
    const getStoredStatus = (stockId?: string | null, vin?: string | null): "on_hold" | "sold" | null => {
      const soldKey = normalizeInventorySoldKey(stockId, vin);
      if (soldKey && solds?.[soldKey]) return "sold";
      const holdKey = normalizeInventoryHoldKey(stockId, vin);
      if (holdKey && holds?.[holdKey]) return "on_hold";
      return null;
    };

    const leadStock = String(conv?.lead?.vehicle?.stockId ?? "").trim().toLowerCase();
    const leadVin = String(conv?.lead?.vehicle?.vin ?? "").trim().toLowerCase();
    if (leadStock || leadVin) {
      const storedStatus = getStoredStatus(leadStock, leadVin);
      if (storedStatus) return storedStatus;
      const direct = items.find(
        i =>
          (leadStock && (i.stockId ?? "").toLowerCase() === leadStock) ||
          (leadVin && (i.vin ?? "").toLowerCase() === leadVin)
      );
      if (direct) {
        const directStored = getStoredStatus(direct.stockId, direct.vin);
        if (directStored) return directStored;
        return "in_stock";
      }
      if (leadStock) {
        try {
          const resolved = await resolveInventoryUrlByStock(leadStock);
          if (resolved.ok) {
            const resolvedStored = getStoredStatus(leadStock, leadVin);
            if (resolvedStored) return resolvedStored;
            return "in_stock";
          }
        } catch {}
      }
      if (conv?.hold) return "on_hold";
      if (conv?.sale) return "sold";
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
    if (!matches.length) return "not_found";
    let hasHold = false;
    let hasSold = false;
    const hasAvailable = matches.some(item => {
      const state = getStoredStatus(item.stockId, item.vin);
      if (state === "sold") {
        hasSold = true;
        return false;
      }
      if (state === "on_hold") {
        hasHold = true;
        return false;
      }
      return true;
    });
    if (hasAvailable) return "in_stock";
    if (hasHold) return "on_hold";
    if (hasSold) return "sold";
    return "not_found";
  } catch {
    return "unknown";
  }
}

function buildInitialAvailabilityLine(
  status: "in_stock" | "on_hold" | "sold" | "not_found" | "unknown",
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
  if (status === "on_hold") {
    return `I saw you wanted to learn more about the ${modelLabel}. That unit is currently on hold. If it frees up, I can text you first.`;
  }
  if (status === "sold") {
    return `I saw you wanted to learn more about the ${modelLabel}. That unit is no longer available, but I can help you find similar options.`;
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
  buildInventoryAvailable?: boolean | null,
  options?: {
    testRideInventoryStatus?: "in_stock" | "on_hold" | "sold" | "not_found" | "unknown";
  }
): string {
  const rawName =
    normalizeDisplayCase(conv?.lead?.firstName) ||
    normalizeDisplayCase(conv?.lead?.name) ||
    "there";
  const name = rawName.split(" ")[0] || "there";
  const dealerName = dealerProfile?.dealerName ?? "American Harley-Davidson";
  const agentName = dealerProfile?.agentName ?? "our team";
  const bookingUrl = buildBookingUrlForLead(dealerProfile?.bookingUrl, conv);
  const inventoryBrowseUrl = resolveInventoryBrowseUrl(dealerProfile);
  const model = formatModelLabel(conv?.lead?.vehicle?.year ?? conv?.lead?.year, conv?.lead?.vehicle?.model ?? conv?.lead?.vehicle?.description);
  const leadSourceLower = (conv?.lead?.source ?? conv?.leadSource ?? "").toLowerCase();
  const offersResolution = resolveOffersUrl({
    dealerProfile,
    conversation: conv
  });
  const includeOffersLine =
    /meta promo offer/i.test(leadSourceLower) ||
    (/room58/i.test(leadSourceLower) && !!offersResolution.promoNoteUrl);
  const offersLine = includeOffersLine
    ? buildOffersLine(offersResolution.preferredUrl, { prefix: "Current offers are listed here:" })
    : "";
  const isCustomBuild = /custom build/.test(leadSourceLower);
  const isTestRide =
    conv?.classification?.bucket === "test_ride" || conv?.classification?.cta === "schedule_test_ride";
  const testRideInventoryStatus =
    isTestRide && options?.testRideInventoryStatus
      ? options.testRideInventoryStatus
      : "unknown";
  const testRideInStock = !isTestRide || testRideInventoryStatus === "in_stock";
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
    : isTestRide
      ? testRideInStock
        ? model
          ? "If you want to stop in for a test ride and go over options, you can book an appointment below."
          : "If you want to stop in for a test ride, you can book an appointment below."
        : model
          ? "I don’t want to schedule a test ride on a bike we don’t currently have in stock."
          : "I can line up a test ride once you pick an in-stock bike."
    : model
      ? "If you want to stop in to check out the bike and go over options, you can book an appointment below."
      : "If you want to stop in to go over options, you can book an appointment below.";
  const bookingLine =
    isTestRide && !testRideInStock
      ? inventoryBrowseUrl
        ? `Please pick an in-stock bike from here and reply with the one you want to ride: ${inventoryBrowseUrl}`
        : "Reply with the exact in-stock bike you want to ride and I’ll line up the test ride."
      : bookingUrl
        ? `You can book an appointment here: ${bookingUrl}`
        : "Just reply with a day and time that works for you.";
  const extra = "If a walkaround or extra photos would help, just let me know.";

  const draft = `Hi ${name},\n\n${thanks} ${intro} ${help} ${noteLine} ${buildLine} ${visit}\n\n${
    offersLine ? `${offersLine}\n\n` : ""
  }${bookingLine}\n\n${extra}`
    .replace(/\s+\n/g, "\n")
    .trim();
  return formatEmailLayout(draft, { firstName: name, fallbackName: "there" });
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

function toEmailStyledBody(body: string, conv: any): string {
  const firstName = normalizeDisplayCase(conv?.lead?.firstName) || normalizeDisplayCase(conv?.lead?.name);
  return formatEmailLayout(body, { firstName, fallbackName: "there" });
}

function setEmailDraft(conv: any, text: string): void {
  conv.emailDraft = toEmailStyledBody(text, conv);
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
  const inquiryModelHint = extractInquiryModelHint(t);
  if (inquiryModelHint) return inquiryModelHint;
  if (/\biron\s*883\b/.test(t)) return "Iron 883";
  if (/\b(883\s*roadster|roadster\s*883)\b/.test(t)) return "883 Roadster";
  if (/\b(sportster\s*883|xl\s*883|xl883c)\b/.test(t)) return "Sportster 883";
  if (/\b(sportster|xl883c|xl\s*883|883)\b/.test(t)) return "Sportster";
  if (/\b(road glide\s*(3|iii)|fltrt)\b/.test(t)) return "Road Glide 3";
  if (/\b(street glide\s*(3|iii)|flhlt)\b/.test(t)) return "Street Glide 3 Limited";
  return undefined;
}

function extractWatchDirectiveSegment(text?: string | null): string {
  const source = String(text ?? "");
  if (!source) return "";
  const m = source.match(
    /\b(?:watch(?:ing)? for|keep an eye out for|please watch for|open to watch for|watch)\b([\s\S]*?)(?=(?:\b(?:step\s*\d+|email opt-?in|view lead)\b|[.;]|$))/i
  );
  return String(m?.[1] ?? "").replace(/\s+/g, " ").trim();
}

function hasWatchIntentPhrase(text?: string | null): boolean {
  const source = String(text ?? "").toLowerCase();
  if (!source.trim()) return false;
  return (
    /\b(keep an eye out(?: for)?|watch(?:ing)? for|please watch|open to watch for|notify me|let me know when|text me when|if you get one|when you get one|as soon as one comes in)\b/i.test(
      source
    ) || /\bif one comes in\b/i.test(source)
  );
}

function extractTrafficLogProStep(text?: string | null): number | null {
  const source = String(text ?? "");
  if (!source.trim()) return null;
  const explicit = source.match(/\b(?:step|stp)\s*[:#-]?\s*(\d{1,2})\b/i);
  const named =
    explicit ??
    source.match(
      /\b([1-9])\s*-\s*(?:greet|probe|sit\s*on|presentation|sit\s*down|write[\s-]*up|close|f\s*&\s*i|delivered)\b/i
    );
  if (!named?.[1]) return null;
  const step = Number(named[1]);
  if (!Number.isFinite(step)) return null;
  const normalized = Math.trunc(step);
  if (normalized < 1 || normalized > 9) return null;
  return normalized;
}

function extractTrafficLogProFollowUpTopic(text?: string | null): string | undefined {
  const source = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!source) return undefined;
  const cleaned = source
    .replace(/\(\s*step\s*\d{1,2}\s*\)/gi, " ")
    .replace(/\bstep\s*[:#-]?\s*\d{1,2}\b/gi, " ")
    .replace(/\bview lead\b/gi, " ")
    .replace(/\bemail opt-?in\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return undefined;

  const patterns = [
    /\b(?:i(?:'ll| will)|we(?:'ll| will)|please|can you|could you|reach out|follow up|check in|be in touch)\b[\s\S]{0,24}\b(?:about|on|with|regarding|for)\s+([^.;]+)/i,
    /\b(?:about|on|with|regarding)\s+([^.;]+)/i
  ];
  for (const pattern of patterns) {
    const match = cleaned.match(pattern);
    const rawTopic = String(match?.[1] ?? "").replace(/\s+/g, " ").trim();
    if (!rawTopic) continue;
    const topic = rawTopic
      .replace(/^(?:him|her|them|customer|the customer)\b[\s,:-]*/i, "")
      .replace(/\b(?:please|thanks?|thank you)\b/gi, "")
      .replace(/\s+/g, " ")
      .trim();
    if (!topic) continue;
    const truncated =
      topic.length > 100 ? `${topic.slice(0, 97).trim().replace(/[,\-:]$/, "")}...` : topic;
    if (truncated) return truncated;
  }
  return undefined;
}

function buildTrafficLogProWalkInTail(args: {
  step: number;
  comment: string;
  modelLabel?: string | null;
  hasPricingFollowupIntent?: boolean;
}): string | null {
  const step = Math.trunc(Number(args.step));
  if (!Number.isFinite(step) || step < 1 || step > 9) return null;
  const source = String(args.comment ?? "").toLowerCase();
  const label = formatWatchModelForMessage(String(args.modelLabel ?? "").trim() || "bike");
  const followUpTopic = extractTrafficLogProFollowUpTopic(args.comment);
  const hasFinanceCue =
    /\b(finance|f\s*&\s*i|f and i|credit\s*app|approval|approved|paperwork|contract|lender|bank|credit union|docs?)\b/.test(
      source
    );
  const hasPricingCue =
    /\b(price|pricing|numbers?|payment|payments|write[\s-]*up|worksheet|out the door|otd|trade|appraisal)\b/.test(
      source
    ) || !!args.hasPricingFollowupIntent;
  const hasFollowupCue =
    /\b(in touch|follow up|follow-up|reach out|check in|circle back|touch base|keep you posted)\b/.test(source);

  const withTopic = (base: string): string => {
    if (!followUpTopic) return base;
    return `${base} I'll follow up about ${followUpTopic}.`;
  };

  if (step >= 9) {
    return withTopic("Thanks again for working with us - enjoy the new bike. I'm here if you need anything.");
  }
  if (step === 8) {
    if (followUpTopic) {
      return `Thanks again for coming in today - it was great working with you. I'll be in touch about ${followUpTopic}.`;
    }
    if (hasFinanceCue) {
      return "Thanks again for coming in today - it was great working with you. I'll keep you posted as we wrap up finance and final details.";
    }
    return "Thanks again for coming in today - it was great working with you. I'll keep you posted on final details and next steps.";
  }
  if (step === 7) {
    if (followUpTopic) {
      return `Thanks again for coming in - I'll follow up about ${followUpTopic}.`;
    }
    if (hasPricingCue || hasFinanceCue || hasFollowupCue) {
      return "Thanks again for coming in - I'll follow up with final numbers and next steps.";
    }
    return "Thanks again for coming in - I'll stay in touch as we finish up the next steps.";
  }
  if (step === 6 || step === 5) {
    if (followUpTopic) {
      return `Thanks again for your time today. I'll follow up about ${followUpTopic}.`;
    }
    if (hasPricingCue) {
      return "Thanks again for sitting down with me today. I'll follow up with the numbers we discussed and next steps.";
    }
    return "Thanks again for your time today. I'll follow up shortly with next steps.";
  }
  if (step <= 4) {
    if (followUpTopic) {
      return `Thanks for stopping in today - I'll follow up about ${followUpTopic}.`;
    }
    if (hasFollowupCue) {
      return "Thanks for stopping in today - I'll check back in soon like we discussed.";
    }
    return `Thanks for stopping in today. If you want, I can send a quick recap on ${label}.`;
  }
  return null;
}

function walkInTailHasOwnAcknowledgement(text?: string | null): boolean {
  const source = String(text ?? "").trim();
  if (!source) return false;
  return /^(thanks?|thank you|appreciate|great to|great working|good to|nice to|awesome|perfect)\b/i.test(source);
}

function extractWatchDirectiveModelHint(text?: string | null): string | undefined {
  const segment = extractWatchDirectiveSegment(text);
  if (!segment) return undefined;
  const segmentLower = segment.toLowerCase();
  const inquiryModelHint = extractInquiryModelHint(segmentLower);
  if (inquiryModelHint) return inquiryModelHint;
  const walkInModelHint = extractWalkInModelHint(segmentLower);
  if (walkInModelHint) return walkInModelHint;
  if (/\b(?:touring|bagger)\b/.test(segmentLower)) return "Touring";
  if (/\b(?:trike|trikes)\b/.test(segmentLower)) return "Trike";
  if (/\b(?:tri[\s-]?glide)\b/.test(segmentLower)) return "Tri Glide Ultra";
  if (/\b(?:road\s+glide)\b/.test(segmentLower)) return "Road Glide";
  if (/\b(?:street\s+glide)\b/.test(segmentLower)) return "Street Glide";
  if (/\b(?:road\s+king)\b/.test(segmentLower)) return "Road King";
  if (/\b(?:softail)\b/.test(segmentLower)) return "Softail";
  if (/\b(?:sportster)\b/.test(segmentLower)) return "Sportster";
  return undefined;
}

function extractWalkInReminderRequest(text?: string | null): { timeHint: string; actionNote: string } | null {
  const raw = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!raw) return null;
  const explicit = raw.match(/\bremind me\b\s+(.+?)\s+\bto\b\s+(.+?)(?:[.;]|$)/i);
  if (explicit) {
    const timeHint = String(explicit[1] ?? "").trim();
    const actionNote = String(explicit[2] ?? "")
      .replace(/\b(?:also|and)\b[\s\S]*$/i, "")
      .trim();
    if (timeHint && actionNote) return { timeHint, actionNote };
  }
  const fallback = raw.match(/\bremind me\b\s+(.+?)(?:[.;]|$)/i);
  if (!fallback) return null;
  const timeHint = String(fallback[1] ?? "").trim();
  if (!timeHint) return null;
  return { timeHint, actionNote: "follow up with customer" };
}

function formatWatchModelForMessage(model?: string | null): string {
  const raw = String(model ?? "").replace(/\s+/g, " ").trim();
  if (!raw) return "bike";
  if (/\b(bike|motorcycle)\b/i.test(raw)) return raw;
  if (
    /^(touring|bagger|cruiser|sportster|sport|adventure(?:\s+touring)?|trike|trikes|softail|dyna|cvo)$/i.test(
      raw
    )
  ) {
    return `${raw} bike`;
  }
  return raw;
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

function inferWalkInRequestedCondition(text?: string | null): "new" | "used" | "any" | undefined {
  const t = String(text ?? "").toLowerCase();
  if (!t) return undefined;
  if (/\b(new\s+or\s+used|used\s+or\s+new)\b/.test(t)) return "any";
  if (/\bany\b/.test(t)) return "any";
  const hasUsed = /\b(pre[-\s]?owned|used)\b/.test(t);
  const hasNew = /\bnew\b/.test(t);
  if (hasUsed && hasNew) return "any";
  if (hasUsed) return "used";
  if (hasNew) return "new";
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

function normalizeAdfInquiryText(input?: string | null): string {
  if (!input) return "";
  const withBreaks = String(input).replace(/<\s*br\s*\/?>/gi, " ");
  const withoutKenectTrackingLinks = withBreaks.replace(/https?:\/\/url\d+\.kenect\.com\/\S+/gi, " ");
  const withoutHtml = withoutKenectTrackingLinks.replace(/<[^>]+>/g, " ");
  const normalizedDelimiters = withoutHtml.replace(/\s*>\s*/g, " ");
  return normalizedDelimiters.replace(/\s+/g, " ").trim();
}

const ADF_METADATA_MARKERS: RegExp[] = [
  /\binventory item\s*:/i,
  /\binventory year\s*:/i,
  /\binventory stock id\s*:/i,
  /\bclient_id\s*:/i,
  /\bcan we contact you via (?:email|phone|text)\s*\?:/i,
  /\bhdmc-campaign-tracking code\s*:/i,
  /\blead captured date\s*:/i,
  /\bevent name\s*:/i,
  /\bfirst name\s*:/i,
  /\blast name\s*:/i,
  /\bpre-inspection trade-in value estimate\b/i,
  /\brough trade in wholesale\s*:/i,
  /\bclean trade in wholesale\s*:/i,
  /\baverage retail\s*:/i,
  /\bsuggested list price\s*:/i,
  /\bprices shown to customer\b/i
];

function countAdfMetadataMarkers(text?: string | null): number {
  const raw = String(text ?? "");
  if (!raw) return 0;
  return ADF_METADATA_MARKERS.reduce((count, pattern) => (pattern.test(raw) ? count + 1 : count), 0);
}

function looksLikeAdfMetadataBlob(text?: string | null): boolean {
  const raw = String(text ?? "").trim();
  if (!raw) return false;
  const markerCount = countAdfMetadataMarkers(raw);
  if (markerCount >= 2) return true;
  if (markerCount >= 1 && raw.split(/\s+/).length > 35) return true;
  return false;
}

function extractTrueInquiryFromAdfText(input?: string | null): string {
  const normalized = normalizeAdfInquiryText(input);
  if (!normalized) return "";
  const direct =
    normalized.match(/\byour inquiry:\s*([\s\S]+)$/i)?.[1]?.trim() ??
    normalized.match(/\byour inquiry:\s*([^>\n\r]+)/i)?.[1]?.trim() ??
    normalized.match(/\binquiry:\s*([\s\S]+)$/i)?.[1]?.trim() ??
    normalized.match(/\binquiry:\s*([^>\n\r]+)/i)?.[1]?.trim() ??
    normalized;
  let value = String(direct ?? "").trim();
  if (!value) return "";
  value = value.replace(
    /\s*(?:can we contact you via (?:email|phone|text)\?:|client_id\s*:|hdmc-campaign-tracking code\s*:|lead captured date\s*:|event name\s*:|\/\/\/customer information\/\/\/|parts and accessories interest\s*:|biker rider\?\s*:|language\s*:|purchase timeframe\s*:|source id\s*:|inventory year\s*:|inventory stock id\s*:|vin\s*:|first name\s*:|last name\s*:|phone\s*:|email\s*:|pre-inspection trade-in value estimate|rough trade in wholesale\s*:|clean trade in wholesale\s*:|average retail\s*:|suggested list price\s*:|prices shown to customer)[\s\S]*/i,
    ""
  );
  value = value.replace(/^[>\-\s:]+/, "").trim();
  if (!value) return "";
  if (/^(hello|hi|hey|good\s+(morning|afternoon|evening))[,\s!.-]*$/i.test(value)) return "";
  if (/^(yes|no|n\/a|na|null)$/i.test(value)) return "";
  if (/^can we contact you via/i.test(value)) return "";
  if (looksLikeAdfMetadataBlob(value)) return "";
  return value;
}

function isLikelyGreetingOnlyInquiry(input?: string | null): boolean {
  const value = String(input ?? "").trim();
  if (!value) return false;
  return /^(hello|hi|hey|good\s+(morning|afternoon|evening))[,\s!.-]*$/i.test(value);
}

function sanitizeTradeAcceleratorInquiry(input?: string | null): string {
  const normalized = normalizeAdfInquiryText(input);
  if (!normalized) return "";
  let value = normalized;
  // Drop valuation-only payload rows emitted by Trade Accelerator.
  value = value.replace(
    /\b(pre-inspection trade-in value estimate|prices shown to customer|rough trade in wholesale\s*:|clean trade in wholesale\s*:|average retail\s*:|suggested list price\s*:).*/i,
    ""
  );
  value = value.replace(
    /\b(rough trade in wholesale|clean trade in wholesale|average retail|suggested list price)\s*:\s*\$?\s*[\d,]+(?:\.\d{2})?/gi,
    " "
  );
  value = value.replace(/\$[\d,]+(?:\.\d{2})?/g, " ");
  value = value.replace(/\s+/g, " ").trim();
  if (!value) return "";
  if (looksLikeAdfMetadataBlob(value)) return "";
  return value;
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

function extractLeadMeta(adfXml: string): {
  leadSource?: string;
  model?: string;
  vendorContactName?: string;
  sourceFromId?: string;
} {
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

    return { leadSource, model, vendorContactName, sourceFromId };
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

async function normalizeLegacyNewLeadCondition(args: {
  condition?: "new" | "used";
  year?: string | number | null;
  model?: string | null;
  make?: string | null;
}): Promise<"new" | "used" | undefined> {
  const incoming = args.condition;
  if (incoming !== "new") return incoming;

  const currentYear = new Date().getFullYear();
  const maxNewAgeYears = Math.max(1, Number(process.env.NEW_CONDITION_MAX_AGE_YEARS ?? 2));
  const yearNum = Number(String(args.year ?? "").trim());
  const hasNumericYear = Number.isFinite(yearNum) && yearNum > 0;
  const legacyYear = hasNumericYear && yearNum <= currentYear - maxNewAgeYears;
  const modelRaw =
    normalizeVehicleModel(args.model, args.make) ??
    String(args.model ?? "").trim() ??
    "";
  if (!modelRaw) {
    return legacyYear ? "used" : incoming;
  }

  try {
    const modelMatches = await findInventoryMatches({ year: null, model: modelRaw });
    const yearMatches = hasNumericYear
      ? await findInventoryMatches({ year: String(yearNum), model: modelRaw })
      : [];
    const hasModelInventoryEvidence = modelMatches.length > 0;
    const modelHasExplicitNew = modelMatches.some(item => normalizeVehicleCondition(item?.condition) === "new");
    const yearHasExplicitNew = yearMatches.some(item => normalizeVehicleCondition(item?.condition) === "new");
    const lineupRecentForMake = isModelInRecentYearsForMake(modelRaw, args.make ?? null, currentYear, 1);
    const newestModelYear = modelMatches.reduce((max, item) => {
      const n = Number(String(item?.year ?? "").trim());
      if (!Number.isFinite(n)) return max;
      return Math.max(max, n);
    }, 0);

    if (
      !hasModelInventoryEvidence &&
      lineupRecentForMake === true &&
      (!hasNumericYear || yearNum >= currentYear - 1)
    ) {
      return incoming;
    }
    if (legacyYear && !yearHasExplicitNew) return "used";
    if (yearMatches.length > 0 && !yearHasExplicitNew) return "used";
    // Do not downgrade to "used" just because we have no current stock for the model.
    // Only apply model-year inventory evidence when the model has actual feed matches.
    if (
      hasModelInventoryEvidence &&
      !modelHasExplicitNew &&
      Number.isFinite(newestModelYear) &&
      newestModelYear <= currentYear - 1
    ) {
      return "used";
    }
  } catch (err: any) {
    console.warn("[sendgrid inbound] legacy new-condition normalization failed:", err?.message ?? err);
  }

  if (legacyYear) return "used";
  return incoming;
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
  const compact = normalized.replace(/[^a-z0-9]/g, "");
  if (/^(full line|full lineup|other|unknown|null)$/.test(normalized)) {
    return undefined;
  }
  if (compact === "na" || compact === "nill" || compact === "none") {
    return undefined;
  }
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
  const bareRange = t.match(/\b(\d+)\s*[-to]+\s*(\d+)\b/);
  if (bareRange) {
    const a = Number(bareRange[1]);
    const b = Number(bareRange[2]);
    if (!Number.isNaN(a) && !Number.isNaN(b)) {
      return { start: Math.min(a, b), end: Math.max(a, b) };
    }
  }
  const single = t.match(/(\d+)\s*month/);
  if (single) {
    const a = Number(single[1]);
    if (!Number.isNaN(a)) return { start: a };
  }
  const bareSingle = t.match(/\b(\d+)\b/);
  if (bareSingle) {
    const a = Number(bareSingle[1]);
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
      const schedulingParserEligible =
        process.env.LLM_ENABLED === "1" &&
        process.env.LLM_BOOKING_PARSER_ENABLED === "1" &&
        !!process.env.OPENAI_API_KEY;
      const bodyText = String(event.body ?? "");
      const bodyTextLower = bodyText.toLowerCase();
      const hasScheduleKeyword =
        /\b(schedule|book|appointment|appt|reschedule|availability|available|openings?|stop by|stop in|come in|works?|what time|what times)\b/i.test(
          bodyText
        );
      const hasDayToken =
        /\b(today|tomorrow|monday|mon|tuesday|tue|wednesday|wed|thursday|thu|friday|fri|saturday|sat|sunday|sun|next week|this week|this weekend|weekend)\b/i.test(
          bodyText
        );
      const hasTimeToken =
        /\b(\d{1,2}(:\d{2})?\s*(am|pm)\b|morning|afternoon|evening|night|noon|midnight)\b/i.test(
          bodyText
        );
      const schedulingParserHint =
        hasScheduleKeyword ||
        (((conv.scheduler?.lastSuggestedSlots?.length ?? 0) > 0 ||
          String(conv.appointment?.status ?? "").toLowerCase() !== "none") &&
          (hasDayToken || hasTimeToken));
      if (schedulingParserEligible && schedulingParserHint) {
        try {
          const bookingParse = await parseBookingIntentWithLLM({
            text: bodyText,
            history: buildEffectiveHistory(conv, 8),
            lastSuggestedSlots: conv.scheduler?.lastSuggestedSlots,
            appointment: conv.appointment
          });
          const bookingConfidence =
            typeof bookingParse?.confidence === "number" ? bookingParse.confidence : 0;
          const bookingConfidenceMin = Number(process.env.LLM_BOOKING_CONFIDENCE_MIN ?? 0.7);
          const bookingIntentAccepted =
            !!bookingParse?.explicitRequest &&
            bookingConfidence >= bookingConfidenceMin &&
            (bookingParse.intent === "schedule" ||
              bookingParse.intent === "reschedule" ||
              bookingParse.intent === "availability");
          if (bookingIntentAccepted) {
            const cfg = await getSchedulerConfig();
            const timezone = cfg.timezone || "America/New_York";
            const normalizedText = String(
              bookingParse?.normalizedText ??
                [
                  String(bookingParse?.requested?.day ?? "").trim(),
                  String(bookingParse?.requested?.timeText ?? "").trim()
                ]
                  .filter(Boolean)
                  .join(" ")
            ).trim();
            const parseSource = normalizedText || bodyText;
            let requested = parseRequestedDayTime(parseSource, timezone);
            const hasDayWithoutTime = hasDayToken && !hasTimeToken;
            if (!requested && hasDayWithoutTime) {
              requested = parseRequestedDayTime(`${parseSource} at 9am`, timezone);
            }
            const dueAtDate = requested ? localPartsToUtcDate(timezone, requested) : null;
            const dueAtIso = dueAtDate ? dueAtDate.toISOString() : undefined;
            const reminderAtIso = dueAtDate
              ? new Date(dueAtDate.getTime() - 30 * 60 * 1000).toISOString()
              : undefined;
            const requestedLabel = dueAtIso ? formatSlotLocal(dueAtIso, timezone) : null;
            const intentLabel =
              bookingParse.intent === "reschedule"
                ? "Appointment reschedule requested."
                : bookingParse.intent === "availability"
                  ? "Customer asked for appointment availability."
                  : "Appointment requested.";
            const summary = requestedLabel
              ? `${intentLabel} Requested time: ${requestedLabel}.`
              : normalizedText
                ? `${intentLabel} Requested: ${normalizedText}.`
                : intentLabel;
            addTodo(
              conv,
              "call",
              summary,
              event.providerMessageId,
              conv.leadOwner
                ? {
                    id: String(conv.leadOwner.id ?? "").trim() || undefined,
                    name: String(conv.leadOwner.name ?? "").trim() || undefined
                  }
                : undefined,
              dueAtIso
                ? {
                    dueAt: dueAtIso,
                    reminderAt: reminderAtIso
                  }
                : undefined
            );
          }
        } catch (err: any) {
          console.warn("[sendgrid inbound] human scheduling parser failed:", err?.message ?? err);
        }
      }
      let watchHandledByParser = false;
      const watchParserEligible =
        process.env.LLM_ENABLED === "1" &&
        process.env.LLM_SEMANTIC_SLOT_PARSER_ENABLED === "1" &&
        !!process.env.OPENAI_API_KEY;
      const watchParserHint =
        /\b(let me know|keep me posted|keep an eye out|watch(?:ing)? for|notify me|text me when|if you get one|when you get one|as soon as one comes in)\b/i.test(
          bodyTextLower
        ) ||
        hasWatchIntentPhrase(bodyTextLower) ||
        !!conv.inventoryWatchPending ||
        !!conv.inventoryWatch;
      if (watchParserEligible && watchParserHint) {
        try {
          const semantic = await parseSemanticSlotsWithLLM({
            text: bodyText,
            history: buildEffectiveHistory(conv, 12),
            lead: conv.lead,
            inventoryWatch: conv.inventoryWatch,
            inventoryWatchPending: conv.inventoryWatchPending,
            dialogState: String(conv?.dialogState?.name ?? "")
          });
          const semanticConfidence =
            typeof semantic?.confidence === "number" ? semantic.confidence : 0;
          const semanticConfidenceMin = Number(process.env.LLM_SEMANTIC_SLOT_CONFIDENCE_MIN ?? 0.76);
          const semanticAccepted =
            !!semantic &&
            semanticConfidence >= semanticConfidenceMin &&
            (semantic.watchAction !== "none" ||
              !!semantic.watch?.model ||
              !!semantic.watch?.year ||
              !!semantic.watch?.color);
          const watchAction = semanticAccepted ? semantic.watchAction : "none";
          const watchIntent =
            watchAction === "set_watch" ||
            hasWatchIntentPhrase(bodyTextLower);
          if (watchIntent) {
            const inventoryParserEligible =
              process.env.LLM_ENABLED === "1" &&
              process.env.LLM_INVENTORY_ENTITY_PARSER_ENABLED !== "0" &&
              !!process.env.OPENAI_API_KEY;
            const inv = inventoryParserEligible
              ? await parseInventoryEntitiesWithLLM({
                  text: bodyText,
                  history: buildEffectiveHistory(conv, 8),
                  lead: conv.lead
                })
              : null;
            const invConfidence =
              typeof inv?.confidence === "number" ? inv.confidence : 0;
            const invConfidenceMin = Number(process.env.LLM_INVENTORY_ENTITY_CONFIDENCE_MIN ?? 0.68);
            const invAccepted = !!inv && invConfidence >= invConfidenceMin;
            const leadVehicle = conv.lead?.vehicle ?? {};
            const rawModel =
              String(semantic?.watch?.model ?? "").trim() ||
              (invAccepted ? String(inv?.model ?? "").trim() : "") ||
              normalizeVehicleModel(leadVehicle?.model, leadVehicle?.make) ||
              "";
            const model = normalizeVehicleModel(rawModel, leadVehicle?.make) || rawModel || undefined;
            const semanticYearNum = Number(semantic?.watch?.year ?? NaN);
            const invYearNum = Number(inv?.year ?? NaN);
            const leadYearNum = Number(leadVehicle?.year ?? NaN);
            const year = Number.isFinite(semanticYearNum)
              ? semanticYearNum
              : Number.isFinite(invYearNum)
                ? invYearNum
                : Number.isFinite(leadYearNum)
                  ? leadYearNum
                  : undefined;
            const color = (
              String(semantic?.watch?.color ?? "").trim() ||
              (invAccepted ? String(inv?.color ?? "").trim() : "") ||
              String(leadVehicle?.color ?? "").trim()
            ) || undefined;
            const nowIso = new Date().toISOString();
            if (model) {
              const watch: InventoryWatch = {
                model,
                status: "active",
                createdAt: nowIso
              };
              if (year && Number.isFinite(Number(year))) watch.year = Number(year);
              if (color) watch.color = color;
              const condition = normalizeVehicleCondition(leadVehicle?.condition);
              if (condition) watch.condition = condition;
              if (watch.year && watch.color) watch.exactness = "exact";
              else if (watch.year) watch.exactness = "year_model";
              conv.inventoryWatch = watch;
              conv.inventoryWatches = [watch];
              conv.inventoryWatchPending = undefined;
              conv.dialogState = { name: "inventory_watch_active", updatedAt: nowIso };
              setFollowUpMode(conv, "holding_inventory", "inventory_watch");
              stopFollowUpCadence(conv, "inventory_watch");
              watchHandledByParser = true;
            } else {
              conv.inventoryWatchPending = {
                year,
                color,
                askedAt: nowIso
              };
              conv.dialogState = { name: "inventory_watch_prompted", updatedAt: nowIso };
              watchHandledByParser = true;
            }
          }
        } catch (err: any) {
          console.warn("[sendgrid inbound] human watch parser failed:", err?.message ?? err);
        }
      }
      addTodo(
        conv,
        "note",
        buildHumanEmailReplyTodoSummary(event.body),
        event.providerMessageId
      );
      if (!watchHandledByParser) {
        setFollowUpMode(conv, "manual_handoff", "human_email_reply");
        stopFollowUpCadence(conv, "manual_handoff");
      }
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

    const history = buildEffectiveHistory(conv, 20);
    const allowSchedulingOffer =
      /(appointment|appt|schedule|book|reserve|come in|stop in|stop by|visit|test ride|demo ride|\b\d{1,2}(:\d{2})?\s*(am|pm)\b)/i.test(
        event.body ?? ""
      );
    const weatherStatus = await getDealerWeatherStatusSafe();
    const result = await orchestrateInbound(event, history, {
      appointment: conv.appointment,
      followUp: conv.followUp,
      lead: conv.lead,
      leadSource: conv.lead?.source ?? null,
      bucket: conv.classification?.bucket ?? null,
      cta: conv.classification?.cta ?? null,
      pricingAttempts: getPricingAttempts(conv),
      allowSchedulingOffer,
      weather: weatherStatus,
      agentNameOverride: String(conv?.manualSender?.userName ?? "").trim() || undefined
    });

    if (result.handoff?.required) {
      addTodo(conv, result.handoff.reason, event.body, event.providerMessageId);
      setFollowUpMode(conv, "manual_handoff", `handoff:${result.handoff.reason}`);
      stopFollowUpCadence(conv, "manual_handoff");
      if (result.handoff.reason === "pricing" || result.handoff.reason === "payments") {
        markPricingEscalated(conv);
      }
      setEmailDraft(conv, result.handoff.ack);
    } else if (result.autoClose?.reason) {
      closeConversation(conv, result.autoClose.reason);
      setEmailDraft(conv, result.draft);
    } else {
      setEmailDraft(conv, result.draft);
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
  const sourceFromIdLower = String(meta.sourceFromId ?? "").trim().toLowerCase();
  const isTrafficLogProLeadSourceHint = /traffic\s*log\s*pro/i.test(leadSourceLower);
  const isTrafficLogProSourceFromIdHint = /traffic\s*log\s*pro/i.test(sourceFromIdLower);
  const isTrafficLogProPayloadHint =
    isTrafficLogProLeadSourceHint || isTrafficLogProSourceFromIdHint;
  const isExplicitWalkInLeadSourceHint =
    /\bwalk\s*[- ]?in\b/i.test(leadSourceLower) || /\bdealership\s+visit\b/i.test(leadSourceLower);
  const walkInSignalHint = /\b(step\s*\d+|walk\s*[- ]?in|stopped in|came in|dealership visit)\b/i.test(
    `${String(lead.comment ?? "")} ${String(lead.inquiry ?? "")} ${leadSourceLower}`
  );
  const vendorContactName = meta.vendorContactName?.trim() || "";
  const leadSourceId = lead.leadSourceId ?? undefined;
  const timeframeInfo = parseTimeframeMonths(lead.purchaseTimeframe);
  const make = lead.vehicleMake ?? undefined;
  const inquiryVehicleHintText = [lead.comment, lead.inquiry].filter(Boolean).join(" ").trim();
  const inquiryModelHint = extractInquiryModelHint(inquiryVehicleHintText);
  const inquiryYearHint = extractInquiryYearHint(inquiryVehicleHintText);
  if (!lead.year && inquiryYearHint) {
    lead.year = inquiryYearHint;
  }
  const model = normalizeVehicleModel(
    lead.vehicleModel ?? meta.model ?? lead.vehicleDescription ?? inquiryModelHint ?? undefined,
    make ?? null
  );
  if (!lead.vehicleCondition && lead.year) {
    const yr = Number(lead.year);
    const current = new Date().getFullYear();
    if (Number.isFinite(yr) && yr > 1980 && yr <= current - 1) {
      lead.vehicleCondition = "used";
    }
  }
  if (!lead.vehicleColor) {
    const inquiryColorHint = extractColorFromText(inquiryVehicleHintText);
    if (inquiryColorHint) {
      lead.vehicleColor = normalizeDisplayCase(inquiryColorHint);
    }
  }
  if ((!lead.vehicleDescription || !String(lead.vehicleDescription).trim()) && model) {
    lead.vehicleDescription = [lead.year, make, model].filter(Boolean).join(" ").trim();
  }
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
  const isFreshLeadConversation = !latestByLead;
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
    const rawSalespersonFromComment = extractExplicitSalespersonName(
      String(lead.comment ?? lead.inquiry ?? "")
    );
    const salespersonFirst = pickFirstToken(rawSalespersonFromComment);
    const allowVendorOwnerFallback =
      !isExplicitWalkInLeadSourceHint || isTrafficLogProPayloadHint || !!salespersonFirst;
    const matchedSalesperson =
      users.find(u => {
        if (u.role !== "salesperson") return false;
        const first = pickFirstToken(u.firstName);
        const nameFirst = pickFirstToken(u.name);
        return !!salespersonFirst && (salespersonFirst === first || salespersonFirst === nameFirst);
      }) ??
      users.find(u => {
        if (u.role !== "salesperson") return false;
        if (!allowVendorOwnerFallback) return false;
        const first = pickFirstToken(u.firstName);
        const nameFirst = pickFirstToken(u.name);
        return !!vendorFirst && (vendorFirst === first || vendorFirst === nameFirst);
      }) ??
      null;
    const matchedManagerFromVendor =
      users.find(u => {
        if (u.role !== "manager") return false;
        if (!allowVendorOwnerFallback) return false;
        const first = pickFirstToken(u.firstName);
        const nameFirst = pickFirstToken(u.name);
        return !!vendorFirst && (vendorFirst === first || vendorFirst === nameFirst);
      }) ?? null;
    const owner = matchedSalesperson ?? matchedManagerFromVendor ?? manager;
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
    preferredContactMethod: lead.preferredContactMethod,
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
  const nonSalesPromotionLead =
    /ride challenge|challenge signup|miles challenge/i.test(leadSourceLower) ||
    /ride challenge|challenge signup|record your miles/i.test(journeyText);
  const shouldNormalizeLegacyNewCondition =
    conv.lead.vehicle.condition === "new" &&
    !nonSalesPromotionLead &&
    (isStrictSalesTradeBucket(rule.bucket) ||
      !!String(conv.lead.vehicle.stockId ?? "").trim() ||
      !!String(conv.lead.vehicle.vin ?? "").trim() ||
      !!String(conv.lead.vehicle.model ?? "").trim());
  if (shouldNormalizeLegacyNewCondition) {
    const normalizedLeadCondition = await normalizeLegacyNewLeadCondition({
      condition: "new",
      year: conv.lead.vehicle.year,
      model: conv.lead.vehicle.model,
      make: conv.lead.vehicle.make
    });
    if (normalizedLeadCondition && normalizedLeadCondition !== "new") {
      conv.lead.vehicle.condition = normalizedLeadCondition;
    }
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

  const isTradeAcceleratorLead = leadSourceLower.includes("trade accelerator");
  const rawComment = String(lead.comment ?? "");
  const cleanedComment = normalizeAdfInquiryText(rawComment);
  const commentInquiry = extractTrueInquiryFromAdfText(rawComment);
  const inquiryRaw = String(lead.inquiry ?? "");
  const cleanedInquiry = normalizeAdfInquiryText(inquiryRaw);
  const parsedInquiry = extractTrueInquiryFromAdfText(inquiryRaw);
  const inquiryCandidates = [parsedInquiry, commentInquiry, cleanedInquiry, cleanedComment]
    .map(v => String(v ?? "").trim())
    .filter(Boolean);
  const nonMetadataInquiryCandidates = inquiryCandidates.filter(v => !looksLikeAdfMetadataBlob(v));
  const substantiveInquiryCandidates = nonMetadataInquiryCandidates.filter(
    v => !isLikelyGreetingOnlyInquiry(v)
  );
  let effectiveInquiry =
    substantiveInquiryCandidates[0] ??
    nonMetadataInquiryCandidates[0] ??
    "";
  if (isTradeAcceleratorLead) {
    const tradeInquiryCandidate =
      substantiveInquiryCandidates[0] ??
      inquiryCandidates[0] ??
      "";
    const sanitizedTradeInquiry = sanitizeTradeAcceleratorInquiry(tradeInquiryCandidate);
    effectiveInquiry = sanitizedTradeInquiry || "trade-in appraisal request";
  }
  lead.inquiry = effectiveInquiry;
  const inquiryText = String(effectiveInquiry).toLowerCase();
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
      lead.inquiry ?? ""
    ]
      .filter(v => v !== null)
      .join("\n");
  const inboundProviderMessageIdRaw = String(req.body?.MessageID ?? req.body?.message_id ?? "").trim();
  const syntheticAdfProviderMessageId = buildSyntheticAdfProviderMessageId({
    requestDate: extractAdfRequestDate(adfXml),
    leadRef,
    leadSource,
    phone: leadPhone,
    email: leadEmailForConversation ?? leadEmail,
    stockId: lead.stockId,
    vin: lead.vin,
    inquiry: effectiveInquiry
  });
  const event: InboundMessageEvent = {
    channel: "email",
    provider: "sendgrid_adf",
    from: leadEmailForConversation || leadPhone || leadKey || "unknown_sender",
    to: "dealership",
    body: inboundBody,
    providerMessageId: inboundProviderMessageIdRaw || syntheticAdfProviderMessageId,
    receivedAt: new Date().toISOString()
  };
  if (isDuplicateInboundEvent(conv, event, { windowMs: 15 * 60 * 1000 })) {
    console.log("[sendgrid inbound] duplicate ignored", {
      convId: conv.id,
      providerMessageId: event.providerMessageId
    });
    return res.status(200).json({ ok: true, parsed: true, duplicate: true, leadKey });
  }
  const hasOutboundBeforeInbound = Array.isArray(conv.messages) && conv.messages.some((m: any) => m.direction === "out");
  const isInitialAdf = event.provider === "sendgrid_adf" && !hasOutboundBeforeInbound;
  const isExplicitWalkInLeadSource = isExplicitWalkInLeadSourceHint;
  const isTrafficLogWalkInLead =
    isExplicitWalkInLeadSource ||
    (isTrafficLogProPayloadHint && walkInSignalHint) ||
    !!conv?.lead?.walkIn;
  const isInitialTrafficLogWalkIn = isInitialAdf && isTrafficLogWalkInLead;
  const adfHistory = buildEffectiveHistory(conv, 6);
  const safeParser = async <T>(label: string, run: () => Promise<T | null>): Promise<T | null> => {
    try {
      return await run();
    } catch (error) {
      console.warn(`[sendgrid inbound] parser ${label} failed:`, (error as any)?.message ?? error);
      return null;
    }
  };
  const [
    llmDialogAct,
    llmIntent,
    llmJourneyIntent,
    llmInventoryEntities,
    llmSemanticSlots,
    llmResponseControl,
    llmRoutingDecision,
    llmFaqTopic,
    llmWalkInOutcome
  ] = await Promise.all([
    safeParser("dialog_act", () =>
      parseDialogActWithLLM({
        text: effectiveInquiry,
        history: adfHistory,
        lead: conv.lead
      })
    ),
    safeParser("intent", () =>
      parseIntentWithLLM({
        text: effectiveInquiry,
        history: adfHistory,
        lead: conv.lead
      })
    ),
    safeParser("journey_intent", () =>
      parseJourneyIntentWithLLM({
        text: effectiveInquiry,
        history: adfHistory,
        lead: conv.lead
      })
    ),
    safeParser("inventory_entities", () =>
      parseInventoryEntitiesWithLLM({
        text: effectiveInquiry,
        history: adfHistory,
        lead: conv.lead
      })
    ),
    safeParser("semantic_slots", () =>
      parseSemanticSlotsWithLLM({
        text: effectiveInquiry,
        history: adfHistory,
        lead: conv.lead,
        inventoryWatch: conv.inventoryWatch,
        inventoryWatchPending: conv.inventoryWatchPending,
        dialogState: String(conv.dialogState?.name ?? "")
      })
    ),
    safeParser("response_control", () =>
      parseResponseControlWithLLM({
        text: effectiveInquiry,
        history: adfHistory,
        lead: conv.lead
      })
    ),
    safeParser("routing_decision", () =>
      parseRoutingDecisionWithLLM({
        text: effectiveInquiry,
        history: adfHistory,
        lead: conv.lead,
        followUp: conv.followUp ?? null,
        dialogState: conv.dialogState?.name ?? null,
        classification: {
          bucket: conv.classification?.bucket ?? null,
          cta: conv.classification?.cta ?? null
        }
      })
    ),
    safeParser("faq_topic", () =>
      parseDealershipFaqTopicWithLLM({
        text: effectiveInquiry,
        history: adfHistory,
        lead: conv.lead
      })
    ),
    safeParser("walkin_outcome", () =>
      parseWalkInOutcomeWithLLM({
        text: effectiveInquiry,
        history: adfHistory,
        lead: conv.lead
      })
    )
  ]);
  const dialogActConfidenceMin = Number(process.env.LLM_DIALOG_ACT_CONFIDENCE_MIN ?? 0.68);
  const intentConfidenceMin = Number(process.env.LLM_INTENT_CONFIDENCE_MIN ?? 0.75);
  const journeyIntentConfidence =
    typeof llmJourneyIntent?.confidence === "number" ? llmJourneyIntent.confidence : 0;
  const journeyIntentConfidenceMin = Number(process.env.LLM_JOURNEY_INTENT_CONFIDENCE_MIN ?? 0.72);
  const journeyIntentAccepted =
    !!llmJourneyIntent &&
    llmJourneyIntent.explicitRequest === true &&
    journeyIntentConfidence >= journeyIntentConfidenceMin;
  const saleTradeIntentFromParser =
    journeyIntentAccepted && llmJourneyIntent?.journeyIntent === "sale_trade";
  const serviceSupportIntentFromParser =
    journeyIntentAccepted && llmJourneyIntent?.journeyIntent === "service_support";
  const marketingEventIntentFromParser =
    journeyIntentAccepted && llmJourneyIntent?.journeyIntent === "marketing_event";
  const routingParserDecision = resolveRoutingParserDecision({
    parserIntent: llmRoutingDecision?.primaryIntent ?? null,
    parserFallbackAction: llmRoutingDecision?.fallbackAction ?? null,
    parserClarifyPrompt: llmRoutingDecision?.clarifyPrompt ?? null,
    parserConfidence: llmRoutingDecision?.confidence ?? null,
    parserConfidenceMin: Number(process.env.LLM_ROUTING_PARSER_CONFIDENCE_MIN ?? 0.72)
  });
  const routingParserIntentOverride =
    routingParserDecision.intentOverride && routingParserDecision.intentOverride !== "general"
      ? routingParserDecision.intentOverride
      : null;
  const parserPricingIntent = routingParserIntentOverride === "pricing_payments";
  const parserSchedulingIntent = routingParserIntentOverride === "scheduling";
  const parserCallbackIntent = routingParserIntentOverride === "callback";
  const parserAvailabilityIntent = routingParserIntentOverride === "availability";
  const semanticSlotsConfidence =
    typeof llmSemanticSlots?.confidence === "number" ? llmSemanticSlots.confidence : 0;
  const semanticSlotsConfidenceMin = Number(process.env.LLM_SEMANTIC_SLOT_CONFIDENCE_MIN ?? 0.76);
  const semanticSlotsAccepted = !!llmSemanticSlots && semanticSlotsConfidence >= semanticSlotsConfidenceMin;
  const semanticDepartmentIntent = semanticSlotsAccepted ? llmSemanticSlots?.departmentIntent ?? "none" : "none";
  const semanticPartsIntent = semanticDepartmentIntent === "parts";
  const semanticApparelIntent = semanticDepartmentIntent === "apparel";
  const semanticServiceIntent = semanticDepartmentIntent === "service";
  const pricingInquiryIntentFromParser =
    !!llmDialogAct &&
    llmDialogAct.topic === "pricing" &&
    llmDialogAct.explicitRequest === true &&
    Number(llmDialogAct.confidence ?? 0) >= dialogActConfidenceMin;
  let pricingInquiryIntent =
    pricingInquiryIntentFromParser || parserPricingIntent || isPricingPaymentInquiry(inquiryText);
  const inventoryEntityConfidence =
    typeof llmInventoryEntities?.confidence === "number" ? llmInventoryEntities.confidence : 0;
  const inventoryEntityConfidenceMin = Number(process.env.LLM_INVENTORY_ENTITY_CONFIDENCE_MIN ?? 0.68);
  const inventoryEntityAccepted = !!llmInventoryEntities && inventoryEntityConfidence >= inventoryEntityConfidenceMin;
  const availabilityIntentFromParser =
    parserAvailabilityIntent ||
    !!llmIntent &&
    llmIntent.intent === "availability" &&
    llmIntent.explicitRequest === true &&
    Number(llmIntent.confidence ?? 0) >= intentConfidenceMin;
  const responseControlAccepted = isResponseControlParserAccepted(llmResponseControl);
  const scheduleIntentFromParser =
    parserSchedulingIntent || (responseControlAccepted && llmResponseControl?.intent === "schedule_request");
  const callbackIntentFromParser =
    parserCallbackIntent ||
    !!llmIntent &&
    llmIntent.intent === "callback" &&
    llmIntent.explicitRequest === true &&
    Number(llmIntent.confidence ?? 0) >= intentConfidenceMin;
  const callbackTimeFromParser = String(llmIntent?.callback?.timeText ?? "").trim();
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
  const partsIntentFromText =
    /\b(part number|oem parts?|aftermarket parts?|need (?:a )?part|looking for (?:a )?part|parts?\s+(?:for|department|counter|desk)|do you have (?:it|this|that)?\s*in stock)\b/i.test(
      inquiryText
    ) ||
    /\bparts?\b/.test(leadSourceLower);
  const apparelIntentFromText =
    /\b(apparel|motorclothes|merch|jacket|helmet|gloves|boots|shirt|hoodie)\b/i.test(inquiryText) ||
    /\bapparel|motorclothes\b/i.test(leadSourceLower);
  const jumpStartExperienceLead =
    isJumpStartExperienceText(effectiveInquiry) ||
    isJumpStartExperienceText(lead.comment ?? null) ||
    isJumpStartExperienceText(lead.inquiry ?? null) ||
    isJumpStartExperienceText(leadSource ?? null);
  const hasStockIntent =
    !!lead.stockId || !!lead.vin || inquiryText.includes("available") || availabilityIntentFromParser;
  const parserBucketCta: { bucket: LeadBucket; cta: LeadCTA } | null =
    routingParserIntentOverride === "availability"
      ? { bucket: "inventory_interest", cta: "check_availability" }
      : routingParserIntentOverride === "pricing_payments"
        ? { bucket: "inventory_interest", cta: "request_a_quote" }
        : routingParserIntentOverride === "scheduling"
          ? jumpStartExperienceLead
            ? { bucket: "general_inquiry", cta: "contact_us" }
            : { bucket: "test_ride", cta: "schedule_test_ride" }
          : routingParserIntentOverride === "callback"
            ? { bucket: "general_inquiry", cta: "contact_us" }
            : null;

  let inferredBucket = rule.bucket;
  let inferredCta = rule.cta;
  if (!leadSource || rule.ruleName === "default") {
    if (parserBucketCta) {
      inferredBucket = parserBucketCta.bucket;
      inferredCta = parserBucketCta.cta;
    } else if (semanticPartsIntent || partsIntentFromText) {
      inferredBucket = "parts";
      inferredCta = "parts_request";
    } else if (semanticApparelIntent || apparelIntentFromText) {
      inferredBucket = "apparel";
      inferredCta = "apparel_request";
    } else if (semanticServiceIntent || serviceSupportIntentFromParser) {
      inferredBucket = "service";
      inferredCta = "service_request";
    } else if (marketingEventIntentFromParser) {
      inferredBucket = "event_promo";
      inferredCta = "event_rsvp";
    } else if (hasStockIntent) {
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
        if (jumpStartExperienceLead) {
          inferredBucket = "general_inquiry";
          inferredCta = "contact_us";
        } else {
          inferredBucket = "test_ride";
          inferredCta = "schedule_test_ride";
        }
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
    if (saleTradeIntentFromParser && inferredBucket === "general_inquiry" && !parserBucketCta) {
      inferredBucket = hasStockIntent ? "inventory_interest" : "trade_in_sell";
      inferredCta = hasStockIntent ? "check_availability" : "value_my_trade";
    }
  }
  const forcedTestRide = leadSourceLower.includes("test ride") || leadSourceLower.includes("book test ride");
  if (forcedTestRide && !jumpStartExperienceLead) {
    inferredBucket = "test_ride";
    inferredCta = "schedule_test_ride";
  }
  const forcedTradeIn =
    leadSourceLower.includes("trade accelerator") ||
    /\btrade[-\s]?in\b/.test(leadSourceLower);
  const forcedPrivatePartyMarketplaceSell =
    /marketplace/i.test(leadSourceLower) &&
    /(contact\s*a\s*dealer|used\s*mkt|dealer\s*portal|h-?d1)/i.test(leadSourceLower) &&
    !/(prequal|credit|coa|finance|apply)/i.test(leadSourceLower);
  if (forcedTradeIn) {
    inferredBucket = "trade_in_sell";
    inferredCta = "value_my_trade";
    pricingInquiryIntent = false;
  }
  if (forcedPrivatePartyMarketplaceSell) {
    inferredBucket = "trade_in_sell";
    inferredCta = "sell_my_bike";
    pricingInquiryIntent = false;
  }
  if (isTrafficLogWalkInLead) {
    inferredBucket = "in_store";
    inferredCta = "contact_us";
  }
  if (jumpStartExperienceLead) {
    inferredBucket = "general_inquiry";
    inferredCta = "contact_us";
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
    hasPhone: !!lead.phone,
    primaryChannel:
      lead.preferredContactMethod === "email"
        ? "email"
        : lead.preferredContactMethod === "sms"
          ? "sms"
          : lead.preferredContactMethod === "phone"
            ? "phone"
            : undefined,
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
    forcedTestRide,
    jumpStartExperienceLead,
    routingParserAccepted: routingParserDecision.accepted,
    routingParserIntentOverride
  });
  setConversationClassification(conv, {
    bucket: inferredBucket,
    cta: inferredCta,
    channel,
    ruleName: forcedTestRide ? "room58_book_test_ride_forced" : rule.ruleName
  });
  const inferredBucketKey = String(inferredBucket ?? "").trim().toLowerCase();
  const inferredCtaKey = String(inferredCta ?? "").trim().toLowerCase();
  const departmentLeadRole =
    inferredBucketKey === "service" || inferredCtaKey === "service_request" || serviceVinRequest
      ? "service"
      : inferredBucketKey === "parts" || inferredCtaKey === "parts_request" || inferredCtaKey === "parts_inquiry"
        ? "parts"
        : inferredBucketKey === "apparel" ||
            inferredCtaKey === "apparel_request" ||
            inferredCtaKey === "apparel_inquiry"
          ? "apparel"
          : null;
  let usersForOwnerRouting: any[] | null = null;
  const getUsersForOwnerRouting = async (): Promise<any[]> => {
    if (usersForOwnerRouting) return usersForOwnerRouting;
    usersForOwnerRouting = await listUsers();
    return usersForOwnerRouting;
  };
  if (isFreshLeadConversation && departmentLeadRole) {
    const users = await getUsersForOwnerRouting();
    const departmentOwner = pickUserForRole(users, departmentLeadRole, vendorContactName);
    if (departmentOwner?.id) {
      conv.leadOwner = {
        id: departmentOwner.id,
        name:
          departmentOwner.name ??
          departmentOwner.firstName ??
          departmentOwner.email ??
          (departmentLeadRole === "service"
            ? "Service Department"
            : departmentLeadRole === "parts"
              ? "Parts Department"
            : "Apparel Department"),
        assignedAt: new Date().toISOString()
      };
    }
  }
  if (!departmentLeadRole) {
    const users = await getUsersForOwnerRouting();
    const currentOwnerId = String(conv.leadOwner?.id ?? "").trim();
    const currentOwnerName = String(conv.leadOwner?.name ?? "").trim();
    const currentOwner =
      users.find(u => String(u?.id ?? "").trim() === currentOwnerId) ?? null;
    const currentOwnerRole = String(currentOwner?.role ?? "").trim().toLowerCase();
    const currentOwnerIsDepartment =
      isDepartmentUserRole(currentOwnerRole) ||
      (!currentOwner && isLikelyDepartmentOwnerName(currentOwnerName));
    if (currentOwnerIsDepartment) {
      const salesOwner = pickSalesOwner(users, vendorContactName);
      if (salesOwner?.id) {
        conv.leadOwner = {
          id: salesOwner.id,
          name: salesOwner.name ?? salesOwner.firstName ?? salesOwner.email ?? "Sales",
          assignedAt: new Date().toISOString()
        };
      }
    }
  }
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

  const callOnlyRequested = isCallOnlyText(inquiryText);
  const callbackRequestedByLeadHeuristic =
    /\b(call|callback|call me|give me a call|reach out|reach me|phone me|call us)\b/i.test(inquiryText) &&
    (/\b(today|tomorrow|monday|mon|tuesday|tue|wednesday|wed|thursday|thu|friday|fri|saturday|sat|sunday|sun|morning|afternoon|evening|tonight)\b/i.test(
      inquiryText
    ) ||
      /\b(\d{1,2}(:\d{2})?\s*(am|pm)\b|noon\b|midnight\b)\b/i.test(inquiryText) ||
      /\b\d{1,2}(?::\d{2})?\s*(?:-|–|to)\s*\d{1,2}(?::\d{2})?\s*(am|pm)\b/i.test(inquiryText));
  const callbackRequestedInLead =
    callbackIntentFromParser ||
    callbackRequestedByLeadHeuristic ||
    !!String(lead.preferredTime ?? "").trim();
  const callbackTimeHintFromText = extractCallbackTimeHintFromText(inquiryText);
  const callbackTimeHint =
    callbackTimeFromParser ||
    String(lead.preferredTime ?? "").trim() ||
    callbackTimeHintFromText ||
    (inquiryDayPart ? `${inquiryDayPart.dayLabel} ${inquiryDayPart.dayPart}` : "");
  const callbackTz = callbackRequestedInLead
    ? (await getSchedulerConfig()).timezone || "America/New_York"
    : "America/New_York";
  const callbackSchedule = callbackRequestedInLead
    ? buildCallbackTodoSchedule(callbackTimeHint, callbackTz)
    : {};
  const callbackSummary = callbackTimeHint
    ? `Call requested: ${callbackTimeHint}.`
    : "Call requested.";
  const suppressInitialAutoDraftForTimedCallback =
    callbackRequestedInLead &&
    !!String(callbackSchedule?.dueAt ?? "").trim() &&
    !isTrafficLogWalkInLead &&
    inferredBucket !== "in_store";

  let creditTodoCreated = false;
  const inquiryLower = inquiryText.toLowerCase();
  const isPrequalLead =
    !isTrafficLogWalkInLead &&
    (inferredCta === "prequalify" ||
      (inferredBucket === "finance_prequal" && inferredCta !== "hdfs_coa") ||
      /prequal|pre-qual/.test(leadSourceLower) ||
      /\bprequal\b/.test(inquiryLower));
  const isCreditLead =
    !isTrafficLogWalkInLead &&
    (inferredBucket === "finance_prequal" ||
      inferredCta === "hdfs_coa" ||
      inferredCta === "prequalify" ||
      /coa|credit application|apply for credit|finance application|prequal/i.test(leadSourceLower));
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

  const isRideChallengeLead =
    event.provider === "sendgrid_adf" &&
    (/ride challenge|challenge signup|miles challenge/i.test(leadSourceLower) ||
      /ride challenge|challenge signup|record your miles|ride challenge/i.test(inquiryText));
  const computeRideChallengeReminderDueAt = async () => {
    const cfg = await getSchedulerConfig();
    const tz = cfg.timezone || "America/New_York";
    const now = new Date();
    const local = new Date(now.toLocaleString("en-US", { timeZone: tz }));
    const year = local.getFullYear();
    const month = local.getMonth() + 1;
    const day = local.getDate();
    let reminderYear = year;
    let reminderMonth = 9;
    let reminderDay = 15;
    // If this lead arrives after Sep 15 but before Nov 1, send a near-term catch-up reminder.
    if (month > 9 || (month === 9 && day > 15)) {
      if (month < 11) {
        const tomorrow = new Date(local);
        tomorrow.setDate(local.getDate() + 1);
        reminderYear = tomorrow.getFullYear();
        reminderMonth = tomorrow.getMonth() + 1;
        reminderDay = tomorrow.getDate();
      } else {
        reminderYear = year + 1;
      }
    }
    return localPartsToUtcDate(tz, {
      year: reminderYear,
      month: reminderMonth,
      day: reminderDay,
      hour24: 10,
      minute: 30
    }).toISOString();
  };
  const applyRideChallengeReminderCadence = async () => {
    const dueAt = await computeRideChallengeReminderDueAt();
    scheduleLongTermFollowUp(conv, dueAt, "ride_challenge_final_mileage", {
      contextTag: "ride_challenge_signup"
    });
    setFollowUpMode(conv, "active", "ride_challenge_signup");
    return dueAt;
  };
  const isRideChallengeSignup =
    isRideChallengeLead &&
    !(conv.messages ?? []).some((m: any) => m.direction === "out");
  if (isRideChallengeSignup) {
    const profile = await getDealerProfile();
    const dealerName = profile?.dealerName ?? "American Harley-Davidson";
    const agentName = profile?.agentName ?? "Alexandra";
    const firstName = normalizeDisplayCase(conv.lead?.firstName) || "there";
    const ack =
      `Hi ${firstName} — this is ${agentName} at ${dealerName}. ` +
      "Thanks for signing up for this year's ride challenge. " +
      "Feel free to stop in and record your miles throughout the year. " +
      "Let us know if you need anything to keep your bike rolling through the challenge!";
    const dueAt = await applyRideChallengeReminderCadence();
    appendOutbound(conv, "dealership", leadKey, ack, "draft_ai");
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
      note: "ride_challenge_signup_non_sales",
      draft: ack,
      rideChallengeReminderDueAt: dueAt
    });
  }

  const timeframeLower = String(lead.purchaseTimeframe ?? "").toLowerCase();
  const isDealerRideEventFromParser =
    marketingEventIntentFromParser &&
    /event name:\s*dealer test ride|demo bikes ridden|dealer lead app/i.test(effectiveInquiry);
  const isDealerRideEventLead =
    event.provider === "sendgrid_adf" &&
    (leadSourceLower.includes("dealer lead app") ||
      /event name:\s*dealer test ride|demo bikes ridden|dealer lead app/i.test(effectiveInquiry) ||
      isDealerRideEventFromParser);
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
    const users = await listUsers();
    const ownerId = String(conv.leadOwner?.id ?? "").trim();
    const ownerById =
      users.find(u => String(u.id ?? "").trim() === ownerId) ?? null;
    const vendorFirst = pickFirstToken(vendorContactName);
    const ownerByVendor =
      users.find(u => {
        const first = pickFirstToken(u.firstName);
        const nameFirst = pickFirstToken(u.name);
        return !!vendorFirst && (vendorFirst === first || vendorFirst === nameFirst);
      }) ?? null;
    const manager = users.find(u => u.role === "manager") ?? null;
    const owner = ownerById ?? ownerByVendor ?? manager;
    const ownerPhone = pickUserPhone(owner);
    const ownerName =
      String(owner?.firstName ?? "").trim() ||
      String(owner?.name ?? "").trim() ||
      String(conv.leadOwner?.name ?? "").trim() ||
      "salesperson";
    if (!appt?.staffNotify?.followUpSentAt) {
      const customerName =
        [conv.lead?.firstName, conv.lead?.lastName].filter(Boolean).join(" ").trim() ||
        conv.leadKey ||
        "customer";
      const token = ensureDealerRideOutcomeToken(conv);
      const outcomeLink = buildStaffOutcomeLink(token);
      conv.dealerRide = conv.dealerRide ?? {};
      conv.dealerRide.staffNotify = conv.dealerRide.staffNotify ?? {};
      conv.dealerRide.staffNotify.userId =
        String(owner?.id ?? "").trim() || conv.dealerRide.staffNotify.userId;
      conv.dealerRide.staffNotify.phone = ownerPhone || conv.dealerRide.staffNotify.phone;
      const leadSummary = [
        `Dealer ride outcome needed for ${customerName}.`,
        "DLA confirms they rode a demo bike.",
        `Reply: OUTCOME ${token} SOLD <stock/vin> | HOLD <stock/vin> <when> | FOLLOWUP <when> | LOST <reason>.`,
        outcomeLink ? `Update form: ${outcomeLink}` : null
      ]
        .filter(Boolean)
        .join("\n");
      const staffSms = await sendInternalSalespersonSms(ownerPhone, leadSummary);
      addTodo(
        conv,
        "note",
        staffSms.sent
          ? `Salesperson SMS sent to ${ownerName}${staffSms.sid ? ` (SID ${staffSms.sid})` : ""}.`
          : `Salesperson SMS failed for ${ownerName}: ${staffSms.reason ?? "unknown_error"}.`
      );
      if (appt) {
        appt.staffNotify = appt.staffNotify ?? {};
        appt.staffNotify.followUpSentAt = appt.staffNotify.followUpSentAt ?? new Date().toISOString();
      }
      if (staffSms.sent) {
        conv.dealerRide.staffNotify.followUpSentAt =
          conv.dealerRide.staffNotify.followUpSentAt ?? new Date().toISOString();
      }
    }
  }
  const parserNoPurchaseSignal =
    journeyIntentAccepted &&
    llmJourneyIntent?.journeyIntent === "none" &&
    /not interested in purchasing at this time|not looking to buy|no plans to buy|not buying/i.test(inquiryText);
  const isNoPurchaseNow =
    /not interested in purchasing at this time/.test(timeframeLower) ||
    /purchase timeframe:\s*i am not interested in purchasing at this time/.test(inquiryText) ||
    /do you expect to make a motorcycle purchase in the near future\?\s*no/.test(inquiryText) ||
    /not interested in purchasing at this time/.test(inquiryText) ||
    parserNoPurchaseSignal;
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
    const token = ensureDealerRideOutcomeToken(conv);
    const outcomeLink = buildStaffOutcomeLink(token);
    conv.dealerRide = conv.dealerRide ?? {};
    conv.dealerRide.staffNotify = conv.dealerRide.staffNotify ?? {};
    conv.dealerRide.staffNotify.userId =
      String(owner?.id ?? "").trim() || conv.dealerRide.staffNotify.userId;
    conv.dealerRide.staffNotify.phone =
      pickUserPhone(owner) || conv.dealerRide.staffNotify.phone;
    const leadSummary = [
      `Dealer ride outcome needed for ${customerName}.`,
      'DLA says "not interested in purchasing at this time".',
      `Reply: OUTCOME ${token} SOLD <stock/vin> | HOLD <stock/vin> <when> | FOLLOWUP <when> | LOST <reason>.`,
      outcomeLink ? `Update form: ${outcomeLink}` : null
    ]
      .filter(Boolean)
      .join("\n");
    const staffSms = await sendInternalSalespersonSms(pickUserPhone(owner), leadSummary);
    addTodo(
      conv,
      "note",
      staffSms.sent
        ? `Salesperson SMS sent to ${ownerName}${staffSms.sid ? ` (SID ${staffSms.sid})` : ""}.`
        : `Salesperson SMS failed for ${ownerName}: ${staffSms.reason ?? "unknown_error"}.`
    );
    if (staffSms.sent) {
      conv.dealerRide = conv.dealerRide ?? {};
      conv.dealerRide.staffNotify = conv.dealerRide.staffNotify ?? {};
      conv.dealerRide.staffNotify.followUpSentAt =
        conv.dealerRide.staffNotify.followUpSentAt ?? new Date().toISOString();
    }
    const profile = await getDealerProfile();
    const dealerName = profile?.dealerName ?? "American Harley-Davidson";
    const ownerDisplayRaw =
      String(owner?.firstName ?? "").trim() ||
      String(owner?.name ?? "").trim() ||
      String(conv.leadOwner?.name ?? "").trim() ||
      String(profile?.agentName ?? "Alexandra").trim();
    const ownerDisplay = normalizeDisplayCase(ownerDisplayRaw);
    const ownerFirst = normalizeDisplayCase(ownerDisplay.split(/\s+/).filter(Boolean)[0] ?? ownerDisplay);
    const firstName = normalizeDisplayCase(conv.lead?.firstName);
    const customerAck =
      `${firstName ? `Hi ${firstName} — ` : "Hi — "}This is ${ownerFirst} at ${dealerName}. ` +
      "Thanks again for coming in for the test ride. " +
      "If any questions come up or you’d like to discuss options further, just text me anytime.";
    const shouldSendCustomerReply = shouldSendDealerLeadCustomerReply(conv, event);
    if (shouldSendCustomerReply.allow) {
      const preferredMethod = String(conv.lead?.preferredContactMethod ?? "").trim().toLowerCase();
      if (preferredMethod === "email") {
        setEmailDraft(conv, customerAck);
      } else if (preferredMethod === "phone") {
        addCallTodoIfMissing(conv, "Preferred contact method is phone. Call customer (no auto text/email).");
      } else {
        appendOutbound(conv, "dealership", leadKey, customerAck, "draft_ai");
      }
    } else {
      addTodo(
        conv,
        "note",
        `Suppressed repeat Dealer Lead App customer auto-reply (${shouldSendCustomerReply.reason}).`
      );
    }
    setFollowUpMode(conv, "manual_handoff", "dealer_ride_no_purchase");
    stopFollowUpCadence(conv, "manual_handoff");
    const shouldIncludeDraft = shouldSendCustomerReply.allow;
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
      draft: shouldIncludeDraft ? customerAck : undefined,
      staffSms
    });
  }

  let cachedInitialDealerProfile: any | undefined;
  const getInitialDealerProfile = async () => {
    if (cachedInitialDealerProfile !== undefined) return cachedInitialDealerProfile;
    cachedInitialDealerProfile = await getDealerProfile();
    return cachedInitialDealerProfile;
  };

  const applyInitialAdfPrefix = async (text: string) => {
    if (!isInitialAdf) return text;
    const profile = await getInitialDealerProfile();
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
      if (!/\b(meta|facebook)\b/i.test(body)) {
        const metaLine = modelLabel
          ? `I saw your Meta inquiry come over for the ${modelLabel}.`
          : "I saw your Meta inquiry come over.";
        body = `${metaLine} ${body}`.trim();
      }
    }
    const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // Strip any pre-existing identity intro so initial ADF always uses one
    // consistent profile-based line and never double-introduces.
    body = body.replace(/\bthis is\s+[^.]{1,80}?\s+at\s+[^.]{2,120}\.?\s*/gi, "");
    const agentEsc = esc(agentName);
    const dealerEsc = esc(dealerName);
    body = body.replace(new RegExp(`\\bthis is\\s+${agentEsc}\\s+at\\s+${dealerEsc}\\.?\\s*`, "ig"), "");
    return `${prefix}${body}`.trim();
  };

  const isServiceLead = inferredBucket === "service" || inferredCta === "service_request" || serviceVinRequest;
  const isPartsLead = inferredBucket === "parts" || inferredCta === "parts_request" || inferredCta === "parts_inquiry";
  const isApparelLead =
    inferredBucket === "apparel" ||
    inferredCta === "apparel_request" ||
    inferredCta === "apparel_inquiry";
  const isDepartmentLead = isServiceLead || isPartsLead || isApparelLead;
  const room58Source = /room58/i.test(String(conv.lead?.source ?? ""));
  const isRoom58Standard =
    leadSourceLower.includes("room58 - standard") || rule.ruleName === "room58_standard";
  const metaOfferRawModel = conv.lead?.vehicle?.model ?? conv.lead?.vehicle?.description ?? "";
  const isMetaPromoOffer = /meta promo offer/i.test(leadSourceLower);
  const skipAvailabilityLine =
    isDepartmentLead ||
    isRoom58Standard ||
    (isMetaPromoOffer && /^(other|full line)$/i.test(metaOfferRawModel.trim()));
  let initialMedia =
    isInitialAdf && !isDepartmentLead && !room58Source
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
    // Keep pricing/finance first replies concise; avoid appending a second inventory prompt.
    if (/\b(payment|monthly|apr|down payment|down|budget|finance|financing|credit app|credit application|term)\b/i.test(lower)) {
      return text;
    }
    if (/\b(checking it out|come by|stop in|stop by|take a look|in stock|available)\b/i.test(lower)) {
      return text;
    }
    return `${text} ${initialAvailabilityLine}`.trim();
  };
  let cachedInitialOffersLine: string | null | undefined;
  const resolveInitialOffersLine = async (): Promise<string> => {
    if (cachedInitialOffersLine !== undefined) return cachedInitialOffersLine ?? "";
    if (!isInitialAdf) {
      cachedInitialOffersLine = null;
      return "";
    }
    const sourceLower = String(conv.lead?.source ?? "").toLowerCase();
    const metaPromoSource = /meta promo offer/i.test(sourceLower);
    const room58LeadSource = /room58/i.test(sourceLower);
    if (!metaPromoSource && !room58LeadSource) {
      cachedInitialOffersLine = null;
      return "";
    }
    const profile = await getInitialDealerProfile();
    const offersResolution = resolveOffersUrl({
      dealerProfile: profile,
      conversation: conv,
      leadInquiry: effectiveInquiry,
      leadComment: lead.inquiry ?? inquiryRaw,
      inboundText: event.body
    });
    const shouldIncludeOffersLine = metaPromoSource || (room58LeadSource && !!offersResolution.promoNoteUrl);
    cachedInitialOffersLine = shouldIncludeOffersLine
      ? buildOffersLine(offersResolution.preferredUrl, { prefix: "Current offers:" }) || null
      : null;
    return cachedInitialOffersLine ?? "";
  };
  const withInitialOffersLine = async (text: string) => {
    const offersLine = await resolveInitialOffersLine();
    if (!offersLine) return text;
    if (text.toLowerCase().includes(offersLine.toLowerCase())) return text;
    if (/current offers?:\s*https?:\/\//i.test(text)) return text;
    return `${text} ${offersLine}`.trim();
  };
  const maybeAddInitialCallTodo = () => {
    if (!isInitialAdf) return;
    if (callbackRequestedInLead) {
      addTodo(
        conv,
        "call",
        callbackSummary,
        event.providerMessageId,
        undefined,
        callbackSchedule
      );
      if (suppressInitialAutoDraftForTimedCallback && conv.followUp?.mode !== "manual_handoff") {
        setFollowUpMode(conv, "manual_handoff", "callback_requested");
        stopFollowUpCadence(conv, "manual_handoff");
      }
      return;
    }
    addCallTodoIfMissing(conv, "Call customer (initial reply sent).");
  };
  const prefersPhoneOnly = conv.lead?.preferredContactMethod === "phone";
  const prefersEmailOnly = conv.lead?.preferredContactMethod === "email";
  const systemMode = getSystemMode();
  if (prefersPhoneOnly) {
    setContactPreference(conv, "call_only");
  }
  const queueInitialDraftForPreferredContact = (text: string, mediaUrls?: string[]) => {
    if (suppressInitialAutoDraftForTimedCallback) {
      return;
    }
    if (prefersPhoneOnly) {
      addCallTodoIfMissing(conv, "Preferred contact method is phone. Call customer (no auto text/email).");
      // In Suggest mode, still surface a draft so staff can review/send manually.
      if (systemMode === "suggest") {
        appendOutbound(conv, "dealership", leadKey, text, "draft_ai", undefined, mediaUrls);
      }
      return;
    }
    if (prefersEmailOnly) {
      setEmailDraft(conv, text);
      return;
    }
    appendOutbound(conv, "dealership", leadKey, text, "draft_ai", undefined, mediaUrls);
  };
  if (suppressInitialAutoDraftForTimedCallback) {
    addTodo(
      conv,
      "call",
      callbackSummary,
      event.providerMessageId,
      undefined,
      callbackSchedule
    );
    setFollowUpMode(conv, "manual_handoff", "callback_requested");
    stopFollowUpCadence(conv, "manual_handoff");

    const users = await getUsersForOwnerRouting();
    const ownerId = String(conv.leadOwner?.id ?? "").trim();
    const owner =
      users.find(u => String(u?.id ?? "").trim() === ownerId) ?? null;
    const ownerName =
      String(owner?.name ?? "").trim() ||
      String(owner?.firstName ?? "").trim() ||
      String(conv.leadOwner?.name ?? "").trim() ||
      "sales team";
    const ownerPhone = pickUserPhone(owner);
    const customerName =
      [conv.lead?.firstName, conv.lead?.lastName].filter(Boolean).join(" ").trim() ||
      conv.leadKey ||
      "customer";
    const ownerSummary = [
      `Callback requested for ${customerName}.`,
      callbackTimeHint ? `Requested time: ${callbackTimeHint}.` : null,
      conv.lead?.phone ? `Customer phone: ${conv.lead.phone}` : null,
      conv.lead?.leadRef ? `Lead Ref: ${conv.lead.leadRef}` : null
    ]
      .filter(Boolean)
      .join("\n");
    const staffSms = await sendInternalSalespersonSms(ownerPhone, ownerSummary);
    if (!staffSms.sent) {
      addTodo(
        conv,
        "note",
        `Owner SMS failed for ${ownerName}: ${staffSms.reason ?? "unknown_error"}.`,
        event.providerMessageId
      );
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
      note: "timed_callback_todo_only"
    });
  }
  if (isInitialAdf && prefersPhoneOnly && systemMode !== "suggest") {
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
      note: "preferred_contact_phone_no_auto_reply"
    });
  }

  const isRiderToRiderFinanceLead =
    isRiderToRiderFinanceLeadSource(leadSource) ||
    isRiderToRiderFinanceLeadSource(conv.lead?.source) ||
    isRiderToRiderFinanceLeadSource(lead.inquiry) ||
    isRiderToRiderFinanceLeadSource(lead.comment) ||
    isRiderToRiderFinanceLeadSource(event.body);
  if (isRiderToRiderFinanceLead) {
    const profile = await getDealerProfile();
    const firstName = normalizeDisplayCase(conv.lead?.firstName);
    const dealerOffersProgram = dealerOffersRiderToRiderFinancing(profile);
    let ack = buildRiderToRiderFinanceLeadReply({
      firstName,
      isInitialAdf,
      dealerOffersProgram
    });
    if (isInitialAdf) {
      ack = await applyInitialAdfPrefix(ack);
    }
    ack = withInitialAvailabilityLine(ack);
    if (dealerOffersProgram) {
      addTodo(conv, "approval", event.body ?? "Rider to Rider financing inquiry", event.providerMessageId);
      setFollowUpMode(conv, "manual_handoff", "credit_app");
      stopFollowUpCadence(conv, "manual_handoff");
    }
    queueInitialDraftForPreferredContact(ack);
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
      draft: ack,
      note: dealerOffersProgram
        ? "rider_to_rider_financing_handoff"
        : "rider_to_rider_financing_not_offered"
    });
  }

  if (isServiceLead) {
    let ack =
      "Thanks — I’ve received your service request. I’ll have our service department reach out shortly.";
    ack = await applyInitialAdfPrefix(ack);
    ack = withInitialPhoto(ack);
    ack = withInitialAvailabilityLine(ack);
    const users = await listUsers();
    const ownerId = String(conv.leadOwner?.id ?? "").trim();
    const leadOwner = users.find(u => String(u?.id ?? "").trim() === ownerId) ?? null;
    const serviceOwner = pickUserForRole(users, "service", vendorContactName);
    const serviceTodoOwner = serviceOwner
      ? {
          id: String(serviceOwner.id ?? "").trim(),
          name:
            String(serviceOwner.name ?? "").trim() ||
            String(serviceOwner.firstName ?? "").trim() ||
            "Service"
        }
      : { id: "", name: "Service Department" };
    const notifyOwner = serviceOwner ?? leadOwner;
    const ownerName =
      String(notifyOwner?.name ?? "").trim() ||
      String(notifyOwner?.firstName ?? "").trim() ||
      String(conv.leadOwner?.name ?? "").trim() ||
      "service team";
    const ownerPhone = pickUserPhone(notifyOwner);
    conv.dialogState = { name: "service_handoff", updatedAt: new Date().toISOString() };
    addTodo(conv, "service", event.body, event.providerMessageId, serviceTodoOwner);
    if (callbackRequestedInLead) {
      const callbackTodoOwner = serviceTodoOwner;
      addTodo(
        conv,
        "call",
        callbackSummary,
        event.providerMessageId,
        callbackTodoOwner,
        callbackSchedule
      );
      const customerName =
        [conv.lead?.firstName, conv.lead?.lastName].filter(Boolean).join(" ").trim() ||
        conv.leadKey ||
        "customer";
      const ownerSummary = [
        `Service lead callback requested for ${customerName}.`,
        callbackTimeHint ? `Requested time: ${callbackTimeHint}.` : null,
        conv.lead?.phone ? `Customer phone: ${conv.lead.phone}` : null,
        conv.lead?.leadRef ? `Lead Ref: ${conv.lead.leadRef}` : null
      ]
        .filter(Boolean)
        .join("\n");
      const staffSms = await sendInternalSalespersonSms(ownerPhone, ownerSummary);
      if (!staffSms.sent) {
        addTodo(
          conv,
          "note",
          `Owner SMS failed for ${ownerName}: ${staffSms.reason ?? "unknown_error"}.`,
          event.providerMessageId
        );
      }
    }
    setFollowUpMode(conv, "manual_handoff", "service_request");
    stopFollowUpCadence(conv, "manual_handoff");
    queueInitialDraftForPreferredContact(ack, initialMediaUrls);
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

  if (isPartsLead || isApparelLead) {
    const departmentRole = isPartsLead ? "parts" : "apparel";
    let ack = isPartsLead
      ? "Thanks — I’ve received your parts request. I’ll have our parts department reach out shortly."
      : "Thanks — I’ve received your apparel request. I’ll have our apparel team reach out shortly.";
    ack = await applyInitialAdfPrefix(ack);
    const users = await listUsers();
    const ownerId = String(conv.leadOwner?.id ?? "").trim();
    const leadOwner = users.find(u => String(u?.id ?? "").trim() === ownerId) ?? null;
    const departmentOwner = pickUserForRole(users, departmentRole, vendorContactName);
    const departmentTodoOwner = departmentOwner
      ? {
          id: String(departmentOwner.id ?? "").trim(),
          name:
            String(departmentOwner.name ?? "").trim() ||
            String(departmentOwner.firstName ?? "").trim() ||
            (departmentRole === "parts" ? "Parts" : "Apparel")
        }
      : { id: "", name: departmentRole === "parts" ? "Parts Department" : "Apparel Department" };
    const notifyOwner = departmentOwner ?? leadOwner;
    const ownerName =
      String(notifyOwner?.name ?? "").trim() ||
      String(notifyOwner?.firstName ?? "").trim() ||
      String(conv.leadOwner?.name ?? "").trim() ||
      (departmentRole === "parts" ? "parts team" : "apparel team");
    const ownerPhone = pickUserPhone(notifyOwner);
    conv.dialogState = { name: `${departmentRole}_handoff`, updatedAt: new Date().toISOString() };
    addTodo(
      conv,
      departmentRole,
      event.body ?? `${departmentRole} request`,
      event.providerMessageId,
      departmentTodoOwner
    );
    if (callbackRequestedInLead) {
      addTodo(
        conv,
        "call",
        callbackSummary,
        event.providerMessageId,
        departmentTodoOwner,
        callbackSchedule
      );
      const customerName =
        [conv.lead?.firstName, conv.lead?.lastName].filter(Boolean).join(" ").trim() ||
        conv.leadKey ||
        "customer";
      const ownerSummary = [
        `${departmentRole === "parts" ? "Parts" : "Apparel"} lead callback requested for ${customerName}.`,
        callbackTimeHint ? `Requested time: ${callbackTimeHint}.` : null,
        conv.lead?.phone ? `Customer phone: ${conv.lead.phone}` : null,
        conv.lead?.leadRef ? `Lead Ref: ${conv.lead.leadRef}` : null
      ]
        .filter(Boolean)
        .join("\n");
      const staffSms = await sendInternalSalespersonSms(ownerPhone, ownerSummary);
      if (!staffSms.sent) {
        addTodo(
          conv,
          "note",
          `Owner SMS failed for ${ownerName}: ${staffSms.reason ?? "unknown_error"}.`,
          event.providerMessageId
        );
      }
    }
    setFollowUpMode(conv, "manual_handoff", `${departmentRole}_request`);
    stopFollowUpCadence(conv, "manual_handoff");
    queueInitialDraftForPreferredContact(ack, initialMediaUrls);
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
    let ack = isPrequalLead
      ? isInitialAdf
        ? "Thanks — I received your pre-qualification submission. I’ll have our finance team reach out shortly to review options."
        : firstName
          ? `Thanks ${firstName} — we just received your pre-qualification submission. Our finance team will reach out shortly to review options and next steps.`
          : "Thanks — we just received your pre-qualification submission. Our finance team will reach out shortly to review options and next steps."
      : isInitialAdf
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
    queueInitialDraftForPreferredContact(ack);
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
  const isWalkInLead =
    isTrafficLogWalkInLead ||
    (inferredBucket === "in_store" && (isExplicitWalkInLeadSource || walkInSignalHint));
  if (isWalkInLead) {
    initialMedia = undefined;
    initialMediaUrls = undefined;
    const profile = await getDealerProfile();
    const dealerName = profile?.dealerName ?? "American Harley-Davidson";
    const agentName = profile?.agentName ?? "Brooke";
    const firstName = normalizeDisplayCase(conv.lead?.firstName) || "there";
    if (conv.lead) conv.lead.walkIn = true;
    if (!conv.dialogState?.name || conv.dialogState.name === "none" || conv.dialogState.name === "inventory_init") {
      conv.dialogState = { name: "walk_in_active", updatedAt: new Date().toISOString() } as any;
    }
    const vendorFirst = vendorContactName.split(/\s+/).filter(Boolean)[0] || "";
    const rawSalespersonFromComment = extractExplicitSalespersonName(walkInRawComment);
    const salespersonFirst = pickFirstToken(rawSalespersonFromComment);
    const allowWalkInVendorOwnerFallback =
      !isExplicitWalkInLeadSource || isTrafficLogProPayloadHint || !!salespersonFirst;
    const ownerToken = salespersonFirst || (allowWalkInVendorOwnerFallback ? vendorFirst.toLowerCase() : "");
    if (ownerToken) {
      try {
        const users = await listUsers();
        const currentOwnerId = String(conv.leadOwner?.id ?? "").trim();
        const currentOwner =
          users.find(u => String(u.id ?? "").trim() === currentOwnerId) ?? null;
        const currentOwnerIsManager = !!currentOwner && currentOwner.role === "manager";
        const owner = users.find(u => {
          if (u.role !== "salesperson" && u.role !== "manager") return false;
          const first = String(u.firstName ?? "").trim().toLowerCase();
          const nameFirst = String(u.name ?? "")
            .trim()
            .split(/\s+/)
            .filter(Boolean)[0]
            ?.toLowerCase();
          return first === ownerToken || nameFirst === ownerToken;
        });
        if (owner && (!currentOwnerId || currentOwnerIsManager)) {
          conv.leadOwner = {
            id: owner.id,
            name: owner.name ?? owner.firstName ?? owner.email ?? ownerToken,
            assignedAt: new Date().toISOString()
          };
        }
      } catch (e) {
        console.warn("[sendgrid inbound] walk-in owner resolve failed:", (e as any)?.message ?? e);
      }
    }
    const leadOwnerName = String(conv.leadOwner?.name ?? "").trim();
    const leadOwnerFirst = leadOwnerName ? leadOwnerName.split(/\s+/).filter(Boolean)[0] ?? "" : "";
    const salespersonName =
      leadOwnerFirst || salespersonFirst || (allowWalkInVendorOwnerFallback ? vendorFirst : "") || agentName;
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
    const inquiryModelHint = extractInquiryModelHint(walkInCleanedComment);
    const watchDirectiveModelHint = extractWatchDirectiveModelHint(walkInCleanedComment);
    const modelLabel =
      watchDirectiveModelHint ||
      parserModel ||
      inquiryModelHint ||
      walkInModelHint ||
      normalizeVehicleModel(String(modelRaw ?? ""), conv.lead?.vehicle?.make ?? null);
    const hasWatchIntentFromParser =
      !!llmIntent &&
      llmIntent.intent === "availability" &&
      llmIntent.explicitRequest === true &&
      Number(llmIntent.confidence ?? 0) >= intentConfidenceMin;
    const watchDirectiveSegment = extractWatchDirectiveSegment(walkInCleanedComment);
    const hasWatchIntentFromText =
      hasWatchIntentPhrase(commentLower) || !!watchDirectiveSegment;
    const hasWatchIntent = hasWatchIntentFromParser || hasWatchIntentFromText;
    const pricingFollowupIntentFromParser = pricingInquiryIntentFromParser;
    const pricingFollowupIntentFromText =
      /\b(follow up|follow-up|check in|circle back|touch base)\b[\s\S]{0,40}\b(pricing|price|numbers?)\b/i.test(
        walkInCleanedComment
      ) ||
      /\b(pricing|price|numbers?)\b[\s\S]{0,40}\b(follow up|follow-up|check in|circle back|touch base)\b/i.test(
        walkInCleanedComment
      );
    const hasPricingFollowupIntent = pricingFollowupIntentFromParser || pricingFollowupIntentFromText;
    const trafficLogProStep =
      isTrafficLogProPayloadHint || isExplicitWalkInLeadSource || inferredBucket === "in_store"
        ? extractTrafficLogProStep(walkInCleanedComment)
        : null;
    const lowSignalWalkInUpdate =
      !walkInCleanedComment ||
      /^(email updates?|email opt-?in|view lead|step\s*\d+|n\/?a|na)$/i.test(walkInCleanedComment.trim());
    const watchSourceText =
      hasWatchIntent && watchDirectiveSegment
        ? watchDirectiveSegment
        : lead.comment ?? lead.inquiry ?? "";
    const requestedConditionHint = inferWalkInRequestedCondition(
      hasWatchIntent && watchDirectiveSegment ? watchDirectiveSegment : walkInCleanedComment
    );
    const wantsUsed = requestedConditionHint === "used";
    const wantsNew = requestedConditionHint === "new";
    const walkInReminderRequest = extractWalkInReminderRequest(walkInCleanedComment);
    const parserYearRange =
      inventoryEntityAccepted &&
      llmInventoryEntities?.yearMin &&
      llmInventoryEntities?.yearMax
        ? {
            min: Math.min(llmInventoryEntities.yearMin, llmInventoryEntities.yearMax),
            max: Math.max(llmInventoryEntities.yearMin, llmInventoryEntities.yearMax)
          }
        : null;
    const regexWatchYearRange = extractYearRangeFromText(watchSourceText);
    const yearRange = regexWatchYearRange ?? parserYearRange;
    const singleYear =
      !yearRange
        ? extractSingleYearFromText(watchSourceText) ??
          (inventoryEntityAccepted ? (llmInventoryEntities?.year ?? undefined) : undefined)
        : undefined;
    const regexPriceRange = extractPriceRangeFromText(watchSourceText);
    const priceRange =
      regexPriceRange ??
      (inventoryEntityAccepted &&
      (llmInventoryEntities?.minPrice || llmInventoryEntities?.maxPrice)
        ? {
            minPrice: llmInventoryEntities?.minPrice ?? undefined,
            maxPrice: llmInventoryEntities?.maxPrice ?? undefined
          }
        : null);
    const desiredColor =
      extractColorFromText(watchSourceText) ??
      (inventoryEntityAccepted ? llmInventoryEntities?.color ?? undefined : undefined);
    const desiredTrim =
      extractTrimFromText(watchSourceText) ??
      (inventoryEntityAccepted ? llmInventoryEntities?.trim ?? undefined : undefined);
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
      conv.lead.walkInStep = trafficLogProStep ?? undefined;
      conv.lead.walkInCommentCapturedAt = new Date().toISOString();
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
    const hasDealFinalizingSignal = walkInState === "deal_finalizing";
    const hasDepositSignal = walkInState === "deposit_left";
    const hasSoldSignal = walkInState === "sold_delivered";
    const hasCreditCosignerSignal = walkInState === "cosigner_required";
    const hasCompletedTestRideSignal = walkInState === "test_ride_completed";
    const hasDecisionPendingSignal = walkInState === "decision_pending";
    const hasOutsideFinancingPendingSignal = walkInState === "outside_financing_pending";
    const hasDownPaymentPendingSignal = walkInState === "down_payment_pending";
    const hasTradeEquityPendingSignal = walkInState === "trade_equity_pending";
    const hasTimingDeferWindowSignal = walkInState === "timing_defer_window";
    const hasHouseholdApprovalPendingSignal = walkInState === "household_approval_pending";
    const hasDocsOrInsurancePendingSignal = walkInState === "docs_or_insurance_pending";
    const hasHoldSignal = walkInState === "hold_requested";
    const hasResumeHoldSignal = walkInState === "hold_cleared";
    const walkInOutcomeNeedsReview =
      !!llmWalkInOutcome &&
      !walkInOutcomeAccepted &&
      llmWalkInOutcome.explicitState &&
      llmWalkInOutcome.state !== "none";
    if (walkInOutcomeNeedsReview) {
      addTodo(
        conv,
        "note",
        `Walk-in outcome parser below confidence threshold (${walkInOutcomeConfidence.toFixed(2)} < ${walkInOutcomeConfidenceMin.toFixed(2)}): ${llmWalkInOutcome.state}`,
        event.providerMessageId
      );
    }
    const hasDealProgressSignal =
      hasDepositSignal || hasSoldSignal || hasDealFinalizingSignal;
    if (walkInReminderRequest && !(hasCreditCosignerSignal || hasDealProgressSignal)) {
      const callbackCfg = await getSchedulerConfig();
      const callbackTz = callbackCfg.timezone || "America/New_York";
      let reminderSchedule = buildCallbackTodoSchedule(walkInReminderRequest.timeHint, callbackTz);
      if (reminderSchedule.dueAt) {
        const dueAtMs = Date.parse(reminderSchedule.dueAt);
        if (Number.isFinite(dueAtMs) && dueAtMs < Date.now() - 60_000) {
          const adjustedHint = walkInReminderRequest.timeHint.replace(
            /\b(\d{1,2})[\/\-](\d{1,2})[\/\-]\d{2,4}\b/g,
            (_m, mm, dd) => {
              const now = new Date();
              let targetYear = now.getFullYear();
              const month = Number(mm);
              const day = Number(dd);
              if (
                Number.isFinite(month) &&
                Number.isFinite(day) &&
                month >= 1 &&
                month <= 12 &&
                day >= 1 &&
                day <= 31
              ) {
                const thisYear = new Date(Date.UTC(targetYear, month - 1, day, 12, 0, 0, 0));
                if (thisYear.getTime() < now.getTime() - 24 * 60 * 60 * 1000) {
                  targetYear += 1;
                }
              }
              return `${mm}/${dd}/${targetYear}`;
            }
          );
          const adjusted = buildCallbackTodoSchedule(adjustedHint, callbackTz);
          if (adjusted.dueAt && adjusted.reminderAt) reminderSchedule = adjusted;
        }
      }
      const reminderSummary = `Reminder requested: ${walkInReminderRequest.actionNote}.`;
      addTodo(
        conv,
        "other",
        reminderSummary,
        event.providerMessageId,
        undefined,
        reminderSchedule,
        "reminder"
      );
    }
    if (hasCreditCosignerSignal) {
      conv.dialogState = { name: "payments_handoff", updatedAt: new Date().toISOString() };
      addTodo(conv, "approval", event.body ?? walkInCleanedComment, event.providerMessageId);
      setFollowUpMode(conv, "manual_handoff", "credit_app_cosigner");
      stopFollowUpCadence(conv, "manual_handoff");
    }
    if (hasDealProgressSignal) {
      conv.dialogState = { name: "schedule_booked", updatedAt: new Date().toISOString() };
      addTodo(conv, "other", event.body ?? walkInCleanedComment, event.providerMessageId);
      setFollowUpMode(
        conv,
        "manual_handoff",
        hasSoldSignal ? "sold_walkin_note" : hasDepositSignal ? "deposit_walkin_note" : "deal_finalizing_walkin_note"
      );
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
    if (!(hasDealProgressSignal || hasCreditCosignerSignal || hasHoldSignal || hasResumeHoldSignal)) {
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
    let tail = "Thanks for the update — I’m here if you need anything.";
    if (hasCreditCosignerSignal) {
      tail = "I saw the credit app note and I’ll have our finance team follow up about the co-signer.";
    } else if (hasDealProgressSignal) {
      tail = hasSoldSignal
        ? "Thanks again — we’ll take it from here and follow up if anything is needed."
        : hasDepositSignal
          ? "Thanks for the deposit note — we’ll follow up with next steps."
          : "Got it — we’ll pick up with finalizing details at your visit.";
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
    } else if (hasPricingFollowupIntent) {
      tail = "I’ll follow up with pricing details and next steps.";
    }
    const walkInTestRideRequested =
      walkInOutcomeAccepted && !!llmWalkInOutcome?.testRideRequested;
    const walkInWeatherSensitive =
      walkInOutcomeAccepted && !!llmWalkInOutcome?.weatherSensitive;
    const walkInFollowUpWindowHint = String(llmWalkInOutcome?.followUpWindowText ?? "").trim();
    const walkInHasNextWeekWindow =
      walkInOutcomeAccepted && /next week/i.test(walkInFollowUpWindowHint);

    if (!hasCompletedTestRideSignal) {
      if (walkInTestRideRequested && walkInWeatherSensitive) {
        tail = "I’ll reach back when the weather looks better and we can line up your test ride.";
      } else if (walkInTestRideRequested && walkInHasNextWeekWindow) {
        tail = "I’ll check back next week and we can line up your test ride.";
      }
    }
    if (
      modelLabel &&
      !hasCompletedTestRideSignal &&
      !hasDealProgressSignal &&
      !hasHoldSignal &&
      !hasResumeHoldSignal
    ) {
      if (wantsUsed) {
        const usedLabel = `used ${rangeLabel}${formatWatchModelForMessage(modelLabel)}`;
        if (hasUsedMatch) {
          tail = `We do have a ${usedLabel} in stock right now — want me to send details?`;
        } else {
          tail = hasWatchIntent
            ? `I’ll keep an eye out for a ${usedLabel} and let you know if one comes in.`
            : `I can help track down a ${usedLabel}. Want me to send options as they come in?`;
        }
      } else if (wantsNew && hasWatchIntent) {
        const newLabel = `new ${rangeLabel}${formatWatchModelForMessage(modelLabel)}`;
        tail = hasNewMatch
          ? `We do have a ${newLabel} in stock right now — want me to send details?`
          : `I’ll keep an eye out for a ${newLabel} and let you know when one comes in.`;
      } else {
        const label = `${rangeLabel}${formatWatchModelForMessage(modelLabel)}`;
        tail = hasWatchIntent
          ? `I’ll keep an eye out for a ${label} and let you know if one comes in.`
          : `I can help with details on ${label} and options when you’re ready.`;
      }
      if (walkInTestRideRequested && walkInWeatherSensitive) {
        const rideLabel = wantsUsed
          ? `used ${rangeLabel}${formatWatchModelForMessage(modelLabel)}`
          : wantsNew
            ? `new ${rangeLabel}${formatWatchModelForMessage(modelLabel)}`
            : `${rangeLabel}${formatWatchModelForMessage(modelLabel)}`;
        tail = `I’ll reach back when the weather looks better and we can line up your test ride on ${rideLabel}.`;
      } else if (walkInTestRideRequested && walkInHasNextWeekWindow) {
        const rideLabel = wantsUsed
          ? `used ${rangeLabel}${formatWatchModelForMessage(modelLabel)}`
          : wantsNew
            ? `new ${rangeLabel}${formatWatchModelForMessage(modelLabel)}`
            : `${rangeLabel}${formatWatchModelForMessage(modelLabel)}`;
        tail = `I’ll check back next week and we can line up your test ride on ${rideLabel}.`;
      }
    }
    if (
      trafficLogProStep &&
      !hasWatchIntent &&
      !hasCompletedTestRideSignal &&
      !hasCreditCosignerSignal &&
      !hasDealProgressSignal &&
      !hasHoldSignal &&
      !hasResumeHoldSignal
    ) {
      const tlpStepTail = buildTrafficLogProWalkInTail({
        step: trafficLogProStep,
        comment: walkInCleanedComment,
        modelLabel,
        hasPricingFollowupIntent
      });
      if (tlpStepTail) {
        tail = tlpStepTail;
      }
    }
    const hasDirectedTestRidePlan = /line up your test ride|reach back when the weather looks better|check back next week/i.test(
      tail
    );
    const buildWalkInAddendum = () => {
      if (!walkInCleanedComment) return "";
      const parserWindow = walkInOutcomeAccepted ? walkInFollowUpWindowHint : "";
      const followUpWindow = parserWindow;
      if (followUpWindow) {
        return `I’ll plan to follow up ${followUpWindow.toLowerCase()}.`;
      }
      if (hasDecisionPendingSignal) {
        return "No rush — I’m here whenever you’re ready.";
      }
      if (walkInTestRideRequested) {
        if (hasDirectedTestRidePlan) return "";
        return "If you want a test ride, just let me know.";
      }
      return "";
    };
    const suppressWalkInAutoAck =
      lowSignalWalkInUpdate ||
      hasCompletedTestRideSignal ||
      hasHoldSignal ||
      hasResumeHoldSignal ||
      hasDealProgressSignal ||
      !!conv.hold ||
      conv.followUp?.mode === "paused_indefinite";

    let walkInWatchSet = false;
    if (modelLabel && hasWatchIntent && !(hasDealProgressSignal || hasCreditCosignerSignal)) {
      const requestedCondition: "new" | "used" | undefined =
        requestedConditionHint === "used"
          ? "used"
          : requestedConditionHint === "new"
            ? "new"
            : undefined;
      const watch: InventoryWatch = {
        model: modelLabel,
        condition: requestedCondition,
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
        note: "walk_in_explicit_watch"
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
      walkInWatchSet = true;
    } else if (hasWatchIntent && !modelLabel && !(hasDealProgressSignal || hasCreditCosignerSignal)) {
      conv.inventoryWatchPending = {
        year: singleYear,
        color: desiredColor,
        minPrice: priceRange?.minPrice,
        maxPrice: priceRange?.maxPrice,
        askedAt: new Date().toISOString()
      };
      conv.dialogState = { name: "inventory_watch_prompted", updatedAt: new Date().toISOString() };
      setFollowUpMode(conv, "holding_inventory", "inventory_watch");
      stopFollowUpCadence(conv, "inventory_watch");
      walkInWatchSet = true;
    }

    if (hasWatchIntent) {
      if (walkInWatchSet && modelLabel) {
        const watchConditionLabel =
          requestedConditionHint === "used"
            ? "used "
            : requestedConditionHint === "new"
              ? "new "
              : "";
        tail = `I’ll keep an eye out for ${watchConditionLabel}${formatWatchModelForMessage(modelLabel)} and let you know if one comes in.`;
      } else if (walkInWatchSet) {
        tail = "I’ll keep an eye out and text you as soon as a good match comes in.";
      }
    }

    const addendum = buildWalkInAddendum();
    const includeDefaultWalkInThanks = !walkInTailHasOwnAcknowledgement(tail);
    const ack =
      `Hi ${firstName} — this is ${salespersonName} at ${dealerName}. ` +
      (includeDefaultWalkInThanks ? "Thanks for stopping in, it was nice chatting with you. " : "") +
      tail +
      (addendum ? ` ${addendum}` : "");

    if (!suppressWalkInAutoAck) {
      queueInitialDraftForPreferredContact(ack, initialMediaUrls);
    }
    if (walkInDelayReason && walkInDelayDays && !hasCreditCosignerSignal && !hasDealProgressSignal) {
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
      !hasDealProgressSignal &&
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
    queueInitialDraftForPreferredContact(ack, initialMediaUrls);
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
  const isMarketplaceContactDealerSource =
    /marketplace/i.test(leadSourceLower) &&
    /(contact\s*a\s*dealer|used\s*mkt|dealer\s*portal|h-?d1)/i.test(leadSourceLower);
  const isPrivatePartyMarketplaceSellLead =
    isMarketplaceContactDealerSource && !/(prequal|credit|coa|finance|apply)/i.test(leadSourceLower);
  const isMarketplaceSell =
    /marketplace/i.test(leadSourceLower) &&
    (/sell/.test(leadSourceLower) || isPrivatePartyMarketplaceSellLead);
  const isSellLead = inferredBucket === "trade_in_sell" || inferredCta === "sell_my_bike";
  if (isInitialAdf && isTradeAcceleratorLead && isSellLead) {
    const profile = await getDealerProfile();
    const dealerName = profile?.dealerName ?? "American Harley-Davidson";
    const agentName = profile?.agentName ?? "Brooke";
    const tradeModel = normalizeVehicleModel(
      conv.lead?.tradeVehicle?.model ??
        conv.lead?.tradeVehicle?.description ??
        conv.lead?.vehicle?.model ??
        conv.lead?.vehicle?.description ??
        "",
      conv.lead?.tradeVehicle?.make ?? conv.lead?.vehicle?.make ?? null
    );
    const tradeYear = conv.lead?.tradeVehicle?.year ?? conv.lead?.vehicle?.year ?? null;
    const bikeLabel = [tradeYear, tradeModel].filter(Boolean).join(" ").trim() || "your bike";
    let ack =
      `Thanks — I got your trade-in request for ${bikeLabel}. ` +
      `This is ${agentName} at ${dealerName}. ` +
      "We can give you a firm number after a quick in-person appraisal. " +
      "What day and time works best to stop in?";
    ack = await applyInitialAdfPrefix(ack);
    addTodo(conv, "other", event.body, event.providerMessageId);
    queueInitialDraftForPreferredContact(ack, initialMediaUrls);
    maybeAddInitialCallTodo();
    setEmailDraft(conv, ack);
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
      conv.lead?.tradeVehicle?.model ??
        conv.lead?.tradeVehicle?.description ??
        conv.lead?.vehicle?.model ??
        conv.lead?.vehicle?.description ??
        "",
      conv.lead?.tradeVehicle?.make ?? conv.lead?.vehicle?.make ?? null
    );
    const sellYear = conv.lead?.tradeVehicle?.year ?? conv.lead?.vehicle?.year ?? null;
    const yearLabel = sellYear ? `${sellYear} ` : "";
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
      if (isPrivatePartyMarketplaceSellLead) {
        ack =
          `Thanks — I got your note about your ${sellLabel}. ` +
          `This is ${agentName} at ${dealerName}. ` +
          "We’re always looking for clean pre-owned motorcycles. " +
          "If you’re open to it, we can do a quick in-person evaluation and either make a purchase offer " +
          "or work up trade-in value. Would you be open to bringing it in?";
      } else {
        ack =
          `Thanks — I got your note about selling your ${sellLabel}. ` +
          `This is ${agentName} at ${dealerName}. ` +
          "We can do a quick in‑person appraisal and give you a firm offer. " +
          "If you’re open to stopping by, what day and time works best?";
      }
      ack = await applyInitialAdfPrefix(ack);
      const bookingUrl = buildBookingUrlForLead(profile?.bookingUrl, conv);
      const bookingLine = bookingUrl
        ? `You can book an appointment here: ${bookingUrl}`
        : "Just reply with a day and time that works for you.";
      const rawName =
        firstName || normalizeDisplayCase(conv.lead?.name) || "there";
      const name = rawName.split(" ")[0] || "there";
      if (isPrivatePartyMarketplaceSellLead) {
        emailDraft =
          `Hi ${name},\n\nThanks for reaching out about your ${sellLabel}. ` +
          `This is ${agentName} at ${dealerName}. ` +
          "We’re always looking for clean pre-owned motorcycles. " +
          "If you’re open to it, we can do a quick in-person evaluation and either make a purchase offer " +
          `or work up trade-in value. ${bookingLine}\n\nThanks,`;
      } else {
        emailDraft =
          `Hi ${name},\n\nThanks for reaching out about selling your ${sellLabel}. ` +
          `This is ${agentName} at ${dealerName}. ` +
          "We can do a quick in‑person appraisal and give you a firm offer. " +
          `If you’d like to stop in, ${bookingLine}\n\nThanks,`;
      }
      if (isPrivatePartyMarketplaceSellLead) {
        const cfg = await getSchedulerConfig();
        const nowIso = new Date().toISOString();
        const firstDue = computeFollowUpDueAt(nowIso, 30, cfg.timezone);
        scheduleLongTermFollowUp(conv, firstDue, "private_party_marketplace_seller", {
          anchorAtIso: nowIso,
          contextTag: "private_party_seller"
        });
        setFollowUpMode(conv, "active", "private_party_seller");
      }
    }
    setEmailDraft(conv, emailDraft);
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
    queueInitialDraftForPreferredContact(ack, initialMediaUrls);
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
    queueInitialDraftForPreferredContact(ack, initialMediaUrls);
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
    queueInitialDraftForPreferredContact(ack, initialMediaUrls);
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

  const faqConfidence =
    typeof llmFaqTopic?.confidence === "number" && Number.isFinite(llmFaqTopic.confidence)
      ? llmFaqTopic.confidence
      : 0;
  const faqConfidenceMin = Number(process.env.LLM_FAQ_TOPIC_CONFIDENCE_MIN ?? 0.8);
  const faqOrderConfidenceMin = Number(process.env.LLM_FAQ_TOPIC_ORDER_CONFIDENCE_MIN ?? 0.7);
  const faqOrderIntentAccepted =
    isInitialAdf &&
    !!llmFaqTopic &&
    llmFaqTopic.explicitRequest === true &&
    faqConfidence >= faqOrderConfidenceMin &&
    (llmFaqTopic.topic === "custom_order" || llmFaqTopic.topic === "factory_order_timing");
  if (faqOrderIntentAccepted) {
    const inquiryCombined = `${effectiveInquiry} ${String(conv.lead?.vehicle?.model ?? "")}`.toLowerCase();
    const asksStreet750 = /\bstreet\s*750\b|\bharley\s*750\b|\b750\b/.test(inquiryCombined);
    setConversationSoftTag(conv, "faq_order_intent", {
      value: llmFaqTopic?.topic === "factory_order_timing" ? "factory_order_timing" : "custom_order",
      source: "faq_parser",
      confidence: faqConfidence,
      ttlMs: 30 * 24 * 60 * 60 * 1000,
      meta: {
        explicitRequest: true,
        asksStreet750,
        initialAdf: true
      }
    });
    let ack =
      llmFaqTopic?.topic === "factory_order_timing"
        ? "Factory orders are usually around 6 to 12 weeks depending on model and build details. If you want, we can map your build and timing now."
        : "Yes — we can place a factory order and spec it with genuine Harley-Davidson options. If you want, we can map your build today.";
    if (asksStreet750) {
      ack =
        "Great question — Harley-Davidson no longer sells the Street 750 new, so we can’t factory-order that model. I can help with similar new options or locate pre-owned Street 750s for you. What matters most to you: price, engine size, or style?";
    }
    ack = await applyInitialAdfPrefix(ack);
    queueInitialDraftForPreferredContact(ack);
    maybeAddInitialCallTodo();
    setEmailDraft(conv, ack);
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

  const orderLexicalFallback =
    isInitialAdf &&
    !faqOrderIntentAccepted &&
    /\b(order|factory order|custom order|special order|build one|build it)\b/i.test(
      String(effectiveInquiry ?? "")
    );
  if (orderLexicalFallback) {
    const inquiryCombined = `${effectiveInquiry} ${String(conv.lead?.vehicle?.model ?? "")}`.toLowerCase();
    const asksStreet750 = /\bstreet\s*750\b|\bharley\s*750\b|\b750\b/.test(inquiryCombined);
    setConversationSoftTag(conv, "faq_order_intent", {
      value: asksStreet750 ? "street_750_order_inquiry" : "custom_order",
      source: "faq_lexical_fallback",
      ttlMs: 14 * 24 * 60 * 60 * 1000,
      meta: {
        asksStreet750,
        initialAdf: true
      }
    });
    let ack =
      "Great question — we can place factory orders on current models, and factory timing is usually around 6 to 12 weeks depending on model/build. If you want, I can map options with you now.";
    if (asksStreet750) {
      ack =
        "Great question — Harley-Davidson no longer sells the Street 750 new, so we can’t factory-order that model. I can help with similar new options or locate pre-owned Street 750s for you. What matters most to you: price, engine size, or style?";
    }
    ack = await applyInitialAdfPrefix(ack);
    queueInitialDraftForPreferredContact(ack);
    maybeAddInitialCallTodo();
    setEmailDraft(conv, ack);
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
    const profile = await getInitialDealerProfile();
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
    ack = await withInitialOffersLine(ack);

    appendOutbound(conv, "dealership", leadKey, ack, "draft_ai", undefined, initialMediaUrls);
    maybeAddInitialCallTodo();
    const emailGreeting = firstName ? `Hi ${firstName},` : "Hi,";
    const offersLine = await resolveInitialOffersLine();
    const emailLines = [
      emailGreeting,
      "",
      "Thanks for your H-D Meta promo offer request.",
      `This is ${agentName} at ${dealerName}.`,
      "I can help with pricing and availability.",
      ...(offersLine ? [offersLine] : []),
      "Which model are you interested in, and do you have a preferred trim or color?"
    ];
    setEmailDraft(
      conv,
      emailLines.join("\n")
    );
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
    queueInitialDraftForPreferredContact(ack);
    maybeAddInitialCallTodo();
    setEmailDraft(conv, ack);
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

  const history = buildEffectiveHistory(conv, 20);
  const weatherStatus = await getDealerWeatherStatusSafe();
  let result: any;
  try {
    result = await orchestrateInbound(event, history, {
      appointment: conv.appointment,
      followUp: conv.followUp,
      lead: conv.lead,
      leadSource: conv.lead?.source ?? null,
      bucket: conv.classification?.bucket ?? null,
      cta: conv.classification?.cta ?? null,
      availabilityIntentHint: availabilityIntentFromParser || hasStockIntent,
      schedulingIntentHint: scheduleIntentFromParser || forcedTestRide,
      pricingIntentHint: pricingInquiryIntent,
      financeIntentHint: pricingInquiryIntent,
      pricingAttempts: getPricingAttempts(conv),
      allowSchedulingOffer: true,
      weather: weatherStatus,
      agentNameOverride: String(conv?.manualSender?.userName ?? "").trim() || undefined
    });
  } catch (error: any) {
    console.error("[sendgrid inbound] orchestrator failed:", error?.message ?? error);
    result = {
      intent: "GENERAL",
      stage: "ENGAGED",
      shouldRespond: true,
      draft: "Thanks — I got your inquiry. I’ll follow up shortly.",
      requestedTime: null,
      requestedAppointmentType: null,
      handoff: { required: false, reason: null, ack: "" },
      autoClose: null,
      pricingAttempted: false
    };
  }
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
    ack = await withInitialOffersLine(ack);
    if (!creditTodoCreated) {
      addTodo(conv, reason, event.body, event.providerMessageId);
    }
    setFollowUpMode(conv, "manual_handoff", `handoff:${reason}`);
    stopFollowUpCadence(conv, "manual_handoff");
    if (reason === "pricing" || reason === "payments") {
      markPricingEscalated(conv);
    }
    queueInitialDraftForPreferredContact(ack, initialMediaUrls);
    maybeAddInitialCallTodo();
    setEmailDraft(conv, ack);
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
    ack = await withInitialOffersLine(ack);
    closeConversation(conv, result.autoClose.reason);
    queueInitialDraftForPreferredContact(ack, initialMediaUrls);
    maybeAddInitialCallTodo();
    setEmailDraft(conv, ack);
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
    setEmailDraft(
      conv,
      buildInitialEmailDraft(conv, profile, inventoryNote, buildInventoryAvailable, {
        testRideInventoryStatus: initialAvailability
      })
    );
  } else {
    setEmailDraft(conv, result.draft);
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

          queueInitialDraftForPreferredContact(confirmText);
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

  const dealerProfile = await getInitialDealerProfile();
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
    } else if (initialAvailability === "on_hold") {
      draft = `Thanks — that unit is currently on hold. If it frees up, I can text you right away. If you still want to come by ${dayPhrase}, what time works best?`;
    } else if (initialAvailability === "sold") {
      draft = `Thanks — that specific unit is no longer available, but I can help with similar options. If you still want to come by ${dayPhrase}, what time works best?`;
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
    } else if (initialAvailability === "on_hold") {
      draft =
        `Thanks for your inquiry about the ${bikeLabel}. ` +
        "That unit is currently on hold, but I can text you first if it frees up.";
    } else if (initialAvailability === "sold") {
      draft =
        `Thanks for your inquiry about the ${bikeLabel}. ` +
        "That unit is no longer available, but I can help with similar options if you want.";
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
    suppressAvailabilityAppend = true;
  }
  if (
    inferredBucket === "test_ride" &&
    /\b(test ride|demo ride|ride)\b/i.test(inquiryText) &&
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
  if (
    isInitialAdf &&
    /meta/i.test(leadSourceLower) &&
    inferredBucket === "general_inquiry" &&
    typeof draft === "string"
  ) {
    let usedNearTermMetaTemplate = false;
    const modelLabel = normalizeVehicleModel(
      conv.lead?.vehicle?.model ?? conv.lead?.vehicle?.description ?? "",
      conv.lead?.vehicle?.make ?? null
    );
    const monthsStart = conv.lead?.purchaseTimeframeMonthsStart;
    const monthsEnd = conv.lead?.purchaseTimeframeMonthsEnd;
    const rawModelLabel = String(conv.lead?.vehicle?.model ?? "").trim();
    const genericModel = /^(other|full line)$/i.test(rawModelLabel);
    const nearTermWindow =
      typeof monthsStart === "number" && Number.isFinite(monthsStart) && monthsStart >= 0 && monthsStart <= 3;
    const buildNearTermInvite = (subject: string): string => {
      const rideLine = testRideInSeason
        ? " If weather permits, we can line up a test ride too."
        : "";
      return `${subject} Want to set a time to come in and check out bikes?${rideLine}`.trim();
    };
    if (genericModel && nearTermWindow) {
      const timeframeLabel =
        conv.lead?.purchaseTimeframe?.trim() ||
        (typeof monthsEnd === "number" && Number.isFinite(monthsEnd)
          ? `${Math.max(0, Math.round(monthsStart))}-${Math.max(Math.round(monthsStart), Math.round(monthsEnd))} months`
          : "0-3 months");
      draft = buildNearTermInvite(
        `Thanks for reaching out on Facebook. Since you’re shopping in the next ${timeframeLabel}, I can help you narrow down a few strong options.`
      );
      usedNearTermMetaTemplate = true;
    }
    const isFutureWindow = typeof monthsStart === "number" && monthsStart >= 4;
    const asksModel = /which model|what model|model are you interested|bike preference/i.test(draft);
    const hasSoftInvite = /\b(stop in|come in|check (it|them) out|go over options|take a look)\b/i.test(draft);
    const shouldForceNearTermInvite = nearTermWindow && !usedNearTermMetaTemplate;
    if (shouldForceNearTermInvite) {
      const subject = modelLabel
        ? `Great — I can help with ${modelLabel} options and pricing.`
        : "Great — I can help you compare models and pricing.";
      draft = buildNearTermInvite(subject);
      usedNearTermMetaTemplate = true;
    }
    if (!usedNearTermMetaTemplate && (!asksModel || !hasSoftInvite || isFutureWindow)) {
      const modelQuestion = modelLabel
        ? `Are you leaning toward a specific ${modelLabel}, or still comparing?`
        : "Do you have a bike preference, or are you still comparing models?";
      const timeframeNote = isFutureWindow
        ? "Even if you’re a few months out, you’re welcome to stop in anytime to check bikes out and go over options."
        : "You’re welcome to stop in anytime to check bikes out and go over options.";
      draft = `${modelQuestion} ${timeframeNote}`;
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
  draft = await withInitialOffersLine(draft);

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
        const emailBody = toEmailStyledBody(draft, conv);
        const signed =
          signature
            ? `${emailBody}\n\n${signature}${dealerProfile?.logoUrl ? `\n\n${dealerProfile.logoUrl}` : ""}`
            : appendFallbackEmailSignoff(emailBody, dealerProfile);
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
        queueInitialDraftForPreferredContact(draft, initialMediaUrls);
        maybeAddInitialCallTodo();
      }
    } else {
      queueInitialDraftForPreferredContact(draft, initialMediaUrls);
      maybeAddInitialCallTodo();
    }
  } else {
    // Store the draft as an outbound message (suggest-only for now)
    queueInitialDraftForPreferredContact(draft, initialMediaUrls);
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
  const storedMonthsStart = Number(conv.lead?.purchaseTimeframeMonthsStart);
  const parsedTimeframe = parseTimeframeMonths(conv.lead?.purchaseTimeframe);
  const monthsStart = Number.isFinite(storedMonthsStart) && storedMonthsStart > 0
    ? storedMonthsStart
    : Number(parsedTimeframe?.start ?? NaN);
  const hasLongTermTimeframe = Number.isFinite(monthsStart) && monthsStart >= 1;
  const hasExistingCadence =
    conv.followUpCadence?.status === "active" || conv.followUpCadence?.status === "stopped";
  const existingCadenceKind = String(conv.followUpCadence?.kind ?? "").toLowerCase();
  const shouldForceRideChallengeCadence =
    isRideChallengeLead && conv.classification?.bucket !== "event_promo" && conv.status !== "closed";
  if (shouldForceRideChallengeCadence) {
    await applyRideChallengeReminderCadence();
  }
  const canRealignExistingCadenceToLongTerm =
    hasExistingCadence &&
    existingCadenceKind !== "post_sale" &&
    existingCadenceKind !== "long_term" &&
    !conv.appointment?.bookedEventId &&
    conv.followUp?.mode !== "manual_handoff" &&
    conv.followUp?.mode !== "paused_indefinite" &&
    conv.classification?.bucket !== "finance_prequal" &&
    conv.classification?.bucket !== "service" &&
    conv.classification?.bucket !== "event_promo" &&
    conv.classification?.cta !== "hdfs_coa" &&
    conv.classification?.cta !== "prequalify" &&
    !notReadyTimeframe &&
    !shouldForceRideChallengeCadence;
  if (canRealignExistingCadenceToLongTerm && hasLongTermTimeframe) {
    const due = new Date();
    due.setMonth(due.getMonth() + Math.max(1, Math.round(monthsStart)));
    due.setHours(10, 30, 0, 0);
    const msg = buildLongTermMessage(conv.lead?.purchaseTimeframe, conv.lead?.hasMotoLicense);
    scheduleLongTermFollowUp(conv, due.toISOString(), msg);
  }
  const shouldStartCadence =
    !hasExistingCadence &&
    !conv.appointment?.bookedEventId &&
    conv.followUp?.mode !== "manual_handoff" &&
    conv.followUp?.mode !== "paused_indefinite" &&
    conv.classification?.bucket !== "finance_prequal" &&
    conv.classification?.bucket !== "service" &&
    conv.classification?.bucket !== "event_promo" &&
    conv.classification?.cta !== "hdfs_coa" &&
    conv.classification?.cta !== "prequalify" &&
    !notReadyTimeframe &&
    !shouldForceRideChallengeCadence;
  if (shouldStartCadence) {
    const cfg = await getSchedulerConfig();
    if (hasLongTermTimeframe) {
      const due = new Date();
      due.setMonth(due.getMonth() + Math.max(1, Math.round(monthsStart)));
      due.setHours(10, 30, 0, 0);
      const msg = buildLongTermMessage(conv.lead?.purchaseTimeframe, conv.lead?.hasMotoLicense);
      scheduleLongTermFollowUp(conv, due.toISOString(), msg);
    } else {
      startFollowUpCadence(conv, new Date().toISOString(), cfg.timezone);
    }
  } else if (notReadyTimeframe && !shouldForceRideChallengeCadence) {
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
