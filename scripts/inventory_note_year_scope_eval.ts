/**
 * Inventory-note model/year-scope guard eval (Joe ruling 2026-07-27, +15854890786).
 *
 * A unit's inventory note (e.g. the "$1,000 trade-in credit" that lives on the 2025 Breakout
 * stock, stock# s32-25 / s24-24) belongs to the UNIT it is listed under. The early-cadence
 * promotion builder (buildEarlyCadencePromotionOverride, index.ts) broadens the inventory lookup
 * across years when the exact year has no match (findInventoryMatches({year:null})), then narrates
 * the matched units' notes under a specific model-label ("2026 Breakout"). Without a guard, a 2025
 * unit's trade-in credit gets attached to a 2026 Breakout reply — the exact miss the operator
 * flagged. The guard drops any note whose unit year differs from the narrated year.
 *
 * Pins: the pure predicate (same-year surface / cross-year drop / no-year-claimed allow) and the
 * index.ts wiring (the builder consults the guard before surfacing a note). Wired into ci:eval.
 *
 * Run: npx tsx scripts/inventory_note_year_scope_eval.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  inventoryNoteMatchesNarratedYear,
  decideInventoryNoteUnitAttribution
} from "../services/api/src/domain/inventoryNotes.ts";

// Same year → surface the note (the credit belongs to this unit).
assert.equal(inventoryNoteMatchesNarratedYear("2025", "2025"), true, "same-year note surfaces");

// Cross-year → DROP (the exact +15854890786 miss: a 2025 credit on a 2026 reply).
assert.equal(
  inventoryNoteMatchesNarratedYear("2025", "2026"),
  false,
  "a 2025 unit's note is not surfaced for a 2026 narration"
);
assert.equal(inventoryNoteMatchesNarratedYear("2026", "2025"), false, "and the reverse is dropped too");

// No specific year claimed → not a cross-year misattribution → allowed.
assert.equal(inventoryNoteMatchesNarratedYear("2025", null), true, "no narrated year → allowed");
assert.equal(inventoryNoteMatchesNarratedYear("2025", ""), true, "blank narrated year → allowed");
assert.equal(inventoryNoteMatchesNarratedYear("2025", "  "), true, "whitespace narrated year → allowed");

// A narrated year with an unknown unit year cannot be confirmed same-year → DROP (fail-safe).
assert.equal(
  inventoryNoteMatchesNarratedYear(null, "2026"),
  false,
  "unknown unit year cannot confirm a match for a narrated year → dropped"
);
assert.equal(inventoryNoteMatchesNarratedYear(undefined, "2026"), false, "undefined unit year → dropped");

// Whitespace tolerance on the unit side.
assert.equal(inventoryNoteMatchesNarratedYear(" 2026 ", "2026"), true, "trims the unit year");

// --- Source guard: note selection lives in the domain module, and index.ts calls it ---
// (The loop moved out of index.ts under the source-size ratchet; the pins moved WITH it, so this
// still asserts against real code rather than silently passing on a file that no longer has it.)
const notesSrc = fs.readFileSync(path.resolve("services/api/src/domain/inventoryNotes.ts"), "utf8");
const indexSrc = fs.readFileSync(path.resolve("services/api/src/index.ts"), "utf8");
assert.match(
  notesSrc,
  /if \(!inventoryNoteMatchesNarratedYear\(item\?\.year \?\? null, args\.narratedYear\)\) continue;/,
  "collectCadenceInventoryNotes skips other-year units before surfacing a note"
);
assert.match(
  indexSrc,
  /const notes = await collectCadenceInventoryNotes\(\{/,
  "buildEarlyCadencePromotionOverride sources its notes through the guarded collector"
);
// The builder must NOT keep a second, unguarded note read of its own.
assert.equal(
  /getInventoryNote\(/.test(indexSrc),
  false,
  "index.ts no longer reads inventory notes directly — the collector owns the unit-scope policy"
);

// =====================================================================================
// Unit ATTRIBUTION when no year is narrated (Joe report 2026-08-01, +17736151296).
//
// The year guard above allows every unit when nothing claims a year — and the promotion builder
// deliberately claims no year for a USED lead. Mark Walsh asked about a 2017 USED Breakout
// (U590-17); the "$4,000 off list price" note lives on the NEW 2025 Breakouts (S9-25/S13-25), so
// the draft read "quick update on the Breakout: Save $4,000 off list price." Joe corrected it to
// "...on a new 2025 Breakout". A borrowed note must name the unit it lives on.
// =====================================================================================

// THE PRODUCTION TURN: new 2025 unit's note, used 2017 lead → attribute, do not narrate bare.
const walsh = decideInventoryNoteUnitAttribution({
  unitYear: "2025",
  unitCondition: "new",
  unitModel: "Breakout",
  leadYear: "2017",
  leadCondition: "used"
});
assert.equal(walsh.kind, "attribute", "+17736151296: a new 2025 unit's note on a used 2017 lead is attributed");
assert.equal(
  walsh.kind === "attribute" ? walsh.phrase : null,
  "a new 2025 Breakout",
  "the attribution names Joe's own correction: 'a new 2025 Breakout'"
);
// The rendered promo line matches the reply Joe actually sent.
assert.equal(
  `Save $4,000 off list price on ${walsh.kind === "attribute" ? walsh.phrase : ""}`,
  "Save $4,000 off list price on a new 2025 Breakout",
  "the composed note reads as Joe's sent correction"
);

// The lead's OWN unit keeps the bare copy — no regression in the ordinary case.
assert.deepEqual(
  decideInventoryNoteUnitAttribution({
    unitYear: "2025",
    unitCondition: "new",
    unitModel: "Breakout",
    leadYear: "2025",
    leadCondition: "new"
  }),
  { kind: "plain" },
  "the lead's own unit narrates plainly"
);

// Same year but a NEW/USED conflict is still a different bike → attribute.
assert.equal(
  decideInventoryNoteUnitAttribution({
    unitYear: "2025",
    unitCondition: "new",
    unitModel: "Breakout",
    leadYear: "2025",
    leadCondition: "used"
  }).kind,
  "attribute",
  "same year but new-vs-used is a different unit → attributed"
);

// An UNKNOWN lead year can never round up to "the customer's own bike" (fail-safe direction).
assert.equal(
  decideInventoryNoteUnitAttribution({
    unitYear: "2025",
    unitCondition: "new",
    unitModel: "Breakout",
    leadYear: null,
    leadCondition: null
  }).kind,
  "attribute",
  "unknown lead year → attributed, never assumed to be their unit"
);

// A unit we cannot describe (no year on the feed row) is DROPPED, not narrated bare.
assert.deepEqual(
  decideInventoryNoteUnitAttribution({
    unitYear: null,
    unitCondition: "new",
    unitModel: "Breakout",
    leadYear: "2017",
    leadCondition: "used"
  }),
  { kind: "drop" },
  "an undescribable borrowed unit drops the note rather than misattribute it"
);

// Unknown unit condition still attributes, just without the new/used word.
assert.equal(
  decideInventoryNoteUnitAttribution({
    unitYear: "2024",
    unitCondition: null,
    unitModel: "Road Glide",
    leadYear: "2017",
    leadCondition: "used"
  }).phrase ?? null,
  "a 2024 Road Glide",
  "unknown condition attributes by year+model only"
);

// --- Source guard: the collector attributes borrowed notes in the no-year branch ---
assert.match(
  notesSrc,
  /decideInventoryNoteUnitAttribution\(\{/,
  "collectCadenceInventoryNotes consults the unit-attribution decision"
);
assert.match(
  notesSrc,
  /if \(attribution\.kind === "drop"\) continue;/,
  "an undescribable borrowed unit is dropped, not narrated bare"
);

const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
assert.ok(
  String(pkg.scripts?.["ci:eval"] ?? "").includes("inventory_note_year_scope:eval"),
  "inventory_note_year_scope:eval is wired into ci:eval"
);

console.log(
  "PASS inventory-note year-scope guard eval (same-year surface / cross-year drop / no-year allow + unit attribution + wiring)"
);
