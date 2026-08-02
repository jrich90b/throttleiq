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
  findDeadCounters,
  typicalPeakOutboundPerHour,
  buildRevertPlan,
  DEFAULT_CANARY_THRESHOLDS,
  type CanaryCounters
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

console.log(`PASS canary auto-revert — abstains rather than false-greens (${checks} checks)`);
