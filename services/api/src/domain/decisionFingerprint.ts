/**
 * Decision fingerprint — the equivalence harness for un-stacking.
 *
 * Joe, 2026-08-01: "I need everything burned down that is fighting as soon as possible."
 *
 * THE PROBLEM THIS SOLVES. Un-stacking (giving contended state ONE referee instead of many
 * writers deciding for themselves — see domain/stateWriterContention.ts) is supposed to be
 * behavior-preserving. But "I refactored it and it looks fine" is not evidence, and Joe is not a
 * programmer: asking him to eyeball a refactor diff is asking for the one judgement a human is
 * worst at and he is least equipped to make. So the queue stalls, and nothing gets burned down.
 *
 * THE TEST INSTEAD: run every real conversation through the OLD code and the NEW code and compare
 * what the agent DECIDED. Identical across the whole live corpus ⇒ provably behavior-preserving,
 * on actual customer messages rather than on an assertion.
 *
 * COMPARE DECISIONS, NOT WORDS. Reply text is written by an LLM and differs slightly on every run,
 * so diffing prose would drown a real regression in hundreds of fake ones. The decisions — which
 * cadence, what appointment status, disclose the hold or not — are deterministic, and they are
 * exactly what un-stacking can break. That is what this fingerprints.
 *
 * DETERMINISM IS THE WHOLE CONTRACT. Every input must be a pure projection of STORED state plus a
 * pinned clock. `Date.now()` is never read: a decision that depends on the wall clock would differ
 * between the baseline run and the candidate run for reasons that have nothing to do with the
 * change, which would make the harness useless exactly when it matters.
 *
 * FAIL DIRECTION — the one that would quietly ruin this: a harness that reports "no differences"
 * because it compared NOTHING is worse than no harness, because it launders an unverified refactor
 * as proven. So an empty corpus, an empty registry, or a projection that throws all FAIL CLOSED,
 * and every comparison carries the count of what it actually covered.
 */

export type FingerprintClock = {
  /** Pinned "now" for every time-dependent decision. Never Date.now(). */
  nowMs: number;
  timeZone: string;
};

/**
 * One sampled decision: a name, and a pure projection from a stored conversation to its result.
 * `undefined` means "not applicable to this conversation" and is omitted from the fingerprint —
 * distinct from a decision that ran and produced a value.
 */
export type SampledDecision = {
  name: string;
  sample: (conv: any, clock: FingerprintClock) => unknown | undefined;
  /**
   * The reducer function(s) this sample exercises. Declared, not inferred — `decision_registry_
   * coverage:eval` reads it to prove every referee is either sampled here or consciously classified
   * as un-projectable. Inferring it by reflection would silently pass when a sample early-returns.
   */
  covers: string[];
};

export type ConversationFingerprint = {
  convId: string;
  decisions: Record<string, unknown>;
};

export type FingerprintRun = {
  clock: FingerprintClock;
  decisionNames: string[];
  conversations: ConversationFingerprint[];
  /** Projections that threw. Non-empty = the run is NOT trustworthy. */
  errors: { convId: string; decision: string; message: string }[];
};

function str(value: unknown): string | undefined {
  const s = String(value ?? "").trim();
  return s || undefined;
}

/**
 * THE REGISTRY. Every referee the un-stack loop adds MUST be sampled here, or its PR ships with
 * no equivalence evidence — the loop's instructions say so, and `state_writer_contention` names
 * the fields these cover.
 *
 * Only decisions that are (a) pure and (b) projectable from stored state belong here. A decision
 * that needs this turn's customer text is not sampleable from the store and is out of scope —
 * un-stacking targets STATE arbitration, not comprehension.
 */
/**
 * The standard/engaged follow-up ladder, for SAMPLING only. Mirrors FOLLOW_UP_DAY_OFFSETS in
 * conversationStore, which this import-free module cannot pull in (that file loads the store).
 * Drift is guarded: cadence_manual_advance:eval asserts the two stay equal.
 */
export const SAMPLING_FOLLOW_UP_DAY_OFFSETS = [1, 2, 3, 5, 7, 10, 15, 21, 30, 45, 60, 90, 120];

