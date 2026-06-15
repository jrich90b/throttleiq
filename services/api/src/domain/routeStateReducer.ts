export type RouteStateReducerInput = {
  provider: string;
  channel: "sms" | "email";
  isShortAck: boolean;
  deterministicAvailabilityLookup?: boolean;
  availabilityIntentOverride?: boolean;
  financePriorityOverride?: boolean;
  schedulePriorityOverride?: boolean;
  dealerRideNoPurchaseAdf?: boolean;
};

export type RouteStateDecision =
  | { kind: "skip"; note: "short_ack_no_action" | "dealer_ride_no_purchase_manual_handoff"; draft?: string }
  | { kind: "continue" };

export type TurnPrimaryIntent =
  | "pricing_payments"
  | "scheduling"
  | "callback"
  | "availability"
  | "general";

export type TurnIntentPlannerInput = {
  financePriorityOverride?: boolean;
  schedulePriorityOverride?: boolean;
  availabilityIntentOverride?: boolean;
  hasPricingIntent?: boolean;
  hasSchedulingIntent?: boolean;
  hasAvailabilityIntent?: boolean;
  callbackRequested?: boolean;
};

export type TurnIntentPlannerDecision = {
  primaryIntent: TurnPrimaryIntent;
  pricingIntent: boolean;
  schedulingIntent: boolean;
  callbackIntent: boolean;
  availabilityIntent: boolean;
};

export type RouteDecisionSnapshot = {
  parserIntentOverride: TurnPrimaryIntent | null;
  plannerPrimaryIntent: TurnPrimaryIntent;
  primaryIntent: TurnPrimaryIntent;
  pricingIntent: boolean;
  schedulingIntent: boolean;
  callbackIntent: boolean;
  availabilityIntent: boolean;
  financePriorityOverride: boolean;
  schedulePriorityOverride: boolean;
  availabilityIntentOverride: boolean;
};

export type RouteActionableContextInput = {
  primaryIntent?: TurnPrimaryIntent | null;
  financeSignal?: boolean;
  availabilitySignal?: boolean;
  schedulingSignal?: boolean;
  callbackSignal?: boolean;
  hasMonthlyBudgetContext?: boolean;
  hasDownPaymentContext?: boolean;
  hasTermContext?: boolean;
};

export type RouteActionableContextDecision = {
  hasActionableFinanceContext: boolean;
  hasActionableAvailabilityContext: boolean;
  hasActionableSchedulingContext: boolean;
  hasActionableCallbackContext: boolean;
  hasActionableTurnContext: boolean;
};

export type RoutingParserIntent = TurnPrimaryIntent | "none";
export type RoutingParserFallbackAction = "none" | "clarify" | "no_response";

export type RoutingParserDecisionInput = {
  parserIntent?: RoutingParserIntent | null;
  parserFallbackAction?: RoutingParserFallbackAction | null;
  parserClarifyPrompt?: string | null;
  parserConfidence?: number | null;
  parserConfidenceMin?: number;
};

export type RoutingParserDecision = {
  accepted: boolean;
  intentOverride: TurnPrimaryIntent | null;
  fallbackAction: RoutingParserFallbackAction;
  clarifyPrompt: string | null;
  reason:
    | "accepted"
    | "below_confidence"
    | "no_signal"
    | "intent_override"
    | "clarify_fallback"
    | "no_response_fallback";
};

export type NoResponseFallbackDecision = RouteActionableContextDecision & {
  shouldSkipNoResponse: boolean;
};

export type NoResponsePolicyAction =
  | "skip"
  | "override"
  | "ack_progress_update"
  | "ack_manual_handoff_question";

