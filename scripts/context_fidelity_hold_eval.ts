/**
 * Context-fidelity HOLD gate eval (pure, no LLM).
 *
 * Pins the pre-publish hold slice the shadow logs today and the (future, approve-first) enforce-flip
 * will act on. The scorer itself (scoreContextFidelityWithLLM) is LLM-backed and covered by
 * context_fidelity:eval; THIS eval pins only the pure precedence in decideContextFidelityHold so the
 * hold trigger can't silently drift.
 *
 * Slice (mirrors the draft-quality gate's proven-safe first slice): hold ONLY on
 *   verdict=out_of_context AND severity=major AND confidence>=0.8 AND a TURN-JUDGED frame
 *   (stale_intent | over_attached_model | dropped_anchor).
 * Everything else (faithful / minor / below-confidence / anchor-dependent frame / no score) passes.
 *
 * Layers:
 *   1. Source guard — index.ts imports + uses the decision + the scorer + the shadow flag, and logs
 *      the [context-fidelity-hold-shadow] marker (so the shadow measurement actually runs).
 *   2. Decision table — the hold case + every pass case, incl. the excluded anchor-dependent frames.
 *   3. Invariants — the hold-frame set is exactly the 3 turn-judged frames; bar matches 0.8;
 *      `live` follows the enabled flag.
 *
 * Run: npx tsx scripts/context_fidelity_hold_eval.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  decideContextFidelityHold,
  CONTEXT_FIDELITY_HOLD_FRAMES,
  CONTEXT_FIDELITY_HOLD_MIN_CONFIDENCE,
  type ContextFidelityScoreLike
} from "../services/api/src/domain/contextFidelityHold.ts";

// --- 1) Source guard: index.ts must wire the shadow (import + use + log marker). ---
const index = fs.readFileSync("services/api/src/index.ts", "utf8");
assert.ok(
  /decideContextFidelityHold/.test(index) && /contextFidelityHold/.test(index),
  "index.ts must import + use decideContextFidelityHold from the pure module"
);
assert.ok(
  /scoreContextFidelityWithLLM/.test(index),
  "index.ts must call the context-fidelity scorer in the shadow hook"
);
assert.ok(
  /context-fidelity-hold-shadow/.test(index),
  "index.ts must log the [context-fidelity-hold-shadow] would-hold marker"
);
assert.ok(
  /contextFidelityHoldShadowEnabled/.test(index),
  "the shadow hook must be gated by contextFidelityHoldShadowEnabled()"
);

// --- 2) Decision table (pure). ---
const score = (over: Partial<ContextFidelityScoreLike>): ContextFidelityScoreLike => ({
  verdict: "out_of_context",
  severity: "major",
  frame: "stale_intent",
  confidence: 0.9,
  ...over
});

type Case = { id: string; score: ContextFidelityScoreLike | null; enabled: boolean; action: "pass" | "hold"; live: boolean; reason: string };
const cases: Case[] = [
  // The hold cases — each turn-judged frame, confident + major + out_of_context.
  { id: "hold_stale_intent", score: score({ frame: "stale_intent" }), enabled: true, action: "hold", live: true, reason: "live_hold" },
  { id: "hold_over_attached", score: score({ frame: "over_attached_model" }), enabled: true, action: "hold", live: true, reason: "live_hold" },
  { id: "hold_dropped_anchor", score: score({ frame: "dropped_anchor" }), enabled: true, action: "hold", live: true, reason: "live_hold" },
  // Shadow (flag off): would-hold but live=false.
  { id: "shadow_would_hold", score: score({ frame: "stale_intent" }), enabled: false, action: "hold", live: false, reason: "shadow_would_hold" },
  // Passes:
  { id: "faithful_passes", score: score({ verdict: "faithful" }), enabled: true, action: "pass", live: false, reason: "faithful" },
  { id: "minor_passes", score: score({ severity: "minor" }), enabled: true, action: "pass", live: false, reason: "minor" },
  { id: "below_confidence_passes", score: score({ confidence: 0.7 }), enabled: true, action: "pass", live: false, reason: "below_confidence" },
  { id: "missing_confidence_passes", score: score({ confidence: undefined }), enabled: true, action: "pass", live: false, reason: "below_confidence" },
  // Anchor-dependent frames are EXCLUDED from the hold (stale-anchor false-hold risk) even when major+confident.
  { id: "wrong_lead_type_excluded", score: score({ frame: "wrong_lead_type" }), enabled: true, action: "pass", live: false, reason: "frame_excluded" },
  { id: "fabricated_excluded", score: score({ frame: "fabricated" }), enabled: true, action: "pass", live: false, reason: "frame_excluded" },
  { id: "matches_excluded", score: score({ frame: "matches" }), enabled: true, action: "pass", live: false, reason: "frame_excluded" },
  { id: "other_excluded", score: score({ frame: "other" }), enabled: true, action: "pass", live: false, reason: "frame_excluded" },
  // No score → pass (fail-safe).
  { id: "no_score_passes", score: null, enabled: true, action: "pass", live: false, reason: "no_score" }
];

for (const c of cases) {
  const got = decideContextFidelityHold({ enabled: c.enabled, score: c.score });
  assert.equal(got.action, c.action, `decide[${c.id}] action expected ${c.action}, got ${got.action}`);
  assert.equal(got.live, c.live, `decide[${c.id}] live expected ${c.live}, got ${got.live}`);
  assert.equal(got.reason, c.reason, `decide[${c.id}] reason expected ${c.reason}, got ${got.reason}`);
}

// --- 3) Invariants. ---
assert.deepEqual(
  [...CONTEXT_FIDELITY_HOLD_FRAMES].sort(),
  ["dropped_anchor", "over_attached_model", "stale_intent"],
  "hold frames must be exactly the 3 turn-judged frames (anchor-dependent frames excluded)"
);
assert.equal(CONTEXT_FIDELITY_HOLD_MIN_CONFIDENCE, 0.8, "confidence bar should match the draft-quality gate (0.8)");
// Boundary: exactly 0.8 holds (>=), just under does not.
assert.equal(decideContextFidelityHold({ enabled: true, score: score({ confidence: 0.8 }) }).action, "hold", "0.8 is at the bar → hold");
assert.equal(decideContextFidelityHold({ enabled: true, score: score({ confidence: 0.79 }) }).action, "pass", "just under the bar → pass");

const holds = cases.filter(c => c.action === "hold").length;
console.log(`PASS context-fidelity hold gate — ${cases.length} cases (${holds} hold, ${cases.length - holds} pass), frames ${JSON.stringify([...CONTEXT_FIDELITY_HOLD_FRAMES])}, bar ${CONTEXT_FIDELITY_HOLD_MIN_CONFIDENCE}`);
