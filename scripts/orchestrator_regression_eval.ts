import type { InboundMessageEvent } from "../services/api/src/domain/types.ts";

process.env.OPENAI_API_KEY ||= "test";

const { orchestrateInbound } = await import("../services/api/src/domain/orchestrator.ts");

type Case = {
  id: string;
  event: InboundMessageEvent;
  ctx: Parameters<typeof orchestrateInbound>[2];
  expectedIncludes: string[];
  expectedExcludes?: string[];
};

const now = new Date().toISOString();

const cases: Case[] = [
  {
    id: "initial_adf_price_plus_trade_mentions_lead_bike_and_trade",
    event: {
      channel: "sms",
      provider: "sendgrid_adf",
      from: "+17163308822",
      to: "+17166927200",
      body: "What the asking price i have a 2013 street glide to trade in what the trade in value would be?",
      providerMessageId: "orchestrator-regression-1",
      receivedAt: now
    },
    ctx: {
      leadSource: "Room58 - Request details",
      pricingIntentHint: true,
      financeIntentHint: true,
      lead: {
        firstName: "Joseph",
        source: "Room58 - Request details",
        vehicle: {
          year: "2025",
          make: "Harley-Davidson",
          model: "Road Glide",
          color: "T4-25 Vivid Black",
          stockId: "T4-25",
          vin: "1HD1KH712SB601122",
          condition: "new"
        }
      } as any
    },
    expectedIncludes: ["2025 Road Glide", "trade"],
    expectedExcludes: ["How many miles are on it?", "Which one would you like pricing on?"]
  }
];

let passed = 0;
const failures: Array<{ id: string; got: string; reason: string }> = [];

for (const c of cases) {
  const result = await orchestrateInbound(c.event, [], c.ctx);
  const got = String(result.draft ?? "");
  const lower = got.toLowerCase();
  const missing = c.expectedIncludes.filter(fragment => !lower.includes(fragment.toLowerCase()));
  const presentExcluded = (c.expectedExcludes ?? []).filter(fragment => lower.includes(fragment.toLowerCase()));
  if (!missing.length && !presentExcluded.length) {
    passed += 1;
    console.log(`PASS ${c.id} draft=${JSON.stringify(got)}`);
  } else {
    failures.push({
      id: c.id,
      got,
      reason: [
        missing.length ? `missing ${missing.map(v => JSON.stringify(v)).join(", ")}` : "",
        presentExcluded.length ? `included blocked ${presentExcluded.map(v => JSON.stringify(v)).join(", ")}` : ""
      ]
        .filter(Boolean)
        .join("; ")
    });
    console.log(`FAIL ${c.id} ${failures[failures.length - 1].reason} draft=${JSON.stringify(got)}`);
  }
}

if (failures.length) {
  console.error(`\n${failures.length} failures out of ${cases.length} orchestrator regression checks`);
  process.exit(1);
}

console.log(`\nAll ${passed} orchestrator regression checks passed.`);
