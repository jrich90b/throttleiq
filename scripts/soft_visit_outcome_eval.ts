/**
 * soft_visit_outcome:eval — pins shouldPromptSoftVisitOutcome (the soft-visit outcome
 * decision) + its tick wiring. A customer who committed to coming in ("I'll be there
 * Saturday") needs a showed-up/no-show outcome once the visit day passes, like booked
 * appointments + dealer rides already get. Fires the morning AFTER the visit (never before
 * it's over), once, only when no booked appointment owns the outcome and the conv is open.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { shouldPromptSoftVisitOutcome } from "../services/api/src/domain/conversationStore.ts";

const NOW = Date.parse("2026-06-22T13:00:00Z"); // ~2 days after a 6/20 (Saturday) visit
const visited = { year: 2026, month: 6, day: 20 };
const future = { year: 2026, month: 6, day: 30 };

// 1) Decision
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

// 2) Tick wiring (the backstop loop calls it once per conv, sets the idempotency flag)
const idx = fs.readFileSync(path.resolve("services/api/src/index.ts"), "utf8");
assert.ok(/maybeCreateSoftVisitOutcomeTodo\(conv, now\.getTime\(\)\)/.test(idx), "tick must call maybeCreateSoftVisitOutcomeTodo");
assert.ok(/scheduleSoft\.outcomePromptedAt = nowIso\(\)/.test(idx), "outcome creation must set the idempotency flag");

console.log("PASS soft-visit-outcome eval (decision + idempotency + tick wiring)");
