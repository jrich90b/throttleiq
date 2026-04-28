import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { InboundMessageEvent } from "./types.js";
import { maybeMarkEngagedFromInbound } from "./engagement.js";
import { fileURLToPath } from "node:url";
import { dataPath } from "./dataDir.js";
import {
  applyDeterministicToneOverrides,
  formatEmailLayout,
  formatSmsLayout,
  normalizeSalesToneBase
} from "./tone.js";
import { parsePhoneNumberFromString } from "libphonenumber-js";
import { applyDraftStateInvariants } from "./draftStateInvariants.js";

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

export type LeadOwner = {
  id: string;
  name?: string;
  assignedAt?: string;
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
  bookedSalespersonName?: string | null;
  bookedCalendarId?: string | null;
  whenLocal?: string | null;
  appointmentType?: string | null;
  reschedulePending?: boolean;
  attendanceQuestionedAt?: string;
  staffNotify?: {
    bookedSentAt?: string;
    followUpSentAt?: string;
    lastEventId?: string | null;
    outcomeToken?: string;
    userId?: string;
    phone?: string;
    contextUsedAt?: string;
    outcome?: {
      status:
        | "showed_up"
        | "no_show"
        | "cancelled"
        | "sold"
        | "hold"
        | "financing_declined"
        | "financing_needs_info"
        | "bought_elsewhere"
        | "lost"
        | "follow_up"
        | "other";
      primaryStatus?: "showed" | "did_not_show" | "cancelled";
      secondaryStatus?:
        | "sold"
        | "hold"
        | "needs_follow_up"
        | "lost"
        | "finance_not_approved"
        | "finance_needs_info"
        | "not_ready"
        | "other";
      note?: string;
      updatedAt: string;
    };
  };
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
  kind?: "standard" | "engaged" | "long_term" | "post_sale";
  deferredMessage?: string;
  pausedUntil?: string;
  pauseReason?: string;
  contextTag?: string;
  contextTagUpdatedAt?: string;
  usedVariants?: Record<string, string[]>;
  scheduleInviteCount?: number;
  scheduleMuted?: boolean;
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
  ownerId?: string;
  ownerName?: string;
  reason:
    | "pricing"
    | "payments"
    | "approval"
    | "manager"
    | "service"
    | "parts"
    | "apparel"
    | "call"
    | "note"
    | "other";
  summary: string;
  createdAt: string;
  sourceMessageId?: string;
  status: "open" | "done";
  doneAt?: string;
  dueAt?: string;
  reminderAt?: string;
  reminderLeadMinutes?: number;
  reminderSentAt?: string;
  taskClass?: TodoTaskClass;
};

export type TodoTaskClass = "followup" | "appointment" | "todo" | "reminder";

export type TodoScheduleOptions = {
  dueAt?: string;
  reminderAt?: string;
  reminderLeadMinutes?: number;
  reminderSentAt?: string;
};

export function inferTodoTaskClass(
  reason: TodoTask["reason"],
  summary?: string | null,
  schedule?: TodoScheduleOptions
): TodoTaskClass {
  const summaryRaw = String(summary ?? "");
  const text = summaryRaw.toLowerCase();
  const hasDepartmentSignals =
    reason === "service" ||
    reason === "parts" ||
    reason === "apparel" ||
    /\b(service|parts?|apparel|motorclothes|clothing|merch)\b/.test(text);
  const hasAppointmentLanguage =
    /\b(appointment|schedule|scheduled|book|booking|reschedule|no[\s-]?show|showed up|show up|test ride|demo ride)\b/.test(
      text
    );
  const hasAppointmentTimeSignal =
    !!String(schedule?.dueAt ?? "").trim() ||
    !!String(schedule?.reminderAt ?? "").trim() ||
    /\b(today|tomorrow|tonight|this\s+(?:morning|afternoon|evening)|mon(?:day)?|tue(?:s|sday)?|wed(?:nesday)?|thu(?:r|rs|rsday)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?|\d{1,2}:\d{2}\s*(?:am|pm)?|\d{1,2}\s*(?:am|pm))\b/.test(
      text
    );
  const hasAppointmentSignals =
    !hasDepartmentSignals &&
    reason !== "note" &&
    hasAppointmentLanguage &&
    hasAppointmentTimeSignal;
  if (reason === "call") {
    const hasCadenceFollowUpSignals =
      /^call customer \(follow-up\):/i.test(summaryRaw) ||
      /^call customer \((initial reply sent|follow[- ]?up)\)/i.test(summaryRaw) ||
      /\bfollow[- ]?up\b/i.test(text) ||
      /\binitial reply sent\b/i.test(text) ||
      /\bcadence\b/i.test(text);
    if (hasCadenceFollowUpSignals) return "followup";
    const hasReminderSignals =
      !!String(schedule?.dueAt ?? "").trim() ||
      !!String(schedule?.reminderAt ?? "").trim() ||
      /^call requested:/i.test(summaryRaw) ||
      /\brequested call time\b/i.test(text) ||
      /\bremind(er)?\b/i.test(text);
    if (hasReminderSignals) return "reminder";
    if (hasAppointmentSignals) return "appointment";
  }
  if (hasAppointmentSignals) return "appointment";
  return "todo";
}

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
  type?: "attendance" | "cadence_checkin";
};

export type DialogStateName =
  | "none"
  | "walk_in_active"
  | "specs_single_request"
  | "specs_single_answered"
  | "inventory_init"
  | "inventory_watch_prompted"
  | "inventory_watch_active"
  | "inventory_answered"
  | "compare_request"
  | "compare_answered"
  | "clarify_schedule"
  | "test_ride_init"
  | "test_ride_offer_sent"
  | "test_ride_booked"
  | "test_ride_handoff"
  | "schedule_soft"
  | "trade_init"
  | "trade_cash"
  | "trade_trade"
  | "trade_either"
  | "pricing_init"
  | "pricing_need_model"
  | "pricing_answered"
  | "payments_answered"
  | "pricing_handoff"
  | "payments_handoff"
  | "service_request"
  | "service_handoff"
  | "parts_handoff"
  | "apparel_handoff"
  | "small_talk"
  | "callback_requested"
  | "callback_handoff"
  | "call_only"
  | "followup_paused"
  | "followup_resumed"
  | "customer_stepping_back"
  | "customer_sell_on_own"
  | "customer_keep_current_bike"
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
  preferredContactMethod?: "email" | "sms" | "phone";
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
  walkIn?: boolean;
  walkInComment?: string;
  walkInStep?: number;
  walkInCommentCapturedAt?: string;
  walkInCommentUsedAt?: string;
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
  minPrice?: number;
  maxPrice?: number;
  monthlyBudget?: number;
  termMonths?: number;
  downPayment?: number;
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
  minPrice?: number;
  maxPrice?: number;
  monthlyBudget?: number;
  termMonths?: number;
  downPayment?: number;
  askedAt: string;
};

export type FinanceDocsState = {
  status: "none" | "pending" | "complete";
  requestedAt?: string;
  updatedAt: string;
  insuranceRequested?: boolean;
  insuranceReceived?: boolean;
  insuranceReceivedAt?: string;
  binderRequested?: boolean;
  binderReceived?: boolean;
  binderReceivedAt?: string;
  licenseRequested?: boolean;
  licenseReceived?: boolean;
  licenseReceivedAt?: string;
  completedAt?: string;
  lastInboundMessageId?: string;
};

export type TradePayoffState = {
  status: "unknown" | "no_lien" | "has_lien";
  lienQuestionAskedAt?: string;
  lastAnsweredAt?: string;
  lienHolderNeeded?: boolean;
  lienHolderProvided?: boolean;
  lienHolderProvidedAt?: string;
  updatedAt: string;
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
  feedback?: MessageFeedback;
};

export type MessageFeedback = {
  rating: "up" | "down";
  reason?: string;
  note?: string;
  byUserId?: string;
  byUserName?: string;
  at: string;
};

export type AgentContextNote = {
  id: string;
  text: string;
  mode?: "persistent" | "next_reply";
  expiresAt?: string;
  createdAt: string;
  createdByUserId?: string;
  createdByUserName?: string;
  addressedAt?: string;
  addressedReason?: string;
};

export type ConversationSoftTagValue = {
  value?: string;
  source?: string;
  confidence?: number;
  updatedAt: string;
  expiresAt?: string;
  meta?: Record<string, string | number | boolean | null>;
};

