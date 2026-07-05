/**
 * Draft brevity eval (closed-loop voice fix, 2026-06-24).
 *
 * "Reply says too much" is the #1 staff thumbs-down class (Phase 2 report: 40%). The fix is a voice
 * change — tighter SMS brevity rules in the generator prompt — plus a deterministic shadow signal to
 * measure whether drafts still run long. This pins:
 *  1) the pure brevity budget helper (deterministic),
 *  2) the prompt actually carries the strengthened brevity directive,
 *  3) the shadow signal is wired (logging only — never trims/blocks).
 *
 * Run: npx tsx scripts/draft_brevity_eval.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";

// llmDraft constructs an OpenAI client at module scope; give it a dummy key so the import doesn't
// throw (this eval never makes an LLM call — it only tests the pure helper + source).
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "eval-no-live-key";
const { exceedsSmsBrevityBudget } = await import("../services/api/src/domain/llmDraft.ts");

// --- 1) Pure brevity budget. ---
const short = "It is! Want to swing by this week to take a look?";
assert.equal(exceedsSmsBrevityBudget(short), false, "a 1–2 sentence reply is within budget");
assert.equal(exceedsSmsBrevityBudget(""), false, "empty is not 'too long'");
assert.equal(exceedsSmsBrevityBudget("One. Two. Three. Four."), false, "4 sentences is the ceiling, not over");
assert.equal(exceedsSmsBrevityBudget("One. Two. Three. Four. Five."), true, "5+ sentences is too long");
// The compliance footer must not count against brevity.
assert.equal(
  exceedsSmsBrevityBudget("Sounds good, I'll text you when it's in. Reply STOP to opt out."),
  false,
  "the STOP footer is excluded from the budget"
);
// Sentence-budget path: an overloaded multi-sentence reply trips it.
const sixSentences =
  "Thanks! Option one is the Nightster. Option two is the Forty-Eight. Option three is the 1200 Custom. " +
  "Option four is the Street Glide. Want me to run numbers on all of them?";
assert.equal(exceedsSmsBrevityBudget(sixSentences), true, "6 sentences exceeds the sentence budget");
// Char-budget path: a very long reply trips it even without many sentence breaks.
const longChars = "we have lots of options to share with you ".repeat(15); // ~630 chars
assert.ok(longChars.length > 480, "fixture sanity: the long reply is actually long");
assert.equal(exceedsSmsBrevityBudget(longChars), true, "a very long reply exceeds the char budget");
// Threshold is tunable.
assert.equal(exceedsSmsBrevityBudget(short, { maxSentences: 1 }), true, "stricter sentence budget flags 2 sentences");

// --- 2) Source guard: the generator prompt carries the brevity directive + the shadow hook. ---
const llm = fs.readFileSync("services/api/src/domain/llmDraft.ts", "utf8");
assert.match(llm, /export function exceedsSmsBrevityBudget/, "the brevity helper must be exported");
assert.match(llm, /SMS RULES \(strict\):/, "the SMS rules block must exist");
assert.match(llm, /BE BRIEF\./, "the SMS rules must carry the strengthened brevity directive");
assert.match(llm, /Answer ONLY what the customer/, "the rules must scope the reply to the actual ask");
assert.match(llm, /At most ONE question per message/, "the rules must cap questions");
assert.match(llm, /\[draft-brevity-shadow\]/, "the brevity shadow signal must be wired");
assert.match(llm, /DRAFT_BREVITY_SHADOW/, "the shadow signal must have a kill switch");

console.log("PASS draft brevity eval (budget helper + prompt directive + shadow signal)");
