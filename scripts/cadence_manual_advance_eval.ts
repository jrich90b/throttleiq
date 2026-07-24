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
  DECIDE_SOON_CHECK_IN_DUE_DAYS
} from "../services/api/src/domain/routeStateReducer.ts";
import { pauseFollowUpCadence } from "../services/api/src/domain/conversationStore.ts";

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

console.log(
  `PASS cadence-manual-advance eval — pause-only manual sends (both branches), ${rows.length} decide-soon decision cases, ${DECIDE_SOON_CHECK_IN_DUE_DAYS}-day dated check-in, shared-helper two-path wiring`
);
