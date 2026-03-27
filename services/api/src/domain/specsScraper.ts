import { fetchHtmlSmart } from "./zenrowsFetch.js";
import { getInventoryFeed, InventoryFeedItem } from "./inventoryFeed.js";
import { dataPath } from "./dataDir.js";
import fs from "node:fs";

export type ModelSpecs = {
  model: string;
  year?: string | null;
  specs: Record<string, string>;
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

async function fetchSpecsForUrl(url: string | null): Promise<Record<string, string>> {
  if (!url) return {};
  const html = await fetchHtmlSmart(url, "specs-scraper");
  if (!html) return {};
  const parsed = parseSpecsFromHtml(html);
  return filterSpecMap(parsed);
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
  if (!node || depth > 8) return;
  if (Array.isArray(node)) {
    for (const item of node) collectSpecsFromJsonNode(item, out, depth + 1);
    return;
  }
  if (typeof node !== "object") return;
  const specContainers = [
    node.specs,
    node.specifications,
    node.items,
    node.values,
    node.attributes
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
    null;
  let value: string | null = null;
  if (typeof valueCandidate === "string" || typeof valueCandidate === "number" || typeof valueCandidate === "boolean") {
    value = String(valueCandidate);
  } else if (Array.isArray(valueCandidate)) {
    const parts = valueCandidate
      .map(item => {
        if (typeof item === "string" || typeof item === "number" || typeof item === "boolean") {
          return String(item);
        }
        if (item && typeof item === "object") {
          return (
            item.value ??
            item.displayValue ??
            item.text ??
            item.label ??
            item.name ??
            null
          );
        }
        return null;
      })
      .filter(Boolean)
      .map(v => String(v));
    if (parts.length) value = parts.join(", ");
  }
  if (label && value) {
    out[label] = value;
  } else if (label && valueCandidate && typeof valueCandidate === "object") {
    const derived =
      (valueCandidate as any).value ??
      (valueCandidate as any).displayValue ??
      (valueCandidate as any).text ??
      (valueCandidate as any).label ??
      (valueCandidate as any).name ??
      null;
    if (typeof derived === "string" || typeof derived === "number" || typeof derived === "boolean") {
      out[label] = String(derived);
    }
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

function filterSpecMap(specs: Record<string, string>): Record<string, string> {
  const filtered: Record<string, string> = {};
  const invalidKey = /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|hours?|open|closed)\b/i;
  const invalidValueDays = /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i;
  const invalidValueTimes = /\b\d{1,2}:\d{2}\s*(am|pm)?\b/i;
  const invalidValueStatus = /\b(open|closed)\b/i;
  for (const [key, value] of Object.entries(specs)) {
    if (!key || !value) continue;
    if (invalidKey.test(key)) continue;
    if (invalidValueDays.test(value) || invalidValueTimes.test(value) || invalidValueStatus.test(value)) continue;
    filtered[key] = value;
  }
  return filtered;
}

function parseSpecsFromHtml(html: string): Record<string, string> {
  const specs: Record<string, string> = {};
  if (!html) return specs;

  Object.assign(specs, extractFromJsonLd(html));
  Object.assign(specs, extractFromJsonScripts(html));

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
      if (Object.keys(cleaned).length >= 3) {
        if (Object.keys(cleaned).length !== Object.keys(cached.specs).length) {
          cache[key] = { ...cached, specs: cleaned };
          saveCache(cache);
        }
        return { ...cached, specs: cleaned };
      }
    }
  }

  const harleyUrl = resolveHarleyUrl(model, year);
  let specs = await fetchSpecsForUrl(harleyUrl);
  let usedUrl = harleyUrl;
  if (Object.keys(specs).length < 3 && year) {
    const fallbackUrl = resolveHarleyUrl(model, null);
    if (fallbackUrl && fallbackUrl !== harleyUrl) {
      const fallbackSpecs = await fetchSpecsForUrl(fallbackUrl);
      if (Object.keys(fallbackSpecs).length >= Object.keys(specs).length) {
        specs = fallbackSpecs;
        usedUrl = fallbackUrl;
      }
    }
  }
  if (Object.keys(specs).length >= 3) {
    const payload: ModelSpecs = {
      model,
      year,
      specs,
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
    if (Object.keys(specs).length < 3) continue;
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
  const formatted = entries
    .map(([k, v]) => `${k}: ${v}`)
    .join("; ");
  return `${label} — ${formatted}`;
}
