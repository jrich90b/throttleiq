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
export function parseHdModelsFromNextData(nextData: any): HdCatalogModel[] {
  const out: HdCatalogModel[] = [];
  const seen = new Set<string>();
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

/** Convenience: raw HTML -> models. */
export function parseHdCatalog(html: string): HdCatalogModel[] {
  const data = extractNextData(html);
  return data ? parseHdModelsFromNextData(data) : [];
}
