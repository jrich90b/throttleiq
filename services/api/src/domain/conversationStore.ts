import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { InboundMessageEvent } from "./types.js";
import { fileURLToPath } from "node:url";
import { dataPath } from "./dataDir.js";
import { parsePhoneNumberFromString } from "libphonenumber-js";

export type ConversationMode = "autopilot" | "suggest" | "human";
export type MessageProvider =
  | "twilio"
  | "sendgrid_adf"
  | "sendgrid"
  | "draft_ai"
  | "human"
  | "voice_call"
  | "voice_transcript"
  | "voice_summary";

export type VoiceContext = {
  summary: string;
  updatedAt: string;
  expiresAt?: string;
  sourceMessageId?: string;
  contacted?: boolean;
};

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
  attendanceQuestionedAt?: string;
  confirmation?: {
    sentAt?: string;
    status?: "pending" | "confirmed" | "declined";
    respondedAt?: string;
  };
  matchedSlot?: {
    salespersonId?: string;
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
  pendingSlot?: {
    calendarId: string;
    start: string;
    end: string;
    startLocal?: string;
    endLocal?: string;
    salespersonId?: string;
    salespersonName?: string;
    appointmentType?: string;
    reschedule?: boolean;
  };
  preferredSalespersonId?: string;
  preferredSalespersonName?: string;
  preferredSetAt?: string;
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
  kind?: "standard" | "long_term" | "post_sale";
  deferredMessage?: string;
  pausedUntil?: string;
  pauseReason?: string;
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
  reason: "pricing" | "payments" | "approval" | "manager" | "service" | "call" | "other";
  summary: string;
  createdAt: string;
  sourceMessageId?: string;
  status: "open" | "done";
  doneAt?: string;
};

export type InternalQuestion = {
  id: string;
  convId: string;
  leadKey: string;
  text: string;
  createdAt: string;
  status: "open" | "done";
  doneAt?: string;
  outcome?: string;
  followUpAction?: string;
};

export type DialogStateName =
  | "none"
  | "inventory_init"
  | "inventory_watch_prompted"
  | "inventory_watch_active"
  | "inventory_answered"
  | "clarify_schedule"
  | "trade_init"
  | "trade_cash"
  | "trade_trade"
  | "trade_either"
  | "pricing_init"
  | "pricing_need_model"
  | "pricing_answered"
  | "pricing_handoff"
  | "payments_handoff"
  | "service_request"
  | "service_handoff"
  | "callback_requested"
  | "callback_handoff"
  | "call_only"
  | "followup_paused"
  | "followup_resumed"
  | "schedule_request"
  | "schedule_offer_sent"
  | "schedule_booked";

export type LeadProfile = {
  leadRef?: string;
  source?: string;
  name?: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
  emailOptIn?: boolean;
  smsOptIn?: boolean;
  phoneOptIn?: boolean;
  street?: string;
  city?: string;
  region?: string;
  postal?: string;
  preferredDate?: string;
  preferredTime?: string;
  channelPreference?: "sms" | "email" | "facebook_messenger";
  purchaseTimeframe?: string;
  purchaseTimeframeMonthsStart?: number;
  purchaseTimeframeMonthsEnd?: number;
  hasMotoLicense?: boolean;
  sellOption?: "cash" | "trade" | "either";
  sellOptionUpdatedAt?: string;
  sourceId?: number;
  vehicle?: {
    stockId?: string;
    vin?: string;
    year?: string;
    make?: string;
    model?: string;
    trim?: string;
    modelOptions?: string[];
    color?: string;
    condition?: string;
    url?: string;
    inventoryStatus?: "AVAILABLE" | "PENDING" | "UNKNOWN";
    description?: string;
    mileage?: number;
    listPrice?: number;
    priceRange?: { min: number; max: number; count: number };
  };
  tradeVehicle?: {
    year?: string;
    make?: string;
    model?: string;
    vin?: string;
    mileage?: number;
    color?: string;
    description?: string;
  };
};

export type InventoryWatch = {
  model: string;
  year?: number;
  yearMin?: number;
  yearMax?: number;
  make?: string;
  condition?: string;
  color?: string;
  trim?: string;
  note?: string;
  exactness?: "exact" | "year_model" | "model_range" | "model_only";
  status?: "active" | "paused";
  createdAt: string;
  lastNotifiedAt?: string;
  lastNotifiedStockId?: string;
};

