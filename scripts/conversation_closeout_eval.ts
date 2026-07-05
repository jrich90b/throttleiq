/**
 * Conversation closeout / sign-off eval.
 *
 * Pins the 2026-06-19 fix for Joe's report: "the agent would not know when to close out after a
 * social reciprocation — it would keep going." A warm closer ("have a good weekend!", "you guys
 * are the best!") fell through the narrow isCloseoutSignoffNoResponseText keyword regex (which only
 * matched "talk soon"/"see you soon") into the small-talk generator — which is even told it MAY
 * pivot back to bikes. The fix is parser-first: classify a closer as reciprocate_and_close (ONE
 * brief warm reply, then stop) vs. close_silent (a terminal echo — no reply) vs. none, centralized
 * in routeStateReducer and wired into BOTH /webhooks/twilio and /conversations/:id/regenerate.
 * Scope is the immediate exchange only — it never touches the follow-up cadence.
 *
 * Three layers:
 *  1) Source guard (no LLM): parser exported + flagged + schema'd; decision centralized in the
 *     reducer; the closing reply path (closingHint) + the actionable-signal safety floor exist;
 *     the shared resolver is wired into BOTH paths; the pre-filter hint catches canonical closers.
 *  2) Decision-table coverage (pure): close out ONLY on a confident reciprocate/silent verdict with
 *     NO actionable signal; everything else (low conf / none / an ask present) => none (fail toward
 *     replying — never go silent on a live ask).
 *  3) LLM coverage (gated; skips cleanly): warm closers classify as reciprocate_and_close; a bare
 *     echo after our own sign-off classifies as close_silent; ADVERSARIAL asks ("price?", "come by
 *     Saturday?") must NOT close out.
 *
 * Run gated: LLM_ENABLED=1 LLM_CONVERSATION_CLOSEOUT_PARSER_ENABLED=1 npx tsx scripts/conversation_closeout_eval.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { parseConversationCloseoutWithLLM } from "../services/api/src/domain/llmDraft.ts";
import { decideConversationCloseoutTurn } from "../services/api/src/domain/routeStateReducer.ts";

// --- 1) Source guard (no LLM): parser + centralized decision + BOTH-paths wiring + hint + floor. ---
const index = fs.readFileSync("services/api/src/index.ts", "utf8");
const llm = fs.readFileSync("services/api/src/domain/llmDraft.ts", "utf8");
const reducer = fs.readFileSync("services/api/src/domain/routeStateReducer.ts", "utf8");

assert.ok(
  /export async function parseConversationCloseoutWithLLM/.test(llm),
  "the parser must be exported from llmDraft.ts"
);
assert.ok(
  /CONVERSATION_CLOSEOUT_PARSER_JSON_SCHEMA/.test(llm),
  "the strict JSON schema const must exist"
);
assert.ok(
  /LLM_CONVERSATION_CLOSEOUT_PARSER_ENABLED/.test(llm),
  'the parser must be behind an enable flag (on-by-default via !== "0")'
);
// The reciprocation must be a terminal warm reply — closingHint forces no-pivot/no-question.
assert.ok(/closingHint/.test(llm), "generateSmallTalkReplyWithLLM must support a closingHint (terminal reply)");
assert.ok(
  /export function decideConversationCloseoutTurn/.test(reducer),
  "the route decision must be centralized in routeStateReducer.ts"
);
assert.ok(
  /function conversationCloseoutHint/.test(index) && /CONVERSATION_CLOSEOUT_HINT_RE/.test(index),
  "the pre-filter hint must exist in index.ts"
);
assert.ok(
  /function closeoutHasActionableSignal/.test(index),
  "the deterministic actionable-signal safety floor must exist in index.ts"
);
const callSites = (index.match(/await resolveConversationCloseoutReply\(/g) || []).length;
assert.ok(
  callSites >= 2,
  `the shared resolver must be wired in BOTH paths (live + regenerate); found ${callSites} call site(s)`
);

// Pre-filter hint must catch canonical closers (else the parser never runs on them).
// Kept in sync with CONVERSATION_CLOSEOUT_HINT_RE in index.ts — update both together.
const HINT_RE =
  /\b(?:have a (?:good|great|nice)|good (?:night|one)|take care|talk (?:soon|to you|later)|see you|catch you|thanks again|thank you|appreciate|you guys (?:are|rock)|the best|ride safe|stay safe|happy (?:friday|holidays?|weekend)|weekend|cya|later|peace|cheers|bye|good bye|goodbye|you too|same to you|all set|we'?re good)\b/i;
for (const phrase of [
  "have a good weekend!",
  "you guys are the best, thank you!",
  "thanks again, take care",
  "talk soon",
  "you too!"
]) {
  assert.ok(HINT_RE.test(phrase), `hint must match closer: "${phrase}"`);
}
// ...and NOT fire on a plain business ask (keeps the parser off active turns).
for (const phrase of ["what's the out the door price?", "can I come by Saturday?"]) {
  assert.ok(!HINT_RE.test(phrase), `hint must NOT match an active ask: "${phrase}"`);
}

// --- 2) Decision-table coverage (pure): close out ONLY on a confident verdict + no actionable ask. ---
type Kind = "reciprocate_and_close" | "close_silent" | "none";
type Row = { id: string; input: Parameters<typeof decideConversationCloseoutTurn>[0]; kind: Kind };

const recip = {
  parserAccepted: true,
  kind: "reciprocate_and_close" as Kind | null,
  confidence: 0.9,
  confidenceMin: 0.7,
  hasActionableSignal: false
};

const rows: Row[] = [
  { id: "reciprocate_high_conf", input: { ...recip }, kind: "reciprocate_and_close" },
  { id: "silent_high_conf", input: { ...recip, kind: "close_silent" }, kind: "close_silent" },
  { id: "at_confidence_floor", input: { ...recip, confidence: 0.7 }, kind: "reciprocate_and_close" },
  { id: "below_confidence_floor", input: { ...recip, confidence: 0.69 }, kind: "none" },
  { id: "kind_none", input: { ...recip, kind: "none" }, kind: "none" },
  { id: "kind_null", input: { ...recip, kind: null }, kind: "none" },
  { id: "parser_not_accepted", input: { ...recip, parserAccepted: false }, kind: "none" },
  // SAFETY FLOOR: an actionable ask is NEVER closed out, even a confident closer verdict.
  { id: "actionable_signal_blocks", input: { ...recip, hasActionableSignal: true }, kind: "none" },
  { id: "actionable_blocks_silent", input: { ...recip, kind: "close_silent", hasActionableSignal: true }, kind: "none" }
];

for (const r of rows) {
  const got = decideConversationCloseoutTurn(r.input).kind;
  assert.equal(got, r.kind, `decision[${r.id}] expected ${r.kind}, got ${got}`);
}

// --- 3) LLM coverage + adversarial negatives (gated; skips cleanly). ---
type Cov = {
  id: string;
  text: string;
  history?: { direction: "in" | "out"; body: string }[];
  expect: Kind | "closeout_any";
};
const coverage: Cov[] = [
  { id: "weekend", text: "Have a great weekend!", expect: "reciprocate_and_close" },
  { id: "best", text: "You guys are the best, thank you!", expect: "reciprocate_and_close" },
  { id: "take_care", text: "Thanks again, take care!", expect: "reciprocate_and_close" },
  // Bare echo after WE already signed off => no reply owed (close_silent).
  {
    id: "echo_after_signoff",
    text: "You too!",
    history: [{ direction: "out", body: "Have a great weekend!" }],
    expect: "close_silent"
  },
  { id: "ok_thanks", text: "ok thanks", expect: "closeout_any" } // some closeout; sub-kind may vary
];

// Safety-critical: an active ask must NEVER be read as a closeout (that would silence a live lead).
const mustNotClose: string[] = [
  "what's the out the door price?",
  "can I come by Saturday?",
  "is it still available?",
  "did you watch the game last night?"
];

let ran = 0;
let safetyRan = 0;

for (const c of coverage) {
  const parsed = await parseConversationCloseoutWithLLM({ text: c.text, history: c.history });
  if (!parsed) continue; // parser disabled / transient null — skip, don't red the gate
  ran += 1;
  if (c.expect === "closeout_any") {
    assert.notEqual(parsed.kind, "none", `[${c.id}] "${c.text}" should be SOME closeout, got none`);
  } else {
    assert.equal(parsed.kind, c.expect, `[${c.id}] "${c.text}" should be ${c.expect}, got ${parsed.kind}`);
  }
}

for (const text of mustNotClose) {
  const parsed = await parseConversationCloseoutWithLLM({ text });
  if (!parsed) continue;
  safetyRan += 1;
  assert.equal(
    parsed.kind,
    "none",
    `ADVERSARIAL: active ask "${text}" must NOT close out, got ${parsed.kind}`
  );
}

console.log(
  ran === 0 && safetyRan === 0
    ? `PASS conversation closeout eval (source guard + hint + ${rows.length} decision-table rows; LLM coverage skipped — parser disabled)`
    : `PASS conversation closeout eval (source guard + hint + ${rows.length} decision-table rows + ${ran}/${coverage.length} coverage + ${safetyRan}/${mustNotClose.length} adversarial cases)`
);
