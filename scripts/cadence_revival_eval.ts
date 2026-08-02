/**
 * cadence_revival:eval — ONE referee for "what counts as a DEAD CHASE that a re-engagement trigger
 * may throw away and start over?"
 *
 * WHAT WAS FIGHTING. `startFollowUpCadence` refuses to lay a new chase over a lead that already
 * carries an `active` or `stopped` cadence — quietly reviving a chase somebody deliberately ended
 * is the fail-unsafe direction. So every trigger that DOES mean to revive one first blanks the
 * record (`conv.followUpCadence = undefined`) to defeat that guard. Four places did that, each with
 * its own hand-written test for which cadences are dead enough to discard:
 *
 *   health_recovery_delay       index.ts  applyHealthRecoveryFollowUpDelay
 *   customer_followup_deferral  index.ts  applyCustomerFollowUpDeferral
 *   finance_no_contact          index.ts  voicemail on a manual finance handoff
 *   manual_hold_clear           sendgridInbound.ts  walk-in note saying the hold is over
 *
 * THE DIVERGENCES, PINNED AS-IS (preserved by the un-stacking, NOT fixed by it):
 *
 *   1. `finance_no_contact` is the only trigger that also treats a `completed` chase as dead.
 *      On the other three a completed cadence is left standing, `startFollowUpCadence` is never
 *      called, and the trigger's own `pauseFollowUpCadence` then no-ops (it requires `active`) —
 *      so the trigger silently does nothing at all. Low severity and in the SAFE direction (fewer
 *      proactive texts), which is why it is preserved rather than "fixed".
 *
 *   2. `manual_hold_clear` is the only trigger that forces a SURVIVING cadence back to `active`
 *      where it stands rather than leaving it alone — including a `completed` one, which comes
 *      back to life at whatever step it finished on. A walk-in note saying the hold is over is an
 *      explicit staff instruction to resume the chase, so it overrides a pause the same way it
 *      overrides the hold.
 *
 * FAIL DIRECTION. Every output of this referee can only ever START or RESUME proactive texting, so
 * the dangerous direction is reviving too much. An unrecognized trigger therefore gets the
 * STRICTEST table, not the most permissive one: a caller that forgets to register its trigger
 * loses a revival, it never gains one.
 *
 * THE LOAD-BEARING SECTION is "the four original rules, re-encoded" below: it replays every
 * (trigger x stored cadence) pair through the hand-written tests exactly as they read before the
 * un-stacking, and asserts the referee answers identically. That is the behavior-preservation
 * claim, stated as an executable table rather than as a promise.
 *
 * Unwiring a CALL SITE from the referee is caught mechanically elsewhere: putting an inline
 * `conv.followUpCadence = undefined` back next to a start raises the unrefereed-writer count above
 * the ratchet in state_writer_contention:eval, which fails ci:eval.
 *
 * Behavior assertions only — no source-text pins (see eval_source_pin_ratchet:eval).
 *
 * Run: npx tsx scripts/cadence_revival_eval.ts
 */
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";

process.env.CONVERSATIONS_DB_PATH =
  process.env.CONVERSATIONS_DB_PATH ||
  path.join(os.tmpdir(), `cadence-revival-eval-${Date.now()}.json`);

const { decideCadenceRevival } = await import("../services/api/src/domain/routeStateReducer.ts");
const { applyCadenceRevival } = await import("../services/api/src/domain/conversationStore.ts");

let checks = 0;
const eq = (actual: unknown, expected: unknown, message: string) => {
  assert.deepEqual(actual, expected, message);
  checks++;
};

const NOW = "2026-08-02T15:00:00.000Z";
const TZ = "America/New_York";

const TRIGGERS = [
  "health_recovery_delay",
  "customer_followup_deferral",
  "finance_no_contact",
  "manual_hold_clear"
] as const;

/** Every cadence shape a lead can actually be carrying. `null` = no cadence record at all. */
const CADENCE_STATES: Array<{ label: string; cadence: any }> = [
  { label: "no cadence", cadence: null },
  { label: "active", cadence: { status: "active", anchorAt: NOW, stepIndex: 2 } },
  {
    label: "active but paused",
    cadence: {
      status: "active",
      anchorAt: NOW,
      stepIndex: 2,
      pausedUntil: "2026-09-01T15:00:00.000Z",
      pauseReason: "customer_thinking_it_over"
    }
  },
  { label: "stopped", cadence: { status: "stopped", anchorAt: NOW, stepIndex: 5, stopReason: "manual_hold" } },
  { label: "completed", cadence: { status: "completed", anchorAt: NOW, stepIndex: 7 } }
];

