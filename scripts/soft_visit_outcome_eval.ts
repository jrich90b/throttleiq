/**
 * soft_visit_outcome:eval — pins the soft-visit outcome loop:
 *   (a) shouldPromptSoftVisitOutcome — the owner "did they show?" prompt the morning AFTER
 *       the visit (never before it's over), once, only when no booked appointment owns the
 *       outcome and the conv is open;
 *   (b) shouldHoldSoftVisitForOutcome / softVisitOutcomeAutoResumeReached — keep the customer
 *       cadence QUIET from the visit day until the rep records an outcome, then auto-resume a
 *       gentle re-invite after ~3 business days if none is recorded (Joe, 6/15). The hold never
 *       suppresses the day-before reminder (it starts at the visit day) and respects
 *       closed/sold/booked.
 * Plus the tick wiring that applies the hold/auto-resume.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  shouldPromptSoftVisitOutcome,
  shouldHoldSoftVisitForOutcome,
  softVisitOutcomeAutoResumeReached,
  SOFT_VISIT_OUTCOME_AUTO_RESUME_BUSINESS_DAYS
} from "../services/api/src/domain/conversationStore.ts";

const NOW = Date.parse("2026-06-22T13:00:00Z"); // Monday, ~2 days after a 6/20 (Saturday) visit
const visited = { year: 2026, month: 6, day: 20 };
const future = { year: 2026, month: 6, day: 30 };
const activeCadence = { status: "active", kind: "standard", nextDueAt: "2026-06-23T13:00:00Z" };

// 1) Outcome PROMPT decision
assert.equal(
  shouldPromptSoftVisitOutcome({ scheduleSoft: { windowStart: visited, windowLabel: "Saturday" } }, NOW),
  true,
  "visit day passed + no outcome -> prompt"
);
assert.equal(
  shouldPromptSoftVisitOutcome({ scheduleSoft: { windowStart: visited, outcomePromptedAt: "2026-06-21T13:00:00Z" } }, NOW),
  false,
  "already prompted -> skip (idempotent)"
);
assert.equal(
  shouldPromptSoftVisitOutcome({ scheduleSoft: { windowStart: visited }, appointment: { bookedEventId: "evt" } }, NOW),
  false,
  "booked appointment owns the outcome -> skip"
);
assert.equal(
  shouldPromptSoftVisitOutcome({ scheduleSoft: { windowStart: visited }, closedReason: "sold" }, NOW),
  false,
  "closed/sold -> skip"
);
assert.equal(shouldPromptSoftVisitOutcome({ scheduleSoft: { windowStart: future } }, NOW), false, "visit day in the future -> not yet");
assert.equal(shouldPromptSoftVisitOutcome({}, NOW), false, "no scheduleSoft -> skip");
assert.equal(shouldPromptSoftVisitOutcome(null, NOW), false, "null conv -> skip");
// never ask before the visit day is over (the morning of)
assert.equal(
  shouldPromptSoftVisitOutcome({ scheduleSoft: { windowStart: visited } }, Date.parse("2026-06-20T14:00:00Z")),
  false,
  "morning of the visit -> not yet (don't ask before it's over)"
);
// a multi-day window uses the later windowEnd
assert.equal(
  shouldPromptSoftVisitOutcome({ scheduleSoft: { windowStart: visited, windowEnd: future } }, NOW),
  false,
  "multi-day window uses the later windowEnd -> not yet"
);

// 2) Cadence HOLD decision — quiet through the visit, pending outcome
assert.equal(
  shouldHoldSoftVisitForOutcome({ scheduleSoft: { windowStart: visited }, followUpCadence: { ...activeCadence } }, NOW),
  true,
  "visit day reached + active cadence + no outcome -> HOLD the customer cadence"
);
assert.equal(
  shouldHoldSoftVisitForOutcome({ scheduleSoft: { windowStart: future }, followUpCadence: { ...activeCadence } }, NOW),
  false,
  "before the visit day -> do NOT hold (let the day-before reminder fire)"
);
assert.equal(
  shouldHoldSoftVisitForOutcome({ scheduleSoft: { windowStart: visited }, followUpCadence: { ...activeCadence }, closedReason: "sold" }, NOW),
  false,
  "closed/sold owns the outcome -> do not hold"
);
assert.equal(
  shouldHoldSoftVisitForOutcome(
    { scheduleSoft: { windowStart: visited }, followUpCadence: { ...activeCadence }, appointment: { bookedEventId: "evt" } },
    NOW
  ),
  false,
  "booked appointment owns the outcome -> do not hold"
);
assert.equal(
  shouldHoldSoftVisitForOutcome({ scheduleSoft: { windowStart: visited }, followUpCadence: { status: "stopped" } }, NOW),
  false,
  "no active cadence -> nothing to hold"
);
assert.equal(
  shouldHoldSoftVisitForOutcome({ scheduleSoft: { windowStart: visited }, followUpCadence: { status: "active", kind: "post_sale" } }, NOW),
  false,
  "post-sale cadence is never soft-visit-held"
);
assert.equal(shouldHoldSoftVisitForOutcome({ followUpCadence: { ...activeCadence } }, NOW), false, "no scheduleSoft -> not a soft visit");
// once the grace window passes, stop holding (so the cadence can auto-resume)
assert.equal(
  shouldHoldSoftVisitForOutcome({ scheduleSoft: { windowStart: visited }, followUpCadence: { ...activeCadence } }, Date.parse("2026-06-25T13:00:00Z")),
  false,
  "after ~3 business days with no outcome -> stop holding (auto-resume)"
);

// 3) Auto-resume grace boundary (~3 business days)
assert.equal(SOFT_VISIT_OUTCOME_AUTO_RESUME_BUSINESS_DAYS, 3, "grace window is 3 business days");
assert.equal(
  softVisitOutcomeAutoResumeReached({ scheduleSoft: { windowStart: visited } }, NOW),
  false,
  "Monday after a Saturday visit = 1 business day -> not yet"
);
assert.equal(
  softVisitOutcomeAutoResumeReached({ scheduleSoft: { windowStart: visited } }, Date.parse("2026-06-25T13:00:00Z")),
  true,
  "Thursday after a Saturday visit = 4 business days -> auto-resume reached"
);
// weekend days don't count toward the grace window
assert.equal(
  softVisitOutcomeAutoResumeReached({ scheduleSoft: { windowStart: { year: 2026, month: 6, day: 19 } } }, Date.parse("2026-06-22T13:00:00Z")),
  false,
  "Fri visit -> Mon = 1 business day (Sat/Sun skipped) -> not yet"
);

// 4) Tick wiring (the maintenance tick applies the hold + auto-resume)
const idx = fs.readFileSync(path.resolve("services/api/src/index.ts"), "utf8");
assert.ok(/maybeCreateSoftVisitOutcomeTodo\(conv, now\.getTime\(\)\)/.test(idx), "tick must call maybeCreateSoftVisitOutcomeTodo");
assert.ok(/scheduleSoft\.outcomePromptedAt = nowIso\(\)/.test(idx), "outcome creation must set the idempotency flag");
assert.ok(/shouldHoldSoftVisitForOutcome\(conv, now\.getTime\(\)\)/.test(idx), "tick must apply the soft-visit cadence hold");
assert.ok(/pauseFollowUpCadence\(conv,[\s\S]*?"soft_visit_outcome_pending"\)/.test(idx), "hold must pause the cadence with the soft_visit_outcome_pending reason");
assert.ok(/softVisitOutcomeAutoResumeReached\(conv, now\.getTime\(\)\)/.test(idx), "tick must auto-resume once the grace window passes");
assert.ok(/scheduleSoft\.autoResumedAt = now\.toISOString\(\)/.test(idx), "auto-resume must stamp scheduleSoft.autoResumedAt");

console.log("PASS soft-visit-outcome eval (prompt + hold + auto-resume + tick wiring)");
