/**
 * On-site arrival reply eval (pure source/table checks, no LLM).
 *
 * Pins the "Hey I'm here who do I ask for?" class (corpus flywheel 2026-07-03, +17168039550:
 * a customer STANDING AT THE DEALERSHIP drew "what time tomorrow works best?"). Parser-first by
 * law: on-site is a typed field (on_site) on the customer-ack parser — the comprehension-debt
 * ratchet rejected the regex version of this gate, correctly.
 *   1. Schema + prompt: on_site is REQUIRED in the strict schema, the rule names the on-site
 *      case, and the few-shots carry it (true for "I'm here", false for "can I come now").
 *   2. Reply: on-site names the lead owner; pre-arrival copy unchanged; urgent todo wording;
 *      all 5 arm call sites read the parse's onSite — no comprehension regex anywhere.
 *
 * Run: npx tsx scripts/onsite_arrival_reply_eval.ts
 */
import { strict as assert } from "node:assert";
import fs from "node:fs";

const llm = fs.readFileSync("services/api/src/domain/llmDraft.ts", "utf8");
assert.ok(llm.includes('"on_site",') && llm.includes('on_site: { type: "boolean" }'), "on_site is a REQUIRED strict-schema field");
assert.ok(/on_site: true ONLY when the customer indicates they are physically AT the dealership/.test(llm), "prompt rule defines on_site");
assert.ok(llm.includes('"on_site":true,"confidence":0.97'), "on-site few-shot carries on_site:true");
assert.ok(llm.includes('"normalized_text":"today now","on_site":false'), "pre-arrival few-shot carries on_site:false");
assert.ok(/onSite: !!parsed\.on_site/.test(llm), "parse mapping exposes onSite");

const index = fs.readFileSync("services/api/src/index.ts", "utf8");
assert.ok(!/isAlreadyOnSiteArrivalText/.test(index), "NO comprehension regex for on-site (parser-first, ratchet-enforced)");
const builder = index.slice(index.indexOf("function buildImmediateArrivalRequestReply"), index.indexOf("function buildImmediateArrivalRequestReply") + 1100);
assert.ok(/opts\?\.onSite/.test(builder), "builder gates on the PARSER field");
assert.ok(/ask for \$\{ownerFirst\} at the front desk/.test(builder), "on-site reply names the lead owner");
assert.ok(/before you head over/.test(builder), "pre-arrival copy unchanged");
assert.equal(
  (index.match(/buildImmediateArrivalRequestReply\(conv, \{ onSite: (?:regenC|c)ustomerAckActionParse\?\.onSite === true \}\)/g) ?? []).length,
  5,
  "all 5 arm call sites read the parse's onSite"
);
assert.ok(/Customer is AT the dealership right now/.test(index), "on-site staff todo is urgent-worded");

console.log("PASS on-site arrival reply eval (parser-first on_site field + reply split + 5-site wiring)");
