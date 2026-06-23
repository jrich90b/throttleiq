/**
 * HD catalog parser eval (no network) — pins parseHdModelsFromNextData against a fixture mimicking
 * HD's __NEXT_DATA__ shape: decoration stripping, price parsing, dedup-by-modelCode, noise rejection,
 * and the discontinuation tie-in (a discontinued model is simply absent from the catalog).
 * Run: npx tsx scripts/hd_catalog_eval.ts
 */
import assert from "node:assert/strict";

import { parseHdModelsFromNextData, parseHdCatalog, extractNextData, extractModelYear, findModelInHdCatalog, findBestCatalogModel, parseHdDetailFinish, parseHdDetailFinishFromNextData, type HdCatalogModel } from "../services/api/src/domain/hdCatalog.ts";

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

// --- findBestCatalogModel: returns the full model object (so the pricing seam can read its finish) ---
const yearedCat: HdCatalogModel[] = [
  { name: "Street Bob", modelCode: "FXBB", year: 2026, priceFormatted: "$14,999", price: 14999, monthlyPriceFormatted: null, urlPath: null },
  { name: "Street Bob", modelCode: "FXBB", year: 2025, priceFormatted: "$14,499", price: 14499, monthlyPriceFormatted: null, urlPath: null }
];
assert.equal(findBestCatalogModel(yearedCat, "Street Bob", { year: 2025 })?.price, 14499, "year-specific match prefers that year");
assert.equal(findBestCatalogModel(yearedCat, "Street Bob")?.year, 2026, "no year -> current year wins (index-first order)");
assert.equal(findBestCatalogModel(yearedCat, "Fat Bob"), null, "no match -> null");
assert.equal(findBestCatalogModel(yearedCat, "Street Bob", { year: 2099 })?.year, 2026, "absent year -> falls back to best across years");

// --- parseHdDetailFinish: per-color adders from a model's DETAIL page configurator ---
// Shaped like the real bikeProductDetails: colorOptions repeat a paint name across color codes; the
// related-bike products nest colors under colorOptionsCollection (different key) and must NOT be picked.
const detailNextData = {
  props: { pageProps: { initialState: {
    bikeProductDetails: {
      formattedName: "Street Bob<sup>®</sup>",
      modelName: "street-bob",
      modelFamily: "SOFTAIL",
      modelCode: "FXBB",
      modelYear: 2026,
      priceFormatted: "$14,999",
      monthlyPriceFormatted: "$231",
      colorOptions: [
        { optionName: "Dark Billiard Gray", colorCode: "m85s", additionalPrice: 0, additionalPriceFormatted: "+ $0" },
        { optionName: "Dark Billiard Gray", colorCode: "m85", additionalPrice: 0, additionalPriceFormatted: "+ $0" }, // dup name -> deduped
        { optionName: "Vivid Black", colorCode: "m04", additionalPrice: 300, additionalPriceFormatted: "+ $300" },
        { optionName: "Brilliant Red", colorCode: "m44", additionalPrice: 650, additionalPriceFormatted: "+ $650" },
        { optionName: "Olive Steel Metallic<sup>®</sup>", colorCode: "m73", additionalPriceFormatted: "+ $650" /* no numeric -> parsed from formatted */ }
      ],
      trimOptions: [{ optionName: "Chrome Two-Up", additionalPrice: 1000 }], // seat accessory -> NOT folded into finish
      wheelOptions: [{ optionName: "Laced", additionalPrice: 850 }]
    },
    bikePDPSections: { list: [{ category: { productsCollection: { items: [
      { modelCode: "FLHX", priceFormatted: "$24,999", colorOptionsCollection: { items: [{ optionName: "Other Bike Color", additionalPrice: 9999 }] } }
    ] } } }] }
  } } }
};
const fin = parseHdDetailFinishFromNextData(detailNextData)!;
assert.ok(fin, "detail finish parsed");
assert.equal(fin.modelCode, "FXBB", "right product picked (not the related-bike FLHX)");
assert.equal(fin.name, "Street Bob", "® decoration stripped from detail name");
assert.equal(fin.year, 2026, "model year carried");
assert.equal(fin.finish.baseMsrp, 14999, "base MSRP parsed from priceFormatted");
assert.equal(fin.finish.colors.length, 4, "4 distinct colors (duplicate name deduped)");
assert.deepEqual(fin.finish.colors.map(c => c.adder), [0, 300, 650, 650], "colors sorted by adder ascending");
const vivid = fin.finish.colors.find(c => c.name === "Vivid Black")!;
assert.equal(vivid.adder, 300, "color adder = additionalPrice");
const olive = fin.finish.colors.find(c => /Olive Steel/.test(c.name))!;
assert.equal(olive.adder, 650, "adder parsed from '+ $650' when numeric additionalPrice absent");
assert.equal(olive.name, "Olive Steel Metallic", "® stripped from color name");

// HTML -> finish, and graceful null when there's no configurator
const detailHtml = `<html><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(detailNextData)}</script></html>`;
assert.equal(parseHdDetailFinish(detailHtml)?.finish.baseMsrp, 14999, "parseHdDetailFinish works from raw HTML");
assert.equal(parseHdDetailFinish("<html>no next data</html>"), null, "no __NEXT_DATA__ -> null finish");
assert.equal(parseHdDetailFinishFromNextData({ props: {} }), null, "no bikeProductDetails -> null finish");

console.log(`PASS hd-catalog parser — ${models.length} models from fixture (strip/price/dedup/noise/sort + HTML extraction + discontinuation absence + detail finish pricing + year-aware model match).`);
