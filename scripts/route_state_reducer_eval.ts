import {
  buildRouteDecisionSnapshot,
  nextActionFromState,
  reduceStaleStateForInbound,
  resolveRoutingParserDecision,
  resolveTurnPrimaryIntent
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
    hasDepartmentIntent?: boolean;
  };
  expected: {
    clearInventoryWatchPending: boolean;
    setDialogStateToNone: boolean;
    clearManualAppointmentHandoff?: boolean;
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
      clearManualAppointmentHandoff: false
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
      clearManualAppointmentHandoff: true
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
      clearManualAppointmentHandoff: false
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
      clearManualAppointmentHandoff: false
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
      clearManualAppointmentHandoff: false
    }
  }
];

let stalePassed = 0;
for (const c of staleCases) {
  const actual = reduceStaleStateForInbound(c.input);
  const ok =
    actual.clearInventoryWatchPending === c.expected.clearInventoryWatchPending &&
    actual.setDialogStateToNone === c.expected.setDialogStateToNone &&
    actual.clearManualAppointmentHandoff === (c.expected.clearManualAppointmentHandoff ?? false);
  if (ok) stalePassed += 1;
  console.log(
    `${ok ? "PASS" : "FAIL"} ${c.id} expected=${JSON.stringify(c.expected)} actual=${JSON.stringify({
      clearInventoryWatchPending: actual.clearInventoryWatchPending,
      setDialogStateToNone: actual.setDialogStateToNone,
      clearManualAppointmentHandoff: actual.clearManualAppointmentHandoff,
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
