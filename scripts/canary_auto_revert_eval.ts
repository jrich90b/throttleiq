/**
 * canary_auto_revert:eval — pins the post-deploy canary's decision table.
 *
 * The canary is the control that lets work ship without Joe approving every PR (Joe, 2026-08-01:
 * "Is there a way to continuously work without me approving PRs"), so its own failure modes matter
 * more than most:
 *
 *   FALSE GREEN ruins it. A canary reporting HEALTHY because it measured nothing launders an
 *   unwatched deploy as watched — worse than no canary, because it manufactures confidence. Every
 *   "not enough to judge" path must return UNKNOWN, and UNKNOWN must never read as HEALTHY.
 *
 *   FALSE RED gets it switched off. Reverting a good deploy because Sunday was quiet teaches
 *   everyone to ignore it. Hence loose thresholds and a minimum-traffic floor.
 *
 * FIXTURES ARE PRODUCTION-SHAPED, AND THAT IS LOAD-BEARING. The first version of this eval invented
 * a `kind` field ("draft_ai", "cadence") that DOES NOT EXIST on any outbound message in the real
 * store — every draft counter read zero against production while this file stayed green. Fixtures
 * built from imagination test the code against the author's memory, not the system. Real outbound
 * shape, verified against the live store 2026-08-01:
 *     { id, direction:"out", from, to, body, at, provider, providerMessageId }
 * `provider` is the discriminator (twilio | sendgrid | human | draft_ai | voice_* | payment_event);
 * there is NO `kind`. `findDeadCounters` exists so that class of bug fails loudly next time.
 *
 * Behavior assertions only — no source-text pins (see eval_source_pin_ratchet:eval).
 *
 * Run: npx tsx scripts/canary_auto_revert_eval.ts
 */
import assert from "node:assert/strict";
import {
  computeCanaryCounters,
  decideCanaryVerdict,
  detectRunaway,
  detectStaleStore,
  findDeadCounters,
  newestOutboundAtMs,
  typicalPeakOutboundPerHour,
  buildRevertPlan,
  decideCanaryGate,
  measureCanarySlice,
  decideCanaryProgress,
  scaleCounters,
  DEFAULT_CANARY_THRESHOLDS,
  type CanaryCounters,
  type CanaryMeasurement
} from "../services/api/src/domain/canaryHealth.ts";

let checks = 0;
const eq = (actual: unknown, expected: unknown, message: string) => {
  assert.deepEqual(actual, expected, message);
  checks++;
};
const ok = (cond: boolean, message: string) => {
  assert.equal(cond, true, message);
  checks++;
};

// A baseline with enough traffic to judge (~a day at this dealership's ~26 sends/day).
const BASE: CanaryCounters = {
  outboundToCustomer: 26,
  draftsProduced: 12,
  conversationsClosed: 3,
  draftsHeld: 2,
  activeConversations: 29
};
const after = (over: Partial<CanaryCounters> = {}): CanaryCounters => ({ ...BASE, ...over });

// ---------------------------------------------------------------------------
// 1. GREEN PATH — ordinary variation must not trip it.
// ---------------------------------------------------------------------------
eq(decideCanaryVerdict(BASE, after()).status, "healthy", "identical counters are healthy");
eq(
  decideCanaryVerdict(BASE, after({ outboundToCustomer: 45, draftsProduced: 20 })).status,
  "healthy",
  "a busy-but-normal day (under 2x) is healthy — a canary that cries wolf gets switched off"
);
eq(
  decideCanaryVerdict(BASE, after({ outboundToCustomer: 14, draftsProduced: 7 })).status,
  "healthy",
  "a quieter day is healthy — only a COLLAPSE in drafting is guarded, not a dip in sends"
);

