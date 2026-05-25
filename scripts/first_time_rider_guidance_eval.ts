import { parseFirstTimeRiderGuidanceWithLLM } from "../services/api/src/domain/llmDraft.js";

type Expected = {
  intent: string;
  explicitRequest: boolean;
  hasEndorsement?: boolean | null;
  asksTestRide?: boolean;
  asksBeginnerBike?: boolean;
  asksRiderCourse?: boolean;
};

type Case = {
  id: string;
  text: string;
  expected: Expected;
};

const cases: Case[] = [
  {
    id: "first_bike_advice",
    text: "This would be my first bike. What do you recommend?",
    expected: {
      intent: "first_time_rider",
      explicitRequest: true,
      hasEndorsement: null,
      asksBeginnerBike: true
    }
  },
  {
    id: "never_ridden_test_ride",
    text: "I've never ridden before but can I test ride the Nightster?",
    expected: {
      intent: "first_time_rider",
      explicitRequest: true,
      hasEndorsement: null,
      asksTestRide: true
    }
  },
  {
    id: "no_endorsement_test_ride",
    text: "I don't have my motorcycle license yet. Can I ride it?",
    expected: {
      intent: "no_motorcycle_endorsement",
      explicitRequest: true,
      hasEndorsement: false,
      asksTestRide: true
    }
  },
  {
    id: "rider_course",
    text: "Do you know where I can take the rider course?",
    expected: {
      intent: "rider_course_info",
      explicitRequest: true,
      asksRiderCourse: true
    }
  },
  {
    id: "rider_course_price_short_adf",
    text: "Your course and price",
    expected: {
      intent: "rider_course_info",
      explicitRequest: true,
      asksRiderCourse: true
    }
  },
  {
    id: "riding_academy_price",
    text: "How much is the Riding Academy course?",
    expected: {
      intent: "rider_course_info",
      explicitRequest: true,
      asksRiderCourse: true
    }
  },
  {
    id: "returning_rider_not_first_time",
    text: "I used to ride years ago and want to get back into it.",
    expected: {
      intent: "none",
      explicitRequest: false
    }
  }
];

function matchesExpected(actual: Awaited<ReturnType<typeof parseFirstTimeRiderGuidanceWithLLM>>, expected: Expected) {
  if (!actual) return false;
  if (actual.intent !== expected.intent) return false;
  if (actual.explicitRequest !== expected.explicitRequest) return false;
  if ("hasEndorsement" in expected && actual.hasEndorsement !== expected.hasEndorsement) return false;
  if ("asksTestRide" in expected && actual.asksTestRide !== expected.asksTestRide) return false;
  if ("asksBeginnerBike" in expected && actual.asksBeginnerBike !== expected.asksBeginnerBike) return false;
  if ("asksRiderCourse" in expected && actual.asksRiderCourse !== expected.asksRiderCourse) return false;
  return true;
}

let passed = 0;
const failures: string[] = [];

for (const testCase of cases) {
  const actual = await parseFirstTimeRiderGuidanceWithLLM({
    text: testCase.text,
    history: [],
    lead: {}
  });
  if (matchesExpected(actual, testCase.expected)) {
    passed += 1;
    console.log(`PASS ${testCase.id}`);
  } else {
    failures.push(
      `${testCase.id} expected=${JSON.stringify(testCase.expected)} actual=${JSON.stringify(actual)}`
    );
    console.error(`FAIL ${testCase.id}`);
  }
}

console.log(`First-time rider guidance parser accuracy: ${passed}/${cases.length}`);
if (failures.length) {
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log("All checks passed.");
