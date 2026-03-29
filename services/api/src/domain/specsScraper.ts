import { fetchHtmlSmart } from "./zenrowsFetch.js";
import { getInventoryFeed, InventoryFeedItem } from "./inventoryFeed.js";
import { dataPath } from "./dataDir.js";
import fs from "node:fs";

export type ModelSpecs = {
  model: string;
  year?: string | null;
  specs: Record<string, string>;
  glance?: string | null;
  sourceUrl?: string | null;
  updatedAt: string;
};

type SpecsCache = Record<string, ModelSpecs>;

const CACHE_FILE = "specs_cache.json";
const HARLEY_URLS_FILE = "harley_model_urls.json";
const DEFAULT_HARLEY_URLS: Record<string, string> = {
  "street bob": "https://www.harley-davidson.com/us/en/motorcycles/street-bob.html?color=m44",
  "road glide": "https://www.harley-davidson.com/us/en/motorcycles/road-glide.html"
};
const HARLEY_SPECS_ONLY = (process.env.HARLEY_SPECS_ONLY ?? "true").toLowerCase() === "true";
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MIN_SPECS_COUNT = 1;

function cleanModelForHarleyUrl(model: string): string {
  return model
    .replace(/harley-davidson/gi, " ")
    .replace(/\([^)]*\)/g, " ")
    .replace(/\s*[•\u2022]\s*.*$/g, " ")
    .replace(/\s+[-–—]\s+.*$/g, " ")
    .replace(/\s+\/\s+.*$/g, " ")
    .replace(/\s+in\s+[^,]+$/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function cacheKey(model: string, year?: string | null): string {
  return `${String(year ?? "").trim()}|${cleanModelForHarleyUrl(model).toLowerCase()}`;
}

function loadCache(): SpecsCache {
  try {
    const p = dataPath(CACHE_FILE);
    if (!fs.existsSync(p)) return {};
    const raw = fs.readFileSync(p, "utf8");
    return JSON.parse(raw || "{}");
  } catch {
    return {};
  }
}

function saveCache(cache: SpecsCache) {
  try {
    const p = dataPath(CACHE_FILE);
    fs.writeFileSync(p, JSON.stringify(cache, null, 2));
  } catch {
    // ignore
  }
}

function loadHarleyUrlMap(): Record<string, string> {
  const normalized: Record<string, string> = {};
  const normalizeKey = (k: string) => k.toLowerCase().replace(/\s+/g, " ").trim();
  for (const [k, v] of Object.entries(DEFAULT_HARLEY_URLS)) {
    if (k && v) normalized[normalizeKey(k)] = v;
  }
  try {
    const p = dataPath(HARLEY_URLS_FILE);
    if (!fs.existsSync(p)) {
      fs.writeFileSync(p, JSON.stringify(normalized, null, 2));
      return normalized;
    }
    const raw = fs.readFileSync(p, "utf8");
    const parsed = JSON.parse(raw || "{}");
    if (parsed && typeof parsed === "object") {
      for (const [k, v] of Object.entries(parsed)) {
        if (!k || typeof v !== "string") continue;
        normalized[normalizeKey(k)] = v;
      }
    }
  } catch {
    return normalized;
  }
  return normalized;
}

function slugifyModel(model: string): string {
  return model
    .toLowerCase()
    .replace(/harley-davidson/gi, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function resolveHarleyUrl(model: string, year?: string | null): string | null {
  const cleaned = cleanModelForHarleyUrl(model);
  const map = loadHarleyUrlMap();
  const key = cleaned.toLowerCase().replace(/\s+/g, " ").trim();
  if (map[key]) return map[key];
  const slug = slugifyModel(cleaned);
  if (!slug) return null;
  if (year && /^\d{4}$/.test(String(year))) {
    return `https://www.harley-davidson.com/us/en/motorcycles/${year}/${slug}.html`;
  }
  return `https://www.harley-davidson.com/us/en/motorcycles/${slug}.html`;
}

type SpecsBundle = { specs: Record<string, string>; glance?: string | null };

async function fetchSpecsForUrl(url: string | null): Promise<SpecsBundle> {
  if (!url) return { specs: {} };
  const urlWithAnchor = url.includes("#specs") ? url : `${url}#specs`;
  const html = await fetchHtmlSmart(urlWithAnchor, "specs-scraper");
  if (!html) return { specs: {} };
  const parsed = parseSpecsFromHtml(html);
  const glance = extractAtAGlance(html);
  return { specs: filterSpecMap(parsed), glance };
}

function stripTags(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
}

function extractFromTable(html: string): Record<string, string> {
  const specs: Record<string, string> = {};
  const rows = html.match(/<tr[\s\S]*?<\/tr>/gi) ?? [];
  for (const row of rows) {
    const cells = row.match(/<t[hd][\s\S]*?<\/t[hd]>/gi) ?? [];
    if (cells.length < 2) continue;
    const firstCell = cells[0] ?? "";
    const secondCell = cells[1] ?? "";
    if (!firstCell || !secondCell) continue;
    const keyRaw = decodeHtmlEntities(stripTags(firstCell));
    const valRaw = decodeHtmlEntities(stripTags(secondCell));
    if (!keyRaw || !valRaw) continue;
    specs[keyRaw] = valRaw;
  }
  return specs;
}

function extractFromDl(html: string): Record<string, string> {
  const specs: Record<string, string> = {};
  const dts = html.match(/<dt[\s\S]*?<\/dt>/gi) ?? [];
  const dds = html.match(/<dd[\s\S]*?<\/dd>/gi) ?? [];
  const count = Math.min(dts.length, dds.length);
  for (let i = 0; i < count; i += 1) {
    const keyRaw = decodeHtmlEntities(stripTags(dts[i]));
    const valRaw = decodeHtmlEntities(stripTags(dds[i]));
    if (!keyRaw || !valRaw) continue;
    specs[keyRaw] = valRaw;
  }
  return specs;
}

function extractFromJsonLd(html: string): Record<string, string> {
  const specs: Record<string, string> = {};
  const scripts = [...html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)];
  for (const match of scripts) {
    const raw = match[1];
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw.trim());
      const nodes = Array.isArray(parsed) ? parsed : [parsed];
      for (const node of nodes) {
        const props = node?.additionalProperty;
        if (!Array.isArray(props)) continue;
        for (const prop of props) {
          const name = prop?.name;
          const value = prop?.value;
          if (typeof name === "string" && typeof value === "string") {
            specs[name] = value;
          }
        }
      }
    } catch {
      // ignore invalid json-ld
    }
  }
  return specs;
}

