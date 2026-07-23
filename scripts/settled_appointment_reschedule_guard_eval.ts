/**
 * Settled-appointment reschedule guard eval.
 *
 * Production fixture: +17165011693 (James Mercer, 2026-07-22T22:45), msg
 * msg_7ab34f4f7ade1_1784760315728.
 *
 * The agent pitched a newly-arrived bike ("a 2020 Harley-Davidson Tri Glide Ultra just landed
 * here at the shop. Would you like to stop by and check it out?"). The customer answered with a
 * pure BUDGET OBJECTION — "Still a little rich for me. Im looking in the 18 to 20 thousand range.
 * But thanks Gio" — and 14 seconds later we texted him a test-ride RESCHEDULE booking link.
 *
 * ROOT CAUSE (two defects):
 *   1. State latch. appointment.reschedulePending had been stuck `true` since 2026-05-16 and was
 *      never cleared when staff recorded the May 2 outcome as `showed`. allowPastAppointmentReschedule
 *      treated that latch as sufficient reason to keep a 2.5-month-past appointment reschedulable,
 *      and the reschedule arm re-sets the latch every time it fires — self-renewing, no expiry.
 *   2. State used as intent. rescheduleIntent listed `reschedulePending` as a standalone sufficient
 *      disjunct, so on a latched thread ANY inbound routes to the reschedule arm. Nothing about
 *      this turn's text was read.
 *
 * FIX (both paths, centralized in routeStateReducer):
 *   - isSettledPastAppointment(): past calendar day AND recorded outcome `showed` => no rebook debt.
 *     Vetoes allowPastAppointmentReschedule (live) and the regen outcome-reschedule nudge, and the
 *     live path heals the stuck latch once. Reads ONLY structured state, never customer text —
 *     a state/side-effect invariant guard, deterministic per AGENTS.md rule 2.
 *   - pendingRescheduleCarriesTurnIntent(): the latch becomes an ENABLER, never sufficient on its
 *     own; a signal read from THIS turn must accompany it. Fail direction: if every signal misses
 *     we do not send an unsolicited booking link and the turn falls through to the ordinary draft
 *     — which on this very turn produced the right answer ("I'll keep an eye out for trikes in the
 *     $18-20k range and text you if one comes in").
 *
 * Deliberately scoped to the SHOWED family: `did_not_show` and `cancelled` latches are real rebook
 * debts and must keep working.
 */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";

const { isSettledPastAppointment, pendingRescheduleCarriesTurnIntent } = await import(
  "../services/api/src/domain/routeStateReducer.ts"
);
const { parseRequestedDayTime } = await import(
  "../services/api/src/domain/conversationStore.ts"
);
const { extractTimeToken } = await import(
  "../services/api/src/domain/legacyRegexFallback.ts"
);
const { isAffordabilityRideConfidenceObjectionText } = await import(
  "../services/api/src/domain/transitionSafety.ts"
);

const TZ = "America/New_York";

// The exact production turn.
const TURN_TEXT =
  "Still a little rich for me. Im looking in the 18 to 20 thousand range. But thanks Gio";
const NOW_MS = Date.parse("2026-07-22T22:45:15.723Z");
const APPT_WHEN_ISO = "2026-05-02T15:00:00.000Z"; // Sat, May 2, 11:00 AM ET — ~2.5 months past.

// ── Behavioral pins on the REAL upstream helpers: prove nothing else in the reschedule
// disjunction fired, i.e. the bare `reschedulePending` latch is genuinely what routed this turn.
assert.equal(
  parseRequestedDayTime(TURN_TEXT, TZ),
  null,
  "budget objection must not parse as a requested day/time"
);
assert.equal(extractTimeToken(TURN_TEXT), null, "budget objection carries no time token");
assert.equal(
  isAffordabilityRideConfidenceObjectionText(TURN_TEXT),
  false,
  "this turn is not claimed by the upstream affordability arm"
);

// ── Guard A: the settled (past + showed) appointment.
assert.equal(
  isSettledPastAppointment({
    whenIso: APPT_WHEN_ISO,
    nowMs: NOW_MS,
    timeZone: TZ,
    outcomePrimaryStatus: "showed",
    outcomeLegacyStatus: "follow_up"
  }),
  true,
  "+17165011693: past day + recorded 'showed' is a SETTLED appointment — nothing left to reschedule"
);

// Counter-cases that must KEEP rescheduling (real rebook debts).
assert.equal(
  isSettledPastAppointment({
    whenIso: "2026-05-15T19:15:00.000Z",
    nowMs: NOW_MS,
    timeZone: TZ,
    outcomePrimaryStatus: "did_not_show",
    outcomeLegacyStatus: "no_show"
  }),
  false,
  "a no-show is a real rebook debt — must stay reschedulable"
);
assert.equal(
  isSettledPastAppointment({
    whenIso: "2026-06-18T14:00:00.000Z",
    nowMs: NOW_MS,
    timeZone: TZ,
    outcomePrimaryStatus: "cancelled",
    outcomeLegacyStatus: "cancelled"
  }),
  false,
  "a cancelled appointment is a real rebook debt — must stay reschedulable"
);

