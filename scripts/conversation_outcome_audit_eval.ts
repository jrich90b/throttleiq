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
const { auditConversationOutcome, auditConversationStore, decideOpenCriticAnomaly, summarizeTurnActions } = await import(
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

// --- 2b. watch FIRED on the wrong model: a trim-specific watch notified a less-specific (base) unit. ---
const RECENT_FIRE = "2026-06-25T01:00:00.000Z"; // within the 14d window of NOW
const STALE_FIRE = "2026-06-01T00:00:00.000Z"; // > 14d before NOW
eq(dims({ id: "w1", inventoryWatch: { model: "Street Glide Special", lastNotifiedModel: "Street Glide", lastNotifiedAt: RECENT_FIRE } }), ["watch_fired_wrong_model"], "trim-specific watch notified a base unit (the Jason bug) => anomaly");
eq(dims({ id: "w2", inventoryWatch: { model: "Street Glide", lastNotifiedModel: "Street Glide Special", lastNotifiedAt: RECENT_FIRE } }), [], "base watch notified a more-specific unit (directional-correct) => clean");
eq(dims({ id: "w3", inventoryWatch: { model: "Breakout", lastNotifiedModel: "Breakout", lastNotifiedAt: RECENT_FIRE } }), [], "exact same model => clean");
eq(dims({ id: "w4", inventoryWatch: { model: "Electra Glide Ultra Classic", lastNotifiedModel: "Ultra Limited", lastNotifiedAt: RECENT_FIRE } }), [], "different families (neither includes the other) => NOT this detector (scoped to the LLM open-critic, avoids family false-positives)");
eq(dims({ id: "w5", inventoryWatch: { model: "CVO Street Glide", lastNotifiedModel: "Street Glide", lastNotifiedAt: RECENT_FIRE } }), ["watch_fired_wrong_model"], "CVO watch notified a non-CVO base unit => anomaly (CVO is strictly more specific)");
eq(dims({ id: "w6", inventoryWatch: { model: "Street Glide Special", lastNotifiedModel: "Street Glide", lastNotifiedAt: STALE_FIRE } }), [], "wrong-model fire OUTSIDE the 14d window => aged out, clean (fresh signal only)");
eq(dims({ id: "w7", inventoryWatch: { model: "Street Glide Special" } }), [], "watch never fired (no lastNotifiedModel) => clean");
eq(dims({ id: "w8", inventoryWatches: [{ model: "Road Glide Limited", lastNotifiedModel: "Road Glide", lastNotifiedAt: RECENT_FIRE }] }), ["watch_fired_wrong_model"], "array-form watch fired on a base unit => anomaly");
{
  const a = auditConversationOutcome({ id: "w9", inventoryWatch: { model: "Street Glide Special", lastNotifiedModel: "Street Glide", lastNotifiedAt: RECENT_FIRE } }, { now: NOW });
  eq(a[0].category, "state", "watch_fired_wrong_model is a STATE anomaly");
  eq(a[0].healed, false, "watch_fired_wrong_model is net-new (no auto-heal; the fix is the matcher)");
  assert.ok(a[0].detail.includes("Street Glide Special") && a[0].detail.includes("Street Glide"), "detail names both the watched + notified model"); n++;
}
// SOURCE GUARD: both watch-fire sites must stamp the UNIT's model (matchedItem.model), not the watch's.
{
  const idx = fs.readFileSync("services/api/src/index.ts", "utf8");
  const stamps = idx.match(/matchedWatch\.lastNotifiedModel = matchedItem\.model/g) || [];
  assert.ok(stamps.length >= 2, `both watch-fire sites must stamp lastNotifiedModel from matchedItem.model (found ${stamps.length})`); n++;
}

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

// --- 5f. cadence-quality suppressed/held (folded from the cadence-quality judge) => comprehension. ---
{
  const a = auditConversationOutcome({ id: "c5g", cadenceQualityShadow: { at: "2026-06-25T01:00:00.000Z", overall: "suppress", reason: "nagging on a closed deal", cadenceKind: "standard" } }, { now: NOW });
  eq(a.map(x => x.dimension), ["cadence_quality_suppressed"], "recent suppress/hold cadence verdict => surfaced");
  eq(a[0].category, "comprehension", "cadence_quality_suppressed is comprehension");
}
eq(dims({ id: "c5h", cadenceQualityShadow: { at: "2026-06-25T01:00:00.000Z", overall: "good" } }), [], "a GOOD cadence verdict => not surfaced");
eq(dims({ id: "c5i", cadenceQualityShadow: { at: "2026-05-01T00:00:00.000Z", overall: "hold" } }), [], "cadence verdict older than 21d => aged out");

// --- 5d. Net 3 open-critic decision: only a CLEAR, MAJOR, high-confidence mishandling escalates. ---
{
  const base = { convId: "c5f", leadKey: "+1" };
  const a = decideOpenCriticAnomaly({ hasIssue: true, severity: "major", issueClass: "ignored_stated_constraint", reason: "booked a time the customer said they can't do", confidence: 0.9 }, base);
  eq(a?.dimension, "open_critic_finding", "major + confident issue => open_critic_finding anomaly");
  eq(a?.category, "discovery", "open_critic_finding is category=discovery (escalate, never auto-merge)");
  eq(a?.severity, "P2", "open_critic_finding is P2");
  eq(/ignored_stated_constraint/.test(String(a?.detail)), true, "the model-proposed class rides in the detail");
}
eq(decideOpenCriticAnomaly({ hasIssue: false, severity: "major", confidence: 0.9 }, { convId: "c", leadKey: "" }), null, "no issue => no anomaly");
eq(decideOpenCriticAnomaly({ hasIssue: true, severity: "minor", confidence: 0.9 }, { convId: "c", leadKey: "" }), null, "minor issue => not escalated (conservative)");
eq(decideOpenCriticAnomaly({ hasIssue: true, severity: "major", confidence: 0.5 }, { convId: "c", leadKey: "" }), null, "low-confidence issue => not escalated");

// --- 5e. turn-action summary (Net 3 turn-critic): the agent's side-effects, extracted for the critic. ---
{
  const sample = {
    lead: { source: "Dealer Lead App", vehicle: { year: 2026, model: "Street Glide" }, tradeVehicle: { model: "Sportster" }, purchaseTimeframe: "0-3 months" },
    classification: { bucket: "inventory_interest", cta: "check_availability" },
    dialogState: { name: "pricing_init" },
    followUp: { mode: "manual_handoff" },
    followUpCadence: { kind: "standard", status: "active" },
    inventoryWatches: [{ model: "Road Glide", year: 2025, status: "active" }, { model: "Old", status: "paused" }],
    appointment: { status: "confirmed", bookedEventId: "evt1", whenText: "Sat 1pm" }
  };
  const a = summarizeTurnActions(sample, [{ reason: "pricing", summary: "Confirm OTD price" }]);
  eq(a.parsedVehicle, "2026 Street Glide", "parsed vehicle summarized");
  eq(a.tradeVehicle, "Sportster", "trade vehicle summarized");
  eq(a.route, { bucket: "inventory_interest", cta: "check_availability" }, "route captured");
  eq(a.handoffMode, "manual_handoff", "handoff mode captured");
  eq(a.cadence, { kind: "standard", status: "active" }, "cadence captured");
  eq(a.activeWatches, [{ model: "Road Glide", year: 2025, condition: null }], "only ACTIVE watches (paused excluded), with model");
  eq(a.appointment, { status: "confirmed", booked: true, whenText: "Sat 1pm" }, "appointment captured (booked=true)");
  eq(a.openTasks, [{ reason: "pricing", summary: "Confirm OTD price" }], "open tasks captured");
}

// --- 6. unaddressed 👎 on the LATEST outbound (a newer outbound clears it). ---
{
  const a = auditConversationOutcome({ id: "c6", messages: [{ direction: "out", provider: "twilio", at: "t1", body: "reply", feedback: { rating: "down" } }] }, { now: NOW });
  eq(a.map(x => x.dimension), ["negative_feedback"], "latest outbound thumbed-down => negative_feedback");
  eq(a[0].category, "feedback", "negative_feedback is category=feedback");
}
eq(dims({ id: "c6b", messages: [{ direction: "out", provider: "twilio", at: "t1", body: "bad", feedback: { rating: "down" } }, { direction: "out", provider: "draft_ai", at: "t2", body: "redraft" }] }), [], "a newer outbound after the 👎 => addressed, clean");
eq(dims({ id: "c6c", messages: [{ direction: "out", provider: "twilio", at: "t1", body: "good", feedback: { rating: "up" } }] }), [], "thumbs-UP => not an anomaly");

// --- 7. CRM (TLP) update error: an open TLP-failure internal question => crm_update_error. ---
const RECENT_Q = "2026-06-24T12:00:00.000Z"; // within 21d of NOW
const OLD_Q = "2026-05-01T12:00:00.000Z";    // > 21d before NOW
{
  const a = auditConversationOutcome({ id: "crm1", questions: [{ text: "TLP log failed for leadRef 12345. Last error: lead: quick lookup failed. Retry in TLP or update manually.", status: "open", createdAt: RECENT_Q }] }, { now: NOW });
  eq(a.map(x => x.dimension), ["crm_update_error"], "open recent TLP-log-failure question => crm_update_error");
  eq(a[0].category, "state", "crm_update_error nominal category=state");
}
eq(dims({ id: "crm2", questions: [{ text: "TLP delivered step failed for leadRef 9. visit: submit button not found. Retry in TLP or update manually.", status: "open", createdAt: RECENT_Q }] }), ["crm_update_error"], "open recent TLP-delivered-step failure => crm_update_error");
eq(dims({ id: "crm3", questions: [{ text: "TLP log failed for leadRef 12345. Retry in TLP or update manually.", status: "done", createdAt: RECENT_Q }] }), [], "resolved (status=done) TLP failure => clean");
eq(dims({ id: "crm4", questions: [{ text: "TLP log failed for leadRef 12345.", status: "open", createdAt: OLD_Q }] }), [], "stale (>21d) TLP failure => clean (ages out)");
eq(dims({ id: "crm5", crm: { lastLoggedAt: "2026-06-25T00:00:00.000Z" }, questions: [{ text: "TLP log failed for leadRef 12345.", status: "open", createdAt: RECENT_Q }] }), [], "CRM logged successfully AFTER the failure => recovered, de-noised");
eq(dims({ id: "crm6", questions: [{ text: "Customer asked about financing — needs a callback.", status: "open", createdAt: RECENT_Q }] }), [], "a non-TLP internal question => not a crm_update_error");

// --- 8. crm_log_stale: a real send newer than the last TLP log by > N days, no open TLP-fail Q. ---
const STALE_SEND = "2026-06-20T14:30:00.000Z"; // >2d before NOW (CRM_LOG_STALE_DAYS default 2)
const FRESH_SEND = "2026-06-24T20:00:00.000Z"; // <2d before NOW (async-pending window)
eq(dims({ id: "cls1", lead: { leadRef: "11028" }, crm: { lastLoggedAt: "2026-04-27T17:10:04.914Z" },
  messages: [{ direction: "out", provider: "twilio", at: STALE_SEND, body: "Hope you're enjoying the Street Glide" }] }),
  ["crm_log_stale"], "post-sale cadence auto-send long after the last CRM log => crm_log_stale");
eq(dims({ id: "cls2", lead: { leadRef: "11545" },
  messages: [{ direction: "in", provider: "sendgrid_adf", at: "2026-06-19T00:00:00.000Z", body: "Ref 11545" },
             { direction: "out", provider: "human", at: STALE_SEND, body: "Happy to help." }] }),
  ["crm_log_stale"], "never-logged conv with a real send => crm_log_stale");
eq(dims({ id: "cls3", lead: { leadRef: "11337" }, crm: { lastLoggedAt: STALE_SEND, lastLoggedAtByLeadRef: { "11337": STALE_SEND } },
  messages: [{ direction: "out", provider: "twilio", at: STALE_SEND, body: "x" }] }), [],
  "per-leadRef CRM log == send time => logged, clean");
eq(dims({ id: "cls4", lead: { leadRef: "11546" },
  messages: [{ direction: "out", provider: "human", at: FRESH_SEND, body: "Hey there" }] }), [],
  "send within CRM_LOG_STALE_DAYS => async-pending, not flagged");
eq(dims({ id: "cls5",
  messages: [{ direction: "out", provider: "twilio", at: STALE_SEND, body: "x" }] }), [],
  "no leadRef anywhere => nothing could log, not a miss");
eq(dims({ id: "cls6", lead: { leadRef: "11028" },
  messages: [{ direction: "out", provider: "twilio", at: STALE_SEND, body: "x" }],
  questions: [{ text: "TLP log failed for leadRef 11028.", status: "open", createdAt: RECENT_Q }] }),
  ["crm_update_error"], "open TLP-fail question takes precedence (exclusive with crm_log_stale)");
eq(dims({ id: "cls7", lead: { leadRef: "11471" },
  messages: [{ direction: "out", provider: "draft_ai", at: STALE_SEND, body: "draft" }] }), [],
  "draft_ai (suggest-mode, never sent) is not a real send => clean");

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
    { convId: "+also_gone", status: "done", summary: "closed" }, // done => ignored
    { convId: "+1", status: "open", summary: "answered parts q", autoCloseCheck: { decision: "closed" } }, // folded: decided closed but still open => task_autoclose_regression (P2, healed)
    { convId: "+1", status: "open", summary: "below floor", autoCloseCheck: { decision: "below_confidence" } } // correctly left open => NOT flagged
  ],
  now: NOW
});
eq(store.summary.totalAnomalies, 4, "2 conv anomalies + 1 orphan todo + 1 task-autoclose regression");
eq(store.summary.byDimension["orphan_todo"], 1, "one orphan todo");
eq(store.summary.byDimension["task_autoclose_regression"], 1, "one task-autoclose regression (decision=closed but still open)");
eq(store.summary.byCategory.state, 4, "all 4 here are state-category");
eq(store.summary.bySeverity.P1, 2, "two P1 (confirmed-no-event + cadence-while-handoff)");
eq(store.summary.regressionAnomalies, 2, "two regressions (healed cadence_active_while_handoff + task_autoclose)");
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
// Folded detectors: cadence-quality judge persists its suppress/hold verdict; task-autoclose regression
// reads the persisted autoCloseCheck.decision.
assert.match(idx, /\(conv as any\)\.cadenceQualityShadow = \{/, "the cadence-quality judge persists a suppress/hold verdict for the feed");
assert.match(mod, /task_autoclose_regression/, "the store auditor folds the task-autoclose regression");
assert.match(mod, /autoCloseCheck\?\.decision \?\? ""\)\.toLowerCase\(\) === "closed"/, "task-autoclose regression keys on decision=closed but still open");

