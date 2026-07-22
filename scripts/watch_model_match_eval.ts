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
import { watchLabelIsBareFamilyUmbrella } from "../services/api/src/domain/watchFamilyScope.ts";

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

// FAMILY-UMBRELLA SCOPE (open-critic cluster, 2026-07-22 — five leads in one sweep).
// detectGenericWatchFamilyLabel is a CONTAINS matcher for its specific-model branches, so it
// classified "Sportster S" and "Iron 883" as the `sportster` UMBRELLA. In the engine matcher that
// both turned familyMatch true against any Sportster-family unit AND switched off the forward
// distinct-model guard — so a customer who asked for a 2022 Iron 883 was texted about a 2006
// Sportster 883 Low (+15164197791, +12399612259, +18728882220, +19897006720, +17705967891).
// These assertions run the REAL predicate the engine now gates on, not a source regex — the
// detector matcher `m()` above has no family umbrella at all, which is exactly why the previous
// round of fixtures stayed green while the engine drifted.
assert.equal(watchLabelIsBareFamilyUmbrella("Sportster", "sportster"), true, "a bare 'Sportster' watch IS the family umbrella — it should still collect Iron 883s");
assert.equal(watchLabelIsBareFamilyUmbrella("Sportster S", "sportster"), false, "'Sportster S' is a specific model, NOT the Sportster umbrella (+17705967891)");
assert.equal(watchLabelIsBareFamilyUmbrella("Iron 883", "sportster"), false, "'Iron 883' is a specific model, NOT the Sportster umbrella (+15164197791)");
assert.equal(watchLabelIsBareFamilyUmbrella("Sportster 883 Low", "sportster"), false, "'Sportster 883 Low' is a specific model, not the umbrella (+12399612259)");
assert.equal(watchLabelIsBareFamilyUmbrella("Street Glide", "street_glide"), true, "a bare 'Street Glide' watch is the Street Glide umbrella");
assert.equal(watchLabelIsBareFamilyUmbrella("Street Glide Special", "street_glide"), false, "'Street Glide Special' is a specific model, not the Street Glide umbrella (+17165104578)");
assert.equal(watchLabelIsBareFamilyUmbrella("Harley-Davidson Street Glide", "street_glide"), true, "make tokens carry no model specificity — still the umbrella (+17165600980)");
assert.equal(watchLabelIsBareFamilyUmbrella("2024 Street Glide", "street_glide"), true, "a model YEAR carries no model specificity — still the umbrella (the year is matched separately)");
assert.equal(watchLabelIsBareFamilyUmbrella("Tri Glide", "tri_glide"), true, "a bare 'Tri Glide' watch is the Tri Glide umbrella");
assert.equal(watchLabelIsBareFamilyUmbrella("Flhtcutg 1mad Tri Glide Ultra", "tri_glide"), false, "a VIN-decoded, trim-bearing label is NOT the umbrella (+17166021492)");
assert.equal(watchLabelIsBareFamilyUmbrella("Street Glide", null), false, "no detected family → never an umbrella");
assert.equal(watchLabelIsBareFamilyUmbrella("", "street_glide"), false, "an empty label is never an umbrella");

// Source guard: the engine gates its family umbrella on that predicate, and keeps the 883 arm
// (which was the same umbrella in disguise) behind the same gate.
const engineSrc = fs.readFileSync("services/api/src/index.ts", "utf8");
assert.match(engineSrc, /watchLabelIsBareFamilyUmbrella\(watch\.model, detectedWatchFamily\)/, "engine must gate the family umbrella on a BARE family label");
assert.match(engineSrc, /return !!genericWatchFamily && is883ModelToken\(itemModel\);/, "the engine's 883 family arm must be gated on the same umbrella check");
// Creation-side: the customer's own specificity must survive into the stored watch label.
assert.ok(!/if \(is883ModelToken\(normalized\)\) return "Sportster 883";\n    return "Iron";/.test(engineSrc), "an 'Iron 883' ask must not be rewritten to the generic 'Sportster 883'");
assert.match(engineSrc, /if \(is883ModelToken\(normalized\)\) return "Iron 883";/, "an 'Iron 883' ask stores 'Iron 883'");
assert.match(engineSrc, /return canonicalizeWatchModelLabel\(fallback\) \|\| fallback;/, "the lead-vehicle fallback must be canonicalized (strips make prefixes / VIN junk)");

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