// --- the four original rules, re-encoded --------------------------------------------------------
// This is the behavior-preservation proof. Each entry is the hand-written test that call site
// carried BEFORE the un-stacking, transcribed literally, plus what it then did.
const ORIGINAL_RULES: Record<
  (typeof TRIGGERS)[number],
  (has: boolean, status: string) => { replaceDeadCadence: boolean; startFresh: boolean; reactivateInPlace: boolean }
> = {
  // if (!conv.followUpCadence || conv.followUpCadence.status === "stopped") { blank; start; }
  health_recovery_delay: (has, status) => {
    const revive = !has || status === "stopped";
    return { replaceDeadCadence: has && revive, startFresh: revive, reactivateInPlace: false };
  },
  // same test, then re-tags whatever survives as an engaged chase
  customer_followup_deferral: (has, status) => {
    const revive = !has || status === "stopped";
    return { replaceDeadCadence: has && revive, startFresh: revive, reactivateInPlace: false };
  },
  // if (!conv.followUpCadence || status === "stopped" || status === "completed") { blank; start; }
  finance_no_contact: (has, status) => {
    const revive = !has || status === "stopped" || status === "completed";
    return { replaceDeadCadence: has && revive, startFresh: revive, reactivateInPlace: false };
  },
  // if (status === "stopped") blank;  then  if (!cadence) start;  else force it back to active
  manual_hold_clear: (has, status) => {
    const dead = has && status === "stopped";
    return { replaceDeadCadence: dead, startFresh: !has || dead, reactivateInPlace: has && !dead };
  }
};

for (const trigger of TRIGGERS) {
  for (const { label, cadence } of CADENCE_STATES) {
    const has = Boolean(cadence);
    const expected = ORIGINAL_RULES[trigger](has, String(cadence?.status ?? ""));
    const decision = decideCadenceRevival({
      trigger,
      hasCadence: has,
      cadenceStatus: cadence?.status ?? null
    });
    eq(
      {
        replaceDeadCadence: decision.replaceDeadCadence,
        startFresh: decision.startFresh,
        reactivateInPlace: decision.reactivateInPlace
      },
      expected,
      `${trigger} on a ${label} lead answers exactly what its own inline rule answered`
    );
  }
}

// --- divergence 1: only the finance lane buries a completed chase -------------------------------
{
  const completed = { hasCadence: true, cadenceStatus: "completed" };
  eq(
    decideCadenceRevival({ trigger: "finance_no_contact", ...completed }).startFresh,
    true,
    "finance_no_contact restarts over a completed chase"
  );
  eq(
    decideCadenceRevival({ trigger: "finance_no_contact", ...completed }).divergence,
    "finance_no_contact_alone_revives_a_completed_chase",
    "...and the decision NAMES that it is the odd one out"
  );
  for (const trigger of ["health_recovery_delay", "customer_followup_deferral"] as const) {
    const decision = decideCadenceRevival({ trigger, ...completed });
    eq(decision.startFresh, false, `${trigger} leaves a completed chase alone`);
    eq(decision.replaceDeadCadence, false, `${trigger} does not discard a completed chase`);
    eq(decision.reactivateInPlace, false, `${trigger} does not resurrect a completed chase either`);
  }
}

// --- divergence 2: only the hold-clear puts a survivor back to work ------------------------------
{
  for (const status of ["active", "completed"] as const) {
    const decision = decideCadenceRevival({
      trigger: "manual_hold_clear",
      hasCadence: true,
      cadenceStatus: status
    });
    eq(decision.reactivateInPlace, true, `manual_hold_clear reactivates a ${status} chase in place`);
    eq(decision.startFresh, false, `...without throwing the ${status} chase away`);
    eq(
      decision.divergence,
      "manual_hold_clear_alone_forces_a_surviving_chase_back_to_active",
      `...and NAMES that it is the only trigger that does so (${status})`
    );
  }
  // A stopped chase is dead for every trigger, hold-clear included — that is the universal case.
  const stopped = decideCadenceRevival({
    trigger: "manual_hold_clear",
    hasCadence: true,
    cadenceStatus: "stopped"
  });
  eq(stopped.replaceDeadCadence, true, "manual_hold_clear discards a stopped chase like the rest");
  eq(stopped.reactivateInPlace, false, "...rather than resurrecting it in place");
}

