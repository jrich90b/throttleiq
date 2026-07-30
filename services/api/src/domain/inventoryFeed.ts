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
  // Same order as before ("price" first), now also reachable as an attribute or a
  // name/value entry via field().
  const PRICE_KEYS = [
    "price",
    "list",
    "listprice",
    "list_price",
    "msrp",
    "msrpprice",
    "saleprice",
    "sale_price",
    "internetprice",
    "internet_price",
    "specialprice",
    "special_price",
    "ourprice",
    "askingprice"
  ];
  for (const key of PRICE_KEYS) {
    const parsed = parsePrice(field(item, key));
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
    // `mileage` first: already-normalized snapshot items carry it.
    field(item as any, "mileage"),
    field(item as any, "miles"),
    field(item as any, "odometer"),
    field(item as any, "odometer_reading")
  ];
  for (const raw of candidates) {
    if (!raw) continue;
    const n = Number(String(raw).replace(/[^\d.]/g, ""));
    if (Number.isFinite(n) && n > 0) return Math.round(n);
  }
  return null;
}

/**
 * Vendor-feed field tolerance (dealer-portability, 2026-07-30). The intake-shape harness
 * measured this surface at 3 of 7 real-world feed shapes: only colour, price and mileage
 * tried alternative spellings, so `<stock_number>` lost the stock number outright and
 * attribute-style rows, generic name/value rows, and `<vehicles><vehicle>` containers each
 * lost EVERYTHING. That failure is silent — no inventory just means the agent never
 * mentions a bike, with no error for a health check to catch.
 *
 * SAFETY PROPERTY, load-bearing: the CANONICAL name for each field is listed FIRST and is
 * resolved as a child element before any alias, attribute, or name/value entry is even
 * considered, so an existing dealer's feed parses exactly as it did. Two separate pieces of
 * evidence, because one alone would be weak: `inventory_feed_shape:eval` pins the PRECEDENCE
 * RULE on fixtures (a canonical child element beats an alias and beats an attribute), and at
 * build time the live 72-row americanharley feed was parsed before and after this change and
 * the output was byte-for-byte identical (recorded in the PR — the feed itself is dealer data
 * and deliberately not committed as a fixture).
 *
 * DELIBERATE EXCLUSIONS, each one a way this could go wrong:
 *   - `id` is NOT a stock-number alias. The live americanharley feed carries `<id>` as the
 *     vendor's own row id; treating it as a stock number would invent stock numbers for the
 *     13 rows that legitimately have none, and a reply citing a meaningless number is worse
 *     than one citing none.
 *   - `title`, `description` and `category` are NOT model aliases. They hold prose; a long
 *     string landing in `model` would corrupt watch matching (see modelMatches below).
 *   - `type`, `status` and `certified` are NOT condition aliases. A feed with
 *     `<type>Motorcycle</type>` would set condition to "Motorcycle" instead of new/used, and
 *     a WRONG value is worse than a missing one.
 */
export const FEED_FIELD_ALIASES = {
  stockId: [
    "stocknumber",
    "stock_number",
    "stocknum",
    "stockno",
    "stockid",
    "stock_id",
    "stock",
    "dealerstocknumber"
  ],
  vin: ["vin", "vinnumber", "vin_number", "serialnumber", "serial_number"],
  year: ["year", "modelyear", "model_year", "yearmodel"],
  make: ["make", "manufacturer", "brand", "makename", "make_name"],
  model: ["model", "modelname", "model_name"],
  condition: ["condition", "newused", "new_used", "neworused"],
  url: ["url", "link", "detailurl", "detail_url", "vdpurl", "vdp_url", "permalink", "weburl", "web_url"]
} as const;

/**
 * Read one logical field from a feed row, tolerating the three ways vendors express it:
 *   1. a child element        <year>2026</year>
 *   2. an XML attribute       <item year="2026">   (fast-xml-parser exposes this as "@_year")
 *   3. a name/value entry     <attribute name="year">2026</attribute>
 * Every listed name is tried as a child element before any attribute is considered, so
 * precedence never changes for a feed that already worked.
 */
