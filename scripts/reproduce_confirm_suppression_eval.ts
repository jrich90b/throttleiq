/**
 * Auto-reproduce suppression eval (pure, no IO / no LLM).
 *
 * Pins the DETERMINISTIC core of the fourth classify-step suppression pass (Joe, 2026-07-24:
 * "run the triage in the routines"). The LLM judge (realJudge) that decides whether a turn still
 * reproduces is NOT unit-tested here — like intent_handled:eval, the model call is exercised only
 * in the live sweep. What we CAN and MUST pin is the fail-safe deterministic gating:
 *   - selectReproduceCandidates: only eligible + pinned + ranked, capped, deduped.
 *   - decideConfirmedStale: confirmed ONLY on N clean, matched, passing samples.
 *   - partitionByReproduceConfirm: drops ONLY eligible-dimension confirmed keys; keeps the rest.
 *   - parseReproduceConfirmPayload: null (→ suppress nothing) on malformed / stale / commit-moved.
 *
 * Run: npx tsx scripts/reproduce_confirm_suppression_eval.ts
 */
import assert from "node:assert/strict";

import {
  ELIGIBLE_REPRODUCE_DIMENSIONS,
  isReproduceEligibleDimension,
  extractPinnedMessageId,
  selectReproduceCandidates,
  decideConfirmedStale,
  partitionByReproduceConfirm,
  parseReproduceConfirmPayload
} from "../services/api/src/domain/reproduceConfirm.ts";
import { findingKeyOf } from "../services/api/src/domain/loopPrDedup.ts";

// --- 0) Eligible-dimension set is the intended narrow v1. ---
assert.ok(ELIGIBLE_REPRODUCE_DIMENSIONS.has("corpus_replay_judge_fail"));
assert.ok(ELIGIBLE_REPRODUCE_DIMENSIONS.has("human_correction_material"));
for (const d of ["open_critic_finding", "reported_issue", "thumbs_down_action_request", "cadence_quality_suppressed", "watch_fire_miss", "corpus_replay_regression"]) {
  assert.ok(!isReproduceEligibleDimension(d), `${d} must NOT be reproduce-eligible in v1`);
}

// --- 1) extractPinnedMessageId — from detail or explicit field; null when unresolvable. ---
assert.equal(
  extractPinnedMessageId({ detail: "[replay +15167997012::msg_7ab00102ded33_1784670603505] customer: ..." }),
  "msg_7ab00102ded33_1784670603505"
);
assert.equal(extractPinnedMessageId({ messageId: "msg_3621f52740f28_1784647042472" }), "msg_3621f52740f28_1784647042472");
assert.equal(extractPinnedMessageId({ detail: "staff materially corrected the AI draft (wrong_intent)" }), null);
assert.equal(extractPinnedMessageId({}), null);

// --- 2) selectReproduceCandidates — eligible + pinned + capped + deduped, rank preserved. ---
const wo = (convId: string, dimension: string, detail: string, extra: Record<string, unknown> = {}) => ({ convId, dimension, detail, ...extra });
const ranked = [
  wo("+1111", "corpus_replay_judge_fail", "[replay +1111::msg_a_1] ..."), // eligible + pinned
  wo("+2222", "reported_issue", "operator-reported (routing): no reply"), // ineligible
  wo("+3333", "human_correction_material", "staff corrected", { messageId: "msg_h_3" }), // eligible via field
  wo("+4444", "corpus_replay_judge_fail", "no message id here"), // eligible but UNPINNED → skipped
  wo("+1111", "corpus_replay_judge_fail", "[replay +1111::msg_a_1] dup"), // duplicate key → skipped
  wo("+5555", "corpus_replay_judge_fail", "[replay +5555::msg_e_5] ...") // eligible + pinned
];
const picked = selectReproduceCandidates(ranked, { max: 8 });
assert.deepEqual(picked.map(c => c.convId), ["+1111", "+3333", "+5555"], "only eligible + pinned, deduped, rank-order");
assert.equal(picked[0].pinnedMessageId, "msg_a_1");
assert.equal(picked[1].pinnedMessageId, "msg_h_3");
// Cap is honored and preserves rank (top-N only).
assert.equal(selectReproduceCandidates(ranked, { max: 1 }).length, 1);
assert.equal(selectReproduceCandidates(ranked, { max: 1 })[0].convId, "+1111");
assert.equal(selectReproduceCandidates([], { max: 8 }).length, 0);
assert.equal(selectReproduceCandidates(null, { max: 8 }).length, 0);

