import {
  isBlockedCadencePersonalizationLineText,
  isManualOutboundBookingConfirmationText,
  resolveRequestedScheduleWindowMode,
  shouldSuppressInitialInventoryPhotoAppend
} from "../services/api/src/domain/workflowRegressionGuards.ts";

type Case = {
  id: string;
  actual: unknown;
  expected: unknown;
};

const cases: Case[] = [
  {
    id: "manual_outbound_confirms_scheduled_inspection",
    actual: isManualOutboundBookingConfirmationText(
      "I will schedule an inspection for the 12th at noon for you"
    ),
    expected: true
  },
  {
    id: "manual_outbound_offer_question_does_not_confirm",
    actual: isManualOutboundBookingConfirmationText(
      "Any of those days will work. Let us know which will work best for you"
    ),
    expected: false
  },
  {
    id: "manual_outbound_two_slot_offer_does_not_confirm",
    actual: isManualOutboundBookingConfirmationText(
      "I have Tue, May 12, 9:30 AM or Tue, May 12, 11:30 AM — do either of those work?"
    ),
    expected: false
  },
  {
    id: "blocks_unverified_photo_helped_personalization",
    actual: isBlockedCadencePersonalizationLineText("Hope the Citrus Heat photo helped you picture the CVO."),
    expected: true
  },
  {
    id: "blocks_unverified_recommendation_helped_personalization",
    actual: isBlockedCadencePersonalizationLineText("Hope Lisa's recommendations helped narrow your options."),
    expected: true
  },
  {
    id: "allows_safe_trip_personalization",
    actual: isBlockedCadencePersonalizationLineText("Hope your trip went smoothly."),
    expected: false
  },
  {
    id: "after_window_wins_over_later_any_time_clause",
    actual: resolveRequestedScheduleWindowMode("Either the 9th after 1:30 or any time on the 16th"),
    expected: "after"
  },
  {
    id: "standalone_any_time_remains_any_time",
    actual: resolveRequestedScheduleWindowMode("Any time on the 16th works for me"),
    expected: "any_time"
  },
  {
    id: "afternoon_window_detected",
    actual: resolveRequestedScheduleWindowMode("Friday afternoon or Saturday morning works for me"),
    expected: "window"
  },
  {
    id: "suppresses_photo_append_after_out_of_stock_test_ride_copy",
    actual: shouldSuppressInitialInventoryPhotoAppend(
      "I’m not seeing 2025 Street Glide in stock right now, and I don’t want to book you on a bike we don’t have."
    ),
    expected: true
  },
  {
    id: "allows_photo_append_after_available_inventory_copy",
    actual: shouldSuppressInitialInventoryPhotoAppend(
      "Yes — we have a 2025 Street Glide in stock. What day works best for a test ride?"
    ),
    expected: false
  }
];

let passed = 0;
for (const c of cases) {
  const ok = c.actual === c.expected;
  if (ok) passed += 1;
  console.log(`${ok ? "PASS" : "FAIL"} ${c.id} expected=${JSON.stringify(c.expected)} actual=${JSON.stringify(c.actual)}`);
}

if (passed !== cases.length) {
  console.error(`\n${cases.length - passed} failures out of ${cases.length} workflow regression checks`);
  process.exit(1);
}

console.log(`\nAll ${cases.length} workflow regression checks passed.`);
