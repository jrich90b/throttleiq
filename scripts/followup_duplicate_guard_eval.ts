import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";

function normalizeOutboundText(text: string): string {
  return String(text ?? "").toLowerCase().replace(/\s+/g, " ").trim();
}

const CADENCE_SIMILARITY_STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "can",
  "did",
  "do",
  "for",
  "from",
  "get",
  "got",
  "have",
  "i",
  "if",
  "in",
  "is",
  "it",
  "just",
  "let",
  "me",
  "my",
  "of",
  "on",
  "or",
  "our",
  "so",
  "still",
  "that",
  "the",
  "this",
  "to",
  "we",
  "what",
  "when",
  "which",
  "with",
  "you",
  "your"
]);

function cadenceSimilarityTokens(text: string): Set<string> {
  const normalized = normalizeOutboundText(text)
    .replace(/[']/g, "")
    .replace(/[^a-z0-9\s]/g, " ");
  const out = new Set<string>();
  for (const token of normalized.split(/\s+/)) {
    if (!token) continue;
    if (CADENCE_SIMILARITY_STOP_WORDS.has(token)) continue;
    if (token.length <= 2 && !/^\d+$/.test(token)) continue;
    out.add(token);
  }
  return out;
}

function cadenceTokenOverlapScore(a: string, b: string): number {
  const left = cadenceSimilarityTokens(a);
  const right = cadenceSimilarityTokens(b);
  if (!left.size || !right.size) return 0;
  let overlap = 0;
  for (const token of left) {
    if (right.has(token)) overlap += 1;
  }
  return overlap / Math.min(left.size, right.size);
}

function isInventoryUnavailableCadenceText(text: string): boolean {
  const normalized = normalizeOutboundText(text);
  if (!normalized) return false;
  const unavailable =
    /\b(bike|unit|that|specific)\b.{0,80}\b(has sold|sold|no longer available|on hold|hold right now)\b/.test(
      normalized
    ) ||
    /\b(has sold|no longer available|on hold|hold right now)\b/.test(normalized);
  const nextStep =
    /\b(check inventory|choose another bike|similar options|keep an eye|opens back up|available again)\b/.test(
      normalized
    );
  return unavailable && nextStep;
}

const exactUnitDraft =
  "Hey Lizbeth, I know you were interested in the 2022 Iron 883, but that bike has sold. If you want, I can check inventory with you so you can choose another bike.";
const familyFallbackDraft =
  "Hey Lizbeth, I know you were interested in the Sportster, but that bike has sold. If you want, I can check inventory with you so you can choose another bike.";
const unrelatedDraft =
  "Hey Lizbeth, we have fresh Nightster options in stock if you want current photos.";

assert.equal(isInventoryUnavailableCadenceText(exactUnitDraft), true);
assert.equal(isInventoryUnavailableCadenceText(familyFallbackDraft), true);
assert.equal(isInventoryUnavailableCadenceText(unrelatedDraft), false);
assert.ok(
  cadenceTokenOverlapScore(exactUnitDraft, familyFallbackDraft) >= 0.82,
  "sold update drafts with exact-unit vs family labels should be near-duplicate candidates"
);

const apiSource = await fs.readFile(path.resolve("services/api/src/index.ts"), "utf8");
assert.match(apiSource, /let followUpsRunning = false;/, "follow-up scheduler needs an overlap lock");
assert.match(
  apiSource,
  /if \(followUpsRunning\) \{[\s\S]*?skipped overlapping run[\s\S]*?return;/,
  "overlapping follow-up runs must be skipped"
);
assert.match(
  apiSource,
  /function isInventoryUnavailableCadenceText\([\s\S]*?check inventory[\s\S]*?choose another bike[\s\S]*?similar options/,
  "inventory unavailable cadence text classifier must remain present"
);
assert.match(
  apiSource,
  /nearDuplicate\?: boolean;/,
  "recent outbound duplicate guard must expose nearDuplicate option"
);
assert.match(
  apiSource,
  /providers: \["draft_ai"\],[\s\S]*?windowMs: 2 \* 60 \* 1000,[\s\S]*?nearDuplicate: true/,
  "suggest-mode follow-up drafts must use near-duplicate suppression"
);
assert.match(
  apiSource,
  /providers: isPostSale \? \["human", "twilio"\] : \["human", "twilio", "draft_ai"\],[\s\S]*?nearDuplicate: true/,
  "SMS fallback follow-up sends must suppress recent near-duplicate drafts"
);

console.log("followup_duplicate_guard_eval passed");
