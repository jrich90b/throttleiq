import {
  buildNoResponseFallbackReply,
  buildNoResponseFallbackTodoSummary,
  buildRouteDecisionSnapshot,
  evaluateNoResponseFallback,
  nextActionFromState,
  reduceStaleStateForInbound,
  resolveNoResponsePolicyDecision,
  resolveRoutingParserDecision,
  resolveTurnPrimaryIntent,
  shouldProposeDaySlotsForNamedDay,
  decideWalkInInventoryWatchTurn,
  shouldTreatInboundAsTestRideBikeSelection
} from "../services/api/src/domain/routeStateReducer.ts";

type Case = {
  id: string;
  input: {
    provider: string;
    channel: "sms" | "email";
    isShortAck: boolean;
    deterministicAvailabilityLookup?: boolean;
    availabilityIntentOverride?: boolean;
    financePriorityOverride?: boolean;
    schedulePriorityOverride?: boolean;
    dealerRideNoPurchaseAdf?: boolean;
  };
  expected: { kind: string; note?: string };
};

const cases: Case[] = [
  {
    id: "short_ack_continues_parser_first",
    input: {
      provider: "twilio",
      channel: "sms",
      isShortAck: true
    },
    expected: { kind: "continue" }
  },
  {
    id: "dealer_ride_no_purchase_skips",
    input: {
      provider: "sendgrid_adf",
      channel: "sms",
      isShortAck: false,
      dealerRideNoPurchaseAdf: true
    },
    expected: { kind: "skip", note: "dealer_ride_no_purchase_manual_handoff" }
  },
  {
    id: "parser_first_blocks_deterministic_availability",
    input: {
      provider: "twilio",
      channel: "sms",
      isShortAck: false,
      deterministicAvailabilityLookup: true,
      availabilityIntentOverride: true,
      financePriorityOverride: false,
      schedulePriorityOverride: false
    },
    expected: { kind: "continue" }
  },
  {
    id: "finance_priority_blocks_deterministic_availability",
    input: {
      provider: "twilio",
      channel: "sms",
      isShortAck: false,
      deterministicAvailabilityLookup: true,
      availabilityIntentOverride: true,
      financePriorityOverride: true,
      schedulePriorityOverride: false
    },
    expected: { kind: "continue" }
  },
  {
    id: "scheduling_priority_blocks_deterministic_availability",
    input: {
      provider: "twilio",
      channel: "sms",
      isShortAck: false,
      deterministicAvailabilityLookup: true,
      availabilityIntentOverride: true,
      financePriorityOverride: false,
      schedulePriorityOverride: true
    },
    expected: { kind: "continue" }
  },
  {
    id: "weak_availability_signal_blocks_deterministic_lookup",
    input: {
      provider: "twilio",
      channel: "sms",
      isShortAck: false,
      deterministicAvailabilityLookup: true,
      availabilityIntentOverride: false,
      financePriorityOverride: false,
      schedulePriorityOverride: false
    },
    expected: { kind: "continue" }
  }
];

let passed = 0;
for (const c of cases) {
  const actual = nextActionFromState(c.input);
  const ok =
    actual.kind === c.expected.kind &&
    (!c.expected.note || (actual.kind === "skip" && actual.note === c.expected.note));
  if (ok) passed += 1;
  console.log(
    `${ok ? "PASS" : "FAIL"} ${c.id} expected=${JSON.stringify(c.expected)} actual=${JSON.stringify(
      actual
    )}`
  );
}

if (passed !== cases.length) {
  console.error(`\n${cases.length - passed} failures out of ${cases.length} route-state cases`);
  process.exit(1);
}

console.log(`\nAll ${cases.length} route-state checks passed.`);

type TestRideBikeSelectionCase = {
  id: string;
  input: Parameters<typeof shouldTreatInboundAsTestRideBikeSelection>[0];
  expected: boolean;
};

const testRideBikeSelectionCases: TestRideBikeSelectionCase[] = [
  {
    id: "keeps_test_ride_context_on_model_only_selection",
    input: {
      inboundText: "2026 HARLEY-DAVIDSON® STREET GLIDE 3 LIMITED IRON HORSE METALLIC BLACK TRIM",
      lastOutboundText:
        "Here’s our current inventory so you can pick an in-stock bike. Once you pick one, I can line up the test ride right away.",
      dialogState: "test_ride_init",
      classificationBucket: "test_ride",
      classificationCta: "schedule_test_ride",
      mentionedModelCount: 1
    },
    expected: true
  },
  {
    id: "does_not_steal_explicit_spec_question",
    input: {
      inboundText: "Can you send the specs for the 2026 Street Glide 3 Limited?",
      lastOutboundText:
        "Here’s our current inventory so you can pick an in-stock bike. Once you pick one, I can line up the test ride right away.",
      dialogState: "test_ride_init",
      classificationBucket: "test_ride",
      classificationCta: "schedule_test_ride",
      mentionedModelCount: 1
    },
    expected: false
  },
  {
    id: "keeps_test_ride_context_on_alternate_model_selection",
    input: {
      inboundText: "Or maybe that 2022 iron 883",
      lastOutboundText:
        "Here’s our current inventory so you can pick an in-stock bike. Once you pick one, I can line up the test ride right away.",
      dialogState: "test_ride_init",
      classificationBucket: "test_ride",
      classificationCta: "schedule_test_ride",
      mentionedModelCount: 1
    },
    expected: true
  },
  {
    id: "keeps_test_ride_context_after_inventory_answered_state",
    input: {
      inboundText: "Road King, any Street Glide, OR Large CC Pan American, would be great.",
      lastOutboundText:
        "Here’s our current inventory so you can pick an in-stock bike. Once you pick one, I can line up the test ride right away. Here’s a photo of a 2025 Street Glide in Brilliant Red we have in stock.",
      dialogState: "inventory_answered",
      classificationBucket: "inventory_interest",
      classificationCta: "check_availability",
      mentionedModelCount: 3
    },
    expected: true
  },
  {
    id: "does_not_apply_without_test_ride_context",
    input: {
      inboundText: "2026 Street Glide 3 Limited black trim",
      lastOutboundText: "Which model are you interested in?",
      dialogState: "inventory_init",
      classificationBucket: "inventory_interest",
      classificationCta: "check_availability",
      mentionedModelCount: 1
    },
    expected: false
  }
];

