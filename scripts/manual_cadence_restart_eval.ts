/**
 * manual_cadence_restart:eval — ONE referee for "when staff's own outreach turns the follow-up
 * chase back on, does this lead keep its place in the sequence or start over at day one?"
 *
 * WHAT WAS FIGHTING. Three places rebuilt `followUpCadence` wholesale when a staff action put a
 * lead back on a context-tagged chase, each with its own hand-written reuse rule:
 *
 *   activateManualQuoteDeliveredFollowUp   staff texted the customer their quote
 *   the credit-app "needs info" handler    staff asked for missing finance docs
 *   the manual-context prompt              staff picked "seller intake" / "buyer interest"
 *
 * THE DIVERGENCE, PINNED AS-IS (preserved by the un-stacking, NOT fixed by it). The quote and
 * finance lanes keep a lead's place ONLY when the cadence is still ACTIVE and already running for
 * the SAME context; anything else restarts at step 0 on a fresh anchor. The manual-context prompt
 * keeps the place of ANY cadence that has not COMPLETED — including one that was STOPPED, and one
 * tagged for a different context entirely.
 *
 * Why that matters to a customer: a lead chased nine times and then stopped, whom staff now tag
 * "buyer interest", comes back at step 9 carrying the OLD anchor and the OLD due date. The stale
 * due date can already be in the past, so the next scheduler tick fires immediately instead of the
 * day-one ramp staff asked for; and step 9 is at DISENGAGED_TAPER_AFTER_TOUCHES, so on a lead who
 * never replied the cadence sends ONE touch and then completes itself as "disengaged_taper".
 * Flagged for Joe; pinned here so it cannot drift further meanwhile.
 *
 * FAIL DIRECTION. Keeping a place we should not keep resumes a lead deep in a sequence and can fire
 * an overdue touch immediately — it fails toward MESSAGING a customer. Starting over only costs a
 * few days of nurture. So anything unrecognized must START OVER.
 *
 * Behavior assertions only — no source-text pins (see eval_source_pin_ratchet:eval).
 *
 * Run: npx tsx scripts/manual_cadence_restart_eval.ts
 */
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";

process.env.CONVERSATIONS_DB_PATH =
  process.env.CONVERSATIONS_DB_PATH ||
  path.join(os.tmpdir(), `manual-cadence-restart-eval-${Date.now()}.json`);

const { decideManualCadenceRestart } = await import(
  "../services/api/src/domain/routeStateReducer.ts"
);
const { applyManualCadenceRestart, DISENGAGED_TAPER_AFTER_TOUCHES } = await import(
  "../services/api/src/domain/conversationStore.ts"
);

let checks = 0;
const ok = (condition: boolean, message: string) => {
  assert.equal(condition, true, message);
  checks++;
};
const eq = (actual: unknown, expected: unknown, message: string) => {
  assert.deepEqual(actual, expected, message);
  checks++;
};

const NOW = "2026-08-01T15:00:00.000Z";
const TZ = "America/New_York";

/** A cadence mid-sequence, as the store holds one when staff reach out by hand. */
const cadence = (over: Record<string, unknown> = {}) => ({
  status: "active",
  kind: "engaged",
  anchorAt: "2026-07-01T13:00:00.000Z",
  nextDueAt: "2026-07-20T13:00:00.000Z",
  stepIndex: 4,
  contextTag: "manual_quote_delivered",
  scheduleInviteCount: 2,
  scheduleMuted: true,
  lastSentStep: 3,
  ...over
});

const TAG_LANES = ["manual_quote_delivered", "finance_docs"] as const;
const PROMPT_LANES = ["seller_photo_details_request", "buyer_interest"] as const;
const ALL_LANES = [...TAG_LANES, ...PROMPT_LANES] as const;

