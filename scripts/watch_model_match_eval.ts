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
import {
  unitIsDistinctModelFromWatch,
  distinct883ModelConflict,
  specific883ModelToken,
  distinctSportsterModelConflict,
  modernSportsterModelToken,
  modelMatches,
  stripLeadingHarleyModelCode
} from "../services/api/src/domain/inventoryFeed.ts";
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

// DISTINCT-883-MODEL guard (+15164197791, +12399612259, +18728882220, +19897006720, 2026-07-22):
// the is883ModelToken family umbrella treated every "883" as one model, and detectGenericWatchFamilyLabel
// maps "Iron 883" to the generic "sportster" family — so a SINGLE 2006 "Sportster 883 Low" fired EVERY
// "Iron 883" watch (four+ customers texted that "their" bike came in). Iron 883 and Sportster 883 Low are
// DISTINCT models, not trims. Both matchers must block it; a generic "883" watcher is still open to any 883.
assert.equal(m("Sportster 883 Low", "Iron 883"), false, "an 'Iron 883' watch must NOT fire on a 'Sportster 883 Low' (the wrong-model bug)");
assert.equal(m("2006 Harley-Davidson Sportster 883 Low", "Iron 883"), false, "the exact production unit must NOT fire an Iron 883 watch");
assert.equal(m("Iron 883", "Iron 883"), true, "a real Iron 883 still fires an Iron 883 watch");
assert.equal(m("Sportster Iron 883", "Iron 883"), true, "a feed-labeled 'Sportster Iron 883' still matches an Iron 883 watch");
assert.equal(m("Sportster 883 Low", "883"), true, "a GENERIC '883' watcher is still open to a Sportster 883 Low");
assert.equal(m("Sportster 883 Low", "Sportster 883 Low"), true, "an exact 883-Low match still fires");
// The pure guard directly (both directions of specificity).
assert.equal(distinct883ModelConflict("Sportster 883 Low", "Iron 883"), true, "specific 883 watch vs different 883 unit → block");
assert.equal(distinct883ModelConflict("Iron 883", "Iron 883"), false, "same specific 883 model → allow");
assert.equal(distinct883ModelConflict("Sportster 883 Low", "883"), false, "generic 883 watch → never blocks");
assert.equal(distinct883ModelConflict("Road Glide", "Road Glide"), false, "non-883 models are untouched by this guard");
assert.equal(specific883ModelToken("Iron 883"), "iron", "Iron 883 resolves to its sub-model token");
assert.equal(specific883ModelToken("883"), null, "a bare 883 has no sub-model token (generic)");
assert.equal(specific883ModelToken("Road Glide"), null, "a non-883 model has no 883 sub-model token");

// MODERN-SPORTSTER guard (+17705967891, 2026-07-22): "Sportster S" and "Nightster" are specific
// modern models but detectGenericWatchFamilyLabel maps them to the generic "sportster" family, so the
// SAME 2006 Sportster 883 Low fired a "Sportster S" watch too. Distinct models, not trims — block.
assert.equal(m("Sportster 883 Low", "Sportster S"), false, "a 'Sportster S' watch must NOT fire on a Sportster 883 Low (the wrong-model bug)");
assert.equal(m("2006 Harley-Davidson Sportster 883 Low", "Sportster S"), false, "the exact production unit must NOT fire a Sportster S watch");
assert.equal(m("Sportster 883 Low", "Nightster"), false, "a 'Nightster' watch must NOT fire on a Sportster 883 Low");
assert.equal(m("Sportster S", "Sportster S"), true, "a real Sportster S still fires a Sportster S watch");
assert.equal(m("Sportster 883 Low", "Sportster"), true, "a GENERIC 'Sportster' watcher is still open to a Sportster 883 Low");
// Pure guard — including the critical NEGATIVES that must never be read as a modern Sportster.
assert.equal(distinctSportsterModelConflict("Sportster 883 Low", "Sportster S"), true, "Sportster S watch vs 883 Low unit → block");
assert.equal(distinctSportsterModelConflict("Sportster S", "Sportster S"), false, "same modern model → allow");
assert.equal(distinctSportsterModelConflict("Sportster 883 Low", "Sportster"), false, "generic Sportster watch → never blocks");
assert.equal(modernSportsterModelToken("Sportster S"), "sportster_s", "Sportster S resolves to its modern token");
assert.equal(modernSportsterModelToken("RH1250S"), "sportster_s", "the RH1250 code resolves to Sportster S");
assert.equal(modernSportsterModelToken("Nightster"), "nightster", "Nightster resolves");
assert.equal(modernSportsterModelToken("Low Rider S"), null, "a 'Low Rider S' is NOT a modern Sportster (the '…S' false-positive trap)");
assert.equal(modernSportsterModelToken("CVO Road Glide ST"), null, "a 'Road Glide ST' is NOT a modern Sportster");
assert.equal(modernSportsterModelToken("Sportster"), null, "a bare Sportster carries no modern-model token (stays generic)");

