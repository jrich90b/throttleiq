import "dotenv/config";
import express from "express";
import cors from "cors";
import twilio from "twilio";
import { orchestrateInbound } from "./domain/orchestrator.js";
import type { InboundMessageEvent } from "./domain/types.js";
import { sendgridInboundMiddleware, handleSendgridInbound } from "./routes/sendgridInbound.js";
import { resolveInventoryUrlByStock } from "./domain/inventoryUrlResolver.js";
import { checkInventorySalePendingByUrl } from "./domain/inventoryChecker.js";
import { getDealerProfile } from "./domain/dealerProfile.js";
import { getSchedulerConfig, dayKey } from "./domain/schedulerConfig.js";
import {
  getOAuthClient,
  saveTokens,
  getAuthedCalendarClient,
  queryFreeBusy,
  insertEvent,
  updateEvent
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
  setConversationMode
} from "./domain/conversationStore.js";
import { logTuningRow } from "./domain/tuningLogger.js";
import {
  addSuppression,
  isSuppressed,
  listSuppressions,
  removeSuppression
} from "./domain/suppressionStore.js";
import { tlpLogCustomerContact } from "./connectors/crm/tlpPlaywright.js";

import { getSystemMode, setSystemMode, type SystemMode } from "./domain/settingsStore.js";

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

function effectiveMode(conv: any): SystemMode {
  if (conv?.mode === "human") return "suggest";
  return getSystemMode();
}

setInterval(() => {
  void processDueFollowUps();
}, 60_000);

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "api",
    ts: new Date().toISOString(),
    systemMode: getSystemMode()
  });
});

// ✅ System-wide mode (suggest vs autopilot)
app.get("/settings", (_req, res) => {
  res.json({ ok: true, mode: getSystemMode() });
});

