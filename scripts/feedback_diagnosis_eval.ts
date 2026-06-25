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
import { decideFeedbackDiagnosisAction } from "../services/api/src/domain/routeStateReducer.ts";

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

console.log("PASS feedback diagnosis eval (decision table + parser contract + report-only guard + nightly wiring)");
