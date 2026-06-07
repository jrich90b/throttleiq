import "dotenv/config";
import { parsePurchaseDeliveryLogisticsWithLLM } from "../services/api/src/domain/llmDraft.ts";

type ExpectedIntent =
  | "delivery_progress"
  | "delivery_timing"
  | "docs_status"
  | "post_sale_item_pickup"
  | "none";

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
    id: "active_delivery_schedule_status_check",
    text: "hey, I'm just checking to see if everything going according schedule",
    history: [
      {
        direction: "out",
        body: "lol all good. Sry took me a min to get back. Bars just came in and the goat-light. Only thing we are waiting for is the Corbin stuff from the looks of it, but that won’t hold anything up"
      },
      { direction: "out", body: "actually the seats showed up today" }
    ],
    expectedIntent: "delivery_progress",
    expectedTimingContains: "schedule"
  },
  {
    id: "delivery_ready_before_juneteenth_update",
    text: "I just spoke with Hollis. I asked him would the bike be ready before Juneteenth. He said that's the plan and I said I'm definitely good with that. Please let him know he got time.",
    history: [
      {
        direction: "out",
        body: "Bars just came in and the goat-light. Only thing we are waiting for is the Corbin stuff from the looks of it, but that won’t hold anything up"
      },
      { direction: "out", body: "actually the seats showed up today" }
    ],
    expectedIntent: "delivery_progress",
    expectedTimingContains: "juneteenth"
  },
  {
    id: "vin_request_active_purchase_delivery",
    text: "Need the Vin #",
    history: [
      { direction: "in", body: "Need the Vin #, Ill get the insurance going" },
      { direction: "out", body: "Lou, here is that quote with today’s date. Just waiting for the parts guys to get a few options for me" }
    ],
    expectedIntent: "delivery_progress"
  },
  {
    id: "lift_info_request_active_purchase_delivery",
    text: "And need the lift info too",
    history: [
      { direction: "in", body: "Need the Vin #" },
      { direction: "out", body: "I’ll get the VIN for you and send it over." }
    ],
    expectedIntent: "delivery_progress"
  },
  {
    id: "dealer_trade_status_request_active_purchase_delivery",
    text: "Did you get the trade done",
    history: [
      { direction: "in", body: "doing a dealer trade on a 2026 FLHC in Vivid Black" },
      { direction: "out", body: "I’ll get rolling on everything and follow up." }
    ],
    expectedIntent: "delivery_progress"
  },
  {
    id: "accessory_selection_active_purchase_delivery",
    text: "That's the ones, chrome, black K tip",
    history: [
      { direction: "out", body: "Ok this is the Khrome Werks muffler. For the 2026 Heritage it doesn’t have the black tips" },
      { direction: "out", body: "https://www.tabperformance.com/hd-cruiser-2-1/" }
    ],
    expectedIntent: "delivery_progress"
  },
  {
    id: "call_request_active_purchase_delivery",
    text: "Call me Joe",
    history: [
      { direction: "out", body: "I’ll follow back up when I get back with the warranty and exhaust details." }
    ],
    expectedIntent: "delivery_progress"
  },
  {
    id: "on_way_arrival",
    text: "On my way doing my best to be there by 530",
    expectedIntent: "delivery_timing",
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
    id: "spelled_arrival_time_after_pickup_context",
    text: "be there at nine am",
    history: [
      { direction: "in", body: "Let me know when you need me to come and do the paperwork" },
      { direction: "out", body: "ok I am around tomorrow or Friday just give me a heads up" }
    ],
    expectedIntent: "delivery_timing",
    expectedTimingContains: "9"
  },
  {
    id: "post_sale_stock_exhaust_pickup",
    text: "Working on having someone come by for the stock exhaust I just couldn't fit everything yesterday",
    history: [
      { direction: "out", body: "Hi John — this is Joe at American Harley-Davidson. Thanks again for coming to see us for your Street Glide. If you need anything, just let me know." },
      { direction: "in", body: "Thank you very much, was an amazing experience, and the ride home was nothing but smiles from ear to ear" }
    ],
    expectedIntent: "post_sale_item_pickup",
    expectedTimingContains: "stock"
  },
  {
    id: "post_sale_key_and_backseat_dropoff",
    text: "Absolutely! Btw.  I'm hoping you guys still have my garage key on my sporster keyring I left with y'all?\n\nAlso, I'm stopping by after work today dropping off the backseat for sporster.  Thanks",
    history: [
      {
        direction: "out",
        body: "Hi Eric — this is Stone at American Harley-Davidson. Thanks again for coming to see us for your bike. If you need anything, just let me know."
      }
    ],
    expectedIntent: "post_sale_item_pickup",
    expectedTimingContains: "after work"
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
