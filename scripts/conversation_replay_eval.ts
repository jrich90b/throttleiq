import { applyDraftStateInvariants } from "../services/api/src/domain/draftStateInvariants.ts";

type Case = {
  id: string;
  expectedAllow: boolean;
  expectedReason?: string;
  expectedDraftContains?: string;
  input: {
    inboundText: string;
    draftText: string;
    followUpMode?: string | null;
    followUpReason?: string | null;
    dialogState?: string | null;
    classificationBucket?: string | null;
    classificationCta?: string | null;
    turnFinanceIntent?: boolean | null;
    turnAvailabilityIntent?: boolean | null;
    turnSchedulingIntent?: boolean | null;
    financeContextIntent?: boolean | null;
    shortAckIntent?: boolean | null;
  };
};

const cases: Case[] = [
  {
    id: "kelly_short_ack_blocks_walkaround_prompt",
    expectedAllow: false,
    expectedReason: "short_ack_no_action_guard",
    input: {
      inboundText: "Ok sounds great!",
      draftText:
        "Glad you like it — I can send more photos or a quick walkaround video. Anything specific you want to see?",
      followUpMode: "manual_handoff",
      followUpReason: "manual_appointment",
      dialogState: "none",
      classificationBucket: "general_inquiry",
      classificationCta: "unknown",
      shortAckIntent: true
    }
  },
  {
    id: "dylan_dealer_ride_blocks_model_clarifier",
    expectedAllow: false,
    expectedReason: "manual_handoff_inventory_prompt_guard",
    input: {
      inboundText:
        "customer comments: giovanni boccabella ... purchase timeframe: i am not interested in purchasing at this time",
      draftText: "You're welcome. happy to help with pricing or a model comparison. Which model are you leaning toward?",
      followUpMode: "manual_handoff",
      followUpReason: "dealer_ride_no_purchase",
      dialogState: "followup_paused",
      classificationBucket: "general_inquiry",
      classificationCta: "unknown"
    }
  },
  {
    id: "michael_service_thread_blocks_watch_prompt",
    expectedAllow: false,
    expectedReason: "manual_handoff_inventory_prompt_guard",
    input: {
      inboundText: "Can u add this to parts. It's drag specialties website.",
      draftText:
        "You're welcome. just to confirm, should I watch for the exact year/color/finish, the same year any color, or a year range?",
      followUpMode: "manual_handoff",
      followUpReason: "credit_app",
      dialogState: "service_handoff",
      classificationBucket: "service",
      classificationCta: "service_request"
    }
  },
  {
    id: "service_handoff_allows_explicit_availability_answer",
    expectedAllow: true,
    input: {
      inboundText: "Is it still available?",
      draftText: "Yes — the Street Glide is available. What day and time works best to stop in and take a look?",
      followUpMode: "manual_handoff",
      followUpReason: "service_request",
      dialogState: "service_handoff",
      classificationBucket: "service",
      classificationCta: "service_request",
      turnAvailabilityIntent: true
    }
  },
  {
    id: "finance_progress_update_blocks_unsupported_hold_promise",
    expectedAllow: false,
    expectedReason: "unsupported_inventory_hold_promise_guard",
    input: {
      inboundText: "I called them yesterday and they say it should be done today",
      draftText: "Sounds good — I’ll keep the 21 SGS held for you and text if anything changes.",
      followUpMode: "manual_handoff",
      followUpReason: "credit_app",
      dialogState: "pricing_handoff",
      classificationBucket: "inventory_interest",
      classificationCta: "ask_payment",
      turnFinanceIntent: true,
      financeContextIntent: true
    }
  },
  {
    id: "finance_progress_update_repairs_schedule_prompt",
    expectedAllow: true,
    expectedReason: "finance_progress_update_repaired",
    expectedDraftContains: "finance team review it",
    input: {
      inboundText:
        "Just wanted to give you an update. We are FINALLY signing the papers today. They were giving me a hard time about the Harley credit address. Hopefully within a week I should be good.",
      draftText: "Happy to set that up. What day and time work best for you?",
      followUpMode: "manual_handoff",
      followUpReason: "credit_app",
      dialogState: "none",
      classificationBucket: "finance_prequal",
      classificationCta: "hdfs_coa"
    }
  },
  {
    id: "finance_progress_update_repairs_closed_day_next_steps_drift",
    expectedAllow: true,
    expectedReason: "finance_progress_update_repaired",
    expectedDraftContains: "finance team review it",
    input: {
      inboundText:
        "Just wanted to give you an update. We are FINALLY signing the papers today. They were giving me a hard time about the Harley credit address. Hopefully within a week I should be good.",
      draftText:
        "Got it. That’s great news — congrats on signing the papers. I’m closed today, but I’ll have someone follow up tomorrow to help with the next steps.",
      followUpMode: "manual_handoff",
      followUpReason: "credit_app",
      dialogState: "none",
      classificationBucket: "finance_prequal",
      classificationCta: "hdfs_coa"
    }
  },
  {
    id: "finance_progress_update_repairs_tagged_ready_stop_in_drift",
    expectedAllow: true,
    expectedReason: "finance_progress_update_repaired",
    expectedDraftContains: "finance team review it",
    input: {
      inboundText:
        "Just wanted to give you an update. We are FINALLY signing the papers today. They were giving me a hard time about the Harley credit address. Hopefully within a week I should be good.",
      draftText:
        "Thanks for the update. That’s great news—congrats on getting the papers signed. I’ll keep the 21 SGS tagged and ready for you. No rush—I’m here when you’re good to stop in.",
      followUpMode: "manual_handoff",
      followUpReason: "credit_app",
      dialogState: "none",
      classificationBucket: "finance_prequal",
      classificationCta: "hdfs_coa"
    }
  },
  {
    id: "finance_progress_update_repairs_hold_offer_drift",
    expectedAllow: true,
    expectedReason: "finance_progress_update_repaired",
    expectedDraftContains: "finance team review it",
    input: {
      inboundText:
        "Just wanted to give you an update. We are FINALLY signing the papers today. They were giving me a hard time about the Harley credit address. Hopefully within a week I should be good.",
      draftText:
        "Thanks for the update. That’s great news—congrats on signing the papers. I’m here when you’re ready; just text or call if you want me to hold the 21 SGS or look for another option.",
      followUpMode: "manual_handoff",
      followUpReason: "credit_app",
      dialogState: "none",
      classificationBucket: "finance_prequal",
      classificationCta: "hdfs_coa"
    }
  },
  {
    id: "pricing_down_payment_followup_is_allowed",
    expectedAllow: true,
    input: {
      inboundText: "I have 5000 to put down",
      draftText: "Perfect — with $5,000 down, do you want me to run 60, 72, or 84 months?",
      followUpMode: "active",
      followUpReason: "pricing",
      dialogState: "pricing_answered",
      classificationBucket: "inventory_interest",
      classificationCta: "ask_payment",
      turnFinanceIntent: true,
      financeContextIntent: true
    }
  },
  {
    id: "joseph_down_payment_blocks_inventory_model_prompt",
    expectedAllow: false,
    expectedReason: "finance_priority_inventory_prompt_guard",
    input: {
      inboundText: "I have 5000 to put down",
      draftText: "Sounds good. happy to help with pricing or a model comparison. Which model are you leaning toward?",
      followUpMode: "active",
      followUpReason: "pricing",
      dialogState: "pricing_answered",
      classificationBucket: "inventory_interest",
      classificationCta: "ask_payment",
      turnFinanceIntent: true,
      financeContextIntent: true
    }
  },
  {
    id: "joseph_monthly_target_blocks_availability_offer",
    expectedAllow: false,
    expectedReason: "finance_priority_inventory_prompt_guard",
    input: {
      inboundText: "I really want to stay under $400.",
      draftText:
        "Yes — we do have a new 2026 Street Glide in Dark Billiard Gray Chrome Trim in stock. Would you like to stop by to take a look?",
      followUpMode: "active",
      followUpReason: "pricing",
      dialogState: "pricing_answered",
      classificationBucket: "inventory_interest",
      classificationCta: "ask_payment",
      turnFinanceIntent: true,
      financeContextIntent: true
    }
  },
  {
    id: "joseph_availability_question_blocks_pricing_prompt",
    expectedAllow: false,
    expectedReason: "availability_priority_pricing_prompt_guard",
    input: {
      inboundText: "Do you have any black street glides in-stock?",
      draftText:
        "The price we have listed for T19-26 is $24,999. Final price can change with tax, fees, trade-in, and financing. Do you have a trade?",
      followUpMode: "active",
      followUpReason: "pricing",
      dialogState: "pricing_answered",
      classificationBucket: "inventory_interest",
      classificationCta: "check_availability",
      turnAvailabilityIntent: true
    }
  },
  {
    id: "handlebar_customization_blocks_pricing_carryover",
    expectedAllow: false,
    expectedReason: "customization_priority_pricing_prompt_guard",
    input: {
      inboundText: "Are you able to change handbars not a fan of the ones on there",
      draftText:
        "Thanks for your interest in the 2025 Road Glide. I’ll have a manager pull the exact pricing and follow up shortly.",
      followUpMode: "active",
      followUpReason: "pricing",
      dialogState: "pricing_answered",
      classificationBucket: "inventory_interest",
      classificationCta: "ask_payment",
      financeContextIntent: true
    }
  },
  {
    id: "availability_question_blocks_watch_without_answer",
    expectedAllow: false,
    expectedReason: "availability_priority_inventory_prompt_guard",
    input: {
      inboundText:
        "Hey I inquired about the red street glide but had to wait on my id to come in still waiting on it but just checking to make sure it's still available",
      draftText:
        "Sounds good. I can text you as soon as a red Street Glide comes in. Anything else you want me to watch for (year, miles, or price)?",
      followUpMode: "active",
      followUpReason: "inventory_watch",
      dialogState: "inventory_watch_prompted",
      classificationBucket: "inventory_interest",
      classificationCta: "check_availability",
      turnAvailabilityIntent: true
    }
  },
  {
    id: "blake_credit_app_blocks_inventory_prompt",
    expectedAllow: false,
    expectedReason: "finance_priority_inventory_prompt_guard",
    input: {
      inboundText: "I want to fill out a credit app",
      draftText: "Absolutely. happy to help with pricing or a model comparison. Which model are you leaning toward?",
      followUpMode: "active",
      followUpReason: "pricing",
      dialogState: "pricing_answered",
      classificationBucket: "inventory_interest",
      classificationCta: "ask_payment",
      turnFinanceIntent: true,
      financeContextIntent: true
    }
  },
  {
    id: "finance_inventory_miss__13152739247_20260401144531",
    expectedAllow: false,
    expectedReason: "finance_priority_inventory_prompt_guard",
    input: {
      inboundText: "I want to fill out a credit app ",
      draftText: "Absolutely. happy to help with pricing or a model comparison. Which model are you leaning toward?",
      followUpMode: "active",
      followUpReason: "pricing",
      dialogState: "pricing_answered",
      classificationBucket: "inventory_interest",
      classificationCta: "ask_payment"
    }
  },
  {
    id: "marcy_thanks_blocks_inventory_prompt",
    expectedAllow: false,
    expectedReason: "short_ack_no_action_guard",
    input: {
      inboundText: "Awesome! Thank you very much!",
      draftText:
        "Glad you like it — I can send more photos or a quick walkaround video. Anything specific you want to see?",
      followUpMode: "manual_handoff",
      followUpReason: "manual_appointment",
      dialogState: "none",
      classificationBucket: "general_inquiry",
      classificationCta: "unknown",
      shortAckIntent: true
    }
  },
  {
    id: "short_ack_miss__17246830020_20260402205129",
    expectedAllow: false,
    expectedReason: "short_ack_no_action_guard",
    input: {
      inboundText: "Awesome!  Thank you very much!",
      draftText:
        "Glad you like it — I can send more photos or a quick walkaround video. Anything specific you want to see?"
    }
  },
  {
    id: "appointment_status_blocks_new_available_times_draft",
    expectedAllow: false,
    expectedReason: "appointment_status_new_schedule_guard",
    input: {
      inboundText: "Hey is my appointment today Dalton Magill ?",
      draftText: "Sounds good — I’ll check available times for today and follow up.",
      followUpMode: "active",
      followUpReason: "manual_appointment",
      dialogState: "schedule_request",
      classificationBucket: "general_inquiry",
      classificationCta: "appointment",
      turnSchedulingIntent: false
    }
  },
  {
    id: "post_sale_key_backseat_dropoff_blocks_time_check_draft",
    expectedAllow: false,
    expectedReason: "post_sale_logistics_schedule_guard",
    input: {
      inboundText:
        "Absolutely! Btw.  I'm hoping you guys still have my garage key on my sporster keyring I left with y'all?\n\nAlso, I'm stopping by after work today dropping off the backseat for sporster.  Thanks",
      draftText: "Sounds good — I’ll check that time and follow up.",
      followUpMode: "active",
      followUpReason: "post_sale",
      dialogState: "schedule_request",
      classificationBucket: "inventory_interest",
      classificationCta: "sold",
      turnSchedulingIntent: false
    }
  },
  {
    id: "finance_docs_blocks_schedule_reask",
    expectedAllow: false,
    expectedReason: "finance_priority_schedule_prompt_guard",
    input: {
      inboundText: "Before I come in, what do I need to bring in for financing?",
      draftText: "Absolutely — what day and time works for you?",
      followUpMode: "manual_handoff",
      followUpReason: "manual_appointment",
      dialogState: "none",
      classificationBucket: "general_inquiry",
      classificationCta: "unknown",
      turnFinanceIntent: true,
      financeContextIntent: true
    }
  },
  {
    id: "finance_docs_question_is_allowed",
    expectedAllow: true,
    input: {
      inboundText: "Before I come in, what do I need to bring in for financing?",
      draftText:
        "Bring your driver's license, proof of income, and insurance card. If you have a trade, bring title/registration and payoff info.",
      followUpMode: "manual_handoff",
      followUpReason: "manual_appointment",
      dialogState: "none",
      classificationBucket: "general_inquiry",
      classificationCta: "unknown"
    }
  },
  {
    id: "health_recovery_paused_fresh_inventory_interest_allowed",
    expectedAllow: true,
    input: {
      inboundText: "I'm looking for a 2026 cvo road glide but not an st",
      draftText: "Got it — I can keep an eye out for a 2026 CVO Road Glide that is not an ST and text you when one comes in.",
      followUpMode: "active",
      followUpReason: "health_recovery_delay",
      dialogState: "followup_paused",
      classificationBucket: "inventory_interest",
      classificationCta: "check_availability"
    }
  },
  {
    id: "explicit_watch_ack_allowed_despite_short_ack_words",
    expectedAllow: true,
    input: {
      inboundText: "I have no problem. let me know if you find something",
      draftText: "Got it — I’ll keep an eye out for a 2022 Forty-Eight and text you as soon as one comes in.",
      followUpMode: "holding_inventory",
      followUpReason: "inventory_watch",
      dialogState: "inventory_watch_active",
      classificationBucket: "in_store",
      classificationCta: "contact_us",
      shortAckIntent: false
    }
  },
  {
    id: "availability_watch_ack_allowed_when_alternatives_answered",
    expectedAllow: true,
    input: {
      inboundText:
        "If you dont mind keeping an eye out cause it either the iron 883 or a Fat Boy im looking for a breakout",
      draftText:
        "Got it - I’ll keep an eye out for an Iron 883 and text you if one comes in. Current options available right now: Breakout: 2025 Breakout plus 2 more. If either one interests you, I can send photos or more details.",
      followUpMode: "holding_inventory",
      followUpReason: "inventory_watch",
      dialogState: "inventory_watch_active",
      classificationBucket: "inventory_interest",
      classificationCta: "request_a_quote",
      turnAvailabilityIntent: true,
      shortAckIntent: false
    }
  },
  {
    id: "followup_paused_stale_inventory_prompt_still_blocked",
    expectedAllow: false,
    expectedReason: "paused_state_inventory_prompt_guard",
    input: {
      inboundText: "ok",
      draftText: "I can keep an eye out and text you as soon as one comes in.",
      followUpMode: "active",
      followUpReason: "health_recovery_delay",
      dialogState: "followup_paused",
      classificationBucket: "inventory_interest",
      classificationCta: "check_availability",
      shortAckIntent: false
    }
  },
  {
    id: "noah_service_manual_handoff_blocks_walkaround_prompt",
    expectedAllow: false,
    expectedReason: "short_ack_no_action_guard",
    input: {
      inboundText: "Ok",
      draftText:
        "Glad you like it — I can send more photos or a quick walkaround video. Anything specific you want to see?",
      followUpMode: "manual_handoff",
      followUpReason: "service_request",
      dialogState: "service_handoff",
      classificationBucket: "service",
      classificationCta: "service_request",
      shortAckIntent: true
    }
  },
  {
    id: "manual_appointment_confirmation_is_allowed",
    expectedAllow: true,
    input: {
      inboundText: "Monday 3:45-ish works",
      draftText:
        "Sounds good. I’ll be here Monday around 3:45 to meet you and go over options and financing.",
      followUpMode: "manual_handoff",
      followUpReason: "manual_appointment",
      dialogState: "none",
      classificationBucket: "general_inquiry",
      classificationCta: "unknown"
    }
  },
  {
    id: "wayne_other_inventory_fallback_repaired",
    expectedAllow: true,
    expectedReason: "unresolved_inventory_entity_repaired",
    expectedDraftContains: "current options in your range with bags",
    input: {
      inboundText: "Ok well im trying to stay in the mid 30s range with bags",
      draftText:
        "I'm not seeing a new 2026 Harley-Davidson Other in stock right now. I can check similar options or keep an eye out.",
      followUpMode: "manual_handoff",
      followUpReason: "finance_budget",
      dialogState: "pricing_init",
      classificationBucket: "inventory_interest",
      classificationCta: "ask_payment",
      turnFinanceIntent: true,
      financeContextIntent: true
    }
  },
  {
    id: "other_inventory_model_less_quote_repaired",
    expectedAllow: true,
    expectedReason: "unresolved_inventory_entity_repaired",
    expectedDraftContains: "pull current pricing",
    input: {
      inboundText:
        "WEB LEAD (ADF) Source: HD.com Request a Quote Year: 2026 Vehicle: Harley-Davidson Other",
      draftText:
        "I'm not seeing a new 2026 Harley-Davidson Other in stock right now. I can check similar options or keep an eye out.",
      followUpMode: "manual_handoff",
      followUpReason: "pricing",
      dialogState: "pricing_init",
      classificationBucket: "inventory_interest",
      classificationCta: "ask_payment"
    }
  },
  {
    id: "truncated_in_good_smalltalk_repaired",
    expectedAllow: true,
    expectedReason: "truncated_draft_repaired",
    expectedDraftContains: "check on that",
    input: {
      inboundText: "is he the best man for the job?",
      draftText: "Yeah, Hollis knows his stuff — you’ll be in good",
      followUpMode: "active",
      followUpReason: "manual_resume",
      dialogState: "small_talk"
    }
  },
  {
    id: "truncated_and_moves_smalltalk_repaired",
    expectedAllow: true,
    expectedReason: "truncated_draft_repaired",
    expectedDraftContains: "check on that",
    input: {
      inboundText: "is he the best man for the job?",
      draftText: "Yep, Hollis is solid — knows his stuff and moves",
      followUpMode: "active",
      followUpReason: "manual_resume",
      dialogState: "small_talk"
    }
  }
];

let passed = 0;
for (const c of cases) {
  const actual = applyDraftStateInvariants(c.input);
  const reasonMatches =
    !c.expectedReason ||
    String(actual.reason ?? "") === String(c.expectedReason ?? "");
  const draftMatches =
    !c.expectedDraftContains ||
    String(actual.draftText ?? "")
      .toLowerCase()
      .includes(String(c.expectedDraftContains).toLowerCase());
  const ok = actual.allow === c.expectedAllow && reasonMatches && draftMatches;
  if (ok) passed += 1;
  console.log(
    `${ok ? "PASS" : "FAIL"} ${c.id} expectedAllow=${c.expectedAllow} actualAllow=${actual.allow} expectedReason=${c.expectedReason ?? "-"} actualReason=${actual.reason ?? "-"}`
  );
}

if (passed !== cases.length) {
  console.error(`\n${cases.length - passed} failures out of ${cases.length} cases`);
  process.exit(1);
}

console.log(`\nAll ${cases.length} conversation replay checks passed.`);
