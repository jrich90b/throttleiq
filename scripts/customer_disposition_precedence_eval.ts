/**
 * Customer-disposition precedence eval (pure, no LLM).
 *
 * THE MOST EXPENSIVE MISFIRE IN THE SYSTEM. This decision does not change a reply — it CLOSES a
 * lead: `customer_stepping_back` / `customer_sell_on_own` sets the dialog state and stops the
 * follow-up cadence.
 *
 * Measured over four live days (2026-08-02..05): **516 calls to customer_disposition_parser,
 * 0 accepted.** `isDispositionParserAccepted` needs `explicitDisposition === true` AND
 * `disposition !== "none"` AND confidence >= 0.74, and that never all held. So closure ran entirely
 * on `parseCustomerDispositionFallback` — a keyword scan for
 * "can't afford | too expensive | too high | out of budget | hold off | I'll pass" — while the
 * parser's reading of every one of those 516 turns was thrown away.
 *
 * The turn that shows the cost, parser answered `none` at 0.93:
 *   "I took a look at those programs the interest rate is just too high. Those rates are not
 *    competitive in the market."
 * A buyer negotiating financing. The scan matches "too high", marks him stepping back, and the
 * follow-ups stop.
 *
 * The fix is narrow and the measurement — not an argument — is what makes it safe: since nothing is
 * ever accepted, closure happens only through the scan today. Blocking on `none` removes exactly the
 * closures the parser said were not dispositions. A hedged `stepping_back` still reaches the scan
 * and still closes, so real walk-aways are untouched.
 *
 * Run: npx tsx scripts/customer_disposition_precedence_eval.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { resolveCustomerDispositionSource } from "../services/api/src/domain/inboundPipeline.ts";

type Row = {
  id: string;
  parserAccepted: boolean;
  parsedDisposition: string | null;
  hasParse: boolean;
  want: "parser" | "none" | "fallback";
  why: string;
};

const table: Row[] = [
  {
    id: "accepted_parser_wins",
    parserAccepted: true,
    parsedDisposition: "stepping_back",
    hasParse: true,
    want: "parser",
    why: "an accepted disposition is the answer — unchanged"
  },
  {
    id: "THE_FIX_rate_negotiation_is_not_a_walk_away",
    parserAccepted: false,
    parsedDisposition: "none",
    hasParse: true,
    want: "none",
    why: '"the interest rate is just too high" — parser said none at 0.93; the scan matched "too high" and closed the lead'
  },
  {
    id: "hedged_stepping_back_still_closes",
    parserAccepted: false,
    parsedDisposition: "stepping_back",
    hasParse: true,
    want: "fallback",
    why: "a real walk-away the parser hedged on must still close — do NOT start pestering people who said they are out"
  },
  {
    id: "hedged_sell_on_own_still_closes",
    parserAccepted: false,
    parsedDisposition: "sell_on_own",
    hasParse: true,
    want: "fallback",
    why: "same, for the sell-on-own closeout"
  },
  {
    id: "no_parse_at_all_still_falls_back",
    parserAccepted: false,
    parsedDisposition: null,
    hasParse: false,
    want: "fallback",
    why: "parser disabled, keyless or errored — the scan is the only reader left"
  }
];

for (const row of table) {
  const got = resolveCustomerDispositionSource({
    parserAccepted: row.parserAccepted,
    parsedDisposition: row.parsedDisposition,
    hasParse: row.hasParse
  });
  assert.equal(got, row.want, `${row.id}: expected ${row.want}, got ${got} — ${row.why}`);
}

// The two halves that matter to a customer, stated as behaviour.
assert.equal(
  resolveCustomerDispositionSource({ parserAccepted: false, parsedDisposition: "none", hasParse: true }),
  "none",
  "a live lead must not be retired because a keyword matched text the parser already read and rejected"
);
assert.notEqual(
  resolveCustomerDispositionSource({ parserAccepted: false, parsedDisposition: "stepping_back", hasParse: true }),
  "none",
  "a customer who really did walk away must still be closed out"
);

// One resolver, three call sites: live, regenerate, and human-mode. They must not drift.
const index = fs.readFileSync("services/api/src/index.ts", "utf8");
assert.ok(
  index.includes("resolveCustomerDispositionSource"),
  "index.ts must resolve precedence through the shared referee, not inline"
);
assert.ok(
  (index.match(/resolveCustomerDispositionDecision\(/g) ?? []).length >= 4,
  "the live, regenerate and human-mode call sites must all still go through the one resolver"
);

console.log(
  `PASS customer disposition precedence eval — ${table.length} decision-table rows + close-the-lead protection + shared-resolver wiring`
);
