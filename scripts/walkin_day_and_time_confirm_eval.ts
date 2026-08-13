/**
 * walkin_day_and_time_confirm:eval — a walk-in note that names a day AND a time must say that time
 * back, instead of dropping the whole commitment on the floor.
 *
 * THE PRODUCTION TURN. Paul Harrigan (+17169467451), Walk In ref 11779, first touch
 * 2026-08-11T21:55Z. The salesperson's note and the text we actually sent:
 *
 *   note: "We bought Paul's 2015 FLTRU earlier in the year. He is not in the market to get back on
 *          a bike and like the 2021 FLTRXS with 131ci engine. Then saw the 2020 FLTRXS and liked it
 *          better. Wants to take it for a test ride on Saturday 8/15/2026 at 12pm (Step 4)"
 *   sent: "Hi Paul — this is Scott at American Harley-Davidson. Thanks for stopping in - I'll follow
 *          up about the 2020 FLTRXS Road Glide Special."
 *
 * Scott rewrote it by hand, confirmed the ride and booked it himself; the nightly replay filed it
 * P1 and the human-correction detector filed it again the same night.
 *
 * THE PARSER WAS NOT WRONG. Executed against the verbatim note above it returns
 * `return_visit: "committed_day_and_time"`, `return_day_text: "Saturday 8/15/2026 at 12pm"`,
 * confidence 0.95, `test_ride_requested: true` — 4 runs of 4, no instability. Every CONSUMER threw
 * it away: the tail builder returned "" for anything that was not `committed_day`, and the route
 * gated the day resolution on the same string. So this file pins the CONSUMERS, deterministically,
 * and never calls the parser: the reading is settled, the discarding was the defect.
 *
 * WHY THE ASSERTIONS ARE SHAPED THIS WAY. Each one EXECUTES the function the route calls — the
 * ratchet trap is that un-wiring leaves source-text assertions green (SKILL trap 2). The clock is
 * pinned two ways: every date string carries a 4-DIGIT YEAR, which `parseRequestedDayTime` never
 * rolls forward (executed: "8/15/2020" stays 2020), and every `asOfIso` is the note's real capture
 * instant. Nothing here reads the wall clock.
 *
 * Deterministic — no clock, no network, no LLM.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  buildWalkInReturnVisitTail,
  formatWalkInReturnDayLabel,
  formatWalkInReturnTimeLabel
} from "../services/api/src/domain/walkInFollowUpTopic.ts";
import {
  parseRequestedDayTime,
  parseRequestedDateOnly
} from "../services/api/src/domain/conversationStore.ts";

const TZ = "America/New_York";
/** The note's real capture instant, `lead.walkInCommentCapturedAt` in the live store. */
const AS_OF = "2026-08-11T21:50:08.489Z";
/** Verbatim `return_day_text` off the parser, run against the verbatim live note. */
const PAUL_SLOT_TEXT = "Saturday 8/15/2026 at 12pm";
/** Verbatim from the live store — the tail that actually went out, and must not any more. */
const PAUL_SENT_TAIL = "I'll follow up about the 2020 FLTRXS Road Glide Special.";

const ACK = "Thanks again for your time.";
const CONFIDENCE_MIN = 0.8;

// ---------------------------------------------------------------------------
// 1) THE RESOLVER CHAIN the route runs, on the real slot text. If any link here
//    goes null the tail below can never fire in production.
// ---------------------------------------------------------------------------
const paulParts = parseRequestedDayTime(PAUL_SLOT_TEXT, TZ);
assert.deepEqual(
  paulParts,
  { year: 2026, month: 8, day: 15, hour24: 12, minute: 0, dayOfWeek: "saturday" },
  "the real slot text resolves to Saturday 15 Aug 2026, 12:00 — day AND clock time"
);

const paulDayLabel = formatWalkInReturnDayLabel(paulParts, TZ, AS_OF);
assert.equal(paulDayLabel, "Saturday, Aug 15", "the day label is the one the sibling lane already ships");

const paulTimeLabel = formatWalkInReturnTimeLabel(paulParts?.hour24, paulParts?.minute);
assert.equal(paulTimeLabel, "12:00 PM", "noon is 12:00 PM, not 0:00 AM");

