/**
 * Corpus replay flywheel eval — runs the flywheel's pure self-test (scoring, baseline diff,
 * findings shape, judge gating; no network) and guards the wiring contracts: the judge and
 * actionability filter are SHARED with the nightly intent-handled audit (same semantics in the
 * offline flywheel and the live net), and findings carry the OutcomeAnomaly essentials
 * (occurredAt for stale-suppression, category, convId) so the next.json fold can consume them.
 *
 * Run: npx tsx scripts/corpus_replay_flywheel_eval.ts
 */
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import fs from "node:fs";

const out = execFileSync("npx", ["tsx", "scripts/corpus_replay_flywheel.ts", "--self-test"], { encoding: "utf8" });
assert.ok(/self-test OK/.test(out), `flywheel self-test must pass, got: ${out.slice(0, 300)}`);

const flywheel = fs.readFileSync("scripts/corpus_replay_flywheel.ts", "utf8");
assert.ok(
  /from "\.\/intent_handled_audit\.ts"/.test(flywheel) && /realJudge/.test(flywheel) && /isNonActionableInbound/.test(flywheel),
  "the flywheel shares the intent-handled judge + actionability filter (one judging semantics, offline and live)"
);
assert.ok(/maxJudge/.test(flywheel) && /LLM_ENABLED/.test(flywheel), "LLM cost is capped and key-gated");
assert.ok(/occurredAt: atIso/.test(flywheel), "findings are timestamped for downstream stale-suppression");

const audit = fs.readFileSync("scripts/intent_handled_audit.ts", "utf8");
assert.ok(/export async function realJudge/.test(audit), "realJudge stays exported for the flywheel");

// Release contract (Joe, 2026-07-05): the GATE blocks on correctness only (criticals=0 AND
// regressions=0); the pass-rate is a tracked TREND aligned with the live tone floor (0.85),
// never blocking — pinned so a future edit can't quietly re-block on the judge's taste.
{
  const { TREND_PASS_RATE_TARGET } = await import("./corpus_replay_flywheel.ts");
  assert.equal(TREND_PASS_RATE_TARGET, 0.85, "trend target stays aligned with the live tone-gate floor");
  const src = fs.readFileSync("scripts/corpus_replay_flywheel.ts", "utf8");
  assert.ok(/gate_pass: criticalsZero && regressionsZero/.test(src), "the blocking gate is criticals+regressions ONLY");
  assert.ok(!/pass_rate_ge_090|>=\s*0\.9\b/.test(src), "the retired 90%-overall blocker must not reappear");
  assert.ok(/trend_on_target: rate >= TREND_PASS_RATE_TARGET/.test(src), "pass rate is tracked as a trend, not a gate");
}

// Nightly box orchestrator: the sweep gate is pure + self-tested (skip-if-unchanged, forced,
// weekly UTC-Monday confirmation, fail-toward-measuring), and the detect chain folds the
// flywheel's latest.json like every other sibling feed.
const nightlyOut = execFileSync("npx", ["tsx", "scripts/corpus_replay_nightly.ts", "--self-test"], { encoding: "utf8" });
assert.ok(/self-test OK/.test(nightlyOut), `nightly self-test must pass, got: ${nightlyOut.slice(0, 200)}`);
const detect = fs.readFileSync("scripts/anomaly_loop_detect.ts", "utf8");
assert.ok(/corpus_replay", "latest\.json"/.test(detect), "anomaly_loop_detect must fold the corpus_replay sibling feed into next.json");

// Confirm-on-refail (2026-07-06): one unlucky sample of a NONDETERMINISTIC pipeline must not
// block the release gate — a candidate regression re-replays its conversation and only a repeat
// failure counts (7/6 sweep: 2 phantom "regressions" from LLM routing flips, 0/6 reproducible;
// ~13 more from the Brooke→Alexandra rename). Pinned so a future edit can't quietly go back to
// single-sample gating or let persona renames read as code changes.
assert.ok(/resolveRefailOutcome/.test(flywheel) && /confirmedRegressions/.test(flywheel), "the gate counts CONFIRMED regressions only (confirm-on-refail)");
assert.ok(/gate_regressions_zero: regressionsZero/.test(flywheel) && /regressionsZero = confirmedRegressions\.length === 0/.test(flywheel), "the blocking regression bar reads the confirmed set");
assert.ok(/stripAgentIntro/.test(flywheel), "persona renames normalize out of draft signatures");
assert.ok(/FLYWHEEL_REFAIL/.test(flywheel), "refail keeps its kill switch");
const shadowReplay = fs.readFileSync("scripts/inbound_shadow_replay.ts", "utf8");
assert.ok(/--conv/.test(shadowReplay) && /convIds/.test(shadowReplay), "the replay harness supports the per-conversation filter refail depends on");

console.log("PASS corpus replay flywheel eval (self-test + shared-judge + cost-cap + finding-shape + refail guards)");
