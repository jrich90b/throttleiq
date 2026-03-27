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
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function cacheKey(model: string, year?: string | null): string {
  return `${String(year ?? "").trim()}|${model.trim().toLowerCase()}`;
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
    const keyRaw = decodeHtmlEntities(stripTags(cells[0]));
    const valRaw = decodeHtmlEntities(stripTags(cells[1]));
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

function parseSpecsFromHtml(html: string): Record<string, string> {
  const specs: Record<string, string> = {};
  if (!html) return specs;

  Object.assign(specs, extractFromJsonLd(html));

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

  return specs;
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
      return cached;
    }
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
    const specs = parseSpecsFromHtml(html);
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
