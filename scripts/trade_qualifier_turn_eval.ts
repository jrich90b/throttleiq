/**
 * Trade-qualifier turn decision eval (pure, no LLM).
 *
 * Pins the trade-cluster route-decision centralization: after we ask "do you have a trade?",
 * the typed parser `parseTradeQualifierResponseWithLLM` classifies the reply (hasTrade =
 * affirmed / declined / unclear), and `decideTradeQualifierTurn` maps that to the route kind
 * so BOTH /webhooks/twilio AND /conversations/:id/regenerate switch on the SAME result
 * (route-parity law). This closes the prior gap where regen handled ONLY the decline branch
 * and an affirm fell through to the orchestrator.
 *
 * Layers:
 *   1. Decision table — affirmed -> trade_affirm, declined -> trade_decline, unclear/null/
 *      not-asked -> none (fail-safe fall-through).
 *   2. Source guard — both paths compute decideTradeQualifierTurn and handle BOTH the
 *      trade_affirm and trade_decline arms (regen affirm parity).
 *
 * Run: npx tsx scripts/trade_qualifier_turn_eval.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";

import { decideTradeQualifierTurn } from "../services/api/src/domain/routeStateReducer.ts";

// --- 1) Decision table (pure). ---
type Row = { id: string; asked: boolean; hasTrade: string | null; kind: "trade_affirm" | "trade_decline" | "none" };
const rows: Row[] = [
  { id: "affirmed_asked", asked: true, hasTrade: "affirmed", kind: "trade_affirm" },
  { id: "declined_asked", asked: true, hasTrade: "declined", kind: "trade_decline" },
  { id: "unclear_asked", asked: true, hasTrade: "unclear", kind: "none" },
  { id: "null_asked", asked: true, hasTrade: null, kind: "none" },
  // We never asked -> never act on a stray "yes"/"no".
  { id: "affirmed_not_asked", asked: false, hasTrade: "affirmed", kind: "none" },
  { id: "declined_not_asked", asked: false, hasTrade: "declined", kind: "none" }
];
for (const r of rows) {
  const got = decideTradeQualifierTurn({ askedTradeQualifier: r.asked, hasTrade: r.hasTrade }).kind;
  assert.equal(got, r.kind, `decideTradeQualifierTurn[${r.id}] expected ${r.kind}, got ${got}`);
}

// --- 2) Source guard — both paths apply the decision + handle both arms. ---
const index = fs.readFileSync("services/api/src/index.ts", "utf8");
const calls = (index.match(/decideTradeQualifierTurn\(/g) || []).length;
assert.ok(
  calls >= 2,
  `decideTradeQualifierTurn must be applied in BOTH /webhooks/twilio and /conversations/:id/regenerate; found ${calls}`
);
assert.ok(
  /tradeQualifierDecision\.kind === "trade_affirm"/.test(index) &&
    /tradeQualifierDecision\.kind === "trade_decline"/.test(index),
  "the live path must switch on trade_affirm + trade_decline"
);
assert.ok(
  /regenTradeQualifierDecision\.kind === "trade_affirm"/.test(index) &&
    /regenTradeQualifierDecision\.kind === "trade_decline"/.test(index),
  "the regenerate path must now handle BOTH trade_affirm (parity) + trade_decline"
);

console.log(
  `PASS trade-qualifier turn eval — ${rows.length} decision cases + both-path source guard (regen affirm parity)`
);
