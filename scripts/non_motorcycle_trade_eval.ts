import { strict as assert } from "node:assert";
import fs from "node:fs";

/**
 * Non-motorcycle trade handoff eval. A Harley dealer's trade flow is for motorcycles; a
 * customer wanting to trade something else (motorcycle camper, RV, car, boat, ATV) must be
 * handed off to a person, not given a trade-value draft. Production miss: Jessica Ornce —
 * "I wouldn't be able to make the deal happen unless I could also trade in my motorcycle
 * camper" got "estimate based on the bike details".
 *
 * Pins the centralized decision (decideNonMotorcycleTradeTurn), the parser coverage
 * (parseNonMotorcycleTradeWithLLM, when LLM enabled), and both-path wiring (source guard).
 */

const { decideNonMotorcycleTradeTurn } = await import("../services/api/src/domain/routeStateReducer.ts");

const MIN = 0.7;
const D = (over: any = {}) =>
  decideNonMotorcycleTradeTurn({
    parserAccepted: true,
    intent: "non_motorcycle_trade",
    explicitRequest: true,
    confidence: 0.9,
    confidenceMin: MIN,
    ...over
  });

// Handoff only on a confident, explicit non-motorcycle trade.
assert.equal(D().kind, "non_motorcycle_trade_handoff", "camper/boat/car trade => handoff");
assert.equal(D({ intent: "none" }).kind, "none", "motorcycle trade => none");
assert.equal(D({ explicitRequest: false }).kind, "none", "not explicit => none");
assert.equal(D({ confidence: 0.5 }).kind, "none", "below confidence floor => none");
assert.equal(D({ parserAccepted: false }).kind, "none", "parser not accepted => none");

// --- Source guards: both paths run the resolver (route-parity law) ---
const idx = fs.readFileSync("services/api/src/index.ts", "utf8");
const wirings = idx.match(/resolveNonMotorcycleTradeHandoffReply\(/g) ?? [];
// one definition + one live call + one regen call
assert.ok(wirings.length >= 3, `expected the resolver defined + called in both paths, saw ${wirings.length}`);
assert.ok(/"live"/.test(idx) && /"regen"/.test(idx), "resolver must run in live and regen scopes");
// sticky continuation: bypass the pre-filter once already handed off
assert.ok(
  /alreadyHandoff/.test(idx) && /!alreadyHandoff && !nonMotorcycleTradeHint/.test(idx),
  "resolver must keep parsing follow-up turns while already in the non-moto handoff"
);

// --- Parser coverage (only when the LLM is enabled, e.g. in ci:eval) ---
const llmOn = process.env.LLM_ENABLED === "1" && !!process.env.OPENAI_API_KEY;
if (llmOn) {
  const { parseNonMotorcycleTradeWithLLM } = await import("../services/api/src/domain/llmDraft.ts");
  const expectKind = async (text: string, want: "non_motorcycle_trade" | "none") => {
    const r = await parseNonMotorcycleTradeWithLLM({ text });
    assert.ok(r, `parser returned null for: ${text}`);
    assert.equal(r!.intent, want, `"${text}" => ${r!.intent}, expected ${want}`);
  };
  await expectKind(
    "I wouldn't be able to make the deal happen unless I could also trade in my motorcycle camper. Brand new last year.",
    "non_motorcycle_trade"
  );
  await expectKind("could I put my boat toward it?", "non_motorcycle_trade");
  await expectKind("would you take my truck on trade?", "non_motorcycle_trade");
  await expectKind("I want to trade in my 2019 Street Glide", "none");
  await expectKind("trading in my Vegas", "none");
  await expectKind("what would my bike be worth on trade?", "none");

  // Sticky continuation: with handoff history, a details reply stays non_motorcycle_trade;
  // a pivot to the bike breaks out to none.
  const camperHistory = [
    { direction: "in" as const, body: "I'd also need to trade in my motorcycle camper" },
    { direction: "out" as const, body: "let me have our team take a look at the motorcycle camper specifically — they'll follow up" }
  ];
  const cont = await parseNonMotorcycleTradeWithLLM({
    text: "it's a 2023 Forest River, 18ft, brand new never used",
    history: camperHistory
  });
  assert.ok(cont, "continuation parse returned null");
  assert.equal(cont!.intent, "non_motorcycle_trade", "details follow-up about the camper stays a non-moto trade");
  const pivot = await parseNonMotorcycleTradeWithLLM({
    text: "actually never mind that — what's the monthly payment on the Street Glide?",
    history: camperHistory
  });
  assert.ok(pivot, "pivot parse returned null");
  assert.equal(pivot!.intent, "none", "a pivot to the bike breaks out of the handoff");
} else {
  console.log("(LLM disabled — skipped parser coverage; decision-table + source guards ran)");
}

console.log("non_motorcycle_trade:eval ok");
