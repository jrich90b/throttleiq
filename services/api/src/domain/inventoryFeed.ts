import { XMLParser } from "fast-xml-parser";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { dataPath } from "./dataDir.js";
import { getDealerId } from "./storePersistence.js";

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
  mileage?: number | null;
  images?: string[];
};

const CACHE_TTL_MS = 10 * 60 * 1000;
const INVENTORY_FETCH_TIMEOUT_MS = Number(process.env.INVENTORY_FETCH_TIMEOUT_MS ?? 8000);
let cache: { items: InventoryFeedItem[]; loadedAt: number } | null = null;
let snapshotCache: { items: InventoryFeedItem[]; loadedAt: number } | null = null;

/**
 * Feed-URL scoping (de-hardcode A3, 2026-07-17): INVENTORY_XML_URL always wins.
 * The legacy americanharley default survives ONLY for the americanharley dealer
 * id — the live AH box runs with no INVENTORY_XML_URL set, so deleting the
 * default would kill its feed. Any other dealer id gets NO feed URL and the
 * feed loads empty. Fail direction: a misconfigured second dealer gets no
 * inventory data — never this dealer's bikes.
 */
export const LEGACY_AMERICANHARLEY_FEED_URL =
  "https://americanharley-davidson.com/inventory/xml?location=127";
const LEGACY_FEED_DEALER_ID = "americanharley";
let warnedLegacyFeedDefault = false;

export function resolveInventoryFeedUrl(): string | null {
  const url = process.env.INVENTORY_XML_URL?.trim();
  if (url) return url;
  const dealerId = getDealerId();
  if (dealerId === LEGACY_FEED_DEALER_ID) {
    if (!warnedLegacyFeedDefault) {
      warnedLegacyFeedDefault = true;
      console.warn(
        `[inventory-feed] INVENTORY_XML_URL unset — using the deprecated implicit ${LEGACY_FEED_DEALER_ID} default feed URL; set INVENTORY_XML_URL explicitly`
      );
    }
    return LEGACY_AMERICANHARLEY_FEED_URL;
  }
  console.error(
    `[inventory-feed] INVENTORY_XML_URL is not set for dealer "${dealerId}" — inventory feed disabled (no implicit default exists for non-${LEGACY_FEED_DEALER_ID} dealers)`
  );
  return null;
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

function priceForItem(item: Record<string, any> | null | undefined): number | null {
  if (!item || typeof item !== "object") return null;
  const direct = parsePrice(text((item as any).price));
  if (direct != null) return direct;
  return extractPrice(item);
}

// Odometer reading from the feed (the americanharley Room58 feed uses <miles>). A 0/blank
// reading means "not reported" (or a new unit) — return null so the reply never states "0 miles".
export function mileageForItem(item: Record<string, any> | null | undefined): number | null {
  if (!item || typeof item !== "object") return null;
  const candidates = [
    text((item as any).mileage), // already-normalized snapshot items carry `mileage`
    text((item as any).miles),
    text((item as any).odometer),
    text((item as any).odometer_reading)
  ];
  for (const raw of candidates) {
    if (!raw) continue;
    const n = Number(String(raw).replace(/[^\d.]/g, ""));
    if (Number.isFinite(n) && n > 0) return Math.round(n);
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
    mileage: mileageForItem(it),
    images: extractImageUrls(it)
  }));
}

