/**
 * Manual-send cadence + decide-soon check-in eval (pure, no LLM).
 *
 * Pins Joe's 2026-07-23 ruling (Dennis Daffron +16303628805, day-one hot out-of-state buyer):
 *  A) Staff manual sends PAUSE the follow-up cadence (existing 1-day breather) but NEVER
 *     advance/burn planned ladder steps. Production shape: 10 staff texts on 7/23 each
 *     consumed a ladder step (stepIndex 0→9 of 13) and pushed the next automated touch to
 *     Sept 5 while the buyer was actively deciding.
 *  B) A parser-detected "I'll decide soon/shortly" turn (customerDisposition
 *     defer_with_window whose STRUCTURED timeframe slot is the vague near-term class)
 *     creates a DATED owner check-in task due in 2-3 days — decision centralized in
 *     routeStateReducer (decideDecideSoonTurn), applied via ONE shared helper in BOTH paths
 *     (/webhooks/twilio + /conversations/:id/regenerate).
 *
 * Layers:
 *   1. Behavior — pauseFollowUpCadence never moves stepIndex (a pause is not a send).
 *   2. Decision table — decideDecideSoonTurn fires ONLY for an accepted defer_with_window
 *      with a vague-soon timeframe on an open, unsold conversation.
 *   3. Wiring guards — the /conversations/:id/send handler contains NO cadence advance
 *      (pause-only, both SMS + email branches), and both inbound paths call the shared
 *      decide-soon helper.
 *
 * Run: npx tsx scripts/cadence_manual_advance_eval.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  decideDecideSoonTurn,
  isVagueSoonTimeframeText,
  decideBurnedCadenceLadderRealign,
  DECIDE_SOON_CHECK_IN_DUE_DAYS
} from "../services/api/src/domain/routeStateReducer.ts";
import { pauseFollowUpCadence, FOLLOW_UP_DAY_OFFSETS } from "../services/api/src/domain/conversationStore.ts";
import { SAMPLING_FOLLOW_UP_DAY_OFFSETS } from "../services/api/src/domain/decisionFingerprint.ts";
import { sweepCadenceRealigns } from "../services/api/src/domain/cadenceRealignSweep.ts";

// --- 1) Behavior: a manual-outbound pause never burns a ladder step. ---
const conv: any = {
  id: "+16303628805",
  leadKey: "+16303628805",
  messages: [],
  followUpCadence: {
    status: "active",
    anchorAt: "2026-07-23T01:02:12.823Z",
    nextDueAt: "2026-07-24T15:18:00.000Z",
    stepIndex: 1,
    kind: "standard"
  }
};
pauseFollowUpCadence(conv, new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(), "manual_outbound");
assert.equal(conv.followUpCadence.stepIndex, 1, "a manual-outbound pause must NOT advance stepIndex");
assert.equal(conv.followUpCadence.status, "active", "a pause keeps the cadence active (it resumes on its own)");
assert.ok(conv.followUpCadence.pausedUntil, "the 1-day breather is recorded");
assert.equal(conv.followUpCadence.pauseReason, "manual_outbound");

// --- 2) Decision table: decideDecideSoonTurn. ---
assert.ok(
  DECIDE_SOON_CHECK_IN_DUE_DAYS >= 2 && DECIDE_SOON_CHECK_IN_DUE_DAYS <= 3,
  "Joe ruled a 2-3 day check-in window"
);
type Row = {
  id: string;
  parserAccepted: boolean;
  disposition: string | null;
  timeframeText: string | null;
  closed?: boolean;
  sold?: boolean;
  task: boolean;
};
const rows: Row[] = [
  // The Dennis replay: accepted defer_with_window, parser timeframe slot "soon" → dated task.
  { id: "dennis_decision_soon", parserAccepted: true, disposition: "defer_with_window", timeframeText: "soon", task: true },
  { id: "shortly", parserAccepted: true, disposition: "defer_with_window", timeframeText: "shortly", task: true },
  { id: "very_soon", parserAccepted: true, disposition: "defer_with_window", timeframeText: "very soon", task: true },
  { id: "in_a_day_or_two", parserAccepted: true, disposition: "defer_with_window", timeframeText: "a day or two", task: true },
  // Concrete windows stay with the existing with-window deferral machinery — no task.
  { id: "concrete_next_month", parserAccepted: true, disposition: "defer_with_window", timeframeText: "next month", task: false },
  { id: "concrete_few_days", parserAccepted: true, disposition: "defer_with_window", timeframeText: "a few days", task: false },
  { id: "concrete_tax_return", parserAccepted: true, disposition: "defer_with_window", timeframeText: "after tax return", task: false },
  // Parser not accepted (low confidence / disabled LLM) → fail toward today's behavior.
  { id: "parser_not_accepted", parserAccepted: false, disposition: "defer_with_window", timeframeText: "soon", task: false },
  // Other dispositions never create the task from this decision.
  { id: "defer_no_window", parserAccepted: true, disposition: "defer_no_window", timeframeText: "", task: false },
  { id: "stepping_back", parserAccepted: true, disposition: "stepping_back", timeframeText: "soon", task: false },
  { id: "none_disposition", parserAccepted: true, disposition: "none", timeframeText: "soon", task: false },
  { id: "null_disposition", parserAccepted: true, disposition: null, timeframeText: "soon", task: false },
  // Closed/sold conversations are left alone.
  { id: "closed_conv", parserAccepted: true, disposition: "defer_with_window", timeframeText: "soon", closed: true, task: false },
  { id: "sold_conv", parserAccepted: true, disposition: "defer_with_window", timeframeText: "soon", sold: true, task: false },
  // Empty timeframe slot never fires.
  { id: "empty_timeframe", parserAccepted: true, disposition: "defer_with_window", timeframeText: "", task: false },
  { id: "null_timeframe", parserAccepted: true, disposition: "defer_with_window", timeframeText: null, task: false }
];
for (const r of rows) {
  const decision = decideDecideSoonTurn({
    parserAccepted: r.parserAccepted,
    disposition: r.disposition,
    timeframeText: r.timeframeText,
    conversationClosed: !!r.closed,
    saleRecorded: !!r.sold
  });
  assert.equal(
    decision.kind === "owner_check_in_task",
    r.task,
    `decideDecideSoonTurn[${r.id}] expected task=${r.task}, got kind=${decision.kind}`
  );
  if (decision.kind === "owner_check_in_task") {
    assert.equal(decision.dueInDays, DECIDE_SOON_CHECK_IN_DUE_DAYS, `[${r.id}] due window is the ruled 2-3 days`);
  }
}
// The vague-soon classifier reads the STRUCTURED slot; punctuation/lead-in "in" are tolerated,
// concrete phrases are not this class.
assert.ok(isVagueSoonTimeframeText("Soon."));
assert.ok(isVagueSoonTimeframeText("in soon") || isVagueSoonTimeframeText("soon"), "lead-in 'in' tolerated");
assert.ok(!isVagueSoonTimeframeText("next spring"));
assert.ok(!isVagueSoonTimeframeText("in 3 days"));
assert.ok(!isVagueSoonTimeframeText(""));

// --- 3) Wiring guards. ---
const index = fs.readFileSync("services/api/src/index.ts", "utf8");

// 3a) The manual send handler is pause-only: no cadence advance in EITHER branch (SMS + email).
const sendStart = index.indexOf('app.post("/conversations/:id/send"');
assert.ok(sendStart > 0, "manual send endpoint exists");
const sendEnd = index.indexOf('app.post("/conversations/:id/draft"', sendStart);
assert.ok(sendEnd > sendStart, "manual send endpoint boundary found");
const sendHandler = index.slice(sendStart, sendEnd);
assert.ok(
  !/advanceFollowUpCadence\s*\(/.test(sendHandler),
  "the manual send handler must NEVER advance/burn a cadence ladder step (Joe ruling 2026-07-23)"
);
assert.ok(
  !/applyManualCadenceAdvance/.test(sendHandler.replace(/\/\/[^\n]*/g, "")),
  "the removed applyManualCadenceAdvance hook must not come back"
);
const pauseCalls = sendHandler.split("pauseCadenceAfterManualOutbound()").length - 1;
assert.ok(
  pauseCalls >= 2,
  `the existing 1-day pause stays in BOTH branches (SMS + email) — found ${pauseCalls} call(s)`
);
// The scheduled tick is untouched — real cadence sends still advance the ladder.
assert.ok(
  /advanceFollowUpCadence\(conv, cfg\.timezone\)/.test(index),
  "processDueFollowUps still advances the ladder on real scheduled sends"
);

