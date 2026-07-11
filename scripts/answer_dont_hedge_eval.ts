/**
 * answer_dont_hedge:eval — pins the "answer, don't hedge" voice rule in the reply composer.
 *
 * Context: a judged audit of a month of drafts found ~20% were punts ("I'll check and follow up")
 * and ~70% of those were AVOIDABLE — the agent hedged when the thread already gave it what it needed
 * to answer or advance (confirm a time, give a spec, ask the one needed question). The fix is a voice
 * rule in generateDraftWithLLM (the composer shared by BOTH the live and regenerate paths) that tells
 * the model to answer/advance instead of stalling.
 *
 * This is a source tripwire (pure, no LLM), the same discipline as phantom_visit_intro/unified_slots:
 * it guarantees the rule — AND its two safety rails — can't be silently dropped or weakened:
 *   1. the rule exists (answer/advance instead of a hollow deferral),
 *   2. it still PROTECTS legitimate deferrals (finance decision, appraisal, parts lookup, service
 *      records, physically checking a bike) — so it never becomes a blanket "never defer",
 *   3. the fabrication rule still WINS (never invent a price/rate/stock/availability to avoid a defer).
 * Rails 2+3 are the fail-direction guard: over-suppressing a defer would push the agent to answer
 * something it can't, i.e. fabricate — the more dangerous miss.
 *
 * Run: npx tsx scripts/answer_dont_hedge_eval.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

let failures = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (err: any) {
    failures += 1;
    console.error(`FAIL ${name}: ${err?.message ?? err}`);
  }
}

const source = fs.readFileSync(
  path.join(process.cwd(), "services/api/src/domain/llmDraft.ts"),
  "utf8"
);

check("composer carries the ANSWER-DON'T-HEDGE rule header", () => {
  assert.ok(source.includes("ANSWER, DON'T HEDGE (strict):"), "rule header missing from generateDraftWithLLM");
});

check("rule bans the hollow deferral", () => {
  assert.ok(
    source.includes("Do NOT send a hollow") && /I'll check and follow up/.test(source),
    "the 'no hollow I\\'ll-follow-up' instruction is missing"
  );
});

check("rule tells it to confirm a named day/time instead of hedging", () => {
  assert.ok(
    /named a specific day or time, confirm it or counter/.test(source),
    "the specific-day/time confirm instruction is missing"
  );
});

check("RAIL 1: legitimate deferrals are still protected (fail-safe, not a blanket ban)", () => {
  assert.ok(source.includes("ONLY defer"), "the 'ONLY defer when you genuinely need…' protection clause is missing");
  for (const reason of ["finance/credit decision", "trade appraisal", "parts or backorder lookup", "service records", "physically checking"]) {
    assert.ok(source.includes(reason), `protected-deferral reason missing: "${reason}"`);
  }
});

check("RAIL 2: the anti-fabrication rule still wins over answering", () => {
  assert.ok(
    /Never invent a price, rate, stock number, or availability/.test(source),
    "the 'never fabricate to avoid deferring' safety clause is missing"
  );
});

check("the rule lives in the shared composer (both live + regenerate use generateDraftWithLLM)", () => {
  const composerIdx = source.indexOf("export async function generateDraftWithLLM");
  const ruleIdx = source.indexOf("ANSWER, DON'T HEDGE (strict):");
  assert.ok(composerIdx >= 0, "generateDraftWithLLM not found");
  assert.ok(ruleIdx > composerIdx, "the rule must sit inside generateDraftWithLLM's instructions");
});

if (failures) {
  console.error(`answer_dont_hedge:eval FAILED (${failures})`);
  process.exit(1);
}
console.log("answer_dont_hedge:eval OK");
