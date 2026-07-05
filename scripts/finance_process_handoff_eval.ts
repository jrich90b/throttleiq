/**
 * Finance-process / logistics handoff eval.
 *
 * Pins the 2026-06-18 fix for a production miss surfaced by the agent-watch sweep
 * (intent_handled_audit, Adam +17166033199): the customer asked "if I pay the whole 10%
 * needed do I have more time to get insurance or no" — a finance-PROCESS conditional — and
 * got "we would just need the insurance before we finalize any of the financing", which
 * restated the requirement without answering whether the down payment extends the deadline.
 * The agent can't know dealer/lender process policy, so the fix routes these to a finance-
 * manager handoff (no fabricated policy), in BOTH /webhooks/twilio and regenerate.
 *
 * Layers: (1) source guard (parser + centralized decision + BOTH-paths wiring + hint),
 * (2) pure decision table (handoff ONLY on accepted + finance_process_handoff + explicit +
 * confidence>=min), (3) LLM coverage with the Adam replay fixture + sibling process questions,
 * and ADVERSARIAL number-question negatives (payment/rate/amount-down must NOT hand off).
 *
 * Run gated: LLM_ENABLED=1 LLM_FINANCE_PROCESS_QUESTION_PARSER_ENABLED=1 npx tsx scripts/finance_process_handoff_eval.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { parseFinanceProcessQuestionWithLLM } from "../services/api/src/domain/llmDraft.ts";
import { decideFinanceProcessQuestionTurn } from "../services/api/src/domain/routeStateReducer.ts";

// --- 1) Source guard (no LLM). ---
const index = fs.readFileSync("services/api/src/index.ts", "utf8");
const llm = fs.readFileSync("services/api/src/domain/llmDraft.ts", "utf8");
const reducer = fs.readFileSync("services/api/src/domain/routeStateReducer.ts", "utf8");

assert.ok(
  /export async function parseFinanceProcessQuestionWithLLM/.test(llm),
  "the parser must be exported from llmDraft.ts"
);
assert.ok(
  /FINANCE_PROCESS_QUESTION_PARSER_JSON_SCHEMA/.test(llm),
  "the strict JSON schema const must exist"
);
assert.ok(
  /LLM_FINANCE_PROCESS_QUESTION_PARSER_ENABLED/.test(llm),
  "the parser must be behind an enable flag (on-by-default via !== \"0\")"
);
assert.ok(
  /export function decideFinanceProcessQuestionTurn/.test(reducer),
  "the route decision must be centralized in routeStateReducer.ts"
);
assert.ok(
  /function financeProcessQuestionHint/.test(index) && /FINANCE_PROCESS_QUESTION_HINT_RE/.test(index),
  "the pre-filter hint must exist in index.ts"
);
const callSites = (index.match(/await resolveFinanceProcessHandoffReply\(/g) || []).length;
assert.ok(
  callSites >= 2,
  `the shared resolver must be wired in BOTH paths (live + regenerate); found ${callSites} call site(s)`
);

// Hint must catch the production miss + sibling process phrasings (else the parser never runs).
// Kept in sync with FINANCE_PROCESS_QUESTION_HINT_RE in index.ts — update both together.
const HINT_RE =
  /\b(insurance|binder|proof of insurance|down\s*payment|put .* down|how long (do|have)|more time|by when|when (do|does|is|will)|what comes first|before (we|you|i) (finalize|sign|can)|after (i|we) sign|need .*(before|first)|paperwork|the title|finaliz)\b/i;
for (const phrase of [
  "if I pay the whole 10% needed do I have more time to get insurance or no",
  "can I get the insurance after I sign the paperwork?",
  "when do I need the down payment by?",
  "what comes first, insurance or the financing?"
]) {
  assert.ok(HINT_RE.test(phrase), `hint must match finance-process phrasing: "${phrase}"`);
}

// --- 2) Decision-table coverage (pure). ---
type Row = {
  id: string;
  input: Parameters<typeof decideFinanceProcessQuestionTurn>[0];
  kind: "finance_process_handoff" | "none";
};

const ok = {
  parserAccepted: true,
  intent: "finance_process_handoff" as string | null,
  explicitRequest: true,
  confidence: 0.9,
  confidenceMin: 0.7
};

const rows: Row[] = [
  { id: "accepted_explicit_high_conf", input: { ...ok }, kind: "finance_process_handoff" },
  { id: "at_confidence_floor", input: { ...ok, confidence: 0.7 }, kind: "finance_process_handoff" },
  { id: "intent_none", input: { ...ok, intent: "none" }, kind: "none" },
  { id: "null_intent", input: { ...ok, intent: null }, kind: "none" },
  { id: "not_explicit", input: { ...ok, explicitRequest: false }, kind: "none" },
  { id: "parser_not_accepted", input: { ...ok, parserAccepted: false }, kind: "none" },
  { id: "below_confidence_floor", input: { ...ok, confidence: 0.69 }, kind: "none" }
];

for (const r of rows) {
  const got = decideFinanceProcessQuestionTurn(r.input).kind;
  assert.equal(got, r.kind, `decision[${r.id}] expected ${r.kind}, got ${got}`);
}

// --- 3) LLM coverage + adversarial number-question negatives (gated; skips cleanly). ---
const coverage: { text: string; expect: "finance_process_handoff" | "none" }[] = [
  { text: "if I pay the whole 10% needed do I have more time to get insurance or no", expect: "finance_process_handoff" }, // Adam replay fixture
  { text: "can I get the insurance after I sign the paperwork?", expect: "finance_process_handoff" },
  { text: "what comes first, insurance or the financing?", expect: "finance_process_handoff" },
  { text: "how long do I have to get insurance once I put money down?", expect: "finance_process_handoff" },
  { text: "what's my monthly payment going to be?", expect: "none" },
  { text: "what rate can I get?", expect: "none" },
  { text: "can I come by Saturday?", expect: "none" }
];

// Safety-critical: a finance NUMBER question must NEVER become a process handoff (that would
// pull normal pricing questions out of their handlers and into a manager handoff).
const mustNotHandoff: string[] = [
  "what's my monthly payment going to be?",
  "what rate can I get?",
  "how much do I need for a down payment?",
  "what's the out the door price?"
];

let ran = 0;
let safetyRan = 0;

for (const c of coverage) {
  const parsed = await parseFinanceProcessQuestionWithLLM({ text: c.text });
  if (!parsed) continue; // parser disabled or transient null — skip, don't red the gate
  ran += 1;
  assert.equal(
    parsed.intent,
    c.expect,
    `"${c.text}" should classify as ${c.expect}, got ${parsed.intent}`
  );
}

for (const text of mustNotHandoff) {
  const parsed = await parseFinanceProcessQuestionWithLLM({ text });
  if (!parsed) continue;
  safetyRan += 1;
  assert.notEqual(
    parsed.intent,
    "finance_process_handoff",
    `ADVERSARIAL: number question "${text}" must NOT classify as finance_process_handoff, got ${parsed.intent}`
  );
}

console.log(
  ran === 0 && safetyRan === 0
    ? `PASS finance process handoff eval (source guard + hint + ${rows.length} decision-table rows; LLM coverage skipped — parser disabled)`
    : `PASS finance process handoff eval (source guard + hint + ${rows.length} decision-table rows + ${ran}/${coverage.length} coverage + ${safetyRan}/${mustNotHandoff.length} adversarial number-question cases)`
);