// 3b) Both inbound paths run the decide-soon check-in through the ONE shared helper.
const helperCalls = index.split("applyDecideSoonCheckInFromDispositionParse(").length - 1;
assert.ok(
  helperCalls >= 3,
  `decide-soon helper must be defined once and called from BOTH paths (live + regen) — found ${helperCalls} references`
);
const helperBody = index.slice(
  index.indexOf("function applyDecideSoonCheckInFromDispositionParse"),
  index.indexOf("function applyDecideSoonCheckInFromDispositionParse") + 2200
);
assert.ok(
  /decideDecideSoonTurn\(/.test(helperBody),
  "the shared helper consults the centralized routeStateReducer decision"
);
assert.ok(
  /isDispositionParserAccepted\(/.test(helperBody),
  "the helper gates on typed-parser acceptance (never raw-text keying)"
);
assert.ok(/addTodo\(/.test(helperBody) && /dueAt/.test(helperBody), "the check-in task is DATED");

// --- 4) The BURNED-LADDER heal (2026-08-02) ------------------------------------------------------
// Part A stopped NEW damage on 2026-07-24. It could not repair records already burned, and a burned
// ladder is invisible — the cadence looks healthy, it just points at a rung the calendar has not
// earned. Measured on the live store 2026-08-02: 2 of 66 active standard/engaged cadences were still
// stranded (+16303628805 and +16813891971), both at step 9 with a September due date.
// The referee only ever moves a cadence BACK onto the earned rung; it sends nothing.
// The eval uses the PRODUCTION ladder, never a hand-copy (the cadence-repeat eval already got
// burned scoring a drifted copy). The fingerprint registry keeps its own sampling copy because it
// must stay import-free; assert the two never drift apart.
const LADDER = FOLLOW_UP_DAY_OFFSETS;
assert.deepEqual(
  SAMPLING_FOLLOW_UP_DAY_OFFSETS,
  FOLLOW_UP_DAY_OFFSETS,
  "the decision-registry sampling ladder must match the production ladder"
);
const burned = (over: Record<string, unknown> = {}) =>
  decideBurnedCadenceLadderRealign({
    status: "active",
    kind: "standard",
    stepIndex: 9,
    ageDays: 10,
    ladderOffsets: LADDER,
    conversationClosed: false,
    pausedInFuture: false,
    ...over
  } as any);

// DENNIS, his exact live state on 2026-08-02: anchored 7/23, ten manual sends drove him to step 9
// (the 45-day rung) while only 10 days elapsed — offsets 1,2,3,5,7,10 have come due, so the
// calendar has earned step 6.
const dennis = burned();
assert.equal(dennis.realign, true, "Dennis's burned ladder must be healed");
assert.equal(dennis.stepIndex, 6, "clamped to the rung elapsed time earned, not reset to 0");
assert.equal(dennis.why, "ladder_burned_ahead_of_elapsed_time");
// IDEMPOTENT: re-running against the healed state must decline.
assert.equal(burned({ stepIndex: dennis.stepIndex }).realign, false, "a healed ladder is not re-healed");

// A healthy ladder is never touched — including the legitimately-pending next rung (+1 tolerance).
assert.equal(burned({ stepIndex: 6 }).realign, false, "step at the earned rung -> no-op");
assert.equal(burned({ stepIndex: 7 }).realign, false, "the pending next rung is legitimate -> no-op");
assert.equal(burned({ stepIndex: 0 }).realign, false, "a fresh cadence is never realigned");
assert.equal(burned({ stepIndex: 8 }).realign, true, "two rungs ahead IS burned");

// SCOPE: long_term / post_sale ladders sit months out BY DESIGN. Correcting them would undo the
// tempo-cap heal that deliberately parks a 4+ month lead (Zachary +17169013675).
assert.equal(burned({ kind: "long_term" }).why, "kind_not_ladder_scoped", "long_term is never realigned");
assert.equal(burned({ kind: "post_sale" }).why, "kind_not_ladder_scoped", "post_sale is never realigned");
assert.equal(burned({ kind: "engaged" }).realign, true, "engaged runs the same 13-step ladder -> in scope");

// Guards: never touch a closed/sold lead, a paused cadence (the pause owns the schedule), a
// non-active cadence, or one with no usable anchor.
assert.equal(burned({ conversationClosed: true }).why, "conversation_closed");
assert.equal(burned({ pausedInFuture: true }).why, "pause_owns_the_schedule");
assert.equal(burned({ status: "stopped" }).why, "cadence_not_active");
assert.equal(burned({ status: "completed" }).why, "cadence_not_active");
assert.equal(burned({ ageDays: null }).why, "no_anchor");
assert.equal(burned({ ageDays: -3 }).why, "no_anchor");
assert.equal(burned({ ladderOffsets: [] }).why, "no_ladder");
// A day-one cadence burned to step 9 clamps to 0 — nothing has come due yet.
assert.equal(burned({ ageDays: 0 }).stepIndex, 0, "no offset earned yet -> back to the first rung");

// WIRING, proven by BEHAVIOR rather than by pinning source text (the eval source-pin ratchet is
// right that a re-pinned string guards nothing): run the real sweep over real conversation shapes
// and assert what it healed. This covers both heals AND that the sweep applies the referee's
// verdict end-to-end — Dennis's exact burned state, and the long_term heal it absorbed from
// index.ts, alongside a healthy cadence that must be left alone.
const SWEEP_TZ = "America/New_York";
const SWEEP_NOW = new Date("2026-08-02T15:00:00.000Z");
const burnedConv: any = {
  id: "+16303628805",
  leadKey: "+16303628805",
  messages: [],
  followUpCadence: {
    status: "active",
    kind: "standard",
    stepIndex: 9,
    anchorAt: "2026-07-23T01:02:12.823Z",
    nextDueAt: "2026-09-05T15:18:00.000Z"
  }
};
const healthyConv: any = {
  id: "+15550000101",
  leadKey: "+15550000101",
  messages: [],
  followUpCadence: {
    status: "active",
    kind: "standard",
    stepIndex: 2,
    anchorAt: "2026-07-30T00:00:00.000Z",
    nextDueAt: "2026-08-02T00:00:00.000Z"
  }
};
const sweepResult = sweepCadenceRealigns([burnedConv, healthyConv], SWEEP_TZ, SWEEP_NOW);
assert.equal(sweepResult.burnedLaddersHealed.length, 1, "the sweep heals exactly the burned ladder");
assert.equal(sweepResult.burnedLaddersHealed[0].convId, "+16303628805", "…and it is Dennis");
assert.equal(sweepResult.burnedLaddersHealed[0].fromStep, 9, "outcome names the rung it was wrongly on");
assert.equal(sweepResult.burnedLaddersHealed[0].toStep, 6, "…and the rung the calendar had earned");
assert.equal(burnedConv.followUpCadence.stepIndex, 6, "the record itself is moved back onto the earned rung");
assert.ok(
  Date.parse(burnedConv.followUpCadence.nextDueAt) < Date.parse("2026-09-05T00:00:00.000Z"),
  "the September parking is gone — the next touch comes forward onto the ladder"
);
assert.equal(healthyConv.followUpCadence.stepIndex, 2, "a healthy cadence is untouched");
assert.equal(healthyConv.followUpCadence.nextDueAt, "2026-08-02T00:00:00.000Z", "…including its due date");
// Idempotent end-to-end: a second sweep over the already-healed record changes nothing.
assert.equal(
  sweepCadenceRealigns([burnedConv, healthyConv], SWEEP_TZ, SWEEP_NOW).burnedLaddersHealed.length,
  0,
  "re-running the sweep does not re-heal"
);

console.log(
  `PASS cadence-manual-advance eval — pause-only manual sends (both branches), ${rows.length} decide-soon decision cases, ${DECIDE_SOON_CHECK_IN_DUE_DAYS}-day dated check-in, shared-helper two-path wiring, burned-ladder heal (Dennis step 9 -> 6, idempotent, scope + guards)`
);