// --- fail direction: an unrecognized trigger gets the STRICTEST table ----------------------------
{
  const completed = decideCadenceRevival({
    trigger: "some_lane_nobody_registered",
    hasCadence: true,
    cadenceStatus: "completed"
  });
  eq(completed.startFresh, false, "an unregistered trigger does NOT inherit the finance lane's reach");
  eq(completed.reactivateInPlace, false, "...and does not inherit the hold-clear's in-place revival");
  const stopped = decideCadenceRevival({
    trigger: "",
    hasCadence: true,
    cadenceStatus: "stopped"
  });
  eq(stopped.startFresh, true, "a blank trigger still gets the universal stopped-is-dead answer");
  // Status casing/whitespace must not decide whether we text somebody.
  eq(
    decideCadenceRevival({ trigger: "finance_no_contact", hasCadence: true, cadenceStatus: " COMPLETED " })
      .startFresh,
    true,
    "the status is normalized before it is read"
  );
}

// --- end to end, against the real store ---------------------------------------------------------
// The referee decides; the applier is what actually rewrites the lead. These run the shipped
// conversationStore code, so a mis-wired applier fails here even though the table above passes.
const leadWith = (cadence: any) => ({
  id: `c-${Math.random().toString(36).slice(2)}`,
  status: "open",
  followUp: {},
  followUpCadence: cadence ? { ...cadence } : undefined
}) as any;

{
  // No cadence at all: every trigger lays a fresh day-one ramp.
  for (const trigger of TRIGGERS) {
    const conv = leadWith(null);
    applyCadenceRevival(conv, { trigger, anchorAtIso: NOW, timeZone: TZ });
    eq(conv.followUpCadence?.status, "active", `${trigger} starts a chase on a lead that had none`);
    eq(conv.followUpCadence?.stepIndex, 0, `...at step zero`);
    eq(conv.followUpCadence?.anchorAt, NOW, `...anchored at the caller's clock, not the wall clock`);
  }
}

{
  // A stopped chase is discarded and rebuilt from step zero — the case the blanking existed for.
  for (const trigger of TRIGGERS) {
    const conv = leadWith({ status: "stopped", anchorAt: "2026-01-01T00:00:00.000Z", stepIndex: 6 });
    applyCadenceRevival(conv, { trigger, anchorAtIso: NOW, timeZone: TZ });
    eq(conv.followUpCadence?.status, "active", `${trigger} revives a stopped chase`);
    eq(conv.followUpCadence?.stepIndex, 0, `...starting over rather than resuming at step 6`);
    eq(conv.followUpCadence?.stopReason, undefined, `...with the stop reason gone`);
  }
}

{
  // A RUNNING chase is never thrown away by the three index triggers.
  for (const trigger of ["health_recovery_delay", "customer_followup_deferral", "finance_no_contact"] as const) {
    const conv = leadWith({ status: "active", anchorAt: "2026-01-01T00:00:00.000Z", stepIndex: 4 });
    applyCadenceRevival(conv, { trigger, anchorAtIso: NOW, timeZone: TZ });
    eq(conv.followUpCadence?.stepIndex, 4, `${trigger} leaves a running chase at its own step`);
    eq(conv.followUpCadence?.anchorAt, "2026-01-01T00:00:00.000Z", `...and at its own anchor`);
  }
}

{
  // Divergence 1, applied: the finance lane rebuilds a completed chase; the others leave it.
  const finance = leadWith({ status: "completed", anchorAt: "2026-01-01T00:00:00.000Z", stepIndex: 7 });
  applyCadenceRevival(finance, { trigger: "finance_no_contact", anchorAtIso: NOW, timeZone: TZ });
  eq(finance.followUpCadence?.status, "active", "finance_no_contact restarts the completed chase");
  eq(finance.followUpCadence?.stepIndex, 0, "...from step zero");

  const health = leadWith({ status: "completed", anchorAt: "2026-01-01T00:00:00.000Z", stepIndex: 7 });
  applyCadenceRevival(health, { trigger: "health_recovery_delay", anchorAtIso: NOW, timeZone: TZ });
  eq(health.followUpCadence?.status, "completed", "health_recovery_delay leaves the completed chase completed");
  eq(health.followUpCadence?.stepIndex, 7, "...untouched at the step it finished on");
}

{
  // Divergence 2, applied: the hold-clear un-pauses a running chase where it stands.
  const conv = leadWith({
    status: "active",
    anchorAt: "2026-01-01T00:00:00.000Z",
    stepIndex: 3,
    pausedUntil: "2026-09-01T15:00:00.000Z",
    pauseReason: "manual_hold"
  });
  applyCadenceRevival(conv, { trigger: "manual_hold_clear", anchorAtIso: NOW, timeZone: TZ });
  eq(conv.followUpCadence?.status, "active", "manual_hold_clear keeps the chase active");
  eq(conv.followUpCadence?.pausedUntil, undefined, "...and lifts the pause");
  eq(conv.followUpCadence?.pauseReason, undefined, "...including its reason");
  eq(conv.followUpCadence?.stepIndex, 3, "...without losing the lead's place in the sequence");

  // ...and brings a COMPLETED chase back to life in place, which no other trigger does.
  const done = leadWith({ status: "completed", anchorAt: "2026-01-01T00:00:00.000Z", stepIndex: 7 });
  applyCadenceRevival(done, { trigger: "manual_hold_clear", anchorAtIso: NOW, timeZone: TZ });
  eq(done.followUpCadence?.status, "active", "manual_hold_clear resurrects a completed chase in place");
  eq(done.followUpCadence?.stepIndex, 7, "...at the step it had finished on, not step zero");
}

