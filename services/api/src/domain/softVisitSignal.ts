import type { AppointmentTimingParse } from "./llmDraft.js";

/**
 * Parser-driven soft-visit commitment signal (Todd Herian +15673079691, Ref 11438,
 * 2026-06-15: "Ok I will be there for the taste of country pre party on Saturday 👍").
 * The customer commits to coming in on a day/event WITHOUT booking a time — the
 * appointment-timing parser already classifies this as intent:none + requested.day +
 * normalizedText "committing to a ... visit" (the prompt rule keeps it `none` so the
 * soft-visit handler owns it). This makes the soft-visit cadence window parser-driven
 * instead of relying on the legacy `detectSoftVisitIntent` regex (which missed weekday /
 * event phrasings). Fail-safe: over-firing only DELAYS a follow-up (never sends wrong
 * content), and it is OR'd with the regex, so it strictly broadens recall.
 *
 * Pure (LLM parse is passed in) + dependency-light (type-only import of the parse shape)
 * so it is unit-testable without the LLM client — pinned by soft_visit_commitment:eval.
 */
// The one visit-commitment verb list, shared by the day-anchored and conditional signals.
// "be in" excludes "be in touch" — a contact deferral ("I'll be in touch Monday"), not a visit.
const VISIT_COMMITMENT_VERBS =
  /\b(?:commit|visit|see (?:you|ya|y'all)|be back|be there|be in(?!\s+touch)|get there|make it (?:in|out)|stop(?:ping)? (?:by|in)|com(?:e|ing) (?:in|by|out)|rid(?:e|ing) (?:up|in|over)|driv(?:e|ing) (?:up|in|over)|head(?:ing|ed)? (?:up|in|over)|swing(?:ing)? (?:by|in|up)|roll(?:ing)? (?:in|up|by)|pull(?:ing)? (?:in|up)|run(?:ning)? (?:up|in|by))\b/;

export function isParserSoftVisitCommitment(parse: AppointmentTimingParse | null | undefined): boolean {
  if (!parse) return false;
  if (parse.intent !== "none") return false; // actionable scheduling intents are handled by their own arms
  if (parse.explicitRequest) return false;
  if (!String(parse.requested?.day ?? "").trim()) return false; // must reference a committed day
  const nt = String(parse.normalizedText ?? "").toLowerCase();
  // Visit-commitment verbs in the parser's own normalizedText. The gate already requires
  // intent:none + a committed day + !explicitRequest, so an en-route arrival_update ("on my
  // way by 5:30") or an availability ask ("what's open Saturday") never reaches here — which
  // is why we can safely broaden past "come in" to the casual ride/drive/head-in phrasings
  // staff kept hand-fixing (Jessica Ornce "riding up there in the morning tomorrow", 2026-07-11).
  // "see you {day}" / "be back {day}" added 2026-07-19 (Joe ruling, Peter Meredith
  // +17168303999: "Sounds good see you Monday" fell through every recognizer and drew the
  // "I'll check that time and follow up" deflection — a day-only commitment is a SOFT
  // APPOINTMENT, never a time-check).
  return VISIT_COMMITMENT_VERBS.test(nt);
}

/**
 * Fail-safe HINT gate (eligibility only) for the conditional visit-commitment shape: does
 * the raw inbound look like it could carry "once <condition> I'll be in"? The
 * appointment-timing parser is hint-gated in both paths, and Michael's turn matched none
 * of the existing hint tokens ("be in" is not "be there"), so the parser never ran and the
 * comprehension below could never fire. This widens ELIGIBILITY only — comprehension stays
 * with the parser (AGENTS.md fallback policy: hint gates are the allowed deterministic
 * bucket). Fail direction: a hint miss = today's behavior (parser not consulted); an
 * over-trigger only costs one extra parser call.
 */
export function hasConditionalVisitCommitmentHintText(text: string): boolean {
  const t = String(text ?? "").toLowerCase();
  if (!/\b(?:once|when|whenever|as soon as|after)\b/.test(t)) return false;
  return /\b(?:i'?ll|i\s+will|we'?ll|we\s+will|gonna|going\s+to)\s+(?:be\s+in\b(?!\s+touch)|come\s+(?:in|by|out)|stop\s+(?:by|in)|swing\s+(?:by|in)|make\s+it\s+(?:in|out)|head\s+(?:up|in|over)|ride\s+(?:up|in|over)|drive\s+(?:up|in|over))\b/.test(
    t
  );
}

/**
 * CONDITIONAL (day-less) visit commitment (Michael Siejka +17169906333, 2026-06-25:
 * "Beautiful thank you so much, currently cleaning the carbs on my bike but once she's
 * back on the road i'll be in."). The appointment-timing parser reads these correctly —
 * intent:none, no requested day, normalizedText like "will come in once bike is back on
 * the road" — but isParserSoftVisitCommitment requires a committed DAY, so the turn fell
 * through every recognizer and the generic orchestrator improvised (the corpus replay
 * judge flagged a photo-appreciation-flavored draft instead of a visit ack + patience).
 *
 * Same bucket as isParserSoftVisitCommitment: structured extraction over the PARSER's own
 * normalizedText (the parser comprehended the turn; this only reads its output — AGENTS.md
 * "comprehend, never regex"). Requires a visit-commitment verb AND a conditional/deferral
 * marker ("once/when/after/as soon as <condition>"), so a bare day-less "I'll come by"
 * (too vague) or "I'll let you know when I'm ready" (no visit verb) never fires.
 *
 * Fail direction: over-firing sends a warm no-rush ack + soft cadence cooldown (never a
 * booking, never a claim); a miss = today's improvised generic draft. Fail-safe.
 */
export function isParserConditionalVisitCommitment(
  parse: AppointmentTimingParse | null | undefined
): boolean {
  if (!parse) return false;
  if (parse.intent !== "none") return false; // actionable scheduling intents keep their own arms
  if (parse.explicitRequest) return false;
  if (String(parse.requested?.day ?? "").trim()) return false; // day-anchored commitments use isParserSoftVisitCommitment
  const nt = String(parse.normalizedText ?? "").toLowerCase();
  if (!VISIT_COMMITMENT_VERBS.test(nt)) return false;
  return /\b(?:once|when|whenever|as soon as|after)\b/.test(nt);
}
