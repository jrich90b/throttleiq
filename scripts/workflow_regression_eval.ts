import {
  allowComplimentOnlyReply,
  allowNoResponseSmallTalkAck,
  buildAccessoryCustomizationReply,
  buildFactoryOrderTimingHandoffReply,
  buildHiringManagerInquiryReply,
  buildRideChallengeSignupReply,
  buildTimingAwareWalkInFollowUpLine,
  catalogModelMentionMatchesText,
  cleanCatalogModelNameForDisplay,
  extractInventoryStockIdMention,
  hasRideChallengeSignupAcknowledgement,
  isAccessoryCustomizationRequestText,
  isBlockedCadencePersonalizationLineText,
  isCloseoutSignoffNoResponseText,
  isFactoryOrderTimingQuestionText,
  isInventoryBrowseLinkRequestText,
  isHiringManagerInquiryText,
  isRideChallengeLeadSignal,
  isManualOutboundBookingConfirmationText,
  isShortAckNoReplyText,
  isStockNumberInventoryInterestText,
  isTimingOnlyFollowUpTopic,
  pickCatalogModelLabelFromText,
  resolveRequestedScheduleWindowMode,
  shouldRebaseWeekdayReplyToPriorNextWeek,
  shouldCarryLeadYearForRequestedModel,
  shouldIgnoreAdfModelMismatchForTradeContext,
  shouldSuppressInitialAvailabilityLineAppend,
  shouldSuppressInitialInventoryPhotoAppend,
  shouldTreatAdfAsWalkInContext
} from "../services/api/src/domain/workflowRegressionGuards.ts";
import { detectSchedulingSignals } from "../services/api/src/domain/legacyRegexFallback.ts";

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
    id: "compact_ampm_day_time_detected",
    actual: detectSchedulingSignals("Tuesday around 11am would work great for me if that's possible.").hasDayTime,
    expected: true
  },
  {
    id: "close_to_compact_time_day_time_detected",
    actual: detectSchedulingSignals("Am I able to ride a road glide today? I can take lunch close to 430.").hasDayTime,
    expected: true
  },
  {
    id: "no_response_smalltalk_suppressed_for_scheduling_signal",
    actual: allowNoResponseSmallTalkAck({ smallTalk: true, schedulingSignal: true }),
    expected: false
  },
  {
    id: "no_response_smalltalk_allowed_without_action_signal",
    actual: allowNoResponseSmallTalkAck({ smallTalk: true }),
    expected: true
  },
  {
    id: "compliment_reply_suppressed_for_scheduling_signal",
    actual: allowComplimentOnlyReply({ complimentOnly: true, schedulingSignal: true }),
    expected: false
  },
  {
    id: "compliment_reply_allowed_without_action_signal",
    actual: allowComplimentOnlyReply({ complimentOnly: true }),
    expected: true
  },
  {
    id: "closeout_talk_soon_suppresses_reply",
    actual: isCloseoutSignoffNoResponseText("Talk soon!"),
    expected: true
  },
  {
    id: "closeout_question_does_not_suppress_reply",
    actual: isCloseoutSignoffNoResponseText("Can we talk soon?"),
    expected: false
  },
  {
    id: "perfect_short_ack_suppresses_reply",
    actual: isShortAckNoReplyText("Perfect."),
    expected: true
  },
  {
    id: "short_ack_with_availability_question_does_not_suppress_reply",
    actual: isShortAckNoReplyText("Perfect, is it available?"),
    expected: false
  },
  {
    id: "short_ack_with_appointment_question_does_not_suppress_reply",
    actual: isShortAckNoReplyText("Sounds good, can I come in Wednesday?"),
    expected: false
  },
  {
    id: "weekday_reply_rebases_from_prior_next_week_prompt",
    actual: shouldRebaseWeekdayReplyToPriorNextWeek(
      "Tuesday around 11am would work great for me if that's possible.",
      "We can schedule a demo ride on a Breakout Monday or Tuesday next week."
    ),
    expected: true
  },
  {
    id: "explicit_next_weekday_reply_does_not_double_rebase",
    actual: shouldRebaseWeekdayReplyToPriorNextWeek(
      "Next Tuesday around 11am would work great.",
      "We can schedule a demo ride on a Breakout Monday or Tuesday next week."
    ),
    expected: false
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
    id: "ride_challenge_source_detected",
    actual: isRideChallengeLeadSignal({
      leadSource: "Ride Challenge",
      inquiry: "Customer Comments: Preferred method of contact - email-"
    }),
    expected: true
  },
  {
    id: "ride_challenge_duplicate_without_ack_still_needs_ack",
    actual: hasRideChallengeSignupAcknowledgement([
      {
        direction: "out",
        body: "Hi Mike — you mentioned a 1-3 Years timeline. I’m here when you’re ready."
      }
    ]),
    expected: false
  },
  {
    id: "ride_challenge_prior_signup_ack_detected",
    actual: hasRideChallengeSignupAcknowledgement([
      {
        direction: "out",
        body:
          "Hi Mike — this is Alexandra at American Harley-Davidson. Thanks for signing up for this year's ride challenge. Feel free to stop in and record your miles throughout the year."
      }
    ]),
    expected: true
  },
  {
    id: "ride_challenge_signup_reply_thanks_for_signup",
    actual: buildRideChallengeSignupReply({
      firstName: "Mike",
      agentName: "Brooke",
      dealerName: "American Harley-Davidson"
    }).includes("Thanks for signing up for this year's ride challenge."),
    expected: true
  },
  {
    id: "stock_id_extracted_from_inventory_interest",
    actual: extractInventoryStockIdMention("Very interested in thw T10-26 street glide !!"),
    expected: "T10-26"
  },
  {
    id: "stock_id_inventory_interest_detected",
    actual: isStockNumberInventoryInterestText("Very interested in thw T10-26 street glide !!"),
    expected: true
  },
  {
    id: "inventory_browse_link_request_detected",
    actual: isInventoryBrowseLinkRequestText("Can you send me your inventory link?"),
    expected: true
  },
  {
    id: "inventory_browse_available_bikes_detected",
    actual: isInventoryBrowseLinkRequestText("Can you send me the bikes you have available?"),
    expected: true
  },
  {
    id: "customer_check_out_bike_plan_not_inventory_browse",
    actual: isInventoryBrowseLinkRequestText(
      "I'll come tomarow and check out bike after work, and if all goes great I'll take off work Thursday and pick up."
    ),
    expected: false
  },
  {
    id: "factory_order_timing_question_detected",
    actual: isFactoryOrderTimingQuestionText("perfect thanks. how long would it take to get a 2026 nightster in"),
    expected: true
  },
  {
    id: "incoming_inventory_question_routes_to_turnover",
    actual: isFactoryOrderTimingQuestionText("Hi! Do you have any Street Bob coming in."),
    expected: true
  },
  {
    id: "customer_coming_in_does_not_route_to_turnover",
    actual: isFactoryOrderTimingQuestionText("I am coming in tomorrow to look at the Street Bob."),
    expected: false
  },
  {
    id: "factory_order_timing_reply_no_eta_guess",
    actual: buildFactoryOrderTimingHandoffReply("2026 Nightster"),
    expected: "I’ll check on the status of the 2026 Nightster and follow up with you."
  },
  {
    id: "incoming_inventory_reply_no_hold_claim",
    actual: buildFactoryOrderTimingHandoffReply("Street Bob"),
    expected: "I’ll check on the status of the Street Bob and follow up with you."
  },
  {
    id: "incoming_inventory_different_model_does_not_carry_lead_year",
    actual: shouldCarryLeadYearForRequestedModel("Street Bob", "Road Glide"),
    expected: false
  },
  {
    id: "incoming_inventory_same_model_can_carry_lead_year",
    actual: shouldCarryLeadYearForRequestedModel("Street Bob", "Street Bob 114"),
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
    id: "catalog_model_code_clean_forty_eight_variant_code_only",
    actual: cleanCatalogModelNameForDisplay("1lc3 Forty-Eight"),
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