// FAMILY-LABEL letter-suffix guard (Cory Fiegel +17169490089, Joe ruling 2026-07-23): a "Low Rider S"
// watch fired on a "Low Rider ST". The watch label maps to a generic family id (low_rider_s), which
// bypassed the ENGINE's forward distinct-model guard (it was gated on !genericWatchFamily) — and the
// substring directMatch ("low rider st".includes("low rider s")) fired even though the unit is NOT a
// family member ("st" fails the exact "low rider s" token sequence). S and ST are distinct models.
// The DETECTOR matcher applies the guard ungated, so pin the behavior here + a source guard below
// that the engine's gate no longer requires !genericWatchFamily.
assert.equal(m("Low Rider ST", "Low Rider S"), false, "a 'Low Rider S' watch must NOT fire on a 'Low Rider ST' (Cory — distinct letter-suffix model)");
assert.equal(m("2025 Harley-Davidson Low Rider ST", "Low Rider S"), false, "the year/make-prefixed ST unit must not fire an S watch either");
assert.equal(m("Low Rider S", "Low Rider S"), true, "a real Low Rider S still fires a Low Rider S watch");
assert.equal(m("Low Rider S 117", "Low Rider S"), true, "an engine-size suffix is not a distinct model — still fires");
assert.equal(mo("Low Rider ST", "Low Rider S", true), true, "openToOtherTrims still relaxes the guard");
assert.equal(unitIsDistinctModelFromWatch("Low Rider ST", "Low Rider S"), true, "the pure guard reads ST as a distinct-model token the S watch lacks");

// Source guard: BOTH matchers apply the distinct-883 + modern-Sportster guards (live engine + detector).
const wfm = fs.readFileSync("services/api/src/domain/watchFireMiss.ts", "utf8");
assert.match(wfm, /distinct883ModelConflict\(item\.model, watch\.model\)/, "detector matcher must apply the distinct-883 guard");
assert.match(wfm, /distinctSportsterModelConflict\(item\.model, watch\.model\)/, "detector matcher must apply the modern-Sportster guard");

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
// The engine must DELEGATE its directional test to the shared modelMatches, not re-implement it.
// It used to hold a private copy (`itemModel.includes(watchModel)`), and a copy drifts: when the
// leading-DMS-code retry was added to modelMatches on 2026-08-08 (#617 `cb97b0ab`), only the
// DETECTOR — which calls modelMatches — picked it up. The engine kept its copy and stayed blind to
// "FLHD Deadwood", so Mike Wolf's watch never fired on the 2026 Deadwood (S28-26) that arrived
// 2026-08-17T21:20Z. Delegating is what makes Layer 1's execution binding on the live fire path;
// the old assertion pinned the copy's TEXT, which is why it passed all the way through the miss.
assert.match(idx, /const directMatch = modelMatches\(item\.model, watch\.model\);/, "engine directMatch must DELEGATE to the shared modelMatches (a private copy drifts)");
assert.ok(!/const directMatch = itemModel\.includes\(watchModel\)/.test(idx), "the engine's private copy of the directional test must stay gone");
assert.match(idx, /unitIsDistinctModelFromWatch\(item\.model, watch\.model\)/, "engine matcher must apply the forward distinct-model guard");
// The forward guard must apply on the FAMILY-LABEL path too (Cory, 7/23): gated on !familyMatch
// only — NOT on !genericWatchFamily, which let "Low Rider S" (family low_rider_s) skip it and
// substring-fire on a "Low Rider ST".
assert.match(
  idx,
  /!familyMatch &&\s*\n\s*!watch\.openToOtherTrims &&\s*\n\s*unitIsDistinctModelFromWatch\(item\.model, watch\.model\)/,
  "engine forward guard must run whenever the unit is not a genuine family member"
);
assert.ok(
  !/!genericWatchFamily &&\s*\n\s*!familyMatch &&\s*\n\s*!watch\.openToOtherTrims/.test(idx),
  "the !genericWatchFamily gate on the forward guard (the Cory S→ST hole) must stay gone"
);
assert.match(idx, /unitIsDistinctModelFromWatch\(watch\.model, item\.model\)/, "engine matcher must apply the REVERSE distinct-model guard (a trim-specific watch must not fire on a base unit)");
assert.match(idx, /distinct883ModelConflict\(item\.model, watch\.model\)/, "engine matcher must apply the distinct-883-model guard");
assert.match(idx, /distinctSportsterModelConflict\(item\.model, watch\.model\)/, "engine matcher must apply the modern-Sportster guard");

