/**
 * Conversation outcome-audit eval (2026-06-25) — Phase 2 detection feed.
 *
 * Pins the deterministic state/side-effect anomaly detectors in
 * services/api/src/domain/conversationOutcomeAudit.ts: each contradiction trips exactly its dimension,
 * a healthy conversation trips nothing, and the store-level orphan-todo + summary roll-up are correct.
 * This is the "healthy = 0 anomalies" detection net the self-healing loop consumes.
 *
 * Run: npx tsx scripts/conversation_outcome_audit_eval.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.CONVERSATIONS_DB_PATH =
  process.env.CONVERSATIONS_DB_PATH || path.join(os.tmpdir(), `outcome-audit-eval-${Date.now()}.json`);
const { auditConversationOutcome, auditConversationStore } = await import(
  "../services/api/src/domain/conversationOutcomeAudit.ts"
);

const NOW = new Date("2026-06-25T18:00:00.000Z");
const dims = (conv: any) => auditConversationOutcome(conv, { now: NOW }).map(a => a.dimension).sort();
let n = 0;
const eq = (a: unknown, b: unknown, m: string) => { assert.deepEqual(a, b, m); n++; };

// --- 1. appointment confirmed with no calendar event. ---
eq(dims({ id: "c1", appointment: { status: "confirmed", whenText: "Sat 1 PM" } }), ["appointment_confirmed_no_event"], "confirmed + no bookedEventId => anomaly");
eq(dims({ id: "c1b", appointment: { status: "confirmed", bookedEventId: "evt1", whenText: "Sat 1 PM" } }), [], "confirmed WITH bookedEventId => clean");

// --- 2. inventory watch active on a closed/sold conv. ---
eq(dims({ id: "c2", closedReason: "sold", inventoryWatch: { status: "active" } }), ["watch_active_on_closed"], "active watch on closed => anomaly");
eq(dims({ id: "c2b", inventoryWatch: { status: "active" } }), [], "active watch on OPEN conv => clean");
eq(dims({ id: "c2c", closedReason: "sold", inventoryWatches: [{ status: "active" }] }), ["watch_active_on_closed"], "active watch (array form) on closed => anomaly");
eq(dims({ id: "c2d", closedReason: "other", inventoryWatch: { status: "active" }, inventoryWatches: [{ status: "paused" }] }), ["watch_active_on_closed"], "active SINGLE + paused array on closed => flagged (union, the 6/25 leak)");
eq(dims({ id: "c2e", closedReason: "other", inventoryWatch: { status: "paused" }, inventoryWatches: [{ status: "paused" }] }), [], "all watches paused on closed => clean (heal succeeded)");

// --- 3. cadence active on a closed conv (post_sale is legit). ---
eq(dims({ id: "c3", closedReason: "not_interested", followUpCadence: { status: "active", kind: "standard" } }), ["cadence_active_on_closed"], "active standard cadence on closed => anomaly");
eq(dims({ id: "c3b", sale: { soldAt: "2026-06-20T00:00:00Z" }, closedReason: "sold", followUpCadence: { status: "active", kind: "post_sale" } }), [], "post_sale cadence on a sold conv => legit, clean");

// --- 4. cadence active while handed off (regression — a heal exists). ---
{
  const a = auditConversationOutcome({ id: "c4", followUpCadence: { status: "active", kind: "standard" }, followUp: { mode: "manual_handoff" } }, { now: NOW });
  eq(a.map(x => x.dimension), ["cadence_active_while_handoff"], "active standard cadence + manual_handoff => anomaly");
  eq(a[0].healed, true, "cadence_active_while_handoff is flagged as a heal-regression");
}
// CARVE-OUT: long_term / post_sale cadences are INTENTIONALLY kept through a handoff (match the heal) —
// flagging them would be a false positive (model the engine's hold conditions).
eq(dims({ id: "c4b", followUpCadence: { status: "active", kind: "long_term" }, followUp: { mode: "manual_handoff" } }), [], "long_term cadence on handoff is kept => NOT flagged");
eq(dims({ id: "c4c", followUpCadence: { status: "active", kind: "post_sale" }, followUp: { mode: "manual_handoff" } }), [], "post_sale cadence on handoff is kept => NOT flagged");

// --- 5. held draft: STATE-cleanup (reply after) vs COMPREHENSION-miss (still blocking) — exclusive. ---
const held = { id: "c5", draftHeld: { at: "2026-06-25T01:00:00.000Z", heldKind: "context_fidelity", frame: "stale_intent" } };
eq(dims({ ...held, messages: [{ direction: "out", provider: "twilio", at: "2026-06-25T01:05:00.000Z", body: "hi" }] }), ["stale_held_flag"], "real reply AFTER the hold => stale_held_flag (state cleanup)");
eq(dims({ ...held, messages: [{ direction: "out", provider: "twilio", at: "2026-06-25T00:30:00.000Z", body: "hi" }] }), ["held_draft_unresolved"], "reply BEFORE the hold, still blocking => held_draft_unresolved (comprehension)");
eq(dims({ ...held, messages: [{ direction: "out", provider: "draft_ai", at: "2026-06-25T01:05:00.000Z", body: "draft" }] }), ["held_draft_unresolved"], "only a draft_ai after the hold (not a real reply) => still unresolved");
{
  const a = auditConversationOutcome({ ...held, messages: [] }, { now: NOW });
  eq(a.map(x => x.dimension), ["held_draft_unresolved"], "held + no messages => unresolved comprehension miss");
  eq(a[0].category, "comprehension", "held_draft_unresolved is category=comprehension");
  eq(a[0].severity, "P1", "held_draft_unresolved is P1");
}

// --- 5b. context-fidelity SHADOW unresolved (Net 1): the scorer flagged out-of-context, shadow let it
//         publish, and NO corrective reply followed. A DIFFERENT reply after the flag = resolved. ---
const cfs = {
  id: "c5b",
  contextFidelityShadow: {
    at: "2026-06-25T01:00:00.000Z",
    severity: "major",
    frame: "wrong_lead_type",
    reason: "non-buyer survey got a sales pitch",
    draftPreview: "Which bike are you asking about?"
  }
};
{
  const a = auditConversationOutcome({ ...cfs, messages: [] }, { now: NOW });
  eq(a.map(x => x.dimension), ["context_fidelity_shadow_unresolved"], "shadow major + no corrective reply => unresolved comprehension miss");
  eq(a[0].category, "comprehension", "context_fidelity_shadow_unresolved is category=comprehension");
  eq(a[0].severity, "P2", "context_fidelity_shadow_unresolved is P2");
}
// The out-of-context draft sent AS-IS (same body after the flag) is NOT a correction => still fires.
eq(dims({ ...cfs, messages: [{ direction: "out", provider: "twilio", at: "2026-06-25T01:00:05.000Z", body: "Which bike are you asking about?" }] }), ["context_fidelity_shadow_unresolved"], "same draft sent as-is after the flag => still unresolved");
// A DIFFERENT reply after the flag (edited/regenerated/human) => corrected => resolved (no fire).
eq(dims({ ...cfs, messages: [{ direction: "out", provider: "twilio", at: "2026-06-25T01:05:00.000Z", body: "Thanks for reaching out — no pressure at all." }] }), [], "a different reply after the flag => corrected, resolved");
// MINOR severity is not actionable => never fires.
eq(dims({ id: "c5c", contextFidelityShadow: { at: "2026-06-25T01:00:00.000Z", severity: "minor", frame: "dropped_anchor", draftPreview: "x" } }), [], "minor shadow flag => not surfaced");

// --- 5c. material HUMAN CORRECTION (Net 2): a staff edit the diff-judge found material → surfaced
//         (recent only); cosmetic edits are never recorded so they never reach this detector. ---
{
  const a = auditConversationOutcome(
    { id: "c5d", humanCorrection: { at: "2026-06-25T01:00:00.000Z", category: "wrong_lead_type", reason: "pitched a non-buyer" } },
    { now: NOW }
  );
  eq(a.map(x => x.dimension), ["human_correction_material"], "recent material correction => surfaced");
  eq(a[0].category, "comprehension", "human_correction_material is category=comprehension");
  eq(a[0].severity, "P2", "human_correction_material is P2");
}
// Older than the 21-day window => aged out (the loop already had its chance; dedup handles recurrence).
eq(dims({ id: "c5e", humanCorrection: { at: "2026-05-01T00:00:00.000Z", category: "wrong_fact" } }), [], "material correction older than 21d => not surfaced");

// --- 6. unaddressed 👎 on the LATEST outbound (a newer outbound clears it). ---
{
  const a = auditConversationOutcome({ id: "c6", messages: [{ direction: "out", provider: "twilio", at: "t1", body: "reply", feedback: { rating: "down" } }] }, { now: NOW });
  eq(a.map(x => x.dimension), ["negative_feedback"], "latest outbound thumbed-down => negative_feedback");
  eq(a[0].category, "feedback", "negative_feedback is category=feedback");
}
eq(dims({ id: "c6b", messages: [{ direction: "out", provider: "twilio", at: "t1", body: "bad", feedback: { rating: "down" } }, { direction: "out", provider: "draft_ai", at: "t2", body: "redraft" }] }), [], "a newer outbound after the 👎 => addressed, clean");
eq(dims({ id: "c6c", messages: [{ direction: "out", provider: "twilio", at: "t1", body: "good", feedback: { rating: "up" } }] }), [], "thumbs-UP => not an anomaly");

// --- A fully healthy conv trips nothing. ---
eq(dims({ id: "ok", appointment: { status: "confirmed", bookedEventId: "e", whenText: "x" }, followUpCadence: { status: "active", kind: "standard" }, followUp: { mode: "active" } }), [], "healthy conv => zero anomalies");

// --- Store-level: orphan todos + summary roll-up. ---
const store = auditConversationStore({
  conversations: [
    { id: "+1", appointment: { status: "confirmed", whenText: "x" } }, // appointment_confirmed_no_event (P1)
    { id: "+2", followUpCadence: { status: "active", kind: "standard" }, followUp: { mode: "manual_handoff" } } // cadence_active_while_handoff (P1, healed)
  ],
  todos: [
    { convId: "+1", status: "open", summary: "real todo" }, // conv exists => not orphan
    { convId: "+gone", status: "open", summary: "stale" }, // orphan (P2)
    { convId: "+also_gone", status: "done", summary: "closed" } // done => ignored
  ],
  now: NOW
});
eq(store.summary.totalAnomalies, 3, "2 conv anomalies + 1 orphan todo");
eq(store.summary.byDimension["orphan_todo"], 1, "one orphan todo");
eq(store.summary.byCategory.state, 3, "all 3 here are state-category");
eq(store.summary.bySeverity.P1, 2, "two P1 (confirmed-no-event + cadence-while-handoff)");
eq(store.summary.regressionAnomalies, 1, "one regression (the healed cadence_active_while_handoff)");
eq(store.summary.conversationsScanned, 2, "scanned count");

// --- Source guards: the sweep writes the feed; the module exports the detectors. ---
const sweep = fs.readFileSync("scripts/conversation_outcome_audit.ts", "utf8");
assert.match(sweep, /auditConversationStore\(\{ conversations: convs, todos, now: new Date\(\) \}\)/, "sweep runs the store audit");
assert.match(sweep, /outcome_audit/, "sweep writes the outcome_audit feed");
const mod = fs.readFileSync("services/api/src/domain/conversationOutcomeAudit.ts", "utf8");
assert.match(mod, /export function auditConversationOutcome/, "per-conv detector exported");
assert.match(mod, /export function auditConversationStore/, "store auditor exported");

// --- Net 1 wiring: the publish path PERSISTS the shadow verdict; a correction sink CLEARS it. ---
const idx = fs.readFileSync("services/api/src/index.ts", "utf8");
assert.match(idx, /\(args\.conv as any\)\.contextFidelityShadow = \{/, "publishCustomerReplyDraft persists the shadow verdict (Net 1)");
assert.match(idx, /String\(cfHold\.severity \?\? ""\)\.toLowerCase\(\) === "major"/, "only MAJOR would-holds are persisted (actionable subset)");
const storeSrc = fs.readFileSync("services/api/src/domain/conversationStore.ts", "utf8");
assert.match(storeSrc, /\(conv as any\)\.contextFidelityShadow = null/, "an operator/passing draft clears the shadow flag (correction sink)");

// --- Net 2 wiring: a typed LLM diff-judge + the send-path recorder that persists material corrections. ---
const llm = fs.readFileSync("services/api/src/domain/llmDraft.ts", "utf8");
assert.match(llm, /export async function classifyDraftEditWithLLM/, "the material-vs-cosmetic diff-judge exists (LLM, not regex)");
assert.match(llm, /DRAFT_EDIT_JUDGE_JSON_SCHEMA/, "the diff-judge uses a typed structured-output schema");
assert.match(idx, /maybeRecordDraftEditCorrection\(conv, fin/, "the send path records a staff edit (both email + sms sites)");
assert.match(idx, /\(conv as any\)\.humanCorrection = \{/, "a MATERIAL correction is persisted on the conversation");
assert.match(idx, /if \(!verdict \|\| !verdict\.isMaterial\) return/, "cosmetic edits are NOT recorded (material only)");
assert.ok((idx.match(/maybeRecordDraftEditCorrection\(conv, fin/g) ?? []).length >= 2, "wired at both successful send sites (email + twilio)");
// The classifier routes it by category (comprehension → parser_fix_candidate, Tier 1, notify) with no
// dimension whitelist — so the new dimension flows through automatically.
{
  const { classifyOutcomeAnomaly } = await import("../services/api/src/domain/anomalyClassifier.ts");
  const c = classifyOutcomeAnomaly(
    { category: "comprehension", dimension: "context_fidelity_shadow_unresolved", healed: false, severity: "P2" },
    {}
  );
  eq(c.action, "parser_fix_candidate", "shadow comprehension anomaly classifies as parser_fix_candidate");
  eq(c.tier, 1, "parser_fix_candidate is Tier 1");
  eq(c.notify, true, "comprehension fix candidate notifies Joe");
  eq(c.autoMergeEligible, false, "starts non-graduated (PR + notify, no auto-merge)");
  const hcCls = classifyOutcomeAnomaly(
    { category: "comprehension", dimension: "human_correction_material", healed: false, severity: "P2" },
    {}
  );
  eq(hcCls.action, "parser_fix_candidate", "human_correction_material → parser_fix_candidate (Net 2)");
  eq(hcCls.notify, true, "a human correction notifies Joe");
}
n += 4;

console.log(`PASS conversation outcome-audit eval (${n} assertions)`);