async function loadInventorySnapshotFeedItems(): Promise<InventoryFeedItem[]> {
  const now = Date.now();
  if (snapshotCache && now - snapshotCache.loadedAt < CACHE_TTL_MS) return snapshotCache.items;
  const candidates = [
    dataPath("inventory_snapshot.json"),
    path.resolve(process.cwd(), "services/api/data/inventory_snapshot.json"),
    path.resolve(process.cwd(), "data/inventory_snapshot.json")
  ];
  for (const filePath of [...new Set(candidates)]) {
    try {
      const raw = await fs.readFile(filePath, "utf8");
      const parsed = JSON.parse(raw) as { items?: InventoryFeedItem[] };
      const items = Array.isArray(parsed?.items) ? parsed.items : [];
      snapshotCache = { items, loadedAt: now };
      return items;
    } catch (err: any) {
      if (err?.code !== "ENOENT") {
        console.warn("[inventory-feed] snapshot load failed", {
          path: filePath,
          message: err?.message ?? String(err)
        });
      }
    }
  }
  snapshotCache = { items: [], loadedAt: now };
  return [];
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

export function normalizeModel(s: string): string {
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

export function modelMatches(candidateRaw: string | undefined, targetRaw: string): boolean {
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

// Suffix tokens that denote a DISTINCT Harley model, not a trim/color of a base
// model: "Road Glide Limited"/"...ST"/CVO etc. are separate models (often ~$10k
// apart), so a base-model watch ("Road Glide") must NOT be satisfied by them.
// (The directional `candidate.includes(target)` above otherwise lets "road glide
// limited" satisfy a "road glide" watch.) Generalizes the existing CVO guard.
const DISTINCT_MODEL_TOKENS = new Set(["limited", "special", "st", "cvo", "ultra", "classic"]);

/**
 * True when the in-stock UNIT carries a distinct-model token the WATCH does not —
 * i.e. the unit is a separate sibling model, not a trim/color of the watched base.
 * Token-level (not substring) so "street" never trips "st". Used by the watch
 * matchers to block a base-model watch from firing on a distinct sibling unless
 * the watch is explicitly `openToOtherTrims`. Production case (Joe 2026-06-30):
 * Joseph Mackmin's "Road Glide" watch fired a "Road Glide Limited" alert.
 */
export function unitIsDistinctModelFromWatch(unitModelRaw: string | undefined, watchModelRaw: string | undefined): boolean {
  if (!unitModelRaw || !watchModelRaw) return false;
  const unitTokens = normalizeModel(unitModelRaw).split(" ").filter(t => DISTINCT_MODEL_TOKENS.has(t));
  if (!unitTokens.length) return false;
  const watchTokens = new Set(normalizeModel(watchModelRaw).split(" ").filter(t => DISTINCT_MODEL_TOKENS.has(t)));
  return unitTokens.some(t => !watchTokens.has(t));
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
  const url = resolveInventoryFeedUrl();
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
    return staleItems.length ? staleItems : await loadInventorySnapshotFeedItems();
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
  const findMatch = (haystack: InventoryFeedItem[]) => {
    if (!haystack.length) return null;
    const stock = opts.stockId?.trim().toLowerCase();
    const vin = opts.vin?.trim().toLowerCase();
    if (stock) {
      const item = haystack.find(i => i.stockId?.toLowerCase() === stock);
      if (item) return { price: priceForItem(item as any), item };
    }
    if (vin) {
      const item = haystack.find(i => i.vin?.toLowerCase() === vin);
      if (item) return { price: priceForItem(item as any), item };
    }
    const year = opts.year?.trim();
    const model = opts.model?.trim() ?? null;
    if (year && model) {
      const item = haystack.find(i => i.year === year && modelMatches(i.model, model));
      if (item) return { price: priceForItem(item as any), item };
    }
    return null;
  };
  const liveMatch = findMatch(items);
  if (liveMatch) return liveMatch;
  const snapshotMatch = findMatch(await loadInventorySnapshotFeedItems());
  if (snapshotMatch) return snapshotMatch;
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
    i => i.year === year && modelMatches(i.model, model) && (priceForItem(i as any) ?? 0) > 0
  );
  const prices = matches
    .map(m => priceForItem(m as any))
    .filter((price): price is number => typeof price === "number" && Number.isFinite(price) && price > 0)
    .sort((a, b) => a - b);
  if (!prices.length) return null;
  return { min: prices[0], max: prices[prices.length - 1], count: prices.length };
}