function collectSpecsFromJsonNode(node: any, out: Record<string, string>, depth = 0) {
  if (!node || depth > 16) return;
  if (Array.isArray(node)) {
    for (const item of node) collectSpecsFromJsonNode(item, out, depth + 1);
    return;
  }
  if (typeof node !== "object") return;
  const coerceValue = (val: any, depthVal = 0): string | null => {
    if (depthVal > 6) return null;
    if (typeof val === "string" || typeof val === "number" || typeof val === "boolean") return String(val);
    if (Array.isArray(val)) {
      const parts = val
        .map(v => coerceValue(v, depthVal + 1))
        .filter(Boolean)
        .map(v => String(v));
      return parts.length ? parts.join(", ") : null;
    }
    if (val && typeof val === "object") {
      const direct = val.value ?? val.displayValue ?? val.text ?? val.label ?? val.name ?? null;
      const derived = coerceValue(direct, depthVal + 1);
      if (derived) return derived;
      for (const v of Object.values(val)) {
        const candidate = coerceValue(v, depthVal + 1);
        if (candidate) return candidate;
      }
    }
    return null;
  };
  const specContainers = [
    node.specs,
    node.specifications,
    node.items,
    node.values,
    node.attributes,
    node.specEntriesCollection,
    node.specEntries
  ].filter(Boolean);
  for (const container of specContainers) {
    const specsNode = container as any;
    if (Array.isArray(specsNode)) {
      for (const item of specsNode) collectSpecsFromJsonNode(item, out, depth + 1);
    } else if (typeof specsNode === "object") {
      for (const [k, v] of Object.entries(specsNode)) {
        if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
          out[k] = String(v);
        } else {
          collectSpecsFromJsonNode(v, out, depth + 1);
        }
      }
    }
  }
  const label =
    typeof node.label === "string"
      ? node.label
      : typeof node.name === "string"
        ? node.name
        : typeof node.title === "string"
          ? node.title
          : typeof node.specName === "string"
            ? node.specName
            : typeof node.spec === "string"
              ? node.spec
              : typeof node.key === "string"
                ? node.key
                : typeof node.specKey === "string"
                  ? node.specKey
                  : null;
  const valueCandidate =
    node.value ??
    node.text ??
    node.displayValue ??
    node.specValue ??
    node.detail ??
    node.values ??
    node.measurement ??
    null;
  let value: string | null = coerceValue(valueCandidate);
  if (label && value) {
    out[label] = value;
  } else if (label && valueCandidate && typeof valueCandidate === "object") {
    const derived = coerceValue(valueCandidate);
    if (derived) out[label] = derived;
  }
  for (const val of Object.values(node)) {
    collectSpecsFromJsonNode(val, out, depth + 1);
  }
}

