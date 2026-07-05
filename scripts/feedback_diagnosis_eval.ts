/**
 * Feedback diagnosis eval — closed-loop Phase 2 (2026-06-24).
 *
 * Pins the diagnosis policy + that the report stays SHADOW (no code writes, no PRs):
 *  1) decideFeedbackDiagnosisAction decision table — VOICE → refine (never a routing change),
 *     SYSTEMIC COMPREHENSION → parser-fix candidate, SAFETY → already-gated, everything unsure →
 *     record_only (the fail-safe; n=1 / low-confidence never proposes code).
 *  2) Parser contract — the free-text rep reason is classified by a typed LLM parser (strict schema,
 *     flag-gated), never regex.
 *  3) Report is read-only — feedback_diagnosis_report.ts never writes the store, edits code, runs git,
 *     or opens a PR.
 *
 * Run: npx tsx scripts/feedback_diagnosis_eval.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { decideFeedbackDiagnosisAction } from "../services/api/src/domain/routeStateReducer.ts";

// conversationStore hydrates a store on import — point it at a temp dir so it never touches prod data.
process.env.CONVERSATIONS_DB_PATH =
  process.env.CONVERSATIONS_DB_PATH || path.join(os.tmpdir(), `feedback-diag-eval-${Date.now()}.json`);
const { isUnansweredInboundConversation } = await import("../services/api/src/domain/conversationStore.ts");

// --- 1) Pure decision table. ---
type Row = { id: string; input: Parameters<typeof decideFeedbackDiagnosisAction>[0]; action: string };
const base = { parserAccepted: true, systemic: true, confidence: 0.9, confidenceMin: 0.7 };
const rows: Row[] = [
  { id: "no_parse", input: { ...base, parserAccepted: false, layer: "comprehension" }, action: "record_only" },
  { id: "low_conf", input: { ...base, layer: "comprehension", confidence: 0.5 }, action: "record_only" },
  { id: "safety", input: { ...base, layer: "safety" }, action: "already_gated" },
  { id: "voice", input: { ...base, layer: "voice" }, action: "voice_refinement" },
  { id: "comprehension_systemic", input: { ...base, layer: "comprehension" }, action: "parser_fix_candidate" },
  { id: "comprehension_oneoff", input: { ...base, layer: "comprehension", systemic: false }, action: "record_only" },
  { id: "none_layer", input: { ...base, layer: "none" }, action: "record_only" },
  { id: "at_floor_voice", input: { ...base, layer: "voice", confidence: 0.7 }, action: "voice_refinement" }
];
for (const r of rows) {
  const a = decideFeedbackDiagnosisAction(r.input);
  assert.equal(a, r.action, `decideFeedbackDiagnosisAction[${r.id}] expected ${r.action}, got ${a}`);
}
// A voice miss must NEVER escalate to a parser fix (the de-tangle guard: tone is not a routing change).
assert.notEqual(
  decideFeedbackDiagnosisAction({ ...base, layer: "voice" }),
  "parser_fix_candidate",
  "a voice/tone thumbs-down must not become a parser/routing fix"
);

// --- 2) Parser contract. ---
const llm = fs.readFileSync("services/api/src/domain/llmDraft.ts", "utf8");
assert.match(llm, /export async function parseFeedbackFailureModeWithLLM/, "the failure-mode parser must be exported");
assert.match(llm, /FEEDBACK_FAILURE_MODE_JSON_SCHEMA/, "the strict JSON schema must exist");
assert.match(llm, /LLM_FEEDBACK_FAILURE_MODE_PARSER_ENABLED/, "the parser must be flag-gated");
assert.match(llm, /schemaName: "feedback_failure_mode_parser"/, "the parser must use structured JSON output");

// --- 3) Report is read-only (shadow). ---
const report = fs.readFileSync("scripts/feedback_diagnosis_report.ts", "utf8");
assert.match(report, /decideFeedbackDiagnosisAction/, "report uses the central policy");
assert.match(report, /parseFeedbackFailureModeWithLLM/, "report classifies via the typed parser");
assert.match(report, /REPORT-ONLY/i, "report documents itself as shadow/report-only");
for (const sideEffect of [/writeFileSync|writeFile\(|appendFile/, /child_process|execSync|spawn/, /gh pr|git push|git commit/]) {
  assert.ok(!sideEffect.test(report), `the Phase 2 report must have NO side effects (${sideEffect})`);
}

// --- 4) Auto-run wiring: the nightly loop runs the report (so the digest is produced on a schedule). ---
const nightly = fs.readFileSync("scripts/feedback_loop_nightly.sh", "utf8");
assert.match(nightly, /feedback_diagnosis:report/, "the nightly feedback loop must run the diagnosis report (auto-run)");
assert.match(nightly, /step=feedback_diagnosis_report/, "the nightly loop must log the diagnosis step");
assert.match(nightly, /FEEDBACK_LOOP_API_ENV/, "the nightly loop must load OPENAI_API_KEY (LLM steps need it)");

// --- 5) Silence / no-reply detection (the thumbs-down blind spot). ---
const mk = (msgs: any[], extra: any = {}) => ({ messages: msgs, ...extra });
assert.equal(
  isUnansweredInboundConversation(mk([{ direction: "out", provider: "twilio", body: "hi" }, { direction: "in", body: "Ok sure" }])),
  true,
  "customer spoke last with nothing waiting = unanswered"
);
assert.equal(
  isUnansweredInboundConversation(mk([{ direction: "in", body: "Ok sure" }, { direction: "out", provider: "twilio", body: "great, what's your budget?" }])),
  false,
  "we replied last = answered"
);
assert.equal(
  isUnansweredInboundConversation(mk([{ direction: "in", body: "Ok sure" }, { direction: "out", provider: "draft_ai", draftStatus: "pending", body: "draft waiting" }])),
  false,
  "a pending draft is waiting for the rep = not silence"
);
assert.equal(
  isUnansweredInboundConversation(mk([{ direction: "in", body: "Ok sure" }], { draftHeld: { reason: "context_fidelity_out_of_context" } })),
  false,
  "a held draft is its OWN bucket, not 'unanswered'"
);
assert.equal(
  isUnansweredInboundConversation(mk([{ direction: "in", body: "Ok sure" }], { closedReason: "sold" })),
  false,
  "closed/sold conversations expect no reply"
);
assert.equal(isUnansweredInboundConversation(mk([])), false, "no messages = not unanswered");

// --- 6) Source guards: the report surfaces silence; an operator draft clears the held marker. ---
assert.match(report, /isUnansweredInboundConversation/, "the report must surface unanswered-inbound silence");
assert.match(report, /SILENCE \/ NO-REPLY/, "the report must have a silence section");
assert.match(report, /held drafts/, "the report must count held drafts separately");
const store = fs.readFileSync("services/api/src/domain/conversationStore.ts", "utf8");
assert.match(store, /export function isUnansweredInboundConversation/, "the silence predicate must be exported");
assert.match(
  store,
  /if \(\(conv as any\)\.draftHeld\) \(conv as any\)\.draftHeld = null;/,
  "saveOperatorDraft must clear a stale held marker"
);

console.log("PASS feedback diagnosis eval (decision table + parser contract + report-only + nightly + silence)");
