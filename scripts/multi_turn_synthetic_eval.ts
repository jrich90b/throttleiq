import {
  nextActionFromState,
  reduceStaleStateForInbound,
  type RouteStateDecision
} from "../services/api/src/domain/routeStateReducer.ts";
import { applyDraftStateInvariants } from "../services/api/src/domain/draftStateInvariants.ts";

type RouteExpectation = {
  kind: RouteStateDecision["kind"];
  note?: string;
};

type DraftExpectation = {
  allow: boolean;
  reason?: string;
};

type StaleExpectation = {
  clearInventoryWatchPending: boolean;
  setDialogStateToNone: boolean;
};

type Turn = {
  id: string;
  provider?: string;
  channel?: "sms" | "email";
  inboundText: string;
  routeInput?: Partial<{
    isShortAck: boolean;
    deterministicAvailabilityLookup: boolean;
    availabilityIntentOverride: boolean;
    financePriorityOverride: boolean;
    schedulePriorityOverride: boolean;
    dealerRideNoPurchaseAdf: boolean;
  }>;
  expectedRoute?: RouteExpectation;
  staleSignals?: Partial<{
    hasWatchIntent: boolean;
    hasFinanceIntent: boolean;
    hasSchedulingIntent: boolean;
    hasDepartmentIntent: boolean;
    inventoryWatchPendingAgeHours: number;
  }>;
  expectedStale?: StaleExpectation;
  draftCandidate?: string;
  expectedDraft?: DraftExpectation;
  applyStatePatch?: Partial<SimState>;
};

type Scenario = {
  id: string;
  initial: SimState;
  turns: Turn[];
};

type SimState = {
  followUpMode: string | null;
  followUpReason: string | null;
  dialogState: string | null;
  classificationBucket: string | null;
  classificationCta: string | null;
  hasInventoryWatchPending: boolean;
  inventoryWatchPendingAgeHours: number | null;
};

function cloneState(state: SimState): SimState {
  return { ...state };
}

function isShortAckText(text: string): boolean {
  const t = String(text ?? "").trim().toLowerCase();
  if (!t) return false;
  if (t.length > 60) return false;
  if (/[?]/.test(t)) return false;
  return /^(ok|okay|k|kk|got it|sounds good|sounds great|thanks|thank you|thx|ty|perfect|awesome|cool|great)[.!?\s]*$/.test(
    t
  );
}

function assertRoute(
  scenarioId: string,
  turnId: string,
  actual: RouteStateDecision,
  expected: RouteExpectation
): boolean {
  const noteOk = !expected.note || (actual.kind === "skip" && actual.note === expected.note);
  const ok = actual.kind === expected.kind && noteOk;
  console.log(
    `${ok ? "PASS" : "FAIL"} ${scenarioId}/${turnId} route expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`
  );
  return ok;
}

function assertStale(
  scenarioId: string,
  turnId: string,
  actual: ReturnType<typeof reduceStaleStateForInbound>,
  expected: StaleExpectation
): boolean {
  const ok =
    actual.clearInventoryWatchPending === expected.clearInventoryWatchPending &&
    actual.setDialogStateToNone === expected.setDialogStateToNone;
  console.log(
    `${ok ? "PASS" : "FAIL"} ${scenarioId}/${turnId} stale expected=${JSON.stringify(expected)} actual=${JSON.stringify({
      clearInventoryWatchPending: actual.clearInventoryWatchPending,
      setDialogStateToNone: actual.setDialogStateToNone,
      reasons: actual.reasons
    })}`
  );
  return ok;
}

function assertDraft(
  scenarioId: string,
  turnId: string,
  actual: ReturnType<typeof applyDraftStateInvariants>,
  expected: DraftExpectation
): boolean {
  const reasonOk = expected.allow || !expected.reason || actual.reason === expected.reason;
  const ok = actual.allow === expected.allow && reasonOk;
  console.log(
    `${ok ? "PASS" : "FAIL"} ${scenarioId}/${turnId} draft expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`
  );
  return ok;
}

