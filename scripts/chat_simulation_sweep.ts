import fs from "node:fs";
import path from "node:path";
import type { InboundMessageEvent } from "../services/api/src/domain/types.ts";
import { applyDraftStateInvariants } from "../services/api/src/domain/draftStateInvariants.ts";

process.env.LLM_ENABLED = process.env.LLM_ENABLED ?? "0";
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? "test";

const { orchestrateInbound } = await import("../services/api/src/domain/orchestrator.ts");

process.env.GOOGLE_REFRESH_TOKEN = "";
process.env.GOOGLE_CLIENT_ID = "";
process.env.GOOGLE_CLIENT_SECRET = "";

type SimIntent =
  | "short_ack"
  | "finance"
  | "availability"
  | "scheduling"
  | "parts"
  | "service"
  | "hiring"
  | "accessory"
  | "trade"
  | "callback"
  | "hours";

type ContextProfile = {
  id: string;
  followUpMode?: string | null;
  followUpReason?: string | null;
  dialogState?: string | null;
  bucket?: string | null;
  cta?: string | null;
  lead?: any;
  pricingIntentHint?: boolean;
  financeIntentHint?: boolean;
  availabilityIntentHint?: boolean;
  schedulingIntentHint?: boolean;
  callbackRequestedOverride?: boolean;
};

type SimCase = {
  id: string;
  intent: SimIntent;
  text: string;
  context: ContextProfile;
  shouldRespond: boolean;
};

type Gap = {
  id: string;
  intent: SimIntent;
  context: string;
  text: string;
  draft: string;
  reasons: string[];
};

const inboundByIntent: Record<SimIntent, string[]> = {
  short_ack: ["Ok sounds good", "Perfect thank you", "Awesome thanks", "Got it", "Sounds great!"],
  finance: [
    "What would payments be?",
    "I have 2500 down and want to stay under 500 monthly",
    "Can I fill out a credit app?",
    "What APR and term would I be looking at?",
    "Do you need proof of income for financing?"
  ],
  availability: [
    "Is it still available?",
    "Do you have any black Street Glides in stock?",
    "Very interested in the T10-26 Street Glide",
    "Can you check if that bike is still there?",
    "Any used Road Kings available?"
  ],
  scheduling: [
    "Can I come in Saturday morning?",
    "Does 9:30-10 work?",
    "I can stop by tomorrow after work",
    "Can we schedule a test ride?",
    "Friday or Saturday would work for me"
  ],
  parts: [
    "Can parts order drag specialties for my Road King?",
    "Do you have a part number for that seat?",
    "I need parts for my 572 fl",
    "Can someone at the parts counter call me?",
    "Looking for a take-off 114/117 M8"
  ],
  service: [
    "Can service quote an LED headlight install?",
    "I need an oil change",
    "Can service help with my bike?",
    "Do you have my service records?",
    "I need warranty work checked"
  ],
  hiring: [
    "Who is the hiring manager?",
    "Are you hiring?",
    "Where do I send a resume?",
    "I applied online, who handles that?",
    "Do you have any job openings?"
  ],
  accessory: [
    "Are you able to change the handlebars?",
    "Can heated grips and seat be added?",
    "Did you get a stereo for me to hear yet?",
    "How much to add pipes?",
    "Can I hear the exhaust before I pick?"
  ],
  trade: [
    "What would my trade be worth?",
    "I have a 2013 Street Glide to trade",
    "Do you buy bikes outright?",
    "Can you appraise my bike?",
    "I owe money on my trade still"
  ],
  callback: [
    "Can someone call me?",
    "Have a salesperson call me",
    "Can Brooke call me?",
    "I would rather talk on the phone",
    "Please call when you get a chance"
  ],
  hours: [
    "What are your hours?",
    "Are you open on weekends?",
    "What time do you close?",
    "Are you open during the week?",
    "What are weekend hours?"
  ]
};

