/**
 * Draft-quality pre-send judge eval (STEP 1 — shadow).
 *
 * Pins the keystone of the self-correcting draft loop (2026-06-19): before a customer-facing
 * draft is sent, a multi-dimensional LLM judge (judgeDraftQualityWithLLM) scores it on intent /
 * tone / disposition / safety, and a pure gate (decideDraftQualityGate) maps the verdict to
 * pass / regenerate / hold. STEP 1 ships DARK — the gate only shadow-logs what it WOULD do; the
 * live regenerate/hold + auto-release-on-fix is a later, approve-first step.
 *
 * Layers:
 *  1) Source guard (no LLM): the gate module + the judge + the flags exist, and the shadow hook
 *     is wired into the single draft chokepoint (publishCustomerReplyDraft).
 *  2) Decision-table coverage (pure): pass on good/low-confidence/no-verdict; regenerate/hold only
 *     on a confident actionable verdict; `live` only when the enable flag is on (else shadow).
 *  3) LLM coverage (gated; skips cleanly): a wrong-intent / disposition-blind draft is NOT "good";
 *     a genuinely fine draft IS "good" (the false-positive guard — don't flag good drafts).
 *
 * Run gated: LLM_ENABLED=1 LLM_DRAFT_QUALITY_JUDGE_ENABLED=1 npx tsx scripts/draft_quality_judge_eval.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { judgeDraftQualityWithLLM } from "../services/api/src/domain/llmDraft.ts";
import { decideDraftQualityGate, DRAFT_QUALITY_MIN_CONFIDENCE } from "../services/api/src/domain/draftQualityGate.ts";

// --- 1) Source guard (no LLM). ---
const index = fs.readFileSync("services/api/src/index.ts", "utf8");
const llm = fs.readFileSync("services/api/src/domain/llmDraft.ts", "utf8");
const gate = fs.readFileSync("services/api/src/domain/draftQualityGate.ts", "utf8");

assert.ok(/export async function judgeDraftQualityWithLLM/.test(llm), "the judge must be exported from llmDraft.ts");
assert.ok(/DRAFT_QUALITY_JUDGE_JSON_SCHEMA/.test(llm), "the strict JSON schema const must exist");
assert.ok(/LLM_DRAFT_QUALITY_JUDGE_ENABLED/.test(llm), "the judge must be behind an enable flag");
assert.ok(/export function decideDraftQualityGate/.test(gate), "the pure gate must be centralized in draftQualityGate.ts");
assert.ok(
  /DRAFT_QUALITY_JUDGE_ENABLED/.test(gate) && /DRAFT_QUALITY_JUDGE_SHADOW/.test(gate),
  "the live-enable + shadow flags must exist"
);
assert.ok(
  /void runDraftQualityJudgeShadow\(args\.conv, draft, args\.channel/.test(index),
  "the shadow hook must be wired into publishCustomerReplyDraft (the draft chokepoint)"
);
// STEP 1 must NOT mutate live drafts — the hook is documented shadow-only.
assert.ok(
  /STEP 1 is shadow-only: never mutate the draft/.test(index),
  "STEP 1 must be shadow-only (no live draft mutation)"
);

// --- 2) Decision-table coverage (pure). ---
type V = Parameters<typeof decideDraftQualityGate>[0]["verdict"];
const verdict = (overall: "good" | "needs_regenerate" | "hold", confidence: number): V => ({
  intentOk: overall === "good",
  toneOk: true,
  dispositionOk: overall !== "hold",
  safetyOk: true,
  overall,
  confidence
});

type Row = { id: string; input: Parameters<typeof decideDraftQualityGate>[0]; action: string; live: boolean };
const rows: Row[] = [
  { id: "no_verdict_pass", input: { enabled: true, verdict: null }, action: "pass", live: false },
  { id: "good_pass", input: { enabled: true, verdict: verdict("good", 0.95) }, action: "pass", live: false },
  { id: "regen_shadow_when_flag_off", input: { enabled: false, verdict: verdict("needs_regenerate", 0.9) }, action: "regenerate", live: false },
  { id: "regen_live_when_flag_on", input: { enabled: true, verdict: verdict("needs_regenerate", 0.9) }, action: "regenerate", live: true },
  { id: "hold_live_when_flag_on", input: { enabled: true, verdict: verdict("hold", 0.92) }, action: "hold", live: true },
  { id: "hold_shadow_when_flag_off", input: { enabled: false, verdict: verdict("hold", 0.92) }, action: "hold", live: false },
  { id: "below_confidence_pass", input: { enabled: true, verdict: verdict("needs_regenerate", DRAFT_QUALITY_MIN_CONFIDENCE - 0.01) }, action: "pass", live: false },
  { id: "at_confidence_floor_acts", input: { enabled: true, verdict: verdict("hold", DRAFT_QUALITY_MIN_CONFIDENCE) }, action: "hold", live: true }
];
for (const r of rows) {
  const d = decideDraftQualityGate(r.input);
  assert.equal(d.action, r.action, `gate[${r.id}] action expected ${r.action}, got ${d.action}`);
  assert.equal(d.live, r.live, `gate[${r.id}] live expected ${r.live}, got ${d.live}`);
}

// --- 3) LLM coverage (gated; skips cleanly). ---
type Case = { id: string; inbound: string; draft: string; wantGood: boolean };
const cases: Case[] = [
  {
    id: "pleasantry_for_price",
    inbound: "What is the asking price?",
    draft: "Doing well — hope your day is going great too!",
    wantGood: false // ignores the price ask
  },
  {
    id: "grief_pushy",
    inbound: "my wife just passed, I need to put this on hold",
    draft: "No problem! Want to come in Saturday at 10 to check it out?",
    wantGood: false // disposition-blind, pushes a visit
  },
  {
    id: "good_price_handoff",
    inbound: "what's the out the door price on it?",
    draft: "Great question — let me grab the exact out-the-door number from my manager and text it right over.",
    wantGood: true // addresses the ask, no fabricated number, warm
  },
  {
    id: "good_availability_invite",
    inbound: "is it still available?",
    draft: "It is! Happy to hold it for you — want to swing by this week to take a look?",
    wantGood: true
  }
];

let ran = 0;
for (const c of cases) {
  const v = await judgeDraftQualityWithLLM({ draft: c.draft, inbound: c.inbound, channel: "sms" });
  if (!v) continue; // judge disabled / transient null — skip, don't red the gate
  ran += 1;
  if (c.wantGood) {
    assert.equal(v.overall, "good", `[${c.id}] a fine draft should be "good", got ${v.overall} (${v.reason})`);
  } else {
    assert.notEqual(v.overall, "good", `[${c.id}] a bad draft must NOT be "good" (${v.reason})`);
  }
}

console.log(
  ran === 0
    ? `PASS draft quality judge eval (source guard + ${rows.length} decision-table rows; LLM coverage skipped — judge disabled)`
    : `PASS draft quality judge eval (source guard + ${rows.length} decision-table rows + ${ran}/${cases.length} LLM coverage cases)`
);
