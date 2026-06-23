/**
 * Harley-Davidson current-model catalog parser. HD's motorcycles index is a Next.js page whose
 * __NEXT_DATA__ blob carries fully-structured model objects ({name, modelCode, priceFormatted,
 * monthlyPriceFormatted, url.urlPath, colorOptionsCollection}). We parse THAT (structured JSON, by
 * object shape) rather than scraping the DOM — robust to layout changes.
 *
 * This is the auto-source behind the discontinuation/pricing seam (findModelInMsrp): a scheduled job
 * scrapes HD -> writes the catalog -> the heuristic reads current, complete data instead of a
 * hand-maintained file. robots.txt permits /us/en/motorcycles/. The parser is pure (HTML/data in,
 * models out) so it's eval-tested against a fixture without hitting the network.
 */

export type HdCatalogModel = {
  name: string; // "Street Bob" (decorations stripped)
  modelCode: string; // "FXBB" — aligns with the MSRP sheet's model_code
  year: number | null; // model year (the scraper tags from which year's page it parsed)
  priceFormatted: string; // "$14,999"
  price: number | null; // 14999
  monthlyPriceFormatted: string | null; // "$231"
  urlPath: string | null; // "/motorcycles/street-bob.html"
};

/** Extract the __NEXT_DATA__ JSON object from the raw page HTML, or null. */
export function extractNextData(html: string): any | null {
  const m = String(html ?? "").match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

/** The model year a page represents — the most frequent "year":NNNN in its __NEXT_DATA__. So a page
 *  self-reports its year (index.html -> current, /2025/index.html -> 2025); no hardcoding. */
export function extractModelYear(html: string): number | null {
  const data = extractNextData(html);
  if (!data) return null;
  const counts = new Map<number, number>();
  for (const m of JSON.stringify(data).matchAll(/"year":\s*"?(\d{4})"?/g)) {
    const y = Number(m[1]);
    if (y >= 2015 && y <= 2035) counts.set(y, (counts.get(y) ?? 0) + 1);
  }
  let best: number | null = null;
  let bestN = 0;
  for (const [y, n] of counts) if (n > bestN) { bestN = n; best = y; }
  return best;
}

const cleanName = (raw: string): string =>
  String(raw ?? "")
    .replace(/<sup>.*?<\/sup>/gi, "")
    .replace(/[®™®™]/g, "")
    .replace(/\s+/g, " ")
    .trim();

const parsePrice = (formatted: string): number | null => {
  const n = Number(String(formatted ?? "").replace(/[^0-9]/g, ""));
  return Number.isFinite(n) && n > 0 ? n : null;
};

/** Walk the __NEXT_DATA__ object for model entries (objects with name + modelCode + priceFormatted),
 *  deduped by modelCode. Pure. */
export function parseHdModelsFromNextData(nextData: any, opts?: { year?: number | null }): HdCatalogModel[] {
  const out: HdCatalogModel[] = [];
  const seen = new Set<string>();
  const year = opts?.year ?? null;
  const visit = (o: any): void => {
    if (!o || typeof o !== "object") return;
    if (Array.isArray(o)) {
      o.forEach(visit);
      return;
    }
    if (typeof o.name === "string" && typeof o.modelCode === "string" && typeof o.priceFormatted === "string") {
      const code = o.modelCode.trim();
      if (code && !seen.has(code)) {
        seen.add(code);
        out.push({
          name: cleanName(o.name),
          modelCode: code,
          year,
          priceFormatted: String(o.priceFormatted).trim(),
          price: parsePrice(o.priceFormatted),
          monthlyPriceFormatted: typeof o.monthlyPriceFormatted === "string" ? o.monthlyPriceFormatted.trim() : null,
          urlPath: o?.url?.urlPath ?? null
        });
      }
    }
    for (const k of Object.keys(o)) visit(o[k]);
  };
  visit(nextData);
  return out.sort((a, b) => (a.price ?? 0) - (b.price ?? 0));
}

/** Convenience: raw HTML -> models (tag with the model year the page represents). */
export function parseHdCatalog(html: string, opts?: { year?: number | null }): HdCatalogModel[] {
  const data = extractNextData(html);
  return data ? parseHdModelsFromNextData(data, opts) : [];
}

// --- Runtime: read the scraped catalog + match a model against it (the discontinuation seam) ---

const normTok = (s: string): string => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
function scoreMatch(query: string, candidate: string): number {
  if (!query || !candidate) return 0;
  if (query === candidate) return 100 + candidate.length;
  if (query.includes(candidate)) return 80 + candidate.length;
  if (candidate.includes(query)) return 60 + query.length;
  return 0;
}

/** Best match of a model string against the scraped catalog (name/modelCode), with the same 60+ score
 *  threshold as the MSRP matcher. Pure. */
export function findModelInHdCatalog(
  models: HdCatalogModel[] | null | undefined,
  query: string
): { matched: boolean; score: number; year: number | null; name: string | null } {
  const q = normTok(query);
  if (!q || !models?.length) return { matched: false, score: 0, year: null, name: null };
  let best: HdCatalogModel | null = null;
  let bestScore = 0;
  for (const m of models) {
    const s = Math.max(scoreMatch(q, normTok(m.name)), scoreMatch(q, normTok(m.modelCode)));
    if (s > bestScore) { bestScore = s; best = m; }
  }
  return { matched: bestScore >= 60, score: bestScore, year: best?.year ?? null, name: best?.name ?? null };
}

let catalogCache: { models: HdCatalogModel[]; loadedAt: number } | null = null;
const CATALOG_TTL_MS = 10 * 60 * 1000;

/** Load the scraped HD catalog from the runtime store. Returns [] if it hasn't been scraped yet (so
 *  callers gracefully fall back to the static MSRP sheet). Cached. */
export async function loadHdCatalog(filePath?: string): Promise<HdCatalogModel[]> {
  const now = Date.now();
  if (catalogCache && now - catalogCache.loadedAt < CATALOG_TTL_MS) return catalogCache.models;
  const { readFile } = await import("node:fs/promises");
  const path = await import("node:path");
  const file =
    filePath ||
    process.env.HD_CATALOG_OUT ||
    path.join(process.env.REPORT_ROOT || "data/hd_catalog", "hd_current_catalog.json");
  try {
    const data = JSON.parse(await readFile(file, "utf8"));
    const models: HdCatalogModel[] = Array.isArray(data?.models) ? data.models : Array.isArray(data) ? data : [];
    catalogCache = { models, loadedAt: now };
    return models;
  } catch {
    catalogCache = { models: [], loadedAt: now };
    return [];
  }
}
