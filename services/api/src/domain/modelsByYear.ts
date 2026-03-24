import fs from "fs";
import path from "path";

const MODELS_BY_YEAR_PATH =
  process.env.MODELS_BY_YEAR_PATH ?? path.resolve(process.cwd(), "data", "models_by_year.json");

let cached: Record<string, string[]> | null = null;

function toTitleCaseIfAllCaps(value: string): string {
  const letters = value.replace(/[^A-Za-z]/g, "");
  if (!letters) return value;
  if (letters !== letters.toUpperCase()) return value;
  return value
    .toLowerCase()
    .replace(/\b\w/g, c => c.toUpperCase());
}

function stripModelCode(raw: string): string {
  const parts = String(raw ?? "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "";
  let idx = parts.findIndex(p => /\d/.test(p));
  let modelParts = idx >= 0 ? parts.slice(idx + 1) : parts;
  if (!modelParts.length && parts.length > 1) modelParts = parts.slice(1);
  if (idx === -1 && parts.length > 1 && /^[A-Z0-9]{2,6}$/.test(parts[0])) {
    modelParts = parts.slice(1);
  }
  const model = modelParts.join(" ").trim();
  return toTitleCaseIfAllCaps(model);
}

export function getModelsByYear(): Record<string, string[]> {
  if (cached) return cached;
  try {
    const raw = fs.readFileSync(MODELS_BY_YEAR_PATH, "utf8");
    const data = JSON.parse(raw) as Record<string, string[]>;
    const out: Record<string, string[]> = {};
    for (const [year, list] of Object.entries(data || {})) {
      const seen = new Set<string>();
      const cleaned = (list || [])
        .map(stripModelCode)
        .map(s => s.trim())
        .filter(Boolean)
        .filter(name => {
          const key = name.toLowerCase();
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        })
        .sort((a, b) => a.localeCompare(b));
      out[year] = cleaned;
    }
    cached = out;
    return out;
  } catch {
    cached = {};
    return cached;
  }
}

export function getModelsForYear(year?: number | null): string[] {
  if (!year) return [];
  const map = getModelsByYear();
  return map[String(year)] ?? [];
}

export function getModelsForYearRange(min?: number | null, max?: number | null): string[] {
  if (!min || !max) return [];
  const map = getModelsByYear();
  const out = new Set<string>();
  for (let y = Math.min(min, max); y <= Math.max(min, max); y++) {
    for (const name of map[String(y)] ?? []) out.add(name);
  }
  return Array.from(out).sort((a, b) => a.localeCompare(b));
}

export function getAllModels(): string[] {
  const map = getModelsByYear();
  const out = new Set<string>();
  for (const list of Object.values(map)) {
    for (const name of list) out.add(name);
  }
  return Array.from(out).sort((a, b) => a.localeCompare(b));
}
