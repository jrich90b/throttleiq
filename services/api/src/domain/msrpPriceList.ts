import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadHdCatalog, findModelInHdCatalog, findBestCatalogModel } from "./hdCatalog.js";

/** Dark flag: source exact per-color finish pricing from the scraped HD detail-page catalog (instead of
 *  the hand-maintained MSRP sheet). Off by default — this is a customer-facing pricing change. */
function hdCatalogFinishPricingEnabled(): boolean {
  return process.env.HD_CATALOG_FINISH_PRICING === "1";
}

type MsrpTrim = {
  spec?: string;
  type?: string;
  name?: string;
  adder?: number;
  msrp?: number;
};

type MsrpColor = {
  name?: string;
  adder?: number;
};

export type MsrpEntry = {
  family?: string;
  model_code?: string;
  model_name?: string;
  spec_code?: string;
  base_msrp?: number;
  base_option_type?: string;
  base_option_spec?: string;
  base_option_name?: string;
  colors?: MsrpColor[];
  trims?: MsrpTrim[];
  msrp_range?: { min: number; max: number };
  max_color_adder?: number;
  max_trim_adder?: number;
};

export type MsrpLookup = {
  model?: string | null;
  year?: string | null;
  trimText?: string | null;
  colorText?: string | null;
};

export type MsrpLookupResult = {
  entry: MsrpEntry;
  exact?: number | null;
  range: { min: number; max: number };
  rangeForTrim?: { min: number; max: number } | null;
  rangeForColor?: { min: number; max: number } | null;
  trim?: MsrpTrim | null;
  color?: MsrpColor | null;
};

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_PATH = resolve(__dirname, "../../data/price_list_msrp_2026.json");
/** The model year this MSRP sheet represents. Used by the discontinuation heuristic's staleness guard.
 *  When the sheet is swapped (file -> API, or a new model year), update this. */
export const MSRP_SHEET_MODEL_YEAR = 2026;

let cache: { items: MsrpEntry[]; loadedAt: number } | null = null;
let colorCache: { items: string[]; loadedAt: number } | null = null;
const CACHE_TTL_MS = 10 * 60 * 1000;

