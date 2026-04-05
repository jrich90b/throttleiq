import { applyDraftStateInvariants } from "../services/api/src/domain/draftStateInvariants.ts";

type Case = {
  id: string;
  expectedAllow: boolean;
  expectedReason?: string;
  input: {
    inboundText: string;
    draftText: string;
    followUpMode?: string | null;
    followUpReason?: string | null;
    dialogState?: string | null;
    classificationBucket?: string | null;
    classificationCta?: string | null;
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
      classificationCta: "unknown"
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
    id: "pricing_down_payment_followup_is_allowed",
    expectedAllow: true,
    input: {
      inboundText: "I have 5000 to put down",
      draftText: "Perfect — with $5,000 down, do you want me to run 60, 72, or 84 months?",
      followUpMode: "active",
      followUpReason: "pricing",
      dialogState: "pricing_answered",
      classificationBucket: "inventory_interest",
      classificationCta: "ask_payment"
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
      classificationCta: "ask_payment"
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
      classificationCta: "ask_payment"
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
      classificationCta: "unknown"
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
      classificationCta: "unknown"
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
      classificationCta: "service_request"
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
  }
];

let passed = 0;
for (const c of cases) {
  const actual = applyDraftStateInvariants(c.input);
  const reasonMatches =
    c.expectedAllow ||
    !c.expectedReason ||
    String(actual.reason ?? "") === String(c.expectedReason ?? "");
  const ok = actual.allow === c.expectedAllow && reasonMatches;
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
