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
  foldModelWordTrimIntoModel,
  applyWatchFieldHygiene
} from "../services/api/src/domain/watchFieldHygiene.ts";

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
assert.match(idx, /applyInventoryWatchConfirmation\(conv: Conversation, watchRaw: InventoryWatch\)/, "…on the raw watch it was handed");
const sg = fs.readFileSync("services/api/src/routes/sendgridInbound.ts", "utf8");
assert.match(sg, /const hygienicWalkInWatch = applyWatchFieldHygiene\(watch\);/, "the Traffic Log Pro walk-in path (which produced the reported record) must apply hygiene");
assert.match(sg, /const hygienicWatch = applyWatchFieldHygiene\(watch\);/, "the semantic/inventory-entity path writes directly too and must apply hygiene");

console.log("PASS watch field hygiene eval — TLP step tags never land in colour; a model word folds into the model label instead of dead-ending the trim slot.");
