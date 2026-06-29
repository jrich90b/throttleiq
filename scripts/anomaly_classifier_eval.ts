/**
 * Anomaly classifier eval (2026-06-25) — Phase 3.
 *
 * Pins classifyOutcomeAnomaly (the AGENTS.md "Autonomous Self-Healing Loop" tier contract as code):
 * every (category, healed, persistent) combination maps to the right TIER + action + notify + auto-merge
 * eligibility, and the conservative default is Tier 2 (escalate). This is what keeps the loop's
 * classification legible and non-drifting instead of a per-run model judgment.
 *
 * Run: npx tsx scripts/anomaly_classifier_eval.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { classifyOutcomeAnomaly } from "../services/api/src/domain/anomalyClassifier.ts";

const A = (over: any) => ({ category: "state", dimension: "x", healed: false, severity: "P2", ...over });
let n = 0;
const check = (cls: any, exp: any, msg: string) => {
  for (const k of Object.keys(exp)) assert.equal(cls[k], exp[k], `${msg}: ${k} expected ${exp[k]}, got ${cls[k]}`);
  n++;
};

// --- healed: tier 0 when transient; ESCALATE when it persists (the reconcile heal has a gap). ---
check(classifyOutcomeAnomaly(A({ healed: true, dimension: "watch_active_on_closed" }), { persistent: false }),
  { tier: 0, action: "reconcile_will_heal", workOrder: false, notify: false }, "healed + transient => tier 0, no work order");
check(classifyOutcomeAnomaly(A({ healed: true, dimension: "watch_active_on_closed" }), { persistent: true }),
  { tier: 2, action: "heal_regression", workOrder: true, notify: true, autoMergeEligible: false }, "healed + PERSISTENT => escalate (heal gap)");

// --- net-new STATE contradiction (no heal yet): Tier 1 fail-safe, NOT behavioral (no Joe notify). ---
check(classifyOutcomeAnomaly(A({ category: "state", healed: false, dimension: "appointment_confirmed_no_event" })),
  { tier: 1, action: "add_invariant_or_heal", workOrder: true, notify: false, autoMergeEligible: false }, "state net-new => tier 1 invariant, no notify");

// --- graduated category flips auto-merge eligibility on (still Tier 1). ---
check(classifyOutcomeAnomaly(A({ category: "state", healed: false, dimension: "appointment_confirmed_no_event" }),
  { graduatedCategories: new Set(["appointment_confirmed_no_event"]) }),
  { tier: 1, autoMergeEligible: true }, "graduated category => auto-merge eligible");

// --- COMPREHENSION (held draft): Tier 1 parser fix, customer-facing => notify. ---
check(classifyOutcomeAnomaly(A({ category: "comprehension", healed: false, dimension: "held_draft_unresolved" })),
  { tier: 1, action: "parser_fix_candidate", workOrder: true, notify: true }, "comprehension => parser fix candidate + notify");

// --- FEEDBACK (👎): Tier 1 redraft/diagnose => notify. ---
check(classifyOutcomeAnomaly(A({ category: "feedback", healed: false, dimension: "negative_feedback" })),
  { tier: 1, action: "redraft_or_diagnose", workOrder: true, notify: true }, "feedback => redraft/diagnose + notify");

// --- Net 3 discovery (open-critic): an unconfirmed model-proposed class => ALWAYS Tier 2 escalate. ---
check(classifyOutcomeAnomaly(A({ category: "discovery", healed: false, dimension: "open_critic_finding" })),
  { tier: 2, action: "escalate", workOrder: true, notify: true, autoMergeEligible: false }, "discovery => escalate (unconfirmed new class)");
// Even if its dimension somehow graduated, a discovery never auto-merges (it's unconfirmed by construction).
check(classifyOutcomeAnomaly(A({ category: "discovery", healed: false, dimension: "open_critic_finding" }),
  { graduatedCategories: new Set(["open_critic_finding"]) } as any),
  { tier: 2, action: "escalate", autoMergeEligible: false }, "discovery never auto-merges even if graduated");

// --- CRM/TLP update error: an integration failure => ALWAYS Tier 2 escalate, never auto-merge. ---
check(classifyOutcomeAnomaly(A({ category: "state", healed: false, dimension: "crm_update_error" })),
  { tier: 2, action: "escalate", workOrder: true, notify: true, autoMergeEligible: false }, "crm_update_error => escalate (diagnose integration)");
// Even graduated, a CRM integration error never auto-merges (the fix is a connector diagnosis).
check(classifyOutcomeAnomaly(A({ category: "state", healed: false, dimension: "crm_update_error" }),
  { graduatedCategories: new Set(["crm_update_error"]) }),
  { tier: 2, action: "escalate", autoMergeEligible: false }, "crm_update_error never auto-merges even if graduated");

// --- conservative default: an unknown category => Tier 2 escalate. ---
check(classifyOutcomeAnomaly(A({ category: "mystery", healed: false } as any)),
  { tier: 2, action: "escalate", workOrder: true, notify: true, autoMergeEligible: false }, "unknown category => escalate");

// --- Source guards: the DETECT script uses the classifier + persistence + writes the work order. ---
const det = fs.readFileSync("scripts/anomaly_loop_detect.ts", "utf8");
assert.match(det, /classifyOutcomeAnomaly\(a, \{ persistent, graduatedCategories \}\)/, "DETECT classifies each anomaly with persistence + graduation");
assert.match(det, /reports\/anomaly_loop\/next\.json|"anomaly_loop", "next\.json"/, "DETECT writes the work order");
assert.match(det, /prevKeys\.has\(keyOf\(a\)\)/, "DETECT computes persistence vs the prior run");
assert.match(det, /stop: workOrders\.length === 0/, "DETECT emits stop:true when healthy");
n += 4;

console.log(`PASS anomaly classifier eval (${n} assertions)`);