let testRideBikeSelectionPassed = 0;
for (const c of testRideBikeSelectionCases) {
  const actual = shouldTreatInboundAsTestRideBikeSelection(c.input);
  const ok = actual === c.expected;
  if (ok) testRideBikeSelectionPassed += 1;
  console.log(`${ok ? "PASS" : "FAIL"} ${c.id} expected=${c.expected} actual=${actual}`);
}

if (testRideBikeSelectionPassed !== testRideBikeSelectionCases.length) {
  console.error(
    `\n${testRideBikeSelectionCases.length - testRideBikeSelectionPassed} failures out of ${testRideBikeSelectionCases.length} test-ride bike-selection checks`
  );
  process.exit(1);
}

console.log(`\nAll ${testRideBikeSelectionCases.length} test-ride bike-selection checks passed.`);

type TurnIntentCase = {
  id: string;
  input: {
    financePriorityOverride?: boolean;
    schedulePriorityOverride?: boolean;
    availabilityIntentOverride?: boolean;
    hasPricingIntent?: boolean;
    hasSchedulingIntent?: boolean;
    hasAvailabilityIntent?: boolean;
    callbackRequested?: boolean;
  };
  expectedPrimaryIntent: "pricing_payments" | "scheduling" | "callback" | "availability" | "general";
};

const turnIntentCases: TurnIntentCase[] = [
  {
    id: "pricing_wins_when_finance_override_true",
    input: { financePriorityOverride: true, callbackRequested: true, availabilityIntentOverride: true },
    expectedPrimaryIntent: "pricing_payments"
  },
  {
    id: "scheduling_wins_when_schedule_override_true_and_no_finance",
    input: { schedulePriorityOverride: true, callbackRequested: true, availabilityIntentOverride: true },
    expectedPrimaryIntent: "scheduling"
  },
  {
    id: "callback_wins_when_no_pricing_or_scheduling",
    input: { callbackRequested: true, availabilityIntentOverride: true },
    expectedPrimaryIntent: "callback"
  },
  {
    id: "availability_wins_when_only_availability_signals_present",
    input: { availabilityIntentOverride: true },
    expectedPrimaryIntent: "availability"
  },
  {
    id: "general_when_no_signals_present",
    input: {},
    expectedPrimaryIntent: "general"
  },
  {
    id: "explicit_pricing_signal_wins_over_schedule_signal",
    input: { hasPricingIntent: true, hasSchedulingIntent: true },
    expectedPrimaryIntent: "pricing_payments"
  }
];

let turnIntentPassed = 0;
for (const c of turnIntentCases) {
  const actual = resolveTurnPrimaryIntent(c.input);
  const ok = actual.primaryIntent === c.expectedPrimaryIntent;
  if (ok) turnIntentPassed += 1;
  console.log(
    `${ok ? "PASS" : "FAIL"} ${c.id} expected=${c.expectedPrimaryIntent} actual=${actual.primaryIntent}`
  );
}

if (turnIntentPassed !== turnIntentCases.length) {
  console.error(
    `\n${turnIntentCases.length - turnIntentPassed} failures out of ${turnIntentCases.length} turn-intent cases`
  );
  process.exit(1);
}

console.log(`\nAll ${turnIntentCases.length} turn-intent checks passed.`);

type RouteDecisionSnapshotCase = {
  id: string;
  input: {
    parserIntentOverride?: "pricing_payments" | "scheduling" | "callback" | "availability" | "general" | null;
    hasPricingIntent?: boolean;
    hasSchedulingIntent?: boolean;
    hasAvailabilityIntent?: boolean;
    callbackRequested?: boolean;
    financePriorityOverride?: boolean;
    schedulePriorityOverride?: boolean;
    availabilityIntentOverride?: boolean;
  };
  expected: {
    primaryIntent: "pricing_payments" | "scheduling" | "callback" | "availability" | "general";
    parserIntentOverride: "pricing_payments" | "scheduling" | "callback" | "availability" | null;
    plannerPrimaryIntent: "pricing_payments" | "scheduling" | "callback" | "availability" | "general";
  };
};

const routeDecisionSnapshotCases: RouteDecisionSnapshotCase[] = [
  {
    id: "parser_override_wins_over_planner",
    input: {
      parserIntentOverride: "availability",
      hasPricingIntent: true
    },
    expected: {
      primaryIntent: "availability",
      parserIntentOverride: "availability",
      plannerPrimaryIntent: "pricing_payments"
    }
  },
  {
    id: "general_parser_override_does_not_override_planner",
    input: {
      parserIntentOverride: "general",
      hasSchedulingIntent: true
    },
    expected: {
      primaryIntent: "scheduling",
      parserIntentOverride: null,
      plannerPrimaryIntent: "scheduling"
    }
  },
  {
    id: "planner_finance_priority_when_no_parser_override",
    input: {
      hasAvailabilityIntent: true,
      financePriorityOverride: true
    },
    expected: {
      primaryIntent: "pricing_payments",
      parserIntentOverride: null,
      plannerPrimaryIntent: "pricing_payments"
    }
  }
];

