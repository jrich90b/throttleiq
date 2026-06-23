/**
 * HD current-catalog scraper (the auto-source so we never hand-update models/pricing). Fetches HD's
 * motorcycles lineup for the CURRENT model year (/us/en/motorcycles/index.html) AND prior years
 * (/us/en/motorcycles/{year}/index.html — dealers still sell prior-year units), parses each page's
 * __NEXT_DATA__ model objects, tags by the year the page self-reports, and writes a combined catalog.
 *
 * FRESHNESS GUARD: if the CURRENT-year page parses fewer than HD_CATALOG_MIN models (HD changed markup /
 * bad fetch), it does NOT overwrite the last-good catalog and exits 2 so a cron alerts. Prior years are
 * best-effort (a missing archive doesn't fail the run). robots.txt permits /us/en/motorcycles/.
 *
 *   npx tsx scripts/hd_catalog_scrape.ts          # default years: current + 2025
 *   HD_CATALOG_PRIOR_YEARS=2025,2024 npx tsx scripts/hd_catalog_scrape.ts
 */
import fs from "node:fs";
import path from "node:path";
import { parseHdCatalog, extractModelYear, type HdCatalogModel } from "../services/api/src/domain/hdCatalog.ts";

const BASE = process.env.HD_CATALOG_BASE || "https://www.harley-davidson.com/us/en/motorcycles";
const OUT = process.env.HD_CATALOG_OUT || path.join(process.env.REPORT_ROOT || "data/hd_catalog", "hd_current_catalog.json");
const MIN_MODELS = Number(process.env.HD_CATALOG_MIN || 15);
const PRIOR_YEARS = (process.env.HD_CATALOG_PRIOR_YEARS || "2025").split(",").map(s => s.trim()).filter(Boolean);
const UA = "Mozilla/5.0 (compatible; LeadRiderCatalogSync/1.0; +catalog-refresh)";

async function fetchModels(url: string): Promise<HdCatalogModel[] | null> {
  try {
    const r = await fetch(url, { headers: { "User-Agent": UA } });
    if (!r.ok) { console.error(`  ${url} -> ${r.status}`); return null; }
    const html = await r.text();
    const year = extractModelYear(html);
    const models = parseHdCatalog(html, { year });
    console.error(`  ${url} -> year ${year ?? "?"}, ${models.length} models`);
    return models;
  } catch (e) {
    console.error(`  ${url} -> error`);
    return null;
  }
}

// CURRENT year (the live index) — this one gates the run.
const current = await fetchModels(`${BASE}/index.html`);
if (!current || current.length < MIN_MODELS) {
  console.error(`hd_catalog: current-year page parsed ${current?.length ?? 0} models (< ${MIN_MODELS}). HD markup may have changed — NOT overwriting last-good; exit 2.`);
  process.exit(2);
}

// PRIOR years (archives) — best-effort; a missing archive is fine.
const all: HdCatalogModel[] = [...current];
for (const y of PRIOR_YEARS) {
  const prior = await fetchModels(`${BASE}/${y}/index.html`);
  if (prior?.length) all.push(...prior);
}

// Dedup by modelCode + year (a model legitimately appears once per year it was made).
const seen = new Set<string>();
const models = all.filter(m => {
  const k = `${m.modelCode}|${m.year}`;
  if (seen.has(k)) return false;
  seen.add(k);
  return true;
});

const byYear: Record<string, number> = {};
for (const m of models) byYear[String(m.year ?? "?")] = (byYear[String(m.year ?? "?")] ?? 0) + 1;

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify({ fetchedAt: new Date().toISOString(), source: BASE, count: models.length, byYear, models }, null, 2));
console.log(`hd_catalog: wrote ${models.length} models across years ${JSON.stringify(byYear)} -> ${OUT}`);