// The clock formatter's own edges — midnight and noon are where a 12-hour clock goes wrong.
assert.equal(formatWalkInReturnTimeLabel(0, 0), "12:00 AM", "midnight is 12:00 AM");
assert.equal(formatWalkInReturnTimeLabel(13, 30), "1:30 PM", "afternoon minutes survive");
assert.equal(formatWalkInReturnTimeLabel(9, 5), "9:05 AM", "single-digit minutes are padded");
assert.equal(formatWalkInReturnTimeLabel(24, 0), "", "an impossible hour states no time at all");
assert.equal(formatWalkInReturnTimeLabel(null, null), "", "no time in, no time out");

// ---------------------------------------------------------------------------
// 2) THE FIX. The day-and-time lane speaks, says both facts, and ends by asking.
// ---------------------------------------------------------------------------
const paulTail = buildWalkInReturnVisitTail({
  ackSentence: ACK,
  returnVisit: "committed_day_and_time",
  confidence: 0.95,
  confidenceMin: CONFIDENCE_MIN,
  dayLabel: paulDayLabel,
  timeLabel: paulTimeLabel,
  familyLabel: "",
  testRide: true
});
assert.equal(
  paulTail,
  "Thanks again for your time. Just confirming Saturday, Aug 15 at 12:00 PM. I'll make sure we're ready for you. Does that still work?",
  "the production turn now confirms the day and the time the salesperson wrote down"
);
assert.ok(paulTail.includes("Saturday, Aug 15"), "the day is stated");
assert.ok(paulTail.includes("12:00 PM"), "the time is stated");
assert.ok(paulTail.trim().endsWith("?"), "it ends on the advancing question (charter C1.7)");
assert.ok(
  !paulTail.includes("What time works best"),
  "it never re-asks a time the salesperson already wrote down (charter C4.1, confirm don't re-ask)"
);
assert.ok(
  !paulTail.includes(PAUL_SENT_TAIL),
  "the generic follow-up promise that shipped is not what ships now"
);
// It states no booking, no hold and no figure — the note is a staff log, not the customer
// confirming to us, so nothing irreversible may be claimed off it.
for (const overclaim of ["booked", "I've got you down", "$", "on the calendar", "confirmed for"]) {
  assert.ok(
    !paulTail.includes(overclaim),
    `the confirmation claims nothing we have not done — "${overclaim}" must not appear`
  );
}

// The family close is reused verbatim from the day-only lane, never a second phrasing.
assert.equal(
  buildWalkInReturnVisitTail({
    ackSentence: ACK,
    returnVisit: "committed_day_and_time",
    confidence: 0.9,
    confidenceMin: CONFIDENCE_MIN,
    dayLabel: "Tuesday, Aug 4",
    timeLabel: "5:30 PM",
    familyLabel: "Sportsters",
    testRide: true
  }),
  "Thanks again for your time. Just confirming Tuesday, Aug 4 at 5:30 PM. I'll have a few Sportsters ready for you. Does that still work?",
  "a named family and a test ride keep the sibling lane's close"
);

// ---------------------------------------------------------------------------
// 3) FAIL DIRECTION — every degraded input lands on behaviour that already ships.
// ---------------------------------------------------------------------------
const dayOnly = buildWalkInReturnVisitTail({
  ackSentence: ACK,
  returnVisit: "committed_day",
  confidence: 0.9,
  confidenceMin: CONFIDENCE_MIN,
  dayLabel: "Tuesday, Aug 4",
  familyLabel: "Sportsters",
  testRide: true
});
assert.equal(
  dayOnly,
  "Thanks again for your time. What time works best Tuesday, Aug 4? I'll have a few Sportsters ready for you.",
  "the day-only lane is byte-for-byte the sentence that shipped before this change"
);

// A day-and-time note whose slot text carries no clock time: the resolver returns null (executed
// below), so no time label reaches the builder and it asks for the time rather than inventing one.
assert.equal(
  parseRequestedDayTime("Saturday 8/15/2026", TZ),
  null,
  "a slot with no clock time in it resolves no time"
);
assert.deepEqual(
  parseRequestedDateOnly("Saturday 8/15/2026", TZ, AS_OF),
  { year: 2026, month: 8, day: 15, dayOfWeek: "saturday" },
  "the day still resolves through the date-only fallback the route keeps"
);
assert.equal(
  buildWalkInReturnVisitTail({
    ackSentence: ACK,
    returnVisit: "committed_day_and_time",
    confidence: 0.95,
    confidenceMin: CONFIDENCE_MIN,
    dayLabel: "Saturday, Aug 15",
    timeLabel: "",
    familyLabel: "",
    testRide: true
  }),
  "Thanks again for your time. What time works best Saturday, Aug 15? I'll make sure we're ready for you.",
  "no time resolved falls back to the day-only sentence, never to silence and never to a made-up time"
);

