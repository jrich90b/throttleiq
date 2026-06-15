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

// 1) Arm assignment: pure, deterministic, ~50/50, empty -> control.
assert.equal(decideDraftModelArm(""), "control", "empty lead -> control");
for (const k of ["+17166286477", "+15673079691", "lead_abc", "9f74"]) {
  const a = decideDraftModelArm(k);
  for (let i = 0; i < 50; i++) assert.equal(decideDraftModelArm(k), a, `stable arm for ${k}`);
  assert.ok(a === "control" || a === "challenger", "arm is one of two values");
}
let challenger = 0;
const N = 20000;
for (let i = 0; i < N; i++) if (decideDraftModelArm(`+1716${String(1000000 + i)}`) === "challenger") challenger++;
const share = challenger / N;
assert.ok(share > 0.45 && share < 0.55, `~50/50 split, got ${(share * 100).toFixed(1)}%`);

// Independent salt: draft arm must not track the cadence arm (else the two
// experiments confound each other). For the same keys they should agree ~50%.
let agree = 0;
for (let i = 0; i < N; i++) {
  const key = `k_${i}`;
  if (decideDraftModelArm(key) === decideCadenceInviteArm(key)) agree++;
}
const agreeRate = agree / N;
assert.ok(agreeRate > 0.45 && agreeRate < 0.55, `draft/cadence arms must be decorrelated, agree=${(agreeRate * 100).toFixed(1)}%`);

// 2) Wiring + isolation pins in llmDraft.ts.
const src = await fs.readFile(path.resolve("services/api/src/domain/llmDraft.ts"), "utf8");

assert.match(
  src,
  /import \{ decideDraftModelArm \} from "\.\/routeStateReducer\.js"/,
  "llmDraft must import decideDraftModelArm"
);
// resolver: control = OPENAI_MODEL||gpt-5-mini, challenger = OPENAI_DRAFT_MODEL_CHALLENGER||gpt-5, kill switch.
assert.match(src, /function resolveDraftModelForLead\(/, "resolveDraftModelForLead must exist");
assert.match(src, /process\.env\.OPENAI_DRAFT_MODEL_CHALLENGER \|\| "gpt-5"/, "challenger model = gpt-5 (overridable)");
assert.match(src, /process\.env\.DRAFT_MODEL_AB_ENABLED === "0"/, "kill switch DRAFT_MODEL_AB_ENABLED=0 forces control");
assert.match(src, /function draftModelControl\(\)[\s\S]{0,80}OPENAI_MODEL \|\| "gpt-5-mini"/, "control model = OPENAI_MODEL||gpt-5-mini");

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

console.log(`PASS draft-model A/B eval (split ${(share * 100).toFixed(1)}%, decorrelation ${(agreeRate * 100).toFixed(1)}%, ${parserModelSites} parser model sites)`);