export type InventoryWatchPending = {
  model?: string;
  year?: number;
  color?: string;
  askedAt: string;
};

export type Message = {
  id: string;
  direction: "in" | "out";
  from: string;
  to: string;
  body: string;
  originalDraftBody?: string;
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
  sale?: {
    soldAt?: string;
    soldById?: string;
    soldByName?: string;
    stockId?: string;
    vin?: string;
    label?: string;
    note?: string;
  };
  hold?: {
    key?: string;
    stockId?: string;
    vin?: string;
    label?: string;
    note?: string;
    until?: string;
    reason?: string;
    createdAt?: string;
    updatedAt?: string;
  };
  createdAt: string;
  updatedAt: string;
  messages: Message[];
  lead?: LeadProfile;
  classification?: { bucket?: string; cta?: string; channel?: string; ruleName?: string };
  appointment?: AppointmentMemory;
  followUp?: { mode: "active" | "holding_inventory" | "manual_handoff" | "paused_indefinite"; reason?: string; updatedAt: string };
  scheduler?: SchedulerMemory;
  followUpCadence?: FollowUpCadence;
  objections?: ObjectionState;
  crm?: { lastLoggedAt?: string };
  inventoryWatch?: InventoryWatch;
  inventoryWatches?: InventoryWatch[];
  inventoryWatchPending?: InventoryWatchPending;
  emailDraft?: string;
  contactPreference?: "call_only";
  voiceContext?: VoiceContext;
  dialogState?: { name: DialogStateName; updatedAt: string };
};

const conversations = new Map<string, Conversation>();

// Normalize lead keys at the store level to prevent split threads across channels/phone formats.
export function normalizeLeadKey(raw: string): string {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed) return trimmed;
  if (trimmed.includes("@")) return trimmed.toLowerCase();

  const direct = parsePhoneNumberFromString(trimmed);
  if (direct?.isValid()) return direct.number;

  const digits = trimmed.replace(/\D/g, "");
  const looksNanp = digits.length === 10 || (digits.length === 11 && digits.startsWith("1"));
  if (looksNanp) {
    const fallback = parsePhoneNumberFromString(digits, "US");
    if (fallback?.isValid()) return fallback.number;
  }

  return trimmed;
}

if (process.env.NODE_ENV === "test") {
  const samples = [
    "716-866-8217",
    "+1 (716) 866-8217",
    "+44 20 7946 0018",
    "GIO@AMERICANHARLEY-DAVIDSON.COM"
  ];
  for (const s of samples) {
    // eslint-disable-next-line no-console
    console.log("[normalizeLeadKey]", s, "=>", normalizeLeadKey(s));
  }
}
const todos: TodoTask[] = [];
const questions: InternalQuestion[] = [];

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
    const parsed = JSON.parse(raw) as { conversations?: Conversation[]; todos?: TodoTask[]; questions?: InternalQuestion[] };

    const list = parsed?.conversations ?? [];
    conversations.clear();
    for (const c of list) {
      const key = normalizeLeadKey(c?.leadKey || c?.id || "");
      if (!key) continue;
      c.id = key;
      c.leadKey = key;
      conversations.set(key, c);
    }
    todos.length = 0;
    if (parsed?.todos?.length) todos.push(...parsed.todos);
    questions.length = 0;
    if (parsed?.questions?.length) questions.push(...parsed.questions);

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
      todos,
      questions
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

// Flush pending conversation changes to disk (used before early-return paths).
export async function flushConversationStore(): Promise<void> {
  await saveToDisk();
}

export function getConversationStorePath(): string {
  return DB_PATH;
}

// Ensure conversation is present in the in-memory store before flush.
export function saveConversation(conv: Conversation): void {
  const key = normalizeLeadKey(conv.leadKey || conv.id || "");
  if (!key) return;
  conv.id = key;
  conv.leadKey = key;
  conversations.set(key, conv);
  scheduleSave();
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
  const key = normalizeLeadKey(leadKey);
  const existing = conversations.get(key);
  if (existing) return existing;

  const created: Conversation = {
    id: key,
    leadKey: key,
    mode: defaultMode,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    messages: [],
    scheduler: { updatedAt: nowIso(), lastSuggestedSlots: [] }
  };

  conversations.set(key, created);
  scheduleSave();
  return created;
}

