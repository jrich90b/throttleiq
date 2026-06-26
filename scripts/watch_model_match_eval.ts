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

const m = (itemModel: string, watchModel: string) =>
  inventoryItemMatchesWatch({ model: itemModel } as any, { model: watchModel, status: "active", createdAt: "" } as any);

// THE BUG — a trim-specific watch must NOT fire on a base unit.
assert.equal(m("Street Glide", "Street Glide Special"), false, "base unit must NOT satisfy a 'Special' trim watch (Jason)");
assert.equal(m("Ultra Limited", "Electra Glide Ultra Classic"), false, "an Ultra Limited must NOT satisfy an Ultra Classic watch (different model)");
assert.equal(m("Road Glide", "Road Glide Limited"), false, "a base Road Glide must NOT satisfy a 'Limited' trim watch");

// Legitimate matches preserved.
assert.equal(m("Street Glide Special", "Street Glide Special"), true, "exact trim match still matches");
assert.equal(m("Breakout", "Breakout"), true, "exact model match still matches");
assert.equal(m("Road Glide Limited", "Road Glide"), true, "a base watch DOES match a more-specific unit (unit includes the watched model)");
assert.equal(m("Street Glide Special Black", "Street Glide Special"), true, "a more-specific unit still satisfies the trim watch");

// Source guard: the ENGINE's matcher (index.ts) is directional — no reverse `watchModel.includes(itemModel)`.
const idx = fs.readFileSync("services/api/src/index.ts", "utf8");
assert.match(idx, /const directMatch = itemModel\.includes\(watchModel\);/, "engine directMatch must be directional (unit includes watch)");
assert.ok(!/itemModel\.includes\(watchModel\) \|\| watchModel\.includes\(itemModel\)/.test(idx), "the bidirectional matcher (the bug) must be gone");

console.log("PASS watch model-match eval — directional (unit⊇watch): trim-specific watches no longer fire on base units; base/exact matches preserved; engine matcher guarded.");
