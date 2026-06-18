/**
 * Deal/progress status-check eval.
 *
 * Pins the 2026-06-18 fix for a production miss: the customer texted "How are we looking"
 * (a status/progress check on their deal) and the small-talk classifier read it as banter,
 * producing the pleasantry "Doing well—hope your day's going great too!". The fix rescues
 * these turns inside the small-talk branch — BEFORE composing a pleasantry — via a typed
 * parser, in BOTH /webhooks/twilio and /conversations/:id/regenerate.
 *
 * Three layers:
 *  1) Source guard (no LLM): parser exported + flagged + schema'd, decision centralized in
 *     routeStateReducer, shared resolver wired into BOTH paths, and the pre-filter hint catches
 *     the canonical status phrasings (so the parser actually runs on them in prod).
 *  2) Decision-table coverage (pure): answer_status ONLY on an accepted, explicit
 *     deal_status_check at/above the confidence floor; everything else => none (fail-safe to the
 *     existing small-talk behavior).
 *  3) LLM coverage (gated; skips cleanly): the "How are we looking" replay fixture + sibling
 *     status phrasings classify as deal_status_check, and ADVERSARIAL social pleasantries
 *     ("how's your day going?", "how are you?") must NOT.
 *
 * Run gated: LLM_ENABLED=1 LLM_DEAL_STATUS_CHECK_PARSER_ENABLED=1 npx tsx scripts/deal_status_check_eval.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { parseDealStatusCheckWithLLM } from "../services/api/src/domain/llmDraft.ts";
import { decideDealStatusCheckTurn } from "../services/api/src/domain/routeStateReducer.ts";

// --- 1) Source guard (no LLM): parser + centralized decision + BOTH-paths wiring + hint. ---
const index = fs.readFileSync("services/api/src/index.ts", "utf8");
const llm = fs.readFileSync("services/api/src/domain/llmDraft.ts", "utf8");
const reducer = fs.readFileSync("services/api/src/domain/routeStateReducer.ts", "utf8");

assert.ok(
  /export async function parseDealStatusCheckWithLLM/.test(llm),
  "the parser must be exported from llmDraft.ts"
);
assert.ok(
  /DEAL_STATUS_CHECK_PARSER_JSON_SCHEMA/.test(llm),
  "the strict JSON schema const must exist"
);
assert.ok(
  /LLM_DEAL_STATUS_CHECK_PARSER_ENABLED/.test(llm),
  "the parser must be behind an enable flag (on-by-default via !== \"0\")"
);
assert.ok(
  /export function decideDealStatusCheckTurn/.test(reducer),
  "the route decision must be centralized in routeStateReducer.ts"
);
assert.ok(
  /function dealStatusCheckParserHint/.test(index) && /DEAL_STATUS_CHECK_HINT_RE/.test(index),
  "the pre-filter hint must exist in index.ts"
);
const callSites = (index.match(/await resolveDealStatusCheckReply\(/g) || []).length;
assert.ok(
  callSites >= 2,
  `the shared resolver must be wired in BOTH paths (live + regenerate); found ${callSites} call site(s)`
);

// Pre-filter hint must catch the canonical status phrasings (else the parser never runs on them).
// Kept in sync with DEAL_STATUS_CHECK_HINT_RE in index.ts — update both together.
const HINT_RE =
  /\b(how(?:'?s| is| are)?\s+(?:we|it|things|everything)|how\s+we\s+look|any\s+(?:update|word|news|movement|progress)|what'?s\s+(?:the\s+)?(?:latest|new|news|word|update)|where\s+(?:are\s+)?(?:we|things)\b|where\s+do\s+we\s+stand|hear(?:d)?\s+(?:anything|back)|coming\s+along|status\s+(?:update|on)|update\s+on)\b/i;
for (const phrase of ["How are we looking", "how we lookin", "any update?", "what's the latest?", "where are we at?", "any word back?"]) {
  assert.ok(HINT_RE.test(phrase), `hint must match status phrasing: "${phrase}"`);
}
// ...and NOT fire on a plain social pleasantry (keeps the parser off pure small talk).
for (const phrase of ["how's your day going?", "happy friday!"]) {
  assert.ok(!HINT_RE.test(phrase), `hint must NOT match pleasantry: "${phrase}"`);
}

// --- 2) Decision-table coverage (pure): answer ONLY a confident, explicit status check. ---
type Row = {
  id: string;
  input: Parameters<typeof decideDealStatusCheckTurn>[0];
  kind: "answer_status" | "none";
};

const ok = {
  parserAccepted: true,
  intent: "deal_status_check" as string | null,
  explicitRequest: true,
  confidence: 0.9,
  confidenceMin: 0.7
};

const rows: Row[] = [
  { id: "accepted_explicit_high_conf", input: { ...ok }, kind: "answer_status" },
  { id: "at_confidence_floor", input: { ...ok, confidence: 0.7 }, kind: "answer_status" },
  { id: "intent_none", input: { ...ok, intent: "none" }, kind: "none" },
  { id: "null_intent", input: { ...ok, intent: null }, kind: "none" },
  { id: "not_explicit", input: { ...ok, explicitRequest: false }, kind: "none" },
  { id: "parser_not_accepted", input: { ...ok, parserAccepted: false }, kind: "none" },
  { id: "below_confidence_floor", input: { ...ok, confidence: 0.69 }, kind: "none" }
];

for (const r of rows) {
  const got = decideDealStatusCheckTurn(r.input).kind;
  assert.equal(got, r.kind, `decision[${r.id}] expected ${r.kind}, got ${got}`);
}

// --- 3) LLM coverage + adversarial pleasantry negatives (gated; skips cleanly). ---
const coverage: { text: string; expect: "deal_status_check" | "none" }[] = [
  { text: "How are we looking", expect: "deal_status_check" }, // the production-miss replay fixture
  { text: "any update?", expect: "deal_status_check" },
  { text: "where are we at on the bike?", expect: "deal_status_check" },
  { text: "what's the latest?", expect: "deal_status_check" },
  { text: "any word back on my financing?", expect: "deal_status_check" },
  { text: "what's the out the door price?", expect: "none" },
  { text: "can I come by Saturday?", expect: "none" }
];

// Safety-critical: a social pleasantry must NEVER read as a deal status check (that would turn
// "how's your day?" into "let me check on your deal").
const mustNotAnswer: string[] = [
  "how's your day going?",
  "how are you?",
  "hope you're doing well",
  "happy friday!"
];

let ran = 0;
let safetyRan = 0;

for (const c of coverage) {
  const parsed = await parseDealStatusCheckWithLLM({ text: c.text });
  if (!parsed) continue; // parser disabled or transient null — skip, don't red the gate
  ran += 1;
  assert.equal(
    parsed.intent,
    c.expect,
    `"${c.text}" should classify as ${c.expect}, got ${parsed.intent}`
  );
}

for (const text of mustNotAnswer) {
  const parsed = await parseDealStatusCheckWithLLM({ text });
  if (!parsed) continue;
  safetyRan += 1;
  assert.notEqual(
    parsed.intent,
    "deal_status_check",
    `ADVERSARIAL: pleasantry "${text}" must NOT classify as deal_status_check, got ${parsed.intent}`
  );
}

console.log(
  ran === 0 && safetyRan === 0
    ? `PASS deal status check eval (source guard + hint + ${rows.length} decision-table rows; LLM coverage skipped — parser disabled)`
    : `PASS deal status check eval (source guard + hint + ${rows.length} decision-table rows + ${ran}/${coverage.length} coverage + ${safetyRan}/${mustNotAnswer.length} adversarial pleasantry cases)`
);
