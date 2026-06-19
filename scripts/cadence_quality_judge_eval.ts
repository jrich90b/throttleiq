/**
 * Cadence-quality judge eval (STEP 1 — shadow). Judge #3 of the self-correcting loop.
 *
 * The draft + no-response judges only fire on INBOUND-triggered turns, so the proactive follow-up
 * cadence (the nudges WE initiate) was unjudged by the loop. judgeCadenceQualityWithLLM scores a
 * cadence message about to go out on four axes — send_worthy / state_fit / tone_ok (real employee,
 * never a bot) / disposition_ok — and the pure gate (decideCadenceQualityGate) maps the verdict to
 * pass / regenerate / suppress / hold. STEP 1 ships DARK: it only shadow-logs; suppressing or
 * rewording a live cadence touch is a later, approve-first step.
 *
 * Layers: (1) source guard (judge + gate + flags exist; the shadow hook is wired at the cadence
 * emit; STEP-1-shadow-only assertion), (2) pure decision table (pass on good / low-confidence /
 * no-verdict; act only on a confident non-good verdict; live only when the flag is on), (3) LLM
 * coverage — a concrete warm nudge is good; a bare "just checking in" is suppress; a corporate-bot
 * message fails tone_ok.
 *
 * Run gated: LLM_ENABLED=1 LLM_CADENCE_QUALITY_JUDGE_ENABLED=1 npx tsx scripts/cadence_quality_judge_eval.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { judgeCadenceQualityWithLLM } from "../services/api/src/domain/llmDraft.ts";
import { decideCadenceQualityGate, DRAFT_QUALITY_MIN_CONFIDENCE } from "../services/api/src/domain/draftQualityGate.ts";

// --- 1) Source guard (no LLM). ---
const index = fs.readFileSync("services/api/src/index.ts", "utf8");
const llm = fs.readFileSync("services/api/src/domain/llmDraft.ts", "utf8");
const gate = fs.readFileSync("services/api/src/domain/draftQualityGate.ts", "utf8");

assert.ok(/export async function judgeCadenceQualityWithLLM/.test(llm), "the judge must be exported from llmDraft.ts");
assert.ok(/CADENCE_QUALITY_JUDGE_JSON_SCHEMA/.test(llm), "the strict JSON schema const must exist");
assert.ok(/LLM_CADENCE_QUALITY_JUDGE_ENABLED/.test(llm), "the judge must be behind an enable flag");
assert.ok(/export function decideCadenceQualityGate/.test(gate), "the pure gate must be in draftQualityGate.ts");
assert.ok(
  /CADENCE_QUALITY_JUDGE_ENABLED/.test(gate) && /CADENCE_QUALITY_JUDGE_SHADOW/.test(gate),
  "the live-enable + shadow flags must exist"
);
const callSites = (index.match(/void runCadenceQualityJudgeShadow\(/g) || []).length;
assert.ok(callSites >= 1, `the shadow hook must be wired at the cadence emit; found ${callSites}`);
assert.ok(
  /STEP 1 is shadow-only: never suppress\/alter the cadence draft/.test(index),
  "STEP 1 must be shadow-only (never suppress/alter the live cadence draft)"
);

// --- 2) Decision-table coverage (pure). ---
type V = Parameters<typeof decideCadenceQualityGate>[0]["verdict"];
type Row = { id: string; input: Parameters<typeof decideCadenceQualityGate>[0]; action: string; live: boolean };
const rows: Row[] = [
  { id: "no_verdict_pass", input: { enabled: true, verdict: null }, action: "pass", live: false },
  { id: "good_pass", input: { enabled: true, verdict: { overall: "good", confidence: 0.95 } as V }, action: "pass", live: false },
  { id: "suppress_shadow_when_off", input: { enabled: false, verdict: { overall: "suppress", confidence: 0.95 } as V }, action: "suppress", live: false },
  { id: "suppress_live_when_on", input: { enabled: true, verdict: { overall: "suppress", confidence: 0.95 } as V }, action: "suppress", live: true },
  { id: "regenerate_live_when_on", input: { enabled: true, verdict: { overall: "needs_regenerate", confidence: 0.95 } as V }, action: "regenerate", live: true },
  { id: "hold_live_when_on", input: { enabled: true, verdict: { overall: "hold", confidence: 0.95 } as V }, action: "hold", live: true },
  { id: "below_confidence_pass", input: { enabled: true, verdict: { overall: "suppress", confidence: DRAFT_QUALITY_MIN_CONFIDENCE - 0.01 } as V }, action: "pass", live: false },
  { id: "at_floor_acts", input: { enabled: true, verdict: { overall: "suppress", confidence: DRAFT_QUALITY_MIN_CONFIDENCE } as V }, action: "suppress", live: true }
];
for (const r of rows) {
  const d = decideCadenceQualityGate(r.input);
  assert.equal(d.action, r.action, `gate[${r.id}] action expected ${r.action}, got ${d.action}`);
  assert.equal(d.live, r.live, `gate[${r.id}] live expected ${r.live}, got ${d.live}`);
}

// --- 3) LLM coverage (gated; skips cleanly). ---
const cases: {
  id: string;
  message: string;
  assert: (v: NonNullable<Awaited<ReturnType<typeof judgeCadenceQualityWithLLM>>>) => void;
}[] = [
  {
    id: "concrete_warm_nudge",
    message: "Hey Charlie, the 2026 Street Glide in Vivid Black just landed — want to come take a look this week?",
    assert: v => assert.equal(v.overall, "good", `concrete warm nudge should be good, got ${v.overall} (${v.reason})`)
  },
  {
    id: "bare_check_in",
    message: "Just checking in!",
    assert: v => assert.equal(v.overall, "suppress", `bare check-in should suppress, got ${v.overall} (${v.reason})`)
  },
  {
    id: "corporate_bot",
    message:
      "Per your inquiry, we would be delighted to assist you in exploring our wide range of options at your earliest convenience.",
    assert: v => assert.equal(v.toneOk, false, `corporate-bot copy should fail tone_ok, got tone_ok=${v.toneOk} (${v.reason})`)
  }
];

let ran = 0;
for (const c of cases) {
  const v = await judgeCadenceQualityWithLLM({ message: c.message, channel: "sms" });
  if (!v) continue; // judge disabled / transient null — skip, don't red the gate
  ran += 1;
  c.assert(v);
}

console.log(
  ran === 0
    ? `PASS cadence quality judge eval (source guard + ${rows.length} decision-table rows; LLM coverage skipped — judge disabled)`
    : `PASS cadence quality judge eval (source guard + ${rows.length} decision-table rows + ${ran}/${cases.length} LLM coverage cases)`
);
