import "dotenv/config";
import { parsePurchaseDeliveryLogisticsWithLLM } from "../services/api/src/domain/llmDraft.ts";

type ExpectedIntent = "delivery_progress" | "delivery_timing" | "docs_status" | "none";

type Fixture = {
  id: string;
  text: string;
  history?: { direction: "in" | "out"; body: string }[];
  expectedIntent: ExpectedIntent;
  expectedTimingContains?: string;
};

const fixtures: Fixture[] = [
  {
    id: "loan_finalized_progress",
    text: "Loans finalized just need to send them insurance paper work",
    expectedIntent: "delivery_progress"
  },
  {
    id: "certified_check_progress",
    text: "Certified chek has been Maide for the motorcycle",
    expectedIntent: "delivery_progress"
  },
  {
    id: "insurance_status_docs",
    text: "Insured already too",
    expectedIntent: "docs_status"
  },
  {
    id: "media_proof_legit_docs",
    text: "Like I said. I'm 💯 legit",
    history: [
      { direction: "out", body: "Thanks, got it — I received the image. I’ll review it and let you know if anything else is needed." },
      { direction: "in", body: "Certified check has been made for the motorcycle" }
    ],
    expectedIntent: "docs_status"
  },
  {
    id: "start_driving_deadline",
    text: "Let me know be cause I star driving on Friday morning. Please",
    expectedIntent: "delivery_progress",
    expectedTimingContains: "friday"
  },
  {
    id: "on_way_arrival",
    text: "On my way doing my best to be there by 530",
    expectedIntent: "delivery_progress",
    expectedTimingContains: "530"
  },
  {
    id: "pickup_window_active_delivery",
    text: "1-2 o'clock ish",
    history: [
      { direction: "out", body: "Thanks for sending that over John, I will get rolling on everything. What time works for you today?" },
      { direction: "in", body: "Early afternoon ish, wife just has to be home to get kids off the bus" },
      { direction: "out", body: "Just let me know when you have a better idea of time so I can make sure I have everything lined up before you get here" }
    ],
    expectedIntent: "delivery_timing",
    expectedTimingContains: "1"
  },
  {
    id: "loose_pickup_window_active_delivery",
    text: "Early afternoon ish, wife just has to be home to get kids off the bus",
    history: [
      { direction: "out", body: "Thanks for sending that over John, I will get rolling on everything. What time works for you today?" },
      { direction: "in", body: "Loans finalized just need to send them insurance paperwork" }
    ],
    expectedIntent: "delivery_timing",
    expectedTimingContains: "early afternoon"
  },
  {
    id: "purchase_delivery_not_trade_after_trade_origin",
    text: "1-2 o'clock ish",
    history: [
      { direction: "in", body: "trade-in appraisal request" },
      { direction: "out", body: "Yes — the 2026 Street Glide is available. Let me know what day and time works for you to stop in!" },
      { direction: "in", body: "Loans finalized just need to send them insurance paperwork" },
      { direction: "out", body: "What time works for you today?" }
    ],
    expectedIntent: "delivery_timing",
    expectedTimingContains: "1"
  },
  {
    id: "pickup_time_after_delivery_lineup_context",
    text: "1-2 o'clock ish",
    history: [
      { direction: "out", body: "Thanks for sending that over John, I will get rolling on everything. What time works for you today?" },
      { direction: "in", body: "Early afternoon ish, wife just has to be home to get kids off the bus" },
      { direction: "out", body: "Just let me know when you have a better idea of time so I can make sure I have everything lined up before you get here" }
    ],
    expectedIntent: "delivery_timing",
    expectedTimingContains: "1"
  },
  {
    id: "trade_appraisal_not_delivery",
    text: "Tuesday between 9:30 and 10:00 works for bringing my trade in",
    history: [
      { direction: "out", body: "When would be a good day and time to stop by with your Road King? We can do a professional evaluation at that time." }
    ],
    expectedIntent: "none"
  },
  {
    id: "test_ride_not_delivery",
    text: "Tomorrow around 11/12 would work best for me",
    history: [
      { direction: "out", body: "We can set up a test ride on the Breakout. What day and time works?" }
    ],
    expectedIntent: "none"
  }
];

function normalize(value: unknown): string {
  return String(value ?? "").toLowerCase();
}

async function main() {
  const apiKey = process.env.OPENAI_API_KEY ?? "";
  if (!apiKey || apiKey.trim() === "..." || apiKey.trim().length < 20) {
    console.error("OPENAI_API_KEY is missing or looks like a placeholder. Set a real key and re-run.");
    process.exit(1);
  }
  if (process.env.LLM_ENABLED !== "1") {
    console.error("LLM_ENABLED=1 is required for this eval.");
    process.exit(1);
  }

  let intentMatches = 0;
  let timingMatches = 0;
  let timingAsserted = 0;
  let nullParses = 0;
  const mismatches: string[] = [];

  for (const fixture of fixtures) {
    const parsed = await parsePurchaseDeliveryLogisticsWithLLM({
      text: fixture.text,
      history: fixture.history
    });
    if (!parsed) {
      nullParses += 1;
      mismatches.push(`- [${fixture.id}] parser returned null | expected intent=${fixture.expectedIntent}`);
      continue;
    }

    const intentOk = parsed.intent === fixture.expectedIntent;
    if (intentOk) intentMatches += 1;

    let timingOk = true;
    if (fixture.expectedTimingContains) {
      timingAsserted += 1;
      timingOk = normalize(parsed.timingText).includes(normalize(fixture.expectedTimingContains));
      if (timingOk) timingMatches += 1;
    }

    if (!intentOk || !timingOk) {
      mismatches.push(
        [
          `- [${fixture.id}] text=${JSON.stringify(fixture.text)}`,
          `expected intent=${fixture.expectedIntent}`,
          fixture.expectedTimingContains ? `expected timing contains=${fixture.expectedTimingContains}` : null,
          `got intent=${parsed.intent}`,
          `got timing=${JSON.stringify(parsed.timingText ?? null)}`,
          `confidence=${parsed.confidence ?? null}`
        ]
          .filter(Boolean)
          .join(" | ")
      );
    }
  }

  const pct = (n: number, total: number) => (total ? Math.round((n / total) * 1000) / 10 : 0);
  console.log(`Intent accuracy: ${intentMatches}/${fixtures.length} (${pct(intentMatches, fixtures.length)}%)`);
  console.log(`Timing field match: ${timingMatches}/${timingAsserted} (${pct(timingMatches, timingAsserted)}%)`);
  console.log(`Null parses: ${nullParses}/${fixtures.length}`);
  console.log("");

  if (mismatches.length) {
    console.log("Mismatches:");
    for (const line of mismatches) console.log(line);
    process.exit(1);
  }

  console.log("All checks passed.");
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