let routeDecisionSnapshotPassed = 0;
for (const c of routeDecisionSnapshotCases) {
  const actual = buildRouteDecisionSnapshot(c.input);
  const ok =
    actual.primaryIntent === c.expected.primaryIntent &&
    actual.parserIntentOverride === c.expected.parserIntentOverride &&
    actual.plannerPrimaryIntent === c.expected.plannerPrimaryIntent;
  if (ok) routeDecisionSnapshotPassed += 1;
  console.log(
    `${ok ? "PASS" : "FAIL"} ${c.id} expected=${JSON.stringify(c.expected)} actual=${JSON.stringify({
      primaryIntent: actual.primaryIntent,
      parserIntentOverride: actual.parserIntentOverride,
      plannerPrimaryIntent: actual.plannerPrimaryIntent
    })}`
  );
}

if (routeDecisionSnapshotPassed !== routeDecisionSnapshotCases.length) {
  console.error(
    `\n${
      routeDecisionSnapshotCases.length - routeDecisionSnapshotPassed
    } failures out of ${routeDecisionSnapshotCases.length} route-decision-snapshot cases`
  );
  process.exit(1);
}

console.log(`\nAll ${routeDecisionSnapshotCases.length} route-decision-snapshot checks passed.`);

type NoResponseFallbackCase = {
  id: string;
  input: {
    primaryIntent?: "pricing_payments" | "scheduling" | "callback" | "availability" | "general" | null;
    financeSignal?: boolean;
    availabilitySignal?: boolean;
    schedulingSignal?: boolean;
    callbackSignal?: boolean;
    hasMonthlyBudgetContext?: boolean;
    hasDownPaymentContext?: boolean;
    hasTermContext?: boolean;
  };
  expected: {
    shouldSkipNoResponse: boolean;
    hasActionableFinanceContext: boolean;
    hasActionableAvailabilityContext: boolean;
    hasActionableSchedulingContext: boolean;
    hasActionableCallbackContext: boolean;
  };
};

const noResponseFallbackCases: NoResponseFallbackCase[] = [
  {
    id: "no_response_skips_when_general_no_context",
    input: { primaryIntent: "general" },
    expected: {
      shouldSkipNoResponse: true,
      hasActionableFinanceContext: false,
      hasActionableAvailabilityContext: false,
      hasActionableSchedulingContext: false,
      hasActionableCallbackContext: false
    }
  },
  {
    id: "no_response_overridden_by_callback_context",
    input: { primaryIntent: "general", callbackSignal: true },
    expected: {
      shouldSkipNoResponse: false,
      hasActionableFinanceContext: false,
      hasActionableAvailabilityContext: false,
      hasActionableSchedulingContext: false,
      hasActionableCallbackContext: true
    }
  },
  {
    id: "no_response_overridden_by_finance_context",
    input: { primaryIntent: "general", hasDownPaymentContext: true },
    expected: {
      shouldSkipNoResponse: false,
      hasActionableFinanceContext: true,
      hasActionableAvailabilityContext: false,
      hasActionableSchedulingContext: false,
      hasActionableCallbackContext: false
    }
  },
  {
    id: "no_response_overridden_by_availability_signal",
    input: { primaryIntent: "general", availabilitySignal: true },
    expected: {
      shouldSkipNoResponse: false,
      hasActionableFinanceContext: false,
      hasActionableAvailabilityContext: true,
      hasActionableSchedulingContext: false,
      hasActionableCallbackContext: false
    }
  }
];

let noResponseFallbackPassed = 0;
for (const c of noResponseFallbackCases) {
  const actual = evaluateNoResponseFallback(c.input);
  const ok =
    actual.shouldSkipNoResponse === c.expected.shouldSkipNoResponse &&
    actual.hasActionableFinanceContext === c.expected.hasActionableFinanceContext &&
    actual.hasActionableAvailabilityContext === c.expected.hasActionableAvailabilityContext &&
    actual.hasActionableSchedulingContext === c.expected.hasActionableSchedulingContext &&
    actual.hasActionableCallbackContext === c.expected.hasActionableCallbackContext;
  if (ok) noResponseFallbackPassed += 1;
  console.log(
    `${ok ? "PASS" : "FAIL"} ${c.id} expected=${JSON.stringify(c.expected)} actual=${JSON.stringify({
      shouldSkipNoResponse: actual.shouldSkipNoResponse,
      hasActionableFinanceContext: actual.hasActionableFinanceContext,
      hasActionableAvailabilityContext: actual.hasActionableAvailabilityContext,
      hasActionableSchedulingContext: actual.hasActionableSchedulingContext,
      hasActionableCallbackContext: actual.hasActionableCallbackContext
    })}`
  );
}

if (noResponseFallbackPassed !== noResponseFallbackCases.length) {
  console.error(
    `\n${
      noResponseFallbackCases.length - noResponseFallbackPassed
    } failures out of ${noResponseFallbackCases.length} no-response-fallback cases`
  );
  process.exit(1);
}

console.log(`\nAll ${noResponseFallbackCases.length} no-response-fallback checks passed.`);

type NoResponsePolicyCase = {
  id: string;
  input: {
    hasParserNoResponse: boolean;
    actionable: {
      hasActionableFinanceContext: boolean;
      hasActionableAvailabilityContext: boolean;
      hasActionableSchedulingContext: boolean;
      hasActionableCallbackContext: boolean;
      hasActionableTurnContext: boolean;
    };
    isLogisticsProgressUpdate?: boolean;
    isManualHandoff?: boolean;
    manualHandoffQuestionCandidate?: boolean;
    allowManualHandoffQuestionAck?: boolean;
  };
  expected: {
    applicable: boolean;
    action: "skip" | "override" | "ack_progress_update" | "ack_manual_handoff_question";
    reason:
      | "not_no_response_fallback"
      | "actionable_context_present"
      | "context_only_actionable_guard"
      | "progress_update_ack"
      | "manual_handoff_question_ack"
      | "small_talk_question_ack"
      | "no_actionable_context";
  };
};

