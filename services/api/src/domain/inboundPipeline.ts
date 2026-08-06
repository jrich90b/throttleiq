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
  confidence?: number;
};

export const BUSINESS_HOURS_QUESTION_PARSER_MIN_CONFIDENCE = 0.7;

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
      dispositionReason:
        | "customer_sell_on_own"
        | "customer_keep_current_bike"
        | "customer_stepping_back"
        | "customer_deferred";
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
      | "customer_deferred";
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
 * Note the second gate: a turn the regex ALREADY routes gets no parser call, because the parser
 * is additive-only and could not change the outcome. So the new comprehension costs nothing on
 * the hours questions we handle today — only on the ones we were missing.
 */
export function shouldParseBusinessHoursQuestion(input: {
  provider: InboundPipelineProvider;
  channel: "sms" | "email";
  text: string | null | undefined;
}): boolean {
  const text = normalizeText(input.text);
  if (!text) return false;
  if (input.provider !== "twilio" || input.channel !== "sms") return false;
  if (isBusinessHoursQuestionText(text)) return false;
  return hasBusinessHoursQuestionHint(text);
}

export function classifyInboundPreParserTurn(input: {
  provider: InboundPipelineProvider;
  channel: "sms" | "email";
  text: string | null | undefined;
  // Optional: callers that ran the typed parser pass its verdict in. The parser is ADDITIVE
  // ONLY — it can claim a turn the regex missed, but it never vetoes one the regex claims.
  // A veto would fail toward NOT answering an hours question, which is the failure this whole
  // path exists to prevent, and no production miss asks for it.
  hoursQuestionParse?: BusinessHoursQuestionParseInput | null;
}): InboundPreParserDecision | null {
  const text = normalizeText(input.text);
  if (!text) return null;
  if (input.provider !== "twilio" || input.channel !== "sms") return null;
  const lexicalHoursQuestion = isBusinessHoursQuestionText(text);
  const parserHoursQuestion = isBusinessHoursQuestionParserAccepted(input.hoursQuestionParse);
  if (!lexicalHoursQuestion && !parserHoursQuestion) return null;

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