export type NoResponsePolicyInput = {
  hasParserNoResponse: boolean;
  actionable: RouteActionableContextDecision;
  isLogisticsProgressUpdate?: boolean;
  isManualHandoff?: boolean;
  manualHandoffQuestionCandidate?: boolean;
  smallTalkQuestionCandidate?: boolean;
  allowManualHandoffQuestionAck?: boolean;
  hasExplicitFinanceSignal?: boolean;
  hasExplicitAvailabilitySignal?: boolean;
  hasExplicitSchedulingSignal?: boolean;
  hasExplicitCallbackSignal?: boolean;
};

export type NoResponsePolicyDecision = {
  applicable: boolean;
  action: NoResponsePolicyAction;
  reason:
    | "not_no_response_fallback"
    | "small_talk_question_ack"
    | "context_only_actionable_guard"
    | "actionable_context_present"
    | "progress_update_ack"
    | "manual_handoff_question_ack"
    | "no_actionable_context";
};

export type StaleStateCleanupInput = {
  followUpMode?: string | null;
  followUpReason?: string | null;
  dialogState?: string | null;
  hasInventoryWatchPending?: boolean;
  inventoryWatchPendingAgeHours?: number | null;
  hasWatchIntent?: boolean;
  hasFinanceIntent?: boolean;
  hasSchedulingIntent?: boolean;
  hasAvailabilityIntent?: boolean;
  hasDepartmentIntent?: boolean;
};

export type StaleStateCleanupDecision = {
  clearInventoryWatchPending: boolean;
  setDialogStateToNone: boolean;
  clearManualAppointmentHandoff: boolean;
  clearManualDepartmentHandoff: boolean;
  reasons: string[];
};

export type TestRideBikeSelectionInput = {
  inboundText?: string | null;
  lastOutboundText?: string | null;
  dialogState?: string | null;
  classificationBucket?: string | null;
  classificationCta?: string | null;
  mentionedModelCount?: number;
};

export const DEALER_RIDE_NO_PURCHASE_SKIP_DRAFT =
  "Customer thank-you draft needed — dealer ride outcome still requires salesperson follow-up.";

export function nextActionFromState(input: RouteStateReducerInput): RouteStateDecision {
  if (input.dealerRideNoPurchaseAdf) {
    return {
      kind: "skip",
      note: "dealer_ride_no_purchase_manual_handoff",
      draft: DEALER_RIDE_NO_PURCHASE_SKIP_DRAFT
    };
  }

  // Parser-first routing: deterministic regex lookups are disabled by default.
  // Availability handling still occurs later via parser-driven intent paths.

  return { kind: "continue" };
}

export function resolveTurnPrimaryIntent(input: TurnIntentPlannerInput): TurnIntentPlannerDecision {
  const pricingIntent = !!input.hasPricingIntent || !!input.financePriorityOverride;
  const schedulingIntent =
    !pricingIntent && (!!input.hasSchedulingIntent || !!input.schedulePriorityOverride);
  const callbackIntent = !pricingIntent && !schedulingIntent && !!input.callbackRequested;
  const availabilityIntent =
    !pricingIntent &&
    !schedulingIntent &&
    !callbackIntent &&
    (!!input.hasAvailabilityIntent || !!input.availabilityIntentOverride);
  const primaryIntent: TurnPrimaryIntent = pricingIntent
    ? "pricing_payments"
    : schedulingIntent
      ? "scheduling"
      : callbackIntent
        ? "callback"
        : availabilityIntent
          ? "availability"
          : "general";
  return {
    primaryIntent,
    pricingIntent,
    schedulingIntent,
    callbackIntent,
    availabilityIntent
  };
}

