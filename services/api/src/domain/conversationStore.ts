import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { InboundMessageEvent } from "./types.js";
import { fileURLToPath } from "node:url";
import { dataPath } from "./dataDir.js";

export type ConversationMode = "autopilot" | "suggest" | "human";
export type MessageProvider = "twilio" | "sendgrid_adf" | "draft_ai" | "human";

export type AppointmentStatus = "none" | "proposed" | "confirmed";

export type AppointmentMemory = {
  status: AppointmentStatus;
  whenText?: string;
  whenIso?: string | null;
  confirmedBy?: "customer" | "salesperson";
  updatedAt: string;
  sourceMessageId?: string;
  acknowledged?: boolean;
  bookedEventId?: string | null;
  bookedEventLink?: string | null;
  bookedSalespersonId?: string | null;
  reschedulePending?: boolean;
  confirmation?: {
    sentAt?: string;
    status?: "pending" | "confirmed" | "declined";
    respondedAt?: string;
  };
  matchedSlot?: {
    salespersonId: string;
    salespersonName?: string;
    calendarId: string;
    start: string;
    end: string;
    startLocal?: string;
    endLocal?: string;
    appointmentType?: string;
  };
};

export type SchedulerMemory = {
  lastSuggestedSlots?: Array<{
    salespersonId: string;
    salespersonName?: string;
    calendarId: string;
    start: string;
    end: string;
    startLocal?: string;
    endLocal?: string;
    appointmentType?: string;
  }>;
  requested?: { day?: string; timeText?: string; requestedAt: string };
  updatedAt: string;
};

export type FollowUpCadence = {
  status: "active" | "stopped" | "completed";
  anchorAt: string;
  nextDueAt?: string;
  stepIndex: number;
  lastSentAt?: string;
  lastSentStep?: number;
  stopReason?: string;
  kind?: "standard" | "long_term";
  deferredMessage?: string;
};

export type PricingObjectionState = {
  attempts: number;
  lastAt?: string;
  escalated?: boolean;
};

export type ObjectionState = {
  pricing?: PricingObjectionState;
};

export type TodoTask = {
  id: string;
  convId: string;
  leadKey: string;
  reason: "pricing" | "payments" | "approval" | "manager" | "other";
  summary: string;
  createdAt: string;
  sourceMessageId?: string;
  status: "open" | "done";
  doneAt?: string;
};

export type LeadProfile = {
  leadRef?: string;
  source?: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
  channelPreference?: "sms" | "email" | "facebook_messenger";
  purchaseTimeframe?: string;
  purchaseTimeframeMonthsStart?: number;
  purchaseTimeframeMonthsEnd?: number;
  hasMotoLicense?: boolean;
  vehicle?: {
    stockId?: string;
    vin?: string;
    year?: string;
    model?: string;
    color?: string;
    condition?: string;
    url?: string;
    inventoryStatus?: "AVAILABLE" | "PENDING" | "UNKNOWN";
    description?: string;
    listPrice?: number;
    priceRange?: { min: number; max: number; count: number };
  };
};

export type Message = {
  id: string;
  direction: "in" | "out";
  from: string;
  to: string;
  body: string;
  mediaUrls?: string[];
  at: string; // ISO
  provider?: MessageProvider;
  providerMessageId?: string; // e.g., Twilio SID for sent messages
  draftStatus?: "pending" | "stale";
};

export type Conversation = {
  id: string; // leadKey (phone/email) for now
  leadKey: string;
  mode: ConversationMode;
  status?: "open" | "closed";
  closedAt?: string;
  closedReason?: string;
  createdAt: string;
  updatedAt: string;
  messages: Message[];
  lead?: LeadProfile;
  classification?: { bucket?: string; cta?: string; channel?: string; ruleName?: string };
  appointment?: AppointmentMemory;
  followUp?: { mode: "active" | "holding_inventory" | "manual_handoff"; reason?: string; updatedAt: string };
  scheduler?: SchedulerMemory;
  followUpCadence?: FollowUpCadence;
  objections?: ObjectionState;
  crm?: { lastLoggedAt?: string };
};

const conversations = new Map<string, Conversation>();
const todos: TodoTask[] = [];

function nowIso() {
  return new Date().toISOString();
}

function makeId(prefix: string) {
  return `${prefix}_${Math.random().toString(16).slice(2)}_${Date.now()}`;
}

