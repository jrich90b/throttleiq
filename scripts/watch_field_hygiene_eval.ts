/**
 * Inventory-watch field hygiene eval (Joe ruling, 2026-07-22 #3 — +17167992882).
 *
 * Staff reported a watch that "will never trigger". They were right: "Special" had landed in the
 * watch's `trim` field and the Traffic-Log-Pro step tag "(Step 2)" in its `color`. The matcher
 * tests `trim` against the unit's MODEL string and `color` against the unit's COLOR, so
 * `"road glide".includes("special")` and `"vivid black".includes("step 2")` are both permanently
 * false — the watch looks active in the console and can never fire.
 *
 * These fixtures pin the two repairs and, just as importantly, pin what must NOT happen: the
 * model word is FOLDED INTO the model label, never deleted. Deleting it would widen the watch to
 * every base Road Glide and re-create the wrong-model notification class the matcher guards fix.
 *
 * Run: npx tsx scripts/watch_field_hygiene_eval.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  sanitizeWatchColorValue,
  dropUnstockedWatchColor,
  foldModelWordTrimIntoModel,
  applyWatchFieldHygiene,
  formatWatchYearLabel
} from "../services/api/src/domain/watchFieldHygiene.ts";
import {
  unitColorCarriesStated,
  narrowUnitsByColorFinish
} from "../services/api/src/domain/inventoryFeed.ts";

// --- Colour: the production junk, and the colours that must survive it -----------------------
assert.equal(sanitizeWatchColorValue("(Step 2)"), undefined, "the TLP step tag must never be stored as a colour (+17167992882)");
assert.equal(sanitizeWatchColorValue("Step 6"), undefined, "a bare step marker is a step marker, not a colour");
assert.equal(sanitizeWatchColorValue("step 9"), undefined, "case-insensitive");
assert.equal(sanitizeWatchColorValue("(Vivid Black)"), undefined, "bracketed values are lifted form fields, not colours");
assert.equal(sanitizeWatchColorValue("T10-26"), undefined, "a stock number is not a colour");
assert.equal(sanitizeWatchColorValue(""), undefined, "empty stays empty");
assert.equal(sanitizeWatchColorValue(null), undefined, "null stays empty");
assert.equal(sanitizeWatchColorValue("Vivid Black"), "Vivid Black", "a real colour survives");
assert.equal(sanitizeWatchColorValue("Dark Billiard Gray"), "Dark Billiard Gray", "a real multi-word colour survives (+17165981862)");
assert.equal(sanitizeWatchColorValue("black trim"), "black trim", "a finish phrase survives — that is a separate, still-open class");
assert.equal(sanitizeWatchColorValue("Olive Steel Metallic"), "Olive Steel Metallic", "a real metallic colour survives");

// --- Trim: a model word belongs in the MODEL, not the trim ----------------------------------
assert.deepEqual(
  foldModelWordTrimIntoModel({ model: "Road Glide", trim: "special" }),
  { model: "Road Glide Special", trim: undefined },
  "'Special' moves into the model label so the watch keeps the customer's specificity (+17167992882)"
);
assert.deepEqual(
  foldModelWordTrimIntoModel({ model: "Road Glide Special", trim: "special" }),
  { model: "Road Glide Special", trim: undefined },
  "a redundant model-word trim is dropped, not doubled — it was blocking every match on its own"
);
assert.deepEqual(
  foldModelWordTrimIntoModel({ model: "Street Glide", trim: "CVO" }),
  { model: "Street Glide CVO", trim: undefined },
  "CVO is a distinct model, not a trim"
);
assert.deepEqual(
  foldModelWordTrimIntoModel({ model: "Electra Glide", trim: "ultra classic" }),
  { model: "Electra Glide Ultra Classic", trim: undefined },
  "a multi-word model-word trim folds whole"
);
assert.deepEqual(
  foldModelWordTrimIntoModel({ model: "Road Glide", trim: "chrome" }),
  { model: "Road Glide", trim: "chrome" },
  "a FINISH trim is left exactly as-is — out of scope here"
);
assert.deepEqual(
  foldModelWordTrimIntoModel({ model: "Road Glide", trim: "black trim" }),
  { model: "Road Glide", trim: "black trim" },
  "'black trim' is a finish, not a model word"
);
assert.deepEqual(
  foldModelWordTrimIntoModel({ model: "Road Glide", trim: "" }),
  { model: "Road Glide", trim: undefined },
  "no trim, no change"
);
assert.deepEqual(
  foldModelWordTrimIntoModel({ model: "", trim: "special" }),
  { model: undefined, trim: undefined },
  "a model word with no model to attach it to is not a watchable target on its own"
);

// --- The reported record, end to end --------------------------------------------------------
const repaired = applyWatchFieldHygiene({
  model: "Road Glide",
  trim: "special",
  color: "(Step 2)",
  year: 2024
} as any);
assert.equal(repaired.model, "Road Glide Special", "the reported watch keeps its specificity");
assert.equal(repaired.trim, undefined, "…in the model, not the unmatchable trim slot");
assert.equal(repaired.color, undefined, "…and the step tag is gone");
assert.equal((repaired as any).year, 2024, "unrelated fields are untouched");

// --- Wiring: every direct watch-write path applies the repair --------------------------------
const idx = fs.readFileSync("services/api/src/index.ts", "utf8");
assert.match(idx, /const watch = applyWatchFieldHygiene\(watchRaw\);/, "the shared applyInventoryWatchConfirmation choke point must apply hygiene");
assert.match(idx, /applyInventoryWatchConfirmation\(\s*conv: Conversation,\s*watchRaw: InventoryWatch/, "…on the raw watch it was handed");
const sg = fs.readFileSync("services/api/src/routes/sendgridInbound.ts", "utf8");
// The Traffic Log Pro walk-in path (which produced the reported record) must apply hygiene. Pinned
// by ORDERING rather than by the exact call expression: the source pin broke the moment a second
// repair was chained onto the same value, which is drift the assertion should survive, not punish.
assert.notEqual(
  sg.indexOf("const hygienicWalkInWatch"),
  -1,
  "the walk-in watch still routes through a hygiene step before it is armed"
);
const walkInHygieneAt = sg.indexOf("const hygienicWalkInWatch");
assert.ok(
  walkInHygieneAt < sg.indexOf("applyInventoryWatchArm(conv, {", walkInHygieneAt),
  "hygiene runs before the walk-in watch is armed"
);
assert.match(sg, /const hygienicWatch = applyWatchFieldHygiene\(watch\);/, "the semantic/inventory-entity path writes directly too and must apply hygiene");

// --- Year label: a one-year "range" is one year (2026-07-28 replay sweep) ---------------------
// `extractYearRangeFromText` returns {min, max} for ANY text carrying two 20xx years, and an ADF
// repeats its year as a matter of course ("Year: 2026 … 2026 Sportster S"), so {2026, 2026} is the
// ordinary shape. Printed raw it reached the customer as "a 2026-2026 Sportster S".
assert.equal(
  formatWatchYearLabel({ yearMin: 2026, yearMax: 2026 }),
  "2026",
  "a range whose ends are equal is ONE year — the production defect (Sanjeev Goms 08610167776, Justin Holmes +16785960725)"
);
assert.equal(formatWatchYearLabel({ yearMin: "2026", yearMax: "2026" }), "2026", "…string-typed bounds collapse too");
assert.equal(
  formatWatchYearLabel({ yearMin: 2017, yearMax: 2020 }),
  "2017-2020",
  "a REAL range still prints as a range — the customer's specificity survives"
);
assert.equal(formatWatchYearLabel({ yearMin: 2020, yearMax: 2017 }), "2017-2020", "an inverted range is ordered, never printed backwards");
assert.equal(formatWatchYearLabel({ year: 2024 }), "2024", "a single year wins when it is set, as before");
assert.equal(
  formatWatchYearLabel({ year: 2024, yearMin: 2017, yearMax: 2020 }),
  "2024",
  "…and still outranks a range on the watch record itself (unchanged precedence)"
);
assert.equal(
  formatWatchYearLabel({ yearMin: 2019, yearMax: null }),
  "",
  "a half-open bound stays UNLABELLED — printing '2019' alone would claim an exact year the watch never asked for"
);
assert.equal(formatWatchYearLabel({ yearMin: null, yearMax: 2022 }), "", "…either side");
assert.equal(formatWatchYearLabel({}), "", "no year constraint, no label");

// --- Year label: a PLACEHOLDER year is not a year (production draft, 2026-08-04) --------------
// `year: 0` is how the watch-creation paths spell "the customer named no year", but `String(0)` is
// a non-empty string, so the old non-blank test printed it. Joshua Ricksgers (+17162512324) was
// drafted "I'll keep an eye out for 0 Street Glide Special in silver flux/black fuse" off a watch
// whose own exactness read `model_only` — the record said no-year while the sentence claimed one.
assert.equal(
  formatWatchYearLabel({ year: 0 }),
  "",
  "year 0 is the no-year placeholder, never a label — the production defect (+17162512324, msg at 2026-08-04T17:15:25.890Z)"
);
assert.equal(formatWatchYearLabel({ year: "0" }), "", "…string-typed placeholder too");
assert.equal(formatWatchYearLabel({ year: NaN }), "", "NaN is not a year");
assert.equal(formatWatchYearLabel({ year: "unknown" }), "", "…nor is unparseable prose");
assert.equal(formatWatchYearLabel({ year: 1899 }), "", "…nor a number below the plausible floor");
assert.equal(formatWatchYearLabel({ year: 20261 }), "", "…nor a mistyped/overlong year");
// The placeholder must not poison a range the watch legitimately carries.
assert.equal(
  formatWatchYearLabel({ year: 0, yearMin: 2019, yearMax: 2021 }),
  "2019-2021",
  "a placeholder single-year falls THROUGH to the real range instead of printing '0'"
);
assert.equal(formatWatchYearLabel({ yearMin: 0, yearMax: 2021 }), "", "a placeholder bound makes the range half-open ⇒ unlabelled");
// Guard the guard: real years must be untouched by the plausibility check.
assert.equal(formatWatchYearLabel({ year: 1903 }), "1903", "the floor is loose on purpose — a real old year still labels");
assert.equal(formatWatchYearLabel({ year: "2026" }), "2026", "…and the ordinary string-typed year is unchanged");

// --- Wiring: no customer-facing path may hand-roll the range again ---------------------------
assert.doesNotMatch(
  idx,
  /\$\{watch\.yearMin\}-\$\{watch\.yearMax\}/,
  "index.ts must render watch years through formatWatchYearLabel, never a raw min-max template"
);
assert.match(idx, /formatWatchYearLabel/, "…and must actually import/use it");
assert.doesNotMatch(
  sg,
  /\$\{yearRange\.min\}-\$\{yearRange\.max\}/,
  "the walk-in watch label must go through formatWatchYearLabel"
);
assert.doesNotMatch(
  sg,
  /\$\{customerYearRange\.min\}-\$\{customerYearRange\.max\}/,
  "the initial-ADF unavailable-inventory reply (where '2026-2026 Sportster S' shipped) must go through formatWatchYearLabel"
);
// The internal watch_fire_miss REPORT is deliberately out of scope: it renders half-open bounds
// ("2019-") on purpose for triage and is never read by a customer.

// --- A colour NOTHING in stock carries must not silence the model match (+17168609581) -------
// The mirror of #494's price-lane guard (narrowUnitsByColorFinish: "a colour we do not stock
// degrades to the model's honest range rather than to silence"). The availability/watch lane never
// got the equivalent, so a watch for a BLUE Road Glide 3 was armed against the three we actually
// had — and the matcher hard-rejects on colour, so it could never fire.
// The real feed rows on 2026-08-04, as a local fixture (never the live dealer feed — a universal
// eval may not assert a dealer fact).
const ROAD_GLIDE_3_UNITS = [
  { color: "Iron Horse Metallic" },
  { color: "Dark Billiard Gray" },
  { color: "Vivid Black" }
];
// One definition of colour equality, shared with the price lane rather than re-invented here.
const carries = (unitColor: string, wantedColor: string) =>
  unitColorCarriesStated(unitColor, { color: wantedColor });

assert.equal(
  dropUnstockedWatchColor({ model: "Road Glide 3", color: "blue" }, ROAD_GLIDE_3_UNITS, carries).color,
  undefined,
  "the +17168609581 watch degrades to model-only, which can fire, instead of exact-colour, which cannot"
);
assert.equal(
  dropUnstockedWatchColor({ model: "Road Glide 3", color: "blue" }, ROAD_GLIDE_3_UNITS, carries).model,
  "Road Glide 3",
  "…and the model constraint still bounds it — the guard is colour-only"
);
// SUBTRACTIVE ONLY: a colour we DO stock is never touched. Widening one would hand the customer a
// bike in the wrong paint, which is a worse failure than the one being fixed.
for (const stocked of ["Vivid Black", "vivid black", "black", "Dark Billiard Gray", "iron horse metallic"]) {
  assert.equal(
    dropUnstockedWatchColor({ model: "Road Glide 3", color: stocked }, ROAD_GLIDE_3_UNITS, carries).color,
    stocked,
    `a colour we stock is preserved exactly as written: ${stocked}`
  );
}
// FAIL DIRECTION: an empty or failed feed read is NOT evidence of absence. Stripping a real
// customer constraint because we could not see the inventory is the fail-unsafe direction.
assert.equal(
  dropUnstockedWatchColor({ model: "Road Glide 3", color: "blue" }, [], carries).color,
  "blue",
  "an unread feed preserves the colour — 'I could not look' is not 'we have none'"
);
assert.equal(
  dropUnstockedWatchColor({ model: "Road Glide 3", color: "blue" }, [{ color: "" }, { color: null }], carries).color,
  undefined,
  "units with no colour recorded cannot vouch for a colour"
);
// A watch with no colour is returned untouched — nothing to decide.
assert.equal(
  dropUnstockedWatchColor({ model: "Road Glide 3", color: undefined }, ROAD_GLIDE_3_UNITS, carries).color,
  undefined,
  "no stated colour => nothing to drop"
);
// The extraction that let both lanes share one rule must stay behaviour-identical for the price
// lane: a colour matching no unit still returns the UNNARROWED set, never an empty one.
assert.equal(
  narrowUnitsByColorFinish([...ROAD_GLIDE_3_UNITS], { color: "blue" }).length,
  3,
  "#494's fail direction is intact: an unstocked colour never narrows the price set to nothing"
);
assert.equal(
  narrowUnitsByColorFinish([...ROAD_GLIDE_3_UNITS], { color: "Vivid Black" }).length,
  1,
  "…and a stocked colour still pins the one bike"
);

// WIRING: the walk-in watch arm must run the guard, and must run it AFTER the field hygiene that
// strips junk shapes — otherwise "(Step 2)" reaches the colour comparison as a real colour.
const hygieneAt = sg.indexOf("applyWatchFieldHygiene(watch)");
const dropAt = sg.indexOf("dropUnstockedWatchColor(");
const armAt = sg.indexOf("applyInventoryWatchArm(conv, {", dropAt);
const matchesAt = sg.indexOf("modelLabelMatches = matches");
for (const [label, at] of [
  ["applyWatchFieldHygiene(watch)", hygieneAt],
  ["dropUnstockedWatchColor", dropAt],
  ["applyInventoryWatchArm", armAt],
  ["modelLabelMatches", matchesAt]
] as [string, number][]) {
  assert.notEqual(at, -1, `the walk-in watch arm must still contain ${label}`);
}
assert.ok(matchesAt < dropAt, "the stock lookup resolves before the guard that reads it");
assert.ok(dropAt < armAt, "the colour is settled before the watch is armed, not after");
assert.ok(hygieneAt <= dropAt, "junk shapes are stripped before a colour is compared against the feed");

console.log("PASS watch field hygiene eval — TLP step tags never land in colour; a model word folds into the model label instead of dead-ending the trim slot; a one-year range prints as one year; a colour no matched unit carries degrades to a model-only watch instead of one that can never fire.");
