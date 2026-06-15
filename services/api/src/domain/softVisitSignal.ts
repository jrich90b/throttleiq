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
  return /\b(commit|visit|be there|stop(?:ping)? by|coming in|come in)\b/.test(nt);
}
