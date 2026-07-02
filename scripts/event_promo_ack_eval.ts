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
import { resolveLeadRule } from "../services/api/src/domain/leadSourceRules.ts";

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

// --- 1b) Classification: the event-marketing SOURCES must resolve to event_promo so the ack even gets
//         a chance to fire. ROOT CAUSE of the top wrong_lead_type misses (7-day audit): these sources
//         aren't in the catalog, so resolveLeadRule fell through to general_inquiry -> a sales
//         first-touch ("that stock number is still available, what day to stop in?"). ---
for (const src of ["National Event Dealer Sweeps", "Room58 - National Event RSVP", "National Event RSVP", "Ride Challenge"]) {
  const r = resolveLeadRule(src);
  assert.equal(r.bucket, "event_promo", `source "${src}" must classify as event_promo, got ${r.bucket}/${r.cta}`);
  assert.equal(
    decideEventPromoTurn({ classificationBucket: r.bucket, classificationCta: r.cta }).kind,
    "event_promo_ack",
    `"${src}" must flow through to the event-promo ack`
  );
}
// The name inference must NOT sweep a real sales source into event_promo.
assert.notEqual(resolveLeadRule("Facebook - RAQ").bucket, "event_promo", "a sales source must stay out of event_promo");

// --- 1c) Demo-ride disambiguation: an INDIVIDUAL demo-ride REQUEST must route to test_ride (a real
//         "let's set up a time to ride it" reply), NOT the event_promo "thanks for entering — good luck!"
//         ack. ROOT CAUSE (Jennifer Adam, 2026-07-01): "GLA - DEMO RIDE" wasn't in the hdmc_test_ride_request
//         allowlist, so it fell through to inferFromCatalog's `/event|rsvp|demo ride/` catch-all and was
//         mis-bucketed event_promo. Its sibling "DEALER DEMO RIDE" was already handled — this pins parity.
//         The genuine "Road to Your Ride" ROADSHOW demo-ride EVENTS must STAY event_promo. ---
for (const src of ["GLA - DEMO RIDE", "GLA - Demo Ride", "DEALER DEMO RIDE"]) {
  const r = resolveLeadRule(src);
  assert.equal(r.bucket, "test_ride", `individual demo-ride request "${src}" must classify as test_ride, got ${r.bucket}/${r.cta}`);
  assert.notEqual(
    decideEventPromoTurn({ classificationBucket: r.bucket, classificationCta: r.cta }).kind,
    "event_promo_ack",
    `"${src}" must NOT be diverted to the event-promo ack`
  );
}
// NB: the genuine "GLA - Road to Your Ride ... Demo Ride" ROADSHOW events (3025/3026) stay event_promo
// in production via the catalog (inferFromCatalog's event catch-all) / the gla_demo_ride_dat sourceId
// rule — they are deliberately NOT added to the test_ride allowlist above. That path is catalog-data-
// dependent (DATA_DIR), so it isn't asserted here; the fix above is a purely additive allowlist entry
// that cannot reach those event sources.

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
