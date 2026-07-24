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
import { isTruncatedDraftBody } from "../services/api/src/domain/draftQualityGate.ts";

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

// --- 2b) OBEY-THE-NOTE: an action_request instruction becomes the CONTROLLING directive (Joe ruling
// 7/23; conv +17693591448 — the note "Tell the customer to stop in when they are in town" was ignored
// and the redraft re-offered tee shipping). ---
const controlled = buildFeedbackRedraftSteering(
  "shipping",
  "Tell the customer to stop in when they are in town",
  "Tell the customer to stop in when they are in town"
);
assert.match(controlled, /MUST follow/i, "a controlling instruction is framed as a directive to obey");
assert.match(controlled, /stop in when they are in town/, "the instruction text is carried verbatim");
assert.match(controlled, /never fabricate/i, "the controlling steering keeps the no-fabrication guardrail");
// The decision must thread the controlling instruction into the steering it hands back.
const controlledDecision = decideFeedbackRedraftTurn({
  enabled: true,
  rating: "down",
  ratedIsPendingDraft: true,
  note: "Tell the customer to stop in when they are in town",
  controllingInstruction: "Tell the customer to stop in when they are in town"
});
assert.equal(controlledDecision.kind, "redraft", "a down on a pending draft still redrafts");
assert.match(
  String(controlledDecision.steering ?? ""),
  /MUST follow/i,
  "the controlling instruction reaches the redraft steering"
);
// No controlling instruction → the generic 'fix the issue' steering (unchanged behavior).
const generic = buildFeedbackRedraftSteering("too pushy", "they asked for options");
assert.doesNotMatch(generic, /MUST follow/i, "without an instruction the steering stays the generic fix hint");

// --- 2c) TRUNCATED-BODY invariant (Joe ruling 7/23): a draft cut off mid-clause never surfaces. ---
const truncated = [
  "Mississippi sounds nice — Gulf life has its perks, I", // the exact production draft
  "I can ship a black tee to you, and", // dangling conjunction
  "Let me check on that for you,", // trailing comma
  "Happy to help with the" // dangling article
];
for (const t of truncated) {
  assert.equal(isTruncatedDraftBody(t), true, `truncated draft should be flagged: ${JSON.stringify(t)}`);
}
const complete = [
  "I can ship an “American H‑D, North Tonawanda, NY” black tee to Biloxi. What size do you wear?",
  "Sounds good — see you Saturday!",
  "Thank you", // common ender left alone
  "Go for it 🏍️",
  "Yes it is", // 'is' final is a legit complete reply — never flagged
  "" // empty is not a truncation (nothing to publish)
];
for (const c of complete) {
  assert.equal(isTruncatedDraftBody(c), false, `complete draft should NOT be flagged: ${JSON.stringify(c)}`);
}

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
const helper = api.slice(helperStart, helperStart + 4200);
assert.match(helper, /decideFeedbackRedraftTurn\(/, "redraft must route through the pure gate");
assert.match(helper, /feedbackDownRedraftEnabled\(\)/, "redraft must be behind the kill switch");
assert.match(helper, /provider === "draft_ai" && ratedMsg\?\.draftStatus !== "stale"/, "only a still-pending draft redrafts");
assert.match(helper, /generateDraftWithLLM\(/, "redraft uses the generation layer (steered), not a routing change");
assert.match(helper, /steering: decision\.steering/, "the rep's steering is fed to the generator");
assert.match(helper, /parseThumbsDownNoteWithLLM\(/, "an action-request note is classified parser-first (obey-the-note)");
assert.match(helper, /controllingInstruction/, "an action-request note becomes the controlling redraft instruction");
assert.match(helper, /isTruncatedDraftBody\(redraft\)/, "a truncated redraft is never published");
assert.match(helper, /saveOperatorDraft\(/, "redraft publishes as a reviewable draft (never sends)");
// The main draft chokepoint holds a truncated draft too (covers the ORIGINAL draft, not just redrafts).
assert.match(
  api,
  /isTruncatedDraftBody\(invariant\.draftText\)/,
  "publishCustomerReplyDraft holds a truncated draft at the shared live+regen chokepoint"
);
for (const sendToken of [/finalizeDraftAsSent\(/, /\/send\b/]) {
  assert.ok(!sendToken.test(helper), `redraft helper must NEVER send (${sendToken})`);
}

console.log("PASS feedback redraft eval (decision table + steering + safe-wiring source guard)");
