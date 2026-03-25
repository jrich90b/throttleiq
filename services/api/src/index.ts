import "dotenv/config";
import express from "express";
import cors from "cors";
import twilio from "twilio";
import multer from "multer";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import OpenAI from "openai";
import { orchestrateInbound } from "./domain/orchestrator.js";
import {
  classifySchedulingIntent,
  classifyEmpathyNeedWithLLM,
  summarizeSalespersonNoteWithLLM,
  parseBookingIntentWithLLM,
  parseIntentWithLLM,
  summarizeVoiceTranscriptWithLLM
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
  getDealerDailyForecast
} from "./domain/weather.js";
import { resolveTownNearestDealer, formatTownLabel } from "./domain/geo.js";
import { getDataDir } from "./domain/dataDir.js";
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
  FOLLOW_UP_DAY_OFFSETS,
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
  upsertConversationByLeadKey,
  appendInbound,
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
  finalizeDraftAsSent,
  discardPendingDrafts,
  addTodo,
  addCallTodoIfMissing,
  listOpenTodos,
  addInternalQuestion,
  listOpenQuestions,
  markQuestionDone,
  markTodoDone,
  deleteConversation,
  setFollowUpMode,
  incrementPricingAttempt,
  markPricingEscalated,
  getPricingAttempts,
  closeConversation,
  mergeConversationLead,
  setConversationMode,
  setContactPreference,
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
import { listContacts, updateContact, deleteContact } from "./domain/contactsStore.js";
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
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

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

