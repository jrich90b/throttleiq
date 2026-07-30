/**
 * Eval-suite manifest guard (runs inside ci:eval).
 *
 * Keeps the universal/dealer split honest so the per-dealer gate stays
 * trustworthy:
 *   1. Drift — every script in DEALER_AMERICANHARLEY_EVALS must actually be in
 *      ci:eval (no stale overrides), and every ci:eval entry must classify.
 *   2. Portability — no `universal` eval may assert a dealer-OUTPUT fact (AH
 *      address/zip/promo-domain/stock-id). A hit means the eval is secretly
 *      AH-pinned and would break dealer #2's gate: parameterize it, or move it
 *      to dealer:americanharley.
 */
import assert from "node:assert/strict";
import {
  ciEvalScriptNames,
  DEALER_AMERICANHARLEY_EVALS,
  scanUniversalEvalPortability
} from "./eval_suite.manifest.ts";

const ciNames = ciEvalScriptNames();
assert.ok(ciNames.length > 0, "ci:eval must parse to a non-empty eval list");

// 1) No stale dealer override — every pinned eval must be in ci:eval.
for (const pinned of DEALER_AMERICANHARLEY_EVALS) {
  assert.ok(
    ciNames.includes(pinned),
    `eval_suite.manifest pins "${pinned}" as dealer:americanharley but it is not in ci:eval (stale override)`
  );
}

// 2) Portability — universal evals may not hardcode a dealer-output fact. The scan lives in the
//    manifest module so the rollout-readiness scorecard grades the SAME number this gate enforces.
const { universal: universalCount, dealer: dealerCount, violations } = scanUniversalEvalPortability(ciNames);

if (violations.length) {
  console.error("Universal evals must not hardcode dealer-specific output facts. Parameterize or tag dealer:americanharley:");
  for (const v of violations) console.error(`  - ${v}`);
  assert.fail(`${violations.length} dealer-portability violation(s) in universal evals`);
}

console.log(
  `PASS eval suite manifest guard — ${universalCount} universal, ${dealerCount} dealer:americanharley, 0 portability violations`
);
