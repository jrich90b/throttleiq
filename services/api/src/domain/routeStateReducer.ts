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
  | "confirm_appointment"
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
  // The customer confirmed a CONCRETE proposed time and the parser cleared it to book
  // (CustomerAckActionParse.shouldBook). Only then does a confirm route to the auto-book arm.
  customerAckShouldBook?: boolean;
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
      case "confirm_proposed_appointment":
        // Customer confirmed a concrete time the agent didn't pre-offer ("Ya 10 will work",
        // "Around 1pm"). Only route to the auto-book arm when the parser cleared it to book;
        // otherwise fall through (the appointment-timing / lock-in arms handle the soft cases),
        // so we never auto-book on a vague signal.
        if (input.customerAckShouldBook) return { kind: "confirm_appointment", visitCommitment };
        break;
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

// The customer-ack CONFIRM-BOOKING outcome — the pure branching behind
// resolveCustomerAckConfirmBooking (index.ts), which decides what happens when a customer confirms a
// concrete time the agent didn't pre-offer ("Ya 10 will work"). The IO (service check, scheduler
// config, day/time resolution, calendar availability + the actual insertEvent write) stays in
// index.ts; this owns the DECISION given those resolved results. Extracted so the risk branches are
// unit-testable WITHOUT booting index.ts or hitting Google Calendar — especially:
//   - a calendar write that FAILED must NOT produce a "you're all set" confirm (booked=false => fall_back),
//   - a TAKEN slot must offer alternatives, never a fabricated confirm,
//   - the regen draft path (book=false) must never claim a booking.
// `fall_back` => the caller returns null and asks the customer to lock in (no false confirm).
export type ConfirmBookingDecisionInput = {
  serviceContext: boolean; // a service-dept scheduling ask must not book a sales visit
  hasConfig: boolean; // scheduler config resolved
  hasExistingBooking: boolean; // appointment already has bookedEventId + whenText (reflect it)
  requestedResolved: boolean; // a concrete day+time resolved from the turn
  availabilityChecked: boolean; // the calendar availability lookup returned a result (not null)
  slotFree: boolean; // availability.available AND an exact slot is open
  book: boolean; // true = live (write the calendar); false = regenerate draft preview (no write)
  bookSucceeded: boolean; // the insertEvent write succeeded (only meaningful when book && slotFree)
  hasAlternatives: boolean; // alternative slots exist when the requested time is taken
};

export type ConfirmBookingOutcome =
  | { kind: "fall_back" } // caller returns null → lock-in ask (no fabricated confirm)
  | { kind: "already_booked" } // reflect the existing confirmed appointment
  | { kind: "regen_lock_in" } // regen preview on a free slot — "I'll get you locked in" (no write)
  | { kind: "booked" } // live write succeeded — "you're all set for X"
  | { kind: "offer_alternatives"; hasAlternatives: boolean }; // requested time taken

export function decideCustomerAckConfirmBooking(input: ConfirmBookingDecisionInput): ConfirmBookingOutcome {
  if (input.serviceContext) return { kind: "fall_back" };
  if (!input.hasConfig) return { kind: "fall_back" };
  if (input.hasExistingBooking) return { kind: "already_booked" };
  if (!input.requestedResolved) return { kind: "fall_back" };
  if (!input.availabilityChecked) return { kind: "fall_back" };
  if (input.slotFree) {
    if (!input.book) return { kind: "regen_lock_in" };
    return input.bookSucceeded ? { kind: "booked" } : { kind: "fall_back" }; // write failed => NO false confirm
  }
  return { kind: "offer_alternatives", hasAlternatives: input.hasAlternatives };
}

// A scheduling turn where the agent DEFERRED ("I'll check / I'll confirm that time and follow up")
// but did NOT book this turn and did NOT offer alternative slots is a silent promise with nothing
// behind it — the salesperson never sees the requested time. That turn MUST leave an owner follow-up
// task. Operator-reported 4× on +17167506588 ("next Saturday same time around 1" → "I'll check that
// time and follow up", no task). FAIL DIRECTION = create the task whenever unsure: an extra owner
// task is safe; a silently-dropped reschedule request is the bug. The booking arm (decideCustomerAck-
// ConfirmBooking) and the offer-alternatives branch are excluded — they already act for the customer.
export type SchedulingDeferralFollowUpInput = {
  deferred: boolean; // this turn produced a deferral ack (no concrete slot resolved/booked this turn)
  booked: boolean; // the booking arm actually wrote/locked the appointment this turn
  offeredAlternatives: boolean; // we offered concrete alternative slots (not a silent defer)
  hasRequestedPhrase: boolean; // a concrete requested day/time was carried (for the summary, NOT a gate)
};
export type SchedulingDeferralFollowUpDecision = { createTask: boolean };

export function decideSchedulingDeferralFollowUpTask(
  input: SchedulingDeferralFollowUpInput
): SchedulingDeferralFollowUpDecision {
  if (input.booked) return { createTask: false }; // auto-book already handled it
  if (input.offeredAlternatives) return { createTask: false }; // we gave the customer times to pick
  if (!input.deferred) return { createTask: false }; // not a deferral turn
  return { createTask: true }; // deferred, not booked, no alternatives => owner must follow up
}

