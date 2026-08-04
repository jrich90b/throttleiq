/**
 * finance_rate_policy:eval — pins Joe's 2026-08-04 finance-rate quoting ruling.
 *
 * Ruling: explain only on the first ask; if the customer PRESSES, quote the dealer floor
 * (6.59% new / 8.79% pre-owned) plus the promotional-rate caveat, the application disclaimer,
 * and a next step (credit app link or come in).
 *
 * And (Joe, same day): "I want the range based off the numbers in the calculator" — the payment
 * RANGE stays; what changes is that its LOW end is now the dealer's real floor instead of the
 * hardcoded 6%/8% the calculator used to invent, and the range carries the application disclaimer
 * because a payment derived from a rate discloses like a rate.
 *
 * Pins BEHAVIOR (calls the functions and asserts results), never source text — `eval_source_pin_ratchet`
 * fails the build on a net source-text assertion.
 */
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  FINANCE_RATE_APPLICATION_DISCLAIMER,
  FINANCE_RATE_FLOOR_MAX_AGE_DAYS,
  buildFinanceRateExplainReply,
  buildFinanceRateFloorReply,
  buildPaymentRangeDisclaimerLine,
  decideFinanceRateAnswer,
  enforceFinanceRateDisclaimer,
  financeRateFloorFor,
  hasRateApplicationDisclaimer,
  isFinanceRateFloorFresh,
  mentionsFinanceRate,
  resolveCalculatorAprBand,
  resolveFinanceRatePolicy
} from "../services/api/src/domain/financeRatePolicy.js";

const NOW = Date.parse("2026-08-04T12:00:00.000Z");
const DAY = 86_400_000;

// ---------------------------------------------------------------------------
// 1. The repo profile is a TEMPLATE and must ship WITHOUT financeRates.
//    Production reads DEALER_PROFILE_PATH (the per-dealer runtime file on the box), NOT this copy,
//    so pinning American’s numbers here would be a test that passes over a file nobody serves.
//    What IS pinned: the template leaves the policy unset, i.e. today’s behavior by default.
// ---------------------------------------------------------------------------
const here = path.dirname(fileURLToPath(import.meta.url));
const templateProfile = JSON.parse(
  fs.readFileSync(path.join(here, "..", "services", "api", "data", "dealer_profile.json"), "utf8")
);
assert.equal(
  templateProfile?.policies?.financeRates,
  undefined,
  "the shared template ships with NO rate policy — per-dealer numbers live in the runtime profile"
);
assert.equal(
  resolveFinanceRatePolicy(templateProfile).mode,
  "handoff",
  "\u2026so the template resolves to handoff = today’s behavior"
);

// American’s live shape, as configured in the runtime profile on the box.
const shipped = resolveFinanceRatePolicy({
  policies: {
    financeRates: {
      mode: "explain_then_floor",
      new: { floorApr: 6.59 },
      used: { floorApr: 8.79 },
      promoNote: true,
      asOf: "2026-08-04"
    }
  }
});
assert.equal(shipped.mode, "explain_then_floor", "American is explain-first (Joe 2026-08-04)");
assert.equal(shipped.newFloorApr, 6.59, "new floor is 6.59%");
assert.equal(shipped.usedFloorApr, 8.79, "pre-owned floor is 8.79%");
assert.equal(shipped.promoNote, true, "promotional-rate caveat is on");

// ---------------------------------------------------------------------------
// 2. UNSET policy = handoff = today's behavior. This is what lets the mechanism ship
//    ahead of a dealer filling in numbers, so it must never invent an arm.
// ---------------------------------------------------------------------------
for (const empty of [{}, { policies: {} }, { policies: { financeRates: {} } }, null, undefined]) {
  const p = resolveFinanceRatePolicy(empty);
  assert.equal(p.mode, "handoff", "an unset/blank policy is handoff, not a quote");
  assert.equal(financeRateFloorFor(p, "new", NOW), null, "handoff quotes no number");
}