/**
 * JSON persistence (dev/prototype):
 * - Loads on startup
 * - Saves after mutations (debounced)
 *
 * Configure path via env:
 *   CONVERSATIONS_DB_PATH=/absolute/or/relative/path.json
 */
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEFAULT_DB_PATH = dataPath("conversations.json");

const DB_PATH = process.env.CONVERSATIONS_DB_PATH
  ? path.resolve(process.env.CONVERSATIONS_DB_PATH)
  : DEFAULT_DB_PATH;

let saveTimer: NodeJS.Timeout | null = null;
let isSaving = false;

async function ensureDirForFile(filePath: string) {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
}

async function loadFromDisk() {
  try {
    const raw = await fs.readFile(DB_PATH, "utf8");
    const parsed = JSON.parse(raw) as { conversations?: Conversation[]; todos?: TodoTask[] };

    const list = parsed?.conversations ?? [];
    conversations.clear();
    for (const c of list) {
      if (c?.id) conversations.set(c.id, c);
    }
    todos.length = 0;
    if (parsed?.todos?.length) todos.push(...parsed.todos);

    console.log(`📦 Loaded ${conversations.size} conversations from ${DB_PATH}`);
  } catch (err: any) {
    if (err?.code === "ENOENT") {
      // First run, file doesn't exist yet.
      await ensureDirForFile(DB_PATH);
      await saveToDisk(); // create empty file
      console.log(`📦 Created new conversation store at ${DB_PATH}`);
      return;
    }
    console.warn("⚠️ Failed to load conversations store:", err?.message ?? err);
  }
}

export async function reloadConversationStore() {
  await loadFromDisk();
}

async function saveToDisk() {
  if (isSaving) return;
  isSaving = true;

  try {
    await ensureDirForFile(DB_PATH);

    const payload = {
      version: 1,
      savedAt: nowIso(),
      conversations: Array.from(conversations.values()),
      todos
    };

    const json = JSON.stringify(payload, null, 2);

    // Atomic write: write temp then rename
    const tmp = `${DB_PATH}.tmp`;
    await fs.writeFile(tmp, json, "utf8");
    await fs.rename(tmp, DB_PATH);
  } catch (err: any) {
    console.warn("⚠️ Failed to save conversations store:", err?.message ?? err);
  } finally {
    isSaving = false;
  }
}

function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    void saveToDisk();
  }, 250);
}

// Load immediately on module import
void loadFromDisk();

export function upsertConversationByLeadKey(
  leadKey: string,
  defaultMode: ConversationMode = "suggest"
): Conversation {
  const existing = conversations.get(leadKey);
  if (existing) return existing;

  const created: Conversation = {
    id: leadKey,
    leadKey,
    mode: defaultMode,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    messages: []
  };

  conversations.set(leadKey, created);
  scheduleSave();
  return created;
}

export function setConversationMode(id: string, mode: ConversationMode): Conversation | null {
  const conv = conversations.get(id);
  if (!conv) return null;
  conv.mode = mode;
  conv.updatedAt = nowIso();
  scheduleSave();
  return conv;
}

export function appendInbound(conv: Conversation, evt: InboundMessageEvent) {
  conv.messages.push({
    id: makeId("msg"),
    direction: "in",
    from: evt.from,
    to: evt.to,
    body: evt.body,
    at: evt.receivedAt,
    provider: evt.provider as MessageProvider,
    providerMessageId: evt.providerMessageId
  });
  conv.updatedAt = nowIso();
  scheduleSave();
}

export function appendOutbound(
  conv: Conversation,
  from: string,
  to: string,
  body: string,
  provider: MessageProvider = "draft_ai",
  providerMessageId?: string,
  mediaUrls?: string[]
) {
  conv.messages.push({
    id: makeId("msg"),
    direction: "out",
    from,
    to,
    body,
    mediaUrls: mediaUrls && mediaUrls.length ? mediaUrls : undefined,
    at: nowIso(),
    provider,
    providerMessageId
  });
  conv.updatedAt = nowIso();
  scheduleSave();
}

export function finalizeDraftAsSent(
  conv: Conversation,
  draftId: string | undefined,
  finalBody: string,
  provider: MessageProvider,
  providerMessageId?: string
): { usedDraft: boolean; originalDraftBody?: string } {
  if (!draftId) return { usedDraft: false };

  const msg = conv.messages.find(m => m.id === draftId);
  if (!msg) return { usedDraft: false };
  if (msg.direction !== "out" || msg.provider !== "draft_ai") return { usedDraft: false };
  if (msg.draftStatus === "stale") return { usedDraft: false };

  const original = msg.body;
  msg.body = finalBody;
  msg.provider = provider;
  msg.providerMessageId = providerMessageId;
  msg.at = new Date().toISOString();
  msg.draftStatus = undefined;

  conv.updatedAt = new Date().toISOString();
  scheduleSave();

  return { usedDraft: true, originalDraftBody: original };
}

