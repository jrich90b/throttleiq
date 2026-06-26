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
import { decidePreShipGate } from "../services/api/src/domain/preShipReview.ts";

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

// --- runner wiring: review subcommand merges ONLY on SHIP, always leaves an auditable PR. ---
const runner = fs.readFileSync("scripts/act_runner.ts", "utf8");
assert.match(runner, /reviewLoopFixWithLLM/, "runner runs the cross-model review");
assert.match(runner, /decidePreShipGate/, "runner gates on the pure decision");
assert.match(runner, /if \(gate\.ship\) \{[\s\S]*?pr", "merge"/, "runner merges ONLY when the gate says ship");
assert.match(runner, /ESCALATED — PR left OPEN for a human/, "non-approve => PR left open + escalate (not merged)");

console.log("PASS pre-ship review eval — ships only on clean approve + green gates; all doubt escalates; reviewer is cross-model + conservative; runner merges only on SHIP.");
