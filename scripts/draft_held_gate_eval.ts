/**
 * STEP 2 — pre-publish held-gate eval (dark).
 *
 * Joe's hard requirement: a bad draft must NEVER appear in the outgoing field. STEP 2 makes the
 * draft-quality judge a PRE-PUBLISH gate inside publishCustomerReplyDraft: a failing draft is never
 * stored — the gate clears any existing draft and sets a `draftHeld` ("being fixed") marker instead.
 * Ships DARK behind DRAFT_QUALITY_JUDGE_ENABLED; with the flag off the gate short-circuits (no judge
 * call, no latency) so behavior is byte-identical to before.
 *
 * Layers: (1) source guard — the held-state type, the async gate, the dark short-circuit, the
 * "store no draft on held" clearing + held marker, the "a passing draft clears stale held" reset,
 * and the no-double-judge guard (the post-publish shadow hook is skipped when the live gate is on).
 * (2) pure decision coverage — the gate only HOLDS on a confident hold/regenerate while live;
 * good / low-confidence never holds (fail-open toward publishing).
 *
 * Deterministic — always runs. Run: npx tsx scripts/draft_held_gate_eval.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { decideDraftQualityGate, DRAFT_QUALITY_MIN_CONFIDENCE } from "../services/api/src/domain/draftQualityGate.ts";

const index = fs.readFileSync("services/api/src/index.ts", "utf8");
const store = fs.readFileSync("services/api/src/domain/conversationStore.ts", "utf8");

// --- 1) Source guard. ---
assert.ok(/draftHeld\?:\s*\{/.test(store), "Conversation must carry a draftHeld marker");
assert.ok(/async function gateDraftBeforePublish/.test(index), "the async pre-publish gate must exist");
assert.ok(
  /if \(!isDraftQualityJudgeEnabled\(\)\) return \{ held: false \}/.test(index),
  "gate must short-circuit when dark (no judge call, no latency)"
);
assert.ok(/async function publishCustomerReplyDraft/.test(index), "publishCustomerReplyDraft must be async (it awaits the gate)");
// On held: store NO draft — clear any existing draft + set the held marker + return held.
assert.ok(/discardPendingDrafts\(args\.conv, "draft_quality_held"\)/.test(index), "held must discard pending drafts");
assert.ok(/delete args\.conv\.emailDraft/.test(index), "held must clear any existing email draft");
assert.ok(/args\.conv\.draftHeld = \{/.test(index), "held must set the draftHeld marker");
assert.ok(/return \{ ok: false, reason: "draft_quality_held", held: true \}/.test(index), "held must return a distinct held result");
// A passing draft supersedes a stale held marker.
assert.ok(/if \(args\.conv\.draftHeld\) args\.conv\.draftHeld = null/.test(index), "a passing draft must clear stale held state");
// No double-judge: the post-publish shadow hook is skipped when the live gate is on.
assert.ok(
  /if \(!isDraftQualityJudgeEnabled\(\)\) \{\s*\n\s*void runDraftQualityJudgeShadow/.test(index),
  "the post-publish shadow hook must be skipped when the live gate is enabled"
);

// --- 2) Pure decision coverage: the gate HOLDS only on a confident hold/regenerate while live. ---
type V = Parameters<typeof decideDraftQualityGate>[0]["verdict"];
const holdsWhenLive = (overall: "hold" | "needs_regenerate") => {
  const d = decideDraftQualityGate({ enabled: true, verdict: { intentOk: true, toneOk: false, dispositionOk: true, safetyOk: true, overall, confidence: 0.95 } as V });
  return d.live && (d.action === "hold" || d.action === "regenerate");
};
assert.ok(holdsWhenLive("hold"), "a confident hold verdict must hold while live");
assert.ok(holdsWhenLive("needs_regenerate"), "a confident needs_regenerate verdict must hold while live");
// Good / low-confidence never holds (fail-open toward publishing).
const good = decideDraftQualityGate({ enabled: true, verdict: { intentOk: true, toneOk: true, dispositionOk: true, safetyOk: true, overall: "good", confidence: 0.99 } as V });
assert.equal(good.action, "pass", "a good draft must pass");
const lowConf = decideDraftQualityGate({ enabled: true, verdict: { intentOk: true, toneOk: false, dispositionOk: true, safetyOk: true, overall: "hold", confidence: DRAFT_QUALITY_MIN_CONFIDENCE - 0.01 } as V });
assert.equal(lowConf.action, "pass", "a low-confidence verdict must pass (fail-open)");

console.log("PASS draft held-gate eval (source guard + held-state wiring + pure decision coverage)");
