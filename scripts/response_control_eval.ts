import { isResponseControlParserAccepted } from "../services/api/src/domain/transitionSafety.ts";

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

const weakSchedule = {
  intent: "schedule_request",
  explicitRequest: true,
  confidence: 0.41
};

const noneIntent = {
  intent: "none",
  explicitRequest: true,
  confidence: 0.99
};

const cases: Case[] = [
  {
    id: "accepts_strong_opt_out_parse",
    expected: true,
    run: () => isResponseControlParserAccepted(strongOptOut)
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
