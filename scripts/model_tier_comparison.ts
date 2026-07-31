/**
 * Model-tier comparison harness (2026-07-31, Joe: "Is there anywhere we need to implement a more
 * powerful model in the system for better understanding?").
 *
 * ANSWERS THE QUESTION WITH THE GATE WE ALREADY TRUST. Every comprehension eval encodes correct
 * answers that Joe and the corpus already agreed on. The parser model is an env knob
 * (OPENAI_TURN_UNDERSTANDING_PARSER_MODEL, OPENAI_MODEL), so "would a stronger model understand
 * better?" needs no shadow plumbing and no production change: run the SAME evals on each tier,
 * several times, and compare pass rates.
 *
 * WHY REPETITIONS ARE THE POINT, not a nicety. The failure that motivated this was FLAKY — the
 * intent-comprehension gate failed roughly one run in three on a critical invariant while passing
 * the other two. A single run of each model would have been a coin toss reported as a finding.
 * Anything below ~3 reps cannot distinguish "better" from "lucky", so the harness refuses to
 * present a verdict it cannot support.
 *
 * DELIBERATELY NOT IN ci:eval. Every run costs real LLM calls on both tiers; this is a measurement
 * you commission, not a gate. It changes NO production code — it only sets env vars for child eval
 * processes and reads their exit codes.
 *
 * Usage:
 *   npx tsx scripts/model_tier_comparison.ts --evals harley_slang_glossary:eval,intent_comprehension:eval \
 *     --challenger gpt-5 --reps 3
 *   env: OPENAI_API_KEY (both tiers), CONTROL_MODEL (default gpt-5-mini)
 *
 * Reads results only from child exit codes — a non-zero exit is a FAIL, which is exactly the
 * contract ci:eval itself relies on.
 */
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

/** Below this, a difference cannot be told from judge/parser nondeterminism. */
export const MIN_REPS_FOR_VERDICT = 3;

export type TierResult = { model: string; passes: number; runs: number; failures: string[] };

/**
 * The verdict, kept pure so the reporting rule is pinned rather than improvised.
 *
 * Fail-direction is CONSERVATIVE: we only claim the challenger is better when it passed strictly
 * more often AND the control actually failed at least once. A tie, a regression, or too few reps
 * all read as "no evidence" — never as a recommendation to spend more per call. Recommending an
 * upgrade on noise is the expensive mistake here.
 */
export function summariseComparison(args: {
  control: TierResult;
  challenger: TierResult;
  reps: number;
}): { verdict: "challenger_better" | "no_difference" | "challenger_worse" | "insufficient_reps"; detail: string } {
  const { control, challenger, reps } = args;
  if (reps < MIN_REPS_FOR_VERDICT) {
    return {
      verdict: "insufficient_reps",
      detail: `${reps} rep(s) cannot separate a real difference from nondeterminism — need at least ${MIN_REPS_FOR_VERDICT}.`
    };
  }
  if (challenger.passes > control.passes && control.passes < control.runs) {
    return {
      verdict: "challenger_better",
      detail: `${challenger.model} passed ${challenger.passes}/${challenger.runs} vs ${control.model} ${control.passes}/${control.runs}.`
    };
  }
  if (challenger.passes < control.passes) {
    return {
      verdict: "challenger_worse",
      detail: `${challenger.model} passed ${challenger.passes}/${challenger.runs} vs ${control.model} ${control.passes}/${control.runs} — do NOT upgrade.`
    };
  }
  return {
    verdict: "no_difference",
    detail: `both tiers passed ${control.passes}/${control.runs} — this eval does not discriminate, so it is not evidence either way.`
  };
}

function runEvalOnce(evalScript: string, model: string): { ok: boolean; tail: string } {
  const res = spawnSync("npm", ["run", evalScript], {
    encoding: "utf8",
    env: {
      ...process.env,
      // Both knobs: the turn-understanding parser has its own, everything else reads OPENAI_MODEL.
      OPENAI_MODEL: model,
      OPENAI_TURN_UNDERSTANDING_PARSER_MODEL: model
    },
    maxBuffer: 64 * 1024 * 1024
  });
  const out = `${res.stdout ?? ""}${res.stderr ?? ""}`;
  const tail = out.split("\n").filter(l => /FAIL|AssertionError|Error:/i.test(l)).slice(0, 2).join(" | ");
  return { ok: res.status === 0, tail };
}

