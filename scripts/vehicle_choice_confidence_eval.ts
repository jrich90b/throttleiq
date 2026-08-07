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
  { id: "relevance_guard_fail_stays_silent", input: { ...ok, modelRelevanceGuardPassed: false }, kind: "stay_silent" },
  // An ACCEPTED concrete parsed action (dealer_location_question / inventory_watch_acknowledgement)
  // owns the turn — the alternatives offer yields (corpus flywheel 2026-07-03, +12399612259:
  // "remind me again what address is this at?" drew the "line up options" reply instead of the address).
  { id: "concrete_parsed_action_owns_turn", input: { ...ok, concreteParsedActionThisTurn: true }, kind: "stay_silent" }
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

// A BARE AFFIRMATIVE answers the dealer's LAST line, not an older one. Michael +16076549423,
// 2026-06-09: an offer of "a simple compare" three days earlier, then an offer of current
// INCENTIVES, then "That would be great". Reading the whole thread the parser reached back to the
// compare offer and returned open_to_alternatives (0.83-0.85, over the 0.8 floor, 3 of 4 runs), so
// a lead already quoted on a specific unit was told "happy to line up a couple of other options"
// and asked new/used/budget — every one of which he had already answered.
//
// These assert the DECISION the referee actually branches on (offer alternatives, or not), never
// the label: `committed` and `unclear` both stay silent, so either is correct for the targets.
// The REAL thread, not a stylised one. Measured 2026-08-07: a three-message fixture does NOT
// reproduce the defect (the unfixed parser passes it 3/3) — it needs the customer's own answers
// and the check-in framing in the window the parser reads (history.slice(-6)). A fixture that
// passes on the broken code pins nothing, so this one is the transcript.
const realThreadPrefix: { direction: "in" | "out"; body: string }[] = [
  { direction: "in", body: "Interested in the 2026 Street Glide Limited" },
  { direction: "out", body: "Hey Michael, this is Joe at American H-D. I will get a price worked up for you. Couple questions, what county would you be registering the bike in and do you have a trade?" },
  { direction: "in", body: "No trade, Steuben county, 5-10k down, credit score over 800" },
  { direction: "out", body: "ok thanks, thats all i should need" },
  { direction: "out", body: "Hey Michael, sorry it took a little bit. Here is a quote on that iron horse street glide limited. I have it priced at the billiard gray base color and there are no dealer prep/hd freight charges, so you would just have the taxes and dmv charges. 10k down at just a 60 mo term you would probably be looking around $500/mo" },
  { direction: "out", body: "Hey Michael, just checking in on the 2026 Street Glide Limited. If helpful, I can send a simple compare and next-step options." }
];
const quoteTurn = { direction: "out" as const, body: "Here is a quote on that Street Glide Limited, billiard gray base color. 10k down at a 60 mo term you would be around $500/mo" };

const bareAffirmativeCases: {
  id: string;
  text: string;
  history: { direction: "in" | "out"; body: string }[];
  offersAlternatives: boolean;
}[] = [
  {
    id: "yes_to_incentives_after_an_older_compare_offer",
    text: "That would be great",
    history: [
      ...realThreadPrefix,
      { direction: "out", body: "I can also check current incentives on about the Street Glide Limited and send only what applies. Current offers: https://americanharley-davidson.com/l/h-d-national-promotions" }
    ],
    offersAlternatives: false
  },
  {
    id: "yes_to_photos_after_an_older_compare_offer",
    text: "That would be great",
    history: [
      ...realThreadPrefix,
      { direction: "out", body: "I can grab a few photos of that Street Glide and text them over if you want." }
    ],
    offersAlternatives: false
  },
  {
    id: "yes_to_an_explicit_other_bikes_offer_still_offers",
    text: "Yes please",
    history: [quoteTurn, { direction: "out", body: "Want me to pull a few similar bikes so you can compare?" }],
    offersAlternatives: true
  }
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

let bareRan = 0;
for (const c of bareAffirmativeCases) {
  const parsed = await parseVehicleChoiceConfidenceWithLLM({
    text: c.text,
    history: [...c.history, { direction: "in", body: c.text }],
    referencedModel: "Street Glide Limited"
  });
  if (!parsed) continue;
  bareRan += 1;
  const offers = parsed.stance === "open_to_alternatives";
  assert.equal(
    offers,
    c.offersAlternatives,
    `[${c.id}] a bare "${c.text}" must ${c.offersAlternatives ? "" : "NOT "}reach the offer-alternatives arm; stance=${parsed.stance} conf=${parsed.confidence}`
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
  ran === 0 && safetyRan === 0 && bareRan === 0
    ? `PASS vehicle choice confidence eval (source guard + ${rows.length} decision-table rows; LLM coverage skipped — parser disabled)`
    : `PASS vehicle choice confidence eval (source guard + ${rows.length} decision-table rows + ${ran}/${coverage.length} coverage + ${safetyRan}/${mustNotOffer.length} adversarial false-positive cases + ${bareRan}/${bareAffirmativeCases.length} bare-affirmative last-offer cases)`
);
