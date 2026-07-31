/**
 * OpenAI usage pricing coverage eval (2026-07-31).
 *
 * THE BLIND SPOT. `gpt-5` is the draft A/B challenger and the browser-automation model, and it was
 * missing from the usage logger's rate table. `estimateCostUsd` returns null for an unknown model,
 * so a real 6,640-token call recorded `estimatedCostUsd: null` and July's spend summed to $29.21
 * with those calls counted as FREE. A missing rate did not look like a missing rate — it looked
 * like zero, which is the most expensive kind of wrong.
 *
 * That matters right now because the open question is whether to run COMPREHENSION on a stronger
 * model. An experiment whose cost reports as $0 cannot be judged on cost.
 *
 * THE RULE THIS PINS: every model the code can select must be either PRICED or explicitly
 * ACKNOWLEDGED as unpriced with a reason. Silence is not an option. A guessed rate is also not an
 * option — it produces a confident wrong number nobody re-checks — so the acknowledged list is the
 * honest place for "we haven't read the real rate off the dashboard yet".
 *
 * Run: npx tsx scripts/openai_usage_pricing_eval.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { UNPRICED_ACKNOWLEDGED } from "../services/api/src/domain/openaiUsageLogger.ts";

let n = 0;
const loggerSrc = fs.readFileSync("services/api/src/domain/openaiUsageLogger.ts", "utf8");

// The rate table, read from source so the eval can't drift from what ships.
const priced = new Set(
  [...loggerSrc.matchAll(/^\s+"([a-z0-9.\-]+)":\s*\{\s*inputPerMillion/gm)].map(m => m[1].toLowerCase())
);
assert.ok(priced.size >= 4, `expected a populated rate table, found ${priced.size}`);
n += 1;

// --- 1. EVERY SELECTABLE MODEL IS PRICED OR ACKNOWLEDGED -----------------------------------------
{
  // Model literals the code can fall back to, i.e. what actually runs when no env override is set.
  // This is the same scan shape that would have caught gpt-5 on the day the A/B shipped.
  const sources = [
    "services/api/src/index.ts",
    "services/api/src/domain/llmDraft.ts",
    "services/api/src/connectors/crm/tlpBrowserUse.ts"
  ].filter(f => fs.existsSync(f));
  assert.ok(sources.length >= 2, "expected the main model-selecting sources to exist");
  n += 1;

  const selectable = new Set<string>();
  for (const file of sources) {
    const src = fs.readFileSync(file, "utf8");
    for (const m of src.matchAll(/\|\|\s*"((?:gpt|o[0-9]|chatgpt)[a-z0-9.\-]*)"/g)) {
      selectable.add(m[1].toLowerCase());
    }
  }
  assert.ok(selectable.size >= 2, `expected to find selectable model defaults, found ${selectable.size}`);
  n += 1;

  const unknown = [...selectable].filter(m => !priced.has(m) && !(m in UNPRICED_ACKNOWLEDGED));
  assert.deepEqual(
    unknown,
    [],
    `these models can run but have NO rate and are NOT acknowledged — their spend would silently ` +
      `report as $0: ${unknown.join(", ")}. Add a real rate (from the billing dashboard, never a ` +
      `guess) or list them in UNPRICED_ACKNOWLEDGED with a reason.`
  );
  n += 1;
}

// --- 2. THE ACKNOWLEDGED LIST MUST STAY HONEST ---------------------------------------------------
{
  assert.ok(Object.keys(UNPRICED_ACKNOWLEDGED).length > 0, "the acknowledged list documents a real gap today");
  for (const [model, reason] of Object.entries(UNPRICED_ACKNOWLEDGED)) {
    assert.ok(reason.trim().length >= 20, `"${model}" needs a REASON, not a placeholder — got "${reason}"`);
    // Acknowledged means "knowingly unpriced". A model in both lists is a contradiction.
    assert.ok(!priced.has(model.toLowerCase()), `"${model}" is both priced and acknowledged-unpriced`);
    n += 2;
  }
  // gpt-5 is the live example; if someone adds its real rate, it must leave this list.
  assert.ok(
    "gpt-5" in UNPRICED_ACKNOWLEDGED || priced.has("gpt-5"),
    "gpt-5 must be either priced or acknowledged — it is a live model (draft A/B + browser automation)"
  );
  n += 1;
}

// --- 3. A NULL COST MUST BE DISTINGUISHABLE FROM FREE --------------------------------------------
{
  assert.match(
    loggerSrc,
    /pricingKnown: model \? pricingForModel\(model\) != null : false/,
    "every usage row records whether a rate was known, so a null cost cannot read as zero"
  );
  // The estimator must keep returning null (not 0) for an unknown model — 0 would be a lie that
  // even pricingKnown could not undo in a naive sum.
  assert.match(
    loggerSrc,
    /const pricing = pricingForModel\(model\);\s*\n\s*if \(!pricing\) return null;/,
    "an unknown model estimates to null, never to 0"
  );
  n += 2;

  // The env override remains the no-deploy path to supply a real rate.
  assert.match(loggerSrc, /OPENAI_USAGE_PRICING_JSON/, "a real rate can be supplied without a code change");
  n += 1;
}

console.log(`PASS openai usage pricing coverage eval (${n} assertions)`);
