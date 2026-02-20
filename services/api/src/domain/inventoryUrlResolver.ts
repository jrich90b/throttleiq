import { fetchHtmlSmart } from "./zenrowsFetch.js";

const DOMAIN = "https://americanharley-davidson.com";

export type ResolveResult =
  | { ok: true; url: string; sourceListUrl: string }
  | { ok: false; reason: "not_found" | "fetch_failed" };

type CacheEntry = { result: ResolveResult; expiresAt: number };
const cache = new Map<string, CacheEntry>();
const TTL_MS = 2 * 60 * 1000; // 2 minutes

// Your all-inventory list base (no page/search_text; we set those)
const DEFAULT_LIST_URLS = [
  "https://americanharley-davidson.com/new-harley-davidson-motorcycles-for-sale-buffalo-ny-xnewinventory?condition=all&inventory_list_id=0&sort_column=year&sort_direction=desc"
];

function getListUrls(): string[] {
  const env = (process.env.INVENTORY_LIST_URLS ?? "").trim();
  if (!env) return DEFAULT_LIST_URLS;
  return env.split(",").map(s => s.trim()).filter(Boolean);
}

const INVENTORY_LINK_RE =
  /https?:\/\/americanharley-davidson\.com\/inventory\/\d+\/[^\s"'<>]+/ig;
const INVENTORY_REL_LINK_RE =
  /\/inventory\/\d+\/[^\s"'<>]+/ig;

function extractFirstInventoryUrl(html: string): string | null {
  const abs = html.match(INVENTORY_LINK_RE);
  if (abs?.[0]) return abs[0];

  const rel = html.match(INVENTORY_REL_LINK_RE);
  if (rel?.[0]) return `${DOMAIN}${rel[0]}`;

  return null;
}

function extractInventoryUrlContainingStock(html: string, stockLower: string): string | null {
  const re = new RegExp(
    `https?:\\/\\/americanharley-davidson\\.com\\/inventory\\/\\d+\\/[^"\\s<>]*${stockLower}[^"\\s<>]*`,
    "i"
  );
  const m = html.match(re);
  if (m?.[0]) return m[0];

  const reRel = new RegExp(
    `\\/inventory\\/\\d+\\/[^"\\s<>]*${stockLower}[^"\\s<>]*`,
    "i"
  );
  const mRel = html.match(reRel);
  if (mRel?.[0]) return `${DOMAIN}${mRel[0]}`;

  return null;
}

function findNearestInventoryUrl(html: string, stock: string): string | null {
  const lower = html.toLowerCase();
  const stockLower = stock.toLowerCase();

  let idx = lower.indexOf(stockLower);
  while (idx !== -1) {
    const start = Math.max(0, idx - 4000);
    const end = Math.min(html.length, idx + 4000);
    const window = html.slice(start, end);

    const stockUrl = extractInventoryUrlContainingStock(window, stockLower);
    if (stockUrl) return stockUrl;

    const any = extractFirstInventoryUrl(window);
    if (any) return any;

    idx = lower.indexOf(stockLower, idx + stockLower.length);
  }

  return null;
}

export async function resolveInventoryUrlByStock(stockId: string): Promise<ResolveResult> {
  const stock = stockId.trim();
  if (!stock) return { ok: false, reason: "not_found" };

  const cached = cache.get(stock);
  if (cached && cached.expiresAt > Date.now()) return cached.result;

  const stockLower = stock.toLowerCase();
  const listUrls = getListUrls();

  for (const base of listUrls) {
    try {
      const u = new URL(base);
      u.searchParams.set("search_text", stock);
      u.searchParams.set("page", "1");
      const searchUrl = u.toString();

      const html = await fetchHtmlSmart(searchUrl, "Inventory URL Resolve");
      if (!html) continue;

      const stockUrl = extractInventoryUrlContainingStock(html, stockLower);
      if (stockUrl) {
        const result: ResolveResult = { ok: true, url: stockUrl, sourceListUrl: searchUrl };
        cache.set(stock, { result, expiresAt: Date.now() + TTL_MS });
        return result;
      }

      const near = findNearestInventoryUrl(html, stock);
      if (near) {
        const result: ResolveResult = { ok: true, url: near, sourceListUrl: searchUrl };
        cache.set(stock, { result, expiresAt: Date.now() + TTL_MS });
        return result;
      }
    } catch {
    }
  }

  const result: ResolveResult = { ok: false, reason: "not_found" };
  cache.set(stock, { result, expiresAt: Date.now() + TTL_MS });
  return result;
}
