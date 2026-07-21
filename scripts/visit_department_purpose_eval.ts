/**
 * Visit-department purpose parser eval (Justin Alley, 2026-07-21).
 *
 * Coverage for parseVisitDepartmentPurposeWithLLM — the typed parser that reads whether a
 * customer's visit-time turn is about bringing THEIR bike in for service work, or about
 * coming in to see/buy a SALE bike. The replay fixture is the exact production miss: a
 * sales thread about a used 2017 Breakout where the DEALER's own messages described the
 * sale bike's maintenance ("on the lift doing a 5,000 mile service"), and the customer's
 * "Yea it'll probably be between 5 and 6 p then" (visit to see the bike + talk finance)
 * was routed to a SERVICE scheduling handoff.
 *
 * LLM-backed. Run: LLM_ENABLED=1 npx tsx scripts/visit_department_purpose_eval.ts
 * (skips cleanly when the LLM is disabled — the decision-table eval still pins routing).
 */
import assert from "node:assert/strict";
import { parseVisitDepartmentPurposeWithLLM } from "../services/api/src/domain/llmDraft.ts";

const useLLM = process.env.LLM_ENABLED === "1" && !!process.env.OPENAI_API_KEY;
if (!useLLM) {
  console.log("SKIP visit-department purpose parser eval (LLM disabled)");
  process.exit(0);
}

type Case = {
  id: string;
  expect: "service_visit" | "sales_visit" | "unknown";
  minConfidence?: number;
  args: Parameters<typeof parseVisitDepartmentPurposeWithLLM>[0];
};

// The production thread, verbatim shape (anonymized name/contact irrelevant to the parse).
const justinHistory: { direction: "in" | "out"; body: string }[] = [
  {
    direction: "out",
    body:
      "ok, so it was a two owner bike. The 1,000 mile service was done, we actually have it on the lift doing a 5,000 mile service and a brake fluid flush right now. Rear tire has been replaced. We did a stage 1 with exhaust, tune and intake at about 2,000 miles. ill send a couple more photos"
  },
  {
    direction: "in",
    body:
      "Are you going to be there later today? I'll be in that area looking at a car for my son , so maybe 2 birds one stone type ordeal and talk maybe with finance"
  },
  {
    direction: "out",
    body: "Hey, I am off today, but you can always stop in and see Gio or Scott. Let me know what time you are thinking and I can give them a heads up."
  },
  { direction: "in", body: "Ok .. it would have to be after 5 cuz I work till 430. And probably with traffic and such. Idk what time you close there" },
  { direction: "out", body: "Gotcha. We will be open 'til 6." },
  { direction: "in", body: "👍" }
];

const cases: Case[] = [
  {
    id: "justin_alley_visit_time_is_sales",
    expect: "sales_visit",
    minConfidence: 0.6,
    args: {
      text: "Yea it'll probably be between 5 and 6 p then",
      history: justinHistory,
      lead: {
        vehicle: { year: "2017", make: "Harley-Davidson", model: "Breakout", condition: "used" }
      } as any
    }
  },
  {
    id: "oil_change_is_service",
    expect: "service_visit",
    minConfidence: 0.6,
    args: { text: "Can I bring my bike in for an oil change Thursday morning?" }
  },
  {
    id: "mechanical_problem_is_service",
    expect: "service_visit",
    minConfidence: 0.6,
    args: { text: "My clutch is slipping pretty bad, when can you guys get me in?" }
  },
  {
    id: "time_answer_in_service_booking_is_service",
    expect: "service_visit",
    minConfidence: 0.6,
    args: {
      text: "probably around 2pm",
      history: [
        { direction: "in", body: "I need the 10k service done on my Road Glide" },
        { direction: "out", body: "We've received your service request and will have the service department reach out. What day works?" }
      ]
    }
  },
  {
    id: "come_see_sale_bike_is_sales",
    expect: "sales_visit",
    minConfidence: 0.6,
    args: {
      text: "What time do you close today? Wanted to swing by and look at the Fat Bob",
      lead: { vehicle: { year: "2023", make: "Harley-Davidson", model: "Fat Bob 114", condition: "used" } } as any
    }
  },
  {
    id: "sale_bike_history_question_visit_is_sales",
    expect: "sales_visit",
    minConfidence: 0.6,
    args: {
      text: "Saturday works. Can you also check when the tires were last changed on it?",
      history: [{ direction: "out", body: "Want to set up a time to come see it?" }],
      lead: { vehicle: { year: "2019", make: "Harley-Davidson", model: "Street Glide", condition: "used" } } as any
    }
  }
];

let pass = 0;
const failures: string[] = [];
for (const c of cases) {
  const parsed = await parseVisitDepartmentPurposeWithLLM(c.args);
  const purpose = parsed?.purpose ?? "(null)";
  const confidence = parsed?.confidence ?? 0;
  const ok = purpose === c.expect && (c.minConfidence == null || confidence >= c.minConfidence);
  if (ok) {
    pass++;
  } else {
    failures.push(`${c.id}: got ${purpose} (conf ${confidence}), expected ${c.expect}`);
  }
}

if (failures.length) {
  console.error(failures.join("\n"));
}
assert.equal(failures.length, 0, `visit-department purpose parser misses:\n${failures.join("\n")}`);
console.log(`PASS visit-department purpose parser eval (${pass}/${cases.length} cases)`);