export function setConversationMode(id: string, mode: ConversationMode): Conversation | null {
  const key = normalizeLeadKey(id);
  const conv = conversations.get(key);
  if (!conv) return null;
  conv.mode = mode;
  conv.updatedAt = nowIso();
  scheduleSave();
  return conv;
}

export function setContactPreference(
  conv: Conversation,
  pref?: "call_only" | null
): void {
  if (pref) {
    conv.contactPreference = pref;
  } else {
    delete conv.contactPreference;
  }
  conv.updatedAt = nowIso();
  scheduleSave();
}

export function appendInbound(conv: Conversation, evt: InboundMessageEvent) {
  if (conv.status === "closed") {
    conv.status = "open";
    conv.closedAt = undefined;
    conv.closedReason = undefined;
  }
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
  if (original.trim() !== finalBody.trim()) {
    msg.originalDraftBody = original;
  }
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
  const mergedTradeVehicle = patch.tradeVehicle
    ? { ...(existingLead.tradeVehicle ?? {}), ...patch.tradeVehicle }
    : existingLead.tradeVehicle;

  conv.lead = {
    ...existingLead,
    ...patch,
    vehicle: mergedVehicle,
    tradeVehicle: mergedTradeVehicle
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
      const nonCallMessages = c.messages.filter(
        m => m.provider !== "voice_call" && m.provider !== "voice_transcript"
      );
      const lastNonCall =
        nonCallMessages[nonCallMessages.length - 1] ??
        c.messages[c.messages.length - 1] ??
        null;
      const updatedAt = lastNonCall?.at ?? c.updatedAt;
      return {
        id: c.id,
        leadKey: c.leadKey,
        mode: c.mode,
        status: c.status ?? "open",
        closedAt: c.closedAt ?? null,
        closedReason: c.closedReason ?? null,
        createdAt: c.createdAt,
        updatedAt,
        lastMessage: lastNonCall,
        messageCount: c.messages.length,
        leadName:
          c.lead?.name?.trim() ||
          [c.lead?.firstName, c.lead?.lastName].filter(Boolean).join(" ").trim() ||
          null,
        vehicleDescription: c.lead?.vehicle?.description ?? null,
        contactPreference: c.contactPreference,
        leadSource: c.lead?.source ?? null,
        classification: c.classification ?? null,
        followUpCadence: c.followUpCadence ?? null,
        followUp: c.followUp ?? null,
        hold: c.hold ?? null,
        ...pd
      };
    })
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

export function getAllConversations(): Conversation[] {
  return Array.from(conversations.values());
}