export type Conversation = {
  id: string;
  leadKey: string;
  mode: ConversationMode;
  status?: "open" | "closed";
  closedAt?: string;
  closedReason?: string;
  sale?: {
    soldAt?: string;
    soldById?: string;
    soldByName?: string;
    year?: string;
    make?: string;
    model?: string;
    trim?: string;
    color?: string;
    stockId?: string;
    vin?: string;
    label?: string;
    note?: string;
  };
  hold?: {
    key?: string;
    onOrder?: boolean;
    stockId?: string;
    vin?: string;
    year?: string;
    make?: string;
    model?: string;
    trim?: string;
    color?: string;
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
  leadOwner?: LeadOwner;
  manualSender?: {
    userId?: string;
    userName?: string;
    activatedAt: string;
    source?: "manual_takeover";
  };
  lead?: LeadProfile;
  classification?: { bucket?: string; cta?: string; channel?: string; ruleName?: string };
  appointment?: AppointmentMemory;
  dealerRide?: {
    staffNotify?: {
      bookedSentAt?: string;
      outcomeToken?: string;
      followUpSentAt?: string;
      userId?: string;
      phone?: string;
      outcome?: {
        status?: string;
        note?: string;
        updatedAt?: string;
      };
      contextUsedAt?: string;
    };
  };
  followUp?: {
    mode: "active" | "holding_inventory" | "manual_handoff" | "paused_indefinite";
    reason?: string;
    updatedAt: string;
    skipNextCheckin?: boolean;
  };
  campaignThread?: {
    status: "campaign" | "linked_open" | "passed";
    campaignId?: string;
    campaignName?: string;
    listId?: string;
    listName?: string;
    firstSentAt?: string;
    lastSentAt?: string;
    replySeenAt?: string;
    passedAt?: string;
    passedTo?: "sales" | "service" | "parts" | "apparel" | "financing" | "general";
  };
  scheduler?: SchedulerMemory;
  followUpCadence?: FollowUpCadence;
  objections?: ObjectionState;
  crm?: { lastLoggedAt?: string };
  inventoryWatch?: InventoryWatch;
  inventoryWatches?: InventoryWatch[];
  inventoryWatchPending?: InventoryWatchPending;
  inventoryContext?: {
    model?: string;
    year?: string;
    condition?: string;
    color?: string;
    finish?: string;
    updatedAt?: string;
  };
  paymentBudgetContext?: {
    monthlyBudget?: number | null;
    termMonths?: number | null;
    downPayment?: number | null;
    updatedAt?: string;
  };
  compareContext?: {
    models?: string[];
    year?: string | number | null;
    format?: "highlights" | "full" | null;
    updatedAt?: string;
  };
  specsContext?: {
    model?: string;
    year?: string | number | null;
    format?: "highlights" | "full" | null;
    updatedAt?: string;
  };
  scheduleSoft?: {
    requestedAt: string;
    cooldownUntil?: string;
    lastAskAt?: string;
  };
  pickup?: {
    stage?: "need_town" | "need_street" | "need_time" | "ready";
    town?: string;
    street?: string;
    preferredTimeText?: string;
    distanceMiles?: number;
    eligible?: boolean;
    updatedAt?: string;
  };
  financeDocs?: FinanceDocsState;
  tradePayoff?: TradePayoffState;
  emailDraft?: string;
  contactPreference?: "call_only";
  voiceContext?: VoiceContext;
  financeOutcome?: {
    status: "approved" | "declined" | "needs_more_info";
    updatedAt: string;
    sourceMessageId?: string;
    reasonText?: string;
  };
  memorySummary?: { text: string; updatedAt: string; messageCount: number };
  agentContext?: {
    text: string;
    mode?: "persistent" | "next_reply";
    expiresAt?: string;
    updatedAt: string;
    updatedByUserId?: string;
    updatedByUserName?: string;
    consumedAt?: string;
    consumedReason?: string;
    notes?: AgentContextNote[];
  };
  lastDecision?: {
    at: string;
    ambiguousFlow: boolean;
    intent:
      | "AVAILABILITY"
      | "PRICING"
      | "FINANCING"
      | "TRADE_IN"
      | "TEST_RIDE"
      | "SPECS"
      | "GENERAL"
      | "UNSURE";
    signals: {
      pricingIntent: boolean;
      financeRequest: boolean;
      hoursRequest: boolean;
      managerRequest: boolean;
      approvalStatus: boolean;
      callbackRequest: boolean;
      wantsAvailability: boolean;
      wantsScheduling: boolean;
      wantsPayments: boolean;
      wantsTrade: boolean;
      multiIntentCount: number;
    };
  };
  lastIntent?: {
      name:
      | "trade"
      | "pricing"
      | "payments"
      | "inventory"
      | "scheduling"
      | "callback"
      | "service"
      | "small_talk"
      | "general";
    updatedAt: string;
    source?: "dialog_state" | "llm" | "manual";
  };
  lastAffect?: {
    primary:
      | "neutral"
      | "frustrated"
      | "excited"
      | "humorous"
      | "confused"
      | "anxious"
      | "angry"
      | "urgent"
      | "none";
    explicitAffect: boolean;
    needsEmpathy: boolean;
    hasHumor: boolean;
    hasPositiveEnergy: boolean;
    hasNegativeSentiment: boolean;
    toneIntensity?: number;
    confidence?: number;
    source?: "llm";
    sourceMessageId?: string;
    updatedAt: string;
  };
  dialogState?: { name: DialogStateName; updatedAt: string };
  engagement?: {
    at: string;
    source: "sms" | "email" | "call";
    reason?: string;
    messageId?: string;
  };
  softTags?: Record<string, ConversationSoftTagValue>;
};

const conversations = new Map<string, Conversation>();
const leadKeyIndex = new Map<string, string[]>();

function indexConversationByLeadKey(conv: Conversation): void {
  const leadKey = normalizeLeadKey(conv.leadKey || "");
  if (!leadKey) return;
  conv.leadKey = leadKey;
  const existing = leadKeyIndex.get(leadKey) ?? [];
  if (!existing.includes(conv.id)) {
    existing.push(conv.id);
    leadKeyIndex.set(leadKey, existing);
  }
}

function removeConversationFromLeadIndex(conv: Conversation): void {
  const leadKey = normalizeLeadKey(conv.leadKey || "");
  if (!leadKey) return;
  const ids = leadKeyIndex.get(leadKey);
  if (!ids?.length) return;
  const filtered = ids.filter(id => id !== conv.id);
  if (filtered.length) {
    leadKeyIndex.set(leadKey, filtered);
  } else {
    leadKeyIndex.delete(leadKey);
  }
}

function buildConversationId(baseLeadKey: string): string {
  const base = normalizeLeadKey(baseLeadKey) || `lead_${Date.now()}`;
  if (!conversations.has(base)) return base;
  let attempt = 2;
  let candidate = `${base}::${attempt}`;
  while (conversations.has(candidate)) {
    attempt += 1;
    candidate = `${base}::${attempt}`;
  }
  return candidate;
}

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

function detectFinanceDocRequestSignals(body: string): {
  insuranceRequested: boolean;
  binderRequested: boolean;
  licenseRequested: boolean;
} {
  const t = String(body ?? "").toLowerCase();
  if (!t.trim()) return { insuranceRequested: false, binderRequested: false, licenseRequested: false };
  const actionCue =
    /\b(send|text|photo|upload|attach|add|provide|share|submit|once you add|when you add|when you send|when you text)\b/.test(
      t
    ) || /\be-?sign\b/.test(t);
  const insuranceRequested =
    /\b(insurance card|id card|proof of insurance)\b/.test(t) ||
    (/\binsurance\b/.test(t) && actionCue);
  const binderRequested = /\bbinder\b/.test(t) && (actionCue || /\binsurance\b/.test(t));
  const licenseRequested =
    /\b(driver'?s?\s*licen[cs]e|drivers?\s*license|driver license|d\.?\s*l\.?)\b/.test(t) &&
    actionCue;
  return { insuranceRequested, binderRequested, licenseRequested };
}

function detectFinanceDocMentionSignals(body: string): {
  insuranceMentioned: boolean;
  binderMentioned: boolean;
  licenseMentioned: boolean;
} {
  const t = String(body ?? "").toLowerCase();
  return {
    insuranceMentioned: /\b(insurance|insurance card|id card|proof of insurance)\b/.test(t),
    binderMentioned: /\bbinder\b/.test(t),
    licenseMentioned: /\b(driver'?s?\s*licen[cs]e|drivers?\s*license|driver license|d\.?\s*l\.?)\b/.test(
      t
    )
  };
}

function looksLikeAttachmentPlaceholderBody(body: string): boolean {
  const text = String(body ?? "").trim().toLowerCase();
  if (!text) return false;
  return (
    text === "open attachment" ||
    text === "sent an attachment" ||
    text === "sent an image" ||
    text === "sent a photo"
  );
}

function detectLienNoPayoffStatement(text: string): boolean {
  const t = String(text ?? "").toLowerCase();
  return (
    /\b(no lien|no payoff|no pay off|don't have (a )?lien|dont have (a )?lien|without (a )?lien|no loan)\b/.test(
      t
    ) ||
    /\b(i own (it|the bike)|own and have the title|have the title|title in hand)\b/.test(t)
  );
}

function detectLienHasPayoffStatement(text: string): boolean {
  const t = String(text ?? "").toLowerCase();
  if (detectLienNoPayoffStatement(t)) return false;
  return /\b(lien|payoff|loan on it|still owe|lender|finance company|bank note)\b/.test(t);
}

function detectNeedsLienHolderInfo(text: string): boolean {
  const t = String(text ?? "").toLowerCase();
  return (
    /\b(didn'?t|do not|don't|dont|not)\b.{0,30}\blien holder\b.{0,25}\b(info|address)\b/.test(t) ||
    /\b(need|have|get)\b.{0,25}\blien holder\b.{0,20}\b(address|info)\b/.test(t) ||
    /\blien holder'?s?\s+address\b/.test(t) ||
    /\bpayoff address\b/.test(t)
  );
}

function detectAgentAskedLienPayoff(text: string): boolean {
  const t = String(text ?? "").toLowerCase();
  return /\b(do you have|any)\b.{0,25}\b(lien|payoff)\b/.test(t);
}

function detectAgentProvidedLienHolderInfo(text: string): boolean {
  const t = String(text ?? "").toLowerCase();
  const hasHolderTerm =
    /\b(lien holder|lender|payoff)\b/.test(t) || /\b(bank|credit union|savings bank)\b/.test(t);
  const hasAddressPattern =
    /\b(p\.?\s*o\.?\s*box|suite|ste\.?|street|st\.|avenue|ave\.?|road|rd\.|boulevard|blvd|drive|dr\.|lane|ln\.|court|ct\.|way|circle|cir|hwy|highway)\b/.test(
      t
    ) || /\b,\s*[a-z]{2}\s+\d{5}(?:-\d{4})?\b/.test(t);
  return hasHolderTerm && hasAddressPattern;
}

function ensureFinanceDocsState(conv: Conversation): FinanceDocsState {
  if (!conv.financeDocs) {
    conv.financeDocs = {
      status: "none",
      updatedAt: nowIso()
    };
  }
  return conv.financeDocs;
}

function ensureTradePayoffState(conv: Conversation): TradePayoffState {
  if (!conv.tradePayoff) {
    conv.tradePayoff = {
      status: "unknown",
      updatedAt: nowIso()
    };
  }
  return conv.tradePayoff;
}

function recomputeFinanceDocsState(state: FinanceDocsState): void {
  const pendingInsurance = !!state.insuranceRequested && !state.insuranceReceived;
  const pendingBinder = !!state.binderRequested && !state.binderReceived;
  const pendingLicense = !!state.licenseRequested && !state.licenseReceived;
  if (!state.insuranceRequested && !state.binderRequested && !state.licenseRequested) {
    state.status = "none";
    state.completedAt = undefined;
    return;
  }
  if (pendingInsurance || pendingBinder || pendingLicense) {
    state.status = "pending";
    state.completedAt = undefined;
    return;
  }
  state.status = "complete";
  state.completedAt = state.completedAt ?? nowIso();
}

function normalizeTradePayoffState(state: TradePayoffState): void {
  if (state.status === "no_lien") {
    state.lienHolderNeeded = false;
  }
  if (state.status === "has_lien" && state.lienHolderProvided) {
    state.lienHolderNeeded = false;
  }
}

function trackFinanceDocsRequestFromOutbound(conv: Conversation, body: string): void {
  const signal = detectFinanceDocRequestSignals(body);
  if (!signal.insuranceRequested && !signal.binderRequested && !signal.licenseRequested) return;
  const state = ensureFinanceDocsState(conv);
  const now = nowIso();
  if (signal.insuranceRequested) {
    state.insuranceRequested = true;
    state.requestedAt = state.requestedAt ?? now;
  }
  if (signal.binderRequested) {
    state.binderRequested = true;
    state.requestedAt = state.requestedAt ?? now;
  }
  if (signal.licenseRequested) {
    state.licenseRequested = true;
    state.requestedAt = state.requestedAt ?? now;
  }
  state.updatedAt = now;
  recomputeFinanceDocsState(state);
}

function inferRequestedFinanceDocsFromRecentOutbound(conv: Conversation): {
  insuranceRequested: boolean;
  binderRequested: boolean;
  licenseRequested: boolean;
} {
  const recentOut = [...(conv.messages ?? [])]
    .reverse()
    .filter(
      m =>
        m.direction === "out" &&
        (m.provider === "twilio" || m.provider === "human" || m.provider === "sendgrid")
    )
    .slice(0, 10);
  let insuranceRequested = false;
  let binderRequested = false;
  let licenseRequested = false;
  for (const m of recentOut) {
    const signal = detectFinanceDocRequestSignals(String(m.body ?? ""));
    if (signal.insuranceRequested) insuranceRequested = true;
    if (signal.binderRequested) binderRequested = true;
    if (signal.licenseRequested) licenseRequested = true;
  }
  return { insuranceRequested, binderRequested, licenseRequested };
}

function trackFinanceDocsReceiptFromInbound(conv: Conversation, evt: InboundMessageEvent): void {
  const hasMedia =
    (Array.isArray(evt.mediaUrls) && evt.mediaUrls.length > 0) ||
    looksLikeAttachmentPlaceholderBody(evt.body);
  if (!hasMedia) return;
  const mentions = detectFinanceDocMentionSignals(evt.body);
  const inferredRequest = inferRequestedFinanceDocsFromRecentOutbound(conv);
  const hasTrackedRequest = !!(
    conv.financeDocs?.insuranceRequested ||
    conv.financeDocs?.binderRequested ||
    conv.financeDocs?.licenseRequested
  );
  const hasInferredRequest =
    inferredRequest.insuranceRequested ||
    inferredRequest.binderRequested ||
    inferredRequest.licenseRequested;
  if (
    !hasTrackedRequest &&
    !hasInferredRequest &&
    !mentions.insuranceMentioned &&
    !mentions.binderMentioned &&
    !mentions.licenseMentioned
  ) {
    return;
  }
  const state = ensureFinanceDocsState(conv);
  let changed = false;
  const now = nowIso();

  if (inferredRequest.insuranceRequested && !state.insuranceRequested) {
    state.insuranceRequested = true;
    state.requestedAt = state.requestedAt ?? now;
    changed = true;
  }
  if (inferredRequest.binderRequested && !state.binderRequested) {
    state.binderRequested = true;
    state.requestedAt = state.requestedAt ?? now;
    changed = true;
  }
  if (inferredRequest.licenseRequested && !state.licenseRequested) {
    state.licenseRequested = true;
    state.requestedAt = state.requestedAt ?? now;
    changed = true;
  }

  if (mentions.insuranceMentioned && !state.insuranceReceived) {
    state.insuranceReceived = true;
    state.insuranceReceivedAt = now;
    changed = true;
  }
  if (mentions.binderMentioned && !state.binderReceived) {
    state.binderReceived = true;
    state.binderReceivedAt = now;
    changed = true;
  }
  if (mentions.licenseMentioned && !state.licenseReceived) {
    state.licenseReceived = true;
    state.licenseReceivedAt = now;
    changed = true;
  }

  if (!mentions.insuranceMentioned && !mentions.binderMentioned && !mentions.licenseMentioned) {
    if (state.insuranceRequested && !state.insuranceReceived) {
      state.insuranceReceived = true;
      state.insuranceReceivedAt = now;
      changed = true;
    } else if (state.binderRequested && !state.binderReceived) {
      state.binderReceived = true;
      state.binderReceivedAt = now;
      changed = true;
    } else if (state.licenseRequested && !state.licenseReceived) {
      state.licenseReceived = true;
      state.licenseReceivedAt = now;
      changed = true;
    }
  }

  if (changed) {
    state.lastInboundMessageId = evt.providerMessageId ?? state.lastInboundMessageId;
    state.updatedAt = now;
    recomputeFinanceDocsState(state);
  }
}

function trackTradePayoffFromInbound(conv: Conversation, evt: InboundMessageEvent): void {
  const body = String(evt.body ?? "");
  if (!body.trim()) return;
  const noLien = detectLienNoPayoffStatement(body);
  const hasLien = detectLienHasPayoffStatement(body);
  const needsHolder = detectNeedsLienHolderInfo(body);
  if (!noLien && !hasLien && !needsHolder) return;

  const state = ensureTradePayoffState(conv);
  const now = nowIso();
  if (noLien) {
    state.status = "no_lien";
    state.lastAnsweredAt = now;
    state.lienHolderNeeded = false;
  } else if (hasLien) {
    state.status = "has_lien";
    state.lastAnsweredAt = now;
  }
  if (needsHolder) {
    state.status = "has_lien";
    state.lienHolderNeeded = true;
  }
  normalizeTradePayoffState(state);
  state.updatedAt = now;
}

function trackTradePayoffFromOutbound(conv: Conversation, body: string): void {
  const text = String(body ?? "");
  if (!text.trim()) return;
  const asked = detectAgentAskedLienPayoff(text);
  const providedHolder = detectAgentProvidedLienHolderInfo(text);
  if (!asked && !providedHolder) return;

  const state = ensureTradePayoffState(conv);
  const now = nowIso();
  if (asked) {
    state.lienQuestionAskedAt = now;
    if (state.status !== "no_lien" && state.status !== "has_lien") {
      state.status = "unknown";
    }
  }
  if (providedHolder) {
    state.status = "has_lien";
    state.lienHolderProvided = true;
    state.lienHolderProvidedAt = now;
    state.lienHolderNeeded = false;
  }
  normalizeTradePayoffState(state);
  state.updatedAt = now;
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
    leadKeyIndex.clear();
    for (const c of list) {
      // Defensive normalization: prevent one malformed row from taking down
      // list rendering/API responses.
      if (!Array.isArray((c as any)?.messages)) {
        (c as any).messages = [];
      }
      const leadKey = normalizeLeadKey(c?.leadKey || c?.id || "");
      if (!leadKey) continue;
      c.leadKey = leadKey;
      const preferredId = String(c?.id ?? "").trim() || leadKey;
      const id = conversations.has(preferredId) ? buildConversationId(leadKey) : preferredId;
      c.id = id;
      conversations.set(id, c);
      indexConversationByLeadKey(c);
    }
    todos.length = 0;
    if (parsed?.todos?.length) {
      for (const task of parsed.todos) {
      const inferredClass = inferTodoTaskClass(task.reason, task.summary, task);
      const explicitClass = String(task.taskClass ?? "").trim().toLowerCase();
      const knownExplicitClass =
        explicitClass === "followup" ||
        explicitClass === "appointment" ||
        explicitClass === "todo" ||
        explicitClass === "reminder";
        if (
          task.reason === "call" ||
          !knownExplicitClass ||
          explicitClass === "todo" ||
          (explicitClass === "appointment" && inferredClass !== "appointment")
        ) {
          // Normalize legacy classes (especially default "todo") so cadence
          // follow-ups, appointment tasks, reminders, and generic todos render
          // in the correct sections.
          task.taskClass = inferredClass;
        }
        todos.push(task);
      }
    }
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
  const leadKey = normalizeLeadKey(conv.leadKey || "");
  if (!leadKey) return;
  conv.leadKey = leadKey;
  if (!conv.id) {
    conv.id = buildConversationId(leadKey);
  }
  const prev = conversations.get(conv.id);
  if (prev && prev !== conv && normalizeLeadKey(prev.leadKey || "") !== leadKey) {
    removeConversationFromLeadIndex(prev);
  }
  conversations.set(conv.id, conv);
  indexConversationByLeadKey(conv);
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
  const key = normalizeLeadKey(leadKey) || `unknown_${Date.now()}`;
  const existing = getLatestConversationByLeadKey(key);
  if (existing) return existing;

  const created: Conversation = {
    id: buildConversationId(key),
    leadKey: key,
    mode: defaultMode,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    messages: [],
    scheduler: { updatedAt: nowIso(), lastSuggestedSlots: [] }
  };

  conversations.set(created.id, created);
  indexConversationByLeadKey(created);
  scheduleSave();
  return created;
}

export function createConversationForLeadKey(
  leadKey: string,
  defaultMode: ConversationMode = "suggest"
): Conversation {
  const key = normalizeLeadKey(leadKey) || `unknown_${Date.now()}`;
  const created: Conversation = {
    id: buildConversationId(key),
    leadKey: key,
    mode: defaultMode,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    messages: [],
    scheduler: { updatedAt: nowIso(), lastSuggestedSlots: [] }
  };
  conversations.set(created.id, created);
  indexConversationByLeadKey(created);
  scheduleSave();
  return created;
}

export function setConversationMode(id: string, mode: ConversationMode): Conversation | null {
  const conv = getConversation(id);
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
    const closedReason = String(conv.closedReason ?? "").toLowerCase();
    const stickyClosed =
      closedReason === "sold" ||
      /\bhold\b/.test(closedReason) ||
      !!conv.sale?.soldAt ||
      !!conv.hold ||
      /\b(unit_hold|order_hold|manual_hold|post_sale)\b/.test(
        String(conv.followUp?.reason ?? "").toLowerCase()
      );
    if (!stickyClosed) {
      conv.status = "open";
      conv.closedAt = undefined;
      conv.closedReason = undefined;
    }
  }
  conv.messages.push({
    id: makeId("msg"),
    direction: "in",
    from: evt.from,
    to: evt.to,
    body: evt.body,
    mediaUrls: evt.mediaUrls && evt.mediaUrls.length ? evt.mediaUrls : undefined,
    at: evt.receivedAt,
    provider: evt.provider as MessageProvider,
    providerMessageId: evt.providerMessageId
  });
  trackFinanceDocsReceiptFromInbound(conv, evt);
  trackTradePayoffFromInbound(conv, evt);
  maybeMarkEngagedFromInbound(conv, evt);
  consumeAgentContextOnInboundIfNeeded(conv, "inbound_customer_reply");
  conv.updatedAt = nowIso();
  scheduleSave();
}

function normalizeInboundDedupBody(input: string): string {
  return String(input ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

const PENDING_SHORTLIST_SOFT_TAG = "pending_shortlist_prompt";
const PENDING_SHORTLIST_TTL_MS = 72 * 60 * 60 * 1000;

function outboundAsksForShortList(body: string): boolean {
  const text = String(body ?? "").trim();
  if (!text) return false;
  return /\b(want me to send|i can send|happy to send)\b[\s\S]{0,100}\b(short list|couple models?|list of bikes?|options that fit)\b/i.test(
    text
  );
}

function markPendingShortListPrompt(conv: Conversation, source: string): void {
  const now = nowIso();
  const expiresAt = new Date(Date.now() + PENDING_SHORTLIST_TTL_MS).toISOString();
  conv.softTags = {
    ...(conv.softTags ?? {}),
    [PENDING_SHORTLIST_SOFT_TAG]: {
      value: "1",
      source,
      updatedAt: now,
      expiresAt,
      meta: {
        askedAt: now,
        ttlMs: PENDING_SHORTLIST_TTL_MS
      }
    }
  };
}

export function isDuplicateInboundEvent(
  conv: Conversation,
  evt: InboundMessageEvent,
  opts?: { windowMs?: number }
): boolean {
  const messages = Array.isArray(conv.messages) ? conv.messages : [];
  if (!messages.length) return false;
  const provider = String(evt.provider ?? "").trim().toLowerCase();
  const providerMessageId = String(evt.providerMessageId ?? "").trim();
  if (providerMessageId) {
    return messages.some(
      m =>
        m.direction === "in" &&
        String(m.provider ?? "").trim().toLowerCase() === provider &&
        String(m.providerMessageId ?? "").trim() === providerMessageId
    );
  }

  const bodyNorm = normalizeInboundDedupBody(evt.body);
  if (!bodyNorm) return false;
  const from = String(evt.from ?? "").trim();
  const to = String(evt.to ?? "").trim();
  const nowMs = Date.now();
  const windowMs = Number(opts?.windowMs ?? 2 * 60 * 1000);
  const recentInbound = [...messages].reverse().find(
    m => m.direction === "in" && String(m.provider ?? "").trim().toLowerCase() === provider
  );
  if (!recentInbound) return false;
  const recentBody = normalizeInboundDedupBody(recentInbound.body);
  if (recentBody !== bodyNorm) return false;
  if (String(recentInbound.from ?? "").trim() !== from) return false;
  if (String(recentInbound.to ?? "").trim() !== to) return false;
  const atMs = Date.parse(String(recentInbound.at ?? ""));
  if (!Number.isFinite(atMs)) return false;
  return nowMs - atMs <= windowMs;
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
  const isEmailThread = String(from ?? "").includes("@") || String(to ?? "").includes("@");
  const salesToneProvider = provider === "draft_ai" || provider === "twilio" || provider === "sendgrid";
  const lastInbound = [...(conv.messages || [])]
    .reverse()
    .find(m => m.direction === "in" && m.body);
  const inboundText = lastInbound?.body ?? "";
  const normalizedBody = normalizeGotItLeadIn(body, inboundText, provider);
  let stateSignalBody = salesToneProvider ? normalizeSalesToneBase(normalizedBody) : normalizedBody;
  let tonedBody = stateSignalBody;
  if (provider === "draft_ai") {
    const invariant = applyDraftStateInvariants({
      inboundText,
      draftText: tonedBody,
      followUpMode: conv.followUp?.mode ?? null,
      followUpReason: conv.followUp?.reason ?? null,
      dialogState: conv.dialogState?.name ?? null,
      classificationBucket: conv.classification?.bucket ?? null,
      classificationCta: conv.classification?.cta ?? null
    });
    if (!invariant.allow) {
      conv.updatedAt = nowIso();
      scheduleSave();
      return;
    }
    tonedBody = invariant.draftText;
    stateSignalBody = invariant.draftText;
  }
  if (salesToneProvider) {
    tonedBody = applyDeterministicToneOverrides(tonedBody);
  }
  if (!isEmailThread) {
    tonedBody = formatSmsLayout(tonedBody);
  }
  // If this is an email-thread draft, store it as an email draft instead of a SMS draft.
  if (
    provider === "draft_ai" &&
    isEmailThread
  ) {
    const firstName = String(conv?.lead?.firstName ?? conv?.lead?.name ?? "").trim();
    const emailDraft = formatEmailLayout(tonedBody, { firstName, fallbackName: "there" });
    conv.emailDraft = emailDraft;
    if (outboundAsksForShortList(stateSignalBody)) {
      markPendingShortListPrompt(conv, `outbound_${provider}`);
    }
    consumeAgentContextIfNeeded(conv, "outbound_email_draft");
    conv.updatedAt = nowIso();
    scheduleSave();
    return;
  }
  if (outboundAsksForShortList(stateSignalBody)) {
    markPendingShortListPrompt(conv, `outbound_${provider}`);
  }
  conv.messages.push({
    id: makeId("msg"),
    direction: "out",
    from,
    to,
    body: tonedBody,
    mediaUrls: mediaUrls && mediaUrls.length ? mediaUrls : undefined,
    at: nowIso(),
    provider,
    providerMessageId
  });
  if (provider === "twilio" || provider === "human" || provider === "sendgrid") {
    trackFinanceDocsRequestFromOutbound(conv, stateSignalBody);
    trackTradePayoffFromOutbound(conv, stateSignalBody);
  }
  consumeAgentContextIfNeeded(conv, "outbound_sent");
  conv.updatedAt = nowIso();
  scheduleSave();
}

export function setAgentContext(
  conv: Conversation,
  args: {
    text: string;
    mode?: "persistent" | "next_reply";
    expiresAt?: string;
    updatedByUserId?: string;
    updatedByUserName?: string;
  }
) {
  const text = String(args.text ?? "").trim();
  if (!text) {
    clearAgentContext(conv, "empty_text");
    return;
  }
  markNextReplyContextNotesAddressed(conv, "superseded_by_context_update");
  const mode = args.mode === "next_reply" ? "next_reply" : "persistent";
  const expiresAtRaw = String(args.expiresAt ?? "").trim();
  const expiresAt = expiresAtRaw ? new Date(expiresAtRaw) : null;
  const notes = Array.isArray(conv.agentContext?.notes)
    ? conv.agentContext?.notes.slice(-50)
    : undefined;
  conv.agentContext = {
    text: text.slice(0, 2000),
    mode,
    expiresAt: expiresAt && !Number.isNaN(expiresAt.getTime()) ? expiresAt.toISOString() : undefined,
    updatedAt: nowIso(),
    updatedByUserId: String(args.updatedByUserId ?? "").trim() || undefined,
    updatedByUserName: String(args.updatedByUserName ?? "").trim() || undefined,
    consumedAt: undefined,
    consumedReason: undefined,
    notes
  };
  conv.updatedAt = nowIso();
  scheduleSave();
}

export function addAgentContextNote(
  conv: Conversation,
  args: {
    text: string;
    mode?: "persistent" | "next_reply";
    expiresAt?: string;
    createdByUserId?: string;
    createdByUserName?: string;
  }
): AgentContextNote {
  const text = String(args.text ?? "").trim();
  if (!text) {
    throw new Error("Agent context note text required");
  }
  markNextReplyContextNotesAddressed(conv, "superseded_by_new_context_note");
  const mode = args.mode === "next_reply" ? "next_reply" : "persistent";
  const expiresAtRaw = String(args.expiresAt ?? "").trim();
  const expiresAt = expiresAtRaw ? new Date(expiresAtRaw) : null;
  const createdAt = nowIso();
  const note: AgentContextNote = {
    id: makeId("ctxn"),
    text: text.slice(0, 2000),
    mode,
    expiresAt: expiresAt && !Number.isNaN(expiresAt.getTime()) ? expiresAt.toISOString() : undefined,
    createdAt,
    createdByUserId: String(args.createdByUserId ?? "").trim() || undefined,
    createdByUserName: String(args.createdByUserName ?? "").trim() || undefined
  };
  const previousNotes = Array.isArray(conv.agentContext?.notes) ? conv.agentContext.notes : [];
  const nextNotes = [...previousNotes, note].slice(-50);
  conv.agentContext = {
    text: note.text,
    mode: note.mode,
    expiresAt: note.expiresAt,
    updatedAt: createdAt,
    updatedByUserId: note.createdByUserId,
    updatedByUserName: note.createdByUserName,
    consumedAt: undefined,
    consumedReason: undefined,
    notes: nextNotes
  };
  conv.updatedAt = nowIso();
  scheduleSave();
  return note;
}

export function clearAgentContext(conv: Conversation, reason = "manual_clear") {
  if (!conv.agentContext) return;
  conv.agentContext = undefined;
  conv.updatedAt = nowIso();
  scheduleSave();
}

export function getActiveAgentContextText(conv: Conversation): string {
  const context = conv.agentContext;
  if (!context) return "";
  const text = String(context.text ?? "").trim();
  if (!text) return "";
  const expiresAtIso = String(context.expiresAt ?? "").trim();
  if (expiresAtIso) {
    const expiry = new Date(expiresAtIso);
    if (Number.isNaN(expiry.getTime()) || expiry.getTime() <= Date.now()) {
      return "";
    }
  }
  return text;
}

function consumeAgentContextIfNeeded(conv: Conversation, reason: string) {
  const context = conv.agentContext;
  if (!context) return;
  const mode = context.mode === "next_reply" ? "next_reply" : "persistent";
  if (mode !== "next_reply") return;
  markNextReplyContextNotesAddressed(conv, reason);
  const hasNotes = Array.isArray(context.notes) && context.notes.length > 0;
  const active = getActiveAgentContextText(conv);
  if (!active) {
    if (hasNotes) {
      context.text = "";
      context.mode = "persistent";
      context.expiresAt = undefined;
      context.consumedAt = nowIso();
      context.consumedReason = reason;
    } else {
      conv.agentContext = undefined;
    }
    return;
  }
  context.consumedAt = nowIso();
  context.consumedReason = reason;
  if (hasNotes) {
    context.text = "";
    context.mode = "persistent";
    context.expiresAt = undefined;
  } else {
    conv.agentContext = undefined;
  }
}

function markNextReplyContextNotesAddressed(conv: Conversation, reason: string) {
  const notes = conv.agentContext?.notes;
  if (!Array.isArray(notes) || !notes.length) return;
  const at = nowIso();
  let changed = false;
  for (const note of notes) {
    const noteMode = note.mode === "next_reply" ? "next_reply" : "persistent";
    if (noteMode !== "next_reply") continue;
    if (String(note.addressedAt ?? "").trim()) continue;
    note.addressedAt = at;
    note.addressedReason = reason;
    changed = true;
  }
  if (changed) {
    conv.updatedAt = at;
  }
}

function consumeAgentContextOnInboundIfNeeded(conv: Conversation, reason: string) {
  const context = conv.agentContext;
  if (!context) return;
  const mode = context.mode === "next_reply" ? "next_reply" : "persistent";
  if (mode !== "next_reply") return;
  markNextReplyContextNotesAddressed(conv, reason);
  const hasNotes = Array.isArray(context.notes) && context.notes.length > 0;
  context.consumedAt = nowIso();
  context.consumedReason = reason;
  if (hasNotes) {
    context.text = "";
    context.mode = "persistent";
    context.expiresAt = undefined;
  } else {
    conv.agentContext = undefined;
  }
}

function pickLeadInVariant(text: string): string {
  const t = String(text ?? "").toLowerCase();
  if (/(thanks|thank you|thanks again|thx|ty|appreciate)/.test(t)) return "You're welcome.";
  if (/(sorry|apologize|apologies|my bad)/.test(t)) return "No worries.";
  if (/(i left|already left|left a deposit|just letting you know|update)/.test(t)) return "Thanks for the update.";
  if (/(can you|could you|would you|do you|is it possible)/.test(t)) return "Sure.";
  if (/(i want|i'd like|i would like|looking to|want to)/.test(t)) return "Absolutely.";
  if (/[?]/.test(t)) return "Got it.";
  return "Sounds good.";
}

function normalizeGotItLeadIn(body: string, inboundText: string, provider: MessageProvider): string {
  if (!body) return body;
  if (!(provider === "twilio" || provider === "draft_ai")) return body;
  const trimmed = body.trim();
  const match = trimmed.match(/^got it(?:\s*[—–-]|\.|,|!|:)?\s*/i);
  if (!match) return body;
  const rest = trimmed.slice(match[0].length);
  const leadIn = pickLeadInVariant(inboundText);
  if (!rest) return leadIn;
  return `${leadIn} ${rest}`.trim();
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
  const stateSignalBody = normalizeSalesToneBase(finalBody);
  const tonedFinalBody = applyDeterministicToneOverrides(stateSignalBody);
  if (original.trim() !== tonedFinalBody.trim()) {
    msg.originalDraftBody = original;
  }
  msg.body = tonedFinalBody;
  msg.provider = provider;
  msg.providerMessageId = providerMessageId;
  msg.at = new Date().toISOString();
  msg.draftStatus = undefined;

  if (provider === "twilio" || provider === "human" || provider === "sendgrid") {
    trackFinanceDocsRequestFromOutbound(conv, stateSignalBody);
    trackTradePayoffFromOutbound(conv, stateSignalBody);
  }

  conv.updatedAt = new Date().toISOString();
  scheduleSave();

  return { usedDraft: true, originalDraftBody: original };
}

export function setMessageFeedback(
  conv: Conversation,
  messageId: string,
  feedback: MessageFeedback | null
): Message | null {
  const msg = conv.messages.find(m => m.id === messageId);
  if (!msg) return null;
  if (feedback) {
    msg.feedback = {
      rating: feedback.rating,
      reason: feedback.reason,
      note: feedback.note,
      byUserId: feedback.byUserId,
      byUserName: feedback.byUserName,
      at: feedback.at || nowIso()
    };
  } else {
    delete msg.feedback;
  }
  conv.updatedAt = nowIso();
  scheduleSave();
  return msg;
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

function normalizeSoftTagKey(raw: string): string {
  return String(raw ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64);
}

export function setConversationSoftTag(
  conv: Conversation,
  key: string,
  patch: {
    value?: string;
    source?: string;
    confidence?: number;
    expiresAt?: string;
    ttlMs?: number;
    meta?: Record<string, string | number | boolean | null>;
  }
): Conversation {
  const normalizedKey = normalizeSoftTagKey(key);
  if (!normalizedKey) return conv;
  const now = nowIso();
  const current = conv.softTags?.[normalizedKey];
  const ttlMs =
    typeof patch.ttlMs === "number" && Number.isFinite(patch.ttlMs) && patch.ttlMs > 0
      ? patch.ttlMs
      : null;
  const computedExpiry = ttlMs ? new Date(Date.now() + ttlMs).toISOString() : undefined;
  const expiresAt = patch.expiresAt ?? computedExpiry ?? current?.expiresAt;
  const confidence =
    typeof patch.confidence === "number" && Number.isFinite(patch.confidence)
      ? Math.max(0, Math.min(1, patch.confidence))
      : current?.confidence;
  const nextValue: ConversationSoftTagValue = {
    value: patch.value ?? current?.value,
    source: patch.source ?? current?.source,
    confidence,
    updatedAt: now,
    expiresAt,
    meta: patch.meta ?? current?.meta
  };
  conv.softTags = {
    ...(conv.softTags ?? {}),
    [normalizedKey]: nextValue
  };
  conv.updatedAt = now;
  scheduleSave();
  return conv;
}

export function discardPendingDrafts(conv: Conversation, reason?: string) {
  let lastSentIdx = -1;
  for (let i = 0; i < conv.messages.length; i++) {
    const m = conv.messages[i];
    if (m.direction !== "out") continue;
    if (m.provider === "human" || m.provider === "twilio" || m.provider === "sendgrid") {
      lastSentIdx = i;
    }
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
    if (m.provider === "human" || m.provider === "twilio" || m.provider === "sendgrid") {
      lastSentIdx = i;
    }
  }

  if (lastDraftIdx > lastSentIdx) return conv.messages[lastDraftIdx] ?? null;
  return null;
}

const WALK_IN_SOURCE_RE = /traffic log pro|walk[\s_-]*in|dealer lead app/i;

function extractAdfSourceLine(body: string): string {
  const match = String(body ?? "").match(/(?:^|\n)\s*source:\s*([^\n\r]+)/i);
  return String(match?.[1] ?? "").trim();
}

export function inferWalkIn(conv: Conversation): boolean {
  if (conv.lead?.walkIn) return true;
  if (String(conv.dialogState?.name ?? "") === "walk_in_active") return true;
  const firstAdfBody =
    conv.messages.find(
      m =>
        m.direction === "in" &&
        m.provider === "sendgrid_adf" &&
        typeof m.body === "string"
    )?.body ?? "";
  const firstAdfSource = extractAdfSourceLine(firstAdfBody);
  const firstAdfSourceSignalsWalkIn = WALK_IN_SOURCE_RE.test(firstAdfSource);
  const firstAdfSourceLocksNonWalkIn = !!firstAdfSource && !firstAdfSourceSignalsWalkIn;
  if (firstAdfSourceLocksNonWalkIn) return false;
  const leadSource = String(conv.lead?.source ?? "");
  const legacyLeadSource = String((conv as any)?.leadSource ?? "");
  const bucket = String(conv.classification?.bucket ?? "").toLowerCase();
  const ruleName = String(conv.classification?.ruleName ?? "").toLowerCase();
  if (bucket === "in_store") return true;
  if (ruleName.includes("dealer_lead_app")) return true;
  const sourceMatch =
    WALK_IN_SOURCE_RE.test(leadSource) ||
    WALK_IN_SOURCE_RE.test(legacyLeadSource) ||
    WALK_IN_SOURCE_RE.test(firstAdfSource);
  return sourceMatch;
}

function isConversationOnHoldForHot(conv: Conversation): boolean {
  return (
    conv.followUpCadence?.pauseReason === "manual_hold" ||
    conv.followUpCadence?.pauseReason === "unit_hold" ||
    conv.followUpCadence?.pauseReason === "order_hold" ||
    conv.followUpCadence?.stopReason === "unit_hold" ||
    conv.followUpCadence?.stopReason === "order_hold" ||
    conv.followUp?.reason === "manual_hold" ||
    conv.followUp?.reason === "unit_hold" ||
    conv.followUp?.reason === "order_hold" ||
    !!conv.hold
  );
}

function isSoldConversationForHot(conv: Conversation): boolean {
  return (conv.status === "closed" && conv.closedReason === "sold") || !!conv.sale?.soldAt;
}

function hasDirectCustomerEngagementForHot(conv: Conversation, hasInboundTwilio: boolean): boolean {
  if (hasInboundTwilio) return true;
  if (String(conv.engagement?.source ?? "").toLowerCase() === "call" && conv.engagement?.at) return true;
  const hasInboundVoiceTranscript = (conv.messages ?? []).some(m => {
    if (m?.direction !== "in") return false;
    const provider = String(m?.provider ?? "").toLowerCase();
    return provider === "voice_transcript" || provider === "call_transcript";
  });
  if (hasInboundVoiceTranscript) return true;
  return false;
}

function hasActionableAdfInquiryHotIntent(conv: Conversation): boolean {
  const adfMessages = (conv.messages ?? []).filter(
    m => m?.direction === "in" && String(m?.provider ?? "").toLowerCase() === "sendgrid_adf"
  );
  if (!adfMessages.length) return false;
  const strongIntentPattern =
    /\b(ready to (buy|pull the trigger)|let'?s make a deal|i have cash|cash buyer|coming to look|coming in|come in|can i come in|want to come in|stop in|swing by|be there|today works|tomorrow works|test ride|schedule|appointment|book(?:\s+an?)?\s+appointment|in stock|availability|pricing|payments?|finance specials?|trade[-\s]?in|watch for|interested in buying|looking to buy|want to buy)\b/i;
  const nearTermPurchasePattern =
    /\bpurchase timeframe:\s*(0-3 months|yes,\s*in less than 3 months|yes,\s*in less than a month)\b/i;
  const uninterestedPattern =
    /\b(i am not interested in purchasing at this time|not interested in purchasing|not interested)\b/i;
  for (const m of adfMessages) {
    const body = String(m?.body ?? "");
    if (!body) continue;
    const inquiryIdx = body.toLowerCase().lastIndexOf("inquiry:");
    const inquiryText = (inquiryIdx >= 0 ? body.slice(inquiryIdx + "inquiry:".length) : body).trim();
    if (!inquiryText) continue;
    if (uninterestedPattern.test(inquiryText)) continue;
    if (strongIntentPattern.test(inquiryText)) return true;
    if (nearTermPurchasePattern.test(inquiryText)) return true;
  }
  return false;
}

function extractInboundAdfInquiryTexts(conv: Conversation): string[] {
  const adfMessages = (conv.messages ?? []).filter(
    m => m?.direction === "in" && String(m?.provider ?? "").toLowerCase() === "sendgrid_adf"
  );
  const inquiryTexts: string[] = [];
  for (const m of adfMessages) {
    const body = String(m?.body ?? "");
    if (!body) continue;
    const inquiryIdx = body.toLowerCase().lastIndexOf("inquiry:");
    const inquiryText = (inquiryIdx >= 0 ? body.slice(inquiryIdx + "inquiry:".length) : body)
      .replace(/\s+/g, " ")
      .trim();
    if (!inquiryText) continue;
    inquiryTexts.push(inquiryText);
  }
  return inquiryTexts;
}

function hasNonSalesInquiryLanguage(text: string): boolean {
  const normalized = String(text ?? "").toLowerCase();
  if (!normalized) return false;
  const directNonSalesPattern =
    /\b(oil change|nys inspection|state inspection|inspection\b|maintenance|repair|service department|service request|parts? department|part number|need\s+(?:a|an)?\s*part|order(?:ing)?\s+(?:a|an)?\s*part|motorclothes|apparel)\b/i;
  if (directNonSalesPattern.test(normalized)) return true;
  if (!/\bservice\b/i.test(normalized)) return false;
  const purchaseIntentPattern =
    /\b(test ride|buy|purchase|price|pricing|payment|finance|trade|in stock|availability|quote|appointment|schedule (?:a )?(?:test ride|visit|appointment)|street glide|road glide|nightster|sportster)\b/i;
  return !purchaseIntentPattern.test(normalized);
}

function isNonSalesLeadForHeat(conv: Conversation): boolean {
  const bucket = String(conv.classification?.bucket ?? "").trim().toLowerCase();
  const cta = String(conv.classification?.cta ?? "").trim().toLowerCase();
  const leadSource = String(conv.lead?.source ?? "").trim().toLowerCase();
  const nonDealBuckets = new Set(["service", "parts", "apparel"]);
  const nonDealCtas = new Set(["service_request", "parts_request", "apparel_request"]);
  if (nonDealBuckets.has(bucket) || nonDealCtas.has(cta)) return true;
  if (/\b(service|parts?|apparel|motorclothes)\b/.test(leadSource)) return true;
  const adfInquiryTexts = extractInboundAdfInquiryTexts(conv);
  if (adfInquiryTexts.some(hasNonSalesInquiryLanguage)) return true;
  return false;
}

function computeStickyHotDealSignal(conv: Conversation, hasInboundTwilio: boolean): boolean {
  if (isSoldConversationForHot(conv)) return false;
  if (isConversationOnHoldForHot(conv)) return false;
  if (String(conv.status ?? "").trim().toLowerCase() === "closed") return false;
  if (isNonSalesLeadForHeat(conv)) return false;

  const leadSource = String(conv.lead?.source ?? "").trim().toLowerCase();
  const bucket = String(conv.classification?.bucket ?? "").trim().toLowerCase();
  const cta = String(conv.classification?.cta ?? "").trim().toLowerCase();
  const engagementReason = String(conv.engagement?.reason ?? "").trim().toLowerCase();

  const isPrequal =
    bucket === "finance_prequal" ||
    cta === "prequalify" ||
    leadSource.includes("marketplace - prequal") ||
    leadSource.includes("prequal");
  if (isPrequal) return false;

  const isCoa =
    cta === "hdfs_coa" ||
    leadSource.includes("hdfs coa") ||
    leadSource.includes("coa online") ||
    leadSource.includes("credit application");
  if (isCoa) return true;

  const hasDirectEngagement = hasDirectCustomerEngagementForHot(conv, hasInboundTwilio);
  if (!hasDirectEngagement) {
    if (hasActionableAdfInquiryHotIntent(conv)) return true;
    return false;
  }

  const purchaseBuckets = new Set(["inventory_interest", "test_ride", "pricing_payments"]);
  const purchaseCtas = new Set([
    "check_availability",
    "request_a_quote",
    "schedule_test_ride",
    "value_my_trade",
    "sell_my_bike",
    "hdfs_coa",
    "book_appointment",
    "schedule_appointment"
  ]);
  const nonDealBuckets = new Set(["service", "parts", "apparel"]);
  const nonDealCtas = new Set(["service_request", "parts_request", "apparel_request"]);
  if (nonDealBuckets.has(bucket) || nonDealCtas.has(cta)) return false;
  if (purchaseBuckets.has(bucket) || purchaseCtas.has(cta)) return true;

  if (
    engagementReason === "purchase" ||
    engagementReason === "schedule" ||
    engagementReason === "trade" ||
    engagementReason === "finance" ||
    engagementReason === "pricing" ||
    engagementReason === "availability"
  ) {
    return true;
  }

  const apptStatus = String(conv.appointment?.status ?? "").trim().toLowerCase();
  if (apptStatus && apptStatus !== "cancelled" && apptStatus !== "no_show") return true;
  if (conv.inventoryWatch || (Array.isArray(conv.inventoryWatches) && conv.inventoryWatches.length > 0)) {
    return true;
  }
  if (!hasInboundTwilio) return false;

  const hasInventoryListSignal = conv.messages.some(m => {
    const body = String(m?.body ?? "").trim().toLowerCase();
    if (!body) return false;
    return (
      /\btop options:\b/.test(body) ||
      /\bwe have\s+\d+\s+(?:new|used|pre[-\s]?owned)?[\s\S]{0,80}\bin stock\b/.test(body) ||
      /\bhttps?:\/\/\S*\/inventory\/\S+/i.test(body)
    );
  });
  if (hasInventoryListSignal) return true;

  const hasInboundPurchaseLanguage = conv.messages.some(m => {
    if (m?.direction !== "in") return false;
    if (String(m?.provider ?? "").toLowerCase() !== "twilio") return false;
    const body = String(m?.body ?? "").trim().toLowerCase();
    if (!body) return false;
    return /\b(road glide|street glide|touring|cruiser|trike|used|new|in stock|available|payment|monthly|apr|down payment|trade|appointment|schedule|come in|stop by|test ride)\b/.test(
      body
    );
  });
  return hasInboundPurchaseLanguage;
}

function parseAtMs(value: unknown): number {
  const ms = Date.parse(String(value ?? ""));
  return Number.isFinite(ms) ? ms : NaN;
}

function hasNotInterestedSignalForHeat(conv: Conversation): boolean {
  const closeReason = String(conv.closedReason ?? "").trim().toLowerCase();
  const cadenceStop = String(conv.followUpCadence?.stopReason ?? "").trim().toLowerCase();
  const followUpReason = String(conv.followUp?.reason ?? "").trim().toLowerCase();
  const reasonText = `${closeReason} ${cadenceStop} ${followUpReason}`;
  if (/\b(not[_\s-]?interested|bought[_\s-]?elsewhere|lost|do[_\s-]?not[_\s-]?contact)\b/.test(reasonText)) {
    return true;
  }
  const latestInbound = [...(conv.messages ?? [])]
    .reverse()
    .find(
      m => m?.direction === "in" && (String(m?.provider ?? "").toLowerCase() === "twilio")
    );
  if (!latestInbound?.body) return false;
  const text = String(latestInbound.body).toLowerCase();
  return /\b(not interested|no longer interested|already bought|bought elsewhere|take me off|remove me|stop texting|do not text)\b/.test(
    text
  );
}

function computeLastHotSignalAtMs(conv: Conversation, hasInboundTwilio: boolean): number {
  let best = NaN;
  const keep = (at: unknown) => {
    const ms = parseAtMs(at);
    if (!Number.isFinite(ms)) return;
    if (!Number.isFinite(best) || ms > best) best = ms;
  };

  const engagementReason = String(conv.engagement?.reason ?? "").trim().toLowerCase();
  if (
    engagementReason === "purchase" ||
    engagementReason === "schedule" ||
    engagementReason === "trade" ||
    engagementReason === "finance" ||
    engagementReason === "pricing" ||
    engagementReason === "availability"
  ) {
    keep(conv.engagement?.at);
  }

  const apptStatus = String(conv.appointment?.status ?? "").trim().toLowerCase();
  if (apptStatus && apptStatus !== "cancelled" && apptStatus !== "no_show") {
    keep(conv.appointment?.updatedAt);
    keep(conv.appointment?.whenIso);
  }

  const addWatchHotTime = (watch: any) => {
    if (!watch) return;
    keep(watch.lastNotifiedAt);
    keep(watch.createdAt);
  };
  addWatchHotTime(conv.inventoryWatch);
  for (const watch of conv.inventoryWatches ?? []) addWatchHotTime(watch);

  const leadSource = String(conv.lead?.source ?? "").trim().toLowerCase();
  const bucket = String(conv.classification?.bucket ?? "").trim().toLowerCase();
  const cta = String(conv.classification?.cta ?? "").trim().toLowerCase();
  const isCoaLead =
    cta === "hdfs_coa" ||
    leadSource.includes("hdfs coa") ||
    leadSource.includes("coa online") ||
    leadSource.includes("credit application");

  const inboundPurchaseLexical =
    /\b(road glide|street glide|touring|cruiser|trike|used|new|in stock|available|payment|monthly|apr|down payment|trade|appointment|schedule|come in|stop by|test ride|pricing|price|quote|finance)\b/i;
  const inboundNotInterested =
    /\b(not interested|no longer interested|already bought|bought elsewhere|take me off|remove me|stop texting|do not text)\b/i;
  for (const m of conv.messages ?? []) {
    if (m?.direction !== "in") continue;
    const provider = String(m?.provider ?? "").toLowerCase();
    const body = String(m?.body ?? "");
    if (provider === "twilio") {
      if (inboundNotInterested.test(body)) continue;
      if (inboundPurchaseLexical.test(body)) keep(m.at);
      continue;
    }
    if (provider === "sendgrid_adf" && isCoaLead) {
      keep(m.at);
    }
  }

  if (!Number.isFinite(best) && hasInboundTwilio) {
    const latestInboundTwilio = [...(conv.messages ?? [])]
      .reverse()
      .find(m => m?.direction === "in" && String(m?.provider ?? "").toLowerCase() === "twilio");
    if (latestInboundTwilio) keep(latestInboundTwilio.at);
  }

  return best;
}

function computeDealTemperature(
  conv: Conversation,
  hasInboundTwilio: boolean,
  hotDealSticky: boolean
): "hot" | "warm" | "cold" | null {
  if (!hotDealSticky) return null;
  if (isSoldConversationForHot(conv)) return null;
  if (isConversationOnHoldForHot(conv)) return null;
  if (String(conv.status ?? "").trim().toLowerCase() === "closed") return null;
  if (isNonSalesLeadForHeat(conv)) return null;
  if (hasNotInterestedSignalForHeat(conv)) return null;

  const lastHotAtMs = computeLastHotSignalAtMs(conv, hasInboundTwilio);
  if (!Number.isFinite(lastHotAtMs)) return "hot";
  const ageMs = Date.now() - lastHotAtMs;
  const warmCutoffMs = 60 * 24 * 60 * 60 * 1000;
  const coldCutoffMs = 120 * 24 * 60 * 60 * 1000;
  if (ageMs <= warmCutoffMs) return "hot";
  if (ageMs <= coldCutoffMs) return "warm";
  return "cold";
}

function normalizeModelInterestText(value?: string | null): string {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

function isGenericModelInterest(value?: string | null): boolean {
  const raw = normalizeModelInterestText(value);
  if (!raw) return true;
  const normalized = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  if (!normalized) return true;
  if (/^\d{4}$/.test(normalized)) return true;
  if (normalized === "new" || normalized === "used") return true;
  const generic = new Set([
    "other",
    "full line",
    "unknown",
    "n a",
    "na",
    "harley davidson",
    "harley davidson other",
    "harley davidson full line"
  ]);
  if (generic.has(normalized)) return true;
  if (normalized.endsWith(" other")) return true;
  return false;
}

function toModelConditionLabel(value?: string | null): string {
  const normalized = String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  if (!normalized || normalized === "any" || normalized === "unknown") return "";
  if (normalized.includes("used") || normalized.includes("pre owned") || normalized.includes("preowned")) {
    return "Used";
  }
  if (normalized.includes("new")) return "New";
  return "";
}

function latestModelInterestLabel(conv: Conversation): string | null {
  const contextModel = normalizeModelInterestText(conv.inventoryContext?.model);
  const lastActiveWatchModel = normalizeModelInterestText(
    [...(conv.inventoryWatches ?? [])]
      .reverse()
      .find(w => (w?.status ?? "active") !== "paused" && !isGenericModelInterest(w?.model))?.model ??
      (conv.inventoryWatch && (conv.inventoryWatch.status ?? "active") !== "paused"
        ? conv.inventoryWatch.model
        : "")
  );
  const leadModel = normalizeModelInterestText(conv.lead?.vehicle?.model);
  const leadDescription = normalizeModelInterestText(conv.lead?.vehicle?.description);

  const model =
    !isGenericModelInterest(contextModel)
      ? contextModel
      : !isGenericModelInterest(lastActiveWatchModel)
        ? lastActiveWatchModel
        : !isGenericModelInterest(leadModel)
          ? leadModel
          : "";

  if (model) {
    const conditionLabel =
      toModelConditionLabel(conv.inventoryContext?.condition) ||
      toModelConditionLabel(
        [...(conv.inventoryWatches ?? [])]
          .reverse()
          .find(w => (w?.status ?? "active") !== "paused" && !isGenericModelInterest(w?.model))?.condition ??
          conv.inventoryWatch?.condition
      ) ||
      toModelConditionLabel(conv.lead?.vehicle?.condition);
    return `${conditionLabel ? `${conditionLabel} ` : ""}${model}`.trim();
  }

  if (!isGenericModelInterest(leadDescription)) return leadDescription;
  if (!isGenericModelInterest(leadModel)) return leadModel;
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
      const leadSource = c.lead?.source ?? null;
      const inferredWalkIn = inferWalkIn(c);
      const hasInboundTwilio = c.messages.some(
        m => m.direction === "in" && String(m.provider ?? "").toLowerCase() === "twilio"
      );
      const hotDealSticky = computeStickyHotDealSignal(c, hasInboundTwilio);
      const dealTemperature = computeDealTemperature(c, hasInboundTwilio, hotDealSticky);
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
        vehicleDescription: latestModelInterestLabel(c),
        contactPreference: c.contactPreference,
        preferredContactMethod: c.lead?.preferredContactMethod ?? null,
        leadSource,
        hasInboundTwilio,
        hotDealSticky,
        dealTemperature,
        campaignThread: c.campaignThread ?? null,
        walkIn: inferredWalkIn ? true : null,
        engagement: c.engagement ?? null,
        sale: c.sale ?? null,
        classification: c.classification ?? null,
        followUpCadence: c.followUpCadence ?? null,
        followUp: c.followUp ?? null,
        hold: c.hold ?? null,
        inventoryWatch: c.inventoryWatch ?? null,
        inventoryWatches: c.inventoryWatches ?? null,
        tradePayoff: c.tradePayoff ?? null,
        leadOwner: c.leadOwner ?? null,
        scheduler: c.scheduler
          ? {
              preferredSalespersonId: c.scheduler.preferredSalespersonId,
              preferredSalespersonName: c.scheduler.preferredSalespersonName
            }
          : null,
        ...pd
      };
    })
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

export function getAllConversations(): Conversation[] {
  return Array.from(conversations.values());
}

export function findConversationsByLeadKey(leadKey: string): Conversation[] {
  const key = normalizeLeadKey(leadKey);
  if (!key) return [];
  const ids = leadKeyIndex.get(key) ?? [];
  return ids
    .map(id => conversations.get(id))
    .filter((conv): conv is Conversation => !!conv)
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

export function getLatestConversationByLeadKey(leadKey: string): Conversation | null {
  const matches = findConversationsByLeadKey(leadKey);
  return matches[0] ?? null;
}

export function getConversation(id: string): Conversation | null {
  const raw = String(id ?? "").trim();
  if (!raw) return null;
  const direct = conversations.get(raw);
  if (direct) return direct;
  const key = normalizeLeadKey(raw);
  return getLatestConversationByLeadKey(key);
}

export function updateConversationContact(
  conv: Conversation,
  patch: {
    phone?: string;
    email?: string;
    firstName?: string;
    lastName?: string;
    name?: string;
  }
): void {
  const prevKey = normalizeLeadKey(conv.leadKey || "");
  const nextKey = patch.phone ? normalizeLeadKey(patch.phone) : "";
  const lead = (conv.lead = conv.lead ?? {});

  if (patch.firstName !== undefined) lead.firstName = patch.firstName;
  if (patch.lastName !== undefined) lead.lastName = patch.lastName;
  if (patch.name !== undefined) lead.name = patch.name;
  if (patch.email !== undefined) lead.email = patch.email;
  if (patch.phone !== undefined) {
    if (nextKey) {
      lead.phone = nextKey;
    } else {
      lead.phone = patch.phone;
    }
  }

  if (nextKey && nextKey !== prevKey) {
    removeConversationFromLeadIndex(conv);
    conv.leadKey = nextKey;
    indexConversationByLeadKey(conv);
  }
  conv.updatedAt = nowIso();
  scheduleSave();
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

function allowRelaxedSlotMatch(inbound: string): boolean {
  const raw = String(inbound ?? "").trim();
  if (!raw) return false;
  // Common short selections after slot offers.
  if (/^(first|second|earlier|later)\.?$/i.test(raw)) return true;
  if (/^\d{1,2}(?::\d{2})?\s*(am|pm)?\.?$/i.test(raw)) return true;

  const t = normalizeText(raw);
  return /\b(works|that works|sounds good|perfect|yes|yep|yeah|book|schedule|appointment|confirm|confirmed|reschedule|move (it|me)|set (it|me)|lets do|let s do|see you)\b/.test(
    t
  );
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
    if (!allowRelaxedSlotMatch(inboundText)) {
      console.log("[appt-match] inbound (no relaxed intent):", inboundText);
      console.log("[appt-match] suggested:", (slots || []).map(s => s.startLocal ?? s.start));
      return false;
    }
    const relaxed = slots.filter(s => slotMatchesInboundRelaxed(s, inboundText));
    if (relaxed.length === 1) {
      const single = relaxed[0];
      console.log("[appt-match] matched (relaxed):", single.startLocal ?? single.start);
      conv.appointment = conv.appointment ?? { status: "none", updatedAt: nowIso() };
      conv.appointment.status = "confirmed";
      conv.appointment.whenText = String(single.startLocal ?? single.start ?? "").trim();
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
        conv.appointment.whenText = String(single.startLocal ?? single.start ?? "").trim();
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
  conv.appointment.whenText = String(match.startLocal ?? match.start ?? "").trim();
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

export const FOLLOW_UP_DAY_OFFSETS = [1, 2, 3, 5, 7, 10, 15, 21, 30, 45, 60, 90, 120];
export const ENGAGED_DAY_OFFSETS = FOLLOW_UP_DAY_OFFSETS;
export const POST_SALE_DAY_OFFSETS = [1, 60, 365, 690];
export const LONG_TERM_DAY_OFFSETS = [30, 90, 180];
export const FINANCE_DECLINED_DAY_OFFSETS = [30, 60, 120];
export const PRIVATE_PARTY_SELL_DAY_OFFSETS = [30, 60, 90, 120];

export function computeFollowUpDueAt(anchorAtIso: string, offsetDays: number, timeZone: string) {
  const anchor = new Date(anchorAtIso);
  const anchorParts = getZonedParts(anchor, timeZone);
  const baseLocalDate = new Date(Date.UTC(anchorParts.year, anchorParts.month - 1, anchorParts.day));
  baseLocalDate.setUTCDate(baseLocalDate.getUTCDate() + offsetDays);
  const targetYear = baseLocalDate.getUTCFullYear();
  const targetMonth = baseLocalDate.getUTCMonth() + 1;
  const targetDay = baseLocalDate.getUTCDate();

  const baseMinutes = 10 * 60 + 30;
  const randMinutes = Math.floor(Math.random() * 121);
  const total = baseMinutes + randMinutes;
  const hour24 = Math.floor(total / 60);
  const minute = total % 60;

  return localPartsToUtcDate(timeZone, {
    year: targetYear,
    month: targetMonth,
    day: targetDay,
    hour24,
    minute
  }).toISOString();
}

export function computePostSaleDueAt(anchorAtIso: string, offsetDays: number, timeZone: string) {
  const anchor = new Date(anchorAtIso);
  const anchorParts = getZonedParts(anchor, timeZone);
  const baseLocalDate = new Date(Date.UTC(anchorParts.year, anchorParts.month - 1, anchorParts.day));
  baseLocalDate.setUTCDate(baseLocalDate.getUTCDate() + offsetDays);
  const targetYear = baseLocalDate.getUTCFullYear();
  const targetMonth = baseLocalDate.getUTCMonth() + 1;
  const targetDay = baseLocalDate.getUTCDate();
  let due = localPartsToUtcDate(timeZone, {
    year: targetYear,
    month: targetMonth,
    day: targetDay,
    hour24: 10,
    minute: 30
  });
  const now = new Date();
  if (offsetDays > 0) {
    while (due.getTime() <= anchor.getTime() || due.getTime() <= now.getTime()) {
      due = new Date(due.getTime() + 24 * 60 * 60 * 1000);
    }
  }
  return due.toISOString();
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
    kind: "standard",
    scheduleInviteCount: 0,
    scheduleMuted: false
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
    kind: "post_sale",
    scheduleInviteCount: 0,
    scheduleMuted: false
  };
  conv.updatedAt = nowIso();
  scheduleSave();
}

export function scheduleLongTermFollowUp(
  conv: Conversation,
  dueAtIso: string,
  message: string,
  opts?: { anchorAtIso?: string; contextTag?: string }
) {
  if (conv.status === "closed") return;
  const anchorAtIso = String(opts?.anchorAtIso ?? dueAtIso).trim() || dueAtIso;
  conv.followUpCadence = {
    status: "active",
    anchorAt: anchorAtIso,
    nextDueAt: dueAtIso,
    stepIndex: 0,
    kind: "long_term",
    deferredMessage: message,
    contextTag: opts?.contextTag,
    contextTagUpdatedAt: opts?.contextTag ? nowIso() : undefined,
    scheduleInviteCount: 0,
    scheduleMuted: false
  };
  conv.updatedAt = nowIso();
  scheduleSave();
}

export function stopFollowUpCadence(conv: Conversation, reason: string) {
  if (!conv.followUpCadence) return;
  // Post-sale and long-term cadences should continue even when sales flow triggers
  // manual handoff (for example, service requests or internal coordination).
  if (
    reason === "manual_handoff" &&
    (conv.followUpCadence.kind === "post_sale" || conv.followUpCadence.kind === "long_term")
  ) {
    return;
  }
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
  const until = new Date(untilIso);
  if (!Number.isNaN(until.getTime())) {
    const current = conv.followUpCadence.nextDueAt
      ? new Date(conv.followUpCadence.nextDueAt)
      : null;
    if (!current || Number.isNaN(current.getTime()) || current.getTime() < until.getTime()) {
      conv.followUpCadence.nextDueAt = until.toISOString();
    }
  }
  conv.updatedAt = nowIso();
  scheduleSave();
}

export function resetScheduleInviteCounter(conv: Conversation) {
  if (!conv.followUpCadence) return;
  conv.followUpCadence.scheduleInviteCount = 0;
  conv.followUpCadence.scheduleMuted = false;
  conv.updatedAt = nowIso();
  scheduleSave();
}

export function registerScheduleInviteSent(conv: Conversation, threshold = 3) {
  if (!conv.followUpCadence) return;
  conv.followUpCadence.scheduleInviteCount = (conv.followUpCadence.scheduleInviteCount ?? 0) + 1;
  if ((conv.followUpCadence.scheduleInviteCount ?? 0) >= threshold) {
    conv.followUpCadence.scheduleMuted = true;
  }
  conv.updatedAt = nowIso();
  scheduleSave();
}

export function closeConversation(conv: Conversation, reason?: string) {
  conv.status = "closed";
  conv.closedAt = nowIso();
  conv.closedReason = reason;
  markOpenTodosDoneForConversation(conv.id);
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
  const isEngaged = conv.followUpCadence.kind === "engaged";
  const isLongTerm = conv.followUpCadence.kind === "long_term";
  const isFinanceDeclinedLongTerm =
    isLongTerm && String(conv.followUp?.reason ?? "").trim().toLowerCase() === "financing_declined";
  const isPrivatePartySellLongTerm =
    isLongTerm &&
    (String(conv.followUp?.reason ?? "").trim().toLowerCase() === "private_party_seller" ||
      String(conv.followUpCadence?.contextTag ?? "").trim().toLowerCase() === "private_party_seller");
  const isRideChallengeReminder = conv.followUpCadence.deferredMessage === "ride_challenge_final_mileage";
  if (isLongTerm && isRideChallengeReminder) {
    conv.followUpCadence.status = "completed";
    conv.followUpCadence.nextDueAt = undefined;
    conv.updatedAt = nowIso();
    scheduleSave();
    return;
  }
  const offsets = isPostSale
    ? POST_SALE_DAY_OFFSETS
    : isEngaged
      ? ENGAGED_DAY_OFFSETS
      : isLongTerm
        ? isFinanceDeclinedLongTerm
          ? FINANCE_DECLINED_DAY_OFFSETS
          : isPrivatePartySellLongTerm
            ? PRIVATE_PARTY_SELL_DAY_OFFSETS
          : LONG_TERM_DAY_OFFSETS
      : FOLLOW_UP_DAY_OFFSETS;
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
  const source = String(t ?? "").toLowerCase();
  const patterns: Array<{ token: string; re: RegExp }> = [
    { token: "today", re: /\btoday\b/ },
    { token: "tomorrow", re: /\btomorrow\b/ },
    { token: "monday", re: /\b(?:mon|monday)\b/ },
    { token: "tuesday", re: /\b(?:tue|tues|tuesday)\b/ },
    { token: "wednesday", re: /\b(?:wed|wednesday)\b/ },
    { token: "thursday", re: /\b(?:thu|thur|thurs|thursday)\b/ },
    { token: "friday", re: /\b(?:fri|friday)\b/ },
    { token: "saturday", re: /\b(?:sat|saturday)\b/ },
    { token: "sunday", re: /\b(?:sun|sunday)\b/ }
  ];
  let best: { token: string; index: number } | null = null;
  for (const row of patterns) {
    row.re.lastIndex = 0;
    const match = row.re.exec(source);
    if (!match || typeof match.index !== "number") continue;
    if (!best || match.index < best.index) {
      best = { token: row.token, index: match.index };
    }
  }
  return best?.token ?? null;
}

function parseExactTime(text: string): { hour24: number; minute: number; timeText: string } | null {
  const t = text.toLowerCase();
  const trimmed = t.trim();
  if (/(around|approx|approximately|ish)\b/.test(t)) return null;
  if (/\bnoon\b/.test(t)) return { hour24: 12, minute: 0, timeText: "noon" };

  // Prefer explicit time tokens so dates like 3/11/2026 don't get parsed as "3".
  const m = t.match(/\b(\d{1,2})([:.])(\d{2})\s*(am|pm)?\b/);
  let hourRaw: number;
  let minute: number;
  let meridiem: string | undefined;
  let timeText: string;
  if (m) {
    hourRaw = Number(m[1]);
    minute = Number(m[3] ?? "0");
    meridiem = m[4];
    timeText = m[0];
  } else {
    const m2 = t.match(/\b(\d{1,2})\s*(am|pm)\b/);
    if (m2) {
      hourRaw = Number(m2[1]);
      minute = 0;
      meridiem = m2[2];
      timeText = m2[0];
    } else {
      // Compact forms like "430", "0430", "430pm", or "at 430".
      const compact =
        trimmed.match(/^(\d{3,4})\s*(am|pm)?$/) ??
        t.match(/\b(?:at|for|by)\s*(\d{3,4})\s*(am|pm)?\b/);
      if (compact) {
        const digits = compact[1];
        const numeric = Number(digits);
        if (!compact[2] && digits.length === 4 && Number.isFinite(numeric) && numeric >= 1900 && numeric <= 2099) {
          return null;
        }
        const split = digits.length === 3 ? 1 : 2;
        hourRaw = Number(digits.slice(0, split));
        minute = Number(digits.slice(split));
        meridiem = compact[2];
        timeText = compact[0];
      } else {
        // Bare-hour forms like "4" or "at 4".
        const bare =
          trimmed.match(/^(\d{1,2})\s*(am|pm)?$/) ??
          t.match(/\b(?:at|for|by)\s*(\d{1,2})\s*(am|pm)?\b/);
        if (!bare) return null;
        hourRaw = Number(bare[1]);
        minute = 0;
        meridiem = bare[2];
        timeText = bare[0];
      }
    }
  }
  if (minute < 0 || minute > 59) return null;
  if (hourRaw < 0 || hourRaw > 23) return null;
  if (meridiem && (hourRaw < 1 || hourRaw > 12)) return null;

  let hour24 = hourRaw;
  if (meridiem) {
    if (meridiem === "am") hour24 = hourRaw === 12 ? 0 : hourRaw;
    if (meridiem === "pm") hour24 = hourRaw === 12 ? 12 : hourRaw + 12;
  } else if (hourRaw <= 12) {
    // Heuristic for ambiguous times like "1:30" without am/pm.
    if (hourRaw !== 12) {
      hour24 = hourRaw <= 7 ? hourRaw + 12 : hourRaw;
    }
  }
  return { hour24, minute, timeText };
}

function parseExplicitDate(text: string): { year: number; month: number; day: number } | null {
  const normalizeYear = (raw: string | undefined): number => {
    const nowYear = new Date().getFullYear();
    if (!raw) return nowYear;
    let year = Number(raw);
    if (!Number.isFinite(year)) return nowYear;
    if (raw.length === 2) year = 2000 + year;
    return year;
  };

  const monthMap: Record<string, number> = {
    jan: 1,
    january: 1,
    feb: 2,
    february: 2,
    mar: 3,
    march: 3,
    apr: 4,
    april: 4,
    may: 5,
    jun: 6,
    june: 6,
    jul: 7,
    july: 7,
    aug: 8,
    august: 8,
    sep: 9,
    sept: 9,
    september: 9,
    oct: 10,
    october: 10,
    nov: 11,
    november: 11,
    dec: 12,
    december: 12
  };

  const m = text.match(/\b(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?\b/);
  if (m) {
    const month = Number(m[1]);
    const day = Number(m[2]);
    const year = normalizeYear(m[3]);
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    return { year, month, day };
  }

  const monthFirst = text.match(
    /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s*(\d{2,4}))?\b/i
  );
  if (monthFirst) {
    const month = monthMap[String(monthFirst[1] ?? "").toLowerCase()] ?? 0;
    const day = Number(monthFirst[2]);
    const year = normalizeYear(monthFirst[3]);
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    return { year, month, day };
  }

  const dayFirst = text.match(
    /\b(\d{1,2})(?:st|nd|rd|th)?\s+(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)(?:,?\s*(\d{2,4}))?\b/i
  );
  if (dayFirst) {
    const day = Number(dayFirst[1]);
    const month = monthMap[String(dayFirst[2] ?? "").toLowerCase()] ?? 0;
    const year = normalizeYear(dayFirst[3]);
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    return { year, month, day };
  }

  return null;
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
  let offset = (targetIdx - todayIdx + 7) % 7;
  if (offset === 0) offset = 7;
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

export function parseRequestedDateOnly(
  text: string,
  timeZone: string
): { year: number; month: number; day: number; dayOfWeek: string } | null {
  const t = String(text ?? "").toLowerCase();
  const explicitDate = parseExplicitDate(t);
  if (explicitDate) {
    const explicitYearProvided =
      /\b\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}\b/.test(t) ||
      /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{1,2}(?:st|nd|rd|th)?(?:,?\s*)\d{2,4}\b/i.test(
        t
      ) ||
      /\b\d{1,2}(?:st|nd|rd|th)?\s+(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)(?:,?\s*)\d{2,4}\b/i.test(
        t
      );
    let year = explicitDate.year;
    if (!explicitYearProvided) {
      const now = new Date();
      const nowParts = getZonedParts(now, timeZone);
      if (
        explicitDate.month < nowParts.month ||
        (explicitDate.month === nowParts.month && explicitDate.day < nowParts.day)
      ) {
        year += 1;
      }
    }
    const base = new Date(Date.UTC(year, explicitDate.month - 1, explicitDate.day, 12, 0));
    const parts = getZonedParts(base, timeZone);
    return {
      year,
      month: explicitDate.month,
      day: explicitDate.day,
      dayOfWeek: weekdayFull((parts.weekday ?? "").slice(0, 3))
    };
  }

  const dayToken = parseDayToken(t);
  if (!dayToken) return null;

  const now = new Date();
  const nowParts = getZonedParts(now, timeZone);
  const todayIdx = weekdayIndex((nowParts.weekday ?? "").slice(0, 3));
  let base = new Date(Date.UTC(nowParts.year, nowParts.month - 1, nowParts.day, 12, 0));

  if (dayToken === "today" || dayToken === "tomorrow") {
    const offset = dayToken === "tomorrow" ? 1 : 0;
    base.setUTCDate(base.getUTCDate() + offset);
    const parts = getZonedParts(base, timeZone);
    return {
      year: parts.year,
      month: parts.month,
      day: parts.day,
      dayOfWeek: weekdayFull((parts.weekday ?? "").slice(0, 3))
    };
  }

  const targetIdx = weekdayIndex(dayToken.slice(0, 3));
  if (targetIdx < 0 || todayIdx < 0) return null;
  let offset = (targetIdx - todayIdx + 7) % 7;
  if (offset === 0) offset = 7;
  base.setUTCDate(base.getUTCDate() + offset);
  const parts = getZonedParts(base, timeZone);
  return {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    dayOfWeek: weekdayFull((parts.weekday ?? "").slice(0, 3))
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
  sourceMessageId?: string,
  owner?: { id?: string | null; name?: string | null },
  schedule?: TodoScheduleOptions,
  taskClass?: TodoTaskClass
): TodoTask | null {
  const soldContext =
    conv?.closedReason === "sold" ||
    !!conv?.sale?.soldAt ||
    conv?.followUpCadence?.kind === "post_sale";
  if (soldContext && reason !== "call") {
    return null;
  }
  const ownerIdRaw = String(owner?.id ?? conv?.leadOwner?.id ?? "").trim();
  const ownerNameRaw = String(owner?.name ?? conv?.leadOwner?.name ?? "").trim();
  const ownerId = ownerIdRaw || undefined;
  const ownerName = ownerNameRaw || undefined;
  const incomingTaskClass = taskClass ?? inferTodoTaskClass(reason, summary, schedule);
  const existing = todos.find(t => {
    if (t.convId !== conv.id || t.status !== "open") return false;
    const existingClass = t.taskClass ?? inferTodoTaskClass(t.reason, t.summary, t);
    if (!t.taskClass) t.taskClass = existingClass;
    return existingClass === incomingTaskClass;
  });
  if (existing) {
    const priorities: Record<TodoTask["reason"], number> = {
      call: 7,
      service: 6,
      parts: 6,
      apparel: 6,
      payments: 5,
      pricing: 4,
      manager: 3,
      approval: 3,
      note: 2,
      other: 1
    };
    const existingPriority = priorities[existing.reason] ?? 1;
    const incomingPriority = priorities[reason] ?? 1;
    if (incomingPriority > existingPriority) {
      existing.reason = reason;
    }
    const incoming = String(summary ?? "").trim();
    if (incoming) {
      const current = String(existing.summary ?? "").trim();
      const currentLower = current.toLowerCase();
      const incomingLower = incoming.toLowerCase();
      if (incomingTaskClass === "followup" || incomingTaskClass === "appointment") {
        // Follow-up and appointment tasks should always reflect the latest
        // actionable ask, not accumulate prior summaries.
        existing.summary = incoming;
      } else if (!currentLower.includes(incomingLower)) {
        existing.summary = current ? `${current}\n${incoming}` : incoming;
      }
    }
    if (sourceMessageId) existing.sourceMessageId = sourceMessageId;
    if (ownerId) existing.ownerId = ownerId;
    if (ownerName) existing.ownerName = ownerName;
    existing.taskClass = incomingTaskClass;
    if (incomingTaskClass === "followup") {
      existing.createdAt = nowIso();
    }
    if (schedule?.dueAt) {
      if (existing.dueAt && existing.dueAt !== schedule.dueAt) {
        existing.reminderSentAt = undefined;
      }
      existing.dueAt = schedule.dueAt;
    }
    if (schedule?.reminderAt) {
      existing.reminderAt = schedule.reminderAt;
    }
    if (
      Number.isFinite(schedule?.reminderLeadMinutes) &&
      Number(schedule?.reminderLeadMinutes) > 0
    ) {
      existing.reminderLeadMinutes = Math.round(Number(schedule?.reminderLeadMinutes));
    }
    if (schedule?.reminderSentAt) {
      existing.reminderSentAt = schedule.reminderSentAt;
    }
    conv.updatedAt = nowIso();
    scheduleSave();
    return existing;
  }
  const task: TodoTask = {
    id: makeId("todo"),
    convId: conv.id,
    leadKey: conv.leadKey,
    ownerId,
    ownerName,
    reason,
    taskClass: incomingTaskClass,
    summary,
    sourceMessageId,
    createdAt: nowIso(),
    status: "open",
    dueAt: schedule?.dueAt,
    reminderAt: schedule?.reminderAt,
    reminderLeadMinutes:
      Number.isFinite(schedule?.reminderLeadMinutes) && Number(schedule?.reminderLeadMinutes) > 0
        ? Math.round(Number(schedule?.reminderLeadMinutes))
        : undefined,
    reminderSentAt: schedule?.reminderSentAt
  };
  todos.push(task);
  conv.updatedAt = nowIso();
  scheduleSave();
  return task;
}

export function addCallTodoIfMissing(conv: Conversation, summary: string): TodoTask | null {
  const bucket = String((conv as any)?.classification?.bucket ?? "").trim().toLowerCase();
  const cta = String((conv as any)?.classification?.cta ?? "").trim().toLowerCase();
  const followUpReason = String((conv as any)?.followUp?.reason ?? "").trim().toLowerCase();
  const isFinancePrequalOrCreditApp =
    bucket === "finance_prequal" ||
    cta === "hdfs_coa" ||
    cta === "prequalify" ||
    /credit_app|credit_app_cosigner|credit_app_needs_info|credit_app_approved|financing_declined/.test(
      followUpReason
    );
  if (isFinancePrequalOrCreditApp) {
    // Finance pre-approval / credit-app flows should only surface a single
    // approval To Do, not an additional cadence follow-up task.
    return null;
  }

  // Upsert cadence follow-up tasks so we never create duplicates while still
  // keeping the open follow-up aligned to the latest cadence step.
  return addTodo(conv, "call", summary, undefined, undefined, undefined, "followup");
}

export function listOpenTodos(): TodoTask[] {
  return todos.filter(t => t.status === "open");
}

export function addInternalQuestion(
  convId: string,
  leadKey: string,
  text: string,
  type?: InternalQuestion["type"]
): InternalQuestion {
  const q: InternalQuestion = {
    id: makeId("q"),
    convId,
    leadKey,
    text,
    createdAt: nowIso(),
    status: "open",
    type
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

export function markTodoReminderSent(
  convId: string,
  todoId: string,
  sentAtIso?: string
): TodoTask | null {
  const task = todos.find(t => t.id === todoId && t.convId === convId);
  if (!task) return null;
  task.reminderSentAt = sentAtIso || nowIso();
  scheduleSave();
  return task;
}

export function markOpenTodosDoneForConversation(convId: string): number {
  let count = 0;
  const doneAt = nowIso();
  for (const task of todos) {
    if (task.convId !== convId || task.status !== "open") continue;
    task.status = "done";
    task.doneAt = doneAt;
    count += 1;
  }
  if (count > 0) scheduleSave();
  return count;
}

export function reassignOpenTodoOwnersForConversation(
  convId: string,
  owner: { id?: string | null; name?: string | null },
  opts?: { includeDepartmentTodos?: boolean }
): number {
  const ownerId = String(owner?.id ?? "").trim() || undefined;
  const ownerName = String(owner?.name ?? "").trim() || undefined;
  const includeDepartmentTodos = !!opts?.includeDepartmentTodos;
  let count = 0;
  for (const task of todos) {
    if (task.convId !== convId || task.status !== "open") continue;
    const reason = String(task.reason ?? "").trim().toLowerCase();
    const isDepartmentTodo = reason === "service" || reason === "parts" || reason === "apparel";
    if (isDepartmentTodo && !includeDepartmentTodos) continue;
    task.ownerId = ownerId;
    task.ownerName = ownerName;
    count += 1;
  }
  if (count > 0) scheduleSave();
  return count;
}

export function markOpenTodosDoneForConversationByClass(
  convId: string,
  taskClasses: TodoTaskClass[]
): number {
  const requested = new Set(taskClasses);
  if (!requested.size) return 0;
  let count = 0;
  const doneAt = nowIso();
  for (const task of todos) {
    if (task.convId !== convId || task.status !== "open") continue;
    const inferred = inferTodoTaskClass(task.reason, task.summary, task);
    const explicit = String(task.taskClass ?? "").trim().toLowerCase();
    const knownExplicit =
      explicit === "followup" ||
      explicit === "appointment" ||
      explicit === "todo" ||
      explicit === "reminder";
    const klass =
      !knownExplicit || explicit === "todo"
        ? inferred
        : (task.taskClass as TodoTaskClass);
    if (!requested.has(klass)) continue;
    task.status = "done";
    task.doneAt = doneAt;
    count += 1;
  }
  if (count > 0) scheduleSave();
  return count;
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

export function setMemorySummary(
  conv: Conversation,
  text: string,
  messageCount: number,
  updatedAt?: string
) {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) return;
  conv.memorySummary = {
    text: trimmed,
    messageCount,
    updatedAt: updatedAt ?? nowIso()
  };
  conv.updatedAt = nowIso();
  scheduleSave();
}

export function getMemorySummary(conv: Conversation): string | null {
  return conv.memorySummary?.text ?? null;
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
  const conv = getConversation(convId);
  if (!conv) return false;
  const existed = conversations.delete(conv.id);
  if (!existed) return false;
  removeConversationFromLeadIndex(conv);
  for (let i = todos.length - 1; i >= 0; i -= 1) {
    if (todos[i]?.convId === conv.id) {
      todos.splice(i, 1);
    }
  }
  for (let i = questions.length - 1; i >= 0; i -= 1) {
    if (questions[i]?.convId === conv.id) {
      questions.splice(i, 1);
    }
  }
  scheduleSave();
  return true;
}
