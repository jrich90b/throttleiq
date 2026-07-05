/**
 * Vehicle recommendation eval (2026-06-24).
 *
 * Pins the fix for the "give me some options" loop: a customer asking us to SUGGEST bikes by
 * budget/style (no model named) used to get "Which bike are you looking at so I can run it
 * correctly?" on repeat (s R Gurajala +17167506588). Now the agent classifies inventory by
 * segment, filters by the customer's preferences, and suggests real priced units.
 *
 * Layers (no live LLM — the parser is env-gated off; we test the pure pieces + source wiring):
 *  1) Segment classifier — model string -> cruiser/touring/sport/adventure/trike.
 *  2) Recommender — filter by condition + segment, rank by price, one per model, needs a price.
 *  3) Route decision table — recommend only on a confident request with no model in play.
 *  4) Reply/todo builders — list units, never a fabricated $/mo, offer to run numbers; honest
 *     fallback (no loop) when nothing fits.
 *  5) Source guards — both live + regen wire the resolver (route-parity), fail-direction, parser exists.
 *
 * Run: npx tsx scripts/vehicle_recommendation_eval.ts
 */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { checkMessage } from "./voice_charter_audit.ts";

process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "eval-no-live-key";
const {
  classifyHarleySegment,
  recommendInventory,
  buildVehicleRecommendationReply,
  buildVehicleRecommendationFollowupReply,
  buildVehicleRecommendationTodoSummary
} = await import("../services/api/src/domain/inventoryRecommender.ts");
const { decideVehicleRecommendationTurn, shouldBowOutRecommenderForNamedModel } = await import(
  "../services/api/src/domain/routeStateReducer.ts"
);

// --- 1) Segment classifier. ---
const segmentCases: [string, string][] = [
  ["Street Glide", "touring"],
  ["Road Glide Special", "touring"],
  ["Ultra Limited", "touring"],
  ["Fat Boy", "cruiser"],
  ["Twin Cruiser", "cruiser"], // literal "cruiser" in a feed model name (caught live 2026-06-24)
  ["Low Rider S", "cruiser"],
  ["Heritage Classic", "cruiser"],
  ["Breakout", "cruiser"],
  ["Super Glide Custom", "cruiser"], // a Dyna cruiser — must NOT read as touring (caught live)
  ["Wide Glide", "cruiser"],
  ["Sport Glide", "cruiser"],
  ["Iron 883", "sport"],
  ["Nightster", "sport"],
  ["Forty-Eight", "sport"],
  ["Pan America", "adventure"],
  ["Tri Glide Ultra", "trike"],
  ["Freewheeler", "trike"],
  ["", "unknown"],
  ["Mystery Cargo Van", "unknown"]
];
for (const [model, expected] of segmentCases) {
  assert.equal(classifyHarleySegment(model), expected, `classifyHarleySegment(${JSON.stringify(model)})`);
}

// --- 2) Recommender. ---
const feed = [
  { model: "Twin Cruiser", year: "2023", price: 3000, condition: "new" }, // cheapest, but a cruiser by name
  { model: "Fat Boy", year: "2022", price: 18000, condition: "new" },
  { model: "Iron 883", year: "2019", price: 7995, condition: "used" },
  { model: "Iron 883", year: "2018", price: 7200, condition: "used" }, // dup model, cheaper
  { model: "Street 750", year: "2020", price: 6495, condition: "used" },
  { model: "Nightster", year: "2023", price: 13500, condition: "new" },
  { model: "Road Glide", year: "2021", price: 24000, condition: "used" },
  { model: "Heritage Classic", year: "2020", price: 16000, condition: "used" },
  { model: "Sportster", year: "2017", price: null, condition: "used" } // no price => never suggested
] as any[];

