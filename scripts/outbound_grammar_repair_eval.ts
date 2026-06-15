/**
 * Outbound grammar repair eval — pins the deterministic grammar net that runs on
 * every customer-facing message, plus the cadence label-prefix fix that produced
 * the two defects observed in the 2026-06-14 American Harley runtime snapshot:
 *
 *   1. Dropped verb: a malformed tone rewrite (or a hand edit) turned the bank
 *      string "I can send a couple time options." into "I can a couple time
 *      options." — a modal with no following verb.
 *   2. Doubled article: the regenerate cadence prefixed "the" onto
 *      formatModelLabelForFollowUp output (which already returns "the <model>"),
 *      shipping "just checking back on the the Nightster".
 *
 * Bank strings stay correct (cadence_template_voice:eval guards those); this eval
 * covers the DOWNSTREAM runtime steps so the sent text is grammatical.
 *
 * Usage: npx tsx scripts/outbound_grammar_repair_eval.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  applyDeterministicToneOverrides,
  repairDoubledArticle,
  repairDroppedModalVerb
} from "../services/api/src/domain/tone.ts";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tone-rules-"));
function writeRules(name: string, body: unknown): string {
  const p = path.join(tmpDir, name);
  fs.writeFileSync(p, JSON.stringify(body));
  return p;
}
function hasModalVerbGap(text: string): boolean {
  return /\b(?:i|we|you|they)\s+(?:can|could|will|would|can't|cannot|won't)\s+(?:a|an|the|some|any|two|your|my)\b/i.test(
    text
  );
}

// --- repairDroppedModalVerb (pure) -----------------------------------------
assert.equal(
  repairDroppedModalVerb("If you want to come in, I can a couple time options."),
  "If you want to come in, I can send a couple time options.",
  "restores the dropped verb before a determiner"
);
assert.equal(
  repairDroppedModalVerb("Want me to text you two quick time slots so it stays easy?"),
  "Want me to text you two quick time slots so it stays easy?",
  "leaves grammatical text untouched"
);
// A modal already followed by a verb must never gain a spurious "send".
for (const ok of [
  "If you want to come in, I can send a couple time options.",
  "I can also check what incentives are running and send over whatever applies.",
  "We can get that done anytime.",
  "I can keep an eye out and text you if one comes in."
]) {
  assert.equal(repairDroppedModalVerb(ok), ok, `no false repair: "${ok}"`);
  assert.ok(!hasModalVerbGap(ok), `no false positive gap: "${ok}"`);
}

// --- repairDoubledArticle (pure) -------------------------------------------
assert.equal(
  repairDoubledArticle("Hey Sam, just checking back on the the Nightster."),
  "Hey Sam, just checking back on the Nightster.",
  "collapses 'the the'"
);
assert.equal(repairDoubledArticle("I saw a a bike you liked."), "I saw a bike you liked.");
assert.equal(
  repairDoubledArticle("Just checking back on the Nightster theater downtown."),
  "Just checking back on the Nightster theater downtown.",
  "does not touch a word that merely starts with 'the'"
);

// --- applyDeterministicToneOverrides: net runs end-to-end (empty rules) -----
process.env.DETERMINISTIC_TONE_RULES_PATH = writeRules("empty.json", {
  version: 1,
  auto: { rewriteRules: [], blockedExactDrafts: [] },
  manual: { rewriteRules: [], blockedExactDrafts: [] }
});
assert.equal(
  applyDeterministicToneOverrides("If you want to come in, I can a couple time options."),
  "If you want to come in, I can send a couple time options.",
  "tone overrides restore the dropped verb"
);
assert.equal(
  applyDeterministicToneOverrides("Hey Sam, just checking back on the the Nightster."),
  "Hey Sam, just checking back on the Nightster.",
  "tone overrides collapse the doubled article"
);

// --- applyDeterministicToneOverrides: verb-loss-safe rule application -------
// The exact production shape: AI draft "I can send two time options." plus a
// malformed promoted rule "send two" -> "a couple" would drop the verb. The
// guard must skip that rule rather than ship "I can a couple time options.".
process.env.DETERMINISTIC_TONE_RULES_PATH = writeRules("malformed.json", {
  version: 1,
  auto: { rewriteRules: [{ match: "send two", replace: "a couple" }], blockedExactDrafts: [] },
  manual: { rewriteRules: [], blockedExactDrafts: [] }
});
const guarded = applyDeterministicToneOverrides("If you want to come in, I can send two time options.");
assert.ok(!hasModalVerbGap(guarded), `verb-loss rule was rejected: "${guarded}"`);
assert.ok(/\bsend\b/i.test(guarded), `the verb survives: "${guarded}"`);

// A benign rewrite that does NOT create a gap still applies.
process.env.DETERMINISTIC_TONE_RULES_PATH = writeRules("benign.json", {
  version: 1,
  auto: { rewriteRules: [{ match: "give me a shout", replace: "let me know" }], blockedExactDrafts: [] },
  manual: { rewriteRules: [], blockedExactDrafts: [] }
});
assert.equal(
  applyDeterministicToneOverrides("If anything changes, just give me a shout."),
  "If anything changes, just let me know.",
  "benign rewrite still applies"
);

fs.rmSync(tmpDir, { recursive: true, force: true });

// --- source pins: the runtime fixes must stay in place ---------------------
const toneSource = fs.readFileSync(path.resolve("services/api/src/domain/tone.ts"), "utf8");
assert.match(
  toneSource,
  /out = repairDroppedModalVerb\(out\);\s*\n\s*out = repairDoubledArticle\(out\);/,
  "applyDeterministicToneOverrides must run both grammar repairs last"
);
assert.match(
  toneSource,
  /if \(hasModalVerbGap\(candidate\) && !hasModalVerbGap\(out\)\) continue;/,
  "tone rewrite application must be verb-loss-safe"
);

const apiSource = fs.readFileSync(path.resolve("services/api/src/index.ts"), "utf8");
assert.doesNotMatch(
  apiSource,
  /\? `the \$\{followUpLabel\}` : "your inquiry"/,
  "regenerate cadence must not re-prefix 'the' onto followUpLabel (it already carries one)"
);
assert.match(
  apiSource,
  /const label = hasSpecificFollowUpModel && followUpLabel \? followUpLabel : "your inquiry";/,
  "regenerate cadence must use followUpLabel as-is"
);

console.log("outbound_grammar_repair_eval passed");
