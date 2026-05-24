import {
  canInviteScheduleAfterBusinessHours,
  classifyInboundPreParserTurn,
  decorateBusinessHoursReply,
  resolveDealerTransactionPolicyRoute,
  resolveInboundTerminalRoute
} from "../services/api/src/domain/inboundPipeline.ts";

type Case = {
  id: string;
  actual: unknown;
  expected: unknown;
};

const cases: Case[] = [
  {
    id: "twilio_hours_question_routes_to_pre_parser",
    actual: classifyInboundPreParserTurn({
      provider: "twilio",
      channel: "sms",
      text: "Like to see tomorrow. You open till when"
    })?.routeOutcome,
    expected: "business_hours_question_pre_parser"
  },
  {
    id: "twilio_hours_with_time_marks_schedule_time_signal",
    actual: classifyInboundPreParserTurn({
      provider: "twilio",
      channel: "sms",
      text: "Are you open Monday at 1?"
    })?.hasScheduleTimeSignal,
    expected: true
  },
  {
    id: "color_preference_open_word_not_hours",
    actual: classifyInboundPreParserTurn({
      provider: "twilio",
      channel: "sms",
      text: "I am open to either color tomorrow"
    }),
    expected: null
  },
  {
    id: "service_time_request_not_hours",
    actual: classifyInboundPreParserTurn({
      provider: "twilio",
      channel: "sms",
      text: "Do you have anything Thursday afternoon?"
    }),
    expected: null
  },
  {
    id: "after_hours_courtesy_with_real_question_not_hours",
    actual: classifyInboundPreParserTurn({
      provider: "twilio",
      channel: "sms",
      text:
        "Hi Joe, sorry to text you after hours but had a quick question. Would you be able to facilitate a trade for a used bike I found with a private seller?"
    }),
    expected: null
  },
  {
    id: "adf_hours_question_does_not_use_twilio_pre_parser",
    actual: classifyInboundPreParserTurn({
      provider: "sendgrid_adf",
      channel: "sms",
      text: "What are your hours?"
    }),
    expected: null
  },
  {
    id: "dealer_policy_route_accepts_parser_decision",
    actual: resolveDealerTransactionPolicyRoute({
      provider: "twilio",
      channel: "sms",
      hasDecision: true,
      source: "parser",
      asksRiderToRiderFinancing: true,
      asksPrivateSellerFacilitation: true,
      asksExternalDealerFacilitation: false
    })?.routeOutcome,
    expected: "dealer_transaction_policy"
  },
  {
    id: "dealer_policy_route_ignores_empty_decision",
    actual: resolveDealerTransactionPolicyRoute({
      provider: "twilio",
      channel: "sms",
      hasDecision: false,
      source: null,
      asksRiderToRiderFinancing: true,
      asksPrivateSellerFacilitation: true,
      asksExternalDealerFacilitation: false
    }),
    expected: null
  },
  {
    id: "business_hours_sales_invite_allowed",
    actual: canInviteScheduleAfterBusinessHours({
      isSalesLead: true,
      schedulingAllowed: true,
      followUpMode: "active",
      outboundHoldNotice: false
    }),
    expected: true
  },
  {
    id: "business_hours_manual_handoff_blocks_invite",
    actual: canInviteScheduleAfterBusinessHours({
      isSalesLead: true,
      schedulingAllowed: true,
      followUpMode: "manual_handoff",
      outboundHoldNotice: false
    }),
    expected: false
  },
  {
    id: "business_hours_with_time_gets_availability_guard",
    actual: decorateBusinessHoursReply({
      baseReply: "Our hours on Monday are 9:00 AM-6:00 PM.",
      decision: classifyInboundPreParserTurn({
        provider: "twilio",
        channel: "sms",
        text: "Are you open Monday at 1?"
      })!,
      canInviteSchedule: true
    }),
    expected:
      "Our hours on Monday are 9:00 AM-6:00 PM. That time is during open hours, but I still need to check appointment availability before locking it in."
  },
  {
    id: "business_hours_without_time_gets_schedule_invite",
    actual: decorateBusinessHoursReply({
      baseReply: "Our hours on Saturday are 9:00 AM-3:00 PM.",
      decision: classifyInboundPreParserTurn({
        provider: "twilio",
        channel: "sms",
        text: "Are you open Saturday?"
      })!,
      canInviteSchedule: true
    }),
    expected:
      "Our hours on Saturday are 9:00 AM-3:00 PM. If you're thinking about coming in, what time works best? I can put you down on the schedule."
  },
  {
    id: "terminal_watch_stop_wins_before_disposition_closeout",
    actual: resolveInboundTerminalRoute({
      provider: "twilio",
      channel: "sms",
      hasInventoryWatchStopContext: true,
      watchStopRequested: true,
      watchStopSource: "semantic_slot",
      customerDispositionDecision: {
        reason: "customer_stepping_back",
        state: "customer_stepping_back"
      },
      customerDispositionAllowed: true,
      responseControlNotInterested: true
    })?.kind,
    expected: "inventory_watch_optout"
  },
  {
    id: "terminal_watch_context_without_stop_does_not_clear_watch",
    actual: resolveInboundTerminalRoute({
      provider: "twilio",
      channel: "sms",
      hasInventoryWatchStopContext: true,
      watchStopRequested: false,
      watchStopSource: null,
      customerDispositionDecision: null,
      customerDispositionAllowed: false,
      responseControlNotInterested: true
    }),
    expected: null
  },
  {
    id: "terminal_response_control_not_interested_does_not_close_without_disposition",
    actual: resolveInboundTerminalRoute({
      provider: "twilio",
      channel: "sms",
      hasInventoryWatchStopContext: false,
      watchStopRequested: false,
      watchStopSource: null,
      customerDispositionDecision: null,
      customerDispositionAllowed: false,
      responseControlNotInterested: true
    }),
    expected: null
  },
  {
    id: "terminal_customer_disposition_closeout_requires_allowed_gate",
    actual: resolveInboundTerminalRoute({
      provider: "twilio",
      channel: "sms",
      hasInventoryWatchStopContext: false,
      watchStopRequested: false,
      watchStopSource: null,
      customerDispositionDecision: {
        reason: "customer_stepping_back",
        state: "customer_stepping_back"
      },
      customerDispositionAllowed: false,
      responseControlNotInterested: true
    }),
    expected: null
  },
  {
    id: "terminal_customer_disposition_closeout_routes_after_gate",
    actual: resolveInboundTerminalRoute({
      provider: "twilio",
      channel: "sms",
      hasInventoryWatchStopContext: false,
      watchStopRequested: false,
      watchStopSource: null,
      customerDispositionDecision: {
        reason: "customer_stepping_back",
        state: "customer_stepping_back"
      },
      customerDispositionAllowed: true,
      responseControlNotInterested: true
    })?.routeOutcome,
    expected: "customer_disposition_closeout"
  },
  {
    id: "terminal_sendgrid_adf_ignored",
    actual: resolveInboundTerminalRoute({
      provider: "sendgrid_adf",
      channel: "sms",
      hasInventoryWatchStopContext: true,
      watchStopRequested: true,
      watchStopSource: "lexical",
      customerDispositionDecision: {
        reason: "customer_stepping_back",
        state: "customer_stepping_back"
      },
      customerDispositionAllowed: true,
      responseControlNotInterested: true
    }),
    expected: null
  }
];

let passed = 0;
for (const c of cases) {
  const ok = JSON.stringify(c.actual) === JSON.stringify(c.expected);
  if (ok) passed += 1;
  console.log(
    `${ok ? "PASS" : "FAIL"} ${c.id} expected=${JSON.stringify(c.expected)} actual=${JSON.stringify(
      c.actual
    )}`
  );
}

if (passed !== cases.length) {
  console.error(`\n${cases.length - passed} failures out of ${cases.length} inbound-pipeline cases`);
  process.exit(1);
}

console.log(`\nAll ${cases.length} inbound-pipeline checks passed.`);
