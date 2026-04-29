import { evaluateTurnToneQuality } from "./lib/toneQuality.ts";

type Fixture = {
  id: string;
  inboundText: string;
  outboundText: string;
  expect: {
    minScore?: number;
    maxScore?: number;
    mustIncludeIssues?: string[];
    mustNotIncludeIssues?: string[];
  };
};

const FIXTURES: Fixture[] = [
  {
    id: "pricing_answered_directly",
    inboundText: "What would monthly payments be on this bike?",
    outboundText:
      "Ballpark, on about $24,999, you’re around $550–$570/mo at 60 months before taxes and fees. What monthly payment are you trying to stay around?",
    expect: { minScore: 85, mustNotIncludeIssues: ["intent_mismatch", "question_not_answered_first"] }
  },
  {
    id: "availability_hijacked_by_pricing",
    inboundText: "Do you have any black street glides in stock?",
    outboundText: "The price we have listed for T19-26 is $24,999. Final price can change with tax and fees.",
    expect: { maxScore: 65, mustIncludeIssues: ["intent_mismatch", "question_not_answered_first"] }
  },
  {
    id: "status_update_with_clean_ack",
    inboundText: "I received all my paperwork and I’m headed to the DMV this afternoon.",
    outboundText: "Sounds good. Keep me posted, and I’m here if you need anything.",
    expect: { minScore: 85, mustNotIncludeIssues: ["pushy_cta_on_ack"] }
  },
  {
    id: "status_update_pushy_schedule",
    inboundText: "I got everything filed at the DMV, thanks.",
    outboundText: "Great. Stop by tomorrow and let’s lock in a time to review options.",
    expect: { maxScore: 75, mustIncludeIssues: ["pushy_cta_on_ack"] }
  },
  {
    id: "duplicate_self_identification",
    inboundText: "Do you have any deals right now?",
    outboundText:
      "Hi Aaron — This is Alexandra at American Harley-Davidson. This is Giovanni at American Harley-Davidson. We can review current specials.",
    expect: { maxScore: 75, mustIncludeIssues: ["role_inconsistency"] }
  },
  {
    id: "generic_reask_when_model_given",
    inboundText: "I’m looking at a 2017 orange Street Glide and can come in tomorrow.",
    outboundText: "Thanks for the update. Which model are you interested in?",
    expect: { maxScore: 75, mustIncludeIssues: ["generic_model_reask"] }
  },
  {
    id: "night_rod_mid_controls_fact_conflict",
    inboundText: "Night rod with the mid controls",
    outboundText:
      "Understood. I can check on Night Rods with mid controls and see what options we have. Are you looking for a new or pre-owned Night Rod?",
    expect: { maxScore: 75, mustIncludeIssues: ["known_fact_conflict"] }
  },
  {
    id: "consignment_request_hijacked_by_scheduling",
    inboundText: "Can you sell a bike for me for a commission?",
    outboundText: "I can set up a time to stop in. I have Tuesday at 9:30 AM or 11:30 AM — do any of these times work?",
    expect: { maxScore: 75, mustIncludeIssues: ["intent_mismatch", "question_not_answered_first"] }
  },
  {
    id: "specific_day_reasked_generically",
    inboundText: "Thank you for that. Can you let me know about the check and if Saturday is okay?",
    outboundText: "Absolutely — what day and time works for you?",
    expect: { maxScore: 85, mustIncludeIssues: ["generic_day_reask"] }
  },
  {
    id: "schedule_correction_answered_wrong_topic",
    inboundText:
      "Happy Easter! I see that the location is closed on Mondays. I think I made a mistake on telling you Monday. Wednesday at 3:45pm would work!",
    outboundText: "We’re located at 1149 Erie Ave., North Tonawanda, NY 14120. Do you want pricing details or a quick model comparison?",
    expect: { maxScore: 75, mustIncludeIssues: ["intent_mismatch"] }
  },
  {
    id: "service_records_overcommitted_availability_watch",
    inboundText:
      "I wanted to know about any service records, including the age of the battery and tires. I'll be back in Westfield, NY in early May. So if this bike is still available at that time, I would love to drop by.",
    outboundText:
      "Thanks for the details — I’ll have the team check service records (battery/tires) and follow up. I’ll also keep an eye on availability for early May.",
    expect: { maxScore: 85, mustIncludeIssues: ["overcommitted_availability_watch"] }
  },
  {
    id: "warranty_question_answered",
    inboundText: "What warranty comes with a new Harley?",
    outboundText:
      "New Harley-Davidson motorcycles include a 2-year factory limited warranty, and we can review optional extended coverage plans.",
    expect: { minScore: 85, mustNotIncludeIssues: ["intent_mismatch"] }
  },
  {
    id: "scheduling_question_answered",
    inboundText: "Can I come in Saturday at 9:30?",
    outboundText: "Saturday at 9:30 can work. Want me to lock that in now?",
    expect: { minScore: 85, mustNotIncludeIssues: ["intent_mismatch", "question_not_answered_first"] }
  }
];

function hasIssue(issues: string[], issue: string): boolean {
  return issues.includes(issue);
}

function main() {
  let passCount = 0;
  const rows = FIXTURES.map(f => {
    const actual = evaluateTurnToneQuality({
      inboundText: f.inboundText,
      outboundText: f.outboundText
    });
    const issueCodes = actual.issues.map(x => x.code);
    let pass = true;

    if (Number.isFinite(f.expect.minScore) && actual.score < Number(f.expect.minScore)) pass = false;
    if (Number.isFinite(f.expect.maxScore) && actual.score > Number(f.expect.maxScore)) pass = false;

    for (const issue of f.expect.mustIncludeIssues ?? []) {
      if (!hasIssue(issueCodes, issue)) pass = false;
    }
    for (const issue of f.expect.mustNotIncludeIssues ?? []) {
      if (hasIssue(issueCodes, issue)) pass = false;
    }

    if (pass) passCount += 1;
    return {
      id: f.id,
      pass,
      score: actual.score,
      issues: issueCodes
    };
  });

  for (const row of rows) {
    console.log(`${row.pass ? "PASS" : "FAIL"} ${row.id} score=${row.score} issues=${row.issues.join("|") || "-"}`);
  }

  const failing = rows.length - passCount;
  if (failing > 0) {
    console.error(`\n${failing} tone-quality fixture checks failed.`);
    process.exit(1);
  }
  console.log(`\nAll ${rows.length} tone-quality fixture checks passed.`);
}

main();
