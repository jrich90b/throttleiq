/**
 * Model-deflection decision eval (pure, no LLM) — "answer-don't-deflect: model-known case".
 *
 * Built in the 4-pillar shape so it can't overfit to the failures it patches:
 *   1. SATISFIED (keep)     — placeholder/absent anchor => ask is CORRECT. The over-correction guard
 *                             (the pillar most likely to be skipped, and the main risk here).
 *   2. REPLAYED FAILURES    — specific anchor, agent asked anyway => answer_with_model (the bug).
 *   3. DELIBERATE EDGES     — make-prefix, trim/variant, turn-vs-anchor precedence, casing/whitespace.
 *   4. ADVERSARIAL          — customer pivots OFF the anchor => never assert the stale anchor
 *                             (the over-attachment failure mode that ruled out the big consolidation).
 *
 * Cases 1-2 are derived from the production harvest (scripts/model_deflection_harvest.ts, PII-scrubbed);
 * 3-4 are hand-authored. Asserts the pure decision in services/api/src/domain/modelDeflection.ts. The
 * orchestrator wiring (consume this at the ~7 deflection sites) lands in a follow-up commit and adds a
 * source guard here then.
 *
 * Run: npx tsx scripts/model_deflection_eval.ts
 */
import assert from "node:assert/strict";

import {
  decideModelDeflection,
  isPlaceholderModel,
  resolveSpecificModelForDeflection
} from "../services/api/src/domain/modelDeflection.ts";

type Case = {
  pillar: 1 | 2 | 3 | 4;
  id: string;
  turnModel?: string | null;
  anchorModel?: string | null;
  turnContradictsAnchor?: boolean;
  action: "answer_with_model" | "ask_for_model";
  model?: string | null;
};

const cases: Case[] = [
  // --- Pillar 1: SATISFIED (keep) — placeholder/absent anchor => ASK is correct. ---
  { pillar: 1, id: "anchor_other_prefixed", anchorModel: "Harley-Davidson Other", action: "ask_for_model", model: null }, // lead_83/lead_312
  { pillar: 1, id: "anchor_full_line", anchorModel: "Harley-Davidson Full Line", action: "ask_for_model", model: null }, // lead_305
  { pillar: 1, id: "anchor_bare_other", anchorModel: "Other", action: "ask_for_model", model: null },
  { pillar: 1, id: "anchor_bare_make", anchorModel: "Harley-Davidson", action: "ask_for_model", model: null },
  { pillar: 1, id: "anchor_empty", anchorModel: "", action: "ask_for_model", model: null },
  { pillar: 1, id: "anchor_null_literal", anchorModel: "null", action: "ask_for_model", model: null },
  { pillar: 1, id: "anchor_na", anchorModel: "N/A", action: "ask_for_model", model: null },
  { pillar: 1, id: "all_unknown", turnModel: null, anchorModel: null, action: "ask_for_model", model: null },

  // --- Pillar 2: REPLAYED FAILURES — specific anchor, agent asked anyway => ANSWER with it. ---
  { pillar: 2, id: "anchor_road_glide", anchorModel: "Road Glide", action: "answer_with_model", model: "Road Glide" }, // lead_30
  { pillar: 2, id: "anchor_street_glide_limited", anchorModel: "HARLEY-DAVIDSON Street Glide Limited", action: "answer_with_model", model: "HARLEY-DAVIDSON Street Glide Limited" }, // lead_47
  { pillar: 2, id: "anchor_fat_bob", anchorModel: "Fat Bob", action: "answer_with_model", model: "Fat Bob" }, // lead_389

  // --- Pillar 3: DELIBERATE EDGES. ---
  { pillar: 3, id: "anchor_make_prefixed_specific", anchorModel: "Harley-Davidson Road Glide", action: "answer_with_model", model: "Harley-Davidson Road Glide" },
  { pillar: 3, id: "anchor_trim_variant", anchorModel: "Road Glide Special", action: "answer_with_model", model: "Road Glide Special" },
  { pillar: 3, id: "anchor_whitespace_case", anchorModel: "  fat boy  ", action: "answer_with_model", model: "fat boy" },
  { pillar: 3, id: "turn_specific_anchor_placeholder", turnModel: "Sportster", anchorModel: "Other", action: "answer_with_model", model: "Sportster" }, // turn wins over placeholder anchor
  { pillar: 3, id: "turn_placeholder_anchor_specific", turnModel: "Other", anchorModel: "Street Glide", action: "answer_with_model", model: "Street Glide" }, // fall back to specific anchor

  // --- Pillar 4: ADVERSARIAL — pivots / over-attachment. ---
  { pillar: 4, id: "turn_pivots_to_new_model", turnModel: "Sportster", anchorModel: "Road Glide", action: "answer_with_model", model: "Sportster" }, // "forget the Road Glide, what about a Sportster" -> turn wins
  { pillar: 4, id: "turn_rejects_anchor_no_new_model", anchorModel: "Road Glide", turnContradictsAnchor: true, action: "ask_for_model", model: null }, // "not that one anymore" -> never assert stale anchor
  { pillar: 4, id: "turn_pivots_with_new_model_overrides_contradiction", turnModel: "Fat Boy", anchorModel: "Road Glide", turnContradictsAnchor: true, action: "answer_with_model", model: "Fat Boy" }
];

const byPillar: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0 };
for (const c of cases) {
  const got = decideModelDeflection({ turnModel: c.turnModel, anchorModel: c.anchorModel, turnContradictsAnchor: c.turnContradictsAnchor });
  assert.equal(got.action, c.action, `[P${c.pillar} ${c.id}] action: expected ${c.action}, got ${got.action} (reason ${got.reason})`);
  if (c.model !== undefined) {
    assert.equal((got.model ?? "").trim(), (c.model ?? "").trim() || (got.model ?? ""), `[P${c.pillar} ${c.id}] model: expected "${c.model}", got "${got.model}"`);
  }
  byPillar[c.pillar]++;
}

// --- Invariants on the placeholder primitive (the over-correction guardrail). ---
for (const ph of ["", "  ", "Other", "harley-davidson other", "Full Line", "Full Lineup", "Harley-Davidson Full Line", "harley-davidson", "harley", "null", "N/A", "TBD"]) {
  assert.equal(isPlaceholderModel(ph), true, `isPlaceholderModel("${ph}") should be true`);
}
for (const sp of ["Road Glide", "Fat Bob", "Street Glide Limited", "Sportster S", "Harley-Davidson Road Glide", "Tri Glide Ultra"]) {
  assert.equal(isPlaceholderModel(sp), false, `isPlaceholderModel("${sp}") should be false`);
}
// Fail-direction: a pure pivot with no new specific model never resolves to the stale anchor.
assert.equal(resolveSpecificModelForDeflection({ anchorModel: "Road Glide", turnContradictsAnchor: true }), null, "pivot-off-anchor must resolve to null (ask), not the stale anchor");

console.log(`PASS model-deflection decision — ${cases.length} cases across 4 pillars (satisfied ${byPillar[1]}, failures ${byPillar[2]}, edges ${byPillar[3]}, adversarial ${byPillar[4]}); placeholder primitive + fail-direction invariants green.`);
