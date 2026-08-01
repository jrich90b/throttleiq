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
export function buildDecisionRegistry(reducer: any): SampledDecision[] {
  const registry: SampledDecision[] = [];

  const add = (name: string, fn: SampledDecision["sample"]) => {
    // A referee that has not shipped yet simply is not sampled — that is correct on the BASELINE
    // side of a comparison, where the new function does not exist. It must never throw.
    registry.push({ name, sample: fn });
  };

  add("staleBookedAppointmentDay", (conv, clock) => {
    const whenIso = str(conv?.appointment?.whenIso);
    if (!whenIso || typeof reducer.isStaleBookedAppointmentDay !== "function") return undefined;
    return reducer.isStaleBookedAppointmentDay({ whenIso, nowMs: clock.nowMs, timeZone: clock.timeZone });
  });

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
  });

  add("staleSoldAnnouncement", (conv, clock) => {
    const soldAtIso = str(conv?.sale?.soldAt);
    if (!soldAtIso || typeof reducer.isStaleSoldAnnouncement !== "function") return undefined;
    return reducer.isStaleSoldAnnouncement({ soldAtIso, nowMs: clock.nowMs });
  });

  add("internationalLeadPhone", conv => {
    const phone = str(conv?.lead?.phone) ?? str(conv?.id);
    if (!phone || typeof reducer.isInternationalLeadPhone !== "function") return undefined;
    return reducer.isInternationalLeadPhone(phone);
  });

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
  });

  // Added 2026-08-01 with the draftHeld un-stacking. Sampled as: given this conversation's CURRENT
  // hold, would a real reply release it? That is the question the six former clear-sites disagreed on.
  add("heldDraftReleaseOnRealReply", conv => {
    const held = conv?.draftHeld;
    if (!held || typeof reducer.decideHeldDraftRelease !== "function") return undefined;
    return reducer.decideHeldDraftRelease({
      heldKind: held.heldKind ?? held.reason,
      event: "real_reply"
    });
  });

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
    });
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
