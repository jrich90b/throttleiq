import fs from "node:fs";
import path from "node:path";
import {
  isResponseControlParserAccepted,
  isResponseControlParserConfidentDecision,
  isResponseControlNoResponseAccepted
} from "../services/api/src/domain/transitionSafety.ts";
import { resolveLeadIdentity } from "../services/api/src/domain/leadIdentity.ts";

type Case = {
  id: string;
  expected: boolean;
  run: () => boolean;
};

const strongOptOut = {
  intent: "opt_out",
  explicitRequest: true,
  confidence: 0.93
};

const strongWrongNumber = {
  intent: "wrong_number",
  explicitRequest: true,
  confidence: 0.98
};

const strongDataQualityComplaint = {
  intent: "data_quality_complaint",
  explicitRequest: true,
  confidence: 0.96
};

const weakSchedule = {
  intent: "schedule_request",
  explicitRequest: true,
  confidence: 0.41
};

const noneIntent = {
  intent: "none",
  explicitRequest: false,
  confidence: 0.99
};

const noResponseIntent = {
  intent: "no_response",
  explicitRequest: false,
  confidence: 0.93
};

const apiIndex = fs.readFileSync(path.join(process.cwd(), "services/api/src/index.ts"), "utf8");
const suppressedBranchStart = apiIndex.indexOf("if (isSuppressed(event.from))");
const suppressedBranch = suppressedBranchStart >= 0 ? apiIndex.slice(suppressedBranchStart, suppressedBranchStart + 1100) : "";
// 2026-08-13: this case used to pin the SOURCE TEXT of `getLeadIdentifiers` inside index.ts. The
// body moved to domain/leadIdentity.ts and the pin failed on a refactor that preserved the
// behaviour exactly — the failure mode AGENTS.md warns about. It now EXECUTES the resolver, so it
// still fails if the Twilio-`From` fallback is dropped and no longer fails on a move. index.ts must
// keep delegating rather than grow a second reader, which is what the source check below is for.
const indexDelegatesLeadIdentity = apiIndex.includes(
  "return resolveLeadIdentity(conv, event, normalizePhone);"
);
const normalizePhoneForIdentity = (raw: string): string => {
  const trimmed = String(raw ?? "").trim();
  const digits = trimmed.replace(/\D/g, "");
  if (trimmed.startsWith("+")) return trimmed;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length > 10) return `+${digits}`;
  return trimmed;
};
const thirdPartyDecisionStart = apiIndex.indexOf("function resolveThirdPartyFinanceFacilitationDecision");
const thirdPartyDecisionEnd = apiIndex.indexOf("function buildThirdPartyFinanceFacilitationReply", thirdPartyDecisionStart);
const thirdPartyDecisionBranch =
  thirdPartyDecisionStart >= 0 && thirdPartyDecisionEnd > thirdPartyDecisionStart
    ? apiIndex.slice(thirdPartyDecisionStart, thirdPartyDecisionEnd)
    : "";

const cases: Case[] = [
  {
    id: "accepts_strong_opt_out_parse",
    expected: true,
    run: () => isResponseControlParserAccepted(strongOptOut)
  },
  {
    id: "accepts_strong_wrong_number_parse",
    expected: true,
    run: () => isResponseControlParserAccepted(strongWrongNumber)
  },
  {
    id: "accepts_strong_data_quality_complaint_parse",
    expected: true,
    run: () => isResponseControlParserAccepted(strongDataQualityComplaint)
  },
  {
    id: "rejects_low_confidence_schedule_parse",
    expected: false,
    run: () => isResponseControlParserAccepted(weakSchedule)
  },
  {
    id: "rejects_none_intent_even_high_confidence",
    expected: false,
    run: () => isResponseControlParserAccepted(noneIntent)
  },
  {
    id: "none_intent_can_still_be_authoritative",
    expected: true,
    run: () => isResponseControlParserConfidentDecision(noneIntent)
  },
  {
    id: "low_confidence_parse_is_not_authoritative",
    expected: false,
    run: () => isResponseControlParserConfidentDecision(weakSchedule)
  },
  {
    id: "no_response_intent_is_authoritative_without_explicit_request",
    expected: true,
    run: () => isResponseControlNoResponseAccepted(noResponseIntent)
  },
  {
    id: "suppressed_stop_request_still_publishes_opt_out_confirmation",
    expected: true,
    run: () =>
      // 2026-06-12: confirmation now flows through the audited boundary with
      // forceSend (sent immediately even in suggest mode, never drafted), and
      // Twilio-handled STOP keywords stay silent (Twilio auto-confirms those).
      suppressedBranch.includes("llmOptOut || isOptOut(event.body)") &&
      suppressedBranch.includes("isTwilioHandledStopKeyword(event.body)") &&
      suppressedBranch.indexOf("publishLiveTwilioReply(confirmation, undefined, { forceSend: true })") >
        suppressedBranch.indexOf("applySmsOptOut")
  },
  {
    id: "sms_stop_suppression_uses_twilio_from_when_lead_phone_blank",
    expected: true,
    run: () =>
      indexDelegatesLeadIdentity &&
      // lead.phone blank + an email leadKey: the Twilio `From` is the only phone we have.
      resolveLeadIdentity(
        { leadKey: "buyer@example.com", lead: { phone: "" } },
        { from: "+17165231238" },
        normalizePhoneForIdentity
      ).phone === "+17165231238" &&
      // a real lead.phone still wins over the inbound `From`.
      resolveLeadIdentity(
        { leadKey: "+17164656440", lead: { phone: "7169467451" } },
        { from: "+17165231238" },
        normalizePhoneForIdentity
      ).phone === "+17169467451"
  },
  {
    id: "third_party_policy_requires_explicit_third_party_or_r2r_cue",
    expected: true,
    run: () =>
      thirdPartyDecisionBranch.includes("hasRiderToRiderFinanceCue(text)") &&
      thirdPartyDecisionBranch.includes("hasThirdPartyPurchaseFacilitationCue(text)") &&
      thirdPartyDecisionBranch.includes("hasRecentInboundThirdPartyFinanceCue(history)") &&
      thirdPartyDecisionBranch.includes("!!parsed.asksThirdPartyPurchaseFacilitation &&") &&
      thirdPartyDecisionBranch.includes("(currentHasThirdPartyCue || recentHasThirdPartyFinanceCue)") &&
      apiIndex.includes("resolveThirdPartyFinanceFacilitationDecision(pricingPaymentsParse, event.body ?? \"\", recentHistory)") &&
      apiIndex.includes("resolveThirdPartyFinanceFacilitationDecision(pricingPaymentsParse, event.body ?? \"\", regenHistory)")
  }
];

let passed = 0;
for (const c of cases) {
  const actual = c.run();
  const ok = actual === c.expected;
  if (ok) passed += 1;
  console.log(`${ok ? "PASS" : "FAIL"} ${c.id} expected=${c.expected} actual=${actual}`);
}

if (passed !== cases.length) {
  console.error(`\n${cases.length - passed} failures out of ${cases.length} cases`);
  process.exit(1);
}

console.log(`\nAll ${cases.length} response-control checks passed.`);
