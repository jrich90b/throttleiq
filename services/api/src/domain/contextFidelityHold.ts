/**
 * Context-fidelity pre-publish hold — pure gating decision around the "answering out of context"
 * scorer (scoreContextFidelityWithLLM). Sibling of draftQualityGate.ts.
 *
 * The scorer is the typed LLM parser (COMPREHENSION — does the reply answer THIS turn, or did it
 * adopt a stale / over-attached / wrong-lead-type / fabricated / anchor-dropped frame?). This module
 * owns ONLY the pure precedence + flag/shadow gating, so it's fully unit-testable (the score is
 * passed IN). It turns a score into an action: pass | hold.
 *
 * WHY a separate gate from draftQualityGate: the draft-quality judge scores generic quality
 * (intent/tone/disposition/safety); this gate is the dedicated catch for the "out of context" class
 * — the residual misses that slip past per-intent parsers AND past staff approval. The enforcement
 * backtest (scripts/context_fidelity_backtest.ts) found ~20% of STAFF-APPROVED drafts score
 * out-of-context, ~10-12/14 of those genuine misses staff rubber-stamped — i.e. the human backstop
 * leaks ~1-in-5, and this gate flags exactly those.
 *
 * HOLD SLICE (mirrors the draft-quality gate's proven-safe first slice):
 *  - hold-class only        — verdict === "out_of_context" (faithful never holds),
 *  - major severity         — a customer would notice it answers the wrong thing,
 *  - confidence >= 0.8,
 *  - AND a TURN-JUDGED frame — judged from what the customer said THIS turn, not a possibly-stale
 *    anchor. wrong_lead_type / fabricated need the anchor to judge and carry a stale-anchor
 *    false-hold risk (a sold lead with a stale "test_ride" classification), so they are EXCLUDED
 *    from the hold here (still scored + shadow-logged). The backtest's real would-holds all fell in
 *    the turn-judged frames.
 *
 * FAIL DIRECTION: a missing / faithful / low-confidence / excluded-frame score resolves to "pass" —
 * a false hold blocks a good draft, and a hold fails SAFE to a handoff ack + staff task anyway
 * (AGENTS.md Fallback Policy). Biased toward letting drafts through.
 *
 * SHIPS DARK: with CONTEXT_FIDELITY_HOLD_ENABLED unset/0, `live` is false ⇒ the gate never changes a
 * live draft — it only computes what it WOULD do (shadow-logged). The live cutover (flag on + wiring
 * the actual hold) is a separate approve-first step.
 */

/** The subset of scoreContextFidelityWithLLM's output this gate reasons over (kept local so the
 *  module stays pure + decoupled from llmDraft). The runtime score is structurally compatible. */
export type ContextFidelityScoreLike = {
  verdict: "faithful" | "out_of_context";
  severity: "minor" | "major";
  frame: string;
  confidence?: number;
  reason?: string;
  steering?: string;
};

/** Frames judged from THIS turn (not the anchor) — the only frames the hold acts on. */
export const CONTEXT_FIDELITY_HOLD_FRAMES = ["stale_intent", "over_attached_model", "dropped_anchor"] as const;

/** Minimum confidence to hold. Matches the draft-quality gate's bar — high, biased toward pass. */
export const CONTEXT_FIDELITY_HOLD_MIN_CONFIDENCE = 0.8;

export type ContextFidelityHoldAction = "pass" | "hold";

export type ContextFidelityHoldDecision = {
  action: ContextFidelityHoldAction;
  /** Whether the action may change a live draft (flag on). Shadow ⇒ false. */
  live: boolean;
  reason: string;
  /** Carried through for the trace / shadow log. */
  frame?: string;
};

/**
 * Pure. Maps a context-fidelity score to an action.
 *  - No score / faithful / minor / below-confidence / excluded-frame => pass.
 *  - out_of_context + major + confident + turn-judged frame          => hold.
 * `live` is true only when the hold would fire AND the live flag is on; otherwise the decision is
 * computed for shadow logging with `live=false`.
 */
export function decideContextFidelityHold(input: {
  enabled: boolean; // CONTEXT_FIDELITY_HOLD_ENABLED — allow changing a live draft
  score: ContextFidelityScoreLike | null | undefined;
  minConfidence?: number;
}): ContextFidelityHoldDecision {
  const min = input.minConfidence ?? CONTEXT_FIDELITY_HOLD_MIN_CONFIDENCE;
  const score = input.score;
  if (!score) return { action: "pass", live: false, reason: "no_score" };
  if (score.verdict !== "out_of_context") return { action: "pass", live: false, reason: "faithful", frame: score.frame };
  if (score.severity !== "major") return { action: "pass", live: false, reason: "minor", frame: score.frame };
  if (!(typeof score.confidence === "number" && score.confidence >= min)) {
    return { action: "pass", live: false, reason: "below_confidence", frame: score.frame };
  }
  if (!(CONTEXT_FIDELITY_HOLD_FRAMES as readonly string[]).includes(score.frame)) {
    // Out-of-context but in an anchor-dependent frame (wrong_lead_type/fabricated/other) — don't hold
    // (stale-anchor false-hold risk); still surfaced via the shadow log for review.
    return { action: "pass", live: false, reason: "frame_excluded", frame: score.frame };
  }
  return {
    action: "hold",
    live: !!input.enabled,
    reason: input.enabled ? "live_hold" : "shadow_would_hold",
    frame: score.frame
  };
}

/** Reads CONTEXT_FIDELITY_HOLD_ENABLED. Default OFF (dark) — the live enforce-flip (approve-first). */
export function isContextFidelityHoldEnabled(): boolean {
  const raw = String(process.env.CONTEXT_FIDELITY_HOLD_ENABLED ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

/**
 * Reads CONTEXT_FIDELITY_HOLD_SHADOW. Default OFF — unlike the other shadows this adds a NET-NEW LLM
 * call per published reply draft, so it stays off until we deliberately turn it on for the
 * measurement window. Set to 1 to start logging [context-fidelity-hold-shadow] would-holds.
 */
export function contextFidelityHoldShadowEnabled(): boolean {
  const raw = String(process.env.CONTEXT_FIDELITY_HOLD_SHADOW ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}
