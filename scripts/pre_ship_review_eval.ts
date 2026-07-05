/**
 * Pre-ship review eval (pure gate + wiring). The cross-model pre-ship review is the independent check
 * before a loop change ships. The non-negotiables: ship ONLY on a clean approve with green gates; ANY
 * doubt — no review, hold, blocking, off-target, law violation, high risk, or red gates — does NOT ship.
 * No review available => ESCALATE (never silently ship unreviewed). The runner merges only on SHIP.
 *
 * Run: npx tsx scripts/pre_ship_review_eval.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { decidePreShipGate, prepareDiffForReview } from "../services/api/src/domain/preShipReview.ts";

const clean = { verdict: "approve", risk: "low", customerFacing: true, onTarget: true, lawOk: true, blocking: false } as const;

// --- the one path that ships: clean approve + green gates. ---
{
  const g = decidePreShipGate({ ...clean }, { evalsGreen: true });
  assert.equal(g.ship, true, "clean approve + green gates => SHIP");
  assert.equal(g.escalate, false, "ship is not an escalation");
}

// --- everything else does NOT ship. ---
const noShip = (review: any, evalsGreen: boolean, label: string, expectEscalate: boolean) => {
  const g = decidePreShipGate(review, { evalsGreen });
  assert.equal(g.ship, false, `${label} => must NOT ship`);
  assert.equal(g.escalate, expectEscalate, `${label} => escalate=${expectEscalate}`);
};
noShip(null, true, "no review available (no key)", true); // escalate to a human, never silent-ship
noShip({ ...clean }, false, "red gates", false); // blocked, fix gates first (not an escalation)
noShip({ ...clean, verdict: "hold" }, true, "reviewer held", true);
noShip({ ...clean, blocking: true }, true, "blocking defect", true);
noShip({ ...clean, risk: "high" }, true, "high risk", true);
noShip({ ...clean, onTarget: false }, true, "off-target (fixes the wrong thing)", true);
noShip({ ...clean, lawOk: false }, true, "law violation (e.g. new free-text regex / one path)", true);

// --- reviewer source guards: independent (Claude), typed, conservative defaults. ---
const src = fs.readFileSync("services/api/src/domain/preShipReview.ts", "utf8");
assert.match(src, /api\.anthropic\.com\/v1\/messages/, "reviewer is a DIFFERENT lineage (Claude) than the OpenAI generator");
assert.match(src, /tool_choice: \{ type: "tool", name: "pre_ship_review" \}/, "typed structured review via tool-use");
assert.match(src, /verdict: oneOf\(p\.verdict, \["approve", "hold"\], "hold"\)/, "parse failure defaults to HOLD (conservative)");
assert.match(src, /oneOf\(p\.risk, \["low", "medium", "high"\], "high"\)/, "parse failure defaults to HIGH risk (conservative)");
assert.match(src, /if \(!review\) return \{ ship: false, escalate: true/, "no review => escalate, never ship");

// --- prepareDiffForReview: the source change must NEVER be starved out of the reviewed window. ---
// Regression guard for the Jason watch-matcher ship (6/26, PR #100): a 15KB one-line package.json `ci:eval`
// megaline sorted first (alphabetically) and a flat 16KB cap truncated the real index.ts fix entirely, so
// the cross-model reviewer reported "no change to index.ts" and wrongly HELD a correct change.
{
  const megaline = "x".repeat(15000);
  const SOURCE_FIX = "const directMatch = itemModel.includes(watchModel);";
  // package.json (config, alphabetically FIRST) carries the megaline; index.ts (source) carries the real fix.
  const rawDiff = [
    "diff --git a/package.json b/package.json",
    "index aaaaaaa..bbbbbbb 100644",
    "--- a/package.json",
    "+++ b/package.json",
    "@@ -300,1 +300,1 @@",
    `-    "ci:eval": "${megaline}OLD",`,
    `+    "ci:eval": "${megaline}NEW",`,
    "diff --git a/services/api/src/index.ts b/services/api/src/index.ts",
    "index ccccccc..ddddddd 100644",
    "--- a/services/api/src/index.ts",
    "+++ b/services/api/src/index.ts",
    "@@ -5314,1 +5314,1 @@",
    "-  const directMatch = itemModel.includes(watchModel) || watchModel.includes(itemModel);",
    `+  ${SOURCE_FIX}`,
    ""
  ].join("\n");

  const prepared = prepareDiffForReview(rawDiff);
  assert.ok(prepared.includes(SOURCE_FIX), "the source fix must survive into the reviewed window (the PR #100 bug)");
  assert.ok(prepared.includes("[line collapsed:"), "the 15KB config megaline must be collapsed, not consume the budget");
  assert.ok(!prepared.includes(megaline), "the raw 15KB megaline content must NOT appear (it was collapsed)");
  // Code-first ordering: the source file section must precede the config file section.
  assert.ok(
    prepared.indexOf("b/services/api/src/index.ts") < prepared.indexOf("b/package.json"),
    "source files must be ordered BEFORE config files so source is never truncated out"
  );
  // Sanity: well under the cap once the megaline is collapsed.
  assert.ok(prepared.length < 24000, "collapsed diff fits the cap");
}
// edge cases
assert.equal(prepareDiffForReview(""), "", "empty diff => empty");
assert.equal(prepareDiffForReview("   \n  "), "", "whitespace-only diff => empty");
{
  // a non-git-diff blob still gets its megalines collapsed (defensive fallback path)
  const blob = "+" + "y".repeat(2000);
  assert.ok(prepareDiffForReview(blob).includes("[line collapsed:"), "fallback path still collapses megalines");
}
// reviewer wiring: the LLM call must use the prepared diff, NOT a raw slice that alphabetical-sorts config first.
assert.match(
  fs.readFileSync("services/api/src/domain/preShipReview.ts", "utf8"),
  /const diff = prepareDiffForReview\(args\.diff\)/,
  "reviewLoopFixWithLLM must feed the prepared (code-first, collapsed) diff to the model"
);

// --- runner wiring: review subcommand merges ONLY on SHIP, always leaves an auditable PR. ---
const runner = fs.readFileSync("scripts/act_runner.ts", "utf8");
assert.match(runner, /reviewLoopFixWithLLM/, "runner runs the cross-model review");
assert.match(runner, /decidePreShipGate/, "runner gates on the pure decision");
assert.match(runner, /if \(gate\.ship\) \{[\s\S]*?pr", "merge"/, "runner merges ONLY when the gate says ship");
assert.match(runner, /ESCALATED — PR left OPEN for a human/, "non-approve => PR left open + escalate (not merged)");

console.log("PASS pre-ship review eval — ships only on clean approve + green gates; all doubt escalates; reviewer is cross-model + conservative; runner merges only on SHIP.");