// ---------------------------------------------------------------------------
// 2. THE RUNAWAY — the 7/31 nudge-bug shape (tick 13s -> 220s, texting everyone).
// ---------------------------------------------------------------------------
{
  const r = detectRunaway(60, 3_600_000, 4); // 60 sends in one hour, historical peak 4/h
  ok(r.runaway, "60 sends in an hour against a peak of 4 is a runaway");
  const v = decideCanaryVerdict(BASE, after({ outboundToCustomer: 60 }), DEFAULT_CANARY_THRESHOLDS, r);
  eq(v.status, "regressed", "and the verdict is a regression");
  eq(v.breaches[0].kind, "runaway", "the runaway is reported FIRST — it is the most urgent");
}
// The fast tripwire stands alone: it fires without any usable baseline, because an
// order-of-magnitude flood needs no statistics.
{
  const r = detectRunaway(60, 3_600_000, 4);
  const v = decideCanaryVerdict(after({ outboundToCustomer: 1, activeConversations: 1 }), after(), DEFAULT_CANARY_THRESHOLDS, r);
  eq(v.status, "regressed", "a runaway is a regression even when the baseline is too thin to compare");
  eq(v.blockers, [], "and it is not downgraded to UNKNOWN");
}
// A normal hour must NOT trip it, and a sleepy history must not make the bar trivially low.
{
  eq(detectRunaway(1, 3_600_000, 4).runaway, false, "one send an hour is normal here");
  eq(detectRunaway(3, 3_600_000, 0).runaway, false, "a store with no history still needs a real flood to trip");
  ok(
    detectRunaway(2, 3_600_000, 0).limit >= DEFAULT_CANARY_THRESHOLDS.runawayMinPerHour,
    "the absolute floor holds even when historical peak is zero"
  );
  eq(detectRunaway(10, 0, 4).runaway, false, "a zero-length window cannot produce a rate");
}

// Wrongful closes, and a quality gate that started rejecting everything.
eq(
  decideCanaryVerdict(BASE, after({ conversationsClosed: 12 })).status,
  "regressed",
  "a spike in closed conversations is a regression — live leads marked done"
);
eq(
  decideCanaryVerdict(BASE, after({ draftsHeld: 9 })).status,
  "regressed",
  "a pile-up of held drafts is a regression"
);
eq(
  decideCanaryVerdict(BASE, after({ draftsProduced: 40 })).status,
  "regressed",
  "a DRAFT flood is a regression too — it burns money and signals a loop, even with nothing sent"
);

// ---------------------------------------------------------------------------
// 3. THE MIRROR FAILURE — the agent goes SILENT. Increase-only checks are blind to this.
// ---------------------------------------------------------------------------
{
  const v = decideCanaryVerdict(BASE, after({ draftsProduced: 1 }));
  eq(v.status, "regressed", "drafting collapsing to near-zero is a regression");
  eq(v.breaches.find(b => b.metric === "draftsProduced")?.kind, "collapse", "reported as a collapse");
}
eq(
  decideCanaryVerdict(BASE, after({ draftsProduced: 0 })).status,
  "regressed",
  "producing NOTHING is the loudest version of the same failure"
);

// ---------------------------------------------------------------------------
// 4. ABSTAIN — the safety property. Never HEALTHY when nothing could be judged.
// ---------------------------------------------------------------------------
for (const [label, baseline] of [
  ["a near-silent baseline", after({ outboundToCustomer: 3 })],
  ["one chatty lead", after({ activeConversations: 2 })]
] as const) {
  const v = decideCanaryVerdict(baseline, after({ outboundToCustomer: 999, conversationsClosed: 999 }));
  eq(v.status, "unknown", `${label}: too little to judge => UNKNOWN`);
  ok(v.blockers.length > 0, `${label}: and it says why`);
  eq(v.breaches, [], `${label}: it must not report breaches it cannot stand behind`);
}
for (const [label, a, b] of [
  ["missing baseline", null, after()],
  ["missing current", BASE, null],
  ["both missing", null, null]
] as const) {
  const v = decideCanaryVerdict(a, b);
  eq(v.status, "unknown", `${label} => UNKNOWN`);
  ok(v.status !== "healthy", `${label} must NEVER read as healthy`);
}
eq(
  decideCanaryVerdict(after({ draftsHeld: 0 }), after({ draftsHeld: 1 })).status,
  "healthy",
  "0 -> 1 on a zero baseline is not an infinite regression"
);