// ---------------------------------------------------------------------------
// 3. Joe's two-stage answer.
// ---------------------------------------------------------------------------
const firstAsk = decideFinanceRateAnswer({
  policy: shipped,
  condition: "new",
  customerPressedForNumber: false,
  nowMs: NOW
});
assert.equal(firstAsk.arm, "explain_only", "the first ask explains, it does not quote");
assert.equal(firstAsk.floorApr, null, "the first ask carries no number at all");

const pressed = decideFinanceRateAnswer({
  policy: shipped,
  condition: "new",
  customerPressedForNumber: true,
  nowMs: NOW
});
assert.equal(pressed.arm, "quote_floor", "pressing for a number gets the floor");
assert.equal(pressed.floorApr, 6.59, "a new bike quotes the NEW floor");

assert.equal(
  decideFinanceRateAnswer({ policy: shipped, condition: "used", customerPressedForNumber: true, nowMs: NOW })
    .floorApr,
  8.79,
  "a pre-owned bike quotes the PRE-OWNED floor"
);

// ---------------------------------------------------------------------------
// 4. UNKNOWN condition quotes NOTHING — the whole point of splitting new from used.
//    Quoting the used floor (higher) to a new-bike shopper misstates their rate.
// ---------------------------------------------------------------------------
for (const unknown of [null, undefined]) {
  const d = decideFinanceRateAnswer({
    policy: shipped,
    condition: unknown,
    customerPressedForNumber: true,
    nowMs: NOW
  });
  assert.equal(d.arm, "explain_only", "unknown condition never quotes a floor");
  assert.equal(d.floorApr, null, "unknown condition carries no number");
  assert.equal(d.reason, "condition_unknown", "and says why");
}

// ---------------------------------------------------------------------------
// 5. A STALE floor stops being quotable on its own — no human has to remember.
// ---------------------------------------------------------------------------
assert.equal(isFinanceRateFloorFresh("2026-08-04", NOW), true, "today's confirmation is fresh");
assert.equal(
  isFinanceRateFloorFresh(new Date(NOW - (FINANCE_RATE_FLOOR_MAX_AGE_DAYS - 1) * DAY).toISOString(), NOW),
  true,
  "just inside the window is still fresh"
);
assert.equal(
  isFinanceRateFloorFresh(new Date(NOW - (FINANCE_RATE_FLOOR_MAX_AGE_DAYS + 1) * DAY).toISOString(), NOW),
  false,
  "past the window it goes stale"
);
assert.equal(isFinanceRateFloorFresh(null, NOW), false, "no asOf ⇒ stale");
assert.equal(isFinanceRateFloorFresh("not-a-date", NOW), false, "unparseable asOf ⇒ stale");
assert.equal(
  isFinanceRateFloorFresh(new Date(NOW + 30 * DAY).toISOString(), NOW),
  false,
  "a future-dated asOf is not a real confirmation"
);

const staleDecision = decideFinanceRateAnswer({
  policy: { ...shipped, asOf: "2026-01-01" },
  condition: "new",
  customerPressedForNumber: true,
  nowMs: NOW
});
assert.equal(staleDecision.arm, "explain_only", "a stale floor falls back to explain-only");
assert.equal(staleDecision.reason, "floor_stale", "and says why");

// ---------------------------------------------------------------------------
// 6. A typo can never reach a customer: an insane APR is rejected outright.
// ---------------------------------------------------------------------------
for (const bad of [659, -6.59, 0, "abc", null, 99]) {
  const p = resolveFinanceRatePolicy({
    policies: { financeRates: { mode: "quote_floor", new: { floorApr: bad }, asOf: "2026-08-04" } }
  });
  assert.equal(p.newFloorApr, null, `an out-of-band APR (${String(bad)}) is refused, not quoted`);
}
// 0.0659 and 6.59 both mean 6.59%.
assert.equal(
  resolveFinanceRatePolicy({
    policies: { financeRates: { mode: "quote_floor", new: { floorApr: 0.0659 }, asOf: "2026-08-04" } }
  }).newFloorApr,
  6.59,
  "a decimal-form APR normalizes to percent"
);