export function mergeConversationLead(conv: Conversation, patch: Partial<LeadProfile>): Conversation {
  const existingLead = conv.lead ?? {};
  const mergedVehicle = patch.vehicle
    ? { ...(existingLead.vehicle ?? {}), ...patch.vehicle }
    : existingLead.vehicle;

  conv.lead = {
    ...existingLead,
    ...patch,
    vehicle: mergedVehicle
  };
  conv.updatedAt = nowIso();
  scheduleSave();
  return conv;
}

export function setConversationClassification(
  conv: Conversation,
  classification: Conversation["classification"]
): Conversation {
  conv.classification = classification;
  conv.updatedAt = nowIso();
  scheduleSave();
  return conv;
}

export function discardPendingDrafts(conv: Conversation, reason?: string) {
  let lastSentIdx = -1;
  for (let i = 0; i < conv.messages.length; i++) {
    const m = conv.messages[i];
    if (m.direction !== "out") continue;
    if (m.provider === "human" || m.provider === "twilio") lastSentIdx = i;
  }
  for (let i = lastSentIdx + 1; i < conv.messages.length; i++) {
    const m = conv.messages[i];
    if (m.direction !== "out") continue;
    if (m.provider === "draft_ai" && m.draftStatus !== "stale") {
      m.draftStatus = "stale";
      if (reason) {
        // Keep body intact; reason is for internal tracking if needed later.
      }
    }
  }
  conv.updatedAt = nowIso();
  scheduleSave();
}

export function getLatestPendingDraft(conv: Conversation): Message | null {
  let lastDraftIdx = -1;
  let lastSentIdx = -1;

  for (let i = 0; i < conv.messages.length; i++) {
    const m = conv.messages[i];
    if (m.direction !== "out") continue;

    if (m.provider === "draft_ai" && m.draftStatus !== "stale") lastDraftIdx = i;
    if (m.provider === "human" || m.provider === "twilio") lastSentIdx = i;
  }

  if (lastDraftIdx > lastSentIdx) return conv.messages[lastDraftIdx] ?? null;
  return null;
}