function extractFromJsonScripts(html: string): Record<string, string> {
  const specs: Record<string, string> = {};
  const nextData = [...html.matchAll(/<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/gi)];
  const genericJson = [...html.matchAll(/<script[^>]*type="application\/json"[^>]*>([\s\S]*?)<\/script>/gi)];
  const candidates = [...nextData, ...genericJson];
  for (const match of candidates) {
    const raw = match[1];
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw.trim());
      collectSpecsFromJsonNode(parsed, specs, 0);
    } catch {
      // ignore
    }
  }
  return specs;
}

function extractFromHarleyNextData(html: string): Record<string, string> {
  const specs: Record<string, string> = {};
  const match = html.match(/<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i);
  if (!match?.[1]) return specs;
  let data: any;
  try {
    data = JSON.parse(match[1]);
  } catch {
    return specs;
  }
  const specOptions =
    data?.props?.pageProps?.initialState?.bikeProductDetails?.specOptionsCollection?.items ??
    data?.props?.pageProps?.initialState?.bikeProductDetails?.specOptionsCollection ??
    data?.props?.pageProps?.bikeProductDetails?.specOptionsCollection?.items ??
    data?.props?.pageProps?.bikeProductDetails?.specOptionsCollection ??
    null;
  let options = Array.isArray(specOptions) ? specOptions : specOptions?.items;

  const foundCollections: any[] = [];
  const findSpecOptionsCollections = (node: any, depth = 0) => {
    if (!node || typeof node !== "object" || depth > 16) return;
    if (node.specOptionsCollection) foundCollections.push(node.specOptionsCollection);
    if (Array.isArray(node)) {
      for (const item of node) findSpecOptionsCollections(item, depth + 1);
      return;
    }
    for (const val of Object.values(node)) findSpecOptionsCollections(val, depth + 1);
  };
  if (!Array.isArray(options)) {
    findSpecOptionsCollections(data, 0);
    const collected: any[] = [];
    for (const coll of foundCollections) {
      if (Array.isArray(coll)) collected.push(...coll);
      else if (Array.isArray(coll?.items)) collected.push(...coll.items);
      else if (coll?.items) collected.push(coll.items);
    }
    options = collected.filter(Boolean);
  }
  if (!Array.isArray(options)) return specs;

  const coerceValue = (val: any, depth = 0): string | null => {
    if (depth > 6) return null;
    if (typeof val === "string" || typeof val === "number" || typeof val === "boolean") return String(val);
    if (Array.isArray(val)) {
      const parts = val
        .map(v => coerceValue(v, depth + 1))
        .filter(Boolean)
        .map(v => String(v));
      return parts.length ? parts.join(", ") : null;
    }
    if (val && typeof val === "object") {
      if (val.value !== undefined || val.unit !== undefined) {
        const valuePart = coerceValue(val.value, depth + 1);
        const unitPart = coerceValue(val.unit, depth + 1);
        if (valuePart && unitPart) return `${valuePart} ${unitPart}`.trim();
        if (valuePart) return valuePart;
      }
      const direct = val.value ?? val.displayValue ?? val.text ?? val.label ?? val.name ?? null;
      const derived = coerceValue(direct, depth + 1);
      if (derived) return derived;
      for (const v of Object.values(val)) {
        const candidate = coerceValue(v, depth + 1);
        if (candidate) return candidate;
      }
    }
    return null;
  };

  const collectSpecItems = (items: any) => {
    if (!Array.isArray(items)) return;
    for (const item of items) {
      if (!item || typeof item !== "object") continue;
      const label =
        item.specName ??
        item.label ??
        item.name ??
        item.title ??
        item.specLabel ??
        item.key ??
        item.specKey ??
        null;
      const value =
        coerceValue(item.specValue ?? item.value ?? item.displayValue ?? item.text ?? item.specValues ?? item.values);
      if (label && value) {
        specs[String(label)] = value;
      }
      if (item.specEntriesCollection?.items) collectSpecItems(item.specEntriesCollection.items);
      if (item.specEntries?.items) collectSpecItems(item.specEntries.items);
      if (item.specEntries) collectSpecItems(item.specEntries);
      if (item.specItemsCollection?.items) collectSpecItems(item.specItemsCollection.items);
      if (item.specItems?.items) collectSpecItems(item.specItems.items);
      if (item.specItems) collectSpecItems(item.specItems);
      if (item.items) collectSpecItems(item.items);
    }
  };

  const collectSpecGroups = (collection: any) => {
    const items = collection?.items ?? collection;
    if (!Array.isArray(items)) return;
    for (const group of items) {
      if (!group || typeof group !== "object") continue;
      if (group.specGroupsCollection) collectSpecGroups(group.specGroupsCollection);
      collectSpecItems(group.specEntriesCollection?.items ?? group.specEntries?.items ?? group.specEntries ?? []);
      collectSpecItems(group.specItemsCollection?.items ?? group.specItems?.items ?? group.specItems ?? group.items);
    }
  };

  for (const option of options) {
    if (!option || typeof option !== "object") continue;
    collectSpecGroups(option.specGroupsCollection ?? option.specGroupCollection ?? option.specGroups);
  }

  return specs;
}