export function buildRouteDecisionSnapshot(input: {
  parserIntentOverride?: TurnPrimaryIntent | null;
  hasPricingIntent?: boolean;
  hasSchedulingIntent?: boolean;
  hasAvailabilityIntent?: boolean;
  callbackRequested?: boolean;
  financePriorityOverride?: boolean;
  schedulePriorityOverride?: boolean;
  availabilityIntentOverride?: boolean;
}): RouteDecisionSnapshot {
  const financePriorityOverride = !!input.financePriorityOverride;
  const schedulePriorityOverride = !!input.schedulePriorityOverride;
  const availabilityIntentOverride = !!input.availabilityIntentOverride;
  const planner = resolveTurnPrimaryIntent({
    hasPricingIntent: !!input.hasPricingIntent,
    hasSchedulingIntent: !!input.hasSchedulingIntent,
    hasAvailabilityIntent: !!input.hasAvailabilityIntent,
    callbackRequested: !!input.callbackRequested,
    financePriorityOverride,
    schedulePriorityOverride,
    availabilityIntentOverride
  });
  const parserIntentOverride =
    input.parserIntentOverride && input.parserIntentOverride !== "general"
      ? input.parserIntentOverride
      : null;
  const primaryIntent = parserIntentOverride ?? planner.primaryIntent;
  return {
    parserIntentOverride,
    plannerPrimaryIntent: planner.primaryIntent,
    primaryIntent,
    pricingIntent: primaryIntent === "pricing_payments",
    schedulingIntent: primaryIntent === "scheduling",
    callbackIntent: primaryIntent === "callback",
    availabilityIntent: primaryIntent === "availability",
    financePriorityOverride,
    schedulePriorityOverride,
    availabilityIntentOverride
  };
}

// ---------------------------------------------------------------------------
// Scheduling-cluster route precedence (Phase 0 of the routing-de-tangle program).
//
// The /webhooks/twilio handler decides the scheduling cluster — arrival-window ack
// vs future-day visit commitment vs tentative window vs decline vs appointment-status
// question vs immediate arrival vs purchase-delivery vs accept-tentative vs ask-for-
// times — as a chain of inline `if` blocks whose precedence was implicit in their
// order. That ordering is the soil the Todd Herian bug grew in (appointment-timing's
// arrival_update block ran before the schedule-status block, so a visit commitment got
// the vague arrival ack). This function is the single, testable source of truth for
// that precedence; the handler switches on `kind` and keeps the arm bodies (calendar
// checks, todos, cadence re-anchor, replies) inline.
//
// Precedence (faithfully reproduces the current block order):
//   A. customer-ack actions  (highest — the live customer-ack block runs first and
//      always returns once entered)
//   B. appointment-timing intents
//   C. recognized future-day visit commitment (schedule_context_status_update)
// with the Todd rule folded in: a visit commitment preempts the arrival-window ack
// (provide_arrival_window / arrival_update) but NOT the other A/B arms.
// ---------------------------------------------------------------------------

export type SchedulingTurnKind =
  | "accept_tentative"
  | "ask_available_times"
  | "appointment_status_question"
  | "arrival_window"
  | "immediate_arrival"
  | "purchase_delivery"
  | "arrival_update"
  | "tentative_window"
  | "decline_time"
  | "visit_commitment"
  | "none";

export type SchedulingTurnInput = {
  // Block A — customer-ack parser (action string + whether the parse was accepted).
  customerAckActionAccepted: boolean;
  customerAckAction?: string | null;
  // Block B — appointment-timing parser (intent string + whether accepted).
  appointmentTimingAccepted: boolean;
  appointmentTimingIntent?: string | null;
  // Block C — inbound_reply_action schedule_context_status_update (accepted).
  parserScheduleStatusUpdate: boolean;
  // Context gates available where the decision is computed.
  pricingOrPaymentsIntent: boolean;
  scheduleDialogState: boolean;
  scheduleOfferContext: boolean;
};

export type SchedulingTurnDecision = {
  kind: SchedulingTurnKind;
  /** A recognized future-day visit commitment holds (parser + active schedule context). */
  visitCommitment: boolean;
};