export function listConversations() {
  function pendingDraftInfo(c: Conversation) {
    const pendingDraftMsg = getLatestPendingDraft(c);
    const pendingDraft = !!pendingDraftMsg;
    const pendingDraftBody = pendingDraftMsg?.body ?? undefined;

    return {
      pendingDraft,
      pendingDraftPreview: pendingDraftBody ? pendingDraftBody.slice(0, 140) : null
    };
  }

  return Array.from(conversations.values())
    .map(c => {
      const pd = pendingDraftInfo(c);
      return {
        id: c.id,
        leadKey: c.leadKey,
        mode: c.mode,
        status: c.status ?? "open",
        closedAt: c.closedAt ?? null,
        closedReason: c.closedReason ?? null,
        createdAt: c.createdAt,
        updatedAt: c.updatedAt,
        lastMessage: c.messages[c.messages.length - 1] ?? null,
        messageCount: c.messages.length,
        leadName: [c.lead?.firstName, c.lead?.lastName].filter(Boolean).join(" ").trim() || null,
        vehicleDescription: c.lead?.vehicle?.description ?? null,
        leadSource: c.lead?.source ?? null,
        classification: c.classification ?? null,
        ...pd
      };
    })
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

export function getAllConversations(): Conversation[] {
  return Array.from(conversations.values());
}

export function getConversation(id: string): Conversation | null {
  return conversations.get(id) ?? null;
}


function ensureAppointment(conv: Conversation): AppointmentMemory {
  if (!conv.appointment) {
    conv.appointment = { status: "none", updatedAt: nowIso(), acknowledged: false };
  }
  return conv.appointment;
}

const TIME_RE = /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i;
const DAY_RE = /\b(today|tomorrow|mon(day)?|tue(sday)?|wed(nesday)?|thu(rsday)?|fri(day)?|sat(urday)?|sun(day)?)\b/i;

export function updateAppointmentFromInbound(
  conv: Conversation,
  inboundText: string,
  sourceMessageId?: string
) {
  const text = (inboundText || "").toLowerCase();

  if (/(cancel|reschedule|another time|change the time)/.test(text)) {
    conv.appointment = { status: "none", updatedAt: nowIso(), sourceMessageId };
    scheduleSave();
    return;
  }

  const hasTime = TIME_RE.test(text);
  const hasDay = DAY_RE.test(text);

  if (hasTime && hasDay) {
    conv.appointment = {
      status: "confirmed",
      whenText: inboundText.trim(),
      whenIso: null,
      confirmedBy: "customer",
      updatedAt: nowIso(),
      sourceMessageId,
      acknowledged: false
    };
    scheduleSave();
    return;
  }

  const appt = ensureAppointment(conv);
  if (appt.status !== "none" && /(works|sounds good|see you|perfect|ok|okay|yes)/.test(text)) {
    appt.status = "confirmed";
    appt.confirmedBy = "customer";
    appt.updatedAt = nowIso();
    appt.sourceMessageId = sourceMessageId;
    appt.acknowledged = false;
    scheduleSave();
  }
}

export function setLastSuggestedSlots(conv: Conversation, slots: any[]) {
  conv.scheduler = {
    lastSuggestedSlots: Array.isArray(slots) ? slots : [],
    updatedAt: nowIso()
  };
  conv.updatedAt = nowIso();
  scheduleSave();
}

export function setRequestedTime(conv: Conversation, parsed: { day?: string; timeText?: string }) {
  conv.scheduler = conv.scheduler ?? { updatedAt: nowIso() };
  conv.scheduler.requested = { ...parsed, requestedAt: nowIso() };
  conv.scheduler.updatedAt = nowIso();
  conv.updatedAt = nowIso();
  scheduleSave();
}

function normalizeText(s: string) {
  return (s || "")
    .toLowerCase()
    .replace(/[^\w\s:]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function slotMatchesInbound(slot: any, inbound: string): boolean {
  const t = normalizeText(inbound);

  const local = normalizeText(slot.startLocal ?? "");
  if (local && t.includes(local)) return true;

  let hour12: number | null = null;
  let min2 = "00";
  let ampm = "";
  const localTime = String(slot.startLocal ?? "");
  const tm = localTime.match(/(\d{1,2}):(\d{2})\s*(am|pm)/i);
  if (tm) {
    hour12 = Number(tm[1]);
    min2 = String(tm[2]).padStart(2, "0");
    ampm = tm[3].toLowerCase();
  } else if (slot.start) {
    const start = new Date(slot.start);
    const hh = start.getHours();
    const mm = start.getMinutes();
    hour12 = ((hh + 11) % 12) + 1;
    min2 = String(mm).padStart(2, "0");
    ampm = hh >= 12 ? "pm" : "am";
  }
  if (!hour12) return false;

  const dayMatch = local.match(/\b(mon|tue|wed|thu|fri|sat|sun)(day)?\b/i);
  const dayShort = dayMatch?.[1]?.toLowerCase() ?? "";
  const dayFull = dayMatch?.[0]?.toLowerCase() ?? "";

  const timeToken = `${hour12}:${min2}`;
  const hasTime = t.includes(timeToken) && (t.includes(ampm) || (!t.includes("am") && !t.includes("pm")));
  const hasDay = dayShort ? t.includes(dayShort) || (dayFull ? t.includes(dayFull) : false) : false;

  if (hasDay && hasTime) return true;

  const compact = t.replace(/\s/g, "");
  const compactTime = `${hour12}${min2}${ampm}`;
  if (hasDay && compact.includes(compactTime)) return true;

  return false;
}

function slotMatchesInboundRelaxed(slot: any, inbound: string): boolean {
  const t = normalizeText(inbound);
  let hour12: number | null = null;
  let min2 = "00";
  const localTime = String(slot.startLocal ?? "");
  const tm = localTime.match(/(\d{1,2}):(\d{2})\s*(am|pm)/i);
  if (tm) {
    hour12 = Number(tm[1]);
    min2 = String(tm[2]).padStart(2, "0");
  } else if (slot.start) {
    const start = new Date(slot.start);
    const hh = start.getHours();
    const mm = start.getMinutes();
    hour12 = ((hh + 11) % 12) + 1;
    min2 = String(mm).padStart(2, "0");
  }
  if (!hour12) return false;

  const timeToken = `${hour12}:${min2}`;
  const compact = t.replace(/\s/g, "");
  const compactTime = `${hour12}${min2}`;

  if (t.includes(timeToken)) return true;
  if (compact.includes(compactTime)) return true;

  // Hour-only replies like "11" or "11am" without minute
  const hourOnly = new RegExp(`\\b${hour12}\\b`);
  if (hourOnly.test(t)) return true;

  return false;
}

function extractTimeOnly(text: string): { hour12: number; minute: number } | null {
  const t = normalizeText(text);
  if (/\bnoon\b/.test(t)) return { hour12: 12, minute: 0 };

  const m = t.match(/\b(\d{1,2})(?::?(\d{2}))?\b/);
  if (!m) return null;
  const rawHour = Number(m[1]);
  const rawMin = m[2];
  const minute = rawMin ? Number(rawMin) : 0;

  if (Number.isNaN(rawHour) || Number.isNaN(minute)) return null;
  if (minute < 0 || minute > 59) return null;
  if (rawHour < 1 || rawHour > 12) return null;

  return { hour12: rawHour, minute };
}

function slotTimeMatches(slot: any, timeOnly: { hour12: number; minute: number }): boolean {
  let hour12: number | null = null;
  let min2 = "00";
  const localTime = String(slot.startLocal ?? "");
  const tm = localTime.match(/(\d{1,2}):(\d{2})\s*(am|pm)/i);
  if (tm) {
    hour12 = Number(tm[1]);
    min2 = String(tm[2]).padStart(2, "0");
  } else if (slot.start) {
    const start = new Date(slot.start);
    const hh = start.getHours();
    const mm = start.getMinutes();
    hour12 = ((hh + 11) % 12) + 1;
    min2 = String(mm).padStart(2, "0");
  }
  if (!hour12) return false;
  return hour12 === timeOnly.hour12 && Number(min2) === timeOnly.minute;
}

export function confirmAppointmentIfMatchesSuggested(
  conv: Conversation,
  inboundText: string,
  sourceMessageId?: string
) {
  const slots = conv.scheduler?.lastSuggestedSlots ?? [];
  if (!slots.length) {
    console.log("[appt-match] inbound:", inboundText);
    console.log("[appt-match] suggested:", (slots || []).map(s => s.startLocal ?? s.start));
    return false;
  }

  const match = slots.find(s => slotMatchesInbound(s, inboundText));
  if (!match) {
    const relaxed = slots.filter(s => slotMatchesInboundRelaxed(s, inboundText));
    if (relaxed.length === 1) {
      const single = relaxed[0];
      console.log("[appt-match] matched (relaxed):", single.startLocal ?? single.start);
      conv.appointment = conv.appointment ?? { status: "none", updatedAt: nowIso() };
      conv.appointment.status = "confirmed";
      conv.appointment.whenText = inboundText.trim();
      conv.appointment.whenIso = single.start;
      conv.appointment.confirmedBy = "customer";
      conv.appointment.updatedAt = nowIso();
      conv.appointment.acknowledged = false;
      conv.appointment.sourceMessageId = sourceMessageId;
      conv.appointment.matchedSlot = single;

      scheduleSave();
      return true;
    }

    const timeOnly = extractTimeOnly(inboundText);
    if (timeOnly) {
      const byTime = slots.filter(s => slotTimeMatches(s, timeOnly));
      if (byTime.length === 1) {
        const single = byTime[0];
        console.log("[appt-match] matched (time-only):", single.startLocal ?? single.start);
        conv.appointment = conv.appointment ?? { status: "none", updatedAt: nowIso() };
        conv.appointment.status = "confirmed";
        conv.appointment.whenText = inboundText.trim();
        conv.appointment.whenIso = single.start;
        conv.appointment.confirmedBy = "customer";
        conv.appointment.updatedAt = nowIso();
        conv.appointment.acknowledged = false;
        conv.appointment.sourceMessageId = sourceMessageId;
        conv.appointment.matchedSlot = single;

        scheduleSave();
        return true;
      }
    }

    console.log("[appt-match] inbound:", inboundText);
    console.log("[appt-match] suggested:", (slots || []).map(s => s.startLocal ?? s.start));
    return false;
  }

  console.log("[appt-match] matched:", match.startLocal ?? match.start);

  conv.appointment = conv.appointment ?? { status: "none", updatedAt: nowIso() };
  conv.appointment.status = "confirmed";
  conv.appointment.whenText = inboundText.trim();
  conv.appointment.whenIso = match.start;
  conv.appointment.confirmedBy = "customer";
  conv.appointment.updatedAt = nowIso();
  conv.appointment.acknowledged = false;
  conv.appointment.sourceMessageId = sourceMessageId;
  conv.appointment.matchedSlot = match;

  scheduleSave();
  return true;
}

function getZonedParts(date: Date, timeZone: string) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
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
    weekday: map.weekday?.toLowerCase(),
    hour: Number(map.hour),
    minute: Number(map.minute)
  };
}

function localPartsToUtcDate(
  timeZone: string,
  parts: { year: number; month: number; day: number; hour24: number; minute: number }
) {
  const guess = new Date(
    Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour24, parts.minute)
  );
  const guessedLocal = getZonedParts(guess, timeZone);
  const desiredLocalMs = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour24, parts.minute);
  const guessedLocalMs = Date.UTC(
    guessedLocal.year,
    guessedLocal.month - 1,
    guessedLocal.day,
    guessedLocal.hour,
    guessedLocal.minute
  );
  const diffMs = guessedLocalMs - desiredLocalMs;
  return new Date(guess.getTime() - diffMs);
}

