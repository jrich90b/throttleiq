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

// 3) ORDERING — the cheap GLOBAL guards must run at the FRONT of ci:eval.
//
// These are deterministic source/config scanners: a grep over the tree, no LLM, ~0.3s each. They
// had drifted to positions 274-330 of 331 — 85-100% of the way through a ~25-minute chain. On
// 2026-07-30 that cost roughly 75 minutes across three red runs, and EVERY one of those failures
// was a deterministic guard (the portability ratchet twice, a source-count pin once) that a
// front-loaded run reports in seconds.
//
// ORDERING ONLY — the eval SET is unchanged and nothing is skipped. Test SELECTION was considered
// and rejected: that same day a phone-log change broke an unrelated first-touch eval via a
// file-wide source count, and tripped the global portability ratchet twice. A file-scoped selector
// misses all three; the full suite earns its keep on couplings nobody predicts.
const FRONT_LOADED_GLOBAL_GUARDS = [
  "route_parity_guard:eval",
  "twilio_comprehension_debt:eval",
  "ui_contrast_guard:eval",
  "rollout_readiness:eval",
  "stranger_dealer_test:eval",
  "intro_over_at_live:eval",
  "outbound_echo_guard:eval",
  "eval_suite_manifest:eval"
];
// Generous ceiling: the infra/store sanity prefix legitimately runs first, and a new global guard
// should be able to join the block without a fight. Tight enough that drift back to the tail fails.
const GUARD_BLOCK_MAX_INDEX = 24;
for (const guard of FRONT_LOADED_GLOBAL_GUARDS) {
  const idx = ciNames.indexOf(guard);
  assert.ok(idx >= 0, `${guard} must be in ci:eval`);
  assert.ok(
    idx <= GUARD_BLOCK_MAX_INDEX,
    `${guard} is a ~0.3s global guard but sits at position ${idx} of ${ciNames.length} — front-load it (<= ${GUARD_BLOCK_MAX_INDEX}) so a whole-tree breakage fails in seconds, not ~20 minutes`
  );
}

console.log(
  `PASS eval suite manifest guard — ${universalCount} universal, ${dealerCount} dealer:americanharley, 0 portability violations, ${FRONT_LOADED_GLOBAL_GUARDS.length} global guards front-loaded`
);
