import { strict as assert } from "node:assert";

/**
 * watch_model_vin_codes:eval — stripLeadingVinCodes turns a VIN-decoded watch model string into its
 * friendly model name, and (critically) leaves real model names alone. Motivated by ~7 leads whose
 * watches carried VIN codes ("Xl1200x 1lc3 Forty-Eight", "Fxst Bhlf Softail Standard").
 */

const { stripLeadingVinCodes } = await import("../services/api/src/domain/watchModelVinCodes.ts");
const s = (m: string) => stripLeadingVinCodes(m);

// --- Garbage the field actually held → cleaned to the friendly model ---
assert.equal(s("Xl1200x 1lc3 Forty-Eight"), "Forty-Eight");
assert.equal(s("Xl1200x 1ln3 Anx Forty-Eight Anniversary"), "Anx Forty-Eight Anniversary"); // Anx is not a VIN code; anniversary handled elsewhere
assert.equal(s("Fxst Bhlf Softail Standard"), "Softail Standard");
assert.equal(s("Fxst Bhll Softail Standard"), "Softail Standard");
assert.equal(s("Fxsts Bllj Softail Springer"), "Softail Springer");
assert.equal(s("Fxstc Bkll Softail Custom"), "Softail Custom");
assert.equal(s("Flstf Bmll Softail Fat Boy"), "Softail Fat Boy");
assert.equal(s("Flst Bjlg Softail Heritage"), "Softail Heritage");
assert.equal(s("Fxds_conv Ggvx Dyna Glide Convertible"), "Dyna Glide Convertible"); // underscore code + vowelless code
assert.equal(s("1hha Vrscdx Night Rod Special"), "Night Rod Special");
assert.equal(s("1hda Vrscd Night Rod"), "Night Rod");
assert.equal(s("Xl1200c 1cgp Sportster 1200 Custom"), "Sportster 1200 Custom"); // keeps the meaningful 1200
assert.equal(s("Xl1200n 1cz3 Nightster"), "Nightster");
assert.equal(s("Flstsci 1byb Springer Classic"), "Springer Classic"); // Flstsci = FL-prefix code w/ vowel
assert.equal(s("Fxstsse2 1pt9 Cvo Softail Springer"), "Cvo Softail Springer"); // Fxstsse2 has digit; Cvo has a vowel → kept
assert.equal(s("Xl1200cx 1lm3 1200 Roadster"), "1200 Roadster"); // pure-digit 1200 is NOT a code → kept

// --- Real model names must be LEFT ALONE (fail-direction: never mangle a good watch) ---
for (const clean of [
  "Street Glide",
  "Road Glide",
  "Road Glide 3",
  "Street Glide 3 Limited",
  "CVO Road Glide ST",
  "Fat Boy",
  "Iron 883",
  "Iron 1200",
  "Sportster 1200 Custom",
  "Pan America 1250 ST",
  "Low Rider S",
  "103 Softail Slim", // engine-size prefix 103 is pure-digit, not a VIN code
  "Softail Slim",
  "Nightster",
  "Tri Glide",
  "Heritage Softail Classic",
  "1200 Roadster"
]) {
  assert.equal(s(clean), clean, `real model must be untouched: ${clean}`);
}

// --- Code-shaped real model NAMES that are a single token must survive (never stripped to empty) ---
assert.equal(s("XG500"), "XG500", "XG500 is a real model (Street 500), not a strippable prefix");
assert.equal(s("XG750"), "XG750", "XG750 survives — last/only token is never stripped");
assert.equal(s("Sportster S"), "Sportster S");

// --- Edge cases ---
assert.equal(s(""), "");
assert.equal(s("   "), "");
assert.equal(s(null as any), "");
assert.equal(s("Fxst"), "Fxst", "a lone VIN code with nothing after is kept (never empty) — better an odd label than none");

// --- normalizeWatchModelsVin: clean in place + collapse the duplicates cleaning creates ---
const { normalizeWatchModelsVin } = await import("../services/api/src/domain/watchModelVinCodes.ts");

// Peter/+17169974120 shape: six VIN variants of one real model collapse to one.
{
  const six = [
    { model: "Fxst Bhlf Softail Standard", condition: "used", minPrice: 7000, maxPrice: 8000 },
    { model: "Fxst Bhlg Softail Standard", condition: "used", minPrice: 7000, maxPrice: 8000 },
    { model: "Fxst Bhlh Softail Standard", condition: "used", minPrice: 7000, maxPrice: 8000 },
    { model: "Fxst Bhlj Softail Standard", condition: "used", minPrice: 7000, maxPrice: 8000 },
    { model: "Fxst Bhlk Softail Standard", condition: "used", minPrice: 7000, maxPrice: 8000 },
    { model: "Fxst Bhll Softail Standard", condition: "used", minPrice: 7000, maxPrice: 8000 }
  ];
  const { watches, changedModels, removedDuplicates } = normalizeWatchModelsVin(six as any);
  assert.equal(changedModels, 6, "all six models were VIN-decoded and got cleaned");
  assert.equal(watches.length, 1, "…and collapse to a single 'Softail Standard' watch");
  assert.equal(watches[0].model, "Softail Standard");
  assert.equal(removedDuplicates, 5);
}

