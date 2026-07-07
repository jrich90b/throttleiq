/**
 * Watch model-match directionality eval.
 *
 * A watch match must be DIRECTIONAL: the in-stock UNIT's model must contain the WATCHED model, never the
 * reverse. The bug (Jason, 6/26): the engine's matcher was bidirectional, so a trim-specific watch fired on
 * a base unit — a "Street Glide Special" watch matched a base 2013 "Street Glide"; "Electra Glide Ultra
 * Classic" matched an "Ultra Limited". A base/family watch still matches a more-specific unit; a specific
 * watch only matches a unit that includes that specificity.
 *
 * Layer 1 — behavior via the exported detector matcher (inventoryItemMatchesWatch, which uses the shared
 * directional modelMatches). Layer 2 — source guard that the ENGINE's matcher (index.ts) is directional.
 *
 * Run: npx tsx scripts/watch_model_match_eval.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { inventoryItemMatchesWatch } from "../services/api/src/domain/watchFireMiss.ts";
import { unitIsDistinctModelFromWatch } from "../services/api/src/domain/inventoryFeed.ts";

const m = (itemModel: string, watchModel: string) =>
  inventoryItemMatchesWatch({ model: itemModel } as any, { model: watchModel, status: "active", createdAt: "" } as any);

const mo = (itemModel: string, watchModel: string, openToOtherTrims: boolean) =>
  inventoryItemMatchesWatch(
    { model: itemModel } as any,
    { model: watchModel, status: "active", createdAt: "", openToOtherTrims } as any
  );

// THE BUG — a trim-specific watch must NOT fire on a base unit.
assert.equal(m("Street Glide", "Street Glide Special"), false, "base unit must NOT satisfy a 'Special' trim watch (Jason)");
assert.equal(m("Ultra Limited", "Electra Glide Ultra Classic"), false, "an Ultra Limited must NOT satisfy an Ultra Classic watch (different model)");
assert.equal(m("Road Glide", "Road Glide Limited"), false, "a base Road Glide must NOT satisfy a 'Limited' trim watch");

// DISTINCT-MODEL guard (Joe 2026-06-30): a base-model watch must NOT fire on a
// distinct sibling unit — Limited/ST/CVO/Ultra/Classic/Special are separate
// models, not trims/colors of the base. Joseph Mackmin: "Road Glide" watch fired
// a "Road Glide Limited" alert.
assert.equal(m("Road Glide Limited", "Road Glide"), false, "a 'Road Glide' watch must NOT fire on a distinct 'Road Glide Limited' (Joseph)");
assert.equal(m("Road Glide ST", "Road Glide"), false, "a 'Road Glide' watch must NOT fire on a distinct 'Road Glide ST'");
assert.equal(m("Street Glide Special", "Street Glide"), false, "a 'Street Glide' watch must NOT fire on a distinct 'Street Glide Special'");
assert.equal(m("CVO Street Glide", "Street Glide"), false, "a 'Street Glide' watch must NOT fire on a distinct 'CVO Street Glide'");
// openToOtherTrims relaxes the guard (customer known to be open — typically used inventory).
assert.equal(mo("Road Glide Limited", "Road Glide", true), true, "openToOtherTrims lets a base watch fire on a distinct sibling");
assert.equal(mo("Road Glide Limited", "Road Glide", false), false, "openToOtherTrims=false stays strict");

// Legitimate matches preserved.
assert.equal(m("Street Glide Special", "Street Glide Special"), true, "exact trim match still matches");
assert.equal(m("Breakout", "Breakout"), true, "exact model match still matches");
assert.equal(m("Street Glide Special Black", "Street Glide Special"), true, "a more-specific COLOR unit still satisfies the trim watch (color is not a distinct model)");

// REVERSE distinct-model direction (+17165104578, 2026-07-03): the ENGINE matcher
// (index.ts) misclassified a trim-bearing watch "Street Glide Special" as its BASE
// family "street_glide" (detectGenericWatchFamilyLabel), so familyMatch turned true
// and the FORWARD guard above (gated on !genericWatchFamily && !familyMatch) was
// bypassed — a base "Street Glide" unit (stock U902-24) fired the "Street Glide
// Special" watch. The detector matcher `m()` never hit this (no family umbrella), so
// the assertions above stayed green while the engine drifted. Pin the reverse-direction
// semantics the engine guard relies on, plus a source guard that the engine applies it.
assert.equal(unitIsDistinctModelFromWatch("Street Glide Special", "Street Glide"), true, "a 'Special' watch vs a base unit → watch is distinct → engine must block the fire");
assert.equal(unitIsDistinctModelFromWatch("CVO Street Glide", "Street Glide"), true, "a CVO watch vs a base unit → distinct → block");
assert.equal(unitIsDistinctModelFromWatch("Touring", "Street Glide"), false, "a true umbrella watch carries no distinct token → still fires on family units");
assert.equal(unitIsDistinctModelFromWatch("Street Glide Special", "Street Glide Special"), false, "exact-trim watch → not distinct from itself → still fires");
assert.equal(unitIsDistinctModelFromWatch("Street Glide Special", "Street Glide Special Black"), false, "a 'Special' watch vs a more-specific COLOR unit → not distinct → still fires");
assert.equal(unitIsDistinctModelFromWatch("Street Glide", "Street Glide Special"), false, "base watch vs specific unit → forward direction (handled by the other guard), not this one");

// Source guard: the ENGINE's matcher (index.ts) is directional AND carries BOTH the
// forward and the reverse distinct-model guards, so it stays in sync with the detector
// matcher here — a family-umbrella misclassification can no longer slip a trim-specific
// watch onto a base unit.
const idx = fs.readFileSync("services/api/src/index.ts", "utf8");
assert.match(idx, /const directMatch = itemModel\.includes\(watchModel\);/, "engine directMatch must be directional (unit includes watch)");
assert.ok(!/itemModel\.includes\(watchModel\) \|\| watchModel\.includes\(itemModel\)/.test(idx), "the bidirectional matcher (the bug) must be gone");
assert.match(idx, /unitIsDistinctModelFromWatch\(item\.model, watch\.model\)/, "engine matcher must apply the forward distinct-model guard");
assert.match(idx, /unitIsDistinctModelFromWatch\(watch\.model, item\.model\)/, "engine matcher must apply the REVERSE distinct-model guard (a trim-specific watch must not fire on a base unit)");

console.log("PASS watch model-match eval — directional (unit⊇watch): trim-specific watches no longer fire on base units (forward + reverse guards); base/exact matches preserved; engine matcher guarded.");