export function field(item: Record<string, any> | null | undefined, ...names: string[]): string | undefined {
  if (!item || typeof item !== "object") return undefined;
  for (const name of names) {
    const direct = text(item[name]);
    if (direct) return direct;
  }
  for (const name of names) {
    const asAttribute = text(item[`@_${name}`]);
    if (asAttribute) return asAttribute;
  }
  const pairs = [...asArray(item.attribute), ...asArray(item.attributes?.attribute)];
  if (!pairs.length) return undefined;
  for (const name of names) {
    for (const pair of pairs) {
      const key = String(text(pair?.["@_name"]) ?? text(pair?.name) ?? "").toLowerCase();
      if (key !== name.toLowerCase()) continue;
      const value = text(pair?.["#text"]) ?? text(pair?.value) ?? text(pair);
      if (value) return value;
    }
  }
  return undefined;
}

/**
 * The row list, whatever the vendor calls it. The three original shapes stay first so an
 * existing feed resolves exactly as before; a feed calling its rows `vehicle`, `unit` or
 * `listing` used to yield ZERO rows and read as an empty store.
 */
export function pickFeedRows(doc: any): any {
  return (
    doc?.inventory?.item ??
    doc?.items?.item ??
    doc?.item ??
    doc?.inventory?.vehicle ??
    doc?.vehicles?.vehicle ??
    doc?.vehicle ??
    doc?.inventory?.unit ??
    doc?.units?.unit ??
    doc?.unit ??
    doc?.listings?.listing ??
    doc?.listing ??
    []
  );
}

/**
 * Exported ONLY so the intake-shape harness (scripts/dealer_intake_shape_test.ts) can
 * drive the real parser with synthetic vendor feeds instead of a copy that would drift
 * out of sync with this one. Behavior unchanged; no caller inside services/api uses the
 * export.
 */
