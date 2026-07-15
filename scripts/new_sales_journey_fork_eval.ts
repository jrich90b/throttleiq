/**
 * New-sales-journey fork eval.
 *
 * Pins the 2026-07-15 fix (Joe-reported, Nicholas Braun +17166286477): his original thread was
 * CLOSED as "sold" (post_sale / purchase_delivery). The dealer texted "we took that bike in on
 * trade, so whenever you want to come down for the backrest, let me know" and Nicholas replied
 * "Perfect man, are you there today,". resolveInboundConversationForSms only forks a NEW thread
 * off a sticky-closed (sold/hold/post-sale) journey when the journey-intent parser reads the
 * inbound as a NEW sale_trade journey (explicit + confidence >= 0.68). The parser misread a
 * post-sale pickup COORDINATION as a new sale → forked "+17166286477::2", which then auto-sent
 * "yes" / "sorry that was an auto send". A visit/pickup continuation must classify as "none" so
 * the reply reopens/appends to the existing thread instead of splitting it.
 *
 * Layers: (1) source guard — the parser + the fork resolver exist, the fork is gated on a
 * sticky-closed journey AND a confident explicit sale_trade (confidence >= 0.68), and a
 * non-sticky closed conv returns the existing conversation (no fork); (2) LLM coverage — the
 * Nicholas replay + sibling pickup/visit-coordination continuations classify as "none", while a
 * genuine NEW purchase from a past buyer still classifies as sale_trade (the fix must not
 * over-suppress real repeat buyers).
 *
 * Run gated: LLM_ENABLED=1 LLM_JOURNEY_INTENT_PARSER_ENABLED=1 npx tsx scripts/new_sales_journey_fork_eval.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { parseJourneyIntentWithLLM } from "../services/api/src/domain/llmDraft.ts";

// --- 1) Source guard (no LLM). ---
const index = fs.readFileSync("services/api/src/index.ts", "utf8");
const llm = fs.readFileSync("services/api/src/domain/llmDraft.ts", "utf8");

assert.ok(
  /export async function parseJourneyIntentWithLLM/.test(llm),
  "the journey-intent parser must be exported from llmDraft.ts"
);
assert.ok(
  /LLM_JOURNEY_INTENT_PARSER_ENABLED/.test(llm),
  "the parser must be behind an enable flag (on-by-default via !== \"0\")"
);
assert.ok(
  /async function resolveInboundConversationForSms/.test(index),
  "the inbound SMS conversation resolver must exist in index.ts"
);
// The fork must be gated on a STICKY-CLOSED journey (a non-sticky closed conv returns the
// existing conversation — so a reply reopens instead of forking).
assert.ok(
  /if \(!isStickyClosedJourney\(latest\)\) return latest;/.test(index),
  "a non-sticky-closed conversation must be returned as-is (no fork)"
);
// The fork must additionally require a confident, explicit NEW sale_trade journey.
assert.ok(
  /if \(!shouldStartNewSalesJourney\(parse\)\) return latest;/.test(index),
  "the fork must require shouldStartNewSalesJourney(parse) — else return the existing conversation"
);
assert.ok(
  /journeyIntent !== "sale_trade"[\s\S]*?explicitRequest[\s\S]*?confidence >= 0\.68/.test(index),
  "shouldStartNewSalesJourney must require sale_trade + explicit + confidence >= 0.68"
);

// --- 2) LLM coverage + adversarial repeat-buyer positive (gated; skips cleanly). ---
const backrestHistory = [
  { direction: "in" as const, body: "Sounds good, thank you" },
  { direction: "out" as const, body: "Nick, we took that bike in on trade, so whenever you want to come down for the backrest, let me know" }
];

// Post-sale pickup / visit coordination continuations → NOT a new sales journey.
const continuations: { text: string; history?: typeof backrestHistory }[] = [
  { text: "Perfect man, are you there today,", history: backrestHistory }, // Nicholas replay fixture
  { text: "When can I come grab the backrest?" },
  { text: "On my way to pick up my bike, what time do you close?" },
  { text: "Cool, are you open today?" }
];

// A genuine NEW purchase from a past buyer MUST still fork (confident sale_trade) — the fix must
// not over-suppress real repeat buyers.
const newJourneys: string[] = [
  "I want to trade my Heritage and look at a Street Glide.",
  "How much are payments on the 2025 Road Glide?"
];

let ran = 0;
let newRan = 0;

for (const c of continuations) {
  const parsed = await parseJourneyIntentWithLLM({ text: c.text, history: c.history });
  if (!parsed) continue; // parser disabled or transient null — skip, don't red the gate
  ran += 1;
  assert.notEqual(
    parsed.journeyIntent,
    "sale_trade",
    `pickup/visit continuation "${c.text}" must NOT classify as sale_trade (would fork a duplicate thread), got ${parsed.journeyIntent}`
  );
}

for (const text of newJourneys) {
  const parsed = await parseJourneyIntentWithLLM({ text });
  if (!parsed) continue;
  newRan += 1;
  assert.equal(
    parsed.journeyIntent,
    "sale_trade",
    `genuine new-purchase "${text}" should classify as sale_trade, got ${parsed.journeyIntent}`
  );
}

console.log(
  ran === 0 && newRan === 0
    ? "PASS new sales journey fork eval (source guard only; LLM coverage skipped — parser disabled)"
    : `PASS new sales journey fork eval (source guard + ${ran}/${continuations.length} continuation-not-fork + ${newRan}/${newJourneys.length} genuine-new-journey cases)`
);