const noResponsePolicyCases: NoResponsePolicyCase[] = [
  {
    id: "policy_not_applicable_without_no_response_fallback",
    input: {
      hasParserNoResponse: false,
      actionable: {
        hasActionableFinanceContext: false,
        hasActionableAvailabilityContext: false,
        hasActionableSchedulingContext: false,
        hasActionableCallbackContext: false,
        hasActionableTurnContext: false
      }
    },
    expected: {
      applicable: false,
      action: "override",
      reason: "not_no_response_fallback"
    }
  },
  {
    id: "policy_progress_update_ack_when_no_actionable_context",
    input: {
      hasParserNoResponse: true,
      actionable: {
        hasActionableFinanceContext: false,
        hasActionableAvailabilityContext: false,
        hasActionableSchedulingContext: false,
        hasActionableCallbackContext: false,
        hasActionableTurnContext: false
      },
      isLogisticsProgressUpdate: true
    },
    expected: {
      applicable: true,
      action: "ack_progress_update",
      reason: "progress_update_ack"
    }
  },
  {
    id: "policy_manual_handoff_question_ack_when_enabled",
    input: {
      hasParserNoResponse: true,
      actionable: {
        hasActionableFinanceContext: false,
        hasActionableAvailabilityContext: false,
        hasActionableSchedulingContext: false,
        hasActionableCallbackContext: false,
        hasActionableTurnContext: false
      },
      isManualHandoff: true,
      manualHandoffQuestionCandidate: true,
      allowManualHandoffQuestionAck: true
    },
    expected: {
      applicable: true,
      action: "ack_manual_handoff_question",
      reason: "manual_handoff_question_ack"
    }
  },
  {
    id: "policy_small_talk_question_skip_even_with_actionable_context",
    input: {
      hasParserNoResponse: true,
      actionable: {
        hasActionableFinanceContext: true,
        hasActionableAvailabilityContext: false,
        hasActionableSchedulingContext: false,
        hasActionableCallbackContext: false,
        hasActionableTurnContext: true
      },
      smallTalkQuestionCandidate: true
    },
    expected: {
      applicable: true,
      action: "skip",
      reason: "small_talk_question_ack"
    }
  },
  {
    id: "policy_override_when_actionable_context_present",
    input: {
      hasParserNoResponse: true,
      actionable: {
        hasActionableFinanceContext: true,
        hasActionableAvailabilityContext: false,
        hasActionableSchedulingContext: false,
        hasActionableCallbackContext: false,
        hasActionableTurnContext: true
      }
    },
    expected: {
      applicable: true,
      action: "skip",
      reason: "context_only_actionable_guard"
    }
  }
];

let noResponsePolicyPassed = 0;
for (const c of noResponsePolicyCases) {
  const actual = resolveNoResponsePolicyDecision(c.input);
  const ok =
    actual.applicable === c.expected.applicable &&
    actual.action === c.expected.action &&
    actual.reason === c.expected.reason;
  if (ok) noResponsePolicyPassed += 1;
  console.log(
    `${ok ? "PASS" : "FAIL"} ${c.id} expected=${JSON.stringify(c.expected)} actual=${JSON.stringify({
      applicable: actual.applicable,
      action: actual.action,
      reason: actual.reason
    })}`
  );
}

if (noResponsePolicyPassed !== noResponsePolicyCases.length) {
  console.error(
    `\n${noResponsePolicyCases.length - noResponsePolicyPassed} failures out of ${noResponsePolicyCases.length} no-response-policy cases`
  );
  process.exit(1);
}

console.log(`\nAll ${noResponsePolicyCases.length} no-response-policy checks passed.`);

type NoResponseReplyCase = {
  id: string;
  input: {
    hasActionableFinanceContext: boolean;
    hasActionableAvailabilityContext: boolean;
    hasActionableSchedulingContext: boolean;
    hasActionableCallbackContext: boolean;
    hasActionableTurnContext: boolean;
  };
  expectedReply: string;
};

const noResponseReplyCases: NoResponseReplyCase[] = [
  {
    id: "reply_prefers_finance",
    input: {
      hasActionableFinanceContext: true,
      hasActionableAvailabilityContext: false,
      hasActionableSchedulingContext: false,
      hasActionableCallbackContext: false,
      hasActionableTurnContext: true
    },
    expectedReply: "I’ll have someone check the payment options and follow up shortly."
  },
  {
    id: "reply_prefers_availability",
    input: {
      hasActionableFinanceContext: false,
      hasActionableAvailabilityContext: true,
      hasActionableSchedulingContext: false,
      hasActionableCallbackContext: false,
      hasActionableTurnContext: true
    },
    expectedReply: "I’ll check availability and follow up shortly."
  },
  {
    id: "reply_scheduling_is_safe_handoff",
    input: {
      hasActionableFinanceContext: false,
      hasActionableAvailabilityContext: false,
      hasActionableSchedulingContext: true,
      hasActionableCallbackContext: false,
      hasActionableTurnContext: true
    },
    expectedReply: "I’ll check the schedule and follow up shortly."
  },
  {
    id: "reply_prefers_callback",
    input: {
      hasActionableFinanceContext: false,
      hasActionableAvailabilityContext: false,
      hasActionableSchedulingContext: false,
      hasActionableCallbackContext: true,
      hasActionableTurnContext: true
    },
    expectedReply: "Got it — I’ll have someone follow up with you shortly."
  }
];

let noResponseReplyPassed = 0;
for (const c of noResponseReplyCases) {
  const actual = buildNoResponseFallbackReply(c.input);
  const ok = actual === c.expectedReply;
  if (ok) noResponseReplyPassed += 1;
  console.log(`${ok ? "PASS" : "FAIL"} ${c.id} expected=${JSON.stringify(c.expectedReply)} actual=${JSON.stringify(actual)}`);
}

