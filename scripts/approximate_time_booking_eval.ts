/**
 * Approximate-time booking eval. Production fixture: Chuck Bailey Jr
 * +17163197142, 2026-06-12 — answered "what day and time works best?" with
 * "Monday, 15 June around 10am" and was offered Saturday Jun 13 slots. Root
 * cause: parseExactTime dropped "around 10am" (approximate phrase on a round
 * hour with no minutes) to null, so the requested day+time never pinned a
 * slot and booking fell back to next-available.
 */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";

const { parseRequestedDayTime } = await import(
  "../services/api/src/domain/conversationStore.ts"
);

const storeSource = await fs.readFile(
  path.resolve("services/api/src/domain/conversationStore.ts"),
  "utf8"
);
assert.match(
  storeSource,
  /Approximate time on a round hour/,
  "parseExactTime must handle approximate round-hour times before the catch-all return null"
);

const TZ = "America/New_York";

// Chuck's literal turn: Monday 15 June around 10am.
const chuck = parseRequestedDayTime("Monday, 15 June around 10am", TZ);
assert.ok(chuck, "Chuck's day+time must parse");
assert.equal(chuck!.month, 6, "month is June");
assert.equal(chuck!.day, 15, "day is the 15th, not next-available");
assert.equal(chuck!.hour24, 10, "10am stays 10:00");
assert.equal(chuck!.minute, 0);

// Approximate variants on round hours.
const aroundThree = parseRequestedDayTime("can we do tuesday around 3", TZ);
assert.ok(aroundThree, "'around 3' must parse");
assert.equal(aroundThree!.hour24, 15, "'around 3' with no meridiem reads as 3pm by the 1-7 heuristic");

const about9 = parseRequestedDayTime("friday about 9am", TZ);
assert.ok(about9, "'about 9am' must parse");
assert.equal(about9!.hour24, 9);

const near5 = parseRequestedDayTime("saturday near 5pm", TZ);
assert.ok(near5, "'near 5pm' must parse");
assert.equal(near5!.hour24, 17);

// Approximate WITH minutes still works (the path that already existed).
const approxMin = parseRequestedDayTime("monday around 10:30am", TZ);
assert.ok(approxMin, "'around 10:30am' must parse");
assert.equal(approxMin!.hour24, 10);
assert.equal(approxMin!.minute, 30);

// A vague "around" with no usable hour still declines, rather than guessing.
const vague = parseRequestedDayTime("monday sometime around then", TZ);
assert.equal(vague, null, "'around then' has no hour and must not invent one");

// ---------------------------------------------------------------------------
// AFTER/BEFORE BOUNDS (production incident: Kody +17163975098, 2026-07-16).
// "I don't think I'll be out until after 3 tomorrow" was auto-booked AT 3:00 PM —
// the excluded bound. "around N" is an approximate POINT (bookable at N, above);
// "after N"/"before N" are OPEN-ENDED BOUNDS: the hour anchors the WINDOW for
// slot offers, but must never be treated as a bookable clock time.
// ---------------------------------------------------------------------------
const { isOpenEndedTimeBoundParse } = await import(
  "../services/api/src/domain/routeStateReducer.ts"
);
const { resolveRequestedScheduleWindowMode } = await import(
  "../services/api/src/domain/workflowRegressionGuards.ts"
);

// The parse still resolves the bound hour — it anchors the slot WINDOW ("after 3" =>
// search past 15:00). Booking is vetoed upstream (decideSchedulingTurn offer_slots_in_bound
// + the schedulingRangeBoundVeto gates), not by dropping the parse.
const afterBound = parseRequestedDayTime("tomorrow after 3", TZ);
assert.ok(afterBound, "'tomorrow after 3' must still resolve a window anchor");
assert.equal(afterBound!.hour24, 15, "'after 3' anchors 3pm by the 1-7 heuristic");

// The window mode reads the bound direction for the slot search.
assert.equal(resolveRequestedScheduleWindowMode("tomorrow after 3"), "after", "'after 3' => after-mode window");
assert.equal(resolveRequestedScheduleWindowMode("saturday before noon"), "before", "'before noon' => before-mode window");

