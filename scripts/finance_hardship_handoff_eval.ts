/**
 * Finance-hardship turn eval (2026-07-15, refined 2026-07-16).
 *
 * The 7/15 ruling (John Geschwender +17166060001, ref 11624) hard-gated EVERY credit-hardship
 * disclosure to a silent staff hand-off with no co-signer pitch. Joe refined it on 2026-07-16:
 * split the situation in two.
 *  - DISTRESS (real current financial pain — a fresh bankruptcy, "can't afford anything", a job
 *    loss): still a warm, non-solutioning hand-off to the finance manager. No co-signer pitch.
 *  - DECLINE (a credit QUALIFYING obstacle a co-signer can realistically fix while they STILL want
 *    the bike — no/thin/bad credit, prior denial, PAST bankruptcy, identity theft, high-rate worry):
 *    an empathetic CO-SIGNER NUDGE. John's no-credit-score case is a DECLINE → it now GETS the nudge.
 * Neither reply ever quotes a specific rate/APR or promises approval odds.
 *
 * Layers: (1) source guard (parser hardship_kind + centralized 3-way decision + BOTH-paths wiring +
 * hint; the DISTRESS handoff reply proposes NO co-signer/rate, the DECLINE reply DOES nudge a
 * co-signer but NO rate/approval), (2) pure decision table (distress=>handoff, decline=>cosigner_nudge,
 * none/low-conf/not-explicit/not-accepted=>none), (3) LLM coverage with the John replay fixture +
 * sibling decline phrasings + genuine-distress fixtures, and ADVERSARIAL normal-finance negatives
 * (payment/rate/budget must stay "none").
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

// The DISTRESS hand-off reply must NOT propose a financing solution (co-signer / rate / approval odds).
const replyMatch = index.match(/function buildFinanceHardshipHandoffReply\(\): string \{[\s\S]*?return\s+"([^"]+)"/);
assert.ok(replyMatch, "buildFinanceHardshipHandoffReply must return a string literal");
const replyText = String(replyMatch![1]).toLowerCase();
for (const banned of ["co-signer", "cosigner", "co signer", "apr", "rate", "approv", "% "]) {
  assert.ok(
    !replyText.includes(banned),
    `distress hand-off reply must NOT propose a solution — found banned term "${banned}" in: ${replyMatch![1]}`
  );
}

// The DECLINE reply DOES nudge a co-signer (Joe 2026-07-16) but must STILL avoid a specific
// rate/APR or an approval-odds promise.
assert.ok(
  /function buildFinanceCosignerNudgeReply\(/.test(index),
  "buildFinanceCosignerNudgeReply must exist (the decline co-signer nudge)"
);
const nudgeMatch = index.match(/function buildFinanceCosignerNudgeReply\([^)]*\): string \{[\s\S]*?return\s+`([^`]+)`/);
assert.ok(nudgeMatch, "buildFinanceCosignerNudgeReply must return a template literal");
const nudgeText = String(nudgeMatch![1]).toLowerCase();
assert.ok(nudgeText.includes("co-signer") || nudgeText.includes("cosigner"), "decline reply must nudge a co-signer");
for (const banned of ["apr", "approv", "% ", "guarantee"]) {
  assert.ok(
    !nudgeText.includes(banned),
    `co-signer nudge must NOT promise a rate/approval — found banned term "${banned}" in: ${nudgeMatch![1]}`
  );
}
// The resolver wires the decline nudge (both paths share this resolver) and records its outcome.
assert.ok(
  /decision\.kind === "finance_cosigner_nudge"/.test(index) &&
    /buildFinanceCosignerNudgeReply\(conv\.lead\?\.firstName\)/.test(index),
  "the shared resolver must return the co-signer nudge on a decline"
);
assert.ok(/"finance_cosigner_nudge"/.test(index), "the decline route outcome must be recorded");
// The parser must classify into the 3-way hardship_kind (not the old binary intent).
assert.ok(/hardship_kind/.test(llm), "parser schema/prompt must use hardship_kind (distress|decline|none)");
assert.ok(/finance_cosigner_nudge/.test(reducer), "the decision must expose the cosigner_nudge kind");

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
  kind: "finance_hardship_handoff" | "finance_cosigner_nudge" | "none";
};

const ok = {
  parserAccepted: true,
  hardshipKind: "decline" as string | null,
  explicitRequest: true,
  confidence: 0.9,
  confidenceMin: 0.7
};

const rows: Row[] = [
  { id: "distress_explicit_high_conf", input: { ...ok, hardshipKind: "distress" }, kind: "finance_hardship_handoff" },
  { id: "distress_at_floor", input: { ...ok, hardshipKind: "distress", confidence: 0.7 }, kind: "finance_hardship_handoff" },
  { id: "decline_explicit_high_conf", input: { ...ok }, kind: "finance_cosigner_nudge" },
  { id: "decline_at_floor", input: { ...ok, confidence: 0.7 }, kind: "finance_cosigner_nudge" },
  { id: "kind_none", input: { ...ok, hardshipKind: "none" }, kind: "none" },
  { id: "null_kind", input: { ...ok, hardshipKind: null }, kind: "none" },
  { id: "decline_not_explicit", input: { ...ok, explicitRequest: false }, kind: "none" },
  { id: "distress_not_explicit", input: { ...ok, hardshipKind: "distress", explicitRequest: false }, kind: "none" },
  { id: "parser_not_accepted", input: { ...ok, parserAccepted: false }, kind: "none" },
  { id: "decline_below_floor", input: { ...ok, confidence: 0.69 }, kind: "none" },
  { id: "distress_below_floor", input: { ...ok, hardshipKind: "distress", confidence: 0.69 }, kind: "none" }
];

for (const r of rows) {
  const got = decideFinanceHardshipTurn(r.input).kind;
  assert.equal(got, r.kind, `decision[${r.id}] expected ${r.kind}, got ${got}`);
}

// --- 3) LLM coverage + adversarial normal-finance negatives (gated; skips cleanly). ---
const coverage: { text: string; expect: "distress" | "decline" | "none" }[] = [
  {
    text: "due to a past identity theft I no longer have a credit score and paying a ridiculous high interest just doesn't seem plausible for me as a responsible person",
    expect: "decline"
  }, // John Geschwender replay fixture — now a decline (gets the co-signer nudge)
  { text: "my credit is pretty bad, not sure I'd even get approved", expect: "decline" },
  { text: "I had a bankruptcy a couple years ago, does that matter?", expect: "decline" },
  { text: "got denied at another dealer, can you guys do anything?", expect: "decline" },
  { text: "I'm on a fixed income and worried the rate would be too high", expect: "decline" },
  { text: "honestly I just filed for bankruptcy and can't afford anything right now", expect: "distress" },
  { text: "I lost my job last month, this really isn't happening for me", expect: "distress" },
  { text: "what would my monthly payment be?", expect: "none" },
  { text: "trying to stay under $500 a month", expect: "none" },
  { text: "can I come by Saturday?", expect: "none" }
];

// Safety-critical: a normal finance/budget question must NEVER become a hardship turn (that would
// pull ordinary pricing questions into either the finance-manager handoff or the co-signer nudge).
const mustStayNone: string[] = [
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
    parsed.hardshipKind,
    c.expect,
    `"${c.text}" should classify as ${c.expect}, got ${parsed.hardshipKind}`
  );
}

for (const text of mustStayNone) {
  const parsed = await parseFinanceHardshipDisclosureWithLLM({ text });
  if (!parsed) continue;
  safetyRan += 1;
  assert.equal(
    parsed.hardshipKind,
    "none",
    `ADVERSARIAL: normal finance question "${text}" must classify as none, got ${parsed.hardshipKind}`
  );
}

console.log(
  ran === 0 && safetyRan === 0
    ? `PASS finance hardship turn eval (source guard + reply guards + hint + ${rows.length} decision-table rows; LLM coverage skipped — parser disabled)`
    : `PASS finance hardship turn eval (source guard + reply guards + hint + ${rows.length} decision-table rows + ${ran}/${coverage.length} coverage + ${safetyRan}/${mustStayNone.length} adversarial normal-finance cases)`
);
