/**
 * Dealer-transaction-policy precedence eval (pure, no LLM).
 *
 * A DIRECT REQUEST MUST BEAT A BACKGROUND MENTION.
 *
 * Measured 2026-08-06 by replaying one live turn three times through the deployed API:
 *   "Let me know what you are looking for price wise and I will make a decision on coming to check
 *    it out. I'm currently talking to a private seller about a 2018 Indian."
 * `dealer_transaction_policy_parser` answered `none` on all three runs — at 0.86, 0.86 and 0.72.
 * On the 0.72 run it fell under the 0.74 accept floor, `parseDealerTransactionPolicyFallback` saw
 * the words "private seller", asserted `explicitRequest: true` at a hardcoded 0.76, and the customer
 * was told "we generally cannot facilitate a trade or purchase for a bike owned by a private seller"
 * — answering a question he never asked and never quoting the price he did. Same words in, a coin
 * flip on which reply went out. That is where wrong-template replies come from.
 *
 * The table below is the whole precedence. Row 3 is the fix; rows 1, 2 and 4 are what must NOT
 * change while fixing it.
 *
 * Run: npx tsx scripts/dealer_transaction_policy_precedence_eval.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { resolveDealerTransactionPolicySource } from "../services/api/src/domain/inboundPipeline.ts";

type Row = {
  id: string;
  parserAccepted: boolean;
  parsedIntent: string | null;
  hasParse: boolean;
  want: "parser" | "none" | "fallback";
  why: string;
};

const table: Row[] = [
  {
    id: "accepted_parser_wins",
    parserAccepted: true,
    parsedIntent: "private_seller_facilitation",
    hasParse: true,
    want: "parser",
    why: "a confident parser reading is the answer — unchanged"
  },
  {
    id: "accepted_none_stays_none",
    parserAccepted: true,
    parsedIntent: "none",
    hasParse: true,
    want: "parser",
    why: "an ACCEPTED none is still the parser's answer; the caller turns it into no route"
  },
  {
    id: "THE_FIX_low_confidence_none_blocks_the_keyword_scan",
    parserAccepted: false,
    parsedIntent: "none",
    hasParse: true,
    want: "none",
    why: "the 0.72 run: a hedged reading of the sentence still beats a keyword that never read it"
  },
  {
    id: "no_parse_at_all_still_falls_back",
    parserAccepted: false,
    parsedIntent: null,
    hasParse: false,
    want: "fallback",
    why: "parser down or disabled — the fallback is the only reader left, so it must survive"
  },
  {
    id: "low_confidence_REAL_policy_ask_still_falls_back",
    parserAccepted: false,
    parsedIntent: "rider_to_rider_financing",
    hasParse: true,
    want: "fallback",
    why: "the parser DID see a policy question but hedged — do not silence a genuine ask"
  }
];

for (const row of table) {
  const got = resolveDealerTransactionPolicySource({
    parserAccepted: row.parserAccepted,
    parsedIntent: row.parsedIntent,
    hasParse: row.hasParse
  });
  assert.equal(got, row.want, `${row.id}: expected ${row.want}, got ${got} — ${row.why}`);
}

// The two customer-facing halves of the fix, stated as behaviour rather than as a table row.
assert.equal(
  resolveDealerTransactionPolicySource({ parserAccepted: false, parsedIntent: "none", hasParse: true }),
  "none",
  "a live buyer who merely MENTIONS a private seller must not be handed the refusal template"
);
assert.notEqual(
  resolveDealerTransactionPolicySource({ parserAccepted: false, parsedIntent: "private_seller_facilitation", hasParse: true }),
  "none",
  "a customer who genuinely ASKS whether we handle private-party deals must still get an answer"
);

// Both paths must share the referee. /webhooks/twilio and /conversations/:id/regenerate each call
// resolveDealerTransactionPolicyDecision, so pinning the single resolver keeps them in step —
// two-path parity is the rule this route already had to learn once.
const index = fs.readFileSync("services/api/src/index.ts", "utf8");
assert.ok(
  index.includes("resolveDealerTransactionPolicySource"),
  "index.ts must resolve precedence through the shared referee, not inline"
);
assert.ok(
  !/parsed && confidence >= min && parsed\.intent === "none"/.test(index),
  "the old confidence-gated none must be gone — that gate is what handed the turn to the keyword scan"
);
assert.equal(
  (index.match(/resolveDealerTransactionPolicyDecision\(/g) ?? []).length >= 3,
  true,
  "both the live and regenerate call sites must still go through the one resolver"
);

console.log(
  `PASS dealer transaction policy precedence eval — ${table.length} decision-table rows + direct-ask-beats-background-mention + two-path wiring`
);