{
  // The deferral lane's own bookkeeping: whatever cadence survives is re-tagged as engaged.
  const fresh = leadWith(null);
  applyCadenceRevival(fresh, {
    trigger: "customer_followup_deferral",
    anchorAtIso: NOW,
    timeZone: TZ,
    engagedContextTag: "customer_thinking_it_over"
  });
  eq(fresh.followUpCadence?.kind, "engaged", "the deferral tags a freshly started chase as engaged");
  eq(fresh.followUpCadence?.contextTag, "customer_thinking_it_over", "...with the deferral's reason");
  eq(fresh.followUpCadence?.contextTagUpdatedAt, NOW, "...stamped at the caller's clock");

  const running = leadWith({ status: "active", anchorAt: "2026-01-01T00:00:00.000Z", stepIndex: 4 });
  applyCadenceRevival(running, {
    trigger: "customer_followup_deferral",
    anchorAtIso: NOW,
    timeZone: TZ,
    engagedContextTag: "customer_thinking_it_over"
  });
  eq(running.followUpCadence?.kind, "engaged", "a surviving chase is re-tagged too");
  eq(running.followUpCadence?.stepIndex, 4, "...without being restarted");

  // No tag supplied (the other three lanes) => the kind is left exactly as it was.
  const untagged = leadWith({ status: "active", anchorAt: NOW, stepIndex: 1, kind: "long_term" });
  applyCadenceRevival(untagged, { trigger: "health_recovery_delay", anchorAtIso: NOW, timeZone: TZ });
  eq(untagged.followUpCadence?.kind, "long_term", "a lane with no context tag never re-labels the chase");
}

{
  // The revival must not outrank decideCadenceStart's own refusals. A closed thread and a
  // non-sales lead both stay without a chase — reviving either is the fail-unsafe direction.
  const closed = leadWith(null);
  closed.status = "closed";
  applyCadenceRevival(closed, { trigger: "finance_no_contact", anchorAtIso: NOW, timeZone: TZ });
  eq(closed.followUpCadence, undefined, "a closed thread gets no revived chase");

  const vendor = leadWith({ status: "stopped", anchorAt: NOW, stepIndex: 2 });
  vendor.followUp = { reason: "vendor_inquiry" };
  applyCadenceRevival(vendor, { trigger: "manual_hold_clear", anchorAtIso: NOW, timeZone: TZ });
  eq(vendor.followUpCadence, undefined, "a non-sales lead's stopped chase is discarded and NOT restarted");
}

// --- the referee is registered with the equivalence harness --------------------------------------
// An un-stacking whose referee is missing from buildDecisionRegistry ships with no evidence behind
// it: decision_equivalence would report IDENTICAL because it never looked.
{
  const reducer = await import("../services/api/src/domain/routeStateReducer.ts");
  const { buildDecisionRegistry } = await import(
    "../services/api/src/domain/decisionFingerprint.ts"
  );
  const registry = buildDecisionRegistry(reducer as any);
  const covered = registry.filter((entry: any) =>
    (entry.covers ?? []).includes("decideCadenceRevival")
  );
  eq(covered.length, TRIGGERS.length, "every revival trigger is sampled by the equivalence harness");
  for (const trigger of TRIGGERS) {
    eq(
      covered.some((entry: any) => entry.name === `cadenceRevival:${trigger}`),
      true,
      `the harness samples the ${trigger} trigger specifically`
    );
  }
  // ...and the samples must actually project — a sampler that silently returns undefined for every
  // lead is the "compared nothing" failure the harness exists to refuse.
  const lead = { followUpCadence: { status: "stopped", anchorAt: NOW, stepIndex: 3 } } as any;
  for (const entry of covered) {
    eq(
      entry.sample(lead, { nowMs: Date.parse(NOW), timeZone: TZ }) !== undefined,
      true,
      `${entry.name} projects a real answer off a stored cadence`
    );
  }
}

console.log(`cadence_revival:eval OK — ${checks} checks`);
