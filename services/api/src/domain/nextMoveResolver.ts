/**
 * Next-Move resolver — the ONE next human action on a lead, or none.
 *
 * WHY THIS EXISTS (Joe, 2026-07-31: "Tasks still seem like they are confusing for
 * salespeople… sometimes there are multiple tasks created when there probably shouldn't
 * be"). Today staff tasks are EMITTED by 204 independent call sites (150 in index.ts,
 * 61 in routes/sendgridInbound.ts, 3 in conversationStore.ts), each with its own hardcoded
 * wording and its own idea of whether to set a due date. Measured consequence on the live
 * American Harley store: 69% of open tasks carry no due date, 18% carry no owner, the
 * oldest is 36 days old, and 547 of 1913 closed tasks lived under an hour. Nothing
 * re-evaluates an open task on a timer.
 *
 * This module replaces "whichever code noticed something writes a task" with ONE decision
 * per lead. It is PURE — no I/O, no store access, no clock read — so it is eval-pinnable
 * and can be applied identically in BOTH reply paths (/webhooks/twilio and
 * /conversations/:id/regenerate) per AGENTS.md route-centralization law.
 *
 * COMPREHENSION IS NOT DONE HERE. Whether an inbound is real customer engagement, and what
 * a move should SAY, are comprehension jobs for a typed LLM parser — this module consumes
 * an already-judged `EngagementState` and emits a machine reason. It only owns thresholds,
 * precedence, and side-effect gating, which AGENTS.md explicitly allows to be deterministic.
 * Feeding it a keyword guess instead of a parser verdict would violate parser-first law.
 *
 * JOE'S RULINGS ENCODED HERE (memory `joe-rulings-7-31-decision-queue`):
 *  1. "If there is engagement it should not make call tasks." Engagement suppresses
 *     CHASING calls entirely — not deferred, never created.
 *  2. "3 days should be a call." An engaged lead gone quiet 3 days earns a CALL, not a text.
 *  3. "Watches should stop the cadence too, or if we tell them when a bike should be coming
 *     in." Generalized: a KNOWN NEXT EVENT replaces the generic timetable.
 *  4. A lead that has told us nothing runs the printed wall chart
 *     (memory `followup-cadence-wall-chart`), floored at day 3 by ruling 2.
 *
 * FAIL DIRECTION (AGENTS.md migrate-vs-keep test). A wrongly SUPPRESSED move silently drops
 * a live lead — expensive and invisible. A wrongly EMITTED move costs a salesperson ten
 * seconds. So every gate here fails toward EMITTING: suppression requires a POSITIVE,
 * confident signal (a judged engagement verdict, a dated known event). Absent or ambiguous
 * input never suppresses.
 *
 * SHIPS INERT: nothing imports this into a reply path yet. Phase 1 is shadow reporting only
 * (scripts/next_move_resolver_shadow.ts) so the rewritten board can be compared against the
 * real one before anything reaches staff screens.
 */

/** The printed dealership wall chart's touch days (day 1 = lead arrival). */
export const FOLLOW_UP_CHART_DAYS = [1, 2, 3, 5, 7, 10, 14, 18, 21, 27, 30] as const;

/**
 * No chart CALL before day 3 (Joe, 2026-07-31). Day-1/day-2 calls land while the agent is
 * still mid-conversation on a fresh lead — the exact pestering this work exists to remove.
 * Priced at 5.8 calls/day of pure noise across the store.
 */
export const CHART_CALL_MIN_DAY = 3;

/** Quiet days after an engaged customer's last reply before a human call is earned. */
export const ENGAGED_QUIET_DAYS_FOR_CALL = 3;

/**
 * A move whose moment passed more than this many days ago is LAPSED, not due.
 *
 * Found by the phase-1 shadow run (2026-07-31) before any of this reached a screen: without
 * it the resolver told the store it owed 241 calls, and the sample was dated MAY — leads that
 * arrived in April, never engaged, and permanently "owed" a day-30 call that nothing would
 * ever mark served. Emitting a backdated flood on day one would destroy trust in the board
 * faster than the mess it replaces.
 *
 * A lapsed lead does not silently vanish: `decideNextMove` reports it as `chart_lapsed` /
 * `reengage_lapsed` so the caller can count the ONE-TIME backlog and decide once whether to
 * sweep it. What such a lead actually needs is a decision — the warm sign-off — not a call
 * dated three months ago. That sign-off move is phase 3.
 */
export const MOVE_LAPSES_AFTER_DAYS = 7;

const DAY_MS = 86_400_000;

/**
 * A judged view of whether the CUSTOMER has really spoken. Produced upstream by the
 * fulfillment/engagement parser — NOT by keyword matching here. `engaged: false` must mean
 * "no customer-authored reply", excluding lead-intake (ADF/widget) payloads, automated
 * senders, iOS tapback echoes, and staff notes logged into the thread.
 */
export type EngagementState = {
  engaged: boolean;
  /** ISO of the customer's most recent real reply, when engaged. */
  lastCustomerReplyAt?: string | null;
};

