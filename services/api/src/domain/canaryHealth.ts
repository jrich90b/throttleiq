/**
 * Post-deploy canary — the safety net that makes autonomy survivable.
 *
 * Joe, 2026-08-01: "Is there a way to continuously work without me approving PRs."
 *
 * THE PROBLEM. Approval BEFORE a change is a weak control here — Joe is not a programmer, so a diff
 * is the one artifact he cannot usefully check, and every PR that waits on him stalls the queue.
 * The control that actually works for autonomy is DETECTION AFTER: ship, watch what the agent does
 * to real customers, and pull it back when the numbers move the wrong way. `decision_equivalence`
 * proves a change is safe to ship; this checks whether it WAS.
 *
 * CALIBRATED AGAINST THE REAL STORE, NOT AN ASSUMPTION (2026-08-01). American Harley runs about
 * **26 customer sends a day — roughly one an hour**. That single number drives the whole design:
 *
 *   - A 6-hour window carries ~6 messages. Ratios on 6 messages are noise, so the first draft of
 *     this file would have returned UNKNOWN forever and been quietly useless.
 *   - Hence TWO SPEEDS. A slow ratio comparison needs ~24h to have anything to compare. But the
 *     failure that actually costs money — a runaway loop — does not show up as 2x, it shows up as
 *     20x (the 7/31 nudge bug drove the tick from 13s to 220s). At one-an-hour, thirty sends in an
 *     hour is unambiguous without any statistics at all. So the fast tripwire is an ABSOLUTE
 *     ceiling derived from the store's own history, and it fires in an hour; the slow ratio check
 *     catches subtler drift over a day.
 *
 * COUNTERS ARE READ FROM `provider`, NOT `kind`. Learned the hard way: outbound messages in this
 * store carry NO `kind` field at all — `provider` is where "this was a draft" vs "this was sent"
 * lives (`draft_ai` vs `twilio`/`sendgrid`/`human`). A first version keyed off `kind` and every
 * draft counter read ZERO against production while passing its own tests, because the tests used
 * invented fixtures. That is precisely the false-green this module exists to prevent, so
 * `findDeadCounters` now makes it structurally impossible to ship again: any counter that reads
 * zero across the ENTIRE store is treated as unwired, not as good news.
 *
 * FAIL DIRECTION — the one that would quietly ruin this: UNKNOWN must never read as HEALTHY. A
 * canary that says "looks fine" because it measured nothing launders an unwatched deploy as
 * watched, which is worse than no canary because it manufactures confidence. So: too little
 * traffic, a missing baseline, an unelapsed window, or a dead counter all return UNKNOWN, and
 * UNKNOWN authorizes nothing — not a rollback, and not a clean bill of health.
 */

export type CanaryCounters = {
  /** Messages that actually reached a customer (provider twilio/sendgrid/human). */
  outboundToCustomer: number;
  /** AI drafts produced (provider draft_ai) — the SILENCE detector, and a draft-flood detector. */
  draftsProduced: number;
  /** Conversations whose closedAt falls in the window — wrongful-close detector. */
  conversationsClosed: number;
  /** Quality-gate holds recorded in the window. */
  draftsHeld: number;
  /** Conversations that contributed anything — the sample size behind the counts. */
  activeConversations: number;
};

export type CanaryWindow = { startMs: number; endMs: number };

export type CanaryVerdict = {
  status: "healthy" | "regressed" | "unknown";
  /** Counters that breached, most severe first. Empty unless status is "regressed". */
  breaches: {
    metric: keyof CanaryCounters | "outboundPerHour";
    kind: "runaway" | "increase" | "collapse";
    baseline: number;
    current: number;
    limit: number;
    detail: string;
  }[];
  /** Why the run could not conclude. Non-empty <=> status is "unknown". */
  blockers: string[];
  reason: string;
};

export type CanaryThresholds = {
  /** An increase-guarded counter may not exceed baseline x this (slow check). */
  maxIncreaseRatio: number;
  /** draftsProduced may not fall below baseline x this (slow check). */
  minProducedRatio: number;
  /** Minimum outbound in the BASELINE window before any ratio verdict is allowed. */
  minBaselineOutbound: number;
  /** ...and minimum distinct conversations, so one chatty lead cannot decide a deploy. */
  minBaselineConversations: number;
  /** Fast tripwire: sends/hour above this multiple of the store's TYPICAL busy hour = runaway. */
  runawayPeakMultiple: number;
  /** ...but never trip below this absolute rate, so a sleepy history can't make the bar trivial. */
  runawayMinPerHour: number;
};

