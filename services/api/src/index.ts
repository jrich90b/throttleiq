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
import { classifySchedulingIntent } from "./domain/llmDraft.js";
import type { InboundMessageEvent } from "./domain/types.js";
import { sendgridInboundMiddleware, handleSendgridInbound } from "./routes/sendgridInbound.js";
import { resolveInventoryUrlByStock } from "./domain/inventoryUrlResolver.js";
import { checkInventorySalePendingByUrl } from "./domain/inventoryChecker.js";
import { getDealerProfile, saveDealerProfile } from "./domain/dealerProfile.js";
import { getDataDir } from "./domain/dataDir.js";
import { computeFollowUpDueAt, FOLLOW_UP_DAY_OFFSETS } from "./domain/conversationStore.js";
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
  advanceFollowUpCadence,
  getAllConversations,
  finalizeDraftAsSent,
  discardPendingDrafts,
  addTodo,
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
  setConversationMode,
  setContactPreference,
  setCrmLastLoggedAt,
  flushConversationStore,
  reloadConversationStore,
  saveConversation,
  getConversationStorePath,
  type InventoryWatch
} from "./domain/conversationStore.js";
import { logTuningRow } from "./domain/tuningLogger.js";
import {
  addSuppression,
  isSuppressed,
  listSuppressions,
  removeSuppression
} from "./domain/suppressionStore.js";
import { tlpLogCustomerContact } from "./connectors/crm/tlpPlaywright.js";
import { listContacts, updateContact, deleteContact } from "./domain/contactsStore.js";

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
    .filter(u => u.role === "salesperson" && u.calendarId)
    .map(u => ({ id: u.id, name: u.name || u.email || u.id, calendarId: u.calendarId! }));
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

function inventoryItemMatchesWatch(item: any, watch: InventoryWatch): boolean {
  if (!item?.model || !watch?.model) return false;
  const itemModel = normalizeModelName(String(item.model));
  const watchModel = normalizeModelName(String(watch.model));
  if (!itemModel.includes(watchModel) && !watchModel.includes(itemModel)) return false;
  if (watch.year && String(item.year) !== String(watch.year)) return false;
  if (watch.yearMin && watch.yearMax) {
    const y = Number(item.year ?? 0);
    if (!Number.isFinite(y) || y < watch.yearMin || y > watch.yearMax) return false;
  }
  if (watch.color) {
    const color = String(item.color ?? "").toLowerCase();
    if (!color.includes(String(watch.color).toLowerCase())) return false;
  }
  return true;
}

