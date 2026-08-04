/**
 * Gold-corpus SCORING — the pure core of "how good is the agent right now?"
 *
 * WHY THIS EXISTS (Joe, 2026-08-04). We already HARVEST a golden corpus: real customer turns paired
 * with the reply a named human actually sent (`tier: "human_verbatim"`) or explicitly marked good
 * (`tier: "positive_feedback"`). Both are genuine human labels. But nothing GRADED the agent
 * against it — the only consumer of the corpus was `gold_corpus_harvest_eval`, which tests the
 * HARVESTER (dedup key, split, scrub), not the agent. So the suite could answer "these 392 specific
 * things have not regressed" and could not answer "is the agent getting better."
 *
 * This module owns the pure parts so they can be pinned without an LLM or a filesystem: eligibility,
 * the vote, the aggregate, and the ratchet comparison. The runner
 * (`scripts/gold_corpus_score.ts`) does the I/O and the LLM calls.
 *
 * WHY IT VOTES. Judge verdicts here are NOT reproducible — measured 55-74% self-agreement
 * ([[judge-verdicts-are-not-reproducible]]). A single sample per item would make the headline number
 * jitter by several points run-to-run, and a ratchet on a jittering number fails the build for
 * nobody's mistake. Majority of an odd number of samples is the cheapest fix that makes the score
 * mean something.
 *
 * WHAT "CORRECT" MEANS. Not "matches the human's wording" — two good replies to "what's the price?"
 * can share no words. The judge is asked whether the agent's reply ACCOMPLISHES what the human's
 * reply accomplished: same commitment, same facts, no fabrication, no dropped question. Wording,
 * warmth, and length are explicitly not graded here; the tone scorer already owns those.
 *
 * FAIL DIRECTION. A tie or an unparseable verdict counts as NOT correct. The score is a floor we
 * ratchet UP, so the bias must be pessimistic: an over-generous score would raise the floor on
 * noise and then fail every later run.
 */

export type GoldTier = "positive_feedback" | "human_verbatim";

export type GoldExample = {
  tier?: string | null;
  convId?: string | null;
  at?: string | null;
  by?: string | null;
  inbound?: string | null;
  reply?: string | null;
};

export type GoldItemVerdict = {
  key: string;
  convId: string | null;
  tier: string | null;
  correct: boolean;
  votes: boolean[];
  why: string;
};

/**
 * A VOICE TRANSCRIPT is our own recording of a phone call, not a customer message. The harvester
 * pairs it as an "inbound" (measured 2026-08-04: 2 of 81), which produces an unanswerable item —
 * one scored pair was the IVR menu itself, *"Thank you for calling American Harley Davidson. If you
 * know your party's extension…"*. No reply can be right, so scoring it only drags the number down.
 */
const VOICE_TRANSCRIPT_SHAPE = /^Agent:\s|If you know your party's extension|press one\b/i;

/**
 * Scoreable only with BOTH sides present and a real customer turn to answer. A blank or trivial
 * inbound ("👍") has no answerable content, so grading a reply to it measures nothing.
 */
export function isScoreableGoldExample(ex: GoldExample | null | undefined): boolean {
  const inbound = String(ex?.inbound ?? "").trim();
  const reply = String(ex?.reply ?? "").trim();
  if (!inbound || !reply) return false;
  if (inbound.length < 8) return false;
  if (VOICE_TRANSCRIPT_SHAPE.test(inbound)) return false;
  return true;
}

/**
 * The items the scorer will actually grade: scoreable, and on the EVAL side of the hold-out.
 *
 * Lives here rather than inline in the runner so the selection can be pinned by CALLING it, not by
 * grepping the runner's source. A source-text assertion breaks on every legitimate refactor and — the
 * worse failure — a sloppy re-pin passes while guarding nothing; `eval_source_pin_ratchet` exists to
 * stop exactly that, and caught this on the first run.
 *
 * Scoring the TRAIN side would be marking our own homework: few-shots may draw from it.
 */
export function selectScoreableEvalItems<T extends GoldExample>(
  all: ReadonlyArray<T> | null | undefined,
  splitOf: (key: string) => "train" | "eval",
  keyOf: (ex: T) => string
): T[] {
  if (!Array.isArray(all)) return [];
  return all.filter(ex => isScoreableGoldExample(ex) && splitOf(keyOf(ex)) === "eval");
}