/**
 * A dated thing the customer is already waiting on. Its presence means the next contact is
 * already determined, so the generic timetable must stay silent until then. `at` is when the
 * event became known (not when it resolves) — suppression starts from that moment.
 */
export type KnownNextEvent = {
  kind:
    | "inventory_watch" // waiting on a watched bike
    | "order_hold" // we told them a bike is on order
    | "unit_hold" // a unit is being held for them
    | "appointment" // booked
    | "manual_handoff" // a human owns this thread
    | "customer_named_time" // "call me Friday" — their own instruction outranks ours
    | "paused";
  at?: string | null;
};

export type NextMoveInput = {
  /** Evaluation clock, ms. Passed in so the decision is pure and replayable. */
  nowMs: number;
  /** ISO the lead arrived — day 1 of the chart. */
  leadCreatedAt: string;
  engagement: EngagementState;
  /** Null when nothing is pending. */
  knownNextEvent?: KnownNextEvent | null;
  /** Lead is closed/sold — never chase. */
  closed?: boolean;
  /** Customer opted out — never chase, ever. */
  optedOut?: boolean;
  /**
   * Highest chart day already served, so a call isn't re-emitted every evaluation tick.
   * 0 / undefined = nothing served yet.
   */
  servedThroughChartDay?: number;
};

export type NextMoveKind = "none" | "call";

/**
 * A move that came due and was never actioned. Joe, 2026-07-31: "The call should disappear
 * but should show up in the KPIs somewhere showing how many calls the salesperson missed for
 * accountability." So a lapse leaves the daily board (it is not today's work) but never
 * leaves the RECORD — this is the attributable receipt.
 */
export type LapsedMove = {
  kind: "chart" | "reengage";
  /** ISO the move was due. */
  dueAt: string;
  /** Whole days between the due moment and evaluation. */
  daysLate: number;
  /** Chart day it represented, when it came from the wall chart. */
  chartDay?: number;
};

export type NextMoveDecision = {
  move: NextMoveKind;
  /** Machine-legible why, for the shadow log and the eval. */
  reason: string;
  /** ISO when the move is due, when there is one. */
  dueAt?: string;
  /** The chart day this call serves, for `servedThroughChartDay` bookkeeping. */
  chartDay?: number;
  /** Present only when the move lapsed — carries the accountability record. */
  lapsed?: LapsedMove;
};

/** Chart days that may produce a CALL, after Joe's day-3 floor. */
export function chartCallDays(): number[] {
  return FOLLOW_UP_CHART_DAYS.filter(d => d >= CHART_CALL_MIN_DAY);
}

/**
 * The highest chart call-day whose moment has arrived and which has not been served yet, or
 * null. Returns the HIGHEST rather than the next unserved one so a lead that was suppressed
 * for a stretch (a watch that later cleared) rejoins the chart at today's position instead of
 * replaying a backlog of stale calls at the salesperson.
 */
export function dueChartCallDay(
  daysElapsed: number,
  servedThroughChartDay = 0
): number | null {
  let due: number | null = null;
  for (const d of chartCallDays()) {
    if (d > daysElapsed) break;
    if (d <= servedThroughChartDay) continue;
    due = d;
  }
  return due;
}

function parseMs(value: unknown): number {
  const ms = Date.parse(String(value ?? ""));
  return Number.isFinite(ms) ? ms : NaN;
}

/**
 * THE decision. Pure. Precedence is Joe's, in order:
 *   opted out / closed  >  known next event  >  engaged  >  the chart.
 */
