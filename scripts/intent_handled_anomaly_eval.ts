/**
 * intent_handled_anomaly:eval — pins the intent-handled → self-healing-loop wiring.
 *
 * The intent-handled audit is the SEMANTIC safety net that catches fluent-but-wrong-intent replies the
 * keyword scorers can't (a polite non-answer on a real ask). Before this it was a report-only morning
 * digest; now its MAJOR misses feed the autonomous loop. This eval pins all three seams so the wiring
 * can't silently rot:
 *   1. decideIntentHandledAnomaly maps a MAJOR miss → comprehension OutcomeAnomaly, and drops minor/none
 *      (the noise floor) + findings with no convId.
 *   2. classifyOutcomeAnomaly tiers it as a Tier-1 parser_fix_candidate that NOTIFIES Joe and is NOT
 *      auto-merge-eligible until the dimension graduates (the tier contract = approve-first for a
 *      customer-facing comprehension miss).
 *   3. the audit emits the sibling feed (anomalies.json) and anomaly_loop_detect MERGES it (string-level,
 *      mirroring anomaly_classifier_eval) — so the feed actually reaches DETECT→CLASSIFY→ACT.
 *
 * Pure + deterministic, no network.
 */
import assert from "node:assert";
import fs from "node:fs";

import { decideIntentHandledAnomaly } from "../services/api/src/domain/conversationOutcomeAudit.ts";
import { classifyOutcomeAnomaly } from "../services/api/src/domain/anomalyClassifier.ts";

// 1. MAPPING — a real major miss (the wedge-air-cleaner case: a booking ask got a bare pleasantry).
const major = decideIntentHandledAnomaly({
  convId: "+17162605144",
  severity: "major",
  replyKind: "sent",
  customerAsk: "book a service appointment next month for the wedge air cleaner",
  why: "the reply was a generic pleasantry and never offered to book or gave next steps"
});
assert(major, "a major miss maps to an anomaly");
assert.equal(major!.category, "comprehension", "category is comprehension (→ parser-first fix)");
assert.equal(major!.dimension, "intent_unaddressed", "dimension is intent_unaddressed");
assert.equal(major!.severity, "P2", "severity normalizes to P2");
assert.equal(major!.healed, false, "not a healed dimension");
assert.equal(major!.convId, "+17162605144", "convId carries through (the loop needs it to pull context)");
assert(/sent/.test(major!.detail), "detail records reply kind");
assert(/wedge air cleaner|service appointment/.test(major!.detail), "detail carries the customer ask");

// a DRAFT miss is still emitted (catchable pre-send) and records its kind
const draft = decideIntentHandledAnomaly({ convId: "+13179357913", severity: "major", replyKind: "draft", customerAsk: "x", why: "y" });
assert(draft && /draft/.test(draft.detail), "draft major miss is emitted and labeled draft");

// NOISE FLOOR — minor/none/blank/missing severity never become work orders; no convId never does either.
for (const sev of ["minor", "none", "", "MAJORLY", undefined, null]) {
  assert.equal(
    decideIntentHandledAnomaly({ convId: "+1", severity: sev as any }),
    null,
    `severity ${JSON.stringify(sev)} → null (only "major" crosses the noise floor)`
  );
}
assert.equal(decideIntentHandledAnomaly({ severity: "major" }), null, "no convId → null");

// 2. CLASSIFICATION — the tier contract for a customer-facing comprehension miss.
const cls = classifyOutcomeAnomaly(major!, {});
assert.equal(cls.tier, 1, "comprehension → Tier 1");
assert.equal(cls.action, "parser_fix_candidate", "action is a parser-first fix");
assert.equal(cls.workOrder, true, "it is a work order (the loop must act)");
assert.equal(cls.notify, true, "customer-facing → notify Joe");
assert.equal(cls.autoMergeEligible, false, "NOT auto-merge-eligible until the dimension graduates (approve-first)");

// graduation is keyed by dimension via the ledger — only then can it auto-merge.
const graduated = classifyOutcomeAnomaly(major!, { graduatedCategories: new Set(["intent_unaddressed"]) });
assert.equal(graduated.autoMergeEligible, true, "auto-merge unlocks once intent_unaddressed graduates");

// 3. WIRING — the emit + the merge are actually in the scripts (string-level, like anomaly_classifier_eval).
const audit = fs.readFileSync("scripts/intent_handled_audit.ts", "utf8");
assert.match(audit, /decideIntentHandledAnomaly/, "audit imports/uses the mapper");
assert.match(audit, /anomalies\.json/, "audit writes the sibling feed file");
const det = fs.readFileSync("scripts/anomaly_loop_detect.ts", "utf8");
assert.match(det, /"intent_handled",\s*"anomalies\.json"/, "anomaly_loop_detect merges the intent-handled feed");

console.log("PASS intent_handled_anomaly eval");