export const FOLLOW_UP_DAY_OFFSETS = [2, 3, 5, 7, 10, 14, 18, 21, 27, 30, 45, 60, 90];

function computeFollowUpDueAt(anchorAtIso: string, offsetDays: number, timeZone: string) {
  const anchor = new Date(anchorAtIso);
  const anchorParts = getZonedParts(anchor, timeZone);
  const base = new Date(Date.UTC(anchorParts.year, anchorParts.month - 1, anchorParts.day));
  base.setUTCDate(base.getUTCDate() + offsetDays);
  const baseParts = getZonedParts(base, timeZone);

  const baseMinutes = 10 * 60 + 30;
  const randMinutes = Math.floor(Math.random() * 121);
  const total = baseMinutes + randMinutes;
  const hour24 = Math.floor(total / 60);
  const minute = total % 60;

  return localPartsToUtcDate(timeZone, {
    year: baseParts.year,
    month: baseParts.month,
    day: baseParts.day,
    hour24,
    minute
  }).toISOString();
}

export function startFollowUpCadence(conv: Conversation, anchorAtIso: string, timeZone: string) {
  if (conv.status === "closed") return;
  if (conv.followUpCadence?.status === "active" || conv.followUpCadence?.status === "stopped") return;
  const nextDueAt = computeFollowUpDueAt(anchorAtIso, FOLLOW_UP_DAY_OFFSETS[0], timeZone);
  conv.followUpCadence = {
    status: "active",
    anchorAt: anchorAtIso,
    nextDueAt,
    stepIndex: 0,
    kind: "standard"
  };
  conv.updatedAt = nowIso();
  scheduleSave();
}