export const DEFAULT_CANARY_THRESHOLDS: CanaryThresholds = {
  // Deliberately loose. This is a CIRCUIT BREAKER for a change that went badly wrong, not a quality
  // metric — a tight bound reverts good deploys on ordinary variation, and a canary that cries wolf
  // gets switched off, which is the real failure.
  maxIncreaseRatio: 2.0,
  minProducedRatio: 0.34,
  // ~26 sends/day here, so ~20 needs about a day. Set from the measurement, not from taste.
  minBaselineOutbound: 20,
  minBaselineConversations: 8,
  runawayPeakMultiple: 3,
  runawayMinPerHour: 12 // ~12x the normal hourly rate; nothing legitimate here sends that fast
};

const SEND_PROVIDERS = new Set(["twilio", "sendgrid", "human"]);
const DRAFT_PROVIDER = "draft_ai";

/** Counters alarming when they RISE. `draftsProduced` is guarded in BOTH directions separately. */
const INCREASE_GUARDED: (keyof CanaryCounters)[] = [
  "outboundToCustomer",
  "draftsProduced",
  "conversationsClosed",
  "draftsHeld"
];

function ms(value: unknown): number {
  const t = Date.parse(String(value ?? ""));
  return Number.isFinite(t) ? t : NaN;
}

const inWindow = (t: number, w: CanaryWindow) => Number.isFinite(t) && t >= w.startMs && t < w.endMs;

/**
 * Pure projection: stored conversations + a window -> counters. Reads no clock, so a baseline and a
 * check over the same window always agree — which is what makes the comparison mean anything.
 */
export function computeCanaryCounters(conversations: any[], window: CanaryWindow): CanaryCounters {
  const counters: CanaryCounters = {
    outboundToCustomer: 0,
    draftsProduced: 0,
    conversationsClosed: 0,
    draftsHeld: 0,
    activeConversations: 0
  };

  for (const conv of conversations ?? []) {
    let touched = false;

    if (inWindow(ms(conv?.closedAt), window)) {
      counters.conversationsClosed += 1;
      touched = true;
    }

    for (const m of Array.isArray(conv?.messages) ? conv.messages : []) {
      if (m?.direction !== "out") continue;
      if (!inWindow(ms(m?.at), window)) continue;
      const provider = String(m?.provider ?? "").toLowerCase();
      // A DRAFT is not a SEND. Conflating them hides a draft flood — which still burns money and
      // still means a loop is running away, even though no customer was texted.
      if (provider === DRAFT_PROVIDER) {
        counters.draftsProduced += 1;
        touched = true;
      } else if (SEND_PROVIDERS.has(provider)) {
        counters.outboundToCustomer += 1;
        touched = true;
      }
      // voice_call / voice_summary / voice_transcript / payment_event are LOG entries, not messages
      // the agent chose to send, so they are deliberately outside every counter.
    }

    if (inWindow(ms(conv?.draftHeld?.at ?? conv?.draftHeld?.heldAt), window)) {
      counters.draftsHeld += 1;
      touched = true;
    }

    if (touched) counters.activeConversations += 1;
  }

  return counters;
}

/**
 * The store's TYPICAL busy hour of customer sends — the 99th percentile of hours that had any
 * traffic, NOT the maximum.
 *
 * Using the max is a trap, and the live store proves it: the busiest hour on record is 524 sends,
 * seventeen times the next busiest (31), because a bulk import once landed in a single hour. Scaling
 * the tripwire off that set the runaway ceiling to 1,572 sends/hour — high enough that no real
 * runaway could ever trip it. One historical backfill would have silently disarmed the alarm
 * forever, and nothing would have looked wrong.
 *
 * Measured distribution 2026-08-01 (1,021 non-empty hours): p50 2/h · p90 7/h · p95 9/h · p99 14/h.
 * A percentile ignores the import spike while still tracking real growth as the dealership scales.
 */
export function typicalPeakOutboundPerHour(conversations: any[]): number {
  const byHour = new Map<number, number>();
  for (const conv of conversations ?? []) {
    for (const m of Array.isArray(conv?.messages) ? conv.messages : []) {
      if (m?.direction !== "out") continue;
      if (!SEND_PROVIDERS.has(String(m?.provider ?? "").toLowerCase())) continue;
      const t = ms(m?.at);
      if (!Number.isFinite(t)) continue;
      const hour = Math.floor(t / 3_600_000);
      byHour.set(hour, (byHour.get(hour) ?? 0) + 1);
    }
  }
  const counts = [...byHour.values()].sort((a, b) => a - b);
  if (!counts.length) return 0;
  const at = (p: number) => counts[Math.min(counts.length - 1, Math.floor(counts.length * p))];
  const p99 = at(0.99);
  const median = Math.max(1, at(0.5));
  // A percentile alone is NOT enough: with few sampled hours, p99 lands ON the outlier (40 quiet
  // hours plus one 500-message import puts p99 at 500). Capping it against the MEDIAN — which a
  // single burst cannot move — makes it robust at both sample sizes. Live store: median 2/h,
  // p99 14/h, max 524/h => 14, so the import is ignored and real growth still tracks.
  return Math.min(p99, median * MEDIAN_PEAK_CAP_MULTIPLE);
}

