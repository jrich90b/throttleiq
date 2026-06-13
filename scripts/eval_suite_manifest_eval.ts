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
import fs from "node:fs";
import path from "node:path";
import {
  ciEvalScriptNames,
  DEALER_AMERICANHARLEY_EVALS,
  DEALER_OUTPUT_FACT_PATTERNS,
  tierForEval
} from "./eval_suite.manifest.ts";

const ASSERTION_LINE = /\b(assert|expect|expected|mustInclude|toContain|toMatch|toEqual|toBe)\b/i;

function scriptFileFor(name: string): string | null {
  const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
  const cmd = String(pkg?.scripts?.[name] ?? "");
  const m = cmd.match(/scripts\/([\w-]+)\.ts/);
  if (!m) return null;
  const file = path.join("scripts", `${m[1]}.ts`);
  return fs.existsSync(file) ? file : null;
}

const ciNames = ciEvalScriptNames();
assert.ok(ciNames.length > 0, "ci:eval must parse to a non-empty eval list");

// 1) No stale dealer override — every pinned eval must be in ci:eval.
for (const pinned of DEALER_AMERICANHARLEY_EVALS) {
  assert.ok(
    ciNames.includes(pinned),
    `eval_suite.manifest pins "${pinned}" as dealer:americanharley but it is not in ci:eval (stale override)`
  );
}

// 2) Portability — universal evals may not hardcode a dealer-output fact.
const violations: string[] = [];
for (const name of ciNames) {
  if (name === "eval_suite_manifest:eval") continue;
  if (tierForEval(name) !== "universal") continue;
  const file = scriptFileFor(name);
  if (!file) continue; // multi-file/composite entries (e.g. source-grep guards) — nothing to scan
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
  lines.forEach((line, i) => {
    if (!ASSERTION_LINE.test(line)) return;
    for (const pat of DEALER_OUTPUT_FACT_PATTERNS) {
      if (pat.test(line)) {
        violations.push(`${file}:${i + 1} (${name}) asserts dealer-output fact ${pat} → ${line.trim().slice(0, 100)}`);
        break;
      }
    }
  });
}

if (violations.length) {
  console.error("Universal evals must not hardcode dealer-specific output facts. Parameterize or tag dealer:americanharley:");
  for (const v of violations) console.error(`  - ${v}`);
  assert.fail(`${violations.length} dealer-portability violation(s) in universal evals`);
}

const universalCount = ciNames.filter(n => n !== "eval_suite_manifest:eval" && tierForEval(n) === "universal").length;
const dealerCount = ciNames.filter(n => tierForEval(n) === "dealer:americanharley").length;
console.log(
  `PASS eval suite manifest guard — ${universalCount} universal, ${dealerCount} dealer:americanharley, 0 portability violations`
);
