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
import { catalogModelReferencedInTurnText } from "../services/api/src/domain/workflowRegressionGuards.ts";

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

// 4) Phantom-substring watch models — the SAME "never a guessed watch" invariant, on the
// other half of the resolver. resolveWatchModelFromText used to pick its label with a bare
// `textLower.includes(model)`, and since #288 put the slang ALIAS keys into the label
// candidates, the bare word "king" (Road King) lives inside "looking". Both production turns
// below rendered "I'll keep an eye out for 2026/2022 king" instead of the customer's actual
// model. 17% of the prod inbound corpus carries such a phantom hit.
const phantomTurns: Array<[string, string]> = [
  // +17169490089 (corpus_replay_regression) — wanted a Low Rider S, got "2026 king".
  ["Just looking for a s , thanks tho", "+17169490089"],
  // +16412012540 (corpus_replay_judge_fail) — wanted a 2022 Low Rider El Diablo, got "2022 king".
  [
    "Thats what Im looking for. Definitely hit me up if one comes in or another store has one",
    "+16412012540"
  ],
  // The same collision family, from other real turns.
  ["What time you thinking?", "thinking"],
  ["thanks for working on this for me", "working"],
  ["I'm all set on the bike search", "never/every → EV"]
];
// Every catalog label candidate must fail the reference test on these turns — asserting the
// WHOLE alias map (not just "king") is what would have blocked #288 from landing the collision.
const familyLookup = JSON.parse(
  fs.readFileSync(path.resolve("services/api/src/domain/model_codes_by_family.json"), "utf8")
) as { aliases?: Record<string, unknown>; families?: Record<string, unknown> };
const aliasKeys = [...Object.keys(familyLookup.aliases ?? {}), ...Object.keys(familyLookup.families ?? {})]
  .map(k => String(k ?? "").trim())
  .filter(Boolean);
assert.ok(aliasKeys.includes("king"), "catalog must still carry the 'king' alias (the collision source)");
for (const [turn, origin] of phantomTurns) {
  for (const key of aliasKeys) {
    assert.equal(
      catalogModelReferencedInTurnText(turn, key),
      false,
      `phantom watch model "${key}" must not be referenced by: ${turn} (${origin})`
    );
  }
}
// Non-regression: a real model named in the turn still resolves (the fix must not mute watches).
const realReferences: Array<[string, string]> = [
  ["keep an eye out for a road king", "Road King"],
  ["2026 low rider s when one lands", "Low Rider S"],
  ["a road glide 3 please", "Road Glide 3"],
  ["any sportsters", "Sportster"], // plural arm
  ["text me if a street glide comes in", "Street Glide"]
];
for (const [turn, model] of realReferences) {
  assert.equal(
    catalogModelReferencedInTurnText(turn, model),
    true,
    `real model reference must still resolve: "${model}" in ${turn}`
  );
}
// Purely-numeric alias keys ("48", "72") are never watch LABELS — even whole-word they turn
// "can you do 72 months" into a Seventy-Two watch. They must be dropped at the candidate list.
const candidatesBlock = idx.slice(idx.indexOf("function getCatalogModelNameCandidates"));
const candidatesBody = candidatesBlock.slice(0, candidatesBlock.indexOf("\n}\n") + 3);
assert.ok(
  /\.filter\(k => \/\[a-z\]\/i\.test\(k\)\)/.test(candidatesBody),
  "getCatalogModelNameCandidates must drop purely-numeric alias keys from the label candidates"
);
assert.ok(
  aliasKeys.some(k => !/[a-z]/i.test(k)),
  "catalog must still carry a purely-numeric alias key (the case the candidate filter exists for)"
);
// Source guard — the resolver must use the whole-word predicate, never the bare substring.
assert.ok(
  /catalogModelReferencedInTurnText\(textLower, m\)/.test(resolverBody),
  "resolveWatchModelFromText must match catalog labels whole-word (catalogModelReferencedInTurnText)"
);
assert.ok(
  !/textLower\.includes\(m\.toLowerCase\(\)\)/.test(resolverBody),
  "resolveWatchModelFromText must NOT pick a watch label by bare substring (the 'looking' → 'king' bug)"
);

console.log("PASS family-watch-clarify eval (family taxonomy + resolver/voice-path clarify wiring)");
