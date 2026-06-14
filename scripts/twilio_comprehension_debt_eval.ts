/**
 * Twilio comprehension-debt ratchet (AGENTS.md "Twilio conversations: comprehend,
 * never regex"). The /webhooks/twilio handler still comprehends customer intent
 * with regex/keyword `isXText()` guards instead of the LLM parser — years of
 * accumulated debt that can't be safely rewritten in one pass. This ratchet
 * makes the debt visible, FAILS ci:eval if it grows (so any new conversational
 * intent must be parser-first), and only drops as guards are migrated.
 *
 * To migrate a guard: replace its use in the twilio handler with a typed intent
 * parser + replay fixture (AGENTS.md Parser-First Rule), then LOWER BASELINE.
 * Never raise BASELINE to land a new regex intent — that's the whole point.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

// The current comprehension-debt count. RATCHET DOWN ONLY.
// 42 -> 41: retired isScheduleContextStatusUpdateText (visit-commitment routing is
// now parser-first via scheduleStatusCommitmentOutranksArrivalAck). Migration #1.
const BASELINE = 41;

// Pure no-reply / safety / compliance gates — allowed to read customer text
// (they suppress or hand off; they do not compose a comprehension reply).
const SAFETY_ALLOWLIST = new Set([
  "isShortAckText",
  "isShortAckNoReplyText",
  "isEmojiOnlyText",
  "isWrongNumberText",
  "isQuotedReactionInboundText",
  "isCloseoutSignoffNoResponseText"
]);

const src = fs.readFileSync(path.resolve("services/api/src/index.ts"), "utf8").split(/\r?\n/);
const start = src.findIndex(l => l.includes('app.post("/webhooks/twilio"'));
assert.ok(start >= 0, "twilio handler must exist");
let end = src.length;
for (let i = start + 1; i < src.length; i += 1) {
  if (/^app\.(post|get)\(/.test(src[i])) { end = i; break; }
}
const handler = src.slice(start, end).join("\n");

const guards = [...new Set([...handler.matchAll(/\bis[A-Z][A-Za-z]+Text\b/g)].map(m => m[0]))]
  .filter(g => !SAFETY_ALLOWLIST.has(g))
  .sort();

console.log(`Twilio comprehension-debt guards (intent comprehended by regex, should be parser-first): ${guards.length}`);
for (const g of guards) console.log(`  - ${g}`);

assert.ok(
  guards.length <= BASELINE,
  `Twilio comprehension debt grew to ${guards.length} (baseline ${BASELINE}). A new customer intent was handled with regex — make it parser-first instead (AGENTS.md). Do NOT raise BASELINE.`
);
if (guards.length < BASELINE) {
  console.log(`\nNote: debt is below baseline (${guards.length} < ${BASELINE}). Lower BASELINE to ${guards.length} to lock in the burndown.`);
}
console.log(`PASS twilio comprehension-debt ratchet (${guards.length}/${BASELINE})`);
