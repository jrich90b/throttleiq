import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { InboundMessageEvent } from "./types.js";
import { maybeMarkEngagedFromInbound } from "./engagement.js";
import { fileURLToPath } from "node:url";
import { dataPath } from "./dataDir.js";
import {
  getDataBackend,
  getDealerId,
  isFileSnapshotEnabled,
  isPostgresDegraded,
  loadConversationStoreFromPostgres,
  notePostgresFailure,
  persistConversationStoreToPostgres,
  type ConversationUpsertRow
} from "./storePersistence.js";
import {
  applyDeterministicToneOverrides,
  formatEmailLayout,
  formatSmsLayout,
  normalizeSalesToneBase
} from "./tone.js";
import { parsePhoneNumberFromString } from "libphonenumber-js";
import {
  applyDraftStateInvariants,
  type DraftStateInvariantInput
} from "./draftStateInvariants.js";
import { isPhoneLogConversation } from "./phoneLogLead.js";
import { findComputerLikePhrases } from "./voiceBannedPhrases.js";
import {
  isPendingIncomingInventoryNotifyTodoSummary,
  planPendingIncomingNotifyDedup
} from "./pendingIncomingInventory.js";

export type ConversationMode = "autopilot" | "suggest" | "human";
export type MessageProvider =
  | "twilio"
  | "sendgrid_adf"
  | "sendgrid"
  | "draft_ai"
  | "human"
  | "web_widget"
  | "payment_event"
  | "voice_call"
  | "voice_transcript"
  | "voice_summary";

export type DraftInvariantHints = Pick<
  DraftStateInvariantInput,
  | "turnFinanceIntent"
  | "turnAvailabilityIntent"
  | "turnSchedulingIntent"
  | "financeContextIntent"
  | "shortAckIntent"
>;

export const INITIAL_SMS_OPTOUT_FOOTER = "Reply STOP to opt out.";

const INITIAL_SMS_OPTOUT_PROVIDERS = new Set<string>(["draft_ai", "human", "twilio"]);
const INITIAL_SMS_OPTOUT_SENT_PROVIDERS = new Set<string>(["twilio"]);

function isEmailAddressLike(value: unknown): boolean {
  return String(value ?? "").includes("@");
}

function isPhoneAddressLike(value: unknown): boolean {
  const raw = String(value ?? "").trim();
  if (!raw || isEmailAddressLike(raw)) return false;
  const digits = raw.replace(/\D/g, "");
  return raw.startsWith("+") || digits.length === 10 || (digits.length === 11 && digits.startsWith("1"));
}

export function hasSmsOptOutLanguage(text: unknown): boolean {
  const normalized = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!normalized) return false;
  return /\breply\s+(?:stop|unsubscribe)\b|\btext\s+stop\b|\bstop\s+to\s+(?:opt\s*out|unsubscribe)\b|\bopt[-\s]?out\b|\bunsubscribe\b/i.test(
    normalized
  );
}

export function hasPriorCustomerFacingSmsOutbound(
  conv: Conversation,
  opts?: { excludeMessageId?: string | null }
): boolean {
  const excludeMessageId = String(opts?.excludeMessageId ?? "").trim();
  return (conv.messages ?? []).some(message => {
    if (excludeMessageId && message.id === excludeMessageId) return false;
    if (message.direction !== "out") return false;
    const provider = String(message.provider ?? "").trim().toLowerCase();
    if (!INITIAL_SMS_OPTOUT_SENT_PROVIDERS.has(provider)) return false;
    if (isEmailAddressLike(message.from) || isEmailAddressLike(message.to)) return false;
    return isPhoneAddressLike(message.to) || isPhoneAddressLike(message.from);
  });
}

export function shouldAppendInitialSmsOptOutFooter(
  conv: Conversation,
  opts?: {
    provider?: MessageProvider | string | null;
    from?: string | null;
    to?: string | null;
    excludeMessageId?: string | null;
  }
): boolean {
  const provider = String(opts?.provider ?? "").trim().toLowerCase();
  if (!INITIAL_SMS_OPTOUT_PROVIDERS.has(provider)) return false;
  if (isEmailAddressLike(opts?.from) || isEmailAddressLike(opts?.to)) return false;
  const target = String(opts?.to ?? "").trim() || String(conv.lead?.phone ?? conv.leadKey ?? "").trim();
  if (!isPhoneAddressLike(target)) return false;
  return !hasPriorCustomerFacingSmsOutbound(conv, { excludeMessageId: opts?.excludeMessageId ?? null });
}

export function ensureInitialSmsOptOutFooter(
  conv: Conversation,
  body: string,
  opts?: {
    provider?: MessageProvider | string | null;
    from?: string | null;
    to?: string | null;
    excludeMessageId?: string | null;
    force?: boolean;
  }
): string {
  const formatted = formatSmsLayout(body);
  if (!formatted || hasSmsOptOutLanguage(formatted)) return formatted;
  if (!opts?.force && !shouldAppendInitialSmsOptOutFooter(conv, opts)) return formatted;
  return formatSmsLayout(`${formatted} ${INITIAL_SMS_OPTOUT_FOOTER}`);
}

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
export type AppointmentBookedByActor = "ai" | "human" | "customer" | "unknown";
export type AppointmentBookedByChannel =
  | "sms"
  | "email"
  | "phone"
  | "manual"
  | "public_booking"
  | "unknown";

