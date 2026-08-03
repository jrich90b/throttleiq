/**
 * Email-lane unified-slot cutover eval (2026-08-03; Joe approved the cutover 2026-08-01).
 *
 * WHAT THIS PROTECTS. The SMS lane has been served by the MERGED one-call slot parser
 * since 2026-07-14; the email/SendGrid lane still called `parseSemanticSlotsWithLLM`
 * directly, so the same customer sentence could be comprehended by two different parsers
 * depending only on whether it arrived as a text or an email. `parseSemanticSlotsMergedAware
 * WithLLM` closes that split. This eval pins the three things that can silently break it:
 *
 *  1. The PROJECTION is lossless. Email consumes `SemanticSlotParse`; the merged parser
 *     returns the wider `UnifiedSemanticSlotParse`. A field dropped in the projection is a
 *     comprehension regression on email that NO SMS eval can see.
 *  2. `confidence` maps from `watchConfidence`, NOT the unified `confidence`. The unified
 *     value is the MIN across all three merged jobs, so a low trade score on a turn with no
 *     trade would drag a confident semantic parse under the email acceptance floor (0.76)
 *     and silently drop real watch intent.
 *  3. Both email call sites go through the merged-aware entry point, and the relevance guard
 *     runs BEFORE projection — CLAUDE.md: never act on a model the customer didn't reference
 *     this turn.
 *
 * Deterministic (no LLM) — always runs in ci:eval.
 * Run: npx tsx scripts/email_lane_unified_slot_eval.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { applyMergedWatchRelevanceGuard, type UnifiedSemanticSlotParse } from "../services/api/src/domain/llmDraft.ts";
import { projectUnifiedToSemanticSlots } from "../services/api/src/domain/emailLaneSlots.ts";

const llm = fs.readFileSync("services/api/src/domain/llmDraft.ts", "utf8");
// The cutover entry point lives in its own module so llmDraft.ts keeps shrinking
// under source_size_ratchet:eval — see emailLaneSlots.ts.
const emailLane = fs.readFileSync("services/api/src/domain/emailLaneSlots.ts", "utf8");
const sendgrid = fs.readFileSync("services/api/src/routes/sendgridInbound.ts", "utf8");

/**
 * Whole source text of a top-level exported function: from its declaration to the next
 * top-level `export`. A lazy `\n}` regex does NOT work here — these functions take an inline
 * object type whose own closing `}` lands at column 0 (`}): Promise<...>`), so a lazy match
 * captures the PARAMETER TYPE and silently asserts against the wrong text.
 */
