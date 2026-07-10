import { strict as assert } from "node:assert";
import fs from "node:fs";

/**
 * Thumbs-down NOTE routing eval (2026-07-10).
 *
 * A 👎 note does one of two jobs: it INSTRUCTS a person to act for a live customer ("book him in at
 * 9:30") or it reports a code DEFECT ("wrong unit"). The old path funneled every note into the
 * code-fix classifier, and its shadow report ignores anything it hasn't seen 3+ times — so a one-off
 * "book him in" evaporated and the customer kept waiting.
 *
 * Pins: (1) decideThumbsDownNoteRouting — action_request + unclear + low-confidence ALL fail toward a
 * human (staff_action); only a CONFIDENT reply_defect / coaching leaves the human lane. (2) the mapper
 * decideThumbsDownActionAnomaly — emits ONLY for staff_action, stamps the exact rated-at as occurredAt
 * (a real event time, unlike an operator report's upper bound). (3) the classifier escalates the new
 * dimension Tier 2 (notify, never auto-merge, even if graduated). (4) the sweep + detect wiring.
 */

const { decideThumbsDownNoteRouting } = await import("../services/api/src/domain/routeStateReducer.ts");
const { classifyOutcomeAnomaly } = await import("../services/api/src/domain/anomalyClassifier.ts");
const { decideThumbsDownActionAnomaly } = await import("../services/api/src/domain/conversationOutcomeAudit.ts");

const MIN = 0.7;
const route = (over: any = {}) =>
  decideThumbsDownNoteRouting({ parserAccepted: true, noteKind: "reply_defect", confidence: 0.9, confidenceMin: MIN, ...over });

// 1. ROUTING — fail-direction is the whole point.
// A live-customer instruction ALWAYS goes to a human, regardless of confidence.
assert.equal(route({ noteKind: "action_request", confidence: 0.9 }), "staff_action", "action_request => staff_action");
assert.equal(route({ noteKind: "action_request", confidence: 0.3 }), "staff_action", "even LOW-confidence action_request => staff_action (never dropped)");
// Ambiguous or parser-off => a human reads it.
assert.equal(route({ noteKind: "unclear", confidence: 0.95 }), "staff_action", "unclear => staff_action");
assert.equal(route({ parserAccepted: false }), "staff_action", "parser off/failed => staff_action (never silently dropped)");
// A non-action classification is trusted only when confident; an unsure 'coaching' could be a missed action.
assert.equal(route({ noteKind: "coaching", confidence: 0.4 }), "staff_action", "low-confidence coaching => staff_action (could be a missed action)");
assert.equal(route({ noteKind: "reply_defect", confidence: 0.4 }), "staff_action", "low-confidence reply_defect => staff_action");
// Confident non-action notes leave the human lane.
assert.equal(route({ noteKind: "reply_defect", confidence: 0.9 }), "reply_defect", "confident reply_defect => code-fix diagnosis lane");
assert.equal(route({ noteKind: "coaching", confidence: 0.9 }), "record_only", "confident coaching => record_only");

// 2. MAPPER — emits only for staff_action, with a true occurredAt.
{
  const at = "2026-07-10T14:00:00.000Z";
  const a = decideThumbsDownActionAnomaly({
    convId: "+17169904133",
    leadKey: "+17169904133",
    note: "Book him In at 9:30 today",
    route: "staff_action",
    actionSummary: "Book him in at 9:30 today",
    ratedAt: at
  });
  assert(a, "staff_action => anomaly");
  assert.equal(a!.dimension, "thumbs_down_action_request", "dimension");
  assert.equal(a!.category, "feedback", "feedback category");
  assert.equal(a!.convId, "+17169904133", "convId carried");
  assert.equal(a!.occurredAt, at, "the 👎 rated-at is a TRUE occurredAt (exact reply anchor, not an upper bound)");
  assert.ok(/Book him in at 9:30/.test(a!.detail) && /staff action/.test(a!.detail), "detail carries the action + note");
}
// Non-staff routes never emit here — they belong to the existing code-fix diagnosis lane.
assert.equal(decideThumbsDownActionAnomaly({ convId: "+1", note: "wrong unit", route: "reply_defect" }), null, "reply_defect => no staff anomaly");
assert.equal(decideThumbsDownActionAnomaly({ convId: "+1", note: "too wordy", route: "record_only" }), null, "record_only => no staff anomaly");
assert.equal(decideThumbsDownActionAnomaly({ convId: "", note: "x", route: "staff_action" }), null, "no convId => null");
assert.equal(decideThumbsDownActionAnomaly({ convId: "+1", note: "", route: "staff_action" }), null, "empty note => null");
// No rated-at => omit occurredAt rather than invent one.
assert.equal(
  decideThumbsDownActionAnomaly({ convId: "+1", note: "book him in", route: "staff_action", ratedAt: "" })!.occurredAt,
  undefined,
  "no rated-at => no occurredAt (never invented)"
);

// 3. CLASSIFICATION — Tier 2 escalate, notify, never auto-merge (even if the dimension graduates).
{
  const a = decideThumbsDownActionAnomaly({ convId: "+1", note: "book him in", route: "staff_action", ratedAt: "2026-07-10T00:00:00Z" })!;
  const cls = classifyOutcomeAnomaly(a, {});
  assert.equal(cls.tier, 2, "Tier 2");
  assert.equal(cls.action, "escalate", "escalate (surface to a human)");
  assert.equal(cls.notify, true, "notify");
  assert.equal(cls.autoMergeEligible, false, "never auto-merge (there is no code to merge)");
  assert.equal(
    classifyOutcomeAnomaly(a, { graduatedCategories: new Set(["thumbs_down_action_request"]) }).autoMergeEligible,
    false,
    "stays approve-first even if graduated"
  );
}

// 4. WIRING — the sweep uses the parser+policy+mapper, and detect merges its sibling feed.
const sweep = fs.readFileSync("scripts/thumbs_down_action_sweep.ts", "utf8");
assert.match(sweep, /parseThumbsDownNoteWithLLM/, "sweep uses the note parser");
assert.match(sweep, /decideThumbsDownNoteRouting/, "sweep routes via the pure policy");
assert.match(sweep, /decideThumbsDownActionAnomaly/, "sweep maps to the anomaly");
assert.match(sweep, /isPendingDraft/, "sweep skips unsent drafts (SENT-only)");
const det = fs.readFileSync("scripts/anomaly_loop_detect.ts", "utf8");
assert.match(det, /"thumbs_down_action", "latest\.json"/, "anomaly_loop_detect merges the thumbs-down staff-action feed");

console.log("PASS thumbs_down_action eval");