if (noResponseReplyPassed !== noResponseReplyCases.length) {
  console.error(
    `\n${noResponseReplyCases.length - noResponseReplyPassed} failures out of ${noResponseReplyCases.length} no-response-reply cases`
  );
  process.exit(1);
}

console.log(`\nAll ${noResponseReplyCases.length} no-response-reply checks passed.`);

type NoResponseTodoSummaryCase = {
  id: string;
  input: NoResponseReplyCase["input"];
  expectedSummary: string;
};

const noResponseTodoSummaryCases: NoResponseTodoSummaryCase[] = [
  {
    id: "todo_summary_finance",
    input: {
      hasActionableFinanceContext: true,
      hasActionableAvailabilityContext: false,
      hasActionableSchedulingContext: false,
      hasActionableCallbackContext: false,
      hasActionableTurnContext: true
    },
    expectedSummary:
      "Follow up on payment or finance question. The reply pipeline did not produce a confident customer-facing answer."
  },
  {
    id: "todo_summary_availability",
    input: {
      hasActionableFinanceContext: false,
      hasActionableAvailabilityContext: true,
      hasActionableSchedulingContext: false,
      hasActionableCallbackContext: false,
      hasActionableTurnContext: true
    },
    expectedSummary:
      "Follow up on inventory availability question. The reply pipeline did not produce a confident customer-facing answer."
  },
  {
    id: "todo_summary_scheduling",
    input: {
      hasActionableFinanceContext: false,
      hasActionableAvailabilityContext: false,
      hasActionableSchedulingContext: true,
      hasActionableCallbackContext: false,
      hasActionableTurnContext: true
    },
    expectedSummary:
      "Follow up on scheduling request. The reply pipeline did not produce a confident customer-facing answer."
  },
  {
    id: "todo_summary_callback",
    input: {
      hasActionableFinanceContext: false,
      hasActionableAvailabilityContext: false,
      hasActionableSchedulingContext: false,
      hasActionableCallbackContext: true,
      hasActionableTurnContext: true
    },
    expectedSummary:
      "Customer needs a callback or staff follow-up. The reply pipeline did not produce a confident customer-facing answer."
  }
];

let noResponseTodoSummaryPassed = 0;
for (const c of noResponseTodoSummaryCases) {
  const actual = buildNoResponseFallbackTodoSummary(c.input);
  const ok = actual === c.expectedSummary;
  if (ok) noResponseTodoSummaryPassed += 1;
  console.log(`${ok ? "PASS" : "FAIL"} ${c.id} expected=${JSON.stringify(c.expectedSummary)} actual=${JSON.stringify(actual)}`);
}

if (noResponseTodoSummaryPassed !== noResponseTodoSummaryCases.length) {
  console.error(
    `\n${noResponseTodoSummaryCases.length - noResponseTodoSummaryPassed} failures out of ${noResponseTodoSummaryCases.length} no-response-todo-summary cases`
  );
  process.exit(1);
}

console.log(`\nAll ${noResponseTodoSummaryCases.length} no-response-todo-summary checks passed.`);