// ---------------------------------------------------------------------------
// 5. COUNTERS, AGAINST PRODUCTION-SHAPED MESSAGES (provider, never kind).
// ---------------------------------------------------------------------------
const T = (iso: string) => Date.parse(iso);
const WINDOW = { startMs: T("2026-08-01T12:00:00Z"), endMs: T("2026-08-01T18:00:00Z") };
const out = (provider: string, at: string) => ({
  id: `msg_${provider}_${at}`,
  direction: "out",
  from: "dealership",
  to: "716-555-0100",
  body: "…",
  at,
  provider,
  providerMessageId: "SM0"
});

const CONVS = [
  {
    id: "in-window",
    closedAt: "2026-08-01T13:00:00Z",
    draftHeld: { at: "2026-08-01T14:00:00Z", reason: "live_regenerate" },
    messages: [
      out("twilio", "2026-08-01T12:30:00Z"),
      out("sendgrid", "2026-08-01T12:45:00Z"),
      out("human", "2026-08-01T13:15:00Z"),
      out("draft_ai", "2026-08-01T14:30:00Z"),
      out("voice_call", "2026-08-01T15:00:00Z"),
      out("voice_transcript", "2026-08-01T15:01:00Z"),
      out("payment_event", "2026-08-01T15:02:00Z"),
      { direction: "in", provider: "twilio", at: "2026-08-01T16:00:00Z", body: "hi" }
    ]
  },
  {
    id: "outside-window",
    closedAt: "2026-07-30T13:00:00Z",
    messages: [out("twilio", "2026-07-30T12:30:00Z")]
  }
];

{
  const c = computeCanaryCounters(CONVS, WINDOW);
  eq(c.outboundToCustomer, 3, "twilio + sendgrid + human are the real sends");
  eq(c.draftsProduced, 1, "draft_ai is a DRAFT, not a send — conflating them hides a draft flood");
  eq(c.conversationsClosed, 1, "only the close inside the window counts");
  eq(c.draftsHeld, 1, "draftHeld.at inside the window counts");
  eq(c.activeConversations, 1, "the conversation outside the window contributed nothing");
}
// Voice + payment rows are LOGS, not messages the agent chose to send. If they ever leaked into
// outbound they would swamp every counter (1,600+ of them in the live store).
{
  const voiceOnly = [{ id: "v", messages: [out("voice_summary", "2026-08-01T13:00:00Z")] }];
  eq(
    computeCanaryCounters(voiceOnly, WINDOW).outboundToCustomer,
    0,
    "voice/payment log rows are never counted as customer sends"
  );
}
{
  const empty = computeCanaryCounters([], WINDOW);
  eq(empty.outboundToCustomer, 0, "no conversations => zero counters, not a throw");
  eq(decideCanaryVerdict(empty, empty).status, "unknown", "and an empty corpus can never clear a deploy");
}
// ROBUST TO A BULK IMPORT — the trap the live store sprang. Its busiest hour ever is 524 sends
// (a one-off backfill), seventeen times the next busiest. Scaling off the MAX set the runaway
// ceiling to 1,572/h, high enough that no real flood could ever trip it: one historical import
// would have silently disarmed the alarm forever.
{
  const normalHours = Array.from({ length: 40 }, (_, i) =>
    out("twilio", new Date(T("2026-06-01T00:00:00Z") + i * 3_600_000).toISOString())
  );
  const bulkImportHour = Array.from({ length: 500 }, (_, i) => ({
    ...out("twilio", "2026-05-01T03:00:00Z"),
    id: `bulk_${i}`
  }));
  const withImport = [{ id: "x", messages: [...normalHours, ...bulkImportHour] }];
  const typical = typicalPeakOutboundPerHour(withImport);
  ok(
    typical < 500,
    "a single bulk-import hour must NOT define the typical busy hour — that disarms the tripwire"
  );
  ok(
    detectRunaway(60, 3_600_000, typical).runaway,
    "and with the outlier ignored, a 60/hour flood still trips"
  );
  eq(typicalPeakOutboundPerHour([]), 0, "an empty store has no typical hour");
}

