/**
 * Soft-visit precedence eval (pure, no LLM).
 *
 * Pins the referee that decides whether a turn arms the soft-visit cadence window —
 * `resolveSoftVisitCommitment` (services/api/src/domain/softVisitSignal.ts) — and the gate that
 * decides when the tiebreak parser is worth a round-trip (`needsVisitCommitmentTiebreak`).
 *
 * TWO defects, both measured 2026-08-14 over all 1,910 inbound turns in 90d on the live store:
 *
 *  1. THE PATHS DISAGREED. `/webhooks/twilio` OR'd the legacy keyword rule with the parser
 *     signal; `/conversations/:id/regenerate` used the parser signal ALONE. The keyword rule
 *     fires on 45 turns/90d and the parser signal agrees on 5, so ~40 turns/90d armed a cadence
 *     hold on the live SMS lane that a regenerate would never arm.
 *  2. A KEYWORD RULE OVERRULED A PARSER VERDICT THAT EXISTED — AGENTS.md "Fallback-vs-Parser
 *     Precedence" (Joe, 2026-08-06). Michelle Hyjek +17163164854, 2026-08-08 17:33Z:
 *     "No I am out of town for my nieces wedding I come back Monday". The appointment-timing
 *     parser read her correctly 6/6 ("out of town, returning Monday", intent none, conf
 *     0.86-0.92); the keyword rule saw `come` + `monday` and produced a staff task claiming she
 *     had said she would come in Aug 10.
 *
 * The eval asserts the DECISION (arm / don't arm) and the SOURCE, not any label spelling.
 *
 * Run: npx tsx scripts/soft_visit_precedence_eval.ts
 */
import { strict as assert } from "node:assert";
import fs from "node:fs";

const { resolveSoftVisitCommitment, needsVisitCommitmentTiebreak } = await import(
  "../services/api/src/domain/softVisitSignal.ts"
);
const { detectSoftVisitIntent } = await import("../services/api/src/domain/legacyRegexFallback.ts");
const { visitCommitmentConfidenceMin, visitCommitmentJsonSchema } = await import(
  "../services/api/src/domain/visitCommitmentParser.ts"
);

const parse = (over: any = {}) => ({
  intent: "none",
  explicitRequest: false,
  requested: { day: "", timeText: "", timeWindow: "unknown" },
  normalizedText: "",
  confidence: 0.9,
  ...over
});

// ── 1) The reported miss, end to end ─────────────────────────────────────────────────────────
const MICHELLE = "No I am out of town for my nieces wedding I come back Monday";
// The keyword rule really does fire on her text — that is the whole problem, so prove it here
// rather than asserting it from memory.
assert.equal(detectSoftVisitIntent(MICHELLE), true, "the legacy rule fires on the reported turn");
// The appointment-timing reading she actually got on current main, 6/6.
const michelleParse = parse({ requested: { day: "monday", timeText: "", timeWindow: "unknown" }, normalizedText: "out of town, returning Monday" });
assert.equal(
  needsVisitCommitmentTiebreak({ legacySignal: true, parse: michelleParse }),
  true,
  "a turn where the keyword rule would decide alone MUST buy the tiebreak parse"
);
assert.equal(
  resolveSoftVisitCommitment({
    legacySignal: true,
    parse: michelleParse,
    visitCommitment: { visit_commitment: "no", confidence: 0.95 }
  }).arm,
  false,
  "a confident visit_commitment=no must stop the keyword rule arming a soft visit"
);
assert.equal(
  resolveSoftVisitCommitment({
    legacySignal: true,
    parse: michelleParse,
    visitCommitment: { visit_commitment: "no", confidence: 0.95 }
  }).source,
  "visit_parser_veto",
  "and the decision must say WHY it did not arm"
);

// ── 2) The ~40 real commitments the keyword rule is carrying must SURVIVE ────────────────────
// Each of these fires the keyword rule while the day-anchored verb list misses it. Deleting the
// rule (the tempting de-tangle move) would drop every one; the referee must keep them.
for (const [text, nt] of [
  ["I'll come this weekend", "coming this weekend"],
  ["I will have to come Friday", "will have to come Friday"],
  ["I'm going to stop up there tomorrow, thank you", "going to stop up there tomorrow"]
] as const) {
  assert.equal(detectSoftVisitIntent(text), true, `legacy rule still fires on: ${text}`);
  const d = resolveSoftVisitCommitment({
    legacySignal: true,
    parse: parse({ requested: { day: "friday", timeText: "", timeWindow: "unknown" }, normalizedText: nt }),
    visitCommitment: { visit_commitment: "yes", confidence: 0.93 }
  });
  assert.equal(d.arm, true, `a real commitment must still arm: ${text}`);
  assert.equal(d.source, "legacy_regex", "and it arms as the gap-fill the fallback policy allows");
}

// ── 3) Fail direction: every degraded reading leaves TODAY'S behaviour ───────────────────────
const degraded: Array<[string, any]> = [
  ["parser unavailable (disabled / keyless / errored)", null],
  ["unclear", { visit_commitment: "unclear", confidence: 0.99 }],
  ["a hedged no below the floor", { visit_commitment: "no", confidence: visitCommitmentConfidenceMin() - 0.01 }],
  ["a yes", { visit_commitment: "yes", confidence: 0.9 }]
];
for (const [label, vc] of degraded) {
  assert.equal(
    resolveSoftVisitCommitment({ legacySignal: true, parse: michelleParse, visitCommitment: vc }).arm,
    true,
    `${label} must leave the legacy signal standing — the veto is the ONLY new suppression`
  );
}
// Exactly at the floor is enough (the floor is inclusive).
assert.equal(
  resolveSoftVisitCommitment({
    legacySignal: true,
    parse: michelleParse,
    visitCommitment: { visit_commitment: "no", confidence: visitCommitmentConfidenceMin() }
  }).arm,
  false,
  "a no exactly at the confidence floor vetoes"
);

