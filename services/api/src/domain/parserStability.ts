/**
 * Parser stability + perturbation: the pure half.
 *
 * WHY THIS EXISTS (measured 2026-08-12, two production incidents in the same week).
 *
 * 1. Michael McGary (+17165502654) asked the SERVICE widget "Can I ask what is going on with my
 *    2026 street glide?" and got a sales-vs-service clarify. Re-run on his EXACT text the reader
 *    answered correctly 4 times out of 4 — and over ten runs it returned the clarify twice. Nothing
 *    in the 494-eval gate could see that, because every eval asks its question ONCE.
 * 2. A job applicant was filed as a bike shopper. The reader had him right 6 times out of 6, and a
 *    MISSING QUESTION MARK threw the correct read away.
 *
 * Those are the two failure shapes this module measures, and neither is "the reader is wrong":
 *   - WOBBLE: identical input, different decision run to run.
 *   - FRAGILITY: same meaning, trivially different surface, different decision.
 *
 * ⚠️ This can never live in the merge gate. Repeat-sampling an LLM is probabilistic by construction,
 * and a probabilistic assertion in `ci:eval` red-lines main on bad luck for everyone (the n=3 judge
 * incident, 2026-08-07). It runs as a SWEEP that reports; individual cases graduate into the gate
 * only once measured stable. `parser_stability_sweep_eval.ts` pins THIS module's pure logic
 * deterministically, with no API key, and that eval is what the gate runs.
 *
 * TEMPERATURE NOTE. The obvious fix for wobble — pin temperature at 0 — is NOT available: the
 * parsers run on gpt-5-mini, and `modelSupportsTemperature` omits the parameter for every gpt-5
 * model because the API rejects it. So wobble cannot be switched off; it has to be MEASURED, and
 * defended against with repeat-sampling on the decisions that matter. Note also that temperature 0
 * would buy repeatability, not correctness: McGary's case would have failed 10/10 instead of 2/10.
 */

/** A surface-only rewrite of a customer message. Meaning must be untouched. */
export type Perturbation = {
  id: string;
  /** Why this is meaning-preserving — stated so a reviewer can check the claim, not trust it. */
  rationale: string;
  apply: (text: string) => string;
};

/**
 * Meaning-preserving perturbations, drawn from what real customers actually do.
 *
 * Every one of these is a SURFACE change: punctuation, casing, politeness padding, contraction.
 * None of them changes who is asking, what they own, what they want, or when. If a reader's
 * decision moves under one of these, the reader was keying on the surface, not the meaning — which
 * is the thing AGENTS.md forbids us from doing with a regex and should equally forbid by accident.
 */