// ---------------------------------------------------------------------------
// 6. DEAD-COUNTER DETECTION — the guard against the bug that actually shipped here.
// ---------------------------------------------------------------------------
{
  eq(findDeadCounters(CONVS), [], "production-shaped data wires every guarded counter");

  // The exact historical bug: a store where drafts are marked some other way, so the draft counter
  // silently reads zero forever. That must surface as BROKEN, not as a quiet period.
  const noDrafts = [
    { id: "a", closedAt: "2026-08-01T13:00:00Z", messages: [out("twilio", "2026-08-01T12:30:00Z")] }
  ];
  eq(
    findDeadCounters(noDrafts),
    ["draftsProduced"],
    "a counter that reads zero across the ENTIRE store is unwired instrumentation, not good news"
  );
  ok(
    findDeadCounters([]).length > 0,
    "an empty store has every counter dead — it can never be read as healthy"
  );
  ok(
    !findDeadCounters(noDrafts).includes("draftsHeld"),
    "holds are legitimately rare, so a store with none is exempt from the dead-counter check"
  );
}

// ---------------------------------------------------------------------------
// 7. THE ROLLBACK PLAN — only for a real regression, never without a target.
// ---------------------------------------------------------------------------
{
  const regressed = decideCanaryVerdict(BASE, after({ outboundToCustomer: 90 }));
  const plan = buildRevertPlan(regressed, "abc1234");
  ok(plan.length > 0, "a regression produces a rollback plan");
  ok(plan.some(l => l.includes("abc1234")), "the plan names the commit to revert");
  ok(plan.some(l => l.includes("npm run deploy:api")), "and deploys via the npm script");
  ok(
    !plan.some(l => l.includes("bash scripts/deploy_api_lightsail.sh")),
    "never the raw deploy script — it repoints the live store at the wrong data dir"
  );

  eq(buildRevertPlan(decideCanaryVerdict(BASE, after()), "abc1234"), [], "a healthy verdict produces NO plan");
  eq(
    buildRevertPlan(decideCanaryVerdict(after({ outboundToCustomer: 1 }), after()), "abc1234"),
    [],
    "an UNKNOWN verdict must never trigger a rollback — abstaining is not a regression"
  );
  ok(
    buildRevertPlan(regressed, "")[0].includes("BLOCKED"),
    "with no recorded commit, the plan blocks instead of guessing what to revert"
  );
}

// Thresholds are a circuit breaker, not a quality metric — keep them visibly loose.
ok(DEFAULT_CANARY_THRESHOLDS.maxIncreaseRatio >= 1.5, "the increase limit stays loose");
ok(DEFAULT_CANARY_THRESHOLDS.minBaselineOutbound > 0, "there is always a minimum-traffic floor");
ok(DEFAULT_CANARY_THRESHOLDS.runawayMinPerHour > 0, "and an absolute runaway floor");

