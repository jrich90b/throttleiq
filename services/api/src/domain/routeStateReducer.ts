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
  /**
   * The customer-ack parser read this turn as accepting something WE left pending — an offer to
   * send information, or an open scheduling ask. Joe, 2026-08-07: that outranks every other
   * reason to stay quiet, INCLUDING an uncertain read, because the alternative is that a customer
   * who said yes to our own offer hears nothing. It grants a REPLY and nothing else: no booking,
   * no state write, no route arm — those all still require the full acceptance confidence.
   */
  acceptedPendingOfferSignal?: boolean;
};

export type NoResponsePolicyDecision = {
  applicable: boolean;
  action: NoResponsePolicyAction;
  reason:
    | "not_no_response_fallback"
    | "accepted_pending_offer"
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
  | "staff_availability_question"
  | "arrival_window"
  | "immediate_arrival"
  | "purchase_delivery"
  | "arrival_update"
  | "tentative_window"
  | "decline_time"
  | "propose_booking"
  | "offer_slots_in_bound"
  // The customer said YES to OUR OWN open ask for a day/time without naming one. Answer with
  // CONCRETE times off the calendar instead of re-asking the same open question.
  | "offer_times_after_acceptance"
  | "visit_commitment"
  | "scheduling_conflict_continue"
  | "none";

// ---------------------------------------------------------------------------
// RANGE-CONSTRAINT VETO (production incident: Kody +17163975098, 2026-07-16).
//
// "are you guys available anytime later on the day? … I don't think I'll be out
// until after 3 tomorrow" was auto-booked AT 3:00 PM — the excluded bound — 28
// seconds later, because a deterministic concrete-time signal counted "after 3"
// as a clock time and overrode the parser's correct range/question read
// (appointment_timing: intent=ask_for_times, window=range). Staff had to move
// it to 4:00 PM.
//
// This helper is the veto's ONE definition. It reads the PARSER's structured
// output (requested.timeWindow + the parser's own normalized time_text) — this
// is structured extraction over parser output, NOT raw-customer-text
// comprehension: the parser already comprehended the turn and carries the
// window signal (AGENTS.md "comprehend, never regex").
//
// TRUE  = the window is an OPEN-ENDED BOUND: "after 3", "before noon", "later
//         in the day", "past 5", "until 4" — there is no bookable clock time;
//         booking AT the stated hour is exactly the incident.
// FALSE = an approximate POINT ("around 10", "10-ish") or a dealer-proposed
//         window confirm ("11-12"): the parser also labels these range, but
//         they stay bookable at the anchor hour (Chuck Bailey +17163197142 /
//         Rafael "11-12" behaviors, pinned by scheduling_auto_book_on_confirm).
//
// FAIL DIRECTION: a veto fires toward NOT booking (slots get offered honoring
// the bound, or an honest deferral + owner task). A missed veto is the bug.
// ---------------------------------------------------------------------------
export function isOpenEndedTimeBoundParse(requested?: {
  timeWindow?: string | null;
  timeText?: string | null;
} | null): boolean {
  if (!requested) return false;
  if (requested.timeWindow !== "range") return false;
  const t = String(requested.timeText ?? "").toLowerCase();
  if (!t.trim()) return false;
  return /\b(after|before|later|past|until|till|til)\b/.test(t);
}

export type SchedulingTurnInput = {
  // Block A — customer-ack parser (action string + whether the parse was accepted).
  customerAckActionAccepted: boolean;
  customerAckAction?: string | null;
  // The customer confirmed a CONCRETE proposed time and the parser cleared it to book
  // (CustomerAckActionParse.shouldBook). Only then does a confirm route to the auto-book arm.
  customerAckShouldBook?: boolean;
  // RANGE-CONSTRAINT VETO (Kody +17163975098, 7/16): the customer-ack parse's requested
  // window is an OPEN-ENDED BOUND (isOpenEndedTimeBoundParse — "after 3", "later in the
  // day"). A bounded "confirm" must never reach the auto-book arm.
  customerAckOpenEndedBound?: boolean;
  // Block B — appointment-timing parser (intent string + whether accepted).
  appointmentTimingAccepted: boolean;
  appointmentTimingIntent?: string | null;
  // The appointment-timing parse carried a CONCRETE day AND time (not day-only). Gates the
  // provide_new_time → propose_booking arm so a day-only proposal keeps its slot-offer path (#203).
  appointmentTimingHasConcreteDayTime?: boolean;
  // RANGE-CONSTRAINT VETO: the appointment-timing parse's requested window is an
  // OPEN-ENDED BOUND (isOpenEndedTimeBoundParse over the timing parse).
  appointmentTimingOpenEndedBound?: boolean;
  // Block C — inbound_reply_action schedule_context_status_update (accepted).
  parserScheduleStatusUpdate: boolean;
  // DAY-ONLY visit commitment (Joe ruling 2026-07-19, Peter Meredith +17168303999:
  // "Sounds good see you Monday"): the parser read a committed DAY with no time
  // (isParserSoftVisitCommitment over the appointment-timing parse, or a day-only
  // provide_arrival_window ack). A concrete named day IS the schedule context, so this
  // routes to the visit_commitment arm (soft appointment: warm confirm + cadence quiet
  // until the day + dated staff task) WITHOUT the dialog-state/offer-context gates —
  // and never to the "I'll check that time" arrival-window deflection (there is no time
  // to check). Recognition miss => today's behavior; over-fire => a warm confirm + task,
  // never a booking.
  dayOnlyVisitCommitment?: boolean;
  // TIMED visit commitment (Joe ruling 2026-07-28, Terry Majchrzak +17166091289: "I could be
  // there today between 4 and 5"). Same parser shape as dayOnlyVisitCommitment but the customer
  // ALSO named a time (isParserTimedVisitCommitment). A named time belongs on the schedule, so
  // this routes to the SAME book-or-offer resolver a proposed day+time uses instead of the
  // soft-visit hold that let Terry's 4pm slip (staff-reported the same morning).
  timedVisitCommitment?: boolean;
  // OPEN SCHEDULING CONFLICT (William Indelicato +17163591526, 2026-07-24). The
  // inbound-reply-action parser's scheduling_conflict_open slot: we proposed a day/time and the
  // customer answered with uncertainty or a conflicting obligation WITHOUT withdrawing. Unlike
  // every other input here it does NOT depend on a hint-gated parser, which is the whole point —
  // the appointment-timing and customer-ack parsers are both skipped on a turn with no weekday
  // or clock token, which is exactly the turn shape that produced the incident.
  schedulingConflictStillWilling?: boolean;
  // Context gates available where the decision is computed.
  pricingOrPaymentsIntent: boolean;
  scheduleDialogState: boolean;
  scheduleOfferContext: boolean;
};

export type SchedulingTurnDecision = {
  kind: SchedulingTurnKind;
  /** A recognized future-day visit commitment holds (parser + active schedule context, or a day-only parser commitment). */
  visitCommitment: boolean;
};

export function decideSchedulingTurn(input: SchedulingTurnInput): SchedulingTurnDecision {
  // Same recognition as workflowRegressionGuards.scheduleStatusCommitmentOutranksArrivalAck:
  // a visit commitment requires the parser signal AND an active schedule/visit context.
  const visitCommitment =
    !!input.parserScheduleStatusUpdate &&
    !!input.scheduleDialogState &&
    !!input.scheduleOfferContext;
  const dayOnlyCommitment = !!input.dayOnlyVisitCommitment;

  // Block A — customer-ack actions. Mirrors the live customer-ack block: it only fires
  // for these actions and (once entered) always returns, so it has top precedence.
  if (input.customerAckActionAccepted && !input.pricingOrPaymentsIntent) {
    switch (input.customerAckAction) {
      case "confirm_proposed_appointment":
        // Customer confirmed a concrete time the agent didn't pre-offer ("Ya 10 will work",
        // "Around 1pm"). Only route to the auto-book arm when the parser cleared it to book;
        // otherwise fall through (the appointment-timing / lock-in arms handle the soft cases),
        // so we never auto-book on a vague signal.
        if (input.customerAckShouldBook) {
          // RANGE-CONSTRAINT VETO (Kody 7/16): an open-ended bound ("after 3") is NOT a
          // bookable clock time — offer slots honoring the bound instead of booking AT it.
          if (input.customerAckOpenEndedBound) return { kind: "offer_slots_in_bound", visitCommitment };
          return { kind: "confirm_appointment", visitCommitment };
        }
        break;
      case "accept_tentative_appointment":
        return { kind: "accept_tentative", visitCommitment };
      case "accept_scheduling_ask":
        // The customer said YES to our own open "what day/time works?" without naming one.
        // Measured 2026-08-04: 18 engaged leads sat in the booking funnel's `accepted_no_time`
        // bucket — they agreed to come in and no time was ever pinned, the largest single gap
        // between "offered a time" (136) and "booked" (41) over 30 days.
        //
        // GATED on live schedule context as well as the parse. The parser is already told to fire
        // this only when OUR last message asked, but a scheduling route must not rest on the
        // parser's reading of our own text alone: with no schedule context this falls through to
        // today's behavior. Recognition miss => today's behavior (silence). Over-fire => we offer
        // two concrete times to someone who was signing off — recoverable, and never a booking,
        // because this arm cannot book (the customer named no time to book).
        if (input.scheduleOfferContext || input.scheduleDialogState) {
          return { kind: "offer_times_after_acceptance", visitCommitment };
        }
        break;
      case "ask_for_available_times":
        return { kind: "ask_available_times", visitCommitment };
      case "appointment_status_question":
        return { kind: "appointment_status_question", visitCommitment };
      case "staff_availability_question":
        // "Will Stone be there Saturday?" — answer it directly (PRESUME AVAILABLE, read the
        // rep's calendar); the handler owns the calendar IO + reply. Joe ruling 2026-07-23.
        return { kind: "staff_availability_question", visitCommitment };
      case "provide_arrival_window":
        // Visit commitment preempts the vague arrival-window ack (the Todd rule). A DAY-ONLY
        // commitment counts (Peter Meredith): "see you Monday" must never draw the arrival-window
        // "I'll check that time and follow up" deflection — there is no time to check.
        if (!visitCommitment && !dayOnlyCommitment) return { kind: "arrival_window", visitCommitment };
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
    // A customer PROPOSING a concrete day+time to come in ("Tomorrow at 9:30am?") — unprompted, so
    // the customer-ack confirm arm (Block A) never fired. Route it to the SAME calendar-check-and-book
    // resolver as a confirm, or it falls through to the orchestrator and improvises (Mark Ezell
    // +17169904133: "Tomorrow at 930am?" → "I'll check that time and follow up" then a contradictory
    // 9:30/9:40/today mess, never booked). Gated on day AND time so a day-ONLY proposal keeps its
    // slot-offer path (#203). Applied in BOTH /webhooks/twilio and /conversations/:id/regenerate.
    if (
      input.appointmentTimingIntent === "provide_new_time" &&
      input.appointmentTimingHasConcreteDayTime
    ) {
      // RANGE-CONSTRAINT VETO (Kody 7/16): "tomorrow after 3" carries a day AND a timeText,
      // but the time is an open-ended bound — never route it to the book-or-offer resolver
      // (which would book AT the bound); offer slots honoring the bound instead.
      if (input.appointmentTimingOpenEndedBound) {
        return { kind: "offer_slots_in_bound", visitCommitment };
      }
      return { kind: "propose_booking", visitCommitment };
    }
    // The Kody turn shape itself: an availability QUESTION carrying an open-ended bound
    // ("are you guys available anytime later on the day? I don't think I'll be out until
    // after 3 tomorrow" — intent ask_for_times, window range). Claim it for the
    // bound-honoring slot-offer arm so no downstream deterministic day+time signal (the
    // bare-hour "3") can read the bound as a concrete time and auto-book. A plain
    // ask_for_times without a bound keeps its existing fall-through path.
    if (input.appointmentTimingIntent === "ask_for_times" && input.appointmentTimingOpenEndedBound) {
      return { kind: "offer_slots_in_bound", visitCommitment };
    }
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

  // Block B2 — a visit commitment that NAMED A TIME (Joe ruling 2026-07-28, Terry Majchrzak
  // +17166091289: "I could be there today between 4 and 5"). It reaches here rather than the
  // provide_new_time arm because the parser reads a commitment as intent:none, so Block B
  // never claimed it — and Block C below would file it as a soft "might stop by" and never put
  // it on the calendar. A stated day AND time is bookable, so send it to the same
  // book-or-offer resolver as a proposal. Sits BELOW Block A/B (an explicit ack or timing
  // intent still outranks it) and ABOVE the day-only soft-visit arm.
  if (input.timedVisitCommitment) {
    // RANGE-CONSTRAINT VETO (Kody +17163975098, 7/16) applies here too: "I'll be there
    // tomorrow after 3" names a bound, not a clock time — offer slots honoring it.
    if (input.appointmentTimingOpenEndedBound) return { kind: "offer_slots_in_bound", visitCommitment };
    return { kind: "propose_booking", visitCommitment };
  }

  // Block B3 — an OPEN SCHEDULING CONFLICT (William Indelicato +17163591526, 2026-07-24).
  // We asked "What time do you think you can be here on Wednesday?" and got "Unsure I have to
  // have injections into my shoulder" — uncertainty plus a conflicting obligation, no
  // withdrawal. On main that turn reached the disposition-closeout arm instead: the lead was
  // closed and follow-up paused indefinitely, and the draft was a taper sign-off.
  //
  // Precedence: BELOW A/B/B2, so an explicit ack or any concrete day/time the customer names
  // still outranks it (if they give us a bookable time, book it — a conflict answer never
  // steals a booking). ABOVE Block C, because a conflict is the OPPOSITE of a visit
  // commitment: filing it as one would confirm a visit the customer just said they cannot
  // make. Gated on !pricingOrPaymentsIntent like A and B.
  //
  // FAIL DIRECTION: fires toward KEEPING the negotiation open (offer to work around them +
  // an owner follow-up task). A miss is today's behavior; an over-fire costs one warm
  // "what day works best" on a live thread, never a booking and never a close.
  if (input.schedulingConflictStillWilling && !input.pricingOrPaymentsIntent) {
    return { kind: "scheduling_conflict_continue", visitCommitment: false };
  }

  // Block C — recognized future-day visit commitment. The handler additionally gates
  // this on the top-level route (no pricing/availability/callback) where routeExec* is
  // known; this function owns the visit-commitment recognition + precedence. A day-only
  // parser commitment qualifies without the context gates (the named day IS the context).
  if (visitCommitment || dayOnlyCommitment) {
    return { kind: "visit_commitment", visitCommitment: visitCommitment || dayOnlyCommitment };
  }

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
  // RANGE-CONSTRAINT VETO (Kody +17163975098, 7/16): the parse's requested window is an
  // OPEN-ENDED BOUND ("after 3" — isOpenEndedTimeBoundParse). Belt-and-suspenders net under
  // decideSchedulingTurn's routing veto: even if a bounded parse reaches this resolver, it
  // must NEVER book or confirm a slot AT the bound → fall_back (lock-in ask + owner task).
  rangeConstrained?: boolean;
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
  // RANGE-CONSTRAINT VETO: a bound ("after 3") is not a bookable clock time — never a
  // booked/lock-in confirm at the bound. The caller's IO must also skip the calendar write.
  if (input.rangeConstrained) return { kind: "fall_back" };
  if (!input.requestedResolved) return { kind: "fall_back" };
  if (!input.availabilityChecked) return { kind: "fall_back" };
  if (input.slotFree) {
    if (!input.book) return { kind: "regen_lock_in" };
    return input.bookSucceeded ? { kind: "booked" } : { kind: "fall_back" }; // write failed => NO false confirm
  }
  return { kind: "offer_alternatives", hasAlternatives: input.hasAlternatives };
}

// Staff-side confirm of a PENDING appointment request (manual outbound). The customer asked for a
// concrete slot (an open "Appointment requested." todo carries it) and a staff member typed an
// affirmative reply ("Sounds good! See you then"). That confirmation must BOOK the calendar — the
// task's objective is a calendar entry, and closing anything short of booking buries an un-booked
// visit. The old inline gate required existingBookedAppointmentIsPast, i.e. it ONLY worked as a
// REBOOK after an old appointment — a FIRST booking (no appointment at all) fell through entirely:
// William +17163591526 (7/20) asked "thursday 9a", staff replied "Sounds good! See you then", and
// nothing was booked, the request todo sat open (operator-reported). The fix: fire when there is NO
// live booking (first booking) OR the existing booking is already past (the original rebook case);
// a LIVE future booking still hard-excludes (never silently rebook over it — the dedupe guard owns
// that turn). An affirmative WITH a question mark is a question, not a confirm. Booking IO failure
// downstream fails safe (state reverts + a staff conflict task; pinned by the caller's own arm).
export type ManualConfirmPendingAppointmentInput = {
  hasPendingRequestText: boolean; // an open "Appointment requested." todo with a parseable Requested: phrase
  hasBookedEvent: boolean; // a calendar event id exists on the conversation
  existingBookedAppointmentIsPast: boolean; // that event's time is >1h in the past
  hasAffirmativeAck: boolean; // the staff outbound contains an affirmative phrase
  hasQuestionMark: boolean; // the staff outbound asks something instead of confirming
};

export function decideManualConfirmPendingAppointment(
  input: ManualConfirmPendingAppointmentInput
): { confirm: boolean } {
  if (!input.hasPendingRequestText) return { confirm: false };
  if (!input.hasAffirmativeAck) return { confirm: false };
  if (input.hasQuestionMark) return { confirm: false };
  if (input.hasBookedEvent && !input.existingBookedAppointmentIsPast) return { confirm: false };
  return { confirm: true };
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

// ── Staff-availability question ("Will Stone be there Saturday?") ───────────────────────────
// Joe ruling (2026-07-23, Davey +17164255036): a customer asking whether a rep will be at the
// store on a given day gets answered DIRECTLY, policy PRESUME AVAILABLE — "the salesman should
// be available all times unless there is a scheduling block saying something like day off." The
// handler reads the rep's Google Calendar for the asked day; this PURE decision turns that IO
// result into one of three arms. Extracted (like decideCustomerAckConfirmBooking) so the
// fail-direction is unit-testable without booting the server or hitting Google Calendar.
//
// FAIL DIRECTION (hard): we NEVER guess a NO. A flip to "day_off" requires an EXPLICIT day-off
// block on the calendar. If the rep can't be resolved OR the calendar can't be read/parsed, we
// fall to "check_with" (a named "let me check with <rep>" + a task on the rep) — a safe handoff,
// never a fabricated absence and never a fabricated confirm.
export type StaffAvailabilityAnswerInput = {
  repResolved: boolean; // we mapped the asked-about rep to a roster entry with a calendar
  calendarReadable: boolean; // the calendar read for the asked day succeeded (no throw)
  dayOffBlock: boolean; // an explicit day-off/vacation/PTO block covers the asked day
};
export type StaffAvailabilityAnswerKind = "present" | "day_off" | "check_with";
export type StaffAvailabilityAnswerDecision = { kind: StaffAvailabilityAnswerKind };

export function decideStaffAvailabilityAnswer(
  input: StaffAvailabilityAnswerInput
): StaffAvailabilityAnswerDecision {
  // Can't resolve who / can't read the calendar → never guess; hand to the rep.
  if (!input.repResolved) return { kind: "check_with" };
  if (!input.calendarReadable) return { kind: "check_with" };
  // Only an EXPLICIT day-off block flips PRESUME-AVAILABLE to not-in.
  if (input.dayOffBlock) return { kind: "day_off" };
  // Default: the rep is presumed working.
  return { kind: "present" };
}

// Day-off block detection over Google Calendar event SUMMARIES for the asked day. This is
// structured extraction of our OWN calendar data (AGENTS.md allows deterministic here), NOT
// comprehension of free-form customer language. A day-off block reads like "Day off", "OFF",
// "Vacation", "PTO", "OOO"/"out of office", "not in". Ordinary busy events (a booked test ride,
// a meeting) are NOT day-off blocks — presence still holds around them.
// FAIL DIRECTION: err toward NOT matching (→ present). We only assert not-in on an unambiguous
// day-off phrase, so a missed match keeps the safe "yes, presumed in" answer.
export function summaryIndicatesStaffDayOff(summary: string | null | undefined): boolean {
  const s = String(summary ?? "").toLowerCase();
  if (!s.trim()) return false;
  if (/\bday\s*off\b/.test(s)) return true;
  if (/\bout\s*of\s*office\b/.test(s) || /\bo\.?o\.?o\.?\b/.test(s)) return true;
  if (/\bvacation\b/.test(s) || /\bpto\b/.test(s) || /\bp\.?t\.?o\.?\b/.test(s)) return true;
  if (/\bpersonal\s+day\b/.test(s) || /\bsick\b/.test(s) || /\bfurlough\b/.test(s)) return true;
  if (/\bnot\s+(?:in|working|here)\b/.test(s)) return true;
  // A bare "off" token ("Stone - OFF", "OFF today"), guarded so it doesn't match "office",
  // "offer", "off-site sales event", etc. — only a standalone word.
  if (/(?:^|[^a-z])off(?:$|[^a-z])/.test(s) && !/off[\s-]*site/.test(s)) return true;
  return false;
}

export function staffDayOffFromSummaries(summaries: Array<string | null | undefined>): boolean {
  return summaries.some(summaryIndicatesStaffDayOff);
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

// A booked appointment that is SETTLED: its day is already past AND staff recorded that the
// customer SHOWED. Such an appointment has nothing left to reschedule — the visit happened.
//
// Why this exists (+17165011693, James Mercer, 2026-07-22). That thread carried
// `appointment.reschedulePending: true`, latched since 2026-05-16 and never cleared when staff
// logged the May 2 outcome as `showed`. The latch is self-renewing (the reschedule arm re-sets it
// on every fire), so it armed the thread indefinitely. When the agent pitched a newly-arrived Tri
// Glide and the customer answered with a pure budget objection — "Still a little rich for me. Im
// looking in the 18 to 20 thousand range. But thanks Gio" — the stale latch routed the turn into
// the reschedule arm and we texted a test-ride booking link 14 seconds later. Nothing in that
// sentence is about timing. Three live conversations were armed the same way.
//
// FAIL DIRECTION: this reads ONLY already-structured state (`whenIso`, the recorded outcome) and
// never customer text, so it is a state/side-effect invariant guard — deterministic is correct
// here (AGENTS.md rule 2), not comprehension. A false positive merely skips the reschedule
// deflection and lets the turn fall through to the ordinary draft (which, on this very turn,
// produced the right answer: "I'll keep an eye out for trikes in the $18–20k range"). A false
// negative is exactly today's behavior. So when the outcome is absent or unrecognized we return
// false and keep the existing path — never suppress a rebook the customer is genuinely owed.
//
// Deliberately scoped to the SHOWED family only: `did_not_show` and `cancelled` latches are real
// rebook debts and must keep working.
export function isSettledPastAppointment(input: {
  whenIso: string | null | undefined;
  nowMs: number;
  timeZone: string;
  outcomePrimaryStatus?: string | null;
  outcomeLegacyStatus?: string | null;
}): boolean {
  const pastDay = isStaleBookedAppointmentDay({
    whenIso: input.whenIso,
    nowMs: input.nowMs,
    timeZone: input.timeZone
  });
  if (!pastDay) return false;
  return isShowedAppointmentOutcome(input.outcomePrimaryStatus, input.outcomeLegacyStatus);
}

// Normalizes the two ways an attendance outcome is stored to the single question "did they show?".
// `primaryStatus` is the modern field; older records carry only the legacy `status`, whose
// showed-family values mirror mapLegacyAppointmentOutcome() in index.ts. Unknown/blank => false
// (fail toward keeping the current behavior).
function isShowedAppointmentOutcome(
  primaryStatusRaw: string | null | undefined,
  legacyStatusRaw: string | null | undefined
): boolean {
  const primary = String(primaryStatusRaw ?? "").trim().toLowerCase();
  if (primary === "showed" || primary === "showed_up") return true;
  // An explicit non-showed primary status wins outright — don't second-guess it via the legacy field.
  if (primary) return false;
  const legacy = String(legacyStatusRaw ?? "").trim().toLowerCase();
  return (
    legacy === "showed" ||
    legacy === "showed_up" ||
    legacy === "sold" ||
    legacy === "hold" ||
    legacy === "already_on_hold" ||
    legacy === "no_change" ||
    legacy === "financing_declined" ||
    legacy === "financing_needs_info" ||
    legacy === "bought_elsewhere" ||
    legacy === "lost" ||
    legacy === "other"
  );
}

// May we TELL a customer they missed their appointment?
//
// Production fixture: +17167506588 (Sudheer Gurajala, appointment Sat 2026-06-27 1:00 PM ET). At
// 18:06:08Z he texted "Sorry I had a flat tire" — a running-late note, not a cancellation. At
// 18:29:10Z we answered "Hey s R, I see you were not able to make it in for the appointment."
// At that moment `appointment.staffNotify.outcome` was ABSENT: nobody had recorded anything. He
// then showed up and left a deposit; the outcome was written as `showed`/`hold` at 18:42.
//
// Two defects stacked. `buildAppointmentOutcomeRescheduleReply` asserted the no-show in its
// FALLBACK branch, so a blank `primaryStatus` produced the strongest possible factual claim. And
// the regen gate (`regenAppointmentOutcomeRescheduleReply`) fired on the bare `reschedulePending`
// latch: `isSettledPastAppointment` only vetoes past-day + `showed`, so a blank outcome sails
// through. Regen requires `!isRegenerateInboundActionableForRouting`, i.e. it fires precisely when
// the turn carries NO signal — "Sorry I had a flat tire" has no model/price/day/time token.
//
// This guard answers only the narrow question the copy depends on: is there a RECORDED
// missed-family outcome, and has the appointment time actually arrived? Staff clicking
// "Did not show" in the console is the ground truth (that click is what legitimately produced
// Aaron Smith's +13463990700 send 8 seconds later). We never infer a no-show from elapsed time.
//
// FAIL DIRECTION: reads ONLY structured state (`whenIso`, the recorded outcome), never customer
// text — a state/copy invariant guard, deterministic per AGENTS.md rule 2. A false negative drops
// the no-show SENTENCE and still offers the rebook (neutral copy), so the customer keeps every
// path forward; a false positive is today's bug — telling a customer who is on his way, or who
// already arrived, that he failed to appear. Unknown/blank outcome => false.
//
// The time check is start-time based, NOT `isStaleBookedAppointmentDay` (which keeps same-day as
// "not stale"): a same-day no-show recorded at 3pm for a 1pm slot is the COMMON case and must keep
// its copy. It exists only to block asserting a no-show before the slot has begun — the
// +17165350411 mis-click pattern (outcome logged 21s before the text, corrected to `showed` later).
export function canAssertMissedAppointment(input: {
  whenIso: string | null | undefined;
  nowMs: number;
  outcomePrimaryStatus?: string | null;
  outcomeLegacyStatus?: string | null;
}): boolean {
  if (!isMissedAppointmentOutcome(input.outcomePrimaryStatus, input.outcomeLegacyStatus)) {
    return false;
  }
  const startMs = Date.parse(String(input.whenIso ?? ""));
  // No parseable start time: a human explicitly recorded the miss, so trust the click.
  if (!Number.isFinite(startMs)) return true;
  return startMs <= input.nowMs;
}

// Normalizes the two outcome fields to "did the customer fail to appear?". Mirrors the showed-family
// helper above; `primaryStatus` is the modern field and an explicit primary wins outright, with the
// legacy `status` consulted only when primary is blank. Unknown/blank => false (never assert).
function isMissedAppointmentOutcome(
  primaryStatusRaw: string | null | undefined,
  legacyStatusRaw: string | null | undefined
): boolean {
  const primary = String(primaryStatusRaw ?? "").trim().toLowerCase();
  if (primary) {
    return primary === "did_not_show" || primary === "no_show" || primary === "cancelled";
  }
  const legacy = String(legacyStatusRaw ?? "").trim().toLowerCase();
  return legacy === "did_not_show" || legacy === "no_show" || legacy === "cancelled";
}

// The scheduling cluster — may a PENDING-RESCHEDULE latch stand in for this turn's intent?
//
// `appointment.reschedulePending` is STATE, not something the customer said. Treating it as a
// standalone sufficient condition for "they want to reschedule" means any inbound at all — a
// budget objection, a thank-you — gets answered with a booking link (+17165011693, above). This
// function makes the latch an ENABLER: it may only carry the turn when a signal read from THIS
// turn accompanies it.
//
// FAIL DIRECTION: if every signal misses we do NOT send an unsolicited booking link; the turn
// falls through to the normal draft path. Removal fails toward answering the customer, never
// toward performing the side effect — so by the AGENTS.md migrate-vs-keep test this is
// comprehension, and the intent signals must come from the parsers, not from stored state.
// `explicitReschedulePhrase` stays a KEEP disjunct: it matches explicit reschedule wording only,
// and its removal would fail toward dropping a real reschedule request.
export function pendingRescheduleCarriesTurnIntent(input: {
  reschedulePending: boolean;
  settledPastAppointment: boolean;
  explicitReschedulePhrase: boolean;
  hasRequestedDayTime: boolean;
  parserExplicitScheduleIntent: boolean;
  parserSchedulingAckAction?: string | null;
}): boolean {
  if (!input.reschedulePending) return false;
  // A settled (past + showed) appointment has no rebook debt — the latch is dead regardless.
  if (input.settledPastAppointment) return false;
  return (
    input.explicitReschedulePhrase ||
    input.hasRequestedDayTime ||
    input.parserExplicitScheduleIntent ||
    isSchedulingAcceptanceAckAction(input.parserSchedulingAckAction)
  );
}

// Ack-parser actions that mean the customer is engaging the rebook we offered ("want to get you
// back in?" -> "yes please"). Keeps the legitimate no_show/cancelled rebook flow alive once the
// bare latch stops qualifying on its own.
function isSchedulingAcceptanceAckAction(action: string | null | undefined): boolean {
  const value = String(action ?? "").trim();
  return (
    value === "confirm_proposed_appointment" ||
    value === "accept_tentative_appointment" ||
    value === "ask_for_available_times" ||
    value === "provide_arrival_window" ||
    value === "immediate_arrival_request"
  );
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

// --- Under-specified equipment ask → CLARIFY up to a style/type (Joe, 2026-07-25) --------------
//
// A PURE equipment ask with NO bike type — "something with bags and a windshield" — names equipment
// but no model, no family, and no segment/style. #292/#294 mint watches only when there IS a
// model/family/segment to anchor the fire test, and the Phase B equipment SEARCH would otherwise
// run vision over the WHOLE lot to answer it. Joe's ruling: don't drop it and don't build a
// watch-the-whole-inventory modality — CLARIFY up to a segment. Ask what STYLE/type they want (and
// new vs used); the customer's answer ("a cruiser") turns the NEXT turn into a normal segment +
// equipment request that #292/#294 + Phase B already handle.
//
// This owns ONLY the precedence decision from the parser's already-extracted slots (never regex over
// intent): the Phase B requested_equipment features + the glossary include_segments, plus whether a
// concrete model/family was referenced this turn. The reply (and the route wiring in BOTH paths)
// stay in index.ts's shared resolveVehicleRecommendationReply.
//
// FAIL DIRECTION = `none` (untouched): flag off, no equipment named, OR any bike type present
// (segment/model/family) → we do NOT clarify. A request that already HAS a style ("a cruiser with
// bags") proceeds to the equipment search unchanged; a request with NO equipment is untouched. We
// clarify ONLY when equipment is named with zero bike type — the genuinely under-specified case.
export type EquipmentClarifyTurnKind = "clarify" | "none";

export type EquipmentClarifyTurnInput = {
  // The equipment-vision canary is on (INVENTORY_EQUIPMENT_VISION_ENABLED). Flag off → never clarify.
  visionEnabled: boolean;
  // Parser (requested_equipment) named at least one equipment feature this turn.
  hasEquipmentFeatures: boolean;
  // Parser (include_segments) resolved a style/type — a cruiser, bagger/touring, sport, etc.
  hasSegment: boolean;
  // A concrete model was referenced this turn (e.g. "Road King with bags").
  hasModel: boolean;
  // A model family was referenced this turn (e.g. "a Softail with bags").
  hasFamily: boolean;
};

export type EquipmentClarifyTurnDecision = {
  kind: EquipmentClarifyTurnKind;
};

export function decideEquipmentClarifyTurn(
  input: EquipmentClarifyTurnInput
): EquipmentClarifyTurnDecision {
  if (!input.visionEnabled) return { kind: "none" }; // canary off → today's behavior, no change
  if (!input.hasEquipmentFeatures) return { kind: "none" }; // no equipment named → untouched
  // Any bike type/style/model/family present → NOT under-specified. The equipment ask is anchored, so
  // #292/#294 (watches) and the Phase B equipment search proceed unchanged.
  if (input.hasSegment || input.hasModel || input.hasFamily) return { kind: "none" };
  // Equipment named with ZERO bike type → clarify UP to a segment (ask style + new/used).
  return { kind: "clarify" };
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
// Photo-question vision (DARK behind PHOTO_QUESTION_VISION_ENABLED, Joe 2026-07-28). A customer asks
// about a photo WE sent. Centralized route decision (both paths): answer a benign visual question,
// describe + hand a FUNCTIONAL/condition question to a tech (never diagnose from a still), or take a
// closer look when we can't read it confidently. Fail direction: any uncertainty → a human/tech, never
// a fabricated condition claim.
export type PhotoQuestionTurnInput = {
  parserAccepted: boolean;
  asksAboutSentPhoto: boolean;
  textConfidence: number;
  confidenceMin: number;
  hasSentPhoto: boolean;
  visionAccepted: boolean;
  isFunctionalQuestion: boolean;
  canAnswerVisually: boolean;
  visionConfidence: number;
};
export type PhotoQuestionTurnDecision = {
  kind: "answer_visual" | "describe_and_handoff" | "closer_look_handoff" | "none";
};

export function decidePhotoQuestionTurn(input: PhotoQuestionTurnInput): PhotoQuestionTurnDecision {
  if (!input.parserAccepted || !input.asksAboutSentPhoto) return { kind: "none" };
  if (!Number.isFinite(input.textConfidence) || input.textConfidence < input.confidenceMin) return { kind: "none" };
  if (!input.hasSentPhoto) return { kind: "none" }; // no photo we sent to reason about => existing handling
  if (!input.visionAccepted) return { kind: "closer_look_handoff" }; // couldn't read it => a human looks
  // A functional / condition / "is it broken?" question is NEVER answered from a still — describe what's
  // visible + the scene context, then hand to a tech (Joe ruling 2026-07-28).
  if (input.isFunctionalQuestion) return { kind: "describe_and_handoff" };
  // A benign visual question we can confidently answer from the photo => answer it directly.
  if (input.canAnswerVisually && input.visionConfidence >= input.confidenceMin) return { kind: "answer_visual" };
  return { kind: "closer_look_handoff" }; // uncertain => a human takes a closer look
}

export type VehicleMediaRequestTurnInput = {
  parserAccepted: boolean;
  wantsMedia: boolean;
  confidence: number;
  confidenceMin: number;
  /** Customer wants MORE / different photos than what's posted (always a task — site isn't enough). */
  wantsAdditionalPhotos: boolean;
  /** Any resolved/discussed unit at all (from the customer's reference or the recommender). */
  hasUnits: boolean;
  /** Any resolved unit has a REAL photo gallery (>= MIN_REAL_PHOTOS) we can text. */
  hasUnitsWithRealPhotos: boolean;
  /** Any resolved unit has NO real gallery (no photos or just a stock shot) — needs a salesperson. */
  hasUnitsNeedingPhotos: boolean;
};
export type VehicleMediaRequestTurnDecision = {
  kind: "send_media" | "send_and_task" | "salesperson_photo_task" | "none";
};

export function decideVehicleMediaRequestTurn(input: VehicleMediaRequestTurnInput): VehicleMediaRequestTurnDecision {
  if (!input.parserAccepted) return { kind: "none" };
  if (!input.wantsMedia) return { kind: "none" };
  if (!Number.isFinite(input.confidence) || input.confidence < input.confidenceMin) return { kind: "none" };
  if (!input.hasUnits) return { kind: "none" }; // no unit context at all => existing handling
  // Send the REAL photos we have — but NOT when the customer wants MORE than what's posted (they've
  // seen the site gallery; re-sending it is unhelpful → that's a salesperson task).
  const sendPart = input.hasUnitsWithRealPhotos && !input.wantsAdditionalPhotos;
  // A salesperson task is needed when they want additional photos, OR any discussed bike has no real
  // gallery (no photos or just a stock shot — Joe 2026-07-27: a stock image must become a task).
  const taskPart = input.wantsAdditionalPhotos || input.hasUnitsNeedingPhotos;
  if (sendPart && taskPart) return { kind: "send_and_task" }; // send the real ones, task the rest
  if (sendPart) return { kind: "send_media" };
  if (taskPart) return { kind: "salesperson_photo_task" };
  return { kind: "none" };
}

// --- Inventory unit clarification (2026-07-10; centralized 2026-07-19) --------
// A customer confirming/disambiguating the YEAR (or which of two quoted units) of the vehicle
// ALREADY under discussion — e.g. "Is it a 15 or 16?" — is answered from context, never routed to
// the stock-availability deflection. Centralized so BOTH /webhooks/twilio and
// /conversations/:id/regenerate make the IDENTICAL gate decision (route-parity law) instead of
// hand-mirroring it as regen-locals in the regenerate handler.
//
// FAIL DIRECTION: default is `false` — fall through to normal availability/inventory routing. We
// only capture the turn as a context-answer when the parser flags it (`isActiveUnitClarification`)
// or the caller's legacy lexical fallback fires, AND the thread is not human-owned.
export type InventoryUnitClarificationTurnInput = {
  mode?: string | null;
  isActiveUnitClarification?: boolean | null;
  legacyLexicalMatch?: boolean | null; // path-specific fail-safe fallback (see callers)
};

export function decideInventoryUnitClarificationTurn(
  input: InventoryUnitClarificationTurnInput
): boolean {
  if (String(input.mode ?? "").toLowerCase() === "human") return false;
  return !!input.isActiveUnitClarification || !!input.legacyLexicalMatch;
}

// --- Proactive cadence value gate (2026-07-20, Joe: "no spam — later cadences must be high quality")
// The LATER proactive cadence must be VALUE-driven, not time-driven filler. Early touches (the initial
// engagement sequence) still fire. But a LATER touch fires ONLY when a genuine value trigger exists for
// the lead's bike: matching new inventory (existing watch fire), a real national offer on their model
// (nationalOffers.ts), a genuine test-ride opportunity, or a price drop on an interested unit (future).
// Otherwise the cadence STAYS QUIET — that is the anti-spam behavior, not a miss.
//
// This is a PURE precedence decision (a deterministic side-effect/state gate, which AGENTS.md allows):
// the comprehension — "is there really a matching offer / inventory?" — lives upstream in the typed
// parsers/matchers; this only decides whether/what to fire from the signals they produce. Applied in
// BOTH /webhooks/twilio and /conversations/:id/regenerate (route-parity law).
//
// FAIL DIRECTION: a later touch with no value signal → fire:false (silence). Removing this gate fails
// toward SENDING (today's filler) — so it is a suppression gate, deliberately fail-toward-quiet here
// because Joe's directive is explicitly "stop the spam"; early touches are never gated.
export type ProactiveCadenceValueKind = "new_inventory" | "national_offer" | "test_ride" | "price_drop";

export type ProactiveCadenceValueInput = {
  /** true for a later-stage proactive step (value-gated); false for early engagement touches (always fire). */
  isLaterStage: boolean;
  hasNewInventoryMatch?: boolean | null; // a matching in-stock unit surfaced (existing watch trigger)
  hasNationalOfferMatch?: boolean | null; // a genuine national offer applies to their bike (new trigger)
  hasTestRideOffer?: boolean | null; // a real test-ride opportunity to extend
  hasPriceDrop?: boolean | null; // price cut on an interested unit (future trigger; wire when built)
  /**
   * The customer has actually engaged at least once — customerEngagedWithCadence (conversationStore):
   * any real inbound message, or a voice call they genuinely participated in. OMITTED/false = never
   * engaged, and a never-engaged lead is NOT pitched a national offer (see below).
   */
  customerEverEngaged?: boolean | null;
};

export type ProactiveCadenceValueDecision =
  | { fire: true; valueKind: ProactiveCadenceValueKind | null; reason: string }
  | { fire: false; valueKind: null; reason: string };

export function decideProactiveCadenceValue(
  input: ProactiveCadenceValueInput
): ProactiveCadenceValueDecision {
  // Early-stage touches are the initial engagement sequence — always allowed, not value-gated.
  if (!input.isLaterStage) return { fire: true, valueKind: null, reason: "early_stage_touch" };
  // Later stage: fire ONLY on a genuine value trigger. Precedence: concrete inventory news first,
  // then a real offer, then a test-ride opportunity, then a price drop.
  if (input.hasNewInventoryMatch) return { fire: true, valueKind: "new_inventory", reason: "matching_inventory" };
  // A national offer is the one value kind that VOLUNTEERS PAYMENT FIGURES ("from $406/month with
  // 10% down for 96 months"), so it additionally requires that the customer has ever engaged.
  //
  // Production miss (+16102170861, Seth Farrand — open-critic unsolicited_financing_quote_on_trade_lead):
  // a "Trade Accelerator - Trade In" lead who asked what his 2018 Street Glide S was WORTH and then
  // never wrote back once got a touring-program monthly payment pitched at him on 7/21 (sent) and
  // again on 8/1 (drafted). The offer matched only because the lead card's buy-side vehicle (a 2026
  // Road Glide) is a touring model — the gate never asked whether he had said anything at all.
  //
  // FAIL DIRECTION: removing this condition fails toward TEXTING PAYMENT NUMBERS at a silent lead —
  // a money claim nobody asked for. Keeping it fails toward silence on a promo, which the next step
  // re-offers the moment they reply. Same shape as the leadUnitUnavailable guard (Joe ruling
  // 2026-07-28, Jason Roorda +17165104578) — unit-specific money talk is gated, not the whole touch.
  // Deliberately gates ONLY this arm: inventory news, a test-ride invite and a price drop are all
  // still sayable to a quiet lead. Omitted signal = not engaged = quiet (fail-safe default).
  if (input.hasNationalOfferMatch && input.customerEverEngaged) {
    return { fire: true, valueKind: "national_offer", reason: "matching_national_offer" };
  }
  if (input.hasTestRideOffer) return { fire: true, valueKind: "test_ride", reason: "test_ride_opportunity" };
  if (input.hasPriceDrop) return { fire: true, valueKind: "price_drop", reason: "price_drop" };
  // No value this cycle → stay quiet (the anti-spam gate).
  return { fire: false, valueKind: null, reason: "no_value_trigger_stay_quiet" };
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
  // When the thumbs-down note is a staff INSTRUCTION (parseThumbsDownNoteWithLLM → action_request),
  // its action becomes the CONTROLLING directive for the redraft — the note tells the reply what to
  // DO ("tell the customer to stop in when they're in town"), not just what was wrong.
  controllingInstruction?: string | null;
};

export type FeedbackRedraftTurnDecision = { kind: "redraft" | "record_only"; steering?: string };

export function buildFeedbackRedraftSteering(
  reason?: string | null,
  note?: string | null,
  controllingInstruction?: string | null
): string {
  const instruction = String(controllingInstruction ?? "").replace(/\s+/g, " ").trim();
  if (instruction) {
    // A staff instruction OVERRIDES the rejected draft's content — obey it, don't merely "fix" the
    // old reply (production miss: the note "Tell the customer to stop in when they are in town" was
    // treated as a vague hint and the redraft re-offered tee shipping twice).
    return (
      `A staff reviewer rejected the previous draft and gave a direct instruction you MUST follow: ` +
      `"${instruction}". Rewrite the reply so it does exactly what that instruction says. Do NOT ` +
      `repeat the rejected draft's offer or re-propose anything the instruction steers away from. ` +
      `Keep it on-voice (like texting a friend), and never fabricate a price, availability, stock, or appointment.`
    );
  }
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
  return {
    kind: "redraft",
    steering: buildFeedbackRedraftSteering(input.reason, input.note, input.controllingInstruction)
  };
}

/**
 * A 👎 redraft must not break the GLA demo-ride ruling (Joe ruling 2026-07-29, Braedon Halpin
 * +18455515759).
 *
 * Joe ruled on 2026-07-02 that a corporate/GLA demo-ride lead (bucket=event_promo,
 * cta=demo_ride_event) gets ONE warm soft invite and nothing else: the ride does not happen at the
 * dealership, so a scheduling push is wrong, a sweepstakes "good luck!" ack is wrong, and
 * `buildDemoRideEventSoftInvite` deliberately contains NO appointment offer, NO availability claim
 * and NO fabricated completed-ride frame ("thanks for your recent demo ride") — the lead SOURCE
 * alone never proves the ride happened.
 *
 * That ruling was only enforced on the arrival paths, which compose the invite deterministically.
 * The 👎 redraft path re-composes freely with `generateDraftWithLLM`, so on 7/28 staff down-rated
 * Braedon's (correct) invite and the redraft produced "Awesome that you **demoed** the Low Rider ST
 * with the Stage IV. Swing by American H-D to check out bikes…" — the fabricated completed-ride
 * frame AND the dealership visit push, i.e. both halves of the ruling, in one message. Staff filed
 * it a minute later. The redraft carried `hadReason: false` — no note at all.
 *
 * PRECEDENCE — an explicit staff INSTRUCTION still wins. Joe's 2026-07-23 obey-the-note ruling
 * exists because staff know things the model doesn't; a human deliberately steering this lead is
 * different in kind from the model inventing a ride that never happened. So: `action_request` note
 * => free redraft (staff drives); anything else (no note, or a note that only says what was wrong)
 * => rebuild the deterministic soft invite.
 *
 * Pure decision over the structured classification pair, applied at the single redraft site.
 * FAIL DIRECTION: a missing/unknown bucket or cta falls through to the ordinary redraft, so this
 * only ever constrains the one lead class Joe ruled on.
 */
export function decideDemoRideRedraftGuard(input: {
  bucket?: string | null;
  cta?: string | null;
  hasControllingInstruction?: boolean;
}): { kind: "soft_invite" | "free_redraft"; reason: string } {
  const bucket = String(input.bucket ?? "").trim().toLowerCase();
  const cta = String(input.cta ?? "").trim().toLowerCase();
  if (bucket !== "event_promo" || cta !== "demo_ride_event") {
    return { kind: "free_redraft", reason: "not_demo_ride_event_lead" };
  }
  if (input.hasControllingInstruction) {
    return { kind: "free_redraft", reason: "staff_instruction_outranks_guard" };
  }
  return { kind: "soft_invite", reason: "demo_ride_event_lead_deterministic_invite" };
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

// --- Thumbs-down NOTE routing (2026-07-10) -----------------------------------
// A thumbs-down note (parseThumbsDownNoteWithLLM) does one of two jobs: it asks a PERSON to do
// something for a live customer ("book him in at 9:30") or it reports a code DEFECT ("wrong unit").
// The old path funneled every note into the code-fix classifier, so action requests silently died in
// a shadow report that ignores anything it hasn't seen 3+ times. This decides where a note goes.
//
//   staff_action   → surface the note to a HUMAN in the morning digest (a customer is waiting).
//   reply_defect   → hand to the existing failure-mode diagnosis (decideFeedbackDiagnosisAction).
//   record_only    → coaching/one-off; the nightly voice loop already sees it, nobody is waiting.
//
// FAIL DIRECTION: stranding a live customer is the expensive miss, so `unclear` AND any low-confidence
// read route to staff_action, never record_only. We would rather put a coaching nit in front of a
// human than let "book him in" evaporate. Only a CONFIDENT reply_defect / coaching leaves the human lane.
export type ThumbsDownNoteRoute = "staff_action" | "reply_defect" | "record_only";

export type ThumbsDownNoteRoutingInput = {
  parserAccepted: boolean;
  noteKind?: "action_request" | "reply_defect" | "coaching" | "unclear" | null;
  confidence: number;
  confidenceMin: number; // default 0.7 at the call site
};

export function decideThumbsDownNoteRouting(input: ThumbsDownNoteRoutingInput): ThumbsDownNoteRoute {
  // Parser off/failed, or the note is ambiguous → a human reads it. Never silently dropped.
  if (!input.parserAccepted) return "staff_action";
  if (input.noteKind === "action_request") return "staff_action"; // a customer is waiting; confidence-independent
  if (input.noteKind === "unclear") return "staff_action";
  // Below here we have a non-action classification. Trust it only when the parser is confident;
  // an unsure "it's just coaching" could be a missed action request, so fail toward the human.
  if (!Number.isFinite(input.confidence) || input.confidence < input.confidenceMin) return "staff_action";
  if (input.noteKind === "reply_defect") return "reply_defect";
  return "record_only"; // confident coaching
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
// ACQUISITION ARM (Joe, 2026-08-04 — Mark Kocsis +17168609533). A watch alert drew "Thanks for
// keeping me in mind but I actually just picked up a 2023 street glide anniversary edition." Telling
// us they BOUGHT A BIKE is not the same as "stop the alerts", and Joe wants it handled differently:
// congratulate them, say we are here for anything the bike needs, take them off the watch list, and
// close the lead ONCE THAT REPLY ACTUALLY GOES OUT. Hence a second kind rather than a flag —
// `pause_watch` deliberately KEEPS a live lead (they may still buy from us), this one does not.
//
// FAIL DIRECTION is stricter here than for pause_watch, because closing a live lead is the expensive
// mistake: it takes the acquisition intent AND the same confidence floor, and the close is DEFERRED
// — the caller arms it and only a genuinely SENT acknowledgement fires it. A draft staff discard
// leaves the lead exactly where it was. Everything unsure still falls to `none`.
export type WatchOptOutTurnKind = "acknowledge_and_close" | "pause_watch" | "none";

export type WatchOptOutTurnInput = {
  hasActiveWatch: boolean;
  parserAccepted: boolean;
  intent?: string | null; // "acquired_vehicle" | "watch_opt_out" | "none"
  confidence: number;
  confidenceMin: number;
};

export type WatchOptOutTurnDecision = {
  kind: WatchOptOutTurnKind;
};

// --- The lost-sale closeout acknowledgement (Joe, 2026-08-07) ----------------
// "Can the agents let the customer know if they need anything for their new bike to let us know?"
//
// The wording already existed (buildAcquiredVehicleAck, Joe's 2026-08-04 rule) but only the WATCH
// lane could reach it, and only outside human mode. Everyone else walking away got the generic
// goodbye — +15853528447, "I appreciate your time, but I purchased a bike at a different
// dealership", answered with "I hear you. If anything changes down the road, just give me a shout."
//
// WHY THIS RIDES ON THE CLOSEOUT AND NOT ON THE MESSAGE. Measured over the 30 days to 2026-08-07,
// the acquired-vehicle read on raw turns is wrong more often than right once it leaves the watch
// lane: it called a customer's own TRADE-IN, a tour pack, a Chevy Traverse lease and a bike being
// brought IN to us all "acquired_vehicle" at 0.85-0.9. Executed against those same five turns, the
// DISPOSITION parser answers `none` for every one of them, so none reaches a closeout. That is the
// whole safety argument: the congratulation can only ever ride on top of a walk-away we are already
// confident about. It never reads a message on its own.
//
// FAIL DIRECTION: the generic goodbye. Every uncertain input returns "generic", which is exactly
// today's behaviour — we close the lead and say the neutral line. The only thing this can get wrong
// in the other direction is congratulating someone who is walking away for a different reason, and
// that needs BOTH an accepted disposition closeout AND an explicit purchase statement above the
// confidence floor.
export type LostSaleCloseoutAckKind = "lost_sale" | "generic";

export type LostSaleCloseoutAckInput = {
  /** The acquired/opt-out parser's read of THIS turn. */
  intent?: string | null;
  confidence: number;
  confidenceMin: number;
  /** The bike they named in THIS message, never carried over from the thread or lead record. */
  vehicle?: string | null;
  /** Do they actually have alerts to come off? Decides one clause of the wording. */
  hasActiveWatch: boolean;
  /**
   * Did WE sell them a bike? Then "I just bought the bike" means OURS, and a congratulation is
   * wrong. Kevin +17163440581, 2026-07-21, one day after taking delivery: "Bro your brother just
   * called me and said I had to pay for another set I dad what I just bought the bike" — an
   * annoyed customer arguing about a $150 key fob, read as a purchase at 0.9. It is the ONLY false
   * positive among the six purchases that reached a closeout in 30 days, and this closes it.
   *
   * A STATE gate (closedReason "sold" / sale.soldAt / post_sale cadence), never a word gate.
   */
  hasPostSaleContext?: boolean;
};

export type LostSaleCloseoutAckDecision = {
  kind: LostSaleCloseoutAckKind;
  /** The closeout reason to record. "customer_bought_elsewhere" is an OUTCOME, never re-engaged. */
  closeReason: string | null;
  vehicle: string;
  removesFromAlertList: boolean;
};

const GENERIC_ACK: LostSaleCloseoutAckDecision = {
  kind: "generic",
  closeReason: null,
  vehicle: "",
  removesFromAlertList: false
};

export function decideLostSaleCloseoutAck(
  input: LostSaleCloseoutAckInput
): LostSaleCloseoutAckDecision {
  if (String(input.intent ?? "") !== "acquired_vehicle") return GENERIC_ACK;
  // We sold them this bike — "I just bought it" is about OURS. Never congratulate our own buyer
  // on a purchase, and never imply they bought elsewhere.
  if (input.hasPostSaleContext) return GENERIC_ACK;
  const confidence = Number(input.confidence);
  const floor = Number(input.confidenceMin);
  if (!Number.isFinite(confidence) || !Number.isFinite(floor)) return GENERIC_ACK;
  if (confidence < floor) return GENERIC_ACK;
  // Naming the wrong bike is worse than naming none, so a blank simply falls back to the generic
  // congratulations — the same rule the watch lane already follows.
  const vehicle = String(input.vehicle ?? "").replace(/\s+/g, " ").trim();
  return {
    kind: "lost_sale",
    closeReason: "customer_bought_elsewhere",
    vehicle: vehicle.length <= 60 ? vehicle : "",
    removesFromAlertList: !!input.hasActiveWatch
  };
}

export function decideWatchOptOutTurn(input: WatchOptOutTurnInput): WatchOptOutTurnDecision {
  if (!input.hasActiveWatch) return { kind: "none" }; // nothing to remove
  if (!input.parserAccepted) return { kind: "none" };
  const acquired = input.intent === "acquired_vehicle";
  if (!acquired && input.intent !== "watch_opt_out") return { kind: "none" };
  if (!Number.isFinite(input.confidence) || input.confidence < input.confidenceMin) {
    return { kind: "none" };
  }
  return { kind: acquired ? "acknowledge_and_close" : "pause_watch" };
}

// --- Deferred closeout, fired by an actual SEND (Joe, 2026-08-04) ------------
// "After we send draft and it goes through it should close the lead."
//
// The close cannot happen when the draft is WRITTEN, because in suggest mode a draft is a proposal —
// staff may edit it, sit on it, or throw it away. So the acquisition turn ARMS a closeout and the
// send route fires it. Nothing else may write `conv.status` off the back of this: the firing call
// goes through `applyLeadCloseout`, the one closeout referee (#484).
//
// FAIL DIRECTION: refuse. Every uncertain input leaves the lead OPEN, which is recoverable — a lead
// that should have closed just sits in the inbox, whereas a wrongly closed one silently stops being
// worked. The interesting refusal is the third: if the customer has said ANYTHING since we armed,
// they have re-engaged, and whatever they now want outranks a stale "close after send" note.
export type PendingCloseoutSendKind = "close_lead" | "none";

export type PendingCloseoutSendInput = {
  /** Is a closeout armed on this conversation at all? */
  armed: boolean;
  /** When it was armed (ms). Non-finite = cannot compare = refuse. */
  armedAtMs: number;
  /** The newest INBOUND message time (ms), or null when there is none. */
  lastInboundAtMs: number | null;
  /** `conv.status === "closed"` — already done, nothing to fire. */
  alreadyClosed: boolean;
};

export type PendingCloseoutSendDecision = {
  kind: PendingCloseoutSendKind;
  /** Drop the arm even when we refuse to close — a stale arm must not linger and fire later. */
  clearArm: boolean;
  why: string;
};

export function decidePendingCloseoutOnSend(
  input: PendingCloseoutSendInput
): PendingCloseoutSendDecision {
  if (!input.armed) return { kind: "none", clearArm: false, why: "no closeout is armed on this lead" };
  if (input.alreadyClosed) {
    return { kind: "none", clearArm: true, why: "the lead is already closed — drop the stale arm" };
  }
  if (!Number.isFinite(input.armedAtMs)) {
    return { kind: "none", clearArm: true, why: "the arm carries no usable timestamp — refuse and drop it" };
  }
  if (input.lastInboundAtMs !== null && input.lastInboundAtMs > input.armedAtMs) {
    return {
      kind: "none",
      clearArm: true,
      why: "the customer has written since we armed — they re-engaged, so the lead stays open"
    };
  }
  return { kind: "close_lead", clearArm: true, why: "the acknowledgement went out — close the lead" };
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

// --- Subjectless web-lead handoff (2026-08-10) -----------------------------
//
// The SAME parser verdict (`parseAdfDepartmentInterestWithLLM`) that routes a department request
// also answers a second, narrower question: did the customer identify ANY subject at all? Its
// `none` verdict means "a greeting, an unrelated topic, or no identifiable subject" — and on a web
// form that carries no bike, that is precisely the lead the agent cannot answer.
//
// Production miss (Timothy Patrick, +13049475135, Ref 11753, "Room58 - Contact Us", 2026-08-08):
// the ADF body ended `Inquiry:\nHome` — the PAGE the form sat on, not anything he typed — and the
// only place left to land was the purchase-intent fallback, which asked "Which bike are you asking
// about?" about a bike nobody had named. Joe removed that question by hand before sending. Measured
// 2026-08-09 across the two catch-all web forms: 26 leads, and ZERO let the customer pick a bike —
// the `Harley-Davidson Full Line` on every one of them is the form's own filler, so no sample size
// turns it into a customer choice. Same family as the walk-in note graded as customer speech: text
// that is not the customer talking, read as if it were.
//
// The treatment is the one the structurally identical twin form already gets (`isRoom58Standard`,
// live since 2026-03-12): the pinned ack, a staff todo, `manual_handoff`, cadence stopped — because
// a human has to find out what the customer actually wants. NOT a new reply class and not new copy;
// the sibling's exact sentence pair.
//
// DELIBERATELY parser-driven, not a page-name/junk-word list. Enumerating "Home" would be the
// keyword-scan anti-pattern on n=1 ("Home" is the only bare page name in all 830 conversations);
// the parser already answers "did they actually ask something?" without anyone listing anything.
//
// FAIL DIRECTION: unsure => none => today's behaviour exactly. A bike named on the lead, an
// inventory stock id/VIN, no parser verdict, low confidence, or ANY department other than `none`
// (a real parts/apparel/service/course request, or `vehicle` — the default for bike shoppers) all
// keep the existing path. The only turns this can change are the ones that would have asked which
// bike with no bike on record, so the worst case is a lead the agent could have engaged getting a
// human instead — which is the reversible direction, and the 26-lead measurement says that lead
// does not exist on these forms.
// ---------------------------------------------------------------------------

/**
 * Marker written to `followUp.reason` when this referee hands the lead to a person. The nightly
 * replay judge's design-accept keys on this EXACT string rather than sniffing the body, so the
 * accept can never widen past the referee's own decision.
 */
export const NO_SUBJECT_WEB_LEAD_HANDOFF_REASON = "no_subject_web_lead";

/**
 * The raw ADF department parse, narrowed to the three fields the referees read. Pulled out of the
 * route so an eval can EXECUTE the carrying step instead of asserting how it is spelled: a mapping
 * that quietly hardcodes `accepted: false` reads identical to a correct one in source, and that is
 * the one sabotage a source pin cannot catch.
 */
export type AdfDepartmentVerdict = {
  accepted: boolean;
  department: "apparel" | "parts" | "service" | "vehicle" | "riding_academy" | "none" | null;
  confidence: number;
};

export function toAdfDepartmentVerdict(
  parse: { department?: string | null; confidence?: number | null } | null | undefined
): AdfDepartmentVerdict {
  return {
    accepted: !!parse,
    department: (parse?.department ?? null) as AdfDepartmentVerdict["department"],
    confidence: parse?.confidence ?? 0
  };
}

export type NoSubjectWebLeadHandoffKind = "handoff" | "none";

export type NoSubjectWebLeadHandoffInput = {
  isInitialAdf: boolean;
  /** A SPECIFIC model on the lead (a placeholder like "Full Line" is not one). */
  hasNamedBike: boolean;
  hasInventoryIdentifiers: boolean;
  parserAccepted: boolean;
  department?: "apparel" | "parts" | "service" | "vehicle" | "riding_academy" | "none" | null;
  confidence: number;
  confidenceMin: number;
};

export type NoSubjectWebLeadHandoffDecision = {
  kind: NoSubjectWebLeadHandoffKind;
  /** `followUp.reason` to record on a handoff; empty string when nothing changes. */
  reason: string;
};

export function decideNoSubjectWebLeadHandoff(
  input: NoSubjectWebLeadHandoffInput
): NoSubjectWebLeadHandoffDecision {
  const none: NoSubjectWebLeadHandoffDecision = { kind: "none", reason: "" };
  if (!input.isInitialAdf) return none;
  if (input.hasNamedBike || input.hasInventoryIdentifiers) return none;
  if (!input.parserAccepted) return none;
  if (!Number.isFinite(input.confidence) || input.confidence < input.confidenceMin) return none;
  if (input.department !== "none") return none;
  return { kind: "handoff", reason: NO_SUBJECT_WEB_LEAD_HANDOFF_REASON };
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

// --- Budget gated on the financing (Franklin +17164208660, 2026-08-10) -----
//
// We ask a shopper "what budget should I target?" and they answer that it depends on the
// FINANCING — the down payment, the monthly payment, what they qualify for. That is an answer,
// not a non-answer, and it names the one thing the agent cannot help with. The live miss: he
// replied "No I want used and I don't know it depends on how much money I have to put down"
// and the next draft asked for a budget range again, because the clarifier's budget hint is a
// six-word list that could not see the sentence. Joe ruled 2026-08-10: "it should probably hand
// it to finance, only finance can handle that info."
//
// Distinct from decideFinanceProcessQuestionTurn, which owns a QUESTION about the financing
// process (deadlines, sequencing) and requires an explicit request. This one owns a STATEMENT
// tying spending capacity to financing terms, so it deliberately does NOT gate on
// explicitRequest — the customer is not asking us anything.
//
// FAIL DIRECTION: unsure => none, and today's behavior runs (at worst one redundant clarifying
// question). We only hand off on a confident read, because a wrong handoff pulls a person into
// a thread that did not need one.
// ---------------------------------------------------------------------------
export type BudgetGatedOnFinancingTurnKind = "finance_handoff" | "none";

export type BudgetGatedOnFinancingTurnInput = {
  parserAccepted: boolean;
  intent?: string | null; // "budget_gated_on_financing" | "none"
  confidence: number;
  confidenceMin: number;
};

export type BudgetGatedOnFinancingTurnDecision = {
  kind: BudgetGatedOnFinancingTurnKind;
};

export function decideBudgetGatedOnFinancingTurn(
  input: BudgetGatedOnFinancingTurnInput
): BudgetGatedOnFinancingTurnDecision {
  if (!input.parserAccepted) return { kind: "none" };
  if (input.intent !== "budget_gated_on_financing") return { kind: "none" };
  if (!Number.isFinite(input.confidence) || input.confidence < input.confidenceMin) {
    return { kind: "none" };
  }
  return { kind: "finance_handoff" };
}

// --- "We have enough — hand off instead of asking again" (John Zimmerman, 2026-08-10) ------
//
// He arrived on a SUBMITTED HDFS credit application for a 2026 Road Glide. We asked "Are you
// looking at the Road Glide, or open to a couple of options?"; he answered "Couple options" — our
// own second option, in our own words — and the routing parser returned fallback_action "clarify",
// so the draft asked him what he meant. Reachable customer, submitted credit app, bike question
// settled, and we interrogated him.
//
// Joe, 2026-08-10: "the agent has to know when we have enough info and to handoff — we don't need
// the agent to keep asking questions."
//
// This is the FIFTH C1.7 exception (see advanceEveryReplySuppressed in draftChannelRules.ts): a
// question is advancing while we are still discovering and stalling once a salesperson could take
// the lead as-is. All three inputs must be POSITIVELY known — the money path via a real artefact
// (cta hdfs_coa / an explicit cash-or-finance answer), never a prequal ORIGIN label, mirroring
// decideBusinessManagerFinanceOutcomePrompt's artefact-not-origin rule.
//
// FAIL DIRECTION: unsure => keep_asking. A premature handoff spends a salesperson on a lead still
// qualifying itself; a late one costs one more question.
// ---------------------------------------------------------------------------
export type SalesHandoffReadinessKind = "handoff" | "keep_asking";

export type SalesHandoffReadinessInput = {
  /** A phone or email we can actually reach them on. */
  contactable: boolean;
  /** A real finance ARTEFACT or an explicit cash/finance answer — never a prequal origin label. */
  moneyPathKnown: boolean;
  /** The parser settled which bike: a specific model, or explicit openness to a shortlist. */
  bikeScopeSettled: boolean;
  /** Already on a person's desk — never hand off twice. */
  alreadyHandedOff: boolean;
  /** A booked appointment already settles the thread (C1.7 exception #2). */
  appointmentBooked: boolean;
};

export type SalesHandoffReadinessDecision = { kind: SalesHandoffReadinessKind; reason: string };

export function decideSalesHandoffReadiness(
  input: SalesHandoffReadinessInput
): SalesHandoffReadinessDecision {
  if (input.alreadyHandedOff) return { kind: "keep_asking", reason: "already_handed_off" };
  if (input.appointmentBooked) return { kind: "keep_asking", reason: "appointment_booked" };
  if (!input.contactable) return { kind: "keep_asking", reason: "no_contact_method" };
  if (!input.moneyPathKnown) return { kind: "keep_asking", reason: "money_path_unknown" };
  if (!input.bikeScopeSettled) return { kind: "keep_asking", reason: "bike_scope_unsettled" };
  return { kind: "handoff", reason: "enough_info_for_a_salesperson" };
}

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

// --- Service-scheduling handoff vs sales visit (Justin Alley, 2026-07-21) --
//
// A SALES thread got claimed by the service department: the customer asked about a sale
// bike's maintenance history, OUR OWN replies filled the thread with "service" words
// ("we're doing the 5,000 mile service on it right now"), and when the customer then named
// a visit time ("between 5 and 6") the deterministic service-context hint
// (isServiceDepartmentSchedulingRequest) routed the turn to a SERVICE scheduling handoff —
// wrong department, wrong reply, and it rewrote the conversation's classification to
// service. The Bobby Kindred defer (6/25) only covers answers to OUR visit-time question;
// this covers the customer VOLUNTEERING a time inside an in-flight sales visit plan.
//
// The comprehension question ("which department is this visit for?") belongs to a typed
// parser (parseVisitDepartmentPurposeWithLLM); this pure decision owns the precedence.
//
// FAIL DIRECTION: an explicit customer service ask this turn ALWAYS wins (deterministic
// gate — the parser can never talk us out of an explicit request). Parser null/unknown =>
// status quo (service_handoff) — behavior-preserving when the LLM is down. We only defer
// to the sales scheduling cluster on a CONFIDENT parser sales_visit read.
// ---------------------------------------------------------------------------
export type ServiceSchedulingHandoffRoute = "service_handoff" | "defer_to_scheduling_cluster";

export type ServiceSchedulingHandoffTurnInput = {
  serviceContextHint: boolean; // isServiceDepartmentSchedulingRequest fired for this turn
  customerNamedServiceThisTurn: boolean; // explicit service-department ask in the CUSTOMER's words this turn
  parserPurpose?: "service_visit" | "sales_visit" | "unknown" | null;
  parserConfidence?: number | null;
  confidenceMin: number;
  /**
   * OUR last outbound was a dealer-initiated visit-time check-in ("what time are you coming in?")
   * that did not itself name the service department. Biases the turn back to the sales scheduling
   * cluster (Bobby Kindred, 2026-06-25) — but as a DEFAULT the parser can outrank, not a verdict.
   */
  dealerVisitTimeCheckIn?: boolean;
};

export type ServiceSchedulingHandoffTurnDecision = {
  route: ServiceSchedulingHandoffRoute;
  reason:
    | "no_service_context"
    | "explicit_service_request"
    | "parser_sales_visit"
    | "visit_time_checkin_not_service"
    | "service_handoff_default";
};

export function decideServiceSchedulingHandoffTurn(
  input: ServiceSchedulingHandoffTurnInput
): ServiceSchedulingHandoffTurnDecision {
  if (!input.serviceContextHint) {
    return { route: "defer_to_scheduling_cluster", reason: "no_service_context" };
  }
  if (input.customerNamedServiceThisTurn) {
    return { route: "service_handoff", reason: "explicit_service_request" };
  }
  const confidence = typeof input.parserConfidence === "number" ? input.parserConfidence : 0;
  if (input.parserPurpose === "sales_visit" && confidence >= input.confidenceMin) {
    return { route: "defer_to_scheduling_cluster", reason: "parser_sales_visit" };
  }
  // The customer is ANSWERING our own visit-time check-in ("what time works?" → "Probably around
  // 4pm"). That framing normally means a plain sales visit, so it defers (Bobby Kindred). It used
  // to be settled in index.ts by testing the check-in for the literal word "service", which reads
  // COMPREHENSION off a keyword: Edward Trouse (+17166281539, operator-reported 2026-08-01) bought
  // a Breakout, called about the NYS inspection sticker, and staff answered "let me know when you
  // want to bring it in and we can put a new sticker on the bike" — plainly a service visit that
  // never says "service", so his "Probably around 4pm" was booked as a SALES appointment and filed
  // a sales availability task. The deferral now lives here as the DEFAULT and a confident
  // service_visit parse outranks it; anything less (sales_visit, unknown, no parse, low
  // confidence) still defers, so the fail direction is unchanged.
  if (
    input.dealerVisitTimeCheckIn &&
    !(input.parserPurpose === "service_visit" && confidence >= input.confidenceMin)
  ) {
    return { route: "defer_to_scheduling_cluster", reason: "visit_time_checkin_not_service" };
  }
  return { route: "service_handoff", reason: "service_handoff_default" };
}

// --- Finance-hardship turn (2026-07-15, refined 2026-07-16) -----------------
//
// A customer who surfaces a personal CREDIT / FINANCING situation gets ONE of two safe replies —
// never a bot-quoted rate/APR or approval promise:
//  - DISTRESS (real current financial pain — fresh bankruptcy, "can't afford anything", job loss):
//    a warm, non-solutioning hand-off to the finance manager. No co-signer pitch — that reads as
//    tone-deaf (Joe ruling 2026-07-15).
//  - DECLINE (a credit QUALIFYING obstacle a co-signer can realistically fix while they still want
//    the bike — no/thin/bad credit, prior denial, past bankruptcy, identity theft, high-rate worry):
//    an empathetic CO-SIGNER NUDGE (Joe, 2026-07-16 — refines 7/15: the John Geschwender no-credit-
//    score case should get the nudge, not a silent handoff).
// Centralized + pure; the parser signal is fed in and applied in BOTH /webhooks/twilio and
// /conversations/:id/regenerate.
//
// FAIL DIRECTION: unsure => none, and the existing finance handling runs. We only act on a confident,
// explicit disclosure; an ambiguous hardship read is parsed as decline (the softer co-signer nudge).
// ---------------------------------------------------------------------------
export type FinanceHardshipTurnKind = "finance_hardship_handoff" | "finance_cosigner_nudge" | "none";

export type FinanceHardshipTurnInput = {
  parserAccepted: boolean;
  hardshipKind?: string | null; // "distress" | "decline" | "none"
  explicitRequest: boolean;
  confidence: number;
  confidenceMin: number;
};

export type FinanceHardshipTurnDecision = {
  kind: FinanceHardshipTurnKind;
};

export function decideFinanceHardshipTurn(
  input: FinanceHardshipTurnInput
): FinanceHardshipTurnDecision {
  if (!input.parserAccepted) return { kind: "none" };
  if (!input.explicitRequest) return { kind: "none" };
  if (!Number.isFinite(input.confidence) || input.confidence < input.confidenceMin) {
    return { kind: "none" };
  }
  if (input.hardshipKind === "distress") return { kind: "finance_hardship_handoff" };
  if (input.hardshipKind === "decline") return { kind: "finance_cosigner_nudge" };
  return { kind: "none" };
}

// --- Incoming-unit purpose (2026-07-16) ------------------------------------
//
// WHY a bike is coming in decides how we describe it to the customer. The old rule guessed from the
// structured `condition` alone (new => "on order", anything else => "your trade"), which called a used
// bike the dealer was SOURCING for a buyer "the 2015 Road King trade" (Bill Indelicato +17163591526,
// Joe 2026-07-16). The comprehended purpose (parseIncomingInventoryPurposeWithLLM) is fed in here.
//
// FAIL DIRECTION: no parser / low confidence / unclear => "unclear", which renders the NEUTRAL
// "coming in" copy — true whether it's a trade-in or a purchase, so we never make a wrong "trade"
// claim. We only say "trade" on a confident, explicit trade_in read.
// ---------------------------------------------------------------------------
export type IncomingInventoryPurpose = "trade_in" | "sourced_for_purchase" | "factory_order" | "unclear";

export type IncomingInventoryPurposeInput = {
  parserAccepted: boolean;
  purpose?: string | null;
  // WHO the incoming unit is allocated to (Joe ruling 2026-07-19, Peter Arnoldo +17166887637).
  // "spoken_for_other" (at/above the confidence floor) is what diverts a walk-in watch into a
  // staff handoff — anything else keeps today's behavior.
  allocation?: string | null;
  confidence: number;
  confidenceMin: number;
  condition?: string | null;
};

export type IncomingInventoryAllocation = "spoken_for_other" | "for_this_customer" | "unclear";

export function decideIncomingInventoryPurpose(
  input: IncomingInventoryPurposeInput
): { purpose: IncomingInventoryPurpose; allocation: IncomingInventoryAllocation } {
  // Allocation is accepted only from a confident parse — a wrong "spoken_for_other" would
  // suppress a legitimate availability watch, so anything uncertain fails to "unclear"
  // (= today's behavior: watch + generic ack).
  const allocationAccepted =
    input.parserAccepted &&
    Number.isFinite(input.confidence) &&
    input.confidence >= input.confidenceMin;
  const allocation: IncomingInventoryAllocation =
    allocationAccepted &&
    (input.allocation === "spoken_for_other" || input.allocation === "for_this_customer")
      ? input.allocation
      : "unclear";
  // A structured `new` condition is a factory order regardless of the parser — a dealer never takes a
  // brand-new bike in on trade. (Keeps the 2026-06 Nicholas Braun pre-order fix intact.)
  if (String(input.condition ?? "").trim().toLowerCase() === "new") {
    return { purpose: "factory_order", allocation };
  }
  if (!input.parserAccepted) return { purpose: "unclear", allocation };
  if (!Number.isFinite(input.confidence) || input.confidence < input.confidenceMin) {
    return { purpose: "unclear", allocation };
  }
  if (
    input.purpose === "trade_in" ||
    input.purpose === "sourced_for_purchase" ||
    input.purpose === "factory_order"
  ) {
    return { purpose: input.purpose, allocation };
  }
  return { purpose: "unclear", allocation };
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
  // MEASURED 2026-08-07 on +16076549423, by driving the live handler and reading the recorded
  // route outcome: this referee — not the lexical sign-off gate, not the response-control gate —
  // is what actually silenced "That would be great" after our own offer to send incentives. It
  // returned `no_actionable_context`, because "the customer accepted the thing we offered" was not
  // in its list of actionable turn contexts (finance, availability, scheduling, callback). Two
  // earlier fixes to the other two gates changed nothing at all for that reason.
  if (input.acceptedPendingOfferSignal) {
    return {
      applicable: true,
      action: "override",
      reason: "accepted_pending_offer"
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

export type InventoryWatchPendingClearInput = {
  followUpMode?: string | null;
  followUpReason?: string | null;
  dialogState?: string | null;
  hasInventoryWatchPending?: boolean;
  inventoryWatchPendingAgeHours?: number | null;
  hasWatchIntent?: boolean;
  hasFinanceIntent?: boolean;
  hasSchedulingIntent?: boolean;
  hasDepartmentIntent?: boolean;
  /**
   * The conversation-state parser explicitly reported that the customer has moved off the
   * pending watch (`ConversationStateParse.clearInventoryWatchPending`). It is a reason to
   * clear, never a licence to skip the keep-guards below.
   */
  parserRequestedClear?: boolean;
};

export type InventoryWatchPendingClearDecision = {
  clearInventoryWatchPending: boolean;
  /** dialogState `inventory_watch_prompted` should fall back to `none`. */
  clearInventoryWatchPrompt: boolean;
  reasons: string[];
};

/**
 * THE ONE REFEREE for "may this inbound drop the pending inventory-watch prompt?".
 *
 * Two places used to answer this independently and disagreed (un-stacking slice, 2026-08-04):
 * `reduceStaleWorkflowStateForInbound` asked the guarded rule below, while
 * `applyConversationStateReducer` cleared on a bare `departmentIntent !== "none"` with no
 * guards at all. That second rule dropped the watch even when the lead was parked in
 * `holding_inventory`, even when the follow-up reason WAS the inventory watch, and even when
 * the same turn showed watch intent — i.e. it failed toward silently forgetting a customer's
 * "tell me when one lands". Per AGENTS.md fail-direction the guarded rule wins: prefer
 * failing toward KEEPING the watch, because re-asking is recoverable and a dropped watch is
 * a customer who never hears from us again.
 */
export function resolveInventoryWatchPendingClear(
  input: InventoryWatchPendingClearInput
): InventoryWatchPendingClearDecision {
  const mode = normalizeLower(input.followUpMode);
  const reason = normalizeLower(input.followUpReason);
  const dialogState = normalizeLower(input.dialogState);
  const hasInventoryWatchPending = !!input.hasInventoryWatchPending;
  const hasWatchIntent = !!input.hasWatchIntent;
  const hasFinanceIntent = !!input.hasFinanceIntent;
  const hasSchedulingIntent = !!input.hasSchedulingIntent;
  const hasDepartmentIntent = !!input.hasDepartmentIntent;
  const pendingAgeHoursRaw =
    typeof input.inventoryWatchPendingAgeHours === "number"
      ? input.inventoryWatchPendingAgeHours
      : NaN;
  const pendingAgeHours = Number.isFinite(pendingAgeHoursRaw) ? pendingAgeHoursRaw : null;

  const reasons: string[] = [];
  let clearInventoryWatchPending = false;

  if (hasInventoryWatchPending && !shouldKeepInventoryWatchPending(mode, reason) && !hasWatchIntent) {
    if (mode === "manual_handoff") {
      clearInventoryWatchPending = true;
      reasons.push("clear_watch_pending_manual_handoff");
    } else if (hasFinanceIntent || hasSchedulingIntent || hasDepartmentIntent) {
      clearInventoryWatchPending = true;
      reasons.push("clear_watch_pending_context_shift");
    } else if (input.parserRequestedClear) {
      clearInventoryWatchPending = true;
      reasons.push("clear_watch_pending_parser_signal");
    } else if (pendingAgeHours != null && pendingAgeHours >= 24) {
      clearInventoryWatchPending = true;
      reasons.push("clear_watch_pending_expired");
    }
  }

  const clearInventoryWatchPrompt =
    dialogState === "inventory_watch_prompted" &&
    !hasWatchIntent &&
    (clearInventoryWatchPending || hasFinanceIntent || hasSchedulingIntent || hasDepartmentIntent);
  if (clearInventoryWatchPrompt) reasons.push("clear_inventory_watch_prompted_after_shift");

  return { clearInventoryWatchPending, clearInventoryWatchPrompt, reasons };
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

  // The pending-watch question has ONE referee; this used to inline the rule.
  const watchPending = resolveInventoryWatchPendingClear({
    followUpMode: mode,
    followUpReason: reason,
    dialogState,
    hasInventoryWatchPending,
    inventoryWatchPendingAgeHours: pendingAgeHours,
    hasWatchIntent,
    hasFinanceIntent,
    hasSchedulingIntent,
    hasDepartmentIntent
  });
  clearInventoryWatchPending = watchPending.clearInventoryWatchPending;
  if (watchPending.clearInventoryWatchPrompt) setDialogStateToNone = true;
  reasons.push(...watchPending.reasons);

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

// Which flavour of the non-sales ack to render. The routing decision (kind) is IDENTICAL
// for both — the whole non-demo event_promo bucket gets an ack and every precedence guard
// keys on `kind === "event_promo_ack"`. `ackVariant` only selects the WORDING at the three
// ack-build sites: a marketing/mailing-list OPT-IN (cta="list_opt_in") gets "you're on the
// list" (buildMarketingOptInAck); a sweepstakes/RSVP/bare event_promo gets the contest
// thank-you (buildEventPromoAck). Keeping `kind` unchanged means adding the opt-in variant
// touches no precedence/close/cadence logic — only the customer-facing sentence.
export type EventPromoAckVariant = "contest" | "list_opt_in";

export type EventPromoTurnInput = {
  classificationBucket?: string | null;
  classificationCta?: string | null;
};

export type EventPromoTurnDecision = { kind: EventPromoTurnKind; ackVariant: EventPromoAckVariant };

export function decideEventPromoTurn(input: EventPromoTurnInput): EventPromoTurnDecision {
  const bucket = String(input.classificationBucket ?? "").toLowerCase();
  const cta = String(input.classificationCta ?? "").toLowerCase();
  if (bucket === "event_promo" && cta !== "demo_ride_event") {
    return { kind: "event_promo_ack", ackVariant: cta === "list_opt_in" ? "list_opt_in" : "contest" };
  }
  return { kind: "none", ackVariant: "contest" };
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

// ── Owner-named personal thread step-back (Joe, 2026-07-09, Mark Kocsis +17168609533) ──
// A customer who opens with the assigned owner's NAME ("Hey Scott this is Mark"), replying to
// that owner's own recent HUMAN outbound, is having a two-person conversation with their
// salesperson — the AI persona must not take it over (Mark's turn drew a garbled availability
// draft instead of Scott's attention). Decision: step back — suppress the auto-draft and hand
// the owner a call/reply task. Deterministic structured extraction: the greeting is matched
// against the KNOWN assigned-owner first name (never open-text comprehension), and it only
// fires when the last outbound really was a human send from staff. Fail-direction: firing
// wrongly = no auto reply + a visible owner task (humanward, recoverable); missing = today's
// behavior. Applied in BOTH /webhooks/twilio and /conversations/:id/regenerate.
export type OwnerThreadStepBackInput = {
  inboundText?: string | null;
  ownerFirstName?: string | null; // conv.leadOwner first name (known, structured)
  lastOutboundWasHumanSend: boolean; // last outbound before this inbound was a real staff send (not draft_ai)
};

export type OwnerThreadStepBackDecision = { kind: "owner_thread_step_back" | "none" };

export function decideOwnerThreadStepBack(input: OwnerThreadStepBackInput): OwnerThreadStepBackDecision {
  if (!input.lastOutboundWasHumanSend) return { kind: "none" };
  const owner = String(input.ownerFirstName ?? "").trim().toLowerCase();
  if (!owner || owner.length < 3) return { kind: "none" }; // too-short names ("al") risk false hits
  const text = String(input.inboundText ?? "").trim().toLowerCase();
  if (!text) return { kind: "none" };
  // The greeting must ADDRESS the owner by name in the opening clause — "hey scott", "hi scott,",
  // "scott this is mark", "good morning scott". A mere mention later in the message ("tell scott
  // thanks") does not fire (the agent can still answer those normally).
  const escaped = owner.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const greeting = new RegExp(
    `^(?:hey|hi|hello|good (?:morning|afternoon|evening)|yo|hiya)?[,!. ]*\\b${escaped}\\b(?:[,!. ]|$)`,
    "i"
  );
  const opensWithName = new RegExp(`^${escaped}\\b(?:[,!. -]|$)`, "i");
  if (greeting.test(text) || opensWithName.test(text)) return { kind: "owner_thread_step_back" };
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

// Decide-soon owner check-in (Joe ruling 2026-07-23, Dennis Daffron +16303628805): a hot
// out-of-state buyer said "Okay. Im waiting on two other dealers to get back to me. I should
// have a decision soon. Then ill leave a deposit and talk financing or cash price at that
// point." — a live, near-term buying decision that today produces NOTHING dated (the
// defer_with_window machinery only knows concrete windows like "next month", and "soon" is
// not concrete, so the turn falls through to the general draft path and the lead is carried
// only by the generic cadence). Joe ruled: a parser-detected "I'll decide soon/shortly" turn
// creates a DATED owner check-in task due in 2-3 days so a human circles back while the
// decision is live.
//
// Deterministic bucket: this is a SIDE-EFFECT decision off a TYPED PARSER signal. The
// customer's intent is read by parseCustomerDispositionWithLLM (defer_with_window + the
// structured timeframe_text slot); the vague-soon classification below reads that STRUCTURED
// slot — the parser's own extraction of the customer's timeframe phrase — never the raw
// customer text. Fail-direction: a false negative keeps today's behavior (no task; cadence
// still covers the lead — recoverable); a false positive costs one dated owner task (merged
// by addTodo's class-keyed dedup — bounded, staff-visible, no customer-facing send).
export type DecideSoonCheckInTurnKind = "owner_check_in_task" | "none";

export type DecideSoonCheckInTurnInput = {
  parserAccepted: boolean;
  disposition?: string | null;
  // The disposition parser's structured timeframe_text slot (the customer's own timeframe
  // phrase as extracted by the LLM), NOT raw message text.
  timeframeText?: string | null;
  conversationClosed?: boolean;
  saleRecorded?: boolean;
};

export type DecideSoonCheckInTurnDecision =
  | { kind: "owner_check_in_task"; dueInDays: number }
  | { kind: "none" };

// Joe ruled "2-3 day"; 3 keeps the check-in inside the window without crowding day-after texts.
export const DECIDE_SOON_CHECK_IN_DUE_DAYS = 3;

// Vague near-term window classifier over the parser's structured timeframe slot: "soon",
// "shortly", "very soon", "in a day or two", "a day or so". Concrete windows ("next month",
// "in 3 days", "after tax return") are NOT this class — they already drive the existing
// with-window deferral machinery (customer's own timeframe wins) and stay untouched.
export function isVagueSoonTimeframeText(raw: string | null | undefined): boolean {
  const t = String(raw ?? "")
    .toLowerCase()
    .replace(/[.!,]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!t) return false;
  if (/^(?:in\s+)?(?:very\s+|real\s+|really\s+|pretty\s+)?(?:soon|shortly)$/.test(t)) return true;
  if (/^(?:in\s+)?(?:the\s+next\s+)?(?:a\s+)?day\s+or\s+(?:two|so)$/.test(t)) return true;
  return false;
}

export function decideDecideSoonTurn(input: DecideSoonCheckInTurnInput): DecideSoonCheckInTurnDecision {
  if (!input.parserAccepted) return { kind: "none" };
  if (String(input.disposition ?? "") !== "defer_with_window") return { kind: "none" };
  if (input.conversationClosed || input.saleRecorded) return { kind: "none" };
  if (!isVagueSoonTimeframeText(input.timeframeText)) return { kind: "none" };
  return { kind: "owner_check_in_task", dueInDays: DECIDE_SOON_CHECK_IN_DUE_DAYS };
}

// Sell-to-dealer (outright cash sale) turn — the Josh Kiddy class (+17169831712, 2026-07-23).
// Staff asked "are you looking into trading the bike in or you want to sell outright?" and the
// customer answered "Sell it outright." In dealer parlance BOTH options are transactions with
// US (a trade applies the bike's value toward a purchase; an outright sale is us buying it for
// cash), but the disposition parser read it as sell_on_own @0.98 -> customer_sell_on_own ->
// conversation CLOSED, cadence paused_indefinite, inventory watches paused, and a farewell
// brush-off draft. A customer handing us used inventory was durably parked.
//
// Deterministic bucket: a SIDE-EFFECT decision off a TYPED PARSER slot. The customer's intent
// is read by parseCustomerDispositionWithLLM (the structured sell_to_dealer_interest slot);
// this reducer reads that STRUCTURED slot, never raw customer text.
//
// Fail-direction (AGENTS.md migrate-vs-keep): the behavior being corrected fails toward a
// wrong silent answer + a lead-suppressing side effect (fail-UNSAFE). A false negative here
// keeps today's post-fix behavior (the turn simply falls through to the normal draft pipeline
// — recoverable); a false positive costs one staff appraisal task plus a trade_cash dialog
// state (bounded, staff-visible, no customer-facing send). Deliberately NON-terminal: the turn
// must continue to normal routing/drafting so the existing appraisal copy owns the wording.
export type SellToDealerTurnKind = "sell_to_dealer_appraisal" | "none";

export type SellToDealerTurnInput = {
  // The disposition parser's structured sell_to_dealer_interest slot, NOT raw message text.
  sellToDealerInterest: boolean;
  // Conflict guard: sell_to_dealer_interest and sell_on_own are mutually exclusive.
  disposition?: string | null;
  confidence?: number | null;
  conversationClosed?: boolean;
  saleRecorded?: boolean;
};

export type SellToDealerTurnDecision = { kind: "sell_to_dealer_appraisal" } | { kind: "none" };

// Mirrors IN_PROCESS_DEAL_CONFIDENCE_FLOOR: a task-creating side effect wants a confident read.
export const SELL_TO_DEALER_CONFIDENCE_FLOOR = 0.8;

export function decideSellToDealerTurn(input: SellToDealerTurnInput): SellToDealerTurnDecision {
  if (!input.sellToDealerInterest) return { kind: "none" };
  // Never fire on a conflicting parse — sell_on_own is the opposite intent.
  if (String(input.disposition ?? "") === "sell_on_own") return { kind: "none" };
  if (input.conversationClosed || input.saleRecorded) return { kind: "none" };
  const confidence = typeof input.confidence === "number" ? input.confidence : 0;
  if (!(confidence >= SELL_TO_DEALER_CONFIDENCE_FLOOR)) return { kind: "none" };
  return { kind: "sell_to_dealer_appraisal" };
}

// Customer photo-share FRAME — whose bike is in this picture? (Tom +17164454081, 2026-07-30.)
//
// Tom is selling his motorcycle TO us. He sent five photo-only MMS turns; each drew
// "Let me match it against what we've got in stock and coming in" — the BUY-side inventory
// promise. The thread had said "seller" 3m39s before the first photo arrived
// (followUp.reason = followUpCadence.contextTag = "seller_photo_details_request"), and the photo
// router never looked.
//
// Root cause worth naming: there were THREE separate enumerations of "is this a seller thread" and
// the photo one was the incomplete one — `isSellLead` (index.ts) and `cadenceInventoryGuard` both
// already list `seller_photo_details_request` / `private_party_seller`; customerPhotoShare's
// `isTradePhotoShareConversation` listed only TRADE signals, so an outright seller fell through to
// the buy-side DEFAULT. That default is the defect: nothing ever asked whose bike it was.
//
// Deterministic bucket: reads ALREADY-classified structured state (bucket / CTA / handoff reason /
// cadence + manual context tag / dialog state / lead source / sellOption). The comprehension that
// set those ran earlier in the typed intent parsers — this is a route read, never a re-reading of
// customer text. AGENTS.md permits exactly this as deterministic routing.
//
// Fail-direction (AGENTS.md migrate-vs-keep): a MISS here fails toward a confident, wrong,
// customer-facing claim ("I'll match it against our stock" to a man selling us his bike), so the
// signal set is deliberately BROAD and the `trade` substring test below is KEPT, not tightened —
// removing that breadth would fail toward the very miss this referee exists to stop. A false
// positive costs the appraiser reply + an appraisal todo on a buyer thread: staff-visible,
// recoverable, no wrong promise. Broad is the safe direction here.
export type CustomerPhotoShareFrame = "owner_unit" | "buyer_match";
export type CustomerPhotoShareOwnerIntent = "trade_in" | "sell_to_dealer";

export type CustomerPhotoShareFrameInput = {
  classificationBucket?: string | null;
  classificationCta?: string | null;
  followUpReason?: string | null;
  cadenceContextTag?: string | null;
  manualContextTag?: string | null;
  dialogStateName?: string | null;
  leadSource?: string | null;
  // Set by the sell-to-dealer side effect (decideSellToDealerTurn -> lead.sellOption).
  leadSellOption?: string | null;
};

export type CustomerPhotoShareFrameDecision = {
  frame: CustomerPhotoShareFrame;
  ownerIntent: CustomerPhotoShareOwnerIntent | null;
};

// Mirrors the seller vocabulary already enumerated in cadenceInventoryGuard + isSellLead. Kept as
// exact tags (not a substring) because "sell_on_own" — a customer selling privately, NOT to us —
// must never read as "they are handing us their unit".
const SELL_TO_DEALER_CONTEXT_TAGS = new Set([
  "private_party_seller",
  "seller_photo_details_request",
  "seller_intake",
  "seller_vin_miles",
  "sell:pickup"
]);

const PHOTO_SHARE_TRADE_INTENT_CTAS = new Set([
  "value_my_trade",
  "sell_my_bike",
  "trade_in_value",
  "trade_in_sell"
]);

const PHOTO_SHARE_TRADE_DIALOG_STATES = new Set([
  "trade_init",
  "trade_cash",
  "trade_trade",
  "trade_either"
]);

const norm = (value: unknown): string => String(value ?? "").trim().toLowerCase();

export function decideCustomerPhotoShareFrame(
  input: CustomerPhotoShareFrameInput
): CustomerPhotoShareFrameDecision {
  const followUpReason = norm(input.followUpReason);
  const cadenceContextTag = norm(input.cadenceContextTag);
  const manualContextTag = norm(input.manualContextTag);

  // 1. SELL-TO-DEALER (they own it and want us to buy it outright). Checked first so the vision
  //    prompt gets the accurate frame; both arms return owner_unit, so precedence never changes
  //    WHICH reply class fires — only how the image is described to the parser.
  const sellOption = norm(input.leadSellOption);
  if (sellOption === "cash") return { frame: "owner_unit", ownerIntent: "sell_to_dealer" };
  for (const tag of [followUpReason, cadenceContextTag, manualContextTag]) {
    if (tag && SELL_TO_DEALER_CONTEXT_TAGS.has(tag)) {
      return { frame: "owner_unit", ownerIntent: "sell_to_dealer" };
    }
  }

  // 2. TRADE-IN (they own it and want its value applied to a purchase) — the pre-existing set,
  //    unchanged. `sellOption` trade/either lands here: still their unit, still the appraiser.
  if (sellOption === "trade" || sellOption === "either") {
    return { frame: "owner_unit", ownerIntent: "trade_in" };
  }
  if (norm(input.classificationBucket) === "trade_in_sell") {
    return { frame: "owner_unit", ownerIntent: "trade_in" };
  }
  if (PHOTO_SHARE_TRADE_INTENT_CTAS.has(norm(input.classificationCta))) {
    return { frame: "owner_unit", ownerIntent: "trade_in" };
  }
  // Breadth KEPT on purpose (see the fail-direction note above): any trade-flavoured handoff
  // reason means the customer owns the unit. Tightening this to an enum would fail unsafe.
  if (followUpReason === "non_motorcycle_trade" || followUpReason.includes("trade")) {
    return { frame: "owner_unit", ownerIntent: "trade_in" };
  }
  if (PHOTO_SHARE_TRADE_DIALOG_STATES.has(norm(input.dialogStateName))) {
    return { frame: "owner_unit", ownerIntent: "trade_in" };
  }
  // Trade-IN intent specifically — not a "Trade Show" booth lead. Jessica's source is
  // "Trade Accelerator - Trade In".
  if (/\btrade[\s-]?in\b|trade accelerator/.test(norm(input.leadSource))) {
    return { frame: "owner_unit", ownerIntent: "trade_in" };
  }

  return { frame: "buyer_match", ownerIntent: null };
}

// Dept-widget intake precedence (the Lynn Kraus class, +17164785613, corpus sweep 2026-07-28).
// The bike-vs-department clarify (Joe ruling 2026-07-26 #4) shipped as a TWO-state decision —
// clarify or plain dept ack — in a THREE-state world. Lynn came through the Motor Clothes widget
// with "Do you guys buy motorcycles? I have a '17 Road King Special with just under 11k miles I'm
// looking to sell." and got "are you looking for info on the '17 Road King itself, or Motor Clothes
// gear/support for it?" — a clarify for a question that was never ambiguous. Her ask was an
// ACQUISITION lead (she is selling TO us), already fully modeled by the disposition parser's
// sell_to_dealer_interest slot (the Josh Kiddy fix, 2026-07-23) — this path just never consulted it.
//
// So: clarify only when the customer's own words leave apparel-vs-bike genuinely open. A stated
// sell-to-dealer ask outranks the clarify, which outranks the plain dept ack. Structured slots only
// (no raw text) — comprehension stays upstream in the two typed parsers. The acquisition arm
// delegates to decideSellToDealerTurn so there is ONE definition of "is this an acquisition lead"
// (same 0.8 floor, same sell_on_own conflict guard) rather than a second drifting opinion.
//
// Containment property that makes this safe: the acquisition arm is a strict SUBSET of today's
// clarify cohort — it is reachable only when asksAboutMotorcycle is already true, which the parser's
// department carve-out already suppresses for gear/parts/service asks. A pure apparel ask can never
// reach it. Fail-direction: a missed/low-confidence acquisition read falls through to today's
// clarify (status quo, staff edits it), and a null parse falls through to the plain ack — nothing
// fails toward silence, a closeout, or a cadence pause.
export type DeptWidgetIntakeTurnKind = "sell_to_dealer_appraisal" | "bike_clarify" | "plain_dept_ack";

export type DeptWidgetIntakeTurnInput = {
  // classifyDeptWidgetBikeInterestWithLLM's structured verdict.
  asksAboutMotorcycle: boolean;
  bikeConfidence?: number | null;
  bikeConfidenceMin?: number;
  // parseCustomerDispositionWithLLM's structured slots (never raw text).
  sellToDealerInterest?: boolean;
  disposition?: string | null;
  dispositionConfidence?: number | null;
  conversationClosed?: boolean;
  saleRecorded?: boolean;
};

export type DeptWidgetIntakeTurnDecision = { kind: DeptWidgetIntakeTurnKind };

export const DEPT_WIDGET_BIKE_CLARIFY_CONFIDENCE_FLOOR = 0.6;

export function decideDeptWidgetIntakeTurn(input: DeptWidgetIntakeTurnInput): DeptWidgetIntakeTurnDecision {
  if (!input.asksAboutMotorcycle) return { kind: "plain_dept_ack" };
  const bikeMin =
    typeof input.bikeConfidenceMin === "number" ? input.bikeConfidenceMin : DEPT_WIDGET_BIKE_CLARIFY_CONFIDENCE_FLOOR;
  const bikeConfidence = typeof input.bikeConfidence === "number" ? input.bikeConfidence : 0;
  if (!(bikeConfidence >= bikeMin)) return { kind: "plain_dept_ack" };
  // Acquisition outranks the clarify — she told us what she wants; don't ask her again.
  const acquisition = decideSellToDealerTurn({
    sellToDealerInterest: !!input.sellToDealerInterest,
    disposition: input.disposition ?? null,
    confidence: input.dispositionConfidence ?? null,
    conversationClosed: input.conversationClosed,
    saleRecorded: input.saleRecorded
  });
  if (acquisition.kind === "sell_to_dealer_appraisal") return { kind: "sell_to_dealer_appraisal" };
  return { kind: "bike_clarify" };
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

// Riding Academy ENROLLMENT lead (Joe, 2026-08-05; Savannah Niver +13155211619 and Donald Rawson
// +17165344986, the first two on this source, both 2026-08-04). The rider-training school files an
// ADF when someone REGISTERS for a course: `Source: Riding Academy - Enrolled` plus a machine
// enrollment record ("Enrollment Status: Enrolled-Course: …-Class Start Date: …-Payment Status: …").
// It is not a sales inquiry and it is not prose — nobody typed it. The generic ADF path answered
// both with "Thanks for asking about our Riding Academy course. Course details and pricing are
// here: <link>" — quoting the price to two people who had already paid to sign up — and Donald,
// whose record says he expects to buy nothing, was queued for the standard day-1 sales ramp behind
// it.
//
// JOE'S RULING (2026-08-05, verbatim intent): on an enrollment the agent "sends an introduction,
// thanking the customer and letting them know the agent is there to assist with anything regarding
// the course." So: warm intro, no selling, and deliberately NO mention of Payment Status — whether
// an unpaid seat is ever raised over SMS is a money decision that stays with Joe.
//
// Like decideNonBuyerSurveyTurn and decideEventPromoTurn this keys ONLY on fixed ADF enum fields
// (the lead source + the enrollment record's status), so it is STRUCTURED ROUTING, not free-text
// comprehension — there is no customer prose on this lead to comprehend. Applied at the INITIAL ADF
// draft only (both paths); once the person actually texts back, normal routing answers them.
//
// THE STATUS VOCABULARY IS CLOSED, AND WE HAVE IT (Joe's Lead Source List 8.15, confirmed against
// services/api/data/lead_sources/hdmc.json — the same file dealer_onboard.sh copies to every new
// dealer). H-D files exactly three rider-training sources:
//   2843  RIDING ACADEMY - ENROLLED
//   2844  RIDING ACADEMY - COMPLETE
//   2978  Riding Academy - Wait List
// The older note here said completions "have their own copy still to be written ... none has ever
// arrived", and routed them to `none`. That was true when written and is not any more: Joe chose the
// copy on 2026-08-07 (congratulate, and stop — no pitch, no price, no model ask).
//
// FALLING THROUGH TO `none` IS NOT NEUTRAL, which is the correction this revision makes. `none` hands
// the turn to generic SALES routing. Maya Iversen (+15854782032) moved wait list -> Enrolled on
// 2026-08-07 and the second record, never reaching this lane at all, was answered with "I can ballpark
// payments once I confirm the exact price. If you'd like to stop in, what day and time works best?" —
// to someone whose own form says she has never been on a motorcycle, even as a passenger. So an
// unrecognised status now returns `riding_academy_unknown_status`: stay quiet and raise a task, never
// guess and never sell. FAIL DIRECTION: silence + a human, which is recoverable; a sales pitch to
// someone who just cancelled a course is not.
export type RidingAcademyTurnKind =
  | "riding_academy_enrollment_ack"
  | "riding_academy_waitlist_ack"
  /** Wait list -> a seat. The school files a SECOND record; this is the "you're in" turn. */
  | "riding_academy_waitlist_to_enrolled_ack"
  /** They finished the course (source 2844). Joe 2026-08-07: congratulate, and stop. */
  | "riding_academy_completion_ack"
  /** On this lane, status word unknown. Silence + a staff task — never generic sales routing. */
  | "riding_academy_unknown_status"
  | "none";

export type RidingAcademyTurnInput = {
  leadSource?: string | null;
  inquiry?: string | null;
  /**
   * The status this thread was ALREADY in, from the school's previous record — not from anything the
   * customer said. Supplied by the caller so this stays pure. Absent = no prior record = first touch.
   */
  priorStatus?: string | null;
};

export type RidingAcademyTurnDecision = { kind: RidingAcademyTurnKind };

/** The enrollment record's own status field — a machine enum, never customer prose. */
function readRidingAcademyStatus(input: RidingAcademyTurnInput): string {
  const inquiry = String(input.inquiry ?? "");
  const recorded = inquiry.match(/\benrollment status:\s*([^-\n]+)/i);
  if (recorded?.[1]) return recorded[1].trim().toLowerCase();
  // Fall back to the source suffix ("Riding Academy - Enrolled") when the body carries no record.
  const suffix = String(input.leadSource ?? "").match(/\briding academy\s*[-–]\s*(.+)$/i);
  return suffix?.[1] ? suffix[1].trim().toLowerCase() : "";
}

/** Is this status word the wait list? Shared so the current and prior reads cannot drift. */
function isWaitListStatus(status: string): boolean {
  return /^(wait|waitlist)/.test(String(status ?? "").replace(/[\s_-]+/g, ""));
}

export function decideRidingAcademyTurn(input: RidingAcademyTurnInput): RidingAcademyTurnDecision {
  const source = String(input.leadSource ?? "").toLowerCase();
  const hasEnrollmentRecord = /\benrollment status:\s*/i.test(String(input.inquiry ?? ""));
  // Must be THIS lane: the rider-training source, or the school's enrollment record in the body.
  if (!source.includes("riding academy") && !hasEnrollmentRecord) return { kind: "none" };
  const status = readRidingAcademyStatus(input);

  if (status.startsWith("enrolled")) {
    // A seat, after being wait-listed, is its own moment — the news IS that the wait ended. Keyed off
    // the school's PREVIOUS record, never off anything the customer wrote.
    return isWaitListStatus(String(input.priorStatus ?? ""))
      ? { kind: "riding_academy_waitlist_to_enrolled_ack" }
      : { kind: "riding_academy_enrollment_ack" };
  }
  // WAIT LIST is its own state, not a near-enrollment (igor yuzbashev, 2026-08-06). Falling through
  // to `none` handed the turn to the generic ADF path, which read the form's FIELD LABELS
  // ("Motivation: Learn to ride", "Training Experience: No") as a Jumpstart request and told him
  // "I saw you want to do the Jumpstart experience before the course" — a claim he never made — while
  // never mentioning that he has no seat yet. He is owed the truth about his status; the Jumpstart
  // stays available as an OFFER on the reply side.
  if (isWaitListStatus(status)) return { kind: "riding_academy_waitlist_ack" };
  // Source 2844. Joe, 2026-08-07, choosing between three drafted options: congratulate and STOP.
  // No pitch, no price, no "which model" — they just spent five days with the instructors and the
  // dealership's first word to them should not be a sale.
  if (status.startsWith("complete")) return { kind: "riding_academy_completion_ack" };
  // On the lane, unknown word (a cancellation, a transfer, a status H-D adds later) — or no status at
  // all. Never generic sales routing; see the header.
  return { kind: "riding_academy_unknown_status" };
}

// JUMPSTART 1-on-1 invite (Joe, 2026-08-05). The H-D Jumpstart is a real bike locked onto a
// stationary rig — you work the clutch, throttle and gears and feel the bike running without ever
// leaving the showroom or needing an endorsement. Joe's rule: *if the dealer HAS one (noted in the
// profile) and the customer has no-to-little riding experience, invite them in for a 1-on-1 ride on
// it.* Until now the agent only ever mentioned the Jumpstart when the CUSTOMER raised it first, and
// it never checked whether the store owned one at all.
//
// This is the reply-side rule for an EXISTING parser lane: the experience read comes from the typed
// `first_time_rider_guidance` parser (`parseFirstTimeRiderGuidanceWithLLM`) — comprehension stays in
// the parser, this decision is pure — with one extra STRUCTURED source, the rider-training school's
// enrollment record (`Motorcycle Riding History: …`), which is a machine enum, not prose.
//
// TWO FAIL DIRECTIONS, both deliberate:
//  1. NEVER offer equipment the store does not have. `dealerHasJumpstart` must be an explicit true;
//     absent/unknown profile ⇒ no invite. This is the one that would embarrass a new dealer.
//  2. NEVER call an experienced rider a beginner. Only an EXPLICIT inexperience signal invites —
//     the parser saying first-time/no-endorsement, or a riding-history field that says in so many
//     words that they have not ridden. "unknown" is not "beginner": a missed invite costs an
//     opportunity, a wrong one insults a customer who has ridden for thirty years.
// Also one-shot: `alreadyOffered` suppresses a repeat, so the invite never turns into nagging.
export type JumpstartInviteTurnKind = "jumpstart_one_on_one_invite" | "none";

export type RiderExperienceLevel = "none_or_little" | "experienced" | "unknown";

export type JumpstartInviteTurnInput = {
  dealerHasJumpstart?: boolean | null;
  /** From the typed first_time_rider_guidance parse. */
  riderIntent?: string | null;
  hasEndorsement?: boolean | null;
  /** The rider-training enrollment record's machine fields, when this lead carries one. */
  ridingHistory?: string | null;
  enrolledCourse?: string | null;
  alreadyOffered?: boolean | null;
};

export type JumpstartInviteTurnDecision = { kind: JumpstartInviteTurnKind };

/**
 * How much riding has this customer actually done? Reads the typed parse first, then the enrollment
 * record's structured history field. Anything we cannot read plainly stays `unknown`.
 */
export function resolveRiderExperienceLevel(input: {
  riderIntent?: string | null;
  hasEndorsement?: boolean | null;
  ridingHistory?: string | null;
  enrolledCourse?: string | null;
}): RiderExperienceLevel {
  // An endorsement in hand is the strongest "not a beginner" signal we get, and it outranks the
  // intent label: someone endorsed asking a beginner-bike question is a rider, not a novice.
  if (input.hasEndorsement === true) return "experienced";
  // Signing up for a LEARN-TO-RIDE course is a plain statement of little experience, and it
  // outranks the riding-history field below (Joe, 2026-08-05, asking for the offer in the
  // registration reply). Both real enrollees say they have "operated an on-road motorcycle within
  // the last 12 months" — which could be a parking lot on a friend's bike — while paying to be
  // taught the basics. The course they CHOSE is the better evidence of the two. An advanced or
  // returning-rider course does not match, so those students are not handed a beginner rig.
  const course = String(input.enrolledCourse ?? "").toLowerCase();
  if (course && /\b(new rider|basic rider|beginner|learn(ing)? to ride)\b/.test(course)) {
    return "none_or_little";
  }
  const intent = String(input.riderIntent ?? "").toLowerCase();
  if (intent === "first_time_rider" || intent === "no_motorcycle_endorsement") return "none_or_little";
  if (input.hasEndorsement === false) return "none_or_little";
  // The enrollment record's own enum. Only the plainly-negative wordings count; the value we have
  // seen in live data ("I have operated an on-road motorcycle within the last 12 months") is a
  // rider, and every unrecognised wording stays unknown rather than being guessed at.
  const history = String(input.ridingHistory ?? "").toLowerCase();
  if (history) {
    // The negative wordings the school form actually emits. It required the word "operated", but
    // the live records say "I have NEVER BEEN ON a motorcycle (even as a passenger)" — 2 of the 4
    // enrollment records in the store on 2026-08-07 — which read `unknown` and kept the two most
    // plainly inexperienced people we have off the beginner list. Still only explicit negatives:
    // never/not paired with operating, being on, or riding a motorcycle.
    if (/\b(never|not)\b[^.]*\b(operated|been on|ridden|rode)\b/.test(history) || /\bno riding experience\b/.test(history)) {
      return "none_or_little";
    }
    // "I have ridden ONLY AS A PASSENGER" — one of the school form's fixed options, and one of the
    // four live enrollment records on 2026-08-07. It read `unknown`, which kept a genuine beginner
    // off the beginner list. A passenger has not operated a motorcycle; that is a plainly-negative
    // wording, not a guess, so it belongs with the other two above. Checked BEFORE the `operated`
    // test below, which would otherwise never see it anyway — order kept explicit on purpose.
    if (/\bonly as a passenger\b/.test(history)) return "none_or_little";
    if (/\boperated\b/.test(history)) return "experienced";
  }
  return "unknown";
}

/** What we durably know about a lead's riding experience. Only ever an EXPLICIT read. */
export type RiderExperienceRecord = {
  level: "none_or_little" | "experienced";
  /** "parser" = the typed first_time_rider_guidance read; "enrollment" = the school's machine record. */
  source: "parser" | "enrollment";
  at: string;
};

export type RiderExperiencePersistDecision =
  | { write: false; reason: string }
  | { write: true; next: RiderExperienceRecord; reason: string };

/**
 * THE REFEREE for `conv.riderExperience` — the only thing allowed to decide whether we write it.
 *
 * WHY THIS EXISTS (Joe, 2026-08-07, asking for a list of customers who are not licensed yet).
 * `resolveRiderExperienceLevel` already works this out on every relevant turn and then throws it
 * away — nothing persists it, so the audience cannot be queried. Measured on the live store: across
 * 822 conversations we raised an endorsement in 19 outbound messages, a customer answered in 4, and
 * 4 leads carry the riding school's structured record. Storing the reads we already make is what
 * turns that into a list that grows.
 *
 * MONOTONIC, and the direction is the whole point. `none_or_little` -> `experienced` is allowed:
 * people get licensed, and a stale beginner label would put a newly-endorsed rider on a
 * learn-to-ride list. `experienced` -> `none_or_little` is REFUSED: the failure the surrounding code
 * has always guarded against is calling a thirty-year rider a beginner, and a marketing list makes
 * that failure durable and public instead of one awkward sentence. A missed invite costs an
 * opportunity; a wrong one insults a customer.
 *
 * `unknown` NEVER writes — absence of evidence is not evidence, and a stored "unknown" would be
 * indistinguishable from a real read.
 */
export function decideRiderExperiencePersist(input: {
  current?: { level?: string | null } | null;
  observed: RiderExperienceLevel;
  source: "parser" | "enrollment";
  nowIso: string;
}): RiderExperiencePersistDecision {
  if (input.observed !== "none_or_little" && input.observed !== "experienced") {
    return { write: false, reason: "observed_unknown" };
  }
  const next: RiderExperienceRecord = { level: input.observed, source: input.source, at: input.nowIso };
  const current = String(input.current?.level ?? "").trim();
  if (!current) return { write: true, next, reason: "first_observation" };
  if (current === input.observed) return { write: false, reason: "unchanged" };
  if (current === "experienced" && input.observed === "none_or_little") {
    return { write: false, reason: "never_demote_experienced" };
  }
  return { write: true, next, reason: "upgrade_to_experienced" };
}

export function decideJumpstartInviteTurn(
  input: JumpstartInviteTurnInput
): JumpstartInviteTurnDecision {
  if (input.dealerHasJumpstart !== true) return { kind: "none" };
  if (input.alreadyOffered === true) return { kind: "none" };
  const level = resolveRiderExperienceLevel({
    riderIntent: input.riderIntent,
    hasEndorsement: input.hasEndorsement,
    ridingHistory: input.ridingHistory,
    enrolledCourse: input.enrolledCourse
  });
  if (level !== "none_or_little") return { kind: "none" };
  return { kind: "jumpstart_one_on_one_invite" };
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
// FAIL DIRECTION: fail toward DISCLOSING. A hold/sale with no/unknown owner conversation still
// discloses (the unit isn't freely available either way); only THIS customer's own record
// suppresses it. Compliance/system replies (STOP acks, opt-out
// confirmations) and empty replies never carry it — a disclosure there would be nonsense and
// tampering with compliance text is the one direction we never fail toward. Disclose ONCE per
// unit-hold (alreadyDisclosedForThisUnit dedups; re-arms if the hold key changes).
//
// OWN-RECORD SUPPRESSION covers BOTH kinds (Charles Desalvo +17168614216, 2026-08-06). The sold
// branch used to hardcode "not mine", so two days after he took delivery of stock U902-24 the
// reply path told the BUYER "the 2024 Street Glide is no longer available. I can line up similar
// in-stock options if you want" — lost inventory narrated to the person holding the keys. The
// solds store already stamps the buying conversation (67 of 68 live records carry convId/leadKey);
// nothing read it. Measured blast radius on the live store: 8 conversations are the buyer of their
// own lead unit (all closed sold/sold_walkin_note), 22 are watching a unit that sold to SOMEONE
// ELSE and keep disclosing exactly as before.
export type LeadUnitAvailabilityDisclosureKind = "disclose_hold" | "disclose_sold" | "none";

export type LeadUnitAvailabilityDisclosureInput = {
  unavailableKind: "hold" | "sold" | null;
  // True when the hold/sold record's convId/leadKey matches THIS conversation — the customer's own
  // hold, or the unit THIS customer bought. Ownerless records read false (fail toward disclosing).
  unitOwnedByThisConv: boolean;
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
  // Their own hold is good news, not a warning; their own PURCHASE is not lost inventory.
  if (input.unitOwnedByThisConv) return { kind: "none" };
  return { kind: input.unavailableKind === "hold" ? "disclose_hold" : "disclose_sold" };
}

// Reservation handoff second-look (2026-07-13, Kody +17163975098). The reservation handoff is an
// EXPENSIVE side effect (committal "how to get one reserved" draft + high-priority owner call
// task), and the primary inbound_reply_action parser occasionally over-reads a deferred "I'll buy
// later and circle back" as a reservation. Before firing, a narrow second-look verifier
// (parseReservationConfirmWithLLM) re-asks the one question that matters. This reducer owns the
// precedence — applied identically in BOTH /webhooks/twilio and /conversations/:id/regenerate.
//
// FAIL DIRECTION: the verifier can only VETO, never enable. A null verdict (parser disabled /
// LLM error) falls through to the primary parser's decision — today's behavior — so an LLM outage
// cannot kill genuine reservation handling. The deterministic regex fallback path (explicit
// "reserve/pre-order/deposit" tokens, only consulted when the primary parser is unavailable) is
// NOT vetoed: with the LLM down there is no verifier to ask, and those tokens are explicit.
export type ReservationHandoffTurnInput = {
  // Primary inbound_reply_action parser accepted customer_reservation_request (confidence-gated).
  parserReservationAccepted: boolean;
  // Deterministic detectReservationRequestText fired AND the fallback lane is allowed.
  fallbackDetected: boolean;
  // Second-look verifier verdict; null = verifier unavailable (disabled/error).
  confirmVerdict: "reserve_now" | "not_reserve_now" | null;
};

export type ReservationHandoffTurnDecision = {
  fire: boolean;
  reason:
    | "parser_confirmed" // primary parser + verifier agree: reserve now
    | "parser_unverified" // primary parser accepted; verifier unavailable — proceed (today's behavior)
    | "second_look_veto" // primary parser accepted; verifier says NOT a reserve-now → suppress
    | "fallback_detector" // explicit reserve-token regex lane (primary parser unavailable)
    | "no_signal";
};

export function decideReservationHandoffTurn(
  input: ReservationHandoffTurnInput
): ReservationHandoffTurnDecision {
  if (input.parserReservationAccepted) {
    if (input.confirmVerdict === "not_reserve_now") return { fire: false, reason: "second_look_veto" };
    if (input.confirmVerdict === "reserve_now") return { fire: true, reason: "parser_confirmed" };
    return { fire: true, reason: "parser_unverified" };
  }
  if (input.fallbackDetected) return { fire: true, reason: "fallback_detector" };
  return { fire: false, reason: "no_signal" };
}

// --- Day-only visit-commitment: propose real slots vs ask "what time?" (Joe-approved 2026-07-14) ---
// When a customer commits to a DAY with no time ("can I look at it Saturday?"), the agent used to
// ask "what time works?" ONLY offering real open slots when the customer explicitly asked us to
// suggest a time. Joe's north star is answer→book, so a named-day commitment should proactively
// OFFER that day's real open slots (via findScheduleSlotsForRequestedDay + buildRequestedDaySlotReply,
// never fabricated). This pure predicate decides whether to ATTEMPT the day-slot proposal; the
// caller still falls back to the "what time?" ask when the lookup returns no slots (fail-safe:
// no scheduler config / no open slots that day → current behavior). Applied identically in the
// live (/webhooks/twilio) and regenerate paths so the two never drift.
export type DaySlotProposalInput = {
  hasNamedDay: boolean; // the turn carries a resolved day-of-week commitment
  customerAskedToSuggest: boolean; // customer explicitly asked the dealer to pick a time
  proposalEnabled: boolean; // kill switch (SCHEDULING_DAY_SLOT_PROPOSAL_ENABLED !== "0")
};

export function shouldProposeDaySlotsForNamedDay(input: DaySlotProposalInput): boolean {
  if (!input.hasNamedDay) return false; // no day => nothing to propose slots for
  // Flag on: any named-day commitment gets a proactive slot offer. Flag off: legacy behavior
  // (only when the customer asked us to suggest). Either way the caller's null-slot fallback
  // preserves the "what time?" ask when there is nothing real to offer.
  return input.proposalEnabled || input.customerAskedToSuggest;
}

// --- Committed-buyer availability re-pitch suppression (Joe, 2026-07-16) ---
// When a customer has ALREADY committed to a specific unit and is arranging paperwork/pickup/
// delivery — the conversation is in an active purchase_delivery (or sold/post-sale) state — a
// bare pickup/timing/logistics turn ("And to hopefully pick it up tomorrow as well") must NOT be
// routed into the availability re-pitch arm ("Yes — we have one in stock right now … Want to come
// check it out? Here is photo."). Re-selling a bike the customer already chose (and came in to see)
// is the tone-deaf failure this guards against: it ignores the ask, restarts the funnel, and reads
// like the agent forgot the customer is buying.
//
// Carve-out: an EXPLICIT availability question this turn ("is the red one still there?") is a
// legitimate ask even mid-deal, so it is NOT suppressed — the customer gets a real answer.
//
// Fail-direction: removing this guard makes us re-pitch to a committed buyer (a wrong, tone-deaf
// answer) => this is a KEEP-class deterministic precedence gate. It composes existing structured
// signals (dialog/followUp state + the availability router's own eligibility + the direct-question
// parser); it introduces NO new keyword/regex read of customer text. Applied identically in the
// live (/webhooks/twilio) and regenerate paths so the two never drift; pinned by
// committed_buyer_availability_suppression:eval.
export type CommittedBuyerAvailabilitySuppressionInput = {
  activePurchaseDeliveryState: boolean; // dialogState/followUp === purchase_delivery, or sold/post-sale
  availabilityArmWouldFire: boolean; // the availability re-pitch arm is otherwise eligible this turn
  directAvailabilityQuestionThisTurn: boolean; // an explicit "is it still available?" ask (carve-out)
};

export function shouldSuppressCommittedBuyerAvailabilityRepitch(
  input: CommittedBuyerAvailabilitySuppressionInput
): boolean {
  if (!input.activePurchaseDeliveryState) return false; // not a committed-buyer deal => normal availability answering
  if (!input.availabilityArmWouldFire) return false; // nothing to suppress
  if (input.directAvailabilityQuestionThisTurn) return false; // explicit availability ask is legit mid-deal
  return true;
}

// --- Stock-number interest turn (centralized 2026-08-01) ---
// A customer naming a dealer stock number ("still have T10-26?") routes into the inventory
// availability arm. The eligibility expression lived inline in THREE places (live webhook, regen,
// orchestrator) and so could drift; it is centralized here unchanged.
//
// Two inputs feed it and they are NOT interchangeable: `parserStockId` comes from the typed
// inventory-entity parser (comprehension — the parser owns "did the customer mean a stock
// number?"), while `deterministicStockId` is the structured-extraction fallback over the raw text.
//
// Fail-direction: if this decision goes FALSE on a real stock-number ask, the turn falls through to
// the general composer, which still answers the customer conversationally — a soft miss. If it goes
// TRUE on a non-stock-number, the deterministic availability arm hijacks the turn and answers a
// question nobody asked ("I'm not seeing 2026 Other in stock right now") while ignoring what the
// customer actually said. The over-fire is the worse direction, which is why the interest signal is
// a KEEP-class gate (removing it would make any stock-shaped token fire the arm) and why the
// extractor is letter-led. Applied identically in the live (/webhooks/twilio) and regenerate paths;
// pinned by stock_number_interest_routing:eval.
export type StockNumberInterestTurnInput = {
  parserStockId: string | null; // typed inventory-entity parser's stock id for this turn
  deterministicStockId: string | null; // extractInventoryStockIdMention over the raw body
  interestSignal: boolean; // isStockNumberInventoryInterestText — KEEP-class over-fire gate
};

export type StockNumberInterestTurnDecision = {
  routeToStockInventory: boolean;
  stockId: string | null;
};

export function decideStockNumberInterestTurn(
  input: StockNumberInterestTurnInput
): StockNumberInterestTurnDecision {
  const stockId = input.parserStockId || input.deterministicStockId || null;
  return {
    routeToStockInventory: !!stockId && input.interestSignal,
    stockId,
  };
}

// --- International (out-of-country) inbound lead: log + close (Joe ruling 2026-07-22) ---
// Joe, on +6282245353758 (Indonesia): "leave it but make sure the crm is updated with
// international lead and close it." So the SILENCE stays — we do not sell or ship overseas and
// have never replied to these — but the lead stops sitting open with nobody on it: the CRM gets
// an "international lead" note and the conversation is CLOSED.
//
// BUCKET: deterministic structured extraction (the E.164 country code is carrier metadata, never
// customer prose) feeding a SIDE-EFFECT gate (close + CRM write). No comprehension is involved,
// so no parser is required — per AGENTS.md this is exactly the deterministic-allowed class.
//
// FAIL DIRECTION: DOMESTIC. Only a clean E.164 number whose country code is outside the +1 North
// American Numbering Plan flags. Anything we cannot read as E.164 — a short code, an alphanumeric
// sender ID, a bare 10-digit string, empty input — is treated as domestic and handled normally,
// because a false positive would silence AND close a real local customer.
// Applied identically in /webhooks/twilio and /conversations/:id/regenerate.

// E.164 country codes that are exactly two digits. Everything else outside +1 / +7 is a
// three-digit code. Used only to LABEL the CRM note — the domestic/international verdict itself
// depends solely on the leading digits, so an imperfect label can never mis-route a lead.
const TWO_DIGIT_DIAL_CODES = new Set([
  "20", "27", "30", "31", "32", "33", "34", "36", "39", "40", "41", "43", "44", "45", "46", "47",
  "48", "49", "51", "52", "53", "54", "55", "56", "57", "58", "60", "61", "62", "63", "64", "65",
  "66", "81", "82", "84", "86", "90", "91", "92", "93", "94", "95", "98"
]);

/** The non-NANP country dial code on an E.164 number, or null when the number is domestic/unreadable. */
export function internationalDialCode(rawPhone: string | null | undefined): string | null {
  const raw = String(rawPhone ?? "").trim();
  if (!raw.startsWith("+")) return null; // not E.164 — never guess
  const digits = raw.slice(1).replace(/\D/g, "");
  if (!digits) return null;
  if (digits.startsWith("1")) return null; // +1 = US / Canada / NANP Caribbean → domestic
  if (digits.length < 8) return null; // too short to be a real international subscriber number
  if (digits.startsWith("7")) return "7"; // Russia / Kazakhstan — the other single-digit code
  const two = digits.slice(0, 2);
  if (TWO_DIGIT_DIAL_CODES.has(two)) return two;
  return digits.slice(0, 3);
}

export function isInternationalLeadPhone(rawPhone: string | null | undefined): boolean {
  return internationalDialCode(rawPhone) !== null;
}

export type InternationalLeadTurnInput = {
  provider: string;
  channel: "sms" | "email";
  fromPhone: string | null | undefined;
  /** The CRM note already landed on an earlier turn — write it once, not once per text. */
  alreadyLogged: boolean;
};

export type InternationalLeadTurnDecision = {
  kind: "international_lead_log_close";
  routeOutcome: "international_lead_log_close";
  shouldStop: true;
  shouldReply: false;
  dialCode: string;
  closeReason: "international_lead";
  /** First detection only. Repeat texts still stop + re-close (appendInbound reopens a closed
   *  thread on any real inbound, so re-closing is what keeps it out of the inbox) — they just
   *  don't re-write the CRM note. */
  logCrmNote: boolean;
  crmNote: string;
};

export function decideInternationalLeadTurn(
  input: InternationalLeadTurnInput
): InternationalLeadTurnDecision | null {
  if (input.provider !== "twilio" || input.channel !== "sms") return null;
  const dialCode = internationalDialCode(input.fromPhone);
  if (!dialCode) return null;
  return {
    kind: "international_lead_log_close",
    routeOutcome: "international_lead_log_close",
    shouldStop: true,
    shouldReply: false,
    dialCode,
    closeReason: "international_lead",
    logCrmNote: !input.alreadyLogged,
    crmNote: `International lead (country code +${dialCode}) — out-of-country number. No reply sent; lead closed.`
  };
}

// --- Reply-anchor: which bike does a pricing/MSRP answer talk about? (Joe ruling 2026-07-23) ---
// Production evidence (+17166021492, Brian Serena): Brian objected to a used 2019 Tri Glide
// Ultra's $29,995 quote and the pricing arm answered with the 2026 Street Glide Trike MSRP
// range lifted from his June ADF lead record — a bike nobody was talking about. Joe ruled:
// MSRP/price answers anchor to the bike under discussion THIS TURN — never the stale ADF
// lead-record vehicle — falling back to ASKING which bike when nothing resolves.
//
// Pure precedence (no text reading here — the caller supplies already-extracted models):
//   - When the thread's most recently DISCUSSED model contradicts the lead record, the lead
//     record is stale for pricing: this turn's named model wins, else the thread model.
//   - When there is no contradiction, the lead record keeps its existing precedence (a
//     first-touch ADF pricing ask IS about the lead vehicle — that behavior is unchanged).
//   - With no lead record at all: turn model, else thread model, else ask.
//
// FAIL DIRECTION: every input defaults to null and the terminal fallback is "ask" — a missed
// extraction degrades to asking the customer which bike (a correct, honest reply), never to
// quoting the wrong unit. This is a pure precedence decision over structured model slots, not
// customer-text comprehension. Applied inside orchestrateInbound's pricing block, which BOTH
// /webhooks/twilio and /conversations/:id/regenerate funnel through (two-path parity for free).
// Pinned by reply_anchor_live_conversation:eval.
export type PriceAnswerAnchorInput = {
  turnModel: string | null; // model named in THIS inbound turn (caller nulls it on trade-framed turns)
  threadModel: string | null; // most recent model discussed in the thread (either direction, pre-turn)
  leadModel: string | null; // ADF lead-record vehicle model (caller nulls unknown placeholders)
  threadMatchesLead: boolean; // normalized equality when both are present
};

export type PriceAnswerAnchorDecision = {
  source: "turn" | "thread" | "lead_record" | "ask";
};

export function decidePriceAnswerAnchor(
  input: PriceAnswerAnchorInput
): PriceAnswerAnchorDecision {
  const threadContradictsLead =
    !!input.threadModel && !!input.leadModel && !input.threadMatchesLead;
  if (threadContradictsLead) {
    // The conversation moved on from the lead record — the live discussion owns the answer.
    if (input.turnModel) return { source: "turn" };
    return { source: "thread" };
  }
  if (input.leadModel) return { source: "lead_record" }; // existing precedence, unchanged
  if (input.turnModel) return { source: "turn" };
  if (input.threadModel) return { source: "thread" };
  return { source: "ask" };
}

// --- Price-objection turn: ack + cheaper-unit watch offer, never a sticker re-quote ---
// (Joe ruling 2026-07-23, same +17166021492 evidence: "no buddy that's too much money. That's
// way too much money for a 2019." was answered with an MSRP range re-quote.) Joe ruled: a price
// objection gets acknowledged and offered a cheaper-unit watch — never a sticker re-quote.
//
// The customer-intent reading is PARSER-FIRST: parsePriceQuoteObjectionWithLLM (llmDraft.ts)
// classifies the turn; this pure function only decides the arm. The recent-outbound-quote gate
// is a deterministic scan of OUR OWN sent copy (side-effect eligibility, not comprehension) so
// the parser is consulted only where a quote exists to object to.
//
// FAIL DIRECTION: parser unavailable / low confidence / explicit question => "none" — the turn
// falls through to the existing pricing path (today's behavior). Removal fails toward answering
// with numbers, never toward silence or a wrong side effect. Pinned by
// reply_anchor_live_conversation:eval.
export type PriceObjectionTurnInput = {
  pricingRoute: boolean; // the turn routed to the pricing cluster
  recentOutboundQuotedPrice: boolean; // one of OUR recent sends carried a concrete $ quote
  parserPriceObjection: boolean; // parser: the turn objects to a quoted price
  parserExplicitQuestion: boolean; // parser: the turn ALSO asks a concrete question (answer it instead)
  parserConfidence: number;
  confidenceMin: number;
};

export type PriceObjectionTurnDecision = {
  kind: "cheaper_watch_offer" | "none";
};

export function decidePriceObjectionTurn(
  input: PriceObjectionTurnInput
): PriceObjectionTurnDecision {
  if (!input.pricingRoute) return { kind: "none" };
  if (!input.recentOutboundQuotedPrice) return { kind: "none" };
  if (!input.parserPriceObjection) return { kind: "none" };
  if (input.parserExplicitQuestion) return { kind: "none" }; // a concrete ask outranks the objection framing
  if (!(input.parserConfidence >= input.confidenceMin)) return { kind: "none" };
  return { kind: "cheaper_watch_offer" };
}

// --- Sold-news staleness cap: no months-old "just sold" announcements (Joe ruling 2026-07-23) ---
// The proactive cadence overrides frame a sold lead unit as NEWS ("quick update — the {unit} is
// no longer available" / "…but that bike has sold"). Joe ruled that months-old sale news must not
// be announced as an update — the customer either already knows or the thread has moved on. This
// caps only the PROACTIVE announcement framing; the responsive reply-side disclosure (appended
// when the customer is actively engaging about the unit) is a sell-a-gone-bike safety guard and
// is deliberately NOT capped.
//
// FAIL DIRECTION: an absent/unparseable soldAt returns false — keep announcing (fail toward
// disclosure, never toward silently selling a gone unit). Reads ONLY structured store state
// (soldAt), never customer text => deterministic invariant guard per AGENTS.md rule 2. Pinned by
// reply_anchor_live_conversation:eval.
export function isStaleSoldAnnouncement(input: {
  soldAtIso: string | null | undefined;
  nowMs: number;
  maxAgeDays?: number | null;
}): boolean {
  const iso = String(input.soldAtIso ?? "").trim();
  if (!iso) return false;
  const soldMs = new Date(iso).getTime();
  if (!Number.isFinite(soldMs) || Number.isNaN(soldMs)) return false;
  const maxDaysRaw = Number(input.maxAgeDays ?? NaN);
  const maxDays = Number.isFinite(maxDaysRaw) && maxDaysRaw > 0 ? maxDaysRaw : 30;
  return input.nowMs - soldMs > maxDays * 24 * 60 * 60 * 1000;
}

// A lead whose FINANCING WAS DECLINED belongs on the long-term cadence, not the standard chase.
//
// Joe's ruling, 2026-08-01 ("5 yes long term"): "someone who just got declined is not a this-week
// buyer." `applyFinanceOutcomeStatusFromSignal` already opens the right cadence
// (kind `long_term`, FINANCE_DECLINED_DAY_OFFSETS = 30/60/120 days) the moment the decline is
// recorded — but nothing DEFENDED it afterwards, so a later cadence write silently downgraded it.
//
// Production fixture — Tyler Boudreau `+17169905800`:
//   19:43:45.442Z  staff record the To-Do outcome "not approved (needs a cosigner)"
//                  -> followUp.reason = financing_declined, followUpCadence.kind = long_term
//   19:44:22.868Z  (37 SECONDS later) staff manually text him about the co-signer. That text hits
//                  `isManualOutboundCreditAppNeedsMoreInfoText` ("co-signer" is in its term list),
//                  and `applyManualOutboundCreditAppNeedsMoreInfo` REPLACED the whole cadence with
//                  kind `engaged` on FOLLOW_UP_DAY_OFFSETS.
// He has been on the fast chase ever since — the operator report reads "this has a not approved
// outcome. why did it go into a short term cadence follow up". `+17166060001` is the same class
// ("finance application was not approved. shouldn't this go into a long term cadence?", 15d old).
//
// DETERMINISTIC BY DESIGN, and legal under AGENTS.md rule 2: this reads only RECORDED STATE
// (`followUp.reason`, `financeOutcome.status`, the appointment outcome) — never customer text —
// and it gates a SIDE EFFECT (which cadence schedule runs). No comprehension is involved.
//
// FAIL DIRECTION: a false positive slows an already-declined lead to 30/60/120-day touches; a
// false negative is today's bug, chasing a just-declined customer every few days. Joe ruled the
// slow direction, so unknown/blank => NOT declined (fail toward today's behavior) and any
// POSITIVE decline signal wins.
//
// `needs_more_info` is deliberately NOT a decline — that lead is being actively worked and keeps
// its engaged docs cadence. Only an outright decline drops to long-term.
export type FinanceDeclinedCadenceInput = {
  followUpReason?: string | null;
  financeOutcomeStatus?: string | null;
  appointmentOutcomeStatus?: string | null;
  appointmentOutcomeSecondaryStatus?: string | null;
  cadenceKind?: string | null;
  cadenceStatus?: string | null;
};

export type FinanceDeclinedCadenceDecision = {
  /** Does the recorded state say this lead's financing was declined? */
  isFinanceDeclined: boolean;
  /** May a caller replace the current cadence with a short-term (engaged/standard) one? */
  blockEngagedDowngrade: boolean;
  /** Is an active cadence currently running at the WRONG speed and in need of a heal? */
  needsLongTermHeal: boolean;
  reason: string;
};

const FINANCE_DECLINED_STATE_TOKENS = new Set([
  "financing_declined",
  "finance_not_approved",
  "finance_declined",
  "not_approved",
  "declined"
]);

function isFinanceDeclinedToken(raw: string | null | undefined): boolean {
  const value = String(raw ?? "").trim().toLowerCase();
  if (!value) return false;
  return FINANCE_DECLINED_STATE_TOKENS.has(value);
}

export function decideFinanceDeclinedCadence(
  input: FinanceDeclinedCadenceInput
): FinanceDeclinedCadenceDecision {
  const signals: string[] = [];
  if (isFinanceDeclinedToken(input.followUpReason)) signals.push("follow_up_reason");
  // `financeOutcome.status` is the narrow finance lane and carries the bare token "declined";
  // the appointment outcome carries the legacy "financing_declined" / secondary
  // "finance_not_approved" pair written by normalizeAppointmentOutcomeInput().
  if (isFinanceDeclinedToken(input.financeOutcomeStatus)) signals.push("finance_outcome");
  if (isFinanceDeclinedToken(input.appointmentOutcomeStatus)) signals.push("appointment_outcome");
  if (isFinanceDeclinedToken(input.appointmentOutcomeSecondaryStatus)) {
    signals.push("appointment_outcome_secondary");
  }

  const isFinanceDeclined = signals.length > 0;
  const cadenceKind = String(input.cadenceKind ?? "").trim().toLowerCase();
  const cadenceStatus = String(input.cadenceStatus ?? "").trim().toLowerCase();
  // post_sale outranks everything (they bought something in the end) and long_term is already
  // correct, so neither is a downgrade target and neither needs healing.
  const cadenceIsShortTerm = cadenceKind !== "long_term" && cadenceKind !== "post_sale";

  return {
    isFinanceDeclined,
    blockEngagedDowngrade: isFinanceDeclined && cadenceKind === "long_term",
    needsLongTermHeal: isFinanceDeclined && cadenceIsShortTerm && cadenceStatus === "active",
    reason: isFinanceDeclined ? `finance_declined:${signals.join("+")}` : "not_finance_declined"
  };
}

/**
 * May we PROACTIVELY text the business manager asking for a finance outcome? (Joe ruling
 * 2026-08-04: "a pre qual should not create a finance outcome.")
 *
 * Christopher Szczesny +17169400722 arrived 8/2 from "Marketplace - Prequal", which stamps the
 * conversation `bucket: finance_prequal` / `cta: prequalify` FOREVER. Two days later the whole
 * thread was inventory — "can u dsend pics", "looking for a used road glide with some goodies" —
 * and the state agreed (`dialogState: inventory_answered`). A staff-initiated call then hit his
 * voicemail, and the no-contact handler texted Stone "Finance outcome needed: … Reply OUTCOME
 * <token> APPROVED | DECLINED | NEEDS_INFO | PENDING" plus an open task. There was no credit app,
 * no approval pending, no finance appointment — nothing whose outcome a manager could report.
 *
 * The old gate read HOW THE LEAD ARRIVED as if it were WHAT THE DEAL IS DOING NOW: a prequal
 * origin label never expires, so every prequal-sourced lead nags the manager the first time a
 * call goes to voicemail. This referee requires a real finance ARTEFACT instead:
 *   - `cta: hdfs_coa` — a SUBMITTED HDFS credit application (note `hdfs_coa_online` also carries
 *     bucket `finance_prequal`, so the bucket alone can never be the discriminator);
 *   - a live credit-app / financing-declined follow-up state;
 *   - a booked `finance_discussion` appointment.
 * A soft prequal form on its own is NOT one.
 *
 * Fail-direction: this gates an unprompted SMS to staff plus an open task, so the safe direction
 * is to stay quiet about a deal that does not exist. Nothing here blocks RECORDING an outcome —
 * the outcome token/link still exists, the appointment-outcome lane has its own (already
 * artefact-only) gate, and staff explicitly picking "approved"/"declined" on a task still writes
 * the finance outcome through `isFinanceOutcomeContextForConversation`.
 */
export type BusinessManagerFinanceOutcomePromptInput = {
  /** classification.cta — how the lead came in ("prequalify", "hdfs_coa", …). */
  leadCta?: string | null;
  /** classification.bucket — kept for the reason string; never sufficient on its own. */
  leadBucket?: string | null;
  followUpReason?: string | null;
  appointmentType?: string | null;
};

export type BusinessManagerFinanceOutcomePromptDecision = {
  /** May the caller send the business-manager finance-outcome prompt? */
  prompt: boolean;
  reason: string;
};

const FINANCE_OUTCOME_LIVE_FOLLOW_UP_REASONS = new Set([
  "credit_app",
  "credit_app_cosigner",
  "credit_app_needs_info",
  "credit_app_approved",
  "financing_declined"
]);

export function decideBusinessManagerFinanceOutcomePrompt(
  input: BusinessManagerFinanceOutcomePromptInput
): BusinessManagerFinanceOutcomePromptDecision {
  const cta = String(input.leadCta ?? "").trim().toLowerCase();
  const bucket = String(input.leadBucket ?? "").trim().toLowerCase();
  const followUpReason = String(input.followUpReason ?? "").trim().toLowerCase();
  const appointmentType = String(input.appointmentType ?? "").trim().toLowerCase();

  const signals: string[] = [];
  if (cta === "hdfs_coa") signals.push("credit_app_online");
  if (FINANCE_OUTCOME_LIVE_FOLLOW_UP_REASONS.has(followUpReason)) signals.push("follow_up_reason");
  if (appointmentType === "finance_discussion") signals.push("finance_appointment");

  if (signals.length) return { prompt: true, reason: `finance_artifact:${signals.join("+")}` };
  // The two labels that used to be enough on their own, named so the skip is legible in a trace.
  if (bucket === "finance_prequal" || cta === "prequalify") {
    return { prompt: false, reason: "prequal_origin_only" };
  }
  return { prompt: false, reason: "no_finance_context" };
}

// How long the proactive cadence goes QUIET after we just reached out — one referee for what were
// four independent copies of the same block.
//
// THE FIGHT, concretely. Four places in index.ts each decided for themselves how to hush the
// follow-up cadence right after the agent had already contacted the customer:
//
//   deliverDuePendingWatchAlerts        (~7146)  "we just texted them the bike they were watching"
//   processInventoryWatchlist           (~7446)  same, from the feed sweep
//   notifyInventoryWatchersForAvailableItem (~7643)  same, from a hold/sold clearing
//   applySoftVisitCadenceWindow        (~10980)  "they said they'd stop by Saturday"
//
// The first three were byte-identical copy-paste; the fourth is a near-twin that drifted. Nothing
// arbitrated between them, so a change to one silently left the other three behind — exactly the
// shape that produced PR #398 (two writers of `followUpCadence` disagreeing 37 seconds apart).
//
// DIVERGENCE 1 — RESTARTING A STOPPED CADENCE. **Joe ruled 2026-08-01: make it match.**
//      The three watch sites blank `followUpCadence` before calling startFollowUpCadence, because
//      that function refuses to overwrite a cadence whose status is already "active" or "stopped".
//      The soft-visit site did NOT blank it, so on a STOPPED cadence its restart quietly no-op'd:
//      a customer who said "I'll be there Saturday" got no cadence, therefore no day-before
//      "still planning to stop by?" reminder and no follow-up after the visit day. That was a real
//      customer-facing miss, and it is now fixed — soft visits revive a stopped cadence too.
//
//      ONE CARVE-OUT, and it is not optional. `setFollowUpMode(conv, "manual_handoff")` STOPS the
//      cadence on purpose: "a handed-off lead must not keep an ACTIVE customer cadence — otherwise
//      it can auto-text the customer mid-handoff (audited contradiction class)". The watch sites
//      escape that because they flip the mode to `holding_inventory` first; the soft-visit site
//      deliberately PRESERVES `manual_handoff` (see the guard right after its call). So a literal
//      "match the watch paths" would leave a human-owned thread carrying a live automated cadence —
//      re-creating the exact contradiction that invariant exists to prevent. `paused_indefinite`
//      is excluded for the same reason: someone deliberately said stop.
//      Net: soft visits now revive a stopped cadence EXCEPT on a human-owned or deliberately
//      paused thread. Fail direction of the carve-out is safe — it only ever means FEWER touches.
//   2. THE INVITE BUDGET. Only the soft-visit site resets scheduleInviteCount/scheduleMuted — a
//      fresh visit commitment re-opens the "what time works?" budget. The watch sites leave it
//      alone. Deliberate, and now stated.
//
// FAIL DIRECTION. Quieting is the SAFE direction: it only ever DELAYS a proactive touch, never
// sends one. We have just messaged this customer, so the failure we must avoid is chasing them
// again on top of that message. So an unrecognized trigger still quiets. What this must never do
// is quiet a cadence that isn't running: `quiet` is gated on the cadence actually being active
// after any restart, so a closed/absent conversation is left alone rather than resurrected.
//
// PURE + CLOCK-FREE: the caller computes `quietUntilIso` (the watch sites use now+7d, the
// soft-visit site uses the day-before-visit reminder) and passes it in, so this stays sampleable
// by the decision-equivalence harness.
export type CadenceQuietTrigger =
  | "inventory_watch_alert" // we just sent the "your bike is here" text
  | "soft_visit_window"; // the customer committed to coming in on a day

export type CadenceQuietInput = {
  trigger: CadenceQuietTrigger;
  /** Current `followUpCadence.status`. Absent/blank = there is no cadence at all. */
  cadenceStatus?: string | null;
  /**
   * Current `followUp.mode`. Only consulted for a soft visit, and only to REFUSE a revival on a
   * thread a human owns or that was deliberately paused — never to start one.
   */
  followUpMode?: string | null;
  /** Caller-supplied pause reason; falls back to the trigger's own default. */
  reason?: string | null;
};

export type CadenceQuietDecision = {
  /** Try to (re)start a cadence first, so there is something to quiet. */
  restartCadence: boolean;
  /** Discard the stopped cadence before restarting — without this, startFollowUpCadence no-ops. */
  clearStoppedCadenceFirst: boolean;
  /** Apply the quiet window (only ever to a cadence that is active once the restart has run). */
  quiet: boolean;
  /** Pause reason to record. */
  reason: string;
  /** Re-open the schedule-invite budget (soft visit only). */
  resetScheduleInvites: boolean;
  why: string;
};

const CADENCE_QUIET_DEFAULT_REASON: Record<CadenceQuietTrigger, string> = {
  inventory_watch_alert: "inventory_watch_match",
  soft_visit_window: "soft_visit_window"
};

/**
 * Modes where the automated cadence must NOT be revived: a human owns the thread, or someone
 * deliberately stopped the chase. Reviving either would re-create the contradiction
 * `setFollowUpMode` guards against (handoff + active cadence = auto-texting mid-handoff).
 */
const CADENCE_REVIVAL_BLOCKING_MODES = new Set(["manual_handoff", "paused_indefinite"]);

export function decideCadenceQuietWindow(input: CadenceQuietInput): CadenceQuietDecision {
  const status = String(input.cadenceStatus ?? "").trim().toLowerCase();
  const missingOrStopped = !status || status === "stopped";
  const isSoftVisit = input.trigger === "soft_visit_window";
  const mode = String(input.followUpMode ?? "").trim().toLowerCase();
  // Only the soft-visit path consults the mode. The watch paths flip the mode to
  // `holding_inventory` themselves before quieting, so there is no handoff left to contradict.
  const revivalBlocked = isSoftVisit && CADENCE_REVIVAL_BLOCKING_MODES.has(mode);
  const restartCadence = missingOrStopped && !revivalBlocked;
  const reason =
    String(input.reason ?? "").trim() ||
    CADENCE_QUIET_DEFAULT_REASON[input.trigger] ||
    CADENCE_QUIET_DEFAULT_REASON.inventory_watch_alert;

  return {
    restartCadence,
    // Joe 2026-08-01: soft visits now blank a stopped cadence like the watch paths do, so the
    // revival actually takes. Moves in lockstep with restartCadence — a restart that cannot
    // overwrite the stopped cadence is the silent no-op this ruling exists to kill.
    clearStoppedCadenceFirst: restartCadence,
    quiet: true,
    reason,
    // Divergence (2) above: only a fresh visit commitment re-opens the invite budget.
    resetScheduleInvites: isSoftVisit,
    why: revivalBlocked
      ? `a ${mode} thread keeps its stopped cadence — never revive a chase a human or a deliberate pause ended`
      : missingOrStopped
        ? `no live cadence to quiet — restart first, then hold for ${reason}`
        : `hold the running cadence for ${reason}`
  };
}

// What counts as a DEAD CHASE that a re-engagement trigger may overwrite — one referee for what
// were four independent answers.
//
// THE SHAPE OF THE PILE. `startFollowUpCadence` refuses to lay a new chase over a lead that already
// carries an `active` or `stopped` cadence (see `decideCadenceStart`), because quietly reviving a
// chase somebody deliberately ended is the fail-unsafe direction. So every re-engagement trigger
// that DOES mean to revive one first BLANKS the record (`conv.followUpCadence = undefined`) to
// defeat that guard. Four places did that, each with its own hand-rolled test for which cadences
// are dead enough to throw away, and the tests did not agree.
//
// TWO PRESERVED DIVERGENCES — both real today, both left exactly as they are (this is a
// behavior-PRESERVING un-stacking; the referee makes the disagreement visible and named, it does
// not settle it):
//   1. `finance_no_contact` is the only trigger that also treats a `completed` chase as dead.
//      On the other three a completed cadence is left standing, `startFollowUpCadence` is never
//      called, and the trigger's own `pauseFollowUpCadence` then no-ops (it requires `active`) —
//      i.e. the trigger silently does nothing. That is the SAFE direction (fewer proactive texts),
//      which is why it is preserved rather than "fixed".
//   2. `manual_hold_clear` is the only trigger that forces a SURVIVING non-dead cadence back to
//      `active` where it stands instead of leaving it alone. A walk-in note saying the hold is over
//      is an explicit staff instruction to resume the chase, so it overrides a pause the same way
//      it overrides the hold.
//
// FAIL DIRECTION. Every output here can only ever START or RESUME proactive texting, so the
// dangerous direction is reviving too much. An unrecognized trigger therefore gets the STRICTEST
// answer (stopped-only, no in-place reactivation) rather than the most permissive one — a caller
// that forgets to register its trigger loses a revival, it never gains one.
//
// PURE + CLOCK-FREE: the caller supplies the anchor and timezone to the applier; this decides only
// which record may be discarded, so it stays sampleable by the decision-equivalence harness.
export type CadenceRevivalTrigger =
  | "health_recovery_delay" // customer told us they're unwell — push the chase out, restart if dead
  | "customer_followup_deferral" // "take your time" — re-tag as engaged and hold
  | "finance_no_contact" // voicemail on a manual finance handoff — keep the lead moving
  | "manual_hold_clear"; // walk-in note says the hold is over — resume the chase

export type CadenceRevivalInput = {
  trigger: CadenceRevivalTrigger | string;
  /** Is there a cadence record on the lead at all? False = nothing to overwrite. */
  hasCadence: boolean;
  /** Current `followUpCadence.status`, exactly as stored. Blank when there is no cadence. */
  cadenceStatus?: string | null;
};

export type CadenceRevivalDecision = {
  /** Discard the dead record first — without this, `startFollowUpCadence` no-ops. */
  replaceDeadCadence: boolean;
  /** Lay down a fresh day-one ramp (nothing there, or what was there is dead). */
  startFresh: boolean;
  /** Force a SURVIVING non-dead cadence back to `active` where it stands. Divergence 2. */
  reactivateInPlace: boolean;
  /** Names the preserved disagreement when this trigger is the odd one out for THIS input. */
  divergence: string | null;
  why: string;
};

/**
 * Statuses each trigger is willing to throw away. `stopped` is the universal one — that is the
 * status `startFollowUpCadence`'s own guard blocks on, and defeating it is why these sites blank
 * the record at all. Only the finance lane adds `completed` (divergence 1).
 */
const CADENCE_REVIVAL_DEAD_STATUSES: Record<CadenceRevivalTrigger, ReadonlySet<string>> = {
  health_recovery_delay: new Set(["stopped"]),
  customer_followup_deferral: new Set(["stopped"]),
  finance_no_contact: new Set(["stopped", "completed"]),
  manual_hold_clear: new Set(["stopped"])
};

export function decideCadenceRevival(input: CadenceRevivalInput): CadenceRevivalDecision {
  const trigger = String(input.trigger ?? "").trim() as CadenceRevivalTrigger;
  const status = String(input.cadenceStatus ?? "").trim().toLowerCase();
  // Unrecognized trigger falls back to the strictest table, never the most permissive — see the
  // fail-direction note above.
  const deadStatuses =
    CADENCE_REVIVAL_DEAD_STATUSES[trigger] ?? CADENCE_REVIVAL_DEAD_STATUSES.health_recovery_delay;
  const hasCadence = Boolean(input.hasCadence);
  const isDead = hasCadence && deadStatuses.has(status);
  const reactivateInPlace = trigger === "manual_hold_clear" && hasCadence && !isDead;

  const divergence =
    isDead && status === "completed"
      ? "finance_no_contact_alone_revives_a_completed_chase"
      : reactivateInPlace
        ? "manual_hold_clear_alone_forces_a_surviving_chase_back_to_active"
        : null;

  return {
    replaceDeadCadence: isDead,
    startFresh: !hasCadence || isDead,
    reactivateInPlace,
    divergence,
    why: !hasCadence
      ? `${trigger}: no cadence on the lead — start the day-one ramp`
      : isDead
        ? `${trigger}: the ${status} chase is dead — discard it and start over`
        : reactivateInPlace
          ? `${trigger}: staff cleared the hold — put the ${status} chase back to work as it stands`
          : `${trigger}: a ${status} chase is not dead — leave it alone`
  };
}

// The lead BOUGHT — one referee for what were two hand-maintained copies of the same closeout.
//
// WHAT WAS FIGHTING. Marking a unit sold happens down two paths that were written separately and
// then kept in step by hand: `applyOutcomeSold` (the rep records an appointment outcome) and
// `POST /conversations/:id/close` with reason "sold" (the console's sold button). Both stamp the
// sale, close the thread as "sold", decide whether the lead's unit HOLD is released, and start the
// owner sequence — including a five-line hold-match condition duplicated character for character.
// Three Tier-1 fields (`status`, `closedReason`, `hold`) had two independent writers each, and the
// only thing keeping them equal was that nobody had edited one copy without the other yet.
//
// THE ONE PRESERVED DIVERGENCE: the outcome path REFUSES a sale with no unit named (it returns an
// error before touching anything), while the console endpoint accepts one — it closes the thread as
// sold and starts the owner sequence, but skips the whole inventory block, so the lead's hold is
// never released and the bike stays flagged HELD in inventory with a sold conversation attached to
// it. Named on the decision as `sold_closeout_without_a_named_unit_leaves_the_hold_standing`.
// Preserved, not fixed: releasing a hold we cannot match to the sold unit could free the WRONG
// bike, which is the worse direction. Fixing it is a behavior change and belongs in its own PR.
//
// FAIL DIRECTION. Releasing a hold is the irreversible-ish side of this decision (the unit goes
// back on the floor), so anything unresolved must KEEP the hold. Closing the thread is not gated
// on the unit at all — both paths agree that a recorded sale closes the conversation, and that is
// the answer a lead who just bought should get either way.
//
// PURE: the caller resolves `holdMatchesSoldUnit` (it needs the inventory matcher and the lead's
// stored hold), so this stays sampleable by the decision-equivalence harness.
export type SoldCloseoutInput = {
  /** Did staff name an actual unit on this sale? The console endpoint allows a sale without one. */
  hasSoldUnit: boolean;
  /** The lead's stored hold, exactly as recorded. Absent = nothing to release. */
  hold?: { key?: string | null; onOrder?: boolean | null } | null;
  /** Normalized key of the unit that just sold. */
  soldKey?: string | null;
  /**
   * Does the stored hold match the sold unit by stock number / VIN? Resolved by the caller because
   * it needs the inventory matcher and the previous hold key as a fallback.
   */
  holdMatchesSoldUnit: boolean;
};

export type SoldCloseoutDecision = {
  /** Close the thread. Both paths say yes for any recorded sale. */
  closeConversation: boolean;
  closedReason: string;
  /** Drop the lead's unit hold. The five-line condition both copies carried, stated once. */
  releaseHold: boolean;
  /** Names the preserved disagreement when this input is the odd one out. */
  divergence: string | null;
  why: string;
};

export function decideSoldCloseout(input: SoldCloseoutInput): SoldCloseoutDecision {
  const hasSoldUnit = Boolean(input.hasSoldUnit);
  const hold = input.hold ?? null;
  // Compared RAW, exactly as both copies did. No trim/normalize here: the keys on both sides come
  // out of `normalizeInventorySoldKey`, and quietly normalizing one side would make two keys match
  // that do not match today — a cleanup must not change which bike gets freed.
  const soldKey = input.soldKey;
  // The condition both copies spelled out inline: an on-order hold and a keyless hold are always
  // this lead's own, a keyed hold has to be the same unit, and otherwise the inventory matcher
  // decides. Anything that does not clear one of those bars KEEPS the hold — see fail direction.
  const holdIsThisUnit = Boolean(
    hold && (hold.onOrder || !hold.key || hold.key === soldKey || input.holdMatchesSoldUnit)
  );
  const releaseHold = hasSoldUnit && holdIsThisUnit;

  return {
    closeConversation: true,
    closedReason: "sold",
    releaseHold,
    divergence:
      !hasSoldUnit && Boolean(hold)
        ? "sold_closeout_without_a_named_unit_leaves_the_hold_standing"
        : null,
    why: !hasSoldUnit
      ? hold
        ? "sold with no unit named — the thread closes but the lead's hold is left standing"
        : "sold with no unit named — nothing held, so nothing to release"
      : releaseHold
        ? "sold — this lead's hold is the unit that sold, so release it"
        : hold
          ? "sold — the lead's hold is a different unit, so it stays"
          : "sold — the lead had no hold to release"
  };
}

// When a lead's thread CLOSES, what else has to settle? One referee for what were two independent
// answers. This is the SIBLING of `decideSoldCloseout` and deliberately not merged with it: that
// one answers "does the unit HOLD come off", this one answers "what does closing itself entail".
//
// THE TWO LANES, and they were never equal:
//   generic_close            `closeConversation(conv, reason)` — every ordinary close, any reason.
//   appointment_outcome_sold the console header's appointment outcome "sold", which hand-wrote
//                            `status`/`closedAt`/`closedReason` itself and never routed through
//                            `closeConversation` at all.
//
// THE DIVERGENCE, PRESERVED AS-IS (named, not fixed): `closeConversation` pauses every ACTIVE
// inventory watch at write time — a reopen must not refire "it's available again!" at someone who
// already closed or bought (the `watch_active_on_closed` leak the outcome auditor surfaced 6/25).
// The appointment-outcome sold lane does not, so between that write and the next maintenance tick
// the lead keeps a live watch on a closed, SOLD thread. It is genuinely mitigated rather than
// merely unnoticed: the state-invariant reconcile pauses watches on any conversation carrying
// `closedAt`/`closedReason`/`sale.soldAt`, and its own comment names this exact gap. So the
// exposure is the window between the two, not a permanent leak — which is why it is preserved
// here and raised separately instead of being "tidied" inside a behavior-preserving un-stacking.
//
// FAIL DIRECTION for whoever changes this later: pausing a watch is REVERSIBLE (the record stays,
// the fire engine just skips it) while an alert already texted to someone who bought is not, so an
// unresolved lane should pause. That is an argument for changing the sold lane, and it belongs in
// its own `fix/` PR with its own evidence — not in this one.
export type LeadCloseoutLane = "generic_close" | "appointment_outcome_sold";

export type LeadCloseoutInput = {
  lane: LeadCloseoutLane;
  /**
   * The reason the caller supplies. Passed through UNCHANGED, including `undefined` — a bare
   * `closeConversation(conv)` stores no reason today, and readers distinguish that from a string.
   */
  reason?: string | undefined;
};

export type LeadCloseoutDecision = {
  /** Exactly what gets stored on `conv.closedReason`. */
  closedReason: string | undefined;
  /** Pause every ACTIVE inventory watch at write time. Only the generic lane does today. */
  pauseActiveWatches: boolean;
  /** Names the preserved disagreement when this lane is the odd one out. */
  divergence: string | null;
  why: string;
};

export function decideLeadCloseout(input: LeadCloseoutInput): LeadCloseoutDecision {
  const sold = input.lane === "appointment_outcome_sold";
  return {
    // The sold lane hard-codes "sold"; the generic lane stores whatever it was handed.
    closedReason: sold ? "sold" : input.reason,
    pauseActiveWatches: !sold,
    divergence: sold
      ? "appointment_outcome_sold_leaves_active_watches_running_until_the_reconcile_tick"
      : null,
    why: sold
      ? "sold from the appointment outcome — the thread closes, active watches left to the reconcile tick"
      : "an ordinary close — the thread closes and every active inventory watch is paused at write time"
  };
}

// How many times may we ask this customer to come in, and what happens once we stop asking?
//
// THE FIGHT WAS A DUPLICATED CONSTANT, which is the quietest kind. Two places owned "how many
// invites is too many", in two different files, with nothing making them agree:
//   conversationStore.registerScheduleInviteSent   `threshold = 3` — latches `scheduleMuted` once
//                                                  the count reaches it.
//   index.ts SCHEDULE_INVITE_THRESHOLD = 3         picks the follow-up message POOL: below it the
//                                                  fresh-info lines, at or above it the soft exits.
// They happen to agree at 3 today, so nothing is broken. But they are read on the SAME counter for
// the SAME question, and moving one without the other would silently split the pairing: the mute
// would latch at one count while the message pool switched at another, so a customer could be
// muted and still be getting fresh-info invites (or soft-exit lines while the budget said there was
// still room). This referee owns the number; both sides ask it.
//
// FAIL DIRECTION: this budget only ever makes us ask LESS. Spending it wrong in the "too few"
// direction just means a softer message; in the "too many" direction it means pestering someone who
// has ignored three invitations. So an unresolved count resolves toward SPENT (mute), never toward
// more asking — which is what `?? 0` on a missing count already does, since 0 < threshold only
// while there is genuinely room.
export const SCHEDULE_INVITE_THRESHOLD = 3;

export type ScheduleInviteBudgetInput = {
  /** `followUpCadence.scheduleInviteCount` as it stands BEFORE this turn. */
  inviteCount?: number | null;
  /**
   * Caller override. `registerScheduleInviteSent` accepted one and NOBODY ever passed it — kept so
   * the store helper's signature is unchanged, and so a per-dealer budget has somewhere to land.
   */
  threshold?: number;
};

export type ScheduleInviteBudgetDecision = {
  threshold: number;
  /** The count as it stands now. */
  inviteCount: number;
  /** The count after recording one more invite. */
  nextInviteCount: number;
  /** The budget is ALREADY spent at the current count — the soft-exit message pool. */
  spent: boolean;
  /** Latch `scheduleMuted` when recording this invite. */
  mute: boolean;
  why: string;
};

export function decideScheduleInviteBudget(
  input: ScheduleInviteBudgetInput
): ScheduleInviteBudgetDecision {
  // Must be POSITIVE, not merely finite: `Number("")` and `Number(null)` are both 0, and a
  // threshold of 0 would mute every lead on its first invite — "never ask" dressed up as a budget.
  // Caught by this referee's own eval enumerating junk inputs.
  const rawThreshold = Number(input.threshold);
  const threshold =
    Number.isFinite(rawThreshold) && rawThreshold > 0 ? rawThreshold : SCHEDULE_INVITE_THRESHOLD;
  const inviteCount = Number(input.inviteCount ?? 0) || 0;
  const nextInviteCount = inviteCount + 1;
  const spent = inviteCount >= threshold;
  const mute = nextInviteCount >= threshold;
  return {
    threshold,
    inviteCount,
    nextInviteCount,
    spent,
    mute,
    why: spent
      ? `already asked ${inviteCount} time(s) against a budget of ${threshold} — soft exits from here`
      : mute
        ? `this invite spends the last of the budget (${nextInviteCount}/${threshold}) — mute after it`
        : `invite ${nextInviteCount} of ${threshold} — there is still room to ask`
  };
}

// Who may put a bike ON HOLD for a lead, and what does that hold record say? One referee for what
// were two hand-maintained copies of the same fourteen-field block.
//
// This is the INVERSE of `decideInventoryAvailabilityReopen` (PR #463), which only ever CLEARS a
// hold — it could never vouch for the two places that WRITE one. Those two:
//   appointment_outcome   `applyOutcomeHold` — a rep records the appointment outcome as "held".
//   console_resolution    the console's manual-resolution endpoint, resolution === "hold".
// They were copies down to the field ORDER, which is why they are safe to merge; the persisted JSON
// must stay byte-identical, so the order below is the originals' order and must not be "tidied".
//
// TWO DIVERGENCES, BOTH PRESERVED AS-IS (named, not fixed):
//
// (1) THE MODE STOMP — the one that can matter to a customer. Both lanes stop the chase. The
//     console lane then sets `paused_indefinite` only when this request did NOT also arm an
//     inventory watch AND the thread is not already `manual_handoff`; the appointment-outcome lane
//     sets it unconditionally, overwriting BOTH. Overwriting `manual_handoff` is the fail-unsafe
//     half: the thread stops saying "a human owns this", and when the hold is later cleared the
//     console's own hold_clear branch flips a `unit_hold`/`order_hold` thread back to ACTIVE — so
//     the agent can resume texting a lead a human had taken over. Nothing is texted at hold time
//     (the chase is stopped either way), so this is a LATENT divergence, not a live send.
//     Named `appointment_outcome_hold_overwrites_a_human_handoff`; fix direction is to adopt the
//     console lane's guards, and that belongs in its own `fix/` PR with its own evidence.
//
// (2) THE NULL KEY — cosmetic today, kept so the stored record is unchanged. An on-order hold has
//     no stock number or VIN, so `normalizeInventoryHoldKey` returns null. The outcome lane stores
//     that null; the console lane collapses it to `undefined`, which drops the property from the
//     saved JSON entirely. Every reader coalesces (`conv.hold?.key &&`, `!hold.key`,
//     `?? undefined`), so the two behave identically — but they are not the same stored record, so
//     the difference is carried on the decision rather than normalized away.
//
// FAIL DIRECTION for whoever changes this later: a hold STOPS outreach, so an unresolved lane
// should hold rather than not. What is NOT reversible is waking the agent up on a thread a human
// owns — hence divergence 1's direction.
export type InventoryHoldRecordLane = "appointment_outcome" | "console_resolution";

/**
 * Structural mirror of the stored `conv.hold` record. `routeStateReducer` deliberately imports no
 * store types (they drag the whole `Conversation` graph in), so the shape is restated here and
 * narrowed with a documented cast in the applier.
 */
export type InventoryHoldRecord = {
  key: string | null | undefined;
  onOrder: true | undefined;
  stockId: string | undefined;
  vin: string | undefined;
  year: string | undefined;
  make: string | undefined;
  model: string | undefined;
  trim: string | undefined;
  color: string | undefined;
  label: string | undefined;
  note: string | undefined;
  reason: "unit_hold" | "order_hold";
  createdAt: string;
  updatedAt: string;
};

export type InventoryHoldRecordInput = {
  lane: InventoryHoldRecordLane;
  /** `normalizeInventoryHoldKey(stockId, vin)` — null when nothing identifies a physical unit. */
  holdKey: string | null;
  /** The bike is on order rather than on the floor; both lanes reject a hold that is neither. */
  onOrder: boolean;
  unit: {
    stockId?: string;
    vin?: string;
    year?: string;
    make?: string;
    model?: string;
    trim?: string;
    color?: string;
    label?: string;
  };
  note?: string;
  /** `conv.hold?.createdAt` — when this lead FIRST held a bike; preserved across a re-hold. */
  existingCreatedAt?: string;
  nowIso: string;
  /** console lane only: this same request also armed an inventory watch. */
  watchApplied?: boolean;
  /** `conv.followUp?.mode` as it stands before the hold lands. */
  currentFollowUpMode?: string;
};

export type InventoryHoldRecordDecision = {
  reason: "unit_hold" | "order_hold";
  /** Exactly what gets stored on `conv.hold`, field order included. */
  record: InventoryHoldRecord;
  /** Both lanes stop the chase, under the hold reason. */
  stopCadenceReason: string;
  /** Force the thread to `paused_indefinite`. See divergence 1. */
  setPausedIndefinite: boolean;
  /** Names the preserved disagreement when this lane is the odd one out. */
  divergence: string | null;
  why: string;
};

export function decideInventoryHoldRecord(
  input: InventoryHoldRecordInput
): InventoryHoldRecordDecision {
  const outcomeLane = input.lane === "appointment_outcome";
  const reason: "unit_hold" | "order_hold" = input.onOrder ? "order_hold" : "unit_hold";
  const handoffOwned = String(input.currentFollowUpMode ?? "") === "manual_handoff";
  // Divergence 1. The console lane looks before it writes; the outcome lane never did.
  const setPausedIndefinite = outcomeLane ? true : !input.watchApplied && !handoffOwned;
  const unit = input.unit;
  return {
    reason,
    record: {
      // Divergence 2. The outcome lane keeps the null; the console lane drops the property.
      key: outcomeLane ? input.holdKey : input.holdKey || undefined,
      onOrder: input.onOrder || undefined,
      stockId: unit.stockId,
      vin: unit.vin,
      year: unit.year,
      make: unit.make,
      model: unit.model,
      trim: unit.trim,
      color: unit.color,
      label: unit.label,
      note: input.note,
      reason,
      createdAt: input.existingCreatedAt ?? input.nowIso,
      updatedAt: input.nowIso
    },
    stopCadenceReason: reason,
    setPausedIndefinite,
    divergence:
      outcomeLane && (handoffOwned || input.watchApplied)
        ? "appointment_outcome_hold_overwrites_a_human_handoff"
        : null,
    why: outcomeLane
      ? handoffOwned
        ? "held from the appointment outcome — the chase stops and the thread is forced to paused_indefinite, overwriting a human handoff"
        : "held from the appointment outcome — the chase stops and the thread is forced to paused_indefinite"
      : setPausedIndefinite
        ? "held from the console — the chase stops and the thread pauses indefinitely"
        : handoffOwned
          ? "held from the console — the chase stops, but a human owns this thread so its mode stands"
          : "held from the console — the chase stops, but a watch was armed on this same request so its mode stands"
  };
}

// Who may release a HELD draft — one referee for what were six independent decisions.
//
// `draftHeld` is the "being fixed" marker: the quality gate withheld a reply, so staff see a card
// instead of a draft. SETTING it is centralized already (both set-sites sit in
// publishCustomerReplyDraft and run in sequence). CLEARING it was not — six places each decided for
// themselves, and each was patched separately after its own production incident. The comments in
// conversationStore.ts still name them: Nicholas Braun 2026-06-24 ("stuck because only provider
// 'human' cleared it"), s R Gurajala 2026-06-25 ("the flag stayed stuck after a real reply"), and
// again 2026-06-24 ("the console keeps showing 'being fixed' over a real draft").
//
// THE FIGHT, concretely: the clear-on-outbound site in `appendOutbound` releases the hold ONLY when
// `heldKind === "context_fidelity"`, while the console-send site releases ANY hold. Same trigger — a
// real reply went out — opposite answers. So a DRAFT-QUALITY hold survives a genuine reply on the
// first path and the card never goes away. That is live today: the 2026-08-01 work order carries
// "draft is stuck on being fixed" (+17167134728) and "says the ai's draft is being fixed, but no fix
// happened" (+17164785613).
//
// This referee takes the UNION, which is the narrower site's own intent: any real reply releases any
// hold. That is a BEHAVIOR CHANGE on that one path, in the fail-safe direction, and it is called out
// in the PR rather than buried — a cleanup must never smuggle one in silently.
//
// FAIL DIRECTION: releasing costs nothing customer-facing — the marker is staff-only UI and the
// withheld draft is NOT restored by clearing it (see the escalation site: "the withheld weak draft is
// NOT restored — staff replies fresh"). Leaving it stuck, by contrast, hides a live lead behind a
// permanent "being fixed" card, which is the reported failure. So unknown/ambiguous ⇒ RELEASE.
//
// The one thing that must NEVER release it: the same AI re-publishing another draft. That is the
// generator that could not answer the turn marking its own homework.
export type HeldDraftReleaseEvent =
  | "real_reply" // a human/twilio/sendgrid message actually went to the customer
  | "operator_draft" // staff authored a replacement draft in the console
  | "ai_draft_passed" // a NEW ai draft cleared the quality gate
  | "escalated_to_human" // the hold became a staff task; the limbo must not persist
  | "ai_republish" // the same AI re-publishing — never self-clears
  | "internal_log"; // an internal/system note — not a reply

export type HeldDraftReleaseInput = {
  /** Absent/blank = nothing is held. */
  heldKind?: string | null;
  event: HeldDraftReleaseEvent;
};

export type HeldDraftReleaseDecision = { release: boolean; reason: string };

/** Providers that mean a message actually reached the customer. */
const REAL_REPLY_PROVIDERS = new Set(["human", "twilio", "sendgrid"]);

export function isRealReplyProvider(provider: string | null | undefined): boolean {
  return REAL_REPLY_PROVIDERS.has(String(provider ?? "").trim().toLowerCase());
}

export function decideHeldDraftRelease(input: HeldDraftReleaseInput): HeldDraftReleaseDecision {
  const held = String(input.heldKind ?? "").trim();
  if (!held) return { release: false, reason: "nothing_held" };
  switch (input.event) {
    case "real_reply":
      return { release: true, reason: "a real reply went out — the held turn is handled" };
    case "operator_draft":
      return { release: true, reason: "an operator-authored draft supersedes the hold" };
    case "ai_draft_passed":
      return { release: true, reason: "a new draft cleared the gate" };
    case "escalated_to_human":
      return { release: true, reason: "the hold became a staff task; limbo must not persist" };
    case "ai_republish":
      // The generator that could not answer this turn must not mark its own homework.
      return { release: false, reason: "the same AI re-publishing never self-clears" };
    case "internal_log":
      return { release: false, reason: "an internal log entry is not a reply" };
    default:
      // Unknown event ⇒ release, per the fail direction above: a stuck card hides a live lead.
      return { release: true, reason: "unrecognized event — failing toward releasing the hold" };
  }
}

// ---------------------------------------------------------------------------
// APPOINTMENT TEARDOWN — one referee for "when an appointment stops being an
// appointment, what actually gets cleared?"
//
// WHAT WAS FIGHTING. Five independent places in index.ts un-booked an appointment, each with its
// own hand-written list of fields to null out:
//
//   cancelBookedAppointmentForConversation   the customer texted "cancel"
//   the calendar reconcile sweep             the Google event was cancelled/deleted out from under us
//   the staff event-edit endpoint             staff cancelled or marked no-show in the console
//   manual-outbound schedule (confirm path)   staff set a time, the calendar refused the booking
//   manual-outbound schedule (parse path)     same, via the other branch of the same handler
//
// Nobody arbitrated, so the lists drifted. Three of the five clear the whole record; the two
// manual-outbound paths clear the BOOKING but leave the REQUESTED TIME behind.
//
// THE DIVERGENCE, PRESERVED HERE RATHER THAN FIXED (the un-stacking is behavior-preserving; the
// question goes to Joe). After a manual-outbound booking failure the record says status "none"
// with no event id — but `whenText` ("Saturday at 2:00 PM"), `confirmedBy: "salesperson"` and
// `matchedSlot` are all still set. buildAppointmentStatusReply reads whenText when there is no
// whenIso, so if that customer then asks "are we still on?" they are told "I'm seeing an
// appointment note for Saturday at 2:00 PM, but I'll have the team confirm it" — a half-affirmed
// time that was never booked. An identically-unbooked lead torn down by any of the other three
// paths gets the neutral "I'll have the team confirm your appointment status." Same state, two
// different things said to the customer. Pinned as-is by appointment_teardown:eval so it cannot
// drift further while the question is open.
//
// FAIL DIRECTION. A teardown that clears too LITTLE leaves a phantom appointment we may assert to
// a customer, or count in the funnel — the failure above. A teardown that clears too MUCH loses
// the requested time, which is recoverable (the manual-outbound paths also open a staff call todo
// carrying that time). So the safe default for an unrecognized cause is CLEAR EVERYTHING.
//
// PURE + CLOCK-FREE by contract: the caller stamps updatedAt and owns its own side effects
// (cancelling the Google event, opening the staff todo, setting dialog state). This referee owns
// only the field set.
export type AppointmentTeardownCause =
  | "customer_cancelled" // customer asked us to cancel a booked appointment
  | "calendar_event_gone" // reconcile sweep: the Google event is cancelled/deleted
  | "staff_cancelled" // staff cancelled the event from the console
  | "staff_no_show" // staff marked the appointment a no-show
  | "manual_outbound_book_failed"; // staff set a time the calendar would not accept

export type AppointmentTeardownInput = {
  cause: AppointmentTeardownCause;
  /**
   * Only the customer-cancel path lets its caller choose whether a reschedule is pending
   * (today it always passes false). Everyone else's answer is fixed by the cause.
   */
  reschedulePendingOverride?: boolean | null;
};

export type AppointmentTeardownDecision = {
  /** Always "none" — that is what teardown means. */
  status: "none";
  /** whenIso + every booked* field. Always cleared; a stale event id is never safe. */
  clearBookedEvent: boolean;
  /** whenText + confirmedBy — the human-readable requested time. FALSE on the diverging paths. */
  clearRequestedTime: boolean;
  /** matchedSlot — the concrete calendar slot we had matched. FALSE on the diverging paths. */
  clearMatchedSlot: boolean;
  reschedulePending: boolean;
  /** bookedSentAt / followUpSentAt / lastEventId / outcomeToken — the staff prompt state. */
  clearStaffPromptState: boolean;
  /** Close open appointment-class todos. FALSE where the caller instead OPENS a staff call todo. */
  closeAppointmentTodos: boolean;
  /** Names the preserved disagreement when this cause is one of the odd ones out. */
  divergence: string | null;
  why: string;
};

export function decideAppointmentTeardown(
  input: AppointmentTeardownInput
): AppointmentTeardownDecision {
  const cause = input.cause;
  const bookFailed = cause === "manual_outbound_book_failed";

  const reschedulePending =
    cause === "customer_cancelled"
      ? input.reschedulePendingOverride === true
      : cause === "staff_no_show"
        ? false
        : true;

  return {
    status: "none",
    clearBookedEvent: true,
    // RULED (Joe, 2026-08-01: "Clear it"). The manual-outbound failure paths used to KEEP the
    // requested time after the calendar refused the booking, so a customer who later asked "are we
    // still on?" was told "I'm seeing an appointment note for Saturday at 2:00 PM, but I'll have the
    // team confirm it" — half-affirming a time nobody ever booked. The other four teardown causes
    // clear it and produce the neutral "I'll have the team confirm your appointment status."
    // All five now behave the same. Staff lose nothing: the failure opens a call todo that carries
    // the time in its text ("Manual appointment could not be booked on calendar. Requested: ...").
    clearRequestedTime: true,
    clearMatchedSlot: true,
    reschedulePending,
    clearStaffPromptState: true,
    // STILL DIVERGENT, deliberately and unruled: those same two paths open a staff CALL todo rather
    // than closing the open appointment todos — that todo IS the recovery path for the failed
    // booking, so closing it would drop the work on the floor.
    closeAppointmentTodos: !bookFailed,
    divergence: bookFailed ? "manual_outbound_book_failed_opens_call_todo" : null,
    why: bookFailed
      ? "calendar refused a staff-set time — booking and time both cleared; a staff call todo carries the time forward"
      : `appointment torn down (${cause}) — record fully cleared`
  };
}

// ===================================================================================================
// THE APPOINTMENT OUTCOME RECORD — "what happened at the visit, and may a new answer overwrite the
// one already on the record?"
//
// WHAT WAS FIGHTING. Nine independent places wrote `appointment.staffNotify.outcome` (and its
// dealer-ride twin), each hand-building the record and each assigning it WHOLESALE:
//
//   the conversation-header outcome form      staff picks primary + secondary in the console
//   the public tokenized outcome form         the link we text the rep after the appointment
//   the todo-done modal                       staff closes the appointment todo with an outcome
//   the dealer-ride staff SMS reply           the rep answers the outcome prompt by text
//   the finance signal, declined              a parsed finance call/console result
//   the finance signal, needs-more-info       same lane, other branch
//   the finance signal, approved              same lane, other branch
//   the context-note booking read             a staff note read as cancel / reschedule
//   the context-note outcome read             a staff note read as an attendance outcome
//
// Nobody arbitrated, and the records drifted into two different SHAPES. Three writers run the
// input through normalizeAppointmentOutcomeInput() and store the modern pair
// (`primaryStatus` + `secondaryStatus`) alongside the legacy `status`. The other six store a bare
// `{ status, note, updatedAt }` and no pair at all.
//
// THE DISAGREEMENT THAT MATTERS (preserved here, NOT fixed here). Every downstream reader of
// attendance — isShowedAppointmentOutcome, isMissedAppointmentOutcome / canAssertMissedAppointment
// above, and customerVisitConfirmed in visitFraming.ts — asks `primaryStatus` FIRST and only falls
// back to the legacy `status` when the pair is blank. Because each writer replaces the whole
// object, a bare-shape write silently DELETES a recorded attendance and hands the question back to
// the legacy fallback, which can answer differently:
//
//   staff clicks "Did not show"       -> { status: "no_show", primaryStatus: "did_not_show", ... }
//   a finance call then lands declined-> { status: "financing_declined", note, updatedAt }
//   the attendance answer flips MISSED -> SHOWED, because the legacy showed-family list contains
//   "financing_declined". The recorded no-show is gone and canAssertMissedAppointment stops being
//   able to acknowledge the miss to the customer.
//
// The reverse runs too: a context note parsed as "cancelled" lands on a recorded showed/sold and
// the attendance answer flips SHOWED -> MISSED, which is licence to tell a customer who bought a
// bike that he failed to appear.
//
// The readers do not even agree with each other about the resulting record: customerVisitConfirmed
// in visitFraming.ts accepts only showed/showed_up from the legacy field, so the same overwritten
// record reads SHOWED here and NOT-A-VISIT there. Pinned in appointment_outcome_record:eval.
//
// TODAY'S BEHAVIOR IS PRESERVED EXACTLY: `record` is still the incoming write, whole, with no
// carry-forward. What changes is that the referee now NAMES the collision it just performed
// (`attendanceBefore` / `attendanceAfter` / `attendanceFlipped` / `dropsRecordedAttendance`), so it
// is visible and pinned instead of buried in nine branches. Fixing it is a behavior change and
// belongs to Joe.
//
// FAIL DIRECTION: this referee only SHAPES a record staff explicitly asked us to store — it never
// invents, suppresses or infers an outcome, and an unrecognized status keeps the caller's value
// verbatim. Its attendance readout mirrors the two helpers above exactly, so "unknown" (blank/
// unrecognized) is reported rather than guessed, and a blank never counts as a flip.
//
// PURE and CLOCK-FREE: the caller passes `nowIso`.
// ===================================================================================================

/** Where an outcome write came from. Named so a divergence can be attributed to a lane. */
export type AppointmentOutcomeSource =
  | "staff_console_header"
  | "staff_outcome_link"
  | "staff_todo_modal"
  | "staff_outcome_sms"
  | "finance_signal"
  | "context_note_booking"
  | "context_note_outcome";

/** What every downstream attendance reader ultimately resolves the record to. */
export type AppointmentAttendanceAnswer = "showed" | "missed" | "unknown";

export type AppointmentOutcomeRecordInput = {
  source: AppointmentOutcomeSource;
  /** The record already on the conversation, if any. Read-only — never mutated. */
  existing?: { status?: string | null; primaryStatus?: string | null; secondaryStatus?: string | null } | null;
  incoming: {
    status: string;
    /** Only the three normalized lanes supply the modern pair; the rest legitimately omit it. */
    primaryStatus?: string | null;
    secondaryStatus?: string | null;
    note?: string | null;
  };
  nowIso: string;
};

export type AppointmentOutcomeRecordDecision = {
  /** The record to store. Byte-for-byte what the nine sites wrote before — full replacement. */
  record: {
    status: string;
    primaryStatus?: string;
    secondaryStatus?: string;
    note?: string;
    updatedAt: string;
  };
  /** Attendance as the readers would answer it on the OLD record. */
  attendanceBefore: AppointmentAttendanceAnswer;
  /** Attendance as they will answer it on the NEW one. */
  attendanceAfter: AppointmentAttendanceAnswer;
  /** A recorded attendance is being replaced by a DIFFERENT recorded attendance. */
  attendanceFlipped: boolean;
  /** The old record carried an explicit primaryStatus and this write does not — the pair is lost. */
  dropsRecordedAttendance: boolean;
  /** True when this lane stores the bare legacy shape rather than the normalized pair. */
  bareLegacyShape: boolean;
  divergence: string | null;
  why: string;
};

/**
 * Resolves a stored outcome to the single question "did the customer show up?", exactly the way
 * isShowedAppointmentOutcome / isMissedAppointmentOutcome above do it: explicit `primaryStatus`
 * wins outright, the legacy `status` is consulted only when the pair is blank, and anything
 * unrecognized stays "unknown" rather than being guessed.
 */
export function readAppointmentAttendance(
  outcome: { status?: string | null; primaryStatus?: string | null } | null | undefined
): AppointmentAttendanceAnswer {
  if (!outcome) return "unknown";
  const primary = String(outcome.primaryStatus ?? "").trim().toLowerCase();
  const legacy = String(outcome.status ?? "").trim().toLowerCase();
  if (isShowedAppointmentOutcome(primary || null, legacy || null)) return "showed";
  if (isMissedAppointmentOutcome(primary || null, legacy || null)) return "missed";
  return "unknown";
}

export function decideAppointmentOutcomeRecord(
  input: AppointmentOutcomeRecordInput
): AppointmentOutcomeRecordDecision {
  const status = String(input.incoming.status ?? "").trim();
  const primaryStatus = String(input.incoming.primaryStatus ?? "").trim();
  const secondaryStatus = String(input.incoming.secondaryStatus ?? "").trim();
  const note = String(input.incoming.note ?? "").trim();

  const record: AppointmentOutcomeRecordDecision["record"] = {
    status,
    updatedAt: input.nowIso
  };
  const existingPrimary = String(input.existing?.primaryStatus ?? "").trim();

  // RULED (Joe, 2026-08-01: "the reps click wins"). Six of the nine write sites save a BARE record
  // — a `status` with no attendance answer — and assigning it wholesale erased what the rep had
  // recorded about whether the customer actually showed up. So: a rep clicks "did not show"; that
  // lead's finance application later comes back declined; the system then believed he DID come in,
  // and we lost the ability to say "sorry you couldn't make it". It ran the other way too — a note
  // read as "cancelled", landing on someone recorded as SOLD, gave us permission to tell a customer
  // who had just bought a bike that he failed to appear.
  //
  // A finance result or a context note is not a statement about whether someone walked in the door,
  // so it may not overwrite one. The rep's click is ground truth and is carried forward; the new
  // `status` still lands, so the incoming write loses nothing it actually knew.
  //
  // FAIL DIRECTION: preserving an attendance answer is the safe side — the readers
  // (`canAssertMissedAppointment`) only ever ASSERT a miss on a positive answer, so keeping the
  // rep's "missed" can at most keep us honest, while wiping it invents a "showed" nobody recorded.
  if (primaryStatus) record.primaryStatus = primaryStatus;
  else if (existingPrimary) record.primaryStatus = existingPrimary;
  if (secondaryStatus) record.secondaryStatus = secondaryStatus;
  if (note) record.note = note;

  const attendanceBefore = readAppointmentAttendance(input.existing ?? null);
  const attendanceAfter = readAppointmentAttendance(record);
  const attendanceFlipped =
    attendanceBefore !== "unknown" &&
    attendanceAfter !== "unknown" &&
    attendanceBefore !== attendanceAfter;

  // After the carry-forward above, a bare write no longer drops the recorded answer. This stays
  // computed (rather than hard-coded false) so the flag keeps telling the truth if the rule moves.
  const dropsRecordedAttendance = !!existingPrimary && !String(record.primaryStatus ?? "").trim();
  const bareLegacyShape = !primaryStatus;

  let divergence: string | null = null;
  if (dropsRecordedAttendance && attendanceFlipped) {
    divergence = "bare_outcome_write_flips_recorded_attendance";
  } else if (dropsRecordedAttendance) {
    divergence = "bare_outcome_write_drops_recorded_attendance";
  } else if (attendanceFlipped) {
    divergence = "outcome_write_flips_recorded_attendance";
  }

  return {
    record,
    attendanceBefore,
    attendanceAfter,
    attendanceFlipped,
    dropsRecordedAttendance,
    bareLegacyShape,
    divergence,
    why: divergence
      ? `${input.source} overwrote a recorded outcome (${attendanceBefore} -> ${attendanceAfter})`
      : `${input.source} recorded outcome "${status || "(blank)"}"`
  };
}

// ===================================================================================================
// THE MANUAL-OUTBOUND CADENCE RESTART — "when staff's own outreach turns the follow-up chase back on,
// does this lead keep its place in the sequence, or start over at day one?"
//
// WHAT WAS FIGHTING. Three independent places rebuilt `followUpCadence` wholesale when a staff
// action put a lead back on a context-tagged chase:
//
//   activateManualQuoteDeliveredFollowUp   staff texted the customer their quote   (manual_quote_delivered)
//   the credit-app "needs info" handler    staff asked for missing finance docs     (finance_docs)
//   the manual-context prompt              staff picked "seller intake" / "buyer interest"
//
// All three answer the same question — reuse the cadence already on the lead, or lay down a fresh
// day-one one — and two of them answer it one way while the third answers it another.
//
// THE DISAGREEMENT THAT MATTERS (preserved here, NOT fixed here). The quote and finance lanes keep
// a lead's place ONLY when the existing cadence is still ACTIVE and is already running for the SAME
// context. Anything else — a stopped cadence, or one tagged for a different context — is treated as
// finished business and the lead restarts at step 0 with a fresh anchor.
//
// The manual-context prompt keeps the place of ANY cadence that has not COMPLETED. So a lead whose
// chase was stopped at step 9 (manual handoff, a hold, an opt-out reason since cleared) and who
// staff then tag "buyer interest" comes back at step 9, carrying the OLD anchor and the OLD due
// date. Two consequences, both real: the stale due date can be in the past, so the very next
// scheduler tick fires immediately instead of on the day-one ramp staff just asked for; and
// stepIndex 9 is at DISENGAGED_TAPER_AFTER_TOUCHES, so on a lead that never replied
// advanceFollowUpCadence sends ONE touch and then completes the cadence as "disengaged_taper" —
// the buyer-interest chase staff just switched on is over after a single message.
//
// FAIL DIRECTION. Keeping a place we should not keep resumes a lead deep in a sequence and can fire
// an overdue touch immediately — it fails toward MESSAGING a customer. Starting over when we could
// have resumed only costs the lead a few extra days of nurture. So the safe default for anything
// unrecognized is START OVER: `keepPlaceInLine` is false unless a named rule says otherwise.
// ===================================================================================================

export type ManualCadenceRestartContext =
  | "manual_quote_delivered" // staff sent the customer their quote
  | "finance_docs" // staff asked for missing credit-app info
  | "seller_photo_details_request" // manual-context prompt: seller intake
  | "buyer_interest"; // manual-context prompt: buyer interest

/** The lanes that today keep the place of ANY not-completed cadence, whatever it was tagged for. */
const MANUAL_CONTEXT_PROMPT_CONTEXTS = new Set<string>([
  "seller_photo_details_request",
  "buyer_interest"
]);

export type ManualCadenceRestartInput = {
  context: ManualCadenceRestartContext | string;
  /** The cadence already on the lead, exactly as stored. */
  existing?: {
    status?: string | null;
    contextTag?: string | null;
    anchorAt?: string | null;
    nextDueAt?: string | null;
    stepIndex?: number | null;
    scheduleInviteCount?: number | null;
    scheduleMuted?: boolean | null;
  } | null;
  /** Caller-supplied clock — the referee never reads Date.now(). */
  nowIso: string;
};

export type ManualCadenceRestartDecision = {
  /** Resume where the lead left off (anchor + step + due date) instead of restarting at day one. */
  keepPlaceInLine: boolean;
  anchorAt: string;
  stepIndex: number;
  /** Non-null: keep this due date. Null: the caller computes a fresh day-one date from `anchorAt`. */
  keepNextDueAt: string | null;
  /**
   * Carry the OLD cadence record's leftover fields (deferredMessage, lastSentAt/lastSentStep,
   * usedVariants, and the schedule-invite counters) onto the new one. This is the SECOND preserved
   * disagreement: the quote and finance lanes carry them from whatever cadence was there, even one
   * they just decided was finished business; the manual-context prompt only carries them when it
   * kept the lead's place.
   */
  carryExistingRecord: boolean;
  scheduleInviteCount: number;
  scheduleMuted: boolean;
  /** Names the preserved disagreement when this lane is the odd one out for THIS input. */
  divergence: string | null;
  why: string;
};

export function decideManualCadenceRestart(
  input: ManualCadenceRestartInput
): ManualCadenceRestartDecision {
  const context = String(input.context ?? "").trim();
  const existing = input.existing ?? null;
  const now = String(input.nowIso ?? "").trim();
  const status = String(existing?.status ?? "").trim().toLowerCase();
  const existingTag = String(existing?.contextTag ?? "").trim().toLowerCase();

  const promptLane = MANUAL_CONTEXT_PROMPT_CONTEXTS.has(context);
  /**
   * THE ONE RULE, all three lanes (Joe, 2026-08-01: "Start fresh"). Keep a lead's place in the
   * follow-up sequence ONLY when the chase is still running AND running for this same reason.
   *
   * The manual-context prompt used to apply a looser test — "anything that has not completed" — so
   * pressing "Buyer interest" or "Seller intake" inherited the position of a chase that had been
   * STOPPED, or that was running for something else entirely. Two things went wrong with that:
   * the inherited next-touch date could already be in the PAST, so the very next scheduler pass
   * texted the customer immediately instead of walking the day-one ramp; and a lead already nine
   * touches deep sat at the give-up threshold, so the "new" buyer chase sent ONE message and shut
   * itself off. Staff pressing that button mean "chase this lead for THIS reason, now" — which is
   * a fresh day one, exactly as the quote-delivered and credit-app lanes already behaved.
   *
   * FAIL DIRECTION: starting fresh re-anchors the next touch to the day-one offset rather than a
   * stale (possibly past-due) one, so it can only ever DELAY the next proactive message, never
   * fire one sooner. It also restores the full ramp instead of a lead expiring after one send.
   */
  const sameContextActive = !!existing && status === "active" && existingTag === context.toLowerCase();

  const keepPlaceInLine = sameContextActive;
  const carryExistingRecord = promptLane ? keepPlaceInLine : !!existing;

  const anchorAt = keepPlaceInLine ? String(existing?.anchorAt ?? "").trim() || now : now;
  const storedStep = Number(existing?.stepIndex);
  const stepIndex =
    keepPlaceInLine && Number.isFinite(storedStep) ? Math.max(0, storedStep) : 0;
  const keepNextDueAt = keepPlaceInLine
    ? String(existing?.nextDueAt ?? "").trim() || null
    : null;

  const carrySource = carryExistingRecord ? existing : null;
  const scheduleInviteCount = Number.isFinite(Number(carrySource?.scheduleInviteCount))
    ? Number(carrySource?.scheduleInviteCount)
    : 0;
  const scheduleMuted = carrySource?.scheduleMuted === true;

  // The prompt-lane divergence is RULED and gone. What survives is the quote/finance lanes carrying
  // a finished cadence RECORD forward (its invite budget and mute flag) even when they correctly
  // start a fresh day one — a narrower disagreement Joe has not ruled on, so it stays named.
  const divergence =
    !promptLane && !!existing && !sameContextActive
      ? "quote_and_finance_lanes_carry_a_finished_cadence_record_forward"
      : null;

  return {
    keepPlaceInLine,
    anchorAt,
    stepIndex,
    keepNextDueAt,
    carryExistingRecord,
    scheduleInviteCount,
    scheduleMuted,
    divergence,
    why: keepPlaceInLine
      ? `${context}: resumed the existing cadence at step ${stepIndex}`
      : `${context}: started a fresh day-one cadence`
  };
}

// ===================================================================================================
// STARTING A CHASE — "may we lay a brand-new follow-up cadence over this lead right now, and what
// does the new one inherit from the one it replaces?"
//
// WHAT WAS FIGHTING. Three exported entry points in conversationStore build a whole fresh
// `followUpCadence` object, and each one carried its OWN admission test:
//
//   startFollowUpCadence     the day-one ramp (and the long_term variant)   ~25 call sites
//   startPostSaleCadence     the after-the-sale owner sequence               4 call sites
//   scheduleLongTermFollowUp "check back with me in the spring"              8 call sites
//
// They disagree, and the disagreement is not theoretical — several call sites branch straight
// between two of them on the SAME turn:
//
//     if (nearTerm) startFollowUpCadence(conv, now, tz);
//     else          scheduleLongTermFollowUp(conv, untilIso, "future_timeframe");
//
// A lead already six touches into a live chase who says "now" keeps that chase (startFollowUpCadence
// refuses to overwrite one that is active OR stopped). The same lead saying "in the spring" has the
// whole record thrown away and rebuilt at step 0. Same decision point, opposite answers, decided
// only by which branch the turn fell into — the shape that produced #398, #414 and #423.
//
// THE THREE DIVERGENCES, PRESERVED HERE, NOT FIXED HERE:
//
//   1. REPLACING A LIVE CHASE. startFollowUpCadence never does. The other two always do, without
//      looking. For post-sale that is correct and load-bearing — the customer has bought, so the
//      pre-sale chase MUST die — and it is why post-sale is also the one lane that ignores
//      `conv.status === "closed"`: a sold conversation is closed with reason "sold", and refusing
//      to start there would leave every buyer with no owner sequence at all.
//
//   2. THE INVITE BUDGET GOES BACK TO ZERO. All three lanes open the new cadence at
//      `scheduleInviteCount: 0, scheduleMuted: false`. On the two replacing lanes that means a
//      customer who was muted for having already been asked three times "what time works for you?"
//      becomes askable again once the chase is re-shaped.
//
//      RULED 2026-08-02 (readiness loop, hands-off mandate): this is CORRECT, not a defect, and
//      the ruling is written here because the first reading of it was wrong and the next reader
//      will reach for the same wrong fix. Three things had to be checked, and all three say leave
//      it alone:
//        - It adds NO messages. The mute never silences a touch; it swaps that touch's content
//          from the schedule ask to a softer pool. So clearing it cannot fail toward messaging.
//        - It is not even reachable on the lane that clears it. Both replacing lanes produce a
//          cadence of kind `post_sale` or `long_term`, and every schedule-invite content path
//          returns early on exactly those two kinds. The flag is cleared into a state nothing
//          reads.
//        - The only way it surfaces is later, when the engagement bump promotes a `long_term`
//          chase to `engaged` — which happens because THE CUSTOMER CAME BACK. Asking a customer
//          who has just re-engaged months later what time suits them is the right move, not a
//          relapse. The mute means "ignored three asks in THIS chase", and a dated check-back
//          starts a genuinely different one.
//      The divergence is still NAMED on the decision, because the state is worth seeing — but it
//      is named as a known-and-accepted difference, not as work waiting to be done.
//
//   3. THE CLOSED CHECK. Two lanes refuse on a closed conversation, post-sale does not (see 1).
//
// FAIL DIRECTION. Refusing to start is the SAFE answer: a chase that never starts costs the lead
// some nurture, while a chase started wrongly texts a customer who should have been left alone. So
// every unrecognized lane refuses — `start` is false unless a named lane says otherwise.
//
// PURE + CLOCK-FREE: the caller passes the conversation's stored state in and computes the dates
// itself, so this stays sampleable by the decision-equivalence harness.
// ===================================================================================================

export type CadenceStartLane =
  | "standard_ramp" // startFollowUpCadence — the day-one ramp, or its long_term variant
  | "post_sale" // startPostSaleCadence — the after-the-sale owner sequence
  | "deferred_long_term"; // scheduleLongTermFollowUp — a dated "check back with me" touch

/** The lanes that lay a new cadence over one that is still running. See divergence 1 above. */
const CADENCE_START_REPLACING_LANES = new Set<string>(["post_sale", "deferred_long_term"]);

/**
 * Handoff reasons that mean "this lead is not a sales conversation at all" — a job seeker, a B2B
 * vendor pitching the dealership, spam. Chasing one of these with a sales cadence is never right.
 *
 * This is the SAME set `scoringExclusions.isNonSalesConversation` reads (it imports from here), so
 * cadence suppression and tone-scoring exclusion can never drift apart. That drift is exactly how
 * `vendor_inquiry` came to sit in the exclusion list for months while nothing ever wrote it.
 *
 * Until now the hiring lane's cadence suppression was ORDERING LUCK: its ADF branch returns early
 * before the cadence check, and `setFollowUpMode(…,"manual_handoff")` happens to stop an active
 * chase as a side effect. Neither is a ruling, and neither survives a refactor. Asking the referee
 * makes the refusal explicit for every lane and every caller.
 */
export const NON_SALES_CADENCE_REASONS = new Set<string>([
  "hiring_manager_inquiry",
  "vendor_inquiry",
  "spam"
]);

export type CadenceStartInput = {
  lane: CadenceStartLane | string;
  /** `conv.status`. "closed" means the thread is finished. */
  conversationStatus?: string | null;
  /** The cadence already on the lead, exactly as stored. Absent/blank status = no cadence at all. */
  existing?: {
    status?: string | null;
    scheduleInviteCount?: number | null;
    scheduleMuted?: boolean | null;
  } | null;
  /**
   * post_sale only: has this lead actually bought? (`closedReason === "sold" || sale.soldAt`).
   * The caller resolves it because the two source fields live in different places on the record.
   */
  sold?: boolean | null;
  /**
   * `conv.followUp?.reason` exactly as stored. A recognized non-sales class
   * (`NON_SALES_CADENCE_REASONS`) refuses every customer-chase lane. Absent/unknown = ordinary
   * sales lead, so a caller that forgets to pass it gets today's behavior, not silence.
   */
  followUpReason?: string | null;
};

export type CadenceStartDecision = {
  /** Lay down the new cadence. False means the caller returns without touching the record. */
  start: boolean;
  /** True when this start is throwing away a cadence that is still running. Divergence 1. */
  replacesActiveCadence: boolean;
  /** Invite budget the new cadence opens with. Today always fresh — divergence 2. */
  scheduleInviteCount: number;
  scheduleMuted: boolean;
  /** Names the preserved disagreement when this lane is the odd one out for THIS input. */
  divergence: string | null;
  why: string;
};

// === Burned-ladder realign referee (2026-08-02) =================================================
// Dennis Daffron (+16303628805), a day-one hot out-of-state buyer choosing between dealers: staff
// texted him ten times on 2026-07-23 and every manual send consumed a follow-up ladder step, so
// stepIndex marched 0 -> 9 of 13 in a single afternoon. Step 9 is the 45-day offset, which parked
// his next automated touch on Sept 5 — right after he told us "I should have a decision soon."
//
// The SOURCE bug is already fixed: 86e3ec79 (Joe ruling 2026-07-23) removed the manual-send
// advance hook, so no new cadence can be burned this way. What that fix could not do is repair the
// records already damaged, and a burned ladder is invisible — the cadence looks perfectly healthy,
// it is just pointing at a step the calendar has not earned. Measured on the live store 2026-08-02:
// 2 of 66 active standard/engaged cadences are still stranded (+16303628805, +16813891971), both at
// step 9 with a September due date.
//
// The referee is the ONE place that judges whether a ladder position is consistent with elapsed
// time. It only ever moves a cadence BACK onto the rung the calendar has actually reached; it never
// sends anything, and the value gate + no-repeat guards still decide whether that touch has content
// worth sending. Scoped to the standard/engaged ladders — long_term and post_sale cadences sit
// months out BY DESIGN and must never be "corrected".
//
// FAIL DIRECTION: an unrealigned cadence is a live lead parked months out (the damage); a
// realigned one is a lead back on its normal schedule, still value-gated. Tolerance of +1 keeps the
// currently-pending step legitimate, so a healthy ladder is never touched, and the result is
// idempotent — after a realign the position is consistent and the referee declines to act again.

export type BurnedLadderInput = {
  status?: string | null;
  kind?: string | null;
  stepIndex?: number | null;
  /** Whole days elapsed since the cadence anchor. Null/negative = no usable anchor. */
  ageDays?: number | null;
  /** The ladder this cadence kind runs on (FOLLOW_UP_DAY_OFFSETS for standard/engaged). */
  ladderOffsets: number[];
  conversationClosed: boolean;
  /** A live pause (manual-outbound breather, event hold) owns the schedule — leave it alone. */
  pausedInFuture: boolean;
};

export type BurnedLadderDecision = {
  realign: boolean;
  /** The rung elapsed time actually justifies. Only set when realign is true. */
  stepIndex?: number;
  why: string;
};

export function decideBurnedCadenceLadderRealign(input: BurnedLadderInput): BurnedLadderDecision {
  if (String(input?.status ?? "").trim() !== "active") return { realign: false, why: "cadence_not_active" };
  const kind = String(input?.kind ?? "").trim().toLowerCase();
  // long_term / post_sale ladders legitimately run months out — never "correct" them.
  if (kind !== "standard" && kind !== "engaged") return { realign: false, why: "kind_not_ladder_scoped" };
  if (input.conversationClosed) return { realign: false, why: "conversation_closed" };
  if (input.pausedInFuture) return { realign: false, why: "pause_owns_the_schedule" };
  const offsets = Array.isArray(input.ladderOffsets) ? input.ladderOffsets : [];
  if (!offsets.length) return { realign: false, why: "no_ladder" };
  // Explicit null/undefined check FIRST: Number(null) is 0, which would read a missing anchor as
  // "day zero" and clamp a live cadence to the first rung — due immediately. Never infer an anchor.
  if (input.ageDays === null || input.ageDays === undefined) return { realign: false, why: "no_anchor" };
  const ageDays = Number(input.ageDays);
  if (!Number.isFinite(ageDays) || ageDays < 0) return { realign: false, why: "no_anchor" };
  const stepIndex = Number(input.stepIndex ?? 0);
  if (!Number.isFinite(stepIndex) || stepIndex <= 0) return { realign: false, why: "ladder_at_start" };
  // The rung elapsed time has actually earned: every offset that has already come due.
  const justified = offsets.filter(offset => Number(offset) <= ageDays).length;
  // +1 tolerance: the step currently PENDING is legitimately one ahead of what has fired.
  if (stepIndex <= justified + 1) return { realign: false, why: "ladder_consistent_with_elapsed_time" };
  return { realign: true, stepIndex: justified, why: "ladder_burned_ahead_of_elapsed_time" };
}

export function decideCadenceStart(input: CadenceStartInput): CadenceStartDecision {
  const lane = String(input.lane ?? "").trim();
  const conversationClosed =
    String(input.conversationStatus ?? "").trim().toLowerCase() === "closed";
  const existingStatus = String(input.existing?.status ?? "").trim().toLowerCase();
  const hasActiveCadence = existingStatus === "active";
  // startFollowUpCadence refuses on "stopped" too: someone or something deliberately ended that
  // chase, and quietly reviving it is the fail-unsafe direction.
  const hasCadenceRecord = hasActiveCadence || existingStatus === "stopped";
  const followUpReason = String(input.followUpReason ?? "").trim().toLowerCase();
  const nonSalesLead = NON_SALES_CADENCE_REASONS.has(followUpReason);

  let start: boolean;
  let why: string;
  switch (lane) {
    case "standard_ramp":
      start = !conversationClosed && !hasCadenceRecord && !nonSalesLead;
      why = start
        ? "standard_ramp: no cadence on the lead — started the day-one ramp"
        : conversationClosed
          ? "standard_ramp: refused — the conversation is closed"
          : nonSalesLead
            ? `standard_ramp: refused — this lead is a non-sales class (${followUpReason})`
            : `standard_ramp: refused — a ${existingStatus} cadence already owns this lead`;
      break;
    case "post_sale":
      // No closed check on purpose: a sold conversation IS closed (reason "sold").
      // No non-sales check on purpose either: this lane is already gated on an actual sale, and a
      // vendor/job-seeker never sells. Adding one here would only risk the load-bearing divergence
      // above for no reachable case.
      start = input.sold === true;
      why = start
        ? "post_sale: the lead bought — started the owner sequence"
        : "post_sale: refused — nothing on this lead says it sold";
      break;
    case "deferred_long_term":
      start = !conversationClosed && !nonSalesLead;
      why = start
        ? "deferred_long_term: scheduled the dated check-back touch"
        : conversationClosed
          ? "deferred_long_term: refused — the conversation is closed"
          : `deferred_long_term: refused — this lead is a non-sales class (${followUpReason})`;
      break;
    default:
      start = false;
      why = `unrecognized cadence-start lane "${lane}" — refused`;
      break;
  }

  const replacesActiveCadence = start && hasActiveCadence && CADENCE_START_REPLACING_LANES.has(lane);

  // Divergence 2, named but NOT yet acted on: the two replacing lanes wipe a live chase's invite
  // budget, so a customer already muted for over-asking becomes askable again. Preserved exactly.
  const mutedCadenceReplaced = replacesActiveCadence && input.existing?.scheduleMuted === true;

  return {
    start,
    replacesActiveCadence,
    scheduleInviteCount: 0,
    scheduleMuted: false,
    divergence: mutedCadenceReplaced
      ? "replacing_lane_reopens_a_muted_schedule_invite_budget"
      : null,
    why
  };
}

// MAY THIS TRIGGER REPLACE THE CHASE ALREADY RUNNING, AND WITH WHAT TEMPO — one referee for what
// were four independent answers.
//
// WHY THIS IS NOT `decideCadenceStart`. That referee guards the three exported ENTRY POINTS
// (`startFollowUpCadence`, `startPostSaleCadence`, `scheduleLongTermFollowUp`) and its
// `standard_ramp` lane REFUSES outright when any cadence record exists, active or stopped. The
// four sites below never go through those entry points: each MINTS the whole
// `conv.followUpCadence` object itself, so `decideCadenceStart`'s refusal never applies to them.
// Two philosophies in one field. They are named here side by side rather than merged, because
// merging them would be a behavior change and this is a behavior-PRESERVING un-stacking.
//
// THE THREE PRESERVED DIVERGENCES:
//   1. ADMISSION. Three of the four (`finance_declined`, `license_credit_pending`,
//      `seller_photo_details_request`) test the running chase not at all — they overwrite whatever
//      is there, including a `stopped` cadence somebody deliberately ended, which is exactly what
//      `decideCadenceStart` refuses to do. Only `over_eager_engaged_realign` looks at the record
//      first, and it is the odd one out because it is a HEALER: it exists to downshift a chase, so
//      it has to know which chase it is downshifting.
//   2. THE INVITE BUDGET. `finance_declined` alone omits `scheduleInviteCount` / `scheduleMuted`
//      from the record entirely, where the other three write 0 / false. Every reader coalesces
//      (`cad.scheduleInviteCount ?? 0`, and an absent `scheduleMuted` is falsy), so today the two
//      shapes behave the same — but they are not the same STORED record, so the omission is
//      preserved exactly rather than tidied into a uniform shape.
//   3. THE ANCHOR. `license_credit_pending` anchors the cadence at its own FUTURE due date; every
//      other lane anchors at the clock read. `anchorAt` is what the ladder-age math reads, and a
//      future anchor makes `ageDays` negative, which `decideBurnedCadenceLadderRealign` treats as
//      "no_anchor" and declines to touch. So that lane is exempt from ladder realignment for as
//      long as its anchor is in the future — the fewer-corrections direction, so preserved.
//
// FAIL DIRECTION. Every `replace: true` here throws away a chase and lays a new one, which can
// only ever START proactive texting. So an unrecognized trigger is REFUSED rather than waved
// through: a caller that forgets to register its lane loses a cadence, it never gains one.
//
// PURE + CLOCK-FREE: the caller supplies the anchor and timezone to the applier; this decides only
// whether the replacement happens and what shape the record takes.

export type CadenceReplacementTrigger =
  | "finance_declined" // a finance call came back not-approved — restart on the slow nurture
  | "license_credit_pending" // staff note: licence + credit app pending — check back on a date
  | "seller_photo_details_request" // manual outbound asked a seller for photos/details
  | "over_eager_engaged_realign"; // heal a chase bumped to `engaged` against the lead's own timeline

export type CadenceReplacementInput = {
  trigger: CadenceReplacementTrigger | string;
  /** The chase already on the lead, exactly as stored. Absent = nothing to replace. */
  existing?: { status?: string | null; kind?: string | null } | null;
  /**
   * Realign lane only — the rest ignore every field below. The lead's OWN structured purchase
   * timeframe caps the tempo to long_term (`cadenceTempoCappedToLongTerm`), computed by the caller
   * so this stays a pure data decision.
   */
  tempoCappedToLongTerm?: boolean;
  /** Realign lane only: closed, sold, or already booked in — all three end the healing. */
  conversationClosed?: boolean;
  appointmentBooked?: boolean;
  /** Realign lane only: `followUp.mode` and `followUp.reason`, exactly as stored. */
  followUpMode?: string | null;
  followUpReason?: string | null;
  /** Realign lane only: the lead is holding for an inventory watch, which owns its own tempo. */
  hasInventoryWatch?: boolean;
};

export type CadenceReplacementDecision = {
  /** Mint a fresh cadence record over whatever is there. False = leave the lead alone. */
  replace: boolean;
  /** Tempo of the minted chase. Only set when `replace`. */
  kind?: "engaged" | "long_term";
  /** Which day-offset ladder the first due date comes off. Only set when `replace`. */
  ladder?: "standard" | "long_term" | "finance_declined";
  /**
   * `now` = anchor at the applier's clock read and compute the due date off the ladder.
   * `due` = anchor at the caller's own precomputed due date and use it verbatim (divergence 3).
   */
  anchor?: "now" | "due";
  /** Whether the minted record carries `scheduleInviteCount` / `scheduleMuted` (divergence 2). */
  writeInviteBudget?: boolean;
  /** Whether the minted record carries the caller's `contextTag` / `contextTagUpdatedAt`. */
  writeContextTag?: boolean;
  /** Names the preserved disagreement when this lane is the odd one out for THIS input. */
  divergence: string | null;
  why: string;
};

/** The per-lane record shape, preserved exactly as each site wrote it inline. */
const CADENCE_REPLACEMENT_SHAPES: Record<
  CadenceReplacementTrigger,
  Required<Pick<CadenceReplacementDecision, "kind" | "ladder" | "anchor" | "writeInviteBudget" | "writeContextTag">>
> = {
  finance_declined: {
    kind: "long_term",
    ladder: "finance_declined",
    anchor: "now",
    writeInviteBudget: false,
    writeContextTag: false
  },
  license_credit_pending: {
    kind: "engaged",
    ladder: "standard",
    anchor: "due",
    writeInviteBudget: true,
    writeContextTag: true
  },
  seller_photo_details_request: {
    kind: "engaged",
    ladder: "standard",
    anchor: "now",
    writeInviteBudget: true,
    writeContextTag: true
  },
  over_eager_engaged_realign: {
    kind: "long_term",
    ladder: "long_term",
    anchor: "now",
    writeInviteBudget: true,
    writeContextTag: false
  }
};

/** Modes that own the schedule outright — the healer must not touch a chase a human is holding. */
const CADENCE_REALIGN_BLOCKING_MODES = new Set(["manual_handoff", "paused_indefinite", "holding_inventory"]);

export function decideCadenceReplacement(input: CadenceReplacementInput): CadenceReplacementDecision {
  const trigger = String(input?.trigger ?? "").trim() as CadenceReplacementTrigger;
  const shape = CADENCE_REPLACEMENT_SHAPES[trigger];
  if (!shape) {
    return { replace: false, divergence: null, why: `unrecognized cadence-replacement trigger "${trigger}" — refused` };
  }
  const existingStatus = String(input.existing?.status ?? "").trim().toLowerCase();
  const existingKind = String(input.existing?.kind ?? "").trim().toLowerCase();

  if (trigger === "over_eager_engaged_realign") {
    // The healer's own admission test, the only one of the four that reads the running chase.
    let refusal: string | null = null;
    if (existingStatus !== "active" || existingKind !== "engaged") refusal = "no active engaged chase to downshift";
    else if (input.tempoCappedToLongTerm !== true) refusal = "the lead's own timeframe does not cap the tempo";
    else if (input.conversationClosed === true) refusal = "the conversation is closed or sold";
    else if (input.appointmentBooked === true) refusal = "the lead is already booked in";
    else if (CADENCE_REALIGN_BLOCKING_MODES.has(String(input.followUpMode ?? "").trim())) {
      refusal = `a ${String(input.followUpMode).trim()} thread owns its own schedule`;
    } else if (String(input.followUpReason ?? "").trim() === "inventory_watch" || input.hasInventoryWatch === true) {
      refusal = "an inventory watch owns this lead's tempo";
    }
    if (refusal) return { replace: false, divergence: null, why: `over_eager_engaged_realign: refused — ${refusal}` };
    return {
      replace: true,
      ...shape,
      divergence: null,
      why: "over_eager_engaged_realign: re-anchored an over-eager engaged chase onto the long_term nurture"
    };
  }

  // The other three lanes: their trigger conditions live upstream (the finance signal, the note's
  // own cues, `maybeStartCadence`'s early returns) and are about the EVENT, not the chase. Nothing
  // here tests the running cadence at all — divergence 1, preserved.
  const overwritesADeliberateStop = existingStatus === "stopped";
  return {
    replace: true,
    ...shape,
    divergence: overwritesADeliberateStop ? "replaces_a_deliberately_stopped_chase" : null,
    why: overwritesADeliberateStop
      ? `${trigger}: replaced a stopped chase — this lane does not ask whether the last one was ended on purpose`
      : `${trigger}: laid a fresh ${shape.kind} chase over whatever was running`
  };
}

// ===================================================================================================
// MARKING AN APPOINTMENT CONFIRMED — "when we stamp an appointment `confirmed`, what else does the
// record get: is the customer's word on file (`acknowledged`), and does the reschedule latch clear?"
//
// WHAT WAS FIGHTING. Three independent places stamp `appointment.status = "confirmed"`, each
// deciding the companion fields for itself:
//
//   confirmAppointmentIfMatchesSuggested   customer's TEXT matched a slot we suggested — no
//     (conversationStore, 3 branches)      calendar write happens here
//   the confirm-book path (index.ts)       customer's ack booked a real calendar event
//   the voice post-summary path (index.ts) a rep's call produced an exact slot; calendar booked
//
// `decideCustomerAckConfirmBooking` (above) already referees WHETHER that booking turn happens.
// Nobody refereed what the confirmed RECORD contains — and the three writers disagree:
//
//   DIVERGENCE 1 — `acknowledged`. The two booked lanes set it TRUE; the slot-match lane sets it
//     FALSE. `acknowledged` is what suppresses the automatic 24h "Reply YES to confirm or NO to
//     reschedule" reminder (transitionSafety.shouldSuppressAppointmentConfirmationReminder — the
//     Peter Meredith "boomed him" ruling, 2026-07-20). This split is CORRECT and load-bearing, and
//     the reason is the calendar: the booked lanes have a real event the customer just agreed to,
//     so the robotic reminder would re-ask what was just answered. The slot-match lane has NO
//     calendar event yet — its confirm is provisional, the booking happens downstream, and if the
//     record were pre-acknowledged the reminder for the eventual real booking would be suppressed
//     by a stamp made before that booking existed. Fail direction: acknowledged=false only ever
//     means ONE extra reminder; acknowledged=true wrongly means a customer who half-committed
//     never gets nudged and no-shows.
//
//   DIVERGENCE 2 — the `reschedulePending` latch. The two booked lanes CLEAR it; the slot-match
//     lane leaves it standing. So a lead mid-reschedule whose text matches a suggested slot ends
//     up `confirmed` WITH `reschedulePending=true` — a contradiction two downstream guards already
//     carry local armor against (the stale-latch comments at index.ts ~55689 and ~62982 exist
//     because this state occurs). Preserved EXACTLY here (this is a cleanup, not a fix): named on
//     the decision as `divergence` so the follow-up ruling has an anchor.
//
// All three lanes agree on `confirmedBy: "customer"` — even the voice lane, where a human books
// the calendar but the TIME is the customer's own words from the call.
//
// FAIL DIRECTION. Refusing to stamp is the SAFE answer: an unconfirmed appointment costs at most a
// re-ask, while a wrong confirm tells the customer "you're all set" for a slot nothing holds. An
// unrecognized lane therefore refuses, and the caller must not write.
//
// PURE + CLOCK-FREE: the caller passes the stored latch state in; dates/slots stay caller-side.
// ===================================================================================================

// ---------------------------------------------------------------------------------------------
// SECOND SLICE (2026-08-04) — the two STAFF writers that were patching the referee's answer up
// afterwards. Same question ("what does the confirmed record contain"), two more askers:
//
//   DIVERGENCE 3 — the manual-outbound slot match (index.ts, reconcileManualOutboundState) called
//     this referee on the `customer_slot_match` lane and then, three lines later, overwrote both of
//     its answers: `confirmedBy` "customer" -> "salesperson" and `acknowledged` false -> true. The
//     lane name was simply wrong for that caller — the text being matched is the REP'S OWN outbound,
//     not the customer's. RULED: the manual path's answer stands, as its own lane. Crediting the
//     customer for words a salesperson typed is false on its face, and a human pressed send on a
//     message naming that slot, so the automatic "Reply YES to confirm" re-ask is exactly the
//     robotic double-text Joe ruled against on 2026-07-20. Note this is the OPPOSITE call to
//     divergence 1, and deliberately: divergence 1 is about a CUSTOMER half-committing with nobody
//     watching the thread; here a member of staff is on it. The latch is still left alone — no
//     calendar event was written on this path either.
//
//   DIVERGENCE 4 — none. `markAppointmentAcknowledged` (fired after every manual send) already
//     agreed with the referee: it only ever stamps `acknowledged` on a record that is ALREADY
//     `confirmed`, which is the same "a human is handling this thread" reasoning. It asks now
//     rather than deciding for itself, and it is the one lane that leaves `confirmedBy` untouched
//     — it says nothing about who confirmed, only that staff are on the thread.
// ---------------------------------------------------------------------------------------------

export type AppointmentConfirmLane =
  | "customer_slot_match" // customer's text matched a suggested slot — record only, no calendar yet
  | "customer_confirm_booking" // customer's ack booked the calendar event
  | "voice_summary_booking" // rep's call summary booked the calendar event
  | "salesperson_manual_booking" // the REP’S own outbound settled the time — no calendar event
  | "salesperson_manual_send"; // any manual send, on a record already confirmed

/** The lanes whose confirm carries a REAL calendar event. See divergences 1 and 2 above. */
const APPOINTMENT_CONFIRM_BOOKED_LANES = new Set<string>([
  "customer_confirm_booking",
  "voice_summary_booking"
]);

export type AppointmentConfirmRecordInput = {
  lane: AppointmentConfirmLane | string;
  /** The stored `appointment.reschedulePending` latch, exactly as it is right now. */
  reschedulePending?: boolean | null;
  /** The stored `appointment.status`, for lanes that may only stamp an already-confirmed record. */
  currentStatus?: string | null;
  /** The stored `appointment.acknowledged`, so a lane can decline to re-stamp what is already set. */
  currentAcknowledged?: boolean | null;
};

export type AppointmentConfirmRecordDecision = {
  /** Stamp the record. False means the caller must not write anything. */
  confirm: boolean;
  status: "confirmed";
  /** Who gets the credit. `null` means LEAVE THE EXISTING CREDIT ALONE — this lane has no view. */
  confirmedBy: "customer" | "salesperson" | null;
  /** Customer's word on file — suppresses the 24h YES/NO reminder. Booked lanes only. */
  acknowledged: boolean;
  /** Clear the reschedule latch alongside the confirm. Booked lanes only (divergence 2). */
  clearReschedulePending: boolean;
  /** Names the preserved disagreement when this lane is the odd one out for THIS input. */
  divergence: string | null;
  why: string;
};

export function decideAppointmentConfirmRecord(
  input: AppointmentConfirmRecordInput
): AppointmentConfirmRecordDecision {
  const lane = String(input.lane ?? "").trim();
  const booked = APPOINTMENT_CONFIRM_BOOKED_LANES.has(lane);
  const latched = input.reschedulePending === true;

  // Divergence 3: a salesperson's own outbound matched a slot we suggested. No calendar event, so
  // the latch is left standing exactly as the customer slot-match lane leaves it — but a human is
  // demonstrably on this thread, so the credit is theirs and the robotic re-ask stays off.
  if (lane === "salesperson_manual_booking") {
    return {
      confirm: true,
      status: "confirmed",
      confirmedBy: "salesperson",
      acknowledged: true,
      clearReschedulePending: false,
      divergence: latched ? "slot_match_confirm_leaves_the_reschedule_latch_standing" : null,
      why:
        "salesperson_manual_booking: a rep's own send settled the time — their confirm, no calendar " +
        "event, and the automatic YES/NO re-ask stays off while staff are on the thread"
    };
  }

  // Divergence 4 (agreement): a manual send only tells us staff are handling this thread. It may
  // put the customer's word on file for a record that is ALREADY confirmed, and it says nothing
  // about who confirmed it, so the existing credit is left untouched.
  if (lane === "salesperson_manual_send") {
    const alreadyConfirmed = String(input.currentStatus ?? "") === "confirmed";
    const alreadyAcknowledged = input.currentAcknowledged === true;
    return {
      confirm: alreadyConfirmed && !alreadyAcknowledged,
      status: "confirmed",
      confirmedBy: null,
      acknowledged: true,
      clearReschedulePending: false,
      divergence: null,
      why: !alreadyConfirmed
        ? "salesperson_manual_send: nothing is confirmed yet — a manual send must not stamp one into existence"
        : alreadyAcknowledged
          ? "salesperson_manual_send: already acknowledged — nothing to restamp"
          : "salesperson_manual_send: staff are on this confirmed thread, so the automatic re-ask stands down"
    };
  }

  const recognized = booked || lane === "customer_slot_match";

  return {
    confirm: recognized,
    status: "confirmed",
    confirmedBy: "customer",
    acknowledged: booked,
    clearReschedulePending: booked,
    // Divergence 2, named but NOT acted on: a slot-match confirm on a lead whose reschedule latch
    // is set leaves the record saying "confirmed" AND "reschedule pending" at once.
    divergence:
      recognized && !booked && latched
        ? "slot_match_confirm_leaves_the_reschedule_latch_standing"
        : null,
    why: !recognized
      ? `unrecognized appointment-confirm lane "${lane}" — refused, nothing may be stamped`
      : booked
        ? `${lane}: confirmed against a real calendar event — customer's word on file, latch cleared`
        : `${lane}: provisional confirm from the customer's text — no calendar event yet, so the ` +
          "reminder stays armed and the latch is left as-is"
  };
}

// ===================================================================================================
// A CALENDAR WRITE JUST PUT A REAL EVENT ON THIS LEAD'S BOOKS — "what does the appointment record
// become?"
//
// The sibling question to `decideAppointmentConfirmRecord` above, and a DIFFERENT one. That referee
// owns the three lanes where a CONVERSATION TURN stamps `confirmed`. This one owns every place that
// writes a real Google event and then writes the record:
//
//   POST /scheduler/book                 the booking widget — the customer picked one of our slots
//   POST /public/booking/book            the public booking link we text a lead
//   POST /conversations/:id/appointment  the console — a salesperson books the lead in by hand
//   (manual outbound send)               staff texted a time; we book the lead in behind the message
//   PATCH /calendar/events/:cal/:event   staff EDITED the event straight on the calendar
//
// WHAT WAS FIGHTING. All five ran their own hand-maintained block of the same field writes, and the
// lists had drifted apart. They agree on status/whenText/whenIso/updatedAt and the reschedule latch.
// They disagree on four things:
//
//   DIVERGENCE 1 — the `reschedulePending` latch. **FIXED 2026-08-02; all three lanes now clear
//     it.** The staff lane always did; the two customer lanes left it standing. That latch is what
//     routes a lead's NEXT message into the reschedule arm (pendingRescheduleCarriesTurnIntent, and
//     the regen twin at index.ts ~55663), so a lead who was mid-reschedule and then booked a new
//     time through the public link stayed flagged as owing a rebook: her next message carrying any
//     time-ish word could be answered as "let's find you another time" for the appointment she JUST
//     made. Two downstream guards already carried local armor against exactly this "confirmed AND
//     reschedule-pending" contradiction (the stale-latch comments at index.ts ~55689 and ~62982),
//     which is how we knew it had been hit. The principle was already settled by the sibling referee
//     `decideAppointmentConfirmRecord`: a lane holding a REAL calendar event clears the latch, and
//     "leave it standing" belongs to the provisional slot-match lane that has no event yet. All
//     three of these hold an event. PR #455 preserved the split (a cleanup must not change an
//     answer); this is the follow-up fix. Ruling 4 in the joe-autonomous-rulings ledger.
//
//   DIVERGENCE 2 — `matchedSlot`. The staff lane records the slot it booked; the two customer lanes
//     do not, so their record cannot say which salesperson/calendar window was taken. Lower stakes
//     (a breadcrumb, not something we assert to a customer). Also preserved and named.
//
//   DIVERGENCE 3 — does the lane STAMP `confirmedBy` at all? The three endpoint lanes do. The two
//     lanes joining here (2026-08-04) leave whatever is already on file untouched. That is not
//     cosmetic: `confirmedBy` is what `decideAppointmentAttribution` reads when nobody handed it an
//     explicit actor, and `kpiAnalytics` turns it into the appointment-SETTER label (salesperson vs
//     ai_sms). Both joining lanes call `setAppointmentBookedBy` explicitly, so attribution is
//     already answered for them — but stamping `confirmedBy` anyway would move a reported number.
//     PRESERVED and named; changing a business figure is not a cleanup's call.
//
//   DIVERGENCE 4 — does the lane put the customer's word on file (`acknowledged`)? Every lane that
//     CREATES an event does: the customer or the rep chose that time, so the robotic 24h "Reply YES
//     to confirm" reminder would re-ask what was just settled. `staff_calendar_edit` does NOT touch
//     it, because staff dragging an event to a new hour is not the customer agreeing to the new
//     hour. PRESERVED. Traced to its consumer before preserving:
//     `shouldSuppressAppointmentConfirmationReminder` (transitionSafety.ts) is the only thing that
//     reads it, and leaving it alone is the fail-SAFE half — an unacknowledged appointment still
//     gets its reminder. (The other half IS a real gap: a customer who acknowledged the OLD time
//     stays acknowledged after staff move it, so she is never re-asked about the new one. That is a
//     behavior FIX, not a centralization, and belongs in its own PR.)
//
// FAIL DIRECTION. Refusing to stamp is the SAFE answer: an unrecorded booking costs a re-ask, while
// a wrong "confirmed" tells a customer they are on the calendar when nothing holds the slot. An
// unrecognized lane therefore refuses and the caller must not write.
//
// PURE + CLOCK-FREE: times, slots and event ids stay caller-side; this decides only the SHAPE.
// ===================================================================================================

export type AppointmentBookingLane =
  | "scheduler_widget_booking" // POST /scheduler/book — customer picked a suggested slot
  | "public_link_booking" // POST /public/booking/book — customer used the public booking link
  | "staff_console_booking" // POST /conversations/:id/appointment — a salesperson booked it
  | "manual_outbound_schedule_booking" // staff texted a time; we book the event behind the send
  | "staff_calendar_edit" // PATCH /calendar/events/:calendarId/:eventId — staff moved the event
  // The four CONVERSATION-TURN lanes, joined 2026-08-05. These are the seven hand-maintained copies
  // that lived inside the inbound handler: the customer said something this turn that put a real
  // calendar event on the books. They differ from the five above in that nobody clicked anything —
  // the booking rides out of a text message.
  | "customer_turn_reschedule_move" // customer confirmed a new time; we MOVED the existing event
  | "customer_turn_exact_slot_move" // ...and the exact-slot arm, which also records who owns the calendar
  | "customer_turn_slot_autobook" // customer picked one of our suggested slots; we CREATED the event
  | "customer_turn_matched_slot_book"; // the slot was already matched onto the record; just book it

/**
 * Lanes that leave `confirmedBy` exactly as they found it (divergence 3, and divergence 6 for the
 * conversation-turn arrival). The first two hand attribution in themselves via
 * `setAppointmentBookedBy`, so stamping here would only move the KPI setter label. The third does
 * not touch it because the time it is booking was already agreed and already attributed — this lane
 * only turns a matched slot into a real event.
 */
const APPOINTMENT_BOOKING_LANES_KEEPING_CONFIRMED_BY = new Set<string>([
  "manual_outbound_schedule_booking",
  "staff_calendar_edit",
  "customer_turn_matched_slot_book"
]);

/**
 * DIVERGENCE 5, PRESERVED — who records the slot that was taken. Explicit rather than "every staff
 * lane", because one conversation-turn lane records it too: `customer_turn_slot_autobook` books the
 * slot the customer chose off our own suggestion list, so the slot IS the booking's provenance.
 * The other three conversation-turn lanes do not, matching the two console customer lanes.
 */
const APPOINTMENT_BOOKING_LANES_RECORDING_MATCHED_SLOT = new Set<string>([
  "staff_console_booking",
  "manual_outbound_schedule_booking",
  "staff_calendar_edit",
  "customer_turn_slot_autobook"
]);

/**
 * DIVERGENCE 7, PRESERVED — the lane that stamps `confirmed` with NO fresh hour. It books a slot
 * already sitting on the record (`appointment.matchedSlot`), so `whenIso`/`whenText` are already
 * right and rewriting them would be a change, not a centralization. Every other creating lane
 * carries its own time. Kept separate from the edit lane's `hasBookedTime` rule, which is the
 * opposite case: staff recolouring an event must NOT restamp `confirmed`.
 */
const APPOINTMENT_BOOKING_LANES_STATUS_WITHOUT_TIME = new Set<string>([
  "customer_turn_matched_slot_book"
]);

/**
 * DIVERGENCE 8, PRESERVED — the one lane that also writes WHOSE calendar holds the event
 * (`bookedSalespersonName` / `bookedCalendarId`). The exact-slot move arm has both to hand because
 * it had to resolve the salesperson to move the event; the others carry only an id. Extra
 * breadcrumbs, never asserted to a customer.
 */
const APPOINTMENT_BOOKING_LANES_STAMPING_SALESPERSON_IDENTITY = new Set<string>([
  "customer_turn_exact_slot_move"
]);

/**
 * DIVERGENCE 9, PRESERVED — what a MISSING event id means. The lanes that CREATE an event clear a
 * missing id to null, so no stale event survives a failed create. The lanes that MOVE an existing
 * event fall back to what they already hold: the event is still there, and nulling it would lose the
 * booking we just moved. The caller computes the fallback (it is the only one that knows the old id);
 * this flag says whether a still-missing value becomes `null` or is written through untouched.
 */
const APPOINTMENT_BOOKING_LANES_PRESERVING_MISSING_EVENT = new Set<string>([
  "customer_turn_reschedule_move",
  "customer_turn_exact_slot_move"
]);

/**
 * The one lane that EDITS an event someone else created. It owns its booked-event ids field by
 * field (it patches only what the calendar actually returned, rather than clearing to null), and it
 * never claims the customer acknowledged the new time. See divergences 3 and 4.
 */
const APPOINTMENT_BOOKING_EDIT_LANE = "staff_calendar_edit";

/** The lanes the CUSTOMER drives. See `confirmedBy` above — an input, not a disagreement. */
const APPOINTMENT_BOOKING_CUSTOMER_LANES = new Set<string>([
  "scheduler_widget_booking",
  "public_link_booking",
  "customer_turn_reschedule_move",
  "customer_turn_exact_slot_move",
  "customer_turn_slot_autobook",
  "customer_turn_matched_slot_book"
]);

/** The conversation-turn arrivals, kept nameable so the divergences below can single them out. */
const APPOINTMENT_BOOKING_CONVERSATION_TURN_LANES = new Set<string>([
  "customer_turn_reschedule_move",
  "customer_turn_exact_slot_move",
  "customer_turn_slot_autobook",
  "customer_turn_matched_slot_book"
]);

export type AppointmentBookingRecordInput = {
  lane: AppointmentBookingLane | string;
  /** The stored `appointment.reschedulePending` latch, exactly as it is right now. */
  reschedulePending?: boolean | null;
  /** Does the caller HAVE a slot to record? Only used to name divergence 2 honestly. */
  hasMatchedSlot?: boolean;
  /**
   * Does this call carry a TIME to put on the record? Only the edit lane can arrive without one —
   * staff recolouring or retitling an event changes no hour, and must not restamp `confirmed`.
   * Every creating lane always has one, so this input cannot move their answer.
   */
  hasBookedTime?: boolean;
};

export type AppointmentBookingRecordDecision = {
  /** Stamp the record. False means the caller must not write anything. */
  record: boolean;
  status: "confirmed";
  confirmedBy: "customer" | "salesperson";
  /** Customer's word on file — suppresses the 24h YES/NO confirmation reminder. */
  acknowledged: boolean;
  /** Write whenIso + whenText. False on a metadata-only calendar edit (no hour moved). */
  stampBookedTime: boolean;
  /**
   * Write `status = "confirmed"`. Identical to `stampBookedTime` for every lane except
   * `customer_turn_matched_slot_book`, which confirms a slot already on the record and so has no
   * fresh hour to write. See divergence 7.
   */
  stampStatus: boolean;
  /** Write `bookedSalespersonName` + `bookedCalendarId` too. One lane only — see divergence 8. */
  stampBookedSalespersonIdentity: boolean;
  /**
   * A missing booked-event id/link becomes `null` (a create that failed leaves nothing stale) rather
   * than being written through as the caller handed it in (a move keeps the event it already has).
   * See divergence 9.
   */
  clearMissingBookedEvent: boolean;
  /** Write `confirmedBy` at all. False on the two lanes that hand attribution in (divergence 3). */
  stampConfirmedBy: boolean;
  /** Put the customer's word on file. False on the staff calendar edit (divergence 4). */
  stampAcknowledged: boolean;
  /** Own the booked-event ids. False on the edit lane, which patches them itself (divergence 3/4). */
  stampBookedEvent: boolean;
  /** Clear the reschedule latch alongside the booking. Staff lane only today (divergence 1). */
  clearReschedulePending: boolean;
  /** Store which slot was taken. Staff lane only today (divergence 2). */
  recordMatchedSlot: boolean;
  /** Names the preserved disagreement when this lane is the odd one out for THIS input. */
  divergence: string | null;
  why: string;
};

export function decideAppointmentBookingRecord(
  input: AppointmentBookingRecordInput
): AppointmentBookingRecordDecision {
  const lane = String(input.lane ?? "").trim();
  const customerDriven = APPOINTMENT_BOOKING_CUSTOMER_LANES.has(lane);
  const staffDriven =
    lane === "staff_console_booking" ||
    lane === "manual_outbound_schedule_booking" ||
    lane === APPOINTMENT_BOOKING_EDIT_LANE;
  const recognized = customerDriven || staffDriven;
  const editLane = lane === APPOINTMENT_BOOKING_EDIT_LANE;
  const conversationTurn = APPOINTMENT_BOOKING_CONVERSATION_TURN_LANES.has(lane);
  const latched = input.reschedulePending === true;
  // The edit lane can arrive with no hour to record, and the matched-slot lane never carries one
  // (the hour is already on the record it is confirming); every other creating lane always does, so
  // this can never move their answer.
  const statusWithoutTime = APPOINTMENT_BOOKING_LANES_STATUS_WITHOUT_TIME.has(lane);
  const stampBookedTime =
    recognized && !statusWithoutTime && (!editLane || input.hasBookedTime === true);

  return {
    record: recognized,
    status: "confirmed",
    confirmedBy: customerDriven ? "customer" : "salesperson",
    // Every lane that CREATES an event booked it against a time the customer or the rep chose, so
    // the robotic "Reply YES to confirm" reminder would re-ask what was just settled. The edit lane
    // is excluded via `stampAcknowledged` — see divergence 4.
    acknowledged: true,
    stampBookedTime,
    // Divergence 7: the matched-slot lane confirms without a fresh hour. Identical to
    // `stampBookedTime` everywhere else, including the edit lane, which must NOT restamp `confirmed`
    // when staff moved no hour.
    stampStatus: statusWithoutTime ? recognized : stampBookedTime,
    // Divergence 8: only the exact-slot move arm carries the calendar owner's name and id.
    stampBookedSalespersonIdentity:
      recognized && APPOINTMENT_BOOKING_LANES_STAMPING_SALESPERSON_IDENTITY.has(lane),
    // Divergence 9: a CREATE that came back empty must leave nothing stale behind; a MOVE keeps the
    // event it already holds.
    clearMissingBookedEvent:
      recognized && !APPOINTMENT_BOOKING_LANES_PRESERVING_MISSING_EVENT.has(lane),
    // Divergence 3, PRESERVED: the two lanes that hand attribution in themselves via
    // `setAppointmentBookedBy` leave `confirmedBy` alone. Stamping it would move the KPI
    // appointment-setter label, and a centralization does not get to move a reported number.
    stampConfirmedBy: recognized && !APPOINTMENT_BOOKING_LANES_KEEPING_CONFIRMED_BY.has(lane),
    // Divergence 4, PRESERVED: staff dragging an event to a new hour is not the customer agreeing
    // to the new hour, so the edit lane never puts her word on file.
    stampAcknowledged: recognized && !editLane,
    // The edit lane patches the booked-event ids itself — it writes only what Google actually
    // returned, where the creating lanes clear a missing id to null so no stale event survives.
    stampBookedEvent: recognized && !editLane,
    // RULED 2026-08-02 (divergence 1, FIXED — was: staff lane only). A booking lane that holds a
    // REAL calendar event clears the latch; that principle was already settled by the sibling
    // referee `decideAppointmentConfirmRecord`, which reserves "leave it standing" for the
    // provisional slot-match lane that has no event yet. All three of these lanes hold an event.
    // Leaving it standing let a lead who booked through the public link keep owing a rebook, so her
    // next message with a time-ish word could be answered "let's find you another time" — for the
    // appointment she had just made. Fail-direction agrees: clearing fails toward NOT raising a
    // reschedule nobody asked for. See ruling 4 in the joe-autonomous-rulings ledger.
    clearReschedulePending: recognized,
    // Divergence 5, PRESERVED: named lanes rather than "every staff lane", because the
    // suggested-slot autobook records the slot too — that slot IS where the booking came from.
    recordMatchedSlot: recognized && APPOINTMENT_BOOKING_LANES_RECORDING_MATCHED_SLOT.has(lane),
    // Divergence 2, still preserved and NOT acted on: only the staff lane records which slot it
    // took. A breadcrumb, never asserted to a customer. Named only when a slot actually exists to
    // record, so the flag marks a real gap rather than every customer booking.
    divergence: !recognized
      ? null
      : editLane
        ? // Divergence 4 is the one that can cost a customer a visit, so it is named on every edit.
          "staff_calendar_edit_does_not_refresh_the_customers_acknowledgement_of_the_new_time"
        : // The four conversation-turn lanes are named FIRST and by their own name — one of them
          // sits in the keep-confirmedBy set for a completely different reason than the console
          // lanes do, and letting it borrow their divergence string would misreport why.
          conversationTurn
          ? statusWithoutTime
            ? "matched_slot_lane_confirms_the_booking_without_writing_a_fresh_time_or_attribution"
            : APPOINTMENT_BOOKING_LANES_STAMPING_SALESPERSON_IDENTITY.has(lane)
              ? "exact_slot_move_is_the_only_lane_that_records_whose_calendar_holds_the_event"
              : APPOINTMENT_BOOKING_LANES_PRESERVING_MISSING_EVENT.has(lane)
                ? "move_lanes_keep_the_event_they_already_hold_when_the_calendar_returns_nothing"
                : input.hasMatchedSlot === true
                  ? "suggested_slot_autobook_records_the_matched_slot_where_the_console_customer_lanes_do_not"
                  : null
          : APPOINTMENT_BOOKING_LANES_KEEPING_CONFIRMED_BY.has(lane)
            ? "manual_outbound_booking_leaves_confirmedBy_to_the_attribution_writer"
            : customerDriven && input.hasMatchedSlot === true
              ? "customer_lane_booking_does_not_record_the_matched_slot"
              : null,
    why: !recognized
      ? `unrecognized appointment-booking lane "${lane}" — refused, nothing may be stamped`
      : editLane
        ? `${lane}: staff edited the event${stampBookedTime ? " and moved the hour" : " without moving the hour"} — ` +
          "latch cleared, but the customer's acknowledgement is left exactly as it was"
        : customerDriven
          ? `${lane}: the customer booked a real calendar event — their word is on file and the ` +
            `reschedule latch is cleared${latched ? " (it was standing)" : ""}; the matched slot is ` +
            `${APPOINTMENT_BOOKING_LANES_RECORDING_MATCHED_SLOT.has(lane) ? "recorded" : "not recorded"}`
          : `${lane}: a salesperson booked the lead in — latch cleared and the taken slot recorded`
  };
}

// ===================================================================================================
// SOMETHING SAYS THIS LEAD OWES US A REBOOK — "do we ARM the reschedule latch?"
//
// The third referee in the appointment family, and the one with the most customer risk.
// `decideAppointmentConfirmRecord` and `decideAppointmentBookingRecord` both decide when the latch
// is CLEARED. Nobody owned the opposite question, so three places armed it on their own:
//
//   appointment_outcome_reschedule_draft  a rebook offer was just SENT after staff recorded the
//                                         appointment as missed/cancelled (index.ts ~20050)
//   staff_context_note                    a staff note parsed as an explicit cancel/reschedule
//                                         request (applyAppointmentStateFromContextNote)
//   customer_inbound_cancel_reschedule    the CUSTOMER's own message parsed as cancel/reschedule,
//                                         on a non-human thread (index.ts ~61080)
//
// WHY THE LATCH IS NOT A NOTE. `pendingRescheduleCarriesTurnIntent` (and its regen twin at
// index.ts ~55663) uses it to read the lead's NEXT message as "they want to move their appointment".
// Arming it wrongly means a customer gets answered about rescheduling something they never raised;
// failing to arm it costs a rebook we should have chased. Both directions touch a customer, which is
// why this sits in Tier 1.
//
// THE ONE DISAGREEMENT — must an appointment record already EXIST?
//   The two staff-side lanes require one and skip silently without it: the outcome-draft lane is
//   guarded by `if (conv?.appointment)`, and the context-note lane returns early unless the record
//   exists AND carries real context (a booked event, a `confirmed` status, or an already-standing
//   latch). The CUSTOMER lane requires nothing — it manufactures a `{ status: "none" }` stub and
//   latches on that.
//
//   PRESERVED, and ruled NOT a defect. This is the lane's INPUT, not a fight about the same
//   question. The staff lanes are INFERRING a rebook debt from a record we hold, so with no record
//   there is nothing to infer from. The customer lane has the customer saying it in their own words
//   this turn — the strongest evidence there is — and a lead who says "I need to move my
//   appointment" when we hold nothing is exactly the lead we must not answer as if they said
//   nothing. Fail-direction agrees: for a staff inference, arming on a phantom record fails toward
//   messaging about an appointment that never existed; for the customer lane, NOT arming fails
//   toward ignoring what they just told us. See ruling 5 in the joe-autonomous-rulings ledger.
//
// FAIL DIRECTION for an unrecognized lane: REFUSE to arm. A missed rebook chase costs us a
// follow-up; a wrongly armed latch mis-routes the customer's next message.
//
// PURE + CLOCK-FREE: the caller stamps `updatedAt`; this decides only whether to arm and whether the
// lane may mint a record to arm on.
// ===================================================================================================

export type ReschedulePendingLatchLane =
  | "appointment_outcome_reschedule_draft" // we just SENT a rebook offer after a missed/cancelled appt
  | "staff_context_note" // a staff note read as an explicit cancel/reschedule request
  | "customer_inbound_cancel_reschedule"; // the customer's own message said cancel/reschedule

/**
 * The lane driven by the CUSTOMER'S OWN WORDS this turn. See the divergence above — this is the only
 * lane allowed to mint an appointment record to latch on, because it is the only one not inferring
 * the rebook debt from a record we already hold.
 */
const RESCHEDULE_LATCH_CUSTOMER_SPEECH_LANES = new Set<string>([
  "customer_inbound_cancel_reschedule"
]);

export type ReschedulePendingLatchInput = {
  lane: ReschedulePendingLatchLane | string;
  /** Does this conversation carry an appointment record right now? */
  hasAppointmentRecord: boolean;
  /** The stored latch, exactly as it stands. Only used to say honestly whether this is a no-op. */
  reschedulePending?: boolean | null;
};

export type ReschedulePendingLatchDecision = {
  /** Arm the latch. False means the caller must not write anything. */
  arm: boolean;
  /** This lane may mint a `{ status: "none" }` record to arm on. Customer-speech lane only. */
  createRecordIfAbsent: boolean;
  /** Names the preserved disagreement when this lane is the odd one out for THIS input. */
  divergence: string | null;
  why: string;
};

export function decideReschedulePendingLatch(
  input: ReschedulePendingLatchInput
): ReschedulePendingLatchDecision {
  const lane = String(input.lane ?? "").trim();
  const customerSpeech = RESCHEDULE_LATCH_CUSTOMER_SPEECH_LANES.has(lane);
  const recognized =
    customerSpeech ||
    lane === "appointment_outcome_reschedule_draft" ||
    lane === "staff_context_note";
  const hasRecord = input.hasAppointmentRecord === true;
  const alreadyLatched = input.reschedulePending === true;

  // A staff lane with no record to reason about has nothing to arm — today it skips silently, and
  // that is the safe answer, not an oversight.
  const arm = recognized && (hasRecord || customerSpeech);

  return {
    arm,
    createRecordIfAbsent: customerSpeech,
    divergence:
      recognized && !hasRecord
        ? customerSpeech
          ? "customer_speech_lane_mints_an_appointment_record_to_latch_on"
          : "staff_inference_lane_refuses_to_latch_without_an_appointment_record"
        : null,
    why: !recognized
      ? `unrecognized reschedule-latch lane "${lane}" — refused, the latch may not be armed`
      : !hasRecord
        ? customerSpeech
          ? `${lane}: the customer asked for a new time in their own words and we hold no ` +
            "appointment — mint the record and arm, rather than answer as if they said nothing"
          : `${lane}: no appointment record to infer a rebook debt from — skipped, as today`
        : `${lane}: this lead owes us a rebook — latch armed${alreadyLatched ? " (already standing)" : ""}`
  };
}

// ===================================================================================================
// THE REBOOK DEBT IS SETTLED — "who may take `appointment.reschedulePending` OFF?"
//
// The SETTLEMENT half of the latch, and the last unowned half of it. The booking referees
// (`decideAppointmentBookingRecord` / `decideAppointmentConfirmRecord`) already clear the latch when a
// new time is put on the calendar — that is "we booked them again", a different event. Nobody owned
// the case where the debt simply STOPS being owed without a new booking, so three places answered it
// inline, on three different preconditions:
//
//   stale_pending_reschedule_slot  the scheduler is holding a reschedule slot for an appointment that
//                                  is no longer bookable-for-reschedule at all (index.ts ~62727)
//   settled_past_appointment       the appointment is in the past AND settled — the customer showed,
//                                  or the outcome says so — so the latch is stuck (index.ts ~62731)
//   staff_outcome_showed_up        a staff context note recorded the outcome as SHOWED UP
//                                  (applyAppointmentStateFromContextNote, index.ts ~25371)
//
// WHY IT MATTERS AS MUCH AS ARMING. Same routing switch as the arm half: `pendingRescheduleCarriesTurn
// Intent` reads the lead's NEXT message as "they want to move their appointment" while the latch
// stands. Failing to clear it is the fail-UNSAFE direction here — it keeps answering a customer about
// moving an appointment they already kept — which is why two downstream guards carry hand-written
// armor against a "confirmed AND reschedule-pending" record.
//
// THE ONE DISAGREEMENT — does taking the latch off stamp `updatedAt`?
//   `settled_past_appointment` clears the latch AND stamps `appointment.updatedAt`. The other two
//   clear it and leave the stamp alone (the staff-outcome lane's caller stamps `updatedAt` a few
//   lines earlier for the OUTCOME record, whether or not the latch moved; the stale-slot lane stamps
//   nothing at all). PRESERVED and named. `updatedAt` is a freshness input, not a decision — but a
//   cleanup does not get to start or stop refreshing one, because "when did this record last change"
//   is read by staleness checks and would move under us.
//
// AND ONE PLACE THEY AGREE, worth stating so a later tidy-up cannot quietly break it: NONE of the
// three mints an appointment record. With nothing on file there is no debt to settle, and inventing a
// `{ status: "none" }` stub just to write `false` onto it would hand the arm half's staff lanes a
// phantom record to reason about later.
//
// FAIL DIRECTION for an unrecognized lane: REFUSE to clear. Leaving a latch standing costs a
// mis-routed turn that a human can correct; clearing one we should have kept silently drops a rebook
// the customer asked for. Note this is the OPPOSITE default to the arm half, and deliberately: each
// half refuses to ACT, so an unknown lane changes nothing in either direction.
//
// PURE + CLOCK-FREE: this says whether to clear and whether that clear carries a stamp; the applier
// reads the clock.
// ===================================================================================================

export type ReschedulePendingClearLane =
  | "stale_pending_reschedule_slot" // a reschedule slot with no appointment left to reschedule
  | "settled_past_appointment" // the appointment is past and settled — the latch is stuck
  | "staff_outcome_showed_up"; // a staff note recorded the customer as having shown up

/** The lane that couples the clear to an `updatedAt` stamp. See the divergence above. */
const RESCHEDULE_CLEAR_STAMPING_LANES = new Set<string>(["settled_past_appointment"]);

/**
 * The lane that acts only on a latch that is actually STANDING. The other two write `false` over
 * whatever is there — a no-op when it is already false, which is why the distinction only shows up in
 * the stamp above.
 */
const RESCHEDULE_CLEAR_STANDING_LATCH_LANES = new Set<string>(["settled_past_appointment"]);

export type ReschedulePendingClearInput = {
  lane: ReschedulePendingClearLane | string;
  /** Does this conversation carry an appointment record right now? */
  hasAppointmentRecord: boolean;
  /** The stored latch, exactly as it stands. */
  reschedulePending?: boolean | null;
};

export type ReschedulePendingClearDecision = {
  /** Take the latch off. False means the caller must not write anything. */
  clear: boolean;
  /** Stamp `appointment.updatedAt` as part of taking it off. */
  stampUpdatedAt: boolean;
  /** Names the preserved disagreement when this lane is the odd one out for THIS input. */
  divergence: string | null;
  why: string;
};

export function decideReschedulePendingClear(
  input: ReschedulePendingClearInput
): ReschedulePendingClearDecision {
  const lane = String(input.lane ?? "").trim();
  const recognized =
    RESCHEDULE_CLEAR_STAMPING_LANES.has(lane) ||
    lane === "stale_pending_reschedule_slot" ||
    lane === "staff_outcome_showed_up";
  const hasRecord = input.hasAppointmentRecord === true;
  const standing = input.reschedulePending === true;
  const needsStandingLatch = RESCHEDULE_CLEAR_STANDING_LATCH_LANES.has(lane);
  const stamps = RESCHEDULE_CLEAR_STAMPING_LANES.has(lane);

  const clear = recognized && hasRecord && (!needsStandingLatch || standing);

  return {
    clear,
    stampUpdatedAt: clear && stamps,
    divergence: !clear
      ? null
      : stamps
        ? "settled_past_appointment_stamps_updated_at_when_it_clears_the_latch"
        : "stale_slot_and_staff_outcome_lanes_clear_the_latch_without_stamping_updated_at",
    why: !recognized
      ? `unrecognized reschedule-clear lane "${lane}" — refused, the latch stays as it is`
      : !hasRecord
        ? `${lane}: no appointment record, so there is no rebook debt to settle — nothing written`
        : needsStandingLatch && !standing
          ? `${lane}: the latch is not standing, so there is nothing stuck to heal`
          : `${lane}: this lead no longer owes us a rebook — latch cleared${
              stamps ? " and the record stamped" : ""
            }`
  };
}

// ===================================================================================================
// THE INVENTORY RECORD THAT CLOSED THIS LEAD IS GONE — "does the conversation REOPEN?"
//
// One question, three causes, and it writes THREE Tier-1 fields at once (`hold`/`sale`, `status`,
// `closedReason`) plus the chase. Two places answered it inline:
//
//   clearLinkedInventoryAvailabilityConversations (index.ts ~8630)  staff un-marked a unit as
//       held or sold, so every lead we closed against that unit has to be reconsidered. Two
//       near-identical arms, hold and sale, that had drifted apart.
//   processInventoryHolds (index.ts ~7736)  a hold is cleared because the unit SOLD. It clears the
//       hold record and deliberately does NOT reopen — and that is right, not an oversight.
//
// FAIL DIRECTION, and it is the unusual one. Everywhere else in this file the safe answer is "do
// less". Here the irreversible thing already happened: we CLOSED a live lead because a bike was
// spoken for. If that turns out to be wrong, staying closed means a real buyer is silently dropped
// and no follow-up will ever run. So for a cause that genuinely frees the unit, REOPENING is the
// safe answer. What must stay conservative is the CAUSE test: an unrecognized cause changes nothing.
//
// THE PRESERVED DISAGREEMENTS between the two arms of the un-mark lane:
//
//   DIVERGENCE 1 — how `closedReason` is matched. The hold arm uses a loose word test (`hold`
//     appearing anywhere in the reason); the sale arm demands the reason be exactly "sold". So a
//     lead closed with a wordier sold-ish reason reopens on the hold arm's rules but not the sale
//     arm's. Preserved, because tightening the hold arm would strand leads we closed with
//     free-text hold reasons, and loosening the sale arm would reopen leads that really did buy.
//
//   DIVERGENCE 2 — the chase. The sale arm STOPS the post-sale cadence before resuming normal
//     follow-up; the hold arm stops nothing, it only flips the mode back to active. Preserved:
//     a post-sale chase talks about a bike the customer no longer bought and must not keep running,
//     whereas a hold never started a cadence of its own to stop.
//
// PURE + CLOCK-FREE: the caller owns the record matching, the writes and the timestamps.
// ===================================================================================================

export type InventoryAvailabilityReopenCause =
  | "hold_released" // staff un-marked the unit as held — it is available again
  | "sale_reversed" // staff un-marked the unit as sold — it is available again
  | "hold_superseded_by_sale"; // the hold went away because the unit SOLD — not a release

export type InventoryAvailabilityReopenInput = {
  cause: InventoryAvailabilityReopenCause | string;
  /** The stored `closedReason`, exactly as it is. Each cause applies its own matcher (divergence 1). */
  closedReason?: string | null;
  /** The stored `followUp.reason`. */
  followUpReason?: string | null;
  /** The stored `followUpCadence.kind`. */
  cadenceKind?: string | null;
};

export type InventoryAvailabilityReopenDecision = {
  /** Drop the stale `hold` / `sale` record off the conversation. */
  clearRecord: boolean;
  /** Reopen: `status` back to "open", `closedAt` and `closedReason` cleared. */
  reopen: boolean;
  /** Stop the running cadence before resuming. Sale arm only today (divergence 2). */
  stopCadence: boolean;
  /** Put follow-up back into "active". */
  resumeFollowUp: boolean;
  /** Names the preserved disagreement when this cause is the odd one out for THIS input. */
  divergence: string | null;
  why: string;
};

export function decideInventoryAvailabilityReopen(
  input: InventoryAvailabilityReopenInput
): InventoryAvailabilityReopenDecision {
  const cause = String(input.cause ?? "").trim();
  const recognized =
    cause === "hold_released" || cause === "sale_reversed" || cause === "hold_superseded_by_sale";
  // The unit is genuinely free again. `hold_superseded_by_sale` is NOT — the bike sold.
  const freesTheUnit = cause === "hold_released" || cause === "sale_reversed";

  const reason = String(input.closedReason ?? "");
  // DIVERGENCE 1, preserved verbatim: a loose word test on the hold arm, an exact match on the sale
  // arm. Both are tests against STORED STATE we wrote ourselves, not comprehension of a customer.
  const closedForThisCause =
    cause === "hold_released"
      ? /\bhold\b/i.test(reason)
      : cause === "sale_reversed"
        ? reason.trim().toLowerCase() === "sold"
        : false;

  const followUpReason = String(input.followUpReason ?? "");
  const chaseIsAboutThisCause =
    cause === "hold_released"
      ? followUpReason === "unit_hold" || followUpReason === "order_hold"
      : cause === "sale_reversed"
        ? followUpReason === "post_sale" || String(input.cadenceKind ?? "") === "post_sale"
        : false;

  return {
    clearRecord: recognized,
    reopen: freesTheUnit && closedForThisCause,
    // DIVERGENCE 2, preserved: only the sale arm stops a cadence, because only it can be facing a
    // post-sale chase that is now talking about a bike the customer did not buy.
    stopCadence: cause === "sale_reversed" && chaseIsAboutThisCause,
    resumeFollowUp: freesTheUnit && chaseIsAboutThisCause,
    divergence: !freesTheUnit && recognized
      ? "hold_cleared_by_a_sale_never_reopens_the_conversation"
      : freesTheUnit && !closedForThisCause && !!reason.trim()
        ? cause === "hold_released"
          ? "hold_arm_reopens_on_a_loose_word_match_in_closedReason"
          : "sale_arm_reopens_only_on_an_exact_sold_closedReason"
        : null,
    why: !recognized
      ? `unrecognized inventory-availability cause "${cause}" — refused, nothing may change`
      : !freesTheUnit
        ? "the hold went away because the unit SOLD — clear the stale hold record, but the lead " +
          "stays closed; the bike is spoken for"
        : closedForThisCause
          ? `${cause}: the unit is available again and this lead was closed against it — reopen`
          : `${cause}: the unit is available again but this lead was not closed against it ` +
            `(closedReason "${reason.trim() || "none"}") — clear the record only`
  };
}

// ===================================================================================================
// SOMETHING WANTS A CLOSED LEAD BACK IN THE WORKING INBOX — "may it reopen, and does that erase the
// closeout?"
//
// The companion question to `decideInventoryAvailabilityReopen` above, for every reopen cause that
// is NOT an inventory record disappearing. Four places answered it inline, each writing `status`,
// `closedAt` and `closedReason` on its own reading:
//
//   appendInbound (conversationStore.ts ~2362)   a customer texted a closed thread. The only arm
//       that may REFUSE: sold threads stay sold, and a bare content-free ack must not drag a
//       hold / archived / declined thread back into the working inbox.
//   POST /conversations/:id/reopen (index.ts ~41408)   staff pressed Reopen. Unconditional.
//   the walk-in HOLD note (sendgridInbound.ts ~7652)   a CRM walk-in note says a bike is being held
//       for this customer.
//   the walk-in HOLD-CLEAR note (sendgridInbound.ts ~7668)   a CRM walk-in note says the hold is over.
//
// FAIL DIRECTION: same unusual one as the inventory referee. The irreversible thing (closing a live
// lead) already happened, so REOPENING is the safe answer — a lead wrongly left closed is silently
// dropped and no follow-up ever runs. What stays conservative is the refusal arm: it is driven
// entirely by state WE wrote (`closedReason`, `sale`, `hold`, `followUp.reason`) plus one narrow
// deterministic bare-ack test, never by comprehension of what the customer meant.
//
// AN UNRECOGNIZED CAUSE CHANGES NOTHING. Reopening is safe for the four causes above precisely
// because each one is a human or a customer asking for this lead again; a cause this referee does
// not know is not evidence of anything.
//
// THE PRESERVED DISAGREEMENTS, both real and both visible only once the four sat side by side:
//
//   DIVERGENCE 1 — only the CUSTOMER arm can be refused. Staff Reopen and both walk-in notes reopen
//     unconditionally; a customer's own message is filtered by the sold / hold-ack / archived-ack
//     rules. Preserved: staff clicking Reopen and a salesperson's walk-in note are explicit human
//     instructions, while "thanks!" on a completed sale must not resurrect the deal.
//
//   DIVERGENCE 2 — the walk-in arms reopen WITHOUT erasing a non-hold closeout. They set the status
//     back to open but only clear `closedReason`/`closedAt` when the stored reason mentions "hold",
//     so a lead closed `not_interested` that later gets a walk-in hold note comes back open while
//     still claiming it was closed for not-interested. The other two arms always erase the whole
//     closeout. Preserved as-is: erasing more would destroy the record of WHY staff closed the lead,
//     and the thread is open either way, which is the direction that matters.
//
// PURE + CLOCK-FREE: the caller owns the reads, the bare-ack test and the writes.
// ===================================================================================================

export type CloseoutReversalCause =
  | "customer_inbound" // a customer texted/emailed a closed thread
  | "staff_reopen" // staff pressed Reopen in the console
  | "walkin_hold_note" // a CRM walk-in note says a bike is being held for this customer
  | "walkin_hold_clear"; // a CRM walk-in note says the hold is over

export type CloseoutReversalInput = {
  cause: CloseoutReversalCause | string;
  /** Is the conversation closed right now? Only the customer arm cares (it is a no-op when open). */
  isClosed: boolean;
  /** The stored `closedReason`, exactly as it is. */
  closedReason?: string | null;
  /** The stored `followUp.reason`. */
  followUpReason?: string | null;
  /** Does the conversation carry a `sale.soldAt`? */
  hasSoldSale?: boolean;
  /** Does the conversation carry a `hold` record? */
  hasHoldRecord?: boolean;
  /**
   * CUSTOMER ARM ONLY: the inbound was a bare, content-free acknowledgement and carried no media.
   * Computed by the caller (`isBareAckInboundText`) — a deterministic side-effect gate, not
   * comprehension. Ignored for every other cause.
   */
  bareAck?: boolean;
  /** CUSTOMER ARM ONLY: `isDeclineCloseoutReason(closedReason)` — our own closeout vocabulary. */
  declineCloseoutReason?: boolean;
};

export type CloseoutReversalDecision = {
  /** Put `status` back to "open". */
  reopen: boolean;
  /** Also clear `closedAt` + `closedReason` — NOT always implied by `reopen` (divergence 2). */
  clearCloseout: boolean;
  /** Names the preserved disagreement when this cause is the odd one out for THIS input. */
  divergence: string | null;
  why: string;
};

export function decideCloseoutReversal(input: CloseoutReversalInput): CloseoutReversalDecision {
  const cause = String(input.cause ?? "").trim();
  const recognized =
    cause === "customer_inbound" ||
    cause === "staff_reopen" ||
    cause === "walkin_hold_note" ||
    cause === "walkin_hold_clear";
  const walkIn = cause === "walkin_hold_note" || cause === "walkin_hold_clear";

  const closedReason = String(input.closedReason ?? "").toLowerCase();
  const followUpReason = String(input.followUpReason ?? "").toLowerCase();
  const bareAck = !!input.bareAck;

  // SOLD stays closed no matter what: post-sale texts are worked in the sold bucket, and a
  // genuinely NEW purchase forks a fresh journey — reopening the sold lead would pull completed
  // deals back into the inbox on every "thanks!".
  const soldSticky =
    closedReason === "sold" || !!input.hasSoldSale || /\bpost_sale\b/.test(followUpReason);
  // A HOLD deal (bike held for the customer, purchase in progress) is NOT sold: a real customer
  // message there is live deal traffic and must reopen the thread so it surfaces (Joe ruling
  // 2026-07-16; David Miller +17163440581). Only a bare content-free ack leaves it closed.
  const holdSticky =
    !soldSticky &&
    (/\bhold\b/.test(closedReason) ||
      !!input.hasHoldRecord ||
      /\b(unit_hold|order_hold|manual_hold)\b/.test(followUpReason));
  const stickyClosed = soldSticky || (holdSticky && bareAck);
  // Staff-archived + a bare content-free ack (no media) => stay archived. A CLEAN DECLINE closeout
  // ("No thanks") archives on the same terms (Joe ruling 2026-07-22).
  const archivedAckHold = (/archive/.test(closedReason) || !!input.declineCloseoutReason) && bareAck;
  const customerMayReopen = !!input.isClosed && !stickyClosed && !archivedAckHold;

  // DIVERGENCE 2, preserved verbatim: the walk-in arms only erase a closeout that mentions "hold".
  const walkInClearsCloseout = !!closedReason && /\bhold\b/.test(closedReason);

  const reopen = !recognized ? false : cause === "customer_inbound" ? customerMayReopen : true;
  const clearCloseout = !recognized
    ? false
    : cause === "customer_inbound"
      ? customerMayReopen
      : walkIn
        ? walkInClearsCloseout
        : true;

  return {
    reopen,
    clearCloseout,
    divergence: !recognized
      ? null
      : cause === "customer_inbound" && !!input.isClosed && !customerMayReopen
        ? "only_the_customer_arm_may_be_refused_a_reopen"
        : walkIn && reopen && !clearCloseout
          ? "walkin_note_reopens_but_keeps_a_non_hold_closeout_reason"
          : null,
    why: !recognized
      ? `unrecognized closeout-reversal cause "${cause}" — refused, nothing may change`
      : cause === "customer_inbound"
        ? !input.isClosed
          ? "customer_inbound: the thread is already open — nothing to reverse"
          : customerMayReopen
            ? "customer_inbound: a real message on a closed thread — reopen and clear the closeout"
            : soldSticky
              ? "customer_inbound: this lead is SOLD — post-sale traffic stays in the sold bucket"
              : holdSticky
                ? "customer_inbound: a bare ack on a HOLD thread — not live deal traffic, stays closed"
                : "customer_inbound: a bare ack on an archived/declined thread — stays archived"
        : cause === "staff_reopen"
          ? "staff_reopen: staff asked for this lead back — reopen and clear the whole closeout"
          : clearCloseout
            ? `${cause}: a walk-in note about the hold, and the lead was closed against a hold — ` +
              "reopen and clear the closeout"
            : `${cause}: a walk-in note about the hold — reopen, but the stored closedReason ` +
              `("${String(input.closedReason ?? "").trim() || "none"}") is not a hold, so it stands`
  };
}

// ===================================================================================================
// THE CHASE'S STATE MACHINE — "may this caller stop / pause / resume the follow-up cadence?"
//
// `followUpCadence` is the field that TEXTS people. Four places moved it between active, paused and
// stopped, each with its own preconditions and its own idea of which companion fields get cleared:
//
//   stop     stopFollowUpCadence(conv, reason)      the general "end this chase" verb
//   pause    pauseFollowUpCadence(conv, until, r)   hush it until a date, keep it alive
//   resume   resumeFollowUpCadence(conv, tz)        bring a STOPPED chase back
//   close    closeConversation(conv, reason)        stopped the chase INLINE, bypassing `stop`
//
// FAIL DIRECTION: fewer texts. Refusing a transition leaves the chase where it is, and the states
// this referee can refuse into (stopped, or a protected post-sale chase) are all quieter than the
// alternative. An unrecognized verb changes nothing.
//
// THE PRESERVED DISAGREEMENTS, all three only visible once the four sat side by side:
//
//   DIVERGENCE 1 — only `stop` protects a post-sale / long-term chase. `stopFollowUpCadence` refuses
//     when the reason is "manual_handoff" or "purchase_delivery" and the chase is post_sale or
//     long_term: a service question or a "be there in 10 minutes" is expected post-sale chatter, not
//     a reason to kill the sequence the sale itself started. `close` writes the same field with no
//     such check. Preserved, and it is not reachable today — closeConversation is never called with
//     either of those two reasons — but writing it down is the point: the protection belongs to the
//     REASON, not to the function that happens to hold it.
//
//   DIVERGENCE 2 — `close` leaves the pause fields standing. `stop` clears `pausedUntil` and
//     `pauseReason` alongside `nextDueAt`; the inline stop inside closeConversation clears only
//     `nextDueAt`, so a closed lead can keep a "paused until <date>" stamp on a stopped chase.
//     Preserved: it is a stale label on an already-stopped chase, it sends nothing, and clearing it
//     here would be a behavior change smuggled into a cleanup.
//
//   DIVERGENCE 3 — `pause` has no post-sale protection at all. It hushes any ACTIVE chase whatever
//     its kind, where `stop` would refuse for the same reason. Preserved: pausing is reversible and
//     quieter, which is the safe direction; refusing here would make us text MORE.
//
// PURE + CLOCK-FREE: the caller owns the dates, the offsets and the writes.
// ===================================================================================================

export type CadenceLifecycleVerb =
  | "stop" // stopFollowUpCadence — end this chase
  | "pause" // pauseFollowUpCadence — hush it until a date, keep it alive
  | "resume" // resumeFollowUpCadence — bring a STOPPED chase back
  | "close"; // closeConversation — the lead is closed, so the chase ends with it

/** Reasons that must NOT kill a post-sale / long-term chase. See divergence 1. */
const CADENCE_STOP_PROTECTED_REASONS = new Set<string>(["manual_handoff", "purchase_delivery"]);
/** Kinds that survive those reasons. */
const CADENCE_PROTECTED_KINDS = new Set<string>(["post_sale", "long_term"]);

/**
 * DIVERGENCE 1, SECOND HALF (Charles Desalvo +17168614216 — Joe filed "No sold cadence"
 * 2026-08-03T12:32Z; reproduced against the live record).
 *
 * Close reasons that mean the lead closed BECAUSE IT SOLD. A `post_sale` chase must survive them:
 * closing a sold lead is exactly WHEN the owner sequence is supposed to run, so stopping the chase
 * on that transition deletes the whole point of it.
 *
 * The comment above says divergence 1 is "not reachable today — closeConversation is never called
 * with either of those two reasons". True of the reason strings, and beside the point: the walk-in
 * sold branch reaches the same outcome twelve lines apart. `sendgridInbound.ts` asks
 * `stopFollowUpCadence(conv, "manual_handoff")`, which this referee correctly REFUSES for a
 * post-sale chase — and then calls `closeConversation(conv, "sold_walkin_note")`, whose `close`
 * verb had no such check and killed it anyway. Charles's record is that sequence frozen in place:
 * `kind: "post_sale"`, `anchorAt` equal to `sale.soldAt` to the millisecond (the console sold
 * button armed it), `status: "stopped"`, `stopReason: "sold_walkin_note"`. He bought a Street
 * Glide on 2026-08-03 and the owner sequence never sent a thing.
 *
 * FAIL DIRECTION — this one sends MORE, which is the opposite of this referee's usual bias, so it
 * is deliberately narrow: `post_sale` only (a `long_term` chase on a closed lead still stops), and
 * only for reasons that literally mean sold. It does not invent behavior — it restores PARITY with
 * the three console sold paths (index.ts 20518 / 41289 / 41812 / 42915), which never call
 * closeConversation at all and so already leave an ACTIVE post-sale chase on a closed, sold lead.
 * +17163741119 (Tim Williams) is the healthy comparison: `closedReason: "sold"`, post_sale ACTIVE,
 * and it duly sent his congratulations touch on 2026-08-01. Each individual touch is still gated
 * downstream by the cadence-quality judge and `decidePostSaleOwnershipTurn`.
 */
const CADENCE_CLOSE_SOLD_REASONS = new Set<string>(["sold", "sold_walkin_note"]);

/**
 * The same authority, for the BACKFILL that repairs records this referee froze before it existed.
 *
 * #519 is forward-only, so every lead already stopped this way stays stopped. The heal must select
 * on EXACTLY what the referee now protects, or the two drift — and the drift is not symmetric: a
 * heal with its own private list would either miss victims or, far worse, re-arm an owner sequence
 * on a lead stopped for a real reason. Measured 2026-08-05 on the live store: of 15 stranded sold
 * leads only 3 carried a sold-close reason; the other 12 stopped for `customer_stepping_back`,
 * `purchase_delivery`, `in_process_deal`, `inventory_watch` and friends. Texting those would have
 * been a fresh defect, not a repair. Exported as a predicate, not the Set, so no caller can mutate it.
 */
export function isCadenceCloseSoldReason(reason?: string | null): boolean {
  return CADENCE_CLOSE_SOLD_REASONS.has(String(reason ?? "").trim());
}

export type CadenceLifecycleInput = {
  verb: CadenceLifecycleVerb | string;
  /**
   * Is there a `followUpCadence` OBJECT at all? Deliberately separate from `status`: `stop` gated on
   * the object's existence and `close` on the status being set, and a record carrying no status
   * would have been treated differently by the two. Preserved rather than tidied.
   */
  hasRecord?: boolean;
  /** The stored `followUpCadence.status`, exactly as it is. */
  status?: string | null;
  /** The stored `followUpCadence.kind`. */
  kind?: string | null;
  /** The caller's reason. Only `stop` reads it (divergence 1). */
  reason?: string | null;
};

export type CadenceLifecycleDecision = {
  /** May this transition happen at all? False means the caller writes nothing. */
  apply: boolean;
  /** The status to write. `null` when the verb does not change the status (pause). */
  nextStatus: "active" | "stopped" | null;
  /** Clear `nextDueAt`. */
  clearNextDue: boolean;
  /** Clear `pausedUntil` + `pauseReason`. NOT implied by stopping (divergence 2). */
  clearPause: boolean;
  /** Clear `stopReason`. */
  clearStopReason: boolean;
  /** Names the preserved disagreement when this verb is the odd one out for THIS input. */
  divergence: string | null;
  why: string;
};

export function decideCadenceLifecycle(input: CadenceLifecycleInput): CadenceLifecycleDecision {
  const verb = String(input.verb ?? "").trim();
  const recognized = verb === "stop" || verb === "pause" || verb === "resume" || verb === "close";
  const status = String(input.status ?? "").trim();
  const kind = String(input.kind ?? "").trim();
  const reason = String(input.reason ?? "").trim();
  const hasChase = !!status;
  const hasRecord = input.hasRecord ?? hasChase;
  const protectedChase =
    CADENCE_STOP_PROTECTED_REASONS.has(reason) && CADENCE_PROTECTED_KINDS.has(kind);
  /** The lead is closing BECAUSE IT SOLD, and this is the owner sequence. See divergence 1's second half. */
  const soldCloseSparesPostSale = kind === "post_sale" && CADENCE_CLOSE_SOLD_REASONS.has(reason);

  // Every verb needs a cadence RECORD to move — all four originals returned early without one.
  const apply = !recognized || !hasRecord
    ? false
    : verb === "stop"
      ? !protectedChase
      : verb === "pause"
        ? status === "active"
        : verb === "resume"
          ? status === "stopped"
          : /* close */ hasChase && !soldCloseSparesPostSale;

  const refused = { clearNextDue: false, clearPause: false, clearStopReason: false };
  const writes = !apply
    ? refused
    : verb === "stop"
      ? { clearNextDue: true, clearPause: true, clearStopReason: false }
      : verb === "pause"
        ? refused
        : verb === "resume"
          ? { clearNextDue: false, clearPause: true, clearStopReason: true }
          : /* close, DIVERGENCE 2 */ { clearNextDue: true, clearPause: false, clearStopReason: false };

  return {
    apply,
    nextStatus: !apply
      ? null
      : verb === "resume"
        ? "active"
        : verb === "pause"
          ? null
          : "stopped",
    ...writes,
    divergence:
      verb === "close" && hasRecord && soldCloseSparesPostSale
        ? "a_sold_close_spares_the_post_sale_chase_it_hands_off_to"
        : verb === "stop" && hasRecord && protectedChase
          ? "only_the_stop_verb_protects_a_post_sale_or_long_term_chase"
          : verb === "close" && apply && CADENCE_PROTECTED_KINDS.has(kind)
            ? "closing_the_lead_stops_a_protected_chase_that_stop_would_have_spared"
            : verb === "pause" && apply && CADENCE_PROTECTED_KINDS.has(kind)
              ? "pause_hushes_a_protected_chase_that_stop_would_have_spared"
              : null,
    why: !recognized
      ? `unrecognized cadence-lifecycle verb "${verb}" — refused, the chase stays where it is`
      : !hasRecord
        ? `${verb}: there is no chase on this lead — nothing to move`
        : !apply
          ? verb === "close" && soldCloseSparesPostSale
            ? `close: refused — the lead is closing as "${reason}", and a post-sale chase is the ` +
              "owner sequence that close is supposed to hand off to, not something it ends"
            : verb === "stop"
            ? `stop: refused — a ${kind} chase survives "${reason}"; that is expected post-sale ` +
              "traffic, not a reason to kill the sequence the sale started"
            : `${verb}: refused — the chase is "${status}", not the state this verb moves from`
          : verb === "pause"
            ? `pause: the chase is hushed until the caller's date, still alive`
            : `${verb}: the chase moves to ${verb === "resume" ? "active" : "stopped"}`
  };
}

/**
 * Should a Traffic Log Pro walk-in note start an inventory watch?
 *
 * ONE referee for a question the ADF intake lane used to answer with its own inline
 * `parser || regex` pair (`hasWatchIntentFromParser || hasWatchIntentFromText`,
 * sendgridInbound.ts). Larry Godzich (+17164327329) is the miss that forced it: both arms ask
 * whether the CUSTOMER asked to be notified, and a salesperson's third-person CRM log never does
 * — see walkInInventoryWant.ts for the full write-up and the corpus numbers.
 *
 * TWO INDEPENDENT ARMS, and the order matters:
 *   1. `explicitWatchPhrase` — the KEEP arm. A literal "watch for" / "let me know when" in the
 *      note wins on its own, exactly as it does today. Nothing here may veto it: its fail
 *      direction is a lead we promised to text never getting one.
 *   2. the parser arm — additive only, and OFF until `wantParserEnabled`. It can add watches the
 *      regex cannot see and can never remove one. Unclear, low-confidence, a non-`open_search`
 *      lane, or the parser being absent all collapse to today's behavior.
 *
 * A family-only label ("trike models", "a Sportster") never mints a watch on the parser arm —
 * we would be guessing which bike, so we ask (Joe ruling 2026-07-11 #4). The explicit arm keeps
 * its existing pending-clarify path for that case downstream.
 *
 * AND the parser arm asks the INVENTORY, not just the note. Mike Wolf (+17164323990, 2026-08-07)
 * walked in to look at a new Deadwood; the note never says whether we have one, the parser answered
 * `wantIsSatisfiableFromNote: false` — which is literally true of the NOTE — and the arm armed a
 * watch and told him "I'll keep an eye out for new FLHD Deadwood and let you know if one comes in"
 * about a bike on our own floor. Silence in the note is not evidence of an empty floor, so when the
 * model is in stock right now the parser arm stands down. Fail direction: no watch and no promise
 * to text — the safe side, and the KEEP arm is untouched, so a customer who literally asked to be
 * notified still gets the watch whatever the floor holds.
 */
export type WalkInInventoryWatchInput = {
  /** A literal notify verb was found in the note. The KEEP arm — wins on its own. */
  explicitWatchPhrase: boolean;
  /**
   * The legacy customer-speech intent arm (`parseIntentWithLLM` availability +
   * explicit_request, already confidence-gated by the caller). Preserved so this referee is a
   * behavior-preserving swap when the new arm is off.
   */
  intentParserWatchRequest: boolean;
  /** `unmetInventoryWant` from the walk-in outcome parser. Only "open_search" is watchable. */
  want?: string | null;
  /** The note says the wanted bike is ours to sell/show right now. */
  wantSatisfiableFromNote?: boolean | null;
  /** `wantConfidence` from the same parse. Absent = no parser answer. */
  wantConfidence?: number | null;
  /** Floor for the parser arm. Deliberately higher than the parser's own accept floor. */
  wantConfidenceMin: number;
  /** Flag gate. False = shadow only: the verdict is computed and logged, never acted on. */
  wantParserEnabled: boolean;
  /** Resolved model label, if any. Blank = we could not name a bike. */
  modelLabel?: string | null;
  /** The label names a family, not a model ("trike", "Sportster") — ask rather than guess. */
  familyOnlyModel?: boolean | null;
  /**
   * We have at least one of this model in stock RIGHT NOW (the lane's own feed lookup). True vetoes
   * the parser arm — you cannot have an unmet open search for a bike we can show you today. Null or
   * undefined means the lookup never ran or failed, which must read as "unknown", never as "empty".
   */
  modelInStockNow?: boolean | null;
  /** Accepted walk-in outcome state; a deal in motion is not a shopping list. */
  walkInState?: string | null;
};

export type WalkInInventoryWatchDecision = {
  /** Feeds the lane's existing `hasWatchIntent`. False = today's behavior in every branch. */
  watch: boolean;
  /** What the parser arm WOULD have said, regardless of the flag — this is the shadow signal. */
  parserArmWouldWatch: boolean;
  /** Which arm carried it: the KEEP regex, the legacy intent parser, or the want parser. */
  source: "explicit_phrase" | "intent_parser" | "want_parser" | "none";
  why: string;
};

/** Walk-in states that mean a deal is already in motion — never a reason to start shopping. */
const WALK_IN_DEAL_PROGRESS_STATES = new Set<string>([
  "deal_finalizing",
  "deposit_left",
  "sold_delivered",
  "cosigner_required"
]);

export function decideWalkInInventoryWatchTurn(
  input: WalkInInventoryWatchInput
): WalkInInventoryWatchDecision {
  const want = String(input.want ?? "").trim().toLowerCase();
  const state = String(input.walkInState ?? "").trim().toLowerCase();
  const confidence =
    typeof input.wantConfidence === "number" && Number.isFinite(input.wantConfidence)
      ? input.wantConfidence
      : null;
  const floor =
    typeof input.wantConfidenceMin === "number" && Number.isFinite(input.wantConfidenceMin)
      ? input.wantConfidenceMin
      : 1;

  // The parser arm, evaluated even when the flag is off so the shadow log has something to say.
  const parserArmWouldWatch =
    want === "open_search" &&
    input.wantSatisfiableFromNote !== true &&
    // Mike Wolf: the note is silent, the floor is not. Only a POSITIVE in-stock answer vetoes.
    input.modelInStockNow !== true &&
    confidence !== null &&
    confidence >= floor &&
    !!String(input.modelLabel ?? "").trim() &&
    input.familyOnlyModel !== true &&
    !WALK_IN_DEAL_PROGRESS_STATES.has(state);

  if (input.explicitWatchPhrase) {
    return {
      watch: true,
      parserArmWouldWatch,
      source: "explicit_phrase",
      why: "the note carries an explicit notify verb — the KEEP arm, unchanged and never vetoed"
    };
  }
  if (input.intentParserWatchRequest) {
    return {
      watch: true,
      parserArmWouldWatch,
      source: "intent_parser",
      why: "the customer-speech intent parser read an explicit availability request"
    };
  }
  if (parserArmWouldWatch && input.wantParserEnabled) {
    return {
      watch: true,
      parserArmWouldWatch,
      source: "want_parser",
      why: `staff note records an unmet open search for "${String(input.modelLabel).trim()}" we cannot fill today`
    };
  }

  return {
    watch: false,
    parserArmWouldWatch,
    source: "none",
    why: parserArmWouldWatch
      ? "want parser would watch, but the flag is off — shadow only, today's behavior stands"
      : want === "open_search"
        ? input.modelInStockNow === true
          ? `open search for "${String(input.modelLabel ?? "").trim()}", but we have one in stock right now — nothing to watch for`
          : "open search, but it did not clear the guards (confidence / model / family-only / deal in motion / already ours)"
        : `no watchable want (${want || "unclassified"}) and no explicit notify verb`
  };
}

// ===================================================================================================
// WHO BOOKED THIS APPOINTMENT — "and what do we record when nobody told us?"
//
// WHAT WAS FIGHTING. Two places write `appointment.bookedBy` and they answer different halves of
// the same question with different rules:
//
//   setAppointmentBookedBy (index.ts)  the caller HANDS IN an attribution — nine booking paths do
//                                      this (the customer-ack booking, the voice-transcript
//                                      booking, the public link, the staff console, the
//                                      manual-outbound lanes)
//   onAppointmentBooked (index.ts)     nobody handed one in, so INFER it from `confirmedBy`
//
// The inference is not a curiosity: of the eighteen places that call `onAppointmentBooked`, eleven
// reach it without any explicit attribution above them, so for those the inference IS the record.
//
// THE THREE PRESERVED DIVERGENCES:
//
//   1. OVERWRITE vs FILL-A-BLANK. The explicit lane writes over an attribution already on file; the
//      inference refuses to touch one. So a later booking path can rewrite who booked an
//      appointment, while the inference never can. Preserved: an explicit attribution is somebody
//      stating a fact, and the fresher statement winning is the defensible reading.
//
//   2. A CUSTOMER'S CONFIRMATION IS FILED AS THE AGENT'S BOOKING. `confirmedBy: "customer"` infers
//      `{ actor: "ai", channel: "sms" }` — the customer did the confirming, and we record the agent
//      as the booker over SMS, with the channel hard-coded rather than read off the thread the way
//      every explicit lane passes it. (`confirmedBy: "salesperson"` infers `{ human, manual }`,
//      which has the same hard-coded-channel shape but attributes to the right party.) Preserved:
//      `bookedBy` drives reporting and attribution, not what any customer receives, so changing it
//      is a decision about how the dealership counts its own bookings.
//
//   3. AN UNRECOGNIZED `confirmedBy` RECORDS NOTHING AT ALL. Blank, "staff", anything else — the
//      appointment simply carries no booker. Preserved, and it is the safe direction: an absent
//      attribution reads as unknown, where a guessed one reads as fact.
//
// FAIL DIRECTION. `bookedBy` never gates a message, a close, or a booking — it is a record of who
// did something that already happened. So the dangerous direction here is a CONFIDENT WRONG
// attribution, not a missing one, and an unrecognized lane therefore writes nothing.
//
// PURE + CLOCK-FREE: the caller owns the write and the timestamps.

export type AppointmentAttributionLane =
  | "explicit" // a booking path handed us the attribution
  | "inferred"; // nobody did — read it off `confirmedBy`

/**
 * Structural mirror of the store's `AppointmentBookedBy`. Declared here rather than imported
 * because this module stays free of store types — actor/channel are plain strings so a decision
 * never has to know the store's unions, and the applier does the narrowing.
 */
export type AppointmentAttributionRecord = {
  actor: string;
  channel: string;
  userId?: string | null;
  userName?: string | null;
  sourceMessageId?: string | null;
  inferred?: boolean;
};

export type AppointmentAttributionInput = {
  lane: AppointmentAttributionLane | string;
  /** Is there an appointment record to attribute at all? */
  hasAppointment: boolean;
  /** Is an attribution already on file? Only the inference defers to it (divergence 1). */
  hasExistingAttribution: boolean;
  /** Explicit lane: what the caller handed in. Absent = nothing to write. */
  supplied?: Partial<AppointmentAttributionRecord> | null;
  /** Inferred lane: the stored `appointment.confirmedBy`, exactly as it is. */
  confirmedBy?: string | null;
};

export type AppointmentAttributionDecision = {
  write: boolean;
  /** The attribution to store. Only set when `write`. */
  bookedBy?: AppointmentAttributionRecord;
  divergence: string | null;
  why: string;
};

/** What each recognized `confirmedBy` infers. Anything absent from this table records nothing. */
const APPOINTMENT_ATTRIBUTION_INFERENCE: Record<string, { actor: string; channel: string }> = {
  salesperson: { actor: "human", channel: "manual" },
  customer: { actor: "ai", channel: "sms" }
};

export function decideAppointmentAttribution(
  input: AppointmentAttributionInput
): AppointmentAttributionDecision {
  const lane = String(input?.lane ?? "").trim();
  if (!input?.hasAppointment) {
    return { write: false, divergence: null, why: "no appointment record to attribute" };
  }

  if (lane === "explicit") {
    const supplied = input.supplied;
    if (!supplied) return { write: false, divergence: null, why: "explicit: the caller handed in nothing" };
    return {
      write: true,
      // The six-key shape the helper has always written, normalizations included: a blank
      // userId/userName/sourceMessageId becomes undefined, and `inferred` is only ever true or gone.
      bookedBy: {
        actor: supplied.actor,
        channel: supplied.channel,
        userId: supplied.userId ?? undefined,
        userName: supplied.userName ?? undefined,
        sourceMessageId: supplied.sourceMessageId ?? undefined,
        inferred: supplied.inferred === true ? true : undefined
      } as AppointmentAttributionRecord,
      divergence: input.hasExistingAttribution ? "explicit_overwrites_an_existing_attribution" : null,
      why: input.hasExistingAttribution
        ? "explicit: rewrote an attribution already on file — the fresher statement wins"
        : `explicit: recorded ${String(supplied.actor ?? "?")} via ${String(supplied.channel ?? "?")}`
    };
  }

  if (lane === "inferred") {
    if (input.hasExistingAttribution) {
      return { write: false, divergence: null, why: "inferred: an attribution is already on file — never overwrite one" };
    }
    const confirmedBy = String(input.confirmedBy ?? "").toLowerCase();
    const inference = APPOINTMENT_ATTRIBUTION_INFERENCE[confirmedBy];
    if (!inference) {
      return {
        write: false,
        divergence: "an_unrecognized_confirmedBy_records_no_attribution_at_all",
        why: `inferred: nothing to go on (confirmedBy "${confirmedBy || "blank"}") — left unattributed`
      };
    }
    return {
      write: true,
      // The three-key shape the inference has always written — no userId/userName/sourceMessageId
      // keys at all, unlike the explicit lane's six.
      bookedBy: { actor: inference.actor, channel: inference.channel, inferred: true } as AppointmentAttributionRecord,
      divergence:
        confirmedBy === "customer" ? "customer_confirmation_is_filed_as_the_agents_booking" : null,
      why: `inferred: ${confirmedBy} confirmed, so recorded ${inference.actor} via ${inference.channel}`
    };
  }

  return { write: false, divergence: null, why: `unrecognized attribution lane "${lane}" — recorded nothing` };
}

/**
 * ARMING AN INVENTORY WATCH — "a watch is being set on this lead; what does the conversation
 * record look like afterwards?"
 *
 * SIX places used to answer that on their own, each carrying its own copy of the same five-or-six
 * line block (`inventoryWatches` + the singular mirror + clear the pending ask + the dialog state +
 * `holding_inventory` + stop the chase): the voice-summary watch (index.ts), the staff context
 * note (index.ts), the shared confirmation choke point `applyInventoryWatchConfirmation`
 * (index.ts), the console hold-resolution endpoint (index.ts), the manual-outbound watch
 * (index.ts) and the email lane (sendgridInbound.ts). Three Tier-2 fields — `inventoryWatch`,
 * `inventoryWatches`, `inventoryWatchPending` — all decided in the same breath, which is why they
 * are one question and not three.
 *
 * TWO DIVERGENCES, both preserved here rather than tidied away, both about the DIALOG STATE — and
 * the dialog state is load-bearing for a reason that is not obvious from the write site.
 * `setDialogState(conv, "inventory_watch_active")` (index.ts) does three things: it clears the
 * DURABLE watch opt-out (`clearInventoryWatchOptOut`), it writes `conv.dialogState`, and it stamps
 * `lastIntent`. `inventoryWatchOptOut.ts`'s own header names that transition as THE way a customer
 * re-subscribes. So a lane that does not pass through the helper arms a watch that
 * `isInventoryWatchOptedOut` will keep silent forever — the alert cron `continue`s on it.
 *   1. `console_hold_resolution` sets NO dialog state at all.
 *   2. `email_inbound` writes `conv.dialogState` DIRECTLY, bypassing the helper.
 * BLAST RADIUS at the time of writing: 802 conversations, 89 carrying a watch, and **ZERO** with a
 * durable watch opt-out on file — so this is a PORTABILITY defect, not a live one. It fires the
 * first time a customer opts out and later re-subscribes through the email lane or a console hold
 * resolution. Named on the decision; the fix is its own PR, not this cleanup.
 */
export type InventoryWatchArmLane =
  | "voice_summary"
  | "context_note"
  | "watch_confirmation"
  | "console_watch_set"
  | "console_hold_resolution"
  | "held_unit_guard"
  | "manual_outbound"
  | "email_inbound"
  | "email_walk_in"
  | "email_adf_unavailable";

/** How this lane enters the active-watch dialog state — see the divergences above. */
export type InventoryWatchArmDialogRoute = "helper" | "direct" | "none";

export type InventoryWatchArmInput = {
  lane: InventoryWatchArmLane;
  /** How many watches this lane is arming. Zero is not an arm — no caller reaches here with none. */
  watchCount: number;
};

export type InventoryWatchArmDecision = {
  arm: boolean;
  clearPending: boolean;
  dialogRoute: InventoryWatchArmDialogRoute;
  dialogState: "inventory_watch_active" | null;
  /** True only when this lane's dialog route also reverses a durable watch opt-out. */
  reversesWatchOptOut: boolean;
  followUpMode: "holding_inventory";
  followUpModeReason: string;
  stopCadenceReason: string;
  divergence: string | null;
  why: string;
};

const INVENTORY_WATCH_ARM_DIALOG_ROUTE: Record<InventoryWatchArmLane, InventoryWatchArmDialogRoute> = {
  voice_summary: "helper",
  context_note: "helper",
  watch_confirmation: "helper",
  manual_outbound: "helper",
  console_watch_set: "helper",
  // Divergence 1 — the console HOLD-RESOLUTION lane leaves the dialog state alone entirely, while
  // its sibling the console watch-set endpoint (same console, same staff action) calls the helper.
  console_hold_resolution: "none",
  // NOT a divergence: the held-unit auto-guard arms a watch NOBODY asked for, so it must not read
  // as a re-subscribe. `setDialogState`'s own comment names this lane as the deliberate exception,
  // and `inventoryWatchOptOut.ts` carries a matching held-guard early return.
  held_unit_guard: "none",
  // Divergence 2 — all three email arms write the record themselves and skip the helper's side
  // effects (above all the durable-opt-out reversal).
  email_inbound: "direct",
  email_walk_in: "direct",
  email_adf_unavailable: "direct"
};

const INVENTORY_WATCH_ARM_DIVERGENCE: Partial<Record<InventoryWatchArmLane, string>> = {
  console_hold_resolution: "two_console_lanes_disagree_on_whether_arming_a_watch_enters_the_active_dialog_state",
  email_inbound: "email_lane_writes_the_dialog_state_directly_so_a_durable_watch_opt_out_survives",
  email_walk_in: "email_lane_writes_the_dialog_state_directly_so_a_durable_watch_opt_out_survives",
  email_adf_unavailable: "email_lane_writes_the_dialog_state_directly_so_a_durable_watch_opt_out_survives"
};

/** Pure. */
export function decideInventoryWatchArm(input: InventoryWatchArmInput): InventoryWatchArmDecision {
  const dialogRoute = INVENTORY_WATCH_ARM_DIALOG_ROUTE[input.lane] ?? "none";
  const armed = Number(input.watchCount) > 0;
  if (!armed) {
    return {
      arm: false,
      clearPending: false,
      dialogRoute: "none",
      dialogState: null,
      reversesWatchOptOut: false,
      followUpMode: "holding_inventory",
      followUpModeReason: "inventory_watch",
      stopCadenceReason: "inventory_watch",
      divergence: null,
      why: `${input.lane}: nothing to arm — no watch supplied`
    };
  }
  return {
    arm: true,
    clearPending: true,
    dialogRoute,
    dialogState: dialogRoute === "none" ? null : "inventory_watch_active",
    // Only the shared helper reverses the durable opt-out. A direct write does not.
    reversesWatchOptOut: dialogRoute === "helper",
    followUpMode: "holding_inventory",
    followUpModeReason: "inventory_watch",
    stopCadenceReason: "inventory_watch",
    divergence: INVENTORY_WATCH_ARM_DIVERGENCE[input.lane] ?? null,
    why:
      dialogRoute === "helper"
        ? `${input.lane}: watch armed, chase stops, and the active-watch transition reverses any durable opt-out`
        : dialogRoute === "direct"
          ? `${input.lane}: watch armed, chase stops, dialog state written directly — a durable opt-out survives`
          : `${input.lane}: watch armed and the chase stops, but the dialog state is left untouched`
  };
}

/**
 * INVENTORY-WATCH DISARM — "a watch is coming OFF this lead: what does the record look like
 * afterwards?" The exact INVERSE of `decideInventoryWatchArm` above, and a separate referee rather
 * than a lane on that one because the questions differ in kind: arming asks what to switch ON,
 * disarming asks what SURVIVES, and the three lanes disagree about survival in ways arming cannot.
 *
 * THREE LANES, each of which hand-wrote the same three Tier-2 fields:
 *   1. `customer_stop`   — `clearInventoryWatchState`. The customer told us to stop. Everything goes.
 *   2. `held_guard_heal` — `applyStaleHeldUnitWatchHeal`. WE armed a watch on a unit that turned out
 *      to be in stock; prune only the watches we created ourselves, keep the customer's.
 *   3. `model_prune`     — the `/internal/worker/watch-prune/:id` repair endpoint. A data fix: drop
 *      the watches naming these models, keep the rest.
 *   4. `vin_normalize`   — the `/internal/worker/watch-normalize-vin` repair endpoint. Strips VIN
 *      trim codes out of watch models and dedupes what collapses together, so it REMOVES watches
 *      too. The queue could not see this lane until lane 3 was refereed — refereeing 3 un-collapsed
 *      it, the adjacency artifact this program has now hit five times.
 *
 * TWO DIVERGENCES, PRESERVED AND NAMED — measured against the live store 2026-08-04 (802
 * conversations, 90 carrying a watch array, 89 carrying the singular mirror, 0 mismatched mirrors):
 *
 *   D1 — EMPTY ARRAY vs UNDEFINED, when nothing survives. The heal lane collapses to `undefined`;
 *   the prune lane writes the empty array it computed. **1 lead carries an empty array today.**
 *   Readers split on it: the `Array.isArray(x) ? x : …` idiom treats `[]` as "no watches", but a
 *   plain truthiness test reads it as "has watches". The only reader doing the latter today is the
 *   Langfuse telemetry payload's `hasInventoryWatch` (index.ts) — an observability field, not a
 *   decision. So D1 is real but currently costs a wrong flag in a trace, nothing customer-facing.
 *
 *   D2 — THE PENDING FLAG. `inventoryWatchPending` means "we are waiting to hear WHICH bike".
 *   customer_stop always clears it; held_guard_heal clears it only when nothing survives;
 *   model_prune never touches it — so a fully-pruned lead can still be flagged as owing us an
 *   answer about a watch it no longer has. **3 leads carry the pending flag today and all 3 have
 *   no watch at all**, which is this shape (it has other doors too). Partly self-healing:
 *   `reduceStaleWorkflowStateForInbound` clears a stale pending on the next inbound.
 *
 *   D3 — THE MIRROR, between the two sibling repair endpoints. `model_prune` repoints the singular
 *   mirror ONLY when the mirror itself was pruned, leaving a survivor byte-identical;
 *   `vin_normalize` re-derives it every run from the cleaned model name (falling back to the first
 *   survivor). Both are defensible for their own job — one is surgical, one is a rewrite — so both
 *   are preserved behind `mirrorRule` rather than normalized into a single answer.
 *
 * NOT A DIVERGENCE — pinned so a later tidy-up does not flatten it. The three lanes leave the lead
 * in deliberately different places, because they are answers to three different events.
 * customer_stop pauses the lead indefinitely, stops the chase and steps the dialog back; the heal
 * does the OPPOSITE (its caller restores active mode and resumes the chase) because it exists to
 * undo OUR mistake; the repair endpoint touches neither, because a data fix is not a customer
 * event. Merging their aftermath would be the bug, not the cleanup.
 *
 * KNOWN GAP, NOT FIXED HERE (its own PR): no lane un-parks a lead whose last watch just left. A
 * lead sits in `followUp.mode = "holding_inventory"` / reason `inventory_watch` with zero watches,
 * frozen for a watch that no longer exists (+15856048591, found 2026-08-04). This referee is the
 * place that fix will hang off once it exists — every disarm now passes through one door.
 */
export type InventoryWatchDisarmLane =
  | "customer_stop"
  | "held_guard_heal"
  | "model_prune"
  | "vin_normalize";

/**
 * How the singular `inventoryWatch` mirror is repointed. The two repair endpoints differ here and
 * it is not cosmetic: `only_if_pruned` leaves a surviving mirror byte-identical, while
 * `caller_picks` re-derives it every time from the cleaned model name.
 */
export type InventoryWatchMirrorRule = "first" | "only_if_pruned" | "caller_picks";

export type InventoryWatchDisarmInput = {
  lane: InventoryWatchDisarmLane;
  /** How many watches survive this disarm. */
  remainingCount: number;
};

export type InventoryWatchDisarmDecision = {
  /** What an EMPTY survivor list is written as — divergence 1. */
  emptyListShape: "empty_array" | "undefined";
  /** How to repoint the singular mirror. */
  mirrorRule: InventoryWatchMirrorRule;
  /** Clear `inventoryWatchPending` — divergence 2. */
  clearPending: boolean;
  /** The aftermath. `null` = this lane leaves the lead's mode and chase alone. */
  followUpMode: "paused_indefinite" | null;
  stopCadence: boolean;
  /** Step the dialog back out of a watch state, when it is in one. */
  stepDialogBack: boolean;
  divergence: string | null;
  why: string;
};

/** Pure. */
export function decideInventoryWatchDisarm(
  input: InventoryWatchDisarmInput
): InventoryWatchDisarmDecision {
  const remaining = Math.max(0, Number(input.remainingCount) || 0);
  if (input.lane === "customer_stop") {
    return {
      emptyListShape: "undefined",
      mirrorRule: "first",
      clearPending: true,
      followUpMode: "paused_indefinite",
      stopCadence: true,
      stepDialogBack: true,
      divergence: null,
      why: "customer_stop: the customer asked us to stop watching — every watch goes and the lead parks"
    };
  }
  if (input.lane === "held_guard_heal") {
    return {
      emptyListShape: "undefined",
      mirrorRule: "first",
      // Divergence 2, the conservative half: only clear "which bike?" when nothing is left to ask about.
      clearPending: remaining === 0,
      followUpMode: null,
      stopCadence: false,
      stepDialogBack: false,
      divergence: null,
      why:
        remaining === 0
          ? "held_guard_heal: our own held-unit watch was wrong and nothing survives it — the record clears"
          : `held_guard_heal: our own held-unit watch was wrong; ${remaining} customer watch(es) survive untouched`
    };
  }
  // Both remaining lanes are DATA REPAIRS on the worker endpoints and share an answer: store the
  // list you computed, touch nothing about the lead. They differ only on the mirror — that is D3.
  return {
    // Divergence 1 — a repair stores the empty list it computed rather than collapsing it.
    emptyListShape: "empty_array",
    mirrorRule: input.lane === "model_prune" ? "only_if_pruned" : "caller_picks",
    // Divergence 2 — a data repair never claims to know whether the customer still owes us an answer.
    clearPending: false,
    followUpMode: null,
    stopCadence: false,
    stepDialogBack: false,
    divergence:
      input.lane === "model_prune"
        ? remaining === 0
          ? "model_prune_stores_an_empty_array_and_leaves_the_pending_flag_standing"
          : "model_prune_leaves_the_pending_flag_standing"
        : "vin_normalize_rederives_the_mirror_where_its_sibling_repair_leaves_a_survivor_alone",
    why: `${input.lane}: data repair — ${remaining} watch(es) kept; the lead's mode, chase and pending flag are not this lane's business`
  };
}

/**
 * WHERE IS THIS FINANCE OUTCOME IN THE MANAGER-NOTIFICATION LIFECYCLE?
 *
 * `conv.financeOutcomeNotify` is the record behind the business-manager loop: we mint a reply
 * token, text the manager "what happened with the financing?", and stamp what came back. Seven
 * places used to hand-write that record — the token mint, the parsed-outcome write, the prompt
 * sender, the notification sender, the public outcome link (pending + resolved) and the staff-SMS
 * reply lane (pending + resolved). They now all ask here.
 *
 * The lanes deliberately write DIFFERENT field sets; that is the whole reason a referee is worth
 * having, because the differences were invisible while they sat 20,000 lines apart.
 *
 * DIVERGENCE 1 — THE TWO "PENDING" LANES DO NOT AGREE ON THE RECORD. A manager who answers the
 * public link with PENDING gets `status:"pending"` + `pendingAt`. A manager who TEXTS back
 * "pending" / "no answer" / "left a voicemail" gets `outcomePendingAt` and NO `status` at all.
 * `scripts/outcome_qa_audit.ts` reports a pending outcome only when it sees `status === "pending"`
 * AND `pendingAt`, so the texted answer never reaches the QA report. Preserved, not merged: the
 * blast radius is a REPORT, and normalizing it would start writing a `status` the SMS lane has
 * never written. **Measured 2026-08-04: 807 conversations, 67 carry this record, and ZERO carry
 * either pending shape — so this is a portability defect, not a live one.**
 *
 * DIVERGENCE 2 — THE TWO "RESOLVED" LANES STAMP DIFFERENT FIELD NAMES for the same event: the
 * public link writes `outcomePromptRespondedAt`, the staff SMS writes `outcomePromptResolvedAt`.
 * Both have ZERO consumers (grep-verified across services/api, scripts, apps/web, packages), so
 * nothing today can tell them apart — but both HAVE fired in production (4 responded / 1 resolved),
 * so anything later built on "when did the manager answer?" would silently see a fifth of the truth.
 *
 * DIVERGENCE 3 — `notify_sent` IS THE ONLY LANE THAT DOES NOT BUMP `updatedAt`. That field is the
 * second-choice freshness input to the staff-SMS token matcher (index.ts, after
 * `outcomePromptSentAt` and before `conv.updatedAt`), so it can only matter on a record whose ONLY
 * event was an outbound notification — and `saveConversation` moves `conv.updatedAt` regardless.
 * Preserved rather than tidied: adding a stamp would widen the window in which an old token still
 * matches a staff reply, which is the fail-toward-acting direction.
 *
 * NOT A DIVERGENCE, pinned so a later tidy-up does not "fix" it: `token_mint` keeps an existing
 * token instead of replacing it, and `prompt_sent` keeps an existing `userId` when the caller has
 * no better one. Both are deliberate — the token is what an inbound staff SMS is matched against
 * (index.ts `isFinanceOutcomeTokenForConversation`), so re-minting one would strand a manager who
 * is mid-reply, and blanking `userId` would lose the attribution the matcher falls back on.
 */
export type FinanceOutcomeNotifyLane =
  | "token_mint"
  | "outcome_signal"
  | "prompt_sent"
  | "notify_sent"
  | "public_link_pending"
  | "public_link_resolved"
  | "staff_sms_pending"
  | "staff_sms_resolved";

/** Which "the manager answered" timestamp a lane stamps — divergence 2. */
export type FinanceOutcomeAnswerStamp = "responded" | "resolved" | "pending_only" | null;

export type FinanceOutcomeNotifyInput = {
  lane: FinanceOutcomeNotifyLane;
  /** `outcome_signal` only: the parsed outcome being recorded. */
  outcomeStatus?: "approved" | "declined" | "needs_more_info" | null;
  /** `notify_sent` only: which manager notification just went out. */
  sentStatus?: "approved" | "declined" | "needs_more_info" | null;
};

export type FinanceOutcomeNotifyDecision = {
  /** Mint a reply token when the record has none (never replace one). */
  mintToken: boolean;
  /** What to write into `status`; `null` = leave whatever is there. */
  status: "approved" | "declined" | "needs_more_info" | "pending" | null;
  /** Stamp `pendingAt` — the public link's half of divergence 1. */
  stampPendingAt: boolean;
  /** Which "the manager answered" clock this lane stamps — divergence 2. */
  answerStamp: FinanceOutcomeAnswerStamp;
  /** Record the outbound prompt (sent-at, source id, assignee, phone). */
  stampPromptSent: boolean;
  /** Which per-status "we already told the manager" latch to set; `null` = none. */
  sentLatch: "approvedSentAt" | "declinedSentAt" | "needsInfoSentAt" | null;
  /** Bump `updatedAt` — every lane but `notify_sent` (divergence 3). */
  touchUpdatedAt: boolean;
  divergence: string | null;
  why: string;
};

/** Pure. */
export function decideFinanceOutcomeNotifyState(
  input: FinanceOutcomeNotifyInput
): FinanceOutcomeNotifyDecision {
  const base = {
    mintToken: false,
    status: null,
    stampPendingAt: false,
    answerStamp: null,
    stampPromptSent: false,
    sentLatch: null,
    touchUpdatedAt: true,
    divergence: null
  } as const;
  switch (input.lane) {
    case "token_mint":
      return {
        ...base,
        mintToken: true,
        // The mint is the one lane that predates the record; it stamps nothing else, including the
        // clock, because "we generated a token" is not yet an event in the manager's lifecycle.
        touchUpdatedAt: false,
        why: "token_mint: give this conversation a reply token if it has none — never replace one"
      };
    case "outcome_signal":
      return {
        ...base,
        status: input.outcomeStatus ?? null,
        why: `outcome_signal: a finance outcome of ${input.outcomeStatus ?? "unknown"} was recorded`
      };
    case "prompt_sent":
      return {
        ...base,
        stampPromptSent: true,
        why: "prompt_sent: the outcome prompt went out — record when, off what, to whom"
      };
    case "notify_sent":
      return {
        ...base,
        sentLatch:
          input.sentStatus === "declined"
            ? "declinedSentAt"
            : input.sentStatus === "approved"
              ? "approvedSentAt"
              : "needsInfoSentAt",
        // Divergence 3.
        touchUpdatedAt: false,
        divergence: "notify_sent_does_not_bump_updated_at",
        why: `notify_sent: the ${input.sentStatus ?? "needs_more_info"} notification went out — latch it so it goes out once`
      };
    case "public_link_pending":
      return {
        ...base,
        status: "pending",
        stampPendingAt: true,
        answerStamp: "responded",
        // Divergence 1, the half the QA audit can see.
        divergence: "public_link_pending_writes_a_status_the_staff_sms_lane_never_writes",
        why: "public_link_pending: the manager pressed PENDING on the link — status + pendingAt"
      };
    case "public_link_resolved":
      return {
        ...base,
        answerStamp: "responded",
        why: "public_link_resolved: the manager answered on the link; the outcome itself is written by outcome_signal"
      };
    case "staff_sms_pending":
      return {
        ...base,
        stampPendingAt: false,
        answerStamp: "pending_only",
        // Divergence 1, the half nothing reports on.
        divergence: "staff_sms_pending_stamps_only_outcome_pending_at_so_the_qa_audit_never_sees_it",
        why: "staff_sms_pending: the manager texted back that it is still pending — outcomePendingAt only"
      };
    default:
      return {
        ...base,
        answerStamp: "resolved",
        // Divergence 2.
        divergence: "staff_sms_resolved_stamps_a_different_answer_clock_than_the_public_link",
        why: "staff_sms_resolved: the manager texted back a real outcome; the outcome itself is written by outcome_signal"
      };
  }
}

/**
 * DID WE ALREADY ASK THIS CUSTOMER ABOUT THIS APPOINTMENT, AND WHAT MARKS THAT WE DID?
 *
 * Two prompts hang off a booked appointment and each leaves a mark that stops it repeating:
 * the 24-hour YES/NO confirmation text (`appointment.confirmation`) and the internal
 * "did the customer show?" question we put to staff afterwards (`attendanceQuestionedAt`).
 * EIGHT places used to write those marks by hand — six byte-identical copies of the same
 * five-line "pending" block inside the reminder sender, the customer's YES/NO reply, and the
 * attendance ask. They now all ask here.
 *
 * WHY THE MARK MATTERS MORE THAN IT LOOKS: `processAppointmentConfirmations` skips any
 * appointment whose `confirmation.sentAt` is set, so the mark IS the "only ask once" rule. A
 * lane that forgot to stamp it would re-text the same customer every pass.
 *
 * DIVERGENCE 1 — THREE OF THE SIX REMINDER COPIES STAMP "SENT" WITHOUT SENDING. Each delivery
 * mode (draft/suggest, live Twilio, undelivered fallback) first checks `isRecentDuplicateOutbound`
 * and, on a hit, stamps the record and `continue`s WITHOUT appending an outbound. Preserved,
 * because a duplicate hit means the same text went out through another path inside 10 minutes —
 * the customer HAS been asked. Named so nobody later "fixes" it into re-texting.
 *
 * DIVERGENCE 2 — THE ANSWER LANE SPREADS THE EXISTING RECORD (`...confirmation`) where the
 * sender REPLACES it. That is what keeps `sentAt` and the trigger metadata alive next to the
 * answer, so "asked at X, answered at Y" survives; a replace would erase the ask.
 *
 * NOT A DIVERGENCE, pinned as such: the attendance lane stamps a bare clock and no status, because
 * the question goes to STAFF, not the customer — there is no YES/NO coming back down this channel
 * to record. Giving it a status shape to match its sibling would invent a state nothing sets.
 */
export type AppointmentPromptLane =
  | "confirmation_reminder_sent"
  | "confirmation_answer"
  | "attendance_question_asked";

export type AppointmentPromptRecordInput = {
  lane: AppointmentPromptLane;
  /** `confirmation_answer` only: what the customer replied. */
  answer?: "yes" | "no" | null;
};

export type AppointmentPromptRecordDecision = {
  /** What `confirmation.status` becomes; `null` = this lane does not touch the confirmation. */
  confirmationStatus: "pending" | "confirmed" | "declined" | null;
  /** Stamp `confirmation.sentAt` — the "only ask once" mark. */
  stampSentAt: boolean;
  /** Stamp `confirmation.respondedAt`. */
  stampRespondedAt: boolean;
  /** Keep the existing confirmation fields alongside the new ones — divergence 2. */
  preserveExistingConfirmation: boolean;
  /** Carry the sender's trigger metadata onto the record. */
  carryTriggerMeta: boolean;
  /** Stamp `attendanceQuestionedAt`. */
  stampAttendanceQuestionedAt: boolean;
  divergence: string | null;
  why: string;
};

/** Pure. */
export function decideAppointmentPromptRecord(
  input: AppointmentPromptRecordInput
): AppointmentPromptRecordDecision {
  if (input.lane === "confirmation_reminder_sent") {
    return {
      confirmationStatus: "pending",
      stampSentAt: true,
      stampRespondedAt: false,
      // The sender REPLACES the record — there is nothing to keep, it only runs when sentAt is blank.
      preserveExistingConfirmation: false,
      carryTriggerMeta: true,
      stampAttendanceQuestionedAt: false,
      // Divergence 1 — three of the six copies reach this on a suppressed duplicate.
      divergence: "confirmation_reminder_marks_sent_even_when_a_duplicate_suppressed_the_send",
      why: "confirmation_reminder_sent: the 24h YES/NO ask is out — mark it pending so it is asked once"
    };
  }
  if (input.lane === "confirmation_answer") {
    return {
      confirmationStatus: input.answer === "yes" ? "confirmed" : "declined",
      stampSentAt: false,
      stampRespondedAt: true,
      // Divergence 2 — keep the ask (sentAt + trigger meta) next to the answer.
      preserveExistingConfirmation: true,
      carryTriggerMeta: false,
      stampAttendanceQuestionedAt: false,
      divergence: null,
      why: `confirmation_answer: the customer replied ${input.answer === "yes" ? "YES" : "NO"} to the 24h ask`
    };
  }
  return {
    confirmationStatus: null,
    stampSentAt: false,
    stampRespondedAt: false,
    preserveExistingConfirmation: true,
    carryTriggerMeta: false,
    stampAttendanceQuestionedAt: true,
    divergence: null,
    why: "attendance_question_asked: staff were asked whether the customer showed — stamp it so we ask once"
  };
}

/**
 * HOW SPECIFIC IS THIS WATCH? — `inventoryWatch.exactness`.
 *
 * TEN places in `index.ts` (plus one repair script) each carried their own copy of the same
 * three-rung ladder: a year RANGE means a model range, a year PLUS a distinguishing detail means
 * an exact unit, a bare year means year+model, and anything less stays model-only. They now all
 * ask here.
 *
 * MEASURED BEFORE WRITING THIS (and it is the reason the divergences below are preserved rather
 * than fixed): **`exactness` has ZERO readers.** Nothing in `services/api/src` or `apps/web`
 * consults it — grep-verified — so it is a descriptive field today, not a matching input.
 * That makes the two disagreements below free to keep AND free to get wrong later, which is
 * exactly why they are named on the decision instead of quietly normalised.
 *
 * DIVERGENCE 1 — THE MODEL-RANGE RUNG IS MISSING FROM SEVEN OF THE TEN LANES. Only the ADF
 * multi-watch build, the context-note build and the manual-outbound list recognise
 * `yearMin`+`yearMax` as "model range"; on the other seven a year range falls through to
 * model-only. Preserved per lane behind `recognisesYearRange`.
 *
 * DIVERGENCE 2 — WHAT COUNTS AS "DISTINGUISHING". Eight lanes accept a COLOUR **or** a TRIM
 * ("2023 Road Glide CVO" is exact); two — the seller-intake list builders — accept a colour only,
 * so the same customer's trim-only watch reads year_model there. Preserved behind
 * `trimCountsAsDistinguishing`.
 *
 * FAIL DIRECTION, worth stating because it is not the usual one: an exactness that reads TOO
 * SPECIFIC would, the day something consumes it, narrow which arrivals we alert a customer about
 * — i.e. fail toward silence. So when a lane's rule is in doubt the ladder must fall DOWN
 * (model_only), never up, and every rung below requires strictly more evidence than the one under it.
 */
export type InventoryWatchExactness = "exact" | "year_model" | "model_range" | "model_only";

export type InventoryWatchExactnessInput = {
  /** A single pinned model year. */
  year?: number | string | null;
  /** A pinned year RANGE. */
  yearMin?: number | string | null;
  yearMax?: number | string | null;
  color?: string | null;
  trim?: string | null;
  /** Divergence 1 — does this lane read a year range as a model range? */
  recognisesYearRange: boolean;
  /** Divergence 2 — does a TRIM count as distinguishing, or only a colour? */
  trimCountsAsDistinguishing: boolean;
};

export type InventoryWatchExactnessDecision = {
  /** `null` = this lane's ladder does not fire; the caller's existing value stands. */
  exactness: InventoryWatchExactness | null;
  divergence: string | null;
  why: string;
};

// ---------------------------------------------------------------------------
// Voicemail -> staff follow-up task
//
// Operator report 2026-07-31 (+15416478489, Mark Griffin): "there is a watch on this. it should
// not have a task." The lead asked for a used 2023 Fat Bob, we armed an inventory watch, and the
// chase was DELIBERATELY stopped because of that watch (followUp.mode=holding_inventory,
// cadence stopped with reason inventory_watch). A later outbound call hit voicemail and the
// generic 2nd-attempt arm minted a "Call customer (follow-up)" task anyway — a lead in the staff
// inbox with nothing for staff to do. It then escalated, and the operator closed it four seconds
// after filing the report.
//
// The three voicemail arms in /webhooks/twilio/voice/recording each hand-answered "does this mint
// a task"; this is the one referee they now ask.
//
// FAIL DIRECTION — this suppression can lose work, so it fails toward KEEPING the task. After the
// task is suppressed the watch fire is the only remaining touch (the cadence is stopped and
// decideCadenceHoldTtlResume refuses to resume it), so a loose predicate silently buries leads.
// Hence the four-clause conjunction below. Measured against the live store: of the 16 voicemail
// 2nd-attempt tasks ever minted it suppresses exactly one — the reported lead. The two near-misses
// it must spare are why each clause is load-bearing:
//   - +17162458986 has an active watch from April but followUp.mode="active" — a stale watch on an
//     otherwise normal lead. A watch-only predicate would wrongly bury it.
//   - +15856048591 is holding_inventory/inventory_watch with ZERO watch records — held for a watch
//     that no longer exists, so the call task is the only thing keeping it alive. A mode-only
//     predicate would wrongly bury it (twice).
//
// NARROWED 2026-08-04 by Joe's ruling on the same operator report, verbatim: "Suppress when there
// is a callback voicemail on a watch unless it is an additional lead or the customer shows interest
// in something else." Being parked is necessary but NOT sufficient — the watch only owns the
// follow-up while the watch is the whole story. Two more clauses carry the "unless":
//   - customerContactSinceWatchArmed = "an additional lead". Anything the customer has said since
//     we started watching is by definition not covered by the watch.
//   - openWorkBeyondWatch = "interest in something else". Another open task, or a booked
//     appointment, is work the watch does not own.
// Both read state we already comprehended upstream, so this gate never re-reads the customer's
// words and cannot decay into a keyword test.
//
// These are not theoretical. Measured against the live store on 2026-08-04: 47 conversations are
// parked on a live watch, and 11 of them (23%) hit one of the two carve-outs — including
// +12399612259 asking an unanswered question ("remind me again what address is this at?"),
// +17164819192 saying "it's a bit high mileage for me. I am considering something new as of
// recent", and three leads with an appointment already on the books. Without these clauses a
// voicemail to any of those 11 would leave the watch as the lead's only remaining touch.
// ---------------------------------------------------------------------------

export type VoicemailFollowUpTaskLane =
  /** The CUSTOMER called us and left a voicemail. */
  | "inbound_voicemail"
  /** Outbound call to a manual finance handoff — also restarts the finance cadence. */
  | "outbound_finance_handoff"
  /** Outbound call to any other conversation (Joe-approved 2026-07-02, 2nd-attempt task). */
  | "outbound_generic";

export type VoicemailFollowUpTaskInput = {
  lane: VoicemailFollowUpTaskLane;
  /** An open followup/call todo already covers this lead. */
  hasOpenFollowUpTask: boolean;
  /** Count of ACTIVE inventory watches on the lead. */
  activeInventoryWatchCount: number;
  /** conv.followUp?.mode */
  followUpMode: string | null | undefined;
  /** conv.followUp?.reason */
  followUpReason: string | null | undefined;
  /** Joe's "an additional lead": any inbound from the customer since the newest watch was armed. */
  customerContactSinceWatchArmed: boolean;
  /** Joe's "interest in something else": another open task, or a booked appointment. */
  openWorkBeyondWatch: boolean;
};

export type VoicemailFollowUpTaskDecision = {
  create: boolean;
  reason:
    | "created"
    | "existing_open_task"
    | "parked_on_inventory_watch"
    | "additional_lead"
    | "interest_beyond_watch";
  why: string;
};

/** Pure. */
export function resolveInventoryWatchExactness(
  input: InventoryWatchExactnessInput
): InventoryWatchExactnessDecision {
  const hasRange = !!input.yearMin && !!input.yearMax;
  const hasYear = !!input.year;
  const distinguishing = !!input.color || (input.trimCountsAsDistinguishing && !!input.trim);
  if (input.recognisesYearRange && hasRange) {
    return {
      exactness: "model_range",
      divergence: null,
      why: "a pinned year RANGE describes a span of model years, not one unit"
    };
  }
  if (hasYear && distinguishing) {
    return {
      exactness: "exact",
      divergence: null,
      why: "a year plus a colour or trim names one unit closely enough to call it exact"
    };
  }
  if (hasYear) {
    return {
      exactness: "year_model",
      // Divergence 2 is named HERE, where it actually bites: this lane is holding a trim it does
      // not count, so it lands a rung lower than the eight lanes that do.
      divergence:
        !input.trimCountsAsDistinguishing && !!input.trim
          ? "this lane ignores TRIM, so a trim-only watch reads year_model where eight other lanes read exact"
          : null,
      why: "a bare year pins the model year, nothing finer"
    };
  }
  // Every original ladder ENDS here with no `else` — the caller's literal already defaults to
  // model_only, and a lane with a year range it does not recognise falls through to exactly that.
  return {
    exactness: null,
    divergence:
      !input.recognisesYearRange && hasRange
        ? "this lane does not recognise a year RANGE, so the watch stays model_only"
        : null,
    why: "nothing pins a year — the caller's model_only default stands"
  };
}

/**
 * THE LEGACY SINGULAR WATCH AND THE LIST — which is the truth, and does reading it repair the record?
 *
 * A conversation may carry `inventoryWatch` (the original single watch), `inventoryWatches` (the
 * list that replaced it), or both. Two alert paths — the watchlist sweep and the
 * available-item notifier — each hand-wrote the same eight lines: prefer a non-empty list,
 * otherwise wrap the singular, and if the list was missing entirely, backfill it from the singular.
 * They now both ask here.
 *
 * The backfill is a HEAL, and its guard is deliberately `!conv.inventoryWatches` (missing), NOT
 * `!conv.inventoryWatches?.length` (missing or empty): an explicitly EMPTY list is a record that
 * says "this lead has no watches", and re-populating it from a stale singular would resurrect a
 * watch a disarm lane just took off. See `decideInventoryWatchDisarm`, whose repair lanes store
 * exactly that empty array.
 */
export type InventoryWatchListNormalizationInput = {
  /** `undefined` = no list field at all; `[]` = an explicitly empty list. */
  listLength: number | null;
  hasSingular: boolean;
};

export type InventoryWatchListNormalizationDecision = {
  /** Which source the caller should read this turn. */
  source: "list" | "singular" | "none";
  /** Write the singular into the list field — only when the list is absent entirely. */
  backfillListFromSingular: boolean;
  why: string;
};

/** Pure. */
export function resolveInventoryWatchListNormalization(
  input: InventoryWatchListNormalizationInput
): InventoryWatchListNormalizationDecision {
  const listLength = input.listLength;
  if (listLength !== null && listLength > 0) {
    return { source: "list", backfillListFromSingular: false, why: "the list has entries — it is the truth" };
  }
  if (!input.hasSingular) {
    return { source: "none", backfillListFromSingular: false, why: "no list entries and no legacy singular" };
  }
  return {
    source: "singular",
    // Only when the list field is ABSENT. An empty list is a statement, not a gap.
    backfillListFromSingular: listLength === null,
    why:
      listLength === null
        ? "legacy record: only the singular exists — read it and backfill the list"
        : "an explicitly EMPTY list stands; read the singular this turn but do not resurrect it into the list"
  };
}

/** Pure. */
export function decideVoicemailFollowUpTask(
  input: VoicemailFollowUpTaskInput
): VoicemailFollowUpTaskDecision {
  if (input.hasOpenFollowUpTask) {
    return {
      create: false,
      reason: "existing_open_task",
      why: `${input.lane}: an open followup/call task already covers this lead`
    };
  }
  // Only the generic outbound arm parks. The inbound lane is the CUSTOMER reaching out — that
  // always earns a callback task. The finance handoff arm restarts the finance cadence in the same
  // breath, so its task is the cadence's own next step, not a duplicate of a watch.
  const parked =
    input.lane === "outbound_generic" &&
    Number(input.activeInventoryWatchCount) > 0 &&
    input.followUpMode === "holding_inventory" &&
    String(input.followUpReason || "").includes("inventory_watch");
  if (parked) {
    // Joe 2026-08-04, the two "unless" clauses. Being parked is necessary, not sufficient: the
    // watch only owns the follow-up while the watch is the WHOLE story. Checked in this order so
    // the recorded reason names the thing that actually saved the task.
    if (input.customerContactSinceWatchArmed) {
      return {
        create: true,
        reason: "additional_lead",
        why: `${input.lane}: parked on a watch, but the customer has been in touch since it was armed — that is an additional lead the watch does not cover`
      };
    }
    if (input.openWorkBeyondWatch) {
      return {
        create: true,
        reason: "interest_beyond_watch",
        why: `${input.lane}: parked on a watch, but another open task or a booked appointment is work the watch does not own`
      };
    }
    return {
      create: false,
      reason: "parked_on_inventory_watch",
      why: `${input.lane}: the lead is parked on an active inventory watch and the chase is stopped for that reason — the watch fire is the intended next touch`
    };
  }
  return {
    create: true,
    reason: "created",
    why: `${input.lane}: no open task and the lead is not parked on a watch — mint the follow-up`
  };
}

// ===================================================================================================
// THE CHASE JUST TOOK A RUNG — "what does that write, and does the ladder end here?"
//
// `advanceFollowUpCadence` (conversationStore) is the last unrefereed writer of `followUpCadence`
// that carries real logic, and every rule it applies lived only inside its own body:
//
//   - WHICH LADDER this chase is climbing. Six shapes behind four `kind` values, because two of
//     them are picked off the follow-up REASON and a context tag rather than the kind:
//     post_sale, engaged, finance-declined long-term, private-party-sell long-term, plain
//     long-term, and the standard ramp.
//   - WHETHER THIS RUNG COUNTS AS A TOUCH. Four gates advance the schedule while staying completely
//     silent (cadence-quality suppress, the value gate and its repeat backstop, the past-dated-event
//     guard). A silent rung still BURNS — we tried it and had nothing worth saying — but it must not
//     stamp `lastSentAt`/`lastSentStep` as though a customer heard from us, and it must not spend a
//     touch against the taper.
//   - WHETHER THE LADDER ENDS HERE, by either of two completely different routes: the disengagement
//     taper (a never-engaged sales lead at or past the give-up threshold) or the ride-challenge
//     final-mileage reminder, which is a one-shot and completes as soon as it fires.
//
// THE PRE-INCREMENT RULE IS LOAD-BEARING, and until now it lived in a comment. The taper is judged
// on the touch count BEFORE this one — the same number `shouldSendDisengagedCloseout` was asked — so
// the rung that SENDS the goodbye is exactly the rung that ends the ladder. Compare the
// post-increment count and the sequence ends one touch early, i.e. the lead is retired without ever
// being said goodbye to. That is not a tidy-up detail; it is the difference between a customer
// getting a close-out and going silent, and it now has a name and an eval row.
//
// FAIL DIRECTION. Ending a ladder is the direction that sends FEWER messages, so it is the safe one
// — except for the close-out itself, which is the message that ends things politely. Hence: only a
// DELIVERED touch (or an explicit `endSequence`) may trip the taper, because ending from a silent
// gate retires the lead without the goodbye. An unknown ladder falls back to the standard ramp
// rather than completing, since completing on a shape we did not recognise would drop the chase.
//
// PURE + CLOCK-FREE: the caller reads the clock, resolves engagement, and owns the day-offset
// tables; this decides the SHAPE of the rung.
// ===================================================================================================

/** The six ladder shapes. The caller maps each to its day-offset table. */
export type CadenceAdvanceLadder =
  | "post_sale"
  | "engaged"
  | "finance_declined_long_term"
  | "private_party_sell_long_term"
  | "long_term"
  | "standard";

export type CadenceAdvanceInput = {
  /** The chase's kind, exactly as stored. */
  kind?: string | null;
  /** `followUp.reason`, which is what splits plain long-term from its two special ladders. */
  followUpReason?: string | null;
  /** `followUpCadence.contextTag` — the second way a private-party-sell chase identifies itself. */
  contextTag?: string | null;
  /** `followUpCadence.deferredMessage` — the ride-challenge one-shot names itself here. */
  deferredMessage?: string | null;
  /** The rung the chase is on right now. */
  stepIndex?: number | null;
  /** Touches that ACTUALLY went out before this one. Silent rungs are not in this count. */
  deliveredTouchesBefore?: number | null;
  /** Did this rung produce a message? Defaults TRUE — only the four silent gates pass false. */
  delivered?: boolean;
  /** The one exception that may end the ladder from a silent rung: the close-out was withheld. */
  endSequence?: boolean;
  /** Has the customer ever replied to this chase? */
  customerEngaged?: boolean;
  /** `DISENGAGED_TAPER_AFTER_TOUCHES`, handed in so the referee stays free of store constants. */
  taperAfterTouches: number;
};

export type CadenceAdvanceDecision = {
  /** Stamp `lastSentAt` / `lastSentStep` / `deliveredTouches`. False on a silent rung. */
  stampDelivered: boolean;
  /** The rung the chase moves to. Always written, delivered or not — a silent rung still burns. */
  nextStepIndex: number;
  /** The touch count AFTER this one. Only written when `stampDelivered`. */
  deliveredTouchesAfter: number;
  /** End the ladder here, before any due-date maths. Null means climb on. */
  endNow: null | {
    /** `disengaged_taper` writes a stopReason; the ride-challenge one-shot deliberately does not. */
    stopReason: "disengaged_taper" | null;
    cause: "disengaged_taper" | "ride_challenge_final_mileage";
  };
  /** Which day-offset table this chase climbs. The caller owns the tables. */
  ladder: CadenceAdvanceLadder;
  /** Post-sale due dates are computed by a different function. */
  usesPostSaleDueAt: boolean;
  why: string;
};

const CADENCE_ADVANCE_RIDE_CHALLENGE_ONE_SHOT = "ride_challenge_final_mileage";

const lowerTrim = (value: unknown): string => String(value ?? "").trim().toLowerCase();

export function decideCadenceAdvance(input: CadenceAdvanceInput): CadenceAdvanceDecision {
  const kind = lowerTrim(input.kind);
  const isPostSale = kind === "post_sale";
  const isEngaged = kind === "engaged";
  const isLongTerm = kind === "long_term";
  const reason = lowerTrim(input.followUpReason);
  const contextTag = lowerTrim(input.contextTag);

  const delivered = input.delivered !== false;
  const stepIndex = Number(input.stepIndex);
  const currentStep = Number.isFinite(stepIndex) ? stepIndex : 0;
  const before = Number(input.deliveredTouchesBefore);
  const deliveredBefore = Number.isFinite(before) && before >= 0 ? Math.floor(before) : 0;

  // A never-engaged SALES lead at or past the give-up threshold. post_sale and long_term chases are
  // exempt: those are dated check-backs, not a chase to give up on.
  const taperApplies =
    (delivered || input.endSequence === true) &&
    !isPostSale &&
    !isLongTerm &&
    input.customerEngaged !== true &&
    deliveredBefore >= input.taperAfterTouches;

  // The ride-challenge final-mileage reminder is a ONE-SHOT: it completes as soon as it has fired,
  // and deliberately records no stopReason — nothing gave up on this lead, the message simply had
  // one job. Checked after the taper, exactly as the original ordering had it.
  const rideChallengeOneShot =
    isLongTerm && lowerTrim(input.deferredMessage) === CADENCE_ADVANCE_RIDE_CHALLENGE_ONE_SHOT;

  const ladder: CadenceAdvanceLadder = isPostSale
    ? "post_sale"
    : isEngaged
      ? "engaged"
      : isLongTerm
        ? reason === "financing_declined"
          ? "finance_declined_long_term"
          : reason === "private_party_seller" || contextTag === "private_party_seller"
            ? "private_party_sell_long_term"
            : "long_term"
        : "standard";

  const endNow = taperApplies
    ? ({ stopReason: "disengaged_taper", cause: "disengaged_taper" } as const)
    : rideChallengeOneShot
      ? ({ stopReason: null, cause: "ride_challenge_final_mileage" } as const)
      : null;

  return {
    stampDelivered: delivered,
    nextStepIndex: currentStep + 1,
    deliveredTouchesAfter: deliveredBefore + 1,
    endNow,
    ladder,
    usesPostSaleDueAt: isPostSale,
    why: endNow
      ? endNow.cause === "disengaged_taper"
        ? `the ${ladder} ladder ends here: ${deliveredBefore} delivered touches with no reply, at or ` +
          `past the give-up threshold of ${input.taperAfterTouches}`
        : "the ride-challenge final-mileage reminder is a one-shot — it has fired, so the chase is done"
      : `${ladder} ladder, rung ${currentStep} -> ${currentStep + 1}` +
        `${delivered ? `, touch ${deliveredBefore + 1} delivered` : ", silent rung (burned, not counted)"}`
  };
}

// ── The last four unrefereed writers of the customer-risk fields ─────────────────────────────
// Everything below arbitrates a piece of state where a mistake can TEXT a customer, CLOSE a lead,
// or BOOK/KILL an appointment. Each was a rule that lived only inside one call site's body.

// 1. STALE BOOKING REPLACEMENT (`appointment`) ───────────────────────────────────────────────
// The rep's own outbound confirms a pending appointment request ("Sounds good! See you then") on a
// record that STILL CARRIES AN EXPIRED BOOKING. The new time is about to be stamped; the question
// is what of the dead booking must not survive it.
//
// The calendar identity fields are the dangerous ones. `bookedEventId` / `bookedEventLink` /
// `bookedCalendarId` point at a Google event for the OLD time; `bookedSalespersonId` / `...Name`
// name whoever owned that slot; `matchedSlot` is the availability row it came from. Leave any of
// them and the record claims the new appointment is the old event — a later cancel or reschedule
// then edits the wrong calendar entry, and the confirmation names the wrong rep.
//
// `whenIso` / `whenText` are deliberately NOT in the wipe list: the caller overwrites both on the
// next line, and blanking them here would leave the record momentarily timeless for no gain.
// `status` is likewise left to `applyAppointmentConfirmRecord`, which owns it.
//
// FAIL DIRECTION = wipe. A cleared field that did not need clearing costs one re-lookup; a stale
// calendar id that survives sends the customer a confirmation for an event at the wrong time.
export type StaleBookingReplacementInput = {
  /** The rep's text confirmed the pending request (decideManualConfirmPendingAppointment). */
  confirmsPendingRequest: boolean;
  /** The booking already on the record is in the past (expired, not live). */
  existingBookedAppointmentIsPast: boolean;
};
export type StaleBookingReplacementDecision = {
  clearBookedEvent: boolean;
  clearBookedSalesperson: boolean;
  clearMatchedSlot: boolean;
  why: string;
};

export function decideStaleBookingReplacement(
  input: StaleBookingReplacementInput
): StaleBookingReplacementDecision {
  // A LIVE booking is never torn down from this lane — that is the dedupe guard's job, and
  // rebooking over a good appointment from a "see you then" text is the failure it exists to stop.
  if (!input.confirmsPendingRequest || !input.existingBookedAppointmentIsPast) {
    return {
      clearBookedEvent: false,
      clearBookedSalesperson: false,
      clearMatchedSlot: false,
      why: input.confirmsPendingRequest
        ? "no expired booking to replace — nothing stale to wipe"
        : "this text did not confirm a pending request"
    };
  }
  return {
    clearBookedEvent: true,
    clearBookedSalesperson: true,
    clearMatchedSlot: true,
    why: "an expired booking is being replaced — its calendar event, owning rep and matched slot all die with it"
  };
}

// 2. HEALTH-RECOVERY PAUSE (`followUpCadence`) ────────────────────────────────────────────────
// A customer who told us they are recovering (surgery, illness, an accident) gets the chase pushed
// out, not stopped. Any inbound from them re-enters this lane, and the rule that matters is that
// an ALREADY-SET later pause WINS: without it, every "thanks" they send while recovering slides the
// pause back to today + N days and the chase creeps forward on someone who is unwell.
//
// FAIL DIRECTION = the LATER date. Waiting too long to re-approach a recovering customer costs
// time; texting them early is the harm this pause exists to prevent. So a pause already standing in
// the future is kept as-is, and only an absent, unparseable or already-past pause is replaced.
export type HealthRecoveryPauseInput = {
  /** The pause currently on the record, if any (ISO string or nullish). */
  currentPausedUntil?: string | null;
  /** now + HEALTH_RECOVERY_DELAY_DAYS, resolved by the caller in the dealer's timezone. */
  fallbackUntilIso: string;
  nowMs: number;
};
export type HealthRecoveryPauseDecision = { pausedUntilIso: string; keptExisting: boolean; why: string };

export function decideHealthRecoveryPause(input: HealthRecoveryPauseInput): HealthRecoveryPauseDecision {
  const current = String(input.currentPausedUntil ?? "").trim();
  const currentMs = current ? new Date(current).getTime() : Number.NaN;
  // A junk date is NOT a pause. Reading an unparseable value as "already paused" would leave the
  // record pausedUntil=Invalid Date and the chase would never resume at all.
  const standingInFuture = Number.isFinite(currentMs) && currentMs > input.nowMs;
  if (standingInFuture) {
    return {
      pausedUntilIso: new Date(currentMs).toISOString(),
      keptExisting: true,
      why: "a recovery pause is already standing in the future — a new inbound must not pull it forward"
    };
  }
  return {
    pausedUntilIso: input.fallbackUntilIso,
    keptExisting: false,
    why: current
      ? "the standing pause is past or unparseable — restart the recovery delay from now"
      : "no recovery pause on the record — start one"
  };
}

// 3. STAFF REOPEN RESIDUE (`followUpCadence`, `followUp`, dialog state) ───────────────────────
// Staff pressed Reopen on an archived thread. `applyCloseoutReversal` reopens the record; this
// referee says what CLOSEOUT RESIDUE has to be undone with it, because a reopen that leaves the
// residue behind is a zombie — the thread reads open while the chase stays dead (Dave Batka,
// 2026-06-11: reopen alone left followUp paused_indefinite / customer_sell_on_own and the cadence
// stopped).
//
// The ORDER is load-bearing. A post-sale chase is BLANKED, and blanking it first is what stops the
// disposition-revive arm below from ever resurrecting a post-sale ladder onto a reopened deal —
// those two arms would otherwise both claim the same record.
//
// FAIL DIRECTION splits by arm, which is why they are separate flags rather than one boolean:
//  - BLANK (post-sale) fails toward NOT messaging: no cadence at all beats a delivery-congrats
//    ladder re-firing at a customer whose sale was just un-done.
//  - REVIVE (disposition) fails toward working the lead: staff pressing Reopen on a lead they
//    themselves archived as "stepping back" is an explicit instruction to chase again.
export const REOPEN_DISPOSITION_REASONS = [
  "customer_sell_on_own",
  "customer_keep_current_bike",
  "customer_stepping_back",
  "customer_deferred"
] as const;

export type StaffReopenResidueInput = {
  /** A cadence RECORD exists. Deliberately separate from `cadenceStatus`, which may be absent. */
  hasCadence: boolean;
  cadenceKind?: string | null;
  cadenceStatus?: string | null;
  cadenceStopReason?: string | null;
  followUpReason?: string | null;
  dialogState?: string | null;
  hasSale: boolean;
};
export type StaffReopenResidueDecision = {
  clearSale: boolean;
  blankPostSaleCadence: boolean;
  clearPostSaleFollowUp: boolean;
  clearDispositionFollowUp: boolean;
  resetDispositionDialogState: boolean;
  reviveDispositionCadence: boolean;
  why: string;
};

function isReopenDispositionReason(raw?: string | null): boolean {
  return (REOPEN_DISPOSITION_REASONS as readonly string[]).includes(String(raw ?? ""));
}

export function decideStaffReopenResidue(input: StaffReopenResidueInput): StaffReopenResidueDecision {
  const blankPostSaleCadence = String(input.cadenceKind ?? "") === "post_sale";
  const clearPostSaleFollowUp = String(input.followUpReason ?? "") === "post_sale";
  const clearDispositionFollowUp = isReopenDispositionReason(input.followUpReason);
  const resetDispositionDialogState = isReopenDispositionReason(input.dialogState);
  // Only a chase that is BOTH stopped and stopped FOR A DISPOSITION is revived — a cadence stopped
  // for any other reason (opt-out, a hold, a handoff) keeps its own stop, and an already-active one
  // is left alone rather than restarted at rung zero.
  //
  // A cadence record with NO status counts as not-active and IS revived. That reads odd but it is
  // exactly what the handler did (`status !== "active"` over a missing status is true), and a
  // statusless record that carries a disposition stopReason is a stopped chase either way — so the
  // literal reading is also the right one. Gating on `hasCadence` rather than on the status being
  // present is what keeps the two the same.
  const reviveDispositionCadence =
    !blankPostSaleCadence &&
    input.hasCadence &&
    String(input.cadenceStatus ?? "") !== "active" &&
    isReopenDispositionReason(input.cadenceStopReason);
  return {
    clearSale: input.hasSale,
    blankPostSaleCadence,
    clearPostSaleFollowUp,
    clearDispositionFollowUp,
    resetDispositionDialogState,
    reviveDispositionCadence,
    why: blankPostSaleCadence
      ? "a post-sale chase does not survive un-doing the sale — blanked, and never revived below"
      : reviveDispositionCadence
        ? `staff reopened a lead they archived as ${String(input.cadenceStopReason)} — restart the chase`
        : "reopen with no cadence residue to undo"
  };
}

// 4. INVENTORY-WATCH DEFAULTS (`inventoryWatch`) ──────────────────────────────────────────────
// A watch the customer just asked for is usually under-specified ("let me know when a Road Glide
// comes in") and the blanks get filled from what we already know. THREE call sites filled them —
// the SMS watch lane, the confirm-a-pending-watch lane, and the live inbound lane — each with its
// own hand-written ladder, and the ladders had drifted.
//
// This is the state that decides WHICH ARRIVING UNIT TEXTS THIS CUSTOMER, so a wrong rung here is
// an unwanted outbound: fill `condition` from a stale lead record and someone who asked for a used
// bike gets alerted about a new one.
//
// THE DIVERGENCE IS CLOSED (ruling 24, adopted 2026-08-07). Until now only the live inbound lane
// consulted the parser's reading of what the customer said THIS TURN (`semanticCondition`); the
// other three skipped that rung and fell straight from the text scan to a possibly-stale LEAD
// RECORD. AGENTS.md parser-first decides it — a typed parser's reading of this turn outranks a
// stored field, and the non-answers below mean it cannot over-attach. All four lanes now pass their
// own lane's accepted parse; `customer_risk_referees:eval` reddens if one goes back to `undefined`.
export type InventoryWatchDefaultsInput = {
  watchMake?: string | null;
  watchTrim?: string | null;
  watchCondition?: string | null;
  leadMake?: string | null;
  leadTrim?: string | null;
  /** normalizeWatchCondition() over the customer's text — the strongest rung. */
  conditionFromText?: "new" | "used" | null;
  /** The parser's condition for THIS turn, from each lane's own accepted parse. All four supply it. */
  semanticCondition?: string | null;
  /** normalizeWatchCondition() over the lead record's condition — the weakest rung. */
  conditionFromLead?: "new" | "used" | null;
};
export type InventoryWatchDefaultsDecision = {
  make?: string;
  trim?: string;
  condition?: string;
  conditionSource: "already_set" | "text" | "parser" | "lead_record" | "none";
};

export function resolveInventoryWatchDefaults(
  input: InventoryWatchDefaultsInput
): InventoryWatchDefaultsDecision {
  // NOT trimmed: the four call sites this replaces tested plain truthiness (`!pref.watch.make`), and
  // a cleanup that starts treating " " as blank would be a behaviour change hiding inside a refactor.
  const has = (v?: string | null) => String(v ?? "").length > 0;
  const out: InventoryWatchDefaultsDecision = { conditionSource: "already_set" };
  // Only ever FILL a blank. The watch the customer described outranks anything we infer for them.
  if (!has(input.watchMake) && has(input.leadMake)) out.make = String(input.leadMake);
  if (!has(input.watchTrim) && has(input.leadTrim)) out.trim = String(input.leadTrim);
  if (has(input.watchCondition)) return out;
  // "unknown" and "any" are the parser saying it could not tell — they are not a condition, and
  // treating them as one would pin the watch to a literal condition the customer never named.
  const semantic =
    has(input.semanticCondition) &&
    input.semanticCondition !== "unknown" &&
    input.semanticCondition !== "any"
      ? String(input.semanticCondition)
      : null;
  if (input.conditionFromText) {
    out.condition = input.conditionFromText;
    out.conditionSource = "text";
  } else if (semantic) {
    out.condition = semantic;
    out.conditionSource = "parser";
  } else if (input.conditionFromLead) {
    out.condition = input.conditionFromLead;
    out.conditionSource = "lead_record";
  } else {
    out.conditionSource = "none";
  }
  return out;
}

// --- ADF sale/trade journey fallback bucket (2026-08-06) -------------------
//
// `sale_trade` is the journey parser's BROAD sales label. Its own prompt defines it as
// "customer is explicitly shopping again, wants to buy, asks for trade/appraisal value, asks
// about availability/pricing/test ride for purchase" — buying and trading share one tag, so the
// tag alone says NOTHING about which of the two this customer wants.
//
// On a default-rule ADF lead the inbound route used to read that tag as a trade appraisal
// whenever no stock/VIN/availability signal was present, and open the first touch with
// "Thanks for using our trade-in estimator on your <bike>". Two reproduced misses, both
// Room58 "Request details" leads whose structured Trade-In field is a form MIRROR of the bike
// they are shopping for (see isMirroredTradeFieldArtifact):
//   - Beth Bremer (Ref 11449): "I sold my sportster several years back ... is the super glide a
//     good option?" — a fit question, answered with a trade appraisal she never asked for.
//   - Brandon Drazinski (Ref 11278): "Do you happen to have a PDF brochure ... just shopping
//     around" — same trade-estimator opening.
//
// This decision is only ever consulted AFTER the explicit trade branch has already declined
// (no trade dialog-act, no trade/sell wording in the inquiry), so the sole remaining honest
// trade evidence is a STRUCTURED trade vehicle that survived the mirror guard.
//
// FAIL DIRECTION: unsure => the shopping bucket. Treating a buyer as a shopper costs us a
// generic availability reply; treating a shopper as a trade-in costs us a fabricated frame —
// we assert a trade the customer never mentioned and never answer what they asked.
// ---------------------------------------------------------------------------
export type SaleTradeJourneyBucketInput = {
  /** journeyIntent === "sale_trade" and the parser verdict was accepted. */
  saleTradeIntentFromParser: boolean;
  /** The bucket the deterministic chain landed on before this fallback. */
  inferredBucket: string;
  /** A routing-parser bucket/cta already won; this fallback must not override it. */
  hasParserBucketCta: boolean;
  /** Stock id / VIN / "available" / availability parser — the customer named a unit. */
  hasStockIntent: boolean;
  /** A structured trade vehicle that SURVIVED isMirroredTradeFieldArtifact. */
  hasStructuredTradeVehicle: boolean;
};

export type SaleTradeJourneyBucketDecision = {
  applies: boolean;
  bucket: "inventory_interest" | "trade_in_sell" | null;
  cta: "check_availability" | "value_my_trade" | null;
};

const NO_SALE_TRADE_JOURNEY_BUCKET: SaleTradeJourneyBucketDecision = {
  applies: false,
  bucket: null,
  cta: null
};

export function decideSaleTradeJourneyBucket(
  input: SaleTradeJourneyBucketInput
): SaleTradeJourneyBucketDecision {
  if (!input.saleTradeIntentFromParser) return NO_SALE_TRADE_JOURNEY_BUCKET;
  if (input.hasParserBucketCta) return NO_SALE_TRADE_JOURNEY_BUCKET;
  if (input.inferredBucket !== "general_inquiry") return NO_SALE_TRADE_JOURNEY_BUCKET;
  // A named unit is a shopping signal, and it outranks a trade field either way.
  if (input.hasStockIntent) {
    return { applies: true, bucket: "inventory_interest", cta: "check_availability" };
  }
  if (input.hasStructuredTradeVehicle) {
    return { applies: true, bucket: "trade_in_sell", cta: "value_my_trade" };
  }
  return { applies: true, bucket: "inventory_interest", cta: "check_availability" };
}

// ---------------------------------------------------------------------------
// Website text-widget SALES classification (Beverly Hennig, +17169839279, operator note
// 2026-08-06: "Someone selling us their bike should not carry an availability tag").
//
// She wrote, through the Sales widget: "Do you take used Harley's on consignment or buy outright?
// I have a 2008 Superglide in excellent condition for sale." — a SELLER. The lead was stamped
// {bucket: inventory_interest, cta: check_availability} because the old classifier read the
// DEPARTMENT and nothing else: every Sales-department widget lead was a buyer asking about stock
// before one word of the customer's message was read. The cta is not just a console badge —
// salesTopicHint maps check_availability -> the "availability" topic hint that goes INTO the draft.
//
// So the sell-side answer comes from the typed widget-sales parser that ALREADY ran on this exact
// turn (parseWebTextWidgetSalesLeadWithLLM, intent: "sell_or_trade") — no new round-trip, and no
// keyword scan for "sell"/"consignment", which would be the manufactured-confidence anti-pattern.
// The bucket/cta pair it lands on (trade_in_sell / value_my_trade) is the SAME pair the ADF/email
// lane already produces, so this routes into a lane the drafting prompt and the KPI split already
// understand; it invents nothing.
//
// FAIL DIRECTION: unsure => the buy side, which is today's behaviour. Treating a seller as a buyer
// costs a wrong tag and a wrong topic hint (the reported miss); treating a BUYER as a seller costs
// us not answering the availability question they actually asked — strictly worse. So sell-side
// needs a positive, accepted parser verdict AND the parser finding no bike they want to buy: an
// unaccepted parse, any other intent, or a requested vehicle all fall back to the buy side.
// ---------------------------------------------------------------------------
export type WebTextWidgetDepartmentInput = "sales" | "service" | "parts" | "apparel";

export type WebTextWidgetSalesClassificationInput = {
  department: WebTextWidgetDepartmentInput;
  /** parseWebTextWidgetSalesLeadWithLLM's own intent for THIS turn; null when it was not accepted. */
  parserIntent?: string | null;
  /** The PARSER's requestedVehicle — never the regex extractor's, which is what minted "Outright". */
  parserHasRequestedVehicle?: boolean;
};

export type WebTextWidgetSalesClassificationDecision = {
  bucket: "inventory_interest" | "trade_in_sell" | "service" | "parts" | "apparel";
  cta:
    | "check_availability"
    | "value_my_trade"
    | "service_request"
    | "parts_request"
    | "apparel_request";
  /** True only on a positive sell-side parser verdict. Also blanks the extractor's phantom bike. */
  sellSide: boolean;
};

export function decideWebTextWidgetSalesClassification(
  input: WebTextWidgetSalesClassificationInput
): WebTextWidgetSalesClassificationDecision {
  if (input.department === "service") {
    return { bucket: "service", cta: "service_request", sellSide: false };
  }
  if (input.department === "parts") {
    return { bucket: "parts", cta: "parts_request", sellSide: false };
  }
  if (input.department === "apparel") {
    return { bucket: "apparel", cta: "apparel_request", sellSide: false };
  }
  const sellSide = input.parserIntent === "sell_or_trade" && !input.parserHasRequestedVehicle;
  if (sellSide) return { bucket: "trade_in_sell", cta: "value_my_trade", sellSide: true };
  return { bucket: "inventory_interest", cta: "check_availability", sellSide: false };
}

/**
 * THE LAST OF FOUR SILENCERS on a customer's "yes" (+16076549423, found 2026-08-07).
 *
 * Three near-identical `if (…) return empty TwiML` blocks sat in a row in the inbound handler,
 * ending the turn with NO route outcome recorded — invisible to decision tracing, to the route
 * outcome log, to the replay harness, to everything. Finding this one needed temporary markers
 * bisected through 3,700 lines, because nothing about it was observable.
 *
 * Two things are wrong with that and both are fixed here:
 *
 * 1. THE DECISION IS NOW ONE PLACE AND IT IS PURE. Three hand-maintained copies of the same idea
 *    could not be reasoned about or tested; this can.
 *
 * 2. `lastOutboundAskedQuestion` IS A WORD LIST, and our own offer phrasing is not in it. It tests
 *    for a trailing "?" or `want me to|should i|can i|would you like|does that work|…`. We had
 *    written *"**I can also** check current incentives and send only what applies"* — no question
 *    mark, and "I can" is not "can i" — so the handler decided we had asked nothing, read his
 *    "That would be great" as politeness, and said nothing back. **The phrasing our own agent uses
 *    to make an offer was missing from the list that decides whether we are waiting on an answer.**
 *    Widening that list is the anti-pattern that built all four silencers, so it stays exactly as
 *    it is and the PARSER outranks it — the same closed two-action exemption, at the same measured
 *    sub-floor, that the other three silencers now honour (Joe, 2026-08-07).
 *
 * FAIL DIRECTION. Every rule below other than the acceptance is unchanged, so a parser miss lands
 * on exactly today's behaviour. An over-fire puts a draft in the approval queue for someone who
 * was signing off, and staff discard it.
 */
export type ShortAckTurnEndInput = {
  provider?: string | null;
  shortAck: boolean;
  schedulingBlocked: boolean;
  ackOnlyCloseTurn: boolean;
  lastOutboundAskedQuestion: boolean;
  hasPendingWatch: boolean;
  hasPendingSlot: boolean;
  hasReschedulePending: boolean;
  /** The customer-ack parser read this as accepting something WE left pending. */
  acceptedPendingOffer: boolean;
};

export type ShortAckTurnEndDecision = {
  end: boolean;
  reason:
    | "not_twilio"
    | "accepted_pending_offer"
    | "scheduling_blocked_short_ack"
    | "ack_only_close_turn"
    | "short_ack_no_pending_question"
    | "turn_continues";
};

export function decideShortAckTurnEnd(input: ShortAckTurnEndInput): ShortAckTurnEndDecision {
  if (input.provider !== "twilio") return { end: false, reason: "not_twilio" };
  // The acceptance outranks every reason below to go quiet — that is the whole ruling.
  if (input.acceptedPendingOffer) return { end: false, reason: "accepted_pending_offer" };
  if (input.schedulingBlocked && input.shortAck) {
    return { end: true, reason: "scheduling_blocked_short_ack" };
  }
  const somethingPending =
    input.hasPendingWatch || input.hasPendingSlot || input.hasReschedulePending;
  if (somethingPending || input.lastOutboundAskedQuestion) {
    return { end: false, reason: "turn_continues" };
  }
  if (input.ackOnlyCloseTurn) return { end: true, reason: "ack_only_close_turn" };
  if (input.shortAck) return { end: true, reason: "short_ack_no_pending_question" };
  return { end: false, reason: "turn_continues" };
}

// ---------------------------------------------------------------------------
// PRE-QUALIFICATION STAGE LADDER (Joe, 2026-08-11, verbatim: "Pre qualification needs to change.
// The agent should discover what bike they are interested in, what their budget in then either try
// to book an appointment or if that fails, send them a credit application link.")
//
// MEASURED, live store, 90 days, before building anything:
//   27 prequal leads — the finance lane that matters (credit applications: 3).
//   19 of the 27 ALREADY carry a real, specific bike; only 8 are catch-alls ("Harley-Davidson Full
//     Line", "FXR/LS/WX model"). Asking the 19 which bike they want reads as not having listened —
//     the same miss Joe corrected by hand on 8/7 — so ask_bike is gated on the EXISTING
//     isPlaceholderModel referee, never on "is the field empty".
//   0 of the 27 ever had a budget captured, though paymentBudgetContext has held the shape all along.
//   6 of the 27 booked (22%, against 3.8% for non-finance leads — this lane is our best, not our worst).
//   15 were invited in and never came. THAT 15 is the credit application's audience.
//
// WHY A REDUCER: this is a route decision, so it is pure and central and both reply paths apply it
// (AGENTS.md). It reads only already-structured state — no customer text is read in here. The one
// comprehension input, `visitNotPossible`, arrives as a boolean FROM the parser slot of the same
// name; the reducer never looks at words.
//
// FAIL DIRECTION, and it is the whole reason for the ordering below: every early return is toward
// doing LESS. Suppressed, booked, or already-sent all return "none" before any stage can fire, so
// the failure mode is a prequal lead who gets today's ordinary reply — not a customer who is asked
// a question after they booked, and never a second credit application.
export type PrequalStage = "none" | "ask_bike" | "ask_budget" | "offer_visit" | "send_credit_app";

export type PrequalTurnInput = {
  /** From the lead SOURCE (a machine record), never from customer text. */
  isPrequalLead: boolean;
  /** advanceEveryReplySuppressed — grief / not interested / already bought / already booked. */
  suppressed: boolean;
  appointmentBooked: boolean;
  /** True when the lead's vehicle is missing OR a catch-all (isPlaceholderModel). */
  bikeUnknown: boolean;
  budgetKnown: boolean;
  /** How many times we have already invited this lead in. */
  visitOffersMade: number;
  /** Parser slot: still interested, but coming in is not their path. */
  visitNotPossible: boolean;
  /**
   * What the LENDER said on the ADF (`PreQual: N` / `Y`), read deterministically off the form.
   * "not_cleared" means the soft check returned nothing and the lender's own instruction is a
   * completed application — so this lead starts AT the fallback rung instead of earning it after two
   * unanswered invitations. "unknown" is the commonest value (22 of 42 leads carry no such field)
   * and must behave exactly as before.
   */
  prequalResult?: "cleared" | "not_cleared" | "unknown";
  /** ISO string once sent; the application goes out at most ONCE per lead. */
  creditAppSentAt?: string | null;
  /** False when the dealer profile has no real credit-app URL — we never fabricate a link. */
  creditAppAvailable: boolean;
};

export type PrequalTurnDecision = {
  stage: PrequalStage;
  reason: string;
};

/**
 * How many invitations count as "we tried". Joe, 2026-08-11: send the application when they tell us
 * they cannot come in, OR when we have invited them twice with no booking. TWO, deliberately — one
 * unanswered invitation is not a refusal, and these threads are often just slow. At two, this would
 * have reached roughly five leads a month.
 */
export const PREQUAL_VISIT_OFFER_LIMIT = 2;

export function decidePrequalTurn(input: PrequalTurnInput): PrequalTurnDecision {
  if (!input.isPrequalLead) return { stage: "none", reason: "not_a_prequal_lead" };
  // The four existing suppressions own the turn before any goal does. Never sell into grief, never
  // push someone who said no, never invite an owner in, never re-open a booked thread.
  if (input.suppressed) return { stage: "none", reason: "suppressed" };
  // THE FINISH LINE. This is the stop condition the ladder exists to have: the goal is reached, so
  // stop asking. Before this change the only stop was a booked appointment reached by accident.
  if (input.appointmentBooked) return { stage: "none", reason: "already_booked" };
  // A credit application is not undoable and must never be sent twice.
  if (String(input.creditAppSentAt ?? "").trim()) return { stage: "none", reason: "credit_app_already_sent" };

  // Qualify first, in Joe's order. Both of these are questions, so they are safe to ask even after
  // the customer has told us they cannot come in — they are how we help, not how we push.
  if (input.bikeUnknown) return { stage: "ask_bike", reason: "no_specific_bike_on_the_lead" };
  if (!input.budgetKnown) return { stage: "ask_budget", reason: "no_budget_captured" };

  // Qualified. Try for the appointment; fall back to the application when that has failed — or when
  // the lender has ALREADY told us it failed. A soft check that returned $0 does not need two
  // unanswered invitations to prove the visit is not the blocker: the form itself says a completed
  // application is the way through, and waiting just delays the only step that can produce a number.
  const triedEnough = input.visitOffersMade >= PREQUAL_VISIT_OFFER_LIMIT;
  const softCheckDidNotClear = input.prequalResult === "not_cleared";
  if (input.visitNotPossible || triedEnough || softCheckDidNotClear) {
    if (!input.creditAppAvailable) {
      // No real URL configured. Keep inviting rather than promising a link we cannot produce —
      // fail toward the thing we can actually do.
      return { stage: "offer_visit", reason: "credit_app_unavailable_keep_inviting" };
    }
    return {
      stage: "send_credit_app",
      reason: softCheckDidNotClear
        ? "soft_check_did_not_clear"
        : input.visitNotPossible
          ? "customer_cannot_come_in"
          : "visit_offered_enough_times"
    };
  }
  return { stage: "offer_visit", reason: "qualified_ask_them_in" };
}
