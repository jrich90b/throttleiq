/**
 * Computer-like / banned-phrase guard eval (2026-06-19).
 *
 * Joe's directive: every customer-facing message should sound like a real American H-D employee,
 * never a computer — certain phrases are banned outright. This pins the curated denylist + the
 * word-boundary matcher + the universal draft-sink shadow hook.
 *
 * Deterministic (no LLM) — always runs. Three layers:
 *  1) Source guard: the module exports a non-empty list + matcher, and the shadow hook is wired
 *     into appendOutbound (the ONE sink every AI draft — replies AND cadence — passes through),
 *     behind the VOICE_BANNED_PHRASE_SHADOW flag, logging-only (never mutates the draft).
 *  2) Detection: every listed phrase is found when present.
 *  3) Precision: word-boundary matching does NOT false-fire ("as per" must not trip inside "as
 *     personal"), and our gold-standard reps' real texts produce ZERO hits (we never flag good copy).
 *
 * Run: npx tsx scripts/voice_banned_phrase_eval.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  COMPUTER_LIKE_PHRASES,
  findComputerLikePhrases,
  hasComputerLikePhrase
} from "../services/api/src/domain/voiceBannedPhrases.ts";

// --- 1) Source guard. ---
assert.ok(Array.isArray(COMPUTER_LIKE_PHRASES) && COMPUTER_LIKE_PHRASES.length >= 25, "denylist must be a non-trivial list");
assert.ok(new Set(COMPUTER_LIKE_PHRASES).size === COMPUTER_LIKE_PHRASES.length, "denylist must have no duplicates");
// A few non-negotiable computer-like tells must be on the list.
for (const must of ["reach out", "feel free to", "rest assured", "utilize", "seamless", "happy to assist"]) {
  assert.ok(COMPUTER_LIKE_PHRASES.includes(must), `denylist must include "${must}"`);
}
const store = fs.readFileSync("services/api/src/domain/conversationStore.ts", "utf8");
assert.ok(/findComputerLikePhrases/.test(store), "the matcher must be wired into conversationStore.ts");
assert.ok(/VOICE_BANNED_PHRASE_SHADOW/.test(store), "the shadow flag must gate the hook");
assert.ok(/\[voice-banned-phrase-shadow\]/.test(store), "the shadow hook must log a greppable trace line");
// Hook must sit on the draft_ai branch (AI drafts only — not human/twilio sends).
assert.ok(/provider === "draft_ai" && String\(process\.env\.VOICE_BANNED_PHRASE_SHADOW/.test(store), "hook must be scoped to provider draft_ai");

// --- 2) Detection: every listed phrase is found in a sentence that contains it. ---
for (const phrase of COMPUTER_LIKE_PHRASES) {
  const sentence = `Just a quick note ${phrase} and thanks again for your time.`;
  const hits = findComputerLikePhrases(sentence);
  assert.ok(hits.includes(phrase), `"${phrase}" should be detected in: ${sentence}`);
  assert.ok(hasComputerLikePhrase(sentence), `hasComputerLikePhrase should be true for: ${sentence}`);
}

// --- 3a) Precision: word boundaries must not false-fire. ---
const personal = "Sounds good — that's my read as personal preference, not a push.";
assert.ok(
  !findComputerLikePhrases(personal).includes("as per"),
  `"as per" must NOT fire inside "as personal": ${personal}`
);
// "use" is fine; only "utilize" is banned.
assert.ok(!hasComputerLikePhrase("Want to use it this weekend?"), '"use" must be clean (only "utilize" is banned)');

// --- 3b) Our gold-standard reps' real texts must produce ZERO hits. ---
const goldStandard: string[] = [
  "Hi Darwin — this is Scott at American Harley-Davidson. Thanks for stopping in, it was nice chatting with you. Let me know if you have any questions about the Fat Boy.",
  "this is Scott from American H-D. You requested a test ride on a Heritage a little while back. Are you still interested in riding one?",
  "Hey charlie, still leaning toward the Fat Bob 114 or still comparing?",
  "We currently do not have a 2025 Heritage in stock. We do however have a 2026. Would you be interested in that one? It's Brilliant Red with black cast wheels.",
  "Was there another bike that peaked your interest?"
];
for (const line of goldStandard) {
  const hits = findComputerLikePhrases(line);
  assert.equal(hits.length, 0, `gold-standard rep line must be clean, got hits [${hits.join(", ")}]: ${line}`);
}

console.log(
  `PASS voice banned-phrase eval (source guard + ${COMPUTER_LIKE_PHRASES.length} phrases detected + boundary precision + ${goldStandard.length} gold-standard clean lines)`
);
