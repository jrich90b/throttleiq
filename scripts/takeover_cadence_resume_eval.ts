/**
 * takeover_cadence_resume:eval — pins Joe's 2026-08-21 rulings: a manual takeover must not
 * permanently kill the follow-up schedule absent deal progress, and after the quiet window
 * the cadence picks back up WHERE IT LEFT OFF (same step — not a restart, not a long_term
 * demotion). Also pins the console toggle-back resume (human→suggest restarts a
 * manual_handoff-stopped cadence) and the per-tick cap (the census backlog is 60+ threads;
 * an uncapped first pass would flood the approval box — same "won't overwhelm" requirement
 * as the ride-challenge stagger).
 *
 * Decision rows (decideHumanTakeoverCadenceResume) + helper rows (lastDeliveredAtMs) +
 * wiring source-guards. Fail-direction: every blocker fails toward SILENCE (today's
 * behavior); a wrong fire is one suggest-mode draft staff can dismiss.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  decideHumanTakeoverCadenceResume,
  HUMAN_TAKEOVER_RESUME_QUIET_DAYS
} from "../services/api/src/domain/routeStateReducer.ts";
import {
  lastDeliveredAtMs,
  TAKEOVER_RESUME_MAX_PER_TICK
} from "../services/api/src/domain/takeoverCadenceResume.ts";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-08-21T12:00:00.000Z");

const ELIGIBLE = {
  cadenceStatus: "stopped",
  cadenceStopReason: "manual_handoff",
  cadenceStepIndex: 5,
  lastDeliveredAtMs: NOW - 13 * DAY,
  nowMs: NOW,
  conversationClosed: false,
  sold: false,
  suppressed: false,
  contactPreference: null,
  appointmentBookedEventId: null,
  hasHold: false,
  hasOpenFutureDatedTodo: false,
  hasPendingDraft: false
};

// --- the resume case ---
const yes = decideHumanTakeoverCadenceResume(ELIGIBLE);
assert.ok(yes && yes.resume === true && yes.quietDays === 13, "takeover-stopped cadence, 13 quiet days, no progress → RESUMES (quietDays reported)");

// --- the quiet bar is exactly 12 days ---
assert.equal(HUMAN_TAKEOVER_RESUME_QUIET_DAYS, 12, "quiet bar is 12 days — both nudge bumps (day 3 + day 8) fit inside it");
assert.equal(
  decideHumanTakeoverCadenceResume({ ...ELIGIBLE, lastDeliveredAtMs: NOW - 11 * DAY }),
  null,
  "11 quiet days → too soon (the nudge lane still owns the thread)"
);
assert.ok(
  decideHumanTakeoverCadenceResume({ ...ELIGIBLE, lastDeliveredAtMs: NOW - 12 * DAY }),
  "exactly 12 quiet days → resumes"
);

// --- ONE-WAY / convergence: a resumed (active) cadence can never match again ---
assert.equal(
  decideHumanTakeoverCadenceResume({ ...ELIGIBLE, cadenceStatus: "active" }),
  null,
  "CONVERGES: once resumed (status active) the decision is dead until a fresh takeover stop"
);

// --- stopReason discipline: manual_handoff ONLY — disposition stops are judgements ---
for (const reason of ["no_longer_owns", "wrong_number", "call_only", "unit_hold", "order_hold", "closed", "disengaged_taper", "", null]) {
  assert.equal(
    decideHumanTakeoverCadenceResume({ ...ELIGIBLE, cadenceStopReason: reason as any }),
    null,
    `stopReason ${JSON.stringify(reason)} → never resumed here`
  );
}

// --- every progress/safety signal blocks, failing toward silence ---
assert.equal(decideHumanTakeoverCadenceResume({ ...ELIGIBLE, conversationClosed: true }), null, "closed → no resume");
assert.equal(decideHumanTakeoverCadenceResume({ ...ELIGIBLE, sold: true }), null, "sold → no resume");
assert.equal(decideHumanTakeoverCadenceResume({ ...ELIGIBLE, suppressed: true }), null, "opt-out/suppressed → no resume");
assert.equal(decideHumanTakeoverCadenceResume({ ...ELIGIBLE, contactPreference: "call_only" }), null, "call_only → no resume");
assert.equal(decideHumanTakeoverCadenceResume({ ...ELIGIBLE, appointmentBookedEventId: "evt_1" }), null, "booked appointment = progress → no resume");
assert.equal(decideHumanTakeoverCadenceResume({ ...ELIGIBLE, hasHold: true }), null, "unit hold = progress → no resume");
assert.equal(decideHumanTakeoverCadenceResume({ ...ELIGIBLE, hasOpenFutureDatedTodo: true }), null, "dated staff promise owns the follow-up → no resume");
assert.equal(decideHumanTakeoverCadenceResume({ ...ELIGIBLE, hasPendingDraft: true }), null, "pending draft → never stack");
assert.equal(decideHumanTakeoverCadenceResume({ ...ELIGIBLE, cadenceStepIndex: null }), null, "no stepIndex → nowhere to resume to");
assert.equal(decideHumanTakeoverCadenceResume({ ...ELIGIBLE, lastDeliveredAtMs: null }), null, "no delivered anchor → never resume blind");

// --- lastDeliveredAtMs: drafts, stale ghosts, and empty bodies never count ---
const msgs = (rows: any[]) => ({ id: "+1", leadKey: "+1", messages: rows }) as any;
assert.equal(
  lastDeliveredAtMs(msgs([
    { provider: "twilio", at: "2026-08-01T00:00:00Z", body: "hi", direction: "out" },
    { provider: "draft_ai", at: "2026-08-20T00:00:00Z", body: "draft", direction: "out" },
    { provider: "twilio", at: "2026-08-19T00:00:00Z", body: "stale", direction: "out", draftStatus: "stale" },
    { provider: "twilio", at: "2026-08-18T00:00:00Z", body: "  ", direction: "in" }
  ])),
  Date.parse("2026-08-01T00:00:00Z"),
  "drafts/stale/empty rows never move the quiet clock"
);
assert.equal(
  lastDeliveredAtMs(msgs([
    { provider: "twilio", at: "2026-08-01T00:00:00Z", body: "out", direction: "out" },
    { provider: "twilio", at: "2026-08-05T00:00:00Z", body: "customer reply", direction: "in" }
  ])),
  Date.parse("2026-08-05T00:00:00Z"),
  "an inbound also resets the quiet clock (either direction counts)"
);

// --- the per-tick cap exists and is sane ---
assert.equal(TAKEOVER_RESUME_MAX_PER_TICK, 10, "per-tick cap pinned — the 60+ backlog drains across ticks, never one morning");

// --- wiring source-guards ---
const healModule = fs.readFileSync(path.join(process.cwd(), "services/api/src/domain/takeoverCadenceResume.ts"), "utf8");
assert.ok(
  healModule.includes("decideHumanTakeoverCadenceResume({") &&
    healModule.includes("resumeFollowUpCadence(conv, opts.timeZone)") &&
    healModule.includes("resumed >= TAKEOVER_RESUME_MAX_PER_TICK") &&
    healModule.includes('recordRouteOutcome("manual", "takeover_cadence_resumed"'),
  "heal routes through the routeStateReducer decision, resumes AT STEP via resumeFollowUpCadence, caps per tick, records the outcome"
);
const apiIndex = fs.readFileSync(path.join(process.cwd(), "services/api/src/index.ts"), "utf8");
assert.ok(
  apiIndex.includes("resumeTakeoverStoppedCadences(convs, {"),
  "state-reconcile calls the takeover-resume heal"
);
const modeStart = apiIndex.indexOf('app.post("/conversations/:id/mode"');
const modeBlock = modeStart >= 0 ? apiIndex.slice(modeStart, modeStart + 900) : "";
assert.ok(
  /if \(mode === "suggest"\) \{[\s\S]{0,200}resumeCadenceOnModeToggle\(conv,/.test(modeBlock),
  "toggle-back resume fires on the suggest direction of the mode toggle"
);
assert.ok(
  healModule.includes('conv.followUpCadence?.stopReason !== "manual_handoff") return false') &&
    healModule.includes('recordRouteOutcome("manual", "takeover_cadence_resumed_on_mode_toggle"'),
  "resumeCadenceOnModeToggle resumes ONLY a manual_handoff-stopped cadence and records the outcome"
);

console.log("PASS takeover cadence resume eval — quiet-bar decision table, manual_handoff-only, one-way, capped per tick, toggle-back resume wired");
