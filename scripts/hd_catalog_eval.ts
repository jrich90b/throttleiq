/**
 * HD catalog parser eval (no network) — pins parseHdModelsFromNextData against a fixture mimicking
 * HD's __NEXT_DATA__ shape: decoration stripping, price parsing, dedup-by-modelCode, noise rejection,
 * and the discontinuation tie-in (a discontinued model is simply absent from the catalog).
 * Run: npx tsx scripts/hd_catalog_eval.ts
 */
import assert from "node:assert/strict";

import { parseHdModelsFromNextData, parseHdCatalog, extractNextData, extractModelYear, findModelInHdCatalog, type HdCatalogModel } from "../services/api/src/domain/hdCatalog.ts";

// Fixture shaped like the real __NEXT_DATA__ (model objects nested arbitrarily; Fat Bob NOT present).
const nextData = {
  props: {
    pageProps: {
      categories: [
        { name: "Cruiser", items: [
          { name: "Street Bob®", modelCode: "FXBB", priceFormatted: "$14,999", monthlyPriceFormatted: "$231", url: { urlPath: "/motorcycles/street-bob.html" } },
          { name: "Low Rider<sup>®</sup> S", modelCode: "FXLRS", priceFormatted: "$18,999", url: { urlPath: "/motorcycles/low-rider-s.html" } }
        ] },
        { name: "Touring", items: [
          { name: "Street Glide®", modelCode: "FLHX", priceFormatted: "$24,999", monthlyPriceFormatted: "$385", url: { urlPath: "/motorcycles/street-glide.html" } },
          { name: "Street Bob®", modelCode: "FXBB", priceFormatted: "$14,999" } // duplicate -> deduped
        ] }
      ],
      noise: [{ name: "Not a model — no code/price" }, { modelCode: "X", priceFormatted: "$1" /* no name */ }]
    }
  }
};

const models = parseHdModelsFromNextData(nextData, { year: 2026 });
assert.equal(models.length, 3, `3 unique models (dup deduped, noise skipped), got ${models.length}`);
assert.ok(models.every(m => m.year === 2026), "models tagged with the page's model year");

const sb = models.find(m => m.modelCode === "FXBB")!;
assert.equal(sb.name, "Street Bob", "® decoration stripped");
assert.equal(sb.price, 14999, "price parsed from $14,999");
assert.equal(sb.monthlyPriceFormatted, "$231", "monthly carried");
assert.equal(sb.urlPath, "/motorcycles/street-bob.html", "detail url carried");

const lr = models.find(m => m.modelCode === "FXLRS")!;
assert.equal(lr.name, "Low Rider S", "<sup>®</sup> stripped");

// sorted by price ascending
assert.deepEqual(models.map(m => m.modelCode), ["FXBB", "FXLRS", "FLHX"], "sorted by price");

// HTML -> models via __NEXT_DATA__ extraction
const html = `<html><head></head><body><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(nextData)}</script></body></html>`;
assert.equal(parseHdCatalog(html).length, 3, "parseHdCatalog extracts from raw HTML");
assert.ok(extractNextData("<html>no next data</html>") === null, "missing __NEXT_DATA__ -> null");

// self-reported model year: the most frequent "year":NNNN in the data
const yearHtml = `<html><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ a: { year: 2025 }, b: { year: 2025 }, c: { year: 2024 } })}</script></html>`;
assert.equal(extractModelYear(yearHtml), 2025, "extractModelYear picks the dominant year");
assert.equal(extractModelYear("<html>nope</html>"), null, "no data -> null year");

// discontinuation tie-in: a discontinued model (Fat Bob) is simply ABSENT from the live catalog
assert.ok(!parseHdCatalog(html).some(m => /fat bob/i.test(m.name)), "Fat Bob absent (discontinued)");

// --- the SEAM matcher: findModelInHdCatalog (what the discontinuation resolver consults) ---
const cat: HdCatalogModel[] = [
  { name: "Street Bob", modelCode: "FXBB", year: 2026, priceFormatted: "$14,999", price: 14999, monthlyPriceFormatted: null, urlPath: null },
  { name: "Road King Special", modelCode: "FLHRXS", year: 2025, priceFormatted: "$24,999", price: 24999, monthlyPriceFormatted: null, urlPath: null }
];
assert.equal(findModelInHdCatalog(cat, "Fat Bob").matched, false, "Fat Bob not in catalog -> not matched (discontinued)");
assert.equal(findModelInHdCatalog(cat, "Street Bob").matched, true, "current model matched");
const rks = findModelInHdCatalog(cat, "Road King Special");
assert.ok(rks.matched && rks.year === 2025, "prior-year (2025) model matched -> NOT flagged discontinued");
assert.equal(findModelInHdCatalog([], "Street Bob").matched, false, "empty catalog -> no match (caller falls back to MSRP file)");

console.log(`PASS hd-catalog parser — ${models.length} models from fixture (strip/price/dedup/noise/sort + HTML extraction + discontinuation absence).`);
