/**
 * The staff confirms a TIME, the thread already settled the DAY — deterministic half.
 *
 * Production fixture: John Kelly +17169902571, 2026-08-12. Customer: "Oh okay I get out at 3 joe I
 * should be able to stop today". Staff: "Ok sounds good John, see you around 3!" then "Ok 3:45
 * works!". The parser returned state=confirmed_booking at 0.88 with day=null, so
 * parseRequestedDayTime saw "around 3" with no day token, returned null, and the whole booking fell
 * through in silence — no calendar event, no appointment, nothing in the booked funnel. The
 * operator filed it twice in four minutes. Measured on the live store: ~10 staff confirmations in
 * 90d carry a clock time and no day, against 52 booked events in the same window.
 *
 * The comprehension half (does the parser carry the day the thread settled?) is LLM-backed and
 * lives in manual_outbound_appointment:eval, fixtures
 * staff_confirms_time_day_from_context_*. THIS file pins the parts that must never drift without an
 * LLM call: the phrase composer's output actually RESOLVES, the prompt still carries the rule and
 * its few-shots, and both are still WIRED — an unwired fix is inert (SKILL trap 2).
 */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";

const { parseRequestedDayTime } = await import("../services/api/src/domain/conversationStore.ts");
const {
  composeManualOutboundRequestedPhrase,
  MANUAL_OUTBOUND_APPOINTMENT_EXAMPLES,
  MANUAL_OUTBOUND_APPOINTMENT_PROMPT_RULES
} = await import("../services/api/src/domain/manualOutboundAppointment.ts");

const TZ = "America/New_York";

// ---------------------------------------------------------------- composer: the executed decision
// John's first turn: the parser named the day, the normalized phrase dropped it.
const johnAroundThree = composeManualOutboundRequestedPhrase({
  requested: { day: "today", timeText: "around 3" },
  normalizedText: "around 3"
});
assert.equal(johnAroundThree, "today around 3", "a day the parser returned goes back on a day-less phrase");
const johnResolved = parseRequestedDayTime(johnAroundThree, TZ);
assert.ok(johnResolved, "the composed phrase must resolve to a bookable slot");
assert.equal(johnResolved!.hour24, 15, "'around 3' reads as 3pm");
assert.equal(johnResolved!.minute, 0);

// John's second turn, with minutes.
const johnThreeFortyFive = composeManualOutboundRequestedPhrase({
  requested: { day: "today", timeText: "3:45" },
  normalizedText: "3:45"
});
const johnThreeFortyFiveResolved = parseRequestedDayTime(johnThreeFortyFive, TZ);
assert.ok(johnThreeFortyFiveResolved, "'3:45' with the thread's day must resolve");
assert.equal(johnThreeFortyFiveResolved!.hour24, 15);
assert.equal(johnThreeFortyFiveResolved!.minute, 45);

// A normalized phrase that ALREADY carries the day is left exactly as it is — no doubled day.
assert.equal(
  composeManualOutboundRequestedPhrase({
    requested: { day: "tomorrow", timeText: "10:00 AM" },
    normalizedText: "tomorrow 10:00 AM"
  }),
  "tomorrow 10:00 AM",
  "a normalized phrase that already names the day is untouched"
);
assert.equal(
  composeManualOutboundRequestedPhrase({
    requested: { day: "Tuesday", timeText: "4:30" },
    normalizedText: "Tuesday at 4:30"
  }),
  "Tuesday at 4:30",
  "the day is matched as a word, not appended blindly"
);

// THE FAIL DIRECTION. No day from the parser means no day invented here: the phrase stays
// unresolvable and the booking is skipped, which is where this path failed before the fix.
const noDay = composeManualOutboundRequestedPhrase({
  requested: { day: "", timeText: "3:45" },
  normalizedText: "3:45"
});
assert.equal(noDay, "3:45", "no day from the parser, no day in the phrase");
assert.equal(parseRequestedDayTime(noDay, TZ), null, "a day-less phrase must stay unbookable");
assert.equal(composeManualOutboundRequestedPhrase(null), "", "a null parse composes to nothing");
assert.equal(
  composeManualOutboundRequestedPhrase({ requested: { day: "Tuesday", timeText: "4:30" }, normalizedText: "" }),
  "Tuesday 4:30",
  "with no normalized phrase the day and time still compose"
);

