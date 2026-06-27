/**
 * Model-authority eval (Phase 2, scoped to model resolution).
 *
 * Pins the pure authority resolver + relevance guard that lets the consolidated
 * understanding pass own model selection WITHOUT the over-attachment failure mode
 * the shadow backfill exposed. Deterministic (LLM output is passed in).
 */
import assert from "node:assert/strict";

import {
  isNonActionableTurnText,
  modelAuthorityEnabled,
  passesModelRelevanceGuard,
  resolveAuthoritativeModels,
  toAuthorityModels
} from "../services/api/src/domain/turnUnderstandingAuthority.ts";

// 1) Non-actionable detector
for (const yes of ["Thanks Joe", "ok", "👍", "Perfect. See you then.", "see you Saturday", "sounds good", "awesome"]) {
  assert.ok(isNonActionableTurnText(yes), `non-actionable: "${yes}"`);
}
for (const no of ["do you have a road glide?", "is the bike in store?", "I want to test ride a Fat Boy", "what's the price on the 23 lrs"]) {
  assert.ok(!isNonActionableTurnText(no), `actionable: "${no}"`);
}

// 2) Relevance guard
assert.ok(passesModelRelevanceGuard("Road Glide", "do you have a road glide?"), "named-this-turn model is relevant");
assert.ok(passesModelRelevanceGuard("Street Glide", "is the bike in store?"), "actionable question may use the active subject");
assert.ok(!passesModelRelevanceGuard("Breakout", "Thanks Joe"), "context model on a bare thanks is NOT relevant");
assert.ok(!passesModelRelevanceGuard("Road Glide", "Perfect. See you then."), "context model on a sign-off is NOT relevant");

// 3) Kill switch: disabled => deterministic regardless of LLM
{
  const d = resolveAuthoritativeModels({
    enabled: false,
    llmModels: [{ family: "Road Glide", confidence: 0.95 }],
    deterministicModels: ["Street Glide"],
    inboundText: "do you have a road glide?"
  });
  assert.deepEqual(d.models, ["Street Glide"], "disabled => deterministic models");
  assert.equal(d.source, "deterministic");
  assert.equal(d.reason, "authority_disabled");
}

// 4) Enabled + confident + relevant => LLM authority
{
  const d = resolveAuthoritativeModels({
    enabled: true,
    llmModels: [{ family: "Road Glide", confidence: 0.95 }],
    deterministicModels: [],
    inboundText: "do you have a road glide?",
    confidenceMin: 0.7
  });
  assert.deepEqual(d.models, ["Road Glide"], "confident relevant LLM model wins");
  assert.equal(d.source, "llm");
}

// 5) Over-attachment on a bare ack => dropped; falls back to deterministic
{
  const d = resolveAuthoritativeModels({
    enabled: true,
    llmModels: [{ family: "Breakout", confidence: 0.9 }],
    deterministicModels: ["Street Glide"],
    inboundText: "Thanks Joe",
    confidenceMin: 0.7
  });
  assert.deepEqual(d.droppedContextModels, ["Breakout"], "over-attached model dropped");
  assert.deepEqual(d.models, ["Street Glide"], "falls back to deterministic");
  assert.equal(d.reason, "llm_empty_fallback");
}

// 6) Over-attachment with no deterministic fallback => no model (NOT the wrong one)
{
  const d = resolveAuthoritativeModels({
    enabled: true,
    llmModels: [{ family: "Breakout", confidence: 0.9 }],
    deterministicModels: [],
    inboundText: "Thanks Joe",
    confidenceMin: 0.7
  });
  assert.deepEqual(d.models, [], "no model rather than the over-attached one");
  assert.equal(d.source, "none");
}

// 7) Low-confidence LLM => deterministic fallback
{
  const d = resolveAuthoritativeModels({
    enabled: true,
    llmModels: [{ family: "Road Glide", confidence: 0.4 }],
    deterministicModels: ["Road Glide"],
    inboundText: "do you have a road glide?",
    confidenceMin: 0.7
  });
  assert.equal(d.source, "deterministic");
}

// 8) env kill switch reads correctly
{
  const prev = process.env.TURN_UNDERSTANDING_MODEL_AUTHORITY;
  process.env.TURN_UNDERSTANDING_MODEL_AUTHORITY = "1";
  assert.equal(modelAuthorityEnabled(), true, "flag=1 enables");
  delete process.env.TURN_UNDERSTANDING_MODEL_AUTHORITY;
  assert.equal(modelAuthorityEnabled(), true, "GRADUATED 2026-06-24: default-ON when the flag is unset");
  process.env.TURN_UNDERSTANDING_MODEL_AUTHORITY = "0";
  assert.equal(modelAuthorityEnabled(), false, "flag=0 is the kill-switch");
  if (prev === undefined) delete process.env.TURN_UNDERSTANDING_MODEL_AUTHORITY;
  else process.env.TURN_UNDERSTANDING_MODEL_AUTHORITY = prev;
}

// 9) toAuthorityModels mapper (STEP 2 — maps pass.requestedModels -> resolver input)
{
  const mapped = toAuthorityModels([
    { family: "Road Glide", trim: "Limited", confidence: 0.92 },
    { family: "  ", confidence: 0.9 }, // empty family dropped
    { family: "Street Glide" } // missing confidence => defaults to 1 (not gated out)
  ]);
  assert.deepEqual(
    mapped,
    [
      { family: "Road Glide", trim: "Limited", confidence: 0.92 },
      { family: "Street Glide", trim: null, confidence: 1 }
    ],
    "maps families, drops empties, defaults confidence to 1"
  );
  assert.deepEqual(toAuthorityModels(null), [], "null requestedModels => []");
  assert.deepEqual(toAuthorityModels(undefined), [], "undefined => []");
}

// 10) STEP-2 live-cutover invariant: at each wired site, flag OFF (the per-turn helper
//     returns []) => output is the deterministic list VERBATIM, identically in the live
//     + regen paths (parity by construction — both route through the one resolver).
{
  const sitePassthrough = (det: string[]) =>
    resolveAuthoritativeModels({ enabled: false, llmModels: [], deterministicModels: det, inboundText: "do you have a road glide?" }).models;
  for (const det of [[], ["Road Glide"], ["Street Glide", "Low Rider S"]]) {
    assert.deepEqual(sitePassthrough(det), det, `dark passthrough preserves ${JSON.stringify(det)}`);
  }
  const args = {
    enabled: true,
    llmModels: toAuthorityModels([{ family: "Fat Boy", confidence: 0.9 }]),
    deterministicModels: ["Street Glide"],
    inboundText: "can I test ride a fat boy"
  };
  const live = resolveAuthoritativeModels(args);
  const regen = resolveAuthoritativeModels({ ...args });
  assert.deepEqual(live.models, regen.models, "live + regen identical for identical inputs (parity)");
  assert.deepEqual(live.models, ["Fat Boy"], "confident relevant model wins at the site");
}

console.log("PASS model authority eval");
