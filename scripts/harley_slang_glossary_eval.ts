/**
 * Harley knowledge-layer glossary eval (Joe-approved 2026-07-24).
 *
 * Pins the DETERMINISTIC alias-map layer of the Harley slang glossary
 * (services/api/src/domain/model_codes_by_family.json) + the governance guard hooks
 * in services/api/src/index.ts (detectGenericWatchFamilyLabel). Covers a representative
 * case from EACH glossary table AND the governance, not just the happy path:
 *   1. Model slang -> the right model's codes (streetglide/sg -> Street Glide, rg -> Road
 *      Glide, fatty -> Fat Boy).
 *   2. Attribute/body-style -> a GROUP of codes (fixed fairing/sharknose -> the Road Glide
 *      group) that (a) is a GROUP not one bike, and (b) is registered with an existing
 *      generic watch family so it can NEVER become an ungoverned broad watch fire.
 *   2b. Segment/category term (cruiser, touring) NARROWS to a multi-code group and is a
 *      recognized generic watch family (governed by the broad-code fire guard).
 *   3. Engine-era term (twin cam) is a multi-model GROUP (narrows, never one bike). The
 *      engine-era -> YEAR BAND narrowing itself is the deferred parser-comprehension layer.
 *   4. FLHR vs FLHRC Road King trim split (Joe, precise): hard bag/FLHR = base Road King;
 *      leather bag/FLHRC = Road King Classic.
 *   5. Buell (Table 5) is a separate MAKE -> NO Buell term may exist as an HD alias (a Buell
 *      must never resolve to HD stock). Deterministic governance for the trade-in rule.
 *   6. Ambiguous terms (883, 1200, naked, standard, bobber, cafe racer, liberty, sturgis)
 *      are deliberately NOT hard-resolved in the alias map -> they stay CLARIFY.
 *   7. The new slang integrates with the trike-class guard (rg3 -> trike, fixed fairing ->
 *      two-wheel).
 *
 * FAIL DIRECTION: every added alias either mirrors an existing specific-model code set
 * (pure comprehension win, same fire behavior) or an existing generic-family umbrella that
 * detectGenericWatchFamilyLabel governs. An unrecognized attribute infers nothing.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { isTrikeClassModel } from "../services/api/src/domain/modelFamily.ts";

type Catalog = { aliases?: Record<string, string[]>; families?: Record<string, string[]> };

const root = process.cwd();
const catalogPath = path.resolve(root, "services/api/src/domain/model_codes_by_family.json");
const catalog = JSON.parse(fs.readFileSync(catalogPath, "utf8")) as Catalog;
const apiSource = fs.readFileSync(path.resolve(root, "services/api/src/index.ts"), "utf8");

function norm(v: string): string {
  return String(v ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function getAlias(label: string): Set<string> {
  const target = norm(label);
  for (const [raw, codes] of Object.entries(catalog.aliases ?? {})) {
    if (norm(raw) === target) return new Set((codes ?? []).map(c => String(c).trim().toUpperCase()).filter(Boolean));
  }
  return new Set();
}

function hasAliasKey(label: string): boolean {
  const target = norm(label);
  return Object.keys(catalog.aliases ?? {}).some(raw => norm(raw) === target);
}

// --- 1) Model slang -> the right model's codes. ---
for (const slang of ["streetglide", "street g", "sg"]) {
  const codes = getAlias(slang);
  assert(codes.has("FLHX"), `"${slang}" must resolve to the Street Glide code set (FLHX)`);
  assert.deepEqual(codes, getAlias("street glide"), `"${slang}" must mirror the Street Glide alias exactly`);
}
for (const slang of ["roadglide", "road g", "rg"]) {
  const codes = getAlias(slang);
  assert(codes.has("FLTRX"), `"${slang}" must resolve to the Road Glide code set (FLTRX)`);
  assert.deepEqual(codes, getAlias("road glide"), `"${slang}" must mirror the Road Glide alias exactly`);
}
assert(getAlias("fatty").has("FLSTF") && getAlias("fatty").has("FLFB"), "fatty -> Fat Boy codes");
assert.deepEqual(getAlias("fatty"), getAlias("fat boy"), "fatty mirrors fat boy");
assert.deepEqual(getAlias("rgs"), new Set(["FLTRXS"]), "rgs -> Road Glide Special");
assert.deepEqual(getAlias("sgs"), new Set(["FLHXS"]), "sgs -> Street Glide Special");
assert.deepEqual(getAlias("nightrod"), getAlias("night rod"), "nightrod mirrors night rod");
assert.deepEqual(getAlias("geezer glide"), getAlias("electra glide"), "geezer glide -> Electra Glide/Ultra");
// Vintage/collector single-model slang already in the map must survive.
assert.deepEqual(getAlias("bad boy"), new Set(["FXSTSB"]), "bad boy -> FXSTSB (1995-97 Softail Springer)");

// --- 2) Attribute/body-style -> a GROUP (never one bike) + governed as a family. ---
const fixedFairing = getAlias("fixed fairing");
assert(fixedFairing.size > 1, "fixed fairing must be a GROUP of codes, not one bike");
assert.deepEqual(fixedFairing, getAlias("road glide"), "fixed fairing (sharknose) = the Road Glide group (Joe 7/24)");
assert.deepEqual(getAlias("sharknose"), getAlias("road glide"), "sharknose = Road Glide group");
// GOVERNANCE: the attribute umbrella must resolve to a recognized generic watch family so
// the broad catalog-code fire guard (inventoryItemMatchesWatch) applies — never a broad,
// specificity-claiming, N-model watch fire. Pinned via the routing source.
assert(apiSource.includes('return "road_glide";'), "detectGenericWatchFamilyLabel must map fixed fairing/sharknose -> road_glide");
assert(/tokensExactly\(tokens, \["fixed", "fairing"\]\)/.test(apiSource), "fixed fairing must be a recognized generic watch family (governed, cannot broad-fire)");
assert(/tokensExactly\(tokens, \["bagger"\]\)/.test(apiSource), "bagger must be a recognized generic watch family (governed)");
assert(/tokensExactly\(tokens, \["dana"\]\)/.test(apiSource), "dana (Dyna) must be a recognized generic watch family (governed)");

// --- 2b) Segment/category term NARROWS to a multi-code group; recognized family. ---
assert(getAlias("cruiser").size > 1, "cruiser is a NARROW segment group, not one bike");
assert(getAlias("touring").size > 1, "touring is a NARROW segment group, not one bike");
assert.deepEqual(getAlias("bagger"), getAlias("touring"), "bagger narrows to the Touring segment group (NOT trikes)");
assert.deepEqual(getAlias("sportbike"), getAlias("sport"), "sportbike -> Sport segment group");
assert.deepEqual(getAlias("adv"), getAlias("adventure touring"), "adv -> Adventure segment group");
// The segment ids are already asserted present in index.ts by harley_watch_model_catalog_eval;
// here we pin that the NEW synonyms route to those governed ids.
assert(apiSource.includes('return "touring";'), "bagger/dresser/tourer must route to the governed touring family");
assert(apiSource.includes('return "adventure_touring";'), "adventure/adv must route to the governed adventure_touring family");

// --- 3) Engine-era term is a multi-model GROUP (narrows). Year-band = deferred parser. ---
assert(getAlias("twin cam").size > 1, "twin cam is an engine-era GROUP (narrows the year across many models), not one bike");

// --- 4) Road King FLHR (base) vs FLHRC (Classic) trim split. ---
const hardBag = getAlias("hard bag road king");
assert(hardBag.has("FLHR") && !hardBag.has("FLHRC"), "hard bag / FLHR = base Road King (FLHR), NOT the Classic");
assert.deepEqual(getAlias("flhr"), new Set(["FLHR", "FLHRI"]), "flhr -> base Road King codes");
const leatherBag = getAlias("leather bag road king");
assert(leatherBag.has("FLHRC") && !leatherBag.has("FLHR"), "leather bag = Road King Classic (FLHRC), NOT the base FLHR");
assert.deepEqual(getAlias("flhrc"), new Set(["FLHRC", "FLHRCI"]), "flhrc -> Road King Classic codes");
assert(getAlias("road king classic").has("FLHRC"), "road king classic -> FLHRC");
// Bare "road king" stays the umbrella (both FLHR and FLHRC) -> parser clarifies base vs Classic.
const bareKing = getAlias("road king");
assert(bareKing.has("FLHR") && bareKing.has("FLHRC"), "bare road king umbrella spans base + Classic (clarify at parser layer)");

// --- 5) Buell is a separate MAKE: no Buell term may resolve to an HD model. ---
const buellTerms = [
  "buell", "blast", "firebolt", "ulysses", "thunderbolt", "cyclone",
  "1125r", "1125cr", "xb12s", "xb9r", "xb12r", "xb9s", "xb12x", "s1", "x1", "cityx", "rr1000", "rr1200"
];
for (const term of buellTerms) {
  assert(!hasAliasKey(term), `Buell term "${term}" must NOT exist as an HD alias (a Buell must route to trade/appraisal, never HD stock)`);
}

// --- 6) Ambiguous terms stay CLARIFY: deliberately not hard-resolved in the alias map. ---
for (const term of ["883", "1200", "naked", "standard", "bobber", "cafe racer", "chopper", "hardtail", "liberty", "sturgis", "confederate"]) {
  assert(!hasAliasKey(term), `Ambiguous term "${term}" must NOT be a hard-resolve alias (stays CLARIFY / parser layer)`);
}

// --- 7) New slang integrates with the trike-class guard. ---
assert.equal(isTrikeClassModel("rg3"), true, "rg3 -> Road Glide 3 is trike-class");
assert.equal(isTrikeClassModel("sg3"), true, "sg3 -> Street Glide 3 is trike-class");
assert.equal(isTrikeClassModel("fixed fairing"), false, "fixed fairing = two-wheel Road Glide group (not trike)");
assert.equal(isTrikeClassModel("bagger"), false, "bagger = two-wheel Touring group (not trike)");

console.log("PASS harley slang glossary eval");