// =================================================================================================
// THE DEPLOY GATE — a CIRCUIT BREAKER, not a turnstile (Joe ruling 2026-08-03).
//
// Until 8/3 every state that was not a recorded HEALTHY blocked. That is unsatisfiable here: the
// 20-send floor against ~26 sends/day means the comparative check abstains (UNKNOWN) on an ordinary
// week, and UNKNOWN blocked — so the first abstention latched the gate shut with no path back open,
// while merges land every 20 minutes. A permanently-shut gate gets overridden, which is what
// happened on three consecutive deploys. Now only a MEASURED REGRESSION blocks; the watch still
// runs and still reports, and the fast runaway tripwire (above) is the protection that works at
// this cadence.
// =================================================================================================
{
  const HOUR = 3_600_000;
  const NOW = 1_754_000_000_000;
  const pending = (over: Record<string, unknown> = {}) => ({
    takenAtMs: NOW - 10 * HOUR,
    windowMs: 48 * HOUR,
    deployedSha: "abc1234def",
    ...over
  });

  // --- an open canary no longer blocks, but still reports what it is watching --------------------
  const open = decideCanaryGate({ pending: pending(), lastVerdictStatus: "healthy", nowMs: NOW });
  eq(open.mayDeployBehaviour, true, "an OPEN canary does NOT block — the watch is not a turnstile");
  eq(open.pendingReady, false, "...it is not yet ready to judge");
  ok(open.minutesRemaining > 0, "...and it still reports how long is left");
  ok(open.reason.includes("abc1234d"), "...naming the sha under watch so the report is actionable");

  // --- an elapsed-but-unjudged window is flagged ripe, and still does not block -------------------
  const ripe = decideCanaryGate({
    pending: pending({ takenAtMs: NOW - 60 * HOUR }),
    lastVerdictStatus: null,
    nowMs: NOW
  });
  eq(ripe.mayDeployBehaviour, true, "an elapsed-but-unjudged canary does not freeze the pipeline");
  eq(ripe.pendingReady, true, "...but IS flagged ready so something comes back and judges it");
  eq(ripe.minutesRemaining, 0, "...with no time left on the clock");

  // --- THE ONE BLOCKING STATE --------------------------------------------------------------------
  eq(
    decideCanaryGate({ pending: null, lastVerdictStatus: "regressed", nowMs: NOW }).mayDeployBehaviour,
    false,
    "a REGRESSED verdict is the ONE state that blocks — customers measurably got worse"
  );
  eq(
    decideCanaryGate({ pending: pending(), lastVerdictStatus: "regressed", nowMs: NOW }).mayDeployBehaviour,
    false,
    "...and REGRESSED still blocks even while a newer canary is open"
  );

  // --- abstention and inexperience are NOT regressions --------------------------------------------
  eq(
    decideCanaryGate({ pending: null, lastVerdictStatus: "unknown", nowMs: NOW }).mayDeployBehaviour,
    true,
    "UNKNOWN does not block — at 26 sends/day abstaining is the normal case, not a fault signal"
  );
  eq(
    decideCanaryGate({ pending: null, lastVerdictStatus: null, nowMs: NOW }).mayDeployBehaviour,
    true,
    "NEVER MEASURED does not block — otherwise the gate can never open for the first time"
  );
  eq(
    decideCanaryGate({ pending: null, lastVerdictStatus: "healthy", nowMs: NOW }).mayDeployBehaviour,
    true,
    "a judged HEALTHY with nothing pending is clear"
  );
}

