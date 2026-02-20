import { fetchHtmlSmart } from "./zenrowsFetch.js";

export type InventoryStatus = "AVAILABLE" | "PENDING" | "UNKNOWN";

type CacheEntry = { status: InventoryStatus; expiresAt: number };
const cache = new Map<string, CacheEntry>();
const TTL_MS = 2 * 60 * 1000;

const SALE_PENDING_RE =
  /<span[^>]*class=["']imgPreview-tag["'][^>]*>\s*Sale\s*pending\s*<\/span>/i;

export async function checkInventorySalePendingByUrl(url: string): Promise<InventoryStatus> {
  const key = url.trim();

  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.status;

  const html = await fetchHtmlSmart(key, "Inventory Check");
  if (!html) {
    const status: InventoryStatus = "UNKNOWN";
    cache.set(key, { status, expiresAt: Date.now() + TTL_MS });
    return status;
  }

  const status: InventoryStatus = SALE_PENDING_RE.test(html) ? "PENDING" : "AVAILABLE";
  cache.set(key, { status, expiresAt: Date.now() + TTL_MS });
  return status;
}