// --- the invariant every lane must satisfy: a restart leaves an ACTIVE, day-one-or-later cadence --
for (const context of ALL_LANES) {
  const conv: any = { id: "c1", followUpCadence: cadence({ contextTag: context, status: "stopped" }) };
  applyManualCadenceRestart(conv, { context, kind: "engaged", nowIso: NOW, timeZone: TZ });

  eq(conv.followUpCadence.status, "active", `${context}: the chase is switched back on`);
  eq(conv.followUpCadence.contextTag, context, `${context}: the cadence is tagged for this context`);
  eq(conv.followUpCadence.contextTagUpdatedAt, NOW, `${context}: the tag is stamped now`);
  eq(conv.followUpCadence.stopReason, undefined, `${context}: the old stop reason is cleared`);
  eq(conv.followUpCadence.pausedUntil, undefined, `${context}: any pause is lifted`);
  eq(conv.followUpCadence.pauseReason, undefined, `${context}: the pause reason is cleared`);
  ok(!!String(conv.followUpCadence.nextDueAt ?? "").trim(), `${context}: a next touch is scheduled`);
  ok(
    Number(conv.followUpCadence.stepIndex) >= 0,
    `${context}: the step index is never negative`
  );
}

// --- the two agreeing lanes: same context + still active => keep the place -----------------------
for (const context of TAG_LANES) {
  const decision = decideManualCadenceRestart({
    context,
    existing: cadence({ contextTag: context, status: "active" }),
    nowIso: NOW
  });
  eq(decision.keepPlaceInLine, true, `${context}: a live same-context chase keeps its place`);
  eq(decision.stepIndex, 4, `${context}: the lead resumes at the step it reached`);
  eq(decision.anchorAt, "2026-07-01T13:00:00.000Z", `${context}: the original anchor is kept`);
  eq(decision.keepNextDueAt, "2026-07-20T13:00:00.000Z", `${context}: the scheduled touch is kept`);
  eq(decision.divergence, null, `${context}: agrees with the majority rule — nothing to name`);
}

// --- ...and start over when the cadence is stopped, or tagged for something else -----------------
for (const context of TAG_LANES) {
  for (const [label, existing] of [
    ["stopped", cadence({ contextTag: context, status: "stopped" })],
    ["completed", cadence({ contextTag: context, status: "completed" })],
    ["a different context", cadence({ contextTag: "some_other_context", status: "active" })]
  ] as const) {
    const decision = decideManualCadenceRestart({ context, existing, nowIso: NOW });
    eq(decision.keepPlaceInLine, false, `${context}: ${label} => start over, not resume`);
    eq(decision.stepIndex, 0, `${context}: ${label} => back to step 0`);
    eq(decision.anchorAt, NOW, `${context}: ${label} => a fresh anchor`);
    eq(decision.keepNextDueAt, null, `${context}: ${label} => the caller computes a day-one date`);
  }
}

// --- THE PRESERVED DIVERGENCE -------------------------------------------------------------------
// The manual-context prompt resumes a STOPPED cadence, and one tagged for a different context.
// This is today's live behavior and the un-stacking must not silently "fix" it.
for (const context of PROMPT_LANES) {
  for (const [label, existing] of [
    ["a stopped chase", cadence({ contextTag: context, status: "stopped" })],
    ["a foreign-tagged chase", cadence({ contextTag: "finance_docs", status: "active" })]
  ] as const) {
    const decision = decideManualCadenceRestart({ context, existing, nowIso: NOW });
    eq(decision.keepPlaceInLine, true, `${context}: ${label} KEEPS its place (divergence, as-is)`);
    eq(decision.stepIndex, 4, `${context}: ${label} resumes mid-sequence (divergence, as-is)`);
    eq(
      decision.keepNextDueAt,
      "2026-07-20T13:00:00.000Z",
      `${context}: ${label} carries the OLD due date forward (divergence, as-is)`
    );
    eq(
      decision.divergence,
      "manual_context_prompt_keeps_the_place_of_a_stopped_or_foreign_cadence",
      `${context}: the disagreement is NAMED on the decision, not buried in a branch`
    );
  }
  // ...but a COMPLETED cadence starts over even here — that is the one thing all four lanes agree on.
  const done = decideManualCadenceRestart({
    context,
    existing: cadence({ contextTag: context, status: "completed" }),
    nowIso: NOW
  });
  eq(done.keepPlaceInLine, false, `${context}: a completed chase always starts over`);
  eq(done.stepIndex, 0, `${context}: a completed chase restarts at step 0`);
}

