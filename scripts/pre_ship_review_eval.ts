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
import {
  cleanReviewText,
  decidePreShipGate,
  prepareDiffForReview,
  summarizePreShipHold
} from "../services/api/src/domain/preShipReview.ts";

const clean = { verdict: "approve", risk: "low", customerFacing: true, onTarget: true, lawOk: true, blocking: false, charterCovered: false } as const;

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

// --- A HOLD MUST ALWAYS BE ACTIONABLE (2026-07-29, PR #331). ---
// The reviewer blocked a change with verdict=hold and EMPTY reasons AND concerns. An empty string
// satisfies the schema's `required` but is falsy, so it fell through the `||` chain and the operator
// was told only "review withheld approval" — a block with nothing to act on just moves the guesswork
// onto the human. The reviewer's prose is best-effort; the failed-checks summary is not.
{
  // blank prose can never masquerade as an explanation
  assert.equal(cleanReviewText(""), undefined, "empty string => no explanation");
  assert.equal(cleanReviewText("   \n\t "), undefined, "whitespace-only => no explanation");
  assert.equal(cleanReviewText(undefined), undefined, "missing => no explanation");
  assert.equal(cleanReviewText(123 as any), undefined, "non-string => no explanation");
  assert.equal(cleanReviewText("  real reason  "), "real reason", "prose is trimmed, not dropped");
  assert.equal(cleanReviewText("x".repeat(900)), "x".repeat(900), "a long-but-reasonable explanation survives intact");
  const capped = cleanReviewText("y".repeat(2000));
  assert.ok(capped && capped.endsWith("…[truncated]"), "over-long prose is marked truncated, not silently cut mid-sentence");
  assert.ok(capped && capped.length < 1000, "and is still bounded");
}
{
  // THE PR #331 CASE: hold with empty prose still names which checks failed.
  const silent = { ...clean, verdict: "hold", onTarget: false, lawOk: false, blocking: true, risk: "medium", reasons: "", concerns: "" };
  const g = decidePreShipGate(silent as any, { evalsGreen: true });
  assert.equal(g.ship, false, "a contentless hold still must not ship");
  assert.equal(g.escalate, true, "a contentless hold escalates");
  assert.match(g.reason, /NO REASON GIVEN/, "an unexplained hold must SAY it was unexplained");
  assert.match(g.reason, /on_target=false/, "the escalation must name the on_target failure");
  assert.match(g.reason, /law_ok=false/, "the escalation must name the law_ok failure");
  assert.match(g.reason, /blocking=true/, "the escalation must name the blocking defect");
  assert.doesNotMatch(g.reason, /review withheld approval/, "the old contentless fallback is gone");
}
{
  // When the reviewer DOES explain, its words lead and the failed checks still follow.
  const explained = { ...clean, verdict: "hold", onTarget: false, concerns: "watchMatcher.ts drops the year filter", reasons: "off target" };
  const g = decidePreShipGate(explained as any, { evalsGreen: true });
  assert.match(g.reason, /watchMatcher\.ts drops the year filter/, "the reviewer's specific concern must reach the human");
  assert.match(g.reason, /failed checks: .*on_target=false/, "and the deterministic failed-checks summary is still appended");
  assert.doesNotMatch(g.reason, /NO REASON GIVEN/, "an explained hold is not labelled unexplained");
}
{
  // reasons is used when concerns is blank (concerns preferred, reasons is the fallback).
  const g = decidePreShipGate({ ...clean, verdict: "hold", concerns: "  ", reasons: "unsure about the cadence timing" } as any, { evalsGreen: true });
  assert.match(g.reason, /unsure about the cadence timing/, "blank concerns falls back to reasons");
  assert.doesNotMatch(g.reason, /NO REASON GIVEN/, "reasons counts as an explanation");
}
{
  // risk=high and the unsure-hold case each name themselves.
  assert.match(summarizePreShipHold({ ...clean, risk: "high" } as any), /risk=high/, "high risk is named");
  assert.match(
    summarizePreShipHold({ ...clean, verdict: "hold" } as any),
    /no failing check/,
    "a hold with every check passing is reported as reviewer uncertainty, not silence"
  );
  assert.equal(summarizePreShipHold({ ...clean } as any), "", "a clean approve has no failed checks to report");
}
{
  // Fail-direction: better explanations must NOT loosen the gate. Every non-ship case above still
  // does not ship, and a clean approve still ships.
  assert.equal(decidePreShipGate({ ...clean } as any, { evalsGreen: true }).ship, true, "explanation changes did not break the ship path");
  assert.equal(
    decidePreShipGate({ ...clean, verdict: "hold", reasons: "looks fine honestly" } as any, { evalsGreen: true }).ship,
    false,
    "reassuring prose can never turn a hold into a ship"
  );
}

