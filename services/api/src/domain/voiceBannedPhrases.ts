/**
 * Computer-like / banned-phrase denylist (2026-06-19).
 *
 * Joe's directive: every customer-facing message should sound like a real American H-D
 * employee texting a buyer they like — "warm, short, plain, low-pressure — never corporate,
 * gimmicky, or machine" (the Voice Charter). Certain words/phrases are dead giveaways that a
 * computer wrote it; those are BANNED outright. A fixed phrase denylist is a deterministic
 * OUTPUT guard (an invariant), not comprehension — so it lives here as plain data + a matcher,
 * per AGENTS.md ("deterministic only for … invariant guards").
 *
 * This is SEPARATE from the 11-phrase list in scripts/voice_charter_audit.ts on purpose: that
 * list is wired into six existing evals that assert clean copy, so growing it risks tripping
 * them. This broader list drives the new draft-time shadow detection + the cadence-quality
 * judge's tone axis, with no collateral risk to the audit.
 *
 * Curation principle (Joe delegated the call): only phrases a real salesperson would never text.
 * Cross-checked against our gold-standard reps (Scott/Joe/Gio) so it never collides with their
 * human phrasing — "let me know", "still interested?", "want to come ride it?", "thanks for
 * stopping in", "we don't have a 2025, we do have a 2026" all pass clean.
 *
 * Matching is WORD-BOUNDARY (not raw substring) so "as per" doesn't fire inside "as personal"
 * and "utilize" doesn't fire inside a larger token.
 */

export const COMPUTER_LIKE_PHRASES: string[] = [
  // --- Corporate-speak / CRM filler ---
  "reach out", // a human says "text me" / "let me know"
  "feel free to",
  "don't hesitate",
  "do not hesitate",
  "at your earliest convenience",
  "per your inquiry",
  "per your request",
  "as per",
  "kindly",
  "circle back",
  "touch base",
  "valued customer",
  "we appreciate your business",
  "thank you for your patience",
  "rest assured",
  "we strive",
  "we pride ourselves",
  "hope this message finds you well",
  "hope this finds you well",
  "hope all is well",

  // --- Robotic / "assist" register (a human says "help", not "assist") ---
  "happy to assist",
  "glad to assist",
  "be of assistance",
  "further assistance",
  "how may i assist",
  "utilize",
  "facilitate",
  "furthermore",
  "moreover",

  // --- Marketing / AI tells ---
  "seamless",
  "leverage",
  "elevate your",
  "curated",
  "delve",
  "ecosystem",
  "streamline",
  "tailored solutions",
  "wide range",
  "wide selection",
  "state-of-the-art",
  "top-notch",
  "cutting-edge",
  "look no further",
  "got you covered",
  "in today's"
];

/** Escape a phrase for use inside a RegExp (spaces become flexible whitespace). */
function phraseToRegExp(phrase: string): RegExp {
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
  return new RegExp("\\b" + escaped + "\\b", "i");
}

const PHRASE_MATCHERS: { phrase: string; re: RegExp }[] = COMPUTER_LIKE_PHRASES.map(phrase => ({
  phrase,
  re: phraseToRegExp(phrase)
}));

/**
 * Returns the list of banned/computer-like phrases present in `text` (word-boundary matched,
 * case-insensitive). Empty array when the text is clean. Pure + cheap (no LLM).
 */
export function findComputerLikePhrases(text: string | null | undefined): string[] {
  const t = String(text ?? "");
  if (!t.trim()) return [];
  const hits: string[] = [];
  for (const { phrase, re } of PHRASE_MATCHERS) {
    if (re.test(t)) hits.push(phrase);
  }
  return hits;
}

/** Convenience boolean: does the text contain any banned/computer-like phrase? */
export function hasComputerLikePhrase(text: string | null | undefined): boolean {
  return findComputerLikePhrases(text).length > 0;
}

/**
 * A prompt line to feed the denylist into LLM reply generators as HARD NEGATIVES — prevention,
 * so the model never writes a computer-like phrase in the first place (the safe, grammar-preserving
 * complement to the post-hoc shadow detection). Keep it one line so it slots into existing prompts.
 */
export function bannedPhraseAvoidanceInstruction(): string {
  return (
    "Never write computer-like / corporate phrases — sound like a real person texting, not a bot. " +
    "Banned (do not use these or close variants, including -ing forms like \"reaching out\"): " +
    COMPUTER_LIKE_PHRASES.join(", ") +
    "."
  );
}
