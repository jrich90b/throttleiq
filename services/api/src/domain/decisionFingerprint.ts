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

  // Added 2026-08-04 (Joe — Mark Kocsis +17168609533). Fully projectable: the armed note and the
  // last inbound both live on the stored conversation, so a lead that starts closing itself on the
  // wrong send shows up as a decision DIFF rather than as a lead that quietly left the inbox. The
  // clock is deliberately unused — this referee compares two stored timestamps to each other.
  add("pendingCloseoutOnSend", conv => {
    if (typeof reducer.decidePendingCloseoutOnSend !== "function") return undefined;
    const armedAt = str(conv?.pendingCloseout?.armedAt);
    const lastInbound = [...(Array.isArray(conv?.messages) ? conv.messages : [])]
      .reverse()
      .find((m: any) => str(m?.direction) === "in");
    const lastInboundMs = lastInbound ? Date.parse(str(lastInbound?.at) ?? "") : NaN;
    return reducer.decidePendingCloseoutOnSend({
      armed: !!conv?.pendingCloseout,
      armedAtMs: Date.parse(armedAt ?? ""),
      lastInboundAtMs: Number.isFinite(lastInboundMs) ? lastInboundMs : null,
      alreadyClosed: str(conv?.status) === "closed"
    });
  }, ["decidePendingCloseoutOnSend"]);

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

  // Added 2026-08-04 (Joe: "a pre qual should not create a finance outcome"). Fully projectable —
  // every input is stored conversation state, so a prequal-origin lead that starts nagging the
  // business manager again shows up as a decision DIFF, not just a missing SMS nobody notices.
  add("businessManagerFinanceOutcomePrompt", conv => {
    if (typeof reducer.decideBusinessManagerFinanceOutcomePrompt !== "function") return undefined;
    return reducer.decideBusinessManagerFinanceOutcomePrompt({
      leadCta: conv?.classification?.cta ?? null,
      leadBucket: conv?.classification?.bucket ?? null,
      followUpReason: conv?.followUp?.reason ?? null,
      appointmentType: conv?.appointment?.appointmentType ?? null
    });
  }, ["decideBusinessManagerFinanceOutcomePrompt"]);

  // Added 2026-08-03 with the seller-photo frame fix (Tom +17164454081). Sampled as: given this
  // conversation's stored seller/trade signals, whose bike would we assume a photo shows? Purely a
  // projection of stored state — no turn text, no vision — so it is genuinely sampleable.
  add("customerPhotoShareFrame", conv => {
    if (typeof reducer.decideCustomerPhotoShareFrame !== "function") return undefined;
    return reducer.decideCustomerPhotoShareFrame({
      classificationBucket: conv?.classification?.bucket ?? null,
      classificationCta: conv?.classification?.cta ?? null,
      followUpReason: conv?.followUp?.reason ?? null,
      cadenceContextTag: conv?.followUpCadence?.contextTag ?? null,
      manualContextTag: conv?.manualContext?.contextTag ?? null,
      dialogStateName: conv?.dialogState?.name ?? null,
      leadSource: conv?.lead?.source ?? null,
      leadSellOption: conv?.lead?.sellOption ?? null
    });
  }, ["decideCustomerPhotoShareFrame"]);

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

  // Added 2026-08-03 with the cadence-REPLACEMENT un-stacking (the four sites that mint a whole new
  // `followUpCadence` object over whatever is running). PROBE: the trigger is held fixed per sample
  // and the realign lane's non-cadence inputs are read off the lead, so the only thing that can move
  // a fingerprint between baseline and candidate is the arbitration applied to this lead's own
  // stored chase. The three non-realign lanes ignore every realign input, so passing them is inert.
  for (const trigger of [
    "finance_declined",
    "license_credit_pending",
    "seller_photo_details_request",
    "over_eager_engaged_realign"
  ] as const) {
    add(`cadenceReplacement:${trigger}`, conv => {
      if (typeof reducer.decideCadenceReplacement !== "function") return undefined;
      const decision = reducer.decideCadenceReplacement({
        trigger, // PROBE
        existing: conv?.followUpCadence
          ? { status: conv.followUpCadence.status, kind: conv.followUpCadence.kind }
          : null,
        // PROBE: held TRUE so the realign lane's REMAINING gates are what vary per lead. The
        // predicate itself (`cadenceTempoCappedToLongTerm`) is pinned by cadence_tempo_timeframe_cap.
        tempoCappedToLongTerm: true,
        conversationClosed: Boolean(conv?.closedAt || conv?.closedReason || (conv as any)?.sale?.soldAt),
        appointmentBooked: Boolean(conv?.appointment?.bookedEventId),
        followUpMode: conv?.followUp?.mode ?? null,
        followUpReason: conv?.followUp?.reason ?? null,
        hasInventoryWatch: Boolean(conv?.inventoryWatch)
      });
      return {
        replace: decision.replace,
        kind: decision.kind ?? null,
        ladder: decision.ladder ?? null,
        anchor: decision.anchor ?? null,
        writeInviteBudget: decision.writeInviteBudget ?? null,
        writeContextTag: decision.writeContextTag ?? null,
        divergence: decision.divergence
      };
    }, ["decideCadenceReplacement"]);
  }

  // Added 2026-08-03 with the appointment-ATTRIBUTION un-stacking. PROBE: the `explicit` lane is
  // sampled with a FIXED supplied attribution (the record a booking path hands in is a turn input,
  // not stored state), so what varies per lead is only whether an attribution is already on file —
  // which is the divergence that lane owns. The `inferred` lane reads entirely off stored state.
  for (const lane of ["explicit", "inferred"] as const) {
    add(`appointmentAttribution:${lane}`, conv => {
      if (typeof reducer.decideAppointmentAttribution !== "function") return undefined;
      const decision = reducer.decideAppointmentAttribution({
        lane, // PROBE
        hasAppointment: Boolean(conv?.appointment),
        hasExistingAttribution: Boolean(conv?.appointment?.bookedBy),
        // PROBE: fixed, documented turn input — see the note above.
        supplied: lane === "explicit" ? { actor: "human", channel: "manual" } : null,
        confirmedBy: conv?.appointment?.confirmedBy ?? null
      });
      return {
        write: decision.write,
        actor: decision.bookedBy?.actor ?? null,
        channel: decision.bookedBy?.channel ?? null,
        inferred: decision.bookedBy?.inferred ?? null,
        divergence: decision.divergence
      };
    }, ["decideAppointmentAttribution"]);
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

  // Added 2026-08-03 with the LEAD-closeout un-stacking (the sibling of the block above: that one
  // answers "does the unit hold come off", this one "what does closing itself entail"). Sampled
  // once PER LANE, because the lanes are the whole disagreement — the generic close pauses the
  // lead's active inventory watches at write time and the appointment-outcome sold lane does not.
  // PROBE: the lane is held fixed per sample (it is a property of the CALL SITE, not of stored
  // state); the reason is projected from what this lead actually has stored, so between a baseline
  // and a candidate run only the arbitration itself can move the fingerprint.
  for (const lane of ["generic_close", "appointment_outcome_sold"] as const) {
    add(`leadCloseout:${lane}`, conv => {
      if (typeof reducer.decideLeadCloseout !== "function") return undefined;
      const decision = reducer.decideLeadCloseout({
        lane, // PROBE
        reason: str(conv?.closedReason) ?? undefined
      });
      return {
        closedReason: decision.closedReason ?? null,
        pauseActiveWatches: decision.pauseActiveWatches,
        divergence: decision.divergence
      };
    }, ["decideLeadCloseout"]);
  }

  // Added 2026-08-03 with the inventory-HOLD-RECORD un-stacking (the INVERSE of the availability
  // reopen below: that one only ever CLEARS a hold, this one is the two places that WRITE one).
  // Sampled once PER LANE, because the lanes are the disagreement — the appointment-outcome lane
  // forces `paused_indefinite` unconditionally while the console lane spares a thread a human owns
  // or a watch was just armed on.
  // PROBE: the lane, the hold key/on-order flag and the clock are held fixed (all are properties of
  // the CALL SITE, not of stored state); `watchApplied` is pinned false so the ONLY stored input is
  // the lead's actual follow-up mode plus the createdAt already on its hold. So between a baseline
  // and a candidate run only the arbitration itself can move the fingerprint.
  for (const lane of ["appointment_outcome", "console_resolution"] as const) {
    add(`inventoryHoldRecord:${lane}`, conv => {
      if (!conv || typeof reducer.decideInventoryHoldRecord !== "function") return undefined;
      const decision = reducer.decideInventoryHoldRecord({
        lane, // PROBE
        holdKey: "probe-hold-key", // PROBE
        onOrder: false, // PROBE
        unit: { stockId: "PROBE-1" }, // PROBE
        nowIso: "2026-01-01T00:00:00.000Z", // PROBE
        watchApplied: false, // PROBE
        existingCreatedAt: str(conv?.hold?.createdAt) ?? undefined,
        currentFollowUpMode: str(conv?.followUp?.mode) ?? undefined
      });
      return {
        reason: decision.reason,
        setPausedIndefinite: decision.setPausedIndefinite,
        recordKey: decision.record.key ?? null,
        createdAt: decision.record.createdAt,
        divergence: decision.divergence
      };
    }, ["decideInventoryHoldRecord"]);
  }

  // Added 2026-08-03 with the SCHEDULE-INVITE-BUDGET un-stacking. Not lane-sampled: there is one
  // question ("have we asked this lead to come in too many times?") and the only input that varies
  // is the lead's own stored count. PROBE: the threshold is left to the referee's default, so a
  // change to the budget itself moves this fingerprint — which is the drift the un-stacking exists
  // to catch.
  add("scheduleInviteBudget", conv => {
    if (!conv?.followUpCadence || typeof reducer.decideScheduleInviteBudget !== "function") {
      return undefined;
    }
    const decision = reducer.decideScheduleInviteBudget({
      inviteCount: conv.followUpCadence?.scheduleInviteCount
    });
    return {
      threshold: decision.threshold,
      nextInviteCount: decision.nextInviteCount,
      spent: decision.spent,
      mute: decision.mute
    };
  }, ["decideScheduleInviteBudget"]);

  // Added 2026-08-04 with the inventory-watch ARM un-stacking. Sampled once PER LANE: the whole
  // point of this referee is that the console and email lanes take a DIFFERENT dialog-state route
  // from the other four, and a single sample would hide exactly that. PROBE: the lane is held fixed
  // per sample and `watchCount` is pinned to 1 (arming is a property of the CALL SITE, not of
  // stored state), so the referee consults nothing but its own arbitration — which is what this
  // fingerprint exists to freeze.
  for (const lane of [
    "voice_summary",
    "context_note",
    "watch_confirmation",
    "console_watch_set",
    "console_hold_resolution",
    "held_unit_guard",
    "manual_outbound",
    "email_inbound",
    "email_walk_in",
    "email_adf_unavailable"
  ] as const) {
    add(`inventoryWatchArm:${lane}`, () => {
      if (typeof reducer.decideInventoryWatchArm !== "function") return undefined;
      const decision = reducer.decideInventoryWatchArm({ lane, watchCount: 1 }); // PROBE
      return {
        arm: decision.arm,
        clearPending: decision.clearPending,
        dialogRoute: decision.dialogRoute,
        reversesWatchOptOut: decision.reversesWatchOptOut,
        followUpMode: decision.followUpMode,
        stopCadenceReason: decision.stopCadenceReason,
        divergence: decision.divergence
      };
    }, ["decideInventoryWatchArm"]);
  }

  // Added 2026-08-04 with the inventory-watch DISARM un-stacking (the inverse of the arm referee
  // above). Sampled once PER LANE for the same reason: the four lanes disagree about the shape of
  // an emptied list, about the pending ask, and about the singular mirror, and one sample would
  // hide all three. PROBE: the lane is held fixed per sample and `remainingCount` is pinned to 0 —
  // the boundary both "when empty" rules turn on — so the referee consults nothing but its own
  // arbitration.
  for (const lane of ["customer_stop", "held_guard_heal", "model_prune", "vin_normalize"] as const) {
    add(`inventoryWatchDisarm:${lane}`, () => {
      if (typeof reducer.decideInventoryWatchDisarm !== "function") return undefined;
      const decision = reducer.decideInventoryWatchDisarm({ lane, remainingCount: 0 }); // PROBE
      return {
        emptyListShape: decision.emptyListShape,
        mirrorRule: decision.mirrorRule,
        clearPending: decision.clearPending,
        followUpMode: decision.followUpMode,
        stopCadence: decision.stopCadence,
        stepDialogBack: decision.stepDialogBack,
        divergence: decision.divergence
      };
    }, ["decideInventoryWatchDisarm"]);
  }

  // Added 2026-08-04 with the finance-outcome-notify un-stacking. Sampled once PER LANE because
  // the eight lanes are exactly where the three preserved divergences live — the two "pending"
  // lanes write different records, the two "resolved" lanes stamp different clocks, and
  // `notify_sent` alone skips `updatedAt`. A single sample would hide all three. PROBE: the lane
  // and both status inputs are pinned per sample, so the referee consults nothing but its own
  // arbitration — it reads no stored state at all.
  for (const lane of [
    "token_mint",
    "outcome_signal",
    "prompt_sent",
    "notify_sent",
    "public_link_pending",
    "public_link_resolved",
    "staff_sms_pending",
    "staff_sms_resolved"
  ] as const) {
    add(`financeOutcomeNotify:${lane}`, () => {
      if (typeof reducer.decideFinanceOutcomeNotifyState !== "function") return undefined;
      // PROBE: fixed inputs; `declined` exercises both status-carrying lanes' branch.
      const decision = reducer.decideFinanceOutcomeNotifyState({
        lane,
        outcomeStatus: "declined",
        sentStatus: "declined"
      });
      return {
        mintToken: decision.mintToken,
        status: decision.status,
        stampPendingAt: decision.stampPendingAt,
        answerStamp: decision.answerStamp,
        stampPromptSent: decision.stampPromptSent,
        sentLatch: decision.sentLatch,
        touchUpdatedAt: decision.touchUpdatedAt,
        divergence: decision.divergence
      };
    }, ["decideFinanceOutcomeNotifyState"]);
  }

  // Added 2026-08-04 with the appointment-PROMPT un-stacking. Sampled once PER LANE, and the
  // confirmation ANSWER lane twice, because the yes/no branch is the only input the referee reads:
  // one sample would hide the confirmed/declined split. PROBE: lane and answer are pinned, so the
  // referee consults nothing but its own arbitration — it reads no stored state at all.
  for (const probe of [
    { name: "reminder_sent", lane: "confirmation_reminder_sent", answer: null },
    { name: "answer_yes", lane: "confirmation_answer", answer: "yes" },
    { name: "answer_no", lane: "confirmation_answer", answer: "no" },
    { name: "attendance_asked", lane: "attendance_question_asked", answer: null }
  ] as const) {
    add(`appointmentPromptRecord:${probe.name}`, () => {
      if (typeof reducer.decideAppointmentPromptRecord !== "function") return undefined;
      const decision = reducer.decideAppointmentPromptRecord({
        lane: probe.lane,
        answer: probe.answer
      }); // PROBE
      return {
        confirmationStatus: decision.confirmationStatus,
        stampSentAt: decision.stampSentAt,
        stampRespondedAt: decision.stampRespondedAt,
        preserveExistingConfirmation: decision.preserveExistingConfirmation,
        carryTriggerMeta: decision.carryTriggerMeta,
        stampAttendanceQuestionedAt: decision.stampAttendanceQuestionedAt,
        divergence: decision.divergence
      };
    }, ["decideAppointmentPromptRecord"]);
  }

  // Added 2026-08-04 with the watch-EXACTNESS un-stacking. Sampled once per RULE PAIR, because the
  // two flags ARE the two preserved divergences: seven lanes do not recognise a year range, and
  // two do not count a trim as distinguishing. PROBE: the watch inputs are pinned at the value that
  // exercises every rung (a year, a year range, and a trim but no colour), so only the arbitration
  // can move the fingerprint.
  for (const rule of [
    { name: "range_trim", recognisesYearRange: true, trimCountsAsDistinguishing: true },
    { name: "range_colour", recognisesYearRange: true, trimCountsAsDistinguishing: false },
    { name: "norange_trim", recognisesYearRange: false, trimCountsAsDistinguishing: true },
    { name: "norange_colour", recognisesYearRange: false, trimCountsAsDistinguishing: false }
  ] as const) {
    add(`inventoryWatchExactness:${rule.name}`, () => {
      if (typeof reducer.resolveInventoryWatchExactness !== "function") return undefined;
      const decision = reducer.resolveInventoryWatchExactness({
        year: 2023,
        yearMin: 2020,
        yearMax: 2024,
        color: null,
        trim: "CVO",
        recognisesYearRange: rule.recognisesYearRange,
        trimCountsAsDistinguishing: rule.trimCountsAsDistinguishing
      }); // PROBE
      return { exactness: decision.exactness, divergence: decision.divergence };
    }, ["resolveInventoryWatchExactness"]);
  }

  // Added 2026-08-04 with the watch-LIST normalization un-stacking. Sampled at the three record
  // shapes that matter — a populated list, an ABSENT list with a legacy singular (the heal), and an
  // explicitly EMPTY list with a singular (the deliberate non-heal, so a disarmed lead is not
  // resurrected). PROBE: the shape is pinned per sample.
  for (const shape of [
    { name: "populated_list", listLength: 2, hasSingular: true },
    { name: "absent_list_legacy_singular", listLength: null, hasSingular: true },
    { name: "empty_list_stale_singular", listLength: 0, hasSingular: true }
  ] as const) {
    add(`inventoryWatchListNormalization:${shape.name}`, () => {
      if (typeof reducer.resolveInventoryWatchListNormalization !== "function") return undefined;
      const decision = reducer.resolveInventoryWatchListNormalization({
        listLength: shape.listLength,
        hasSingular: shape.hasSingular
      }); // PROBE
      return { source: decision.source, backfillListFromSingular: decision.backfillListFromSingular };
    }, ["resolveInventoryWatchListNormalization"]);
  }

  // Added 2026-08-04 with the pending-inventory-watch-clear un-stacking. Sampled at the states
  // that decide the question: the two KEEP-guards that the second writer used to ignore
  // (`holding_inventory` mode, a follow-up reason that IS the watch), a same-turn watch intent,
  // the department context shift that both writers agreed on, and the parser's explicit clear.
  // PROBE: every input is pinned per sample; the referee reads no stored state of its own.
  for (const state of [
    { name: "department_shift_plain", mode: "active", reason: "none", watch: false, dept: true, parser: false },
    { name: "department_shift_holding_inventory", mode: "holding_inventory", reason: "none", watch: false, dept: true, parser: false },
    { name: "department_shift_watch_reason", mode: "active", reason: "inventory_watch_followup", watch: false, dept: true, parser: false },
    { name: "department_shift_same_turn_watch_intent", mode: "active", reason: "none", watch: true, dept: true, parser: false },
    { name: "parser_clear_signal", mode: "active", reason: "none", watch: false, dept: false, parser: true },
    { name: "parser_clear_signal_watch_reason", mode: "active", reason: "inventory_watch_followup", watch: false, dept: false, parser: true }
  ] as const) {
    add(`inventoryWatchPendingClear:${state.name}`, () => {
      if (typeof reducer.resolveInventoryWatchPendingClear !== "function") return undefined;
      const decision = reducer.resolveInventoryWatchPendingClear({
        followUpMode: state.mode,
        followUpReason: state.reason,
        dialogState: "inventory_watch_prompted",
        hasInventoryWatchPending: true,
        inventoryWatchPendingAgeHours: 1,
        hasWatchIntent: state.watch,
        hasDepartmentIntent: state.dept,
        parserRequestedClear: state.parser
      }); // PROBE
      return {
        clearInventoryWatchPending: decision.clearInventoryWatchPending,
        clearInventoryWatchPrompt: decision.clearInventoryWatchPrompt
      };
    }, ["resolveInventoryWatchPendingClear"]);
  }

  // Added 2026-08-04 with the voicemail follow-up-task un-stacking (operator report +15416478489:
  // "there is a watch on this. it should not have a task"). Sampled once PER LANE and once for the
  // watch-parked shape, because the whole point of the referee is that ONLY the generic outbound
  // lane parks — a single sample would hide exactly that. PROBE: `hasOpenFollowUpTask:false` is
  // held fixed so the sample reads the park arbitration rather than the duplicate check.
  for (const lane of ["inbound_voicemail", "outbound_finance_handoff", "outbound_generic"] as const) {
    for (const parked of [false, true]) {
      add(`voicemailFollowUpTask:${lane}:${parked ? "watch_parked" : "plain"}`, () => {
        if (typeof reducer.decideVoicemailFollowUpTask !== "function") return undefined;
        const decision = reducer.decideVoicemailFollowUpTask({
          lane,
          hasOpenFollowUpTask: false, // PROBE
          activeInventoryWatchCount: parked ? 1 : 0, // PROBE
          followUpMode: parked ? "holding_inventory" : "active", // PROBE
          followUpReason: parked ? "inventory_watch" : "engaged" // PROBE
        });
        return { create: decision.create, reason: decision.reason };
      }, ["decideVoicemailFollowUpTask"]);
    }
  }

  // Added 2026-08-02 with the appointment-CONFIRM un-stacking. Sampled once PER LANE, because the
  // whole point of this referee is that the slot-match lane answers `acknowledged` and the
  // reschedule latch differently from the two booked lanes — a single sample would hide exactly
  // that. PROBE: the lane is held fixed per sample; the only stored state consulted is the lead's
  // actual reschedulePending latch, so between a baseline and a candidate run only the arbitration
  // itself can move the fingerprint.
  // 2026-08-04: the two STAFF lanes joined the table (divergences 3 and 4). `salesperson_manual_send`
  // is the first lane that consults the STORED status/acknowledged rather than only the latch, so
  // those are passed through from the lead as-is — the probe still holds the lane fixed.
  for (const lane of [
    "customer_slot_match",
    "customer_confirm_booking",
    "voice_summary_booking",
    "salesperson_manual_booking",
    "salesperson_manual_send"
  ] as const) {
    add(`appointmentConfirmRecord:${lane}`, conv => {
      if (!conv?.appointment || typeof reducer.decideAppointmentConfirmRecord !== "function") {
        return undefined;
      }
      const decision = reducer.decideAppointmentConfirmRecord({
        lane, // PROBE
        currentStatus: conv.appointment?.status ?? null,
        currentAcknowledged: conv.appointment?.acknowledged ?? null,
        reschedulePending: conv.appointment?.reschedulePending
      });
      return {
        confirm: decision.confirm,
        acknowledged: decision.acknowledged,
        // NOT in the fingerprint on purpose: adding a field to the payload reads as 183 changed
        // decisions in the equivalence diff while every value is identical, which buries a real
        // change in noise. `confirmedBy` is pinned behaviourally in appointment_confirm_record:eval.
        clearReschedulePending: decision.clearReschedulePending,
        divergence: decision.divergence
      };
    }, ["decideAppointmentConfirmRecord"]);
  }

  // Added 2026-08-02 with the booking-ENDPOINT un-stacking (the sibling of the block above: those
  // are conversation turns, these are the three HTTP endpoints that book a real calendar event).
  // Sampled once PER LANE, because the whole point of this referee is that the staff console lane
  // clears the reschedule latch and records the matched slot while the two customer lanes do
  // neither — a single sample would hide exactly that. PROBE: the lane is held fixed per sample and
  // the only stored state consulted is the lead's actual reschedulePending latch, so between a
  // baseline and a candidate run only the arbitration itself can move the fingerprint.
  for (const lane of [
    "scheduler_widget_booking",
    "public_link_booking",
    "staff_console_booking"
  ] as const) {
    add(`appointmentBookingRecord:${lane}`, conv => {
      if (!conv?.appointment || typeof reducer.decideAppointmentBookingRecord !== "function") {
        return undefined;
      }
      const decision = reducer.decideAppointmentBookingRecord({
        lane, // PROBE
        reschedulePending: conv.appointment?.reschedulePending,
        // PROBE, fixed true: `divergence` only names the matched-slot gap when there IS a slot to
        // record, so holding this at true keeps that field live in the fingerprint. It is a
        // caller-side fact, never stored state, so pinning it changes nothing about what varies.
        hasMatchedSlot: true
      });
      return {
        record: decision.record,
        confirmedBy: decision.confirmedBy,
        acknowledged: decision.acknowledged,
        clearReschedulePending: decision.clearReschedulePending,
        recordMatchedSlot: decision.recordMatchedSlot,
        divergence: decision.divergence
      };
    }, ["decideAppointmentBookingRecord"]);
  }

  // Added 2026-08-04 with the two remaining calendar-write lanes (the manual-outbound send that
  // books a texted time, and the staff calendar edit). Kept as SEPARATE samples with their own
  // projection rather than widening the three above: a widened projection would read as a decision
  // CHANGE on every lead and drown the very signal this harness exists to show. The extra fields
  // are the four "does this lane stamp it at all" switches — the divergences these two preserve.
  // PROBE: lane and hasMatchedSlot are held fixed; hasBookedTime is sampled BOTH ways because it is
  // the only input that can move the edit lane's answer.
  for (const lane of ["manual_outbound_schedule_booking", "staff_calendar_edit"] as const) {
    for (const hasBookedTime of [true, false] as const) {
      add(`appointmentBookingRecord:${lane}:${hasBookedTime ? "timed" : "untimed"}`, conv => {
        if (!conv?.appointment || typeof reducer.decideAppointmentBookingRecord !== "function") {
          return undefined;
        }
        const decision = reducer.decideAppointmentBookingRecord({
          lane, // PROBE
          reschedulePending: conv.appointment?.reschedulePending,
          hasMatchedSlot: true, // PROBE — caller-side, never stored state
          hasBookedTime // PROBE
        });
        return {
          record: decision.record,
          stampBookedTime: decision.stampBookedTime,
          stampConfirmedBy: decision.stampConfirmedBy,
          stampAcknowledged: decision.stampAcknowledged,
          stampBookedEvent: decision.stampBookedEvent,
          clearReschedulePending: decision.clearReschedulePending,
          recordMatchedSlot: decision.recordMatchedSlot,
          divergence: decision.divergence
        };
      }, ["decideAppointmentBookingRecord"]);
    }
  }

  // Sampled once PER LANE, because the whole disagreement this referee owns is between lanes: the
  // customer-speech lane may mint an appointment record to latch on and the two staff-inference
  // lanes may not, so a single sample would hide exactly that. PROBE: the lane is held fixed per
  // sample; the only stored state consulted is whether the lead has an appointment record and what
  // the latch currently says, so between a baseline and a candidate run only the arbitration itself
  // can move the fingerprint. Note this registry entry deliberately does NOT early-return on a
  // missing `conv.appointment` — "no record" is the input the divergence turns on.
  for (const lane of [
    "appointment_outcome_reschedule_draft",
    "staff_context_note",
    "customer_inbound_cancel_reschedule"
  ] as const) {
    add(`reschedulePendingLatch:${lane}`, conv => {
      if (!conv || typeof reducer.decideReschedulePendingLatch !== "function") return undefined;
      const decision = reducer.decideReschedulePendingLatch({
        lane, // PROBE
        hasAppointmentRecord: !!conv.appointment,
        reschedulePending: conv.appointment?.reschedulePending ?? null
      });
      return {
        arm: decision.arm,
        createRecordIfAbsent: decision.createRecordIfAbsent,
        divergence: decision.divergence
      };
    }, ["decideReschedulePendingLatch"]);
  }

  // Sampled once PER CAUSE. The whole question is whether a lead we CLOSED against a bike comes back
  // open, and the three causes answer it differently on the same lead — so one sample would hide the
  // divergences the un-stacking preserved. PROBE: the cause is held fixed per sample; everything else
  // is the lead's real stored closedReason / follow-up reason / cadence kind, which is exactly what
  // the two `closedReason` matchers disagree about.
  for (const cause of ["hold_released", "sale_reversed", "hold_superseded_by_sale"] as const) {
    add(`inventoryAvailabilityReopen:${cause}`, conv => {
      if (!conv || typeof reducer.decideInventoryAvailabilityReopen !== "function") return undefined;
      const decision = reducer.decideInventoryAvailabilityReopen({
        cause, // PROBE
        closedReason: conv.closedReason ?? null,
        followUpReason: conv.followUp?.reason ?? null,
        cadenceKind: conv.followUpCadence?.kind ?? null
      });
      return {
        clearRecord: decision.clearRecord,
        reopen: decision.reopen,
        stopCadence: decision.stopCadence,
        resumeFollowUp: decision.resumeFollowUp,
        divergence: decision.divergence
      };
    }, ["decideInventoryAvailabilityReopen"]);
  }

  // Sampled once per (cause × customer-arm switch), same reasoning as above: the four reopen causes
  // answer this differently on the SAME lead, so one sample would hide the divergences the
  // un-stacking preserved. PROBE: the cause, `bareAck` and `declineCloseoutReason` are held fixed
  // per sample — `bareAck` is the switch the sticky rules turn on, and the decline vocabulary test
  // only matters when it is true. Everything else is the lead's real stored closeout state
  // (`status`, `closedReason`, `followUp.reason`, `sale.soldAt`, `hold`), which is exactly what the
  // arms disagree about. `isClosed` is NOT probed: it is stored state.
  const CLOSEOUT_REVERSAL_PROBES = [
    { cause: "customer_inbound", bareAck: false, decline: false },
    { cause: "customer_inbound", bareAck: true, decline: false },
    { cause: "customer_inbound", bareAck: true, decline: true },
    { cause: "staff_reopen", bareAck: false, decline: false },
    { cause: "walkin_hold_note", bareAck: false, decline: false },
    { cause: "walkin_hold_clear", bareAck: false, decline: false }
  ] as const;
  for (const probe of CLOSEOUT_REVERSAL_PROBES) {
    const label =
      probe.cause === "customer_inbound"
        ? `${probe.cause}:ack=${probe.bareAck}:decline=${probe.decline}`
        : probe.cause;
    add(`closeoutReversal:${label}`, conv => {
      if (!conv || typeof reducer.decideCloseoutReversal !== "function") return undefined;
      const decision = reducer.decideCloseoutReversal({
        cause: probe.cause, // PROBE
        isClosed: conv.status === "closed",
        closedReason: conv.closedReason ?? null,
        followUpReason: conv.followUp?.reason ?? null,
        hasSoldSale: !!conv.sale?.soldAt,
        hasHoldRecord: !!conv.hold,
        bareAck: probe.bareAck, // PROBE
        declineCloseoutReason: probe.decline // PROBE
      });
      return {
        reopen: decision.reopen,
        clearCloseout: decision.clearCloseout,
        divergence: decision.divergence
      };
    }, ["decideCloseoutReversal"]);
  }

  // Sampled once per (verb x reason class). The four verbs answer this differently on the SAME lead,
  // and `stop`'s post-sale protection turns on the REASON, so a single reason would hide divergence
  // 1 entirely. PROBE: verb and reason are held fixed per sample; `hasRecord`, `status` and `kind`
  // are the lead's real stored chase, which is what the verbs disagree about.
  const CADENCE_LIFECYCLE_PROBES = [
    { verb: "stop", reason: "manual_handoff" },
    { verb: "stop", reason: "opt_out" },
    { verb: "pause", reason: "manual_outbound" },
    { verb: "resume", reason: "" },
    { verb: "close", reason: "not_interested" }
  ] as const;
  for (const probe of CADENCE_LIFECYCLE_PROBES) {
    add(`cadenceLifecycle:${probe.verb}${probe.reason ? `:${probe.reason}` : ""}`, conv => {
      if (!conv || typeof reducer.decideCadenceLifecycle !== "function") return undefined;
      const decision = reducer.decideCadenceLifecycle({
        verb: probe.verb, // PROBE
        hasRecord: !!conv.followUpCadence,
        status: conv.followUpCadence?.status ?? null,
        kind: conv.followUpCadence?.kind ?? null,
        reason: probe.reason // PROBE
      });
      return {
        apply: decision.apply,
        nextStatus: decision.nextStatus,
        clearNextDue: decision.clearNextDue,
        clearPause: decision.clearPause,
        clearStopReason: decision.clearStopReason,
        divergence: decision.divergence
      };
    }, ["decideCadenceLifecycle"]);
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
