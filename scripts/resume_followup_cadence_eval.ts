/**
 * resumeFollowUpCadence behavioral eval (2026-06-25).
 *
 * Closes an eval blind spot the full-codebase audit flagged: `resumeFollowUpCadence` (conversationStore)
 * RESTARTS a stopped cadence — a customer-facing side effect (resumes outbound SMS). It was the only
 * cadence mutator with no eval. This executes the mutation against a fixture store (not a source-string
 * guard) so a regression that re-spams a held lead or fails to resume a paused one is caught.
 *
 * Contract pinned: resume ONLY from a stopped cadence; re-activate + recompute nextDueAt from the
 * step-appropriate offset table by kind; preserve stepIndex (resume where it left off); clear
 * stop/pause markers; no-op on an active cadence or a conv with no cadence.
 *
 * KNOWN GAP (flagged, not asserted here — needs a careful fix re: post_sale-on-sold nuance):
 * resumeFollowUpCadence has no closed/sold guard, so the inventory-heal caller could in theory resume a
 * cadence on a closed lead. Tracked in docs/code_audit_2026-06-25.md (P1.5).
 *
 * Run: npx tsx scripts/resume_followup_cadence_eval.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.CONVERSATIONS_DB_PATH =
  process.env.CONVERSATIONS_DB_PATH || path.join(os.tmpdir(), `resume-cadence-eval-${Date.now()}.json`);
const { resumeFollowUpCadence, upsertConversationByLeadKey } = await import(
  "../services/api/src/domain/conversationStore.ts"
);

const TZ = "America/New_York";
let seq = 0;
let n = 0;
const ok = (c: boolean, m: string) => { assert.equal(c, true, m); n++; };

const mkStopped = (kind: string, stepIndex = 0) => {
  const c: any = upsertConversationByLeadKey(`+1555200${String(seq++).padStart(4, "0")}`, "suggest");
  c.followUpCadence = {
    status: "stopped",
    kind,
    stepIndex,
    anchorAt: "2026-06-20T14:00:00.000Z",
    stopReason: "manual_handoff",
    pausedUntil: "2026-07-01T00:00:00.000Z",
    pauseReason: "soft_visit_window",
    scheduleInviteCount: 0
  };
  return c;
};

// --- Resume from stopped: re-activate, recompute nextDueAt, clear stop/pause markers, keep stepIndex. ---
for (const kind of ["standard", "long_term", "post_sale"]) {
  const c = mkStopped(kind, 2);
  resumeFollowUpCadence(c, TZ);
  const cad = c.followUpCadence;
  ok(cad.status === "active", `${kind}: stopped => active`);
  ok(cad.kind === kind, `${kind}: kind preserved`);
  ok(cad.stepIndex === 2, `${kind}: stepIndex preserved (resume where it left off)`);
  ok(!!String(cad.nextDueAt ?? "").trim() && Number.isFinite(Date.parse(cad.nextDueAt)), `${kind}: nextDueAt recomputed to a valid date`);
  ok(!cad.stopReason, `${kind}: stopReason cleared`);
  ok(!cad.pausedUntil, `${kind}: pausedUntil cleared`);
  ok(!cad.pauseReason, `${kind}: pauseReason cleared`);
}

// --- No-op on an ACTIVE cadence (don't disturb a running cadence). ---
const active: any = upsertConversationByLeadKey(`+1555200${String(seq++).padStart(4, "0")}`, "suggest");
active.followUpCadence = { status: "active", kind: "standard", stepIndex: 1, nextDueAt: "2026-06-26T13:00:00.000Z", anchorAt: "2026-06-20T14:00:00.000Z" };
resumeFollowUpCadence(active, TZ);
ok(active.followUpCadence.nextDueAt === "2026-06-26T13:00:00.000Z", "active cadence untouched (nextDueAt unchanged)");
ok(active.followUpCadence.stepIndex === 1, "active cadence stepIndex unchanged");

// --- No-op when there is no cadence. ---
const none: any = upsertConversationByLeadKey(`+1555200${String(seq++).padStart(4, "0")}`, "suggest");
none.followUpCadence = undefined;
resumeFollowUpCadence(none, TZ);
ok(!none.followUpCadence, "no cadence => no-op (nothing created)");

// --- stepIndex clamped to the offset table (a too-high index doesn't overflow). ---
const high = mkStopped("standard", 999);
resumeFollowUpCadence(high, TZ);
ok(high.followUpCadence.status === "active" && Number.isFinite(Date.parse(high.followUpCadence.nextDueAt)), "out-of-range stepIndex still resumes to a valid date");

// --- Source guard: the heal caller resumes the cadence. ---
const api = fs.readFileSync("services/api/src/index.ts", "utf8");
assert.match(api, /resumeFollowUpCadence\(conv, cfg\.timezone/, "the held-unit-available heal resumes the cadence");
n += 1;

console.log(`PASS resume-followup-cadence eval (${n} assertions)`);
