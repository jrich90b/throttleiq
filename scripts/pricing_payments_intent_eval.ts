import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parsePricingPaymentsIntentWithLLM } from "../services/api/src/domain/llmDraft.ts";

type Intent = "pricing" | "payments" | "none";

type Example = {
  id: string;
  text: string;
  history?: { direction: "in" | "out"; body: string }[];
  lead?: any;
  expected: {
    intent: Intent;
    intent_any?: Intent[];
    explicit_request: boolean;
    asks_monthly_target?: boolean;
    asks_down_payment?: boolean;
    asks_apr_or_term?: boolean;
    asks_for_payment_estimate?: boolean;
    asks_external_approval_transfer?: boolean;
    asks_rider_to_rider_financing?: boolean;
    asks_third_party_purchase_facilitation?: boolean;
  };
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataPath = process.argv[2] ?? path.join(__dirname, "pricing_payments_intent_examples.json");

const apiKey = process.env.OPENAI_API_KEY ?? "";
if (!apiKey || apiKey.trim() === "..." || apiKey.trim().length < 20) {
  console.error("OPENAI_API_KEY is missing or looks like a placeholder. Set a real key and re-run.");
  process.exit(1);
}

if (process.env.LLM_ENABLED !== "1" || process.env.LLM_PRICING_PAYMENTS_PARSER_ENABLED === "0") {
  console.error("LLM_ENABLED=1 and LLM_PRICING_PAYMENTS_PARSER_ENABLED!=0 are required for this eval.");
  process.exit(1);
}

const raw = await fs.readFile(dataPath, "utf8");
const examples = JSON.parse(raw) as Example[];

let intentOk = 0;
let explicitOk = 0;
let monthlyOk = 0;
let downOk = 0;
let aprTermOk = 0;
let estimateOk = 0;
let externalApprovalOk = 0;
let riderToRiderOk = 0;
let thirdPartyOk = 0;
let total = 0;
let nullCount = 0;
let monthlyAsserts = 0;
let downAsserts = 0;
let aprTermAsserts = 0;
let estimateAsserts = 0;
let externalApprovalAsserts = 0;
let riderToRiderAsserts = 0;
let thirdPartyAsserts = 0;

const mismatches: string[] = [];

for (const ex of examples) {
  total += 1;
  const result = await parsePricingPaymentsIntentWithLLM({
    text: ex.text,
    history: ex.history,
    lead: ex.lead
  });

  if (!result) {
    nullCount += 1;
    mismatches.push(
      `[${ex.id}] parser returned null | expected intent=${ex.expected.intent} explicit=${ex.expected.explicit_request}`
    );
    continue;
  }

  const expectedIntents = ex.expected.intent_any?.length ? ex.expected.intent_any : [ex.expected.intent];
  const intentMatch = expectedIntents.includes(result.intent);
  const explicitMatch = result.explicitRequest === ex.expected.explicit_request;

  if (intentMatch) intentOk += 1;
  if (explicitMatch) explicitOk += 1;

  let monthlyMatch = true;
  if (typeof ex.expected.asks_monthly_target === "boolean") {
    monthlyAsserts += 1;
    monthlyMatch = result.asksMonthlyTarget === ex.expected.asks_monthly_target;
    if (monthlyMatch) monthlyOk += 1;
  }

  let downMatch = true;
  if (typeof ex.expected.asks_down_payment === "boolean") {
    downAsserts += 1;
    downMatch = result.asksDownPayment === ex.expected.asks_down_payment;
    if (downMatch) downOk += 1;
  }

  let aprTermMatch = true;
  if (typeof ex.expected.asks_apr_or_term === "boolean") {
    aprTermAsserts += 1;
    aprTermMatch = result.asksAprOrTerm === ex.expected.asks_apr_or_term;
    if (aprTermMatch) aprTermOk += 1;
  }

  let estimateMatch = true;
  if (typeof ex.expected.asks_for_payment_estimate === "boolean") {
    estimateAsserts += 1;
    estimateMatch = result.asksForPaymentEstimate === ex.expected.asks_for_payment_estimate;
    if (estimateMatch) estimateOk += 1;
  }

  let externalApprovalMatch = true;
  if (typeof ex.expected.asks_external_approval_transfer === "boolean") {
    externalApprovalAsserts += 1;
    externalApprovalMatch =
      result.asksExternalApprovalTransfer === ex.expected.asks_external_approval_transfer;
    if (externalApprovalMatch) externalApprovalOk += 1;
  }

  let riderToRiderMatch = true;
  if (typeof ex.expected.asks_rider_to_rider_financing === "boolean") {
    riderToRiderAsserts += 1;
    riderToRiderMatch =
      result.asksRiderToRiderFinancing === ex.expected.asks_rider_to_rider_financing;
    if (riderToRiderMatch) riderToRiderOk += 1;
  }

  let thirdPartyMatch = true;
  if (typeof ex.expected.asks_third_party_purchase_facilitation === "boolean") {
    thirdPartyAsserts += 1;
    thirdPartyMatch =
      result.asksThirdPartyPurchaseFacilitation === ex.expected.asks_third_party_purchase_facilitation;
    if (thirdPartyMatch) thirdPartyOk += 1;
  }

  if (
    !intentMatch ||
    !explicitMatch ||
    !monthlyMatch ||
    !downMatch ||
    !aprTermMatch ||
    !estimateMatch ||
    !externalApprovalMatch ||
    !riderToRiderMatch ||
    !thirdPartyMatch
  ) {
    mismatches.push(
      [
        `[${ex.id}]`,
        `text="${ex.text}"`,
        `expected intent=${ex.expected.intent}${ex.expected.intent_any ? " (any)" : ""}`,
        `expected explicit=${ex.expected.explicit_request}`,
        typeof ex.expected.asks_monthly_target === "boolean"
          ? `expected asks_monthly_target=${ex.expected.asks_monthly_target}`
          : "",
        typeof ex.expected.asks_down_payment === "boolean"
          ? `expected asks_down_payment=${ex.expected.asks_down_payment}`
          : "",
        typeof ex.expected.asks_apr_or_term === "boolean"
          ? `expected asks_apr_or_term=${ex.expected.asks_apr_or_term}`
          : "",
        typeof ex.expected.asks_for_payment_estimate === "boolean"
          ? `expected asks_for_payment_estimate=${ex.expected.asks_for_payment_estimate}`
          : "",
        typeof ex.expected.asks_external_approval_transfer === "boolean"
          ? `expected asks_external_approval_transfer=${ex.expected.asks_external_approval_transfer}`
          : "",
        typeof ex.expected.asks_rider_to_rider_financing === "boolean"
          ? `expected asks_rider_to_rider_financing=${ex.expected.asks_rider_to_rider_financing}`
          : "",
        typeof ex.expected.asks_third_party_purchase_facilitation === "boolean"
          ? `expected asks_third_party_purchase_facilitation=${ex.expected.asks_third_party_purchase_facilitation}`
          : "",
        `got intent=${result.intent}`,
        `got explicit=${result.explicitRequest}`,
        `got asks_monthly_target=${result.asksMonthlyTarget}`,
        `got asks_down_payment=${result.asksDownPayment}`,
        `got asks_apr_or_term=${result.asksAprOrTerm}`,
        `got asks_for_payment_estimate=${result.asksForPaymentEstimate}`,
        `got asks_external_approval_transfer=${result.asksExternalApprovalTransfer}`,
        `got asks_rider_to_rider_financing=${result.asksRiderToRiderFinancing}`,
        `got asks_third_party_purchase_facilitation=${result.asksThirdPartyPurchaseFacilitation}`,
        `got confidence=${String(result.confidence ?? null)}`
      ]
        .filter(Boolean)
        .join(" | ")
    );
  }
}

const pct = (n: number, d: number) => (d ? Math.round((n / d) * 1000) / 10 : 0);

console.log(`Intent accuracy: ${intentOk}/${total} (${pct(intentOk, total)}%)`);
console.log(`Explicit accuracy: ${explicitOk}/${total} (${pct(explicitOk, total)}%)`);
if (monthlyAsserts > 0) {
  console.log(`asks_monthly_target match: ${monthlyOk}/${monthlyAsserts} (${pct(monthlyOk, monthlyAsserts)}%)`);
}
if (downAsserts > 0) {
  console.log(`asks_down_payment match: ${downOk}/${downAsserts} (${pct(downOk, downAsserts)}%)`);
}
if (aprTermAsserts > 0) {
  console.log(`asks_apr_or_term match: ${aprTermOk}/${aprTermAsserts} (${pct(aprTermOk, aprTermAsserts)}%)`);
}
if (estimateAsserts > 0) {
  console.log(
    `asks_for_payment_estimate match: ${estimateOk}/${estimateAsserts} (${pct(estimateOk, estimateAsserts)}%)`
  );
}
if (externalApprovalAsserts > 0) {
  console.log(
    `asks_external_approval_transfer match: ${externalApprovalOk}/${externalApprovalAsserts} (${pct(externalApprovalOk, externalApprovalAsserts)}%)`
  );
}
if (riderToRiderAsserts > 0) {
  console.log(
    `asks_rider_to_rider_financing match: ${riderToRiderOk}/${riderToRiderAsserts} (${pct(riderToRiderOk, riderToRiderAsserts)}%)`
  );
}
if (thirdPartyAsserts > 0) {
  console.log(
    `asks_third_party_purchase_facilitation match: ${thirdPartyOk}/${thirdPartyAsserts} (${pct(thirdPartyOk, thirdPartyAsserts)}%)`
  );
}
console.log(`Null parses: ${nullCount}/${total}`);
console.log("");

if (mismatches.length) {
  console.log("Mismatches:");
  for (const line of mismatches) console.log(`- ${line}`);
} else {
  console.log("All checks passed.");
}
