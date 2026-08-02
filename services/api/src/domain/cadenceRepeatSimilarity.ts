/**
 * Cadence repeat similarity — the "did we already say this?" math.
 *
 * WHY THIS MODULE EXISTS (2026-08-02): this algorithm lived privately inside `index.ts`, and
 * `scripts/followup_duplicate_guard_eval.ts` tested a HAND-COPIED duplicate of it. The copy had
 * already drifted: it stripped only the ASCII apostrophe (`/[']/g`) where the real code strips the
 * curly one too (`/[’']/g`), so on the same production text the copy scored 0.8095 where the code
 * that actually runs scored 0.7727 — a 3.7-point gap, straddling the 0.82 decision threshold. The
 * eval was measuring math nobody shipped. Extracting it here is behavior-preserving: `index.ts`
 * imports these back under the same names, and the eval now imports the real thing.
 *
 * Nothing here reads or writes conversation state, and nothing here decides whether to send. It is
 * pure text math consumed by the cadence send path's repetition guards.
 */

export function normalizeOutboundText(text: string): string {
  return String(text ?? "").toLowerCase().replace(/\s+/g, " ").trim();
}

export const CADENCE_SIMILARITY_STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "can",
  "did",
  "do",
  "for",
  "from",
  "get",
  "got",
  "have",
  "i",
  "if",
  "in",
  "is",
  "it",
  "just",
  "let",
  "me",
  "my",
  "of",
  "on",
  "or",
  "our",
  "so",
  "still",
  "that",
  "the",
  "this",
  "to",
  "we",
  "what",
  "when",
  "which",
  "with",
  "you",
  "your"
]);

export function cadenceSimilarityTokens(text: string): Set<string> {
  const normalized = normalizeOutboundText(text)
    .replace(/[’']/g, "")
    .replace(/[^a-z0-9\s]/g, " ");
  const out = new Set<string>();
  for (const token of normalized.split(/\s+/)) {
    if (!token) continue;
    if (CADENCE_SIMILARITY_STOP_WORDS.has(token)) continue;
    if (token.length <= 2 && !/^\d+$/.test(token)) continue;
    out.add(token);
  }
  return out;
}

export function extractComparableCadenceSentences(text: string): string[] {
  const compact = String(text ?? "")
    .replace(/[!?]+/g, ".")
    .replace(/\s+/g, " ")
    .trim();
  if (!compact) return [];
  return compact
    .split(".")
    .map(part =>
      normalizeOutboundText(part)
        .replace(/[’']/g, "")
        .replace(/[^a-z0-9\s]/g, " ")
        .replace(/\s+/g, " ")
        .trim()
    )
    .filter(part => part.length >= 24 && part.split(" ").length >= 5);
}

export function cadenceTokenOverlapScore(a: string, b: string): number {
  const left = cadenceSimilarityTokens(a);
  const right = cadenceSimilarityTokens(b);
  if (!left.size || !right.size) return 0;
  let overlap = 0;
  for (const token of left) {
    if (right.has(token)) overlap += 1;
  }
  return overlap / Math.min(left.size, right.size);
}

export function cadenceSharesSentence(a: string, b: string): boolean {
  const left = extractComparableCadenceSentences(a);
  if (!left.length) return false;
  const right = new Set(extractComparableCadenceSentences(b));
  if (!right.size) return false;
  return left.some(sentence => right.has(sentence));
}

/**
 * The bar a lone token-overlap score has to clear to count as a repeat on its own.
 *
 * MEASURED GAP (pinned by `followup_duplicate_guard_eval`): a real production pair — the same
 * touring-payment pitch sent to +16102170861 on 2026-07-21 and again on 2026-08-01, same bike,
 * same $406/month, same ask, only reworded — scores 0.7727 and therefore does NOT trip this
 * threshold. Closing that gap needs a semantic "is this the same angle?" judgement (a typed
 * parser), not a lower number: the nearest legitimate follow-ups for that same lead (price drop,
 * new arrival, customer cash, trade appraisal) score 0.167-0.467, so the band between them is
 * where the ambiguity actually lives.
 */
export const CADENCE_NEAR_DUPLICATE_OVERLAP_MIN = 0.82;

/** Overlap required alongside a fully shared sentence, which is much stronger evidence on its own. */
export const CADENCE_SHARED_SENTENCE_OVERLAP_MIN = 0.45;

export function isCadenceNearDuplicateText(a: string, b: string): boolean {
  const left = normalizeOutboundText(a);
  const right = normalizeOutboundText(b);
  if (!left || !right) return false;
  if (left === right) return true;
  const minLen = Math.min(left.length, right.length);
  if (minLen >= 48 && (left.includes(right) || right.includes(left))) return true;
  const overlap = cadenceTokenOverlapScore(left, right);
  if (overlap >= CADENCE_NEAR_DUPLICATE_OVERLAP_MIN) return true;
  if (cadenceSharesSentence(left, right) && overlap >= CADENCE_SHARED_SENTENCE_OVERLAP_MIN) {
    return true;
  }
  return false;
}
