import { readFileSync } from "node:fs";
import path from "node:path";

const root = process.cwd();

function read(rel: string): string {
  return readFileSync(path.join(root, rel), "utf8");
}

function extractFunction(source: string, name: string): string {
  const start = source.indexOf(`function ${name}`);
  if (start < 0) {
    throw new Error(`Missing function ${name}`);
  }
  const braceStart = source.indexOf("{", start);
  if (braceStart < 0) {
    throw new Error(`Missing opening brace for ${name}`);
  }
  let depth = 0;
  for (let i = braceStart; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === "{") depth += 1;
    if (ch === "}") depth -= 1;
    if (depth === 0) {
      return source.slice(start, i + 1);
    }
  }
  throw new Error(`Missing closing brace for ${name}`);
}

type Check = {
  name: string;
  pass: boolean;
  detail?: string;
};

const indexSource = read("services/api/src/index.ts");
const routeStateReducerSource = read("services/api/src/domain/routeStateReducer.ts");
const agentsSource = read("AGENTS.md");
const fallbackBody = extractFunction(indexSource, "buildOrchestratorFailureFallback");
const noResponseFallbackBody = extractFunction(routeStateReducerSource, "buildNoResponseFallbackReply");

const forbiddenFallbackTokens = [
  "cashReadySignal",
  "availabilitySignal",
  "pricingSignal",
  "schedulingSignal",
  "fallbackModelLabelFromLead",
  "fallbackRequestedDayLabel",
  "What time works best",
  "What monthly payment",
  "I can check availability",
  "cash buyer",
  "ready to buy",
  "in stock",
  "payment|payments"
];
const forbiddenNoResponseReplyTokens = [
  "What term",
  "60, 72, or 84 months",
  "specific year, color, or trim",
  "What day and time work best",
  "setting a time to come in"
];

const checks: Check[] = [
  {
    name: "AGENTS.md records no semantic regex fallback policy",
    pass:
      agentsSource.includes("Do not generate semantic customer-facing answers from regex fallback") &&
      agentsSource.includes("orchestrator failure") &&
      agentsSource.includes("Parser-accepted `no_response` overrides")
  },
  {
    name: "orchestrator failure fallback requires handoff",
    pass:
      fallbackBody.includes("handoff: { required: true") &&
      fallbackBody.includes('reason: "other"') &&
      fallbackBody.includes("ack")
  },
  {
    name: "orchestrator failure fallback avoids inbound semantic parsing",
    pass: !forbiddenFallbackTokens.some((token) => fallbackBody.includes(token)),
    detail: forbiddenFallbackTokens.filter((token) => fallbackBody.includes(token)).join(", ")
  },
  {
    name: "safe orchestrator catch still routes through fallback boundary",
    pass: indexSource.includes("return buildOrchestratorFailureFallback(event, ctx);")
  },
  {
    name: "no-response deterministic fallback avoids sales-discovery prompts",
    pass: !forbiddenNoResponseReplyTokens.some((token) => noResponseFallbackBody.includes(token)),
    detail: forbiddenNoResponseReplyTokens.filter((token) => noResponseFallbackBody.includes(token)).join(", ")
  },
  {
    name: "live no-response override creates staff follow-up",
    pass:
      indexSource.includes("buildNoResponseFallbackTodoSummary(noResponseContextDecision)") &&
      indexSource.includes('setFollowUpMode(conv, "manual_handoff", "orchestrator_no_response_fallback")')
  }
];

let failed = 0;
for (const check of checks) {
  if (check.pass) {
    console.log(`PASS ${check.name}`);
  } else {
    failed += 1;
    console.error(`FAIL ${check.name}${check.detail ? `: ${check.detail}` : ""}`);
  }
}

if (failed > 0) {
  process.exit(1);
}

console.log("Fallback policy eval passed.");
