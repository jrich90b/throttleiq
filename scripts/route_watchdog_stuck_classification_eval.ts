/**
 * Route-watchdog stuck-turn classification eval (pure, no LLM).
 *
 * Pins the de-noising of the "routing-stuck-turns" signal (2026-06-20 prod
 * investigation: the watchdog flagged 44 stuck turns, 0 of them genuine misses
 * — all closed / handed-off / paused / rep-owned / months-old). The watchdog
 * now classifies every matched turn and surfaces only the ACTIONABLE subset as
 * its headline `count`, keeping the benign rows in a `suppressed` block.
 *
 * Layers:
 *   1. Source guard — the watchdog imports the pure classifier and assembles the
 *      segmented output shape (actionable `count`/`rows` + `suppressed` +
 *      `matchedTotal` + `maxAgeSec`).
 *   2. Decision table — each suppression reason + the actionable case, in the
 *      documented priority order (terminal state wins).
 *   3. Invariant — the default recency ceiling is a sane, positive horizon.
 *
 * Run: npx tsx scripts/route_watchdog_stuck_classification_eval.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  classifyStuckTurn,
  judgedNoResponseOnInbound,
  DELIBERATE_SILENCE_ROUTE_OUTCOMES,
  STUCK_MAX_AGE_SEC_DEFAULT,
  type StuckConvLike,
  type StuckSuppressionReason
} from "../services/api/src/domain/routeWatchdogClassification.ts";

// --- 1) Source guard (no logic): the watchdog must consume the classifier and
//        emit the segmented shape so agent_manager reads an accurate count. ---
const watchdog = fs.readFileSync("scripts/route_audit_watchdog.ts", "utf8");
assert.ok(
  /classifyStuckTurn/.test(watchdog) && /routeWatchdogClassification/.test(watchdog),
  "the watchdog must import + use classifyStuckTurn from the pure module"
);
assert.ok(
  /actionable/.test(watchdog) && /suppressed:/.test(watchdog) && /matchedTotal/.test(watchdog),
  "the watchdog summary must segment actionable vs suppressed and report matchedTotal"
);
assert.ok(
  /reasonCounts/.test(watchdog),
  "the suppressed block must carry per-reason counts for triage"
);
assert.ok(
  /--stuck-max-age-sec/.test(watchdog) && /ROUTE_WATCHDOG_STUCK_MAX_AGE_SEC/.test(watchdog),
  "the recency ceiling must be tunable via flag + env"
);
// The call-only suppression is only safe because the watchdog proves a human is on
// the hook. Pin the wiring: it must read OPEN call todos off the store and hand the
// flag to the classifier, or the fail-direction guard silently becomes a blanket
// "call-only leads are never stuck".
assert.ok(
  /collectOpenCallTaskConvIds/.test(watchdog) && /hasOpenCallTask/.test(watchdog),
  "the watchdog must derive open call tasks and pass hasOpenCallTask to the classifier"
);
assert.ok(
  /todos/.test(watchdog) && /"open"/.test(watchdog) && /"call"/.test(watchdog),
  "open call tasks must be read from the store's todos (status open, reason call)"
);
// The reaction matcher must stay in the SHARED exclusions module — the classifier is
// text-free by contract, so the watchdog reads the text and passes a boolean.
assert.ok(
  /isBareReactionOnlyInbound/.test(watchdog) && /scoringExclusions/.test(watchdog),
  "the watchdog must source the reaction matcher from the shared scoringExclusions module"
);
assert.ok(
  /lastInboundIsReactionOnly/.test(watchdog),
  "the watchdog must pass lastInboundIsReactionOnly to the classifier"
);
// The judged-silence suppression is only honest if the watchdog actually looks the
// verdict up per turn and over the STUCK ceiling. Reading only the report window
// would find no verdict for exactly the old rows that need one.
assert.ok(
  /judgedNoResponseOnInbound/.test(watchdog) && /lastInboundJudgedNoResponse/.test(watchdog),
  "the watchdog must bind a recorded no-response verdict and pass it to the classifier"
);
assert.ok(
  /stuckMaxAgeSec\s*\*\s*1000/.test(watchdog),
  "the outcome lookup window must be widened to the stuck ceiling, not the report window"
);
const classifier = fs.readFileSync(
  "services/api/src/domain/routeWatchdogClassification.ts",
  "utf8"
);
assert.ok(
  !/^\s*import[\s\S]*?from\s+["'][^"']*scoringExclusions/m.test(classifier),
  "the classifier must stay text-free — it may not import the text matchers itself"
);

// --- 2) Decision table (pure). Priority: terminal state wins. ---
const RECENT = 60 * 60; // 1h — inside the default ceiling
const OLD = STUCK_MAX_AGE_SEC_DEFAULT + 60 * 60; // past the ceiling

type Row = {
  id: string;
  conv: StuckConvLike;
  ageSec: number;
  actionable: boolean;
  reason: StuckSuppressionReason | null;
  maxAgeSec?: number;
  hasOpenCallTask?: boolean;
  lastInboundIsReactionOnly?: boolean;
  lastInboundJudgedNoResponse?: boolean;
};

const rows: Row[] = [
  // The one that matters: recent, open, suggest-mode, no suppression → actionable.
  { id: "actionable_recent_open", conv: { status: null, mode: "suggest", followUp: { mode: "active" } }, ageSec: RECENT, actionable: true, reason: null },
  // Terminal: a closed conversation can never be a live stall (wins even if recent).
  { id: "closed_recent", conv: { status: "closed", mode: "suggest", followUp: { mode: "active" } }, ageSec: RECENT, actionable: false, reason: "closed" },
  // closed wins over a handoff mode too (priority order).
  { id: "closed_beats_handoff", conv: { status: "closed", mode: "suggest", followUp: { mode: "manual_handoff" } }, ageSec: RECENT, actionable: false, reason: "closed" },
  // Staff took over.
  { id: "manual_handoff", conv: { status: null, mode: "suggest", followUp: { mode: "manual_handoff" } }, ageSec: RECENT, actionable: false, reason: "manual_handoff" },
  // Customer dispositioned out.
  { id: "paused_indefinite", conv: { status: "open", mode: "suggest", followUp: { mode: "paused_indefinite" } }, ageSec: RECENT, actionable: false, reason: "paused_indefinite" },
  // Inventory watch.
  { id: "holding_inventory", conv: { status: null, mode: "suggest", followUp: { mode: "holding_inventory" } }, ageSec: RECENT, actionable: false, reason: "holding_inventory" },
  // Rep owns the thread directly.
  { id: "human_mode", conv: { status: null, mode: "human", followUp: { mode: "active" } }, ageSec: RECENT, actionable: false, reason: "human_mode" },
  // Stale lead past the recency ceiling — owned by cadence/closeout, not a P0.
  { id: "aged_out", conv: { status: null, mode: "suggest", followUp: { mode: "active" } }, ageSec: OLD, actionable: false, reason: "aged_out" },
  // followUp mode wins over the age ceiling (handoff is reported even when old).
  { id: "handoff_beats_aged_out", conv: { status: null, mode: "suggest", followUp: { mode: "manual_handoff" } }, ageSec: OLD, actionable: false, reason: "manual_handoff" },
  // Call-only lead WITH an open call task — correct silence (Joe ruling 2026-07-09);
  // the human is on the hook to dial (Kevin Burgess +17165414830, 2026-07-21).
  { id: "call_only_with_open_call_task", conv: { status: null, mode: "suggest", followUp: null, contactPreference: "call_only" }, ageSec: RECENT, actionable: false, reason: "call_only", hasOpenCallTask: true },
  // FAIL DIRECTION: call-only with NO open call task is silence with nobody told to
  // dial — exactly what the ruling guards against. Stays actionable.
  { id: "call_only_without_call_task", conv: { status: null, mode: "suggest", followUp: null, contactPreference: "call_only" }, ageSec: RECENT, actionable: true, reason: null, hasOpenCallTask: false },
  // A terminal state still wins over the call-only suppression (priority order).
  { id: "closed_beats_call_only", conv: { status: "closed", mode: "suggest", followUp: null, contactPreference: "call_only" }, ageSec: RECENT, actionable: false, reason: "closed", hasOpenCallTask: true },
  // The suppression is scoped to call-only: a texting lead with a call task stays actionable.
  { id: "call_task_without_call_only", conv: { status: null, mode: "suggest", followUp: { mode: "active" } }, ageSec: RECENT, actionable: true, reason: null, hasOpenCallTask: true },
  // Pure reaction turn (👍👍 on a sweepstakes blast, +17164233848) — the customer
  // pressed a button, not a word; silence is correct (Joe ruling 2026-07-22).
  { id: "reaction_only", conv: { status: null, mode: "suggest", followUp: { mode: "active" } }, ageSec: RECENT, actionable: false, reason: "reaction_only", lastInboundIsReactionOnly: true },
  // FAIL DIRECTION: the caller decides. A turn the shared exclusion did NOT call a
  // bare reaction stays actionable — the classifier never reads text itself.
  { id: "reaction_flag_false_stays_actionable", conv: { status: null, mode: "suggest", followUp: { mode: "active" } }, ageSec: RECENT, actionable: true, reason: null, lastInboundIsReactionOnly: false },
  // A terminal state still outranks the reaction suppression (priority order).
  { id: "manual_handoff_beats_reaction_only", conv: { status: null, mode: "suggest", followUp: { mode: "manual_handoff" } }, ageSec: RECENT, actionable: false, reason: "manual_handoff", lastInboundIsReactionOnly: true },
  // The no-response judge already ruled silence on this exact inbound (Mark Walsh
  // +17736151296, 2026-08-01: a bare "No, thanks" to a cadence touch, live outcome
  // `customer_ack_no_response` five seconds later). Correct silence, not a stall.
  { id: "judged_no_response", conv: { status: null, mode: "suggest", followUp: { mode: "active" } }, ageSec: RECENT, actionable: false, reason: "judged_no_response", lastInboundJudgedNoResponse: true },
  // FAIL DIRECTION, the whole point: absence of a verdict is NOT a verdict. Silence
  // with nothing recorded is the genuine stall this watchdog exists to catch.
  { id: "no_verdict_stays_actionable", conv: { status: null, mode: "suggest", followUp: { mode: "active" } }, ageSec: RECENT, actionable: true, reason: null, lastInboundJudgedNoResponse: false },
  // An undefined flag must behave exactly like "no verdict" — never like a verdict.
  { id: "absent_verdict_stays_actionable", conv: { status: null, mode: "suggest", followUp: { mode: "active" } }, ageSec: RECENT, actionable: true, reason: null },
  // A terminal state still outranks the judged suppression (priority order).
  { id: "closed_beats_judged_no_response", conv: { status: "closed", mode: "suggest", followUp: { mode: "active" } }, ageSec: RECENT, actionable: false, reason: "closed", lastInboundJudgedNoResponse: true },
  // A judged turn past the ceiling reports the INFORMATIVE reason, not "aged_out" —
  // "we decided this" beats "it got old" for triage.
  { id: "judged_beats_aged_out", conv: { status: null, mode: "suggest", followUp: { mode: "active" } }, ageSec: OLD, actionable: false, reason: "judged_no_response", lastInboundJudgedNoResponse: true },
  // Missing followUp / mode are tolerated → recent unsuppressed stays actionable.
  { id: "actionable_sparse_conv", conv: { status: null, mode: "suggest", followUp: null }, ageSec: RECENT, actionable: true, reason: null },
  // A custom (smaller) ceiling still suppresses a turn beyond it.
  { id: "custom_ceiling_aged_out", conv: { status: null, mode: "suggest", followUp: { mode: "active" } }, ageSec: 2 * 60 * 60, actionable: false, reason: "aged_out", maxAgeSec: 60 * 60 }
];

for (const r of rows) {
  const got = classifyStuckTurn(r.conv, {
    ageSec: r.ageSec,
    maxAgeSec: r.maxAgeSec,
    hasOpenCallTask: r.hasOpenCallTask,
    lastInboundIsReactionOnly: r.lastInboundIsReactionOnly,
    lastInboundJudgedNoResponse: r.lastInboundJudgedNoResponse
  });
  assert.equal(got.actionable, r.actionable, `classify[${r.id}] actionable expected ${r.actionable}, got ${got.actionable}`);
  assert.equal(
    got.suppressionReason,
    r.reason,
    `classify[${r.id}] reason expected ${r.reason}, got ${got.suppressionReason}`
  );
}

// --- 2b) The BINDER table. The classifier trusts a boolean; this is where that
//         boolean is earned. Every row here is a way a verdict could silence a turn
//         it has no business silencing. ---
const INBOUND_MS = Date.parse("2026-08-01T17:00:13.333Z");
const CONV = "+17736151296";
const verdictRow = (over: Record<string, any> = {}) => ({
  ts: "2026-08-01T17:00:18.022Z",
  scope: "live",
  outcome: "customer_ack_no_response",
  detail: { convId: CONV, leadKey: CONV },
  ...over
});

type BinderCase = { id: string; rows: any[]; expected: boolean; convId?: string };
const binderCases: BinderCase[] = [
  // The real one: live verdict, this thread, recorded 5s after the inbound.
  { id: "live_verdict_after_inbound", rows: [verdictRow()], expected: true },
  // The other member of the allowlist.
  { id: "short_ack_no_reply", rows: [verdictRow({ outcome: "short_ack_no_reply" })], expected: true },

  // INVERTED MEANING. `routing_parser_no_response_overridden` contains the substring
  // "no_response" and means we OVERRODE the silence and replied. A substring match
  // would read this as a decision to stay quiet — the exact reason the allowlist is
  // a set and not a regex.
  { id: "overridden_verdict_is_not_silence", rows: [verdictRow({ outcome: "routing_parser_no_response_overridden" })], expected: false },
  { id: "unrelated_outcome", rows: [verdictRow({ outcome: "orchestrator_draft" })], expected: false },

  // STALE. A verdict recorded BEFORE this inbound judged an earlier turn. Honouring
  // it would let one old "no reply needed" silence every future message on the lead.
  { id: "verdict_predates_inbound", rows: [verdictRow({ ts: "2026-08-01T16:59:00.000Z" })], expected: false },
  // Exactly at the inbound instant still counts — the serving path stamps the inbound
  // first and the outcome in the same turn.
  { id: "verdict_at_inbound_instant", rows: [verdictRow({ ts: "2026-08-01T17:00:13.333Z" })], expected: true },

  // WRONG THREAD. A verdict on someone else's conversation must never travel.
  { id: "verdict_on_another_lead", rows: [verdictRow({ detail: { convId: "+15550001111", leadKey: "+15550001111" } })], expected: false },

  // WRONG SCOPE. `regen` is a replay and `manual` is a staff action; neither is the
  // serving path deciding about this customer's message.
  { id: "regen_scope_is_not_a_decision", rows: [verdictRow({ scope: "regen" })], expected: false },
  { id: "manual_scope_is_not_a_decision", rows: [verdictRow({ scope: "manual" })], expected: false },

  // Degenerate input must fail toward ACTIONABLE, never toward silence.
  { id: "no_rows", rows: [], expected: false },
  { id: "malformed_row", rows: [{}], expected: false },
  { id: "unparseable_ts", rows: [verdictRow({ ts: "not-a-date" })], expected: false },
  // One good verdict among noise still binds.
  { id: "finds_verdict_among_noise", rows: [verdictRow({ outcome: "orchestrator_send" }), verdictRow({ scope: "manual" }), verdictRow()], expected: true }
];

let binderChecks = 0;
for (const c of binderCases) {
  const got = judgedNoResponseOnInbound(c.rows, {
    convId: c.convId ?? CONV,
    leadKey: c.convId ?? CONV,
    inboundAtMs: INBOUND_MS
  });
  assert.equal(got, c.expected, `binder[${c.id}] expected ${c.expected}, got ${got}`);
  binderChecks += 1;
}

// The allowlist itself is the safety boundary — pin its exact membership so a future
// "just add anything that looks like a no-reply" widening has to argue with this line.
assert.deepEqual(
  [...DELIBERATE_SILENCE_ROUTE_OUTCOMES].sort(),
  ["customer_ack_no_response", "short_ack_no_reply"],
  "the deliberate-silence allowlist must stay explicit and minimal"
);
assert.ok(
  ![...DELIBERATE_SILENCE_ROUTE_OUTCOMES].some(o => o.includes("overridden")),
  "an overridden verdict is not a decision to stay silent"
);

// --- 3) Invariant: the default ceiling is a sane, positive horizon (7 days). ---
assert.ok(STUCK_MAX_AGE_SEC_DEFAULT > 0, "recency ceiling must be positive");
assert.equal(STUCK_MAX_AGE_SEC_DEFAULT, 7 * 24 * 60 * 60, "default ceiling should be 7 days");

const actionableCount = rows.filter(r => r.actionable).length;
console.log(
  `PASS route-watchdog stuck classification — ${rows.length} cases (${actionableCount} actionable, ${rows.length - actionableCount} suppressed) + ${binderChecks} verdict-binding cases, default ceiling ${STUCK_MAX_AGE_SEC_DEFAULT}s`
);
