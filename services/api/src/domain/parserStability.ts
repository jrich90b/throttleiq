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
 * Meaning-preserving perturbations, CALIBRATED TO WHAT CUSTOMERS ACTUALLY TYPE.
 *
 * ⚠️ THE RULE THIS SET IS BUILT ON, earned the hard way: **a perturbation must mirror something
 * real customers measurably do, and carry the measurement.** The first version of this set was
 * written from imagination and manufactured two false findings in one evening before either
 * reached a build:
 *
 *   - `polite_prefix` prefixed STATEMENTS with "Hey quick question," — a sentence that announces a
 *     question and never asks one. The reader shrugged; the sweep called it a defect. Different
 *     MEANING, not different surface. Now question-only.
 *   - `sloppy_whitespace` doubled EVERY space. The disposition reader returned `none` 5 of 5 on it
 *     and the sweep reported a live customer-facing bug. Measured against 1,872 real typed inbound
 *     messages: **0.0%** of customers type that way. Every realistic form of the same sloppiness —
 *     trailing newline, double space after a period, no punctuation at all — read correctly 5 of 5.
 *     The finding was pure artifact.
 *
 * MEASURED FREQUENCIES (1,872 real typed inbound customer messages, americanharley, 2026-08-13 —
 * web-lead envelopes and call transcripts excluded, so this is only what a person thumbed in):
 *
 *   no ending punctuation at all ....... 68.3%   <- the dominant real variation, and it was UNTESTED
 *   leading/trailing whitespace ........ 34.2%
 *   a doubled space somewhere ........... 8.6%
 *   doubled space after . ! ? ........... 5.3%
 *   a question with NO question mark .... 4.1%   <- the hiring-lead failure mode (#651)
 *   entirely lowercase .................. 3.2%
 *   every space doubled ................. 0.0%   <- REMOVED; it never happens
 *
 * Every entry below is a SURFACE change: punctuation, casing, spacing, politeness padding,
 * contraction. None changes who is asking, what they own, what they want, or when. If a reader's
 * decision moves under one of these, it was keying on surface rather than meaning — the very thing
 * AGENTS.md forbids us to do deliberately with a regex, and should equally forbid by accident.
 */
export const PERTURBATIONS: readonly Perturbation[] = [
  {
    id: "no_ending_punctuation",
    rationale:
      "68.3% of real typed messages end with no . ! or ? at all — the single most common real variation, and it was untested until 2026-08-13",
    apply: t => t.replace(/[.!?]+\s*$/, "").trimEnd()
  },
  {
    id: "drop_question_mark",
    rationale:
      "4.1% of real messages ask a question with no question mark; the hiring-lead miss (#651) turned on exactly this",
    apply: t => t.replace(/\?+(\s*)$/, "$1").trimEnd()
  },
  {
    id: "surrounding_whitespace",
    rationale: "34.2% of real messages arrive with leading or trailing whitespace; 3.5% carry a newline",
    apply: t => `  ${t}\n`
  },
  {
    id: "double_space_after_sentence",
    rationale:
      "5.3% of real messages double the space after a sentence end (the typewriter habit) — the REALISTIC form of the artifact that replaced it",
    apply: t => t.replace(/([.!?]) /g, "$1  ")
  },
  {
    id: "all_lowercase",
    rationale: "3.2% of real messages are entirely lowercase; casing carries no meaning here",
    apply: t => t.toLowerCase()
  },
  {
    id: "polite_prefix",
    // ⚠️ QUESTION-ONLY. Prefixing a STATEMENT with "Hey quick question," announces a question that
    // never arrives — that is a change of meaning, and it manufactured a false finding on this
    // sweep's first run. A test that invents its own defects is worse than no test.
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
  /** Perturbation ids where EVERY run missed — deterministic fragility, reproducible in one shot. */
  fragileUnder: string[];
  /** Perturbation ids where SOME but not all runs missed — the variant makes the reader WOBBLE. */
  unstableUnder: string[];
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
  // Per VARIANT, not per observation: a perturbation run several times can miss every time
  // (deterministic fragility) or only sometimes (the variant tips the reader into wobbling). The
  // first version ran each perturbation ONCE and so could not tell those apart — a single differing
  // run was reported as fragility when it may have been luck.
  const byVariant = new Map<string, { runs: number; misses: number }>();
  for (const o of mine) {
    if (o.variantId === "base") continue;
    const cur = byVariant.get(o.variantId) ?? { runs: 0, misses: 0 };
    cur.runs += 1;
    if (o.decision !== args.expected) cur.misses += 1;
    byVariant.set(o.variantId, cur);
  }
  const fragileUnder = [...byVariant.entries()]
    .filter(([, v]) => v.misses > 0 && v.misses === v.runs)
    .map(([k]) => k)
    .sort();
  const unstableUnder = [...byVariant.entries()]
    .filter(([, v]) => v.misses > 0 && v.misses < v.runs)
    .map(([k]) => k)
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
    unstableUnder: measured ? unstableUnder : [],
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
    if (!v.stable) return 0; // wobbles on the unchanged text: worst
    if (!v.correct) return 1; // stably wrong
    if (v.fragileUnder.length) return 2; // right, but a surface change breaks it every time
    if (v.unstableUnder.length) return 2.2; // right, but a surface change tips it into wobbling
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
    const isClean =
      v.measured && v.stable && v.correct && v.fragileUnder.length === 0 && v.unstableUnder.length === 0;
    if (!v.measured) notMeasured += 1;
    else if (!v.stable) wobbling += 1;
    else if (!v.correct) stablyWrong += 1;
    else if (v.fragileUnder.length || v.unstableUnder.length) fragile += 1;
    else clean += 1;
    byScope[v.scope].cases += 1;
    if (!isClean) byScope[v.scope].notClean += 1;
  }
  return { cases: verdicts.length, notMeasured, wobbling, stablyWrong, fragile, clean, byScope };
}