export function decideSchedulingTurn(input: SchedulingTurnInput): SchedulingTurnDecision {
  // Same recognition as workflowRegressionGuards.scheduleStatusCommitmentOutranksArrivalAck:
  // a visit commitment requires the parser signal AND an active schedule/visit context.
  const visitCommitment =
    !!input.parserScheduleStatusUpdate &&
    !!input.scheduleDialogState &&
    !!input.scheduleOfferContext;

  // Block A — customer-ack actions. Mirrors the live customer-ack block: it only fires
  // for these actions and (once entered) always returns, so it has top precedence.
  if (input.customerAckActionAccepted && !input.pricingOrPaymentsIntent) {
    switch (input.customerAckAction) {
      case "accept_tentative_appointment":
        return { kind: "accept_tentative", visitCommitment };
      case "ask_for_available_times":
        return { kind: "ask_available_times", visitCommitment };
      case "appointment_status_question":
        return { kind: "appointment_status_question", visitCommitment };
      case "provide_arrival_window":
        // Visit commitment preempts the vague arrival-window ack (the Todd rule).
        if (!visitCommitment) return { kind: "arrival_window", visitCommitment };
        break;
      case "immediate_arrival_request":
        return { kind: "immediate_arrival", visitCommitment };
      case "purchase_delivery_update":
        return { kind: "purchase_delivery", visitCommitment };
      default:
        break; // non-cluster ack action → fall through to appointment-timing
    }
  }

  // Block B — appointment-timing intents (reached only when A didn't claim the turn).
  if (input.appointmentTimingAccepted && !input.pricingOrPaymentsIntent) {
    if (input.appointmentTimingIntent === "arrival_update" && !visitCommitment) {
      return { kind: "arrival_update", visitCommitment };
    }
    if (input.appointmentTimingIntent === "tentative_time_window") {
      return { kind: "tentative_window", visitCommitment };
    }
    if (input.appointmentTimingIntent === "decline_time") {
      return { kind: "decline_time", visitCommitment };
    }
  }

  // Block C — recognized future-day visit commitment. The handler additionally gates
  // this on the top-level route (no pricing/availability/callback) where routeExec* is
  // known; this function owns the visit-commitment recognition + precedence.
  if (visitCommitment) return { kind: "visit_commitment", visitCommitment };

  return { kind: "none", visitCommitment };
}

// The finance/pricing cluster — the pricing-CONTINUATION sub-decision.
//
// Once a turn is routed to pricing_payments (routeExecPricing, derived from the
// parser via buildRouteDecisionSnapshot) and carries no live scheduling signal, the
// /webhooks/twilio handler picks between two adjacent arms by inline block order: a
// manual-quote-details-received state update, then the finance follow-up
// continuation. This function is the single source of truth for that precedence and
// the shared scheduling-suppression gate, so /webhooks/twilio and
// /conversations/:id/regenerate cannot drift. The arm bodies (state writes, reply
// copy, payment-budget sub-branching) stay inline in index.ts.
//
// Scope note: this owns ONLY the contiguous, parser-route-gated pricing-continuation
// pair. The other finance-cluster arms — affordability objection, lien-holder info,
// payment-numbers status — are non-contiguous early-return guards evaluated upstream
// (before routeExecPricing is even computed), with non-finance routing interleaved
// between them. By the fail-direction test (AGENTS.md) the lien + payment-numbers
// guards are side-effect/handoff KEEPs, not comprehension to migrate. Folding any of
// them into this switch would reorder them relative to that interleaved routing and
// is intentionally NOT done here. A new pricing-continuation arm extends this
// function + its decision table — never a new inline precedence gate.
//
// Precedence (faithfully reproduces the current /webhooks/twilio block order):
//   gate G = pricing route AND no live scheduling/availability signal this turn
//   under G:  manual_quote_details  >  finance_followup_continuation
// ---------------------------------------------------------------------------

export type FinancePricingTurnKind =
  | "manual_quote_details"
  | "finance_followup_continuation"
  | "none";

