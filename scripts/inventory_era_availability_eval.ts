/**
 * Inventory era/decade availability eval. Production fixture: +17168648467,
 * 2026 — "Any early 2000s lowriders?" drew a list of current-year (2023–2026)
 * Low Rider units as if they satisfied the early-2000s ask. Root cause was a
 * dropped era constraint in three places:
 *   1. AvailabilityParseHint carried no yearMin/yearMax,
 *   2. inventoryEntityParseToAvailabilityHint never copied the range the parser
 *      already emits,
 *   3. resolveDeterministicAvailabilityReply had no era concept, so it listed
 *      off-era inventory under "We have N units in stock right now."
 *
 * Fix (parser-first + a deterministic backstop): the entity parser maps era
 * phrasing into year_min/year_max, the hint threads it through, and the shared
 * resolver keeps only in-era matches — acknowledging an era miss instead of
 * fabricating a match. Both reply paths call the shared resolver, so the guard
 * rides live + regen. This eval pins all three layers + the filter behavior with
 * no network.
 */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";

const apiSource = await fs.readFile(path.resolve("services/api/src/index.ts"), "utf8");

// Source pins — layer 1: the hint type carries the era range.
assert.match(
  apiSource,
  /type AvailabilityParseHint = \{[\s\S]*?yearMin\?: number \| null;[\s\S]*?yearMax\?: number \| null;[\s\S]*?\};/,
  "AvailabilityParseHint must carry yearMin/yearMax"
);

// Source pins — layer 2: the entity→hint mapper copies the range.
assert.match(
  apiSource,
  /yearMin: typeof parsed\?\.yearMin === "number" \? parsed\.yearMin : null,/,
  "inventoryEntityParseToAvailabilityHint must copy yearMin"
);
assert.match(
  apiSource,
  /yearMax: typeof parsed\?\.yearMax === "number" \? parsed\.yearMax : null,/,
  "inventoryEntityParseToAvailabilityHint must copy yearMax"
);

// Source pins — layer 3: the resolver has the era guard, and it early-returns the
// era-miss acknowledgement BEFORE the "units in stock right now" listing branch.
const hasEraGuardIdx = apiSource.indexOf("const hasEraConstraint = eraMin != null || eraMax != null;");
assert.ok(hasEraGuardIdx > 0, "resolver must derive hasEraConstraint from the era range");
const eraMissReplyIdx = apiSource.indexOf("I’m not seeing any ${modelEraLabel} in stock right now.");
assert.ok(eraMissReplyIdx > hasEraGuardIdx, "resolver must build the era-miss acknowledgement reply");
const unitsInStockIdx = apiSource.indexOf("units in stock right now. ${multiListText}");
assert.ok(
  unitsInStockIdx > 0 && eraMissReplyIdx < unitsInStockIdx,
  "the era-miss early return must precede the multi-unit 'in stock right now' branch"
);

// Behavioral copy — the in-era filter mirrored from resolveDeterministicAvailabilityReply.
function matchInRequestedEra(
  itemYear: number,
  eraMin: number | null,
  eraMax: number | null
): boolean {
  const iy = Number(itemYear);
  if (!Number.isFinite(iy)) return false;
  if (eraMin != null && iy < eraMin) return false;
  if (eraMax != null && iy > eraMax) return false;
  return true;
}

// Production case: early-2000s ask (2000–2005) against 2023–2026 Low Rider stock
// yields ZERO in-era matches → we acknowledge the miss, never list off-era units.
const STOCK_YEARS = [2023, 2024, 2025, 2026];
const earlyEra = { min: 2000, max: 2005 };
const inEraEarly = STOCK_YEARS.filter(y => matchInRequestedEra(y, earlyEra.min, earlyEra.max));
assert.equal(
  inEraEarly.length,
  0,
  "early-2000s request must find ZERO in-era matches in 2023–2026 stock (era miss, not a listing)"
);

// "2015 or older" (open low end) against the same stock is also an era miss.
const olderEra = { min: null as number | null, max: 2015 };
const inEraOlder = STOCK_YEARS.filter(y => matchInRequestedEra(y, olderEra.min, olderEra.max));
assert.equal(inEraOlder.length, 0, "'2015 or older' finds zero matches in 2023–2026 stock");

// A range that DOES overlap keeps only the in-era units (no over-filtering).
const overlapEra = { min: 2024, max: 2025 };
const inEraOverlap = STOCK_YEARS.filter(y => matchInRequestedEra(y, overlapEra.min, overlapEra.max));
assert.deepEqual(inEraOverlap, [2024, 2025], "an overlapping era keeps only the in-era units");

// No era constraint (both null) must pass every unit through unchanged.
const inEraNone = STOCK_YEARS.filter(y => matchInRequestedEra(y, null, null));
assert.deepEqual(inEraNone, STOCK_YEARS, "no era constraint leaves matches untouched");

// The era label wording stays factual (mirrors formatRequestedEraLabel).
function formatRequestedEraLabel(yearMin: number | null, yearMax: number | null): string {
  if (yearMin != null && yearMax != null) {
    return yearMin === yearMax ? String(yearMin) : `${yearMin}–${yearMax}`;
  }
  if (yearMax != null) return `${yearMax}-or-older`;
  if (yearMin != null) return `${yearMin}-or-newer`;
  return "";
}
assert.equal(formatRequestedEraLabel(2000, 2005), "2000–2005", "range label reads as a span");
assert.equal(formatRequestedEraLabel(null, 2015), "2015-or-older", "open low end reads as -or-older");
assert.equal(formatRequestedEraLabel(2020, null), "2020-or-newer", "open high end reads as -or-newer");

console.log("PASS inventory era availability eval");
