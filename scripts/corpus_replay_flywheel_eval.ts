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

// Nightly box orchestrator: the sweep gate is pure + self-tested (skip-if-unchanged, forced,
// weekly UTC-Monday confirmation, fail-toward-measuring), and the detect chain folds the
// flywheel's latest.json like every other sibling feed.
const nightlyOut = execFileSync("npx", ["tsx", "scripts/corpus_replay_nightly.ts", "--self-test"], { encoding: "utf8" });
assert.ok(/self-test OK/.test(nightlyOut), `nightly self-test must pass, got: ${nightlyOut.slice(0, 200)}`);
const detect = fs.readFileSync("scripts/anomaly_loop_detect.ts", "utf8");
assert.ok(/corpus_replay", "latest\.json"/.test(detect), "anomaly_loop_detect must fold the corpus_replay sibling feed into next.json");

console.log("PASS corpus replay flywheel eval (self-test + shared-judge + cost-cap + finding-shape guards)");