// ── 4) A parser verdict that EXISTS wins; the keyword rule never drags a turn sideways ───────
const commitment = parse({ requested: { day: "saturday", timeText: "", timeWindow: "unknown" }, normalizedText: "committing to a saturday event visit" });
const d4 = resolveSoftVisitCommitment({ legacySignal: false, parse: commitment });
assert.equal(d4.arm, true, "the parser signal alone arms, with no keyword rule at all");
assert.equal(d4.source, "parser", "and it is attributed to the parser");
assert.equal(
  needsVisitCommitmentTiebreak({ legacySignal: true, parse: commitment }),
  false,
  "no tiebreak round-trip when the parser signal already fired"
);
for (const intent of ["ask_for_times", "provide_new_time", "tentative_time_window", "arrival_update", "accept_proposed_time", "decline_time"]) {
  const actionable = parse({ intent, requested: { day: "today", timeText: "", timeWindow: "unknown" }, normalizedText: "today" });
  const d = resolveSoftVisitCommitment({ legacySignal: true, parse: actionable });
  assert.equal(d.arm, false, `an actionable ${intent} turn belongs to its own arm, not a soft hold`);
  assert.equal(d.source, "parser_actionable_intent", "and the decision says so");
  assert.equal(
    needsVisitCommitmentTiebreak({ legacySignal: true, parse: actionable }),
    false,
    `no tiebreak round-trip is bought for an actionable ${intent} turn`
  );
}

// ── 5) The conditional arm, and its watch guard ──────────────────────────────────────────────
const conditional = parse({ normalizedText: "once she is back on the road i'll be in" });
const d5 = resolveSoftVisitCommitment({ legacySignal: false, parse: conditional });
assert.equal(d5.arm, true, "the day-less conditional commitment still arms");
assert.equal(d5.conditional, true, "and is flagged conditional so the caller picks the patience ack");
assert.equal(
  resolveSoftVisitCommitment({ legacySignal: false, parse: conditional, conditionalAllowed: false }).arm,
  false,
  "a watch-owned turn must not take the conditional arm (the watch keeps its routing)"
);

// ── 6) Nothing fires ⇒ nothing arms, and nothing is bought ───────────────────────────────────
const quiet = parse({ normalizedText: "thanks" });
assert.equal(resolveSoftVisitCommitment({ legacySignal: false, parse: quiet }).arm, false, "a quiet turn arms nothing");
assert.equal(resolveSoftVisitCommitment({ legacySignal: false, parse: quiet }).source, "none", "and says none");
assert.equal(
  needsVisitCommitmentTiebreak({ legacySignal: false, parse: quiet }),
  false,
  "no keyword signal ⇒ no tiebreak round-trip (this is what keeps the parser off every turn)"
);
// No reading at all + the keyword rule ⇒ the gap-fill the fallback policy explicitly allows.
assert.equal(
  resolveSoftVisitCommitment({ legacySignal: true, parse: null }).source,
  "legacy_regex",
  "with NO parser reading the keyword rule may fill the gap"
);

// ── 7) The strict-schema trap: Zod must not emit `oneOf` (OpenAI rejects it outright) ────────
const schemaJson = JSON.stringify(visitCommitmentJsonSchema());
assert.ok(!schemaJson.includes('"oneOf"'), "strict structured outputs reject oneOf — must be anyOf");
assert.ok(!schemaJson.includes('"$schema"'), "$schema must be stripped for strict mode");
assert.ok(schemaJson.includes("visit_commitment"), "the schema must actually carry the field");

// ── 8) BOTH paths go through the referee — the parity defect this eval exists to prevent ─────
// A source guard, deliberately: the two-path split is invisible to any unit test of the referee.
const index = fs.readFileSync("services/api/src/index.ts", "utf8");
const resolverCalls = index.split("resolveSoftVisitTurn(").length - 1;
assert.equal(
  resolverCalls,
  2,
  `the live and regen paths must BOTH call the shared resolver exactly once (found ${resolverCalls})`
);
// Guard the PATTERN, not a variable name. The first draft of this assertion keyed on
// `softVisitCommitment =` and a sabotage that merely renamed the variable to
// `softVisitCommitmentX` sailed straight through it (the trap: "a guard matching two loose
// substrings survives renaming the key"). What must never come back is the legacy signal being
// combined with anything OUTSIDE the referee — under any name.
const legacyOrs = index.split(/schedulingSignalsBase\.softVisit\s*===\s*true\s*(?:\|\||&&)/).length - 1;
assert.equal(
  legacyOrs,
  0,
  `the legacy soft-visit signal must reach the referee as an argument, never be combined inline (found ${legacyOrs})`
);
const legacyReads = index.split("schedulingSignalsBase.softVisit").length - 1;
assert.equal(
  legacyReads,
  1,
  `the live path reads the legacy signal exactly once — to hand it to the referee (found ${legacyReads})`
);

console.log("PASS soft_visit_precedence_eval — one referee, both paths, parser verdict wins");
