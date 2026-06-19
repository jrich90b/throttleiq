/**
 * Draft-quality pre-send gate — pure eligibility + gating decision.
 *
 * Before a customer-facing draft is shown/sent, a multi-dimensional LLM judge
 * (judgeDraftQualityWithLLM) reads the draft against the customer's turn and scores
 * it on four axes: does it ADDRESS the ask (intent), is it ON-VOICE (tone), is it
 * RIGHT FOR THE CUSTOMER'S STATE (disposition — empathy/pushiness/undercutting), and
 * is it SAFE (no fabricated facts / premature booking). This module is the
 * deterministic gate around that verdict: turn the judge's verdict into an action.
 *
 * Whether a draft is good is COMPREHENSION — the judge is the typed LLM parser; this
 * module owns only the pure precedence + the flag/shadow gating, so it's fully
 * unit-testable (the judge object is passed IN).
 *
 * Actions:
 *  - "pass"       — let the draft proceed (good, or we couldn't confidently judge).
 *  - "regenerate" — the draft is recoverable; re-draft (with the judge's steering hint).
 *  - "hold"       — the draft is wrong in a way a re-draft of the SAME code won't fix
 *                   (a routing/comprehension bug); don't send — wait for a code fix +
 *                   auto-regenerate once it lands.
 *
 * FAIL DIRECTION (STEP 1, shadow + suggest mode): a missing/low-confidence verdict
 * resolves to "pass" — a false hold/regenerate blocks a good draft, and in suggest
 * mode a human reviews every draft anyway. (When auto-send is later enabled, the
 * caller raises the bar; the gate keeps the verdict authoritative.)
 *
 * SHIPS DARK: with DRAFT_QUALITY_JUDGE_ENABLED unset/0, `live` is false ⇒ the gate
 * never changes a live draft — it only computes + logs what it WOULD do (shadow).
 * The live cutover (flag on) is approve-first.
 */

export type DraftQualityVerdict = {
  /** Per-axis pass flags. */
  intentOk: boolean;
  toneOk: boolean;
  dispositionOk: boolean;
  safetyOk: boolean;
  /** Overall judge verdict. */
  overall: "good" | "needs_regenerate" | "hold";
  /** 0..1 (may be absent if the judge didn't score). */
  confidence?: number;
  /** Short why (for the trace). */
  reason?: string;
  /** Steering hint to feed a re-draft when overall !== "good". */
  steering?: string;
};

export type DraftQualityAction = "pass" | "regenerate" | "hold";

export type DraftQualityGateDecision = {
  action: DraftQualityAction;
  /** Whether the action is allowed to change the live draft (flag on). Shadow ⇒ false. */
  live: boolean;
  reason: string;
};

/** Minimum confidence to act on a non-"good" verdict. High by design — biased toward pass. */
export const DRAFT_QUALITY_MIN_CONFIDENCE = 0.8;

/**
 * Pure. Maps the judge verdict to an action.
 *  - No verdict / low confidence / good        => pass.
 *  - needs_regenerate (confident)              => regenerate.
 *  - hold (confident)                          => hold.
 * `live` is true only when the verdict would change a draft AND the live flag is on;
 * otherwise the decision is computed for shadow logging with `live=false`.
 */
export function decideDraftQualityGate(input: {
  enabled: boolean; // DRAFT_QUALITY_JUDGE_ENABLED — allow changing a live draft
  verdict: DraftQualityVerdict | null;
  minConfidence?: number;
}): DraftQualityGateDecision {
  const min = input.minConfidence ?? DRAFT_QUALITY_MIN_CONFIDENCE;
  if (!input.verdict) return { action: "pass", live: false, reason: "no_verdict" };
  if (input.verdict.overall === "good") {
    return { action: "pass", live: false, reason: "good" };
  }
  if (!(typeof input.verdict.confidence === "number" && input.verdict.confidence >= min)) {
    return { action: "pass", live: false, reason: "below_confidence" };
  }
  const action: DraftQualityAction = input.verdict.overall === "hold" ? "hold" : "regenerate";
  // Confident, actionable verdict. `live` only when the flag is on; otherwise shadow.
  return { action, live: !!input.enabled, reason: input.enabled ? `live_${action}` : `shadow_would_${action}` };
}

/** Reads DRAFT_QUALITY_JUDGE_ENABLED. Default OFF (dark) — never changes a live draft. */
export function isDraftQualityJudgeEnabled(): boolean {
  const raw = String(process.env.DRAFT_QUALITY_JUDGE_ENABLED ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

/**
 * Reads DRAFT_QUALITY_JUDGE_SHADOW. Default ON so the dark hook records what it WOULD
 * do; set to 0 to silence the shadow judge entirely (no extra LLM call per draft).
 */
export function draftQualityJudgeShadowEnabled(): boolean {
  const raw = String(process.env.DRAFT_QUALITY_JUDGE_SHADOW ?? "1").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}
