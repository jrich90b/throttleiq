/**
 * Owned-bike model guard eval. Production miss: Todd Herian +15673079691,
 * 2026-06-13 — a Road Glide Special test-ride lead texted "as long as it's a
 * roadglide compared to my current ultra limited" and the agent offered Ultra
 * Limiteds for sale. Two stacked bugs: "roadglide" (one word) never matched
 * Road Glide, and "my current ultra limited" (his owned bike) was read as the
 * requested model.
 */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";

const { selectRequestedAvailabilityModelMentions } = await import(
  "../services/api/src/domain/workflowRegressionGuards.ts"
);

// --- Bug 2: owned/comparison mentions are not requests ---
const idx = (text: string, model: string) => ({ model, index: text.indexOf(model) });

const toddText = "as long as it s a roadglide compared to my current ultra limited";
// Only the owned bike surfaced as a candidate (roadglide didn't match before the fix).
assert.deepEqual(
  selectRequestedAvailabilityModelMentions(toddText, [idx(toddText, "ultra limited")]),
  [],
  "the customer's current/owned bike must never become the requested model"
);

// A genuine single-model request still passes through.
const want = "do you have a road glide special in stock";
assert.deepEqual(
  selectRequestedAvailabilityModelMentions(want, [idx(want, "road glide special")]),
  ["road glide special"],
  "a real request still returns the model"
);

// Owned bike excluded, real request kept, when both appear.
const both = "i want a road glide but i currently ride a street glide";
const bothSel = selectRequestedAvailabilityModelMentions(both, [
  idx(both, "road glide"),
  idx(both, "street glide")
]).map(m => m.toLowerCase());
assert.ok(bothSel.includes("road glide"), "requested road glide kept");
assert.ok(!bothSel.includes("street glide"), "owned street glide dropped");

// "than my ___" / "vs my ___" comparison forms.
const vs = "looking at a breakout vs my heritage classic";
assert.deepEqual(
  selectRequestedAvailabilityModelMentions(vs, [
    idx(vs, "breakout"),
    idx(vs, "heritage classic")
  ]).map(m => m.toLowerCase()),
  ["breakout"],
  "vs-my comparison drops the owned bike"
);

// --- Bug 1: concatenated model names normalize (source pin + behavioral copy) ---
const apiSource = await fs.readFile(path.resolve("services/api/src/index.ts"), "utf8");
assert.match(
  apiSource,
  /Concatenated model names people text as one word/,
  "normalizeModelText must split concatenated model names"
);
assert.match(apiSource, /\\broad\\s\*glides\?\\b\/g, "road glide"/, "roadglide normalization pinned");

function normalizeConcat(val: string): string {
  return String(val ?? "")
    .toLowerCase()
    .replace(/\broad\s*glides?\b/g, "road glide")
    .replace(/\bstreet\s*glides?\b/g, "street glide")
    .replace(/\bultra\s*limiteds?\b/g, "ultra limited")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
assert.equal(normalizeConcat("roadglide"), "road glide", "roadglide → road glide");
assert.equal(normalizeConcat("StreetGlide"), "street glide", "StreetGlide → street glide");
assert.equal(normalizeConcat("a roadglide special"), "a road glide special", "embedded concat splits");

console.log("PASS owned-bike model guard eval");
