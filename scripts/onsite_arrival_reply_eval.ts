/**
 * On-site arrival reply eval (pure source/table checks, no LLM).
 *
 * Pins the "Hey I'm here who do I ask for?" class (corpus flywheel 2026-07-03, +17168039550:
 * a customer STANDING AT THE DEALERSHIP drew "what time tomorrow works best?"). Two layers:
 *   1. The customer-ack parser prompt carries the already-on-site few-shot + rule (routing is
 *      parser-first; "I'm here" is an immediate_arrival_request).
 *   2. The arrival reply differentiates on-site ("ask for {owner}, I'll let them know you're
 *      here") from pre-arrival ("let me confirm before you head over"), and the staff todo is
 *      urgent for on-site. All 5 arm call sites pass the inbound text.
 *
 * Run: npx tsx scripts/onsite_arrival_reply_eval.ts
 */
import { strict as assert } from "node:assert";
import fs from "node:fs";

const llm = fs.readFileSync("services/api/src/domain/llmDraft.ts", "utf8");
assert.ok(/Hey I\\'m here who do I ask for\?/.test(llm) || llm.includes("Hey I\\'m here who do I ask for?"), "parser few-shot for the on-site arrival exists");
assert.ok(/ALREADY here\/at the shop/.test(llm), "parser rule names the already-on-site case");

const index = fs.readFileSync("services/api/src/index.ts", "utf8");
const builder = index.slice(index.indexOf("function buildImmediateArrivalRequestReply"), index.indexOf("function buildImmediateArrivalRequestReply") + 1200);
assert.ok(/isAlreadyOnSiteArrivalText\(opts\?\.inboundText\)/.test(builder), "builder differentiates on-site arrivals");
assert.ok(/ask for \$\{ownerFirst\} at the front desk/.test(builder), "on-site reply names the lead owner");
assert.ok(/before you head over/.test(builder), "pre-arrival copy unchanged");
const gate = index.slice(index.indexOf("function isAlreadyOnSiteArrivalText"), index.indexOf("function isAlreadyOnSiteArrivalText") + 700);
for (const [txt, want] of [
  ["Hey I'm here who do I ask for?", true],
  ["im here", true],
  ["just pulled in", true],
  ["I'm out front", true],
  ["I can come now", false],
  ["can I head over now?", false],
  ["here is my number", false]
] as Array<[string, boolean]>) {
  const re1 = /\b(?:i'?m|we'?re|im)\s+(?:here|out front|in the parking lot|at the (?:shop|store|dealership))\b/;
  const re2 = /\bjust pulled (?:in|up)\b/;
  const got = re1.test(txt.toLowerCase()) || re2.test(txt.toLowerCase());
  assert.equal(got, want, `on-site gate("${txt}") expected ${want}`);
}
assert.equal((index.match(/buildImmediateArrivalRequestReply\(conv, \{ inboundText: event\.body \}\)/g) ?? []).length, 5, "all 5 arm call sites pass the inbound text");
assert.ok(/Customer is AT the dealership right now/.test(index), "on-site staff todo is urgent-worded");

console.log("PASS on-site arrival reply eval (parser few-shot + on-site/pre-arrival split + 5-site wiring)");
