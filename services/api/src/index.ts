import "dotenv/config";
import express from "express";
import cors from "cors";
import twilio from "twilio";
import { orchestrateInbound } from "./domain/orchestrator.js";
import type { InboundMessageEvent } from "./domain/types.js";
import { sendgridInboundMiddleware, handleSendgridInbound } from "./routes/sendgridInbound.js";
import { resolveInventoryUrlByStock } from "./domain/inventoryUrlResolver.js";
import { checkInventorySalePendingByUrl } from "./domain/inventoryChecker.js";
import { getDealerProfile, saveDealerProfile } from "./domain/dealerProfile.js";
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
import { extractImageDate, findInventoryMatches, findInventoryPrice } from "./domain/inventoryFeed.js";

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
  stopFollowUpCadence,
  advanceFollowUpCadence,
  getAllConversations,
  finalizeDraftAsSent,
  discardPendingDrafts,
  addTodo,
  listOpenTodos,
  markTodoDone,
  deleteConversation,
  setFollowUpMode,
  incrementPricingAttempt,
  markPricingEscalated,
  getPricingAttempts,
  closeConversation,
  setConversationMode,
  setCrmLastLoggedAt,
  reloadConversationStore
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

const app = express();
app.use(cors());
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
  const tokenHeader = req.header("x-auth-token") || req.header("authorization")?.replace(/^Bearer\s+/i, "");
  const cookies = parseCookies(req.header("cookie"));
  const token = tokenHeader || cookies.lr_session;
  if (!token) return res.status(401).json({ ok: false, error: "auth required" });
  const session = await getSession(token);
  if (!session) return res.status(401).json({ ok: false, error: "invalid session" });
  const user = await getUserById(session.userId);
  if (!user) return res.status(401).json({ ok: false, error: "user not found" });
  (req as any).user = user;
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