export function scheduleLongTermFollowUp(
  conv: Conversation,
  dueAtIso: string,
  message: string
) {
  if (conv.status === "closed") return;
  conv.followUpCadence = {
    status: "active",
    anchorAt: dueAtIso,
    nextDueAt: dueAtIso,
    stepIndex: 0,
    kind: "long_term",
    deferredMessage: message
  };
  conv.updatedAt = nowIso();
  scheduleSave();
}

export function stopFollowUpCadence(conv: Conversation, reason: string) {
  if (!conv.followUpCadence) return;
  conv.followUpCadence.status = "stopped";
  conv.followUpCadence.stopReason = reason;
  conv.followUpCadence.nextDueAt = undefined;
  conv.updatedAt = nowIso();
  scheduleSave();
}

export function closeConversation(conv: Conversation, reason?: string) {
  conv.status = "closed";
  conv.closedAt = nowIso();
  conv.closedReason = reason;
  if (conv.followUpCadence?.status) {
    conv.followUpCadence.status = "stopped";
    conv.followUpCadence.stopReason = reason ?? "closed";
    conv.followUpCadence.nextDueAt = undefined;
  }
  conv.updatedAt = nowIso();
  scheduleSave();
}

export function advanceFollowUpCadence(conv: Conversation, timeZone: string) {
  if (!conv.followUpCadence || conv.followUpCadence.status !== "active") return;
  const nextStep = conv.followUpCadence.stepIndex + 1;
  conv.followUpCadence.lastSentAt = nowIso();
  conv.followUpCadence.lastSentStep = conv.followUpCadence.stepIndex;
  conv.followUpCadence.stepIndex = nextStep;
  if (nextStep >= FOLLOW_UP_DAY_OFFSETS.length) {
    conv.followUpCadence.status = "completed";
    conv.followUpCadence.nextDueAt = undefined;
  } else {
    conv.followUpCadence.nextDueAt = computeFollowUpDueAt(
      conv.followUpCadence.anchorAt,
      FOLLOW_UP_DAY_OFFSETS[nextStep],
      timeZone
    );
  }
  conv.updatedAt = nowIso();
  scheduleSave();
}