// --- Net 2 wiring: a typed LLM diff-judge + the send-path recorder that persists material corrections. ---
const llm = fs.readFileSync("services/api/src/domain/llmDraft.ts", "utf8");
assert.match(llm, /export async function classifyDraftEditWithLLM/, "the material-vs-cosmetic diff-judge exists (LLM, not regex)");
assert.match(llm, /DRAFT_EDIT_JUDGE_JSON_SCHEMA/, "the diff-judge uses a typed structured-output schema");
assert.match(idx, /maybeRecordDraftEditCorrection\(conv, fin/, "the send path records a staff edit (both email + sms sites)");
assert.match(idx, /\(conv as any\)\.humanCorrection = \{/, "a MATERIAL correction is persisted on the conversation");
assert.match(idx, /if \(!verdict \|\| !verdict\.isMaterial\) return/, "cosmetic edits are NOT recorded (material only)");
assert.ok((idx.match(/maybeRecordDraftEditCorrection\(conv, fin/g) ?? []).length >= 2, "wired at both successful send sites (email + twilio)");

// --- Net 3 wiring: the open-ended critic (LLM) + the sweep that emits discovery anomalies + the merge. ---
assert.match(llm, /export async function critiqueConversationHandlingWithLLM/, "the open-ended critic exists (LLM, model NAMES the class)");
assert.match(llm, /OPEN_CRITIC_JSON_SCHEMA/, "the critic uses a typed structured-output schema");
// Cross-model: the critic prefers Claude (a different lineage than the OpenAI generator) and falls back
// to OpenAI when no Anthropic key / forced. Claude via raw fetch + tool-use (no SDK dependency).
assert.match(llm, /async function requestStructuredJsonAnthropic/, "a Claude structured-output helper exists (cross-model judging)");
assert.match(llm, /api\.anthropic\.com\/v1\/messages/, "the Claude helper calls the Anthropic API directly (no SDK dep)");
assert.match(llm, /tool_choice: \{ type: "tool", name: args\.schemaName \}/, "Claude structured output uses forced tool-use");
assert.match(llm, /const useClaude =/, "the critic selects a provider (cross-model by default)");
assert.match(llm, /requestStructuredJsonAnthropic\(\{[\s\S]*?schemaName: "open_critic"/, "the critic routes to Claude for the open-critic judgment");
assert.match(llm, /OpenAI fallback: the no-Claude-key path AND resilience/, "the critic falls back to OpenAI (safe before the key lands / on a Claude outage)");
const sweep3 = fs.readFileSync("scripts/open_critic_sweep.ts", "utf8");
assert.match(sweep3, /critiqueConversationHandlingWithLLM/, "the open-critic sweep runs the critic over recent convs");
assert.match(sweep3, /decideOpenCriticAnomaly/, "the sweep emits anomalies via the pure decision");
assert.match(sweep3, /open_critic", "latest\.json"|"open_critic"/, "the sweep writes the open_critic feed");
// Turn-critic: the critic judges side-effects (actions), not just the reply.
assert.match(mod, /export function summarizeTurnActions/, "summarizeTurnActions is exported from the feed module");
assert.match(llm, /AGENT ACTIONS this turn/, "the critic prompt includes the turn's side-effects");
assert.match(llm, /actions\?: Record<string, unknown>/, "the critic accepts the turn's actions");
assert.match(sweep3, /summarizeTurnActions\(c, convTodos\)/, "the sweep passes the turn's actions to the critic");
assert.match(sweep3, /raw\?\.todos/, "the sweep reads open todos for the action summary");
const det = fs.readFileSync("scripts/anomaly_loop_detect.ts", "utf8");
assert.match(det, /open_critic", "latest\.json"/, "DETECT merges the open-critic (discovery) feed");
// watch_fire_miss folds as a sibling sweep (needs the inventory snapshot): DETECT merges it + it's state-category.
assert.match(det, /watch_fire_miss", "latest\.json"/, "DETECT merges the watch-fire-miss sibling feed");
assert.match(mod, /watch_fire_miss: "state"/, "watch_fire_miss is a state-category dimension");
const wfmSweep = fs.readFileSync("scripts/watch_fire_miss_sweep.ts", "utf8");
assert.match(wfmSweep, /findWatchFireMisses/, "the watch-fire-miss sweep runs findWatchFireMisses");
assert.match(wfmSweep, /inventory_snapshot\.json/, "the sweep reads the on-disk inventory snapshot (no network)");
assert.match(wfmSweep, /byConv\.set|ONE anomaly per conversation/, "the sweep dedups to one anomaly per conversation (no digest flooding)");
// Inventory enrichment: the critic gets the in-stock model list so it can catch fabricated availability.
assert.match(llm, /inStockModels\?: string\[\]/, "the critic accepts the in-stock model list");
assert.match(llm, /IN-STOCK MODELS \(current, by model\)/, "the critic prompt includes the in-stock list");
assert.match(llm, /skip the inventory check/, "an empty in-stock list => the critic SKIPS the check (never assumes out-of-stock)");
const ocSweep = fs.readFileSync("scripts/open_critic_sweep.ts", "utf8");
assert.match(ocSweep, /inStockModels/, "the open-critic sweep loads + passes the in-stock list to the critic");
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
