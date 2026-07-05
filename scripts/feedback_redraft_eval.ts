/**
 * Feedback-driven redraft eval (closed-loop Phase 1, 2026-06-24).
 *
 * A staff thumbs-DOWN on a still-pending AI draft re-generates the reply with the rep's reason as
 * steering and drops it back in the console box (suggest mode — a human still hits Send). This pins
 * the pure gate + steering, and guards that the wiring stays safe + de-tangle-honoring:
 *  - only a DOWN on a still-editable (non-stale draft_ai) draft redrafts; up / sent / disabled =
 *    record-only (today's behavior, the fail-safe direction).
 *  - the redraft is the generation/voice layer (generateDraftWithLLM + steering), NOT a routing
 *    change, and publishes via saveOperatorDraft (never sends).
 *
 * Run: npx tsx scripts/feedback_redraft_eval.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  decideFeedbackRedraftTurn,
  buildFeedbackRedraftSteering
} from "../services/api/src/domain/routeStateReducer.ts";

// --- 1) Pure decision table. ---
type Row = {
  id: string;
  input: Parameters<typeof decideFeedbackRedraftTurn>[0];
  kind: "redraft" | "record_only";
};
const rows: Row[] = [
  { id: "disabled", input: { enabled: false, rating: "down", ratedIsPendingDraft: true }, kind: "record_only" },
  { id: "thumbs_up", input: { enabled: true, rating: "up", ratedIsPendingDraft: true }, kind: "record_only" },
  { id: "down_on_sent", input: { enabled: true, rating: "down", ratedIsPendingDraft: false }, kind: "record_only" },
  { id: "down_on_pending_draft", input: { enabled: true, rating: "down", ratedIsPendingDraft: true }, kind: "redraft" },
  { id: "case_insensitive", input: { enabled: true, rating: "DOWN", ratedIsPendingDraft: true }, kind: "redraft" }
];
for (const r of rows) {
  const d = decideFeedbackRedraftTurn(r.input);
  assert.equal(d.kind, r.kind, `decideFeedbackRedraftTurn[${r.id}] expected ${r.kind}, got ${d.kind}`);
  if (r.kind === "redraft") {
    assert.ok(d.steering && d.steering.length > 0, `[${r.id}] a redraft decision must carry steering`);
  } else {
    assert.ok(!d.steering, `[${r.id}] record_only must not carry steering`);
  }
}

// --- 2) Steering content. ---
const steered = buildFeedbackRedraftSteering("too pushy", "they asked for options, not a visit");
assert.match(steered, /thumbs-down/i, "steering names the negative signal");
assert.match(steered, /too pushy/, "steering carries the rep's reason");
assert.match(steered, /options, not a visit/, "steering carries the rep's note");
assert.match(steered, /never fabricate/i, "steering keeps the no-fabrication guardrail");
// No reason/note → still a valid instruction, no stray "undefined".
const bare = buildFeedbackRedraftSteering();
assert.ok(bare.length > 0 && !/undefined|null/.test(bare), "bare steering is valid and clean");

// --- 3) Source guard (wiring stays safe + de-tangle-honoring). ---
const api = fs.readFileSync("services/api/src/index.ts", "utf8");
assert.match(
  api,
  /app\.post\("\/conversations\/:id\/messages\/:messageId\/feedback", async \(req, res\) =>/,
  "the feedback handler must be async (it awaits the redraft)"
);
assert.match(
  api,
  /rating === "down"\)\s*\{\s*redraft = await maybeRedraftOnNegativeFeedback/,
  "a thumbs-down must invoke the redraft path"
);
const helperStart = api.indexOf("async function maybeRedraftOnNegativeFeedback");
assert.ok(helperStart > 0, "the redraft helper must exist");
const helper = api.slice(helperStart, helperStart + 2600);
assert.match(helper, /decideFeedbackRedraftTurn\(/, "redraft must route through the pure gate");
assert.match(helper, /feedbackDownRedraftEnabled\(\)/, "redraft must be behind the kill switch");
assert.match(helper, /provider === "draft_ai" && ratedMsg\?\.draftStatus !== "stale"/, "only a still-pending draft redrafts");
assert.match(helper, /generateDraftWithLLM\(/, "redraft uses the generation layer (steered), not a routing change");
assert.match(helper, /steering: decision\.steering/, "the rep's steering is fed to the generator");
assert.match(helper, /saveOperatorDraft\(/, "redraft publishes as a reviewable draft (never sends)");
for (const sendToken of [/finalizeDraftAsSent\(/, /\/send\b/]) {
  assert.ok(!sendToken.test(helper), `redraft helper must NEVER send (${sendToken})`);
}

console.log("PASS feedback redraft eval (decision table + steering + safe-wiring source guard)");
