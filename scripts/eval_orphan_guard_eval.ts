/**
 * Orphaned-eval guard: an eval script that is not in `ci:eval` is not a safety net, it is a file.
 *
 * WHY. Found 2026-08-06: **46 of 437 eval scripts were not in the chain**, 24 of them with a working
 * npm script — written, committed, and never run again. All 24 passed when finally executed, so this
 * was not rot; the wiring step was simply forgotten, silently, over and over.
 *
 * One of them was `first_time_rider_guidance:eval` — the safety net for the very route changed by
 * #574 the same day. It would have covered that work and nobody knew it existed.
 *
 * `eval_suite_manifest:eval` already checks the other direction (every chain entry classifies, and
 * DEALER_AMERICANHARLEY_EVALS entries are present). Nothing checked that a script on disk ever
 * REACHES the chain. That asymmetry is this file.
 *
 * TO ADD A NEW EVAL: put it in `ci:eval`. That is the whole rule.
 * TO DELIBERATELY EXCLUDE ONE: add it to EXCLUDED below **with a reason**. The point is not to make
 * exclusion impossible — some evals are genuinely manual, costly, or superseded — it is to make
 * exclusion a decision somebody wrote down instead of an accident nobody noticed.
 *
 * Run: npx tsx scripts/eval_orphan_guard_eval.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";

/**
 * name → why it is deliberately not in the gate. Keep the reason specific and current.
 *
 * Empty today, and that is the healthy state: every runnable eval is in the chain. The map exists so
 * a future exclusion has to be written down. (The first entry I tried to add here — `adf_smoke:eval`
 * — was wrong: it has no npm script of its own, it runs as `adf:smoke`, so it was never an orphan.
 * The stale-entry check below caught that immediately, which is the behaviour we want from it.)
 */
const EXCLUDED: Record<string, string> = {};

const pkg = JSON.parse(fs.readFileSync("package.json", "utf8")) as {
  scripts: Record<string, string>;
};
const chain = String(pkg.scripts["ci:eval"] ?? "");
assert.ok(chain.length > 0, "ci:eval must exist");

const onDisk = fs
  .readdirSync("scripts")
  .filter(f => f.endsWith("_eval.ts"))
  .map(f => `${f.replace(/_eval\.ts$/, "")}:eval`);

// Only scripts with an npm entry can be wired in at all; the rest are helpers or fixtures.
const runnable = onDisk.filter(name => typeof pkg.scripts[name] === "string");
const orphans = runnable.filter(name => !chain.includes(`npm run ${name}`) && !(name in EXCLUDED));

assert.deepEqual(
  orphans,
  [],
  `these evals exist and are runnable but never run — wire them into ci:eval, or add them to ` +
    `EXCLUDED in this file with a reason:\n  ${orphans.join("\n  ")}`
);

// An exclusion whose script no longer exists is stale bookkeeping — clean it up rather than let the
// list rot into an alibi.
for (const name of Object.keys(EXCLUDED)) {
  assert.ok(
    runnable.includes(name) || chain.includes(`npm run ${name}`) || pkg.scripts[name],
    `EXCLUDED lists "${name}" but no such npm script exists — remove the stale entry`
  );
  assert.ok(EXCLUDED[name].trim().length > 10, `EXCLUDED["${name}"] needs a real reason, not a placeholder`);
}

console.log(
  `PASS eval orphan guard — ${runnable.length} runnable eval scripts, all in ci:eval ` +
    `(${Object.keys(EXCLUDED).length} deliberately excluded, each with a reason)`
);