export function decideNextMove(input: NextMoveInput): NextMoveDecision {
  // 1. Hard stops. An opt-out is absolute; a closed lead is not chased.
  if (input.optedOut) return { move: "none", reason: "opted_out" };
  if (input.closed) return { move: "none", reason: "lead_closed" };

  // 2. A known next event IS the cadence (Joe: watches / "a bike is coming in"). Suppress
  //    only from the moment the event became known — an undated event still suppresses,
  //    because its presence is itself the positive signal.
  const event = input.knownNextEvent;
  if (event?.kind) {
    const knownAt = parseMs(event.at);
    if (!Number.isFinite(knownAt) || knownAt <= input.nowMs) {
      return { move: "none", reason: `known_next_event:${event.kind}` };
    }
  }

  // 3. Engagement suppresses chasing entirely (Joe: "if there is engagement it should not
  //    make call tasks"). The ONLY call an engaged lead earns is the 3-quiet-day re-engage.
  if (input.engagement?.engaged) {
    const lastReplyMs = parseMs(input.engagement.lastCustomerReplyAt);
    // Engaged but we can't tell when — fail toward NOT chasing an active conversation.
    if (!Number.isFinite(lastReplyMs)) {
      return { move: "none", reason: "engaged_reply_time_unknown" };
    }
    const quietMs = input.nowMs - lastReplyMs;
    if (quietMs < ENGAGED_QUIET_DAYS_FOR_CALL * DAY_MS) {
      return { move: "none", reason: "engaged_recently" };
    }
    const dueMs = lastReplyMs + ENGAGED_QUIET_DAYS_FOR_CALL * DAY_MS;
    // Quiet for months is not a 3-day re-engagement call — it's a lead awaiting a decision.
    if (input.nowMs - dueMs > MOVE_LAPSES_AFTER_DAYS * DAY_MS) {
      return {
        move: "none",
        reason: "reengage_lapsed",
        lapsed: {
          kind: "reengage",
          dueAt: new Date(dueMs).toISOString(),
          daysLate: Math.floor((input.nowMs - dueMs) / DAY_MS)
        }
      };
    }
    return { move: "call", reason: "engaged_then_quiet", dueAt: new Date(dueMs).toISOString() };
  }

  // 4. Never engaged → the wall chart, floored at day 3.
  const createdMs = parseMs(input.leadCreatedAt);
  // Unknown lead age: fail toward emitting nothing rather than inventing a chart position.
  if (!Number.isFinite(createdMs)) return { move: "none", reason: "lead_age_unknown" };
  const daysElapsed = Math.floor((input.nowMs - createdMs) / DAY_MS);
  const day = dueChartCallDay(daysElapsed, input.servedThroughChartDay ?? 0);
  if (day == null) {
    return {
      move: "none",
      reason:
        daysElapsed > FOLLOW_UP_CHART_DAYS[FOLLOW_UP_CHART_DAYS.length - 1]
          ? "chart_exhausted"
          : "no_chart_day_due"
    };
  }
  const dueMs = createdMs + day * DAY_MS;
  // A chart day that came due weeks ago is a backlog item, not today's work.
  if (input.nowMs - dueMs > MOVE_LAPSES_AFTER_DAYS * DAY_MS) {
    return {
      move: "none",
      reason: "chart_lapsed",
      chartDay: day,
      lapsed: {
        kind: "chart",
        dueAt: new Date(dueMs).toISOString(),
        daysLate: Math.floor((input.nowMs - dueMs) / DAY_MS),
        chartDay: day
      }
    };
  }
  return { move: "call", reason: "chart_day", chartDay: day, dueAt: new Date(dueMs).toISOString() };
}

// ---------------------------------------------------------------------------
// MISSED-CALL ACCOUNTABILITY KPI
//
// Joe, 2026-07-31: "The call should disappear but should show up in the KPIs somewhere
// showing how many calls the salesperson missed for accountability."
//
// A lapsed move leaves the daily board but not the record. This rolls those receipts up
// per salesperson. PURE — the caller supplies the rows, so it is eval-pinnable and can back
// either a KPI endpoint or a digest line without either owning the arithmetic.
//
// FAIRNESS, deliberately built in: a lapsed move on a lead NOBODY was assigned is not a
// salesperson's miss — it is an assignment gap, and charging it to a person would make the
// metric dishonest the first time it is used. Those land in `unassigned`, counted and
// visible, never folded into anyone's number.
// ---------------------------------------------------------------------------

export type MissedCallRow = {
  ownerId?: string | null;
  ownerName?: string | null;
  lapsed: LapsedMove;
};

export type MissedCallsByOwner = {
  ownerId: string | null;
  ownerName: string;
  missed: number;
  /** Days late of the oldest miss — how long the worst one sat. */
  oldestDaysLate: number;
  chartMisses: number;
  reengageMisses: number;
};

export type MissedCallsSummary = {
  total: number;
  /** Lapsed moves on leads with no owner — an assignment gap, charged to nobody. */
  unassigned: number;
  byOwner: MissedCallsByOwner[];
};

/**
 * Roll lapsed moves up per salesperson, worst first. Pure and total-preserving:
 * `total === unassigned + sum(byOwner.missed)` always holds, so the number can never
 * quietly lose misses.
 */
export function summarizeMissedCalls(rows: MissedCallRow[]): MissedCallsSummary {
  const byKey = new Map<string, MissedCallsByOwner>();
  let unassigned = 0;
  let total = 0;

  for (const row of rows ?? []) {
    if (!row?.lapsed) continue;
    total += 1;
    const name = String(row.ownerName ?? "").trim();
    const id = String(row.ownerId ?? "").trim();
    if (!name && !id) {
      unassigned += 1;
      continue;
    }
    const key = id || name;
    const entry =
      byKey.get(key) ??
      ({
        ownerId: id || null,
        ownerName: name || "(unnamed owner)",
        missed: 0,
        oldestDaysLate: 0,
        chartMisses: 0,
        reengageMisses: 0
      } as MissedCallsByOwner);
    entry.missed += 1;
    const late = Number(row.lapsed.daysLate);
    if (Number.isFinite(late) && late > entry.oldestDaysLate) entry.oldestDaysLate = late;
    if (row.lapsed.kind === "chart") entry.chartMisses += 1;
    else entry.reengageMisses += 1;
    byKey.set(key, entry);
  }

  const byOwner = [...byKey.values()].sort(
    (a, b) => b.missed - a.missed || b.oldestDaysLate - a.oldestDaysLate
  );
  return { total, unassigned, byOwner };
}
