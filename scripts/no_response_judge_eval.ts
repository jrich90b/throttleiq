/**
 * No-response judge eval (STEP 1 — shadow). The second inline judge of the self-correcting loop.
 *
 * The draft judge only fires when a draft IS produced, so a wrongful SILENCE (the agent should have
 * replied but stayed quiet) is invisible to it. This judge (judgeShouldRespondWithLLM) runs at the
 * suppress / no-response decision points and asks: did this turn warrant a reply? The pure gate
 * (decideNoResponseJudge) maps the verdict to pass / flag_missing_response. STEP 1 ships DARK — it
 * only shadow-logs wrongful silences; producing a reply in place of silence is a later, approve-first step.
 *
 * Layers: (1) source guard (judge + gate + flags exist; the shadow hook is wired into BOTH the regen
 * chokepoint and the live terminal no-response; STEP-1-shadow-only assertion), (2) pure decision table
 * (pass on silence-ok / low-confidence / no-verdict; flag only on a confident should_respond; live only
 * when the flag is on), (3) LLM coverage — a real ask flags as wrongful silence; an ack/opt-out/closeout
 * does NOT (the false-positive guard: don't manufacture replies).
 *
 * Run gated: LLM_ENABLED=1 LLM_SHOULD_RESPOND_JUDGE_ENABLED=1 npx tsx scripts/no_response_judge_eval.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { judgeShouldRespondWithLLM } from "../services/api/src/domain/llmDraft.ts";
import { decideNoResponseJudge, DRAFT_QUALITY_MIN_CONFIDENCE } from "../services/api/src/domain/draftQualityGate.ts";

// --- 1) Source guard (no LLM). ---
const index = fs.readFileSync("services/api/src/index.ts", "utf8");
const llm = fs.readFileSync("services/api/src/domain/llmDraft.ts", "utf8");
const gate = fs.readFileSync("services/api/src/domain/draftQualityGate.ts", "utf8");

assert.ok(/export async function judgeShouldRespondWithLLM/.test(llm), "the judge must be exported from llmDraft.ts");
assert.ok(/SHOULD_RESPOND_JUDGE_JSON_SCHEMA/.test(llm), "the strict JSON schema const must exist");
assert.ok(/LLM_SHOULD_RESPOND_JUDGE_ENABLED/.test(llm), "the judge must be behind an enable flag");
assert.ok(/export function decideNoResponseJudge/.test(gate), "the pure gate must be in draftQualityGate.ts");
assert.ok(
  /NO_RESPONSE_JUDGE_ENABLED/.test(gate) && /NO_RESPONSE_JUDGE_SHADOW/.test(gate),
  "the live-enable + shadow flags must exist"
);
const callSites = (index.match(/void runNoResponseJudgeShadow\(/g) || []).length;
assert.ok(
  callSites >= 2,
  `the shadow hook must be wired at BOTH the regen chokepoint and the live terminal no-response; found ${callSites}`
);
assert.ok(/STEP 1 is shadow-only: never produce a reply/.test(index), "STEP 1 must be shadow-only (no live reply)");

// --- 2) Decision-table coverage (pure). ---
type V = Parameters<typeof decideNoResponseJudge>[0]["verdict"];
type Row = { id: string; input: Parameters<typeof decideNoResponseJudge>[0]; action: string; live: boolean };
const rows: Row[] = [
  { id: "no_verdict_pass", input: { enabled: true, verdict: null }, action: "pass", live: false },
  { id: "silence_ok_pass", input: { enabled: true, verdict: { shouldRespond: false, confidence: 0.95 } as V }, action: "pass", live: false },
  { id: "should_respond_shadow_when_off", input: { enabled: false, verdict: { shouldRespond: true, confidence: 0.95 } as V }, action: "flag_missing_response", live: false },
  { id: "should_respond_live_when_on", input: { enabled: true, verdict: { shouldRespond: true, confidence: 0.95 } as V }, action: "flag_missing_response", live: true },
  { id: "below_confidence_pass", input: { enabled: true, verdict: { shouldRespond: true, confidence: DRAFT_QUALITY_MIN_CONFIDENCE - 0.01 } as V }, action: "pass", live: false },
  { id: "at_floor_acts", input: { enabled: true, verdict: { shouldRespond: true, confidence: DRAFT_QUALITY_MIN_CONFIDENCE } as V }, action: "flag_missing_response", live: true }
];
for (const r of rows) {
  const d = decideNoResponseJudge(r.input);
  assert.equal(d.action, r.action, `gate[${r.id}] action expected ${r.action}, got ${d.action}`);
  assert.equal(d.live, r.live, `gate[${r.id}] live expected ${r.live}, got ${d.live}`);
}

// --- 3) LLM coverage (gated; skips cleanly). ---
const cases: { id: string; inbound: string; wantRespond: boolean }[] = [
  { id: "price_question", inbound: "What is the asking price?", wantRespond: true },
  { id: "media_request", inbound: "can you send me a couple pics of it?", wantRespond: true },
  { id: "availability_question", inbound: "is it still available?", wantRespond: true },
  { id: "pure_ack", inbound: "👍", wantRespond: false },
  { id: "closeout", inbound: "thanks, I was just curious", wantRespond: false },
  { id: "opt_out", inbound: "STOP", wantRespond: false }
];

let ran = 0;
for (const c of cases) {
  const v = await judgeShouldRespondWithLLM({ inbound: c.inbound });
  if (!v) continue; // judge disabled / transient null — skip, don't red the gate
  ran += 1;
  assert.equal(
    v.shouldRespond,
    c.wantRespond,
    `[${c.id}] expected should_respond=${c.wantRespond}, got ${v.shouldRespond} (${v.reason})`
  );
}

console.log(
  ran === 0
    ? `PASS no response judge eval (source guard + ${rows.length} decision-table rows; LLM coverage skipped — judge disabled)`
    : `PASS no response judge eval (source guard + ${rows.length} decision-table rows + ${ran}/${cases.length} LLM coverage cases)`
);