export function buildDecisionRegistry(reducer: any): SampledDecision[] {
  const registry: SampledDecision[] = [];

  const add = (name: string, fn: SampledDecision["sample"], covers: string[] = []) => {
    // A referee that has not shipped yet simply is not sampled — that is correct on the BASELINE
    // side of a comparison, where the new function does not exist. It must never throw.
    registry.push({ name, sample: fn, covers });
  };

  add("staleBookedAppointmentDay", (conv, clock) => {
    const whenIso = str(conv?.appointment?.whenIso);
    if (!whenIso || typeof reducer.isStaleBookedAppointmentDay !== "function") return undefined;
    return reducer.isStaleBookedAppointmentDay({ whenIso, nowMs: clock.nowMs, timeZone: clock.timeZone });
  }, ["isStaleBookedAppointmentDay"]);

  add("canAssertMissedAppointment", (conv, clock) => {
    const whenIso = str(conv?.appointment?.whenIso);
    if (!whenIso || typeof reducer.canAssertMissedAppointment !== "function") return undefined;
    const outcome = conv?.appointment?.staffNotify?.outcome ?? {};
    return reducer.canAssertMissedAppointment({
      whenIso,
      nowMs: clock.nowMs,
      outcomePrimaryStatus: outcome.primaryStatus ?? null,
      outcomeLegacyStatus: outcome.status ?? null
    });
  }, ["canAssertMissedAppointment"]);

  add("staleSoldAnnouncement", (conv, clock) => {
    const soldAtIso = str(conv?.sale?.soldAt);
    if (!soldAtIso || typeof reducer.isStaleSoldAnnouncement !== "function") return undefined;
    return reducer.isStaleSoldAnnouncement({ soldAtIso, nowMs: clock.nowMs });
  }, ["isStaleSoldAnnouncement"]);

  add("internationalLeadPhone", conv => {
    const phone = str(conv?.lead?.phone) ?? str(conv?.id);
    if (!phone || typeof reducer.isInternationalLeadPhone !== "function") return undefined;
    return reducer.isInternationalLeadPhone(phone);
  }, ["isInternationalLeadPhone"]);

  // Added 2026-08-01 with PR #398 — the worked example of an un-stacking referee.
  add("financeDeclinedCadence", conv => {
    if (typeof reducer.decideFinanceDeclinedCadence !== "function") return undefined;
    return reducer.decideFinanceDeclinedCadence({
      followUpReason: conv?.followUp?.reason ?? null,
      financeOutcomeStatus: conv?.financeOutcome?.status ?? null,
      appointmentOutcomeStatus: conv?.appointment?.staffNotify?.outcome?.status ?? null,
      appointmentOutcomeSecondaryStatus: conv?.appointment?.staffNotify?.outcome?.secondaryStatus ?? null,
      cadenceKind: conv?.followUpCadence?.kind ?? null,
      cadenceStatus: conv?.followUpCadence?.status ?? null
    });
  }, ["decideFinanceDeclinedCadence"]);

  // Added 2026-08-02 with the burned-cadence-ladder heal (Dennis Daffron +16303628805). Sampled as:
  // given this conversation's CURRENT ladder position and how long the cadence has actually been
  // running, is that a rung the calendar has earned?
  //
  // The ladder is a LOCAL copy on purpose: this module is deliberately import-free so it can load
  // against a BASELINE checkout (hence `reducer: any` + the typeof guards), and the real constant
  // lives in conversationStore, which loads the store on import. A copy is the trade — so
  // cadence_manual_advance:eval asserts SAMPLING_FOLLOW_UP_DAY_OFFSETS still equals
  // FOLLOW_UP_DAY_OFFSETS, and fails the build if they ever drift apart.
  add("burnedCadenceLadderRealign", (conv, clock) => {
    const cad = conv?.followUpCadence;
    if (!cad || typeof reducer.decideBurnedCadenceLadderRealign !== "function") return undefined;
    const anchorMs = Date.parse(String(cad.anchorAt ?? ""));
    const pausedUntilMs = Date.parse(String(cad.pausedUntil ?? ""));
    return reducer.decideBurnedCadenceLadderRealign({
      status: cad.status ?? null,
      kind: cad.kind ?? null,
      stepIndex: cad.stepIndex ?? null,
      ageDays: Number.isFinite(anchorMs) ? Math.floor((clock.nowMs - anchorMs) / 86_400_000) : null,
      ladderOffsets: SAMPLING_FOLLOW_UP_DAY_OFFSETS,
      conversationClosed: !!(conv?.closedAt || conv?.closedReason || conv?.sale?.soldAt),
      pausedInFuture: Number.isFinite(pausedUntilMs) && pausedUntilMs > clock.nowMs
    });
  }, ["decideBurnedCadenceLadderRealign"]);

  // Added 2026-08-01 with the draftHeld un-stacking. Sampled as: given this conversation's CURRENT
  // hold, would a real reply release it? That is the question the six former clear-sites disagreed on.
  add("heldDraftReleaseOnRealReply", conv => {
    const held = conv?.draftHeld;
    if (!held || typeof reducer.decideHeldDraftRelease !== "function") return undefined;
    return reducer.decideHeldDraftRelease({
      heldKind: held.heldKind ?? held.reason,
      event: "real_reply"
    });
  }, ["decideHeldDraftRelease"]);

  // ---------------------------------------------------------------------------------------------
  // PROBED DECISIONS (added 2026-08-01, registry-deepening pass).
  //
  // Some referees mix STORED state with THIS TURN's inputs (what the customer just said, what the
  // parser read). Those look un-sampleable, and the registry skipped them — which left the harness
  // blind exactly where the next un-stackings will land.
  //
  // THE PROBE TECHNIQUE closes that gap: hold every turn-derived input at a FIXED, documented
  // value and vary ONLY the stored state. The sample then answers a precise, deterministic
  // question — "holding the customer's side constant, does this conversation's STATE still steer
  // the decision the same way?" — which is exactly what un-stacking can break, and nothing else.
  //
  // A probe must never be mistaken for full coverage of its referee: it pins one row of that
  // decision's table, chosen to be the row where state arbitration actually happens. The probe
  // values are named inline so a future reader can see which row is pinned and add others.
  // ---------------------------------------------------------------------------------------------

  // Appointment state — the NEXT un-stacking target (23 unrefereed writers, the top of the queue).
  // PROBE: staff clearly confirmed a requested time (pending request present, affirmative, no
  // question mark). Everything that varies is stored appointment state, which is the whole point.
  add("manualConfirmPendingAppointment", (conv, clock) => {
    if (typeof reducer.decideManualConfirmPendingAppointment !== "function") return undefined;
    const whenIso = str(conv?.appointment?.whenIso);
    const whenMs = whenIso ? Date.parse(whenIso) : NaN;
    return reducer.decideManualConfirmPendingAppointment({
      hasPendingRequestText: true, // PROBE
      hasAffirmativeAck: true, // PROBE
      hasQuestionMark: false, // PROBE
      hasBookedEvent: !!str(conv?.appointment?.bookedEventId),
      existingBookedAppointmentIsPast:
        Number.isFinite(whenMs) && whenMs < clock.nowMs - 3_600_000
    });
  }, ["decideManualConfirmPendingAppointment"]);

  // Added 2026-08-01 with the appointment-outcome-record un-stacking (nine writers, one referee).
  // PROBE: hold the INCOMING write fixed at the bare-shape lane that actually causes the collision
  // — a finance-declined signal, no primary/secondary pair, no note — and vary only the outcome
  // ALREADY on the conversation. The sample then answers exactly the question the nine sites
  // disagreed about: given what this lead's record already says, what does a bare write turn the
  // attendance answer into, and does it drop a recorded one? A fixed clock string keeps `record`
  // stable so only the arbitration can move the fingerprint.
  add("appointmentOutcomeRecordOnBareWrite", conv => {
    const existing = conv?.appointment?.staffNotify?.outcome ?? conv?.dealerRide?.staffNotify?.outcome ?? null;
    if (!existing || typeof reducer.decideAppointmentOutcomeRecord !== "function") return undefined;
    const decision = reducer.decideAppointmentOutcomeRecord({
      source: "finance_signal", // PROBE
      existing,
      incoming: { status: "financing_declined" }, // PROBE — the bare legacy shape
      nowIso: "2026-01-01T00:00:00.000Z" // PROBE — fixed so only arbitration moves the answer
    });
    return {
      attendanceBefore: decision.attendanceBefore,
      attendanceAfter: decision.attendanceAfter,
      attendanceFlipped: decision.attendanceFlipped,
      dropsRecordedAttendance: decision.dropsRecordedAttendance,
      divergence: decision.divergence
    };
  }, ["decideAppointmentOutcomeRecord", "readAppointmentAttendance"]);

  // A/B ARM ASSIGNMENT. Pure functions of an id — perfectly projectable, and uniquely dangerous to
  // leave unsampled: an arm that silently re-buckets corrupts a live experiment's results with no
  // error anywhere, and nothing else in the suite would notice.
  add("cadenceInviteArm", conv => {
    const id = str(conv?.id);
    if (!id || typeof reducer.decideCadenceInviteArm !== "function") return undefined;
    return reducer.decideCadenceInviteArm(id);
  }, ["decideCadenceInviteArm"]);

  add("draftModelArm", conv => {
    const leadKey = str(conv?.leadKey) ?? str(conv?.id);
    if (!leadKey || typeof reducer.decideDraftModelArm !== "function") return undefined;
    return reducer.decideDraftModelArm(leadKey);
  }, ["decideDraftModelArm"]);

  // Closing a lead as international is a SIDE EFFECT on stored state (stop + close), driven by the
  // stored phone. PROBE: an inbound SMS on twilio that has not been logged yet — the arm where the
  // close actually fires.
  add("internationalLeadTurn", conv => {
    if (typeof reducer.decideInternationalLeadTurn !== "function") return undefined;
    const phone = str(conv?.lead?.phone) ?? str(conv?.leadKey);
    if (!phone) return undefined;
    return reducer.decideInternationalLeadTurn({
      provider: "twilio", // PROBE
      channel: "sms", // PROBE
      alreadyLogged: false, // PROBE
      fromPhone: phone
    });
  }, ["decideInternationalLeadTurn"]);

  // Added 2026-08-01 with the followUpCadence quiet-window un-stacking. Sampled once PER TRIGGER,
  // because the point of this referee is that the two triggers answer the same question
  // differently — a single sample would hide exactly the divergence it exists to make visible.
  for (const trigger of ["inventory_watch_alert", "soft_visit_window"] as const) {
    add(`cadenceQuietWindow:${trigger}`, conv => {
      if (typeof reducer.decideCadenceQuietWindow !== "function") return undefined;
      return reducer.decideCadenceQuietWindow({
        trigger,
        cadenceStatus: conv?.followUpCadence?.status ?? null,
        followUpMode: conv?.followUp?.mode ?? null
      });
    }, ["decideCadenceQuietWindow"]);
  }

  // Added 2026-08-01 with the appointment-teardown un-stacking. Sampled once PER CAUSE — this
  // referee is a pure function of the cause (no stored state), and the whole point of it is that
  // one of the five causes answers differently from the other four. A single sample would hide
  // exactly that. PROBE technique: the cause is held at a fixed value per sample, so what varies
  // between a baseline and a candidate run is only the referee's own table.
  for (const cause of [
    "customer_cancelled",
    "calendar_event_gone",
    "staff_cancelled",
    "staff_no_show",
    "manual_outbound_book_failed"
  ] as const) {
    add(`appointmentTeardown:${cause}`, conv => {
      if (!conv?.appointment || typeof reducer.decideAppointmentTeardown !== "function") return undefined;
      return reducer.decideAppointmentTeardown({
        cause,
        reschedulePendingOverride: cause === "customer_cancelled" ? false : undefined
      });
    }, ["decideAppointmentTeardown"]);
  }

  // Added 2026-08-01 with the manual-outbound cadence-restart un-stacking. Sampled once PER
  // CONTEXT, because the whole point of this referee is that two of the lanes keep a lead's place
  // in the follow-up sequence only when the cadence is still running for that same context, and the
  // third keeps the place of ANY cadence that has not completed. A single sample would hide exactly
  // that. PROBE: the context and the clock are held fixed per sample, so the only thing that can
  // move the fingerprint between a baseline and a candidate run is the arbitration itself, applied
  // to the cadence this lead actually has stored.
  for (const context of [
    "manual_quote_delivered",
    "finance_docs",
    "seller_photo_details_request",
    "buyer_interest"
  ] as const) {
    add(`manualCadenceRestart:${context}`, conv => {
      const existing = conv?.followUpCadence ?? null;
      if (!existing || typeof reducer.decideManualCadenceRestart !== "function") return undefined;
      const decision = reducer.decideManualCadenceRestart({
        context, // PROBE
        existing,
        nowIso: "2026-01-01T00:00:00.000Z" // PROBE — fixed so only arbitration moves the answer
      });
      return {
        keepPlaceInLine: decision.keepPlaceInLine,
        stepIndex: decision.stepIndex,
        keptNextDueAt: decision.keepNextDueAt != null,
        carryExistingRecord: decision.carryExistingRecord,
        scheduleMuted: decision.scheduleMuted,
        divergence: decision.divergence
      };
    }, ["decideManualCadenceRestart"]);
  }

  // Added 2026-08-02 with the cadence-START un-stacking. Sampled once PER LANE, because the whole
  // point of this referee is that the three lanes answer "may I lay a new chase over this lead?"
  // differently — standard_ramp never overwrites, the other two always do. A single sample would
  // hide exactly that. PROBE: the lane and `sold` are held at fixed values per sample, so the only
  // thing that can move the fingerprint between a baseline and a candidate run is the arbitration
  // itself, applied to the conversation status + cadence this lead actually has stored.
  for (const lane of ["standard_ramp", "post_sale", "deferred_long_term"] as const) {
    add(`cadenceStart:${lane}`, conv => {
      if (typeof reducer.decideCadenceStart !== "function") return undefined;
      const decision = reducer.decideCadenceStart({
        lane, // PROBE
        conversationStatus: conv?.status ?? null,
        existing: conv?.followUpCadence ?? null,
        sold: conv?.closedReason === "sold" || Boolean(conv?.sale?.soldAt)
      });
      return {
        start: decision.start,
        replacesActiveCadence: decision.replacesActiveCadence,
        scheduleMuted: decision.scheduleMuted,
        divergence: decision.divergence
      };
    }, ["decideCadenceStart"]);
  }

  // Added 2026-08-02 with the cadence-REVIVAL un-stacking. Sampled once PER TRIGGER, because the
  // whole point of this referee is that the four triggers answer "which chases are dead enough to
  // throw away?" differently — finance_no_contact alone buries a `completed` chase, and
  // manual_hold_clear alone puts a surviving one back to work in place. A single sample would hide
  // exactly those two divergences. PROBE: the trigger is held fixed per sample, so the only thing
  // that can move the fingerprint between a baseline and a candidate run is the arbitration itself,
  // applied to the cadence this lead actually has stored.
  for (const trigger of [
    "health_recovery_delay",
    "customer_followup_deferral",
    "finance_no_contact",
    "manual_hold_clear"
  ] as const) {
    add(`cadenceRevival:${trigger}`, conv => {
      if (typeof reducer.decideCadenceRevival !== "function") return undefined;
      const decision = reducer.decideCadenceRevival({
        trigger, // PROBE
        hasCadence: Boolean(conv?.followUpCadence),
        cadenceStatus: conv?.followUpCadence?.status ?? null
      });
      return {
        replaceDeadCadence: decision.replaceDeadCadence,
        startFresh: decision.startFresh,
        reactivateInPlace: decision.reactivateInPlace,
        divergence: decision.divergence
      };
    }, ["decideCadenceRevival"]);
  }

  // Added 2026-08-02 with the SOLD-closeout un-stacking. Sampled once WITH a named unit and once
  // WITHOUT, because that is the whole disagreement between the two paths: the appointment-outcome
  // path refuses a sale with no unit, the console endpoint accepts one and leaves the lead's hold
  // standing. PROBE: `hasSoldUnit` and `holdMatchesSoldUnit` are held at fixed values per sample —
  // the matcher needs the live inventory feed, which is not stored state — so the only thing that
  // can move the fingerprint between a baseline and a candidate run is the arbitration itself,
  // applied to the hold this lead actually has stored.
  for (const hasSoldUnit of [true, false] as const) {
    add(`soldCloseout:${hasSoldUnit ? "unit_named" : "no_unit_named"}`, conv => {
      if (typeof reducer.decideSoldCloseout !== "function") return undefined;
      const decision = reducer.decideSoldCloseout({
        hasSoldUnit, // PROBE
        hold: conv?.hold ?? null,
        soldKey: str(conv?.sale?.stockId) ?? str(conv?.sale?.vin) ?? null,
        holdMatchesSoldUnit: false // PROBE — the inventory matcher is not projectable from the store
      });
      return {
        closeConversation: decision.closeConversation,
        closedReason: decision.closedReason,
        releaseHold: decision.releaseHold,
        divergence: decision.divergence
      };
    }, ["decideSoldCloseout"]);
  }

  // Added 2026-08-02 with the appointment-CONFIRM un-stacking. Sampled once PER LANE, because the
  // whole point of this referee is that the slot-match lane answers `acknowledged` and the
  // reschedule latch differently from the two booked lanes — a single sample would hide exactly
  // that. PROBE: the lane is held fixed per sample; the only stored state consulted is the lead's
  // actual reschedulePending latch, so between a baseline and a candidate run only the arbitration
  // itself can move the fingerprint.
  for (const lane of [
    "customer_slot_match",
    "customer_confirm_booking",
    "voice_summary_booking"
  ] as const) {
    add(`appointmentConfirmRecord:${lane}`, conv => {
      if (!conv?.appointment || typeof reducer.decideAppointmentConfirmRecord !== "function") {
        return undefined;
      }
      const decision = reducer.decideAppointmentConfirmRecord({
        lane, // PROBE
        reschedulePending: conv.appointment?.reschedulePending
      });
      return {
        confirm: decision.confirm,
        acknowledged: decision.acknowledged,
        clearReschedulePending: decision.clearReschedulePending,
        divergence: decision.divergence
      };
    }, ["decideAppointmentConfirmRecord"]);
  }

  return registry;
}

