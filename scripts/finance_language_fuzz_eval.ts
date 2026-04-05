import { applyDraftStateInvariants } from "../services/api/src/domain/draftStateInvariants.ts";

type FinanceCase = {
  id: string;
  inboundText: string;
  expectInventoryGuard: boolean;
  expectScheduleGuard: boolean;
  context?: {
    followUpReason?: string | null;
    dialogState?: string | null;
  };
  hints?: {
    turnFinanceIntent?: boolean;
    turnAvailabilityIntent?: boolean;
    turnSchedulingIntent?: boolean;
    shortAckIntent?: boolean;
    financeContextIntent?: boolean;
  };
};

const inventoryPromptDraft =
  "Sounds good. happy to help with pricing or a model comparison. Which model are you leaning toward?";
const schedulePromptDraft = "Absolutely — what day and time works for you?";

const cases: FinanceCase[] = [
  {
    id: "monthly_budget_under",
    inboundText: "I need to stay under $500/month",
    expectInventoryGuard: true,
    expectScheduleGuard: true
  },
  {
    id: "monthly_budget_no_dollar",
    inboundText: "trying to be around 500 monthly",
    expectInventoryGuard: true,
    expectScheduleGuard: true
  },
  {
    id: "how_much_down",
    inboundText: "how much down would I need?",
    expectInventoryGuard: true,
    expectScheduleGuard: true
  },
  {
    id: "zero_down_phrase",
    inboundText: "I really don't want to put anything down",
    expectInventoryGuard: true,
    expectScheduleGuard: true
  },
  {
    id: "zero_down_short",
    inboundText: "can I do 0 down?",
    expectInventoryGuard: true,
    expectScheduleGuard: true
  },
  {
    id: "term_72",
    inboundText: "run it for 72 months",
    expectInventoryGuard: true,
    expectScheduleGuard: true
  },
  {
    id: "term_84_typo",
    inboundText: "can u run that 84 mo",
    expectInventoryGuard: true,
    expectScheduleGuard: true
  },
  {
    id: "apr_question",
    inboundText: "what APR can I get with great credit?",
    expectInventoryGuard: true,
    expectScheduleGuard: true
  },
  {
    id: "rate_question",
    inboundText: "what rates are you writing right now?",
    expectInventoryGuard: true,
    expectScheduleGuard: true
  },
  {
    id: "specials_question",
    inboundText: "any deals or finance specials on this bike?",
    expectInventoryGuard: true,
    expectScheduleGuard: true
  },
  {
    id: "rebate_question",
    inboundText: "any rebates or incentives currently?",
    expectInventoryGuard: true,
    expectScheduleGuard: true
  },
  {
    id: "payment_direct",
    inboundText: "what would payments be?",
    expectInventoryGuard: true,
    expectScheduleGuard: true
  },
  {
    id: "payment_followup_under_no_month_word_with_context",
    inboundText: "I really need to be under 500",
    expectInventoryGuard: true,
    expectScheduleGuard: true,
    context: { followUpReason: "pricing", dialogState: "pricing_answered" }
  },
  {
    id: "down_with_amount",
    inboundText: "I can put 5k down",
    expectInventoryGuard: true,
    expectScheduleGuard: true
  },
  {
    id: "down_with_amount_words",
    inboundText: "I have 5000 to put down",
    expectInventoryGuard: true,
    expectScheduleGuard: true
  },
  {
    id: "down_and_budget_combo",
    inboundText: "I have $2,500 to put down and want to stay under $500/mo",
    expectInventoryGuard: true,
    expectScheduleGuard: true
  },
  {
    id: "down_and_budget_combo_no_symbols",
    inboundText: "well i have 2500 down and want under 500 a month",
    expectInventoryGuard: true,
    expectScheduleGuard: true
  },
  {
    id: "term_and_zero_down_combo",
    inboundText: "can you run it for 72 months with 0 down",
    expectInventoryGuard: true,
    expectScheduleGuard: true
  },
  {
    id: "money_down_question",
    inboundText: "do i need any money down?",
    expectInventoryGuard: true,
    expectScheduleGuard: true
  },
  {
    id: "finance_docs_question",
    inboundText: "before i come in what do i need to bring for financing?",
    expectInventoryGuard: true,
    expectScheduleGuard: true
  },
  {
    id: "credit_app_question",
    inboundText: "should I fill out the credit app first?",
    expectInventoryGuard: true,
    expectScheduleGuard: true
  },
  {
    id: "non_finance_inventory_question",
    inboundText: "do you have any black road glides?",
    expectInventoryGuard: false,
    expectScheduleGuard: false,
    hints: { turnFinanceIntent: false, turnAvailabilityIntent: true }
  },
  {
    id: "non_finance_photo_request",
    inboundText: "can you send photos?",
    expectInventoryGuard: false,
    expectScheduleGuard: false,
    hints: { turnFinanceIntent: false }
  },
  {
    id: "non_finance_engine_spec",
    inboundText: "what size motor is in this one?",
    expectInventoryGuard: false,
    expectScheduleGuard: false,
    hints: { turnFinanceIntent: false }
  },
  {
    id: "non_finance_trim_inventory",
    inboundText: "do you have any black ones with black trim?",
    expectInventoryGuard: false,
    expectScheduleGuard: false,
    hints: { turnFinanceIntent: false, turnAvailabilityIntent: true }
  },
  {
    id: "non_finance_schedule_question",
    inboundText: "can I come in Wednesday at 1?",
    expectInventoryGuard: false,
    expectScheduleGuard: false,
    hints: { turnFinanceIntent: false, turnSchedulingIntent: true }
  }
];

