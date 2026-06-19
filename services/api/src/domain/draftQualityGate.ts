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

// --- No-response gate (sibling of the draft gate) ---------------------------------
// The agent stayed SILENT on a customer turn; the judge says whether that was a miss. This
// gate maps the verdict to an action. STEP 1 is shadow: it only logs what it WOULD do.
//   - "pass"             — silence was fine (or we couldn't confidently judge).
//   - "flag_missing_response" — the turn warranted a reply; (later) generate one instead of silence.
// FAIL DIRECTION = pass (never manufacture a reply on an unsure/low-confidence verdict).

export type ShouldRespondVerdict = { shouldRespond: boolean; confidence?: number };

export type NoResponseGateDecision = {
  action: "pass" | "flag_missing_response";
  live: boolean;
  reason: string;
};

export function decideNoResponseJudge(input: {
  enabled: boolean; // NO_RESPONSE_JUDGE_ENABLED — allow producing a reply where we'd have been silent
  verdict: ShouldRespondVerdict | null;
  minConfidence?: number;
}): NoResponseGateDecision {
  const min = input.minConfidence ?? DRAFT_QUALITY_MIN_CONFIDENCE;
  if (!input.verdict) return { action: "pass", live: false, reason: "no_verdict" };
  if (!input.verdict.shouldRespond) return { action: "pass", live: false, reason: "silence_ok" };
  if (!(typeof input.verdict.confidence === "number" && input.verdict.confidence >= min)) {
    return { action: "pass", live: false, reason: "below_confidence" };
  }
  return {
    action: "flag_missing_response",
    live: !!input.enabled,
    reason: input.enabled ? "live_flag_missing_response" : "shadow_would_flag_missing_response"
  };
}

// --- Cadence-quality gate (sibling of the draft gate, for PROACTIVE follow-ups) ---------------
// The agent is about to send a scheduled cadence touch (no inbound to answer). The cadence-quality
// judge scores it; this gate maps the verdict to an action. STEP 1 is shadow: it only logs what it
// WOULD do.
//   - "pass"       — send it (good, or we couldn't confidently judge).
//   - "regenerate" — worth sending, but reword (the judge's steering).
//   - "suppress"   — do NOT send this proactive touch (wrong moment / nothing worth saying).
//   - "hold"       — references something wrong/unsafe; a human/code fix should look.
// FAIL DIRECTION (shadow + suggest mode) = pass: a missing/low-confidence verdict never blocks a
// cadence draft (in suggest mode a human approves it anyway). NOTE: at the LIVE/auto-send cutover the
// caller raises the bar so an UNSURE proactive touch is suppressed — an unsolicited bad message has
// no upside — but the gate keeps the verdict authoritative; only the confidence bar changes.

export type CadenceQualityVerdict = {
  overall: "good" | "needs_regenerate" | "suppress" | "hold";
  confidence?: number;
};

export type CadenceQualityAction = "pass" | "regenerate" | "suppress" | "hold";

export type CadenceQualityGateDecision = {
  action: CadenceQualityAction;
  live: boolean;
  reason: string;
};

export function decideCadenceQualityGate(input: {
  enabled: boolean; // CADENCE_QUALITY_JUDGE_ENABLED — allow changing/suppressing a live cadence draft
  verdict: CadenceQualityVerdict | null;
  minConfidence?: number;
}): CadenceQualityGateDecision {
  const min = input.minConfidence ?? DRAFT_QUALITY_MIN_CONFIDENCE;
  if (!input.verdict) return { action: "pass", live: false, reason: "no_verdict" };
  if (input.verdict.overall === "good") return { action: "pass", live: false, reason: "good" };
  if (!(typeof input.verdict.confidence === "number" && input.verdict.confidence >= min)) {
    return { action: "pass", live: false, reason: "below_confidence" };
  }
  const action: CadenceQualityAction =
    input.verdict.overall === "hold"
      ? "hold"
      : input.verdict.overall === "suppress"
        ? "suppress"
        : "regenerate";
  return { action, live: !!input.enabled, reason: input.enabled ? `live_${action}` : `shadow_would_${action}` };
}

/** Reads CADENCE_QUALITY_JUDGE_ENABLED. Default OFF (dark) — never changes a live cadence draft. */
export function isCadenceQualityJudgeEnabled(): boolean {
  const raw = String(process.env.CADENCE_QUALITY_JUDGE_ENABLED ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

/** Reads CADENCE_QUALITY_JUDGE_SHADOW. Default ON so the dark hook records what it WOULD do. */
export function cadenceQualityJudgeShadowEnabled(): boolean {
  const raw = String(process.env.CADENCE_QUALITY_JUDGE_SHADOW ?? "1").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

/** Reads NO_RESPONSE_JUDGE_ENABLED. Default OFF (dark). */
export function isNoResponseJudgeEnabled(): boolean {
  const raw = String(process.env.NO_RESPONSE_JUDGE_ENABLED ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

/** Reads NO_RESPONSE_JUDGE_SHADOW. Default ON so the dark hook records wrongful silences. */
export function noResponseJudgeShadowEnabled(): boolean {
  const raw = String(process.env.NO_RESPONSE_JUDGE_SHADOW ?? "1").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
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