const scenarios: Scenario[] = [
  {
    id: "pricing_to_availability_switch",
    initial: {
      followUpMode: "active",
      followUpReason: "pricing",
      dialogState: "pricing_answered",
      classificationBucket: "inventory_interest",
      classificationCta: "ask_payment",
      hasInventoryWatchPending: false,
      inventoryWatchPendingAgeHours: null
    },
    turns: [
      {
        id: "payments_question",
        inboundText: "What would I be looking at for payments?",
        routeInput: {
          financePriorityOverride: true
        },
        expectedRoute: { kind: "continue" },
        draftCandidate:
          "Ballpark, on about $24,999, you’re around $550–$570/mo at 60 months before taxes and fees, based on your APR.",
        expectedDraft: { allow: true }
      },
      {
        id: "availability_question_after_pricing",
        inboundText: "Do you have any black street glides in-stock?",
        routeInput: {
          deterministicAvailabilityLookup: true,
          availabilityIntentOverride: true,
          financePriorityOverride: false,
          schedulePriorityOverride: false
        },
        expectedRoute: { kind: "continue" },
        draftCandidate:
          "The price we have listed for T19-26 is $24,999. Final price can change with tax, fees, trade-in, and financing. Do you have a trade?",
        expectedDraft: {
          allow: false,
          reason: "availability_priority_pricing_prompt_guard"
        }
      }
    ]
  },
  {
    id: "manual_handoff_short_ack_skip",
    initial: {
      followUpMode: "manual_handoff",
      followUpReason: "manual_appointment",
      dialogState: "none",
      classificationBucket: "general_inquiry",
      classificationCta: "unknown",
      hasInventoryWatchPending: false,
      inventoryWatchPendingAgeHours: null
    },
    turns: [
      {
        id: "short_ack",
        inboundText: "Ok sounds great!",
        routeInput: {
          isShortAck: true
        },
        expectedRoute: { kind: "continue" },
        draftCandidate:
          "Glad you like it — I can send more photos or a quick walkaround video. Anything specific you want to see?",
        expectedDraft: { allow: false, reason: "short_ack_no_action_guard" }
      }
    ]
  },
  {
    id: "pricing_followup_down_and_budget_stays_finance",
    initial: {
      followUpMode: "active",
      followUpReason: "pricing",
      dialogState: "pricing_answered",
      classificationBucket: "inventory_interest",
      classificationCta: "ask_payment",
      hasInventoryWatchPending: false,
      inventoryWatchPendingAgeHours: null
    },
    turns: [
      {
        id: "down_and_budget_followup",
        inboundText: "Well I have $2,500 to put down and would like to stay under $500/mo",
        routeInput: {
          financePriorityOverride: true,
          availabilityIntentOverride: false,
          schedulePriorityOverride: false
        },
        expectedRoute: { kind: "continue" },
        draftCandidate:
          "Sounds good. happy to help with pricing or a model comparison. Which model are you leaning toward?",
        expectedDraft: {
          allow: false,
          reason: "finance_priority_inventory_prompt_guard"
        }
      }
    ]
  },
  {
    id: "stale_inventory_watch_clears_on_finance_shift",
    initial: {
      followUpMode: "active",
      followUpReason: "standard",
      dialogState: "inventory_watch_prompted",
      classificationBucket: "inventory_interest",
      classificationCta: "check_availability",
      hasInventoryWatchPending: true,
      inventoryWatchPendingAgeHours: 30
    },
    turns: [
      {
        id: "finance_shift",
        inboundText: "How much down would I need?",
        expectedRoute: { kind: "continue" },
        staleSignals: {
          hasWatchIntent: false,
          hasFinanceIntent: true,
          inventoryWatchPendingAgeHours: 30
        },
        expectedStale: {
          clearInventoryWatchPending: true,
          setDialogStateToNone: true
        }
      }
    ]
  },
  {
    id: "dealer_ride_no_purchase_adf_skip",
    initial: {
      followUpMode: "active",
      followUpReason: "standard",
      dialogState: "test_ride_booked",
      classificationBucket: "test_ride",
      classificationCta: "schedule_test_ride",
      hasInventoryWatchPending: false,
      inventoryWatchPendingAgeHours: null
    },
    turns: [
      {
        id: "dla_no_purchase_adf",
        provider: "sendgrid_adf",
        channel: "sms",
        inboundText:
          "WEB LEAD (ADF) Source: Dealer Lead App ... purchase timeframe: i am not interested in purchasing at this time",
        routeInput: {
          dealerRideNoPurchaseAdf: true
        },
        expectedRoute: {
          kind: "skip",
          note: "dealer_ride_no_purchase_manual_handoff"
        }
      }
    ]
  }
];