export const PERTURBATIONS: readonly Perturbation[] = [
  {
    id: "drop_question_mark",
    rationale:
      "customers routinely omit it; the hiring-lead miss (+17165... 2026-08-11) turned on exactly this",
    apply: t => t.replace(/\?+(\s*)$/, "$1").trimEnd()
  },
  {
    id: "all_lowercase",
    rationale: "phone keyboards autocorrect inconsistently; casing carries no meaning here",
    apply: t => t.toLowerCase()
  },
  {
    id: "polite_prefix",
    // ⚠️ QUESTION-ONLY, and that carve-out was earned on this sweep's first real run. The original
    // version prefixed EVERYTHING with "Hey quick question," — including the statement "Found a
    // better offer. Thanks", producing "Hey quick question, found a better offer. Thanks". The
    // disposition reader returned `none` on that, 3 runs of 3, and the sweep called it a defect.
    // It is not: that sentence ANNOUNCES a question and then never asks one, so the reader had been
    // handed different meaning, not different surface. The perturbation was wrong, not the reader.
    // A test that manufactures its own findings is worse than no test.
    rationale: "'hey quick question' adds courtesy, not content — but only in front of an actual question",
    apply: t =>
      /\?\s*$/.test(t)
        ? `Hey quick question, ${t.charAt(0).toLowerCase()}${t.slice(1)}`
        : `Hey — ${t.charAt(0).toLowerCase()}${t.slice(1)}`
  },
  {
    id: "trailing_thanks",
    rationale: "a sign-off is not an intent; the courtesy-word miss (#588) came from reading one as one",
    apply: t => `${t.trimEnd()} Thanks!`
  },
  {
    id: "expand_contractions",
    rationale: "'what's' and 'what is' are the same question",
    apply: t =>
      t
        .replace(/\bwhat's\b/gi, m => (m[0] === "W" ? "What is" : "what is"))
        .replace(/\bI'm\b/g, "I am")
        .replace(/\bdon't\b/gi, m => (m[0] === "D" ? "Do not" : "do not"))
        .replace(/\bit's\b/gi, m => (m[0] === "I" ? "It is" : "it is"))
  },
  {
    id: "sloppy_whitespace",
    rationale: "double spaces and a stray newline are typing artifacts, not meaning",
    apply: t => t.replace(/ /g, "  ").replace(/([.?!])\s/g, "$1\n")
  }
];

/**
 * The decision a reader that could not run at all reports. It is NOT a wrong answer — it is the
 * absence of one, and the two must never be confused.
 *
 * Measured 2026-08-12, first run of this sweep: both booking cases came back `parse_failed` six
 * times and the report called them "stably WRONG". The booking parser is flag-gated
 * (`LLM_BOOKING_PARSER_ENABLED`), the flag is `1` in production and unset on a dev box — so the
 * sweep had measured a switch, not a reader, and said "wrong" about code that is fine. That is the
 * same shape as the two instrument mis-diagnoses this month (the walk-in lane wrongly silenced, the
 * vendor feed wrongly alarmed): the COUNTING was right and the CONCLUSION was backwards.
 *
 * So an unrunnable reader reads NOT MEASURED, and not-measured never rounds up to clean or down to
 * wrong — the same discipline the readiness bar uses.
 */
export const PARSE_FAILED = "parse_failed";

/** One decision observed once. `decision` is the BRANCH the system takes, never the raw label. */
export type StabilityObservation = {
  caseId: string;
  variantId: string;
  decision: string;
};

export type CaseVerdict = {
  caseId: string;
  /** How far back the evidence for this decision lives — the "evidence scope" dimension. */
  scope: EvidenceScope;
  expected: string;
  /** Distinct decisions seen on the UNCHANGED text, and how often each occurred. */
  baseDecisions: Record<string, number>;
  baseRuns: number;
  /** false when the reader could not run at all (flag off, no key) — never "wrong", never "clean". */
  measured: boolean;
  /** true when every run of the unchanged text agreed. Meaningless when `measured` is false. */
  stable: boolean;
  /** true when the agreed decision is also the right one. Stable-and-wrong is still wrong. */
  correct: boolean;
  /** Perturbation ids whose decision differed from the expected decision. */
  fragileUnder: string[];
  /** Worst-case: the share of ALL observations (base + perturbed) that missed `expected`. */
  missRate: number;
};

/**
 * How much history a decision needs. Lens 2 of the reading-comprehension framework, and the
 * dimension our error corpus says matters most: of 219 confirmed genuine agent errors, 211 (96%)
 * are frame `stale_intent` / `dropped_anchor` / `over_attached_model` — all three are failures to
 * apply the RIGHT slice of history, not failures to read one sentence.
 */
export type EvidenceScope = "single_turn" | "needs_history";

/**
 * Fold observations into one verdict per case. Pure — the sweep does the I/O, this does the maths,
 * and the eval can therefore prove the maths with a stubbed parser and no API key.
 *
 * A case is only GREEN when it is both stable and correct: an unwavering wrong answer is the worse
 * failure, because nothing downstream will ever flag it.
 */
export function summarizeCase(args: {
  caseId: string;
  scope: EvidenceScope;
  expected: string;
  observations: readonly StabilityObservation[];
}): CaseVerdict {
  const mine = args.observations.filter(o => o.caseId === args.caseId);
  const base = mine.filter(o => o.variantId === "base");
  const baseDecisions: Record<string, number> = {};
  for (const o of base) baseDecisions[o.decision] = (baseDecisions[o.decision] ?? 0) + 1;
  // A reader that never ran teaches us nothing in either direction.
  const measured = base.length > 0 && !base.some(o => o.decision === PARSE_FAILED);
  const distinct = Object.keys(baseDecisions);
  const stable = distinct.length === 1;
  const correct = stable && distinct[0] === args.expected;
  const fragileUnder = mine
    .filter(o => o.variantId !== "base" && o.decision !== args.expected)
    .map(o => o.variantId)
    .filter((v, i, a) => a.indexOf(v) === i)
    .sort();
  const misses = mine.filter(o => o.decision !== args.expected).length;
  return {
    caseId: args.caseId,
    scope: args.scope,
    expected: args.expected,
    baseDecisions,
    baseRuns: base.length,
    measured,
    stable: measured && stable,
    correct: measured && correct,
    fragileUnder: measured ? fragileUnder : [],
    missRate: measured && mine.length ? misses / mine.length : 0
  };
}

/**
 * Rank the verdicts worst-first so the report leads with what to fix.
 *
 * Order is deliberate: WOBBLE outranks fragility, because an unstable reader cannot be reasoned
 * about at all — you cannot even reproduce its bug (McGary took ten runs to catch). A stable reader
 * that breaks under a dropped question mark is at least diagnosable in one run.
 */
export function rankVerdicts(verdicts: readonly CaseVerdict[]): CaseVerdict[] {
  const rank = (v: CaseVerdict): number => {
    if (!v.measured) return 2.5; // a gap in coverage: below the real defects, above a clean pass
    if (!v.stable) return 0; // wobbles: worst
    if (!v.correct) return 1; // stably wrong
    if (v.fragileUnder.length) return 2; // right, but breaks on surface changes
    return 3; // clean
  };
  return [...verdicts].sort(
    (a, b) => rank(a) - rank(b) || b.missRate - a.missRate || a.caseId.localeCompare(b.caseId)
  );
}

/** Sweep-level roll-up. Counts only; the sweep decides what to print. */
export function summarizeSweep(verdicts: readonly CaseVerdict[]): {
  cases: number;
  notMeasured: number;
  wobbling: number;
  stablyWrong: number;
  fragile: number;
  clean: number;
  byScope: Record<EvidenceScope, { cases: number; notClean: number }>;
} {
  const byScope: Record<EvidenceScope, { cases: number; notClean: number }> = {
    single_turn: { cases: 0, notClean: 0 },
    needs_history: { cases: 0, notClean: 0 }
  };
  let notMeasured = 0;
  let wobbling = 0;
  let stablyWrong = 0;
  let fragile = 0;
  let clean = 0;
  for (const v of verdicts) {
    const isClean = v.measured && v.stable && v.correct && v.fragileUnder.length === 0;
    if (!v.measured) notMeasured += 1;
    else if (!v.stable) wobbling += 1;
    else if (!v.correct) stablyWrong += 1;
    else if (v.fragileUnder.length) fragile += 1;
    else clean += 1;
    byScope[v.scope].cases += 1;
    if (!isClean) byScope[v.scope].notClean += 1;
  }
  return { cases: verdicts.length, notMeasured, wobbling, stablyWrong, fragile, clean, byScope };
}
