import { detectSchedulingSignals, extractTimeToken } from "./legacyRegexFallback.js";
import {
  hasBusinessHoursQuestionHint,
  isBusinessHoursQuestionText
} from "./workflowRegressionGuards.js";

export type InboundPipelineStage =
  | "pre_parser"
  | "parser"
  | "router"
  | "side_effects"
  | "orchestrator";

export type InboundPipelinePrimaryIntent =
  | "hours"
  | "dealer_policy"
  | "pricing_payments"
  | "scheduling"
  | "callback"
  | "availability"
  | "department"
  | "no_response"
  | "general";

export type InboundPipelineProvider =
  | "twilio"
  | "sendgrid"
  | "sendgrid_adf"
  | "voice_transcript"
  | "debug"
  | "web_widget"
  | string;

export type InboundPreParserDecision = {
  stage: "pre_parser";
  kind: "business_hours_question";
  primaryIntent: "hours";
  routeOutcome: "business_hours_question_pre_parser";
  shouldStop: true;
  hasScheduleSignal: boolean;
  hasScheduleTimeSignal: boolean;
  hasScheduleDaySignal: boolean;
  // Which signal claimed the turn. "lexical" = the pre-existing regex gate; "parser" = only the
  // typed parser saw it (the hours question with no hours word). Auditing only — the reply and
  // the route outcome are identical either way.
  source: "lexical" | "parser";
  reason: "business_hours_question";
};

/**
 * The typed parser's verdict, passed IN so this decision stays pure and sync (an async
 * classifier would cascade through all five call sites for no gain).
 * Structurally compatible with BusinessHoursQuestionParse from llmDraft.
 */
export type BusinessHoursQuestionParseInput = {
  isHoursQuestion: boolean;
  scope: "dealership" | "staff_person" | "appointment_slot" | "none";
  day?: string | null;
  // A second question in the same turn our posted hours would not answer, verbatim (see
  // BusinessHoursQuestionParse.otherAsk).
  otherAsk?: string | null;
  confidence?: number;
};

export const BUSINESS_HOURS_QUESTION_PARSER_MIN_CONFIDENCE = 0.7;

/** "14:30" -> "2:30 PM". Pure; moved out of index.ts alongside its only non-trivial caller below. */
export function formatTime12h(time: string): string {
  const m = String(time ?? "").match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return time;
  let hour = Number(m[1]);
  const minute = m[2];
  const ampm = hour >= 12 ? "PM" : "AM";
  hour = hour % 12;
  if (hour === 0) hour = 12;
  return `${hour}:${minute} ${ampm}`;
}

/** A customer's bare time token ("4", "4:30pm") rendered for an hours reply. */
export function formatBusinessHoursProposalTime(timeToken: string): string {
  const m = String(timeToken ?? "").match(/^(\d{1,2}):(\d{2})(am|pm)?$/i);
  if (!m) return timeToken;
  const rawHour = Number(m[1]);
  const minute = m[2] ?? "00";
  const meridiem = String(m[3] ?? "").toLowerCase();
  let hour24 = rawHour;
  if (meridiem === "am") {
    hour24 = rawHour === 12 ? 0 : rawHour;
  } else if (meridiem === "pm") {
    hour24 = rawHour === 12 ? 12 : rawHour + 12;
  } else if (rawHour >= 1 && rawHour <= 6) {
    // In dealer scheduling, bare "1" through "6" almost always means PM.
    hour24 = rawHour + 12;
  }
  return formatTime12h(`${String(hour24).padStart(2, "0")}:${minute}`);
}

/**
 * Only a confident DEALERSHIP-scope read routes. A staff_person or appointment_slot read is a
 * question store hours would answer WRONGLY, and an unsure read is no read at all.
 */
