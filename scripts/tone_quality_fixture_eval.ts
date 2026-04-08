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

