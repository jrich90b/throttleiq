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
import { buildDemoRideEventSoftInvite, buildEventPromoAck } from "../services/api/src/domain/agentVoice.ts";
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

// --- 1c) GLA demo-ride leads: corporate demo-ride program rides that do NOT happen at the dealership
//         (operator-reported, Joe, 2026-07-02). They must classify event_promo/demo_ride_event —
//         NOT the sweepstakes ack (Jennifer Adam, 2026-07-01, got "thanks for entering — good luck!"
//         via inferFromCatalog's `/event|rsvp|demo ride/` catch-all as event_rsvp), and NOT a
//         dealership test-ride booking. They get ONE soft invite + no follow-up cadence (the
//         event_promo bucket closes `event_promo_no_cadence`). ---
for (const src of [
  "GLA - DEMO RIDE",
  "GLA - Demo Ride", // case-insensitive match of the same source
  "GLA - Demo Ride - DAT",
  "HDMC GLA - Road to Your Ride DAT Dealer Demo Ride",
  "GLA - Road to Your Ride Event Dealer Demo Ride"
]) {
  const r = resolveLeadRule(src);
  assert.equal(r.bucket, "event_promo", `GLA demo-ride "${src}" must classify as event_promo, got ${r.bucket}/${r.cta}`);
  assert.equal(r.cta, "demo_ride_event", `GLA demo-ride "${src}" must carry cta=demo_ride_event, got ${r.cta}`);
  assert.notEqual(
    decideEventPromoTurn({ classificationBucket: r.bucket, classificationCta: r.cta }).kind,
    "event_promo_ack",
    `"${src}" must NOT be diverted to the sweepstakes ack (demo_ride_event has its own soft invite)`
  );
}
// A DEALERSHIP demo/test-ride request keeps its real scheduling handling.
assert.equal(resolveLeadRule("DEALER DEMO RIDE").bucket, "test_ride", "a dealership demo-ride request stays test_ride");

// --- 1d) Soft-invite safety (pure): the demo_ride_event reply is a SOFT INVITE — it must identify the
//         agent + dealer and carry NO scheduling push/appointment times, NO availability claim, and NO
//         fabricated completed-ride frame ("thanks for your recent demo ride" — the source alone doesn't
//         prove the ride happened). ---
const softInvite = buildDemoRideEventSoftInvite("Jennifer", "Alexandra", "American Harley-Davidson", "2026 Low Rider ST");
assert.ok(
  /Jennifer/.test(softInvite) && /Alexandra/.test(softInvite) && /American Harley-Davidson/.test(softInvite),
  "soft invite must identify lead + agent + dealer"
);
assert.ok(/2026 Low Rider ST/.test(softInvite), "soft invite should reference the bike when known");
const SOFT_INVITE_BANNED: { label: string; re: RegExp }[] = [
  { label: "scheduling push / appointment times", re: /\b(what day|what time|which works|get you scheduled|set up a time|schedule|appointment|book)\b/i },
  { label: "availability claim", re: /\b(still available|in stock|available)\b/i },
  { label: "fabricated completed-ride frame", re: /\b(your recent demo ride|thanks for (coming|riding)|enjoyed? your (demo )?ride)\b/i },
  { label: "sweepstakes frame", re: /\b(entering|good luck|winner|sweepstake)\b/i }
];
for (const b of SOFT_INVITE_BANNED) {
  assert.ok(!b.re.test(softInvite), `demo-ride soft invite must not contain a ${b.label}: "${softInvite}"`);
}
const softInviteBare = buildDemoRideEventSoftInvite(null, "Alexandra", "American Harley-Davidson", null);
assert.ok(!/undefined|null/.test(softInviteBare), "soft invite must handle missing name/bike cleanly");
for (const b of SOFT_INVITE_BANNED) {
  assert.ok(!b.re.test(softInviteBare), `bare demo-ride soft invite must not contain a ${b.label}: "${softInviteBare}"`);
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

// Demo-ride soft invite wired at BOTH draft chokepoints (orchestrator + initial-ADF).
assert.ok(
  /buildDemoRideEventSoftInvite/.test(orchestrator),
  "orchestrateInbound must draft a demo_ride_event lead with the shared soft invite"
);
assert.ok(
  /buildDemoRideEventSoftInvite/.test(sendgrid) && /cta === "demo_ride_event"/.test(sendgrid),
  "the initial-ADF draft must override a demo_ride_event lead with the shared soft invite"
);
// GLA demo-ride leads are NOT auto-closed (Joe, 2026-07-07): genuine sweepstakes/RSVP
// (event_promo, cta !== demo_ride_event) still close with no cadence, but a demo_ride_event
// lead stays OPEN and visible so staff can work it. The terminal close must exclude it.
assert.ok(
  /bucket === "event_promo" && conv\.classification\?\.cta !== "demo_ride_event"[\s\S]*?closeConversation\(conv, "event_promo_no_cadence"\)/.test(
    sendgrid
  ),
  "the event_promo close must EXCLUDE demo_ride_event — GLA demo rides stay open/visible; genuine sweepstakes/RSVP still close"
);
// "Soft invite, then NO follow-up" holds independently of the close: cadence stays
// suppressed for the WHOLE event_promo bucket (incl. demo_ride_event) via the
// shouldStartCadence gate, so keeping the demo-ride lead open does not start a cadence.
assert.ok(
  /shouldStartCadence[\s\S]*?bucket !== "event_promo"/.test(sendgrid),
  "cadence must stay suppressed for the whole event_promo bucket (incl. demo_ride_event) independent of the close"
);

const ackCount = rows.filter(r => r.ack).length;
console.log(
  `PASS event-promo ack eval — ${rows.length} decision cases (${ackCount} ack / ${rows.length - ackCount} not), ack safety + 3-chokepoint source guard`
);
