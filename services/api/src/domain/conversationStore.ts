import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { InboundMessageEvent } from "./types.js";
import { maybeMarkEngagedFromInbound } from "./engagement.js";
import { setInventoryWatchOptOut } from "./inventoryWatchOptOut.js";
import {
  decideUnansweredWatchAlertPause,
  hasSentWatchCloseOut,
  type UnansweredWatchAlertDecision
} from "./watchAlertUnansweredPause.js";
import {
  decideAppointmentBookingRecord,
  decideAppointmentConfirmRecord,
  decideCadenceQuietWindow,
  decideCadenceRevival,
  decideCadenceStart,
  decideHeldDraftRelease,
  decideSoldCloseout,
  decideLeadCloseout,
  decidePendingCloseoutOnSend,
  type PendingCloseoutSendDecision,
  type LeadCloseoutLane,
  type LeadCloseoutDecision,
  decideAppointmentTeardown,
  decideStaleBookingReplacement,
  type StaleBookingReplacementInput,
  resolveInventoryWatchDefaults,
  type InventoryWatchDefaultsInput,
  decideManualCadenceRestart,
  isRealReplyProvider,
  decideBurnedCadenceLadderRealign,
  decideInventoryAvailabilityReopen,
  type InventoryAvailabilityReopenCause,
  type InventoryAvailabilityReopenDecision,
  decideCloseoutReversal,
  type CloseoutReversalCause,
  type CloseoutReversalDecision,
  decideInventoryHoldRecord,
  type InventoryHoldRecordInput,
  type InventoryHoldRecordDecision,
  decideInventoryWatchArm,
  type InventoryWatchArmLane,
  type InventoryWatchArmDecision,
  decideInventoryWatchDisarm,
  type InventoryWatchDisarmLane,
  type InventoryWatchDisarmDecision,
  resolveInventoryWatchExactness,
  resolveInventoryWatchListNormalization,
  type InventoryWatchListNormalizationDecision,
  resolveInventoryWatchPendingClear,
  type InventoryWatchPendingClearInput,
  decideAppointmentPromptRecord,
  type AppointmentPromptLane,
  type AppointmentPromptRecordDecision,
  decideFinanceOutcomeNotifyState,
  type FinanceOutcomeNotifyLane,
  type FinanceOutcomeNotifyDecision,
  decideVoicemailFollowUpTask,
  type VoicemailFollowUpTaskLane,
  type VoicemailFollowUpTaskDecision,
  decideScheduleInviteBudget,
  decideCadenceLifecycle,
  decideAppointmentAttribution,
  type AppointmentAttributionLane,
  type AppointmentAttributionRecord,
  type AppointmentAttributionDecision,
  decideCadenceReplacement,
  type CadenceReplacementTrigger,
  type CadenceReplacementDecision,
  type CadenceLifecycleVerb,
  type CadenceLifecycleDecision,
  decideReschedulePendingLatch,
  type ReschedulePendingLatchLane,
  type ReschedulePendingLatchDecision,
  decideReschedulePendingClear,
  decideCadenceAdvance,
  type CadenceAdvanceLadder,
  type ReschedulePendingClearLane,
  type ReschedulePendingClearDecision,
  type AppointmentBookingLane,
  type AppointmentBookingRecordDecision,
  type AppointmentConfirmLane,
  type AppointmentConfirmRecordDecision,
  type CadenceQuietTrigger,
  type CadenceRevivalTrigger,
  type HeldDraftReleaseEvent,
  type AppointmentTeardownCause,
  type ManualCadenceRestartContext,
  type ManualCadenceRestartDecision,
  type SoldCloseoutDecision,
  decidePrequalTurn,
  decideFinanceDeclinedCadence
} from "./routeStateReducer.js";
import { buildPrequalStageLine, readPrequalSubmissionResult, buildPrequalStageGoal } from "./workflowRegressionGuards.js";
import { advanceEveryReplySuppressed } from "./draftChannelRules.js";
import { isPlaceholderModel } from "./modelDeflection.js";
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
import type { StaffPingRecord } from "./staffPing.js";
import { buildPersonaSelfIntroPattern, buildUnansweredWatchCloseOutReply } from "./agentVoice.js";
import { getCachedDealerProfile } from "./dealerProfile.js";
import { findComputerLikePhrases } from "./voiceBannedPhrases.js";
import {
  hasCustomerGratitude,
  isFabricatedGratitudeLeadIn,
  resolveLeadInSourceText
} from "./leadInGuards.js";
import {
  isPendingIncomingInventoryNotifyTodoSummary,
  planPendingIncomingNotifyDedup,
  planPendingIncomingNotifyDueAtUpdate,
  shouldVoiceAttemptKeepArrivalNotifyTaskOpen
} from "./pendingIncomingInventory.js";
import { isFollowUpCadenceHeld } from "./cadenceHoldTtl.js";

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
  // How many cadence touches ACTUALLY produced a message. `stepIndex` is a rung on the
  // schedule and advances even when a gate stays quiet, so it is not a count of outreach —
  // see deliveredCadenceTouches / DISENGAGED_TAPER_AFTER_TOUCHES.
  deliveredTouches?: number;
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
  // When a DEFER-class close ("not at this time", or staff archiving as not-interested) becomes
  // re-engageable (Joe ruling 2026-07-29, "soft pause"). A RECORD only — nothing reads this to
  // send. It exists so a deferred lead is not parked forever with nextDueAt cleared, and so any
  // future value-gated re-engagement has an honest earliest date to respect.
  // See resolveDeferCloseSoftPause.
  deferResumeEligibleAt?: string;
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
  /** Dealer-local `YYYY-MM-DD` the walk-in note committed to returning on (parsed slot, not prose). */
  walkInReturnDayIso?: string;
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
  // When true, a base-model watch may fire on a DISTINCT sibling model (e.g. a
  // "Road Glide" watch on a "Road Glide Limited") — set only when the customer is
  // known to be open to other trims (typically used inventory). Default/undefined
  // = strict: a base watch fires only on the exact base model. See
  // unitIsDistinctModelFromWatch (inventoryFeed) + the distinct-model guard.
  openToOtherTrims?: boolean;
  // Sibling-variant scope clarification (watchSiblingScope.ts): when a same-family
  // sibling trim lands during a strict watch, we ASK ONCE whether they're open to
  // variants. askedAt records the one ask (never re-ask); declinedAt records a
  // "just the base" answer (stays strict, never re-ask); a yes sets openToOtherTrims.
  siblingScopeAskedAt?: string;
  siblingScopeDeclinedAt?: string;
  siblingScopeResolvedAt?: string;
  siblingScopeAskModel?: string; // the unit model that prompted the ask (audit + parser context)
  siblingScopeAskStockId?: string;
  status?: "active" | "paused";
  createdAt: string;
  lastNotifiedAt?: string;
  lastNotifiedStockId?: string;
  lastNotifiedModel?: string; // the MODEL of the unit last notified — lets a read-only audit catch a watch that fired on the wrong model (watch_fired_wrong_model) without re-reading the inventory feed
  // OPTIONAL "shop by equipment" filter (Phase B → watches, canary). When present, an arriving unit
  // fires this watch ONLY when it ALSO clears the model/family/year/condition/price criteria above
  // (inventoryItemMatchesWatch, UNCHANGED) AND its cached EquipmentProfile ASSERTS every requested
  // feature (inventoryEquipmentVision.matchesEquipmentQuery / classifyUnitForEquipmentQuery). Keys
  // mirror RequestedEquipmentQuery / EquipmentFeatureKey (only the true keys appear). ABSENT/empty →
  // the watch behaves EXACTLY as a model-only watch does today (the gate is a no-op). FAIL-SAFE: an
  // unprofiled or below-assertion-threshold unit does NOT fire an equipment watch (never a false
  // "your bike came in"). windshield≠fairing holds in the matcher. Behind INVENTORY_EQUIPMENT_VISION_ENABLED
  // (flag off → the field is ignored and the watch fires as a plain model watch).
  requestedEquipment?: {
    bags?: boolean;
    windshield?: boolean;
    fairing?: boolean;
    backrestSissybar?: boolean;
    tourpak?: boolean;
    forwardControls?: boolean;
    apeHangers?: boolean;
    floorboards?: boolean;
    crashBars?: boolean;
  };
  // OPTIONAL "watch a whole SEGMENT" target (stacked on the equipment-watch canary — Joe's literal
  // "let me know when a cruiser with bags and a windshield comes in" case). #292 only watched a concrete
  // MODEL/FAMILY; a SEGMENT ("cruiser","touring","sport","adventure","trike") is a broad code GROUP the
  // glossary resolves, so it NARROWS rather than naming one bike. When present, the model-half fire test
  // is SEGMENT MEMBERSHIP (classifyHarleySegment(unit.model) ∈ segments) instead of a model-token match —
  // ANDed as usual with year/condition/price AND, when set, the requestedEquipment gate above. The `model`
  // field on a segment watch carries a synthetic human label (formatSegmentWatchLabel) purely for
  // copy/merge/bookkeeping — it is NEVER model-token-matched (inventoryItemMatchesWatch routes segment
  // watches to the segment matcher at the top). ABSENT → an ordinary model/family watch, behavior 100%
  // UNCHANGED. Gated behind INVENTORY_EQUIPMENT_VISION_ENABLED (flag off → a segment watch is inert, never
  // fires — the segment-membership modality is new firing surface kept inside the same canary). A segment
  // is a NARROW: a bike outside the group never fires it.
  // "cholo" is a BUILD segment (Cholo style vision, DARK) — resolved by the vision composite
  // (deriveCholoBuild over the unit's equipment profile), NOT by classifyHarleySegment like the model
  // segments. A cholo watch fires only when an arriving unit's build crosses the confident cholo bar
  // (watchPassesCholoGate). Behind CHOLO_STYLE_VISION_ENABLED (which also requires the equipment-vision
  // flag) → a cholo watch is INERT until the flag is flipped.
  segments?: ("cruiser" | "touring" | "sport" | "adventure" | "trike" | "cholo")[];
};

