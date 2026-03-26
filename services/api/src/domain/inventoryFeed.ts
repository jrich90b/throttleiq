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
    price: parsePrice(text(it?.price)),
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
  return s.toLowerCase().replace(/\s+/g, " ").trim();
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
  const target = normalizeModel(model);
  return items.filter(i => {
    if (!i.model) return false;
    if (year && i.year !== year) return false;
    return normalizeModel(i.model) === target;
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
  const target = normalizeModel(model);
  const yearNum = opts.year ? Number(opts.year) : null;
  const delta = typeof opts.yearDelta === "number" ? opts.yearDelta : 1;
  return items.some(i => {
    if (!i.model) return false;
    if (normalizeModel(i.model) !== target) return false;
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
  const r = await fetch(url, {
    headers: {
      "User-Agent": "ThrottleIQ/1.0 (inventory-feed)",
      Accept: "application/xml,text/xml,*/*"
    }
  });
  if (!r.ok) return [];
  const xml = await r.text();
  const items = parseFeed(xml);
  cache = { items, loadedAt: now };
  return items;
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
  const model = opts.model?.trim().toLowerCase();
  if (year && model) {
    const item = items.find(i => i.year === year && i.model?.toLowerCase() === model);
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
  const model = opts.model?.trim().toLowerCase();
  if (!year || !model) return null;
  const matches = items.filter(
    i => i.year === year && i.model?.toLowerCase() === model && i.price && i.price > 0
  );
  if (!matches.length) return null;
  const prices = matches.map(m => m.price as number).sort((a, b) => a - b);
  return { min: prices[0], max: prices[prices.length - 1], count: prices.length };
}