/** Majority of the samples, with a tie or an empty vote resolving to NOT correct (see fail direction). */
export function tallyVotes(votes: ReadonlyArray<boolean | null | undefined>): boolean {
  const cast = (votes ?? []).filter((v): v is boolean => typeof v === "boolean");
  if (!cast.length) return false;
  const yes = cast.filter(Boolean).length;
  return yes * 2 > cast.length;
}

export type GoldScoreSummary = {
  scored: number;
  correct: number;
  /** Percent 0-100, rounded to one decimal. 0 when nothing was scored. */
  score: number;
  byTier: Record<string, { scored: number; correct: number }>;
};

export function summarizeGoldScore(items: ReadonlyArray<GoldItemVerdict>): GoldScoreSummary {
  const scored = items.length;
  const correct = items.filter(i => i.correct).length;
  const byTier: Record<string, { scored: number; correct: number }> = {};
  for (const i of items) {
    const t = String(i.tier ?? "unknown");
    byTier[t] ??= { scored: 0, correct: 0 };
    byTier[t].scored += 1;
    if (i.correct) byTier[t].correct += 1;
  }
  return {
    scored,
    correct,
    score: scored ? Math.round((correct / scored) * 1000) / 10 : 0,
    byTier
  };
}

/**
 * The ratchet. A score below the floor FAILS; at or above it PASSES.
 *
 * `minScored` guards the degenerate case that has bitten every ratchet here at least once: a run
 * that scored 3 items and got them all right is not a 100%, it is a broken run, and letting it pass
 * (or worse, raise the floor) would hide exactly the outage it should surface.
 */
export function checkGoldScoreFloor(
  summary: GoldScoreSummary | null | undefined,
  floor: number,
  minScored: number
): { ok: boolean; reason: string } {
  if (!summary) return { ok: false, reason: "no score summary — the scorer has not run" };
  if (summary.scored < minScored) {
    return {
      ok: false,
      reason: `only ${summary.scored} item(s) scored, need >= ${minScored} — treat a thin run as a broken run, never as a pass`
    };
  }
  if (summary.score < floor) {
    return { ok: false, reason: `gold score ${summary.score}% is below the floor ${floor}%` };
  }
  return { ok: true, reason: `gold score ${summary.score}% >= floor ${floor}% over ${summary.scored} item(s)` };
}

/** Staleness: a score nobody has refreshed is not evidence about today's agent. */
export function isGoldScoreStale(generatedAt: string | null | undefined, nowMs: number, maxAgeHours: number): boolean {
  const t = Date.parse(String(generatedAt ?? ""));
  if (!Number.isFinite(t)) return true;
  return nowMs - t > maxAgeHours * 60 * 60 * 1000;
}

/** The judge prompt. Exported so the runner and any offline arm ask the IDENTICAL question. */
export function buildGoldEquivalencePrompt(args: { inbound: string; humanReply: string; agentReply: string }): string {
  return [
    "You are grading a dealership sales agent's reply against the reply a REAL SALESPERSON sent to",
    "the same customer message. The human reply is the reference: it is known-good.",
    "",
    "Answer ONE question: does the agent's reply ACCOMPLISH WHAT THE HUMAN'S REPLY ACCOMPLISHED?",
    "",
    "Grade on substance only:",
    "- Does it answer the same question, or make the same commitment?",
    "- Does it carry the same facts (price, availability, timing, next step)?",
    "- Does it avoid stating anything the human did not state and could not know?",
    "- Does it leave the customer able to take the same next step?",
    "",
    "Do NOT grade wording, warmth, length, or style — two good replies can share no words. A reply",
    "that reaches the same outcome by a different route is CORRECT. A reply that is pleasant but",
    "drops the question, invents a fact, or makes a different commitment is NOT correct.",
    "",
    'Return JSON: {"correct": true|false, "why": "<one short sentence>"}',
    "",
    `CUSTOMER: ${args.inbound}`,
    `HUMAN REPLY (reference, known-good): ${args.humanReply}`,
    `AGENT REPLY (grade this): ${args.agentReply}`
  ].join("\n");
}

export const GOLD_EQUIVALENCE_JSON_SCHEMA: { [key: string]: unknown } = {
  type: "object",
  additionalProperties: false,
  required: ["correct", "why"],
  properties: {
    correct: { type: "boolean" },
    why: { type: "string" }
  }
};