type StaleCase = {
  id: string;
  input: {
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
  expected: {
    clearInventoryWatchPending: boolean;
    setDialogStateToNone: boolean;
    clearManualAppointmentHandoff?: boolean;
    clearManualDepartmentHandoff?: boolean;
  };
};

const staleCases: StaleCase[] = [
  {
    id: "manual_handoff_clears_sticky_dialog",
    input: {
      followUpMode: "manual_handoff",
      followUpReason: "manual_appointment",
      dialogState: "pricing_need_model",
      hasInventoryWatchPending: false
    },
    expected: {
      clearInventoryWatchPending: false,
      setDialogStateToNone: true,
      clearManualAppointmentHandoff: false,
      clearManualDepartmentHandoff: false
    }
  },
  {
    id: "manual_appointment_clears_on_finance_shift",
    input: {
      followUpMode: "manual_handoff",
      followUpReason: "manual_appointment",
      dialogState: "none",
      hasInventoryWatchPending: false,
      hasFinanceIntent: true,
      hasSchedulingIntent: false
    },
    expected: {
      clearInventoryWatchPending: false,
      setDialogStateToNone: false,
      clearManualAppointmentHandoff: true,
      clearManualDepartmentHandoff: false
    }
  },
  {
    id: "manual_handoff_clears_pending_watch_without_watch_intent",
    input: {
      followUpMode: "manual_handoff",
      followUpReason: "credit_app",
      dialogState: "none",
      hasInventoryWatchPending: true,
      hasWatchIntent: false
    },
    expected: {
      clearInventoryWatchPending: true,
      setDialogStateToNone: false,
      clearManualAppointmentHandoff: false,
      clearManualDepartmentHandoff: false
    }
  },
  {
    id: "watch_context_keeps_pending_watch",
    input: {
      followUpMode: "holding_inventory",
      followUpReason: "inventory_watch",
      dialogState: "inventory_watch_prompted",
      hasInventoryWatchPending: true,
      hasWatchIntent: true
    },
    expected: {
      clearInventoryWatchPending: false,
      setDialogStateToNone: false,
      clearManualAppointmentHandoff: false,
      clearManualDepartmentHandoff: false
    }
  },
  {
    id: "expired_pending_watch_clears_on_context_shift",
    input: {
      followUpMode: "active",
      followUpReason: "standard",
      dialogState: "inventory_watch_prompted",
      hasInventoryWatchPending: true,
      inventoryWatchPendingAgeHours: 30,
      hasWatchIntent: false,
      hasFinanceIntent: true
    },
    expected: {
      clearInventoryWatchPending: true,
      setDialogStateToNone: true,
      clearManualAppointmentHandoff: false,
      clearManualDepartmentHandoff: false
    }
  },
  {
    id: "manual_department_handoff_clears_on_scheduling_shift",
    input: {
      followUpMode: "manual_handoff",
      followUpReason: "service_request",
      dialogState: "none",
      hasInventoryWatchPending: false,
      hasSchedulingIntent: true,
      hasDepartmentIntent: false
    },
    expected: {
      clearInventoryWatchPending: false,
      setDialogStateToNone: false,
      clearManualAppointmentHandoff: false,
      clearManualDepartmentHandoff: true
    }
  }
];

let stalePassed = 0;
for (const c of staleCases) {
  const actual = reduceStaleStateForInbound(c.input);
  const ok =
    actual.clearInventoryWatchPending === c.expected.clearInventoryWatchPending &&
    actual.setDialogStateToNone === c.expected.setDialogStateToNone &&
    actual.clearManualAppointmentHandoff === (c.expected.clearManualAppointmentHandoff ?? false) &&
    actual.clearManualDepartmentHandoff === (c.expected.clearManualDepartmentHandoff ?? false);
  if (ok) stalePassed += 1;
  console.log(
    `${ok ? "PASS" : "FAIL"} ${c.id} expected=${JSON.stringify(c.expected)} actual=${JSON.stringify({
      clearInventoryWatchPending: actual.clearInventoryWatchPending,
      setDialogStateToNone: actual.setDialogStateToNone,
      clearManualAppointmentHandoff: actual.clearManualAppointmentHandoff,
      clearManualDepartmentHandoff: actual.clearManualDepartmentHandoff,
      reasons: actual.reasons
    })}`
  );
}

if (stalePassed !== staleCases.length) {
  console.error(`\n${staleCases.length - stalePassed} failures out of ${staleCases.length} stale-state cases`);
  process.exit(1);
}

console.log(`\nAll ${staleCases.length} stale-state checks passed.`);

type RoutingParserCase = {
  id: string;
  input: {
    parserIntent?: "pricing_payments" | "scheduling" | "callback" | "availability" | "general" | "none" | null;
    parserFallbackAction?: "none" | "clarify" | "no_response" | null;
    parserClarifyPrompt?: string | null;
    parserConfidence?: number | null;
    parserConfidenceMin?: number;
  };
  expected: {
    accepted: boolean;
    intentOverride: "pricing_payments" | "scheduling" | "callback" | "availability" | "general" | null;
    fallbackAction: "none" | "clarify" | "no_response";
    reason:
      | "accepted"
      | "below_confidence"
      | "no_signal"
      | "intent_override"
      | "clarify_fallback"
      | "no_response_fallback";
  };
};

const routingParserCases: RoutingParserCase[] = [
  {
    id: "below_confidence_rejected",
    input: { parserIntent: "pricing_payments", parserConfidence: 0.51, parserConfidenceMin: 0.72 },
    expected: {
      accepted: false,
      intentOverride: null,
      fallbackAction: "none",
      reason: "below_confidence"
    }
  },
  {
    id: "pricing_override_accepted",
    input: { parserIntent: "pricing_payments", parserConfidence: 0.9 },
    expected: {
      accepted: true,
      intentOverride: "pricing_payments",
      fallbackAction: "none",
      reason: "intent_override"
    }
  },
  {
    id: "clarify_fallback_accepted",
    input: {
      parserIntent: "none",
      parserFallbackAction: "clarify",
      parserClarifyPrompt: "Quick check — payments, availability, or appointment?",
      parserConfidence: 0.86
    },
    expected: {
      accepted: true,
      intentOverride: null,
      fallbackAction: "clarify",
      reason: "clarify_fallback"
    }
  },
  {
    id: "no_response_fallback_accepted",
    input: {
      parserIntent: "none",
      parserFallbackAction: "no_response",
      parserConfidence: 0.95
    },
    expected: {
      accepted: true,
      intentOverride: null,
      fallbackAction: "no_response",
      reason: "no_response_fallback"
    }
  }
];

let routingParserPassed = 0;
for (const c of routingParserCases) {
  const actual = resolveRoutingParserDecision(c.input);
  const ok =
    actual.accepted === c.expected.accepted &&
    actual.intentOverride === c.expected.intentOverride &&
    actual.fallbackAction === c.expected.fallbackAction &&
    actual.reason === c.expected.reason;
  if (ok) routingParserPassed += 1;
  console.log(
    `${ok ? "PASS" : "FAIL"} ${c.id} expected=${JSON.stringify(c.expected)} actual=${JSON.stringify({
      accepted: actual.accepted,
      intentOverride: actual.intentOverride,
      fallbackAction: actual.fallbackAction,
      reason: actual.reason
    })}`
  );
}

if (routingParserPassed !== routingParserCases.length) {
  console.error(
    `\n${routingParserCases.length - routingParserPassed} failures out of ${routingParserCases.length} routing-parser cases`
  );
  process.exit(1);
}

console.log(`\nAll ${routingParserCases.length} routing-parser checks passed.`);

// --- Day-only visit-commitment slot-proposal trigger (item 2, Joe-approved 2026-07-14) ---
// Pins the decision to ATTEMPT a real-slot offer for a named-day commitment. The caller's
// null-slot fallback (findScheduleSlotsForRequestedDay => buildRequestedDaySlotReply) still
// preserves the "what time?" ask when the lookup returns nothing, so this is fail-safe.
type DaySlotProposalCase = {
  id: string;
  input: { hasNamedDay: boolean; customerAskedToSuggest: boolean; proposalEnabled: boolean };
  expected: boolean;
};

const daySlotProposalCases: DaySlotProposalCase[] = [
  {
    // Davey Cash: "can I look at it Saturday?" — named day, did NOT ask us to suggest, flag on
    // => proactively propose that day's real slots (the new answer->book behavior).
    id: "named_day_flag_on_not_asked_proposes",
    input: { hasNamedDay: true, customerAskedToSuggest: false, proposalEnabled: true },
    expected: true
  },
  {
    // Legacy behavior preserved when the flag is off: only propose when the customer asked us.
    id: "named_day_flag_off_not_asked_falls_back_to_what_time",
    input: { hasNamedDay: true, customerAskedToSuggest: false, proposalEnabled: false },
    expected: false
  },
  {
    id: "named_day_flag_off_but_asked_still_proposes",
    input: { hasNamedDay: true, customerAskedToSuggest: true, proposalEnabled: false },
    expected: true
  },
  {
    id: "named_day_flag_on_and_asked_proposes",
    input: { hasNamedDay: true, customerAskedToSuggest: true, proposalEnabled: true },
    expected: true
  },
  {
    // No resolved day => nothing to propose slots for, regardless of flag/ask.
    id: "no_named_day_never_proposes",
    input: { hasNamedDay: false, customerAskedToSuggest: true, proposalEnabled: true },
    expected: false
  }
];

let daySlotProposalPassed = 0;
for (const c of daySlotProposalCases) {
  const actual = shouldProposeDaySlotsForNamedDay(c.input);
  const ok = actual === c.expected;
  if (ok) daySlotProposalPassed += 1;
  console.log(`${ok ? "PASS" : "FAIL"} ${c.id} expected=${c.expected} actual=${actual}`);
}

if (daySlotProposalPassed !== daySlotProposalCases.length) {
  console.error(
    `\n${daySlotProposalCases.length - daySlotProposalPassed} failures out of ${daySlotProposalCases.length} day-slot-proposal cases`
  );
  process.exit(1);
}

console.log(`\nAll ${daySlotProposalCases.length} day-slot-proposal checks passed.`);

// --- decideWalkInInventoryWatchTurn: should a walk-in STAFF note start a watch? ---------------
// Larry Godzich +17164327329, Traffic Log Pro ref 11695, 2026-07-27. Operator, 2026-08-01: "THIS
// SHOULD HAVE TRIGGERED A WATCH FROM THE ADF." Both old arms ask whether the CUSTOMER asked to be
// notified; a salesperson's third-person CRM log never does, so the answer was structurally no.
// The table below is the whole contract: which arm carries which note, and — the load-bearing
// half — which "want" notes must NOT mint a watch, because a wrong watch becomes an unsolicited
// text weeks later. See services/api/src/domain/walkInInventoryWant.ts for the corpus numbers.
type WalkInWatchCase = {
  id: string;
  input: Parameters<typeof decideWalkInInventoryWatchTurn>[0];
  expectWatch: boolean;
  expectSource: ReturnType<typeof decideWalkInInventoryWatchTurn>["source"];
  /** What the parser arm would say regardless of the flag — the shadow signal. */
  expectParserArm?: boolean;
};

// The production turn's parse, as the fix expects to read it.
const LARRY_WANT: Parameters<typeof decideWalkInInventoryWatchTurn>[0] = {
  explicitWatchPhrase: false,
  intentParserWatchRequest: false,
  want: "open_search",
  wantSatisfiableFromNote: false,
  wantConfidence: 0.92,
  wantConfidenceMin: 0.8,
  wantParserEnabled: true,
  modelLabel: "Tri Glide",
  familyOnlyModel: false,
  walkInState: "none"
};

const walkInWatchCases: WalkInWatchCase[] = [
  {
    // THE PRODUCTION TURN. Today's shipped code returns watch=false here.
    id: "larry_open_search_staff_note_watches_when_enabled",
    input: LARRY_WANT,
    expectWatch: true,
    expectSource: "want_parser",
    expectParserArm: true
  },
  {
    // DARK BY DEFAULT: identical input, flag off => today's behavior, and the shadow still fires.
    id: "larry_flag_off_is_todays_behavior_but_shadow_still_says_would_watch",
    input: { ...LARRY_WANT, wantParserEnabled: false },
    expectWatch: false,
    expectSource: "none",
    expectParserArm: true
  },
  {
    // The KEEP arm is untouched and wins on its own — with the new parser silent AND disabled.
    id: "explicit_notify_verb_still_wins_alone",
    input: {
      ...LARRY_WANT,
      explicitWatchPhrase: true,
      want: "none",
      wantConfidence: null,
      wantParserEnabled: false
    },
    expectWatch: true,
    expectSource: "explicit_phrase",
    expectParserArm: false
  },
  {
    // The legacy customer-speech intent arm also survives unchanged.
    id: "legacy_intent_parser_arm_preserved",
    input: {
      ...LARRY_WANT,
      intentParserWatchRequest: true,
      want: "none",
      wantConfidence: null,
      wantParserEnabled: false
    },
    expectWatch: true,
    expectSource: "intent_parser",
    expectParserArm: false
  },
  {
    id: "below_confidence_floor_never_watches",
    input: { ...LARRY_WANT, wantConfidence: 0.6 },
    expectWatch: false,
    expectSource: "none",
    expectParserArm: false
  },
  {
    id: "absent_want_confidence_never_watches",
    input: { ...LARRY_WANT, wantConfidence: null },
    expectWatch: false,
    expectSource: "none",
    expectParserArm: false
  },
  // --- the four wrong-watch lanes, each pinned to the real note that taught it ----------------
  {
    // +17165238728 "…we need to order one for him" — a factory order, not an arrival alert.
    id: "order_lane_never_watches",
    input: { ...LARRY_WANT, want: "order", modelLabel: "Street Glide Limited" },
    expectWatch: false,
    expectSource: "none",
    expectParserArm: false
  },
  {
    // +17165832512 "Should be delivered 7/22" — already allocated; a watch would double up.
    id: "incoming_allocated_never_watches",
    input: { ...LARRY_WANT, want: "incoming_allocated", modelLabel: "Street Glide" },
    expectWatch: false,
    expectSource: "none",
    expectParserArm: false
  },
  {
    // +17169570162 "call him when we get it through service" — one known unit, a callback.
    id: "specific_unit_never_watches",
    input: { ...LARRY_WANT, want: "specific_unit", modelLabel: "Road Glide Special" },
    expectWatch: false,
    expectSource: "none",
    expectParserArm: false
  },
  {
    // +17162626218 "Wants to test ride 2026 Street Glide 3" — we have it; nothing to search for.
    id: "no_want_never_watches",
    input: { ...LARRY_WANT, want: "none", modelLabel: "Street Glide 3" },
    expectWatch: false,
    expectSource: "none",
    expectParserArm: false
  },
  {
    // The note says the bike is already ours to sell them — a want we can fill is not a watch.
    id: "satisfiable_from_note_never_watches",
    input: { ...LARRY_WANT, wantSatisfiableFromNote: true },
    expectWatch: false,
    expectSource: "none",
    expectParserArm: false
  },
  {
    // +17165100025 "Looking for trike models" — a family, not a model. Ask, never guess
    // (Joe ruling 2026-07-11 #4); guessing is how a watch fires on the wrong bike.
    id: "family_only_label_never_watches_on_the_parser_arm",
    input: { ...LARRY_WANT, modelLabel: "trike", familyOnlyModel: true },
    expectWatch: false,
    expectSource: "none",
    expectParserArm: false
  },
  {
    id: "no_model_label_never_watches_on_the_parser_arm",
    input: { ...LARRY_WANT, modelLabel: "" },
    expectWatch: false,
    expectSource: "none",
    expectParserArm: false
  },
  // --- a deal already in motion is not a shopping list ----------------------------------------
  ...(["deal_finalizing", "deposit_left", "sold_delivered", "cosigner_required"] as const).map(
    (state): WalkInWatchCase => ({
      id: `deal_in_motion_${state}_never_watches`,
      input: { ...LARRY_WANT, walkInState: state },
      expectWatch: false,
      expectSource: "none",
      expectParserArm: false
    })
  ),
  {
    // An unrecognized lane string must read as "no watch", never as the watchable one.
    id: "unknown_want_string_fails_closed",
    input: { ...LARRY_WANT, want: "something_new_from_a_future_prompt" },
    expectWatch: false,
    expectSource: "none",
    expectParserArm: false
  },
  {
    // Nothing may veto the KEEP arm — not a deal in motion, not a family-only label, not the flag.
    id: "keep_arm_is_never_vetoed_by_the_new_guards",
    input: {
      ...LARRY_WANT,
      explicitWatchPhrase: true,
      walkInState: "deal_finalizing",
      familyOnlyModel: true,
      modelLabel: "trike",
      wantParserEnabled: false
    },
    expectWatch: true,
    expectSource: "explicit_phrase",
    expectParserArm: false
  },
  // --- the floor answers, not just the note (Mike Wolf +17164323990, 2026-08-07) ---------------
  // He walked in to look at a new Deadwood. The note never says whether we have one, so the parser
  // answered `wantIsSatisfiableFromNote: false` — true of the NOTE — and the arm armed a watch and
  // told him "I'll keep an eye out ... and let you know if one comes in" about a bike on our own
  // floor. Reproduced 5/5 against the live parser on 2026-08-08 before this guard existed.
  {
    id: "mike_wolf_in_stock_now_vetoes_the_parser_arm",
    input: { ...LARRY_WANT, modelLabel: "FLHD Deadwood", modelInStockNow: true },
    expectWatch: false,
    expectSource: "none",
    expectParserArm: false
  },
  {
    // The same note with an EMPTY floor is still Larry's watch — the guard removes nothing else.
    id: "not_in_stock_still_watches",
    input: { ...LARRY_WANT, modelLabel: "FLHD Deadwood", modelInStockNow: false },
    expectWatch: true,
    expectSource: "want_parser",
    expectParserArm: true
  },
  {
    // A feed timeout hands in null. Unknown must read as unknown — never as "the floor is empty"
    // and never as "we have one" — so it collapses to the behavior that shipped before the guard.
    id: "unknown_stock_leaves_todays_behavior_alone",
    input: { ...LARRY_WANT, modelLabel: "FLHD Deadwood", modelInStockNow: null },
    expectWatch: true,
    expectSource: "want_parser",
    expectParserArm: true
  },
  {
    // In stock or not, an explicit "let me know when one comes in" is still honoured — the customer
    // may want a different colour or year than the one on the floor. The KEEP arm has no vetoes.
    id: "keep_arm_survives_the_in_stock_veto",
    input: { ...LARRY_WANT, explicitWatchPhrase: true, modelInStockNow: true },
    expectWatch: true,
    expectSource: "explicit_phrase",
    expectParserArm: false
  }
];

let walkInWatchPassed = 0;
for (const c of walkInWatchCases) {
  const actual = decideWalkInInventoryWatchTurn(c.input);
  const ok =
    actual.watch === c.expectWatch &&
    actual.source === c.expectSource &&
    (c.expectParserArm === undefined || actual.parserArmWouldWatch === c.expectParserArm);
  if (ok) walkInWatchPassed += 1;
  console.log(
    `${ok ? "PASS" : "FAIL"} ${c.id} expected=${c.expectWatch}/${c.expectSource} ` +
      `actual=${actual.watch}/${actual.source} parserArm=${actual.parserArmWouldWatch}`
  );
}

if (walkInWatchPassed !== walkInWatchCases.length) {
  console.error(
    `\n${walkInWatchCases.length - walkInWatchPassed} failures out of ${walkInWatchCases.length} walk-in inventory-watch cases`
  );
  process.exit(1);
}

console.log(`\nAll ${walkInWatchCases.length} walk-in inventory-watch checks passed.`);