// The veto classifier: bounds veto booking; approximate points do NOT (this file's cases).
assert.equal(isOpenEndedTimeBoundParse({ timeWindow: "range", timeText: "after 3" }), true, "'after 3' is an open-ended bound (veto)");
assert.equal(isOpenEndedTimeBoundParse({ timeWindow: "range", timeText: "before 1" }), true, "'before 1' is an open-ended bound (veto)");
assert.equal(isOpenEndedTimeBoundParse({ timeWindow: "range", timeText: "around 10" }), false, "'around 10' stays a bookable approximate point (Chuck Bailey)");
assert.equal(isOpenEndedTimeBoundParse({ timeWindow: "exact", timeText: "around 10am" }), false, "an exact-window approximate stays bookable");

// --- A stated WINDOW resolves to its START (Joe ruling 2026-07-28) ------------------------
// Terry Majchrzak +17166091289, 2026-07-27: "I could be there today between 4 and 5". Two
// defects met here. `and` was missing from the window separators, so that shape only resolved
// by accident through the bare-number fallback; and because the meridiem binds to the range
// END, "between 4 and 5pm" matched "5pm" in parseExactTime and came back 17:00 while the
// identical un-suffixed sentence came back 16:00. He means 4 o'clock in both.
const terryWindow = parseRequestedDayTime("I could be there today between 4 and 5", TZ);
assert.ok(terryWindow, "Terry's window must parse");
assert.equal(terryWindow!.hour24, 16, "'between 4 and 5' is 4:00 — the START of the window");
assert.equal(terryWindow!.minute, 0);

const terryWindowPm = parseRequestedDayTime("I could be there today between 4 and 5pm", TZ);
assert.ok(terryWindowPm, "the pm-suffixed window must parse");
assert.equal(
  terryWindowPm!.hour24,
  16,
  "'between 4 and 5pm' is ALSO 4:00 — the trailing meridiem qualifies the window, it does not move the start to 5"
);

// Every window separator lands on the same start.
for (const [text, expected] of [
  ["today between 4-5", 16],
  ["today between 4-5pm", 16],
  ["today between 4 to 5", 16],
  ["monday between 10 and 11am", 10]
] as Array<[string, number]>) {
  const parsed = parseRequestedDayTime(text, TZ);
  assert.ok(parsed, `${text} must parse`);
  assert.equal(parsed!.hour24, expected, `${text} => window start ${expected}`);
}

// A start with MINUTES keeps them — the window start is a real clock time, not a bare hour.
const halfPast = parseRequestedDayTime("tuesday between 4:30 and 5", TZ);
assert.ok(halfPast, "'4:30 and 5' must parse");
assert.equal(halfPast!.hour24, 16, "start hour 4pm");
assert.equal(halfPast!.minute, 30, "…and the :30 survives the window read");

// Regression guard: a single stated time is untouched by the window path.
const plainFour = parseRequestedDayTime("I'll be there today at 4", TZ);
assert.ok(plainFour, "a plain 'at 4' must still parse");
assert.equal(plainFour!.hour24, 16, "a single time is unchanged");

// SOURCE GUARDS: the deterministic concrete-time signals must NOT read "after"/"before"
// as clock times (that regex overriding the parser's range read was the root cause).
const apiSrc = await fs.readFile(path.resolve("services/api/src/index.ts"), "utf8");
const legacySrc = await fs.readFile(
  path.resolve("services/api/src/domain/legacyRegexFallback.ts"),
  "utf8"
);
assert.ok(
  !/llmHasAtHour = bookingParseText\s*\n?\s*\?\s*\/\\b\(\?\:at\|for\|around\|by\|after\|before/.test(apiSrc) &&
    /const llmHasAtHour = bookingParseText\s*\n\s*\? \/\\b\(\?:at\|for\|around\|by\)/.test(apiSrc),
  "llmHasAtHour must not count after|before as a concrete at-hour"
);
assert.ok(
  /const hasAtHour = \/\\b\(\?:at\|for\|around\|by\|close\\s\+to\|near\)/.test(legacySrc),
  "detectSchedulingSignals hasAtHour must not count after|before as a concrete at-hour"
);
// The window slot search honors an "after X" bound STRICTLY (3:00 itself is excluded —
// staff corrected Kody's 3:00 booking to 4:00).
assert.match(
  apiSrc,
  /if \(isAfter\) return c\.start\.getTime\(\) > requestedStartUtc\.getTime\(\);/,
  "findScheduleSlotsForRequestedWindow offers only slots strictly after an 'after X' bound"
);

console.log("PASS approximate time booking eval (approximate points + stated windows resolve to their start)");