// =================================================================================================
// THE WRONG-STORE GUARD — the bug that produced the all-zero 2026-08-02 baseline.
//
// canary_watch resolves its store from CONVERSATIONS_DB_PATH, else DATA_DIR, else a relative path.
// Miss the env var on the box and it reads the STALE BASE store (frozen 2026-06-16): non-empty,
// 3,720 LIFETIME sends so findDeadCounters sees nothing dead, but zero activity since June — so
// every recent window reads 0. A zero baseline clears any deploy, because "after" can only be >= 0.
// The tell a lifetime check cannot see: newest activity predating the window being measured.
// =================================================================================================
{
  const HOUR = 3_600_000;
  const NOW = 1_754_000_000_000;
  const WINDOW = 48 * HOUR;

  const fresh = detectStaleStore({ newestOutboundMs: NOW - 2 * HOUR, nowMs: NOW, windowMs: WINDOW });
  eq(fresh.stale, false, "a store with activity inside the window is usable");

  // A genuinely QUIET dealership — last send 40h ago — is still inside a 48h window and must pass.
  // This is the false-positive that would make the guard unusable, so it is pinned explicitly.
  const quiet = detectStaleStore({ newestOutboundMs: NOW - 40 * HOUR, nowMs: NOW, windowMs: WINDOW });
  eq(quiet.stale, false, "a QUIET store inside the window is not a stale store");

  // The real 8/2 shape: base store frozen ~47 days before the arm.
  const frozen = detectStaleStore({
    newestOutboundMs: NOW - 47 * 24 * HOUR,
    nowMs: NOW,
    windowMs: WINDOW
  });
  eq(frozen.stale, true, "a store frozen weeks ago is REFUSED — this is the 8/2 all-zero baseline");
  ok(frozen.reason.includes("frozen store"), "...and says plainly that it is the wrong store");

  // Just past the boundary — 49h against a 48h window — must be caught, not rounded away.
  eq(
    detectStaleStore({ newestOutboundMs: NOW - 49 * HOUR, nowMs: NOW, windowMs: WINDOW }).stale,
    true,
    "a store whose newest activity falls just outside the window is stale"
  );

  eq(
    detectStaleStore({ newestOutboundMs: null, nowMs: NOW, windowMs: WINDOW }).stale,
    true,
    "a store with no dated outbound at all is refused, never treated as quiet"
  );

  // The projection that feeds the guard: only real sends/drafts count, never voice/payment LOG rows,
  // or a store idle since June would look 'fresh' because a call was logged on it yesterday.
  const convs = [
    { messages: [{ direction: "out", provider: "twilio", at: new Date(NOW - 3 * HOUR).toISOString() }] },
    { messages: [{ direction: "out", provider: "voice_call", at: new Date(NOW).toISOString() }] },
    { messages: [{ direction: "in", provider: "twilio", at: new Date(NOW).toISOString() }] }
  ];
  eq(
    newestOutboundAtMs(convs),
    NOW - 3 * HOUR,
    "newestOutboundAtMs counts sends/drafts only — a logged voice call is not the agent messaging anyone"
  );
  eq(newestOutboundAtMs([]), null, "an empty store has no newest outbound");
}