export function getConversation(id: string): Conversation | null {
  const key = normalizeLeadKey(id);
  const direct = conversations.get(key);
  if (direct) return direct;
  for (const conv of conversations.values()) {
    if (conv.id === id || conv.leadKey === id) return conv;
    const convKey = normalizeLeadKey(conv.leadKey || conv.id || "");
    if (convKey && convKey === key) return conv;
  }
  return null;
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
  conv.scheduler = conv.scheduler ?? { updatedAt: nowIso(), lastSuggestedSlots: [] };
  conv.scheduler.lastSuggestedSlots = Array.isArray(slots) ? slots : [];
  conv.scheduler.updatedAt = nowIso();
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
export const POST_SALE_DAY_OFFSETS = [1, 60, 365, 690];

export function computeFollowUpDueAt(anchorAtIso: string, offsetDays: number, timeZone: string) {
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

export function computePostSaleDueAt(anchorAtIso: string, offsetDays: number, timeZone: string) {
  const anchor = new Date(anchorAtIso);
  const anchorParts = getZonedParts(anchor, timeZone);
  const base = new Date(Date.UTC(anchorParts.year, anchorParts.month - 1, anchorParts.day));
  base.setUTCDate(base.getUTCDate() + offsetDays);
  const baseParts = getZonedParts(base, timeZone);
  return localPartsToUtcDate(timeZone, {
    year: baseParts.year,
    month: baseParts.month,
    day: baseParts.day,
    hour24: 10,
    minute: 30
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

export function startPostSaleCadence(conv: Conversation, anchorAtIso: string, timeZone: string) {
  if (conv.closedReason !== "sold" && !conv.sale?.soldAt) return;
  const nextDueAt = computePostSaleDueAt(anchorAtIso, POST_SALE_DAY_OFFSETS[0], timeZone);
  conv.followUpCadence = {
    status: "active",
    anchorAt: anchorAtIso,
    nextDueAt,
    stepIndex: 0,
    kind: "post_sale"
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
  conv.followUpCadence.pausedUntil = undefined;
  conv.followUpCadence.pauseReason = undefined;
  conv.updatedAt = nowIso();
  scheduleSave();
}

export function pauseFollowUpCadence(conv: Conversation, untilIso: string, reason?: string) {
  if (!conv.followUpCadence || conv.followUpCadence.status !== "active") return;
  conv.followUpCadence.pausedUntil = untilIso;
  conv.followUpCadence.pauseReason = reason ?? "manual_outbound";
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
  const isPostSale = conv.followUpCadence.kind === "post_sale";
  const offsets = isPostSale ? POST_SALE_DAY_OFFSETS : FOLLOW_UP_DAY_OFFSETS;
  if (nextStep >= offsets.length) {
    conv.followUpCadence.status = "completed";
    conv.followUpCadence.nextDueAt = undefined;
  } else {
    conv.followUpCadence.nextDueAt = isPostSale
      ? computePostSaleDueAt(conv.followUpCadence.anchorAt, offsets[nextStep], timeZone)
      : computeFollowUpDueAt(conv.followUpCadence.anchorAt, offsets[nextStep], timeZone);
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

  // Prefer explicit time tokens so dates like 3/11/2026 don't get parsed as "3".
  const m = t.match(/\b(\d{1,2}):(\d{2})\s*(am|pm)?\b/);
  let hourRaw: number;
  let minute: number;
  let meridiem: string | undefined;
  let timeText: string;
  if (m) {
    hourRaw = Number(m[1]);
    minute = Number(m[2] ?? "0");
    meridiem = m[3];
    timeText = m[0];
  } else {
    const m2 = t.match(/\b(\d{1,2})\s*(am|pm)\b/);
    if (!m2) return null;
    hourRaw = Number(m2[1]);
    minute = 0;
    meridiem = m2[2];
    timeText = m2[0];
  }
  if (minute < 0 || minute > 59) return null;
  if (hourRaw < 0 || hourRaw > 23) return null;
  if (meridiem && (hourRaw < 1 || hourRaw > 12)) return null;
  if (!meridiem && hourRaw <= 12) return null;

  let hour24 = hourRaw;
  if (meridiem) {
    if (meridiem === "am") hour24 = hourRaw === 12 ? 0 : hourRaw;
    if (meridiem === "pm") hour24 = hourRaw === 12 ? 12 : hourRaw + 12;
  }
  return { hour24, minute, timeText };
}

function parseExplicitDate(text: string): { year: number; month: number; day: number } | null {
  const m = text.match(/\b(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?\b/);
  if (!m) return null;
  const month = Number(m[1]);
  const day = Number(m[2]);
  let year = m[3] ? Number(m[3]) : new Date().getFullYear();
  if (m[3] && m[3].length === 2) {
    year = 2000 + year;
  }
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return { year, month, day };
}

export function parsePreferredDateTime(
  dateText: string,
  timeText: string,
  timeZone: string
): { year: number; month: number; day: number; hour24: number; minute: number; dayOfWeek: string } | null {
  const date = parseExplicitDate(dateText.toLowerCase());
  const time = parseExactTime(timeText.toLowerCase());
  if (!date || !time) return null;
  const base = new Date(Date.UTC(date.year, date.month - 1, date.day, 12, 0));
  const parts = getZonedParts(base, timeZone);
  return {
    year: date.year,
    month: date.month,
    day: date.day,
    hour24: time.hour24,
    minute: time.minute,
    dayOfWeek: weekdayFull((parts.weekday ?? "").slice(0, 3))
  };
}

export function parseRequestedDayTime(
  text: string,
  timeZone: string
): { year: number; month: number; day: number; hour24: number; minute: number; dayOfWeek: string } | null {
  const t = text.toLowerCase();
  const explicitDate = parseExplicitDate(t);
  const dayToken = parseDayToken(t);
  let time = parseExactTime(t);
  if (!time && dayToken && !explicitDate) {
    // Support messages like "Tuesday at 3" or "Tue 3?" by inferring AM/PM.
    const atMatch = t.match(/\b(?:at|for|around|by)\s*(\d{1,2})\b(?!\s*\/)/);
    const bareMatch = t.match(/\b(\d{1,2})\b(?!\s*\/)/);
    const raw = atMatch?.[1] ?? bareMatch?.[1];
    if (raw) {
      const hour = Number(raw);
      if (hour >= 1 && hour <= 12) {
        let hour24 = hour;
        if (hour !== 12) {
          // Heuristic: 1-7 -> PM, 8-11 -> AM.
          hour24 = hour <= 7 ? hour + 12 : hour;
        }
        time = { hour24, minute: 0, timeText: raw };
      }
    }
  }
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
  if (!time) return null;
  if (explicitDate) {
    const base = new Date(Date.UTC(explicitDate.year, explicitDate.month - 1, explicitDate.day, 12, 0));
    const parts = getZonedParts(base, timeZone);
    return {
      year: explicitDate.year,
      month: explicitDate.month,
      day: explicitDate.day,
      hour24: time.hour24,
      minute: time.minute,
      dayOfWeek: weekdayFull((parts.weekday ?? "").slice(0, 3))
    };
  }
  if (!dayToken) return null;

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
  mode: "active" | "holding_inventory" | "manual_handoff" | "paused_indefinite",
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

export function addCallTodoIfMissing(conv: Conversation, summary: string): TodoTask | null {
  const existing = todos.find(
    t => t.convId === conv.id && t.status === "open" && t.reason === "call"
  );
  if (existing) return null;
  return addTodo(conv, "call", summary);
}

export function listOpenTodos(): TodoTask[] {
  return todos.filter(t => t.status === "open");
}

export function addInternalQuestion(convId: string, leadKey: string, text: string): InternalQuestion {
  const q: InternalQuestion = {
    id: makeId("q"),
    convId,
    leadKey,
    text,
    createdAt: nowIso(),
    status: "open"
  };
  questions.push(q);
  scheduleSave();
  return q;
}

export function listOpenQuestions(): InternalQuestion[] {
  return questions.filter(q => q.status === "open");
}

export function markQuestionDone(
  convId: string,
  questionId: string,
  outcome?: string,
  followUpAction?: string
): InternalQuestion | null {
  const q = questions.find(x => x.id === questionId && x.convId === convId);
  if (!q) return null;
  q.status = "done";
  q.doneAt = nowIso();
  if (outcome) q.outcome = outcome;
  if (followUpAction) q.followUpAction = followUpAction;
  scheduleSave();
  return q;
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

export function setVoiceContext(conv: Conversation, voiceContext: VoiceContext | null) {
  if (!voiceContext) {
    if (conv.voiceContext) {
      conv.voiceContext = undefined;
      conv.updatedAt = nowIso();
      scheduleSave();
    }
    return;
  }
  conv.voiceContext = voiceContext;
  conv.updatedAt = nowIso();
  scheduleSave();
}

export function getActiveVoiceContext(conv: Conversation): VoiceContext | null {
  const ctx = conv.voiceContext;
  if (!ctx) return null;
  if (ctx.expiresAt) {
    const expiresAt = new Date(ctx.expiresAt).getTime();
    if (Number.isFinite(expiresAt) && expiresAt <= Date.now()) {
      conv.voiceContext = undefined;
      conv.updatedAt = nowIso();
      scheduleSave();
      return null;
    }
  }
  return ctx;
}

export function deleteConversation(convId: string): boolean {
  const key = normalizeLeadKey(convId);
  const existed = conversations.delete(key);
  if (!existed) return false;
  for (let i = todos.length - 1; i >= 0; i -= 1) {
    if (todos[i]?.convId === key) {
      todos.splice(i, 1);
    }
  }
  for (let i = questions.length - 1; i >= 0; i -= 1) {
    if (questions[i]?.convId === key) {
      questions.splice(i, 1);
    }
  }
  scheduleSave();
  return true;
}
