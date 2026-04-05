import "dotenv/config";
import express from "express";
import cors from "cors";
import twilio from "twilio";
import multer from "multer";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import OpenAI from "openai";
import { orchestrateInbound } from "./domain/orchestrator.js";
import {
  classifySchedulingIntent,
  classifyCadenceContextWithLLM,
  classifyEmpathyNeedWithLLM,
  classifyComplimentWithLLM,
  summarizeSalespersonNoteWithLLM,
  parseBookingIntentWithLLM,
  parseInventoryEntitiesWithLLM,
  parseIntentWithLLM,
  parsePricingPaymentsIntentWithLLM,
  parseDialogActWithLLM,
  parseCustomerDispositionWithLLM,
  parseResponseControlWithLLM,
  parseJourneyIntentWithLLM,
  parseConversationStateWithLLM,
  parseStaffOutcomeUpdateWithLLM,
  parseUnifiedSemanticSlotsWithLLM,
  parseSemanticSlotsWithLLM,
  parseTradePayoffWithLLM,
  summarizeVoiceTranscriptWithLLM
} from "./domain/llmDraft.js";
import type {
  ConversationStateParse,
  CustomerDispositionParse,
  JourneyIntentParse,
  SemanticSlotParse,
  TradePayoffParse
} from "./domain/llmDraft.js";
import type { InboundMessageEvent } from "./domain/types.js";
import { sendgridInboundMiddleware, handleSendgridInbound } from "./routes/sendgridInbound.js";
import { resolveInventoryUrlByStock } from "./domain/inventoryUrlResolver.js";
import { checkInventorySalePendingByUrl } from "./domain/inventoryChecker.js";
import { getDealerProfile, saveDealerProfile } from "./domain/dealerProfile.js";
import {
  getDealerWeatherStatus,
  getWeatherConfig,
  resolveDealerLatLon,
  getDealerDailyForecast,
  getDealerDailyForecasts
} from "./domain/weather.js";
import type { DailyForecast } from "./domain/weather.js";
import { resolveTownNearestDealer, formatTownLabel } from "./domain/geo.js";
import { getDataDir } from "./domain/dataDir.js";
import { getModelSpecs, buildSpecsSummary, buildGlanceSummary } from "./domain/specsScraper.js";
import {
  getModelsByYear,
  getModelsForYear,
  getModelsForYearRange,
  getAllModels,
  isModelInRecentYears
} from "./domain/modelsByYear.js";
import { modelHasFinishOptions } from "./domain/msrpPriceList.js";
import {
  computeFollowUpDueAt,
  computePostSaleDueAt,
  FOLLOW_UP_DAY_OFFSETS,
  LONG_TERM_DAY_OFFSETS,
  POST_SALE_DAY_OFFSETS,
  inferWalkIn,
  startPostSaleCadence
} from "./domain/conversationStore.js";
import { getSchedulerConfig, saveSchedulerConfig, dayKey, getPreferredSalespeople } from "./domain/schedulerConfig.js";
import {
  getOAuthClient,
  saveTokens,
  getAuthedCalendarClient,
  queryFreeBusy,
  insertEvent,
  updateEvent,
  updateEventDetails,
  listEvents,
  createCalendar,
  createRecurringBlock,
  deleteEvent,
  moveEvent
} from "./domain/googleCalendar.js";
import {
  generateCandidateSlots,
  expandBusyBlocks,
  pickSlotsForSalesperson,
  findExactSlotForSalesperson,
  formatSlotLocal,
  localPartsToUtcDate
} from "./domain/schedulerEngine.js";
import {
  extractImageDate,
  findInventoryMatches,
  findInventoryPrice,
  getInventoryFeed,
  hasInventoryForModelYear
} from "./domain/inventoryFeed.js";
import { listInventoryNotes, setInventoryNote } from "./domain/inventoryNotes.js";
import {
  listInventoryHolds,
  getInventoryHold,
  setInventoryHold,
  clearInventoryHold,
  normalizeInventoryHoldKey
} from "./domain/inventoryHolds.js";
import {
  listInventorySolds,
  setInventorySold,
  normalizeInventorySoldKey
} from "./domain/inventorySolds.js";
import { sendEmail } from "./domain/emailSender.js";
import {
  canApplyDispositionCloseout,
  isDispositionParserAccepted,
  isResponseControlParserAccepted
} from "./domain/transitionSafety.js";
import { pickRegenerateInbound } from "./domain/regenerateSelection.js";
import { applyDraftStateInvariants } from "./domain/draftStateInvariants.js";
import {
  DEALER_RIDE_NO_PURCHASE_SKIP_DRAFT,
  nextActionFromState
} from "./domain/routeStateReducer.js";

import {
  upsertConversationByLeadKey,
  createConversationForLeadKey,
  appendInbound,
  isDuplicateInboundEvent,
  appendOutbound,
  listConversations,
  getConversation,
  getLatestPendingDraft,
  updateHoldingFromInbound,
  markAppointmentAcknowledged,
  setLastSuggestedSlots,
  confirmAppointmentIfMatchesSuggested,
  setRequestedTime,
  parseRequestedDayTime,
  startFollowUpCadence,
  pauseFollowUpCadence,
  stopFollowUpCadence,
  scheduleLongTermFollowUp,
  advanceFollowUpCadence,
  getAllConversations,
  findConversationsByLeadKey,
  finalizeDraftAsSent,
  discardPendingDrafts,
  addTodo,
  addCallTodoIfMissing,
  listOpenTodos,
  addInternalQuestion,
  listOpenQuestions,
  markQuestionDone,
  markTodoDone,
  markOpenTodosDoneForConversation,
  deleteConversation,
  setFollowUpMode,
  incrementPricingAttempt,
  markPricingEscalated,
  getPricingAttempts,
  closeConversation,
  mergeConversationLead,
  setConversationMode,
  setContactPreference,
  registerScheduleInviteSent,
  updateConversationContact,
  setCrmLastLoggedAt,
  setVoiceContext,
  getActiveVoiceContext,
  setMemorySummary,
  flushConversationStore,
  reloadConversationStore,
  saveConversation,
  getConversationStorePath,
  type Conversation,
  type InventoryWatch,
  type InventoryWatchPending,
  type DialogStateName
} from "./domain/conversationStore.js";
import { logTuningRow } from "./domain/tuningLogger.js";
import {
  addSuppression,
  isSuppressed,
  listSuppressions,
  removeSuppression
} from "./domain/suppressionStore.js";
import { tlpLogCustomerContact, tlpMarkDealershipVisitDelivered } from "./connectors/crm/tlpPlaywright.js";
import { listContacts, upsertContact, updateContact, deleteContact } from "./domain/contactsStore.js";
import {
  listContactLists,
  getContactList,
  createContactList,
  updateContactList,
  addContactsToList,
  deleteContactList
} from "./domain/contactListsStore.js";
import { isLikelyVoicemailTranscript, maybeMarkEngagedFromCall } from "./domain/engagement.js";

import { getSystemMode, setSystemMode, type SystemMode } from "./domain/settingsStore.js";
import {
  listUsers,
  createUser,
  updateUser,
  deleteUser,
  verifyPassword,
  createSession,
  getSession,
  deleteSession,
  getUserById,
  hasAnyUsers
} from "./domain/userStore.js";

const isProd = (process.env.NODE_ENV ?? "").toLowerCase() === "production";
if (!process.env.DATA_DIR) {
  console.warn("⚠ DATA_DIR not set. Defaulting to ./data (repo).");
  if (isProd) {
    console.error("❌ Refusing to start in production without DATA_DIR.");
    process.exit(1);
  }
}

const app = express();
const upload = multer({ storage: multer.memoryStorage() });
app.use(cors());
app.use("/uploads", express.static(path.resolve(getDataDir(), "uploads")));

const routeOutcomeCounters = new Map<string, number>();
function recordRouteOutcome(scope: "live" | "regen" | "manual", outcome: string, detail?: Record<string, unknown>) {
  if (process.env.DEBUG_DECISION_TRACE !== "1") return;
  const normalizedScope = String(scope ?? "live");
  const normalizedOutcome = String(outcome ?? "unknown").trim() || "unknown";
  const key = `${normalizedScope}:${normalizedOutcome}`;
  const count = (routeOutcomeCounters.get(key) ?? 0) + 1;
  routeOutcomeCounters.set(key, count);
  console.log("[route-outcome]", {
    scope: normalizedScope,
    outcome: normalizedOutcome,
    count,
    ...(detail ?? {})
  });
}
app.post(
  "/debug/inbound",
  express.raw({ type: "*/*", limit: "10mb" }),
  (req, res) => {
    const requestId =
      req.header("x-request-id") ||
      req.header("x-correlation-id") ||
      req.header("x-amzn-trace-id") ||
      `dbg_${Math.random().toString(36).slice(2, 10)}`;
    const contentType = req.header("content-type") ?? "";
    const contentLength = req.header("content-length") ?? "";
    const rawLength = Buffer.isBuffer(req.body) ? req.body.length : undefined;
    console.log("[debug inbound]", {
      ts: new Date().toISOString(),
      id: requestId,
      method: req.method,
      path: req.originalUrl,
      contentType,
      contentLength,
      rawLength,
      host: req.header("host"),
      userAgent: req.header("user-agent"),
      xForwardedFor: req.header("x-forwarded-for"),
      xForwardedProto: req.header("x-forwarded-proto")
    });
    return res.status(200).send("ok");
  }
);

app.get("/debug/route-outcomes", (req, res) => {
  const counters = [...routeOutcomeCounters.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
  return res.json({
    ok: true,
    enabled: process.env.DEBUG_DECISION_TRACE === "1",
    total: counters.reduce((sum, row) => sum + row.count, 0),
    counters
  });
});

app.post("/debug/route-outcomes/reset", (_req, res) => {
  routeOutcomeCounters.clear();
  return res.json({ ok: true, counters: [] });
});

app.use(express.json({ limit: "30mb" }));
app.use(express.urlencoded({ extended: false, limit: "30mb" }));

const AUTH_DISABLED = (process.env.AUTH_DISABLED ?? "false").toLowerCase() === "true";

function parseCookies(header: string | undefined): Record<string, string> {
  if (!header) return {};
  return header.split(";").reduce((acc, part) => {
    const [k, ...rest] = part.trim().split("=");
    if (!k) return acc;
    acc[k] = decodeURIComponent(rest.join("="));
    return acc;
  }, {} as Record<string, string>);
}

function shouldUpdateMemorySummary(conv: { messages?: any[]; memorySummary?: { messageCount?: number } | undefined }) {
  const messageCount = conv.messages?.length ?? 0;
  const lastCount = conv.memorySummary?.messageCount ?? 0;
  if (!conv.memorySummary) return messageCount >= 4;
  return messageCount - lastCount >= 6;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise;
  let timer: NodeJS.Timeout | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const DEFAULT_LLM_PARSER_TIMEOUT_MS = Number(process.env.LLM_PARSER_TIMEOUT_MS ?? 9000);

async function safeLlmParse<T>(
  label: string,
  run: () => Promise<T>,
  timeoutMs: number = DEFAULT_LLM_PARSER_TIMEOUT_MS
): Promise<T | null> {
  try {
    return await withTimeout(run(), timeoutMs, label);
  } catch (err: any) {
    console.warn(`[llm-parse] ${label} failed:`, err?.message ?? err);
    return null;
  }
}

type HotCacheEntry<T> = {
  value?: T;
  expiresAt: number;
  inFlight?: Promise<T>;
};

type DealerProfileSnapshot = Awaited<ReturnType<typeof getDealerProfile>>;
type SchedulerConfigSnapshot = Awaited<ReturnType<typeof getSchedulerConfig>>;
type InventoryFeedSnapshot = Awaited<ReturnType<typeof getInventoryFeed>>;

const HOT_CACHE_ENABLED = process.env.HOT_READ_CACHE_ENABLED !== "0";
const HOT_CACHE_DEALER_PROFILE_MS = Number(process.env.HOT_CACHE_DEALER_PROFILE_MS ?? 5000);
const HOT_CACHE_SCHEDULER_CONFIG_MS = Number(process.env.HOT_CACHE_SCHEDULER_CONFIG_MS ?? 5000);
const HOT_CACHE_INVENTORY_FEED_MS = Number(process.env.HOT_CACHE_INVENTORY_FEED_MS ?? 3000);
const hotDealerProfileCache: HotCacheEntry<DealerProfileSnapshot> = { expiresAt: 0 };
const hotSchedulerConfigCache: HotCacheEntry<SchedulerConfigSnapshot> = { expiresAt: 0 };
const hotInventoryFeedCache: HotCacheEntry<InventoryFeedSnapshot> = { expiresAt: 0 };
let dynamicInventoryColorPhrases: string[] = [];

async function withHotCache<T>(
  cache: HotCacheEntry<T>,
  ttlMs: number,
  label: string,
  loader: () => Promise<T>
): Promise<T> {
  if (!HOT_CACHE_ENABLED || ttlMs <= 0) {
    return loader();
  }
  const now = Date.now();
  if (cache.value !== undefined && cache.expiresAt > now) {
    return cache.value;
  }
  if (cache.inFlight) {
    return cache.inFlight;
  }
  cache.inFlight = (async () => {
    const t0 = Date.now();
    try {
      const value = await loader();
      cache.value = value;
      cache.expiresAt = Date.now() + ttlMs;
      if (process.env.DEBUG_ROUTE_TIMING === "1") {
        console.log("[route-timing]", { stage: `${label}.load`, ms: Date.now() - t0, cache: "miss" });
      }
      return value;
    } finally {
      cache.inFlight = undefined;
    }
  })();
  return cache.inFlight;
}

async function getDealerProfileHot(): Promise<DealerProfileSnapshot> {
  return withHotCache(hotDealerProfileCache, HOT_CACHE_DEALER_PROFILE_MS, "dealer_profile", () =>
    getDealerProfile()
  );
}

async function getSchedulerConfigHot(): Promise<SchedulerConfigSnapshot> {
  return withHotCache(hotSchedulerConfigCache, HOT_CACHE_SCHEDULER_CONFIG_MS, "scheduler_config", () =>
    getSchedulerConfig()
  );
}

async function getInventoryFeedHot(): Promise<InventoryFeedSnapshot> {
  const items = await withHotCache(hotInventoryFeedCache, HOT_CACHE_INVENTORY_FEED_MS, "inventory_feed", () =>
    getInventoryFeed()
  );
  dynamicInventoryColorPhrases = buildInventoryColorPhrasesFromFeed(items);
  return items;
}

function isPublicPath(pathname: string): boolean {
  return (
    pathname === "/health" ||
    pathname.startsWith("/webhooks/twilio") ||
    pathname.startsWith("/crm/leads/adf/sendgrid") ||
    pathname.startsWith("/public/booking") ||
    pathname.startsWith("/public/appointment") ||
    pathname.startsWith("/public/inventory") ||
    pathname.startsWith("/integrations/google") ||
    pathname.startsWith("/debug/inbound") ||
    pathname.startsWith("/auth/login") ||
    pathname.startsWith("/auth/me")
  );
}

app.use(async (req, res, next) => {
  if (AUTH_DISABLED) return next();
  if (req.path === "/users" && req.method === "POST") {
    const any = await hasAnyUsers();
    if (!any) return next();
  }
  if (isPublicPath(req.path)) return next();
  if (req.path === "/dealer-profile" && req.method === "PUT") {
    console.log("[auth] dealer-profile PUT start");
  }
  const tokenHeader = req.header("x-auth-token") || req.header("authorization")?.replace(/^Bearer\s+/i, "");
  const cookies = parseCookies(req.header("cookie"));
  const token = tokenHeader || cookies.lr_session;
  if (!token) return res.status(401).json({ ok: false, error: "auth required" });
  const session = await getSession(token);
  if (!session) return res.status(401).json({ ok: false, error: "invalid session" });
  const user = await getUserById(session.userId);
  if (!user) return res.status(401).json({ ok: false, error: "user not found" });
  (req as any).user = user;
  if (req.path === "/dealer-profile" && req.method === "PUT") {
    console.log("[auth] dealer-profile PUT user", user.email);
  }
  return next();
});

function requireManager(req: any, res: any, next: any) {
  if (AUTH_DISABLED) return next();
  if (req.user?.role !== "manager") return res.status(403).json({ ok: false, error: "manager required" });
  return next();
}

function requirePermission(key: "canEditAppointments" | "canToggleHumanOverride" | "canAccessTodos" | "canAccessSuppressions") {
  return (req: any, res: any, next: any) => {
    if (AUTH_DISABLED) return next();
    if (req.user?.role === "manager") return next();
    if (req.user?.permissions?.[key]) return next();
    return res.status(403).json({ ok: false, error: "forbidden" });
  };
}

type DepartmentRole = "service" | "parts" | "apparel";

const SERVICE_DEPARTMENT_RE =
  /\b(service|inspection|oil change|3[- ]hole|maintenance|repair|service department|service writer|warranty work|state inspection|headlight|tail ?light|turn signal|led|light bulb|bulb|install|replace|swap|upgrade)\b/i;
const PARTS_DEPARTMENT_RE =
  /\b(parts? department|parts? counter|parts? desk|order (a )?part|need (a )?part|part number|oem parts?|aftermarket parts?|parts? for my|do you (have|carry|stock)\b.{0,28}\bparts?)\b/i;
const APPAREL_DEPARTMENT_RE =
  /\b(apparel|merch|merchandise|clothing|jacket|hoodie|t-?shirt|tee shirt|helmet|gloves?|boots?|riding gear|gear)\b/i;

function inferDepartmentFromText(text: string): DepartmentRole | null {
  const t = String(text ?? "").trim();
  if (!t) return null;
  if (SERVICE_DEPARTMENT_RE.test(t)) return "service";
  if (PARTS_DEPARTMENT_RE.test(t)) return "parts";
  if (APPAREL_DEPARTMENT_RE.test(t)) return "apparel";
  return null;
}

function departmentFromReasonText(reasonText: string): DepartmentRole | null {
  const t = String(reasonText ?? "").toLowerCase();
  if (!t) return null;
  if (/\bservice\b/.test(t)) return "service";
  if (/\bparts?\b/.test(t)) return "parts";
  if (/\bapparel\b/.test(t)) return "apparel";
  return null;
}

function getConversationDepartment(conv: any): DepartmentRole | null {
  if (!conv) return null;
  const bucket = String(conv?.classification?.bucket ?? "").toLowerCase();
  const cta = String(conv?.classification?.cta ?? "").toLowerCase();
  if (bucket === "service" || cta === "service_request") return "service";
  if (bucket === "parts" || cta === "parts_request" || cta === "parts_inquiry") return "parts";
  if (bucket === "apparel" || cta === "apparel_request" || cta === "apparel_inquiry") return "apparel";

  const dialogState = String(getDialogState(conv) ?? "").toLowerCase();
  if (dialogState === "service_request" || dialogState === "service_handoff" || dialogState.startsWith("service_")) {
    return "service";
  }
  if (dialogState.startsWith("parts_")) return "parts";
  if (dialogState.startsWith("apparel_")) return "apparel";

  const followUpReason = String(conv?.followUp?.reason ?? "").toLowerCase();
  const fromFollowUp = departmentFromReasonText(followUpReason);
  if (fromFollowUp) return fromFollowUp;

  const openTodos = listOpenTodos().filter(t => t.convId === conv.id);
  for (const todo of openTodos) {
    const todoReason = departmentFromReasonText(todo.reason);
    if (todoReason) return todoReason;
    const summaryDept = inferDepartmentFromText(String(todo.summary ?? ""));
    if (summaryDept) return summaryDept;
  }

  const leadText = [conv?.lead?.source, conv?.lead?.inquiry, conv?.lead?.notes, conv?.lead?.summary]
    .map(v => String(v ?? "").trim())
    .filter(Boolean)
    .join(" ");
  const inboundText = (conv?.messages ?? [])
    .filter((m: any) => m?.direction === "in")
    .slice(-10)
    .map((m: any) => String(m?.body ?? "").trim())
    .filter(Boolean)
    .join(" ");
  return inferDepartmentFromText(`${leadText} ${inboundText}`);
}

function isServiceConversation(conv: any): boolean {
  return getConversationDepartment(conv) === "service";
}

function inferTodoDepartment(todo: any, conv: any): DepartmentRole | null {
  const reason = departmentFromReasonText(String(todo?.reason ?? ""));
  if (reason) return reason;
  const convDepartment = getConversationDepartment(conv);
  if (convDepartment) return convDepartment;
  return inferDepartmentFromText(String(todo?.summary ?? ""));
}

function canUserAccessConversation(user: any, conv: any): boolean {
  if (AUTH_DISABLED || !user) return true;
  const role = String(user?.role ?? "").toLowerCase();
  if (role === "manager") return true;
  const dept = getConversationDepartment(conv);
  if (role === "service" || role === "parts" || role === "apparel") {
    return dept === role;
  }
  if (role === "salesperson") return !dept;
  return true;
}

app.use((req, res, next) => {
  if (AUTH_DISABLED) return next();
  const user = (req as any).user ?? null;
  if (!user) return next();
  const match = req.path.match(/^\/conversations\/([^/]+)/);
  if (!match) return next();
  if (match[1] === "compose") return next();
  const convId = decodeURIComponent(match[1]);
  const conv = getConversation(convId);
  if (!conv) return next();
  if (!canUserAccessConversation(user, conv)) {
    return res.status(403).json({ ok: false, error: "forbidden" });
  }
  return next();
});

async function syncSchedulerSalespeopleFromUsers() {
  const cfg = await getSchedulerConfigHot();
  const users = await listUsers();
  const salespeople = users
    .filter(
      u =>
        !!u.calendarId &&
        (u.role === "salesperson" || (u.role === "manager" && u.includeInSchedule))
    )
    .map(u => ({
      id: u.id,
      name: [u.firstName, u.lastName].filter(Boolean).join(" ") || u.name || u.email || u.id,
      calendarId: u.calendarId!
    }));
  const preferredExisting = (cfg.preferredSalespeople ?? []).filter(id => salespeople.some(s => s.id === id));
  const preferredSalespeople = preferredExisting.length ? preferredExisting : salespeople.map(s => s.id);
  await saveSchedulerConfig({ ...(cfg as any), salespeople, preferredSalespeople });
}

function effectiveMode(conv: any): SystemMode {
  if (conv?.mode === "human") return "suggest";
  return getSystemMode();
}

function hasEmailOptIn(lead: any): boolean {
  return lead?.emailOptIn !== false;
}

function getEmailConfig(profile: any) {
  const from =
    (profile?.fromEmail ?? process.env.SENDGRID_FROM_EMAIL ?? "").trim() || undefined;
  const replyTo =
    (profile?.replyToEmail ?? process.env.SENDGRID_REPLY_TO ?? "").trim() || undefined;
  const signature = String(profile?.emailSignature ?? "").trim() || undefined;
  return { from, replyTo, signature };
}

function appendFallbackEmailSignoff(body: string, dealerProfile: any): string {
  const text = String(body ?? "").trim();
  if (!text) return text;
  const agent = String(dealerProfile?.agentName ?? "").trim() || "Sales Team";
  const dealer = String(dealerProfile?.dealerName ?? "").trim() || "American Harley-Davidson";
  if (/\n\s*(best|thanks|thank you|regards|sincerely)\s*,?\s*$/i.test(text)) {
    return `${text}\n${agent}\n${dealer}`;
  }
  return `${text}\n\nBest,\n${agent}\n${dealer}`;
}

function base64UrlEncode(input: string): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/=+$/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
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

type InventorySnapshot = {
  savedAt: string;
  items: Array<{
    key: string;
    stockId?: string;
    vin?: string;
    year?: string;
    model?: string;
    color?: string;
  }>;
};

const INVENTORY_SNAPSHOT_PATH = path.join(getDataDir(), "inventory_snapshot.json");
let inventoryWatchRunning = false;

function inventoryKey(item: any): string | null {
  const key =
    (item.stockId ?? item.vin ?? "").trim() ||
    [item.year ?? "", item.model ?? "", item.color ?? ""].join("|").trim();
  return key ? key.toLowerCase() : null;
}

async function loadInventorySnapshot(): Promise<InventorySnapshot> {
  try {
    const raw = await fs.promises.readFile(INVENTORY_SNAPSHOT_PATH, "utf8");
    const parsed = JSON.parse(raw) as InventorySnapshot;
    if (!parsed?.items) return { savedAt: new Date(0).toISOString(), items: [] };
    return parsed;
  } catch (e: any) {
    if (e?.code === "ENOENT") {
      return { savedAt: new Date(0).toISOString(), items: [] };
    }
    console.warn("[inventory-watch] snapshot load failed:", e?.message ?? e);
    return { savedAt: new Date(0).toISOString(), items: [] };
  }
}

async function saveInventorySnapshot(items: any[]) {
  const payload: InventorySnapshot = {
    savedAt: new Date().toISOString(),
    items: items
      .map(i => ({
        key: inventoryKey(i) ?? "",
        stockId: i.stockId,
        vin: i.vin,
        year: i.year,
        model: i.model,
        color: i.color
      }))
      .filter(i => i.key)
  };
  try {
    await fs.promises.mkdir(path.dirname(INVENTORY_SNAPSHOT_PATH), { recursive: true });
    await fs.promises.writeFile(INVENTORY_SNAPSHOT_PATH, JSON.stringify(payload, null, 2));
  } catch (e: any) {
    console.warn("[inventory-watch] snapshot save failed:", e?.message ?? e);
  }
}

function normalizeWatchCondition(raw?: string | null): "new" | "used" | undefined {
  const t = String(raw ?? "").toLowerCase().trim();
  if (!t) return undefined;
  if (/(pre|used|pre-owned|preowned|owned)/.test(t)) return "used";
  if (/new/.test(t)) return "new";
  return undefined;
}

function inferInventoryItemCondition(item: any): "new" | "used" | undefined {
  const explicit = normalizeWatchCondition(item?.condition);
  if (explicit) return explicit;
  const yearNum = Number(String(item?.year ?? ""));
  if (Number.isFinite(yearNum) && yearNum > 0) {
    const currentYear = new Date().getFullYear();
    return yearNum <= currentYear - 2 ? "used" : "new";
  }
  return undefined;
}

function inventoryItemMatchesRequestedCondition(
  item: any,
  requestedCondition?: "new" | "used"
): boolean {
  if (!requestedCondition) return true;
  return inferInventoryItemCondition(item) === requestedCondition;
}

function formatRequestedConditionLabel(condition?: "new" | "used"): string {
  return condition ? `${condition} ` : "";
}

type ModelCodesByFamilyCatalog = {
  families?: Record<string, string[]>;
  aliases?: Record<string, string[]>;
};

type ModelCodesByFamilyLookup = {
  aliases: Map<string, Set<string>>;
  families: Map<string, Set<string>>;
  aliasKeysByLength: string[];
  familyKeysByLength: string[];
  allCodes: Set<string>;
};

let modelCodesByFamilyLookupCache: ModelCodesByFamilyLookup | null = null;

function normalizeCatalogModelKey(value: string | null | undefined): string {
  return normalizeModelText(value);
}

function normalizeModelCode(value: string | null | undefined): string {
  return String(value ?? "")
    .toUpperCase()
    .replace(/[^A-Z0-9_-]+/g, "")
    .trim();
}

function toCodeSet(values: string[] | undefined): Set<string> {
  const out = new Set<string>();
  for (const raw of values ?? []) {
    const code = normalizeModelCode(raw);
    if (code) out.add(code);
  }
  return out;
}

function modelKeyContains(haystack: string, needle: string): boolean {
  if (!haystack || !needle) return false;
  const hay = ` ${haystack.trim()} `;
  const ndl = ` ${needle.trim()} `;
  return hay.includes(ndl);
}

function resolveModelCodesCatalogPaths(): string[] {
  const envPath = String(process.env.MODEL_CODES_BY_FAMILY_PATH ?? "").trim();
  const byCwdSrc = path.resolve(process.cwd(), "src/domain/model_codes_by_family.json");
  const byCwdRepo = path.resolve(process.cwd(), "services/api/src/domain/model_codes_by_family.json");
  const byModuleSrc = fileURLToPath(
    new URL("../src/domain/model_codes_by_family.json", import.meta.url)
  );
  const byModuleSibling = fileURLToPath(
    new URL("./domain/model_codes_by_family.json", import.meta.url)
  );
  const deduped = Array.from(
    new Set([envPath, byCwdSrc, byCwdRepo, byModuleSrc, byModuleSibling].filter(Boolean))
  );
  return deduped;
}

function loadModelCodesByFamilyLookup(): ModelCodesByFamilyLookup | null {
  if (modelCodesByFamilyLookupCache) return modelCodesByFamilyLookupCache;
  let parsed: ModelCodesByFamilyCatalog | null = null;
  for (const p of resolveModelCodesCatalogPaths()) {
    try {
      const raw = fs.readFileSync(p, "utf8");
      const json = JSON.parse(raw) as ModelCodesByFamilyCatalog;
      if (!json || (typeof json !== "object" && !Array.isArray(json))) continue;
      parsed = json;
      break;
    } catch {
      // try next location
    }
  }
  if (!parsed) return null;

  const aliases = new Map<string, Set<string>>();
  for (const [rawKey, rawCodes] of Object.entries(parsed.aliases ?? {})) {
    if (!Array.isArray(rawCodes)) continue;
    const key = normalizeCatalogModelKey(rawKey);
    if (!key) continue;
    const codes = toCodeSet(rawCodes);
    if (!codes.size) continue;
    aliases.set(key, codes);
  }

  const families = new Map<string, Set<string>>();
  for (const [rawKey, rawCodes] of Object.entries(parsed.families ?? {})) {
    if (!Array.isArray(rawCodes)) continue;
    const key = normalizeCatalogModelKey(rawKey);
    if (!key) continue;
    const codes = toCodeSet(rawCodes);
    if (!codes.size) continue;
    families.set(key, codes);
  }

  modelCodesByFamilyLookupCache = {
    aliases,
    families,
    aliasKeysByLength: [...aliases.keys()].sort((a, b) => b.length - a.length),
    familyKeysByLength: [...families.keys()].sort((a, b) => b.length - a.length),
    allCodes: new Set<string>(
      [...aliases.values(), ...families.values()].flatMap(set => Array.from(set))
    )
  };
  return modelCodesByFamilyLookupCache;
}

function extractCatalogCodeHints(
  modelText: string | null | undefined,
  lookup: ModelCodesByFamilyLookup
): Set<string> {
  const hints = new Set<string>();
  const raw = String(modelText ?? "");
  if (!raw.trim()) return hints;
  const tokens = raw.toUpperCase().match(/[A-Z0-9_-]{3,}/g) ?? [];
  for (const token of tokens) {
    const code = normalizeModelCode(token);
    if (!code) continue;
    if (lookup.allCodes.has(code)) {
      hints.add(code);
      continue;
    }
    const noUnderscore = code.replace(/_/g, "");
    if (noUnderscore && lookup.allCodes.has(noUnderscore)) {
      hints.add(noUnderscore);
    }
  }
  return hints;
}

function inferModelCodesForText(modelText: string | null | undefined): Set<string> {
  const lookup = loadModelCodesByFamilyLookup();
  const modelKey = normalizeCatalogModelKey(modelText);
  if (!lookup || !modelKey) return new Set<string>();

  const resolved = new Set<string>();
  const addCodes = (codes?: Set<string>) => {
    if (!codes) return;
    for (const code of codes) resolved.add(code);
  };
  const codeHints = extractCatalogCodeHints(modelText, lookup);
  addCodes(codeHints);

  const exactAliasCodes = lookup.aliases.get(modelKey);
  const exactFamilyCodes = lookup.families.get(modelKey);
  addCodes(exactAliasCodes);
  addCodes(exactFamilyCodes);

  // Keep exact aliases/families precise. Only expand via contains-match when there is no exact hit.
  if (!exactAliasCodes && !exactFamilyCodes) {
    for (const aliasKey of lookup.aliasKeysByLength) {
      if (!modelKeyContains(modelKey, aliasKey)) continue;
      addCodes(lookup.aliases.get(aliasKey));
    }
    for (const familyKey of lookup.familyKeysByLength) {
      if (!modelKeyContains(modelKey, familyKey)) continue;
      addCodes(lookup.families.get(familyKey));
    }
  }

  const numericTokens = Array.from(modelKey.matchAll(/\b\d{3,4}\b/g))
    .map(m => m[0])
    .filter(Boolean);
  if (numericTokens.length && resolved.size) {
    const filtered = [...resolved].filter(code => numericTokens.some(token => code.includes(token)));
    if (filtered.length) return new Set(filtered);
  }
  return resolved;
}

function modelsShareCatalogCodes(modelA: string | null | undefined, modelB: string | null | undefined): boolean {
  const aCodes = inferModelCodesForText(modelA);
  const bCodes = inferModelCodesForText(modelB);
  if (!aCodes.size || !bCodes.size) return false;
  for (const code of aCodes) {
    if (bCodes.has(code)) return true;
  }
  return false;
}

function getCatalogModelNameCandidates(): string[] {
  const lookup = loadModelCodesByFamilyLookup();
  if (!lookup) return [];
  const keys = [...lookup.aliases.keys(), ...lookup.families.keys()]
    .map(k => String(k ?? "").trim())
    .filter(Boolean);
  return Array.from(new Set(keys.map(k => normalizeDisplayCase(k))));
}

function is883ModelToken(model: string): boolean {
  const t = normalizeModelText(model);
  return /\b883\b/.test(t) || /\bxl\s*883\b/.test(t);
}

function isSportsterFamilyAlias(model: string): boolean {
  const t = normalizeModelText(model);
  if (!t) return false;
  return (
    /\bsportster\b/.test(t) ||
    is883ModelToken(t) ||
    /\biron 883\b/.test(t) ||
    /\b883 roadster\b/.test(t) ||
    /\broadster 883\b/.test(t)
  );
}

function isRoadGlide3Variant(model: string | null | undefined): boolean {
  const t = normalizeModelName(String(model ?? ""));
  if (!t) return false;
  return (
    /\bfltrt\b/.test(t) ||
    /\broad glide\s*(3|iii)\b/.test(t) ||
    /\broad glide trike\b/.test(t)
  );
}

function isStreetGlide3Variant(model: string | null | undefined): boolean {
  const t = normalizeModelName(String(model ?? ""));
  if (!t) return false;
  return (
    /\bflhlt\b/.test(t) ||
    /\bstreet glide\s*(3|iii)\b/.test(t) ||
    /\bstreet glide trike\b/.test(t)
  );
}

function canonicalizeWatchModelLabel(model: string | null | undefined): string {
  const raw = String(model ?? "").trim();
  if (!raw) return "";
  const cleaned = raw
    .replace(/\s*\/\s*anniversary\s+edition\b/gi, " ")
    .replace(/\banniversary\s+edition\b/gi, " ")
    .replace(/\banniversary\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  const t = normalizeModelName(cleaned);
  if (isRoadGlide3Variant(cleaned)) return "Road Glide 3";
  if (isStreetGlide3Variant(cleaned)) return "Street Glide 3 Limited";
  if (/\bflhtcutg\b/.test(t) || /\btri glide(?:\s+ultra)?\b/.test(t)) return "Tri Glide Ultra";
  if (/\bflhxxx\b/.test(t) || /\bstreet glide trike\b/.test(t)) return "Street Glide Trike";
  if (/\bra1250st\b/.test(t) || /\bpan america(?:\s+1250)?\s+st\b/.test(t)) return "Pan America 1250 ST";
  if (/\bra1250s\b/.test(t) || /\bpan america(?:\s+1250)?\s+special\b/.test(t)) return "Pan America Special";
  if (/\bra1250l\b/.test(t) || /\bpan america(?:\s+1250)?\s+l(?:imited)?\b/.test(t)) return "Pan America 1250 L";
  if (/\brh1250s\b/.test(t) || /\bsportster\s+s\b/.test(t)) return "Sportster S";
  if (/\brh975s\b/.test(t) || /\bnightster\s+special\b/.test(t)) return "Nightster Special";
  if (/\brh975\b/.test(t) || /\bnightster\b/.test(t)) return "Nightster";
  return cleaned || raw;
}

function inventoryItemMatchesWatch(item: any, watch: InventoryWatch): boolean {
  if (!item?.model || !watch?.model) return false;
  const itemModel = normalizeModelName(String(item.model));
  const watchModel = normalizeModelName(String(watch.model));
  const watchIsRoadGlide3 = isRoadGlide3Variant(watchModel);
  const itemIsRoadGlide3 = isRoadGlide3Variant(itemModel);
  if (watchIsRoadGlide3 && !itemIsRoadGlide3) return false;
  const watchIsStreetGlide3 = isStreetGlide3Variant(watchModel);
  const itemIsStreetGlide3 = isStreetGlide3Variant(itemModel);
  if (watchIsStreetGlide3 && !itemIsStreetGlide3) return false;
  const directMatch = itemModel.includes(watchModel) || watchModel.includes(itemModel);
  const catalogCodeMatch = modelsShareCatalogCodes(itemModel, watchModel);
  const watchHas883 = is883ModelToken(watchModel);
  const familyMatch = (() => {
    if (!isSportsterFamilyAlias(watchModel)) return false;
    if (watchHas883) return is883ModelToken(itemModel);
    return isSportsterFamilyAlias(itemModel);
  })();
  if (!directMatch && !familyMatch && !catalogCodeMatch) return false;
  if (watch.trim) {
    const trimToken = normalizeModelName(String(watch.trim));
    if (trimToken && !itemModel.includes(trimToken)) return false;
  }
  if (watch.make) {
    const itemMake = normalizeModelName(String(item.make ?? ""));
    const watchMake = normalizeModelName(String(watch.make));
    if (!itemMake || (!itemMake.includes(watchMake) && !watchMake.includes(itemMake))) return false;
  }
  const watchCondition = normalizeWatchCondition(watch.condition);
  if (watchCondition) {
    const itemCondition = normalizeWatchCondition(item.condition);
    if (!itemCondition || itemCondition !== watchCondition) return false;
  }
  if (watch.year && String(item.year) !== String(watch.year)) return false;
  if (watch.yearMin && watch.yearMax) {
    const y = Number(item.year ?? 0);
    if (!Number.isFinite(y) || y < watch.yearMin || y > watch.yearMax) return false;
  }
  if (watch.color) {
    const watchColorRaw = String(watch.color ?? "");
    const itemColorRaw = String(item.color ?? "");
    const leadTrim = watch.trim ? extractTrimToken(String(watch.trim)) : extractTrimToken(watchColorRaw);
    const keepTrim = !!watch.trim || /\b(trim|finish)\b/i.test(watchColorRaw);
    const itemColor = normalizeColorBase(itemColorRaw, keepTrim);
    const watchColor = normalizeColorBase(watchColorRaw, keepTrim);
    const directIncludes = !!itemColor && !!watchColor && itemColor.includes(watchColor);
    const normalizedMatch =
      colorMatchesExact(itemColorRaw, watchColorRaw, leadTrim) ||
      colorMatchesAlias(itemColorRaw, watchColorRaw, leadTrim);
    if (!directIncludes && !normalizedMatch) return false;
  }
  const itemPrice = Number(item?.price ?? NaN);
  const minPrice = Number(watch.minPrice ?? NaN);
  const maxPrice = Number(watch.maxPrice ?? NaN);
  const hasMinPrice = Number.isFinite(minPrice) && minPrice > 0;
  const hasMaxPrice = Number.isFinite(maxPrice) && maxPrice > 0;
  if (hasMinPrice || hasMaxPrice) {
    if (!Number.isFinite(itemPrice) || itemPrice <= 0) return false;
    if (hasMinPrice && itemPrice < minPrice) return false;
    if (hasMaxPrice && itemPrice > maxPrice) return false;
  }
  const monthlyBudget = Number(watch.monthlyBudget ?? NaN);
  if (Number.isFinite(monthlyBudget) && monthlyBudget > 0) {
    const termMonthsRaw = Number(watch.termMonths ?? NaN);
    const termMonths = Number.isFinite(termMonthsRaw) && termMonthsRaw > 0 ? termMonthsRaw : 72;
    const downPaymentRaw = Number(watch.downPayment ?? NaN);
    const downPayment = Number.isFinite(downPaymentRaw) && downPaymentRaw > 0 ? downPaymentRaw : 0;
    const estimatedMonthly = estimateInventoryItemMonthlyPayment(item, {
      termMonths,
      taxRate: 0.08,
      downPayment
    });
    if (estimatedMonthly == null || estimatedMonthly > monthlyBudget) return false;
  }
  return true;
}

async function processInventoryWatchlist(targetConvId?: string) {
  if (inventoryWatchRunning) return;
  inventoryWatchRunning = true;
  try {
    const items = await getInventoryFeedHot();
    if (!items.length) return;
    const holds = await listInventoryHolds();
    const solds = await listInventorySolds();
    const isWatchCandidateAvailable = (item: any): boolean => {
      const holdKey = normalizeInventoryHoldKey(item?.stockId, item?.vin);
      if (holdKey && holds?.[holdKey]) return false;
      const soldKey = normalizeInventorySoldKey(item?.stockId, item?.vin);
      if (soldKey && solds?.[soldKey]) return false;
      return true;
    };
    const cfg = await getSchedulerConfigHot();
    const tz = cfg.timezone || "America/New_York";
    const snapshot = await loadInventorySnapshot();
    const prevKeys = new Set(snapshot.items.map(i => i.key));
    const newItems = items.filter(i => {
      const key = inventoryKey(i);
      return key && !prevKeys.has(key);
    });
    const newItemKeys = new Set(newItems.map(i => inventoryKey(i)).filter(Boolean));
    await saveInventorySnapshot(items);

    const nowIso = new Date().toISOString();
    const targetConv = targetConvId ? getConversation(targetConvId) : null;
    const convs = targetConvId ? (targetConv ? [targetConv] : []) : getAllConversations();
    for (const conv of convs) {
      const watches =
        conv.inventoryWatches?.length
          ? conv.inventoryWatches
          : conv.inventoryWatch
            ? [conv.inventoryWatch]
            : [];
      if (!watches.length) continue;
      if (!conv.inventoryWatches && conv.inventoryWatch) {
        conv.inventoryWatches = [conv.inventoryWatch];
      }
      if (conv.status === "closed") continue;
      const phone = conv.lead?.phone ?? conv.leadKey;
      if (phone && isSuppressed(phone)) continue;
      if (conv.followUp?.mode === "manual_handoff") continue;
      let matchedWatch: InventoryWatch | null = null;
      let matchedItem: any | null = null;
      for (const watch of watches) {
        if (!watch || watch.status === "paused") continue;
        if (
          watch.lastNotifiedAt &&
          Date.now() - new Date(watch.lastNotifiedAt).getTime() < 24 * 60 * 60 * 1000
        ) {
          continue;
        }
        // For brand-new watches (never notified), allow matching against current
        // in-stock inventory. Otherwise only match newly-arrived units.
        const candidateItems = (watch.lastNotifiedAt ? newItems : items).filter(i =>
          isWatchCandidateAvailable(i)
        );
        if (!candidateItems.length) continue;
        const match = candidateItems.find(i => inventoryItemMatchesWatch(i, watch));
        if (!match) continue;
        matchedWatch = watch;
        matchedItem = match;
        break;
      }
      if (!matchedWatch || !matchedItem) continue;

      const year = matchedItem.year ?? (matchedWatch.year ? String(matchedWatch.year) : undefined);
      const make = matchedItem.make ?? matchedWatch.make;
      const model = matchedItem.model ?? matchedWatch.model;
      const trim = matchedWatch.trim;
      const color = matchedItem.color ?? matchedWatch.color;
      const name = [year, make, model, trim].filter(Boolean).join(" ");
      const colorText = color ? ` in ${color}` : "";
      const matchedKey = inventoryKey(matchedItem);
      const isNewArrival = matchedKey ? newItemKeys.has(matchedKey) : false;
      const reply = isNewArrival
        ? `Good news — we just got ${name}${colorText} in stock. Want details or a time to check it out?`
        : `Good news — we have ${name}${colorText} in stock right now. Want details or a time to check it out?`;
      const imageUrl =
        Array.isArray(matchedItem.images) && matchedItem.images.length
          ? matchedItem.images[0]
          : undefined;
      const to = conv.lead?.phone ?? conv.leadKey;
      appendOutbound(conv, "salesperson", to, reply, "draft_ai", undefined, imageUrl ? [imageUrl] : undefined);
      matchedWatch.lastNotifiedAt = nowIso;
      matchedWatch.lastNotifiedStockId = matchedItem.stockId ?? matchedItem.vin ?? undefined;
      setFollowUpMode(conv, "holding_inventory", "inventory_watch_match");
      if (!conv.followUpCadence || conv.followUpCadence.status === "stopped") {
        conv.followUpCadence = undefined;
        startFollowUpCadence(conv, nowIso, tz);
      }
      if (conv.followUpCadence && conv.followUpCadence.status === "active") {
        const pauseUntil = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
        conv.followUpCadence.pausedUntil = pauseUntil;
        conv.followUpCadence.pauseReason = "inventory_watch_match";
        conv.followUpCadence.nextDueAt = pauseUntil;
      }
      conv.updatedAt = nowIso;
      saveConversation(conv);
    }
    await flushConversationStore();
  } catch (e: any) {
    console.warn("[inventory-watch] failed:", e?.message ?? e);
  } finally {
    inventoryWatchRunning = false;
  }
}

async function processInventoryHolds() {
  try {
    const holds = await listInventoryHolds();
    const now = new Date();
    const openQuestions = listOpenQuestions();
    for (const hold of Object.values(holds ?? {})) {
      const createdAt = hold.createdAt || hold.updatedAt;
      if (!createdAt) continue;
      const created = new Date(createdAt);
      if (Number.isNaN(created.getTime())) continue;
      const ageDays = Math.floor((now.getTime() - created.getTime()) / (24 * 60 * 60 * 1000));
      if (ageDays < 30) continue;
      const conv =
        (hold.convId && getConversation(hold.convId)) ||
        (hold.leadKey && getConversation(hold.leadKey)) ||
        null;
      if (!conv) continue;
      const label = hold.label ?? hold.stockId ?? hold.vin ?? "this unit";
      const text = `Unit on hold for ${ageDays} days (${label}). Keep hold or release?`;
      const hasQuestion = openQuestions.some(
        q => q.convId === conv.id && /unit on hold/i.test(q.text)
      );
      if (!hasQuestion) {
        addInternalQuestion(conv.id, conv.leadKey, text);
      }
    }
  } catch (e: any) {
    console.warn("[inventory-holds] failed:", e?.message ?? e);
  }
}

setInterval(() => {
  void processDueFollowUps();
  void processAppointmentConfirmations();
  void processStaffAppointmentNotifications();
  void processAppointmentQuestions();
}, 60_000);

setTimeout(() => {
  void processInventoryWatchlist();
  void processInventoryHolds();
}, 60_000);

setInterval(() => {
  void processInventoryWatchlist();
  void processInventoryHolds();
}, 24 * 60 * 60 * 1000);

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "api",
    ts: new Date().toISOString(),
    systemMode: getSystemMode()
  });
});

app.get("/inventory", async (_req, res) => {
  try {
    const items = await getInventoryFeedHot();
    if (!items.length) {
      const snap = await loadInventorySnapshot();
      if (snap.items.length) {
        const withNotes = snap.items.map(item => ({
          ...item,
          notes: [],
          hold: null,
          sold: null
        }));
        return res.json({ ok: true, items: withNotes, snapshot: true });
      }
    }
    const notes = await listInventoryNotes();
    const holds = await listInventoryHolds();
    const solds = await listInventorySolds();
    const withNotes = items.map(item => {
      const key = normalizeInventoryHoldKey(item.stockId, item.vin) ?? "";
      const entry = key ? notes?.[key] : undefined;
      const hold = key ? holds?.[key] : undefined;
      const sold = key ? solds?.[key] : undefined;
      return { ...item, notes: entry?.notes ?? [], hold: hold ?? null, sold: sold ?? null };
    });
    return res.json({ ok: true, items: withNotes });
  } catch (err: any) {
    console.warn("inventory list failed:", err?.message ?? err);
    return res.status(500).json({ ok: false, error: "Failed to load inventory" });
  }
});

app.get("/public/inventory", async (_req, res) => {
  try {
    const items = await getInventoryFeedHot();
    let list = items;
    if (!list.length) {
      list = await getInventoryFeed({ bypassCache: true });
    }
    if (!list.length) {
      const snap = await loadInventorySnapshot();
      list = snap.items ?? [];
    }
    const sanitized = (list ?? []).map((item: any) => ({
      year: item.year ?? "",
      make: item.make ?? "",
      model: item.model ?? "",
      trim: item.trim ?? "",
      color: item.color ?? "",
      stockId: item.stockId ?? item.stock ?? "",
      vin: item.vin ?? "",
      image: Array.isArray(item.images) && item.images.length ? item.images[0] : ""
    }));
    return res.json({ ok: true, items: sanitized });
  } catch (err: any) {
    console.warn("public inventory list failed:", err?.message ?? err);
    return res.status(500).json({ ok: false, error: "Failed to load inventory" });
  }
});

app.put("/inventory", async (req, res) => {
  try {
    const stockId = req.body?.stockId ?? null;
    const vin = req.body?.vin ?? null;
    const notes = Array.isArray(req.body?.notes) ? req.body.notes : [];
    await setInventoryNote({ stockId, vin, notes });
    return res.json({ ok: true });
  } catch (err: any) {
    console.warn("inventory note update failed:", err?.message ?? err);
    return res.status(500).json({ ok: false, error: "Failed to save note" });
  }
});

app.post("/debug/followups/run", async (_req, res) => {
  try {
    await processDueFollowUps();
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err?.message ?? "Failed to run follow-ups" });
  }
});

app.post("/debug/conversations/reload", async (_req, res) => {
  try {
    await reloadConversationStore();
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err?.message ?? "Failed to reload conversation store" });
  }
});

app.post("/debug/inbound/process", express.json(), async (req, res) => {
  try {
    const from = String(req.body?.from ?? "").trim();
    const to = String(req.body?.to ?? "dealership").trim();
    const body = String(req.body?.body ?? "");
    if (!from || !body) {
      return res.status(400).json({ ok: false, error: "from and body are required" });
    }

    const event: InboundMessageEvent = {
      channel: "sms",
      provider: "debug",
      from,
      to,
      body,
      providerMessageId: `dbg_${Math.random().toString(36).slice(2, 10)}`,
      receivedAt: new Date().toISOString()
    };

    const conv = await resolveInboundConversationForSms(event);
    appendInbound(conv, event);
    const history = buildHistory(conv, 20);
    const memorySummary = conv.memorySummary?.text ?? null;
    const memorySummaryShouldUpdate = shouldUpdateMemorySummary(conv);
    const dealerProfile = await getDealerProfileHot();
    const weatherStatus = await getDealerWeatherStatus(dealerProfile);
    const result = await orchestrateInbound(event, history, {
      appointment: conv.appointment,
      followUp: conv.followUp,
      leadSource: conv.lead?.source ?? null,
      bucket: conv.classification?.bucket ?? null,
      cta: conv.classification?.cta ?? null,
      primaryIntentHint: "general",
      lead: conv.lead ?? null,
      pricingAttempts: getPricingAttempts(conv),
      allowSchedulingOffer: isExplicitScheduleIntent(body),
      voiceSummary: getActiveVoiceContext(conv)?.summary ?? null,
      memorySummary,
      memorySummaryShouldUpdate,
      inventoryWatch: conv.inventoryWatch ?? null,
      inventoryWatches: conv.inventoryWatches ?? null,
      financeDocs: conv.financeDocs ?? null,
      tradePayoff: conv.tradePayoff ?? null,
      hold: conv.hold ?? null,
      sale: conv.sale ?? null,
      pickup: conv.pickup ?? null,
      weather: weatherStatus ?? null
    });

  if (result?.draft && result.shouldRespond) {
      appendOutbound(conv, event.to, event.from, result.draft, "draft_ai");
      if (result.pricingAttempted) incrementPricingAttempt(conv);
      if (result.paymentsAnswered) setDialogState(conv, "payments_answered");
      if (result.smallTalk) setDialogState(conv, "small_talk");
      if (result.suggestedSlots && result.suggestedSlots.length > 0) {
        setLastSuggestedSlots(conv, result.suggestedSlots);
      }
      if (result.requestedTime) {
        setRequestedTime(conv, { day: result.requestedTime.dayOfWeek, timeText: event.body });
      }
      if (result.memorySummary) {
        setMemorySummary(conv, result.memorySummary, conv.messages.length);
      }
    if (result.pickupUpdate) {
      conv.pickup = { ...(conv.pickup ?? {}), ...result.pickupUpdate, updatedAt: nowIso() };
    }
  }
  if (result?.debugFlow) {
    conv.lastDecision = result.debugFlow;
  }
  if (result?.debugFlow) {
    conv.lastDecision = result.debugFlow;
  }
    if (result?.debugFlow) {
      conv.lastDecision = result.debugFlow;
    }

    res.json({ ok: true, conversationId: conv.id, draft: result?.draft ?? null });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err?.message ?? "Failed to process inbound" });
  }
});

app.get("/auth/me", async (req, res) => {
  if (AUTH_DISABLED) {
    return res.json({ ok: true, authDisabled: true, user: { role: "manager", email: "dev@local" } });
  }
  const any = await hasAnyUsers();
  if (!any) {
    return res.json({ ok: true, needsBootstrap: true });
  }
  const tokenHeader = req.header("x-auth-token") || req.header("authorization")?.replace(/^Bearer\s+/i, "");
  const cookies = parseCookies(req.header("cookie"));
  const token = tokenHeader || cookies.lr_session;
  if (!token) return res.status(401).json({ ok: false, error: "auth required" });
  const session = await getSession(token);
  if (!session) return res.status(401).json({ ok: false, error: "invalid session" });
  const user = await getUserById(session.userId);
  if (!user) return res.status(401).json({ ok: false, error: "user not found" });
  return res.json({
    ok: true,
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      firstName: user.firstName,
      lastName: user.lastName,
      role: user.role,
      includeInSchedule: user.includeInSchedule,
      calendarId: user.calendarId,
      phone: user.phone,
      extension: user.extension,
      permissions: user.permissions
    }
  });
});

app.post("/auth/login", async (req, res) => {
  if (AUTH_DISABLED) return res.json({ ok: true, token: "disabled", user: { role: "manager" } });
  const email = String(req.body?.email ?? "").trim();
  const password = String(req.body?.password ?? "");
  if (!email || !password) return res.status(400).json({ ok: false, error: "Missing email/password" });
  const user = await verifyPassword(email, password);
  if (!user) return res.status(401).json({ ok: false, error: "Invalid credentials" });
  const session = await createSession(user.id);
  res.json({
    ok: true,
    token: session.token,
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      firstName: user.firstName,
      lastName: user.lastName,
      role: user.role,
      calendarId: user.calendarId,
      phone: user.phone,
      extension: user.extension,
      permissions: user.permissions
    }
  });
});

app.post("/auth/logout", async (req, res) => {
  const tokenHeader = req.header("x-auth-token") || req.header("authorization")?.replace(/^Bearer\s+/i, "");
  const cookies = parseCookies(req.header("cookie"));
  const token = tokenHeader || cookies.lr_session;
  if (token) await deleteSession(token);
  res.json({ ok: true });
});

app.get("/users", requirePermission("canEditAppointments"), async (_req, res) => {
  const users = await listUsers();
  res.json({
    ok: true,
    users: users.map(u => ({
      id: u.id,
      email: u.email,
      name: u.name,
      firstName: u.firstName,
      lastName: u.lastName,
      role: u.role,
      includeInSchedule: u.includeInSchedule,
      calendarId: u.calendarId,
      phone: u.phone,
      extension: u.extension,
      permissions: u.permissions
    }))
  });
});

app.post("/users", async (req, res) => {
  const any = await hasAnyUsers();
  if (any && !AUTH_DISABLED && (req as any).user?.role !== "manager") {
    return res.status(403).json({ ok: false, error: "manager required" });
  }
  const email = String(req.body?.email ?? "").trim();
  const password = String(req.body?.password ?? "");
  const roleRaw = String(req.body?.role ?? "salesperson").trim();
  const role = (["manager", "salesperson", "service", "parts", "apparel"].includes(roleRaw)
    ? roleRaw
    : "salesperson") as "manager" | "salesperson" | "service" | "parts" | "apparel";
  const firstName = String(req.body?.firstName ?? "").trim();
  const lastName = String(req.body?.lastName ?? "").trim();
  const nameRaw = String(req.body?.name ?? "").trim();
  const name = [firstName, lastName].filter(Boolean).join(" ").trim() || nameRaw;
  const calendarId = String(req.body?.calendarId ?? "").trim();
  const phone = String(req.body?.phone ?? "").trim();
  const extension = String(req.body?.extension ?? "").trim();
  const includeInSchedule =
    req.body?.includeInSchedule == null ? undefined : Boolean(req.body.includeInSchedule);
  const permissions = req.body?.permissions ?? undefined;
  if (!email || !password) return res.status(400).json({ ok: false, error: "Missing email/password" });
  try {
    const user = await createUser({
      email,
      password,
      role,
      name,
      firstName,
      lastName,
      includeInSchedule,
      calendarId,
      phone,
      extension,
      permissions
    });
    await syncSchedulerSalespeopleFromUsers();
    res.json({
      ok: true,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        firstName: user.firstName,
        lastName: user.lastName,
        role: user.role,
        includeInSchedule: user.includeInSchedule,
        calendarId: user.calendarId,
        phone: user.phone,
        extension: user.extension,
        permissions: user.permissions
      }
    });
  } catch (err: any) {
    res.status(400).json({ ok: false, error: err?.message ?? "Failed to create user" });
  }
});

app.put("/users/:id", requireManager, async (req, res) => {
  const id = String(req.params.id ?? "").trim();
  if (!id) return res.status(400).json({ ok: false, error: "Missing id" });
  try {
    const roleRaw =
      req.body?.role == null ? undefined : String(req.body.role).trim();
    const role = roleRaw && ["manager", "salesperson", "service", "parts", "apparel"].includes(roleRaw)
      ? (roleRaw as "manager" | "salesperson" | "service" | "parts" | "apparel")
      : undefined;
    const user = await updateUser(id, {
      email: req.body?.email,
      password: req.body?.password,
      role,
      name: req.body?.name,
      firstName: req.body?.firstName,
      lastName: req.body?.lastName,
      includeInSchedule: req.body?.includeInSchedule,
      calendarId: req.body?.calendarId,
      phone: req.body?.phone,
      extension: req.body?.extension,
      permissions: req.body?.permissions
    });
    await syncSchedulerSalespeopleFromUsers();
    res.json({
      ok: true,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        firstName: user.firstName,
        lastName: user.lastName,
        role: user.role,
        includeInSchedule: user.includeInSchedule,
        calendarId: user.calendarId,
        phone: user.phone,
        extension: user.extension,
        permissions: user.permissions
      }
    });
  } catch (err: any) {
    res.status(400).json({ ok: false, error: err?.message ?? "Failed to update user" });
  }
});

app.delete("/users/:id", requireManager, async (req, res) => {
  const id = String(req.params.id ?? "").trim();
  if (!id) return res.status(400).json({ ok: false, error: "Missing id" });
  await deleteUser(id);
  await syncSchedulerSalespeopleFromUsers();
  res.json({ ok: true });
});

// ✅ System-wide mode (suggest vs autopilot)
app.get("/settings", (_req, res) => {
  res.json({ ok: true, mode: getSystemMode() });
});

app.patch("/settings", requireManager, (req, res) => {
  const mode = String(req.body?.mode ?? "") as SystemMode;
  if (mode !== "suggest" && mode !== "autopilot") {
    return res.status(400).json({ ok: false, error: "mode must be 'suggest' or 'autopilot'" });
  }
  const next = setSystemMode(mode);
  return res.json({ ok: true, mode: next });
});

// ✅ SendGrid Inbound Parse (ADF email ingestion)
app.post("/crm/leads/adf/sendgrid", sendgridInboundMiddleware, handleSendgridInbound);

function fmtLocal(iso: string, tz: string) {
  const d = new Date(iso);
  return d.toLocaleString("en-US", {
    timeZone: tz,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  });
}

function dayKeyLocal(iso: string, tz: string) {
  try {
    const fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    });
    return fmt.format(new Date(iso));
  } catch {
    return new Date(iso).toISOString().slice(0, 10);
  }
}

function overlaps(aStart: Date, aEnd: Date, bStart: Date, bEnd: Date) {
  return aStart < bEnd && aEnd > bStart;
}

function getLeadIdentifiers(conv: any, event?: { from?: string }) {
  const leadEmailRaw =
    conv?.lead?.email ??
    (typeof conv?.leadKey === "string" && conv.leadKey.includes("@") ? conv.leadKey : "") ??
    (event?.from && event.from.includes("@") ? event.from : "");
  const leadPhoneRaw =
    conv?.lead?.phone ??
    (typeof conv?.leadKey === "string" && !conv.leadKey.includes("@") ? conv.leadKey : "") ??
    (event?.from && !event.from.includes("@") ? event.from : "");

  const email = String(leadEmailRaw ?? "").trim().toLowerCase() || undefined;
  const phone = leadPhoneRaw ? normalizePhone(String(leadPhoneRaw)) : undefined;
  return { email, phone };
}

function getRelatedConversations(conv: any, event?: { from?: string }) {
  const { email, phone } = getLeadIdentifiers(conv, event);
  if (!email && !phone) return [];
  return getAllConversations().filter(other => {
    if (!other || other.id === conv.id) return false;
    const ids = getLeadIdentifiers(other);
    const emailMatch = email && ids.email && ids.email === email;
    const phoneMatch = phone && ids.phone && ids.phone === phone;
    return !!(emailMatch || phoneMatch);
  });
}

function isStickyClosedJourney(conv: Conversation | null | undefined): boolean {
  if (!conv) return false;
  const closedReason = String(conv.closedReason ?? "").toLowerCase();
  return (
    conv.status === "closed" &&
    (closedReason === "sold" ||
      /\bhold\b/.test(closedReason) ||
      !!conv.sale?.soldAt ||
      !!conv.hold?.key ||
      conv.followUpCadence?.kind === "post_sale")
  );
}

function shouldStartNewSalesJourney(parse: JourneyIntentParse | null): boolean {
  if (!parse) return false;
  if (parse.journeyIntent !== "sale_trade") return false;
  if (!parse.explicitRequest) return false;
  const confidence = typeof parse.confidence === "number" ? parse.confidence : 0;
  return confidence >= 0.68;
}

async function resolveInboundConversationForSms(event: InboundMessageEvent): Promise<Conversation> {
  const existing = findConversationsByLeadKey(event.from);
  if (!existing.length) return upsertConversationByLeadKey(event.from, "suggest");
  const latest = existing[0];
  if (!isStickyClosedJourney(latest)) return latest;

  const parse = await parseJourneyIntentWithLLM({
    text: String(event.body ?? ""),
    history: buildHistory(latest, 12),
    lead: latest.lead
  });

  if (!shouldStartNewSalesJourney(parse)) return latest;

  const created = createConversationForLeadKey(event.from, latest.mode ?? "suggest");
  created.leadOwner = latest.leadOwner ? { ...latest.leadOwner } : undefined;
  if (latest.lead) {
    created.lead = {
      ...latest.lead,
      walkInComment: undefined,
      walkInCommentUsedAt: undefined
    };
  }
  created.status = "open";
  created.closedAt = undefined;
  created.closedReason = undefined;
  saveConversation(created);
  return created;
}

function pauseRelatedCadencesOnInbound(conv: any, event?: { from?: string }) {
  const pauseUntil = new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString();
  for (const other of getRelatedConversations(conv, event)) {
    if (other?.followUpCadence?.kind === "post_sale") continue;
    pauseFollowUpCadence(other, pauseUntil, "cross_channel_inbound");
  }
}

async function resetFollowUpCadenceOnInbound(conv: any, inboundText: string) {
  const cadence = conv?.followUpCadence;
  if (!cadence || cadence.status !== "active") return;
  if (cadence.kind === "post_sale") return;
  if (conv?.contactPreference === "call_only") return;
  if (conv?.followUp?.mode === "manual_handoff") return;
  if (conv?.inventoryWatch || (conv?.inventoryWatches?.length ?? 0) > 0) return;
  if (conv?.hold) return;
  const inbound = String(inboundText ?? "");
  const shortAck = isShortAckText(inbound) || isEmojiOnlyText(inbound);
  if (shortAck) {
    const lastOutboundText = String(getLastNonVoiceOutbound(conv)?.body ?? "");
    if (isReachOutWhenReadyCloseText(lastOutboundText)) {
      stopFollowUpCadence(conv, "ack_after_soft_close");
      if (conv?.followUp?.mode !== "holding_inventory" && conv?.followUp?.mode !== "manual_handoff") {
        setFollowUpMode(conv, "paused_indefinite", "ack_after_soft_close");
        setDialogState(conv, "followup_paused");
      }
    }
    return;
  }

  const cfg = await getSchedulerConfigHot();
  const tz = cfg.timezone || "America/New_York";
  const anchor = nowIso();
  cadence.anchorAt = anchor;
  cadence.stepIndex = 0;
  cadence.nextDueAt = computeFollowUpDueAt(anchor, FOLLOW_UP_DAY_OFFSETS[0], tz);
  cadence.lastSentAt = undefined;
  cadence.lastSentStep = undefined;
  cadence.pausedUntil = undefined;
  cadence.pauseReason = undefined;
  cadence.scheduleInviteCount = 0;
  cadence.scheduleMuted = false;
}

async function suppressRelatedPhones(
  conv: any,
  event: { from?: string } | undefined,
  reason: string,
  source: string
) {
  const phones = new Set<string>();
  const { phone } = getLeadIdentifiers(conv, event);
  if (phone) phones.add(phone);
  for (const other of getRelatedConversations(conv, event)) {
    const ids = getLeadIdentifiers(other);
    if (ids.phone) phones.add(ids.phone);
  }
  for (const p of phones) {
    await addSuppression(p, reason, source);
  }
}

function stopRelatedCadences(
  conv: any,
  reason: string,
  opts?: { setMode?: "manual_handoff" | "holding_inventory" | "active"; close?: boolean }
) {
  for (const other of getRelatedConversations(conv)) {
    if (opts?.setMode) {
      setFollowUpMode(other, opts.setMode, `cross_channel:${reason}`);
    }
    if (opts?.close) {
      closeConversation(other, reason);
    } else {
      stopFollowUpCadence(other, reason);
    }
  }
}

const nowIso = () => new Date().toISOString();

function onAppointmentBooked(conv: any) {
  if (conv?.closedReason === "sold" || conv?.sale?.soldAt || conv?.followUpCadence?.kind === "post_sale") {
    return;
  }
  stopFollowUpCadence(conv, "appointment_booked");
  stopRelatedCadences(conv, "appointment_booked");
  if (conv) {
    conv.scheduleSoft = undefined;
  }
}

function getBookingToken(profile: Awaited<ReturnType<typeof getDealerProfile>> | null): string {
  const token = profile?.bookingToken?.trim();
  return token || (process.env.BOOKING_PUBLIC_TOKEN ?? "").trim();
}

function extractBookingToken(req: express.Request): string {
  return String(
    (req.query?.token as string | undefined) ??
      req.body?.token ??
      req.headers["x-booking-token"] ??
      ""
  ).trim();
}

function inferAppointmentTypeFromConv(conv: any): string {
  const bucket = conv?.classification?.bucket ?? "";
  const cta = conv?.classification?.cta ?? "";
  if (bucket === "test_ride" || cta === "schedule_test_ride") return "test_ride";
  if (bucket === "trade_in_sell" || cta === "value_my_trade" || cta === "sell_my_bike") {
    return "trade_appraisal";
  }
  if (bucket === "finance_prequal" || cta === "prequalify" || cta === "hdfs_coa") {
    return "finance_discussion";
  }
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

function detectSummaryCallback(summaryText: string, transcriptText: string): { label: string } | null {
  const source = `${summaryText}\n${transcriptText}`.toLowerCase();
  if (!/(call back|call me back|call him back|call her back|call you back|call around|call after|follow up|check back|reach back|call later)/i.test(source)) {
    return null;
  }
  const dayMatch = source.match(
    /\b(today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i
  );
  const dayLabel = dayMatch ? dayMatch[1] : /next day/.test(source) ? "tomorrow" : "";
  const timeMatch = source.match(/\b(after|around|by|at)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i);
  let timeLabel = "";
  if (timeMatch) {
    const minute = timeMatch[3] ? `:${timeMatch[3]}` : "";
    timeLabel = `${timeMatch[1]} ${timeMatch[2]}${minute} ${timeMatch[4].toUpperCase()}`;
  }
  const when = [dayLabel, timeLabel].filter(Boolean).join(" ").trim();
  const label = when ? `Call back ${when}` : "Call back when available";
  return { label };
}

function findModelMention(text: string): string | null {
  const models = getAllModels();
  if (!models.length) return null;
  const hay = text.toLowerCase();
  let best: string | null = null;
  for (const model of models) {
    const m = String(model ?? "").trim();
    if (!m) continue;
    const needle = m.toLowerCase();
    if (!hay.includes(needle)) continue;
    if (!best || needle.length > best.toLowerCase().length) {
      best = m;
    }
  }
  return best;
}

function extractYear(text: string): number | null {
  const match = text.match(/\b(19|20)\d{2}\b/);
  if (!match) return null;
  const year = Number(match[0]);
  return Number.isFinite(year) ? year : null;
}

function detectCondition(text: string, year: number | null): "new" | "used" | "unknown" {
  const t = text.toLowerCase();
  if (/\b(pre[-\s]?owned|used)\b/.test(t)) return "used";
  if (/\bnew\b/.test(t)) return "new";
  if (year) {
    const nowYear = new Date().getFullYear();
    if (year >= nowYear - 1) return "new";
    if (year <= nowYear - 2) return "used";
  }
  return "unknown";
}

async function applyPostCallSummaryActions(opts: {
  conv: Conversation;
  summaryText: string;
  transcriptText: string;
  sourceMessageId?: string;
}) {
  const { conv, summaryText, transcriptText, sourceMessageId } = opts;
  const lowerSummary = summaryText.toLowerCase();
  const lowerTranscript = transcriptText.toLowerCase();
  const extractCustomerUtterances = (text: string) => {
    if (!text) return "";
    const lines = text.split(/\r?\n/);
    const customerLines = lines
      .map(line => line.trim())
      .filter(line =>
        /^(customer|caller|client|prospect)\s*:/i.test(line)
      )
      .map(line => line.replace(/^(customer|caller|client|prospect)\s*:\s*/i, ""));
    return customerLines.length ? customerLines.join(" ") : "";
  };
  const customerText = extractCustomerUtterances(transcriptText) || summaryText;

  const intentParse = await parseIntentWithLLM({
    text: customerText,
    lead: conv.lead
  });
  const intentConfidence =
    typeof intentParse?.confidence === "number" ? intentParse.confidence : 0;
  const intentConfidenceMin = Number(process.env.LLM_INTENT_CONFIDENCE_MIN ?? 0.75);
  const intentAccepted = !!intentParse?.explicitRequest && intentConfidence >= intentConfidenceMin;
  const llmCallbackRequested = intentAccepted && intentParse?.intent === "callback";
  const llmAvailabilityIntent = intentAccepted && intentParse?.intent === "availability";
  const llmTestRideIntent = intentAccepted && intentParse?.intent === "test_ride";
  const llmAvailability = llmAvailabilityIntent ? intentParse?.availability ?? null : null;

  if (llmTestRideIntent && !isTestRideDialogState(getDialogState(conv))) {
    setDialogState(conv, "test_ride_init");
  }

  const callback = llmCallbackRequested
    ? {
        label: intentParse?.callback?.timeText
          ? `Customer requested a call back ${intentParse.callback.timeText}`
          : "Customer requested a call back."
      }
    : detectSummaryCallback(summaryText, transcriptText);
  if (callback) {
    const hasOpenCall = listOpenTodos().some(
      t => t.convId === conv.id && t.status === "open" && t.reason === "call"
    );
    if (!hasOpenCall) {
      addTodo(conv, "call", callback.label, sourceMessageId);
    }
  }

  const watchCue = /(looking for|interested in|shopping for|considering|plans to buy|wants to buy|still interested)/i;
  const notInStockCue =
    /\b(don'?t|do not|not)\s+(currently\s+)?(have|see|show|carry|stock)\b.*\b(in stock|available)\b|\bnot available\b|\bsold out\b|\bno\s+.*\bin stock\b/i;
  const notifyCue =
    /\b(let (you|me) know|keep (you|me) posted|keep an eye out|watch for|call (you|me) if|text (you|me) if|send(?:ing)? (?:it|one|them)?\s*my way|send(?:ing)? (?:it|one|them)?\s*over)\b.*\b(comes in|available|get one|get it|in stock|find one)\b/i;
  if (
    watchCue.test(lowerSummary) ||
    watchCue.test(lowerTranscript) ||
    notInStockCue.test(lowerSummary) ||
    notInStockCue.test(lowerTranscript) ||
    notifyCue.test(lowerSummary) ||
    notifyCue.test(lowerTranscript)
  ) {
    const model =
      llmAvailability?.model ||
      findModelMention(summaryText) ||
      findModelMention(transcriptText) ||
      conv.lead?.vehicle?.model ||
      conv.lead?.vehicle?.description ||
      undefined;
    const hasWatch = !!(conv.inventoryWatch || (conv.inventoryWatches && conv.inventoryWatches.length));
    if (model && !hasWatch) {
      const yearFromIntent = llmAvailability?.year ? Number(llmAvailability.year) : undefined;
      const year = yearFromIntent || extractYear(summaryText) || extractYear(transcriptText);
      const cond =
        llmAvailability?.condition && llmAvailability.condition !== "unknown"
          ? llmAvailability.condition
          : detectCondition(summaryText + " " + transcriptText, year);
      const watch: InventoryWatch = {
        model,
        year: year ?? undefined,
        make: conv.lead?.vehicle?.make,
        condition: cond === "unknown" ? undefined : cond,
        exactness: year ? "year_model" : "model_only",
        status: "active",
        createdAt: new Date().toISOString(),
        note: "call_summary"
      };
      if (llmAvailability?.color) watch.color = llmAvailability.color;
      conv.inventoryWatch = watch;
      conv.inventoryWatches = [watch];
      conv.inventoryWatchPending = undefined;
      setDialogState(conv, "inventory_watch_active");
      setFollowUpMode(conv, "holding_inventory", "inventory_watch");
      stopFollowUpCadence(conv, "inventory_watch");
    }
  }

  const bookingCue = /(scheduled|booked|appointment|set for|confirmed|coming in|stop(ping)? in|visit)/i;
  if (bookingCue.test(lowerSummary) || bookingCue.test(lowerTranscript) || llmTestRideIntent) {
    if (!conv.appointment?.bookedEventId) {
      try {
        const cfg = await getSchedulerConfigHot();
        const requested =
          parseRequestedDayTime(summaryText, cfg.timezone) ||
          parseRequestedDayTime(transcriptText, cfg.timezone);
        if (requested) {
          const appointmentType = inferAppointmentTypeFromConv(conv) || "inventory_visit";
          const durationMinutes = cfg.appointmentTypes?.[appointmentType]?.durationMinutes ?? 60;
          const salespeople = cfg.salespeople ?? [];
          const preferred = getPreferredSalespeople(cfg);
          const primaryId = conv.appointment?.bookedSalespersonId ?? preferred[0];
          const candidateIds = [
            primaryId,
            ...preferred.filter(id => id && id !== primaryId)
          ].filter(Boolean) as string[];
          const cal = await getAuthedCalendarClient();
          const timeMin = new Date().toISOString();
          const timeMax = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();
          let exactMatch: { exact: any; sp: any } | null = null;
          for (const spId of candidateIds) {
            const sp = salespeople.find((p: any) => p.id === spId);
            if (!sp) continue;
            const fb = await queryFreeBusy(cal, [sp.calendarId], timeMin, timeMax, cfg.timezone);
            const busy = (fb.calendars?.[sp.calendarId]?.busy ?? []) as any[];
            const expanded = expandBusyBlocks(busy as any, cfg.minGapBetweenAppointmentsMinutes ?? 60);
            const exact = findExactSlotForSalesperson(
              cfg,
              sp.id,
              sp.calendarId,
              requested,
              durationMinutes,
              expanded
            );
            if (exact) {
              exactMatch = { exact, sp };
              break;
            }
          }
          if (exactMatch) {
            const leadName =
              conv.lead?.name?.trim() ||
              [conv.lead?.firstName, conv.lead?.lastName].filter(Boolean).join(" ").trim() ||
              conv.leadKey;
            const stockId = conv.lead?.vehicle?.stockId ?? "";
            const summary = `Appt: ${appointmentType} – ${leadName}${stockId ? ` – ${stockId}` : ""}`;
            const descriptionLines = [
              `LeadKey: ${conv.leadKey ?? ""}`,
              `Phone: ${conv.lead?.phone ?? ""}`,
              `Email: ${conv.lead?.email ?? ""}`,
              `FirstName: ${conv.lead?.firstName ?? ""}`,
              `LastName: ${conv.lead?.lastName ?? ""}`,
              `Stock: ${conv.lead?.vehicle?.stockId ?? ""}`,
              `VIN: ${conv.lead?.vehicle?.vin ?? ""}`,
              `Source: ${conv.lead?.source ?? ""}`,
              `VisitType: ${appointmentType}`
            ].filter(Boolean);
            const colorId = getAppointmentTypeColorId(cfg, appointmentType);
            const event = await insertEvent(
              cal,
              exactMatch.sp.calendarId,
              cfg.timezone,
              summary,
              descriptionLines.join("\n"),
              exactMatch.exact.start,
              exactMatch.exact.end,
              colorId
            );
            conv.appointment = conv.appointment ?? { status: "none", updatedAt: new Date().toISOString() };
            conv.appointment.bookedEventId = event.id ?? null;
            conv.appointment.bookedSalespersonId = exactMatch.sp.id;
            conv.appointment.bookedSalespersonName = exactMatch.sp.name;
            conv.appointment.bookedCalendarId = exactMatch.sp.calendarId;
            conv.appointment.whenIso = exactMatch.exact.start;
            conv.appointment.whenLocal = formatSlotLocal(exactMatch.exact.start, cfg.timezone);
            conv.appointment.appointmentType = appointmentType;
            conv.appointment.updatedAt = new Date().toISOString();
            onAppointmentBooked(conv);
          }
        }
      } catch (err: any) {
        console.warn("[voice] post-summary booking failed:", err?.message ?? err);
      }
    }
  }
}

const FOLLOW_UP_MESSAGES = [
  "Hi {name}, just checking in on{labelClause}. Any questions?",
  "Hey {name}, want pics or a quick video of{label}?",
  "Hi {name}, still shopping around or want to come in soon?",
  "Quick check {name}, is{label} still the one you want?",
  "If you want to stop by{labelClause}, give me a day that works.",
  "No rush {name}. If you want, I can keep an eye out{labelClause}.",
  "If timing is tough {name}, tell me what works and I’ll make it easy.",
  "Want me to hold a time for you{labelClause}?",
  "If you want to come by{labelClause}, what day works best?",
  "Still thinking it over {name}? If you want to stop in{labelClause}, I can set it up."
];

type WalkInCommentFollowUpCtx = {
  name: string;
  agent: string;
  dealerName: string;
  comment: string;
  label: string;
};

const buildWalkInCommentFollowUp = ({
  name,
  agent,
  dealerName,
  comment,
  label
}: WalkInCommentFollowUpCtx) =>
  `Hi ${name}, this is ${agent} at ${dealerName}. You said "${comment}". When the weather looks good, we can set up your ${label}.`;

const FOLLOW_UP_VARIANTS_WITH_SLOTS: string[] = [
  "Hi {name}, if you want to stop by I have {a} or {b} open. Which works best?{extraLine}",
  "Hey {name}, I can do {a} or {b}. Which one works for you?{extraLine}",
  "Quick follow-up {name}, if you want to come in I have {a} or {b} open. Which time do you want?{extraLine}"
];

const SELL_FOLLOW_UP_VARIANTS_WITH_SLOTS: string[] = [
  "Hi {name}, if you want we can do a quick appraisal on {bike}. I have {a} or {b} open. Which works best?",
  "Hey {name}, I can set a quick appraisal for {bike}. {a} or {b}?",
  "Quick check {name}, want to bring {bike} by? I have {a} or {b} open."
];

const FOLLOW_UP_VARIANTS_NO_SLOTS: Record<number, string[]> = {
  0: [
    "Hi {name}, just checking in{labelClause}. Let me know what you’re thinking.{extraLine}",
    "Hey {name}, quick follow-up{labelClause}. Any questions?{extraLine}",
    "Hi {name}, if you want to stop by{labelClause}, tell me what day works.{extraLine}"
  ],
  1: [
    "Hi {name}, want pics or a quick video of{label}?",
    "Hey {name}, I can send a short video of{label} if you want."
  ],
  2: [
    "Quick check {name}, is{label} still your top pick?",
    "Hey {name}, still leaning toward{label} or still comparing?"
  ],
  4: [
    "If it helps {name}, I can send a couple times to stop by.",
    "Want me to send a couple time options {name}?",
    "If it’s easier {name}, I can send times that work on our end."
  ],
  7: [
    "If you want to line up a quick visit {name}, I can send a couple options.",
    "Want a couple time options to stop in {name}?",
    "If you want, I can send times that work on our side."
  ]
};

const ENGAGED_FOLLOW_UP_VARIANTS_WITH_SLOTS: Record<string, string[]> = {
  general: [
    "Hi {name}, if you want to stop by I have {a} or {b} open. Which works best?{extraLine}",
    "Hey {name}, I can do {a} or {b}. Which one works?{extraLine}"
  ],
  trade: [
    "Hi {name}, if you want to go over trade numbers for {trade}, I have {a} or {b} open. Which works best?{extraLine}",
    "Hey {name}, I can set a quick trade appraisal for {trade}. {a} or {b}?{extraLine}",
    "Quick check {name}, want to bring {trade} by? I have {a} or {b} open.{extraLine}"
  ],
  pricing: [
    "Hi {name}, if you want to go over numbers on the {model}, I have {a} or {b} open. Which works best?{extraLine}",
    "Hey {name}, I can walk through pricing at {a} or {b}. Which time works?{extraLine}"
  ],
  payments: [
    "Hi {name}, if you want to go over payments, I have {a} or {b} open. Which works best?{extraLine}",
    "Hey {name}, I can walk through payment options at {a} or {b}. Which one works?{extraLine}"
  ],
  inventory: [
    "Hi {name}, if you want to see{label}, I have {a} or {b} open. Which works best?{extraLine}",
    "Hey {name}, want to stop by for the {model}? I can do {a} or {b}.{extraLine}"
  ],
  scheduling: [
    "Hi {name}, if you want to lock a time, I have {a} or {b} open. Which works best?{extraLine}",
    "Hey {name}, I can set a time for the {model}. {a} or {b}?{extraLine}"
  ]
};

const ENGAGED_FOLLOW_UP_VARIANTS_NO_SLOTS: Record<string, Record<number, string[]>> = {
  general: {
    0: [
      "Hi {name}, just checking in{labelClause}. Let me know what you’re thinking.{extraLine}",
      "Hey {name}, quick follow-up{labelClause}. If you want to stop by, tell me what day works.{extraLine}"
    ],
    1: [
      "Hi {name}, want a quick video of{label}?"
    ],
    2: [
      "Quick check {name}, still leaning toward{label} or comparing a few?"
    ]
  },
  trade: {
    0: [
      "Hi {name}, if you want I can run trade numbers on {trade}.{extraLine}",
      "Hey {name}, I can walk you through a rough trade value on {trade}.{extraLine}"
    ],
    1: [
      "Hi {name}, I can go over trade value on {trade} if you want.",
      "Hey {name}, want me to check trade options on {trade}?"
    ],
    2: [
      "Quick check {name}, still thinking about a trade on {trade}?",
      "Hey {name}, want me to run trade numbers or wait for now?"
    ]
  },
  pricing: {
    0: [
      "Hi {name}, any questions on pricing{labelClause}?{extraLine}",
      "Hey {name}, want me to re-check numbers on the {model}?{extraLine}"
    ],
    1: [
      "Hi {name}, I can send a quick pricing breakdown on the {model}.",
      "Hey {name}, want a quick video or pricing recap on the {model}?"
    ],
    2: [
      "Quick check {name}, still interested in the {model} at this price?",
      "Hey {name}, want me to revisit pricing on the {model}?"
    ]
  },
  payments: {
    0: [
      "Hi {name}, any questions on payments? I can tighten numbers if you want.{extraLine}",
      "Hey {name}, want me to walk through payment options?{extraLine}"
    ],
    1: [
      "Hi {name}, I can send a quick payment breakdown."
    ],
    2: [
      "Quick check {name}, still looking at payments or holding off for now?"
    ]
  },
  inventory: {
    0: [
      "Hi {name}, any questions about{label}? I can send a video or confirm stock.{extraLine}",
      "Hey {name}, still interested in the {model}?{extraLine}"
    ],
    1: [
      "Hi {name}, want pics or a quick video of the {model}?",
      "Hey {name}, I can send a walkaround video of{label}."
    ],
    2: [
      "Quick check {name}, still interested in{label} or looking at others?",
      "Hey {name}, want me to keep an eye on the {model} for you?"
    ]
  },
  scheduling: {
    0: [
      "Hi {name}, if you want to lock a time to stop in, tell me what works.{extraLine}",
      "Hey {name}, want to set a time for the {model}?{extraLine}"
    ],
    1: [
      "Hi {name}, want a quick video of{label}?",
      "Hey {name}, I can send a short walkaround of the {model}."
    ],
    2: [
      "Quick check {name}, want to line up a time or hold off for now?",
      "Hey {name}, still planning to stop in soon?"
    ]
  }
};

function pickVariant(variants: string[], seed: string): string {
  if (!variants.length) return "";
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  }
  return variants[hash % variants.length];
}

function pickVariantNoRepeat(
  cadence: any,
  variants: string[],
  seed: string,
  key: string
): string {
  if (!variants.length) return "";
  const usedMap = (cadence.usedVariants = cadence.usedVariants ?? {});
  const used = usedMap[key] ?? [];
  const remaining = variants.filter(v => !used.includes(v));
  const pool = remaining.length ? remaining : variants;
  const pick = pickVariant(pool, `${seed}|${used.length}`);
  if (!used.includes(pick)) {
    usedMap[key] = [...used, pick];
  }
  return pick;
}

function renderFollowUpTemplate(template: string, ctx: Record<string, string>): string {
  let out = template;
  for (const [key, value] of Object.entries(ctx)) {
    out = out.replace(new RegExp(`\\{${key}\\}`, "g"), value);
  }
  return out.replace(/\s+/g, " ").trim();
}

function buildOutcomeContextLine(note: string): string | null {
  const text = String(note ?? "").trim();
  if (!text) return null;
  const t = text.toLowerCase();
  if (
    /\b(cancer|chemo|chemotherapy|radiation|hospice|icu|hospital|surgery|surgical|terminal|stage\s*(four|4)|death|dying|funeral|passed away|stroke|heart attack)\b/.test(
      t
    )
  ) {
    return "Hope everything is okay on your end.";
  }
  if (/\b(sick|ill|not feeling well|under the weather|family emergency|daughter|son|wife|husband)\b/.test(t)) {
    return "Hope things are okay on your end.";
  }
  if (/\b(out of town|traveling|travelling|vacation|work trip)\b/.test(t)) {
    return "Hope your schedule settles down soon.";
  }
  return null;
}

function getFollowUpContextLine(conv: any, now: Date): string | null {
  const outcome = conv?.appointment?.staffNotify?.outcome;
  const note = outcome?.note;
  if (!note || !outcome?.updatedAt) return null;
  const updatedAt = new Date(outcome.updatedAt);
  if (Number.isNaN(updatedAt.getTime())) return null;
  const ageMs = now.getTime() - updatedAt.getTime();
  if (ageMs > 30 * 24 * 60 * 60 * 1000) return null;
  const usedAt = conv?.appointment?.staffNotify?.contextUsedAt;
  if (usedAt) {
    const usedDate = new Date(usedAt);
    if (!Number.isNaN(usedDate.getTime()) && usedDate.getTime() >= updatedAt.getTime()) {
      return null;
    }
  }
  return buildOutcomeContextLine(note);
}

function mapDialogStateToCadenceTag(name: DialogStateName): string | null {
  if (!name || name === "none") return null;
  if (name.startsWith("trade_")) return "trade";
  if (name.startsWith("pricing_")) return "pricing";
  if (name.startsWith("payments_")) return "payments";
  if (name.startsWith("inventory_")) return "inventory";
  if (name.startsWith("compare_")) return "inventory";
  if (name.startsWith("test_ride_")) return "scheduling";
  if (name.startsWith("schedule_") || name === "clarify_schedule") return "scheduling";
  return null;
}

type LastIntentName = NonNullable<Conversation["lastIntent"]>["name"];

function mapDialogStateToIntent(name: DialogStateName): LastIntentName | null {
  if (!name || name === "none") return null;
  if (name.startsWith("trade_")) return "trade";
  if (name.startsWith("pricing_")) return "pricing";
  if (name.startsWith("payments_")) return "payments";
  if (name.startsWith("inventory_")) return "inventory";
  if (name.startsWith("compare_")) return "inventory";
  if (name.startsWith("test_ride_")) return "scheduling";
  if (name.startsWith("schedule_") || name === "clarify_schedule") return "scheduling";
  if (name.startsWith("callback_")) return "callback";
  if (name.startsWith("service_")) return "service";
  if (name === "small_talk") return "small_talk";
  if (name.startsWith("followup_")) return null;
  return null;
}

function updateLastIntent(conv: any, intent: LastIntentName, source: "dialog_state" | "llm" | "manual") {
  if (!conv || !intent) return;
  const updatedAt = nowIso();
  if (conv.lastIntent?.name === intent) {
    conv.lastIntent.updatedAt = updatedAt;
    conv.lastIntent.source = source;
    return;
  }
  conv.lastIntent = { name: intent, updatedAt, source };
}

function mapBucketToCadenceTag(bucket?: string | null): string | null {
  if (!bucket) return null;
  if (bucket === "trade_in_sell") return "trade";
  if (bucket === "inventory_interest") return "inventory";
  if (bucket === "pricing_payments") return "pricing";
  return null;
}

function mapLastIntentToCadenceTag(name?: string | null): string | null {
  if (!name) return null;
  if (["trade", "pricing", "payments", "inventory", "scheduling"].includes(name)) return name;
  return "general";
}

async function resolveCadenceContextTag(conv: any, cadence: any): Promise<string> {
  const cached = cadence?.contextTag;
  const cachedAt = cadence?.contextTagUpdatedAt ? new Date(cadence.contextTagUpdatedAt) : null;
  if (cached && cachedAt && Date.now() - cachedAt.getTime() < 24 * 60 * 60 * 1000) {
    return cached;
  }
  const lastIntent = conv?.lastIntent;
  if (lastIntent?.name && lastIntent.updatedAt) {
    const lastAt = new Date(lastIntent.updatedAt);
    if (!Number.isNaN(lastAt.getTime()) && Date.now() - lastAt.getTime() < 30 * 24 * 60 * 60 * 1000) {
      const fromLast = mapLastIntentToCadenceTag(lastIntent.name);
      if (fromLast) {
        cadence.contextTag = fromLast;
        cadence.contextTagUpdatedAt = nowIso();
        return fromLast;
      }
    }
  }
  const dialogTag = mapDialogStateToCadenceTag(getDialogState(conv));
  if (dialogTag) {
    cadence.contextTag = dialogTag;
    cadence.contextTagUpdatedAt = nowIso();
    return dialogTag;
  }
  const bucketTag = mapBucketToCadenceTag(conv.classification?.bucket ?? null);
  if (bucketTag) {
    cadence.contextTag = bucketTag;
    cadence.contextTagUpdatedAt = nowIso();
    return bucketTag;
  }
  const history = (conv.messages ?? [])
    .filter((m: any) => m?.body && m.direction && !["voice_call", "voice_transcript", "voice_summary"].includes(m.provider))
    .slice(-6)
    .map((m: any) => ({ direction: m.direction, body: String(m.body ?? "") }));
  const llmTag = history.length ? await classifyCadenceContextWithLLM({ history }) : null;
  const finalTag = llmTag || "general";
  cadence.contextTag = finalTag;
  cadence.contextTagUpdatedAt = nowIso();
  return finalTag;
}

const SELL_FOLLOW_UP_MESSAGES = [
  "Just checking in, if you want a quick appraisal on {bike} I can set a time. I have {a} or {b} open. Which works best?",
  "If it’s easier, we can start with a rough estimate, then confirm in person. What day works?",
  "Still looking to sell? I can set a quick appraisal time for {bike}. What day and time works?",
  "No rush. When you’re ready, I can line up an appraisal.",
  "If you want, we can go over numbers and set a quick appraisal time.",
  "If you want to move forward, tell me a day to bring the bike in and I’ll set it up."
];

type EmailFollowUpCtx = {
  name: string;
  label: string;
  bookingLine: string;
  dealerName: string;
  canTestRide: boolean;
};

const EMAIL_FOLLOW_UP_MESSAGES: Array<(ctx: EmailFollowUpCtx) => string> = [
  ({ name, label, bookingLine }) =>
    `Hi ${name},\n\nJust checking in on ${label}. If you want to stop by, ${bookingLine}\n\nThanks,`,
  ({ name, label, bookingLine }) =>
    `Hi ${name},\n\nIf you want, I can send pics or a quick video of ${label}. ${bookingLine}\n\nThanks,`,
  ({ name, label, bookingLine, canTestRide }) =>
    `Hi ${name},\n\nThanks again for your interest in ${label}. ${canTestRide ? "If you want a test ride, I can hold a time." : "If you want to stop by, I can hold a time."} ${bookingLine}\n\nThanks,`,
  ({ name, label, bookingLine }) =>
    `Hi ${name},\n\nQuick question, is ${label} still at the top of your list? If you want to see it in person, ${bookingLine}\n\nThanks,`,
  ({ name, label, bookingLine }) =>
    `Hi ${name},\n\nJust checking in on ${label}. If you want to take a closer look, ${bookingLine}\n\nThanks,`,
  ({ name, label, bookingLine }) =>
    `Hi ${name},\n\nNo rush. If you’re still shopping for ${label}, I’m here to help. ${bookingLine}\n\nThanks,`,
  ({ name, label, bookingLine }) =>
    `Hi ${name},\n\nIf it’s easier, tell me what day works and I’ll handle the rest. ${bookingLine}\n\nThanks,`,
  ({ name, label, bookingLine }) =>
    `Hi ${name},\n\nIf you want to set a time to check out ${label}, I can put it on the calendar. ${bookingLine}\n\nThanks,`,
  ({ name, label, bookingLine }) =>
    `Hi ${name},\n\nWant me to hold a time for you to see ${label}? ${bookingLine}\n\nThanks,`,
  ({ name, label, bookingLine }) =>
    `Hi ${name},\n\nStill interested in taking a look at ${label}? ${bookingLine}\n\nThanks,`
];

const SCHEDULE_INVITE_THRESHOLD = 3;

const FRESH_INFO_FOLLOW_UPS = [
  "Hi {name}, quick update with a payment estimate for{labelClause}. Want me to keep an eye on similar bikes?",
  "Hey {name}, I can text a quick payment breakdown for{labelClause}. Want me to keep watching while you decide?",
  "Hi {name}, want me to keep tabs on{labelClause}? I can send payment info and watch similar inventory."
];

const SOFT_EXIT_FOLLOW_UPS = [
  "Hi {name}, all good if now isn’t the time. Want me to text you when something similar comes in?",
  "Hi {name}, no rush. I can text when a similar bike or price pops up. Want me to keep watching?",
  "Hi {name}, sounds like you want to wait. Want me to keep you posted on{labelClause}?"
];

function isUnknownInterestVehicle(conv: any): boolean {
  const raw =
    conv?.lead?.vehicle?.model ??
    conv?.lead?.vehicle?.description ??
    conv?.lead?.vehicleDescription ??
    "";
  if (!raw) return true;
  return /full line|other/i.test(raw);
}

function isTradeAcceleratorLead(conv: any): boolean {
  const source = (conv?.lead?.source ?? conv?.leadSource ?? "").toLowerCase();
  return source.includes("trade accelerator");
}

function isSellLead(conv: any): boolean {
  const source = (conv?.lead?.source ?? conv?.leadSource ?? "").toLowerCase();
  const bucket = conv?.classification?.bucket ?? "";
  const cta = conv?.classification?.cta ?? "";
  return (
    bucket === "trade_in_sell" ||
    cta === "sell_my_bike" ||
    cta === "value_my_trade" ||
    /sell my bike|sell your bike|sell your vehicle/.test(source)
  );
}

function getSellBikeLabel(conv: any): string {
  const trade = conv?.lead?.tradeVehicle ?? {};
  const vehicle = conv?.lead?.vehicle ?? {};
  const model = trade.model ?? trade.description ?? vehicle.model ?? vehicle.description ?? null;
  const year = trade.year ?? vehicle.year ?? null;
  if (!model) return "your bike";
  return `your ${formatModelLabel(year, model)}`;
}

function normalizeLeadLabel(conv: any): string | null {
  const raw =
    conv?.lead?.vehicle?.model ??
    conv?.lead?.vehicle?.description ??
    conv?.lead?.vehicleDescription ??
    "";
  if (!raw) return null;
  if (/full line|other/i.test(raw)) return null;
  const year = conv?.lead?.vehicle?.year ?? conv?.lead?.year ?? null;
  return formatModelLabel(year, raw);
}

function buildInitialEmailDraft(conv: any, dealerProfile: any): string {
  const rawName = conv?.lead?.firstName?.trim() || conv?.lead?.name?.trim() || "there";
  const name = rawName.split(" ")[0] || "there";
  const dealerName = dealerProfile?.dealerName ?? "American Harley-Davidson";
  const agentName = dealerProfile?.agentName ?? "our team";
  const bookingUrl = buildBookingUrlForLead(dealerProfile?.bookingUrl, conv);
  const label = normalizeLeadLabel(conv);
  const leadSourceLower = (conv?.lead?.source ?? conv?.leadSource ?? "").toLowerCase();
  const isCustomBuild = /custom build/.test(leadSourceLower);
  const isTestRide =
    conv?.classification?.bucket === "test_ride" || conv?.classification?.cta === "schedule_test_ride";
  const thanks = isCustomBuild
    ? label
      ? `Thanks for building your ${label} online.`
      : "Thanks for your custom build request."
    : isTestRide
      ? label
        ? `Thanks for your interest in a test ride on the ${label}.`
        : "Thanks for your interest in a test ride."
      : label
        ? `Thanks for your interest in the ${label}.`
        : "Thanks for your interest.";
  const intro = `This is ${agentName} at ${dealerName}.`;
  const help = "I’m happy to help with pricing, options, and availability.";
  const buildLine = isCustomBuild ? "I can walk you through build options and next steps." : "";
  const visit = isCustomBuild
    ? "If you want to stop in to go over build options, you can book an appointment below."
    : label
      ? "If you want to stop in to check out the bike and go over options, you can book an appointment below."
      : "If you want to stop in to go over options, you can book an appointment below.";
  const bookingLine = bookingUrl
    ? `You can book an appointment here: ${bookingUrl}`
    : "Just reply with a day and time that works for you.";
  const extra = "If a walkaround or extra photos would help, just let me know.";

  return `Hi ${name},\n\n${thanks} ${intro} ${help} ${buildLine} ${visit}\n\n${bookingLine}\n\n${extra}`;
}

const FOLLOW_UP_COLOR_WORDS = [
  "black",
  "white",
  "red",
  "blue",
  "gray",
  "grey",
  "silver",
  "orange",
  "green",
  "yellow",
  "gold",
  "burgundy",
  "tan",
  "brown",
  "bronze"
];

function extractColorMention(text: string | null | undefined): string | null {
  if (!text) return null;
  const lower = text.toLowerCase();
  for (const color of FOLLOW_UP_COLOR_WORDS) {
    if (lower.includes(color)) return color;
  }
  return null;
}

function extractColorFromDescription(desc?: string | null, stockId?: string | null): string | null {
  if (!desc) return null;
  const clean = desc.replace(/\s+/g, " ").trim();
  if (stockId) {
    const idx = clean.toLowerCase().indexOf(stockId.toLowerCase());
    if (idx >= 0) {
      const tail = clean.slice(idx + stockId.length).trim();
      if (tail && tail.length <= 40) return tail;
    }
  }
  const colorMatch = clean.match(/color[:\-\s]+(.+)$/i);
  if (colorMatch?.[1]) return colorMatch[1].trim();
  return null;
}

function normalizeColor(s: string): string {
  return s
    .toLowerCase()
    .replace(/\bmetalic\b/g, "metallic")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function normalizeColorBase(s: string, keepTrim = false): string {
  const base = normalizeColor(s);
  if (keepTrim) return base;
  return base
    .replace(/\b(and|with)\b/g, " ")
    .replace(/\b(chrome|black)\s+trim\b/g, "")
    .replace(/\b(trim|finish)\b/g, "")
    .replace(/\bblack\s+finish\b/g, "black")
    .replace(/\bchrome\s+finish\b/g, "chrome")
    .replace(/\s+/g, " ")
    .trim();
}

const COLOR_TOKEN_STOP_WORDS = new Set([
  "and",
  "with",
  "w",
  "metallic",
  "pearl",
  "denim",
  "sunglo",
  "custom",
  "colour",
  "color",
  "cast",
  "wheel",
  "wheels",
  "solo",
  "two",
  "tone",
  "pinstripe",
  "vivid"
]);

function extractColorTokens(s: string | undefined | null, keepTrim = false): string[] {
  if (!s) return [];
  const normalized = normalizeColorBase(s, keepTrim);
  if (!normalized) return [];
  return normalized
    .split(" ")
    .map(tok => tok.trim())
    .filter(tok => !!tok && !COLOR_TOKEN_STOP_WORDS.has(tok));
}

function hasStrongColorTokenMatch(
  itemColor: string | undefined,
  leadColor: string | undefined,
  leadTrim: "black" | "chrome" | null
): boolean {
  if (!itemColor || !leadColor) return false;
  const leadTokens = extractColorTokens(leadColor, !!leadTrim);
  if (leadTokens.length < 2) return false;
  const itemTokens = new Set(extractColorTokens(itemColor, !!leadTrim));
  if (itemTokens.size === 0) return false;
  return leadTokens.every(tok => itemTokens.has(tok));
}

function pickMostSpecificColor(primary: string | null | undefined, secondary: string | null | undefined): string | null {
  const a = String(primary ?? "").trim();
  const b = String(secondary ?? "").trim();
  if (!a && !b) return null;
  if (!a) return b;
  if (!b) return a;
  const aNorm = normalizeColorBase(a);
  const bNorm = normalizeColorBase(b);
  if (aNorm === bNorm) return a.length >= b.length ? a : b;
  const aTokens = extractColorTokens(a).length;
  const bTokens = extractColorTokens(b).length;
  if (aTokens !== bTokens) return aTokens > bTokens ? a : b;
  return a.length >= b.length ? a : b;
}

function extractTrimToken(s: string | undefined | null): "black" | "chrome" | null {
  if (!s) return null;
  const clean = normalizeColor(s);
  if (/\bblack\s+trim\b/.test(clean)) return "black";
  if (/\bchrome\s+trim\b/.test(clean)) return "chrome";
  return null;
}

const COLOR_ALIASES: Record<string, string[]> = {
  "vivid black": ["vivid black", "black"]
};

function colorMatchesExact(
  itemColor: string | undefined,
  leadColor: string | undefined,
  leadTrim: "black" | "chrome" | null
): boolean {
  if (!itemColor || !leadColor) return false;
  const item = normalizeColorBase(itemColor, !!leadTrim);
  const lead = normalizeColorBase(leadColor, !!leadTrim);
  if (leadTrim) {
    const itemTrim = extractTrimToken(itemColor);
    if (itemTrim !== leadTrim) return false;
  }
  return !!item && !!lead && item === lead;
}

function colorMatchesAlias(
  itemColor: string | undefined,
  leadColor: string | undefined,
  leadTrim: "black" | "chrome" | null
): boolean {
  if (!itemColor || !leadColor) return false;
  const item = normalizeColorBase(itemColor, !!leadTrim);
  const lead = normalizeColorBase(leadColor, !!leadTrim);
  if (!item || !lead) return false;
  const aliases = COLOR_ALIASES[lead];
  if (leadTrim) {
    const itemTrim = extractTrimToken(itemColor);
    if (itemTrim !== leadTrim) return false;
  }
  if (aliases && aliases.length > 0) {
    const hasAliasMatch = aliases.some(a => item.includes(normalizeColorBase(a, !!leadTrim)));
    if (hasAliasMatch) return true;
  }
  return hasStrongColorTokenMatch(itemColor, leadColor, leadTrim);
}

function getLastInboundBody(conv: any): string | null {
  const msg = conv.messages?.slice().reverse().find((m: any) => m.direction === "in");
  return msg?.body ?? null;
}

function getLastInboundMessage(conv: any): any | null {
  const msg = conv.messages?.slice().reverse().find((m: any) => m.direction === "in");
  return msg ?? null;
}

function findConversationByOutcomeToken(token: string): any | null {
  if (!token) return null;
  const convs = getAllConversations();
  return (
    convs.find(
      (c: any) =>
        c?.appointment?.staffNotify?.outcomeToken === token ||
        c?.dealerRide?.staffNotify?.outcomeToken === token
    ) ?? null
  );
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

function shouldAskForTown(text: string): boolean {
  const t = String(text ?? "").trim().toLowerCase();
  if (!t) return true;
  if (/\b(\d+)\s*(min|mins|minutes|hour|hours|hr|hrs|mile|miles)\b/.test(t)) return true;
  if (/\b(street|st\.|road|rd\.|avenue|ave\.|blvd|boulevard|drive|dr\.|lane|ln\.|route|rt\.|highway|hwy|pkwy|parkway)\b/.test(t)) {
    return true;
  }
  return false;
}

function extractTownFromMessage(text: string): string | null {
  const raw = String(text ?? "").trim();
  if (!raw) return null;
  const match = raw.match(
    /\b(?:i(?:'m| am)?\s+in|i\s+live\s+in|from|located in|out of)\s+([A-Za-z][A-Za-z .'-]{1,40})/i
  );
  let town = match?.[1] ?? "";
  if (!town) {
    if (
      /^[A-Za-z][A-Za-z .'-]{1,30}$/.test(raw) &&
      !/\b(street|st\.|road|rd\.|avenue|ave\.|blvd|boulevard|drive|dr\.|lane|ln\.|route|rt\.|highway|hwy|pkwy|parkway)\b/i.test(
        raw
      )
    ) {
      town = raw;
    }
  }
  if (!town) return null;
  town = town
    .split(/,|\(|\)|\s+so\b|\s+but\b|\s+and\b|\s+lol\b/i)[0]
    .trim();
  return town ? toTitleCase(town) : null;
}

function inferPickupTownFromHistory(conv: any): string | null {
  const msgs = conv?.messages ?? [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m?.direction !== "in") continue;
    const town = extractTownFromMessage(m.body);
    if (town) return town;
  }
  return null;
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

function pickVariantByKey(key: string | null | undefined, variants: string[]): string {
  if (!variants.length) return "";
  const raw = String(key ?? "");
  if (!raw) return variants[0];
  let hash = 0;
  for (let i = 0; i < raw.length; i += 1) {
    hash = (hash + raw.charCodeAt(i)) % variants.length;
  }
  return variants[hash];
}

function formatDatePartsIso(parts: { year: number; month: number; day: number }): string {
  const yyyy = String(parts.year).padStart(4, "0");
  const mm = String(parts.month).padStart(2, "0");
  const dd = String(parts.day).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function nextLocalDateForWeekday(dayName: string, timeZone: string): { year: number; month: number; day: number } | null {
  for (let i = 0; i <= 7; i += 1) {
    const d = new Date();
    d.setDate(d.getDate() + i);
    if (dayKey(d, timeZone) === dayName) {
      const parts = getLocalDateParts(d, timeZone);
      return { year: parts.year, month: parts.month, day: parts.day };
    }
  }
  return null;
}

function formatModelLabel(year?: string | null, model?: string | null): string {
  const yr = year ? `${year} ` : "";
  const clean = normalizeDisplayCase(model) || "that model";
  return `${yr}${clean}`.trim();
}

function formatModelLabelForFollowUp(_year?: string | null, model?: string | null): string {
  if (!model || /full line/i.test(model)) return "the bike";
  const base = normalizeDisplayCase(model);
  return /^the\s/i.test(base) ? base : `the ${base}`;
}

function formatModelToken(model?: string | null): string {
  if (!model || /full line|other/i.test(String(model))) return "bike";
  return normalizeDisplayCase(model);
}

function normalizeModelText(val?: string | null): string {
  const source = String(val ?? "").toLowerCase();
  const withoutAnniversarySuffix = source
    // Treat "<model> / anniversary edition" as one model variant, not two bikes.
    .replace(/\s*\/\s*anniversary\s+edition\b/g, " ")
    .replace(/\banniversary\s+edition\b/g, " ")
    .replace(/\banniversary\b/g, " ");
  return withoutAnniversarySuffix
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const SPEC_SIGNAL_TERMS = [
  "spec",
  "specs",
  "spec sheet",
  "feature",
  "features",
  "highlight",
  "highlights",
  "details",
  "info",
  "information",
  "engine",
  "motor",
  "powertrain",
  "horsepower",
  "hp",
  "torque",
  "displacement",
  "transmission",
  "gearbox",
  "gear",
  "gears",
  "tech",
  "electronics",
  "infotainment",
  "audio",
  "audio system",
  "sound",
  "sound system",
  "stereo",
  "speaker",
  "speaker system",
  "speakers",
  "display",
  "screen",
  "safety",
  "dimensions",
  "weight",
  "seat height",
  "fuel capacity",
  "gas tank",
  "tank size",
  "tank capacity",
  "wheelbase",
  "rake",
  "trail",
  "accessories",
  "trim",
  "suspension",
  "brakes",
  "cruise control",
  "ride mode",
  "ride modes"
];

const INFOTAINMENT_TERMS = [
  "infotainment",
  "audio",
  "audio system",
  "sound",
  "sound system",
  "stereo",
  "speakers",
  "speaker",
  "speaker system",
  "screen",
  "display",
  "apple carplay",
  "android auto"
];

const SPEC_NEEDLE_ALIASES: Record<string, string[]> = {
  "infotainment system": ["infotainment system", "infotainment", "sound system", "stereo", "audio"],
  infotainment: ["infotainment", "sound system", "stereo", "audio"],
  "screen size": ["screen size", "display size", "screen", "display"],
  display: ["display", "screen", "touchscreen", "touch screen"],
  speakers: ["speakers", "speaker count", "speaker"],
  "speaker size": ["speaker size", "speaker diameter"],
  "voice recognition": ["voice recognition", "voice control", "voice command"]
};

function specTermToRegex(term: string): RegExp {
  const normalized = term.trim().toLowerCase().replace(/\s+/g, " ");
  const pattern = escapeRegex(normalized).replace(/\\ /g, "\\s+");
  return new RegExp(`\\b${pattern}\\b`, "i");
}

function hasAnySpecTerm(text: string, terms: string[]): boolean {
  const source = String(text ?? "");
  if (!source) return false;
  return terms.some(term => specTermToRegex(term).test(source));
}

function hasSpecsSignal(text: string): boolean {
  return hasAnySpecTerm(text, SPEC_SIGNAL_TERMS);
}

function hasInfotainmentSignal(text: string): boolean {
  return hasAnySpecTerm(text, INFOTAINMENT_TERMS);
}

function extractSpecsFocus(text: string): "engine" | "features" | "dimensions" | "accessories" | null {
  const t = String(text ?? "");
  if (
    hasAnySpecTerm(t, [
      "engine",
      "motor",
      "powertrain",
      "performance",
      "horsepower",
      "hp",
      "torque",
      "displacement",
      "transmission",
      "gearbox",
      "gear",
      "gears"
    ])
  ) {
    return "engine";
  }
  if (
    hasAnySpecTerm(t, [
      "feature",
      "features",
      "tech",
      "electronics",
      "infotainment",
      "audio",
      "audio system",
      "sound",
      "sound system",
      "stereo",
      "speaker",
      "speaker system",
      "screen",
      "display",
      "safety",
      "navigation",
      "apple carplay",
      "android auto",
      "ride mode",
      "ride modes",
      "cruise control",
      "suspension",
      "brakes"
    ])
  ) {
    return "features";
  }
  if (
    hasAnySpecTerm(t, [
      "dimension",
      "dimensions",
      "weight",
      "seat height",
      "fuel capacity",
      "gas tank",
      "tank size",
      "tank capacity",
      "wheelbase",
      "rake",
      "trail",
      "length",
      "height",
      "width"
    ])
  ) {
    return "dimensions";
  }
  if (hasAnySpecTerm(t, ["accessories", "trim", "finish", "package"])) return "accessories";
  return null;
}

function normalizeSpecValue(value: string): string {
  return String(value ?? "")
    .replace(/\u00ae/g, "")
    .replace(/®/g, "")
    .replace(/\s+/g, " ")
    .replace(/\s*\/\s*/g, " / ")
    .replace(/\s*@\s*/g, " @ ")
    .trim();
}

function formatRpmValue(value: string): string {
  const normalized = normalizeSpecValue(value);
  const digitsOnly = normalized.replace(/[^\d]/g, "");
  const asNumber = Number(digitsOnly);
  if (Number.isFinite(asNumber) && asNumber >= 500 && asNumber <= 15000) {
    return `${asNumber.toLocaleString("en-US")} rpm`;
  }
  return normalized;
}

function formatSpecPhrase(key: string, value: string): string {
  const lk = key.toLowerCase();
  const v = normalizeSpecValue(value);
  if (!v) return "";
  if (lk.includes("horsepower")) {
    if (/^\d{3,5}$/.test(v)) return `horsepower peak at ${formatRpmValue(v)}`;
    if (/\bhp\b|\bkw\b/i.test(v)) return `${v} output`;
    return `${v} horsepower`;
  }
  if (lk.includes("torque")) {
    if (/\bj1349\b/i.test(v)) return "";
    if (lk.includes("rpm") || /^\d{3,5}$/.test(v)) return `torque peak at ${formatRpmValue(v)}`;
    return /\b(ft|lb|nm)\b/i.test(v) ? `${v} torque` : `torque ${v}`;
  }
  if (lk.includes("displacement")) return `${v} displacement`;
  if (lk.includes("fuel capacity") || lk.includes("tank capacity") || lk.includes("fuel tank")) return `fuel capacity ${v}`;
  if (lk.includes("seat height")) return `seat height ${v}`;
  if (lk.includes("wheelbase")) return `wheelbase ${v}`;
  if (lk.includes("weight")) return `weight ${v}`;
  if (lk.includes("rake")) return `rake ${v}`;
  if (lk.includes("trail")) return `trail ${v}`;
  if (lk.includes("length")) return `length ${v}`;
  if (lk.includes("width")) return `width ${v}`;
  if (lk.includes("height")) return `height ${v}`;
  if (lk.includes("transmission") || lk.includes("gearbox") || lk.includes("gear ratio")) return `transmission ${v}`;
  if (lk.includes("engine")) {
    return /engine|motor/i.test(v) ? v : `${v} engine`;
  }
  if (lk.includes("infotainment")) return `infotainment system ${v}`;
  if (lk.includes("screen") || lk.includes("display")) return `${v} screen`;
  if (lk.includes("speaker")) return `speakers ${v}`;
  return `${key.toLowerCase()} ${v}`;
}

function joinNatural(parts: string[]): string {
  if (parts.length === 1) return parts[0];
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join(", ")}, and ${parts[parts.length - 1]}`;
}

function formatSpecsSentence(
  label: string,
  entries: Array<[string, string]>,
  focus?: "engine" | "features" | "dimensions" | "accessories"
): string {
  const lead = label === "the bike" ? "the bike" : `the ${label}`;
  const intro =
    focus === "engine"
      ? `Quick engine details on ${lead}:`
      : focus === "features"
        ? `Tech highlights on ${lead}:`
        : focus === "dimensions"
          ? `Key dimensions on ${lead}:`
          : focus === "accessories"
            ? `Trim/finish details on ${lead}:`
            : `Quick specs on ${lead}:`;
  const phrases = entries.map(([k, v]) => formatSpecPhrase(k, v)).filter(Boolean);
  return `${intro} ${joinNatural(phrases)}.`;
}

function findSpecEntry(
  specs: Record<string, string>,
  matcher: (keyLower: string, value: string) => boolean
): [string, string] | null {
  for (const [key, raw] of Object.entries(specs)) {
    const value = normalizeSpecValue(raw);
    if (!value) continue;
    if (matcher(key.toLowerCase(), value)) return [key, value];
  }
  return null;
}

function buildEngineSpecsSummary(label: string, specs: Record<string, string>, maxItems: number): string | null {
  const lead = label === "the bike" ? "the bike" : `the ${label}`;
  const engine = findSpecEntry(specs, (k, v) => /(engine|motor)/.test(k) && !/\bj1349\b/i.test(v));
  const displacement = findSpecEntry(specs, k => /displacement/.test(k));
  const torque = findSpecEntry(
    specs,
    (k, v) => /torque/.test(k) && !/rpm/.test(k) && /\b(ft|lb|nm)\b/i.test(v) && !/\bj1349\b/i.test(v)
  );
  const torqueRpm = findSpecEntry(
    specs,
    (k, v) => (/torque/.test(k) && /rpm/.test(k)) || (/torque/.test(k) && /^\d{3,5}$/.test(v))
  );
  const horsepower = findSpecEntry(specs, k => /horsepower/.test(k));

  const parts: string[] = [];
  if (engine) parts.push(formatSpecPhrase(engine[0], engine[1]));
  if (displacement) parts.push(formatSpecPhrase(displacement[0], displacement[1]));
  if (torque) {
    const torqueBase = formatSpecPhrase(torque[0], torque[1]);
    const torqueAt = torqueRpm ? formatRpmValue(torqueRpm[1]) : "";
    parts.push(torqueAt ? `${torqueBase} @ ${torqueAt}` : torqueBase);
  } else if (torqueRpm) {
    parts.push(formatSpecPhrase(torqueRpm[0], torqueRpm[1]));
  }
  if (horsepower) parts.push(formatSpecPhrase(horsepower[0], horsepower[1]));

  const cleaned = parts.filter(Boolean).slice(0, Math.max(1, maxItems));
  if (!cleaned.length) return null;
  return `Quick engine details on ${lead}: ${joinNatural(cleaned)}.`;
}

function buildFocusedSpecsSummary(
  label: string,
  specs: Record<string, string>,
  focus: "engine" | "features" | "dimensions" | "accessories" | null,
  maxItems: number
): string {
  if (!focus) return buildSpecsSummary(label, specs, maxItems);
  if (focus === "engine") {
    const engineSummary = buildEngineSpecsSummary(label, specs, maxItems);
    if (engineSummary) return engineSummary;
  }
  const focusKeys: Record<string, string[]> = {
    engine: ["engine", "displacement", "horsepower", "torque", "performance"],
    features: [
      "infotainment",
      "screen",
      "display",
      "audio",
      "sound",
      "stereo",
      "speaker",
      "navigation",
      "tech",
      "electronics",
      "safety",
      "suspension",
      "brake",
      "ride mode",
      "cruise"
    ],
    dimensions: [
      "weight",
      "seat height",
      "fuel capacity",
      "tank capacity",
      "fuel tank",
      "wheelbase",
      "rake",
      "trail",
      "length",
      "height",
      "width"
    ],
    accessories: ["accessories", "trim", "finish", "package"]
  };
  const wanted = focusKeys[focus] ?? [];
  const entries: Array<[string, string]> = [];
  for (const key of Object.keys(specs)) {
    const lk = key.toLowerCase();
    if (wanted.some(w => lk.includes(w))) {
      entries.push([key, specs[key]]);
    }
    if (entries.length >= maxItems) break;
  }
  if (!entries.length) return buildSpecsSummary(label, specs, maxItems);
  return formatSpecsSentence(label, entries, focus);
}

function findSpecValue(specs: Record<string, string>, needles: string[]): string | null {
  const wanted = needles
    .flatMap(needle => {
      const normalizedNeedle = needle.toLowerCase();
      return [normalizedNeedle, ...(SPEC_NEEDLE_ALIASES[normalizedNeedle] ?? [])];
    })
    .map(n => n.toLowerCase());
  for (const key of Object.keys(specs)) {
    const lk = key.toLowerCase();
    if (wanted.some(n => lk.includes(n))) {
      return specs[key];
    }
  }
  return null;
}

function buildInfotainmentSummary(label: string, specs: Record<string, string>): string | null {
  const system = findSpecValue(specs, ["infotainment system", "infotainment"]);
  const screen = findSpecValue(specs, ["screen size", "display"]);
  const speakers = findSpecValue(specs, ["speakers"]);
  const speakerSize = findSpecValue(specs, ["speaker size"]);
  const voice = findSpecValue(specs, ["voice recognition"]);

  if (!system && !screen && !speakers && !speakerSize) return null;

  const baseLabel = label ? `${label} has` : "It has";
  const systemLabel = system ?? "an infotainment system";
  const screenLabel = screen ? ` with a ${screen} screen` : "";
  const firstSentence = `Yes — ${baseLabel} ${systemLabel}${screenLabel}.`;

  const audioBits: string[] = [];
  if (speakers) audioBits.push(`${speakers} speakers`);
  if (speakerSize) audioBits.push(speakerSize);
  const audioSentence = audioBits.length ? `Audio is ${audioBits.join(" — ")}.` : null;

  let voiceSentence: string | null = null;
  if (voice && voice.length < 80) {
    voiceSentence = `Voice recognition: ${voice}.`;
  }

  return [firstSentence, audioSentence, voiceSentence].filter(Boolean).join(" ");
}

function isCompareRequest(text: string): boolean {
  const t = String(text ?? "").toLowerCase();
  return (
    /\b(compare|comparison|vs\.?|versus)\b/.test(t) ||
    /\b(difference between|difference in|what'?s the difference|what is the difference)\b/.test(t)
  );
}

function isInfoOnlyRequest(text: string): boolean {
  const t = String(text ?? "");
  return (
    /\b(just want to know|just want info|just want to learn|want to know about|tell me about|more info|more information|details on|information on)\b/.test(
      t
    ) || hasSpecsSignal(t)
  );
}

function findMentionedModel(text: string): string | null {
  const t = normalizeModelText(text);
  const models = getHarleyModelLexicon();
  if (!t || !models.length) return null;
  const matches = models.filter(m => t.includes(normalizeModelText(m)));
  if (!matches.length) return null;
  matches.sort((a, b) => b.length - a.length);
  return matches[0] ?? null;
}

function findMentionedModels(text: string): string[] {
  const t = normalizeModelText(text);
  const models = getHarleyModelLexicon();
  if (!t || !models.length) return [];
  const sorted = [...models].sort((a, b) => b.length - a.length);
  const found: string[] = [];
  for (const model of sorted) {
    const normalized = normalizeModelText(model);
    if (!normalized || !t.includes(normalized)) continue;
    const alreadyCovered = found.some(existing =>
      normalizeModelText(existing).includes(normalized)
    );
    if (alreadyCovered) continue;
    found.push(model);
  }
  return found;
}

async function canOfferTestRideForLead(lead: any, dealerProfile: any): Promise<boolean> {
  const hasLicense = lead?.hasMotoLicense;
  if (hasLicense === false) return false;
  if (!isTestRideSeason(dealerProfile, new Date())) return false;
  const model = lead?.vehicle?.model ?? lead?.vehicle?.description ?? null;
  if (!model || /full line|other/i.test(String(model))) return false;
  const year = lead?.vehicle?.year ?? null;
  return hasInventoryForModelYear({ model, year, yearDelta: 1 });
}

const DEFAULT_HARLEY_MODELS = [
  "CVO Road Glide ST",
  "CVO Street Glide ST",
  "CVO Street Glide Limited",
  "CVO Street Glide 3",
  "CVO Street Glide 3 Limited",
  "Road Glide 3",
  "Road Glide III",
  "Road Glide Limited",
  "Road Glide",
  "Street Glide Limited",
  "Street Glide",
  "Street Glide Ultra",
  "Street Glide Solo",
  "Road Glide Solo",
  "Heritage",
  "Switchback",
  "Seventy-Two",
  "72",
  "Iron 1200",
  "Sportster S",
  "Nightster S",
  "Pan Am",
  "Pan America ST",
  "Pan Am ST",
  "Heritage Classic Liberty Edition",
  "Heritage Liberty",
  "Heritage Classic Liberty",
  "Street Glide Liberty",
  "Street Glide Liberty Edition",
  "Street Glide 3",
  "Pan America Special",
  "Pan America Limited",
  "CVO Road Glide",
  "CVO Street Glide",
  "Road Glide ST",
  "Street Glide ST",
  "Road Glide",
  "Street Glide",
  "Road King",
  "Heritage Classic",
  "Fat Boy",
  "Low Rider ST",
  "Low Rider S",
  "Low Rider",
  "Sportster",
  "Street Bob",
  "Breakout",
  "Softail Standard",
  "Nightster",
  "Pan America",
  "Electra Glide",
  "Ultra Limited",
  "Tri Glide",
  "Freewheeler",
  "Forty-Eight",
  "Iron 883",
  "Fat Bob",
  "Softail"
];

function getHarleyModelLexicon(): string[] {
  const fromYear = getAllModels();
  if (fromYear.length) return Array.from(new Set([...fromYear, ...DEFAULT_HARLEY_MODELS]));
  return DEFAULT_HARLEY_MODELS;
}

async function inferModelsFromText(text: string): Promise<string[]> {
  const t = text.toLowerCase();
  let candidates: string[] = [];
  try {
    const items = await getInventoryFeedHot();
    candidates = items.map(i => i.model).filter(Boolean) as string[];
  } catch {
    candidates = [];
  }
  candidates = Array.from(new Set([...candidates, ...getHarleyModelLexicon()]));
  candidates.sort((a, b) => b.length - a.length);
  const matches = candidates.filter(m => t.includes(m.toLowerCase())).map(m => m.trim());
  return Array.from(new Set(matches));
}

function pickBestMatch(
  matches: Array<{ images?: string[]; color?: string }>,
  leadColor?: string | null
): { url?: string; date: Date | null; color?: string } | null {
  const leadTrim = extractTrimToken(leadColor ?? null);
  const pool = leadColor
    ? matches.filter(
        m =>
          colorMatchesExact(m.color, leadColor, leadTrim) ||
          colorMatchesAlias(m.color, leadColor, leadTrim)
      )
    : matches;
  if (leadColor && pool.length === 0) return null;
  for (const m of pool) {
    const url = m.images?.find(u => /^https?:\/\//i.test(u));
    if (url) return { url, date: extractImageDate(url), color: m.color };
  }
  if (!pool.length) return null;
  const fallback = pool[0];
  const url = fallback.images?.find(u => /^https?:\/\//i.test(u));
  return { url, date: url ? extractImageDate(url) : null, color: fallback.color };
}

function formatColorLabel(value?: string | null): string | null {
  if (!value) return null;
  const cleaned = value.trim();
  if (!cleaned) return null;
  return cleaned
    .toLowerCase()
    .split(/\s+/)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function pickClosestInventoryItem(
  items: Array<{ year?: string; images?: string[]; color?: string }>,
  targetYear?: string | null,
  leadColor?: string | null
): { item?: any; imageUrl?: string | null } | null {
  if (!items.length) return null;
  const leadTrim = extractTrimToken(leadColor ?? null);
  let pool = items.slice();
  if (leadColor) {
    const colorPool = pool.filter(
      i =>
        colorMatchesExact(i.color, leadColor, leadTrim) ||
        colorMatchesAlias(i.color, leadColor, leadTrim)
    );
    if (colorPool.length) pool = colorPool;
  }
  const withImages = pool.filter(i => Array.isArray(i.images) && i.images.length > 0);
  if (withImages.length) pool = withImages;
  const targetYearNum = targetYear ? Number(targetYear) : null;
  pool.sort((a, b) => {
    const aYear = Number(a.year);
    const bYear = Number(b.year);
    const aDiff =
      targetYearNum && Number.isFinite(targetYearNum) && Number.isFinite(aYear)
        ? Math.abs(aYear - targetYearNum)
        : 9999;
    const bDiff =
      targetYearNum && Number.isFinite(targetYearNum) && Number.isFinite(bYear)
        ? Math.abs(bYear - targetYearNum)
        : 9999;
    if (aDiff !== bDiff) return aDiff - bDiff;
    if (Number.isFinite(aYear) && Number.isFinite(bYear) && aYear !== bYear) return bYear - aYear;
    return 0;
  });
  const picked = pool[0];
  if (!picked) return null;
  const imageUrl = picked.images?.find((u: string) => /^https?:\/\//i.test(u)) ?? null;
  return { item: picked, imageUrl };
}

function isRecent(date: Date | null, days: number): boolean {
  if (!date) return false;
  const ageMs = Date.now() - date.getTime();
  return ageMs >= 0 && ageMs <= days * 24 * 60 * 60 * 1000;
}

async function buildLateFollowUp(
  conv: any,
  stepIndex: number,
  dealerProfile: any
): Promise<{ body: string; mediaUrls?: string[] }> {
  const lead = conv.lead ?? {};
  const year = lead?.vehicle?.year ?? null;
  const model = lead?.vehicle?.model ?? null;
  const leadColor =
    lead?.vehicle?.color ??
    extractColorFromDescription(lead?.vehicle?.description, lead?.vehicle?.stockId ?? null) ??
    extractColorMention(getLastInboundBody(conv)) ??
    extractColorMention(lead?.vehicle?.description);
  const name = lead?.firstName ?? null;
  const greeting = name ? `Hi ${name} — ` : "";
  const label = formatModelLabel(year, model);

  let matches: any[] = [];
  if (model) {
    matches = await findInventoryMatches({ year, model });
  }

  const hasMatch = matches.length > 0;
  const imagePick = pickBestMatch(matches, leadColor ?? null);
  const leadTrim = extractTrimToken(leadColor ?? null);
  const colorLabelRaw =
    leadColor &&
    (colorMatchesExact(imagePick?.color, leadColor, leadTrim) ||
      colorMatchesAlias(imagePick?.color, leadColor, leadTrim) ||
      !imagePick?.color)
      ? leadColor
      : imagePick?.color ?? null;
  const hasRecentInventory = imagePick ? isRecent(imagePick.date, 45) : false;
  const testRideOk = isTestRideSeason(dealerProfile, new Date());
  const canTestRide =
    testRideOk &&
    !!model &&
    !/full line|other/i.test(model) &&
    (await hasInventoryForModelYear({ model, year, yearDelta: 1 }));

  if (stepIndex === 10) {
    if (!hasMatch && !testRideOk) {
      return {
        body: `${greeting}Just checking in on the ${label}. If you’re still looking, I can keep an eye out or set a time to stop in. What day and time works for you?`
      };
    }
    if (hasMatch && hasRecentInventory) {
      return {
        body: `${greeting}We just got a ${label} in. Want to come see it? What day and time works for you?`
      };
    }
    if (hasMatch) {
      return {
        body: `${greeting}We have ${label} in stock. Want to stop by and take a look? What day and time works for you?`
      };
    }
    return {
      body: `${greeting}Just checking in on the ${label}. If you’re still looking, I can keep an eye out or set a time to stop in. What day and time works for you?`
    };
  }

  if (stepIndex === 11) {
    if (!hasMatch && !testRideOk) {
      return {
        body: `${greeting}If you’re still shopping, I can help compare options or set a quick visit. What day and time works for you?`
      };
    }
    if (colorLabelRaw && imagePick?.url && hasMatch) {
      const colorLabel = colorLabelRaw.charAt(0).toUpperCase() + colorLabelRaw.slice(1);
      const mentionLead =
        !!leadColor &&
        (colorMatchesExact(colorLabelRaw, leadColor, leadTrim) ||
          colorMatchesAlias(colorLabelRaw, leadColor, leadTrim));
      const prefix = mentionLead
        ? `You mentioned ${colorLabel}. `
        : `Here’s a ${colorLabel} ${label} we have right now. `;
      const body = mentionLead
        ? `${greeting}${prefix}Here’s a ${colorLabel} ${label} we have right now. Want to take a look?`
        : `${greeting}${prefix}Want to take a look?`;
      return {
        body,
        mediaUrls: [imagePick.url]
      };
    }
    if (canTestRide) {
      return {
        body: `${greeting}If you want to take one for a ride, I can set up a test ride for a ${label}. What day and time works for you?`
      };
    }
    if (hasMatch) {
      return {
        body: `${greeting}Still interested in a ${label}? I can send a quick walkaround or set a time to stop in. What day and time works for you?`
      };
    }
    return {
      body: `${greeting}If you’re still shopping, I can help compare options or set a quick visit. What day and time works for you?`
    };
  }

  if (stepIndex === 12) {
    if (!hasMatch && !testRideOk) {
      return {
      body: `${greeting}Should I keep this open or close it out? If you’re still looking, I’m happy to help.`
    };
  }
  if (canTestRide) {
    return {
      body: `${greeting}Test rides are open right now. Want me to reserve a time for you?`
    };
  }
    return {
      body: `${greeting}Should I keep this open or close it out? If you’re still looking, I’m happy to help.`
    };
  }

  return {
    body: `${greeting}${FOLLOW_UP_MESSAGES[FOLLOW_UP_MESSAGES.length - 1]}`
  };
}

async function buildLongTermFollowUp(
  conv: any,
  dealerProfile: any
): Promise<{ body: string; mediaUrls?: string[] }> {
  const lead = conv.lead ?? {};
  const year = lead?.vehicle?.year ?? null;
  const model = lead?.vehicle?.model ?? null;
  const leadColor =
    lead?.vehicle?.color ??
    extractColorFromDescription(lead?.vehicle?.description, lead?.vehicle?.stockId ?? null) ??
    extractColorMention(getLastInboundBody(conv)) ??
    extractColorMention(lead?.vehicle?.description);
  const name = lead?.firstName ?? null;
  const greeting = name ? `Hi ${name} — ` : "";
  const label = formatModelLabel(year, model);
  const timeframe = lead?.purchaseTimeframe ? lead.purchaseTimeframe.trim() : "a future";

  let matches: any[] = [];
  if (model) {
    matches = await findInventoryMatches({ year, model });
  }
  const imagePick = pickBestMatch(matches, leadColor ?? null);
  const leadTrim = extractTrimToken(leadColor ?? null);
  const colorLabelRaw =
    leadColor &&
    (colorMatchesExact(imagePick?.color, leadColor, leadTrim) ||
      colorMatchesAlias(imagePick?.color, leadColor, leadTrim) ||
      !imagePick?.color)
      ? leadColor
      : imagePick?.color ?? null;
  const canTestRide = await canOfferTestRideForLead(lead, dealerProfile);
  const financingDeclined =
    conv?.followUp?.reason === "financing_declined" ||
    conv?.appointment?.staffNotify?.outcome?.status === "financing_declined";

  if (financingDeclined) {
    return {
      body: `${greeting}Just checking in. If you want to revisit options at any point, I’m here.`
    };
  }

  if (imagePick?.url) {
    const colorLabel = colorLabelRaw ? colorLabelRaw.charAt(0).toUpperCase() + colorLabelRaw.slice(1) : null;
    const itemLabel = colorLabel ? `${colorLabel} ${label}` : label;
    return {
      body: `${greeting}You mentioned a ${timeframe} timeline. We have a ${itemLabel} in stock now. Want to take a look?`,
      mediaUrls: [imagePick.url]
    };
  }

  if (canTestRide) {
    return {
      body: `${greeting}You mentioned a ${timeframe} timeline. I’m here when you’re ready. Just reach out when the time is right.`
    };
  }

  return {
    body: `${greeting}You mentioned a ${timeframe} timeline. I’m here when you’re ready. Just reach out when the time is right.`
  };
}

function isOptOut(text: string): boolean {
  const t = text.trim().toLowerCase();
  return (
    t === "stop" ||
    t === "unsubscribe" ||
    t === "cancel" ||
    /do not text|dont text/.test(t)
  );
}

function isWatchAlertStopIntent(text: string): boolean {
  const t = String(text ?? "")
    .trim()
    .toLowerCase()
    .replace(/[’]/g, "'");
  if (!t) return false;

  const hasStopAction =
    /\b(stop|cancel|remove|delete|turn off|pause|disable|end|no more|don't|dont|do not)\b/.test(t);
  if (!hasStopAction) return false;

  const hasWatchContext =
    /\b(watch(?:es)?|watchlist|inventory|availability|alert(?:s)?|update(?:s)?|notification(?:s)?)\b/.test(
      t
    ) ||
    /\b(keep an eye out|notify me|text me)\b/.test(t) ||
    /\b(comes in|in stock|available|one lands)\b/.test(t);
  if (!hasWatchContext) return false;

  return (
    /\b(stop|cancel|remove|delete|turn off|pause|disable|end)\b[\s\w-]{0,24}\b(watch(?:es)?|watchlist|inventory alerts?|availability alerts?|alerts?|updates?|notifications?)\b/.test(
      t
    ) ||
    /\bno more\b[\s\w-]{0,20}\b(watch(?:es)?|alerts?|updates?|notifications?)\b/.test(t) ||
    /\b(don't|dont|do not)\b[\s\w-]{0,24}\b(keep an eye out|notify me|watch for)\b/.test(t) ||
    /\b(stop|don't|dont|do not)\b[\s\w-]{0,20}\btext(?:ing)? me\b[\s\w-]{0,24}\b(if|when)\b[\s\w-]{0,20}\b(comes in|in stock|available|lands)\b/.test(
      t
    )
  );
}

function isNotInterested(text: string): boolean {
  const t = text.trim().toLowerCase();
  return /not interested|no longer interested|no thanks|no thank you|already bought|already purchased|bought elsewhere|purchased elsewhere|found one|got one|no longer shopping|not looking/.test(
    t
  );
}

function isPendingComplaint(text: string): boolean {
  const t = text.trim().toLowerCase();
  return /sale pending|still pending|been pending|pending for|pending too long|what is going on/.test(
    t
  );
}

function normalizePhone(raw: string): string {
  const trimmed = String(raw ?? "").trim();
  const digits = trimmed.replace(/\D/g, "");
  if (trimmed.startsWith("+")) return trimmed;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length > 10) return `+${digits}`;
  return trimmed;
}

function inferExtensionFromMedia(contentType: string | null, sourceUrl: string): string {
  const ct = String(contentType ?? "").toLowerCase();
  if (ct.includes("jpeg")) return "jpg";
  if (ct.includes("png")) return "png";
  if (ct.includes("gif")) return "gif";
  if (ct.includes("webp")) return "webp";
  if (ct.includes("heic")) return "heic";
  if (ct.includes("heif")) return "heif";
  if (ct.includes("bmp")) return "bmp";
  if (ct.includes("svg")) return "svg";
  if (ct.includes("pdf")) return "pdf";
  if (ct.includes("mp4")) return "mp4";
  if (ct.includes("quicktime")) return "mov";
  if (ct.includes("mpeg")) return "mpeg";
  if (ct.includes("audio")) return "mp3";
  try {
    const p = new URL(sourceUrl).pathname;
    const ext = path.extname(p).replace(".", "").toLowerCase();
    if (ext) return ext;
  } catch {
    // ignore
  }
  return "bin";
}

function inferExtensionFromBytes(buf: Buffer): string | null {
  if (!buf || buf.length < 4) return null;
  // JPEG SOI
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpg";
  // PNG
  if (
    buf.length >= 8 &&
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47 &&
    buf[4] === 0x0d &&
    buf[5] === 0x0a &&
    buf[6] === 0x1a &&
    buf[7] === 0x0a
  ) {
    return "png";
  }
  // GIF87a/GIF89a
  if (
    buf.length >= 6 &&
    buf[0] === 0x47 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x38
  ) {
    return "gif";
  }
  // WEBP: RIFF....WEBP
  if (
    buf.length >= 12 &&
    buf[0] === 0x52 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x46 &&
    buf[8] === 0x57 &&
    buf[9] === 0x45 &&
    buf[10] === 0x42 &&
    buf[11] === 0x50
  ) {
    return "webp";
  }
  // HEIC/HEIF container brands
  if (
    buf.length >= 12 &&
    buf[4] === 0x66 &&
    buf[5] === 0x74 &&
    buf[6] === 0x79 &&
    buf[7] === 0x70
  ) {
    const brand = buf.subarray(8, 12).toString("ascii").toLowerCase();
    if (brand.startsWith("hei") || brand.startsWith("mif1") || brand.startsWith("hev")) {
      return "heic";
    }
  }
  // PDF
  if (buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46) return "pdf";
  return null;
}

type TwilioInboundMediaItem = {
  url: string;
  contentType?: string;
};

async function materializeInboundTwilioMedia(
  mediaItems: TwilioInboundMediaItem[],
  providerMessageId: string,
  publicAssetBase: string
): Promise<string[]> {
  if (!Array.isArray(mediaItems) || mediaItems.length === 0) return [];
  const safeMsgId = String(providerMessageId || `mms_${Date.now()}`)
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .slice(0, 80);
  if (!safeMsgId) return mediaItems.map(m => m.url);
  const folderRel = path.join("uploads", "mms", safeMsgId);
  const folderAbs = path.resolve(getDataDir(), folderRel);
  await fs.promises.mkdir(folderAbs, { recursive: true });

  const accountSid = String(process.env.TWILIO_ACCOUNT_SID ?? "").trim();
  const authToken = String(process.env.TWILIO_AUTH_TOKEN ?? "").trim();
  const authHeader =
    accountSid && authToken
      ? `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString("base64")}`
      : "";

  const saved: string[] = [];
  for (let i = 0; i < mediaItems.length; i += 1) {
    const source = String(mediaItems[i]?.url ?? "").trim();
    const declaredType = String(mediaItems[i]?.contentType ?? "").trim() || null;
    if (!source) continue;
    let resp: Response | null = null;
    try {
      if (authHeader) {
        resp = await fetch(source, { headers: { Authorization: authHeader } });
      }
      if (!resp || !resp.ok) {
        resp = await fetch(source);
      }
      if (!resp.ok) {
        console.warn("[twilio mms] media fetch failed", { source, status: resp.status });
        saved.push(source);
        continue;
      }
      const buf = Buffer.from(await resp.arrayBuffer());
      let ext = inferExtensionFromMedia(declaredType ?? resp.headers.get("content-type"), source);
      if (ext === "bin") {
        ext = inferExtensionFromBytes(buf) ?? ext;
      }
      const fileName = `${i}.${ext}`;
      const abs = path.join(folderAbs, fileName);
      const rel = `${folderRel.replace(/\\/g, "/")}/${fileName}`;
      await fs.promises.writeFile(abs, buf);
      const cleanBase = String(publicAssetBase ?? "").replace(/\/+$/, "");
      saved.push(cleanBase ? `${cleanBase}/${rel}` : `/${rel}`);
    } catch (err: any) {
      console.warn("[twilio mms] materialize failed", { source, err: err?.message ?? err });
      saved.push(source);
    }
  }
  return saved.length ? saved : mediaItems.map(m => m.url);
}

function buildStaffOutcomeLink(token: string): string | null {
  const base = process.env.PUBLIC_BASE_URL?.replace(/\/+$/, "");
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

function summarizeConversationForStaff(conv: any): string {
  const lastInbound = String(getLastInboundBody(conv) ?? "").trim();
  if (lastInbound) {
    return lastInbound.replace(/\s+/g, " ").slice(0, 140);
  }
  const inquiry =
    conv?.lead?.inquiry ??
    conv?.lead?.notes ??
    conv?.lead?.summary ??
    "";
  return String(inquiry ?? "").replace(/\s+/g, " ").slice(0, 140);
}

async function sendInternalSms(toNumber: string, body: string): Promise<boolean> {
  const from = normalizePhone(String(process.env.TWILIO_FROM_NUMBER ?? "").trim());
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!from || !accountSid || !authToken || !toNumber.startsWith("+")) return false;
  try {
    const client = twilio(accountSid, authToken);
    await client.messages.create({ from, to: toNumber, body });
    return true;
  } catch (e: any) {
    console.warn("[staff-sms] send failed:", e?.message ?? e);
    return false;
  }
}

function ensureAppointmentOutcomeToken(appt: any): string {
  if (appt?.staffNotify?.outcomeToken) return appt.staffNotify.outcomeToken;
  const token = crypto.randomBytes(12).toString("hex");
  appt.staffNotify = appt.staffNotify ?? {};
  appt.staffNotify.outcomeToken = token;
  return token;
}

function getOutcomeStaffNotifyTarget(conv: any): any {
  if (conv?.appointment) {
    conv.appointment.staffNotify = conv.appointment.staffNotify ?? {};
    return conv.appointment.staffNotify;
  }
  conv.dealerRide = conv.dealerRide ?? {};
  conv.dealerRide.staffNotify = conv.dealerRide.staffNotify ?? {};
  return conv.dealerRide.staffNotify;
}

async function clearInventoryWatchState(conv: any, reason = "inventory_watch_clear"): Promise<void> {
  const nowIso = new Date().toISOString();
  const cfg = await getSchedulerConfigHot();
  const tz = cfg.timezone || "America/New_York";

  conv.inventoryWatch = undefined;
  conv.inventoryWatches = undefined;
  conv.inventoryWatchPending = undefined;
  if (conv.followUp?.mode === "holding_inventory") {
    setFollowUpMode(conv, "active", reason);
  }
  if (conv.followUpCadence) {
    if (conv.followUpCadence.status === "stopped") {
      conv.followUpCadence.status = "active";
      conv.followUpCadence.stopReason = undefined;
    }
    conv.followUpCadence.pausedUntil = undefined;
    conv.followUpCadence.pauseReason = undefined;
    if (!conv.followUpCadence.nextDueAt) {
      const idx = Math.min(
        conv.followUpCadence.stepIndex ?? 0,
        FOLLOW_UP_DAY_OFFSETS.length - 1
      );
      conv.followUpCadence.nextDueAt = computeFollowUpDueAt(
        conv.followUpCadence.anchorAt ?? nowIso,
        FOLLOW_UP_DAY_OFFSETS[idx],
        tz
      );
    }
  } else {
    startFollowUpCadence(conv, nowIso, tz);
  }
  if (getDialogState(conv) === "inventory_watch_active") {
    setDialogState(conv, "inventory_init");
  }
  conv.updatedAt = nowIso;
}

function escapeHtml(input: string): string {
  return String(input ?? "").replace(/[&<>"']/g, s => {
    switch (s) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case "\"":
        return "&quot;";
      case "'":
        return "&#39;";
      default:
        return s;
    }
  });
}

type OutcomeUnitInput = {
  stockId?: string;
  vin?: string;
  year?: string;
  make?: string;
  model?: string;
  trim?: string;
  color?: string;
  label?: string;
};

function buildUnitLabel(unit: OutcomeUnitInput): string | undefined {
  const label = [unit.year, unit.make, unit.model, unit.trim].filter(Boolean).join(" ").trim();
  if (label) return label;
  return unit.stockId || unit.vin || undefined;
}

function readOutcomeUnit(body: any): OutcomeUnitInput {
  const unit: OutcomeUnitInput = {
    stockId: String(body?.unitStockId ?? "").trim() || undefined,
    vin: String(body?.unitVin ?? "").trim() || undefined,
    year: String(body?.unitYear ?? "").trim() || undefined,
    make: String(body?.unitMake ?? "").trim() || undefined,
    model: String(body?.unitModel ?? "").trim() || undefined,
    trim: String(body?.unitTrim ?? "").trim() || undefined,
    color: String(body?.unitColor ?? "").trim() || undefined
  };
  unit.label = buildUnitLabel(unit);
  return unit;
}

async function applyOutcomeHold(conv: any, unit: OutcomeUnitInput, note: string | undefined, nowIso: string) {
  const holdKey = normalizeInventoryHoldKey(unit.stockId, unit.vin);
  if (!holdKey) return "Missing hold unit (stockId or VIN).";
  const createdAt = conv.hold?.createdAt ?? nowIso;
  const holdEntry = {
    id: holdKey,
    stockId: unit.stockId,
    vin: unit.vin,
    label: unit.label,
    note,
    leadKey: conv.leadKey,
    convId: conv.id,
    createdAt,
    updatedAt: nowIso
  };
  await setInventoryHold({ stockId: unit.stockId, vin: unit.vin, hold: holdEntry });
  conv.hold = {
    key: holdKey,
    stockId: unit.stockId,
    vin: unit.vin,
    label: unit.label,
    note,
    reason: "unit_hold",
    createdAt,
    updatedAt: nowIso
  };
  stopFollowUpCadence(conv, "unit_hold");
  setFollowUpMode(conv, "paused_indefinite", "unit_hold");
  return null;
}

async function applyOutcomeSold(
  conv: any,
  unit: OutcomeUnitInput,
  note: string | undefined,
  nowIso: string,
  soldById: string,
  soldByNameRaw: string
) {
  const soldKey = normalizeInventorySoldKey(unit.stockId, unit.vin);
  if (!soldKey) return "Missing sold unit (stockId or VIN).";
  const cfg = await getSchedulerConfigHot();
  const salespeople = cfg.salespeople ?? [];
  const sp = soldById ? salespeople.find(s => s.id === soldById) ?? null : null;
  conv.sale = {
    soldAt: nowIso,
    soldById: sp?.id ?? (soldById || undefined),
    soldByName: sp?.name ?? (soldByNameRaw || undefined),
    stockId: unit.stockId,
    vin: unit.vin,
    label: unit.label,
    note
  };
  conv.status = "closed";
  conv.closedAt = nowIso;
  conv.closedReason = "sold";
  markOpenTodosDoneForConversation(conv.id);
  const soldEntry = {
    id: soldKey,
    stockId: unit.stockId,
    vin: unit.vin,
    label: unit.label,
    note,
    leadKey: conv.leadKey,
    convId: conv.id,
    soldAt: nowIso,
    soldById: sp?.id ?? (soldById || undefined),
    soldByName: sp?.name ?? (soldByNameRaw || undefined),
    createdAt: conv.sale?.soldAt ?? nowIso,
    updatedAt: nowIso
  };
  await setInventorySold({ stockId: unit.stockId, vin: unit.vin, sold: soldEntry });
  await clearInventoryHold(unit.stockId, unit.vin);
  if (conv.hold?.key && conv.hold.key === soldKey) {
    conv.hold = undefined;
  }
  setFollowUpMode(conv, "active", "post_sale");
  startPostSaleCadence(conv, nowIso, cfg.timezone);
  if (conv.lead?.leadRef) {
    try {
      const soldBy = conv.sale?.soldByName || conv.sale?.soldById || "Unknown";
      const soldUnit = conv.sale?.label || conv.sale?.stockId || conv.sale?.vin || "unit";
      const tlpNote = `Sold/Delivered: ${soldUnit}. Salesperson: ${soldBy}.`;
      await tlpMarkDealershipVisitDelivered({ leadRef: conv.lead.leadRef, note: tlpNote });
    } catch (err: any) {
      const msg = `TLP delivered step failed for leadRef ${conv.lead.leadRef}. Retry in TLP or update manually.`;
      addInternalQuestion(conv.id, conv.leadKey, msg);
      console.warn("[tlp] delivered mark failed:", err?.message ?? err);
    }
  }
  return null;
}

function resolveUserByPhone(users: any[], phoneRaw: string): any | null {
  const phone = normalizePhone(phoneRaw);
  if (!phone) return null;
  for (const user of users) {
    const userPhone = normalizePhone(String(user?.phone ?? "").trim());
    if (userPhone && userPhone === phone) return user;
  }
  return null;
}

function extractOutcomeTokenFromText(text: string): string | null {
  const source = String(text ?? "");
  const tagged = source.match(/\boutcome\s+([a-f0-9]{24})\b/i)?.[1];
  if (tagged) return tagged.toLowerCase();
  const token = source.match(/\b[a-f0-9]{24}\b/i)?.[0];
  return token ? token.toLowerCase() : null;
}

function readOutcomeUnitFromText(text: string, parsed: any): OutcomeUnitInput {
  const source = String(text ?? "");
  const stockMatch = source.match(/\b([A-Z]\d{1,4}-\d{2}[A-Z]?)\b/i)?.[1] ?? "";
  const vinMatch = source.match(/\b([A-HJ-NPR-Z0-9]{17})\b/i)?.[1] ?? "";
  const unit: OutcomeUnitInput = {
    stockId: (parsed?.unitStockId ?? stockMatch)?.toString().trim() || undefined,
    vin: (parsed?.unitVin ?? vinMatch)?.toString().trim() || undefined,
    year:
      typeof parsed?.unitYear === "number" && Number.isFinite(parsed.unitYear)
        ? String(parsed.unitYear)
        : undefined,
    make: String(parsed?.unitMake ?? "").trim() || undefined,
    model: String(parsed?.unitModel ?? "").trim() || undefined,
    trim: String(parsed?.unitTrim ?? "").trim() || undefined
  };
  unit.label = buildUnitLabel(unit);
  return unit;
}

async function maybeHandleStaffOutcomeSms(event: InboundMessageEvent): Promise<{
  handled: boolean;
  replyBody?: string;
}> {
  if (event.provider !== "twilio" || event.channel !== "sms") return { handled: false };
  const body = String(event.body ?? "").trim();
  if (!body) return { handled: false };
  const token = extractOutcomeTokenFromText(body);
  if (!token) return { handled: false };

  const users = await listUsers();
  const staff = resolveUserByPhone(users, event.from ?? "");
  if (!staff) return { handled: false };

  const conv = findConversationByOutcomeToken(token);
  if (!conv) {
    return {
      handled: true,
      replyBody: "I couldn't find that outcome token. Please open the lead and resend the update."
    };
  }

  const cleanedText = body
    .replace(new RegExp(`\\boutcome\\s+${token}\\b`, "i"), "")
    .replace(new RegExp(`\\b${token}\\b`, "i"), "")
    .trim();
  const parsed = await parseStaffOutcomeUpdateWithLLM({
    text: cleanedText || body,
    history: buildHistory(conv, 10),
    lead: conv.lead
  });
  if (!parsed || !parsed.explicitOutcome || (parsed.confidence ?? 0) < 0.55 || parsed.outcome === "none") {
    return {
      handled: true,
      replyBody:
        "Please reply with: OUTCOME <token> SOLD <stock/vin> | HOLD <stock/vin> <when> | FOLLOWUP <when> | LOST <reason>."
    };
  }

  const nowIso = new Date().toISOString();
  const note = cleanedText || body;
  const unit = readOutcomeUnitFromText(cleanedText || body, parsed);
  let confirmation = "Outcome saved.";

  if (parsed.outcome === "sold") {
    const err = await applyOutcomeSold(
      conv,
      unit,
      note,
      nowIso,
      String(staff.id ?? "").trim(),
      String(staff.name ?? staff.firstName ?? "").trim()
    );
    if (err) {
      return { handled: true, replyBody: `Couldn't save SOLD: ${err}` };
    }
    confirmation = `Saved SOLD${unit.stockId ? ` (${unit.stockId})` : ""}.`;
  } else if (parsed.outcome === "hold") {
    const err = await applyOutcomeHold(conv, unit, note, nowIso);
    if (err) {
      return { handled: true, replyBody: `Couldn't save HOLD: ${err}` };
    }
    confirmation = `Saved HOLD${unit.stockId ? ` (${unit.stockId})` : ""}.`;
  } else if (parsed.outcome === "lost") {
    closeConversation(conv, "not_interested");
    setFollowUpMode(conv, "manual_handoff", "dealer_ride_lost");
    stopFollowUpCadence(conv, "manual_handoff");
    stopRelatedCadences(conv, "manual_handoff", { setMode: "manual_handoff", close: true });
    confirmation = "Saved LOST and closed the lead.";
  } else {
    setFollowUpMode(conv, "manual_handoff", "dealer_ride_follow_up");
    stopFollowUpCadence(conv, "manual_handoff");
    stopRelatedCadences(conv, "manual_handoff", { setMode: "manual_handoff" });
    confirmation = "Saved FOLLOW UP outcome.";
  }

  const outcomeTarget = getOutcomeStaffNotifyTarget(conv);
  outcomeTarget.outcome = {
    status: parsed.outcome,
    note,
    updatedAt: nowIso
  };
  outcomeTarget.contextUsedAt = nowIso;
  addTodo(conv, "note", `Dealer ride outcome by ${staff.name ?? staff.email ?? "staff"}: ${parsed.outcome}.`);
  saveConversation(conv);
  await flushConversationStore();
  return { handled: true, replyBody: confirmation };
}

async function transcribeRecordingMp3(buffer: Buffer, agentLabel = "Agent"): Promise<string | null> {
  const deepgramKey = process.env.DEEPGRAM_API_KEY?.trim();
  if (deepgramKey) {
    try {
      const resp = await fetch(
        "https://api.deepgram.com/v1/listen?multichannel=true&punctuate=true&model=nova-2&utterances=true",
        {
          method: "POST",
          headers: {
            Authorization: `Token ${deepgramKey}`,
            "Content-Type": "audio/mpeg"
          },
          body: buffer
        }
      );
      if (!resp.ok) {
        const errText = await resp.text().catch(() => "");
        console.warn("[voice] deepgram failed:", resp.status, errText);
      } else {
        const data: any = await resp.json().catch(() => null);
        const chCount = Array.isArray(data?.results?.channels) ? data.results.channels.length : 0;
        const metaChannels = data?.results?.metadata?.channels ?? null;
        console.log("[voice] deepgram channels", { count: chCount, meta: metaChannels });
        const utterances = data?.results?.utterances;
        if (Array.isArray(utterances) && utterances.length) {
          return utterances
            .map((u: any) => {
              const channel =
                typeof u.channel === "number"
                  ? u.channel
                  : typeof u.channel_index === "number"
                    ? u.channel_index
                    : null;
              let who = "";
              if (channel === 0) {
                who = agentLabel;
              } else if (channel === 1) {
                who = "Customer";
              } else if (typeof u.speaker === "number") {
                who = `Speaker ${Number(u.speaker) + 1}`;
              } else {
                who = "Speaker";
              }
              return `${who}: ${u.transcript}`;
            })
            .join("\n");
        }
        const channels = data?.results?.channels;
        if (Array.isArray(channels) && channels.length >= 2) {
          const getText = (ch: any) =>
            ch?.alternatives?.[0]?.paragraphs?.transcript ||
            ch?.alternatives?.[0]?.transcript ||
            "";
          const agentText = getText(channels[0]);
          const customerText = getText(channels[1]);
          const parts: string[] = [];
          if (agentText) parts.push(`Agent: ${agentText}`);
          if (customerText) parts.push(`Customer: ${customerText}`);
          if (parts.length) return parts.join("\n");
        }
        const fallback = channels?.[0]?.alternatives?.[0]?.transcript;
        if (typeof fallback === "string" && fallback.trim()) return fallback.trim();
      }
    } catch (err: any) {
      console.warn("[voice] deepgram error:", err?.message ?? err);
    }
  }

  if (!process.env.OPENAI_API_KEY) return null;
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const tmpPath = path.join(
    os.tmpdir(),
    `call-${Date.now()}-${Math.random().toString(16).slice(2)}.mp3`
  );
  try {
    await fs.promises.writeFile(tmpPath, buffer);
    const file = fs.createReadStream(tmpPath);
    const resp = await client.audio.transcriptions.create({
      file,
      model: "whisper-1"
    });
    return resp.text?.trim() || null;
  } catch (err: any) {
    console.warn("[voice] transcription failed:", err?.message ?? err);
    return null;
  } finally {
    fs.promises.unlink(tmpPath).catch(() => null);
  }
}

async function transcribeAudioBuffer(buffer: Buffer, mimeType?: string): Promise<string | null> {
  const deepgramKey = process.env.DEEPGRAM_API_KEY?.trim();
  if (!deepgramKey) return null;
  try {
    const resp = await fetch("https://api.deepgram.com/v1/listen?punctuate=true&model=nova-2", {
      method: "POST",
      headers: {
        Authorization: `Token ${deepgramKey}`,
        "Content-Type": mimeType || "application/octet-stream"
      },
      body: buffer
    });
    if (!resp.ok) {
      const errText = await resp.text().catch(() => "");
      console.warn("[voice] deepgram note failed:", resp.status, errText);
      return null;
    }
    const data: any = await resp.json().catch(() => null);
    const transcript =
      data?.results?.channels?.[0]?.alternatives?.[0]?.transcript ??
      data?.results?.channels?.[0]?.alternatives?.[0]?.text ??
      "";
    const cleaned = String(transcript ?? "").trim();
    return cleaned || null;
  } catch (e: any) {
    console.warn("[voice] deepgram note error:", e?.message ?? e);
    return null;
  }
}

function findConversationByCallSid(callSid?: string | null) {
  const sid = String(callSid ?? "").trim();
  if (!sid) return null;
  for (const conv of getAllConversations()) {
    if (
      (conv.messages ?? []).some(
        m => m.provider === "voice_call" && m.providerMessageId && m.providerMessageId === sid
      )
    ) {
      return conv;
    }
  }
  return null;
}

function findConversationByPhone(rawPhone?: string | null) {
  const normalized = normalizePhone(String(rawPhone ?? "").trim());
  if (!normalized) return null;
  const direct = getConversation(normalized);
  if (direct) return direct;
  const digits = normalized.replace(/\D/g, "");
  if (!digits) return null;
  for (const conv of getAllConversations()) {
    if (
      (conv.messages ?? []).some(m => {
        const fromDigits = String(m.from ?? "").replace(/\D/g, "");
        const toDigits = String(m.to ?? "").replace(/\D/g, "");
        return fromDigits === digits || toDigits === digits;
      })
    ) {
      return conv;
    }
  }
  return null;
}

function isVoiceProvider(msg: { provider?: string } | null | undefined): boolean {
  return msg?.provider === "voice_call" || msg?.provider === "voice_transcript";
}

function getNonVoiceMessages(conv: any) {
  return (conv?.messages ?? []).filter((m: any) => !isVoiceProvider(m));
}

function buildHistory(conv: any, limit = 20) {
  return getNonVoiceMessages(conv)
    .slice(-limit)
    .map((m: any) => ({ direction: m.direction, body: m.body }));
}

function getRecentMessagesText(conv: any, limit = 12): string {
  return getNonVoiceMessages(conv)
    .slice(-limit)
    .map((m: any) => String(m.body ?? ""))
    .join(" ");
}

function getDialogState(conv: any): DialogStateName {
  return conv?.dialogState?.name ?? "none";
}

function isScheduleDialogState(name: DialogStateName): boolean {
  return (
    name === "clarify_schedule" ||
    name === "schedule_request" ||
    name === "schedule_offer_sent" ||
    name === "schedule_booked" ||
    name.startsWith("test_ride_")
  );
}

function isTestRideDialogState(name: DialogStateName): boolean {
  return name.startsWith("test_ride_");
}

function isTradeDialogState(name: DialogStateName): boolean {
  return name === "trade_init" || name === "trade_cash" || name === "trade_trade" || name === "trade_either";
}

function isServiceDialogState(name: DialogStateName): boolean {
  return name === "service_request" || name === "service_handoff";
}

function isFollowUpDialogState(name: DialogStateName): boolean {
  return name === "followup_paused" || name === "followup_resumed";
}

function setDialogState(conv: any, name: DialogStateName) {
  if (!conv) return;
  const updatedAt = new Date().toISOString();
  if (conv.dialogState?.name === name) {
    conv.dialogState.updatedAt = updatedAt;
    return;
  }
  conv.dialogState = { name, updatedAt };
  const intent = mapDialogStateToIntent(name);
  if (intent) {
    updateLastIntent(conv, intent, "dialog_state");
  }
}

function isConversationStateParserAccepted(parsed: ConversationStateParse | null): boolean {
  if (!parsed) return false;
  const confidence = typeof parsed.confidence === "number" ? parsed.confidence : 0;
  const min = Number(process.env.LLM_CONVERSATION_STATE_CONFIDENCE_MIN ?? 0.74);
  if (confidence < min) return false;
  if (
    parsed.stateIntent === "none" &&
    parsed.departmentIntent === "none" &&
    parsed.manualHandoffReason === "none" &&
    !parsed.clearInventoryWatchPending &&
    !parsed.clearPricingNeedModel
  ) {
    return false;
  }
  return true;
}

function applyConversationStateReducer(
  conv: any,
  parsed: ConversationStateParse | null
): { departmentIntent: DepartmentRole | null } {
  if (!isConversationStateParserAccepted(parsed)) {
    return { departmentIntent: null };
  }
  const state = parsed as ConversationStateParse;
  if (state.clearInventoryWatchPending || state.departmentIntent !== "none") {
    conv.inventoryWatchPending = undefined;
    if (getDialogState(conv) === "inventory_watch_prompted") {
      setDialogState(conv, "none");
    }
  }
  if (state.clearPricingNeedModel && getDialogState(conv) === "pricing_need_model") {
    setDialogState(conv, "none");
  }
  if (state.manualHandoffReason !== "none") {
    setFollowUpMode(conv, "manual_handoff", state.manualHandoffReason);
    stopFollowUpCadence(conv, "manual_handoff");
    stopRelatedCadences(conv, "manual_handoff", { setMode: "manual_handoff" });
  }
  if (
    state.stateIntent === "scheduling" &&
    state.explicitRequest &&
    conv.followUp?.mode === "manual_handoff" &&
    /^(handoff:pricing|handoff:payments|credit_app)$/.test(String(conv.followUp?.reason ?? ""))
  ) {
    setFollowUpMode(conv, "manual_handoff", "manual_appointment");
  }
  if (state.departmentIntent !== "none") {
    return { departmentIntent: state.departmentIntent };
  }
  return { departmentIntent: null };
}

function hasConversationStateParserHint(text: string, conv: any): boolean {
  const lower = String(text ?? "").toLowerCase();
  return (
    /\b(parts?|service|apparel|credit app|credit application|lien|binder|e-?sign|watch|notify|keep an eye out|price|payment|apr|term|schedule|appointment)\b/i.test(
      lower
    ) ||
    !!conv.inventoryWatchPending ||
    getDialogState(conv) === "pricing_need_model" ||
    conv.followUp?.mode === "manual_handoff"
  );
}

async function parseAndReduceConversationState(args: {
  conv: any;
  text: string;
  history: { direction: "in" | "out"; body: string }[];
  shortAck: boolean;
  debugLabel: "live" | "regen" | "manual";
}): Promise<{ parsed: ConversationStateParse | null; reduced: { departmentIntent: DepartmentRole | null } }> {
  const { conv, text, history, shortAck, debugLabel } = args;
  const parserEligible =
    process.env.LLM_ENABLED === "1" &&
    process.env.LLM_CONVERSATION_STATE_PARSER_ENABLED !== "0" &&
    !!process.env.OPENAI_API_KEY &&
    !shortAck;
  const parsed =
    parserEligible && hasConversationStateParserHint(text, conv)
      ? await safeLlmParse(`conversation_state_parser_${debugLabel}`, () =>
          parseConversationStateWithLLM({
            text,
            history,
            lead: conv.lead,
            followUp: conv.followUp,
            dialogState: getDialogState(conv),
            inventoryWatchPending: conv.inventoryWatchPending
          })
        )
      : null;
  if (process.env.DEBUG_CONVERSATION_STATE_PARSER === "1" && parsed) {
    const label =
      debugLabel === "regen"
        ? "[llm-conversation-state-parse] regen"
        : debugLabel === "manual"
          ? "[llm-conversation-state-parse] manual"
          : "[llm-conversation-state-parse]";
    console.log(
      label,
      parsed
    );
  }
  return {
    parsed,
    reduced: applyConversationStateReducer(conv, parsed)
  };
}

function normalizePersonName(value: string): string {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function resolveSalespersonByName(
  cfg: Awaited<ReturnType<typeof getSchedulerConfig>>,
  name: string
) {
  const target = normalizePersonName(name);
  if (!target) return null;
  const salespeople = cfg.salespeople ?? [];
  let match = salespeople.find(sp => normalizePersonName(sp.name ?? "") === target) ?? null;
  if (!match) {
    match =
      salespeople.find(sp => normalizePersonName(sp.name ?? "").includes(target)) ??
      salespeople.find(sp => target.includes(normalizePersonName(sp.name ?? ""))) ??
      null;
  }
  return match ? { id: match.id, name: match.name, calendarId: match.calendarId } : null;
}

function resolveSalespersonForUser(
  cfg: Awaited<ReturnType<typeof getSchedulerConfig>>,
  user: { name?: string | null; email?: string | null; calendarId?: string | null } | null
) {
  if (!user) return null;
  const salespeople = cfg.salespeople ?? [];
  if (user.calendarId) {
    const byCal = salespeople.find(sp => sp.calendarId === user.calendarId);
    if (byCal) return { id: byCal.id, name: byCal.name, calendarId: byCal.calendarId };
  }
  const name = user.name ?? "";
  if (name) {
    const byName = resolveSalespersonByName(cfg, name);
    if (byName) return byName;
  }
  return null;
}

function setPreferredSalespersonForConv(
  conv: any,
  sp: { id: string; name?: string | null },
  source: string
) {
  if (!sp?.id) return;
  conv.scheduler = conv.scheduler ?? { updatedAt: new Date().toISOString() };
  const nextId = sp.id;
  const nextName = sp.name ?? conv.scheduler.preferredSalespersonName ?? null;
  if (
    conv.scheduler.preferredSalespersonId === nextId &&
    conv.scheduler.preferredSalespersonName === nextName
  ) {
    return;
  }
  conv.scheduler.preferredSalespersonId = nextId;
  conv.scheduler.preferredSalespersonName = nextName ?? undefined;
  conv.scheduler.preferredSetAt = new Date().toISOString();
  conv.scheduler.updatedAt = new Date().toISOString();
  if (process.env.DEBUG_SCHEDULER === "1") {
    console.log("[scheduler] preferred salesperson set", {
      leadKey: conv.leadKey,
      salespersonId: nextId,
      salespersonName: nextName,
      source
    });
  }
}

function getPreferredSalespeopleForConv(
  cfg: Awaited<ReturnType<typeof getSchedulerConfig>>,
  conv: any
): string[] {
  const base = getPreferredSalespeople(cfg);
  const salespeople = cfg.salespeople ?? [];
  let ordered = [...base];

  const prependUnique = (id: string | null | undefined) => {
    const clean = String(id ?? "").trim();
    if (!clean) return;
    ordered = [clean, ...ordered.filter(existing => existing !== clean)];
  };

  const prefId = conv?.scheduler?.preferredSalespersonId ?? null;
  if (prefId) {
    prependUnique(prefId);
  }

  const prefName = conv?.scheduler?.preferredSalespersonName ?? "";
  const byName = prefName ? resolveSalespersonByName(cfg, prefName) : null;
  if (byName) {
    prependUnique(byName.id);
  }

  // Lead owner should be first choice when we can resolve to a salesperson.
  const ownerId = String(conv?.leadOwner?.id ?? "").trim();
  if (ownerId) {
    const byOwnerId = salespeople.find(sp => sp.id === ownerId);
    if (byOwnerId?.id) {
      prependUnique(byOwnerId.id);
    }
  }
  const ownerName = String(conv?.leadOwner?.name ?? "").trim();
  const byOwnerName = ownerName ? resolveSalespersonByName(cfg, ownerName) : null;
  if (byOwnerName) {
    prependUnique(byOwnerName.id);
  }

  return ordered;
}

function getLastNonVoiceOutbound(conv: any) {
  return getNonVoiceMessages(conv)
    .filter((m: any) => m.direction === "out")
    .slice(-1)[0];
}

function normalizeTimeToken(s: string): string {
  return s
    .toLowerCase()
    .replace(/\./g, "")
    .replace(/\s+/g, "")
    .replace(/^0+/, "");
}

function getLocalDateParts(date: Date, timeZone: string) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  });
  const parts = fmt.formatToParts(date);
  const map: Record<string, string> = {};
  for (const p of parts) {
    if (p.type !== "literal") map[p.type] = p.value;
  }
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour: Number(map.hour),
    minute: Number(map.minute)
  };
}

function parseTimeTokenToParts(token: string, fallbackHour24: number): { hour24: number; minute: number } | null {
  const m = token.match(/(\d{1,2}):(\d{2})(am|pm)?/i);
  if (!m) return null;
  const hourRaw = Number(m[1]);
  const minute = Number(m[2]);
  const meridiem = (m[3] ?? "").toLowerCase();
  if (Number.isNaN(hourRaw) || Number.isNaN(minute)) return null;
  if (minute < 0 || minute > 59) return null;
  if (hourRaw < 0 || hourRaw > 12) return null;
  if (meridiem) {
    if (meridiem === "am") return { hour24: hourRaw === 12 ? 0 : hourRaw, minute };
    if (meridiem === "pm") return { hour24: hourRaw === 12 ? 12 : hourRaw + 12, minute };
  }
  const fallbackIsPm = fallbackHour24 >= 12;
  if (fallbackIsPm) {
    return { hour24: hourRaw === 12 ? 12 : hourRaw + 12, minute };
  }
  return { hour24: hourRaw === 12 ? 0 : hourRaw, minute };
}

function extractTimeToken(msg: string): string | null {
  const s = String(msg ?? "").toLowerCase();
  const financeNumericContext =
    /\b(payment|monthly|per month|\/\s*mo|\/\s*month|down|down payment|apr|term|finance|financing|loan|loans?)\b/i
      .test(s) || /\b\d{2,3}\s*(month|months|mo)\b/i.test(s);

  // colon format: 9:30, 09:30, 9:30am, 9:30 am
  let m = s.match(/\b(\d{1,2})\s*:\s*(\d{2})\s*(am|pm)?\b/);
  if (m) {
    const hh = String(Number(m[1]));
    const mm = m[2];
    const ap = m[3] ?? "";
    return normalizeTimeToken(`${hh}:${mm}${ap}`);
  }

  // no-colon 3–4 digit: 930, 0930, 1030, 1230pm
  m = s.match(/(?:^|[^0-9])(\d{3,4})\s*(am|pm)?(?:$|[^0-9])/);
  if (m) {
    const digits = m[1];
    const ap = m[2] ?? "";
    if (!ap && financeNumericContext) return null;
    const d = digits.padStart(4, "0");
    const hh = String(Number(d.slice(0, 2)));
    const mm = d.slice(2, 4);
    const token = normalizeTimeToken(`${hh}:${mm}${ap}`);
    console.log("[time-token] compact", { raw: digits, token });
    return token;
  }

  // hour-only: 1, 11, 1pm, 11am
  m = s.match(/\b(\d{1,2})\s*(am|pm)?\b/);
  if (m) {
    const hourNum = Number(m[1]);
    const hasMeridiem = !!m[2];
    // Prevent finance terms like "84 months" from being treated as a time.
    if (!hasMeridiem && /\b(month|months|mo|year|years|yr|yrs)\b/.test(s)) return null;
    if (!hasMeridiem && (hourNum < 1 || hourNum > 12)) return null;
    const hh = String(Number(m[1]));
    const ap = m[2] ?? "";
    return normalizeTimeToken(`${hh}:00${ap}`);
  }

  return null;
}

function isClarificationReply(text: string): boolean {
  const t = text.trim().toLowerCase();
  return /^(what\??|huh\??|sorry\??|pardon\??|come again\??|not sure|confused)\s*$/.test(t);
}

function parseRelativeDurationCount(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const t = String(raw).trim().toLowerCase();
  const direct = Number(t);
  if (Number.isFinite(direct) && direct > 0) return direct;
  const wordMap: Record<string, number> = {
    one: 1,
    two: 2,
    three: 3,
    four: 4,
    five: 5,
    six: 6,
    seven: 7,
    eight: 8,
    nine: 9,
    ten: 10,
    couple: 2
  };
  return wordMap[t] ?? null;
}

function parseRelativeDaysOrWeeks(text: string): { count: number; unit: "days" | "weeks" } | null {
  const t = String(text ?? "").toLowerCase();
  if (!t) return null;
  const m = t.match(
    /\b(?:in|for|about|around)\s+(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|couple)\s+(day|days|week|weeks|wk|wks)\b/
  );
  if (!m) return null;
  const count = parseRelativeDurationCount(m[1]);
  if (!count) return null;
  const unitRaw = m[2];
  const unit: "days" | "weeks" = /wk|week/.test(unitRaw) ? "weeks" : "days";
  return { count, unit };
}

function parseFutureTimeframe(text: string, base: Date): { label: string; until?: Date } | null {
  const t = text.toLowerCase();

  if (/\bnext\s+year\b/.test(t)) {
    const d = new Date(base.getFullYear() + 1, 0, 1, 9, 0, 0, 0);
    return { label: "next year", until: d };
  }

  if (/\bnext\s+season\b/.test(t)) {
    const d = new Date(base.getFullYear() + 1, 2, 1, 9, 0, 0, 0);
    return { label: "next season", until: d };
  }

  const relative = parseRelativeDaysOrWeeks(t);
  if (relative) {
    if (relative.unit === "days") {
      const days = relative.count;
      return {
        label: `in ${days} day${days === 1 ? "" : "s"}`,
        until: new Date(base.getTime() + days * 24 * 60 * 60 * 1000)
      };
    }
    const weeks = relative.count;
    return {
      label: `in ${weeks} week${weeks === 1 ? "" : "s"}`,
      until: new Date(base.getTime() + weeks * 7 * 24 * 60 * 60 * 1000)
    };
  }

  if (/\bnext week\b/.test(t)) {
    return { label: "next week", until: new Date(base.getTime() + 7 * 24 * 60 * 60 * 1000) };
  }

  if (/\bnext month\b/.test(t)) {
    return { label: "next month", until: new Date(base.getTime() + 30 * 24 * 60 * 60 * 1000) };
  }

  const monthMap: Record<string, number> = {
    jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2, apr: 3, april: 3,
    may: 4, jun: 5, june: 5, jul: 6, july: 6, aug: 7, august: 7, sep: 8, sept: 8, september: 8,
    oct: 9, october: 9, nov: 10, november: 10, dec: 11, december: 11
  };
  const monthMatch = t.match(
    /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/
  );
  if (monthMatch) {
    const monthKey = monthMatch[1];
    if (monthKey === "may") {
      const explicitMonth =
        /\bmay\s+\d{1,2}\b/.test(t) ||
        /\b(in|this|next|on|by|during|around|early|late)\s+may\b/.test(t);
      if (!explicitMonth) return null;
    }
    const month = monthMap[monthKey];
    const year = base.getFullYear();
    let d = new Date(year, month, 1, 9, 0, 0, 0);
    if (d.getTime() <= base.getTime()) d = new Date(year + 1, month, 1, 9, 0, 0, 0);
    return { label: monthKey, until: d };
  }

  const seasonMatch = t.match(/\b(this\s+|next\s+)?(spring|summer|fall|autumn|winter)\b/);
  if (seasonMatch) {
    const season = seasonMatch[2];
    const seasonMap: Record<string, number> = {
      spring: 2,
      summer: 5,
      fall: 8,
      autumn: 8,
      winter: 11
    };
    const month = seasonMap[season];
    const year = base.getFullYear();
    let d = new Date(year, month, 1, 9, 0, 0, 0);
    if (seasonMatch[1]?.trim().startsWith("next")) {
      d = new Date(year + 1, month, 1, 9, 0, 0, 0);
      return { label: `next ${season}`, until: d };
    }
    if (d.getTime() <= base.getTime()) d = new Date(year + 1, month, 1, 9, 0, 0, 0);
    return { label: seasonMatch[1] ? `this ${season}` : season, until: d };
  }

  return null;
}

function isExplicitScheduleIntent(text: string): boolean {
  const t = String(text ?? "").toLowerCase();
  const scheduleWords =
    /\b(schedule|appointment|appt|book|reserve|set\s+up|come\s+in|stop\s+(in|by)|visit|test ride|demo ride)\b/i;
  const hoursQuestion =
    /\bhours?\b/i.test(t) ||
    /(what time.*open|what time.*close|when.*open|when.*close|opening hours|closing time)/i.test(t);
  if (hoursQuestion && !scheduleWords.test(t)) {
    return false;
  }
  // If they’re asking for a phone call, do not treat it as an appointment request.
  if (/\b(call|phone|call me|give me a call|reach me|reach out)\b/i.test(t) &&
      !scheduleWords.test(t)) {
    return false;
  }
  // Deferrals like "wait until warmer" shouldn't trigger scheduling.
  if (/\b(wait|later|not yet|not now|when (it'?s|it is) warmer|once (it'?s|it is) warmer|warmer)\b/i.test(t) &&
      !scheduleWords.test(t)) {
    return false;
  }
  if (looksLikeTimeSelection(t)) return true;
  if (scheduleWords.test(t)) {
    return true;
  }
  if (/\b(when|what time|what day|availability|available|openings|open)\b/i.test(t)) {
    return true;
  }
  // Day words only count as scheduling if paired with a time.
  if (/\b(today|tomorrow|next week|this week|next month|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i.test(t) &&
      /\b(\d{1,2})(?::\d{2})?\s*(am|pm)?\b/i.test(t)) {
    return true;
  }
  return false;
}

function extractDayPart(text: string): string | null {
  const t = String(text ?? "").toLowerCase();
  const m = t.match(/\b(morning|afternoon|evening|tonight|tonite)\b/);
  if (!m) return null;
  return m[1] === "tonight" || m[1] === "tonite" ? "evening" : m[1];
}

const SOFT_SCHEDULE_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;

function detectSoftVisitIntent(text: string): boolean {
  const t = String(text ?? "").toLowerCase();
  const hasDayPart = /\b(morning|afternoon|evening|tonight|tonite)\b/i.test(t);
  const hasTime = /\b(\d{1,2})(?::\d{2})?\s*(am|pm)\b/i.test(t);
  if (hasTime) return false;
  if (isExplicitScheduleIntent(t)) return false;
  const hardConstraint =
    /\b(can'?t|cannot|can not|won'?t|unable|not able|have to work|working|stuck at work|something came up)\b/i;
  const rescheduleLike =
    /\b(make it|make it in|come in|stop in|stop by|visit|today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|this week|next week)\b/i;
  if (hardConstraint.test(t) && rescheduleLike.test(t)) return false;
  const visitVerb =
    /\b(come|stop|swing|drop|head|drive|ride|make it|make it in|get there|come up|come down|stop by|come by|come in)\b/i;
  if (!visitVerb.test(t)) return false;
  const softQualifier =
    /\b(might|maybe|probably|try|trying|hope|hoping|plan|planning|if i can|if i could|if possible|sometime|some time|soon|eventually|later|in a few|in a couple|a couple (days|weeks)|next week|next month|this week|this weekend|weekend)\b/i;
  const dayToken =
    /\b(today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|next week|this week|this weekend|weekend|next month)\b/i;
  if (hasDayPart && dayToken.test(t)) return false;
  return visitVerb.test(t) && (softQualifier.test(t) || dayToken.test(t));
}

function detectSchedulingSignals(text: string) {
  const t = String(text ?? "").toLowerCase();
  const hasDayToken =
    /\b(today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|this week|next week|this weekend|weekend|next month)\b/i.test(
      t
    );
  const hasDayPart = /\b(morning|afternoon|evening|tonight|tonite)\b/i.test(t);
  const hasTimeWord = /\b(\d{1,2}):(\d{2})\s*(am|pm)?\b/i.test(t);
  const hasAtHour = /\b(?:at|for|around|by)\s*(\d{1,2})(?::\d{2})?\b(?!\s*\/)/i.test(t);
  const hasDayTime = hasDayToken && (hasTimeWord || hasAtHour);
  const softVisit = detectSoftVisitIntent(t);
  const explicit = softVisit ? false : isExplicitScheduleIntent(t);
  const hasDayOnlyAvailability =
    hasDayToken && /\b(availability|available|openings|open|time|times)\b/i.test(t);
  const hasDayOnlyRequest = !softVisit && hasDayToken && (explicit || hasDayPart) && !hasDayTime;
  return { explicit, hasDayTime: softVisit ? false : hasDayTime, hasDayOnlyAvailability, hasDayOnlyRequest, softVisit };
}

function detectScheduleConflictWithoutAlternative(text: string): boolean {
  const t = String(text ?? "").toLowerCase();
  if (!t.trim()) return false;
  if (isExplicitScheduleIntent(t)) return false;
  const hardConflict =
    /\b(can'?t|cannot|can not|won'?t|unable|not able|have to work|working|stuck at work|something came up)\b/i.test(
      t
    );
  if (!hardConflict) return false;
  const dayTokens = Array.from(
    new Set(
      (t.match(
        /\b(today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|this week|next week|this weekend|weekend)\b/g
      ) ?? []) as string[]
    )
  );
  if (dayTokens.length >= 2) return false;
  const hasAlternativeCue =
    /\b(instead|how about|what about|i can do|i could do|works for me|available)\b/i.test(t);
  if (hasAlternativeCue) return false;
  const hasScheduleContext =
    /\b(make it|make it in|come in|stop in|stop by|visit|today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|this week|next week)\b/i.test(
      t
    );
  return hasScheduleContext;
}

function isDecisionDeferral(text: string): boolean {
  const t = String(text ?? "").toLowerCase();
  return (
    /(let me|lemme)\s+(talk|check|see|figure|confirm)\b/.test(t) ||
    /\b(talk to (my )?(wife|husband|spouse|partner))\b/.test(t) ||
    /\b(check|look at|review)\s+(my )?(schedule|calendar)\b/.test(t) ||
    /\bsee what i have going on\b/.test(t) ||
    /\bget back to you\b/.test(t)
  );
}

function nextWeekdayDate(base: Date, weekday: number): Date {
  const d = new Date(base);
  d.setHours(9, 0, 0, 0);
  while (d.getDay() !== weekday) {
    d.setDate(d.getDate() + 1);
  }
  if (d.getTime() <= base.getTime()) {
    d.setDate(d.getDate() + 7);
  }
  return d;
}

function parseDayOfWeek(text: string): { day: string; date: Date } | null {
  const t = text.toLowerCase();
  const map: Array<{ re: RegExp; idx: number; label: string }> = [
    { re: /\bmonday|mon\b/, idx: 1, label: "Monday" },
    { re: /\btuesday|tue|tues\b/, idx: 2, label: "Tuesday" },
    { re: /\bwednesday|wed\b/, idx: 3, label: "Wednesday" },
    { re: /\bthursday|thu|thur|thurs\b/, idx: 4, label: "Thursday" },
    { re: /\bfriday|fri\b/, idx: 5, label: "Friday" },
    { re: /\bsaturday|sat\b/, idx: 6, label: "Saturday" },
    { re: /\bsunday|sun\b/, idx: 0, label: "Sunday" }
  ];
  for (const entry of map) {
    if (entry.re.test(t)) {
      return { day: entry.label, date: nextWeekdayDate(new Date(), entry.idx) };
    }
  }
  return null;
}

function formatTime12h(time: string): string {
  const m = time.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return time;
  let hour = Number(m[1]);
  const minute = m[2];
  const ampm = hour >= 12 ? "PM" : "AM";
  hour = hour % 12;
  if (hour === 0) hour = 12;
  return `${hour}:${minute} ${ampm}`;
}

function formatBusinessHoursForReply(
  hours?: Record<string, any> | null,
  country?: string | null
): string | null {
  if (!hours) return null;
  const dayOrder = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
  const entries = dayOrder
    .map(day => ({ day, open: hours?.[day]?.open, close: hours?.[day]?.close }))
    .filter(d => d.open && d.close);
  if (!entries.length) return null;

  const use12h = !country || ["us", "usa", "ca", "can", "canada"].includes(country.toLowerCase());

  const groups: Array<{ start: number; end: number; open: string; close: string }> = [];
  for (let i = 0; i < entries.length; i++) {
    const { open, close } = entries[i];
    const prev = groups[groups.length - 1];
    if (prev && prev.open === open && prev.close === close && prev.end === i - 1) {
      prev.end = i;
    } else {
      groups.push({ start: i, end: i, open, close });
    }
  }

  const label = (idx: number) =>
    entries[idx].day.slice(0, 3).replace(/^\w/, c => c.toUpperCase());
  return groups
    .map(g => {
      const dayLabel = g.start === g.end ? label(g.start) : `${label(g.start)}–${label(g.end)}`;
      const open = use12h ? formatTime12h(g.open) : g.open;
      const close = use12h ? formatTime12h(g.close) : g.close;
      return `${dayLabel} ${open}–${close}`;
    })
    .join(", ");
}

function extractDayRequest(text: string): string | null {
  const t = text.toLowerCase();
  const map: Record<string, string> = {
    monday: "monday",
    mon: "monday",
    tuesday: "tuesday",
    tue: "tuesday",
    tues: "tuesday",
    wednesday: "wednesday",
    wed: "wednesday",
    thursday: "thursday",
    thu: "thursday",
    thur: "thursday",
    thurs: "thursday",
    friday: "friday",
    fri: "friday",
    saturday: "saturday",
    sat: "saturday",
    sunday: "sunday",
    sun: "sunday"
  };
  for (const key of Object.keys(map)) {
    const re = new RegExp(`\\b${key}\\b`, "i");
    if (re.test(t)) return map[key];
  }
  return null;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeOutboundText(text: string): string {
  return String(text ?? "").toLowerCase().replace(/\s+/g, " ").trim();
}

function normalizeOutboundTarget(target: string): string {
  const raw = String(target ?? "").trim().toLowerCase();
  if (!raw) return "";
  if (raw.includes("@")) return raw;
  const digits = raw.replace(/\D/g, "");
  return digits || raw;
}

function normalizeOutboundMediaForDedup(mediaUrls?: string[]): string {
  if (!Array.isArray(mediaUrls) || mediaUrls.length === 0) return "";
  return mediaUrls
    .map(u => String(u ?? "").trim().toLowerCase())
    .filter(Boolean)
    .sort()
    .join("|");
}

function isRecentDuplicateOutbound(
  conv: any,
  to: string,
  body: string,
  opts?: {
    providers?: string[];
    windowMs?: number;
    mediaUrls?: string[];
    nowMs?: number;
    excludeMessageId?: string | null;
  }
): boolean {
  const bodyNorm = normalizeOutboundText(body);
  const toNorm = normalizeOutboundTarget(to);
  if (!bodyNorm || !toNorm) return false;
  const messages = Array.isArray(conv?.messages) ? conv.messages : [];
  if (!messages.length) return false;
  const providers = opts?.providers?.length
    ? new Set(opts.providers.map(p => String(p ?? "").trim()))
    : null;
  const windowMs = Number(opts?.windowMs ?? 90 * 1000);
  const nowMs = Number(opts?.nowMs ?? Date.now());
  const candidateMedia = normalizeOutboundMediaForDedup(opts?.mediaUrls);
  const excludeMessageId = String(opts?.excludeMessageId ?? "").trim();

  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m?.direction !== "out") continue;
    if (excludeMessageId && String(m?.id ?? "") === excludeMessageId) continue;
    if (m?.draftStatus === "stale") continue;
    const provider = String(m?.provider ?? "").trim();
    if (providers && !providers.has(provider)) continue;
    if (normalizeOutboundTarget(String(m?.to ?? "")) !== toNorm) continue;
    if (normalizeOutboundText(String(m?.body ?? "")) !== bodyNorm) continue;
    if (candidateMedia) {
      const msgMedia = normalizeOutboundMediaForDedup(
        Array.isArray(m?.mediaUrls) ? (m.mediaUrls as string[]) : undefined
      );
      if (msgMedia !== candidateMedia) continue;
    }
    const atMs = Date.parse(String(m?.at ?? ""));
    if (!Number.isFinite(atMs)) continue;
    if (nowMs - atMs <= windowMs) return true;
  }
  return false;
}

function getOutboundMessagesByProvider(conv: any, providers?: string[]): any[] {
  const allow = providers?.length ? new Set(providers) : null;
  return (conv?.messages ?? [])
    .filter(
      (m: any) =>
        m?.direction === "out" &&
        String(m?.body ?? "").trim() &&
        (!allow || allow.has(String(m.provider ?? "")))
    )
    .sort((a: any, b: any) => new Date(a.at ?? 0).getTime() - new Date(b.at ?? 0).getTime());
}

function selectNonRepeatingCadenceMessage(
  conv: any,
  candidate: string,
  fallbackOptions: string[] = [],
  providers: string[] = ["twilio", "draft_ai", "human", "sendgrid"]
): string {
  const normalizedCandidate = normalizeOutboundText(candidate);
  if (!normalizedCandidate) return candidate;
  const outbounds = getOutboundMessagesByProvider(conv, providers);
  if (!outbounds.length) return candidate;
  const lastNorm = normalizeOutboundText(outbounds[outbounds.length - 1]?.body ?? "");
  if (!lastNorm || normalizedCandidate !== lastNorm) return candidate;

  const used = new Set(
    outbounds
      .map((m: any) => normalizeOutboundText(m.body))
      .filter(Boolean)
  );
  for (const option of fallbackOptions) {
    const normalizedOption = normalizeOutboundText(option);
    if (!normalizedOption || normalizedOption === lastNorm) continue;
    if (!used.has(normalizedOption)) return option.trim();
  }
  for (const option of fallbackOptions) {
    const normalizedOption = normalizeOutboundText(option);
    if (normalizedOption && normalizedOption !== lastNorm) return option.trim();
  }
  return `${candidate.trim()} If timing changed, just let me know.`.trim();
}

function hasIntro(conv: any, dealerName?: string, agentName?: string): boolean {
  const dealer = dealerName?.toLowerCase();
  const agent = agentName?.toLowerCase();
  const outs = (conv?.messages ?? []).filter((m: any) => m.direction === "out");
  return outs.some((m: any) => {
    const body = String(m.body ?? "").toLowerCase();
    if (agent && body.includes(`this is ${agent}`)) return true;
    if (dealer && body.includes(dealer)) return true;
    return false;
  });
}

function stripIntroIfRepeated(text: string, conv: any, dealerName?: string, agentName?: string): string {
  if (!text) return text;
  if (!hasIntro(conv, dealerName, agentName)) return text.trim();
  let out = text.trim();
  out = out.replace(/^hi[^.]*?\s*[-—]\s*/i, "");
  if (agentName) {
    const r = new RegExp(`\\bthis is[^.]*${escapeRegex(agentName)}[^.]*\\.?\\s*`, "i");
    out = out.replace(r, "");
  }
  if (dealerName) {
    const r = new RegExp(`\\bthis is[^.]*${escapeRegex(dealerName)}[^.]*\\.?\\s*`, "i");
    out = out.replace(r, "");
  }
  out = out.replace(/\s{2,}/g, " ").replace(/\s+([,.;:])/g, "$1").trim();
  return out.trim();
}

function ensureUniqueDraft(
  draft: string,
  conv: any,
  dealerName?: string,
  agentName?: string
): string {
  const used = new Set(
    (conv?.messages ?? [])
      .filter((m: any) => m.direction === "out")
      .map((m: any) => normalizeOutboundText(m.body))
  );
  let candidate = stripIntroIfRepeated(draft, conv, dealerName, agentName);
  if (!candidate) {
    candidate = "Got it — happy to help with pricing or a model comparison.";
  }
  if (!used.has(normalizeOutboundText(candidate))) return candidate;
  const fallbacks = [
    "Got it — happy to help with pricing or a model comparison. Which model are you leaning toward?",
    "Thanks for the update — I can help with pricing or compare models if that’s useful.",
    "Understood. If you want pricing details or a quick model comparison, just say the word."
  ];
  for (const fb of fallbacks) {
    if (!used.has(normalizeOutboundText(fb))) return fb;
  }
  const suffix = " Let me know what you’re leaning toward.";
  return used.has(normalizeOutboundText(candidate + suffix))
    ? `${candidate} Thanks for the update.`
    : candidate + suffix;
}

function ensureUniqueDispositionReply(reply: string, conv: any): string {
  const used = new Set(
    (conv?.messages ?? [])
      .filter((m: any) => m.direction === "out")
      .map((m: any) => normalizeOutboundText(m.body))
  );
  const base = String(reply ?? "").trim();
  if (base && !used.has(normalizeOutboundText(base))) return base;
  const fallbacks = [
    "I hear you. No worries at all. If things change later, reach out anytime.",
    "Totally get it. Thanks for being straight with me. If timing changes, I’m here.",
    "All good — thanks for the update. If things open up later, just text me."
  ];
  for (const fb of fallbacks) {
    if (!used.has(normalizeOutboundText(fb))) return fb;
  }
  return "No worries at all. If things change later, just text me.";
}

function draftHasSchedulingPrompt(text: string): boolean {
  return /(what day|what time|when.*available|schedule|appointment|come in|stop by|stop in|book|reserve|test ride|demo ride|which works best)/i.test(
    text
  );
}

function wantsReminder(text: string): boolean {
  const t = String(text ?? "").toLowerCase();
  return /\b(remind|reminder|follow up|follow-up|check back|reach out|touch base)\b/i.test(t);
}

function looksLikeTimeSelection(text: string): boolean {
  // Finance phrasing (e.g., "run it for 84 months") should never be treated as slot selection.
  if (isPaymentText(text)) return false;
  if (extractTimeToken(text)) return true;
  return /\b(first|second|earlier|later)\b/i.test(String(text ?? ""));
}

function isSlotOfferMessage(text: string): boolean {
  return /\b(do any of these times work|which works best)\b/i.test(String(text ?? ""));
}

function hasScheduleOfferContext(lastOutboundText: string, dialogState: DialogStateName): boolean {
  if (isScheduleDialogState(dialogState)) return true;
  const text = String(lastOutboundText ?? "");
  if (!text.trim()) return false;
  return (
    isSlotOfferMessage(text) ||
    draftHasSpecificTimes(text) ||
    /\b(what day and time works|what day works|what time works|what time on|set up a time|stop in|come in|schedule|appointment|book)\b/i.test(
      text
    )
  );
}

function applySlotOfferPolicy(conv: any, reply: string, lastOutboundText: string): string {
  if (getDialogState(conv) !== "schedule_offer_sent") return reply;
  if (!isSlotOfferMessage(reply)) return reply;
  if (!isSlotOfferMessage(lastOutboundText)) return reply;
  setDialogState(conv, "schedule_request");
  return "If those times don't work, what day and time works for you?";
}

function stripTradeIntroSentence(text: string): string {
  return String(text ?? "")
    .replace(
      /^([^.!?]*\bthanks for (reaching out about selling|using our trade[-\s]?in estimator)[^.!?]*[.!?]\s*)/i,
      ""
    )
    .trim();
}

function rewriteTradeVoiceToTeam(text: string): string {
  let out = String(text ?? "");
  if (!out) return out;
  out = out.replace(/\bI can\b/g, "We can");
  out = out.replace(/\bI(?:'|’)ll\b/g, "We’ll");
  out = out.replace(/\bI will\b/g, "We will");
  out = out.replace(/\bI(?:'|’)m\b/g, "We’re");
  out = out.replace(/\bI am\b/g, "We are");
  out = out.replace(/\blet me know\b/gi, "let us know");
  out = out.replace(/\btext me\b/gi, "text us");
  return out;
}

function stripDuplicateTradeAppraisalMention(reply: string, lastOutboundText: string): string {
  const current = String(reply ?? "").trim();
  if (!current) return reply;
  const previous = String(lastOutboundText ?? "");
  const appraisalMention =
    /\b(quick\s+in[-\s]?person appraisal|in[-\s]?person appraisal|trade appraisal|line up the appraisal|set up a trade appraisal)\b/i;
  if (!appraisalMention.test(current) || !appraisalMention.test(previous)) {
    return reply;
  }
  const sentences = current.split(/(?<=[.!?])\s+/);
  const filtered = sentences.filter(s => !appraisalMention.test(s));
  const cleaned = filtered.join(" ").replace(/\s{2,}/g, " ").trim();
  return cleaned || "Sounds good — thanks for confirming.";
}

function hasPriorTradeAppraisalMention(conv: any): boolean {
  const appraisalMention =
    /\b(quick\s+in[-\s]?person appraisal|in[-\s]?person appraisal|trade appraisal|line up the appraisal|set up a trade appraisal)\b/i;
  return (conv?.messages ?? []).some(
    (m: any) => m?.direction === "out" && appraisalMention.test(String(m?.body ?? ""))
  );
}

function stripTradeReaskSentences(reply: string): string {
  const text = String(reply ?? "").trim();
  if (!text) return text;
  const sentences = text.split(/(?<=[.!?])\s+/);
  const dropPattern =
    /\b(quick\s+in[-\s]?person appraisal|in[-\s]?person appraisal|trade appraisal|appraisal\b|bring (the|your|it)|evaluate (it|your|the)|any lien|lien|payoff|what(?:'| i)?s the mileage|how many miles|mileage(?: on| of)?|cash offer|trade credit|trade into)\b/i;
  const filtered = sentences.filter(s => !dropPattern.test(s));
  return filtered.join(" ").replace(/\s{2,}/g, " ").trim();
}

function isLienHolderInfoRequestText(text: string): boolean {
  const t = String(text ?? "").toLowerCase();
  if (!t.trim()) return false;
  const hasLienTerm = /\b(lien|lein|lender|payoff)\b/.test(t);
  const hasInfoTerm = /\b(address|info|information|details|name)\b/.test(t);
  if (!hasLienTerm || !hasInfoTerm) return false;
  const hasRequestCue =
    /\b(do you have|what(?:'| i)?s|can you|could you|send|text|share|give me|need|get)\b/.test(t) ||
    /\?/.test(t) ||
    /\b(didn'?t|don'?t|dont|do not)\b.{0,30}\b(have|know)\b/.test(t);
  if (!hasRequestCue) return false;
  const hasProvideCue =
    /\b(here(?:'| i)?s|attached|i have|sending|sent|this is)\b/.test(t) &&
    !/\?$/.test(t.trim());
  return !hasProvideCue;
}

function isFinanceDocsQuestionText(text: string): boolean {
  const t = String(text ?? "").toLowerCase();
  if (!t.trim()) return false;
  const asksDocs =
    /\b(what do i need to bring|what (?:should|do) i bring|what documents?|which documents?|what paperwork|what do you need from me)\b/.test(
      t
    ) || /\bwhat(?:'| i)?s needed\b/.test(t);
  const financeContext =
    /\b(financ|credit app|credit application|loan|approval|lien|binder|insurance|payoff|e-?sign)\b/.test(
      t
    );
  return asksDocs && financeContext;
}

function stringifyPolicyField(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.trim();
}

function isEmojiOnlyText(text: string): boolean {
  const t = String(text ?? "").trim();
  return t.length > 0 && /^[\p{Extended_Pictographic}\s]+$/u.test(t);
}

function isShortAckText(text: string): boolean {
  const t = String(text ?? "").trim().toLowerCase();
  if (!t) return false;
  if (isEmojiOnlyText(t)) return true;
  if (t.length > 60) return false;
  if (/[?]/.test(t)) return false;
  return /\b(thanks|thank you|thanks again|thx|ty|appreciate|got it|sounds good|sounds great|will do|ok|okay|k|kk|cool|perfect|great|all good|no problem|you bet|yep|yup|sure)\b/.test(
    t
  );
}

function shouldSuppressShortAckDraft(text: string): boolean {
  const t = String(text ?? "").trim();
  if (!isShortAckText(t)) return false;
  const schedulingSignals = detectSchedulingSignals(t);
  if (
    schedulingSignals.explicit ||
    schedulingSignals.hasDayTime ||
    schedulingSignals.hasDayOnlyAvailability ||
    schedulingSignals.hasDayOnlyRequest ||
    extractTimeToken(t)
  ) {
    return false;
  }
  if (
    /\b(price|pricing|payment|monthly|apr|term|down payment|trade|trade in|service|parts|apparel|available|availability|in stock|stock|test ride|appointment|schedule|call|video|photos?|email|watch)\b/i.test(
      t
    )
  ) {
    return false;
  }
  return true;
}

function isReachOutWhenReadyCloseText(text: string): boolean {
  const t = String(text ?? "")
    .toLowerCase()
    .replace(/[’']/g, "'");
  if (!t.trim()) return false;
  return (
    /\b(no rush|if anything changes|down the road|time is right)\b/.test(t) &&
    /\b(reach out|here when you're ready|give me a shout|just let me know)\b/.test(t)
  );
}

function formatLienHolderDirectoryEntry(entry: any): string | null {
  if (!entry || typeof entry !== "object") return null;
  const name = stringifyPolicyField(entry.name || entry.lender || entry.bank);
  const address = stringifyPolicyField(entry.address);
  const note = stringifyPolicyField(entry.note);
  const linesRaw = Array.isArray(entry.addressLines) ? entry.addressLines : [];
  const addressLines = linesRaw
    .map((v: unknown) => stringifyPolicyField(v))
    .filter(Boolean);
  const parts = [name, address, ...addressLines, note].filter(Boolean);
  if (!parts.length) return null;
  return parts.join("\n");
}

function resolveConfiguredLienHolderReply(profile: any): { text?: string; ambiguous?: boolean } {
  const policies = profile?.policies ?? {};
  const directText =
    stringifyPolicyField(policies?.lienHolderResponse) ||
    stringifyPolicyField(policies?.lienHolderText) ||
    stringifyPolicyField(policies?.payoffAddressResponse) ||
    stringifyPolicyField(policies?.lienHolder?.response) ||
    stringifyPolicyField(profile?.lienHolderResponse);
  if (directText) {
    return { text: directText };
  }

  const fromPolicies = Array.isArray(policies?.lienHolders) ? policies.lienHolders : [];
  const fromProfile = Array.isArray(profile?.lienHolders) ? profile.lienHolders : [];
  const entries = (fromPolicies.length ? fromPolicies : fromProfile)
    .map((entry: any) => formatLienHolderDirectoryEntry(entry))
    .filter((v: string | null): v is string => !!v);
  if (!entries.length) return {};
  if (entries.length === 1) return { text: entries[0] };
  return { ambiguous: true };
}

function buildLienHolderFallbackReply(profile: any): string {
  const configured = resolveConfiguredLienHolderReply(profile);
  if (configured.text) {
    return `Absolutely — here’s the lien holder/payoff info we have:\n${configured.text}`;
  }
  return "Good question — lien/payoff details can vary by lender. We’ll have our finance team confirm the exact lien holder name and payoff address and text you shortly.";
}

function hasOpenLienHolderInfoTodo(conv: any): boolean {
  return listOpenTodos().some(t => {
    if (t.convId !== conv.id || t.status !== "open") return false;
    const summary = String(t.summary ?? "").toLowerCase();
    return /\b(lien|lein|lender|payoff)\b/.test(summary);
  });
}

function applyTradePayoffParseToConversation(
  conv: any,
  parse: {
    payoffStatus?: "unknown" | "no_lien" | "has_lien";
    needsLienHolderInfo?: boolean;
    providesLienHolderInfo?: boolean;
  } | null
): void {
  if (!conv || !parse) return;
  const now = nowIso();
  const state = conv.tradePayoff ?? { status: "unknown", updatedAt: now };
  if (parse.payoffStatus === "no_lien") {
    state.status = "no_lien";
    state.lastAnsweredAt = now;
    state.lienHolderNeeded = false;
  } else if (parse.payoffStatus === "has_lien") {
    state.status = "has_lien";
    state.lastAnsweredAt = now;
  }
  if (parse.needsLienHolderInfo) {
    state.status = "has_lien";
    state.lienHolderNeeded = true;
  }
  if (parse.providesLienHolderInfo) {
    state.status = "has_lien";
    state.lienHolderProvided = true;
    state.lienHolderProvidedAt = now;
    state.lienHolderNeeded = false;
  }
  if (state.status === "no_lien") {
    state.lienHolderNeeded = false;
    state.lienHolderProvided = false;
    state.lienHolderProvidedAt = undefined;
  }
  state.updatedAt = now;
  conv.tradePayoff = state;
}

function maybeEscalateLienHolderInfoRequest(
  conv: any,
  event: InboundMessageEvent,
  profile: any,
  opts?: { createTodo?: boolean; setManualHandoff?: boolean; triggered?: boolean }
): string | null {
  if (!opts?.triggered && !isLienHolderInfoRequestText(String(event.body ?? ""))) return null;
  const configured = resolveConfiguredLienHolderReply(profile);
  const shouldEscalate = !configured.text || configured.ambiguous;
  if (shouldEscalate && opts?.createTodo) {
    if (!hasOpenLienHolderInfoTodo(conv)) {
      addTodo(
        conv,
        "manager",
        `Customer asked for lien holder/payoff details: ${String(event.body ?? "").trim() || "Lien holder info request"}`,
        event.providerMessageId
      );
    }
    if (opts?.setManualHandoff) {
      setFollowUpMode(conv, "manual_handoff", "lien_holder_info");
      stopFollowUpCadence(conv, "manual_handoff");
      stopRelatedCadences(conv, "manual_handoff", { setMode: "manual_handoff" });
    }
  }
  return buildLienHolderFallbackReply(profile);
}

function applyTradePolicy(
  conv: any,
  reply: string,
  lastOutboundText: string,
  suggestedSlots?: Array<{ startLocal?: string | null }>
): string {
  const state = getDialogState(conv);
  const lastInboundText = String(getLastInboundBody(conv) ?? "");
  const watchIntent = isWatchConfirmationIntentText(lastInboundText);
  if (!state.startsWith("trade_")) {
    if (watchIntent && hasPriorTradeAppraisalMention(conv)) {
      let stripped = stripTradeReaskSentences(reply);
      if (!stripped) {
        stripped = conv.inventoryWatch
          ? buildInventoryWatchConfirmation(conv.inventoryWatch)
          : "Sounds good — I’ll keep an eye out and text you as soon as one comes in.";
      }
      return rewriteTradeVoiceToTeam(stripped);
    }
    return reply;
  }
  let out = reply;
  if (state !== "trade_init") {
    out = stripTradeIntroSentence(out);
  }
  const askedToSchedule =
    /(schedule|appointment|set (up )?a time|come (in|by)|stop (in|by)|what time|what day|when can i come|can i come|stop by)/i.test(
      lastInboundText
    );
  if (state === "trade_cash" && askedToSchedule && suggestedSlots && suggestedSlots.length >= 2) {
    if (!isSlotOfferMessage(out)) {
      const a = suggestedSlots[0]?.startLocal ?? "";
      const b = suggestedSlots[1]?.startLocal ?? "";
      if (a && b) {
        out = `We can set up a trade appraisal. We have ${a} or ${b} — do any of these times work?`;
      }
    }
  }
  const cashTradeQuestion =
    /\b(are you looking for (a )?(straight )?cash offer|cash offer|trade credit|trading toward another bike)\b/i;
  if (cashTradeQuestion.test(out)) {
    if (state === "trade_cash") {
      const payoffStatus = String(conv?.tradePayoff?.status ?? "unknown");
      const hasMileage = Number.isFinite(Number(conv?.lead?.tradeVehicle?.mileage ?? NaN));
      if (payoffStatus === "no_lien") {
        out = hasMileage
          ? "Got it — thanks for confirming there’s no lien or payoff."
          : "Got it — thanks for confirming there’s no lien or payoff. What’s the mileage?";
      } else if (payoffStatus === "has_lien") {
        if (conv?.tradePayoff?.lienHolderNeeded && !conv?.tradePayoff?.lienHolderProvided) {
          out =
            "Got it — thanks. If you have the lien holder name and payoff details, send them over and we can keep this moving.";
        } else {
          out = hasMileage
            ? "Got it — thanks for the lien/payoff details."
            : "Got it — thanks for the lien/payoff details. What’s the mileage?";
        }
      } else {
        out =
          "Got it — for a straight cash offer, we’ll need an in‑person appraisal. Do you have any lien or payoff on the bike?";
      }
    } else if (state === "trade_trade") {
      out = "Great — what model are you hoping to trade into?";
    } else if (state === "trade_either") {
      out = "Understood — are you leaning more toward a cash offer or trade credit?";
    }
  }
  if (normalizeOutboundText(out) === normalizeOutboundText(lastOutboundText)) {
    if (state === "trade_cash") {
      out = "Whenever you’re ready, just reach out and we can take a look in person.";
    } else if (state === "trade_trade") {
      out = "If you have a model in mind, let us know — we can also set a time to stop in.";
    } else if (state === "trade_either") {
      out = "We can do either — just let us know which direction you prefer.";
    }
  }
  const phoneNumbersIntent = detectPhoneNumbersIntent(lastInboundText);
  if (phoneNumbersIntent) {
    const sentences = String(out ?? "").split(/(?<=[.!?])\s+/);
    const dropPattern =
      /(in[-\s]?person appraisal|bring (it|the bike) (by|in)|come (in|by)|stop (in|by)|set up a time|schedule|appraisal time|good time to call|when can i call|when should i call|what time to call|call you (today|tomorrow)|is now a good time to call)/i;
    const callQuestion =
      /\b(want|would you like|ok to|okay to|can we|should we|do you want)\b[^.?!]*\bcall\b[^.?!]*\?/i;
    const filtered = sentences.filter(s => !dropPattern.test(s) && !callQuestion.test(s));
    if (filtered.length) {
      out = filtered.join(" ").trim();
    }
    const callLine = "We’ll have someone call you today to go over a rough idea.";
    if (!/call you today|reach out today|give you a call today/i.test(out)) {
      out = `${out} ${callLine}`.trim();
    }
  }
  if (watchIntent && hasPriorTradeAppraisalMention(conv)) {
    out = stripTradeReaskSentences(out);
    if (!out) {
      out = conv.inventoryWatch
        ? buildInventoryWatchConfirmation(conv.inventoryWatch)
        : "Sounds good — I’ll keep an eye out and text you as soon as one comes in.";
    }
  }
  out = stripDuplicateTradeAppraisalMention(out, lastOutboundText);
  return rewriteTradeVoiceToTeam(out);
}

function detectPhoneNumbersIntent(text: string): boolean {
  return /(over the phone|on the phone|phone|numbers|ballpark|rough (idea|number)|general numbers|give me something|where i'm thinking|way out of where i'm thinking)/i.test(
    String(text ?? "")
  );
}

function applyPickupPolicy(conv: any, reply: string): string {
  const text = String(reply ?? "");
  if (!/(pick[-\s]?up|pickup range|street number|street name|address)/i.test(text)) {
    return reply;
  }
  const inboundText = String(getLastInboundBody(conv) ?? "");
  const visitIntent =
    /(come (in|by|up)|stop (in|by)|swing by|drive (up|down)|ride (up|down)|take a ride|look at (it|the)|check (it|them) out|see (it|them))/i;
  const pickupRequested =
    /(pick[-\s]?up|can you pick|have you pick|come get|driver pick)/i;
  if (visitIntent.test(inboundText) && !pickupRequested.test(inboundText)) {
    if (conv.pickup?.stage) {
      conv.pickup = { ...(conv.pickup ?? {}), stage: undefined, updatedAt: nowIso() };
    }
    return "Got it — if you want to come by and take a look, just let me know. We can go over the trade value in person.";
  }
  if (conv.pickup?.eligible === false) {
    return "Got it — we’re outside the usual pickup range for that area. If you can make it in, we can go over the trade value in person. Just let me know when you’re ready.";
  }
  return reply;
}

function inboundAskedToSchedule(text: string): boolean {
  const t = String(text ?? "");
  if (!t.trim()) return false;
  if (detectSoftVisitIntent(t)) return false;
  if (isExplicitScheduleIntent(t)) return true;
  return (
    /\b(today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|this week|next week|this weekend|weekend)\b/i.test(
      t
    ) ||
    /\b\d{1,2}(:\d{2})?\s*(am|pm)\b/i.test(t)
  );
}

function stripSchedulingLanguageIfNotAsked(reply: string, inboundText: string): string {
  if (inboundAskedToSchedule(inboundText)) return reply;
  const schedulePhrase =
    /\b(schedule|appointment|appt|book|reserve|calendar|set (up )?a time|come in|stop in|stop by|visit|which works best|do any of these times work|what day|what time)\b/i;
  if (!schedulePhrase.test(reply)) return reply;
  const financeReplyContext =
    /\b(credit app|credit application|finance application|apply for credit|prequal|pre-qual|financing|finance)\b/i.test(
      reply
    );
  const financeInPersonLine = /\b(stop by|come by|in person|dealership)\b/i;
  const outOfStockContext =
    /\b(not seeing|sold|on hold)\b/.test(reply) &&
    /\b(in stock|available)\b/.test(reply);
  const inventoryWatchInviteLine =
    /\b(text you as soon as one comes in|text you when one lands|keep an eye out|watch for)\b/i;
  const sentences = reply.split(/(?<=[.!?])\s+/);
  const kept = sentences.filter(s => {
    if (!schedulePhrase.test(s)) return true;
    if (financeReplyContext && financeInPersonLine.test(s)) return true;
    if (outOfStockContext && inventoryWatchInviteLine.test(s)) return true;
    return false;
  });
  const trimmed = kept.join(" ").trim();
  if (trimmed) return trimmed;
  // If every sentence is scheduling language, use a clean fallback instead of partial regex surgery.
  const inbound = String(inboundText ?? "").trim();
  if (!inbound) return "";
  if (detectSoftVisitIntent(inbound)) {
    return "Sounds good — just give me a heads-up when you want to stop in.";
  }
  return "Got it — I’m here if you need anything.";
}

function stripSchedulingPromptFromFollowUp(message: string): string {
  const stripped = stripSchedulingLanguageIfNotAsked(message, "");
  if (normalizeOutboundText(stripped)) return stripped;
  return "Just checking in — I’m here if you need anything.";
}

function shouldAllowProactiveScheduleAsk(conv: any, now: Date): boolean {
  const soft = conv?.scheduleSoft;
  if (!soft || soft.lastAskAt) return false;
  const cooldownUntil = soft.cooldownUntil
    ? new Date(soft.cooldownUntil)
    : new Date(new Date(soft.requestedAt).getTime() + SOFT_SCHEDULE_COOLDOWN_MS);
  if (now < cooldownUntil) return false;
  const lastInbound = getLastInboundMessage(conv);
  if (!lastInbound?.at) return false;
  const lastInboundAt = new Date(lastInbound.at);
  if (now.getTime() - lastInboundAt.getTime() < SOFT_SCHEDULE_COOLDOWN_MS) return false;
  return true;
}

function applySoftSchedulePolicy(conv: any, reply: string, inboundText: string): string {
  if (!detectSoftVisitIntent(inboundText)) return reply;
  let out = stripSchedulingLanguageIfNotAsked(reply, inboundText);
  const softLine = "Sounds good — just give me a heads-up when you want to stop in.";
  if (!normalizeOutboundText(out)) return softLine;
  if (/heads[-\s]?up|reach out|just let me know/i.test(out)) return out;
  if (!/[.!?]$/.test(out)) out = `${out}.`;
  return `${out} ${softLine}`.trim();
}

function stripYearPreferenceIfAnyYearSpecified(reply: string, inboundText: string): string {
  const inbound = String(inboundText ?? "").toLowerCase();
  const anyYearSpecified =
    /\b(any year|no year preference|open to other years|either year|any model year)\b/.test(inbound);
  if (!anyYearSpecified) return reply;
  const original = String(reply ?? "");
  if (!original.trim()) return original;
  const prefersFinishPrompt = /\b(chrome|blacked[-\s]?out|finish)\b/i.test(original);
  const replacement = prefersFinishPrompt
    ? "Any specific color or finish you’re after (chrome vs blacked-out)?"
    : "Any specific color you’re after?";
  const patterns: RegExp[] = [
    /\bAny color or year preference\??/gi,
    /\bAny (?:specific )?year or color(?: you(?:'|’)re after| preference)?\??/gi,
    /\bWhat year are you after\??/gi
  ];
  const rewritten = patterns.reduce((text, pattern) => text.replace(pattern, replacement), original);
  if (rewritten === original) return reply;
  return rewritten.replace(/\s{2,}/g, " ").trim();
}

function isPricingText(text: string): boolean {
  return /(price|otd|out the door|payment|monthly|down|apr|term|finance|credit|quote|lowest|best price|how low|low can (you|they) go)/i.test(
    String(text ?? "")
  );
}

function isPaymentText(text: string): boolean {
  return /(monthly payment|what would it be a month|what would it be per month|how much down|money down|put (?:any )?money down|put down|to put down|no money down|zero down|\$0 down|\bapr\b|term|\b\d{2,3}\s*(month|months|mo)\b|\brun\s+(it|that|the numbers?)\s+for\s+\d{2,3}\b)/i.test(
    String(text ?? "")
  );
}

function hasPrimaryIntentBeyondWatch(text: string): boolean {
  const t = String(text ?? "").toLowerCase();
  if (!t.trim()) return false;
  const schedulingSignals = detectSchedulingSignals(t);
  if (
    schedulingSignals.explicit ||
    schedulingSignals.hasDayTime ||
    schedulingSignals.hasDayOnlyAvailability ||
    schedulingSignals.hasDayOnlyRequest
  ) {
    return true;
  }
  if (/\b\d{2,3}\s*(month|months|mo)\b/.test(t)) return true;
  if (/\brun\s+(it|that|the numbers?)\s+for\s+\d{2,3}\b/.test(t)) return true;
  if (isPaymentText(t) || isDownPaymentQuestion(t)) return true;
  return (
    /\b(price|pricing|otd|monthly|apr|term|trade|trade in|appraisal|finance|financing|credit app|credit application|apply|application|schedule|book|appointment|test ride|available|availability|in stock|how many|what do you have|other options|another option|photos?|video|walkaround|specs?|engine|weight|stop in|come in|come by|stop by|look at)\b/.test(
      t
    ) ||
    /\b(do you have|what do you have|any .* in[-\s]?stock)\b/.test(t)
  );
}

function isDownPaymentQuestion(text: string): boolean {
  const t = String(text ?? "").toLowerCase();
  if (!t.trim()) return false;
  return (
    /\b(how much|what(?:'s| is)|amount|do i have to|will i have to|can i)\b[^?]*\b(down|down payment|put down|put money down|money down|deposit|dp|zero down|\$0 down)\b/.test(
      t
    ) ||
    /\b(down payment|put down|put money down|money down|deposit|dp|zero down|\$0 down|no money down)\b/.test(
      t
    )
  );
}

function isModelUnknownForPayments(conv: any): boolean {
  const model = String(conv?.lead?.vehicle?.model ?? conv?.lead?.vehicle?.description ?? "")
    .trim()
    .toLowerCase();
  return !model || /\b(other|full line|full lineup|unknown)\b/.test(model);
}

function isAckOnlyCloseTurn(text: string, lastOutboundText: string): boolean {
  const inbound = String(text ?? "").trim().toLowerCase();
  if (!inbound) return false;
  if (/[?]/.test(inbound)) return false;
  if (hasPrimaryIntentBeyondWatch(inbound)) return false;
  const hasAck =
    /\b(ok|okay|sounds good|got it|will do|thanks|thank you|thx|appreciate it|perfect|cool|awesome|no problem)\b/.test(
      inbound
    );
  if (!hasAck) return false;
  const closeLikeLastOutbound = /\b(if anything changes|just let me know|reach out|i(?:’|')?ll be here when you(?:’|')?re ready|no rush|no pressure|when you(?:’|')?re ready)\b/i.test(
    String(lastOutboundText ?? "")
  );
  return closeLikeLastOutbound;
}

function isExplicitAvailabilityQuestion(text: string): boolean {
  const t = String(text ?? "").toLowerCase();
  if (!t.trim()) return false;
  return (
    /\b(do you have|do u have|you have any|have any|any .* in[-\s]?stock|in[-\s]?stock|availability|available|how many do you have|how many in stock|any others)\b/.test(
      t
    ) ||
    /\bwhat do you have\b/.test(t)
  );
}

function hasPricingDialogContext(conv: any): boolean {
  return (
    String(getDialogState(conv) ?? "").startsWith("pricing_") ||
    hasRecentPricingPromptContext(conv)
  );
}

function hasFinancePrioritySignals(
  text: string,
  conv: any,
  opts?: { pricingOrPaymentsIntent?: boolean; lastOutboundText?: string | null }
): boolean {
  if (opts?.pricingOrPaymentsIntent) return true;
  const lower = String(text ?? "").toLowerCase();
  if (
    /\b(financing|finance|apr|credit score|monthly|per month|down payment|term|0%\s*apr)\b/i.test(
      lower
    )
  ) {
    return true;
  }
  if (isPricingText(text) || isPaymentText(text) || isDownPaymentQuestion(text)) return true;
  if (extractMonthlyBudgetLimit(text) != null) return true;
  if (extractPaymentTermMonths(text) != null) return true;
  if (parseDownPaymentForBudget(text)?.amount != null) return true;
  const bareBudget = extractBareBudgetAmount(text);
  if (bareBudget != null && hasPricingDialogContext(conv)) return true;
  const lastOutboundText =
    String(opts?.lastOutboundText ?? "").trim() ||
    String(getLastNonVoiceOutbound(conv)?.body ?? "").trim();
  if (lastOutboundText) {
    const askedFinanceFollowUpRecently =
      /\b(how much can you put down|about how much down|how much down|money down|down payment|cash down|what monthly payment|what monthly|target monthly|60,?\s*72,?\s*or\s*84|60 months|72 months|84 months|which term|run (?:it|that|the numbers?))/i.test(
        lastOutboundText
      );
    const hasFinanceValueReply =
      parseDownPaymentForBudget(text)?.amount != null ||
      extractMonthlyBudgetLimit(text) != null ||
      extractPaymentTermMonths(text) != null ||
      /\b(yes i have|i have (?:a )?trade|no trade|no trade-in|without a trade)\b/i.test(lower);
    if (askedFinanceFollowUpRecently && hasFinanceValueReply) return true;
  }
  return false;
}

function getDeterministicAvailabilitySignals(
  text: string,
  conv: any
): {
  inventoryCountQuestion: boolean;
  explicitAvailabilityAsk: boolean;
  shouldLookupAvailability: boolean;
} {
  const lower = String(text ?? "").toLowerCase();
  const inventoryCountQuestion =
    /\b(only one|just one|is that all|any others|how many|how many do you have|only one you have)\b/i.test(
      lower
    );
  const explicitAvailabilityAsk = isExplicitAvailabilityQuestion(lower);
  const availabilityPhraseDetected =
    /\b(in[-\s]?stock|available|availability|do you have|have .* in[-\s]?stock|any .* in[-\s]?stock|do you carry|carry any)\b/i.test(
      lower
    );
  const correctionCue = /\b(i meant|actually|sorry|correction|typo)\b/i.test(lower);
  const mentionsModel = !!findMentionedModel(lower);
  const mentionsColor = !!extractColorToken(lower);
  const mentionsFinish = !!extractFinishToken(lower);
  const mentionsCondition = !!normalizeWatchCondition(lower);
  const mentionsYear = !!extractYearSingle(lower);
  const hasAvailabilityContext =
    !!conv.inventoryContext?.model ||
    !!conv.lead?.vehicle?.model ||
    !!conv.lead?.vehicle?.description;
  const hasAvailabilityDetail =
    mentionsModel || mentionsColor || mentionsFinish || mentionsCondition || mentionsYear;
  const referencesContextUnit =
    referencesSpecificInventoryUnit(lower) ||
    /\b(this|that|the)\s+(cvo|street glide|road glide|tri glide|bike|unit|one)\b/.test(lower);
  const shouldLookupAvailability =
    inventoryCountQuestion ||
    ((availabilityPhraseDetected || correctionCue) &&
      (hasAvailabilityDetail || hasAvailabilityContext || referencesContextUnit));
  return { inventoryCountQuestion, explicitAvailabilityAsk, shouldLookupAvailability };
}

function reconcileStateFromRecentManualOutbound(
  conv: any,
  inboundAtIso?: string
): { changed: boolean; reasons: string[] } {
  if (!conv || typeof conv !== "object") return { changed: false, reasons: [] };
  const mode = String(conv.followUp?.mode ?? "").toLowerCase();
  const convMode = String(conv.mode ?? "").toLowerCase();
  if (mode !== "manual_handoff" && convMode !== "human") {
    return { changed: false, reasons: [] };
  }
  const inboundAtMs = new Date(String(inboundAtIso ?? "")).getTime();
  const lastManualOutbound = [...(conv.messages ?? [])]
    .reverse()
    .find((m: any) => {
      if (!m || m.direction !== "out" || !m.body) return false;
      const provider = String(m.provider ?? "").toLowerCase();
      if (provider === "draft_ai" || provider === "voice_transcript") return false;
      if (!Number.isFinite(inboundAtMs)) return true;
      const atMs = new Date(String(m.at ?? "")).getTime();
      return !Number.isFinite(atMs) || atMs <= inboundAtMs;
    });
  if (!lastManualOutbound?.body) return { changed: false, reasons: [] };
  const lastOutboundText = String(lastManualOutbound.body ?? "").toLowerCase();
  const dialogState = String(getDialogState(conv) ?? "").toLowerCase();
  const reasons: string[] = [];
  let changed = false;

  const manualAppointmentCue =
    /\b(see you|i(?:’|')?ll be here|that works|works for me|you(?:’|')?re all set|you are all set|look forward to meeting|come in|stop by|stop in)\b/.test(
      lastOutboundText
    ) ||
    /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/.test(lastOutboundText) ||
    /\b\d{1,2}(?::\d{2})?\s*(am|pm)\b/.test(lastOutboundText);
  const manualFinanceCue =
    /\b(apr|rate|monthly|payment|down payment|put down|term|months?|financing|credit)\b/.test(
      lastOutboundText
    );

  if (
    manualAppointmentCue &&
    [
      "pricing_need_model",
      "inventory_watch_prompted",
      "inventory_init",
      "schedule_soft",
      "followup_paused"
    ].includes(dialogState)
  ) {
    setDialogState(conv, "none");
    changed = true;
    reasons.push("manual_appointment_context");
  }

  if (conv.inventoryWatchPending && manualAppointmentCue) {
    conv.inventoryWatchPending = undefined;
    changed = true;
    reasons.push("clear_inventory_watch_pending_after_manual_context");
  }

  if (manualFinanceCue && dialogState === "pricing_need_model") {
    setDialogState(conv, "pricing_answered");
    changed = true;
    reasons.push("manual_finance_context");
  }

  if (changed) {
    (conv as any).manualStateReconciled = {
      at: nowIso(),
      sourceProvider: lastManualOutbound.provider ?? null,
      sourceAt: lastManualOutbound.at ?? null,
      reasons
    };
  }

  return { changed, reasons };
}

function isOtherInventoryRequestText(text: string): boolean {
  const lower = String(text ?? "").toLowerCase();
  if (!lower.trim()) return false;
  return (
    /\b(any|what|do you have|got)\s+(other|another|different|more)\b/i.test(lower) ||
    (/\b(other|another|different|else|more)\b/i.test(lower) &&
      /\b(in[-\s]?stock|available|availability|options?|ones|units|bikes)\b/i.test(lower))
  );
}

type DeterministicAvailabilityResolution =
  | { kind: "missing_model" }
  | { kind: "reply"; reply: string; mediaUrls?: string[] };

async function resolveDeterministicAvailabilityReply(args: {
  conv: any;
  text: string;
  parsedAvailability?: { model?: string | null; year?: string | number | null; color?: string | null; condition?: string | null } | null;
  otherInventoryRequest?: boolean;
}): Promise<DeterministicAvailabilityResolution> {
  const { conv, parsedAvailability } = args;
  const textLower = String(args.text ?? "").toLowerCase();
  const otherInventoryRequest = !!args.otherInventoryRequest;
  const modelFromText = parsedAvailability?.model ?? findMentionedModel(textLower);
  const priorModel =
    conv.inventoryContext?.model ??
    conv.lead?.vehicle?.model ??
    conv.lead?.vehicle?.description ??
    null;
  const model = modelFromText ?? priorModel ?? null;
  if (!model) return { kind: "missing_model" };
  const modelForLookup = canonicalizeWatchModelLabel(model);
  const modelChanged =
    !!modelFromText &&
    !!priorModel &&
    normalizeModelText(modelFromText) !== normalizeModelText(priorModel);
  const yearFromText =
    parsedAvailability?.year != null
      ? String(parsedAvailability.year)
      : (extractYearSingle(textLower)?.toString() ?? null);
  const colorFromParser = sanitizeColorPhrase(extractColorToken(textLower));
  const colorFromLlm = sanitizeColorPhrase(parsedAvailability?.color ?? null);
  const colorFromText = pickMostSpecificColor(colorFromLlm, colorFromParser);
  const finishFromText = extractFinishToken(textLower);
  const explicitModelNoColorOrFinish = !!modelFromText && !colorFromText && !finishFromText;
  const llmConditionRaw =
    parsedAvailability?.condition && parsedAvailability.condition !== "unknown"
      ? parsedAvailability.condition
      : null;
  const conditionFromText = normalizeWatchCondition(textLower);
  const conditionFromLlm = normalizeWatchCondition(llmConditionRaw);
  const conditionFromLlmTrusted = conditionFromText ? conditionFromLlm : undefined;
  const explicitCondition = conditionFromLlmTrusted ?? conditionFromText;
  const priorCondition = !modelChanged
    ? normalizeWatchCondition(conv.inventoryContext?.condition ?? conv.lead?.vehicle?.condition ?? null)
    : undefined;
  const conditionSearchRequest = /\b(looking for|want|need|after|open to)\b[^.?!]*\b(new|used|pre[-\s]?owned|preowned)\b/i.test(
    textLower
  );
  const resetContextForCondition =
    !modelChanged &&
    !!explicitCondition &&
    ((!!priorCondition && explicitCondition !== priorCondition) || conditionSearchRequest);
  const priorYear =
    !modelChanged && !resetContextForCondition
      ? conv.inventoryContext?.year ?? conv.lead?.vehicle?.year ?? null
      : null;
  const year =
    yearFromText ??
    (!modelChanged && !resetContextForCondition
      ? conv.inventoryContext?.year ?? conv.lead?.vehicle?.year ?? null
      : null);
  const colorCandidate =
    explicitModelNoColorOrFinish
      ? null
      : colorFromText ??
        (!modelChanged && !resetContextForCondition
          ? conv.inventoryContext?.color ?? conv.lead?.vehicle?.color ?? null
          : null);
  const color = sanitizeColorPhrase(colorCandidate) ?? null;
  const finish = extractTrimToken(
    explicitModelNoColorOrFinish
      ? null
      : finishFromText ??
        (!modelChanged && !resetContextForCondition ? conv.inventoryContext?.finish ?? null : null)
  );
  const conditionFromContext =
    !modelChanged && !resetContextForCondition
      ? normalizeWatchCondition(conv.inventoryContext?.condition ?? conv.lead?.vehicle?.condition ?? null)
      : undefined;
  const yearChangedFromContext =
    !!yearFromText &&
    !!priorYear &&
    String(yearFromText).trim() !== String(priorYear).trim();
  const keepContextCondition = !yearChangedFromContext || !!conditionFromText || !!conditionFromLlmTrusted;
  const condition =
    conditionFromLlmTrusted ??
    conditionFromText ??
    (keepContextCondition ? conditionFromContext : undefined);
  if (model || yearFromText || colorFromText || finishFromText || condition) {
    conv.inventoryContext = {
      model: model ?? conv.inventoryContext?.model,
      year:
        (modelChanged || resetContextForCondition) && !yearFromText
          ? undefined
          : year ?? conv.inventoryContext?.year,
      condition:
        modelChanged || resetContextForCondition
          ? (explicitCondition ?? undefined)
          : (condition ?? conv.inventoryContext?.condition),
      color:
        explicitModelNoColorOrFinish
          ? undefined
          : modelChanged || resetContextForCondition
          ? (colorFromText ?? undefined)
          : (colorFromText ?? conv.inventoryContext?.color),
      finish:
        explicitModelNoColorOrFinish
          ? undefined
          : modelChanged || resetContextForCondition
          ? (finishFromText ?? undefined)
          : (finishFromText ?? conv.inventoryContext?.finish),
      updatedAt: nowIso()
    };
  }
  let matches = await findInventoryMatches({ year: year ?? null, model: modelForLookup });
  if (condition) {
    matches = matches.filter(i => inventoryItemMatchesRequestedCondition(i, condition));
  }
  if (color) {
    const leadColor = String(color);
    const leadTrim: "chrome" | "black" | null = finish;
    matches = matches.filter(i => {
      const itemColor = i.color ?? "";
      if (colorMatchesExact(itemColor, leadColor, leadTrim) || colorMatchesAlias(itemColor, leadColor, leadTrim)) {
        return true;
      }
      const itemNorm = normalizeColorBase(itemColor, !!leadTrim);
      const leadNorm = normalizeColorBase(leadColor, !!leadTrim);
      if (!itemNorm || !leadNorm) return false;
      return itemNorm.includes(leadNorm) || leadNorm.includes(itemNorm);
    });
  }
  const holds = await listInventoryHolds();
  const solds = await listInventorySolds();
  const availableMatches = matches.filter(m => {
    const key = normalizeInventoryHoldKey(m.stockId, m.vin);
    return key ? !holds?.[key] && !solds?.[key] : true;
  });
  const leadStockId = conv.lead?.vehicle?.stockId ?? null;
  const leadVin = conv.lead?.vehicle?.vin ?? null;
  const availableMatchesForCount = otherInventoryRequest
    ? availableMatches.filter(
        m => !((leadStockId && m.stockId === leadStockId) || (leadVin && m.vin === leadVin))
      )
    : availableMatches;
  const count = availableMatchesForCount.length;
  const sentMediaUrls = new Set<string>();
  for (const msg of conv.messages ?? []) {
    if (msg.direction !== "out") continue;
    if (!Array.isArray(msg.mediaUrls)) continue;
    for (const url of msg.mediaUrls) {
      if (typeof url === "string" && url) sentMediaUrls.add(url);
    }
  }
  const hasSentPhoto = sentMediaUrls.size > 0;
  const remainingWithImages = availableMatchesForCount.filter(item =>
    Array.isArray(item.images) &&
    item.images.length &&
    !item.images.some((u: string) => sentMediaUrls.has(u))
  );
  const photoRequestedLocal = /\b(photo|picture|pic|image|images)\b/i.test(textLower);
  const extraMediaUrls =
    count > 1 && (photoRequestedLocal || hasSentPhoto)
      ? remainingWithImages
          .slice(0, 2)
          .map(item => item.images?.find((u: string) => /^https?:\/\//i.test(u)) ?? null)
          .filter((u: string | null): u is string => !!u)
      : [];
  const conditionLabel = formatRequestedConditionLabel(condition);
  const yearText = year ? `${year} ` : "";
  const modelLabel = normalizeDisplayCase(modelForLookup ?? model);
  const colorLabel = color ? ` in ${formatColorLabel(color)}` : "";
  const inventoryLabel = `${conditionLabel}${yearText}${modelLabel}${colorLabel}`;
  const inventoryLabelLower = inventoryLabel.toLowerCase();
  const hasPriorSpecificInventoryMention = (conv.messages ?? []).some(
    (m: any) =>
      m?.direction === "out" &&
      typeof m?.body === "string" &&
      m.body.toLowerCase().includes(inventoryLabelLower)
  );
  const paintTrimPrompt = "Are you looking for any paint or trim specifically (chrome vs blacked-out)?";
  const noStockColorFinishPrompt =
    count <= 0 ? await buildColorFinishFollowUpPrompt(conv, model, year, color) : "";
  let reply = "";
  if (otherInventoryRequest) {
    if (count <= 0) {
      reply = `Right now that’s the only ${inventoryLabel} we have in stock. ${paintTrimPrompt}`;
    } else if (count === 1) {
      reply = `Yes — we have one other ${inventoryLabel} in stock. ${paintTrimPrompt}`;
    } else {
      reply = `Yes — we have ${count} other ${inventoryLabel} units in stock. ${paintTrimPrompt}`;
    }
  } else {
    if (count <= 0) {
      reply = `I’m not seeing ${inventoryLabel} in stock right now. ${buildOutOfStockHumanOptionsLine()}${
        noStockColorFinishPrompt ? ` ${noStockColorFinishPrompt}` : ""
      }`;
    } else if (count === 1) {
      reply = hasPriorSpecificInventoryMention
        ? `That’s the only ${inventoryLabel} we have in stock right now. Want to come check it out, or want a couple photos first?`
        : `Yes — we have one ${inventoryLabel} in stock right now. Want to come check it out, or want a couple photos first?`;
    } else {
      reply = `We have ${count} ${inventoryLabel} units in stock right now. Want to come check one out, or want a couple photos first?`;
    }
  }
  if (extraMediaUrls.length) {
    reply += ` Here ${extraMediaUrls.length === 1 ? "is" : "are"} photo${extraMediaUrls.length === 1 ? "" : "s"}.`;
  } else if (photoRequestedLocal && count > 0) {
    reply += " I can have one of the guys send photos over by text.";
  }
  return { kind: "reply", reply, mediaUrls: extraMediaUrls.length ? extraMediaUrls : undefined };
}

function referencesSpecificInventoryUnit(text: string): boolean {
  const t = String(text ?? "").toLowerCase();
  if (!t.trim()) return false;
  return (
    /\b(this|that|the)\s+(one|bike|unit)\b/.test(t) ||
    /\b(it|this|that)\b/.test(t) ||
    /\b(on|for)\s+(?:the\s+)?[a-z]+\s+one\b/.test(t)
  );
}

type CustomerDispositionDecision = {
  reason: "customer_sell_on_own" | "customer_keep_current_bike" | "customer_stepping_back";
  state: "customer_sell_on_own" | "customer_keep_current_bike" | "customer_stepping_back";
};

function parseCustomerDispositionFallback(text: string): CustomerDispositionDecision | null {
  const lower = String(text ?? "").toLowerCase();
  if (hasSellOnOwnSignal(lower)) {
    return { reason: "customer_sell_on_own", state: "customer_sell_on_own" };
  }
  if (hasKeepCurrentBikeSignal(lower)) {
    return { reason: "customer_keep_current_bike", state: "customer_keep_current_bike" };
  }
  if (
    /\b(can(?:not|'t)\s+afford|too (expensive|high)|out of (my )?budget|can't do that right now|cannot do that right now|not in the budget|payments? (are|is) too high)\b/i.test(
      lower
    )
  ) {
    return { reason: "customer_stepping_back", state: "customer_stepping_back" };
  }
  if (/\b(hold off for now|pass for now)\b/i.test(lower)) {
    return { reason: "customer_stepping_back", state: "customer_stepping_back" };
  }
  return null;
}

function resolveCustomerDispositionDecision(
  text: string,
  parsed: CustomerDispositionParse | null
): CustomerDispositionDecision | null {
  const parsedAccepted = isDispositionParserAccepted(parsed);
  const acceptedParsed = parsedAccepted ? parsed : null;
  if (acceptedParsed) {
    if (acceptedParsed.disposition === "sell_on_own") {
      return { reason: "customer_sell_on_own", state: "customer_sell_on_own" };
    }
    if (acceptedParsed.disposition === "keep_current_bike") {
      return { reason: "customer_keep_current_bike", state: "customer_keep_current_bike" };
    }
    if (acceptedParsed.disposition === "stepping_back") {
      return { reason: "customer_stepping_back", state: "customer_stepping_back" };
    }
    if (acceptedParsed.disposition === "defer_no_window") {
      return { reason: "customer_stepping_back", state: "customer_stepping_back" };
    }
  }
  // Fallback for parser-disabled/low-confidence cases.
  return parseCustomerDispositionFallback(text);
}

function applyCustomerDispositionCloseout(conv: any, decision: CustomerDispositionDecision) {
  stopFollowUpCadence(conv, decision.reason);
  setFollowUpMode(conv, "paused_indefinite", decision.reason);
  setDialogState(conv, decision.state as DialogStateName);
  closeConversation(conv, decision.reason);
  stopRelatedCadences(conv, decision.reason, { close: true });
}

function buildFriendlyReachOutClose(hasAppreciation: boolean): string {
  return hasAppreciation
    ? "I hear you, and I appreciate that. If anything changes down the road, just give me a shout."
    : "I hear you. If anything changes down the road, just give me a shout.";
}

function buildCustomerDispositionReply(text: string): string {
  const textLower = String(text ?? "").toLowerCase();
  const hasBikeCompliment =
    /\b(beautiful|nice|great|awesome|amazing|love|like|clean|killer|badass|sweet)\b/i.test(textLower) &&
    /\b(bike|street glide|road glide|harley|motorcycle|ride)\b/i.test(textLower);
  return buildFriendlyReachOutClose(hasBikeCompliment);
}

function hasSellOnOwnSignal(text: string): boolean {
  const t = String(text ?? "").toLowerCase();
  return /\b(sell (it|my bike|my motorcycle|my ride) (on my own|myself)|sell (my bike|my motorcycle|my ride) myself)\b/i.test(
    t
  );
}

function hasKeepCurrentBikeSignal(text: string): boolean {
  const t = String(text ?? "").toLowerCase();
  return /\b(keep (it|my bike|my motorcycle|my ride)|going to keep (it|my bike|my motorcycle|my ride)|gonna keep (it|my bike|my motorcycle|my ride)|just keep (it|my bike|my motorcycle|my ride))\b/i.test(
    t
  );
}

function isSteppingBackDispositionText(text: string): boolean {
  const t = String(text ?? "").toLowerCase();
  return (
    hasSellOnOwnSignal(t) ||
    hasKeepCurrentBikeSignal(t) ||
    /\b(hold off for now|pass for now)\b/i.test(t)
  );
}

function isComplimentOnlyText(text: string): boolean {
  const t = String(text ?? "").toLowerCase().trim();
  if (!t) return false;
  if (isShortAckText(t)) return false;
  const compliment =
    /\b(love|like|awesome|amazing|great|cool|nice|sweet|beautiful|killer|badass|sick|clean|gorgeous)\b/.test(t) ||
    /\b(looks?\s+(great|awesome|amazing|sweet|clean|sick|good)|sweet looking)\b/.test(t) ||
    /\b(v&h|short shots?)\b/.test(t);
  if (!compliment) return false;
  const softVisitIntent =
    /\b(love to see (it|that|this)|would love to see (it|that|this)|want to see (it|that|this)|see it in person|stop by|come by|come in)\b/.test(
      t
    ) ||
    /\b(wish i (didn['’]?t|did not) have plans|can['’]?t make it|can(?:not|'t) make it|not today|this afternoon|later today|tonight|tomorrow)\b/.test(
      t
    );
  if (softVisitIntent) return false;
  const explicitAsk =
    /\?/.test(t) ||
    /\b(price|payment|monthly|otd|apr|term|down|available|availability|in stock|stock|schedule|book|appointment|test ride|trade|finance|credit|call|phone|email|address|hours|open|close|where|when)\b/.test(
      t
    );
  const steppingBackSignal = isSteppingBackDispositionText(t) || /\bnot ready\b/.test(t);
  const watchIntent = isWatchConfirmationIntentText(t);
  return !explicitAsk && !watchIntent && !steppingBackSignal;
}

function buildComplimentReply(): string {
  return "Glad you like it — I can send more photos or a quick walkaround video. Anything specific you want to see?";
}

function buildMediaAffirmativeReply(
  lastOutboundText: string,
  inboundText: string,
  bikeLabel: string
): string | null {
  const prior = String(lastOutboundText ?? "");
  const inbound = String(inboundText ?? "").trim();
  if (!prior || !inbound) return null;

  const mediaOfferPromptedByLastOutbound =
    /\b(want|would you like|prefer)\b[\s\S]{0,80}\b(photo|photos|pic|pics|video|walkaround)\b/i.test(
      prior
    ) ||
    /\b(i can send|can send)\b[\s\S]{0,80}\b(photo|photos|pic|pics|video|walkaround)\b/i.test(prior);
  if (!mediaOfferPromptedByLastOutbound) return null;

  const inboundSimpleAffirmative =
    /^(yes|yep|yeah|ya|sure|ok|okay|sounds good|please|yes please|do it|send it|send them|both)\b/i.test(
      inbound
    ) || /\b(yes please|please do|send (it|them)|both)\b/i.test(inbound);
  if (!inboundSimpleAffirmative) return null;

  const inboundMediaPreferencePhoto = /\b(photo|photos|pic|pics|picture|pictures|images?)\b/i.test(inbound);
  const inboundMediaPreferenceVideo = /\b(video|walkaround|walk around|walkthrough|walk-through|clip)\b/i.test(
    inbound
  );
  const inboundHasOtherPrimaryIntent =
    /\b(price|pricing|payment|monthly|apr|term|trade|appraisal|finance|schedule|appointment|test ride|available|availability|in stock|service records?|records?|mileage)\b/i.test(
      inbound
    );
  if (inboundHasOtherPrimaryIntent) return null;

  const lastAskedPhoto = /\b(photo|photos|pic|pics|picture|pictures|images?)\b/i.test(prior);
  const lastAskedVideo = /\b(video|walkaround|walk around|walkthrough|walk-through|clip)\b/i.test(prior);
  const sendPhotos =
    inboundMediaPreferencePhoto || (!inboundMediaPreferenceVideo && lastAskedPhoto && !lastAskedVideo);
  const sendVideo = inboundMediaPreferenceVideo || (!inboundMediaPreferencePhoto && lastAskedVideo);
  if (sendPhotos && sendVideo) {
    return `Okay — I’ll have one of the guys send photos and a quick walkaround video of ${bikeLabel} over to you.`;
  }
  if (sendPhotos) {
    return `Okay — I’ll have one of the guys send photos of ${bikeLabel} over to you.`;
  }
  return `Okay — I’ll have one of the guys send a quick walkaround video of ${bikeLabel} over to you.`;
}

async function findAutoMediaUrlsForConversationContext(
  conv: any,
  opts?: { max?: number }
): Promise<string[]> {
  const max = Math.max(1, Math.min(4, Number(opts?.max ?? 2)));
  const contextModel = String(
    conv?.inventoryContext?.model ??
      conv?.lead?.vehicle?.model ??
      conv?.lead?.vehicle?.description ??
      ""
  ).trim();
  if (!contextModel) return [];
  const contextYearRaw = String(conv?.inventoryContext?.year ?? conv?.lead?.vehicle?.year ?? "").trim();
  const contextYear = contextYearRaw || null;
  const requestedCondition = normalizeWatchCondition(
    conv?.inventoryContext?.condition ?? conv?.lead?.vehicle?.condition
  );
  const preferredColor = String(conv?.inventoryContext?.color ?? conv?.lead?.vehicle?.color ?? "").trim() || null;
  const leadTrim = extractTrimToken(preferredColor);

  let matches = await findInventoryMatches({ year: contextYear, model: contextModel });
  if (!matches.length && contextYear) {
    matches = await findInventoryMatches({ year: null, model: contextModel });
  }
  if (requestedCondition) {
    matches = matches.filter(i => inventoryItemMatchesRequestedCondition(i, requestedCondition));
  }
  if (preferredColor) {
    const colorFiltered = matches.filter(i => {
      const itemColor = String(i.color ?? "").trim();
      if (!itemColor) return false;
      if (
        colorMatchesExact(itemColor, preferredColor, leadTrim) ||
        colorMatchesAlias(itemColor, preferredColor, leadTrim)
      ) {
        return true;
      }
      const itemNorm = normalizeColorBase(itemColor, !!leadTrim);
      const leadNorm = normalizeColorBase(preferredColor, !!leadTrim);
      return !!itemNorm && !!leadNorm && (itemNorm.includes(leadNorm) || leadNorm.includes(itemNorm));
    });
    if (colorFiltered.length) matches = colorFiltered;
  }
  if (!matches.length) return [];

  const holds = await listInventoryHolds();
  const solds = await listInventorySolds();
  const availableMatches = matches.filter(m => {
    const key = normalizeInventoryHoldKey(m.stockId, m.vin);
    return key ? !holds?.[key] && !solds?.[key] : true;
  });
  if (!availableMatches.length) return [];

  const alreadySent = new Set<string>();
  for (const msg of conv?.messages ?? []) {
    if (msg?.direction !== "out") continue;
    if (!Array.isArray(msg?.mediaUrls)) continue;
    for (const u of msg.mediaUrls) {
      if (typeof u === "string" && u.trim()) alreadySent.add(u.trim());
    }
  }

  const withImages = availableMatches.filter(
    item => Array.isArray(item.images) && item.images.some((u: string) => /^https?:\/\//i.test(String(u ?? "")))
  );
  if (!withImages.length) return [];

  const unseenFirst = withImages
    .map(item => ({
      item,
      urls: (item.images ?? []).filter((u: string) => /^https?:\/\//i.test(String(u ?? "")))
    }))
    .filter(entry => entry.urls.some(u => !alreadySent.has(u)));
  const pool = unseenFirst.length ? unseenFirst : withImages.map(item => ({ item, urls: item.images ?? [] }));

  const picked: string[] = [];
  for (const entry of pool) {
    for (const raw of entry.urls) {
      const url = String(raw ?? "").trim();
      if (!url || picked.includes(url)) continue;
      picked.push(url);
      if (picked.length >= max) return picked;
    }
  }
  return picked;
}

function addMediaRequestTodoIfMissing(conv: any, inboundText: string, sourceMessageId?: string) {
  const alreadyOpen = listOpenTodos().some(
    t =>
      t.convId === conv.id &&
      t.status === "open" &&
      /\b(media request|walkaround|walk around|video|photos?|pics?)\b/i.test(String(t.summary ?? ""))
  );
  if (alreadyOpen) return;
  const clean = String(inboundText ?? "").trim();
  const summary = clean
    ? `Media request: ${clean}`
    : "Media request: Customer asked for a walkaround video/photos.";
  addTodo(conv, "note", summary, sourceMessageId);
}

function buildOutOfStockHumanOptionsLine(): string {
  return "If you'd like, you can stop by and we can go over availability and pricing, or I can text you as soon as one comes in.";
}

function isOutOfStockWatchInviteReply(reply: string): boolean {
  const t = String(reply ?? "").toLowerCase();
  if (!t.trim()) return false;
  const outOfStock =
    /\b(not seeing|sold|on hold)\b/.test(t) &&
    /\b(in stock|available)\b/.test(t);
  const watchInvite =
    /\b(keep an eye out|watch for|text you as soon as one comes in|text you when one lands)\b/.test(
      t
    );
  return outOfStock && watchInvite;
}

async function seedInventoryWatchPendingFromReply(
  conv: any,
  event: InboundMessageEvent,
  reply: string
): Promise<void> {
  if (event.provider !== "twilio") return;
  if (!isOutOfStockWatchInviteReply(reply)) return;
  if (String(conv?.followUp?.mode ?? "").toLowerCase() === "manual_handoff") return;
  const inboundText = String(event.body ?? "");
  const inferredDept = inferDepartmentFromText(inboundText);
  if (inferredDept === "service" || inferredDept === "parts" || inferredDept === "apparel") return;
  const conversationDept = getConversationDepartment(conv);
  if (conversationDept === "service" || conversationDept === "parts" || conversationDept === "apparel") return;
  if (conv.inventoryWatchPending || conv.inventoryWatch || (conv.inventoryWatches?.length ?? 0) > 0) return;
  const model = await resolveWatchModelFromText(
    inboundText.toLowerCase(),
    conv.inventoryContext?.model ?? conv.lead?.vehicle?.model ?? conv.lead?.vehicle?.description ?? null
  );
  if (!model) return;
  const year = extractYearSingle(inboundText.toLowerCase());
  const finish = extractFinishToken(inboundText.toLowerCase());
  const color = combineWatchColorAndFinish(
    extractColorToken(inboundText.toLowerCase()),
    finish
  );
  const budget = resolveWatchBudgetPreferenceForConversation(conv, inboundText);
  conv.inventoryWatchPending = {
    model,
    year: year ?? undefined,
    color,
    minPrice: budget.minPrice,
    maxPrice: budget.maxPrice,
    monthlyBudget: budget.monthlyBudget,
    termMonths: budget.termMonths,
    downPayment: budget.downPayment,
    askedAt: nowIso()
  };
  setDialogState(conv, "inventory_watch_prompted");
}

async function buildColorFinishFollowUpPrompt(
  conv: any,
  model?: string | null,
  year?: string | null,
  color?: string | null
): Promise<string> {
  if (color) return "";
  const modelText = String(model ?? "").trim();
  if (!modelText) return "Are you after a certain color?";
  const leadCondition = normalizeWatchCondition(conv.lead?.vehicle?.condition);
  const yearNum = Number(String(year ?? ""));
  const parsedYear = Number.isFinite(yearNum) ? yearNum : undefined;
  const currentYear = new Date().getFullYear();
  const assumeNew = !leadCondition && !!parsedYear && parsedYear === currentYear;
  const modelRecent = isModelInRecentYears(modelText, currentYear, 1);
  const condition = leadCondition ?? (assumeNew ? "new" : modelRecent ? undefined : "used");
  if (condition !== "new") return "Are you after a certain color?";
  const finishEligible = await shouldAskFinishPreference(modelText, parsedYear, condition);
  return finishEligible
    ? "Are you after a certain color or finish (chrome vs blacked-out)?"
    : "Are you after a certain color?";
}

function extractMonthlyBudgetLimit(text: string): number | null {
  const t = String(text ?? "").toLowerCase();
  if (!t.trim()) return null;
  const monthHint = /\b(month|monthly|per month|a month|\/\s*mo)\b/i.test(t);
  if (!monthHint) return null;
  const capped = t.match(/\b(?:under|below|less than|no more than|max(?:imum)?|around|about|~)\s*\$?\s*([0-9][0-9,]{1,6})\b/i);
  if (capped?.[1]) {
    const n = Number(capped[1].replace(/,/g, ""));
    if (Number.isFinite(n) && n > 0) return n;
  }
  const explicit = t.match(/\$?\s*([0-9][0-9,]{1,6})\s*(?:\/\s*mo|\/\s*month|per month|a month|monthly)\b/i);
  if (explicit?.[1]) {
    const n = Number(explicit[1].replace(/,/g, ""));
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

function extractBareBudgetAmount(text: string): number | null {
  const t = String(text ?? "").toLowerCase();
  if (!t.trim()) return null;
  const capped = t.match(
    /\b(?:under|below|less than|no more than|max(?:imum)?|around|about|~|stay under|keep (?:it|me)?\s*under)\s*\$?\s*([0-9][0-9,]{1,6})\b/i
  );
  if (!capped?.[1]) return null;
  const n = Number(capped[1].replace(/,/g, ""));
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

function hasRecentPricingPromptContext(conv: any): boolean {
  const msgs = Array.isArray(conv?.messages) ? conv.messages : [];
  for (let i = msgs.length - 1; i >= 0 && i >= msgs.length - 6; i -= 1) {
    const m = msgs[i];
    if (!m || m.direction !== "out") continue;
    const body = String(m.body ?? "").toLowerCase();
    if (!body.trim()) continue;
    if (
      /\b(monthly|per month|a month|payment|payments|how much can you put down|money down|down payment|cash down|apr|term|60,? 72,? or 84|60|72|84)\b/.test(
        body
      )
    ) {
      return true;
    }
  }
  return false;
}

function extractPaymentTermMonths(text: string): number | null {
  const t = String(text ?? "").toLowerCase();
  const termMatch = t.match(/\b(60|72|84)\s*(month|mo|mos|months|term)?\b/);
  if (!termMatch?.[1]) return null;
  const months = Number(termMatch[1]);
  return Number.isFinite(months) && months > 0 ? months : null;
}

function hasZeroDownSignal(text: string): boolean {
  const t = String(text ?? "").toLowerCase();
  if (!t.trim()) return false;
  return (
    /\b(no money down|zero down|\$0 down|no down payment)\b/.test(t) ||
    /\b(?:don'?t|dont|do not)\s+have to put\s+(?:anything|nothing|any money|money)\s+down\b/.test(t) ||
    /\b(?:without|with no)\s+(?:any\s+)?(?:money|cash|anything)\s+down\b/.test(t)
  );
}

function parseDownPaymentForBudget(text: string): { amount: number; assumedThousands: boolean } | null {
  const t = String(text ?? "").toLowerCase();
  if (hasZeroDownSignal(t)) {
    return { amount: 0, assumedThousands: false };
  }
  const match = t.match(
    /(?:\$\s*)?(\d{1,3}(?:,\d{3})+|\d+)\s*(k|grand)?\s*(?:down|down payment|deposit|dp|put down)/
  );
  if (!match?.[1]) return null;
  const rawNum = Number(String(match[1]).replace(/,/g, ""));
  if (!Number.isFinite(rawNum) || rawNum <= 0) return null;
  const hasK = !!match[2];
  const hasDollar = t.includes("$");
  let amount = rawNum;
  let assumedThousands = false;
  if (hasK) {
    amount = rawNum * 1000;
  } else if (!hasDollar && rawNum <= 99) {
    amount = rawNum * 1000;
    assumedThousands = true;
  }
  return { amount, assumedThousands };
}

function findRecentInboundPaymentBudgetContext(conv: any): {
  monthlyBudget?: number;
  termMonths?: number;
  downPayment?: number;
} {
  const msgs = Array.isArray(conv?.messages) ? conv.messages : [];
  let monthlyBudget: number | undefined;
  let termMonths: number | undefined;
  let downPayment: number | undefined;
  let inboundScanned = 0;
  for (let i = msgs.length - 1; i >= 0; i -= 1) {
    const m = msgs[i];
    if (!m || m.direction !== "in") continue;
    inboundScanned += 1;
    const body = String(m.body ?? "");
    if (monthlyBudget == null) {
      monthlyBudget = extractMonthlyBudgetLimit(body) ?? undefined;
    }
    if (termMonths == null) {
      termMonths = extractPaymentTermMonths(body) ?? undefined;
    }
    if (downPayment == null) {
      const parsedDown = parseDownPaymentForBudget(body)?.amount;
      const zeroDown = hasZeroDownSignal(body);
      downPayment = parsedDown ?? (zeroDown ? 0 : undefined);
    }
    if (monthlyBudget != null && termMonths != null && downPayment != null) break;
    if (inboundScanned >= 8) break;
  }
  return { monthlyBudget, termMonths, downPayment };
}

function resolvePaymentBudgetForConversation(
  conv: any,
  text: string
): {
  monthlyBudget?: number;
  termMonths?: number;
  downPayment?: number;
} {
  const recent = findRecentInboundPaymentBudgetContext(conv);
  let monthlyBudget = extractMonthlyBudgetLimit(text) ?? recent.monthlyBudget;
  if (monthlyBudget == null) {
    const bareBudget = extractBareBudgetAmount(text);
    const inPricingDialog = String(getDialogState(conv) ?? "").startsWith("pricing_");
    if (bareBudget != null && (inPricingDialog || hasRecentPricingPromptContext(conv))) {
      monthlyBudget = bareBudget;
    }
  }
  const termMonths = extractPaymentTermMonths(text) ?? recent.termMonths;
  const parsedDown = parseDownPaymentForBudget(text)?.amount;
  const zeroDown = hasZeroDownSignal(text);
  const downPayment = parsedDown ?? (zeroDown ? 0 : recent.downPayment);
  return { monthlyBudget, termMonths, downPayment };
}

function parsePriceTokenForWatch(raw: string): number | null {
  const token = String(raw ?? "").trim().toLowerCase();
  if (!token) return null;
  const match = token.match(/^\$?\s*(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s*(k|grand)?\s*$/i);
  if (!match?.[1]) return null;
  let value = Number(String(match[1]).replace(/,/g, ""));
  if (!Number.isFinite(value) || value <= 0) return null;
  const hasDollar = token.includes("$");
  const hasK = !!match[2];
  if (hasK) value *= 1000;
  // Prevent year-like values (e.g. 2024) from being interpreted as price caps.
  if (!hasDollar && !hasK && value >= 1900 && value <= 2099) return null;
  // Price-watch parsing is for realistic vehicle pricing; require explicit currency/k
  // or a value that already looks like a full dollar amount.
  if (!hasDollar && !hasK && value < 1000) return null;
  return Math.round(value);
}

function parseBudgetMoneyInput(raw: unknown): number | undefined {
  const text = String(raw ?? "").trim();
  if (!text) return undefined;
  const strict = parsePriceTokenForWatch(text);
  if (strict != null) return strict;
  const n = Number(text.replace(/[$,\s]/g, ""));
  if (Number.isFinite(n) && n > 0) return Math.round(n);
  const k = text.match(/^(\d+(?:\.\d+)?)\s*(k|grand)$/i);
  if (k?.[1]) {
    const v = Number(k[1]);
    if (Number.isFinite(v) && v > 0) return Math.round(v * 1000);
  }
  return undefined;
}

function extractWatchPricePreference(text: string): { minPrice?: number; maxPrice?: number } {
  const t = String(text ?? "").toLowerCase();
  if (!t.trim()) return {};
  let minPrice: number | undefined;
  let maxPrice: number | undefined;

  const range = t.match(
    /\b(?:between|from)?\s*(\$?\s*\d{1,3}(?:,\d{3})*|\$?\s*\d+(?:\.\d+)?\s*(?:k|grand)?)\s*(?:-|–|to)\s*(\$?\s*\d{1,3}(?:,\d{3})*|\$?\s*\d+(?:\.\d+)?\s*(?:k|grand)?)\b/i
  );
  if (range?.[1] && range?.[2]) {
    const a = parsePriceTokenForWatch(range[1]);
    const b = parsePriceTokenForWatch(range[2]);
    if (a != null && b != null) {
      minPrice = Math.min(a, b);
      maxPrice = Math.max(a, b);
    }
  }

  const cap = t.match(
    /\b(?:under|below|less than|no more than|max(?:imum)?|up to)\s*(\$?\s*\d{1,3}(?:,\d{3})*|\$?\s*\d+(?:\.\d+)?\s*(?:k|grand)?)\b/i
  );
  if (cap?.[1]) {
    const parsed = parsePriceTokenForWatch(cap[1]);
    if (parsed != null) maxPrice = parsed;
  }

  const floor = t.match(
    /\b(?:over|above|at least|more than|min(?:imum)?|from)\s*(\$?\s*\d{1,3}(?:,\d{3})*|\$?\s*\d+(?:\.\d+)?\s*(?:k|grand)?)\b/i
  );
  if (floor?.[1]) {
    const parsed = parsePriceTokenForWatch(floor[1]);
    if (parsed != null) minPrice = parsed;
  }

  if (minPrice != null && maxPrice != null && minPrice > maxPrice) {
    const swap = minPrice;
    minPrice = maxPrice;
    maxPrice = swap;
  }
  return {
    minPrice: Number.isFinite(minPrice as number) ? minPrice : undefined,
    maxPrice: Number.isFinite(maxPrice as number) ? maxPrice : undefined
  };
}

function extractWatchBudgetPreference(text: string): {
  minPrice?: number;
  maxPrice?: number;
  monthlyBudget?: number;
  termMonths?: number;
  downPayment?: number;
} {
  const pricePref = extractWatchPricePreference(text);
  const monthlyBudget = extractMonthlyBudgetLimit(text) ?? undefined;
  const termMonths = extractPaymentTermMonths(text) ?? undefined;
  const down = parseDownPaymentForBudget(text);
  const downPayment = down?.amount ?? undefined;
  return {
    minPrice: pricePref.minPrice,
    maxPrice: pricePref.maxPrice,
    monthlyBudget,
    termMonths,
    downPayment
  };
}

function hasAnyWatchBudgetPreference(pref?: {
  minPrice?: number;
  maxPrice?: number;
  monthlyBudget?: number;
  termMonths?: number;
  downPayment?: number;
} | null): boolean {
  if (!pref) return false;
  return (
    pref.minPrice != null ||
    pref.maxPrice != null ||
    pref.monthlyBudget != null ||
    pref.termMonths != null ||
    pref.downPayment != null
  );
}

function mergeWatchBudgetPreference(
  primary: {
    minPrice?: number;
    maxPrice?: number;
    monthlyBudget?: number;
    termMonths?: number;
    downPayment?: number;
  },
  fallback: {
    minPrice?: number;
    maxPrice?: number;
    monthlyBudget?: number;
    termMonths?: number;
    downPayment?: number;
  }
): {
  minPrice?: number;
  maxPrice?: number;
  monthlyBudget?: number;
  termMonths?: number;
  downPayment?: number;
} {
  return {
    minPrice: primary.minPrice ?? fallback.minPrice,
    maxPrice: primary.maxPrice ?? fallback.maxPrice,
    monthlyBudget: primary.monthlyBudget ?? fallback.monthlyBudget,
    termMonths: primary.termMonths ?? fallback.termMonths,
    downPayment: primary.downPayment ?? fallback.downPayment
  };
}

function findRecentInboundWatchBudgetPreference(conv: any): {
  minPrice?: number;
  maxPrice?: number;
  monthlyBudget?: number;
  termMonths?: number;
  downPayment?: number;
} {
  const msgs = Array.isArray(conv?.messages) ? conv.messages : [];
  for (let i = msgs.length - 1; i >= 0; i -= 1) {
    const m = msgs[i];
    if (!m || m.direction !== "in") continue;
    const parsed = extractWatchBudgetPreference(String(m.body ?? ""));
    if (!hasAnyWatchBudgetPreference(parsed)) continue;
    return parsed;
  }
  return {};
}

function resolveWatchBudgetPreferenceForConversation(
  conv: any,
  text: string
): {
  minPrice?: number;
  maxPrice?: number;
  monthlyBudget?: number;
  termMonths?: number;
  downPayment?: number;
} {
  const fromText = extractWatchBudgetPreference(text);
  const recent = findRecentInboundWatchBudgetPreference(conv);
  return mergeWatchBudgetPreference(fromText, recent);
}

function normalizeTaxRate(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return 0.08;
  if (n >= 1) return n / 100;
  return n;
}

function isUsedInventoryConditionForBudget(condition?: string | null, year?: string | null): boolean {
  const cond = String(condition ?? "").toLowerCase();
  if (/(pre|used|pre-owned|preowned|owned)/.test(cond)) return true;
  const yearNum = Number(String(year ?? ""));
  if (Number.isFinite(yearNum) && yearNum > 0) {
    const nowYear = new Date().getFullYear();
    return yearNum <= nowYear - 2;
  }
  return false;
}

function isTouringModelName(model?: string | null): boolean {
  return /\b(touring|bagger|road glide|street glide|road king|electra glide|ultra|tri glide|freewheeler)\b/i.test(
    String(model ?? "")
  );
}

function isTouringRequestText(text: string): boolean {
  return /\b(touring|bagger|road glide|street glide|road king|electra glide|ultra|tri glide|freewheeler)\b/i.test(
    String(text ?? "")
  );
}

function isTrailerOrTowRequestText(text?: string | null): boolean {
  const t = String(text ?? "").toLowerCase();
  if (!t) return false;
  return /\b(trailer|cargo|utility|enclosed|hauler|tow(?:ing)?|tow[-\s]?dolly|dolly)\b/.test(t);
}

function isLikelyMotorcycleInventoryItem(item: any): boolean {
  const model = String(item?.model ?? "").toLowerCase();
  const stock = String(item?.stockId ?? "").toLowerCase();
  const vin = String(item?.vin ?? "").toUpperCase();

  if (!model && !stock && !vin) return false;
  if (isTrailerOrTowRequestText(model)) return false;
  if (/\btwin cruiser\b/.test(model)) return false;
  if (/^tr\d/.test(stock) && !/\b(tri glide|trike)\b/.test(model)) return false;
  if (/^(2TR|4YH|5KT|1UY|53W|7H3|7M3|1Z9)/.test(vin)) return false;
  return true;
}

function calcMonthlyPayment(principal: number, apr: number, months: number): number {
  const rate = apr / 12;
  if (rate <= 0) return principal / months;
  const pow = Math.pow(1 + rate, months);
  return (principal * rate * pow) / (pow - 1);
}

function calcPrincipalFromMonthlyPayment(monthly: number, apr: number, months: number): number {
  const rate = apr / 12;
  if (rate <= 0) return monthly * months;
  const pow = Math.pow(1 + rate, months);
  return monthly * ((pow - 1) / (rate * pow));
}

function estimateMonthlyPaymentFromPrice(opts: {
  price: number;
  isUsed: boolean;
  termMonths: number;
  taxRate: number;
  downPayment?: number;
}): number | null {
  const price = Number(opts.price);
  if (!Number.isFinite(price) || price <= 0) return null;
  const termMonths = Number(opts.termMonths);
  if (!Number.isFinite(termMonths) || termMonths <= 0) return null;
  const fee = opts.isUsed ? 300 : 1200;
  const taxRate = Number.isFinite(opts.taxRate) ? opts.taxRate : 0.08;
  const down = Number.isFinite(opts.downPayment) ? Number(opts.downPayment) : 0;
  const financed = Math.max(0, (price + fee) * (1 + taxRate) - Math.max(0, down));
  const apr = getPaymentAprMidpoint(opts.termMonths, opts.isUsed);
  return calcMonthlyPayment(financed, apr, termMonths);
}

function estimateMonthlyPaymentBandFromPrice(opts: {
  price: number;
  isUsed: boolean;
  termMonths: number;
  taxRate: number;
  downPayment?: number;
}): { low: number; high: number } | null {
  const price = Number(opts.price);
  if (!Number.isFinite(price) || price <= 0) return null;
  const termMonths = Number(opts.termMonths);
  if (!Number.isFinite(termMonths) || termMonths <= 0) return null;
  const fee = opts.isUsed ? 300 : 1200;
  const taxRate = Number.isFinite(opts.taxRate) ? opts.taxRate : 0.08;
  const down = Number.isFinite(opts.downPayment) ? Number(opts.downPayment) : 0;
  const financed = Math.max(0, (price + fee) * (1 + taxRate) - Math.max(0, down));
  const aprRange = getPaymentAprRange(termMonths, opts.isUsed);
  const low = calcMonthlyPayment(financed, aprRange.min, termMonths);
  const high = calcMonthlyPayment(financed, aprRange.max, termMonths);
  if (!Number.isFinite(low) || !Number.isFinite(high)) return null;
  return { low: Math.min(low, high), high: Math.max(low, high) };
}

function estimateInventoryItemMonthlyPayment(
  item: any,
  opts: { termMonths: number; taxRate: number; downPayment?: number }
): number | null {
  const price = Number(item?.price ?? NaN);
  if (!Number.isFinite(price) || price <= 0) return null;
  return estimateMonthlyPaymentFromPrice({
    price,
    isUsed: isUsedInventoryConditionForBudget(item?.condition, item?.year),
    termMonths: opts.termMonths,
    taxRate: opts.taxRate,
    downPayment: opts.downPayment
  });
}

function estimateRequiredDownPaymentForTarget(opts: {
  price: number;
  isUsed: boolean;
  termMonths: number;
  taxRate: number;
  targetMonthly: number;
}): number | null {
  const price = Number(opts.price);
  const termMonths = Number(opts.termMonths);
  const targetMonthly = Number(opts.targetMonthly);
  if (!Number.isFinite(price) || price <= 0) return null;
  if (!Number.isFinite(termMonths) || termMonths <= 0) return null;
  if (!Number.isFinite(targetMonthly) || targetMonthly <= 0) return null;
  const fee = opts.isUsed ? 300 : 1200;
  const taxRate = Number.isFinite(opts.taxRate) ? opts.taxRate : 0.08;
  const apr = getPaymentAprMidpoint(termMonths, opts.isUsed);
  const totalWithFees = (price + fee) * (1 + taxRate);
  const maxPrincipal = calcPrincipalFromMonthlyPayment(targetMonthly, apr, termMonths);
  if (!Number.isFinite(maxPrincipal)) return null;
  return Math.max(0, totalWithFees - maxPrincipal);
}

function getPaymentAprRange(termMonths: number, isUsed: boolean): { min: number; max: number } {
  const term = Number(termMonths);
  let min = 0.1;
  let max = 0.13;
  if (term >= 84) {
    min = 0.12;
    max = 0.15;
  } else if (term >= 72) {
    min = 0.105;
    max = 0.135;
  } else if (term >= 60) {
    min = 0.095;
    max = 0.125;
  }
  if (isUsed) {
    min += 0.01;
    max += 0.01;
  }
  return { min, max };
}

function getPaymentAprMidpoint(termMonths: number, isUsed: boolean): number {
  const range = getPaymentAprRange(termMonths, isUsed);
  return (range.min + range.max) / 2;
}

function estimateRequiredDownPaymentRangeForTarget(opts: {
  price: number;
  isUsed: boolean;
  termMonths: number;
  taxRate: number;
  targetMonthly: number;
}): { minDown: number; maxDown: number; aprMin: number; aprMax: number } | null {
  const price = Number(opts.price);
  const termMonths = Number(opts.termMonths);
  const targetMonthly = Number(opts.targetMonthly);
  if (!Number.isFinite(price) || price <= 0) return null;
  if (!Number.isFinite(termMonths) || termMonths <= 0) return null;
  if (!Number.isFinite(targetMonthly) || targetMonthly <= 0) return null;
  const fee = opts.isUsed ? 300 : 1200;
  const taxRate = Number.isFinite(opts.taxRate) ? opts.taxRate : 0.08;
  const totalWithFees = (price + fee) * (1 + taxRate);
  const aprRange = getPaymentAprRange(termMonths, opts.isUsed);
  const principalAtLowApr = calcPrincipalFromMonthlyPayment(targetMonthly, aprRange.min, termMonths);
  const principalAtHighApr = calcPrincipalFromMonthlyPayment(targetMonthly, aprRange.max, termMonths);
  if (!Number.isFinite(principalAtLowApr) || !Number.isFinite(principalAtHighApr)) return null;
  const downLowApr = Math.max(0, totalWithFees - principalAtLowApr);
  const downHighApr = Math.max(0, totalWithFees - principalAtHighApr);
  return {
    minDown: Math.min(downLowApr, downHighApr),
    maxDown: Math.max(downLowApr, downHighApr),
    aprMin: aprRange.min,
    aprMax: aprRange.max
  };
}

function buildPaymentTermDownCombosText(opts: {
  price: number;
  isUsed: boolean;
  taxRate: number;
  targetMonthly: number;
  terms?: number[];
}): string {
  const nf = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0
  });
  const terms = (opts.terms ?? [84, 72, 60]).filter(t => Number.isFinite(t) && t > 0);
  const parts: string[] = [];
  for (const term of terms) {
    const band = estimateRequiredDownPaymentRangeForTarget({
      price: opts.price,
      isUsed: opts.isUsed,
      termMonths: term,
      taxRate: opts.taxRate,
      targetMonthly: opts.targetMonthly
    });
    if (!band) continue;
    const aprMinPct = Math.round(band.aprMin * 1000) / 10;
    const aprMaxPct = Math.round(band.aprMax * 1000) / 10;
    const minDown = Math.max(0, Math.round(band.minDown / 100) * 100);
    const maxDown = Math.max(0, Math.round(band.maxDown / 100) * 100);
    const downText =
      minDown === 0 && maxDown === 0
        ? "little to no money down"
        : minDown === maxDown
          ? `about ${nf.format(minDown)} down`
          : `${nf.format(minDown)}-${nf.format(maxDown)} down`;
    parts.push(`${term} mo (${aprMinPct}-${aprMaxPct}% APR): ${downText}`);
  }
  if (!parts.length) return "";
  return `Rough combos to be near ${nf.format(opts.targetMonthly)}/mo: ${parts.join("; ")}.`;
}

function formatBudgetInventoryOption(item: any): string {
  const nf = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
  const year = item?.year ? `${item.year} ` : "";
  const model = normalizeDisplayCase(String(item?.model ?? "").trim()) || "bike";
  const price = Number(item?.price ?? NaN);
  const priceLabel = Number.isFinite(price) && price > 0 ? ` ${nf.format(price)}` : "";
  const stockLabel = item?.stockId ? ` (Stock ${item.stockId})` : "";
  return `${year}${model}${priceLabel}${stockLabel}`.trim();
}

function detectsModelQuestion(text: string): boolean {
  return /\b(which|what)\b.*\bmodel\b/i.test(String(text ?? ""));
}

function detectsPricingAnswer(text: string): boolean {
  return /\b(msrp|price we have listed|prices we have listed|listed price|prices.*range|runs about)\b/i.test(
    String(text ?? "")
  );
}

function isCallOnlyText(text: string): boolean {
  return /\b(call only|phone only|call me only|no text|do not text|don't text|text me not)\b/i.test(
    String(text ?? "")
  );
}

function isTextingTypoJokeText(text: string): boolean {
  const t = String(text ?? "").toLowerCase();
  if (!t) return false;
  const cannotText = /\bi can(?:not|['’]t)\s+text\b/.test(t);
  const correctionSignal = /\b(lol|haha|lmao|i meant|meant)\b/.test(t);
  return cannotText && correctionSignal;
}

function isCustomerWillCallText(text: string): boolean {
  const t = String(text ?? "").toLowerCase();
  if (!t) return false;
  return (
    /\b(i(?:'|’)ll|i will)\s+call\b/.test(t) ||
    /\bcall for (an )?appointment\b/.test(t) ||
    /\bcall (to )?(set|schedule) (an )?appointment\b/.test(t) ||
    /\bcheck my schedule\b/.test(t) ||
    /\blet you know when i(?:'|’)m coming in\b/.test(t) ||
    /\blet you know when i am coming in\b/.test(t)
  );
}

function detectCallbackText(text: string): boolean {
  const t = String(text ?? "").toLowerCase();
  if (isCustomerWillCallText(t)) return false;
  const hasCallback =
    /(call me|call him|call her|give me a call|give (him|her) a call|reach me|reach him|reach her|contact me|can you call|can you have|please call|have .* call)/.test(
      t
    );
  const hasTimeframe =
    /(today|tomorrow|this weekend|this week|next week|tuesday|wednesday|thursday|friday|saturday|sunday|monday|\bmon\b|\btue\b|\bwed\b|\bthu\b|\bfri\b|\bsat\b|\bsun\b|\b\d{1,2}:\d{2}\s*(am|pm)?\b|\b\d{1,2}\s*(am|pm)\b)/.test(
      t
    );
  const hasPhone = /\b\d{3}[-.\s]?\d{3}[-.\s]?\d{4}\b/.test(t);
  const hasTrade = /(trade[-\s]?in|trade in|trading in)/.test(t);
  return hasCallback || (hasTimeframe && (hasPhone || hasTrade));
}

function findMentionedUser(text: string, users: Array<any>): any | null {
  const body = String(text ?? "");
  if (!body) return null;
  for (const user of users ?? []) {
    const name = String(user?.firstName ?? "").trim() || String(user?.name ?? "").split(" ")[0];
    if (!name) continue;
    const token = escapeRegex(name);
    const direct = new RegExp(`^\\s*(hey|hi|yo|ok|okay)?\\s*${token}\\b`, "i");
    const refer = new RegExp(`\\b${token}\\b`, "i");
    const tell = new RegExp(`\\b(tell|let)\\s+${token}\\b`, "i");
    if (direct.test(body) || tell.test(body) || refer.test(body)) {
      return user;
    }
  }
  return null;
}

function isDirectUserMention(text: string, user: any): boolean {
  const body = String(text ?? "");
  if (!body || !user) return false;
  const name = String(user?.firstName ?? "").trim() || String(user?.name ?? "").split(" ")[0];
  if (!name) return false;
  const token = escapeRegex(name);
  const direct = new RegExp(`^\\s*(hey|hi|yo|ok|okay)?\\s*${token}\\b`, "i");
  return direct.test(body);
}

function inboundReferencesOtherPerson(text: string): boolean {
  const t = String(text ?? "").toLowerCase();
  return (
    /\b(call|reach|talk to|speak to|tell|let|ask|have)\s+(him|her)\b/.test(t) ||
    /\b(let|tell)\s+(him|her)\s+know\b/.test(t) ||
    /\b(can|could|would|should)\s+(he|she)\s+(call|text|reach out|follow up)\b/.test(t) ||
    /\b(him|her)\s+(call|text|reach out|follow up)\b/.test(t)
  );
}

function findUserFromRecentOutbound(conv: any, users: Array<any>): any | null {
  const outbounds = [...(conv?.messages ?? [])]
    .reverse()
    .filter((m: any) => m.direction === "out" && m.body);
  for (const m of outbounds.slice(0, 6)) {
    const found = findMentionedUser(m.body, users);
    if (found) return found;
  }
  return null;
}

function applyPricingPolicy(
  conv: any,
  reply: string,
  lastOutboundText: string,
  inboundText?: string,
  opts?: { pricingActiveThisTurn?: boolean }
): string {
  const state = getDialogState(conv);
  if (!(state.startsWith("pricing_") || state === "payments_handoff" || state === "payments_answered")) {
    return reply;
  }
  const body = String(inboundText ?? "");
  const pricingActiveThisTurn =
    opts?.pricingActiveThisTurn === true ||
    isPricingText(body) ||
    isPaymentText(body) ||
    /\b(finance|financing|apr|credit score|monthly|per month|down payment|term|0%\s*apr)\b/i.test(body);
  const schedulingConfirmThisTurn =
    /\b(see you|sounds good|that sounds|works for me|i can come|i['’]ll come|i will come|next week works|this week works|tomorrow works)\b/i.test(
      body
    ) &&
    /\b(mon|tue|wed|thu|fri|sat|sun|monday|tuesday|wednesday|thursday|friday|saturday|sunday|today|tomorrow|next week|this week)\b/i.test(
      body
    );
  if (!pricingActiveThisTurn || schedulingConfirmThisTurn) {
    return reply;
  }
  let out = reply;
  if (state === "pricing_need_model" && !detectsModelQuestion(out)) {
    out = "Which model are you interested in (and any trim or color)?";
  }
  if (normalizeOutboundText(out) === normalizeOutboundText(lastOutboundText)) {
    if (state === "pricing_need_model") {
      out = "Which model are you interested in? If you have a trim or color in mind, share that too.";
    } else if (state === "pricing_answered") {
      out = "If you want a full out‑the‑door quote, I can set a time to stop in or have a manager follow up.";
    } else if (state === "payments_answered") {
      out = "If you want me to tighten that payment estimate, just tell me term and down payment.";
    } else if (state === "pricing_handoff" || state === "payments_handoff") {
      out = "Got it — I’ll have a manager pull the exact numbers and follow up shortly.";
    }
  }
  return out;
}

function applyCallbackPolicy(conv: any, reply: string, lastOutboundText: string): string {
  const state = getDialogState(conv);
  if (state !== "callback_requested" && state !== "callback_handoff") return reply;
  let out = "Got it — I’ll have someone call you shortly.";
  if (normalizeOutboundText(out) === normalizeOutboundText(lastOutboundText)) {
    out = "Thanks — we’ll give you a call soon.";
  }
  return out;
}

function stripNonAdfThanks(reply: string, provider?: string): string {
  if (provider === "sendgrid_adf") return reply;
  let out = reply;
  out = out.replace(
    /^(\\s*(hi|hey)\\s+[^—\\n]+—\\s*)(thanks for[^.]+\\.\\s*)/i,
    "$1"
  );
  out = out.replace(/^(\\s*)thanks for[^.]+\\.\\s*/i, "$1");
  out = out.replace(/\s{2,}/g, " ").replace(/—\s+/g, "— ").trim();
  return out;
}

function stripCallTimingQuestions(reply: string): string {
  const text = String(reply ?? "");
  if (!/(call|phone|reach|give (me|you) a call)/i.test(text)) return reply;
  const sentences = text.split(/(?<=[.!?])\s+/);
  const dropPattern =
    /(good time to (call|talk)|when can (i|we) (call|talk)|when should (i|we) (call|talk)|what time (works|is best) (for|to) (a )?(call|talk)|is now a good time to (call|talk)|can i (call|talk) (to )?(you )?(now|today|tomorrow)|what time should i (call|talk))/i;
  const filtered = sentences.filter(s => !dropPattern.test(s));
  return filtered.length ? filtered.join(" ").trim() : reply;
}

function stripAgentCallFollowupWhenCustomerWillCall(reply: string, inboundText: string): string {
  if (!isCustomerWillCallText(inboundText)) return reply;
  const text = String(reply ?? "");
  if (!text.trim()) return reply;
  const sentences = text.split(/(?<=[.!?])\s+/);
  const dropPattern =
    /\b(i(?:'|’)ll have|i will have|someone from .* will call|someone will call|we(?:'|’)ll call|we will call|call you (today|tomorrow|shortly)|reach out (today|tomorrow|shortly)|sales team will call)\b/i;
  const filtered = sentences.filter(s => !dropPattern.test(s));
  const cleaned = filtered.join(" ").replace(/\s{2,}/g, " ").trim();
  if (cleaned) return cleaned;
  return "Sounds good — thanks for the update. When you’re ready, call us or text us and we can line up the appraisal.";
}

function applyServicePolicy(conv: any, reply: string, lastOutboundText: string): string {
  const state = getDialogState(conv);
  const isService =
    isServiceDialogState(state) ||
    conv.classification?.bucket === "service" ||
    conv.classification?.cta === "service_request";
  if (!isService) return reply;
  let out = "We’ve received your service request and will have the service department reach out.";
  if (normalizeOutboundText(out) === normalizeOutboundText(lastOutboundText)) {
    out = "Got it — our service department will be in touch shortly.";
  }
  return out;
}

function parseSellOptionFromText(text: string): "cash" | "trade" | "either" | null {
  const t = String(text ?? "").toLowerCase();
  if (!t) return null;
  const cash = /\b(cash offer|straight cash|cash)\b/.test(t) && !/\b(cash down|down payment)\b/.test(t);
  const trade = /\b(trade[-\s]?in|trade in|trading in|trade credit|trade toward|trade for)\b/.test(t);
  if (cash && trade) return "either";
  if (cash) return "cash";
  if (trade) return "trade";
  if (/\b(either|both)\b/.test(t)) return "either";
  return null;
}

function extractTradeYearCorrection(
  text: string,
  baselineYear?: string | number | null
): string | null {
  const t = String(text ?? "").toLowerCase();
  if (!t) return null;

  const baseline = baselineYear != null ? String(baselineYear) : null;
  const direct = t.match(/\b(it'?s|it is|its)\s+(?:a\s+)?(19\d{2}|20\d{2})\b/i)?.[2] ?? null;
  if (direct && (!baseline || direct !== baseline)) {
    return direct;
  }

  const years = Array.from(t.matchAll(/\b(19\d{2}|20\d{2})\b/g)).map(m => m[1]);
  if (!years.length) return null;

  const notYear = t.match(/\bnot\s+(?:a\s+)?(19\d{2}|20\d{2})\b/i)?.[1] ?? null;
  if (notYear) {
    const candidate = years.find(y => y !== notYear);
    if (candidate) return candidate;
  }

  const correctionCue = /\b(actually|correction|meant|wrong year)\b/.test(t);
  if (!correctionCue) return null;

  if (baseline) {
    const candidate = years.find(y => y !== baseline);
    if (candidate) return candidate;
  }
  return years[0] ?? null;
}

function normalizeModelName(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

function extractYearRange(text: string): { min: number; max: number } | null {
  const t = text.toLowerCase();
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

function extractYearSingle(text: string): number | null {
  const m = text.match(/\b(20\d{2})\b/);
  if (!m) return null;
  const year = Number(m[1]);
  return Number.isFinite(year) ? year : null;
}

const INVENTORY_COLOR_PHRASES = [
  "iron horse metallic",
  "blood orange and vivid black black trim",
  "blood orange and vivid black chrome trim",
  "blood orange and black",
  "blood orange",
  "olive steel metallic and vivid black black trim",
  "olive steel metallic and vivid black chrome trim",
  "olive steel metallic and vivid black",
  "olive steel and black",
  "olive steel black",
  "midnight ember chrome trim",
  "midnight ember",
  "gunship gray",
  "inferno gray",
  "dark billiard gray",
  "purple abyss denim",
  "purple abyss",
  "vivid black",
  "matte black metallic",
  "billiard gray",
  "billiard red"
].sort((a, b) => b.length - a.length);

function buildInventoryColorPhrasesFromFeed(items: InventoryFeedSnapshot): string[] {
  if (!Array.isArray(items) || items.length === 0) return [];
  const out = new Set<string>();
  const baseRegistry = [...INVENTORY_COLOR_PHRASES];
  const maybeAdd = (rawText: string | null | undefined) => {
    const raw = String(rawText ?? "").trim();
    if (!raw) return;
    const cleaned = sanitizeColorPhrase(raw);
    if (!cleaned) return;
    if (cleaned.length < 3 || cleaned.length > 80) return;
    const normalized = normalizeColor(cleaned);
    if (!normalized || BASIC_COLOR_WORDS.includes(normalized)) return;
    out.add(normalized);
  };
  for (const item of items) {
    const itemAny = item as Record<string, unknown>;
    maybeAdd(item?.color);
    const textFields = [
      itemAny.title,
      itemAny.name,
      itemAny.description,
      itemAny.vehicleDescription,
      item?.model
    ];
    for (const field of textFields) {
      const text = normalizeColor(String(field ?? ""));
      if (!text) continue;
      const direct = baseRegistry.find(c => text.includes(c));
      if (direct) maybeAdd(direct);
      const yearStockPattern =
        /\b20\d{2}\s+[a-z0-9\s-]{2,50}\s+[a-z]{1,5}\d{1,4}(?:[-\s]\d{2})?\s+([a-z][a-z0-9\s-]{3,50}?)(?:\s+(?:black|chrome)\s+trim)?(?:\s|$)/i;
      const patternMatch = String(field ?? "").match(yearStockPattern);
      if (patternMatch?.[1]) maybeAdd(patternMatch[1]);
    }
  }
  return Array.from(out).sort((a, b) => b.length - a.length);
}

function getInventoryColorPhraseRegistry(): string[] {
  const merged = new Set<string>([...INVENTORY_COLOR_PHRASES, ...dynamicInventoryColorPhrases]);
  return Array.from(merged).sort((a, b) => b.length - a.length);
}

const BASIC_COLOR_WORDS = [
  "black",
  "white",
  "red",
  "blue",
  "gray",
  "grey",
  "silver",
  "green",
  "orange",
  "yellow",
  "brown",
  "tan",
  "chrome",
  "purple"
];

function extractTwoToneColorPhrase(text: string): string | null {
  const cleaned = text
    .replace(
      /^(what about|about|i m looking for|im looking for|i am looking for|looking for|i m after|im after|i am after|after|i want|want|i need|need|so you have|so do you have|do you have|you have|have)\s+(an|a|the)?\s*/i,
      ""
    )
    .replace(/\s+/g, " ")
    .trim();
  const pattern =
    /\b([a-z][a-z0-9\s-]{2,40}?\s+and\s+(?:black|white|red|blue|gray|grey|silver|green|orange|yellow|brown|tan|chrome|purple))\b(?:\s+(?:one|bike|model|option|version|trim))?/i;
  const m = cleaned.match(pattern);
  if (!m?.[1]) return null;
  const phrase = m[1].replace(/\s+/g, " ").trim();
  if (BASIC_COLOR_WORDS.includes(phrase)) return null;
  return phrase;
}

function sanitizeColorPhrase(text: string | null | undefined): string | undefined {
  const cleaned = String(text ?? "")
    .toLowerCase()
    .replace(/['’"]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(
      /^(what about|about|i m looking for|im looking for|i am looking for|looking for|m looking for|i m after|im after|i am after|after|i want|want|i need|need|so you have|so do you have|do you have|you have|have)\s+(an|a|the)?\s*/i,
      ""
    )
    .replace(/^[,.:;\-]+|[,.:;\-]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || undefined;
}

function extractColorFromTrimContext(text: string): string | null {
  const trimScoped =
    text.match(
      /\b([a-z][a-z0-9\s-]{2,70}?)\s+(?:and\s+)?(?:black(?:ed)?(?:\s|-)?out|black(?:\s|-)?out|black\s+trim|black\s+finish|chrome\s+trim|chrome\s+finish|chrome)\b/i
    )?.[1] ?? null;
  if (!trimScoped) return null;

  let candidate = sanitizeColorPhrase(trimScoped);
  if (!candidate) return null;
  candidate = candidate
    .replace(/^(new|used|pre[-\s]?owned)\s+/i, "")
    .replace(/^(an|a|the)\s+/i, "")
    .replace(/^any\s+/i, "")
    .replace(/^\d{4}\s+/, "")
    .replace(/\b(ones?|bikes?|units?|models?|options?)\b$/i, "")
    .replace(/\b(with|w|in)\b\s*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!candidate) return null;

  const colorWordMatch = candidate.match(
    /\b(black|white|red|blue|gray|grey|silver|green|orange|yellow|brown|tan|purple)\b/i
  );
  if (colorWordMatch?.[1]) {
    return colorWordMatch[1].toLowerCase();
  }

  const mentionedModel = findMentionedModel(text);
  if (mentionedModel) {
    const modelPattern = normalizeModelText(mentionedModel).replace(/\s+/g, "\\s+");
    if (modelPattern) {
      candidate = candidate
        .replace(new RegExp(`\\b${modelPattern}\\b`, "i"), " ")
        .replace(/\s+/g, " ")
        .trim()
        .replace(/\b(with|w|in)\b\s*$/i, "")
        .trim();
    }
    const modelNorm = normalizeModelText(mentionedModel);
    const candidateNorm = normalizeModelText(candidate);
    if (!candidateNorm || candidateNorm === modelNorm) return null;
  }

  if (!candidate || candidate === "black" || candidate === "chrome") return null;
  return candidate;
}

function extractColorToken(text: string): string | null {
  const t = text
    .toLowerCase()
    .replace(/['’"]/g, " ")
    .replace(/[\/&]+/g, " and ")
    .replace(/\s+/g, " ")
    .trim();
  const direct = getInventoryColorPhraseRegistry().find(c => t.includes(c));
  if (direct) return direct;
  const twoTone = extractTwoToneColorPhrase(t);
  if (twoTone) return twoTone;
  const hasTrimContext =
    /\b(black(?:ed)?(?:\s|-)?out|black(?:\s|-)?out|black\s+trim|black\s+finish|chrome\s*(?:trim|finish)|chrome\s+trim)\b/i.test(
      t
    );
  if (hasTrimContext) {
    const trimScopedColor = extractColorFromTrimContext(t);
    if (trimScopedColor) return trimScopedColor;
    const nonTrimColor = BASIC_COLOR_WORDS.find(
      color => color !== "black" && color !== "chrome" && new RegExp(`\\b${color}\\b`, "i").test(t)
    );
    if (nonTrimColor) return nonTrimColor;
    if (/\bblack\b/i.test(t)) return "black";
  }
  for (const color of BASIC_COLOR_WORDS) {
    if (hasTrimContext && (color === "black" || color === "chrome")) continue;
    if (new RegExp(`\\b${color}\\b`, "i").test(t)) return color;
  }
  return /\bolive\s+steel\b/.test(t) && /\bblack\b/.test(t) ? "olive steel and black" : null;
}

function extractFinishToken(text: string): "chrome" | "black" | null {
  const t = text.toLowerCase();
  if (/\bchrome(\s+(trim|finish))?\b/.test(t)) return "chrome";
  if (/\bblack(ed)?\s*(out|trim|finish)\b/.test(t) || /\bblack\s+trim\b/.test(t)) return "black";
  return null;
}

function combineWatchColorAndFinish(
  color: string | null | undefined,
  finish: "chrome" | "black" | null
): string | undefined {
  const baseColor = sanitizeColorPhrase(color);
  if (!finish) return baseColor;
  if (baseColor) {
    if (new RegExp(`\\b${finish}\\s+trim\\b`, "i").test(baseColor)) return baseColor;
    return `${baseColor} ${finish} trim`;
  }
  return `${finish} trim`;
}

function inferWatchCondition(
  model: string | undefined,
  year: number | undefined,
  conv: Conversation
): "new" | "used" | undefined {
  const leadCondition = normalizeWatchCondition(conv.lead?.vehicle?.condition);
  if (leadCondition) return leadCondition;
  const currentYear = new Date().getFullYear();
  if (year && year === currentYear) return "new";
  if (model && !isModelInRecentYears(model, currentYear, 1)) return "used";
  return undefined;
}

async function shouldAskFinishPreference(
  model: string | undefined,
  year: number | undefined,
  condition?: string | null
): Promise<boolean> {
  if (condition !== "new" || !model) return false;
  const targetYear = year ?? new Date().getFullYear();
  return modelHasFinishOptions({ year: String(targetYear), model });
}

function buildWatchPreferencePrompt(
  condition?: string | null,
  finishEligible?: boolean
): string {
  if (condition !== "new") {
    return "Got it — should I watch for a specific year or a year range? If a range, tell me the years you want.";
  }
  if (finishEligible) {
    return "Got it — just to confirm, should I watch for the exact year/color/finish, the same year any color, or a year range? If a range, tell me the years you want.";
  }
  return "Got it — just to confirm, should I watch for the exact year/color, the same year any color, or a year range? If a range, tell me the years you want.";
}

function buildWatchUpdateHint(condition?: string | null, finishEligible?: boolean): string {
  if (condition !== "new") return "year and model";
  if (finishEligible) return "year, model, and any color/finish preference";
  return "year, model, and any color preference";
}

function parseInventoryWatchPreference(
  text: string,
  pending: InventoryWatchPending
): { action: "set" | "clarify" | "ignore"; watch?: InventoryWatch } {
  const t = text.toLowerCase();
  if (!pending.model) return { action: "ignore" };

  const similar =
    /(similar|anything like|anything similar|anything close|whatever you can find|open to similar)/.test(
      t
    );
  const specificAnyPreference =
    /\b(any color|any colour|any year|any trim|any finish|any condition)\b/.test(t);
  const mentionsPreference =
    /(exact|only|same|no preference|no pref|either|range|year|color|colour|trim|finish|condition)/.test(t) ||
    specificAnyPreference ||
    similar ||
    /\b(20\d{2})\b/.test(t);
  if (!mentionsPreference) return { action: "ignore" };

  const anyColor =
    /(any color|no color preference|no preference|any colour|no colour preference)/.test(t) ||
    similar;
  const anyYear =
    /(any year|no year preference|no preference|open to other years|either year)/.test(t) ||
    similar;
  const exact = /(exact|only|same color|same colour|only that|just that|same year)/.test(t);

  const finish = extractFinishToken(t);
  const baseColor = anyColor ? undefined : sanitizeColorPhrase(extractColorToken(t) ?? pending.color);
  const color = combineWatchColorAndFinish(baseColor, finish);
  const budgetFromText = extractWatchBudgetPreference(text);
  const range = extractYearRange(t);
  let yearMin: number | undefined;
  let yearMax: number | undefined;
  let year: number | undefined;

  if (range) {
    yearMin = range.min;
    yearMax = range.max;
  } else if (!anyYear) {
    const single = extractYearSingle(t);
    if (single) year = single;
    else if (pending.year && /(same year|this year|that year|current year)/.test(t)) year = pending.year;
    else if (pending.year && exact) year = pending.year;
  }

  if (!year && !yearMin && !yearMax && anyYear) {
    year = undefined;
  }

  const watch: InventoryWatch = {
    model: pending.model,
    color,
    year,
    yearMin,
    yearMax,
    minPrice: budgetFromText.minPrice ?? pending.minPrice,
    maxPrice: budgetFromText.maxPrice ?? pending.maxPrice,
    monthlyBudget: budgetFromText.monthlyBudget ?? pending.monthlyBudget,
    termMonths: budgetFromText.termMonths ?? pending.termMonths,
    downPayment: budgetFromText.downPayment ?? pending.downPayment,
    exactness: "model_only",
    status: "active",
    createdAt: new Date().toISOString()
  };
  if (
    watch.minPrice != null &&
    watch.maxPrice != null &&
    Number.isFinite(watch.minPrice) &&
    Number.isFinite(watch.maxPrice) &&
    watch.minPrice > watch.maxPrice
  ) {
    const swap = watch.minPrice;
    watch.minPrice = watch.maxPrice;
    watch.maxPrice = swap;
  }

  if (watch.yearMin && watch.yearMax) watch.exactness = "model_range";
  else if (watch.year && watch.color) watch.exactness = "exact";
  else if (watch.year) watch.exactness = "year_model";

  const hasYearInfo = !!watch.year || (!!watch.yearMin && !!watch.yearMax);
  if (!hasYearInfo && !anyYear && pending.year) {
    // Still unclear; ask again
    return { action: "clarify" };
  }

  return { action: "set", watch };
}

function buildWatchBudgetText(watch: InventoryWatch): string {
  const nf = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0
  });
  const minPrice = Number(watch.minPrice ?? NaN);
  const maxPrice = Number(watch.maxPrice ?? NaN);
  const hasMin = Number.isFinite(minPrice) && minPrice > 0;
  const hasMax = Number.isFinite(maxPrice) && maxPrice > 0;
  const monthlyBudget = Number(watch.monthlyBudget ?? NaN);
  const hasMonthly = Number.isFinite(monthlyBudget) && monthlyBudget > 0;
  const termMonthsRaw = Number(watch.termMonths ?? NaN);
  const termMonths = Number.isFinite(termMonthsRaw) && termMonthsRaw > 0 ? termMonthsRaw : undefined;
  const downPaymentRaw = Number(watch.downPayment ?? NaN);
  const downPayment = Number.isFinite(downPaymentRaw) && downPaymentRaw > 0 ? downPaymentRaw : undefined;

  const parts: string[] = [];
  if (hasMin && hasMax) {
    parts.push(`between ${nf.format(minPrice)} and ${nf.format(maxPrice)}`);
  } else if (hasMax) {
    parts.push(`up to ${nf.format(maxPrice)}`);
  } else if (hasMin) {
    parts.push(`from ${nf.format(minPrice)}`);
  }
  if (hasMonthly) {
    let paymentPart = `around ${nf.format(monthlyBudget)}/mo`;
    if (termMonths) paymentPart += ` at ${termMonths} months`;
    if (downPayment) paymentPart += ` with about ${nf.format(downPayment)} down`;
    parts.push(paymentPart);
  }
  if (!parts.length) return "";
  return ` ${parts.join(" and ")}`;
}

function buildInventoryWatchConfirmation(watch: InventoryWatch): string {
  const yearText = watch.year
    ? `${watch.year} `
    : watch.yearMin && watch.yearMax
      ? `${watch.yearMin}-${watch.yearMax} `
      : "";
  const cleanColor = sanitizeColorPhrase(watch.color) ?? watch.color;
  const colorText = cleanColor ? ` in ${cleanColor}` : "";
  const budgetText = buildWatchBudgetText(watch);
  return `Got it — I’ll keep an eye out for ${yearText}${watch.model}${colorText}${budgetText} and text you as soon as one comes in.`;
}

function isWatchConfirmationIntentText(text: string): boolean {
  const t = String(text ?? "").toLowerCase();
  if (!t.trim()) return false;
  const intent =
    /\b(let me know|keep me posted|keep an eye out|watch for|notify me|text me|call me|shoot me(?: a)? (?:text|message|one)|shot me(?: a)? (?:text|message|one)|send(?:ing)? (?:it|one|them)?\s*my way|send(?:ing)? (?:it|one|them)?\s*over)\b/.test(
      t
    );
  const trigger =
    /\b(if|when|whenever|once|as soon as)\b/.test(t) ||
    /\b(comes in|available|in stock|get one|get any|find one|one comes in)\b/.test(t);
  return intent && trigger;
}

async function resolveWatchModelFromText(
  textLower: string,
  fallbackModel?: string | null
): Promise<string | null> {
  const fallback = String(fallbackModel ?? "").trim();
  const normalized = normalizeModelText(textLower);
  if (/\biron\b/.test(normalized)) {
    if (is883ModelToken(normalized)) return "Sportster 883";
    return "Iron";
  }
  if (/\bsportster\b/.test(normalized) && is883ModelToken(normalized)) {
    return "Sportster 883";
  }
  if (/\b(any|all)\s+sportsters?\b/.test(normalized) || /\bany\s+year\s+sportsters?\b/.test(normalized)) {
    return "Sportster";
  }
  try {
    const items = await getInventoryFeedHot();
    const inventoryModels = Array.from(new Set(items.map(i => i.model).filter(Boolean))) as string[];
    const range = extractYearRange(textLower);
    const singleYear = extractYearSingle(textLower);
    const rangeModels = range ? getModelsForYearRange(range.min, range.max) : [];
    const yearModels = !range && singleYear ? getModelsForYear(singleYear) : [];
    const allModels = !range && !singleYear ? getAllModels() : [];
    const catalogModelNames = getCatalogModelNameCandidates();
    const models = Array.from(
      new Set(
        [...inventoryModels, ...rangeModels, ...yearModels, ...allModels, ...catalogModelNames]
          .filter(Boolean)
          .map(m => String(m))
      )
    );
    models.sort((a, b) => b.length - a.length);
    const match = models.find(m => textLower.includes(m.toLowerCase()));
    if (match) return match;
  } catch (e) {
    // ignore inventory feed lookup failures; fall back to lead model
  }
  return fallback || null;
}

function isVideoRequest(text: string): boolean {
  const t = (text ?? "").toLowerCase();
  return /\b(video|walkaround|walk around|walk-through|walkthrough|clip)\b/.test(t);
}

function isServiceRecordsRequest(text: string): boolean {
  const t = String(text ?? "").toLowerCase();
  return (
    /(service records?|service history|maintenance records?|maintenance history)/.test(t) ||
    /\b(battery|tires?|tire age)\b/.test(t)
  );
}

function parseOfferSlotsFromReply(reply: string): { startLocal: string; endLocal: string }[] {
  const text = String(reply ?? "");
  const marker = " — do any of these times work?";
  const head = text.includes(marker) ? text.split(marker)[0] : text;
  const idx = head.indexOf("I have ");
  if (idx === -1) return [];
  const tail = head.slice(idx + "I have ".length);
  const parts = tail.split(" or ");
  if (parts.length < 2) return [];
  const a = parts[0].trim();
  const b = parts[1].trim();
  if (!a || !b) return [];
  return [
    { startLocal: a, endLocal: "" },
    { startLocal: b, endLocal: "" }
  ];
}

function inferDayTokenFromSlot(text: string): string | null {
  const t = String(text ?? "").toLowerCase();
  const m = t.match(/\b(mon|monday|tue|tues|tuesday|wed|wednesday|thu|thur|thurs|thursday|fri|friday|sat|saturday|sun|sunday)\b/);
  if (!m) return null;
  const token = m[1];
  const map: Record<string, string> = {
    mon: "monday",
    monday: "monday",
    tue: "tuesday",
    tues: "tuesday",
    tuesday: "tuesday",
    wed: "wednesday",
    wednesday: "wednesday",
    thu: "thursday",
    thur: "thursday",
    thurs: "thursday",
    thursday: "thursday",
    fri: "friday",
    friday: "friday",
    sat: "saturday",
    saturday: "saturday",
    sun: "sunday",
    sunday: "sunday"
  };
  return map[token] ?? null;
}

function slotMatchesReply(slotStartLocal: string, reply: string): boolean {
  const slotToken = extractTimeToken(slotStartLocal);
  const replyToken = extractTimeToken(reply);
  if (!slotToken || !replyToken) return false;
  const stripAp = (t: string) => t.replace(/(am|pm)$/i, "");
  const replyHasAp = /(am|pm)$/i.test(replyToken);
  return replyHasAp ? slotToken === replyToken : stripAp(slotToken) === stripAp(replyToken);
}

function chooseSlotFromReply(slots: any[], reply: string): any | null {
  const text = (reply || "").toLowerCase();
  if (!Array.isArray(slots) || slots.length === 0) return null;
  const replyToken = extractTimeToken(reply);
  if (replyToken) {
    for (const slot of slots) {
      if (slotMatchesReply(slot.startLocal ?? "", reply)) return slot;
    }
    return null;
  }
  if (/(^|\b)(first|1st|earlier)(\b|$)/.test(text)) return slots[0];
  if (/(^|\b)(second|2nd|later)(\b|$)/.test(text)) return slots[1] ?? slots[0];
  for (const slot of slots) {
    if (slotMatchesReply(slot.startLocal ?? "", reply)) return slot;
  }
  return null;
}

function draftHasSpecificTimes(text: string): boolean {
  const s = (text || "").toLowerCase();
  const timePattern = /\b\d{1,2}:\d{2}\b|\b\d{1,2}\s*(am|pm)\b/;
  const hasTwoOptions = /\bi have\b.*\bor\b/.test(s) && timePattern.test(s);
  const hasWeekday = /\b(mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)\b/.test(s);
  return hasTwoOptions || (hasWeekday && timePattern.test(s));
}

function getAppointmentTypeColorId(
  cfg: Awaited<ReturnType<typeof getSchedulerConfig>>,
  appointmentType?: string | null
): string | undefined {
  const key = String(appointmentType ?? "").trim();
  if (!key) return undefined;
  const raw = (cfg.appointmentTypes ?? {})[key]?.colorId;
  const colorId = typeof raw === "string" ? raw.trim() : "";
  return colorId ? colorId : undefined;
}

async function buildDay2Options(
  cfg: Awaited<ReturnType<typeof getSchedulerConfig>>
): Promise<{ message: string; slots: any[] } | null> {
  const appointmentTypes = cfg.appointmentTypes ?? { inventory_visit: { durationMinutes: 60 } };
  const preferredSalespeople = getPreferredSalespeople(cfg);
  const salespeople = cfg.salespeople ?? [];
  const gapMinutes = cfg.minGapBetweenAppointmentsMinutes ?? 60;
  if (!preferredSalespeople.length || !salespeople.length) return null;
  const durationMinutes = appointmentTypes["inventory_visit"]?.durationMinutes ?? 60;
  const now = new Date();
  const candidatesByDay = generateCandidateSlots(cfg, now, durationMinutes, 14);

  let cal: any = null;
  try {
    cal = await getAuthedCalendarClient();
  } catch {
    cal = null;
  }

  for (const salespersonId of preferredSalespeople) {
    const sp = salespeople.find(p => p.id === salespersonId);
    if (!sp) continue;

    let busy: any[] = [];
    if (cal) {
      const timeMin = new Date(now).toISOString();
      const timeMax = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000).toISOString();
      const fb = await queryFreeBusy(cal, [sp.calendarId], timeMin, timeMax, cfg.timezone);
      busy = fb.calendars?.[sp.calendarId]?.busy ?? [];
    }
    const expanded = expandBusyBlocks(busy as any, gapMinutes);
    const slots = pickSlotsForSalesperson(cfg, sp.id, sp.calendarId, candidatesByDay, expanded, 2);
    if (slots.length >= 2) {
      const mapped = slots.map(s => ({
        ...s,
        startLocal: fmtLocal(s.start, cfg.timezone),
        endLocal: fmtLocal(s.end, cfg.timezone),
        appointmentType: "inventory_visit",
        salespersonId: sp.id,
        salespersonName: sp.name
      }));
      const msg = FOLLOW_UP_MESSAGES[0]
        .replace("{a}", mapped[0].startLocal)
        .replace("{b}", mapped[1].startLocal);
      return { message: msg, slots: mapped };
    }
  }
  return null;
}

type WeatherFollowUpWindow = {
  startDate: string;
  endDate: string;
  leadDaysPreferred: number;
};

type WeatherFollowUpPlan =
  | { kind: "window"; window: WeatherFollowUpWindow }
  | { kind: "open_weather_wait"; leadDaysPreferred: number };

function zonedDateParts(
  date: Date,
  timeZone: string
): { year: number; month: number; day: number; weekday: number } {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short"
  });
  const parts = fmt.formatToParts(date);
  const map: Record<string, string> = {};
  for (const p of parts) {
    if (p.type !== "literal") map[p.type] = p.value;
  }
  const weekdayRaw = String(map.weekday ?? "").toLowerCase().slice(0, 3);
  const weekdayMap: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    weekday: weekdayMap[weekdayRaw] ?? date.getUTCDay()
  };
}

function ymd(parts: { year: number; month: number; day: number }) {
  return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

function addDaysYmd(dateYmd: string, days: number) {
  const [y, m, d] = dateYmd.split("-").map(Number);
  const base = new Date(Date.UTC(y, m - 1, d));
  base.setUTCDate(base.getUTCDate() + days);
  return `${base.getUTCFullYear()}-${String(base.getUTCMonth() + 1).padStart(2, "0")}-${String(
    base.getUTCDate()
  ).padStart(2, "0")}`;
}

function extractWeatherFollowUpPlan(comment: string, now: Date, timeZone: string): WeatherFollowUpPlan | null {
  const t = String(comment ?? "").toLowerCase().trim();
  if (!t) return null;
  const hasTestRideCue = /\b(test ride|demo ride)\b/.test(t);
  const hasWeatherCue =
    /\b(weather|forecast|nice day|warmer|warm up|when it warms|when weather improves|weather looks better|better weather|once it warms)\b/.test(
      t
    );
  const hasTimingCue =
    /\b(next week|this week|this weekend|next weekend|end of next week|later next week|friday|saturday|sunday|monday|tuesday|wednesday|thursday|tomorrow|month|early|mid|late|between|week of|by|after|jan|january|feb|february|mar|march|apr|april|may|jun|june|jul|july|aug|august|sep|sept|september|oct|october|nov|november|dec|december)\b/.test(
      t
    );
  if (!hasWeatherCue || !hasTestRideCue) return null;

  let leadDaysPreferred = 2;
  if (/\b(one|1)\s+day\s+before\b/.test(t)) leadDaysPreferred = 1;
  if (/\b(two|2|couple)\s+days?\s+before\b/.test(t)) leadDaysPreferred = 2;
  if (/\ba day or two\b|\b1 or 2 days\b/.test(t)) leadDaysPreferred = 2;
  if (/\b(day before|night before)\b/.test(t)) leadDaysPreferred = 1;

  const todayParts = zonedDateParts(now, timeZone);
  const todayYmd = ymd(todayParts);
  const mondayOffset = todayParts.weekday === 0 ? -6 : 1 - todayParts.weekday;
  const mondayThisWeek = addDaysYmd(todayYmd, mondayOffset);
  const mondayNextWeek = addDaysYmd(mondayThisWeek, 7);
  const monthByName: Record<string, number> = {
    january: 1,
    jan: 1,
    february: 2,
    feb: 2,
    march: 3,
    mar: 3,
    april: 4,
    apr: 4,
    may: 5,
    june: 6,
    jun: 6,
    july: 7,
    jul: 7,
    august: 8,
    aug: 8,
    september: 9,
    sept: 9,
    sep: 9,
    october: 10,
    oct: 10,
    november: 11,
    nov: 11,
    december: 12,
    dec: 12
  };
  const weekdayIndexByName: Record<string, number> = {
    sunday: 0,
    sun: 0,
    monday: 1,
    mon: 1,
    tuesday: 2,
    tue: 2,
    tues: 2,
    wednesday: 3,
    wed: 3,
    thursday: 4,
    thu: 4,
    thur: 4,
    thurs: 4,
    friday: 5,
    fri: 5,
    saturday: 6,
    sat: 6
  };

  const monthStartEnd = (year: number, month: number) => {
    const start = `${year}-${String(month).padStart(2, "0")}-01`;
    const endDate = new Date(Date.UTC(year, month, 0));
    const end = `${year}-${String(month).padStart(2, "0")}-${String(endDate.getUTCDate()).padStart(2, "0")}`;
    return { start, end };
  };

  const parseMonthDay = (monthToken: string, dayRaw: string): string | null => {
    const month = monthByName[monthToken];
    if (!month) return null;
    const day = Number(dayRaw);
    if (!Number.isFinite(day) || day < 1 || day > 31) return null;
    let year = todayParts.year;
    const candidate = new Date(Date.UTC(year, month - 1, day));
    const todayDate = new Date(Date.UTC(todayParts.year, todayParts.month - 1, todayParts.day));
    if (candidate.getTime() < todayDate.getTime()) year += 1;
    return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  };

  const nextWeekdayFrom = (baseYmd: string, targetDow: number, includeToday = false) => {
    const [y, m, d] = baseYmd.split("-").map(Number);
    const base = new Date(Date.UTC(y, m - 1, d));
    const baseDow = base.getUTCDay();
    let delta = (targetDow - baseDow + 7) % 7;
    if (!includeToday && delta === 0) delta = 7;
    return addDaysYmd(baseYmd, delta);
  };

  const nthWeekOfMonthWindow = (year: number, month: number, nth: number) => {
    const first = `${year}-${String(month).padStart(2, "0")}-01`;
    const firstDow = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
    const mondayOffsetFromFirst = (8 - firstDow) % 7;
    const firstMonday = addDaysYmd(first, mondayOffsetFromFirst);
    const start = addDaysYmd(firstMonday, (Math.max(1, nth) - 1) * 7);
    return { startDate: start, endDate: addDaysYmd(start, 6), leadDaysPreferred };
  };

  const betweenMonthDays = t.match(
    /\bbetween\s+(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(\d{1,2})(?:st|nd|rd|th)?\s+(?:and|to|-)\s+(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(\d{1,2})(?:st|nd|rd|th)?\b/
  );
  if (betweenMonthDays) {
    const start = parseMonthDay(betweenMonthDays[1], betweenMonthDays[2]);
    const end = parseMonthDay(betweenMonthDays[3], betweenMonthDays[4]);
    if (start && end) {
      const window = start <= end
        ? { startDate: start, endDate: end, leadDaysPreferred }
        : { startDate: end, endDate: start, leadDaysPreferred };
      return { kind: "window", window };
    }
  }

  const betweenSameMonth = t.match(
    /\bbetween\s+(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(\d{1,2})(?:st|nd|rd|th)?\s+(?:and|to|-)\s+(\d{1,2})(?:st|nd|rd|th)?\b/
  );
  if (betweenSameMonth) {
    const start = parseMonthDay(betweenSameMonth[1], betweenSameMonth[2]);
    const end = parseMonthDay(betweenSameMonth[1], betweenSameMonth[3]);
    if (start && end) {
      const window = start <= end
        ? { startDate: start, endDate: end, leadDaysPreferred }
        : { startDate: end, endDate: start, leadDaysPreferred };
      return { kind: "window", window };
    }
  }

  const monthDayPoint = t.match(
    /\b(?:on|around|about|near|by|after)?\s*(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(\d{1,2})(?:st|nd|rd|th)?\b/
  );
  if (monthDayPoint) {
    const anchor = parseMonthDay(monthDayPoint[1], monthDayPoint[2]);
    if (anchor) {
      if (/\bafter\b/.test(t)) return { kind: "window", window: { startDate: anchor, endDate: addDaysYmd(anchor, 7), leadDaysPreferred } };
      if (/\bby\b/.test(t)) return { kind: "window", window: { startDate: addDaysYmd(anchor, -7), endDate: anchor, leadDaysPreferred } };
      return { kind: "window", window: { startDate: addDaysYmd(anchor, -2), endDate: addDaysYmd(anchor, 2), leadDaysPreferred } };
    }
  }

  const weekOfMonthDay = t.match(
    /\bweek of\s+(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(\d{1,2})(?:st|nd|rd|th)?\b/
  );
  if (weekOfMonthDay) {
    const anchor = parseMonthDay(weekOfMonthDay[1], weekOfMonthDay[2]);
    if (anchor) return { kind: "window", window: { startDate: anchor, endDate: addDaysYmd(anchor, 6), leadDaysPreferred } };
  }

  const ordinalWeekOfMonth = t.match(
    /\b(first|1st|second|2nd|third|3rd|fourth|4th)\s+week(?:\s+of)?\s+(?:this|next)?\s*(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?|month)\b/
  );
  if (ordinalWeekOfMonth) {
    const ordMap: Record<string, number> = { first: 1, "1st": 1, second: 2, "2nd": 2, third: 3, "3rd": 3, fourth: 4, "4th": 4 };
    const nth = ordMap[ordinalWeekOfMonth[1]] ?? 1;
    const mTok = ordinalWeekOfMonth[2];
    const month =
      mTok === "month"
        ? todayParts.month + (/\bnext month\b/.test(t) ? 1 : 0)
        : (monthByName[mTok] ?? todayParts.month);
    const normalizedMonth = month > 12 ? month - 12 : month;
    const year = month > 12 ? todayParts.year + 1 : todayParts.year;
    return { kind: "window", window: nthWeekOfMonthWindow(year, normalizedMonth, nth) };
  }

  const earlyMidLateMonth = t.match(/\b(early|mid|middle|late|end of)\s+(next month|this month|month)\b/);
  if (earlyMidLateMonth) {
    const phase = earlyMidLateMonth[1];
    const monthShift = /next month/.test(earlyMidLateMonth[2]) ? 1 : 0;
    const monthRaw = todayParts.month + monthShift;
    const month = monthRaw > 12 ? monthRaw - 12 : monthRaw;
    const year = monthRaw > 12 ? todayParts.year + 1 : todayParts.year;
    const { start, end } = monthStartEnd(year, month);
    if (phase === "early") return { kind: "window", window: { startDate: start, endDate: addDaysYmd(start, 9), leadDaysPreferred } };
    if (phase === "mid" || phase === "middle")
      return { kind: "window", window: { startDate: addDaysYmd(start, 10), endDate: addDaysYmd(start, 20), leadDaysPreferred } };
    if (phase === "late") return { kind: "window", window: { startDate: addDaysYmd(start, 21), endDate: end, leadDaysPreferred } };
    return { kind: "window", window: { startDate: addDaysYmd(start, 24), endDate: end, leadDaysPreferred } };
  }

  const explicitMonthWindow = t.match(
    /\b(?:in|during|for)\s+(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/
  );
  if (explicitMonthWindow) {
    const month = monthByName[explicitMonthWindow[1]];
    if (month) {
      let year = todayParts.year;
      if (month < todayParts.month) year += 1;
      const { start, end } = monthStartEnd(year, month);
      if (/\bearly\b/.test(t)) return { kind: "window", window: { startDate: start, endDate: addDaysYmd(start, 9), leadDaysPreferred } };
      if (/\b(mid|middle)\b/.test(t))
        return { kind: "window", window: { startDate: addDaysYmd(start, 10), endDate: addDaysYmd(start, 20), leadDaysPreferred } };
      if (/\blate|end of\b/.test(t)) return { kind: "window", window: { startDate: addDaysYmd(start, 21), endDate: end, leadDaysPreferred } };
      return { kind: "window", window: { startDate: start, endDate: end, leadDaysPreferred } };
    }
  }

  const weekdayMention = t.match(/\b(this|next)?\s*(monday|mon|tuesday|tue|tues|wednesday|wed|thursday|thu|thur|thurs|friday|fri|saturday|sat|sunday|sun)\b/);
  if (weekdayMention) {
    const targetDow = weekdayIndexByName[weekdayMention[2]];
    if (targetDow != null) {
      const base = /\bnext\b/.test(weekdayMention[1] ?? "") ? addDaysYmd(todayYmd, 7) : todayYmd;
      const day = nextWeekdayFrom(base, targetDow, /\bthis\b/.test(weekdayMention[1] ?? ""));
      return { kind: "window", window: { startDate: day, endDate: day, leadDaysPreferred } };
    }
  }

  if (/\b(end of next week|late next week|later next week)\b/.test(t)) {
    return { kind: "window", window: {
      startDate: addDaysYmd(mondayNextWeek, 3),
      endDate: addDaysYmd(mondayNextWeek, 6),
      leadDaysPreferred
    } };
  }
  if (/\bnext week\b/.test(t)) {
    return { kind: "window", window: {
      startDate: mondayNextWeek,
      endDate: addDaysYmd(mondayNextWeek, 6),
      leadDaysPreferred
    } };
  }
  if (/\bthis weekend\b/.test(t) || /\bnext weekend\b/.test(t)) {
    const saturdayOffset = (6 - todayParts.weekday + 7) % 7;
    if (/\bthis weekend\b/.test(t)) {
      const thisSat = addDaysYmd(todayYmd, saturdayOffset);
      return { kind: "window", window: {
        startDate: thisSat,
        endDate: addDaysYmd(thisSat, 1),
        leadDaysPreferred
      } };
    }
    const nextSat = addDaysYmd(todayYmd, saturdayOffset === 0 ? 7 : saturdayOffset);
    return { kind: "window", window: {
      startDate: nextSat,
      endDate: addDaysYmd(nextSat, 1),
      leadDaysPreferred
    } };
  }
  if (/\bend of this week\b/.test(t)) {
    return { kind: "window", window: {
      startDate: addDaysYmd(mondayThisWeek, 3),
      endDate: addDaysYmd(mondayThisWeek, 6),
      leadDaysPreferred
    } };
  }
  if (/\bthis week\b/.test(t)) {
    return { kind: "window", window: {
      startDate: todayYmd,
      endDate: addDaysYmd(mondayThisWeek, 6),
      leadDaysPreferred
    } };
  }
  if (/\btomorrow\b/.test(t)) {
    const tomorrow = addDaysYmd(todayYmd, 1);
    return { kind: "window", window: {
      startDate: tomorrow,
      endDate: tomorrow,
      leadDaysPreferred: 1
    } };
  }
  if (!hasTimingCue) {
    return { kind: "open_weather_wait", leadDaysPreferred };
  }
  return { kind: "open_weather_wait", leadDaysPreferred };
}

function pickBestForecastDateInWindow(
  forecasts: DailyForecast[],
  window: WeatherFollowUpWindow,
  coldThresholdF: number
): string | null {
  const inWindow = forecasts.filter(f => f.date >= window.startDate && f.date <= window.endDate);
  if (!inWindow.length) return null;

  const nice = inWindow
    .filter(f => !f.snow && Number(f.maxTempF ?? f.minTempF ?? Number.NEGATIVE_INFINITY) >= coldThresholdF)
    .sort((a, b) => Number(b.maxTempF ?? b.minTempF ?? -999) - Number(a.maxTempF ?? a.minTempF ?? -999));
  if (nice.length) return nice[0].date;

  const dry = inWindow
    .filter(f => !f.snow)
    .sort((a, b) => Number(b.maxTempF ?? b.minTempF ?? -999) - Number(a.maxTempF ?? a.minTempF ?? -999));
  if (dry.length) return dry[0].date;

  const warmest = [...inWindow].sort(
    (a, b) => Number(b.maxTempF ?? b.minTempF ?? -999) - Number(a.maxTempF ?? a.minTempF ?? -999)
  );
  return warmest[0]?.date ?? null;
}

function computeWeatherWindowFollowUpDueAt(
  targetDateYmd: string,
  leadDaysPreferred: number,
  now: Date,
  timeZone: string
): string | null {
  const todayYmd = ymd(zonedDateParts(now, timeZone));
  const twoDaysOut = addDaysYmd(targetDateYmd, -Math.max(1, leadDaysPreferred));
  const oneDayOut = addDaysYmd(targetDateYmd, -1);
  const outreachYmd = twoDaysOut > todayYmd ? twoDaysOut : oneDayOut > todayYmd ? oneDayOut : null;
  if (!outreachYmd) return null;
  const [year, month, day] = outreachYmd.split("-").map(Number);
  return localPartsToUtcDate(timeZone, { year, month, day, hour24: 10, minute: 45 }).toISOString();
}

function pickFirstNiceForecastDate(forecasts: DailyForecast[], coldThresholdF: number): string | null {
  const sorted = [...forecasts].sort((a, b) => a.date.localeCompare(b.date));
  const nice = sorted.find(
    f => !f.snow && Number(f.maxTempF ?? f.minTempF ?? Number.NEGATIVE_INFINITY) >= coldThresholdF
  );
  return nice?.date ?? null;
}

function computeWeatherRecheckDueAt(now: Date, timeZone: string, daysAhead = 7): string {
  const parts = zonedDateParts(now, timeZone);
  const today = ymd(parts);
  const target = addDaysYmd(today, Math.max(1, daysAhead));
  const [year, month, day] = target.split("-").map(Number);
  return localPartsToUtcDate(timeZone, { year, month, day, hour24: 10, minute: 45 }).toISOString();
}

function zonedDateTimeParts(
  date: Date,
  timeZone: string
): { year: number; month: number; day: number; hour: number; minute: number } | null {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  });
  const parts = fmt.formatToParts(date);
  const map: Record<string, string> = {};
  for (const p of parts) {
    if (p.type !== "literal") map[p.type] = p.value;
  }
  const year = Number(map.year);
  const month = Number(map.month);
  const day = Number(map.day);
  const hour = Number(map.hour);
  const minute = Number(map.minute);
  if (![year, month, day, hour, minute].every(v => Number.isFinite(v))) return null;
  return { year, month, day, hour, minute };
}

function clampCadenceToEarliestHour(
  dueAtIso: string,
  timeZone: string,
  earliestHour = 9
): { adjusted: boolean; dueAtIso: string } {
  const due = new Date(dueAtIso);
  if (Number.isNaN(due.getTime())) return { adjusted: false, dueAtIso };
  const local = zonedDateTimeParts(due, timeZone);
  if (!local) return { adjusted: false, dueAtIso };
  if (local.hour >= earliestHour) return { adjusted: false, dueAtIso };
  const clamped = localPartsToUtcDate(timeZone, {
    year: local.year,
    month: local.month,
    day: local.day,
    hour24: earliestHour,
    minute: 0
  }).toISOString();
  return { adjusted: true, dueAtIso: clamped };
}

async function processDueFollowUps() {
  const cfg = await getSchedulerConfigHot();
  if (cfg.enabled === false) return;
  const dealerProfile = await getDealerProfileHot();
  const users = await listUsers();
  const userById = new Map(users.map(u => [u.id, u]));
  const now = new Date();
  const convs = getAllConversations();
  const todoConvIds = new Set(
    listOpenTodos()
      .filter(t => t.reason !== "call")
      .map(t => t.convId)
  );
  const openQuestions = listOpenQuestions();
  const openCheckinByConv = new Set(
    openQuestions.filter(q => q.type === "cadence_checkin").map(q => q.convId)
  );
  const canTestRideNow = async (conv: any) => {
    return canOfferTestRideForLead(conv?.lead, dealerProfile);
  };
  const resolvePostSaleSender = (conv: any) => {
    const agentName = dealerProfile?.agentName ?? "our team";
    const soldById = conv?.sale?.soldById;
    if (!soldById) return agentName;
    const user = userById.get(soldById);
    if (!user) return agentName;
    const first =
      String(user.firstName ?? "").trim() ||
      String(user.name ?? "").trim().split(/\s+/).filter(Boolean)[0] ||
      "";
    return first || user.name || user.email || agentName;
  };
  const normalizeModelForPostSale = (model: string) => {
    return normalizeDisplayCase(model);
  };
  const getPostSaleModel = (conv: any) => {
    const raw = conv?.lead?.vehicle?.model ?? "";
    const normalized = normalizeModelForPostSale(String(raw));
    return normalized || "bike";
  };

  const getLastInbound = (conv: any) =>
    [...(conv.messages ?? [])].reverse().find((m: any) => m.direction === "in") ?? null;

  const isMeaningfulInbound = (text: string) => {
    const t = text.toLowerCase();
    return (
      /(call me|call him|call her|reach me|reach him|reach her|contact me|can you call|please call|tell .* i will call|i will call)/.test(
        t
      ) ||
      /(appointment|appt|schedule|book|come in|stop in|stop by|visit|test ride|demo ride)/.test(t) ||
      /(price|otd|out the door|payment|monthly|finance|credit|apr|trade|trade-in|trade in)/.test(t) ||
      /(next week|next month|this weekend|today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|\bmon\b|\btue\b|\bwed\b|\bthu\b|\bfri\b|\bsat\b|\bsun\b)/.test(
        t
      ) ||
      /\b\d{1,2}(:\d{2})?\s*(am|pm)?\b/.test(t)
    );
  };

  const parsePauseUntil = (text: string, base: Date): { until?: Date; indefinite?: boolean } => {
    const t = text.toLowerCase();
    if (
      /((i|we)('| )?ll let you know|(i|we) will let you know|(i|we)('| )?ll reach out|(i|we) will reach out|(i|we)('| )?ll get back to you|(i|we) will get back to you)/.test(
        t
      )
    ) {
      return { indefinite: true };
    }

    const relative = parseRelativeDaysOrWeeks(t);
    if (relative) {
      const days = relative.unit === "weeks" ? relative.count * 7 : relative.count;
      return { until: new Date(base.getTime() + days * 24 * 60 * 60 * 1000) };
    }

    if (/\bnext week\b/.test(t)) {
      return { until: new Date(base.getTime() + 7 * 24 * 60 * 60 * 1000) };
    }
    if (/\bnext month\b/.test(t)) {
      return { until: new Date(base.getTime() + 30 * 24 * 60 * 60 * 1000) };
    }

    const monthMap: Record<string, number> = {
      jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2, apr: 3, april: 3,
      may: 4, jun: 5, june: 5, jul: 6, july: 6, aug: 7, august: 7, sep: 8, sept: 8, september: 8,
      oct: 9, october: 9, nov: 10, november: 10, dec: 11, december: 11
    };
    const monthMatch = t.match(/\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)(?:\s+(\d{1,2}))?\b/);
    if (monthMatch) {
      const m = monthMap[monthMatch[1]];
      const day = monthMatch[2] ? Number(monthMatch[2]) : 1;
      const y = base.getFullYear();
      let d = new Date(y, m, day, 9, 0, 0, 0);
      if (d.getTime() <= base.getTime()) d = new Date(y + 1, m, day, 9, 0, 0, 0);
      return { until: d };
    }

    const dowMap: Record<string, number> = {
      sunday: 0, sun: 0, monday: 1, mon: 1, tuesday: 2, tue: 2, tues: 2, wednesday: 3, wed: 3,
      thursday: 4, thu: 4, thurs: 4, friday: 5, fri: 5, saturday: 6, sat: 6
    };
    const dowMatch = t.match(/\b(sun(day)?|mon(day)?|tue(sday)?|wed(nesday)?|thu(rsday)?|fri(day)?|sat(urday)?)\b/);
    if (dowMatch) {
      const key = dowMatch[0].replace(/\s+/g, "");
      const dow = dowMap[key] ?? dowMap[key.slice(0,3)];
      if (dow != null) {
        const d = new Date(base);
        d.setDate(d.getDate() + ((7 + dow - d.getDay()) % 7 || 7));
        d.setHours(9, 0, 0, 0);
        return { until: d };
      }
    }

    if (/\bthis weekend\b/.test(t)) {
      const d = new Date(base);
      const daysToSat = (6 - d.getDay() + 7) % 7;
      d.setDate(d.getDate() + (daysToSat === 0 ? 7 : daysToSat));
      d.setHours(9, 0, 0, 0);
      return { until: d };
    }

    return {};
  };

  const getLastOutbound = (conv: any, providers: string[]) => {
    const list = conv.messages?.filter((m: any) => m.direction === "out" && providers.includes(m.provider)) ?? [];
    return list.sort((a: any, b: any) => new Date(a.at).getTime() - new Date(b.at).getTime()).slice(-1)[0];
  };
  const bumpCadenceNextDueAt = (conv: any, nextAt: Date) => {
    if (!conv.followUpCadence || conv.followUpCadence.status !== "active") return;
    if (!nextAt || Number.isNaN(nextAt.getTime())) return;
    const current = conv.followUpCadence.nextDueAt ? new Date(conv.followUpCadence.nextDueAt) : null;
    if (!current || current.getTime() < nextAt.getTime()) {
      conv.followUpCadence.nextDueAt = nextAt.toISOString();
    }
  };

  for (const conv of convs) {
    let cadence = conv.followUpCadence;
    const soldLead = conv.closedReason === "sold" || !!conv.sale?.soldAt;
    if (
      soldLead &&
      (!cadence || cadence.kind !== "post_sale" || (cadence.status === "stopped" && cadence.stopReason === "appointment_booked"))
    ) {
      const anchor = conv.sale?.soldAt ?? conv.closedAt ?? cadence?.anchorAt ?? nowIso();
      conv.followUpCadence = {
        status: "active",
        anchorAt: anchor,
        nextDueAt: computePostSaleDueAt(anchor, POST_SALE_DAY_OFFSETS[0], cfg.timezone),
        stepIndex: 0,
        kind: "post_sale",
        scheduleInviteCount: 0,
        scheduleMuted: false
      };
      conv.updatedAt = nowIso();
      saveConversation(conv);
      cadence = conv.followUpCadence;
    }
    if (
      cadence?.kind === "post_sale" &&
      cadence.status === "stopped" &&
      cadence.stopReason === "appointment_booked" &&
      (conv.closedReason === "sold" || conv.sale?.soldAt)
    ) {
      const anchor = conv.sale?.soldAt ?? cadence.anchorAt ?? nowIso();
      conv.followUpCadence = {
        status: "active",
        anchorAt: anchor,
        nextDueAt: computePostSaleDueAt(anchor, POST_SALE_DAY_OFFSETS[0], cfg.timezone),
        stepIndex: 0,
        kind: "post_sale"
      };
      conv.updatedAt = nowIso();
      saveConversation(conv);
      cadence = conv.followUpCadence;
    }
    if (!cadence || cadence.status !== "active" || !cadence.nextDueAt) continue;
    const isPostSale = cadence.kind === "post_sale";
    if (isPostSale) {
      const current = new Date(cadence.nextDueAt);
      // Post-sale cadence should send when due. Only recompute if nextDueAt is invalid.
      // Recomputing when already due pushes the send into the future and skips delivery.
      if (Number.isNaN(current.getTime())) {
        const step = Math.min(cadence.stepIndex ?? 0, POST_SALE_DAY_OFFSETS.length - 1);
        cadence.nextDueAt = computePostSaleDueAt(cadence.anchorAt ?? nowIso(), POST_SALE_DAY_OFFSETS[step], cfg.timezone);
        saveConversation(conv);
      }
    }
    if (isPostSale && conv.closedReason !== "sold" && !conv.sale?.soldAt) {
      stopFollowUpCadence(conv, "invalid_post_sale");
      continue;
    }
    if (conv.contactPreference === "call_only") {
      stopFollowUpCadence(conv, "call_only");
      continue;
    }
    if (conv.status === "closed" && !isPostSale) {
      stopFollowUpCadence(conv, "closed");
      continue;
    }
    // Post-sale cadence should not be blocked by legacy open sales todos.
    if (!isPostSale && todoConvIds.has(conv.id)) continue;
    let blockUntilMs: number | null = null;
    const setBlockUntil = (d?: Date | null) => {
      if (!d || Number.isNaN(d.getTime())) return;
      const ms = d.getTime();
      if (blockUntilMs == null || ms > blockUntilMs) blockUntilMs = ms;
    };
    if (cadence.pausedUntil) {
      const resumeAt = new Date(cadence.pausedUntil);
      if (now < resumeAt) {
        setBlockUntil(resumeAt);
      } else {
        cadence.pausedUntil = undefined;
        cadence.pauseReason = undefined;
      }
    }
    if (isSuppressed(conv.leadKey)) {
      stopFollowUpCadence(conv, "suppressed");
      continue;
    }
    if (!isPostSale) {
      const lastInbound = getLastInbound(conv);
      if (lastInbound?.body && lastInbound?.at) {
        const inboundAt = new Date(lastInbound.at);
        if (!Number.isNaN(inboundAt.getTime())) {
          const msSinceInbound = now.getTime() - inboundAt.getTime();
          // Guard against cadence/inbound race conditions: if a customer message
          // just arrived, do not fire a scheduled follow-up in that same window.
          if (msSinceInbound >= 0 && msSinceInbound < 15 * 60 * 1000) {
            setBlockUntil(new Date(inboundAt.getTime() + 15 * 60 * 1000));
          }
        }
        const { until, indefinite } = parsePauseUntil(lastInbound.body, inboundAt);
        if (indefinite) continue;
        if (until && now < until) setBlockUntil(until);
      }
      const lastDraft = getLastOutbound(conv, ["draft_ai"]);
      const lastSent = getLastOutbound(conv, ["twilio", "human", "sendgrid"]);
      if (lastDraft?.at) {
        const draftAt = new Date(lastDraft.at);
        const draftMs = draftAt.getTime();
        const sentMs = lastSent?.at ? new Date(lastSent.at).getTime() : null;
        const inboundMs = lastInbound?.at ? new Date(lastInbound.at).getTime() : null;
        const unsentDraft =
          Number.isFinite(draftMs) &&
          (sentMs == null || !Number.isFinite(sentMs) || draftMs > sentMs);
        const noInboundAfterDraft =
          inboundMs == null || !Number.isFinite(inboundMs) || inboundMs <= draftMs;
        if (unsentDraft && noInboundAfterDraft) {
          setBlockUntil(new Date(Date.now() + 24 * 60 * 60 * 1000));
        }
      }
      if (lastDraft?.at) {
        const draftAt = new Date(lastDraft.at);
        // Avoid stacking multiple follow-up drafts within a day.
        if (now.getTime() - draftAt.getTime() < 24 * 60 * 60 * 1000) {
          setBlockUntil(new Date(draftAt.getTime() + 24 * 60 * 60 * 1000));
        }
      }
      if (blockUntilMs != null && blockUntilMs > now.getTime()) {
        bumpCadenceNextDueAt(conv, new Date(blockUntilMs));
        continue;
      }
    }
    if (!isPostSale && cadence.stepIndex === 0 && !conv.lead?.walkInCommentUsedAt) {
      const walkInComment = String(conv.lead?.walkInComment ?? "").trim();
      const weatherPlan = extractWeatherFollowUpPlan(walkInComment, now, cfg.timezone);
      if (weatherPlan) {
        let weatherDeferred = false;
        const dailyForecasts = await getDealerDailyForecasts(dealerProfile);
        const weatherCfg = getWeatherConfig(dealerProfile);
        const coldThresholdF = Number(weatherCfg.coldThresholdF ?? 50);
        if (dailyForecasts?.length) {
          if (weatherPlan.kind === "window") {
            const targetDate = pickBestForecastDateInWindow(dailyForecasts, weatherPlan.window, coldThresholdF);
            if (targetDate) {
              const dueAt = computeWeatherWindowFollowUpDueAt(
                targetDate,
                weatherPlan.window.leadDaysPreferred,
                now,
                cfg.timezone
              );
              if (dueAt) {
                const dueAtDate = new Date(dueAt);
                if (!Number.isNaN(dueAtDate.getTime()) && dueAtDate.getTime() > now.getTime() + 5 * 60 * 1000) {
                  cadence.nextDueAt = dueAt;
                  weatherDeferred = true;
                }
              }
            } else {
              cadence.nextDueAt = computeWeatherRecheckDueAt(now, cfg.timezone, 7);
              weatherDeferred = true;
            }
          } else {
            const targetDate = pickFirstNiceForecastDate(dailyForecasts, coldThresholdF);
            if (targetDate) {
              const dueAt = computeWeatherWindowFollowUpDueAt(
                targetDate,
                weatherPlan.leadDaysPreferred,
                now,
                cfg.timezone
              );
              if (dueAt) {
                const dueAtDate = new Date(dueAt);
                if (!Number.isNaN(dueAtDate.getTime()) && dueAtDate.getTime() > now.getTime() + 5 * 60 * 1000) {
                  cadence.nextDueAt = dueAt;
                  weatherDeferred = true;
                }
              }
            } else {
              cadence.nextDueAt = computeWeatherRecheckDueAt(now, cfg.timezone, 7);
              weatherDeferred = true;
            }
          }
        }
        if (weatherDeferred) continue;
      }
    }
    const clamped = clampCadenceToEarliestHour(cadence.nextDueAt, cfg.timezone, 9);
    if (clamped.adjusted) {
      cadence.nextDueAt = clamped.dueAtIso;
      conv.updatedAt = nowIso();
      saveConversation(conv);
    }
    if (new Date(cadence.nextDueAt) > now) continue;
    if (conv.appointment?.bookedEventId) {
      onAppointmentBooked(conv);
      continue;
    }
    if (!isPostSale && conv.followUp?.mode === "holding_inventory") continue;
    if (!isPostSale && conv.followUp?.mode === "manual_handoff") continue;
    if (!isPostSale) {
      if (conv.followUp?.skipNextCheckin) {
        conv.followUp.skipNextCheckin = false;
        conv.followUp.updatedAt = nowIso();
      } else if (conv.appointment?.whenIso) {
        if (!openCheckinByConv.has(conv.id)) {
          const text = "Follow-up scheduled — did the customer come in?";
          addInternalQuestion(conv.id, conv.leadKey, text, "cadence_checkin");
          openCheckinByConv.add(conv.id);
        }
        const pauseUntil = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();
        pauseFollowUpCadence(conv, pauseUntil, "cadence_checkin");
        continue;
      }
    }

    const canTestRideFlag = await canTestRideNow(conv);
    const isTradeNoInterest =
      conv?.classification?.bucket === "trade_in_sell" &&
      isUnknownInterestVehicle(conv) &&
      isTradeAcceleratorLead(conv);
    const isSellMyBikeLead = isSellLead(conv);
    const sellBikeLabel = isSellMyBikeLead ? getSellBikeLabel(conv) : null;
    const dealerName = dealerProfile?.dealerName ?? "American Harley-Davidson";
    const agentName = dealerProfile?.agentName ?? "our team";
    const firstName = normalizeDisplayCase(conv.lead?.firstName) || "there";
    const followUpLabel = formatModelLabelForFollowUp(
      conv.lead?.vehicle?.year ?? null,
      conv.lead?.vehicle?.model ?? null
    );
    const labelClause = followUpLabel ? ` about ${followUpLabel}` : "";
    const labelWithThe = followUpLabel ? ` ${followUpLabel}` : " the bike";
    const tradeVehicle = conv?.lead?.tradeVehicle ?? null;
    const tradeLabel =
      tradeVehicle && (tradeVehicle.model || tradeVehicle.description)
        ? getSellBikeLabel(conv)
        : "";
    const modelName = formatModelToken(conv.lead?.vehicle?.model);
    const modelYear = conv.lead?.vehicle?.year
      ? `${conv.lead?.vehicle?.year} ${modelName}`
      : modelName;
    const tradeName = normalizeDisplayCase(tradeVehicle?.model) || tradeLabel || "your trade";
    const pricingLine =
      getPricingAttempts(conv) > 0 ? " If you want me to run numbers, just say the word." : "";
    const tradeLine = tradeLabel ? ` If you want to go over the trade on ${tradeLabel}, just let me know.` : "";
    const paymentLine =
      getDialogState(conv) === "payments_answered"
        ? " If you want a more exact payment, I can run a quick credit app or set a time to go over numbers."
        : "";
    const extraLine = paymentLine || pricingLine || tradeLine;
    const baseCtx = {
      name: firstName,
      agent: agentName,
      labelClause,
      label: labelWithThe,
      extraLine,
      model: modelName,
      modelYear,
      trade: tradeName
    };
    const walkInComment = String(conv.lead?.walkInComment ?? "").trim();
    const walkInCommentLabel = labelWithThe.trim() || "the bike";
    const canUseWalkInComment =
      !isPostSale &&
      cadence.stepIndex === 0 &&
      !conv.lead?.walkInCommentUsedAt &&
      !!walkInComment &&
      cadence.kind !== "long_term" &&
      !isTradeNoInterest &&
      !isSellMyBikeLead;
    if (!isPostSale && !isTradeNoInterest && !isSellMyBikeLead && conv.engagement?.at && cadence.kind !== "engaged") {
      cadence.kind = "engaged";
    }
    const isEngagedCadence = cadence.kind === "engaged";
    const contextTag = isEngagedCadence
      ? await resolveCadenceContextTag(conv, cadence)
      : null;
    const engagedNoSlotMap =
      (contextTag && ENGAGED_FOLLOW_UP_VARIANTS_NO_SLOTS[contextTag]) ||
      ENGAGED_FOLLOW_UP_VARIANTS_NO_SLOTS.general;
    const engagedWithSlot =
      (contextTag && ENGAGED_FOLLOW_UP_VARIANTS_WITH_SLOTS[contextTag]) ||
      ENGAGED_FOLLOW_UP_VARIANTS_WITH_SLOTS.general;
    let message = FOLLOW_UP_MESSAGES[cadence.stepIndex] ?? FOLLOW_UP_MESSAGES[FOLLOW_UP_MESSAGES.length - 1];
    let cadenceNoRepeatFallbacks: string[] = [];
    let mediaUrls: string[] | undefined;
    if (isPostSale) {
      const repName = resolvePostSaleSender(conv);
      const firstName = normalizeDisplayCase(conv.lead?.firstName) || "there";
      const bikeModel = getPostSaleModel(conv);
      const smsTemplates = [
        `Hi ${firstName} — this is ${repName} at ${dealerName}. Thanks again for coming to see us for your ${bikeModel}. If you need anything, just let me know.`,
        `Hi ${firstName} — ${repName} at ${dealerName}. Quick reminder about Custom Coverage. Any Harley-Davidson accessory we install will go under your full factory warranty on the bike. If you have questions, just let me know.`,
        `Hi ${firstName} — ${repName} at ${dealerName}. Happy 1-year anniversary with your ${bikeModel}. If you’re ever thinking about trading in, let me know.`,
        `Hi ${firstName} — ${repName} at ${dealerName}. Just checking in. How are you liking your ${bikeModel}? If you’re ever thinking about trading in, let me know.`
      ];
      message = smsTemplates[Math.min(cadence.stepIndex, smsTemplates.length - 1)];
    } else if (cadence.kind === "long_term") {
      const longTerm = await buildLongTermFollowUp(conv, dealerProfile);
      message = longTerm.body;
      mediaUrls = longTerm.mediaUrls;
    } else if (isTradeNoInterest) {
      const day2 = cadence.stepIndex === 0 ? await buildDay2Options(cfg) : null;
      if (day2) {
        message = `Just checking in on your trade‑in estimate. What model are you interested in? I can set up a trade appraisal. I have ${day2.slots[0].startLocal} or ${day2.slots[1].startLocal} — do any of these times work?`;
        setLastSuggestedSlots(conv, day2.slots);
      } else {
        message =
          "Just checking in on your trade‑in estimate. What model are you interested in? I can set up a trade appraisal. What day and time works for you?";
      }
      cadenceNoRepeatFallbacks = [
        "Quick follow-up on your trade estimate — if you want, I can line up a quick appraisal time.",
        "No rush on your trade estimate — if you'd like, I can help you set a quick appraisal.",
        "If timing changed, that's fine — I can still help with your trade estimate whenever you're ready."
      ];
    } else if (isSellMyBikeLead) {
      const weatherStatus = await getDealerWeatherStatus(dealerProfile);
      let pickupEligible = conv.pickup?.eligible === true;
      let pickupKnown = !!conv.pickup?.town;
      if (!pickupKnown) {
        const inferredTown = inferPickupTownFromHistory(conv);
        if (inferredTown) {
          const coords = await resolveDealerLatLon(dealerProfile);
          const cfg = getWeatherConfig(dealerProfile);
          let townLabel = inferredTown;
          let eligible: boolean | undefined;
          let distance: number | undefined;
          if (coords) {
            const match = await resolveTownNearestDealer(inferredTown, coords.lat, coords.lon);
            if (match) {
              distance = Math.round(match.distanceMiles * 10) / 10;
              eligible = distance <= Number(cfg.pickupRadiusMiles ?? 25);
              townLabel = formatTownLabel(match.name, match.state);
            }
          }
          conv.pickup = {
            ...(conv.pickup ?? {}),
            town: townLabel,
            distanceMiles: distance,
            eligible,
            updatedAt: nowIso()
          };
          pickupKnown = true;
          pickupEligible = eligible === true;
        }
      }
      const template = SELL_FOLLOW_UP_MESSAGES[Math.min(cadence.stepIndex, SELL_FOLLOW_UP_MESSAGES.length - 1)];
      if (weatherStatus?.bad) {
        if (!pickupKnown) {
          const pickupNeedTown = [
            `Just checking in — if you want us to pick up ${sellBikeLabel ?? "your bike"} for a trade evaluation, let me know where you’re located.`,
            `Quick follow-up — if pickup is easier, send me your town and I can see if we can arrange a pickup for ${sellBikeLabel ?? "your bike"}.`,
            `Whenever you're ready, share your location and I can confirm pickup options for ${sellBikeLabel ?? "your bike"}.`
          ];
          message = pickVariantNoRepeat(
            cadence,
            pickupNeedTown,
            `${conv.leadKey}|sell|pickup_need_town`,
            "sell:pickup:need_town"
          );
          cadenceNoRepeatFallbacks = pickupNeedTown;
          conv.pickup = { ...(conv.pickup ?? {}), stage: "need_town", updatedAt: nowIso() };
        } else if (pickupEligible) {
          const pickupWeather = [
            `Just checking in — if the weather’s rough, we can pick up ${sellBikeLabel ?? "your bike"} for a trade evaluation. If you’d rather stop in, what day and time works for you?`,
            `If weather is getting in the way, we can pick up ${sellBikeLabel ?? "your bike"} for appraisal. If not, I can still set a quick in-person time.`,
            `If it's easier with the weather, we can do pickup for ${sellBikeLabel ?? "your bike"} and keep it simple.`
          ];
          message = pickVariantNoRepeat(
            cadence,
            pickupWeather,
            `${conv.leadKey}|sell|pickup_weather`,
            "sell:pickup:weather"
          );
          cadenceNoRepeatFallbacks = pickupWeather;
        } else {
          const inPersonWeather = [
            `Just checking in — if you'd like a quick in-person appraisal on ${sellBikeLabel ?? "your bike"}, what day and time works for you?`,
            `Quick follow-up — if you want to move ahead on ${sellBikeLabel ?? "your bike"}, I can line up a quick in-person appraisal time.`,
            `No rush — whenever you're ready, I can set a quick in-person appraisal for ${sellBikeLabel ?? "your bike"}.`
          ];
          message = pickVariantNoRepeat(
            cadence,
            inPersonWeather,
            `${conv.leadKey}|sell|in_person_weather`,
            "sell:in_person:weather"
          );
          cadenceNoRepeatFallbacks = inPersonWeather;
        }
      } else if (cadence.stepIndex === 0) {
        const day2 = await buildDay2Options(cfg);
        if (day2) {
          message = renderFollowUpTemplate(
            pickVariantNoRepeat(
              cadence,
              SELL_FOLLOW_UP_VARIANTS_WITH_SLOTS,
              `${conv.leadKey}|sell|${cadence.stepIndex}`,
              `sell:${cadence.stepIndex}:slots`
            ),
            {
              name: firstName,
              agent: agentName,
              bike: sellBikeLabel ?? "your bike",
              a: day2.slots[0].startLocal,
              b: day2.slots[1].startLocal
            }
          );
          setLastSuggestedSlots(conv, day2.slots);
        } else {
          message = `Just checking in — if you'd like a quick in‑person appraisal on ${
            sellBikeLabel ?? "your bike"
          }, what day and time works for you?`;
        }
      } else {
        message = template.replace("{bike}", sellBikeLabel ?? "your bike");
      }
      if (!cadenceNoRepeatFallbacks.length) {
        cadenceNoRepeatFallbacks = [
          `Quick follow-up on ${sellBikeLabel ?? "your bike"} — I can line up a quick appraisal whenever you're ready.`,
          `No pressure on ${sellBikeLabel ?? "your bike"} — if you want to move forward, I can set a time that works for you.`,
          `If timing changed on ${sellBikeLabel ?? "your bike"}, just tell me what day works and I can help.`
        ];
      }
    } else if (cadence.stepIndex === 0) {
      const day2 = await buildDay2Options(cfg);
      if (day2) {
        const variant = isEngagedCadence
          ? pickVariantNoRepeat(
              cadence,
              engagedWithSlot,
              `${conv.leadKey}|engaged|${cadence.stepIndex}`,
              `engaged:${contextTag ?? "general"}:${cadence.stepIndex}:slots`
            )
          : pickVariantNoRepeat(
              cadence,
              FOLLOW_UP_VARIANTS_WITH_SLOTS,
              `${conv.leadKey}|${cadence.stepIndex}`,
              `standard:${cadence.stepIndex}:slots`
            );
        message = renderFollowUpTemplate(variant, {
          ...baseCtx,
          a: day2.slots[0].startLocal,
          b: day2.slots[1].startLocal
        });
        setLastSuggestedSlots(conv, day2.slots);
      } else {
        const variants = isEngagedCadence
          ? engagedNoSlotMap[cadence.stepIndex] ?? []
          : FOLLOW_UP_VARIANTS_NO_SLOTS[cadence.stepIndex] ?? [];
        message = variants.length
          ? renderFollowUpTemplate(
              pickVariantNoRepeat(
                cadence,
                variants,
                `${conv.leadKey}|${isEngagedCadence ? "engaged" : "standard"}|${cadence.stepIndex}`,
                `${isEngagedCadence ? `engaged:${contextTag ?? "general"}` : "standard"}:${cadence.stepIndex}:noslots`
              ),
              baseCtx
            )
          : FOLLOW_UP_MESSAGES[1];
      }
    } else if (cadence.stepIndex === 2) {
      if (canTestRideFlag) {
        message = "If you want to set up a test ride, I can hold a time. What day and time works for you?";
      } else {
        const variants = isEngagedCadence
          ? engagedNoSlotMap[cadence.stepIndex] ?? []
          : FOLLOW_UP_VARIANTS_NO_SLOTS[cadence.stepIndex] ?? [];
        message = variants.length
          ? renderFollowUpTemplate(
              pickVariantNoRepeat(
                cadence,
                variants,
                `${conv.leadKey}|${isEngagedCadence ? "engaged" : "standard"}|${cadence.stepIndex}`,
                `${isEngagedCadence ? `engaged:${contextTag ?? "general"}` : "standard"}:${cadence.stepIndex}:noslots`
              ),
              baseCtx
            )
          : FOLLOW_UP_MESSAGES[2];
      }
    } else if (
      FOLLOW_UP_VARIANTS_NO_SLOTS[cadence.stepIndex] ||
      (isEngagedCadence && engagedNoSlotMap[cadence.stepIndex])
    ) {
      const variants = isEngagedCadence
        ? engagedNoSlotMap[cadence.stepIndex] ?? []
        : FOLLOW_UP_VARIANTS_NO_SLOTS[cadence.stepIndex] ?? [];
      message = variants.length
        ? renderFollowUpTemplate(
            pickVariantNoRepeat(
              cadence,
              variants,
              `${conv.leadKey}|${isEngagedCadence ? "engaged" : "standard"}|${cadence.stepIndex}`,
              `${isEngagedCadence ? `engaged:${contextTag ?? "general"}` : "standard"}:${cadence.stepIndex}:noslots`
            ),
            baseCtx
          )
        : message;
    } else if (cadence.stepIndex >= 10) {
      const late = await buildLateFollowUp(conv, cadence.stepIndex, dealerProfile);
      message = late.body;
      mediaUrls = late.mediaUrls;
    }
    if (canUseWalkInComment) {
      message = buildWalkInCommentFollowUp({
        name: firstName,
        agent: agentName,
        dealerName,
        comment: walkInComment,
        label: walkInCommentLabel
      });
      const commentUsedAt = nowIso();
      conv.lead = conv.lead ?? {};
      conv.lead.walkInCommentUsedAt = commentUsedAt;
      conv.updatedAt = commentUsedAt;
      saveConversation(conv);
    }
    if (
      !isPostSale &&
      cadence.kind !== "long_term" &&
      !isTradeNoInterest &&
      !isSellMyBikeLead &&
      message.includes("{")
    ) {
      message = renderFollowUpTemplate(message, baseCtx);
    }

    const allowProactiveSchedule = shouldAllowProactiveScheduleAsk(conv, now);
    if (conv.followUpCadence?.scheduleMuted) {
      const baseCtx = {
        name: firstName,
        agent: agentName,
        labelClause,
        model: modelName,
        extraLine,
        trade: tradeName,
        modelYear,
        label: labelWithThe
      };
      const pool = (conv.followUpCadence.scheduleInviteCount ?? 0) < SCHEDULE_INVITE_THRESHOLD
        ? FRESH_INFO_FOLLOW_UPS
        : SOFT_EXIT_FOLLOW_UPS;
      const messageIdx = (conv.followUpCadence.scheduleInviteCount ?? 0) % pool.length;
      message = renderFollowUpTemplate(pool[messageIdx], baseCtx);
    } else {
      if (conv.scheduleSoft && !allowProactiveSchedule) {
        message = stripSchedulingPromptFromFollowUp(message);
      }
      if (allowProactiveSchedule && conv.scheduleSoft && draftHasSchedulingPrompt(message)) {
        conv.scheduleSoft.lastAskAt = nowIso();
      }
      if (draftHasSchedulingPrompt(message)) {
        registerScheduleInviteSent(conv);
      }
    }

    if (!isPostSale && cadence.kind !== "long_term") {
      const contextLine = getFollowUpContextLine(conv, now);
      if (contextLine && !message.toLowerCase().includes(contextLine.toLowerCase())) {
        message = `${message} ${contextLine}`.trim();
        if (conv.appointment) {
          conv.appointment.staffNotify = conv.appointment.staffNotify ?? {};
          conv.appointment.staffNotify.contextUsedAt = nowIso();
        }
      }
    }
    const genericCadenceNoRepeatFallbacks = isPostSale
      ? [
          "Quick follow-up — if you need anything, just let me know.",
          "Checking in again — I'm here anytime you need help.",
          "No rush — if anything comes up, just reach out."
        ]
      : [
          "Quick follow-up — I'm here if you want to revisit this.",
          "No rush — whenever you're ready, I can help with next steps.",
          "If timing changed, just let me know and I can adjust."
        ];
    message = selectNonRepeatingCadenceMessage(
      conv,
      message,
      cadenceNoRepeatFallbacks.length ? cadenceNoRepeatFallbacks : genericCadenceNoRepeatFallbacks
    );

    const emailTo = conv.lead?.email;
    const useEmail =
      !isPostSale && conv.classification?.channel === "email" && !!emailTo && hasEmailOptIn(conv.lead);
    const systemMode = effectiveMode(conv);
    const { from: emailFrom, replyTo: emailReplyTo, signature } = getEmailConfig(dealerProfile);
    const replyTo = maybeTagReplyTo(emailReplyTo, conv);
    const bookingUrl = buildBookingUrlForLead(dealerProfile?.bookingUrl, conv);
    const name = conv.lead?.firstName?.trim() || "there";
    const year = conv.lead?.vehicle?.year ?? null;
    const model = conv.lead?.vehicle?.model ?? null;
    const label = model ? `the ${formatModelLabel(year, model)}` : "your inquiry";
    const bookingLine = conv.scheduleSoft && !allowProactiveSchedule
      ? "If you need anything, just let me know."
      : bookingUrl
        ? `You can book an appointment here: ${bookingUrl}`
        : "If you want to stop in, reply with a day and time that works.";
    let emailMessage: string | null = null;
    if (useEmail) {
      if (cadence.kind === "long_term") {
        const longTermBody = String(message ?? "")
          .replace(/^\s*hi\s+[^—\n-]+[—-]\s*/i, "")
          .trim();
        emailMessage = `Hi ${name},\n\n${longTermBody || message}\n\n${bookingLine}\n\nThanks,`;
      } else if (isTradeNoInterest) {
        const tradeBookingLine = bookingUrl
          ? `You can book an appointment here: ${bookingUrl}`
          : "If you'd like a trade appraisal, just reply with a day and time that works.";
        emailMessage =
          `Hi ${name},\n\nJust checking in on your trade‑in estimate. ` +
          `If you’d like a trade appraisal, I can set a time. Also, which model are you interested in? ` +
          `${tradeBookingLine}\n\nThanks,`;
      } else if (isSellMyBikeLead) {
        const tradeBookingLine = bookingUrl
          ? `You can book an appointment here: ${bookingUrl}`
          : "If you'd like a trade appraisal, just reply with a day and time that works.";
        emailMessage =
          `Hi ${name},\n\nJust checking in — if you'd like a quick in‑person appraisal on ` +
          `${sellBikeLabel ?? "your bike"}, I can set a time. ${tradeBookingLine}\n\nThanks,`;
      } else {
        const idx = Math.min(cadence.stepIndex, EMAIL_FOLLOW_UP_MESSAGES.length - 1);
        emailMessage = EMAIL_FOLLOW_UP_MESSAGES[idx]({
          name,
          label,
          bookingLine,
          dealerName: dealerProfile?.dealerName ?? "American Harley-Davidson",
          canTestRide: canTestRideFlag
        });
      }
    }
    const to = normalizePhone(conv.leadKey);
    const from = process.env.TWILIO_FROM_NUMBER;
    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken = process.env.TWILIO_AUTH_TOKEN;

    const maybeAddCallTodoForFollowUp = () => {
      if (isPostSale) return;
      addCallTodoIfMissing(conv, "Call customer (follow-up).");
    };

    if (systemMode === "suggest") {
      const draftTo = useEmail ? emailTo! : to;
      const draftMessage = useEmail && emailMessage ? emailMessage : message;
      if (
        isRecentDuplicateOutbound(conv, draftTo, draftMessage, {
          providers: ["draft_ai"],
          windowMs: 2 * 60 * 1000,
          mediaUrls
        })
      ) {
        console.log("[followup] duplicate draft suppressed", { convId: conv.id, to: draftTo });
        continue;
      }
      appendOutbound(conv, from ?? "salesperson", draftTo, draftMessage, "draft_ai", undefined, mediaUrls);
      maybeAddCallTodoForFollowUp();
      advanceFollowUpCadence(conv, cfg.timezone);
      continue;
    }

    if (useEmail) {
      if (!emailFrom) {
        const fallbackMessage = emailMessage ?? message;
        if (
          isRecentDuplicateOutbound(conv, emailTo!, fallbackMessage, {
            providers: ["human", "sendgrid", "draft_ai"],
            windowMs: 2 * 60 * 1000,
            mediaUrls
          })
        ) {
          console.log("[followup] duplicate email fallback suppressed", { convId: conv.id, to: emailTo });
          continue;
        }
        appendOutbound(conv, "salesperson", emailTo!, fallbackMessage, "human", undefined, mediaUrls);
        maybeAddCallTodoForFollowUp();
      } else {
        try {
        const dealerName = dealerProfile?.dealerName ?? "Dealership";
        const subject = `Follow-up from ${dealerName}`;
        const body = emailMessage ?? message;
        if (
          isRecentDuplicateOutbound(conv, emailTo!, body, {
            providers: ["sendgrid", "human"],
            windowMs: 2 * 60 * 1000,
            mediaUrls
          })
        ) {
          console.log("[followup] duplicate email suppressed", { convId: conv.id, to: emailTo });
          continue;
        }
        const signed =
          signature
            ? `${body}\n\n${signature}${dealerProfile?.logoUrl ? `\n\n${dealerProfile.logoUrl}` : ""}`
            : appendFallbackEmailSignoff(body, dealerProfile);
        await sendEmail({
          to: emailTo!,
          subject,
          text: signed,
          from: emailFrom,
          replyTo
        });
        appendOutbound(conv, emailFrom, emailTo!, signed, "sendgrid", undefined, mediaUrls);
        maybeAddCallTodoForFollowUp();
      } catch (e: any) {
        console.log("[followup] email send failed:", e?.message ?? e);
        const fallbackMessage = emailMessage ?? message;
        appendOutbound(conv, "salesperson", emailTo!, fallbackMessage, "human", undefined, mediaUrls);
        maybeAddCallTodoForFollowUp();
      }
      }
      advanceFollowUpCadence(conv, cfg.timezone);
      continue;
    }

    if (!from || !accountSid || !authToken || !to.startsWith("+")) {
      if (
        isRecentDuplicateOutbound(conv, to, message, {
          providers: ["human", "twilio", "draft_ai"],
          windowMs: 2 * 60 * 1000,
          mediaUrls
        })
      ) {
        console.log("[followup] duplicate sms fallback suppressed", { convId: conv.id, to });
        continue;
      }
      appendOutbound(conv, "salesperson", to, message, "human", undefined, mediaUrls);
      maybeAddCallTodoForFollowUp();
      advanceFollowUpCadence(conv, cfg.timezone);
      continue;
    }

    try {
      if (
        isRecentDuplicateOutbound(conv, to, message, {
          providers: ["twilio", "human"],
          windowMs: 2 * 60 * 1000,
          mediaUrls
        })
      ) {
        console.log("[followup] duplicate sms suppressed", { convId: conv.id, to });
        continue;
      }
      const client = twilio(accountSid, authToken);
      const msg = await client.messages.create({
        from,
        to,
        body: message,
        ...(mediaUrls && mediaUrls.length ? { mediaUrl: mediaUrls } : {})
      });
      appendOutbound(conv, from, to, message, "twilio", msg.sid, mediaUrls);
      maybeAddCallTodoForFollowUp();
      advanceFollowUpCadence(conv, cfg.timezone);
    } catch (e: any) {
      console.log("[followup] send failed:", e?.message ?? e);
    }
  }
}

async function processAppointmentConfirmations() {
  const cfg = await getSchedulerConfigHot();
  const now = new Date();
  const convs = getAllConversations();

  for (const conv of convs) {
    const appt = conv.appointment;
    if (!appt?.bookedEventId || !appt.whenIso) continue;
    if (conv.status === "closed") continue;
    if (isSuppressed(conv.leadKey)) continue;
    if (appt.confirmation?.status === "confirmed" || appt.confirmation?.status === "declined") continue;
    if (appt.confirmation?.sentAt) continue;

    const start = new Date(appt.whenIso);
    const diffMs = start.getTime() - now.getTime();
    if (diffMs > 24 * 60 * 60 * 1000 || diffMs <= 23 * 60 * 60 * 1000) continue;

    const when = formatSlotLocal(appt.whenIso, cfg.timezone);
    const message = `Reminder: you’re scheduled for ${when}. Please reply YES to confirm or NO to reschedule.`;
    const systemMode = effectiveMode(conv);
    const from = process.env.TWILIO_FROM_NUMBER;
    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    const toNumber = normalizePhone(conv.leadKey);

    if (systemMode === "suggest") {
      if (
        isRecentDuplicateOutbound(conv, toNumber, message, {
          providers: ["draft_ai", "twilio", "human"],
          windowMs: 10 * 60 * 1000
        })
      ) {
        appt.confirmation = {
          sentAt: new Date().toISOString(),
          status: "pending"
        };
        continue;
      }
      appt.confirmation = {
        sentAt: new Date().toISOString(),
        status: "pending"
      };
      appendOutbound(conv, from ?? "salesperson", toNumber, message, "draft_ai");
    } else if (from && accountSid && authToken && toNumber.startsWith("+")) {
      try {
        if (
          isRecentDuplicateOutbound(conv, toNumber, message, {
            providers: ["twilio", "human", "draft_ai"],
            windowMs: 10 * 60 * 1000
          })
        ) {
          appt.confirmation = {
            sentAt: new Date().toISOString(),
            status: "pending"
          };
          continue;
        }
        const client = twilio(accountSid, authToken);
        const msg = await client.messages.create({ from, to: toNumber, body: message });
        appt.confirmation = {
          sentAt: new Date().toISOString(),
          status: "pending"
        };
        appendOutbound(conv, from, toNumber, message, "twilio", msg.sid);
      } catch (e: any) {
        console.log("[appt-confirm] send failed:", e?.message ?? e);
        continue;
      }
    } else {
      if (
        isRecentDuplicateOutbound(conv, toNumber, message, {
          providers: ["human", "twilio", "draft_ai"],
          windowMs: 10 * 60 * 1000
        })
      ) {
        appt.confirmation = {
          sentAt: new Date().toISOString(),
          status: "pending"
        };
        continue;
      }
      appt.confirmation = {
        sentAt: new Date().toISOString(),
        status: "pending"
      };
      appendOutbound(conv, "salesperson", toNumber, message, "human");
    }
  }
}

async function processStaffAppointmentNotifications() {
  const cfg = await getSchedulerConfigHot();
  const users = await listUsers();
  const now = new Date();
  const convs = getAllConversations();
  let changed = false;
  const cal = await getAuthedCalendarClient();

  const resolveCalendarId = (appt: any): string | null => {
    if (appt?.bookedCalendarId) return appt.bookedCalendarId;
    if (appt?.matchedSlot?.calendarId) return appt.matchedSlot.calendarId;
    const spId = appt?.bookedSalespersonId ?? "";
    if (!spId) return null;
    const sp = (cfg.salespeople ?? []).find(s => s.id === spId);
    return sp?.calendarId ?? null;
  };

  for (const conv of convs) {
    const appt = conv.appointment;
    if (!appt?.bookedEventId || !appt.bookedSalespersonId || !appt.whenIso) continue;
    if (conv.status === "closed") continue;

    const user = users.find(u => u.id === appt.bookedSalespersonId);
    if (!user?.phone) continue;
    const toNumber = normalizePhone(user.phone);
    if (!toNumber.startsWith("+")) continue;

    appt.staffNotify = appt.staffNotify ?? {};
    const token = ensureAppointmentOutcomeToken(appt);
    const link = buildStaffOutcomeLink(token);
    const whenLocal = formatSlotLocal(appt.whenIso, cfg.timezone);
    const customerName =
      [conv.lead?.firstName, conv.lead?.lastName].filter(Boolean).join(" ").trim() ||
      conv.lead?.name ||
      conv.leadKey ||
      "Customer";
    const vehicle =
      conv.lead?.vehicle?.model ??
      conv.lead?.vehicle?.description ??
      conv.sale?.label ??
      "the bike";
    const apptType =
      appt.appointmentType ??
      appt.matchedSlot?.appointmentType ??
      "appointment";
    const summary = summarizeConversationForStaff(conv);

    const eventChanged =
      appt.bookedEventId && appt.staffNotify.lastEventId && appt.bookedEventId !== appt.staffNotify.lastEventId;

    const calendarId = resolveCalendarId(appt);
    if (!calendarId) continue;
    try {
      await cal.events.get({ calendarId, eventId: appt.bookedEventId });
    } catch (e: any) {
      const status = e?.code ?? e?.status;
      if (status === 404) {
        continue;
      }
      console.warn("[staff-sms] event lookup failed:", e?.message ?? e);
      continue;
    }

    if (!appt.staffNotify.bookedSentAt || eventChanged) {
      const bookedText = [
        `New appointment booked`,
        `${customerName} — ${vehicle}`,
        `Type: ${apptType} | ${whenLocal}`,
        summary ? `Notes: ${summary}` : null,
        link ? `Outcome: ${link}` : null
      ]
        .filter(Boolean)
        .join("\n");
      const sent = await sendInternalSms(toNumber, bookedText);
      if (sent) {
        appt.staffNotify.bookedSentAt = new Date().toISOString();
        appt.staffNotify.lastEventId = appt.bookedEventId;
        changed = true;
      }
    }

    if (appt.staffNotify.outcome) continue;
    if (appt.staffNotify.followUpSentAt) continue;

    const start = new Date(appt.whenIso);
    if (Number.isNaN(start.getTime())) continue;
    const followAt = new Date(start.getTime() + 15 * 60 * 1000);
    if (now < followAt) continue;

    const followText = link
      ? `Did ${customerName} show for the ${whenLocal} appointment? Update here: ${link}`
      : `Did ${customerName} show for the ${whenLocal} appointment?`;
    const followSent = await sendInternalSms(toNumber, followText);
    if (followSent) {
      appt.staffNotify.followUpSentAt = new Date().toISOString();
      changed = true;
    }
  }

  if (changed) {
    await flushConversationStore();
  }
}

async function processAppointmentQuestions() {
  if (String(process.env.APPOINTMENT_INTERNAL_QUESTIONS ?? "").trim() !== "1") {
    return;
  }
  const cfg = await getSchedulerConfigHot();
  const now = new Date();
  const convs = getAllConversations();
  const openQuestions = listOpenQuestions();
  const openByConv = new Set(openQuestions.map((q: { convId: string }) => q.convId));

  for (const conv of convs) {
    const appt = conv.appointment;
    if (!appt?.whenIso || !appt.bookedEventId) continue;
    if (conv.status === "closed") continue;
    if (isSuppressed(conv.leadKey)) continue;
    if (appt.attendanceQuestionedAt) continue;
    if (openByConv.has(conv.id)) continue;

    const when = new Date(appt.whenIso);
    if (now.getTime() < when.getTime() + 2 * 60 * 60 * 1000) continue;

    const whenText = formatSlotLocal(appt.whenIso, cfg.timezone);
    const text = `Did the customer show for the ${whenText} appointment?`;
    addInternalQuestion(conv.id, conv.leadKey, text, "attendance");
    appt.attendanceQuestionedAt = now.toISOString();
  }
}

async function maybeStartCadence(conv: any, sentAtIso: string) {
  if (conv.appointment?.bookedEventId) return;
  if (conv.status === "closed") return;
  if (conv.classification?.bucket === "service" || conv.classification?.cta === "service_request") return;
  if (conv.followUp?.mode === "manual_handoff" || conv.followUp?.mode === "paused_indefinite") return;
  if (conv.followUpCadence?.status === "active" || conv.followUpCadence?.status === "stopped") return;
  const purchaseTimeframeRaw = String(conv.lead?.purchaseTimeframe ?? "").toLowerCase();
  const notReadyTimeframe =
    /\b(not interested|not ready|not (yet|right now)|not in the market|not looking)\b/i.test(
      purchaseTimeframeRaw
    );
  if (notReadyTimeframe) return;
  const cfg = await getSchedulerConfigHot();
  const monthsStart = Number(conv.lead?.purchaseTimeframeMonthsStart ?? 0);
  if (Number.isFinite(monthsStart) && monthsStart >= 1) {
    const due = new Date(sentAtIso || new Date().toISOString());
    due.setMonth(due.getMonth() + monthsStart);
    due.setHours(10, 30, 0, 0);
    const timeframeLabel = String(conv.lead?.purchaseTimeframe ?? "").trim() || "a future";
    const msg =
      `Hi, this is Brooke at American Harley-Davidson. You mentioned a ${timeframeLabel} timeline. ` +
      "I’m here when you’re ready. Just reach out when the time is right.";
    scheduleLongTermFollowUp(conv, due.toISOString(), msg);
    return;
  }
  startFollowUpCadence(conv, sentAtIso, cfg.timezone);
}

app.get("/integrations/google/start", async (_req, res) => {
  const oauth2 = getOAuthClient();
  const scopes = ["https://www.googleapis.com/auth/calendar"];
  const url = oauth2.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: scopes
  });
  res.redirect(url);
});

app.get("/integrations/google/status", async (_req, res) => {
  try {
    const cal = await getAuthedCalendarClient();
    await cal.calendarList.list({ maxResults: 1 });
    return res.json({ ok: true, connected: true });
  } catch (err: any) {
    const message = err?.message ?? String(err);
    let reason = "error";
    if (/invalid_grant/i.test(message)) reason = "invalid_grant";
    else if (/not connected/i.test(message)) reason = "not_connected";
    return res.json({ ok: true, connected: false, reason, error: message });
  }
});

app.get("/integrations/google/callback", async (req, res) => {
  const code = String(req.query.code ?? "");
  if (!code) return res.status(400).send("Missing code");

  const oauth2 = getOAuthClient();
  const { tokens } = await oauth2.getToken(code);
  await saveTokens(tokens);

  res.send("Google Calendar connected. You can close this tab.");
});

app.post("/scheduler/suggest", async (req, res) => {
  const cfg = await getSchedulerConfigHot();
  const appointmentTypes = cfg.appointmentTypes ?? { inventory_visit: { durationMinutes: 60 } };
  const preferredSalespeople = getPreferredSalespeople(cfg);
  const salespeople = cfg.salespeople ?? [];
  const gapMinutes = cfg.minGapBetweenAppointmentsMinutes ?? 60;
  const type = String(req.body?.appointmentType ?? "inventory_visit");
  const durationMinutes = appointmentTypes[type]?.durationMinutes ?? 60;

  const now = new Date();
  const candidatesByDay = generateCandidateSlots(cfg, now, durationMinutes, 14);

  console.log(
    "[sched] tz",
    cfg.timezone,
    "now",
    new Date().toISOString(),
    "nowLocal",
    new Date().toLocaleString("en-US", { timeZone: cfg.timezone })
  );
  for (let i = 0; i < 3; i++) {
    const d = new Date(now);
    d.setDate(d.getDate() + i);
    console.log("[sched] dayKey", i, dayKey(d, cfg.timezone));
  }

  const pref = preferredSalespeople;
  const people = salespeople;

  const cal = await getAuthedCalendarClient();

  for (const salespersonId of pref) {
    const sp = people.find((p: any) => p.id === salespersonId);
    if (!sp) continue;

    const timeMin =
      candidatesByDay[0]?.candidates[0]?.start?.toISOString() ?? new Date(now).toISOString();
    const lastDay = candidatesByDay[candidatesByDay.length - 1];
    const timeMax =
      lastDay?.candidates[lastDay.candidates.length - 1]?.end?.toISOString() ??
      new Date(now.getTime() + 7 * 864e5).toISOString();

    const fb = await queryFreeBusy(cal, [sp.calendarId], timeMin, timeMax, cfg.timezone);
    const busy = (fb.calendars?.[sp.calendarId]?.busy ?? []) as any;
    const expanded = expandBusyBlocks(busy, gapMinutes);

    const slots = pickSlotsForSalesperson(
      cfg,
      sp.id,
      sp.calendarId,
      candidatesByDay,
      expanded,
      3
    );

    if (slots.length > 0) {
      const slotsWithLocal = slots.map(s => ({
        ...s,
        startLocal: fmtLocal(s.start, cfg.timezone),
        endLocal: fmtLocal(s.end, cfg.timezone)
      }));

      const leadKey = String(req.body?.leadKey ?? "").trim();
      if (leadKey) {
        const conv = getConversation(leadKey);
        if (conv) setLastSuggestedSlots(conv, slotsWithLocal);
      }

      return res.json({
        ok: true,
        appointmentType: type,
        durationMinutes,
        salesperson: { id: sp.id, name: sp.name, calendarId: sp.calendarId },
        slots: slotsWithLocal
      });
    }
  }

  return res.json({ ok: true, appointmentType: type, durationMinutes, slots: [] });
});

app.post("/scheduler/book", async (req, res) => {
  const cfg = await getSchedulerConfigHot();
  const salespeople = cfg.salespeople ?? [];

  const slot = req.body?.slot as { salespersonId: string; calendarId: string; start: string; end: string };
  const lead = req.body?.lead as any;
  const appointmentType = String(req.body?.appointmentType ?? "inventory_visit");

  if (!slot?.calendarId || !slot?.start || !slot?.end) {
    return res.status(400).json({ ok: false, error: "Missing slot.calendarId/start/end" });
  }

  const salesperson = salespeople.find((s: any) => s.id === slot.salespersonId);
  const leadNameRaw = lead?.name?.trim() ?? "";
  const firstName = lead?.firstName ?? "";
  const lastName = lead?.lastName ?? "";
  const leadName =
    leadNameRaw ||
    [firstName, lastName].filter(Boolean).join(" ").trim() ||
    String(req.body?.leadKey ?? "");
  const summary = `Appt: ${appointmentType} – ${leadName}`.trim();

  const descriptionLines = [
    `LeadKey: ${lead?.leadKey ?? ""}`,
    `Phone: ${lead?.phone ?? ""}`,
    `Email: ${lead?.email ?? ""}`,
    `FirstName: ${firstName ?? ""}`,
    `LastName: ${lastName ?? ""}`,
    `Stock: ${lead?.stockId ?? ""}`,
    `VIN: ${lead?.vin ?? ""}`,
    `Source: ${lead?.leadSource ?? ""}`,
    `VisitType: ${appointmentType}`,
    "",
    `Notes: ${lead?.notes ?? ""}`
  ].filter(Boolean);

  const cal = await getAuthedCalendarClient();
  const colorId = getAppointmentTypeColorId(cfg, appointmentType);
  const event = await insertEvent(
    cal,
    slot.calendarId,
    cfg.timezone,
    summary,
    descriptionLines.join("\n"),
    slot.start,
    slot.end,
    colorId
  );

  const leadKey = String(req.body?.lead?.leadKey ?? "").trim();
  if (leadKey) {
    const conv = getConversation(leadKey);
    if (conv) {
      conv.appointment = conv.appointment ?? { status: "none", updatedAt: new Date().toISOString() };
      conv.appointment.status = "confirmed";
      conv.appointment.whenText = `${(slot as any).startLocal ?? slot.start}`;
      conv.appointment.whenIso = slot.start;
      conv.appointment.confirmedBy = "customer";
      conv.appointment.updatedAt = new Date().toISOString();
      conv.appointment.acknowledged = true;
      conv.appointment.bookedEventId = event.id ?? null;
      conv.appointment.bookedEventLink = event.htmlLink ?? null;
      conv.appointment.bookedSalespersonId = slot.salespersonId ?? null;
      onAppointmentBooked(conv);
    }
  }

  return res.json({
    ok: true,
    eventId: event.id,
    htmlLink: event.htmlLink,
    salesperson: salesperson ? { id: salesperson.id, name: salesperson.name } : null
  });
});

app.get("/public/booking/config", async (req, res) => {
  const profile = await getDealerProfileHot();
  const token = extractBookingToken(req);
  const expected = getBookingToken(profile);
  if (!token || !expected || token !== expected) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }
  const cfg = await getSchedulerConfigHot();
  return res.json({
    ok: true,
    dealer: {
      dealerName: profile?.dealerName ?? "",
      agentName: profile?.agentName ?? "",
      phone: profile?.phone ?? "",
      website: profile?.website ?? "",
      address: profile?.address ?? null
    },
    timezone: cfg.timezone,
    appointmentTypes: Object.keys(cfg.appointmentTypes ?? { inventory_visit: { durationMinutes: 60 } })
  });
});

app.get("/public/booking/availability", async (req, res) => {
  const profile = await getDealerProfileHot();
  const token = extractBookingToken(req);
  const expected = getBookingToken(profile);
  if (!token || !expected || token !== expected) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }

  const cfg = await getSchedulerConfigHot();
  const appointmentTypes = cfg.appointmentTypes ?? { inventory_visit: { durationMinutes: 60 } };
  const type = String(req.query?.type ?? "inventory_visit");
  const durationMinutes = appointmentTypes[type]?.durationMinutes ?? 60;
  const daysAheadRaw = Number(req.query?.daysAhead ?? 14);
  const daysAhead = Number.isFinite(daysAheadRaw) ? Math.min(Math.max(daysAheadRaw, 3), 30) : 14;
  const perDayRaw = Number(req.query?.perDay ?? req.query?.perSalesperson ?? 24);
  const perDay = Number.isFinite(perDayRaw) ? Math.min(Math.max(perDayRaw, 2), 48) : 24;

  const now = new Date();
  const candidatesByDay = generateCandidateSlots(cfg, now, durationMinutes, daysAhead);
  const salespeople = cfg.salespeople ?? [];
  const preferred = (cfg.preferredSalespeople?.length
    ? cfg.preferredSalespeople
    : salespeople.map(s => s.id)) as string[];
  const gapMinutes = cfg.minGapBetweenAppointmentsMinutes ?? 60;

  const cal = await getAuthedCalendarClient();
  const unique = new Map<
    string,
    { start: string; end: string; startLocal: string; endLocal: string }
  >();
  const perDayCounts = new Map<string, number>();

  for (const salespersonId of preferred) {
    const sp = salespeople.find(p => p.id === salespersonId);
    if (!sp?.calendarId) continue;
    const timeMin =
      candidatesByDay[0]?.candidates[0]?.start?.toISOString() ?? new Date(now).toISOString();
    const lastDay = candidatesByDay[candidatesByDay.length - 1];
    const timeMax =
      lastDay?.candidates[lastDay.candidates.length - 1]?.end?.toISOString() ??
      new Date(now.getTime() + daysAhead * 864e5).toISOString();

    const fb = await queryFreeBusy(cal, [sp.calendarId], timeMin, timeMax, cfg.timezone);
    const busy = (fb.calendars?.[sp.calendarId]?.busy ?? []) as any[];
    const expanded = expandBusyBlocks(busy, gapMinutes);
    for (const dayEntry of candidatesByDay) {
      for (const c of dayEntry.candidates) {
        const blocked = expanded.some(b => overlaps(c.start, c.end, b.start, b.end));
        if (blocked) continue;
        const startIso = c.start.toISOString();
        const endIso = c.end.toISOString();
        const key = `${startIso}|${endIso}`;
        const dayKey = dayKeyLocal(startIso, cfg.timezone);
        const count = perDayCounts.get(dayKey) ?? 0;
        if (count >= perDay) continue;
        if (unique.has(key)) continue;
        unique.set(key, {
          start: startIso,
          end: endIso,
          startLocal: fmtLocal(startIso, cfg.timezone),
          endLocal: fmtLocal(endIso, cfg.timezone)
        });
        perDayCounts.set(dayKey, count + 1);
      }
    }
  }

  const slots = Array.from(unique.values()).sort((a, b) =>
    a.start < b.start ? -1 : a.start > b.start ? 1 : 0
  );
  const limitRaw = Number(req.query?.limit ?? 0);
  const defaultLimit = Math.min(Math.max(daysAhead * perDay, 48), 1000);
  const limit =
    Number.isFinite(limitRaw) && limitRaw > 0
      ? Math.min(Math.max(limitRaw, 24), 1000)
      : defaultLimit;

  return res.json({
    ok: true,
    appointmentType: type,
    durationMinutes,
    slots: slots.slice(0, limit)
  });
});

app.post("/public/booking/book", async (req, res) => {
  const profile = await getDealerProfileHot();
  const token = extractBookingToken(req);
  const expected = getBookingToken(profile);
  if (!token || !expected || token !== expected) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }

  const cfg = await getSchedulerConfigHot();
  const slot = req.body?.slot as {
    start: string;
    end: string;
    startLocal?: string;
    endLocal?: string;
  };
  const lead = req.body?.lead as any;
  const appointmentType = String(req.body?.appointmentType ?? "inventory_visit");

  if (!slot?.start || !slot?.end) {
    return res.status(400).json({ ok: false, error: "Missing slot.start/end" });
  }

  const leadKey = String(lead?.leadKey ?? lead?.phone ?? lead?.email ?? "").trim();
  if (!leadKey) {
    return res.status(400).json({ ok: false, error: "Missing leadKey/phone/email" });
  }

  const leadNameRaw = lead?.name?.trim?.() ?? "";
  const firstName = lead?.firstName ?? "";
  const lastName = lead?.lastName ?? "";
  const leadName =
    leadNameRaw ||
    [firstName, lastName].filter(Boolean).join(" ").trim() ||
    leadKey;
  const summary = `Appt: ${appointmentType} – ${leadName}`.trim();

  const descriptionLines = [
    `LeadKey: ${leadKey}`,
    `Phone: ${lead?.phone ?? ""}`,
    `Email: ${lead?.email ?? ""}`,
    `FirstName: ${firstName ?? ""}`,
    `LastName: ${lastName ?? ""}`,
    `Stock: ${lead?.stockId ?? ""}`,
    `VIN: ${lead?.vin ?? ""}`,
    `Source: ${lead?.leadSource ?? "public_booking"}`,
    `VisitType: ${appointmentType}`,
    "",
    `Notes: ${lead?.notes ?? ""}`
  ].filter(Boolean);

  const cal = await getAuthedCalendarClient();
  const preferred = getPreferredSalespeople(cfg);
  const salespeople = cfg.salespeople ?? [];
  let chosenSp: { id: string; calendarId: string; name?: string } | null = null;
  const slotStart = new Date(slot.start);
  const slotEnd = new Date(slot.end);
  for (const salespersonId of preferred) {
    const sp = salespeople.find(p => p.id === salespersonId);
    if (!sp?.calendarId) continue;
    const fb = await queryFreeBusy(cal, [sp.calendarId], slot.start, slot.end, cfg.timezone);
    const busy = (fb.calendars?.[sp.calendarId]?.busy ?? []) as any[];
    const blocked = busy.some((b: any) => {
      const bStart = new Date(b.start);
      const bEnd = new Date(b.end);
      return slotStart < bEnd && bStart < slotEnd;
    });
    if (blocked) continue;
    chosenSp = { id: sp.id, calendarId: sp.calendarId, name: sp.name };
    break;
  }

  if (!chosenSp) {
    return res.status(409).json({ ok: false, error: "No longer available" });
  }

  const colorId = getAppointmentTypeColorId(cfg, appointmentType);
  const event = await insertEvent(
    cal,
    chosenSp.calendarId,
    cfg.timezone,
    summary,
    descriptionLines.join("\n"),
    slot.start,
    slot.end,
    colorId
  );

  const conv = upsertConversationByLeadKey(leadKey, "suggest");
  conv.lead = {
    ...(conv.lead ?? {}),
    name: leadNameRaw || undefined,
    firstName,
    lastName,
    email: lead?.email ?? conv.lead?.email ?? "",
    phone: lead?.phone ?? conv.lead?.phone ?? "",
    source: conv.lead?.source ?? "Public Booking",
    vehicle: lead?.vehicle ?? conv.lead?.vehicle
  };
  conv.appointment = conv.appointment ?? { status: "none", updatedAt: new Date().toISOString() };
  conv.appointment.status = "confirmed";
  conv.appointment.whenText = slot.startLocal ?? fmtLocal(slot.start, cfg.timezone);
  conv.appointment.whenIso = slot.start;
  conv.appointment.confirmedBy = "customer";
  conv.appointment.updatedAt = new Date().toISOString();
  conv.appointment.acknowledged = true;
  conv.appointment.bookedEventId = event.id ?? null;
  conv.appointment.bookedEventLink = event.htmlLink ?? null;
  conv.appointment.bookedSalespersonId = chosenSp.id ?? null;
  onAppointmentBooked(conv);

  return res.json({
    ok: true,
    eventId: event.id,
    htmlLink: event.htmlLink,
    whenText: conv.appointment.whenText,
    salesperson: chosenSp?.name ?? null
  });
});

app.get("/public/booking/prefill", async (req, res) => {
  const profile = await getDealerProfileHot();
  const token = extractBookingToken(req);
  const expected = getBookingToken(profile);
  if (!token || !expected || token !== expected) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }

  const leadKey = String(req.query?.leadKey ?? "").trim();
  const agentName = String(req.query?.agentName ?? "").trim();
  if (!leadKey) return res.json({ ok: true, lead: null });
  const conv = getConversation(leadKey);
  if (!conv) return res.json({ ok: true, lead: null });

  return res.json({
    ok: true,
    lead: {
      firstName: conv.lead?.firstName ?? "",
      lastName: conv.lead?.lastName ?? "",
      email: conv.lead?.email ?? "",
      phone: conv.lead?.phone ?? "",
      name: conv.lead?.name ?? "",
      appointmentType: inferAppointmentTypeFromConv(conv)
    }
  });
});

app.get("/public/appointment/outcome", async (req, res) => {
  const token = String(req.query?.token ?? "").trim();
  if (!token) return res.status(400).send("Missing token");
  const conv = findConversationByOutcomeToken(token);
  if (!conv) return res.status(404).send("Not found");
  const isAppointmentOutcome = !!conv.appointment;
  const cfg = await getSchedulerConfigHot();
  const whenIso = conv.appointment?.whenIso ?? "";
  const whenText = whenIso ? formatSlotLocal(whenIso, cfg.timezone) : isAppointmentOutcome ? "appointment" : "dealer ride";
  const customer = conv.lead?.name ?? conv.leadName ?? conv.leadKey ?? "Customer";
  const vehicle =
    conv.vehicleDescription ??
    conv.lead?.vehicle?.model ??
    conv.lead?.vehicle?.description ??
    "the bike";
  const leadVehicle = conv.lead?.vehicle ?? {};
  const holds = await listInventoryHolds();
  const leadStock = String(leadVehicle?.stockId ?? "").trim();
  const leadVin = String(leadVehicle?.vin ?? "").trim();
  const holdByKey =
    leadStock || leadVin ? await getInventoryHold(leadStock || null, leadVin || null) : null;
  const digitsOnly = (raw: any) => String(raw ?? "").replace(/\D/g, "");
  const leadDigits = digitsOnly(conv.leadKey) || digitsOnly(conv.lead?.phone);
  const holdByConvKey =
    conv.hold?.key && holds ? (holds as any)?.[String(conv.hold.key)] ?? null : null;
  const holdUnit =
    conv.hold ??
    holdByConvKey ??
    holdByKey ??
    Object.values(holds ?? {}).find((h: any) => {
      if (!h) return false;
      if (h?.leadKey === conv.leadKey || h?.convId === conv.id) return true;
      const hDigits = digitsOnly(h?.leadKey);
      return Boolean(hDigits && leadDigits && hDigits.endsWith(leadDigits.slice(-10)));
    }) ??
    null;
  const saleUnit = conv.sale ?? null;
  const preferredStock = String(saleUnit?.stockId ?? holdUnit?.stockId ?? leadStock ?? "").trim();
  const preferredVin = String(saleUnit?.vin ?? holdUnit?.vin ?? leadVin ?? "").trim();
  const preferredSource = saleUnit?.stockId || saleUnit?.vin
    ? "sale"
    : holdUnit?.stockId || holdUnit?.vin
      ? "hold"
      : leadStock || leadVin
        ? "lead"
        : null;
  let matchedUnit: any = null;
  if (preferredStock || preferredVin) {
    try {
      const match = await findInventoryPrice({ stockId: preferredStock || null, vin: preferredVin || null });
      matchedUnit = match?.item ?? null;
    } catch {}
  }
  const unitPrefill = {
    year: String(leadVehicle?.year ?? ""),
    make: String(leadVehicle?.make ?? ""),
    model: String(leadVehicle?.model ?? ""),
    trim: String(leadVehicle?.trim ?? ""),
    color: String(leadVehicle?.color ?? ""),
    stockId: preferredStock,
    vin: preferredVin
  };
  if (matchedUnit) {
    unitPrefill.year = String(matchedUnit.year ?? unitPrefill.year ?? "");
    unitPrefill.make = String(matchedUnit.make ?? unitPrefill.make ?? "");
    unitPrefill.model = String(matchedUnit.model ?? unitPrefill.model ?? "");
    unitPrefill.trim = "";
    unitPrefill.color = String(matchedUnit.color ?? unitPrefill.color ?? "");
    unitPrefill.stockId = String(matchedUnit.stockId ?? unitPrefill.stockId ?? "");
    unitPrefill.vin = String(matchedUnit.vin ?? unitPrefill.vin ?? "");
  } else if (preferredStock && preferredSource === "lead") {
    unitPrefill.stockId = "";
  }

  const html = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${isAppointmentOutcome ? "Appointment Outcome" : "Dealer Ride Outcome"}</title>
    <style>
      body { font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; padding: 24px; color: #111; }
      h1 { font-size: 20px; margin: 0 0 8px; }
      .card { border: 1px solid #ddd; border-radius: 10px; padding: 16px; margin-top: 12px; }
      .row { margin: 8px 0; }
      button { padding: 10px 14px; margin-right: 8px; }
      select, textarea, input { width: 100%; padding: 8px; margin-top: 6px; }
      textarea { min-height: 90px; }
      .muted { color: #666; font-size: 12px; margin-top: 6px; }
      .rec-btn { margin-top: 8px; }
      .unit-results { border: 1px solid #ddd; border-radius: 8px; max-height: 420px; overflow: auto; }
      .unit-item { padding: 8px 10px; border-bottom: 1px solid #eee; cursor: pointer; display: flex; gap: 10px; align-items: center; }
      .unit-item:last-child { border-bottom: none; }
      .unit-item.active { background: #eef6ff; }
      .unit-thumb { width: 56px; height: 56px; border-radius: 6px; background: #f2f2f2; flex: 0 0 56px; object-fit: cover; }
      .unit-meta { display: flex; flex-direction: column; gap: 2px; }
      .modal { position: fixed; inset: 0; background: rgba(0,0,0,0.45); display: none; align-items: center; justify-content: center; z-index: 9999; }
      .modal.open { display: flex; }
      .modal-card { background: #fff; border-radius: 12px; width: min(980px, 92vw); max-height: 85vh; display: flex; flex-direction: column; }
      .modal-header { display: flex; align-items: center; justify-content: space-between; padding: 12px 16px; border-bottom: 1px solid #eee; }
      .modal-body { display: grid; grid-template-columns: 1fr 280px; gap: 12px; padding: 12px 16px 8px; overflow: hidden; }
      .modal-list { overflow: auto; border: 1px solid #ddd; border-radius: 8px; }
      .modal-preview { border: 1px solid #ddd; border-radius: 8px; padding: 8px; display: flex; flex-direction: column; gap: 8px; }
      .preview-img { width: 100%; aspect-ratio: 4 / 3; object-fit: cover; border-radius: 6px; background: #f2f2f2; }
      .modal-footer { display: flex; justify-content: space-between; align-items: center; padding: 8px 16px 12px; }
      .unit-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
    </style>
  </head>
  <body>
    <h1>${isAppointmentOutcome ? "Appointment Outcome" : "Dealer Ride Outcome"}</h1>
    <div class="row"><strong>${escapeHtml(customer)}</strong> — ${escapeHtml(vehicle)}</div>
    <div class="row">${escapeHtml(whenText)}</div>

    <div class="card">
      <form id="outcome-form" method="POST" action="/public/appointment/outcome">
        <input type="hidden" name="token" value="${escapeHtml(token)}" />
        <label>Outcome</label>
        <select name="outcome">
          <option value="follow_up">Needs follow up</option>
          <option value="showed_up">Showed up</option>
          <option value="no_show">No show</option>
          <option value="sold">Sold</option>
          <option value="hold">Hold</option>
          <option value="financing_declined">Financing not approved</option>
          <option value="bought_elsewhere">Bought elsewhere</option>
          <option value="other">Other</option>
        </select>
        <div id="unit-section">
          <label>Unit (optional)</label>
          <div style="display:flex; gap:8px; align-items:center;">
            <button type="button" id="unit-browse-btn">Browse inventory</button>
          </div>
          <div class="modal" id="unit-modal">
            <div class="modal-card">
              <div class="modal-header">
                <strong>Select inventory unit</strong>
                <button type="button" id="unit-modal-close">Close</button>
              </div>
              <div class="modal-body">
                <div class="unit-results modal-list" id="unit-modal-list"></div>
                <div class="modal-preview" id="unit-modal-preview">
                  <img class="preview-img" id="unit-preview-img" src="" alt="Inventory photo" />
                  <div id="unit-preview-text" class="muted">Hover a unit to preview</div>
                </div>
              </div>
              <div class="modal-footer">
                <div id="unit-count" class="muted"></div>
                <button type="button" id="unit-more">Show more</button>
              </div>
            </div>
          </div>
          <div class="muted">Not in inventory? Enter details below. Stock # or VIN required for Sold/Hold.</div>
          <div class="unit-grid">
            <input name="unitYear" id="unitYear" placeholder="Year" value="${escapeHtml(unitPrefill.year)}" />
            <input name="unitMake" id="unitMake" placeholder="Make" value="${escapeHtml(unitPrefill.make)}" />
            <input name="unitModel" id="unitModel" placeholder="Model" value="${escapeHtml(unitPrefill.model)}" />
            <input name="unitTrim" id="unitTrim" placeholder="Trim" value="${escapeHtml(unitPrefill.trim)}" />
            <input name="unitColor" id="unitColor" placeholder="Color" value="${escapeHtml(unitPrefill.color)}" />
            <input name="unitStockId" id="unitStockId" placeholder="Stock #" value="${escapeHtml(unitPrefill.stockId)}" />
            <input name="unitVin" id="unitVin" placeholder="VIN" value="${escapeHtml(unitPrefill.vin)}" />
          </div>
          <div class="muted"><button type="button" id="unit-clear">Clear unit</button></div>
        </div>
        <label>Notes (optional)</label>
        <textarea name="note" id="note-field" placeholder="Add any context for the agent…"></textarea>
        <div class="muted">Tap record to add a quick voice note (auto‑saved).</div>
        <button type="button" class="rec-btn" id="rec-btn">🎤 Record note</button>
        <div class="muted" id="rec-status"></div>
        <button type="submit">Submit outcome</button>
      </form>
    </div>
    <script>
      (function() {
        const token = "${escapeHtml(token)}";
        const recBtn = document.getElementById("rec-btn");
        const statusEl = document.getElementById("rec-status");
        const noteEl = document.getElementById("note-field");
        const outcomeEl = document.querySelector("select[name='outcome']");
        const outcomeForm = document.getElementById("outcome-form");
        const unitSection = document.getElementById("unit-section");
        const unitModal = document.getElementById("unit-modal");
        const unitModalList = document.getElementById("unit-modal-list");
        const unitModalClose = document.getElementById("unit-modal-close");
        const unitPreviewImg = document.getElementById("unit-preview-img");
        const unitPreviewText = document.getElementById("unit-preview-text");
        const unitCount = document.getElementById("unit-count");
        const unitMore = document.getElementById("unit-more");
        const unitYear = document.getElementById("unitYear");
        const unitMake = document.getElementById("unitMake");
        const unitModel = document.getElementById("unitModel");
        const unitTrim = document.getElementById("unitTrim");
        const unitColor = document.getElementById("unitColor");
        const unitStock = document.getElementById("unitStockId");
        const unitVin = document.getElementById("unitVin");
        const unitClear = document.getElementById("unit-clear");
        const unitBrowseBtn = document.getElementById("unit-browse-btn");

        let inventory = [];
        let inventoryLoaded = false;
        let inventoryLoading = false;
        function setUnitInputs(item) {
          if (!item) return;
          if (unitYear) unitYear.value = item.year || "";
          if (unitMake) unitMake.value = item.make || "";
          if (unitModel) unitModel.value = item.model || "";
          if (unitTrim) unitTrim.value = item.trim || "";
          if (unitColor) unitColor.value = item.color || "";
          if (unitStock) unitStock.value = item.stockId || "";
          if (unitVin) unitVin.value = item.vin || "";
        }
        function clearUnitInputs() {
          if (unitYear) unitYear.value = "";
          if (unitMake) unitMake.value = "";
          if (unitModel) unitModel.value = "";
          if (unitTrim) unitTrim.value = "";
          if (unitColor) unitColor.value = "";
          if (unitStock) unitStock.value = "";
          if (unitVin) unitVin.value = "";
        }
        let listLimit = 50;
        let lastList = [];
        let lastSelectedKey = "";
        function renderInventory(list, selectedKey) {
          if (!unitModalList) return;
          unitModalList.innerHTML = "";
          lastList = list || [];
          lastSelectedKey = selectedKey || "";
          if (!lastList.length) {
            const empty = document.createElement("div");
            empty.className = "unit-item";
            empty.textContent = "No matching units.";
            unitModalList.appendChild(empty);
            if (unitCount) unitCount.textContent = "";
            if (unitMore) unitMore.style.display = "none";
            return;
          }
          const slice = lastList.slice(0, listLimit);
          slice.forEach(item => {
            const key = (item.stockId || item.vin || "").toLowerCase();
            const row = document.createElement("div");
            row.className = "unit-item" + (selectedKey && key === selectedKey ? " active" : "");
            const label = [item.year, item.make, item.model, item.trim].filter(Boolean).join(" ");
            const color = item.color ? " • " + item.color : "";
            const sub = [];
            if (item.stockId) sub.push("Stock " + item.stockId);
            if (item.vin) sub.push("VIN " + item.vin);
            const img = document.createElement("img");
            img.className = "unit-thumb";
            img.alt = label || item.model || "Inventory photo";
            img.src = item.image || "";
            img.addEventListener("error", () => {
              img.src = "";
            });
            const meta = document.createElement("div");
            meta.className = "unit-meta";
            const title = document.createElement("div");
            title.textContent = (label || item.model || item.stockId || item.vin) + color;
            const subline = document.createElement("div");
            subline.className = "muted";
            subline.textContent = sub.length ? sub.join(" • ") : "";
            meta.appendChild(title);
            if (subline.textContent) meta.appendChild(subline);
            row.appendChild(img);
            row.appendChild(meta);
            row.addEventListener("mouseover", () => {
              if (unitPreviewImg) unitPreviewImg.src = item.image || "";
              if (unitPreviewText) {
                unitPreviewText.textContent =
                  (label || item.model || item.stockId || item.vin) +
                  (color || "") +
                  (sub.length ? " (" + sub.join(" • ") + ")" : "");
              }
            });
            row.addEventListener("click", () => {
              setUnitInputs(item);
              renderInventory(list, key);
              if (unitModal) unitModal.classList.remove("open");
            });
            unitModalList.appendChild(row);
          });
          if (unitCount) unitCount.textContent = "Showing " + Math.min(listLimit, lastList.length) + " of " + lastList.length;
          if (unitMore) unitMore.style.display = lastList.length > listLimit ? "inline-block" : "none";
        }
        function filterInventory(q) {
          if (!inventory.length) return [];
          const query = (q || "").toLowerCase().trim();
          if (!query) return inventory;
          return inventory.filter(it => {
            const hay = [it.year, it.make, it.model, it.trim, it.color, it.stockId, it.vin]
              .filter(Boolean)
              .join(" ")
              .toLowerCase();
            return hay.includes(query);
          });
        }
        function isUnitOutcome() {
          const status = outcomeEl ? outcomeEl.value : "";
          return status === "sold" || status === "hold";
        }
        function toggleUnitSection() {
          if (!unitSection) return;
          const show = isUnitOutcome();
          unitSection.style.display = show ? "block" : "none";
          if (!show) {
            clearUnitInputs();
            if (unitResults) unitResults.innerHTML = "";
          }
        }
        let showAllOnLoad = false;
        function ensureInventoryLoaded() {
          if (inventoryLoaded || inventoryLoading || !unitModalList) return;
          inventoryLoading = true;
          const loading = document.createElement("div");
          loading.className = "unit-item";
          loading.textContent = "Loading inventory…";
          unitModalList.innerHTML = "";
          unitModalList.appendChild(loading);
          fetch("/public/inventory")
            .then(r => r.json())
            .then(data => {
              if (data?.ok === false) {
                inventory = [];
              } else {
                inventory = Array.isArray(data?.items) ? data.items : [];
              }
              inventoryLoaded = true;
              const preKey = ((unitStock && unitStock.value) || (unitVin && unitVin.value) || "").toLowerCase();
              let list = filterInventory(showAllOnLoad ? "" : "");
              renderInventory(list, preKey);
              if (list.length === 1) {
                setUnitInputs(list[0]);
              }
              showAllOnLoad = false;
            })
            .catch(() => {
              inventory = [];
              inventoryLoaded = true;
              unitModalList.innerHTML = "";
              const empty = document.createElement("div");
              empty.className = "unit-item";
              empty.textContent = "Inventory unavailable — enter details below.";
              unitModalList.appendChild(empty);
            })
            .finally(() => {
              inventoryLoading = false;
            });
        }
        function showInventoryList() {
          if (!isUnitOutcome()) return;
          if (unitModal) unitModal.classList.add("open");
          listLimit = 50;
          if (!inventoryLoaded) {
            showAllOnLoad = true;
            ensureInventoryLoaded();
            return;
          }
          const list = filterInventory("");
          const selectedKey = ((unitStock && unitStock.value) || (unitVin && unitVin.value) || "").toLowerCase();
          renderInventory(list, selectedKey);
        }
        if (unitBrowseBtn) {
          unitBrowseBtn.addEventListener("click", () => {
            showInventoryList();
          });
        }
        if (unitModalClose) {
          unitModalClose.addEventListener("click", () => {
            if (unitModal) unitModal.classList.remove("open");
          });
        }
        if (unitMore) {
          unitMore.addEventListener("click", () => {
            listLimit += 50;
            renderInventory(lastList, lastSelectedKey);
          });
        }
        if (unitModal) {
          unitModal.addEventListener("click", e => {
            if (e.target === unitModal) unitModal.classList.remove("open");
          });
        }
        if (unitClear) {
          unitClear.addEventListener("click", () => {
            clearUnitInputs();
            const list = filterInventory("");
            renderInventory(list, "");
          });
        }
        if (outcomeEl) {
          outcomeEl.addEventListener("change", () => {
            toggleUnitSection();
            if (isUnitOutcome()) {
              ensureInventoryLoaded();
            }
          });
        }
        toggleUnitSection();
        if (isUnitOutcome()) {
          ensureInventoryLoaded();
        }
        if (outcomeForm && outcomeEl) {
          outcomeForm.addEventListener("submit", e => {
            const status = outcomeEl.value || "";
            const requiresUnit = status === "sold" || status === "hold";
            const hasId = ((unitStock && unitStock.value) || (unitVin && unitVin.value) || "").trim();
            if (requiresUnit && !hasId) {
              e.preventDefault();
              alert("Please enter a Stock # or VIN for Sold/Hold.");
              return;
            }
          });
        }
        if (!recBtn) return;
        let recorder = null;
        let chunks = [];
        let stream = null;

        async function stopRecording() {
          if (!recorder) return;
          recorder.stop();
        }

        async function startRecording() {
          if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
            statusEl.textContent = "Recording not supported on this device.";
            return;
          }
          stream = await navigator.mediaDevices.getUserMedia({ audio: true });
          recorder = new MediaRecorder(stream);
          chunks = [];
          recorder.ondataavailable = e => {
            if (e.data) chunks.push(e.data);
          };
          recorder.onstop = async () => {
            try {
              statusEl.textContent = "Transcribing…";
              const blob = new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
              const fd = new FormData();
              fd.append("token", token);
              fd.append("outcome", outcomeEl ? outcomeEl.value : "");
              fd.append("unitYear", unitYear ? unitYear.value : "");
              fd.append("unitMake", unitMake ? unitMake.value : "");
              fd.append("unitModel", unitModel ? unitModel.value : "");
              fd.append("unitTrim", unitTrim ? unitTrim.value : "");
              fd.append("unitColor", unitColor ? unitColor.value : "");
              fd.append("unitStockId", unitStock ? unitStock.value : "");
              fd.append("unitVin", unitVin ? unitVin.value : "");
              fd.append("audio", blob, "note.webm");
              const resp = await fetch("/public/appointment/outcome/transcribe", { method: "POST", body: fd });
              const json = await resp.json().catch(() => null);
              if (json && json.ok) {
                if (noteEl && json.transcript) noteEl.value = json.transcript;
                statusEl.textContent = "Saved.";
              } else {
                statusEl.textContent = (json && json.error) ? json.error : "Transcription failed.";
              }
            } catch (e) {
              statusEl.textContent = "Transcription failed.";
            } finally {
              if (stream) {
                stream.getTracks().forEach(t => t.stop());
                stream = null;
              }
              recorder = null;
              recBtn.dataset.recording = "0";
              recBtn.textContent = "🎤 Record note";
            }
          };
          recorder.start();
          recBtn.dataset.recording = "1";
          recBtn.textContent = "⏺ Stop recording";
          statusEl.textContent = "Recording… tap again to stop.";
        }

        recBtn.addEventListener("click", () => {
          const recording = recBtn.dataset.recording === "1";
          if (recording) {
            void stopRecording();
          } else {
            void startRecording();
          }
        });
      })();
    </script>
  </body>
</html>`;

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  return res.send(html);
});

app.post("/public/appointment/outcome", async (req, res) => {
  const token = String(req.body?.token ?? "").trim();
  const outcome = String(req.body?.outcome ?? "").trim();
  const note = String(req.body?.note ?? "").trim();
  if (!token || !outcome) return res.status(400).send("Missing data");
  const conv = findConversationByOutcomeToken(token);
  if (!conv) return res.status(404).send("Not found");

  const allowed = new Set([
    "showed_up",
    "no_show",
    "sold",
    "hold",
    "financing_declined",
    "bought_elsewhere",
    "follow_up",
    "other"
  ]);
  if (!allowed.has(outcome)) return res.status(400).send("Invalid outcome");

  const nowIso = new Date().toISOString();
  const unit = readOutcomeUnit(req.body);
  if (outcome === "hold") {
    const err = await applyOutcomeHold(conv, unit, note || undefined, nowIso);
    if (err) return res.status(400).send(err);
  } else if (outcome === "sold") {
    const soldById = conv.appointment?.bookedSalespersonId ?? conv.leadOwner?.id ?? "";
    const err = await applyOutcomeSold(conv, unit, note || undefined, nowIso, soldById, "");
    if (err) return res.status(400).send(err);
  } else if (outcome === "financing_declined") {
    const cfg = await getSchedulerConfigHot();
    conv.followUp = {
      mode: "active",
      reason: "financing_declined",
      updatedAt: nowIso
    };
    conv.followUpCadence = {
      status: "active",
      anchorAt: nowIso,
      nextDueAt: computeFollowUpDueAt(nowIso, LONG_TERM_DAY_OFFSETS[0], cfg.timezone),
      stepIndex: 0,
      kind: "long_term"
    };
  }

  const outcomeTarget = getOutcomeStaffNotifyTarget(conv);
  outcomeTarget.outcome = {
    status: outcome as any,
    note: note || undefined,
    updatedAt: nowIso
  };
  if (conv.appointment) conv.appointment.updatedAt = new Date().toISOString();
  saveConversation(conv);
  await flushConversationStore();
  return res.send("Thanks — your update was saved.");
});

app.post("/public/appointment/outcome/transcribe", upload.single("audio"), async (req, res) => {
  const token = String(req.body?.token ?? "").trim();
  const outcomeRaw = String(req.body?.outcome ?? "").trim();
  if (!token) return res.status(400).json({ ok: false, error: "Missing token" });
  const conv = findConversationByOutcomeToken(token);
  if (!conv) return res.status(404).json({ ok: false, error: "Not found" });
  const file = (req as any).file;
  if (!file?.buffer) return res.status(400).json({ ok: false, error: "Missing audio" });

  const transcript = await transcribeAudioBuffer(file.buffer, file.mimetype);
  if (!transcript) return res.status(500).json({ ok: false, error: "Transcription failed" });

  const allowed = new Set([
    "showed_up",
    "no_show",
    "sold",
    "hold",
    "financing_declined",
    "bought_elsewhere",
    "follow_up",
    "other"
  ]);
  const fallbackStatus = conv.appointment?.staffNotify?.outcome?.status ?? conv.dealerRide?.staffNotify?.outcome?.status ?? "follow_up";
  const status = allowed.has(outcomeRaw) ? outcomeRaw : fallbackStatus;
  const nowIso = new Date().toISOString();
  const unit = readOutcomeUnit(req.body);
  if (status === "hold") {
    const err = await applyOutcomeHold(conv, unit, transcript, nowIso);
    if (err) return res.status(400).json({ ok: false, error: err });
  } else if (status === "sold") {
    const soldById = conv.appointment?.bookedSalespersonId ?? conv.leadOwner?.id ?? "";
    const err = await applyOutcomeSold(conv, unit, transcript, nowIso, soldById, "");
    if (err) return res.status(400).json({ ok: false, error: err });
  } else if (status === "financing_declined") {
    const cfg = await getSchedulerConfigHot();
    conv.followUp = {
      mode: "active",
      reason: "financing_declined",
      updatedAt: nowIso
    };
    conv.followUpCadence = {
      status: "active",
      anchorAt: nowIso,
      nextDueAt: computeFollowUpDueAt(nowIso, LONG_TERM_DAY_OFFSETS[0], cfg.timezone),
      stepIndex: 0,
      kind: "long_term"
    };
  }

  const outcomeTarget = getOutcomeStaffNotifyTarget(conv);
  outcomeTarget.outcome = {
    status: status as any,
    note: transcript,
    updatedAt: nowIso
  };
  if (conv.appointment) conv.appointment.updatedAt = new Date().toISOString();
  saveConversation(conv);
  await flushConversationStore();
  return res.json({ ok: true, transcript, status });
});


app.get("/scheduler/calendars", async (_req, res) => {
  const cal = await getAuthedCalendarClient();
  const resp = await cal.calendarList.list();
  const items = (resp.data.items ?? []).map((c: any) => ({
    id: c.id,
    summary: c.summary,
    primary: !!c.primary
  }));
  res.json({ ok: true, calendars: items });
});

app.get("/calendar/events", requirePermission("canEditAppointments"), async (req, res) => {
  try {
    const start = String(req.query?.start ?? "").trim();
    const end = String(req.query?.end ?? "").trim();
    const idsRaw = String(req.query?.userIds ?? "").trim();
    const timeZone = String(req.query?.timeZone ?? "America/New_York").trim();
    if (!start || !end) {
      return res.status(400).json({ ok: false, error: "Missing start/end" });
    }
    const userIds = idsRaw ? idsRaw.split(",").map(s => s.trim()).filter(Boolean) : [];
    if (userIds.length === 0) {
      return res.json({ ok: true, events: [] });
    }

    const users = await listUsers();
    const byId = new Map(users.map(u => [u.id, u]));
    const cal = await getAuthedCalendarClient();
    const events: any[] = [];

    const parseDescription = (desc?: string | null) => {
      const out: Record<string, string> = {};
      const text = String(desc ?? "");
      for (const line of text.split("\n")) {
        const idx = line.indexOf(":");
        if (idx === -1) continue;
        const key = line.slice(0, idx).trim().toLowerCase();
        const value = line.slice(idx + 1).trim();
        if (!value) continue;
        if (key === "leadkey") out.leadKey = value;
        if (key === "phone") out.phone = value;
        if (key === "email") out.email = value;
        if (key === "stock") out.stock = value;
        if (key === "vin") out.vin = value;
        if (key === "source") out.source = value;
        if (key === "firstname" || key === "first name") out.firstName = value;
        if (key === "lastname" || key === "last name") out.lastName = value;
      }
      return out;
    };
    const parseCustomerName = (summary?: string | null) => {
      const s = String(summary ?? "").trim();
      const parts = s.split("–").map(p => p.trim()).filter(Boolean);
      if (parts.length >= 2 && parts[0].toLowerCase().startsWith("appt")) {
        return parts[1];
      }
      return "";
    };

    for (const userId of userIds) {
      const user = byId.get(userId);
      if (!user?.calendarId) continue;
      const items = await listEvents(cal, user.calendarId, start, end, timeZone);
      for (const ev of items) {
        if (ev?.status === "cancelled") continue;
        const startIso = ev?.start?.dateTime ?? ev?.start?.date ?? null;
        const endIso = ev?.end?.dateTime ?? ev?.end?.date ?? null;
        if (!startIso || !endIso) continue;
        const descFields = parseDescription(ev?.description ?? "");
        const firstName = descFields.firstName ?? "";
        const lastName = descFields.lastName ?? "";
        const fullName = [firstName, lastName].filter(Boolean).join(" ").trim();
        const customerName = parseCustomerName(ev?.summary ?? "");
        events.push({
          id: ev.id,
          calendarId: user.calendarId,
          summary: ev?.summary ?? "",
          description: ev?.description ?? "",
          start: startIso,
          end: endIso,
          colorId: ev?.colorId ?? null,
          salespersonId: userId,
          salespersonName: user.name || user.email || user.id,
          fullName,
          customerName,
          ...descFields
        });
      }
    }

    return res.json({ ok: true, events });
  } catch (err: any) {
    console.log("[calendar] failed to load events:", err?.message ?? err);
    return res.status(500).json({ ok: false, error: err?.message ?? "Failed to load events" });
  }
});

app.post("/calendar/events", requirePermission("canEditAppointments"), async (req, res) => {
  try {
    const calendarId = String(req.body?.calendarId ?? "").trim();
    const summary = String(req.body?.summary ?? "Appointment").trim();
    const startDate = String(req.body?.startDate ?? "").trim();
    const startTime = String(req.body?.startTime ?? "").trim();
    const endDate = String(req.body?.endDate ?? "").trim();
    const endTime = String(req.body?.endTime ?? "").trim();
    const colorId = req.body?.colorId != null ? String(req.body.colorId).trim() : "";
    const tz = String(req.body?.timeZone ?? "America/New_York").trim();

    if (!calendarId || !startDate || !startTime || !endDate || !endTime) {
      return res.status(400).json({ ok: false, error: "Missing calendarId/start/end" });
    }

    const [sy, sm, sd] = startDate.split("-").map(Number);
    const [ey, em, ed] = endDate.split("-").map(Number);
    const [sh, smin] = startTime.split(":").map(Number);
    const [eh, emin] = endTime.split(":").map(Number);

    const start = localPartsToUtcDate(tz, { year: sy, month: sm, day: sd, hour24: sh, minute: smin });
    const end = localPartsToUtcDate(tz, { year: ey, month: em, day: ed, hour24: eh, minute: emin });

    const cal = await getAuthedCalendarClient();
    const event = await insertEvent(
      cal,
      calendarId,
      tz,
      summary,
      "",
      start.toISOString(),
      end.toISOString(),
      colorId || undefined
    );

    return res.json({ ok: true, event });
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: e?.message ?? "Failed to create event" });
  }
});

app.patch("/calendar/events/:calendarId/:eventId", requirePermission("canEditAppointments"), async (req, res) => {
  try {
    console.log("[calendar edit] body", req.body);
    const calendarId = String(req.params.calendarId ?? "").trim();
    const eventId = String(req.params.eventId ?? "").trim();
    if (!calendarId || !eventId) return res.status(400).json({ ok: false, error: "Missing calendarId/eventId" });
    const cfg = await getSchedulerConfigHot();
    console.log("[calendar edit] cfg.timezone", cfg.timezone);
    const tz = typeof cfg.timezone === "string" && cfg.timezone ? cfg.timezone : "America/New_York";
    const startDate = String(req.body?.startDate ?? "").trim(); // YYYY-MM-DD
    const startTime = String(req.body?.startTime ?? "").trim(); // HH:MM
    const endDate = String(req.body?.endDate ?? startDate).trim();
    const endTime = String(req.body?.endTime ?? "").trim();
    const summary = req.body?.summary != null ? String(req.body.summary) : undefined;
    const status = req.body?.status != null ? String(req.body.status) : undefined;
    const newCalendarId = req.body?.calendarId != null ? String(req.body.calendarId).trim() : "";
    const reason = req.body?.reason != null ? String(req.body.reason) : "";
    const colorId = req.body?.colorId != null ? String(req.body.colorId).trim() : undefined;

    let startIso: string | undefined;
    let endIso: string | undefined;
    if (startDate && startTime && endDate && endTime) {
      const [sy, sm, sd] = startDate.split("-").map(Number);
      const [sh, smin] = startTime.split(":").map(Number);
      const [ey, em, ed] = endDate.split("-").map(Number);
      const [eh, emin] = endTime.split(":").map(Number);
      const start = localPartsToUtcDate(tz, { year: sy, month: sm, day: sd, hour24: sh, minute: smin });
      const end = localPartsToUtcDate(tz, { year: ey, month: em, day: ed, hour24: eh, minute: emin });
      startIso = start.toISOString();
      endIso = end.toISOString();
    }

    const description =
      status === "no_show"
        ? `Status: no_show${reason ? `\nReason: ${reason}` : ""}`
        : status === "cancelled"
          ? `Status: cancelled${reason ? `\nReason: ${reason}` : ""}`
          : reason
            ? `Reason: ${reason}`
            : undefined;

    const cal = await getAuthedCalendarClient();
    let targetCalendarId = calendarId;
    if (newCalendarId && newCalendarId !== calendarId) {
      await moveEvent(cal, calendarId, eventId, newCalendarId);
      targetCalendarId = newCalendarId;
    }
    const updated = await updateEventDetails(cal, targetCalendarId, eventId, tz, {
      startIso,
      endIso,
      summary,
      description,
      status: status === "cancelled" ? "cancelled" : undefined,
      colorId
    });
    const nowIso = new Date().toISOString();
    let conversationUpdated = false;
    const salespersonByCalendarId = new Map(
      (cfg.salespeople ?? [])
        .filter(sp => sp?.calendarId)
        .map(sp => [sp.calendarId, sp] as const)
    );
    for (const conv of getAllConversations()) {
      const appt = conv?.appointment;
      if (!appt) continue;
      const currentEventId = String(appt.bookedEventId ?? "").trim();
      if (!currentEventId || currentEventId !== eventId) continue;

      if (status === "cancelled" || status === "no_show") {
        appt.status = "none";
        appt.whenText = undefined;
        appt.whenIso = null;
        appt.confirmedBy = undefined;
        appt.bookedEventId = null;
        appt.bookedEventLink = null;
        appt.bookedSalespersonId = null;
        appt.bookedSalespersonName = null;
        appt.bookedCalendarId = null;
        appt.matchedSlot = undefined;
        appt.reschedulePending = status === "cancelled";
      } else {
        if (startIso) {
          appt.status = "confirmed";
          appt.whenIso = startIso;
          appt.whenText = formatSlotLocal(startIso, tz);
        }
        if (updated?.id) appt.bookedEventId = updated.id;
        if (updated?.htmlLink) appt.bookedEventLink = updated.htmlLink;
        if (targetCalendarId) {
          appt.bookedCalendarId = targetCalendarId;
          const sp = salespersonByCalendarId.get(targetCalendarId);
          if (sp?.id) {
            appt.bookedSalespersonId = sp.id;
            appt.bookedSalespersonName = sp.name ?? appt.bookedSalespersonName ?? null;
          }
        }
        appt.reschedulePending = false;
      }

      appt.updatedAt = nowIso;
      conv.updatedAt = nowIso;
      saveConversation(conv);
      conversationUpdated = true;
    }
    if (conversationUpdated) {
      await flushConversationStore();
    }
    res.json({ ok: true, event: updated });
  } catch (err: any) {
    console.log("[calendar edit] error", err?.message ?? err);
    res.status(500).json({ ok: false, error: err?.message ?? "Failed to update event" });
  }
});

app.post("/scheduler/calendars", requireManager, async (req, res) => {
  const name = String(req.body?.name ?? "").trim();
  if (!name) return res.status(400).json({ ok: false, error: "Missing name" });
  const cfg = await getSchedulerConfigHot();
  const cal = await getAuthedCalendarClient();
  const created = await createCalendar(cal, name, cfg.timezone);
  res.json({ ok: true, calendar: { id: created.id, summary: created.summary, timeZone: created.timeZone } });
});

app.post("/scheduler/availability-blocks", requireManager, async (req, res) => {
  const salespersonId = String(req.body?.salespersonId ?? "").trim();
  const title = String(req.body?.title ?? "").trim();
  const rrule = String(req.body?.rrule ?? "").trim();
  const start = String(req.body?.start ?? "").trim(); // HH:MM
  const end = String(req.body?.end ?? "").trim(); // HH:MM
  const days = Array.isArray(req.body?.days) ? (req.body.days as string[]).map(d => String(d)) : undefined;
  if (!salespersonId || !title || !rrule || !start || !end) {
    return res.status(400).json({ ok: false, error: "Missing salespersonId/title/rrule/start/end" });
  }
  const cfg = await getSchedulerConfigHot();
  const sp =
    (cfg.salespeople ?? []).find(s => s.id === salespersonId) ??
    (cfg.salespeople ?? []).find(s => s.calendarId === salespersonId);
  if (!sp) return res.status(404).json({ ok: false, error: "Salesperson not found" });
  const [sh, sm] = start.split(":").map(Number);
  const [eh, em] = end.split(":").map(Number);
  const cal = await getAuthedCalendarClient();
  const created = await createRecurringBlock(
    cal,
    sp.calendarId,
    cfg.timezone,
    title,
    { hour: sh, minute: sm },
    { hour: eh, minute: em },
    rrule
  );
  const updatedCfg = await saveSchedulerConfig({
    ...(cfg as any),
    availabilityBlocks: {
      ...(cfg.availabilityBlocks ?? {}),
      [salespersonId]: [
        ...((cfg.availabilityBlocks ?? {})[salespersonId] ?? []),
        { id: created.id, title, rrule, start, end, days }
      ]
    }
  });
  res.json({ ok: true, block: { id: created.id, title, rrule, start, end, days }, config: updatedCfg });
});

app.delete("/scheduler/availability-blocks/:salespersonId/:eventId", requireManager, async (req, res) => {
  const salespersonId = String(req.params.salespersonId ?? "").trim();
  const eventId = String(req.params.eventId ?? "").trim();
  const cfg = await getSchedulerConfigHot();
  const sp =
    (cfg.salespeople ?? []).find(s => s.id === salespersonId) ??
    (cfg.salespeople ?? []).find(s => s.calendarId === salespersonId);
  if (!sp) return res.status(404).json({ ok: false, error: "Salesperson not found" });
  const cal = await getAuthedCalendarClient();
  await deleteEvent(cal, sp.calendarId, eventId);
  const remaining = ((cfg.availabilityBlocks ?? {})[salespersonId] ?? []).filter(b => b.id !== eventId);
  const updatedCfg = await saveSchedulerConfig({
    ...(cfg as any),
    availabilityBlocks: {
      ...(cfg.availabilityBlocks ?? {}),
      [salespersonId]: remaining
    }
  });
  res.json({ ok: true, config: updatedCfg });
});

app.get("/scheduler-config", async (_req, res) => {
  const cfg = await getSchedulerConfigHot();
  res.json({ ok: true, config: cfg });
});

app.put("/scheduler-config", requireManager, async (req, res) => {
  const saved = await saveSchedulerConfig(req.body ?? {});
  res.json({ ok: true, config: saved });
});


app.get("/debug/inventory/:stock", async (req, res) => {
  const stock = String(req.params.stock ?? "").trim();
  if (!stock) return res.status(400).json({ ok: false, error: "missing stock" });

  const resolved = await resolveInventoryUrlByStock(stock);
  if (!resolved.ok) return res.json({ ok: true, stock, resolved });

  const status = await checkInventorySalePendingByUrl(resolved.url);
  return res.json({ ok: true, stock, resolved, status });
});

app.get("/debug/inventory-price", async (req, res) => {
  const stock = String(req.query.stock ?? "").trim();
  if (!stock) return res.status(400).json({ ok: false, error: "missing stock" });
  try {
    const result = await findInventoryPrice({ stockId: stock });
    return res.json({ ok: true, stock, result });
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: e?.message ?? "lookup_failed" });
  }
});

app.get("/debug/dealer-profile", async (_req, res) => {
  const profile = await getDealerProfileHot();
  res.json({ ok: true, profile });
});

app.get("/dealer-profile", async (_req, res) => {
  const profile = await getDealerProfileHot();
  res.json({ ok: true, profile });
});

app.get("/models-by-year", async (_req, res) => {
  const modelsByYear = getModelsByYear();
  res.json({ ok: true, modelsByYear });
});

app.post("/dealer-profile/logo", requireManager, upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ ok: false, error: "missing file" });
  const ext = path.extname(req.file.originalname || "").toLowerCase();
  const allowed = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);
  if (!allowed.has(ext)) {
    return res.status(400).json({ ok: false, error: "invalid file type" });
  }
  const fileName = `dealer-logo${ext}`;
  const dir = path.resolve(getDataDir(), "uploads");
  await fs.promises.mkdir(dir, { recursive: true });
  const dest = path.join(dir, fileName);
  await fs.promises.writeFile(dest, req.file.buffer);

  const profile = (await getDealerProfileHot()) ?? {};
  const publicBase = process.env.PUBLIC_BASE_URL ?? "";
  const url = publicBase
    ? `${publicBase.replace(/\/$/, "")}/uploads/${fileName}`
    : `/uploads/${fileName}`;
  const saved = await saveDealerProfile({ ...profile, logoUrl: url });
  res.json({ ok: true, profile: saved, url });
});

app.put("/dealer-profile", requireManager, async (req, res) => {
  console.log("[dealer-profile] save start");
  const incoming = { ...(req.body ?? {}) } as Record<string, any>;
  const bookingUrlRaw = String(incoming.bookingUrl ?? "").trim();
  if (bookingUrlRaw) {
    try {
      const u = new URL(bookingUrlRaw);
      const proto = String(u.protocol ?? "").toLowerCase();
      const pathLower = String(u.pathname ?? "").toLowerCase();
      const invalid =
        (proto !== "http:" && proto !== "https:") ||
        /\/(?:api\/)?auth\/me\/?$/.test(pathLower) ||
        /^\/api\//.test(pathLower);
      if (invalid) {
        delete incoming.bookingUrl;
      } else {
        incoming.bookingUrl = u.toString();
      }
    } catch {
      delete incoming.bookingUrl;
    }
  }
  const current = (await getDealerProfileHot()) ?? {};
  const merged = {
    ...current,
    ...incoming,
    address: {
      ...(current?.address ?? {}),
      ...(incoming?.address ?? {})
    },
    hours:
      incoming?.hours && typeof incoming.hours === "object"
        ? incoming.hours
        : current?.hours,
    policies: {
      ...(current?.policies ?? {}),
      ...(incoming?.policies ?? {})
    },
    voice: {
      ...(current?.voice ?? {}),
      ...(incoming?.voice ?? {})
    },
    followUp: {
      ...(current?.followUp ?? {}),
      ...(incoming?.followUp ?? {})
    },
    weather: {
      ...(current?.weather ?? {}),
      ...(incoming?.weather ?? {})
    },
    buying: {
      ...(current?.buying ?? {}),
      ...(incoming?.buying ?? {})
    }
  };
  const saved = await saveDealerProfile(merged);
  console.log("[dealer-profile] save done");
  res.json({ ok: true, profile: saved });
});

app.post("/inventory/status", (req, res) => {
  const leadKey = String(req.body?.leadKey ?? "").trim();
  const stockId = String(req.body?.stockId ?? "").trim();
  const status = String(req.body?.status ?? "").trim(); // AVAILABLE | PENDING | UNKNOWN
  const url = String(req.body?.url ?? "").trim();

  if (!leadKey || !stockId || !status) {
    return res.status(400).json({ ok: false, error: "Missing leadKey/stockId/status" });
  }

  const conv = getConversation(leadKey);
  if (!conv) return res.status(404).json({ ok: false, error: "Conversation not found" });

  conv.lead = conv.lead ?? {};
  conv.lead.vehicle = conv.lead.vehicle ?? {};
  conv.lead.vehicle.stockId = conv.lead.vehicle.stockId ?? stockId;
  (conv.lead.vehicle as any).url = url || (conv.lead.vehicle as any).url;
  // store status in a simple place; you can formalize later
  (conv.lead.vehicle as any).inventoryStatus = status;

  // also log an internal note into the thread for visibility (optional)
  appendOutbound(conv, "system", leadKey, `Inventory check: ${stockId} => ${status}`, "human");

  return res.json({ ok: true, leadKey, stockId, status, url, conversation: conv });
});

// Inbox endpoints
app.get("/conversations", (req, res) => {
  const user = (req as any).user ?? null;
  const conversations = listConversations().filter(conv => canUserAccessConversation(user, conv));
  res.json({ ok: true, systemMode: getSystemMode(), conversations });
});

app.post("/conversations/compose", (req, res) => {
  const rawPhone = String(req.body?.phone ?? "").trim();
  if (!rawPhone) {
    return res.status(400).json({ ok: false, error: "Missing phone" });
  }
  const firstName = String(req.body?.firstName ?? "").trim() || undefined;
  const lastName = String(req.body?.lastName ?? "").trim() || undefined;
  const email = String(req.body?.email ?? "").trim() || undefined;
  const leadName =
    firstName || lastName ? [firstName, lastName].filter(Boolean).join(" ").trim() : undefined;
  const vehicleInput = req.body?.vehicle ?? null;
  const vehicle = vehicleInput
    ? {
        year: String(vehicleInput.year ?? "").trim() || undefined,
        make: String(vehicleInput.make ?? "").trim() || undefined,
        model: String(vehicleInput.model ?? "").trim() || undefined,
        trim: String(vehicleInput.trim ?? "").trim() || undefined,
        color: String(vehicleInput.color ?? "").trim() || undefined,
        stockId: String(vehicleInput.stockId ?? "").trim() || undefined,
        vin: String(vehicleInput.vin ?? "").trim() || undefined,
        condition: String(vehicleInput.condition ?? "").trim() || undefined
      }
    : null;

  const conv = upsertConversationByLeadKey(rawPhone, "human");
  setConversationMode(conv.id, "human");
  const leadPatch: any = {
    ...(firstName ? { firstName } : {}),
    ...(lastName ? { lastName } : {}),
    ...(leadName ? { name: leadName } : {}),
    ...(email ? { email } : {}),
    phone: normalizePhone(rawPhone)
  };
  if (vehicle && Object.values(vehicle).some(v => v)) {
    leadPatch.vehicle = vehicle;
  }
  mergeConversationLead(conv, leadPatch);
  saveConversation(conv);
  return res.json({ ok: true, conversation: conv });
});

app.get("/conversations/:id", async (req, res) => {
  const conv = getConversation(req.params.id);
  if (!conv) return res.status(404).json({ ok: false, error: "Not found" });
  const user = (req as any).user ?? null;
  if (!canUserAccessConversation(user, conv)) {
    return res.status(403).json({ ok: false, error: "forbidden" });
  }
  const emailDraft = conv.emailDraft ?? null;
  const leadSource = conv.lead?.source ?? null;
  const walkIn = inferWalkIn(conv) ? true : null;
  res.json({
    ok: true,
    systemMode: getSystemMode(),
    conversation: { ...conv, emailDraft, leadSource, walkIn }
  });
});

app.post("/conversations/:id/mode", requirePermission("canToggleHumanOverride"), (req, res) => {
  const conv = getConversation(req.params.id);
  if (!conv) return res.status(404).json({ ok: false, error: "Not found" });
  const mode = String(req.body?.mode ?? "").trim();
  if (mode !== "human" && mode !== "suggest") {
    return res.status(400).json({ ok: false, error: "Invalid mode" });
  }
  setConversationMode(conv.id, mode as any);
  return res.json({ ok: true, conversation: conv });
});

app.post("/conversations/:id/department", requirePermission("canAccessTodos"), (req, res) => {
  const conv = getConversation(req.params.id);
  if (!conv) return res.status(404).json({ ok: false, error: "Not found" });
  const user = (req as any).user ?? null;
  if (!canUserAccessConversation(user, conv)) {
    return res.status(403).json({ ok: false, error: "forbidden" });
  }

  const department = String(req.body?.department ?? "")
    .trim()
    .toLowerCase() as DepartmentRole;
  if (!["service", "parts", "apparel"].includes(department)) {
    return res.status(400).json({ ok: false, error: "Invalid department" });
  }

  const summaryRaw = String(req.body?.summary ?? "").trim();
  const summary = summaryRaw || `${department} request`;

  const ownerIdRaw = String(req.body?.ownerId ?? "").trim();
  const ownerNameRaw = String(req.body?.ownerName ?? "").trim();
  if ((ownerIdRaw || ownerNameRaw) && user?.role !== "manager") {
    return res.status(403).json({ ok: false, error: "manager required to assign owner" });
  }
  const owner =
    ownerIdRaw || ownerNameRaw ? { id: ownerIdRaw || undefined, name: ownerNameRaw || undefined } : undefined;

  conv.classification = {
    ...(conv.classification ?? {}),
    bucket: department,
    cta: `${department}_request`
  };
  if (department === "service") {
    if (getDialogState(conv) === "none") {
      setDialogState(conv, "service_request");
    }
    setDialogState(conv, "service_handoff");
  }

  const hasDepartmentTodo = listOpenTodos().some(t => t.convId === conv.id && t.reason === department);
  if (!hasDepartmentTodo) {
    addTodo(conv, department, summary, undefined, owner);
  }

  setFollowUpMode(conv, "manual_handoff", `${department}_request`);
  stopFollowUpCadence(conv, "manual_handoff");
  stopRelatedCadences(conv, "manual_handoff", { setMode: "manual_handoff" });
  saveConversation(conv);
  return res.json({ ok: true, conversation: conv });
});

app.post("/conversations/:id/contact-preference", (req, res) => {
  const conv = getConversation(req.params.id);
  if (!conv) return res.status(404).json({ ok: false, error: "Not found" });
  const raw = req.body?.contactPreference;
  const pref = raw === null || raw === undefined ? "" : String(raw).trim();
  if (!pref) {
    setContactPreference(conv, null);
    return res.json({ ok: true, conversation: conv });
  }
  if (pref !== "call_only") {
    return res.status(400).json({ ok: false, error: "Invalid contactPreference" });
  }
  setContactPreference(conv, "call_only");
  return res.json({ ok: true, conversation: conv });
});

app.post("/conversations/:id/close", async (req, res) => {
  const conv = getConversation(req.params.id);
  if (!conv) return res.status(404).json({ ok: false, error: "Not found" });
  const reason = String(req.body?.reason ?? "closed").trim() || "closed";
  if (reason === "sold") {
    const nowIso = new Date().toISOString();
    const cfg = await getSchedulerConfigHot();
    const soldById = String(req.body?.soldById ?? "").trim();
    const soldByNameRaw = String(req.body?.soldByName ?? "").trim();
    const soldInput = req.body?.soldUnit ?? null;
    const soldStockId = String(soldInput?.stockId ?? "").trim() || undefined;
    const soldVin = String(soldInput?.vin ?? "").trim() || undefined;
    const soldLabel = String(soldInput?.label ?? "").trim() || undefined;
    const soldNote = String(soldInput?.note ?? "").trim() || undefined;
    const soldKey = soldInput ? normalizeInventorySoldKey(soldStockId, soldVin) : null;
    if (soldInput && !soldKey) {
      return res.status(400).json({ ok: false, error: "Missing sold unit (stockId or VIN)." });
    }
    const salespeople = cfg.salespeople ?? [];
    const sp = soldById ? salespeople.find(s => s.id === soldById) ?? null : null;
    conv.sale = {
      soldAt: nowIso,
      soldById: sp?.id ?? (soldById || undefined),
      soldByName: sp?.name ?? (soldByNameRaw || undefined),
      stockId: soldStockId,
      vin: soldVin,
      label: soldLabel,
      note: soldNote
    };
    conv.status = "closed";
    conv.closedAt = nowIso;
    conv.closedReason = "sold";
    markOpenTodosDoneForConversation(conv.id);
    if (soldKey) {
      const soldEntry = {
        id: soldKey,
        stockId: soldStockId,
        vin: soldVin,
        label: soldLabel,
        note: soldNote,
        leadKey: conv.leadKey,
        convId: conv.id,
        soldAt: nowIso,
        soldById: sp?.id ?? (soldById || undefined),
        soldByName: sp?.name ?? (soldByNameRaw || undefined),
        createdAt: conv.sale?.soldAt ?? nowIso,
        updatedAt: nowIso
      };
      await setInventorySold({ stockId: soldStockId, vin: soldVin, sold: soldEntry });
      await clearInventoryHold(soldStockId, soldVin);
      if (conv.hold?.key && conv.hold.key === soldKey) {
        conv.hold = undefined;
      }
    }
    setFollowUpMode(conv, "active", "post_sale");
    startPostSaleCadence(conv, nowIso, cfg.timezone);
    saveConversation(conv);
    if (conv.lead?.leadRef) {
      try {
        const soldBy = conv.sale?.soldByName || conv.sale?.soldById || "Unknown";
        const soldUnit = conv.sale?.label || conv.sale?.stockId || conv.sale?.vin || "unit";
        const note = `Sold/Delivered: ${soldUnit}. Salesperson: ${soldBy}.`;
        await tlpMarkDealershipVisitDelivered({ leadRef: conv.lead.leadRef, note });
      } catch (err: any) {
        const msg = `TLP delivered step failed for leadRef ${conv.lead.leadRef}. Retry in TLP or update manually.`;
        addInternalQuestion(conv.id, conv.leadKey, msg);
        console.warn("[tlp] delivered mark failed:", err?.message ?? err);
      }
    }
    return res.json({ ok: true, conversation: conv });
  }
  closeConversation(conv, reason);
  stopRelatedCadences(conv, reason, { close: true });
  return res.json({ ok: true, conversation: conv });
});

app.post("/conversations/:id/reopen", (req, res) => {
  const conv = getConversation(req.params.id);
  if (!conv) return res.status(404).json({ ok: false, error: "Not found" });
  conv.status = "open";
  conv.closedAt = undefined;
  conv.closedReason = undefined;
  if (conv.sale) {
    conv.sale = undefined;
  }
  if (conv.followUpCadence?.kind === "post_sale") {
    conv.followUpCadence = undefined;
  }
  if (conv.followUp?.reason === "post_sale") {
    conv.followUp = undefined;
  }
  conv.updatedAt = new Date().toISOString();
  saveConversation(conv);
  return res.json({ ok: true, conversation: conv });
});

app.post("/conversations/:id/appointment", requirePermission("canEditAppointments"), async (req, res) => {
  try {
    const conv = getConversation(req.params.id);
    if (!conv) return res.status(404).json({ ok: false, error: "Not found" });

    const isServiceLead =
      conv.classification?.bucket === "service" || conv.classification?.cta === "service_request";
    if (isServiceLead) {
      return res.status(403).json({ ok: false, error: "Service leads cannot be scheduled here" });
    }

    const cfg = await getSchedulerConfigHot();
    const appointmentTypes = cfg.appointmentTypes ?? { inventory_visit: { durationMinutes: 60 } };
    const rawType = String(req.body?.appointmentType ?? "").trim();
    const appointmentType = rawType || inferAppointmentTypeFromConv(conv) || "inventory_visit";
    const durationMinutes = appointmentTypes[appointmentType]?.durationMinutes ?? 60;

    const date = String(req.body?.date ?? "").trim(); // YYYY-MM-DD
    const time = String(req.body?.time ?? "").trim(); // HH:mm
    if (!date || !time) {
      return res.status(400).json({ ok: false, error: "Missing date/time" });
    }
    const [sy, sm, sd] = date.split("-").map(Number);
    const [sh, smin] = time.split(":").map(Number);
    if (!sy || !sm || !sd || Number.isNaN(sh) || Number.isNaN(smin)) {
      return res.status(400).json({ ok: false, error: "Invalid date/time" });
    }

    const start = localPartsToUtcDate(cfg.timezone, {
      year: sy,
      month: sm,
      day: sd,
      hour24: sh,
      minute: smin
    });
    const end = new Date(start.getTime() + durationMinutes * 60_000);

    const salespeople = cfg.salespeople ?? [];
    const requestedSalespersonId = String(req.body?.salespersonId ?? "").trim();
    let salesperson = salespeople.find((s: any) => s.id === requestedSalespersonId) ?? null;
    if (!salesperson) {
      const user = (req as any).user ?? null;
      salesperson = user ? resolveSalespersonForUser(cfg, user) : null;
    }
    if (!salesperson?.calendarId) {
      return res.status(400).json({ ok: false, error: "Select a salesperson" });
    }

    const startIso = start.toISOString();
    const endIso = end.toISOString();
    const cal = await getAuthedCalendarClient();
    const fb = await queryFreeBusy(cal, [salesperson.calendarId], startIso, endIso, cfg.timezone);
    const busy = (fb.calendars?.[salesperson.calendarId]?.busy ?? []) as any[];
    const blocked = busy.some((b: any) => {
      const bStart = new Date(b.start);
      const bEnd = new Date(b.end);
      return start < bEnd && bStart < end;
    });
    if (blocked) {
      return res.status(409).json({ ok: false, error: "Time is no longer available" });
    }

    const lead = conv.lead ?? {};
    const leadNameRaw = String(lead?.name ?? "").trim();
    const firstName = lead?.firstName ?? "";
    const lastName = lead?.lastName ?? "";
    const leadName =
      leadNameRaw || [firstName, lastName].filter(Boolean).join(" ").trim() || conv.leadKey;
    const summary = `Appt: ${appointmentType} – ${leadName}`.trim();

    const notes = String(req.body?.notes ?? "").trim();
    const descriptionLines = [
      `LeadKey: ${conv.leadKey}`,
      `LeadRef: ${lead?.leadRef ?? ""}`,
      `Phone: ${lead?.phone ?? ""}`,
      `Email: ${lead?.email ?? ""}`,
      `FirstName: ${firstName ?? ""}`,
      `LastName: ${lastName ?? ""}`,
      `Stock: ${lead?.vehicle?.stockId ?? ""}`,
      `VIN: ${lead?.vehicle?.vin ?? ""}`,
      `Source: ${lead?.source ?? ""}`,
      `VisitType: ${appointmentType}`,
      "",
      `Notes: ${notes}`
    ].filter(Boolean);

    const colorId = getAppointmentTypeColorId(cfg, appointmentType);
    const event = await insertEvent(
      cal,
      salesperson.calendarId,
      cfg.timezone,
      summary,
      descriptionLines.join("\n"),
      startIso,
      endIso,
      colorId
    );

    conv.appointment = conv.appointment ?? { status: "none", updatedAt: new Date().toISOString() };
    conv.appointment.status = "confirmed";
    conv.appointment.whenText = formatSlotLocal(startIso, cfg.timezone);
    conv.appointment.whenIso = startIso;
    conv.appointment.confirmedBy = "salesperson";
    conv.appointment.updatedAt = new Date().toISOString();
    conv.appointment.acknowledged = true;
    conv.appointment.bookedEventId = event.id ?? null;
    conv.appointment.bookedEventLink = event.htmlLink ?? null;
    conv.appointment.bookedSalespersonId = salesperson.id ?? null;
    conv.appointment.matchedSlot = {
      salespersonId: salesperson.id,
      salespersonName: salesperson.name,
      calendarId: salesperson.calendarId,
      start: startIso,
      end: endIso,
      startLocal: formatSlotLocal(startIso, cfg.timezone),
      endLocal: formatSlotLocal(endIso, cfg.timezone),
      appointmentType
    };
    conv.appointment.reschedulePending = false;
    setPreferredSalespersonForConv(conv, { id: salesperson.id, name: salesperson.name }, "manual-appointment");
    onAppointmentBooked(conv);
    const smsResult: { sent: boolean; reason?: string; sid?: string } = {
      sent: false,
      reason: "manual_no_notify"
    };

    conv.updatedAt = new Date().toISOString();
    saveConversation(conv);
    await flushConversationStore();

    return res.json({
      ok: true,
      eventId: event.id,
      htmlLink: event.htmlLink,
      salesperson: { id: salesperson.id, name: salesperson.name },
      conversation: conv,
      sms: smsResult
    });
  } catch (err: any) {
    console.log("[manual-appointment] failed:", err?.message ?? err);
    return res.status(500).json({ ok: false, error: err?.message ?? "Failed to book appointment" });
  }
});

app.post("/conversations/:id/followup-action", async (req, res) => {
  try {
    const conv = getConversation(req.params.id);
    if (!conv) return res.status(404).json({ ok: false, error: "Not found" });

    const resolutionRaw = String(req.body?.resolution ?? "resume").trim();
    const resolution = resolutionRaw || "resume";
    const resumeDateRaw = String(req.body?.resumeDate ?? "").trim();
    const watchInput = req.body?.watch ?? null;
    const watchItemsInput = Array.isArray(watchInput?.items) ? watchInput.items : [];
    const watchNote = String(watchInput?.note ?? "").trim();
    const holdInput = req.body?.holdUnit ?? null;
    const holdStockId = String(holdInput?.stockId ?? "").trim() || undefined;
    const holdVin = String(holdInput?.vin ?? "").trim() || undefined;
    const holdLabel = String(holdInput?.label ?? "").trim() || undefined;
    const holdNote = String(holdInput?.note ?? "").trim() || undefined;
    const nowIso = new Date().toISOString();
    const cfg = await getSchedulerConfigHot();
    const tz = cfg.timezone || "America/New_York";
    let cadenceNotice: string | null = null;

    const normalizeInputCondition = (raw?: string | null) => {
      const t = String(raw ?? "").toLowerCase().trim();
      if (!t) return undefined;
      if (/(pre|used|pre-owned|preowned|owned)/.test(t)) return "used";
      if (/new/.test(t)) return "new";
      return undefined;
    };

    const buildWatchList = (): InventoryWatch[] => {
      const createdAt = nowIso;
      const list = watchItemsInput
        .map((item: any) => {
          const model = String(item?.model ?? "").trim();
          if (!model) return null;
          const yearNum = Number(String(item?.year ?? "").trim());
          const year = Number.isFinite(yearNum) && yearNum > 1900 ? yearNum : undefined;
          const budgetSeed = extractWatchBudgetPreference(
            [
              item?.priceRange,
              item?.budget,
              item?.priceBudget,
              item?.monthlyBudget != null ? `${item?.monthlyBudget} monthly` : "",
              item?.termMonths != null ? `${item?.termMonths} months` : "",
              item?.downPayment != null ? `${item?.downPayment} down` : ""
            ]
              .filter(v => String(v ?? "").trim().length > 0)
              .join(" ")
          );
          const minPrice = parseBudgetMoneyInput(item?.minPrice) ?? budgetSeed.minPrice;
          const maxPrice = parseBudgetMoneyInput(item?.maxPrice) ?? budgetSeed.maxPrice;
          const watch: InventoryWatch = {
            model,
            year,
            make: String(item?.make ?? "").trim() || undefined,
            trim: String(item?.trim ?? "").trim() || undefined,
            color: String(item?.color ?? "").trim() || undefined,
            condition: normalizeInputCondition(item?.condition),
            minPrice,
            maxPrice,
            note: watchNote || undefined,
            exactness: "model_only",
            status: "active",
            createdAt
          };
          if (
            watch.minPrice != null &&
            watch.maxPrice != null &&
            Number.isFinite(watch.minPrice) &&
            Number.isFinite(watch.maxPrice) &&
            watch.minPrice > watch.maxPrice
          ) {
            const swap = watch.minPrice;
            watch.minPrice = watch.maxPrice;
            watch.maxPrice = swap;
          }
          if (watch.year && watch.color) watch.exactness = "exact";
          else if (watch.year) watch.exactness = "year_model";
          return watch;
        })
        .filter(Boolean) as InventoryWatch[];
      return list;
    };

    const toResumeIso = (dateStr: string): string | null => {
      if (!dateStr) return null;
      const [sy, sm, sd] = dateStr.split("-").map(Number);
      if (!sy || !sm || !sd) return null;
      const resumeAt = localPartsToUtcDate(tz, {
        year: sy,
        month: sm,
        day: sd,
        hour24: 9,
        minute: 0
      });
      return resumeAt.toISOString();
    };

    const pickUnusedAck = (options: string[]): string | null => {
      const used = new Set(
        (conv.messages ?? [])
          .filter((m: any) => m.direction === "out")
          .map((m: any) => normalizeOutboundText(m.body))
      );
      for (const opt of options) {
        if (!used.has(normalizeOutboundText(opt))) return opt;
      }
      return null;
    };

    const buildCadenceAck = (action: string): string | null => {
      if (action === "resume") {
        return pickUnusedAck([
          "Thanks for the update — let me know if anything changes.",
          "Appreciate the update — if anything changes, just let me know."
        ]);
      }
      if (["pause_7", "pause_30", "pause_indef", "resume_on"].includes(action)) {
        return pickUnusedAck([
          "Sounds good — I’ll be here when you’re ready. If anything changes, just let me know.",
          "No problem — I’ll be here when you’re ready. If anything changes, just let me know."
        ]);
      }
      return null;
    };

    const sendCadenceAck = async (message: string) => {
      const accountSid = process.env.TWILIO_ACCOUNT_SID;
      const authToken = process.env.TWILIO_AUTH_TOKEN;
      const from = process.env.TWILIO_FROM_NUMBER;
      const toNumber = normalizePhone(conv.lead?.phone ?? conv.leadKey ?? "");
      if (
        isRecentDuplicateOutbound(conv, toNumber, message, {
          providers: ["twilio", "human", "draft_ai"],
          windowMs: 10 * 60 * 1000
        })
      ) {
        return { sent: false, reason: "duplicate_suppressed" };
      }
      if (conv.contactPreference === "call_only") {
        return { sent: false, reason: "call_only" };
      }
      if (!toNumber.startsWith("+")) {
        return { sent: false, reason: "invalid_phone" };
      }
      if (isSuppressed(toNumber)) {
        return { sent: false, reason: "suppressed" };
      }
      if (!accountSid || !authToken || !from) {
        appendOutbound(conv, "salesperson", toNumber, message, "human");
        return { sent: false, reason: "twilio_not_configured" };
      }
      try {
        const client = twilio(accountSid, authToken);
        const msg = await client.messages.create({ from, to: toNumber, body: message });
        appendOutbound(conv, from, toNumber, message, "twilio", msg.sid);
        return { sent: true, sid: msg.sid };
      } catch (e: any) {
        appendOutbound(conv, "salesperson", toNumber, message, "human");
        return { sent: false, reason: "send_failed" };
      }
    };

    const ensureCadenceActive = (nextDueAtOverride?: string) => {
      if (!conv.followUpCadence) {
        startFollowUpCadence(conv, nowIso, tz);
      }
      if (!conv.followUpCadence) return;
      if (conv.followUpCadence.status === "stopped") {
        conv.followUpCadence.status = "active";
        conv.followUpCadence.anchorAt = conv.followUpCadence.anchorAt ?? nowIso;
      }
      if (nextDueAtOverride) {
        conv.followUpCadence.nextDueAt = nextDueAtOverride;
      } else if (!conv.followUpCadence.nextDueAt) {
        const idx = Math.min(
          conv.followUpCadence.stepIndex ?? 0,
          FOLLOW_UP_DAY_OFFSETS.length - 1
        );
        conv.followUpCadence.nextDueAt = computeFollowUpDueAt(
          conv.followUpCadence.anchorAt ?? nowIso,
          FOLLOW_UP_DAY_OFFSETS[idx],
          tz
        );
      }
    };

    const applyPauseUntil = (untilIso: string, reason: string) => {
      ensureCadenceActive(untilIso);
      if (conv.followUpCadence) {
        conv.followUpCadence.status = "active";
        conv.followUpCadence.pausedUntil = untilIso;
        conv.followUpCadence.pauseReason = reason;
        conv.followUpCadence.nextDueAt = untilIso;
        conv.followUpCadence.lastSentAt = conv.followUpCadence.lastSentAt ?? nowIso;
      }
    };

    const applyResume = (holdForWatch: boolean) => {
      if (!holdForWatch) {
        setFollowUpMode(conv, "active", "manual_resume");
      }
      ensureCadenceActive();
      if (conv.followUpCadence) {
        conv.followUpCadence.pausedUntil = undefined;
        conv.followUpCadence.pauseReason = undefined;
      }
    };

    const applyPauseDays = (days: number, reason: string) => {
      const untilIso = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
      applyPauseUntil(untilIso, reason);
    };

    const applyPauseIndef = (holdForWatch: boolean) => {
      stopFollowUpCadence(conv, "manual_pause_indef");
      if (!holdForWatch) {
        setFollowUpMode(conv, "paused_indefinite", "manual_pause_indef");
      }
    };

    const watchList = buildWatchList();
    const watchEnabled = watchItemsInput.length > 0;
    if (watchEnabled && watchList.length === 0) {
      return res.status(400).json({ ok: false, error: "At least one watch model is required." });
    }

    const shouldApplyWatch = watchList.length > 0 && resolution !== "archive";

    const holdKey = normalizeInventoryHoldKey(holdStockId, holdVin);
    if (resolution === "hold" && !holdKey) {
      return res.status(400).json({ ok: false, error: "Missing hold unit (stockId or VIN)." });
    }

    if (shouldApplyWatch) {
      conv.inventoryWatches = watchList;
      conv.inventoryWatch = watchList[0];
      conv.inventoryWatchPending = undefined;
      setFollowUpMode(conv, "holding_inventory", "inventory_watch");
      stopFollowUpCadence(conv, "inventory_watch");
    }

    const effectiveResolution =
      shouldApplyWatch && resolution === "resume" ? "pause_7" : resolution;

    const cadenceBlockedByWatch =
      shouldApplyWatch &&
      ["resume", "pause_7", "pause_30", "pause_indef", "resume_on"].includes(effectiveResolution);

    if (cadenceBlockedByWatch) {
      stopFollowUpCadence(conv, "inventory_watch");
      cadenceNotice = "Vehicle watch active — follow-ups paused until a match is found.";
    } else if (effectiveResolution === "archive") {
      stopFollowUpCadence(conv, "manual_archive");
      closeConversation(conv, "manual_archive");
      stopRelatedCadences(conv, "manual_archive", { close: true });
    } else if (effectiveResolution === "appointment_set") {
      stopFollowUpCadence(conv, "manual_appointment");
      setFollowUpMode(conv, "manual_handoff", "manual_appointment");
      stopRelatedCadences(conv, "manual_appointment", { setMode: "manual_handoff" });
    } else if (effectiveResolution === "hold") {
      if (!holdKey) {
        return res.status(400).json({ ok: false, error: "Missing hold unit (stockId or VIN)." });
      }
      const prevKey = conv.hold?.key ?? null;
      if (prevKey && prevKey !== holdKey) {
        await clearInventoryHold(prevKey, null);
      }
      const createdAt = conv.hold?.createdAt ?? nowIso;
      const holdEntry = {
        id: holdKey,
        stockId: holdStockId,
        vin: holdVin,
        label: holdLabel,
        leadKey: conv.leadKey,
        convId: conv.id,
        note: holdNote,
        createdAt,
        updatedAt: nowIso
      };
      await setInventoryHold({ stockId: holdStockId, vin: holdVin, hold: holdEntry });
      conv.hold = {
        key: holdKey,
        stockId: holdStockId,
        vin: holdVin,
        label: holdLabel,
        note: holdNote,
        reason: "unit_hold",
        createdAt,
        updatedAt: nowIso
      };
      stopFollowUpCadence(conv, "unit_hold");
      if (!shouldApplyWatch && conv.followUp?.mode !== "manual_handoff") {
        setFollowUpMode(conv, "paused_indefinite", "unit_hold");
      }
      cadenceNotice = "Unit marked on hold.";
    } else if (effectiveResolution === "hold_clear") {
      const clearKey = holdKey ?? conv.hold?.key ?? null;
      if (clearKey) {
        await clearInventoryHold(clearKey, null);
      }
      conv.hold = undefined;
      if (conv.followUpCadence?.stopReason === "unit_hold") {
        conv.followUpCadence.stopReason = undefined;
      }
      if (!shouldApplyWatch && conv.followUp?.reason === "unit_hold") {
        setFollowUpMode(conv, "active", "manual_hold_clear");
      }
      applyResume(shouldApplyWatch);
      cadenceNotice = "Unit hold removed.";
    } else if (effectiveResolution === "pause_indef") {
      applyPauseIndef(shouldApplyWatch);
    } else if (effectiveResolution === "pause_7" || effectiveResolution === "pause_30") {
      if (!shouldApplyWatch) {
        setFollowUpMode(conv, "active", "manual_pause");
      }
      const days = effectiveResolution === "pause_7" ? 7 : 30;
      applyPauseDays(days, "manual_pause");
    } else if (effectiveResolution === "resume_on") {
      const resumeIso = toResumeIso(resumeDateRaw);
      if (!resumeIso) {
        return res.status(400).json({ ok: false, error: "Missing or invalid resume date." });
      }
      if (!shouldApplyWatch) {
        setFollowUpMode(conv, "active", "manual_pause");
      }
      applyPauseUntil(resumeIso, "manual_pause");
      cadenceNotice = `Follow-ups paused until ${formatSlotLocal(resumeIso, tz)}.`;
    } else {
      applyResume(shouldApplyWatch);
    }

    if (!cadenceNotice) {
      if (effectiveResolution === "resume") cadenceNotice = "Follow-ups resumed.";
      else if (effectiveResolution === "hold") cadenceNotice = "Unit marked on hold.";
      else if (effectiveResolution === "hold_clear") cadenceNotice = "Unit hold removed.";
      else if (effectiveResolution === "pause_7") cadenceNotice = "Follow-ups paused for 7 days.";
      else if (effectiveResolution === "pause_30") cadenceNotice = "Follow-ups paused for 30 days.";
      else if (effectiveResolution === "pause_indef") cadenceNotice = "Follow-ups paused indefinitely.";
    }

    if (shouldApplyWatch && !["archive", "appointment_set"].includes(effectiveResolution)) {
      setFollowUpMode(conv, "holding_inventory", "inventory_watch");
    }

    if (effectiveResolution === "resume") {
      setDialogState(conv, "followup_resumed");
    } else if (
      effectiveResolution === "hold" ||
      effectiveResolution === "pause_7" ||
      effectiveResolution === "pause_30" ||
      effectiveResolution === "pause_indef" ||
      effectiveResolution === "resume_on"
    ) {
      setDialogState(conv, "followup_paused");
    }

    let cadenceAckResult: { sent: boolean; reason?: string; sid?: string } | null = null;
    const cadenceAck =
      effectiveResolution === "hold" || shouldApplyWatch
        ? null
        : buildCadenceAck(effectiveResolution);
    if (cadenceAck) {
      cadenceAckResult = await sendCadenceAck(cadenceAck);
    }

    if (shouldApplyWatch) {
      await processInventoryWatchlist(conv.id);
    }
    saveConversation(conv);
    await flushConversationStore();
    return res.json({ ok: true, conversation: conv, notice: cadenceNotice, cadenceAck: cadenceAckResult });
  } catch (err: any) {
    console.log("[followup-action] failed:", err?.message ?? err);
    return res.status(500).json({ ok: false, error: err?.message ?? "Failed to update follow-ups" });
  }
});

app.post("/conversations/:id/watch", async (req, res) => {
  try {
    const conv = getConversation(req.params.id);
    if (!conv) return res.status(404).json({ ok: false, error: "Not found" });

    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    const note = String(req.body?.note ?? "").trim();
    if (!items.length) {
      return res.status(400).json({ ok: false, error: "At least one watch model is required." });
    }
    const nowIso = new Date().toISOString();
    const cfg = await getSchedulerConfigHot();
    const tz = cfg.timezone || "America/New_York";

    const normalizeInputCondition = (raw?: string | null) => {
      const t = String(raw ?? "").toLowerCase().trim();
      if (!t) return undefined;
      if (/(pre|used|pre-owned|preowned|owned)/.test(t)) return "used";
      if (/new/.test(t)) return "new";
      return undefined;
    };

    const parseYearInput = (raw?: string | null) => {
      const t = String(raw ?? "").trim();
      if (!t) return {};
      const range = t.match(/(\d{4})\s*[-–]\s*(\d{4})/);
      if (range) {
        const min = Number(range[1]);
        const max = Number(range[2]);
        if (Number.isFinite(min) && Number.isFinite(max)) {
          return { yearMin: min, yearMax: max };
        }
      }
      const year = Number(t);
      if (Number.isFinite(year) && year > 1900) {
        return { year };
      }
      return {};
    };

    const parseTermMonthsInput = (raw?: unknown): number | undefined => {
      const n = Number(String(raw ?? "").trim());
      if (!Number.isFinite(n) || n <= 0) return undefined;
      return Math.round(n);
    };

    const watchList: InventoryWatch[] = items
      .map((item: any) => {
        const model = canonicalizeWatchModelLabel(item?.model);
        if (!model) return null;
        const yearMin =
          Number(String(item?.yearMin ?? "").trim()) || undefined;
        const yearMax =
          Number(String(item?.yearMax ?? "").trim()) || undefined;
        const parsedYear = parseYearInput(item?.year);
        const year = parsedYear.year;
        const budgetSeed = extractWatchBudgetPreference(
          [
            item?.priceRange,
            item?.budget,
            item?.priceBudget,
            item?.monthlyBudget != null ? `${item?.monthlyBudget} monthly` : "",
            item?.termMonths != null ? `${item?.termMonths} months` : "",
            item?.downPayment != null ? `${item?.downPayment} down` : ""
          ]
            .filter(v => String(v ?? "").trim().length > 0)
            .join(" ")
        );
        const minPrice = parseBudgetMoneyInput(item?.minPrice) ?? budgetSeed.minPrice;
        const maxPrice = parseBudgetMoneyInput(item?.maxPrice) ?? budgetSeed.maxPrice;
        const monthlyBudget = parseBudgetMoneyInput(item?.monthlyBudget) ?? budgetSeed.monthlyBudget;
        const termMonths = parseTermMonthsInput(item?.termMonths) ?? budgetSeed.termMonths;
        const downPayment = parseBudgetMoneyInput(item?.downPayment) ?? budgetSeed.downPayment;
        const watch: InventoryWatch = {
          model,
          year,
          yearMin: parsedYear.yearMin ?? yearMin,
          yearMax: parsedYear.yearMax ?? yearMax,
          make: String(item?.make ?? "").trim() || undefined,
          trim: String(item?.trim ?? "").trim() || undefined,
          color: String(item?.color ?? "").trim() || undefined,
          condition: normalizeInputCondition(item?.condition),
          minPrice,
          maxPrice,
          monthlyBudget,
          termMonths,
          downPayment,
          note: note || undefined,
          exactness: "model_only",
          status: "active",
          createdAt: nowIso
        };
        if (
          watch.minPrice != null &&
          watch.maxPrice != null &&
          Number.isFinite(watch.minPrice) &&
          Number.isFinite(watch.maxPrice) &&
          watch.minPrice > watch.maxPrice
        ) {
          const swap = watch.minPrice;
          watch.minPrice = watch.maxPrice;
          watch.maxPrice = swap;
        }
        if (watch.yearMin && watch.yearMax) watch.exactness = "model_range";
        else if (watch.year && watch.color) watch.exactness = "exact";
        else if (watch.year) watch.exactness = "year_model";
        return watch;
      })
      .filter(Boolean) as InventoryWatch[];

    if (!watchList.length) {
      return res.status(400).json({ ok: false, error: "At least one watch model is required." });
    }

    conv.inventoryWatches = watchList;
    conv.inventoryWatch = watchList[0];
    conv.inventoryWatchPending = undefined;
    setFollowUpMode(conv, "holding_inventory", "inventory_watch");
    stopFollowUpCadence(conv, "inventory_watch");
    setDialogState(conv, "inventory_watch_active");
    conv.updatedAt = nowIso;
    await processInventoryWatchlist(conv.id);
    saveConversation(conv);
    await flushConversationStore();
    return res.json({ ok: true, conversation: conv });
  } catch (err: any) {
    console.log("[watch-update] failed:", err?.message ?? err);
    return res.status(500).json({ ok: false, error: err?.message ?? "Failed to update watch" });
  }
});

app.delete("/conversations/:id/watch", async (req, res) => {
  try {
    const conv = getConversation(req.params.id);
    if (!conv) return res.status(404).json({ ok: false, error: "Not found" });
    await clearInventoryWatchState(conv);
    saveConversation(conv);
    await flushConversationStore();
    return res.json({ ok: true, conversation: conv });
  } catch (err: any) {
    console.log("[watch-delete] failed:", err?.message ?? err);
    return res.status(500).json({ ok: false, error: err?.message ?? "Failed to delete watch" });
  }
});

app.delete("/conversations/:id", (req, res) => {
  const id = req.params.id;
  const ok = deleteConversation(id);
  if (!ok) return res.status(404).json({ ok: false, error: "Not found" });
  return res.json({ ok: true });
});

app.get("/todos", requirePermission("canAccessTodos"), (req, res) => {
  const user = (req as any).user ?? null;
  const isManager = user?.role === "manager";
  const isSalesperson = user?.role === "salesperson";
  const departmentRole =
    user?.role === "service" || user?.role === "parts" || user?.role === "apparel"
      ? (user.role as DepartmentRole)
      : null;
  const requesterId = String(user?.id ?? "").trim();
  const extractNameFromSummary = (summary?: string | null) => {
    const text = String(summary ?? "");
    const match =
      text.match(/\bName:\s*([A-Za-z][^\n,]*)/i) ||
      text.match(/\bCustomer:\s*([A-Za-z][^\n,]*)/i) ||
      text.match(/\bLead:\s*([A-Za-z][^\n,]*)/i);
    const raw = match?.[1]?.trim() ?? "";
    if (!raw) return null;
    const cleaned = raw.replace(/\s{2,}/g, " ").trim();
    return cleaned || null;
  };
  const todos = listOpenTodos()
    .filter(t => {
      if (isManager) return true;
      const conv = getConversation(t.convId);
      const todoDepartment = inferTodoDepartment(t, conv);
      if (departmentRole) return todoDepartment === departmentRole;
      if (isSalesperson) {
        if (todoDepartment) return false;
        const ownerId = String(t.ownerId ?? "").trim();
        if (!ownerId) return true;
        if (requesterId && ownerId === requesterId) return true;
        const leadOwnerId = String(conv?.leadOwner?.id ?? "").trim();
        return !!requesterId && !!leadOwnerId && leadOwnerId === requesterId;
      }
      if (todoDepartment) return false;
      if (!requesterId) return false;
      if (t.ownerId) return t.ownerId === requesterId;
      return conv?.leadOwner?.id === requesterId;
    })
    .map(t => {
      const conv = getConversation(t.convId);
      const leadNameRaw = conv?.lead?.name?.trim() ?? "";
      const firstName = conv?.lead?.firstName ?? "";
      const lastName = conv?.lead?.lastName ?? "";
      const leadName =
        leadNameRaw ||
        [firstName, lastName].filter(Boolean).join(" ").trim() ||
        extractNameFromSummary(t.summary) ||
        null;
      return { ...t, leadName };
    });
  res.json({ ok: true, todos });
});

app.post("/todos", requirePermission("canAccessTodos"), (req, res) => {
  const convId = String(req.body?.convId ?? "").trim();
  const summary = String(req.body?.summary ?? "").trim();
  const reasonRaw = String(req.body?.reason ?? "other").trim();
  if (!convId || !summary) {
    return res.status(400).json({ ok: false, error: "Missing convId/summary" });
  }
  const conv = getConversation(convId);
  if (!conv) return res.status(404).json({ ok: false, error: "Not found" });
  const user = (req as any).user ?? null;
  if (!canUserAccessConversation(user, conv)) {
    return res.status(403).json({ ok: false, error: "forbidden" });
  }
  const allowedReasons: Array<
    | "pricing"
    | "payments"
    | "approval"
    | "manager"
    | "service"
    | "parts"
    | "apparel"
    | "call"
    | "note"
    | "other"
  > = ["pricing", "payments", "approval", "manager", "service", "parts", "apparel", "call", "note", "other"];
  const reason = allowedReasons.includes(reasonRaw as any)
    ? (reasonRaw as any)
    : "other";
  const ownerId = user?.role === "manager" ? "" : String(user?.id ?? "").trim();
  const ownerName = String(user?.name ?? user?.email ?? "").trim();
  const task = addTodo(
    conv,
    reason,
    summary,
    undefined,
    ownerId ? { id: ownerId, name: ownerName || undefined } : undefined
  );
  if (!task) {
    return res.status(200).json({
      ok: true,
      skipped: true,
      reason: "sold_lead_only_allows_call_todo",
      conversation: conv
    });
  }
  saveConversation(conv);
  return res.json({ ok: true, todo: task, conversation: conv });
});

app.post("/todos/:convId/:todoId/done", requirePermission("canAccessTodos"), (req, res) => {
  const { convId, todoId } = req.params;
  const user = (req as any).user ?? null;
  const convForAccess = getConversation(convId);
  if (convForAccess && !canUserAccessConversation(user, convForAccess)) {
    return res.status(403).json({ ok: false, error: "forbidden" });
  }
  const existingTask = listOpenTodos().find(t => t.id === todoId && t.convId === convId);
  if (existingTask && user?.role !== "manager") {
    const taskDepartment = inferTodoDepartment(existingTask, convForAccess ?? getConversation(convId));
    if (taskDepartment) {
      if (String(user?.role ?? "").toLowerCase() !== taskDepartment) {
        return res.status(403).json({ ok: false, error: "forbidden" });
      }
    } else {
      if (user?.role === "salesperson") {
        const requesterId = String(user?.id ?? "").trim();
        const ownerId = String(existingTask.ownerId ?? "").trim();
        if (!ownerId) {
          // Unassigned sales todos are shared across all salespeople.
        } else if (requesterId && ownerId === requesterId) {
          // Todo explicitly assigned to this salesperson.
        } else {
          const convForOwner = convForAccess ?? getConversation(convId);
          const leadOwnerId = String(convForOwner?.leadOwner?.id ?? "").trim();
          if (!requesterId || !leadOwnerId || leadOwnerId !== requesterId) {
            return res.status(403).json({ ok: false, error: "forbidden" });
          }
        }
      } else {
      const requesterId = String(user?.id ?? "").trim();
      const ownerId = String(existingTask.ownerId ?? "").trim();
      if (ownerId && ownerId !== requesterId) {
        return res.status(403).json({ ok: false, error: "forbidden" });
      }
      if (!ownerId) {
        const convForOwner = getConversation(convId);
        const fallbackOwner = String(convForOwner?.leadOwner?.id ?? "").trim();
        if (fallbackOwner && fallbackOwner !== requesterId) {
          return res.status(403).json({ ok: false, error: "forbidden" });
        }
      }
      }
    }
  }
  const task = markTodoDone(convId, todoId);
  const conv = getConversation(convId);
  if (conv) {
    const resolution = String(req.body?.resolution ?? "resume").trim();
    const nowIso = new Date().toISOString();
    if (resolution === "resume") {
      setFollowUpMode(conv, "active", "todo_done");
    } else if (resolution === "dismiss") {
      // No follow-up changes; just close the todo.
    } else if (resolution === "pause_7" || resolution === "pause_30") {
      setFollowUpMode(conv, "active", "todo_pause");
      const days = resolution === "pause_7" ? 7 : 30;
      if (conv.followUpCadence) {
        conv.followUpCadence.status = "active";
        conv.followUpCadence.nextDueAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
        conv.followUpCadence.lastSentAt = conv.followUpCadence.lastSentAt ?? nowIso;
      }
    } else if (resolution === "pause_indef") {
      setFollowUpMode(conv, "manual_handoff", "todo_pause_indef");
      stopRelatedCadences(conv, "todo_pause_indef", { setMode: "manual_handoff" });
    } else if (resolution === "archive") {
      stopFollowUpCadence(conv, "manual_archive");
      closeConversation(conv, "manual_archive");
      stopRelatedCadences(conv, "manual_archive", { close: true });
    } else if (resolution === "appointment_set") {
      stopFollowUpCadence(conv, "manual_appointment");
      setFollowUpMode(conv, "manual_handoff", "manual_appointment");
      stopRelatedCadences(conv, "manual_appointment", { setMode: "manual_handoff" });
    } else {
      setFollowUpMode(conv, "active", "todo_done");
    }
  }
  if (!task) return res.status(404).json({ ok: false, error: "Todo not found" });
  res.json({ ok: true, todo: task });
});

app.get("/questions", (_req, res) => {
  res.json({ ok: true, questions: listOpenQuestions() });
});

app.post("/questions", (req, res) => {
  const convId = String(req.body?.convId ?? "").trim();
  const text = String(req.body?.text ?? "").trim();
  if (!convId || !text) return res.status(400).json({ ok: false, error: "Missing convId/text" });
  const conv = getConversation(convId);
  const leadKey = conv?.leadKey ?? convId;
  const q = addInternalQuestion(convId, leadKey, text);
  res.json({ ok: true, question: q });
});

app.post("/questions/:convId/:questionId/done", (req, res) => {
  const { convId, questionId } = req.params;
  const outcome = String(req.body?.outcome ?? "").trim() || undefined;
  const followUpAction = String(req.body?.followUpAction ?? "").trim() || undefined;
  const q = markQuestionDone(convId, questionId, outcome, followUpAction);
  if (!q) return res.status(404).json({ ok: false, error: "Question not found" });

  const conv = getConversation(convId);
  if (!conv) return res.status(404).json({ ok: false, error: "Conversation not found" });
  const nowIso = new Date().toISOString();
  const applyAction = async (action?: string) => {
    const cfg = await getSchedulerConfigHot();
    const tz = cfg.timezone || "America/New_York";
    if (!action || action === "none") return;
    if (action === "archive") {
      stopFollowUpCadence(conv, "attendance_archive");
      closeConversation(conv, "attendance_archive");
      return;
    }
    if (action === "pause_indef") {
      stopFollowUpCadence(conv, "attendance_pause_indef");
      setFollowUpMode(conv, "paused_indefinite", "attendance_pause_indef");
      return;
    }
    if (action === "pause_24h" || action === "pause_72h") {
      if (!conv.followUpCadence || conv.followUpCadence.status === "stopped") {
        startFollowUpCadence(conv, nowIso, tz);
      }
      const hours = action === "pause_24h" ? 24 : 72;
      const until = new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
      pauseFollowUpCadence(conv, until, "attendance_pause");
      return;
    }
    if (action === "resume") {
      setFollowUpMode(conv, "active", "attendance_resume");
      if (!conv.followUpCadence || conv.followUpCadence.status === "stopped") {
        startFollowUpCadence(conv, nowIso, tz);
      } else if (conv.followUpCadence.pausedUntil) {
        conv.followUpCadence.pausedUntil = undefined;
        conv.followUpCadence.pauseReason = undefined;
      }
      if (conv.followUp) {
        conv.followUp.skipNextCheckin = true;
        conv.followUp.updatedAt = nowIso;
      }
    }
  };

  const derivedAction = () => {
    if (followUpAction) return followUpAction;
    if (!outcome) return undefined;
    if (outcome === "sold") return "archive";
    if (outcome === "hold") return "pause_indef";
    if (outcome === "undecided") return "resume";
    if (outcome === "no_show") return "pause_72h";
    return undefined;
  };

  void applyAction(derivedAction());
  res.json({ ok: true, question: q });
});

app.get("/suppressions", requirePermission("canAccessSuppressions"), (_req, res) => {
  res.json({ ok: true, suppressions: listSuppressions() });
});

function extractInquiryFromAdf(body?: string): string | undefined {
  if (!body) return undefined;
  const idx = body.toLowerCase().lastIndexOf("inquiry:");
  if (idx === -1) return undefined;
  return body.slice(idx + "inquiry:".length).trim() || undefined;
}

function normalizeContactText(value?: string | null): string {
  return String(value ?? "").trim().toLowerCase();
}

function normalizeContactCondition(value?: string | null): string {
  const t = normalizeContactText(value);
  if (!t) return "";
  if (/(pre|used|pre-owned|preowned|owned)/.test(t)) return "used";
  if (/new/.test(t)) return "new";
  return t;
}

function findConversationForContact(input: {
  conversationId?: string;
  leadKey?: string;
  phone?: string;
  email?: string;
}): any | null {
  const phone = input.phone ? normalizePhone(String(input.phone)) : "";
  const email = normalizeContactText(input.email);
  const candidates = Array.from(
    new Set(
      [input.conversationId, input.leadKey, phone, email]
        .map(v => String(v ?? "").trim())
        .filter(Boolean)
    )
  );
  for (const key of candidates) {
    const conv = getConversation(key);
    if (conv) return conv;
  }
  const all = listConversations() as any[];
  return (
    all.find(conv => {
      const leadPhone = normalizePhone(String(conv?.lead?.phone ?? ""));
      const leadEmail = normalizeContactText(conv?.lead?.email);
      const leadKey = String(conv?.leadKey ?? "").trim();
      if (phone && (leadPhone === phone || leadKey === phone)) return true;
      if (email && (leadEmail === email || leadKey === email)) return true;
      return false;
    }) ?? null
  );
}

function syncContactIntoConversation(contact: {
  id?: string;
  leadKey?: string;
  conversationId?: string;
  phone?: string;
  email?: string;
  firstName?: string;
  lastName?: string;
  name?: string;
}): any {
  const conv = findConversationForContact(contact);
  if (!conv) return contact;
  updateConversationContact(conv, {
    phone: contact.phone,
    email: contact.email,
    firstName: contact.firstName,
    lastName: contact.lastName,
    name: contact.name
  });
  saveConversation(conv);
  const contactId = String(contact.id ?? "").trim();
  if (
    contactId &&
    (String(contact.conversationId ?? "") !== String(conv.id ?? "") ||
      String(contact.leadKey ?? "") !== String(conv.leadKey ?? ""))
  ) {
    const patched = updateContact(contactId, {
      conversationId: conv.id,
      leadKey: conv.leadKey
    });
    if (patched) {
      return patched;
    }
  }
  return contact;
}

function buildContactsView() {
  return listContacts().map(c => {
    const convId = c.conversationId ?? c.leadKey;
    const conv = convId ? getConversation(convId) : null;
    const archived = !!(conv?.closedReason && /archive/i.test(conv.closedReason));
    const suppressed = c.phone ? isSuppressed(c.phone) : c.leadKey ? isSuppressed(c.leadKey) : false;
    const status = suppressed ? "suppressed" : archived ? "archived" : "active";
    const lastAdf = conv?.messages
      ?.slice()
      .reverse()
      .find(m => m.direction === "in" && m.provider === "sendgrid_adf");
    const inquiry = extractInquiryFromAdf(lastAdf?.body);
    const stockId = c.stockId ?? conv?.lead?.vehicle?.stockId;
    const condition =
      c.condition ??
      conv?.lead?.vehicle?.condition ??
      (stockId ? (/^u/i.test(stockId) ? "used" : "new") : undefined);
    return {
      ...c,
      stockId,
      vin: c.vin ?? conv?.lead?.vehicle?.vin,
      year: c.year ?? conv?.lead?.vehicle?.year,
      make: c.make ?? conv?.lead?.vehicle?.make,
      vehicle: c.vehicle ?? conv?.lead?.vehicle?.model,
      model: c.model ?? c.vehicle ?? conv?.lead?.vehicle?.model,
      trim: c.trim ?? conv?.lead?.vehicle?.trim,
      color: c.color ?? conv?.lead?.vehicle?.color,
      condition,
      vehicleDescription:
        c.vehicleDescription ?? conv?.lead?.vehicle?.description ?? conv?.lead?.vehicle?.model,
      inquiry: c.inquiry ?? inquiry,
      status
    };
  });
}

function contactMatchesListFilter(
  contact: any,
  filter?: { condition?: string; year?: string; make?: string; model?: string } | null
): boolean {
  if (!filter) return true;
  const condition = normalizeContactCondition(filter.condition);
  const year = normalizeContactText(filter.year);
  const make = normalizeContactText(filter.make);
  const model = normalizeContactText(filter.model);

  if (condition) {
    const rowCondition = normalizeContactCondition(contact.condition);
    if (condition === "used" && rowCondition !== "used") return false;
    if (condition === "new" && rowCondition !== "new") return false;
    if (!["new", "used"].includes(condition) && rowCondition !== condition) return false;
  }
  if (year) {
    const rowYear = normalizeContactText(contact.year);
    if (rowYear !== year) return false;
  }
  if (make) {
    const rowMake = normalizeContactText(contact.make);
    if (!rowMake.includes(make)) return false;
  }
  if (model) {
    const rowModel = normalizeContactText(contact.model ?? contact.vehicle);
    if (!rowModel.includes(model)) return false;
  }
  return true;
}

function resolveContactIdsForList(list: any, contacts: any[]): string[] {
  const byId = new Set(contacts.map(c => String(c.id)));
  const explicitIds = Array.isArray(list?.contactIds)
    ? list.contactIds.map((v: any) => String(v ?? "").trim()).filter(Boolean)
    : [];
  const filteredIds =
    list?.filter
      ? contacts.filter(c => contactMatchesListFilter(c, list.filter)).map(c => String(c.id))
      : [];
  return Array.from(
    new Set([...explicitIds, ...filteredIds].filter(id => byId.has(id)))
  );
}

app.get("/contacts", (_req, res) => {
  const contacts = buildContactsView();
  res.json({ ok: true, contacts });
});

app.post("/contacts", (req, res) => {
  const firstName = String(req.body?.firstName ?? "").trim() || undefined;
  const lastName = String(req.body?.lastName ?? "").trim() || undefined;
  const name =
    String(req.body?.name ?? "").trim() ||
    [firstName, lastName].filter(Boolean).join(" ").trim() ||
    undefined;
  const phoneRaw = String(req.body?.phone ?? "").trim();
  const email = String(req.body?.email ?? "").trim() || undefined;
  const phone = phoneRaw ? normalizePhone(phoneRaw) : undefined;
  if (!phone && !email) {
    return res.status(400).json({ ok: false, error: "Phone or email required" });
  }
  const leadKey = phone || email;
  let contact = upsertContact({
    leadKey,
    conversationId: leadKey,
    firstName,
    lastName,
    name,
    phone,
    email
  });
  contact = syncContactIntoConversation(contact);
  return res.json({ ok: true, contact });
});

app.get("/contacts/lists", (_req, res) => {
  const contacts = buildContactsView();
  const lists = listContactLists().map(list => {
    const contactIds = resolveContactIdsForList(list, contacts);
    return {
      ...list,
      contactIds,
      contactCount: contactIds.length
    };
  });
  res.json({ ok: true, lists });
});

app.post("/contacts/lists", requireManager, (req, res) => {
  const name = String(req.body?.name ?? "").trim();
  if (!name) return res.status(400).json({ ok: false, error: "Missing name" });
  const created = createContactList({
    name,
    source: req.body?.source,
    contactIds: Array.isArray(req.body?.contactIds) ? req.body.contactIds : [],
    filter: req.body?.filter ?? undefined
  });
  return res.json({ ok: true, list: created });
});

app.patch("/contacts/lists/:id", requireManager, (req, res) => {
  const patched = updateContactList(req.params.id, {
    name: req.body?.name,
    source: req.body?.source,
    contactIds: Array.isArray(req.body?.contactIds) ? req.body.contactIds : undefined,
    filter: req.body?.filter,
    lastImportAt: req.body?.lastImportAt
  });
  if (!patched) return res.status(404).json({ ok: false, error: "Not found" });
  return res.json({ ok: true, list: patched });
});

app.delete("/contacts/lists/:id", requireManager, (req, res) => {
  const ok = deleteContactList(req.params.id);
  if (!ok) return res.status(404).json({ ok: false, error: "Not found" });
  return res.json({ ok: true });
});

app.post("/contacts/import", requireManager, (req, res) => {
  const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
  if (!rows.length) return res.status(400).json({ ok: false, error: "Missing rows" });

  const importedIds: string[] = [];
  for (const row of rows) {
    const firstName = String(row?.firstName ?? "").trim() || undefined;
    const lastName = String(row?.lastName ?? "").trim() || undefined;
    const name = String(row?.name ?? "").trim() || [firstName, lastName].filter(Boolean).join(" ").trim() || undefined;
    const phone = String(row?.phone ?? "").trim() || undefined;
    const email = String(row?.email ?? "").trim() || undefined;
    if (!phone && !email) continue;
    const leadKey = phone ? normalizePhone(phone) : email;
    let contact = upsertContact({
      leadKey,
      conversationId: leadKey,
      firstName,
      lastName,
      name,
      phone,
      email
    });
    contact = syncContactIntoConversation(contact);
    importedIds.push(contact.id);
  }

  const uniqImported = Array.from(new Set(importedIds));
  let list: any = null;
  const listId = String(req.body?.listId ?? "").trim();
  const listName = String(req.body?.listName ?? "").trim();
  if (listId) {
    list = addContactsToList(listId, uniqImported);
  } else if (listName) {
    list = createContactList({
      name: listName,
      source: "csv",
      contactIds: uniqImported
    });
  }

  return res.json({
    ok: true,
    imported: uniqImported.length,
    list
  });
});

app.post("/contacts/broadcast", requireManager, async (req, res) => {
  const listId = String(req.body?.listId ?? "").trim();
  const message = String(req.body?.message ?? "").trim();
  if (!listId) return res.status(400).json({ ok: false, error: "Missing listId" });
  if (!message) return res.status(400).json({ ok: false, error: "Missing message" });

  const list = getContactList(listId);
  if (!list) return res.status(404).json({ ok: false, error: "List not found" });

  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const fromRaw = String(process.env.TWILIO_FROM_NUMBER ?? "").trim();
  const from = normalizePhone(fromRaw);
  if (!accountSid || !authToken || !from || !from.startsWith("+")) {
    return res.status(500).json({ ok: false, error: "Twilio not configured" });
  }

  const contacts = buildContactsView();
  const recipientIds = resolveContactIdsForList(list, contacts);
  const recipients = contacts.filter(c => recipientIds.includes(String(c.id)));
  const twilioClient = twilio(accountSid, authToken);

  const sent: Array<{ id: string; phone: string; sid?: string }> = [];
  const skipped: Array<{ id: string; reason: string }> = [];
  const failed: Array<{ id: string; error: string }> = [];

  for (const contact of recipients) {
    const phone = normalizePhone(String(contact.phone ?? "").trim());
    if (!phone || !phone.startsWith("+")) {
      skipped.push({ id: String(contact.id), reason: "missing_phone" });
      continue;
    }
    if (isSuppressed(phone)) {
      skipped.push({ id: String(contact.id), reason: "suppressed" });
      continue;
    }
    try {
      const out = await twilioClient.messages.create({
        from,
        to: phone,
        body: message
      });
      const leadKey = String(contact.leadKey ?? contact.conversationId ?? phone);
      const conv = upsertConversationByLeadKey(leadKey, "suggest");
      updateConversationContact(conv, {
        firstName: contact.firstName,
        lastName: contact.lastName,
        name: contact.name,
        phone,
        email: contact.email
      });
      appendOutbound(conv, from, phone, message, "twilio", out.sid ?? undefined);
      conv.updatedAt = new Date().toISOString();
      saveConversation(conv);
      sent.push({ id: String(contact.id), phone, sid: out.sid });
    } catch (err: any) {
      failed.push({ id: String(contact.id), error: err?.message ?? "send_failed" });
    }
  }

  if (sent.length) {
    await flushConversationStore();
  }

  return res.json({
    ok: true,
    listId,
    attempted: recipients.length,
    sent: sent.length,
    skipped: skipped.length,
    failed: failed.length,
    details: { sent, skipped, failed }
  });
});

app.patch("/contacts/:id", (req, res) => {
  let updated = updateContact(req.params.id, req.body ?? {});
  if (!updated) return res.status(404).json({ ok: false, error: "Not found" });
  updated = syncContactIntoConversation(updated);
  res.json({ ok: true, contact: updated });
});

app.delete("/contacts/:id", (req, res) => {
  const ok = deleteContact(req.params.id);
  if (!ok) return res.status(404).json({ ok: false, error: "Not found" });
  res.json({ ok: true });
});

app.post("/suppressions", requirePermission("canAccessSuppressions"), async (req, res) => {
  const phone = String(req.body?.phone ?? "").trim();
  if (!phone) return res.status(400).json({ ok: false, error: "Missing phone" });
  const entry = await addSuppression(phone, String(req.body?.reason ?? "manual"), "ui");
  res.json({ ok: true, entry });
});

app.delete("/suppressions/:phone", requirePermission("canAccessSuppressions"), async (req, res) => {
  const ok = await removeSuppression(String(req.params.phone ?? ""));
  res.json({ ok });
});

function buildTranscript(
  conv: any,
  opts?: { since?: string; maxMessages?: number }
): { note: string; lastAt?: string; count: number } {
  const lead = conv.lead ?? {};
  const vehicle = lead.vehicle ?? {};
  const since = opts?.since;
  const maxMessages = opts?.maxMessages ?? 60;
  const header = [
    `LeadKey: ${conv.leadKey}`,
    lead.leadRef ? `Lead Ref: ${lead.leadRef}` : null,
    lead.firstName || lead.lastName ? `Name: ${(lead.firstName ?? "").trim()} ${(lead.lastName ?? "").trim()}`.trim() : null,
    lead.phone ? `Phone: ${lead.phone}` : null,
    lead.email ? `Email: ${lead.email}` : null,
    lead.source ? `Source: ${lead.source}` : null,
    vehicle.stockId ? `Stock: ${vehicle.stockId}` : null,
    vehicle.vin ? `VIN: ${vehicle.vin}` : null,
    vehicle.year ? `Year: ${vehicle.year}` : null,
    vehicle.model ? `Model: ${vehicle.model}` : null,
    vehicle.description ? `Vehicle: ${vehicle.description}` : null
  ]
    .filter(Boolean)
    .join("\n");

  let messages = Array.isArray(conv.messages) ? conv.messages : [];
  if (since) {
    messages = messages.filter((m: any) => m?.at && m.at > since);
  }
  if (maxMessages > 0) {
    messages = messages.slice(-maxMessages);
  }
  if (messages.length === 0) {
    return { note: "", lastAt: undefined, count: 0 };
  }

  const lines = messages.map((m: any) => {
    const when = new Date(m.at).toLocaleString();
    const dir = m.direction === "in" ? "IN" : "OUT";
    const prov = m.provider ? ` ${m.provider}` : "";
    return `[${when}] ${dir}${prov}: ${m.body}`;
  });

  const note = `${header}\n\nNew messages:\n${lines.join("\n")}`.trim();
  const lastAt = messages[messages.length - 1]?.at;
  return { note, lastAt, count: messages.length };
}

app.post("/crm/tlp/log-contact", async (req, res) => {
  const leadRef = String(req.body?.leadRef ?? "").trim();
  const conversationId = String(req.body?.conversationId ?? "").trim();
  const categoryValue = req.body?.categoryValue ? String(req.body.categoryValue).trim() : undefined;

  if (!leadRef) return res.status(400).json({ ok: false, error: "Missing leadRef" });
  if (!conversationId) return res.status(400).json({ ok: false, error: "Missing conversationId" });

  const conv = getConversation(conversationId);
  if (!conv) return res.status(404).json({ ok: false, error: "Conversation not found" });

  const { note, lastAt, count } = buildTranscript(conv, { since: conv.crm?.lastLoggedAt });
  if (count === 0 || !note) {
    return res.json({ ok: true, skipped: true, reason: "no_new_messages" });
  }

  try {
    await tlpLogCustomerContact({ leadRef, note, categoryValue });
    if (lastAt) setCrmLastLoggedAt(conv, lastAt);
    return res.json({ ok: true });
  } catch (err: any) {
    const msg = `TLP log failed for leadRef ${leadRef}. Retry in TLP or update manually.`;
    addInternalQuestion(conversationId, conv.leadKey, msg);
    return res.status(500).json({ ok: false, error: err?.message ?? "Failed to log contact" });
  }
});

app.post("/conversations/:id/media", upload.single("file"), async (req, res) => {
  const conv = getConversation(req.params.id);
  if (!conv) return res.status(404).json({ ok: false, error: "Not found" });
  if (!req.file) return res.status(400).json({ ok: false, error: "missing file" });

  const mime = String(req.file.mimetype ?? "").toLowerCase();
  const isImage = mime.startsWith("image/");
  const isVideo = mime.startsWith("video/");
  if (!isImage && !isVideo) {
    return res.status(400).json({ ok: false, error: "only image/video files are allowed" });
  }
  const maxBytes = 100 * 1024 * 1024;
  if (Number(req.file.size ?? 0) > maxBytes) {
    return res.status(400).json({ ok: false, error: "file too large (max 100MB)" });
  }

  const extFromOriginal = path.extname(req.file.originalname || "").toLowerCase();
  const extFromMime =
    mime === "image/jpeg"
      ? ".jpg"
      : mime === "image/png"
        ? ".png"
        : mime === "image/webp"
          ? ".webp"
          : mime === "image/gif"
            ? ".gif"
            : mime === "video/mp4"
              ? ".mp4"
              : mime === "video/quicktime"
                ? ".mov"
                : "";
  const ext = extFromOriginal || extFromMime || (isVideo ? ".mp4" : ".jpg");
  const safeConv = String(conv.id ?? "conv").replace(/[^a-z0-9_-]/gi, "_").slice(0, 48) || "conv";
  const fileName = `${safeConv}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`;
  const dir = path.resolve(getDataDir(), "uploads", "messages");
  await fs.promises.mkdir(dir, { recursive: true });
  const dest = path.join(dir, fileName);
  await fs.promises.writeFile(dest, req.file.buffer);

  const publicBase = process.env.PUBLIC_BASE_URL ?? "";
  const url = publicBase
    ? `${publicBase.replace(/\/$/, "")}/uploads/messages/${fileName}`
    : `/uploads/messages/${fileName}`;
  const mmsEligibleMaxBytes = 5 * 1024 * 1024;
  const sizeBytes = Number(req.file.size ?? 0);
  const mmsEligible = sizeBytes > 0 && sizeBytes <= mmsEligibleMaxBytes;

  return res.json({
    ok: true,
    url,
    name: req.file.originalname || fileName,
    type: mime || "application/octet-stream",
    size: sizeBytes,
    mmsEligible
  });
});

// ✅ Control-panel "send" (still log-only for now)
app.post("/conversations/:id/send", async (req, res) => {
  const conv = getConversation(req.params.id);
  if (!conv) return res.status(404).json({ ok: false, error: "Not found" });

  const user = (req as any).user ?? null;
  const body = String(req.body?.body ?? "").trim();

  const draftId = req.body?.draftId ? String(req.body.draftId) : undefined;
  const manualTakeover = req.body?.manualTakeover === true;
  const channel =
    req.body?.channel === "email" ? "email" : req.body?.channel === "sms" ? "sms" : null;
  const editNote = req.body?.editNote ? String(req.body.editNote).trim() : null;
  const draftCandidate = draftId
    ? conv.messages.find(m => m.id === draftId)
    : getLatestPendingDraft(conv);
  const draft =
    draftCandidate && draftCandidate.provider === "draft_ai" ? draftCandidate : null;
  const draftTextForLog = draft?.body ?? null;
  const requestMediaUrls = Array.isArray(req.body?.mediaUrls)
    ? req.body.mediaUrls
        .map((u: unknown) => String(u ?? "").trim())
        .filter((u: string) => /^https?:\/\//i.test(u))
    : [];
  const mediaUrls = requestMediaUrls.length
    ? requestMediaUrls
    : draft?.mediaUrls && draft.mediaUrls.length
      ? draft.mediaUrls
      : undefined;
  if (!body && !(mediaUrls && mediaUrls.length)) {
    return res.status(400).json({ ok: false, error: "Missing body or media" });
  }
  const actorUserId = String(user?.id ?? "").trim();
  const actorUserName = String(user?.name ?? user?.email ?? "").trim();
  const outboundSendTimeoutMs = Number(process.env.OUTBOUND_SEND_TIMEOUT_MS ?? 20000);
  const claimLeadOwnerFromActor = () => {
    if (!actorUserId) return;
    const existingOwner = conv.leadOwner;
    const assignedAt =
      existingOwner?.id === actorUserId
        ? existingOwner?.assignedAt ?? new Date().toISOString()
        : new Date().toISOString();
    conv.leadOwner = {
      id: actorUserId,
      name: actorUserName || existingOwner?.name || undefined,
      assignedAt
    };
  };

  let schedulerTimezone = "America/New_York";
  try {
    const cfg = await getSchedulerConfigHot();
    schedulerTimezone = cfg.timezone || schedulerTimezone;
    const sp = resolveSalespersonForUser(cfg, user);
    if (sp) {
      setPreferredSalespersonForConv(conv, sp, "manual_send");
    }
  } catch (err: any) {
    console.warn("[scheduler] preferred salesperson resolve failed:", err?.message ?? err);
  }

  const applyManualCadenceAdvance = (hadOutbound: boolean) => {
    if (!hadOutbound) return;
    if (!conv.followUpCadence || conv.followUpCadence.status !== "active") return;
    if (conv.followUpCadence.kind === "post_sale") return;
    advanceFollowUpCadence(conv, schedulerTimezone);
  };
  const finalizeManualSendDraftState = (opts?: { clearEmailDraft?: boolean; preserveSmsDrafts?: boolean }) => {
    if (!opts?.preserveSmsDrafts) {
      const pendingDraftIds = new Set(
        conv.messages
          .filter(
            m => m.direction === "out" && m.provider === "draft_ai" && m.draftStatus !== "stale"
          )
          .map(m => m.id)
      );
      discardPendingDrafts(conv, "manual_send");
      if (pendingDraftIds.size > 0) {
        conv.messages = conv.messages.filter(m => !pendingDraftIds.has(m.id));
        conv.updatedAt = new Date().toISOString();
      }
    }
    if (opts?.clearEmailDraft) {
      delete conv.emailDraft;
    }
  };
  const hasOpenNonCallTodo = () =>
    listOpenTodos().some(t => t.convId === conv.id && t.reason !== "call");
  const pauseCadenceAfterManualOutbound = () => {
    if (conv.followUpCadence?.kind === "post_sale") return;
    if (!hasOpenNonCallTodo()) {
      pauseFollowUpCadence(
        conv,
        new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        "manual_outbound"
      );
    }
  };
  const applyManualOutboundStateHints = (outboundBody: string, opts?: { channel?: "sms" | "email" | null }) => {
    const text = String(outboundBody ?? "").trim();
    if (!text) return;
    const lower = text.toLowerCase();
    const department = inferDepartmentFromText(text);
    if (department) {
      conv.classification = {
        ...(conv.classification ?? {}),
        bucket: department,
        cta: `${department}_request`,
        channel: opts?.channel === "email" ? "email" : "sms"
      };
      conv.inventoryWatchPending = undefined;
      if (getDialogState(conv) === "pricing_need_model" || getDialogState(conv) === "inventory_watch_prompted") {
        setDialogState(conv, "none");
      }
      if (department === "service") {
        setDialogState(conv, "service_handoff");
      }
      setFollowUpMode(conv, "manual_handoff", `${department}_request`);
      stopFollowUpCadence(conv, "manual_handoff");
      stopRelatedCadences(conv, "manual_handoff", { setMode: "manual_handoff" });
      return;
    }

    const schedulingSignals = detectSchedulingSignals(text);
    const scheduleConfirmation =
      schedulingSignals.explicit ||
      schedulingSignals.hasDayTime ||
      /\b(see you|you(?:'|’)re all set|you are all set|confirmed|booked|scheduled|works for me|that works)\b/i.test(
        lower
      );
    if (scheduleConfirmation) {
      conv.inventoryWatchPending = undefined;
      if (getDialogState(conv) === "pricing_need_model" || getDialogState(conv) === "inventory_watch_prompted") {
        setDialogState(conv, "none");
      }
      setFollowUpMode(conv, "manual_handoff", "manual_appointment");
      stopFollowUpCadence(conv, "manual_handoff");
      stopRelatedCadences(conv, "manual_appointment", { setMode: "manual_handoff" });
      return;
    }

    const financeDocsHint =
      /\b(credit app|credit application|finance team|lien holder|binder|e-?sign|payoff)\b/i.test(
        lower
      );
    if (financeDocsHint) {
      conv.inventoryWatchPending = undefined;
      if (getDialogState(conv) === "pricing_need_model" || getDialogState(conv) === "inventory_watch_prompted") {
        setDialogState(conv, "none");
      }
      setFollowUpMode(conv, "manual_handoff", "credit_app");
      stopFollowUpCadence(conv, "manual_handoff");
      stopRelatedCadences(conv, "manual_handoff", { setMode: "manual_handoff" });
      return;
    }

    if (
      conv.inventoryWatchPending &&
      !/\b(watch|keep an eye|notify|when one comes in|text you when one lands)\b/i.test(lower)
    ) {
      conv.inventoryWatchPending = undefined;
      if (getDialogState(conv) === "inventory_watch_prompted") {
        setDialogState(conv, "none");
      }
    }
    if (
      getDialogState(conv) === "pricing_need_model" &&
      !/\b(price|pricing|payment|monthly|apr|term|down payment|otd)\b/i.test(lower)
    ) {
      setDialogState(conv, "none");
    }
  };
  const reconcileManualOutboundState = async (
    outboundBody: string,
    opts?: { channel?: "sms" | "email" | null }
  ) => {
    if (process.env.MANUAL_OUTBOUND_STATE_REDUCER_ENABLED === "0") return;
    const text = String(outboundBody ?? "").trim();
    if (!text) return;
    const shortAck = isShortAckText(text) || isEmojiOnlyText(text);
    const history = buildHistory(conv, 12);
    try {
      const { parsed, reduced } = await parseAndReduceConversationState({
        conv,
        text,
        history,
        shortAck,
        debugLabel: "manual"
      });
      if (reduced.departmentIntent) {
        conv.classification = {
          ...(conv.classification ?? {}),
          bucket: reduced.departmentIntent,
          cta: `${reduced.departmentIntent}_request`,
          channel: opts?.channel === "email" ? "email" : "sms"
        };
      }
      if (process.env.DEBUG_DECISION_TRACE === "1") {
        console.log("[decision-trace]", {
          stage: "manual.outbound_reducer",
          convId: conv.id,
          leadKey: conv.leadKey,
          parsedStateIntent: parsed?.stateIntent ?? null,
          parsedDepartmentIntent: parsed?.departmentIntent ?? null,
          reducedDepartmentIntent: reduced.departmentIntent,
          followUpMode: conv.followUp?.mode ?? null,
          followUpReason: conv.followUp?.reason ?? null,
          dialogState: getDialogState(conv),
          text: text.slice(0, 140)
        });
      }
    } catch (err: any) {
      if (process.env.DEBUG_DECISION_TRACE === "1") {
        console.warn("[decision-trace] manual.outbound_reducer_error", {
          convId: conv.id,
          leadKey: conv.leadKey,
          message: String(err?.message ?? err)
        });
      }
    }
  };

  // Normalize destination number from conversation leadKey
  const rawTo = String(conv.leadKey ?? "").trim();
  const emailTo = conv.lead?.email ?? (rawTo.includes("@") ? rawTo : null);
  const wantsEmail =
    !!emailTo &&
    (channel === "email" || rawTo.includes("@") || conv.classification?.channel === "email");
  const emailOptInOk = hasEmailOptIn(conv.lead);
  if (!wantsEmail && conv.contactPreference === "call_only") {
    return res.status(400).json({
      ok: false,
      error: "call_only",
      conversation: conv
    });
  }
  const digits = rawTo.replace(/\D/g, "");
  const to =
    rawTo.startsWith("+")
      ? rawTo
      : digits.length === 10
        ? `+1${digits}`
        : digits.length > 10
          ? `+${digits}`
          : rawTo;
  const isManualDuplicateOutbound = (
    toTarget: string,
    text: string,
    providers: string[],
    windowMs = 2 * 60 * 1000
  ) =>
    isRecentDuplicateOutbound(conv, toTarget, text, {
      providers,
      windowMs,
      mediaUrls,
      excludeMessageId: draftId ?? null
    });

  const logRow = async (twilioSid: string | null) => {
    try {
      const draftForLog = draftTextForLog ?? draft?.originalDraftBody ?? draft?.body ?? null;
      await logTuningRow({
        ts: new Date().toISOString(),
        leadKey: conv.leadKey,
        leadSource: conv.lead?.source ?? null,
        bucket: conv.classification?.bucket ?? null,
        cta: conv.classification?.cta ?? null,
        channel: channel ?? conv.classification?.channel ?? "sms",
        draftId: draft?.id ?? null,
        draft: draftForLog,
        final: body,
        edited: draftForLog ? draftForLog.trim() !== body.trim() : null,
        editDistance: null,
        editNote: editNote && editNote.length > 0 ? editNote : null,
        twilioSid
      });
    } catch (err: any) {
      console.warn("⚠️ Failed to write tuning row:", err?.message ?? err);
    }
  };

  const maybeLogTlp = async () => {
    const leadRef = conv.lead?.leadRef;
    if (!leadRef) {
      console.log("📝 TLP skip: missing leadRef", { convId: conv.id });
      return;
    }
    const { note, lastAt, count } = buildTranscript(conv, { since: conv.crm?.lastLoggedAt });
    if (count === 0 || !note) {
      console.log("📝 TLP skip: no new messages", { leadRef, convId: conv.id });
      return;
    }
    try {
      console.log("📝 TLP env", {
        TLP_USERNAME: process.env.TLP_USERNAME ? "set" : "missing",
        TLP_PASSWORD: process.env.TLP_PASSWORD ? "set" : "missing",
        TLP_BASE_URL: process.env.TLP_BASE_URL ?? "https://tlpcrm.com",
        TLP_HEADLESS: process.env.TLP_HEADLESS ?? "true"
      });
      console.log("📝 TLP log start", { leadRef, convId: conv.id });
      await tlpLogCustomerContact({ leadRef, note });
      if (lastAt) setCrmLastLoggedAt(conv, lastAt);
      console.log("✅ TLP log success", { leadRef, convId: conv.id });
    } catch (err: any) {
      console.warn("⚠️ TLP log failed:", err?.message ?? err);
      const msg = `TLP log failed for leadRef ${leadRef}. Retry in TLP or update manually.`;
      addInternalQuestion(conv.id, conv.leadKey, msg);
    }
  };
  const queueTlpLog = () => {
    void maybeLogTlp().catch((err: any) => {
      console.warn("⚠️ TLP async log failed:", err?.message ?? err);
    });
  };
  const queueTuningLog = (twilioSid: string | null) => {
    void logRow(twilioSid).catch((err: any) => {
      console.warn("⚠️ Async tuning log failed:", err?.message ?? err);
    });
  };

  if (wantsEmail) {
    const forceEmail = req.body?.forceEmail === true;
    const skipEmailSignature = req.body?.skipEmailSignature === true;
    if (!emailOptInOk && !forceEmail) {
      return res.status(400).json({
        ok: false,
        error: "email opt-in not present for this lead",
        conversation: conv
      });
    }
    const dealerProfile = await getDealerProfileHot();
    const { from: emailFrom, replyTo: emailReplyTo, signature } = getEmailConfig(dealerProfile);
    const replyTo = maybeTagReplyTo(emailReplyTo, conv);
    if (!emailFrom) {
      return res.status(400).json({
        ok: false,
        error: "SendGrid from email not configured",
        conversation: conv
      });
    }
    const dealerName = dealerProfile?.dealerName ?? "Dealership";
    const subject = String(req.body?.subject ?? `Message from ${dealerName}`).trim();
    const rawAttachments: { content?: string; filename?: string; type?: string }[] =
      Array.isArray(req.body?.attachments) ? req.body.attachments : [];
    const attachments = rawAttachments
      .map(att => ({
        content: String(att?.content ?? "")
          .trim()
          .replace(/^data:[^,]+,/i, "")
          .replace(/\s+/g, ""),
        filename: String(att?.filename ?? "").trim() || "attachment",
        type: att?.type ? String(att.type) : undefined
      }))
      .filter(att => att.content.length > 0);
    const signed =
      !skipEmailSignature && signature
        ? `${body}\n\n${signature}${dealerProfile?.logoUrl ? `\n\n${dealerProfile.logoUrl}` : ""}`
        : body;
    if (isManualDuplicateOutbound(emailTo!, signed, ["sendgrid", "human", "draft_ai"])) {
      return res.json({
        ok: true,
        sent: false,
        duplicateSuppressed: true,
        conversation: conv
      });
    }
    const hadOutbound = conv.messages.some(m => m.direction === "out");
    try {
      await withTimeout(
        sendEmail({
          to: emailTo!,
          subject,
          text: signed,
          from: emailFrom,
          replyTo,
          ...(attachments.length ? { attachments } : {})
        }),
        outboundSendTimeoutMs,
        "email send"
      );
      const outboundProvider = manualTakeover && !draftId ? "human" : "sendgrid";
      const fin = finalizeDraftAsSent(conv, draftId, signed, outboundProvider);
      if (!fin.usedDraft) {
        appendOutbound(conv, emailFrom, emailTo!, signed, outboundProvider);
      }
      applyManualOutboundStateHints(signed, { channel: "email" });
      await reconcileManualOutboundState(signed, { channel: "email" });
      finalizeManualSendDraftState({ clearEmailDraft: true, preserveSmsDrafts: true });
      saveConversation(conv);
      await flushConversationStore();
      if (!hadOutbound) {
        await maybeStartCadence(conv, new Date().toISOString());
      }
      applyManualCadenceAdvance(hadOutbound);
      pauseCadenceAfterManualOutbound();
      if (manualTakeover && !draftId) {
        claimLeadOwnerFromActor();
        setConversationMode(conv.id, "human");
      }
      markAppointmentAcknowledged(conv);
      queueTuningLog(null);
      queueTlpLog();
      return res.json({ ok: true, conversation: conv });
    } catch (err: any) {
      console.warn("[email] send failed:", err?.message ?? err);
      return res.status(500).json({ ok: false, error: "email send failed", conversation: conv });
    }
  }

  if (!to.startsWith("+")) {
    // Not a phone number; still log as human note so it isn't lost
    if (isManualDuplicateOutbound(conv.leadKey, body, ["human", "draft_ai", "twilio"])) {
      return res.status(400).json({
        ok: false,
        error: "leadKey is not a valid phone number for SMS send",
        duplicateSuppressed: true,
        conversation: conv
      });
    }
    const hadOutbound = conv.messages.some(m => m.direction === "out");
    const fin = finalizeDraftAsSent(conv, draftId, body, "human");
    if (!fin.usedDraft) {
      appendOutbound(conv, "salesperson", conv.leadKey, body, "human", undefined, mediaUrls);
    }
    applyManualOutboundStateHints(body, { channel: "sms" });
    await reconcileManualOutboundState(body, { channel: "sms" });
    finalizeManualSendDraftState();
    if (!hadOutbound) {
      await maybeStartCadence(conv, new Date().toISOString());
    }
    applyManualCadenceAdvance(hadOutbound);
    pauseCadenceAfterManualOutbound();
    if (manualTakeover && !draftId) {
      claimLeadOwnerFromActor();
      setConversationMode(conv.id, "human");
    }
    markAppointmentAcknowledged(conv);
    queueTuningLog(null);
    queueTlpLog();
    return res.status(400).json({
      ok: false,
      error: "leadKey is not a valid phone number for SMS send",
      conversation: conv
    });
  }

  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_FROM_NUMBER;

  if (!accountSid || !authToken || !from) {
    if (isManualDuplicateOutbound(to, body, ["human", "draft_ai", "twilio"])) {
      return res.status(500).json({
        ok: false,
        error: "Twilio credentials not configured (TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN/TWILIO_FROM_NUMBER)",
        duplicateSuppressed: true,
        conversation: conv
      });
    }
    const hadOutbound = conv.messages.some(m => m.direction === "out");
    const fin = finalizeDraftAsSent(conv, draftId, body, "human");
    if (!fin.usedDraft) {
      appendOutbound(conv, "salesperson", to, body, "human", undefined, mediaUrls);
    }
    applyManualOutboundStateHints(body, { channel: "sms" });
    await reconcileManualOutboundState(body, { channel: "sms" });
    finalizeManualSendDraftState();
    if (!hadOutbound) {
      await maybeStartCadence(conv, new Date().toISOString());
    }
    applyManualCadenceAdvance(hadOutbound);
    pauseCadenceAfterManualOutbound();
    if (manualTakeover && !draftId) {
      claimLeadOwnerFromActor();
      setConversationMode(conv.id, "human");
    }
    markAppointmentAcknowledged(conv);
    queueTuningLog(null);
    queueTlpLog();
    return res.status(500).json({
      ok: false,
      error: "Twilio credentials not configured (TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN/TWILIO_FROM_NUMBER)",
      conversation: conv
    });
  }

  try {
    if (isManualDuplicateOutbound(to, body, ["twilio", "human", "draft_ai"])) {
      return res.json({
        ok: true,
        sent: false,
        duplicateSuppressed: true,
        conversation: conv
      });
    }
    const client = twilio(accountSid, authToken);
    const msg = await withTimeout(
      client.messages.create({
        from,
        to,
        body,
        ...(mediaUrls && mediaUrls.length ? { mediaUrl: mediaUrls } : {})
      }),
      outboundSendTimeoutMs,
      "twilio send"
    );

    // Log as truly sent via Twilio (store SID)
    const hadOutbound = conv.messages.some(m => m.direction === "out");
    const fin = finalizeDraftAsSent(conv, draftId, body, "twilio", msg.sid);
    if (!fin.usedDraft) {
      appendOutbound(conv, from, to, body, "twilio", msg.sid, mediaUrls);
    }
    applyManualOutboundStateHints(body, { channel: "sms" });
    await reconcileManualOutboundState(body, { channel: "sms" });
    finalizeManualSendDraftState();
    if (!hadOutbound) {
      await maybeStartCadence(conv, new Date().toISOString());
    }
    applyManualCadenceAdvance(hadOutbound);
    pauseCadenceAfterManualOutbound();
    if (manualTakeover && !draftId) {
      claimLeadOwnerFromActor();
      setConversationMode(conv.id, "human");
    }
    markAppointmentAcknowledged(conv);
    queueTuningLog(msg.sid);
    queueTlpLog();

    return res.json({
      ok: true,
      sent: true,
      sid: msg.sid,
      conversation: conv
    });
  } catch (err: any) {
    // Log the attempted send as human so rep still sees it
    const hadOutbound = conv.messages.some(m => m.direction === "out");
    const fin = finalizeDraftAsSent(conv, draftId, body, "human");
    if (!fin.usedDraft) {
      appendOutbound(conv, "salesperson", to, body, "human", undefined, mediaUrls);
    }
    applyManualOutboundStateHints(body, { channel: "sms" });
    await reconcileManualOutboundState(body, { channel: "sms" });
    finalizeManualSendDraftState();
    if (!hadOutbound) {
      await maybeStartCadence(conv, new Date().toISOString());
    }
    applyManualCadenceAdvance(hadOutbound);
    pauseCadenceAfterManualOutbound();
    if (manualTakeover && !draftId) {
      claimLeadOwnerFromActor();
      setConversationMode(conv.id, "human");
    }
    markAppointmentAcknowledged(conv);
    queueTuningLog(null);

    return res.status(502).json({
      ok: false,
      sent: false,
      error: "Twilio send failed",
      details: String(err?.message ?? err),
      conversation: conv
    });
  }
});

app.post("/conversations/:id/draft/clear", async (req, res) => {
  const conv = getConversation(req.params.id);
  if (!conv) return res.status(404).json({ ok: false, error: "Not found" });

  const clearEmailDraft = req.body?.clearEmailDraft === true;
  const clearSmsDraft = req.body?.clearSmsDraft !== false;
  if (clearSmsDraft) {
    discardPendingDrafts(conv, "manual_clear");
  }
  if (clearEmailDraft) {
    delete conv.emailDraft;
  }
  saveConversation(conv);
  await flushConversationStore();
  return res.json({ ok: true, conversation: conv });
});

app.post("/conversations/:id/regenerate", async (req, res) => {
  const conv = getConversation(req.params.id);
  if (!conv) return res.status(404).json({ ok: false, error: "Not found" });
  if (getSystemMode() !== "suggest") {
    return res.status(400).json({ ok: false, error: "regenerate_requires_suggest_mode" });
  }
  if (conv.mode === "human") {
    return res.status(400).json({ ok: false, error: "human_override" });
  }
  const isWalkInLead =
    inferWalkIn(conv) || /traffic log pro/i.test(String(conv.lead?.source ?? ""));
  if (isWalkInLead && Array.isArray(conv.messages)) {
    for (const m of conv.messages) {
      if (m.direction === "out" && m.provider === "draft_ai") {
        m.mediaUrls = undefined;
      }
    }
  }

  const channel =
    req.body?.channel === "email" ? "email" : req.body?.channel === "sms" ? "sms" : "sms";
  const lastDraft = [...(conv.messages ?? [])].reverse().find(m => m.provider === "draft_ai" && m.body);
  const {
    inbound,
    latestInboundBeforeDraft,
    latestInboundIsCreditAdf,
    latestInboundIsDlaNoPurchaseAdf
  } = pickRegenerateInbound({
    messages: conv.messages ?? [],
    latestDraftAt: lastDraft?.at ?? null
  });
  if (process.env.DEBUG_DECISION_TRACE === "1") {
    console.log("[decision-trace]", {
      stage: "regen.pick_inbound",
      convId: conv.id,
      leadKey: conv.leadKey,
      selectedProvider: inbound?.provider ?? null,
      selectedAt: inbound?.at ?? null,
      selectedPreview: String(inbound?.body ?? "").slice(0, 120),
      latestInboundProvider: latestInboundBeforeDraft?.provider ?? null,
      latestInboundAt: latestInboundBeforeDraft?.at ?? null,
      latestInboundIsCreditAdf,
      latestInboundIsDlaNoPurchaseAdf
    });
  }
  if (!inbound?.body) {
    return res.status(400).json({ ok: false, error: "no_inbound_message" });
  }

  const inboundProvider = inbound.provider;
  const provider: InboundMessageEvent["provider"] =
    inboundProvider === "twilio" ||
    inboundProvider === "sendgrid" ||
    inboundProvider === "sendgrid_adf" ||
    inboundProvider === "voice_transcript"
      ? inboundProvider
      : channel === "email"
        ? "sendgrid"
        : "twilio";

  const event: InboundMessageEvent = {
    channel,
    provider,
    from: inbound.from ?? conv.leadKey,
    to: inbound.to ?? "dealership",
    body: String(inbound.body ?? ""),
    mediaUrls:
      Array.isArray((inbound as any).mediaUrls) && (inbound as any).mediaUrls.length
        ? ((inbound as any).mediaUrls as string[])
        : undefined,
    providerMessageId: inbound.providerMessageId ?? `regen_${Date.now()}`,
    receivedAt: inbound.at ?? new Date().toISOString()
  };
  const evaluateRegenDraftInvariant = (text: string) =>
    applyDraftStateInvariants({
      inboundText: event.body ?? "",
      draftText: text,
      followUpMode: conv.followUp?.mode ?? null,
      followUpReason: conv.followUp?.reason ?? null,
      dialogState: getDialogState(conv),
      classificationBucket: conv.classification?.bucket ?? null,
      classificationCta: conv.classification?.cta ?? null
    });
  const respondRegenerateSkipped = (note: string, draft?: string) => {
    recordRouteOutcome("regen", note, {
      convId: conv.id,
      leadKey: conv.leadKey
    });
    discardPendingDrafts(conv, note);
    delete conv.emailDraft;
    saveConversation(conv);
    return res.json({
      ok: true,
      conversation: conv,
      skipped: true,
      note,
      ...(draft ? { draft } : {})
    });
  };
  const appendSmsRegeneratedDraft = (text: string, mediaUrls?: string[]) => {
    const invariant = evaluateRegenDraftInvariant(text);
    if (!invariant.allow) {
      return { ok: false as const, reason: invariant.reason ?? "draft_invariant_blocked" };
    }
    const from = String(event.to ?? "dealership").trim() || "dealership";
    const leadKey = String(conv.leadKey ?? "").trim();
    const to = leadKey || String(event.from ?? "").trim();
    appendOutbound(conv, from, to, invariant.draftText, "draft_ai", undefined, mediaUrls);
    return { ok: true as const, draft: invariant.draftText };
  };
  const respondWithSmsRegeneratedDraft = (text: string, mediaUrls?: string[]) => {
    discardPendingDrafts(conv);
    const published = appendSmsRegeneratedDraft(text, mediaUrls);
    if (!published.ok) {
      return respondRegenerateSkipped(published.reason);
    }
    saveConversation(conv);
    recordRouteOutcome("regen", "draft_published", {
      convId: conv.id,
      leadKey: conv.leadKey
    });
    return res.json({ ok: true, conversation: conv, draft: published.draft });
  };
  const respondWithEmailRegeneratedDraft = (text: string) => {
    const invariant = evaluateRegenDraftInvariant(text);
    if (!invariant.allow) {
      return respondRegenerateSkipped(invariant.reason ?? "draft_invariant_blocked");
    }
    conv.emailDraft = invariant.draftText;
    saveConversation(conv);
    recordRouteOutcome("regen", "email_draft_published", {
      convId: conv.id,
      leadKey: conv.leadKey
    });
    return res.json({ ok: true, conversation: conv, draft: invariant.draftText });
  };
  const regenManualReconcile = reconcileStateFromRecentManualOutbound(conv, event.receivedAt);
  if (regenManualReconcile.changed) {
    recordRouteOutcome("regen", "manual_outbound_reconciled", {
      convId: conv.id,
      leadKey: conv.leadKey,
      reasons: regenManualReconcile.reasons
    });
  }
  const regenShortAckSuppression = shouldSuppressShortAckDraft(event.body ?? "");
  const regenInboundLower = String(event.body ?? "").toLowerCase();
  const regenRawProvider = String((inbound as any)?.provider ?? "").toLowerCase();
  const regenLooksLikeAdf =
    regenRawProvider === "sendgrid_adf" ||
    /web lead\s*\(adf\)|source:\s*[^\\n]+/i.test(String(event.body ?? ""));
  const regenDealerRideEventLead =
    regenLooksLikeAdf &&
    (/source:\s*dealer lead app/i.test(String(event.body ?? "")) ||
      /event name:\s*dealer test ride|demo bikes ridden|dealer lead app/i.test(String(event.body ?? "")));
  const regenNoPurchaseNow =
    /purchase timeframe:\s*i am not interested in purchasing at this time/.test(regenInboundLower) ||
    /do you expect to make a motorcycle purchase in the near future\?\s*no/.test(regenInboundLower) ||
    /not interested in purchasing at this time/.test(regenInboundLower);
  const regenPreRouteDecision = nextActionFromState({
    provider: event.provider,
    channel,
    isShortAck: regenShortAckSuppression,
    dealerRideNoPurchaseAdf: regenDealerRideEventLead && regenNoPurchaseNow
  });
  if (regenPreRouteDecision.kind === "skip" && regenPreRouteDecision.note === "short_ack_no_action") {
    return respondRegenerateSkipped(regenPreRouteDecision.note);
  }
  if (
    regenPreRouteDecision.kind === "skip" &&
    regenPreRouteDecision.note === "dealer_ride_no_purchase_manual_handoff"
  ) {
    addCallTodoIfMissing(
      conv,
      "Dealer ride follow-up needed: thank customer, confirm how to proceed, and update lead status."
    );
    const users = await listUsers();
    const pickUserPhone = (user: any): string => {
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
        const normalized = normalizePhone(String(raw ?? "").trim());
        if (normalized) return normalized;
      }
      return "";
    };
    const ownerId = String(conv.leadOwner?.id ?? "").trim();
    const ownerById =
      users.find(u => String(u.id ?? "").trim() === ownerId) ?? null;
    const ownerFirst = String(conv.leadOwner?.name ?? "")
      .trim()
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean)[0];
    const ownerByName =
      users.find(u => {
        const first = String(u.firstName ?? "").trim().toLowerCase();
        const nameFirst = String(u.name ?? "")
          .trim()
          .toLowerCase()
          .split(/\s+/)
          .filter(Boolean)[0];
        return !!ownerFirst && (ownerFirst === first || ownerFirst === nameFirst);
      }) ?? null;
    const manager = users.find(u => u.role === "manager") ?? null;
    const owner = ownerById ?? ownerByName ?? manager;
    const ownerName =
      String(owner?.firstName ?? "").trim() ||
      String(owner?.name ?? "").trim() ||
      String(conv.leadOwner?.name ?? "").trim() ||
      "salesperson";
    const ownerPhone = pickUserPhone(owner);
    if (ownerPhone) {
      const customerName =
        [conv.lead?.firstName, conv.lead?.lastName].filter(Boolean).join(" ").trim() ||
        conv.leadKey ||
        "customer";
      const token = ensureDealerRideOutcomeToken(conv);
      const outcomeLink = buildStaffOutcomeLink(token);
      conv.dealerRide = conv.dealerRide ?? {};
      conv.dealerRide.staffNotify = conv.dealerRide.staffNotify ?? {};
      const leadSummary = [
        `Dealer ride outcome needed for ${customerName}.`,
        "DLA confirms they rode a demo bike.",
        `Reply: OUTCOME ${token} SOLD <stock/vin> | HOLD <stock/vin> <when> | FOLLOWUP <when> | LOST <reason>.`,
        outcomeLink ? `Update form: ${outcomeLink}` : null
      ]
        .filter(Boolean)
        .join("\n");
      const sent = await sendInternalSms(ownerPhone, leadSummary);
      addTodo(
        conv,
        "note",
        sent
          ? `Salesperson SMS sent to ${ownerName}.`
          : `Salesperson SMS failed for ${ownerName}: send_failed.`
      );
      if (sent) {
        conv.dealerRide.staffNotify.followUpSentAt =
          conv.dealerRide.staffNotify.followUpSentAt ?? new Date().toISOString();
      }
    } else {
      addTodo(
        conv,
        "note",
        `Salesperson SMS failed for ${ownerName}: invalid_to_number.`
      );
    }
    setFollowUpMode(conv, "manual_handoff", "dealer_ride_no_purchase");
    stopFollowUpCadence(conv, "manual_handoff");
    saveConversation(conv);
    return respondRegenerateSkipped(
      regenPreRouteDecision.note,
      regenPreRouteDecision.draft ?? DEALER_RIDE_NO_PURCHASE_SKIP_DRAFT
    );
  }

  const history = buildHistory(conv, 60);
  const memorySummary = conv.memorySummary?.text ?? null;
  const memorySummaryShouldUpdate = shouldUpdateMemorySummary(conv);
  const regenShortAck = isShortAckText(event.body) || isEmojiOnlyText(event.body);
  const regenUnifiedSlotRouterEnabled = process.env.LLM_UNIFIED_SLOT_ROUTER_ENABLED === "1";
  const regenUnifiedSlotCompareLogEnabled = process.env.LLM_UNIFIED_SLOT_COMPARE_LOG === "1";
  const regenTradePayoffParserEligible =
    event.provider === "twilio" &&
    process.env.LLM_ENABLED === "1" &&
    process.env.LLM_TRADE_PAYOFF_PARSER_ENABLED === "1" &&
    !!process.env.OPENAI_API_KEY &&
    !regenShortAck;
  const regenTextLower = String(event.body ?? "").toLowerCase();
  const regenTradePayoffParserHint =
    /\b(lien|lein|payoff|lender|loan|title|owe|owe on it|bank)\b/i.test(regenTextLower) ||
    /\b(address|info|information|details)\b/i.test(regenTextLower) ||
    isTradeDialogState(getDialogState(conv)) ||
    !!conv.tradePayoff;
  const regenUnifiedSlotParserEligible =
    event.provider === "twilio" &&
    process.env.LLM_ENABLED === "1" &&
    process.env.LLM_UNIFIED_SLOT_PARSER_ENABLED === "1" &&
    !!process.env.OPENAI_API_KEY &&
    !regenShortAck;
  const regenUnifiedSlotParse =
    regenUnifiedSlotRouterEnabled && regenUnifiedSlotParserEligible && regenTradePayoffParserHint
      ? await safeLlmParse("regen_unified_semantic_slot_parser", () =>
          parseUnifiedSemanticSlotsWithLLM({
            text: event.body,
            history,
            lead: conv.lead,
            inventoryWatch: conv.inventoryWatch,
            inventoryWatchPending: conv.inventoryWatchPending,
            tradePayoff: conv.tradePayoff,
            dialogState: getDialogState(conv)
          })
        )
      : null;
  const regenUnifiedTradeParse: TradePayoffParse | null =
    regenUnifiedSlotParse && regenTradePayoffParserHint
      ? {
          payoffStatus: regenUnifiedSlotParse.payoffStatus,
          needsLienHolderInfo: regenUnifiedSlotParse.needsLienHolderInfo,
          providesLienHolderInfo: regenUnifiedSlotParse.providesLienHolderInfo,
          confidence:
            typeof regenUnifiedSlotParse.payoffConfidence === "number"
              ? regenUnifiedSlotParse.payoffConfidence
              : regenUnifiedSlotParse.confidence
        }
      : null;
  let regenTradePayoffParse: TradePayoffParse | null = regenUnifiedSlotRouterEnabled
    ? regenUnifiedTradeParse
    : null;
  if (!regenTradePayoffParse && regenTradePayoffParserEligible && regenTradePayoffParserHint) {
    regenTradePayoffParse = await safeLlmParse("regen_trade_payoff_parser", () =>
      parseTradePayoffWithLLM({
        text: event.body,
        history,
        lead: conv.lead,
        tradePayoff: conv.tradePayoff
      })
    );
    if (regenUnifiedSlotRouterEnabled && process.env.DEBUG_UNIFIED_SLOT_PARSER === "1") {
      console.log("[llm-unified-slot-parse] regen trade fallback to legacy parser");
    }
  }
  if (regenUnifiedSlotRouterEnabled && regenUnifiedSlotCompareLogEnabled && regenTradePayoffParserHint) {
    const legacyRegenTradeShadow =
      regenTradePayoffParserEligible &&
      (!regenTradePayoffParse || regenTradePayoffParse === regenUnifiedTradeParse)
        ? await safeLlmParse("regen_trade_payoff_parser_legacy_shadow", () =>
            parseTradePayoffWithLLM({
              text: event.body,
              history,
              lead: conv.lead,
              tradePayoff: conv.tradePayoff
            })
          )
        : null;
    if (legacyRegenTradeShadow) {
      const mismatch =
        legacyRegenTradeShadow.payoffStatus !== (regenUnifiedTradeParse?.payoffStatus ?? "unknown") ||
        legacyRegenTradeShadow.needsLienHolderInfo !==
          !!(regenUnifiedTradeParse?.needsLienHolderInfo ?? false) ||
        legacyRegenTradeShadow.providesLienHolderInfo !==
          !!(regenUnifiedTradeParse?.providesLienHolderInfo ?? false);
      if (mismatch) {
        console.log("[llm-unified-slot-compare] regen trade mismatch", {
          text: event.body,
          unified: regenUnifiedTradeParse,
          legacy: legacyRegenTradeShadow
        });
      }
    }
  }
  const regenTradePayoffConfidence =
    typeof regenTradePayoffParse?.confidence === "number" ? regenTradePayoffParse.confidence : 0;
  const regenTradePayoffConfidenceMin = Number(process.env.LLM_TRADE_PAYOFF_CONFIDENCE_MIN ?? 0.72);
  const regenTradePayoffAccepted =
    !!regenTradePayoffParse &&
    regenTradePayoffConfidence >= regenTradePayoffConfidenceMin &&
    (regenTradePayoffParse.payoffStatus !== "unknown" ||
      regenTradePayoffParse.needsLienHolderInfo ||
      regenTradePayoffParse.providesLienHolderInfo);
  if (regenTradePayoffAccepted) {
    applyTradePayoffParseToConversation(conv, regenTradePayoffParse);
  }
  const regenNeedsLienHolderInfo = !!(
    regenTradePayoffAccepted && regenTradePayoffParse?.needsLienHolderInfo
  );
  const dealerProfile = await getDealerProfileHot();
  const weatherStatus = await getDealerWeatherStatus(dealerProfile);
  const regenTextingTypoJoke = isTextingTypoJokeText(event.body ?? "");

  // Keep regenerate aligned with inbound deterministic availability behavior.
  if (event.provider === "twilio" && channel === "sms") {
    const availabilitySignals = getDeterministicAvailabilitySignals(regenTextLower, conv);
    const deterministicRegenAvailability = availabilitySignals.shouldLookupAvailability;
    const regenAvailabilityIntentOverride =
      availabilitySignals.inventoryCountQuestion || availabilitySignals.explicitAvailabilityAsk;
    const regenFinancePriorityOverride = hasFinancePrioritySignals(event.body ?? "", conv, {
      lastOutboundText: String(getLastNonVoiceOutbound(conv)?.body ?? "")
    });
    const regenSchedulingSignals = detectSchedulingSignals(event.body ?? "");
    const regenSchedulePriorityOverride =
      regenSchedulingSignals.explicit ||
      regenSchedulingSignals.hasDayTime ||
      regenSchedulingSignals.hasDayOnlyAvailability ||
      regenSchedulingSignals.hasDayOnlyRequest;
    const regenOtherInventoryRequest = isOtherInventoryRequestText(regenTextLower);
    const regenRouteDecision = nextActionFromState({
      provider: event.provider,
      channel,
      isShortAck: false,
      deterministicAvailabilityLookup: deterministicRegenAvailability,
      availabilityIntentOverride: regenAvailabilityIntentOverride,
      financePriorityOverride: regenFinancePriorityOverride,
      schedulePriorityOverride: regenSchedulePriorityOverride
    });
    if (regenRouteDecision.kind === "deterministic_availability_lookup") {
      const availabilityResolution = await resolveDeterministicAvailabilityReply({
        conv,
        text: event.body ?? "",
        parsedAvailability: null,
        otherInventoryRequest: regenOtherInventoryRequest
      });
      const reply =
        availabilityResolution.kind === "reply"
          ? availabilityResolution.reply
          : "Which model are you asking about?";
      const mediaUrls =
        availabilityResolution.kind === "reply" && Array.isArray(availabilityResolution.mediaUrls)
          ? availabilityResolution.mediaUrls
          : undefined;
      return respondWithSmsRegeneratedDraft(reply, mediaUrls);
    }
  }

  if (event.provider === "twilio") {
    const inboundAtMs = new Date(event.receivedAt).getTime();
    const lastOutboundBeforeInbound = [...(conv.messages ?? [])]
      .filter(m => m.direction === "out" && m.body)
      .filter(m => {
        if (!Number.isFinite(inboundAtMs)) return true;
        const atMs = new Date(m.at ?? "").getTime();
        return !Number.isFinite(atMs) || atMs <= inboundAtMs;
      })
      .slice(-1)[0];
    const lastOutboundForMedia = String(lastOutboundBeforeInbound?.body ?? "");
    const bike =
      formatModelLabel(
        conv.lead?.vehicle?.year ? String(conv.lead?.vehicle?.year) : null,
        conv.lead?.vehicle?.model ?? conv.lead?.vehicle?.description ?? null
      ) || "the bike";
    const mediaAffirmReply = buildMediaAffirmativeReply(lastOutboundForMedia, event.body, bike);
    if (mediaAffirmReply) {
      const autoMediaUrls = await findAutoMediaUrlsForConversationContext(conv, { max: 2 });
      const mediaReply = autoMediaUrls.length
        ? `Absolutely — here ${autoMediaUrls.length === 1 ? "is a photo" : "are a couple photos"} of ${bike}.`
        : mediaAffirmReply;
      if (!autoMediaUrls.length) {
        addMediaRequestTodoIfMissing(conv, event.body, event.providerMessageId);
      }
      if (channel === "email") {
        return respondWithEmailRegeneratedDraft(mediaReply);
      }
      return respondWithSmsRegeneratedDraft(
        mediaReply,
        autoMediaUrls.length ? autoMediaUrls : undefined
      );
    }
  }

  const usersForMentions = await listUsers();
  const resolveRegenSenderName = () => {
    const ownerId = String(conv.leadOwner?.id ?? "").trim();
    const ownerFromUsers = ownerId
      ? usersForMentions.find(u => String(u.id ?? "").trim() === ownerId)
      : null;
    const ownerName =
      String(ownerFromUsers?.firstName ?? "").trim() ||
      String(ownerFromUsers?.name ?? "").trim() ||
      String(conv.leadOwner?.name ?? "").trim();
    if (ownerName) return ownerName.split(/\s+/).filter(Boolean)[0] ?? ownerName;
    const user = (req as any).user ?? null;
    const actorName = String(user?.name ?? user?.email ?? "").trim();
    if (actorName) return actorName.split(/\s+/).filter(Boolean)[0] ?? actorName;
    return "";
  };
  if (latestInboundIsCreditAdf) {
    const firstName = normalizeDisplayCase(conv.lead?.firstName);
    const dealerName = dealerProfile?.dealerName ?? "American Harley-Davidson";
    const agentName = resolveRegenSenderName() || dealerProfile?.agentName || "Brooke";
    const hasPriorOutbound = Array.isArray(conv.messages) && conv.messages.some(m => m.direction === "out");
    const reply = hasPriorOutbound
      ? firstName
        ? `Thanks ${firstName} — we just received your online credit application. Our finance team will reach out shortly to go over options.`
        : "Thanks — we just received your online credit application. Our finance team will reach out shortly to go over options."
      : `${firstName ? `Hi ${firstName} — ` : "Hi — "}This is ${agentName} at ${dealerName}. Thanks — I received your credit application. I’ll have our finance team reach out shortly.`;
    const hasApprovalTodo = listOpenTodos().some(
      t => t.convId === conv.id && t.reason === "approval" && t.status === "open"
    );
    if (!hasApprovalTodo) {
      addTodo(conv, "approval", event.body ?? "Credit application", event.providerMessageId);
    }
    setFollowUpMode(conv, "manual_handoff", "credit_app");
    stopFollowUpCadence(conv, "manual_handoff");
    stopRelatedCadences(conv, "manual_handoff", { setMode: "manual_handoff" });
    if (channel === "email") {
      return respondWithEmailRegeneratedDraft(reply);
    }
    return respondWithSmsRegeneratedDraft(reply);
  }
  let mentionedUser =
    event.provider === "sendgrid_adf" ? null : findMentionedUser(event.body ?? "", usersForMentions);
  if (!mentionedUser && inboundReferencesOtherPerson(event.body ?? "")) {
    mentionedUser = findUserFromRecentOutbound(conv, usersForMentions);
  }
  if (mentionedUser) {
    const firstName =
      String(mentionedUser.firstName ?? "").trim() ||
      String(mentionedUser.name ?? "").trim().split(/\s+/).filter(Boolean)[0] ||
      "them";
    const fallbackSensitive = /\b(cancer|chemo|chemotherapy|radiation|hospice|icu|hospital|surgery|surgical|terminal|stage\s*(four|4)|death|dying|funeral|passed away|stroke|heart attack)\b/i.test(
      String(event.body ?? "")
    );
    const empathyNeeded =
      (await classifyEmpathyNeedWithLLM({ text: event.body ?? "", history })) ?? fallbackSensitive;
    const wantsCall = /\b(call me|give me a call|can you call|please call|have .* call|reach me|contact me)\b/i.test(
      String(event.body ?? "")
    );
    const dealerName = dealerProfile?.dealerName ?? "American Harley-Davidson";
    const agentName = dealerProfile?.agentName ?? "our team";
    const customerName = normalizeDisplayCase(conv.lead?.firstName) || "there";
    const intro = isDirectUserMention(event.body ?? "", mentionedUser)
      ? `Hey ${customerName} — this is ${agentName} at ${dealerName}. `
      : "";
    const handoff = wantsCall
      ? `I'll have ${firstName} reach out.`
      : `I'll let ${firstName} know.`;
    const reply = `${intro}${empathyNeeded ? "I'm really sorry to hear that. " : "Got it — "}${handoff}`;
    return respondWithSmsRegeneratedDraft(reply);
  }

  const regenCustomerDispositionParserEligible =
    event.provider === "twilio" &&
    process.env.LLM_ENABLED === "1" &&
    process.env.LLM_CUSTOMER_DISPOSITION_PARSER_ENABLED !== "0" &&
    !!process.env.OPENAI_API_KEY &&
    !regenShortAck;
  const regenCustomerDispositionParserHint =
    /\b(sell (it|my bike|my motorcycle|my ride)|on my own|myself|keep (it|my bike|my motorcycle|my ride)|hold off|pass for now|not ready|let you know|get back to you|maybe later|can(?:not|'t)\s+afford|too (expensive|high)|out of (my )?budget|can't do that right now|not in the budget)\b/i.test(
      regenTextLower
    );
  const regenCustomerDispositionParse =
    regenCustomerDispositionParserEligible && regenCustomerDispositionParserHint
      ? await safeLlmParse("regen_customer_disposition_parser", () =>
          parseCustomerDispositionWithLLM({
            text: event.body,
            history,
            lead: conv.lead
          })
        )
      : null;
  if (process.env.DEBUG_CUSTOMER_DISPOSITION_PARSER === "1" && regenCustomerDispositionParse) {
    console.log("[llm-customer-disposition-parse] regen", regenCustomerDispositionParse);
  }
  const regenResponseControlParserEligible =
    event.provider === "twilio" &&
    process.env.LLM_ENABLED === "1" &&
    process.env.LLM_RESPONSE_CONTROL_PARSER_ENABLED !== "0" &&
    !!process.env.OPENAI_API_KEY &&
    !regenShortAck;
  const regenResponseControlParse = regenResponseControlParserEligible
    ? await safeLlmParse("regen_response_control_parser", () =>
        parseResponseControlWithLLM({
          text: event.body ?? "",
          history,
          lead: conv.lead
        })
      )
    : null;
  const regenResponseControlAccepted = isResponseControlParserAccepted(regenResponseControlParse);
  const regenLlmComplimentOnly =
    regenResponseControlAccepted && regenResponseControlParse?.intent === "compliment_only";
  const regenLlmExplicitScheduleIntent =
    regenResponseControlAccepted && regenResponseControlParse?.intent === "schedule_request";
  const { reduced: regenReducedConversationState } = await parseAndReduceConversationState({
    conv,
    text: event.body ?? "",
    history,
    shortAck: regenShortAck,
    debugLabel: "regen"
  });
  const regenDispositionDecision = resolveCustomerDispositionDecision(
    event.body,
    regenCustomerDispositionParse
  );
  const regenParsedDispositionAccepted = isDispositionParserAccepted(regenCustomerDispositionParse);
  if (
    canApplyDispositionCloseout({
      conv,
      text: event.body ?? "",
      parsedAccepted: regenParsedDispositionAccepted,
      hasDecision: !!regenDispositionDecision
    }) &&
    regenDispositionDecision
  ) {
    applyCustomerDispositionCloseout(conv, regenDispositionDecision);
    const regenReply = ensureUniqueDispositionReply(buildCustomerDispositionReply(event.body), conv);
    if (channel === "email") {
      return respondWithEmailRegeneratedDraft(regenReply);
    }
    return respondWithSmsRegeneratedDraft(regenReply);
  }

  if (isServiceRecordsRequest(event.body)) {
    const hasServiceTodo = listOpenTodos().some(
      t => t.convId === conv.id && t.reason === "service"
    );
    if (!hasServiceTodo) {
      addTodo(conv, "service", `Service records request: ${event.body}`, event.providerMessageId);
    }
    setDialogState(conv, "service_handoff");
    setFollowUpMode(conv, "manual_handoff", "service_records");
    stopFollowUpCadence(conv, "manual_handoff");
    stopRelatedCadences(conv, "manual_handoff", { setMode: "manual_handoff" });
    const reply =
      "Thanks for the details — I’ll have the team check service records (battery/tires) and follow up. I’ll also keep an eye on availability for early May.";
    if (channel === "email") {
      return respondWithEmailRegeneratedDraft(reply);
    }
    return respondWithSmsRegeneratedDraft(reply);
  }

  if ((regenLlmComplimentOnly || isComplimentOnlyText(event.body)) && !isShortAckText(event.body)) {
    const reply = buildComplimentReply();
    if (channel === "email") {
      return respondWithEmailRegeneratedDraft(reply);
    }
    return respondWithSmsRegeneratedDraft(reply);
  }

  const serviceDialogState = getDialogState(conv);
  const regenInboundDepartmentIntent =
    regenReducedConversationState.departmentIntent ??
    inferDepartmentFromText(event.body ?? "") ??
    (regenUnifiedSlotParse?.departmentIntent && regenUnifiedSlotParse.departmentIntent !== "none"
      ? (regenUnifiedSlotParse.departmentIntent as DepartmentRole)
      : null);
  if (regenInboundDepartmentIntent === "parts" || regenInboundDepartmentIntent === "apparel") {
    conv.classification = {
      ...(conv.classification ?? {}),
      bucket: regenInboundDepartmentIntent,
      cta: `${regenInboundDepartmentIntent}_request`
    };
    const hasDepartmentTodo = listOpenTodos().some(
      t => t.convId === conv.id && t.reason === regenInboundDepartmentIntent
    );
    if (!hasDepartmentTodo) {
      addTodo(
        conv,
        regenInboundDepartmentIntent,
        event.body ?? `${regenInboundDepartmentIntent} request`,
        event.providerMessageId
      );
    }
    setFollowUpMode(conv, "manual_handoff", `${regenInboundDepartmentIntent}_request`);
    stopFollowUpCadence(conv, "manual_handoff");
    stopRelatedCadences(conv, "manual_handoff", { setMode: "manual_handoff" });
    const reply =
      regenInboundDepartmentIntent === "parts"
        ? "Got it — I’ll have our parts department reach out shortly."
        : "Got it — I’ll have our apparel team reach out shortly.";
    if (channel === "email") {
      return respondWithEmailRegeneratedDraft(reply);
    }
    return respondWithSmsRegeneratedDraft(reply);
  }
  const isServiceLead =
    conv.classification?.bucket === "service" ||
    conv.classification?.cta === "service_request" ||
    regenInboundDepartmentIntent === "service" ||
    serviceDialogState === "service_request" ||
    serviceDialogState === "service_handoff" ||
    (conv.followUp?.mode === "manual_handoff" &&
      /service/.test(String(conv.followUp?.reason ?? "")));
  if (isServiceLead) {
    const t = String(event.body ?? "").toLowerCase();
    const complimentRegex =
      /\b(love|like|awesome|amazing|great|cool|nice|sweet|beautiful|killer|badass|sick|clean)\b/.test(t) ||
      /\b(looks great|looks amazing|looks awesome|sounds great)\b/.test(t) ||
      /\b(v&h|short shots?)\b/.test(t) ||
      (/\b(wheels?|exhaust|pipes?|paint|color|trim|bars?|seat)\b/.test(t) &&
        /\b(love|like|awesome|amazing|great|cool|nice|sweet|beautiful|killer|badass|sick|clean)\b/.test(t));
    const complimentLLM =
      (await classifyComplimentWithLLM({
        text: event.body ?? "",
        history: buildHistory(conv, 6)
      })) ?? false;
    if (complimentRegex || complimentLLM) {
      const reply = "Totally — glad you like it.";
      if (channel === "email") {
        return respondWithEmailRegeneratedDraft(reply);
      }
      return respondWithSmsRegeneratedDraft(reply);
    }
    if (/\b(thanks|thank you|thanks again|thx|ty|appreciate)\b/.test(t)) {
      const reply = "You're welcome!";
      if (channel === "email") {
        return respondWithEmailRegeneratedDraft(reply);
      }
      return respondWithSmsRegeneratedDraft(reply);
    }
    if (getDialogState(conv) === "none") {
      setDialogState(conv, "service_request");
    }
    setDialogState(conv, "service_handoff");
    const hasServiceTodo = listOpenTodos().some(
      todo => todo.convId === conv.id && todo.reason === "service"
    );
    if (!hasServiceTodo) {
      addTodo(conv, "service", event.body ?? "Service request", event.providerMessageId);
    }
    setFollowUpMode(conv, "manual_handoff", "service_request");
    stopFollowUpCadence(conv, "manual_handoff");
    stopRelatedCadences(conv, "manual_handoff", { setMode: "manual_handoff" });
    const reply =
      "We’ve received your service request and will have the service department reach out.";
    if (channel === "email") {
      return respondWithEmailRegeneratedDraft(reply);
    }
    return respondWithSmsRegeneratedDraft(reply);
  }

  if (event.provider === "twilio" && channel === "sms") {
    const regenPaymentBudget = resolvePaymentBudgetForConversation(conv, event.body ?? "");
    const regenDownProvided = regenPaymentBudget.downPayment != null;
    const regenMonthlyBudget = regenPaymentBudget.monthlyBudget ?? null;
    const regenTermMonths = regenPaymentBudget.termMonths ?? null;
    const regenInboundAtMs = new Date(event.receivedAt).getTime();
    const lastOutboundBeforeInbound = [...(conv.messages ?? [])]
      .filter(m => m.direction === "out" && m.body)
      .filter(m => {
        if (!Number.isFinite(regenInboundAtMs)) return true;
        const atMs = new Date(m.at ?? "").getTime();
        return !Number.isFinite(atMs) || atMs <= regenInboundAtMs;
      })
      .slice(-1)[0];
    const lastOutboundText = String(lastOutboundBeforeInbound?.body ?? "");
    const askedDownRecently =
      /\b(how much can you put down|how much (?:are|can) you put down|about how much down|how much down|money down|down payment|cash down)\b/i.test(
        lastOutboundText
      );
    if (regenDownProvided && askedDownRecently) {
      const downLabel = `$${Number(regenPaymentBudget.downPayment).toLocaleString("en-US")}`;
      const budgetLabel =
        regenMonthlyBudget != null ? `$${Number(regenMonthlyBudget).toLocaleString("en-US")}/mo` : null;
      const reply =
        regenTermMonths != null
          ? budgetLabel
            ? `Perfect — with ${downLabel} down at ${regenTermMonths} months targeting ${budgetLabel}, I can run the exact numbers now.`
            : `Perfect — with ${downLabel} down at ${regenTermMonths} months, I can run the exact numbers now.`
          : budgetLabel
            ? `Perfect — with ${downLabel} down targeting ${budgetLabel}, do you want me to run 60, 72, or 84 months?`
            : `Perfect — with ${downLabel} down, do you want me to run 60, 72, or 84 months?`;
      return respondWithSmsRegeneratedDraft(reply);
    }

    const regenSchedulingSignals = detectSchedulingSignals(event.body ?? "");
    const regenBody = String(event.body ?? "");
    const visitTimingIntent =
      regenSchedulingSignals.hasDayOnlyRequest ||
      regenSchedulingSignals.softVisit ||
      /\b(next week|this week|tomorrow|later today|this afternoon|come in|stop by|see it)\b/i.test(
        regenBody
      );
    const explicitAvailabilityAskThisTurn = /\b(in[-\s]?stock|available|availability|do you have|have any|any .* in[-\s]?stock|still available)\b/i.test(
      regenBody
    );
    const financeOrRateAskThisTurn = /\b(financing|finance|apr|credit score|monthly|per month|down payment|term|0%\s*apr)\b/i.test(
      regenBody
    );
    const contextModel =
      conv.inventoryContext?.model ?? conv.lead?.vehicle?.model ?? conv.lead?.vehicle?.description ?? null;
    if (visitTimingIntent && contextModel && !financeOrRateAskThisTurn) {
      const modelForLookup = canonicalizeWatchModelLabel(contextModel);
      const contextYear = conv.inventoryContext?.year ?? conv.lead?.vehicle?.year ?? null;
      const contextColor = sanitizeColorPhrase(
        conv.inventoryContext?.color ?? conv.lead?.vehicle?.color ?? null
      );
      const contextFinish = extractTrimToken(conv.inventoryContext?.finish ?? null);
      const contextCondition = normalizeWatchCondition(
        conv.inventoryContext?.condition ?? conv.lead?.vehicle?.condition ?? null
      );
      const suppressContextConditionForYear =
        /\b(19|20)\d{2}\b/.test(String(event.body ?? "")) &&
        !normalizeWatchCondition(String(event.body ?? ""));
      let matches = await findInventoryMatches({ year: contextYear ?? null, model: modelForLookup });
      if (contextCondition && !suppressContextConditionForYear) {
        matches = matches.filter(i => inventoryItemMatchesRequestedCondition(i, contextCondition));
      }
      if (contextColor) {
        const leadColor = String(contextColor);
        const leadTrim: "chrome" | "black" | null = contextFinish;
        matches = matches.filter(i => {
          const itemColor = i.color ?? "";
          if (colorMatchesExact(itemColor, leadColor, leadTrim) || colorMatchesAlias(itemColor, leadColor, leadTrim)) {
            return true;
          }
          const itemNorm = normalizeColorBase(itemColor, !!leadTrim);
          const leadNorm = normalizeColorBase(leadColor, !!leadTrim);
          if (!itemNorm || !leadNorm) return false;
          return itemNorm.includes(leadNorm) || leadNorm.includes(itemNorm);
        });
      }
      const holds = await listInventoryHolds();
      const solds = await listInventorySolds();
      const availableMatches = matches.filter(m => {
        const key = normalizeInventoryHoldKey(m.stockId, m.vin);
        return key ? !holds?.[key] && !solds?.[key] : true;
      });
      const lastAvailabilityOutbound = [...(conv.messages ?? [])]
        .filter(m => m.direction === "out" && typeof m.body === "string")
        .reverse()
        .find(m => /\b(in stock|available right now|still available)\b/i.test(String(m.body ?? "")));
      const recentlyConfirmedAvailable = (() => {
        if (!lastAvailabilityOutbound?.at) return false;
        const sentMs = new Date(lastAvailabilityOutbound.at).getTime();
        if (!Number.isFinite(sentMs)) return false;
        return Date.now() - sentMs <= 2 * 60 * 60 * 1000;
      })();
      const labelYear = contextYear ? `${contextYear} ` : "";
      const labelModel = normalizeDisplayCase(modelForLookup || contextModel);
      const labelColor = contextColor ? ` in ${formatColorLabel(contextColor)}` : "";
      const unitLabel = `${labelYear}${labelModel}${labelColor}`.trim();
      const reply =
        availableMatches.length > 0
          ? explicitAvailabilityAskThisTurn && !recentlyConfirmedAvailable
            ? `Absolutely — next week works. ${unitLabel} is still available right now. What day next week works best for you?`
            : "Absolutely — next week works. What day next week works best for you?"
          : explicitAvailabilityAskThisTurn
            ? `Next week works. I’ll keep an eye on ${unitLabel} and update you right away. What day are you thinking to stop by?`
            : "Next week works. What day are you thinking to stop by?";
      return respondWithSmsRegeneratedDraft(reply);
    }
  }

  if (event.provider === "twilio" && shouldSuppressShortAckDraft(event.body ?? "")) {
    return respondRegenerateSkipped("short_ack_no_action");
  }
  const regenSchedulingSignalsForHint = detectSchedulingSignals(event.body ?? "");
  const regenFinancePriorityHint = hasFinancePrioritySignals(event.body ?? "", conv, {
    lastOutboundText: String(getLastNonVoiceOutbound(conv)?.body ?? "")
  });
  const regenPrimaryIntentHint: "pricing_payments" | "scheduling" | "callback" | "availability" | "general" =
    regenFinancePriorityHint
      ? "pricing_payments"
      : regenSchedulingSignalsForHint.explicit ||
          regenSchedulingSignalsForHint.hasDayTime ||
          regenSchedulingSignalsForHint.hasDayOnlyAvailability ||
          regenSchedulingSignalsForHint.hasDayOnlyRequest
        ? "scheduling"
        : !regenTextingTypoJoke && detectCallbackText(event.body ?? "")
          ? "callback"
          : isExplicitAvailabilityQuestion(event.body ?? "")
            ? "availability"
            : "general";
  const regenPricingIntentHint = regenPrimaryIntentHint === "pricing_payments";
  const regenSchedulingIntentHint = regenPrimaryIntentHint === "scheduling";
  const regenAvailabilityIntentHint = regenPrimaryIntentHint === "availability";
  const regenCallbackIntentHint = regenPrimaryIntentHint === "callback";

  const result = await orchestrateInbound(event, history, {
    appointment: conv.appointment,
    followUp: conv.followUp,
    leadSource: conv.lead?.source ?? null,
    bucket: conv.classification?.bucket ?? null,
    cta: conv.classification?.cta ?? null,
    primaryIntentHint: regenPrimaryIntentHint,
    availabilityIntentHint: regenAvailabilityIntentHint,
    schedulingIntentHint: regenSchedulingIntentHint,
    pricingIntentHint: regenPricingIntentHint,
    financeIntentHint: regenFinancePriorityHint,
    lead: conv.lead ?? null,
    pricingAttempts: getPricingAttempts(conv),
    allowSchedulingOffer: regenLlmExplicitScheduleIntent || isExplicitScheduleIntent(event.body),
    callbackRequestedOverride:
      !regenTextingTypoJoke && (regenCallbackIntentHint || detectCallbackText(event.body ?? "")),
    voiceSummary: getActiveVoiceContext(conv)?.summary ?? null,
    memorySummary,
    memorySummaryShouldUpdate,
    inventoryWatch: conv.inventoryWatch ?? null,
    inventoryWatches: conv.inventoryWatches ?? null,
    financeDocs: conv.financeDocs ?? null,
    tradePayoff: conv.tradePayoff ?? null,
    hold: conv.hold ?? null,
    sale: conv.sale ?? null,
    pickup: conv.pickup ?? null,
    weather: weatherStatus ?? null
  });

  if (!result?.draft || result.shouldRespond === false) {
    return respondRegenerateSkipped("no_draft");
  }

  if (result.pickupUpdate) {
    conv.pickup = { ...(conv.pickup ?? {}), ...result.pickupUpdate, updatedAt: nowIso() };
  }

  const dealerName = dealerProfile?.dealerName ?? "American Harley-Davidson";
  const agentName = resolveRegenSenderName() || dealerProfile?.agentName || "Brooke";
  const firstName = normalizeDisplayCase(conv.lead?.firstName);
  const hasSentOutbound = (conv.messages ?? []).some(
    m =>
      m.direction === "out" &&
      (m.provider === "twilio" || m.provider === "human" || m.provider === "sendgrid")
  );
  const regenIsWalkInLead =
    inferWalkIn(conv) || /traffic log pro/i.test(String(conv.lead?.source ?? ""));
  const enforceInitialAdfPrefixForRegen = (text: string): string => {
    const body = String(text ?? "").trim();
    if (!body) return body;
    const greeting = firstName ? `Hi ${firstName} — ` : "Hi — ";
    const prefix = `${greeting}This is ${agentName} at ${dealerName}.`;
    if (body.toLowerCase().startsWith(prefix.toLowerCase())) {
      return body;
    }
    return `${prefix} ${body}`.trim();
  };
  const lastOutboundTextFinal = getLastNonVoiceOutbound(conv)?.body ?? "";
  let reply = ensureUniqueDraft(result.draft, conv, dealerName, agentName);
  reply = applySlotOfferPolicy(conv, reply, lastOutboundTextFinal);
  reply = applyTradePolicy(conv, reply, lastOutboundTextFinal, result.suggestedSlots);
  reply = applyPickupPolicy(conv, reply);
  reply = applyPricingPolicy(conv, reply, lastOutboundTextFinal, String(event.body ?? ""), {
    pricingActiveThisTurn:
      result.intent === "PRICING" ||
      result.intent === "FINANCING" ||
      isPricingText(String(event.body ?? "")) ||
      isPaymentText(String(event.body ?? ""))
  });
  reply = applyCallbackPolicy(conv, reply, lastOutboundTextFinal);
  reply = applyServicePolicy(conv, reply, lastOutboundTextFinal);
  reply = applySoftSchedulePolicy(conv, reply, String(event.body ?? ""));
  reply = stripYearPreferenceIfAnyYearSpecified(reply, String(event.body ?? ""));
  reply = stripSchedulingLanguageIfNotAsked(reply, String(event.body ?? ""));
  reply = stripNonAdfThanks(reply, event.provider);
  reply = stripCallTimingQuestions(reply);
  reply = stripNonAdfThanks(reply, provider);
  reply = stripNonAdfThanks(reply, event.provider);
  reply = stripCallTimingQuestions(reply);
  reply = stripAgentCallFollowupWhenCustomerWillCall(reply, String(event.body ?? ""));
  if (regenNeedsLienHolderInfo) {
    reply =
      maybeEscalateLienHolderInfoRequest(conv, event, dealerProfile, {
        createTodo: false,
        setManualHandoff: false,
        triggered: true
      }) ?? buildLienHolderFallbackReply(dealerProfile);
  }
  const lienHolderFallback = maybeEscalateLienHolderInfoRequest(conv, event, dealerProfile, {
    createTodo: false,
    setManualHandoff: false
  });
  if (lienHolderFallback) {
    reply = lienHolderFallback;
  }
  if (event.provider === "sendgrid_adf" && !hasSentOutbound) {
    if (!regenIsWalkInLead) {
      reply = enforceInitialAdfPrefixForRegen(reply);
    }
  }
  if (isSlotOfferMessage(reply)) {
    const appointmentType = String(result.requestedAppointmentType ?? "inventory_visit");
    if (appointmentType === "test_ride") {
      setDialogState(conv, "test_ride_offer_sent");
    } else {
      setDialogState(conv, "schedule_offer_sent");
    }
  }
  if (result.suggestedSlots && result.suggestedSlots.length > 0) {
    setLastSuggestedSlots(conv, result.suggestedSlots);
  }
  if (result.memorySummary) {
    setMemorySummary(conv, result.memorySummary, conv.messages.length);
  }
  await seedInventoryWatchPendingFromReply(conv, event, reply);

    if (channel === "email") {
      const invariant = evaluateRegenDraftInvariant(reply);
      if (!invariant.allow) {
        return respondRegenerateSkipped(invariant.reason ?? "draft_invariant_blocked");
      }
      conv.emailDraft = invariant.draftText;
      saveConversation(conv);
      return res.json({
        ok: true,
        conversation: conv,
        draft: invariant.draftText,
        debug: {
          inboundBody: event.body,
          inboundAt: event.receivedAt,
          historyCount: history.length,
          lastDraftAt: lastDraft?.at ?? null
        }
      });
    }

    discardPendingDrafts(conv);
    const published = appendSmsRegeneratedDraft(reply);
    if (!published.ok) {
      return respondRegenerateSkipped(published.reason);
    }
    saveConversation(conv);
    return res.json({
      ok: true,
      conversation: conv,
      draft: published.draft,
      debug: {
        inboundBody: event.body,
        inboundAt: event.receivedAt,
        historyCount: history.length,
        lastDraftAt: lastDraft?.at ?? null
      }
    });
  });

app.post("/conversations/:id/call", async (req, res) => {
  const conv = getConversation(req.params.id);
  if (!conv) return res.status(404).json({ ok: false, error: "Not found" });

  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_FROM_NUMBER;
  if (!accountSid || !authToken || !from) {
    return res.status(500).json({
      ok: false,
      error: "Twilio credentials not configured (TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN/TWILIO_FROM_NUMBER)"
    });
  }

  const dealerProfile = await getDealerProfileHot();
  const user = (req as any).user ?? null;
  const useExtension = req.body?.useExtension === true;
  const userPhoneRaw = String(user?.phone ?? "").trim();
  const userExtRaw = String(user?.extension ?? "").trim();
  const dealerPhoneRaw = String(dealerProfile?.phone ?? "").trim();
  const ownerId = String(user?.id ?? "").trim();
  const ownerNameRaw = String(user?.name ?? user?.email ?? "").trim();
  if (ownerId && (!conv.leadOwner || !conv.leadOwner.id)) {
    conv.leadOwner = {
      id: ownerId,
      name: ownerNameRaw || undefined,
      assignedAt: new Date().toISOString()
    };
  } else if (conv.leadOwner && !conv.leadOwner.name && ownerNameRaw) {
    conv.leadOwner.name = ownerNameRaw;
  }

  let agentTo = "";
  let agentDigits = "";
  if (useExtension) {
    if (!userExtRaw) {
      return res.status(400).json({ ok: false, error: "No extension configured for this user" });
    }
    if (!dealerPhoneRaw) {
      return res.status(400).json({ ok: false, error: "Dealer phone not configured for extensions" });
    }
    agentTo = normalizePhone(dealerPhoneRaw);
    agentDigits = userExtRaw;
  } else if (userPhoneRaw) {
    agentTo = normalizePhone(userPhoneRaw);
  } else if (userExtRaw && dealerPhoneRaw) {
    agentTo = normalizePhone(dealerPhoneRaw);
    agentDigits = userExtRaw;
  }

  if (!agentTo || !agentTo.startsWith("+")) {
    return res.status(400).json({ ok: false, error: "Salesperson phone/extension not configured" });
  }

  const customerRaw = String(conv.lead?.phone ?? conv.leadKey ?? "").trim();
  const customerPhone = normalizePhone(customerRaw);
  if (!customerPhone || !customerPhone.startsWith("+")) {
    return res.status(400).json({ ok: false, error: "Customer phone not available" });
  }

  if (conv.leadOwner) {
    saveConversation(conv);
    await flushConversationStore();
  }

  const publicBase = process.env.PUBLIC_BASE_URL?.replace(/\/+$/, "");
  const baseUrl = publicBase
    ? publicBase
    : `${req.protocol}://${req.get("host")}`;
  const agentName = String(user?.name ?? user?.email ?? "Agent").trim() || "Agent";
  try {
    const cfg = await getSchedulerConfigHot();
    const sp = resolveSalespersonForUser(cfg, user);
    if (sp) {
      setPreferredSalespersonForConv(conv, sp, "voice_call");
    }
  } catch (err: any) {
    console.warn("[scheduler] preferred salesperson resolve failed:", err?.message ?? err);
  }
  const voiceUrl = `${baseUrl}/webhooks/twilio/voice?customer=${encodeURIComponent(
    customerPhone
  )}&leadKey=${encodeURIComponent(conv.leadKey)}${agentDigits ? `&agentDigits=${encodeURIComponent(agentDigits)}` : ""}&agentName=${encodeURIComponent(agentName)}`;

  try {
    const client = twilio(accountSid, authToken);
    const call = await client.calls.create({
      to: agentTo,
      from,
      url: voiceUrl
    });
    appendOutbound(
      conv,
      "system",
      conv.leadKey,
      `Call initiated to ${agentTo}.`,
      "voice_call",
      call.sid
    );
    const callTodos = listOpenTodos().filter(t => t.convId === conv.id && t.reason === "call");
    for (const todo of callTodos) {
      markTodoDone(conv.id, todo.id);
    }
    saveConversation(conv);
    await flushConversationStore();
    return res.json({ ok: true, callSid: call.sid, agentPhone: agentTo, customerPhone });
  } catch (err: any) {
    console.warn("[voice] call start failed:", err?.message ?? err);
    return res.status(500).json({ ok: false, error: "call failed" });
  }
});

app.post("/webhooks/twilio", async (req, res) => {
const authToken = process.env.TWILIO_AUTH_TOKEN;
const signature = req.header("x-twilio-signature");

// If you're behind ngrok, set PUBLIC_BASE_URL to your public URL (no trailing slash).
const publicBase = process.env.PUBLIC_BASE_URL?.replace(/\/+$/, "");
const requestUrl = publicBase
  ? `${publicBase}${req.originalUrl}`
  : `${req.protocol}://${req.get("host")}${req.originalUrl}`;

// Validate ONLY when a signature header is present (Twilio sends it; curl won't)
if (authToken && signature) {
  const ok = twilio.validateRequest(authToken, signature, requestUrl, req.body);
  if (!ok) return res.status(403).json({ ok: false, error: "Invalid Twilio signature" });
}

  const { From, To, Body, MessageSid, SmsSid, NumMedia } = req.body ?? {};

  const fromRaw = String(From ?? "").trim();
  const toRaw = String(To ?? "").trim();
  const from = normalizePhone(fromRaw);
  const to = normalizePhone(toRaw);

  const mediaUrls: string[] = [];
  const mediaItems: Array<{ idx: number; url: string; contentType?: string }> = [];
  const bodyAny = (req.body ?? {}) as Record<string, unknown>;
  const mediaCount = Number.parseInt(String(NumMedia ?? "0"), 10);
  if (Number.isFinite(mediaCount) && mediaCount > 0) {
    for (let i = 0; i < mediaCount; i += 1) {
      const rawUrl = String(bodyAny[`MediaUrl${i}`] ?? "").trim();
      const rawType = String(bodyAny[`MediaContentType${i}`] ?? "").trim();
      if (rawUrl) {
        mediaUrls.push(rawUrl);
        mediaItems.push({ idx: i, url: rawUrl, contentType: rawType || undefined });
      }
    }
  }
  // Fallback: parse any MediaUrlN keys even if NumMedia is missing/incorrect.
  if (!mediaUrls.length) {
    const urlPairs = Object.entries(bodyAny)
      .filter(([k, v]) => /^MediaUrl\d+$/i.test(k) && String(v ?? "").trim().length > 0)
      .map(([k, v]) => ({ idx: Number.parseInt(k.replace(/[^0-9]/g, ""), 10), url: String(v).trim() }))
      .filter(x => Number.isFinite(x.idx) && !!x.url)
      .sort((a, b) => a.idx - b.idx);
    const typeMap = new Map<number, string>();
    for (const [k, v] of Object.entries(bodyAny)) {
      if (!/^MediaContentType\d+$/i.test(k)) continue;
      const idx = Number.parseInt(k.replace(/[^0-9]/g, ""), 10);
      const t = String(v ?? "").trim();
      if (Number.isFinite(idx) && t) typeMap.set(idx, t);
    }
    for (const p of urlPairs) {
      mediaUrls.push(p.url);
      mediaItems.push({ idx: p.idx, url: p.url, contentType: typeMap.get(p.idx) });
    }
  }
  const providerMessageId = String(MessageSid ?? SmsSid ?? "").trim();
  const mediaUrlsForConversation =
    mediaUrls.length > 0
      ? await materializeInboundTwilioMedia(
          mediaItems.length ? mediaItems : mediaUrls.map((u, idx) => ({ idx, url: u })),
          providerMessageId || `mms_${Date.now()}`,
          publicBase || `${req.protocol}://${req.get("host")}`
        )
      : undefined;

  const event: InboundMessageEvent = {
    channel: "sms",
    provider: "twilio",
    from,
    to,
    body: String(Body ?? ""),
    mediaUrls: mediaUrlsForConversation && mediaUrlsForConversation.length ? mediaUrlsForConversation : undefined,
    providerMessageId,
    receivedAt: new Date().toISOString()
  };

  const internalOutcomeHandled = await maybeHandleStaffOutcomeSms(event);
  if (internalOutcomeHandled.handled) {
    const body = String(internalOutcomeHandled.replyBody ?? "").trim();
    const twiml = body
      ? `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n  <Message>${escapeXml(body)}</Message>\n</Response>`
      : `<?xml version="1.0" encoding="UTF-8"?>\n<Response></Response>`;
    return res.status(200).type("text/xml").send(twiml);
  }

  console.log("[twilio inbound]", event);

  const conv = await resolveInboundConversationForSms(event);
  if (isDuplicateInboundEvent(conv, event, { windowMs: 5 * 60 * 1000 })) {
    console.log("[twilio inbound] duplicate ignored", {
      convId: conv.id,
      providerMessageId: event.providerMessageId
    });
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response></Response>`;
    return res.status(200).type("text/xml").send(twiml);
  }
  appendInbound(conv, event);
  const liveManualReconcile = reconcileStateFromRecentManualOutbound(conv, event.receivedAt);
  if (liveManualReconcile.changed) {
    recordRouteOutcome("live", "manual_outbound_reconciled", {
      convId: conv.id,
      leadKey: conv.leadKey,
      reasons: liveManualReconcile.reasons
    });
  }
  const liveEarlyDecision = nextActionFromState({
    provider: event.provider,
    channel: event.channel === "email" ? "email" : "sms",
    isShortAck: shouldSuppressShortAckDraft(event.body ?? "")
  });
  if (liveEarlyDecision.kind === "skip" && liveEarlyDecision.note === "short_ack_no_action") {
    discardPendingDrafts(conv, "short_ack_no_action");
    recordRouteOutcome("live", "short_ack_no_action", {
      convId: conv.id,
      leadKey: conv.leadKey
    });
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response></Response>`;
    return res.status(200).type("text/xml").send(twiml);
  }
  pauseRelatedCadencesOnInbound(conv, event);
  const responseControlParserEligible =
    event.provider === "twilio" &&
    process.env.LLM_ENABLED === "1" &&
    process.env.LLM_RESPONSE_CONTROL_PARSER_ENABLED !== "0" &&
    !!process.env.OPENAI_API_KEY;
  const responseControlParse = responseControlParserEligible
    ? await safeLlmParse("response_control_parser", () =>
        parseResponseControlWithLLM({
          text: event.body ?? "",
          history: buildHistory(conv, 8),
          lead: conv.lead
        })
      )
    : null;
  if (process.env.DEBUG_RESPONSE_CONTROL_PARSER === "1" && responseControlParse) {
    console.log("[llm-response-control-parse]", responseControlParse);
  }
  const responseControlAccepted = isResponseControlParserAccepted(responseControlParse);
  const llmOptOut = responseControlAccepted && responseControlParse?.intent === "opt_out";
  const llmNotInterested = responseControlAccepted && responseControlParse?.intent === "not_interested";
  const llmComplimentOnly = responseControlAccepted && responseControlParse?.intent === "compliment_only";
  const llmExplicitScheduleIntent =
    responseControlAccepted && responseControlParse?.intent === "schedule_request";
  if (getDialogState(conv) === "none" && conv.classification?.bucket === "inventory_interest") {
    setDialogState(conv, "inventory_init");
  }
  let didConfirm = false;
  if (conv.contactPreference === "call_only") {
    if (llmOptOut || isOptOut(event.body)) {
      await suppressRelatedPhones(conv, event, "sms_stop", "twilio");
      stopFollowUpCadence(conv, "opt_out");
      stopRelatedCadences(conv, "opt_out");
    } else if (llmNotInterested || isNotInterested(event.body)) {
      stopFollowUpCadence(conv, "not_interested");
      closeConversation(conv, "not_interested");
      stopRelatedCadences(conv, "not_interested", { close: true });
    }
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response></Response>`;
    return res.status(200).type("text/xml").send(twiml);
  }
  if (conv.mode === "human") {
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response></Response>`;
    return res.status(200).type("text/xml").send(twiml);
  }
  const systemMode = getSystemMode();
  const webhookMode =
    systemMode === "suggest" ? "suggest" : event.provider === "twilio" ? "autopilot" : effectiveMode(conv);
  if (isSuppressed(event.from)) {
    stopFollowUpCadence(conv, "suppressed");
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response></Response>`;
    return res.status(200).type("text/xml").send(twiml);
  }
  if (systemMode === "suggest") {
    discardPendingDrafts(conv, "new_inbound");
  }
  await resetFollowUpCadenceOnInbound(conv, event.body ?? "");
  if (llmOptOut || isOptOut(event.body)) {
    await suppressRelatedPhones(conv, event, "sms_stop", "twilio");
    stopFollowUpCadence(conv, "opt_out");
    stopRelatedCadences(conv, "opt_out");
    const reply = "Understood - I'll stop texting.";
    const systemMode = webhookMode;
    if (systemMode === "suggest") {
      appendOutbound(conv, event.to, event.from, reply, "draft_ai");
      const twiml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response></Response>`;
      return res.status(200).type("text/xml").send(twiml);
    }
    appendOutbound(conv, event.to, event.from, reply, "twilio");
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n  <Message>${escapeXml(
      reply
    )}</Message>\n</Response>`;
    return res.status(200).type("text/xml").send(twiml);
  }
  if (llmNotInterested || isNotInterested(event.body)) {
    stopFollowUpCadence(conv, "not_interested");
    closeConversation(conv, "not_interested");
    stopRelatedCadences(conv, "not_interested", { close: true });
    const reply = "Totally understand - I won't bug you. If anything changes, just let me know.";
    const systemMode = webhookMode;
    if (systemMode === "suggest") {
      appendOutbound(conv, event.to, event.from, reply, "draft_ai");
      const twiml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response></Response>`;
      return res.status(200).type("text/xml").send(twiml);
    }
    appendOutbound(conv, event.to, event.from, reply, "twilio");
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n  <Message>${escapeXml(
      reply
    )}</Message>\n</Response>`;
    return res.status(200).type("text/xml").send(twiml);
  }

  const semanticInboundText = String(event.body ?? "");
  const semanticTextLower = semanticInboundText.toLowerCase();
  const semanticShortAck = isShortAckText(semanticInboundText) || isEmojiOnlyText(semanticInboundText);
  const unifiedSlotRouterEnabled = process.env.LLM_UNIFIED_SLOT_ROUTER_ENABLED === "1";
  const unifiedSlotCompareLogEnabled = process.env.LLM_UNIFIED_SLOT_COMPARE_LOG === "1";
  const semanticSlotParserEligible =
    event.provider === "twilio" &&
    process.env.LLM_ENABLED === "1" &&
    process.env.LLM_SEMANTIC_SLOT_PARSER_ENABLED === "1" &&
    !!process.env.OPENAI_API_KEY &&
    !semanticShortAck;
  const semanticSlotParserHint =
    /\b(let me know|keep me posted|keep an eye out|watch for|notify me|text me|shoot me (a )?text|if you get one|when you get one|as soon as one comes in)\b/i.test(
      semanticTextLower
    ) ||
    /\b(stop|cancel|remove|delete|turn off|pause|disable|no more|don['’]?t|do not)\b/i.test(
      semanticTextLower
    ) ||
    /\b(service|inspection|oil change|maintenance|repair|warranty|headlight|tail ?light|turn signal|led|light bulb|bulb|install|replace|swap|upgrade|parts?|part number|apparel|merch|clothing|jacket|helmet|gloves|boots)\b/i.test(
      semanticTextLower
    ) ||
    /\b(call only|phone only|call me only|no text|do not text|don't text|text me not)\b/i.test(
      semanticTextLower
    ) ||
    /\b(video|walkaround|walk around|walk-through|walkthrough|clip|photo|photos|pic|pics|images?)\b/i.test(
      semanticTextLower
    ) ||
    /(service records?|service history|maintenance records?|maintenance history)/i.test(
      semanticTextLower
    ) ||
    !!conv.inventoryWatch ||
    !!conv.inventoryWatchPending;
  const unifiedSlotParserEligible =
    event.provider === "twilio" &&
    process.env.LLM_ENABLED === "1" &&
    process.env.LLM_UNIFIED_SLOT_PARSER_ENABLED === "1" &&
    !!process.env.OPENAI_API_KEY &&
    !semanticShortAck;
  const unifiedSemanticSlotParse =
    unifiedSlotRouterEnabled && unifiedSlotParserEligible
      ? await safeLlmParse("unified_semantic_slot_parser", () =>
          parseUnifiedSemanticSlotsWithLLM({
            text: semanticInboundText,
            history: buildHistory(conv, 12),
            lead: conv.lead,
            inventoryWatch: conv.inventoryWatch,
            inventoryWatchPending: conv.inventoryWatchPending,
            tradePayoff: conv.tradePayoff,
            dialogState: getDialogState(conv)
          })
        )
      : null;
  if (process.env.DEBUG_UNIFIED_SLOT_PARSER === "1" && unifiedSemanticSlotParse) {
    console.log("[llm-unified-slot-parse]", unifiedSemanticSlotParse);
  }
  const unifiedSemanticOnlyParse: SemanticSlotParse | null = unifiedSemanticSlotParse
    ? {
        watchAction: unifiedSemanticSlotParse.watchAction,
        watch: unifiedSemanticSlotParse.watch,
        departmentIntent: unifiedSemanticSlotParse.departmentIntent,
        contactPreferenceIntent: unifiedSemanticSlotParse.contactPreferenceIntent,
        mediaIntent: unifiedSemanticSlotParse.mediaIntent,
        serviceRecordsIntent: unifiedSemanticSlotParse.serviceRecordsIntent,
        confidence:
          typeof unifiedSemanticSlotParse.watchConfidence === "number"
            ? unifiedSemanticSlotParse.watchConfidence
            : unifiedSemanticSlotParse.confidence
      }
    : null;
  let semanticSlotParse: SemanticSlotParse | null =
    unifiedSlotRouterEnabled && unifiedSemanticOnlyParse
      ? unifiedSemanticOnlyParse
      : null;
  if (!semanticSlotParse && semanticSlotParserEligible) {
    semanticSlotParse = await safeLlmParse("semantic_slot_parser", () =>
      parseSemanticSlotsWithLLM({
        text: semanticInboundText,
        history: buildHistory(conv, 12),
        lead: conv.lead,
        inventoryWatch: conv.inventoryWatch,
        inventoryWatchPending: conv.inventoryWatchPending,
        dialogState: getDialogState(conv)
      })
    );
    if (unifiedSlotRouterEnabled && process.env.DEBUG_UNIFIED_SLOT_PARSER === "1") {
      console.log("[llm-unified-slot-parse] semantic fallback to legacy parser");
    }
  }
  if (unifiedSlotRouterEnabled && unifiedSlotCompareLogEnabled && semanticSlotParserHint) {
    const legacySemanticShadow =
      semanticSlotParserEligible && (!semanticSlotParse || semanticSlotParse === unifiedSemanticOnlyParse)
        ? await safeLlmParse("semantic_slot_parser_legacy_shadow", () =>
            parseSemanticSlotsWithLLM({
              text: semanticInboundText,
              history: buildHistory(conv, 12),
              lead: conv.lead,
              inventoryWatch: conv.inventoryWatch,
              inventoryWatchPending: conv.inventoryWatchPending,
              dialogState: getDialogState(conv)
            })
          )
        : null;
    if (legacySemanticShadow) {
      const mismatch =
        legacySemanticShadow.watchAction !== (unifiedSemanticOnlyParse?.watchAction ?? "none") ||
        legacySemanticShadow.departmentIntent !==
          (unifiedSemanticOnlyParse?.departmentIntent ?? "none") ||
        String(legacySemanticShadow.watch?.model ?? "").toLowerCase() !==
          String(unifiedSemanticOnlyParse?.watch?.model ?? "").toLowerCase() ||
        String(legacySemanticShadow.watch?.year ?? "").toLowerCase() !==
          String(unifiedSemanticOnlyParse?.watch?.year ?? "").toLowerCase() ||
        String(legacySemanticShadow.watch?.color ?? "").toLowerCase() !==
          String(unifiedSemanticOnlyParse?.watch?.color ?? "").toLowerCase() ||
        String(legacySemanticShadow.watch?.condition ?? "unknown").toLowerCase() !==
          String(unifiedSemanticOnlyParse?.watch?.condition ?? "unknown").toLowerCase();
      if (mismatch) {
        console.log("[llm-unified-slot-compare] semantic mismatch", {
          text: semanticInboundText,
          unified: unifiedSemanticOnlyParse,
          legacy: legacySemanticShadow
        });
      }
    }
  }
  if (process.env.DEBUG_SEMANTIC_SLOT_PARSER === "1" && semanticSlotParse) {
    console.log("[llm-semantic-slot-parse]", semanticSlotParse);
  }
  const semanticSlotConfidence =
    typeof semanticSlotParse?.confidence === "number" ? semanticSlotParse.confidence : 0;
  const semanticSlotConfidenceMin = Number(process.env.LLM_SEMANTIC_SLOT_CONFIDENCE_MIN ?? 0.76);
  const semanticSlotAccepted =
    !!semanticSlotParse &&
    semanticSlotConfidence >= semanticSlotConfidenceMin &&
    (semanticSlotParse.watchAction !== "none" ||
      semanticSlotParse.departmentIntent !== "none" ||
      !!semanticSlotParse.watch?.model ||
      !!semanticSlotParse.watch?.year ||
      !!semanticSlotParse.watch?.color ||
      (!!semanticSlotParse.watch?.condition && semanticSlotParse.watch.condition !== "unknown"));
  const semanticWatchAction =
    semanticSlotAccepted && semanticSlotParse ? semanticSlotParse.watchAction : "none";
  const semanticWatch =
    semanticSlotAccepted && semanticSlotParse?.watch ? semanticSlotParse.watch : null;
  const semanticDepartmentIntent =
    semanticSlotAccepted &&
    semanticSlotParse &&
    semanticSlotParse.departmentIntent !== "none"
      ? semanticSlotParse.departmentIntent
      : null;
  const semanticRoutingConfidence =
    typeof semanticSlotParse?.confidence === "number" ? semanticSlotParse.confidence : 0;
  const semanticRoutingConfidenceMin = Number(process.env.LLM_SEMANTIC_ROUTING_CONFIDENCE_MIN ?? 0.72);
  const semanticRoutingAccepted = !!semanticSlotParse && semanticRoutingConfidence >= semanticRoutingConfidenceMin;
  const semanticCallOnlyIntent =
    semanticRoutingAccepted && semanticSlotParse?.contactPreferenceIntent === "call_only";
  const semanticVideoIntent =
    semanticRoutingAccepted &&
    (semanticSlotParse?.mediaIntent === "video" || semanticSlotParse?.mediaIntent === "either");
  const semanticServiceRecordsIntent =
    semanticRoutingAccepted && !!semanticSlotParse?.serviceRecordsIntent;
  const callOnlyRequested =
    !isTextingTypoJokeText(event.body ?? "") &&
    (semanticCallOnlyIntent || isCallOnlyText(event.body));
  const serviceRecordsRequested =
    semanticServiceRecordsIntent || isServiceRecordsRequest(event.body);
  const videoRequested =
    (semanticVideoIntent || isVideoRequest(event.body)) && !serviceRecordsRequested;
  const { reduced: reducedConversationState } = await parseAndReduceConversationState({
    conv,
    text: semanticInboundText,
    history: buildHistory(conv, 10),
    shortAck: semanticShortAck,
    debugLabel: "live"
  });

  if (
    (isWatchAlertStopIntent(event.body) || semanticWatchAction === "stop_watch") &&
    (conv.inventoryWatchPending || conv.inventoryWatch || (conv.inventoryWatches?.length ?? 0) > 0)
  ) {
    await clearInventoryWatchState(conv, "inventory_watch_optout");
    const reply =
      "Got it — we’ll stop inventory watch alerts. If you want alerts again later, just tell me.";
    const systemMode = webhookMode;
    if (systemMode === "suggest") {
      appendOutbound(conv, event.to, event.from, reply, "draft_ai");
      const twiml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response></Response>`;
      return res.status(200).type("text/xml").send(twiml);
    }
    appendOutbound(conv, event.to, event.from, reply, "twilio");
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n  <Message>${escapeXml(
      reply
    )}</Message>\n</Response>`;
    return res.status(200).type("text/xml").send(twiml);
  }

  const customerDispositionParserEligible =
    event.provider === "twilio" &&
    process.env.LLM_ENABLED === "1" &&
    process.env.LLM_CUSTOMER_DISPOSITION_PARSER_ENABLED !== "0" &&
    !!process.env.OPENAI_API_KEY &&
    !semanticShortAck;
  const customerDispositionParse =
    customerDispositionParserEligible
      ? await safeLlmParse("customer_disposition_parser", () =>
          parseCustomerDispositionWithLLM({
            text: semanticInboundText,
            history: buildHistory(conv, 8),
            lead: conv.lead
          })
        )
      : null;
  if (process.env.DEBUG_CUSTOMER_DISPOSITION_PARSER === "1" && customerDispositionParse) {
    console.log("[llm-customer-disposition-parse]", customerDispositionParse);
  }
  const dispositionDecision = resolveCustomerDispositionDecision(
    semanticInboundText,
    customerDispositionParse
  );
  const parsedDispositionAccepted = isDispositionParserAccepted(customerDispositionParse);
  if (
    canApplyDispositionCloseout({
      conv,
      text: semanticInboundText,
      parsedAccepted: parsedDispositionAccepted,
      hasDecision: !!dispositionDecision
    }) &&
    dispositionDecision
  ) {
    applyCustomerDispositionCloseout(conv, dispositionDecision);
    const reply = ensureUniqueDispositionReply(buildCustomerDispositionReply(semanticInboundText), conv);
    const mode = webhookMode;
    if (mode === "suggest") {
      appendOutbound(conv, event.to, event.from, reply, "draft_ai");
      const twiml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response></Response>`;
      return res.status(200).type("text/xml").send(twiml);
    }
    appendOutbound(conv, event.to, event.from, reply, "twilio");
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n  <Message>${escapeXml(
      reply
    )}</Message>\n</Response>`;
    return res.status(200).type("text/xml").send(twiml);
  }

  if (callOnlyRequested) {
    setContactPreference(conv, "call_only");
    setDialogState(conv, "call_only");
    addTodo(conv, "other", event.body ?? "Call only requested", event.providerMessageId);
    setFollowUpMode(conv, "manual_handoff", "call_only");
    stopFollowUpCadence(conv, "manual_handoff");
    stopRelatedCadences(conv, "manual_handoff", { setMode: "manual_handoff" });
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response></Response>`;
    return res.status(200).type("text/xml").send(twiml);
  }

  if (videoRequested) {
    const reply =
      "Got it — I’ll have a salesperson send a walkaround video by text shortly.";
    addTodo(conv, "other", `Video request: ${event.body}`, event.providerMessageId);
    const systemMode = webhookMode;
    if (systemMode === "suggest") {
      appendOutbound(conv, event.to, event.from, reply, "draft_ai");
      const twiml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response></Response>`;
      return res.status(200).type("text/xml").send(twiml);
    }
    appendOutbound(conv, event.to, event.from, reply, "twilio");
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n  <Message>${escapeXml(
      reply
    )}</Message>\n</Response>`;
    return res.status(200).type("text/xml").send(twiml);
  }

  if (serviceRecordsRequested) {
    const hasServiceTodo = listOpenTodos().some(
      t => t.convId === conv.id && t.reason === "service"
    );
    if (!hasServiceTodo) {
      addTodo(conv, "service", `Service records request: ${event.body}`, event.providerMessageId);
    }
    setDialogState(conv, "service_handoff");
    setFollowUpMode(conv, "manual_handoff", "service_records");
    stopFollowUpCadence(conv, "manual_handoff");
    stopRelatedCadences(conv, "manual_handoff", { setMode: "manual_handoff" });
    const reply =
      "Thanks for the details — I’ll have the team check service records (battery/tires) and follow up. I’ll also keep an eye on availability for early May.";
    const systemMode = webhookMode;
    if (systemMode === "suggest") {
      appendOutbound(conv, event.to, event.from, reply, "draft_ai");
      const twiml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response></Response>`;
      return res.status(200).type("text/xml").send(twiml);
    }
    appendOutbound(conv, event.to, event.from, reply, "twilio");
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n  <Message>${escapeXml(
      reply
    )}</Message>\n</Response>`;
    return res.status(200).type("text/xml").send(twiml);
  }

  if (isLienHolderInfoRequestText(event.body ?? "")) {
    const dealerProfileForLien = await getDealerProfileHot();
    const reply = maybeEscalateLienHolderInfoRequest(conv, event, dealerProfileForLien, {
      createTodo: true,
      setManualHandoff: true
    });
    if (reply) {
      const systemMode = webhookMode;
      if (systemMode === "suggest") {
        appendOutbound(conv, event.to, event.from, reply, "draft_ai");
        const twiml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response></Response>`;
        return res.status(200).type("text/xml").send(twiml);
      }
      appendOutbound(conv, event.to, event.from, reply, "twilio");
      const twiml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n  <Message>${escapeXml(
        reply
      )}</Message>\n</Response>`;
      return res.status(200).type("text/xml").send(twiml);
    }
  }

  if ((llmComplimentOnly || isComplimentOnlyText(event.body)) && !isShortAckText(event.body)) {
    const reply = buildComplimentReply();
    const systemMode = webhookMode;
    if (systemMode === "suggest") {
      appendOutbound(conv, event.to, event.from, reply, "draft_ai");
      const twiml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response></Response>`;
      return res.status(200).type("text/xml").send(twiml);
    }
    appendOutbound(conv, event.to, event.from, reply, "twilio");
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n  <Message>${escapeXml(
      reply
    )}</Message>\n</Response>`;
    return res.status(200).type("text/xml").send(twiml);
  }

  const dialogState = getDialogState(conv);
  const inboundDepartmentIntent =
    reducedConversationState.departmentIntent ??
    inferDepartmentFromText(event.body ?? "") ??
    semanticDepartmentIntent;
  if (inboundDepartmentIntent === "parts" || inboundDepartmentIntent === "apparel") {
    conv.classification = {
      ...(conv.classification ?? {}),
      bucket: inboundDepartmentIntent,
      cta: `${inboundDepartmentIntent}_request`
    };
    const hasDepartmentTodo = listOpenTodos().some(
      t => t.convId === conv.id && t.reason === inboundDepartmentIntent
    );
    if (!hasDepartmentTodo) {
      addTodo(
        conv,
        inboundDepartmentIntent,
        event.body ?? `${inboundDepartmentIntent} request`,
        event.providerMessageId
      );
    }
    setFollowUpMode(conv, "manual_handoff", `${inboundDepartmentIntent}_request`);
    stopFollowUpCadence(conv, "manual_handoff");
    stopRelatedCadences(conv, "manual_handoff", { setMode: "manual_handoff" });
    const reply =
      inboundDepartmentIntent === "parts"
        ? "Got it — I’ll have our parts department reach out shortly."
        : "Got it — I’ll have our apparel team reach out shortly.";
    const systemMode = webhookMode;
    if (systemMode === "suggest") {
      appendOutbound(conv, event.to, event.from, reply, "draft_ai");
      const twiml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response></Response>`;
      return res.status(200).type("text/xml").send(twiml);
    }
    appendOutbound(conv, event.to, event.from, reply, "twilio");
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n  <Message>${escapeXml(
      reply
    )}</Message>\n</Response>`;
    return res.status(200).type("text/xml").send(twiml);
  }
  const isServiceLead =
    conv.classification?.bucket === "service" ||
    conv.classification?.cta === "service_request" ||
    inboundDepartmentIntent === "service" ||
    dialogState === "service_request" ||
    dialogState === "service_handoff" ||
    (conv.followUp?.mode === "manual_handoff" &&
      /service/.test(String(conv.followUp?.reason ?? "")));
  if (isServiceLead) {
    const t = String(event.body ?? "").toLowerCase();
    const complimentRegex =
      /\b(love|like|awesome|amazing|great|cool|nice|sweet|beautiful|killer|badass|sick|clean)\b/.test(t) ||
      /\b(looks great|looks amazing|looks awesome|sounds great)\b/.test(t) ||
      /\b(v&h|short shots?)\b/.test(t) ||
      (/\b(wheels?|exhaust|pipes?|paint|color|trim|bars?|seat)\b/.test(t) &&
        /\b(love|like|awesome|amazing|great|cool|nice|sweet|beautiful|killer|badass|sick|clean)\b/.test(t));
    const complimentLLM =
      (await classifyComplimentWithLLM({
        text: event.body ?? "",
        history: buildHistory(conv, 6)
      })) ?? false;
    if (complimentRegex || complimentLLM) {
      const reply = "Totally — glad you like it.";
      const systemMode = webhookMode;
      if (systemMode === "suggest") {
        appendOutbound(conv, event.to, event.from, reply, "draft_ai");
        const twiml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response></Response>`;
        return res.status(200).type("text/xml").send(twiml);
      }
      appendOutbound(conv, event.to, event.from, reply, "twilio");
      const twiml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n  <Message>${escapeXml(
        reply
      )}</Message>\n</Response>`;
      return res.status(200).type("text/xml").send(twiml);
    }
    if (/\b(thanks|thank you|thanks again|thx|ty|appreciate)\b/.test(t)) {
      const reply = "You're welcome!";
      const systemMode = webhookMode;
      if (systemMode === "suggest") {
        appendOutbound(conv, event.to, event.from, reply, "draft_ai");
        const twiml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response></Response>`;
        return res.status(200).type("text/xml").send(twiml);
      }
      appendOutbound(conv, event.to, event.from, reply, "twilio");
      const twiml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n  <Message>${escapeXml(
        reply
      )}</Message>\n</Response>`;
      return res.status(200).type("text/xml").send(twiml);
    }
    if (getDialogState(conv) === "none") {
      setDialogState(conv, "service_request");
    }
    setDialogState(conv, "service_handoff");
    const hasServiceTodo = listOpenTodos().some(
      t => t.convId === conv.id && t.reason === "service"
    );
    if (!hasServiceTodo) {
      addTodo(conv, "service", event.body ?? "Service request", event.providerMessageId);
    }
    setFollowUpMode(conv, "manual_handoff", "service_request");
    stopFollowUpCadence(conv, "manual_handoff");
    stopRelatedCadences(conv, "manual_handoff", { setMode: "manual_handoff" });
    const reply =
      "We’ve received your service request and will have the service department reach out.";
    const systemMode = webhookMode;
    if (systemMode === "suggest") {
      appendOutbound(conv, event.to, event.from, reply, "draft_ai");
      const twiml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response></Response>`;
      return res.status(200).type("text/xml").send(twiml);
    }
    appendOutbound(conv, event.to, event.from, reply, "twilio");
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n  <Message>${escapeXml(
      reply
    )}</Message>\n</Response>`;
    return res.status(200).type("text/xml").send(twiml);
  }

  const isDeferral = (text: string) => {
    const t = String(text ?? "").toLowerCase();
    return (
      /(let me|lemme)\s+(talk|check|see|confirm|ask|figure)/.test(t) ||
      /\btalk to (my )?(wife|husband|spouse|partner)\b/.test(t) ||
      /\bget back to you\b/.test(t) ||
      /\bnot sure\b/.test(t) ||
      /\bmaybe\b/.test(t)
    );
  };
  const isAffirmative = (text: string) => {
    const t = String(text ?? "");
    const lower = t.toLowerCase();
    if (extractTimeToken(t)) return true;
    if (isDeferral(t)) return false;
    const hasSelection = /\b(first|second|earlier|later)\b/i.test(lower);
    const hasConfirm =
      /\b(yes|yep|yeah|yup|sure|confirmed|confirm|that works|works|works for me|sounds good|book it|perfect)\b/i.test(
        lower
      );
    return hasSelection || hasConfirm;
  };

  const schedulingAllowed = !isServiceLead;

  // Auto-reschedule if they confirmed a pending reschedule slot
  if (schedulingAllowed && conv.appointment?.bookedEventId && conv.scheduler?.pendingSlot?.reschedule) {
    if (isDeferral(event.body)) {
      conv.scheduler.pendingSlot = undefined;
    } else {
      const chosen = conv.scheduler.pendingSlot;
      const hasTimeToken = !!extractTimeToken(event.body);
      const matchesPending = hasTimeToken
        ? slotMatchesReply(chosen?.startLocal ?? "", event.body)
        : false;
      if (hasTimeToken && !matchesPending) {
        conv.scheduler.pendingSlot = undefined;
      } else if ((hasTimeToken && matchesPending) || (!hasTimeToken && isAffirmative(event.body))) {
        try {
          const cfg = await getSchedulerConfigHot();
          const tz = cfg.timezone || "America/New_York";
          const cal = await getAuthedCalendarClient();
          const salespeople = cfg.salespeople ?? [];

          const currentSpId = conv.appointment.bookedSalespersonId ?? chosen.salespersonId;
          const currentSp = salespeople.find(p => p.id === currentSpId);
          const targetSp = salespeople.find(p => p.id === chosen.salespersonId) ?? currentSp;
          if (!currentSp || !targetSp) throw new Error("Salesperson not found for reschedule confirm");

          let eventId = conv.appointment.bookedEventId;
          if (currentSp.calendarId !== targetSp.calendarId) {
            const moved = await moveEvent(cal, currentSp.calendarId, eventId, targetSp.calendarId);
            eventId = moved?.id ?? eventId;
          }
          const eventObj = await updateEvent(
            cal,
            targetSp.calendarId,
            eventId,
            tz,
            chosen.start,
            chosen.end
          );

          conv.appointment.status = "confirmed";
          conv.appointment.whenText = chosen.startLocal ?? chosen.start;
          conv.appointment.whenIso = chosen.start;
          conv.appointment.confirmedBy = "customer";
          conv.appointment.updatedAt = new Date().toISOString();
          conv.appointment.acknowledged = true;
          conv.appointment.bookedEventId = eventObj.id ?? eventId;
          conv.appointment.bookedEventLink = eventObj.htmlLink ?? conv.appointment.bookedEventLink;
          conv.appointment.bookedSalespersonId = targetSp.id;
          conv.appointment.reschedulePending = false;
          onAppointmentBooked(conv);

          if (conv.scheduler) {
            conv.scheduler.pendingSlot = undefined;
            conv.scheduler.updatedAt = new Date().toISOString();
          }

          const dealerName =
            (conv as any).dealerProfile?.dealerName ?? "American Harley-Davidson";
          const addressLine = "1149 Erie Ave., North Tonawanda, NY 14120";
          const when = formatSlotLocal(chosen.start, tz);
          const repName =
            chosen?.salespersonName ??
            cfg.salespeople?.find(p => p.id === chosen?.salespersonId)?.name ??
            null;
          const repSuffix = repName ? ` with ${repName}` : "";
          const reply =
            `Perfect — you’re booked for ${when}${repSuffix}. ` +
            `${dealerName} is at ${addressLine}.`;
          const systemMode = webhookMode;
          if (systemMode === "suggest") {
            appendOutbound(conv, event.to, event.from, reply, "draft_ai");
            const twiml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response></Response>`;
            return res.status(200).type("text/xml").send(twiml);
          }
          appendOutbound(conv, event.to, event.from, reply, "twilio", eventObj.id ?? undefined);
          const twiml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n  <Message>${escapeXml(
            reply
          )}</Message>\n</Response>`;
          return res.status(200).type("text/xml").send(twiml);
        } catch (e: any) {
          console.log("[appt-resched-confirm] failed:", e?.message ?? e);
        }
      }
    }
  }

  // Auto-book if they confirmed a pending slot
  if (schedulingAllowed && !conv.appointment?.bookedEventId && conv.scheduler?.pendingSlot) {
    if (isDeferral(event.body)) {
      conv.scheduler.pendingSlot = undefined;
    } else {
      const chosen = conv.scheduler.pendingSlot;
      const hasTimeToken = !!extractTimeToken(event.body);
      const matchesPending = hasTimeToken
        ? slotMatchesReply(chosen?.startLocal ?? "", event.body)
        : false;
      if (hasTimeToken && !matchesPending) {
        conv.scheduler.pendingSlot = undefined;
      } else if ((hasTimeToken && matchesPending) || (!hasTimeToken && isAffirmative(event.body))) {
        try {
          const cfg = await getSchedulerConfigHot();
          const tz = cfg.timezone || "America/New_York";
          const cal = await getAuthedCalendarClient();

          const stockId = conv.lead?.vehicle?.stockId ?? null;
          const leadNameRaw = conv.lead?.name?.trim() ?? "";
          const firstName = normalizeDisplayCase(conv.lead?.firstName);
          const lastName = conv.lead?.lastName ?? "";
          const leadName = leadNameRaw || [firstName, lastName].filter(Boolean).join(" ").trim() || conv.leadKey;
          const appointmentType = chosen.appointmentType ?? "inventory_visit";

          const summary = `Appt: ${appointmentType} – ${leadName}${stockId ? ` – ${stockId}` : ""}`;
          const description = [
            `LeadKey: ${conv.leadKey}`,
            `Phone: ${conv.lead?.phone ?? conv.leadKey}`,
            `Email: ${conv.lead?.email ?? ""}`,
            `FirstName: ${firstName ?? ""}`,
            `LastName: ${lastName ?? ""}`,
            `Stock: ${stockId ?? ""}`,
            `VIN: ${conv.lead?.vehicle?.vin ?? ""}`,
            `Source: ${conv.lead?.source ?? ""}`,
            `VisitType: ${appointmentType}`
          ]
            .filter(Boolean)
            .join("\n");

          const colorId = getAppointmentTypeColorId(cfg, appointmentType);
          const created = await insertEvent(
            cal,
            chosen.calendarId,
            tz,
            summary,
            description,
            chosen.start,
            chosen.end,
            colorId
          );

          conv.appointment = conv.appointment ?? { status: "none", updatedAt: new Date().toISOString() };
          conv.appointment.status = "confirmed";
          conv.appointment.whenText = chosen.startLocal ?? chosen.start;
          conv.appointment.whenIso = chosen.start;
          conv.appointment.confirmedBy = "customer";
          conv.appointment.updatedAt = new Date().toISOString();
          conv.appointment.acknowledged = true;
          conv.appointment.bookedEventId = created.id ?? null;
          conv.appointment.bookedEventLink = created.htmlLink ?? null;
          conv.appointment.bookedSalespersonId = chosen.salespersonId ?? null;
          conv.appointment.matchedSlot = chosen;
          conv.appointment.reschedulePending = false;
          onAppointmentBooked(conv);

          if (conv.scheduler) {
            conv.scheduler.pendingSlot = undefined;
            conv.scheduler.updatedAt = new Date().toISOString();
          }

          console.log("[auto-book] chosen slot", chosen?.startLocal, chosen?.calendarId);
          console.log("[auto-book] booked", created?.id, "calendarId", chosen.calendarId);

          const repName =
            chosen?.salespersonName ??
            cfg.salespeople?.find(p => p.id === chosen?.salespersonId)?.name ??
            null;
          const repSuffix = repName ? ` with ${repName}` : "";
          const reply = `Perfect — you’re all set for ${conv.appointment.whenText}${repSuffix}. See you then.`;
          const systemMode = webhookMode;
          if (systemMode === "suggest") {
            appendOutbound(conv, event.to, event.from, reply, "draft_ai");
            saveConversation(conv);
            await flushConversationStore();
            const twiml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response></Response>`;
            return res.status(200).type("text/xml").send(twiml);
          }
          appendOutbound(conv, event.to, event.from, reply, "twilio", created.id ?? undefined);
          saveConversation(conv);
          await flushConversationStore();
          const twiml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n  <Message>${escapeXml(
            reply
          )}</Message>\n</Response>`;
          return res.status(200).type("text/xml").send(twiml);
        } catch (e: any) {
          console.log("[auto-book] failed:", e?.message ?? e);
        }
      }
    }
  }

  // Auto-book if they accept a suggested slot
  if (
    schedulingAllowed &&
    !conv.appointment?.bookedEventId &&
    Array.isArray(conv.scheduler?.lastSuggestedSlots) &&
    conv.scheduler.lastSuggestedSlots.length > 0
  ) {
    console.log("[auto-book] inbound:", JSON.stringify(event.body));
    console.log(
      "[auto-book] lastSuggestedSlots:",
      conv.scheduler?.lastSuggestedSlots?.map(s => s.startLocal) ?? []
    );
    const chosen = chooseSlotFromReply(conv.scheduler.lastSuggestedSlots, event.body);
    if (chosen) {
      console.log("[auto-book] chosen slot", chosen?.startLocal, chosen?.calendarId);
      try {
        const cfg = await getSchedulerConfigHot();
        const tz = cfg.timezone || "America/New_York";
        const cal = await getAuthedCalendarClient();

        const stockId = conv.lead?.vehicle?.stockId ?? null;
        const leadNameRaw = conv.lead?.name?.trim() ?? "";
        const firstName = normalizeDisplayCase(conv.lead?.firstName);
        const lastName = conv.lead?.lastName ?? "";
        const leadName = leadNameRaw || [firstName, lastName].filter(Boolean).join(" ").trim() || conv.leadKey;
        const appointmentType = chosen.appointmentType ?? "inventory_visit";

        const summary = `Appt: ${appointmentType} – ${leadName}${stockId ? ` – ${stockId}` : ""}`;
        const description = [
          `LeadKey: ${conv.leadKey}`,
          `Phone: ${conv.lead?.phone ?? conv.leadKey}`,
          `Email: ${conv.lead?.email ?? ""}`,
          `FirstName: ${firstName ?? ""}`,
          `LastName: ${lastName ?? ""}`,
          `Stock: ${stockId ?? ""}`,
          `VIN: ${conv.lead?.vehicle?.vin ?? ""}`,
          `Source: ${conv.lead?.source ?? ""}`,
          `VisitType: ${appointmentType}`
        ]
          .filter(Boolean)
          .join("\n");

        const colorId = getAppointmentTypeColorId(cfg, appointmentType);
        const created = await insertEvent(
          cal,
          chosen.calendarId,
          tz,
          summary,
          description,
          chosen.start,
          chosen.end,
          colorId
        );

        conv.appointment = conv.appointment ?? { status: "none", updatedAt: new Date().toISOString() };
        conv.appointment.status = "confirmed";
        conv.appointment.whenText = chosen.startLocal ?? chosen.start;
        conv.appointment.whenIso = chosen.start;
        conv.appointment.confirmedBy = "customer";
        conv.appointment.updatedAt = new Date().toISOString();
        conv.appointment.acknowledged = true;
        conv.appointment.bookedEventId = created.id ?? null;
        conv.appointment.bookedEventLink = created.htmlLink ?? null;
        conv.appointment.bookedSalespersonId = chosen.salespersonId ?? null;
        conv.appointment.matchedSlot = chosen;
        conv.appointment.reschedulePending = false;
        onAppointmentBooked(conv);

        if (conv.scheduler) {
          conv.scheduler.pendingSlot = undefined;
          conv.scheduler.updatedAt = new Date().toISOString();
        }

        console.log("[auto-book] booked", created?.id, "calendarId", chosen.calendarId);

        const repName =
          chosen?.salespersonName ??
          cfg.salespeople?.find(p => p.id === chosen?.salespersonId)?.name ??
          null;
        const repSuffix = repName ? ` with ${repName}` : "";
        const reply = `Perfect — you’re all set for ${conv.appointment.whenText}${repSuffix}. See you then.`;
        const systemMode = webhookMode;
        if (systemMode === "suggest") {
          appendOutbound(conv, event.to, event.from, reply, "draft_ai");
          saveConversation(conv);
          await flushConversationStore();
          const twiml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response></Response>`;
          return res.status(200).type("text/xml").send(twiml);
        }
        appendOutbound(conv, event.to, event.from, reply, "twilio", created.id ?? undefined);
        saveConversation(conv);
        await flushConversationStore();
        const twiml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n  <Message>${escapeXml(
          reply
        )}</Message>\n</Response>`;
        return res.status(200).type("text/xml").send(twiml);
      } catch (e: any) {
        console.log("[auto-book] failed:", e?.message ?? e);
      }
    }
  }

  // 24-hour appointment confirmation replies (YES/NO)
  if (
    conv.appointment?.bookedEventId &&
    conv.appointment?.confirmation?.status === "pending" &&
    conv.appointment?.confirmation?.sentAt
  ) {
    const text = (event.body || "").trim().toLowerCase();
    const isYes = /\b(yes|yep|yeah|yup|confirm|confirmed|ok|okay|sure)\b/.test(text);
    const isNo = /\b(no|nope|nah|cancel|reschedule)\b/.test(text);
    if (isYes || isNo) {
      let tz = "America/New_York";
      conv.appointment.confirmation = {
        ...conv.appointment.confirmation,
        status: isYes ? "confirmed" : "declined",
        respondedAt: new Date().toISOString()
      };
      if (isNo) {
        try {
          const cfg = await getSchedulerConfigHot();
          tz = cfg.timezone;
          const cal = await getAuthedCalendarClient();
          const calendarId =
            cfg.salespeople?.find(p => p.id === conv.appointment?.bookedSalespersonId)?.calendarId ??
            conv.appointment?.matchedSlot?.calendarId ??
            "";
          if (calendarId) {
            await updateEventDetails(cal, calendarId, conv.appointment.bookedEventId, cfg.timezone, {
              status: "cancelled"
            });
          }
        } catch (e: any) {
          console.log("[appt-confirm] cancel failed:", e?.message ?? e);
        }
        conv.appointment.status = "none";
        conv.appointment.whenText = undefined;
        conv.appointment.whenIso = null;
        conv.appointment.confirmedBy = undefined;
        conv.appointment.bookedEventId = null;
        conv.appointment.bookedEventLink = null;
        conv.appointment.bookedSalespersonId = null;
        conv.appointment.acknowledged = true;
        conv.appointment.reschedulePending = true;
      }
      if (isYes) {
        try {
          const cfg = await getSchedulerConfigHot();
          tz = cfg.timezone;
        } catch {}
      }
      const when = conv.appointment?.whenIso ? formatSlotLocal(conv.appointment.whenIso, tz) : null;
      const reply = isYes
        ? `Thanks — you’re all set for ${when ?? "your appointment"}. See you then.`
        : "No problem — I’ve cancelled it. What day and time works to reschedule?";
      const systemMode = webhookMode;
      if (systemMode === "suggest") {
        appendOutbound(conv, event.to, event.from, reply, "draft_ai");
        const twiml = `<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<Response></Response>`;
        return res.status(200).type("text/xml").send(twiml);
      }
      appendOutbound(conv, event.to, event.from, reply, "twilio");
      const twiml = `<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<Response>\n  <Message>${escapeXml(
        reply
      )}</Message>\n</Response>`;
      return res.status(200).type("text/xml").send(twiml);
    }
  }
  didConfirm = confirmAppointmentIfMatchesSuggested(conv, event.body, event.providerMessageId);
  updateHoldingFromInbound(conv, event.body);

  const isUsed =
    conv.lead?.vehicle?.condition === "used" ||
    (!!conv.lead?.vehicle?.stockId && /^u/i.test(conv.lead?.vehicle?.stockId ?? "")) ||
    /\bU[A-Z0-9]{0,4}-\d{1,4}\b/i.test(event.body);
  if (isUsed && isPendingComplaint(event.body)) {
    const ack =
      "Thanks for the heads-up — I’m going to have a salesperson check the sale‑pending status and follow up shortly.";
    addTodo(conv, "other", event.body, event.providerMessageId);
    setFollowUpMode(conv, "manual_handoff", "pending_used_followup");
    stopFollowUpCadence(conv, "manual_handoff");
    stopRelatedCadences(conv, "manual_handoff", { setMode: "manual_handoff" });
    const systemMode = webhookMode;
    if (systemMode === "suggest") {
      appendOutbound(conv, event.to, event.from, ack, "draft_ai");
      const twiml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response></Response>`;
      return res.status(200).type("text/xml").send(twiml);
    }
    appendOutbound(conv, event.to, event.from, ack, "twilio");
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n  <Message>${escapeXml(
      ack
    )}</Message>\n</Response>`;
    return res.status(200).type("text/xml").send(twiml);
  }

  const reschedulePending = conv.appointment?.reschedulePending === true;
  const reschedulePhrase = /(reschedule|change the time|change time|another time|can't make|cant make|move it|push it|different time)/i.test(
    event.body
  );
  let requestedReschedule: ReturnType<typeof parseRequestedDayTime> | null = null;
  if (conv.appointment?.bookedEventId) {
    const cfg = await getSchedulerConfigHot();
    const appointmentTypes = cfg.appointmentTypes ?? { inventory_visit: { durationMinutes: 60 } };
    const preferredSalespeople = getPreferredSalespeopleForConv(cfg, conv);
    const salespeople = cfg.salespeople ?? [];
    const gapMinutes = cfg.minGapBetweenAppointmentsMinutes ?? 60;
    requestedReschedule = parseRequestedDayTime(event.body, cfg.timezone);
    if (!requestedReschedule && conv.appointment.whenIso) {
      const token = extractTimeToken(event.body);
      if (token) {
        const baseParts = getLocalDateParts(new Date(conv.appointment.whenIso), cfg.timezone);
        const timeParts = parseTimeTokenToParts(token, baseParts.hour);
        if (timeParts) {
          const dayBase = localPartsToUtcDate(cfg.timezone, {
            year: baseParts.year,
            month: baseParts.month,
            day: baseParts.day,
            hour24: 12,
            minute: 0
          });
          requestedReschedule = {
            year: baseParts.year,
            month: baseParts.month,
            day: baseParts.day,
            hour24: timeParts.hour24,
            minute: timeParts.minute,
            dayOfWeek: dayKey(dayBase, cfg.timezone)
          };
        }
      }
    }
    const rescheduleIntent =
      !isFinanceDocsQuestionText(event.body) &&
      (reschedulePending ||
        reschedulePhrase ||
        !!requestedReschedule ||
        llmExplicitScheduleIntent ||
        isExplicitScheduleIntent(event.body));
    if (!rescheduleIntent) {
      // fall through
    } else {
      const requested = requestedReschedule;
    if (!requested) {
      const ask = "Absolutely — what day and time works for you?";
      conv.appointment.reschedulePending = true;
      conv.appointment.updatedAt = new Date().toISOString();
      const systemMode = webhookMode;
      if (systemMode === "suggest") {
        appendOutbound(conv, event.to, event.from, ask, "draft_ai");
        const twiml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response></Response>`;
        return res.status(200).type("text/xml").send(twiml);
      }
      appendOutbound(conv, event.to, event.from, ask, "twilio");
      const twiml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n  <Message>${escapeXml(
        ask
      )}</Message>\n</Response>`;
      return res.status(200).type("text/xml").send(twiml);
    }

    try {
      const cal = await getAuthedCalendarClient();
      const appointmentType = "inventory_visit";
      const durationMinutes = appointmentTypes[appointmentType]?.durationMinutes ?? 60;

      const primarySalespersonId = conv.appointment.bookedSalespersonId ?? preferredSalespeople[0];
      const primarySp = salespeople.find((p: any) => p.id === primarySalespersonId);
      if (!primarySp) throw new Error("Salesperson not found for reschedule");

      const timeMin = new Date().toISOString();
      const timeMax = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();
      const candidateSalespeople = [
        primarySalespersonId,
        ...preferredSalespeople.filter(id => id !== primarySalespersonId)
      ];

      let exactMatch: { exact: any; sp: any } | null = null;
      let expandedPrimary: any[] | null = null;
      for (const spId of candidateSalespeople) {
        const sp = salespeople.find((p: any) => p.id === spId);
        if (!sp) continue;
        const fb = await queryFreeBusy(cal, [sp.calendarId], timeMin, timeMax, cfg.timezone);
        let busy = (fb.calendars?.[sp.calendarId]?.busy ?? []) as any[];
        if (conv.appointment.whenIso && sp.id === primarySalespersonId) {
          const oldStart = new Date(conv.appointment.whenIso);
          const oldEnd = new Date(oldStart.getTime() + durationMinutes * 60_000);
          busy = busy.filter(b => !(new Date(b.start) < oldEnd && oldStart < new Date(b.end)));
        }
        const expanded = expandBusyBlocks(busy as any, gapMinutes);
        if (sp.id === primarySalespersonId) expandedPrimary = expanded;
        const exact = findExactSlotForSalesperson(
          cfg,
          sp.id,
          sp.calendarId,
          requested,
          durationMinutes,
          expanded
        );
        if (exact) {
          exactMatch = { exact, sp };
          break;
        }
      }

      if (exactMatch) {
        const systemMode = webhookMode;
        const when = formatSlotLocal(exactMatch.exact.start, cfg.timezone);
        const repName = exactMatch.sp.name ? ` with ${exactMatch.sp.name}` : "";
        if (systemMode === "suggest") {
          conv.scheduler = conv.scheduler ?? { updatedAt: new Date().toISOString() };
          conv.scheduler.pendingSlot = {
            salespersonId: exactMatch.sp.id,
            salespersonName: exactMatch.sp.name,
            calendarId: exactMatch.sp.calendarId,
            start: exactMatch.exact.start,
            end: exactMatch.exact.end,
            startLocal: when,
            endLocal: formatSlotLocal(exactMatch.exact.end, cfg.timezone),
            appointmentType,
            reschedule: true
          };
          conv.scheduler.updatedAt = new Date().toISOString();
          conv.appointment.reschedulePending = true;
          conv.appointment.matchedSlot = {
            salespersonId: exactMatch.sp.id,
            salespersonName: exactMatch.sp.name,
            calendarId: exactMatch.sp.calendarId,
            start: exactMatch.exact.start,
            end: exactMatch.exact.end,
            startLocal: when,
            endLocal: formatSlotLocal(exactMatch.exact.end, cfg.timezone),
            appointmentType
          };
          conv.appointment.updatedAt = new Date().toISOString();
          const ask = `I can move you to ${when}${repName}. Want me to lock that in?`;
          appendOutbound(conv, event.to, event.from, ask, "draft_ai");
          const twiml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response></Response>`;
          return res.status(200).type("text/xml").send(twiml);
        }

        const sameCalendar = exactMatch.sp.id === primarySalespersonId;
        let eventId = conv.appointment.bookedEventId;
        if (!sameCalendar) {
          const moved = await moveEvent(
            cal,
            primarySp.calendarId,
            conv.appointment.bookedEventId,
            exactMatch.sp.calendarId
          );
          eventId = moved?.id ?? eventId;
        }
        const eventObj = await updateEvent(
          cal,
          exactMatch.sp.calendarId,
          eventId,
          cfg.timezone,
          exactMatch.exact.start,
          exactMatch.exact.end
        );

        conv.appointment.status = "confirmed";
        conv.appointment.whenText = formatSlotLocal(exactMatch.exact.start, cfg.timezone);
        conv.appointment.whenIso = exactMatch.exact.start;
        conv.appointment.confirmedBy = "customer";
        conv.appointment.updatedAt = new Date().toISOString();
        conv.appointment.acknowledged = true;
        conv.appointment.bookedEventId = eventObj.id ?? eventId;
        conv.appointment.bookedEventLink = eventObj.htmlLink ?? conv.appointment.bookedEventLink;
        conv.appointment.bookedSalespersonId = exactMatch.sp.id;
        conv.appointment.reschedulePending = false;
        onAppointmentBooked(conv);

        const dealerName =
          (conv as any).dealerProfile?.dealerName ?? "American Harley-Davidson";
        const addressLine = "1149 Erie Ave., North Tonawanda, NY 14120";
        const confirmText =
          `Perfect — you’re booked for ${when}${repName}. ` +
          `${dealerName} is at ${addressLine}.`;
        appendOutbound(conv, event.to, event.from, confirmText, "twilio", eventObj.id ?? undefined);
        const twiml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n  <Message>${escapeXml(
          confirmText
        )}</Message>\n</Response>`;
        return res.status(200).type("text/xml").send(twiml);
      }

      const candidatesByDay = generateCandidateSlots(cfg, new Date(), durationMinutes, 14);
      const requestedStartUtc = localPartsToUtcDate(cfg.timezone, requested);
      const requestedDayKey = requested.dayOfWeek;

      const sameDay = candidatesByDay.filter(d => dayKey(d.dayStart, cfg.timezone) === requestedDayKey);
      const pool = sameDay.length > 0 ? sameDay : candidatesByDay;
      const flat = pool.flatMap(d => d.candidates);
      const expanded = expandedPrimary ?? [];
      const available = flat.filter(c => !expanded.some(b => c.start < b.end && b.start < c.end));
      available.sort(
        (a, b) =>
          Math.abs(a.start.getTime() - requestedStartUtc.getTime()) -
          Math.abs(b.start.getTime() - requestedStartUtc.getTime())
      );
      const picked = available.slice(0, 2).map(s => ({
        salespersonId: primarySp.id,
        salespersonName: primarySp.name,
        calendarId: primarySp.calendarId,
        start: s.start.toISOString(),
        end: s.end.toISOString(),
        startLocal: formatSlotLocal(s.start.toISOString(), cfg.timezone),
        endLocal: formatSlotLocal(s.end.toISOString(), cfg.timezone),
        appointmentType
      }));

      if (picked.length >= 2) {
        setLastSuggestedSlots(conv, picked);
        console.log(
          "[scheduler] persisted lastSuggestedSlots",
          picked.length,
          "leadKey",
          conv.leadKey
        );
        console.log("[scheduler] persisted lastSuggestedSlots len:", picked.length);
        console.log(
          "[scheduler] persisted lastSuggestedSlots preview:",
          picked.slice(0, 2).map(s => s.startLocal)
        );
        conv.appointment.reschedulePending = true;
        conv.appointment.updatedAt = new Date().toISOString();
        const reply = `I can reschedule you. I have ${picked[0].startLocal} or ${picked[1].startLocal} — do any of these times work?`;
        const systemMode = webhookMode;
        if (systemMode === "suggest") {
          appendOutbound(conv, event.to, event.from, reply, "draft_ai");
          saveConversation(conv);
          console.log(
            "[scheduler] saving convo before flush",
            "leadKey",
            conv.leadKey,
            "len",
            conv.scheduler?.lastSuggestedSlots?.length ?? 0
          );
          console.log("[scheduler] flushing store path:", getConversationStorePath());
          if (getConversationStorePath() !== "/home/ubuntu/throttleiq-runtime/data/conversations.json") {
            console.log(
              "[scheduler] WARN expected CONVERSATIONS_DB_PATH /home/ubuntu/throttleiq-runtime/data/conversations.json"
            );
          }
          await flushConversationStore();
          console.log(
            "[scheduler] saved lastSuggestedSlots len:",
            conv.scheduler?.lastSuggestedSlots?.length ?? 0,
            "leadKey",
            conv.leadKey
          );
          const twiml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response></Response>`;
          return res.status(200).type("text/xml").send(twiml);
        }
        appendOutbound(conv, event.to, event.from, reply, "twilio");
        saveConversation(conv);
        console.log(
          "[scheduler] saving convo before flush",
          "leadKey",
          conv.leadKey,
          "len",
          conv.scheduler?.lastSuggestedSlots?.length ?? 0
        );
        console.log("[scheduler] flushing store path:", getConversationStorePath());
        if (getConversationStorePath() !== "/home/ubuntu/throttleiq-runtime/data/conversations.json") {
          console.log(
            "[scheduler] WARN expected CONVERSATIONS_DB_PATH /home/ubuntu/throttleiq-runtime/data/conversations.json"
          );
        }
        await flushConversationStore();
        console.log(
          "[scheduler] saved lastSuggestedSlots len:",
          conv.scheduler?.lastSuggestedSlots?.length ?? 0,
          "leadKey",
          conv.leadKey
        );
        const twiml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n  <Message>${escapeXml(
          reply
        )}</Message>\n</Response>`;
        return res.status(200).type("text/xml").send(twiml);
      }
      const dayName = requested.dayOfWeek.charAt(0).toUpperCase() + requested.dayOfWeek.slice(1);
      const hh = String(requested.hour24).padStart(2, "0");
      const mm = String(requested.minute).padStart(2, "0");
      const timeText = formatTime12h(`${hh}:${mm}`);
      const reply =
        `I can try ${dayName} at ${timeText}. ` +
        "If that doesn't work, what other time could you do?";
      conv.appointment.reschedulePending = true;
      conv.appointment.updatedAt = new Date().toISOString();
      const systemMode = webhookMode;
      if (systemMode === "suggest") {
        appendOutbound(conv, event.to, event.from, reply, "draft_ai");
        const twiml = `<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<Response></Response>`;
        return res.status(200).type("text/xml").send(twiml);
      }
      appendOutbound(conv, event.to, event.from, reply, "twilio");
      const twiml = `<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<Response>\n  <Message>${escapeXml(
        reply
      )}</Message>\n</Response>`;
      return res.status(200).type("text/xml").send(twiml);
    } catch (e: any) {
      console.log("[reschedule] failed:", e?.message ?? e);
    }
    }
  }

  const lastOutboundBeforeConflict = getLastNonVoiceOutbound(conv)?.body ?? "";
  const scheduleConflictNoBooking =
    !conv.appointment?.bookedEventId &&
    detectScheduleConflictWithoutAlternative(event.body) &&
    hasScheduleOfferContext(lastOutboundBeforeConflict, getDialogState(conv));
  if (scheduleConflictNoBooking) {
    const reply = "No problem — what day and time works better for you?";
    setDialogState(conv, "schedule_request");
    const systemMode = webhookMode;
    if (systemMode === "suggest") {
      appendOutbound(conv, event.to, event.from, reply, "draft_ai");
      const twiml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response></Response>`;
      return res.status(200).type("text/xml").send(twiml);
    }
    appendOutbound(conv, event.to, event.from, reply, "twilio");
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n  <Message>${escapeXml(
      reply
    )}</Message>\n</Response>`;
    return res.status(200).type("text/xml").send(twiml);
  }

  // Reschedule flow: if they pick one of our suggested slots, update the existing event
  if (
    didConfirm &&
    conv.appointment?.matchedSlot &&
    conv.appointment.bookedEventId &&
    conv.appointment.reschedulePending
  ) {
    try {
      const cfg = await getSchedulerConfigHot();
      const salespeople = cfg.salespeople ?? [];
      const cal = await getAuthedCalendarClient();
      const slot = conv.appointment.matchedSlot;
      const appointmentType = String(slot?.appointmentType ?? "inventory_visit");
      const salespersonId = conv.appointment.bookedSalespersonId ?? slot.salespersonId;
      const sp = salespeople.find((p: any) => p.id === salespersonId);
      if (!sp) throw new Error("Salesperson not found for reschedule");

      const eventObj = await updateEvent(
        cal,
        sp.calendarId,
        conv.appointment.bookedEventId,
        cfg.timezone,
        slot.start,
        slot.end
      );

      conv.appointment.status = "confirmed";
      conv.appointment.whenText = formatSlotLocal(slot.start, cfg.timezone);
      conv.appointment.whenIso = slot.start;
      conv.appointment.confirmedBy = "customer";
      conv.appointment.updatedAt = new Date().toISOString();
      conv.appointment.acknowledged = true;
      conv.appointment.bookedEventId = eventObj.id ?? conv.appointment.bookedEventId;
      conv.appointment.bookedEventLink = eventObj.htmlLink ?? conv.appointment.bookedEventLink;
      conv.appointment.bookedSalespersonId = sp.id;
      conv.appointment.reschedulePending = false;
      onAppointmentBooked(conv);

      if (conv.scheduler) {
        conv.scheduler.lastSuggestedSlots = [];
        conv.scheduler.updatedAt = new Date().toISOString();
      }

      const dealerName =
        (conv as any).dealerProfile?.dealerName ?? "American Harley-Davidson";
      const addressLine = "1149 Erie Ave., North Tonawanda, NY 14120";
      const when = formatSlotLocal(slot.start, cfg.timezone);
      const repName = sp.name ? ` with ${sp.name}` : "";
      const confirmText =
        `Perfect — you’re booked for ${when}${repName}. ` +
        `${dealerName} is at ${addressLine}.`;

      const systemMode = webhookMode;
      if (systemMode === "suggest") {
        appendOutbound(conv, event.to, event.from, confirmText, "draft_ai");
        const twiml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response></Response>`;
        return res.status(200).type("text/xml").send(twiml);
      }

      appendOutbound(conv, event.to, event.from, confirmText, "twilio", eventObj.id ?? undefined);
      const twiml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n  <Message>${escapeXml(
        confirmText
      )}</Message>\n</Response>`;
      return res.status(200).type("text/xml").send(twiml);
    } catch (e: any) {
      console.log("[reschedule-confirm] failed:", e?.message ?? e);
    }
  }

  // If customer selected one of our suggested slots, auto-book immediately (Option B)
  if (didConfirm && conv.appointment?.matchedSlot && !conv.appointment.bookedEventId) {
    try {
      const cfg = await getSchedulerConfigHot();
      const cal = await getAuthedCalendarClient();

      const slot = conv.appointment.matchedSlot;
      const appointmentType = String(slot?.appointmentType ?? "inventory_visit");

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
        `Source: ${conv.lead?.source ?? ""}`,
        `VisitType: ${appointmentType}`
      ]
        .filter(Boolean)
        .join("\n");

      const colorId = getAppointmentTypeColorId(cfg, appointmentType);
      const eventObj = await insertEvent(
        cal,
        slot.calendarId,
        cfg.timezone,
        summary,
        description,
        slot.start,
        slot.end,
        colorId
      );

      // Mark appointment as truly booked
      conv.appointment.status = "confirmed";
      conv.appointment.bookedEventId = eventObj.id ?? null;
      conv.appointment.bookedEventLink = eventObj.htmlLink ?? null;
      conv.appointment.bookedSalespersonId = slot.salespersonId ?? null;
      conv.appointment.acknowledged = true;
      conv.appointment.reschedulePending = false;
      onAppointmentBooked(conv);
      if (appointmentType === "test_ride") {
        setDialogState(conv, "test_ride_booked");
      } else {
        setDialogState(conv, "schedule_booked");
      }

      // Build confirmation message (SMS)
      const dealerName =
        (conv as any).dealerProfile?.dealerName ?? "American Harley-Davidson";
      const addressLine = "1149 Erie Ave., North Tonawanda, NY 14120";

      const when = slot.startLocal ?? "the selected time";
      const repName = slot.salespersonName ? ` with ${slot.salespersonName}` : "";

      const confirmText =
        `Perfect — you’re booked for ${when}${repName}. ` +
        `${dealerName} is at ${addressLine}.`;
      const systemMode = webhookMode;
      if (systemMode === "suggest") {
        appendOutbound(conv, event.to, event.from, confirmText, "draft_ai");
        const twiml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response></Response>`;
        return res.status(200).type("text/xml").send(twiml);
      }

      // Log as actually sent
      appendOutbound(conv, event.to, event.from, confirmText, "twilio", eventObj.id ?? undefined);

      // Return TwiML to send the SMS immediately (Option B)
      const twiml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n  <Message>${escapeXml(
        confirmText
      )}</Message>\n</Response>`;
      return res.status(200).type("text/xml").send(twiml);
    } catch (e: any) {
      console.log("[auto-book] failed:", e?.message ?? e);
      // If booking fails, fall through to normal draft behavior
    }
  }

  console.log("[deterministic-offer] precheck", {
    provider: event.provider,
    from: event.from,
    to: event.to,
    bookedEventId: conv.appointment?.bookedEventId ?? null,
    lastSuggestedSlotsLen: conv.scheduler?.lastSuggestedSlots?.length ?? 0,
    cta: conv.classification?.cta ?? null,
    bucket: conv.classification?.bucket ?? null
  });
  const lastOutbound = getLastNonVoiceOutbound(conv);
  const lastOutboundText = lastOutbound?.body ?? "";
  const lastOutboundAskedQuestion =
    /\?\s*$/.test(lastOutboundText.trim()) ||
    /\b(do any of these times work|which works best|what day and time works|what day works|what time works|want me to|should i|can i|would you like|does that work|ok to|are you able|set a time|schedule|appointment)\b/i.test(
      lastOutboundText
    );
  const inboundText = String(event.body ?? "").trim();
  const inboundLower = inboundText.toLowerCase();
  const lastOutboundAskedTradeQualifier =
    /\bdo you have a trade\b/i.test(lastOutboundText) ||
    /\bany trade\b/i.test(lastOutboundText);
  if (event.provider === "twilio" && lastOutboundAskedTradeQualifier) {
    const tradeYear = extractYearSingle(inboundLower);
    const tradeModel = findMentionedModel(inboundLower);
    const tradeAffirmed = isAffirmative(inboundText) || /\b(i have|i got|i've got|ive got)\b/i.test(inboundText);
    if (tradeAffirmed) {
      conv.lead = conv.lead ?? {};
      conv.lead.tradeVehicle = conv.lead.tradeVehicle ?? {};
      if (tradeYear) conv.lead.tradeVehicle.year = String(tradeYear);
      if (tradeModel) {
        conv.lead.tradeVehicle.model = tradeModel;
        conv.lead.tradeVehicle.description = tradeModel;
      }
      if (!isTradeDialogState(getDialogState(conv))) {
        setDialogState(conv, "trade_init");
      }
      const tradeLabel = tradeModel
        ? formatModelLabel(tradeYear ? String(tradeYear) : null, tradeModel)
        : tradeYear
          ? `${tradeYear} bike`
          : "your bike";
      const reply = tradeModel || tradeYear
        ? `Perfect — thanks. ${tradeLabel} helps. About how many miles are on it, and is there any payoff left on it?`
        : "Perfect — thanks. What year and model is your trade, about how many miles are on it, and is there any payoff left?";
      const systemMode = webhookMode;
      if (systemMode === "suggest") {
        appendOutbound(conv, event.to, event.from, reply, "draft_ai");
        const twiml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response></Response>`;
        return res.status(200).type("text/xml").send(twiml);
      }
      appendOutbound(conv, event.to, event.from, reply, "twilio");
      const twiml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n  <Message>${escapeXml(
        reply
      )}</Message>\n</Response>`;
      return res.status(200).type("text/xml").send(twiml);
    }
  }
  if (event.provider === "twilio") {
    const bike =
      formatModelLabel(
        conv.lead?.vehicle?.year ? String(conv.lead?.vehicle?.year) : null,
        conv.lead?.vehicle?.model ?? conv.lead?.vehicle?.description ?? null
      ) || "the bike";
    const mediaAffirmReply = buildMediaAffirmativeReply(lastOutboundText, inboundText, bike);
    if (mediaAffirmReply) {
      const autoMediaUrls = await findAutoMediaUrlsForConversationContext(conv, { max: 2 });
      const mediaReply = autoMediaUrls.length
        ? `Absolutely — here ${autoMediaUrls.length === 1 ? "is a photo" : "are a couple photos"} of ${bike}.`
        : mediaAffirmReply;
      if (!autoMediaUrls.length) {
        addMediaRequestTodoIfMissing(conv, event.body, event.providerMessageId);
      }
      const systemMode = webhookMode;
      if (systemMode === "suggest") {
        appendOutbound(
          conv,
          event.to,
          event.from,
          mediaReply,
          "draft_ai",
          undefined,
          autoMediaUrls.length ? autoMediaUrls : undefined
        );
        const twiml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response></Response>`;
        return res.status(200).type("text/xml").send(twiml);
      }
      appendOutbound(
        conv,
        event.to,
        event.from,
        mediaReply,
        "twilio",
        undefined,
        autoMediaUrls.length ? autoMediaUrls : undefined
      );
      const mediaTags = autoMediaUrls.length
        ? autoMediaUrls.map(u => `\n    <Media>${escapeXml(u)}</Media>`).join("")
        : "";
      const twiml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n  <Message>${escapeXml(
        mediaReply
      )}${mediaTags}\n  </Message>\n</Response>`;
      return res.status(200).type("text/xml").send(twiml);
    }
  }
  const emojiOnly = isEmojiOnlyText(inboundText);
  const outboundHoldNotice =
    lastOutbound?.body &&
    /(on hold|hold with deposit|deposit|sale pending|pending|sold|already sold)/i.test(lastOutbound.body);
  const textLower = inboundLower;
  const availabilitySignalsEarly = getDeterministicAvailabilitySignals(textLower, conv);
  const inventoryCountQuestion = availabilitySignalsEarly.inventoryCountQuestion;
  const deterministicAvailabilityLookup = availabilitySignalsEarly.shouldLookupAvailability;
  const deterministicAvailabilityIntentBase =
    inventoryCountQuestion || availabilitySignalsEarly.explicitAvailabilityAsk;
  const otherInventoryRequest = isOtherInventoryRequestText(textLower);
  const schedulingSignalsBase = detectSchedulingSignals(event.body);
  const preParserExplicitFinanceTermIntent =
    /\b\d{2,3}\s*(month|months|mo)\b/i.test(String(event.body ?? "")) ||
    /\brun\s+(it|that|the numbers?)\s+for\s+\d{2,3}\b/i.test(String(event.body ?? ""));
  const preParserFinanceSignal =
    isPaymentText(event.body ?? "") ||
    isDownPaymentQuestion(event.body ?? "") ||
    preParserExplicitFinanceTermIntent;
  const preParserSchedulingSignal =
    schedulingSignalsBase.explicit ||
    schedulingSignalsBase.hasDayTime ||
    schedulingSignalsBase.hasDayOnlyAvailability ||
    schedulingSignalsBase.hasDayOnlyRequest;
  const preParserNonWatchPrimaryIntent = preParserFinanceSignal || preParserSchedulingSignal;
  const leadSourceText = String(conv.lead?.source ?? "").toLowerCase();
  const isTradeLead =
    /sell my bike/.test(leadSourceText) ||
    /trade[-\s]?in|trade accelerator/.test(leadSourceText) ||
    conv.classification?.cta === "sell_my_bike" ||
    conv.classification?.bucket === "trade_in_sell";
  const isSellMyBikeLead = /sell my bike/.test(leadSourceText) || conv.classification?.cta === "sell_my_bike";
  const inventoryEntityParserEligible =
    event.provider === "twilio" &&
    process.env.LLM_ENABLED === "1" &&
    process.env.LLM_INVENTORY_ENTITY_PARSER_ENABLED !== "0" &&
    !!process.env.OPENAI_API_KEY &&
    !emojiOnly &&
    !isShortAckText(inboundText);
  const inventoryEntityParse = inventoryEntityParserEligible
    ? await safeLlmParse("inventory_entity_parser", () =>
        parseInventoryEntitiesWithLLM({
          text: event.body ?? "",
          history: buildHistory(conv, 8),
          lead: conv.lead
        })
      )
    : null;
  if (process.env.DEBUG_INVENTORY_ENTITY_PARSER === "1" && inventoryEntityParse) {
    console.log("[llm-inventory-entity-parse]", inventoryEntityParse);
  }
  const inventoryEntityConfidence =
    typeof inventoryEntityParse?.confidence === "number" ? inventoryEntityParse.confidence : 0;
  const inventoryEntityConfidenceMin = Number(process.env.LLM_INVENTORY_ENTITY_CONFIDENCE_MIN ?? 0.68);
  const inventoryEntityAccepted = !!inventoryEntityParse && inventoryEntityConfidence >= inventoryEntityConfidenceMin;
  const inventoryEntityModelHint =
    inventoryEntityAccepted && inventoryEntityParse?.model ? inventoryEntityParse.model : null;
  const inventoryEntityYearHint =
    inventoryEntityAccepted && inventoryEntityParse?.year ? inventoryEntityParse.year : null;
  const inventoryEntityColorHint =
    inventoryEntityAccepted && inventoryEntityParse?.color ? inventoryEntityParse.color : null;
  const applyEntityBudgetSeed = (seed: {
    minPrice?: number;
    maxPrice?: number;
    monthlyBudget?: number;
    termMonths?: number;
    downPayment?: number;
  }) => ({
    ...seed,
    minPrice: inventoryEntityAccepted ? (inventoryEntityParse?.minPrice ?? seed.minPrice) : seed.minPrice,
    maxPrice: inventoryEntityAccepted ? (inventoryEntityParse?.maxPrice ?? seed.maxPrice) : seed.maxPrice,
    monthlyBudget: inventoryEntityAccepted
      ? (inventoryEntityParse?.monthlyBudget ?? seed.monthlyBudget)
      : seed.monthlyBudget,
    downPayment: inventoryEntityAccepted
      ? (inventoryEntityParse?.downPayment ?? seed.downPayment)
      : seed.downPayment
  });
  let watchHandledEarly = false;
  const earlyWatchIntentText = isWatchConfirmationIntentText(String(event.body ?? ""));
  const earlyWatchIntentLLM = semanticWatchAction === "set_watch";
  const earlyWatchPrompted = /\b(keep an eye|keep me posted|watch for|watch\b)\b/i.test(
    lastOutboundText
  );
  const earlyPromptedWatchAffirm =
    earlyWatchPrompted &&
    isAffirmative(event.body) &&
    !schedulingSignalsBase.hasDayTime &&
    !schedulingSignalsBase.hasDayOnlyAvailability &&
    !schedulingSignalsBase.hasDayOnlyRequest &&
    !schedulingSignalsBase.explicit &&
    !preParserNonWatchPrimaryIntent;
  const earlyWatchIntent =
    event.provider === "twilio" &&
    !conv.inventoryWatchPending &&
    !preParserNonWatchPrimaryIntent &&
    (earlyWatchIntentLLM || earlyWatchIntentText || earlyPromptedWatchAffirm);
  const earlyWatchAsSideEffectOnly =
    earlyWatchIntent && hasPrimaryIntentBeyondWatch(String(event.body ?? ""));
  if (earlyWatchIntent) {
    const nowIso = new Date().toISOString();
    const leadVehicle = conv.lead?.vehicle ?? {};
    const leadYearNum = Number(leadVehicle.year ?? "");
    const leadYear = Number.isFinite(leadYearNum) ? leadYearNum : undefined;
    const llmWatchYear = Number(String(semanticWatch?.year ?? ""));
    const llmWatchColor = sanitizeColorPhrase(semanticWatch?.color ?? undefined);
    const llmWatchModel = String(semanticWatch?.model ?? "").trim();
    const llmWatchModelResolved = llmWatchModel
      ? await resolveWatchModelFromText(llmWatchModel.toLowerCase(), llmWatchModel)
      : null;
    const resolvedModel = await resolveWatchModelFromText(
      textLower,
      llmWatchModelResolved || inventoryEntityModelHint || leadVehicle.model || leadVehicle.description || null
    );
    if (!resolvedModel) {
      const budgetSeed = applyEntityBudgetSeed(
        resolveWatchBudgetPreferenceForConversation(conv, String(event.body ?? ""))
      );
      conv.inventoryWatchPending = {
        minPrice: budgetSeed.minPrice,
        maxPrice: budgetSeed.maxPrice,
        monthlyBudget: budgetSeed.monthlyBudget,
        termMonths: budgetSeed.termMonths,
        downPayment: budgetSeed.downPayment,
        askedAt: nowIso
      };
      setDialogState(conv, "inventory_watch_prompted");
      watchHandledEarly = true;
      if (!earlyWatchAsSideEffectOnly) {
        const reply = "Got it — which model should I watch for?";
        const systemMode = webhookMode;
        if (systemMode === "suggest") {
          appendOutbound(conv, event.to, event.from, reply, "draft_ai");
          const twiml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response></Response>`;
          return res.status(200).type("text/xml").send(twiml);
        }
        appendOutbound(conv, event.to, event.from, reply, "twilio");
        const twiml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n  <Message>${escapeXml(
          reply
        )}</Message>\n</Response>`;
        return res.status(200).type("text/xml").send(twiml);
      }
    } else {
      const budgetSeed = applyEntityBudgetSeed(
        resolveWatchBudgetPreferenceForConversation(conv, String(event.body ?? ""))
      );
      const pending: InventoryWatchPending = {
        model: resolvedModel,
        year:
          Number.isFinite(llmWatchYear) && llmWatchYear > 0
            ? llmWatchYear
            : inventoryEntityYearHint ?? extractYearSingle(textLower) ?? leadYear,
        color: combineWatchColorAndFinish(
          llmWatchColor ??
            inventoryEntityColorHint ??
            extractColorToken(textLower) ??
            leadVehicle.color ??
            undefined,
          extractFinishToken(textLower)
        ),
        minPrice: budgetSeed.minPrice,
        maxPrice: budgetSeed.maxPrice,
        monthlyBudget: budgetSeed.monthlyBudget,
        termMonths: budgetSeed.termMonths,
        downPayment: budgetSeed.downPayment,
        askedAt: nowIso
      };
      let pref = parseInventoryWatchPreference(String(event.body ?? ""), pending);
      if (
        pref.action === "ignore" &&
        pending.model &&
        (isAffirmative(event.body) || earlyWatchIntentText || earlyWatchIntentLLM)
      ) {
        const watchColor = sanitizeColorPhrase(pending.color);
        const watch: InventoryWatch = {
          model: pending.model,
          year: pending.year,
          color: watchColor,
          minPrice: pending.minPrice,
          maxPrice: pending.maxPrice,
          monthlyBudget: pending.monthlyBudget,
          termMonths: pending.termMonths,
          downPayment: pending.downPayment,
          exactness: "model_only",
          status: "active",
          createdAt: new Date().toISOString()
        };
        if (watch.year && watch.color) watch.exactness = "exact";
        else if (watch.year) watch.exactness = "year_model";
        pref = { action: "set", watch };
      }
      if (pref.action === "set" && pref.watch) {
        if (!pref.watch.make && leadVehicle.make) pref.watch.make = leadVehicle.make;
        if (!pref.watch.trim && leadVehicle.trim) pref.watch.trim = leadVehicle.trim;
        const conditionFromText = normalizeWatchCondition(textLower);
        if (!pref.watch.condition && conditionFromText) pref.watch.condition = conditionFromText;
        if (!pref.watch.condition && leadVehicle.condition) {
          pref.watch.condition = normalizeWatchCondition(leadVehicle.condition);
        }
        conv.inventoryWatch = pref.watch;
        conv.inventoryWatches = [pref.watch];
        conv.inventoryWatchPending = undefined;
        setDialogState(conv, "inventory_watch_active");
        setFollowUpMode(conv, "holding_inventory", "inventory_watch");
        stopFollowUpCadence(conv, "inventory_watch");
        watchHandledEarly = true;
        if (!earlyWatchAsSideEffectOnly) {
          const reply = buildInventoryWatchConfirmation(pref.watch);
          const systemMode = webhookMode;
          if (systemMode === "suggest") {
            appendOutbound(conv, event.to, event.from, reply, "draft_ai");
            const twiml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response></Response>`;
            return res.status(200).type("text/xml").send(twiml);
          }
          appendOutbound(conv, event.to, event.from, reply, "twilio");
          const twiml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n  <Message>${escapeXml(
            reply
          )}</Message>\n</Response>`;
          return res.status(200).type("text/xml").send(twiml);
        }
      } else {
        conv.inventoryWatchPending = pending;
        setDialogState(conv, "inventory_watch_prompted");
        watchHandledEarly = true;
        if (!earlyWatchAsSideEffectOnly) {
          const pendingCondition = inferWatchCondition(pending.model, pending.year, conv);
          const finishEligible = await shouldAskFinishPreference(
            pending.model,
            pending.year,
            pendingCondition
          );
          const reply = buildWatchPreferencePrompt(pendingCondition, finishEligible);
          const systemMode = webhookMode;
          if (systemMode === "suggest") {
            appendOutbound(conv, event.to, event.from, reply, "draft_ai");
            const twiml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response></Response>`;
            return res.status(200).type("text/xml").send(twiml);
          }
          appendOutbound(conv, event.to, event.from, reply, "twilio");
          const twiml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n  <Message>${escapeXml(
            reply
          )}</Message>\n</Response>`;
          return res.status(200).type("text/xml").send(twiml);
        }
      }
    }
  }
  if (event.provider === "twilio" && isTradeLead) {
    const townMention = extractTownFromMessage(event.body ?? "");
    if (townMention && !conv.pickup?.town) {
      const dealerProfile = await getDealerProfileHot();
      const coords = await resolveDealerLatLon(dealerProfile);
      const cfg = getWeatherConfig(dealerProfile);
      let townLabel = townMention;
      let eligible: boolean | undefined;
      let distance: number | undefined;
      if (coords) {
        const match = await resolveTownNearestDealer(townMention, coords.lat, coords.lon);
        if (match) {
          distance = Math.round(match.distanceMiles * 10) / 10;
          eligible = distance <= Number(cfg.pickupRadiusMiles ?? 25);
          townLabel = formatTownLabel(match.name, match.state);
        }
      }
      conv.pickup = {
        ...(conv.pickup ?? {}),
        town: townLabel,
        distanceMiles: distance,
        eligible,
        updatedAt: nowIso()
      };
      saveConversation(conv);
    }
  }
  if (event.provider === "twilio" && isTradeLead && detectPhoneNumbersIntent(event.body ?? "")) {
    addTodo(conv, "call", "Customer wants a rough trade idea over the phone.", event.providerMessageId);
  }
  if (isTradeLead && conv.lead) {
    const parsedSellOption = parseSellOptionFromText(event.body ?? "");
    if (parsedSellOption) {
      conv.lead.sellOption = parsedSellOption;
      conv.lead.sellOptionUpdatedAt = new Date().toISOString();
      if (!isScheduleDialogState(getDialogState(conv))) {
        if (parsedSellOption === "cash") setDialogState(conv, "trade_cash");
        else if (parsedSellOption === "trade") setDialogState(conv, "trade_trade");
        else setDialogState(conv, "trade_either");
      }
    }
    if (getDialogState(conv) === "none") {
      setDialogState(conv, "trade_init");
    }
  }
  const shortAck = isShortAckText(inboundText) || emojiOnly;
  const recentHistory = buildHistory(conv, 6);
  const routeTimingEnabled = process.env.DEBUG_ROUTE_TIMING === "1";
  const decisionTraceEnabled = process.env.DEBUG_DECISION_TRACE === "1";
  const logRouteTiming = (stage: string, startedAtMs: number, extra?: Record<string, unknown>) => {
    if (!routeTimingEnabled) return;
    console.log("[route-timing]", {
      stage,
      ms: Date.now() - startedAtMs,
      convId: conv.id,
      leadKey: conv.leadKey,
      ...(extra ?? {})
    });
  };
  const logDecisionTrace = (stage: string, extra?: Record<string, unknown>) => {
    if (!decisionTraceEnabled) return;
    console.log("[decision-trace]", {
      stage,
      convId: conv.id,
      leadKey: conv.leadKey,
      dialogState: getDialogState(conv),
      followUpMode: conv.followUp?.mode ?? null,
      followUpReason: conv.followUp?.reason ?? null,
      ...(extra ?? {})
    });
  };
  const logRouteOutcome = (outcome: string, extra?: Record<string, unknown>) => {
    recordRouteOutcome("live", outcome, {
      convId: conv.id,
      leadKey: conv.leadKey,
      ...(extra ?? {})
    });
  };
  const highConfidenceFinanceTurn =
    preParserFinanceSignal &&
    !preParserSchedulingSignal &&
    !detectCallbackText(event.body ?? "") &&
    !isWatchConfirmationIntentText(String(event.body ?? ""));
  const highConfidenceSchedulingTurn =
    preParserSchedulingSignal && !preParserFinanceSignal && !detectCallbackText(event.body ?? "");
  const bookingParserEligible =
    event.provider === "twilio" &&
    process.env.LLM_ENABLED === "1" &&
    process.env.LLM_BOOKING_PARSER_ENABLED === "1" &&
    !!process.env.OPENAI_API_KEY &&
    schedulingAllowed;
  let paymentOrPricingNoSchedule =
    isPricingText(event.body ?? "") &&
    !schedulingSignalsBase.explicit &&
    !schedulingSignalsBase.hasDayTime &&
    !schedulingSignalsBase.hasDayOnlyAvailability &&
    !schedulingSignalsBase.hasDayOnlyRequest;
  const bookingParserHint =
    !paymentOrPricingNoSchedule &&
    (!!conv.scheduler?.lastSuggestedSlots?.length ||
      draftHasSpecificTimes(lastOutboundText) ||
      /\b(schedule|book|appt|appointment|stop in|stop by|come in|visit|time|times|available|availability|today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i.test(
        textLower
      ));
  const bookingParsePromise =
    bookingParserEligible && bookingParserHint && !shortAck && !highConfidenceFinanceTurn
      ? safeLlmParse("booking_intent_parser", () =>
          parseBookingIntentWithLLM({
            text: event.body,
            history: recentHistory,
            lastSuggestedSlots: conv.scheduler?.lastSuggestedSlots,
            appointment: conv.appointment
          })
        )
      : Promise.resolve(null);
  const intentParserEligible =
    event.provider === "twilio" &&
    process.env.LLM_ENABLED === "1" &&
    process.env.LLM_INTENT_PARSER_ENABLED === "1" &&
    !!process.env.OPENAI_API_KEY;
  const intentParsePromise =
    intentParserEligible && !shortAck && !highConfidenceFinanceTurn
      ? safeLlmParse("intent_parser", () =>
          parseIntentWithLLM({
            text: event.body,
            history: recentHistory,
            lead: conv.lead
          })
        )
      : Promise.resolve(null);
  const dialogActParserEligible =
    event.provider === "twilio" &&
    process.env.LLM_ENABLED === "1" &&
    process.env.LLM_DIALOG_ACT_PARSER_ENABLED === "1" &&
    !!process.env.OPENAI_API_KEY &&
    !shortAck;
  const dialogActParsePromise = dialogActParserEligible
    && !highConfidenceFinanceTurn
    ? safeLlmParse("dialog_act_parser", () =>
        parseDialogActWithLLM({
          text: event.body,
          history: recentHistory,
          lead: conv.lead
        })
      )
    : Promise.resolve(null);
  const pricingPaymentsParserEligible =
    event.provider === "twilio" &&
    process.env.LLM_ENABLED === "1" &&
    process.env.LLM_PRICING_PAYMENTS_PARSER_ENABLED !== "0" &&
    !!process.env.OPENAI_API_KEY &&
    !shortAck;
  const pricingPaymentsParsePromise = pricingPaymentsParserEligible
    && !highConfidenceSchedulingTurn
    ? safeLlmParse("pricing_payments_parser", () =>
        parsePricingPaymentsIntentWithLLM({
          text: event.body,
          history: recentHistory,
          lead: conv.lead
        })
      )
    : Promise.resolve(null);
  const parserStageStartedAt = Date.now();
  const [bookingParse, intentParse, dialogActParse, pricingPaymentsParse] =
    await Promise.all([
      bookingParsePromise,
      intentParsePromise,
      dialogActParsePromise,
      pricingPaymentsParsePromise
    ]);
  logRouteTiming("parsers", parserStageStartedAt, {
    highConfidenceFinanceTurn,
    highConfidenceSchedulingTurn
  });
  if (process.env.DEBUG_BOOKING_PARSER === "1" && bookingParse) {
    console.log("[llm-booking-parse]", {
      intent: bookingParse.intent,
      explicitRequest: bookingParse.explicitRequest,
      normalizedText: bookingParse.normalizedText,
      reference: bookingParse.reference,
      confidence: bookingParse.confidence
    });
  }
  const bookingParseTimeText =
    bookingParse?.requested?.timeText ??
    (bookingParse?.explicitRequest ? extractTimeToken(event.body) ?? "" : "");
  if (process.env.DEBUG_INTENT_PARSER === "1" && intentParse) {
    console.log("[llm-intent-parse]", {
      intent: intentParse.intent,
      explicitRequest: intentParse.explicitRequest,
      confidence: intentParse.confidence,
      availability: intentParse.availability,
      callback: intentParse.callback
    });
  }
  if (process.env.DEBUG_DIALOG_ACT_PARSER === "1" && dialogActParse) {
    console.log("[llm-dialog-act-parse]", dialogActParse);
  }
  const dialogActConfidence =
    typeof dialogActParse?.confidence === "number" ? dialogActParse.confidence : 0;
  const dialogActConfidenceMin = Number(process.env.LLM_DIALOG_ACT_CONFIDENCE_MIN ?? 0.72);
  const dialogActAccepted =
    !!dialogActParse?.explicitRequest &&
    dialogActParse.topic !== "general" &&
    dialogActConfidence >= dialogActConfidenceMin;
  if (process.env.DEBUG_PRICING_PAYMENTS_PARSER === "1" && pricingPaymentsParse) {
    console.log("[llm-pricing-payments-parse]", pricingPaymentsParse);
  }
  const pricingPaymentsConfidence =
    typeof pricingPaymentsParse?.confidence === "number" ? pricingPaymentsParse.confidence : 0;
  const pricingPaymentsConfidenceMin = Number(process.env.LLM_PRICING_PAYMENTS_CONFIDENCE_MIN ?? 0.74);
  const pricingPaymentsAccepted =
    !!pricingPaymentsParse?.explicitRequest &&
    pricingPaymentsConfidence >= pricingPaymentsConfidenceMin &&
    pricingPaymentsParse.intent !== "none";
  const llmPaymentsIntent = pricingPaymentsAccepted && pricingPaymentsParse?.intent === "payments";
  const llmPricingIntent =
    (dialogActAccepted && dialogActParse?.topic === "pricing") ||
    (pricingPaymentsAccepted && pricingPaymentsParse?.intent === "pricing");
  const llmPricingOrPaymentsIntent = llmPricingIntent || llmPaymentsIntent;
  const explicitFinanceTermIntent =
    /\b\d{2,3}\s*(month|months|mo)\b/i.test(String(event.body ?? "")) ||
    /\brun\s+(it|that|the numbers?)\s+for\s+\d{2,3}\b/i.test(String(event.body ?? ""));
  const llmSchedulingIntent = dialogActAccepted && dialogActParse?.topic === "scheduling";
  const insuranceStatusUpdateOnly = (() => {
    const body = String(event.body ?? "");
    const lower = body.toLowerCase();
    const hasInsurance = /\binsurance\b/.test(lower);
    const hasQuoteOrRate = /\b(quote|quoted|rate|fair price|priced)\b/.test(lower);
    const hasVisitTiming = /\b(come in|stop by|stop in|see it|next week|this week|tomorrow|later today|this afternoon)\b/.test(lower);
    const hasExplicitFinanceAsk =
      /\b(how much|what(?:'s| is) (the )?(price|payment)|monthly|per month|down payment|apr|term|otd|out the door|msrp)\b/.test(
        lower
      ) || /\?/.test(body);
    return hasInsurance && hasQuoteOrRate && hasVisitTiming && !hasExplicitFinanceAsk;
  })();
  const paymentBudgetContext = resolvePaymentBudgetForConversation(conv, event.body ?? "");
  const explicitBudgetSignal =
    paymentBudgetContext.monthlyBudget != null ||
    paymentBudgetContext.termMonths != null ||
    paymentBudgetContext.downPayment != null;
  const pricingSignal =
    !insuranceStatusUpdateOnly &&
    (llmPricingOrPaymentsIntent ||
      explicitBudgetSignal ||
      isPricingText(event.body ?? "") ||
      isPaymentText(event.body ?? ""));
  const scheduleFromDialogAct = llmSchedulingIntent && !llmPricingOrPaymentsIntent;
  const explicitScheduleSignal =
    llmExplicitScheduleIntent || scheduleFromDialogAct || isExplicitScheduleIntent(event.body);
  paymentOrPricingNoSchedule =
    pricingSignal &&
    !llmExplicitScheduleIntent &&
    !schedulingSignalsBase.explicit &&
    !schedulingSignalsBase.hasDayTime &&
    !schedulingSignalsBase.hasDayOnlyAvailability &&
    !schedulingSignalsBase.hasDayOnlyRequest;
  const pricingOrPaymentsIntent =
    llmPricingOrPaymentsIntent || paymentOrPricingNoSchedule || explicitFinanceTermIntent;
  if (
    getDialogState(conv) === "none" &&
    !isScheduleDialogState(getDialogState(conv)) &&
    !isTradeDialogState(getDialogState(conv)) &&
    pricingSignal
  ) {
    setDialogState(conv, "pricing_init");
  }
  const tradePayoffParserEligible =
    event.provider === "twilio" &&
    process.env.LLM_ENABLED === "1" &&
    process.env.LLM_TRADE_PAYOFF_PARSER_ENABLED === "1" &&
    !!process.env.OPENAI_API_KEY &&
    !shortAck;
  const tradePayoffParserHint =
    /\b(lien|lein|payoff|lender|loan|title|owe|owe on it|bank)\b/i.test(textLower) ||
    /\b(address|info|information|details)\b/i.test(textLower) ||
    isTradeLead ||
    !!conv.tradePayoff;
  const unifiedTradeParse: TradePayoffParse | null =
    unifiedSemanticSlotParse && tradePayoffParserHint
      ? {
          payoffStatus: unifiedSemanticSlotParse.payoffStatus,
          needsLienHolderInfo: unifiedSemanticSlotParse.needsLienHolderInfo,
          providesLienHolderInfo: unifiedSemanticSlotParse.providesLienHolderInfo,
          confidence:
            typeof unifiedSemanticSlotParse.payoffConfidence === "number"
              ? unifiedSemanticSlotParse.payoffConfidence
              : unifiedSemanticSlotParse.confidence
        }
      : null;
  let tradePayoffParse: TradePayoffParse | null = unifiedSlotRouterEnabled
    ? unifiedTradeParse
    : null;
  if (!tradePayoffParse && tradePayoffParserEligible && tradePayoffParserHint) {
    tradePayoffParse = await safeLlmParse("trade_payoff_parser", () =>
      parseTradePayoffWithLLM({
        text: event.body,
        history: recentHistory,
        lead: conv.lead,
        tradePayoff: conv.tradePayoff
      })
    );
    if (unifiedSlotRouterEnabled && process.env.DEBUG_UNIFIED_SLOT_PARSER === "1") {
      console.log("[llm-unified-slot-parse] trade fallback to legacy parser");
    }
  }
  if (unifiedSlotRouterEnabled && unifiedSlotCompareLogEnabled && tradePayoffParserHint) {
    const legacyTradeShadow =
      tradePayoffParserEligible && (!tradePayoffParse || tradePayoffParse === unifiedTradeParse)
        ? await safeLlmParse("trade_payoff_parser_legacy_shadow", () =>
            parseTradePayoffWithLLM({
              text: event.body,
              history: recentHistory,
              lead: conv.lead,
              tradePayoff: conv.tradePayoff
            })
          )
        : null;
    if (legacyTradeShadow) {
      const mismatch =
        legacyTradeShadow.payoffStatus !== (unifiedTradeParse?.payoffStatus ?? "unknown") ||
        legacyTradeShadow.needsLienHolderInfo !==
          !!(unifiedTradeParse?.needsLienHolderInfo ?? false) ||
        legacyTradeShadow.providesLienHolderInfo !==
          !!(unifiedTradeParse?.providesLienHolderInfo ?? false);
      if (mismatch) {
        console.log("[llm-unified-slot-compare] trade mismatch", {
          text: event.body,
          unified: unifiedTradeParse,
          legacy: legacyTradeShadow
        });
      }
    }
  }
  if (process.env.DEBUG_TRADE_PAYOFF_PARSER === "1" && tradePayoffParse) {
    console.log("[llm-trade-payoff-parse]", {
      payoffStatus: tradePayoffParse.payoffStatus,
      needsLienHolderInfo: tradePayoffParse.needsLienHolderInfo,
      providesLienHolderInfo: tradePayoffParse.providesLienHolderInfo,
      confidence: tradePayoffParse.confidence
    });
  }
  const tradePayoffConfidence =
    typeof tradePayoffParse?.confidence === "number" ? tradePayoffParse.confidence : 0;
  const tradePayoffConfidenceMin = Number(process.env.LLM_TRADE_PAYOFF_CONFIDENCE_MIN ?? 0.72);
  const tradePayoffAccepted =
    !!tradePayoffParse &&
    tradePayoffConfidence >= tradePayoffConfidenceMin &&
    (tradePayoffParse.payoffStatus !== "unknown" ||
      tradePayoffParse.needsLienHolderInfo ||
      tradePayoffParse.providesLienHolderInfo);
  if (tradePayoffAccepted) {
    applyTradePayoffParseToConversation(conv, tradePayoffParse);
  }
  const llmNeedsLienHolderInfo = !!(tradePayoffAccepted && tradePayoffParse?.needsLienHolderInfo);
  const intentConfidence =
    typeof intentParse?.confidence === "number" ? intentParse.confidence : 0;
  const intentConfidenceMin = Number(process.env.LLM_INTENT_CONFIDENCE_MIN ?? 0.75);
  const intentAccepted = !!intentParse?.explicitRequest && intentConfidence >= intentConfidenceMin;
  const intentLow =
    !!intentParse?.explicitRequest && intentConfidence > 0 && intentConfidence < intentConfidenceMin;
  const llmCallbackRequested = intentAccepted && intentParse?.intent === "callback";
  const customerWillCallIntent = isCustomerWillCallText(event.body ?? "");
  const textingTypoJoke = isTextingTypoJokeText(event.body ?? "");
  const callbackRequestedOverride =
    !customerWillCallIntent &&
    !textingTypoJoke &&
    (llmCallbackRequested || detectCallbackText(event.body ?? ""));
  const llmAvailabilityIntent = intentAccepted && intentParse?.intent === "availability";
  const llmTestRideIntent = intentAccepted && intentParse?.intent === "test_ride";
  const llmAvailability = llmAvailabilityIntent ? intentParse?.availability ?? null : null;
  let mentionedUser: any | null = null;
  let usersForMentions: Array<any> = [];
  if (event.provider === "twilio") {
    usersForMentions = await listUsers();
    mentionedUser = findMentionedUser(event.body ?? "", usersForMentions);
    if (!mentionedUser && inboundReferencesOtherPerson(event.body ?? "")) {
      mentionedUser = findUserFromRecentOutbound(conv, usersForMentions);
    }
  }
  if (event.provider === "twilio" && llmNeedsLienHolderInfo) {
    const dealerProfile = await getDealerProfileHot();
    const reply =
      maybeEscalateLienHolderInfoRequest(conv, event, dealerProfile, {
        createTodo: true,
        setManualHandoff: true,
        triggered: true
      }) ?? buildLienHolderFallbackReply(dealerProfile);
    const systemMode = webhookMode;
    if (systemMode === "suggest") {
      appendOutbound(conv, event.to, event.from, reply, "draft_ai");
      const twiml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response></Response>`;
      return res.status(200).type("text/xml").send(twiml);
    }
    appendOutbound(conv, event.to, event.from, reply, "twilio");
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n  <Message>${escapeXml(
      reply
    )}</Message>\n</Response>`;
    return res.status(200).type("text/xml").send(twiml);
  }
  if (event.provider === "twilio" && mentionedUser) {
    const firstName =
      String(mentionedUser.firstName ?? "").trim() ||
      String(mentionedUser.name ?? "").trim().split(/\s+/).filter(Boolean)[0] ||
      "them";
    const updateText = String(event.body ?? "").trim();
    const noteSummary =
      (await summarizeSalespersonNoteWithLLM({ text: updateText, history: recentHistory })) ?? "";
    const todoText = noteSummary || updateText || `Update for ${firstName}`;
    addTodo(conv, "note", todoText, event.providerMessageId);
    const fallbackSensitive = /\b(cancer|chemo|chemotherapy|radiation|hospice|icu|hospital|surgery|surgical|terminal|stage\s*(four|4)|death|dying|funeral|passed away|stroke|heart attack)\b/i.test(
      String(event.body ?? "")
    );
    const empathyNeeded =
      (await classifyEmpathyNeedWithLLM({ text: event.body ?? "", history: recentHistory })) ??
      fallbackSensitive;
    const wantsCall = llmCallbackRequested
      ? true
      : /\b(call me|give me a call|can you call|please call|have .* call|reach me|contact me)\b/i.test(
          String(event.body ?? "")
        );
    const dealerProfile = await getDealerProfileHot();
    const dealerName = dealerProfile?.dealerName ?? "American Harley-Davidson";
    const agentName = dealerProfile?.agentName ?? "our team";
    const customerName = normalizeDisplayCase(conv.lead?.firstName) || "there";
    const intro = isDirectUserMention(event.body ?? "", mentionedUser)
      ? `Hey ${customerName} — this is ${agentName} at ${dealerName}. `
      : "";
    const handoff = wantsCall
      ? `I'll have ${firstName} reach out.`
      : `I'll let ${firstName} know.`;
    const reply = `${intro}${
      empathyNeeded ? "I'm really sorry to hear that. " : "Got it — "
    }${handoff}`;
    const systemMode = webhookMode;
    if (systemMode === "suggest") {
      appendOutbound(conv, event.to, event.from, reply, "draft_ai");
      const twiml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response></Response>`;
      return res.status(200).type("text/xml").send(twiml);
    }
    appendOutbound(conv, event.to, event.from, reply, "twilio");
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n  <Message>${escapeXml(
      reply
    )}</Message>\n</Response>`;
    return res.status(200).type("text/xml").send(twiml);
  }
  const bookingConfidence =
    typeof bookingParse?.confidence === "number" ? bookingParse.confidence : 0;
  const bookingConfidenceMin = Number(process.env.LLM_BOOKING_CONFIDENCE_MIN ?? 0.7);
  const bookingIntentAccepted =
    !!bookingParse?.explicitRequest && bookingConfidence >= bookingConfidenceMin;
  const bookingIntentLow =
    !!bookingParse?.explicitRequest && bookingConfidence > 0 && bookingConfidence < bookingConfidenceMin;
  let bookingParseText = bookingIntentAccepted ? bookingParse?.normalizedText ?? "" : "";
  if (bookingIntentAccepted && bookingParse?.reference === "last_suggested") {
    const dayFromSlot = inferDayTokenFromSlot(conv.scheduler?.lastSuggestedSlots?.[0]?.startLocal ?? "");
    const hasDayToken = bookingParseText
      ? /\b(today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|this week|next week|this weekend|weekend|next month)\b/i.test(
          bookingParseText
        )
      : false;
    if (dayFromSlot && !hasDayToken) {
      if (bookingParseTimeText) {
        bookingParseText = `${dayFromSlot} ${bookingParseTimeText}`;
      } else if (bookingParseText) {
        bookingParseText = `${dayFromSlot} ${bookingParseText}`;
      } else {
        bookingParseText = dayFromSlot;
      }
    }
  }
  const llmHasDayToken = bookingParseText
    ? /\b(today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|this week|next week|this weekend|weekend|next month)\b/i.test(
        bookingParseText
      )
    : false;
  const llmHasTimeWord = bookingParseText
    ? /\b(\d{1,2}):(\d{2})\s*(am|pm)?\b/i.test(bookingParseText)
    : false;
  const llmHasAtHour = bookingParseText
    ? /\b(?:at|for|around|by)\s*(\d{1,2})(?::\d{2})?\b(?!\s*\/)/i.test(bookingParseText)
    : false;
  const llmHasDayTime = !!llmHasDayToken && (llmHasTimeWord || llmHasAtHour);
  const llmHasDayOnlyAvailability =
    !!llmHasDayToken && /\b(availability|available|openings|open|time|times)\b/i.test(bookingParseText);
  const llmHasDayOnlyRequest = bookingIntentAccepted && !!llmHasDayToken && !llmHasDayTime;
  const schedulingSignals = {
    explicit:
      schedulingSignalsBase.explicit ||
      bookingIntentAccepted ||
      scheduleFromDialogAct ||
      llmExplicitScheduleIntent ||
      !!llmTestRideIntent,
    hasDayTime: schedulingSignalsBase.hasDayTime || llmHasDayTime,
    hasDayOnlyAvailability:
      schedulingSignalsBase.hasDayOnlyAvailability || llmHasDayOnlyAvailability,
    hasDayOnlyRequest: schedulingSignalsBase.hasDayOnlyRequest || llmHasDayOnlyRequest
  };
  if (llmTestRideIntent && schedulingAllowed && !isTestRideDialogState(getDialogState(conv))) {
    setDialogState(conv, "test_ride_init");
  }
  if (schedulingSignalsBase.softVisit) {
    schedulingSignals.explicit = false;
    schedulingSignals.hasDayTime = false;
    schedulingSignals.hasDayOnlyAvailability = false;
    schedulingSignals.hasDayOnlyRequest = false;
  }
  if (pricingOrPaymentsIntent) {
    schedulingSignals.explicit = false;
    schedulingSignals.hasDayTime = false;
    schedulingSignals.hasDayOnlyAvailability = false;
    schedulingSignals.hasDayOnlyRequest = false;
  }
  const softVisitIntent = schedulingSignalsBase.softVisit === true;
  if (event.provider === "twilio" && softVisitIntent) {
    conv.scheduleSoft = {
      requestedAt: nowIso(),
      cooldownUntil: new Date(Date.now() + SOFT_SCHEDULE_COOLDOWN_MS).toISOString()
    };
    if (getDialogState(conv) === "none") {
      setDialogState(conv, "schedule_soft");
    }
  }
  const schedulingExplicit = schedulingAllowed ? schedulingSignals.explicit : false;
  const schedulingPrimaryIntent =
    schedulingSignals.explicit ||
    schedulingSignals.hasDayTime ||
    schedulingSignals.hasDayOnlyAvailability ||
    schedulingSignals.hasDayOnlyRequest ||
    llmSchedulingIntent ||
    !!llmTestRideIntent;
  const callbackPrimaryIntent =
    callbackRequestedOverride && !pricingOrPaymentsIntent && !schedulingPrimaryIntent;
  const availabilityPrimaryIntent =
    llmAvailabilityIntent && !pricingOrPaymentsIntent && !schedulingPrimaryIntent && !callbackPrimaryIntent;
  const turnPrimaryIntent:
    | "pricing_payments"
    | "scheduling"
    | "callback"
    | "availability"
    | "general" = pricingOrPaymentsIntent
    ? "pricing_payments"
    : schedulingPrimaryIntent
      ? "scheduling"
      : callbackPrimaryIntent
        ? "callback"
        : availabilityPrimaryIntent
          ? "availability"
          : "general";
  const deterministicAvailabilityIntentOverride =
    deterministicAvailabilityIntentBase || availabilityPrimaryIntent;
  const financePriorityOverride = hasFinancePrioritySignals(event.body ?? "", conv, {
    pricingOrPaymentsIntent,
    lastOutboundText
  });
  const schedulePriorityOverride = schedulingPrimaryIntent;
  logDecisionTrace("live.intent_routing", {
    inboundProvider: event.provider,
    turnPrimaryIntent,
    pricingOrPaymentsIntent,
    schedulingPrimaryIntent,
    callbackPrimaryIntent,
    availabilityPrimaryIntent,
    deterministicAvailabilityIntentOverride,
    financePriorityOverride,
    schedulePriorityOverride,
    deterministicAvailabilityLookup
  });
  if (turnPrimaryIntent === "scheduling" && getDialogState(conv) === "pricing_need_model") {
    setDialogState(conv, "schedule_request");
  }
  const suppressWatchIntentThisTurn = turnPrimaryIntent !== "general";
  if (schedulingSignals.explicit || schedulingSignals.hasDayTime) {
    if (conv.scheduleSoft) {
      conv.scheduleSoft = undefined;
    }
  }
  if (
    event.provider === "twilio" &&
    !schedulingSignals.hasDayTime &&
    !schedulingSignals.hasDayOnlyRequest &&
    !schedulingSignals.hasDayOnlyAvailability &&
    !explicitScheduleSignal &&
    (() => {
      const downPaymentProvided = paymentBudgetContext.downPayment != null;
      const askedDownPaymentRecently =
        /\b(how much can you put down|how much (?:are|can) you put down|money down|down payment|cash down)\b/i.test(
          lastOutboundText
        );
      return (
        llmPaymentsIntent ||
        (pricingPaymentsAccepted && pricingPaymentsParse?.intent === "payments") ||
        (downPaymentProvided && askedDownPaymentRecently)
      );
    })()
  ) {
    const monthlyBudget = paymentBudgetContext.monthlyBudget ?? null;
    const termMonths = paymentBudgetContext.termMonths ?? null;
    const downPayment = paymentBudgetContext.downPayment ?? null;
    let reply: string | null = null;
    if (isModelUnknownForPayments(conv)) {
      const budgetHint =
        monthlyBudget && Number.isFinite(monthlyBudget)
          ? ` around $${Number(monthlyBudget).toLocaleString("en-US")}/mo`
          : "";
      reply = `Got it${budgetHint}. Which bike are you looking at so I can run it correctly?`;
      setDialogState(conv, "pricing_need_model");
    } else if (isDownPaymentQuestion(event.body ?? "") && !monthlyBudget) {
      reply = "Got it — what monthly payment are you trying to stay around?";
      if (!isScheduleDialogState(getDialogState(conv))) {
        setDialogState(conv, "pricing_init");
      }
    } else if (monthlyBudget && termMonths && downPayment == null && isDownPaymentQuestion(event.body ?? "")) {
      reply = "Got it — are you planning a trade-in or cash down?";
      if (!isScheduleDialogState(getDialogState(conv))) {
        setDialogState(conv, "pricing_init");
      }
    } else if (monthlyBudget && downPayment != null && !termMonths) {
      const downLabel = `$${Number(downPayment).toLocaleString("en-US")}`;
      reply = `Perfect — with ${downLabel} down, do you want me to run 60, 72, or 84 months?`;
      if (!isScheduleDialogState(getDialogState(conv))) {
        setDialogState(conv, "pricing_init");
      }
    } else if (!monthlyBudget && termMonths && downPayment != null) {
      const downLabel =
        Number(downPayment) <= 0
          ? "$0 down"
          : `$${Number(downPayment).toLocaleString("en-US")} down`;
      reply = `Got it — ${downLabel} at ${termMonths} months. What monthly payment are you trying to stay around?`;
      if (!isScheduleDialogState(getDialogState(conv))) {
        setDialogState(conv, "pricing_init");
      }
    } else if (monthlyBudget && downPayment != null && termMonths) {
      const downValue = Number(downPayment);
      const downLabel =
        downValue <= 0 ? "$0 down" : `$${Number(downPayment).toLocaleString("en-US")} down`;
      const budgetLabel = `$${Number(monthlyBudget).toLocaleString("en-US")}/mo`;
      const stockId = conv.lead?.vehicle?.stockId ?? null;
      const vin = conv.lead?.vehicle?.vin ?? null;
      const match = stockId || vin ? await findInventoryPrice({ stockId, vin }) : null;
      const item = match?.item ?? null;
      const itemPrice = Number(item?.price ?? NaN);
      if (Number.isFinite(itemPrice) && itemPrice > 0) {
        const isUsed = isUsedInventoryConditionForBudget(
          item?.condition ?? conv.lead?.vehicle?.condition,
          item?.year ?? conv.lead?.vehicle?.year
        );
        const taxRate = normalizeTaxRate((await getDealerProfileHot())?.taxRate ?? 8);
        const paymentBand = estimateMonthlyPaymentBandFromPrice({
          price: itemPrice,
          isUsed,
          termMonths,
          taxRate,
          downPayment
        });
        if (paymentBand) {
          const lowRounded = Math.round(paymentBand.low / 10) * 10;
          const highRounded = Math.round(paymentBand.high / 10) * 10;
          const priceLabel = `$${Math.round(itemPrice).toLocaleString("en-US")}`;
          reply =
            `Ballpark, with ${downLabel} on about ${priceLabel} at ${termMonths} months, ` +
            `you’re around $${lowRounded.toLocaleString("en-US")}–$${highRounded.toLocaleString("en-US")}/mo ` +
            `depending on taxes, fees, and APR.`;
          if (downValue <= 0) {
            reply += " $0 down options are application-dependent and lender approval is required.";
          }
        } else {
          reply = `Perfect — with ${downLabel} at ${termMonths} months targeting ${budgetLabel}, I can run the exact numbers now.`;
        }
      } else {
        reply = `Perfect — with ${downLabel} at ${termMonths} months targeting ${budgetLabel}, I can run the exact numbers now.`;
      }
      if (!isScheduleDialogState(getDialogState(conv))) {
        setDialogState(conv, "pricing_init");
      }
    }
    if (reply) {
      const systemMode = webhookMode;
      if (systemMode === "suggest") {
        appendOutbound(conv, event.to, event.from, reply, "draft_ai");
        const twiml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response></Response>`;
        return res.status(200).type("text/xml").send(twiml);
      }
      appendOutbound(conv, event.to, event.from, reply, "twilio");
      const twiml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n  <Message>${escapeXml(
        reply
      )}</Message>\n</Response>`;
      return res.status(200).type("text/xml").send(twiml);
    }
  }
  if (event.provider === "twilio" && schedulingAllowed && schedulingSignals.hasDayOnlyRequest) {
    const dayInfo = parseDayOfWeek(textLower);
    const dayPart = extractDayPart(textLower);
    const stockId = conv.lead?.vehicle?.stockId ?? null;
    const vin = conv.lead?.vehicle?.vin ?? null;
    if (dayInfo && dayPart && (stockId || vin)) {
      const match = await findInventoryPrice({ stockId, vin });
      if (match?.item) {
        const unitLabel = stockId || vin || "that unit";
        const dayPhrase = `${dayInfo.day} ${dayPart}`;
        const reply = `Got it — ${unitLabel} is available right now. ${dayPhrase} works — what time were you thinking?`;
        setDialogState(conv, "schedule_request");
        const systemMode = webhookMode;
        if (systemMode === "suggest") {
          appendOutbound(conv, event.to, event.from, reply, "draft_ai");
          const twiml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response></Response>`;
          return res.status(200).type("text/xml").send(twiml);
        }
        appendOutbound(conv, event.to, event.from, reply, "twilio");
        const twiml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n  <Message>${escapeXml(
          reply
        )}</Message>\n</Response>`;
        return res.status(200).type("text/xml").send(twiml);
      }
    }
  }
  if (turnPrimaryIntent === "callback" && !isScheduleDialogState(getDialogState(conv))) {
    setDialogState(conv, "callback_requested");
  }
  if (
    event.provider === "twilio" &&
    intentLow &&
    !shortAck &&
    !lastOutboundAskedQuestion &&
    !schedulingSignalsBase.explicit &&
    !schedulingSignalsBase.hasDayTime &&
    !schedulingSignalsBase.hasDayOnlyAvailability &&
    !schedulingSignalsBase.hasDayOnlyRequest
  ) {
    let reply = "";
    if (intentParse?.intent === "callback") {
      reply = "Just to confirm — do you want me to have someone call you?";
    } else if (intentParse?.intent === "test_ride") {
      reply = "Just to confirm — are you looking to set up a test ride?";
    } else if (intentParse?.intent === "availability") {
      reply = "Just to confirm — are you asking about availability on a bike?";
    }
    if (reply) {
      if (intentParse?.intent === "test_ride") {
        setDialogState(conv, "test_ride_init");
      }
      const systemMode = webhookMode;
      if (systemMode === "suggest") {
        appendOutbound(conv, event.to, event.from, reply, "draft_ai");
        const twiml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response></Response>`;
        return res.status(200).type("text/xml").send(twiml);
      }
      appendOutbound(conv, event.to, event.from, reply, "twilio");
      const twiml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n  <Message>${escapeXml(
        reply
      )}</Message>\n</Response>`;
      return res.status(200).type("text/xml").send(twiml);
    }
  }
  if (
    event.provider === "twilio" &&
    schedulingAllowed &&
    !pricingOrPaymentsIntent &&
    bookingIntentLow &&
    !schedulingSignalsBase.hasDayTime &&
    !schedulingSignalsBase.hasDayOnlyRequest &&
    !schedulingSignalsBase.hasDayOnlyAvailability &&
    !lastOutboundAskedQuestion
  ) {
    const reply = "Just to confirm — are you looking to set a time to stop in?";
    setDialogState(conv, "clarify_schedule");
    const systemMode = webhookMode;
    if (systemMode === "suggest") {
      appendOutbound(conv, event.to, event.from, reply, "draft_ai");
      const twiml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response></Response>`;
      return res.status(200).type("text/xml").send(twiml);
    }
    appendOutbound(conv, event.to, event.from, reply, "twilio");
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n  <Message>${escapeXml(
      reply
    )}</Message>\n</Response>`;
    return res.status(200).type("text/xml").send(twiml);
  }
  if (event.provider === "twilio" && schedulingExplicit && conv.followUp?.mode === "holding_inventory") {
    setFollowUpMode(conv, "active", "customer_requested_appointment");
  }
  const schedulingBlocked =
    conv.followUp?.mode === "manual_handoff" ||
    conv.followUp?.mode === "holding_inventory" ||
    outboundHoldNotice ||
    !schedulingAllowed;
  console.log("[deterministic-offer] scheduleExplicit", { schedulingExplicit });
  const metaPromoSource = /meta promo offer/i.test(conv.lead?.source ?? "");
  const currentModel = conv.lead?.vehicle?.model ?? conv.lead?.vehicle?.description ?? "";
  const unknownModel = !currentModel || /other|full line/i.test(currentModel);
  const hoursQuestion =
    /\bhours?\b/.test(textLower) ||
    /(what time.*open|what time.*close|when.*open|when.*close|opening hours|closing time)/.test(
      textLower
    );

  if (event.provider === "twilio" && hoursQuestion) {
    const cfg = await getSchedulerConfigHot();
    const dealerProfile = await getDealerProfileHot();
    const country = dealerProfile?.address?.country ?? null;
    const directDayRequest = extractDayRequest(textLower);
    const wantsToday = /\btoday\b/.test(textLower);
    const wantsTomorrow = /\btomorrow\b/.test(textLower);
    const wantsTonight = /\b(tonight|tonite)\b/.test(textLower);
    let dayRequest = directDayRequest;
    if (!dayRequest && (wantsToday || wantsTonight)) {
      dayRequest = dayKey(new Date(), cfg.timezone);
    } else if (!dayRequest && wantsTomorrow) {
      const nextDay = new Date();
      nextDay.setDate(nextDay.getDate() + 1);
      dayRequest = dayKey(nextDay, cfg.timezone);
    }
    const hoursLine = formatBusinessHoursForReply(cfg.businessHours, country);
    let reply = "Our hours vary by day. What day are you thinking?";
    if (dayRequest) {
      const dayHours = cfg.businessHours?.[dayRequest];
      if (dayHours?.open && dayHours?.close) {
        const open = formatTime12h(dayHours.open);
        const close = formatTime12h(dayHours.close);
        const dayLabel =
          wantsTonight || wantsToday
            ? "today"
            : wantsTomorrow
              ? "tomorrow"
              : dayRequest.replace(/^\w/, c => c.toUpperCase());
        reply = `Our hours on ${dayLabel} are ${open}–${close}.`;
      } else {
        const dayLabel =
          wantsTonight || wantsToday
            ? "today"
            : wantsTomorrow
              ? "tomorrow"
              : dayRequest.replace(/^\w/, c => c.toUpperCase());
        reply = `We’re closed on ${dayLabel}.`;
      }
    } else if (hoursLine) {
      reply = `Our hours this week are ${hoursLine}.`;
    }
    const confirmBike =
      /\b(that'?s (it|the one|the bike)|that one|yep|yup|yes)\b/i.test(textLower);
    const contextModel = conv.inventoryContext?.model ?? conv.lead?.vehicle?.model ?? null;
    const contextYear = conv.inventoryContext?.year ?? conv.lead?.vehicle?.year ?? null;
    const contextColor = conv.inventoryContext?.color ?? null;
    if (confirmBike && contextModel) {
      const label = `${contextYear ? `${contextYear} ` : ""}${contextModel}`.trim();
      const colorText = contextColor ? ` in ${contextColor}` : "";
      reply = `Yes — the ${label}${colorText} is in stock. ${reply}`;
    }
    const isSalesLead =
      !isServiceLead &&
      (!!conv.lead?.vehicle?.model ||
        !!conv.lead?.vehicle?.year ||
        !!conv.lead?.tradeVehicle?.model ||
        !!conv.lead?.tradeVehicle?.description ||
        (conv.classification?.bucket &&
          !["service", "other"].includes(String(conv.classification.bucket))));
    const canInviteSchedule =
      isSalesLead &&
      schedulingAllowed &&
      conv.followUp?.mode !== "manual_handoff" &&
      conv.followUp?.mode !== "holding_inventory" &&
      !outboundHoldNotice;
    if (canInviteSchedule) {
      reply = `${reply} If you’re thinking about coming in, what time works best? I can put you down on the schedule.`;
    }
    if (webhookMode === "suggest") {
      appendOutbound(conv, event.to, event.from, reply, "draft_ai");
      const twiml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response></Response>`;
      return res.status(200).type("text/xml").send(twiml);
    }
    appendOutbound(conv, event.to, event.from, reply, "twilio");
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n  <Message>${escapeXml(
      reply
    )}</Message>\n</Response>`;
    return res.status(200).type("text/xml").send(twiml);
  }
  if (metaPromoSource && unknownModel) {
    const foundModels = await inferModelsFromText(String(event.body ?? ""));
    if (foundModels.length === 1) {
      const foundModel = foundModels[0];
      const yearMatch = textLower.match(/\b(20\d{2}|19\d{2})\b/);
      const yearFound = yearMatch?.[1];
      conv.lead = conv.lead ?? {};
      conv.lead.vehicle = conv.lead.vehicle ?? {};
      if (yearFound) conv.lead.vehicle.year = yearFound;
      conv.lead.vehicle.model = foundModel;
      if (!conv.lead.vehicle.description) {
        conv.lead.vehicle.description = foundModel;
      }
      saveConversation(conv);
    } else if (foundModels.length > 1) {
      conv.lead = conv.lead ?? {};
      conv.lead.vehicle = conv.lead.vehicle ?? {};
      conv.lead.vehicle.modelOptions = foundModels;
      saveConversation(conv);
      const dealerProfile = await getDealerProfileHot();
      const dealerName = dealerProfile?.dealerName ?? "American Harley-Davidson";
      const agentName = dealerProfile?.agentName ?? "Brooke";
      const firstName = normalizeDisplayCase(conv.lead?.firstName);
      const greeting = firstName ? `Hi ${firstName} — ` : "Hi — ";
      const replyRaw =
        `${greeting}thanks for your H‑D Meta promo offer request. ` +
        `This is ${agentName} at ${dealerName}. ` +
        `Are you leaning more toward ${foundModels.join(" or ")}?`;
      const reply = ensureUniqueDraft(replyRaw, conv, dealerName, agentName);
      if (webhookMode === "suggest") {
        appendOutbound(conv, event.to, event.from, reply, "draft_ai");
        const twiml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response></Response>`;
        return res.status(200).type("text/xml").send(twiml);
      }
      appendOutbound(conv, event.to, event.from, reply, "twilio");
      const twiml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n  <Message>${escapeXml(
        reply
      )}</Message>\n</Response>`;
      return res.status(200).type("text/xml").send(twiml);
    }
  }
  const clarificationReply = isClarificationReply(String(event.body ?? ""));
  const lastWasInventoryUncertain =
    /(not seeing|in stock|verify|inventory availability|check.*inventory|follow up shortly)/i.test(
      lastOutboundText
    );
  if (event.provider === "twilio" && clarificationReply && lastWasInventoryUncertain) {
    const reply =
      "Sorry for the confusion — I meant I don’t see that exact bike/color in stock right now. " +
      "Want me to check similar options or other years/colors?";
    const systemMode = webhookMode;
    if (systemMode === "suggest") {
      appendOutbound(conv, event.to, event.from, reply, "draft_ai");
      const twiml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response></Response>`;
      return res.status(200).type("text/xml").send(twiml);
    }
    appendOutbound(conv, event.to, event.from, reply, "twilio");
    const twiml = `<?xml version="1.0\" encoding=\"UTF-8\"?>\n<Response>\n  <Message>${escapeXml(
      reply
    )}</Message>\n</Response>`;
    return res.status(200).type("text/xml").send(twiml);
  }

  const lastAskedReminder =
    /\b(set a reminder|reminder|check back)\b/i.test(lastOutboundText) &&
    /\?\s*$/.test(lastOutboundText.trim());
  if (event.provider === "twilio" && lastAskedReminder && isAffirmative(event.body)) {
    const futureFromReply = parseFutureTimeframe(String(event.body ?? ""), new Date());
      if (futureFromReply?.until) {
        const untilIso = futureFromReply.until.toISOString();
        if (!conv.followUpCadence || conv.followUpCadence.status === "stopped") {
          scheduleLongTermFollowUp(conv, untilIso, "customer_reminder");
        } else {
          pauseFollowUpCadence(conv, untilIso, "customer_reminder");
        }
        if (conv.followUp?.mode !== "holding_inventory" && conv.followUp?.mode !== "manual_handoff") {
          setFollowUpMode(conv, "active", "customer_reminder");
          setDialogState(conv, "followup_resumed");
        }
      } else {
        stopFollowUpCadence(conv, "customer_reminder");
        setFollowUpMode(conv, "paused_indefinite", "customer_reminder");
        setDialogState(conv, "followup_paused");
      }
    const dealerProfile = await getDealerProfileHot();
    const dealerName = dealerProfile?.dealerName ?? "American Harley-Davidson";
    const agentName = dealerProfile?.agentName ?? "Brooke";
    const label = futureFromReply?.label;
    const labelText = label ? label.charAt(0).toUpperCase() + label.slice(1) : "";
    const replyRaw = label
      ? `Sounds good — I’ll pause things until ${labelText}. Just reach out when the time is right.`
      : "Got it — I’m here when you’re ready. Just reach out when the time is right.";
    const reply = ensureUniqueDraft(replyRaw, conv, dealerName, agentName);
    const systemMode = webhookMode;
    if (systemMode === "suggest") {
      appendOutbound(conv, event.to, event.from, reply, "draft_ai");
      const twiml = `<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<Response></Response>`;
      return res.status(200).type("text/xml").send(twiml);
    }
    appendOutbound(conv, event.to, event.from, reply, "twilio");
    const twiml = `<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<Response>\n  <Message>${escapeXml(
      reply
    )}</Message>\n</Response>`;
    return res.status(200).type("text/xml").send(twiml);
  }

  const notReadyToBuy =
    /\b(not ready|not (yet|right now)|not in the market|not looking to buy|not looking for|just browsing|just looking|window shopping|not ready to purchase|not ready to buy)\b/i.test(
      textLower
    );
  if (event.provider === "twilio" && notReadyToBuy) {
    const futureFromNotReady = parseFutureTimeframe(String(event.body ?? ""), new Date());
    if (!futureFromNotReady) {
      stopFollowUpCadence(conv, "not_ready_no_timeframe");
      setFollowUpMode(conv, "paused_indefinite", "not_ready_no_timeframe");
      setDialogState(conv, "followup_paused");
      const dealerProfile = await getDealerProfileHot();
      const dealerName = dealerProfile?.dealerName ?? "American Harley-Davidson";
      const agentName = dealerProfile?.agentName ?? "Brooke";
      const replyRaw = buildFriendlyReachOutClose(false);
      const reply = ensureUniqueDraft(replyRaw, conv, dealerName, agentName);
      const systemMode = webhookMode;
      if (systemMode === "suggest") {
        appendOutbound(conv, event.to, event.from, reply, "draft_ai");
        const twiml = `<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<Response></Response>`;
        return res.status(200).type("text/xml").send(twiml);
      }
      appendOutbound(conv, event.to, event.from, reply, "twilio");
      const twiml = `<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<Response>\n  <Message>${escapeXml(
        reply
      )}</Message>\n</Response>`;
      return res.status(200).type("text/xml").send(twiml);
    }
  }

  const future = parseFutureTimeframe(String(event.body ?? ""), new Date());
  const weatherLikeQuestion =
    /\b(weather|forecast|temperature|temp|snow|cold|rain|nicest day|nice day|best day)\b/i.test(textLower);
  const shouldSkipFuture =
    schedulingSignalsBase.hasDayTime ||
    looksLikeTimeSelection(textLower) ||
    schedulingSignalsBase.explicit ||
    weatherLikeQuestion;
  if (event.provider === "twilio" && future && !shouldSkipFuture) {
    conv.lead = conv.lead ?? {};
    if (future.label) conv.lead.purchaseTimeframe = future.label;
    if (future.until) {
      const untilIso = future.until.toISOString();
      if (!conv.followUpCadence || conv.followUpCadence.status === "stopped") {
        scheduleLongTermFollowUp(conv, untilIso, "future_timeframe");
      } else {
        pauseFollowUpCadence(conv, untilIso, "future_timeframe");
      }
      if (conv.followUp?.mode !== "holding_inventory" && conv.followUp?.mode !== "manual_handoff") {
        setFollowUpMode(conv, "active", "future_timeframe");
        setDialogState(conv, "followup_resumed");
      }
    } else {
      stopFollowUpCadence(conv, "future_timeframe");
      setFollowUpMode(conv, "paused_indefinite", "future_timeframe");
      setDialogState(conv, "followup_paused");
    }
    const dealerProfile = await getDealerProfileHot();
    const dealerName = dealerProfile?.dealerName ?? "American Harley-Davidson";
    const agentName = dealerProfile?.agentName ?? "Brooke";
    const label = future.label;
    const labelText = label.charAt(0).toUpperCase() + label.slice(1);
    const replyRaw = `Got it — I’ll pause things until ${labelText}. Just reach out when the time is right.`;
    const reply = ensureUniqueDraft(replyRaw, conv, dealerName, agentName);
    const systemMode = webhookMode;
    if (systemMode === "suggest") {
      appendOutbound(conv, event.to, event.from, reply, "draft_ai");
      const twiml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response></Response>`;
      return res.status(200).type("text/xml").send(twiml);
    }
    appendOutbound(conv, event.to, event.from, reply, "twilio");
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n  <Message>${escapeXml(
      reply
    )}</Message>\n</Response>`;
    return res.status(200).type("text/xml").send(twiml);
  }

  if (event.provider === "twilio" && wantsReminder(event.body)) {
    const pauseUntil = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString();
    pauseFollowUpCadence(conv, pauseUntil, "customer_reminder");
    const dealerProfile = await getDealerProfileHot();
    const dealerName = dealerProfile?.dealerName ?? "American Harley-Davidson";
    const agentName = dealerProfile?.agentName ?? "Brooke";
    const replyRaw =
      "Sounds good — I’m here when you’re ready. Just reach out when the time is right.";
    const reply = ensureUniqueDraft(replyRaw, conv, dealerName, agentName);
    const systemMode = webhookMode;
    if (systemMode === "suggest") {
      appendOutbound(conv, event.to, event.from, reply, "draft_ai");
      const twiml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response></Response>`;
      return res.status(200).type("text/xml").send(twiml);
    }
    appendOutbound(conv, event.to, event.from, reply, "twilio");
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n  <Message>${escapeXml(
      reply
    )}</Message>\n</Response>`;
    return res.status(200).type("text/xml").send(twiml);
  }

  const locationQuestion = /(where are you|what location|what address|address|located|location)\b/i.test(
    textLower
  );
  const weatherQuestion =
    /\b(nicest day|nice day|best day)\b/i.test(textLower) ||
    /\b(what(?:'s| is)|how(?:'s| is)|is it|will it|can i|can we|should i|should we)\b[^.!?]*\b(weather|forecast|temperature|temp|snow|cold|rain)\b/i.test(
      textLower
    ) ||
    /\b(weather|forecast|temperature|temp)\b[^.!?]*\?/i.test(textLower) ||
    /\b(is it|will it)\b[^.!?]*\b(rain|snow|cold)\b/i.test(textLower);
  const bestDayQuestion = /\b(nicest day|nice day|best day)\b/i.test(textLower);
  const mentionsNextWeek = /\bnext week\b/i.test(textLower);
  if (event.provider === "twilio" && weatherQuestion) {
    const cfg = await getSchedulerConfigHot();
    const tz = cfg.timezone || "America/New_York";
    const dealerProfile = await getDealerProfileHot();
    const dayRequest = extractDayRequest(textLower);
    const wantsToday = /\btoday\b/.test(textLower);
    const wantsTomorrow = /\btomorrow\b/.test(textLower);
    const stateName = getDialogState(conv);
    const tradeContext =
      (stateName && stateName.startsWith("trade_")) ||
      conv.classification?.bucket === "trade_in_sell" ||
      conv.classification?.cta === "sell_my_bike" ||
      conv.classification?.cta === "trade_in" ||
      conv.lastIntent?.name === "trade";
    const rideContext = /\b(test ride|ride it in|ride in)\b/i.test(textLower);
    let targetParts: { year: number; month: number; day: number } | null = null;
    let dayLabel = "";
    let bestForecast: DailyForecast | null = null;
    if (dayRequest) {
      targetParts = nextLocalDateForWeekday(dayRequest, tz);
      dayLabel = dayRequest.replace(/^\w/, c => c.toUpperCase());
    } else if (wantsTomorrow) {
      const d = new Date();
      d.setDate(d.getDate() + 1);
      const parts = getLocalDateParts(d, tz);
      targetParts = { year: parts.year, month: parts.month, day: parts.day };
      dayLabel = "Tomorrow";
    } else if (wantsToday) {
      const parts = getLocalDateParts(new Date(), tz);
      targetParts = { year: parts.year, month: parts.month, day: parts.day };
      dayLabel = "Today";
    }

    if (!targetParts && bestDayQuestion) {
      const forecasts = await getDealerDailyForecasts(dealerProfile);
      if (forecasts?.length) {
        const sorted = forecasts
          .filter(f => f?.date)
          .slice()
          .sort((a, b) => {
            const aSnow = a.snow ? 1 : 0;
            const bSnow = b.snow ? 1 : 0;
            if (aSnow !== bSnow) return aSnow - bSnow;
            const aMax = typeof a.maxTempF === "number" ? a.maxTempF : -999;
            const bMax = typeof b.maxTempF === "number" ? b.maxTempF : -999;
            if (aMax !== bMax) return bMax - aMax;
            return String(a.date).localeCompare(String(b.date));
          });
        bestForecast = sorted[0] ?? null;
        if (bestForecast?.date) {
          const [yy, mm, dd] = bestForecast.date.split("-").map(Number);
          if (Number.isFinite(yy) && Number.isFinite(mm) && Number.isFinite(dd)) {
            targetParts = { year: yy, month: mm, day: dd };
            const label = new Date(`${bestForecast.date}T12:00:00`).toLocaleDateString("en-US", {
              weekday: "long",
              timeZone: tz
            });
            dayLabel = label || (mentionsNextWeek ? "Next week" : "");
          }
        }
      }
    }

    if (!targetParts) {
      const reply = bestDayQuestion
        ? "Happy to check — any specific day next week you’re thinking?"
        : "Sure — which day are you wondering about?";
      const systemMode = webhookMode;
      if (systemMode === "suggest") {
        appendOutbound(conv, event.to, event.from, reply, "draft_ai");
        const twiml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response></Response>`;
        return res.status(200).type("text/xml").send(twiml);
      }
      appendOutbound(conv, event.to, event.from, reply, "twilio");
      const twiml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n  <Message>${escapeXml(
        reply
      )}</Message>\n</Response>`;
      return res.status(200).type("text/xml").send(twiml);
    }

    const dateIso = formatDatePartsIso(targetParts);
    const forecast = bestForecast ?? (await getDealerDailyForecast(dealerProfile, dateIso));
    const cfgWeather = getWeatherConfig(dealerProfile);
    const coldThreshold = Number(cfgWeather.coldThresholdF ?? 50);
    let reply = "";
    if (!forecast) {
      reply = "I couldn’t pull the forecast just now. If you want, I can check again shortly.";
    } else {
      const lowVal = typeof forecast.minTempF === "number" ? Math.round(forecast.minTempF) : null;
      const highVal = typeof forecast.maxTempF === "number" ? Math.round(forecast.maxTempF) : null;
      const tempText =
        lowVal !== null && highVal !== null
          ? `${lowVal}–${highVal}°F`
          : highVal !== null
            ? `${highVal}°F`
            : lowVal !== null
              ? `${lowVal}°F`
              : "mild";
      const cold = lowVal !== null ? lowVal < coldThreshold : highVal !== null ? highVal < coldThreshold : false;
      const rough = cold || forecast.snow;
      const lineA = forecast.snow
        ? `Looks like ${dayLabel} is around ${tempText} here at the dealership, and snow is possible.`
        : `Looks like ${dayLabel} is around ${tempText} here at the dealership.`;
      const lineB = rough
        ? `${dayLabel} here looks ${forecast.snow ? "rough" : "cold"} — about ${tempText}.`
        : `${dayLabel} here looks around ${tempText}.`;
      const tradeAltA = rough
        ? ` If it stays ${forecast.snow ? "cold or snowy" : "cold"}, we can pick it up for a trade evaluation instead.`
        : "";
      const tradeAltB = rough
        ? " If the weather’s rough, we can pick it up for a trade evaluation instead of having you ride it in."
        : "";
      const rideAltA = rough
        ? ` If it stays ${forecast.snow ? "cold or snowy" : "cold"}, we can plan the test ride for a better day.`
        : "";
      const rideAltB = rough
        ? " If the weather’s rough, we can plan the test ride for a better day."
        : "";
      const extraA = tradeContext ? tradeAltA : rideContext ? rideAltA : "";
      const extraB = tradeContext ? tradeAltB : rideContext ? rideAltB : "";
      reply = pickVariantByKey(conv.leadKey ?? event.from, [lineA + extraA, lineB + extraB]);
    }
    const systemMode = webhookMode;
    if (systemMode === "suggest") {
      appendOutbound(conv, event.to, event.from, reply, "draft_ai");
      const twiml = `<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<Response></Response>`;
      return res.status(200).type("text/xml").send(twiml);
    }
    appendOutbound(conv, event.to, event.from, reply, "twilio");
    const twiml = `<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<Response>\n  <Message>${escapeXml(
      reply
    )}</Message>\n</Response>`;
    return res.status(200).type("text/xml").send(twiml);
  }
  if (event.provider === "twilio" && locationQuestion) {
    const dealerProfile = await getDealerProfileHot();
    const dealerName = dealerProfile?.dealerName ?? "American Harley-Davidson";
    const agentName = dealerProfile?.agentName ?? "Brooke";
    const address = dealerProfile?.address;
    const line1 = address?.line1 ?? "1149 Erie Ave.";
    const city = address?.city ?? "North Tonawanda";
    const state = address?.state ?? "NY";
    const zip = address?.zip ?? "14120";
    const replyRaw =
      `Hi — this is ${agentName} at ${dealerName}. We’re located at ${line1}, ${city}, ${state} ${zip}. ` +
      "Do you want pricing details or a quick model comparison?";
    const reply = ensureUniqueDraft(replyRaw, conv, dealerName, agentName);
    const systemMode = webhookMode;
    if (systemMode === "suggest") {
      appendOutbound(conv, event.to, event.from, reply, "draft_ai");
      const twiml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response></Response>`;
      return res.status(200).type("text/xml").send(twiml);
    }
    appendOutbound(conv, event.to, event.from, reply, "twilio");
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n  <Message>${escapeXml(
      reply
    )}</Message>\n</Response>`;
    return res.status(200).type("text/xml").send(twiml);
  }

  const testRideQuestion =
    /\b(test ride|demo ride|ride it|take (it )?for a ride)\b/i.test(textLower) &&
    /\b(while|when|during|there|visit|come in|stop in|stop by|appointment)\b/i.test(textLower);
  if (event.provider === "twilio" && testRideQuestion) {
    const requirements =
      "For a test ride, please bring a motorcycle endorsement, a DOT helmet, eyewear, long pants, a long sleeve shirt, and over-the-ankle boots.";
    const dealerProfile = await getDealerProfileHot();
    const weather = await getDealerWeatherStatus(dealerProfile);
    const reply = conv.appointment?.bookedEventId
      ? weather?.bad
        ? `If the weather’s rough, we can plan the test ride for a better day. ${requirements} If you want to reschedule, just let me know.`
        : `Yes — we can plan a test ride during your visit. ${requirements}`
      : weather?.bad
        ? `If the weather’s rough, we can plan the test ride for a better day. ${requirements} If you want me to set one up, just let me know.`
        : `Yes — we can set that up during your visit. ${requirements} If you want me to add a test ride to your visit, just let me know.`;
    const systemMode = webhookMode;
    if (systemMode === "suggest") {
      appendOutbound(conv, event.to, event.from, reply, "draft_ai");
      const twiml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response></Response>`;
      return res.status(200).type("text/xml").send(twiml);
    }
    appendOutbound(conv, event.to, event.from, reply, "twilio");
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n  <Message>${escapeXml(
      reply
    )}</Message>\n</Response>`;
    return res.status(200).type("text/xml").send(twiml);
  }

  if (event.provider === "twilio" && conv.pickup?.stage) {
    const stage = conv.pickup.stage;
    const townRaw = String(event.body ?? "").trim();
    if (stage === "need_town") {
      if (shouldAskForTown(townRaw)) {
        const reply = "Got it — where are you located?";
        const systemMode = webhookMode;
        if (systemMode === "suggest") {
          appendOutbound(conv, event.to, event.from, reply, "draft_ai");
          const twiml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response></Response>`;
          return res.status(200).type("text/xml").send(twiml);
        }
        appendOutbound(conv, event.to, event.from, reply, "twilio");
        const twiml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n  <Message>${escapeXml(
          reply
        )}</Message>\n</Response>`;
        return res.status(200).type("text/xml").send(twiml);
      }

      const dealerProfile = await getDealerProfileHot();
      const coords = await resolveDealerLatLon(dealerProfile);
      const cfg = getWeatherConfig(dealerProfile);
      let townLabel = townRaw;
      let eligible: boolean | undefined;
      let distance: number | undefined;
      if (coords) {
        const match = await resolveTownNearestDealer(townRaw, coords.lat, coords.lon);
        if (match) {
          distance = Math.round(match.distanceMiles * 10) / 10;
          eligible = distance <= Number(cfg.pickupRadiusMiles ?? 25);
          townLabel = formatTownLabel(match.name, match.state);
        }
      }
      conv.pickup = {
        ...(conv.pickup ?? {}),
        stage: "need_street",
        town: townLabel,
        distanceMiles: distance,
        eligible,
        updatedAt: nowIso()
      };
      saveConversation(conv);
      const reply = eligible === false
        ? `Thanks — ${townLabel} is about ${distance ?? ""} miles from us. I’ll have to check with the driver to see if we can get a pick-up scheduled. What street address (number and street) should we use?`
        : eligible === true
          ? `Thanks — ${townLabel} is within our pickup range. What street address (number and street) should we use?`
          : "Thanks — I’ll have to check with the driver to see if we can get a pick-up scheduled. What street address (number and street) should we use?";
      const systemMode = webhookMode;
      if (systemMode === "suggest") {
        appendOutbound(conv, event.to, event.from, reply, "draft_ai");
        const twiml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response></Response>`;
        return res.status(200).type("text/xml").send(twiml);
      }
      appendOutbound(conv, event.to, event.from, reply, "twilio");
      const twiml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n  <Message>${escapeXml(
        reply
      )}</Message>\n</Response>`;
      return res.status(200).type("text/xml").send(twiml);
    }

    if (stage === "need_street") {
      const streetRaw = String(event.body ?? "").trim();
      if (!/\d+/.test(streetRaw)) {
        const reply = "Thanks — can you share the street number and street name for pickup?";
        const systemMode = webhookMode;
        if (systemMode === "suggest") {
          appendOutbound(conv, event.to, event.from, reply, "draft_ai");
          const twiml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response></Response>`;
          return res.status(200).type("text/xml").send(twiml);
        }
        appendOutbound(conv, event.to, event.from, reply, "twilio");
        const twiml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n  <Message>${escapeXml(
          reply
        )}</Message>\n</Response>`;
        return res.status(200).type("text/xml").send(twiml);
      }
      conv.pickup = {
        ...(conv.pickup ?? {}),
        stage: "ready",
        street: streetRaw,
        updatedAt: nowIso()
      };
      saveConversation(conv);
      const bikeLabel = getSellBikeLabel(conv);
      const town = conv.pickup?.town ?? "";
      const street = conv.pickup?.street ?? "";
      const distance = conv.pickup?.distanceMiles;
      const eligible = conv.pickup?.eligible;
      const mileage = conv.lead?.vehicle?.mileage ?? conv.lead?.tradeVehicle?.mileage;
      const summary =
        `Pickup request: ${bikeLabel}. ` +
        `Address: ${street}${town ? `, ${town}` : ""}. ` +
        (mileage ? `Mileage: ${mileage}. ` : "") +
        (typeof distance === "number"
          ? `Distance: ${distance} miles${eligible === false ? " (outside pickup range)" : ""}.`
          : "Distance: unknown.");
      addTodo(conv, "service", summary, event.providerMessageId);
      setFollowUpMode(conv, "manual_handoff", "pickup_request");
      stopFollowUpCadence(conv, "pickup_request");
      stopRelatedCadences(conv, "pickup_request", { setMode: "manual_handoff" });
      const reply = "Thanks — I’ll have our service department reach out to schedule the pickup.";
      const systemMode = webhookMode;
      if (systemMode === "suggest") {
        appendOutbound(conv, event.to, event.from, reply, "draft_ai");
        const twiml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response></Response>`;
        return res.status(200).type("text/xml").send(twiml);
      }
      appendOutbound(conv, event.to, event.from, reply, "twilio");
      const twiml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n  <Message>${escapeXml(
        reply
      )}</Message>\n</Response>`;
      return res.status(200).type("text/xml").send(twiml);
    }
  }

  if (
    event.provider === "twilio" &&
    conv.inventoryWatchPending &&
    isExplicitAvailabilityQuestion(textLower) &&
    !isWatchConfirmationIntentText(String(event.body ?? ""))
  ) {
    // Customer asked a fresh availability question; don't force pending watch clarification.
    conv.inventoryWatchPending = undefined;
  }

  const watchPendingBlockedByPricingIntent =
    suppressWatchIntentThisTurn;
  if (
    event.provider === "twilio" &&
    conv.inventoryWatchPending &&
    !inventoryCountQuestion &&
    !watchPendingBlockedByPricingIntent
  ) {
    const cfg = await getSchedulerConfigHot();
    const tz = cfg.timezone || "America/New_York";
    const explicitRequested = parseRequestedDayTime(String(event.body ?? ""), tz);
    const hasDayTime = schedulingSignals.hasDayTime;
    const hasDayOnlyAvailability = schedulingSignals.hasDayOnlyAvailability;
    const watchConfirmIntent = isWatchConfirmationIntentText(String(event.body ?? ""));
    const watchAsSideEffectOnly = hasPrimaryIntentBeyondWatch(String(event.body ?? ""));
    // If the customer explicitly asks for a day/time, let scheduling handle it.
    // But when the text is an explicit watch-confirmation intent, do not let
    // scheduling classification block watch resolution.
    const watchFlowAllowed =
      watchConfirmIntent ||
      (!explicitRequested && !hasDayTime && !hasDayOnlyAvailability && !schedulingExplicit);
    if (watchFlowAllowed) {
      const pending = conv.inventoryWatchPending;
      if (!pending.model) {
        const resolvedModel = await resolveWatchModelFromText(
          textLower,
          conv.lead?.vehicle?.model ?? conv.lead?.vehicle?.description ?? null
        );
        if (!resolvedModel) {
          if (!watchAsSideEffectOnly) {
            const reply = "Got it — which model should I watch for?";
            setDialogState(conv, "inventory_watch_prompted");
            const systemMode = webhookMode;
            if (systemMode === "suggest") {
              appendOutbound(conv, event.to, event.from, reply, "draft_ai");
              const twiml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response></Response>`;
              return res.status(200).type("text/xml").send(twiml);
            }
            appendOutbound(conv, event.to, event.from, reply, "twilio");
            const twiml = `<?xml version="1.0\" encoding=\"UTF-8\"?>\n<Response>\n  <Message>${escapeXml(
              reply
            )}</Message>\n</Response>`;
            return res.status(200).type("text/xml").send(twiml);
          }
        } else {
          pending.model = resolvedModel;
          if (!pending.year) {
            const yearFromText = extractYearSingle(textLower);
            if (yearFromText) pending.year = yearFromText;
          }
          if (!pending.color) {
            const colorFromText = combineWatchColorAndFinish(
              extractColorToken(textLower),
              extractFinishToken(textLower)
            );
            if (colorFromText) pending.color = colorFromText;
          }
          const budgetSeed = resolveWatchBudgetPreferenceForConversation(conv, String(event.body ?? ""));
          if (pending.minPrice == null && budgetSeed.minPrice != null) pending.minPrice = budgetSeed.minPrice;
          if (pending.maxPrice == null && budgetSeed.maxPrice != null) pending.maxPrice = budgetSeed.maxPrice;
          if (pending.monthlyBudget == null && budgetSeed.monthlyBudget != null) {
            pending.monthlyBudget = budgetSeed.monthlyBudget;
          }
          if (pending.termMonths == null && budgetSeed.termMonths != null) pending.termMonths = budgetSeed.termMonths;
          if (pending.downPayment == null && budgetSeed.downPayment != null) pending.downPayment = budgetSeed.downPayment;
        }
      }
      const pendingCondition = inferWatchCondition(pending.model, pending.year, conv);
      const finishEligible = await shouldAskFinishPreference(
        pending.model,
        pending.year,
        pendingCondition
      );
      let pref = parseInventoryWatchPreference(String(event.body ?? ""), pending);
      if (pref.action === "ignore" && pending.model && (isAffirmative(event.body) || watchConfirmIntent)) {
        const watchColor = sanitizeColorPhrase(pending.color);
        const watch: InventoryWatch = {
          model: pending.model,
          year: pending.year,
          color: watchColor,
          minPrice: pending.minPrice,
          maxPrice: pending.maxPrice,
          monthlyBudget: pending.monthlyBudget,
          termMonths: pending.termMonths,
          downPayment: pending.downPayment,
          exactness: "model_only",
          status: "active",
          createdAt: new Date().toISOString()
        };
        if (watch.year && watch.color) watch.exactness = "exact";
        else if (watch.year) watch.exactness = "year_model";
        pref = { action: "set", watch };
      }
      if (pref.action === "clarify") {
        if (!watchAsSideEffectOnly) {
          const reply = buildWatchPreferencePrompt(pendingCondition, finishEligible);
          const systemMode = webhookMode;
          if (systemMode === "suggest") {
            appendOutbound(conv, event.to, event.from, reply, "draft_ai");
            const twiml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response></Response>`;
            return res.status(200).type("text/xml").send(twiml);
          }
          appendOutbound(conv, event.to, event.from, reply, "twilio");
          const twiml = `<?xml version="1.0\" encoding=\"UTF-8\"?>\n<Response>\n  <Message>${escapeXml(
            reply
          )}</Message>\n</Response>`;
          return res.status(200).type("text/xml").send(twiml);
        }
      }
      if (pref.action === "set" && pref.watch) {
        const leadVehicle = conv.lead?.vehicle ?? {};
        if (!pref.watch.make && leadVehicle.make) pref.watch.make = leadVehicle.make;
        if (!pref.watch.trim && leadVehicle.trim) pref.watch.trim = leadVehicle.trim;
        const conditionFromText = normalizeWatchCondition(textLower);
        if (!pref.watch.condition && conditionFromText) pref.watch.condition = conditionFromText;
        if (!pref.watch.condition && leadVehicle.condition) {
          pref.watch.condition = normalizeWatchCondition(leadVehicle.condition);
        }
        conv.inventoryWatch = pref.watch;
        conv.inventoryWatches = [pref.watch];
        conv.inventoryWatchPending = undefined;
        setDialogState(conv, "inventory_watch_active");
        setFollowUpMode(conv, "holding_inventory", "inventory_watch");
        stopFollowUpCadence(conv, "inventory_watch");
        const reply = buildInventoryWatchConfirmation(pref.watch);
        if (!watchAsSideEffectOnly) {
          const systemMode = webhookMode;
          if (systemMode === "suggest") {
            appendOutbound(conv, event.to, event.from, reply, "draft_ai");
            const twiml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response></Response>`;
            return res.status(200).type("text/xml").send(twiml);
          }
          appendOutbound(conv, event.to, event.from, reply, "twilio");
          const twiml = `<?xml version="1.0\" encoding=\"UTF-8\"?>\n<Response>\n  <Message>${escapeXml(
            reply
          )}</Message>\n</Response>`;
          return res.status(200).type("text/xml").send(twiml);
        }
      }
    }
  }

  const liveRouteDecision = nextActionFromState({
    provider: event.provider,
    channel: event.channel === "email" ? "email" : "sms",
    isShortAck: false,
    deterministicAvailabilityLookup,
    availabilityIntentOverride: deterministicAvailabilityIntentOverride,
    financePriorityOverride,
    schedulePriorityOverride
  });
  if (liveRouteDecision.kind === "deterministic_availability_lookup") {
    logDecisionTrace("live.route_deterministic_availability", {
      source: "deterministicAvailabilityLookup",
      text: String(event.body ?? "").slice(0, 180)
    });
    const availabilityResolution = await resolveDeterministicAvailabilityReply({
      conv,
      text: event.body ?? "",
      parsedAvailability: llmAvailability,
      otherInventoryRequest
    });
    const reply =
      availabilityResolution.kind === "reply"
        ? availabilityResolution.reply
        : "Which model are you asking about?";
    const extraMediaUrls =
      availabilityResolution.kind === "reply" && Array.isArray(availabilityResolution.mediaUrls)
        ? availabilityResolution.mediaUrls
        : [];
    const systemMode = webhookMode;
    if (systemMode === "suggest") {
      appendOutbound(
        conv,
        event.to,
        event.from,
        reply,
        "draft_ai",
        undefined,
        extraMediaUrls.length ? extraMediaUrls : undefined
      );
      logRouteOutcome("deterministic_availability_draft");
      const twiml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response></Response>`;
      return res.status(200).type("text/xml").send(twiml);
    }
    appendOutbound(
      conv,
      event.to,
      event.from,
      reply,
      "twilio",
      undefined,
      extraMediaUrls.length ? extraMediaUrls : undefined
    );
    logRouteOutcome("deterministic_availability_send");
    const mediaTags = extraMediaUrls.length
      ? extraMediaUrls.map(u => `\n    <Media>${escapeXml(u)}</Media>`).join("")
      : "";
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n  <Message>${escapeXml(
      reply
    )}${mediaTags}\n  </Message>\n</Response>`;
    return res.status(200).type("text/xml").send(twiml);
  }

  const finishPreferenceOnlyRaw =
    /\b(black(?:ed)?\s*(?:out|trim|finish)?|chrome\s*(?:trim|finish)?|black\s*trim|black\s*finish|chrome\s*trim|chrome\s*finish)\b/i.test(
      textLower
    ) &&
    !hasSpecsSignal(textLower);
  const specsSignal = !finishPreferenceOnlyRaw && hasSpecsSignal(textLower);
  const llmMediaIntent =
    semanticRoutingAccepted && semanticSlotParse?.mediaIntent ? semanticSlotParse.mediaIntent : "none";
  const photoRequested =
    llmMediaIntent === "photos" ||
    llmMediaIntent === "either" ||
    /\b(photo|picture|pic|image|images)\b/i.test(textLower);
  const availabilityRefinementSignal = (() => {
    if (turnPrimaryIntent === "pricing_payments" || turnPrimaryIntent === "callback") return false;
    const hasAvailabilityContext =
      !!conv.inventoryContext?.model ||
      !!conv.lead?.vehicle?.model ||
      !!conv.lead?.vehicle?.description;
    const mentionsModel = !!(llmAvailability?.model ?? findMentionedModel(textLower));
    const mentionsColor = !!extractColorToken(textLower);
    const mentionsFinish = !!extractFinishToken(textLower);
    const mentionsCondition = !!normalizeWatchCondition(textLower);
    const mentionsYear = !!extractYearSingle(textLower);
    const hasRefinementDetail =
      mentionsModel || mentionsColor || mentionsFinish || mentionsCondition || mentionsYear;
    if (!hasRefinementDetail) return false;
    if (specsSignal || pricingSignal) return false;
    const correctionCue = /\b(i meant|actually|sorry|correction|typo)\b/i.test(textLower);
    const contextCue = /\b(that one|the one|this one|that bike|this bike)\b/i.test(textLower);
    return correctionCue || contextCue || hasAvailabilityContext;
  })();
  const availabilityExplicit =
    (turnPrimaryIntent === "availability" || llmAvailabilityIntent || availabilityRefinementSignal) &&
    !/\b(sound system|audio system|stereo|speakers?|speaker system)\b/i.test(textLower) &&
    turnPrimaryIntent !== "pricing_payments" &&
    turnPrimaryIntent !== "callback" &&
    !specsSignal;
  if (
    event.provider === "twilio" &&
    availabilityExplicit &&
    !deterministicAvailabilityLookup &&
    !financePriorityOverride &&
    !schedulePriorityOverride &&
    !pricingSignal &&
    !pricingOrPaymentsIntent &&
    !/\b(compare|comparison|vs\.?|versus|specs?|spec sheet)\b/i.test(textLower)
  ) {
    logDecisionTrace("live.route_availability_explicit_fallback", {
      source: "availabilityExplicit",
      text: String(event.body ?? "").slice(0, 180)
    });
    const availabilityResolution = await resolveDeterministicAvailabilityReply({
      conv,
      text: event.body ?? "",
      parsedAvailability: llmAvailability,
      otherInventoryRequest
    });
    const reply =
      availabilityResolution.kind === "reply"
        ? availabilityResolution.reply
        : "Which model are you asking about?";
    const extraMediaUrls =
      availabilityResolution.kind === "reply" && Array.isArray(availabilityResolution.mediaUrls)
        ? availabilityResolution.mediaUrls
        : [];
    const systemMode = webhookMode;
    if (systemMode === "suggest") {
      appendOutbound(
        conv,
        event.to,
        event.from,
        reply,
        "draft_ai",
        undefined,
        extraMediaUrls.length ? extraMediaUrls : undefined
      );
      logRouteOutcome("availability_explicit_draft");
      const twiml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response></Response>`;
      return res.status(200).type("text/xml").send(twiml);
    }
    appendOutbound(
      conv,
      event.to,
      event.from,
      reply,
      "twilio",
      undefined,
      extraMediaUrls.length ? extraMediaUrls : undefined
    );
    logRouteOutcome("availability_explicit_send");
    const mediaTags = extraMediaUrls.length
      ? extraMediaUrls.map(u => `\n    <Media>${escapeXml(u)}</Media>`).join("")
      : "";
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n  <Message>${escapeXml(
      reply
    )}${mediaTags}\n  </Message>\n</Response>`;
    return res.status(200).type("text/xml").send(twiml);
  }
  const tradeYearCorrection =
    isTradeLead && !availabilityExplicit && turnPrimaryIntent !== "availability"
      ? extractTradeYearCorrection(
          textLower,
          conv.lead?.tradeVehicle?.year ?? conv.lead?.vehicle?.year ?? null
        )
      : null;
  const tradeFollowupMessage =
    isTradeLead &&
    !availabilityExplicit &&
    turnPrimaryIntent !== "availability" &&
    !isSteppingBackDispositionText(textLower) &&
    !pricingSignal &&
    (tradeYearCorrection ||
      llmExplicitScheduleIntent ||
      (bookingIntentAccepted &&
        (bookingParse?.intent === "schedule" || bookingParse?.intent === "reschedule")) ||
      /\b(inspection|appraisal|bring (it|the bike) (in|by)|coming in|come in|stop in|call for (an )?appointment|call (to )?(set|schedule) (an )?appointment|check my schedule|i(?:'|’)ll call|i will call|let you know when i(?:'|’)m coming in|let you know when i am coming in)\b/i.test(
        textLower
      ));
  if (event.provider === "twilio" && tradeFollowupMessage) {
    if (conv.lead) {
      conv.lead.vehicle = conv.lead.vehicle ?? {};
      conv.lead.tradeVehicle = {
        ...(conv.lead.tradeVehicle ?? {}),
        model: conv.lead.tradeVehicle?.model ?? conv.lead.vehicle?.model,
        description: conv.lead.tradeVehicle?.description ?? conv.lead.vehicle?.description
      };
      if (tradeYearCorrection) {
        conv.lead.vehicle.year = tradeYearCorrection;
        conv.lead.tradeVehicle.year = tradeYearCorrection;
      }
    }
    if (!isTradeDialogState(getDialogState(conv))) {
      setDialogState(conv, "trade_init");
    }
    const tradeModel =
      conv.lead?.tradeVehicle?.model ??
      conv.lead?.tradeVehicle?.description ??
      conv.lead?.vehicle?.model ??
      conv.lead?.vehicle?.description ??
      null;
    const tradeYear =
      tradeYearCorrection ?? conv.lead?.tradeVehicle?.year ?? conv.lead?.vehicle?.year ?? null;
    const tradeLabel = tradeModel
      ? formatModelLabel(tradeYear, tradeModel)
      : tradeYear
        ? `${tradeYear} bike`
        : "your bike";
    const correctionLine = tradeYearCorrection
      ? `Thanks for clarifying — I updated it to ${tradeLabel}. `
      : "";
    const reply = `${correctionLine}Sounds good. When you’re ready, call us or text us a day and time, and we can line up the appraisal.`;
    const systemMode = webhookMode;
    if (systemMode === "suggest") {
      appendOutbound(conv, event.to, event.from, reply, "draft_ai");
      const twiml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response></Response>`;
      return res.status(200).type("text/xml").send(twiml);
    }
    appendOutbound(conv, event.to, event.from, reply, "twilio");
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n  <Message>${escapeXml(
      reply
    )}</Message>\n</Response>`;
    return res.status(200).type("text/xml").send(twiml);
  }
  const compareRequest = isCompareRequest(textLower);
  const llmInventoryInfoIntent =
    dialogActAccepted &&
    (dialogActParse?.topic === "new_inventory" || dialogActParse?.topic === "used_inventory");
  const llmCompareHint =
    llmInventoryInfoIntent && /\b(compare|comparison|vs\.?|versus)\b/i.test(String(event.body ?? ""));
  const compareContext = /compare|spec sheet|highlights comparison|highlights list/i.test(
    lastOutboundText
  );
  const explicitNoCompare = /\b(don't|do not|not)\s+(want|need)?\s*to?\s*compare\b|no compare|not comparing/i.test(
    textLower
  );
  const mentionedModelsEarly = findMentionedModels(textLower);
  const hasModelContext =
    getHarleyModelLexicon().some(m => textLower.includes(m.toLowerCase())) ||
    !!conv.inventoryContext?.model ||
    !!conv.lead?.vehicle?.model ||
    !!conv.lead?.vehicle?.description;
  const lastOutboundInfoPrompt = /quick highlights list for|spec sheet or a quick highlights list for/i.test(
    lastOutboundText
  );
  let isCompare = llmCompareHint || compareRequest || compareContext;
  if (explicitNoCompare) {
    isCompare = false;
    conv.compareContext = undefined;
  }
  if (lastOutboundInfoPrompt && !compareRequest) {
    isCompare = false;
  }
  if (isCompare && !compareRequest) {
    const wantsSingleModelInfo =
      mentionedModelsEarly.length === 1 &&
      /\b(tell me about|details|info|specs?|spec sheet|highlights?|quick spec|quick highlights?)\b/i.test(
        textLower
      ) &&
      !/\b(compare|comparison|vs\.?|versus)\b/i.test(textLower);
    if (wantsSingleModelInfo) {
      isCompare = false;
      conv.compareContext = undefined;
    }
  }
  const skipInfoOnly =
    finishPreferenceOnlyRaw &&
    (!!conv.inventoryContext?.model ||
      !!conv.lead?.vehicle?.model ||
      !!conv.lead?.vehicle?.description);
  const infoOnlyRequest =
    (llmInventoryInfoIntent || isInfoOnlyRequest(textLower) || specsSignal || isCompare) && !skipInfoOnly;
  if (event.provider === "twilio" && finishPreferenceOnlyRaw && !hasModelContext) {
    const reply = "Got it — which model and year are you looking for?";
    const systemMode = webhookMode;
    if (systemMode === "suggest") {
      appendOutbound(conv, event.to, event.from, reply, "draft_ai");
      const twiml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response></Response>`;
      return res.status(200).type("text/xml").send(twiml);
    }
    appendOutbound(conv, event.to, event.from, reply, "twilio");
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n  <Message>${escapeXml(
      reply
    )}</Message>\n</Response>`;
    return res.status(200).type("text/xml").send(twiml);
  }
  if (event.provider === "twilio" && infoOnlyRequest && !availabilityExplicit) {
    if (isCompare) {
      const wantsEverythingCompare = /\b(all (the )?details|everything|all (the )?info|all specs?|full details|everything on the page)\b/i.test(
        textLower
      );
      const formatChoice = wantsEverythingCompare
        ? "highlights"
        : /\b(highlights?|highlight comparison|quick highlights?|quick highlight|quick spec|quick comparison)\b/i.test(
            textLower
          )
          ? "highlights"
          : /\b(full specs?|full spec|spec sheet|specs?)\b/i.test(textLower)
            ? "full"
            : null;
      const storedFormat = conv.compareContext?.format ?? null;
      const isCompareFormatChoice = !!formatChoice;
      if (isCompareFormatChoice || storedFormat) {
        let contextModels =
          conv.compareContext?.models?.length && Array.isArray(conv.compareContext.models)
            ? conv.compareContext.models
            : findMentionedModels(lastOutboundText);
        if (contextModels.length < 2) {
          const historyText = getRecentMessagesText(conv, 12);
          const historyModels = findMentionedModels(historyText);
          if (historyModels.length >= 2) {
            contextModels = [historyModels[0], historyModels[1]];
          } else {
            try {
              const inferred = await inferModelsFromText(historyText);
              if (inferred.length >= 2) {
                contextModels = [inferred[0], inferred[1]];
              }
            } catch {}
          }
        }
        const contextYear =
          conv.compareContext?.year ??
          extractYearSingle(lastOutboundText) ??
          extractYearSingle(textLower);
        if (contextModels.length >= 2) {
          const format = formatChoice ?? storedFormat ?? null;
          conv.compareContext = {
            models: contextModels.slice(0, 2),
            year: contextYear ?? null,
            format,
            updatedAt: nowIso()
          };
          const primaryLabel = formatModelLabel(
            contextYear ? String(contextYear) : null,
            contextModels[0]
          );
          const secondaryLabel = formatModelLabel(
            contextYear ? String(contextYear) : null,
            contextModels[1]
          );
          setDialogState(conv, "compare_answered");
          const wantsHighlights = format === "highlights";
          const primarySpecs = await getModelSpecs({
            model: contextModels[0],
            year: contextYear ? String(contextYear) : null
          });
          const secondarySpecs = await getModelSpecs({
            model: contextModels[1],
            year: contextYear ? String(contextYear) : null
          });
          const lines: string[] = [];
          const maxItems = wantsHighlights ? 4 : 8;
          if (primarySpecs?.specs && Object.keys(primarySpecs.specs).length) {
            if (wantsHighlights) {
              const glance = buildGlanceSummary(primaryLabel, primarySpecs.glance);
              lines.push(glance ?? buildSpecsSummary(primaryLabel, primarySpecs.specs, maxItems));
            } else {
              lines.push(buildSpecsSummary(primaryLabel, primarySpecs.specs, maxItems));
            }
          }
          if (secondarySpecs?.specs && Object.keys(secondarySpecs.specs).length) {
            if (wantsHighlights) {
              const glance = buildGlanceSummary(secondaryLabel, secondarySpecs.glance);
              lines.push(glance ?? buildSpecsSummary(secondaryLabel, secondarySpecs.specs, maxItems));
            } else {
              lines.push(buildSpecsSummary(secondaryLabel, secondarySpecs.specs, maxItems));
            }
          }
          let reply = "";
          if (lines.length >= 2) {
            reply = lines.join("\n");
          } else if (lines.length === 1) {
            reply = `${lines[0]} I’m pulling the rest of the spec sheet and will text it over shortly.`;
          } else {
            reply = wantsHighlights
              ? `Got it — I’ll pull a quick highlights comparison for ${primaryLabel} and the ${secondaryLabel} and text it over shortly.`
              : `Got it — I’ll pull the full spec sheets for ${primaryLabel} and the ${secondaryLabel} and text them over shortly.`;
          }
          if (wantsEverythingCompare) {
            reply += " Want full spec sheets or safety/features next?";
          }
          const systemMode = webhookMode;
          if (systemMode === "suggest") {
            appendOutbound(conv, event.to, event.from, reply, "draft_ai");
            const twiml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response></Response>`;
            return res.status(200).type("text/xml").send(twiml);
          }
          appendOutbound(conv, event.to, event.from, reply, "twilio");
          const twiml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n  <Message>${escapeXml(
            reply
          )}</Message>\n</Response>`;
          return res.status(200).type("text/xml").send(twiml);
        }
        if (isCompareFormatChoice) {
          conv.compareContext = {
            models: conv.compareContext?.models,
            year: conv.compareContext?.year ?? null,
            format: formatChoice,
            updatedAt: nowIso()
          };
          setDialogState(conv, "compare_request");
          const reply =
            formatChoice === "highlights"
              ? "Got it — I can do a quick highlights comparison. Which two models should I compare?"
              : "Got it — I can send the full spec sheets. Which two models should I compare?";
          const systemMode = webhookMode;
          if (systemMode === "suggest") {
            appendOutbound(conv, event.to, event.from, reply, "draft_ai");
            const twiml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response></Response>`;
            return res.status(200).type("text/xml").send(twiml);
          }
          appendOutbound(conv, event.to, event.from, reply, "twilio");
          const twiml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n  <Message>${escapeXml(
            reply
          )}</Message>\n</Response>`;
          return res.status(200).type("text/xml").send(twiml);
        }
      }
      setDialogState(conv, isCompareFormatChoice ? "compare_answered" : "compare_request");
    }
    const yearFromText = extractYearSingle(textLower);
    const mentionedModels = mentionedModelsEarly;
    const singleMention = !isCompare && mentionedModels.length === 1 ? mentionedModels[0] : null;
    const baseModelRaw =
      singleMention ??
      conv.inventoryContext?.model ??
      conv.lead?.vehicle?.model ??
      conv.lead?.vehicle?.description ??
      null;
    const baseYearRaw =
      (singleMention ? yearFromText : null) ?? conv.inventoryContext?.year ?? conv.lead?.vehicle?.year ?? null;
    if (singleMention) {
      conv.inventoryContext = {
        model: singleMention,
        year: baseYearRaw ? String(baseYearRaw) : undefined,
        updatedAt: nowIso()
      };
    }
    if (isCompare && mentionedModels.length >= 2) {
      conv.compareContext = {
        models: mentionedModels.slice(0, 2),
        year: yearFromText ?? null,
        updatedAt: nowIso()
      };
      setDialogState(conv, "compare_request");
      const primaryLabel = formatModelLabel(
        yearFromText ? String(yearFromText) : null,
        mentionedModels[0]
      );
      const secondaryLabel = formatModelLabel(
        yearFromText ? String(yearFromText) : null,
        mentionedModels[1]
      );
      const reply = `Got it — I can compare the ${primaryLabel} and the ${secondaryLabel}. Do you want the full spec sheets or a quick highlights comparison?`;
      const systemMode = webhookMode;
      if (systemMode === "suggest") {
        appendOutbound(conv, event.to, event.from, reply, "draft_ai");
        const twiml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response></Response>`;
        return res.status(200).type("text/xml").send(twiml);
      }
      appendOutbound(conv, event.to, event.from, reply, "twilio");
      const twiml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n  <Message>${escapeXml(
        reply
      )}</Message>\n</Response>`;
      return res.status(200).type("text/xml").send(twiml);
    }
    let baseModelForLabel = baseModelRaw;
    let baseYearForLabel = baseYearRaw;
    let hasBaseModel = !!baseModelForLabel && !/full line|other/i.test(String(baseModelForLabel));
    if (!hasBaseModel && mentionedModels.length) {
      baseModelForLabel = mentionedModels[0] ?? baseModelForLabel;
      hasBaseModel = !!baseModelForLabel && !/full line|other/i.test(String(baseModelForLabel));
    }
    const baseLabel = hasBaseModel
      ? formatModelLabel(baseYearForLabel ? String(baseYearForLabel) : null, baseModelForLabel)
      : "the bike";
    const baseLabelWithThe = baseLabel === "the bike" ? baseLabel : `the ${baseLabel}`;
    const specsFocus = extractSpecsFocus(textLower);
    const specsFormatChoice = /\b(highlights?|highlight comparison|quick highlights?|quick highlight|quick spec)\b/i.test(
      textLower
    )
      ? "highlights"
      : /\b(full specs?|full spec|spec sheet|specs?)\b/i.test(textLower)
        ? "full"
        : null;
    const wantsEverything = /\b(all (the )?details|everything|all (the )?info|all specs?|full details|everything on the page)\b/i.test(
      textLower
    );
    const finishPreferenceOnly =
      finishPreferenceOnlyRaw &&
      specsFocus === "accessories" &&
      !specsFormatChoice &&
      !wantsEverything &&
      !/\b(specs?|spec sheet|highlights?|details|info|information)\b/i.test(textLower);
    if (!isCompare && hasBaseModel) {
      if (!finishPreferenceOnly) {
        conv.specsContext = {
          model: baseModelForLabel ? String(baseModelForLabel) : undefined,
          year: baseYearForLabel ? String(baseYearForLabel) : null,
          format: specsFormatChoice ?? conv.specsContext?.format ?? null,
          updatedAt: nowIso()
        };
      }
      const wantsSpecsNow =
        !finishPreferenceOnly &&
        (wantsEverything ||
          !!specsFormatChoice ||
          !!specsFocus ||
          hasSpecsSignal(textLower));
      if (wantsSpecsNow) {
        setDialogState(conv, "specs_single_answered");
        const wantsHighlights =
          wantsEverything || (specsFormatChoice ?? conv.specsContext?.format) === "highlights";
        const specs = await getModelSpecs({
          model: String(baseModelForLabel),
          year: baseYearForLabel ? String(baseYearForLabel) : null
        });
        let reply = "";
        if (specs?.specs && Object.keys(specs.specs).length) {
          const maxItems = wantsHighlights ? 6 : 10;
          const wantsInfotainment = hasInfotainmentSignal(textLower);
          const infotainmentSummary =
            specsFocus === "features" && wantsInfotainment
              ? buildInfotainmentSummary(baseLabel, specs.specs)
              : null;
          const summary =
            infotainmentSummary ??
            (wantsHighlights && !specsFocus
              ? buildGlanceSummary(baseLabel, specs.glance) ??
                buildFocusedSpecsSummary(baseLabel, specs.specs, specsFocus, maxItems)
              : buildFocusedSpecsSummary(baseLabel, specs.specs, specsFocus, maxItems));
          reply = wantsEverything
            ? `${summary} If you want more, I can send full specs, key features, or safety next — which should I send?`
            : summary;
        } else {
          reply = wantsEverything
            ? `Got it — I’ll start with quick highlights for ${baseLabelWithThe}. Do you want full specs, key features, or safety next?`
            : wantsHighlights
              ? `Got it — I’ll pull a quick highlights list for ${baseLabelWithThe} and text it over shortly.`
              : `Got it — I’ll pull the full spec sheet for ${baseLabelWithThe} and text it over shortly.`;
        }
        const systemMode = webhookMode;
        if (systemMode === "suggest") {
          appendOutbound(conv, event.to, event.from, reply, "draft_ai");
          const twiml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response></Response>`;
          return res.status(200).type("text/xml").send(twiml);
        }
        appendOutbound(conv, event.to, event.from, reply, "twilio");
        const twiml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n  <Message>${escapeXml(
          reply
        )}</Message>\n</Response>`;
        return res.status(200).type("text/xml").send(twiml);
      }
    }
    const compareModelRaw = compareRequest ? findMentionedModel(textLower) : null;
    let compareLabel = compareModelRaw ? normalizeDisplayCase(compareModelRaw) : null;
    if (!compareLabel && compareContext && mentionedModels.length) {
      const baseNormalized = baseModelForLabel ? normalizeModelText(baseModelForLabel) : null;
      const alternate = mentionedModels.find(
        model => !baseNormalized || normalizeModelText(model) !== baseNormalized
      );
      if (alternate) compareLabel = normalizeDisplayCase(alternate);
      if (!baseModelForLabel && mentionedModels.length >= 2) {
        baseModelForLabel = mentionedModels[0] ?? baseModelForLabel;
        baseYearForLabel = baseYearForLabel ?? baseYearRaw;
        hasBaseModel =
          !!baseModelForLabel && !/full line|other/i.test(String(baseModelForLabel));
      }
    }
    if (compareLabel && baseModelForLabel) {
      if (normalizeModelText(compareLabel) === normalizeModelText(baseModelForLabel)) {
        compareLabel = null;
      }
    }
    let reply = "";
    if (isCompare) {
      reply = compareLabel
        ? `Got it — I can send the full spec sheet for ${baseLabelWithThe} and compare it to the ${compareLabel}. Do you want the full spec sheets or a quick highlights comparison?`
        : "Got it — happy to compare. Which model/year do you want to compare it to? I can send the full spec sheets or a quick highlights comparison.";
    } else {
      if (!hasBaseModel) {
        reply = "Which model are you interested in?";
      } else {
        setDialogState(conv, "specs_single_request");
        reply = `Got it — want the full spec sheet or a quick highlights list for ${baseLabelWithThe}? If you want specific areas (engine, features, accessories), tell me what to focus on.`;
      }
    }
    const systemMode = webhookMode;
    if (systemMode === "suggest") {
      appendOutbound(conv, event.to, event.from, reply, "draft_ai");
      const twiml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response></Response>`;
      return res.status(200).type("text/xml").send(twiml);
    }
    appendOutbound(conv, event.to, event.from, reply, "twilio");
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n  <Message>${escapeXml(
      reply
    )}</Message>\n</Response>`;
    return res.status(200).type("text/xml").send(twiml);
  }

  const inventoryQuestion =
    !pricingOrPaymentsIntent &&
    !/\b(payment|payments|monthly|per month|apr|term|down payment|otd|out the door|finance|financing|credit)\b/i.test(
      textLower
    ) &&
    (llmAvailabilityIntent ||
      (!isTradeLead &&
        (!!llmAvailability?.color || !!inventoryEntityColorHint) &&
        (!!conv.inventoryContext?.model || !!conv.lead?.vehicle?.model)) ||
      (!isTradeLead &&
        (getHarleyModelLexicon().some(m => textLower.includes(m.toLowerCase())) ||
          (!!conv.inventoryContext?.model && textLower.includes(conv.inventoryContext.model.toLowerCase())) ||
          (!!conv.inventoryContext?.model &&
            /\b(\d{4}|blue|black|white|red|green|gray|grey|silver|chrome|trim|finish|color|standard|special|st|new|used|pre[-\s]?owned|preowned)\b/i.test(
              textLower
            )) ||
          (!!conv.lead?.vehicle?.model && textLower.includes(conv.lead.vehicle.model.toLowerCase())) ||
          (!!conv.lead?.vehicle?.model &&
            /\b(\d{4}|blue|black|white|red|green|gray|grey|silver|chrome|trim|color|standard|special|st|new|used|pre[-\s]?owned|preowned)\b/i.test(
              textLower
            )))));
  const watchPrompted = /\b(keep an eye|keep me posted|watch for|watch\b)\b/i.test(
    lastOutboundText
  );
  const watchIntentText = isWatchConfirmationIntentText(String(event.body ?? ""));
  const promptedWatchAffirm =
    watchPrompted &&
    isAffirmative(event.body) &&
    !schedulingSignals.hasDayTime &&
    !schedulingSignals.hasDayOnlyAvailability &&
    !schedulingSignals.hasDayOnlyRequest &&
    !schedulingExplicit;
  const explicitWatchIntent =
    watchIntentText ||
    promptedWatchAffirm ||
    semanticWatchAction === "set_watch";
  const passiveWatchIntent =
    !!inventoryEntityModelHint &&
    !hasPrimaryIntentBeyondWatch(String(event.body ?? "")) &&
    !llmAvailabilityIntent &&
    !availabilityExplicit &&
    !inventoryCountQuestion;
  const watchIntent =
    event.provider === "twilio" &&
    !conv.inventoryWatchPending &&
    !watchHandledEarly &&
    !suppressWatchIntentThisTurn &&
    (explicitWatchIntent || passiveWatchIntent);
  const watchAsSideEffectOnly = watchIntent && hasPrimaryIntentBeyondWatch(String(event.body ?? ""));
  if (watchIntent) {
    if (getDialogState(conv) === "inventory_watch_active" && conv.inventoryWatch) {
      const watch = conv.inventoryWatch;
      const inboundModel = await resolveWatchModelFromText(
        textLower,
        conv.lead?.vehicle?.model ?? conv.lead?.vehicle?.description ?? null
      );
      const watchModel = watch.model ?? null;
      const modelDifferent =
        !!inboundModel &&
        !!watchModel &&
        normalizeModelText(inboundModel) !== normalizeModelText(watchModel);
      const availabilityAskedHere = availabilityExplicit || inventoryCountQuestion;
      if (modelDifferent || availabilityAskedHere) {
        // Customer is asking about a different model or availability; handle below.
      } else {
        if (!watchAsSideEffectOnly) {
          const watchCondition =
            normalizeWatchCondition(watch.condition) ??
            inferWatchCondition(watch.model, watch.year, conv);
          const finishEligible = await shouldAskFinishPreference(
            watch.model,
            watch.year,
            watchCondition
          );
          const updateHint = buildWatchUpdateHint(watchCondition, finishEligible);
          const yearText = watch.year
            ? `${watch.year} `
            : watch.yearMin && watch.yearMax
              ? `${watch.yearMin}-${watch.yearMax} `
              : "";
          const modelText = watch.model ?? "that model";
          const watchColor = sanitizeColorPhrase(watch.color) ?? watch.color;
          const colorText = watchColor ? ` in ${watchColor}` : "";
          const reply = `I’ve already got a watch set for ${yearText}${modelText}${colorText}. If you want me to update it, just tell me the ${updateHint}.`;
          const systemMode = webhookMode;
          if (systemMode === "suggest") {
            appendOutbound(conv, event.to, event.from, reply, "draft_ai");
            const twiml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response></Response>`;
            return res.status(200).type("text/xml").send(twiml);
          }
          appendOutbound(conv, event.to, event.from, reply, "twilio");
          const twiml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n  <Message>${escapeXml(
            reply
          )}</Message>\n</Response>`;
          return res.status(200).type("text/xml").send(twiml);
        }
      }
    }

    const nowIso = new Date().toISOString();
    const leadVehicle = conv.lead?.vehicle ?? {};
    const leadYearNum = Number(leadVehicle.year ?? "");
    const leadYear = Number.isFinite(leadYearNum) ? leadYearNum : undefined;
    const semanticWatchYearNum = Number(semanticWatch?.year ?? NaN);
    const semanticWatchYear = Number.isFinite(semanticWatchYearNum) ? semanticWatchYearNum : undefined;
    const semanticWatchColor = sanitizeColorPhrase(semanticWatch?.color ?? undefined);
    const resolvedModel = await resolveWatchModelFromText(
      textLower,
      semanticWatch?.model ??
        inventoryEntityModelHint ??
        leadVehicle.model ??
        leadVehicle.description ??
        null
    );
    if (!resolvedModel) {
      if (!watchAsSideEffectOnly) {
        const reply = "Got it — which model should I watch for?";
        const budgetSeed = applyEntityBudgetSeed(
          resolveWatchBudgetPreferenceForConversation(conv, String(event.body ?? ""))
        );
        conv.inventoryWatchPending = {
          minPrice: budgetSeed.minPrice,
          maxPrice: budgetSeed.maxPrice,
          monthlyBudget: budgetSeed.monthlyBudget,
          termMonths: budgetSeed.termMonths,
          downPayment: budgetSeed.downPayment,
          askedAt: nowIso
        };
        setDialogState(conv, "inventory_watch_prompted");
        const systemMode = webhookMode;
        if (systemMode === "suggest") {
          appendOutbound(conv, event.to, event.from, reply, "draft_ai");
          const twiml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response></Response>`;
          return res.status(200).type("text/xml").send(twiml);
        }
        appendOutbound(conv, event.to, event.from, reply, "twilio");
        const twiml = `<?xml version="1.0\" encoding=\"UTF-8\"?>\n<Response>\n  <Message>${escapeXml(
          reply
        )}</Message>\n</Response>`;
        return res.status(200).type("text/xml").send(twiml);
      }
    }

    if (resolvedModel) {
      const budgetSeed = applyEntityBudgetSeed(
        resolveWatchBudgetPreferenceForConversation(conv, String(event.body ?? ""))
      );
      const pending: InventoryWatchPending = {
        model: resolvedModel,
        year: inventoryEntityYearHint ?? extractYearSingle(textLower) ?? semanticWatchYear ?? leadYear,
        color: combineWatchColorAndFinish(
          inventoryEntityColorHint ??
            extractColorToken(textLower) ??
            semanticWatchColor ??
            leadVehicle.color ??
            undefined,
          extractFinishToken(textLower)
        ),
        minPrice: budgetSeed.minPrice,
        maxPrice: budgetSeed.maxPrice,
        monthlyBudget: budgetSeed.monthlyBudget,
        termMonths: budgetSeed.termMonths,
        downPayment: budgetSeed.downPayment,
        askedAt: nowIso
      };
      let pref = parseInventoryWatchPreference(String(event.body ?? ""), pending);
      if (
        pref.action === "ignore" &&
        pending.model &&
        (isAffirmative(event.body) || watchIntentText || !!inventoryEntityModelHint)
      ) {
        const watchColor = sanitizeColorPhrase(pending.color);
        const watch: InventoryWatch = {
          model: pending.model,
          year: pending.year,
          color: watchColor,
          minPrice: pending.minPrice,
          maxPrice: pending.maxPrice,
          monthlyBudget: pending.monthlyBudget,
          termMonths: pending.termMonths,
          downPayment: pending.downPayment,
          exactness: "model_only",
          status: "active",
          createdAt: new Date().toISOString()
        };
        if (watch.year && watch.color) watch.exactness = "exact";
        else if (watch.year) watch.exactness = "year_model";
        pref = { action: "set", watch };
      }
      if (pref.action === "set" && pref.watch) {
        if (!pref.watch.make && leadVehicle.make) pref.watch.make = leadVehicle.make;
        if (!pref.watch.trim && leadVehicle.trim) pref.watch.trim = leadVehicle.trim;
        const conditionFromText = normalizeWatchCondition(textLower);
        if (!pref.watch.condition && conditionFromText) pref.watch.condition = conditionFromText;
        if (
          !pref.watch.condition &&
          semanticWatch?.condition &&
          semanticWatch.condition !== "unknown" &&
          semanticWatch.condition !== "any"
        ) {
          pref.watch.condition = semanticWatch.condition;
        }
        if (!pref.watch.condition && leadVehicle.condition) {
          pref.watch.condition = normalizeWatchCondition(leadVehicle.condition);
        }
        conv.inventoryWatch = pref.watch;
        conv.inventoryWatches = [pref.watch];
        conv.inventoryWatchPending = undefined;
        setDialogState(conv, "inventory_watch_active");
        setFollowUpMode(conv, "holding_inventory", "inventory_watch");
        stopFollowUpCadence(conv, "inventory_watch");
        const reply = buildInventoryWatchConfirmation(pref.watch);
        if (!watchAsSideEffectOnly) {
          const systemMode = webhookMode;
          if (systemMode === "suggest") {
            appendOutbound(conv, event.to, event.from, reply, "draft_ai");
            const twiml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response></Response>`;
            return res.status(200).type("text/xml").send(twiml);
          }
          appendOutbound(conv, event.to, event.from, reply, "twilio");
          const twiml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n  <Message>${escapeXml(
            reply
          )}</Message>\n</Response>`;
          return res.status(200).type("text/xml").send(twiml);
        }
      }

      const watchWasSet = pref.action === "set" && !!pref.watch;
      if (!watchWasSet) {
        conv.inventoryWatchPending = pending;
        setDialogState(conv, "inventory_watch_prompted");
        const pendingCondition = inferWatchCondition(pending.model, pending.year, conv);
        const finishEligible = await shouldAskFinishPreference(
          pending.model,
          pending.year,
          pendingCondition
        );
        const reply = buildWatchPreferencePrompt(pendingCondition, finishEligible);
        if (!watchAsSideEffectOnly) {
          const systemMode = webhookMode;
          if (systemMode === "suggest") {
            appendOutbound(conv, event.to, event.from, reply, "draft_ai");
            const twiml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response></Response>`;
            return res.status(200).type("text/xml").send(twiml);
          }
          appendOutbound(conv, event.to, event.from, reply, "twilio");
          const twiml = `<?xml version="1.0\" encoding=\"UTF-8\"?>\n<Response>\n  <Message>${escapeXml(
            reply
          )}</Message>\n</Response>`;
          return res.status(200).type("text/xml").send(twiml);
        }
      }
    }
  }
  if (event.provider === "twilio" && schedulingBlocked && shortAck) {
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response></Response>`;
    return res.status(200).type("text/xml").send(twiml);
  }
  if (
    event.provider === "twilio" &&
    !lastOutboundAskedQuestion &&
    !conv.inventoryWatchPending &&
    !conv.scheduler?.pendingSlot &&
    !conv.appointment?.reschedulePending &&
    isAckOnlyCloseTurn(event.body, lastOutboundText)
  ) {
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response></Response>`;
    return res.status(200).type("text/xml").send(twiml);
  }
  if (
    event.provider === "twilio" &&
    shortAck &&
    !lastOutboundAskedQuestion &&
    !conv.inventoryWatchPending &&
    !conv.scheduler?.pendingSlot &&
    !conv.appointment?.reschedulePending
  ) {
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response></Response>`;
    return res.status(200).type("text/xml").send(twiml);
  }

  if (
    event.provider === "twilio" &&
    /(?:\bwho('?s| is)\s+this\b|^who dis\??$)/i.test(textLower)
  ) {
    const dealerProfile = await getDealerProfileHot();
    const dealerName = dealerProfile?.dealerName ?? "American Harley-Davidson";
    const agentName = dealerProfile?.agentName ?? "Alexandra";
    const bikeLabel = formatModelLabelForFollowUp(
      conv.lead?.vehicle?.year ?? null,
      conv.lead?.vehicle?.model ?? null
    );
    const context = bikeLabel ? ` You asked about the ${bikeLabel}.` : "";
    const firstName = conv.lead?.firstName?.trim();
    const greeting = firstName ? `Hi ${firstName} — ` : "";
    const reply = `${greeting}This is ${agentName} at ${dealerName}.${context} Want a quick walkaround video or to stop in?`;
    const systemMode = webhookMode;
    if (systemMode === "suggest") {
      appendOutbound(conv, event.to, event.from, reply, "draft_ai");
      const twiml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response></Response>`;
      return res.status(200).type("text/xml").send(twiml);
    }
    appendOutbound(conv, event.to, event.from, reply, "twilio");
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n  <Message>${escapeXml(
      reply
    )}</Message>\n</Response>`;
    return res.status(200).type("text/xml").send(twiml);
  }

  if (
    event.provider === "twilio" &&
    inventoryQuestion &&
    !schedulingSignals.hasDayTime &&
    !schedulingSignals.hasDayOnlyAvailability &&
    !schedulingSignals.hasDayOnlyRequest
  ) {
    logDecisionTrace("live.route_inventory_question", {
      source: "inventoryQuestion",
      text: String(event.body ?? "").slice(0, 180)
    });
    const inventoryStageStartedAt = Date.now();
    if (getDialogState(conv) === "inventory_watch_active" && conv.inventoryWatch) {
      const watch = conv.inventoryWatch;
      const watchCondition =
        normalizeWatchCondition(watch.condition) ??
        inferWatchCondition(watch.model, watch.year, conv);
      const finishEligible = await shouldAskFinishPreference(
        watch.model,
        watch.year,
        watchCondition
      );
      const updateHint = buildWatchUpdateHint(watchCondition, finishEligible);
      const yearText = watch.year
        ? `${watch.year} `
        : watch.yearMin && watch.yearMax
          ? `${watch.yearMin}-${watch.yearMax} `
          : "";
      const modelText = watch.model ?? "that model";
      const watchColor = sanitizeColorPhrase(watch.color) ?? watch.color;
      const colorText = watchColor ? ` in ${watchColor}` : "";
      const reply = `I’ve already got a watch set for ${yearText}${modelText}${colorText}. If you want me to update it, just tell me the ${updateHint}.`;
      const systemMode = webhookMode;
      if (systemMode === "suggest") {
        appendOutbound(conv, event.to, event.from, reply, "draft_ai");
        const twiml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response></Response>`;
        return res.status(200).type("text/xml").send(twiml);
      }
      appendOutbound(conv, event.to, event.from, reply, "twilio");
      const twiml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n  <Message>${escapeXml(
        reply
      )}</Message>\n</Response>`;
      return res.status(200).type("text/xml").send(twiml);
    }
    try {
      const yearMatch = textLower.match(/\b(20\d{2}|19\d{2})\b/);
      const yearFromText = yearMatch?.[1] ?? llmAvailability?.year ?? null;
      const priorModel =
        conv.inventoryContext?.model ??
        conv.lead?.vehicle?.model ??
        conv.lead?.vehicle?.description ??
        null;
      const inventoryFeedStartedAt = Date.now();
      const items = await getInventoryFeedHot();
      logRouteTiming("inventory.feed", inventoryFeedStartedAt, { itemCount: items.length });
      const models = Array.from(new Set(items.map(i => i.model).filter(Boolean))) as string[];
      models.sort((a, b) => b.length - a.length);
      const modelFromText =
        models.find(m => textLower.includes(m.toLowerCase())) ??
        findMentionedModel(textLower) ??
        null;
      const paymentBudgetContext = resolvePaymentBudgetForConversation(conv, event.body);
      const monthlyBudget = paymentBudgetContext.monthlyBudget ?? null;
      const hasMonthlyBudgetTarget = monthlyBudget != null;
      const paymentTermMonths = paymentBudgetContext.termMonths ?? (hasMonthlyBudgetTarget ? 84 : 72);
      const downPayment = hasMonthlyBudgetTarget ? (paymentBudgetContext.downPayment ?? 0) : 0;
      let paymentTaxRate = 0.08;
      if (hasMonthlyBudgetTarget) {
        try {
          const dealerProfile = await getDealerProfileHot();
          paymentTaxRate = normalizeTaxRate((dealerProfile as any)?.taxRate);
        } catch {
          paymentTaxRate = 0.08;
        }
      }
      const touringRequested = hasMonthlyBudgetTarget && isTouringRequestText(event.body);
      const modelExplicitInInbound = !!(llmAvailability?.model || modelFromText);
      const explicitModelFromInbound = llmAvailability?.model ?? modelFromText ?? null;
      const model =
        explicitModelFromInbound ??
        conv.inventoryContext?.model ??
        conv.lead?.vehicle?.model ??
        conv.lead?.vehicle?.description ??
        null;
      const modelForLookup = model ? canonicalizeWatchModelLabel(model) : null;
      const modelChanged =
        explicitModelFromInbound &&
        priorModel &&
        normalizeModelText(explicitModelFromInbound) !== normalizeModelText(priorModel);
      const colorFromParser = sanitizeColorPhrase(extractColorToken(textLower));
      const colorFromLlm = sanitizeColorPhrase(llmAvailability?.color ?? null);
      const colorFromText = pickMostSpecificColor(colorFromLlm, colorFromParser);
      const finishFromText = extractFinishToken(textLower);
      const llmConditionRaw =
        llmAvailability?.condition && llmAvailability.condition !== "unknown"
          ? llmAvailability.condition
          : null;
      const conditionFromText = normalizeWatchCondition(textLower);
      const conditionFromLlm = normalizeWatchCondition(llmConditionRaw);
      const conditionFromLlmTrusted = conditionFromText ? conditionFromLlm : undefined;
      const explicitCondition = conditionFromLlmTrusted ?? conditionFromText;
      const priorCondition = !modelChanged
        ? normalizeWatchCondition(conv.inventoryContext?.condition ?? conv.lead?.vehicle?.condition ?? null)
        : undefined;
      const conditionSearchRequest = /\b(looking for|want|need|after|open to)\b[^.?!]*\b(new|used|pre[-\s]?owned|preowned)\b/i.test(
        textLower
      );
      const resetContextForCondition =
        !modelChanged &&
        !!explicitCondition &&
        ((!!priorCondition && explicitCondition !== priorCondition) || conditionSearchRequest);
      const priorYear =
        !modelChanged && !resetContextForCondition
          ? conv.inventoryContext?.year ?? conv.lead?.vehicle?.year ?? null
          : null;
      const year =
        yearFromText ??
        (!modelChanged && !resetContextForCondition
          ? conv.inventoryContext?.year ?? conv.lead?.vehicle?.year ?? null
          : null);
      const colorCandidate =
        colorFromText ??
        (!modelChanged && !resetContextForCondition
          ? conv.inventoryContext?.color ?? conv.lead?.vehicle?.color ?? null
          : null);
      const color = sanitizeColorPhrase(colorCandidate) ?? null;
      const finish = extractTrimToken(
        finishFromText ??
          (!modelChanged && !resetContextForCondition ? conv.inventoryContext?.finish ?? null : null)
      );
      const conditionFromContext =
        !modelChanged && !resetContextForCondition
          ? normalizeWatchCondition(conv.inventoryContext?.condition ?? conv.lead?.vehicle?.condition ?? null)
          : undefined;
      const yearChangedFromContext =
        !!yearFromText &&
        !!priorYear &&
        String(yearFromText).trim() !== String(priorYear).trim();
      const keepContextCondition = !yearChangedFromContext || !!conditionFromText || !!conditionFromLlmTrusted;
      const condition =
        conditionFromLlmTrusted ??
        conditionFromText ??
        (keepContextCondition ? conditionFromContext : undefined);
      const downPaymentQuestion = isDownPaymentQuestion(event.body ?? "");
      const broadInventoryBudgetAsk =
        /\b(what do you have|what.*in stock|show me|options?|inventory|other|another|different)\b/i.test(
          textLower
        );
      const hasSpecificUnitBudgetAnchor =
        referencesSpecificInventoryUnit(event.body ?? "") ||
        !!colorFromText ||
        (!modelChanged && !!conv.inventoryContext?.color) ||
        !!conv.lead?.vehicle?.stockId ||
        !!conv.lead?.vehicle?.vin;
      const broadBudgetScopeRequest =
        otherInventoryRequest ||
        inventoryCountQuestion ||
        broadInventoryBudgetAsk;
      const specificUnitBudgetQuestion =
        hasMonthlyBudgetTarget &&
        downPaymentQuestion &&
        !broadBudgetScopeRequest &&
        hasSpecificUnitBudgetAnchor;
      const ambiguousBudgetScopeQuestion =
        hasMonthlyBudgetTarget &&
        downPaymentQuestion &&
        !broadBudgetScopeRequest &&
        !hasSpecificUnitBudgetAnchor;
      if (model || yearFromText || colorFromText || finishFromText || condition) {
        conv.inventoryContext = {
          model: model ?? conv.inventoryContext?.model,
          year:
            (modelChanged || resetContextForCondition) && !yearFromText
              ? undefined
              : year ?? conv.inventoryContext?.year,
          condition:
            modelChanged || resetContextForCondition
              ? (explicitCondition ?? undefined)
              : (condition ?? conv.inventoryContext?.condition),
          color:
            modelChanged || resetContextForCondition
              ? (colorFromText ?? undefined)
              : (colorFromText ?? conv.inventoryContext?.color),
          finish:
            modelChanged || resetContextForCondition
              ? (finishFromText ?? undefined)
              : (finishFromText ?? conv.inventoryContext?.finish),
          updatedAt: nowIso()
        };
      }

      if (model) {
        const hasIdentifiers =
          !!conv.lead?.vehicle?.stockId ||
          !!conv.lead?.vehicle?.vin ||
          !!color ||
          !!condition;
        const inventoryMatchStartedAt = Date.now();
        let matches = await findInventoryMatches({ year: year ?? null, model: modelForLookup });
        logRouteTiming("inventory.match", inventoryMatchStartedAt, { model: modelForLookup ?? model, year: year ?? null });
        if (condition) {
          matches = matches.filter(i => inventoryItemMatchesRequestedCondition(i, condition));
        }
        if (color) {
          const leadColor = String(color);
          const leadTrim: "chrome" | "black" | null = finish;
          matches = matches.filter(i => {
            const itemColor = i.color ?? "";
            if (colorMatchesExact(itemColor, leadColor, leadTrim) || colorMatchesAlias(itemColor, leadColor, leadTrim)) {
              return true;
            }
            const itemNorm = normalizeColorBase(itemColor, !!leadTrim);
            const leadNorm = normalizeColorBase(leadColor, !!leadTrim);
            if (!itemNorm || !leadNorm) return false;
            return itemNorm.includes(leadNorm) || leadNorm.includes(itemNorm);
          });
        }
        const holds = await listInventoryHolds();
        const solds = await listInventorySolds();
        const leadHoldKey = normalizeInventoryHoldKey(
          conv.lead?.vehicle?.stockId,
          conv.lead?.vehicle?.vin
        );
        const leadHold = leadHoldKey ? holds?.[leadHoldKey] : null;
        const leadSoldKey = normalizeInventorySoldKey(
          conv.lead?.vehicle?.stockId,
          conv.lead?.vehicle?.vin
        );
        const leadSold = leadSoldKey ? solds?.[leadSoldKey] : null;
        const availableMatches = matches.filter(m => {
          const key = normalizeInventoryHoldKey(m.stockId, m.vin);
          return key ? !holds?.[key] && !solds?.[key] : true;
        });
        if (ambiguousBudgetScopeQuestion && availableMatches.length > 1) {
          const bikeLabel = `${year ? `${year} ` : ""}${normalizeDisplayCase(String(model))}${
            color ? ` in ${formatColorLabel(color)}` : ""
          }`.trim();
          const reply = `Quick clarify so I quote this right: are you asking on the ${bikeLabel} specifically, or across all in-stock options around that payment?`;
          const systemMode = webhookMode;
          if (systemMode === "suggest") {
            appendOutbound(conv, event.to, event.from, reply, "draft_ai");
            const twiml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response></Response>`;
            return res.status(200).type("text/xml").send(twiml);
          }
          appendOutbound(conv, event.to, event.from, reply, "twilio");
          const twiml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n  <Message>${escapeXml(
            reply
          )}</Message>\n</Response>`;
          return res.status(200).type("text/xml").send(twiml);
        }
        const resolvedSpecificUnitBudgetQuestion =
          specificUnitBudgetQuestion ||
          (ambiguousBudgetScopeQuestion && availableMatches.length === 1);
        const hasSoldMatch = matches.some(m => {
          const key = normalizeInventorySoldKey(m.stockId, m.vin);
          return key ? !!solds?.[key] : false;
        });
        const budgetMatchedEntries = hasMonthlyBudgetTarget
          ? availableMatches
              .map(item => ({
                item,
                monthly: estimateInventoryItemMonthlyPayment(item, {
                  termMonths: paymentTermMonths,
                  taxRate: paymentTaxRate,
                  downPayment
                })
              }))
              .filter(entry => entry.monthly != null && (entry.monthly as number) <= (monthlyBudget as number))
              .sort((a, b) => (a.monthly as number) - (b.monthly as number))
          : [];
        const responseMatches = hasMonthlyBudgetTarget ? budgetMatchedEntries.map(entry => entry.item) : availableMatches;
        const conditionLabel = formatRequestedConditionLabel(condition);
        const requestedColorLabel = formatColorLabel(color) ?? color;

        if (matches.length === 0 && (leadSold || leadHold)) {
          const label =
            leadSold?.label ??
            leadHold?.label ??
            formatModelLabelForFollowUp(
              conv.lead?.vehicle?.year ?? null,
              conv.lead?.vehicle?.model ?? null
            );
          const reply = leadSold
            ? `Looks like that unit has sold. Want me to keep an eye out for another ${label}?`
            : `That unit is on hold right now. I can reach out if it becomes available — want me to keep an eye on it?`;
          const systemMode = webhookMode;
          if (systemMode === "suggest") {
            appendOutbound(conv, event.to, event.from, reply, "draft_ai");
            const twiml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response></Response>`;
            return res.status(200).type("text/xml").send(twiml);
          }
          appendOutbound(conv, event.to, event.from, reply, "twilio");
          const twiml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n  <Message>${escapeXml(
            reply
          )}</Message>\n</Response>`;
          return res.status(200).type("text/xml").send(twiml);
        }

        if (matches.length > 0 && availableMatches.length === 0) {
          const reply = hasSoldMatch
            ? "Looks like that unit has sold. Want me to keep an eye out for another one?"
            : "That unit is on hold right now. I can reach out if it becomes available — want me to keep an eye on it?";
          const systemMode = webhookMode;
          if (systemMode === "suggest") {
            appendOutbound(conv, event.to, event.from, reply, "draft_ai");
            const twiml = `<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<Response></Response>`;
            return res.status(200).type("text/xml").send(twiml);
          }
          appendOutbound(conv, event.to, event.from, reply, "twilio");
          const twiml = `<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<Response>\n  <Message>${escapeXml(
            reply
          )}</Message>\n</Response>`;
          return res.status(200).type("text/xml").send(twiml);
        }

        if (leadHold && availableMatches.length > 0) {
          const reply = `That specific unit is on hold right now, but we do have other ${conditionLabel}${model} options available. Want details?`;
          const systemMode = webhookMode;
          if (systemMode === "suggest") {
            appendOutbound(conv, event.to, event.from, reply, "draft_ai");
            const twiml = `<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<Response></Response>`;
            return res.status(200).type("text/xml").send(twiml);
          }
          appendOutbound(conv, event.to, event.from, reply, "twilio");
          const twiml = `<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<Response>\n  <Message>${escapeXml(
            reply
          )}</Message>\n</Response>`;
          return res.status(200).type("text/xml").send(twiml);
        }

        if (hasMonthlyBudgetTarget && availableMatches.length > 0 && responseMatches.length === 0) {
          if (resolvedSpecificUnitBudgetQuestion) {
            const leadStockId = conv.lead?.vehicle?.stockId ?? null;
            const leadVin = conv.lead?.vehicle?.vin ?? null;
            const exactMatch = leadStockId || leadVin
              ? availableMatches.find(
                  m => (leadStockId && m.stockId === leadStockId) || (leadVin && m.vin === leadVin)
                )
              : null;
            const pickedSpecific =
              exactMatch ??
              pickClosestInventoryItem(availableMatches, year ?? null, color ?? null)?.item ??
              availableMatches[0] ??
              null;
            const targetMonthly = Number(monthlyBudget);
            const budgetLabel = `$${Math.round(targetMonthly).toLocaleString("en-US")}/mo`;
              if (pickedSpecific) {
                const pickedLabel = formatBudgetInventoryOption(pickedSpecific);
                const requiredDown = estimateRequiredDownPaymentForTarget({
                  price: Number(pickedSpecific?.price ?? NaN),
                  isUsed: isUsedInventoryConditionForBudget(pickedSpecific?.condition, pickedSpecific?.year),
                termMonths: paymentTermMonths,
                taxRate: paymentTaxRate,
                targetMonthly
              });
                const noDownMonthly = estimateInventoryItemMonthlyPayment(pickedSpecific, {
                  termMonths: paymentTermMonths,
                  taxRate: paymentTaxRate,
                  downPayment: 0
                });
                const noDownMonthlyRounded =
                  noDownMonthly != null ? Math.round((noDownMonthly as number) / 10) * 10 : null;
                const combosText = buildPaymentTermDownCombosText({
                  price: Number(pickedSpecific?.price ?? NaN),
                  isUsed: isUsedInventoryConditionForBudget(pickedSpecific?.condition, pickedSpecific?.year),
                  taxRate: paymentTaxRate,
                  targetMonthly
                });
                let reply = "";
                if (requiredDown == null) {
                  reply = `For ${pickedLabel}, I can run that payment target for you. Do you want 60, 72, or 84 months?`;
                } else if (requiredDown <= 0) {
                  reply = `On ${pickedLabel}, you should already be around ${budgetLabel} or lower on a ${paymentTermMonths}-month estimate with little to no money down (before taxes/fees and final APR). ${combosText}`;
                } else {
                  const roundedDown = Math.max(0, Math.round(requiredDown / 100) * 100);
                  const noDownLine =
                    noDownMonthlyRounded != null
                      ? ` With $0 down it’s roughly $${noDownMonthlyRounded.toLocaleString("en-US")}/mo.`
                      : "";
                  reply = `On ${pickedLabel}, to get near ${budgetLabel} on a ${paymentTermMonths}-month estimate, you’d be around $${roundedDown.toLocaleString("en-US")} down (before taxes/fees and final lender approval).${noDownLine} ${combosText}`;
                }
              const systemMode = webhookMode;
              if (systemMode === "suggest") {
                appendOutbound(conv, event.to, event.from, reply, "draft_ai");
                const twiml = `<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<Response></Response>`;
                return res.status(200).type("text/xml").send(twiml);
              }
              appendOutbound(conv, event.to, event.from, reply, "twilio");
              const twiml = `<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<Response>\n  <Message>${escapeXml(
                reply
              )}</Message>\n</Response>`;
              return res.status(200).type("text/xml").send(twiml);
            }
          }

          let alternativePool = items.filter(i => {
            const holdKey = normalizeInventoryHoldKey(i.stockId, i.vin);
            const soldKey = normalizeInventorySoldKey(i.stockId, i.vin);
            if (holdKey && holds?.[holdKey]) return false;
            if (soldKey && solds?.[soldKey]) return false;
            return true;
          });
          const trailerRequested =
            isTrailerOrTowRequestText(event.body) ||
            isTrailerOrTowRequestText(model) ||
            isTrailerOrTowRequestText(conv.lead?.vehicle?.description);
          if (!trailerRequested) {
            alternativePool = alternativePool.filter(i => isLikelyMotorcycleInventoryItem(i));
          }
          if (touringRequested) {
            alternativePool = alternativePool.filter(i => isTouringModelName(i.model));
          }
          if (modelExplicitInInbound && model) {
            const modelKey = normalizeModelText(model);
            alternativePool = alternativePool.filter(i => normalizeModelText(i.model ?? "") === modelKey);
          }
          const alternativeBudgetEntries = alternativePool
            .map(item => ({
              item,
              monthly: estimateInventoryItemMonthlyPayment(item, {
                termMonths: paymentTermMonths,
                taxRate: paymentTaxRate,
                downPayment
              })
            }))
            .filter(entry => entry.monthly != null && (entry.monthly as number) <= (monthlyBudget as number))
            .sort((a, b) => (a.monthly as number) - (b.monthly as number));
          const budgetLabel = `$${Number(monthlyBudget).toLocaleString("en-US")}/mo`;
          const scopeLabel =
            modelExplicitInInbound && model
              ? normalizeDisplayCase(String(model))
              : touringRequested
                ? "touring bikes"
                : "inventory";
          const reply = alternativeBudgetEntries.length
            ? (() => {
                const top = alternativeBudgetEntries.slice(0, 3);
                const list = top.map(entry => formatBudgetInventoryOption(entry.item)).join("; ");
                return modelExplicitInInbound && model
                  ? `I do have ${scopeLabel} in stock, but they typically run over ${budgetLabel} on a ${paymentTermMonths}-month estimate. Closest in your budget: ${list}. Want me to pull more in that range?`
                  : `Closest in-stock options around ${budgetLabel} on a ${paymentTermMonths}-month estimate: ${list}. Want me to pull more in that range?`;
              })()
            : `I’m not seeing ${scopeLabel} in stock that would typically land under ${budgetLabel} on a ${paymentTermMonths}-month estimate. If you share term or down payment, I can tighten the match.`;
          const systemMode = webhookMode;
          if (systemMode === "suggest") {
            appendOutbound(conv, event.to, event.from, reply, "draft_ai");
            const twiml = `<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<Response></Response>`;
            return res.status(200).type("text/xml").send(twiml);
          }
          appendOutbound(conv, event.to, event.from, reply, "twilio");
          const twiml = `<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<Response>\n  <Message>${escapeXml(
            reply
          )}</Message>\n</Response>`;
          return res.status(200).type("text/xml").send(twiml);
        }

        if (responseMatches.length > 0) {
        const leadStockId = conv.lead?.vehicle?.stockId ?? null;
        const leadVin = conv.lead?.vehicle?.vin ?? null;
        const responseMatchesExcludingLead = otherInventoryRequest
          ? responseMatches.filter(
              m => !((leadStockId && m.stockId === leadStockId) || (leadVin && m.vin === leadVin))
            )
          : responseMatches;
        if (otherInventoryRequest && responseMatchesExcludingLead.length === 0) {
          const paintTrimPrompt = "Are you looking for any paint or trim specifically (chrome vs blacked-out)?";
          const reply = `Right now that’s the only ${conditionLabel}${year ? `${year} ` : ""}${model}${requestedColorLabel ? ` in ${requestedColorLabel}` : ""} we have in stock. ${paintTrimPrompt}`;
          const systemMode = webhookMode;
          if (systemMode === "suggest") {
            appendOutbound(conv, event.to, event.from, reply, "draft_ai");
            const twiml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response></Response>`;
            return res.status(200).type("text/xml").send(twiml);
          }
          appendOutbound(conv, event.to, event.from, reply, "twilio");
          const twiml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n  <Message>${escapeXml(
            reply
          )}</Message>\n</Response>`;
          return res.status(200).type("text/xml").send(twiml);
        }
        const exactMatch = !otherInventoryRequest && (leadStockId || leadVin)
          ? responseMatches.find(m =>
              (leadStockId && m.stockId === leadStockId) || (leadVin && m.vin === leadVin)
            )
          : null;
        const selectionPool = responseMatchesExcludingLead.length ? responseMatchesExcludingLead : responseMatches;
        const pick = exactMatch ? { item: exactMatch } : pickClosestInventoryItem(selectionPool, year ?? null, color ?? null);
        const picked = pick?.item ?? null;
        if (picked) {
          conv.inventoryContext = {
            model: picked.model ?? model ?? conv.inventoryContext?.model,
            year: picked.year ?? year ?? conv.inventoryContext?.year,
            condition: inferInventoryItemCondition(picked) ?? condition ?? conv.inventoryContext?.condition,
            color: picked.color ?? color ?? conv.inventoryContext?.color,
            finish: conv.inventoryContext?.finish,
            updatedAt: nowIso()
          };
          conv.lead = conv.lead ?? {};
          conv.lead.vehicle = conv.lead.vehicle ?? {};
          if (picked.stockId) conv.lead.vehicle.stockId = picked.stockId;
          if (picked.vin) conv.lead.vehicle.vin = picked.vin;
          if (typeof picked.price === "number" && Number.isFinite(picked.price)) {
            conv.lead.vehicle.listPrice = picked.price;
          }
        }
        const pickedMonthlyEstimate =
          hasMonthlyBudgetTarget && picked
            ? estimateInventoryItemMonthlyPayment(picked, {
                termMonths: paymentTermMonths,
                taxRate: paymentTaxRate,
                downPayment
              })
            : null;
        const pickedMonthlyRounded =
          pickedMonthlyEstimate != null ? Math.round((pickedMonthlyEstimate as number) / 10) * 10 : null;
        const pickedPaymentHint =
          pickedMonthlyRounded != null
            ? ` It should land around $${pickedMonthlyRounded.toLocaleString("en-US")}/mo on a ${paymentTermMonths}-month estimate (before taxes/fees, depending on APR).`
            : "";
        if (photoRequested && picked) {
          const pickedYear = picked.year ? `${picked.year} ` : "";
          const pickedModel = picked.model ?? model ?? "that model";
          const pickedColor = formatColorLabel(picked.color ?? null);
          const label = `${pickedYear}${pickedModel}`.trim();
          const explicitColor = !!colorFromText;
          const colorMismatch =
            explicitColor &&
            !!pickedColor &&
            !colorMatchesExact(pickedColor, String(color), finish) &&
            !colorMatchesAlias(pickedColor, String(color), finish);
          const colorNote = explicitColor
            ? requestedColorLabel
              ? ` in ${requestedColorLabel}`
              : pickedColor
                ? ` in ${pickedColor}`
                : ""
            : exactMatch && pickedColor
              ? ` in ${pickedColor}`
              : "";
          const reply = colorMismatch
            ? `I don’t see ${requestedColorLabel ?? "that color"} in stock right now, but I can send photos of the ${label}${pickedColor ? ` in ${pickedColor}` : ""} we do have. Want those?`
            : year || model
              ? `Yes — here’s a photo of the ${year ? `${year} ` : ""}${model ?? pickedModel}${colorNote} we have in stock.`
              : `Yes — here’s a photo of the ${colorNote ? colorNote.replace(/^ in /, "") + " " : ""}${label} we have in stock.`;
          setDialogState(conv, "inventory_answered");
          const systemMode = webhookMode;
          if (systemMode === "suggest") {
            appendOutbound(
              conv,
              event.to,
              event.from,
              reply,
              "draft_ai",
              undefined,
              picked.images?.[0] ? [picked.images[0]] : undefined
            );
            const twiml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response></Response>`;
            return res.status(200).type("text/xml").send(twiml);
          }
          appendOutbound(
            conv,
            event.to,
            event.from,
            reply,
            "twilio",
            undefined,
            picked.images?.[0] ? [picked.images[0]] : undefined
          );
          const mediaTag = picked.images?.[0] ? `\n    <Media>${escapeXml(picked.images[0])}</Media>` : "";
          const twiml = `<?xml version=\"1.0\" encoding=\"UTF-8\"?>\\n<Response>\\n  <Message>\\n    <Body>${escapeXml(
            reply
          )}</Body>${mediaTag}\\n  </Message>\\n</Response>`;
          return res.status(200).type("text/xml").send(twiml);
        }
        if (!year && (color || finishFromText) && picked) {
          const pickedYear = picked.year ? `${picked.year} ` : "";
          const pickedModel = picked.model ?? model ?? "that model";
          const pickedColor = formatColorLabel(picked.color ?? null);
          const paintTrimPrompt = "Are you looking for any paint or trim specifically (chrome vs blacked-out)?";
          const reply = hasMonthlyBudgetTarget
            ? `Yes — we do have a ${conditionLabel}${pickedYear}${pickedModel}${pickedColor ? ` in ${pickedColor}` : ""} in stock.${pickedPaymentHint} Want another option around that payment range?`
            : otherInventoryRequest
              ? `Yes — we do have another ${conditionLabel}${pickedYear}${pickedModel}${pickedColor ? ` in ${pickedColor}` : ""} in stock. ${paintTrimPrompt}`
              : `Yes — we do have a ${conditionLabel}${pickedYear}${pickedModel}${pickedColor ? ` in ${pickedColor}` : ""} in stock. Want details or to stop by?`;
          setDialogState(conv, "inventory_answered");
          const systemMode = webhookMode;
          if (systemMode === "suggest") {
            appendOutbound(
              conv,
              event.to,
              event.from,
              reply,
              "draft_ai",
              undefined,
              picked.images?.[0] ? [picked.images[0]] : undefined
            );
            const twiml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response></Response>`;
            return res.status(200).type("text/xml").send(twiml);
          }
          appendOutbound(
            conv,
            event.to,
            event.from,
            reply,
            "twilio",
            undefined,
            picked.images?.[0] ? [picked.images[0]] : undefined
          );
          const mediaTag = picked.images?.[0] ? `\n    <Media>${escapeXml(picked.images[0])}</Media>` : "";
          const twiml = `<?xml version=\"1.0\" encoding=\"UTF-8\"?>\\n<Response>\\n  <Message>\\n    <Body>${escapeXml(
            reply
          )}</Body>${mediaTag}\\n  </Message>\\n</Response>`;
          return res.status(200).type("text/xml").send(twiml);
        }
        conv.lead = conv.lead ?? {};
        conv.lead.vehicle = conv.lead.vehicle ?? {};
        if (year) conv.lead.vehicle.year = year;
        conv.lead.vehicle.model = model ?? conv.lead.vehicle.model;
        if (condition) conv.lead.vehicle.condition = condition;
        if (color) conv.lead.vehicle.color = color;
        setDialogState(conv, "inventory_answered");
        const imageUrl =
          responseMatches.find(m => Array.isArray(m.images) && m.images.length)?.images?.[0] ?? null;
        const finishLabel = finishFromText ? ` with ${finishFromText} finish` : "";
        const colorLabel = requestedColorLabel ? ` in ${requestedColorLabel}` : "";
        const asksConditionOnly =
          /\b(new|used|pre[-\s]?owned|preowned)\b/i.test(textLower) &&
          (/\bor\b/i.test(textLower) || /\b(is it|that|this)\b/i.test(textLower)) &&
          !/\b(price|payment|monthly|otd|apr|down|trade|schedule|appointment|test ride)\b/i.test(textLower);
        const conditionAnswer =
          condition === "used" ? "It’s used." : condition === "new" ? "It’s new." : "";
        const paintTrimPrompt = "Are you looking for any paint or trim specifically (chrome vs blacked-out)?";
        const anyYearRequested =
          /\b(any year|no year preference|open to other years|either year|any model year)\b/i.test(
            textLower
          );
        const followUpPreferencePrompt = anyYearRequested
          ? condition === "new"
            ? "Any specific color or finish you’re after (chrome vs blacked-out)?"
            : "Any specific color you’re after?"
          : "Any specific year or color you’re after?";
        const reply = hasMonthlyBudgetTarget
          ? `Yes — we do have ${formatBudgetInventoryOption(picked ?? { year, model, color })} in stock.${pickedPaymentHint} Want another option around that payment range?`
          : otherInventoryRequest
            ? `Yes — we do have another ${formatBudgetInventoryOption(picked ?? { year, model, color })} in stock. ${paintTrimPrompt}`
          : asksConditionOnly && conditionAnswer
            ? `${conditionAnswer} We do have a ${conditionLabel}${model} in stock. ${followUpPreferencePrompt}`
          : year
            ? `Yes — we do have a ${conditionLabel}${year} ${model}${colorLabel}${finishLabel} in stock. Would you like to stop by to take a look?`
          : color || finishFromText
              ? anyYearRequested
                ? `Yes — we do have a ${conditionLabel}${model}${colorLabel}${finishLabel} in stock. Would you like details or to stop by?`
                : `Yes — we do have a ${conditionLabel}${model}${colorLabel}${finishLabel} in stock. What year are you after?`
              : `Yes — we do have a ${conditionLabel}${model} in stock. ${followUpPreferencePrompt}`;
          const systemMode = webhookMode;
          if (systemMode === "suggest") {
            appendOutbound(
              conv,
              event.to,
              event.from,
              reply,
              "draft_ai",
              undefined,
              imageUrl ? [imageUrl] : undefined
            );
            const twiml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response></Response>`;
            return res.status(200).type("text/xml").send(twiml);
          }
          appendOutbound(conv, event.to, event.from, reply, "twilio", undefined, imageUrl ? [imageUrl] : undefined);
          const mediaTag = imageUrl ? `\n    <Media>${escapeXml(imageUrl)}</Media>` : "";
          const twiml = `<?xml version=\"1.0\" encoding=\"UTF-8\"?>\\n<Response>\\n  <Message>\\n    <Body>${escapeXml(
            reply
          )}</Body>${mediaTag}\\n  </Message>\\n</Response>`;
          return res.status(200).type("text/xml").send(twiml);
        }
        if (matches.length === 0 && color && !hasIdentifiers) {
          const watchCondition = inferWatchCondition(
            model ?? undefined,
            year ? Number(year) : undefined,
            conv
          );
          const watchExactLabel = watchCondition === "new" ? "exact year/color" : "exact year";
          const watchBudgetSeed = resolveWatchBudgetPreferenceForConversation(
            conv,
            String(event.body ?? "")
          );
          conv.inventoryWatchPending = {
            model: model ?? undefined,
            year: year ? Number(year) : undefined,
            color: combineWatchColorAndFinish(color, finishFromText),
            minPrice: watchBudgetSeed.minPrice,
            maxPrice: watchBudgetSeed.maxPrice,
            monthlyBudget: watchBudgetSeed.monthlyBudget,
            termMonths: watchBudgetSeed.termMonths,
            downPayment: watchBudgetSeed.downPayment,
            askedAt: new Date().toISOString()
          };
          const reply = year
            ? `I’m not seeing a ${conditionLabel}${year} ${model}${requestedColorLabel ? ` in ${requestedColorLabel}` : ""} in stock right now. ${buildOutOfStockHumanOptionsLine()} Want me to keep an eye out for the ${watchExactLabel}?`
            : `I’m not seeing a ${conditionLabel}${model}${requestedColorLabel ? ` in ${requestedColorLabel}` : ""} in stock right now. ${buildOutOfStockHumanOptionsLine()} Want me to keep an eye out for the ${watchExactLabel}?`;
          setDialogState(conv, "inventory_watch_prompted");
          const systemMode = webhookMode;
          if (systemMode === "suggest") {
            appendOutbound(conv, event.to, event.from, reply, "draft_ai");
            const twiml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response></Response>`;
            return res.status(200).type("text/xml").send(twiml);
          }
          appendOutbound(conv, event.to, event.from, reply, "twilio");
          const twiml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n  <Message>${escapeXml(
            reply
          )}</Message>\n</Response>`;
          return res.status(200).type("text/xml").send(twiml);
        }
        if (matches.length === 0 && !hasIdentifiers) {
          const inventoryFallbackMatchStartedAt = Date.now();
          let fallback = await findInventoryMatches({ year: null, model: modelForLookup });
          logRouteTiming("inventory.match_fallback", inventoryFallbackMatchStartedAt, { model: modelForLookup ?? model });
          if (color) {
            const c = color.toLowerCase();
            fallback = fallback.filter(i => (i.color ?? "").toLowerCase().includes(c));
          }
          const availableFallback = fallback.filter(m => {
            const key = normalizeInventoryHoldKey(m.stockId, m.vin);
            return key ? !holds?.[key] && !solds?.[key] : true;
          });
          const pick = pickClosestInventoryItem(availableFallback, year ?? null, color ?? null);
          if (pick?.item) {
            const picked = pick.item;
            const yearLabel = picked.year ? `${picked.year} ` : "";
            const modelLabel = picked.model ?? model ?? "that model";
            const colorLabel = formatColorLabel(picked.color ?? null);
            const label = `${yearLabel}${modelLabel}`.trim();
            const watchCondition = inferWatchCondition(
              model ?? undefined,
              year ? Number(year) : undefined,
              conv
            );
            const watchExactLabel = watchCondition === "new" ? "exact year/color" : "exact year";
            const reply =
              year
                ? `Got it — I’m not seeing a ${year} ${model} in stock right now, but we do have a ${colorLabel ? `${colorLabel} ` : ""}${label} available. Here’s a photo — is this the one you had in mind? If not, I can keep an eye out for the ${watchExactLabel}.`
                : `Got it — we do have a ${colorLabel ? `${colorLabel} ` : ""}${label} available. Here’s a photo — is this the one you had in mind? If not, I can keep an eye out for the ${watchExactLabel}.`;
            setDialogState(conv, "inventory_answered");
            const systemMode = webhookMode;
            if (systemMode === "suggest") {
              appendOutbound(
                conv,
                event.to,
                event.from,
                reply,
                "draft_ai",
                undefined,
                pick.imageUrl ? [pick.imageUrl] : undefined
              );
              const twiml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response></Response>`;
              return res.status(200).type("text/xml").send(twiml);
            }
            appendOutbound(
              conv,
              event.to,
              event.from,
              reply,
              "twilio",
              undefined,
              pick.imageUrl ? [pick.imageUrl] : undefined
            );
            const mediaTag = pick.imageUrl ? `\n    <Media>${escapeXml(pick.imageUrl)}</Media>` : "";
            const twiml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n  <Message>\n    <Body>${escapeXml(
              reply
            )}</Body>${mediaTag}\n  </Message>\n</Response>`;
            return res.status(200).type("text/xml").send(twiml);
          }
        }
        addTodo(
          conv,
          "other",
          `Verify inventory for ${conditionLabel}${year ? `${year} ` : ""}${model}${requestedColorLabel ? ` (${requestedColorLabel})` : ""}`.trim(),
          event.providerMessageId
        );
        const isGenericModel = /full line|other/i.test(model ?? "");
        if (!isGenericModel) {
          const watchBudgetSeed = resolveWatchBudgetPreferenceForConversation(
            conv,
            String(event.body ?? "")
          );
          conv.inventoryWatchPending = {
            model: model ?? undefined,
            year: year ? Number(year) : undefined,
            color: combineWatchColorAndFinish(color, finishFromText),
            minPrice: watchBudgetSeed.minPrice,
            maxPrice: watchBudgetSeed.maxPrice,
            monthlyBudget: watchBudgetSeed.monthlyBudget,
            termMonths: watchBudgetSeed.termMonths,
            downPayment: watchBudgetSeed.downPayment,
            askedAt: new Date().toISOString()
          };
          setDialogState(conv, "inventory_watch_prompted");
        }
        const colorFinishPrompt = await buildColorFinishFollowUpPrompt(conv, model, year, color);
        const reply =
          `I’m not seeing ${conditionLabel}${year ? `${year} ` : ""}${model}${requestedColorLabel ? ` in ${requestedColorLabel}` : ""} in stock right now. ` +
          (isGenericModel
            ? "I’ll have someone verify and follow up shortly."
            : `${buildOutOfStockHumanOptionsLine()}${colorFinishPrompt ? ` ${colorFinishPrompt}` : ""} Want me to keep an eye out and text you when one lands?`);
        const systemMode = webhookMode;
        if (systemMode === "suggest") {
          appendOutbound(conv, event.to, event.from, reply, "draft_ai");
          const twiml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response></Response>`;
          return res.status(200).type("text/xml").send(twiml);
        }
        appendOutbound(conv, event.to, event.from, reply, "twilio");
        const twiml = `<?xml version=\"1.0\" encoding=\"UTF-8\"?>\\n<Response>\\n  <Message>${escapeXml(
          reply
        )}</Message>\\n</Response>`;
        return res.status(200).type("text/xml").send(twiml);
      }
      addTodo(conv, "other", "Verify inventory availability", event.providerMessageId);
      const reply = "I’ll have someone verify inventory availability and follow up shortly.";
      const systemMode = webhookMode;
      if (systemMode === "suggest") {
        appendOutbound(conv, event.to, event.from, reply, "draft_ai");
        const twiml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response></Response>`;
        return res.status(200).type("text/xml").send(twiml);
      }
      appendOutbound(conv, event.to, event.from, reply, "twilio");
      const twiml = `<?xml version=\"1.0\" encoding=\"UTF-8\"?>\\n<Response>\\n  <Message>${escapeXml(
        reply
      )}</Message>\\n</Response>`;
      return res.status(200).type("text/xml").send(twiml);
    } catch (e: any) {
      addTodo(conv, "other", "Verify inventory availability", event.providerMessageId);
      const reply = "I’ll have someone verify inventory availability and follow up shortly.";
      const systemMode = webhookMode;
      if (systemMode === "suggest") {
        appendOutbound(conv, event.to, event.from, reply, "draft_ai");
        const twiml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response></Response>`;
        return res.status(200).type("text/xml").send(twiml);
      }
      appendOutbound(conv, event.to, event.from, reply, "twilio");
      const twiml = `<?xml version=\"1.0\" encoding=\"UTF-8\"?>\\n<Response>\\n  <Message>${escapeXml(
        reply
      )}</Message>\\n</Response>`;
      return res.status(200).type("text/xml").send(twiml);
    } finally {
      logRouteTiming("inventory", inventoryStageStartedAt);
    }
  }
  // Deterministic slot offer for Twilio when scheduling context is known but no slots exist yet.
  if (
    event.provider === "twilio" &&
    !conv.appointment?.bookedEventId &&
    (!conv.scheduler?.lastSuggestedSlots || conv.scheduler.lastSuggestedSlots.length === 0) &&
    !schedulingBlocked &&
    !schedulingSignals.hasDayOnlyRequest &&
    !schedulingSignals.hasDayOnlyAvailability
  ) {
    const cta = conv.classification?.cta ?? "";
    const bucket = conv.classification?.bucket ?? "";
    const ctxSuggestsScheduling =
      /(check_availability|inventory_interest|appointment|schedule|book|visit|test_ride)/i.test(cta) ||
      /(inventory_interest|appointment|schedule|book|visit|test_ride)/i.test(bucket);
    let llmSuggestsScheduling = false;
    if (!ctxSuggestsScheduling) {
      const text = String(event.body ?? "").trim();
      if (text.length > 3 && !shortAck && !looksLikeTimeSelection(text)) {
        llmSuggestsScheduling = await classifySchedulingIntent(text);
        console.log("[twilio] llm scheduling intent", {
          text: text.slice(0, 120),
          llmSuggestsScheduling
        });
      }
    }
    const schedulingIntent =
      turnPrimaryIntent === "scheduling" &&
      schedulingExplicit &&
      (ctxSuggestsScheduling || llmSuggestsScheduling || schedulingSignals.hasDayTime);
    if (schedulingIntent) {
      const schedulerStageStartedAt = Date.now();
      try {
        const schedulerConfigStartedAt = Date.now();
        const cfg = await getSchedulerConfigHot();
        logRouteTiming("scheduler.config", schedulerConfigStartedAt);
        const requested = parseRequestedDayTime(
          bookingParseText || String(event.body ?? ""),
          cfg.timezone
        );
        if (requested) {
          console.log("[deterministic-offer] skip explicit day/time request");
          // Let orchestrator/exact-booking handle explicit day+time requests.
        } else {
        const appointmentTypes = cfg.appointmentTypes ?? { inventory_visit: { durationMinutes: 60 } };
        const preferredSalespeople = getPreferredSalespeopleForConv(cfg, conv);
        const salespeople = cfg.salespeople ?? [];
        const gapMinutes = cfg.minGapBetweenAppointmentsMinutes ?? 60;
        const appointmentType = llmTestRideIntent ? "test_ride" : "inventory_visit";
        const durationMinutes = appointmentTypes[appointmentType]?.durationMinutes ?? 60;

        const cal = await getAuthedCalendarClient();
        const now = new Date();
        const timeMin = new Date(now).toISOString();
        const timeMax = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000).toISOString();

        let bestSlots: any[] = [];
        for (const salespersonId of preferredSalespeople) {
          const sp = salespeople.find((p: any) => p.id === salespersonId);
          if (!sp) continue;
          const fb = await queryFreeBusy(cal, [sp.calendarId], timeMin, timeMax, cfg.timezone);
          const busy = (fb.calendars?.[sp.calendarId]?.busy ?? []) as any;
          const expanded = expandBusyBlocks(busy, gapMinutes);
          const candidatesByDay = generateCandidateSlots(cfg, now, durationMinutes, 14);
          const slots = pickSlotsForSalesperson(
            cfg,
            sp.id,
            sp.calendarId,
            candidatesByDay,
            expanded,
            2
          );
          if (slots.length >= 2) {
            bestSlots = slots.map((s: any) => {
              const startIso = typeof s.start === "string" ? s.start : s.start.toISOString();
              const endIso = typeof s.end === "string" ? s.end : s.end.toISOString();
              return {
                salespersonId: sp.id,
                salespersonName: sp.name,
                calendarId: sp.calendarId,
                start: startIso,
                end: endIso,
                startLocal: formatSlotLocal(startIso, cfg.timezone),
                endLocal: formatSlotLocal(endIso, cfg.timezone),
                appointmentType
              };
            });
            break;
          }
        }

        logRouteTiming("scheduler.deterministic_slots", schedulerStageStartedAt, {
          slotCount: bestSlots.length
        });
        if (bestSlots.length >= 2) {
          const timeLike = looksLikeTimeSelection(event.body);
          const chosen = timeLike ? chooseSlotFromReply(bestSlots, event.body) : null;
          if (chosen) {
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
              `Source: ${conv.lead?.source ?? ""}`,
              `VisitType: ${appointmentType}`
            ]
              .filter(Boolean)
              .join("\n");
            const colorId = getAppointmentTypeColorId(cfg, appointmentType);
            const created = await insertEvent(
              cal,
              chosen.calendarId,
              cfg.timezone,
              summary,
              description,
              chosen.start,
              chosen.end,
              colorId
            );

            conv.appointment = conv.appointment ?? { status: "none", updatedAt: new Date().toISOString() };
            conv.appointment.status = "confirmed";
            conv.appointment.whenText = chosen.startLocal ?? chosen.start;
            conv.appointment.whenIso = chosen.start;
            conv.appointment.confirmedBy = "customer";
            conv.appointment.updatedAt = new Date().toISOString();
            conv.appointment.acknowledged = true;
            conv.appointment.bookedEventId = created.id ?? null;
            conv.appointment.bookedEventLink = created.htmlLink ?? null;
            conv.appointment.bookedSalespersonId = chosen.salespersonId ?? null;
            conv.appointment.matchedSlot = chosen;
            conv.appointment.reschedulePending = false;
            onAppointmentBooked(conv);
            if (appointmentType === "test_ride") {
              setDialogState(conv, "test_ride_booked");
            } else {
              setDialogState(conv, "schedule_booked");
            }

            if (conv.scheduler) {
              conv.scheduler.lastSuggestedSlots = [];
              conv.scheduler.updatedAt = new Date().toISOString();
            }

            const repName =
              chosen?.salespersonName ??
              cfg.salespeople?.find(p => p.id === chosen?.salespersonId)?.name ??
              null;
            const repSuffix = repName ? ` with ${repName}` : "";
            const confirmText = `Perfect — you’re all set for ${conv.appointment.whenText}${repSuffix}. See you then.`;
            const systemMode = webhookMode;
            if (systemMode === "suggest") {
              logRouteTiming("scheduler.deterministic_booked", schedulerStageStartedAt, { mode: "suggest" });
              appendOutbound(conv, event.to, event.from, confirmText, "draft_ai");
              saveConversation(conv);
              await flushConversationStore();
              const twiml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response></Response>`;
              return res.status(200).type("text/xml").send(twiml);
            }
            logRouteTiming("scheduler.deterministic_booked", schedulerStageStartedAt, { mode: "twilio" });
            appendOutbound(conv, event.to, event.from, confirmText, "twilio", created.id ?? undefined);
            saveConversation(conv);
            await flushConversationStore();
            const twiml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n  <Message>${escapeXml(
              confirmText
            )}</Message>\n</Response>`;
            return res.status(200).type("text/xml").send(twiml);
          }

          setLastSuggestedSlots(conv, bestSlots);
          console.log(
            "[scheduler] persisted lastSuggestedSlots",
            bestSlots.length,
            "leadKey",
            conv.leadKey
          );
          console.log("[scheduler] bestSlots len:", bestSlots.length);
          console.log(
            "[scheduler] bestSlots preview:",
            bestSlots.slice(0, 2).map(s => s.startLocal)
          );
          const lastOutboundTextOffer = getLastNonVoiceOutbound(conv)?.body ?? "";
          let reply = `I have ${bestSlots[0].startLocal} or ${bestSlots[1].startLocal} — do any of these times work?`;
          reply = applySlotOfferPolicy(conv, reply, lastOutboundTextOffer);
          if (isSlotOfferMessage(reply)) {
            if (llmTestRideIntent) {
              setDialogState(conv, "test_ride_offer_sent");
            } else {
              setDialogState(conv, "schedule_offer_sent");
            }
          }
          const systemMode = webhookMode;
          if (systemMode === "suggest") {
            logRouteTiming("scheduler.deterministic_offer", schedulerStageStartedAt, { mode: "suggest" });
            appendOutbound(conv, event.to, event.from, reply, "draft_ai");
            saveConversation(conv);
            await flushConversationStore();
            console.log(
              "[scheduler] after flush lastSuggestedSlots len:",
              conv.scheduler?.lastSuggestedSlots?.length ?? 0
            );
            const twiml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response></Response>`;
            return res.status(200).type("text/xml").send(twiml);
          }
          logRouteTiming("scheduler.deterministic_offer", schedulerStageStartedAt, { mode: "twilio" });
          appendOutbound(conv, event.to, event.from, reply, "twilio");
          saveConversation(conv);
          await flushConversationStore();
          console.log(
            "[scheduler] after flush lastSuggestedSlots len:",
            conv.scheduler?.lastSuggestedSlots?.length ?? 0
          );
          const twiml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n  <Message>${escapeXml(
            reply
          )}</Message>\n</Response>`;
          return res.status(200).type("text/xml").send(twiml);
        }
        }
      } catch (e: any) {
        logRouteTiming("scheduler.deterministic_error", schedulerStageStartedAt, {
          error: String(e?.message ?? e)
        });
        console.log("[scheduler] deterministic offer failed:", e?.message ?? e);
      }
    }
  }

  const schedulingTextForOrchestrator =
    turnPrimaryIntent === "scheduling" &&
    bookingIntentAccepted &&
    bookingParseText &&
    !shortAck &&
    !isAffirmative(event.body) &&
    schedulingAllowed &&
    (bookingParse.intent === "schedule" ||
      bookingParse.intent === "reschedule" ||
      bookingParse.intent === "availability")
      ? bookingParseText
      : null;
  const appointmentTypeOverride = llmTestRideIntent ? "test_ride" : undefined;
  const history = buildHistory(conv, 20);
  const memorySummary = conv.memorySummary?.text ?? null;
  const memorySummaryShouldUpdate = shouldUpdateMemorySummary(conv);
  const leadForOrchestrator = conv.lead
    ? {
        ...conv.lead,
        vehicle: {
          ...(conv.lead.vehicle ?? {}),
          stockId:
            (conv.inventoryContext as any)?.stockId ??
            conv.lead.vehicle?.stockId,
          vin:
            (conv.inventoryContext as any)?.vin ??
            conv.lead.vehicle?.vin,
          year:
            (conv.inventoryContext as any)?.year ??
            conv.lead.vehicle?.year,
          model:
            (conv.inventoryContext as any)?.model ??
            conv.lead.vehicle?.model,
          color:
            (conv.inventoryContext as any)?.color ??
            conv.lead.vehicle?.color,
          condition:
            (conv.inventoryContext as any)?.condition ??
            conv.lead.vehicle?.condition,
          listPrice:
            (conv.inventoryContext as any)?.listPrice ??
            conv.lead.vehicle?.listPrice
        }
      }
    : null;
  const weatherProfileStartedAt = Date.now();
  const weatherProfile = await getDealerProfileHot();
  logRouteTiming("dealer_profile_for_weather", weatherProfileStartedAt);
  const weatherStatus = await getDealerWeatherStatus(weatherProfile);
  if (event.provider === "twilio" && shouldSuppressShortAckDraft(event.body ?? "")) {
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response></Response>`;
    return res.status(200).type("text/xml").send(twiml);
  }
  const orchestratorStartedAt = Date.now();
  const result = await orchestrateInbound(event, history, {
    appointment: conv.appointment,
    followUp: conv.followUp,
    leadSource: conv.lead?.source ?? null,
    bucket: conv.classification?.bucket ?? null,
    cta: conv.classification?.cta ?? null,
    primaryIntentHint: turnPrimaryIntent,
    availabilityIntentHint: deterministicAvailabilityIntentOverride,
    schedulingIntentHint: schedulingPrimaryIntent,
    pricingIntentHint: pricingOrPaymentsIntent,
    financeIntentHint: financePriorityOverride,
    lead: leadForOrchestrator,
    pricingAttempts: getPricingAttempts(conv),
    allowSchedulingOffer:
      turnPrimaryIntent === "scheduling" &&
      (schedulingExplicit || explicitScheduleSignal) &&
      schedulingAllowed &&
      !pricingOrPaymentsIntent,
    schedulingText: schedulingTextForOrchestrator,
    callbackRequestedOverride: turnPrimaryIntent === "callback" ? callbackRequestedOverride : false,
    appointmentTypeOverride,
    voiceSummary: getActiveVoiceContext(conv)?.summary ?? null,
    memorySummary,
    memorySummaryShouldUpdate,
    inventoryWatch: conv.inventoryWatch ?? null,
    inventoryWatches: conv.inventoryWatches ?? null,
    financeDocs: conv.financeDocs ?? null,
    tradePayoff: conv.tradePayoff ?? null,
    hold: conv.hold ?? null,
    sale: conv.sale ?? null,
    pickup: conv.pickup ?? null,
    weather: weatherStatus ?? null
  });
  logRouteTiming("orchestrator", orchestratorStartedAt, {
    turnPrimaryIntent
  });
  if (result.smallTalk) {
    setDialogState(conv, "small_talk");
  }
  if (pricingOrPaymentsIntent) {
    result.requestedTime = undefined;
    result.suggestedSlots = [];
    result.draft = stripSchedulingLanguageIfNotAsked(String(result.draft ?? ""), String(event.body ?? ""));
  }
  if (result.pickupUpdate) {
    conv.pickup = { ...(conv.pickup ?? {}), ...result.pickupUpdate, updatedAt: nowIso() };
  }
  if (!pricingOrPaymentsIntent && !result.requestedTime && schedulingAllowed && schedulingSignals.hasDayTime) {
    try {
      const cfg = await getSchedulerConfigHot();
      const tz = cfg.timezone || "America/New_York";
      const parsed = parseRequestedDayTime(bookingParseText || String(event.body ?? ""), tz);
      if (parsed) {
        result.requestedTime = parsed;
      }
    } catch {}
  }
  if (
    !pricingOrPaymentsIntent &&
    !result.requestedTime &&
    schedulingAllowed &&
    schedulingSignals.hasDayOnlyRequest
  ) {
    const dayPart = extractDayPart(textLower);
    const dayInfo = parseDayOfWeek(textLower);
    if (dayInfo?.day) {
      const partLabel = dayPart ? ` ${dayPart}` : "";
      result.draft = `Got it — ${dayInfo.day}${partLabel} works. What time were you thinking?`;
      setDialogState(conv, "schedule_request");
    } else if (dayPart) {
      result.draft = `Got it — ${dayPart} works. What time were you thinking?`;
      setDialogState(conv, "schedule_request");
    }
  }
  if (
    !pricingOrPaymentsIntent &&
    !result.requestedTime &&
    !conv.appointment?.bookedEventId &&
    isAffirmative(event.body) &&
    conv.scheduler?.requested?.timeText
  ) {
    const requestedAt = conv.scheduler.requested.requestedAt;
    const isFresh = !requestedAt || Date.now() - new Date(requestedAt).getTime() < 36 * 60 * 60 * 1000;
    const lastHadTime =
      !!extractTimeToken(lastOutboundText) || draftHasSpecificTimes(lastOutboundText ?? "");
    if (isFresh && lastHadTime) {
      try {
        const cfg = await getSchedulerConfigHot();
        const tz = cfg.timezone || "America/New_York";
        const parsed = parseRequestedDayTime(conv.scheduler.requested.timeText, tz);
        if (parsed) {
          result.requestedTime = parsed;
        }
      } catch {}
    }
  }
  console.log("[twilio] result.suggestedSlots len:", result.suggestedSlots?.length ?? 0);
  if (
    !pricingOrPaymentsIntent &&
    (result.suggestedSlots?.length ?? 0) === 0 &&
    draftHasSpecificTimes(result.draft ?? "")
  ) {
    let requested = result.requestedTime ?? null;
    if (!requested) {
      try {
        const cfg = await getSchedulerConfigHot();
        const tz = cfg.timezone || "America/New_York";
        requested = parseRequestedDayTime(bookingParseText || String(event.body ?? ""), tz);
      } catch {}
    }
    if (requested) {
      const dayName = requested.dayOfWeek.charAt(0).toUpperCase() + requested.dayOfWeek.slice(1);
      const hh = String(requested.hour24).padStart(2, "0");
      const mm = String(requested.minute).padStart(2, "0");
      const timeText = formatTime12h(`${hh}:${mm}`);
      result.draft = `Got it. I can check ${dayName} at ${timeText}. If that doesn't work, what other time could you do?`;
    } else {
      result.draft = "What day and time works for you to stop in?";
      setDialogState(conv, "schedule_request");
    }
  }
  const flowDialogState = getDialogState(conv);
  const draftText = String(result.draft ?? "");
  if (
    !conv.appointment?.bookedEventId &&
    !isScheduleDialogState(flowDialogState) &&
    /(what time works best|what day and time works best|what time were you thinking|reserve that time)/i.test(
      draftText
    )
  ) {
    setDialogState(conv, "schedule_request");
  }
  if (
    !isTradeDialogState(flowDialogState) &&
    /(still available|in stock right now|not seeing .* in stock|checking availability)/i.test(draftText)
  ) {
    setDialogState(conv, "inventory_answered");
  }
  const canUpdatePricingState =
    !isScheduleDialogState(flowDialogState) &&
    !isTradeDialogState(flowDialogState) &&
    !isServiceDialogState(flowDialogState) &&
    flowDialogState !== "callback_requested" &&
    flowDialogState !== "callback_handoff" &&
    flowDialogState !== "call_only";
  if (result.intent === "TRADE_IN" && !isScheduleDialogState(getDialogState(conv))) {
    if (!isTradeDialogState(getDialogState(conv))) {
      const sellOption = conv.lead?.sellOption;
      if (sellOption === "cash") setDialogState(conv, "trade_cash");
      else if (sellOption === "trade") setDialogState(conv, "trade_trade");
      else if (sellOption === "either") setDialogState(conv, "trade_either");
      else setDialogState(conv, "trade_init");
    }
  }
  if (result.intent === "TEST_RIDE" && !isScheduleDialogState(getDialogState(conv))) {
    if (!isTestRideDialogState(getDialogState(conv))) {
      setDialogState(conv, "test_ride_init");
    }
  }
  if (
    !isTestRideDialogState(getDialogState(conv)) &&
    /test ride/i.test(draftText) &&
    /(what day|what time|what time works|reserve|set up|schedule)/i.test(draftText)
  ) {
    setDialogState(conv, "test_ride_offer_sent");
  }
  if (canUpdatePricingState) {
    if (result.handoff?.required) {
      if (result.handoff.reason === "payments") {
        setDialogState(conv, "payments_handoff");
      } else if (result.handoff.reason === "pricing") {
        setDialogState(conv, "pricing_handoff");
      }
    } else if (detectsModelQuestion(result.draft ?? "")) {
      setDialogState(conv, "pricing_need_model");
    } else if (detectsPricingAnswer(result.draft ?? "")) {
      setDialogState(conv, "pricing_answered");
    } else if (pricingSignal && getDialogState(conv) === "none") {
      setDialogState(conv, "pricing_init");
    }
  }
  if (result.handoff?.required) {
    const reason = result.handoff.reason;
    const dealerProfile = await getDealerProfileHot();
    const dealerName = dealerProfile?.dealerName ?? "American Harley-Davidson";
    const agentName = dealerProfile?.agentName ?? "Brooke";
    const ack = ensureUniqueDraft(result.handoff.ack, conv, dealerName, agentName);
    if (getDialogState(conv) === "callback_requested") {
      setDialogState(conv, "callback_handoff");
    }
    addTodo(conv, reason, event.body, event.providerMessageId);
    setFollowUpMode(conv, "manual_handoff", `handoff:${reason}`);
    stopFollowUpCadence(conv, "manual_handoff");
    stopRelatedCadences(conv, "manual_handoff", { setMode: "manual_handoff" });
    if (reason === "pricing" || reason === "payments") {
      markPricingEscalated(conv);
    }
    const systemMode = webhookMode;
    if (systemMode === "suggest") {
      appendOutbound(conv, event.to, event.from, ack, "draft_ai");
      const twiml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response></Response>`;
      return res.status(200).type("text/xml").send(twiml);
    }
    appendOutbound(conv, event.to, event.from, ack, "twilio");
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n  <Message>${escapeXml(
      ack
    )}</Message>\n</Response>`;
    return res.status(200).type("text/xml").send(twiml);
  }
  if (result.autoClose?.reason) {
    const dealerProfile = await getDealerProfileHot();
    const dealerName = dealerProfile?.dealerName ?? "American Harley-Davidson";
    const agentName = dealerProfile?.agentName ?? "Brooke";
    const ack = ensureUniqueDraft(result.draft, conv, dealerName, agentName);
    closeConversation(conv, result.autoClose.reason);
    stopRelatedCadences(conv, result.autoClose.reason, { close: true });
    const systemMode = webhookMode;
    if (systemMode === "suggest") {
      appendOutbound(conv, event.to, event.from, ack, "draft_ai");
      const twiml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response></Response>`;
      return res.status(200).type("text/xml").send(twiml);
    }
    appendOutbound(conv, event.to, event.from, ack, "twilio");
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n  <Message>${escapeXml(
      ack
    )}</Message>\n</Response>`;
    return res.status(200).type("text/xml").send(twiml);
  }
  if (result.pricingAttempted) {
    incrementPricingAttempt(conv);
  }
  if (!pricingOrPaymentsIntent && result.suggestedSlots && result.suggestedSlots.length > 0) {
    if (schedulingAllowed && schedulingSignals.hasDayTime && !conv.appointment?.bookedEventId) {
      let requested = result.requestedTime ?? null;
      if (!requested) {
        try {
          const cfg = await getSchedulerConfigHot();
          const tz = cfg.timezone || "America/New_York";
          requested = parseRequestedDayTime(bookingParseText || String(event.body ?? ""), tz);
        } catch {}
      }
      if (requested) {
        try {
          const cfg = await getSchedulerConfigHot();
          const tz = cfg.timezone || "America/New_York";
          const requestedStartUtc = localPartsToUtcDate(tz, requested);
          const match = result.suggestedSlots.find(s => {
            const startMs = new Date(s.start).getTime();
            return Math.abs(startMs - requestedStartUtc.getTime()) <= 60_000;
          });
          if (match) {
            const cal = await getAuthedCalendarClient();
            const salespeople = cfg.salespeople ?? [];
            const matchSp = salespeople.find((p: any) => p.id === match.salespersonId);
            const stockId = conv.lead?.vehicle?.stockId ?? null;
            const leadNameRaw = conv.lead?.name?.trim() ?? "";
            const firstName = normalizeDisplayCase(conv.lead?.firstName);
            const lastName = conv.lead?.lastName ?? "";
            const leadName =
              leadNameRaw || [firstName, lastName].filter(Boolean).join(" ").trim() || conv.leadKey;

            const appointmentType = String(match.appointmentType ?? "inventory_visit");
            const summary = `Appt: ${appointmentType} – ${leadName}${stockId ? ` – ${stockId}` : ""}`;
            const description = [
              `LeadKey: ${conv.leadKey}`,
              `Phone: ${conv.lead?.phone ?? conv.leadKey}`,
              `Email: ${conv.lead?.email ?? ""}`,
              `FirstName: ${firstName ?? ""}`,
              `LastName: ${lastName ?? ""}`,
              `Stock: ${stockId ?? ""}`,
              `VIN: ${conv.lead?.vehicle?.vin ?? ""}`,
              `Source: ${conv.lead?.source ?? ""}`,
              `VisitType: ${appointmentType}`
            ]
              .filter(Boolean)
              .join("\n");

            const colorId = getAppointmentTypeColorId(cfg, appointmentType);
            const eventObj = await insertEvent(
              cal,
              match.calendarId,
              tz,
              summary,
              description,
              match.start,
              match.end,
              colorId
            );

            conv.appointment = conv.appointment ?? { status: "none", updatedAt: new Date().toISOString() };
            conv.appointment.status = "confirmed";
            conv.appointment.whenText = match.startLocal ?? formatSlotLocal(match.start, tz);
            conv.appointment.whenIso = match.start;
            conv.appointment.confirmedBy = "customer";
            conv.appointment.updatedAt = new Date().toISOString();
            conv.appointment.acknowledged = true;
            conv.appointment.bookedEventId = eventObj.id ?? null;
            conv.appointment.bookedEventLink = eventObj.htmlLink ?? null;
            conv.appointment.bookedSalespersonId = match.salespersonId ?? null;
            onAppointmentBooked(conv);

            if (conv.scheduler) {
              conv.scheduler.lastSuggestedSlots = [];
              conv.scheduler.updatedAt = new Date().toISOString();
            }

            const dealerName =
              (conv as any).dealerProfile?.dealerName ?? "American Harley-Davidson";
            const addressLine = "1149 Erie Ave., North Tonawanda, NY 14120";
            const when = match.startLocal ?? formatSlotLocal(match.start, tz);
            const repName = matchSp?.name ? ` with ${matchSp.name}` : "";
            const confirmText =
              `Perfect — you’re booked for ${when}${repName}. ` +
              `${dealerName} is at ${addressLine}.`;
            const systemMode = webhookMode;
            if (systemMode === "suggest") {
              appendOutbound(conv, event.to, event.from, confirmText, "draft_ai", eventObj.id ?? undefined);
              saveConversation(conv);
              await flushConversationStore();
              const twiml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response></Response>`;
              return res.status(200).type("text/xml").send(twiml);
            }
            appendOutbound(conv, event.to, event.from, confirmText, "twilio", eventObj.id ?? undefined);
            const twiml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n  <Message>${escapeXml(
              confirmText
            )}</Message>\n</Response>`;
            return res.status(200).type("text/xml").send(twiml);
          }
        } catch (e: any) {
          console.log("[scheduler] suggestedSlots exact match failed:", e?.message ?? e);
        }
      }
    }
    const prefId = conv.scheduler?.preferredSalespersonId ?? null;
    if (prefId) {
      const preferred = result.suggestedSlots.filter(s => s.salespersonId === prefId);
      if (preferred.length >= 2) {
        result.suggestedSlots = preferred;
      } else if (preferred.length > 0) {
        const rest = result.suggestedSlots.filter(s => s.salespersonId !== prefId);
        result.suggestedSlots = [...preferred, ...rest];
      }
    }
    const requestedAppointmentType = String(result.requestedAppointmentType ?? "inventory_visit");
    console.log("[scheduler] persist suggestedSlots", result.suggestedSlots.length);
    setLastSuggestedSlots(conv, result.suggestedSlots);
    if (requestedAppointmentType === "test_ride") {
      setDialogState(conv, "test_ride_offer_sent");
    } else {
      setDialogState(conv, "schedule_offer_sent");
    }
    console.log(
      "[scheduler] persisted lastSuggestedSlots",
      result.suggestedSlots.length,
      "leadKey",
      conv.leadKey
    );
    saveConversation(conv);
    console.log(
      "[scheduler] flushing store path:",
      getConversationStorePath(),
      "leadKey",
      conv.leadKey
    );
    await flushConversationStore();
    console.log(
      "[scheduler] after flush lastSuggestedSlots len:",
      conv.scheduler?.lastSuggestedSlots?.length ?? 0
    );
  }
  if (result.requestedTime) {
    setRequestedTime(conv, { day: result.requestedTime.dayOfWeek, timeText: event.body });
    if (result.requestedAppointmentType === "test_ride") {
      setDialogState(conv, "test_ride_init");
    } else {
      setDialogState(conv, "schedule_request");
    }
  }

  if (schedulingAllowed && !didConfirm && result.requestedTime) {
    try {
      const skipExactBooking = /(this time|same time)/i.test(event.body);
      const cfg = await getSchedulerConfigHot();
      const appointmentTypes = cfg.appointmentTypes ?? { inventory_visit: { durationMinutes: 60 } };
      const preferredSalespeople = getPreferredSalespeopleForConv(cfg, conv);
      const salespeople = cfg.salespeople ?? [];
      const gapMinutes = cfg.minGapBetweenAppointmentsMinutes ?? 60;
      const appointmentType = String(result.requestedAppointmentType ?? "inventory_visit");
      const durationMinutes = appointmentTypes[appointmentType]?.durationMinutes ?? 60;

      const cal = await getAuthedCalendarClient();
      const now = new Date();
      const timeMin = new Date(now).toISOString();
      const timeMax = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000).toISOString();

      if (!skipExactBooking) {
        for (const salespersonId of preferredSalespeople) {
          const sp = salespeople.find((p: any) => p.id === salespersonId);
          if (!sp) continue;

          const fb = await queryFreeBusy(cal, [sp.calendarId], timeMin, timeMax, cfg.timezone);
          const busy = (fb.calendars?.[sp.calendarId]?.busy ?? []) as any;
          const expanded = expandBusyBlocks(busy, gapMinutes);

          const exact = findExactSlotForSalesperson(
            cfg,
            sp.id,
            sp.calendarId,
            result.requestedTime,
            durationMinutes,
            expanded
          );

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
              `FirstName: ${firstName ?? ""}`,
              `LastName: ${lastName ?? ""}`,
              `Stock: ${stockId ?? ""}`,
              `VIN: ${conv.lead?.vehicle?.vin ?? ""}`,
              `Source: ${conv.lead?.source ?? ""}`,
              `VisitType: ${appointmentType}`
            ]
              .filter(Boolean)
              .join("\n");

            const dealerName =
              (conv as any).dealerProfile?.dealerName ?? "American Harley-Davidson";
            const addressLine = "1149 Erie Ave., North Tonawanda, NY 14120";
            const when = formatSlotLocal(exact.start, cfg.timezone);
            const repName = sp.name ? ` with ${sp.name}` : "";
            const systemMode = webhookMode;
            const autoBookInSuggest = systemMode === "suggest" && schedulingSignals.hasDayTime;

            if (systemMode === "suggest" && !autoBookInSuggest) {
              conv.scheduler = conv.scheduler ?? { updatedAt: new Date().toISOString() };
              conv.scheduler.pendingSlot = {
                salespersonId: sp.id,
                salespersonName: sp.name,
                calendarId: sp.calendarId,
                start: exact.start,
                end: exact.end,
                startLocal: when,
                endLocal: formatSlotLocal(exact.end, cfg.timezone),
                appointmentType
              };
              conv.scheduler.updatedAt = new Date().toISOString();
              const ask = `I can do ${when}${repName}. Want me to lock that in?`;
              appendOutbound(conv, event.to, event.from, ask, "draft_ai");
              const twiml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response></Response>`;
              return res.status(200).type("text/xml").send(twiml);
            }

            const colorId = getAppointmentTypeColorId(cfg, appointmentType);
            const eventObj = await insertEvent(
              cal,
              exact.calendarId,
              cfg.timezone,
              summary,
              description,
              exact.start,
              exact.end,
              colorId
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
            onAppointmentBooked(conv);

            if (conv.scheduler) {
              conv.scheduler.lastSuggestedSlots = [];
              conv.scheduler.updatedAt = new Date().toISOString();
            }

            const confirmText =
              `Perfect — you’re booked for ${when}${repName}. ` +
              `${dealerName} is at ${addressLine}.`;

            if (systemMode === "suggest") {
              appendOutbound(conv, event.to, event.from, confirmText, "draft_ai", eventObj.id ?? undefined);
              saveConversation(conv);
              await flushConversationStore();
              const twiml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response></Response>`;
              return res.status(200).type("text/xml").send(twiml);
            }

            appendOutbound(conv, event.to, event.from, confirmText, "twilio", eventObj.id ?? undefined);

            const twiml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n  <Message>${escapeXml(
              confirmText
            )}</Message>\n</Response>`;
            return res.status(200).type("text/xml").send(twiml);
          }
        }
      }

      // exact not available -> suggest closest slots
      const candidatesByDay = generateCandidateSlots(cfg, now, durationMinutes, 14);
      const requestedStartUtc = localPartsToUtcDate(cfg.timezone, result.requestedTime);
      const requestedDayKey = result.requestedTime?.dayOfWeek ?? dayKey(requestedStartUtc, cfg.timezone);
      const requestedDayHours = cfg.businessHours?.[requestedDayKey];
      const requestedDayClosed = !requestedDayHours || !requestedDayHours.open || !requestedDayHours.close;
      const requestedDateKey = `${result.requestedTime.year}-${String(result.requestedTime.month).padStart(2, "0")}-${String(
        result.requestedTime.day
      ).padStart(2, "0")}`;
      const isSameLocalDate = (d: Date) => {
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
        const key = `${map.year}-${map.month}-${map.day}`;
        return key === requestedDateKey;
      };

      let bestSlots: any[] = [];
      for (const salespersonId of preferredSalespeople) {
        const sp = salespeople.find((p: any) => p.id === salespersonId);
        if (!sp) continue;

        const fb = await queryFreeBusy(cal, [sp.calendarId], timeMin, timeMax, cfg.timezone);
        const busy = (fb.calendars?.[sp.calendarId]?.busy ?? []) as any;
        const expanded = expandBusyBlocks(busy, gapMinutes);

        const sameDay = candidatesByDay.filter(
          d => dayKey(d.dayStart, cfg.timezone) === requestedDayKey && isSameLocalDate(d.dayStart)
        );
        const requestedDaySpecified = !!result.requestedTime?.dayOfWeek;
        const targetStart = requestedStartUtc;
        let pool = sameDay.filter(d => d.dayStart.getTime() >= targetStart.getTime());
        if (pool.length === 0 && !requestedDaySpecified) {
          pool = candidatesByDay;
        }
        if (pool.length === 0) {
          pool = sameDay;
        }

        const flat = pool.flatMap(d => d.candidates);
        const available = flat
          .filter(c => !expanded.some(b => c.start < b.end && b.start < c.end))
          .sort((a, b) => a.start.getTime() - b.start.getTime());
        const after = available.filter(c => c.start.getTime() >= requestedStartUtc.getTime());
        const before = available
          .filter(c => c.start.getTime() < requestedStartUtc.getTime())
          .sort((a, b) => b.start.getTime() - a.start.getTime());
        const picked: any[] = [];
        const tryAdd = (c: { start: Date; end: Date }) => {
          if (picked.length >= 2) return;
          const tooClose = picked.some((r: any) => {
            const rs = new Date(new Date(r.start).getTime() - gapMinutes * 60_000);
            const re = new Date(new Date(r.end).getTime() + gapMinutes * 60_000);
            return c.start < re && rs < c.end;
          });
          if (!tooClose) {
            picked.push(c);
          }
        };
        for (const c of after) tryAdd(c);
        for (const c of before) tryAdd(c);

        const mapped = picked.map(s => ({
          salespersonId: sp.id,
          salespersonName: sp.name,
          calendarId: sp.calendarId,
          start: s.start.toISOString(),
          end: s.end.toISOString(),
          startLocal: formatSlotLocal(s.start.toISOString(), cfg.timezone),
          endLocal: formatSlotLocal(s.end.toISOString(), cfg.timezone),
          appointmentType
        })).sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime());

        if (mapped.length >= 2) {
          bestSlots = mapped;
          break;
        }
      }

      if (bestSlots.length >= 2) {
        if (schedulingSignals.hasDayTime && result.requestedTime) {
          const requestedStartUtc = localPartsToUtcDate(cfg.timezone, result.requestedTime);
          const match = bestSlots.find(s => {
            const startMs = new Date(s.start).getTime();
            return Math.abs(startMs - requestedStartUtc.getTime()) <= 60_000;
          });
          if (match) {
            const matchSp = salespeople.find((p: any) => p.id === match.salespersonId);
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
              `FirstName: ${firstName ?? ""}`,
              `LastName: ${lastName ?? ""}`,
              `Stock: ${stockId ?? ""}`,
              `VIN: ${conv.lead?.vehicle?.vin ?? ""}`,
              `Source: ${conv.lead?.source ?? ""}`,
              `VisitType: ${appointmentType}`
            ]
              .filter(Boolean)
              .join("\n");

            const colorId = getAppointmentTypeColorId(cfg, appointmentType);
            const eventObj = await insertEvent(
              cal,
              match.calendarId,
              cfg.timezone,
              summary,
              description,
              match.start,
              match.end,
              colorId
            );

            conv.appointment = conv.appointment ?? { status: "none", updatedAt: new Date().toISOString() };
            conv.appointment.status = "confirmed";
            conv.appointment.whenText = match.startLocal ?? formatSlotLocal(match.start, cfg.timezone);
            conv.appointment.whenIso = match.start;
            conv.appointment.confirmedBy = "customer";
            conv.appointment.updatedAt = new Date().toISOString();
            conv.appointment.acknowledged = true;
            conv.appointment.bookedEventId = eventObj.id ?? null;
            conv.appointment.bookedEventLink = eventObj.htmlLink ?? null;
            conv.appointment.bookedSalespersonId = match.salespersonId ?? null;
            onAppointmentBooked(conv);

            if (conv.scheduler) {
              conv.scheduler.lastSuggestedSlots = [];
              conv.scheduler.updatedAt = new Date().toISOString();
            }

            const dealerName =
              (conv as any).dealerProfile?.dealerName ?? "American Harley-Davidson";
            const addressLine = "1149 Erie Ave., North Tonawanda, NY 14120";
            const when = match.startLocal ?? formatSlotLocal(match.start, cfg.timezone);
            const repName = matchSp?.name ? ` with ${matchSp.name}` : "";
            const confirmText =
              `Perfect — you’re booked for ${when}${repName}. ` +
              `${dealerName} is at ${addressLine}.`;
            const systemMode = webhookMode;
            if (systemMode === "suggest") {
              appendOutbound(conv, event.to, event.from, confirmText, "draft_ai", eventObj.id ?? undefined);
              saveConversation(conv);
              await flushConversationStore();
              const twiml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response></Response>`;
              return res.status(200).type("text/xml").send(twiml);
            }
            appendOutbound(conv, event.to, event.from, confirmText, "twilio", eventObj.id ?? undefined);
            const twiml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n  <Message>${escapeXml(
              confirmText
            )}</Message>\n</Response>`;
            return res.status(200).type("text/xml").send(twiml);
          }
        }
        setLastSuggestedSlots(conv, bestSlots);
        console.log("[scheduler] persisted lastSuggestedSlots len:", bestSlots.length);
        console.log(
          "[scheduler] persisted lastSuggestedSlots preview:",
          bestSlots.slice(0, 2).map(s => s.startLocal)
        );
        const dayName = requestedDayKey.charAt(0).toUpperCase() + requestedDayKey.slice(1);
        const requestedDaySpecified = !!result.requestedTime?.dayOfWeek;
        const sameDayHasCandidates = candidatesByDay.some(
          d => dayKey(d.dayStart, cfg.timezone) === requestedDayKey && d.candidates.length > 0
        );
        let prefix = "";
        if (requestedDaySpecified && (requestedDayClosed || !sameDayHasCandidates)) {
          const todayKey = dayKey(now, cfg.timezone);
          if (requestedDayClosed) {
            prefix = `We’re closed on ${dayName}, but`;
          } else if (todayKey === requestedDayKey) {
            prefix = "I'm booked up for the rest of today, but";
          } else {
            prefix = `I'm booked up for the rest of ${dayName}, but`;
          }
        }
        const lastOutboundTextOffer = getLastNonVoiceOutbound(conv)?.body ?? "";
        let reply = `${prefix ? `${prefix} ` : ""}I have ${bestSlots[0].startLocal} or ${bestSlots[1].startLocal} — do any of these times work?`;
        reply = applySlotOfferPolicy(conv, reply, lastOutboundTextOffer);
        if (isSlotOfferMessage(reply)) {
          const requestedAppointmentType = String(result.requestedAppointmentType ?? "inventory_visit");
          if (requestedAppointmentType === "test_ride") {
            setDialogState(conv, "test_ride_offer_sent");
          } else {
            setDialogState(conv, "schedule_offer_sent");
          }
        }
        const systemMode = webhookMode;
        if (systemMode === "suggest") {
          // Persist suggested slots before early return so the next inbound can match.
          appendOutbound(conv, event.to, event.from, reply, "draft_ai");
          saveConversation(conv);
          console.log(
            "[scheduler] saving convo before flush",
            "leadKey",
            conv.leadKey,
            "len",
            conv.scheduler?.lastSuggestedSlots?.length ?? 0
          );
          console.log("[scheduler] flushing store path:", getConversationStorePath());
          if (getConversationStorePath() !== "/home/ubuntu/throttleiq-runtime/data/conversations.json") {
            console.log(
              "[scheduler] WARN expected CONVERSATIONS_DB_PATH /home/ubuntu/throttleiq-runtime/data/conversations.json"
            );
          }
          await flushConversationStore();
          console.log(
            "[scheduler] saved lastSuggestedSlots len:",
            conv.scheduler?.lastSuggestedSlots?.length ?? 0,
            "leadKey",
            conv.leadKey
          );
          console.log(
            "[scheduler] after persist lastSuggestedSlots",
            conv.scheduler?.lastSuggestedSlots?.length ?? 0
          );
          const twiml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response></Response>`;
          return res.status(200).type("text/xml").send(twiml);
        }
        // Persist suggested slots before early return so the next inbound can match.
        appendOutbound(conv, event.to, event.from, reply, "twilio");
        saveConversation(conv);
        console.log(
          "[scheduler] saving convo before flush",
          "leadKey",
          conv.leadKey,
          "len",
          conv.scheduler?.lastSuggestedSlots?.length ?? 0
        );
        console.log("[scheduler] flushing store path:", getConversationStorePath());
        if (getConversationStorePath() !== "/home/ubuntu/throttleiq-runtime/data/conversations.json") {
          console.log(
            "[scheduler] WARN expected CONVERSATIONS_DB_PATH /home/ubuntu/throttleiq-runtime/data/conversations.json"
          );
        }
        await flushConversationStore();
        console.log(
          "[scheduler] saved lastSuggestedSlots len:",
          conv.scheduler?.lastSuggestedSlots?.length ?? 0,
          "leadKey",
          conv.leadKey
        );
        console.log(
          "[scheduler] after persist lastSuggestedSlots",
          conv.scheduler?.lastSuggestedSlots?.length ?? 0
        );
        const twiml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n  <Message>${escapeXml(
          reply
        )}</Message>\n</Response>`;
        return res.status(200).type("text/xml").send(twiml);
      }
    } catch (e: any) {
      console.log("[exact-book] failed:", e?.message ?? e);
    }
  }

  if (!result.shouldRespond) {
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response></Response>`;
    return res.status(200).type("text/xml").send(twiml);
  }

  const dealerProfile = await getDealerProfileHot();
  const dealerName = dealerProfile?.dealerName ?? "American Harley-Davidson";
  const agentName = dealerProfile?.agentName ?? "Brooke";
  const lastOutboundTextFinal = getLastNonVoiceOutbound(conv)?.body ?? "";
  let reply = ensureUniqueDraft(result.draft, conv, dealerName, agentName);
  reply = applySlotOfferPolicy(conv, reply, lastOutboundTextFinal);
  reply = applyTradePolicy(conv, reply, lastOutboundTextFinal, result.suggestedSlots);
  reply = applyPickupPolicy(conv, reply);
  reply = applyPricingPolicy(conv, reply, lastOutboundTextFinal, String(event.body ?? ""), {
    pricingActiveThisTurn: turnPrimaryIntent === "pricing_payments" || pricingSignal
  });
  reply = applyCallbackPolicy(conv, reply, lastOutboundTextFinal);
  reply = applyServicePolicy(conv, reply, lastOutboundTextFinal);
  reply = applySoftSchedulePolicy(conv, reply, String(event.body ?? ""));
  reply = stripYearPreferenceIfAnyYearSpecified(reply, String(event.body ?? ""));
  reply = stripSchedulingLanguageIfNotAsked(reply, String(event.body ?? ""));
  reply = stripAgentCallFollowupWhenCustomerWillCall(reply, String(event.body ?? ""));
  const lienHolderFallback = maybeEscalateLienHolderInfoRequest(conv, event, dealerProfile, {
    createTodo: true,
    setManualHandoff: true
  });
  if (lienHolderFallback) {
    reply = lienHolderFallback;
  }
  await seedInventoryWatchPendingFromReply(conv, event, reply);
  if (isSlotOfferMessage(reply)) {
    const requestedAppointmentType = String(result.requestedAppointmentType ?? "inventory_visit");
    if (requestedAppointmentType === "test_ride") {
      setDialogState(conv, "test_ride_offer_sent");
    } else {
      setDialogState(conv, "schedule_offer_sent");
    }
  }
  const effectiveWebhookMode = webhookMode;
  const hadOutbound = conv.messages.some(m => m.direction === "out");

  // ✅ Global behavior:
  // - suggest: store a draft, do NOT auto-send
  // - autopilot: send immediately and log as twilio (no separate draft)
  if (effectiveWebhookMode === "suggest") {
    if (result.suggestedSlots && result.suggestedSlots.length > 0) {
      console.log("[scheduler] persist suggestedSlots", result.suggestedSlots.length);
      setLastSuggestedSlots(conv, result.suggestedSlots);
      console.log(
        "[twilio] after persist lastSuggestedSlots",
        conv.scheduler?.lastSuggestedSlots?.length ?? 0
      );
      const offerSlots = parseOfferSlotsFromReply(reply);
      const asksToLock =
        /\b(lock (that|it) in|book (that|it)|schedule (that|it)|confirm (that|it)|want me to (book|lock|schedule)|should i (book|schedule)|ok to (book|schedule)|sound good to (book|schedule))\b/i.test(
          reply
        );
      if (asksToLock && offerSlots.length < 2 && conv.scheduler) {
        const pending = chooseSlotFromReply(result.suggestedSlots, reply) ?? result.suggestedSlots[0];
        if (pending) {
          conv.scheduler.pendingSlot = pending;
          conv.scheduler.updatedAt = new Date().toISOString();
        }
      }
    }
    console.log("[twilio] result.suggestedSlots len:", result.suggestedSlots?.length ?? 0);
    appendOutbound(conv, event.to, event.from, reply, "draft_ai");
    logRouteOutcome("orchestrator_draft", {
      intent: result.intent ?? "unknown"
    });
    if (result.memorySummary) {
      setMemorySummary(conv, result.memorySummary, conv.messages.length);
    }
    if (!hadOutbound) {
      await maybeStartCadence(conv, new Date().toISOString());
    }
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response></Response>`;
    return res.status(200).type("text/xml").send(twiml);
  }

  // autopilot
  if (result.suggestedSlots && result.suggestedSlots.length > 0) {
    console.log("[scheduler] persist suggestedSlots", result.suggestedSlots.length);
    setLastSuggestedSlots(conv, result.suggestedSlots);
    console.log(
      "[twilio] after persist lastSuggestedSlots",
      conv.scheduler?.lastSuggestedSlots?.length ?? 0
    );
    const offerSlots = parseOfferSlotsFromReply(reply);
    const asksToLock =
      /\b(lock (that|it) in|book (that|it)|schedule (that|it)|confirm (that|it)|want me to (book|lock|schedule)|should i (book|schedule)|ok to (book|schedule)|sound good to (book|schedule))\b/i.test(
        reply
      );
    if (asksToLock && offerSlots.length < 2 && conv.scheduler) {
      const pending = chooseSlotFromReply(result.suggestedSlots, reply) ?? result.suggestedSlots[0];
      if (pending) {
        conv.scheduler.pendingSlot = pending;
        conv.scheduler.updatedAt = new Date().toISOString();
      }
    }
  }
  appendOutbound(conv, event.to, event.from, reply, "twilio");
  logRouteOutcome("orchestrator_send", {
    intent: result.intent ?? "unknown"
  });
  if (result.memorySummary) {
    setMemorySummary(conv, result.memorySummary, conv.messages.length);
  }
  console.log("[twilio] result.suggestedSlots len:", result.suggestedSlots?.length ?? 0);
  if (
    (conv.scheduler?.lastSuggestedSlots?.length ?? 0) === 0 &&
    (!result.suggestedSlots || result.suggestedSlots.length === 0)
  ) {
    const parsed = parseOfferSlotsFromReply(reply);
    if (parsed.length >= 2) {
      setLastSuggestedSlots(conv, parsed);
      console.log(
        "[scheduler] fallback-saved offer-path slots",
        parsed.length,
        conv.leadKey
      );
    }
  }
  saveConversation(conv);
  await flushConversationStore();
  if (result.suggestedSlots && result.suggestedSlots.length > 0) {
    saveConversation(conv);
    await flushConversationStore();
    console.log(
      "[scheduler] saved offer-path slots",
      result.suggestedSlots.length,
      conv.leadKey
    );
  }
  if (!hadOutbound) {
    await maybeStartCadence(conv, new Date().toISOString());
  }

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n  <Message>${escapeXml(
    reply
  )}</Message>\n</Response>`;
  return res.status(200).type("text/xml").send(twiml);
});

app.post("/webhooks/twilio/voice", async (req, res) => {
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const signature = req.header("x-twilio-signature");
  const publicBase = process.env.PUBLIC_BASE_URL?.replace(/\/+$/, "");
  const requestUrl = publicBase
    ? `${publicBase}${req.originalUrl}`
    : `${req.protocol}://${req.get("host")}${req.originalUrl}`;
  if (authToken && signature) {
    const ok = twilio.validateRequest(authToken, signature, requestUrl, req.body);
    if (!ok) return res.status(403).json({ ok: false, error: "Invalid Twilio signature" });
  }

  const requestedCustomerRaw = String(req.query?.customer ?? "").trim();
  const inboundFromRaw = String(req.body?.From ?? "").trim();
  const inboundToRaw = String(req.body?.To ?? "").trim();
  const agentDigits = String(req.query?.agentDigits ?? "").trim();
  const agentNameRaw = String(req.query?.agentName ?? "").trim();
  const requestedCustomerPhone = normalizePhone(requestedCustomerRaw);
  const inboundFromPhone = normalizePhone(inboundFromRaw);
  const inboundToPhone = normalizePhone(inboundToRaw);
  const leadKey = String(req.query?.leadKey ?? "").trim();
  const callSid = String(req.body?.CallSid ?? "").trim();
  const from = process.env.TWILIO_FROM_NUMBER ?? "";

  const isInbound = !requestedCustomerPhone && !!inboundFromPhone && !!inboundToPhone;
  let dialTarget: string | null = requestedCustomerPhone || null;
  let callerId = from;
  if (isInbound) {
    const dealerProfile = await getDealerProfileHot();
    const dealerPhone = normalizePhone(String(dealerProfile?.phone ?? "").trim());
    if (dealerPhone && dealerPhone.startsWith("+")) {
      dialTarget = dealerPhone;
      callerId = inboundFromPhone && inboundFromPhone.startsWith("+") ? inboundFromPhone : from;
    }
  }

  const leadKeyParam = leadKey || requestedCustomerPhone || inboundFromPhone || "";
  const customerForCb = requestedCustomerPhone || inboundFromPhone || "";
  const recordingCb = `${publicBase ?? `${req.protocol}://${req.get("host")}`}/webhooks/twilio/voice/recording?leadKey=${encodeURIComponent(leadKeyParam)}${customerForCb ? `&customer=${encodeURIComponent(customerForCb)}` : ""}${callSid ? `&callSid=${encodeURIComponent(callSid)}` : ""}${agentNameRaw ? `&agentName=${encodeURIComponent(agentNameRaw)}` : ""}`;
  const statusCb = `${publicBase ?? `${req.protocol}://${req.get("host")}`}/webhooks/twilio/voice/status?leadKey=${encodeURIComponent(
    leadKeyParam
  )}${inboundFromPhone ? `&from=${encodeURIComponent(inboundFromPhone)}` : ""}${isInbound ? "&inbound=1" : ""}${callSid ? `&callSid=${encodeURIComponent(callSid)}` : ""}`;

  const response = new (twilio as any).twiml.VoiceResponse();
  if (agentDigits) {
    response.pause({ length: 1 });
    response.play({ digits: agentDigits });
    response.pause({ length: 1 });
  }
  if (dialTarget && dialTarget.startsWith("+")) {
    const dial = response.dial({
      callerId,
      answerOnBridge: true,
      timeout: 30,
      record: "record-from-answer-dual",
      recordingStatusCallback: recordingCb,
      recordingStatusCallbackEvent: ["completed"],
      statusCallback: statusCb,
      statusCallbackEvent: ["completed"],
      statusCallbackMethod: "POST"
    });
    dial.number(dialTarget);
  } else {
    response.say("We were unable to complete your call.");
  }
  return res.type("text/xml").send(response.toString());
});

app.post("/webhooks/twilio/voice/recording", async (req, res) => {
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const signature = req.header("x-twilio-signature");
  const publicBase = process.env.PUBLIC_BASE_URL?.replace(/\/+$/, "");
  const requestUrl = publicBase
    ? `${publicBase}${req.originalUrl}`
    : `${req.protocol}://${req.get("host")}${req.originalUrl}`;
  if (authToken && signature) {
    const ok = twilio.validateRequest(authToken, signature, requestUrl, req.body);
    if (!ok) return res.status(403).json({ ok: false, error: "Invalid Twilio signature" });
  }

  const leadKey = String(req.query?.leadKey ?? "").trim();
  const customerRaw = String(req.query?.customer ?? "").trim();
  const callbackCallSid = String(req.query?.callSid ?? "").trim();
  const agentName = String(req.query?.agentName ?? "").trim();
  const recordingUrl = String(req.body?.RecordingUrl ?? "").trim();
  const recordingSid = String(req.body?.RecordingSid ?? "").trim();
  const bodyCallSid = String(req.body?.CallSid ?? "").trim();

  if (!recordingUrl) {
    return res.json({ ok: false, error: "missing RecordingUrl" });
  }

  let conv = leadKey ? getConversation(leadKey) : null;
  if (!conv && callbackCallSid) {
    conv = findConversationByCallSid(callbackCallSid);
  }
  if (!conv && bodyCallSid) {
    conv = findConversationByCallSid(bodyCallSid);
  }
  if (!conv) {
    const fallbackPhone =
      customerRaw ||
      String(req.body?.To ?? "").trim() ||
      String(req.body?.From ?? "").trim();
    conv = findConversationByPhone(fallbackPhone);
  }
  if (!conv) {
    console.warn("[voice] recording skip: conversation not found", {
      leadKey,
      customerRaw,
      callbackCallSid,
      bodyCallSid
    });
    return res.json({ ok: true });
  }

  if (agentName) {
    try {
      const cfg = await getSchedulerConfigHot();
      const sp = resolveSalespersonByName(cfg, agentName);
      if (sp) {
        setPreferredSalespersonForConv(conv, sp, "voice_transcript");
      }
    } catch (err: any) {
      console.warn("[scheduler] preferred salesperson resolve failed:", err?.message ?? err);
    }
  }

  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken2 = process.env.TWILIO_AUTH_TOKEN;
  if (!accountSid || !authToken2) {
    return res.json({ ok: false, error: "missing twilio auth" });
  }

  try {
    const mp3Url = `${recordingUrl}.mp3`;
    const authHeader = `Basic ${Buffer.from(`${accountSid}:${authToken2}`).toString("base64")}`;
    const recResp = await fetch(mp3Url, {
      headers: { Authorization: authHeader }
    });
    if (!recResp.ok) {
      throw new Error(`recording fetch failed ${recResp.status}`);
    }
    const buf = Buffer.from(await recResp.arrayBuffer());
    const transcript = await transcribeRecordingMp3(buf, agentName || "Agent");
    const transcriptText = (transcript ?? "").trim();
    const noteText = transcriptText || "Not contacted.";
    const isVoicemail = transcriptText ? isLikelyVoicemailTranscript(transcriptText) : true;
    const contactedValue: "YES" | "NO" =
      transcriptText && !isVoicemail ? "YES" : "NO";
    if (noteText) {
      const summaryText = isVoicemail
        ? "Voicemail — not contacted."
        : await summarizeVoiceTranscriptWithLLM({
            transcript: transcriptText,
            lead: conv.lead ?? undefined
          });
      if (!isVoicemail) {
        maybeMarkEngagedFromCall(conv, transcriptText, {
          isVoicemail,
          messageId: recordingSid || bodyCallSid || callbackCallSid || undefined
        });
      }
      if (summaryText) {
        if (!isVoicemail) {
          const expiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();
          setVoiceContext(conv, {
            summary: summaryText,
            updatedAt: new Date().toISOString(),
            expiresAt,
            sourceMessageId: recordingSid || undefined,
            contacted: true
          });
        }
        appendOutbound(
          conv,
          "system",
          conv.leadKey,
          summaryText,
          "voice_summary",
          recordingSid || bodyCallSid || callbackCallSid || undefined
        );
        if (isVoicemail) {
          const existing = listOpenTodos().some(
            t => t.convId === conv.id && t.status === "open" && t.reason === "call"
          );
          if (!existing) {
            const label = customerRaw
              ? `Voicemail from ${customerRaw}`
              : "Voicemail received — call back.";
            addTodo(conv, "call", label, recordingSid || bodyCallSid || callbackCallSid || undefined);
          }
          pauseFollowUpCadence(
            conv,
            new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString(),
            "voicemail"
          );
        }
        if (!isVoicemail) {
          await applyPostCallSummaryActions({
            conv,
            summaryText,
            transcriptText,
            sourceMessageId: recordingSid || bodyCallSid || callbackCallSid || undefined
          });
        }
      }

      appendOutbound(
        conv,
        "voice",
        conv.leadKey,
        noteText,
        "voice_transcript",
        recordingSid || undefined
      );
      saveConversation(conv);
      await flushConversationStore();

      const leadRef = conv.lead?.leadRef;
      if (leadRef) {
        try {
          await tlpLogCustomerContact({ leadRef, note: noteText, contactedValue });
          const lastAt = conv.messages[conv.messages.length - 1]?.at;
          if (lastAt) setCrmLastLoggedAt(conv, lastAt);
        } catch (err: any) {
          const msg = `TLP log failed for leadRef ${leadRef}. Retry in TLP or update manually.`;
          addInternalQuestion(conv.id, conv.leadKey, msg);
          console.warn("[voice] TLP log failed:", err?.message ?? err);
        }
      } else {
        console.log("[voice] TLP skip: missing leadRef", { convId: conv.id });
      }
    }
    return res.json({ ok: true });
  } catch (err: any) {
    console.warn("[voice] recording handle failed:", err?.message ?? err);
    return res.json({ ok: false, error: "recording handle failed" });
  }
});

app.post("/webhooks/twilio/voice/status", async (req, res) => {
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const signature = req.header("x-twilio-signature");
  const publicBase = process.env.PUBLIC_BASE_URL?.replace(/\/+$/, "");
  const requestUrl = publicBase
    ? `${publicBase}${req.originalUrl}`
    : `${req.protocol}://${req.get("host")}${req.originalUrl}`;
  if (authToken && signature) {
    const ok = twilio.validateRequest(authToken, signature, requestUrl, req.body);
    if (!ok) return res.status(403).json({ ok: false, error: "Invalid Twilio signature" });
  }

  const leadKey = String(req.query?.leadKey ?? "").trim();
  const inbound = String(req.query?.inbound ?? "") === "1";
  const fromRaw = String(req.query?.from ?? req.body?.From ?? "").trim();
  const from = normalizePhone(fromRaw);
  const dialStatusRaw = String(req.body?.DialCallStatus ?? req.body?.CallStatus ?? "")
    .trim()
    .toLowerCase();

  if (!inbound || !leadKey) {
    return res.json({ ok: true });
  }

  const missedStatuses = new Set(["no-answer", "busy", "failed", "canceled"]);
  if (missedStatuses.has(dialStatusRaw)) {
    const conv = getConversation(leadKey) || upsertConversationByLeadKey(leadKey, "suggest");
    if (conv) {
      const hasOpenCall = listOpenTodos().some(
        t => t.convId === conv.id && t.status === "open" && t.reason === "call"
      );
      if (!hasOpenCall) {
        const label = from ? `Missed call from ${from}` : "Missed inbound call — call back.";
        addTodo(conv, "call", label, String(req.query?.callSid ?? req.body?.CallSid ?? ""));
      }
      saveConversation(conv);
      await flushConversationStore();
    }
  }
  return res.json({ ok: true });
});

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

const port = Number.parseInt(process.env.PORT ?? "3001", 10);
app.listen(port, () => {
  console.log(`✅ API listening on http://localhost:${port}`);
  console.log("   - GET    /health");
  console.log("   - GET    /settings");
  console.log("   - PATCH  /settings");
  console.log("   - POST   /crm/leads/adf/sendgrid");
  console.log("   - GET    /conversations");
  console.log("   - GET    /conversations/:id");
  console.log("   - POST   /conversations/:id/mode");
  console.log("   - POST   /conversations/:id/close");
  console.log("   - POST   /conversations/:id/reopen");
  console.log("   - POST   /conversations/:id/appointment");
  console.log("   - POST   /conversations/:id/send");
  console.log("   - GET    /todos");
  console.log("   - POST   /todos");
  console.log("   - POST   /todos/:convId/:todoId/done");
  console.log("   - GET    /suppressions");
  console.log("   - POST   /suppressions");
  console.log("   - DELETE /suppressions/:phone");
  console.log("   - POST   /crm/tlp/log-contact");
  console.log("   - POST   /webhooks/twilio");

  const keepaliveEnabled =
    (process.env.GOOGLE_KEEPALIVE_ENABLED ?? "true").toLowerCase() === "true";
  const keepaliveMinutesRaw = Number(process.env.GOOGLE_KEEPALIVE_MINUTES ?? "720");
  const keepaliveMinutes = Number.isFinite(keepaliveMinutesRaw) && keepaliveMinutesRaw >= 5
    ? keepaliveMinutesRaw
    : 720;
  if (keepaliveEnabled) {
    console.log(`[gcal] keepalive enabled (${keepaliveMinutes} min interval)`);
    const runKeepalive = async () => {
      try {
        const cal = await getAuthedCalendarClient();
        await cal.calendarList.list({ maxResults: 1 });
      } catch (err: any) {
        console.warn("[gcal] keepalive failed:", err?.message ?? err);
      }
    };
    setTimeout(runKeepalive, 10_000).unref?.();
    const interval = setInterval(runKeepalive, keepaliveMinutes * 60 * 1000);
    (interval as any).unref?.();
  }
});