/** How far above the median a "typical busy hour" may sit before we treat it as an outlier. */
const MEDIAN_PEAK_CAP_MULTIPLE = 8;

/**
 * THE FIX FOR THE BUG THAT BIT THIS FILE. A counter that reads zero across the ENTIRE store is
 * almost certainly not wired to the real data shape — that is how `kind`-based counters shipped
 * reading zero forever while passing their own tests. Treat it as broken instrumentation, never as
 * a quiet period.
 */
export function findDeadCounters(conversations: any[]): (keyof CanaryCounters)[] {
  const all = computeCanaryCounters(conversations, { startMs: -Infinity, endMs: Infinity });
  // draftsHeld is legitimately rare (holds are exceptional), so it is exempt from the dead check —
  // a store with zero holds is a store that never had a bad draft, not broken instrumentation.
  const guarded: (keyof CanaryCounters)[] = [
    "outboundToCustomer",
    "draftsProduced",
    "conversationsClosed",
    "activeConversations"
  ];
  return guarded.filter(k => all[k] === 0);
}

/**
 * FAST TRIPWIRE. A runaway loop is not a 2x drift, it is an order-of-magnitude flood, and at ~1
 * send/hour it is visible within the hour with no statistics at all. Independent of the slow ratio
 * check so it can fire long before a comparable window exists.
 */
export function detectRunaway(
  outboundInWindow: number,
  windowMs: number,
  historicalPeakPerHour: number,
  thresholds: CanaryThresholds = DEFAULT_CANARY_THRESHOLDS
): { runaway: boolean; perHour: number; limit: number } {
  const hours = windowMs / 3_600_000;
  if (!(hours > 0)) return { runaway: false, perHour: 0, limit: Infinity };
  const perHour = outboundInWindow / hours;
  const limit = Math.max(
    thresholds.runawayMinPerHour,
    Math.max(0, historicalPeakPerHour) * thresholds.runawayPeakMultiple
  );
  return { runaway: perHour > limit, perHour: Number(perHour.toFixed(2)), limit };
}

/**
 * Pure comparison: baseline counters vs the post-deploy window -> verdict.
 *
 * Returns UNKNOWN rather than HEALTHY whenever the comparison would be meaningless. That is the
 * whole safety property: worse than missing a regression is announcing there wasn't one when
 * nothing was actually measured.
 */
