/**
 * Stock-number interest routing — decision-table eval.
 *
 * `decideStockNumberInterestTurn` (services/api/src/domain/routeStateReducer.ts) is the single
 * source of truth for whether a turn routes into the deterministic inventory-availability arm on
 * the strength of a dealer stock number. It is applied identically in the live (/webhooks/twilio)
 * path, the /conversations/:id/regenerate path, and the orchestrator, so the three cannot drift.
 *
 * Origin: Lisa Hanson (+17164233031, msg_30b26a65c146e_1777309569346, 2026-04-27). Asked whether her
 * boyfriend was looking at a specific model, she replied "Idk actually I should have given his
 * number.  Itz 716-713-8288. His name is Steve" — handing over an alternate contact. The stock-id
 * extractor read "716-713" out of the phone number and "I should HAVE given" satisfied the interest
 * keyword list, so the turn was hijacked into the availability arm and answered
 * "I'm not seeing new 2026 Other in stock right now…", ignoring Steve entirely. Production's own
 * draft that day (before the stock arm existed) was correct: "Thanks for the update—I'll note Steve
 * (716-713-8288)."
 *
 * Two independent properties are pinned here:
 *   1. A stock id must actually be present AND the interest signal must hold before the arm fires.
 *   2. The typed inventory-entity parser's stock id takes precedence over the deterministic
 *      extraction, and either alone is sufficient (the parser owns comprehension; the extractor is
 *      the structured-extraction fallback).
 *
 * Fail-direction: FALSE on a real stock-number ask is soft (the general composer still answers the
 * customer). TRUE on a non-stock-number is the damaging direction — the arm answers a question
 * nobody asked and drops what the customer actually said. The interest signal is therefore a
 * KEEP-class over-fire gate, pinned below.
 */
import assert from "node:assert/strict";
import { decideStockNumberInterestTurn } from "../services/api/src/domain/routeStateReducer.ts";

type Row = {
  id: string;
  input: Parameters<typeof decideStockNumberInterestTurn>[0];
  route: boolean;
  stockId: string | null;
};

const rows: Row[] = [
  // THE PRODUCTION TURN. A phone number is no longer extracted as a stock id, so there is nothing
  // to route on and the turn falls through to the general composer.
  {
    id: "alternate_contact_phone_number_does_not_route",
    input: { parserStockId: null, deterministicStockId: null, interestSignal: false },
    route: false,
    stockId: null
  },
  // Belt-and-braces on the same turn: even if some future extractor change re-surfaced a token, the
  // interest signal alone must never be enough to fire the arm without a stock id.
  {
    id: "interest_signal_without_stock_id_does_not_route",
    input: { parserStockId: null, deterministicStockId: null, interestSignal: true },
    route: false,
    stockId: null
  },
  // The preserved positive: a real, letter-led stock number with the interest signal routes.
  {
    id: "deterministic_stock_id_with_interest_routes",
    input: { parserStockId: null, deterministicStockId: "T10-26", interestSignal: true },
    route: true,
    stockId: "T10-26"
  },
  // KEEP-class gate: a stock-shaped token with NO interest signal must not fire the arm. Removing
  // the interest gate would make any stock-shaped token hijack the turn.
  {
    id: "stock_id_without_interest_signal_does_not_route",
    input: { parserStockId: null, deterministicStockId: "T10-26", interestSignal: false },
    route: false,
    stockId: "T10-26"
  },
  // The typed parser alone is sufficient — comprehension does not depend on the raw-text extractor.
  {
    id: "parser_stock_id_alone_routes",
    input: { parserStockId: "S9-25", deterministicStockId: null, interestSignal: true },
    route: true,
    stockId: "S9-25"
  },
  // Parser wins when the two disagree (parser-first).
  {
    id: "parser_stock_id_takes_precedence_over_extraction",
    input: { parserStockId: "S9-25", deterministicStockId: "T10-26", interestSignal: true },
    route: true,
    stockId: "S9-25"
  },
  // Nothing at all: no route, no stock id.
  {
    id: "no_signals_does_not_route",
    input: { parserStockId: null, deterministicStockId: null, interestSignal: false },
    route: false,
    stockId: null
  }
];

let passed = 0;
for (const row of rows) {
  const out = decideStockNumberInterestTurn(row.input);
  assert.equal(
    out.routeToStockInventory,
    row.route,
    `${row.id}: expected routeToStockInventory=${row.route}, got ${out.routeToStockInventory}`
  );
  assert.equal(out.stockId, row.stockId, `${row.id}: expected stockId=${row.stockId}, got ${out.stockId}`);
  passed += 1;
}

console.log(`PASS stock-number interest routing eval (${passed} rows)`);