export type FinancePricingTurnInput = {
  // Parser-derived route: turnPrimaryIntent === "pricing_payments".
  routeExecPricing: boolean;
  // Scheduling-suppression gate — any live scheduling/availability signal this turn
  // defers the pricing-continuation arms (the customer is talking timing, not money).
  availabilitySignal: boolean; // explicitAvailabilitySignalThisTurn
  schedulingDayTime: boolean; // schedulingSignals.hasDayTime
  schedulingDayOnlyRequest: boolean; // schedulingSignals.hasDayOnlyRequest
  schedulingDayOnlyAvailability: boolean; // schedulingSignals.hasDayOnlyAvailability
  explicitScheduleSignal: boolean; // explicitScheduleSignal
  // Arm signals (computed at the decision point in the handler).
  manualQuoteDetailsReceived: boolean; // shouldHandleManualQuoteDetailsReceived(...)
  financeFollowUpContinuation: boolean; // financeFollowUpContinuationSignal
};

export type FinancePricingTurnDecision = {
  kind: FinancePricingTurnKind;
};

export function decideFinancePricingTurn(
  input: FinancePricingTurnInput
): FinancePricingTurnDecision {
  const schedulingDefers =
    input.availabilitySignal ||
    input.schedulingDayTime ||
    input.schedulingDayOnlyRequest ||
    input.schedulingDayOnlyAvailability ||
    input.explicitScheduleSignal;

  if (input.routeExecPricing && !schedulingDefers) {
    // Manual-quote-details state update runs first (handler block order).
    if (input.manualQuoteDetailsReceived) return { kind: "manual_quote_details" };
    if (input.financeFollowUpContinuation) {
      return { kind: "finance_followup_continuation" };
    }
  }

  return { kind: "none" };
}

// --- Appointment/stop-in invite A/B experiment (2026-06-14) ---------------
// The appointment-invite cadence message is our lowest-replying touch with real
// volume (5.9% reply vs ~30% for soft check-ins, 6/14 snapshot). We A/B the copy
// to learn whether a warmer, reason-to-come-in register lifts replies/bookings.
//
// Assignment is a PURE, deterministic 50/50 split of conversation id (no stored
// state, no randomness — same conv always lands in the same arm), so it is
// identical in the live cadence tick and the regenerate path and the offline
// report can recompute each conversation's arm without any message tagging.
export type CadenceInviteArm = "control" | "challenger";

export function decideCadenceInviteArm(conversationId: string): CadenceInviteArm {
  const id = String(conversationId ?? "");
  if (!id) return "control";
  // FNV-1a 32-bit hash for a stable, well-distributed split.
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) % 2 === 0 ? "control" : "challenger";
}

export function resolveRoutingParserDecision(input: RoutingParserDecisionInput): RoutingParserDecision {
  const confidence = Number.isFinite(Number(input.parserConfidence))
    ? Number(input.parserConfidence)
    : 0;
  const confidenceMin = Number.isFinite(Number(input.parserConfidenceMin))
    ? Math.max(0, Math.min(1, Number(input.parserConfidenceMin)))
    : 0.72;
  if (confidence < confidenceMin) {
    return {
      accepted: false,
      intentOverride: null,
      fallbackAction: "none",
      clarifyPrompt: null,
      reason: "below_confidence"
    };
  }

  const parserIntent = String(input.parserIntent ?? "none").toLowerCase();
  const parserFallbackAction = String(input.parserFallbackAction ?? "none").toLowerCase();
  const parserClarifyPrompt = String(input.parserClarifyPrompt ?? "").trim() || null;

  const intentOverride: TurnPrimaryIntent | null =
    parserIntent === "pricing_payments" ||
    parserIntent === "scheduling" ||
    parserIntent === "callback" ||
    parserIntent === "availability" ||
    parserIntent === "general"
      ? (parserIntent as TurnPrimaryIntent)
      : null;

  if (intentOverride && intentOverride !== "general") {
    return {
      accepted: true,
      intentOverride,
      fallbackAction: "none",
      clarifyPrompt: null,
      reason: "intent_override"
    };
  }

  if (parserFallbackAction === "no_response") {
    return {
      accepted: true,
      intentOverride: null,
      fallbackAction: "no_response",
      clarifyPrompt: null,
      reason: "no_response_fallback"
    };
  }

  if (parserFallbackAction === "clarify") {
    return {
      accepted: true,
      intentOverride: null,
      fallbackAction: "clarify",
      clarifyPrompt:
        parserClarifyPrompt ??
        "Quick check — are you asking about payments, availability, or setting a time to come in?",
      reason: "clarify_fallback"
    };
  }

  if (intentOverride === "general") {
    return {
      accepted: true,
      intentOverride,
      fallbackAction: "none",
      clarifyPrompt: null,
      reason: "accepted"
    };
  }

  return {
    accepted: false,
    intentOverride: null,
    fallbackAction: "none",
    clarifyPrompt: null,
    reason: "no_signal"
  };
}

