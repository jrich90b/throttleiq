/**
 * Next-Move resolver decision-table eval (pure, no LLM) — 2026-07-31.
 *
 * Pins the ONE next-human-action decision (services/api/src/domain/nextMoveResolver.ts)
 * against Joe's rulings of 2026-07-31, so the precedence can't drift:
 *
 *   1. "If there is engagement it should not make call tasks."  → engagement suppresses chasing
 *   2. "3 days should be a call."                               → engaged + 3 quiet days = CALL
 *   3. "Watches should stop the cadence too, or if we tell them
 *       when a bike should be coming in."                       → a known next event suppresses
 *   4. A lead that told us nothing runs the printed wall chart, floored at day 3 by (2).
 *
 * Precedence order pinned here: opted out / closed > known next event > engaged > chart.
 *
 * Also pins the FAIL DIRECTION (AGENTS.md): every gate fails toward EMITTING a move.
 * Suppression requires a positive, confident signal — missing/ambiguous input must never
 * silently drop a live lead.
 *
 * Run: npx tsx scripts/next_move_resolver_eval.ts
 */
import assert from "node:assert/strict";

import {
  CHART_CALL_MIN_DAY,
  ENGAGED_QUIET_DAYS_FOR_CALL,
  FOLLOW_UP_CHART_DAYS,
  MOVE_LAPSES_AFTER_DAYS,
  chartCallDays,
  decideNextMove,
  dueChartCallDay
} from "../services/api/src/domain/nextMoveResolver.ts";

