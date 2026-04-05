import {
  nextActionFromState,
  reduceStaleStateForInbound
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
    id: "short_ack_skips",
    input: {
      provider: "twilio",
      channel: "sms",
      isShortAck: true
    },
    expected: { kind: "skip", note: "short_ack_no_action" }
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
    id: "deterministic_availability_allowed",
    input: {
      provider: "twilio",
      channel: "sms",
      isShortAck: false,
      deterministicAvailabilityLookup: true,
      availabilityIntentOverride: true,
      financePriorityOverride: false,
      schedulePriorityOverride: false
    },
    expected: { kind: "deterministic_availability_lookup" }
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
  expected: { clearInventoryWatchPending: boolean; setDialogStateToNone: boolean };
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
    expected: { clearInventoryWatchPending: false, setDialogStateToNone: true }
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
    expected: { clearInventoryWatchPending: true, setDialogStateToNone: false }
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
    expected: { clearInventoryWatchPending: false, setDialogStateToNone: false }
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
    expected: { clearInventoryWatchPending: true, setDialogStateToNone: true }
  }
];

let stalePassed = 0;
for (const c of staleCases) {
  const actual = reduceStaleStateForInbound(c.input);
  const ok =
    actual.clearInventoryWatchPending === c.expected.clearInventoryWatchPending &&
    actual.setDialogStateToNone === c.expected.setDialogStateToNone;
  if (ok) stalePassed += 1;
  console.log(
    `${ok ? "PASS" : "FAIL"} ${c.id} expected=${JSON.stringify(c.expected)} actual=${JSON.stringify({
      clearInventoryWatchPending: actual.clearInventoryWatchPending,
      setDialogStateToNone: actual.setDialogStateToNone,
      reasons: actual.reasons
    })}`
  );
}

if (stalePassed !== staleCases.length) {
  console.error(`\n${staleCases.length - stalePassed} failures out of ${staleCases.length} stale-state cases`);
  process.exit(1);
}

console.log(`\nAll ${staleCases.length} stale-state checks passed.`);
