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
  resolveAuthoritativeModels
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
  process.env.TURN_UNDERSTANDING_MODEL_AUTHORITY = "0";
  assert.equal(modelAuthorityEnabled(), false, "flag=0 disabled (ships dark)");
  if (prev === undefined) delete process.env.TURN_UNDERSTANDING_MODEL_AUTHORITY;
  else process.env.TURN_UNDERSTANDING_MODEL_AUTHORITY = prev;
}

console.log("PASS model authority eval");