// The tentative-time-window arm ("probably about 11 o'clock on Monday", "maybe Saturday around 3")
// acks softly ("that can work — give me a heads up on the exact time") and never books. It carries
// the SAME silent-drop risk as the deferral arms above (decideSchedulingDeferralFollowUpTask), but it
// escaped that net: the tentative arm computes no calendar-check result, so `needsOwnerFollowUpTask`
// was always null → no owner task. When the customer named a CONCRETE day AND time (not a vague
// "sometime next week"), the salesperson must still SEE that requested slot or it's silently dropped —
// Peter Meredith +17168303999 (2026-07-03): a bike-on-hold sales deal (deposit left on stock U894-13,
// which needs prep before the sale finalizes). "probably about 11 o'clock on Monday" is a HEDGED
// concrete time → the parser reads it as tentative (shouldBook=false), so the agent soft-acks and
// never books — but the Monday-11 visit-to-finalize was silently dropped: NO owner task; only saved
// because a salesperson booked it manually. FAIL DIRECTION = leave the task whenever a concrete
// day+time is present; an extra owner
// task is safe, a dropped requested time is the bug. Gated on day AND time (not day-only) so vague
// windows keep going to the soft-visit cadence, not a task. Feeds decideSchedulingDeferralFollowUpTask.
export function tentativeWindowNeedsOwnerFollowUp(input: {
  hasRequestedDay: boolean;
  hasRequestedTime: boolean;
}): boolean {
  return input.hasRequestedDay && input.hasRequestedTime;
}

