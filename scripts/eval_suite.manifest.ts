/**
 * Eval-suite tiering — the foundation of the per-dealer rollout gate
 * (docs/multi_client_deployment.md, docs/autonomous_coding_loop.md).
 *
 * Two tiers:
 *   - universal              — shared product behavior every (Harley) dealer
 *                              must pass. This IS the per-dealer gate: point it
 *                              at any dealer's data and it should stay green.
 *   - dealer:americanharley  — pass/fail depends on American Harley's SPECIFIC
 *                              runtime data or config (its inventory, address,
 *                              promo URLs, salespeople), not just an AH-flavored
 *                              fixture. NOT part of another dealer's gate.
 *
 * Classification criterion: "Would a different Harley dealer pass this eval
 * unchanged?" Yes ⇒ universal. An AH customer's name or wording in a fixture
 * (Al Davis, Todd Herian, Chuck Bailey) does NOT make an eval dealer-specific —
 * the behavior under test generalizes. Only an eval that asserts AH's own data
 * as the expected OUTPUT is dealer:americanharley.
 *
 * Finding (2026-06-13 audit): every eval currently in `ci:eval` is universal —
 * the gated suite is fully dealer-portable. AH-specificity lives in swappable
 * data files (dealer_profile.json, inventory feed, conversations.json), not in
 * eval assertions. The lone AH-output assertion in the repo lives in
 * `web_fallback_rank_eval` (asserts AH's promotions URL) and is intentionally
 * NOT gated; it is the canonical example of what belongs in dealer:americanharley.
 *
 * Membership is the override set below + "everything else in ci:eval is
 * universal", so there is no 69-line list to drift. The manifest guard
 * (scripts/eval_suite_manifest_eval.ts) enforces both that every override is
 * real and that no universal eval hardcodes a dealer-output fact.
 */

import fs from "node:fs";
import path from "node:path";

export type EvalTier = "universal" | "dealer:americanharley";

/** Ordered, de-duped eval names from the package.json `ci:eval` chain — the single source of membership. */
export function ciEvalScriptNames(): string[] {
  const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8"));
  const chain = String(pkg?.scripts?.["ci:eval"] ?? "");
  const names: string[] = [];
  for (const m of chain.matchAll(/npm run ([\w:-]+)/g)) {
    if (!names.includes(m[1])) names.push(m[1]);
  }
  return names;
}

/** ci:eval scripts pinned to American Harley's own data/config. Currently none. */
export const DEALER_AMERICANHARLEY_EVALS = new Set<string>([
  // e.g. "web_fallback_rank:eval" — asserts americanharley-davidson.com/current-promotions
  //      (kept out of ci:eval today; add here if it ever gates).
]);

export function tierForEval(script: string): EvalTier {
  return DEALER_AMERICANHARLEY_EVALS.has(script) ? "dealer:americanharley" : "universal";
}

/**
 * Dealer-OUTPUT facts a `universal` eval must never assert — these differ per
 * dealer, so hardcoding one means the eval is secretly AH-pinned and would
 * break dealer #2's gate. The guard scans universal evals' assertion lines for
 * these; a hit fails ci:eval until the eval is parameterized or reclassified.
 * Note: a bare dealer slug ("americanharley") is allowed (it is the repo's
 * single-tenant DEALER_ID default constant, identical on every instance).
 */
export const DEALER_OUTPUT_FACT_PATTERNS: RegExp[] = [
  /1149\s+erie/i,
  /\berie\s+ave/i,
  /north\s+tonawanda/i,
  /\b14120\b/,
  /americanharley-davidson\.com/i,
  /\bU\d{3}-\d{2}\b/ // AH inventory stock-id shape, e.g. U876-22
];