export function isBusinessHoursQuestionParserAccepted(
  parse: BusinessHoursQuestionParseInput | null | undefined
): boolean {
  if (!parse) return false;
  if (parse.isHoursQuestion !== true) return false;
  if (parse.scope !== "dealership") return false;
  const confidence =
    typeof parse.confidence === "number" && Number.isFinite(parse.confidence) ? parse.confidence : 0;
  return confidence >= BUSINESS_HOURS_QUESTION_PARSER_MIN_CONFIDENCE;
}

/**
 * Raw model JSON -> the typed hours parse. Lives here, in the pure module, rather than beside the
 * prompt: importing llmDraft.ts constructs an OpenAI client at module load, and that would make
 * this pure decision-table eval need an API key to run.
 *
 * Exported so an eval can EXECUTE the mapping. The decision-table cases hand the referee a
 * hand-built parse, so without this nothing would notice if the parser stopped carrying
 * `other_ask` through at all.
 */
export function mapBusinessHoursQuestionParse(parsed: any): BusinessHoursQuestionParseInput {
  const rawScope = String(parsed?.scope ?? "").toLowerCase();
  const scope: BusinessHoursQuestionParseInput["scope"] =
    rawScope === "dealership" || rawScope === "staff_person" || rawScope === "appointment_slot"
      ? rawScope
      : "none";
  const dayRaw = typeof parsed?.day === "string" ? parsed.day.trim() : "";
  const confidence =
    typeof parsed?.confidence === "number" && Number.isFinite(parsed.confidence)
      ? Math.max(0, Math.min(1, parsed.confidence))
      : undefined;
  const otherAskRaw = typeof parsed?.other_ask === "string" ? parsed.other_ask.trim() : "";
  return {
    isHoursQuestion: parsed?.is_hours_question === true,
    scope,
    day: dayRaw || null,
    otherAsk: otherAskRaw || null,
    confidence
  };
}

/**
 * A one-line hours answer ENDS the turn, so it has to be the whole answer. When the customer asked
 * something else in the same breath, it isn't — and the shortcut would drop that question entirely.
 *
 * Ulises HernandezPerez, Ref 11755, 2026-08-08 — an enrolled Riding Academy student:
 *   "I tried calling ... but its the weekend and they close early today. I will make it a point to
 *    call at 9am on Monday when they open again, is that going to be too late, WILL I LOSE MY SEAT?"
 * The hours READ is correct (the live parser says dealership at 0.85-0.90, 4/4) — he really did
 * reference our hours. They were his CONTEXT, not his question. The queued reply was "Our hours today
 * are 9:00 AM-6:00 PM", and whether he keeps his seat went unanswered.
 *
 * Fail direction: only a NON-EMPTY otherAsk hands the turn to the full draft path. No parse, no
 * field, or an empty one keeps the shortcut exactly as today — so this can only ever add answering,
 * never remove it. The shortcut's failure is total and certain (the second question is always lost);
 * the fallthrough's worst case is a drafted reply a human still reviews.
 */
export function businessHoursTurnCarriesAnotherAsk(
  parse: BusinessHoursQuestionParseInput | null | undefined
): boolean {
  return !!String(parse?.otherAsk ?? "").trim();
}

/**
 * The NARROW veto: the parser read the whole turn and confidently says the customer is not asking
 * about our hours AT ALL (`scope: "none"`). Only then may it overrule a keyword claim.
 *
 * Earned by a production miss, +17163975098 on 2026-07-16 — the reason the veto was left out
 * originally was that no miss had asked for one. The customer wrote:
 *   "I should be able to swing in around then tomorrow. If it looks like it'll be close I'll get
 *    ahold of you guys before hand.  Should I send a photo of my id and my insurance over for it?"
 * `isBusinessHoursQuestionText` fires on "close" (as in CUTTING IT CLOSE) plus a question mark, so
 * the turn was answered "Our hours tomorrow are 9:00 AM-6:00 PM." and his actual question — should
 * he send his ID and insurance ahead of the ride — was never answered by anyone.
 *
 * Deliberately narrower than `isBusinessHoursQuestionParserAccepted` is permissive:
 *  - `staff_person` and `appointment_slot` do NOT veto. Those turns ARE availability questions the
 *    hours path handles acceptably; vetoing them would fail toward saying nothing, which is the
 *    failure this whole path exists to prevent.
 *  - No parse, a malformed parse, or confidence under the floor does NOT veto — unknown keeps
 *    today's behaviour exactly, so an LLM outage cannot silently retire the hours answer.
 * So the ONLY turns that change are ones where the parser positively read "not an hours question"
 * and the keyword scan disagreed.
 */
