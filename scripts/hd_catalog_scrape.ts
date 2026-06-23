/**
 * HD current-catalog scraper (the auto-source so we never hand-update models/pricing). Fetches HD's
 * motorcycles index (robots.txt permits /us/en/motorcycles/), parses the __NEXT_DATA__ model objects,
 * and writes a catalog JSON. FRESHNESS GUARD: if it parses fewer than HD_CATALOG_MIN models (HD changed
 * their markup / a bad fetch), it does NOT overwrite the last-good catalog and exits 2 so a cron alerts.
 *
 *   npx tsx scripts/hd_catalog_scrape.ts
 */
import fs from "node:fs";
import path from "node:path";
import { parseHdCatalog } from "../services/api/src/domain/hdCatalog.ts";

const URL = process.env.HD_CATALOG_URL || "https://www.harley-davidson.com/us/en/motorcycles/index.html";
const OUT = process.env.HD_CATALOG_OUT || path.join(process.env.REPORT_ROOT || "data/hd_catalog", "hd_current_catalog.json");
const MIN_MODELS = Number(process.env.HD_CATALOG_MIN || 15);

const resp = await fetch(URL, {
  headers: { "User-Agent": "Mozilla/5.0 (compatible; LeadRiderCatalogSync/1.0; +catalog-refresh)" }
});
if (!resp.ok) {
  console.error(`hd_catalog: fetch failed (${resp.status}) — keeping last-good.`);
  process.exit(2);
}
const html = await resp.text();
const models = parseHdCatalog(html);

if (models.length < MIN_MODELS) {
  console.error(`hd_catalog: only ${models.length} models parsed (< ${MIN_MODELS}) — HD markup may have changed. NOT overwriting last-good; exit 2 for alert.`);
  process.exit(2);
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify({ fetchedAt: new Date().toISOString(), source: URL, count: models.length, models }, null, 2));
console.log(`hd_catalog: wrote ${models.length} models -> ${OUT}`);
console.log(`  cheapest: ${models[0]?.name} ${models[0]?.priceFormatted}; dearest: ${models[models.length - 1]?.name} ${models[models.length - 1]?.priceFormatted}`);
