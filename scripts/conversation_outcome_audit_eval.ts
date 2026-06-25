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

// --- 5. stale held flag (real reply after the hold; draft_ai does NOT count). ---
const held = { id: "c5", draftHeld: { at: "2026-06-25T01:00:00.000Z" } };
eq(dims({ ...held, messages: [{ direction: "out", provider: "twilio", at: "2026-06-25T01:05:00.000Z", body: "hi" }] }), ["stale_held_flag"], "real reply after the hold => anomaly");
eq(dims({ ...held, messages: [{ direction: "out", provider: "twilio", at: "2026-06-25T00:30:00.000Z", body: "hi" }] }), [], "reply BEFORE the hold => clean (fresh hold)");
eq(dims({ ...held, messages: [{ direction: "out", provider: "draft_ai", at: "2026-06-25T01:05:00.000Z", body: "draft" }] }), [], "a draft_ai after the hold is NOT a real reply => clean");

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
n += 4;

console.log(`PASS conversation outcome-audit eval (${n} assertions)`);