function filterSpecMap(specs: Record<string, string>): Record<string, string> {
  const filtered: Record<string, string> = {};
  const invalidKey =
    /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|hours?|open|closed|__typename)\b/i;
  const invalidValueDays = /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i;
  const invalidValueTimes = /\b\d{1,2}:\d{2}\s*(am|pm)?\b/i;
  const invalidValueStatus = /\b(open|closed)\b/i;
  const cleanValue = (val: string): string => {
    if (!val) return val;
    if (val.includes("<") && val.includes(">")) {
      return decodeHtmlEntities(stripTags(val));
    }
    return decodeHtmlEntities(val).replace(/\s+/g, " ").trim();
  };
  for (const [key, value] of Object.entries(specs)) {
    if (!key || !value) continue;
    if (invalidKey.test(key)) continue;
    const cleanedValue = cleanValue(String(value));
    if (!cleanedValue) continue;
    if (invalidValueDays.test(cleanedValue) || invalidValueTimes.test(cleanedValue) || invalidValueStatus.test(cleanedValue)) continue;
    filtered[key] = cleanedValue;
  }
  return filtered;
}

function parseSpecsFromHtml(html: string): Record<string, string> {
  const specs: Record<string, string> = {};
  if (!html) return specs;

  Object.assign(specs, extractFromJsonLd(html));
  Object.assign(specs, extractFromJsonScripts(html));
  Object.assign(specs, extractFromHarleyNextData(html));

  const specSection =
    html.match(/<h\d[^>]*>\s*(Specifications|Specs?)\s*<\/h\d>[\s\S]*?(<table[\s\S]*?<\/table>)/i)?.[2] ??
    html.match(/<h\d[^>]*>\s*(Specifications|Specs?)\s*<\/h\d>[\s\S]*?(<dl[\s\S]*?<\/dl>)/i)?.[2] ??
    html.match(/<table[^>]*class="[^"]*(spec|specs)[^"]*"[\s\S]*?<\/table>/i)?.[0] ??
    html.match(/<dl[^>]*class="[^"]*(spec|specs)[^"]*"[\s\S]*?<\/dl>/i)?.[0] ??
    "";

  if (specSection) {
    Object.assign(specs, extractFromTable(specSection));
    Object.assign(specs, extractFromDl(specSection));
  }

  return filterSpecMap(specs);
}