export function summarizeRouteActionableContext(
  input: RouteActionableContextInput
): RouteActionableContextDecision {
  const primaryIntent = input.primaryIntent ?? "general";
  const hasActionableFinanceContext =
    primaryIntent === "pricing_payments" ||
    !!input.financeSignal ||
    !!input.hasMonthlyBudgetContext ||
    !!input.hasDownPaymentContext ||
    !!input.hasTermContext;
  const hasActionableAvailabilityContext =
    primaryIntent === "availability" || !!input.availabilitySignal;
  const hasActionableSchedulingContext =
    primaryIntent === "scheduling" || !!input.schedulingSignal;
  const hasActionableCallbackContext =
    primaryIntent === "callback" || !!input.callbackSignal;
  return {
    hasActionableFinanceContext,
    hasActionableAvailabilityContext,
    hasActionableSchedulingContext,
    hasActionableCallbackContext,
    hasActionableTurnContext:
      hasActionableFinanceContext ||
      hasActionableAvailabilityContext ||
      hasActionableSchedulingContext ||
      hasActionableCallbackContext
  };
}

export function evaluateNoResponseFallback(
  input: RouteActionableContextInput
): NoResponseFallbackDecision {
  const actionable = summarizeRouteActionableContext(input);
  return {
    ...actionable,
    shouldSkipNoResponse: !actionable.hasActionableTurnContext
  };
}

export function resolveNoResponsePolicyDecision(
  input: NoResponsePolicyInput
): NoResponsePolicyDecision {
  if (!input.hasParserNoResponse) {
    return {
      applicable: false,
      action: "override",
      reason: "not_no_response_fallback"
    };
  }
  if (input.smallTalkQuestionCandidate) {
    return {
      applicable: true,
      action: "skip",
      reason: "small_talk_question_ack"
    };
  }
  const hasExplicitSignal =
    !!input.hasExplicitFinanceSignal ||
    !!input.hasExplicitAvailabilitySignal ||
    !!input.hasExplicitSchedulingSignal ||
    !!input.hasExplicitCallbackSignal;
  if (input.actionable.hasActionableTurnContext && !hasExplicitSignal) {
    return {
      applicable: true,
      action: "skip",
      reason: "context_only_actionable_guard"
    };
  }
  if (input.actionable.hasActionableTurnContext) {
    return {
      applicable: true,
      action: "override",
      reason: "actionable_context_present"
    };
  }
  if (input.isLogisticsProgressUpdate) {
    return {
      applicable: true,
      action: "ack_progress_update",
      reason: "progress_update_ack"
    };
  }
  if (
    input.allowManualHandoffQuestionAck &&
    input.isManualHandoff &&
    input.manualHandoffQuestionCandidate
  ) {
    return {
      applicable: true,
      action: "ack_manual_handoff_question",
      reason: "manual_handoff_question_ack"
    };
  }
  return {
    applicable: true,
    action: "skip",
    reason: "no_actionable_context"
  };
}

