import { XMLParser } from "fast-xml-parser";

export type InventoryFeedItem = {
  stockId?: string;
  vin?: string;
  year?: string;
  make?: string;
  model?: string;
  color?: string;
  condition?: string;
  url?: string;
  price?: number | null;
  images?: string[];
};

const CACHE_TTL_MS = 10 * 60 * 1000;
const INVENTORY_FETCH_TIMEOUT_MS = Number(process.env.INVENTORY_FETCH_TIMEOUT_MS ?? 8000);
let cache: { items: InventoryFeedItem[]; loadedAt: number } | null = null;

function getFeedUrl(): string | null {
  const url = process.env.INVENTORY_XML_URL?.trim();
  if (url) return url;
  return "https://americanharley-davidson.com/inventory/xml?location=127";
}

function text(v: any): string | undefined {
  if (v == null) return undefined;
  if (typeof v === "string") return v.trim();
  if (typeof v === "number") return String(v);
  if (typeof v === "object" && typeof v["#text"] === "string") return v["#text"].trim();
  return undefined;
}

function asArray<T>(v: T | T[] | undefined): T[] {
  if (!v) return [];
  return Array.isArray(v) ? v : [v];
}

function parsePrice(raw?: string): number | null {
  if (!raw) return null;
  const n = Number(String(raw).replace(/[^\d.]/g, ""));
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

function extractPrice(item: Record<string, any>): number | null {
  const candidates = [
    text(item?.price),
    text(item?.list),
    text(item?.listprice),
    text(item?.list_price),
    text(item?.msrp),
    text(item?.msrpprice),
    text(item?.saleprice),
    text(item?.sale_price),
    text(item?.internetprice),
    text(item?.internet_price),
    text(item?.specialprice),
    text(item?.special_price),
    text(item?.ourprice),
    text(item?.askingprice)
  ];
  for (const raw of candidates) {
    const parsed = parsePrice(raw);
    if (parsed != null) return parsed;
  }
  return null;
}

function parseFeed(xml: string): InventoryFeedItem[] {
  const parser = new XMLParser({ ignoreAttributes: false });
  const doc = parser.parse(xml);
  const items = asArray(doc?.inventory?.item ?? doc?.items?.item ?? doc?.item ?? []);
  return items.map((it: any) => ({
    stockId: text(it?.stocknumber),
    vin: text(it?.vin),
    year: text(it?.year),
    make: text(it?.make),
    model: text(it?.model),
    color: extractColor(it),
    condition: text(it?.condition),
    url: text(it?.url),
    price: extractPrice(it),
    images: extractImageUrls(it)
  }));
}

function extractImageUrls(item: Record<string, any>): string[] {
  const urls: string[] = [];
  for (const [key, val] of Object.entries(item ?? {})) {
    if (!/^image\d+$/i.test(key)) continue;
    const url = text(val);
    if (url && /^https?:\/\//i.test(url)) urls.push(url);
  }
  return urls;
}

function extractColor(item: Record<string, any>): string | undefined {
  const keys = [
    "color",
    "colorname",
    "color_name",
    "exteriorcolor",
    "exterior_color",
    "extcolor",
    "ext_color",
    "primarycolor",
    "primary_color",
    "paint"
  ];
  for (const key of keys) {
    const val = text(item?.[key]);
    if (val) return val;
  }
  return undefined;
}

function normalizeModel(s: string): string {
  const raw = s
    .toLowerCase()
    // common model-word cleanup for user-entered text
    .replace(/\bstreet\s+glides\b/g, "street glide")
    .replace(/\broad\s+glides\b/g, "road glide")
    .replace(/\btri\s+glides\b/g, "tri glide")
    .replace(/\blimieteds?\b/g, "limited")
    .replace(/\blimteds?\b/g, "limited")
    .replace(/\blimiteds\b/g, "limited")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return raw;
}

function modelMatches(candidateRaw: string | undefined, targetRaw: string): boolean {
  if (!candidateRaw) return false;
  const candidate = normalizeModel(candidateRaw);
  const target = normalizeModel(targetRaw);
  if (!candidate || !target) return false;
  const hasWord = (text: string, word: string) => text.split(" ").includes(word);
  // Guard against over-broad fallback matching:
  // if customer explicitly asked for a CVO model, do not match non-CVO variants.
  if (hasWord(target, "cvo") && !hasWord(candidate, "cvo")) return false;
  if (candidate === target) return true;
  // Keep matching directional so trim-specific asks do not collapse to base families:
  // target="street glide limited" should NOT match candidate="street glide".
  return candidate.includes(target);
}

export function extractImageDate(url: string): Date | null {
  const m = url.match(/\/(\d{4})\/(\d{2})\/(\d{2})\//);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return null;
  return new Date(Date.UTC(year, month - 1, day));
}

export async function findInventoryMatches(opts: {
  year?: string | null;
  model?: string | null;
}): Promise<InventoryFeedItem[]> {
  const items = await getInventoryFeed();
  if (!items.length) return [];
  const year = opts.year?.trim();
  const model = opts.model?.trim();
  if (!model) return [];
  return items.filter(i => {
    if (year && i.year !== year) return false;
    return modelMatches(i.model, model);
  });
}

export async function hasInventoryForModelYear(opts: {
  model?: string | null;
  year?: string | null;
  yearDelta?: number;
}): Promise<boolean> {
  const items = await getInventoryFeed();
  if (!items.length) return false;
  const model = opts.model?.trim();
  if (!model) return false;
  const yearNum = opts.year ? Number(opts.year) : null;
  const delta = typeof opts.yearDelta === "number" ? opts.yearDelta : 1;
  return items.some(i => {
    if (!i.model) return false;
    if (!modelMatches(i.model, model)) return false;
    if (!yearNum || !Number.isFinite(yearNum)) return true;
    const itemYear = Number(i.year);
    if (!Number.isFinite(itemYear)) return true;
    return Math.abs(itemYear - yearNum) <= delta;
  });
}

export async function getInventoryFeed(opts?: { bypassCache?: boolean }): Promise<InventoryFeedItem[]> {
  const now = Date.now();
  if (!opts?.bypassCache && cache && now - cache.loadedAt < CACHE_TTL_MS) return cache.items;
  const url = getFeedUrl();
  if (!url) return [];
  const staleItems = cache?.items ?? [];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1000, INVENTORY_FETCH_TIMEOUT_MS));
  try {
    const r = await fetch(url, {
      headers: {
        "User-Agent": "ThrottleIQ/1.0 (inventory-feed)",
        Accept: "application/xml,text/xml,*/*"
      },
      signal: controller.signal
    });
    if (!r.ok) {
      console.warn("[inventory-feed] fetch failed", { status: r.status, url });
      return staleItems;
    }
    const xml = await r.text();
    const items = parseFeed(xml);
    cache = { items, loadedAt: now };
    return items;
  } catch (err: any) {
    const reason = err?.name === "AbortError" ? "timeout" : "fetch_error";
    console.warn("[inventory-feed] fetch error", {
      reason,
      message: err?.message ?? String(err),
      timeoutMs: INVENTORY_FETCH_TIMEOUT_MS,
      url
    });
    return staleItems;
  } finally {
    clearTimeout(timer);
  }
}

export async function findInventoryPrice(opts: {
  stockId?: string | null;
  vin?: string | null;
  year?: string | null;
  model?: string | null;
}): Promise<{ price?: number | null; item?: InventoryFeedItem } | null> {
  const items = await getInventoryFeed();
  if (!items.length) return null;
  const stock = opts.stockId?.trim().toLowerCase();
  const vin = opts.vin?.trim().toLowerCase();
  if (stock) {
    const item = items.find(i => i.stockId?.toLowerCase() === stock);
    if (item) return { price: item.price ?? null, item };
  }
  if (vin) {
    const item = items.find(i => i.vin?.toLowerCase() === vin);
    if (item) return { price: item.price ?? null, item };
  }
  const year = opts.year?.trim();
  const model = opts.model?.trim() ?? null;
  if (year && model) {
    const item = items.find(i => i.year === year && modelMatches(i.model, model));
    if (item) return { price: item.price ?? null, item };
  }
  return null;
}

export async function findPriceRange(opts: {
  year?: string | null;
  model?: string | null;
}): Promise<{ min: number; max: number; count: number } | null> {
  const items = await getInventoryFeed();
  if (!items.length) return null;
  const year = opts.year?.trim();
  const model = opts.model?.trim() ?? null;
  if (!year || !model) return null;
  const matches = items.filter(
    i => i.year === year && modelMatches(i.model, model) && i.price && i.price > 0
  );
  if (!matches.length) return null;
  const prices = matches.map(m => m.price as number).sort((a, b) => a - b);
  return { min: prices[0], max: prices[prices.length - 1], count: prices.length };
}