async function processInventoryWatchlist() {
  if (inventoryWatchRunning) return;
  inventoryWatchRunning = true;
  try {
    const items = await getInventoryFeed();
    if (!items.length) return;
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
      const watch = conv.inventoryWatch;
      if (!watch || watch.status === "paused") continue;
      if (conv.status === "closed") continue;
      const phone = conv.lead?.phone ?? conv.leadKey;
      if (phone && isSuppressed(phone)) continue;
      if (conv.followUp?.mode === "manual_handoff") continue;
      if (watch.lastNotifiedAt && Date.now() - new Date(watch.lastNotifiedAt).getTime() < 24 * 60 * 60 * 1000) {
        continue;
      }

      const match = newItems.find(i => inventoryItemMatchesWatch(i, watch));
      if (!match) continue;

      const year = match.year ?? (watch.year ? String(watch.year) : undefined);
      const model = match.model ?? watch.model;
      const color = match.color ?? watch.color;
      const name = [year, model].filter(Boolean).join(" ");
      const colorText = color ? ` in ${color}` : "";
      const reply = `Good news — we just got ${name}${colorText} in stock. Want details or a time to check it out?`;
      const imageUrl = Array.isArray(match.images) && match.images.length ? match.images[0] : undefined;
      const to = conv.lead?.phone ?? conv.leadKey;
      appendOutbound(conv, "salesperson", to, reply, "draft_ai", undefined, imageUrl ? [imageUrl] : undefined);
      watch.lastNotifiedAt = nowIso;
      watch.lastNotifiedStockId = match.stockId ?? match.vin ?? undefined;
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

setInterval(() => {
  void processDueFollowUps();
  void processAppointmentConfirmations();
  void processAppointmentQuestions();
}, 60_000);

setTimeout(() => {
  void processInventoryWatchlist();
}, 60_000);

setInterval(() => {
  void processInventoryWatchlist();
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
    const withNotes = items.map(item => {
      const key = (item.stockId ?? item.vin ?? "").trim().toLowerCase();
      const entry = key ? notes?.[key] : undefined;
      return { ...item, notes: entry?.notes ?? [] };
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
    const history = conv.messages.slice(-20).map(m => ({ direction: m.direction, body: m.body }));
    const result = await orchestrateInbound(event, history, {
      appointment: conv.appointment,
      followUp: conv.followUp,
      leadSource: conv.lead?.source ?? null,
      bucket: conv.classification?.bucket ?? null,
      cta: conv.classification?.cta ?? null,
      lead: conv.lead ?? null,
      pricingAttempts: getPricingAttempts(conv)
    });

    if (result?.draft && result.shouldRespond) {
      appendOutbound(conv, event.to, event.from, result.draft, "draft_ai");
      if (result.pricingAttempted) incrementPricingAttempt(conv);
      if (result.suggestedSlots && result.suggestedSlots.length > 0) {
        setLastSuggestedSlots(conv, result.suggestedSlots);
      }
      if (result.requestedTime) {
        setRequestedTime(conv, { day: result.requestedTime.dayOfWeek, timeText: event.body });
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
      role: user.role,
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
      role: u.role,
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
  const name = String(req.body?.name ?? "").trim();
  const calendarId = String(req.body?.calendarId ?? "").trim();
  const phone = String(req.body?.phone ?? "").trim();
  const extension = String(req.body?.extension ?? "").trim();
  const permissions = req.body?.permissions ?? undefined;
  if (!email || !password) return res.status(400).json({ ok: false, error: "Missing email/password" });
  try {
    const user = await createUser({ email, password, role, name, calendarId, phone, extension, permissions });
    await syncSchedulerSalespeopleFromUsers();
    res.json({
      ok: true,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
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
        role: user.role,
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

function onAppointmentBooked(conv: any) {
  stopFollowUpCadence(conv, "appointment_booked");
  stopRelatedCadences(conv, "appointment_booked");
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

const FOLLOW_UP_MESSAGES = [
  "Just checking in. Want to come by and look at the bike? I have {a} or {b} — do any of these times work?",
  "If you want a quick walkaround video, I can send one. If you'd rather come by, what day works for you?",
  "If you still want to see it, what day and time works for you?",
  "Quick question — are you comparing a few bikes, or is this one your top choice?",
  "Still interested? I can set a time. What day and time works for you?",
  "If you're still shopping, what day and time works for you?",
  "No rush. If you want to see it, what day and time should I hold?",
  "Want to set a visit? What day and time works for you?",
  "Should I hold a time for you? If so, what day and time?",
  "Still want to take a look? If so, what day and time works for you?"
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
    `Hi ${name},\n\nJust checking in about ${label}. I can help with pricing, options, and availability. ${bookingLine} If you’d rather reply by email, just send a day and time that works for you.\n\nThanks,`,
  ({ name, label, bookingLine }) =>
    `Hi ${name},\n\nI wanted to see if you’d like more details on ${label}. If a walkaround video would help, I can send one. ${bookingLine} I’m happy to answer any questions by email.\n\nThanks,`,
  ({ name, label, bookingLine, canTestRide }) =>
    `Hi ${name},\n\nThanks again for your interest in ${label}. ${canTestRide ? "If you want a test ride, I can reserve a time." : "If you want to stop by, I can reserve a time."} ${bookingLine} If you prefer, just reply with a day and time that works.\n\nThanks,`,
  ({ name, label, bookingLine }) =>
    `Hi ${name},\n\nQuick question: is ${label} still at the top of your list? If you’d like to see it in person, ${bookingLine} I’m here to help with any questions in the meantime.\n\nThanks,`,
  ({ name, label, bookingLine }) =>
    `Hi ${name},\n\nJust checking in on ${label}. If you’d like to take a closer look, ${bookingLine} I can also help with pricing or availability by email.\n\nThanks,`,
  ({ name, label, bookingLine }) =>
    `Hi ${name},\n\nI hope your week is going well. If you’re still shopping for ${label}, I’m happy to help with options and next steps. ${bookingLine} Let me know if there’s anything specific you want to see.\n\nThanks,`,
  ({ name, label, bookingLine }) =>
    `Hi ${name},\n\nNo rush at all — I just wanted to keep the conversation open on ${label}. ${bookingLine} If it’s easier, reply with a day and time and I’ll take care of the rest.\n\nThanks,`,
  ({ name, label, bookingLine }) =>
    `Hi ${name},\n\nIf you want to set a time to check out ${label}, I can get that on the calendar. ${bookingLine} I can also answer any questions by email before you visit.\n\nThanks,`,
  ({ name, label, bookingLine }) =>
    `Hi ${name},\n\nShould I hold a time for you to see ${label}? ${bookingLine} If a different approach is better, just tell me what works.\n\nThanks,`,
  ({ name, label, bookingLine }) =>
    `Hi ${name},\n\nStill interested in taking a look at ${label}? ${bookingLine} I’m happy to help with anything you need in the meantime.\n\nThanks,`
];

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
  const isTestRide =
    conv?.classification?.bucket === "test_ride" || conv?.classification?.cta === "schedule_test_ride";
  const thanks = isTestRide
    ? label
      ? `Thanks for your interest in a test ride on the ${label}.`
      : "Thanks for your interest in a test ride."
    : label
      ? `Thanks for your interest in the ${label}.`
      : "Thanks for your interest.";
  const intro = `This is ${agentName} at ${dealerName}.`;
  const help = "I’m happy to help with pricing, options, and availability.";
  const visit = label
    ? "If you want to stop in to check out the bike and go over options, you can book an appointment below."
    : "If you want to stop in to go over options, you can book an appointment below.";
  const bookingLine = bookingUrl
    ? `You can book an appointment here: ${bookingUrl}`
    : "Just reply with a day and time that works for you.";
  const extra = "If a walkaround or extra photos would help, just let me know.";

  return `Hi ${name},\n\n${thanks} ${intro} ${help} ${visit}\n\n${bookingLine}\n\n${extra}`;
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

function isTestRideSeason(profile: any, now: Date): boolean {
  const enabled = profile?.followUp?.testRideEnabled;
  if (enabled === false) return false;
  const months: number[] = Array.isArray(profile?.followUp?.testRideMonths)
    ? profile.followUp.testRideMonths
    : [4, 5, 6, 7, 8, 9, 10];
  const current = now.getMonth() + 1;
  return months.includes(current);
}

function formatModelLabel(year?: string | null, model?: string | null): string {
  const yr = year ? `${year} ` : "";
  return `${yr}${model ?? "that model"}`.trim();
}

function formatModelLabelForFollowUp(_year?: string | null, model?: string | null): string {
  if (!model || /full line/i.test(model)) return "the bike";
  const base = String(model).trim();
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
        body: `${greeting}If you want, we can set up a test ride for a ${label}. What day and time works for you?`
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
      body: `${greeting}We’re offering test rides right now. Want me to reserve a time for you?`
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
      body: `${greeting}You mentioned a ${timeframe} timeline. I’m here when you’re ready. Want me to set a reminder?`
    };
  }

  return {
    body: `${greeting}You mentioned a ${timeframe} timeline. I’m here when you’re ready. Want me to set a reminder?`
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
  const monthMatch = t.match(/\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/);
  if (monthMatch) {
    const monthKey = monthMatch[1];
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
  if (looksLikeTimeSelection(t)) return true;
  if (/\b(schedule|appointment|appt|book|reserve|set\s+up|come\s+in|stop\s+(in|by)|visit|test ride|demo ride)\b/i.test(t)) {
    return true;
  }
  if (/\b(when|what time|what day|availability|available|openings|open)\b/i.test(t)) {
    return true;
  }
  if (/\b(today|tomorrow|next week|this week|next month|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i.test(t)) {
    return true;
  }
  return false;
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
    const r = new RegExp(`^\\s*(this is[^.]*${escapeRegex(agentName)}[^.]*\\.)\\s*`, "i");
    out = out.replace(r, "");
  }
  if (dealerName) {
    const r = new RegExp(`^\\s*(this is[^.]*${escapeRegex(dealerName)}[^.]*\\.)\\s*`, "i");
    out = out.replace(r, "");
  }
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

function parseInventoryWatchPreference(
  text: string,
  pending: { model?: string; year?: number; color?: string }
): { action: "set" | "clarify" | "ignore"; watch?: InventoryWatch } {
  const t = text.toLowerCase();
  if (!pending.model) return { action: "ignore" };

  const mentionsPreference =
    /(exact|only|same|any|no preference|no pref|either|range|year|color)/.test(t) ||
    /\b(20\d{2})\b/.test(t);
  if (!mentionsPreference) return { action: "ignore" };

  const anyColor = /(any color|no color preference|no preference|any colour|no colour preference)/.test(t);
  const anyYear = /(any year|no year preference|no preference|open to other years|either year)/.test(t);
  const exact = /(exact|only|same color|same colour|only that|just that|same year)/.test(t);

  const color = anyColor ? undefined : extractColorToken(t) ?? pending.color;
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
  const now = new Date();
  const convs = getAllConversations();
  const todoConvIds = new Set(listOpenTodos().map(t => t.convId));
  const canTestRideNow = async (conv: any) => {
    return canOfferTestRideForLead(conv?.lead, dealerProfile);
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

  for (const conv of convs) {
    const cadence = conv.followUpCadence;
    if (!cadence || cadence.status !== "active" || !cadence.nextDueAt) continue;
    if (conv.contactPreference === "call_only") {
      stopFollowUpCadence(conv, "call_only");
      continue;
    }
    if (conv.status === "closed") {
      stopFollowUpCadence(conv, "closed");
      continue;
    }
    if (todoConvIds.has(conv.id)) continue;
    if (cadence.pausedUntil) {
      const resumeAt = new Date(cadence.pausedUntil);
      if (now < resumeAt) continue;
      cadence.pausedUntil = undefined;
      cadence.pauseReason = undefined;
    }
    if (isSuppressed(conv.leadKey)) {
      stopFollowUpCadence(conv, "suppressed");
      continue;
    }
    const lastInbound = getLastInbound(conv);
    if (lastInbound?.body && lastInbound?.at) {
      const inboundAt = new Date(lastInbound.at);
      const { until, indefinite } = parsePauseUntil(lastInbound.body, inboundAt);
      if (indefinite) continue;
      if (until && now < until) continue;
      if (isMeaningfulInbound(lastInbound.body) && now.getTime() - inboundAt.getTime() < 72 * 60 * 60 * 1000) {
        continue;
      }
    }
    const lastOutbound = getLastOutbound(conv, ["human", "twilio", "sendgrid"]);
    if (lastOutbound?.at) {
      const outboundAt = new Date(lastOutbound.at);
      if (now.getTime() - outboundAt.getTime() < 72 * 60 * 60 * 1000) {
        continue;
      }
    }
    const lastDraft = getLastOutbound(conv, ["draft_ai"]);
    if (lastDraft?.at) {
      const draftAt = new Date(lastDraft.at);
      // Avoid stacking multiple follow-up drafts within a day.
      if (now.getTime() - draftAt.getTime() < 24 * 60 * 60 * 1000) {
        continue;
      }
    }
    if (new Date(cadence.nextDueAt) > now) continue;
    if (conv.appointment?.bookedEventId) {
      onAppointmentBooked(conv);
      continue;
    }
    if (conv.followUp?.mode === "holding_inventory") continue;
    if (conv.followUp?.mode === "manual_handoff") continue;

    const canTestRideFlag = await canTestRideNow(conv);
    let message = FOLLOW_UP_MESSAGES[cadence.stepIndex] ?? FOLLOW_UP_MESSAGES[FOLLOW_UP_MESSAGES.length - 1];
    let mediaUrls: string[] | undefined;
    if (cadence.kind === "long_term") {
      const longTerm = await buildLongTermFollowUp(conv, dealerProfile);
      message = longTerm.body;
      mediaUrls = longTerm.mediaUrls;
    } else if (cadence.stepIndex === 0) {
      const day2 = await buildDay2Options(cfg);
      if (day2) {
        const followUpLabel = formatModelLabelForFollowUp(
          conv.lead?.vehicle?.year ?? null,
          conv.lead?.vehicle?.model ?? null
        );
        message = `Just checking in — want to come by and look at ${followUpLabel}? I have ${day2.slots[0].startLocal} or ${day2.slots[1].startLocal} if that helps.`;
        setLastSuggestedSlots(conv, day2.slots);
      } else {
        message = FOLLOW_UP_MESSAGES[1];
      }
    } else if (cadence.stepIndex === 2) {
      if (canTestRideFlag) {
        message = "If you want to set up a test ride, I can hold a time. What day and time works for you?";
      } else {
        message = FOLLOW_UP_MESSAGES[2];
      }
    } else if (cadence.stepIndex >= 10) {
      const late = await buildLateFollowUp(conv, cadence.stepIndex, dealerProfile);
      message = late.body;
      mediaUrls = late.mediaUrls;
    }

    const emailTo = conv.lead?.email;
    const useEmail =
      conv.classification?.channel === "email" && !!emailTo && hasEmailOptIn(conv.lead);
    const systemMode = effectiveMode(conv);
    const { from: emailFrom, replyTo: emailReplyTo, signature } = getEmailConfig(dealerProfile);
    const replyTo = maybeTagReplyTo(emailReplyTo, conv);
    const bookingUrl = buildBookingUrlForLead(dealerProfile?.bookingUrl, conv);
    const name = conv.lead?.firstName?.trim() || "there";
    const year = conv.lead?.vehicle?.year ?? null;
    const model = conv.lead?.vehicle?.model ?? null;
    const label = model ? `the ${formatModelLabel(year, model)}` : "your inquiry";
    const bookingLine = bookingUrl
      ? `You can book an appointment here: ${bookingUrl}`
      : "If you want to stop in, reply with a day and time that works.";
    let emailMessage: string | null = null;
    if (useEmail) {
      if (cadence.kind === "long_term") {
        emailMessage = `Hi ${name},\n\n${message}\n\n${bookingLine}\n\nThanks,`;
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

    if (systemMode === "suggest") {
      const draftTo = useEmail ? emailTo! : to;
      const draftMessage = useEmail && emailMessage ? emailMessage : message;
      appendOutbound(conv, from ?? "salesperson", draftTo, draftMessage, "draft_ai", undefined, mediaUrls);
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
      } catch (e: any) {
        console.log("[followup] email send failed:", e?.message ?? e);
        const fallbackMessage = emailMessage ?? message;
        appendOutbound(conv, "salesperson", emailTo!, fallbackMessage, "human", undefined, mediaUrls);
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
    addInternalQuestion(conv.id, conv.leadKey, text);
    appt.attendanceQuestionedAt = now.toISOString();
  }
}

async function maybeStartCadence(conv: any, sentAtIso: string) {
  if (conv.appointment?.bookedEventId) return;
  if (conv.status === "closed") return;
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
  const summary = `Appt: ${String(req.body?.appointmentType ?? "inventory_visit")} – ${leadName}`.trim();

  const descriptionLines = [
    `LeadKey: ${lead?.leadKey ?? ""}`,
    `Phone: ${lead?.phone ?? ""}`,
    `Email: ${lead?.email ?? ""}`,
    `Stock: ${lead?.stockId ?? ""}`,
    `VIN: ${lead?.vin ?? ""}`,
    `Source: ${lead?.leadSource ?? ""}`,
    "",
    `Notes: ${lead?.notes ?? ""}`
  ].filter(Boolean);

  const cal = await getAuthedCalendarClient();
  const event = await insertEvent(
    cal,
    slot.calendarId,
    cfg.timezone,
    summary,
    descriptionLines.join("\n"),
    slot.start,
    slot.end
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
    `Stock: ${lead?.stockId ?? ""}`,
    `VIN: ${lead?.vin ?? ""}`,
    `Source: ${lead?.leadSource ?? "public_booking"}`,
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

  const event = await insertEvent(
    cal,
    chosenSp.calendarId,
    cfg.timezone,
    summary,
    descriptionLines.join("\n"),
    slot.start,
    slot.end
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
      end.toISOString()
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
      status: status === "cancelled" ? "cancelled" : undefined
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

app.get("/conversations/:id", async (req, res) => {
  const conv = getConversation(req.params.id);
  if (!conv) return res.status(404).json({ ok: false, error: "Not found" });
  const emailDraft = conv.emailDraft ?? null;
  res.json({
    ok: true,
    systemMode: getSystemMode(),
    conversation: { ...conv, emailDraft }
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

app.post("/conversations/:id/close", (req, res) => {
  const conv = getConversation(req.params.id);
  if (!conv) return res.status(404).json({ ok: false, error: "Not found" });
  const reason = String(req.body?.reason ?? "closed").trim() || "closed";
  closeConversation(conv, reason);
  stopRelatedCadences(conv, reason, { close: true });
  return res.json({ ok: true, conversation: conv });
});

app.delete("/conversations/:id", (req, res) => {
  const id = req.params.id;
  const ok = deleteConversation(id);
  if (!ok) return res.status(404).json({ ok: false, error: "Not found" });
  return res.json({ ok: true });
});

app.get("/todos", requirePermission("canAccessTodos"), (_req, res) => {
  res.json({ ok: true, todos: listOpenTodos() });
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
    addTodo(conv, "other", msg);
    return res.status(500).json({ ok: false, error: err?.message ?? "Failed to log contact" });
  }
});

// ✅ Control-panel "send" (still log-only for now)
app.post("/conversations/:id/send", async (req, res) => {
  const conv = getConversation(req.params.id);
  if (!conv) return res.status(404).json({ ok: false, error: "Not found" });

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
      addTodo(conv, "other", msg);
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
      const hasOpenTodo = listOpenTodos().some(t => t.convId === conv.id);
      if (!hasOpenTodo) {
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
      appendOutbound(conv, "salesperson", conv.leadKey, body, "human");
    }
    if (!hadOutbound) {
      await maybeStartCadence(conv, new Date().toISOString());
    }
    const hasOpenTodo = listOpenTodos().some(t => t.convId === conv.id);
    if (!hasOpenTodo) {
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
      appendOutbound(conv, "salesperson", to, body, "human");
    }
    if (!hadOutbound) {
      await maybeStartCadence(conv, new Date().toISOString());
    }
    const hasOpenTodo = listOpenTodos().some(t => t.convId === conv.id);
    if (!hasOpenTodo) {
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
    const msg = await client.messages.create({ from, to, body });

    // Log as truly sent via Twilio (store SID)
    const hadOutbound = conv.messages.some(m => m.direction === "out");
    const fin = finalizeDraftAsSent(conv, draftId, body, "twilio", msg.sid);
    if (!fin.usedDraft) {
      appendOutbound(conv, from, to, body, "twilio", msg.sid);
    }
    if (!hadOutbound) {
      await maybeStartCadence(conv, new Date().toISOString());
    }
    const hasOpenTodo = listOpenTodos().some(t => t.convId === conv.id);
    if (!hasOpenTodo) {
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
      appendOutbound(conv, "salesperson", to, body, "human");
    }
    if (!hadOutbound) {
      await maybeStartCadence(conv, new Date().toISOString());
    }
    const hasOpenTodo = listOpenTodos().some(t => t.convId === conv.id);
    if (!hasOpenTodo) {
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

  const publicBase = process.env.PUBLIC_BASE_URL?.replace(/\/+$/, "");
  const baseUrl = publicBase
    ? publicBase
    : `${req.protocol}://${req.get("host")}`;
  const agentName = String(user?.name ?? user?.email ?? "Agent").trim() || "Agent";
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

  const isAffirmative = (text: string) => {
    if (extractTimeToken(text)) return false;
    return /\b(yes|yep|yeah|yup|ok|okay|sure|confirmed|confirm|works|that works|sounds good)\b/i.test(
      text
    );
  };

  // Auto-book if they confirmed a pending slot
  if (!conv.appointment?.bookedEventId && conv.scheduler?.pendingSlot && isAffirmative(event.body)) {
    const chosen = conv.scheduler.pendingSlot;
    try {
      const cfg = await getSchedulerConfig();
      const tz = cfg.timezone || "America/New_York";
      const cal = await getAuthedCalendarClient();

      const stockId = conv.lead?.vehicle?.stockId ?? null;
      const leadNameRaw = conv.lead?.name?.trim() ?? "";
      const firstName = conv.lead?.firstName ?? "";
      const lastName = conv.lead?.lastName ?? "";
      const leadName = leadNameRaw || [firstName, lastName].filter(Boolean).join(" ").trim() || conv.leadKey;
      const appointmentType = chosen.appointmentType ?? "inventory_visit";

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

      const created = await insertEvent(
        cal,
        chosen.calendarId,
        tz,
        summary,
        description,
        chosen.start,
        chosen.end
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

  // Auto-book if they accept a suggested slot
  if (
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
        const firstName = conv.lead?.firstName ?? "";
        const lastName = conv.lead?.lastName ?? "";
        const leadName = leadNameRaw || [firstName, lastName].filter(Boolean).join(" ").trim() || conv.leadKey;
        const appointmentType = chosen.appointmentType ?? "inventory_visit";

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

        const created = await insertEvent(
          cal,
          chosen.calendarId,
          tz,
          summary,
          description,
          chosen.start,
          chosen.end
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
  const didConfirm = confirmAppointmentIfMatchesSuggested(conv, event.body, event.providerMessageId);
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
    const preferredSalespeople = getPreferredSalespeople(cfg);
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
    const rescheduleIntent = reschedulePending || reschedulePhrase || !!requestedReschedule;
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

      const salespersonId = conv.appointment.bookedSalespersonId ?? preferredSalespeople[0];
      const sp = salespeople.find((p: any) => p.id === salespersonId);
      if (!sp) throw new Error("Salesperson not found for reschedule");

      const timeMin = new Date().toISOString();
      const timeMax = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();
      const fb = await queryFreeBusy(cal, [sp.calendarId], timeMin, timeMax, cfg.timezone);
      let busy = (fb.calendars?.[sp.calendarId]?.busy ?? []) as any[];

      if (conv.appointment.whenIso) {
        const oldStart = new Date(conv.appointment.whenIso);
        const oldEnd = new Date(oldStart.getTime() + durationMinutes * 60_000);
        busy = busy.filter(
          b => !(new Date(b.start) < oldEnd && oldStart < new Date(b.end))
        );
      }
      const expanded = expandBusyBlocks(busy as any, gapMinutes);

      const exact = findExactSlotForSalesperson(
        cfg,
        sp.id,
        sp.calendarId,
        requested,
        durationMinutes,
        expanded
      );

      if (exact) {
        const eventObj = await updateEvent(
          cal,
          sp.calendarId,
          conv.appointment.bookedEventId,
          cfg.timezone,
          exact.start,
          exact.end
        );

        conv.appointment.status = "confirmed";
        conv.appointment.whenText = formatSlotLocal(exact.start, cfg.timezone);
        conv.appointment.whenIso = exact.start;
        conv.appointment.confirmedBy = "customer";
        conv.appointment.updatedAt = new Date().toISOString();
        conv.appointment.acknowledged = true;
        conv.appointment.bookedEventId = eventObj.id ?? conv.appointment.bookedEventId;
        conv.appointment.bookedEventLink = eventObj.htmlLink ?? conv.appointment.bookedEventLink;
        conv.appointment.bookedSalespersonId = sp.id;
        conv.appointment.reschedulePending = false;
        onAppointmentBooked(conv);

        const dealerName =
          (conv as any).dealerProfile?.dealerName ?? "American Harley-Davidson";
        const addressLine = "1149 Erie Ave., North Tonawanda, NY 14120";
        const when = formatSlotLocal(exact.start, cfg.timezone);
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
      }

      const candidatesByDay = generateCandidateSlots(cfg, new Date(), durationMinutes, 14);
      const requestedStartUtc = localPartsToUtcDate(cfg.timezone, requested);
      const requestedDayKey = requested.dayOfWeek;

      const sameDay = candidatesByDay.filter(d => dayKey(d.dayStart, cfg.timezone) === requestedDayKey);
      const pool = sameDay.length > 0 ? sameDay : candidatesByDay;
      const flat = pool.flatMap(d => d.candidates);
      const available = flat.filter(c => !expanded.some(b => c.start < b.end && b.start < c.end));
      available.sort(
        (a, b) =>
          Math.abs(a.start.getTime() - requestedStartUtc.getTime()) -
          Math.abs(b.start.getTime() - requestedStartUtc.getTime())
      );
      const picked = available.slice(0, 2).map(s => ({
        salespersonId: sp.id,
        salespersonName: sp.name,
        calendarId: sp.calendarId,
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

      const stockId = conv.lead?.vehicle?.stockId ?? null;
      const leadNameRaw = conv.lead?.name?.trim() ?? "";
      const firstName = conv.lead?.firstName ?? "";
      const lastName = conv.lead?.lastName ?? "";
      const leadName = leadNameRaw || [firstName, lastName].filter(Boolean).join(" ").trim() || conv.leadKey;

      const summary = `Appt: Inventory Visit – ${leadName}${stockId ? ` – ${stockId}` : ""}`;

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
        slot.calendarId,
        cfg.timezone,
        summary,
        description,
        slot.start,
        slot.end
      );

      // Mark appointment as truly booked
      conv.appointment.status = "confirmed";
      conv.appointment.bookedEventId = eventObj.id ?? null;
      conv.appointment.bookedEventLink = eventObj.htmlLink ?? null;
      conv.appointment.bookedSalespersonId = slot.salespersonId ?? null;
      conv.appointment.acknowledged = true;
      conv.appointment.reschedulePending = false;
      onAppointmentBooked(conv);

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
  const lastOutbound = [...(conv.messages ?? [])]
    .filter(m => m.direction === "out")
    .slice(-1)[0];
  const outboundHoldNotice =
    lastOutbound?.body &&
    /(on hold|hold with deposit|deposit|sale pending|pending|sold|already sold)/i.test(lastOutbound.body);
  const schedulingBlocked =
    conv.followUp?.mode === "manual_handoff" ||
    conv.followUp?.mode === "holding_inventory" ||
    outboundHoldNotice;
  const schedulingExplicit = isExplicitScheduleIntent(event.body);
  console.log("[deterministic-offer] scheduleExplicit", { schedulingExplicit });
  const shortAck =
    /^(ok|okay|k|kk|thanks|thank you|got it|will do|sounds good|sounds great|appreciate it|cool)\b/i.test(
      (event.body ?? "").trim()
    );
  const textLower = String(event.body ?? "").toLowerCase();
  const metaPromoSource = /meta promo offer/i.test(conv.lead?.source ?? "");
  const currentModel = conv.lead?.vehicle?.model ?? conv.lead?.vehicle?.description ?? "";
  const unknownModel = !currentModel || /other|full line/i.test(currentModel);
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
      const firstName = conv.lead?.firstName ?? "";
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
  const lastOutboundText = lastOutbound?.body ?? "";
  const clarificationReply = isClarificationReply(String(event.body ?? ""));
  const lastWasInventoryUncertain =
    /(not seeing|live feed|verify|inventory availability|check.*inventory|follow up shortly)/i.test(
      lastOutboundText
    );
  if (event.provider === "twilio" && clarificationReply && lastWasInventoryUncertain) {
    const reply =
      "Sorry for the confusion — I meant I don’t see that exact bike/color in our live feed yet. " +
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

  const future = parseFutureTimeframe(String(event.body ?? ""), new Date());
  if (event.provider === "twilio" && future) {
    if (future.until) {
      pauseFollowUpCadence(conv, future.until.toISOString(), "future_timeframe");
    } else {
      setFollowUpMode(conv, "paused_indefinite", "future_timeframe");
    }
    const dealerProfile = await getDealerProfile();
    const dealerName = dealerProfile?.dealerName ?? "American Harley-Davidson";
    const agentName = dealerProfile?.agentName ?? "Brooke";
    const label = future.label;
    const labelText = label.charAt(0).toUpperCase() + label.slice(1);
    const replyRaw =
      label === "next week"
        ? "Got it — next week works. Want me to set a reminder, or would you like to pick a day/time now?"
        : `Got it — ${labelText} works. I can set a reminder for you. If you’d rather pick a day/time now, just say the word.`;
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
      "Sounds good — I’ll set a reminder and check back closer to then. If you want pricing or a model comparison sooner, just let me know.";
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

  if (event.provider === "twilio" && conv.inventoryWatchPending) {
    const pending = conv.inventoryWatchPending;
    const pref = parseInventoryWatchPreference(String(event.body ?? ""), pending);
    if (pref.action === "clarify") {
      const reply =
        "Got it — just to confirm, should I watch for the exact year/color, the same year any color, or a year range? " +
        "If a range, tell me the years you want.";
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
      conv.inventoryWatch = pref.watch;
      conv.inventoryWatchPending = undefined;
      setFollowUpMode(conv, "holding_inventory", "inventory_watch");
      stopFollowUpCadence(conv, "holding_inventory");
      const yearText = pref.watch.year
        ? `${pref.watch.year} `
        : pref.watch.yearMin && pref.watch.yearMax
          ? `${pref.watch.yearMin}-${pref.watch.yearMax} `
          : "";
      const colorText = pref.watch.color ? ` in ${pref.watch.color}` : "";
      const reply = `Got it — I’ll keep an eye out for ${yearText}${pref.watch.model}${colorText} and text you as soon as one comes in.`;
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

  const inventoryQuestion =
    /(in stock|available|availability|do you have|any .* in stock)/i.test(textLower) ||
    (!!conv.lead?.vehicle?.model &&
      /\b(\d{4}|blue|black|white|red|green|gray|grey|silver|chrome|trim|color|standard|special|st)\b/i.test(
        textLower
      ));
  if (event.provider === "twilio" && inventoryQuestion && !schedulingBlocked) {
    try {
      const yearMatch = textLower.match(/\b(20\d{2}|19\d{2})\b/);
      const year = yearMatch?.[1] ?? conv.lead?.vehicle?.year ?? null;
      let model =
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
      const color =
        colorTokens.find(c => textLower.includes(c)) ??
        conv.lead?.vehicle?.color ??
        null;

      if (model) {
        let matches = await findInventoryMatches({ year: year ?? null, model });
        if (color) {
          const c = color.toLowerCase();
          matches = matches.filter(i => (i.color ?? "").toLowerCase().includes(c));
        }
        if (matches.length > 0) {
          conv.lead = conv.lead ?? {};
          conv.lead.vehicle = conv.lead.vehicle ?? {};
          if (year) conv.lead.vehicle.year = year;
          conv.lead.vehicle.model = model ?? conv.lead.vehicle.model;
          if (color) conv.lead.vehicle.color = color;
          const imageUrl =
            matches.find(m => Array.isArray(m.images) && m.images.length)?.images?.[0] ?? null;
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
        }
        const reply =
          `I’m not seeing ${year ? `${year} ` : ""}${model}${color ? ` in ${color}` : ""} in our live feed. ` +
          (isGenericModel
            ? "I’ll have someone verify and follow up shortly."
            : "Do you want me to watch for the exact year/color, the same year any color, or a year range?");
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
    !schedulingBlocked
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
    const schedulingIntent = (ctxSuggestsScheduling || llmSuggestsScheduling) && schedulingExplicit;
    if (schedulingIntent) {
      try {
        const cfg = await getSchedulerConfig();
        const requested = parseRequestedDayTime(String(event.body ?? ""), cfg.timezone);
        if (requested) {
          console.log("[deterministic-offer] skip explicit day/time request");
          // Let orchestrator/exact-booking handle explicit day+time requests.
        } else {
        const appointmentTypes = cfg.appointmentTypes ?? { inventory_visit: { durationMinutes: 60 } };
        const preferredSalespeople = getPreferredSalespeople(cfg);
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
            const firstName = conv.lead?.firstName ?? "";
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
            const created = await insertEvent(
              cal,
              chosen.calendarId,
              cfg.timezone,
              summary,
              description,
              chosen.start,
              chosen.end
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
          const reply = `I have ${bestSlots[0].startLocal} or ${bestSlots[1].startLocal} — do any of these times work?`;
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

  const history = conv.messages.slice(-20).map(m => ({ direction: m.direction, body: m.body }));
  const result = await orchestrateInbound(event, history, {
    appointment: conv.appointment,
    followUp: conv.followUp,
    leadSource: conv.lead?.source ?? null,
    bucket: conv.classification?.bucket ?? null,
    cta: conv.classification?.cta ?? null,
    lead: conv.lead ?? null,
    pricingAttempts: getPricingAttempts(conv)
  });
  console.log("[twilio] result.suggestedSlots len:", result.suggestedSlots?.length ?? 0);
  if ((result.suggestedSlots?.length ?? 0) === 0 && draftHasSpecificTimes(result.draft ?? "")) {
    result.draft = "What day and time works for you to stop in?";
  }
  if (result.handoff?.required) {
    const reason = result.handoff.reason;
    const dealerProfile = await getDealerProfile();
    const dealerName = dealerProfile?.dealerName ?? "American Harley-Davidson";
    const agentName = dealerProfile?.agentName ?? "Brooke";
    const ack = ensureUniqueDraft(result.handoff.ack, conv, dealerName, agentName);
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
    console.log("[scheduler] persist suggestedSlots", result.suggestedSlots.length);
    setLastSuggestedSlots(conv, result.suggestedSlots);
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
  }

  if (!didConfirm && result.requestedTime) {
    try {
      const skipExactBooking = /(this time|same time)/i.test(event.body);
      const cfg = await getSchedulerConfig();
      const appointmentTypes = cfg.appointmentTypes ?? { inventory_visit: { durationMinutes: 60 } };
      const preferredSalespeople = getPreferredSalespeople(cfg);
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
            const firstName = conv.lead?.firstName ?? "";
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
            onAppointmentBooked(conv);

            if (conv.scheduler) {
              conv.scheduler.lastSuggestedSlots = [];
              conv.scheduler.updatedAt = new Date().toISOString();
            }

            const dealerName =
              (conv as any).dealerProfile?.dealerName ?? "American Harley-Davidson";
            const addressLine = "1149 Erie Ave., North Tonawanda, NY 14120";
            const when = formatSlotLocal(exact.start, cfg.timezone);
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
        const reply = `${prefix ? `${prefix} ` : ""}I have ${bestSlots[0].startLocal} or ${bestSlots[1].startLocal} — do any of these times work?`;
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
  let reply = ensureUniqueDraft(result.draft, conv, dealerName, agentName);
  if (!schedulingExplicit && draftHasSchedulingPrompt(reply)) {
    reply = "If you’d like, I can set a reminder for you or help with pricing/model comparisons.";
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
      const pending = chooseSlotFromReply(result.suggestedSlots, reply);
      if (pending && conv.scheduler) {
        conv.scheduler.pendingSlot = pending;
        conv.scheduler.updatedAt = new Date().toISOString();
      }
    }
    console.log("[twilio] result.suggestedSlots len:", result.suggestedSlots?.length ?? 0);
    appendOutbound(conv, event.to, event.from, reply, "draft_ai");
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
    const pending = chooseSlotFromReply(result.suggestedSlots, reply);
    if (pending && conv.scheduler) {
      conv.scheduler.pendingSlot = pending;
      conv.scheduler.updatedAt = new Date().toISOString();
    }
  }
  appendOutbound(conv, event.to, event.from, reply, "twilio");
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

  const customerRaw = String(req.query?.customer ?? req.body?.To ?? "").trim();
  const agentDigits = String(req.query?.agentDigits ?? "").trim();
  const agentNameRaw = String(req.query?.agentName ?? "").trim();
  const customerPhone = normalizePhone(customerRaw);
  const leadKey = String(req.query?.leadKey ?? "").trim();
  const from = process.env.TWILIO_FROM_NUMBER ?? "";

  const recordingCb = `${publicBase ?? `${req.protocol}://${req.get("host")}`}/webhooks/twilio/voice/recording?leadKey=${encodeURIComponent(leadKey)}${agentNameRaw ? `&agentName=${encodeURIComponent(agentNameRaw)}` : ""}`;

  const response = new (twilio as any).twiml.VoiceResponse();
  if (agentDigits) {
    response.pause({ length: 1 });
    response.play({ digits: agentDigits });
    response.pause({ length: 1 });
  }
  if (customerPhone && customerPhone.startsWith("+")) {
    const dial = response.dial({
      callerId: from,
      answerOnBridge: true,
      timeout: 30,
      record: "record-from-answer-dual",
      recordingStatusCallback: recordingCb,
      recordingStatusCallbackEvent: ["completed"]
    });
    dial.number(customerPhone);
  } else {
    response.say("No customer number provided.");
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
  const recordingUrl = String(req.body?.RecordingUrl ?? "").trim();
  const recordingSid = String(req.body?.RecordingSid ?? "").trim();

  if (!leadKey || !recordingUrl) {
    return res.json({ ok: false, error: "missing leadKey or RecordingUrl" });
  }

  const conv = getConversation(leadKey);
  if (!conv) return res.json({ ok: true });

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
    const body = transcript
      ? `Call transcript:\n${transcript}`
      : `Call recording saved: ${mp3Url}`;
    appendInbound(conv, {
      channel: "sms",
      provider: "voice_transcript",
      from: "voice",
      to: conv.leadKey,
      body,
      providerMessageId: recordingSid || undefined,
      receivedAt: new Date().toISOString()
    });
    saveConversation(conv);
    await flushConversationStore();
    return res.json({ ok: true });
  } catch (err: any) {
    console.warn("[voice] recording handle failed:", err?.message ?? err);
    return res.json({ ok: false, error: "recording handle failed" });
  }
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
  console.log("   - POST   /conversations/:id/send");
  console.log("   - GET    /todos");
  console.log("   - POST   /todos/:convId/:todoId/done");
  console.log("   - GET    /suppressions");
  console.log("   - POST   /suppressions");
  console.log("   - DELETE /suppressions/:phone");
  console.log("   - POST   /crm/tlp/log-contact");
  console.log("   - POST   /webhooks/twilio");
});
