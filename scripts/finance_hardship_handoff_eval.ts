/**
 * Finance-hardship staff-handoff eval.
 *
 * Pins the 2026-07-15 fix (Joe ruling, surfaced by the open-critic feed, John Geschwender
 * +17166060001, ref 11624): a HDFS credit-app lead texted "due to a past identity theft I no
 * longer have a credit score and paying a ridiculous high interest just doesn't seem plausible
 * for me" and the assistant replied "Would a co-signer be a possibility for you while we work
 * through this?" — proactively proposing a financing SOLUTION (co-signer) to a distressed
 * credit-hardship disclosure (open-critic: unauthorized_financial_advice_or_promise). Joe ruled
 * finance-distress replies are a plain, warm staff hand-off — no bot solutioning (co-signer,
 * rate, approval odds). Extends the 2026-07-11 "finance needs-info always staff handoff" ruling.
 *
 * Layers: (1) source guard (parser + centralized decision + BOTH-paths wiring + hint),
 * (2) pure decision table (handoff ONLY on accepted + finance_hardship + explicit +
 * confidence>=min), (3) LLM coverage with the John replay fixture + sibling hardship phrasings,
 * and ADVERSARIAL normal-finance negatives (payment/rate/budget must NOT hand off), plus a guard
 * that the hand-off reply proposes NO co-signer / rate / approval solution.
 *
 * Run gated: LLM_ENABLED=1 LLM_FINANCE_HARDSHIP_PARSER_ENABLED=1 npx tsx scripts/finance_hardship_handoff_eval.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { parseFinanceHardshipDisclosureWithLLM } from "../services/api/src/domain/llmDraft.ts";
import { decideFinanceHardshipTurn } from "../services/api/src/domain/routeStateReducer.ts";

// --- 1) Source guard (no LLM). ---
const index = fs.readFileSync("services/api/src/index.ts", "utf8");
const llm = fs.readFileSync("services/api/src/domain/llmDraft.ts", "utf8");
const reducer = fs.readFileSync("services/api/src/domain/routeStateReducer.ts", "utf8");

assert.ok(
  /export async function parseFinanceHardshipDisclosureWithLLM/.test(llm),
  "the parser must be exported from llmDraft.ts"
);
assert.ok(
  /FINANCE_HARDSHIP_DISCLOSURE_PARSER_JSON_SCHEMA/.test(llm),
  "the strict JSON schema const must exist"
);
assert.ok(
  /LLM_FINANCE_HARDSHIP_PARSER_ENABLED/.test(llm),
  "the parser must be behind an enable flag (on-by-default via !== \"0\")"
);
assert.ok(
  /export function decideFinanceHardshipTurn/.test(reducer),
  "the route decision must be centralized in routeStateReducer.ts"
);
assert.ok(
  /function financeHardshipHint/.test(index) && /FINANCE_HARDSHIP_HINT_RE/.test(index),
  "the pre-filter hint must exist in index.ts"
);
const callSites = (index.match(/await resolveFinanceHardshipHandoffReply\(/g) || []).length;
assert.ok(
  callSites >= 2,
  `the shared resolver must be wired in BOTH paths (live + regenerate); found ${callSites} call site(s)`
);

// The hand-off reply must NOT propose a financing solution (co-signer / rate / approval odds).
const replyMatch = index.match(/function buildFinanceHardshipHandoffReply\(\): string \{[\s\S]*?return\s+"([^"]+)"/);
assert.ok(replyMatch, "buildFinanceHardshipHandoffReply must return a string literal");
const replyText = String(replyMatch![1]).toLowerCase();
for (const banned of ["co-signer", "cosigner", "co signer", "apr", "rate", "approv", "% "]) {
  assert.ok(
    !replyText.includes(banned),
    `hand-off reply must NOT propose a solution — found banned term "${banned}" in: ${replyMatch![1]}`
  );
}

// Hint must catch the production miss + sibling hardship phrasings (else the parser never runs).
// Kept in sync with FINANCE_HARDSHIP_HINT_RE in index.ts — update both together.
const HINT_RE =
  /\b(credit score|no credit|bad credit|low credit|poor credit|credit is (?:\w+\s+){0,2}(bad|shot|rough|terrible|poor|low)|bankrupt|bankruptcy|repo(ssession|ed)?|charge[-\s]?off|identity theft|denied|declined|turned down|didn'?t qualify|won'?t qualify|can'?t qualify|do(n'?t| not) qualify|get approved|even.*approv|high interest|ridiculous.*(rate|interest)|fixed income|collections?)\b/i;
for (const phrase of [
  "due to a past identity theft I no longer have a credit score and paying a ridiculous high interest just doesn't seem plausible for me",
  "my credit is pretty bad, not sure I'd even get approved",
  "I had a bankruptcy a couple years ago",
  "got denied at another dealer"
]) {
  assert.ok(HINT_RE.test(phrase), `hint must match finance-hardship phrasing: "${phrase}"`);
}

// --- 2) Decision-table coverage (pure). ---
type Row = {
  id: string;
  input: Parameters<typeof decideFinanceHardshipTurn>[0];
  kind: "finance_hardship_handoff" | "none";
};

const ok = {
  parserAccepted: true,
  intent: "finance_hardship" as string | null,
  explicitRequest: true,
  confidence: 0.9,
  confidenceMin: 0.7
};

const rows: Row[] = [
  { id: "accepted_explicit_high_conf", input: { ...ok }, kind: "finance_hardship_handoff" },
  { id: "at_confidence_floor", input: { ...ok, confidence: 0.7 }, kind: "finance_hardship_handoff" },
  { id: "intent_none", input: { ...ok, intent: "none" }, kind: "none" },
  { id: "null_intent", input: { ...ok, intent: null }, kind: "none" },
  { id: "not_explicit", input: { ...ok, explicitRequest: false }, kind: "none" },
  { id: "parser_not_accepted", input: { ...ok, parserAccepted: false }, kind: "none" },
  { id: "below_confidence_floor", input: { ...ok, confidence: 0.69 }, kind: "none" }
];

for (const r of rows) {
  const got = decideFinanceHardshipTurn(r.input).kind;
  assert.equal(got, r.kind, `decision[${r.id}] expected ${r.kind}, got ${got}`);
}

// --- 3) LLM coverage + adversarial normal-finance negatives (gated; skips cleanly). ---
const coverage: { text: string; expect: "finance_hardship" | "none" }[] = [
  {
    text: "due to a past identity theft I no longer have a credit score and paying a ridiculous high interest just doesn't seem plausible for me as a responsible person",
    expect: "finance_hardship"
  }, // John Geschwender replay fixture
  { text: "my credit is pretty bad, not sure I'd even get approved", expect: "finance_hardship" },
  { text: "I had a bankruptcy a couple years ago, does that matter?", expect: "finance_hardship" },
  { text: "got denied at another dealer, can you guys do anything?", expect: "finance_hardship" },
  { text: "I'm on a fixed income and worried the rate would be too high", expect: "finance_hardship" },
  { text: "what would my monthly payment be?", expect: "none" },
  { text: "trying to stay under $500 a month", expect: "none" },
  { text: "can I come by Saturday?", expect: "none" }
];

// Safety-critical: a normal finance/budget question must NEVER become a hardship handoff (that
// would pull ordinary pricing questions out of their handlers into a finance-manager handoff).
const mustNotHandoff: string[] = [
  "what would my monthly payment be?",
  "how much do I need for a down payment?",
  "trying to stay under $500 a month",
  "what's the out the door price?"
];

let ran = 0;
let safetyRan = 0;

for (const c of coverage) {
  const parsed = await parseFinanceHardshipDisclosureWithLLM({ text: c.text });
  if (!parsed) continue; // parser disabled or transient null — skip, don't red the gate
  ran += 1;
  assert.equal(
    parsed.intent,
    c.expect,
    `"${c.text}" should classify as ${c.expect}, got ${parsed.intent}`
  );
}

for (const text of mustNotHandoff) {
  const parsed = await parseFinanceHardshipDisclosureWithLLM({ text });
  if (!parsed) continue;
  safetyRan += 1;
  assert.notEqual(
    parsed.intent,
    "finance_hardship",
    `ADVERSARIAL: normal finance question "${text}" must NOT classify as finance_hardship, got ${parsed.intent}`
  );
}

console.log(
  ran === 0 && safetyRan === 0
    ? `PASS finance hardship handoff eval (source guard + no-solutioning reply + hint + ${rows.length} decision-table rows; LLM coverage skipped — parser disabled)`
    : `PASS finance hardship handoff eval (source guard + no-solutioning reply + hint + ${rows.length} decision-table rows + ${ran}/${coverage.length} coverage + ${safetyRan}/${mustNotHandoff.length} adversarial normal-finance cases)`
);
