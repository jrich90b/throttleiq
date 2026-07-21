/**
 * Service-visit vs sales-visit handoff decision eval (Justin Alley, 2026-07-21).
 *
 * A SALES thread (used 2017 Breakout, Room58 "Request details") got claimed by the service
 * department: the customer asked about the SALE bike's maintenance history, OUR OWN replies
 * filled the thread with "service" words ("we actually have it on the lift doing a 5,000 mile
 * service and a brake fluid flush right now"), and when the customer volunteered a visit time
 * ("Yea it'll probably be between 5 and 6 p then" — a sales visit to see the bike and talk
 * finance) the service-context hint routed the turn to a SERVICE scheduling handoff:
 * "I'll have service check availability for 5:00 PM" + classification rewritten to service.
 *
 * Fix: the cheap hint (isServiceDepartmentSchedulingRequest) now only NOMINATES the turn; the
 * typed parser (parseVisitDepartmentPurposeWithLLM) + the pure centralized decision
 * (decideServiceSchedulingHandoffTurn, routeStateReducer) settle the department, in BOTH the
 * live and regenerate paths via one shared resolver. This eval pins the decision table and the
 * two-path wiring.
 *
 * Run: npx tsx scripts/service_visit_purpose_decision_eval.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  decideServiceSchedulingHandoffTurn,
  type ServiceSchedulingHandoffTurnInput
} from "../services/api/src/domain/routeStateReducer.ts";

let n = 0;

type Row = {
  id: string;
  input: ServiceSchedulingHandoffTurnInput;
  expectRoute: "service_handoff" | "defer_to_scheduling_cluster";
  expectReason: string;
};

const base: ServiceSchedulingHandoffTurnInput = {
  serviceContextHint: true,
  customerNamedServiceThisTurn: false,
  parserPurpose: null,
  parserConfidence: null,
  confidenceMin: 0.6
};

const rows: Row[] = [
  // The Justin Alley miss: confident parser sales_visit read on a service-soaked sales thread
  // → the sales scheduling cluster owns the turn.
  {
    id: "justin_alley_sales_visit_defers",
    input: { ...base, parserPurpose: "sales_visit", parserConfidence: 0.95 },
    expectRoute: "defer_to_scheduling_cluster",
    expectReason: "parser_sales_visit"
  },
  // Explicit customer service ask this turn wins over ANY parser read (deterministic gate —
  // fail direction: never let the parser talk us out of an explicit request).
  {
    id: "explicit_service_ask_beats_parser",
    input: {
      ...base,
      customerNamedServiceThisTurn: true,
      parserPurpose: "sales_visit",
      parserConfidence: 0.99
    },
    expectRoute: "service_handoff",
    expectReason: "explicit_service_request"
  },
  // Parser says service → service handoff (status quo confirmed).
  {
    id: "parser_service_visit_keeps_handoff",
    input: { ...base, parserPurpose: "service_visit", parserConfidence: 0.9 },
    expectRoute: "service_handoff",
    expectReason: "service_handoff_default"
  },
  // Parser null (LLM down / disabled) → status quo (behavior-preserving fail direction).
  {
    id: "parser_null_keeps_handoff",
    input: { ...base, parserPurpose: null, parserConfidence: null },
    expectRoute: "service_handoff",
    expectReason: "service_handoff_default"
  },
  // Parser unknown → status quo.
  {
    id: "parser_unknown_keeps_handoff",
    input: { ...base, parserPurpose: "unknown", parserConfidence: 0.4 },
    expectRoute: "service_handoff",
    expectReason: "service_handoff_default"
  },
  // Low-confidence sales_visit is NOT enough to defer.
  {
    id: "low_confidence_sales_visit_keeps_handoff",
    input: { ...base, parserPurpose: "sales_visit", parserConfidence: 0.45 },
    expectRoute: "service_handoff",
    expectReason: "service_handoff_default"
  },
  // Confidence exactly at the threshold defers (>= min).
  {
    id: "threshold_confidence_sales_visit_defers",
    input: { ...base, parserPurpose: "sales_visit", parserConfidence: 0.6 },
    expectRoute: "defer_to_scheduling_cluster",
    expectReason: "parser_sales_visit"
  },
  // No service-context hint → not this cluster's turn at all.
  {
    id: "no_hint_defers",
    input: { ...base, serviceContextHint: false, parserPurpose: "service_visit", parserConfidence: 0.9 },
    expectRoute: "defer_to_scheduling_cluster",
    expectReason: "no_service_context"
  }
];

for (const row of rows) {
  const decision = decideServiceSchedulingHandoffTurn(row.input);
  assert.equal(decision.route, row.expectRoute, `${row.id}: route ${decision.route} != ${row.expectRoute}`);
  assert.equal(decision.reason, row.expectReason, `${row.id}: reason ${decision.reason} != ${row.expectReason}`);
  n += 2;
}

// --- Call-site wiring: BOTH paths consult the shared resolver before the service block. ---
const api = fs.readFileSync("services/api/src/index.ts", "utf8");
const resolverCalls = api.match(/await resolveServiceSchedulingHandoffDecision\(conv, event\.body\)/g) ?? [];
assert.equal(resolverCalls.length, 2, `expected the shared resolver at BOTH call sites (live + regen), found ${resolverCalls.length}`);
// Each service handoff block defers (falls through) instead of returning when the decision says sales.
const deferOutcomes = api.match(/service_scheduling_handoff_deferred_sales_visit/g) ?? [];
assert.equal(deferOutcomes.length >= 2, true, "both paths record the deferred-sales-visit route outcome");
// The resolver feeds the pure centralized decision.
assert.match(api, /decideServiceSchedulingHandoffTurn\(\{/, "resolver applies the centralized routeStateReducer decision");
// Explicit service asks bypass the LLM (deterministic gate ordering).
assert.match(
  api,
  /const customerNamedServiceThisTurn = hasExplicitDepartmentRequestFromText\(raw, "service"\);\s*\n\s*let parse[\s\S]{0,200}if \(!customerNamedServiceThisTurn\)/,
  "explicit service ask short-circuits the parser call"
);
n += 4;

console.log(`PASS service-visit purpose decision eval (${n} assertions)`);
