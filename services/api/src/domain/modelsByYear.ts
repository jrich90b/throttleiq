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
  const first = parts[0] ?? "";
  const second = parts[1] ?? "";
  const isCodeToken = (token: string) => /^[A-Z0-9]{2,6}$/.test(token);
  const secondHasDigit = /\d/.test(second);
  // Only strip leading codes when the pattern looks like CODE + CODE_WITH_DIGIT (e.g., "FLFB 1YF9 FAT BOY")
  if (parts.length >= 3 && isCodeToken(first) && secondHasDigit) {
    return toTitleCaseIfAllCaps(parts.slice(2).join(" ").trim());
  }
  // If the first token itself is a compact code with digits (e.g., "1YF9 FAT BOY")
  if (parts.length >= 2 && isCodeToken(first) && /\d/.test(first)) {
    return toTitleCaseIfAllCaps(parts.slice(1).join(" ").trim());
  }
  return toTitleCaseIfAllCaps(parts.join(" ").trim());
}

function normalizeModelName(value: string | null | undefined): string {
  return String(value ?? "")
    .replace(/harley-?davidson\s+/i, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
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

export function isModelInRecentYears(
  model: string | null | undefined,
  currentYear: number,
  yearsBack = 1
): boolean {
  if (!model || !Number.isFinite(currentYear)) return false;
  const target = normalizeModelName(model);
  if (!target) return false;
  const map = getModelsByYear();
  const minYear = currentYear - Math.max(0, yearsBack);
  for (let y = currentYear; y >= minYear; y--) {
    for (const name of map[String(y)] ?? []) {
      if (normalizeModelName(name) === target) return true;
    }
  }
  return false;
}