export function isBusinessHoursQuestionParserVetoed(
  parse: BusinessHoursQuestionParseInput | null | undefined
): boolean {
  if (!parse) return false;
  if (parse.isHoursQuestion === true) return false;
  if (parse.scope !== "none") return false;
  const confidence =
    typeof parse.confidence === "number" && Number.isFinite(parse.confidence) ? parse.confidence : 0;
  return confidence >= BUSINESS_HOURS_QUESTION_PARSER_MIN_CONFIDENCE;
}

export type InboundTerminalRouteDecision =
  | {
      stage: "router";
      kind: "inventory_watch_optout";
      primaryIntent: "no_response";
      routeOutcome: "inventory_watch_optout";
      shouldStop: true;
      parser: "semantic_slot" | "lexical";
      reason: "inventory_watch_stop";
    }
  | {
      stage: "router";
      kind: "customer_disposition_closeout";
      primaryIntent: "no_response";
      routeOutcome: "customer_disposition_closeout";
      shouldStop: true;
      parser: "customer_disposition";
      // "customer_deferred" = an explicit "not right now", kept distinct from the ambiguous
      // customer_stepping_back (which also carries "I'll pass" and "bought elsewhere"). The
      // dispositionState stays customer_stepping_back, so route/guard behavior is unchanged.
      // "customer_bought_elsewhere" = an EXPLICIT purchase; an outcome, never re-pitched.
      dispositionReason:
        | "customer_sell_on_own"
        | "customer_keep_current_bike"
        | "customer_stepping_back"
        | "customer_deferred"
        | "customer_bought_elsewhere";
      dispositionState:
        | "customer_sell_on_own"
        | "customer_keep_current_bike"
        | "customer_stepping_back";
      responseControlNotInterested: boolean;
      reason: "customer_disposition";
    };

export type InboundTerminalRouteInput = {
  provider: InboundPipelineProvider;
  channel: "sms" | "email";
  hasInventoryWatchStopContext: boolean;
  watchStopRequested: boolean;
  watchStopSource?: "semantic_slot" | "lexical" | null;
  customerDispositionDecision?: {
    reason:
      | "customer_sell_on_own"
      | "customer_keep_current_bike"
      | "customer_stepping_back"
      | "customer_deferred"
      // Explicit purchase elsewhere — an outcome, never re-pitched (Joe, 2026-08-07).
      | "customer_bought_elsewhere";
    state:
      | "customer_sell_on_own"
      | "customer_keep_current_bike"
      | "customer_stepping_back";
  } | null;
  customerDispositionAllowed: boolean;
  responseControlNotInterested?: boolean;
};

export type DealerTransactionPolicyRouteInput = {
  provider: InboundPipelineProvider;
  channel: "sms" | "email";
  hasDecision: boolean;
  source?: "parser" | "fallback" | null;
  asksRiderToRiderFinancing?: boolean;
  asksPrivateSellerFacilitation?: boolean;
  asksExternalDealerFacilitation?: boolean;
};

export type DealerTransactionPolicyRouteDecision = {
  stage: "router";
  kind: "dealer_transaction_policy";
  primaryIntent: "dealer_policy";
  routeOutcome: "dealer_transaction_policy";
  shouldStop: true;
  parser: "dealer_transaction_policy";
  source: "parser" | "fallback";
  asksRiderToRiderFinancing: boolean;
  asksPrivateSellerFacilitation: boolean;
  asksExternalDealerFacilitation: boolean;
  reason: "dealer_transaction_policy_question";
};

