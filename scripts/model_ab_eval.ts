/**
 * Draft-model A/B eval (2026-06-15).
 *
 * Tests whether a stronger model (gpt-5 challenger) lifts customer-facing reply
 * quality over the gpt-5-mini control. This eval pins the experiment scaffolding:
 *  1. decideDraftModelArm is pure, deterministic, ~50/50, and salted independently
 *     of the cadence arm (the two experiments must not correlate).
 *  2. The draft composer (generateDraftWithLLM) resolves its model per-lead via
 *     resolveDraftModelForLead (challenger gpt-5 / control gpt-5-mini, with a kill
 *     switch) — and the PARSERS are NOT on the arm, so routing stays constant and
 *     the measurement isolates the draft model.
 */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";

import { decideCadenceInviteArm, decideDraftModelArm } from "../services/api/src/domain/routeStateReducer.ts";

// 1) Arm assignment: pure, deterministic, 3-way (~15% anthropic, rest ~even), empty -> control.
assert.equal(decideDraftModelArm(""), "control", "empty lead -> control");
for (const k of ["+17166286477", "+15673079691", "lead_abc", "9f74"]) {
  const a = decideDraftModelArm(k);
  for (let i = 0; i < 50; i++) assert.equal(decideDraftModelArm(k), a, `stable arm for ${k}`);
  assert.ok(a === "control" || a === "challenger" || a === "anthropic", "arm is one of three values");
}
let nControl = 0, nChallenger = 0, nAnthropic = 0;
const N = 20000;
for (let i = 0; i < N; i++) {
  const a = decideDraftModelArm(`+1716${String(1000000 + i)}`);
  if (a === "challenger") nChallenger++;
  else if (a === "anthropic") nAnthropic++;
  else nControl++;
}
const anthropicShare = nAnthropic / N, challengerShare = nChallenger / N, controlShare = nControl / N;
assert.ok(anthropicShare > 0.12 && anthropicShare < 0.18, `~15% Sonnet canary, got ${(anthropicShare * 100).toFixed(1)}%`);
assert.ok(challengerShare > 0.37 && challengerShare < 0.48, `~42.5% challenger, got ${(challengerShare * 100).toFixed(1)}%`);
assert.ok(controlShare > 0.37 && controlShare < 0.48, `~42.5% control, got ${(controlShare * 100).toFixed(1)}%`);

// Independent salt: draft arm must not track the cadence arm (else the two experiments
// confound each other). Test on the 2-way (control/challenger) subset, where a clean ~50%
// agreement with the binary cadence arm is the decorrelation signal.
let twoWay = 0, agree = 0;
for (let i = 0; i < N; i++) {
  const key = `k_${i}`;
  const d = decideDraftModelArm(key);
  if (d === "anthropic") continue;
  twoWay++;
  if (d === decideCadenceInviteArm(key)) agree++;
}
const agreeRate = agree / twoWay;
assert.ok(agreeRate > 0.45 && agreeRate < 0.55, `draft/cadence arms must be decorrelated, agree=${(agreeRate * 100).toFixed(1)}%`);

// 2) Wiring + isolation pins in llmDraft.ts.
const src = await fs.readFile(path.resolve("services/api/src/domain/llmDraft.ts"), "utf8");

assert.match(
  src,
  /import \{[^}]*decideDraftModelArm[^}]*\} from "\.\/routeStateReducer\.js"/,
  "llmDraft must import decideDraftModelArm"
);
// resolver: control = OPENAI_MODEL||gpt-5-mini, challenger = OPENAI_DRAFT_MODEL_CHALLENGER||gpt-5, kill switch.
assert.match(src, /function resolveDraftModelForLead\(/, "resolveDraftModelForLead must exist");
assert.match(src, /process\.env\.OPENAI_DRAFT_MODEL_CHALLENGER \|\| "gpt-5"/, "challenger model = gpt-5 (overridable)");
assert.match(src, /process\.env\.DRAFT_MODEL_AB_ENABLED === "0"/, "kill switch DRAFT_MODEL_AB_ENABLED=0 forces control");
assert.match(src, /function draftModelControl\(\)[\s\S]{0,80}OPENAI_MODEL \|\| "gpt-5-mini"/, "control model = OPENAI_MODEL||gpt-5-mini");

// Anthropic (Sonnet) arm: model default, dark-gating until the key is set, raw Messages API call,
// and a fail-safe fallback to the OpenAI control model so a draft is never dropped.
assert.match(src, /process\.env\.ANTHROPIC_DRAFT_MODEL \|\| "claude-sonnet-4-6"/, "anthropic arm model = ANTHROPIC_DRAFT_MODEL||claude-sonnet-4-6");
assert.match(
  src,
  /if \(!String\(process\.env\.ANTHROPIC_API_KEY[\s\S]{0,160}arm: "control", provider: "openai"/,
  "anthropic arm stays dark (falls back to control) until ANTHROPIC_API_KEY is set"
);
assert.match(src, /async function generateDraftViaAnthropic\(/, "anthropic draft helper must exist");
assert.match(src, /api\.anthropic\.com\/v1\/messages/, "anthropic helper calls the Messages API");
assert.match(
  src,
  /draftProvider === "anthropic"[\s\S]{0,700}generateViaOpenAI\(draftModelControl\(\)\)/,
  "anthropic arm must fall back to the OpenAI control model on failure (never drops the draft)"
);

// The draft composer resolves via the arm; it must NOT still hardcode the raw default.
const draftFnStart = src.indexOf("export async function generateDraftWithLLM");
assert.ok(draftFnStart >= 0, "generateDraftWithLLM must exist");
const draftFnHead = src.slice(draftFnStart, draftFnStart + 600);
assert.match(draftFnHead, /resolveDraftModelForLead\(ctx\.leadKey\)/, "generateDraftWithLLM must resolve model via the arm");
assert.doesNotMatch(
  draftFnHead,
  /const model = process\.env\.OPENAI_MODEL \|\| "gpt-5-mini"/,
  "generateDraftWithLLM must not hardcode the raw default model anymore"
);

// Parser isolation: parsers still default to OPENAI_MODEL (they are NOT on the
// arm), so routing behavior is unchanged across arms. Many such sites remain.
const parserModelSites = (src.match(/process\.env\.OPENAI_MODEL \|\| "gpt-5-mini"/g) ?? []).length;
assert.ok(parserModelSites >= 6, `parsers must stay on OPENAI_MODEL (found ${parserModelSites} default sites)`);

// resolveDraftModelForLead is the only model gate the draft path adds.
const resolverUses = (src.match(/resolveDraftModelForLead\(/g) ?? []).length;
assert.ok(resolverUses >= 2, "resolver defined + used at least once");

console.log(
  `PASS draft-model A/B eval (anthropic ${(anthropicShare * 100).toFixed(1)}% / challenger ${(challengerShare * 100).toFixed(1)}% / control ${(controlShare * 100).toFixed(1)}%, decorrelation ${(agreeRate * 100).toFixed(1)}%, ${parserModelSites} parser model sites)`
);
