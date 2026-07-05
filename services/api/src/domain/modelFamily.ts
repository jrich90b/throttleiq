/**
 * Trike-class model discrimination, data-driven from model_codes_by_family.json.
 *
 * Joe's rule (2026-07-04): a trike is a different FAMILY from its two-wheel namesake —
 * "Road Glide 3" (FLTRT, TRIKE) is NOT a "Road Glide" (touring) sibling. A trike-class
 * unit must never satisfy — or prompt a variants-clarification ask on — a two-wheel
 * watch, and vice versa. Same-family trims (Special/ST/Limited/CVO) ARE askable siblings.
 *
 * Why trike-class membership and not general family disjointness: the catalog cross-lists
 * codes across families (FLTRT sits in BOTH TOURING and TRIKE; CVO is an overlay family
 * over touring/softail codes), so "families intersect" is true for exactly the pairs we
 * must separate. TRIKE membership is the one clean form-factor axis: a model whose codes
 * are ALL in the TRIKE family is a trike; a model with predominantly non-trike codes is
 * not. This is deterministic structured extraction over catalog/inventory model LABELS
 * (never customer free text) — allowed deterministic per AGENTS.md.
 *
 * Fail direction: unknown model text resolves to null and null infers NOTHING — the
 * caller falls through to existing matcher behavior. We only separate models the catalog
 * actually knows.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

type ModelCodesCatalog = {
  families?: Record<string, string[]>;
  aliases?: Record<string, string[]>;
};

type TrikeLookup = {
  trikeCodes: Set<string>;
  aliasByKey: Map<string, string[]>;
  aliasKeysByLength: string[]; // longest first — most-specific alias wins
  allCodes: Set<string>;
};

let trikeLookupCache: TrikeLookup | null | undefined;

function normalizeFamilyModelKey(text: string | null | undefined): string {
  return String(text ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeFamilyCode(value: string | null | undefined): string {
  return String(value ?? "")
    .toUpperCase()
    .replace(/[^A-Z0-9_-]+/g, "")
    .trim();
}

function catalogCandidatePaths(): string[] {
  const envPath = String(process.env.MODEL_CODES_BY_FAMILY_PATH ?? "").trim();
  const byCwdSrc = path.resolve(process.cwd(), "src/domain/model_codes_by_family.json");
  const byCwdRepo = path.resolve(process.cwd(), "services/api/src/domain/model_codes_by_family.json");
  // Compiled layout: dist/domain/modelFamily.js sits next to dist/domain/model_codes_by_family.json.
  const bySibling = fileURLToPath(new URL("./model_codes_by_family.json", import.meta.url));
  return Array.from(new Set([envPath, byCwdSrc, byCwdRepo, bySibling].filter(Boolean)));
}

function loadTrikeLookup(): TrikeLookup | null {
  if (trikeLookupCache !== undefined) return trikeLookupCache;
  let parsed: ModelCodesCatalog | null = null;
  for (const p of catalogCandidatePaths()) {
    try {
      parsed = JSON.parse(fs.readFileSync(p, "utf8")) as ModelCodesCatalog;
      if (parsed && typeof parsed === "object") break;
      parsed = null;
    } catch {
      // try next location
    }
  }
  if (!parsed) {
    trikeLookupCache = null;
    return null;
  }
  const trikeCodes = new Set<string>();
  for (const [family, codes] of Object.entries(parsed.families ?? {})) {
    if (normalizeFamilyModelKey(family) !== "trike") continue;
    for (const raw of codes ?? []) {
      const code = normalizeFamilyCode(raw);
      if (code) trikeCodes.add(code);
    }
  }
  const aliasByKey = new Map<string, string[]>();
  const allCodes = new Set<string>();
  for (const [rawKey, rawCodes] of Object.entries(parsed.aliases ?? {})) {
    const key = normalizeFamilyModelKey(rawKey);
    if (!key || !Array.isArray(rawCodes)) continue;
    const codes = rawCodes.map(normalizeFamilyCode).filter(Boolean);
    if (!codes.length) continue;
    aliasByKey.set(key, codes);
    for (const c of codes) allCodes.add(c);
  }
  for (const codes of Object.values(parsed.families ?? {})) {
    for (const raw of codes ?? []) {
      const code = normalizeFamilyCode(raw);
      if (code) allCodes.add(code);
    }
  }
  trikeLookupCache = {
    trikeCodes,
    aliasByKey,
    aliasKeysByLength: [...aliasByKey.keys()].sort((a, b) => b.length - a.length),
    allCodes
  };
  return trikeLookupCache;
}

function keyContains(haystack: string, needle: string): boolean {
  if (!haystack || !needle) return false;
  return ` ${haystack} `.includes(` ${needle} `);
}

/** Resolve a model label to catalog codes: most-specific (longest) alias contained in the
 *  text wins ("road glide 3" beats "road glide"); code-looking tokens resolve directly. */
function resolveCodesForModelText(text: string, lookup: TrikeLookup): string[] {
  const key = normalizeFamilyModelKey(text);
  if (!key) return [];
  const exact = lookup.aliasByKey.get(key);
  if (exact) return exact;
  for (const aliasKey of lookup.aliasKeysByLength) {
    if (keyContains(key, aliasKey)) return lookup.aliasByKey.get(aliasKey) ?? [];
  }
  // Code-only labels ("FLTRT") — any token that IS a known catalog code.
  const codes: string[] = [];
  for (const token of key.split(" ")) {
    const code = normalizeFamilyCode(token);
    if (code && lookup.allCodes.has(code)) codes.push(code);
  }
  return codes;
}

/**
 * Is this model label a TRIKE-class model? true / false / null (catalog can't tell).
 * A model is trike-class when EVERY resolved code is in the TRIKE family — the base
 * "road glide" umbrella alias (23 codes, one of them FLTRT) therefore stays two-wheel,
 * while "road glide 3" ([FLTRT]) is a trike. Labels literally naming a trike
 * ("Street Glide Trike", "Freewheeler") are trikes even when alias resolution misses.
 */
export function isTrikeClassModel(modelText: string | null | undefined): boolean | null {
  const key = normalizeFamilyModelKey(modelText);
  if (!key) return null;
  // Explicit form-factor words on the label itself (inventory/catalog strings, not
  // customer text): "trike" / "freewheeler" name the class outright.
  if (/(^| )(trike|freewheeler)( |$)/.test(key)) return true;
  const lookup = loadTrikeLookup();
  if (!lookup || !lookup.trikeCodes.size) return null;
  const codes = resolveCodesForModelText(key, lookup);
  if (!codes.length) return null;
  return codes.every(code => lookup.trikeCodes.has(code));
}

/**
 * Do these two model labels sit on opposite sides of the trike/two-wheel line?
 * Only true when BOTH resolve (null infers nothing — fail toward existing behavior).
 */
export function trikeClassConflict(
  a: string | null | undefined,
  b: string | null | undefined
): boolean {
  const ta = isTrikeClassModel(a);
  if (ta == null) return false;
  const tb = isTrikeClassModel(b);
  if (tb == null) return false;
  return ta !== tb;
}
