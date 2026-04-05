export type RouteStateReducerInput = {
  provider: string;
  channel: "sms" | "email";
  isShortAck: boolean;
  deterministicAvailabilityLookup?: boolean;
  financePriorityOverride?: boolean;
  schedulePriorityOverride?: boolean;
  dealerRideNoPurchaseAdf?: boolean;
};

export type RouteStateDecision =
  | { kind: "skip"; note: "short_ack_no_action" | "dealer_ride_no_purchase_manual_handoff"; draft?: string }
  | { kind: "deterministic_availability_lookup" }
  | { kind: "continue" };

export const DEALER_RIDE_NO_PURCHASE_SKIP_DRAFT =
  "No customer reply needed — dealer ride outcome requires salesperson follow-up.";

export function nextActionFromState(input: RouteStateReducerInput): RouteStateDecision {
  if (input.dealerRideNoPurchaseAdf) {
    return {
      kind: "skip",
      note: "dealer_ride_no_purchase_manual_handoff",
      draft: DEALER_RIDE_NO_PURCHASE_SKIP_DRAFT
    };
  }

  if (input.provider === "twilio" && input.isShortAck) {
    return { kind: "skip", note: "short_ack_no_action" };
  }

  if (
    input.provider === "twilio" &&
    input.channel === "sms" &&
    !!input.deterministicAvailabilityLookup &&
    !input.financePriorityOverride &&
    !input.schedulePriorityOverride
  ) {
    return { kind: "deterministic_availability_lookup" };
  }

  return { kind: "continue" };
}