// A notify record survives the collapse (never re-notify a unit already sent).
{
  const dupes = [
    { model: "Fxst Bhlf Softail Standard", condition: "used" },
    { model: "Softail Standard", condition: "used", lastNotifiedAt: "2026-06-01T00:00:00Z" }
  ];
  const { watches } = normalizeWatchModelsVin(dupes as any);
  assert.equal(watches.length, 1, "the cleaned garbage + the real one collapse");
  assert.equal(watches[0].lastNotifiedAt, "2026-06-01T00:00:00Z", "survivor keeps the notify record");
}

// Distinct real models are NOT merged, and clean watches are untouched (fail-safe: no spurious change).
{
  const mixed = [
    { model: "Street Glide", condition: "used" },
    { model: "Road Glide", condition: "new" },
    { model: "Xl1200x 1lc3 Forty-Eight", condition: "used" }
  ];
  const { watches, changedModels, removedDuplicates } = normalizeWatchModelsVin(mixed as any);
  assert.equal(changedModels, 1, "only the VIN-coded Forty-Eight changed");
  assert.equal(removedDuplicates, 0, "distinct models are not merged");
  assert.deepEqual(watches.map(w => w.model).sort(), ["Forty-Eight", "Road Glide", "Street Glide"]);
}

// All-clean input is a genuine no-op.
{
  const clean = [{ model: "Street Glide", condition: "used" }, { model: "Iron 883", condition: "used" }];
  const r = normalizeWatchModelsVin(clean as any);
  assert.equal(r.changedModels, 0);
  assert.equal(r.removedDuplicates, 0);
}

// --- stripLeadingMakeName: a glued make prefix comes off; real models are never touched (2026-07-23) ---
const { stripLeadingMakeName, stripWatchModelJunkTokens } = await import("../services/api/src/domain/watchModelVinCodes.ts");
assert.equal(stripLeadingMakeName("HARLEY-DAVIDSON Street Glide"), "Street Glide", "the +17165600980 held-guard watch shape");
assert.equal(stripLeadingMakeName("Harley Davidson Road Glide"), "Road Glide");
assert.equal(stripLeadingMakeName("harley-davidson Tri Glide Ultra"), "Tri Glide Ultra");
assert.equal(stripLeadingMakeName("Harley Fat Boy"), "Fat Boy");
assert.equal(stripLeadingMakeName("HD Street Bob"), "Street Bob");
assert.equal(stripLeadingMakeName("Harley-Davidson"), "Harley-Davidson", "a label that IS just the make stays (never empty)");
for (const clean of ["Street Glide", "Heritage Softail Classic", "Hydra-Glide", "Road Glide 3", "Low Rider S", "Iron 883"]) {
  assert.equal(stripLeadingMakeName(clean), clean, `real model untouched by make-strip: ${clean}`);
}
assert.equal(stripLeadingMakeName(""), "");
assert.equal(stripLeadingMakeName(null as any), "");

// --- stripWatchModelJunkTokens (AUDIT-only specificity comparison): make + OEM/paint codes anywhere ---
assert.equal(stripWatchModelJunkTokens("Flhtcutg 1mad Tri Glide Ultra"), "Tri Glide Ultra", "the +17166021492 feed-line watch shape");
assert.equal(stripWatchModelJunkTokens("Flhtcutg 1maf Tri Glide Ultra"), "Tri Glide Ultra");
assert.equal(stripWatchModelJunkTokens("HARLEY-DAVIDSON Street Glide"), "Street Glide");
assert.equal(stripWatchModelJunkTokens("Flhtcutg"), "Flhtcutg", "a lone code never strips to empty");
for (const clean of ["Street Glide Special", "CVO Street Glide", "Road Glide Limited", "Tri Glide Ultra", "Electra Glide Ultra Classic", "Iron 883"]) {
  assert.equal(stripWatchModelJunkTokens(clean), clean, `real trim words survive the junk filter: ${clean}`);
}

// --- Source guards: the write-time chokepoint + the raw followup-action path are wired ---
{
  const fs = await import("node:fs");
  const idx = fs.readFileSync("services/api/src/index.ts", "utf8");
  assert.match(
    idx,
    /stripLeadingVinCodes\(stripLeadingMakeName\(/,
    "canonicalizeWatchModelLabel strips a glued make prefix before VIN codes (write-time fix for the held-guard path)"
  );
  const canonicalized = idx.match(/const model = canonicalizeWatchModelLabel\(item\?\.model\);/g) || [];
  assert.ok(
    canonicalized.length >= 2,
    `the followup-action buildWatchList must canonicalize item.model like the /watch endpoint (found ${canonicalized.length}, need >= 2)`
  );
}

console.log("PASS watch_model_vin_codes eval — VIN codes stripped to the friendly model; real names untouched; in-place normalize + dedup; make/OEM junk never fakes specificity");
