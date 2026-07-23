/**
 * Customer-disposition parser eval (LLM-backed).
 *
 * Guards the price-objection carve-out. Production incident (Joshua Ricksgers
 * +17162512324, 2026-07-15): to a $22-23k quote an ENGAGED shopper replied "Sounds like it
 * could be a nice bike but a little out of my current price range. Thank you though." The
 * parser classified `defer_no_window` → mapped to `customer_stepping_back` → the live lead
 * was CLOSED/archived with NO reply. A per-unit price objection from a customer who is
 * still shopping is NOT a closeout.
 *
 * Pins:
 *  1) a per-unit price objection from an engaged shopper → `none` (never a closeout);
 *  2) a genuine budget STOP (no continued-shopping signal) still → `defer_no_window`;
 *  3) a price defer WITH a timeframe still → `defer_with_window`.
 * Cases 1 uses a paraphrase (not the verbatim few-shot) to test generalization.
 */
import assert from "node:assert/strict";

import { parseCustomerDispositionWithLLM } from "../services/api/src/domain/llmDraft.ts";

// Dispositions that resolveCustomerDispositionDecision maps to a conversation closeout
// (index.ts): sell_on_own / keep_current_bike / stepping_back / defer_no_window.
const CLOSEOUT_DISPOSITIONS = new Set(["sell_on_own", "keep_current_bike", "stepping_back", "defer_no_window"]);

async function disp(text: string, history?: { direction: "in" | "out"; body: string }[]) {
  const parsed = await parseCustomerDispositionWithLLM({ text, history });
  assert.ok(parsed, `parser returned null for: ${text}`);
  return parsed!;
}

// 1) THE FIX — per-unit price objection from an engaged shopper → not a closeout (none).
const shoppingHistory: { direction: "in" | "out"; body: string }[] = [
  { direction: "in", body: "Just checking in to see if you had anything new come through recently?" },
  { direction: "out", body: "We've got a 2023 Street Glide Special I can do $22,000 - $23,000 on." }
];
const objection = await disp(
  "That's a beautiful bike but it's a bit more than I can spend right now. Let me know if anything else comes in.",
  shoppingHistory
);
assert.ok(
  !CLOSEOUT_DISPOSITIONS.has(objection.disposition),
  `per-unit price objection from an engaged shopper must NOT close the lead — got ${objection.disposition}`
);
assert.equal(
  objection.disposition,
  "none",
  `per-unit price objection should parse as none, got ${objection.disposition}`
);

// 2) REGRESSION GUARD — a genuine budget stop with no continued-shopping signal still defers.
const budgetStop = await disp("Money's just too tight right now, I've got to stop looking for a while.");
assert.equal(
  budgetStop.disposition,
  "defer_no_window",
  `a genuine budget stop should stay defer_no_window, got ${budgetStop.disposition}`
);

// 3) REGRESSION GUARD — a price defer WITH a concrete timeframe stays defer_with_window.
const deferWindow = await disp("Price is too high right now, maybe after my tax return.");
assert.equal(
  deferWindow.disposition,
  "defer_with_window",
  `a price defer with a timeframe should stay defer_with_window, got ${deferWindow.disposition}`
);

// 4) THE FIX — an alert-keeper with a live in-turn ask is not a closeout.
// Production miss (Jaydon Gerolimos +16813891971, 2026-07-22): to a watch alert on a
// 2006 Sportster 883 Low he replied "Im still interested but not in the market right now.
// I do however still like to know when bikes come in! Could o see pictures of that 883 and
// the price?" — parsed as a defer closeout, answered with "I hear you. If anything changes
// down the road, just give me a shout.", and his pictures + price were never sent.
// Paraphrased (not the verbatim few-shot) to test generalization.
const alertKeeper = await disp(
  "Still interested, just not in the market at the moment. I'd still like to hear when bikes show up though. Can you send me some pics of that one and what you want for it?",
  [
    { direction: "out", body: "Hey — a 2006 Sportster 883 Low you were watching for just came in. Are you still looking?" }
  ]
);
assert.ok(
  !CLOSEOUT_DISPOSITIONS.has(alertKeeper.disposition),
  `a deferring customer who asks for pics + price must NOT close the lead — got ${alertKeeper.disposition}`
);
assert.equal(
  alertKeeper.disposition,
  "none",
  `alert-keeper with a live ask should parse as none, got ${alertKeeper.disposition}`
);

// 5) REGRESSION GUARD — deferring with NO ask of our own still closes out.
const deferNoAsk = await disp("I'm not looking right now but I'll get a hold of you when I'm ready.");
assert.equal(
  deferNoAsk.disposition,
  "defer_no_window",
  `a defer with no live ask should stay defer_no_window, got ${deferNoAsk.disposition}`
);

console.log(
  "PASS customer disposition eval — price-objection carve-out + alert-keeper live-ask carve-out (none / defer_no_window / defer_with_window)"
);