export function decideCanaryVerdict(
  baseline: CanaryCounters | null | undefined,
  current: CanaryCounters | null | undefined,
  thresholds: CanaryThresholds = DEFAULT_CANARY_THRESHOLDS,
  runaway?: { runaway: boolean; perHour: number; limit: number }
): CanaryVerdict {
  const breaches: CanaryVerdict["breaches"] = [];

  // The fast tripwire is judged FIRST and needs no baseline: an order-of-magnitude flood is a
  // regression whether or not a comparable window exists.
  if (runaway?.runaway) {
    breaches.push({
      metric: "outboundPerHour",
      kind: "runaway",
      baseline: runaway.limit,
      current: runaway.perHour,
      limit: runaway.limit,
      detail: `${runaway.perHour} customer sends/hour against a ceiling of ${runaway.limit} — a runaway loop, not drift`
    });
  }

  const blockers: string[] = [];
  if (!baseline) blockers.push("no baseline counters — nothing to compare against");
  if (!current) blockers.push("no post-deploy counters — the window was never measured");
  if (baseline && current) {
    if (baseline.outboundToCustomer < thresholds.minBaselineOutbound) {
      blockers.push(
        `baseline carried only ${baseline.outboundToCustomer} customer send(s) ` +
          `(need ${thresholds.minBaselineOutbound}) — at ~1/hour here that means the window was too short`
      );
    }
    if (baseline.activeConversations < thresholds.minBaselineConversations) {
      blockers.push(
        `baseline covered only ${baseline.activeConversations} conversation(s) ` +
          `(need ${thresholds.minBaselineConversations}) — one chatty lead must not decide a deploy`
      );
    }
  }

  if (blockers.length || !baseline || !current) {
    // A runaway still stands on its own — it never needed the baseline.
    if (breaches.length) {
      return {
        status: "regressed",
        breaches,
        blockers: [],
        reason: "the fast tripwire fired — a send flood is a regression regardless of the slow comparison"
      };
    }
    return {
      status: "unknown",
      breaches: [],
      blockers,
      reason: "the canary could not conclude — this is NOT a clean bill of health"
    };
  }

  for (const metric of INCREASE_GUARDED) {
    const base = baseline[metric];
    const now = current[metric];
    // A zero baseline has no ratio: 0 -> 1 would otherwise read as an infinite regression and
    // revert a perfectly good deploy.
    if (base <= 0) continue;
    const ratio = now / base;
    if (ratio > thresholds.maxIncreaseRatio) {
      breaches.push({
        metric,
        kind: "increase",
        baseline: base,
        current: now,
        limit: thresholds.maxIncreaseRatio,
        detail: `${metric} ${base} -> ${now} (x${ratio.toFixed(2)}, limit x${thresholds.maxIncreaseRatio})`
      });
    }
  }

  // The MIRROR failure: the agent stopped drafting. An increase-only check is blind to it.
  if (baseline.draftsProduced > 0) {
    const ratio = current.draftsProduced / baseline.draftsProduced;
    if (ratio < thresholds.minProducedRatio) {
      breaches.push({
        metric: "draftsProduced",
        kind: "collapse",
        baseline: baseline.draftsProduced,
        current: current.draftsProduced,
        limit: thresholds.minProducedRatio,
        detail:
          `drafting collapsed ${baseline.draftsProduced} -> ${current.draftsProduced} ` +
          `(x${ratio.toFixed(2)}, floor x${thresholds.minProducedRatio}) — the agent went quiet`
      });
    }
  }

  const order = { runaway: 0, collapse: 1, increase: 2 } as const;
  breaches.sort((a, b) => order[a.kind] - order[b.kind]);

  return breaches.length
    ? {
        status: "regressed",
        breaches,
        blockers: [],
        reason: `${breaches.length} guarded counter(s) moved past their limit after the deploy`
      }
    : {
        status: "healthy",
        breaches: [],
        blockers: [],
        reason: "every guarded counter stayed inside its limit over a window with enough traffic to judge"
      };
}

/**
 * The rollback the verdict implies. Returned as a PLAN, never executed — deciding a rollback is
 * warranted and having authority to redeploy production are different things, and this module only
 * ever has the first.
 */
export function buildRevertPlan(verdict: CanaryVerdict, deployedSha: string): string[] {
  if (verdict.status !== "regressed") return [];
  const sha = String(deployedSha ?? "").trim();
  if (!sha) return ["# BLOCKED: the deployed commit was not recorded — nothing to revert"];
  return [
    `git revert --no-edit ${sha}`,
    "# gates before it goes out, same as any change:",
    "(cd services/api && node ../../node_modules/typescript/bin/tsc -p tsconfig.json --noEmit)",
    "set -a; source .env; set +a; npm run ci:eval",
    "npm run deploy:api   # NEVER the raw script — it repoints the live store"
  ];
}

/**
 * THE DEPLOY GATE — "has the last behaviour deploy been judged, so another one may go out?"
 *
 * The canary's decision table above says whether a deploy hurt anyone. This says whether we have
 * an ANSWER yet, and it is what makes the readiness loop's rate limit mechanical instead of a
 * promise: no second behaviour deploy until the previous one's window has closed and come back
 * HEALTHY. Before this existed the baseline lived in /tmp and evaporated, so nothing ever came
 * back to judge a deploy at all — the canary watched, and then forgot.
 *
 * FAIL DIRECTION, and it is the whole point. Every state that is not a recorded HEALTHY verdict
 * BLOCKS. A missing record blocks; a window still running blocks; UNKNOWN blocks. The failure we
 * must never have is a gate that opens because it lost track — that launders an unwatched deploy
 * as watched, which is exactly the false-green failure the canary exists to avoid. Waiting costs
 * a few hours; a wrongly-opened gate stacks two unjudged behaviour changes on live customers.
 *
 * Behaviour-preserving CLEANUPS are exempt and never consult this — a change proven IDENTICAL by
 * the decision-equivalence harness cannot alter what a customer receives, so there is nothing for
 * a canary to judge.
 *
 * PURE + CLOCK-FREE: the caller passes `nowMs` in, so this stays unit-testable.
 */
export type CanaryPending = {
  /** When the baseline was captured (the deploy moment). */
  takenAtMs: number;
  /**
   * How long the watch window runs from `takenAtMs` — BUT for a PROGRESSIVE canary this is only the
   * baseline LOOKBACK (336h here), not when the watch concludes. Read `progress` before using it as
   * a deadline; that confusion is exactly what `nextSliceDueMs` below exists to prevent.
   */
  windowMs: number;
  /** The commit that went out. Needed to build the revert. */
  deployedSha: string;
  /** Present => measured as a series of short slices under a run-length rule. */
  progress?: { intervalMs: number; count: number } | null;
  /** Slices already taken. Only the COUNT matters here. */
  measurements?: unknown[] | null;
} | null;