async function main() {
  const argv = process.argv.slice(2);
  const flag = (name: string, dflt = "") => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? String(argv[i + 1] ?? dflt) : dflt;
  };
  const evals = flag("evals").split(",").map(s => s.trim()).filter(Boolean);
  const challenger = flag("challenger", "gpt-5");
  const control = process.env.CONTROL_MODEL || "gpt-5-mini";
  const reps = Math.max(1, Number(flag("reps", "3")) || 3);
  if (!evals.length) {
    console.error("model_tier_comparison needs --evals <npm-script,npm-script>");
    process.exit(2);
  }
  if (!process.env.OPENAI_API_KEY) {
    console.error("model_tier_comparison needs OPENAI_API_KEY (it runs both tiers for real).");
    process.exit(2);
  }

  console.log(`Model-tier comparison — control ${control} vs challenger ${challenger}, ${reps} rep(s) each\n`);
  for (const evalScript of evals) {
    const results: Record<string, TierResult> = {};
    for (const model of [control, challenger]) {
      const r: TierResult = { model, passes: 0, runs: 0, failures: [] };
      for (let i = 0; i < reps; i += 1) {
        const { ok, tail } = runEvalOnce(evalScript, model);
        r.runs += 1;
        if (ok) r.passes += 1;
        else r.failures.push(tail || "(no failure line captured)");
        process.stdout.write(`  ${evalScript} [${model}] rep ${i + 1}/${reps}: ${ok ? "PASS" : "FAIL"}\n`);
      }
      results[model] = r;
    }
    const summary = summariseComparison({ control: results[control], challenger: results[challenger], reps });
    console.log(`\n  => ${evalScript}: ${summary.verdict.toUpperCase()} — ${summary.detail}`);
    const uniqueFailures = [...new Set(results[control].failures)].slice(0, 2);
    if (uniqueFailures.length) console.log(`     control failures: ${uniqueFailures.join(" || ")}`);
    console.log("");
  }
  console.log(
    "Reminder: a model swap is approve-first (never auto-merge) — this harness only MEASURES.\n" +
      "And check the cost side before acting: an unpriced model logs $0 (openai_usage_pricing:eval)."
  );
}

// --- self-test (no LLM calls) --------------------------------------------------------------------
if (process.argv.includes("--self-test")) {
  const assert = await import("node:assert/strict");
  const T = (model: string, passes: number, runs: number): TierResult => ({ model, passes, runs, failures: [] });
  assert.default.equal(
    summariseComparison({ control: T("c", 1, 3), challenger: T("x", 3, 3), reps: 3 }).verdict,
    "challenger_better",
    "a clear win is reported"
  );
  assert.default.equal(
    summariseComparison({ control: T("c", 3, 3), challenger: T("x", 3, 3), reps: 3 }).verdict,
    "no_difference",
    "both perfect = the eval does not discriminate, NOT a win"
  );
  assert.default.equal(
    summariseComparison({ control: T("c", 3, 3), challenger: T("x", 1, 3), reps: 3 }).verdict,
    "challenger_worse",
    "a regression is called out"
  );
  assert.default.equal(
    summariseComparison({ control: T("c", 0, 1), challenger: T("x", 1, 1), reps: 1 }).verdict,
    "insufficient_reps",
    "one rep can never produce a verdict"
  );
  // The conservative rule: a challenger cannot 'win' when the control never failed.
  assert.default.equal(
    summariseComparison({ control: T("c", 3, 3), challenger: T("x", 4, 4), reps: 3 }).verdict,
    "no_difference",
    "no win when the control had nothing to fix"
  );
  console.log("PASS model_tier_comparison self-test (verdict rules)");
} else {
  const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
  if (isMain) await main();
}
