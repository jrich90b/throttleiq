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

// An EXPLICIT scheduling ask from the appointment-timing parser: the customer is
// actively asking for times or proposing a day/time to come in. This must OUTRANK the
// mentioned-user / callback shortcut so that greeting the rep by name ("Good morning
// Scott… would Saturday be a possibility?") doesn't get hijacked into a callback-to-Scott
// and drop the scheduling request. Origin: Jeffrey +17164182619 (2026-06-15) — a paid-off
// + "would Saturday be a possibility?" turn was consumed by the mentioned_user callback
// path (callback todo scheduled for Scott + generic ack) because the message opened with
// the rep's name; the correct scheduling routing (schedulingPrimaryIntent at index.ts
// already handles ask_for_times + a day) never ran. Fail direction if dropped: the mention
// shortcut silently eats a real scheduling request, so this gate stays deterministic and
// is applied in BOTH /webhooks/twilio and /conversations/:id/regenerate.
export function isExplicitSchedulingAskIntent(intent?: string | null): boolean {
  return intent === "ask_for_times" || intent === "provide_new_time";
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

// The finance follow-up CONTINUATION signal (the financeFollowUpContinuation arm of
// decideFinancePricingTurn). Centralized so BOTH /webhooks/twilio and /conversations/:id/regenerate
// compute it identically (route-parity law). Parser-led: a payments-specific parser intent, OR
// stored payment-budget context (down/monthly/term) paired with a pricing/payments route signal.
// This replaced the regen path's `askedDownRecently` regex (which read OUR last outbound text) —
// the live path had already dropped that regex backstop, and regen now matches via this helper.
export function resolveFinanceFollowUpContinuation(args: {
  paymentsIntent: boolean; // parser: turn is payments-specific (live: llmPaymentsIntent)
  financeSignal: boolean; // parser: pricing-or-payments route this turn (live: currentTurnFinanceSignal)
  downProvided: boolean;
  monthlyProvided: boolean;
  termProvided: boolean;
}): boolean {
  const { paymentsIntent, financeSignal, downProvided, monthlyProvided, termProvided } = args;
  return (
    paymentsIntent ||
    ((downProvided || monthlyProvided || termProvided) && financeSignal) ||
    (downProvided && monthlyProvided && financeSignal)
  );
}

// --- Vehicle-choice confidence / open-to-alternatives (2026-06-18) ---------
//
// When a customer is lukewarm/undecided about a SPECIFIC bike they referenced,
// proactively offer 1-2 alternatives; when they're committed, stay out of the way.
// This is fuzzy comprehension with a real false-positive risk — offering
// alternatives to a confident buyer undercuts their choice and reads as not
// listening. So the DEFAULT is to stay silent and this decision FAILS toward
// stay_silent: we only offer when EVERYTHING lines up.
//
// Centralized + pure so /webhooks/twilio and /conversations/:id/regenerate can't
// drift, and so the precedence is pinned by a decision-table eval. The parser
// signal (parseVehicleChoiceConfidenceWithLLM) + the model-relevance guard
// (passesModelRelevanceGuard) are computed at the call site and fed in as inputs;
// this function owns ONLY the precedence. The reply body stays in index.ts.
//
// Gate (all required to offer; any miss => stay_silent):
//   parser accepted  AND  stance === "open_to_alternatives"
//   AND  confidence >= confidenceMin (default 0.8)
//   AND  a specific bike/model was referenced this turn/context
//   AND  the model-relevance guard passes (never act on a model the customer
//        didn't reference this turn — the over-attachment failure mode).
// ---------------------------------------------------------------------------
export type VehicleChoiceConfidenceTurnKind = "offer_alternatives" | "stay_silent";

export type VehicleChoiceConfidenceTurnInput = {
  // The parser returned a non-null result (LLM enabled + a usable parse).
  parserAccepted: boolean;
  // Parser stance: "committed" | "open_to_alternatives" | "unclear" (or null when not accepted).
  stance?: string | null;
  // Parser confidence 0..1 (0 when no parse).
  confidence: number;
  // Confidence floor to act on (default 0.8 — high bar, this can undercut a buyer).
  confidenceMin: number;
  // A specific bike/model was referenced this turn (named) or is the active subject.
  hasReferencedModel: boolean;
  // passesModelRelevanceGuard(referencedModel, inboundText) — the over-attachment guard.
  modelRelevanceGuardPassed: boolean;
};

export type VehicleChoiceConfidenceTurnDecision = {
  kind: VehicleChoiceConfidenceTurnKind;
};

export function decideVehicleChoiceConfidenceTurn(
  input: VehicleChoiceConfidenceTurnInput
): VehicleChoiceConfidenceTurnDecision {
  // FAIL DIRECTION = stay_silent. Each guard below, when it trips, keeps us quiet.
  if (!input.parserAccepted) return { kind: "stay_silent" };
  if (input.stance !== "open_to_alternatives") return { kind: "stay_silent" }; // committed/unclear => quiet
  if (!Number.isFinite(input.confidence) || input.confidence < input.confidenceMin) {
    return { kind: "stay_silent" }; // low confidence => don't risk second-guessing a buyer
  }
  if (!input.hasReferencedModel) return { kind: "stay_silent" }; // no referenced bike => nothing to compare
  if (!input.modelRelevanceGuardPassed) return { kind: "stay_silent" }; // over-attachment guard
  return { kind: "offer_alternatives" };
}

// --- Deal/progress status check (2026-06-18) -------------------------------
//
// A customer asking an OPEN status question about their deal/order/bike — "how are
// we looking", "any update?", "where are we at?", "what's the latest?", "any word?" —
// needs a real status answer, NOT a social pleasantry. Production miss: "How are we
// looking" was read as small talk and got "Doing well—hope your day's going great
// too!". This intent is a fallback that fires ONLY when the more-specific status
// intents (appointment_status_question, purchase_delivery_logistics) did not claim the
// turn and it would otherwise land in the small-talk branch.
//
// Centralized + pure so the live + regenerate small-talk-rescue stay in lockstep, and
// so the precedence is pinned by a decision-table eval. The parser signal is computed
// at the call site and fed in; this owns only the gate. The reply body + owner
// follow-up todo stay in index.ts.
//
// FAIL DIRECTION: when the parser is unsure we return `none` and the existing behavior
// runs (the social ack) — we only rescue on a confident, explicit status check, so we
// never turn genuine small talk ("how's your day going?") into a deal-status reply.
// ---------------------------------------------------------------------------
export type DealStatusCheckTurnKind = "answer_status" | "none";

export type DealStatusCheckTurnInput = {
  // The parser returned a non-null result (LLM enabled + usable parse).
  parserAccepted: boolean;
  // Parser intent: "deal_status_check" | "none" (or null when not accepted).
  intent?: string | null;
  // The parser judged this an explicit status ask (not incidental).
  explicitRequest: boolean;
  // Parser confidence 0..1 (0 when no parse).
  confidence: number;
  // Confidence floor to act on (default 0.7).
  confidenceMin: number;
};

export type DealStatusCheckTurnDecision = {
  kind: DealStatusCheckTurnKind;
};

export function decideDealStatusCheckTurn(
  input: DealStatusCheckTurnInput
): DealStatusCheckTurnDecision {
  if (!input.parserAccepted) return { kind: "none" };
  if (input.intent !== "deal_status_check") return { kind: "none" };
  if (!input.explicitRequest) return { kind: "none" };
  if (!Number.isFinite(input.confidence) || input.confidence < input.confidenceMin) {
    return { kind: "none" };
  }
  return { kind: "answer_status" };
}

// --- Watch opt-out (2026-06-19) --------------------------------------------
// A customer on an inventory WATCH says they want OFF the alerts. The side effect is to PAUSE the
// watch so the watch-fire engine stops notifying them (avoid spamming). Centralized + pure; the
// parser signal + a hasActiveWatch gate are fed in.
//
// FAIL DIRECTION: unsure => none (keep the watch). A wrongly-paused watch makes them miss a unit they
// asked to be told about, so we only act on a confident, explicit opt-out. (Joe prioritizes not-
// spamming, so the floor is moderate; the caller may also escalate a clearly-done customer to the
// disposition closeout, which pauses the watch anyway.)
// ---------------------------------------------------------------------------
export type WatchOptOutTurnKind = "pause_watch" | "none";

export type WatchOptOutTurnInput = {
  hasActiveWatch: boolean;
  parserAccepted: boolean;
  intent?: string | null; // "watch_opt_out" | "none"
  confidence: number;
  confidenceMin: number;
};

export type WatchOptOutTurnDecision = {
  kind: WatchOptOutTurnKind;
};

export function decideWatchOptOutTurn(input: WatchOptOutTurnInput): WatchOptOutTurnDecision {
  if (!input.hasActiveWatch) return { kind: "none" }; // nothing to remove
  if (!input.parserAccepted) return { kind: "none" };
  if (input.intent !== "watch_opt_out") return { kind: "none" };
  if (!Number.isFinite(input.confidence) || input.confidence < input.confidenceMin) {
    return { kind: "none" };
  }
  return { kind: "pause_watch" };
}

// --- ADF intake department route (2026-06-19) ------------------------------
//
// On an initial web (ADF) lead, the Inquiry field is the customer's stated request, so naming an
// apparel/parts/service item there IS that department's request — even with no action verb. The
// SMS-tuned action-signal gates (correct for incidental mid-thread mentions) wrongly dropped a terse
// ADF item and the lead fell through to inventory_interest (Kelly Gantzer "small womens black leather
// vest" got a bogus "not in stock" reply + an inventory watch on the "Full Line" placeholder bike).
// parseAdfDepartmentInterestWithLLM reads the Inquiry (+ Vehicle) and this pure decision turns a
// confident apparel/parts/service verdict into a department route; everything else (vehicle / none)
// stays out so the normal bike flow runs.
//
// FAIL DIRECTION: unsure => none (the standard vehicle/inventory path runs). Over-routing a real bike
// shopper to the apparel desk is worse than the current miss, so we only act on a confident
// apparel/parts/service verdict; a "vehicle" or "none" verdict, low confidence, or no parser => none.
// ---------------------------------------------------------------------------
export type AdfDepartmentRouteKind = "apparel" | "parts" | "service" | "none";

export type AdfDepartmentRouteInput = {
  parserAccepted: boolean;
  department?: "apparel" | "parts" | "service" | "vehicle" | "none" | null;
  confidence: number;
  confidenceMin: number;
};

export type AdfDepartmentRouteDecision = {
  kind: AdfDepartmentRouteKind;
};

export function decideAdfDepartmentRoute(input: AdfDepartmentRouteInput): AdfDepartmentRouteDecision {
  if (!input.parserAccepted) return { kind: "none" };
  if (!Number.isFinite(input.confidence) || input.confidence < input.confidenceMin) {
    return { kind: "none" };
  }
  if (input.department === "apparel" || input.department === "parts" || input.department === "service") {
    return { kind: input.department };
  }
  return { kind: "none" };
}

// --- Finance-process / logistics handoff (2026-06-18) ----------------------
//
// A customer asking about the PROCESS / SEQUENCING / TIMING / CONDITIONS of financing
// and its related steps — insurance timing, down-payment deadlines, order-of-operations
// ("if I pay the full 10% down do I get more time for insurance?", "can I get insurance
// after I sign?", "when do I need the down payment by?") — needs the finance/business
// manager's exact answer, NOT a generic restatement of the requirement. Production miss
// (Adam +17166033199, surfaced by intent_handled_audit): asked whether paying 10% down
// extends the insurance deadline, got "we'd just need insurance before we finalize" — which
// didn't answer the conditional. The agent can't know dealer finance policy, so the safe,
// correct move is a finance-manager handoff that acknowledges the specific question.
//
// Distinct from the NUMBER questions other handlers own (monthly payment, rate, amount
// down) — those are not a process handoff. Centralized + pure; the parser signal is fed in.
//
// FAIL DIRECTION: unsure => none, and the existing finance handling runs. We only hand off
// on a confident, explicit process/logistics question.
// ---------------------------------------------------------------------------
export type FinanceProcessQuestionTurnKind = "finance_process_handoff" | "none";

export type FinanceProcessQuestionTurnInput = {
  parserAccepted: boolean;
  intent?: string | null; // "finance_process_handoff" | "none"
  explicitRequest: boolean;
  confidence: number;
  confidenceMin: number;
};

export type FinanceProcessQuestionTurnDecision = {
  kind: FinanceProcessQuestionTurnKind;
};

export function decideFinanceProcessQuestionTurn(
  input: FinanceProcessQuestionTurnInput
): FinanceProcessQuestionTurnDecision {
  if (!input.parserAccepted) return { kind: "none" };
  if (input.intent !== "finance_process_handoff") return { kind: "none" };
  if (!input.explicitRequest) return { kind: "none" };
  if (!Number.isFinite(input.confidence) || input.confidence < input.confidenceMin) {
    return { kind: "none" };
  }
  return { kind: "finance_process_handoff" };
}

// --- Non-motorcycle trade handoff (2026-06-21) -----------------------------
//
// A Harley dealer's standard trade flow is for MOTORCYCLES. Every so often a customer wants
// to trade in something else — a motorcycle camper/trailer, RV, car, boat, ATV — which the
// dealer has to assess by hand (they may or may not take it). Production miss (Jessica Ornce
// +17167134728): "I wouldn't be able to make the deal happen unless I could also trade in my
// motorcycle camper" got a standard trade-appraisal draft ("estimate based on the bike
// details") as if the camper were a bike. The agent can't quote a value on a non-motorcycle,
// so the safe, correct move is a staff handoff that acknowledges the specific item.
//
// Centralized + pure; the parser signal is fed in. FAIL DIRECTION: unsure => none, and the
// normal trade handling runs. We only hand off on a confident, explicit non-motorcycle trade.
// ---------------------------------------------------------------------------
export type NonMotorcycleTradeTurnKind = "non_motorcycle_trade_handoff" | "none";

export type NonMotorcycleTradeTurnInput = {
  parserAccepted: boolean;
  intent?: string | null; // "non_motorcycle_trade" | "none"
  explicitRequest: boolean;
  confidence: number;
  confidenceMin: number;
};

export type NonMotorcycleTradeTurnDecision = {
  kind: NonMotorcycleTradeTurnKind;
};

export function decideNonMotorcycleTradeTurn(
  input: NonMotorcycleTradeTurnInput
): NonMotorcycleTradeTurnDecision {
  if (!input.parserAccepted) return { kind: "none" };
  if (input.intent !== "non_motorcycle_trade") return { kind: "none" };
  if (!input.explicitRequest) return { kind: "none" };
  if (!Number.isFinite(input.confidence) || input.confidence < input.confidenceMin) {
    return { kind: "none" };
  }
  return { kind: "non_motorcycle_trade_handoff" };
}

// --- Conversation closeout / sign-off (2026-06-19) -------------------------
//
// A warm closer ("have a good weekend!", "you guys are the best!", "thanks again,
// take care") should END the thread gracefully — one brief reciprocation, then quiet
// — not trigger another reply or a bike pivot. Joe's report: the agent "would not know
// when to close out after a social reciprocation — it would keep going." The only
// existing signal (isCloseoutSignoffNoResponseText) is a narrow keyword regex matching
// "talk soon"/"see you soon", so warm closers fell through to the small-talk generator
// (which is even told it MAY pivot back to bikes). This centralizes the parser-first
// closeout decision; the parser signal + an actionable-signal guard are fed in.
//
// Two actions:
//  - reciprocate_and_close: send ONE brief warm reply, then stop (no pivot, no question).
//  - close_silent: no reply at all — a terminal echo where replying again is over-texting.
//
// FAIL DIRECTION: any uncertainty (no parser / low confidence / an actionable ask present)
// resolves to "none" — the existing reply path runs. We only close out on a confident closer
// with NO actionable signal, so the worst case is keeping the conversation going (the safe
// direction), never going silent on a live ask. Scope is the IMMEDIATE exchange only — this
// decision never touches the follow-up cadence (that stays with the disposition handlers).
// ---------------------------------------------------------------------------
export type ConversationCloseoutTurnKind = "reciprocate_and_close" | "close_silent" | "none";

export type ConversationCloseoutTurnInput = {
  parserAccepted: boolean;
  kind?: ConversationCloseoutTurnKind | null; // parser's classification
  confidence: number;
  confidenceMin: number;
  hasActionableSignal: boolean; // ? / pricing / scheduling / availability / trade / callback present
};

export type ConversationCloseoutTurnDecision = {
  kind: ConversationCloseoutTurnKind;
};

export function decideConversationCloseoutTurn(
  input: ConversationCloseoutTurnInput
): ConversationCloseoutTurnDecision {
  // Never close out a turn that contains a real ask — fail toward replying.
  if (input.hasActionableSignal) return { kind: "none" };
  if (!input.parserAccepted) return { kind: "none" };
  if (input.kind !== "reciprocate_and_close" && input.kind !== "close_silent") {
    return { kind: "none" };
  }
  if (!Number.isFinite(input.confidence) || input.confidence < input.confidenceMin) {
    return { kind: "none" };
  }
  return { kind: input.kind };
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

// --- Draft-model A/B experiment (2026-06-15) -------------------------------
// Tests whether a stronger model lifts reply/booking quality on the customer-
// facing draft (gpt-5 challenger vs the gpt-5-mini control). Assignment is the
// same pure, deterministic 50/50 split — keyed on the lead so a given customer
// always gets one model for their whole thread, and the offline report can
// recompute each conversation's arm with no message tagging. Parsers/routing are
// intentionally NOT on this arm, so the experiment isolates the draft model and
// can't perturb route decisions (or the measurement). Uses a distinct salt from
// the cadence arm so the two experiments don't correlate.
export type DraftModelArm = "control" | "challenger";

export function decideDraftModelArm(leadKey: string): DraftModelArm {
  if (!String(leadKey ?? "")) return "control";
  const key = `draftmodel:${String(leadKey)}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  // Use a well-mixed range (NOT the low bit): FNV-1a's `% 2` depends only on the
  // XOR of byte low bits, which a fixed salt can't decorrelate from the cadence
  // arm and buckets weakly. `% 100` uses well-mixed bits — a fair 50/50 split
  // that's independent of decideCadenceInviteArm's low-bit split.
  return (h >>> 0) % 100 < 50 ? "control" : "challenger";
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

// ── Event-promo / sweepstakes turn ──────────────────────────────────────────
// A non-sales marketing lead (sweepstakes entry, event RSVP, bare event_promo) must
// NEVER receive a sales/availability/stop-in/model-fact reply — it isn't shopping for a
// bike, so "That stock number is still available, what day works to stop in?" / "Thanks
// for your inquiry about the 2026 X..." / a bare "It's a 2026 Road Glide." are all
// answering out of context (2026-06-20 context-fidelity audit: 5/6 out-of-context drafts
// were exactly this). The correct reply is one friendly, non-pushy acknowledgement.
//
// Pure + structured: keyed ONLY on the system's own classification (bucket/cta) — already
// assigned deterministically from the ADF source — so this is structured routing, not
// free-text comprehension. Applied at every reply chokepoint in BOTH paths (live publisher,
// regenerate publisher, initial-ADF draft). Demo-ride events (cta=demo_ride_event) are
// EXCLUDED — they keep their dedicated dealer-ride handling.
export type EventPromoTurnKind = "event_promo_ack" | "none";

export type EventPromoTurnInput = {
  classificationBucket?: string | null;
  classificationCta?: string | null;
};

export type EventPromoTurnDecision = { kind: EventPromoTurnKind };

export function decideEventPromoTurn(input: EventPromoTurnInput): EventPromoTurnDecision {
  const bucket = String(input.classificationBucket ?? "").toLowerCase();
  const cta = String(input.classificationCta ?? "").toLowerCase();
  if (bucket === "event_promo" && cta !== "demo_ride_event") {
    return { kind: "event_promo_ack" };
  }
  return { kind: "none" };
}

// ── Trade-qualifier turn (centralizes the trade cluster's route decision) ─────
// After we asked "do you have a trade?", the customer's reply is classified by the typed
// parser `parseTradeQualifierResponseWithLLM` (hasTrade = affirmed / declined / unclear).
// This pure decision maps that to the route kind so BOTH /webhooks/twilio AND
// /conversations/:id/regenerate switch on the SAME result (route-parity law) — it closes the
// prior gap where regen handled ONLY the decline branch and an affirm fell through to the
// orchestrator. Arm bodies (set trade state + ask miles/payoff; clear trade + finance reply)
// stay in index.ts. Fail-safe: an `unclear`/null parse or a turn where we didn't ask returns
// `none` and falls through (no silent regex miss). Pinned by `trade_qualifier_turn:eval`.
export type TradeQualifierTurnKind = "trade_affirm" | "trade_decline" | "none";

export type TradeQualifierTurnInput = {
  askedTradeQualifier: boolean;
  hasTrade?: string | null;
};

export type TradeQualifierTurnDecision = { kind: TradeQualifierTurnKind };

export function decideTradeQualifierTurn(input: TradeQualifierTurnInput): TradeQualifierTurnDecision {
  if (!input.askedTradeQualifier) return { kind: "none" };
  const hasTrade = String(input.hasTrade ?? "").toLowerCase();
  if (hasTrade === "affirmed") return { kind: "trade_affirm" };
  if (hasTrade === "declined") return { kind: "trade_decline" };
  return { kind: "none" };
}