// =================================================================================================
// PROGRESSIVE MEASUREMENT — many small slices under a run-length rule (Argo Rollouts shape).
//
// The one-shot canary could not work at 26 sends/day because `windowMs` was BOTH the baseline
// lookback and the wait for a verdict: widening it to clear the 20-send floor delayed the answer by
// exactly as much. The baseline is now a LONG lookback and slices are SHORT, so the floor is
// cleared once at arm time while verdicts stay timely.
// =================================================================================================
{
  const HOUR = 3_600_000;
  const BASELINE_H = 336; // 14 days
  // A realistic American Harley baseline: ~26 sends/day over 14 days.
  const baseline: CanaryCounters = {
    outboundToCustomer: 364,
    draftsProduced: 168,
    conversationsClosed: 28,
    draftsHeld: 14,
    activeConversations: 322
  };
  const slice = (over: Partial<CanaryCounters> = {}): CanaryCounters => ({
    outboundToCustomer: 9,
    draftsProduced: 4,
    conversationsClosed: 1,
    draftsHeld: 0,
    activeConversations: 8,
    ...over
  });
  const measure = (counters: CanaryCounters, runaway?: any) =>
    measureCanarySlice({
      baselineCounters: baseline,
      baselineWindowMs: BASELINE_H * HOUR,
      sliceCounters: counters,
      sliceWindowMs: 8 * HOUR,
      runaway
    });

  // --- THE HEADLINE: a 14-day baseline makes an 8h slice conclusive at this volume ---------------
  eq(
    measure(slice()).status,
    "pass",
    "a normal 8h slice against a 14-day baseline CONCLUDES — a 48h baseline could not"
  );
  const scaled = scaleCounters(baseline, (8 * HOUR) / (BASELINE_H * HOUR));
  ok(
    scaled.outboundToCustomer > 8 && scaled.outboundToCustomer < 9,
    "the long baseline scales to ~8.7 expected sends for an 8h slice"
  );

  // --- both failure modes still register ----------------------------------------------------------
  eq(measure(slice({ outboundToCustomer: 40 })).status, "fail", "a send flood in one slice FAILS that slice");
  eq(measure(slice({ draftsProduced: 0 })).status, "fail", "the agent going quiet (draft collapse) FAILS that slice");
  const fatal = measure(slice(), { runaway: true, perHour: 60, limit: 42 });
  eq(fatal.status, "fail", "a runaway slice fails");
  eq(fatal.fatal, true, "...and is FATAL — terminal on sight, exempt from the run-length rule");

  // --- a thin baseline abstains rather than false-passing ------------------------------------------
  eq(
    measureCanarySlice({
      baselineCounters: { ...baseline, outboundToCustomer: 8 },
      baselineWindowMs: BASELINE_H * HOUR,
      sliceCounters: slice(),
      sliceWindowMs: 8 * HOUR
    }).status,
    "inconclusive",
    "a baseline too thin to support a ratio yields INCONCLUSIVE, never a false pass"
  );

  // --- THE RUN-LENGTH RULE ------------------------------------------------------------------------
  const m = (status: "pass" | "fail" | "inconclusive", fatal = false): CanaryMeasurement => ({
    atMs: 0, sliceStartMs: 0, sliceEndMs: 0, counters: slice(), status, ...(fatal ? { fatal: true } : {}), reason: ""
  });
  const progress = (ms: CanaryMeasurement[]) => decideCanaryProgress({ measurements: ms });

  eq(progress([m("pass")]).status, "watching", "one clean slice is not yet a verdict");
  eq(progress([m("pass"), m("pass"), m("pass")]).status, "healthy", "3 consecutive clean slices PROMOTE early (~24h)");

  // A single bad slice must NOT revert — at this volume that would be a wolf-crier.
  eq(progress([m("fail")]).status, "watching", "ONE failed slice does not revert — that is noise here");
  eq(progress([m("fail"), m("fail")]).status, "watching", "two failed slices are still inside tolerance");
  eq(progress([m("fail"), m("fail"), m("fail")]).status, "regressed", "exceeding the failure tolerance IS a regression");
  eq(progress([m("fail", true)]).status, "regressed", "a single FATAL runaway slice is terminal on sight");

  // INCONCLUSIVE IS NEUTRAL — the property that stops quiet nights deciding anything.
  eq(
    progress([m("pass"), m("inconclusive"), m("pass"), m("pass")]).status,
    "healthy",
    "a quiet overnight slice does NOT reset a passing streak"
  );
  eq(
    progress([m("inconclusive"), m("inconclusive"), m("inconclusive")]).status,
    "watching",
    "inconclusive slices never accumulate into a failure"
  );
  eq(
    progress(Array.from({ length: 9 }, () => m("inconclusive"))).status,
    "unknown",
    "a full watch that concluded NOTHING is UNKNOWN — still not a clean bill of health"
  );
  eq(
    progress([m("fail"), ...Array.from({ length: 8 }, () => m("pass"))]).status,
    "healthy",
    "one early failure inside tolerance still promotes once the streak is clean"
  );
  eq(
    progress([m("pass"), m("pass"), m("fail"), m("pass")]).consecutivePasses,
    1,
    "a failed slice RESETS the consecutive-pass streak — the three clean ones must be CONSECUTIVE"
  );
}

console.log(`PASS canary auto-revert — abstains rather than false-greens (${checks} checks)`);
