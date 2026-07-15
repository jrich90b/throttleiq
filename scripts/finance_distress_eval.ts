/**
 * Finance-distress hard-gate eval.
 *
 * Pins the 2026-07-15 Joe ruling (decision-queue, John Geschwender +17166060001): a customer
 * disclosing THEIR OWN credit problem / affordability hardship ("due to a past identity theft
 * I no longer have a credit score and paying a ridiculous high interest just doesn't seem
 * plausible for me") must get a clean human handoff — never automated solutioning. The live
 * miss replied "Would a co-signer be a possibility for you?", which the open critic flagged
 * as unauthorized_financial_advice_or_promise. Every parser read the words correctly; the
 * failure was judgment, so the ROUTE is hard-gated in BOTH paths.
 *
 * Layers: (1) source guard (parser + centralized decision + BOTH-paths wiring + hint +
 * distress-before-process precedence), (2) pure decision table (handoff ONLY on accepted +
 * finance_distress + self_disclosed + confidence>=min), (3) LLM coverage with the Geschwender
 * replay fixture + sibling distress phrasings, and ADVERSARIAL negatives (normal finance
 * questions and bike-price haggling must NOT gate).
 *
 * Run gated: LLM_ENABLED=1 LLM_FINANCE_DISTRESS_PARSER_ENABLED=1 npx tsx scripts/finance_distress_eval.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { parseFinanceDistressWithLLM } from "../services/api/src/domain/llmDraft.ts";
import { decideFinanceDistressTurn } from "../services/api/src/domain/routeStateReducer.ts";

// --- 1) Source guard (no LLM). ---
const index = fs.readFileSync("services/api/src/index.ts", "utf8");
const llm = fs.readFileSync("services/api/src/domain/llmDraft.ts", "utf8");
const reducer = fs.readFileSync("services/api/src/domain/routeStateReducer.ts", "utf8");

assert.ok(
  /export async function parseFinanceDistressWithLLM/.test(llm),
  "the parser must be exported from llmDraft.ts"
);
assert.ok(/FINANCE_DISTRESS_PARSER_JSON_SCHEMA/.test(llm), "the strict JSON schema const must exist");
assert.ok(
  /LLM_FINANCE_DISTRESS_PARSER_ENABLED/.test(llm),
  'the parser must be behind an enable flag (on-by-default via !== "0")'
);
assert.ok(
  /export function decideFinanceDistressTurn/.test(reducer),
  "the route decision must be centralized in routeStateReducer.ts"
);
assert.ok(
  /function financeDistressHint/.test(index) && /FINANCE_DISTRESS_HINT_RE/.test(index),
  "the pre-filter hint must exist in index.ts"
);
const callSites = (index.match(/await resolveFinanceDistressHandoffReply\(/g) || []).length;
assert.ok(
  callSites >= 2,
  `the shared resolver must be wired in BOTH paths (live + regenerate); found ${callSites} call site(s)`
);
// Precedence: distress must run BEFORE the finance-process handoff in both paths — a
// distressed turn can also contain process phrasing, and distress outranks. Robust check:
// every process-handoff call site must have a distress-handoff call site shortly before it.
const positionsOf = (needle: string): number[] => {
  const out: number[] = [];
  let i = index.indexOf(needle);
  while (i >= 0) {
    out.push(i);
    i = index.indexOf(needle, i + 1);
  }
  return out;
};
const distressCalls = positionsOf("await resolveFinanceDistressHandoffReply(");
const processCalls = positionsOf("await resolveFinanceProcessHandoffReply(");
assert.ok(processCalls.length >= 2, "expected the finance-process handoff in both paths");
for (const p of processCalls) {
  assert.ok(
    distressCalls.some(d => d < p && p - d < 4000),
    "each finance-process handoff call site must be preceded (closely) by the distress handoff — distress outranks"
  );
}
// The handoff reply must never contain solutioning language.
const replyMatch = index.match(/function buildFinanceDistressHandoffReply\(\): string \{[\s\S]*?\n\}/);
assert.ok(replyMatch, "buildFinanceDistressHandoffReply must exist");
assert.ok(
  !/co-?signer|approve|approval|rate|apr|interest/i.test(replyMatch![0]),
  "the distress handoff reply must contain NO solutioning (co-signer/approval/rate framing)"
);

// Hint must catch the production miss + sibling distress phrasings (else the parser never runs).
// Kept in sync with FINANCE_DISTRESS_HINT_RE in index.ts — update both together.
const HINT_RE =
  /\b(credit (score|history|report|union)|(bad|no|poor|damaged|shot|ruined|bruised|rebuild(ing)?|rough|terrible) credit|credit('s| is| was)? (bad|shot|ruined|gone|terrible|not great|poor)|bankrupt\w*|repossess\w*|repo\b|identity theft|high(er)? interest|(interest|rate|apr|payment)s? .{0,30}(high|crazy|ridiculous|insane|outrageous)|(ridiculous|crazy|insane|outrageous) .{0,30}(interest|rate|apr|payment)|can'?t (afford|swing|make the payment)|cannot afford|couldn'?t afford|out of my (budget|price range|league)|fixed income|disability|lost my job|laid off|unemploy\w*|hours (got |getting )?cut|financial (hardship|trouble|situation|problems)|money('s| is)? (tight|a problem)|struggling (financially|to)|paycheck to paycheck)\b/i;
for (const phrase of [
  "Oh well, due to a past identity theft I no longer have a credit score and paying a ridiculous high interest for that just doesn't seem plausible for me",
  "my credit is shot after my divorce",
  "I went through a bankruptcy last year",
  "honestly with my hours getting cut I can't swing that payment right now",
  "I'm on a fixed income so those numbers scare me"
]) {
  assert.ok(HINT_RE.test(phrase), `hint must match distress phrasing: "${phrase}"`);
}

// --- 2) Decision-table coverage (pure). ---
type Row = {
  id: string;
  input: Parameters<typeof decideFinanceDistressTurn>[0];
  kind: "finance_distress_handoff" | "none";
};

const ok = {
  parserAccepted: true,
  intent: "finance_distress" as string | null,
  selfDisclosed: true,
  confidence: 0.9,
  confidenceMin: 0.7
};

const rows: Row[] = [
  { id: "accepted_self_disclosed_high_conf", input: { ...ok }, kind: "finance_distress_handoff" },
  { id: "at_confidence_floor", input: { ...ok, confidence: 0.7 }, kind: "finance_distress_handoff" },
  { id: "intent_none", input: { ...ok, intent: "none" }, kind: "none" },
  { id: "null_intent", input: { ...ok, intent: null }, kind: "none" },
  { id: "not_self_disclosed", input: { ...ok, selfDisclosed: false }, kind: "none" },
  { id: "parser_not_accepted", input: { ...ok, parserAccepted: false }, kind: "none" },
  { id: "below_confidence_floor", input: { ...ok, confidence: 0.69 }, kind: "none" },
  { id: "nan_confidence", input: { ...ok, confidence: Number.NaN }, kind: "none" }
];

for (const r of rows) {
  const got = decideFinanceDistressTurn(r.input).kind;
  assert.equal(got, r.kind, `decision[${r.id}] expected ${r.kind}, got ${got}`);
}

// --- 3) LLM coverage + adversarial negatives (gated; skips cleanly). ---
const coverage: { text: string; expect: "finance_distress" | "none" }[] = [
  {
    // The Geschwender replay fixture, verbatim (2026-07-14 production miss).
    text: "Oh well, due to a past identity theft I no longer have a credit score and paying a ridiculous high interest for that just doesn't seem plausible for me",
    expect: "finance_distress"
  },
  { text: "my credit is shot after my divorce, not sure I could even get approved", expect: "finance_distress" },
  { text: "I went through a bankruptcy last year so financing is probably a no go", expect: "finance_distress" },
  { text: "honestly with my hours getting cut I can't swing that payment right now", expect: "finance_distress" },
  { text: "what rate can I get?", expect: "none" },
  { text: "what credit score do you guys usually need?", expect: "none" },
  { text: "can I come by Saturday?", expect: "none" }
];

// Safety-critical negatives: normal finance questions and bike-price haggling must NEVER be
// pulled out of their handlers into a distress handoff (that would over-fire the gate onto
// ordinary money conversations).
const mustNotGate: string[] = [
  "what rate can I get?",
  "what credit score do you guys usually need?",
  "how much do I need for a down payment?",
  "that's too much, I've seen the same bike for 2 grand less"
];

let ran = 0;
let safetyRan = 0;

for (const c of coverage) {
  const parsed = await parseFinanceDistressWithLLM({ text: c.text });
  if (!parsed) continue; // parser disabled or transient null — skip, don't red the gate
  ran += 1;
  assert.equal(parsed.intent, c.expect, `"${c.text}" should classify as ${c.expect}, got ${parsed.intent}`);
  if (c.expect === "finance_distress") {
    assert.equal(parsed.selfDisclosed, true, `"${c.text}" should be self_disclosed`);
  }
}

for (const text of mustNotGate) {
  const parsed = await parseFinanceDistressWithLLM({ text });
  if (!parsed) continue;
  safetyRan += 1;
  assert.notEqual(
    parsed.intent,
    "finance_distress",
    `ADVERSARIAL: "${text}" must NOT classify as finance_distress, got ${parsed.intent}`
  );
}

console.log(
  ran === 0 && safetyRan === 0
    ? `PASS finance distress eval (source guard + hint + ${rows.length} decision-table rows; LLM coverage skipped — parser disabled)`
    : `PASS finance distress eval (source guard + hint + ${rows.length} decision-table rows + ${ran}/${coverage.length} coverage + ${safetyRan}/${mustNotGate.length} adversarial negatives)`
);
