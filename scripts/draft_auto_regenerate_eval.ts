/**
 * STEP 3 — inline auto-regenerate (self-heal) eval.
 *
 * After the orchestrator produces a draft, selfHealDraftWithLLM judges it; on a confident hold-class
 * verdict it regenerates ONCE with the judge's steering (the actual PATCH) and re-judges, returning
 * the healed draft only if it now passes — else the original (the publish gate then holds it). Dark
 * unless DRAFT_QUALITY_AUTO_REGENERATE is on. One attempt by design.
 *
 * Layers: (1) source guard — the steering field + the generator's re-draft block, selfHeal + its flag,
 * and the orchestrator wiring all exist. (2) behavioral (no LLM) — with the flag OFF, selfHeal is a
 * pure no-op (returns the draft unchanged, zero LLM calls); the flag defaults OFF and reads truthy.
 *
 * Deterministic — always runs. Run: npx tsx scripts/draft_auto_regenerate_eval.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { selfHealDraftWithLLM, draftAutoRegenerateEnabled } from "../services/api/src/domain/llmDraft.ts";

// --- 1) Source guard. ---
const llm = fs.readFileSync("services/api/src/domain/llmDraft.ts", "utf8");
const orch = fs.readFileSync("services/api/src/domain/orchestrator.ts", "utf8");

assert.ok(/steering\?: string \| null;/.test(llm), "DraftContext must carry a steering hint (the patch input)");
assert.ok(/THIS IS A RE-DRAFT/.test(llm), "the generator must inject a re-draft/steering block when steering is present");
assert.ok(/export async function selfHealDraftWithLLM/.test(llm), "selfHealDraftWithLLM must be exported");
assert.ok(/DRAFT_QUALITY_AUTO_REGENERATE/.test(llm), "the auto-regenerate flag must gate selfHeal");
// One attempt + re-judge guarantee: a single steered regenerate, then keep ORIGINAL if it still fails.
assert.ok(/generateDraftWithLLM\(\{ \.\.\.args\.ctx, steering \}\)/.test(llm), "selfHeal must regenerate WITH steering");
assert.ok(/Re-draft still bad — keep the ORIGINAL/.test(llm), "a still-failing re-draft must NOT be shipped (keep original; gate holds)");
// Wired into the orchestrator at the generation site.
assert.ok(/selfHealDraftWithLLM\(\{ draft: baseDraft, ctx: draftCtx \}\)/.test(orch), "the orchestrator must self-heal the generated draft");

// --- 2) Behavioral (no LLM): dark = pure no-op. ---
assert.equal(draftAutoRegenerateEnabled(), false, "auto-regenerate must default OFF (dark)");
{
  const prev = process.env.DRAFT_QUALITY_AUTO_REGENERATE;
  delete process.env.DRAFT_QUALITY_AUTO_REGENERATE;
  const r = await selfHealDraftWithLLM({
    draft: "Hey Charlie, the Street Glide is in stock — want to come take a look this week?",
    ctx: { channel: "sms", leadKey: "+15550000000", inquiry: "is it still available?", history: [] }
  });
  assert.equal(r.outcome, "no_op", "flag OFF must be a no-op");
  assert.equal(r.healed, false, "flag OFF must not heal");
  assert.equal(r.draft, "Hey Charlie, the Street Glide is in stock — want to come take a look this week?", "flag OFF must return the draft unchanged");
  process.env.DRAFT_QUALITY_AUTO_REGENERATE = "1";
  assert.equal(draftAutoRegenerateEnabled(), true, "DRAFT_QUALITY_AUTO_REGENERATE=1 must enable");
  if (prev === undefined) delete process.env.DRAFT_QUALITY_AUTO_REGENERATE;
  else process.env.DRAFT_QUALITY_AUTO_REGENERATE = prev;
}

console.log("PASS draft auto-regenerate eval (source guard + steering patch wiring + dark no-op behavior)");
