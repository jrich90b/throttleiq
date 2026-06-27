/**
 * Turn-Understanding model authority (Phase 2, scoped to MODEL resolution).
 *
 * Makes the consolidated understanding pass's requested-models the authority for
 * model selection, with the deterministic extractor as fallback — BUT only behind
 * a relevance guard (the shadow backfill showed ~80% of the pass's raw model
 * disagreements were over-attachment: pulling a thread model onto a turn that
 * doesn't need one). Ships DARK: `enabled` defaults false, so today's deterministic
 * behavior is unchanged until the kill switch is flipped for a measured canary.
 *
 * Pure + deterministic so it's fully unit-testable; the LLM understanding object is
 * passed IN. Scoped to models only — schedule stays with the existing parsers
 * (evidence: schedule disagreements are mostly the regex's legitimate misses, not
 * a consolidation win).
 */
import { catalogModelMentionMatchesText } from "./workflowRegressionGuards.js";

export type AuthorityModel = { family: string; trim?: string | null; confidence?: number };

export type ModelAuthorityInput = {
  enabled: boolean;
  llmModels: AuthorityModel[];
  deterministicModels: string[];
  inboundText: string;
  confidenceMin?: number;
};

export type ModelAuthorityDecision = {
  models: string[];
  source: "llm" | "deterministic" | "none";
  reason:
    | "authority_disabled"
    | "llm_authority"
    | "llm_empty_fallback"
    | "no_model";
  droppedContextModels: string[];
};

export function modelAuthorityEnabled(): boolean {
  // GRADUATED from canary to default-ON (2026-06-24): the model-resolution authority + relevance guard
  // proved out — `owned_bike_offered` held at 0 across a 7-day answer_correctness sweep, and americanharley
  // has run it live since 6/20. Now on by default (so dealer #2/#3 get it without an env flag). Kill-switch:
  // TURN_UNDERSTANDING_MODEL_AUTHORITY=0.
  return process.env.TURN_UNDERSTANDING_MODEL_AUTHORITY !== "0";
}

export function modelAuthorityConfidenceMin(): number {
  const raw = Number(process.env.LLM_TURN_UNDERSTANDING_MODEL_CONFIDENCE_MIN);
  return Number.isFinite(raw) && raw > 0 && raw <= 1 ? raw : 0.7;
}

// A bare acknowledgement / thanks / reaction / sign-off with no question is NOT a
// turn that should resolve a model from thread context. Kept narrow + deterministic.
const GRATITUDE_RE = /^(?:thanks?|thank you|thank u|ty|thx|tysm|appreciate (?:it|that|you|ya)|much appreciated)\b/i;
const BARE_ACK_RE =
  /^(?:ok(?:ay)?|k|kk|yes|yep|yeah|yup|no|nope|sounds good|got it|gotcha|great|perfect|cool|awesome|nice|will do|see you( then| there)?|see ya|sweet|good deal|word|right on|👍|👌)[.! ]*$/i;
const SIGNOFF_RE = /\b(see you (then|there|saturday|sunday|monday|tuesday|wednesday|thursday|friday|tomorrow)|talk soon|on my way|heading (out|over)|be there (in|soon|at)|running late|stopped in|came by)\b/i;
const EMOJI_ONLY_RE = /^[\p{Emoji}\p{Extended_Pictographic}\s❤️👍👎]+$/u;

export function isNonActionableTurnText(text: string): boolean {
  const raw = String(text ?? "").trim();
  if (!raw) return true;
  if (raw.includes("?")) return false; // a question is actionable
  if (EMOJI_ONLY_RE.test(raw)) return true;
  if (GRATITUDE_RE.test(raw) && raw.split(/\s+/).length <= 5) return true;
  if (BARE_ACK_RE.test(raw)) return true;
  if (raw.split(/\s+/).length <= 2) return true;
  if (SIGNOFF_RE.test(raw) && raw.split(/\s+/).length <= 12) return true;
  return false;
}

// A model is relevant to act on THIS turn if the customer referenced it on this
// turn (catalog match), OR the turn is actionable (a question/request) and the
// model is the thread's active subject. A model pulled onto a bare ack is dropped.
export function passesModelRelevanceGuard(family: string, inboundText: string): boolean {
  const fam = String(family ?? "").trim();
  if (!fam) return false;
  if (catalogModelMentionMatchesText(inboundText, fam)) return true; // named this turn
  return !isNonActionableTurnText(inboundText); // actionable turn may use the active subject
}

/**
 * Map a turn-understanding pass's requestedModels into AuthorityModel[] (the
 * resolver's `llmModels` input). Pure; drops empty families; defaults missing
 * confidence to 1 so an un-scored model isn't silently filtered by the gate.
 */
export function toAuthorityModels(
  requestedModels: Array<{ family?: string | null; trim?: string | null; confidence?: number | null }> | null | undefined
): AuthorityModel[] {
  return (requestedModels ?? [])
    .map(m => ({
      family: String(m?.family ?? "").trim(),
      trim: m?.trim ?? null,
      confidence: typeof m?.confidence === "number" ? m.confidence : 1
    }))
    .filter(m => m.family.length > 0);
}

export function resolveAuthoritativeModels(input: ModelAuthorityInput): ModelAuthorityDecision {
  const det = (input.deterministicModels ?? []).map(s => String(s ?? "").trim()).filter(Boolean);
  if (!input.enabled) {
    return { models: det, source: "deterministic", reason: "authority_disabled", droppedContextModels: [] };
  }
  const min = input.confidenceMin ?? modelAuthorityConfidenceMin();
  const dropped: string[] = [];
  const guarded: string[] = [];
  for (const m of input.llmModels ?? []) {
    const fam = String(m?.family ?? "").trim();
    if (!fam) continue;
    if ((m?.confidence ?? 1) < min) continue;
    if (!passesModelRelevanceGuard(fam, input.inboundText)) {
      dropped.push(fam);
      continue;
    }
    if (!guarded.some(g => g.toLowerCase() === fam.toLowerCase())) guarded.push(fam);
  }
  if (guarded.length) return { models: guarded, source: "llm", reason: "llm_authority", droppedContextModels: dropped };
  if (det.length) return { models: det, source: "deterministic", reason: "llm_empty_fallback", droppedContextModels: dropped };
  return { models: [], source: "none", reason: "no_model", droppedContextModels: dropped };
}