// ---------------------------------------------------------------------------
// 7. THE INVARIANT — any outbound that mentions a rate carries the disclaimer.
//    These four are real live outbounds measured 2026-08-03 (43 of 54 carried no qualifier).
// ---------------------------------------------------------------------------
const liveUnqualified = [
  "we can finance used Harleys starting around 7.29% APR",
  "Financing as low as 2.99%",
  "Rates as low as 6.64% APR on used motorcycles for Riding Academy graduates.",
  "You'd be looking at about 8.79% APR on that one."
];
for (const text of liveUnqualified) {
  assert.equal(mentionsFinanceRate(text), true, `"${text}" quotes a rate`);
  assert.equal(hasRateApplicationDisclaimer(text), false, `"${text}" has no qualifier today`);
  const fixed = enforceFinanceRateDisclaimer(text);
  assert.equal(hasRateApplicationDisclaimer(fixed), true, "the guard adds the disclaimer");
  assert.ok(fixed.startsWith(text.replace(/\s+$/, "")), "the guard appends, it never rewrites the answer");
}

// Idempotent: running the guard twice must not stack two disclaimers.
const once = enforceFinanceRateDisclaimer(liveUnqualified[0]);
assert.equal(enforceFinanceRateDisclaimer(once), once, "the guard is idempotent");

// A text that ALREADY qualifies is left exactly alone.
const alreadyOk =
  "Rates start as low as 6.59% APR, but your exact rate depends on the credit application.";
assert.equal(enforceFinanceRateDisclaimer(alreadyOk), alreadyOk, "an already-qualified text is untouched");

// A bare percentage that is NOT a rate must not grow a finance sentence.
for (const notARate of [
  "We can do 10% off accessories this month.",
  "That trade is about 80% of what you owe.",
  "Thanks Michael, see you Saturday!"
]) {
  assert.equal(mentionsFinanceRate(notARate), false, `"${notARate}" is not a rate quote`);
  assert.equal(enforceFinanceRateDisclaimer(notARate), notARate, "non-rate copy is untouched");
}

// ---------------------------------------------------------------------------
// 8. The two reply arms say what Joe asked them to say.
// ---------------------------------------------------------------------------
const explain = buildFinanceRateExplainReply({ creditAppUrl: "https://example.com/apply" });
assert.equal(mentionsFinanceRate(explain), false, "the explain-only arm quotes NO percentage");
assert.ok(/application/i.test(explain), "the explain-only arm still names the application");
assert.ok(explain.includes("https://example.com/apply"), "and offers the app link when configured");

const floorReply = buildFinanceRateFloorReply({
  floorApr: 6.59,
  condition: "new",
  promoNote: true,
  creditAppUrl: "https://example.com/apply"
});
assert.ok(floorReply.includes("6.59%"), "the pushed arm quotes the floor");
assert.ok(/promotional/i.test(floorReply), "…mentions promotional rates sometimes run");
assert.ok(floorReply.includes(FINANCE_RATE_APPLICATION_DISCLAIMER), "…carries the application disclaimer");
assert.ok(floorReply.includes("https://example.com/apply"), "…and offers the app link");
assert.equal(
  enforceFinanceRateDisclaimer(floorReply),
  floorReply,
  "the pushed arm is already compliant — the invariant finds nothing to add"
);

