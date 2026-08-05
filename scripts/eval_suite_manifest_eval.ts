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
  "eval_suite_manifest:eval",
  // The 9th member (2026-08-05). Cheapest of the block — one JSON read, no tree walk — and it
  // guards the chain that runs everything else, so a stale-chain merge is reported before the
  // suite it silently shortened gets a chance to pass.
  "ci_eval_chain_guard:eval"
];
// Generous ceiling: the infra/store sanity prefix legitimately runs first, and a new global guard
// should be able to join the block without a fight. Tight enough that drift back to the tail fails.
//
// 24 -> 25 (2026-08-05). The block was sitting EXACTLY on 24, so "without a fight" was not true in
// practice: admitting a 9th guard pushed `eval_suite_manifest` itself to 25 and failed this very
// assertion — which is how the new guard was caught, and the rule working as intended. Raised by
// exactly ONE, for exactly one new member appended at the END of the block; nothing already
// front-loaded moved. The ceiling exists to stop guards DRIFTING BACK TO THE TAIL, and +1 does not
// weaken that — it is not a cap on how many global guards may exist. Keep it equal to the block
// size plus the infra prefix; if it ever needs a jump rather than a +1, that IS drift.
const GUARD_BLOCK_MAX_INDEX = 25;
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
