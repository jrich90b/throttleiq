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
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

let id_counter = 0;
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
  detectJudgeStoreMismatch,
  isPoisonedMeasurement,
  CANARY_JUDGE_RULE_VERSION,
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
  activeConversations: 29,
  inboundFromCustomer: 24
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
  const v = decideCanaryVerdict(BASE, after({ draftsProduced: 1, outboundToCustomer: 2 }));
  eq(v.status, "regressed", "replies collapsing to near-zero is a regression");
  eq(v.breaches.find(b => b.metric === "draftsProduced")?.kind, "collapse", "reported as a collapse");
}
eq(
  decideCanaryVerdict(BASE, after({ draftsProduced: 0, outboundToCustomer: 0 })).status,
  "regressed",
  "replying to NOBODY is the loudest version of the same failure"
);

// THE ACCOUNTING BUG THIS CHECK SHIPPED WITH (found 2026-08-04 on a live canary).
// `finalizeDraftAsSent` rewrites an approved draft's provider to twilio/sendgrid IN PLACE, so an
// approved draft LEAVES draftsProduced and JOINS outboundToCustomer. Reading draftsProduced alone
// therefore scores "the agent went quiet" hardest exactly when staff cleared the queue fastest.
// The real slice: 9 customers wrote in, 16 replies went out, 0 drafts left pending — scored
// "drafting collapsed 2.33 -> 0". Two more of those would have reverted a proven-identical deploy.
eq(
  decideCanaryVerdict(BASE, after({ draftsProduced: 0, outboundToCustomer: 38 })).status,
  "healthy",
  "an EMPTY draft queue with every reply sent is staff being fast, NOT the agent going quiet"
);
{
  const v = decideCanaryVerdict(BASE, after({ draftsProduced: 0, outboundToCustomer: 20 }));
  eq(v.status, "healthy", "drafts at zero cannot mean silence while sends are healthy");
  eq(v.breaches.length, 0, "...and nothing is reported as a collapse");
}
eq(
  decideCanaryVerdict(BASE, after({ draftsProduced: 20, outboundToCustomer: 0 })).status,
  "healthy",
  "the mirror case: everything still drafted, nothing approved yet, is not silence either"
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
  eq(c.inboundFromCustomer, 1, "an inbound customer message is counted — it is what a reply answers");
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
    ["draftsProduced", "inboundFromCustomer"],
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

  // --- RIPENESS ON A PROGRESSIVE CANARY IS THE NEXT SLICE, NOT THE BASELINE LOOKBACK -------------
  //
  // Found live 2026-08-04: `status` reported 19,077 minutes ("13 days") left for a canary that
  // `judge` was already measuring at 2 of 9 slices. `windowMs` on a progressive canary is the 336h
  // BASELINE lookback; reading it as the deadline tells the loop "nothing to judge for two weeks"
  // while the watch sits waiting to be asked — which recreates the exact state the canary's memory
  // rework existed to fix (no deploy had ever actually been judged), and strands the first-touch
  // flip behind a date the mechanism does not need.
  const progressive = (over: Record<string, unknown> = {}) =>
    pending({ windowMs: 336 * HOUR, progress: { intervalMs: 8 * HOUR, count: 9 }, measurements: [], ...over });

  const slice1Due = decideCanaryGate({
    pending: progressive({ takenAtMs: NOW - 9 * HOUR }),
    lastVerdictStatus: null,
    nowMs: NOW
  });
  eq(slice1Due.pendingReady, true, "a progressive canary past its first 8h slice is RIPE, not 13 days out");
  eq(slice1Due.minutesRemaining, 0, "...with no time left before that slice can be taken");
  ok(slice1Due.reason.includes("slice 1"), "...and the reason names WHICH slice is due");

  const midSlice = decideCanaryGate({
    pending: progressive({ takenAtMs: NOW - 4 * HOUR }),
    lastVerdictStatus: null,
    nowMs: NOW
  });
  eq(midSlice.pendingReady, false, "inside the first slice it is not ripe yet");
  eq(midSlice.minutesRemaining, 4 * 60, "...and the countdown is to the SLICE end, not to 336h");

  const twoTaken = decideCanaryGate({
    pending: progressive({ takenAtMs: NOW - 25 * HOUR, measurements: [{}, {}] }),
    lastVerdictStatus: null,
    nowMs: NOW
  });
  eq(twoTaken.pendingReady, true, "with 2 slices taken and 25h elapsed, slice 3 has elapsed and is due");
  const twoTakenEarly = decideCanaryGate({
    pending: progressive({ takenAtMs: NOW - 17 * HOUR, measurements: [{}, {}] }),
    lastVerdictStatus: null,
    nowMs: NOW
  });
  eq(twoTakenEarly.pendingReady, false, "...but at 17h slice 3 is still running, so there is nothing to take");
  // A watch that fell BEHIND catches up rather than waiting: only 1 slice taken after 25h means
  // slice 2 elapsed long ago and judge should be called now.
  eq(
    decideCanaryGate({
      pending: progressive({ takenAtMs: NOW - 25 * HOUR, measurements: [{}] }),
      lastVerdictStatus: null,
      nowMs: NOW
    }).pendingReady,
    true,
    "a watch that fell behind reads RIPE so judge catches it up — never 'wait for the baseline'"
  );

  // A LEGACY one-shot canary (no `progress`) keeps the old window math — the rework must not
  // strand a canary armed before progressive measurement shipped.
  eq(
    decideCanaryGate({ pending: pending({ takenAtMs: NOW - 10 * HOUR }), lastVerdictStatus: null, nowMs: NOW })
      .pendingReady,
    false,
    "a legacy one-shot canary still ripens on windowMs, not on a slice schedule"
  );

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
    activeConversations: 322,
    inboundFromCustomer: 277
  };
  const slice = (over: Partial<CanaryCounters> = {}): CanaryCounters => ({
    outboundToCustomer: 9,
    draftsProduced: 4,
    conversationsClosed: 1,
    draftsHeld: 0,
    activeConversations: 8,
    inboundFromCustomer: 7,
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
  eq(
    measure(slice({ draftsProduced: 0, outboundToCustomer: 1 })).status,
    "fail",
    "the agent going quiet — nobody replied to a busy window — FAILS that slice"
  );
  eq(
    measure(slice({ draftsProduced: 0 })).status,
    "pass",
    "but a cleared draft queue with every reply SENT is not silence — this exact shape false-failed a live canary on 2026-08-03"
  );

  // --- a DEAD window testifies to nothing: not a collapse, and not a clean bill of health ----------
  const deadWindow = slice({
    inboundFromCustomer: 0,
    outboundToCustomer: 0,
    draftsProduced: 0,
    conversationsClosed: 0,
    activeConversations: 0
  });
  eq(
    measure(deadWindow).status,
    "inconclusive",
    "an 8h window with no customers in it cannot show the agent going quiet — there was nothing to answer"
  );
  ok(
    measure(deadWindow).verdict.status !== "healthy",
    "...and silence must never be laundered into a PASS that advances the promote streak"
  );
  eq(
    measure(deadWindow, { runaway: true, perHour: 60, limit: 42 }).status,
    "fail",
    "a runaway still fails on a quiet window — a flood needs no baseline traffic to be alarming"
  );
  eq(
    measure({ ...deadWindow, conversationsClosed: 6 }).status,
    "fail",
    "and a RISING counter still fails on a quiet window — only the went-quiet reading needs traffic"
  );
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
    atMs: 0, sliceStartMs: 0, sliceEndMs: 0, counters: slice(), status,
    ...(fatal ? { fatal: true } : {}), reason: "", ruleVersion: CANARY_JUDGE_RULE_VERSION
  });
  // A verdict recorded before the current judging rule existed. Missing `ruleVersion` IS v1 — every
  // measurement written before the stamp existed reads this way, which is the whole point.
  const stale = (status: "pass" | "fail" | "inconclusive", fatal = false): CanaryMeasurement => ({
    atMs: 0, sliceStartMs: 0, sliceEndMs: 0, counters: slice(), status,
    ...(fatal ? { fatal: true } : {}), reason: "recorded under the old rule"
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

  // --- A VERDICT FROM A SUPERSEDED RULE IS NOT EVIDENCE ---------------------------------------
  // The live case this was written for: a busy slice (16 sends) was judged "the agent went quiet"
  // hours before PR #504 taught the counter that an approved draft which gets SENT is still a
  // draft. That phantom held one of two tolerated failures and had reset the streak.
  eq(
    progress([stale("fail"), stale("fail"), stale("fail")]).status,
    "watching",
    "stale failures never accumulate into a regression — the rule that produced them is gone"
  );
  eq(
    progress([m("pass"), m("pass"), stale("fail"), m("pass")]).consecutivePasses,
    3,
    "a stale failure does NOT reset the streak — it is neutral, exactly like a quiet window"
  );
  // SYMMETRY is the half that protects the funnel lever: a stale PASS must not promote either, or
  // a behaviour deploy unlocks on a measurement nothing stands behind.
  eq(
    progress([stale("pass"), stale("pass"), stale("pass")]).status,
    "watching",
    "stale passes do NOT promote to healthy — the neutrality cuts both ways"
  );
  eq(
    progress(Array.from({ length: 9 }, () => stale("pass"))).status,
    "unknown",
    "a full watch of nothing but stale verdicts concluded NOTHING — UNKNOWN, never a clean bill"
  );
  // ...but a runaway is a raw send-rate count that no counting-rule change can invalidate.
  eq(
    progress([stale("fail", true)]).status,
    "regressed",
    "a FATAL runaway stays terminal on sight however old the rule that recorded it"
  );
  // And a measurement stamped with the CURRENT rule is scored normally — the downgrade must key on
  // the version, not simply excuse every failure.
  eq(
    progress([m("fail"), m("fail"), m("fail")]).status,
    "regressed",
    "current-rule failures still regress — the stale downgrade is not a blanket amnesty"
  );
}

// ---------------------------------------------------------------------------
// SENDS ARE JUDGED PER INBOUND MESSAGE (2026-08-04).
//
// THE INCIDENT, measured off the box: the canary on `0ff64eaf` scored a slice
// `outboundToCustomer 7.88 -> 59 (x7.49, limit x2)` and FAILED it. That window was 11:00-18:00 UTC
// on a Tuesday — a business morning — and it carried 38 INBOUND messages across 18 conversations.
// 59 sends against 38 inbound is 1.55 per customer message, against a baseline of ~1.34. The
// customers were talking and we answered them; nothing ran away.
//
// WHY IT MATTERED MORE THAN ONE BAD SLICE: promotion needs 3 CONSECUTIVE clean slices, so a check
// that fails every busy weekday morning means the canary can never promote at all — which is
// exactly what happened between 8/3 and 8/4, leaving real deploys unwatched because the previous
// watch would not close out.
// ---------------------------------------------------------------------------
{
  // Re-derived from the live 48h baseline the fresh canary armed with: in=80 sends=107 over 48h,
  // i.e. per 8h slice ~13.3 inbound and ~17.8 sends. Scaled to this fixture's shape.
  // Sends kept at BASE's 26 so the baseline clears `minBaselineOutbound` (20) — below it the
  // verdict is UNKNOWN and every case here would be vacuous.
  const busyBase: CanaryCounters = { ...BASE, outboundToCustomer: 26, inboundFromCustomer: 19 };

  // THE REGRESSION THIS FIXES: the real busy morning, at the real numbers.
  const busyMorning = { ...busyBase, outboundToCustomer: 59, inboundFromCustomer: 38 };
  eq(
    decideCanaryVerdict(busyBase, busyMorning).status,
    "healthy",
    "a busy morning where INBOUND rose with sends is healthy — this is the 8/4 false failure"
  );

  // ...and the raw count really would have failed, so the case is not vacuous.
  ok(
    59 / 26 > DEFAULT_CANARY_THRESHOLDS.maxIncreaseRatio,
    "the same slice DOES breach on raw counts — the fixture must keep proving what changed"
  );

  // STILL CAUGHT — talking AT people. Same sends, inbound flat: the rate doubles.
  {
    const v = decideCanaryVerdict(busyBase, { ...busyBase, outboundToCustomer: 59 });
    eq(v.status, "regressed", "more sends with NO more inbound is still a regression");
    ok(
      /per inbound/.test(v.breaches[0]?.detail ?? ""),
      "and the breach explains itself in per-inbound terms"
    );
  }

  // STILL CAUGHT — double-texting every lead: inbound doubles, sends quadruple.
  eq(
    decideCanaryVerdict(busyBase, { ...busyBase, outboundToCustomer: 76, inboundFromCustomer: 26 })
      .status,
    "regressed",
    "twice the replies per customer message is the failure worth reverting for"
  );

  // Just inside the bound stays healthy — the limit is unchanged, only what it measures.
  eq(
    decideCanaryVerdict(busyBase, { ...busyBase, outboundToCustomer: 51, inboundFromCustomer: 26 })
      .status,
    "healthy",
    "under 2x the per-inbound rate is healthy"
  );

  // SENDING INTO SILENCE — no inbound at all means no rate, so it falls back to the RAW comparison,
  // which is the strict one. This must never become a way to escape the guard.
  eq(
    decideCanaryVerdict(busyBase, { ...busyBase, outboundToCustomer: 59, inboundFromCustomer: 0 })
      .status,
    "regressed",
    "sends with ZERO inbound must still regress — the fallback is the strict path"
  );

  // A baseline with no inbound recorded (the pre-8/3 schema) also falls back to raw counts.
  eq(
    decideCanaryVerdict(
      { ...busyBase, inboundFromCustomer: 0 },
      { ...busyBase, outboundToCustomer: 59, inboundFromCustomer: 38 }
    ).status,
    "regressed",
    "an old baseline with no inbound counter keeps the raw comparison, never a free pass"
  );

  // The fast tripwire is untouched: a flood is a regression whatever the inbound volume.
  {
    const r = detectRunaway(60, 3_600_000, 4);
    const v = decideCanaryVerdict(
      busyBase,
      { ...busyBase, outboundToCustomer: 60, inboundFromCustomer: 45 },
      DEFAULT_CANARY_THRESHOLDS,
      r
    );
    eq(v.status, "regressed", "a runaway still regresses even when inbound is high");
    eq(v.breaches[0].kind, "runaway", "and the runaway is still reported first");
  }

  // The OTHER guarded counters are untouched by this — only sends are inbound-normalised.
  eq(
    decideCanaryVerdict(busyBase, { ...busyBase, conversationsClosed: 12, inboundFromCustomer: 60 })
      .status,
    "regressed",
    "wrongful closes are NOT excused by a busy day — normalisation applies to sends only"
  );
}

// -------------------------------------------------------------------------------------------------
// THE JUDGE-SIDE WRONG-STORE GUARD (2026-08-05).
//
// Arming has been guarded since 2026-08-03; JUDGING had no guard, and judging is where the store
// path was actually being lost — the documented `judge` invocation omitted CONVERSATIONS_DB_PATH,
// so it read the repo checkout's May seed store and every slice measured zero. Slices are
// idempotent by index, so each one was burned permanently and the canary could never promote.
// -------------------------------------------------------------------------------------------------
{
  const ARMED_AT = Date.parse("2026-08-04T23:33:00Z");
  const DEALER_NEWEST = Date.parse("2026-08-05T16:09:00Z");
  const SEED_STORE_NEWEST = Date.parse("2026-05-23T01:11:00Z");

  eq(
    detectJudgeStoreMismatch({
      currentStoreNewestOutboundMs: SEED_STORE_NEWEST,
      currentStoreConversations: 12,
      baselineStoreNewestOutboundMs: DEALER_NEWEST,
      baselineStoreConversations: 810,
      baselineTakenAtMs: ARMED_AT
    }).wrong,
    true,
    "the repo seed store is caught: a store cannot travel backwards from the one we armed against"
  );

  eq(
    detectJudgeStoreMismatch({
      currentStoreNewestOutboundMs: DEALER_NEWEST,
      currentStoreConversations: 814,
      baselineStoreNewestOutboundMs: DEALER_NEWEST - 3_600_000,
      baselineStoreConversations: 810,
      baselineTakenAtMs: ARMED_AT
    }).wrong,
    false,
    "the real store, read later with a few more conversations, judges normally"
  );

  eq(
    detectJudgeStoreMismatch({
      currentStoreNewestOutboundMs: SEED_STORE_NEWEST,
      currentStoreConversations: 12,
      baselineTakenAtMs: ARMED_AT
    }).wrong,
    true,
    "a LEGACY baseline with no store provenance still catches a store older than the arming moment"
  );

  // ISOLATE the backwards-in-time test: same conversation count, so the size rule below cannot be
  // the thing catching it. Without this the size rule alone kept the eval green while the
  // travelled-backwards branch was deleted.
  eq(
    detectJudgeStoreMismatch({
      currentStoreNewestOutboundMs: DEALER_NEWEST - 72 * 3_600_000,
      currentStoreConversations: 810,
      baselineStoreNewestOutboundMs: DEALER_NEWEST,
      baselineStoreConversations: 810,
      baselineTakenAtMs: ARMED_AT
    }).wrong,
    true,
    "a store the same SIZE but three days behind is still a different file — the time test stands alone"
  );

  eq(
    detectJudgeStoreMismatch({
      currentStoreNewestOutboundMs: DEALER_NEWEST,
      currentStoreConversations: 401,
      baselineStoreNewestOutboundMs: DEALER_NEWEST,
      baselineStoreConversations: 810,
      baselineTakenAtMs: ARMED_AT
    }).wrong,
    true,
    "a store that lost half its conversations is a different file — conversations do not disappear"
  );

  eq(
    detectJudgeStoreMismatch({
      currentStoreNewestOutboundMs: null,
      currentStoreConversations: 810,
      baselineStoreNewestOutboundMs: DEALER_NEWEST,
      baselineStoreConversations: 810,
      baselineTakenAtMs: ARMED_AT
    }).wrong,
    true,
    "a store with no dated outbound at all can never judge a deploy"
  );

  // HEALING a burned slice — and the one row that must NEVER be overwritten.
  const zeroCounters: CanaryCounters = {
    outboundToCustomer: 0,
    inboundFromCustomer: 0,
    draftsProduced: 0,
    conversationsClosed: 0,
    draftsHeld: 0,
    activeConversations: 0
  };
  const busyTruth: CanaryCounters = { ...zeroCounters, inboundFromCustomer: 23, outboundToCustomer: 36, activeConversations: 15 };

  eq(
    isPoisonedMeasurement({ status: "inconclusive", counters: zeroCounters, truthCounters: busyTruth }),
    true,
    "an inconclusive all-zero slice over a window the real store shows was busy is a mis-measurement"
  );
  eq(
    isPoisonedMeasurement({ status: "fail", counters: zeroCounters, truthCounters: busyTruth }),
    false,
    "a COLLAPSE fail is all-zero too and is real evidence — healing must never overwrite it"
  );
  eq(
    isPoisonedMeasurement({ status: "inconclusive", counters: zeroCounters, truthCounters: zeroCounters }),
    false,
    "a genuinely quiet night stays inconclusive — nothing to heal"
  );
  eq(
    isPoisonedMeasurement({
      status: "inconclusive",
      counters: { ...zeroCounters, inboundFromCustomer: 2 },
      truthCounters: busyTruth
    }),
    false,
    "a slice that measured SOMETHING was reading the right store — only all-zero rows are healed"
  );
}

// -------------------------------------------------------------------------------------------------
// AND THE SCRIPT ITSELF STILL RUNS. `tsc` does not cover scripts/, and a pure-function assertion
// cannot prove canary_watch.ts still wires these in — a guard can be written and never called. This
// EXECUTES `canary_watch.ts judge` end to end against a synthetic store and a synthetic pending
// canary, once from the wrong store and once from the right one.
// -------------------------------------------------------------------------------------------------
{
  const armedAtMs = Date.parse("2026-08-04T00:00:00Z");
  const sliceMs = 8 * 3_600_000;
  const judgeAtIso = "2026-08-04T16:00:00Z"; // two slices elapsed
  const iso = (t: number) => new Date(t).toISOString();

  const conv = (id: string, msgs: any[]) => ({ id, phone: id, messages: msgs });
  const msg = (dir: "in" | "out", provider: string, atMs: number, i: number) => ({
    id: `m_${id_counter++}`,
    direction: dir,
    from: dir === "in" ? "+15550001111" : "+15550002222",
    to: dir === "in" ? "+15550002222" : "+15550001111",
    body: `synthetic ${i}`,
    at: iso(atMs),
    provider
  });

  // A store busy across the baseline lookback AND across both elapsed slices.
  const conversations: any[] = [];
  for (let c = 0; c < 30; c++) {
    const msgs: any[] = [];
    for (let k = 0; k < 8; k++) {
      msgs.push(msg("in", "twilio", armedAtMs - (k + 1) * 3_600_000, k));
      msgs.push(msg("out", "twilio", armedAtMs - (k + 1) * 3_600_000 + 60_000, k));
    }
    // inside slice 0 and slice 1
    msgs.push(msg("in", "twilio", armedAtMs + 2 * 3_600_000, 100));
    msgs.push(msg("out", "twilio", armedAtMs + 2 * 3_600_000 + 60_000, 101));
    msgs.push(msg("in", "twilio", armedAtMs + sliceMs + 2 * 3_600_000, 102));
    msgs.push(msg("out", "twilio", armedAtMs + sliceMs + 2 * 3_600_000 + 60_000, 103));
    conversations.push(conv(`+1555000${String(1000 + c)}`, msgs));
  }
  const goodStore = { conversations };

  // The wrong store: same SHAPE, non-empty, plenty of lifetime traffic — and frozen months ago.
  const stale: any[] = [];
  for (let c = 0; c < 8; c++) {
    const msgs: any[] = [];
    for (let k = 0; k < 20; k++) {
      msgs.push(msg("in", "twilio", Date.parse("2026-05-23T01:11:00Z") - k * 3_600_000, k));
      msgs.push(msg("out", "twilio", Date.parse("2026-05-23T01:11:00Z") - k * 3_600_000 + 60_000, k));
    }
    stale.push(conv(`+1555999${String(1000 + c)}`, msgs));
  }
  const staleStore = { conversations: stale };

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "canary-judge-eval-"));
  try {
    const goodPath = path.join(tmp, "good.json");
    const stalePath = path.join(tmp, "stale.json");
    fs.writeFileSync(goodPath, JSON.stringify(goodStore));
    fs.writeFileSync(stalePath, JSON.stringify(staleStore));

    const baselineCounters = computeCanaryCounters(conversations, {
      startMs: armedAtMs - 48 * 3_600_000,
      endMs: armedAtMs
    });
    const pending = {
      takenAtMs: armedAtMs,
      windowMs: 48 * 3_600_000,
      deployedSha: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
      counters: baselineCounters,
      typicalPeakOutboundPerHour: 30,
      storePath: goodPath,
      storeConversations: conversations.length,
      storeNewestOutboundMs: newestOutboundAtMs(conversations),
      progress: { intervalMs: sliceMs, count: 9, failureLimit: 2, consecutiveSuccessLimit: 3 },
      // Slice 0 already recorded — burned against the wrong store, exactly like the live canary.
      measurements: [
        {
          atMs: armedAtMs + sliceMs,
          sliceStartMs: armedAtMs,
          sliceEndMs: armedAtMs + sliceMs,
          counters: {
            outboundToCustomer: 0,
            inboundFromCustomer: 0,
            draftsProduced: 0,
            conversationsClosed: 0,
            draftsHeld: 0,
            activeConversations: 0
          },
          status: "inconclusive",
          reason: "slice too quiet to judge: 0 customer event(s) in the window"
        }
      ]
    };

    const runJudge = (storePath: string, reportRoot: string) => {
      fs.mkdirSync(path.join(reportRoot, "canary"), { recursive: true });
      fs.writeFileSync(path.join(reportRoot, "canary", "pending.json"), JSON.stringify(pending, null, 2));
      const r = spawnSync(
        "npx",
        ["tsx", "scripts/canary_watch.ts", "judge", "--now", judgeAtIso],
        {
          encoding: "utf8",
          env: { ...process.env, REPORT_ROOT: reportRoot, CONVERSATIONS_DB_PATH: storePath },
          cwd: path.resolve(new URL("..", import.meta.url).pathname)
        }
      );
      const after = JSON.parse(fs.readFileSync(path.join(reportRoot, "canary", "pending.json"), "utf8"));
      return { status: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}`, after };
    };

    // 1. THE WRONG STORE: refuses, and records NOTHING — the burned slice is not compounded.
    const wrong = runJudge(stalePath, path.join(tmp, "reports-wrong"));
    ok(wrong.status !== 0, "judging against the wrong store must not exit 0");
    ok(
      /refusing to JUDGE/.test(wrong.out),
      `the wrong store is refused by name, not silently measured — got: ${wrong.out.slice(0, 400)}`
    );
    eq(wrong.after.measurements.length, 1, "and no new slice was recorded from the wrong store");
    eq(
      wrong.after.measurements[0].counters.inboundFromCustomer,
      0,
      "the pre-existing burned slice is left exactly as it was"
    );

    // 2. THE RIGHT STORE: measures the elapsed slice AND heals the burned one.
    const right = runJudge(goodPath, path.join(tmp, "reports-right"));
    eq(right.after.measurements.length, 2, "both elapsed slices are recorded against the real store");
    ok(
      right.after.measurements[0].counters.inboundFromCustomer > 0,
      "the burned slice 0 was re-measured in place once a valid store was supplied"
    );
    ok(
      right.after.measurements[1].counters.inboundFromCustomer > 0,
      "and the newly elapsed slice 1 measured real traffic"
    );
    eq(
      right.after.measurements[0].sliceStartMs,
      armedAtMs,
      "healing re-measures IN PLACE — slice 0 still covers slice 0's window"
    );
    ok(
      /re-measured 1 slice/.test(right.out),
      `the heal is reported, not silent — got: ${right.out.slice(0, 400)}`
    );

    // 3. THE LEGACY one-shot path (a canary armed before progressive slices) is guarded too. It
    // takes a different branch entirely — `judgeBaseline`, not `advanceCanary` — so guarding only
    // the progressive path leaves a live canary judged against whatever store happens to be there.
    {
      const legacyRoot = path.join(tmp, "reports-legacy");
      fs.mkdirSync(path.join(legacyRoot, "canary"), { recursive: true });
      const { measurements: _dropped, progress: _alsoDropped, ...legacyPending } = pending as any;
      fs.writeFileSync(
        path.join(legacyRoot, "canary", "pending.json"),
        JSON.stringify({ ...legacyPending, windowMs: 8 * 3_600_000 }, null, 2)
      );
      const r = spawnSync("npx", ["tsx", "scripts/canary_watch.ts", "judge", "--now", judgeAtIso], {
        encoding: "utf8",
        env: { ...process.env, REPORT_ROOT: legacyRoot, CONVERSATIONS_DB_PATH: stalePath },
        cwd: path.resolve(new URL("..", import.meta.url).pathname)
      });
      const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
      ok(r.status !== 0, "the legacy one-shot judge must not exit 0 against the wrong store");
      ok(
        /refusing to JUDGE/.test(out),
        `the legacy path refuses the wrong store by name too — got: ${out.slice(0, 400)}`
      );
      ok(
        !/canary: HEALTHY/.test(out),
        "and it certainly never reports HEALTHY off a store frozen in May"
      );
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

console.log(`PASS canary auto-revert — abstains rather than false-greens (${checks} checks)`);
