/**
 * Event-promo / sweepstakes acknowledgement eval (pure, no LLM).
 *
 * Pins the fix for "answering out of context" on non-sales marketing leads (2026-06-20
 * context-fidelity audit: 5/6 out-of-context drafts were National Event Dealer Sweeps
 * ADFs getting sales/availability/stop-in/model-fact answers — "That stock number is
 * still available, what day works to stop in?", "Thanks for your inquiry about the 2026
 * X...", a bare "It's a 2026 Road Glide."). A sweepstakes entry isn't shopping for a bike,
 * so the only correct reply is one friendly, non-pushy acknowledgement.
 *
 * Layers:
 *   1. Decision table — decideEventPromoTurn maps sweepstakes/RSVP/bare event_promo to an
 *      ack and EXCLUDES demo-ride events (their own handling) and every sales bucket.
 *   2. Ack safety — buildEventPromoAck identifies the agent and carries NO availability
 *      claim, stop-in push, appointment offer, or vehicle-fact assertion.
 *   3. Source guard — the gate is wired at all three reply chokepoints across BOTH paths:
 *      the orchestrator (live + regen), the vehicle-fact answer, and the initial-ADF draft.
 *
 * Run: npx tsx scripts/event_promo_ack_eval.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";

import { decideEventPromoTurn } from "../services/api/src/domain/routeStateReducer.ts";
import { buildEventPromoAck } from "../services/api/src/domain/agentVoice.ts";

// --- 1) Decision table (pure). ---
type Row = { id: string; bucket: string | null; cta: string | null; ack: boolean };
const rows: Row[] = [
  { id: "sweepstakes", bucket: "event_promo", cta: "sweepstakes", ack: true },
  { id: "event_rsvp", bucket: "event_promo", cta: "event_rsvp", ack: true },
  { id: "bare_event_promo", bucket: "event_promo", cta: null, ack: true },
  { id: "event_promo_unknown_cta", bucket: "event_promo", cta: "unknown", ack: true },
  // Demo-ride events keep their dedicated dealer-ride handling — NOT diverted.
  { id: "demo_ride_event_excluded", bucket: "event_promo", cta: "demo_ride_event", ack: false },
  // Real sales leads must never be diverted to the ack.
  { id: "inventory_interest", bucket: "inventory_interest", cta: "check_availability", ack: false },
  { id: "trade_in_sell", bucket: "trade_in_sell", cta: "value_my_trade", ack: false },
  { id: "finance_prequal", bucket: "finance_prequal", cta: "prequalify", ack: false },
  { id: "test_ride", bucket: "test_ride", cta: "schedule_test_ride", ack: false },
  { id: "service", bucket: "service", cta: "service_request", ack: false },
  { id: "empty", bucket: null, cta: null, ack: false }
];
for (const r of rows) {
  const kind = decideEventPromoTurn({ classificationBucket: r.bucket, classificationCta: r.cta }).kind;
  assert.equal(
    kind === "event_promo_ack",
    r.ack,
    `decideEventPromoTurn[${r.id}] expected ack=${r.ack}, got kind=${kind}`
  );
}

// --- 2) Ack safety (pure). ---
const ack = buildEventPromoAck("Matthew", "Alexandra", "American Harley-Davidson");
assert.ok(/Matthew/.test(ack) && /Alexandra/.test(ack) && /American Harley-Davidson/.test(ack), "ack must identify lead + agent + dealer");
// The exact failure modes this replaces must NOT appear in the approved ack.
const BANNED: { label: string; re: RegExp }[] = [
  { label: "availability claim", re: /\b(still available|in stock|available)\b/i },
  { label: "stop-in push", re: /\bstop in|come in|swing by|check it out\b/i },
  { label: "appointment offer", re: /\bwhat day|what time|set up a time|test ride|schedule\b/i },
  { label: "vehicle-fact assertion", re: /\bit'?s a (19|20)\d\d\b/i }
];
for (const b of BANNED) {
  assert.ok(!b.re.test(ack), `event-promo ack must not contain a ${b.label}: "${ack}"`);
}
// A nameless lead still produces a clean greeting (no "undefined").
const ackNoName = buildEventPromoAck(null, "Alexandra", "American Harley-Davidson");
assert.ok(!/undefined|null/.test(ackNoName), "ack must handle a missing first name cleanly");

// --- 3) Source guard — the gate is wired at all three chokepoints, BOTH paths. ---
const orchestrator = fs.readFileSync("services/api/src/domain/orchestrator.ts", "utf8");
const index = fs.readFileSync("services/api/src/index.ts", "utf8");
const sendgrid = fs.readFileSync("services/api/src/routes/sendgridInbound.ts", "utf8");

assert.ok(
  /decideEventPromoTurn/.test(orchestrator) && /buildEventPromoAck/.test(orchestrator) && /event\.provider === "sendgrid_adf"/.test(orchestrator),
  "orchestrateInbound must divert a non-sales event_promo ADF to the ack (scoped to the ADF turn)"
);
assert.ok(
  /maybeEventPromoAckReply/.test(index) && /decideEventPromoTurn/.test(index),
  "the vehicle-fact reply (live + regen) must divert a non-sales event_promo turn to the ack"
);
assert.ok(
  /decideEventPromoTurn/.test(sendgrid) && /buildEventPromoAck/.test(sendgrid),
  "the initial-ADF draft must divert a non-sales event_promo lead to the ack"
);

const ackCount = rows.filter(r => r.ack).length;
console.log(
  `PASS event-promo ack eval — ${rows.length} decision cases (${ackCount} ack / ${rows.length - ackCount} not), ack safety + 3-chokepoint source guard`
);