export type BusinessHoursScheduleInviteInput = {
  isSalesLead: boolean;
  schedulingAllowed?: boolean;
  followUpMode?: string | null;
  outboundHoldNotice?: boolean;
};

function normalizeText(value: string | null | undefined): string {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

/**
 * Whether this turn is worth one business-hours parser call. Pure + shared so the live and
 * regenerate paths can never drift on when the parser runs.
 *
 * ⚠️ This gate USED TO SKIP any turn the regex already claimed ("the parser is additive-only and
 * could not change the outcome"). That premise died the moment the parser gained a say over turns
 * the regex claims — first the veto (#630, 2026-08-09), then the other-ask fallthrough below — and
 * skipping the call made BOTH of them dead code in production while every unit-level check passed,
 * because those checks hand the referee a parse this gate would never have produced. That is
 * `parser-fix-inert-until-the-lexical-gate-lets-it-through` exactly, and #630 shipped with it.
 *
 * So: a turn worth an hours ANSWER is now a turn worth an hours PARSE. The added cost is one small
 * call on turns that trip the keyword scan — measured at ~1 a day on this store — and it buys the
 * two things the regex cannot do: notice it was wrong, and notice the customer asked something else.
 */
export function shouldParseBusinessHoursQuestion(input: {
  provider: InboundPipelineProvider;
  channel: "sms" | "email";
  text: string | null | undefined;
}): boolean {
  const text = normalizeText(input.text);
  if (!text) return false;
  if (input.provider !== "twilio" || input.channel !== "sms") return false;
  return isBusinessHoursQuestionText(text) || hasBusinessHoursQuestionHint(text);
}

export function classifyInboundPreParserTurn(input: {
  provider: InboundPipelineProvider;
  channel: "sms" | "email";
  text: string | null | undefined;
  // Optional: callers that ran the typed parser pass its verdict in. The parser CLAIMS turns the
  // regex missed, and — since 2026-08-09 — may also VETO one the regex wrongly claimed, but only
  // on a confident `scope: "none"`. See isBusinessHoursQuestionParserVetoed for why that is the
  // one safe direction to widen in (the miss that earned it: +17163975098, "it'll be close").
  hoursQuestionParse?: BusinessHoursQuestionParseInput | null;
}): InboundPreParserDecision | null {
  const text = normalizeText(input.text);
  if (!text) return null;
  if (input.provider !== "twilio" || input.channel !== "sms") return null;
  const lexicalHoursQuestion = isBusinessHoursQuestionText(text);
  const parserHoursQuestion = isBusinessHoursQuestionParserAccepted(input.hoursQuestionParse);
  if (!lexicalHoursQuestion && !parserHoursQuestion) return null;
  // A confident "this turn is not about our hours" ends it. Checked AFTER the accept so the two can
  // never both hold: accept needs isHoursQuestion true + scope dealership, veto needs it false +
  // scope none. The keyword scan alone can no longer end a turn the parser read as something else.
  if (!parserHoursQuestion && isBusinessHoursQuestionParserVetoed(input.hoursQuestionParse)) {
    return null;
  }
  // The turn asks something a single hours line cannot answer — the full draft path owns it, so the
  // second question survives. Independent of scope: "one line is not enough" is true whether the
  // hours read was dealership, staff_person or appointment_slot.
  if (businessHoursTurnCarriesAnotherAsk(input.hoursQuestionParse)) return null;

  const schedulingSignals = detectSchedulingSignals(text);
  const hasScheduleTimeSignal = !!extractTimeToken(text) || schedulingSignals.hasDayTime;
  const hasScheduleDaySignal =
    schedulingSignals.hasDayTime ||
    schedulingSignals.hasDayOnlyAvailability ||
    schedulingSignals.hasDayOnlyRequest;

  return {
    stage: "pre_parser",
    kind: "business_hours_question",
    primaryIntent: "hours",
    routeOutcome: "business_hours_question_pre_parser",
    shouldStop: true,
    hasScheduleSignal: hasScheduleTimeSignal || hasScheduleDaySignal,
    hasScheduleTimeSignal,
    hasScheduleDaySignal,
    source: lexicalHoursQuestion ? "lexical" : "parser",
    reason: "business_hours_question"
  };
}

export function resolveInboundTerminalRoute(
  input: InboundTerminalRouteInput
): InboundTerminalRouteDecision | null {
  if (input.provider !== "twilio" || input.channel !== "sms") return null;

  if (input.hasInventoryWatchStopContext && input.watchStopRequested) {
    return {
      stage: "router",
      kind: "inventory_watch_optout",
      primaryIntent: "no_response",
      routeOutcome: "inventory_watch_optout",
      shouldStop: true,
      parser: input.watchStopSource === "semantic_slot" ? "semantic_slot" : "lexical",
      reason: "inventory_watch_stop"
    };
  }

  if (input.customerDispositionAllowed && input.customerDispositionDecision) {
    return {
      stage: "router",
      kind: "customer_disposition_closeout",
      primaryIntent: "no_response",
      routeOutcome: "customer_disposition_closeout",
      shouldStop: true,
      parser: "customer_disposition",
      dispositionReason: input.customerDispositionDecision.reason,
      dispositionState: input.customerDispositionDecision.state,
      responseControlNotInterested: !!input.responseControlNotInterested,
      reason: "customer_disposition"
    };
  }

  return null;
}

/**
 * WHICH READING OF THE TURN WINS: the parser, nothing, or the keyword fallback.
 *
 * Pure so the precedence is pinned by a decision table instead of living inline in the handler.
 * The rule that matters is the middle one — a parser verdict of `none` ends it, even below the
 * accept floor.
 *
 * That is not "trusting a low-confidence parse". The only alternative is
 * `parseDealerTransactionPolicyFallback`: a keyword scan that fires on the presence of
 * "private seller" and then asserts `explicitRequest: true` at a hardcoded 0.76 — deliberately just
 * over the 0.74 gate it is bypassing. A hedged reading of the sentence still beats no reading of it.
 *
 * Measured 2026-08-06 by replaying one turn three times: the parser answered `none` every run, at
 * 0.86 twice and 0.72 once. On the 0.72 run the keyword scan took over and a live buyer who asked
 * for our price was told we cannot facilitate a private-party sale — a question he never asked,
 * and no price. Same words in, a coin flip on which reply went out.
 */
export type DealerTransactionPolicySource = "parser" | "none" | "fallback";

export function resolveDealerTransactionPolicySource(input: {
  parserAccepted: boolean;
  parsedIntent?: string | null;
  hasParse: boolean;
}): DealerTransactionPolicySource {
  if (input.parserAccepted) return "parser";
  if (input.hasParse && String(input.parsedIntent ?? "") === "none") return "none";
  return "fallback";
}

/**
 * Same precedence, for the first-time-rider route — where the override is not occasional but TOTAL.
 *
 * The parser here is only CALLED when `hasFirstTimeRiderGuidanceParserHint` has already matched, and
 * it is only ACCEPTED when `explicitRequest` is true. Measured over four live days (2026-08-02..05):
 * **48 calls, 0 accepted, 48 overruled by the keyword scan — 100%.** The parser never sets
 * `explicitRequest` on these turns, so its verdict is structurally unusable and the route is, in
 * practice, entirely keyword-driven. We pay for 48 LLM reads and discard every one.
 *
 * 26 of the 48 were the parser saying `none` — not a first-time rider — at 0.85-0.90, and being
 * overruled anyway. Among them, an ADF record reading `Bike Owner: Current, not first motorcycle`:
 * an existing owner, explicitly not a beginner, pulled into the first-time-rider lane because the
 * keyword hint matched the words "first motorcycle". That lane now carries the Jumpstart invite, so
 * the failure is offering an experienced rider a beginner session.
 *
 * Deliberately narrow: only `none` blocks the scan. The 22 turns where the parser DID see a
 * first-time-rider topic keep their current behaviour — loosening the acceptance gate would make
 * this route fire MORE, and over-offering a beginner session is the costlier direction.
 */
export type FirstTimeRiderGuidanceSource = "parser" | "none" | "fallback";

export function resolveFirstTimeRiderGuidanceSource(input: {
  parserAccepted: boolean;
  parsedIntent?: string | null;
  hasParse: boolean;
}): FirstTimeRiderGuidanceSource {
  if (input.parserAccepted) return "parser";
  if (input.hasParse && String(input.parsedIntent ?? "") === "none") return "none";
  return "fallback";
}

/**
 * Same precedence, on the most expensive decision in the system: whether to CLOSE a lead.
 *
 * `resolveCustomerDispositionDecision` acts on the parser only when `isDispositionParserAccepted`
 * passes — which needs `explicitDisposition === true` AND `disposition !== "none"` AND confidence
 * >= 0.74. Measured over four live days (2026-08-02..05): **516 calls, 0 accepted.** So lead
 * closure has been running entirely on `parseCustomerDispositionFallback`, a keyword scan matching
 * "can't afford | too expensive | too high | out of budget | hold off | I'll pass", while the
 * parser's reading of all 516 turns was discarded.
 *
 * The turn that shows the cost — parser answered `none` at **0.93**:
 *   "I took a look at those programs the interest rate is just too high. Those rates are not
 *    competitive in the market."
 * That is a buyer negotiating financing, not one walking away. The scan matches "too high" and
 * marks him `customer_stepping_back`, which stops the follow-up cadence and retires the lead.
 * A wrong reply costs a reply; this costs the customer.
 *
 * WHY THIS IS SAFE IN BOTH DIRECTIONS, which the measurement settles rather than argues:
 * since nothing is ever accepted, closure today happens ONLY through the scan. Blocking on a
 * parser `none` removes exactly the closures the parser said were not dispositions. A hedged
 * `stepping_back` still reaches the scan and still closes, so genuine walk-aways are untouched —
 * we do not start pestering people who told us they are out.
 */
export type CustomerDispositionSource = "parser" | "none" | "fallback";

export function resolveCustomerDispositionSource(input: {
  parserAccepted: boolean;
  parsedDisposition?: string | null;
  hasParse: boolean;
}): CustomerDispositionSource {
  if (input.parserAccepted) return "parser";
  if (input.hasParse && String(input.parsedDisposition ?? "") === "none") return "none";
  return "fallback";
}

export function resolveDealerTransactionPolicyRoute(
  input: DealerTransactionPolicyRouteInput
): DealerTransactionPolicyRouteDecision | null {
  if (input.provider !== "twilio" && input.provider !== "sendgrid_adf") return null;
  if (!input.hasDecision) return null;
  const asksRiderToRiderFinancing = !!input.asksRiderToRiderFinancing;
  const asksPrivateSellerFacilitation = !!input.asksPrivateSellerFacilitation;
  const asksExternalDealerFacilitation = !!input.asksExternalDealerFacilitation;
  if (!asksRiderToRiderFinancing && !asksPrivateSellerFacilitation && !asksExternalDealerFacilitation) {
    return null;
  }

  return {
    stage: "router",
    kind: "dealer_transaction_policy",
    primaryIntent: "dealer_policy",
    routeOutcome: "dealer_transaction_policy",
    shouldStop: true,
    parser: "dealer_transaction_policy",
    source: input.source === "fallback" ? "fallback" : "parser",
    asksRiderToRiderFinancing,
    asksPrivateSellerFacilitation,
    asksExternalDealerFacilitation,
    reason: "dealer_transaction_policy_question"
  };
}

export function canInviteScheduleAfterBusinessHours(input: BusinessHoursScheduleInviteInput): boolean {
  if (!input.isSalesLead) return false;
  if (input.schedulingAllowed === false) return false;
  if (input.outboundHoldNotice) return false;
  const followUpMode = String(input.followUpMode ?? "").toLowerCase();
  if (followUpMode === "manual_handoff" || followUpMode === "holding_inventory") return false;
  return true;
}

export function decorateBusinessHoursReply(input: {
  baseReply: string;
  decision: InboundPreParserDecision;
  canInviteSchedule: boolean;
}): string {
  const baseReply = normalizeText(input.baseReply);
  if (!baseReply || !input.canInviteSchedule) return baseReply;
  if (/\bclosed\b/i.test(baseReply)) return baseReply;
  if (input.decision.hasScheduleTimeSignal) {
    return `${baseReply} That time is during open hours, but I still need to check appointment availability before locking it in.`;
  }
  return `${baseReply} If you're thinking about coming in, what time works best? I can put you down on the schedule.`;
}

const NAMED_WEEKDAYS: Record<string, string> = {
  monday: "monday",
  mondays: "monday",
  mon: "monday",
  tuesday: "tuesday",
  tuesdays: "tuesday",
  tue: "tuesday",
  tues: "tuesday",
  wednesday: "wednesday",
  wednesdays: "wednesday",
  wed: "wednesday",
  thursday: "thursday",
  thursdays: "thursday",
  thu: "thursday",
  thur: "thursday",
  thurs: "thursday",
  friday: "friday",
  fridays: "friday",
  fri: "friday",
  saturday: "saturday",
  saturdays: "saturday",
  sat: "saturday",
  sunday: "sunday",
  sundays: "sunday",
  sun: "sunday"
};

export type RequestedDayResolution = {
  /** A weekday the customer named outright ("on Monday"). Null when they named none. */
  namedDay: string | null;
  /** The day whose hours/forecast we should look up. Null when the turn names no day at all. */
  day: string | null;
  /** How the reply must refer to that day — always derived from the SAME branch that set `day`. */
  label: string | null;
  /** Drop-in phrase for a sentence: "today" | "tomorrow" | "on Monday". */
  dayPhrase: string | null;
  source: "named_day" | "today" | "tomorrow" | "none";
};

/**
 * Single source of truth for "which day is this turn asking about, and what do we CALL it?".
 *
 * A named weekday outranks a bare "today"/"tomorrow", because a customer who writes
 * "they close early today, I will call at 9am on Monday" is asking about MONDAY. The label is
 * returned alongside the day so a caller cannot look one day up and print another — the
 * +17167857284 miss, where Monday's 9-6 window went out as "Our hours today are 9:00 AM-6:00 PM"
 * on a Saturday that actually closed at 3:00 PM.
 *
 * Pure: the caller supplies today's and tomorrow's weekday keys, so this never reads the clock.
 */
export function resolveRequestedDay(input: {
  text: string | null | undefined;
  todayKey: string;
  tomorrowKey: string;
}): RequestedDayResolution {
  const text = String(input.text ?? "").toLowerCase();
  let namedDay: string | null = null;
  for (const key of Object.keys(NAMED_WEEKDAYS)) {
    if (new RegExp(`\\b${key}\\b`, "i").test(text)) {
      namedDay = NAMED_WEEKDAYS[key];
      break;
    }
  }
  if (namedDay) {
    const label = namedDay.replace(/^\w/, c => c.toUpperCase());
    return { namedDay, day: namedDay, label, dayPhrase: `on ${label}`, source: "named_day" };
  }
  if (/\b(today|tonight|tonite)\b/.test(text)) {
    return {
      namedDay: null,
      day: String(input.todayKey ?? "").toLowerCase() || null,
      label: "today",
      dayPhrase: "today",
      source: "today"
    };
  }
  if (/\btomorrow\b/.test(text)) {
    return {
      namedDay: null,
      day: String(input.tomorrowKey ?? "").toLowerCase() || null,
      label: "tomorrow",
      dayPhrase: "tomorrow",
      source: "tomorrow"
    };
  }
  return { namedDay: null, day: null, label: null, dayPhrase: null, source: "none" };
}