// ------------------------------------------------------------------------- the prompt still says it
const rules = MANUAL_OUTBOUND_APPOINTMENT_PROMPT_RULES.join("\n");
assert.ok(
  rules.includes("already settle which day"),
  "the day-from-context rule must stay in the parser prompt"
);
assert.ok(
  rules.includes("leave requested.day empty rather than guessing"),
  "the bounded half of the rule — never guess a day nobody named — must stay in the prompt"
);
assert.ok(
  rules.includes("normalized_text must include requested.day"),
  "the prompt must keep asking for the day inside normalized_text"
);
const contextExamples = MANUAL_OUTBOUND_APPOINTMENT_EXAMPLES.filter(
  ex => ex.includes("Recent messages") && ex.includes("confirmed_booking")
);
assert.ok(
  contextExamples.length >= 2,
  `the prompt must keep its day-from-context few-shots, found ${contextExamples.length}`
);
assert.ok(
  contextExamples.some(ex => ex.includes('"day":"today"')),
  "one few-shot must show the day being carried from the thread"
);
assert.ok(
  MANUAL_OUTBOUND_APPOINTMENT_EXAMPLES.some(
    ex => ex.includes("Recent messages") && ex.includes('"day":""')
  ),
  "and one must show a day-less confirmation staying day-less"
);

// ------------------------------------------------- the two rules the Paul Harrigan shape needed
// +17169467451, 2026-08-17, operator-reported the same afternoon: "This did not seem to book an
// appointment at 11 today". The day WAS settled ("I'm off today ... come out this morning"), so the
// earlier day-from-context rule should have carried it. MEASURED n=12 against the pre-fix prompt:
// state was confirmed_booking 12/12 but the day carried only 5/12 — the booking was a coin flip and
// it lost. After these two rules and the matching few-shot: 12/12, and both day-less negatives held
// at 6/6, which is the direction that matters (a carried wrong day books a wrong appointment).
// The LLM half replays as fixture staff_confirms_time_day_from_context_long_message_1 in
// manual_outbound_appointment:eval; these are the pins that fail WITHOUT an API call.
assert.ok(
  rules.includes("asking only WHAT TIME"),
  "a staff 'what time?' question must be documented as not unsettling the day"
);
assert.ok(
  rules.includes("inside a longer message about several topics"),
  "a day word buried in a multi-topic message must still count as settling the day"
);
{
  // The few-shot has to carry BOTH features at once, or it teaches neither: a what-time question
  // between the day and the confirmation, AND the day inside a longer multi-topic message.
  const combined = MANUAL_OUTBOUND_APPOINTMENT_EXAMPLES.filter(
    ex =>
      ex.includes("Recent messages") &&
      ex.includes('"day":"today"') &&
      /what time were you thinking/i.test(ex)
  );
  assert.equal(
    combined.length,
    1,
    `exactly one few-shot must show a what-time question sitting between the settled day and the confirmation, found ${combined.length}`
  );
  const [example] = combined;
  const prompt = String(example).split("output:")[0] ?? "";
  const dayLine = prompt.split("\\n").find(l => /\bday off today\b|\btoday\b/i.test(l)) ?? "";
  assert.ok(
    dayLine.length > 90,
    `the day in that few-shot must sit inside a LONG multi-topic message, not a bare one (length ${dayLine.length})`
  );
  // …and it must not simply restate the production thread, or the eval stops testing the rule and
  // starts testing one string (the same reason the 2026-08-20 few-shot was written off-surface).
  assert.ok(
    !prompt.includes("test ride the 2021") && !prompt.includes("USAA"),
    "the few-shot surface must differ from the production thread it was learned from"
  );
}

// -------------------------------------------------------------------------------- still WIRED
const llmDraftSource = await fs.readFile(
  path.resolve("services/api/src/domain/llmDraft.ts"),
  "utf8"
);
assert.ok(
  llmDraftSource.includes("...MANUAL_OUTBOUND_APPOINTMENT_PROMPT_RULES"),
  "the manual-outbound parser prompt must still spread the shared rules"
);
assert.ok(
  llmDraftSource.includes("...MANUAL_OUTBOUND_APPOINTMENT_EXAMPLES"),
  "the manual-outbound parser prompt must still spread the shared few-shots"
);

const indexSource = await fs.readFile(path.resolve("services/api/src/index.ts"), "utf8");
assert.ok(
  indexSource.includes("composeManualOutboundRequestedPhrase(manualOutboundAppointmentParse)"),
  "the staff-send path must compose the requested phrase through the shared helper"
);
assert.ok(
  indexSource.includes("const contextDayResolvedInThePast ="),
  "the past-slot invariant guard must stay in the staff-send path"
);
assert.ok(
  indexSource.includes("!contextDayResolvedInThePast"),
  "the past-slot guard must still gate shouldInferManualAppointment"
);
assert.ok(
  indexSource.includes("localPartsToUtcDate(schedulerTimezone, requested).getTime() < Date.now()"),
  "the guard must compare the RESOLVED slot against now, not a parsed string"
);
assert.ok(
  !indexSource.includes("function manualOutboundAppointmentRequestedPhrase"),
  "the old inline phrase builder must not come back beside the shared one"
);

console.log("manual_outbound_day_from_context: all checks passed.");
