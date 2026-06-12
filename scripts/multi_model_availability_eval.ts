/**
 * Multi-model availability eval. Production fixture: Chuck Bailey Jr
 * +17163197142, 2026-06-07 — "I am mostly interested in a Street Glide, but
 * would also like to ride a Street Gide Limited, if that would be possible"
 * drew a Street-Glide-only inventory list. Three stacked causes:
 *   1. the "Gide" typo never matched the lexicon,
 *   2. the substring dedupe collapsed Street Glide vs Street Glide Limited
 *      into one mention even when spelled right,
 *   3. the availability reply only ever used requestedModelMentions[0].
 */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";

const apiSource = await fs.readFile(path.resolve("services/api/src/index.ts"), "utf8");

// Source pins.
assert.match(apiSource, /\\bgides\?\\b\/g, "glide"/, "the 'gide' typo normalization must exist");
assert.match(
  apiSource,
  /Occurrence-aware dedupe/,
  "findMentionedModels must use occurrence-aware dedupe, not substring collapse"
);
// The resolver's existing multi-mention block answers per model once the
// extraction surfaces both mentions (it was unreachable for Chuck only
// because extraction collapsed his turn to one model).
assert.match(
  apiSource,
  /if \(requestedModelMentions\.length >= 2\) \{/,
  "availability resolver must keep the per-model multi-mention block"
);
assert.match(
  apiSource,
  /let me know what day and time you want to test ride it/,
  "multi-model replies keep the test-ride closer"
);

// Behavioral copies (pure logic mirrored from index.ts; pinned above).
function normalizeModelText(val: string): string {
  return String(val ?? "")
    .toLowerCase()
    .replace(/\bgides?\b/g, "glide")
    .replace(/\bg(?:lied|ilde)s?\b/g, "glide")
    .replace(/\b(street|road|tri|wide)\s+guides?\b/g, "$1 glide")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function findNormalizedPhraseSpans(hay: string, needle: string): Array<{ start: number; end: number }> {
  if (!hay || !needle) return [];
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(?:^|\\s)(${escaped})(?=\\s|$)`, "g");
  const spans: Array<{ start: number; end: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(hay))) {
    const start = m.index + (m[0].length - m[1].length);
    spans.push({ start, end: start + m[1].length });
    if (re.lastIndex === m.index) re.lastIndex += 1;
  }
  return spans;
}

function findMentionedModels(text: string, lexicon: string[]): string[] {
  const t = normalizeModelText(text);
  if (!t || !lexicon.length) return [];
  const sorted = [...lexicon].sort((a, b) => b.length - a.length);
  const claimed: Array<{ start: number; end: number }> = [];
  const found: Array<{ model: string; normalized: string }> = [];
  for (const model of sorted) {
    const normalized = normalizeModelText(model);
    if (!normalized) continue;
    if (found.some(f => f.normalized === normalized)) continue;
    const spans = findNormalizedPhraseSpans(t, normalized);
    const free = spans.find(s => !claimed.some(c => s.start >= c.start && s.end <= c.end));
    if (!free) continue;
    claimed.push(free);
    found.push({ model, normalized });
  }
  return found.map(f => f.model);
}

const LEXICON = [
  "Street Glide",
  "Street Glide Limited",
  "Road Glide",
  "Road Glide Special",
  "Breakout",
  "Heritage Classic"
];

const CHUCK_TEXT =
  "I am mostly interested in a Street Glide, but would also like to ride a Street Gide Limited, if that would be possible- Thanks";

const chuckModels = findMentionedModels(CHUCK_TEXT, LEXICON).map(m => m.toLowerCase());
assert.deepEqual(
  [...chuckModels].sort(),
  ["street glide", "street glide limited"],
  `Chuck's literal turn (typo included) must yield BOTH models, got: ${chuckModels.join(", ")}`
);

// A single mention of the long name must NOT also produce the short name.
const onlyLimited = findMentionedModels("do you have a street glide limited in stock", LEXICON);
assert.deepEqual(
  onlyLimited.map(m => m.toLowerCase()),
  ["street glide limited"],
  "one mention of the longer model stays one mention"
);

// Two distinct families still both surface.
const twoFamilies = findMentionedModels("torn between a breakout and a heritage classic", LEXICON);
assert.equal(twoFamilies.length, 2, "two distinct families both surface");

// Autocorrect's "street guide" still finds the Glide.
const guide = findMentionedModels("looking at a street guide", LEXICON);
assert.deepEqual(guide.map(m => m.toLowerCase()), ["street glide"], "street guide → street glide");

console.log("PASS multi-model availability eval");