function functionText(src: string, name: string): string {
  const start = src.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} must exist in the source`);
  const next = src.indexOf("\nexport ", start + 1);
  return src.slice(start, next === -1 ? src.length : next);
}

// --- 1) The projection carries every semantic field. ---------------------------------------
const unified: UnifiedSemanticSlotParse = {
  watchAction: "set_watch",
  watch: {
    model: "Road Glide",
    year: "2025",
    yearMin: 2024,
    yearMax: 2026,
    color: "Vivid Black",
    condition: "used",
    minPrice: 15000,
    maxPrice: 28000,
    monthlyBudget: 450,
    downPayment: 3000
  },
  departmentIntent: "service",
  contactPreferenceIntent: "call_only",
  mediaIntent: "photos",
  serviceRecordsIntent: true,
  payoffStatus: "has_lien",
  needsLienHolderInfo: true,
  providesLienHolderInfo: false,
  tradeTargetValue: { amount: 12000, raw: "about 12k" },
  watchConfidence: 0.91,
  payoffConfidence: 0.42,
  tradeTargetConfidence: 0.33,
  confidence: 0.33
};

const projected = projectUnifiedToSemanticSlots(unified);
assert.ok(projected, "a non-null unified parse must project to a non-null semantic parse");
assert.equal(projected.watchAction, "set_watch", "watchAction must carry");
assert.equal(projected.departmentIntent, "service", "departmentIntent must carry");
assert.equal(projected.contactPreferenceIntent, "call_only", "contactPreferenceIntent must carry");
assert.equal(projected.mediaIntent, "photos", "mediaIntent must carry");
assert.equal(projected.serviceRecordsIntent, true, "serviceRecordsIntent must carry");
// The whole watch sub-object, field by field — a dropped price band silently loses the
// customer's stated budget on the email lane.
assert.deepEqual(projected.watch, unified.watch, "every watch slot must carry through unchanged");

// --- 2) confidence comes from the SEMANTIC half, not the three-job minimum. -----------------
// This is the subtle one. unified.confidence is 0.33 here (dragged down by the trade jobs on a
// turn that mentions no trade); the semantic parse itself scored 0.91. Mapping the wrong field
// would put every email watch under the 0.76 floor and drop it.
assert.equal(
  projected.confidence,
  0.91,
  "confidence must map from watchConfidence (the semantic score), never the unified min"
);
assert.notEqual(
  projected.confidence,
  unified.confidence,
  "the unified MIN must not be used as the email lane's semantic confidence"
);

// A parse whose semantic half is genuinely unconfident must stay unconfident.
const lowSemantic = projectUnifiedToSemanticSlots({ ...unified, watchConfidence: 0.12, confidence: 0.12 });
assert.equal(lowSemantic?.confidence, 0.12, "a low semantic score must survive the projection");

// --- 3) null in => null out (the parser declining must not become a fabricated empty parse). --
assert.equal(projectUnifiedToSemanticSlots(null), null, "a null parse must project to null");

// --- 4) Field-coverage ratchet: a NEW semantic field must be added to the projector. ---------
// Extract the top-level field names of SemanticSlotParse straight from the type, so adding a
// field without updating projectUnifiedToSemanticSlots fails HERE rather than in production.
const typeBlock = /export type SemanticSlotParse = \{([\s\S]*?)\n\};/.exec(llm);
assert.ok(typeBlock, "SemanticSlotParse type block must be readable from llmDraft.ts");
const topLevelFields: string[] = [];
{
  let depth = 0;
  for (const raw of typeBlock[1].split("\n")) {
    const line = raw.trim();
    if (depth === 0) {
      const m = /^([a-zA-Z][a-zA-Z0-9_]*)\??:/.exec(line);
      if (m) topLevelFields.push(m[1]);
    }
    depth += (line.match(/\{/g) || []).length - (line.match(/\}/g) || []).length;
  }
}
assert.ok(topLevelFields.length >= 7, `expected the known semantic fields, parsed ${topLevelFields.join(",")}`);
const projectorBody = functionText(emailLane, "projectUnifiedToSemanticSlots");
for (const field of topLevelFields) {
  assert.ok(
    new RegExp(`\\b${field}\\b`).test(projectorBody),
    `SemanticSlotParse.${field} is not carried by projectUnifiedToSemanticSlots — the email lane would silently lose it`
  );
}

// --- 5) The relevance guard runs BEFORE projection, and actually blanks over-attachment. -----
// CLAUDE.md law: never act on a model the customer didn't reference this turn. The merged
// parser's known failure mode is gluing a thread model onto a bare ack.
const overAttached = applyMergedWatchRelevanceGuard(
  { ...unified, watch: { ...unified.watch, model: "Breakout" } },
  "Thanks Joe"
);
const overAttachedProjected = projectUnifiedToSemanticSlots(overAttached);
assert.equal(
  String(overAttachedProjected?.watch?.model ?? ""),
  "",
  'a model the customer never named this turn ("Thanks Joe" -> Breakout) must be blanked before it reaches the email lane'
);
// A model the customer DID name this turn survives.
const named = applyMergedWatchRelevanceGuard(unified, "Do you have a Road Glide coming in?");
assert.equal(
  projectUnifiedToSemanticSlots(named)?.watch?.model,
  "Road Glide",
  "a model the customer named this turn must survive the guard"
);

// --- 6) Source guards: the wiring itself. ---------------------------------------------------
const entryBody = functionText(emailLane, "parseSemanticSlotsMergedAwareWithLLM");
// All four flags gate the cutover — the email flag is its OWN, so email can be reverted
// without reverting SMS.
for (const flag of [
  "LLM_ENABLED",
  "LLM_EMAIL_UNIFIED_SLOT_LIVE",
  "LLM_UNIFIED_SLOT_MERGED_LIVE",
  "LLM_UNIFIED_SLOT_PARSER_ENABLED"
]) {
  assert.ok(entryBody.includes(flag), `the email cutover must be gated on ${flag}`);
}
// The kill switch: flags off => the legacy parser, unchanged. The legacy path IS the revert
// and must not be burned while it is the revert (CLAUDE.md).
assert.ok(
  /if \(!mergedLive\) return parseSemanticSlotsWithLLM\(args\);/.test(entryBody),
  "with the cutover flag off, the email lane must fall back to the legacy parser verbatim"
);
assert.ok(
  /export async function parseSemanticSlotsWithLLM/.test(llm),
  "the legacy semantic parser must still exist — it is the revert for this cutover"
);
assert.ok(
  entryBody.includes("applyMergedWatchRelevanceGuard"),
  "the merged result must pass the model-relevance guard before projection"
);

// Both email call sites go through the merged-aware entry, and NONE calls the legacy parser
// directly any more — otherwise one email path silently keeps the old brain.
assert.ok(
  !/\bparseSemanticSlotsWithLLM\(/.test(sendgrid),
  "sendgridInbound must not call parseSemanticSlotsWithLLM directly — that is the split this cutover closes"
);
const emailCallSites = (sendgrid.match(/parseSemanticSlotsMergedAwareWithLLM\(/g) || []).length;
assert.equal(
  emailCallSites,
  2,
  `both email semantic-slot call sites must use the merged-aware entry point; found ${emailCallSites}`
);

// Parity: the SMS wrapper applies the same relevance guard, so neither lane can act on a model
// the other would have rejected.
const smsWrapper = functionText(llm, "parseUnifiedSemanticSlotsWithLLM");
assert.ok(
  smsWrapper.includes("applyMergedWatchRelevanceGuard"),
  "the SMS wrapper must apply the same relevance guard as the email entry point (two-lane parity)"
);

console.log(
  `email_lane_unified_slot_eval passed (${topLevelFields.length} semantic fields projected, ` +
    `${emailCallSites} email call sites cut over, legacy revert intact)`
);
