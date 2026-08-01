/**
 * Dealer-agnostic stock-number recognition — eval.
 *
 * Pins the two properties that matter and that nothing else can check:
 *
 *   PORTABILITY — the reader learns the dealer's id format from their own feed. A dealer whose
 *   stock numbers are five plain digits, or digits-dash-digits, works WITHOUT a code change. The
 *   AH-literal ratchet (countAhHardcodes) greps for the words "american harley"/"north tonawanda",
 *   so a hardcoded SHAPE assumption is invisible to it — this eval is the only thing standing
 *   between us and that class of debt. Joe, 2026-08-01: "What if dealers don't use the same number
 *   and letter combinations as we do?"
 *
 *   THE ORIGINAL DEFECT STAYS FIXED, WITH OR WITHOUT A FEED — a phone number is never a stock
 *   number, including at cold start when no shapes have been learned yet (+17164233031,
 *   msg_30b26a65c146e_1777309569346: "Idk actually I should have given his number.  Itz
 *   716-713-8288. His name is Steve" was answered with "I'm not seeing new 2026 Other in stock").
 */
import assert from "node:assert/strict";
import {
  deriveStockIdShapes,
  extractStockIdFromText,
  stockIdMask,
  looksLikeCalendarDate,
  matchesKnownStockIdShape
} from "../services/api/src/domain/stockIdShapes.ts";

// A letter-led dealer (the shape our first dealer happens to use). Deliberately NOT their real
// stock ids: a universal eval asserting a live AH id would be secretly dealer-pinned, which
// eval_suite_manifest:eval fails the build over — and did, on the first run of this file.
const LETTER_LED_FEED = ["T10-26", "X570-24", "S9-25", "AB9-99", "T144-26"];
// A stranger dealer numbering units with five plain digits.
const NUMERIC_DEALER_FEED = ["24601", "24788", "31002"];
// A stranger dealer using digits-dash-digits — the format AH's letter-led rule would have BROKEN.
const DASHED_NUMERIC_DEALER_FEED = ["12-345", "18-902", "7-144"];

const letterLed = deriveStockIdShapes(LETTER_LED_FEED);
const numeric = deriveStockIdShapes(NUMERIC_DEALER_FEED);
const dashedNumeric = deriveStockIdShapes(DASHED_NUMERIC_DEALER_FEED);

let passed = 0;
const check = (id: string, fn: () => void) => {
  fn();
  passed += 1;
};

// --- masks collapse run LENGTHS so a new unit is not unrecognized -----------------------------
check("mask collapses run lengths", () => {
  assert.equal(stockIdMask("T10-26"), "A9-9");
  assert.equal(stockIdMask("X570-24"), "A9-9");
  assert.equal(stockIdMask("AB9-99"), "A9-9");
  assert.equal(stockIdMask("24601"), "9");
  assert.equal(stockIdMask("12-345"), "9-9");
});
check("prose is not a mask", () => {
  assert.equal(stockIdMask(""), null);
  assert.equal(stockIdMask("street glide"), null);
});
check("a letter-led feed reduces to one learned shape", () => {
  assert.equal(letterLed.length, 1, `expected one shape, got ${JSON.stringify(letterLed)}`);
  assert.equal(letterLed[0]!.mask, "A9-9");
});

// --- PORTABILITY: a stranger dealer's format works with no code change ------------------------
check("numeric-only dealer: their stock number is recognized", () => {
  assert.equal(extractStockIdFromText("do you still have 24601?", numeric), "24601");
});
check("numeric-only dealer: a bare small number is NOT a stock number", () => {
  // Length band keeps "I have 2 bikes" from reading as a unit.
  assert.equal(extractStockIdFromText("interested, I have 2 bikes already", numeric), null);
});
check("dashed-numeric dealer: their stock number is recognized", () => {
  // This is the exact format PR #393's letter-led rule would have rejected.
  assert.equal(extractStockIdFromText("is 12-345 still available?", dashedNumeric), "12-345");
});
check("dashed-numeric dealer: a phone number is still not a stock number", () => {
  // The shape MATCHES here, so only the universal phone exclusion saves this dealer.
  assert.equal(extractStockIdFromText("call him at 716-713-8288", dashedNumeric), null);
});
check("a letter-led dealer does not recognize another dealer's format", () => {
  assert.equal(matchesKnownStockIdShape("12-345", letterLed), false);
  assert.equal(matchesKnownStockIdShape("24601", letterLed), false);
});

// --- THE PRODUCTION TURN, at AH and at cold start ---------------------------------------------
const LISA = "Idk actually I should have given his number.  Itz 716-713-8288. His name is Steve";
check("production turn: no stock number at a letter-led dealer", () => {
  assert.equal(extractStockIdFromText(LISA, letterLed), null);
});
check("production turn: no stock number at COLD START (no feed learned)", () => {
  // The fix must not depend on the feed being reachable.
  assert.equal(extractStockIdFromText(LISA, []), null);
});
check("formatted phone numbers are excluded in every punctuation", () => {
  for (const t of ["call him at (716) 713-8288", "716.713.8288", "+1 716 713 8288", "17167138288"]) {
    assert.equal(extractStockIdFromText(t, []), null, `expected no stock id in ${t}`);
    assert.equal(extractStockIdFromText(t, letterLed), null, `expected no stock id in ${t}`);
  }
});

// --- universal exclusions: dates and quantity ranges -------------------------------------------
check("calendar dates are not stock numbers", () => {
  assert.equal(looksLikeCalendarDate("2026-04"), true);
  assert.equal(looksLikeCalendarDate("2026-04-27"), true);
  assert.equal(looksLikeCalendarDate("T10-26"), false);
  assert.equal(extractStockIdFromText("your email said 2026-04 availability", []), null);
});
check("quantity ranges are not stock numbers", () => {
  assert.equal(extractStockIdFromText("looking to buy in 3-4 weeks, any Street Glides?", []), null);
  assert.equal(extractStockIdFromText("interested if you have anything 10-15 thousand", []), null);
  assert.equal(extractStockIdFromText("budget is $12-15k", []), null);
  assert.equal(extractStockIdFromText("can do 2-3 months out", []), null);
});
check("a range unit does not swallow a real stock number", () => {
  // "26" here is part of the id, not a quantity — the unit word must follow the WHOLE token.
  assert.equal(extractStockIdFromText("is T10-26 still around?", letterLed), "T10-26");
});

// --- regression guards: every letter-led shape still reads --------------------------------------------
check("letter-led stock numbers still extract, learned or cold", () => {
  for (const shapes of [letterLed, []]) {
    assert.equal(extractStockIdFromText("Very interested in thw T10-26 street glide !!", shapes), "T10-26");
    assert.equal(extractStockIdFromText("is S9-25 still there?", shapes), "S9-25");
    assert.equal(extractStockIdFromText("interested in T144-26 please", shapes), "T144-26");
    assert.equal(extractStockIdFromText("do you still have AB9-99 in stock", shapes), "AB9-99");
    assert.equal(extractStockIdFromText("still have t10-26?", shapes), "T10-26");
  }
});
check("length band tolerates a longer unit than the feed has today", () => {
  // A brand-new "X5701-24" must not read as unrecognized just because it is one char longer.
  assert.equal(extractStockIdFromText("is X5701-24 in?", letterLed), "X5701-24");
});

console.log(`PASS stock-id shape portability eval (${passed} checks)`);