export function buildNoResponseFallbackReply(actionable: RouteActionableContextDecision): string {
  if (actionable.hasActionableFinanceContext) {
    return "I’ll have someone check the payment options and follow up shortly.";
  }
  if (actionable.hasActionableAvailabilityContext) {
    return "I’ll check availability and follow up shortly.";
  }
  if (actionable.hasActionableSchedulingContext) {
    return "I’ll check the schedule and follow up shortly.";
  }
  if (actionable.hasActionableCallbackContext) {
    return "Got it — I’ll have someone follow up with you shortly.";
  }
  return "I’ll check that and follow up shortly.";
}

export function buildNoResponseFallbackTodoSummary(actionable: RouteActionableContextDecision): string {
  if (actionable.hasActionableFinanceContext) {
    return "Follow up on payment or finance question. The reply pipeline did not produce a confident customer-facing answer.";
  }
  if (actionable.hasActionableAvailabilityContext) {
    return "Follow up on inventory availability question. The reply pipeline did not produce a confident customer-facing answer.";
  }
  if (actionable.hasActionableSchedulingContext) {
    return "Follow up on scheduling request. The reply pipeline did not produce a confident customer-facing answer.";
  }
  if (actionable.hasActionableCallbackContext) {
    return "Customer needs a callback or staff follow-up. The reply pipeline did not produce a confident customer-facing answer.";
  }
  return "Follow up with customer. The reply pipeline did not produce a confident customer-facing answer.";
}

function normalizeLower(value: string | null | undefined): string {
  return String(value ?? "").trim().toLowerCase();
}

export function shouldTreatInboundAsTestRideBikeSelection(
  input: TestRideBikeSelectionInput
): boolean {
  const inbound = normalizeLower(input.inboundText);
  const lastOutbound = normalizeLower(input.lastOutboundText);
  if (!inbound || !lastOutbound) return false;

  const testRideContext =
    normalizeLower(input.dialogState).startsWith("test_ride_") ||
    normalizeLower(input.classificationBucket) === "test_ride" ||
    normalizeLower(input.classificationCta) === "schedule_test_ride" ||
    /\b(line up|set up|schedule|book)\b[\s\S]{0,80}\b(test ride|demo ride|ride)\b/.test(lastOutbound) ||
    /\b(test ride|demo ride)\b[\s\S]{0,80}\b(pick|choose|reply with|which|what)\b/.test(lastOutbound);
  if (!testRideContext) return false;

  const promptedForBikeSelection =
    /\b(pick|choose|reply with|send me|tell me)\b[\s\S]{0,80}\b(in-stock|in stock|stock)\b[\s\S]{0,80}\b(bike|one|model)\b/.test(
      lastOutbound
    ) ||
    /\b(exact|one)\b[\s\S]{0,80}\b(want|would like)\b[\s\S]{0,80}\b(ride|test ride)\b/.test(
      lastOutbound
    ) ||
    /\bline up (the )?test ride\b/.test(lastOutbound);
  if (!promptedForBikeSelection) return false;

  if ((input.mentionedModelCount ?? 0) <= 0) return false;

  const explicitDifferentAsk =
    /\?/.test(inbound) ||
    /\b(price|pricing|payment|payments|monthly|apr|term|down payment|out the door|otd|finance|financing)\b/.test(
      inbound
    ) ||
    /\b(available|availability|in stock|still there|still available|sold|photos?|pictures?|video|walkaround)\b/.test(
      inbound
    ) ||
    /\b(specs?|spec sheet|details|info|information|features?|engine|motor|compare|comparison|difference)\b/.test(
      inbound
    ) ||
    /\b(today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|morning|afternoon|evening|at\s+\d{1,2}(?::\d{2})?\s*(am|pm)?|after\s+\d{1,2})\b/.test(
      inbound
    );
  return !explicitDifferentAsk;
}