const DAY_MS = 86_400_000;
const NOW = Date.parse("2026-07-31T15:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
const daysAgo = (n: number) => iso(NOW - n * DAY_MS);

// --- 0) The chart matches the printed wall chart, and the day-3 floor holds. ---
assert.deepEqual(
  [...FOLLOW_UP_CHART_DAYS],
  [1, 2, 3, 5, 7, 10, 14, 18, 21, 27, 30],
  "the chart must stay the dealership's printed cadence (memory followup-cadence-wall-chart)"
);
assert.equal(CHART_CALL_MIN_DAY, 3, "Joe 7/31: no chart CALL before day 3");
assert.equal(ENGAGED_QUIET_DAYS_FOR_CALL, 3, "Joe 7/31: '3 days should be a call'");
assert.deepEqual(
  chartCallDays(),
  [3, 5, 7, 10, 14, 18, 21, 27, 30],
  "day-1 and day-2 calls are excluded — the agent is still mid-conversation on a fresh lead"
);

// --- 1) Never-engaged lead runs the chart. ---
const cold = (nDays: number, served = 0) =>
  decideNextMove({
    nowMs: NOW,
    leadCreatedAt: daysAgo(nDays),
    engagement: { engaged: false },
    servedThroughChartDay: served
  });

assert.equal(cold(1).move, "none", "day 1: no call — the agent just texted them");
assert.equal(cold(2).move, "none", "day 2: still no call");
assert.equal(cold(3).move, "call", "day 3: the first chart call (Joe's floor)");
assert.equal(cold(3).reason, "chart_day");
assert.equal(cold(3).chartDay, 3);
assert.equal(cold(7).chartDay, 7, "day 7 is a chart touch day");
assert.equal(cold(8).chartDay, 7, "day 8 still owes the unserved day-7 call");
assert.equal(cold(8, 7).move, "none", "day 7 already served → nothing owed until day 10");
assert.equal(cold(31, 30).reason, "chart_exhausted", "past day 30 with all served → the chart ends");

// A lead suppressed for a stretch (a watch that later cleared) rejoins the chart at TODAY's
// position — it must not replay a backlog of stale calls at the salesperson.
assert.equal(
  cold(21, 3).chartDay,
  21,
  "after a suppressed stretch the lead rejoins at today's chart day, not the next unserved one"
);
assert.equal(dueChartCallDay(21, 3), 21, "dueChartCallDay returns the HIGHEST due day, not the next");
assert.equal(dueChartCallDay(2, 0), null, "nothing is due before day 3");

// --- 2) Ruling 1: engagement suppresses chasing entirely. ---
const engagedRecent = decideNextMove({
  nowMs: NOW,
  leadCreatedAt: daysAgo(20),
  engagement: { engaged: true, lastCustomerReplyAt: daysAgo(1) }
});
assert.equal(engagedRecent.move, "none", "Joe: 'if there is engagement it should not make call tasks'");
assert.equal(engagedRecent.reason, "engaged_recently");

// Engagement outranks the chart even on a chart touch day — this is the whole point.
const engagedOnChartDay = decideNextMove({
  nowMs: NOW,
  leadCreatedAt: daysAgo(21), // a chart day
  engagement: { engaged: true, lastCustomerReplyAt: daysAgo(0) }
});
assert.equal(engagedOnChartDay.move, "none", "an engaged lead never gets a chart call, chart day or not");

// --- 3) Ruling 2: engaged, then quiet 3 days → a CALL. ---
const quiet2 = decideNextMove({
  nowMs: NOW,
  leadCreatedAt: daysAgo(30),
  engagement: { engaged: true, lastCustomerReplyAt: daysAgo(2) }
});
assert.equal(quiet2.move, "none", "2 quiet days is not yet a call");

const quiet3 = decideNextMove({
  nowMs: NOW,
  leadCreatedAt: daysAgo(30),
  engagement: { engaged: true, lastCustomerReplyAt: daysAgo(3) }
});
assert.equal(quiet3.move, "call", "3 quiet days earns a call (Joe 7/31)");
assert.equal(quiet3.reason, "engaged_then_quiet");
assert.equal(
  quiet3.dueAt,
  iso(NOW - 3 * DAY_MS + ENGAGED_QUIET_DAYS_FOR_CALL * DAY_MS),
  "the re-engagement call is due 3 days after their last reply"
);

// --- 4) Ruling 3: a known next event IS the cadence. ---
for (const kind of [
  "inventory_watch",
  "order_hold",
  "unit_hold",
  "appointment",
  "manual_handoff",
  "customer_named_time",
  "paused"
] as const) {
  const d = decideNextMove({
    nowMs: NOW,
    leadCreatedAt: daysAgo(21),
    engagement: { engaged: false },
    knownNextEvent: { kind, at: daysAgo(5) }
  });
  assert.equal(d.move, "none", `${kind} must stop the cadence (Joe 7/31: watches/ETAs)`);
  assert.equal(d.reason, `known_next_event:${kind}`);
}

// The event outranks the 3-quiet-day re-engagement call too — same principle.
assert.equal(
  decideNextMove({
    nowMs: NOW,
    leadCreatedAt: daysAgo(30),
    engagement: { engaged: true, lastCustomerReplyAt: daysAgo(9) },
    knownNextEvent: { kind: "inventory_watch", at: daysAgo(4) }
  }).move,
  "none",
  "a pending watch silences the re-engagement call, not just the chart"
);

// An event that is not yet known at evaluation time must NOT retroactively suppress.
assert.equal(
  decideNextMove({
    nowMs: NOW,
    leadCreatedAt: daysAgo(21),
    engagement: { engaged: false },
    knownNextEvent: { kind: "appointment", at: iso(NOW + 2 * DAY_MS) }
  }).move,
  "call",
  "an event known only in the future cannot suppress a call that is due now"
);

// --- 5) Hard stops outrank everything. ---
assert.equal(
  decideNextMove({
    nowMs: NOW,
    leadCreatedAt: daysAgo(21),
    engagement: { engaged: false },
    optedOut: true
  }).reason,
  "opted_out",
  "an opt-out is absolute"
);
assert.equal(
  decideNextMove({
    nowMs: NOW,
    leadCreatedAt: daysAgo(21),
    engagement: { engaged: false },
    closed: true
  }).reason,
  "lead_closed",
  "a closed/sold lead is never chased"
);

// --- 6) FAIL DIRECTION: ambiguity must never silently drop a live lead. ---
// An UNDATED known event still suppresses — its presence is itself the positive signal.
assert.equal(
  decideNextMove({
    nowMs: NOW,
    leadCreatedAt: daysAgo(21),
    engagement: { engaged: false },
    knownNextEvent: { kind: "inventory_watch" }
  }).move,
  "none",
  "an undated known event still suppresses (presence is the signal)"
);

// Engaged but the reply time is unreadable → do NOT chase an active conversation.
assert.equal(
  decideNextMove({
    nowMs: NOW,
    leadCreatedAt: daysAgo(21),
    engagement: { engaged: true, lastCustomerReplyAt: "not-a-date" }
  }).reason,
  "engaged_reply_time_unknown",
  "an engaged lead with an unreadable reply time is not chased"
);

// Unknown lead age → emit nothing rather than invent a chart position.
assert.equal(
  decideNextMove({ nowMs: NOW, leadCreatedAt: "", engagement: { engaged: false } }).reason,
  "lead_age_unknown",
  "an unreadable lead age must not fabricate a chart day"
);

// A cold lead still inside the chart window ALWAYS surfaces a call — never silence.
assert.equal(
  decideNextMove({ nowMs: NOW, leadCreatedAt: daysAgo(20), engagement: { engaged: false } }).move,
  "call",
  "a cold, un-evented, un-engaged lead inside the chart ALWAYS surfaces a call"
);

// --- 7) LAPSE: a move whose moment passed long ago is backlog, not today's work. ---
// Regression pin for the flaw the phase-1 shadow caught (2026-07-31): without this the
// resolver claimed the store owed 241 calls, sampled dates in MAY, because an April lead
// permanently "owed" a day-30 call nothing would ever mark served.
assert.equal(MOVE_LAPSES_AFTER_DAYS, 7, "a move older than a week is backlog, not due");

const staleChart = decideNextMove({
  nowMs: NOW,
  leadCreatedAt: daysAgo(90), // arrived in May, never engaged, never called
  engagement: { engaged: false }
});
assert.equal(staleChart.move, "none", "a day-30 call that came due 60 days ago is NOT due today");
assert.equal(staleChart.reason, "chart_lapsed", "it must be reported as backlog, not silently dropped");
assert.equal(staleChart.chartDay, 30, "the lapsed move still names the chart day it represents");

const staleReengage = decideNextMove({
  nowMs: NOW,
  leadCreatedAt: daysAgo(120),
  engagement: { engaged: true, lastCustomerReplyAt: daysAgo(80) }
});
assert.equal(staleReengage.move, "none", "quiet for 80 days is not a 3-day re-engagement call");
assert.equal(staleReengage.reason, "reengage_lapsed");

// The boundary holds: still due at the edge of the lapse window, gone just past it.
assert.equal(
  decideNextMove({
    nowMs: NOW,
    leadCreatedAt: daysAgo(30 + MOVE_LAPSES_AFTER_DAYS - 1),
    engagement: { engaged: false }
  }).move,
  "call",
  "a chart call inside the lapse window is still due"
);
assert.equal(
  decideNextMove({
    nowMs: NOW,
    leadCreatedAt: daysAgo(30 + MOVE_LAPSES_AFTER_DAYS + 1),
    engagement: { engaged: false }
  }).reason,
  "chart_lapsed",
  "one day past the lapse window it becomes backlog"
);

console.log("next_move_resolver:eval OK — decision table + fail direction pinned (Joe 7/31 rulings)");
