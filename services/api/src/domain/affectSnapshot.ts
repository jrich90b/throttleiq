/**
 * Affect-parse acceptance + snapshot (shared by every inbound lane).
 *
 * The LLM affect parser (`parseAffectWithLLM`) is comprehension; this module owns the single
 * ACCEPTANCE gate — a confidence floor plus "did the parser actually see an affect signal" —
 * and the write of `conv.lastAffect`. It lived inline in `index.ts` and was therefore reachable
 * only from the Twilio lane, which is how the ADF/email lane ended up never recording affect at
 * all (Wesley Buzzard +17162913658, 2026-07-30: `lastAffect` on the conversation was a stale
 * snapshot from an earlier SMS turn, so the grief disclosed in his ADF was invisible to the
 * reply). Extracting it verbatim lets `routes/sendgridInbound.ts` apply the SAME threshold as
 * `/webhooks/twilio` and `/conversations/:id/regenerate` — one gate, three lanes.
 *
 * Behavior-preserving move: the threshold, the signal test, and the snapshot shape are unchanged.
 */

import type { AffectParse } from "./llmDraft.js";

/** True when the parse carries a usable affect signal at or above the confidence floor. */
export function acceptAffectParse(affectParse: AffectParse | null | undefined): boolean {
  if (!affectParse) return false;
  const confidence =
    typeof affectParse.confidence === "number" && Number.isFinite(affectParse.confidence)
      ? Math.max(0, Math.min(1, affectParse.confidence))
      : 0;
  const confidenceMin = Number(process.env.LLM_AFFECT_CONFIDENCE_MIN ?? 0.68);
  const hasAffectSignal = affectParse.explicitAffect || affectParse.primaryAffect !== "none";
  return hasAffectSignal && confidence >= confidenceMin;
}

/**
 * Record an accepted affect parse on the conversation and return it; returns null (and writes
 * nothing) when the parse is missing or below the acceptance gate.
 */
export function applyAffectParseSnapshot(
  conv: any,
  affectParse: AffectParse | null | undefined,
  sourceMessageId?: string | null
): AffectParse | null {
  if (!conv || !affectParse) return null;
  if (!acceptAffectParse(affectParse)) return null;
  const confidence =
    typeof affectParse.confidence === "number" && Number.isFinite(affectParse.confidence)
      ? Math.max(0, Math.min(1, affectParse.confidence))
      : 0;
  conv.lastAffect = {
    primary: affectParse.primaryAffect,
    explicitAffect: !!affectParse.explicitAffect,
    needsEmpathy: !!affectParse.needsEmpathy,
    hasHumor: !!affectParse.hasHumor,
    hasPositiveEnergy: !!affectParse.hasPositiveEnergy,
    hasNegativeSentiment: !!affectParse.hasNegativeSentiment,
    toneIntensity: affectParse.toneIntensity,
    confidence,
    source: "llm",
    sourceMessageId: sourceMessageId ? String(sourceMessageId) : undefined,
    updatedAt: new Date().toISOString()
  };
  return affectParse;
}