export type CanaryGateDecision = {
  /** May another BEHAVIOUR deploy go out right now? */
  mayDeployBehaviour: boolean;
  /** Is there a canary waiting to be judged, and is its window closed? */
  pendingReady: boolean;
  minutesRemaining: number;
  reason: string;
};

/**
 * THE GATE IS A CIRCUIT BREAKER, NOT A TURNSTILE (Joe ruling 2026-08-03, revising his own 8/2
 * "one deploy watch at a time" rule after it was shown to be unsatisfiable at this dealership).
 *
 * The 8/2 rule: any open canary blocks the next behaviour deploy, so a bad deploy has ONE suspect.
 * Right in principle, arithmetically impossible here:
 *
 *   - `minBaselineOutbound` is 20 sends and this store sends ~26/DAY, so a window able to support a
 *     verdict at all is ~a day wide. Measured 2026-08-03: a live 48h capture returned 19 sends —
 *     UNDER the floor. The comparative check abstains (UNKNOWN) on an ordinary week.
 *   - The unstack loop merges every 20 minutes and supervised batches ship 6 PRs at once, so the
 *     48h of quiet the rule assumes never arrives.
 *   - UNKNOWN and never-judged BOTH blocked, so the first abstention latched the gate shut with no
 *     path back open. The 8/2 canary sat OPEN from 18:13Z on an all-zero baseline (it had read the
 *     stale base store — see detectStaleStore) and would have judged UNKNOWN on 8/4, which blocks,
 *     permanently. The loop's deploys were frozen while supervised deploys walked past it.
 *
 * A gate that is always shut protects nothing — it gets overridden, which is what happened on three
 * consecutive deploys. So the slow comparative check stops being a per-deploy blocker and becomes a
 * DAILY HEALTH READING. What still blocks is the state that means real harm:
 *
 *   BLOCK <= the last judged verdict was REGRESSED (customers measurably got worse)
 *   ALLOW <= anything else, with the current watch state reported
 *
 * FAIL DIRECTION. This deliberately trades "a regression might span several commits" for "the
 * breaker still works and is not routinely overridden". The protections that survive are the ones
 * that function at this cadence: `detectRunaway` (hourly, needs no baseline, catches the
 * catastrophic flood), the ci:eval suite, and the nightly corpus replay. Attribution for a slow
 * regression comes from those, not from freezing the pipeline.
 *
 * PURE + CLOCK-FREE: the caller passes `nowMs` in, so this stays unit-testable.
 */
export function decideCanaryGate(input: {
  pending: CanaryPending;
  /** The verdict of the most recently JUDGED canary, if any. */
  lastVerdictStatus?: CanaryVerdict["status"] | null;
  nowMs: number;
}): CanaryGateDecision {
  const pending = input.pending ?? null;
  const last = input.lastVerdictStatus ?? null;

  // Computed on every branch so a caller can still report WHAT is being watched and whether it is
  // ripe to judge. The watch keeps running; it just no longer holds the door shut.
  let pendingReady = false;
  let minutesRemaining = 0;
  let watching = "nothing is pending";
  if (pending) {
    // RIPENESS FOR A PROGRESSIVE CANARY IS THE NEXT SLICE, NOT THE BASELINE LOOKBACK.
    //
    // Found 2026-08-04. `status` reported "19,077 min left in its window" — 13 days — for a canary
    // that `judge` was already measuring at 2 of 9 slices and that can promote to HEALTHY after 3
    // consecutive clean ones (~24h). `windowMs` on a progressive canary is the 336h BASELINE
    // lookback; treating it as the deadline tells a caller "nothing to do for two weeks" while the
    // watch is quietly waiting to be asked.
    //
    // Why it matters more than a cosmetic number: `judge` is what RECORDS a verdict, and the whole
    // point of the #434 rework was that no deploy had ever actually been judged. A ripeness reading
    // that says "come back in 13 days" recreates that state — and the first-touch auto-send flip,
    // the biggest funnel lever we have, is gated on a recorded HEALTHY verdict.
    //
    // FAIL DIRECTION: ripe-too-early only causes an extra `judge` run, which is idempotent and
    // records nothing until the watch reaches a terminal verdict. Ripe-too-late loses the verdict
    // entirely. So round toward asking.
    const takenAtMs = Number(pending.takenAtMs);
    const intervalMs = Number(pending.progress?.intervalMs);
    const slicesTaken = Array.isArray(pending.measurements) ? pending.measurements.length : 0;
    const progressive = Number.isFinite(intervalMs) && intervalMs > 0;
    const endMs = progressive
      ? takenAtMs + (slicesTaken + 1) * intervalMs
      : takenAtMs + Number(pending.windowMs);
    const remainingMs = endMs - Number(input.nowMs);
    pendingReady = remainingMs <= 0;
    minutesRemaining = remainingMs > 0 ? Math.ceil(remainingMs / 60_000) : 0;
    const sha = pending.deployedSha.slice(0, 8) || "(unrecorded)";
    const what = progressive ? `slice ${slicesTaken + 1}` : "its window";
    watching = pendingReady
      ? `a canary on ${sha} is ready to judge${progressive ? ` (slice ${slicesTaken + 1} is due)` : ""}`
      : `a canary is open on ${sha} — ${minutesRemaining} min left in ${what}`;
  }

  // The ONE blocking condition: a measured regression is the only state where shipping more
  // behaviour on top makes things worse rather than merely less attributable.
  if (last === "regressed") {
    return {
      mayDeployBehaviour: false,
      pendingReady,
      minutesRemaining,
      reason: "the last canary REGRESSED — deal with that before shipping more behaviour"
    };
  }

  const note =
    last === "healthy"
      ? "the last canary returned HEALTHY"
      : last === "unknown"
        ? "the last canary abstained (UNKNOWN — too little traffic to compare), which is not a regression"
        : "no canary has been judged yet";
  return {
    mayDeployBehaviour: true,
    pendingReady,
    minutesRemaining,
    reason: `${note}; ${watching}`
  };
}

