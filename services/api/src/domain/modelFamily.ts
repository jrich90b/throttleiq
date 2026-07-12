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
  familyKeys: Set<string>; // normalized family-node names ("trike", "touring", ...)
  familyCodeCountByKey: Map<string, number>; // family key -> number of member codes
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
  const familyKeys = new Set<string>();
  const familyCodeCountByKey = new Map<string, number>();
  for (const [family, codes] of Object.entries(parsed.families ?? {})) {
    const key = normalizeFamilyModelKey(family);
    if (!key) continue;
    familyKeys.add(key);
    familyCodeCountByKey.set(key, (codes ?? []).map(normalizeFamilyCode).filter(Boolean).length);
  }
  trikeLookupCache = {
    trikeCodes,
    aliasByKey,
    aliasKeysByLength: [...aliasByKey.keys()].sort((a, b) => b.length - a.length),
    allCodes,
    familyKeys,
    familyCodeCountByKey
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

// ---------------------------------------------------------------------------
// Family-only labels (Joe ruling 2026-07-11 #4): "new or used trike" names a
// FAMILY (Tri Glide / Freewheeler / Road Glide 3), not a bookable model. A watch
// created on a family label matches nothing or the wrong bike (+15857552622 got
// a wrong-model wrong-years watch). When a label/turn resolves to a family node,
// the correct move is ONE clarifying "which model?" — never a guessed watch.
// Deterministic is correct here: classifying a label against the catalog's
// family taxonomy is structured extraction, not comprehension.
// FAIL DIRECTION: unknown/no-catalog resolves to false/null and infers NOTHING —
// callers keep today's behavior. We only redirect labels the catalog KNOWS are
// family nodes.
// ---------------------------------------------------------------------------

const FAMILY_LABEL_NOISE_WORDS = new Set([
  "or", "new", "used", "a", "an", "the", "any", "all", "either",
  "harley", "davidson", "hd", "motorcycle", "motorcycles", "bike", "bikes", "model"
]);

function familyKeySet(): Set<string> | null {
  const lookup = loadTrikeLookup();
  if (!lookup) return null;
  return lookup.familyKeys;
}

function stripFamilyLabelNoise(key: string): string {
  return key
    .split(" ")
    .filter(w => w && !FAMILY_LABEL_NOISE_WORDS.has(w))
    .join(" ");
}

function singularizeFamilyWord(word: string): string {
  return word.length > 3 && word.endsWith("s") ? word.slice(0, -1) : word;
}

/**
 * Is this model LABEL (lead.vehicle.model, a parsed watch model, an ADF Vehicle
 * field) a catalog FAMILY node rather than a specific bookable model?
 * "Or New Trike" → "trike" → TRIKE family → true. "Tri Glide" → a real model →
 * false. Whole-label equality after noise-stripping — never a substring test, so
 * "Street Glide" can not false-match the STREET family.
 */
export function isFamilyOnlyModelLabel(label: string | null | undefined): boolean {
  const families = familyKeySet();
  if (!families || !families.size) return false; // no catalog → infer nothing
  const key = normalizeFamilyModelKey(label);
  if (!key) return false;
  const stripped = stripFamilyLabelNoise(key);
  if (!stripped) return false;
  if (families.has(stripped)) return true;
  const singular = stripped.split(" ").map(singularizeFamilyWord).join(" ");
  return families.has(singular);
}

/**
 * Does this customer TURN reference a family word ("trike") standalone — i.e.
 * NOT as part of a longer specific-model alias ("Street Glide Trike", "Road
 * Glide 3 Trike")? Returns the family word, or null. Used by the watch-model
 * resolver: a standalone family reference must clarify ("which model?"), never
 * fall back to the lead-vehicle model the customer didn't name this turn.
 */
// Family words that read as generic ATTRIBUTES in customer speech ("a street bike",
// "something lightweight") — never treat their mere presence in a turn as a family
// reference. Label-equality (isFamilyOnlyModelLabel) still catches them as bare labels.
const ATTRIBUTE_LIKE_FAMILY_WORDS = new Set(["street", "lightweight"]);

export function referencesFamilyOnlyInText(text: string | null | undefined): string | null {
  const lookup = loadTrikeLookup();
  if (!lookup || !lookup.familyKeys.size) return null;
  const key = normalizeFamilyModelKey(text);
  if (!key) return null;
  const padded = ` ${key} `;
  for (const family of lookup.familyKeys) {
    if (family.includes(" ")) continue; // multi-word family keys: label-equality only
    if (ATTRIBUTE_LIKE_FAMILY_WORDS.has(family)) continue;
    const familyPlural = `${family}s`;
    if (!padded.includes(` ${family} `) && !padded.includes(` ${familyPlural} `)) continue;
    // Standalone check: if the text also contains a longer known alias phrase that
    // includes this family word AND is NARROWER than the family word's own alias
    // (fewer member codes), the customer named a specific model ("street glide
    // trike" → 1 code vs "trike" → 6), not the family. Umbrella aliases as broad
    // as the family word itself ("touring bike" → 15 = "touring" → 15) do NOT
    // count as specific — they ARE the family reference. Compare alias-to-alias:
    // the families map carries ALL historical codes (TOURING=92) while aliases
    // carry the current set, so a families-map comparison would never fire.
    const familyCodeCount =
      (lookup.aliasByKey.get(family) ?? []).length || (lookup.familyCodeCountByKey.get(family) ?? 0);
    let partOfSpecificAlias = false;
    for (const aliasKey of lookup.aliasKeysByLength) {
      if (!aliasKey.includes(" ")) continue;
      if (!` ${aliasKey} `.includes(` ${family} `) && !` ${aliasKey} `.includes(` ${familyPlural} `)) continue;
      if (!padded.includes(` ${aliasKey} `)) continue;
      const aliasCodes = lookup.aliasByKey.get(aliasKey) ?? [];
      if (familyCodeCount > 0 && aliasCodes.length >= familyCodeCount) continue; // umbrella = the family
      partOfSpecificAlias = true;
      break;
    }
    if (!partOfSpecificAlias) return family;
  }
  return null;
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
