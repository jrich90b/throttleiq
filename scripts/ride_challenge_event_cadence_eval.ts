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
import {
  resolveRideChallengeEventTouch,
  decideRideChallengeWrapUpRevive,
  RIDE_CHALLENGE_WRAPUP_MARKER
} from "../services/api/src/domain/routeStateReducer.ts";
import { buildRideChallengeWrapUpReply } from "../services/api/src/domain/workflowRegressionGuards.ts";

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

// ═══ Wrap-up REVIVE (Joe ruling 2026-08-21: "generate a draft on the 15th") ═══
// The signup ack completed these cadences on the spot; decideRideChallengeWrapUpRevive
// revives exactly the parked-and-owed records so the tick composes the 9/15 wrap-up.
const PARKED = {
  convId: "+13159215037",
  cadenceStatus: "completed",
  cadenceKind: "long_term",
  deferredMessage: RIDE_CHALLENGE_WRAPUP_MARKER,
  lastSentStep: 0,
  nowMs: Date.parse("2026-08-21T12:00:00.000Z")
};
const EVENT_MS = Date.parse(EVENT);
const DAY = 24 * 60 * 60 * 1000;

const revived = decideRideChallengeWrapUpRevive(PARKED);
assert.ok(revived, "parked completed signup (lastSentStep 0) → revived");
{
  const dueMs = Date.parse(revived!.nextDueAtIso);
  assert.ok(dueMs >= EVENT_MS && dueMs <= EVENT_MS + 2 * DAY, "revive lands on the event date or the 2 staggered days after — never before 9/15");
}
// Stagger is deterministic per lead (reconcile may run any number of times without reshuffling)
assert.equal(
  decideRideChallengeWrapUpRevive(PARKED)!.nextDueAtIso,
  revived!.nextDueAtIso,
  "same lead → same staggered slot on every reconcile run"
);
// ...and actually spreads distinct leads across days (the 8/21 'won't overwhelm' requirement)
{
  const ids = Array.from({ length: 60 }, (_, i) => `+1716555${String(1000 + i)}`);
  const days = new Set(
    ids.map(id => Math.round((Date.parse(decideRideChallengeWrapUpRevive({ ...PARKED, convId: id })!.nextDueAtIso) - EVENT_MS) / DAY))
  );
  assert.equal(days.size, 3, "stagger uses all 3 days across a lead population");
}

// ── CONVERGENCE (memory long-term-cadence-loops-forever-at-step-zero: a decision table
// cannot catch a loop — assert the cycle ends). After the wrap-up sends,
// advanceFollowUpCadence stamps lastSentStep=1 and re-completes; the revive must then be dead.
assert.equal(
  decideRideChallengeWrapUpRevive({ ...PARKED, lastSentStep: 1 }),
  null,
  "CONVERGES: wrap-up sent (lastSentStep 1) → never revived again"
);

// ── fail-safe non-matches ──
assert.equal(decideRideChallengeWrapUpRevive({ ...PARKED, cadenceStatus: "active" }), null, "active cadence → untouched (the tick already owns it)");
assert.equal(decideRideChallengeWrapUpRevive({ ...PARKED, cadenceStatus: "stopped" }), null, "stopped cadence → untouched (a stop is a judgement, not a parking state)");
assert.equal(decideRideChallengeWrapUpRevive({ ...PARKED, cadenceKind: "standard" }), null, "non-long_term kind → untouched");
assert.equal(decideRideChallengeWrapUpRevive({ ...PARKED, deferredMessage: null }), null, "no wrap-up marker → untouched (ordinary completed cadences stay completed)");
assert.equal(decideRideChallengeWrapUpRevive({ ...PARKED, deferredMessage: "something_else" }), null, "different deferred message → untouched");
assert.equal(
  decideRideChallengeWrapUpRevive({ ...PARKED, nowMs: Date.parse("2026-09-23T00:00:00.000Z") }),
  null,
  "past event + 7d grace → stays dormant (no month-late wrap-ups)"
);
// missing lastSentStep reads as owed (matches the live parked records' shape)
assert.ok(decideRideChallengeWrapUpRevive({ ...PARKED, lastSentStep: null }), "missing lastSentStep → owed → revived");
// env/config override moves the whole schedule per season
{
  const custom = decideRideChallengeWrapUpRevive({ ...PARKED, followUpIso: "2027-09-15T13:00:00.000Z" })!;
  const dueMs = Date.parse(custom.nextDueAtIso);
  const customEventMs = Date.parse("2027-09-15T13:00:00.000Z");
  assert.ok(dueMs >= customEventMs && dueMs <= customEventMs + 2 * DAY, "followUpIso override moves the wrap-up revive per season");
}

// ── the wrap-up message: pinned template, no re-intro, asks for the final mileage ──
const wrapUp = buildRideChallengeWrapUpReply({ firstName: "John" });
assert.equal(
  wrapUp,
  "Hi John — this year's ride challenge is wrapping up! Stop in when you get a chance so we can record your final mileage. We'd love to hear how far you rode this season.",
  "wrap-up template pinned"
);
assert.ok(!/this is/i.test(wrapUp), "wrap-up never re-introduces the agent (C1.2a — the signup ack already introduced)");
assert.ok(/final mileage/i.test(wrapUp), "wrap-up asks for the final mileage (the deferred touch's whole job)");
assert.ok(buildRideChallengeWrapUpReply({ firstName: null }).startsWith("Hi — "), "missing first name degrades to a plain greeting");

// ── wiring source-guards: heal + compose branch ──
{
  const reviveStart = apiIndex.indexOf("let rideChallengeWrapUpsRevived = 0");
  const reviveBlock = reviveStart >= 0 ? apiIndex.slice(reviveStart, reviveStart + 1800) : "";
  assert.ok(
    reviveBlock.includes("decideRideChallengeWrapUpRevive({") &&
      reviveBlock.includes('recordRouteOutcome("manual", "ride_challenge_wrapup_revived"') &&
      reviveBlock.includes('cad.status = "active"') &&
      reviveBlock.includes("cad.nextDueAt = revive.nextDueAtIso"),
    "state-reconcile revive heal is wired through the routeStateReducer decision and records the outcome"
  );
  assert.ok(
    /conv\.status === "closed" \|\| conv\.closedAt/.test(reviveBlock),
    "revive heal skips closed conversations (the tick never fires their touch — no zombie actives)"
  );
  const composeIdx = apiIndex.indexOf("=== RIDE_CHALLENGE_WRAPUP_MARKER");
  const longTermIdx = apiIndex.indexOf('} else if (cadence.kind === "long_term") {');
  assert.ok(composeIdx >= 0, "cadence tick has the wrap-up compose branch");
  assert.ok(
    longTermIdx > composeIdx,
    "wrap-up compose branch sits BEFORE the generic long_term builder — the revived record must compose the mileage ask, not a sales check-in"
  );
  assert.ok(
    apiIndex.slice(composeIdx, composeIdx + 700).includes("buildRideChallengeWrapUpReply({ firstName })"),
    "compose branch uses the pinned template builder"
  );
}

console.log("PASS ride-challenge event cadence eval — one wrap-up touch (9/15/26), legacy stragglers realigned, prequal/sweepstakes untouched, parked signups revived staggered + convergent");