// =================================================================================================
// PROGRESSIVE MEASUREMENT — many small readings with a run-length rule, instead of one big
// before/after comparison (2026-08-03, adopting the Argo Rollouts AnalysisRun shape).
//
// WHY THE OLD SHAPE COULD NOT WORK HERE. `windowMs` was BOTH the baseline lookback AND the wait
// before a verdict, so the two requirements fought each other: widening the window to clear the
// 20-send floor also delayed the answer by the same amount. At ~26 sends/day a 48h baseline
// carries ~19-40 sends — straddling the floor — so the check abstained on ordinary weeks and no
// setting of a single knob fixed it.
//
// SPLITTING THE KNOB IS THE FIX. The baseline is now a LONG lookback (default 14 days ~ 360 sends
// here, far above any floor, and adequacy is checked ONCE at arm time), while measurements are
// SHORT slices taken on a schedule. Each slice is compared against the baseline scaled to the same
// duration, so `decideCanaryVerdict` — and every threshold already reasoned about and pinned — is
// reused unchanged.
//
// WHAT THIS DOES AND DOES NOT BUY. It does NOT create statistical power for a subtle regression;
// nothing does at this volume, and pretending otherwise is how a canary starts crying wolf. What
// it buys is (a) the ability to reach HEALTHY at all rather than abstaining forever, (b) a verdict
// in ~24h instead of 48h when things are fine, and (c) reliable detection of the failure mode we
// actually fear — a GROSS regression, which shows up as consecutive bad slices, not one noisy one.
//
// FAIL DIRECTION: a single bad slice never reverts anything (low-volume noise would make that a
// wolf-crier). Only `failureLimit` exceeded does. A runaway is exempt and terminal on sight — it
// never needed a baseline and an order-of-magnitude flood is not noise.
// =================================================================================================

export type CanaryMeasurementStatus = "pass" | "fail" | "inconclusive";

export type CanaryMeasurement = {
  atMs: number;
  sliceStartMs: number;
  sliceEndMs: number;
  counters: CanaryCounters;
  status: CanaryMeasurementStatus;
  /** A runaway: terminal on sight, no run-length rule applies. */
  fatal?: boolean;
  reason: string;
};

export type CanaryProgressConfig = {
  /** How long each measured slice is. */
  intervalMs: number;
  /** Maximum number of slices before the watch gives up. */
  count: number;
  /** Failures TOLERATED; exceeding this is a regression. Argo's `failureLimit`. */
  failureLimit: number;
  /** Consecutive passes that promote early. Argo's `consecutiveSuccessLimit`. */
  consecutiveSuccessLimit: number;
};

/**
 * Tuned to this dealership, not to taste: ~26 sends/day means an 8h slice carries ~9 sends, which
 * is enough for a gross-regression signal but not for fine drift. 3 consecutive clean slices
 * promotes at ~24h; 9 slices caps the watch at ~72h.
 */
export const DEFAULT_CANARY_PROGRESS: CanaryProgressConfig = {
  intervalMs: 8 * 3_600_000,
  count: 9,
  failureLimit: 2,
  consecutiveSuccessLimit: 3
};

