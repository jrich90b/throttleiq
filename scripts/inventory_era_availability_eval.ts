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

// ─────────────────────────────────────────────────────────────────────────────
// The INITIAL-ADF answer path (routes/sendgridInbound.ts) — same invariant, second site.
//
// Production repro (+18188420202, George Khoury, 2026-07-21, msg_81c4856073a4f_1784615558882):
// Room58 ADF, structured `Year: 2022`, `Vehicle: Harley-Davidson Iron 883`, free-text
// `Inquiry: "2027 883"`. `resolveInitialAdfInventoryStatus` looks the model up WITH the year,
// finds nothing, retries with the year DROPPED, matches the lot's only 883 — a 2006 Sportster
// 883 Low — and rebuilds the reply label from that unit's year:
//   "Yes — the 2006 Sportster 883 Low is available right now."
// 21 years off the ask, and it reads to the customer as "yes, we have what you asked for".
// The guard below keeps only units that can honestly answer the requested year; when that
// leaves nothing the path falls through to its existing not_found branch, which answers with
// the REQUESTED label and offers to keep an eye out — the reply that actually shipped live.
const {
  decideAvailabilityAssertion,
  AVAILABILITY_YEAR_TOLERANCE
} = await import("../services/api/src/domain/availabilityAssertionGuard.ts");

assert.equal(AVAILABILITY_YEAR_TOLERANCE, 1, "a one-year gap still answers the question; wider does not");

// THE PRODUCTION MISS: a 2027 ask must never be answered by the 2006 on the lot.
assert.deepEqual(
  decideAvailabilityAssertion({ requestedYear: 2027, itemYear: 2006 }),
  { assert: false, reason: "item_year_outside_tolerance" },
  "a 2027 883 ask must NOT assert the 2006 Sportster 883 Low as available"
);
// The structured ADF year (2022) is just as wrong an answer as the free-text one.
assert.equal(
  decideAvailabilityAssertion({ requestedYear: 2022, itemYear: 2006 }).assert,
  false,
  "the ADF's structured 2022 must not be answered by a 2006 unit either"
);

// Regressions — everything that legitimately answers the ask must STILL assert.
assert.equal(
  decideAvailabilityAssertion({ requestedYear: 2022, itemYear: 2022 }).assert,
  true,
  "an exact-year match still answers"
);
assert.equal(
  decideAvailabilityAssertion({ requestedYear: 2022, itemYear: 2021 }).assert,
  true,
  "a one-year gap still answers (model years drift by one)"
);
assert.equal(
  decideAvailabilityAssertion({ requestedYear: 2022, itemYear: 2023 }).assert,
  true,
  "one year the other way still answers"
);
assert.deepEqual(
  decideAvailabilityAssertion({ itemYear: 2006 }),
  { assert: true, reason: "no_year_requested" },
  "a model-only ask ('any Road Glides?') is answered by any year — behavior preserved"
);

// Range asks reuse the same era semantics the SMS resolver already enforces above.
assert.equal(
  decideAvailabilityAssertion({ requestedYearMin: 2000, requestedYearMax: 2005, itemYear: 2006 }).assert,
  false,
  "an early-2000s ask is not answered by a 2006"
);
assert.equal(
  decideAvailabilityAssertion({ requestedYearMin: 2000, requestedYearMax: 2010, itemYear: 2006 }).assert,
  true,
  "a range that contains the unit still answers"
);
assert.equal(
  decideAvailabilityAssertion({ requestedYearMin: 2020, itemYear: 2006 }).assert,
  false,
  "'2020 or newer' is not answered by a 2006"
);

// An unverifiable year fails toward the honest miss, matching matchInRequestedEra above, which
// also drops unknown-year units once an era was asked for.
assert.equal(
  decideAvailabilityAssertion({ requestedYear: 2027, itemYear: null }).assert,
  false,
  "a unit with no known year cannot satisfy a year constraint"
);
assert.equal(
  decideAvailabilityAssertion({ itemYear: null }).assert,
  true,
  "with no year asked for, an unknown unit year is still fine"
);

// Source pins — the guard is actually WIRED into the initial-ADF resolver, and it runs BEFORE
// the in_stock assertion (a guard placed after the return would be dead code).
const adfSource = await fs.readFile(path.resolve("services/api/src/routes/sendgridInbound.ts"), "utf8");
assert.match(
  adfSource,
  /import \{ decideAvailabilityAssertion \} from "\.\.\/domain\/availabilityAssertionGuard\.js";/,
  "sendgridInbound must import the availability-assertion guard"
);
const resolverIdx = adfSource.indexOf("async function resolveInitialAdfInventoryStatus(");
assert.ok(resolverIdx > 0, "resolveInitialAdfInventoryStatus must exist");
const guardIdx = adfSource.indexOf("decideAvailabilityAssertion({", resolverIdx);
const inStockIdx = adfSource.indexOf('return { status: "in_stock", label: preferredLabel };', resolverIdx);
assert.ok(guardIdx > resolverIdx, "the guard must be called inside resolveInitialAdfInventoryStatus");
assert.ok(
  inStockIdx > guardIdx,
  "the guard must run BEFORE the in_stock assertion, or the off-year unit is already asserted"
);
// The year-less widening retry is the thing that makes the guard necessary; if it is ever
// removed the guard is harmless, but while it exists the guard must sit between it and the reply.
const retryIdx = adfSource.indexOf("findInventoryMatches({ year: null, model: targetModel })", resolverIdx);
if (retryIdx > 0) {
  assert.ok(
    guardIdx > retryIdx,
    "the guard must run after the year-less retry that can widen the match off-year"
  );
}

console.log("PASS inventory era availability eval");
