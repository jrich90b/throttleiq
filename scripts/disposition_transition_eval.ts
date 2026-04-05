import {
  canApplyDispositionCloseout,
  isDispositionParserAccepted
} from "../services/api/src/domain/transitionSafety.ts";

type Case = {
  id: string;
  expected: boolean;
  run: () => boolean;
};

const dmvText = "Thanks Gio! I will let you know as soon as I receive it and get to the DMV.";
const steppingBackText = "I think I'm going to keep my bike and hold off for now.";
const financeInfoText = "I have $2,500 to put down and want to stay under $500/month.";

const parsedAccepted = {
  explicitDisposition: true,
  disposition: "stepping_back",
  confidence: 0.92
};

const parsedLow = {
  explicitDisposition: true,
  disposition: "stepping_back",
  confidence: 0.51
};

const cases: Case[] = [
  {
    id: "dmv_progress_blocks_closeout_even_with_decision",
    expected: false,
    run: () =>
      canApplyDispositionCloseout({
        conv: { followUp: { mode: "post_sale" } },
        text: dmvText,
        parsedAccepted: true,
        hasDecision: true
      })
  },
  {
    id: "parser_accepted_stepping_back_allows_closeout",
    expected: true,
    run: () =>
      canApplyDispositionCloseout({
        conv: { followUp: { mode: "active" } },
        text: steppingBackText,
        parsedAccepted: isDispositionParserAccepted(parsedAccepted),
        hasDecision: true
      })
  },
  {
    id: "low_confidence_parser_no_regex_fallback_blocks_closeout",
    expected: false,
    run: () =>
      canApplyDispositionCloseout({
        conv: { followUp: { mode: "active" } },
        text: "I'll let you know.",
        parsedAccepted: isDispositionParserAccepted(parsedLow),
        hasDecision: true
      })
  },
  {
    id: "structured_finance_info_blocks_closeout_even_if_parser_accepts_disposition",
    expected: false,
    run: () =>
      canApplyDispositionCloseout({
        conv: { followUp: { mode: "active" } },
        text: financeInfoText,
        parsedAccepted: isDispositionParserAccepted(parsedAccepted),
        hasDecision: true
      })
  }
];

let passed = 0;
for (const c of cases) {
  const actual = c.run();
  const ok = actual === c.expected;
  if (ok) passed += 1;
  console.log(`${ok ? "PASS" : "FAIL"} ${c.id} expected=${c.expected} actual=${actual}`);
}

if (passed !== cases.length) {
  console.error(`\n${cases.length - passed} failures out of ${cases.length} cases`);
  process.exit(1);
}

console.log(`\nAll ${cases.length} disposition transition checks passed.`);