/**
 * Scale counters to a different window length so a long baseline can be compared to a short slice.
 *
 * Rounded to 2dp: these numbers are quoted verbatim in operator-facing breach text, and
 * "drafting collapsed 4.333333333333333 -> 0" reads as a bug in the tool. The effect on a ratio
 * against a x0.34 floor is immaterial.
 */
export function scaleCounters(counters: CanaryCounters, factor: number): CanaryCounters {
  const f = Number.isFinite(factor) && factor > 0 ? factor : 0;
  const at = (n: number) => Math.round(n * f * 100) / 100;
  return {
    outboundToCustomer: at(counters.outboundToCustomer),
    draftsProduced: at(counters.draftsProduced),
    conversationsClosed: at(counters.conversationsClosed),
    draftsHeld: at(counters.draftsHeld),
    activeConversations: at(counters.activeConversations)
  };
}

/**
 * One slice -> pass / fail / inconclusive.
 *
 * The baseline's ADEQUACY was established once at arm time against the long lookback, so the
 * per-slice call deliberately relaxes the sample floors — re-applying a 20-send floor to a scaled
 * 8h slice would make every slice inconclusive, which is the bug this whole rework exists to kill.
 * What still makes a slice inconclusive is the scaled baseline being too small to support ANY
 * ratio (`minSliceOutbound`), which is an honest "this slice cannot say".
 */
export function measureCanarySlice(input: {
  baselineCounters: CanaryCounters;
  baselineWindowMs: number;
  sliceCounters: CanaryCounters;
  sliceWindowMs: number;
  thresholds?: CanaryThresholds;
  runaway?: { runaway: boolean; perHour: number; limit: number };
  /** Scaled-baseline sends below which a slice cannot conclude. */
  minSliceOutbound?: number;
}): { status: CanaryMeasurementStatus; fatal: boolean; verdict: CanaryVerdict; reason: string } {
  const thresholds = input.thresholds ?? DEFAULT_CANARY_THRESHOLDS;
  const minSlice = input.minSliceOutbound ?? 3;

  // A runaway is terminal on sight and needs no baseline at all.
  if (input.runaway?.runaway) {
    const verdict = decideCanaryVerdict(null, null, thresholds, input.runaway);
    return {
      status: "fail",
      fatal: true,
      verdict,
      reason: `runaway: ${input.runaway.perHour}/h against a ceiling of ${input.runaway.limit}`
    };
  }

  const factor =
    Number(input.baselineWindowMs) > 0 ? Number(input.sliceWindowMs) / Number(input.baselineWindowMs) : 0;
  const scaled = scaleCounters(input.baselineCounters, factor);

  if (scaled.outboundToCustomer < minSlice) {
    return {
      status: "inconclusive",
      fatal: false,
      verdict: {
        status: "unknown",
        breaches: [],
        blockers: [`slice expects only ${scaled.outboundToCustomer.toFixed(1)} send(s) (need ${minSlice})`],
        reason: "this slice is too small to support a ratio"
      },
      reason: `slice too small: expected ~${scaled.outboundToCustomer.toFixed(1)} sends (need ${minSlice})`
    };
  }

  // Sample floors are relaxed here ON PURPOSE — see the doc comment above.
  const sliceThresholds: CanaryThresholds = {
    ...thresholds,
    minBaselineOutbound: 0,
    minBaselineConversations: 0
  };
  const verdict = decideCanaryVerdict(scaled, input.sliceCounters, sliceThresholds, input.runaway);
  if (verdict.status === "regressed") {
    return { status: "fail", fatal: false, verdict, reason: verdict.breaches[0]?.detail ?? verdict.reason };
  }
  if (verdict.status === "healthy") {
    return { status: "pass", fatal: false, verdict, reason: "every guarded counter stayed inside its limit" };
  }
  return { status: "inconclusive", fatal: false, verdict, reason: verdict.blockers[0] ?? verdict.reason };
}

export type CanaryProgressDecision = {
  status: "watching" | "healthy" | "regressed" | "unknown";
  reason: string;
  passes: number;
  failures: number;
  inconclusive: number;
  consecutivePasses: number;
};

/**
 * The run-length rule over completed measurements.
 *
 * INCONCLUSIVE IS NEUTRAL: it neither counts as a failure nor resets a passing streak. A quiet
 * overnight stretch must not undo three clean daytime slices — treating silence as evidence is
 * exactly the false-green this module exists to avoid, and treating it as a failure would revert
 * good deploys every night.
 */
