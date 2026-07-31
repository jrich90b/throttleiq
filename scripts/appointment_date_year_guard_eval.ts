/**
 * Appointment date year guard eval (2026-07-31).
 *
 * A CLOCK HOUR IS NOT A YEAR. `parseExplicitDate`'s month-name branches ended in an optional
 * `(\d{2,4})` year group, so the time in "July 20 10:00 am" was captured as the year "10" and
 * normalized to 2000+10 → the appointment landed in **2010**. Measured on the live store: 15 tasks
 * with a due year of 2010/2011/2012 — exactly the dealership's 10/11/12 o'clock morning slots —
 * the most recent created 2026-07-19. Each was born ~15 years overdue, which is noise that trains
 * staff to ignore an overdue badge.
 *
 * It survived because `parseRequestedDateOnly` mirrored the SAME flawed pattern when deciding
 * whether a year was "explicitly provided", so its roll-forward correctly declined to fix a year it
 * believed the customer had supplied. Two places encoding one rule, drifting apart — the same class
 * as the readiness scan that gate and scorecard had to share.
 *
 * Pins, in fail-direction order:
 *   1. a time following a date is never a year (the bug), across both month-name orders;
 *   2. a real 4-digit year still works, and the slash form keeps 2-digit years;
 *   3. the two regexes agree — no month-name form is treated as year-bearing by one and not the
 *      other, checked against the SOURCE so a future edit to one must touch the other;
 *   4. the past-due backstop refuses an absurd due date but leaves same-day requests alone.
 *
 * Run: npx tsx scripts/appointment_date_year_guard_eval.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  parseRequestedDayTime,
  parseRequestedDateOnly,
  isImplausibleAppointmentDueAt,
  APPOINTMENT_DUE_PAST_TOLERANCE_MS
} from "../services/api/src/domain/conversationStore.ts";

const TZ = "America/New_York";
const thisYear = new Date().getFullYear();
let n = 0;

// --- 1. THE BUG: the clock hour must never become the year. -------------------------------------
// Every one of these is a real shape from the live store's wrong-year tasks.
const clockNotYear: Array<[string, string]> = [
  ["July 20 10:00 am", "10:00 became year 2010"],
  ["can we do July 6 11:00 am", "11:00 became year 2011"],
  ["May 9, 12:00 PM", "12:00 became year 2012"],
  ["June 27 11:00", "bare time with no meridiem"],
  ["apr 28 11:00 am", "abbreviated month"],
  ["20 July 10:00 am", "day-first order is vulnerable to the same capture"],
  ["9 May, 12:00 PM", "day-first with a comma"]
];
for (const [text, why] of clockNotYear) {
  const parsed = parseRequestedDayTime(text, TZ);
  assert.ok(parsed, `should still parse a date+time: ${text}`);
  assert.ok(
    parsed!.year >= thisYear,
    `${why}: "${text}" resolved to year ${parsed!.year}, must be >= ${thisYear}`
  );
  n += 2;
}

// The date itself must survive the fix — we drop the bogus year, never the appointment.
{
  const july = parseRequestedDayTime("July 20 10:00 am", TZ);
  assert.equal(july!.month, 7, "month is still read");
  assert.equal(july!.day, 20, "day is still read");
  assert.equal(july!.hour24, 10, "10:00 am is still 10am, not a year");
  n += 3;
}

// --- 1b. THE PRODUCTION TURNS. ------------------------------------------------------------------
// The input was OUR OWN reminder copy. When a customer replies NO/reschedule, the handler re-parses
// the thread text, and "Jul 20, 10:00 AM" fed its own 10 back as the year. Every string below is
// verbatim from the live store's wrong-year tasks, with the year each one actually produced.
const productionTurns: Array<[string, number, number, number]> = [
  ["Reminder: you’re scheduled for Mon, Jul 20, 10:00 AM. Please reply YES to confirm or NO to reschedule.", 7, 20, 10],
  ["Reminder: you’re scheduled for Tue, Apr 28, 11:00 AM. Please reply YES to confirm or NO to reschedule.", 4, 28, 11],
  ["Reminder: you’re scheduled for Tue, May 12, 12:00 PM. Please reply YES to confirm or NO to reschedule.", 5, 12, 12],
  ["Reminder: you’re scheduled for Sat, Jun 27, 11:00 AM. Please reply YES to confirm or NO to reschedule. Reply STOP to opt out.", 6, 27, 11],
  ["Sounds good! I will mark you down for May 9th at 12:00pm to test ride the 2025 Breakout in Brilliant Red!", 5, 9, 12]
];
for (const [text, month, day, hour] of productionTurns) {
  const p = parseRequestedDayTime(text, TZ);
  assert.ok(p, `production turn must still parse: ${text.slice(0, 40)}`);
  assert.ok(p!.year >= thisYear, `production turn resolved to ${p!.year}: ${text.slice(0, 46)}`);
  assert.equal(p!.month, month, `month for: ${text.slice(0, 40)}`);
  assert.equal(p!.day, day, `day for: ${text.slice(0, 40)}`);
  assert.equal(p!.hour24, hour, `the clock hour is a TIME, not a year: ${text.slice(0, 40)}`);
  n += 5;
}

// --- 2. A REAL year still works, and the slash form keeps 2-digit years. ------------------------
{
  const explicit = parseRequestedDateOnly("July 20 2027", TZ);
  assert.equal(explicit?.year, 2027, "a 4-digit year is honoured");
  const slash = parseRequestedDateOnly("7/20/27", TZ);
  assert.equal(slash?.year, 2027, "the slash form still accepts a 2-digit year (separators disambiguate)");
  const dayFirstYear = parseRequestedDateOnly("20 July 2027", TZ);
  assert.equal(dayFirstYear?.year, 2027, "day-first 4-digit year is honoured");
  n += 3;
}

// A bare date with no year keeps the existing roll-forward behaviour (never a PAST year).
{
  const bare = parseRequestedDateOnly("July 20", TZ);
  assert.ok(bare, "a bare date still parses");
  assert.ok(bare!.year >= thisYear, `a yearless date never resolves into the past (got ${bare!.year})`);
  n += 2;
}

// --- 3. The two encodings of "a year was provided" must not drift apart. ------------------------
{
  const src = fs.readFileSync("services/api/src/domain/conversationStore.ts", "utf8");
  // No month-name form may still carry a 2-4 digit year group in either place.
  const monthNames = "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";
  const loose = src.split("\n").filter(l => l.includes(monthNames) && /\\d\{2,4\}/.test(l));
  assert.equal(
    loose.length,
    0,
    `a month-name date pattern still accepts a 2-digit year (a clock hour) on ${loose.length} line(s) — parse and year-provided must both require \\d{4}`
  );
  // Both the parser and the year-provided check must require 4 digits.
  assert.ok(
    src.includes("(?:,?\\s*(\\d{4}))?"),
    "parseExplicitDate's month-name branches require a 4-digit year"
  );
  assert.ok(
    src.includes("(?:,?\\s*)\\d{4}\\b"),
    "parseRequestedDateOnly's explicitYearProvided requires a 4-digit year"
  );
  // The slash form must NOT have been tightened — it legitimately takes 2 digits.
  assert.match(src, /\\d\{1,2\}\[\\\/\\-\]\\d\{1,2\}\[\\\/\\-\]\\d\{2,4\}/, "the slash form keeps 2-digit years");
  n += 4;
}

// --- 4. The past-due backstop. ------------------------------------------------------------------
{
  const now = Date.UTC(2026, 6, 31, 12, 0);
  const day = 24 * 60 * 60 * 1000;
  assert.equal(APPOINTMENT_DUE_PAST_TOLERANCE_MS, day, "tolerance is one day");

  // The bug's signature: a date years in the past is refused.
  assert.equal(isImplausibleAppointmentDueAt(Date.UTC(2010, 6, 20, 14, 0), now), true,
    "a 2010 due date is refused");
  // A same-day request that already passed is NOT refused — that is a real request and this guard
  // must not change how it is handled.
  assert.equal(isImplausibleAppointmentDueAt(now - 4 * 60 * 60 * 1000, now), false,
    "earlier today stays a valid same-day request");
  assert.equal(isImplausibleAppointmentDueAt(now - day + 1, now), false, "just inside tolerance is kept");
  assert.equal(isImplausibleAppointmentDueAt(now - day - 1, now), true, "just outside tolerance is refused");
  assert.equal(isImplausibleAppointmentDueAt(now + day, now), false, "a future due date is fine");
  // Fail-direction: unknown never blocks a task's due date.
  assert.equal(isImplausibleAppointmentDueAt(NaN, now), false, "an unparseable due date never blocks");
  assert.equal(isImplausibleAppointmentDueAt(now, NaN), false, "an unknown now never blocks");
  n += 8;

  // Both customer-text schedule builders carry the backstop; the hardcoded "tomorrow 9am" one
  // cannot be in the past and deliberately does not.
  const api = fs.readFileSync("services/api/src/index.ts", "utf8");
  assert.equal(
    (api.match(/isImplausibleAppointmentDueAt\(dueAtMs, Date\.now\(\)\)/g) ?? []).length,
    2,
    "both builders that parse customer text refuse an absurd due date"
  );
  n += 1;
}

console.log(`PASS appointment date year guard eval (${n} assertions)`);