// A booked appointment whose LOCAL CALENDAR DAY is strictly before "now" is STALE — the agent must
// never answer an appointment-status question by asserting a past slot as if it's current ("I'm
// showing your appointment for Fri, Jul 3, 1:00 PM" said on Jul 7). Operator-reported on
// +17167506588 (s R Gurajala): a Jul-3 appointment was parroted back days later instead of offering
// to rebook, so the customer walked away thinking he was still set. Same-day is NOT stale — even if
// the clock time has passed, "today at 1:00 PM"/"your appointment for today" is still a correct
// same-day status answer (the customer may be arriving now). Compared on the dealer-local calendar
// day (Intl, timezone-aware) so a late-evening UTC appointment isn't mis-bucketed. FAIL DIRECTION:
// when unsure (unparseable/absent whenIso) return false — keep the existing status reply rather than
// suppress a real upcoming appointment.
export function isStaleBookedAppointmentDay(input: {
  whenIso: string | null | undefined;
  nowMs: number;
  timeZone: string;
}): boolean {
  const iso = String(input.whenIso ?? "").trim();
  if (!iso) return false;
  const start = new Date(iso);
  if (Number.isNaN(start.getTime())) return false;
  const tz = String(input.timeZone ?? "").trim() || "America/New_York";
  const dayKey = (d: Date): string => {
    try {
      // en-CA yields YYYY-MM-DD, which is lexicographically comparable.
      return new Intl.DateTimeFormat("en-CA", {
        timeZone: tz,
        year: "numeric",
        month: "2-digit",
        day: "2-digit"
      }).format(d);
    } catch {
      return new Intl.DateTimeFormat("en-CA", {
        year: "numeric",
        month: "2-digit",
        day: "2-digit"
      }).format(d);
    }
  };
  return dayKey(start) < dayKey(new Date(input.nowMs));
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
  // parser: the customer explicitly ASKED for payment numbers/an estimate this turn
  // (pricing/payments parser asksForPaymentEstimate). Joe ruling 2026-07-09 (Ryan Tower,
  // +15857278545): volunteering "I have a 2010 sportster and 3k cash to put down" is a
  // payments-intent turn but NOT a numbers request — the agent must gather the trade +
  // down details, not fire the payment calculator (whose ballpark reply was also wrong).
  asksForPaymentEstimate: boolean;
  financeSignal: boolean; // parser: pricing-or-payments route this turn (live: currentTurnFinanceSignal)
  downProvided: boolean;
  monthlyProvided: boolean;
  termProvided: boolean;
}): boolean {
  const { paymentsIntent, asksForPaymentEstimate, financeSignal, downProvided, monthlyProvided, termProvided } = args;
  // The calculator/estimate continuation requires an actual numbers ASK. A declared monthly
  // budget or term (stored payment context) still continues an in-flight structuring flow —
  // the customer gave us numbers to work WITH — but down-payment-only context (the trade
  // volunteer shape) does not. Fail-direction: a false negative falls through to the normal
  // conversational path (gather/answer), never to a wrong auto-computed quote.
  return (
    (paymentsIntent && asksForPaymentEstimate) ||
    (asksForPaymentEstimate && financeSignal) ||
    ((monthlyProvided || termProvided) && financeSignal)
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
  // An ACCEPTED concrete parsed action already owns this turn (dealer_location_question /
  // inventory_watch_acknowledgement) — the alternatives offer must yield (corpus flywheel,
  // 2026-07-03, +12399612259: "remind me again what address is this at?" drew the "Totally
  // fair — happy to line up options" reply because this arm runs ~3k lines before the
  // location arm).
  concreteParsedActionThisTurn?: boolean;
};

export type VehicleChoiceConfidenceTurnDecision = {
  kind: VehicleChoiceConfidenceTurnKind;
};

export function decideVehicleChoiceConfidenceTurn(
  input: VehicleChoiceConfidenceTurnInput
): VehicleChoiceConfidenceTurnDecision {
  // FAIL DIRECTION = stay_silent. Each guard below, when it trips, keeps us quiet.
  if (input.concreteParsedActionThisTurn) return { kind: "stay_silent" }; // the parsed action owns the turn
  if (!input.parserAccepted) return { kind: "stay_silent" };
  if (input.stance !== "open_to_alternatives") return { kind: "stay_silent" }; // committed/unclear => quiet
  if (!Number.isFinite(input.confidence) || input.confidence < input.confidenceMin) {
    return { kind: "stay_silent" }; // low confidence => don't risk second-guessing a buyer
  }
  if (!input.hasReferencedModel) return { kind: "stay_silent" }; // no referenced bike => nothing to compare
  if (!input.modelRelevanceGuardPassed) return { kind: "stay_silent" }; // over-attachment guard
  return { kind: "offer_alternatives" };
}

// --- Vehicle recommendation by budget/style (2026-06-24) -------------------
//
// When a customer asks us to PICK bikes for them ("give me some options", "~$200/mo",
// "not cruisers") with NO specific model in play, answer with real inventory suggestions instead
// of looping "which bike are you looking at so I can run it correctly?" (s R Gurajala
// +17167506588). The parser signal (parseVehicleRecommendationRequestWithLLM) is computed at the
// call site and fed in; this owns ONLY the precedence. The reply (and inventory query) stay in
// index.ts / inventoryRecommender.
//
// FAIL DIRECTION = `none`: any miss falls through to the existing finance/pricing "which bike?"
// behavior. We only recommend on a confident, explicit request AND when no specific model is
// already in play (a customer pricing a known bike is NOT asking for suggestions).
// ---------------------------------------------------------------------------
export type VehicleRecommendationTurnKind = "recommend" | "none";

export type VehicleRecommendationTurnInput = {
  // The parser returned a non-null result (LLM enabled + usable parse).
  parserAccepted: boolean;
  // Parser: the customer wants us to suggest/pick bikes.
  wantsRecommendation: boolean;
  // Parser confidence 0..1 (0 when no parse).
  confidence: number;
  // Confidence floor to act on (default 0.7).
  confidenceMin: number;
  // No specific model is in play this turn/context (recommendation is for the "no model yet" case).
  modelUnknown: boolean;
};

export type VehicleRecommendationTurnDecision = {
  kind: VehicleRecommendationTurnKind;
};

export function decideVehicleRecommendationTurn(
  input: VehicleRecommendationTurnInput
): VehicleRecommendationTurnDecision {
  if (!input.parserAccepted) return { kind: "none" };
  if (!input.wantsRecommendation) return { kind: "none" };
  if (!Number.isFinite(input.confidence) || input.confidence < input.confidenceMin) {
    return { kind: "none" };
  }
  if (!input.modelUnknown) return { kind: "none" }; // they're on a specific bike => let pricing handle it
  return { kind: "recommend" };
}

// When the customer NAMES a model on a turn where no model is yet in play for pricing, should the
// recommender bow out to the finance/pricing flow? Naming a model is normally "price THIS bike"
// (finance owns it). EXCEPTION: when the customer has given a budget profile (a monthly cap and/or a
// down payment) and there is still no concrete unit to price, naming a model CLASS is "find me a
// <model> that fits my budget", not "price the exact unit I'm on" — keep the recommender and let the
// typed parser scope it. Without that exception the agent loops "Which bike are you looking at so I
// can run it correctly?" forever (Tyrone Woods +13179357913, 2026-06-22: gave used-cruiser + $1.8–2k
// down + $450–550/mo, narrowed to "road king or street glider", and got re-asked which bike).
//
// FAIL DIRECTION = bow out (true): a named model with no budget context falls through to the existing
// finance/pricing behavior, never a wrong-target recommendation. The caller has already established
// model-unknown-for-payments before invoking this (so there is genuinely no unit to price).
export function shouldBowOutRecommenderForNamedModel(input: {
  namedModelThisTurn: boolean;
  hasBudgetProfile: boolean;
}): boolean {
  return input.namedModelThisTurn && !input.hasBudgetProfile;
}

// --- Vehicle media request (photos/links/colors of suggested units, 2026-06-24) ----------------
// After the recommender suggests units, the customer asks to SEE them. Fire ONLY when the parser is
// confident AND we actually have persisted units that carry a listing URL — otherwise fall through
// (the deterministic reply needs real links; never fabricate one). FAIL DIRECTION: none => existing
// behavior (commit-to-follow-up), never a made-up link.
export type VehicleMediaRequestTurnInput = {
  parserAccepted: boolean;
  wantsMedia: boolean;
  confidence: number;
  confidenceMin: number;
  hasUnitsWithUrl: boolean;
};
export type VehicleMediaRequestTurnDecision = { kind: "send_media" | "none" };

export function decideVehicleMediaRequestTurn(input: VehicleMediaRequestTurnInput): VehicleMediaRequestTurnDecision {
  if (!input.parserAccepted) return { kind: "none" };
  if (!input.wantsMedia) return { kind: "none" };
  if (!Number.isFinite(input.confidence) || input.confidence < input.confidenceMin) return { kind: "none" };
  if (!input.hasUnitsWithUrl) return { kind: "none" }; // nothing real to send => existing handling
  return { kind: "send_media" };
}

// --- Feedback-driven redraft (2026-06-24) -----------------------------------
// Phase 1 of the closed-loop feedback system: a staff thumbs-DOWN on a still-PENDING AI draft
// triggers an immediate steered re-draft into the same console box (suggest mode — a human still
// hits Send). The rep's thumbs-down reason becomes generator STEERING. This is the generation/voice
// layer (LLM, allowed by the de-tangle program), NOT a routing change — code-level misses are the
// approve-first parser-first fix path (Phases 2-3), never patched from a single thumbs-down.
//
// FAIL DIRECTION: anything other than "down on a live draft" → record_only (today's behavior). We
// only redraft what can still be edited; a thumbs-down on an already-SENT message is feedback only.
export type FeedbackRedraftTurnInput = {
  enabled: boolean; // the FEEDBACK_DOWN_REDRAFT_ENABLED kill switch
  rating: string; // "up" | "down"
  ratedIsPendingDraft: boolean; // the rated message is a non-stale draft_ai (still editable)
  reason?: string | null;
  note?: string | null;
};

export type FeedbackRedraftTurnDecision = { kind: "redraft" | "record_only"; steering?: string };

export function buildFeedbackRedraftSteering(reason?: string | null, note?: string | null): string {
  const detail = [reason, note]
    .map(s => String(s ?? "").replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join(" — ");
  return (
    `A staff reviewer gave the previous draft a thumbs-down${detail ? `: ${detail}` : ""}. ` +
    `Revise the reply to fix that specific issue. Keep it on-voice (like texting a friend), answer ` +
    `what the customer actually asked, and never fabricate a price, availability, stock, or appointment.`
  );
}

export function decideFeedbackRedraftTurn(input: FeedbackRedraftTurnInput): FeedbackRedraftTurnDecision {
  if (!input.enabled) return { kind: "record_only" };
  if (String(input.rating ?? "").trim().toLowerCase() !== "down") return { kind: "record_only" };
  if (!input.ratedIsPendingDraft) return { kind: "record_only" }; // can't redraft an already-sent message
  return { kind: "redraft", steering: buildFeedbackRedraftSteering(input.reason, input.note) };
}

// --- Feedback diagnosis action (closed-loop Phase 2, 2026-06-24) -------------
// Maps a classified thumbs-down (parseFeedbackFailureModeWithLLM) onto the action its LAYER warrants,
// honoring the de-tangle split: VOICE issues are refined at the generation layer (never a routing
// change); COMPREHENSION issues become parser-first fix candidates (Phase 3 turns a recurring class
// into an approve-first PR — never auto-merged); SAFETY is already owned by the held/draft-quality
// gate. Pure + eval'd so the report (Phase 2) and any future auto-PR step (Phase 3) share one policy.
//
// FAIL DIRECTION: unsure / low-confidence / non-systemic → record_only. We only escalate a confident,
// SYSTEMIC comprehension miss to a fix candidate, so a one-off rep preference never proposes code.
export type FeedbackDiagnosisAction =
  | "voice_refinement"
  | "parser_fix_candidate"
  | "already_gated"
  | "record_only";

export type FeedbackDiagnosisActionInput = {
  parserAccepted: boolean;
  layer?: "voice" | "comprehension" | "safety" | "none" | null;
  systemic: boolean;
  confidence: number;
  confidenceMin: number; // default 0.7 at the call site
};

export function decideFeedbackDiagnosisAction(input: FeedbackDiagnosisActionInput): FeedbackDiagnosisAction {
  if (!input.parserAccepted) return "record_only";
  if (!Number.isFinite(input.confidence) || input.confidence < input.confidenceMin) return "record_only";
  if (input.layer === "safety") return "already_gated"; // the held/draft-quality gate owns fabrication
  if (input.layer === "voice") return "voice_refinement"; // generation layer; never a routing change
  if (input.layer === "comprehension" && input.systemic) return "parser_fix_candidate";
  return "record_only";
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

// --- Post-sale ownership loss (2026-07-08) -----------------------------------
// The customer bought a bike from us and is on the POST-SALE cadence (courtesy/warranty/Custom
// Coverage touches about THAT bike). When they state, as a done fact, that they no longer own it
// (sold/traded/wrecked/gave away/stolen — parsePostSaleOwnershipWithLLM), the cadence must stop
// durably instead of pestering them about a bike they don't have. Operator-reported (John,
// +17164739373): a Custom Coverage reminder drew "Yeah i sold the bike remember". The side effect
// is cadence state ONLY (stopFollowUpCadence "no_longer_owns" — a stopReason the maintenance
// tick's sold-lead revive does NOT resurrect); the reply stays with the normal draft pipeline so
// a mixed message ("sold it, but my buddy wants one") never loses its other half to a canned ack.
//
// FAIL DIRECTION: unsure => none (cadence keeps running — today's behavior). A wrongful stop
// silently drops courtesy/warranty touches a real owner should get, so only an EXPLICIT,
// confident, done-fact statement acts.
// -----------------------------------------------------------------------------
export type PostSaleOwnershipTurnKind = "stop_post_sale_cadence" | "none";

export type PostSaleOwnershipTurnInput = {
  /** conv.followUpCadence is kind "post_sale" and status "active". */
  hasActivePostSaleCadence: boolean;
  parserAccepted: boolean;
  intent?: string | null; // "no_longer_owns" | "none"
  /** Loss stated as a completed fact (not a plan/intention). */
  explicitStatement: boolean;
  confidence: number;
  confidenceMin: number;
};

export type PostSaleOwnershipTurnDecision = { kind: PostSaleOwnershipTurnKind };

export function decidePostSaleOwnershipTurn(
  input: PostSaleOwnershipTurnInput
): PostSaleOwnershipTurnDecision {
  if (!input.hasActivePostSaleCadence) return { kind: "none" }; // nothing to stop
  if (!input.parserAccepted) return { kind: "none" };
  if (input.intent !== "no_longer_owns") return { kind: "none" };
  if (!input.explicitStatement) return { kind: "none" }; // a plan/intention is not a loss
  if (!Number.isFinite(input.confidence) || input.confidence < input.confidenceMin) {
    return { kind: "none" };
  }
  return { kind: "stop_post_sale_cadence" };
}

// --- Watch sibling-scope answer (2026-07-04) --------------------------------
// After the one-time "open to variants?" ask (buildWatchSiblingScopeAsk — a same-family sibling
// trim landed during a strict base-model watch), the customer's answer either BROADENS the watch
// (openToOtherTrims — same-family trims now fire) or pins it BASE-ONLY (never re-ask). The side
// effect is watch state ONLY — the reply stays with the normal draft pipeline, which sees the ask
// + answer in history and responds naturally (so an answer carrying another question never gets a
// canned ack that drops it). Centralized + pure; the parser signal + the pending-ask gate are fed in.
//
// FAIL DIRECTION: unsure => none (the watch stays strict — today's behavior; no state change).
// A wrongly-broadened watch texts the customer about bikes they didn't ask for — the exact
// over-attachment class we just fixed on the create side — so only a confident answer acts.
// ---------------------------------------------------------------------------
export type WatchScopeTurnKind = "broaden_watch" | "keep_base_only" | "none";

export type WatchScopeTurnInput = {
  /** A sibling-scope ask is pending on a watch (asked, unresolved, not already open/declined). */
  scopeAskPending: boolean;
  parserAccepted: boolean;
  intent?: string | null; // "open_to_variants" | "base_only" | "unrelated"
  confidence: number;
  confidenceMin: number;
};

export type WatchScopeTurnDecision = {
  kind: WatchScopeTurnKind;
};

export function decideWatchScopeTurn(input: WatchScopeTurnInput): WatchScopeTurnDecision {
  if (!input.scopeAskPending) return { kind: "none" }; // nothing was asked
  if (!input.parserAccepted) return { kind: "none" };
  if (!Number.isFinite(input.confidence) || input.confidence < input.confidenceMin) {
    return { kind: "none" };
  }
  if (input.intent === "open_to_variants") return { kind: "broaden_watch" };
  if (input.intent === "base_only") return { kind: "keep_base_only" };
  return { kind: "none" }; // "unrelated" or anything else — the normal pipeline owns the turn
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
export type AdfDepartmentRouteKind = "apparel" | "parts" | "service" | "riding_academy" | "none";

export type AdfDepartmentRouteInput = {
  parserAccepted: boolean;
  department?: "apparel" | "parts" | "service" | "vehicle" | "riding_academy" | "none" | null;
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
  if (
    input.department === "apparel" ||
    input.department === "parts" ||
    input.department === "service" ||
    input.department === "riding_academy"
  ) {
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

// --- Service / parts-install appointment request (2026-06-27) ---------------
// A customer wanting to bring their bike IN for service or a parts/accessory install + an
// appointment needs the service-department HANDOFF (intake + "service will confirm a time"),
// because LeadRider has no service-scheduler integration — never quote/book a slot. Centralized +
// pure; the parser signal is fed in. FAIL DIRECTION: unsure => none, normal pipeline runs. We only
// hand off on a confident, explicit service/install-appointment request.
// ---------------------------------------------------------------------------
export type ServiceAppointmentTurnKind = "service_appointment_handoff" | "none";

export type ServiceAppointmentTurnInput = {
  parserAccepted: boolean;
  intent?: string | null; // "service_appointment_request" | "none"
  explicitRequest: boolean;
  confidence: number;
  confidenceMin: number;
};

export type ServiceAppointmentTurnDecision = {
  kind: ServiceAppointmentTurnKind;
};

export function decideServiceAppointmentTurn(
  input: ServiceAppointmentTurnInput
): ServiceAppointmentTurnDecision {
  if (!input.parserAccepted) return { kind: "none" };
  if (input.intent !== "service_appointment_request") return { kind: "none" };
  if (!input.explicitRequest) return { kind: "none" };
  if (!Number.isFinite(input.confidence) || input.confidence < input.confidenceMin) {
    return { kind: "none" };
  }
  return { kind: "service_appointment_handoff" };
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
export type DraftModelArm = "control" | "challenger" | "anthropic";

export function decideDraftModelArm(leadKey: string): DraftModelArm {
  if (!String(leadKey ?? "")) return "control";
  const key = `draftmodel:${String(leadKey)}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  // Well-mixed range (NOT the low bit): FNV-1a's `% 2` depends only on the XOR of
  // byte low bits, which a fixed salt can't decorrelate from the cadence arm and
  // buckets weakly. `% 100` uses well-mixed bits, independent of decideCadenceInviteArm.
  // 3-way (2026-06-24): a ~15% Sonnet canary (anthropic) takes the first slice; the
  // remaining ~85% keeps the gpt-5-mini (control) vs gpt-5 (challenger) split roughly
  // even. The anthropic arm resolves to control when ANTHROPIC_API_KEY is unset (dark).
  const bucket = (h >>> 0) % 100;
  if (bucket < 15) return "anthropic";
  return bucket < 57 ? "control" : "challenger";
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

// Which event_promo leads terminally close+archive on intake vs stay OPEN for staff to work. Only
// pure SWEEPSTAKES (cta "sweepstakes" — anonymous contest entries, no dealer intent) close. Demo-ride
// (cta "demo_ride_event", Joe 2026-07-07) and ride-challenge / national-event RSVP (cta "event_rsvp",
// Joe 2026-07-08) leads are real people at real Harley events and stay visible — they were getting
// closed+archived and MISSED (operator +17168184666: "these gla and event promos are getting closed
// right away and put into the archive box so are getting missed"). Cadence is suppressed for the whole
// event_promo bucket independently (the shouldStartCadence gate excludes bucket === "event_promo"), so
// staying open never starts a follow-up. FAIL DIRECTION: an unrecognized event_promo cta stays OPEN — a
// visible lead staff can ignore beats a real lead silently archived.
export function shouldCloseEventPromoLeadOnIntake(input: {
  classificationBucket?: string | null;
  classificationCta?: string | null;
}): boolean {
  const bucket = String(input.classificationBucket ?? "").toLowerCase();
  const cta = String(input.classificationCta ?? "").toLowerCase();
  return bucket === "event_promo" && cta === "sweepstakes";
}

// ── Ride-challenge event-date cadence anchor (Joe ruling 2026-07-09) ──────────
// "This cadence seems wrong. the ride challenge cadence should be 9/15/26"
// (+15857657010, John Miller). A RIDE CHALLENGE entry is a season-long program, not a
// shopping lead: the right follow-up is ONE touch anchored to the challenge wrap-up
// (2026-09-15 — env RIDE_CHALLENGE_FOLLOWUP_ISO to move it per season), not the standard
// day-N sales drip and not total silence. The decision is pure + structured (keyed on the
// deterministic lead source + classification, never free text). Two consumers:
//   - ADF intake: start the cadence, then pause it until the event date ("event_date"),
//     so the first proactive touch lands at the wrap-up and goes through the normal
//     suggest-mode + cadence-quality gates.
//   - the state-reconcile heal: legacy ride-challenge leads classified BEFORE the 6/24
//     event_promo inference (aec61b68) are still on an ACTIVE standard drip (John's next
//     touch was due 7/4) — realign any active cadence whose next touch lands before the
//     event date.
// Fail-direction: a non-match returns null and nothing changes; a match only DELAYS
// proactive touches (never sends, never closes).
const RIDE_CHALLENGE_SOURCE = /\bride\s+challenge\b/i;
const DEFAULT_RIDE_CHALLENGE_FOLLOWUP_ISO = "2026-09-15T13:00:00.000Z";

export function resolveRideChallengeEventTouch(input: {
  leadSource?: string | null;
  classificationBucket?: string | null;
  classificationCta?: string | null;
  nowMs: number;
  followUpIso?: string | null; // env override plumbed by the caller
}): { pauseUntilIso: string } | null {
  const source = String(input.leadSource ?? "");
  if (!RIDE_CHALLENGE_SOURCE.test(source)) return null;
  const bucket = String(input.classificationBucket ?? "").toLowerCase();
  const cta = String(input.classificationCta ?? "").toLowerCase();
  // event_promo/event_rsvp is the correct post-6/24 classification; general_inquiry/unknown
  // is the legacy pre-inference shape (John Miller class). Anything else (e.g. a ride-challenge
  // entrant who ALSO submitted a prequal → finance_prequal) is a real working lead — leave it.
  const isEventShape = bucket === "event_promo" && cta === "event_rsvp";
  const isLegacyShape = bucket === "general_inquiry";
  if (!isEventShape && !isLegacyShape) return null;
  const iso = String(input.followUpIso ?? "").trim() || DEFAULT_RIDE_CHALLENGE_FOLLOWUP_ISO;
  const eventMs = Date.parse(iso);
  if (!Number.isFinite(eventMs) || eventMs <= input.nowMs) return null; // past-dated event: no touch
  return { pauseUntilIso: new Date(eventMs).toISOString() };
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
// Indefinite customer defer while still engaged (the Chuck Bailey class, +17163197142,
// 2026-07-01, operator-reported: "this probably should not have a follow up after the customer
// saying [still interested... but tied up with family concerns, will get back to you]").
//
// The disposition parser reads such a turn as `defer_no_window`, but the terminal closeout is
// (CORRECTLY) suppressed by the competing-active-intent guard — the lead said they're still
// interested, so we must not close them. Before this decision existed, the turn then fell
// through the short-window deferral resolver (which only knows concrete "a few days" windows)
// and landed in the general draft path with the CADENCE STILL ACTIVE — so the agent kept
// nudging someone who explicitly asked for space.
//
// Decision: an accepted `defer_no_window` that neither closed out nor resolved a concrete
// short window PAUSES the follow-up cadence for a default window (14 days) — the conversation
// stays OPEN, watches stay, and cadence resumes automatically after the window. Fail-direction:
// a false negative keeps today's behavior (nudges continue — annoying but recoverable); a false
// positive pauses two weeks on a live lead (bounded by the parser-acceptance gate).
export type IndefiniteDeferTurnKind = "pause_cadence_default_window" | "none";

export type IndefiniteDeferTurnInput = {
  parserAccepted: boolean;
  disposition?: string | null;
  // true when the with-window/short-window resolver already produced a concrete deferral —
  // that path wins (it carries the customer's own timeframe).
  shortWindowResolved: boolean;
};

export type IndefiniteDeferTurnDecision =
  | { kind: "pause_cadence_default_window"; pauseDays: number }
  | { kind: "none" };

export const INDEFINITE_DEFER_PAUSE_DAYS = 14;

// In-process deal entry (the Jeff Hollfelder / Gary Busenlehner class, Joe-approved 2026-07-02):
// a customer's turn is deal LOGISTICS on a staff-worked purchase (insurance/payoff/delivery/
// paperwork/accessory-install), read by the typed deal-progress parser — the per-turn auto-draft
// stops for these conversations (staff answer with off-system deal facts; the agent's generic
// "I'll check and follow up" was rewritten by staff on 5/7 corrections in the 7/2 audit) and the
// owner-nudge + stale-handoff nets keep coverage. Conservative gates: parser acceptance at a high
// floor; already-protected modes stay untouched; a sold/closed conv is post-sale machinery's job.
export type InProcessDealTurnKind = "enter_in_process_deal" | "none";

export type InProcessDealTurnInput = {
  parserAccepted: boolean;
  dealInProgress: boolean;
  confidence?: number | null;
  followUpMode?: string | null;
  saleRecorded?: boolean;
  conversationClosed?: boolean;
};

export type InProcessDealTurnDecision = { kind: InProcessDealTurnKind };

export const IN_PROCESS_DEAL_CONFIDENCE_FLOOR = 0.8;

export function decideInProcessDealTurn(input: InProcessDealTurnInput): InProcessDealTurnDecision {
  if (!input.parserAccepted || !input.dealInProgress) return { kind: "none" };
  if ((input.confidence ?? 0) < IN_PROCESS_DEAL_CONFIDENCE_FLOOR) return { kind: "none" };
  if (input.conversationClosed || input.saleRecorded) return { kind: "none" };
  const mode = String(input.followUpMode ?? "").toLowerCase();
  if (mode === "manual_handoff" || mode === "paused_indefinite") return { kind: "none" };
  return { kind: "enter_in_process_deal" };
}

export function decideIndefiniteDeferTurn(input: IndefiniteDeferTurnInput): IndefiniteDeferTurnDecision {
  if (input.shortWindowResolved) return { kind: "none" };
  if (!input.parserAccepted) return { kind: "none" };
  if (String(input.disposition ?? "") !== "defer_no_window") return { kind: "none" };
  return { kind: "pause_cadence_default_window", pauseDays: INDEFINITE_DEFER_PAUSE_DAYS };
}

// Non-buyer / passenger survey lead (the Elizabeth Klapa class, 2026-06-25). A Dealer Lead
// App "Passenger" / survey submission whose STRUCTURED purchase-timeframe field says the
// person is explicitly NOT a buyer ("I am not interested in purchasing at this time") was
// answered as if it were a sales inquiry — "Which bike are you asking about?" / "want me to
// send photos or price and payment numbers?". That's out of context: they told us up front
// they don't want to buy. Like decideEventPromoTurn, this keys ONLY on a fixed ADF/lead-gen
// enum field (purchaseTimeframe), so it is structured routing, NOT free-text comprehension.
// The SAME signal already drives resolveInitialAdfCadencePlan -> "suppress" (no nagging
// follow-ups); this is its reply-side twin so the FIRST touch is a warm, no-pressure
// acknowledgement instead of a pitch. Applied at the INITIAL ADF draft only (both paths) —
// once the customer engages with a real sales question, normal routing answers it.
// Fail-direction: a false positive merely under-sells one opener (the customer can still
// reply and gets routed normally); the current bug pitches a self-declared non-buyer.
export type NonBuyerSurveyTurnKind = "non_buyer_survey_ack" | "none";

export type NonBuyerSurveyTurnInput = {
  purchaseTimeframe?: string | null;
};

export type NonBuyerSurveyTurnDecision = { kind: NonBuyerSurveyTurnKind };

export function decideNonBuyerSurveyTurn(input: NonBuyerSurveyTurnInput): NonBuyerSurveyTurnDecision {
  const timeframe = String(input.purchaseTimeframe ?? "").toLowerCase();
  // Mirrors resolveInitialAdfCadencePlan's "suppress" trigger (one source of truth for the
  // "explicit non-buyer" signal). Kept inline (no cross-module import) to match the other
  // self-contained reducers here.
  if (timeframe.includes("not interested")) {
    return { kind: "non_buyer_survey_ack" };
  }
  return { kind: "none" };
}

// Dealer Lead App MARKETING SURVEY lead (the Tim Williams class, +17163741119, 2026-06-24) — the
// buyer-side twin of decideNonBuyerSurveyTurn. Where that keys on the STRUCTURED purchase-timeframe
// field, many DLA surveys embed the whole Q&A in the free-text Customer Comments (ownership history +
// "do you expect to make a purchase?" + "which model are you interested in?" + "Demo Bikes Ridden"),
// so the structured field is empty and the lead falls through to the generic sales generator — which
// read the survey's "Demo Bikes Ridden: <model>" field as a completed test ride at THIS dealer and
// fabricated "Thanks again for coming in for the test ride ... Congrats on the <model>" (held by the
// context-fidelity gate). The survey is comprehended by `parseDealerLeadSurveyWithLLM`; this pure
// decision maps the parse to the FIRST-touch reply: a confident non-buyer reuses the existing
// no-pressure ack, a buyer (or a confident survey of unknown horizon) gets the warm buyer ack
// (acknowledge stated model interest + invite a ride/visit), and anything else routes normally.
// Like decideNonBuyerSurveyTurn this is structured routing off a typed parse, applied at the INITIAL
// ADF draft only (both paths). Fail-direction safe: a false positive on a real inventory lead still
// yields a correct warm opener (no fabricated frame, no false availability claim, no close), and a
// false negative just keeps current behavior (the context-fidelity gate still backstops fabrication).
export type DealerLeadSurveyTurnKind = "buyer_survey_ack" | "non_buyer_survey_ack" | "none";

export type DealerLeadSurveyTurnInput = {
  isDealerLeadSurvey: boolean;
  purchaseIntent?: "buyer" | "non_buyer" | "unknown" | null;
  confidence?: number | null;
};

export type DealerLeadSurveyTurnDecision = { kind: DealerLeadSurveyTurnKind };

export function decideDealerLeadSurveyTurn(
  input: DealerLeadSurveyTurnInput
): DealerLeadSurveyTurnDecision {
  if (!input.isDealerLeadSurvey) return { kind: "none" };
  // Only divert on a confident survey read (mirrors the >= 0.7 floors used by the other ADF
  // parser-driven reducers). Unsure => normal routing answers the lead.
  const confidence =
    typeof input.confidence === "number" && Number.isFinite(input.confidence) ? input.confidence : 0;
  if (confidence < 0.7) return { kind: "none" };
  if (input.purchaseIntent === "non_buyer") return { kind: "non_buyer_survey_ack" };
  // "buyer" or a confident-but-unspecified survey => warm buyer acknowledgement.
  return { kind: "buyer_survey_ack" };
}

// Lead-unit hold/sold disclosure (the Ryan Tower class, +15857278545, LEA-238, 2026-07-04) — the
// customer's ADF lead names an EXACT unit (stock#/VIN), that unit goes on hold for a DIFFERENT
// customer, and the live reply path kept quoting payments and confirming purchase logistics ("bring
// the trade and cash Monday!") without ever disclosing the hold. Hold-awareness existed only in the
// watch-fire engines, the cadence override (buildCadenceLeadUnitAvailabilityOverride), and the
// console — never in the live/regen reply turn. This pure decision says whether THIS outgoing reply
// must carry a one-time availability disclosure; the call sites (BOTH /webhooks/twilio and
// /conversations/:id/regenerate) resolve the inputs (holds/solds lookup by the lead's stock#/VIN)
// and weave the disclosure into the reply.
//
// FAIL DIRECTION: fail toward DISCLOSING. A hold with no/unknown owner conversation still
// discloses (the unit isn't freely available either way); only the customer's OWN hold suppresses
// it (their hold is good news, not a warning). Compliance/system replies (STOP acks, opt-out
// confirmations) and empty replies never carry it — a disclosure there would be nonsense and
// tampering with compliance text is the one direction we never fail toward. Disclose ONCE per
// unit-hold (alreadyDisclosedForThisUnit dedups; re-arms if the hold key changes).
export type LeadUnitAvailabilityDisclosureKind = "disclose_hold" | "disclose_sold" | "none";

export type LeadUnitAvailabilityDisclosureInput = {
  unavailableKind: "hold" | "sold" | null;
  // True when the hold record's convId/leadKey matches THIS conversation (customer's own hold).
  holdOwnedByThisConv: boolean;
  alreadyDisclosedForThisUnit: boolean;
  // True for compliance/system reply kinds (STOP/opt-out acks, invariant fallbacks) — never inject.
  isProtectedReplyKind: boolean;
};

export type LeadUnitAvailabilityDisclosureDecision = { kind: LeadUnitAvailabilityDisclosureKind };

export function decideLeadUnitAvailabilityDisclosure(
  input: LeadUnitAvailabilityDisclosureInput
): LeadUnitAvailabilityDisclosureDecision {
  if (!input.unavailableKind) return { kind: "none" };
  if (input.isProtectedReplyKind) return { kind: "none" };
  if (input.alreadyDisclosedForThisUnit) return { kind: "none" };
  if (input.unavailableKind === "hold" && input.holdOwnedByThisConv) return { kind: "none" };
  return { kind: input.unavailableKind === "hold" ? "disclose_hold" : "disclose_sold" };
}
