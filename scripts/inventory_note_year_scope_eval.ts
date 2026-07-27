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
import { inventoryNoteMatchesNarratedYear } from "../services/api/src/domain/inventoryNotes.ts";

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

// --- Source guard: the cadence promotion builder consults the year-scope guard ---
const indexSrc = fs.readFileSync(path.resolve("services/api/src/index.ts"), "utf8");
assert.match(
  indexSrc,
  /if \(!inventoryNoteMatchesNarratedYear\(item\?\.year \?\? null, year \?\? null\)\) continue;/,
  "buildEarlyCadencePromotionOverride skips other-year units before surfacing a note"
);

const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
assert.ok(
  String(pkg.scripts?.["ci:eval"] ?? "").includes("inventory_note_year_scope:eval"),
  "inventory_note_year_scope:eval is wired into ci:eval"
);

console.log("PASS inventory-note year-scope guard eval (same-year surface / cross-year drop / no-year allow + wiring)");
