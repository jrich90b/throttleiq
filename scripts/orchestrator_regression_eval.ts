import type { InboundMessageEvent } from "../services/api/src/domain/types.ts";

process.env.OPENAI_API_KEY ||= "test";
process.env.DEALER_PROFILE_PATH ||= "services/api/data/dealer_profile.json";

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
      pricingIntentHint: false,
      financeIntentHint: false,
      agentNameOverride: "our team",
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
    expectedIncludes: ["have our team check", "2025 Road Glide", "trade"],
    expectedExcludes: ["How many miles are on it?", "Which one would you like pricing on?", "This is our team"]
  },
  {
    id: "stock_number_interest_schedules_inventory_visit",
    event: {
      channel: "sms",
      provider: "twilio",
      from: "+17168619251",
      to: "+17166927200",
      body: "Very interested in thw T10-26 street glide !!",
      providerMessageId: "orchestrator-regression-2",
      receivedAt: now
    },
    ctx: {
      lead: {
        firstName: "Mike",
        vehicle: {
          year: "2016",
          make: "Harley-Davidson",
          model: "Street Glide",
          condition: "used"
        }
      } as any
    },
    expectedIncludes: ["2026 Street Glide", "available", "What day and time works best"],
    expectedExcludes: ["2016 Street Glide", "appraisal"]
  },
  {
    id: "initial_adf_sale_price_routes_pricing_handoff_not_payments",
    event: {
      channel: "sms",
      provider: "sendgrid_adf",
      from: "+17166059249",
      to: "+17166927200",
      body: "What is the sale price",
      providerMessageId: "orchestrator-regression-3",
      receivedAt: now
    },
    ctx: {
      leadSource: "Room58 - Request details",
      pricingIntentHint: true,
      financeIntentHint: true,
      lead: {
        firstName: "Ashanti",
        source: "Room58 - Request details",
        vehicle: {
          year: "2002",
          make: "Harley-Davidson",
          model: "Road King Classic",
          color: "U882-02 White Pearl",
          stockId: "U882-02",
          vin: "1HD1FRW192Y615723",
          condition: "used"
        }
      } as any
    },
    expectedIncludes: ["2002 Road King Classic", "exact pricing"],
    expectedExcludes: ["monthly payment", "how much down", "60, 72, or 84"]
  },
  {
    id: "orchestrator_fallback_hiring_inquiry_handoff",
    event: {
      channel: "sms",
      provider: "twilio",
      from: "+17165550101",
      to: "+17166927200",
      body: "Where do I send a resume?",
      providerMessageId: "orchestrator-regression-4",
      receivedAt: now
    },
    ctx: {},
    expectedIncludes: ["hiring manager", "follow up"],
    expectedExcludes: ["How can I help?", "in stock"]
  },
  {
    id: "orchestrator_fallback_parts_handoff",
    event: {
      channel: "sms",
      provider: "twilio",
      from: "+17165550102",
      to: "+17166927200",
      body: "Can parts order drag specialties for my Road King?",
      providerMessageId: "orchestrator-regression-5",
      receivedAt: now
    },
    ctx: {},
    expectedIncludes: ["parts department", "reach out"],
    expectedExcludes: ["How can I help?", "in stock"]
  },
  {
    id: "orchestrator_fallback_service_records_handoff",
    event: {
      channel: "sms",
      provider: "twilio",
      from: "+17165550103",
      to: "+17166927200",
      body: "Do you have my service records?",
      providerMessageId: "orchestrator-regression-6",
      receivedAt: now
    },
    ctx: {},
    expectedIncludes: ["service records", "follow up"],
    expectedExcludes: ["How can I help?", "in stock"]
  },
  {
    id: "stateful_short_ack_no_draft",
    event: {
      channel: "sms",
      provider: "twilio",
      from: "+17165550104",
      to: "+17166927200",
      body: "Ok sounds good",
      providerMessageId: "orchestrator-regression-7",
      receivedAt: now
    },
    ctx: {
      followUp: { mode: "manual_handoff", reason: "manual_appointment" }
    },
    expectedIncludes: ["__EMPTY_DRAFT__"]
  },
  {
    id: "orchestrator_credit_app_request_gets_link_or_instruction",
    event: {
      channel: "sms",
      provider: "twilio",
      from: "+17165550105",
      to: "+17166927200",
      body: "Can I fill out a credit app?",
      providerMessageId: "orchestrator-regression-8",
      receivedAt: now
    },
    ctx: {},
    expectedIncludes: ["credit app", "online"],
    expectedExcludes: ["How can I help?", "in stock"]
  },
  {
    id: "initial_adf_international_shipping_policy_decline",
    event: {
      channel: "sms",
      provider: "sendgrid_adf",
      from: "+15049927647",
      to: "+17166927200",
      body: "Good afternoon, very nice motorcycle. I live in Honduras. Do you ship internationally?",
      providerMessageId: "orchestrator-regression-9",
      receivedAt: now
    },
    ctx: {
      leadSource: "Room58 - Request details",
      lead: {
        firstName: "Pedro",
        source: "Room58 - Request details",
        vehicle: {
          year: "2024",
          make: "Harley-Davidson",
          model: "Road Glide",
          condition: "used"
        }
      } as any
    },
    expectedIncludes: ["don't ship internationally", "checking"],
    expectedExcludes: ["wanted to learn more", "pricing", "availability"]
  }
];

let passed = 0;
const failures: Array<{ id: string; got: string; reason: string }> = [];

for (const c of cases) {
  const result = await orchestrateInbound(c.event, [], c.ctx);
  const got = String(result.draft ?? "");
  const normalizedExpectedIncludes = c.expectedIncludes.includes("__EMPTY_DRAFT__")
    ? c.expectedIncludes.filter(fragment => fragment !== "__EMPTY_DRAFT__")
    : c.expectedIncludes;
  const lower = got.toLowerCase();
  const missing = normalizedExpectedIncludes.filter(fragment => !lower.includes(fragment.toLowerCase()));
  if (c.expectedIncludes.includes("__EMPTY_DRAFT__") && got !== "") {
    missing.push("__EMPTY_DRAFT__");
  }
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