setInterval(() => {
  void processDueFollowUps();
  void processAppointmentConfirmations();
}, 60_000);

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "api",
    ts: new Date().toISOString(),
    systemMode: getSystemMode()
  });
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
    user: { id: user.id, email: user.email, name: user.name, role: user.role, calendarId: user.calendarId, permissions: user.permissions }
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
    user: { id: user.id, email: user.email, name: user.name, role: user.role, calendarId: user.calendarId, permissions: user.permissions }
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
  const permissions = req.body?.permissions ?? undefined;
  if (!email || !password) return res.status(400).json({ ok: false, error: "Missing email/password" });
  try {
    const user = await createUser({ email, password, role, name, calendarId, permissions });
    await syncSchedulerSalespeopleFromUsers();
    res.json({
      ok: true,
      user: { id: user.id, email: user.email, name: user.name, role: user.role, calendarId: user.calendarId, permissions: user.permissions }
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
      permissions: req.body?.permissions
    });
    await syncSchedulerSalespeopleFromUsers();
    res.json({
      ok: true,
      user: { id: user.id, email: user.email, name: user.name, role: user.role, calendarId: user.calendarId, permissions: user.permissions }
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

const FOLLOW_UP_MESSAGES = [
  "Just checking in - still want to come by to look at it? I have {a} or {b} if that helps.",
  "If you'd like a quick walkaround video first, I can send one. If you'd rather come by, what day works best for you?",
  "If you still want to see it, what day/time is best on your end?",
  "Quick question — are you comparing a few bikes, or is this one at the top of your list?",
  "Still interested? I can set a time - what day/time should I reserve?",
  "If you're still shopping, what day/time is easiest for you?",
  "No rush - if you want to see it, what day/time should I put down?",
  "Do you want to set a visit? What day/time works best?",
  "Should I keep a time available for you? If so, what day/time?",
  "Still interested in taking a look? If so, what day/time works best?"
];

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

  if (stepIndex === 10) {
    if (!hasMatch && !testRideOk) {
      return {
        body: `${greeting}Just checking in on the ${label}. If you’re still looking, I can keep an eye out or set a time to visit. What works best?`
      };
    }
    if (hasMatch && hasRecentInventory) {
      return {
        body: `${greeting}We just got a ${label} in. Want to come check it out? What day/time works best?`
      };
    }
    if (hasMatch) {
      return {
        body: `${greeting}We have ${label} options in stock. Want to stop by and take a look? What day/time works best?`
      };
    }
    return {
      body: `${greeting}Just checking in on the ${label}. If you’re still looking, I can keep an eye out or set a time to visit. What works best?`
    };
  }

  if (stepIndex === 11) {
    if (!hasMatch && !testRideOk) {
      return {
        body: `${greeting}If you’re still shopping, I can help you compare options or set a quick visit. What day/time works best?`
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
    if (testRideOk && hasMatch) {
      return {
        body: `${greeting}If you want, we can set up a test ride for a ${label}. What day/time works best?`
      };
    }
    if (hasMatch) {
      return {
        body: `${greeting}Still interested in a ${label}? I can send a quick walkaround or set a time to visit. What works best?`
      };
    }
    return {
      body: `${greeting}If you’re still shopping, I can help you compare options or set a quick visit. What day/time works best?`
    };
  }

  if (stepIndex === 12) {
    if (!hasMatch && !testRideOk) {
      return {
        body: `${greeting}Should I keep this open or close it out? If you’re still looking, I’m happy to help.`
      };
    }
    if (testRideOk && hasMatch) {
      return {
        body: `${greeting}We’re offering test rides this time of year. Want me to reserve a time for you?`
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
  const hasLicense = lead?.hasMotoLicense;
  const canTestRide = hasLicense !== false && isTestRideSeason(dealerProfile, new Date());

  if (imagePick?.url) {
    const colorLabel = colorLabelRaw ? colorLabelRaw.charAt(0).toUpperCase() + colorLabelRaw.slice(1) : null;
    const itemLabel = colorLabel ? `${colorLabel} ${label}` : label;
    return {
      body: `${greeting}Just circling back since you mentioned a ${timeframe} timeline. We have a ${itemLabel} in stock right now. Want to take a look?`,
      mediaUrls: [imagePick.url]
    };
  }

  if (canTestRide) {
    return {
      body: `${greeting}Just circling back since you mentioned a ${timeframe} timeline. Want to come in and check out options or set up a test ride?`
    };
  }

  return {
    body: `${greeting}Just circling back since you mentioned a ${timeframe} timeline. Want to come in and check out options?`
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

function normalizeTimeToken(s: string): string {
  return s
    .toLowerCase()
    .replace(/\./g, "")
    .replace(/\s+/g, "")
    .replace(/^0+/, "");
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
  m = s.match(/\b(\d{3,4})\s*(am|pm)?\b/);
  if (m) {
    const digits = m[1];
    const ap = m[2] ?? "";
    const d = digits.padStart(4, "0");
    const hh = String(Number(d.slice(0, 2)));
    const mm = d.slice(2, 4);
    return normalizeTimeToken(`${hh}:${mm}${ap}`);
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

  for (const conv of convs) {
    const cadence = conv.followUpCadence;
    if (!cadence || cadence.status !== "active" || !cadence.nextDueAt) continue;
    if (conv.status === "closed") {
      stopFollowUpCadence(conv, "closed");
      continue;
    }
    if (isSuppressed(conv.leadKey)) {
      stopFollowUpCadence(conv, "suppressed");
      continue;
    }
    if (new Date(cadence.nextDueAt) > now) continue;
    if (conv.appointment?.bookedEventId) {
      stopFollowUpCadence(conv, "appointment_booked");
      continue;
    }
    if (conv.followUp?.mode === "holding_inventory") continue;
    if (conv.followUp?.mode === "manual_handoff") continue;

    let message = FOLLOW_UP_MESSAGES[cadence.stepIndex] ?? FOLLOW_UP_MESSAGES[FOLLOW_UP_MESSAGES.length - 1];
    let mediaUrls: string[] | undefined;
    if (cadence.kind === "long_term") {
      const longTerm = await buildLongTermFollowUp(conv, dealerProfile);
      message = longTerm.body;
      mediaUrls = longTerm.mediaUrls;
    } else if (cadence.stepIndex === 0) {
      const day2 = await buildDay2Options(cfg);
      if (day2) {
        message = day2.message;
        setLastSuggestedSlots(conv, day2.slots);
      } else {
        message = FOLLOW_UP_MESSAGES[1];
      }
    } else if (cadence.stepIndex === 2) {
      const hasLicense = conv?.lead?.hasMotoLicense;
      const canTestRide = hasLicense !== false && isTestRideSeason(dealerProfile, new Date());
      if (canTestRide) {
        message = "If you’d like to set up a test ride, I can reserve a time. What day/time works best?";
      } else {
        message = FOLLOW_UP_MESSAGES[2];
      }
    } else if (cadence.stepIndex >= 10) {
      const late = await buildLateFollowUp(conv, cadence.stepIndex, dealerProfile);
      message = late.body;
      mediaUrls = late.mediaUrls;
    }

    const systemMode = effectiveMode(conv);
    const to = normalizePhone(conv.leadKey);
    const from = process.env.TWILIO_FROM_NUMBER;
    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken = process.env.TWILIO_AUTH_TOKEN;

    if (systemMode === "suggest") {
      appendOutbound(conv, from ?? "salesperson", to, message, "draft_ai", undefined, mediaUrls);
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
  const summary = `Appt: ${String(req.body?.appointmentType ?? "inventory_visit")} – ${lead?.firstName ?? ""} ${
    lead?.lastName ?? ""
  }`.trim();

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
      stopFollowUpCadence(conv, "appointment_booked");
    }
  }

  return res.json({
    ok: true,
    eventId: event.id,
    htmlLink: event.htmlLink,
    salesperson: salesperson ? { id: salesperson.id, name: salesperson.name } : null
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
      return res.json({ ok: true, busyByUserId: {} });
    }

    const users = await listUsers();
    const byId = new Map(users.map(u => [u.id, u]));
    const cal = await getAuthedCalendarClient();
    const busyByUserId: Record<string, any[]> = {};

    for (const userId of userIds) {
      const user = byId.get(userId);
      if (!user?.calendarId) continue;
      const fb = await queryFreeBusy(cal, [user.calendarId], start, end, timeZone);
      const busy = fb.calendars?.[user.calendarId]?.busy ?? [];
      busyByUserId[userId] = busy;
    }

    return res.json({ ok: true, busyByUserId });
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

app.put("/dealer-profile", requireManager, async (req, res) => {
  const saved = await saveDealerProfile(req.body ?? {});
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

app.get("/conversations/:id", (req, res) => {
  const conv = getConversation(req.params.id);
  if (!conv) return res.status(404).json({ ok: false, error: "Not found" });
  res.json({ ok: true, systemMode: getSystemMode(), conversation: conv });
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

app.post("/conversations/:id/close", (req, res) => {
  const conv = getConversation(req.params.id);
  if (!conv) return res.status(404).json({ ok: false, error: "Not found" });
  const reason = String(req.body?.reason ?? "closed").trim() || "closed";
  closeConversation(conv, reason);
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
    setFollowUpMode(conv, "active", "todo_done");
  }
  if (!task) return res.status(404).json({ ok: false, error: "Todo not found" });
  res.json({ ok: true, todo: task });
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
  const editNote = req.body?.editNote ? String(req.body.editNote).trim() : null;
  const draftCandidate = draftId
    ? conv.messages.find(m => m.id === draftId)
    : getLatestPendingDraft(conv);
  const draft =
    draftCandidate && draftCandidate.provider === "draft_ai" ? draftCandidate : null;

  // Normalize destination number from conversation leadKey
  const rawTo = String(conv.leadKey ?? "").trim();
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
      await logTuningRow({
        ts: new Date().toISOString(),
        leadKey: conv.leadKey,
        leadSource: conv.lead?.source ?? null,
        bucket: conv.classification?.bucket ?? null,
        cta: conv.classification?.cta ?? null,
        channel: conv.classification?.channel ?? "sms",
        draftId: draft?.id ?? null,
        draft: draft?.body ?? null,
        final: body,
        edited: draft ? draft.body.trim() !== body.trim() : null,
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
    }
  };

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
    if (manualTakeover) setConversationMode(conv.id, "human");
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
    if (manualTakeover) setConversationMode(conv.id, "human");
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
    if (manualTakeover) setConversationMode(conv.id, "human");
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
    if (manualTakeover) setConversationMode(conv.id, "human");
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
  if (isSuppressed(event.from)) {
    stopFollowUpCadence(conv, "suppressed");
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response></Response>`;
    return res.status(200).type("text/xml").send(twiml);
  }
  if (getSystemMode() === "suggest") {
    discardPendingDrafts(conv, "new_inbound");
  }
  if (isOptOut(event.body)) {
    await addSuppression(event.from, "sms_stop", "twilio");
    stopFollowUpCadence(conv, "opt_out");
    const reply = "Understood - I'll stop texting.";
    const systemMode = effectiveMode(conv);
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
    const reply = "Totally understand - I won't bug you. If anything changes, just let me know.";
    const systemMode = effectiveMode(conv);
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

  const isAffirmative = (text: string) =>
    /\b(yes|yep|yeah|yup|ok|okay|sure|confirmed|confirm|works|that works|sounds good)\b/i.test(
      text
    );

  // Auto-book if they confirmed a pending slot
  if (!conv.appointment?.bookedEventId && conv.scheduler?.pendingSlot && isAffirmative(event.body)) {
    const chosen = conv.scheduler.pendingSlot;
    try {
      const cfg = await getSchedulerConfig();
      const tz = cfg.timezone || "America/New_York";
      const cal = await getAuthedCalendarClient();

      const stockId = conv.lead?.vehicle?.stockId ?? null;
      const firstName = conv.lead?.firstName ?? "";
      const leadName = firstName ? firstName : conv.leadKey;
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
      stopFollowUpCadence(conv, "appointment_booked");

      if (conv.scheduler) {
        conv.scheduler.pendingSlot = undefined;
        conv.scheduler.updatedAt = new Date().toISOString();
      }

      console.log("[auto-book] chosen slot", chosen?.startLocal, chosen?.calendarId);
      console.log("[auto-book] booked", created?.id, "calendarId", chosen.calendarId);

      const reply = `Perfect — you’re all set for ${conv.appointment.whenText}. See you then.`;
      const systemMode = effectiveMode(conv);
      if (systemMode === "suggest") {
        appendOutbound(conv, event.to, event.from, reply, "draft_ai");
        const twiml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response></Response>`;
        return res.status(200).type("text/xml").send(twiml);
      }
      appendOutbound(conv, event.to, event.from, reply, "twilio", created.id ?? undefined);
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
        const firstName = conv.lead?.firstName ?? "";
        const leadName = firstName ? firstName : conv.leadKey;
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
        stopFollowUpCadence(conv, "appointment_booked");

        if (conv.scheduler) {
          conv.scheduler.pendingSlot = undefined;
          conv.scheduler.updatedAt = new Date().toISOString();
        }

        console.log("[auto-book] booked", created?.id, "calendarId", chosen.calendarId);

        const reply = `Perfect — you’re all set for ${conv.appointment.whenText}. See you then.`;
        const systemMode = effectiveMode(conv);
        if (systemMode === "suggest") {
          appendOutbound(conv, event.to, event.from, reply, "draft_ai");
          const twiml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response></Response>`;
          return res.status(200).type("text/xml").send(twiml);
        }
        appendOutbound(conv, event.to, event.from, reply, "twilio", created.id ?? undefined);
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
        : "No problem — I’ve cancelled it. What day/time works best to reschedule?";
      const systemMode = effectiveMode(conv);
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
    const systemMode = effectiveMode(conv);
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
    const rescheduleIntent = reschedulePending || reschedulePhrase || !!requestedReschedule;
    if (!rescheduleIntent) {
      // fall through
    } else {
      const requested = requestedReschedule;
    if (!requested) {
      const ask = "Absolutely — what day and time works best for you?";
      conv.appointment.reschedulePending = true;
      conv.appointment.updatedAt = new Date().toISOString();
      const systemMode = effectiveMode(conv);
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
        stopFollowUpCadence(conv, "appointment_booked");

        const dealerName =
          (conv as any).dealerProfile?.dealerName ?? "American Harley-Davidson";
        const addressLine = "1149 Erie Ave., North Tonawanda, NY 14120";
        const when = formatSlotLocal(exact.start, cfg.timezone);
        const repName = sp.name ? ` with ${sp.name}` : "";
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
        conv.appointment.reschedulePending = true;
        conv.appointment.updatedAt = new Date().toISOString();
        const reply = `I can reschedule you. I have ${picked[0].startLocal} or ${picked[1].startLocal} — which works best?`;
        const systemMode = effectiveMode(conv);
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
      stopFollowUpCadence(conv, "appointment_booked");

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

      const systemMode = effectiveMode(conv);
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
      const firstName = conv.lead?.firstName ?? "";
      const leadName = firstName ? firstName : conv.leadKey;

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
      stopFollowUpCadence(conv, "appointment_booked");

      // Clear suggested slots so we don’t reuse stale ones
      if (conv.scheduler) {
        conv.scheduler.lastSuggestedSlots = [];
        conv.scheduler.updatedAt = new Date().toISOString();
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
      const systemMode = effectiveMode(conv);
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
    result.draft = "What day and time works best for you to stop in?";
  }
  if (result.handoff?.required) {
    const reason = result.handoff.reason;
    const ack = result.handoff.ack;
    addTodo(conv, reason, event.body, event.providerMessageId);
    setFollowUpMode(conv, "manual_handoff", `handoff:${reason}`);
    stopFollowUpCadence(conv, "manual_handoff");
    if (reason === "pricing" || reason === "payments") {
      markPricingEscalated(conv);
    }
    appendOutbound(conv, event.to, event.from, ack, "twilio");
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n  <Message>${escapeXml(
      ack
    )}</Message>\n</Response>`;
    return res.status(200).type("text/xml").send(twiml);
  }
  if (result.autoClose?.reason) {
    const ack = result.draft;
    closeConversation(conv, result.autoClose.reason);
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
            const firstName = conv.lead?.firstName ?? "";
            const leadName = firstName ? firstName : conv.leadKey;

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

            const dealerName =
              (conv as any).dealerProfile?.dealerName ?? "American Harley-Davidson";
            const addressLine = "1149 Erie Ave., North Tonawanda, NY 14120";
            const when = formatSlotLocal(exact.start, cfg.timezone);
            const repName = sp.name ? ` with ${sp.name}` : "";
            const confirmText =
              `Perfect — you’re booked for ${when}${repName}. ` +
              `${dealerName} is at ${addressLine}.`;

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
        const reply = `${prefix ? `${prefix} ` : ""}I have ${bestSlots[0].startLocal} or ${bestSlots[1].startLocal} — which works best?`;
        const systemMode = effectiveMode(conv);
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
    } catch (e: any) {
      console.log("[exact-book] failed:", e?.message ?? e);
    }
  }

  if (!result.shouldRespond) {
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response></Response>`;
    return res.status(200).type("text/xml").send(twiml);
  }

  const reply = result.draft;
  const systemMode = effectiveMode(conv);
  const hadOutbound = conv.messages.some(m => m.direction === "out");

  // ✅ Global behavior:
  // - suggest: store a draft, do NOT auto-send
  // - autopilot: send immediately and log as twilio (no separate draft)
  if (systemMode === "suggest") {
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
  console.log("[twilio] result.suggestedSlots len:", result.suggestedSlots?.length ?? 0);
  appendOutbound(conv, event.to, event.from, reply, "twilio");
  if (!hadOutbound) {
    await maybeStartCadence(conv, new Date().toISOString());
  }

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n  <Message>${escapeXml(
    reply
  )}</Message>\n</Response>`;
  return res.status(200).type("text/xml").send(twiml);
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
