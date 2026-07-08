/**
 * Event-promo intake visibility eval (pure, no LLM) — 2026-07-08.
 *
 * Event-promo ADFs get a one-and-done ack/soft-invite and NO follow-up cadence. The open question is
 * whether they stay VISIBLE in the inbox or terminally close+archive on intake:
 *   - pure SWEEPSTAKES (anonymous contest entries) -> close+archive (low value).
 *   - GLA demo-ride (cta demo_ride_event, Joe 2026-07-07) -> stay OPEN (real prospects who rode).
 *   - ride-challenge / national-event RSVP (cta event_rsvp, Joe 2026-07-08) -> stay OPEN.
 * Ride-challenge / RSVP leads were closing+archiving and getting MISSED — operator +17168184666
 * ("these gla and event promos are getting closed right away and put into the archive box so are
 * getting missed"). This pins that only sweepstakes close and everything else in the bucket stays
 * visible, while cadence stays suppressed for the whole bucket.
 *
 * Layers: (1) pure decision table for shouldCloseEventPromoLeadOnIntake; (2) end-to-end from the lead
 * SOURCE (resolveLeadRule -> cta -> close decision); (3) source guard that the intake close routes
 * through the decision and that cadence stays suppressed for the whole bucket.
 *
 * Run: npx tsx scripts/event_promo_visibility_eval.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";

import { shouldCloseEventPromoLeadOnIntake } from "../services/api/src/domain/routeStateReducer.ts";
import { resolveLeadRule } from "../services/api/src/domain/leadSourceRules.ts";

// --- 1) Pure decision table. true => close+archive on intake; false => stay OPEN/visible. ---
type Row = { id: string; bucket: string | null; cta: string | null; close: boolean };
const rows: Row[] = [
  { id: "sweepstakes_closes", bucket: "event_promo", cta: "sweepstakes", close: true },
  { id: "event_rsvp_stays_open", bucket: "event_promo", cta: "event_rsvp", close: false },
  { id: "demo_ride_event_stays_open", bucket: "event_promo", cta: "demo_ride_event", close: false },
  // Fail-direction: an unrecognized / missing event_promo cta stays OPEN (visible beats archived-and-missed).
  { id: "event_promo_unknown_cta_stays_open", bucket: "event_promo", cta: "unknown", close: false },
  { id: "event_promo_null_cta_stays_open", bucket: "event_promo", cta: null, close: false },
  // Case-insensitive on the cta.
  { id: "sweepstakes_uppercase_closes", bucket: "EVENT_PROMO", cta: "SWEEPSTAKES", close: true },
  // Non-event buckets are irrelevant to this gate (never closed by it).
  { id: "inventory_interest_untouched", bucket: "inventory_interest", cta: "check_availability", close: false },
  { id: "finance_prequal_untouched", bucket: "finance_prequal", cta: "prequalify", close: false },
  { id: "empty_untouched", bucket: null, cta: null, close: false }
];
for (const r of rows) {
  assert.equal(
    shouldCloseEventPromoLeadOnIntake({ classificationBucket: r.bucket, classificationCta: r.cta }),
    r.close,
    `shouldCloseEventPromoLeadOnIntake[${r.id}] expected close=${r.close}`
  );
}

// --- 2) End-to-end from the lead SOURCE: the classification cta must drive the right visibility. ---
// Ride-challenge / national-event RSVP sources stay OPEN (the operator complaint) ...
for (const src of ["Room58 - National Event RSVP", "National Event RSVP", "Ride Challenge"]) {
  const r = resolveLeadRule(src);
  assert.equal(r.bucket, "event_promo", `"${src}" must classify event_promo, got ${r.bucket}`);
  assert.equal(r.cta, "event_rsvp", `"${src}" must carry cta=event_rsvp, got ${r.cta}`);
  assert.equal(
    shouldCloseEventPromoLeadOnIntake({ classificationBucket: r.bucket, classificationCta: r.cta }),
    false,
    `"${src}" must STAY OPEN (was getting closed+archived and missed)`
  );
}
// ... GLA demo-ride stays OPEN ...
for (const src of ["GLA - DEMO RIDE", "HDMC GLA - Road to Your Ride DAT Dealer Demo Ride"]) {
  const r = resolveLeadRule(src);
  assert.equal(r.cta, "demo_ride_event", `"${src}" must carry cta=demo_ride_event, got ${r.cta}`);
  assert.equal(
    shouldCloseEventPromoLeadOnIntake({ classificationBucket: r.bucket, classificationCta: r.cta }),
    false,
    `GLA demo-ride "${src}" must STAY OPEN`
  );
}
// ... but a pure sweepstakes source still closes.
{
  const r = resolveLeadRule("National Event Dealer Sweeps");
  assert.equal(r.cta, "sweepstakes", `sweepstakes source must carry cta=sweepstakes, got ${r.cta}`);
  assert.equal(
    shouldCloseEventPromoLeadOnIntake({ classificationBucket: r.bucket, classificationCta: r.cta }),
    true,
    "a pure sweepstakes lead still closes+archives on intake"
  );
}

// --- 3) Source guard: the intake close routes through the decision, and cadence stays suppressed. ---
const sendgrid = fs.readFileSync("services/api/src/routes/sendgridInbound.ts", "utf8");
assert.ok(
  /shouldCloseEventPromoLeadOnIntake\(\{[\s\S]*?classificationBucket: conv\.classification\?\.bucket[\s\S]*?classificationCta: conv\.classification\?\.cta[\s\S]*?\}\)\s*\)\s*\{[\s\S]*?closeConversation\(conv, "event_promo_no_cadence"\)/.test(
    sendgrid
  ),
  "the intake close must be gated by shouldCloseEventPromoLeadOnIntake(conv classification)"
);
// No-sales-cadence for the WHOLE bucket (the original operator complaint on ride-challenge +17168124792).
assert.ok(
  /shouldStartCadence[\s\S]*?bucket !== "event_promo"/.test(sendgrid),
  "no follow-up cadence starts for any event_promo lead (bucket excluded from shouldStartCadence)"
);

const closeCount = rows.filter(r => r.close).length;
console.log(
  `PASS event-promo visibility eval — ${rows.length} decision cases (${closeCount} close / ${rows.length - closeCount} stay-open), source-driven + intake-close + no-cadence guard`
);