function extractAtAGlance(html: string): string | null {
  if (!html) return null;
  const segment =
    html.match(/At a Glance([\s\S]{0,4000}?)(Tech Specs|Technical Specifications|RIDER SAFETY ENHANCEMENTS|Explore the)/i)?.[1] ??
    null;
  if (!segment) return null;
  const plain = decodeHtmlEntities(stripTags(segment)).replace(/\s+/g, " ").trim();
  if (!plain) return null;
  const withMatch = plain.match(/With (?:a|an|the)\s+([^\.]+)\./i);
  if (withMatch?.[1]) {
    let features = withMatch[1];
    features = features.replace(/\s*guiding the way\s*/i, "");
    features = features.replace(/\s+/g, " ").trim();
    if (features) return features;
  }
  const sentences = plain.split(/[.?!]\s+/).map(s => s.trim()).filter(Boolean);
  const prefer =
    sentences.find(s => /milwaukee|ride modes|suspension|skyline|display|torque|horsepower|engine/i.test(s)) ??
    sentences[0];
  if (!prefer) return null;
  let cleaned = prefer
    .replace(/Because .*$/i, "")
    .replace(/Nowhere .*$/i, "")
    .replace(/turns .*$/i, "")
    .replace(/every road.*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return null;
  return cleaned;
}

function normalizeModel(val: string): string {
  return val.toLowerCase().replace(/\s+/g, " ").trim();
}

function selectCandidateUrls(items: InventoryFeedItem[]): string[] {
  const urls: string[] = [];
  for (const item of items) {
    if (item.url && /^https?:\/\//i.test(item.url)) urls.push(item.url);
  }
  return urls;
}

export async function getModelSpecs(opts: {
  model: string;
  year?: string | null;
}): Promise<ModelSpecs | null> {
  const model = opts.model?.trim();
  if (!model) return null;
  const year = opts.year ? String(opts.year) : null;
  const key = cacheKey(model, year);
  const cache = loadCache();
  const cached = cache[key];
  if (cached?.updatedAt) {
    const age = Date.now() - new Date(cached.updatedAt).getTime();
    if (!Number.isNaN(age) && age < CACHE_TTL_MS && cached.specs && Object.keys(cached.specs).length) {
      const cleaned = filterSpecMap(cached.specs);
      if (Object.keys(cleaned).length >= MIN_SPECS_COUNT) {
        if (Object.keys(cleaned).length !== Object.keys(cached.specs).length) {
          cache[key] = { ...cached, specs: cleaned };
          saveCache(cache);
        }
        return { ...cached, specs: cleaned };
      }
    }
  }

  const harleyUrl = resolveHarleyUrl(model, year);
  let { specs, glance } = await fetchSpecsForUrl(harleyUrl);
  let usedUrl = harleyUrl;
  if (Object.keys(specs).length < MIN_SPECS_COUNT && year) {
    const fallbackUrl = resolveHarleyUrl(model, null);
    if (fallbackUrl && fallbackUrl !== harleyUrl) {
      const fallback = await fetchSpecsForUrl(fallbackUrl);
      if (Object.keys(fallback.specs).length >= Object.keys(specs).length) {
        specs = fallback.specs;
        glance = fallback.glance ?? glance;
        usedUrl = fallbackUrl;
      }
    }
  }
  if (Object.keys(specs).length >= MIN_SPECS_COUNT) {
    const payload: ModelSpecs = {
      model,
      year,
      specs,
      glance,
      sourceUrl: usedUrl,
      updatedAt: new Date().toISOString()
    };
    cache[key] = payload;
    saveCache(cache);
    return payload;
  }

  if (HARLEY_SPECS_ONLY) {
    return null;
  }

  const items = await getInventoryFeed();
  const normalized = normalizeModel(model);
  const matches = items.filter(item => {
    if (!item.model) return false;
    if (year && item.year && item.year !== year) return false;
    return normalizeModel(item.model) === normalized;
  });
  const urls = selectCandidateUrls(matches);
  for (const url of urls) {
    const html = await fetchHtmlSmart(url, "specs-scraper");
    if (!html) continue;
    const parsed = parseSpecsFromHtml(html);
    const specs = filterSpecMap(parsed);
    if (Object.keys(specs).length < MIN_SPECS_COUNT) continue;
    const payload: ModelSpecs = { model, year, specs, sourceUrl: url, updatedAt: new Date().toISOString() };
    cache[key] = payload;
    saveCache(cache);
    return payload;
  }

  return null;
}

export function buildSpecsSummary(
  label: string,
  specs: Record<string, string>,
  maxItems: number
): string {
  const normalizeSpecValue = (value: string): string => {
    return String(value ?? "")
      .replace(/\u00ae/g, "")
      .replace(/®/g, "")
      .replace(/\s+/g, " ")
      .replace(/\s*\/\s*/g, " / ")
      .replace(/\s*@\s*/g, " @ ")
      .trim();
  };
  const formatRpmValue = (value: string): string => {
    const normalized = normalizeSpecValue(value);
    const digitsOnly = normalized.replace(/[^\d]/g, "");
    const asNumber = Number(digitsOnly);
    if (Number.isFinite(asNumber) && asNumber >= 500 && asNumber <= 15000) {
      return `${asNumber.toLocaleString("en-US")} rpm`;
    }
    return normalized;
  };
  const formatSpecPhrase = (key: string, value: string): string => {
    const lk = key.toLowerCase();
    const v = normalizeSpecValue(value);
    if (!v) return "";
    if (lk.includes("horsepower")) {
      if (/^\d{3,5}$/.test(v)) return `horsepower peak at ${formatRpmValue(v)}`;
      if (/\bhp\b|\bkw\b/i.test(v)) return `${v} output`;
      return `${v} horsepower`;
    }
    if (lk.includes("torque")) {
      if (/\bj1349\b/i.test(v)) return "";
      if (lk.includes("rpm") || /^\d{3,5}$/.test(v)) return `torque peak at ${formatRpmValue(v)}`;
      return /\b(ft|lb|nm)\b/i.test(v) ? `${v} torque` : `torque ${v}`;
    }
    if (lk.includes("displacement")) return `${v} displacement`;
    if (lk.includes("fuel capacity")) return `fuel capacity ${v}`;
    if (lk.includes("seat height")) return `seat height ${v}`;
    if (lk.includes("wheelbase")) return `wheelbase ${v}`;
    if (lk.includes("weight")) return `weight ${v}`;
    if (lk.includes("rake")) return `rake ${v}`;
    if (lk.includes("trail")) return `trail ${v}`;
    if (lk.includes("length")) return `length ${v}`;
    if (lk.includes("width")) return `width ${v}`;
    if (lk.includes("height")) return `height ${v}`;
    if (lk.includes("transmission")) return `transmission ${v}`;
    if (lk.includes("engine")) {
      return /engine|motor/i.test(v) ? v : `${v} engine`;
    }
    return `${key.toLowerCase()} ${v}`;
  };
  const joinNatural = (parts: string[]): string => {
    if (parts.length === 1) return parts[0];
    if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
    return `${parts.slice(0, -1).join(", ")}, and ${parts[parts.length - 1]}`;
  };
  const priority = [
    "engine",
    "displacement",
    "horsepower",
    "torque",
    "transmission",
    "weight",
    "seat height",
    "fuel capacity",
    "length",
    "wheelbase"
  ];
  const entries: Array<[string, string]> = [];
  const lowerKeys = Object.keys(specs);
  for (const wanted of priority) {
    const foundKey = lowerKeys.find(k => k.toLowerCase().includes(wanted));
    if (foundKey && specs[foundKey]) {
      entries.push([foundKey, specs[foundKey]]);
    }
    if (entries.length >= maxItems) break;
  }
  if (!entries.length) {
    const fallback = Object.entries(specs).slice(0, maxItems);
    entries.push(...fallback);
  }
  const lead = label === "the bike" ? "the bike" : `the ${label}`;
  const phrases = entries.map(([k, v]) => formatSpecPhrase(k, v)).filter(Boolean);
  const formatted = joinNatural(phrases.length ? phrases : Object.entries(specs).slice(0, maxItems).map(([k, v]) => `${k}: ${normalizeSpecValue(v)}`));
  return `Quick specs on ${lead}: ${formatted}.`;
}

export function buildGlanceSummary(label: string, glance?: string | null): string | null {
  if (!glance) return null;
  const cleaned = decodeHtmlEntities(stripTags(glance))
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return null;
  const scrubbed = cleaned
    .replace(/\b(striking|iconic|aggressive|premium|legendary|bold|all-new|new)\b/gi, "")
    .replace(/colorways?/gi, "")
    .replace(/optimized for [^,.;]+/gi, "")
    .replace(/keeping you[^,.;]+/gi, "")
    .replace(/every road[^.]+/gi, "")
    .replace(/\s+/g, " ")
    .replace(/\s+,/g, ",")
    .replace(/,\s*,/g, ",")
    .replace(/\s+\./g, ".")
    .trim()
    .replace(/^\s*with\s+/i, "");
  if (!scrubbed) return null;
  const lead = label === "the bike" ? "the bike" : `the ${label}`;
  return `Quick highlights on ${lead}: ${scrubbed}.`;
}
