/**
 * ride_challenge_event_cadence:eval — pins Joe's 2026-07-09 ruling (+15857657010, John
 * Miller): "the ride challenge cadence should be 9/15/26". A RIDE CHALLENGE entry gets ONE
 * follow-up anchored to the challenge wrap-up (default 2026-09-15, env
 * RIDE_CHALLENGE_FOLLOWUP_ISO), not the standard sales drip and not total silence.
 *
 * Pure decision rows (resolveRideChallengeEventTouch) + source-guards for both consumers
 * (ADF intake pause-until-event; state-reconcile realign heal for the legacy pre-6/24
 * classification stragglers). Fail-direction: non-matches return null (nothing changes);
 * matches only DELAY proactive touches.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { resolveRideChallengeEventTouch } from "../services/api/src/domain/routeStateReducer.ts";

const NOW = Date.parse("2026-07-09T12:00:00.000Z");
const EVENT = "2026-09-15T13:00:00.000Z";

// --- the John Miller class: legacy general_inquiry ride-challenge lead → event touch ---
const john = resolveRideChallengeEventTouch({
  leadSource: "Ride Challenge",
  classificationBucket: "general_inquiry",
  classificationCta: "unknown",
  nowMs: NOW
});
assert.ok(john && john.pauseUntilIso === EVENT, "legacy ride-challenge (general_inquiry) → paused until the 9/15 wrap-up");

// --- correctly-classified post-6/24 shape → event touch ---
const rsvp = resolveRideChallengeEventTouch({
  leadSource: "Ride Challenge",
  classificationBucket: "event_promo",
  classificationCta: "event_rsvp",
  nowMs: NOW
});
assert.ok(rsvp && rsvp.pauseUntilIso === EVENT, "event_promo/event_rsvp ride-challenge → paused until the 9/15 wrap-up");

// --- fail-safe non-matches ---
assert.equal(
  resolveRideChallengeEventTouch({ leadSource: "Room58 - Request details", classificationBucket: "event_promo", classificationCta: "event_rsvp", nowMs: NOW }),
  null,
  "non-ride-challenge source → null (source is the key, not the bucket)"
);
assert.equal(
  resolveRideChallengeEventTouch({ leadSource: "Ride Challenge", classificationBucket: "finance_prequal", classificationCta: "prequalify", nowMs: NOW }),
  null,
  "ride-challenge entrant who ALSO prequalified is a working lead → untouched (+17167995566 class)"
);
assert.equal(
  resolveRideChallengeEventTouch({ leadSource: "Ride Challenge", classificationBucket: "event_promo", classificationCta: "sweepstakes", nowMs: NOW }),
  null,
  "sweepstakes cta → null (close-on-intake path owns it)"
);
assert.equal(
  resolveRideChallengeEventTouch({
    leadSource: "Ride Challenge",
    classificationBucket: "general_inquiry",
    classificationCta: "unknown",
    nowMs: Date.parse("2026-10-01T00:00:00.000Z")
  }),
  null,
  "past-dated event → null (no touch scheduled after the wrap-up)"
);
// env/config override plumbs through
const custom = resolveRideChallengeEventTouch({
  leadSource: "Ride Challenge",
  classificationBucket: "event_promo",
  classificationCta: "event_rsvp",
  nowMs: NOW,
  followUpIso: "2027-09-15T13:00:00.000Z"
});
assert.ok(custom && custom.pauseUntilIso === "2027-09-15T13:00:00.000Z", "followUpIso override moves the wrap-up date per season");

// --- wiring source-guards ---
const route = fs.readFileSync(path.join(process.cwd(), "services/api/src/routes/sendgridInbound.ts"), "utf8");
const intakeStart = route.indexOf("const rideChallengeTouch = resolveRideChallengeEventTouch(");
const intakeBlock = intakeStart >= 0 ? route.slice(intakeStart, intakeStart + 900) : "";
assert.ok(
  intakeBlock.includes("startFollowUpCadence(conv, new Date().toISOString(), cfg.timezone)") &&
    intakeBlock.includes('pauseFollowUpCadence(conv, rideChallengeTouch.pauseUntilIso, "event_date")'),
  "ADF intake starts the cadence then pauses it until the event date"
);
assert.ok(
  /\} else \{[\s\S]{0,700}resolveRideChallengeEventTouch/.test(route.slice(route.indexOf("shouldCloseEventPromoLeadOnIntake({", 9000))),
  "intake wiring sits on the not-closed arm of the event-promo close (sweepstakes still close)"
);

const apiIndex = fs.readFileSync(path.join(process.cwd(), "services/api/src/index.ts"), "utf8");
const healStart = apiIndex.indexOf("let rideChallengeRealigned = 0");
const healBlock = healStart >= 0 ? apiIndex.slice(healStart, healStart + 1600) : "";
assert.ok(
  healBlock.includes('String(cad.status ?? "") !== "active"') &&
    healBlock.includes('pauseFollowUpCadence(conv, touch.pauseUntilIso, "event_date")') &&
    healBlock.includes('recordRouteOutcome("manual", "ride_challenge_cadence_event_realign"'),
  "state-reconcile heal realigns ONLY active ride-challenge cadences and records the outcome"
);

console.log("PASS ride-challenge event cadence eval — one wrap-up touch (9/15/26), legacy stragglers realigned, prequal/sweepstakes untouched");