export function decideCanaryProgress(input: {
  measurements: CanaryMeasurement[];
  config?: CanaryProgressConfig;
}): CanaryProgressDecision {
  const config = input.config ?? DEFAULT_CANARY_PROGRESS;
  const measurements = Array.isArray(input.measurements) ? input.measurements : [];

  const passes = measurements.filter(m => m.status === "pass").length;
  const failures = measurements.filter(m => m.status === "fail").length;
  const inconclusive = measurements.filter(m => m.status === "inconclusive").length;

  let consecutivePasses = 0;
  for (let i = measurements.length - 1; i >= 0; i--) {
    const s = measurements[i].status;
    if (s === "pass") consecutivePasses += 1;
    else if (s === "fail") break;
    // inconclusive: neutral, keep scanning back
  }

  const base = { passes, failures, inconclusive, consecutivePasses };

  if (measurements.some(m => m.fatal)) {
    return { ...base, status: "regressed", reason: "a runaway send flood fired — terminal on sight" };
  }
  if (failures > config.failureLimit) {
    return {
      ...base,
      status: "regressed",
      reason: `${failures} failed slice(s) against a tolerance of ${config.failureLimit}`
    };
  }
  if (consecutivePasses >= config.consecutiveSuccessLimit) {
    return {
      ...base,
      status: "healthy",
      reason: `${consecutivePasses} consecutive clean slice(s) — promoted early`
    };
  }
  if (measurements.length >= config.count) {
    return passes > 0
      ? {
          ...base,
          status: "healthy",
          reason: `watch ran its full ${config.count} slice(s): ${passes} clean, ${failures} failed (tolerance ${config.failureLimit})`
        }
      : {
          ...base,
          status: "unknown",
          reason: `watch ran its full ${config.count} slice(s) and NOTHING was conclusive — not a clean bill of health`
        };
  }
  return {
    ...base,
    status: "watching",
    reason: `${measurements.length}/${config.count} slice(s): ${passes} clean, ${failures} failed, ${inconclusive} inconclusive`
  };
}

/**
 * THE WRONG-STORE GUARD — why the 2026-08-02 canary recorded all zeros.
 *
 * `canary_watch` resolves its store from CONVERSATIONS_DB_PATH, else DATA_DIR, else a relative
 * path. Miss the env var on the box and it silently reads the STALE BASE store
 * (/home/ubuntu/throttleiq-runtime/data, frozen 2026-06-16, 471 convs) instead of the dealer's.
 * That store defeats every guard we had: it is non-empty, and it carries 3,720 lifetime outbound
 * messages so `findDeadCounters` sees nothing dead — but it has had ZERO activity since June, so
 * every recent window reads 0. That is exactly the all-zero baseline armed on 2026-08-02, and it is
 * the same family as the deploy `--profile` footgun (CLAUDE.md): a silent default pointing at the
 * base store instead of the dealer's.
 *
 * The tell a lifetime-counter check cannot see: the store's newest activity predates the window we
 * are about to measure. A genuinely quiet dealership still has SOMETHING recent; a wrong or frozen
 * store does not.
 *
 * FAIL DIRECTION: refusing to arm fails toward having NO canary plus a loud error, never toward a
 * baseline of zeros — which would clear any deploy it was ever compared against, since "after" can
 * only be >= 0.
 */
export function detectStaleStore(input: {
  /** Newest outbound message timestamp anywhere in the store, ms. */
  newestOutboundMs: number | null;
  nowMs: number;
  windowMs: number;
}): { stale: boolean; ageHours: number; reason: string } {
  const newest = Number(input.newestOutboundMs ?? 0);
  if (!Number.isFinite(newest) || newest <= 0) {
    return { stale: true, ageHours: Infinity, reason: "the store has no dated outbound messages at all" };
  }
  const ageHours = (Number(input.nowMs) - newest) / 3_600_000;
  const windowStart = Number(input.nowMs) - Number(input.windowMs);
  if (newest < windowStart) {
    return {
      stale: true,
      ageHours,
      reason:
        `the store's newest outbound message is ${Math.floor(ageHours)}h old, predating the ` +
        `${Math.round(Number(input.windowMs) / 3_600_000)}h baseline window entirely — a wrong or frozen store, not a quiet one`
    };
  }
  return { stale: false, ageHours, reason: "the store has activity inside the baseline window" };
}

/** Newest outbound (sent or drafted) message timestamp in the store, or null if there is none. */
export function newestOutboundAtMs(conversations: any[]): number | null {
  let newest = 0;
  for (const conv of conversations ?? []) {
    for (const m of Array.isArray(conv?.messages) ? conv.messages : []) {
      if (m?.direction !== "out") continue;
      const provider = String(m?.provider ?? "").toLowerCase();
      if (provider !== DRAFT_PROVIDER && !SEND_PROVIDERS.has(provider)) continue;
      const t = ms(m?.at);
      if (Number.isFinite(t) && t > newest) newest = t;
    }
  }
  return newest > 0 ? newest : null;
}
