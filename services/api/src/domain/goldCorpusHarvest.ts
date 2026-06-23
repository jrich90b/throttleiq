/**
 * Gold-corpus incremental harvest — pure core. The nightly runner
 * (scripts/gold_corpus_harvest_incremental.ts) finds NEW takeovers since the last watermark, scores
 * them with the context-fidelity scorer, and appends the scorer-confirmed ones (scrubbed) to a
 * GITIGNORED store. Promotion into the committed golden corpus stays approve-first (+ the LLM-NER pass).
 *
 * This module owns the pure, testable pieces: a stable dedup key, the deterministic train/eval split,
 * the harvest predicate, and the regex PII scrub. No I/O, no LLM.
 */

/** FNV-1a 32-bit hex — deterministic, dependency-free. */
export function hashString(s: string): string {
  let h = 0x811c9dc5;
  const str = String(s ?? "");
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

const norm = (x: string) => String(x ?? "").toLowerCase().replace(/\s+/g, " ").trim();

/** Word-set Jaccard similarity (0..1). */
export function jaccard(a: string, b: string): number {
  const na = norm(a).replace(/[^\w\s]/g, ""), nb = norm(b).replace(/[^\w\s]/g, "");
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  const sa = new Set(na.split(" ")), sb = new Set(nb.split(" "));
  let inter = 0;
  for (const w of sa) if (sb.has(w)) inter++;
  return inter / (sa.size + sb.size - inter);
}

/** A staff EDIT (originalDraftBody -> sent body) is a CORRECTION worth harvesting only when the human
 *  meaningfully changed the answer — not a light touch-up. Below maxJac = the substance changed. */
export function isSubstantiveEdit(originalDraft: string, sent: string, maxJac = 0.6): boolean {
  const o = norm(originalDraft), s = norm(sent);
  if (!o || !s || o === s) return false;
  return jaccard(o, s) < maxJac;
}

/** Stable identity for a (conversation, draft) pair — survives re-runs so we never re-harvest one. */
export function pairKey(convId: string, draftBody: string): string {
  return hashString(`${norm(convId)}|${norm(draftBody)}`);
}

/** Deterministic train/eval assignment from the key — so a pair's split never changes between runs,
 *  and fixtures used as few-shots can't leak into the held-out eval slice. */
export function splitFor(key: string, evalFraction = 0.2): "train" | "eval" {
  const h = parseInt(hashString(key), 16) / 0xffffffff;
  return h < evalFraction ? "eval" : "train";
}

/** The intersection filter — only a confident, genuine out-of-context error becomes a gold pair.
 *  Mirrors the hold trigger so the corpus matches what the gate would act on. */
export function shouldHarvestPair(
  score: { verdict?: string; confidence?: number } | null | undefined,
  minConfidence = 0.8
): boolean {
  if (!score) return false;
  const conf = typeof score.confidence === "number" ? score.confidence : 0;
  return score.verdict === "out_of_context" && conf >= minConfidence;
}

/** Regex PII scrub applied at harvest time (the store is gitignored/transient; the heavier LLM-NER
 *  pass runs only at approve-first promotion before any permanent commit). */
export function scrubText(s: string): string {
  let t = String(s ?? "");
  t = t.replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "[EMAIL]");
  t = t.replace(/\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g, "[PHONE]").replace(/\b\d{10,}\b/g, "[PHONE]");
  t = t.replace(/^(Name|Email|Phone|Customer|Contact)\s*:.*$/gim, "$1: [REDACTED]");
  const STOP = new Set(["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday", "today", "tomorrow", "tonight", "yes", "no", "sure", "ok", "okay", "thanks", "thank", "harley", "davidson", "road", "street", "fat", "glide", "boy", "bob", "sportster", "heritage", "breakout", "king", "tri", "cvo", "ultra", "classic", "special", "limited", "american", "i", "the"]);
  const repl = (lead: string, name: string) => (STOP.has(name.toLowerCase()) ? `${lead} ${name}` : `${lead} [NAME]`);
  t = t.replace(/\b(hi|hey|hello|dear|hiya|thanks|thank you|no rush|sounds good|congrats|congratulations|welcome|got it|cheers|appreciate it)\b[\s,]+([A-Z][a-zA-Z'’.-]+)/gi, (_m, l, n) => repl(l, n));
  t = t.replace(/\bthis is\s+([A-Z][a-zA-Z'’.-]+)/gi, (_m, n) => (STOP.has(String(n).toLowerCase()) ? `this is ${n}` : "this is [NAME]"));
  t = t.replace(/\b(i'?m|i am|it'?s)\s+([A-Z][a-z]+)\b/g, (_m, l, n) => repl(l, n));
  t = t.replace(/([,;])\s+([A-Z][a-z]{2,})\b(?!\s+[A-Za-z])/g, (m, p, n) => (STOP.has(String(n).toLowerCase()) ? m : `${p} [NAME]`));
  return t.trim();
}