function normalizeToken(input: string | null | undefined): string {
  return String(input ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function scoreMatch(text: string, candidate: string): number {
  if (!text || !candidate) return 0;
  if (text === candidate) return 100 + candidate.length;
  if (text.includes(candidate)) return 80 + candidate.length;
  if (candidate.includes(text)) return 60 + text.length;
  return 0;
}

function pickBest<T>(items: T[], getKey: (item: T) => string): T | null {
  let best: T | null = null;
  let bestScore = 0;
  for (const item of items) {
    const key = getKey(item);
    const score = key ? Number(key.split("|")[0]) : 0;
    if (score > bestScore) {
      bestScore = score;
      best = item;
    }
  }
  return best;
}

async function loadMsrpList(): Promise<MsrpEntry[]> {
  const now = Date.now();
  if (cache && now - cache.loadedAt < CACHE_TTL_MS) return cache.items;
  const raw = await readFile(DATA_PATH, "utf8");
  const parsed = JSON.parse(raw);
  const items = Array.isArray(parsed) ? (parsed as MsrpEntry[]) : [];
  cache = { items, loadedAt: now };
  return items;
}

export async function getMsrpColorNames(): Promise<string[]> {
  const now = Date.now();
  if (colorCache && now - colorCache.loadedAt < CACHE_TTL_MS) return colorCache.items;
  const items = await loadMsrpList();
  const seen = new Map<string, string>();
  for (const entry of items) {
    const baseName = entry.base_option_name ? String(entry.base_option_name).trim() : "";
    if (baseName) {
      const key = normalizeToken(baseName);
      if (key && !seen.has(key)) seen.set(key, baseName);
    }
    for (const color of entry.colors ?? []) {
      const name = color?.name ? String(color.name).trim() : "";
      if (!name) continue;
      const key = normalizeToken(name);
      if (key && !seen.has(key)) seen.set(key, name);
    }
  }
  // Catalog-first (dark flag): also surface colors the scraped catalog carries but the static sheet
  // doesn't, so customer color mentions on those models are detected.
  if (hdCatalogFinishPricingEnabled()) {
    for (const m of await loadHdCatalog()) {
      for (const c of m.finish?.colors ?? []) {
        const name = c?.name ? String(c.name).trim() : "";
        if (!name) continue;
        const key = normalizeToken(name);
        if (key && !seen.has(key)) seen.set(key, name);
      }
    }
  }
  const list = [...seen.values()].filter(Boolean);
  colorCache = { items: list, loadedAt: now };
  return list;
}

function matchModel(items: MsrpEntry[], model?: string | null): MsrpEntry | null {
  let query = normalizeToken(model);
  if (!query) return null;
  if (/\broad glide 3\b/.test(query) || /\brg3\b/.test(query) || /\bfltrt\b/.test(query)) {
    query = "road glide trike";
  }
  let best: MsrpEntry | null = null;
  let bestScore = 0;
  for (const entry of items) {
    const name = normalizeToken(entry.model_name);
    const code = normalizeToken(entry.model_code);
    const nameScore = scoreMatch(query, name);
    const codeScore = scoreMatch(query, code);
    const score = Math.max(nameScore, codeScore);
    if (score > bestScore) {
      bestScore = score;
      best = entry;
    }
  }
  return best;
}

function matchTrim(entry: MsrpEntry, text?: string | null): MsrpTrim | null {
  const query = normalizeToken(text);
  if (!query) return null;
  const trims = entry.trims ?? [];
  const scored = trims
    .map(trim => {
      const name = normalizeToken(trim.name);
      const spec = normalizeToken(trim.spec);
      const score = Math.max(scoreMatch(query, name), scoreMatch(query, spec));
      return { score, trim };
    })
    .filter(r => r.score > 0)
    .sort((a, b) => b.score - a.score);
  return scored[0]?.trim ?? null;
}

function matchColor(entry: MsrpEntry, text?: string | null): MsrpColor | null {
  const query = normalizeToken(text);
  if (!query) return null;
  const colors = entry.colors ?? [];
  const scored = colors
    .map(color => {
      const name = normalizeToken(color.name);
      const score = scoreMatch(query, name);
      return { score, color };
    })
    .filter(r => r.score > 0)
    .sort((a, b) => b.score - a.score);
  return scored[0]?.color ?? null;
}

function isSupportedYear(year?: string | null): boolean {
  if (!year) return true;
  const numeric = Number(year);
  if (!Number.isFinite(numeric)) return false;
  return numeric >= 2026;
}

/**
 * Build an MsrpEntry from the scraped HD catalog's per-color finish data (detail-page configurator), so
 * `findMsrpPricing` can answer finish-specific pricing exactly (e.g. "Street Bob in Billiard Gray"). The
 * configurator's seat/wheel options are accessories, NOT finish, so we intentionally leave `trims` empty
 * — that keeps a color-only query resolvable to an exact number (base + color adder) instead of a range.
 * Returns null when the model isn't in the catalog or has no finish data (caller falls back to the sheet).
 */
async function findFinishEntryInHdCatalog(opts: { model?: string | null; year?: string | null }): Promise<MsrpEntry | null> {
  if (!opts.model) return null;
  const yearNum = opts.year != null && Number.isFinite(Number(opts.year)) ? Number(opts.year) : null;
  const match = findBestCatalogModel(await loadHdCatalog(), opts.model, { year: yearNum });
  const finish = match?.finish;
  if (!match || !finish) return null;
  const base = finish.baseMsrp ?? match.price ?? null;
  if (!base) return null;
  const colors: MsrpColor[] = (finish.colors ?? []).map(c => ({ name: c.name, adder: c.adder }));
  const maxColorAdder = colors.reduce((m, c) => Math.max(m, c.adder ?? 0), 0);
  return {
    model_code: match.modelCode,
    model_name: match.name,
    base_msrp: base,
    colors,
    trims: [],
    msrp_range: { min: base, max: base + maxColorAdder },
    max_color_adder: maxColorAdder,
    max_trim_adder: 0
  };
}

/** The trim/color match + range/exact math, shared by the catalog-finish and static-sheet paths. */
function computeMsrpResult(entry: MsrpEntry, opts: MsrpLookup): MsrpLookupResult | null {
  if (!entry || !entry.base_msrp) return null;

  const trim = matchTrim(entry, opts.trimText);
  const color = matchColor(entry, opts.colorText);

  const base = entry.base_msrp ?? 0;
  const trimAdder = typeof trim?.adder === "number" ? trim.adder : 0;
  const colorAdder = typeof color?.adder === "number" ? color.adder : 0;
  const maxTrimAdder = entry.max_trim_adder ?? 0;
  const maxColorAdder = entry.max_color_adder ?? 0;
  const hasTrimVariants = maxTrimAdder > 0 || (entry.trims?.length ?? 0) > 1;
  const hasColorVariants = maxColorAdder > 0 || (entry.colors?.length ?? 0) > 1;

  const range = {
    min: base,
    max: base + maxTrimAdder + maxColorAdder
  };

  const rangeForTrim = trim
    ? {
        min: base + trimAdder,
        max: base + trimAdder + maxColorAdder
      }
    : null;

  const rangeForColor = color
    ? {
        min: base + colorAdder,
        max: base + colorAdder + maxTrimAdder
      }
    : null;

  let exact: number | null = null;
  if ((trim && color) || (trim && !hasColorVariants) || (color && !hasTrimVariants) || (!hasTrimVariants && !hasColorVariants)) {
    exact = base + trimAdder + colorAdder;
  }

  return {
    entry,
    exact,
    range,
    rangeForTrim,
    rangeForColor,
    trim,
    color
  };
}

export async function findMsrpPricing(opts: MsrpLookup): Promise<MsrpLookupResult | null> {
  // Catalog-first (dark flag): exact per-color finish pricing sourced from the scraped HD detail pages.
  // The static MSRP sheet is the fallback when the catalog lacks the model or its finish data.
  if (hdCatalogFinishPricingEnabled()) {
    const catEntry = await findFinishEntryInHdCatalog({ model: opts.model, year: opts.year });
    if (catEntry) {
      const result = computeMsrpResult(catEntry, opts);
      if (result) return result;
    }
  }
  if (!isSupportedYear(opts.year)) return null;
  const items = await loadMsrpList();
  if (!items.length) return null;
  const entry = matchModel(items, opts.model);
  if (!entry) return null;
  return computeMsrpResult(entry, opts);
}

/**
 * Is a model present in the CURRENT model catalog (the MSRP sheet), and how strong is the match?
 * This is the single data-source seam for the discontinuation heuristic: today it reads the static
 * sheet; swapping to a live catalog API later is a change to THIS function only. Matches at family /
 * model_name / model_code granularity (so engine/trim iterations like "Fat Bob 114" resolve to the
 * "Fat Bob" family). Returns the best score so the caller can apply a confidence threshold.
 */
export async function findModelInMsrp(model?: string | null): Promise<{ matched: boolean; score: number; family: string | null; modelName: string | null }> {
  // SEAM: prefer the auto-sourced HD catalog (current + prior model year, complete + fresh); fall back
  // to the static MSRP sheet when the catalog hasn't been scraped yet (loadHdCatalog returns []). Return
  // the stronger of the two matches — so "is this a current/recent model" reflects HD's real lineup.
  const catMatch = findModelInHdCatalog(await loadHdCatalog(), model ?? "");

  const items = await loadMsrpList();
  let query = normalizeToken(model);
  let fileScore = 0;
  let fileBest: MsrpEntry | null = null;
  if (query && items.length) {
    if (/\broad glide 3\b/.test(query) || /\brg3\b/.test(query) || /\bfltrt\b/.test(query)) query = "road glide trike";
    for (const entry of items) {
      const score = Math.max(
        scoreMatch(query, normalizeToken(entry.model_name)),
        scoreMatch(query, normalizeToken(entry.model_code)),
        scoreMatch(query, normalizeToken(entry.family))
      );
      if (score > fileScore) {
        fileScore = score;
        fileBest = entry;
      }
    }
  }

  if (catMatch.score >= fileScore) {
    return { matched: catMatch.matched, score: catMatch.score, family: null, modelName: catMatch.name };
  }
  return { matched: fileScore >= 60, score: fileScore, family: fileBest?.family ?? null, modelName: fileBest?.model_name ?? null };
}

export async function modelHasFinishOptions(opts: {
  year?: string | number | null;
  model?: string | null;
}): Promise<boolean> {
  const year = opts.year != null ? String(opts.year) : null;
  if (!isSupportedYear(year)) return false;
  const items = await loadMsrpList();
  if (!items.length) return false;
  const entry = matchModel(items, opts.model ?? null);
  if (!entry) return false;
  const trims = entry.trims ?? [];
  if (trims.length < 2) return false;
  return trims.some(t => {
    const token = normalizeToken(t.name ?? t.spec ?? "");
    return token.includes("chrome") || token.includes("black");
  });
}
