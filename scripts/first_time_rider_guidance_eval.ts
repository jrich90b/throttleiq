import { parseFirstTimeRiderGuidanceWithLLM } from "../services/api/src/domain/llmDraft.js";

type Expected = {
  intent: string;
  explicitRequest: boolean;
  hasEndorsement?: boolean | null;
  asksTestRide?: boolean;
  asksBeginnerBike?: boolean;
  asksRiderCourse?: boolean;
  asksClassLogistics?: boolean;
  /**
   * WHICH class question this is. Asserted as an exact label ON PURPOSE, against the usual rule of
   * pinning the decision rather than the word: here the label IS the decision — only "equipment"
   * unlocks the dealer's what-is-provided answer, and every other value keeps the hand-off. Measured
   * over 5 runs before it was written down (see the case comments).
   */
  classLogisticsTopic?: string | null;
};

type Case = {
  id: string;
  text: string;
  expected: Expected;
};

const cases: Case[] = [
  {
    // THE REAL MESSAGE. Ulises HernandezPerez +17167857284, 2026-08-11 16:08Z, verbatim — the
    // apology and the "question," hedge are how a polite enrolled student actually writes. Joe typed
    // the answer himself 8 minutes later and reported: "Should be able to answer this. Motorcycles
    // are provided. They are Harley-Davidson X350 RA's."
    id: "enrolled_asks_if_bikes_provided",
    text: "Hi, I'm so sorry to bother, question, are the motorcycle provided or do we need to bring our own? Thanks.",
    expected: {
      intent: "enrolled_class_logistics",
      explicitRequest: true,
      asksClassLogistics: true,
      classLogisticsTopic: "equipment"
    }
  },
  {
    // The other side of the split, and the one that matters most: a WHEN question must NOT come back
    // as equipment, or a student asking about their start time is told what bikes are provided.
    id: "enrolled_asks_when_to_arrive",
    text: "What time should I show up on Saturday?",
    expected: {
      intent: "enrolled_class_logistics",
      explicitRequest: true,
      asksClassLogistics: true,
      classLogisticsTopic: "schedule"
    }
  },
  {
    // Somebody still DECIDING is not an enrolled student, and carries no class topic at all — the
    // sign-up branch (price + link) still owns them.
    id: "signup_price_question_is_not_class_logistics",
    text: "How much is the riding academy course?",
    expected: { intent: "rider_course_info", explicitRequest: true, asksRiderCourse: true }
  },
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
    id: "course_motorcycle_license",
    text: "Yes, I'm looking for a course motorcycle so I can get my license.",
    expected: {
      intent: "rider_course_info",
      explicitRequest: true,
      hasEndorsement: false,
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
  if ("asksClassLogistics" in expected && actual.asksClassLogistics !== expected.asksClassLogistics) return false;
  if ("classLogisticsTopic" in expected && actual.classLogisticsTopic !== expected.classLogisticsTopic) return false;
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