// --- 3) decideConfirmedStale — confirmed ONLY on N clean, matched, passing samples. ---
const S = (found: boolean, pass: boolean, messageIdMatch: boolean) => ({ found, pass, messageIdMatch });
assert.equal(decideConfirmedStale([S(true, true, true), S(true, true, true)], { requiredSamples: 2 }), true, "two clean passes → stale");
assert.equal(decideConfirmedStale([S(true, true, true)], { requiredSamples: 2 }), false, "one sample when two required → not stale");
assert.equal(decideConfirmedStale([S(true, true, true), S(true, false, true)], { requiredSamples: 2 }), false, "a still-reproducing sample → not stale");
assert.equal(decideConfirmedStale([S(true, true, true), S(true, true, false)], { requiredSamples: 2 }), false, "a messageId mismatch → not stale");
assert.equal(decideConfirmedStale([S(false, true, true), S(true, true, true)], { requiredSamples: 2 }), false, "a not-found sample → not stale");
assert.equal(decideConfirmedStale([], { requiredSamples: 2 }), false, "zero samples → not stale");
assert.equal(decideConfirmedStale(null, { requiredSamples: 2 }), false, "null samples → not stale");
assert.equal(decideConfirmedStale([S(true, true, true)], { requiredSamples: 1 }), true, "single-sample mode when explicitly configured");

// --- 4) partitionByReproduceConfirm — drops ONLY eligible + confirmed keys; keeps the rest. ---
const feed = [
  wo("+1111", "corpus_replay_judge_fail", "..."), // confirmed stale → suppressed
  wo("+3333", "human_correction_material", "..."), // eligible but NOT confirmed → kept (still reproduces)
  wo("+2222", "reported_issue", "..."), // ineligible → kept even if its key were in the set
  wo("", "corpus_replay_judge_fail", "...") // empty convId → unkeyable → kept
];
const confirmedStaleKeys = new Set([
  findingKeyOf("+1111", "corpus_replay_judge_fail"),
  findingKeyOf("+2222", "reported_issue") // present but dimension ineligible → must NOT drop
]);
const part = partitionByReproduceConfirm(feed, { confirmedStaleKeys });
assert.deepEqual(part.suppressed.map(s => s.anomaly.convId), ["+1111"], "only the eligible confirmed key is dropped");
assert.deepEqual(part.kept.map(k => k.convId), ["+3333", "+2222", ""], "still-reproducing / ineligible / unkeyable are kept");
// Empty key set (no sweep) → suppress nothing.
assert.equal(partitionByReproduceConfirm(feed, { confirmedStaleKeys: new Set() }).suppressed.length, 0);
assert.equal(partitionByReproduceConfirm(feed, {}).suppressed.length, 0);

// --- 5) parseReproduceConfirmPayload — fail-safe (null → suppress nothing). ---
const NOW = Date.parse("2026-07-24T18:00:00.000Z");
const COMMIT = "c68c9efd";
const good = {
  generatedAt: "2026-07-24T17:50:00.000Z",
  commit: COMMIT,
  confirmed: [
    { convId: "+1111", dimension: "corpus_replay_judge_fail", key: "+1111::corpus_replay_judge_fail", verdict: "no_longer_reproduces" },
    { convId: "+9999", dimension: "reported_issue", key: "+9999::reported_issue" } // ineligible → filtered out
  ]
};
const parsed = parseReproduceConfirmPayload(good, { nowMs: NOW, deployedCommit: COMMIT });
assert.ok(parsed, "well-formed + fresh + commit-match → parsed");
assert.deepEqual([...parsed!.keys], ["+1111::corpus_replay_judge_fail"], "only eligible-dimension entries survive");
assert.equal(parsed!.verdictByKey.get("+1111::corpus_replay_judge_fail"), "no_longer_reproduces");

assert.equal(parseReproduceConfirmPayload(good, { nowMs: NOW, deployedCommit: "DEADBEEF" }), null, "commit moved → null");
assert.equal(parseReproduceConfirmPayload(good, { nowMs: NOW, deployedCommit: "" }), null, "no deployed commit → null");
assert.equal(parseReproduceConfirmPayload({ ...good, commit: "" }, { nowMs: NOW, deployedCommit: COMMIT }), null, "empty payload commit → null");
assert.equal(
  parseReproduceConfirmPayload({ ...good, generatedAt: "2026-07-19T00:00:00.000Z" }, { nowMs: NOW, deployedCommit: COMMIT }),
  null,
  "stale (>3d) → null"
);
assert.equal(parseReproduceConfirmPayload({ generatedAt: "not-a-date", commit: COMMIT, confirmed: [] }, { nowMs: NOW, deployedCommit: COMMIT }), null, "bad date → null");
assert.equal(parseReproduceConfirmPayload({ commit: COMMIT, confirmed: [] }, { nowMs: NOW, deployedCommit: COMMIT }), null, "missing generatedAt → null");
assert.equal(parseReproduceConfirmPayload({ generatedAt: "2026-07-24T17:50:00.000Z", commit: COMMIT }, { nowMs: NOW, deployedCommit: COMMIT }), null, "missing confirmed[] → null");
assert.equal(parseReproduceConfirmPayload(null, { nowMs: NOW, deployedCommit: COMMIT }), null, "null payload → null");
assert.equal(parseReproduceConfirmPayload("nope", { nowMs: NOW, deployedCommit: COMMIT }), null, "non-object → null");

console.log("PASS reproduce-confirm suppression eval — eligibility + pinned selection + N-sample confirm gate + eligible-only partition + fresh/commit-bound parse fail-safe");
