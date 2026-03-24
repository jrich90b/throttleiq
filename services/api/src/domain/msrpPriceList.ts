import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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

let cache: { items: MsrpEntry[]; loadedAt: number } | null = null;
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

export async function findMsrpPricing(opts: MsrpLookup): Promise<MsrpLookupResult | null> {
  if (!isSupportedYear(opts.year)) return null;
  const items = await loadMsrpList();
  if (!items.length) return null;
  const entry = matchModel(items, opts.model);
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
