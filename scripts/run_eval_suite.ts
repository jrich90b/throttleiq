/**
 * Tiered eval runner — executes the ci:eval evals for one tier, in ci:eval
 * order. This is how the per-dealer rollout gate runs the universal suite
 * against a dealer's data (`npm run eval:universal`).
 *
 * Membership comes from ONE source of truth: the names in the package.json
 * `ci:eval` chain, classified by scripts/eval_suite.manifest.ts. No second list
 * to drift.
 *
 * Usage:
 *   npx tsx scripts/run_eval_suite.ts --tier universal
 *   npx tsx scripts/run_eval_suite.ts --tier dealer:americanharley
 *   npx tsx scripts/run_eval_suite.ts --tier all
 *   npx tsx scripts/run_eval_suite.ts --tier universal --list   # print, don't run
 */
import { execSync } from "node:child_process";
import { ciEvalScriptNames, tierForEval, type EvalTier } from "./eval_suite.manifest.ts";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function main(): void {
  const tierArg = (arg("--tier") ?? "universal") as EvalTier | "all";
  const listOnly = process.argv.includes("--list");
  const names = ciEvalScriptNames().filter(
    n => n !== "eval_suite_manifest:eval" // the guard itself runs inside ci:eval, not as a tiered behavior eval
  );
  const selected = names.filter(n => tierArg === "all" || tierForEval(n) === tierArg);

  console.log(
    `[eval-suite] tier="${tierArg}" — ${selected.length}/${names.length} evals` +
      (listOnly ? " (list only)" : "")
  );
  for (const n of selected) console.log(`  • ${n} [${tierForEval(n)}]`);
  if (listOnly || selected.length === 0) {
    if (selected.length === 0) console.log("[eval-suite] nothing to run for this tier.");
    return;
  }

  const startedAll = Date.now();
  let passed = 0;
  for (const name of selected) {
    const started = Date.now();
    process.stdout.write(`\n[eval-suite] ▶ ${name}\n`);
    try {
      execSync(`npm run ${name}`, { stdio: "inherit" });
    } catch {
      console.error(`\n[eval-suite] ✗ FAILED: ${name} (after ${passed} green). Halting.`);
      process.exit(1);
    }
    passed += 1;
    console.log(`[eval-suite] ✓ ${name} (${((Date.now() - started) / 1000).toFixed(1)}s)`);
  }
  console.log(
    `\n[eval-suite] PASS tier="${tierArg}" — ${passed} evals green in ${((Date.now() - startedAll) / 1000).toFixed(
      1
    )}s`
  );
}

main();
