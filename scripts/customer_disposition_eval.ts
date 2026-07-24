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

// 6) THE FIX (Joe ruling 2026-07-23) — a decide-soon turn is a WINDOWED defer with the vague
// near-term phrase in the structured timeframe slot (feeds decideDecideSoonTurn → dated 2-3 day
// owner check-in task). Production replay (Dennis Daffron +16303628805, 2026-07-23): hot
// out-of-state buyer comparing dealers, "I should have a decision soon. Then ill leave a
// deposit..." — must NEVER read as a no-window defer (that maps toward a closeout) or none.
const decideSoon = await disp(
  "Okay.  Im waiting on two other dealers to get back to me.  I should have a decision soon. Then ill leave a deposit and talk financing or cash price at that point.",
  [
    { direction: "in", body: "Do you offer shipping to Illinois" },
    { direction: "out", body: "We can line up shipping. I just would not be able to guarantee delivery timing." }
  ]
);
assert.ok(
  !CLOSEOUT_DISPOSITIONS.has(decideSoon.disposition),
  `a decide-soon buyer must NOT close the lead — got ${decideSoon.disposition}`
);
assert.equal(
  decideSoon.disposition,
  "defer_with_window",
  `a decide-soon turn should parse as defer_with_window, got ${decideSoon.disposition}`
);
assert.ok(
  /\b(soon|shortly)\b/i.test(String(decideSoon.timeframeText ?? "")),
  `the vague near-term phrase must land in the structured timeframe slot, got "${decideSoon.timeframeText}"`
);

// 7) THE FIX — "sell outright" is dealer parlance for selling the bike TO US for cash, an
// acquisition lead, NOT sell_on_own. Production replay (Josh Kiddy +17169831712, 2026-07-23):
// staff (in takeover) asked "are you looking into trading the bike in or you want to sell
// outright?" and he answered "Sell it outright." The parser returned sell_on_own @0.98 →
// customer_sell_on_own → the conversation was CLOSED, cadence paused_indefinite, inventory
// watches paused, and he got "I hear you. If anything changes down the road, just give me a
// shout." A customer handing us used inventory was durably parked.
const sellOutright = await disp("Sell it outright.", [
  { direction: "in", body: "Just seeing what my bike is worth" },
  { direction: "out", body: "are you looking into trading the bike in or you want to sell outright?" }
]);
assert.ok(
  !CLOSEOUT_DISPOSITIONS.has(sellOutright.disposition),
  `selling the bike TO US must NOT close the lead — got ${sellOutright.disposition}`
);
assert.equal(
  sellOutright.disposition,
  "none",
  `"sell it outright" should parse as none, got ${sellOutright.disposition}`
);
assert.equal(
  sellOutright.sellToDealerInterest,
  true,
  `"sell it outright" must set the sell_to_dealer_interest slot (feeds decideSellToDealerTurn)`
);

// 7b) GENERALIZATION — no staff anchor, paraphrased (NOT the verbatim few-shot). On current
// main this parsed sell_on_own @0.95: the most explicit "I'm selling my bike TO YOU" sentence
// in the language was closing the lead.
const sellOutrightNoAnchor = await disp(
  "I'd rather you guys just buy it from me outright instead of trading it in."
);
assert.ok(
  !CLOSEOUT_DISPOSITIONS.has(sellOutrightNoAnchor.disposition),
  `an unanchored outright-sale offer must NOT close the lead — got ${sellOutrightNoAnchor.disposition}`
);
assert.equal(
  sellOutrightNoAnchor.sellToDealerInterest,
  true,
  `an unanchored outright-sale offer must set sell_to_dealer_interest`
);

// 7c) REGRESSION GUARD — a genuine sell-it-without-us still closes out (protects EXAMPLE B).
const sellPrivately = await disp("I think I'll just list it on Marketplace and sell it privately.");
assert.equal(
  sellPrivately.disposition,
  "sell_on_own",
  `selling it privately should stay sell_on_own, got ${sellPrivately.disposition}`
);
assert.ok(
  !sellPrivately.sellToDealerInterest,
  `selling it privately must NOT set sell_to_dealer_interest`
);

console.log(
  "PASS customer disposition eval — price-objection carve-out + alert-keeper live-ask carve-out + decide-soon window + sell-outright-to-dealer carve-out (none / defer_no_window / defer_with_window / sell_on_own)"
);
