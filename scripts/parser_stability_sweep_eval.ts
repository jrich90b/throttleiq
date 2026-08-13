/**
 * Parser stability + perturbation — the deterministic gate half.
 *
 * The SWEEP itself (scripts/parser_stability_sweep.ts) is LLM-priced and probabilistic, so it can
 * never run in ci:eval — a random assertion in the merge gate red-lines main on bad luck for
 * everyone (the n=3 judge incident, 2026-08-07). What CAN be pinned, with no API key and no
 * randomness, is the machinery: the perturbations really are meaning-preserving, and the maths
 * really does detect wobble.
 *
 * This eval EXECUTES that machinery against a stubbed reader that deliberately misbehaves. A
 * source-text assertion could not prove any of it — `tsc` does not cover scripts/, and a sweep that
 * silently stopped detecting anything would still "pass" a grep.
 *
 * Run: npx tsx scripts/parser_stability_sweep_eval.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  PARSE_FAILED,
  PERTURBATIONS,
  rankVerdicts,
  summarizeCase,
  summarizeSweep,
  type StabilityObservation
} from "../services/api/src/domain/parserStability.ts";

// --- The perturbations are surface-only, and each one actually does something ---
{
  // A battery, not one sentence: a contraction expander correctly does NOTHING to a sentence with
  // no contractions, so demanding every rewrite alter one fixed string is the wrong bar. Each
  // perturbation must bite on at least one realistic message, and must preserve meaning on all of
  // them. (The sweep skips no-op variants at runtime for the same reason.)
  const PROBES = [
    "Can I ask what is going on with my 2026 street glide?",
    "What's the price on my 2026 street glide?",
    "I'm asking about my 2026 street glide",
    // Carries a MID-MESSAGE sentence break, so the double-space-after-a-period rewrite has
    // something to bite on — without it that perturbation is a silent no-op on every probe.
    "Thanks for the help. I am still thinking about my 2026 street glide"
  ];
  const seen = new Set<string>();
  for (const p of PERTURBATIONS) {
    assert.ok(p.id && !seen.has(p.id), `perturbation ids are unique: ${p.id}`);
    seen.add(p.id);
    assert.ok(p.rationale.trim().length > 20, `${p.id} states WHY it preserves meaning`);
    // ⚠️ Every perturbation must mirror something customers MEASURABLY do, and carry the number.
    // The set was rebuilt on 2026-08-13 after `sloppy_whitespace` (0.0% of 1,872 real messages)
    // manufactured a false customer-facing finding. A percentage in the rationale is the receipt.
    if (["no_ending_punctuation", "drop_question_mark", "surrounding_whitespace", "double_space_after_sentence", "all_lowercase"].includes(p.id)) {
      assert.match(p.rationale, /\d+(?:\.\d+)?%/, `${p.id} carries its MEASURED real-world frequency`);
    }
    const outs = PROBES.map(t => p.apply(t));
    assert.ok(
      outs.some((out, i) => out !== PROBES[i]),
      `${p.id} bites on at least one realistic message (a rewrite that never fires proves nothing)`
    );
    // Meaning-bearing content must survive EVERY probe: the possessive, the year, and the model.
    for (const out of outs) {
      const flat = out.toLowerCase().replace(/\s+/g, " ");
      assert.ok(flat.includes("my"), `${p.id} keeps the possessive — that word IS the meaning here`);
      assert.ok(flat.includes("2026"), `${p.id} keeps the year`);
      assert.ok(flat.includes("street glide"), `${p.id} keeps the model`);
    }
  }
  // The specific perturbation that broke a real production read.
  const dropped = PERTURBATIONS.find(p => p.id === "drop_question_mark")!;
  assert.equal(
    dropped.apply("are the motorcycles provided?"),
    "are the motorcycles provided",
    "drop_question_mark removes the mark and nothing else (the hiring-lead failure mode)"
  );
  assert.equal(
    dropped.apply("no question mark here"),
    "no question mark here",
    "…and is a no-op when there is no mark to drop"
  );
}

// --- The maths detects WOBBLE (the McGary shape) ---
{
  // Eight runs of identical text, two of which flip — exactly the 2-in-10 that shipped to a customer.
  const obs: StabilityObservation[] = [
    ...Array.from({ length: 6 }, () => ({ caseId: "c", variantId: "base", decision: "plain_dept_ack" })),
    { caseId: "c", variantId: "base", decision: "bike_clarify" },
    { caseId: "c", variantId: "base", decision: "bike_clarify" }
  ];
  const v = summarizeCase({ caseId: "c", scope: "single_turn", expected: "plain_dept_ack", observations: obs });
  assert.equal(v.stable, false, "identical input giving two different decisions is NOT stable");
  assert.equal(v.correct, false, "a wobbling reader is never scored correct, even on the majority answer");
  assert.equal(v.baseRuns, 8, "every base run is counted");
  assert.deepEqual(v.baseDecisions, { plain_dept_ack: 6, bike_clarify: 2 }, "both decisions are reported with counts");
  assert.equal(Math.round(v.missRate * 100), 25, "miss rate is 2 of 8");
}

// --- FRAGILITY (breaks every time) vs WOBBLE-UNDER-A-VARIANT (breaks sometimes) ---
// Running a perturbation ONCE cannot tell these apart, and the first version of the sweep did
// exactly that — reporting a single differing run as a defect. They need different fixes: a
// deterministic break is a rule the reader is missing; an intermittent one is instability.
{
  const obs: StabilityObservation[] = [
    ...Array.from({ length: 4 }, () => ({ caseId: "c", variantId: "base", decision: "hiring_lead" })),
    // 3 of 3 miss => deterministic fragility, reproducible in one shot.
    ...Array.from({ length: 3 }, () => ({ caseId: "c", variantId: "drop_question_mark", decision: "sales_lead" })),
    // 1 of 3 miss => the variant tips the reader into wobbling, not a clean break.
    { caseId: "c", variantId: "no_ending_punctuation", decision: "sales_lead" },
    { caseId: "c", variantId: "no_ending_punctuation", decision: "hiring_lead" },
    { caseId: "c", variantId: "no_ending_punctuation", decision: "hiring_lead" },
    // 0 of 3 miss => clean.
    ...Array.from({ length: 3 }, () => ({ caseId: "c", variantId: "all_lowercase", decision: "hiring_lead" }))
  ];
  const v = summarizeCase({ caseId: "c", scope: "single_turn", expected: "hiring_lead", observations: obs });
  assert.equal(v.stable, true, "the unchanged text was perfectly stable…");
  assert.equal(v.correct, true, "…and correct…");
  assert.deepEqual(
    v.fragileUnder,
    ["drop_question_mark"],
    "…yet a dropped question mark breaks it EVERY time — the hiring-lead failure mode (#651)"
  );
  assert.deepEqual(
    v.unstableUnder,
    ["no_ending_punctuation"],
    "…and a variant that misses only sometimes is reported as wobble, never as a clean break"
  );
  assert.ok(!v.fragileUnder.includes("all_lowercase"), "a variant that never misses is not reported at all");
}

// --- STABLE AND WRONG is still wrong (the trap temperature-0 would hide) ---
{
  const obs: StabilityObservation[] = Array.from({ length: 6 }, () => ({
    caseId: "c",
    variantId: "base",
    decision: "bike_clarify"
  }));
  const v = summarizeCase({ caseId: "c", scope: "single_turn", expected: "plain_dept_ack", observations: obs });
  assert.equal(v.stable, true, "six identical answers are stable");
  assert.equal(v.correct, false, "but they are the WRONG answer — stability is not correctness");
  assert.equal(v.missRate, 1, "and every observation missed");
}

// --- NOT MEASURED is not WRONG (the first run of this sweep got this backwards) ---
// The booking parser is flag-gated. On a dev box with the flag unset it returns null six times, and
// the sweep's first version reported "stably WRONG" — a verdict about a switch, dressed as a verdict
// about the reader. Not-measured must round neither up to clean nor down to wrong.
{
  const obs: StabilityObservation[] = Array.from({ length: 6 }, () => ({
    caseId: "c",
    variantId: "base",
    decision: PARSE_FAILED
  }));
  const v = summarizeCase({ caseId: "c", scope: "single_turn", expected: "wants_a_time", observations: obs });
  assert.equal(v.measured, false, "a reader that never ran is NOT measured");
  assert.equal(v.correct, false, "…so it is never scored correct…");
  assert.equal(v.stable, false, "…and never scored stable — six identical failures are not agreement");
  assert.equal(v.missRate, 0, "…and it contributes no miss rate, because it measured nothing");
  assert.deepEqual(v.fragileUnder, [], "…and cannot be called fragile");

  // One failed run among good ones still poisons the case: we cannot tell which reader we measured.
  const mixed = summarizeCase({
    caseId: "m",
    scope: "single_turn",
    expected: "wants_a_time",
    observations: [
      { caseId: "m", variantId: "base", decision: "wants_a_time" },
      { caseId: "m", variantId: "base", decision: PARSE_FAILED }
    ]
  });
  assert.equal(mixed.measured, false, "any failed base run makes the whole case unmeasured");

  const s = summarizeSweep([v]);
  assert.equal(s.notMeasured, 1, "the roll-up counts it as a coverage gap…");
  assert.equal(s.stablyWrong, 0, "…not as a defect…");
  assert.equal(s.clean, 0, "…and not as a pass");
  assert.equal(s.notMeasured + s.wobbling + s.stablyWrong + s.fragile + s.clean, s.cases, "buckets still partition");
}

// --- A clean case reads clean ---
{
  const obs: StabilityObservation[] = [
    ...Array.from({ length: 6 }, () => ({ caseId: "c", variantId: "base", decision: "plain_dept_ack" })),
    ...PERTURBATIONS.map(p => ({ caseId: "c", variantId: p.id, decision: "plain_dept_ack" }))
  ];
  const v = summarizeCase({ caseId: "c", scope: "single_turn", expected: "plain_dept_ack", observations: obs });
  assert.equal(v.stable && v.correct, true, "a clean reader is stable and correct");
  assert.deepEqual(v.fragileUnder, [], "…and fragile under nothing");
  assert.equal(v.missRate, 0, "…with a zero miss rate");
}

// --- Observations from OTHER cases never leak in ---
{
  const obs: StabilityObservation[] = [
    { caseId: "mine", variantId: "base", decision: "a" },
    { caseId: "theirs", variantId: "base", decision: "b" },
    { caseId: "theirs", variantId: "drop_question_mark", decision: "b" }
  ];
  const v = summarizeCase({ caseId: "mine", scope: "single_turn", expected: "a", observations: obs });
  assert.equal(v.baseRuns, 1, "only this case's runs are counted");
  assert.equal(v.correct, true, "another case's disagreement cannot make mine wrong");
  assert.deepEqual(v.fragileUnder, [], "…nor make mine fragile");
}

// --- Ranking leads with what to fix: wobble > stably-wrong > fragile > clean ---
{
  const mk = (caseId: string, obs: StabilityObservation[], expected: string) =>
    summarizeCase({ caseId, scope: "single_turn", expected, observations: obs });
  const clean = mk("d_clean", [{ caseId: "d_clean", variantId: "base", decision: "x" }], "x");
  const fragile = mk(
    "c_fragile",
    [
      { caseId: "c_fragile", variantId: "base", decision: "x" },
      { caseId: "c_fragile", variantId: "all_lowercase", decision: "y" }
    ],
    "x"
  );
  const wrong = mk("b_wrong", [{ caseId: "b_wrong", variantId: "base", decision: "y" }], "x");
  const wobble = mk(
    "a_wobble",
    [
      { caseId: "a_wobble", variantId: "base", decision: "x" },
      { caseId: "a_wobble", variantId: "base", decision: "y" }
    ],
    "x"
  );
  const ranked = rankVerdicts([clean, fragile, wrong, wobble]).map(v => v.caseId);
  assert.deepEqual(
    ranked,
    ["a_wobble", "b_wrong", "c_fragile", "d_clean"],
    `worst-first: an unstable reader cannot even be reproduced, so it outranks everything — got ${ranked.join(" > ")}`
  );
}

// --- The roll-up counts every case exactly once, and splits by evidence scope ---
{
  const one = (caseId: string, scope: "single_turn" | "needs_history", decisions: string[], expected: string) =>
    summarizeCase({
      caseId,
      scope,
      expected,
      observations: decisions.map(d => ({ caseId, variantId: "base", decision: d }))
    });
  const verdicts = [
    one("w", "single_turn", ["x", "y"], "x"), // wobbling
    one("s", "needs_history", ["y", "y"], "x"), // stably wrong
    one("c", "needs_history", ["x", "x"], "x") // clean
  ];
  const s = summarizeSweep(verdicts);
  assert.equal(s.cases, 3, "every case counted");
  assert.equal(s.wobbling + s.stablyWrong + s.fragile + s.clean, s.cases, "buckets partition the cases — none double-counted, none lost");
  assert.equal(s.wobbling, 1);
  assert.equal(s.stablyWrong, 1);
  assert.equal(s.clean, 1);
  assert.deepEqual(s.byScope.single_turn, { cases: 1, notClean: 1 }, "single-turn split");
  assert.deepEqual(
    s.byScope.needs_history,
    { cases: 2, notClean: 1 },
    "needs-history split — the dimension our error corpus says dominates (211 of 219 genuine errors)"
  );
}

// --- The sweep script is real, runnable, and NOT wired into the merge gate ---
{
  const sweep = path.resolve("scripts/parser_stability_sweep.ts");
  assert.ok(fs.existsSync(sweep), "the sweep script exists");
  const src = fs.readFileSync(sweep, "utf8");
  assert.ok(src.includes("await main()"), "the sweep actually runs when invoked");
  assert.ok(
    src.includes("summarizeCase") && src.includes("rankVerdicts") && src.includes("PERTURBATIONS"),
    "the sweep uses this module's logic rather than a private copy that could drift"
  );
  const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
  const chain = String(pkg.scripts?.["ci:eval"] ?? "");
  assert.ok(
    chain.includes("parser_stability_sweep:eval"),
    "the DETERMINISTIC half is wired into ci:eval"
  );
  assert.ok(
    !/npm run parser_stability_sweep(?!:eval)/.test(chain),
    "the probabilistic SWEEP is NOT in the merge gate — repeat-sampling an LLM there red-lines main on bad luck"
  );
  assert.ok(pkg.scripts?.["parser_stability_sweep"], "…but it is runnable on demand");
}

console.log(
  "PASS parser stability sweep eval (meaning-preserving perturbations + wobble/fragility/stably-wrong detection + worst-first ranking + scope split + not-in-gate)"
);
