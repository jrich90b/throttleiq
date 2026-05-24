import { detectSchedulingSignals, extractTimeToken } from "./legacyRegexFallback.js";
import { isBusinessHoursQuestionText } from "./workflowRegressionGuards.js";

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
  reason: "business_hours_question";
};

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
      dispositionReason:
        | "customer_sell_on_own"
        | "customer_keep_current_bike"
        | "customer_stepping_back";
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
      | "customer_stepping_back";
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

export function classifyInboundPreParserTurn(input: {
  provider: InboundPipelineProvider;
  channel: "sms" | "email";
  text: string | null | undefined;
}): InboundPreParserDecision | null {
  const text = normalizeText(input.text);
  if (!text) return null;
  if (input.provider !== "twilio" || input.channel !== "sms") return null;
  if (!isBusinessHoursQuestionText(text)) return null;

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
