// Comprehension gap log — write down what the agent DIDN'T understand (Joe, 2026-07-31).
//
// WHY. parserCapture logs every typed-parser call (148k records and counting), so anything a
// PARSER handled badly leaves evidence. But a deterministic path that quietly falls back leaves
// NONE: "call me next spring" never reached a parser, failed a hard-coded date match, and silently
// became due-tomorrow-9am. Zero signal across 148,000 captured calls, for months — it surfaced only
// because someone went looking at task due dates by hand.
//
// This is the other half of the flywheel: when the agent declines to act because it could not read
// something, record the phrase. Over weeks that becomes a RANKED list of real customer language the
// system can't handle, which is the evidence for whether a phrase deserves a typed parser — instead
// of guessing. It feeds the same coverage audit as parserCapture (Joe 2026-07-29: variations go in
// EVALS; a prompt few-shot only when a row actually FAILS).
//
// SCOPE, deliberately narrow: this records a KNOWN give-up — we noticed we didn't understand. A
// path that confidently does the wrong thing is invisible here and stays the job of the corpus
// replay and open-critic nets. Recording a gap must never become a way to "handle" one.
//
// Fail-direction: pure logging, exactly like parserCapture. Every error is swallowed; a logging bug
// can never touch the live customer path. Worst case is a missing day of evidence. NEVER add
// behavior here that the reply or task path depends on.
//
// Storage: daily JSONL under COMPREHENSION_GAP_DIR (or REPORT_ROOT/comprehension_gaps). Records are
// SMALL by design (a phrase, not a transcript) — no prompt bodies, no message history, so this adds
// a rounding error next to parserCapture's 1.5GB. Kill switch: COMPREHENSION_GAP_LOG_DISABLED=1.
import fs from "node:fs";

/** A phrase longer than this is not a phrase — record the head and move on. */
export const COMPREHENSION_GAP_PHRASE_CAP = 400;

export type ComprehensionGapRecord = {
  at: string;
  /** Where we gave up, e.g. "callback_timeframe". Groups the report. */
  site: string;
  /** The customer/staff text we could not resolve. */
  phrase: string;
  phraseTruncated: boolean;
  /** What we did INSTEAD — the honest consequence, e.g. "left_undated". */
  outcome: string;
  convId?: string;
};

export function buildComprehensionGapRecord(args: {
  at: string;
  site: string;
  phrase: unknown;
  outcome: string;
  convId?: string | null;
}): ComprehensionGapRecord {
  const phraseRaw = String(args.phrase ?? "").replace(/\s+/g, " ").trim();
  const phraseTruncated = phraseRaw.length > COMPREHENSION_GAP_PHRASE_CAP;
  const convId = String(args.convId ?? "").trim();
  return {
    at: String(args.at ?? ""),
    site: String(args.site ?? "").trim() || "unknown",
    phrase: phraseTruncated ? phraseRaw.slice(0, COMPREHENSION_GAP_PHRASE_CAP) : phraseRaw,
    phraseTruncated,
    outcome: String(args.outcome ?? "").trim() || "unknown",
    ...(convId ? { convId } : {})
  };
}

/**
 * Where gap records go, or null when logging is off. Pure on its env input so the eval can pin the
 * precedence: kill switch wins; explicit dir beats REPORT_ROOT; no configured root → off, so a dev
 * machine never accumulates files.
 */
export function resolveComprehensionGapDir(env: {
  COMPREHENSION_GAP_LOG_DISABLED?: string;
  COMPREHENSION_GAP_DIR?: string;
  REPORT_ROOT?: string;
}): string | null {
  if (String(env.COMPREHENSION_GAP_LOG_DISABLED ?? "") === "1") return null;
  const explicit = String(env.COMPREHENSION_GAP_DIR ?? "").trim();
  if (explicit) return explicit;
  const root = String(env.REPORT_ROOT ?? "").trim();
  if (root) return `${root}/comprehension_gaps`;
  return null;
}

export function appendComprehensionGapRecord(record: ComprehensionGapRecord): void {
  try {
    // An empty phrase is not evidence of anything — recording it would only add noise to the
    // ranked report and dilute the counts that decide whether a parser is worth building.
    if (!record.phrase) return;
    const dir = resolveComprehensionGapDir(process.env as any);
    if (!dir) return;
    fs.mkdirSync(dir, { recursive: true });
    const day = record.at.slice(0, 10).replace(/-/g, "") || "unknown";
    fs.appendFileSync(`${dir}/comprehension_gaps_${day}.jsonl`, `${JSON.stringify(record)}\n`);
  } catch {
    // best-effort by design — the gap log must never disturb the live path
  }
}

/** Convenience wrapper: build + append in one call, still swallowing every error. */
export function recordComprehensionGap(args: {
  site: string;
  phrase: unknown;
  outcome: string;
  convId?: string | null;
  at?: string;
}): void {
  try {
    appendComprehensionGapRecord(
      buildComprehensionGapRecord({ ...args, at: args.at ?? new Date().toISOString() })
    );
  } catch {
    // unreachable in practice; belt and braces so no caller ever needs a try/catch
  }
}

/**
 * Group raw records into the ranked view the report prints: most-frequent unrecognised phrasing
 * first, so "is this worth a parser?" is answered by volume rather than by whoever noticed it.
 *
 * Phrases are normalised (lowercased, whitespace-collapsed) ONLY for grouping; the first raw
 * spelling seen is kept as the example, because the exact wording is what a future eval row needs.
 */
export type ComprehensionGapGroup = {
  site: string;
  phrase: string;
  count: number;
  convIds: string[];
  firstSeenAt: string;
  lastSeenAt: string;
};

export function groupComprehensionGaps(
  records: readonly ComprehensionGapRecord[] | null | undefined
): ComprehensionGapGroup[] {
  const byKey = new Map<string, ComprehensionGapGroup>();
  for (const r of records ?? []) {
    if (!r || !String(r.phrase ?? "").trim()) continue;
    const site = String(r.site ?? "unknown");
    const norm = String(r.phrase).toLowerCase().replace(/\s+/g, " ").trim();
    const key = `${site}::${norm}`;
    const at = String(r.at ?? "");
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, {
        site,
        phrase: String(r.phrase),
        count: 1,
        convIds: r.convId ? [String(r.convId)] : [],
        firstSeenAt: at,
        lastSeenAt: at
      });
      continue;
    }
    existing.count += 1;
    if (r.convId && !existing.convIds.includes(String(r.convId))) existing.convIds.push(String(r.convId));
    if (at && (!existing.firstSeenAt || at < existing.firstSeenAt)) existing.firstSeenAt = at;
    if (at && (!existing.lastSeenAt || at > existing.lastSeenAt)) existing.lastSeenAt = at;
  }
  return [...byKey.values()].sort((a, b) => b.count - a.count || a.phrase.localeCompare(b.phrase));
}