export function fingerprintCorpus(
  conversations: any[],
  registry: SampledDecision[],
  clock: FingerprintClock
): FingerprintRun {
  const errors: FingerprintRun["errors"] = [];
  const out: ConversationFingerprint[] = [];
  for (const conv of conversations ?? []) {
    const convId = String(conv?.id ?? "");
    if (!convId) continue;
    const decisions: Record<string, unknown> = {};
    for (const decision of registry) {
      try {
        const value = decision.sample(conv, clock);
        if (value !== undefined) decisions[decision.name] = value;
      } catch (err: any) {
        // Recorded, never swallowed: a projection that throws means this conversation was NOT
        // compared, and the run must not be read as clean.
        errors.push({ convId, decision: decision.name, message: String(err?.message ?? err).slice(0, 200) });
      }
    }
    out.push({ convId, decisions });
  }
  return {
    clock,
    decisionNames: registry.map(d => d.name),
    conversations: out,
    errors
  };
}

export type FingerprintDiff = {
  identical: boolean;
  /** Conversations compared on BOTH sides — the coverage this verdict actually rests on. */
  comparedConversations: number;
  comparedDecisions: number;
  changes: {
    convId: string;
    decision: string;
    before: unknown;
    after: unknown;
  }[];
  /** Reasons the run cannot be trusted at all. Non-empty ⇒ identical is forced false. */
  blockers: string[];
};

