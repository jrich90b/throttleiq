/**
 * Watch year-pin eval. Pins `decideWatchYearPin`
 * (services/api/src/domain/watchYearPin.ts) so an inventory watch can never again be
 * created with a model year it could never match.
 *
 * Production repro (+18188420202, 2026-07-21): a Room58 ADF carried structured `Year: 2022`
 * but the free-text inquiry read "2027 883". Intake pinned a 2027 Iron 883 watch — a model
 * year that cannot exist (Iron 883 discontinued after 2020) — so the watch sat active and
 * un-fireable while the customer waited on "I'll text you if one comes in".
 *
 * The guard's whole safety argument is its fail direction: dropping a pin only WIDENS the
 * watch (year_model -> model_only), so the failure mode is "contacted about more units",
 * never "contacted about fewer". These cases pin both halves — that impossible pins drop,
 * and that everything else (older years, current models, unknown status) keeps its pin.
 * Dealer-agnostic.
 */
import assert from "node:assert/strict";
import {
  decideWatchYearPin,
  decideWatchConditionPin,
  MAX_MODEL_YEAR_LOOKAHEAD
} from "../services/api/src/domain/watchYearPin.ts";

const NOW = 2026; // fixed "current year" so the eval is deterministic forever

assert.equal(MAX_MODEL_YEAR_LOOKAHEAD, 1, "model years may run one year ahead of the calendar");

// ── THE PRODUCTION MISS: 2027 Iron 883. Model confidently discontinued, requested year is
//    the current model year or later => that unit can never exist => drop the pin.
const repro = decideWatchYearPin({ year: 2027, modelStatus: "discontinued", currentYear: NOW });
assert.equal(repro.pin, "none", "a post-discontinuation model year must not be pinned");
assert.equal(repro.reason, "year_after_model_discontinued");

// ── The other impossible case: no such model year exists yet, for ANY model.
assert.equal(
  decideWatchYearPin({ year: 2035, modelStatus: "current", currentYear: NOW }).pin,
  "none",
  "a year far beyond the next model year can never match"
);
assert.equal(
  decideWatchYearPin({ year: 2035, modelStatus: "current", currentYear: NOW }).reason,
  "year_beyond_max_model_year"
);

// ── KEEP the pin everywhere else. These are the regressions the guard must not cause.
// A used unit of a discontinued model absolutely still shows up — an older year stays pinned.
assert.equal(
  decideWatchYearPin({ year: 2015, modelStatus: "discontinued", currentYear: NOW }).pin,
  "year",
  "an older year on a discontinued model is still matchable (used units exist)"
);
// Next model year on a CURRENT model is plausible (2027 units land during 2026).
assert.equal(
  decideWatchYearPin({ year: 2027, modelStatus: "current", currentYear: NOW }).pin,
  "year",
  "next model year on a current model must keep its pin"
);
// Conservative like decideModelDiscontinuation: only a CONFIDENT "discontinued" may drop a pin.
for (const status of ["unknown", "current", "available"] as const) {
  assert.equal(
    decideWatchYearPin({ year: 2027, modelStatus: status, currentYear: NOW }).pin,
    "year",
    `status "${status}" must never drop a year pin (only a confident discontinued may)`
  );
}

// ── Ranges. Only a range whose EARLIEST year is already unreachable is dropped; a
//    partially-valid range keeps its precision rather than widening to model_only.
assert.equal(
  decideWatchYearPin({ yearMin: 2015, yearMax: 2020, modelStatus: "discontinued", currentYear: NOW }).pin,
  "range",
  "a fully-historic range on a discontinued model is matchable"
);
assert.equal(
  decideWatchYearPin({ yearMin: 2015, yearMax: 2027, modelStatus: "discontinued", currentYear: NOW }).pin,
  "range",
  "a partially-valid range keeps its pin (do not widen a still-matchable watch)"
);
const deadRange = decideWatchYearPin({
  yearMin: 2027,
  yearMax: 2030,
  modelStatus: "discontinued",
  currentYear: NOW
});
assert.equal(deadRange.pin, "none", "a range entirely after discontinuation can never match");
assert.equal(deadRange.reason, "range_after_model_discontinued");
assert.equal(
  decideWatchYearPin({ yearMin: 2030, yearMax: 2035, modelStatus: "current", currentYear: NOW }).pin,
  "none",
  "a range beyond the next model year can never match"
);

// ── No year / junk year => nothing to pin (model_only), never a fabricated pin.
for (const bad of [null, undefined, 0, -1, Number.NaN] as const) {
  const d = decideWatchYearPin({ year: bad as number | null, modelStatus: "current", currentYear: NOW });
  assert.equal(d.pin, "none", `junk year ${String(bad)} must not produce a pin`);
  assert.equal(d.reason, "no_year_requested");
}

// ── Structural invariant: the decision never invents a pin the caller didn't ask for.
assert.equal(
  decideWatchYearPin({ yearMin: 2015, yearMax: 2020, modelStatus: "current", currentYear: NOW }).pin,
  "range",
  "a range request never resolves to a single-year pin"
);
assert.equal(
  decideWatchYearPin({ year: 2019, modelStatus: "current", currentYear: NOW }).pin,
  "year",
  "a single-year request never resolves to a range pin"
);

// ── CONDITION pin. A `new` watch only fires on a brand-new unit; a model no longer made can
//    never produce one, so a `new` pin on a confidently-discontinued model is un-fireable and
//    must widen to any-condition. Production miss +17166887637 (a `new` Super Glide watch).
const superGlide = decideWatchConditionPin({ condition: "new", modelStatus: "discontinued" });
assert.equal(superGlide.pin, "none", "a `new` pin on a discontinued model can never fire");
assert.equal(superGlide.reason, "new_pin_on_discontinued_model");

// KEEP the pin everywhere else — same conservatism as the year guard.
// `used` on a discontinued model is exactly what we WANT to keep (used units still show up).
assert.equal(
  decideWatchConditionPin({ condition: "used", modelStatus: "discontinued" }).pin,
  "condition",
  "a used-condition watch on a discontinued model is still matchable"
);
// Only a CONFIDENT discontinued may drop a `new` pin.
for (const status of ["unknown", "current", "available"] as const) {
  assert.equal(
    decideWatchConditionPin({ condition: "new", modelStatus: status }).pin,
    "condition",
    `status "${status}" must never drop a new-condition pin`
  );
}
// No/blank/junk condition => nothing to pin (never a fabricated condition).
for (const bad of [null, undefined, "", "  ", "any"] as const) {
  const d = decideWatchConditionPin({ condition: bad, modelStatus: "discontinued" });
  assert.equal(d.pin, "none", `junk condition ${JSON.stringify(bad)} produces no pin`);
  assert.equal(d.reason, "no_condition_requested");
}
// Case-insensitive.
assert.equal(
  decideWatchConditionPin({ condition: "NEW", modelStatus: "discontinued" }).pin,
  "none",
  "condition match is case-insensitive"
);

console.log(
  "PASS watch pin eval — impossible model years AND new-on-discontinued conditions widen; every matchable pin kept"
);
