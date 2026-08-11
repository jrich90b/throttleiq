/**
 * A price we cannot answer says WHY (Joe, 2026-08-11).
 *
 * Joe: *"I think the only reason why it might not be able to answer is because there might be no
 * price listed on the website sometimes."* Tested, and he was right — with a sharper shape.
 *
 * MEASURED on the live inventory snapshot, 66 units:
 *   **17 carry no price at all — 13 of 26 USED (50%) against 4 of 40 new (10%).**
 * Half the used floor has no price in the feed. Unpriced units span 2005→2026 and include new
 * Breakouts, so the concentration is CONDITION, not year or model.
 *
 * A second, separate cause: of 17 `Room58 - Request details` price-askers, **only 9 carried a stock#
 * at all** — for the rest there is no unit to look up. Three different situations were producing one
 * vague sentence: *"I'll have the team confirm the current price and send it over."*
 *
 * ⚠️ THIS NEVER QUOTES A FIGURE. Whether to quote a price we DO hold is a money-path decision and
 * Joe's alone. `priced` and `unit_unknown` keep today's wording exactly; only `not_posted` — where we
 * know the unit and the site simply has no price on it — gets the honest line.
 *
 * Run: npx tsx scripts/price_deferral_says_why_eval.ts
 */
import assert from "node:assert/strict";

async function main(): Promise<void> {
  const mod: any = await import("../services/api/src/domain/inventoryFactAnswers.ts");
  const { classifyPriceAnswerability } = mod;

  // --- which of the three are we in? -----------------------------------------------------------
  assert.equal(classifyPriceAnswerability(null), "unit_unknown", "no lookup at all");
  assert.equal(classifyPriceAnswerability(undefined), "unit_unknown", "no lookup at all");
  assert.equal(
    classifyPriceAnswerability({ price: 21999, item: { stockId: "T14-26" } }),
    "priced",
    "the feed has a price"
  );
  // The measured majority case on used inventory: the unit is REAL, the website has no price on it.
  assert.equal(
    classifyPriceAnswerability({ price: null, item: { stockId: "U588-23" } }),
    "not_posted",
    "unit matched, no price — 13 of our 26 used units look like this"
  );
  assert.equal(classifyPriceAnswerability({ price: 0, item: { stockId: "S9-25" } }), "not_posted", "zero is not a price");
  assert.equal(
    classifyPriceAnswerability({ price: 21999 }),
    "unit_unknown",
    "a price with no unit is not something we can stand behind"
  );

  // --- the copy ---------------------------------------------------------------------------------
  // Reached through the exported answer path so this pins what a CUSTOMER sees, not a private helper.
  // NOT behind an `if`. The first cut wrote `if (build) { ... }`, the builder was not exported, and
  // every assertion below was silently SKIPPED while the eval printed PASS. A conditional guard around
  // the assertions is an eval that verifies nothing.
  const build = mod.buildPendingPriceConfirmationReply;
  assert.equal(typeof build, "function", "the copy builder must be reachable, or nothing below runs");
  {
    const notPosted = build("2023 Low Rider S", "not_posted");
    const priced = build("2023 Low Rider S", "priced");
    const unknown = build("2023 Low Rider S", "unit_unknown");

    assert.ok(/isn’t posted with a price yet|isn't posted with a price yet/i.test(notPosted), "it says the price is not posted");
    assert.ok(/manager/i.test(notPosted), "…and names who is getting the number");
    assert.ok(/^[A-Z]/.test(notPosted.trim()), "…and starts with a capital letter, not a bare 'the'");

    // The fail-safe default: anything we are unsure about keeps today's wording, unchanged.
    assert.equal(priced, unknown, "priced and unknown are untouched — only not_posted changed");
    assert.ok(/confirm the current price/i.test(priced), "…and that wording is today's");

    // NEVER a figure, in any branch. This is the money-path line and it is not the loop's to cross.
    for (const [label, text] of [["not_posted", notPosted], ["priced", priced], ["unknown", unknown]] as const) {
      assert.ok(!/\$\s?\d/.test(text), `${label}: a deferral must never quote a number`);
    }
  }

  console.log("PASS price deferral says why — not-posted is named honestly, and no branch quotes a figure.");
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