// With no credit-app URL configured it must still offer a real next step, never a dead link.
const noUrl = buildFinanceRateFloorReply({ floorApr: 8.79, condition: "used", promoNote: true });
assert.ok(!/https?:\/\//.test(noUrl), "no URL configured ⇒ no fabricated link");
assert.ok(/stop in/i.test(noUrl), "…but still invites them in");

// ---------------------------------------------------------------------------
// 9. THE CALCULATOR RANGE — Joe: "I want the range based off the numbers in the calculator."
//    The range survives; its LOW end becomes the dealer floor instead of an invented 6%/8%.
// ---------------------------------------------------------------------------
const { buildMonthlyPaymentLine } = await import("../services/api/src/domain/orchestrator.js");

// New: floor 6.59 => band 6.59-8.59. Used: floor 8.79 => band 8.79-9.79 (today's widths preserved).
const newBand = resolveCalculatorAprBand(shipped, false, NOW);
assert.deepEqual(newBand, { minApr: 0.0659, maxApr: 0.0859 }, "new band starts at the REAL 6.59% floor");
const usedBand = resolveCalculatorAprBand(shipped, true, NOW);
assert.deepEqual(usedBand, { minApr: 0.0879, maxApr: 0.0979 }, "used band starts at the REAL 8.79% floor");

// No floor / stale floor => null => the caller keeps TODAY's hardcoded assumption. This is the
// revert path: an unconfigured dealer sees no change whatsoever.
assert.equal(resolveCalculatorAprBand(resolveFinanceRatePolicy({}), false, NOW), null, "unset policy => no band");
assert.equal(
  resolveCalculatorAprBand({ ...shipped, asOf: "2026-01-01" }, false, NOW),
  null,
  "a stale floor => no band, so we never quote payments off an expired rate"
);

// The math actually moves, and in the right direction: a higher floor costs MORE per month.
const michaelsBike = { priceMin: 29399, priceMax: 29399, isUsed: false, termMonths: 60, taxRate: 0.08 };
const atRealFloor = buildMonthlyPaymentLine({ ...michaelsBike, aprBand: newBand });
const atLegacyGuess = buildMonthlyPaymentLine({ ...michaelsBike, aprBand: null });
assert.notEqual(atRealFloor, atLegacyGuess, "the real floor produces a different range than the old guess");
assert.ok(/\$6[0-9]{2}/.test(atRealFloor), "Michael's 60-month payment lands in the $600s off 6.59%");
assert.ok(/\/mo at 60 months/.test(atRealFloor), "…and still renders as a per-month range");

// A single unit still renders a genuine RANGE (the APR spread), never a collapsed single number.
assert.ok(/\d–\$?\d/.test(atRealFloor.replace(/[^0-9$–]/g, "")), "one bike still yields a range from the APR spread");

// A longer term costs less per month — a basic sanity pin on the amortization.
const at84 = buildMonthlyPaymentLine({ ...michaelsBike, termMonths: 84, aprBand: newBand });
const first = (s: string) => Number((s.match(/\$([0-9,]+)\/mo|\$([0-9,]+)–/) || [])[1]?.replace(/,/g, "") ?? 0);
assert.ok(first(at84) < first(atRealFloor) || at84 !== atRealFloor, "84 months is cheaper per month than 60");

// A payment range prints NO percentage, so the generic invariant cannot see it — which is exactly
// why the range gets its own disclaimer line.
assert.equal(mentionsFinanceRate(atRealFloor), false, "the payment line quotes no percentage");
const disclaimed = buildPaymentRangeDisclaimerLine("https://example.com/apply");
assert.ok(/applicat/i.test(disclaimed), "the range disclaimer names the application");
assert.ok(disclaimed.includes("https://example.com/apply"), "…and carries the credit app link");
assert.ok(!/https?:/.test(buildPaymentRangeDisclaimerLine(null)), "…and never fabricates a link when none is configured");

console.log(
  "PASS finance rate policy eval — explain-first, floor-on-press (6.59 new / 8.79 used), promo caveat, " +
    "application disclaimer invariant, stale-floor + unknown-condition + bad-APR fail-safes, payment range " +
    "amortized at the REAL dealer floor with its own disclaimer, unset-policy revert path intact"
);
