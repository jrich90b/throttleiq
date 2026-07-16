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
import { buildDemoRideEventSoftInvite, buildEventPromoAck, buildMarketingOptInAck } from "../services/api/src/domain/agentVoice.ts";
import { resolveLeadRule } from "../services/api/src/domain/leadSourceRules.ts";

// --- 1) Decision table (pure). ---
// `variant` is the ack WORDING selector (only meaningful when ack=true): a mailing-list opt-in
// (cta=list_opt_in) renders buildMarketingOptInAck ("you're on the list"); everything else in the
// non-demo event_promo bucket renders the contest thank-you (buildEventPromoAck). The routing `kind`
// is identical for both, so precedence/close/cadence are unaffected.
type Row = { id: string; bucket: string | null; cta: string | null; ack: boolean; variant?: "contest" | "list_opt_in" };
const rows: Row[] = [
  { id: "sweepstakes", bucket: "event_promo", cta: "sweepstakes", ack: true, variant: "contest" },
  { id: "event_rsvp", bucket: "event_promo", cta: "event_rsvp", ack: true, variant: "contest" },
  { id: "bare_event_promo", bucket: "event_promo", cta: null, ack: true, variant: "contest" },
  { id: "event_promo_unknown_cta", bucket: "event_promo", cta: "unknown", ack: true, variant: "contest" },
  // Mailing-list OPT-IN ("sign up for emails/texts about events/promos") — same routing, opt-in wording
  // (2026-07-14 corpus-replay judge_fail, +17166985963: was drafted "Thanks for entering — good luck!").
  { id: "list_opt_in", bucket: "event_promo", cta: "list_opt_in", ack: true, variant: "list_opt_in" },
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
  const decision = decideEventPromoTurn({ classificationBucket: r.bucket, classificationCta: r.cta });
  assert.equal(
    decision.kind === "event_promo_ack",
    r.ack,
    `decideEventPromoTurn[${r.id}] expected ack=${r.ack}, got kind=${decision.kind}`
  );
  if (r.ack && r.variant) {
    assert.equal(
      decision.ackVariant,
      r.variant,
      `decideEventPromoTurn[${r.id}] expected ackVariant=${r.variant}, got ${decision.ackVariant}`
    );
  }
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

// --- 1c-passenger) A demo-ride PASSENGER lead (rode along, not the buyer) gets the SAME event_promo/
//     demo_ride_event treatment as a GLA demo ride: one soft invite + no follow-up cadence — NEVER the
//     sales-framed general-inquiry default with nudges. Operator-reported (Elizabeth Klapa
//     +17169492988, 2026-06-25): "This was a passenger. Thank them for coming for the demo ride and ask
//     them to reach out if they ever want a bike of their own; do NOT set a cadence." ---
for (const src of ["Dealer Lead App - Passenger", "dealer lead app - passenger" /* case-insensitive */]) {
  const r = resolveLeadRule(src);
  assert.equal(r.bucket, "event_promo", `passenger demo-ride "${src}" must classify as event_promo, got ${r.bucket}/${r.cta}`);
  assert.equal(r.cta, "demo_ride_event", `passenger demo-ride "${src}" must carry cta=demo_ride_event, got ${r.cta}`);
  assert.notEqual(
    decideEventPromoTurn({ classificationBucket: r.bucket, classificationCta: r.cta }).kind,
    "event_promo_ack",
    `"${src}" must NOT be diverted to the sweepstakes ack (demo_ride_event has its own soft invite)`
  );
}
// SAFETY BOUNDARY: only the "- Passenger" variant flips to no-cadence. The plain "Dealer Lead App"
// BUYER and the "- Prequalify" finance variant must keep their sales/finance handling (NOT event_promo),
// or a real buyer would silently lose their follow-up cadence.
assert.notEqual(resolveLeadRule("Dealer Lead App").bucket, "event_promo", "the plain Dealer Lead App buyer must NOT be diverted to event_promo");
assert.equal(resolveLeadRule("Dealer Lead App - Prequalify").bucket, "finance_prequal", "the Dealer Lead App prequal variant stays finance_prequal");

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

// --- 2b) Marketing-opt-in ack safety (pure). A mailing-list opt-in is NOT a contest, so the ack must
//         confirm the customer is on the list and carry NONE of the sales/availability frames AND NONE
//         of the fabricated sweepstakes/contest frame ("Thanks for entering — good luck!") that the
//         corpus-replay judge flagged on the +17166985963 Room58 "Contact Us" opt-in. ---
const optInAck = buildMarketingOptInAck("Katie", "Alexandra", "American Harley-Davidson");
assert.ok(
  /Katie/.test(optInAck) && /Alexandra/.test(optInAck) && /American Harley-Davidson/.test(optInAck),
  "opt-in ack must identify lead + agent + dealer"
);
assert.ok(/on the list|events and promos/i.test(optInAck), "opt-in ack must confirm the customer is on the list");
const OPT_IN_BANNED: { label: string; re: RegExp }[] = [
  ...BANNED,
  // The fabricated contest frame is the whole point of the fix — it must never appear on an opt-in.
  { label: "sweepstakes/contest frame", re: /\b(entering|good luck|winner|sweepstake|congrats)\b/i }
];
for (const b of OPT_IN_BANNED) {
  assert.ok(!b.re.test(optInAck), `marketing opt-in ack must not contain a ${b.label}: "${optInAck}"`);
}
const optInAckNoName = buildMarketingOptInAck(null, "Alexandra", "American Harley-Davidson");
assert.ok(!/undefined|null/.test(optInAckNoName), "opt-in ack must handle a missing first name cleanly");

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

// --- 3b) The opt-in variant must be wired at all three chokepoints (both paths) so a mailing-list
//         opt-in renders "you're on the list" instead of the contest frame, AND the intake must tag a
//         list_opt_in journey-intent parse as cta=list_opt_in for the decision to fire. ---
assert.ok(
  /buildMarketingOptInAck/.test(orchestrator) && /ackVariant === "list_opt_in"/.test(orchestrator),
  "orchestrateInbound must render a list_opt_in event_promo ADF with the marketing-opt-in ack"
);
assert.ok(
  /buildMarketingOptInAck/.test(index) && /ackVariant === "list_opt_in"/.test(index),
  "the vehicle-fact reply (live + regen) must render a list_opt_in turn with the marketing-opt-in ack"
);
assert.ok(
  /buildMarketingOptInAck/.test(sendgrid) && /ackVariant === "list_opt_in"/.test(sendgrid),
  "the initial-ADF draft must render a list_opt_in lead with the marketing-opt-in ack"
);
assert.ok(
  /marketingKind === "list_opt_in"[\s\S]*?"list_opt_in"\s*:\s*"event_rsvp"/.test(sendgrid),
  "the ADF intake must map a list_opt_in marketing journey-intent to cta=list_opt_in (else event_rsvp)"
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
// The event_promo intake close/visibility is decided by shouldCloseEventPromoLeadOnIntake (only pure
// sweepstakes close; demo_ride_event + event_rsvp stay OPEN and visible) — pinned in detail by
// event_promo_visibility_eval. Here just assert the terminal close routes through that decision.
assert.ok(
  /shouldCloseEventPromoLeadOnIntake\(\{[\s\S]*?\}\)\s*\)\s*\{[\s\S]*?closeConversation\(conv, "event_promo_no_cadence"\)/.test(
    sendgrid
  ),
  "the event_promo intake close must route through shouldCloseEventPromoLeadOnIntake"
);
// "Ack/soft invite, then NO follow-up" holds independently of the close: cadence stays suppressed for
// the WHOLE event_promo bucket (incl. demo_ride_event + event_rsvp) via the shouldStartCadence gate,
// so keeping a lead open does not start a cadence.
assert.ok(
  /shouldStartCadence[\s\S]*?bucket !== "event_promo"/.test(sendgrid),
  "cadence must stay suppressed for the whole event_promo bucket (incl. demo_ride_event + event_rsvp) independent of the close"
);

const ackCount = rows.filter(r => r.ack).length;
console.log(
  `PASS event-promo ack eval — ${rows.length} decision cases (${ackCount} ack / ${rows.length - ackCount} not), ack safety + 3-chokepoint source guard`
);