// A watch match that arrived while the per-conversation daily alert cap was in effect
// (Joe ruling 7/23): held on the conversation and delivered as ONE bundled message once
// the cap window expires. Snapshot of everything the composer needs so delivery does not
// depend on the unit still being a "new arrival" in a later sweep.
export type PendingWatchAlert = {
  /** The WATCH's model label at queue time — used to find + stamp the watch at delivery. */
  watchModel: string;
  /** Unit snapshot for the message + availability recheck at delivery. */
  stockId?: string;
  vin?: string;
  year?: string;
  make?: string;
  model?: string;
  color?: string; // the UNIT's feed color (never presented as the color the customer asked for)
  watchedColor?: string; // the color the CUSTOMER asked about at watch creation — for the honesty disclosure at delivery
  url?: string;
  imageUrl?: string;
  availability: "new" | "in_stock" | "again";
  queuedAt: string;
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
  // WHY the unit is coming in — drives the customer copy so we never call a bike the customer is
  // BUYING a "trade". "trade_in" = the customer's own bike being taken in on trade; "sourced_for_purchase"
  // = a used/other unit the dealer is bringing in FOR the customer to buy; "factory_order" = a new
  // bike on order. Unset/"unclear" => neutral "coming in" copy (safe default; never wrongly "trade").
  // Comprehended by parseIncomingInventoryPurposeWithLLM at creation, not regex.
  purpose?: "trade_in" | "sourced_for_purchase" | "factory_order" | "unclear";
  // WHO the incoming unit is allocated to (Joe ruling 2026-07-19, Peter Arnoldo +17166887637):
  // "spoken_for_other" = the in-transit unit is reserved for a DIFFERENT customer — this customer
  // waits on a future one, so the thread is a staff handoff (never an availability watch, and the
  // agent never answers pipeline questions itself). Unset/"unclear" => today's behavior.
  allocation?: "spoken_for_other" | "for_this_customer" | "unclear";
  label?: string;
  note?: string;
  source?: "adf" | "manual" | "customer" | "system";
  sourceMessageId?: string;
  status: "pending" | "arrived" | "cancelled";
  createdAt: string;
  updatedAt: string;
  acknowledgedAt?: string;
  // WHEN the unit is expected (Joe ruling 2026-07-29, Mohamed Ahmed +17164258647: "task off the
  // arrival date"). `expectedArrivalText` is the timing verbatim as staff/the thread stated it
  // ("around 8/21"), comprehended by parseIncomingInventoryPurposeWithLLM — never regexed out of
  // prose. `expectedArrivalAt` is that text resolved to a calendar day, and it dates the "notify
  // them when it arrives" staff task so the task stops reading as due TODAY until the bike lands.
  // Both unset when no timing was stated; the task then keeps today's undated behavior.
  expectedArrivalText?: string;
  expectedArrivalAt?: string;
  /**
   * When the one-time arrival BACKFILL last tried to read an arrival off `note`
   * (domain/pendingIncomingArrivalBackfill.ts). Stamped whether or not it found one, so a record
   * with no stated timing is parsed at most once ever instead of on every reconcile tick.
   */
  expectedArrivalCheckedAt?: string;
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
  /**
   * "agent" when this message came from an agent draft a human approved — WHETHER OR NOT they
   * edited it. Absent means it did not come from a draft, or predates 2026-08-13.
   *
   * WHY IT EXISTS. `originalDraftBody` is stamped only when the text CHANGED, so a draft approved
   * untouched was byte-identical to a message a rep typed from scratch. MEASURED 2026-08-13 over 45
   * days: 179 messages provably edited, 280 drafts never sent as written, and **919 in that
   * ambiguous bucket** — which in suggest mode is the most common way an agent message reaches a
   * customer. It made the one number that says whether this product saves labour or creates it
   * unanswerable: the agent's work is used as written somewhere between **24% and 79%** of the
   * time, and nothing in the store could narrow it.
   *
   * Write-once, at `finalizeDraftAsSent` — the single door an approved draft passes through.
   */
  authoredBy?: "agent";
  mediaUrls?: string[];
  at: string; // ISO
  provider?: MessageProvider;
  providerMessageId?: string; // e.g., Twilio SID for sent messages
  actorUserId?: string;
  actorUserName?: string;
  callMethod?: "cell" | "extension";
  draftStatus?: "pending" | "stale";
  /**
   * Outbound rows only, and only ever written as `false`: this content was RECORDED but never
   * reached the customer (a send failure or missing credentials — the cadence advanced on it and
   * the CRM logged it, so the row must exist, but no one received it). Absent means delivered —
   * the pre-existing default, so history needs no migration. Consumers answering "what has this
   * customer actually heard from us?" must skip `delivered === false`; treating an undelivered
   * row as received is the 8/3 triage's F1 defect (skipped intro on the REAL first message, the
   * judge grading against ghost text, the cadence benching itself for 14 days).
   */
  delivered?: boolean;
  /**
   * Voice rows only. Parser-confirmed (high confidence) that the CUSTOMER took part in a live
   * two-way call, so this thread counts as engaged — see customerEngagedWithCadence. Stamped once
   * at ingest; absent means "not confirmed", never "confirmed false".
   */
  customerSpokeOnCall?: boolean;
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

/** One document photo a customer sent. Declared structurally here (NOT imported from
 *  domain/customerPhotoShare.ts) to keep conversationStore free of a domain import cycle; it is kept
 *  identical to `DocumentPhotoCapture` there, and the eval pins the two in sync. */
export type DocumentPhotoCaptureRecord = {
  documentType:
    | "title"
    | "lien_release"
    | "insurance_card"
    | "insurance_binder"
    | "drivers_license"
    | "competitor_quote";
  context: "trade" | "general";
  capturedAt: string;
  pii: boolean;
  competitorPrice: number;
  competitorModel: string;
};

export type Conversation = {
  id: string;
  leadKey: string;
  mode: ConversationMode;
  status?: "open" | "closed";
  closedAt?: string;
  closedReason?: string;
  /**
   * A closeout waiting on an actual SEND (Joe, 2026-08-04). Armed when the customer tells us they
   * bought a bike; fired by the send route once the acknowledgement really goes out, never when the
   * draft is merely written. One writer (`armPendingCloseout`), one consumer
   * (`applyPendingCloseoutOnSend`), and the close itself still goes through `applyLeadCloseout`.
   */
  pendingCloseout?: { reason: string; armedAt: string };
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
  // Timestamp of the last activity that should sort the working Inbox (a customer reply or a
  // staff/AI 1:1 message). A campaign broadcast updates updatedAt but deliberately leaves this
  // untouched, so a mass send tags the thread without shoving it to the top of the Inbox — only
  // real back-and-forth re-bumps it. Falls back to updatedAt when unset (older conversations).
  inboxActivityAt?: string;
  messages: Message[];
  leadOwner?: LeadOwner;
  // Audit trail for the manager "Ping" button (newest last, capped at STAFF_PING_HISTORY_LIMIT):
  // who poked whom, when, about which tasks. Internal staff SMS only — never a customer send.
  // Also the cooldown source of truth, so a rep can't be pinged five times in a row.
  staffPings?: StaffPingRecord[];
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
  /** Set once when an out-of-country (non-NANP) number is logged + closed as an international
   *  lead (Joe ruling 2026-07-22). Durable so the side effect is once-per-conversation and so
   *  the console/CRM record says WHY the thread is closed and unanswered. */
  internationalLead?: { detectedAt: string; dialCode: string };
  /** Set when a customer shares a photo of their VIN/data plate and VIN-plate photo handling is
   *  enabled (domain/customerPhotoShare.ts). Durable so staff see the VIN string the customer
   *  sent; on a low-confidence/partial read `vin`/`decodeHint` stay blank and `read` is false
   *  (we never persist an untrusted VIN). The decode hint is a staff-only, unconfirmed hint —
   *  never asserted to the customer. */
  vinPlateCapture?: {
    vin: string;
    confidence: number;
    decodeHint: string;
    context: "trade" | "general";
    capturedAt: string;
    read: boolean;
  };
  /** Set when a customer shares a photo of a DOCUMENT (title / lien release / insurance card|binder /
   *  driver's license / competitor quote) and document-photo intake is enabled
   *  (domain/customerPhotoShare.ts). GOVERNANCE (compliance line): for the PII/legal types this
   *  stores the TYPE ONLY — never the contents (no names/DOB/addresses/account or policy numbers/
   *  VIN/license #). `pii` marks those. competitor_quote is NOT PII, so its read price/model are kept
   *  here for staff; for PII types `competitorPrice`/`competitorModel` stay 0/"". Durable so staff
   *  see what kind of document arrived; the contents live only in the attached image for a human.
   *  This field is the LATEST document only (kept for back-compat); the full per-photo history lives
   *  in `documentPhotoCaptures` below. Nothing reads either field to make a decision — they are a
   *  durable audit breadcrumb, and the staff task created per photo is what actually routes it. */
  documentPhotoCapture?: DocumentPhotoCaptureRecord;
  /** Append-only history of EVERY document photo on the thread, oldest→newest, capped at
   *  DOCUMENT_PHOTO_CAPTURE_HISTORY_LIMIT (domain/customerPhotoShare.ts). `documentPhotoCapture` used
   *  to be the only record, so a second document overwrote the first and the audit trail (how many
   *  documents arrived, and whether a competitor-quote price read was right) was lost. Same governance
   *  as above: PII types store the TYPE ONLY, never contents. */
  documentPhotoCaptures?: DocumentPhotoCaptureRecord[];
  scheduler?: SchedulerMemory;
  followUpCadence?: FollowUpCadence;
  /** Set once when a stale manual-handoff lead is surfaced as a staff follow-up todo, so it is never re-nudged. */
  staleHandoffNudgedAt?: string;
  /** Set when a stale draft-quality HOLD is escalated to a staff "needs a human reply" todo, so the
   *  backstop (domain/heldDraftBackstop.ts) doesn't re-fire every tick (re-surfaces after a window). */
  heldDraftEscalatedAt?: string;
  /** Set once when an in-process deal is surfaced as an owner "nudge?" todo, so it is never re-nudged. */
  inProcessNudgedAt?: string;
  manualContext?: ManualContextState;
  objections?: ObjectionState;
  crm?: {
    lastLoggedAt?: string;
    lastLoggedAtByLeadRef?: Record<string, string>;
    /** Last time the TLP catch-up sweep enqueued this conversation. Sweep-path bookkeeping
     *  ONLY — drives the retry back-off in domain/tlpLogCatchup.ts so a permanently-failing
     *  log can't pin the batch; never written by the normal send-path logger. */
    lastCatchupAttemptAt?: string;
    /** Per-leadRef timestamp of a CONFIRMED "lead not found in TLP" lookup — set ONLY when the
     *  Playwright lookup definitively resolves no matching lead (isTlpLeadNotFoundError), never
     *  on a transient portal/login/timeout failure. Suppresses the catch-up sweep from
     *  re-hammering a lead that isn't in the CRM (domain/tlpLogCatchup.ts) until a NEWER outbound
     *  lands — natural recovery if staff later creates the lead and texts again. Cleared on a
     *  successful log for the same ref (setCrmLastLoggedAt). */
    leadRefNotFoundAtByLeadRef?: Record<string, string>;
  };
  inventoryWatch?: InventoryWatch;
  inventoryWatches?: InventoryWatch[];
  inventoryWatchPending?: InventoryWatchPending;
  // Conversation-level stamp of the most recent watch-alert TEXT (any watch, either fire path).
  // Drives the per-CONVERSATION daily alert cap (Joe ruling 7/23, MD +19292685345: 8 watches from
  // one call → 5 alert texts over 2 days, two within minutes — the 24h cooldown was per-watch
  // only). See domain/watchAlertDailyCap.ts.
  lastWatchAlertAt?: string;
  // Watch matches that landed while the daily cap was in effect — held here and delivered as ONE
  // bundled message by the next cron sweep after the cap window expires (never dropped silently,
  // never sent same-day). See domain/watchAlertDailyCap.ts.
  pendingWatchAlerts?: PendingWatchAlert[];
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
  // Phase 3 (Joe 2026-07-28): a customer asked for photos of bike(s) that had NO real gallery (a
  // salesperson "send customer photos" task was made). We watch those units; when real dealer photos
  // land in the feed, auto-DELIVER them (a suggest-mode draft) + close the task. Each unit stores the
  // image-set fingerprint AT REQUEST TIME so we only fire on a genuine photo UPDATE. Behind
  // PHOTO_DELIVERY_ON_ARRIVAL_ENABLED (default off).
  pendingPhotoDelivery?: {
    units: { stockId?: string | null; model: string; year?: string | null; requestedImageHash: string }[];
    requestedAt: string;
  };
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
  // Permanent stop: the first-touch todo aged out unactioned (task-hygiene retirement, 7/23) — the
  // moment for a "first" touch has passed; cold re-engagement belongs to cadence/stale-handoff, and
  // without this stamp the 7-day re-nudge would recreate the same junk task forever.
  firstTouchRetiredAt?: string;
  inventoryContext?: {
    model?: string;
    year?: string;
    condition?: string;
    color?: string;
    finish?: string;
    updatedAt?: string;
  };
  // High-quality cadence (Joe 2026-07-20): national offers already texted to this lead — the SAME
  // promotion is never re-sent; a DIFFERENT one may fire (dedup key = normalized offer title).
  nationalOfferTouches?: { title: string; at: string }[];
  // Price-drop trigger anchor: the asking price of the unit of interest when we first armed the
  // watch; a later feed price below it (by the threshold) fires ONE price-drop touch, then re-anchors.
  interestUnitPriceAnchor?: { stockId: string; price: number; at: string };
  // Human-thread quiet nudge ledger (domain/humanThreadNudge.ts): how many bumps the agent has
  // composed on this human-owned thread and when the last one fired (cap + spacing enforcement).
  humanThreadNudge?: { count: number; lastAt: string };
  paymentBudgetContext?: {
    monthlyBudget?: number | null;
    termMonths?: number | null;
    downPayment?: number | null;
    updatedAt?: string;
  };
  // Where a pre-qualification lead has got to on its stage ladder (Joe, 2026-08-11): discover the
  // bike, discover the budget, try to book, and if that fails send the credit application. Only the
  // two facts the ladder cannot derive from existing state live here — how many times we have
  // invited them in, and whether the application has already gone out. Written ONLY through
  // applyPrequalFlow, which asks decidePrequalTurn; never set these inline.
  prequalFlow?: {
    visitOffersMade?: number;
    creditAppSentAt?: string | null;
    lastStage?: string | null;
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
  // Context-fidelity SHADOW marker (Net 1 of the gap-detection loop): the scorer runs on every draft
  // and, in SHADOW mode, does not hold — but a MAJOR would-hold means this draft answered out of
  // context. The in-memory decision trace is ephemeral, so we persist the verdict here for the
  // read-only outcome-audit sweep to surface to the self-healing loop (so a human doesn't have to
  // catch it). Detection only — no reply behavior changes. A passing/operator draft clears it; the
  // audit detector treats a DIFFERENT reply going out after as resolved (corrected).
  contextFidelityShadow?: {
    at: string;
    frame?: string | null;
    severity?: string | null;
    confidence?: number | null;
    reason?: string | null;
    steering?: string | null;
    channel?: "sms" | "email";
    inboundPreview?: string;
    draftPreview?: string;
  } | null;
  // Human-correction marker (Net 2 of the gap-detection loop): when staff EDIT the AI's draft before
  // sending and the diff-judge (classifyDraftEditWithLLM) finds the change MATERIAL (the human fixed
  // WHAT the reply said — intent / facts / lead-type / context, not just voice/length), we persist the
  // labeled correction here so the read-only outcome-audit sweep turns it into a comprehension anomaly
  // the loop fixes at the parser. The strongest "the agent was wrong here" signal — a human already
  // corrected it. Cosmetic edits are NOT recorded. Recorded async (never blocks a send); recent ones
  // surface, then age out by the detector's window.
  humanCorrection?: {
    at: string;
    category?: string | null;
    confidence?: number | null;
    reason?: string | null;
    steering?: string | null;
    channel?: "sms" | "email";
    messageId?: string | null;
    generatedPreview?: string;
    sentPreview?: string;
  } | null;
  // Cadence-quality SHADOW marker (folded from the cadence-quality judge): a PROACTIVE follow-up message
  // judged suppress/hold (a bad unprompted send). Persisted so the read-only outcome-audit sweep surfaces
  // it as a comprehension gap. Detection only — the draft is not altered (STEP 1 shadow).
  cadenceQualityShadow?: {
    at: string;
    overall?: string | null; // "suppress" | "hold"
    confidence?: number | null;
    reason?: string | null;
    steering?: string | null;
    channel?: "sms" | "email";
    cadenceKind?: string | null;
    messagePreview?: string;
    // What the enforce gate DID with this verdict. `gateHeld` true = the touch was held back before the
    // send/draft path (safety net worked, nobody saw it). Optional because records written before
    // 2026-08-04 carry none — absent reads as NOT held, the noisier/safer direction. Built once, at the
    // single write site, by buildCadenceQualityShadowRecord (draftQualityGate.ts) — see its fail direction.
    gateAction?: string | null;
    gateReason?: string | null;
    gateHeld?: boolean;
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
  // Eager tenant-config validation (fail loudly at startup, not mid-request):
  // in postgres/dual_write mode getDealerId() throws when DEALER_ID/DEALER_SLUG
  // is unset, so a mis-provisioned dealer process crashes at module import
  // instead of silently defaulting into another dealer's database rows. The
  // lazy per-flush call sites catch-and-fallback, so they must never be the
  // first place this surfaces.
  getDealerId();
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

// A bare acknowledgement with no content — the ONLY inbound class that must not pull a
// staff-ARCHIVED conversation back into the active inbox (Deborah Kranz-Mitchell,
// +17166280459, operator-reported 2026-07-01: she was told "if anything changes, give me a
// shout", replied "Will do", and the archive was wiped). Deliberately deterministic and
// NARROW: this gates a STATE side-effect (reopen), not comprehension — and the fail
// direction is "reopen" (anything not unambiguously a bare ack, or any media, reopens).
export function isBareAckInboundText(text: string | null | undefined): boolean {
  const t = String(text ?? "").trim();
  if (!t) return false;
  if (t.length > 40) return false;
  if (/^[\p{Extended_Pictographic}\s]+$/u.test(t)) return true; // emoji-only
  return /^(ok(ay)?|k|will do|sure( thing)?|thanks?( so much| a lot)?|thank you( so much)?|sounds good|got it|no problem|you too|same to you|anytime|yes sir|yup|yep|have a (good|great) (day|one|weekend)|take care|👍)[.!\s]*$/i.test(
    t
  );
}

// The closedReason vocabulary a CLEAN DECLINE produces: the customer said some version of "no
// thanks" and the disposition / response-control closeout shut the lead down. Joe ruling
// 2026-07-22 (Mark Palmer, +17168304817, "No thanks" on 7/21): a clean decline ARCHIVES the
// thread out of the working inbox rather than leaving it hanging around — while a later REAL
// customer SMS still reopens it. Same shape as the staff-archive rule and the hold-thread rule
// below: only a bare, content-free ack leaves a declined thread archived.
//
// BUCKET: deterministic state/side-effect gate over OUR OWN closedReason vocabulary (never
// customer prose — the comprehension that produced the decline already happened in the typed
// disposition/response-control parsers). FAIL DIRECTION: reopen — any reason this list doesn't
// recognize is not a decline, so the conversation reopens exactly as it does today.
export function isDeclineCloseoutReason(reason: string | null | undefined): boolean {
  const r = String(reason ?? "").trim().toLowerCase();
  if (!r) return false;
  return (
    r === "not_interested" ||
    r === "customer_sell_on_own" ||
    r === "customer_keep_current_bike" ||
    r === "customer_stepping_back" ||
    // A "not right now" archives on the same terms as any other decline — a real customer text
    // still reopens it, only a bare ack leaves it archived (Joe ruling 2026-07-29).
    r === "customer_deferred" ||
    // A lost sale is the most finished decline there is; it archives on the same terms, and a real
    // customer text still reopens it (Joe, 2026-08-07).
    r === "customer_bought_elsewhere"
  );
}

/**
 * A DEFER-class close is a soft pause, not a rejection (Joe ruling 2026-07-29, "soft pause",
 * Donald Schuler +17166220132 and Tony Mooradian +17165236994).
 *
 * Both operator reports ("I don't think this one should have been closed"; "this customer said
 * 'not at this time' i don't know how follow ups should be handled") turned out to be STAFF
 * archiving the lead from the console, not the agent closing it. Donald had just been quoted
 * $12,995 and replied "Not at this time thank you" — a "not right now", not a "never".
 *
 * Two things were wrong with how that landed, and neither is the archive itself:
 *  1. DISHONEST STATE. The console close stopped the cadence with `not_interested` but left
 *     `followUp.mode = "active"` (reason `manual_quote_delivered`) — the record simultaneously
 *     claimed the lead was being actively worked AND had been rejected. The agent's own defer path
 *     (applyCustomerDispositionCloseout) has always set `paused_indefinite`; the console path never
 *     did. Same discipline both ways now.
 *  2. NO RESUME ELIGIBILITY. `closeConversation` clears `nextDueAt`, so a deferred lead is parked
 *     forever unless the customer texts first. Recording WHEN a defer becomes re-engageable lets a
 *     later value-gated touch exist at all.
 *
 * What is deliberately NOT changed here: the thread still archives out of the working inbox, and a
 * real inbound still reopens it (`isDeclineCloseoutReason` already covers `not_interested`, so only
 * a bare content-free ack leaves it archived — see appendInbound). This function adds no sends and
 * arms no cadence; `resumeEligibleAt` is a RECORD, and nothing reads it to send yet. Turning a
 * deferred lead back into outreach is a separate, customer-facing decision.
 *
 * BUCKET: deterministic state/side-effect gate over OUR OWN closedReason vocabulary — never
 * customer prose. The comprehension that produced the defer already happened upstream (the typed
 * disposition parser's `defer_no_window` / `stepping_back`, or a human clicking archive).
 *
 * FAIL DIRECTION: today's behavior. A reason this does not recognize returns `softPause: false` and
 * the caller closes exactly as it does now. Honest state can only help staff; it never sends.
 */
export const DEFER_SOFT_PAUSE_RESUME_DAYS = 45;

/**
 * Which defer/decline reasons are worth RE-ENGAGING later, and which are an OUTCOME.
 *
 * Joe ruling 2026-07-29, after reviewing the first cut of this build: one bucket for four
 * different meanings was wrong. "Not at this time" is a timing answer; "I bought a bike in Ohio"
 * is a finished story. Coming back in 45 days to pitch a motorcycle to someone who already bought
 * one is the fabricated-frame failure mode ([[adf-form-vs-question-framing]]) — talking to a
 * customer about a reality that is not theirs.
 *
 * RE-ENGAGEABLE:
 *  - "not_interested"           — what the console archive writes; Donald Schuler +17166220132 said
 *                                only "Not at this time thank you" after a price. The case Joe is
 *                                fixing.
 *  - "customer_deferred"        — the parser's defer_no_window, an explicit "not right now".
 *  - "customer_keep_current_bike" — keeping their bike today; still a rider, still a future buyer.
 *
 * PARKED (honest paused state, but never re-engaged):
 *  - "customer_stepping_back"   — DELIBERATELY parked because it is AMBIGUOUS. The same reason
 *                                carries "I'll pass", "can't afford it right now", AND
 *                                hasBoughtElsewhereDispositionSignalText ("I ended up buying a
 *                                2016 in Ohio"). Since it can mean "already bought", the safe read
 *                                is to leave it alone. Genuine deferrals now land on
 *                                "customer_deferred" instead, so this parks less than it used to.
 *                                2026-08-07: an EXPLICIT purchase now lands on
 *                                "customer_bought_elsewhere", so the "already bought" half of the
 *                                ambiguity is smaller than it was — but it is not gone. The
 *                                deterministic hasBoughtElsewhereDispositionSignalText arm still
 *                                routes some purchases here, and it is only reached when the typed
 *                                parser did not answer. Making this bucket re-engageable is a
 *                                DIFFERENT decision: it starts new outbound conversations with
 *                                leads we have never re-touched, so it is Joe's call, not a
 *                                consequence of adding the new reason. Measure the bucket first.
 *  - "customer_bought_elsewhere" — an OUTCOME, not a deferral. They bought a bike. Never re-pitch
 *                                one; that is the fabricated-frame failure this whole split exists
 *                                to prevent.
 *  - "customer_sell_on_own"     — about selling THEIR bike themselves, not about buying one.
 *
 * FAIL DIRECTION: no re-engagement. An unrecognized reason gets no resume date, so silence is
 * always the default and a wrong read costs a lead we simply never re-touch — never a text to
 * someone it would embarrass us to text.
 */
const DEFER_RESUME_ELIGIBLE_REASONS = new Set([
  "not_interested",
  "customer_deferred",
  "customer_keep_current_bike"
]);

export function isDeferResumeEligibleCloseReason(reason: string | null | undefined): boolean {
  return DEFER_RESUME_ELIGIBLE_REASONS.has(String(reason ?? "").trim().toLowerCase());
}

export function resolveDeferCloseSoftPause(args: {
  reason?: string | null;
  nowMs: number;
}): { softPause: boolean; followUpReason: string; resumeEligibleAt: string | null } {
  const reason = String(args.reason ?? "").trim().toLowerCase();
  if (!isDeclineCloseoutReason(reason)) {
    return { softPause: false, followUpReason: reason, resumeEligibleAt: null };
  }
  // Honest paused state applies to EVERY defer-class close — a parked lead still must not read as
  // "actively worked". Only the resume-eligible DATE is reserved for reasons worth re-touching.
  if (!isDeferResumeEligibleCloseReason(reason) || !Number.isFinite(args.nowMs)) {
    return { softPause: true, followUpReason: reason, resumeEligibleAt: null };
  }
  const resumeMs = args.nowMs + DEFER_SOFT_PAUSE_RESUME_DAYS * 24 * 60 * 60 * 1000;
  return {
    softPause: true,
    followUpReason: reason,
    resumeEligibleAt: new Date(resumeMs).toISOString()
  };
}

/**
 * Apply the defer soft pause. Called by BOTH the console archive endpoint and the agent's
 * disposition closeout so a "not right now" lead lands in the same honest state either way.
 * Returns true when the soft pause applied (i.e. the reason was a defer/decline).
 */
export function applyDeferCloseSoftPause(conv: Conversation, reason?: string | null): boolean {
  const plan = resolveDeferCloseSoftPause({ reason, nowMs: Date.now() });
  if (!plan.softPause) return false;
  const prior = conv.followUp;
  conv.followUp = {
    mode: "paused_indefinite",
    reason: plan.followUpReason,
    updatedAt: nowIso(),
    ...(prior?.skipNextCheckin ? { skipNextCheckin: true } : {})
  };
  if (conv.followUpCadence) {
    conv.followUpCadence.deferResumeEligibleAt = plan.resumeEligibleAt ?? undefined;
  }
  conv.updatedAt = nowIso();
  scheduleSave();
  return true;
}

export function appendInbound(conv: Conversation, evt: InboundMessageEvent) {
  // A customer texted a closed thread. ONE referee (decideCloseoutReversal) now says whether that
  // reopens it — the sold / hold-ack / archived-ack rules that used to live here inline, and that
  // the staff Reopen endpoint and the walk-in hold notes each answered their own way.
  applyCloseoutReversal(conv, {
    cause: "customer_inbound",
    inboundBody: evt.body,
    inboundHasMedia: !!(evt.mediaUrls && evt.mediaUrls.length)
  });
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
  // A real customer reply is genuine Inbox activity — bump the working-Inbox sort. (A campaign
  // reply flips campaign -> linked_open above, so it (correctly) rises to the top of the Inbox.)
  conv.inboxActivityAt = conv.updatedAt;
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
  // This site used to release ONLY a context_fidelity hold while the console-send site released ANY
  // hold on the same trigger — so a draft-quality hold survived a real reply here and the "being
  // fixed" card never cleared. One referee now, via releaseHeldDraft.
  if (isRealReplyProvider(providerKey)) {
    releaseHeldDraft(conv, "real_reply");
  }
  const isEmailThread = String(from ?? "").includes("@") || String(to ?? "").includes("@");
  const salesToneProvider = provider === "draft_ai" || provider === "twilio" || provider === "sendgrid";
  const lastInbound = [...(conv.messages || [])]
    .reverse()
    .find(m => m.direction === "in" && m.body);
  const inboundText = lastInbound?.body ?? "";
  // The LEAD-IN may only be derived from the customer's OWN words, and only while they are still
  // what we are replying to. A voice-call transcript is a two-speaker script (our agent speaks in
  // it too) and a months-old inbound frames nothing. See leadInGuards.ts for the 7/20 miss.
  const leadInSourceText = resolveLeadInSourceText({
    body: inboundText,
    provider: lastInbound?.provider,
    at: lastInbound?.at,
    now: nowIso()
  });
  const normalizedBody = normalizeGotItLeadIn(body, leadInSourceText, provider);
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
  // A 1:1 staff/AI reply is genuine Inbox activity and should keep the thread near the top. A
  // campaign BROADCAST also routes through here, but the broadcast caller freezes inboxActivityAt
  // back to its pre-send value afterward so a mass send tags the thread without reordering the Inbox.
  conv.inboxActivityAt = conv.updatedAt;
  scheduleSave();
  return message;
}

/**
 * Record an outbound that could NOT be sent (send failure, missing Twilio/SendGrid credentials).
 * The row must exist — the cadence advanced on this content and the CRM log carries it — but the
 * customer never received it, so it is stamped `delivered: false` and every "what has the
 * customer heard from us?" consumer skips it. These rows kept the legacy `provider: "human"` so
 * the duplicate-outbound suppressors keep matching them; the marker, not the provider, now says
 * whether it reached anyone. Genuine staff console sends do NOT come through here.
 */
/**
 * Stamp an outbound row that the carrier NEVER ACCEPTED, without disturbing anything else about it.
 *
 * `appendUndeliveredOutbound` is for sites that are creating the row themselves and can drop the
 * actor. The staff Send button cannot: it has already finalized the draft (or appended) WITH the
 * rep's actor stamp, and that stamp is what identifies a staff-authored reply everywhere else. So
 * this marks the row in place.
 *
 * WHY (Maya Iversen, +15854782032, 2026-08-07T01:15:58Z). A deploy was mid-`npm ci`, the twilio
 * library failed to lazily resolve `dayjs`, and the send threw. The catch recorded the attempt so
 * the rep would still see it — but via `appendOutbound`, which leaves no marker, and the contract
 * is "absent marker = delivered". Her thread showed a sent message. She never received it, and
 * nothing in the console said so.
 *
 * FAIL DIRECTION: marking a delivered row as undelivered would make us re-send and annoy a
 * customer; marking an undelivered row correctly costs a visible failure someone can retry. The
 * caller only reaches this from a catch, so it is stamped only when the send actually threw.
 */
/**
 * Record a staff Send that the carrier REJECTED: the rep still sees the attempt in the thread, and
 * the row is stamped undelivered so nothing downstream reads it as a message the customer got.
 *
 * One function because the two halves must not drift — before this, the handler finalized the draft
 * (or appended) and simply forgot the marker, and "absent marker = delivered" did the rest.
 */
export function recordFailedManualSend(
  conv: Conversation,
  args: {
    draftId?: string;
    to: string;
    body: string;
    mediaUrls?: string[];
    actor?: { userId?: string | null; userName?: string | null };
  }
): { usedDraft: boolean; message: Message | null } {
  const fin = finalizeDraftAsSent(conv, args.draftId, args.body, "human", undefined, args.actor);
  if (!fin.usedDraft) {
    appendOutbound(conv, "salesperson", args.to, args.body, "human", undefined, args.mediaUrls, args.actor);
  }
  return { usedDraft: fin.usedDraft, message: markOutboundUndelivered(conv, fin.usedDraft ? args.draftId : undefined) };
}

export function markOutboundUndelivered(conv: Conversation, messageId?: string): Message | null {
  const messages = Array.isArray(conv?.messages) ? conv.messages : [];
  const byId = messageId ? messages.find(m => m.id === messageId) : null;
  const target =
    byId && byId.direction === "out"
      ? byId
      : [...messages].reverse().find(m => m.direction === "out") ?? null;
  if (!target) return null;
  target.delivered = false;
  return target;
}

export function appendUndeliveredOutbound(
  conv: Conversation,
  from: string,
  to: string,
  body: string,
  mediaUrls?: string[]
) {
  const message = appendOutbound(conv, from, to, body, "human", undefined, mediaUrls);
  if (message) message.delivered = false;
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
  // Persona check runs against the CONFIGURED agent name (was a hardcoded AH-era
  // "this is alexandra" literal — identity-fallback sweep, 2026-07-17). This guard
  // only inspects the NEW outbound body at send time (never stored history), so the
  // legacy literal needs no compatibility alternative. Sync path → cached profile.
  const personaSelfIntro = buildPersonaSelfIntroPattern(getCachedDealerProfile()?.agentName);
  if (personaSelfIntro && personaSelfIntro.test(String(sentBody ?? ""))) return;
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
  // Word-bounded via the shared guard: the old substring test matched "ty" inside warranty /
  // pretty / twenty / city / safety / quality, so "what's the warranty?" opened "You're welcome."
  if (hasCustomerGratitude(t)) return "You're welcome.";
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
  // Belt-and-braces: never ship a gratitude opener the source text doesn't warrant, even if a
  // future picker branch produced one (the guard the LLM lead-in path has had since 6/16).
  const safeLeadIn = (source: string): string => {
    const leadIn = pickLeadInVariant(source);
    return leadIn && isFabricatedGratitudeLeadIn(leadIn, source) ? "" : leadIn;
  };
  if (!rest) {
    // Bare ack with no contextual lead-in: never ship the curt "Got it." (Joe, 2026-06-20) —
    // fall back to a warm "Sounds good." instead of echoing the original opener.
    return safeLeadIn(inboundText) || "Sounds good.";
  }
  // Avoid stacked acknowledgments like "Thanks for sending that over. Thanks for the photo —".
  if (LEAD_IN_ACK_OPENER_RE.test(rest)) return capitalizeLeadInRest(rest);
  const leadIn = safeLeadIn(inboundText);
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
  // UNCONDITIONAL, and that is the whole point. `originalDraftBody` above only survives an EDIT, so
  // until now a draft approved untouched left no trace that the agent wrote it — 919 messages in 45
  // days sat in that blind spot, and it is the most common way an agent message reaches a customer
  // in suggest mode. This is the only door an approved draft passes through, so one line here makes
  // agent authorship countable for the first time.
  msg.authoredBy = "agent";
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
    releaseHeldDraft(conv, "real_reply");
  }

  conv.updatedAt = new Date().toISOString();
  scheduleSave();

  return { usedDraft: true, originalDraftBody: original };
}

/**
 * Release a held ("being fixed") draft — the ONE place that clears `conv.draftHeld`.
 *
 * Six sites used to clear it, each with its own condition, each patched after its own incident, and
 * two of them disagreed on the same trigger (see routeStateReducer.decideHeldDraftRelease). This
 * does the whole job — ask the referee, clear the flag, close the paired "needs reply" todo — so a
 * caller cannot get half of it right. Returns true if a hold was actually released.
 */
export function releaseHeldDraft(conv: Conversation, event: HeldDraftReleaseEvent): boolean {
  const held: any = (conv as any).draftHeld;
  if (!held) return false;
  if (!decideHeldDraftRelease({ heldKind: held.heldKind ?? held.reason, event }).release) return false;
  (conv as any).draftHeld = null;
  for (const t of listOpenTodos()) {
    if (t.convId === conv.id && String(t.summary ?? "").includes(CONTEXT_FIDELITY_HELD_TODO_MARKER)) {
      markTodoDone(conv.id, t.id);
    }
  }
  return true;
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
  if (!releaseHeldDraft(conv, "real_reply")) return false;
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
  releaseHeldDraft(conv, "operator_draft");
  if ((conv as any).contextFidelityShadow) (conv as any).contextFidelityShadow = null;
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
  let lastInboundMs = 0;
  for (const m of msgs) {
    const t = Date.parse(String(m?.at ?? ""));
    if (!Number.isFinite(t)) continue;
    if (t > lastMs) lastMs = t;
    if (m?.direction === "in" && String(m?.body ?? "").trim() && t > lastInboundMs) lastInboundMs = t;
  }
  if (!lastMs || !lastInboundMs) return false;
  // Window: idle enough that it's STALLED (not mid-exchange), but RECENT enough to still be worth
  // chasing. A scheduling thread idle for weeks is a cold/dead lead, NOT an actionable "agreed but
  // never booked" leak — most candidates skew old (age-distribution sweep 6/25: 26 of 34 were 7+
  // days idle), so flagging them all floods the task inbox. Mirrors the stale-handoff min/max
  // windowing; same state-invariants lesson (model the engine's hold conditions, not just "past due").
  //
  // The RECENCY side must anchor to the customer's LAST INBOUND, never to our own outbound: a
  // campaign broadcast resets an any-message clock across the whole store, which made 26
  // months-dead scheduling threads (customer quiet 60-115 days) look "freshly active" the day the
  // 7/18 event blast went out — one blast, 26 junk "book the visit" tasks (2026-07-17 sweep). A
  // blast we sent does not revive the customer's intent. The STALLED side (minIdle) stays on
  // any-message so a live back-and-forth is still never flagged mid-exchange.
  const minIdle = opts?.minIdleHours ?? 2;
  const maxIdle = opts?.maxIdleHours ?? 24 * 7; // 7 days
  const idleHours = (now.getTime() - lastMs) / 3_600_000;
  const inboundIdleHours = (now.getTime() - lastInboundMs) / 3_600_000;
  return idleHours >= minIdle && inboundIdleHours <= maxIdle;
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

/**
 * The message an inbox row previews as "the latest" (Joe ruling 2026-07-20; Peter Meredith
 * +17168303999): a STALE never-sent draft must never be the row preview — it renders like a
 * real send and inflates the operator's read of the thread ("It said I'll check that time…"
 * was a thumbs-downed draft that never went out). Voice-call/transcript rows are skipped as
 * before (calls have their own surface). Fallback order: last non-call non-stale message →
 * raw last message (so a thread of only calls/stale drafts still shows something) → null.
 * Pure; pinned by inbox_stale_draft_preview:eval.
 */
export function pickInboxPreviewMessage<
  T extends { provider?: string | null; draftStatus?: string | null }
>(messages: T[] | undefined | null): T | null {
  const list = Array.isArray(messages) ? messages : [];
  const preview = list.filter(
    m =>
      m.provider !== "voice_call" &&
      m.provider !== "voice_transcript" &&
      m.draftStatus !== "stale"
  );
  return preview[preview.length - 1] ?? list[list.length - 1] ?? null;
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
      const lastNonCall = pickInboxPreviewMessage(c.messages);
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
        inboxActivityAt: c.inboxActivityAt ?? null,
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
        // Display honesty: while the follow-up mode holds the cadence (holding_inventory /
        // manual_handoff / paused_indefinite, post_sale excepted), the tick will not send —
        // so the console must show "on hold", not an overdue nextDueAt (frozen-hold census 7/17).
        followUpHold: isFollowUpCadenceHeld(c.followUp?.mode, c.followUpCadence?.kind) ? true : null,
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

// REMOVED (2026-08-02): `updateAppointmentFromInbound` + its `ensureAppointment`/TIME_RE/DAY_RE
// helpers. It read customer intent with keyword regexes ("cancel|reschedule", a bare weekday +
// clock match, "works|sounds good|ok|yes") and, on a match, WROTE the appointment record whole —
// wiping it to `status: "none"` or asserting `status: "confirmed", confirmedBy: "customer"`.
// That is comprehension by regex on a Tier-1 field (AGENTS.md forbids it), and its fail-direction
// is unsafe in both directions: "ok" in any sentence confirms an appointment nobody agreed to, and
// the word "cancel" anywhere erases a booked one. It had ZERO callers — the live appointment path
// runs through the booking-intent parser and the `applyAppointment*` referees — so this was a dormant
// landmine, not behaviour: any future caller would have silently regressed appointment handling.
// The two `conv.appointment = {...}` writes it contributed are why `appointment` still shows an
// unrefereed fight surface it never actually fought in.

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
  sourceMessageId?: string,
  // Whose text is being matched. Defaults to the customer's, because four of the five callers are
  // inbound lanes; the manual-outbound caller is matching the REP'S OWN send and says so.
  opts?: { lane?: Extract<AppointmentConfirmLane, "customer_slot_match" | "salesperson_manual_booking"> }
) {
  const slotMatchLane = opts?.lane ?? "customer_slot_match";
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
      const decision = decideAppointmentConfirmRecord({
        lane: slotMatchLane,
        reschedulePending: conv.appointment?.reschedulePending
      });
      if (!decision.confirm) return false;
      conv.appointment = conv.appointment ?? { status: "none", updatedAt: nowIso() };
      conv.appointment.status = decision.status;
      conv.appointment.whenText = String(single.startLocal ?? single.start ?? "").trim();
      conv.appointment.whenIso = single.start;
      if (decision.confirmedBy) conv.appointment.confirmedBy = decision.confirmedBy;
      conv.appointment.updatedAt = nowIso();
      conv.appointment.acknowledged = decision.acknowledged;
      if (decision.clearReschedulePending) conv.appointment.reschedulePending = false;
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
        const decision = decideAppointmentConfirmRecord({
          lane: slotMatchLane,
          reschedulePending: conv.appointment?.reschedulePending
        });
        if (!decision.confirm) return false;
        conv.appointment = conv.appointment ?? { status: "none", updatedAt: nowIso() };
        conv.appointment.status = decision.status;
        conv.appointment.whenText = String(single.startLocal ?? single.start ?? "").trim();
        conv.appointment.whenIso = single.start;
        if (decision.confirmedBy) conv.appointment.confirmedBy = decision.confirmedBy;
        conv.appointment.updatedAt = nowIso();
        conv.appointment.acknowledged = decision.acknowledged;
        if (decision.clearReschedulePending) conv.appointment.reschedulePending = false;
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

  const decision = decideAppointmentConfirmRecord({
    lane: slotMatchLane,
    reschedulePending: conv.appointment?.reschedulePending
  });
  if (!decision.confirm) return false;
  conv.appointment = conv.appointment ?? { status: "none", updatedAt: nowIso() };
  conv.appointment.status = decision.status;
  conv.appointment.whenText = String(match.startLocal ?? match.start ?? "").trim();
  conv.appointment.whenIso = match.start;
  if (decision.confirmedBy) conv.appointment.confirmedBy = decision.confirmedBy;
  conv.appointment.updatedAt = nowIso();
  conv.appointment.acknowledged = decision.acknowledged;
  if (decision.clearReschedulePending) conv.appointment.reschedulePending = false;
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

/** The six ladders `decideCadenceAdvance` names, in one place. The referee picks the key; the day
 * counts stay here with the other cadence tables. */
export const CADENCE_LADDER_DAY_OFFSETS: Record<CadenceAdvanceLadder, readonly number[]> = {
  post_sale: POST_SALE_DAY_OFFSETS,
  engaged: ENGAGED_DAY_OFFSETS,
  finance_declined_long_term: FINANCE_DECLINED_DAY_OFFSETS,
  private_party_sell_long_term: PRIVATE_PARTY_SELL_DAY_OFFSETS,
  long_term: LONG_TERM_DAY_OFFSETS,
  standard: FOLLOW_UP_DAY_OFFSETS
};

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

// No-show follow-up timing (Joe-approved 2026-07-02: "a did-not-show + needs-follow-up should get
// its first touch in 1-2 business days, not a week out"). Next BUSINESS day at the standard
// morning send window — Fri/Sat outcomes land Monday (2 calendar days max), never a Sunday.
// Pinned by no_show_followup_timing:eval.
export function resolveNoShowFollowUpDueAt(nowIso: string, timeZone: string): string {
  const now = new Date(nowIso);
  const parts = getZonedParts(now, timeZone);
  const base = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  base.setUTCDate(base.getUTCDate() + 1);
  // getUTCDay on the local-date proxy: 0=Sun, 6=Sat → roll forward to Monday.
  while (base.getUTCDay() === 0 || base.getUTCDay() === 6) {
    base.setUTCDate(base.getUTCDate() + 1);
  }
  return localPartsToUtcDate(timeZone, {
    year: base.getUTCFullYear(),
    month: base.getUTCMonth() + 1,
    day: base.getUTCDate(),
    hour24: 10,
    minute: 30
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

/**
 * WHERE a post-sale sequence RESUMES when the cadence record is re-created long after the sale.
 *
 * The owner sequence is anchored to `sale.soldAt`, not to "now". The two sold -> post_sale
 * reconciles in the cadence maintenance tick rebuild the record at `stepIndex: 0` from that
 * anchor, and `computePostSaleDueAt` never returns a past date — it rolls an elapsed offset
 * forward day by day until it is in the future. So a day-1 touch whose date went by two months
 * ago does not get skipped: it comes due TODAY and the tick sends it on the same pass.
 *
 * THE PRODUCTION SEND. Ken Hardy (+17166795683) bought a 2025 Tri Glide Ultra on 2026-06-15 and
 * got the day-1 note on 2026-06-16. His cadence record was rebuilt on 2026-08-12 and he received
 * the SAME TEXT, WORD FOR WORD, 57 days after the sale — "Thanks again for coming to see us for
 * your Tri Glide Ultra." The rebuilt record still says `deliveredTouches: 1`, because the object
 * was new and had no memory of the first send. That is the release gate's `repeats` failure for
 * 2026-08-13.
 *
 * THE RULE. Resume at the first offset the customer has NOT already lived through, measured in
 * days elapsed since the anchor — never at step 0 on an old sale. Ken: 57 days elapsed, offsets
 * [1, 60, 365, 690], so the answer is step 1 due at day 60 (2026-08-14) — exactly the state his
 * cadence would have held had it never been rebuilt. A sale that closed today is unchanged:
 * 0 days elapsed, offset 1 is still ahead, step 0 due tomorrow.
 *
 * Returns null when the whole sequence has elapsed (a sale older than the last offset) — there is
 * no touch left to schedule, and inventing one is the same defect a step later.
 *
 * FAIL DIRECTION: safe. Every outcome here is the same touch or FEWER touches than today, never
 * an earlier one — this can only remove a send, never add one. Same rule the finance-declined
 * heal already applies a few lines below its own re-anchor ("never PULL a touch earlier than what
 * was already scheduled"); this is that rule for the post-sale ladder.
 */
export function resolvePostSaleResumeStep(
  anchorAtIso: string,
  nowMs: number,
  timeZone: string
): { stepIndex: number; nextDueAt: string } | null {
  const anchorMs = Date.parse(String(anchorAtIso ?? ""));
  if (!Number.isFinite(anchorMs) || !Number.isFinite(nowMs)) return null;
  const elapsedDays = Math.floor((nowMs - anchorMs) / 86_400_000);
  for (let i = 0; i < POST_SALE_DAY_OFFSETS.length; i += 1) {
    if (POST_SALE_DAY_OFFSETS[i] > elapsedDays) {
      return {
        stepIndex: i,
        nextDueAt: computePostSaleDueAt(anchorAtIso, POST_SALE_DAY_OFFSETS[i], timeZone)
      };
    }
  }
  return null;
}

/**
 * The post-sale cadence record the two sold -> post_sale reconciles in the maintenance tick
 * write. Both used to inline the same literal at `stepIndex: 0`; the position now comes from
 * `resolvePostSaleResumeStep`, so neither can replay a touch the customer already received.
 * Returns null when the sequence has fully elapsed — the caller decides what to do with a sold
 * lead that has no owner touch left. `withScheduleFields` mirrors the one difference the two
 * call sites always had (the first seeds the schedule-invite counters, the second does not).
 */
export function buildPostSaleReconcileCadence(
  anchorAtIso: string,
  nowMs: number,
  timeZone: string,
  withScheduleFields: boolean
): Conversation["followUpCadence"] | null {
  const resume = resolvePostSaleResumeStep(anchorAtIso, nowMs, timeZone);
  if (!resume) return null;
  return {
    status: "active",
    anchorAt: anchorAtIso,
    nextDueAt: resume.nextDueAt,
    stepIndex: resume.stepIndex,
    kind: "post_sale",
    ...(withScheduleFields ? { scheduleInviteCount: 0, scheduleMuted: false } : {})
  } as Conversation["followUpCadence"];
}

export function startFollowUpCadence(
  conv: Conversation,
  anchorAtIso: string,
  timeZone: string,
  opts?: { kind?: "standard" | "long_term" }
) {
  const decision = decideCadenceStart({
    lane: "standard_ramp",
    conversationStatus: conv.status,
    existing: conv.followUpCadence,
    followUpReason: conv.followUp?.reason
  });
  if (!decision.start) return;
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
    scheduleInviteCount: decision.scheduleInviteCount,
    scheduleMuted: decision.scheduleMuted
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
  leadSource?: string | null;
}): "standard" | "long_term" | "suppress" {
  const label = String(input.purchaseTimeframe ?? "").toLowerCase();
  if (label.includes("not interested")) return "suppress";
  // Riding Academy ENROLLMENT (Joe, 2026-08-05): a course REGISTRATION is not a bike shopper.
  // Donald Rawson (+17165344986) enrolled with "Future Motorcycle Purchase Expectation: No" and
  // his timeframe field ("No") matched none of the branches below, so he landed on the aggressive
  // day-1 sales ramp — right behind an opener promising help with his COURSE. Cap this lane at the
  // gentle nurture. Placed AFTER the suppress branch so an explicit non-buyer still wins with the
  // quieter answer; fail direction is strictly FEWER touches than today.
  if (/riding academy/i.test(String(input.leadSource ?? ""))) return "long_term";
  if (label.includes("year")) return "long_term";
  const monthsStart = Number(input.purchaseTimeframeMonthsStart);
  // 4+ months out is NOT a hot buyer — soft-invite in the opener, then the gentle long_term
  // nurture, never the aggressive day-1 ramp (Joe, 2026-06-16; was >= 7). Only 0-3mo (and
  // unsure/unparseable) stay on standard; 0-3mo also gets the owner call task.
  if (Number.isFinite(monthsStart) && monthsStart >= 4) return "long_term";
  return "standard";
}

// A lead whose STRUCTURED purchase timeframe is 4+ months (or years) out is not a near-term buyer —
// even once they ENGAGE (test ride / visit / reply), their own stated timeline should keep the
// proactive cadence at the gentle long_term tempo ([30,90,180]) rather than being bumped to the
// aggressive "engaged" ramp (the 13-step [1,2,3,5,7,...] schedule). Joe, 2026-07-16: Zachary
// (+17169013675) said 4-6 months, test-rode a Low Rider S, then got the full engaged-buyer press.
// Structured-field check (lead timeframe), NOT comprehension. Fail direction is SAFE: it only ever
// REDUCES / defers proactive touches. Reuses resolveInitialAdfCadencePlan's long_term branch so the
// timeframe→tempo boundary has ONE source of truth. ("not interested" resolves to suppress, not
// long_term, so it returns false here and stays on its own paused_indefinite path.)
export function cadenceTempoCappedToLongTerm(
  lead?: {
    purchaseTimeframe?: string | null;
    purchaseTimeframeMonthsStart?: number | null;
    source?: string | null;
  } | null
): boolean {
  return (
    resolveInitialAdfCadencePlan({
      purchaseTimeframe: lead?.purchaseTimeframe,
      purchaseTimeframeMonthsStart: lead?.purchaseTimeframeMonthsStart,
      leadSource: lead?.source
    }) === "long_term"
  );
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
    purchaseTimeframeMonthsStart: conv.lead?.purchaseTimeframeMonthsStart,
    leadSource: conv.lead?.source
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
  // A credit-DECLINED lead's long_term ladder is not a mis-deferral — it is Joe's 2026-08-01 "5 yes
  // long term" ruling, applied every cadence tick by the finance-declined heal (index.ts, via
  // decideFinanceDeclinedCadence). Without this the two heals fought each other forever: this one
  // rewrote kind long_term -> standard, the finance heal put it straight back, ~every 60s. MEASURED
  // 2026-08-15: 16,004 "[state-reconcile] re-aligned 7 mis-deferred long_term cadence(s)" lines, the
  // same 7 leads, all 7 finance-declined, none of them ever actually healed — plus a receding horizon
  // on Nicole Branch +17167152873, whose nextDueAt was rewritten to now+24h every minute so her next
  // touch could never come due. Ask the referee that owns this ladder rather than re-deriving it
  // (AGENTS.md: contended fields get one referee, not another inline writer).
  if (
    decideFinanceDeclinedCadence({
      followUpReason: conv.followUp?.reason,
      financeOutcomeStatus: (conv as any).financeOutcome?.status,
      appointmentOutcomeStatus: conv.appointment?.staffNotify?.outcome?.status,
      appointmentOutcomeSecondaryStatus: conv.appointment?.staffNotify?.outcome?.secondaryStatus,
      cadenceKind: cad.kind,
      cadenceStatus: cad.status
    }).isFinanceDeclined
  ) {
    return false;
  }
  const plan = resolveInitialAdfCadencePlan({
    purchaseTimeframe: conv.lead?.purchaseTimeframe,
    purchaseTimeframeMonthsStart: conv.lead?.purchaseTimeframeMonthsStart,
    leadSource: conv.lead?.source
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

/**
 * Heal a follow-up ladder that was BURNED ahead of the calendar — the residue of the pre-86e3ec79
 * bug where every staff manual send consumed a ladder step (Dennis Daffron +16303628805: ten texts
 * on day one marched stepIndex 0 -> 9 of 13, parking his next touch on Sept 5). That fix stopped
 * new damage; it could not repair records already burned, and a burned ladder looks perfectly
 * healthy — it is just pointing at a rung the calendar has not earned.
 *
 * The JUDGEMENT lives in decideBurnedCadenceLadderRealign (routeStateReducer) — followUpCadence is
 * a contended field and gets one referee, not another inline writer. This function only applies
 * the verdict: clamp the step back onto the earned rung and recompute nextDueAt from the anchor,
 * exactly as resumeFollowUpCadence does.
 *
 * Sends nothing. The lead simply rejoins its normal schedule, where the cadence value gate and the
 * no-repeat guards still decide whether that touch has anything worth saying. Idempotent.
 */
export function realignBurnedCadenceLadder(
  conv: Conversation,
  timeZone: string,
  now: Date = new Date()
): boolean {
  const cad = conv?.followUpCadence;
  if (!cad) return false;
  const anchorMs = Date.parse(String(cad.anchorAt ?? ""));
  const pausedUntilMs = Date.parse(String(cad.pausedUntil ?? ""));
  const decision = decideBurnedCadenceLadderRealign({
    status: cad.status,
    kind: cad.kind,
    stepIndex: cad.stepIndex,
    ageDays: Number.isFinite(anchorMs) ? Math.floor((now.getTime() - anchorMs) / 86_400_000) : null,
    ladderOffsets: FOLLOW_UP_DAY_OFFSETS,
    conversationClosed: !!(conv.closedAt || conv.closedReason || (conv as any).sale?.soldAt),
    pausedInFuture: Number.isFinite(pausedUntilMs) && pausedUntilMs > now.getTime()
  });
  if (!decision.realign || decision.stepIndex === undefined) return false;
  cad.stepIndex = decision.stepIndex;
  cad.nextDueAt = computeFollowUpDueAt(
    String(cad.anchorAt),
    FOLLOW_UP_DAY_OFFSETS[Math.min(decision.stepIndex, FOLLOW_UP_DAY_OFFSETS.length - 1)],
    timeZone
  );
  conv.updatedAt = nowIso();
  scheduleSave();
  return true;
}

// Mirror of realignMisdeferredLongTermCadence in the OTHER direction: heal a lead that got bumped to
// the aggressive "engaged" tempo even though its STRUCTURED purchase timeframe is 4+ months (or years)
// out — the generic engagement bump (index.ts cadence tick) upgrades kind -> "engaged" on any inbound /
// agent context, ignoring the customer's own stated timeline (Joe, 2026-07-16: Zachary +17169013675,
// "4-6 Months", got test-ride + promo + event press). A straight kind="long_term" swap is unsafe mid-
// flight because ENGAGED walks the 13-step array and LONG_TERM only has 3 offsets, so we RE-ANCHOR to a
// fresh long_term nurture at stepIndex 0 (next touch ~30 days out). Tight gate + fail-direction safe: it
// only ever pushes the next proactive touch LATER / reduces touches. Returns true if it re-anchored.
export function realignOverEagerEngagedCadence(
  conv: Conversation,
  timeZone: string,
  now: Date = new Date()
): boolean {
  // The admission test now lives in `decideCadenceReplacement` alongside the three lanes that do
  // NOT test the running chase — that contrast is the point (divergence 1).
  const decision = applyCadenceReplacement(conv, {
    trigger: "over_eager_engaged_realign",
    anchorAtIso: now.toISOString(),
    timeZone,
    realign: {
      // Only when the lead's OWN stated timeframe caps them to long_term — respect a real
      // near-term engaged buyer (0-3mo / unknown), only downshift the explicitly-far-out ones.
      tempoCappedToLongTerm: cadenceTempoCappedToLongTerm(conv.lead),
      conversationClosed: Boolean(conv.closedAt || conv.closedReason || (conv as any).sale?.soldAt),
      appointmentBooked: Boolean(conv.appointment?.bookedEventId),
      hasInventoryWatch: Boolean(conv.inventoryWatch)
    }
  });
  if (!decision.replace) return false;
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
  const decision = decideCadenceStart({
    lane: "post_sale",
    conversationStatus: conv.status,
    existing: conv.followUpCadence,
    sold: conv.closedReason === "sold" || Boolean(conv.sale?.soldAt)
  });
  if (!decision.start) return;
  const nextDueAt = computePostSaleDueAt(anchorAtIso, POST_SALE_DAY_OFFSETS[0], timeZone);
  conv.followUpCadence = {
    status: "active",
    anchorAt: anchorAtIso,
    nextDueAt,
    stepIndex: 0,
    kind: "post_sale",
    scheduleInviteCount: decision.scheduleInviteCount,
    scheduleMuted: decision.scheduleMuted
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
  const decision = decideCadenceStart({
    lane: "deferred_long_term",
    conversationStatus: conv.status,
    existing: conv.followUpCadence,
    followUpReason: conv.followUp?.reason
  });
  if (!decision.start) return;
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
    scheduleInviteCount: decision.scheduleInviteCount,
    scheduleMuted: decision.scheduleMuted
  };
  conv.updatedAt = nowIso();
  scheduleSave();
}

// The ONE place that rebuilds a lead's follow-up cadence when STAFF's own outreach turns the chase
// back on (quote delivered, credit-app needs info, the manual-context prompt). Three sites used to
// hand-build this object; they now all ask `decideManualCadenceRestart` whether the lead keeps its
// place in the sequence — see that referee in routeStateReducer.ts for the two divergences it
// preserves and why the safe default is to start over.
//
// Deliberately does NOT touch conv.updatedAt or call scheduleSave(): every caller sits inside a
// larger handler that owns the save, and adding one here would change write timing.
export function applyManualCadenceRestart(
  conv: Conversation,
  input: {
    context: ManualCadenceRestartContext;
    kind: "standard" | "engaged";
    nowIso: string;
    timeZone: string;
  }
): ManualCadenceRestartDecision {
  const existing = conv.followUpCadence ?? null;
  const decision = decideManualCadenceRestart({
    context: input.context,
    existing,
    nowIso: input.nowIso
  });
  const carried = decision.carryExistingRecord ? existing : null;
  conv.followUpCadence = {
    ...((carried ?? {}) as Partial<FollowUpCadence>),
    status: "active",
    anchorAt: decision.anchorAt,
    nextDueAt:
      decision.keepNextDueAt ??
      computeFollowUpDueAt(decision.anchorAt, FOLLOW_UP_DAY_OFFSETS[0], input.timeZone),
    stepIndex: decision.stepIndex,
    kind: input.kind,
    contextTag: input.context,
    contextTagUpdatedAt: input.nowIso,
    pausedUntil: undefined,
    pauseReason: undefined,
    stopReason: undefined,
    scheduleInviteCount: decision.scheduleInviteCount,
    scheduleMuted: decision.scheduleMuted
  } as FollowUpCadence;
  return decision;
}

// The ONE place that moves the chase between active, paused and stopped. Four callers used to do it
// on their own preconditions — this verb, `pauseFollowUpCadence`, `resumeFollowUpCadence` and the
// inline stop inside `closeConversation`. See `decideCadenceLifecycle` for the three preserved
// divergences (who protects a post-sale chase, and who clears the pause fields) and the fail
// direction. Writes the status + flag fields only; dates and offsets stay with the caller.
export function applyCadenceLifecycle(
  conv: Conversation,
  input: { verb: CadenceLifecycleVerb | string; reason?: string | null; stopReason?: string | null }
): CadenceLifecycleDecision {
  const cad = conv?.followUpCadence;
  const decision = decideCadenceLifecycle({
    verb: input.verb,
    hasRecord: !!cad,
    status: cad?.status ?? null,
    kind: cad?.kind ?? null,
    reason: input.reason ?? null
  });
  if (!cad || !decision.apply) return decision;
  if (decision.nextStatus) cad.status = decision.nextStatus;
  if (input.verb === "stop" || input.verb === "close") cad.stopReason = input.stopReason ?? undefined;
  if (decision.clearStopReason) cad.stopReason = undefined;
  if (decision.clearNextDue) cad.nextDueAt = undefined;
  if (decision.clearPause) {
    cad.pausedUntil = undefined;
    cad.pauseReason = undefined;
  }
  return decision;
}

export function stopFollowUpCadence(conv: Conversation, reason: string) {
  const decision = applyCadenceLifecycle(conv, { verb: "stop", reason, stopReason: reason });
  if (!decision.apply) return;
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
  if (!applyCadenceLifecycle(conv, { verb: "resume" }).apply || !cad) return;
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
  conv.updatedAt = nowIso();
  scheduleSave();
}

export function pauseFollowUpCadence(conv: Conversation, untilIso: string, reason?: string) {
  if (!applyCadenceLifecycle(conv, { verb: "pause", reason }).apply || !conv.followUpCadence) return;
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

// The ONE place that hushes the proactive cadence after the agent has just reached out — the four
// former copies (three inventory-watch alert sites + the soft-visit window) now ask
// `decideCadenceQuietWindow` instead of each deciding for themselves. See that referee in
// routeStateReducer.ts for the two divergences it preserves and why.
//
// `quietUntilIso` is supplied by the caller (watch alerts hold ~7 days; a soft visit holds until
// the day-before reminder), which keeps the decision itself clock-free and comparable.
//
// Deliberately does NOT touch `conv.updatedAt` or call `scheduleSave()` on the quiet path: every
// call site already stamps + saves around this, and startFollowUpCadence does its own. Adding
// another write here would change persisted timestamps, which a cleanup must not do.
export function applyCadenceQuietWindow(
  conv: Conversation,
  input: {
    trigger: CadenceQuietTrigger;
    quietUntilIso: string;
    anchorAtIso: string;
    timeZone: string;
    reason?: string | null;
  }
): void {
  const decision = decideCadenceQuietWindow({
    trigger: input.trigger,
    cadenceStatus: conv.followUpCadence?.status ?? null,
    followUpMode: conv.followUp?.mode ?? null,
    reason: input.reason
  });
  if (decision.restartCadence) {
    if (decision.clearStoppedCadenceFirst) conv.followUpCadence = undefined;
    startFollowUpCadence(conv, input.anchorAtIso, input.timeZone);
  }
  if (!decision.quiet) return;
  // Only ever quiets a cadence that is genuinely running — never resurrects a closed/absent one.
  if (conv.followUpCadence?.status !== "active") return;
  conv.followUpCadence.pausedUntil = input.quietUntilIso;
  conv.followUpCadence.pauseReason = decision.reason;
  conv.followUpCadence.nextDueAt = input.quietUntilIso;
  if (decision.resetScheduleInvites) {
    conv.followUpCadence.scheduleInviteCount = 0;
    conv.followUpCadence.scheduleMuted = false;
  }
}

// The ONE place a re-engagement trigger throws away a dead chase and starts a new one — the four
// former copies (health-recovery delay, customer "take your time" deferral, finance no-contact
// voicemail, walk-in hold-clear) now ask `decideCadenceRevival` instead of each deciding for
// themselves. See that referee in routeStateReducer.ts for the two divergences it preserves.
//
// `anchorAtIso` is supplied by the caller so the decision itself stays clock-free and comparable.
//
// Deliberately does NOT stamp `conv.updatedAt` or call `scheduleSave()`: `startFollowUpCadence`
// does both on the path that lays a new cadence, and every call site already stamps + saves around
// this. Adding another write here would change persisted timestamps, which a cleanup must not do.
export function applyCadenceRevival(
  conv: Conversation,
  input: {
    trigger: CadenceRevivalTrigger;
    anchorAtIso: string;
    timeZone: string;
    /**
     * Deferral lane only: re-tag whichever cadence survives as an `engaged` chase carrying this
     * context. Stamped with `anchorAtIso`, which is the same clock read that site used inline.
     */
    engagedContextTag?: string | null;
  }
): void {
  const decision = decideCadenceRevival({
    trigger: input.trigger,
    hasCadence: Boolean(conv.followUpCadence),
    cadenceStatus: conv.followUpCadence?.status ?? null
  });
  if (decision.replaceDeadCadence) conv.followUpCadence = undefined;
  if (decision.startFresh) {
    // May still refuse (closed thread, non-sales lead) — that is decideCadenceStart's call, not
    // ours, and a refusal leaves the lead with no cadence exactly as it does today.
    startFollowUpCadence(conv, input.anchorAtIso, input.timeZone);
  } else if (decision.reactivateInPlace && conv.followUpCadence) {
    conv.followUpCadence.status = "active";
    conv.followUpCadence.pausedUntil = undefined;
    conv.followUpCadence.pauseReason = undefined;
  }
  if (input.engagedContextTag && conv.followUpCadence) {
    conv.followUpCadence.kind = "engaged";
    conv.followUpCadence.contextTag = input.engagedContextTag;
    conv.followUpCadence.contextTagUpdatedAt = input.anchorAtIso;
  }
}

// The ONE place a trigger throws away the chase already running and mints a whole new one — the
// four former copies (finance declined, the licence/credit-pending staff note, the manual-outbound
// seller-photo request, and the over-eager-engaged healer) now ask `decideCadenceReplacement`
// instead of each hand-building the record. See that referee in routeStateReducer.ts for the three
// divergences it preserves, and for why these four never go through `startFollowUpCadence`.
//
// The record's key ORDER matches what each site wrote inline, so the persisted JSON is unchanged.
//
// Deliberately does NOT stamp `conv.updatedAt` or call `scheduleSave()` — three of the four call
// sites already save around this, and the healer stamps for itself on a true return. Adding a
// write here would change persisted timestamps, which a cleanup must not do.
export function applyCadenceReplacement(
  conv: Conversation,
  input: {
    trigger: CadenceReplacementTrigger;
    /** Clock read for the `now` lanes; also the `contextTagUpdatedAt` stamp. */
    anchorAtIso: string;
    timeZone: string;
    /** `license_credit_pending` only: the caller's own precomputed due date (the `due` anchor). */
    dueAtIso?: string | null;
    /** The tag the two engaged lanes carry. Ignored by the lanes that write no tag. */
    contextTag?: string | null;
    /** Realign lane only — see the referee's input docs. */
    realign?: {
      tempoCappedToLongTerm: boolean;
      conversationClosed: boolean;
      appointmentBooked: boolean;
      hasInventoryWatch: boolean;
    };
  }
): CadenceReplacementDecision {
  const decision = decideCadenceReplacement({
    trigger: input.trigger,
    existing: conv.followUpCadence
      ? { status: conv.followUpCadence.status, kind: conv.followUpCadence.kind }
      : null,
    tempoCappedToLongTerm: input.realign?.tempoCappedToLongTerm,
    conversationClosed: input.realign?.conversationClosed,
    appointmentBooked: input.realign?.appointmentBooked,
    followUpMode: conv.followUp?.mode ?? null,
    followUpReason: conv.followUp?.reason ?? null,
    hasInventoryWatch: input.realign?.hasInventoryWatch
  });
  if (!decision.replace) return decision;

  const offsets =
    decision.ladder === "finance_declined"
      ? FINANCE_DECLINED_DAY_OFFSETS
      : decision.ladder === "long_term"
        ? LONG_TERM_DAY_OFFSETS
        : FOLLOW_UP_DAY_OFFSETS;
  const anchorAt = decision.anchor === "due" ? String(input.dueAtIso ?? input.anchorAtIso) : input.anchorAtIso;
  const nextDueAt =
    decision.anchor === "due" ? anchorAt : computeFollowUpDueAt(anchorAt, offsets[0], input.timeZone);

  const record = {
    status: "active",
    anchorAt,
    nextDueAt,
    stepIndex: 0,
    kind: decision.kind
  } as NonNullable<Conversation["followUpCadence"]>;
  if (decision.writeContextTag) {
    record.contextTag = input.contextTag ?? undefined;
    record.contextTagUpdatedAt = input.anchorAtIso;
  }
  // Divergence 2: the finance lane leaves these two keys off the record entirely.
  if (decision.writeInviteBudget) {
    record.scheduleInviteCount = 0;
    record.scheduleMuted = false;
  }
  conv.followUpCadence = record;
  return decision;
}

// The ONE place a recorded sale closes the thread and settles the lead's unit hold — the two
// former copies (the appointment-outcome path and the console's sold button, both in index.ts) now
// ask `decideSoldCloseout` instead of each carrying the same five-line hold-match condition. See
// that referee in routeStateReducer.ts for the divergence it preserves.
//
// ORDERING NOTE. In both originals the hold release sat ~10 lines further down, after the two
// inventory-store awaits (`setInventorySold`, `clearInventoryHoldRefs`). It runs here instead,
// which is inert: neither await reads `conv.hold` — `clearInventoryHoldRefs` is handed the
// previous hold key explicitly, captured before either path touches anything — and the caller
// resolves `holdMatchesSoldUnit` against the stored hold before calling in.
//
// Deliberately does NOT stamp `conv.updatedAt` or save: the outcome path's caller saves, and the
// endpoint saves inline right after. Adding a write here would change persisted timestamps, which
// a cleanup must not do.
export function applySoldCloseout(
  conv: Conversation,
  input: {
    nowIso: string;
    /** The sale record to stamp, built by the caller (the two paths carry different fields). */
    sale: NonNullable<Conversation["sale"]>;
    /** Normalized key of the sold unit; blank/absent = staff named no unit. */
    soldKey?: string | null;
    /** Whether the lead's stored hold matches the sold unit — see the referee's input docs. */
    holdMatchesSoldUnit: boolean;
  }
): SoldCloseoutDecision {
  const decision = decideSoldCloseout({
    hasSoldUnit: Boolean(input.soldKey),
    hold: conv.hold ?? null,
    soldKey: input.soldKey,
    holdMatchesSoldUnit: input.holdMatchesSoldUnit
  });
  conv.sale = input.sale;
  if (decision.closeConversation) {
    conv.status = "closed";
    conv.closedAt = input.nowIso;
    conv.closedReason = decision.closedReason;
  }
  if (decision.releaseHold) conv.hold = undefined;
  return decision;
}

/**
 * A sold signal that names NO unit (a walk-in "delivered" note, a staff sold outcome from a panel
 * with no picker): stamp the sale through the sold-closeout referee's unit-less arm so the deal
 * counts as WON (pipelineFunnel + decideCloseoutReversal both read closedReason/sale.soldAt)
 * without inventing a bike — falling back to lead.vehicle is the #470 wrong-bike trap (the
 * customer inquired on one bike and bought another). Never overwrites an already-recorded sale;
 * a later Update Lead > Sold with a real unit overwrites the stub.
 */
export function applyUnitLessSoldSaleStub(
  conv: Conversation,
  input: { nowIso: string; provenanceNote?: string }
): SoldCloseoutDecision | null {
  if (conv.sale?.soldAt) return null;
  const provenanceNote =
    input.provenanceNote ??
    "Recorded from a sold outcome with no unit named — pick the bike via Update Lead > Sold.";
  return applySoldCloseout(conv, {
    nowIso: input.nowIso,
    sale: {
      ...conv.sale,
      soldAt: input.nowIso,
      note: [String(conv.sale?.note ?? "").trim(), provenanceNote].filter(Boolean).join(" | ")
    },
    soldKey: null,
    holdMatchesSoldUnit: false
  });
}

/**
 * The CRM & Calendar Updates panel's outcome -> follow-up-action mapping (lifted out of the
 * /questions/:convId/:questionId/done endpoint so the policy is evaluable and index.ts shrinks).
 * "sold" maps to archive_sold — the bare "archive" it used to get recorded NO sale, so the
 * pipeline funnel scored a delivered bike as LOST.
 */
export function deriveAttendanceOutcomeAction(
  outcome?: string | null,
  followUpAction?: string | null
): string | undefined {
  if (followUpAction) return followUpAction;
  if (!outcome) return undefined;
  if (outcome === "sold") return "archive_sold";
  if (outcome === "hold") return "pause_indef";
  if (outcome === "undecided") return "resume";
  // Joe-approved 2026-07-02: a no-show re-engages the NEXT BUSINESS DAY (1-2 days), not 72h flat.
  if (outcome === "no_show") return "pause_next_business_day";
  return undefined;
}

/**
 * Wipes the staff-prompt bookkeeping off an appointment (the "we already texted the rep" markers
 * and the outcome-reply token). Lifted out of index.ts with the teardown un-stacking so the field
 * set and its referee live together, and so an eval can exercise the real code rather than a copy.
 */
export function clearAppointmentStaffPromptState(appt: any): boolean {
  const notify = appt?.staffNotify;
  if (!notify || typeof notify !== "object") return false;
  let changed = false;
  for (const key of ["bookedSentAt", "followUpSentAt", "lastEventId", "outcomeToken"]) {
    if (Object.prototype.hasOwnProperty.call(notify, key)) {
      delete notify[key];
      changed = true;
    }
  }
  return changed;
}

// The ONE place that un-books an appointment — the five former teardown sites (customer cancel,
// calendar reconcile, staff console cancel/no-show, and both manual-outbound booking-failure
// branches) each hand-maintained their own field list, and the lists had drifted apart. They now
// ask `decideAppointmentTeardown` instead. See that referee in routeStateReducer.ts for the
// divergence it preserves and the fail direction.
//
// Deliberately does NOT stamp `updatedAt`, close/open todos, cancel the Google event or touch
// dialog state: those differ by cause, every call site already does its own, and adding a write
// here would change persisted timestamps — which a cleanup must not do.
export function applyAppointmentTeardown(
  appt: any,
  input: { cause: AppointmentTeardownCause; reschedulePendingOverride?: boolean | null }
): ReturnType<typeof decideAppointmentTeardown> {
  const decision = decideAppointmentTeardown(input);
  if (!appt) return decision;
  appt.status = decision.status;
  if (decision.clearBookedEvent) {
    appt.whenIso = null;
    appt.bookedEventId = null;
    appt.bookedEventLink = null;
    appt.bookedSalespersonId = null;
    appt.bookedSalespersonName = null;
    appt.bookedCalendarId = null;
  }
  if (decision.clearRequestedTime) {
    appt.whenText = undefined;
    appt.confirmedBy = undefined;
  }
  if (decision.clearMatchedSlot) appt.matchedSlot = undefined;
  appt.reschedulePending = decision.reschedulePending;
  if (decision.clearStaffPromptState) clearAppointmentStaffPromptState(appt);
  return decision;
}

// Wiping the dead half of an EXPIRED booking that a new time is about to replace. Sibling of
// applyAppointmentTeardown, and deliberately NOT the same call: a teardown un-books the appointment
// (status "none", the time cleared, reschedule pending); this one keeps the appointment alive and
// only drops the calendar identity, because the caller overwrites whenIso/whenText on the next line
// and `applyAppointmentConfirmRecord` owns the status.
// The watch blank-filling ladder, applied. Four lanes fill a half-specified watch from what we
// already know, and each hand-wrote the ladder before this — see `resolveInventoryWatchDefaults` for
// the rungs, the fail direction, and the ONE preserved divergence between the lanes.
export function applyInventoryWatchDefaults(
  watch: any,
  input: Omit<InventoryWatchDefaultsInput, "watchMake" | "watchTrim" | "watchCondition">
): ReturnType<typeof resolveInventoryWatchDefaults> {
  const decision = resolveInventoryWatchDefaults({
    watchMake: watch?.make ?? null,
    watchTrim: watch?.trim ?? null,
    watchCondition: watch?.condition ?? null,
    ...input
  });
  if (!watch) return decision;
  if (decision.make !== undefined) watch.make = decision.make;
  if (decision.trim !== undefined) watch.trim = decision.trim;
  if (decision.condition !== undefined) watch.condition = decision.condition;
  return decision;
}

/**
 * PER-MESSAGE TRIPWIRE PASS (Joe's ruling 2026-08-14 evening — see domain/turnResponseTripwire.ts
 * for the decision and its taxonomy). Runs on the minute tick beside the other background passes.
 * For every open thread whose NEWEST row is an aged, unanswered SMS customer message with zero
 * response artifacts, mints ONE merged owner task and stamps a per-message receipt so a message
 * can never fire twice. Heal only — never a send, never a close; the loop's daily sweeps read the
 * route outcome the caller records to find the CLASS behind repeated fires.
 */
export async function processTurnResponseTripwire(deps: {
  isSuppressed: (phone: string) => boolean;
  recordOutcome: (detail: { convId: string; leadKey?: string | null; messageId: string; ageMinutes: number; taskCreated: boolean }) => void;
  nowMs?: number;
  minAgeMs?: number;
  maxAgeMs?: number;
}): Promise<{ scanned: number; fired: number }> {
  const { decideTurnResponseTripwire, hasResponseArtifactSince } = await import("./turnResponseTripwire.js");
  const nowMs = deps.nowMs ?? Date.now();
  let fired = 0;
  let dirty = false;
  const all = getAllConversations();
  for (const conv of all) {
    const msgs = Array.isArray(conv?.messages) ? conv.messages : [];
    const last = msgs.length ? msgs[msgs.length - 1] : null;
    if (!last || last.direction !== "in") continue;
    const inboundAtMs = Date.parse(String(last.at ?? ""));
    const phone = String(conv.leadKey ?? conv.lead?.phone ?? "");
    const watchesArr = Array.isArray(conv.inventoryWatches)
      ? conv.inventoryWatches
      : conv.inventoryWatch
        ? [conv.inventoryWatch]
        : [];
    const decision = decideTurnResponseTripwire({
      nowMs,
      conversationStatus: conv.status ?? null,
      mode: conv.mode ?? null,
      suppressed: !!phone && deps.isSuppressed(phone),
      lastMessage: last as any,
      hasResponseArtifact: Number.isFinite(inboundAtMs)
        ? hasResponseArtifactSince({
            inboundAtMs,
            // The inbound is the NEWEST message row, so any out-row artifact would already have
            // made it not-last; drafts and sends land as rows AFTER the inbound when they exist.
            messagesAfter: [],
            todos: todos.filter(t => t.convId === conv.id) as any[],
            watches: watchesArr as any[]
          })
        : true,
      alreadyFiredForMessageId: (conv as any).turnTripwire?.messageId ?? null,
      minAgeMs: deps.minAgeMs,
      maxAgeMs: deps.maxAgeMs
    });
    if (!decision.fire) continue;
    const customerName = String(conv.lead?.firstName ?? conv.lead?.name ?? "the customer").trim() || "the customer";
    const task = addTodo(
      conv,
      "call",
      `Nothing responded to ${customerName}'s message ${decision.ageMinutes} min ago: "${decision.excerpt}" — needs a reply (tripwire).`,
      decision.messageId,
      conv.leadOwner,
      undefined,
      "followup"
    );
    (conv as any).turnTripwire = { messageId: decision.messageId, firedAt: new Date(nowMs).toISOString() };
    deps.recordOutcome({
      convId: conv.id,
      leadKey: conv.leadKey ?? null,
      messageId: decision.messageId,
      ageMinutes: decision.ageMinutes,
      taskCreated: !!task
    });
    saveConversation(conv);
    fired += 1;
    dirty = true;
  }
  if (dirty) await flushConversationStore();
  return { scanned: all.length, fired };
}

/** Watch condition normalizer (moved from index.ts 2026-08-14 — the notify-promise applier below
 *  needs it here, and index re-imports it). Deterministic structured extraction, not comprehension. */
export function normalizeWatchCondition(raw?: string | null): "new" | "used" | undefined {
  const t = String(raw ?? "").toLowerCase().trim();
  if (!t) return undefined;
  if (/(pre|used|pre-owned|preowned|owned)/.test(t)) return "used";
  if (/new/.test(t)) return "new";
  return undefined;
}

/** Condition family siblings of normalizeWatchCondition (moved with it from index.ts 2026-08-14). */
export function inferInventoryItemCondition(item: any): "new" | "used" | undefined {
  const explicit = normalizeWatchCondition(item?.condition);
  if (explicit) return explicit;
  const yearNum = Number(String(item?.year ?? ""));
  if (Number.isFinite(yearNum) && yearNum > 0) {
    const currentYear = new Date().getFullYear();
    return yearNum <= currentYear - 2 ? "used" : "new";
  }
  return undefined;
}

export function inventoryItemMatchesRequestedCondition(
  item: any,
  requestedCondition?: "new" | "used"
): boolean {
  if (!requestedCondition) return true;
  return inferInventoryItemCondition(item) === requestedCondition;
}

/**
 * Side-effect applier for a staff "we'll keep an eye out" promise (Joe's report 2026-08-12,
 * kunwarsahilnaseem@gmail.com — see domain/inventoryNotifyPromise.ts for the three stacked gates
 * that dropped it). The PLAN is decided by the pure resolveInventoryNotifyPromisePlan; this
 * function only executes it through the same referees every other watch lane uses
 * (applyInventoryWatchDefaults blank-filling, the caller's merge, applyInventoryWatchArm) or
 * mints the fallback dated task via addTodo. Returns what happened so the caller can record the
 * route outcome — it never logs or saves itself.
 */
export function applyInventoryNotifyPromiseOutcome(
  conv: Conversation,
  plan: import("./inventoryNotifyPromise.js").InventoryNotifyPromisePlan,
  args: {
    sourceMessageId?: string;
    semanticCondition?: string | null;
    /** The rep's outbound, lowercased — condition words referee input, not comprehension. */
    conditionText: string;
    mergeWatches: (
      existing: InventoryWatch[],
      incoming: InventoryWatch[]
    ) => { merged: InventoryWatch[]; added: InventoryWatch[] };
    setDialogState: (conv: any, name: any) => void;
  }
): { outcome: "watch_set" | "task" | "none"; model?: string | null; added?: number; taskCreated?: boolean; taskDueAt?: string | null } {
  if (plan.kind === "watch") {
    const watchSpec = plan.watch as unknown as InventoryWatch;
    applyInventoryWatchDefaults(watchSpec, {
      leadMake: conv.lead?.vehicle?.make ?? null,
      leadTrim: conv.lead?.vehicle?.trim ?? null,
      conditionFromText: normalizeWatchCondition(args.conditionText) ?? null,
      semanticCondition: (args.semanticCondition ?? null) as any,
      conditionFromLead: normalizeWatchCondition(conv.lead?.vehicle?.condition ?? null) ?? null
    });
    const existing = Array.isArray(conv.inventoryWatches)
      ? (conv.inventoryWatches as InventoryWatch[])
      : conv.inventoryWatch
        ? [conv.inventoryWatch as InventoryWatch]
        : [];
    const { merged, added } = args.mergeWatches(existing, [watchSpec]);
    if (added.length) {
      applyInventoryWatchArm(conv, { lane: "manual_outbound", watches: merged, setDialogState: args.setDialogState });
      return { outcome: "watch_set", model: watchSpec.model ?? null, added: added.length };
    }
    // Already covered by an existing watch — the promise IS tracked; nothing more to do.
    return { outcome: "none" };
  }
  const task = addTodo(conv, "other", plan.summary, args.sourceMessageId, undefined, { dueAt: plan.dueAtIso }, "reminder");
  return { outcome: "task", taskCreated: !!task, taskDueAt: plan.dueAtIso };
}

export function applyStaleBookingReplacement(
  appt: any,
  input: StaleBookingReplacementInput
): ReturnType<typeof decideStaleBookingReplacement> {
  const decision = decideStaleBookingReplacement(input);
  if (!appt) return decision;
  if (decision.clearBookedEvent) {
    appt.bookedEventId = null;
    appt.bookedEventLink = null;
    appt.bookedCalendarId = null;
  }
  if (decision.clearBookedSalesperson) {
    appt.bookedSalespersonId = null;
    appt.bookedSalespersonName = null;
  }
  if (decision.clearMatchedSlot) appt.matchedSlot = undefined;
  return decision;
}

// The ONE place that records a booking behind a real calendar write — the booking widget, the public
// booking link, the staff console, the manual-outbound send that books a texted time, and the staff
// calendar edit each hand-maintained their own copy of the same field list, and the lists had
// drifted. They now ask `decideAppointmentBookingRecord`; see that referee in routeStateReducer.ts
// for the four divergences it preserves and the fail direction.
//
// Deliberately does NOT set `bookedBy`, stop cadences, open/close todos or write the Google event:
// those are separate questions each call site already answers its own way (setAppointmentBookedBy /
// onAppointmentBooked), and pulling them in here would change behavior rather than centralize it.
export function applyAppointmentBookingRecord(
  conv: Conversation,
  input: {
    lane: AppointmentBookingLane | string;
    /** Absent only on a metadata-only calendar edit, where staff moved no hour. */
    whenText?: string | null;
    whenIso?: string | null;
    bookedEventId?: string | null;
    bookedEventLink?: string | null;
    bookedSalespersonId?: string | null;
    /** The two extra breadcrumbs only the exact-slot move arm carries. See divergence 8. */
    bookedSalespersonName?: string | null;
    bookedCalendarId?: string | null;
    matchedSlot?: NonNullable<Conversation["appointment"]>["matchedSlot"] | null;
  }
): AppointmentBookingRecordDecision {
  const decision = decideAppointmentBookingRecord({
    lane: input.lane,
    reschedulePending: conv?.appointment?.reschedulePending ?? null,
    hasMatchedSlot: !!input.matchedSlot,
    hasBookedTime: !!String(input.whenIso ?? "").trim()
  });
  if (!conv || !decision.record) return decision;
  conv.appointment = conv.appointment ?? { status: "none", updatedAt: nowIso() };
  const appt = conv.appointment;
  if (decision.stampStatus) appt.status = decision.status;
  if (decision.stampBookedTime) {
    appt.whenText = input.whenText as string;
    appt.whenIso = input.whenIso as string;
  }
  if (decision.stampConfirmedBy) appt.confirmedBy = decision.confirmedBy;
  appt.updatedAt = nowIso();
  if (decision.stampAcknowledged) appt.acknowledged = decision.acknowledged;
  if (decision.stampBookedEvent) {
    // A CREATE that came back empty must leave nothing stale behind; a MOVE writes through what the
    // caller resolved, which already falls back to the event it holds. See divergence 9.
    appt.bookedEventId = decision.clearMissingBookedEvent
      ? (input.bookedEventId ?? null)
      : (input.bookedEventId as string);
    appt.bookedEventLink = decision.clearMissingBookedEvent
      ? (input.bookedEventLink ?? null)
      : (input.bookedEventLink as string);
    appt.bookedSalespersonId = input.bookedSalespersonId ?? null;
  }
  if (decision.stampBookedSalespersonIdentity) {
    appt.bookedSalespersonName = input.bookedSalespersonName as string;
    appt.bookedCalendarId = input.bookedCalendarId as string;
  }
  if (decision.recordMatchedSlot && input.matchedSlot) appt.matchedSlot = input.matchedSlot;
  if (decision.clearReschedulePending) appt.reschedulePending = false;
  return decision;
}

// The ONE place that ARMS `appointment.reschedulePending` — the inverse of the two referees above,
// which own clearing it. Three call sites used to arm it inline on their own preconditions; they now
// ask `decideReschedulePendingLatch` (see that referee for the preserved divergence about whether an
// appointment record must already exist, and why the latch is a routing switch rather than a note).
//
// Deliberately does NOT touch cadence, todos or the staff-notify record: each caller answers those
// its own way, and pulling them in here would change behavior rather than centralize it.
export function applyReschedulePendingLatch(
  conv: Conversation,
  input: { lane: ReschedulePendingLatchLane | string }
): ReschedulePendingLatchDecision {
  const decision = decideReschedulePendingLatch({
    lane: input.lane,
    hasAppointmentRecord: !!conv?.appointment,
    reschedulePending: conv?.appointment?.reschedulePending ?? null
  });
  if (!conv || !decision.arm) return decision;
  if (!conv.appointment) {
    if (!decision.createRecordIfAbsent) return decision;
    conv.appointment = { status: "none", updatedAt: nowIso() };
  }
  conv.appointment.reschedulePending = true;
  conv.appointment.updatedAt = nowIso();
  return decision;
}

// The ONE place that SETTLES `appointment.reschedulePending` without a new booking — the other half
// of the latch. Three callers cleared it inline on three different preconditions; they now ask
// `decideReschedulePendingClear` (see that referee for the preserved `updatedAt` divergence, and for
// why none of the three may mint an appointment record just to write `false` onto it).
//
// Deliberately does NOT touch `scheduler.pendingSlot`, the cadence or the staff-notify record: each
// caller answers those its own way, and pulling them in here would change behavior, not centralize it.
export function applyReschedulePendingClear(
  conv: Conversation,
  input: { lane: ReschedulePendingClearLane | string }
): ReschedulePendingClearDecision {
  const decision = decideReschedulePendingClear({
    lane: input.lane,
    hasAppointmentRecord: !!conv?.appointment,
    reschedulePending: conv?.appointment?.reschedulePending ?? null
  });
  if (!conv?.appointment || !decision.clear) return decision;
  conv.appointment.reschedulePending = false;
  if (decision.stampUpdatedAt) conv.appointment.updatedAt = nowIso();
  return decision;
}

// The ONE place that reacts to "the inventory record that closed this lead is gone". Two callers
// answered it inline — the un-mark endpoint (two drifted arms, hold and sale) and the stale-hold
// sweep — writing `hold`/`sale`, `status` and `closedReason` on their own reading. See
// `decideInventoryAvailabilityReopen` for the two preserved divergences and the fail direction,
// which is the unusual one: here REOPENING is the safe answer, because the irreversible thing
// (closing a live lead against a bike) already happened.
export function applyInventoryAvailabilityReopen(
  conv: Conversation,
  input: { cause: InventoryAvailabilityReopenCause | string }
): InventoryAvailabilityReopenDecision {
  const decision = decideInventoryAvailabilityReopen({
    cause: input.cause,
    closedReason: conv?.closedReason ?? null,
    followUpReason: conv?.followUp?.reason ?? null,
    cadenceKind: conv?.followUpCadence?.kind ?? null
  });
  if (!conv || !decision.clearRecord) return decision;
  if (input.cause === "sale_reversed") conv.sale = undefined;
  else conv.hold = undefined;
  if (decision.reopen) {
    conv.status = "open";
    conv.closedAt = undefined;
    conv.closedReason = undefined;
  }
  if (decision.stopCadence) stopFollowUpCadence(conv, "inventory_marked_available");
  if (decision.resumeFollowUp) setFollowUpMode(conv, "active", "inventory_marked_available");
  return decision;
}

// The ONE place that un-does a closeout for a cause that is NOT an inventory record disappearing.
// Four callers answered it inline — the customer-inbound reopen (this file), the staff Reopen
// endpoint (index.ts) and the two walk-in hold notes (sendgridInbound.ts) — each writing `status`,
// `closedAt` and `closedReason` on its own reading. See `decideCloseoutReversal` for the two
// preserved divergences and the fail direction (REOPEN is the safe answer; the refusal arm is the
// conservative one). Writes only; the caller still owns `updatedAt` / saving.
export function applyCloseoutReversal(
  conv: Conversation,
  input: {
    cause: CloseoutReversalCause | string;
    /** CUSTOMER ARM ONLY: the inbound body and whether it carried media. */
    inboundBody?: string | null;
    inboundHasMedia?: boolean;
  }
): CloseoutReversalDecision {
  const isClosed = conv?.status === "closed";
  const customerArm = input.cause === "customer_inbound";
  // The bare-ack test is the customer arm's only non-stored input, and the referee ignores it for
  // every other cause — so it is only worth computing where it can matter.
  const bareAck =
    customerArm && isClosed
      ? !input.inboundHasMedia && isBareAckInboundText(input.inboundBody)
      : false;
  const decision = decideCloseoutReversal({
    cause: input.cause,
    isClosed,
    closedReason: conv?.closedReason ?? null,
    followUpReason: conv?.followUp?.reason ?? null,
    hasSoldSale: !!conv?.sale?.soldAt,
    hasHoldRecord: !!conv?.hold,
    bareAck,
    declineCloseoutReason: customerArm ? isDeclineCloseoutReason(conv?.closedReason ?? null) : false
  });
  if (!conv) return decision;
  if (decision.reopen) conv.status = "open";
  if (decision.clearCloseout) {
    conv.closedAt = undefined;
    conv.closedReason = undefined;
  }
  return decision;
}

// `resetScheduleInviteCounter` was DELETED here (2026-08-03). It set `scheduleInviteCount = 0` and
// `scheduleMuted = false`, and it had ZERO callers anywhere in the repo — one occurrence, its own
// definition. Not behavior, a dormant landmine: the next person needing "start asking this customer
// again" would have called it and silently bypassed the invite-budget arbitration below. The lanes
// that legitimately reset the budget (cadence replacement / revival) already write the pair through
// their own referees. Same class as the dead `updateAppointmentFromInbound` removed in #461.

// Recording that we just asked this customer to come in. Asks `decideScheduleInviteBudget` for the
// new count and whether the mute latches, so the threshold cannot drift from the one the follow-up
// composer uses to pick its message pool — those were two independent `3`s in two files before this.
export function registerScheduleInviteSent(conv: Conversation, threshold?: number) {
  if (!conv.followUpCadence) return;
  const decision = decideScheduleInviteBudget({
    inviteCount: conv.followUpCadence.scheduleInviteCount,
    threshold
  });
  conv.followUpCadence.scheduleInviteCount = decision.nextInviteCount;
  if (decision.mute) {
    conv.followUpCadence.scheduleMuted = true;
  }
  conv.updatedAt = nowIso();
  scheduleSave();
}

// All inventory watches on a conversation, unioning the legacy single `inventoryWatch` AND the newer
// `inventoryWatches` array (deduped). They are NOT mutually exclusive — a conv can carry an active single
// watch alongside a paused array, so "array-if-present-else-single" silently ignored the active single
// (the watch_active_on_closed leak the outcome auditor surfaced, 6/25). One source of truth so the heal,
// the close guard, and the detector all enumerate watches the same way.
export function collectInventoryWatches(conv: any): InventoryWatch[] {
  const arr: InventoryWatch[] = Array.isArray(conv?.inventoryWatches) ? conv.inventoryWatches : [];
  const single: InventoryWatch | undefined = conv?.inventoryWatch ?? undefined;
  return single && !arr.includes(single) ? [...arr, single] : arr;
}

// Does this conversation have at least one ACTIVE inventory watch (one the engine would still fire)?
// Unions the single `inventoryWatch` AND the `inventoryWatches` array (collectInventoryWatches) — they
// can coexist, so the old array-if-present-else-single check missed an active single watch.
export function hasActiveInventoryWatch(conv: any): boolean {
  return collectInventoryWatches(conv).some((w: any) => w && w.status !== "paused");
}

// Is this thread quiet because WE PARKED IT — the customer is waiting on a promise we already made
// — rather than because a lead went cold?
//
// The quiet-thread nudge (domain/humanThreadNudge.ts) asks "is this thread quiet?" and, until
// 2026-08-12, never "why?". Three production threads show what that costs — operator reports from
// Joe on 8/10 and 8/11, each reproduced by executing decideHumanThreadNudge against the live record:
//
//   Jason Marshall +17165230421 — $500 deposit on a 2026 CVO Road Glide ST (hold.onOrder), an active
//   watch, and a cadence stopped with stopReason "inventory_watch". We told him on 8/08 "I'll keep an
//   eye on the 2026 CVO Road Glide ST you've got on order and let you know as soon as it's here" —
//   three days later the nudge drafted "Any update on your timing for Unadilla, Jason - still want me
//   to let you know if it's built before Thursday?". Joe: "There is no reason to follow up when he is
//   waiting for a bike to be delivered. I told him I will let him know when it arrives."
//
//   Mark Griffin +15416478489 — active watch on a 2023 Fat Bob, cadence stopped for it; nudged with
//   "You still set on a 2023 Fat Bob, Mark, or want me to watch any year that pops up?". Joe: "there
//   should not be a cadence or nudge on a set watch."
//
// Three more threads (+17162512324, +17164728139, +17165445915) were nudged on the same footing and
// never reported: 5 of the 33 nudges this feature has ever produced landed on a parked thread, and
// 17 of the 376 nudge-eligible threads are parked right now (measured 2026-08-12 on the live store).
//
// A watch, a cadence stopped FOR that watch, and a unit on order are the same promise — we will text
// you when it lands — and that promise already has its own outreach program (the watch-alert lane
// plus the unanswered-watch pause + close-out of PR #637). A bump here is a second voice on the
// thread AND us breaking the promise three days early.
//
// Lives beside hasActiveInventoryWatch so the watch question has ONE answer: humanThreadNudge.ts is
// a pure decision module and must not import the store, so index.ts reads this and passes the
// boolean in. FAIL DIRECTION: absent or unreadable state ⇒ NOT parked ⇒ the nudge decision is
// exactly what it was before, so a malformed record can never silence a thread by accident.
export function isThreadParkedOnInventoryPromise(conv: any): boolean {
  if (hasActiveInventoryWatch(conv)) return true;
  // A cadence STOPPED for a watch reads exactly like no cadence at all from the nudge's side — the
  // stop reason is the only thing that tells the two apart.
  if (String(conv?.followUpCadence?.stopReason ?? "").trim().toLowerCase() === "inventory_watch") return true;
  // A unit on order or deposit-held: its arrival IS the next contact.
  return conv?.hold?.onOrder === true;
}

// Remove a customer from active inventory-watch alerts: pause every active watch (the watch-fire
// engine skips paused watches). Reversible — keeps the record so they can be re-added if they ask.
// Returns how many were paused. Unions single + array so neither is left active.
export function pauseInventoryWatches(conv: any): number {
  let paused = 0;
  for (const w of collectInventoryWatches(conv)) {
    if (w && w.status !== "paused") {
      w.status = "paused";
      paused++;
    }
  }
  return paused;
}

// Explicit customer opt-out: pause the current watches AND set the durable opt-out flag so a later
// watch (re-)creation can't refire alerts at someone who asked us to stop. See inventoryWatchOptOut.ts.
export function markInventoryWatchOptOut(conv: any, reason: string): number {
  setInventoryWatchOptOut(conv, reason);
  return pauseInventoryWatches(conv);
}

/**
 * SIDE EFFECT half of the unanswered-alert stop (decision lives in watchAlertUnansweredPause.ts,
 * which stays import-free so its eval is not a shared-file barrier).
 *
 * At a watch fire site: pause every active watch and raise ONE staff task in place of the text.
 * Returns the decision when it paused, null when the conversation is still inside its allowance
 * (the caller then fires exactly as before).
 *
 * Called from BOTH watch fire paths in index.ts (`processInventoryWatchlist` and
 * `notifyInventoryWatchersForAvailableItem`) so the arrival cron and the hold-release path stay in
 * lockstep. The pause goes through pauseInventoryWatches — the same referee the explicit opt-out
 * uses — so this adds no new writer of `inventoryWatches`. The task is a `call`, which addTodo
 * merges by task class, so a lead can never accumulate a pile of them.
 *
 * It also queues ONE close-out text (Joe, 2026-08-10: leave "the floor open to keep the watch or
 * let us know if they are looking for something different"), because a silent pause drops the lead
 * with nobody the wiser. It is a `draft_ai` like the alerts it replaces, so staff still approve it,
 * and it is guarded by hasSentWatchCloseOut so a re-run can never send a second one.
 */
export function applyUnansweredWatchAlertPause(
  conv: any,
  nowIsoValue: string,
  opts?: { limit?: number }
): UnansweredWatchAlertDecision | null {
  const decision = decideUnansweredWatchAlertPause(conv, opts);
  if (!decision.pause) return null;
  const paused = pauseInventoryWatches(conv);
  if (paused > 0) {
    addTodo(conv, "call", decision.summary, undefined, conv?.leadOwner);
    if (!hasSentWatchCloseOut(conv)) {
      const to = conv?.lead?.phone ?? conv?.leadKey;
      if (to) {
        appendOutbound(
          conv,
          "salesperson",
          to,
          buildUnansweredWatchCloseOutReply({
            firstName: conv?.lead?.firstName ?? null,
            bikeLabel: watchedModelLabelForCloseOut(conv)
          }),
          "draft_ai"
        );
      }
    }
    conv.updatedAt = nowIsoValue;
    saveConversation(conv);
  }
  return decision;
}

/**
 * The model to name in the close-out, or null to keep it generic. Only a label the CUSTOMER's own
 * watch carries is used — never an inventory unit — so the sign-off cannot name a bike they never
 * asked about. Distinct models on one thread => stay generic rather than pick a favourite.
 */
function watchedModelLabelForCloseOut(conv: any): string | null {
  const labels = new Set<string>();
  for (const watch of collectInventoryWatches(conv)) {
    const model = String((watch as any)?.model ?? "").trim();
    if (!model) continue;
    const year = String((watch as any)?.year ?? "").trim();
    labels.add(year ? `${year} ${model}` : model);
  }
  return labels.size === 1 ? [...labels][0] : null;
}

/**
 * Prune inventory watches whose model EXACTLY matches one of `removeModels` (case-insensitive, trimmed).
 * Pure + surgical: used to remove garbage watches (e.g. VIN-trim-code models like "Fxst Bhlf Softail
 * Standard" that a 4/17 bulk import created on Peter Brand) while KEEPING the customer's real watches.
 * Matching by exact model string, not a fragile "garbage signature", so the caller controls precisely
 * what goes. Returns the kept array + how many were removed; NEVER notifies (the endpoint that calls
 * this deliberately does not run the watchlist, so nothing fires).
 */
export function pruneInventoryWatchesByModel(
  watches: InventoryWatch[],
  removeModels: string[]
): { kept: InventoryWatch[]; removed: number } {
  const norm = (s: unknown) => String(s ?? "").trim().toLowerCase();
  const remove = new Set(removeModels.map(norm).filter(Boolean));
  if (!remove.size) return { kept: watches, removed: 0 };
  const kept = watches.filter(w => !remove.has(norm(w?.model)));
  return { kept, removed: watches.length - kept.length };
}

// The ONE place a lead's thread is stamped closed — `closeConversation` and the console's
// appointment-outcome "sold" lane (index.ts) both ask `decideLeadCloseout` for what closing
// entails, instead of each hand-writing the same three fields. See that referee for the divergence
// it preserves (the sold lane leaves active inventory watches to the reconcile tick).
//
// Deliberately does NOT stamp `conv.updatedAt` or save: `closeConversation` does both right after,
// and the outcome lane's caller saves. Adding a write here would change persisted timestamps,
// which a behavior-preserving cleanup must not do.
export function applyLeadCloseout(
  conv: Conversation,
  input: { nowIso: string; lane: LeadCloseoutLane; reason?: string }
): LeadCloseoutDecision {
  const decision = decideLeadCloseout({ lane: input.lane, reason: input.reason });
  conv.status = "closed";
  conv.closedAt = input.nowIso;
  conv.closedReason = decision.closedReason;
  // A closed conversation must not keep an ACTIVE inventory watch — a reopen could refire
  // "it's available again!" to a customer who already closed/bought. Pause every active watch
  // (reversible; the watch-fire engine skips paused). Write-time guard; the reconcile tick is the
  // catch-all for close paths whose lane opts out (see the referee).
  if (decision.pauseActiveWatches) {
    for (const w of collectInventoryWatches(conv)) {
      if (w && w.status !== "paused") w.status = "paused";
    }
  }
  return decision;
}

/**
 * Arm a closeout that only fires when a reply actually goes out (Joe, 2026-08-04: "After we send
 * draft and it goes through it should close the lead"). Writes nothing but the note itself — the
 * lead stays open, in the inbox, and fully workable until the send.
 */
export function armPendingCloseout(conv: Conversation, reason: string) {
  conv.pendingCloseout = { reason, armedAt: nowIso() };
}

/**
 * Fire (or refuse) an armed closeout because an outbound just went out. Asks
 * `decidePendingCloseoutOnSend` whether this send earns the close, and routes the close itself
 * through `applyLeadCloseout` — the one closeout referee — so this never becomes another writer of
 * `conv.status`. `applyLeadCloseout` also pauses any surviving active watch, which is belt-and-braces
 * here since the acquisition turn already paused them.
 *
 * Returns the decision so callers can log it; a refusal still clears a stale arm.
 */
export function applyPendingCloseoutOnSend(
  conv: Conversation,
  input: { nowIso: string }
): PendingCloseoutSendDecision {
  const armed = conv.pendingCloseout;
  const lastInbound = [...(conv.messages ?? [])]
    .reverse()
    .find(m => String((m as any)?.direction ?? "") === "in");
  const lastInboundAtMs = lastInbound ? Date.parse(String((lastInbound as any).at ?? "")) : NaN;
  const decision = decidePendingCloseoutOnSend({
    armed: !!armed,
    armedAtMs: Date.parse(String(armed?.armedAt ?? "")),
    lastInboundAtMs: Number.isFinite(lastInboundAtMs) ? lastInboundAtMs : null,
    alreadyClosed: conv.status === "closed"
  });
  if (decision.kind === "close_lead") {
    applyLeadCloseout(conv, { nowIso: input.nowIso, lane: "generic_close", reason: armed?.reason });
    markOpenTodosDoneForConversation(conv.id);
  }
  if (decision.clearArm) conv.pendingCloseout = undefined;
  return decision;
}

// The ONE place a bike is put on hold FOR a lead. Both write sites — the appointment-outcome "held"
// lane and the console's manual-resolution endpoint — ask `decideInventoryHoldRecord` instead of
// each hand-writing the same fourteen fields plus the same cadence/mode aftermath. See that referee
// for the two preserved divergences (the outcome lane's unconditional mode stomp, and the null key).
//
// The inventory-store side of a hold (`setInventoryHold` / `clearInventoryHold`) deliberately stays
// at the call sites: it is async I/O against a different store, identical in both lanes, and pulling
// it in here would widen a behavior-preserving cleanup into a lifecycle change.
//
// Deliberately does NOT stamp `conv.updatedAt` or save — both callers already do, and adding a write
// here would change persisted timestamps.
export function applyInventoryHoldRecord(
  conv: Conversation,
  input: Omit<InventoryHoldRecordInput, "existingCreatedAt" | "currentFollowUpMode">
): InventoryHoldRecordDecision {
  const decision = decideInventoryHoldRecord({
    ...input,
    existingCreatedAt: conv.hold?.createdAt,
    currentFollowUpMode: conv.followUp?.mode
  });
  // The referee mirrors the record STRUCTURALLY (it imports no store types), and its `key` is
  // `string | null | undefined` because the outcome lane stores a literal null. The stored type
  // says `key?: string`, which both lanes already violated the same way before this extraction.
  conv.hold = decision.record as unknown as Conversation["hold"];
  stopFollowUpCadence(conv, decision.stopCadenceReason);
  if (decision.setPausedIndefinite) setFollowUpMode(conv, "paused_indefinite", decision.reason);
  return decision;
}

/**
 * The single place an inventory watch is ARMED onto a conversation. Six lanes used to hand-write
 * the same block; they now all ask `decideInventoryWatchArm` (routeStateReducer) — see that
 * referee for the two preserved dialog-state divergences.
 *
 * `setDialogState` lives in index.ts (it also stamps `lastIntent` and reverses the durable watch
 * opt-out), so the five in-file lanes hand it in. The email lane cannot — it writes the record
 * directly, which IS divergence 2 — so the input type makes the callback mandatory for every lane
 * except that one, and a future lane that forgets it will not compile.
 */
export function applyInventoryWatchArm(
  conv: Conversation,
  input: { watches: InventoryWatch[] } & (
    | {
        lane: Exclude<InventoryWatchArmLane, `email_${string}`>;
        setDialogState: (conv: any, name: "inventory_watch_active") => void;
        // Never read on these lanes: only the DIRECT dialog write needs a clock.
        nowIso?: string;
      }
    | { lane: "email_inbound" | "email_walk_in" | "email_adf_unavailable"; setDialogState?: undefined; nowIso: string }
  )
): InventoryWatchArmDecision {
  const decision = decideInventoryWatchArm({ lane: input.lane, watchCount: input.watches.length });
  if (!decision.arm) return decision;
  conv.inventoryWatches = input.watches;
  conv.inventoryWatch = input.watches[0];
  if (decision.clearPending) conv.inventoryWatchPending = undefined;
  if (decision.dialogRoute === "helper" && decision.dialogState) {
    input.setDialogState?.(conv, decision.dialogState);
  } else if (decision.dialogRoute === "direct" && decision.dialogState) {
    conv.dialogState = { name: decision.dialogState, updatedAt: input.nowIso ?? nowIso() };
  }
  setFollowUpMode(conv, decision.followUpMode, decision.followUpModeReason);
  stopFollowUpCadence(conv, decision.stopCadenceReason);
  return decision;
}

/**
 * The single place an inventory watch comes OFF a conversation — the inverse of
 * `applyInventoryWatchArm`. Three lanes used to hand-write the same three fields; they now all ask
 * `decideInventoryWatchDisarm` (routeStateReducer), which is where both preserved divergences and
 * the deliberate per-lane aftermath are documented.
 *
 * `setDialogState` lives in index.ts (it also stamps `lastIntent`), so the one lane that steps the
 * dialog back hands it in along with the states it steps back FROM — the store cannot see either.
 */
export function applyInventoryWatchDisarm(
  conv: Conversation,
  input: {
    lane: InventoryWatchDisarmLane;
    /** The watches that survive. */
    remaining: InventoryWatch[];
    /** `only_if_pruned` lanes pass this: repoint the mirror just when the mirror itself was pruned. */
    mirrorWasPruned?: boolean;
    /** `caller_picks` lanes pass the survivor they matched; undefined falls back to the first. */
    mirrorPick?: InventoryWatch;
    reason?: string;
    stepDialogBack?: (conv: any) => void;
  }
): InventoryWatchDisarmDecision {
  const decision = decideInventoryWatchDisarm({ lane: input.lane, remainingCount: input.remaining.length });
  const empty = input.remaining.length === 0;
  conv.inventoryWatches =
    empty && decision.emptyListShape === "undefined" ? undefined : input.remaining;
  if (decision.mirrorRule === "first" || (decision.mirrorRule === "only_if_pruned" && input.mirrorWasPruned)) {
    conv.inventoryWatch = input.remaining[0];
  } else if (decision.mirrorRule === "caller_picks") {
    conv.inventoryWatch = input.mirrorPick ?? input.remaining[0];
  }
  if (decision.clearPending) conv.inventoryWatchPending = undefined;
  if (decision.followUpMode) setFollowUpMode(conv, decision.followUpMode, input.reason ?? "inventory_watch_clear");
  if (decision.stopCadence) stopFollowUpCadence(conv, input.reason ?? "inventory_watch_clear");
  if (decision.stepDialogBack) input.stepDialogBack?.(conv);
  return decision;
}

// The one writer of "this voicemail mints a staff follow-up task". See the fail-direction note on
// `decideVoicemailFollowUpTask` in routeStateReducer.ts — the suppression clause is deliberately
// four-way, because after it fires the watch is the lead's ONLY remaining touch.
//
// PRESERVED DIVERGENCE: the inbound lane's duplicate check looks at `reason === "call"` only,
// while the two outbound lanes also count `taskClass === "followup"`. That difference predates
// this referee and is kept exactly; centralizing it is a separate question from the operator's.
export function applyVoicemailFollowUpTask(
  conv: Conversation,
  input: {
    lane: VoicemailFollowUpTaskLane;
    summary: string;
    sourceMessageId?: string;
    schedule?: TodoScheduleOptions;
  }
): VoicemailFollowUpTaskDecision {
  const countsFollowUpClass = input.lane !== "inbound_voicemail";
  const hasOpenFollowUpTask = listOpenTodos().some(
    t =>
      t.convId === conv.id &&
      t.status === "open" &&
      (t.reason === "call" || (countsFollowUpClass && t.taskClass === "followup"))
  );
  // Same "active watch" test the fire engine and the watchdog use (watchFireMiss.ts:116,
  // index.ts:7125): an absent status means active, only "paused" is not. Merged with the legacy
  // singular field so a lead written before `inventoryWatches` existed still reads as parked.
  const mergedWatches = [
    ...(Array.isArray(conv.inventoryWatches) ? conv.inventoryWatches : []),
    ...(conv.inventoryWatch ? [conv.inventoryWatch] : [])
  ];
  const liveWatches = mergedWatches.filter(w => w && w.model && w.status !== "paused");
  const activeInventoryWatchCount = liveWatches.length;
  // Joe's two "unless" clauses (2026-08-04). Both are built to fail toward KEEPING the task: an
  // unreadable watch or message timestamp reads as customer contact rather than silence.
  const armedMs = liveWatches.reduce((newest, w) => {
    const t = Date.parse(String(w.createdAt ?? ""));
    return Number.isFinite(t) && t > newest ? t : newest;
  }, Number.NEGATIVE_INFINITY);
  const customerContactSinceWatchArmed = !Number.isFinite(armedMs)
    ? activeInventoryWatchCount > 0
    : (conv.messages ?? []).some((m: any) => {
        if (m?.direction !== "in") return false;
        const t = Date.parse(String(m?.at ?? ""));
        return !Number.isFinite(t) || t > armedMs;
      });
  const openWorkBeyondWatch =
    listOpenTodos().some(
      t => t.convId === conv.id && t.status === "open" && t.reason !== "call" && t.taskClass !== "followup"
    ) || Boolean(conv.appointment?.bookedEventId);
  const decision = decideVoicemailFollowUpTask({
    lane: input.lane,
    hasOpenFollowUpTask,
    activeInventoryWatchCount,
    followUpMode: conv.followUp?.mode,
    followUpReason: conv.followUp?.reason,
    customerContactSinceWatchArmed,
    openWorkBeyondWatch
  });
  if (!decision.create) return decision;
  addTodo(
    conv,
    "call",
    input.summary,
    input.sourceMessageId,
    undefined,
    input.schedule,
    input.lane === "inbound_voicemail" ? undefined : "followup"
  );
  return decision;
}

// ORDERING NOTE. The watch pause used to sit AFTER `applyCadenceLifecycle`; it now runs inside the
// applier, i.e. before it. Inert: `applyCadenceLifecycle` reads and writes only `followUpCadence`
// and `followUp` — it never looks at a watch — so neither can see the other's result.
export function closeConversation(conv: Conversation, reason?: string) {
  applyLeadCloseout(conv, { nowIso: nowIso(), lane: "generic_close", reason });
  markOpenTodosDoneForConversation(conv.id);
  applyCadenceLifecycle(conv, { verb: "close", reason, stopReason: reason ?? "closed" });
  conv.updatedAt = nowIso();
  scheduleSave();
}

// Disengagement taper. A lead that never reached back should not be nudged
// through the entire 13-step sequence (Michael Digiulio +17168660252: 10
// unanswered touches across SMS, email, and a voicemail, still scheduled for
// more). After this many touches with zero customer inbound, the cadence sends
// one graceful close-out and then ends. Joe set the threshold at 9 touches.
export const DISENGAGED_TAPER_AFTER_TOUCHES = 9;

/** Minimum parser confidence to let a phone call count as engagement. */
export const VOICE_PARTICIPATION_MIN_CONFIDENCE = 0.85;

/**
 * Pure. Should this call record stamp the lead as ENGAGED?
 *
 * Only a HIGH-confidence, explicitly live two-way conversation qualifies. `customerParticipated`
 * alone is not enough — the outcome must also say `live_conversation`, because the near-misses
 * (an answering-machine greeting in the customer's own voice, an IVR hold loop) are exactly the
 * cases a loose read gets wrong.
 *
 * FAIL DIRECTION: no parse, low confidence, or any other outcome => false => today's behavior.
 * A false positive keeps texting someone who never actually answered, so uncertainty must resolve
 * toward NOT marking engagement.
 */
export function voiceCallCountsAsEngagement(parse?: {
  customerParticipated?: boolean | null;
  outcome?: string | null;
  confidence?: number | null;
} | null): boolean {
  if (!parse) return false;
  if (parse.customerParticipated !== true) return false;
  if (String(parse.outcome ?? "").trim().toLowerCase() !== "live_conversation") return false;
  const confidence = Number(parse.confidence);
  return Number.isFinite(confidence) && confidence >= VOICE_PARTICIPATION_MIN_CONFIDENCE;
}

/**
 * Pure. Should we SKIP generating a written summary for this call?
 *
 * ROOT CAUSE (2026-07-30). `summarizeVoiceTranscriptWithLLM` is handed the transcript AND the
 * lead's vehicle fields ("Known lead info (may help resolve model names)"). When the transcript
 * carries no actual conversation — an IVR menu, a hold loop, an answering-machine greeting — the
 * lead JSON is the only substantive content in the prompt, so the model writes the LEAD RECORD BACK
 * as if the customer had said it. Proven on +17165236994: a 117-character transcript containing
 * only our own phone greeting ("Thank you for calling ... you may enter it at any") produced
 * "Customer inquired about a Ultra Limited in Billiard Red/Vivid Black (stock U888-21) and wants
 * pricing and availability. Customer asked about trade-in and a test ride; they requested a
 * callback." Every one of those details is verbatim from `lead.vehicle` — model, color, stockId.
 * The prompt's "Use ONLY facts stated in the transcript" does not hold when the transcript is empty
 * of facts.
 *
 * That matters because those summaries are consumed downstream: they become draft-composer context
 * (effectiveContext, priority 150), durable customer facts (voiceCadenceFacts), and the evidence
 * the task auto-closer judges. A fabricated "the customer asked about a test ride" can therefore
 * reach a real customer-facing reply.
 *
 * The existing regex `isLikelyVoicemailTranscript` stays (a fail-safe KEEP gate — its removal fails
 * toward treating a voicemail as contacted). This is an ADDITIONAL suppressor for what the regex
 * cannot see: our own IVR greeting carries no voicemail phrasing and clears the word-count check.
 *
 * FAIL DIRECTION: requires a HIGH-confidence, explicitly non-conversational outcome. `unclear`
 * never suppresses. A wrong suppression loses a summary (the transcript is still stored, and the
 * facts/context simply don't get set) — information loss, never fabrication. That is strictly safer
 * than today, where a contentless call invents customer statements.
 */
export function shouldSuppressVoiceSummary(parse?: {
  outcome?: string | null;
  confidence?: number | null;
} | null): boolean {
  if (!parse) return false;
  const outcome = String(parse.outcome ?? "").trim().toLowerCase();
  if (outcome !== "ivr_or_system" && outcome !== "voicemail" && outcome !== "no_answer") return false;
  const confidence = Number(parse.confidence);
  return Number.isFinite(confidence) && confidence >= VOICE_PARTICIPATION_MIN_CONFIDENCE;
}

/** Neutral marker recorded in place of a summary we refused to fabricate. */
export function buildUnsummarizableCallNote(outcome?: string | null): string {
  const o = String(outcome ?? "").trim().toLowerCase();
  if (o === "ivr_or_system") return "Automated phone system — no conversation recorded.";
  if (o === "no_answer") return "No answer — not contacted.";
  return "Voicemail — not contacted.";
}

/** True when any call on this thread was parser-confirmed as a live two-way conversation. */
export function hasParticipatedVoiceCall(conv: Conversation): boolean {
  return (conv?.messages ?? []).some(m => (m as any)?.customerSpokeOnCall === true);
}

// A lead counts as engaged when the CUSTOMER reached back — an inbound message that isn't the
// originating web-lead form (sendgrid_adf) or a debug event — OR when they actually TALKED to us
// on the phone (Joe ruling 2026-07-30, option B).
//
// Voice rows (`voice_call`/`voice_summary`/`voice_transcript`) are all recorded `direction: "out"`
// because WE placed the call, so a customer who had a real conversation with a salesperson still
// read as "never responded" and could be tapered off cadence with "I'll pause my check-ins here".
// Syed John (+12065383753) got that message two days after taking Giovanni's call. Measured before
// the fix: 35 tapered leads, 26 with call activity, but only 3 with a genuine two-way conversation
// — so this widens cadence for very few leads, which is why it is safe to widen at all.
//
// The "was this a real conversation?" judgement is COMPREHENSION and belongs to
// parseVoiceCallParticipationWithLLM; it is stamped onto the message at ingest as structured
// state. This function stays PURE and SYNC and only reads that stamp.
export function customerEngagedWithCadence(conv: Conversation): boolean {
  if (hasParticipatedVoiceCall(conv)) return true;
  return (conv.messages ?? []).some(
    m =>
      m?.direction === "in" &&
      m?.provider !== "sendgrid_adf" &&
      String(m?.body ?? "").trim().length > 0
  );
}

// Don't put words in a silent customer's mouth (Joe ruling 2026-07-29, Syed John +12065383753).
// The old copy opened "No rush at all, {name}." — which reads as though the customer ASKED for
// space. By construction this close-out only ever fires on a lead who never wrote back
// (shouldSendDisengagedCloseout requires !customerEngagedWithCadence), so that frame is fabricated
// 100% of the time it is used: nobody in this branch has told us anything. Syed had actually taken
// Giovanni's call two days earlier and still got it. The honest version names OUR reason — we've
// reached out plenty and don't want to crowd them — and keeps the door open the same way.
// Fabricated-frame class: see [[adf-form-vs-question-framing]].
export function buildDisengagedCadenceCloseout(firstName?: string): string {
  const name = String(firstName ?? "").trim() || "there";
  return `I'll pause my check-ins here so I'm not crowding your phone, ${name}. Text me anytime you're ready and I'll jump right back in to help.`;
}

/**
 * Pure. How many cadence touches have ACTUALLY produced a message for this lead.
 *
 * The taper threshold is a count of OUTREACH ("after this many touches with zero customer
 * inbound" — Joe set it at 9), but `stepIndex`/`lastSentStep` are positions on the schedule and
 * advance even when a gate stays quiet: the cadence-quality gate, the value gate, and the
 * past-dated-event guard all call advanceFollowUpCadence WITHOUT sending anything. Measured on
 * the live store 2026-08-04: of 37 leads ended with stopReason "disengaged_taper", 13 had fewer
 * than 9 outbound messages of ANY kind (three had 2), and only 2 of the 37 ever received the
 * close-out — the rest were dropped mid-ladder and simply went silent. Counting rungs as touches
 * is what did that, so the count now lives in its own field.
 *
 * Legacy records (written before this field existed) fall back to `lastSentStep + 1` — exactly
 * the number the taper used to read — so in-flight cadences keep their current position and this
 * change can never RE-open a ladder into extra messaging.
 */
export function deliveredCadenceTouches(cadence: FollowUpCadence | undefined | null): number {
  if (!cadence) return 0;
  const tracked = Number(cadence.deliveredTouches);
  if (Number.isFinite(tracked) && tracked >= 0) return Math.floor(tracked);
  const legacy = Number(cadence.lastSentStep);
  return Number.isFinite(legacy) && legacy >= 0 ? Math.floor(legacy) + 1 : 0;
}

// True when the touch about to be sent should be the disengagement close-out:
// a never-engaged sales lead (not post-sale/long-term) at or past the taper
// threshold. `deliveredTouchesBeforeThisOne` counts touches that actually went out — a rung the
// cadence skipped in silence is not outreach and must not spend the lead's patience budget.
export function shouldSendDisengagedCloseout(
  conv: Conversation,
  deliveredTouchesBeforeThisOne: number
): boolean {
  const cadence = conv.followUpCadence;
  if (!cadence) return false;
  if (cadence.kind === "post_sale" || cadence.kind === "long_term") return false;
  if (customerEngagedWithCadence(conv)) return false;
  return Number(deliveredTouchesBeforeThisOne) >= DISENGAGED_TAPER_AFTER_TOUCHES;
}

/**
 * Move the cadence to its next rung.
 *
 * `delivered` says whether this rung actually produced a message. It defaults to TRUE so every
 * send path keeps its existing behaviour untouched; the four gates that advance the schedule
 * while staying completely silent (cadence-quality suppress, the value gate and its repeat
 * backstop, the past-dated-event guard) pass `{ delivered: false }`. A silent rung still burns —
 * we tried it and had nothing worth saying — but it must not stamp `lastSentAt`/`lastSentStep`
 * as though a customer heard from us, and it must not spend a touch against the taper.
 *
 * `endSequence` is the one exception, and it is not a contradiction: when the rung being held IS
 * the close-out, the decision to stop chasing was already taken on the DELIVERED count and only
 * the goodbye got withheld. Ending is right there; going back to chasing is not.
 */
export function advanceFollowUpCadence(
  conv: Conversation,
  timeZone: string,
  opts?: { delivered?: boolean; endSequence?: boolean }
) {
  if (!conv.followUpCadence || conv.followUpCadence.status !== "active") return;
  const cadence = conv.followUpCadence;
  const decision = decideCadenceAdvance({
    kind: cadence.kind,
    followUpReason: conv.followUp?.reason,
    contextTag: cadence.contextTag,
    deferredMessage: cadence.deferredMessage,
    stepIndex: cadence.stepIndex,
    // PRE-increment on purpose — see the referee. The rung that sends the close-out must be the
    // rung that ends the ladder, or the lead is retired without ever being said goodbye to.
    deliveredTouchesBefore: deliveredCadenceTouches(cadence),
    delivered: opts?.delivered,
    endSequence: opts?.endSequence,
    customerEngaged: customerEngagedWithCadence(conv),
    taperAfterTouches: DISENGAGED_TAPER_AFTER_TOUCHES
  });
  if (decision.stampDelivered) {
    cadence.lastSentAt = nowIso();
    cadence.lastSentStep = cadence.stepIndex;
    cadence.deliveredTouches = decision.deliveredTouchesAfter;
  }
  cadence.stepIndex = decision.nextStepIndex;
  if (decision.endNow) {
    cadence.status = "completed";
    if (decision.endNow.stopReason) cadence.stopReason = decision.endNow.stopReason;
    cadence.nextDueAt = undefined;
    conv.updatedAt = nowIso();
    scheduleSave();
    return;
  }
  const offsets = CADENCE_LADDER_DAY_OFFSETS[decision.ladder];
  if (decision.nextStepIndex >= offsets.length) {
    cadence.status = "completed";
    cadence.nextDueAt = undefined;
  } else {
    cadence.nextDueAt = decision.usesPostSaleDueAt
      ? computePostSaleDueAt(cadence.anchorAt, offsets[decision.nextStepIndex], timeZone)
      : computeFollowUpDueAt(cadence.anchorAt, offsets[decision.nextStepIndex], timeZone);
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

/**
 * Deterministic date EXTRACTION (AGENTS.md permits deterministic structured extraction — this
 * reads digits, it does not judge intent).
 *
 * A CLOCK HOUR IS NOT A YEAR (2026-07-30 audit, 15 live tasks). The month-name branches ended in
 * an optional `(\d{2,4})` year, so the time in "July 20 10:00 am" was captured as the year "10" →
 * 2000+10 → the appointment landed in **2010**. Every wrong year on the box was 2010/2011/2012,
 * because the dealership's morning slots are 10, 11 and 12 o'clock. Those tasks were created
 * already ~15 years overdue. It only fired when the time followed the date directly — "July 20 AT
 * 10:00" parsed fine, which is why it survived so long.
 *
 * So a month-name form now requires a 4-DIGIT year. Fail-direction is prefer-missing-over-wrong
 * (same precedent as the feed-alias and replay-fidelity work): dropping an ambiguous 2-digit
 * "year" falls back to the current year and the normal roll-forward, which is right far more often
 * than trusting it. The slash form (7/20/26) keeps 2-digit years — its separators are unambiguous.
 */
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
    /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s*(\d{4}))?\b/i
  );
  if (monthFirst) {
    const month = monthMap[String(monthFirst[1] ?? "").toLowerCase()] ?? 0;
    const day = Number(monthFirst[2]);
    const year = normalizeYear(monthFirst[3]);
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    return { year, month, day };
  }

  const dayFirst = text.match(
    /\b(\d{1,2})(?:st|nd|rd|th)?\s+(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)(?:,?\s*(\d{4}))?\b/i
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

/**
 * Backstop invariant: a requested appointment time is a FUTURE time, so a computed due date far in
 * the past is a parse failure, not a deadline. Stamping it produces a task born overdue — which is
 * exactly what the clock-hour-as-year bug did 15 times (see parseExplicitDate). Callers drop the
 * due date and keep the task, because "no deadline" is honest while "due in 2010" is noise that
 * trains staff to ignore red.
 *
 * Deliberately generous at 24h so this only ever catches the absurd case: a customer asking at 2pm
 * for "10am" resolves to earlier TODAY, which is a real same-day request whose handling this must
 * not change. Only a date that cannot be a request at all is refused. Pure so it can be pinned.
 */
export const APPOINTMENT_DUE_PAST_TOLERANCE_MS = 24 * 60 * 60 * 1000;

export function isImplausibleAppointmentDueAt(dueAtMs: number, nowMs: number): boolean {
  if (!Number.isFinite(dueAtMs) || !Number.isFinite(nowMs)) return false; // unknown → never block
  return dueAtMs < nowMs - APPOINTMENT_DUE_PAST_TOLERANCE_MS;
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
  // A stated WINDOW ("between 4 and 5", "2-3", "10 to 11"). `and` joins the window Terry
  // Majchrzak used (+17166091289, 2026-07-27: "I could be there today between 4 and 5") — it
  // was missing here, so that shape only ever resolved by accident through the bare-number
  // fallback below. Group 2 captures the START's minutes so "4:30 to 5" keeps its :30.
  const timeRange =
    dayToken
      ? t.match(
          /\b(?:at|for|around|by|close\s+to|near|between)\s*(\d{1,2})(?::(\d{2}))?\s*(?:\/|-|to|and)\s*(\d{1,2})(?::\d{2})?(?:\s*(am|pm))?\b/
        )
      : null;
  const explicitDate = timeRange ? null : (parseExplicitDate(t) ?? parseOrdinalDateInCurrentWindow(t, timeZone));
  // A window always resolves to its START (Joe ruling 2026-07-28). This has to OUTRANK
  // parseExactTime, not just backfill it: on "between 4 and 5pm" the meridiem binds to the
  // range END, so parseExactTime matched "5pm" and returned 17:00 while the identical
  // un-suffixed "between 4 and 5" returned 16:00. Same sentence, two answers — the customer
  // means they arrive at 4 in both.
  let time = parseExactTime(t);
  const rangeStart = (() => {
    if (!timeRange) return null;
    const hourRaw = Number(timeRange[1]);
    const minute = Number(timeRange[2] ?? "0");
    const meridiem = timeRange[4];
    if (!(hourRaw >= 1 && hourRaw <= 12)) return null;
    if (!(minute >= 0 && minute <= 59)) return null;
    let hour24 = hourRaw;
    if (meridiem === "am") hour24 = hourRaw === 12 ? 0 : hourRaw;
    else if (meridiem === "pm") hour24 = hourRaw === 12 ? 12 : hourRaw + 12;
    else if (hourRaw !== 12) hour24 = hourRaw <= 7 ? hourRaw + 12 : hourRaw;
    return { hour24, minute, timeText: timeRange[0] };
  })();
  if (rangeStart) time = rangeStart;
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

/**
 * "in 10 days" / "in 2 weeks" / "in 3 months" / "next month" → a number of days, else null.
 *
 * Deterministic QUANTITY extraction — a number and a unit — which AGENTS.md allows as structured
 * extraction. It is not comprehension and must never try to be: anything requiring judgement
 * ("next spring", "after the holidays", "once my bonus lands") returns null on purpose so the
 * caller declines to invent a date instead of guessing one.
 *
 * The phrases the week-anchored branch above already owns (`next week`, `in a week`, `in a few
 * days`, `a couple of weeks`) are deliberately NOT matched here — that branch runs first and
 * anchors them to a MONDAY, which several evals pin. This only picks up what fell through.
 *
 * Months are 30 days: this dates a callback reminder, not a contract, and ±1 day at a 3-month
 * horizon is immaterial. An absurd horizon is refused rather than clamped — past ~2 years the
 * match is far more likely a misread number than a real ask.
 */
const TIMEFRAME_WORD_NUMBERS: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, couple: 2, few: 3, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12
};

const MAX_TIMEFRAME_DAYS = 730;

export function resolveRelativeTimeframeDays(text: string | null | undefined): number | null {
  const t = String(text ?? "").toLowerCase();
  if (!t.trim()) return null;
  if (/\bnext month\b/.test(t)) return 30;

  const m = t.match(
    /\b(?:in\s+|after\s+)?(\d{1,3}|a|an|one|two|couple|few|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s*(?:of\s+)?(day|week|month)s?\b/
  );
  if (!m) return null;
  const raw = m[1];
  const count = /^\d+$/.test(raw) ? Number(raw) : TIMEFRAME_WORD_NUMBERS[raw];
  if (!Number.isFinite(count) || count <= 0) return null;
  const perUnit = m[2] === "day" ? 1 : m[2] === "week" ? 7 : 30;
  const days = count * perUnit;
  if (days > MAX_TIMEFRAME_DAYS) return null;
  return days;
}

/**
 * Did the customer name a timeframe we could not turn into a date?
 *
 * The distinction that matters: "call me back" (no timeframe given) and "call me next spring" (a
 * timeframe we failed to read) are NOT the same, but the callback path treated them identically —
 * both fell back to due-tomorrow-9am. The first is a fair default; the second is a deadline six
 * months early that trains staff to ignore the overdue badge.
 *
 * Used only to SUPPRESS an invented due date, never to create one, so a false positive costs an
 * undated task (still visible in the rep's morning window and the weekly digest) while a false
 * negative just restores today's behaviour. That asymmetry is why a keyword scan is acceptable
 * here: it gates a default, not a customer-facing decision.
 */
export function mentionsUnresolvedTimeframe(text: string | null | undefined): boolean {
  const t = String(text ?? "").toLowerCase();
  if (!t.trim()) return false;
  return /\b(day|days|week|weeks|month|months|year|years|spring|summer|fall|autumn|winter|holidays?|season|christmas|thanksgiving|tax\s+season|bonus|springtime)\b/.test(
    t
  );
}

// EVERY relative date in here is relative to SOMETHING, and until now that something was always
// `Date.now()` — the moment the code happened to run, not the moment the customer or the staff note
// spoke. That is the same class of bug as a replay finding stamped with the sweep's clock: it makes
// the function unreplayable, and it made `walkin_internal_note_topic_guard:eval` go red at midnight
// on 2026-08-05 with nothing changed. Ed's note said "TUESDAY AUGUST 4TH" and carried no year; on
// Aug 4 that rolled forward to 2026, and one day later to 2027.
//
// `asOfIso` is the turn's clock. It DEFAULTS to now, so every existing caller is unchanged — this
// only gives replays and evals a way to ask the question the way production asked it.
export function parseRequestedDateOnly(
  text: string,
  timeZone: string,
  asOfIso?: string | null
): { year: number; month: number; day: number; dayOfWeek: string } | null {
  const t = String(text ?? "").toLowerCase();
  // An unparseable asOf falls back to now rather than throwing or producing Invalid Date parts: a
  // bad clock must never turn a real requested date into no date at all (fail toward resolving).
  const asOfMs = asOfIso ? new Date(String(asOfIso)).getTime() : Number.NaN;
  const nowDate = (): Date => (Number.isFinite(asOfMs) ? new Date(asOfMs) : new Date());
  const explicitDate = parseExplicitDate(t);
  if (explicitDate) {
    // Must mirror parseExplicitDate's year groups EXACTLY. When these two disagree, the roll-forward
    // silently stops protecting a date: "July 20 10:00 am" read "10" as a 2-digit year (2010), and
    // this check then saw a year as "provided", so nothing rolled it forward to 2026 — the task was
    // born 15 years overdue. Month-name forms therefore require a 4-DIGIT year in both places; only
    // the slash form (7/20/26), where separators make it unambiguous, still takes two digits.
    const explicitYearProvided =
      /\b\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}\b/.test(t) ||
      /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{1,2}(?:st|nd|rd|th)?(?:,?\s*)\d{4}\b/i.test(
        t
      ) ||
      /\b\d{1,2}(?:st|nd|rd|th)?\s+(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)(?:,?\s*)\d{4}\b/i.test(
        t
      );
    let year = explicitDate.year;
    if (!explicitYearProvided) {
      const now = nowDate();
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

  // Relative week phrases (task-hygiene follow-up, Nicholas Braun +17166286477): a staff promise
  // "I'll call you when the trade comes in, probably next week" resolved to NO date, so the dated
  // task fell back to due-tomorrow — nagging a week early. "next week" anchors to next MONDAY
  // (the earliest day the promise could be due); "in a couple weeks" to Monday after. Deterministic
  // date-word extraction, not comprehension.
  if (/\bnext week\b/.test(t) || /\bin a (?:week|few days)\b/.test(t) || /\bcouple (?:of )?weeks\b/.test(t)) {
    const now = nowDate();
    const nowParts = getZonedParts(now, timeZone);
    const todayIdx = weekdayIndex((nowParts.weekday ?? "").slice(0, 3));
    const daysToNextMonday = ((8 - todayIdx) % 7) || 7;
    const addDays = /\bcouple (?:of )?weeks\b/.test(t) ? daysToNextMonday + 7 : daysToNextMonday;
    const base = new Date(Date.UTC(nowParts.year, nowParts.month - 1, nowParts.day, 12, 0));
    base.setUTCDate(base.getUTCDate() + addDays);
    const parts = getZonedParts(base, timeZone);
    return {
      year: parts.year,
      month: parts.month,
      day: parts.day,
      dayOfWeek: weekdayFull((parts.weekday ?? "").slice(0, 3))
    };
  }

  // Numeric timeframes — "call me in 10 days", "in 2 weeks", "in 3 months", "next month".
  // Same failure the week phrases below fixed, just the arithmetic half: none of these resolved,
  // so the callback task fell back to due-TOMORROW-9am. Measured on the live store 2026-07-31:
  // "Call requested: 10 days." and "Call requested: next spring." were both sitting on a rep's
  // desk the next morning — nine days and six months early. A deadline nobody can meet is what
  // teaches staff that an overdue badge means nothing.
  //
  // Deterministic quantity extraction (a number and a unit), NOT comprehension — which is exactly
  // why seasonal//conditional asks ("next spring", "after the holidays", "once I sell my house")
  // are deliberately NOT handled here: those are judgement and belong to a typed parser. They fall
  // through to null, and the caller must then decline to invent a date rather than guess.
  {
    const days = resolveRelativeTimeframeDays(t);
    if (days != null) {
      const nowParts = getZonedParts(nowDate(), timeZone);
      const base = new Date(Date.UTC(nowParts.year, nowParts.month - 1, nowParts.day, 12, 0));
      base.setUTCDate(base.getUTCDate() + days);
      const parts = getZonedParts(base, timeZone);
      return {
        year: parts.year,
        month: parts.month,
        day: parts.day,
        dayOfWeek: weekdayFull((parts.weekday ?? "").slice(0, 3))
      };
    }
  }

  const dayToken = parseDayToken(t);
  if (!dayToken) return null;

  const now = nowDate();
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

// The ONE place that stamps an appointment's CONFIRMED record — status + who confirmed + whether
// the customer's word is on file (`acknowledged`) + whether the reschedule latch clears. Asks
// `decideAppointmentConfirmRecord` (routeStateReducer) so the three confirm lanes cannot drift;
// see that referee for the two divergences it preserves. Booking fields (event id, slot, times)
// stay with the caller — they are IO results, not arbitration.
//
// Deliberately does NOT touch conv.updatedAt or call scheduleSave(): every caller sits inside a
// larger handler that owns the save (mirrors applyManualCadenceRestart).
export function applyAppointmentConfirmRecord(
  conv: Conversation,
  lane: AppointmentConfirmLane
): AppointmentConfirmRecordDecision {
  const decision = decideAppointmentConfirmRecord({
    lane,
    reschedulePending: conv.appointment?.reschedulePending,
    currentStatus: conv.appointment?.status ?? null,
    currentAcknowledged: conv.appointment?.acknowledged ?? null
  });
  if (!decision.confirm) return decision;
  conv.appointment = conv.appointment ?? { status: "none", updatedAt: nowIso() };
  conv.appointment.status = decision.status;
  // A null credit means this lane has no view on WHO confirmed — leave whatever is already on file.
  if (decision.confirmedBy) conv.appointment.confirmedBy = decision.confirmedBy;
  conv.appointment.acknowledged = decision.acknowledged;
  if (decision.clearReschedulePending) conv.appointment.reschedulePending = false;
  return decision;
}

// Fired after every manual send. Asks the same referee as every other confirm-record writer
// (lane `salesperson_manual_send`), which is what stops "a manual send may put the customer's word
// on file" from drifting away from the rest of the table.
export function markAppointmentAcknowledged(conv: Conversation) {
  if (!conv.appointment) return;

  if (applyAppointmentConfirmRecord(conv, "salesperson_manual_send").confirm) {
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
  // Collapsing duplicates must not lose the scheduled follow-up time: if only a retiree
  // carried a due date, the survivor adopts the earliest one (Dante Turello class — the
  // richest copy had no dueAt while the staff reminder was due next morning).
  if (retired && plan.keepId && plan.adoptDueAt) {
    const survivor = todos.find(t => t.id === plan.keepId);
    if (survivor && !String(survivor.dueAt ?? "").trim()) survivor.dueAt = plan.adoptDueAt;
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
/**
 * Move an OPEN arrival-notify task onto the arrival we know, in whichever direction that is.
 *
 * Shared by the write path (the upsert below) and the state-reconcile heal, so there is exactly ONE
 * implementation of "the arrival is the authority" and a task cannot be corrected by one lane and
 * left wrong by the other. The decision itself is the pure planPendingIncomingNotifyDueAtUpdate;
 * this function only applies it, plus the reminder bookkeeping that has to touch the record.
 *
 * Returns true when the date actually moved.
 */
export function applyPendingIncomingNotifyArrivalDate(
  task: TodoTask,
  arrivalDueAt: string | null | undefined,
  nowMs: number = Date.parse(nowIso())
): boolean {
  const plan = planPendingIncomingNotifyDueAtUpdate({
    currentDueAt: task.dueAt ?? null,
    arrivalDueAt: arrivalDueAt ?? null,
    nowMs
  });
  if (!plan.changed || !plan.dueAt) return false;
  task.dueAt = plan.dueAt;
  // Keep an EXISTING reminder consistent with the moved date and re-arm it — the same idiom
  // snoozeTodo uses. We deliberately do NOT mint a reminder on a task that had none: this change
  // exists to take noise OUT of the inbox, so it must never add a staff ping that wasn't there.
  if (String(task.reminderAt ?? "").trim()) {
    const lead =
      Number.isFinite(task.reminderLeadMinutes) && (task.reminderLeadMinutes as number) > 0
        ? (task.reminderLeadMinutes as number)
        : 30;
    task.reminderAt = new Date(Date.parse(plan.dueAt) - lead * 60 * 1000).toISOString();
    task.reminderSentAt = undefined;
  }
  return true;
}

/**
 * State-reconcile heal: re-date this conversation's OPEN arrival-notify task onto the arrival the
 * record already stores. This is the backfill for tasks minted before the arrival rule existed, or
 * stamped with a nearer date by another writer — nothing else ever re-dated them, so Mohamed Ahmed
 * +17164258647's task still read due 8/3 for an 8/21 bike five days after #337 shipped.
 *
 * Reads only stored state (no LLM, no prose), and is idempotent: once the task sits on the arrival
 * planPendingIncomingNotifyDueAtUpdate reports no change, so the tick stops touching it. Returns
 * true when the date actually moved.
 */
export function healPendingIncomingNotifyTodoArrivalDate(conv: Conversation): boolean {
  const arrivalAt = String(
    (conv as any)?.pendingIncomingInventory?.expectedArrivalAt ?? ""
  ).trim();
  if (!arrivalAt) return false;
  const task = todos.find(
    t =>
      t.convId === conv.id &&
      t.status === "open" &&
      isPendingIncomingInventoryNotifyTodoSummary(t.summary)
  );
  if (!task) return false;
  if (!applyPendingIncomingNotifyArrivalDate(task, arrivalAt)) return false;
  conv.updatedAt = nowIso();
  scheduleSave();
  return true;
}

/**
 * State-reconcile sweep for the arrival-notify singleton, across every conversation that has one.
 *
 * Two heals on ONE scan, in this order:
 *  1. DEDUP — collapse copies that piled up before the write-time upsert existed (Nicholas Braun:
 *     4 open copies, 2026-06-23). Runs first so step 2 dates the SURVIVOR, not a copy about to go.
 *  2. ARRIVAL DATE — re-date the survivor onto the arrival the record already stores. This is the
 *     backfill for tasks minted before the arrival rule, or stamped with a nearer date by another
 *     writer: Mohamed Ahmed +17164258647's task still read due 8/3 for an 8/21 bike five days
 *     after #337 shipped, because nothing ever re-dated an existing task.
 *
 * Saves each conversation it touched. No LLM and no prose — it reads only stored state — and both
 * heals are idempotent, so a quiet tick does nothing and records nothing.
 */
export function healPendingIncomingNotifyTodosAcross(
  convById: Map<string, Conversation>,
  openTodos: TodoTask[]
): {
  dedup: Array<{ convId: string; leadKey: string; retired: number }>;
  reDated: Array<{ convId: string; leadKey: string; dueAt: string | null }>;
} {
  const convIds = new Set<string>();
  for (const t of openTodos) {
    if (isPendingIncomingInventoryNotifyTodoSummary(t.summary)) convIds.add(t.convId);
  }
  const dedup: Array<{ convId: string; leadKey: string; retired: number }> = [];
  const reDated: Array<{ convId: string; leadKey: string; dueAt: string | null }> = [];
  for (const convId of convIds) {
    const conv = convById.get(convId);
    if (!conv) continue;
    let dirty = false;
    const retired = healPendingIncomingNotifyTodoDuplicates(conv);
    if (retired > 0) {
      dedup.push({ convId: conv.id, leadKey: conv.leadKey, retired });
      dirty = true;
    }
    if (healPendingIncomingNotifyTodoArrivalDate(conv)) {
      const task = todos.find(
        t =>
          t.convId === conv.id &&
          t.status === "open" &&
          isPendingIncomingInventoryNotifyTodoSummary(t.summary)
      );
      reDated.push({ convId: conv.id, leadKey: conv.leadKey, dueAt: task?.dueAt ?? null });
      dirty = true;
    }
    if (dirty) saveConversation(conv);
  }
  return { dedup, reDated };
}

export function upsertPendingIncomingInventoryNotifyTodo(
  conv: Conversation,
  summary: string,
  sourceMessageId?: string,
  owner?: { id?: string | null; name?: string | null },
  /**
   * Due date for the notify task — the unit's EXPECTED ARRIVAL when we know it (Joe ruling
   * 2026-07-29, Mohamed Ahmed +17164258647: "task off the arrival date"). Undefined/null keeps the
   * previous undated behavior, which is the fail-safe: an undated task is merely noisy, whereas
   * dating one wrongly could hide a real follow-through. On an EXISTING task a known future arrival
   * is now the AUTHORITY and moves the date either way — see applyPendingIncomingNotifyArrivalDate.
   */
  dueAt?: string | null
): TodoTask | null {
  healPendingIncomingNotifyTodoDuplicates(conv);
  const survivor = todos.find(
    t =>
      t.convId === conv.id &&
      t.status === "open" &&
      isPendingIncomingInventoryNotifyTodoSummary(t.summary)
  );
  const dueAtIso = String(dueAt ?? "").trim();
  const dueAtMs = dueAtIso ? Date.parse(dueAtIso) : NaN;
  const dueAtUsable = !!dueAtIso && Number.isFinite(dueAtMs);
  if (survivor) {
    survivor.reason = "call";
    survivor.taskClass = "followup";
    if (sourceMessageId) survivor.sourceMessageId = sourceMessageId;
    const ownerId = String(owner?.id ?? conv?.leadOwner?.id ?? "").trim();
    const ownerName = String(owner?.name ?? conv?.leadOwner?.name ?? "").trim();
    if (ownerId) survivor.ownerId = ownerId;
    if (ownerName) survivor.ownerName = ownerName;
    if (dueAtUsable) applyPendingIncomingNotifyArrivalDate(survivor, dueAtIso);
    conv.updatedAt = nowIso();
    scheduleSave();
    return survivor;
  }
  return addTodo(
    conv,
    "call",
    summary,
    sourceMessageId,
    owner,
    dueAtUsable ? { dueAt: dueAtIso } : undefined,
    "followup"
  );
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

// The one place the nudge's summary is composed, so the writer and the recogniser below can never
// drift apart. `who` stays a caller input (display-casing lives in index.ts).
export function buildStaleHandoffNudge(
  conv: Conversation,
  who: string,
  now: Date
): { summary: string; handoffReason: string; idleDays: number } {
  let lastMs = 0;
  for (const m of conv.messages ?? []) {
    const ms = Date.parse(String(m?.at ?? ""));
    if (Number.isFinite(ms) && ms > lastMs) lastMs = ms;
  }
  const idleDays = lastMs ? Math.floor((now.getTime() - lastMs) / 86_400_000) : 0;
  const handoffReason = String(conv.followUp?.reason ?? "handoff").replace(/_/g, " ");
  return {
    summary: `Follow up with ${who} — handed off (${handoffReason}), no activity in ${idleDays} days and no follow-up scheduled.`,
    handoffReason,
    idleDays
  };
}

// The nudge above, recognised by its own template (OUR string, never customer text — same pattern
// as SCHEDULING_LEAK_TODO_MARKER). Matches every generation of the summary in the live store.
export function isStaleHandoffNudgeTodo(todo: Pick<TodoTask, "taskClass" | "summary">): boolean {
  const summary = String(todo?.summary ?? "");
  return (
    String(todo?.taskClass ?? "") === "followup" &&
    summary.includes("handed off (") &&
    summary.includes("no activity in")
  );
}

/**
 * The retire twin of shouldNudgeStaleHandoffLead (Joe, 2026-08-12: "the inbox is overwhelming" —
 * 90 of 136 open tasks were these nudges and 63 of the 90 were themselves over a week old).
 * A nudge exists to say "this handed-off lead has gone quiet"; it stops being true two ways:
 *  - `activity_resumed`: ANY message moved on the thread after the nudge was created — the
 *    premise is gone, whether staff followed up or the customer wrote in.
 *  - `expired`: nobody touched it for EXPIRE days. It retires rather than fossilising; a lead
 *    that is STILL handed-off + quiet re-surfaces as a FRESH nudge via the caller's existing
 *    reNudgeDays window, so expiry can never permanently drop a live lead.
 * A task staff snoozed to a future due time is theirs — expiry leaves it alone (activity still
 * retires it, since resumed activity makes the nudge moot regardless of the snooze).
 * Fail direction: closing a staff reminder never messages a customer, never closes a lead.
 */
export function staleHandoffNudgeRetireReason(
  todo: Pick<TodoTask, "taskClass" | "summary" | "createdAt" | "dueAt" | "reminderAt">,
  conv: Conversation | null | undefined,
  now: Date = new Date(),
  opts?: { expireDays?: number }
): "activity_resumed" | "expired" | null {
  if (!isStaleHandoffNudgeTodo(todo)) return null;
  const createdMs = Date.parse(String(todo?.createdAt ?? ""));
  if (!Number.isFinite(createdMs)) return null;
  const messages = Array.isArray(conv?.messages) ? conv!.messages : [];
  const activityResumed = messages.some(m => {
    if (m?.draftStatus) return false; // a held/stale draft is not activity — nobody saw it
    const ms = Date.parse(String(m?.at ?? ""));
    return Number.isFinite(ms) && ms > createdMs;
  });
  if (activityResumed) return "activity_resumed";
  const snoozedToFuture = [todo?.dueAt, todo?.reminderAt].some(iso => {
    const ms = Date.parse(String(iso ?? ""));
    return Number.isFinite(ms) && ms > now.getTime();
  });
  if (snoozedToFuture) return null;
  const expireMs = (opts?.expireDays ?? 7) * 24 * 60 * 60 * 1000;
  return now.getTime() - createdMs >= expireMs ? "expired" : null;
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
  // Retired for good: the surfaced todo aged out unactioned — stop the re-nudge loop (else the same
  // junk task is recreated every reNudge window forever on a lead nobody is going to first-touch).
  if (conv.firstTouchRetiredAt) return false;
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

/**
 * Summary fragments identifying the two first-touch todo templates (call-preferred / email-draft).
 * Must match the strings the reconcile tick has ALREADY written to production tasks — the resolver
 * below keys on them, exactly like SCHEDULING_LEAK's marker. Own-artifact matching, not customer text.
 */
/**
 * Bookkeeping-notice templates eligible for TTL retirement — an explicit WHITELIST of our own
 * `reason: "note"` summary templates that merely RECORD something that already happened (a staff
 * SMS sent/failed, an arrival heads-up). Their useful life is days; with reason=note ineligible
 * for the LLM fulfillment auto-close and excluded from escalation, nothing else can ever clear
 * them (prod 7/23: four "Business manager outcome prompt sent" notices — two exact duplicates —
 * and a 5-day-old "on my way" arrival note, visit long since happened).
 *
 * WHITELIST, not a blacklist, on purpose: an unknown/new note template is NEVER swept, so an
 * actionable note (photo-ID "reply with match", "Send VIN", held-draft "needs a human", the
 * first-touch tasks) can't be lost by omission — fail direction is "noise lingers", never
 * "work disappears".
 */
export const BOOKKEEPING_NOTE_TTL_MARKERS = [
  "Business manager outcome prompt sent to",
  "Business manager SMS sent to",
  "Business manager SMS failed for",
  "Salesperson SMS failed for",
  "Callback link SMS failed for",
  "Callback reminder SMS failed for",
  "Customer plans pickup/delivery arrival"
] as const;

export const BOOKKEEPING_NOTE_TTL_DAYS = 7;

export function isBookkeepingNoticeTodo(
  todo: Pick<TodoTask, "summary" | "reason"> | null | undefined
): boolean {
  if (String(todo?.reason ?? "") !== "note") return false;
  const s = String(todo?.summary ?? "");
  return BOOKKEEPING_NOTE_TTL_MARKERS.some(m => s.includes(m));
}

/** Pure: an OPEN whitelisted bookkeeping notice older than the TTL should retire. */
export function shouldRetireBookkeepingNotice(
  todo: Pick<TodoTask, "summary" | "reason" | "status" | "createdAt"> | null | undefined,
  now: Date = new Date()
): boolean {
  if (!todo || String(todo.status ?? "") !== "open") return false;
  if (!isBookkeepingNoticeTodo(todo)) return false;
  const createdMs = Date.parse(String(todo.createdAt ?? ""));
  if (!Number.isFinite(createdMs)) return false;
  return now.getTime() - createdMs > BOOKKEEPING_NOTE_TTL_DAYS * 24 * 60 * 60 * 1000;
}

/**
 * Conversation context for a Task Inbox row (task-hygiene Phase 2) — pure. Staff triaging the
 * task list couldn't see WHAT the customer said or WHETHER anyone already replied without
 * opening every conversation (UX audit 7/22: no message preview, no replied indicator — every
 * stale task cost a click to discover it was dead). Three facts per task:
 *   - lastInboundPreview/lastInboundAt: the customer's latest real message, whitespace-collapsed
 *     and capped. An ADF web-lead blob previews as its Inquiry line (the human part), not the
 *     "WEB LEAD (ADF) Source: ..." header noise.
 *   - repliedSinceTaskAt: the newest REAL customer-facing outbound (twilio/sendgrid/human/voice —
 *     not an unsent draft) AFTER the task was created. This is the row's "Replied ✓" signal:
 *     display-only context; it closes nothing (the fulfillment judge owns closes).
 */
export function buildTodoConversationContext(
  conv: Pick<Conversation, "messages"> | null | undefined,
  todo: Pick<TodoTask, "createdAt"> | null | undefined
): { lastInboundPreview: string | null; lastInboundAt: string | null; repliedSinceTaskAt: string | null } {
  const messages = Array.isArray(conv?.messages) ? conv!.messages : [];
  const taskCreatedMs = Date.parse(String(todo?.createdAt ?? ""));
  let lastInbound: { body: string; at: string } | null = null;
  let repliedSinceTaskAt: string | null = null;
  for (const m of messages) {
    const body = String((m as any)?.body ?? "").trim();
    const at = String((m as any)?.at ?? "").trim();
    if (!body || !at) continue;
    if ((m as any)?.direction === "in") {
      if (!lastInbound || at > lastInbound.at) lastInbound = { body, at };
      continue;
    }
    if (
      (m as any)?.direction === "out" &&
      REAL_OUTBOUND_CONTACT_PROVIDERS.has(String((m as any)?.provider ?? "")) &&
      Number.isFinite(taskCreatedMs) &&
      Date.parse(at) > taskCreatedMs
    ) {
      if (!repliedSinceTaskAt || at > repliedSinceTaskAt) repliedSinceTaskAt = at;
    }
  }
  let preview: string | null = null;
  if (lastInbound) {
    let text = lastInbound.body;
    if (/^WEB LEAD \(ADF\)/i.test(text)) {
      // The human part of an ADF blob is its Inquiry section; the rest is routing metadata.
      const inquiry = text.match(/\bInquiry:\s*([\s\S]+)$/i)?.[1]?.trim() ?? "";
      text = inquiry || "New web lead (no written inquiry)";
    }
    preview = text.replace(/\s+/g, " ").trim().slice(0, 140) || null;
  }
  return {
    lastInboundPreview: preview,
    lastInboundAt: lastInbound?.at ?? null,
    repliedSinceTaskAt
  };
}

export const FIRST_TOUCH_TODO_MARKERS = [
  "no first contact has gone out yet",
  "a reply was drafted but never sent"
] as const;

export const FIRST_TOUCH_TODO_MAX_AGE_DAYS = 14;

export function isFirstTouchTodo(todo: Pick<TodoTask, "summary"> | null | undefined): boolean {
  const s = String(todo?.summary ?? "");
  return FIRST_TOUCH_TODO_MARKERS.some(m => s.includes(m));
}

/**
 * Lifecycle decision for an OPEN first-touch todo — pure. The task's objective is "get the first
 * message out", so its resolution is a FACT, not a judgment (AGENTS.md: deterministic side-effect
 * guards are allowed; no LLM needed):
 *   - "close_contacted": a real customer-facing outbound (text/email/call) exists → the objective is
 *     done BY DEFINITION. This is the closer the class never had — reason `note` is ineligible for
 *     the LLM fulfillment auto-close, so "Send the first reply" tasks stayed open even after the
 *     reply went out (Annie +17165361711: replied 7/22, task from 7/2 still open).
 *   - "retire_aged": open past FIRST_TOUCH_TODO_MAX_AGE_DAYS with still no contact → the moment for
 *     a FIRST touch has passed; a month-old cold lead is cadence/stale-handoff territory, and the
 *     task has proven it isn't getting actioned (the 6/25 backfill batch sat 27 days). Callers must
 *     stamp conv.firstTouchRetiredAt so the re-nudge loop can't recreate it.
 *   - "keep": young and still uncontacted — the task is doing its job.
 * FAIL DIRECTION: "close_contacted" only fires on hard evidence of contact; "retire_aged" only
 * after 2 weeks of nobody acting, when the task is noise, not signal. A revived lead (customer
 * writes in) is caught by the unanswered-inbound net regardless.
 */
export function decideFirstTouchTodoResolution(
  conv: Pick<Conversation, "messages"> | null | undefined,
  todo: Pick<TodoTask, "summary" | "createdAt"> | null | undefined,
  now: Date = new Date()
): "close_contacted" | "retire_aged" | "keep" {
  if (!conv || !todo || !isFirstTouchTodo(todo)) return "keep";
  const messages = Array.isArray(conv.messages) ? conv.messages : [];
  const contacted = messages.some(
    m => m?.direction === "out" && REAL_OUTBOUND_CONTACT_PROVIDERS.has(String(m?.provider ?? ""))
  );
  if (contacted) return "close_contacted";
  const createdMs = Date.parse(String(todo.createdAt ?? ""));
  if (
    Number.isFinite(createdMs) &&
    now.getTime() - createdMs > FIRST_TOUCH_TODO_MAX_AGE_DAYS * 24 * 60 * 60 * 1000
  ) {
    return "retire_aged";
  }
  return "keep";
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
  return /finance_no_contact|credit_app|prequal|finance_prequal|unit_hold|order_hold|in_process_deal/.test(
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
  const nowMs = Date.parse(doneAt);
  for (const task of todos) {
    if (task.convId !== convId || task.status !== "open" || task.reason !== "call") continue;
    // A connected call does not deliver a bike that hasn't shipped yet: an arrival-notify task
    // still dated in the FUTURE survives this closer (Joe Catalano +17164324480 — his 8/25 CVO
    // reminder was wiped by an 8/1 call). Referee lives with the task's identity in
    // pendingIncomingInventory.ts; every other call task closes exactly as before.
    if (
      shouldVoiceAttemptKeepArrivalNotifyTaskOpen({
        summary: task.summary,
        dueAt: task.dueAt,
        nowMs
      })
    )
      continue;
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
    // A successful log means the lead resolved after all — clear any stale "not found in TLP"
    // marker so the bookkeeping doesn't keep a dead-end flag around.
    if (conv.crm.leadRefNotFoundAtByLeadRef?.[normalizedLeadRef]) {
      delete conv.crm.leadRefNotFoundAtByLeadRef[normalizedLeadRef];
    }
  }
  conv.updatedAt = nowIso();
  scheduleSave();
}

/** Stamp a CONFIRMED "this lead is not in TLP" outcome for a leadRef. Set only from the logger's
 *  catch path when isTlpLeadNotFoundError(err) is true (a definitive lookup miss, not a transient
 *  portal failure). Read by the catch-up sweep (domain/tlpLogCatchup.ts) to STOP re-hammering a
 *  lead the CRM doesn't have — a newer outbound than this stamp re-opens the attempt. */
export function setCrmLeadRefNotFound(conv: Conversation, iso: string, leadRef: string) {
  const normalizedLeadRef = String(leadRef ?? "").trim();
  if (!normalizedLeadRef) return;
  conv.crm = conv.crm ?? {};
  conv.crm.leadRefNotFoundAtByLeadRef = conv.crm.leadRefNotFoundAtByLeadRef ?? {};
  conv.crm.leadRefNotFoundAtByLeadRef[normalizedLeadRef] = iso;
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

// The ONE place `appointment.bookedBy` is written — the two former copies (index.ts's
// `setAppointmentBookedBy`, which records an attribution a booking path handed in, and
// `onAppointmentBooked`'s fallback, which infers one from `confirmedBy` when nobody did) now ask
// `decideAppointmentAttribution`. See that referee in routeStateReducer.ts for the three
// divergences it preserves — including that a CUSTOMER's confirmation is filed as the agent's
// booking.
//
// The two lanes write DIFFERENT key shapes (six keys explicit, three inferred) and that is
// preserved exactly — the referee returns the record, this only stores it.
//
// Deliberately does NOT stamp `conv.updatedAt` or save: every call site already stamps and saves
// around this, and adding a write here would change persisted timestamps.
export function applyAppointmentAttribution(
  conv: Conversation,
  input: {
    lane: AppointmentAttributionLane;
    /** Explicit lane only: the attribution the booking path handed in. */
    supplied?: Partial<AppointmentAttributionRecord> | null;
  }
): AppointmentAttributionDecision {
  const decision = decideAppointmentAttribution({
    lane: input.lane,
    hasAppointment: Boolean(conv.appointment),
    hasExistingAttribution: Boolean(conv.appointment?.bookedBy),
    supplied: input.supplied,
    confirmedBy: conv.appointment?.confirmedBy ?? null
  });
  if (decision.write && decision.bookedBy && conv.appointment) {
    // The referee speaks in plain strings (it carries no store types); the actor/channel unions are
    // narrowed here. Every value it can produce comes from a caller-supplied record that was already
    // this type, or from the inference table, whose four values are all members of the unions.
    conv.appointment.bookedBy = decision.bookedBy as AppointmentBookedBy;
  }
  return decision;
}

/**
 * The single place the business-manager finance-outcome record is written. Seven lanes across
 * index.ts used to hand-write it; they now all pass through here and ask
 * `decideFinanceOutcomeNotifyState` (routeStateReducer), where the three preserved divergences and
 * the two deliberate keep-what-is-there rules are documented.
 *
 * The caller supplies the clock and the mint, because neither belongs to a pure referee: `nowIso`
 * so a lane that stamps two fields cannot straddle a second, and `mintedToken` so the randomness
 * stays out of the decision. A minted token is DISCARDED when the record already has one.
 */
export function applyFinanceOutcomeNotifyState(
  conv: Conversation,
  input: {
    lane: FinanceOutcomeNotifyLane;
    nowIso: string;
    outcomeStatus?: "approved" | "declined" | "needs_more_info" | null;
    sentStatus?: "approved" | "declined" | "needs_more_info" | null;
    /** `token_mint` only: the candidate token, used only when the record carries none. */
    mintedToken?: string;
    /** `prompt_sent` only. */
    promptSourceMessageId?: string;
    promptUserId?: string;
    promptPhone?: string;
  }
): { decision: FinanceOutcomeNotifyDecision; state: any } {
  const decision = decideFinanceOutcomeNotifyState({
    lane: input.lane,
    outcomeStatus: input.outcomeStatus ?? null,
    sentStatus: input.sentStatus ?? null
  });
  const state = ((conv as any).financeOutcomeNotify = (conv as any).financeOutcomeNotify ?? {});
  if (decision.mintToken && !String(state.outcomeToken ?? "").trim()) {
    state.outcomeToken = String(input.mintedToken ?? "").trim();
  }
  if (decision.status) state.status = decision.status;
  if (decision.stampPendingAt) state.pendingAt = input.nowIso;
  if (decision.answerStamp === "responded") state.outcomePromptRespondedAt = input.nowIso;
  else if (decision.answerStamp === "resolved") state.outcomePromptResolvedAt = input.nowIso;
  else if (decision.answerStamp === "pending_only") state.outcomePendingAt = input.nowIso;
  if (decision.stampPromptSent) {
    state.outcomePromptSentAt = input.nowIso;
    state.lastPromptSourceMessageId = String(input.promptSourceMessageId ?? "").trim() || undefined;
    state.userId = String(input.promptUserId ?? "").trim() || state.userId;
    state.phone = input.promptPhone;
  }
  if (decision.sentLatch) state[decision.sentLatch] = input.nowIso;
  if (decision.touchUpdatedAt) state.updatedAt = input.nowIso;
  return { decision, state };
}

/**
 * The single place a "we already asked about this appointment" mark is written — the 24-hour
 * YES/NO confirmation record and the internal attendance question. Eight lanes across index.ts
 * used to write these by hand (six of them byte-identical copies inside one function); they now
 * all ask `decideAppointmentPromptRecord` (routeStateReducer), where both preserved divergences
 * and the deliberate no-status shape of the attendance mark are documented.
 */
export function applyAppointmentPromptRecord(
  conv: Conversation,
  input: {
    lane: AppointmentPromptLane;
    nowIso: string;
    answer?: "yes" | "no" | null;
    /** `confirmation_reminder_sent` only: which trigger fired, and for when. */
    triggerMeta?: Record<string, unknown>;
  }
): AppointmentPromptRecordDecision {
  const decision = decideAppointmentPromptRecord({ lane: input.lane, answer: input.answer ?? null });
  // NOTE: bound as a plain `const appt = conv.appointment` on purpose. The contention analyzer
  // recognises THAT alias form, so these writes still read as writes of `appointment`; a
  // `(conv as any).appointment` binding makes them invisible and the wiring check vacuous.
  const appt = conv.appointment;
  if (!appt) return decision;
  if (decision.confirmationStatus) {
    appt.confirmation = {
      ...(decision.preserveExistingConfirmation ? (appt.confirmation ?? {}) : {}),
      ...(decision.stampSentAt ? { sentAt: input.nowIso } : {}),
      status: decision.confirmationStatus,
      ...(decision.stampRespondedAt ? { respondedAt: input.nowIso } : {}),
      ...(decision.carryTriggerMeta ? (input.triggerMeta ?? {}) : {})
    };
  }
  if (decision.stampAttendanceQuestionedAt) appt.attendanceQuestionedAt = input.nowIso;
  return decision;
}

/**
 * The single place `inventoryWatch.exactness` is written. Ten copies of the same ladder used to
 * live in index.ts; they now pass their two per-lane flags here and
 * `resolveInventoryWatchExactness` (routeStateReducer) owns the rungs and both divergences.
 *
 * Writes nothing when the ladder does not fire — every original ended without an `else`, leaving
 * the caller's `model_only` literal standing.
 */
export function applyInventoryWatchExactness(
  watch: any,
  opts: { recognisesYearRange: boolean; trimCountsAsDistinguishing: boolean }
): void {
  if (!watch) return;
  const decision = resolveInventoryWatchExactness({
    year: watch.year,
    yearMin: watch.yearMin,
    yearMax: watch.yearMax,
    color: watch.color,
    trim: watch.trim,
    recognisesYearRange: opts.recognisesYearRange,
    trimCountsAsDistinguishing: opts.trimCountsAsDistinguishing
  });
  if (decision.exactness) watch.exactness = decision.exactness;
}

/**
 * The single place the legacy singular watch and the watch LIST are reconciled for reading.
 * Both alert paths used to hand-write the same prefer-list / wrap-singular / backfill block;
 * they now ask `resolveInventoryWatchListNormalization` (routeStateReducer), which is where the
 * deliberate "an explicitly EMPTY list is a statement, not a gap" rule is documented.
 *
 * Returns the watches the caller should read this turn — empty means "skip this lead".
 */
/** How long the pending inventory-watch prompt has been waiting, in hours (null if unknown). */
export function inventoryWatchPendingAgeHours(conv: any, atIso?: string): number | null {
  const askedAtMs = new Date(String(conv?.inventoryWatchPending?.askedAt ?? "")).getTime();
  const atMs = new Date(String(atIso ?? "")).getTime();
  const nowMs = Number.isFinite(atMs) ? atMs : Date.now();
  return Number.isFinite(askedAtMs) && askedAtMs > 0 ? Math.max(0, (nowMs - askedAtMs) / 36e5) : null;
}

/**
 * THE ONLY place that drops `conv.inventoryWatchPending`. Asks
 * `resolveInventoryWatchPendingClear` (routeStateReducer) and performs the write, so the two
 * inbound paths that used to decide for themselves cannot disagree again — see
 * `inventory_watch_pending_clear:eval` for the ruling and the rule table.
 *
 * The dialog-state fallback is RETURNED rather than written: `dialogState` lives behind
 * index.ts-local helpers, and it is a different field with its own writers.
 */
export function applyInventoryWatchPendingClear(
  conv: any,
  input: Omit<InventoryWatchPendingClearInput, "hasInventoryWatchPending" | "inventoryWatchPendingAgeHours"> & {
    atIso?: string;
  }
): { cleared: boolean; clearPrompt: boolean; reasons: string[] } {
  const decision = resolveInventoryWatchPendingClear({
    followUpMode: input.followUpMode,
    followUpReason: input.followUpReason,
    dialogState: input.dialogState,
    hasInventoryWatchPending: !!conv?.inventoryWatchPending,
    inventoryWatchPendingAgeHours: inventoryWatchPendingAgeHours(conv, input.atIso),
    hasWatchIntent: input.hasWatchIntent,
    hasFinanceIntent: input.hasFinanceIntent,
    hasSchedulingIntent: input.hasSchedulingIntent,
    hasDepartmentIntent: input.hasDepartmentIntent,
    parserRequestedClear: input.parserRequestedClear
  });
  let cleared = false;
  if (decision.clearInventoryWatchPending && conv?.inventoryWatchPending) {
    conv.inventoryWatchPending = undefined;
    cleared = true;
  }
  return { cleared, clearPrompt: decision.clearInventoryWatchPrompt, reasons: decision.reasons };
}

/**
 * The conversation-state parser's vocabulary, mapped onto the referee's question. This is the
 * lane that used to clear on a bare `departmentIntent !== "none"`.
 */
export function applyInventoryWatchPendingClearForStateParse(
  conv: any,
  state: {
    stateIntent?: string | null;
    departmentIntent?: string | null;
    clearInventoryWatchPending?: boolean;
  },
  dialogState?: string | null
): { cleared: boolean; clearPrompt: boolean; reasons: string[] } {
  return applyInventoryWatchPendingClear(conv, {
    followUpMode: conv?.followUp?.mode,
    followUpReason: conv?.followUp?.reason,
    dialogState,
    hasWatchIntent:
      state.stateIntent === "inventory_watch" || state.stateIntent === "used_low_mileage_watch",
    hasFinanceIntent: state.stateIntent === "finance_docs",
    hasSchedulingIntent: state.stateIntent === "scheduling",
    hasDepartmentIntent: !!state.departmentIntent && state.departmentIntent !== "none",
    parserRequestedClear: !!state.clearInventoryWatchPending
  });
}

/** The stale-workflow lane, which already carries per-turn intent hints. */
export function applyInventoryWatchPendingClearForIntentHints(
  conv: any,
  dialogState: string | null | undefined,
  hints:
    | {
        hasWatchIntent?: boolean;
        hasFinanceIntent?: boolean;
        hasSchedulingIntent?: boolean;
        hasDepartmentIntent?: boolean;
      }
    | undefined,
  atIso?: string
): { cleared: boolean; clearPrompt: boolean; reasons: string[] } {
  return applyInventoryWatchPendingClear(conv, {
    followUpMode: conv?.followUp?.mode,
    followUpReason: conv?.followUp?.reason,
    dialogState,
    hasWatchIntent: hints?.hasWatchIntent === true,
    hasFinanceIntent: hints?.hasFinanceIntent === true,
    hasSchedulingIntent: hints?.hasSchedulingIntent === true,
    hasDepartmentIntent: hints?.hasDepartmentIntent === true,
    atIso
  });
}

export function applyInventoryWatchListNormalization(
  conv: Conversation
): { watches: InventoryWatch[]; decision: InventoryWatchListNormalizationDecision } {
  const list = conv.inventoryWatches;
  const decision = resolveInventoryWatchListNormalization({
    listLength: list === undefined || list === null ? null : list.length,
    hasSingular: !!conv.inventoryWatch
  });
  if (decision.backfillListFromSingular && conv.inventoryWatch) {
    conv.inventoryWatches = [conv.inventoryWatch];
  }
  const watches =
    decision.source === "list"
      ? (list ?? [])
      : decision.source === "singular" && conv.inventoryWatch
        ? [conv.inventoryWatch]
        : [];
  return { watches, decision };
}

/**
 * PRE-QUALIFICATION STAGE LADDER — the one writer (Joe, 2026-08-11).
 *
 * Asks `decidePrequalTurn` (routeStateReducer) what this turn is for, returns the line to say, and
 * records the only two facts the ladder cannot re-derive: how many times we have invited this lead
 * in, and whether the credit application has gone out. Both reply paths call THIS, so they cannot
 * drift apart, and nothing anywhere else writes `conv.prequalFlow`.
 *
 * Returns "" when the ladder has nothing to add, which is every non-prequal turn and every
 * suppressed, booked or already-sent one.
 */
/**
 * The pre-qualification goal for a FOLLOW-UP turn, or null.
 *
 * Read-only twin of `applyPrequalStageReply`: same referee, same inputs, but it writes NOTHING and
 * returns a goal for the composer instead of a finished sentence. The first touch uses the writer
 * (a fixed ack, no customer turn to answer yet); every turn after it uses this, so the composer can
 * answer whatever the customer actually said and still steer back — Joe, 2026-08-11.
 *
 * `send_credit_app` yields null on purpose: that stage carries a URL, and a customer-facing link is
 * never LLM-composed.
 */
/**
 * A recorded finance APPROVAL is the hottest signal we get, and today it changes nothing.
 *
 * MEASURED 2026-08-11 on `HDFS COA Online`: of the leads whose business manager recorded an outcome,
 * **11 were approved and ZERO of them booked an appointment** — while 10 of the 11 were messaged
 * after the approval. Their financing is arranged and nobody asks them in.
 *
 * ⚠️ THE OTHER TWO OUTCOMES ARE DELIBERATELY NOT HANDLED HERE:
 *  - `declined` — never tell a customer they were declined. Adverse-action notice is the LENDER's
 *    job, the same rule as a `PreQual: N` lead. Today's copy keeps the door open without saying why,
 *    which is right.
 *  - `needs_more_info` — MEASURED as not meaning that. Its `reasonText` is dominated by "Phone number
 *    is not reachable", "4th call attempt that does not go through", "remind stone to follow up".
 *    Staff use it as a catch-all for customers they cannot REACH, so acting on it would text
 *    "can you send a pay stub?" to someone who simply has not answered the phone. The prior fix is a
 *    separate staff disposition for unreachable, not a comprehension change.
 *
 * ⚠️ AND IT NEVER QUOTES THE APPROVAL. The recorded reasons carry amounts ("HD preapproval up to
 * fifty three grand"); an amount, a rate or a term is the business manager's to give, never the
 * agent's. The goal is a TIME, not a number.
 */
const FINANCE_APPROVAL_GOAL_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export function resolveFinanceApprovedAdvanceGoal(conv: Conversation, nowMs?: number): string | null {
  const outcome = (conv as any)?.financeOutcome;
  if (String(outcome?.status ?? "").trim().toLowerCase() !== "approved") return null;
  // A credit approval expires — the staff notes say so themselves ("valid for 30 days"). An approval
  // from three months ago must not drive today's turn.
  const at = Date.parse(String(outcome?.updatedAt ?? ""));
  const now = Number.isFinite(nowMs) ? Number(nowMs) : Date.now();
  if (!Number.isFinite(at) || now - at > FINANCE_APPROVAL_GOAL_MAX_AGE_MS) return null;
  // The four shared suppressions still own the turn — including a booked appointment, which is this
  // goal's own finish line.
  if (advanceEveryReplySuppressed({ appointment: conv.appointment, alreadyPurchased: !!(conv as any).sale })) {
    return null;
  }
  return (
    "their financing is already approved, so the only thing left is finishing up in person — get a " +
    "day and time on the books. Do NOT quote any amount, rate, term or how long the approval lasts: " +
    "those are the business manager's to give, never yours"
  );
}

/**
 * The ONE goal resolver both reply paths call. Lanes are checked in priority order, and an approval
 * outranks everything below it: it is the warmest state a lead can be in.
 */
export function resolveLeadAdvanceGoal(conv: Conversation, creditAppUrl?: string | null): string | null {
  return resolveFinanceApprovedAdvanceGoal(conv) ?? resolvePrequalAdvanceGoal(conv, creditAppUrl);
}

export function resolvePrequalAdvanceGoal(conv: Conversation, creditAppUrl?: string | null): string | null {
  // ONE definition of "is this a prequal lead", read off the lead SOURCE (a machine record).
  const source = String((conv.lead as any)?.source ?? (conv.lead as any)?.leadSource ?? "");
  if (!/prequal|pre-qual/i.test(source)) return null;
  const bikeLabel = String(
    (conv.lead as any)?.vehicle?.model ?? (conv.lead as any)?.vehicle?.description ?? ""
  ).trim();
  const budget = conv.paymentBudgetContext;
  const decision = decidePrequalTurn({
    isPrequalLead: true,
    suppressed: advanceEveryReplySuppressed({ appointment: conv.appointment, alreadyPurchased: !!(conv as any).sale }),
    appointmentBooked: !!(conv.appointment?.whenIso || (conv.appointment as any)?.whenText),
    bikeUnknown: !bikeLabel || isPlaceholderModel(bikeLabel),
    budgetKnown: !!(budget?.monthlyBudget || budget?.downPayment),
    visitOffersMade: Number(conv.prequalFlow?.visitOffersMade ?? 0),
    visitNotPossible: false,
    creditAppSentAt: conv.prequalFlow?.creditAppSentAt ?? null,
    creditAppAvailable: /^https?:\/\//i.test(String(creditAppUrl ?? "")),
    prequalResult: readPrequalSubmissionResult((conv.lead as any)?.inquiry)
  });
  return buildPrequalStageGoal(decision.stage, bikeLabel);
}

export function applyPrequalStageReply(
  conv: Conversation,
  input: {
    isPrequalLead: boolean;
    /** The SAME shape both ack call sites already build; judged by the shared suppression referee. */
    suppression?: { needsEmpathy?: boolean | null; dispositionClosing?: boolean | null; alreadyPurchased?: boolean | null; appointment?: any };
    visitNotPossible?: boolean;
    creditAppUrl?: string | null;
    nowIso?: string;
  }
): string {
  const bikeLabel = String(
    (conv.lead as any)?.vehicle?.model ?? (conv.lead as any)?.vehicle?.description ?? ""
  ).trim();
  const budget = conv.paymentBudgetContext;
  const creditAppUrl = String(input.creditAppUrl ?? "").trim();
  // The lender's own verdict, off the ADF form. `unknown` on 22 of 42 leads, and it changes nothing.
  const prequalResult = readPrequalSubmissionResult((conv.lead as any)?.inquiry);
  const decision = decidePrequalTurn({
    isPrequalLead: input.isPrequalLead,
    suppressed: advanceEveryReplySuppressed(input.suppression ?? {}),
    appointmentBooked: !!(conv.appointment?.whenIso || (conv.appointment as any)?.whenText),
    // "Unknown" means missing OR a catch-all like "Harley-Davidson Full Line" — 19 of 27 measured
    // prequal leads DO name a real bike and must never be asked which one they meant.
    bikeUnknown: !bikeLabel || isPlaceholderModel(bikeLabel),
    budgetKnown: !!(budget?.monthlyBudget || budget?.downPayment),
    visitOffersMade: Number(conv.prequalFlow?.visitOffersMade ?? 0),
    visitNotPossible: !!input.visitNotPossible,
    creditAppSentAt: conv.prequalFlow?.creditAppSentAt ?? null,
    creditAppAvailable: /^https?:\/\//i.test(creditAppUrl),
    prequalResult
  });
  const line = buildPrequalStageLine({ stage: decision.stage, bikeLabel, creditAppUrl, prequalResult });
  if (!line) return "";

  const now = input.nowIso ?? new Date().toISOString();
  const flow = conv.prequalFlow ?? {};
  // Count the invitation only when one is actually going out, or "we tried twice" would be a lie.
  if (decision.stage === "offer_visit") flow.visitOffersMade = Number(flow.visitOffersMade ?? 0) + 1;
  // Stamped the moment it is composed, so a retry or a second path can never send a second one.
  if (decision.stage === "send_credit_app") flow.creditAppSentAt = now;
  flow.lastStage = decision.stage;
  flow.updatedAt = now;
  conv.prequalFlow = flow;
  return line;
}

/**
 * "Couldn't reach them" — recorded, and deliberately NOT stored as a finance outcome.
 *
 * MEASURED 2026-08-11: of 14 finance tasks marked `needs_more_info`, most were really this ("Phone
 * number is not reachable", "4th call attempt that does not go through", "Call will not go through").
 * A lender-contingency bucket was carrying "we cannot get hold of them", which is how anything acting
 * on it ends up asking a customer for a pay stub when nobody has answered the phone.
 *
 * So this writes NO `financeOutcome`. It stops the business-manager prompt nagging (the manager DID
 * answer) and leaves a task, because the outcome is still unknown and a person still owns it.
 */
export function recordFinanceCustomerUnreachable(
  conv: Conversation,
  input: { note?: string | null; token: string; nowIso: string }
): void {
  applyFinanceOutcomeNotifyState(conv, { lane: "public_link_unreachable", nowIso: input.nowIso });
  const note = String(input.note ?? "").trim();
  addTodo(
    conv,
    "note",
    `Could not reach the customer about the credit application${note ? `: ${note}` : "."} Finance outcome still unknown.`,
    `public_finance_outcome:${input.token}`
  );
  saveConversation(conv);
}

/**
 * Email-tab display honesty (2026-08-15, operator report +15852503838 "Email does not respond
 * correctly like the sms").
 *
 * `conv.emailDraft` is a LIVE, SENDABLE draft — the console's Email tab renders it and staff send it
 * verbatim. But it is generated once, as a static template keyed to `classification.bucket` / `cta`,
 * and then NEVER re-read against what has since happened in the thread. Measured on the live store
 * 2026-08-15: 223 conversations carried a live `emailDraft` and **134 of them had moved past it** —
 * 131 on closed/sold threads, plus open threads whose credit application had already been decided.
 *
 * This does NOT rewrite or delete anything (the stored field is left exactly as it is, so the change
 * is reversible and no customer data is touched). It only decides whether the draft is still honest
 * enough to be OFFERED as sendable. Fail direction is the safe one: suppressing means the Email tab
 * opens empty and a human writes the reply themselves — never a wrong send.
 *
 * Two rules, both pure state checks on records we wrote ourselves — no reading of customer intent:
 *
 *  1. THREAD CLOSED / SOLD. A finished thread has no honest use for a first-touch template. This is
 *     the bulk of it (131 records), including `customer_stepping_back` and `manual_archive` — the
 *     exact states where re-offering "happy to help with pricing, options, and availability" is
 *     worst.
 *  2. A CREDIT DECISION HAS LANDED and the draft still promises the callback that decision replaced.
 *     Deliberately content-conditioned rather than "any finance outcome": measured against the real
 *     store, a blanket rule would have wrongly suppressed Owen (+15857462112, declined, whose draft
 *     already reflects the decline) and Jim (+17163275913, approved, "Sounds good."), while the
 *     record that actually needed it — Jessica (+15853564919, approved 8/12, still promising "our
 *     finance team will reach out shortly") — sits on an OPEN thread that rule 1 never reaches.
 *     The phrase match is an invariant guard on OUR OWN generated copy, not comprehension of a
 *     customer message.
 *
 * Related: the declined-side twin is `resolveFinanceOutcomeNotify`'s territory; draft GENERATION
 * reading `conv.financeOutcome` in either polarity is the upstream fix and is still open.
 */
export type EmailDraftSuppressionReason = "thread_closed" | "finance_outcome_landed";

const EMAIL_DRAFT_PENDING_FINANCE_CALLBACK =
  /\b(finance|business)\s+(team|manager|department)\b[^.!?]{0,80}\b(will|to)\s+(reach out|contact|call|be in touch|follow up)/i;

/** True iff the stored email draft still promises the finance callback a decision has replaced. */
export function emailDraftPromisesPendingFinanceCallback(draft: string): boolean {
  return EMAIL_DRAFT_PENDING_FINANCE_CALLBACK.test(String(draft ?? ""));
}

/**
 * The referee. Returns the draft to render, plus why it was withheld when it was.
 * Both `/conversations/:id` and any other surface that offers the draft to staff must ask this
 * rather than reading `conv.emailDraft` directly.
 */
export function resolveEmailDraftForDisplay(conv: Conversation | null | undefined): {
  emailDraft: string | null;
  suppressedReason: EmailDraftSuppressionReason | null;
} {
  const draft = String(conv?.emailDraft ?? "").trim();
  if (!conv || !draft) return { emailDraft: conv?.emailDraft ?? null, suppressedReason: null };
  if (conv.closedAt || conv.closedReason || conv.status === "closed" || conv.sale?.soldAt) {
    return { emailDraft: null, suppressedReason: "thread_closed" };
  }
  if (conv.financeOutcome?.status && emailDraftPromisesPendingFinanceCallback(draft)) {
    return { emailDraft: null, suppressedReason: "finance_outcome_landed" };
  }
  return { emailDraft: conv.emailDraft ?? null, suppressedReason: null };
}

/**
 * Everything `/conversations/:id` has to decide about DISPLAY honesty, in one place.
 *
 * `followUpHold`: a held follow-up mode freezes the cadence's `nextDueAt` (the tick skips the conv),
 * so the console must render "on hold" instead of an overdue date. Post-sale cadences keep running
 * through a hold, so they stay honest without the flag. (Same expression the list endpoint uses.)
 *
 * `emailDraft` / `emailDraftSuppressedReason`: see `resolveEmailDraftForDisplay`. The reason is
 * returned, not swallowed — a surface that hides something must be able to say why.
 */
export function resolveConversationDetailDisplay(conv: Conversation): {
  emailDraft: string | null;
  emailDraftSuppressedReason: EmailDraftSuppressionReason | null;
  followUpHold: true | null;
} {
  const { emailDraft, suppressedReason } = resolveEmailDraftForDisplay(conv);
  return {
    emailDraft,
    emailDraftSuppressedReason: suppressedReason,
    followUpHold: isFollowUpCadenceHeld(conv.followUp?.mode, conv.followUpCadence?.kind) ? true : null
  };
}
