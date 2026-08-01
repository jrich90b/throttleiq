/**
 * Agent correction rate — how often staff have to CORRECT the agent, as opposed to simply taking
 * the conversation over or knowing something the agent could not.
 *
 * Joe, 2026-08-01: "track how often the user needs to change a reply when it's not a true turn
 * over — to see how often the user has to correct the agent." That qualifier is the whole design.
 * A raw edit count is a misleading number, and we have already been burned by treating it as one:
 * [[staff-draft-edit-corpus]] records the 7/29 misreading (239 "replaced" drafts read as agent
 * failures) and [[answer-dont-deflect-program]] measured that ~57% of takeovers replaced a draft
 * that was FINE. A staff edit is a weak wrongness signal until you subtract the reasons that have
 * nothing to do with the agent being wrong.
 *
 * Four things can produce a staff edit. Only the last one is a correction:
 *
 *   1. TURNOVER      the thread was already handed to a person. Them writing the reply is the
 *                    system working, not failing. (Joe's explicit exclusion.)
 *   2. OUT_OF_BAND   the human knew something the agent had no way to know — "I'm taking a
 *                    pre-owned 2016 in next week", "I have to leave at 5", "it's an out-of-state
 *                    sale so no NYS tax". The agent was uninformed, not wrong. Live example
 *                    (+17164792868, 90-day window): the draft said "I'm not seeing one available"
 *                    and staff replaced it with an incoming trade nobody had entered yet.
 *   3. COSMETIC      voice, length, formatting. "Glenn Wakefield" -> "Glenn". Not a correction.
 *   4. CORRECTION    the agent had what it needed and still got it wrong. THIS is the number.
 *
 * FAIL DIRECTION — the most important rule here. This metric exists to tell Joe whether the agent
 * is good enough to sell to another dealer. A metric that FLATTERS the agent is worse than no
 * metric: it would say "ready" when it is not. So every ambiguity resolves TOWARD counting a
 * correction, and anything we genuinely cannot classify is reported as `unclassified` — never
 * silently folded into either side, never quietly dropped from the denominator.
 *
 * Deterministic and legal under AGENTS.md rule 2: this reads RECORDED STATE (the handoff mode and
 * the judge's verdict) and computes a metric. It reads no customer text and steers no reply. The
 * one genuinely comprehension-shaped question — "could the agent have known this?" — is answered
 * by the typed draft-edit judge (classifyDraftEditWithLLM), never by keyword rules here.
 */

export type CorrectionBucket =
  | "turnover"
  | "out_of_band"
  | "cosmetic"
  | "correction"
  | "unclassified";

export type DraftEditInput = {
  /** ISO time the edited reply was SENT. */
  sentAt?: string | null;
  /** `followUp.mode` on the thread, and when it was last set. */
  followUpMode?: string | null;
  followUpModeUpdatedAt?: string | null;
  /**
   * The draft-edit judge's verdict, when one exists.
   * `isMaterial === false` => cosmetic. Absent entirely => unclassified (pre-judge history).
   */
  judge?: {
    isMaterial?: boolean | null;
    /**
     * Did the agent have access to what the human added? `false` => out-of-band knowledge.
     * Absent/null => unknown, and unknown must NOT excuse the agent (fail direction).
     */
    agentCouldHaveKnown?: boolean | null;
    category?: string | null;
    confidence?: number | null;
  } | null;
};

export type DraftEditBucketing = {
  bucket: CorrectionBucket;
  /** Why it landed in that bucket — kept short and stable so the report and eval can key on it. */
  reason: string;
};

/** Modes that mean a human owns this conversation now. */
const HANDED_OVER_MODES = new Set(["manual_handoff", "human", "takeover"]);

function parseMs(value: string | null | undefined): number {
  const ms = Date.parse(String(value ?? ""));
  return Number.isFinite(ms) ? ms : NaN;
}

/**
 * Was the thread already handed to a person when this reply went out?
 *
 * The handoff must PREDATE the send. A thread handed off later does not retroactively excuse an
 * earlier bad draft — reading only the CURRENT mode would do exactly that, and would excuse more
 * and more edits as threads accumulate handoffs over time.
 *
 * A handoff mode with NO timestamp cannot be proven to predate the send, so it does not count as
 * turnover (fail direction: don't excuse the agent on unprovable grounds).
 */
export function wasHandedOverBeforeSend(input: DraftEditInput): boolean {
  const mode = String(input.followUpMode ?? "").trim().toLowerCase();
  if (!HANDED_OVER_MODES.has(mode)) return false;
  const handedMs = parseMs(input.followUpModeUpdatedAt);
  const sentMs = parseMs(input.sentAt);
  if (!Number.isFinite(handedMs) || !Number.isFinite(sentMs)) return false;
  return handedMs <= sentMs;
}

