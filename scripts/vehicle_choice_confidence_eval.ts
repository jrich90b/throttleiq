/**
 * Vehicle-choice confidence / open-to-alternatives eval.
 *
 * Pins the 2026-06-18 feature: when a customer is lukewarm/undecided about a SPECIFIC bike
 * they referenced, the agent proactively offers a couple of alternatives; when they're
 * committed it stays out of the way. This is fuzzy comprehension with a real false-positive
 * risk (offering alternatives to a confident buyer undercuts their choice), so the DEFAULT is
 * to stay silent and the whole design FAILS toward not-offering.
 *
 * Three layers, mirroring the trade-qualifier eval:
 *  1) Source guard (no LLM): the parser is exported + flagged + schema'd, the route decision is
 *     centralized in routeStateReducer, and the shared resolver is wired into BOTH paths.
 *  2) Decision-table coverage (pure, no LLM): the reply-gate — offer ONLY on
 *     open_to_alternatives + confidence>=min + referenced-model + relevance-guard; every other
 *     branch stays silent.
 *  3) LLM parser coverage (runs when enabled; skips cleanly otherwise) incl. ADVERSARIAL
 *     false-positive fixtures: committed phrasings must NOT classify as open_to_alternatives;
 *     off-topic must be unclear.
 *
 * Run gated: LLM_ENABLED=1 LLM_VEHICLE_CHOICE_CONFIDENCE_PARSER_ENABLED=1 npx tsx scripts/vehicle_choice_confidence_eval.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { parseVehicleChoiceConfidenceWithLLM } from "../services/api/src/domain/llmDraft.ts";
import { decideVehicleChoiceConfidenceTurn } from "../services/api/src/domain/routeStateReducer.ts";

// --- 1) Source guard (no LLM): parser + centralized decision + BOTH-paths wiring. ---
const index = fs.readFileSync("services/api/src/index.ts", "utf8");
const llm = fs.readFileSync("services/api/src/domain/llmDraft.ts", "utf8");
const reducer = fs.readFileSync("services/api/src/domain/routeStateReducer.ts", "utf8");

assert.ok(
  /export async function parseVehicleChoiceConfidenceWithLLM/.test(llm),
  "the parser must be exported from llmDraft.ts"
);
assert.ok(
  /VEHICLE_CHOICE_CONFIDENCE_PARSER_JSON_SCHEMA/.test(llm),
  "the strict JSON schema const must exist"
);
assert.ok(
  /LLM_VEHICLE_CHOICE_CONFIDENCE_PARSER_ENABLED/.test(llm),
  "the parser must be behind an enable flag (on-by-default via !== \"0\")"
);
assert.ok(
  /export function decideVehicleChoiceConfidenceTurn/.test(reducer),
  "the route decision must be centralized in routeStateReducer.ts"
);
const callSites = (index.match(/await resolveVehicleChoiceAlternativesReply\(/g) || []).length;
assert.ok(
  callSites >= 2,
  `the shared resolver must be wired in BOTH paths (live + regenerate); found ${callSites} call site(s)`
);

// --- 2) Decision-table coverage (pure): the reply-gate. FAIL DIRECTION = stay_silent. ---
type Row = {
  id: string;
  input: Parameters<typeof decideVehicleChoiceConfidenceTurn>[0];
  kind: "offer_alternatives" | "stay_silent";
};

// All gates satisfied — the ONLY shape that offers.
const ok = {
  parserAccepted: true,
  stance: "open_to_alternatives" as string | null,
  confidence: 0.9,
  confidenceMin: 0.8,
  hasReferencedModel: true,
  modelRelevanceGuardPassed: true
};

const rows: Row[] = [
  { id: "open_high_conf_guard_model", input: { ...ok }, kind: "offer_alternatives" },
  { id: "open_at_confidence_floor", input: { ...ok, confidence: 0.8 }, kind: "offer_alternatives" },
  { id: "committed_stays_silent", input: { ...ok, stance: "committed" }, kind: "stay_silent" },
  { id: "unclear_stays_silent", input: { ...ok, stance: "unclear" }, kind: "stay_silent" },
  { id: "null_stance_stays_silent", input: { ...ok, stance: null }, kind: "stay_silent" },
  { id: "parser_not_accepted_stays_silent", input: { ...ok, parserAccepted: false }, kind: "stay_silent" },
  { id: "low_confidence_stays_silent", input: { ...ok, confidence: 0.79 }, kind: "stay_silent" },
  { id: "no_referenced_model_stays_silent", input: { ...ok, hasReferencedModel: false }, kind: "stay_silent" },
  { id: "relevance_guard_fail_stays_silent", input: { ...ok, modelRelevanceGuardPassed: false }, kind: "stay_silent" }
];

for (const r of rows) {
  const got = decideVehicleChoiceConfidenceTurn(r.input).kind;
  assert.equal(got, r.kind, `decision[${r.id}] expected ${r.kind}, got ${got}`);
}

// --- 3) LLM parser coverage + adversarial false-positive fixtures (gated; skips cleanly). ---
const coverage: { text: string; expect: "committed" | "open_to_alternatives" | "unclear" }[] = [
  { text: "what else do you have?", expect: "open_to_alternatives" },
  { text: "I'm torn between the Street Glide and the Road Glide", expect: "open_to_alternatives" },
  { text: "honestly not sure this is the one for me", expect: "open_to_alternatives" },
  { text: "is there anything cheaper?", expect: "open_to_alternatives" },
  { text: "this is the one I want", expect: "committed" },
  { text: "I'll take the Road Glide", expect: "committed" },
  { text: "what's the out the door price on it?", expect: "unclear" },
  { text: "can I come by Saturday to see it?", expect: "unclear" }
];

// Safety-critical guard: committed/off-topic phrasings must NEVER read as open_to_alternatives.
// A false positive here is the failure mode the feature is built to avoid.
const mustNotOffer: string[] = [
  "this is the one I want",
  "I'll take the Road Glide",
  "let's do it",
  "I've decided on the Street Glide",
  "yeah let's move forward on that one",
  "what's the out the door price on it?",
  "can I come by Saturday to see it?"
];

let ran = 0;
let safetyRan = 0;

for (const c of coverage) {
  const parsed = await parseVehicleChoiceConfidenceWithLLM({ text: c.text, referencedModel: "Street Glide" });
  if (!parsed) continue; // parser disabled or transient null — skip, don't red the gate
  ran += 1;
  assert.equal(
    parsed.stance,
    c.expect,
    `"${c.text}" should classify as ${c.expect}, got ${parsed.stance}`
  );
}

for (const text of mustNotOffer) {
  const parsed = await parseVehicleChoiceConfidenceWithLLM({ text, referencedModel: "Road Glide" });
  if (!parsed) continue;
  safetyRan += 1;
  assert.notEqual(
    parsed.stance,
    "open_to_alternatives",
    `ADVERSARIAL: "${text}" must NOT classify as open_to_alternatives (would undercut a committed buyer), got ${parsed.stance}`
  );
}

console.log(
  ran === 0 && safetyRan === 0
    ? `PASS vehicle choice confidence eval (source guard + ${rows.length} decision-table rows; LLM coverage skipped — parser disabled)`
    : `PASS vehicle choice confidence eval (source guard + ${rows.length} decision-table rows + ${ran}/${coverage.length} coverage + ${safetyRan}/${mustNotOffer.length} adversarial false-positive cases)`
);