const contexts: ContextProfile[] = [
  {
    id: "fresh_inventory",
    bucket: "inventory_interest",
    cta: "check_availability",
    lead: {
      firstName: "Mike",
      vehicle: { year: "2026", make: "Harley-Davidson", model: "Street Glide", stockId: "T10-26" }
    }
  },
  {
    id: "pricing_active",
    followUpMode: "active",
    followUpReason: "pricing",
    dialogState: "pricing_answered",
    bucket: "inventory_interest",
    cta: "ask_payment",
    pricingIntentHint: true,
    financeIntentHint: true,
    lead: { firstName: "Joe", vehicle: { year: "2025", make: "Harley-Davidson", model: "Road Glide" } }
  },
  {
    id: "manual_appointment",
    followUpMode: "manual_handoff",
    followUpReason: "manual_appointment",
    dialogState: "none",
    bucket: "general_inquiry",
    cta: "contact_us",
    lead: { firstName: "Kelly", vehicle: { year: "2024", make: "Harley-Davidson", model: "Low Rider S" } }
  },
  {
    id: "service_handoff",
    followUpMode: "manual_handoff",
    followUpReason: "service_request",
    dialogState: "service_handoff",
    bucket: "service",
    cta: "service_request",
    lead: { firstName: "Sam", vehicle: { year: "2021", make: "Harley-Davidson", model: "Road King" } }
  },
  {
    id: "watch_prompted",
    followUpMode: "active",
    followUpReason: "inventory_watch",
    dialogState: "inventory_watch_prompted",
    bucket: "inventory_interest",
    cta: "check_availability",
    lead: { firstName: "Dana", vehicle: { year: "2026", make: "Harley-Davidson", model: "Street Bob" } }
  }
];

const includeScheduling = process.argv.includes("--include-scheduling");
const intents = (Object.keys(inboundByIntent) as SimIntent[]).filter(
  intent => includeScheduling || intent !== "scheduling"
);
const targetCount = Math.max(1, Number(process.argv.find(arg => /^\d+$/.test(arg)) ?? 2500) || 2500);
const now = new Date().toISOString();

function makeCase(index: number): SimCase {
  const intent = intents[index % intents.length];
  const variants = inboundByIntent[intent];
  const text = variants[Math.floor(index / intents.length) % variants.length];
  const context = contexts[Math.floor(index / (intents.length * variants.length)) % contexts.length];
  return {
    id: `sim_${String(index + 1).padStart(5, "0")}`,
    intent,
    text,
    context,
    shouldRespond: intent !== "short_ack"
  };
}

function hasAny(text: string, patterns: RegExp[]) {
  return patterns.some(pattern => pattern.test(text));
}

function expectedTurnFlags(intent: SimIntent) {
  return {
    turnFinanceIntent: intent === "finance" || intent === "trade",
    turnAvailabilityIntent: intent === "availability",
    turnSchedulingIntent: intent === "scheduling",
    shortAckIntent: intent === "short_ack"
  };
}