/**
 * Buckets ONE staff edit of an AI draft. Order matters and encodes the fail direction:
 * turnover (structural, provable) -> cosmetic (judge says no substance changed) ->
 * out_of_band (judge AFFIRMATIVELY says the agent could not have known) -> correction.
 */
export function bucketDraftEdit(input: DraftEditInput): DraftEditBucketing {
  if (wasHandedOverBeforeSend(input)) {
    return { bucket: "turnover", reason: "thread was handed to a person before this reply went out" };
  }

  const judge = input.judge ?? null;
  // No verdict at all = pre-judge history. Report it, never guess at it.
  if (!judge || judge.isMaterial === null || judge.isMaterial === undefined) {
    return { bucket: "unclassified", reason: "no draft-edit judge verdict on record" };
  }

  if (judge.isMaterial === false) {
    return { bucket: "cosmetic", reason: "judge: wording/length only, no substance changed" };
  }

  // ONLY an affirmative `false` excuses the agent. Unknown/null stays a correction on purpose.
  if (judge.agentCouldHaveKnown === false) {
    return {
      bucket: "out_of_band",
      reason: "judge: the human added something the agent had no way to know"
    };
  }

  return {
    bucket: "correction",
    reason: judge.category ? `material correction (${judge.category})` : "material correction"
  };
}

export type CorrectionRateTotals = {
  /** Every staff edit considered. */
  edits: number;
  turnover: number;
  outOfBand: number;
  cosmetic: number;
  corrections: number;
  unclassified: number;
  /**
   * Drafts where the agent OWNED the thread and we could classify the edit — the honest
   * denominator for the headline rate.
   */
  attributable: number;
  /**
   * corrections / attributable, 0..1. `null` when nothing is attributable — an unmeasured rate
   * must read as "not yet measured", never as a flattering 0%.
   */
  correctionRate: number | null;
};

export function summarizeCorrectionBuckets(buckets: CorrectionBucket[]): CorrectionRateTotals {
  const count = (b: CorrectionBucket) => buckets.filter(x => x === b).length;
  const corrections = count("correction");
  const outOfBand = count("out_of_band");
  const cosmetic = count("cosmetic");
  const attributable = corrections + outOfBand + cosmetic;
  return {
    edits: buckets.length,
    turnover: count("turnover"),
    outOfBand,
    cosmetic,
    corrections,
    unclassified: count("unclassified"),
    attributable,
    correctionRate: attributable > 0 ? corrections / attributable : null
  };
}

/**
 * How much of the window we could actually classify, 0..1. The report prints this next to the
 * rate: a 4% correction rate computed over 8% of the edits is not a 4% correction rate, and the
 * number must never be quotable without it.
 */
export function classifiedCoverage(totals: CorrectionRateTotals): number | null {
  const considered = totals.edits - totals.turnover;
  if (considered <= 0) return null;
  return totals.attributable / considered;
}

// ---------------------------------------------------------------------------
// Draft provenance — the missing DENOMINATOR.
//
// An edited draft is self-identifying (the message keeps `originalDraftBody`). A draft the rep
// sent UNCHANGED left no trace at all: nothing on the message said "this text came from the
// agent". So the store could answer "how many drafts did staff rewrite" but never "out of how
// many", which is the half of Joe's question that makes it a RATE instead of a tally.
//
// These stamps fix that going forward. They are pure bookkeeping — no customer text is read and
// no reply behavior changes. Historical messages have no stamp, and the report says so rather
// than inferring one: a guessed denominator would be a made-up rate.
// ---------------------------------------------------------------------------

export type DraftProvenance = {
  /** The sent body came from an agent draft (edited or not). */
  draftUsed: true;
  /** The rep changed it before sending. */
  draftEdited: boolean;
  /** The draft-edit judge's verdict, when one ran. Absent on unedited sends (nothing to judge). */
  draftEditVerdict?: {
    isMaterial: boolean;
    agentCouldHaveKnown: boolean;
    category?: string | null;
    confidence?: number | null;
  };
};

/**
 * Stamps provenance on the outbound message a draft became. Returns true when a message was
 * found and stamped. Best-effort by design: a miss must never fail a send, it just leaves that
 * message out of the denominator (and the report's coverage line shows the shortfall).
 */
export function stampDraftProvenance(
  messages: any[] | null | undefined,
  messageId: string | null | undefined,
  provenance: Omit<DraftProvenance, "draftUsed">
): boolean {
  const id = String(messageId ?? "").trim();
  if (!id || !Array.isArray(messages)) return false;
  const message = messages.find(m => String(m?.id ?? "") === id);
  if (!message) return false;
  message.draftUsed = true;
  message.draftEdited = provenance.draftEdited;
  if (provenance.draftEditVerdict) message.draftEditVerdict = provenance.draftEditVerdict;
  return true;
}
