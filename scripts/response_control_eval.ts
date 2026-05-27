import {
  isResponseControlParserAccepted,
  isResponseControlParserConfidentDecision,
  isResponseControlNoResponseAccepted
} from "../services/api/src/domain/transitionSafety.ts";

type Case = {
  id: string;
  expected: boolean;
  run: () => boolean;
};

const strongOptOut = {
  intent: "opt_out",
  explicitRequest: true,
  confidence: 0.93
};

const strongWrongNumber = {
  intent: "wrong_number",
  explicitRequest: true,
  confidence: 0.98
};

const strongDataQualityComplaint = {
  intent: "data_quality_complaint",
  explicitRequest: true,
  confidence: 0.96
};

const weakSchedule = {
  intent: "schedule_request",
  explicitRequest: true,
  confidence: 0.41
};

const noneIntent = {
  intent: "none",
  explicitRequest: false,
  confidence: 0.99
};

const noResponseIntent = {
  intent: "no_response",
  explicitRequest: false,
  confidence: 0.93
};

const cases: Case[] = [
  {
    id: "accepts_strong_opt_out_parse",
    expected: true,
    run: () => isResponseControlParserAccepted(strongOptOut)
  },
  {
    id: "accepts_strong_wrong_number_parse",
    expected: true,
    run: () => isResponseControlParserAccepted(strongWrongNumber)
  },
  {
    id: "accepts_strong_data_quality_complaint_parse",
    expected: true,
    run: () => isResponseControlParserAccepted(strongDataQualityComplaint)
  },
  {
    id: "rejects_low_confidence_schedule_parse",
    expected: false,
    run: () => isResponseControlParserAccepted(weakSchedule)
  },
  {
    id: "rejects_none_intent_even_high_confidence",
    expected: false,
    run: () => isResponseControlParserAccepted(noneIntent)
  },
  {
    id: "none_intent_can_still_be_authoritative",
    expected: true,
    run: () => isResponseControlParserConfidentDecision(noneIntent)
  },
  {
    id: "low_confidence_parse_is_not_authoritative",
    expected: false,
    run: () => isResponseControlParserConfidentDecision(weakSchedule)
  },
  {
    id: "no_response_intent_is_authoritative_without_explicit_request",
    expected: true,
    run: () => isResponseControlNoResponseAccepted(noResponseIntent)
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

console.log(`\nAll ${cases.length} response-control checks passed.`);