export type AppointmentBookedBy = {
  actor: AppointmentBookedByActor;
  channel: AppointmentBookedByChannel;
  userId?: string | null;
  userName?: string | null;
  sourceMessageId?: string | null;
  inferred?: boolean;
};

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
  bookedBy?: AppointmentBookedBy;
  whenLocal?: string | null;
  appointmentType?: string | null;
  reschedulePending?: boolean;
  attendanceQuestionedAt?: string;
  staffNotify?: {
    bookedSentAt?: string;
    followUpSentAt?: string;
    lastEventId?: string | null;
    outcomeReminderCount?: number;
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
        | "no_change"
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
        | "no_change"
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

export type ManualContextState = {
  status: "needed" | "inferred" | "resolved" | "dismissed";
  contextTag?: string | null;
  followUpReason?: string | null;
  source?: string | null;
  channel?: "sms" | "email" | null;
  confidence?: number | null;
  reason?: string | null;
  selectedByUserId?: string | null;
  selectedByUserName?: string | null;
  updatedAt?: string;
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
  outcome?: string;
  outcomeLabel?: string;
  outcomeNote?: string;
  outcomeResolution?: string;
  outcomeByUserId?: string;
  outcomeByUserName?: string;
  dueAt?: string;
  reminderAt?: string;
  reminderLeadMinutes?: number;
  reminderSentAt?: string;
  escalatedAt?: string;
  taskClass?: TodoTaskClass;
  // Last task-fulfillment auto-close check (visibility into WHY a task did/didn't close).
  autoCloseCheck?: {
    at: string;
    fulfilled: boolean;
    confidence: number | null;
    evidence?: string;
    decision: string; // e.g. "closed" | "shadow_would_close" | "below_confidence" | "not_fulfilled"
    channel: string;
  };
  // Set ONCE when a department-handoff task soft-closes (dept responded, customer not booked): the task
  // is snoozed to nudgeAt (dueAt) and re-surfaces then as a staff follow-up. Presence also guards
  // against re-soft-closing on the re-surface. See domain/taskFulfillmentAutoClose.ts.
  autoSoftCloseAt?: string;
  autoSoftClose?: { at: string; nudgeAt: string; reason: string; evidence?: string };
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
    (hasAppointmentTimeSignal || /\b(?:appointment\s+)?reschedule requested\b/i.test(summaryRaw));
  if (reason === "call") {
    const hasCadenceFollowUpSignals =
      /^call customer \(follow-up\):/i.test(summaryRaw) ||
      /^call customer \((initial reply sent|follow[- ]?up)\)/i.test(summaryRaw) ||
      /\bfollow[- ]?up\b/i.test(text) ||
      /\binitial reply sent\b/i.test(text) ||
      /\bcadence\b/i.test(text);
    if (hasCadenceFollowUpSignals) return "followup";
    if (hasAppointmentSignals) return "appointment";
    const hasReminderSignals =
      !!String(schedule?.dueAt ?? "").trim() ||
      !!String(schedule?.reminderAt ?? "").trim() ||
      /^call requested:/i.test(summaryRaw) ||
      /\brequested call time\b/i.test(text) ||
      /\bremind(er)?\b/i.test(text);
    if (hasReminderSignals) return "reminder";
  }
  if (hasAppointmentSignals) return "appointment";
  return "todo";
}

export function isCadenceGeneratedFollowUpTodoSummary(summary?: string | null): boolean {
  const text = String(summary ?? "").replace(/\s+/g, " ").trim();
  return (
    /^call customer \(initial reply sent\)\.?$/i.test(text) ||
    /^call customer \(follow[- ]?up\):/i.test(text)
  );
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
  | "inventory_watch_matched"
  | "pending_incoming_inventory"
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
  | "purchase_delivery"
  | "followup_paused"
  | "followup_resumed"
  | "customer_stepping_back"
  | "customer_sell_on_own"
  | "customer_keep_current_bike"
  | "first_time_rider"
  | "rider_course_info"
  | "schedule_request"
  | "schedule_offer_sent"
  | "schedule_booked"
  | "reservation_handoff";

export type LeadProfile = {
  leadRef?: string;
  source?: string;
  sourceType?: "phone_log" | string;
  phoneLog?: boolean;
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
  inquiry?: string;
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
  trim?: string;
  minPrice?: number;
  maxPrice?: number;
  monthlyBudget?: number;
  termMonths?: number;
  downPayment?: number;
  askedAt: string;
};

export type PendingIncomingInventory = {
  model?: string;
  year?: number;
  make?: string;
  condition?: string;
  label?: string;
  note?: string;
  source?: "adf" | "manual" | "customer" | "system";
  sourceMessageId?: string;
  status: "pending" | "arrived" | "cancelled";
  createdAt: string;
  updatedAt: string;
  acknowledgedAt?: string;
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
  actorUserId?: string;
  actorUserName?: string;
  callMethod?: "cell" | "extension";
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
    leadRef?: string;
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
    source?: "manual_takeover" | "manual_send";
  };
  // Durable facts extracted from phone call summaries (voiceContext expires in
  // 48h by design; these persist so follow-up cadence can reference what was
  // actually discussed and quoted on calls).
  voiceFacts?: {
    quotedUnit?: string | null;
    quotedPrice?: number | null;
    otdPrice?: number | null;
    budgetMax?: number | null;
    wantsPreowned?: boolean | null;
    preferences?: string[];
    blockers?: string[];
    updatedAt: string;
    sourceMessageId?: string | null;
  };
  lead?: LeadProfile;
  originalLead?: LeadProfile;
  latestLead?: LeadProfile;
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
  /** Set once when a stale manual-handoff lead is surfaced as a staff follow-up todo, so it is never re-nudged. */
  staleHandoffNudgedAt?: string;
  /** Set once when an in-process deal is surfaced as an owner "nudge?" todo, so it is never re-nudged. */
  inProcessNudgedAt?: string;
  manualContext?: ManualContextState;
  objections?: ObjectionState;
  crm?: { lastLoggedAt?: string; lastLoggedAtByLeadRef?: Record<string, string> };
  inventoryWatch?: InventoryWatch;
  inventoryWatches?: InventoryWatch[];
  inventoryWatchPending?: InventoryWatchPending;
  pendingIncomingInventory?: PendingIncomingInventory;
  // Units the recommender last suggested (with listing url + color), so a "show me pics/links/colors"
  // follow-up can answer with the REAL links instead of punting (2026-06-24).
  recommendedUnits?: {
    year?: string | null;
    model?: string | null;
    color?: string | null;
    price?: number | null;
    stockId?: string | null;
    url?: string | null;
    images?: string[];
  }[];
  recommendedUnitsAt?: string;
  // Offer-once-per-value marker: the down payment we last sent a disclaimed payment ESTIMATE for, so
  // we don't re-fire on later "ok"/"thanks" turns but DO re-estimate if they change it (2026-06-24).
  paymentEstimateSentForDown?: number;
  // Offer-once marker: when we sent the finance pre-qual/credit-app + visit offer to a payment-
  // focused lead (after they engaged with numbers), so we don't repeat it (2026-06-24).
  financeAppInviteSentAt?: string;
  // Dedup marker: when the maintenance reconcile last flagged a scheduling LEAK (a visit time discussed
  // but never booked) so a rep gets ONE "book this" todo, not a flood; re-flags after a window (6/25).
  schedulingLeakFlaggedAt?: string;
  // Dedup marker: when the reconcile last surfaced a "first touch was drafted but never sent" staff
  // todo for a NEVER-contacted lead (the email-first-touch silence pool, 6/25); re-nudges after a window.
  firstTouchSurfacedAt?: string;
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
    reminderAt?: string;
    windowStart?: { year: number; month: number; day: number; dayOfWeek: string };
    windowEnd?: { year: number; month: number; day: number; dayOfWeek: string };
    windowLabel?: string;
    outcomePromptedAt?: string;
    autoResumedAt?: string;
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
  // STEP 2 of the self-correcting draft loop: when the pre-publish quality gate fails a draft, we
  // store NO draft and set this "held / being fixed" marker instead — so a bad draft never reaches
  // the outgoing field. Cleared the moment a passing draft publishes. Dark unless the live gate flag
  // is on. The console renders a held conversation with no editable textarea / no Send.
  draftHeld?: {
    at: string;
    reason: string; // gate action: "live_hold" | "live_regenerate"
    judgeReason?: string;
    channel: "sms" | "email";
    // Diagnosis context for the agent-watch code-fix loop ("the bridge"): the customer turn the bad
    // draft replied to + the held draft itself. A held draft self-heal couldn't fix is a SIGNAL of a
    // code/comprehension bug; these previews let the monitor diagnose it without re-running anything.
    inboundPreview?: string;
    draftPreview?: string;
  } | null;
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
  // Staff outbound-call contact tracking. `contactAttempts` counts calls that
  // did NOT reach the customer (voicemail / no answer); the follow-up keeps
  // cycling and the open task shows the next attempt number until `reachedAt`
  // is set by a real two-way conversation.
  contact?: {
    attempts: number;
    reachedAt?: string;
    lastAttemptAt?: string;
    lastOutcome?: "reached" | "no_answer";
  };
  softTags?: Record<string, ConversationSoftTagValue>;
};

const conversations = new Map<string, Conversation>();
const leadKeyIndex = new Map<string, string[]>();

function indexConversationInLeadKeyIndex(index: Map<string, string[]>, conv: Conversation): void {
  const leadKey = normalizeLeadKey(conv.leadKey || "");
  if (!leadKey) return;
  conv.leadKey = leadKey;
  const existing = index.get(leadKey) ?? [];
  if (!existing.includes(conv.id)) {
    existing.push(conv.id);
    index.set(leadKey, existing);
  }
}

function indexConversationByLeadKey(conv: Conversation): void {
  indexConversationInLeadKeyIndex(leadKeyIndex, conv);
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

function buildConversationIdForStore(store: Map<string, Conversation>, baseLeadKey: string): string {
  const base = normalizeLeadKey(baseLeadKey) || `lead_${Date.now()}`;
  if (!store.has(base)) return base;
  let attempt = 2;
  let candidate = `${base}::${attempt}`;
  while (store.has(candidate)) {
    attempt += 1;
    candidate = `${base}::${attempt}`;
  }
  return candidate;
}

function buildConversationId(baseLeadKey: string): string {
  return buildConversationIdForStore(conversations, baseLeadKey);
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
  const cashDeliveryPaperwork =
    /\b(certified check|cashier'?s check|bank check|full amount|take delivery|taking delivery|pick(?:ing)? up|pickup)\b/.test(
      t
    ) &&
    !/\b(e-?sign|finance|financing|credit app|credit application|approved|approval|loan|lender)\b/.test(t);
  if (cashDeliveryPaperwork) {
    return { insuranceRequested: false, binderRequested: false, licenseRequested: false };
  }
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

function objectValuesIfRecord<T>(value: T[] | Record<string, T> | undefined): T[] {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") return Object.values(value);
  return [];
}

function conversationStoreEntryCountFromParsed(parsed: any): number {
  return objectValuesIfRecord<Conversation>(parsed?.conversations).length;
}

async function readConversationStoreEntryCount(filePath: string): Promise<number | null> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return conversationStoreEntryCountFromParsed(JSON.parse(raw));
  } catch (err: any) {
    if (err?.code === "ENOENT") return 0;
    console.warn("⚠️ Failed to inspect existing conversations store:", err?.message ?? err);
    return null;
  }
}

export function shouldBlockConversationStoreShrink(
  currentCount: number,
  nextCount: number,
  opts?: { minGuardCount?: number; maxShrinkRatio?: number }
): boolean {
  if (!Number.isFinite(currentCount) || !Number.isFinite(nextCount)) return false;
  if (nextCount >= currentCount) return false;
  const minGuardCount = Number(opts?.minGuardCount ?? 50);
  if (currentCount < minGuardCount) return false;
  const maxShrinkRatio = Number(opts?.maxShrinkRatio ?? 0.5);
  if (!Number.isFinite(maxShrinkRatio) || maxShrinkRatio <= 0 || maxShrinkRatio >= 1) {
    return nextCount === 0;
  }
  return nextCount < Math.floor(currentCount * maxShrinkRatio);
}

type ParsedConversationStore = {
  conversations?: Conversation[] | Record<string, Conversation>;
  todos?: TodoTask[] | Record<string, TodoTask>;
  questions?: InternalQuestion[] | Record<string, InternalQuestion>;
};

// Shared hydration for file and Postgres loads so normalization (malformed-row
// coercion, legacy todo classes, lead-key indexing) cannot drift between
// backends. See docs/postgres_store_swap.md.
function hydrateParsedStore(parsed: ParsedConversationStore): {
  scrubbedInternalOutboundCount: number;
} {
  const list = objectValuesIfRecord<Conversation>(parsed?.conversations);
    const loadedConversations = new Map<string, Conversation>();
    const loadedLeadKeyIndex = new Map<string, string[]>();
    const loadedTodos: TodoTask[] = [];
    const loadedQuestions = objectValuesIfRecord<InternalQuestion>(parsed?.questions);
    let scrubbedInternalOutboundCount = 0;
    for (const c of list) {
      // Defensive normalization: prevent one malformed row from taking down
      // list rendering/API responses.
      if (!Array.isArray((c as any)?.messages)) {
        (c as any).messages = [];
      }
      const originalMessageCount = (c as any).messages.length;
      (c as any).messages = (c as any).messages.filter(
        (message: Partial<Message>) => !isInternalActionLogOutboundMessage(message)
      );
      scrubbedInternalOutboundCount += originalMessageCount - (c as any).messages.length;
      const leadKey = normalizeLeadKey(c?.leadKey || c?.id || "");
      if (!leadKey) continue;
      c.leadKey = leadKey;
      const preferredId = String(c?.id ?? "").trim() || leadKey;
      const id = loadedConversations.has(preferredId)
        ? buildConversationIdForStore(loadedConversations, leadKey)
        : preferredId;
      c.id = id;
      loadedConversations.set(id, c);
      indexConversationInLeadKeyIndex(loadedLeadKeyIndex, c);
    }
    const todoList = objectValuesIfRecord<TodoTask>(parsed?.todos);
    if (todoList.length) {
      for (const task of todoList) {
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
        loadedTodos.push(task);
      }
    }
    conversations.clear();
    for (const [id, conv] of loadedConversations.entries()) conversations.set(id, conv);
    leadKeyIndex.clear();
    for (const [leadKey, ids] of loadedLeadKeyIndex.entries()) leadKeyIndex.set(leadKey, ids);
    todos.length = 0;
    todos.push(...loadedTodos);
    questions.length = 0;
    if (loadedQuestions.length) questions.push(...loadedQuestions);

    return { scrubbedInternalOutboundCount };
}

async function loadFromDisk() {
  try {
    const raw = await fs.readFile(DB_PATH, "utf8");
    const parsed = JSON.parse(raw) as ParsedConversationStore;
    const { scrubbedInternalOutboundCount } = hydrateParsedStore(parsed);

    console.log(`📦 Loaded ${conversations.size} conversations from ${DB_PATH}`);
    if (scrubbedInternalOutboundCount > 0) {
      console.warn(
        `[conversationStore] removed ${scrubbedInternalOutboundCount} internal action-log outbound message(s)`
      );
      scheduleSave();
    }
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

async function loadFromPostgres(): Promise<boolean> {
  try {
    const parsed = await loadConversationStoreFromPostgres();
    const { scrubbedInternalOutboundCount } = hydrateParsedStore(parsed);
    console.log(
      `📦 Loaded ${conversations.size} conversations from Postgres (dealer=${getDealerId()})`
    );
    if (scrubbedInternalOutboundCount > 0) {
      console.warn(
        `[conversationStore] removed ${scrubbedInternalOutboundCount} internal action-log outbound message(s)`
      );
      scheduleSave();
    }
    return true;
  } catch (err: any) {
    notePostgresFailure();
    console.error(
      "⚠️ Failed to load conversations store from Postgres; falling back to file snapshot:",
      err?.message ?? err
    );
    return false;
  }
}

// Hydration must be serialized. hydrateParsedStore() clear-and-replaces the
// shared in-memory maps (conversations/todos/questions), so two overlapping
// loads race on that shared state. The module-import boot load and an explicit
// reloadConversationStore() (the /debug/conversations/reload endpoint, or an
// eval that sets CONVERSATIONS_DB_PATH then reloads) can otherwise run
// concurrently: reloadConversationStore() awaits only its own load, so a
// late-resolving boot load (its fs.readFile delayed behind threadpool
// contention) clears the maps *after* the reload returned — wiping rows written
// in between. That is the voice_call_followup eval flake (a freshly-added call
// follow-up todo vanishing between two assertions) and a latent prod data-loss
// path. Chaining each load after any in-flight one guarantees the clears happen
// in order, so a reload transitively awaits the boot load and nothing dangles
// past it.
let hydrationChain: Promise<void> = Promise.resolve();

async function loadStoreOnStartup() {
  const run = hydrationChain.then(async () => {
    if (getDataBackend() === "postgres") {
      const ok = await loadFromPostgres();
      if (ok) return;
      // Postgres unreachable at boot: hydrate from the file snapshot rather than
      // starting empty. Degraded mode forces file snapshots back on, so the
      // snapshot stays as fresh as the last healthy flush.
    }
    await loadFromDisk();
  });
  // Advance the chain even if this load throws, so the next load still waits for
  // this one to settle before it clears the maps.
  hydrationChain = run.catch(() => {});
  await run;
}

let storeReadyPromise: Promise<void> | null = null;

// Hydration is async and clear-and-replaces the in-memory maps; persisting or
// mutating before it settles can lose rows. Flush paths await this, and early
// programmatic writers (scripts/evals) should too.
export function whenConversationStoreReady(): Promise<void> {
  return storeReadyPromise ?? Promise.resolve();
}

export async function reloadConversationStore() {
  storeReadyPromise = loadStoreOnStartup();
  await storeReadyPromise;
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

    const currentCount = await readConversationStoreEntryCount(DB_PATH);
    const nextCount = payload.conversations.length;
    const allowShrink = process.env.CONVERSATION_STORE_ALLOW_DANGEROUS_SHRINK === "1";
    if (currentCount == null && !allowShrink) {
      console.warn(
        "⚠️ Refusing to save conversations store because the existing store could not be inspected. " +
          "Set CONVERSATION_STORE_ALLOW_DANGEROUS_SHRINK=1 only for a manual recovery."
      );
      return;
    }
    if (
      !allowShrink &&
      currentCount != null &&
      shouldBlockConversationStoreShrink(currentCount, nextCount, {
        minGuardCount: Number(process.env.CONVERSATION_STORE_SHRINK_GUARD_MIN_COUNT ?? 50),
        maxShrinkRatio: Number(process.env.CONVERSATION_STORE_SHRINK_GUARD_MAX_RATIO ?? 0.5)
      })
    ) {
      console.warn(
        `[conversationStore] refusing dangerous shrink save: current=${currentCount}, next=${nextCount}, path=${DB_PATH}`
      );
      return;
    }

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

/**
 * Postgres dirty tracking (docs/postgres_store_swap.md):
 * - saveConversation()/upsert/create/delete report exact row changes.
 * - Every other scheduleSave() call site marks a full upsert; correctness
 *   never depends on a call site having been tagged.
 * - The captured sets are restored on a failed flush so retries lose nothing.
 */
const dirtyConversationIds = new Set<string>();
const removedConversationIds = new Set<string>();
let fullPgUpsertNeeded = true;
let isPgPersisting = false;
let pgRetryQueued = false;
let pgRetryTimer: NodeJS.Timeout | null = null;

function schedulePgRetry() {
  if (pgRetryTimer) return;
  pgRetryTimer = setTimeout(() => {
    pgRetryTimer = null;
    void persistStore();
  }, Number(process.env.PG_RETRY_MS ?? 5000));
  pgRetryTimer.unref?.();
}

async function persistToPostgresSafe(): Promise<boolean> {
  if (isPgPersisting) {
    pgRetryQueued = true;
    return true;
  }
  isPgPersisting = true;
  // Capture-and-reset so mutations that land mid-flush are kept for the next one.
  const full = fullPgUpsertNeeded;
  fullPgUpsertNeeded = false;
  const dirtyIds = Array.from(dirtyConversationIds);
  dirtyConversationIds.clear();
  const removedIds = Array.from(removedConversationIds);
  removedConversationIds.clear();
  const sourceRows: Conversation[] = full
    ? Array.from(conversations.values())
    : (dirtyIds.map(id => conversations.get(id)).filter(Boolean) as Conversation[]);
  try {
    const rows: ConversationUpsertRow[] = sourceRows.map(conv => ({
      id: conv.id,
      leadKey: conv.leadKey ?? "",
      payloadJson: JSON.stringify(conv)
    }));
    await persistConversationStoreToPostgres({
      rows,
      removedIds,
      todosJson: JSON.stringify(todos),
      questionsJson: JSON.stringify(questions)
    });
    return true;
  } catch (err: any) {
    notePostgresFailure();
    if (full) fullPgUpsertNeeded = true;
    for (const id of dirtyIds) dirtyConversationIds.add(id);
    for (const id of removedIds) removedConversationIds.add(id);
    console.warn("⚠️ Postgres conversation-store persist failed; will retry:", err?.message ?? err);
    schedulePgRetry();
    return false;
  } finally {
    isPgPersisting = false;
    if (pgRetryQueued) {
      pgRetryQueued = false;
      schedulePgRetry();
    }
  }
}

async function persistStore(): Promise<void> {
  // Never persist mid-hydration: a flush racing the startup load could write
  // a half-cleared store (the pg path has no shrink guard).
  await whenConversationStoreReady();
  const backend = getDataBackend();
  if (backend === "file") {
    await saveToDisk();
    return;
  }
  if (backend === "dual_write") {
    // File stays the source of truth; Postgres is best-effort shadow so
    // webhook flush latency is unchanged.
    await saveToDisk();
    void persistToPostgresSafe();
    return;
  }
  // backend === "postgres"
  const ok = await persistToPostgresSafe();
  if (!ok || isFileSnapshotEnabled() || isPostgresDegraded()) {
    await saveToDisk();
  }
}

if (getDataBackend() !== "file") {
  const sweepMinutes = Math.max(1, Number(process.env.STORE_FULL_SWEEP_MINUTES ?? 30));
  const sweepTimer = setInterval(() => {
    fullPgUpsertNeeded = true;
    scheduleSave();
  }, sweepMinutes * 60_000);
  sweepTimer.unref?.();
}

// Flush pending conversation changes to disk (used before early-return paths).
export async function flushConversationStore(): Promise<void> {
  await persistStore();
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
  scheduleSave({ trackedConversationId: conv.id });
}

function scheduleSave(opts?: { trackedConversationId?: string }) {
  if (opts?.trackedConversationId) {
    dirtyConversationIds.add(opts.trackedConversationId);
  } else {
    // Untracked mutation: the next Postgres flush upserts everything.
    fullPgUpsertNeeded = true;
  }
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    void persistStore();
  }, 250);
}

// Load immediately on module import
storeReadyPromise = loadStoreOnStartup();

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
  scheduleSave({ trackedConversationId: created.id });
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
  scheduleSave({ trackedConversationId: created.id });
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
  const campaignThread = conv.campaignThread;
  if (
    campaignThread &&
    String(campaignThread.status ?? "").trim().toLowerCase() === "campaign" &&
    String(evt.provider ?? "").trim().toLowerCase() !== "sendgrid_adf"
  ) {
    conv.campaignThread = {
      ...campaignThread,
      status: "linked_open",
      replySeenAt: evt.receivedAt
    };
  }
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

export function isInternalOutboundActionLogBody(input: string): boolean {
  const text = String(input ?? "").replace(/\s+/g, " ").trim();
  return /^(?:Context note applied actions\b|Inventory check:)/i.test(text);
}

function isInternalActionLogOutboundMessage(message: Partial<Message>): boolean {
  if (String(message.direction ?? "").trim().toLowerCase() !== "out") return false;
  const from = String(message.from ?? "").trim().toLowerCase();
  const provider = String(message.provider ?? "").trim().toLowerCase();
  const customerFacingProvider =
    provider === "human" || provider === "draft_ai" || provider === "twilio" || provider === "sendgrid";
  return (from === "system" && customerFacingProvider) || isInternalOutboundActionLogBody(String(message.body ?? ""));
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

/** Marker substring in the context-fidelity "needs your reply" held task — lets the producer (index.ts)
 *  dedup it and the clear-on-reply hook below recognize + close it class-agnostically. */
export const CONTEXT_FIDELITY_HELD_TODO_MARKER = "AI couldn't answer this in context";

export function appendOutbound(
  conv: Conversation,
  from: string,
  to: string,
  body: string,
  provider: MessageProvider = "draft_ai",
  providerMessageId?: string,
  mediaUrls?: string[],
  actor?: { userId?: string | null; userName?: string | null },
  invariantHints?: DraftInvariantHints
) {
  const providerKey = String(provider ?? "").trim().toLowerCase();
  const customerFacingProvider =
    providerKey === "human" || providerKey === "draft_ai" || providerKey === "twilio" || providerKey === "sendgrid";
  if (
    (String(from ?? "").trim().toLowerCase() === "system" && customerFacingProvider) ||
    isInternalOutboundActionLogBody(body)
  ) {
    console.warn("[conversationStore] blocked internal action log from outbound timeline", {
      convId: conv.id,
      provider,
      from,
      to
    });
    conv.updatedAt = nowIso();
    scheduleSave();
    return;
  }
  // Clear-on-reply: a real reply to the customer means the held turn is handled — clear the
  // context-fidelity held marker (so the inbox card tag + banner vanish) and close the "needs your
  // reply" task. A reply counts whether it was logged in the console (provider "human"), sent as a live
  // SMS ("twilio"), or emailed ("sendgrid") — but NOT a draft_ai re-publish (that's the same AI that
  // couldn't answer; it must not self-clear the flag). Placed AFTER the internal-action-log guard so a
  // blocked system/log entry never clears it. (Fix: a real Twilio reply — Nicholas Braun, 2026-06-24 —
  // left the flag stuck because only provider "human" cleared it.)
  if (
    (providerKey === "human" || providerKey === "twilio" || providerKey === "sendgrid") &&
    (conv.draftHeld as any)?.heldKind === "context_fidelity"
  ) {
    conv.draftHeld = null;
    for (const t of listOpenTodos()) {
      if (t.convId === conv.id && String(t.summary ?? "").includes(CONTEXT_FIDELITY_HELD_TODO_MARKER)) {
        markTodoDone(conv.id, t.id);
      }
    }
  }
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
      classificationCta: conv.classification?.cta ?? null,
      ...(invariantHints ?? {})
    });
    if (!invariant.allow) {
      console.warn("[conversationStore] draft blocked by invariant", {
        convId: conv.id,
        reason: invariant.reason,
        followUpMode: conv.followUp?.mode ?? null,
        followUpReason: conv.followUp?.reason ?? null,
        dialogState: conv.dialogState?.name ?? null,
        classificationBucket: conv.classification?.bucket ?? null,
        classificationCta: conv.classification?.cta ?? null
      });
      conv.updatedAt = nowIso();
      scheduleSave();
      return;
    }
    tonedBody = invariant.draftText;
    stateSignalBody = invariant.draftText;
  }
  if (salesToneProvider) {
    tonedBody = applyDeterministicToneOverrides(tonedBody);
    tonedBody = limitEmDashStyle(tonedBody);
  }
  if (!isEmailThread) {
    tonedBody = formatSmsLayout(tonedBody);
    tonedBody = ensureInitialSmsOptOutFooter(conv, tonedBody, { provider, from, to });
  }
  // Voice quality (shadow): flag computer-like / banned phrases in AI drafts so we can SEE how
  // often they slip in. This is the UNIVERSAL draft sink, so one hook covers both inbound replies
  // and the proactive follow-up cadence. Deterministic + cheap; logs only, never mutates the draft
  // — the right fix is a regenerate (judge-driven), not naive mid-sentence deletion.
  if (provider === "draft_ai" && String(process.env.VOICE_BANNED_PHRASE_SHADOW ?? "1") !== "0") {
    const bannedHits = findComputerLikePhrases(tonedBody);
    if (bannedHits.length) {
      console.warn(
        "[voice-banned-phrase-shadow]",
        JSON.stringify({ convId: conv.id, channel: isEmailThread ? "email" : "sms", phrases: bannedHits })
      );
    }
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
  const message: Message = {
    id: makeId("msg"),
    direction: "out",
    from,
    to,
    body: tonedBody,
    mediaUrls: mediaUrls && mediaUrls.length ? mediaUrls : undefined,
    at: nowIso(),
    provider,
    providerMessageId,
    actorUserId: String(actor?.userId ?? "").trim() || undefined,
    actorUserName: String(actor?.userName ?? "").trim() || undefined
  };
  conv.messages.push(message);
  if (provider === "twilio" || provider === "human" || provider === "sendgrid") {
    trackFinanceDocsRequestFromOutbound(conv, stateSignalBody);
    trackTradePayoffFromOutbound(conv, stateSignalBody);
    lockPersonaToStaffSender(conv, actor, tonedBody);
  }
  consumeAgentContextIfNeeded(conv, "outbound_sent");
  conv.updatedAt = nowIso();
  scheduleSave();
  return message;
}

// Voice charter: staff texts use ~0 em-dashes; LLM drafts averaged 0.6/message.
// Keep at most the first em-dash and soften the rest into commas/periods.
export function limitEmDashStyle(text: string): string {
  const raw = String(text ?? "");
  const first = raw.search(/\s*—\s*/);
  if (first < 0) return raw;
  const head = raw.slice(0, first + raw.slice(first).match(/^\s*—\s*/)![0].length);
  const tail = raw
    .slice(head.length)
    .replace(/\s*—\s*/g, ", ")
    .replace(/,\s*([.!?])/g, "$1");
  return head + tail;
}

// Voice charter: once a staff member sends as themselves, the thread's voice is
// theirs — later AI drafts must not silently reintroduce the store persona.
// Sending an unedited persona-signed draft does not count as a takeover.
export function lockPersonaToStaffSender(
  conv: Conversation,
  actor: { userId?: string | null; userName?: string | null } | undefined,
  sentBody: string
) {
  const userName = String(actor?.userName ?? "").trim();
  if (!userName) return;
  if (conv.manualSender?.userName || conv.manualSender?.userId) return;
  if (/\bthis is alexandra\b/i.test(String(sentBody ?? ""))) return;
  conv.manualSender = {
    userId: String(actor?.userId ?? "").trim() || undefined,
    userName,
    activatedAt: nowIso(),
    source: "manual_send"
  };
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
  if (
    /\b(photo|photos|picture|pictures|pic|pics|image|images|screenshot|screenshots)\b/.test(t) &&
    /\b(here(?:'s| is| are)|i (?:just )?sent|sending|attached|i'?m sharing)\b/.test(t)
  ) {
    return "Thanks for sending that over.";
  }
  if (/(thanks|thank you|thanks again|thx|ty|appreciate)/.test(t)) return "You're welcome.";
  if (/(sorry|apologize|apologies|my bad)/.test(t)) return "No worries.";
  if (/(i left|already left|left a deposit|just letting you know|update)/.test(t)) return "Thanks for the update.";
  if (/(can you|could you|would you|do you|is it possible)/.test(t)) return "Sure.";
  if (/(i want|i'd like|i would like|looking to|want to)/.test(t)) return "Absolutely.";
  if (/[?]/.test(t)) return "Happy to help.";
  // No filler agreement opener when nothing fits; callers drop the lead-in instead.
  return "";
}

function capitalizeLeadInRest(rest: string): string {
  const trimmed = String(rest ?? "").trim();
  if (!trimmed) return trimmed;
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}

const LEAD_IN_ACK_OPENER_RE =
  /^(thanks|thank you|no worries|you'?re welcome|sounds good|got it|sure|absolutely|perfect|great)\b/i;

function normalizeGotItLeadIn(body: string, inboundText: string, provider: MessageProvider): string {
  if (!body) return body;
  if (!(provider === "twilio" || provider === "draft_ai")) return body;
  const trimmed = body.trim();
  const match = trimmed.match(/^(?:got it|sounds good)(?:\s*[—–-]|\.|,|!|:)?\s*/i);
  if (!match) return body;
  const rest = trimmed.slice(match[0].length);
  if (!rest) {
    // Bare ack with no contextual lead-in: never ship the curt "Got it." (Joe, 2026-06-20) —
    // fall back to a warm "Sounds good." instead of echoing the original opener.
    const leadIn = pickLeadInVariant(inboundText);
    return leadIn || "Sounds good.";
  }
  // Avoid stacked acknowledgments like "Thanks for sending that over. Thanks for the photo —".
  if (LEAD_IN_ACK_OPENER_RE.test(rest)) return capitalizeLeadInRest(rest);
  const leadIn = pickLeadInVariant(inboundText);
  if (!leadIn) return capitalizeLeadInRest(rest);
  return `${leadIn} ${rest}`.trim();
}

export function finalizeDraftAsSent(
  conv: Conversation,
  draftId: string | undefined,
  finalBody: string,
  provider: MessageProvider,
  providerMessageId?: string,
  actor?: { userId?: string | null; userName?: string | null }
): { usedDraft: boolean; originalDraftBody?: string } {
  if (!draftId) return { usedDraft: false };

  const msg = conv.messages.find(m => m.id === draftId);
  if (!msg) return { usedDraft: false };
  if (msg.direction !== "out" || msg.provider !== "draft_ai") return { usedDraft: false };
  if (msg.draftStatus === "stale") return { usedDraft: false };
  // A media-only send (empty final body) must never consume the draft: doing so
  // wiped the typed reply into originalDraftBody and dropped the media from the
  // record (Bailey 2026-06-10, Mustafa 2026-05-11). The caller falls through to
  // appendOutbound for the media message and the draft stays pending.
  if (!String(finalBody ?? "").trim()) return { usedDraft: false };

  const original = msg.body;
  const stateSignalBody = normalizeSalesToneBase(finalBody);
  let tonedFinalBody = applyDeterministicToneOverrides(stateSignalBody);
  const isEmailThread = String(msg.from ?? "").includes("@") || String(msg.to ?? "").includes("@");
  if (!isEmailThread) {
    tonedFinalBody = ensureInitialSmsOptOutFooter(conv, tonedFinalBody, {
      provider,
      from: msg.from,
      to: msg.to,
      excludeMessageId: msg.id
    });
  }
  if (original.trim() !== tonedFinalBody.trim()) {
    msg.originalDraftBody = original;
  }
  msg.body = tonedFinalBody;
  msg.provider = provider;
  msg.providerMessageId = providerMessageId;
  msg.actorUserId = String(actor?.userId ?? "").trim() || undefined;
  msg.actorUserName = String(actor?.userName ?? "").trim() || undefined;
  msg.at = new Date().toISOString();
  msg.draftStatus = undefined;

  if (provider === "twilio" || provider === "human" || provider === "sendgrid") {
    trackFinanceDocsRequestFromOutbound(conv, stateSignalBody);
    trackTradePayoffFromOutbound(conv, stateSignalBody);
    lockPersonaToStaffSender(conv, actor, tonedFinalBody);
    // A sent reply handles the held turn — clear the "needs reply" flag + its todo. The console "Send"
    // of a pending draft comes through HERE (not appendOutbound), so the clear must live here too,
    // else the flag stays stuck after a real reply (s R Gurajala, 2026-06-25).
    if ((conv as any).draftHeld) {
      (conv as any).draftHeld = null;
      for (const t of listOpenTodos()) {
        if (t.convId === conv.id && String(t.summary ?? "").includes(CONTEXT_FIDELITY_HELD_TODO_MARKER)) {
          markTodoDone(conv.id, t.id);
        }
      }
    }
  }

  conv.updatedAt = new Date().toISOString();
  scheduleSave();

  return { usedDraft: true, originalDraftBody: original };
}

/**
 * Reconcile a stale held / "needs reply" flag (closed-loop cron check, 2026-06-25): if a real reply
 * (human/twilio/sendgrid) was sent AFTER the hold, the turn was handled — clear conv.draftHeld and
 * close its "needs reply" todo. Deterministic safety net for any flag that slipped past the clear-on-
 * reply at the send chokepoints (e.g. a send path that bypassed it). Returns true if it healed one.
 */
export function healStaleHeldFlag(conv: Conversation): boolean {
  const held: any = (conv as any).draftHeld;
  const heldMs = held?.at ? Date.parse(String(held.at)) : NaN;
  if (!Number.isFinite(heldMs)) return false;
  const repliedAfter = (conv.messages ?? []).some(m => {
    if (m.direction !== "out") return false;
    if (m.provider !== "human" && m.provider !== "twilio" && m.provider !== "sendgrid") return false;
    const at = Date.parse(String(m.at ?? ""));
    return Number.isFinite(at) && at > heldMs;
  });
  if (!repliedAfter) return false;
  (conv as any).draftHeld = null;
  for (const t of listOpenTodos()) {
    if (t.convId === conv.id && String(t.summary ?? "").includes(CONTEXT_FIDELITY_HELD_TODO_MARKER)) {
      markTodoDone(conv.id, t.id);
    }
  }
  conv.updatedAt = nowIso();
  scheduleSave();
  return true;
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
  const normalizeLeadRef = (value: unknown): string => String(value ?? "").trim();
  const cloneLeadProfile = (lead: Partial<LeadProfile> | undefined): LeadProfile | undefined => {
    if (!lead) return undefined;
    return {
      ...lead,
      vehicle: lead.vehicle ? { ...lead.vehicle } : undefined,
      tradeVehicle: lead.tradeVehicle ? { ...lead.tradeVehicle } : undefined
    };
  };
  const hasLeadProfileData = (lead: Partial<LeadProfile> | undefined): boolean => {
    if (!lead) return false;
    const {
      vehicle,
      tradeVehicle,
      ...rest
    } = lead;
    const hasTopLevel = Object.values(rest).some(v => v != null && String(v).trim?.() !== "");
    const hasVehicle = !!vehicle && Object.values(vehicle).some(v => v != null && String(v).trim?.() !== "");
    const hasTradeVehicle =
      !!tradeVehicle && Object.values(tradeVehicle).some(v => v != null && String(v).trim?.() !== "");
    return hasTopLevel || hasVehicle || hasTradeVehicle;
  };
  if (!conv.originalLead && hasLeadProfileData(existingLead)) {
    conv.originalLead = cloneLeadProfile(existingLead);
  }
  const existingLeadRef = normalizeLeadRef(existingLead.leadRef);
  const patchLeadRef = normalizeLeadRef(patch.leadRef);
  const shouldKeepPrimaryLead =
    hasLeadProfileData(existingLead) &&
    !!existingLeadRef &&
    !!patchLeadRef &&
    existingLeadRef !== patchLeadRef;

  if (shouldKeepPrimaryLead) {
    const existingLatestLead =
      normalizeLeadRef(conv.latestLead?.leadRef) === patchLeadRef ? (conv.latestLead ?? {}) : {};
    const mergedLatestVehicle = patch.vehicle
      ? { ...(existingLatestLead.vehicle ?? {}), ...patch.vehicle }
      : existingLatestLead.vehicle;
    const mergedLatestTradeVehicle = patch.tradeVehicle
      ? { ...(existingLatestLead.tradeVehicle ?? {}), ...patch.tradeVehicle }
      : existingLatestLead.tradeVehicle;
    conv.latestLead = {
      ...existingLatestLead,
      ...patch,
      vehicle: mergedLatestVehicle,
      tradeVehicle: mergedLatestTradeVehicle
    };
    conv.updatedAt = nowIso();
    scheduleSave();
    return conv;
  }

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

export function discardAllDrafts(conv: Conversation, reason?: string) {
  for (const m of conv.messages ?? []) {
    if (m.direction !== "out") continue;
    if (m.provider === "draft_ai" && m.draftStatus !== "stale") {
      m.draftStatus = "stale";
      if (reason) {
        // Reason is reserved for future audit metadata.
      }
    }
  }
  conv.updatedAt = nowIso();
  scheduleSave();
}

/**
 * Save an operator-authored reply as a reviewable DRAFT in the same console approval box the LLM
 * pipeline uses (the customer-reply operator skill: a human handling ONE hard case). It supersedes
 * any prior pending draft and shows as the pending draft — a human still hits Send in the console.
 *
 * This NEVER sends: it only marks prior drafts stale and appends a draft_ai pending message (SMS)
 * or sets conv.emailDraft (email). It is the verbatim text the operator authored — no draft-quality
 * / context-fidelity gate or substitution runs here (that's for the autonomous pipeline; this text
 * was authored and will be reviewed by staff). The send path is the separate /conversations/:id/send.
 */
export function saveOperatorDraft(
  conv: Conversation,
  args: {
    body: string;
    channel: "sms" | "email";
    mediaUrls?: string[];
    actor?: { userId?: string | null; userName?: string | null };
  }
): { draft: string; channel: "sms" | "email" } {
  const body = String(args.body ?? "").trim();
  discardPendingDrafts(conv, "operator_draft_replaced");
  // An operator-authored draft resolves any prior held state (draft-quality / context-fidelity) —
  // mirror publishCustomerReplyDraft, where a passing draft supersedes the held marker. Otherwise the
  // console keeps showing "being fixed" over a real draft (seen on s R Gurajala, 2026-06-24).
  if ((conv as any).draftHeld) (conv as any).draftHeld = null;
  if (args.channel === "email") {
    conv.emailDraft = body;
    conv.updatedAt = nowIso();
    scheduleSave();
    return { draft: body, channel: "email" };
  }
  const to = String(conv.leadKey ?? "").trim();
  const media = args.mediaUrls?.filter(u => /^https?:\/\//i.test(String(u))) ?? [];
  const msg = appendOutbound(
    conv,
    "salesperson",
    to,
    body,
    "draft_ai",
    undefined,
    media.length ? media : undefined,
    args.actor
  );
  return { draft: msg?.body ?? body, channel: "sms" };
}

function normalizePostSaleCloseoutText(text: string): string {
  return String(text ?? "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function isPostSaleCloseoutCadenceText(text: string): boolean {
  const normalized = normalizePostSaleCloseoutText(text);
  if (!normalized) return false;
  const hasThanksAgain = /\bthanks again\b/.test(normalized);
  const hasSoldVisitSignal =
    /\b(congrats|congratulations|coming in|came in|coming to see us|stopping in|picked up|delivered)\b/.test(
      normalized
    );
  const hasSoftExit = /\b(if you need anything|if anything comes up|just let me know|let me know)\b/.test(
    normalized
  );
  return hasThanksAgain && hasSoldVisitSignal && hasSoftExit;
}

export function retireSupersededPostSaleCloseoutDrafts(
  conv: Conversation,
  sentText: string,
  opts?: { persist?: boolean }
): number {
  if (!isPostSaleCloseoutCadenceText(sentText)) return 0;
  let retired = 0;
  for (const m of conv.messages ?? []) {
    if (m.direction !== "out") continue;
    if (m.provider !== "draft_ai" || m.draftStatus === "stale") continue;
    if (!isPostSaleCloseoutCadenceText(m.body)) continue;
    m.draftStatus = "stale";
    retired += 1;
  }
  if (retired > 0) {
    conv.updatedAt = nowIso();
    if (opts?.persist !== false) scheduleSave();
  }
  return retired;
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

/**
 * Closed-loop "no reply" detector (Phase 2.5, 2026-06-24). The customer spoke LAST and there's
 * nothing for the rep to act on — no pending draft and no held marker. This is wrongful silence the
 * thumbs-down loop is blind to (there's no draft to rate). Held drafts (conv.draftHeld) are a SEPARATE
 * category (the agent tried but a gate blocked it) — excluded here so the two are counted distinctly.
 * Pure + conservative: skips closed/sold conversations (no reply expected there).
 * (Live example: s R Gurajala said "Ok sure" to running numbers and got no draft, 2026-06-24.)
 */
export function isUnansweredInboundConversation(
  conv: Pick<Conversation, "messages" | "closedAt" | "closedReason"> & { sale?: { soldAt?: string | null } | null; draftHeld?: unknown }
): boolean {
  if (!conv) return false;
  if (conv.closedAt || conv.closedReason || conv.sale?.soldAt) return false;
  if ((conv as any).draftHeld) return false; // held is its own bucket
  const msgs = Array.isArray(conv.messages) ? conv.messages : [];
  let last: any = null;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (String(m?.body ?? "").trim() || (Array.isArray(m?.mediaUrls) && m.mediaUrls.length)) {
      last = m;
      break;
    }
  }
  if (!last || last.direction !== "in") return false; // the customer must have spoken last
  return !getLatestPendingDraft(conv as Conversation); // nothing waiting for the rep => silence
}

// Scheduling-leak detector (2026-06-25): a visit/time was being arranged but no appointment ever got
// booked, and it went idle. Catches the agent failing to offer times / confirm / book (Nicholas Braun
// +17166286477: said he'd come ~10 in the morning, Joe confirmed, but dialogState stuck at
// schedule_request with appointment status never "confirmed"). Deterministic: a scheduling-pending
// dialog state + appointment not confirmed + idle + not closed. Conservative idle gate so an in-
// progress back-and-forth (e.g. mid-offer) isn't flagged.
const SCHEDULING_PENDING_STATES = new Set(["schedule_soft", "schedule_request", "schedule_offer_sent"]);

export function isSchedulingLeakConversation(
  conv:
    | (Pick<Conversation, "messages" | "closedAt" | "closedReason" | "dialogState" | "appointment"> & {
        sale?: { soldAt?: string | null } | null;
      })
    | null
    | undefined,
  now: Date = new Date(),
  opts?: { minIdleHours?: number; maxIdleHours?: number }
): boolean {
  if (!conv) return false;
  if (conv.closedAt || conv.closedReason || (conv as any).sale?.soldAt) return false;
  const state = String(conv.dialogState?.name ?? "").trim().toLowerCase();
  if (!SCHEDULING_PENDING_STATES.has(state)) return false; // mid-scheduling only (not booked / other)
  if (String(conv.appointment?.status ?? "none").trim().toLowerCase() === "confirmed") return false; // already booked
  const msgs = Array.isArray(conv.messages) ? conv.messages : [];
  if (!msgs.some(m => m?.direction === "in" && String(m?.body ?? "").trim())) return false;
  let lastMs = 0;
  for (const m of msgs) {
    const t = Date.parse(String(m?.at ?? ""));
    if (Number.isFinite(t) && t > lastMs) lastMs = t;
  }
  if (!lastMs) return false;
  const idleHours = (now.getTime() - lastMs) / 3_600_000;
  // Window: idle enough that it's STALLED (not mid-exchange), but RECENT enough to still be worth
  // chasing. A scheduling thread idle for weeks is a cold/dead lead, NOT an actionable "agreed but
  // never booked" leak — most candidates skew old (age-distribution sweep 6/25: 26 of 34 were 7+
  // days idle), so flagging them all floods the task inbox. Mirrors the stale-handoff min/max
  // windowing; same state-invariants lesson (model the engine's hold conditions, not just "past due").
  const minIdle = opts?.minIdleHours ?? 2;
  const maxIdle = opts?.maxIdleHours ?? 24 * 7; // 7 days
  return idleHours >= minIdle && idleHours <= maxIdle;
}

const WALK_IN_SOURCE_RE = /traffic log pro|walk[\s_-]*in|dealer lead app/i;
const DISPLAY_LEAD_ORIGIN_WINDOW_DAYS = 120;
const DISPLAY_LEAD_ORIGIN_WINDOW_MS = DISPLAY_LEAD_ORIGIN_WINDOW_DAYS * 24 * 60 * 60 * 1000;

function extractAdfSourceLine(body: string): string {
  const match = String(body ?? "").match(/(?:^|\n)\s*source:\s*([^\n\r]+)/i);
  return String(match?.[1] ?? "").trim();
}

function extractAdfLeadRefLine(body: string): string {
  const text = String(body ?? "");
  return (
    text.match(/(?:^|\n)\s*Ref:\s*([^\n\r]+)/i)?.[1]?.trim() ||
    text.match(/(?:^|\n)\s*Lead\s*Ref:\s*([^\n\r]+)/i)?.[1]?.trim() ||
    ""
  );
}

function firstAdfMessage(conv: Conversation): Message | null {
  return (
    conv.messages.find(
      m =>
        m.direction === "in" &&
        m.provider === "sendgrid_adf" &&
        typeof m.body === "string"
    ) ?? null
  );
}

function adfMessageForLeadRef(conv: Conversation, leadRef: string): Message | null {
  const ref = String(leadRef ?? "").trim();
  if (!ref) return null;
  return (
    conv.messages.find(
      m =>
        m.direction === "in" &&
        m.provider === "sendgrid_adf" &&
        typeof m.body === "string" &&
        extractAdfLeadRefLine(m.body) === ref
    ) ?? null
  );
}

function adfMessageAtMs(message: Message | null | undefined): number | null {
  const atMs = Date.parse(String(message?.at ?? ""));
  return Number.isFinite(atMs) ? atMs : null;
}

export function inferWalkIn(conv: Conversation): boolean {
  if (isPhoneLogConversation(conv)) return false;
  if (conv.lead?.walkIn) return true;
  if (String(conv.dialogState?.name ?? "") === "walk_in_active") return true;
  const firstAdfBody = firstAdfMessage(conv)?.body ?? "";
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

export function inferDisplayWalkIn(conv: Conversation): boolean {
  const firstAdf = firstAdfMessage(conv);
  const firstAdfSource = extractAdfSourceLine(firstAdf?.body ?? "");
  const firstAdfSourceSignalsWalkIn = WALK_IN_SOURCE_RE.test(firstAdfSource);
  const firstAdfSourceLocksNonWalkIn = !!firstAdfSource && !firstAdfSourceSignalsWalkIn;

  if (firstAdfSourceLocksNonWalkIn) {
    const currentSource = String(conv.lead?.source ?? (conv as any)?.leadSource ?? "");
    const currentSourceSignalsWalkIn = WALK_IN_SOURCE_RE.test(currentSource);
    const currentLeadRef = String(conv.lead?.leadRef ?? "").trim();
    const currentAdf =
      adfMessageForLeadRef(conv, currentLeadRef) ??
      [...(conv.messages ?? [])]
        .reverse()
        .find(
          m =>
            m.direction === "in" &&
            m.provider === "sendgrid_adf" &&
            typeof m.body === "string" &&
            WALK_IN_SOURCE_RE.test(extractAdfSourceLine(m.body))
        ) ??
      null;
    const firstAtMs = adfMessageAtMs(firstAdf);
    const currentAtMs = adfMessageAtMs(currentAdf);

    if (
      currentSourceSignalsWalkIn &&
      firstAtMs != null &&
      currentAtMs != null &&
      currentAtMs - firstAtMs <= DISPLAY_LEAD_ORIGIN_WINDOW_MS
    ) {
      return false;
    }
  }

  return inferWalkIn(conv);
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

function hasInboundNonSalesIntentForHeat(conv: Conversation): boolean {
  const adfInquiryTexts = extractInboundAdfInquiryTexts(conv);
  if (adfInquiryTexts.some(hasNonSalesInquiryLanguage)) return true;

  const inboundMessages = (conv.messages ?? []).filter(m => m?.direction === "in");
  if (!inboundMessages.length) return false;
  for (const m of inboundMessages) {
    const rawBody = String(m?.body ?? "");
    if (!rawBody) continue;
    const provider = String(m?.provider ?? "").toLowerCase();
    const normalizedBody = rawBody.replace(/\s+/g, " ").trim();
    if (!normalizedBody) continue;
    if (provider === "sendgrid_adf") continue;

    let text = normalizedBody;
    const inquiryIdx = text.toLowerCase().lastIndexOf("inquiry:");
    if (inquiryIdx >= 0) text = text.slice(inquiryIdx + "inquiry:".length).trim();
    if (!text) continue;
    if (hasNonSalesInquiryLanguage(text)) return true;
  }
  return false;
}

function isNonSalesLeadForHeat(conv: Conversation): boolean {
  const bucket = String(conv.classification?.bucket ?? "").trim().toLowerCase();
  const cta = String(conv.classification?.cta ?? "").trim().toLowerCase();
  const leadSource = String(conv.lead?.source ?? "").trim().toLowerCase();
  const nonDealBuckets = new Set(["service", "parts", "apparel"]);
  const nonDealCtas = new Set(["service_request", "parts_request", "apparel_request"]);
  if (nonDealBuckets.has(bucket) || nonDealCtas.has(cta)) return true;
  if (/\b(service|parts?|apparel|motorclothes|eagle\s*rider)\b/.test(leadSource)) return true;
  if (hasInboundNonSalesIntentForHeat(conv)) return true;
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

// Strip the verbose inventory tail off a model name for DISPLAY. Feed/ADF models arrive
// like "CVO Road Glide ST 2026 FLTRXSTSE C6-26 Citrus Heat Re-Entry"; staff just want
// "CVO Road Glide ST". Cut at the first model-year token (19xx/20xx) — the year, stock
// code, and color always trail it. Real numeric model suffixes (Iron 883, Sportster 1200,
// Fat Bob 114, Road Glide 3, Pan America 1250) are NOT 19xx/20xx, so they survive.
// Cosmetic / display-only — never used for matching or watch keys.
export function cleanModelDisplayName(model?: string | null): string {
  const raw = normalizeModelInterestText(model);
  if (!raw) return raw;
  const tokens = raw.split(" ");
  const yearIdx = tokens.findIndex(t => /^(19|20)\d{2}$/.test(t));
  return yearIdx > 0 ? tokens.slice(0, yearIdx).join(" ").trim() : raw;
}

export function isGenericModelInterest(value?: string | null): boolean {
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
    return `${conditionLabel ? `${conditionLabel} ` : ""}${cleanModelDisplayName(model)}`.trim();
  }

  if (!isGenericModelInterest(leadDescription)) return cleanModelDisplayName(leadDescription);
  if (!isGenericModelInterest(leadModel)) return cleanModelDisplayName(leadModel);
  // A placeholder vehicle ("Other" / "Full Line" / "Harley-Davidson Other" — common on
  // Meta promo / prequal ADFs) is not a real bike. The lead is still active, so keep
  // the card and show the model of interest as "N/A" instead of the junk placeholder
  // (Joe, 2026-06-21). Truly empty leads (no vehicle at all) still show nothing.
  if (leadDescription || leadModel) return "N/A";
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
      const inferredWalkIn = inferDisplayWalkIn(c);
      const phoneLog = isPhoneLogConversation(c);
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
        // STEP 2: the agent's draft was held — surfaced so the inbox shows a held state instead of an
        // empty row. Carry heldKind so the card tag can be reason-aware ("Needs reply" for a
        // context-fidelity hold vs the draft-quality "being fixed"); the rest of the reason stays
        // server-side. (Truthy object => existing "held" checks still fire.)
        draftHeld: c.draftHeld ? { heldKind: (c.draftHeld as any).heldKind ?? null } : null,
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
        phoneLog: phoneLog ? true : null,
        hasInboundTwilio,
        hotDealSticky,
        dealTemperature,
        campaignThread: c.campaignThread ?? null,
        walkIn: inferredWalkIn ? true : null,
        engagement: c.engagement ?? null,
        sale: c.sale ?? null,
        classification: c.classification ?? null,
        appointment: c.appointment
          ? {
              status: c.appointment.status,
              whenIso: c.appointment.whenIso ?? null,
              whenText: c.appointment.whenText ?? null,
              staffNotify: c.appointment.staffNotify
                ? {
                    followUpSentAt: c.appointment.staffNotify.followUpSentAt ?? null,
                    outcomeReminderCount: c.appointment.staffNotify.outcomeReminderCount ?? null,
                    outcome: c.appointment.staffNotify.outcome
                      ? {
                          status: c.appointment.staffNotify.outcome.status ?? null,
                          primaryStatus: c.appointment.staffNotify.outcome.primaryStatus ?? null,
                          secondaryStatus: c.appointment.staffNotify.outcome.secondaryStatus ?? null,
                          updatedAt: c.appointment.staffNotify.outcome.updatedAt ?? null
                        }
                      : null
                  }
                : null
            }
          : null,
        followUpCadence: c.followUpCadence ?? null,
        followUp: c.followUp ?? null,
        manualContext: c.manualContext ?? null,
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
  const hasPhonePatch = Object.prototype.hasOwnProperty.call(patch, "phone");
  const hasEmailPatch = Object.prototype.hasOwnProperty.call(patch, "email");
  const nextKey = hasPhonePatch && patch.phone ? normalizeLeadKey(patch.phone) : "";
  const lead = (conv.lead = conv.lead ?? {});

  if (patch.firstName !== undefined) lead.firstName = patch.firstName;
  if (patch.lastName !== undefined) lead.lastName = patch.lastName;
  if (patch.name !== undefined) lead.name = patch.name;
  if (hasEmailPatch) {
    const nextEmail = String(patch.email ?? "").trim();
    if (nextEmail) lead.email = nextEmail;
    else delete lead.email;
  }
  if (hasPhonePatch) {
    if (nextKey) {
      lead.phone = nextKey;
    } else if (patch.phone) {
      lead.phone = patch.phone;
    } else {
      delete lead.phone;
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

export function startFollowUpCadence(
  conv: Conversation,
  anchorAtIso: string,
  timeZone: string,
  opts?: { kind?: "standard" | "long_term" }
) {
  if (conv.status === "closed") return;
  if (conv.followUpCadence?.status === "active" || conv.followUpCadence?.status === "stopped") return;
  // A far-out / not-interested-now lead opens on the slow LONG_TERM_DAY_OFFSETS schedule
  // (first touch ~30 days) instead of the day-1 standard ramp. Same content path
  // (buildLongTermFollowUp); only the timing differs.
  const kind = opts?.kind === "long_term" ? "long_term" : "standard";
  const firstOffset = kind === "long_term" ? LONG_TERM_DAY_OFFSETS[0] : FOLLOW_UP_DAY_OFFSETS[0];
  const nextDueAt = computeFollowUpDueAt(anchorAtIso, firstOffset, timeZone);
  conv.followUpCadence = {
    status: "active",
    anchorAt: anchorAtIso,
    nextDueAt,
    stepIndex: 0,
    kind,
    scheduleInviteCount: 0,
    scheduleMuted: false
  };
  conv.updatedAt = nowIso();
  scheduleSave();
}

// Deterministic follow-up plan from the lead's STRUCTURED ADF purchase-timeframe field (a
// fixed Meta lead-gen enum — NOT free-form customer message text, so this is structured-
// extraction + cadence side-effect, not conversational comprehension):
//   - "suppress"   — explicit "not interested at this time": send the opener, then NO
//                    follow-ups at all (the caller sets a deliberate paused_indefinite state).
//   - "long_term"  — far-out horizons (7+ months / multi-year): gentle [30,90,180] nurture.
//   - "standard"   — near-term / unsure / unparseable: the standard day-1 ramp.
// Pinned by initial_adf_cadence_timeframe:eval.
export function resolveInitialAdfCadencePlan(input: {
  purchaseTimeframe?: string | null;
  purchaseTimeframeMonthsStart?: number | null;
}): "standard" | "long_term" | "suppress" {
  const label = String(input.purchaseTimeframe ?? "").toLowerCase();
  if (label.includes("not interested")) return "suppress";
  if (label.includes("year")) return "long_term";
  const monthsStart = Number(input.purchaseTimeframeMonthsStart);
  // 4+ months out is NOT a hot buyer — soft-invite in the opener, then the gentle long_term
  // nurture, never the aggressive day-1 ramp (Joe, 2026-06-16; was >= 7). Only 0-3mo (and
  // unsure/unparseable) stay on standard; 0-3mo also gets the owner call task.
  if (Number.isFinite(monthsStart) && monthsStart >= 4) return "long_term";
  return "standard";
}

// Near-term (0-3 month) purchase window — the hot Meta buyers. Lines up with
// resolveInitialAdfCadencePlan's "standard" (now 0-3mo + unsure/unparseable; 4+mo routes to
// long_term). Structured-field check (lead timeframe), NOT comprehension — used to create an
// owner call task on hot Meta promo leads.
export function isNearTermMetaTimeframe(input: {
  purchaseTimeframe?: string | null;
  purchaseTimeframeMonthsStart?: number | null;
}): boolean {
  const label = String(input.purchaseTimeframe ?? "").toLowerCase();
  if (label.includes("not interested")) return false;
  if (label.includes("0-3") || /\b0\s*[-–]\s*3\b/.test(label)) return true;
  // numeric fallback — guard against null/undefined (Number(null) === 0 would falsely match).
  const m = input.purchaseTimeframeMonthsStart;
  return typeof m === "number" && Number.isFinite(m) && m >= 0 && m <= 3;
}

// Centralized initial-ADF follow-up cadence for Meta promo leads, applied in BOTH the live
// ADF intake and the regenerate path (route parity). Shapes the cadence to the lead's
// purchase timeframe via resolveInitialAdfCadencePlan and — critically — NEVER stops an
// already-active cadence. The regen path previously called stopFollowUpCadence +
// paused_indefinite here, silently killing the follow-up the live intake had set (a warm
// 0-3mo buyer would get one opener and then nothing if a draft was regenerated).
export function applyMetaPromoInitialCadence(conv: Conversation, timeZone: string): void {
  if (
    conv.followUpCadence?.status ||
    conv.appointment?.bookedEventId ||
    conv.followUp?.mode === "manual_handoff" ||
    conv.followUp?.mode === "paused_indefinite"
  ) {
    return;
  }
  const cadencePlan = resolveInitialAdfCadencePlan({
    purchaseTimeframe: conv.lead?.purchaseTimeframe,
    purchaseTimeframeMonthsStart: conv.lead?.purchaseTimeframeMonthsStart
  });
  if (cadencePlan === "suppress") {
    setFollowUpMode(conv, "paused_indefinite", "meta_not_interested_at_this_time");
  } else {
    startFollowUpCadence(conv, new Date().toISOString(), timeZone, { kind: cadencePlan });
  }
}

// Re-align a cadence that was wrongly deferred to long_term when the lead's STRUCTURED purchase
// timeframe actually resolves to the STANDARD day-1 ramp (resolveInitialAdfCadencePlan). Heals leads
// that came in before the ADF intake was unified onto the centralized policy — e.g. Richard Tait
// (+17162893849, 6/25): a "3-12 Months" (start=3) marketplace lead pushed ~3 months out by a divergent
// inline `monthsStart >= 1` gate. Tight gate so it can only ever fire on the genuine mis-deferral:
// an ACTIVE long_term cadence, on an OPEN, never-contacted, non-handoff/-watch/-booked lead, whose
// timeframe is standard. Fail direction is safe — it only ever moves the next touch SOONER. Returns
// true if it re-anchored. (Same hold conditions modeled as the sendgrid initial-ADF shouldStartCadence
// gate, per the [[conversation-state-invariants]] reconcile-heal pattern.)
export function realignMisdeferredLongTermCadence(
  conv: Conversation,
  timeZone: string,
  now: Date = new Date()
): boolean {
  const cad = conv?.followUpCadence;
  if (!cad || cad.status !== "active" || cad.kind !== "long_term") return false;
  // Only BEFORE any long_term nurture step has fired (stepIndex 0) — re-anchoring a cadence that's
  // already mid-nurture would be disruptive. The INITIAL first touch is SEPARATE from the cadence, so
  // a lead can have been contacted (opener sent) while its deferred nurture hasn't started yet — that's
  // exactly the Richard Tait case (email opener sent, but the long_term nurture still pinned 3mo out).
  if (Number(cad.stepIndex ?? 0) !== 0) return false;
  if (conv.closedAt || conv.closedReason || (conv as any).sale?.soldAt) return false;
  if (conv.appointment?.bookedEventId) return false;
  const mode = String(conv.followUp?.mode ?? "");
  if (mode === "manual_handoff" || mode === "paused_indefinite" || mode === "holding_inventory") return false;
  if (conv.followUp?.reason === "inventory_watch" || conv.inventoryWatch) return false;
  const plan = resolveInitialAdfCadencePlan({
    purchaseTimeframe: conv.lead?.purchaseTimeframe,
    purchaseTimeframeMonthsStart: conv.lead?.purchaseTimeframeMonthsStart
  });
  if (plan !== "standard") return false; // genuinely far-out (4+/multi-year) — leave it deferred
  const anchorAtIso = now.toISOString();
  conv.followUpCadence = {
    status: "active",
    anchorAt: anchorAtIso,
    nextDueAt: computeFollowUpDueAt(anchorAtIso, FOLLOW_UP_DAY_OFFSETS[0], timeZone),
    stepIndex: 0,
    kind: "standard",
    scheduleInviteCount: 0,
    scheduleMuted: false
  };
  conv.updatedAt = nowIso();
  scheduleSave();
  return true;
}

// Soft-visit OUTCOME: a customer who committed to coming in on a day/event ("I'll be there
// Saturday") needs a showed-up/no-show outcome once the visit day passes — booked appointments
// + dealer rides have this, soft visits didn't. Pure decision (nowMs passed in) so it's
// unit-testable. True iff there's a soft-visit window whose day has passed, no booked
// appointment owns the outcome, the conv is open, and we haven't already prompted (idempotent).
export function shouldPromptSoftVisitOutcome(conv: any, nowMs: number): boolean {
  const ss = conv?.scheduleSoft;
  if (!ss) return false;
  if (ss.outcomePromptedAt) return false; // already surfaced once (dedup)
  if (conv?.appointment?.bookedEventId) return false; // a booked appointment owns the outcome
  if (conv?.closedAt || conv?.closedReason || conv?.sale?.soldAt) return false;
  const day = ss.windowEnd ?? ss.windowStart; // date-parts {year,month,day}
  const y = Number(day?.year);
  const mo = Number(day?.month);
  const d = Number(day?.day);
  if (!Number.isFinite(y) || !Number.isFinite(mo) || !Number.isFinite(d)) return false;
  // Prompt the morning AFTER the visit day: window-day 00:00 UTC + 36h ≈ ~8am ET the next day,
  // so we never ask "did they come in?" before the visit day is actually over (any US tz).
  const dueMs = Date.UTC(y, mo - 1, d) + 36 * 3_600_000;
  return nowMs >= dueMs;
}

// How long a soft-visit lead stays quiet awaiting an outcome before the cadence
// auto-resumes a gentle re-invite on its own (suggest mode still gates the draft).
export const SOFT_VISIT_OUTCOME_AUTO_RESUME_BUSINESS_DAYS = 3;

function softVisitVisitDayMs(conv: any): number | null {
  const ss = conv?.scheduleSoft;
  const day = ss?.windowEnd ?? ss?.windowStart; // later day of a multi-day window
  const y = Number(day?.year);
  const mo = Number(day?.month);
  const d = Number(day?.day);
  if (!Number.isFinite(y) || !Number.isFinite(mo) || !Number.isFinite(d)) return null;
  return Date.UTC(y, mo - 1, d);
}

// The grace window after the visit has elapsed with no outcome recorded — the cadence
// should now auto-resume rather than hold the customer silent indefinitely (Joe, 6/15:
// "auto-resume after ~3 business days").
export function softVisitOutcomeAutoResumeReached(conv: any, nowMs: number): boolean {
  const visitDayMs = softVisitVisitDayMs(conv);
  if (visitDayMs == null) return false;
  return businessDaysBetween(visitDayMs, nowMs) >= SOFT_VISIT_OUTCOME_AUTO_RESUME_BUSINESS_DAYS;
}

// A soft-visit lead stays QUIET from the visit day through until the rep knows whether
// the customer showed: no generic nurture fires before the outcome is known. The
// day-before reminder has already gone out (the prior day), so holding from the visit
// day on never suppresses it. Booked appt / closed / sold own the outcome instead. Once
// the ~3-business-day grace passes with no outcome, this flips false and the cadence
// auto-resumes (the tick then freshens the stale visit-window copy). Pure decision —
// the hold itself is applied in the maintenance tick, mirroring the in_process_silent hold.
export function shouldHoldSoftVisitForOutcome(conv: any, nowMs: number): boolean {
  const ss = conv?.scheduleSoft;
  if (!ss) return false;
  if (ss.autoResumedAt) return false; // already auto-resumed once — never re-hold
  if (conv?.appointment?.bookedEventId) return false; // a booked appt owns the outcome
  if (conv?.closedAt || conv?.closedReason || conv?.sale?.soldAt) return false;
  const cad = conv?.followUpCadence;
  if (!cad || cad.status !== "active" || cad.kind === "post_sale") return false;
  const visitDayMs = softVisitVisitDayMs(conv);
  if (visitDayMs == null) return false;
  if (nowMs < visitDayMs) return false; // before the visit day — let the day-before reminder fire
  if (softVisitOutcomeAutoResumeReached(conv, nowMs)) return false; // grace elapsed — auto-resume
  return true;
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

// Resume a cadence that was stopped (e.g. a stale inventory-watch hold that
// turned out to be invalid — the customer's unit was actually available). Recomputes
// nextDueAt for the CURRENT step from the anchor so the scheduler picks it back up,
// and clears the stop reason. No-op unless currently stopped. Mirrors the inline
// `ensureCadenceActive` resume used on customer-reply resumes.
export function resumeFollowUpCadence(conv: Conversation, timeZone: string) {
  const cad = conv.followUpCadence;
  if (!cad || cad.status !== "stopped") return;
  cad.status = "active";
  cad.stopReason = undefined;
  cad.anchorAt = cad.anchorAt ?? nowIso();
  const offsets =
    cad.kind === "long_term"
      ? LONG_TERM_DAY_OFFSETS
      : cad.kind === "post_sale"
        ? POST_SALE_DAY_OFFSETS
        : FOLLOW_UP_DAY_OFFSETS;
  const idx = Math.min(cad.stepIndex ?? 0, offsets.length - 1);
  cad.nextDueAt =
    cad.kind === "post_sale"
      ? computePostSaleDueAt(cad.anchorAt, offsets[idx], timeZone)
      : computeFollowUpDueAt(cad.anchorAt, offsets[idx], timeZone);
  cad.pausedUntil = undefined;
  cad.pauseReason = undefined;
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

// Disengagement taper. A lead that never reached back should not be nudged
// through the entire 13-step sequence (Michael Digiulio +17168660252: 10
// unanswered touches across SMS, email, and a voicemail, still scheduled for
// more). After this many touches with zero customer inbound, the cadence sends
// one graceful close-out and then ends. Joe set the threshold at 9 touches.
export const DISENGAGED_TAPER_AFTER_TOUCHES = 9;

// A lead counts as engaged only when the CUSTOMER reached back: an inbound
// message that isn't the originating web-lead form (sendgrid_adf) or a debug
// event. Our own outbound — texts, emails, even an outbound call/voicemail —
// never marks a silent lead engaged.
export function customerEngagedWithCadence(conv: Conversation): boolean {
  return (conv.messages ?? []).some(
    m =>
      m?.direction === "in" &&
      m?.provider !== "sendgrid_adf" &&
      String(m?.body ?? "").trim().length > 0
  );
}

export function buildDisengagedCadenceCloseout(firstName?: string): string {
  const name = String(firstName ?? "").trim() || "there";
  return `No rush at all, ${name}. I'll stop reaching out for now, but just text me anytime you're ready and I'll jump right back in to help.`;
}

// True when the touch about to be sent should be the disengagement close-out:
// a never-engaged sales lead (not post-sale/long-term) at or past the taper
// threshold.
export function shouldSendDisengagedCloseout(conv: Conversation, sendingStep: number): boolean {
  const cadence = conv.followUpCadence;
  if (!cadence) return false;
  if (cadence.kind === "post_sale" || cadence.kind === "long_term") return false;
  if (customerEngagedWithCadence(conv)) return false;
  return Number(sendingStep) >= DISENGAGED_TAPER_AFTER_TOUCHES;
}

export function advanceFollowUpCadence(conv: Conversation, timeZone: string) {
  if (!conv.followUpCadence || conv.followUpCadence.status !== "active") return;
  const nextStep = conv.followUpCadence.stepIndex + 1;
  conv.followUpCadence.lastSentAt = nowIso();
  conv.followUpCadence.lastSentStep = conv.followUpCadence.stepIndex;
  conv.followUpCadence.stepIndex = nextStep;
  // Disengagement taper: once the close-out touch has gone out to a lead that
  // never replied, end the cadence instead of running the rest of the schedule.
  if (
    conv.followUpCadence.kind !== "post_sale" &&
    conv.followUpCadence.kind !== "long_term" &&
    !customerEngagedWithCadence(conv) &&
    Number(conv.followUpCadence.lastSentStep ?? 0) >= DISENGAGED_TAPER_AFTER_TOUCHES
  ) {
    conv.followUpCadence.status = "completed";
    conv.followUpCadence.stopReason = "disengaged_taper";
    conv.followUpCadence.nextDueAt = undefined;
    conv.updatedAt = nowIso();
    scheduleSave();
    return;
  }
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
  const approxWithMinutes =
    t.match(
      /\b(?:around|about|approx(?:imately)?|close\s+to|near)?\s*(\d{1,2})([:.])(\d{2})\s*(am|pm)?(?:\s*[-\s]?ish)?\b/
    ) ??
    t.match(
      /\b(?:around|about|approx(?:imately)?|close\s+to|near)\s*(\d{3,4})\s*(am|pm)?(?:\s*[-\s]?ish)?\b/
    ) ??
    trimmed.match(/^(\d{3,4})\s*(am|pm)?(?:\s*[-\s]?ish)?$/);
  if (/(around|about|approx|approximately|close\s+to|near|ish)\b/.test(t) && approxWithMinutes) {
    let hourRaw: number;
    let minute: number;
    let meridiem: string | undefined;
    if (approxWithMinutes[3] != null) {
      hourRaw = Number(approxWithMinutes[1]);
      minute = Number(approxWithMinutes[3] ?? "0");
      meridiem = approxWithMinutes[4];
    } else {
      const digits = String(approxWithMinutes[1] ?? "");
      const numeric = Number(digits);
      if (!approxWithMinutes[2] && digits.length === 4 && Number.isFinite(numeric) && numeric >= 1900 && numeric <= 2099) {
        return null;
      }
      const split = digits.length === 3 ? 1 : 2;
      hourRaw = Number(digits.slice(0, split));
      minute = Number(digits.slice(split));
      meridiem = approxWithMinutes[2];
    }
    if (minute < 0 || minute > 59) return null;
    if (hourRaw < 0 || hourRaw > 23) return null;
    if (meridiem && (hourRaw < 1 || hourRaw > 12)) return null;
    let hour24 = hourRaw;
    if (meridiem) {
      if (meridiem === "am") hour24 = hourRaw === 12 ? 0 : hourRaw;
      if (meridiem === "pm") hour24 = hourRaw === 12 ? 12 : hourRaw + 12;
    } else if (hourRaw <= 12 && hourRaw !== 12) {
      hour24 = hourRaw <= 7 ? hourRaw + 12 : hourRaw;
    }
    return { hour24, minute, timeText: approxWithMinutes[0] };
  }
  if (/\bnoon(?:ish)?\b/.test(t)) return { hour24: 12, minute: 0, timeText: "noon" };
  // Approximate time on a round hour ("around 10am", "about 3", "near 9pm").
  // Without this, the catch-all `return null` below dropped the time entirely
  // and bookings fell back to next-available (Chuck Bailey 2026-06-12 asked
  // for "Monday, 15 June around 10am" and was offered Saturday Jun 13).
  if (!approxWithMinutes) {
    const approxBareHour = t.match(
      /\b(?:around|about|approx(?:imately)?|close\s+to|near)\s+(\d{1,2})\s*(am|pm)?(?:\s*[-\s]?ish)?\b/
    );
    if (approxBareHour) {
      const hourRaw = Number(approxBareHour[1]);
      const meridiem = approxBareHour[2];
      if (hourRaw >= 1 && hourRaw <= 12) {
        let hour24 = hourRaw;
        if (meridiem === "am") hour24 = hourRaw === 12 ? 0 : hourRaw;
        else if (meridiem === "pm") hour24 = hourRaw === 12 ? 12 : hourRaw + 12;
        else if (hourRaw !== 12) hour24 = hourRaw <= 7 ? hourRaw + 12 : hourRaw;
        return { hour24, minute: 0, timeText: approxBareHour[0] };
      }
    }
  }
  if (/(around|approx|approximately|ish)\b/.test(t)) return null;

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

function parseOrdinalDateInCurrentWindow(
  text: string,
  timeZone: string
): { year: number; month: number; day: number } | null {
  const match = text.match(/\b(?:the\s*)?(\d{1,2})(?:st|nd|rd|th)\b/i);
  if (!match) return null;
  const day = Number(match[1]);
  if (!Number.isFinite(day) || day < 1 || day > 31) return null;
  const nowParts = getZonedParts(new Date(), timeZone);
  let year = nowParts.year;
  let month = nowParts.month;
  let candidate = new Date(Date.UTC(year, month - 1, day, 12, 0));
  let candidateParts = getZonedParts(candidate, timeZone);
  if (candidateParts.month !== month || candidateParts.day !== day) return null;
  const today = new Date(Date.UTC(nowParts.year, nowParts.month - 1, nowParts.day, 12, 0));
  if (candidate.getTime() < today.getTime()) {
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
    candidate = new Date(Date.UTC(year, month - 1, day, 12, 0));
    candidateParts = getZonedParts(candidate, timeZone);
    if (candidateParts.month !== month || candidateParts.day !== day) return null;
  }
  return { year, month, day };
}

export function parseRequestedDayTime(
  text: string,
  timeZone: string
): { year: number; month: number; day: number; hour24: number; minute: number; dayOfWeek: string } | null {
  const t = text.toLowerCase();
  const dayToken = parseDayToken(t);
  const timeRange =
    dayToken
      ? t.match(
          /\b(?:at|for|around|by|close\s+to|near|between)\s*(\d{1,2})(?::\d{2})?\s*(?:\/|-|to)\s*(\d{1,2})(?::\d{2})?(?:\s*(am|pm))?\b/
        )
      : null;
  const explicitDate = timeRange ? null : (parseExplicitDate(t) ?? parseOrdinalDateInCurrentWindow(t, timeZone));
  let time = parseExactTime(t);
  if (!time && timeRange) {
    const hourRaw = Number(timeRange[1]);
    const meridiem = timeRange[3];
    if (hourRaw >= 1 && hourRaw <= 12) {
      let hour24 = hourRaw;
      if (meridiem === "am") hour24 = hourRaw === 12 ? 0 : hourRaw;
      else if (meridiem === "pm") hour24 = hourRaw === 12 ? 12 : hourRaw + 12;
      else if (hourRaw !== 12) hour24 = hourRaw <= 7 ? hourRaw + 12 : hourRaw;
      time = { hour24, minute: 0, timeText: timeRange[0] };
    }
  }
  if (!time && dayToken && !explicitDate) {
    // Support messages like "Tuesday at 3" or "Tue 3?" by inferring AM/PM.
    const compactMatch = t.match(/\b(?:at|for|around|by|close\s+to|near)\s*(\d{3,4})\s*(am|pm)?\b(?!\s*\/)/);
    if (compactMatch) {
      const digits = compactMatch[1];
      const numeric = Number(digits);
      if (!(digits.length === 4 && Number.isFinite(numeric) && numeric >= 1900 && numeric <= 2099)) {
        const split = digits.length === 3 ? 1 : 2;
        const hourRaw = Number(digits.slice(0, split));
        const minute = Number(digits.slice(split));
        const meridiem = compactMatch[2];
        if (hourRaw >= 1 && hourRaw <= 12 && minute >= 0 && minute <= 59) {
          let hour24 = hourRaw;
          if (meridiem === "am") hour24 = hourRaw === 12 ? 0 : hourRaw;
          else if (meridiem === "pm") hour24 = hourRaw === 12 ? 12 : hourRaw + 12;
          else if (hourRaw !== 12) hour24 = hourRaw <= 7 ? hourRaw + 12 : hourRaw;
          time = { hour24, minute, timeText: compactMatch[0] };
        }
      }
    }
    const atMatch = !time ? t.match(/\b(?:at|for|around|by|close\s+to|near)\s*(\d{1,2})\b(?!\s*\/)/) : null;
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
  // Invariant: a handed-off lead must not keep an ACTIVE customer cadence — otherwise it
  // can auto-text the customer mid-handoff (audited contradiction class). Enforce it on the
  // mode-setter so EVERY handoff path is covered, not just the ones that remember to call
  // stopFollowUpCadence. stopFollowUpCadence preserves post_sale/long_term internally.
  if (mode === "manual_handoff" && conv.followUpCadence?.status === "active") {
    stopFollowUpCadence(conv, "manual_handoff");
  }
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
  taskClass?: TodoTaskClass,
  options?: { allowSoldLead?: boolean; skipMerge?: boolean }
): TodoTask | null {
  const soldContext =
    conv?.closedReason === "sold" ||
    !!conv?.sale?.soldAt ||
    conv?.followUpCadence?.kind === "post_sale";
  if (soldContext && reason !== "call" && options?.allowSoldLead !== true) {
    return null;
  }
  if (reason === "note" && isInternalOutboundActionLogBody(summary)) {
    return null;
  }
  const ownerIdRaw = String(owner?.id ?? conv?.leadOwner?.id ?? "").trim();
  const ownerNameRaw = String(owner?.name ?? conv?.leadOwner?.name ?? "").trim();
  const ownerId = ownerIdRaw || undefined;
  const ownerName = ownerNameRaw || undefined;
  const incomingTaskClass = taskClass ?? inferTodoTaskClass(reason, summary, schedule);
  const incomingIsCadenceGeneratedFollowUp =
    incomingTaskClass === "followup" && isCadenceGeneratedFollowUpTodoSummary(summary);
  const retireSupersededCadenceGeneratedFollowUps = (keepId?: string) => {
    if (incomingTaskClass !== "followup" || incomingIsCadenceGeneratedFollowUp) return 0;
    let count = 0;
    const doneAt = nowIso();
    for (const task of todos) {
      if (task.convId !== conv.id || task.status !== "open") continue;
      if (keepId && task.id === keepId) continue;
      const existingClass = task.taskClass ?? inferTodoTaskClass(task.reason, task.summary, task);
      if (!task.taskClass) task.taskClass = existingClass;
      if (existingClass !== "followup") continue;
      if (!isCadenceGeneratedFollowUpTodoSummary(task.summary)) continue;
      task.status = "done";
      task.doneAt = doneAt;
      count += 1;
    }
    return count;
  };
  const existing = options?.skipMerge
    ? null
    : todos.find(t => {
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
    retireSupersededCadenceGeneratedFollowUps(existing.id);
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
  retireSupersededCadenceGeneratedFollowUps(task.id);
  conv.updatedAt = nowIso();
  scheduleSave();
  return task;
}

export function addCallTodoIfMissing(conv: Conversation, summary: string): TodoTask | null {
  const bucket = String((conv as any)?.classification?.bucket ?? "").trim().toLowerCase();
  const cta = String((conv as any)?.classification?.cta ?? "").trim().toLowerCase();
  const followUpReason = String((conv as any)?.followUp?.reason ?? "").trim().toLowerCase();
  const summaryText = String(summary ?? "").trim();
  const hasActiveCustomerCadence =
    conv?.followUpCadence?.status === "active" &&
    String(conv?.followUpCadence?.kind ?? "standard").toLowerCase() !== "post_sale";
  if (isCadenceGeneratedFollowUpTodoSummary(summaryText) && hasActiveCustomerCadence) {
    return null;
  }
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

/**
 * Collapse duplicate pending-incoming "Notify when the trade arrives" tasks on a conversation
 * to a single survivor. These piled up because addTodo dedups by taskClass, but the identical
 * objective lands in different class buckets ("followup" from the producer vs "todo" from
 * inferTodoTaskClass) and so never merged (Nicholas Braun: 4 open copies, 2026-06-23). Class-
 * agnostic by template match. Returns the number of redundant copies retired. Idempotent: a
 * conversation with 0 or 1 such task is left untouched.
 */
export function healPendingIncomingNotifyTodoDuplicates(conv: Conversation): number {
  const open = todos.filter(t => t.convId === conv.id && t.status === "open");
  const plan = planPendingIncomingNotifyDedup(open);
  if (!plan.retireIds.length) return 0;
  const retire = new Set(plan.retireIds);
  const doneAt = nowIso();
  let retired = 0;
  for (const t of todos) {
    if (!retire.has(t.id)) continue;
    t.status = "done";
    t.doneAt = doneAt;
    retired += 1;
  }
  if (retired) {
    conv.updatedAt = nowIso();
    scheduleSave();
  }
  return retired;
}

/**
 * Upsert the pending-incoming "Notify when the trade arrives" task as a per-conversation
 * SINGLETON, independent of taskClass. Used by applyPendingIncomingInventoryState in BOTH the
 * live and regenerate paths (they funnel through that one producer). Replaces a bare addTodo,
 * whose class-keyed merge let the same objective duplicate across class buckets. First collapses
 * any prior duplicates, then refreshes the survivor (preserving its richest summary so an
 * appended ask isn't dropped) or creates one if none exists.
 */
export function upsertPendingIncomingInventoryNotifyTodo(
  conv: Conversation,
  summary: string,
  sourceMessageId?: string,
  owner?: { id?: string | null; name?: string | null }
): TodoTask | null {
  healPendingIncomingNotifyTodoDuplicates(conv);
  const survivor = todos.find(
    t =>
      t.convId === conv.id &&
      t.status === "open" &&
      isPendingIncomingInventoryNotifyTodoSummary(t.summary)
  );
  if (survivor) {
    survivor.reason = "call";
    survivor.taskClass = "followup";
    if (sourceMessageId) survivor.sourceMessageId = sourceMessageId;
    const ownerId = String(owner?.id ?? conv?.leadOwner?.id ?? "").trim();
    const ownerName = String(owner?.name ?? conv?.leadOwner?.name ?? "").trim();
    if (ownerId) survivor.ownerId = ownerId;
    if (ownerName) survivor.ownerName = ownerName;
    conv.updatedAt = nowIso();
    scheduleSave();
    return survivor;
  }
  return addTodo(conv, "call", summary, sourceMessageId, owner, undefined, "followup");
}

/**
 * A lead handed to a human/department (manual_handoff) has its AI cadence
 * stopped by design — but if the human then goes quiet, the lead dies with no
 * safety net (Mike +17163686204, 2026-06-13: web-widget sales lead, priced +
 * pics by staff, then no cadence and no follow-up). This flags such a lead so
 * the maintenance tick can surface ONE staff "follow up" todo (no auto-send).
 * Pure + conservative: never re-nudges (caller sets staleHandoffNudgedAt), only
 * fires inside a re-engageable idle window, and skips leads that already have an
 * open todo, an active cadence, or are closed/sold.
 */
export function shouldNudgeStaleHandoffLead(
  conv: Conversation,
  hasOpenTodo: boolean,
  now: Date = new Date(),
  opts?: { minIdleDays?: number; maxIdleDays?: number; reNudgeDays?: number }
): boolean {
  if (!conv || hasOpenTodo) return false;
  if (conv.closedAt || conv.closedReason || conv.sale?.soldAt) return false;
  // Dedup, but not forever: a lead nudged once whose to-do was later closed while it's STILL
  // handed off + idle is a permanent orphan. Re-surface it after reNudgeDays (default 14) so
  // it never falls through the cracks. The per-tick cap still prevents any flood.
  if (conv.staleHandoffNudgedAt) {
    const nudgedMs = Date.parse(conv.staleHandoffNudgedAt);
    const reNudgeMs = (opts?.reNudgeDays ?? 14) * 24 * 60 * 60 * 1000;
    if (!Number.isFinite(nudgedMs) || now.getTime() - nudgedMs < reNudgeMs) return false;
  }
  if (conv.followUp?.mode !== "manual_handoff") return false;
  if (String(conv.followUpCadence?.status ?? "").toLowerCase() === "active") return false;
  const messages = Array.isArray(conv.messages) ? conv.messages : [];
  if (!messages.some(m => m?.direction === "in" && String(m?.body ?? "").trim())) return false;
  let lastMs = NaN;
  for (const m of messages) {
    const ms = Date.parse(String(m?.at ?? ""));
    if (Number.isFinite(ms) && (!Number.isFinite(lastMs) || ms > lastMs)) lastMs = ms;
  }
  if (!Number.isFinite(lastMs)) return false;
  const idleMs = now.getTime() - lastMs;
  const minIdleMs = (opts?.minIdleDays ?? 3) * 24 * 60 * 60 * 1000;
  const maxIdleMs = (opts?.maxIdleDays ?? 21) * 24 * 60 * 60 * 1000;
  return idleMs >= minIdleMs && idleMs <= maxIdleMs;
}

// Unsent first-touch safety net (2026-06-25): a NEVER-contacted lead whose initial outreach was DRAFTED
// but never sent (e.g. an email-preferred / email-only ADF lead whose `conv.emailDraft` sits in the
// Email tab, in suggest mode, with no cadence and no todo — the silence pool of 8 old AutoDealers.Digital
// inventory leads). DISTINCT from the stale-handoff nudge: that's for a lead we DID reply to then went
// quiet (hence its 21-day max — don't chase a dead conversation), whereas a missed FIRST touch means the
// customer never heard from us at all, so it should be surfaced regardless of age (NO max-idle cap).
// Returns true iff a deduped staff todo should be created. Fail direction is safe — it only ever asks a
// human to send a drafted reply / make a call.
// A REAL customer-facing outreach actually reached (or was placed to) the customer — a sent text/email
// or a phone call. Excludes draft_ai (unsent) and inbound/internal logs. Used to tell "we've made
// contact" from "drafted but never sent" for the unsent-first-touch net AND the auto-close backfill.
export const REAL_OUTBOUND_CONTACT_PROVIDERS = new Set([
  "twilio",
  "sendgrid",
  "voice_call",
  "voice_summary",
  "voice_transcript"
]);

export function shouldSurfaceUnsentFirstTouch(
  conv: Conversation,
  hasOpenTodo: boolean,
  now: Date = new Date(),
  opts?: { minIdleHours?: number; reNudgeDays?: number }
): boolean {
  if (!conv || hasOpenTodo) return false;
  if (conv.closedAt || conv.closedReason || conv.sale?.soldAt) return false;
  // Never contacted: no real customer-facing outreach EVER on ANY channel — a sent text/email
  // (twilio/sendgrid) OR a phone call (voice_*). A pending draft / inbound ADF echo doesn't count. A
  // lead already worked by phone is NOT awaiting a first touch (Cody/Ron were called by Scott).
  const messages = Array.isArray(conv.messages) ? conv.messages : [];
  const contacted = messages.some(
    m => m?.direction === "out" && REAL_OUTBOUND_CONTACT_PROVIDERS.has(String(m?.provider ?? ""))
  );
  if (contacted) return false;
  // Must have a pending first-touch we'd want a human to send: an email draft, or a non-stale draft_ai.
  const hasPendingDraft =
    !!String(conv.emailDraft ?? "").trim() ||
    messages.some(m => m?.direction === "out" && m.provider === "draft_ai" && (m as any).draftStatus !== "stale");
  if (!hasPendingDraft) return false;
  // A real inbound lead (not an internal/echo-only thread).
  if (!messages.some(m => m?.direction === "in" && String(m?.body ?? "").trim())) return false;
  // Skip leads handled by other surfacing: an active cadence already nudges; paused_indefinite is a
  // deliberate "not now"; event_promo gets a friendly ack, not a sales chase.
  if (String(conv.followUpCadence?.status ?? "").toLowerCase() === "active") return false;
  if (conv.followUp?.mode === "paused_indefinite") return false;
  if (conv.classification?.bucket === "event_promo") return false;
  // Dedup with re-nudge so a persistent orphan re-surfaces but never floods.
  if (conv.firstTouchSurfacedAt) {
    const t = Date.parse(conv.firstTouchSurfacedAt);
    const reNudgeMs = (opts?.reNudgeDays ?? 7) * 24 * 60 * 60 * 1000;
    if (!Number.isFinite(t) || now.getTime() - t < reNudgeMs) return false;
  }
  // Idle a beat since the last message (don't fire instantly — let the normal flow / a human act first).
  let lastMs = NaN;
  for (const m of messages) {
    const ms = Date.parse(String(m?.at ?? ""));
    if (Number.isFinite(ms) && (!Number.isFinite(lastMs) || ms > lastMs)) lastMs = ms;
  }
  if (!Number.isFinite(lastMs)) return false;
  const minIdleMs = (opts?.minIdleHours ?? 4) * 60 * 60 * 1000;
  return now.getTime() - lastMs >= minIdleMs; // NO max-idle: a missed first touch is always worth surfacing
}

function businessDaysBetween(fromMs: number, toMs: number): number {
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) return 0;
  const start = new Date(fromMs);
  start.setUTCHours(0, 0, 0, 0);
  const end = new Date(toMs);
  end.setUTCHours(0, 0, 0, 0);
  let count = 0;
  for (let t = start.getTime() + 86_400_000; t <= end.getTime(); t += 86_400_000) {
    const dow = new Date(t).getUTCDay();
    if (dow !== 0 && dow !== 6) count += 1;
  }
  return count;
}

/**
 * A deal actively being worked by a human (finance/credit in process, or a
 * specific unit held for the buyer). These should stay SILENT — the AI cadence
 * shouldn't auto-message the customer while staff works the deal (Merton Kreps
 * +17165503586: HDFS prequalify, finance deal in process). Conservative by
 * design: misclassifying a lead here would wrongly silence its follow-ups, so it
 * is reason-based only — `holding_inventory` mode (an inventory WATCH, i.e. a
 * prospect waiting for stock) is deliberately NOT a deal in process.
 */
export function isInProcessDealLead(conv: Conversation): boolean {
  if (!conv) return false;
  if (conv.followUpCadence?.kind === "post_sale") return false;
  return /finance_no_contact|credit_app|prequal|finance_prequal|unit_hold|order_hold/.test(
    String(conv.followUp?.reason ?? "").toLowerCase()
  );
}

/**
 * Once an in-process deal has been quiet for N business days (no customer reply,
 * no staff outbound, no open todo), the OWNER — not the customer — gets a single
 * "nudge?" task to approve. Never auto-sends. Pure + dedupe-marked.
 */
export function shouldNudgeInProcessDeal(
  conv: Conversation,
  hasOpenTodo: boolean,
  now: Date = new Date(),
  opts?: { minIdleBusinessDays?: number }
): boolean {
  if (!conv || hasOpenTodo) return false;
  if (conv.closedAt || conv.closedReason || conv.sale?.soldAt) return false;
  if (conv.inProcessNudgedAt) return false;
  if (!isInProcessDealLead(conv)) return false;
  const messages = Array.isArray(conv.messages) ? conv.messages : [];
  if (!messages.some(m => m?.direction === "in" && String(m?.body ?? "").trim())) return false;
  let lastMs = NaN;
  for (const m of messages) {
    const t = Date.parse(String(m?.at ?? ""));
    if (Number.isFinite(t) && (!Number.isFinite(lastMs) || t > lastMs)) lastMs = t;
  }
  if (!Number.isFinite(lastMs)) return false;
  return businessDaysBetween(lastMs, now.getTime()) >= (opts?.minIdleBusinessDays ?? 3);
}

export function listOpenTodos(): TodoTask[] {
  return todos.filter(t => t.status === "open");
}

export function markTodoEscalated(todoId: string, atIso: string = nowIso()): boolean {
  const todo = todos.find(t => t.id === todoId);
  if (!todo) return false;
  todo.escalatedAt = atIso;
  scheduleSave();
  return true;
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

// Persist the latest task-fulfillment auto-close verdict on a task, so staff can see
// WHY it did / didn't auto-close (confidence + evidence + decision).
export function setTodoAutoCloseCheck(
  convId: string,
  todoId: string,
  check: NonNullable<TodoTask["autoCloseCheck"]>
): void {
  const task = todos.find(t => t.id === todoId && t.convId === convId);
  if (!task) return;
  task.autoCloseCheck = check;
  scheduleSave();
}

// Mark a department-handoff task as soft-closed (records WHY + the nudge date). Set once; its presence
// guards against re-soft-closing when the task re-surfaces. The actual soft-close (snooze to nudgeAt)
// is applied by the caller via snoozeTodo.
export function setTodoAutoSoftClose(
  convId: string,
  todoId: string,
  info: NonNullable<TodoTask["autoSoftClose"]>
): void {
  const task = todos.find(t => t.id === todoId && t.convId === convId);
  if (!task) return;
  task.autoSoftClose = info;
  task.autoSoftCloseAt = info.at;
  scheduleSave();
}

// Push an open task's due time forward (staff "snooze"). Keeps the reminder lead
// consistent and re-arms the reminder so it fires again before the new due time.
export function snoozeTodo(convId: string, todoId: string, dueAtIso: string): TodoTask | null {
  const task = todos.find(t => t.id === todoId && t.convId === convId && t.status === "open");
  if (!task) return null;
  const at = new Date(String(dueAtIso ?? "").trim());
  if (Number.isNaN(at.getTime())) return null;
  task.dueAt = at.toISOString();
  const lead =
    Number.isFinite(task.reminderLeadMinutes) && (task.reminderLeadMinutes as number) > 0
      ? (task.reminderLeadMinutes as number)
      : 30;
  task.reminderAt = new Date(at.getTime() - lead * 60 * 1000).toISOString();
  task.reminderSentAt = undefined;
  scheduleSave();
  return task;
}

export function markOpenCallTodosDoneForCompletedVoiceAttempt(convId: string): number {
  let count = 0;
  const doneAt = nowIso();
  for (const task of todos) {
    if (task.convId !== convId || task.status !== "open" || task.reason !== "call") continue;
    task.status = "done";
    task.doneAt = doneAt;
    count += 1;
  }
  if (count > 0) scheduleSave();
  return count;
}

export function ordinalLabel(n: number): string {
  const num = Math.max(1, Math.floor(Number(n) || 1));
  const mod100 = num % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${num}th`;
  switch (num % 10) {
    case 1:
      return `${num}st`;
    case 2:
      return `${num}nd`;
    case 3:
      return `${num}rd`;
    default:
      return `${num}th`;
  }
}

// Label for the NEXT staff call attempt, given how many have already missed.
// After one voicemail this returns "2nd attempt".
export function nextContactAttemptLabel(conv: Conversation): string {
  const attempts = Math.max(0, Number(conv.contact?.attempts ?? 0));
  return `${ordinalLabel(attempts + 1)} attempt`;
}

export function registerMissedContactAttempt(conv: Conversation): number {
  const attempts = Math.max(0, Number(conv.contact?.attempts ?? 0)) + 1;
  conv.contact = {
    ...(conv.contact ?? { attempts: 0 }),
    attempts,
    lastAttemptAt: nowIso(),
    lastOutcome: "no_answer"
  };
  conv.updatedAt = nowIso();
  scheduleSave();
  return attempts;
}

export function registerContactReached(conv: Conversation): void {
  conv.contact = {
    ...(conv.contact ?? { attempts: 0 }),
    attempts: Math.max(0, Number(conv.contact?.attempts ?? 0)),
    reachedAt: nowIso(),
    lastAttemptAt: nowIso(),
    lastOutcome: "reached"
  };
  conv.updatedAt = nowIso();
  scheduleSave();
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

function communicationHasDayOrTime(text: string): boolean {
  return (
    /\b(today|tomorrow|monday|mon|tuesday|tue|wednesday|wed|thursday|thu|friday|fri|saturday|sat|sunday|sun|weekend)\b/i.test(
      text
    ) ||
    /\b\d{1,2}(?::?\d{2})?\s*(?:am|pm)?\b/i.test(text) ||
    /\b(morning|afternoon|evening|noon|midday|close|open)\b/i.test(text)
  );
}

function communicationLooksLikeAcceptedTime(text: string): boolean {
  const normalized = String(text ?? "").toLowerCase();
  if (!normalized.trim()) return false;
  const accepted =
    /\b(i can|can definitely|that works|works for me|works|sounds good|ok(?:ay)?|yes|sure|let'?s do|i'?ll be there|be there|see you|i can make|we can do)\b/i.test(
      normalized
    );
  if (!accepted) return false;
  return communicationHasDayOrTime(normalized);
}

function communicationLooksLikeStaffCompleted(text: string): boolean {
  const normalized = String(text ?? "").toLowerCase();
  if (!normalized.trim()) return false;
  return /\b(all set|handled|taken care of|completed|done|answered|sent over|scheduled|booked|confirmed|locked in|i have (?:that|you|it).*noted|have (?:that|you|it).*noted|have you down|you'?re set|you are set|that time is noted)\b/i.test(
    normalized
  );
}

function communicationLooksLikeOfferOnly(text: string): boolean {
  const normalized = String(text ?? "").toLowerCase();
  if (!normalized.trim()) return false;
  if (communicationLooksLikeStaffCompleted(normalized)) return false;
  if (communicationLooksLikeAcceptedTime(normalized)) return false;
  return (
    /\b(we can do|i can do|can do|available|availability|openings?|squeeze (?:you )?in|i have|we have)\b/i.test(
      normalized
    ) && communicationHasDayOrTime(normalized)
  );
}

function recentOutboundOfferedSchedule(conv: Conversation): boolean {
  const recent = [...(conv.messages ?? [])].reverse().slice(0, 10);
  return recent.some(message => {
    if (message.direction !== "out") return false;
    const body = String(message.body ?? "");
    if (!body.trim()) return false;
    return (
      /\b(we can do|i can do|can do|available|availability|openings?|squeeze (?:you )?in|what time|what day|does .* work|would .* work)\b/i.test(
        body
      ) && communicationHasDayOrTime(body)
    );
  });
}

function taskLooksResolvableByCommunication(
  task: TodoTask,
  opts: {
    resolvedScheduling: boolean;
    resolvedGeneral: boolean;
  }
): boolean {
  const reason = String(task.reason ?? "").trim().toLowerCase();
  const summary = String(task.summary ?? "").toLowerCase();
  const inferred = inferTodoTaskClass(task.reason, task.summary, task);
  const explicit = String(task.taskClass ?? "").trim().toLowerCase();
  const klass =
    explicit === "followup" ||
    explicit === "appointment" ||
    explicit === "todo" ||
    explicit === "reminder"
      ? (explicit as TodoTaskClass)
      : inferred;

  if (reason === "pricing" || reason === "payments" || reason === "approval" || reason === "manager") {
    return false;
  }

  const department = reason === "service" || reason === "parts" || reason === "apparel";
  if (department && (opts.resolvedScheduling || opts.resolvedGeneral)) return true;
  if (klass === "appointment" && opts.resolvedScheduling) return true;

  const schedulingSummary =
    /\b(schedule|appointment|appt|availability|available|come in|stop in|service|pickup|pick up|time|tomorrow|today)\b/i.test(
      summary
    );
  if ((klass === "followup" || klass === "reminder") && opts.resolvedScheduling && schedulingSummary) {
    return true;
  }
  if ((reason === "call" || reason === "other" || reason === "note") && opts.resolvedGeneral) {
    return true;
  }
  return false;
}

export function markOpenTodosResolvedByCommunication(
  conv: Conversation,
  text: string | null | undefined,
  opts?: { channel?: string | null; source?: string | null }
): number {
  const body = String(text ?? "").trim();
  if (!body) return 0;
  if (communicationLooksLikeOfferOnly(body)) return 0;

  const acceptedRecentScheduleOffer =
    recentOutboundOfferedSchedule(conv) && communicationLooksLikeAcceptedTime(body);
  const resolvedScheduling =
    acceptedRecentScheduleOffer ||
    communicationLooksLikeStaffCompleted(body) ||
    /\b(?:appointment|appt|service|pickup|pick up|come in|stop in).*\b(?:booked|scheduled|confirmed|all set|handled|noted)\b/i.test(
      body
    );
  const resolvedGeneral = communicationLooksLikeStaffCompleted(body);
  if (!resolvedScheduling && !resolvedGeneral) return 0;

  let count = 0;
  const doneAt = nowIso();
  for (const task of todos) {
    if (task.convId !== conv.id || task.status !== "open") continue;
    if (!taskLooksResolvableByCommunication(task, { resolvedScheduling, resolvedGeneral })) continue;
    task.status = "done";
    task.doneAt = doneAt;
    count += 1;
  }
  if (count > 0) {
    console.log("[todos] auto-closed resolved tasks", {
      convId: conv.id,
      leadKey: conv.leadKey,
      count,
      channel: opts?.channel ?? null,
      source: opts?.source ?? null
    });
    scheduleSave();
  }
  return count;
}

export function setCrmLastLoggedAt(conv: Conversation, iso: string, leadRef?: string) {
  conv.crm = conv.crm ?? {};
  conv.crm.lastLoggedAt = iso;
  const normalizedLeadRef = String(leadRef ?? "").trim();
  if (normalizedLeadRef) {
    conv.crm.lastLoggedAtByLeadRef = conv.crm.lastLoggedAtByLeadRef ?? {};
    conv.crm.lastLoggedAtByLeadRef[normalizedLeadRef] = iso;
  }
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
  dirtyConversationIds.delete(conv.id);
  removedConversationIds.add(conv.id);
  scheduleSave();
  return true;
}
