import {
  allowComplimentOnlyReply,
  allowNoResponseSmallTalkAck,
  buildAudioDemoStatusReply,
  buildAccessoryCustomizationReply,
  buildAppointmentRescheduleBookingLinkReply,
  buildConditionalPickupPlanAck,
  buildExternalDealerApprovalTransferReply,
  buildFactoryOrderTimingHandoffReply,
  buildFollowUpReminderOnlyReply,
  extractReminderFollowUpLabel,
  formatServiceScheduleTimeLabel,
  buildHumanModeSchedulingDraft,
  buildHiringManagerInquiryReply,
  buildInventoryOnlineCompletenessReply,
  buildMarketplaceSellMyBikeReviewReply,
  buildRideChallengeSignupReply,
  buildTakeOffMilwaukeeEightEngineReply,
  buildUnlistedInventoryHandoffReply,
  buildTimingAwareWalkInFollowUpLine,
  catalogModelMentionMatchesText,
  cleanCatalogModelNameForDisplay,
  extractInventoryStockIdMention,
  getBroadScheduleWindowLabel,
  hasRideChallengeSignupAcknowledgement,
  isAccessoryCustomizationRequestText,
  isAudioDemoStatusQuestionText,
  isBusinessHoursQuestionText,
  isBlockedCadencePersonalizationLineText,
  isCloseoutSignoffNoResponseText,
  isDealerLeadAppPostDemoRideAdfText,
  isDemoDayEventQuestionText,
  isDirectInventoryAvailabilityQuestionText,
  isExternalDealerApprovalTransferQuestionText,
  isFactoryOrderTimingQuestionText,
  isFollowUpReminderOnlyText,
  isConditionalPickupPlanText,
  hasExplicitCalendarDateForScheduleMemory,
  isImmediateChatCallbackAvailabilityText,
  getScheduleDayOptionsLabel,
  inferAcceptedScheduleDayFromReplyText,
  isIncidentalInfoAcknowledgementText,
  isInventoryBrowseLinkRequestText,
  isInventoryOnlineCompletenessQuestionText,
  isUnlistedInventoryQuestionText,
  isHiringManagerInquiryText,
  isIncidentalTravelTimingContextNoteText,
  isRideChallengeLeadSignal,
  isManualOutboundBookingConfirmationText,
  isManualOutboundTentativeScheduleOfferText,
  isMediaProofStatusUpdateText,
  isNonComplimentLikePhraseText,
  isPurchaseDeliveryContextText,
  isPurchaseDeliveryTimingText,
  isRegenerateSchedulingLanguageText,
  isShortAckNoReplyText,
  isStockNumberInventoryInterestText,
  isTakeOffMilwaukeeEightEngineRequestText,
  isTimingOnlyFollowUpTopic,
  isCustomerReturningCallText,
  isVisitPlanContextNoteText,
  pickCatalogModelLabelFromText,
  resolveRequestedScheduleWindowMode,
  selectRequestedAvailabilityModelMentions,
  shouldClearPickupStateForSchedulingReply,
  shouldRebaseWeekdayReplyToPriorNextWeek,
  shouldCarryLeadYearForRequestedModel,
  shouldIgnoreAdfModelMismatchForTradeContext,
  shouldSuppressInitialAvailabilityLineAppend,
  shouldSuppressInitialInventoryPhotoAppend,
  shouldSuppressVoiceCallbackTodoForAppointment,
  shouldTreatAdfAsWalkInContext
} from "../services/api/src/domain/workflowRegressionGuards.ts";
import { inferTodoTaskClass, parseRequestedDayTime } from "../services/api/src/domain/conversationStore.ts";
import { applyDraftStateInvariants } from "../services/api/src/domain/draftStateInvariants.ts";
import { detectSchedulingSignals } from "../services/api/src/domain/legacyRegexFallback.ts";
import { isLogisticsProgressUpdateText } from "../services/api/src/domain/transitionSafety.ts";

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
    id: "manual_outbound_tentative_time_offer_does_not_confirm",
    actual: isManualOutboundTentativeScheduleOfferText("Hey Jen, lets shoot for 9:30 if that works"),
    expected: true
  },
  {
    id: "manual_outbound_tentative_booking_text_does_not_confirm",
    actual: isManualOutboundBookingConfirmationText("I'll schedule you in at 9:30 if that works"),
    expected: false
  },
  {
    id: "manual_outbound_loose_ack_does_not_confirm_booking",
    actual: isManualOutboundBookingConfirmationText("That works!"),
    expected: false
  },
  {
    id: "manual_outbound_schedule_you_in_between_window_confirms",
    actual: isManualOutboundBookingConfirmationText("Hey Rafael, sorry, that would work ill schedule you in between 11-12 tomorrow"),
    expected: true
  },
  {
    id: "human_mode_reschedule_without_time_asks_for_day_time",
    actual: buildHumanModeSchedulingDraft({ intent: "reschedule" }),
    expected: "No worries — what day and time works best to reschedule?"
  },
  {
    id: "human_mode_reschedule_without_time_uses_booking_link",
    actual: buildHumanModeSchedulingDraft({ intent: "reschedule", bookingUrl: "https://dealer.example/book" }),
    expected: "No worries — you can reschedule here: https://dealer.example/book"
  },
  {
    id: "reschedule_requested_todo_classifies_as_appointment_without_time",
    actual: inferTodoTaskClass("call", "Appointment reschedule requested."),
    expected: "appointment"
  },
  {
    id: "customer_reschedule_link_reply_uses_first_name",
    actual: buildAppointmentRescheduleBookingLinkReply({
      firstName: "Alex",
      bookingUrl: "https://dealer.example/book"
    }),
    expected: "No problem, Alex — you can reschedule here: https://dealer.example/book"
  },
  {
    id: "human_mode_reschedule_day_only_asks_for_time",
    actual: buildHumanModeSchedulingDraft({ intent: "reschedule", requestedDay: "Saturday" }),
    expected: "No worries — what time works best on Saturday to reschedule?"
  },
  {
    id: "available_to_chat_now_routes_as_callback_fallback",
    actual: isImmediateChatCallbackAvailabilityText(
      "Hi Joe, I'm available to chat right now if that works for you."
    ),
    expected: true
  },
  {
    id: "text_preference_does_not_route_as_chat_callback_fallback",
    actual: isImmediateChatCallbackAvailabilityText(
      "I'm available to chat by text right now, please don't call."
    ),
    expected: false
  },
  {
    id: "open_till_when_detected_as_hours_question",
    actual: isBusinessHoursQuestionText("Like to see tomorrow. You open till when"),
    expected: true
  },
  {
    id: "open_until_what_time_detected_as_hours_question",
    actual: isBusinessHoursQuestionText("Are you open until what time tomorrow?"),
    expected: true
  },
  {
    id: "open_plus_time_proposal_detected_as_hours_question",
    actual: isBusinessHoursQuestionText("Is the dealership open on Monday? If so, would 1 work?"),
    expected: true
  },
  {
    id: "open_to_options_not_hours_question",
    actual: isBusinessHoursQuestionText("I am open to either color tomorrow"),
    expected: false
  },
  {
    id: "after_hours_context_not_hours_question",
    actual: isBusinessHoursQuestionText(
      "Sorry to text after hours but had a quick question. Would Rider to Rider work for a private seller bike?"
    ),
    expected: false
  },
  {
    id: "after_hours_courtesy_not_hours_question",
    actual: isBusinessHoursQuestionText(
      "Hi Joe, sorry to text you after hours but had a quick question. Would you be able to facilitate a trade for a used bike I found with a private seller?"
    ),
    expected: false
  },
  {
    id: "touch_base_statement_is_follow_up_reminder_only",
    actual: isFollowUpReminderOnlyText("Hey brother, let’s touch base on Tuesday. Thank you."),
    expected: true
  },
  {
    id: "touch_base_statement_extracts_day_label",
    actual: extractReminderFollowUpLabel("Hey brother, let’s touch base on Tuesday. Thank you."),
    expected: "Tuesday"
  },
  {
    id: "touch_base_statement_builds_ack_not_time_request",
    actual: buildFollowUpReminderOnlyReply("Hey brother, let’s touch base on Tuesday. Thank you."),
    expected: "Sounds good — I’ll touch base Tuesday."
  },
  {
    id: "schedule_question_is_not_follow_up_reminder_only",
    actual: isFollowUpReminderOnlyText("Can we schedule an appointment Tuesday?"),
    expected: false
  },
  {
    id: "conditional_pickup_plan_is_not_schedule_request",
    actual: isConditionalPickupPlanText("Great. if not I'll pick it up tuesday."),
    expected: true
  },
  {
    id: "conditional_pickup_plan_ack_does_not_ask_time",
    actual: buildConditionalPickupPlanAck("Great. if not I'll pick it up tuesday."),
    expected: "Sounds good — just give me a heads up if you end up picking it up Tuesday."
  },
  {
    id: "service_time_330_defaults_to_pm_when_no_meridiem",
    actual: formatServiceScheduleTimeLabel("330", "I can definitely do tomorrow at 330 or 4."),
    expected: "3:30 PM"
  },
  {
    id: "service_time_after_3_defaults_to_pm",
    actual: formatServiceScheduleTimeLabel("3", "Would there be any time after 3 available?"),
    expected: "3:00 PM"
  },
  {
    id: "voice_callback_suppressed_when_call_books_appointment",
    actual: shouldSuppressVoiceCallbackTodoForAppointment({
      callbackRequested: true,
      bookingIntentAccepted: true,
      bookingIntent: "schedule",
      requestedDay: "tomorrow",
      requestedTime: "10",
      requestedWindow: "exact",
      sourceText:
        "Customer will stop by around ten in the morning for staff to inspect the bike and discuss an offer."
    }),
    expected: true
  },
  {
    id: "voice_callback_kept_when_separate_callback_request",
    actual: shouldSuppressVoiceCallbackTodoForAppointment({
      callbackRequested: true,
      bookingIntentAccepted: true,
      bookingIntent: "schedule",
      requestedDay: "tomorrow",
      requestedTime: "10",
      requestedWindow: "exact",
      sourceText: "Customer will stop by around ten. Customer also asked: please call me later."
    }),
    expected: false
  },
  {
    id: "visit_plan_context_note_does_not_create_callback_reminder",
    actual: isVisitPlanContextNoteText(
      "Customer asked to be called when more info is available and agreed to come by tomorrow after 3:30; Scott will text the customer and follow up."
    ),
    expected: true
  },
  {
    id: "customer_will_call_right_back_not_salesperson_callback",
    actual: isCustomerReturningCallText(
      "Customer: Do you mind if I give you a call right back? Summary: Customer will call back later."
    ),
    expected: true
  },
  {
    id: "incidental_trip_timing_does_not_create_callback_reminder",
    actual: isIncidentalTravelTimingContextNoteText(
      "Would like to take sometime to go over finances and might want the trike street glide limited in the brilliant red. Going on a trip end of the month. Definitely interested in the bike."
    ),
    expected: true
  },
  {
    id: "marketplace_sell_my_bike_followup_review_reply",
    actual: buildMarketplaceSellMyBikeReviewReply({
      firstName: "Zuhair",
      bikeLabel: "2018 Street Bob",
      isInitialAdf: false
    }),
    expected:
      "Thanks Zuhair — I received the updated sell-my-bike details for 2018 Street Bob. I’ll review the info and photos, then follow up with next steps."
  },
  {
    id: "marketplace_sell_my_bike_initial_review_reply",
    actual: buildMarketplaceSellMyBikeReviewReply({
      bikeLabel: "2018 Street Bob",
      isInitialAdf: true,
      agentName: "Alexandra",
      dealerName: "American Harley-Davidson"
    }),
    expected:
      "Thanks — I received the sell-my-bike details for 2018 Street Bob. This is Alexandra at American Harley-Davidson. I’ll review the info and photos, then follow up with next steps."
  },
  {
    id: "external_dealer_approval_transfer_detects_buffalo_harley",
    actual: isExternalDealerApprovalTransferQuestionText(
      "If financing approved at buffalo harly is it go at your store ?"
    ),
    expected: true
  },
  {
    id: "external_dealer_approval_transfer_ignores_credit_union_statement",
    actual: isExternalDealerApprovalTransferQuestionText("I'm already approved through my credit union."),
    expected: false
  },
  {
    id: "external_dealer_approval_transfer_reply_professional",
    actual: buildExternalDealerApprovalTransferReply("https://credit.example/app"),
    expected:
      "Yes — if that approval was through Harley-Davidson Financial Services, it can be used at our store. We do still need you to complete a separate application for our dealership because Harley-Davidson does not transfer the application over to us. It will not be another credit inquiry.\n\nhttps://credit.example/app"
  },
  {
    id: "multi_day_schedule_options_preserve_friday_or_saturday",
    actual: getScheduleDayOptionsLabel(
      "Ooh that looks sharp! Friday morning, early afternoon, or anytime, Saturday I can come out and take a look"
    ),
    expected: "Friday or Saturday"
  },
  {
    id: "manual_outbound_meet_with_tomorrow_confirms_booking",
    actual: isManualOutboundBookingConfirmationText("I will have you meet with Giovanni tomorrow around 4:30-5:00"),
    expected: true
  },
  {
    id: "manual_outbound_tomorrow_wins_over_prior_thursday_pickup",
    actual:
      parseRequestedDayTime(
        "I will have you meet with Giovanni tomorrow around 4:30-5:00",
        "America/New_York"
      )?.hour24 ?? null,
    expected: 16
  },
  {
    id: "approx_compact_315_keeps_minutes",
    actual: (() => {
      const parsed = parseRequestedDayTime("Friday around 315-ish", "America/New_York");
      return !!parsed && parsed.hour24 === 15 && parsed.minute === 15;
    })(),
    expected: true
  },
  {
    id: "approx_colon_315_keeps_minutes",
    actual: (() => {
      const parsed = parseRequestedDayTime("Friday around 3:15-ish", "America/New_York");
      return !!parsed && parsed.hour24 === 15 && parsed.minute === 15;
    })(),
    expected: true
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
    id: "slash_time_window_day_time_parsed",
    actual: (() => {
      const parsed = parseRequestedDayTime("tomorrow around 11/12 would work best for me", "America/New_York");
      return !!parsed && parsed.hour24 === 11 && parsed.minute === 0;
    })(),
    expected: true
  },
  {
    id: "dash_time_window_day_time_parsed",
    actual: (() => {
      const parsed = parseRequestedDayTime("ill schedule you in between 11-12 tomorrow", "America/New_York");
      return !!parsed && parsed.hour24 === 11 && parsed.minute === 0;
    })(),
    expected: true
  },
  {
    id: "tomorrow_noonish_parses_as_noon",
    actual: (() => {
      const parsed = parseRequestedDayTime("tomorrow noonish", "America/New_York");
      return !!parsed && parsed.hour24 === 12 && parsed.minute === 0;
    })(),
    expected: true
  },
  {
    id: "close_to_compact_time_day_time_detected",
    actual: detectSchedulingSignals("Am I able to ride a road glide today? I can take lunch close to 430.").hasDayTime,
    expected: true
  },
  {
    id: "logistics_driving_deadline_not_schedule",
    actual: isLogisticsProgressUpdateText("Let me know because I start driving on Friday morning. Please"),
    expected: true
  },
  {
    id: "arrival_status_on_my_way_not_schedule",
    actual: isLogisticsProgressUpdateText("On my way doing my best to be there by 530"),
    expected: true
  },
  {
    id: "plain_friday_morning_visit_not_logistics",
    actual: isLogisticsProgressUpdateText("I can come in Friday morning"),
    expected: false
  },
  {
    id: "soft_visit_date_range_detected_without_schedule_request",
    actual: (() => {
      const signals = detectSchedulingSignals(
        "Cool. Ill try to stop by the 15th or 16th. Never know because of my work schedule. Thanks"
      );
      return signals.softVisit === true && signals.hasDayOnlyRequest === false && signals.explicit === false;
    })(),
    expected: true
  },
  {
    id: "thanks_for_info_is_not_specs_request",
    actual: isIncidentalInfoAcknowledgementText("Thanks for info. And any appointments later this month same time."),
    expected: true
  },
  {
    id: "can_you_send_info_is_not_incidental_ack",
    actual: isIncidentalInfoAcknowledgementText("Can you send more info on that bike?"),
    expected: false
  },
  {
    id: "regen_appointments_plural_later_this_month_is_actionable_schedule",
    actual: isRegenerateSchedulingLanguageText("Thanks for info. And any appointments later this month same time."),
    expected: true
  },
  {
    id: "broad_schedule_window_preserves_later_this_month",
    actual: getBroadScheduleWindowLabel("Thanks for info. And any appointments later this month same time."),
    expected: "later this month"
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
    id: "free_all_day_routes_as_any_time",
    actual: resolveRequestedScheduleWindowMode("I'm free all day on Saturday"),
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
    id: "suppresses_duplicate_availability_append_after_test_ride_copy",
    actual: shouldSuppressInitialAvailabilityLineAppend(
      "Hi Angelo — This is Alexandra at American Harley-Davidson. Thanks — I saw you’re interested in a test ride on the 2026 Street Glide. What day works best for you?"
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
    id: "new_sell_my_bike_adf_overrides_prior_walkin_context",
    actual: shouldTreatAdfAsWalkInContext({
      leadSource: "Marketplace - Sell My Bike",
      priorWalkIn: true,
      explicitWalkInLeadSource: false,
      trafficLogPayloadHint: false,
      walkInSignalHint: false
    }),
    expected: false
  },
  {
    id: "new_value_my_trade_adf_overrides_prior_walkin_context",
    actual: shouldTreatAdfAsWalkInContext({
      leadSource: "Marketplace - Value My Trade",
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
    id: "heated_grips_possibility_request_detected",
    actual: isAccessoryCustomizationRequestText("Are heated handle grips a possibility"),
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
    id: "heated_grips_customization_reply_acknowledges_possible",
    actual: /heated grips are possible/i.test(
      buildAccessoryCustomizationReply("Are heated handle grips a possibility")
    ),
    expected: true
  },
  {
    id: "audio_demo_status_question_detected",
    actual: isAudioDemoStatusQuestionText("Did you get a stereo for me to hear yet ?"),
    expected: true
  },
  {
    id: "audio_demo_status_reply_carries_tomorrow_day",
    actual: buildAudioDemoStatusReply({ acceptedDay: "tomorrow" }),
    expected: "I’ll check on the stereo for you and follow up shortly. What time tomorrow works best?"
  },
  {
    id: "audio_demo_status_reply_can_acknowledge_humor",
    actual: buildAudioDemoStatusReply({ acceptedDay: "tomorrow", hasHumor: true }),
    expected: "Haha, gotcha — I’ll check on the stereo for you and follow up shortly. What time tomorrow works best?"
  },
  {
    id: "hiring_manager_inquiry_detected",
    actual: isHiringManagerInquiryText("Who is the hiring manager for American Harley Davidson?"),
    expected: true
  },
  {
    id: "credit_application_not_hiring_manager_inquiry",
    actual: isHiringManagerInquiryText(
      "PreQual: N, PreQualified Amount; $0 Please note non-prequalified customers can still be considered for approval with a completed credit application."
    ),
    expected: false
  },
  {
    id: "generic_application_not_hiring_without_job_context",
    actual: isHiringManagerInquiryText("I filled out the application online."),
    expected: false
  },
  {
    id: "hiring_manager_reply_handoff",
    actual: /hiring manager follow up/i.test(buildHiringManagerInquiryReply()),
    expected: true
  },
  {
    id: "inventory_online_completeness_question_detected",
    actual: isInventoryOnlineCompletenessQuestionText(
      "Interested in buying a used bike. We completed credit online already. Is all of your inventory posted online?"
    ),
    expected: true
  },
  {
    id: "inventory_online_completeness_reply_mentions_unlisted_bikes",
    actual: /may not be on the website yet/i.test(buildInventoryOnlineCompletenessReply()),
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
    id: "demo_day_question_detected",
    actual: isDemoDayEventQuestionText("Let me know if you guys have a demo day like Kawasaki"),
    expected: true
  },
  {
    id: "demo_day_question_with_question_mark_detected",
    actual: isDemoDayEventQuestionText("Do you guys have demo days from Harley?"),
    expected: true
  },
  {
    id: "dealer_lead_app_post_demo_raw_body_detected",
    actual: isDealerLeadAppPostDemoRideAdfText(
      "Lead App - Type: Y\nSalesPerson: GIOVANNI BOCCABELLA\nWhich model of motorcycle are you interested in?\n2026,TRIKE,STREET GLIDE 3 LIMITED Demo Bikes Ridden: 2026,TRIKE,STREET GLIDE 3 LIMITED Email Opt-In:Yes"
    ),
    expected: true
  },
  {
    id: "normal_inventory_watch_request_not_demo_day_question",
    actual: isDemoDayEventQuestionText("Let me know if you get a Road Glide in black"),
    expected: false
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
    id: "availability_alternatives_ignore_comparison_reference_model",
    actual: JSON.stringify(
      selectRequestedAvailabilityModelMentions(
        "Do you have the sportster or nightster in stock? Or something a bit lighter than the low rider",
        [
          { model: "Sportster", index: 16 },
          { model: "Nightster", index: 29 },
          { model: "Low Rider", index: 84 }
        ]
      )
    ),
    expected: JSON.stringify(["Sportster", "Nightster"])
  },
  {
    id: "direct_in_stock_alternatives_prioritize_availability",
    actual: isDirectInventoryAvailabilityQuestionText(
      "Do you the sportster or nightster in stock ? Or something a bit lighter than the low rider"
    ),
    expected: true
  },
  {
    id: "direct_availability_with_apology_tail_prioritizes_inventory",
    actual: isDirectInventoryAvailabilityQuestionText(
      "do you have the 26 heritage classic in brilliant red? sorry, been really busy"
    ),
    expected: true
  },
  {
    id: "schedule_available_word_does_not_prioritize_inventory",
    actual: isDirectInventoryAvailabilityQuestionText("Are you available Tuesday around 10?"),
    expected: false
  },
  {
    id: "like_i_said_is_not_compliment",
    actual: isNonComplimentLikePhraseText("Like I said. I'm 💯 legit"),
    expected: true
  },
  {
    id: "media_proof_status_detects_legit_update",
    actual: isMediaProofStatusUpdateText("Like I said. I'm 💯 legit"),
    expected: true
  },
  {
    id: "media_proof_status_does_not_catch_inventory_question",
    actual: isMediaProofStatusUpdateText("Is this available?"),
    expected: false
  },
  {
    id: "pickup_state_cleared_for_schedule_time_reply",
    actual: shouldClearPickupStateForSchedulingReply({
      lastOutboundText:
        "Tuesday can work. I don’t have any other questions right now — just let me know what time you are thinking so I can schedule you in.",
      inboundText:
        "Ok. I'm retired so in the morning is best for me so between 9:30 and 10:00. I'll have everything for the bike with me, title etc.",
      dialogState: "schedule_request"
    }),
    expected: true
  },
  {
    id: "time_only_reply_infers_accepted_tuesday_from_prior_schedule_prompt",
    actual: inferAcceptedScheduleDayFromReplyText(
      "Tuesday can work. I don’t have any other questions right now — just let me know what time you are thinking so I can schedule you in."
    ),
    expected: "Tuesday"
  },
  {
    id: "time_only_reply_ignores_later_bad_slot_draft_and_finds_prior_accepted_day",
    actual: inferAcceptedScheduleDayFromReplyText(
      [
        "I can set up a trade appraisal. I have Thu, May 7, 9:30 AM or Thu, May 7, 11:30 AM — do any of these times work?",
        "Tuesday can work. I don’t have any other questions right now — just let me know what time you are thinking so I can schedule you in."
      ].join("\n")
    ),
    expected: "Tuesday"
  },
  {
    id: "half_hour_travel_note_not_calendar_date",
    actual: hasExplicitCalendarDateForScheduleMemory(
      "Ok. I'm retired so in the morning is best for me so between 9:30 and 10:00. I'll text you when I leave my house 1/2 to get there traffic pending"
    ),
    expected: false
  },
  {
    id: "numeric_calendar_date_still_blocks_prior_day_memory",
    actual: hasExplicitCalendarDateForScheduleMemory("5/12 between 9:30 and 10:00 works"),
    expected: true
  },
  {
    id: "pickup_state_not_cleared_for_explicit_pickup_reply",
    actual: shouldClearPickupStateForSchedulingReply({
      lastOutboundText: "What street address should we use for pickup?",
      inboundText: "Can you pick it up at 123 Main Street?",
      dialogState: "trade_cash"
    }),
    expected: false
  },
  {
    id: "purchase_delivery_context_detects_loan_insurance_pickup",
    actual: isPurchaseDeliveryContextText(
      [
        "Loans finalized just need to send them insurance paper work",
        "Thanks for sending that over John, I will get rolling on everything. What time works for you today?",
        "1-2 o'clock ish"
      ].join("\n")
    ),
    expected: true
  },
  {
    id: "purchase_delivery_timing_detects_oclock_range",
    actual: isPurchaseDeliveryTimingText("1-2 o'clock ish"),
    expected: true
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
    id: "unlisted_back_room_inventory_routes_to_turnover",
    actual: isUnlistedInventoryQuestionText(
      "Hey Gio.. is there anything in the back that we looked at that would fit my budget?"
    ),
    expected: true
  },
  {
    id: "unlisted_not_posted_inventory_routes_to_turnover",
    actual: isFactoryOrderTimingQuestionText("Do you have anything not posted online yet around my budget?"),
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
    id: "unlisted_inventory_reply_promises_check",
    actual: buildUnlistedInventoryHandoffReply(),
    expected: "I’ll take a look for anything not listed yet that fits your budget and follow up with you."
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
  },
  {
    id: "takeoff_m8_engine_parts_request_detected",
    actual: isTakeOffMilwaukeeEightEngineRequestText(
      "If you get anyone yanking out their 114/117 M-8 to upgrade let me know as I am in the market for one."
    ),
    expected: true
  },
  {
    id: "takeoff_m8_engine_parts_reply_mentions_parts_watch",
    actual: buildTakeOffMilwaukeeEightEngineReply(),
    expected:
      "I got your note about looking for a take-off Milwaukee-Eight 114/117. I’ll have our parts team keep an eye out, and if one becomes available from an upgrade we’ll reach out."
  },
  {
    id: "takeoff_m8_parts_handoff_reply_not_blocked_as_inventory_prompt",
    actual: applyDraftStateInvariants({
      inboundText:
        "If you get anyone yanking out their 114/117 M-8 to upgrade let me know as I am in the market for one.",
      draftText: buildTakeOffMilwaukeeEightEngineReply(),
      followUpMode: "manual_handoff",
      followUpReason: "parts_request",
      dialogState: "parts_handoff",
      classificationBucket: "parts",
      classificationCta: "parts_request"
    }).allow,
    expected: true
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