// Fail-direction pins: unsure => false (keep today's behavior, never suppress a real rebook).
assert.equal(
  isSettledPastAppointment({
    whenIso: APPT_WHEN_ISO,
    nowMs: NOW_MS,
    timeZone: TZ,
    outcomePrimaryStatus: null,
    outcomeLegacyStatus: null
  }),
  false,
  "no recorded outcome => not settled (fail toward keeping the existing path)"
);
assert.equal(
  isSettledPastAppointment({
    whenIso: null,
    nowMs: NOW_MS,
    timeZone: TZ,
    outcomePrimaryStatus: "showed",
    outcomeLegacyStatus: null
  }),
  false,
  "unparseable/absent whenIso => not settled"
);
// A FUTURE appointment is never settled, even with a stray outcome recorded.
assert.equal(
  isSettledPastAppointment({
    whenIso: "2026-08-14T15:00:00.000Z",
    nowMs: NOW_MS,
    timeZone: TZ,
    outcomePrimaryStatus: "showed",
    outcomeLegacyStatus: null
  }),
  false,
  "an upcoming appointment is never settled"
);
// Legacy records carrying only the old status field still resolve to the showed family.
assert.equal(
  isSettledPastAppointment({
    whenIso: APPT_WHEN_ISO,
    nowMs: NOW_MS,
    timeZone: TZ,
    outcomePrimaryStatus: null,
    outcomeLegacyStatus: "sold"
  }),
  true,
  "legacy 'sold' maps to the showed family — settled"
);

// ── Guard B: the latch may not stand in for this turn's intent.
const THIS_TURN_SIGNALS = {
  explicitReschedulePhrase: false, // no reschedule wording in the budget objection
  hasRequestedDayTime: false, // parseRequestedDayTime === null, pinned above
  parserExplicitScheduleIntent: false,
  parserSchedulingAckAction: "none" as string | null
};

assert.equal(
  pendingRescheduleCarriesTurnIntent({
    reschedulePending: true,
    settledPastAppointment: true,
    ...THIS_TURN_SIGNALS
  }),
  false,
  "+17165011693: a stale latch on a settled appointment must NOT route a budget objection to reschedule"
);
// Even if the appointment were not settled, a bare latch with no turn signal must not carry.
assert.equal(
  pendingRescheduleCarriesTurnIntent({
    reschedulePending: true,
    settledPastAppointment: false,
    ...THIS_TURN_SIGNALS
  }),
  false,
  "the reschedulePending latch is an enabler, never sufficient intent on its own"
);
// The legitimate rebook flow still works: we offered to get them back in, they accepted.
assert.equal(
  pendingRescheduleCarriesTurnIntent({
    reschedulePending: true,
    settledPastAppointment: false,
    explicitReschedulePhrase: false,
    hasRequestedDayTime: false,
    parserExplicitScheduleIntent: false,
    parserSchedulingAckAction: "ask_for_available_times"
  }),
  true,
  "a parser-read scheduling acceptance on a latched thread still reaches the reschedule arm"
);
assert.equal(
  pendingRescheduleCarriesTurnIntent({
    reschedulePending: true,
    settledPastAppointment: false,
    explicitReschedulePhrase: true,
    hasRequestedDayTime: false,
    parserExplicitScheduleIntent: false,
    parserSchedulingAckAction: null
  }),
  true,
  "explicit reschedule wording still reaches the reschedule arm"
);
assert.equal(
  pendingRescheduleCarriesTurnIntent({
    reschedulePending: false,
    settledPastAppointment: false,
    explicitReschedulePhrase: false,
    hasRequestedDayTime: true,
    parserExplicitScheduleIntent: true,
    parserSchedulingAckAction: "confirm_proposed_appointment"
  }),
  false,
  "with no latch this helper never claims the turn (the other disjuncts own those cases)"
);

// ── Source pins: the settled-appointment veto must exist in BOTH reply paths — the live
// /webhooks/twilio reschedule gate AND the /conversations/:id/regenerate outcome-reschedule gate.
const apiSource = await fs.readFile(path.resolve("services/api/src/index.ts"), "utf8");
assert.equal(
  (apiSource.match(/isSettledPastAppointment\(\{/g) ?? []).length,
  2,
  "isSettledPastAppointment must be applied in BOTH the live and regen paths"
);
assert.equal(
  (apiSource.match(/pendingRescheduleCarriesTurnIntent\(\{/g) ?? []).length,
  1,
  "pendingRescheduleCarriesTurnIntent must gate the live rescheduleIntent decision"
);
// The bare latch must no longer be a standalone disjunct in the live rescheduleIntent expression.
const intentIdx = apiSource.indexOf("const rescheduleIntent =");
assert.ok(intentIdx > 0, "the live rescheduleIntent decision must exist");
const intentExpr = apiSource.slice(intentIdx, intentIdx + 600);
assert.ok(
  !/\(\s*reschedulePending \|\|/.test(intentExpr),
  "reschedulePending must not be a standalone sufficient disjunct in rescheduleIntent"
);
// The veto must gate allowPastAppointmentReschedule, not just sit nearby.
assert.ok(
  /const allowPastAppointmentReschedule =[\s\S]{0,400}!settledPastAppointment/.test(apiSource),
  "allowPastAppointmentReschedule must be vetoed by settledPastAppointment"
);
// The regen gate must carry the veto, and regenerate stays NON-DESTRUCTIVE: only the live path
// heals the latch. (The guard is called inline rather than via a `const regen*` local — a new
// hand-mirrored local is exactly the drift surface route_parity_guard:eval ratchets against.)
const regenIdx = apiSource.indexOf("const regenAppointmentOutcomeRescheduleReply =");
assert.ok(regenIdx > 0, "the regen outcome-reschedule gate must exist");
const regenGate = apiSource.slice(regenIdx, regenIdx + 1400);
assert.ok(
  /!isSettledPastAppointment\(\{/.test(regenGate),
  "the regen outcome-reschedule gate must be vetoed by isSettledPastAppointment"
);
assert.ok(
  !/conv\.appointment\.reschedulePending = false/.test(regenGate),
  "regenerate must not mutate the reschedulePending latch"
);

console.log("settled_appointment_reschedule_guard:eval OK");