function shouldKeepInventoryWatchPending(mode: string, reason: string): boolean {
  if (mode === "holding_inventory") return true;
  if (reason === "pending_used_followup") return true;
  if (reason.includes("inventory_watch")) return true;
  return false;
}

function isDepartmentHandoffReason(reason: string): boolean {
  const normalized = normalizeLower(reason);
  return (
    normalized === "service_request" ||
    normalized === "parts_request" ||
    normalized === "apparel_request"
  );
}

export function reduceStaleStateForInbound(input: StaleStateCleanupInput): StaleStateCleanupDecision {
  const mode = normalizeLower(input.followUpMode);
  const reason = normalizeLower(input.followUpReason);
  const dialogState = normalizeLower(input.dialogState);
  const hasInventoryWatchPending = !!input.hasInventoryWatchPending;
  const hasWatchIntent = !!input.hasWatchIntent;
  const hasFinanceIntent = !!input.hasFinanceIntent;
  const hasSchedulingIntent = !!input.hasSchedulingIntent;
  const hasAvailabilityIntent = !!input.hasAvailabilityIntent;
  const hasDepartmentIntent = !!input.hasDepartmentIntent;
  const pendingAgeHoursRaw =
    typeof input.inventoryWatchPendingAgeHours === "number" ? input.inventoryWatchPendingAgeHours : NaN;
  const pendingAgeHours = Number.isFinite(pendingAgeHoursRaw) ? pendingAgeHoursRaw : null;
  const stickyDialogStates = new Set([
    "pricing_need_model",
    "inventory_watch_prompted",
    "inventory_init",
    "pricing_init",
    "schedule_soft",
    "followup_paused"
  ]);
  const reasons: string[] = [];
  let clearInventoryWatchPending = false;
  let setDialogStateToNone = false;
  let clearManualAppointmentHandoff = false;
  let clearManualDepartmentHandoff = false;

  if (mode === "manual_handoff" && stickyDialogStates.has(dialogState)) {
    setDialogStateToNone = true;
    reasons.push(`clear_sticky_dialog_state:${dialogState}`);
  }

  if (hasInventoryWatchPending && !shouldKeepInventoryWatchPending(mode, reason) && !hasWatchIntent) {
    if (mode === "manual_handoff") {
      clearInventoryWatchPending = true;
      reasons.push("clear_watch_pending_manual_handoff");
    } else if (hasFinanceIntent || hasSchedulingIntent || hasDepartmentIntent) {
      clearInventoryWatchPending = true;
      reasons.push("clear_watch_pending_context_shift");
    } else if (pendingAgeHours != null && pendingAgeHours >= 24) {
      clearInventoryWatchPending = true;
      reasons.push("clear_watch_pending_expired");
    }
  }

  if (
    dialogState === "inventory_watch_prompted" &&
    !hasWatchIntent &&
    (clearInventoryWatchPending || hasFinanceIntent || hasSchedulingIntent || hasDepartmentIntent)
  ) {
    setDialogStateToNone = true;
    reasons.push("clear_inventory_watch_prompted_after_shift");
  }

  if (
    mode === "manual_handoff" &&
    reason === "manual_appointment" &&
    !hasSchedulingIntent &&
    (hasFinanceIntent || hasWatchIntent || hasDepartmentIntent)
  ) {
    clearManualAppointmentHandoff = true;
    reasons.push("clear_manual_appointment_context_shift");
  }

  if (
    mode === "manual_handoff" &&
    isDepartmentHandoffReason(reason) &&
    !hasDepartmentIntent &&
    (hasSchedulingIntent || hasFinanceIntent || hasWatchIntent || hasAvailabilityIntent)
  ) {
    clearManualDepartmentHandoff = true;
    reasons.push("clear_manual_department_handoff_context_shift");
  }

  return {
    clearInventoryWatchPending,
    setDialogStateToNone,
    clearManualAppointmentHandoff,
    clearManualDepartmentHandoff,
    reasons
  };
}