// Exclude cruisers, both conditions: cheapest non-cruiser first, one per model, no priceless unit.
const noCruisers = recommendInventory(feed, { condition: "both", excludeSegments: ["cruiser"] }, 3);
assert.deepEqual(
  noCruisers.map(i => `${i.model} ${i.price}`),
  ["Street 750 6495", "Iron 883 7200", "Nightster 13500"],
  "excludes cruisers, ranks by price, one unit per model, drops priceless"
);
assert.ok(
  !noCruisers.some(i => /cruiser|fat boy|heritage/i.test(String(i.model))),
  "no cruisers leak through — incl. a cheapest-priced unit literally named 'Twin Cruiser'"
);

// Condition filter: used only.
const usedOnly = recommendInventory(feed, { condition: "used", excludeSegments: ["cruiser"] }, 5);
assert.ok(usedOnly.every(i => /used/i.test(String(i.condition))), "used filter keeps only used");
assert.ok(!usedOnly.some(i => i.model === "Nightster"), "a new Nightster is excluded under used-only");

// Include filter: touring only.
const touringOnly = recommendInventory(feed, { includeSegments: ["touring"] }, 3);
assert.deepEqual(touringOnly.map(i => i.model), ["Road Glide"], "include touring keeps only touring");

// Empty when nothing matches.
assert.deepEqual(recommendInventory([], { condition: "both" }, 3), []);
assert.deepEqual(
  recommendInventory(feed, { includeSegments: ["adventure"] }, 3),
  [],
  "no adventure units => empty (caller does the honest fallback)"
);

// --- 3) Route decision table. ---
const rec = (over: Partial<Parameters<typeof decideVehicleRecommendationTurn>[0]>) =>
  decideVehicleRecommendationTurn({
    parserAccepted: true,
    wantsRecommendation: true,
    confidence: 0.9,
    confidenceMin: 0.7,
    modelUnknown: true,
    ...over
  }).kind;
assert.equal(rec({}), "recommend", "confident request, no model => recommend");
assert.equal(rec({ parserAccepted: false }), "none", "no parse => none");
assert.equal(rec({ wantsRecommendation: false }), "none", "not a recommendation ask => none");
assert.equal(rec({ confidence: 0.5 }), "none", "below confidence floor => none");
assert.equal(rec({ modelUnknown: false }), "none", "a specific model in play => let pricing handle it");

// --- 3b) Named-model bow-out precedence (Tyrone Woods +13179357913, 2026-06-22). ---
// A named model normally hands off to finance/pricing ("price THIS bike"). But a named model CLASS
// PLUS a budget profile and no unit in play is "find me a <model> that fits my budget" — keep the
// recommender instead of looping "which bike are you looking at so I can run it correctly?".
assert.equal(
  shouldBowOutRecommenderForNamedModel({ namedModelThisTurn: true, hasBudgetProfile: false }),
  true,
  "named a model, no budget context => bow out to finance/pricing"
);
assert.equal(
  shouldBowOutRecommenderForNamedModel({ namedModelThisTurn: true, hasBudgetProfile: true }),
  false,
  'named a model class WITH a budget profile => keep the recommender ("road king or street glider" + $1.8-2k down/$450-550/mo)'
);
assert.equal(
  shouldBowOutRecommenderForNamedModel({ namedModelThisTurn: false, hasBudgetProfile: false }),
  false,
  "no model named => recommender path continues regardless of budget"
);
assert.equal(
  shouldBowOutRecommenderForNamedModel({ namedModelThisTurn: false, hasBudgetProfile: true }),
  false,
  "no model named, budget present => recommender path continues"
);

