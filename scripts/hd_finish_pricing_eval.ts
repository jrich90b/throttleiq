/**
 * HD detail-page finish pricing eval (no network). Pins the catalog-first path in findMsrpPricing:
 * when HD_CATALOG_FINISH_PRICING=1, a customer who names a color gets an EXACT finish price
 * (base + color adder) sourced from the scraped catalog — not a range. Also pins the safe behavior:
 * flag off => catalog ignored (static sheet only); color-less => range; model absent from catalog =>
 * falls back to the static MSRP sheet; year-aware (2025 vs 2026) finish.
 *
 * Run: npx tsx scripts/hd_finish_pricing_eval.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Point the catalog loader at a temp fixture BEFORE importing the module under test. Use a model name
// that is NOT in the static MSRP sheet so a flag-off lookup cleanly proves the catalog was the source.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hd-finish-"));
const catalogPath = path.join(tmp, "hd_current_catalog.json");
fs.writeFileSync(
  catalogPath,
  JSON.stringify({
    fetchedAt: "2026-01-01T00:00:00Z",
    count: 2,
    models: [
      {
        name: "Finish Test Glide", modelCode: "ZZTEST", year: 2026,
        priceFormatted: "$20,000", price: 20000, monthlyPriceFormatted: null, urlPath: null,
        finish: { baseMsrp: 20000, colors: [
          { name: "Dark Billiard Gray", adder: 0 },
          { name: "Vivid Black", adder: 300 },
          { name: "Blood Orange", adder: 1200 }
        ] }
      },
      {
        name: "Finish Test Glide", modelCode: "ZZTEST", year: 2025,
        priceFormatted: "$19,000", price: 19000, monthlyPriceFormatted: null, urlPath: null,
        finish: { baseMsrp: 19000, colors: [
          { name: "Vivid Black", adder: 0 },
          { name: "Apex Factory Custom", adder: 500 }
        ] }
      }
    ]
  })
);
process.env.HD_CATALOG_OUT = catalogPath;

const { findMsrpPricing } = await import("../services/api/src/domain/msrpPriceList.ts");

// --- Flag ON: exact finish pricing from the catalog ---
process.env.HD_CATALOG_FINISH_PRICING = "1";

// "how much for the Finish Test Glide in Billiard Gray?" -> exact base + $0
const gray = await findMsrpPricing({ model: "Finish Test Glide", year: "2026", colorText: "Billiard Gray" });
assert.ok(gray, "catalog lookup returns a result");
assert.equal(gray!.exact, 20000, "Billiard Gray (adder 0) -> exact base MSRP");
assert.equal(gray!.color?.name, "Dark Billiard Gray", "matched the catalog color");

// a color with an adder -> exact base + adder (the point of this build)
const black = await findMsrpPricing({ model: "Finish Test Glide", year: "2026", colorText: "Vivid Black" });
assert.equal(black!.exact, 20300, "Vivid Black (+$300) -> exact $20,300");

// no color named -> NO fabricated exact; a range across colors (safe fallback the orchestrator renders)
const noColor = await findMsrpPricing({ model: "Finish Test Glide", year: "2026" });
assert.equal(noColor!.exact, null, "no color -> no exact");
assert.deepEqual(noColor!.range, { min: 20000, max: 21200 }, "range = base..base+maxColorAdder");

// year-aware: 2025 has its own (cheaper) finish sheet
const y2025 = await findMsrpPricing({ model: "Finish Test Glide", year: "2025", colorText: "Apex" });
assert.equal(y2025!.exact, 19500, "2025 finish: base 19000 + Apex 500 = 19500");

// model present in the static sheet but ABSENT from the catalog -> falls back to the sheet (Nightster=9999)
const fallback = await findMsrpPricing({ model: "Nightster", year: "2026" });
assert.ok(fallback, "catalog miss falls back to the static MSRP sheet");
assert.equal(fallback!.range.min, 9999, "fell back to the sheet's Nightster base MSRP");

// --- Flag OFF: catalog ignored, static-sheet behavior unchanged ---
process.env.HD_CATALOG_FINISH_PRICING = "0";
const off = await findMsrpPricing({ model: "Finish Test Glide", year: "2026", colorText: "Vivid Black" });
assert.equal(off, null, "flag off -> catalog not consulted; model not in sheet -> null");
const offSheet = await findMsrpPricing({ model: "Nightster", year: "2026" });
assert.equal(offSheet!.range.min, 9999, "flag off -> static sheet still works (regression)");

fs.rmSync(tmp, { recursive: true, force: true });
console.log("PASS hd-finish-pricing — catalog-first exact color pricing (flag on), range fallback, year-aware, sheet fallback, flag-off no-op.");
