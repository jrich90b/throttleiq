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
  return /\b(?:commit|visit|see (?:you|ya|y'all)|be back|be there|be in|get there|make it (?:in|out)|stop(?:ping)? (?:by|in)|com(?:e|ing) (?:in|by|out)|rid(?:e|ing) (?:up|in|over)|driv(?:e|ing) (?:up|in|over)|head(?:ing|ed)? (?:up|in|over)|swing(?:ing)? (?:by|in|up)|roll(?:ing)? (?:in|up|by)|pull(?:ing)? (?:in|up)|run(?:ning)? (?:up|in|by))\b/.test(nt);
}