// --- THE SECOND PRESERVED DIVERGENCE: who carries the old record forward -------------------------
// The quote/finance lanes spread the previous cadence's leftover fields onto the new one even when
// they just decided it was finished business; the prompt lanes only carry them when they resumed.
{
  const finished = cadence({ contextTag: "some_other_context", status: "completed", scheduleMuted: true });

  const tagLane = decideManualCadenceRestart({ context: "finance_docs", existing: finished, nowIso: NOW });
  eq(tagLane.keepPlaceInLine, false, "finance_docs: a finished foreign cadence does not keep its place");
  eq(tagLane.carryExistingRecord, true, "finance_docs CARRIES the old record forward (divergence, as-is)");
  eq(tagLane.scheduleMuted, true, "finance_docs inherits the old schedule-mute (divergence, as-is)");
  eq(
    tagLane.divergence,
    "quote_and_finance_lanes_carry_a_finished_cadence_record_forward",
    "the second disagreement is NAMED too"
  );

  const promptLane = decideManualCadenceRestart({ context: "buyer_interest", existing: finished, nowIso: NOW });
  eq(promptLane.carryExistingRecord, false, "buyer_interest drops a finished record instead of carrying it");
  eq(promptLane.scheduleMuted, false, "buyer_interest starts un-muted");
  eq(promptLane.scheduleInviteCount, 0, "buyer_interest starts the invite counter at zero");
}

// --- the harm this divergence causes, stated as a fact the eval can hold ------------------------
// A never-replied lead resumed at the taper threshold sends one touch and then ends. Pinning the
// step the referee hands back is what makes that visible if anyone changes the rule.
{
  const atTaper = decideManualCadenceRestart({
    context: "buyer_interest",
    existing: cadence({ contextTag: "manual_quote_delivered", status: "stopped", stepIndex: DISENGAGED_TAPER_AFTER_TOUCHES }),
    nowIso: NOW
  });
  eq(
    atTaper.stepIndex,
    DISENGAGED_TAPER_AFTER_TOUCHES,
    "the prompt lane resumes AT the disengagement-taper threshold — one touch then done"
  );
  ok(atTaper.divergence != null, "and it is reported as a divergence, not as normal business");
}

// --- FAIL DIRECTION: no cadence, junk state, or an unknown context all land on day one -----------
// A blank or half-written record has no place to resume TO, so whatever the reuse flag says, the
// lead must come out at step 0, on a fresh anchor, with no inherited due date. That is the
// property that matters — a phantom resume is what would message a customer unexpectedly.
for (const [label, existing] of [
  ["no cadence at all", null],
  ["an undefined cadence", undefined],
  ["an empty record", {}],
  ["a status with nothing else", { status: "active" }],
  ["a non-numeric step", { status: "active", contextTag: "buyer_interest", stepIndex: "seven" }]
] as const) {
  const decision = decideManualCadenceRestart({
    context: "buyer_interest",
    existing: existing as any,
    nowIso: NOW
  });
  eq(decision.stepIndex, 0, `${label} => step 0`);
  eq(decision.anchorAt, NOW, `${label} => a fresh anchor`);
  eq(decision.keepNextDueAt, null, `${label} => no inherited due date`);
  eq(decision.scheduleInviteCount, 0, `${label} => a zeroed invite counter`);
}
for (const existing of [null, undefined] as const) {
  eq(
    decideManualCadenceRestart({ context: "buyer_interest", existing, nowIso: NOW }).keepPlaceInLine,
    false,
    "nothing stored => start over (never resume a phantom)"
  );
}
{
  const unknown = decideManualCadenceRestart({
    context: "some_future_context",
    existing: cadence({ contextTag: "some_future_context", status: "stopped" }),
    nowIso: NOW
  });
  eq(unknown.keepPlaceInLine, false, "an unrecognized context starts over — the safe direction");
  eq(unknown.stepIndex, 0, "an unrecognized context restarts at step 0");
  eq(unknown.anchorAt, NOW, "an unrecognized context re-anchors to now");
}