function findGaps(c: SimCase, draft: string, shouldRespond: boolean): string[] {
  const out = draft.toLowerCase();
  const reasons: string[] = [];
  const routeOwnedParserState = c.intent === "parts" || c.intent === "service" || c.intent === "hiring";
  if (routeOwnedParserState && (!out.trim() || /^thanks for reaching out\. how can i help\??$/i.test(draft))) {
    reasons.push(`${c.intent}_requires_route_parser`);
    return reasons;
  }
  if (c.shouldRespond && (!shouldRespond || !out.trim())) reasons.push("missing_response");
  if (
    !c.shouldRespond &&
    out.trim() &&
    (c.context.followUpMode === "manual_handoff" || c.context.dialogState === "inventory_watch_prompted")
  ) {
    reasons.push("responded_to_short_ack_in_stateful_context");
  }
  if (out.length > 320 && c.intent !== "finance") reasons.push("sms_too_long");
  if (hasAny(out, [/\bwhich model\b/, /\bwhat model\b/]) && c.intent !== "availability") {
    reasons.push("unwanted_model_clarifier");
  }
  if (c.intent === "finance" && hasAny(out, [/\bstill available\b/, /\bin stock\b/, /\bwalkaround\b/, /\bwhich model\b/])) {
    reasons.push("finance_drifted_to_inventory");
  }
  if (c.intent === "availability" && hasAny(out, [/\bdown payment\b/, /\bapr\b/, /\bterm\b/, /\bcredit app\b/])) {
    reasons.push("availability_drifted_to_finance");
  }
  if (c.intent === "parts" && !hasAny(out, [/\bparts?\b/, /\bteam\b/, /\bfollow up\b/, /\bcheck\b/])) {
    reasons.push("parts_not_acknowledged");
  }
  if (c.intent === "service" && !hasAny(out, [/\bservice\b/, /\bteam\b/, /\bfollow up\b/, /\bcheck\b/])) {
    reasons.push("service_not_acknowledged");
  }
  if (c.intent === "hiring" && !hasAny(out, [/\bhiring\b/, /\bmanager\b/, /\bfollow up\b/, /\bpass\b/])) {
    reasons.push("hiring_not_acknowledged");
  }
  if (c.intent === "scheduling" && hasAny(out, [/\bconfirmed\b/, /\byou(?:'|’)re booked\b/, /\bscheduled for\b/])) {
    reasons.push("premature_booking_confirmation");
  }
  if (c.intent === "callback" && !hasAny(out, [/\bcall\b/, /\breach out\b/, /\bphone\b/])) {
    reasons.push("callback_not_acknowledged");
  }
  return reasons;
}

const originalLog = console.log;
console.log = (...args: unknown[]) => {
  const first = String(args[0] ?? "");
  if (first.startsWith("[orchestrateInbound]")) return;
  originalLog(...args);
};

const gaps: Gap[] = [];
const counts: Record<string, number> = {};

for (let i = 0; i < targetCount; i += 1) {
  const c = makeCase(i);
  const event: InboundMessageEvent = {
    channel: "sms",
    provider: "twilio",
    from: "+17165550000",
    to: "+17165550100",
    body: c.text,
    providerMessageId: c.id,
    receivedAt: now
  };
  const result = await orchestrateInbound(event, [], {
    followUp: c.context.followUpMode
      ? { mode: c.context.followUpMode, reason: c.context.followUpReason ?? "standard" }
      : undefined,
    bucket: c.context.bucket,
    cta: c.context.cta,
    lead: c.context.lead,
    pricingIntentHint: c.context.pricingIntentHint,
    financeIntentHint: c.context.financeIntentHint,
    availabilityIntentHint: c.intent === "availability" || c.context.availabilityIntentHint,
    schedulingIntentHint: c.intent === "scheduling" || c.context.schedulingIntentHint,
    callbackRequestedOverride: c.intent === "callback" || c.context.callbackRequestedOverride,
    agentNameOverride: "Brooke"
  });
  const invariant = applyDraftStateInvariants({
    inboundText: c.text,
    draftText: result.draft,
    followUpMode: c.context.followUpMode,
    followUpReason: c.context.followUpReason,
    dialogState: c.context.dialogState,
    classificationBucket: c.context.bucket,
    classificationCta: c.context.cta,
    ...expectedTurnFlags(c.intent)
  });
  const finalDraft = invariant.allow ? result.draft : "";
  const reasons = findGaps(c, finalDraft, result.shouldRespond && invariant.allow);
  for (const reason of reasons) counts[reason] = (counts[reason] ?? 0) + 1;
  if (reasons.length) {
    gaps.push({
      id: c.id,
      intent: c.intent,
      context: c.context.id,
      text: c.text,
      draft: finalDraft,
      reasons
    });
  }
}

const report = {
  generatedAt: new Date().toISOString(),
  total: targetCount,
  gapCount: gaps.length,
  gapRate: targetCount ? gaps.length / targetCount : 0,
  reasonCounts: Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1])),
  samples: gaps.slice(0, 100)
};

const outDir = path.join(process.cwd(), "reports", "chat_simulation_sweep");
fs.mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, "latest.json");
fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);

console.log(`Chat simulation sweep: ${targetCount - gaps.length}/${targetCount} passed`);
console.log(`Gaps: ${gaps.length}/${targetCount}`);
console.log(`Report: ${outPath}`);
console.log(`Scheduling included: ${includeScheduling ? "yes" : "no"}`);
for (const [reason, count] of Object.entries(report.reasonCounts)) {
  console.log(`- ${reason}: ${count}`);
}

if (gaps.length) process.exit(1);