let totalChecks = 0;
let passedChecks = 0;

for (const scenario of scenarios) {
  const state = cloneState(scenario.initial);
  for (const turn of scenario.turns) {
    const provider = turn.provider ?? "twilio";
    const channel = turn.channel ?? "sms";
    const routeInput = {
      provider,
      channel,
      isShortAck:
        typeof turn.routeInput?.isShortAck === "boolean"
          ? turn.routeInput.isShortAck
          : isShortAckText(turn.inboundText),
      deterministicAvailabilityLookup: !!turn.routeInput?.deterministicAvailabilityLookup,
      availabilityIntentOverride: !!turn.routeInput?.availabilityIntentOverride,
      financePriorityOverride: !!turn.routeInput?.financePriorityOverride,
      schedulePriorityOverride: !!turn.routeInput?.schedulePriorityOverride,
      dealerRideNoPurchaseAdf: !!turn.routeInput?.dealerRideNoPurchaseAdf
    };
    const routeDecision = nextActionFromState(routeInput);
    if (turn.expectedRoute) {
      totalChecks += 1;
      if (assertRoute(scenario.id, turn.id, routeDecision, turn.expectedRoute)) passedChecks += 1;
    }

    const staleDecision = reduceStaleStateForInbound({
      followUpMode: state.followUpMode,
      followUpReason: state.followUpReason,
      dialogState: state.dialogState,
      hasInventoryWatchPending: state.hasInventoryWatchPending,
      inventoryWatchPendingAgeHours:
        turn.staleSignals?.inventoryWatchPendingAgeHours ?? state.inventoryWatchPendingAgeHours,
      hasWatchIntent: !!turn.staleSignals?.hasWatchIntent,
      hasFinanceIntent: !!turn.staleSignals?.hasFinanceIntent,
      hasSchedulingIntent: !!turn.staleSignals?.hasSchedulingIntent,
      hasDepartmentIntent: !!turn.staleSignals?.hasDepartmentIntent
    });
    if (turn.expectedStale) {
      totalChecks += 1;
      if (assertStale(scenario.id, turn.id, staleDecision, turn.expectedStale)) passedChecks += 1;
    }

    if (staleDecision.clearInventoryWatchPending) {
      state.hasInventoryWatchPending = false;
      state.inventoryWatchPendingAgeHours = null;
    }
    if (staleDecision.setDialogStateToNone) {
      state.dialogState = "none";
    }

    if (turn.applyStatePatch) {
      Object.assign(state, turn.applyStatePatch);
    }

    if (turn.draftCandidate && turn.expectedDraft) {
      const turnFinanceIntent = !!turn.routeInput?.financePriorityOverride;
      const turnAvailabilityIntent = !!turn.routeInput?.availabilityIntentOverride;
      const turnSchedulingIntent = !!turn.routeInput?.schedulePriorityOverride;
      const turnShortAckIntent =
        typeof turn.routeInput?.isShortAck === "boolean"
          ? turn.routeInput.isShortAck
          : isShortAckText(turn.inboundText);
      const draftDecision = applyDraftStateInvariants({
        inboundText: turn.inboundText,
        draftText: turn.draftCandidate,
        followUpMode: state.followUpMode,
        followUpReason: state.followUpReason,
        dialogState: state.dialogState,
        classificationBucket: state.classificationBucket,
        classificationCta: state.classificationCta,
        turnFinanceIntent,
        turnAvailabilityIntent,
        turnSchedulingIntent,
        financeContextIntent: String(state.dialogState ?? "").toLowerCase().startsWith("pricing_"),
        shortAckIntent: turnShortAckIntent
      });
      totalChecks += 1;
      if (assertDraft(scenario.id, turn.id, draftDecision, turn.expectedDraft)) passedChecks += 1;
    }
  }
}

if (passedChecks !== totalChecks) {
  console.error(`\n${totalChecks - passedChecks} failures out of ${totalChecks} synthetic multi-turn checks`);
  process.exit(1);
}

console.log(`\nAll ${totalChecks} synthetic multi-turn checks passed.`);
