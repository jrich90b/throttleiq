import {
  buildAccessoryCustomizationReply,
  buildHiringManagerInquiryReply,
  buildTimingAwareWalkInFollowUpLine,
  catalogModelMentionMatchesText,
  cleanCatalogModelNameForDisplay,
  isAccessoryCustomizationRequestText,
  isBlockedCadencePersonalizationLineText,
  isHiringManagerInquiryText,
  isManualOutboundBookingConfirmationText,
  isTimingOnlyFollowUpTopic,
  pickCatalogModelLabelFromText,
  resolveRequestedScheduleWindowMode,
  shouldIgnoreAdfModelMismatchForTradeContext,
  shouldSuppressInitialAvailabilityLineAppend,
  shouldSuppressInitialInventoryPhotoAppend,
  shouldTreatAdfAsWalkInContext
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
  },
  {
    id: "suppresses_duplicate_availability_append_after_hold_copy",
    actual: shouldSuppressInitialAvailabilityLineAppend(
      "Thanks for your inquiry about the 2006 Heritage Softail. That unit is currently on hold, but I can text you first if it frees up."
    ),
    expected: true
  },
  {
    id: "new_test_ride_adf_overrides_prior_walkin_context",
    actual: shouldTreatAdfAsWalkInContext({
      leadSource: "HD.com Online Test Ride Request",
      priorWalkIn: true,
      explicitWalkInLeadSource: false,
      trafficLogPayloadHint: false,
      walkInSignalHint: false
    }),
    expected: false
  },
  {
    id: "prior_walkin_context_stays_sticky_for_generic_adf",
    actual: shouldTreatAdfAsWalkInContext({
      leadSource: "Traffic Log Pro",
      priorWalkIn: true,
      explicitWalkInLeadSource: false,
      trafficLogPayloadHint: true,
      walkInSignalHint: true
    }),
    expected: true
  },
  {
    id: "trade_vehicle_model_does_not_trigger_adf_model_mismatch",
    actual: shouldIgnoreAdfModelMismatchForTradeContext({
      inquiry: "What the asking price i have a 2013 street glide to trade in what the trade in value would be?",
      inquiryModel: "Street Glide"
    }),
    expected: true
  },
  {
    id: "direct_requested_model_still_can_trigger_adf_model_mismatch",
    actual: shouldIgnoreAdfModelMismatchForTradeContext({
      inquiry: "What is the asking price on a Street Glide?",
      inquiryModel: "Street Glide"
    }),
    expected: false
  },
  {
    id: "handlebar_customization_request_detected",
    actual: isAccessoryCustomizationRequestText(
      "Are you able to change handbars not a fan of the ones on there"
    ),
    expected: true
  },
  {
    id: "handlebar_customization_reply_acknowledges_able",
    actual: /we can change the handlebars/i.test(
      buildAccessoryCustomizationReply("Are you able to change handbars not a fan of the ones on there")
    ),
    expected: true
  },
  {
    id: "hiring_manager_inquiry_detected",
    actual: isHiringManagerInquiryText("Who is the hiring manager for American Harley Davidson?"),
    expected: true
  },
  {
    id: "hiring_manager_reply_handoff",
    actual: /hiring manager follow up/i.test(buildHiringManagerInquiryReply()),
    expected: true
  },
  {
    id: "walkin_next_week_is_timing_not_topic",
    actual: isTimingOnlyFollowUpTopic("next week"),
    expected: true
  },
  {
    id: "walkin_forty_eight_is_not_timing_topic",
    actual: isTimingOnlyFollowUpTopic("2022 Forty-Eight"),
    expected: false
  },
  {
    id: "walkin_timing_followup_mentions_model",
    actual: buildTimingAwareWalkInFollowUpLine({
      base: "Thanks for stopping in today -",
      followUpTopic: "next week",
      modelLabel: "2022 Forty-Eight"
    }),
    expected: "Thanks for stopping in today - I'll follow up next week about the 2022 Forty-Eight."
  },
  {
    id: "catalog_model_code_clean_low_rider_s",
    actual: cleanCatalogModelNameForDisplay("FXLRS 1YWK LOW RIDER S"),
    expected: "Low Rider S"
  },
  {
    id: "catalog_model_code_clean_forty_eight",
    actual: cleanCatalogModelNameForDisplay("XL1200X 1LC3 FORTY-EIGHT"),
    expected: "Forty-Eight"
  },
  {
    id: "catalog_model_mentions_code",
    actual: catalogModelMentionMatchesText("showed him an FXLRS today", "FXLRS 1YWK LOW RIDER S"),
    expected: true
  },
  {
    id: "catalog_model_mentions_name",
    actual: catalogModelMentionMatchesText("showed her a forty-eight", "XL1200X 1LC3 FORTY-EIGHT"),
    expected: true
  },
  {
    id: "catalog_picker_prefers_named_forty_eight_over_anniversary_code_match",
    actual: pickCatalogModelLabelFromText("showed her a 2022 XL1200X Forty-eight", [
      "XL1200X 1LN3 ANX FORTY-EIGHT ANNIVERSARY",
      "XL1200X 1LC3 FORTY-EIGHT"
    ]),
    expected: "Forty-Eight"
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