function isPublicPath(pathname: string): boolean {
  return (
    pathname === "/health" ||
    pathname.startsWith("/webhooks/twilio") ||
    pathname.startsWith("/crm/leads/adf/sendgrid") ||
    pathname.startsWith("/public/booking") ||
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

async function syncSchedulerSalespeopleFromUsers() {
  const cfg = await getSchedulerConfig();
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

function inventoryItemMatchesWatch(item: any, watch: InventoryWatch): boolean {
  if (!item?.model || !watch?.model) return false;
  const itemModel = normalizeModelName(String(item.model));
  const watchModel = normalizeModelName(String(watch.model));
  if (!itemModel.includes(watchModel) && !watchModel.includes(itemModel)) return false;
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
    const keepTrim = !!watch.trim || /\b(trim|finish)\b/i.test(String(watch.color));
    const itemColor = normalizeColorBase(String(item.color ?? ""), keepTrim);
    const watchColor = normalizeColorBase(String(watch.color), keepTrim);
    if (!itemColor || !watchColor || !itemColor.includes(watchColor)) return false;
  }
  return true;
}

async function processInventoryWatchlist() {
  if (inventoryWatchRunning) return;
  inventoryWatchRunning = true;
  try {
    const items = await getInventoryFeed();
    if (!items.length) return;
    const cfg = await getSchedulerConfig();
    const tz = cfg.timezone || "America/New_York";
    const snapshot = await loadInventorySnapshot();
    const prevKeys = new Set(snapshot.items.map(i => i.key));
    const newItems = items.filter(i => {
      const key = inventoryKey(i);
      return key && !prevKeys.has(key);
    });
    await saveInventorySnapshot(items);
    if (!newItems.length) return;

    const nowIso = new Date().toISOString();
    const convs = getAllConversations();
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
        const match = newItems.find(i => inventoryItemMatchesWatch(i, watch));
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
      const reply = `Good news — we just got ${name}${colorText} in stock. Want details or a time to check it out?`;
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
    const items = await getInventoryFeed();
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

    const conv = upsertConversationByLeadKey(event.from, "suggest");
    appendInbound(conv, event);
    const history = buildHistory(conv, 20);
    const memorySummary = conv.memorySummary?.text ?? null;
    const memorySummaryShouldUpdate = shouldUpdateMemorySummary(conv);
    const dealerProfile = await getDealerProfile();
    const weatherStatus = await getDealerWeatherStatus(dealerProfile);
    const result = await orchestrateInbound(event, history, {
      appointment: conv.appointment,
      followUp: conv.followUp,
      leadSource: conv.lead?.source ?? null,
      bucket: conv.classification?.bucket ?? null,
      cta: conv.classification?.cta ?? null,
      lead: conv.lead ?? null,
      pricingAttempts: getPricingAttempts(conv),
      allowSchedulingOffer: isExplicitScheduleIntent(body),
      voiceSummary: getActiveVoiceContext(conv)?.summary ?? null,
      memorySummary,
      memorySummaryShouldUpdate,
      inventoryWatch: conv.inventoryWatch ?? null,
      inventoryWatches: conv.inventoryWatches ?? null,
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

app.get("/users", requireManager, async (_req, res) => {
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
  const role = (String(req.body?.role ?? "salesperson") as "manager" | "salesperson") ?? "salesperson";
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
    const user = await updateUser(id, {
      email: req.body?.email,
      password: req.body?.password,
      role: req.body?.role,
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

function pauseRelatedCadencesOnInbound(conv: any, event?: { from?: string }) {
  const pauseUntil = new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString();
  for (const other of getRelatedConversations(conv, event)) {
    pauseFollowUpCadence(other, pauseUntil, "cross_channel_inbound");
  }
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
    return raw;
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
    /\b(let (you|me) know|keep (you|me) posted|keep an eye out|watch for|call (you|me) if|text (you|me) if)\b.*\b(comes in|available|get one|get it|in stock|find one)\b/i;
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
        const cfg = await getSchedulerConfig();
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
  "Hi {name} — it’s {agent} again. Just wanted to see if you caught my previous message{labelClause}. Your thoughts would be appreciated when you have a moment.{extraLine}",
  "Hi {name} — if a quick walkaround video of{label} would help, I can send one. Anything you want to see?",
  "Hi {name} — are you mostly shopping or looking to come in soon? I’m happy to help either way.",
  "Quick check {name} — is{label} still the one you’re leaning toward, or are you comparing a few?",
  "If you want to stop by{labelClause}, just tell me a day that works and I’ll line it up.",
  "No rush at all {name}. If you want me to keep an eye on availability{labelClause}, just reach out.",
  "If timing is tricky {name}, just tell me what works and I’ll make it easy.",
  "Want me to hold a time for you{labelClause}? If so, which day is best?",
  "If you’d like to come by{labelClause}, I can set something up. What day works for you?",
  "Still thinking it over {name}? If you want to stop in{labelClause}, tell me a good day and I’ll take care of the rest."
];

const FOLLOW_UP_VARIANTS_WITH_SLOTS: string[] = [
  "Hi {name}, it’s {agent} again. Just wanted to see if you caught my last message{labelClause}. If you want to stop by, I have {a} or {b} open. Which works best?{extraLine}",
  "Hi {name} — {agent} again. Any thoughts on{label}? If stopping in helps, I have {a} or {b} open. Which works better?{extraLine}",
  "Hi {name}, quick follow‑up{labelClause}. If you want to take a look, {a} or {b} work on my end. Which is better for you?{extraLine}"
];

const SELL_FOLLOW_UP_VARIANTS_WITH_SLOTS: string[] = [
  "Hi {name}, it’s {agent} again. If you want a quick in‑person appraisal on {bike}, I have {a} or {b} open. Which works best?",
  "Hi {name} — {agent} again. If it helps, I can set an appraisal time for {bike}. I have {a} or {b} open. Which works better?",
  "Hi {name}, quick follow‑up on {bike}. If you want to bring it by for a quick appraisal, {a} or {b} are open. Which is better for you?"
];

const FOLLOW_UP_VARIANTS_NO_SLOTS: Record<number, string[]> = {
  0: [
    "Hi {name}, it’s {agent} again. Just wanted to see if you caught my previous message{labelClause}. Your thoughts would be appreciated when you have a moment.{extraLine}",
    "Hi {name} — {agent} again. Just wanted to see if you caught my last note{labelClause}. Let me know what you’re thinking.{extraLine}",
    "Hi {name}, quick follow‑up{labelClause}. If you want to swing by, just tell me what day works best.{extraLine}"
  ],
  1: [
    "Hi {name} — if a quick walkaround video of{label} would help, I can send one. Anything you want to see?",
    "Hi {name} — want a short walkaround video of{label}? I’m happy to send it over."
  ],
  2: [
    "Quick question {name} — are you mostly comparing a few bikes, or is{label} at the top of your list?",
    "Hi {name} — are you still leaning toward{label}, or still comparing?"
  ]
};

function pickVariant(variants: string[], seed: string): string {
  if (!variants.length) return "";
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  }
  return variants[hash % variants.length];
}

function renderFollowUpTemplate(template: string, ctx: Record<string, string>): string {
  let out = template;
  for (const [key, value] of Object.entries(ctx)) {
    out = out.replace(new RegExp(`\\{${key}\\}`, "g"), value);
  }
  return out.replace(/\s+/g, " ").trim();
}

const SELL_FOLLOW_UP_MESSAGES = [
  "Just checking in — if you'd like a quick in‑person appraisal on {bike}, I can set a time. I have {a} or {b} open. Which works best?",
  "If it’s easier, we can start with an estimate and then confirm in person. What day works for you?",
  "Still looking to sell? I can set a quick appraisal time for {bike}. What day and time works best?",
  "No rush — when you’re ready, I can line up an appraisal. Want me to hold a time?",
  "If you want, we can go over numbers and then set a quick appraisal time. What day is best for you?",
  "If you’d like to move forward, just tell me a good day to bring the bike in and I’ll line it up."
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
    `Hi ${name},\n\nJust checking in about ${label}. If you want to stop by, ${bookingLine} I’m happy to help with details in the meantime.\n\nThanks,`,
  ({ name, label, bookingLine }) =>
    `Hi ${name},\n\nIf a walkaround video or more details on ${label} would help, I can send that. ${bookingLine}\n\nThanks,`,
  ({ name, label, bookingLine, canTestRide }) =>
    `Hi ${name},\n\nThanks again for your interest in ${label}. ${canTestRide ? "If you want a test ride, I can reserve a time." : "If you want to stop by, I can reserve a time."} ${bookingLine}\n\nThanks,`,
  ({ name, label, bookingLine }) =>
    `Hi ${name},\n\nQuick question: is ${label} still at the top of your list? If you’d like to see it in person, ${bookingLine}\n\nThanks,`,
  ({ name, label, bookingLine }) =>
    `Hi ${name},\n\nJust checking in on ${label}. If you’d like to take a closer look, ${bookingLine}\n\nThanks,`,
  ({ name, label, bookingLine }) =>
    `Hi ${name},\n\nNo rush at all — if you’re still shopping for ${label}, I’m here to help. ${bookingLine}\n\nThanks,`,
  ({ name, label, bookingLine }) =>
    `Hi ${name},\n\nIf it’s easier, tell me what day works for you and I’ll take care of the rest. ${bookingLine}\n\nThanks,`,
  ({ name, label, bookingLine }) =>
    `Hi ${name},\n\nIf you want to set a time to check out ${label}, I can get that on the calendar. ${bookingLine}\n\nThanks,`,
  ({ name, label, bookingLine }) =>
    `Hi ${name},\n\nShould I hold a time for you to see ${label}? ${bookingLine}\n\nThanks,`,
  ({ name, label, bookingLine }) =>
    `Hi ${name},\n\nStill interested in taking a look at ${label}? ${bookingLine}\n\nThanks,`
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
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function normalizeColorBase(s: string, keepTrim = false): string {
  const base = normalizeColor(s);
  if (keepTrim) return base;
  return base
    .replace(/\b(chrome|black)\s+trim\b/g, "")
    .replace(/\b(trim|finish)\b/g, "")
    .replace(/\bblack\s+finish\b/g, "black")
    .replace(/\bchrome\s+finish\b/g, "chrome")
    .replace(/\s+/g, " ")
    .trim();
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
  if (!aliases || aliases.length === 0) return false;
  if (leadTrim) {
    const itemTrim = extractTrimToken(itemColor);
    if (itemTrim !== leadTrim) return false;
  }
  return aliases.some(a => item.includes(normalizeColorBase(a, !!leadTrim)));
}

function getLastInboundBody(conv: any): string | null {
  const msg = conv.messages?.slice().reverse().find((m: any) => m.direction === "in");
  return msg?.body ?? null;
}

function getLastInboundMessage(conv: any): any | null {
  const msg = conv.messages?.slice().reverse().find((m: any) => m.direction === "in");
  return msg ?? null;
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

async function canOfferTestRideForLead(lead: any, dealerProfile: any): Promise<boolean> {
  const hasLicense = lead?.hasMotoLicense;
  if (hasLicense === false) return false;
  if (!isTestRideSeason(dealerProfile, new Date())) return false;
  const model = lead?.vehicle?.model ?? lead?.vehicle?.description ?? null;
  if (!model || /full line|other/i.test(String(model))) return false;
  const year = lead?.vehicle?.year ?? null;
  return hasInventoryForModelYear({ model, year, yearDelta: 1 });
}

const HARLEY_MODELS = [
  "CVO Road Glide ST",
  "CVO Street Glide ST",
  "CVO Street Glide Limited",
  "CVO Street Glide 3",
  "CVO Street Glide 3 Limited",
  "Road Glide 3",
  "Road Glide III",
  "Road Glide Limited",
  "Street Glide Limited",
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

async function inferModelsFromText(text: string): Promise<string[]> {
  const t = text.toLowerCase();
  let candidates: string[] = [];
  try {
    const items = await getInventoryFeed();
    candidates = items.map(i => i.model).filter(Boolean) as string[];
  } catch {
    candidates = [];
  }
  candidates = Array.from(new Set([...candidates, ...HARLEY_MODELS]));
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

function getDialogState(conv: any): DialogStateName {
  return conv?.dialogState?.name ?? "none";
}

function isScheduleDialogState(name: DialogStateName): boolean {
  return (
    name === "clarify_schedule" ||
    name === "schedule_request" ||
    name === "schedule_offer_sent" ||
    name === "schedule_booked"
  );
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
  const prefId = conv?.scheduler?.preferredSalespersonId ?? null;
  if (prefId && base.includes(prefId)) {
    return [prefId, ...base.filter(id => id !== prefId)];
  }
  if (prefId && !base.includes(prefId)) {
    return [prefId, ...base];
  }
  const prefName = conv?.scheduler?.preferredSalespersonName ?? "";
  const byName = prefName ? resolveSalespersonByName(cfg, prefName) : null;
  if (byName) {
    return [byName.id, ...base.filter(id => id !== byName.id)];
  }
  return base;
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

  const inDays = t.match(/\bin\s+(\d{1,2})\s+days?\b/);
  if (inDays) {
    const days = Number(inDays[1]);
    if (!Number.isNaN(days)) {
      return { label: `in ${days} days`, until: new Date(base.getTime() + days * 24 * 60 * 60 * 1000) };
    }
  }

  const inWeeks = t.match(/\bin\s+(\d{1,2})\s+weeks?\b/);
  if (inWeeks) {
    const weeks = Number(inWeeks[1]);
    if (!Number.isNaN(weeks)) {
      return { label: `in ${weeks} weeks`, until: new Date(base.getTime() + weeks * 7 * 24 * 60 * 60 * 1000) };
    }
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

const SOFT_SCHEDULE_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;

function detectSoftVisitIntent(text: string): boolean {
  const t = String(text ?? "").toLowerCase();
  const hasTime = /\b(\d{1,2})(?::\d{2})?\s*(am|pm)\b/i.test(t);
  if (hasTime) return false;
  if (isExplicitScheduleIntent(t)) return false;
  const visitVerb =
    /\b(come|stop|swing|drop|head|drive|ride|make it|make it in|get there|come up|come down|stop by|come by|come in)\b/i;
  if (!visitVerb.test(t)) return false;
  const softQualifier =
    /\b(might|maybe|probably|try|trying|hope|hoping|plan|planning|if i can|if i could|if possible|sometime|some time|soon|eventually|later|in a few|in a couple|a couple (days|weeks)|next week|next month|this week|this weekend|weekend)\b/i;
  const dayToken =
    /\b(today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|next week|this week|this weekend|weekend|next month)\b/i;
  return visitVerb.test(t) && (softQualifier.test(t) || dayToken.test(t));
}

function detectSchedulingSignals(text: string) {
  const t = String(text ?? "").toLowerCase();
  const hasDayToken =
    /\b(today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|this week|next week|this weekend|weekend|next month)\b/i.test(
      t
    );
  const hasTimeWord = /\b(\d{1,2}):(\d{2})\s*(am|pm)?\b/i.test(t);
  const hasAtHour = /\b(?:at|for|around|by)\s*(\d{1,2})(?::\d{2})?\b(?!\s*\/)/i.test(t);
  const hasDayTime = hasDayToken && (hasTimeWord || hasAtHour);
  const softVisit = detectSoftVisitIntent(t);
  const explicit = softVisit ? false : isExplicitScheduleIntent(t);
  const hasDayOnlyAvailability =
    hasDayToken && /\b(availability|available|openings|open|time|times)\b/i.test(t);
  const hasDayOnlyRequest = !softVisit && hasDayToken && explicit && !hasDayTime;
  return { explicit, hasDayTime: softVisit ? false : hasDayTime, hasDayOnlyAvailability, hasDayOnlyRequest, softVisit };
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
  if (extractTimeToken(text)) return true;
  return /\b(first|second|earlier|later)\b/i.test(String(text ?? ""));
}

function isSlotOfferMessage(text: string): boolean {
  return /\b(do any of these times work|which works best)\b/i.test(String(text ?? ""));
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

function applyTradePolicy(
  conv: any,
  reply: string,
  lastOutboundText: string,
  suggestedSlots?: Array<{ startLocal?: string | null }>
): string {
  const state = getDialogState(conv);
  if (!state.startsWith("trade_")) return reply;
  let out = reply;
  if (state !== "trade_init") {
    out = stripTradeIntroSentence(out);
  }
  const lastInboundText = String(getLastInboundBody(conv) ?? "");
  const askedToSchedule =
    /(schedule|appointment|set (up )?a time|come (in|by)|stop (in|by)|what time|what day|when can i come|can i come|stop by)/i.test(
      lastInboundText
    );
  if (state === "trade_cash" && askedToSchedule && suggestedSlots && suggestedSlots.length >= 2) {
    if (!isSlotOfferMessage(out)) {
      const a = suggestedSlots[0]?.startLocal ?? "";
      const b = suggestedSlots[1]?.startLocal ?? "";
      if (a && b) {
        out = `I can set up a trade appraisal. I have ${a} or ${b} — do any of these times work?`;
      }
    }
  }
  const cashTradeQuestion =
    /\b(are you looking for (a )?(straight )?cash offer|cash offer|trade credit|trading toward another bike)\b/i;
  if (cashTradeQuestion.test(out)) {
    if (state === "trade_cash") {
      out =
        "Got it — for a straight cash offer, we’ll need an in‑person appraisal. Do you have any lien or payoff on the bike?";
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
      out = "If you have a model in mind, let me know — I can also set a time to stop in.";
    } else if (state === "trade_either") {
      out = "I can do either — just let me know which direction you prefer.";
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
    const callLine = "I'll have someone call you today to go over a rough idea.";
    if (!/call you today|reach out today|give you a call today/i.test(out)) {
      out = `${out} ${callLine}`.trim();
    }
  }
  return out;
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
  const sentences = reply.split(/(?<=[.!?])\s+/);
  const kept = sentences.filter(s => !schedulePhrase.test(s));
  const trimmed = kept.join(" ").trim();
  if (trimmed) return trimmed;
  return reply.replace(schedulePhrase, "").replace(/\s{2,}/g, " ").trim();
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

function isPricingText(text: string): boolean {
  return /(price|otd|out the door|payment|monthly|down|apr|term|finance|credit|quote)/i.test(String(text ?? ""));
}

function isPaymentText(text: string): boolean {
  return /(monthly payment|what would it be a month|what would it be per month|how much down|\bapr\b|term)/i.test(
    String(text ?? "")
  );
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

function detectCallbackText(text: string): boolean {
  const t = String(text ?? "").toLowerCase();
  const hasCallback =
    /(call me|call him|call her|give me a call|give (him|her) a call|reach me|reach him|reach her|contact me|can you call|can you have|please call|have .* call|tell .* i will call|i will call)/.test(
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
  return /\b(he|him|she|her)\b/.test(t) || /\b(call|reach|talk to|speak to|tell)\s+(him|her)\b/.test(t);
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

function applyPricingPolicy(conv: any, reply: string, lastOutboundText: string): string {
  const state = getDialogState(conv);
  if (!(state.startsWith("pricing_") || state === "payments_handoff" || state === "payments_answered")) {
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

function extractColorToken(text: string): string | null {
  const t = text.toLowerCase();
  const colors = [
    "vivid black",
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
    "gunship gray",
    "midnight ember"
  ];
  return colors.find(c => t.includes(c)) ?? null;
}

function extractFinishToken(text: string): "chrome" | "black" | null {
  const t = text.toLowerCase();
  if (/\bchrome(\s+(trim|finish))?\b/.test(t)) return "chrome";
  if (/\bblack(ed)?\s*(out|trim|finish)\b/.test(t) || /\bblack\s+trim\b/.test(t)) return "black";
  return null;
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
  pending: { model?: string; year?: number; color?: string }
): { action: "set" | "clarify" | "ignore"; watch?: InventoryWatch } {
  const t = text.toLowerCase();
  if (!pending.model) return { action: "ignore" };

  const similar =
    /(similar|anything like|anything similar|anything close|whatever you can find|open to similar)/.test(
      t
    );
  const mentionsPreference =
    /(exact|only|same|any|no preference|no pref|either|range|year|color)/.test(t) ||
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
  const baseColor = anyColor ? undefined : extractColorToken(t) ?? pending.color;
  const color = finish
    ? baseColor
      ? `${baseColor} ${finish} trim`
      : `${finish} trim`
    : baseColor;
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
    exactness: "model_only",
    status: "active",
    createdAt: new Date().toISOString()
  };

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

function buildInventoryWatchConfirmation(watch: InventoryWatch): string {
  const yearText = watch.year
    ? `${watch.year} `
    : watch.yearMin && watch.yearMax
      ? `${watch.yearMin}-${watch.yearMax} `
      : "";
  const colorText = watch.color ? ` in ${watch.color}` : "";
  return `Got it — I’ll keep an eye out for ${yearText}${watch.model}${colorText} and text you as soon as one comes in.`;
}

async function resolveWatchModelFromText(
  textLower: string,
  fallbackModel?: string | null
): Promise<string | null> {
  const fallback = String(fallbackModel ?? "").trim();
  try {
    const items = await getInventoryFeed();
    const inventoryModels = Array.from(new Set(items.map(i => i.model).filter(Boolean))) as string[];
    const range = extractYearRange(textLower);
    const singleYear = extractYearSingle(textLower);
    const rangeModels = range ? getModelsForYearRange(range.min, range.max) : [];
    const yearModels = !range && singleYear ? getModelsForYear(singleYear) : [];
    const allModels = !range && !singleYear ? getAllModels() : [];
    const models = Array.from(
      new Set(
        [...inventoryModels, ...rangeModels, ...yearModels, ...allModels]
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

async function processDueFollowUps() {
  const cfg = await getSchedulerConfig();
  if (cfg.enabled === false) return;
  const dealerProfile = await getDealerProfile();
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
    if (/(i('| )?ll let you know|i will let you know|i'll reach out|i will reach out|i'll get back to you|i will get back to you)/.test(t)) {
      return { indefinite: true };
    }

    const inDays = t.match(/\bin\s+(\d{1,2})\s+days?\b/);
    if (inDays) return { until: new Date(base.getTime() + Number(inDays[1]) * 24 * 60 * 60 * 1000) };

    const inWeeks = t.match(/\bin\s+(\d{1,2})\s+weeks?\b/);
    if (inWeeks) return { until: new Date(base.getTime() + Number(inWeeks[1]) * 7 * 24 * 60 * 60 * 1000) };

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
    const cadence = conv.followUpCadence;
    if (!cadence || cadence.status !== "active" || !cadence.nextDueAt) continue;
    const isPostSale = cadence.kind === "post_sale";
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
    if (todoConvIds.has(conv.id)) continue;
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
        const { until, indefinite } = parsePauseUntil(lastInbound.body, inboundAt);
        if (indefinite) continue;
        if (until && now < until) setBlockUntil(until);
        if (isMeaningfulInbound(lastInbound.body) && now.getTime() - inboundAt.getTime() < 72 * 60 * 60 * 1000) {
          setBlockUntil(new Date(inboundAt.getTime() + 72 * 60 * 60 * 1000));
        }
      }
      const lastOutbound = getLastOutbound(conv, ["human", "twilio", "sendgrid"]);
      if (lastOutbound?.at) {
        const outboundAt = new Date(lastOutbound.at);
        if (now.getTime() - outboundAt.getTime() < 72 * 60 * 60 * 1000) {
          setBlockUntil(new Date(outboundAt.getTime() + 72 * 60 * 60 * 1000));
        }
      }
      const lastDraft = getLastOutbound(conv, ["draft_ai"]);
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
      } else {
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
      extraLine
    };
    let message = FOLLOW_UP_MESSAGES[cadence.stepIndex] ?? FOLLOW_UP_MESSAGES[FOLLOW_UP_MESSAGES.length - 1];
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
          message = `Just checking in — if you want us to pick up ${
            sellBikeLabel ?? "your bike"
          } for a trade evaluation, let me know where you’re located.`;
          conv.pickup = { ...(conv.pickup ?? {}), stage: "need_town", updatedAt: nowIso() };
        } else if (pickupEligible) {
          message = `Just checking in — if the weather’s rough, we can pick up ${
            sellBikeLabel ?? "your bike"
          } for a trade evaluation. If you’d rather stop in, what day and time works for you?`;
        } else {
          message = `Just checking in — if you'd like a quick in‑person appraisal on ${
            sellBikeLabel ?? "your bike"
          }, what day and time works for you?`;
        }
      } else if (cadence.stepIndex === 0) {
        const day2 = await buildDay2Options(cfg);
        if (day2) {
          message = renderFollowUpTemplate(
            pickVariant(
              SELL_FOLLOW_UP_VARIANTS_WITH_SLOTS,
              `${conv.leadKey}|sell|${cadence.stepIndex}`
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
    } else if (cadence.stepIndex === 0) {
      const day2 = await buildDay2Options(cfg);
      if (day2) {
        message = renderFollowUpTemplate(
          pickVariant(FOLLOW_UP_VARIANTS_WITH_SLOTS, `${conv.leadKey}|${cadence.stepIndex}`),
          {
            ...baseCtx,
            a: day2.slots[0].startLocal,
            b: day2.slots[1].startLocal
          }
        );
        setLastSuggestedSlots(conv, day2.slots);
      } else {
        const variants = FOLLOW_UP_VARIANTS_NO_SLOTS[cadence.stepIndex] ?? [];
        message = variants.length
          ? renderFollowUpTemplate(pickVariant(variants, `${conv.leadKey}|${cadence.stepIndex}`), baseCtx)
          : FOLLOW_UP_MESSAGES[1];
      }
    } else if (cadence.stepIndex === 2) {
      if (canTestRideFlag) {
        message = "If you want to set up a test ride, I can hold a time. What day and time works for you?";
      } else {
        const variants = FOLLOW_UP_VARIANTS_NO_SLOTS[cadence.stepIndex] ?? [];
        message = variants.length
          ? renderFollowUpTemplate(pickVariant(variants, `${conv.leadKey}|${cadence.stepIndex}`), baseCtx)
          : FOLLOW_UP_MESSAGES[2];
      }
    } else if (FOLLOW_UP_VARIANTS_NO_SLOTS[cadence.stepIndex]) {
      const variants = FOLLOW_UP_VARIANTS_NO_SLOTS[cadence.stepIndex] ?? [];
      message = variants.length
        ? renderFollowUpTemplate(pickVariant(variants, `${conv.leadKey}|${cadence.stepIndex}`), baseCtx)
        : message;
    } else if (cadence.stepIndex >= 10) {
      const late = await buildLateFollowUp(conv, cadence.stepIndex, dealerProfile);
      message = late.body;
      mediaUrls = late.mediaUrls;
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
    if (conv.scheduleSoft && !allowProactiveSchedule) {
      message = stripSchedulingPromptFromFollowUp(message);
    }
    if (allowProactiveSchedule && conv.scheduleSoft && draftHasSchedulingPrompt(message)) {
      conv.scheduleSoft.lastAskAt = nowIso();
    }

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
        emailMessage = `Hi ${name},\n\n${message}\n\n${bookingLine}\n\nThanks,`;
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
      appendOutbound(conv, from ?? "salesperson", draftTo, draftMessage, "draft_ai", undefined, mediaUrls);
      maybeAddCallTodoForFollowUp();
      if (cadence.kind === "long_term") {
        const nowIso = new Date().toISOString();
        conv.followUpCadence = {
          status: "active",
          anchorAt: nowIso,
          nextDueAt: computeFollowUpDueAt(nowIso, FOLLOW_UP_DAY_OFFSETS[0], cfg.timezone),
          stepIndex: 0,
          kind: "standard",
          lastSentAt: nowIso,
          lastSentStep: -1
        };
      } else {
        advanceFollowUpCadence(conv, cfg.timezone);
      }
      continue;
    }

    if (useEmail) {
      if (!emailFrom) {
        const fallbackMessage = emailMessage ?? message;
        appendOutbound(conv, "salesperson", emailTo!, fallbackMessage, "human", undefined, mediaUrls);
        maybeAddCallTodoForFollowUp();
      } else {
        try {
        const dealerName = dealerProfile?.dealerName ?? "Dealership";
        const subject = `Follow-up from ${dealerName}`;
        const body = emailMessage ?? message;
        const signed =
          signature
            ? `${body}\n\n${signature}${dealerProfile?.logoUrl ? `\n\n${dealerProfile.logoUrl}` : ""}`
            : body;
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
      if (cadence.kind === "long_term") {
        const nowIso = new Date().toISOString();
        conv.followUpCadence = {
          status: "active",
          anchorAt: nowIso,
          nextDueAt: computeFollowUpDueAt(nowIso, FOLLOW_UP_DAY_OFFSETS[0], cfg.timezone),
          stepIndex: 0,
          kind: "standard",
          lastSentAt: nowIso,
          lastSentStep: -1
        };
      } else {
        advanceFollowUpCadence(conv, cfg.timezone);
      }
      continue;
    }

    if (!from || !accountSid || !authToken || !to.startsWith("+")) {
      appendOutbound(conv, "salesperson", to, message, "human", undefined, mediaUrls);
      maybeAddCallTodoForFollowUp();
      if (cadence.kind === "long_term") {
        const nowIso = new Date().toISOString();
        conv.followUpCadence = {
          status: "active",
          anchorAt: nowIso,
          nextDueAt: computeFollowUpDueAt(nowIso, FOLLOW_UP_DAY_OFFSETS[0], cfg.timezone),
          stepIndex: 0,
          kind: "standard",
          lastSentAt: nowIso,
          lastSentStep: -1
        };
      } else {
        advanceFollowUpCadence(conv, cfg.timezone);
      }
      continue;
    }

    try {
      const client = twilio(accountSid, authToken);
      const msg = await client.messages.create({
        from,
        to,
        body: message,
        ...(mediaUrls && mediaUrls.length ? { mediaUrl: mediaUrls } : {})
      });
      appendOutbound(conv, from, to, message, "twilio", msg.sid, mediaUrls);
      maybeAddCallTodoForFollowUp();
      if (cadence.kind === "long_term") {
        const nowIso = new Date().toISOString();
        conv.followUpCadence = {
          status: "active",
          anchorAt: nowIso,
          nextDueAt: computeFollowUpDueAt(nowIso, FOLLOW_UP_DAY_OFFSETS[0], cfg.timezone),
          stepIndex: 0,
          kind: "standard",
          lastSentAt: nowIso,
          lastSentStep: -1
        };
      } else {
        advanceFollowUpCadence(conv, cfg.timezone);
      }
    } catch (e: any) {
      console.log("[followup] send failed:", e?.message ?? e);
    }
  }
}

async function processAppointmentConfirmations() {
  const cfg = await getSchedulerConfig();
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

    appt.confirmation = {
      sentAt: new Date().toISOString(),
      status: "pending"
    };

    if (systemMode === "suggest") {
      appendOutbound(conv, from ?? "salesperson", toNumber, message, "draft_ai");
    } else if (from && accountSid && authToken && toNumber.startsWith("+")) {
      try {
        const client = twilio(accountSid, authToken);
        const msg = await client.messages.create({ from, to: toNumber, body: message });
        appendOutbound(conv, from, toNumber, message, "twilio", msg.sid);
      } catch (e: any) {
        console.log("[appt-confirm] send failed:", e?.message ?? e);
        continue;
      }
    } else {
      appendOutbound(conv, "salesperson", toNumber, message, "human");
    }
  }
}

async function processAppointmentQuestions() {
  const cfg = await getSchedulerConfig();
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
  if (conv.followUpCadence?.status === "active" || conv.followUpCadence?.status === "stopped") return;
  const cfg = await getSchedulerConfig();
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
  const cfg = await getSchedulerConfig();
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
  const cfg = await getSchedulerConfig();
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
  const profile = await getDealerProfile();
  const token = extractBookingToken(req);
  const expected = getBookingToken(profile);
  if (!token || !expected || token !== expected) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }
  const cfg = await getSchedulerConfig();
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
  const profile = await getDealerProfile();
  const token = extractBookingToken(req);
  const expected = getBookingToken(profile);
  if (!token || !expected || token !== expected) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }

  const cfg = await getSchedulerConfig();
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
  const profile = await getDealerProfile();
  const token = extractBookingToken(req);
  const expected = getBookingToken(profile);
  if (!token || !expected || token !== expected) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }

  const cfg = await getSchedulerConfig();
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
  const profile = await getDealerProfile();
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
    const cfg = await getSchedulerConfig();
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
    res.json({ ok: true, event: updated });
  } catch (err: any) {
    console.log("[calendar edit] error", err?.message ?? err);
    res.status(500).json({ ok: false, error: err?.message ?? "Failed to update event" });
  }
});

app.post("/scheduler/calendars", requireManager, async (req, res) => {
  const name = String(req.body?.name ?? "").trim();
  if (!name) return res.status(400).json({ ok: false, error: "Missing name" });
  const cfg = await getSchedulerConfig();
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
  const cfg = await getSchedulerConfig();
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
  const cfg = await getSchedulerConfig();
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
  const cfg = await getSchedulerConfig();
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
  const profile = await getDealerProfile();
  res.json({ ok: true, profile });
});

app.get("/dealer-profile", async (_req, res) => {
  const profile = await getDealerProfile();
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

  const profile = (await getDealerProfile()) ?? {};
  const publicBase = process.env.PUBLIC_BASE_URL ?? "";
  const url = publicBase
    ? `${publicBase.replace(/\/$/, "")}/uploads/${fileName}`
    : `/uploads/${fileName}`;
  const saved = await saveDealerProfile({ ...profile, logoUrl: url });
  res.json({ ok: true, profile: saved, url });
});

app.put("/dealer-profile", requireManager, async (req, res) => {
  console.log("[dealer-profile] save start");
  const saved = await saveDealerProfile(req.body ?? {});
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
app.get("/conversations", (_req, res) => {
  res.json({ ok: true, systemMode: getSystemMode(), conversations: listConversations() });
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
    const cfg = await getSchedulerConfig();
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

    const cfg = await getSchedulerConfig();
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
    const cfg = await getSchedulerConfig();
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
          const watch: InventoryWatch = {
            model,
            year,
            make: String(item?.make ?? "").trim() || undefined,
            trim: String(item?.trim ?? "").trim() || undefined,
            color: String(item?.color ?? "").trim() || undefined,
            condition: normalizeInputCondition(item?.condition),
            note: watchNote || undefined,
            exactness: "model_only",
            status: "active",
            createdAt
          };
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
    const cfg = await getSchedulerConfig();
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

    const watchList: InventoryWatch[] = items
      .map((item: any) => {
        const model = String(item?.model ?? "").trim();
        if (!model) return null;
        const yearMin =
          Number(String(item?.yearMin ?? "").trim()) || undefined;
        const yearMax =
          Number(String(item?.yearMax ?? "").trim()) || undefined;
        const parsedYear = parseYearInput(item?.year);
        const year = parsedYear.year;
        const watch: InventoryWatch = {
          model,
          year,
          yearMin: parsedYear.yearMin ?? yearMin,
          yearMax: parsedYear.yearMax ?? yearMax,
          make: String(item?.make ?? "").trim() || undefined,
          trim: String(item?.trim ?? "").trim() || undefined,
          color: String(item?.color ?? "").trim() || undefined,
          condition: normalizeInputCondition(item?.condition),
          note: note || undefined,
          exactness: "model_only",
          status: "active",
          createdAt: nowIso
        };
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
    const nowIso = new Date().toISOString();
    const cfg = await getSchedulerConfig();
    const tz = cfg.timezone || "America/New_York";

    conv.inventoryWatch = undefined;
    conv.inventoryWatches = undefined;
    conv.inventoryWatchPending = undefined;
    if (conv.followUp?.mode === "holding_inventory") {
      setFollowUpMode(conv, "active", "inventory_watch_clear");
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

    conv.updatedAt = nowIso;
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

app.get("/todos", requirePermission("canAccessTodos"), (_req, res) => {
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
  const todos = listOpenTodos().map(t => {
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
  const allowedReasons: Array<
    "pricing" | "payments" | "approval" | "manager" | "service" | "call" | "note" | "other"
  > = ["pricing", "payments", "approval", "manager", "service", "call", "note", "other"];
  const reason = allowedReasons.includes(reasonRaw as any)
    ? (reasonRaw as any)
    : "other";
  const task = addTodo(conv, reason, summary);
  saveConversation(conv);
  return res.json({ ok: true, todo: task, conversation: conv });
});

app.post("/todos/:convId/:todoId/done", requirePermission("canAccessTodos"), (req, res) => {
  const { convId, todoId } = req.params;
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
    const cfg = await getSchedulerConfig();
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

app.get("/contacts", (_req, res) => {
  function extractInquiry(body?: string): string | undefined {
    if (!body) return undefined;
    const idx = body.toLowerCase().lastIndexOf("inquiry:");
    if (idx === -1) return undefined;
    return body.slice(idx + "inquiry:".length).trim() || undefined;
  }

  const contacts = listContacts().map(c => {
    const convId = c.conversationId ?? c.leadKey;
    const conv = convId ? getConversation(convId) : null;
    const archived = !!(conv?.status === "closed" || conv?.closedAt);
    const suppressed = c.phone ? isSuppressed(c.phone) : c.leadKey ? isSuppressed(c.leadKey) : false;
    const status = suppressed ? "suppressed" : archived ? "archived" : "active";
    const lastAdf = conv?.messages
      ?.slice()
      .reverse()
      .find(m => m.direction === "in" && m.provider === "sendgrid_adf");
    const inquiry = extractInquiry(lastAdf?.body);
    return {
      ...c,
      stockId: c.stockId ?? conv?.lead?.vehicle?.stockId,
      vin: c.vin ?? conv?.lead?.vehicle?.vin,
      year: c.year ?? conv?.lead?.vehicle?.year,
      vehicle: c.vehicle ?? conv?.lead?.vehicle?.model,
      vehicleDescription:
        c.vehicleDescription ?? conv?.lead?.vehicle?.description ?? conv?.lead?.vehicle?.model,
      inquiry: c.inquiry ?? inquiry,
      status
    };
  });
  res.json({ ok: true, contacts });
});

app.patch("/contacts/:id", (req, res) => {
  const updated = updateContact(req.params.id, req.body ?? {});
  if (!updated) return res.status(404).json({ ok: false, error: "Not found" });
  const convId = updated.conversationId ?? updated.leadKey ?? "";
  const conv = convId ? getConversation(convId) : null;
  if (conv) {
    updateConversationContact(conv, {
      phone: updated.phone,
      email: updated.email,
      firstName: updated.firstName,
      lastName: updated.lastName,
      name: updated.name
    });
    saveConversation(conv);
  }
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

// ✅ Control-panel "send" (still log-only for now)
app.post("/conversations/:id/send", async (req, res) => {
  const conv = getConversation(req.params.id);
  if (!conv) return res.status(404).json({ ok: false, error: "Not found" });

  const user = (req as any).user ?? null;
  const body = String(req.body?.body ?? "").trim();
  if (!body) return res.status(400).json({ ok: false, error: "Missing body" });

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
  const mediaUrls = draft?.mediaUrls && draft.mediaUrls.length ? draft.mediaUrls : undefined;

  let schedulerTimezone = "America/New_York";
  try {
    const cfg = await getSchedulerConfig();
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
  const hasOpenNonCallTodo = () =>
    listOpenTodos().some(t => t.convId === conv.id && t.reason !== "call");

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

  if (wantsEmail) {
    if (!emailOptInOk) {
      return res.status(400).json({
        ok: false,
        error: "email opt-in not present for this lead",
        conversation: conv
      });
    }
    const dealerProfile = await getDealerProfile();
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
    const signed =
      signature
        ? `${body}\n\n${signature}${dealerProfile?.logoUrl ? `\n\n${dealerProfile.logoUrl}` : ""}`
        : body;
    const hadOutbound = conv.messages.some(m => m.direction === "out");
    const fin = finalizeDraftAsSent(conv, draftId, signed, "sendgrid");
    if (!fin.usedDraft) {
      appendOutbound(conv, emailFrom, emailTo!, signed, "sendgrid");
    }
    try {
      await sendEmail({
        to: emailTo!,
        subject,
        text: signed,
        from: emailFrom,
        replyTo
      });
      // Clear stored email draft so the UI doesn't keep pre-filling after send.
      delete conv.emailDraft;
      saveConversation(conv);
      await flushConversationStore();
      if (!hadOutbound) {
        await maybeStartCadence(conv, new Date().toISOString());
      }
      applyManualCadenceAdvance(hadOutbound);
      if (!hasOpenNonCallTodo()) {
        pauseFollowUpCadence(conv, new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(), "manual_outbound");
      }
      if (manualTakeover && !fin.usedDraft) setConversationMode(conv.id, "human");
      markAppointmentAcknowledged(conv);
      await logRow(null);
      await maybeLogTlp();
      return res.json({ ok: true, conversation: conv });
    } catch (err: any) {
      console.warn("[email] send failed:", err?.message ?? err);
      return res.status(500).json({ ok: false, error: "email send failed", conversation: conv });
    }
  }

  if (!to.startsWith("+")) {
    // Not a phone number; still log as human note so it isn't lost
    const hadOutbound = conv.messages.some(m => m.direction === "out");
    const fin = finalizeDraftAsSent(conv, draftId, body, "human");
    if (!fin.usedDraft) {
      appendOutbound(conv, "salesperson", conv.leadKey, body, "human", undefined, mediaUrls);
    }
    if (!hadOutbound) {
      await maybeStartCadence(conv, new Date().toISOString());
    }
    applyManualCadenceAdvance(hadOutbound);
    if (!hasOpenNonCallTodo()) {
      pauseFollowUpCadence(conv, new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(), "manual_outbound");
    }
    if (manualTakeover && !fin.usedDraft) setConversationMode(conv.id, "human");
    markAppointmentAcknowledged(conv);
    await logRow(null);
    await maybeLogTlp();
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
    const hadOutbound = conv.messages.some(m => m.direction === "out");
    const fin = finalizeDraftAsSent(conv, draftId, body, "human");
    if (!fin.usedDraft) {
      appendOutbound(conv, "salesperson", to, body, "human", undefined, mediaUrls);
    }
    if (!hadOutbound) {
      await maybeStartCadence(conv, new Date().toISOString());
    }
    applyManualCadenceAdvance(hadOutbound);
    if (!hasOpenNonCallTodo()) {
      pauseFollowUpCadence(conv, new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(), "manual_outbound");
    }
    if (manualTakeover && !fin.usedDraft) setConversationMode(conv.id, "human");
    markAppointmentAcknowledged(conv);
    await logRow(null);
    await maybeLogTlp();
    return res.status(500).json({
      ok: false,
      error: "Twilio credentials not configured (TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN/TWILIO_FROM_NUMBER)",
      conversation: conv
    });
  }

  try {
    const client = twilio(accountSid, authToken);
    const msg = await client.messages.create({
      from,
      to,
      body,
      ...(mediaUrls && mediaUrls.length ? { mediaUrl: mediaUrls } : {})
    });

    // Log as truly sent via Twilio (store SID)
    const hadOutbound = conv.messages.some(m => m.direction === "out");
    const fin = finalizeDraftAsSent(conv, draftId, body, "twilio", msg.sid);
    if (!fin.usedDraft) {
      appendOutbound(conv, from, to, body, "twilio", msg.sid, mediaUrls);
    }
    if (!hadOutbound) {
      await maybeStartCadence(conv, new Date().toISOString());
    }
    applyManualCadenceAdvance(hadOutbound);
    if (!hasOpenNonCallTodo()) {
      pauseFollowUpCadence(conv, new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(), "manual_outbound");
    }
    if (manualTakeover && !fin.usedDraft) setConversationMode(conv.id, "human");
    markAppointmentAcknowledged(conv);
    await logRow(msg.sid);
    await maybeLogTlp();

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
    if (!hadOutbound) {
      await maybeStartCadence(conv, new Date().toISOString());
    }
    applyManualCadenceAdvance(hadOutbound);
    if (!hasOpenNonCallTodo()) {
      pauseFollowUpCadence(conv, new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(), "manual_outbound");
    }
    if (manualTakeover && !fin.usedDraft) setConversationMode(conv.id, "human");
    markAppointmentAcknowledged(conv);
    await logRow(null);

    return res.status(502).json({
      ok: false,
      sent: false,
      error: "Twilio send failed",
      details: String(err?.message ?? err),
      conversation: conv
    });
  }
});

app.post("/conversations/:id/regenerate", async (req, res) => {
  const conv = getConversation(req.params.id);
  if (!conv) return res.status(404).json({ ok: false, error: "Not found" });
  if (conv.mode === "human") {
    return res.status(400).json({ ok: false, error: "human_override" });
  }

  const channel =
    req.body?.channel === "email" ? "email" : req.body?.channel === "sms" ? "sms" : "sms";
  const inboundMessages = [...(conv.messages ?? [])].reverse().filter(m => m.direction === "in");
  const inbound =
    inboundMessages.find(m => m.provider !== "sendgrid_adf" && m.body) ??
    inboundMessages.find(m => m.body);
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
    providerMessageId: inbound.providerMessageId ?? `regen_${Date.now()}`,
    receivedAt: inbound.at ?? new Date().toISOString()
  };

  const history = buildHistory(conv, 20);
  const memorySummary = conv.memorySummary?.text ?? null;
  const memorySummaryShouldUpdate = shouldUpdateMemorySummary(conv);
  const dealerProfile = await getDealerProfile();
  const weatherStatus = await getDealerWeatherStatus(dealerProfile);

  const usersForMentions = await listUsers();
  let mentionedUser = findMentionedUser(event.body ?? "", usersForMentions);
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
    discardPendingDrafts(conv);
    appendOutbound(conv, event.to, event.from, reply, "draft_ai");
    saveConversation(conv);
    return res.json({ ok: true, conversation: conv, draft: reply });
  }

  const result = await orchestrateInbound(event, history, {
    appointment: conv.appointment,
    followUp: conv.followUp,
    leadSource: conv.lead?.source ?? null,
    bucket: conv.classification?.bucket ?? null,
    cta: conv.classification?.cta ?? null,
    lead: conv.lead ?? null,
    pricingAttempts: getPricingAttempts(conv),
    allowSchedulingOffer: isExplicitScheduleIntent(event.body),
    voiceSummary: getActiveVoiceContext(conv)?.summary ?? null,
    memorySummary,
    memorySummaryShouldUpdate,
    inventoryWatch: conv.inventoryWatch ?? null,
    inventoryWatches: conv.inventoryWatches ?? null,
    hold: conv.hold ?? null,
    sale: conv.sale ?? null,
    pickup: conv.pickup ?? null,
    weather: weatherStatus ?? null
  });

  if (!result?.draft || result.shouldRespond === false) {
    return res.json({ ok: true, conversation: conv, skipped: true });
  }

  if (result.pickupUpdate) {
    conv.pickup = { ...(conv.pickup ?? {}), ...result.pickupUpdate, updatedAt: nowIso() };
  }

  const dealerName = dealerProfile?.dealerName ?? "American Harley-Davidson";
  const agentName = dealerProfile?.agentName ?? "Brooke";
  const lastOutboundTextFinal = getLastNonVoiceOutbound(conv)?.body ?? "";
  let reply = ensureUniqueDraft(result.draft, conv, dealerName, agentName);
  reply = applySlotOfferPolicy(conv, reply, lastOutboundTextFinal);
  reply = applyTradePolicy(conv, reply, lastOutboundTextFinal, result.suggestedSlots);
  reply = applyPickupPolicy(conv, reply);
  reply = applyPricingPolicy(conv, reply, lastOutboundTextFinal);
  reply = applyCallbackPolicy(conv, reply, lastOutboundTextFinal);
  reply = applyServicePolicy(conv, reply, lastOutboundTextFinal);
  reply = applySoftSchedulePolicy(conv, reply, String(event.body ?? ""));
  reply = stripSchedulingLanguageIfNotAsked(reply, String(event.body ?? ""));
  reply = stripNonAdfThanks(reply, event.provider);
  reply = stripCallTimingQuestions(reply);
  reply = stripNonAdfThanks(reply, provider);
  reply = stripNonAdfThanks(reply, event.provider);
  reply = stripCallTimingQuestions(reply);
  if (isSlotOfferMessage(reply)) {
    setDialogState(conv, "schedule_offer_sent");
  }
  if (result.suggestedSlots && result.suggestedSlots.length > 0) {
    setLastSuggestedSlots(conv, result.suggestedSlots);
  }
  if (result.memorySummary) {
    setMemorySummary(conv, result.memorySummary, conv.messages.length);
  }

  discardPendingDrafts(conv);
  appendOutbound(conv, event.to, event.from, reply, "draft_ai");
  saveConversation(conv);
  return res.json({ ok: true, conversation: conv });
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

  const dealerProfile = await getDealerProfile();
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
    const cfg = await getSchedulerConfig();
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

  const { From, To, Body, MessageSid, SmsSid } = req.body ?? {};

  const fromRaw = String(From ?? "").trim();
  const toRaw = String(To ?? "").trim();
  const from = normalizePhone(fromRaw);
  const to = normalizePhone(toRaw);

  const event: InboundMessageEvent = {
    channel: "sms",
    provider: "twilio",
    from,
    to,
    body: String(Body ?? ""),
    providerMessageId: String(MessageSid ?? SmsSid ?? ""),
    receivedAt: new Date().toISOString()
  };

  console.log("[twilio inbound]", event);

  const conv = upsertConversationByLeadKey(event.from, "suggest");
  appendInbound(conv, event);
  pauseRelatedCadencesOnInbound(conv, event);
  if (getDialogState(conv) === "none" && conv.classification?.bucket === "inventory_interest") {
    setDialogState(conv, "inventory_init");
  }
  let didConfirm = false;
  if (conv.contactPreference === "call_only") {
    if (isOptOut(event.body)) {
      await suppressRelatedPhones(conv, event, "sms_stop", "twilio");
      stopFollowUpCadence(conv, "opt_out");
      stopRelatedCadences(conv, "opt_out");
    } else if (isNotInterested(event.body)) {
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
  if (isOptOut(event.body)) {
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
  if (isNotInterested(event.body)) {
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

  if (isCallOnlyText(event.body)) {
    setContactPreference(conv, "call_only");
    setDialogState(conv, "call_only");
    addTodo(conv, "other", event.body ?? "Call only requested", event.providerMessageId);
    setFollowUpMode(conv, "manual_handoff", "call_only");
    stopFollowUpCadence(conv, "manual_handoff");
    stopRelatedCadences(conv, "manual_handoff", { setMode: "manual_handoff" });
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response></Response>`;
    return res.status(200).type("text/xml").send(twiml);
  }

  if (isVideoRequest(event.body)) {
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

  const isServiceLead =
    conv.classification?.bucket === "service" || conv.classification?.cta === "service_request";
  if (isServiceLead) {
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

  const deferIndefinitely = /i('| )?ll let you know|i will let you know|i('| )?ll get back to you|i will get back to you|reach out when i can/i.test(
    event.body ?? ""
  );
  if (deferIndefinitely) {
    stopFollowUpCadence(conv, "customer_deferred");
    setFollowUpMode(conv, "paused_indefinite", "customer_deferred");
    const reply = "Sounds good — I’ll be here when you’re ready.";
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
          const cfg = await getSchedulerConfig();
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
          const cfg = await getSchedulerConfig();
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
        const cfg = await getSchedulerConfig();
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
          const cfg = await getSchedulerConfig();
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
          const cfg = await getSchedulerConfig();
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
    const cfg = await getSchedulerConfig();
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
      reschedulePending || reschedulePhrase || !!requestedReschedule || isExplicitScheduleIntent(event.body);
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

  // Reschedule flow: if they pick one of our suggested slots, update the existing event
  if (
    didConfirm &&
    conv.appointment?.matchedSlot &&
    conv.appointment.bookedEventId &&
    conv.appointment.reschedulePending
  ) {
    try {
      const cfg = await getSchedulerConfig();
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
      const cfg = await getSchedulerConfig();
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
      setDialogState(conv, "schedule_booked");

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
  const outboundHoldNotice =
    lastOutbound?.body &&
    /(on hold|hold with deposit|deposit|sale pending|pending|sold|already sold)/i.test(lastOutbound.body);
  const textLower = String(event.body ?? "").toLowerCase();
  const schedulingSignalsBase = detectSchedulingSignals(event.body);
  const leadSourceText = String(conv.lead?.source ?? "").toLowerCase();
  const isTradeLead =
    /sell my bike/.test(leadSourceText) ||
    /trade[-\s]?in|trade accelerator/.test(leadSourceText) ||
    conv.classification?.cta === "sell_my_bike" ||
    conv.classification?.bucket === "trade_in_sell";
  const isSellMyBikeLead = /sell my bike/.test(leadSourceText) || conv.classification?.cta === "sell_my_bike";
  if (event.provider === "twilio" && isTradeLead) {
    const townMention = extractTownFromMessage(event.body ?? "");
    if (townMention && !conv.pickup?.town) {
      const dealerProfile = await getDealerProfile();
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
  if (
    getDialogState(conv) === "none" &&
    !isScheduleDialogState(getDialogState(conv)) &&
    !isTradeDialogState(getDialogState(conv)) &&
    isPricingText(event.body ?? "")
  ) {
    setDialogState(conv, "pricing_init");
  }
  const shortAck =
    /^(ok|okay|k|kk|thanks|thank you|got it|will do|sounds good|sounds great|appreciate it|cool)\b/i.test(
      (event.body ?? "").trim()
    );
  const recentHistory = buildHistory(conv, 6);
  const bookingParserEligible =
    event.provider === "twilio" &&
    process.env.LLM_ENABLED === "1" &&
    process.env.LLM_BOOKING_PARSER_ENABLED === "1" &&
    !!process.env.OPENAI_API_KEY &&
    schedulingAllowed;
  const bookingParserHint =
    !!conv.scheduler?.lastSuggestedSlots?.length ||
    draftHasSpecificTimes(lastOutboundText) ||
    /\b(schedule|book|appt|appointment|stop in|stop by|come in|visit|time|times|available|availability|today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i.test(
      textLower
    );
  const bookingParse =
    bookingParserEligible && bookingParserHint && !shortAck
      ? await parseBookingIntentWithLLM({
          text: event.body,
          history: recentHistory,
          lastSuggestedSlots: conv.scheduler?.lastSuggestedSlots,
          appointment: conv.appointment
        })
      : null;
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

  const intentParserEligible =
    event.provider === "twilio" &&
    process.env.LLM_ENABLED === "1" &&
    process.env.LLM_INTENT_PARSER_ENABLED === "1" &&
    !!process.env.OPENAI_API_KEY;
  const intentParserHint =
    /\b(call|phone|callback|call me|give me a call|reach me|test ride|demo|demo ride|ride it|take .* ride|available|availability|in stock|still there)\b/i.test(
      textLower
    );
  const intentParse =
    intentParserEligible && intentParserHint && !shortAck
      ? await parseIntentWithLLM({
          text: event.body,
          history: recentHistory,
          lead: conv.lead
        })
      : null;
  if (process.env.DEBUG_INTENT_PARSER === "1" && intentParse) {
    console.log("[llm-intent-parse]", {
      intent: intentParse.intent,
      explicitRequest: intentParse.explicitRequest,
      confidence: intentParse.confidence,
      availability: intentParse.availability,
      callback: intentParse.callback
    });
  }
  const intentConfidence =
    typeof intentParse?.confidence === "number" ? intentParse.confidence : 0;
  const intentConfidenceMin = Number(process.env.LLM_INTENT_CONFIDENCE_MIN ?? 0.75);
  const intentAccepted = !!intentParse?.explicitRequest && intentConfidence >= intentConfidenceMin;
  const intentLow =
    !!intentParse?.explicitRequest && intentConfidence > 0 && intentConfidence < intentConfidenceMin;
  const llmCallbackRequested = intentAccepted && intentParse?.intent === "callback";
  const callbackRequestedOverride = llmCallbackRequested || detectCallbackText(event.body ?? "");
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
    const dealerProfile = await getDealerProfile();
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
      !!llmTestRideIntent,
    hasDayTime: schedulingSignalsBase.hasDayTime || llmHasDayTime,
    hasDayOnlyAvailability:
      schedulingSignalsBase.hasDayOnlyAvailability || llmHasDayOnlyAvailability,
    hasDayOnlyRequest: schedulingSignalsBase.hasDayOnlyRequest || llmHasDayOnlyRequest
  };
  if (schedulingSignalsBase.softVisit) {
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
  if (schedulingSignals.explicit || schedulingSignals.hasDayTime) {
    if (conv.scheduleSoft) {
      conv.scheduleSoft = undefined;
    }
  }
  if (callbackRequestedOverride && !isScheduleDialogState(getDialogState(conv))) {
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
    const cfg = await getSchedulerConfig();
    const dealerProfile = await getDealerProfile();
    const country = dealerProfile?.address?.country ?? null;
    const dayRequest = extractDayRequest(textLower);
    const hoursLine = formatBusinessHoursForReply(cfg.businessHours, country);
    let reply = "Our hours vary by day. What day are you thinking?";
    if (dayRequest) {
      const dayHours = cfg.businessHours?.[dayRequest];
      if (dayHours?.open && dayHours?.close) {
        const open = formatTime12h(dayHours.open);
        const close = formatTime12h(dayHours.close);
        const dayLabel = dayRequest.replace(/^\w/, c => c.toUpperCase());
        reply = `Our hours on ${dayLabel} are ${open}–${close}.`;
      } else {
        const dayLabel = dayRequest.replace(/^\w/, c => c.toUpperCase());
        reply = `We’re closed on ${dayLabel}.`;
      }
    } else if (hoursLine) {
      reply = `Our hours this week are ${hoursLine}.`;
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
      const dealerProfile = await getDealerProfile();
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
    const dealerProfile = await getDealerProfile();
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
      const alreadyAsked =
        conv.followUp?.reason === "not_ready_no_timeframe" ||
        /\bcheck back\b/i.test(lastOutboundText);
      stopFollowUpCadence(conv, "not_ready_no_timeframe");
      setFollowUpMode(conv, "paused_indefinite", "not_ready_no_timeframe");
      setDialogState(conv, "followup_paused");
      const dealerProfile = await getDealerProfile();
      const dealerName = dealerProfile?.dealerName ?? "American Harley-Davidson";
      const agentName = dealerProfile?.agentName ?? "Brooke";
      const replyRaw = alreadyAsked
        ? "Understood — I’m here when you’re ready. Just reach out when the time is right."
        : "No problem — I’m here when you’re ready. Just reach out when the time is right.";
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
  const shouldSkipFuture =
    schedulingSignalsBase.hasDayTime ||
    looksLikeTimeSelection(textLower) ||
    schedulingSignalsBase.explicit;
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
    const dealerProfile = await getDealerProfile();
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
    const dealerProfile = await getDealerProfile();
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
  const weatherQuestion = /\b(weather|forecast|temperature|temp|snow|cold|rain)\b/i.test(textLower);
  if (event.provider === "twilio" && weatherQuestion) {
    const cfg = await getSchedulerConfig();
    const tz = cfg.timezone || "America/New_York";
    const dayRequest = extractDayRequest(textLower);
    const wantsToday = /\btoday\b/.test(textLower);
    const wantsTomorrow = /\btomorrow\b/.test(textLower);
    let targetParts: { year: number; month: number; day: number } | null = null;
    let dayLabel = "";
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

    if (!targetParts) {
      const reply = "Sure — which day are you wondering about?";
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

    const dealerProfile = await getDealerProfile();
    const dateIso = formatDatePartsIso(targetParts);
    const forecast = await getDealerDailyForecast(dealerProfile, dateIso);
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
      const pickupA = rough
        ? ` If it stays ${forecast.snow ? "cold or snowy" : "cold"}, we can pick it up for a trade evaluation instead.`
        : "";
      const pickupB = rough
        ? " If the weather’s rough, we can pick it up for a trade evaluation instead of having you ride it in."
        : "";
      reply = pickVariantByKey(conv.leadKey ?? event.from, [lineA + pickupA, lineB + pickupB]);
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
    const dealerProfile = await getDealerProfile();
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
    const dealerProfile = await getDealerProfile();
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

      const dealerProfile = await getDealerProfile();
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

  if (event.provider === "twilio" && conv.inventoryWatchPending) {
    const cfg = await getSchedulerConfig();
    const tz = cfg.timezone || "America/New_York";
    const explicitRequested = parseRequestedDayTime(String(event.body ?? ""), tz);
    const hasDayTime = schedulingSignals.hasDayTime;
    const hasDayOnlyAvailability = schedulingSignals.hasDayOnlyAvailability;
    // If the customer explicitly asks for a day/time, let scheduling handle it.
    if (
      !explicitRequested &&
      !hasDayTime &&
      !hasDayOnlyAvailability &&
      !schedulingExplicit
    ) {
      const pending = conv.inventoryWatchPending;
      if (!pending.model) {
        const resolvedModel = await resolveWatchModelFromText(
          textLower,
          conv.lead?.vehicle?.model ?? conv.lead?.vehicle?.description ?? null
        );
        if (!resolvedModel) {
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
        pending.model = resolvedModel;
        if (!pending.year) {
          const yearFromText = extractYearSingle(textLower);
          if (yearFromText) pending.year = yearFromText;
        }
        if (!pending.color) {
          const colorFromText = extractColorToken(textLower);
          if (colorFromText) pending.color = colorFromText;
        }
      }
      const pendingCondition = inferWatchCondition(pending.model, pending.year, conv);
      const finishEligible = await shouldAskFinishPreference(
        pending.model,
        pending.year,
        pendingCondition
      );
      let pref = parseInventoryWatchPreference(String(event.body ?? ""), pending);
      if (pref.action === "ignore" && pending.model && isAffirmative(event.body)) {
        const watch: InventoryWatch = {
          model: pending.model,
          year: pending.year,
          color: undefined,
          exactness: "model_only",
          status: "active",
          createdAt: new Date().toISOString()
        };
        if (watch.year) watch.exactness = "year_model";
        pref = { action: "set", watch };
      }
      if (pref.action === "clarify") {
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

  const inventoryQuestion =
    llmAvailabilityIntent ||
    /(in[-\s]?stock|available|availability|do you have|have .* in[-\s]?stock|any .* in[-\s]?stock|do you carry|carry any)/i.test(
      textLower
    ) ||
    (!!conv.lead?.vehicle?.model &&
      /\b(\d{4}|blue|black|white|red|green|gray|grey|silver|chrome|trim|color|standard|special|st)\b/i.test(
        textLower
      ));
  const watchPrompted = /\b(keep an eye|keep me posted|watch for|watch\b)\b/i.test(
    lastOutboundText
  );
  const watchIntentText =
    /\b(keep (an )?eye( out)?|keep me posted|watch for|watch\b|notify me|text me|call me|reach out|let me know)\b/i.test(
      textLower
    ) &&
    (/\b(if|when|whenever|once|as soon as)\b/.test(textLower) ||
      /\b(comes in|available|in stock|get one|get any|find one|similar)\b/.test(textLower));
  const watchIntent =
    event.provider === "twilio" &&
    !conv.inventoryWatchPending &&
    !inventoryQuestion &&
    !schedulingSignals.hasDayTime &&
    !schedulingSignals.hasDayOnlyAvailability &&
    !schedulingSignals.hasDayOnlyRequest &&
    !schedulingExplicit &&
    ((watchPrompted && isAffirmative(event.body)) || watchIntentText);
  if (watchIntent) {
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
      const colorText = watch.color ? ` in ${watch.color}` : "";
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

    const nowIso = new Date().toISOString();
    const leadVehicle = conv.lead?.vehicle ?? {};
    const leadYearNum = Number(leadVehicle.year ?? "");
    const leadYear = Number.isFinite(leadYearNum) ? leadYearNum : undefined;
    const resolvedModel = await resolveWatchModelFromText(
      textLower,
      leadVehicle.model ?? leadVehicle.description ?? null
    );
    if (!resolvedModel) {
      const reply = "Got it — which model should I watch for?";
      conv.inventoryWatchPending = { askedAt: nowIso };
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

    const pending: InventoryWatchPending = {
      model: resolvedModel,
      year: extractYearSingle(textLower) ?? leadYear,
      color: extractColorToken(textLower) ?? leadVehicle.color ?? undefined,
      askedAt: nowIso
    };
    let pref = parseInventoryWatchPreference(String(event.body ?? ""), pending);
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

    conv.inventoryWatchPending = pending;
    setDialogState(conv, "inventory_watch_prompted");
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
    const twiml = `<?xml version="1.0\" encoding=\"UTF-8\"?>\n<Response>\n  <Message>${escapeXml(
      reply
    )}</Message>\n</Response>`;
    return res.status(200).type("text/xml").send(twiml);
  }
  if (event.provider === "twilio" && schedulingBlocked && shortAck) {
    const ack = "Sounds good. If anything changes, I’ll let you know.";
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
  if (
    event.provider === "twilio" &&
    shortAck &&
    !lastOutboundAskedQuestion &&
    !conv.inventoryWatchPending &&
    !conv.scheduler?.pendingSlot &&
    !conv.appointment?.reschedulePending
  ) {
    const reply = "Thanks — let me know if anything changes.";
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
    /(?:\bwho('?s| is)\s+this\b|^who dis\??$)/i.test(textLower)
  ) {
    const dealerProfile = await getDealerProfile();
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
      const colorText = watch.color ? ` in ${watch.color}` : "";
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
      const year = yearFromText ?? conv.lead?.vehicle?.year ?? null;
      let model =
        llmAvailability?.model ??
        conv.lead?.vehicle?.model ??
        conv.lead?.vehicle?.description ??
        null;
      if (!model || !textLower.includes(model.toLowerCase())) {
        const items = await getInventoryFeed();
        const models = Array.from(new Set(items.map(i => i.model).filter(Boolean))) as string[];
        models.sort((a, b) => b.length - a.length);
        model = models.find(m => textLower.includes(m.toLowerCase())) ?? model;
      }
      const colorTokens = [
        "vivid black",
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
        "tan"
      ];
      const colorFromText = llmAvailability?.color ?? colorTokens.find(c => textLower.includes(c)) ?? null;
      const color = colorFromText ?? conv.lead?.vehicle?.color ?? null;
      const finishFromText = extractFinishToken(textLower);

      if (model) {
        const hasIdentifiers = !!conv.lead?.vehicle?.stockId || !!conv.lead?.vehicle?.vin || !!color;
        let matches = await findInventoryMatches({ year: year ?? null, model });
        if (color) {
          const c = color.toLowerCase();
          matches = matches.filter(i => (i.color ?? "").toLowerCase().includes(c));
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
        const hasSoldMatch = matches.some(m => {
          const key = normalizeInventorySoldKey(m.stockId, m.vin);
          return key ? !!solds?.[key] : false;
        });

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
          const reply = `That specific unit is on hold right now, but we do have other ${model} options available. Want details?`;
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

        if (availableMatches.length > 0) {
        conv.lead = conv.lead ?? {};
        conv.lead.vehicle = conv.lead.vehicle ?? {};
        if (year) conv.lead.vehicle.year = year;
        conv.lead.vehicle.model = model ?? conv.lead.vehicle.model;
        if (color) conv.lead.vehicle.color = color;
        setDialogState(conv, "inventory_answered");
        const imageUrl =
          availableMatches.find(m => Array.isArray(m.images) && m.images.length)?.images?.[0] ?? null;
        const reply =
          year
            ? `Yes — we do have ${year} ${model}${color ? ` in ${color}` : ""} in stock. Would you like to stop by to take a look?`
              : `Yes — we do have ${model} in stock. Any specific year, trim, or color you’re after?`;
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
        if (matches.length === 0 && !hasIdentifiers) {
          let fallback = await findInventoryMatches({ year: null, model });
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
          `Verify inventory for ${year ?? ""} ${model}${color ? ` (${color})` : ""}`.trim(),
          event.providerMessageId
        );
        const isGenericModel = /full line|other/i.test(model ?? "");
        if (!isGenericModel) {
          conv.inventoryWatchPending = {
            model,
            year: year ? Number(year) : undefined,
            color: color ?? undefined,
            askedAt: new Date().toISOString()
          };
          setDialogState(conv, "inventory_watch_prompted");
        }
        const leadCondition = normalizeWatchCondition(conv.lead?.vehicle?.condition);
        const leadYearNum = Number(String(year ?? ""));
        const currentYear = new Date().getFullYear();
        const assumeNew = !leadCondition && Number.isFinite(leadYearNum) && leadYearNum === currentYear;
        const modelRecent = model ? isModelInRecentYears(model, currentYear, 1) : false;
        const conditionLabel =
          leadCondition ?? (assumeNew ? "new" : modelRecent ? undefined : "used");
        const yearLabel = year ? `${year}${conditionLabel ? `/${conditionLabel}` : ""}` : null;
        const needsYear = !yearFromText;
        const allowColorFinish = conditionLabel === "new";
        const finishEligible = allowColorFinish
          ? await shouldAskFinishPreference(model ?? undefined, year ? Number(year) : undefined, conditionLabel)
          : false;
        const needsColor = allowColorFinish && !colorFromText;
        const needsFinish = allowColorFinish && finishEligible && !finishFromText;
        let clarify = "";
        if (!isGenericModel) {
          if (needsYear && !allowColorFinish) {
            clarify = yearLabel
              ? `Are you looking for ${yearLabel}, or a year range?`
              : "Any specific year or year range you're after?";
          } else if (needsYear && needsColor && needsFinish) {
            clarify = yearLabel
              ? `Are you looking for ${yearLabel}, and any color or finish preference (chrome vs blacked-out)?`
              : "Any specific year, color, or finish preference (chrome vs blacked-out)?";
          } else if (needsYear && needsFinish) {
            clarify = yearLabel
              ? `Are you looking for ${yearLabel}, and do you have a finish preference (chrome vs blacked-out)?`
              : "Any specific year you're after, and do you have a finish preference (chrome vs blacked-out)?";
          } else if (needsYear && needsColor) {
            clarify = yearLabel
              ? `Are you looking for ${yearLabel}, and any color preference?`
              : "Any specific year or color you're after?";
          } else if (needsFinish && needsColor) {
            clarify = "Any color or finish preference (chrome vs blacked-out)?";
          } else if (needsFinish) {
            clarify = "Do you have a finish preference (chrome vs blacked-out)?";
          } else if (needsColor) {
            clarify = "Any specific color you're after?";
          } else if (needsYear) {
            clarify = yearLabel ? `Are you looking for ${yearLabel}?` : "Any specific year you're after?";
          }
        }
        const watchPrompt = buildWatchPreferencePrompt(conditionLabel, finishEligible);
        const reply =
          `I’m not seeing ${year ? `${year} ` : ""}${model}${color ? ` in ${color}` : ""} in stock right now. ` +
          (isGenericModel
            ? "I’ll have someone verify and follow up shortly."
            : clarify || watchPrompt);
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
      schedulingExplicit &&
      (ctxSuggestsScheduling || llmSuggestsScheduling || schedulingSignals.hasDayTime);
    if (schedulingIntent) {
      try {
        const cfg = await getSchedulerConfig();
        const requested = parseRequestedDayTime(String(event.body ?? ""), cfg.timezone);
        if (requested) {
          console.log("[deterministic-offer] skip explicit day/time request");
          // Let orchestrator/exact-booking handle explicit day+time requests.
        } else {
        const appointmentTypes = cfg.appointmentTypes ?? { inventory_visit: { durationMinutes: 60 } };
        const preferredSalespeople = getPreferredSalespeopleForConv(cfg, conv);
        const salespeople = cfg.salespeople ?? [];
        const gapMinutes = cfg.minGapBetweenAppointmentsMinutes ?? 60;
        const appointmentType = "inventory_visit";
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
            setDialogState(conv, "schedule_booked");

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
              appendOutbound(conv, event.to, event.from, confirmText, "draft_ai");
              saveConversation(conv);
              await flushConversationStore();
              const twiml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response></Response>`;
              return res.status(200).type("text/xml").send(twiml);
            }
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
            setDialogState(conv, "schedule_offer_sent");
          }
          const systemMode = webhookMode;
          if (systemMode === "suggest") {
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
        console.log("[scheduler] deterministic offer failed:", e?.message ?? e);
      }
    }
  }

  const schedulingTextForOrchestrator =
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
  const weatherProfile = await getDealerProfile();
  const weatherStatus = await getDealerWeatherStatus(weatherProfile);
  const result = await orchestrateInbound(event, history, {
    appointment: conv.appointment,
    followUp: conv.followUp,
    leadSource: conv.lead?.source ?? null,
    bucket: conv.classification?.bucket ?? null,
    cta: conv.classification?.cta ?? null,
    lead: conv.lead ?? null,
    pricingAttempts: getPricingAttempts(conv),
    allowSchedulingOffer: schedulingExplicit && schedulingAllowed,
    schedulingText: schedulingTextForOrchestrator,
    callbackRequestedOverride: callbackRequestedOverride ? true : undefined,
    appointmentTypeOverride,
    voiceSummary: getActiveVoiceContext(conv)?.summary ?? null,
    memorySummary,
    memorySummaryShouldUpdate,
    inventoryWatch: conv.inventoryWatch ?? null,
    inventoryWatches: conv.inventoryWatches ?? null,
    hold: conv.hold ?? null,
    sale: conv.sale ?? null,
    pickup: conv.pickup ?? null,
    weather: weatherStatus ?? null
  });
  if (result.smallTalk) {
    setDialogState(conv, "small_talk");
  }
  if (result.pickupUpdate) {
    conv.pickup = { ...(conv.pickup ?? {}), ...result.pickupUpdate, updatedAt: nowIso() };
  }
  if (!result.requestedTime && schedulingAllowed && schedulingSignals.hasDayTime) {
    try {
      const cfg = await getSchedulerConfig();
      const tz = cfg.timezone || "America/New_York";
      const parsed = parseRequestedDayTime(String(event.body ?? ""), tz);
      if (parsed) {
        result.requestedTime = parsed;
      }
    } catch {}
  }
  if (
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
        const cfg = await getSchedulerConfig();
        const tz = cfg.timezone || "America/New_York";
        const parsed = parseRequestedDayTime(conv.scheduler.requested.timeText, tz);
        if (parsed) {
          result.requestedTime = parsed;
        }
      } catch {}
    }
  }
  console.log("[twilio] result.suggestedSlots len:", result.suggestedSlots?.length ?? 0);
  if ((result.suggestedSlots?.length ?? 0) === 0 && draftHasSpecificTimes(result.draft ?? "")) {
    let requested = result.requestedTime ?? null;
    if (!requested) {
      try {
        const cfg = await getSchedulerConfig();
        const tz = cfg.timezone || "America/New_York";
        requested = parseRequestedDayTime(String(event.body ?? ""), tz);
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
  const dialogState = getDialogState(conv);
  const canUpdatePricingState =
    !isScheduleDialogState(dialogState) &&
    !isTradeDialogState(dialogState) &&
    !isServiceDialogState(dialogState) &&
    dialogState !== "callback_requested" &&
    dialogState !== "callback_handoff" &&
    dialogState !== "call_only";
  if (result.intent === "TRADE_IN" && !isScheduleDialogState(dialogState)) {
    if (!isTradeDialogState(dialogState)) {
      const sellOption = conv.lead?.sellOption;
      if (sellOption === "cash") setDialogState(conv, "trade_cash");
      else if (sellOption === "trade") setDialogState(conv, "trade_trade");
      else if (sellOption === "either") setDialogState(conv, "trade_either");
      else setDialogState(conv, "trade_init");
    }
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
    } else if (isPricingText(event.body ?? "") && dialogState === "none") {
      setDialogState(conv, "pricing_init");
    }
  }
  if (result.handoff?.required) {
    const reason = result.handoff.reason;
    const dealerProfile = await getDealerProfile();
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
    const dealerProfile = await getDealerProfile();
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
  if (result.suggestedSlots && result.suggestedSlots.length > 0) {
    if (schedulingAllowed && schedulingSignals.hasDayTime && !conv.appointment?.bookedEventId) {
      let requested = result.requestedTime ?? null;
      if (!requested) {
        try {
          const cfg = await getSchedulerConfig();
          const tz = cfg.timezone || "America/New_York";
          requested = parseRequestedDayTime(String(event.body ?? ""), tz);
        } catch {}
      }
      if (requested) {
        try {
          const cfg = await getSchedulerConfig();
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
    console.log("[scheduler] persist suggestedSlots", result.suggestedSlots.length);
    setLastSuggestedSlots(conv, result.suggestedSlots);
    setDialogState(conv, "schedule_offer_sent");
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
    setDialogState(conv, "schedule_request");
  }

  if (schedulingAllowed && !didConfirm && result.requestedTime) {
    try {
      const skipExactBooking = /(this time|same time)/i.test(event.body);
      const cfg = await getSchedulerConfig();
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
          setDialogState(conv, "schedule_offer_sent");
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

  const dealerProfile = await getDealerProfile();
  const dealerName = dealerProfile?.dealerName ?? "American Harley-Davidson";
  const agentName = dealerProfile?.agentName ?? "Brooke";
  const lastOutboundTextFinal = getLastNonVoiceOutbound(conv)?.body ?? "";
  let reply = ensureUniqueDraft(result.draft, conv, dealerName, agentName);
  reply = applySlotOfferPolicy(conv, reply, lastOutboundTextFinal);
  reply = applyTradePolicy(conv, reply, lastOutboundTextFinal, result.suggestedSlots);
  reply = applyPickupPolicy(conv, reply);
  reply = applyPricingPolicy(conv, reply, lastOutboundTextFinal);
  reply = applyCallbackPolicy(conv, reply, lastOutboundTextFinal);
  reply = applyServicePolicy(conv, reply, lastOutboundTextFinal);
  reply = applySoftSchedulePolicy(conv, reply, String(event.body ?? ""));
  reply = stripSchedulingLanguageIfNotAsked(reply, String(event.body ?? ""));
  if (isSlotOfferMessage(reply)) {
    setDialogState(conv, "schedule_offer_sent");
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
    const dealerProfile = await getDealerProfile();
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
      const cfg = await getSchedulerConfig();
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