app.patch("/settings", (req, res) => {
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
  "Want to come by this week? What day works for you?",
  "Still interested? I can set a time - what day/time should I reserve?",
  "If you're still shopping, what day/time is easiest for you?",
  "No rush - if you want to see it, what day/time should I put down?",
  "Do you want to set a visit? What day/time works best?",
  "Last check-in from me - should I keep a time available for you? If so, what day/time?",
  "I don't want to bother you - should I keep this open, or close it out?"
];

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

async function buildDay2Options(
  cfg: Awaited<ReturnType<typeof getSchedulerConfig>>
): Promise<{ message: string; slots: any[] } | null> {
  const appointmentTypes = cfg.appointmentTypes ?? { inventory_visit: { durationMinutes: 60 } };
  const preferredSalespeople = cfg.preferredSalespeople ?? [];
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
    if (cadence.stepIndex === 0) {
      const day2 = await buildDay2Options(cfg);
      if (day2) {
        message = day2.message;
        setLastSuggestedSlots(conv, day2.slots);
      } else {
        message = FOLLOW_UP_MESSAGES[1];
      }
    }

    const systemMode = effectiveMode(conv);
    const to = normalizePhone(conv.leadKey);
    const from = process.env.TWILIO_FROM_NUMBER;
    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken = process.env.TWILIO_AUTH_TOKEN;

    if (systemMode === "suggest") {
      appendOutbound(conv, from ?? "salesperson", to, message, "draft_ai");
      advanceFollowUpCadence(conv, cfg.timezone);
      continue;
    }

    if (!from || !accountSid || !authToken || !to.startsWith("+")) {
      appendOutbound(conv, "salesperson", to, message, "human");
      advanceFollowUpCadence(conv, cfg.timezone);
      continue;
    }

    try {
      const client = twilio(accountSid, authToken);
      const msg = await client.messages.create({ from, to, body: message });
      appendOutbound(conv, from, to, message, "twilio", msg.sid);
      advanceFollowUpCadence(conv, cfg.timezone);
    } catch (e: any) {
      console.log("[followup] send failed:", e?.message ?? e);
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
  const preferredSalespeople = cfg.preferredSalespeople ?? [];
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


app.get("/debug/inventory/:stock", async (req, res) => {
  const stock = String(req.params.stock ?? "").trim();
  if (!stock) return res.status(400).json({ ok: false, error: "missing stock" });

  const resolved = await resolveInventoryUrlByStock(stock);
  if (!resolved.ok) return res.json({ ok: true, stock, resolved });

  const status = await checkInventorySalePendingByUrl(resolved.url);
  return res.json({ ok: true, stock, resolved, status });
});

app.get("/debug/dealer-profile", async (_req, res) => {
  const profile = await getDealerProfile();
  res.json({ ok: true, profile });
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

app.post("/conversations/:id/mode", (req, res) => {
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

app.get("/todos", (_req, res) => {
  res.json({ ok: true, todos: listOpenTodos() });
});

app.post("/todos/:convId/:todoId/done", (req, res) => {
  const { convId, todoId } = req.params;
  const task = markTodoDone(convId, todoId);
  const conv = getConversation(convId);
  if (conv) {
    setFollowUpMode(conv, "active", "todo_done");
  }
  if (!task) return res.status(404).json({ ok: false, error: "Todo not found" });
  res.json({ ok: true, todo: task });
});

app.get("/suppressions", (_req, res) => {
  res.json({ ok: true, suppressions: listSuppressions() });
});

app.post("/suppressions", async (req, res) => {
  const phone = String(req.body?.phone ?? "").trim();
  if (!phone) return res.status(400).json({ ok: false, error: "Missing phone" });
  const entry = await addSuppression(phone, String(req.body?.reason ?? "manual"), "ui");
  res.json({ ok: true, entry });
});

app.delete("/suppressions/:phone", async (req, res) => {
  const ok = await removeSuppression(String(req.params.phone ?? ""));
  res.json({ ok });
});

function buildTranscript(conv: any, maxMessages = 60): string {
  const lead = conv.lead ?? {};
  const vehicle = lead.vehicle ?? {};
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

  const messages = conv.messages.slice(-maxMessages).map((m: any) => {
    const when = new Date(m.at).toLocaleString();
    const dir = m.direction === "in" ? "IN" : "OUT";
    const prov = m.provider ? ` ${m.provider}` : "";
    return `[${when}] ${dir}${prov}: ${m.body}`;
  });

  return `${header}\n\nTranscript:\n${messages.join("\n")}`.trim();
}

app.post("/crm/tlp/log-contact", async (req, res) => {
  const leadRef = String(req.body?.leadRef ?? "").trim();
  const conversationId = String(req.body?.conversationId ?? "").trim();
  const categoryValue = req.body?.categoryValue ? String(req.body.categoryValue).trim() : undefined;

  if (!leadRef) return res.status(400).json({ ok: false, error: "Missing leadRef" });
  if (!conversationId) return res.status(400).json({ ok: false, error: "Missing conversationId" });

  const conv = getConversation(conversationId);
  if (!conv) return res.status(404).json({ ok: false, error: "Conversation not found" });

  const note = buildTranscript(conv);

  try {
    await tlpLogCustomerContact({ leadRef, note, categoryValue });
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
    const note = buildTranscript(conv);
    try {
      console.log("📝 TLP env", {
        TLP_USERNAME: process.env.TLP_USERNAME ? "set" : "missing",
        TLP_PASSWORD: process.env.TLP_PASSWORD ? "set" : "missing",
        TLP_BASE_URL: process.env.TLP_BASE_URL ?? "https://tlpcrm.com",
        TLP_HEADLESS: process.env.TLP_HEADLESS ?? "true"
      });
      console.log("📝 TLP log start", { leadRef, convId: conv.id });
      await tlpLogCustomerContact({ leadRef, note });
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

  const event: InboundMessageEvent = {
    channel: "sms",
    provider: "twilio",
    from: String(From ?? "").trim(),
    to: String(To ?? "").trim(),
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
    const preferredSalespeople = cfg.preferredSalespeople ?? [];
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
      const cfg = await getSchedulerConfig();
      const appointmentTypes = cfg.appointmentTypes ?? { inventory_visit: { durationMinutes: 60 } };
      const preferredSalespeople = cfg.preferredSalespeople ?? [];
      const salespeople = cfg.salespeople ?? [];
      const gapMinutes = cfg.minGapBetweenAppointmentsMinutes ?? 60;
      const appointmentType = String(result.requestedAppointmentType ?? "inventory_visit");
      const durationMinutes = appointmentTypes[appointmentType]?.durationMinutes ?? 60;

      const cal = await getAuthedCalendarClient();
      const now = new Date();
      const timeMin = new Date(now).toISOString();
      const timeMax = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000).toISOString();

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

      // exact not available -> suggest closest slots
      const candidatesByDay = generateCandidateSlots(cfg, now, durationMinutes, 14);
      const requestedStartUtc = localPartsToUtcDate(cfg.timezone, result.requestedTime);
      const requestedDayKey = result.requestedTime?.dayOfWeek ?? dayKey(requestedStartUtc, cfg.timezone);

      let bestSlots: any[] = [];
      for (const salespersonId of preferredSalespeople) {
        const sp = salespeople.find((p: any) => p.id === salespersonId);
        if (!sp) continue;

        const fb = await queryFreeBusy(cal, [sp.calendarId], timeMin, timeMax, cfg.timezone);
        const busy = (fb.calendars?.[sp.calendarId]?.busy ?? []) as any;
        const expanded = expandBusyBlocks(busy, gapMinutes);

        const sameDay = candidatesByDay.filter(d => dayKey(d.dayStart, cfg.timezone) === requestedDayKey);
        const requestedDaySpecified = !!result.requestedTime?.dayOfWeek;
        const isRequestedSaturday = requestedDayKey === "saturday";
        const nextSaturday = candidatesByDay.filter(
          d => dayKey(d.dayStart, cfg.timezone) === "saturday" && d.dayStart.getTime() > now.getTime()
        );

        let pool = sameDay;
        if (pool.length === 0 && requestedDaySpecified && isRequestedSaturday && nextSaturday.length > 0) {
          pool = nextSaturday;
        }
        if (pool.length === 0) {
          pool = candidatesByDay;
        }

        const flat = pool.flatMap(d => d.candidates);
        const available = flat.filter(c => !expanded.some(b => c.start < b.end && b.start < c.end));
        available.sort((a, b) => Math.abs(a.start.getTime() - requestedStartUtc.getTime()) - Math.abs(b.start.getTime() - requestedStartUtc.getTime()));

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
          bestSlots = picked;
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
        if (requestedDaySpecified && !sameDayHasCandidates) {
          const todayKey = dayKey(now, cfg.timezone);
          if (todayKey === requestedDayKey) {
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
    appendOutbound(conv, event.to, event.from, reply, "draft_ai");
    if (!hadOutbound) {
      await maybeStartCadence(conv, new Date().toISOString());
    }
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response></Response>`;
    return res.status(200).type("text/xml").send(twiml);
  }

  // autopilot
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
