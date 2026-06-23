/**
 * Model-deflection decision — pure. "Answer-don't-deflect" for the model-known case.
 *
 * The orchestrator deflects to "which model are you interested in?" / "I need the exact bike you want
 * first" at ~7 sites, each resolving the model its own way. The production audit (takeover gold pairs)
 * showed these fire even when the model is already on record (ADF Vehicle / model-of-record) — the
 * single most common confirmed agent error. This module centralizes the one decision: given the model
 * the customer referenced THIS turn and the established anchor model, do we have a SPECIFIC model to
 * answer with, or is it genuinely unknown (so deflecting/asking is correct)?
 *
 * Centralizes placeholder detection currently duplicated as orchestrator.isUnknownModel +
 * sendgridInbound.isGenericLeadModel. Deterministic is correct here: classifying a known field value
 * ("Other"/"Full Line" are not bookable models) is structured extraction, not comprehension.
 *
 * FAIL DIRECTION: when unsure, ASK (deflect). A false "answer_with_model" would assert a model the
 * customer didn't mean (the over-attachment failure mode); a false "ask_for_model" just re-asks, which
 * the human reviews in suggest mode. So the bar to answer is a SPECIFIC, non-placeholder model that the
 * turn didn't contradict.
 */

/** A label that is never a specific bookable model (placeholder / make-only / blank). */
export function isPlaceholderModel(label?: string | null): boolean {
  if (!label) return true;
  const t = label.trim().toLowerCase();
  if (!t) return true;
  if (t === "null" || t === "n/a" || t === "na" || t === "unknown" || t === "tbd") return true;
  // "Other" / "Harley-Davidson Other" / "Full Line(up)" — placeholders even with a make prefix.
  if (t === "other" || /\bother\b/.test(t) || /\bfull\s*line(up)?\b/.test(t)) return true;
  // Bare make with no model ("harley-davidson", "harley davidson", "harley").
  if (/^harley[-\s]?davidson$/.test(t) || t === "harley") return true;
  return false;
}

/** The inverse, for call sites that read more naturally as "do we have a real model?". */
export const isSpecificModel = (label?: string | null): boolean => !isPlaceholderModel(label);

/**
 * Resolve the SPECIFIC model to answer a deflection with, or null if genuinely unknown.
 * Precedence: a real model the customer named THIS turn wins (over-attachment-safe); else the
 * established anchor model; placeholders count as unknown. If the turn explicitly moved OFF the anchor
 * without naming a new model, we do NOT fall back to the (now stale) anchor.
 */
export function resolveSpecificModelForDeflection(args: {
  turnModel?: string | null; // model the customer referenced this turn (resolved upstream)
  anchorModel?: string | null; // lead.vehicle.model / model-of-record
  turnContradictsAnchor?: boolean; // customer rejected/pivoted off the anchor this turn
}): string | null {
  const turn = String(args.turnModel ?? "").trim();
  if (turn && isSpecificModel(turn)) return turn; // this turn named a real model -> use it
  if (args.turnContradictsAnchor) return null; // pivoted away, no new model -> genuinely unknown
  const anchor = String(args.anchorModel ?? "").trim();
  if (anchor && isSpecificModel(anchor)) return anchor; // established model of record
  return null; // genuinely unknown -> deflection (ask) is CORRECT
}

export type ModelDeflectionDecision = {
  action: "answer_with_model" | "ask_for_model";
  model: string | null;
  reason: string;
};

/** Pure decision at a model-deflection site. */
export function decideModelDeflection(args: {
  turnModel?: string | null;
  anchorModel?: string | null;
  turnContradictsAnchor?: boolean;
}): ModelDeflectionDecision {
  const model = resolveSpecificModelForDeflection(args);
  if (model) return { action: "answer_with_model", model, reason: "specific_model_known" };
  return {
    action: "ask_for_model",
    model: null,
    reason: args.turnContradictsAnchor ? "model_pivoted_unknown" : "model_unknown_or_placeholder"
  };
}