for (const [why, args] of [
  ["a tentative return is not a commitment", { returnVisit: "tentative" }],
  ["no return visit at all stays silent", { returnVisit: "none" }],
  ["an unrelated enum value stays silent", { returnVisit: "committed" }]
] as [string, { returnVisit: string }][]) {
  assert.equal(
    buildWalkInReturnVisitTail({
      ackSentence: ACK,
      confidence: 0.99,
      confidenceMin: CONFIDENCE_MIN,
      dayLabel: "Saturday, Aug 15",
      timeLabel: "12:00 PM",
      ...args
    }),
    "",
    why
  );
}
assert.equal(
  buildWalkInReturnVisitTail({
    ackSentence: ACK,
    returnVisit: "committed_day_and_time",
    confidence: 0.5,
    confidenceMin: CONFIDENCE_MIN,
    dayLabel: "Saturday, Aug 15",
    timeLabel: "12:00 PM"
  }),
  "",
  "a hedged reading below the floor says nothing — the confidence gate binds both lanes alike"
);
assert.equal(
  buildWalkInReturnVisitTail({
    ackSentence: ACK,
    returnVisit: "committed_day_and_time",
    confidence: 0.95,
    confidenceMin: CONFIDENCE_MIN,
    dayLabel: "",
    timeLabel: "12:00 PM"
  }),
  "",
  "a time with no day is never stated on its own"
);
// A day already past, or absurdly far out, is refused by the label — so the time is too.
assert.equal(
  formatWalkInReturnDayLabel({ year: 2026, month: 8, day: 1 }, TZ, AS_OF),
  "",
  "a day that already passed produces no label"
);
assert.equal(
  formatWalkInReturnDayLabel({ year: 2027, month: 8, day: 15 }, TZ, AS_OF),
  "",
  "a day a year out produces no label"
);

// ---------------------------------------------------------------------------
// 4) WIRING. Nothing above can prove the route still calls any of it — sabotaging
//    the call site back to `walkInReturnVisit === "committed_day"` left every
//    assertion above green. The handler is an Express route that cannot be
//    executed here, so the honest available proof is the exact call shape.
//    Written with .includes() on purpose: a pin containing an escaped paren is
//    counted as a source-text assertion by eval_source_pin_ratchet.
// ---------------------------------------------------------------------------
const routeSource = readFileSync(
  new URL("../services/api/src/routes/sendgridInbound.ts", import.meta.url),
  "utf8"
);
assert.ok(
  routeSource.includes('walkInReturnVisit === "committed_day_and_time"'),
  "the route recognises the day-and-time lane at all"
);
assert.ok(
  routeSource.includes("const walkInReturnDayCommitted ="),
  "both committed lanes resolve a day through one named local, not two drifting conditions"
);
assert.ok(
  routeSource.includes("walkInReturnDayCommitted && walkInReturnDayText"),
  "the tail is built for both committed lanes, not just the day-only one"
);
assert.ok(
  routeSource.includes("timeLabel: walkInReturnTimeLabel"),
  "the resolved time reaches the builder — a dropped argument reads as no time and silently restores the bug"
);
assert.ok(
  routeSource.includes("formatWalkInReturnTimeLabel(walkInReturnDayTimeParts?.hour24"),
  "the time label is formatted from the resolved parts, never from the note prose"
);
assert.ok(
  routeSource.includes("parseRequestedDayTime(walkInReturnDayText, walkInReturnTimeZone)"),
  "the clock time is read off the parser SLOT through the shared scheduling resolver"
);
// The cadence-day store stays on the day-only lane ON PURPOSE: the day-of check-in line asks
// "what time works best?", which would re-ask a customer who already named one. If this ever
// widens, buildWalkInReturnDayCheckInLine has to learn the time in the same change.
assert.ok(
  routeSource.includes('walkInReturnDayLabel && walkInReturnVisit === "committed_day"'),
  "the stored cadence day is still the day-only lane, so the day-of check-in cannot re-ask a stated time"
);

console.log("walkin_day_and_time_confirm:eval PASS");