// --- TIER-2a CHARTER GATE (Joe delegation, 2026-07-30). ---
// A Tier-2 change may auto-merge ONLY when it implements policy Joe already ruled
// (docs/policy_charter.md) and the reviewer CONFIRMS the citation. The confirmation is a separate
// question from "is this a good change": an approve without coverage still escalates.
{
  // The delegated path: clean approve + confirmed coverage => ship.
  const g = decidePreShipGate({ ...clean, charterCovered: true } as any, { evalsGreen: true, requireCharterCovered: true });
  assert.equal(g.ship, true, "clean approve + confirmed charter coverage => SHIP");
  assert.match(g.reason, /charter_covered/, "the ship reason records that coverage was confirmed");
}
{
  // THE LOAD-BEARING CASE: the reviewer LIKES the change but says the citation doesn't cover it.
  const g = decidePreShipGate(
    { ...clean, charterCovered: false, concerns: "the cited rule is about cadence copy; this changes WHO gets texted" } as any,
    { evalsGreen: true, requireCharterCovered: true }
  );
  assert.equal(g.ship, false, "approve WITHOUT confirmed coverage must NOT auto-merge");
  assert.equal(g.escalate, true, "it escalates to Joe as a NEW judgment call");
  assert.match(g.reason, /REJECTED the charter citation/, "the reason names the citation rejection");
  assert.match(g.reason, /WHO gets texted/, "and carries the reviewer's specific objection");
}
{
  // Coverage can never RESCUE a bad review: hold/blocking/off-target/high-risk still never ship.
  for (const bad of [
    { ...clean, charterCovered: true, verdict: "hold" },
    { ...clean, charterCovered: true, blocking: true },
    { ...clean, charterCovered: true, onTarget: false },
    { ...clean, charterCovered: true, risk: "high" }
  ]) {
    const g = decidePreShipGate(bad as any, { evalsGreen: true, requireCharterCovered: true });
    assert.equal(g.ship, false, "charter coverage never overrides a failing check");
  }
  // And red gates still block everything, coverage or not.
  const g = decidePreShipGate({ ...clean, charterCovered: true } as any, { evalsGreen: false, requireCharterCovered: true });
  assert.equal(g.ship, false, "red gates still block a covered change");
}
{
  // Back-compat: when coverage is NOT required (Tier-1 lane), charterCovered is ignored entirely.
  assert.equal(decidePreShipGate({ ...clean } as any, { evalsGreen: true }).ship, true, "no-charter lane unchanged");
  assert.equal(
    decidePreShipGate({ ...clean, charterCovered: true } as any, { evalsGreen: true }).ship,
    true,
    "a stray coverage flag changes nothing when not required"
  );
}
{
  // Source guards: fail-safe parse (only explicit true counts) + adversarial prompt contract.
  const s = fs.readFileSync("services/api/src/domain/preShipReview.ts", "utf8");
  assert.match(s, /charterCovered: p\.charter_covered === true/, "anything but explicit true parses as NOT covered");
  assert.match(s, /ADVERSARIALLY/, "the prompt demands adversarial citation judgment");
  assert.match(s, /set charter_covered=false \(it is not being claimed\)/, "no citation => the model is told coverage is not claimed");
  const runner2 = fs.readFileSync("scripts/act_runner.ts", "utf8");
  assert.match(runner2, /requireCharterCovered: !!charterCitation/, "the runner requires coverage exactly when a citation is claimed");
  assert.match(runner2, /\^C\\d\+\\\.\\d\+\$/, "charter ids are validated before use");
  assert.match(runner2, /loop merged a charter-covered change/, "a Tier-2a merge notifies Joe AFTER, by design");
  assert.match(runner2, /gh", \["pr", "comment"/, "notification has a durable PR-comment fallback (the 7/29 silent-skip gap)");
}

// --- the reviewer is INSTRUCTED to explain itself, and has room to. ---
{
  const s = fs.readFileSync("services/api/src/domain/preShipReview.ts", "utf8");
  assert.match(s, /reasons: \{ type: "string", minLength: \d+ \}/, "an empty reasons string is schema-invalid");
  assert.match(s, /required: \["reasons", "concerns"/, "prose fields come FIRST so a truncation cannot eat them");
  assert.match(s, /EXPLAIN YOURSELF/, "the prompt explicitly demands an explanation");
  assert.match(s, /max_tokens: 1200/, "enough budget for real prose");
}

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

// --- The `NS` (North-star) citation is judged HARDER than a rule id, and gets no gate relief. ---
// A rule citation asks "is this a faithful implementation of THIS rule?". NS has no rule to be
// faithful to, so the prompt must demand direct advancement of the goal and reject mere consistency
// with it — otherwise NS becomes a rubber stamp for any change that isn't obviously off-goal.
{
  const s = fs.readFileSync("services/api/src/domain/preShipReview.ts", "utf8");
  assert.match(s, /args\.charterCitation\.id === "NS"/, "the reviewer prompt has a distinct NS branch");
  assert.match(s, /WEAKEST citation available, so judge it the HARDEST/, "NS is explicitly held to the strictest bar");
  assert.match(
    s,
    /Merely being consistent with, adjacent to, or not-in-conflict-with the goal is/,
    "NS coverage rejects mere consistency with the goal — it requires direct advancement"
  );
  assert.match(
    s,
    /threshold\/figure, or resolves a judgment call the goal does not resolve is charter_covered=false/,
    "NS explicitly fails when the change makes a decision the goal does not make"
  );
  // The gate is citation-agnostic: NS must flow through the SAME requireCharterCovered path.
  const nsLike = decidePreShipGate({ ...clean, charterCovered: false } as any, {
    evalsGreen: true,
    requireCharterCovered: true
  });
  assert.equal(nsLike.ship, false, "an unconfirmed NS alignment claim escalates exactly like a rejected rule citation");
  assert.equal(
    decidePreShipGate({ ...clean, charterCovered: true } as any, { evalsGreen: false, requireCharterCovered: true }).ship,
    false,
    "NS never ships on a red gate"
  );
}

console.log("PASS pre-ship review eval — ships only on clean approve + green gates; all doubt escalates; reviewer is cross-model + conservative; NS alignment claims are judged hardest and get no gate relief; runner merges only on SHIP.");