type ResultSummary = {
  passed: number;
  failed: number;
};

function evaluateCase(c: FinanceCase): { ok: boolean; detail: string } {
  const baseInput = {
    inboundText: c.inboundText,
    followUpMode: "active",
    followUpReason: c.context?.followUpReason ?? "pricing",
    dialogState: c.context?.dialogState ?? "pricing_answered",
    classificationBucket: "inventory_interest",
    classificationCta: "ask_payment",
    turnFinanceIntent:
      c.hints?.turnFinanceIntent ?? (c.expectInventoryGuard || c.expectScheduleGuard),
    turnAvailabilityIntent: c.hints?.turnAvailabilityIntent ?? false,
    turnSchedulingIntent: c.hints?.turnSchedulingIntent ?? false,
    financeContextIntent:
      c.hints?.financeContextIntent ?? (c.expectInventoryGuard || c.expectScheduleGuard),
    shortAckIntent: c.hints?.shortAckIntent ?? false
  };

  const inventoryResult = applyDraftStateInvariants({
    ...baseInput,
    draftText: inventoryPromptDraft
  });
  const scheduleResult = applyDraftStateInvariants({
    ...baseInput,
    draftText: schedulePromptDraft
  });

  const inventoryGuarded =
    inventoryResult.allow === false &&
    inventoryResult.reason === "finance_priority_inventory_prompt_guard";
  const scheduleGuarded =
    scheduleResult.allow === false &&
    scheduleResult.reason === "finance_priority_schedule_prompt_guard";

  const invOk = c.expectInventoryGuard ? inventoryGuarded : inventoryResult.allow === true;
  const schedOk = c.expectScheduleGuard ? scheduleGuarded : scheduleResult.allow === true;
  const ok = invOk && schedOk;

  const detail = JSON.stringify({
    inbound: c.inboundText,
    expected: {
      inventoryGuard: c.expectInventoryGuard,
      scheduleGuard: c.expectScheduleGuard
    },
    actual: {
      inventory: {
        allow: inventoryResult.allow,
        reason: inventoryResult.reason ?? "-"
      },
      schedule: {
        allow: scheduleResult.allow,
        reason: scheduleResult.reason ?? "-"
      }
    }
  });

  return { ok, detail };
}

const summary: ResultSummary = { passed: 0, failed: 0 };
for (const c of cases) {
  const { ok, detail } = evaluateCase(c);
  if (ok) {
    summary.passed += 1;
    console.log(`PASS ${c.id} ${detail}`);
  } else {
    summary.failed += 1;
    console.log(`FAIL ${c.id} ${detail}`);
  }
}

if (summary.failed > 0) {
  console.error(
    `\nFinance language fuzz eval failed: ${summary.failed}/${cases.length} failed`
  );
  process.exit(1);
}

console.log(`\nAll ${cases.length} finance language fuzz checks passed.`);
