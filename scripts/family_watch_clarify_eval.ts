/**
 * family_watch_clarify:eval — pins the family-placeholder watch clarify (Joe ruling
 * 2026-07-11 #4). Origin: +15857552622 "new or used trike" — the watch-model resolver
 * fell back to the lead-vehicle garbage label ("Or New Trike") and an active watch got
 * created with the wrong model + years. A FAMILY node ("trike", "touring", "CVO") is
 * never a bookable model: the correct route is ONE clarifying "which model?".
 *
 * Pins:
 *  1) isFamilyOnlyModelLabel — catalog family keys match as whole labels (after
 *     new/used/or noise stripping), never as substrings ("Street Glide" is safe).
 *  2) referencesFamilyOnlyInText — a standalone family word in a customer turn
 *     clarifies; a family word inside a NARROWER specific-model alias ("street glide
 *     trike" → 1 code vs "trike" → 6) does not; umbrella aliases as broad as the
 *     family ("touring bike") DO clarify; attribute-like words ("street bike",
 *     "lightweight") never fire from text.
 *  3) Source guards — resolveWatchModelFromText nulls family/placeholder text +
 *     fallback (landing every call site in its existing "which model should I watch
 *     for?" arm), and both voice/call-summary bypass sites park family labels as
 *     inventoryWatchPending + inventory_watch_prompted instead of an active watch.
 *
 * FAIL DIRECTION: ask (clarify) — never a guessed watch. A missing catalog makes the
 * helpers return false/null (existing behavior); not simulable here because the
 * catalog loader's sibling-path fallback always resolves in-repo.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  isFamilyOnlyModelLabel,
  referencesFamilyOnlyInText
} from "../services/api/src/domain/modelFamily.ts";

// 1) Label classification — family nodes vs specific models.
const familyLabels = [
  "Or New Trike", // the production garbage label (+15857552622)
  "trike",
  "Trikes",
  "new or used trike",
  "Touring",
  "CVO",
  "Sportster"
];
for (const label of familyLabels) {
  assert.equal(isFamilyOnlyModelLabel(label), true, `family label must classify family-only: ${label}`);
}
const specificLabels = [
  "Tri Glide",
  "Freewheeler",
  "Street Glide", // must NOT substring-match the STREET family
  "Road Glide 3",
  "Street Glide Trike", // specific trike model, not the family
  "Low Rider S",
  "Harley-Davidson Other", // placeholder territory (isPlaceholderModel), not family
  ""
];
for (const label of specificLabels) {
  assert.equal(isFamilyOnlyModelLabel(label), false, `must NOT classify family-only: ${label}`);
}

// 2) Turn-text references — standalone family word clarifies; specific aliases don't.
const familyTexts: Array<[string, string]> = [
  ["can you watch for a trike for me", "trike"],
  ["looking for a used trike 2014-2016", "trike"], // the +15857552622 shape
  ["any trikes coming in", "trike"],
  ["a touring bike", "touring"], // umbrella alias as broad as the family = the family
  ["any sportsters", "sportster"]
];
for (const [text, family] of familyTexts) {
  assert.equal(referencesFamilyOnlyInText(text), family, `family reference must clarify: ${text}`);
}
const nonFamilyTexts = [
  "watching for a street glide trike", // narrower specific alias containing the family word
  "a road glide 3 trike please",
  "I want a street glide",
  "looking for a street bike", // attribute-like: generic slang, not the STREET family
  "something lightweight",
  "watch for a tri glide",
  "low rider s when one comes in",
  ""
];
for (const text of nonFamilyTexts) {
  assert.equal(referencesFamilyOnlyInText(text), null, `must NOT read a family reference: ${text}`);
}

// 3) Source guards — the wiring that makes the helpers matter.
const idx = fs.readFileSync(path.resolve("services/api/src/index.ts"), "utf8");
// resolveWatchModelFromText: family text + family/placeholder fallback both null out
// (every call site already clarifies on a null model).
const resolverBlock = idx.slice(idx.indexOf("async function resolveWatchModelFromText"));
const resolverBody = resolverBlock.slice(0, resolverBlock.indexOf("\n}\n") + 3);
assert.ok(
  /referencesFamilyOnlyInText\(textLower\)/.test(resolverBody),
  "resolveWatchModelFromText must clarify on a standalone family reference in the turn text"
);
assert.ok(
  /isFamilyOnlyModelLabel\(fallback\)/.test(resolverBody) && /isPlaceholderModel\(fallback\)/.test(resolverBody),
  "resolveWatchModelFromText must never return a family/placeholder fallback label"
);
// Voice watch path: family-only watches park as pending + prompted, never active.
assert.ok(
  /specificVoiceWatches = watches\.filter\(w => !isFamilyOnlyModelLabel\(w\.model\)\)/.test(idx),
  "voice watch path must filter family-only labels out of active watch creation"
);
assert.ok(
  /voice_watch_family_clarify_pending/.test(idx),
  "voice watch path must park a family-only watch as pending (clarify), with a route outcome"
);
// Call-summary availability path: family/placeholder model parks as pending + prompted.
assert.ok(
  /isFamilyOnlyModelLabel\(model\) \|\| isPlaceholderModel\(model\)/.test(idx) &&
    /call_summary_watch_family_clarify_pending/.test(idx),
  "call-summary watch path must park family/placeholder labels as pending (clarify)"
);

console.log("PASS family-watch-clarify eval (family taxonomy + resolver/voice-path clarify wiring)");