const stable = (value: unknown): string => JSON.stringify(value ?? null);

/**
 * Compares two fingerprint runs. `identical: true` means: every decision sampled on both sides
 * agreed, over a non-empty corpus, with no projection errors and no clock drift.
 *
 * Anything that makes the comparison meaningless is a BLOCKER, not a pass. Notably a decision
 * present on one side only is NOT treated as a change (a newly added referee has no baseline) —
 * but a corpus or registry that is empty, a clock mismatch, or any projection error blocks.
 */
export function diffFingerprints(before: FingerprintRun, after: FingerprintRun): FingerprintDiff {
  const blockers: string[] = [];
  if (!before?.conversations?.length || !after?.conversations?.length) {
    blockers.push("one side of the comparison has no conversations — nothing was verified");
  }
  if (!before?.decisionNames?.length || !after?.decisionNames?.length) {
    blockers.push("the decision registry is empty — nothing was sampled");
  }
  if (before?.clock?.nowMs !== after?.clock?.nowMs || before?.clock?.timeZone !== after?.clock?.timeZone) {
    blockers.push("the two runs used different clocks — time-dependent decisions are not comparable");
  }
  for (const run of [before, after]) {
    if (run?.errors?.length) {
      blockers.push(`${run.errors.length} projection error(s) — those conversations were not compared`);
    }
  }

  const afterById = new Map((after?.conversations ?? []).map(c => [c.convId, c]));
  const changes: FingerprintDiff["changes"] = [];
  let comparedConversations = 0;
  let comparedDecisions = 0;

  for (const beforeConv of before?.conversations ?? []) {
    const afterConv = afterById.get(beforeConv.convId);
    if (!afterConv) continue;
    comparedConversations += 1;
    for (const [name, beforeValue] of Object.entries(beforeConv.decisions)) {
      if (!(name in afterConv.decisions)) continue; // decision retired/added — not a behavior change
      comparedDecisions += 1;
      const afterValue = afterConv.decisions[name];
      if (stable(beforeValue) !== stable(afterValue)) {
        changes.push({ convId: beforeConv.convId, decision: name, before: beforeValue, after: afterValue });
      }
    }
  }

  if (comparedDecisions === 0) {
    blockers.push("zero decisions were actually compared — an empty comparison is not a pass");
  }

  return {
    identical: changes.length === 0 && blockers.length === 0,
    comparedConversations,
    comparedDecisions,
    changes,
    blockers
  };
}