export function parseFeed(xml: string): InventoryFeedItem[] {
  const parser = new XMLParser({ ignoreAttributes: false });
  const doc = parser.parse(xml);
  const items = asArray(pickFeedRows(doc));
  return items.map((it: any) => ({
    stockId: field(it, ...FEED_FIELD_ALIASES.stockId),
    vin: field(it, ...FEED_FIELD_ALIASES.vin),
    year: field(it, ...FEED_FIELD_ALIASES.year),
    make: field(it, ...FEED_FIELD_ALIASES.make),
    model: field(it, ...FEED_FIELD_ALIASES.model),
    color: extractColor(it),
    condition: field(it, ...FEED_FIELD_ALIASES.condition),
    url: field(it, ...FEED_FIELD_ALIASES.url),
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
  // "colour" variants included for non-US feeds; "color" stays first so precedence is
  // unchanged for feeds that already worked.
  return field(
    item,
    "color",
    "colorname",
    "color_name",
    "colour",
    "colourname",
    "colour_name",
    "exteriorcolor",
    "exterior_color",
    "exteriorcolour",
    "extcolor",
    "ext_color",
    "primarycolor",
    "primary_color",
    "paint"
  );
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

/**
 * The specific-model name within the Sportster 883 line, or null for a bare/generic "883".
 * Iron 883, 883 Roadster, Sportster 883 Low, SuperLow, 883 Custom and 883 Hugger are DISTINCT
 * MODELS, not trims of a shared "883" — a customer who says "Iron 883" does not mean "any 883".
 * A bare "883" / "XL 883" / "Sportster 883" carries no sub-model token → generic (what someone
 * means when they just say "an 883"). Runs on `normalizeModel` output (lowercased, punctuation
 * collapsed), so "SuperLow" -> "superlow" and "Super Low" -> "super low" both resolve.
 */
const SPECIFIC_883_MODEL_MATCHERS: ReadonlyArray<readonly [string, RegExp]> = [
  ["iron", /\biron\b/],
  ["roadster", /\broadster\b/],
  ["superlow", /\bsuper\s*low\b|\bsuperlow\b/],
  ["low", /\blow\b/],
  ["custom", /\bcustom\b/],
  ["hugger", /\bhugger\b/]
];
export function specific883ModelToken(modelRaw: string | undefined | null): string | null {
  const t = normalizeModel(String(modelRaw ?? ""));
  if (!/\b883\b/.test(t)) return null;
  for (const [token, re] of SPECIFIC_883_MODEL_MATCHERS) {
    if (re.test(t)) return token;
  }
  return null;
}

/**
 * True when the WATCH names a specific 883 model and the in-stock UNIT is a DIFFERENT 883 model
 * (a different sub-model, or a bare "883") — so an "Iron 883" watch must NOT fire on a "Sportster
 * 883 Low". The `is883ModelToken` family umbrella in the matchers otherwise treats every 883 as one
 * model, and the trim-token distinct guard above doesn't know the Sportster sub-model words — so one
 * 2006 Sportster 883 Low notified EVERY Iron 883 watcher (+15164197791, +12399612259, +18728882220).
 *
 * Purely SUBTRACTIVE (only ever blocks a fire). Fail direction is safe: the worst case is a missed
 * fire the watch_fire_miss detector re-surfaces (and the same-family sibling-scope ask can still offer
 * the 883 Low as a variant) — never a false "your bike came in" for the wrong model. A generic 883
 * watch (no sub-model token) is unaffected: it stays open to any 883.
 */
export function distinct883ModelConflict(unitModelRaw: string | undefined, watchModelRaw: string | undefined): boolean {
  const watchToken = specific883ModelToken(watchModelRaw);
  if (!watchToken) return false; // generic/non-specific 883 (or non-883) watch → umbrella is fine
  return specific883ModelToken(unitModelRaw) !== watchToken;
}

/**
 * The MODERN, liquid-cooled Sportster models — Sportster S (RH1250S) and Nightster (RH975) — as a
 * distinct token, else null. These are specific models, NOT the air-cooled Sportster line, but
 * detectGenericWatchFamilyLabel maps "Sportster S" to the generic "sportster" family (the bare
 * "sportster" token wins), so a "Sportster S" watch umbrella-matched a 2006 Sportster 883 Low
 * (+17705967891). Anchored patterns (require the "sportster s" sequence or an rh12xx/rh9xx code) so a
 * non-Sportster "…S" model — "Low Rider S", "CVO Road Glide ST" — never trips this.
 */
const MODERN_SPORTSTER_MODEL_MATCHERS: ReadonlyArray<readonly [string, RegExp]> = [
  ["sportster_s", /\bsportster\s+s\b|\brh1250/],
  ["nightster", /\bnightster\b|\brh975/]
];
export function modernSportsterModelToken(modelRaw: string | undefined | null): string | null {
  const t = normalizeModel(String(modelRaw ?? ""));
  for (const [token, re] of MODERN_SPORTSTER_MODEL_MATCHERS) {
    if (re.test(t)) return token;
  }
  return null;
}

/**
 * True when the WATCH names a modern Sportster model (Sportster S / Nightster) and the in-stock UNIT
 * is NOT that same model — so a "Sportster S" watch must not fire on a "Sportster 883 Low" (or any
 * other Sportster). Companion to distinct883ModelConflict, covering the modern liquid-cooled models
 * the 883 guard doesn't. Purely SUBTRACTIVE, same fail-safe as the 883 guard (worst case a missed
 * fire the detector re-surfaces, never a false wrong-model alert). A generic "Sportster" watch (no
 * modern-model token) is unaffected.
 */
export function distinctSportsterModelConflict(unitModelRaw: string | undefined, watchModelRaw: string | undefined): boolean {
  const watchToken = modernSportsterModelToken(watchModelRaw);
  if (!watchToken) return false; // watch isn't a modern specific Sportster → nothing to constrain here
  return modernSportsterModelToken(unitModelRaw) !== watchToken;
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