function weekdayIndex(name: string | undefined): number {
  switch (name) {
    case "sun":
      return 0;
    case "mon":
      return 1;
    case "tue":
      return 2;
    case "wed":
      return 3;
    case "thu":
      return 4;
    case "fri":
      return 5;
    case "sat":
      return 6;
    default:
      return -1;
  }
}

function weekdayFull(name: string | undefined): string {
  switch (name) {
    case "sun":
      return "sunday";
    case "mon":
      return "monday";
    case "tue":
      return "tuesday";
    case "wed":
      return "wednesday";
    case "thu":
      return "thursday";
    case "fri":
      return "friday";
    case "sat":
      return "saturday";
    default:
      return "";
  }
}

function parseDayToken(t: string): string | null {
  if (/(sat|saturday)/.test(t)) return "saturday";
  if (/(sun|sunday)/.test(t)) return "sunday";
  if (/(mon|monday)/.test(t)) return "monday";
  if (/(tue|tuesday)/.test(t)) return "tuesday";
  if (/(wed|wednesday)/.test(t)) return "wednesday";
  if (/(thu|thursday)/.test(t)) return "thursday";
  if (/(fri|friday)/.test(t)) return "friday";
  if (/(today)/.test(t)) return "today";
  if (/(tomorrow)/.test(t)) return "tomorrow";
  return null;
}

function parseExactTime(text: string): { hour24: number; minute: number; timeText: string } | null {
  const t = text.toLowerCase();
  if (/(around|approx|approximately|ish)\b/.test(t)) return null;
  if (/\bnoon\b/.test(t)) return { hour24: 12, minute: 0, timeText: "noon" };

  const m = t.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/);
  if (!m) return null;

  const hourRaw = Number(m[1]);
  const minute = Number(m[2] ?? "0");
  const meridiem = m[3];

  // Require explicit precision: am/pm or colon time.
  if (!meridiem && !m[2]) return null;
  if (minute < 0 || minute > 59) return null;
  if (hourRaw < 0 || hourRaw > 23) return null;
  if (meridiem && (hourRaw < 1 || hourRaw > 12)) return null;
  if (!meridiem && hourRaw <= 12) return null;

  let hour24 = hourRaw;
  if (meridiem) {
    if (meridiem === "am") hour24 = hourRaw === 12 ? 0 : hourRaw;
    if (meridiem === "pm") hour24 = hourRaw === 12 ? 12 : hourRaw + 12;
  }
  return { hour24, minute, timeText: m[0] };
}

export function parseRequestedDayTime(
  text: string,
  timeZone: string
): { year: number; month: number; day: number; hour24: number; minute: number; dayOfWeek: string } | null {
  const t = text.toLowerCase();
  const dayToken = parseDayToken(t);
  let time = parseExactTime(t);
  if (!time && dayToken && /(this time|same time|same time tomorrow|this time tomorrow)/.test(t)) {
    const now = new Date();
    const nowParts = getZonedParts(now, timeZone);
    const rounded = Math.round(nowParts.minute / 30) * 30;
    let hour24 = nowParts.hour;
    let minute = rounded;
    if (rounded === 60) {
      hour24 = (hour24 + 1) % 24;
      minute = 0;
    }
    time = { hour24, minute, timeText: "this time" };
  }
  if (!dayToken || !time) return null;

  const now = new Date();
  const nowParts = getZonedParts(now, timeZone);
  const todayIdx = weekdayIndex((nowParts.weekday ?? "").slice(0, 3));

  let target = dayToken;
  let base = new Date(Date.UTC(nowParts.year, nowParts.month - 1, nowParts.day, 12, 0));

  if (dayToken === "today" || dayToken === "tomorrow") {
    const offset = dayToken === "tomorrow" ? 1 : 0;
    base.setUTCDate(base.getUTCDate() + offset);
    const parts = getZonedParts(base, timeZone);
    return {
      year: parts.year,
      month: parts.month,
      day: parts.day,
      hour24: time.hour24,
      minute: time.minute,
      dayOfWeek: weekdayFull((parts.weekday ?? "").slice(0, 3))
    };
  }

  const targetIdx = weekdayIndex(dayToken.slice(0, 3));
  if (targetIdx < 0 || todayIdx < 0) return null;

  let delta = (targetIdx - todayIdx + 7) % 7;
  // If they name a weekday and it's today, assume they mean next week (not today)
  if (delta === 0) delta = 7;
  base.setUTCDate(base.getUTCDate() + delta);
  const parts = getZonedParts(base, timeZone);

  return {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour24: time.hour24,
    minute: time.minute,
    dayOfWeek: target
  };
}