// --- 4) Reply + todo builders. ---
const reply = buildVehicleRecommendationReply({
  firstName: "Sam",
  matches: noCruisers as any,
  monthlyBudget: 200
});
assert.match(reply, /Sam/);
assert.match(reply, /used/i, "low budget reply is honest that ~$200/mo usually means used");
assert.match(reply, /Street 750 at \$6,495/, "lists the unit with price");
assert.match(reply, /run exact monthly numbers/i, "offers to run real numbers");
// Never fabricate a per-bike monthly payment: the only "/mo" allowed is the budget restatement.
assert.ok((reply.match(/\/mo\b/gi) ?? []).length <= 1, "at most the budget mentions /mo; no fabricated per-bike monthly");
for (const m of [/\$\d{1,3}\/mo for the/i, /payment (?:is|of) \$\d/i]) {
  assert.ok(!m.test(reply), `reply must not quote a computed payment (${m})`);
}
{
  const violations = checkMessage(reply, { firstOutbound: false, smsLike: true, staffHasSent: false });
  assert.deepEqual(violations, [], `recommendation reply must be charter-clean: "${reply}"`);
}
// High-budget reply drops the "usually means used" note.
const replyHi = buildVehicleRecommendationReply({ firstName: null, matches: noCruisers as any, monthlyBudget: 600 });
assert.ok(!/usually means used/i.test(replyHi), "high budget reply omits the used note");

// Fallback (no priced match) — honest, NOT a loop back to "which bike?".
const followup = buildVehicleRecommendationFollowupReply("Sam");
assert.match(followup, /Sam/);
assert.ok(!/which bike|what (?:bike|model)/i.test(followup), "fallback must not re-ask which bike (that's the bug)");
assert.match(buildVehicleRecommendationTodoSummary("Sam"), /^Sam asked for bike suggestions/);

// --- 5) Source guards (route-parity + fail-direction + parser exists). ---
const apiSource = await fs.readFile(path.resolve("services/api/src/index.ts"), "utf8");
assert.equal(
  (apiSource.match(/resolveVehicleRecommendationReply\(/g) ?? []).length >= 3,
  true,
  "the resolver must be defined + wired in BOTH the live and regen paths"
);
assert.match(
  apiSource,
  /recordRouteOutcome\(scope, "vehicle_recommendation"/,
  "the resolver records a vehicle_recommendation route outcome"
);
assert.match(
  apiSource,
  /if \(!isModelUnknownForPayments\(conv\)\) return null;/,
  "fail-direction: the resolver only fires when no model is in play (else existing flow runs)"
);
// The named-model bow-out is the centralized pure precedence (not an inline regex gate), and it is
// budget-aware so a named model class + budget profile keeps the recommender (Tyrone Woods).
assert.match(
  apiSource,
  /shouldBowOutRecommenderForNamedModel\(\{[\s\S]*?hasBudgetProfile[\s\S]*?\}\)/,
  "the resolver routes the named-model bow-out through the centralized budget-aware precedence"
);
// Precedence (live path): the recommendation resolver must be wired before the live finance
// "which bike?" continuation loop (its last occurrence is the live finance_followup_continuation
// branch; an earlier occurrence sits in a helper defined up-file, so anchor on lastIndexOf).
const recIdx = apiSource.indexOf("const recommendationReply = await resolveVehicleRecommendationReply");
const liveLoopIdx = apiSource.lastIndexOf("Which bike are you looking at so I can run it correctly?");
assert.ok(recIdx > 0 && liveLoopIdx > 0 && recIdx < liveLoopIdx, "recommendation must take precedence over the live finance which-bike loop");
// And it is wired just ahead of the vehicle-choice block in the live path (stable structural anchor).
const liveChoiceIdx = apiSource.indexOf("const vehicleChoiceReply = await resolveVehicleChoiceAlternativesReply");
assert.ok(recIdx < liveChoiceIdx, "live recommendation resolver is wired ahead of the vehicle-choice block");

const llmSource = await fs.readFile(path.resolve("services/api/src/domain/llmDraft.ts"), "utf8");
assert.match(llmSource, /export async function parseVehicleRecommendationRequestWithLLM/, "parser must exist");
assert.match(llmSource, /LLM_VEHICLE_RECOMMENDATION_PARSER_ENABLED/, "parser must be behind an enable flag");

console.log("PASS vehicle recommendation eval");
