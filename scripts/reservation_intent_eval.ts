/**
 * Reservation / pre-order intent eval (2026-06-15).
 *
 * Production miss (Nicholas Braun +17166286477): "I would like to reserve one" /
 * "What do I have to do to reserve one" on a limited-run 2026 Super Glide had no
 * matching intent and collapsed into the inventory-WATCH path ("I'll let you know
 * when it arrives"), a total non-answer. Reservations are STAFF-ONLY (Joe): the
 * agent confirms warmly, quotes no terms, and hands off with a high-priority call
 * task. This eval pins:
 *   1. the deterministic safety-net detector (reserve-a-unit vs reserve-a-time vs
 *      notify-when-it-arrives),
 *   2. the handoff copy (charter-clean, no deposit/allocation terms),
 *   3. the parser wiring (customer_reservation_request in the inbound_reply_action
 *      union/schema/mapping/few-shots),
 *   4. the dispatch in BOTH the live and regenerate paths.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  buildReservationHandoffReply,
  detectReservationRequestText
} from "../services/api/src/domain/reservationIntent.ts";
import { decideReservationHandoffTurn } from "../services/api/src/domain/routeStateReducer.ts";
import { checkMessage } from "./voice_charter_audit.ts";

// 1) Detector: reservation/pre-order of a UNIT fires; scheduling-reserve and
// notify-when-it-arrives (watch) do NOT.
for (const yes of [
  "What do I have to do to reserve one",
  "I know it's a limited run and I would like to reserve one",
  "Can I reserve one of the 2026 Super Glides?",
  "How do I pre-order one",
  "I want to put a deposit down to hold it",
  "can you hold one for me"
]) {
  assert.ok(detectReservationRequestText(yes), `should detect reservation intent: "${yes}"`);
}
for (const no of [
  "Can you reserve a time for me on Saturday?",
  "I'd like to reserve a spot for the demo day",
  "Can you let me know if one comes in?",
  "Keep me posted when the trade gets here",
  "Is the bike in store?",
  "What's the price on the Super Glide?"
]) {
  assert.ok(!detectReservationRequestText(no), `should NOT be a reservation request: "${no}"`);
}

// 2) Handoff copy: warm, explicit staff handoff, charter-clean, and quotes NO
// deposit / allocation / pricing terms (staff-only policy).
const TERMS_RE = /\$\s?\d|\bdeposit\b|\bapr\b|down payment|allocation|non-?refundable|\d+\s*%/i;
for (const owner of ["Giovanni", "", "Giovanni Boccabella"]) {
  const { reply, todoSummary } = buildReservationHandoffReply({
    firstName: "Nicholas",
    ownerFirstName: owner,
    unitLabel: "the 2026 Super Glide"
  });
  assert.ok(reply.startsWith("Love it, Nicholas"), `reply greets by first name: "${reply}"`);
  assert.ok(!TERMS_RE.test(reply), `reply must not quote reservation terms: "${reply}"`);
  assert.ok(/\breserved\b/i.test(reply), `reply acknowledges reservation: "${reply}"`);
  const violations = checkMessage(reply, { firstOutbound: false, smsLike: true, staffHasSent: false });
  assert.deepEqual(violations, [], `reply charter violations ${JSON.stringify(violations)}: "${reply}"`);
  // exactly one em-dash max (charter)
  assert.ok((reply.match(/—/g) ?? []).length <= 1, `reply em-dash count: "${reply}"`);
  assert.ok(/RESERVE/.test(todoSummary) && /reservation steps/i.test(todoSummary), `todo summary: "${todoSummary}"`);
}
// Unknown unit falls back cleanly (no "the the", no "2026 Other trade" leakage).
const fallbackTodo = buildReservationHandoffReply({ firstName: "Sam", unitLabel: "" }).todoSummary;
assert.ok(/RESERVE a unit/.test(fallbackTodo), `unknown-unit todo: "${fallbackTodo}"`);

// 3) Parser wiring in llmDraft.ts.
const llmSrc = fs.readFileSync(path.resolve("services/api/src/domain/llmDraft.ts"), "utf8");
for (const pin of [
  '| "customer_reservation_request"', // union
  '"customer_reservation_request",' // schema enum + mapping share this token
]) {
  assert.ok(llmSrc.includes(pin), `llmDraft.ts must wire reservation parser action: ${pin}`);
}
assert.match(
  llmSrc,
  /actionRaw === "customer_reservation_request"/,
  "parser must map customer_reservation_request (not drop it to none)"
);
assert.match(llmSrc, /EXAMPLE S[\s\S]*customer_reservation_request/, "parser must carry the reservation few-shot");

// 4) Dispatch wired in BOTH live and regen paths.
const apiSrc = fs.readFileSync(path.resolve("services/api/src/index.ts"), "utf8");
const outcomePins = (apiSrc.match(/recordRouteOutcome\(\s*"(?:live|regen)",\s*"customer_reservation_request"/g) ?? [])
  .length;
assert.ok(outcomePins >= 2, `reservation must route in live + regen (found ${outcomePins})`);
assert.ok(
  (apiSrc.match(/setDialogState\(conv, "reservation_handoff"\)/g) ?? []).length >= 2,
  "both paths set the reservation_handoff dialog state"
);
assert.ok(
  (apiSrc.match(/detectReservationRequestText\(event\.body \?\? ""\)/g) ?? []).length >= 2,
  "both paths use the deterministic fallback detector"
);
assert.match(
  apiSrc,
  /import \{ buildReservationHandoffReply, detectReservationRequestText \} from "\.\/domain\/reservationIntent\.js"/,
  "index.ts imports the reservation handoff helpers"
);

// 5) Second-look decision table (2026-07-13, Kody +17163975098). The reservation handoff fires an
// expensive side effect (committal draft + owner call task), so an accepted primary parse gets one
// narrow verification pass; precedence is pinned here. FAIL DIRECTION: the verifier can only VETO,
// never enable — a null verdict (LLM off/error) proceeds on the primary parser's word (today's
// behavior), and the explicit-token regex fallback lane is never vetoed.
const DECISION_ROWS: {
  id: string;
  input: Parameters<typeof decideReservationHandoffTurn>[0];
  fire: boolean;
  reason: string;
}[] = [
  {
    id: "parser_plus_verifier_agree_fires",
    input: { parserReservationAccepted: true, fallbackDetected: false, confirmVerdict: "reserve_now" },
    fire: true,
    reason: "parser_confirmed"
  },
  {
    id: "verifier_veto_suppresses_deferred_purchase",
    input: { parserReservationAccepted: true, fallbackDetected: false, confirmVerdict: "not_reserve_now" },
    fire: false,
    reason: "second_look_veto"
  },
  {
    id: "verifier_veto_wins_even_if_fallback_also_matched",
    input: { parserReservationAccepted: true, fallbackDetected: true, confirmVerdict: "not_reserve_now" },
    fire: false,
    reason: "second_look_veto"
  },
  {
    id: "null_verifier_proceeds_on_primary_parser",
    input: { parserReservationAccepted: true, fallbackDetected: false, confirmVerdict: null },
    fire: true,
    reason: "parser_unverified"
  },
  {
    id: "fallback_token_lane_never_vetoed",
    input: { parserReservationAccepted: false, fallbackDetected: true, confirmVerdict: null },
    fire: true,
    reason: "fallback_detector"
  },
  {
    id: "no_signal_no_fire",
    input: { parserReservationAccepted: false, fallbackDetected: false, confirmVerdict: null },
    fire: false,
    reason: "no_signal"
  }
];
for (const row of DECISION_ROWS) {
  const decision = decideReservationHandoffTurn(row.input);
  assert.equal(decision.fire, row.fire, `[${row.id}] fire`);
  assert.equal(decision.reason, row.reason, `[${row.id}] reason`);
}

// 6) Second-look wiring: BOTH paths call the verifier + reducer, and both record the veto outcome.
assert.ok(
  (apiSrc.match(/parseReservationConfirmWithLLM\(\{ text: event\.body \?\? ""/g) ?? []).length >= 2,
  "both paths call the reservation second-look verifier"
);
assert.ok(
  (apiSrc.match(/decideReservationHandoffTurn\(\{/g) ?? []).length >= 2,
  "both paths route the reservation turn through decideReservationHandoffTurn"
);
assert.ok(
  (apiSrc.match(/recordRouteOutcome\(\s*"(?:live|regen)",\s*"reservation_second_look_veto"/g) ?? []).length >= 2,
  "both paths record the second-look veto outcome"
);

console.log("PASS reservation intent eval");