// ---------------------------------------------------------------------------------------------
// DMS PLATFORM CODES (Mike Wolf +17164323990, 2026-08-07). ADF leads arrive as CODE + NAME —
// "FLHD Deadwood", "FLHX Street Glide" — because that is how the dealer's DMS writes them, while
// the inventory feed lists the bike by NAME. Directionality then matched NOTHING: the feed's
// "Deadwood" does not contain "flhd deadwood". Measured against the live americanharley store +
// feed 2026-08-08: 12 distinct lead/watch labels (29 references) matched ZERO in-stock units and
// matched real ones the moment the leading code was dropped.
assert.equal(modelMatches("Deadwood", "FLHD Deadwood"), true, "a CODE+NAME ask must match the feed's NAME-only unit (Mike Wolf)");
assert.equal(modelMatches("Street Glide", "FLHX Street Glide"), true, "FLHX Street Glide must match a Street Glide");
assert.equal(modelMatches("Road Glide", "FLTRX Road Glide"), true, "FLTRX Road Glide must match a Road Glide");
assert.equal(modelMatches("Street Bob", "Fxbb Street Bob"), true, "the code is matched case-insensitively (the DMS writes it either way)");

// The relaxation is TARGET-side and LEADING-token only; every existing guard still binds.
assert.equal(modelMatches("Street Glide", "FLHXSE CVO Street Glide"), false, "dropping the code must not manufacture a base match for a CVO ask");
assert.equal(modelMatches("Street Glide", "FLHXS Street Glide Special"), false, "a trim-specific ask must NOT collapse to its base family just because it carried a code");
// Leading-only is load-bearing, not decoration. FLTRXS is the Road Glide SPECIAL: a matcher that
// dropped codes ANYWHERE in the label would reduce this ask to the bare base family and fire on
// all 17 base Road Glides the dealer stocks.
assert.equal(modelMatches("Road Glide", "Road Glide FLTRXS"), false, "a code must only be dropped from the FRONT — mid/trailing codes carry the specificity");
assert.equal(stripLeadingHarleyModelCode("Road Glide FLTRXS"), "", "…and the helper refuses it outright");

// A model whose NAME is its code must not degrade to a bare displacement free to match anything.
assert.equal(stripLeadingHarleyModelCode("Fxdr 114"), "", "stripping must refuse when no model NAME survives ('114' would match any 114)");
assert.equal(modelMatches("Road Glide 114", "Fxdr 114"), false, "so an FXDR ask never matches a Road Glide 114");
assert.equal(stripLeadingHarleyModelCode("FLHD"), "", "a bare code alone strips to nothing");
assert.equal(stripLeadingHarleyModelCode("Street Glide"), "", "a plain model name has no leading code to drop");
assert.equal(stripLeadingHarleyModelCode("FLHD Deadwood"), "deadwood", "the surviving name is what we search on");

// THE MISS ITSELF, through the WHOLE matcher (not just modelMatches). Every assertion above this
// block tested the shared primitive; the live fire engine held its own copy of the directional test
// and none of them bound it. These run the full matcher stack — code-strip retry, then the CVO /
// distinct-model / family guards on the result — which is the path a real watch takes.
assert.equal(m("Deadwood", "FLHD Deadwood"), true, "THE MISS: Mike Wolf's ADF 'FLHD Deadwood' watch must match the feed's 'Deadwood' (S28-26, arrived 2026-08-17)");
assert.equal(m("Street Glide", "FLHX Street Glide"), true, "the other 12 measured CODE+NAME labels match too (FLHX -> 9 units on 2026-08-08)");
assert.equal(m("Road Glide", "FLTRX Road Glide"), true, "FLTRX Road Glide -> the base Road Glides (17 units on 2026-08-08)");
// …and the code-strip retry must not become a back door through the guards it runs before.
// MEASURED 2026-08-19 by sabotage: deleting the CVO guard inside modelMatches does NOT flip this
// line. The pair is already rejected by the directional include ("street glide" does not contain
// "cvo street glide") and, in the detector, again by the distinct-model guard. So this assertion is
// carried by directionality, not by the CVO guard — it is a real behaviour pin, but do NOT read a
// green run here as evidence the CVO guard still exists. Left in place deliberately: it is the
// shape a future widening of the strip rule would break first.
assert.equal(m("Street Glide", "FLHXSE CVO Street Glide"), false, "a CVO ask must not collect a base unit just because its label carried a code");
assert.equal(m("Street Glide", "FLHXS Street Glide Special"), false, "a trim-specific coded ask must not collapse onto the base model");
assert.equal(m("Road Glide", "Road Glide FLTRXS"), false, "a TRAILING code still carries specificity — never dropped");

console.log("PASS watch model-match eval — directional (unit⊇watch): trim-specific watches no longer fire on base units (forward + reverse guards); base/exact matches preserved; a leading DMS platform code no longer hides the whole floor; engine matcher guarded.");