// --- the referee is PURE: same input, same answer, no clock -------------------------------------
eq(
  decideManualCadenceRestart({ context: "finance_docs", existing: cadence(), nowIso: NOW }),
  decideManualCadenceRestart({ context: "finance_docs", existing: cadence(), nowIso: NOW }),
  "the referee is pure — identical input gives an identical decision"
);

// --- the applier writes what the referee decided, and computes a day-one date when told to ------
{
  const conv: any = { id: "c2", followUpCadence: cadence({ contextTag: "buyer_interest", status: "completed" }) };
  const decision = applyManualCadenceRestart(conv, {
    context: "buyer_interest",
    kind: "standard",
    nowIso: NOW,
    timeZone: TZ
  });
  eq(decision.keepPlaceInLine, false, "a completed cadence starts over");
  eq(conv.followUpCadence.stepIndex, 0, "the applier writes step 0");
  eq(conv.followUpCadence.kind, "standard", "the applier writes the caller's cadence kind");
  eq(conv.followUpCadence.anchorAt, NOW, "the applier re-anchors to the caller's clock");
  ok(
    conv.followUpCadence.nextDueAt !== "2026-07-20T13:00:00.000Z",
    "the applier computed a fresh day-one date instead of inheriting the stale one"
  );
  ok(
    new Date(conv.followUpCadence.nextDueAt).getTime() > new Date(NOW).getTime(),
    "the fresh day-one touch is in the future — no immediate overdue fire"
  );
  eq(conv.followUpCadence.lastSentStep, undefined, "a dropped record does not leak its send history");
}
{
  const conv: any = { id: "c3", followUpCadence: cadence({ contextTag: "finance_docs", status: "active" }) };
  applyManualCadenceRestart(conv, { context: "finance_docs", kind: "engaged", nowIso: NOW, timeZone: TZ });
  eq(conv.followUpCadence.nextDueAt, "2026-07-20T13:00:00.000Z", "a resumed lead keeps its scheduled touch");
  eq(conv.followUpCadence.stepIndex, 4, "a resumed lead keeps its place");
  eq(conv.followUpCadence.scheduleInviteCount, 2, "a resumed lead keeps its invite counter");
}

// --- a lead with NO cadence at all gets a clean day-one one -------------------------------------
{
  const conv: any = { id: "c4" };
  applyManualCadenceRestart(conv, {
    context: "manual_quote_delivered",
    kind: "engaged",
    nowIso: NOW,
    timeZone: TZ
  });
  eq(conv.followUpCadence.status, "active", "a lead with no cadence gets one");
  eq(conv.followUpCadence.stepIndex, 0, "...starting at step 0");
  eq(conv.followUpCadence.anchorAt, NOW, "...anchored now");
  eq(conv.followUpCadence.scheduleInviteCount, 0, "...with a zeroed invite counter");
  eq(conv.followUpCadence.scheduleMuted, false, "...and un-muted");
}

// --- the applier does not stamp updatedAt: its callers own the save ------------------------------
{
  const conv: any = { id: "c5", updatedAt: "2026-01-01T00:00:00.000Z" };
  applyManualCadenceRestart(conv, {
    context: "buyer_interest",
    kind: "standard",
    nowIso: NOW,
    timeZone: TZ
  });
  eq(conv.updatedAt, "2026-01-01T00:00:00.000Z", "the applier leaves the save to its caller");
}

console.log(`manual_cadence_restart:eval OK — ${checks} checks`);