export function setFollowUpMode(
  conv: Conversation,
  mode: "active" | "holding_inventory" | "manual_handoff",
  reason?: string
) {
  conv.followUp = { mode, reason, updatedAt: nowIso() };
  conv.updatedAt = nowIso();
  scheduleSave();
}

export function ensureFollowUp(conv: Conversation) {
  if (!conv.followUp) conv.followUp = { mode: "active", updatedAt: nowIso() };
  return conv.followUp;
}

export function updateHoldingFromInbound(conv: Conversation, inboundText: string) {
  const t = (inboundText || "").toLowerCase();
  const wantsHold =
    /only that|just that|next in line|let me know|notify me|if it becomes available|if it falls through/.test(t);
  const mentionsPending = /sale pending|pending|still pending|been pending/.test(t);
  const isUsed =
    conv.lead?.vehicle?.condition === "used" ||
    (!!conv.lead?.vehicle?.stockId && /^u/i.test(conv.lead?.vehicle?.stockId ?? ""));

  if (wantsHold || (mentionsPending && isUsed)) {
    setFollowUpMode(conv, "holding_inventory", "customer_waiting_for_specific_used_unit");
  }
}

export function markAppointmentAcknowledged(conv: Conversation) {
  if (!conv.appointment) return;

  if (conv.appointment.status === "confirmed" && conv.appointment.acknowledged !== true) {
    conv.appointment.acknowledged = true;
    conv.appointment.updatedAt = nowIso();
    scheduleSave();
  }
}

export function getPricingAttempts(conv: Conversation): number {
  return conv.objections?.pricing?.attempts ?? 0;
}

export function incrementPricingAttempt(conv: Conversation): number {
  conv.objections = conv.objections ?? {};
  conv.objections.pricing = conv.objections.pricing ?? { attempts: 0 };
  conv.objections.pricing.attempts += 1;
  conv.objections.pricing.lastAt = nowIso();
  conv.updatedAt = nowIso();
  scheduleSave();
  return conv.objections.pricing.attempts;
}

export function resetPricingAttempt(conv: Conversation) {
  if (!conv.objections) conv.objections = {};
  conv.objections.pricing = { attempts: 0, lastAt: nowIso(), escalated: false };
  conv.updatedAt = nowIso();
  scheduleSave();
}

export function markPricingEscalated(conv: Conversation) {
  conv.objections = conv.objections ?? {};
  conv.objections.pricing = conv.objections.pricing ?? { attempts: 0 };
  conv.objections.pricing.escalated = true;
  conv.objections.pricing.lastAt = nowIso();
  conv.updatedAt = nowIso();
  scheduleSave();
}

export function addTodo(
  conv: Conversation,
  reason: TodoTask["reason"],
  summary: string,
  sourceMessageId?: string
): TodoTask {
  const task: TodoTask = {
    id: makeId("todo"),
    convId: conv.id,
    leadKey: conv.leadKey,
    reason,
    summary,
    sourceMessageId,
    createdAt: nowIso(),
    status: "open"
  };
  todos.push(task);
  conv.updatedAt = nowIso();
  scheduleSave();
  return task;
}

export function listOpenTodos(): TodoTask[] {
  return todos.filter(t => t.status === "open");
}

export function markTodoDone(convId: string, todoId: string): TodoTask | null {
  const task = todos.find(t => t.id === todoId && t.convId === convId);
  if (!task) return null;
  task.status = "done";
  task.doneAt = nowIso();
  scheduleSave();
  return task;
}

export function setCrmLastLoggedAt(conv: Conversation, iso: string) {
  conv.crm = conv.crm ?? {};
  conv.crm.lastLoggedAt = iso;
  conv.updatedAt = nowIso();
  scheduleSave();
}

export function deleteConversation(convId: string): boolean {
  const existed = conversations.delete(convId);
  if (!existed) return false;
  for (let i = todos.length - 1; i >= 0; i -= 1) {
    if (todos[i]?.convId === convId) {
      todos.splice(i, 1);
    }
  }
  scheduleSave();
  return true;
}
