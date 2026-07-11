/**
 * inventory_fact_answer_from_feed:eval — Phase 2 of the answer-don't-hedge program.
 *
 * The judged punt audit found ~12 avoidable "data" punts: the agent hedged on price, photos, and
 * mileage it should be able to look up. Root cause: those facts live in the inventory feed but were
 * never handed to the reply composer. This pins the fix end-to-end:
 *   1. the feed now parses mileage (<miles>), 0/blank => null (never "0 miles"),
 *   2. the composer CONTEXT carries inventoryListPrice / inventoryMileage / inventoryImageUrls,
 *   3. the composer RULES let it STATE list price / mileage / photos when present — but keep
 *      out-the-door price a handoff and never fabricate a missing fact,
 *   4. the shared orchestrator populates the facts into the draft context (both paths).
 *
 * Deterministic (pure mileage parse + source tripwires); no LLM, no network.
 * Run: npx tsx scripts/inventory_fact_answer_from_feed_eval.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

process.env.OPENAI_API_KEY ||= "test-key-not-used";

const { mileageForItem } = await import("../services/api/src/domain/inventoryFeed.ts");

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

// --- 1. mileage parse (pure) ---
check("mileage: parses <miles> from a raw feed item", () => {
  assert.equal(mileageForItem({ miles: "12,480" }), 12480);
  assert.equal(mileageForItem({ miles: 3200 }), 3200);
});
check("mileage: reads a normalized snapshot item's mileage field", () => {
  assert.equal(mileageForItem({ mileage: 5000 }), 5000);
});
check("mileage: 0 / blank / missing => null (never states '0 miles')", () => {
  assert.equal(mileageForItem({ miles: "0" }), null);
  assert.equal(mileageForItem({ miles: "" }), null);
  assert.equal(mileageForItem({}), null);
  assert.equal(mileageForItem(null), null);
});
check("mileage: falls back to odometer fields", () => {
  assert.equal(mileageForItem({ odometer: "21750" }), 21750);
});

// --- 2/3. composer context + rules (source tripwire) ---
const llmSrc = fs.readFileSync(path.join(process.cwd(), "services/api/src/domain/llmDraft.ts"), "utf8");

check("DraftContext carries the three feed-fact fields", () => {
  for (const f of ["inventoryListPrice?: number | null;", "inventoryMileage?: number | null;", "inventoryImageUrls?: string[] | null;"]) {
    assert.ok(llmSrc.includes(f), `DraftContext missing field: ${f}`);
  }
});

check("composer INJECTS the fact values into the prompt context", () => {
  assert.ok(/inventoryListPrice: \$\{/.test(llmSrc), "inventoryListPrice value not injected into prompt");
  assert.ok(/inventoryMileage: \$\{/.test(llmSrc), "inventoryMileage value not injected into prompt");
  assert.ok(/inventoryImageUrls: \$\{/.test(llmSrc), "inventoryImageUrls value not injected into prompt");
});

check("composer RULES: state list price, but out-the-door defers and no fabrication", () => {
  assert.ok(llmSrc.includes("INVENTORY FACTS YOU MAY STATE"), "inventory-facts rule block missing");
  assert.ok(/This is the ONLY price you may give/.test(llmSrc), "list-price-only rule missing");
  assert.ok(/OUT-THE-DOOR/.test(llmSrc) && /do NOT compute, estimate, or guess/.test(llmSrc), "out-the-door handoff rule missing");
  assert.ok(/NEVER invent one/.test(llmSrc), "no-fabrication clause missing");
  assert.ok(/inventoryImageUrls: if they ask for photos/.test(llmSrc), "photo-share rule missing");
});

// --- 4. shared orchestrator populates the facts (both paths) ---
const orchSrc = fs.readFileSync(path.join(process.cwd(), "services/api/src/domain/orchestrator.ts"), "utf8");
check("orchestrator resolves + passes the feed facts into the draft context", () => {
  assert.ok(/inventoryListPrice,\s*\n\s*inventoryMileage,\s*\n\s*inventoryImageUrls,/.test(orchSrc), "draftCtx does not pass the three facts");
  assert.ok(/findInventoryPrice\(\{ stockId: stockForNote, vin: vinForNote \}\)/.test(orchSrc), "facts lookup by the discussed unit missing");
  assert.ok(/if \(stockForNote \|\| vinForNote\)/.test(orchSrc), "facts must only resolve for a specific unit (not a general model inquiry)");
});

if (failures) {
  console.error(`inventory_fact_answer_from_feed:eval FAILED (${failures})`);
  process.exit(1);
}
console.log("inventory_fact_answer_from_feed:eval OK");
