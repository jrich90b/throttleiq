/**
 * Test-ride day re-ask eval (deterministic — no LLM, no browser).
 *
 * Pins the "requested_day_reasked" answer-correctness fix: when a customer names a day while
 * selecting a bike for a test ride, the agent acknowledges that day and asks the time-of-day
 * instead of re-asking "what day?". Origin: the answer_correctness audit flagged the agent
 * re-asking a day the appointment-timing parser had already captured — the reply path gated on
 * the legacy detectSchedulingSignals (blind to a bare day with no time) instead of the parser.
 * This pins the day-aware reply + that BOTH paths (live + regenerate) use it.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { buildTestRideInitReply, resolveNamedSchedulingDay } from "../services/api/src/domain/testRideDayAwareReply.ts";

// 1) Day resolution — parser day preferred, deterministic text fallback, relative-day scope only.
assert.equal(resolveNamedSchedulingDay("tomorrow", ""), "tomorrow", "parser day (tomorrow) is used");
assert.equal(resolveNamedSchedulingDay("today", ""), "today", "parser day (today) is used");
assert.equal(resolveNamedSchedulingDay("monday", ""), "monday", "parser day (weekday) is used");
assert.equal(resolveNamedSchedulingDay(null, "Am I able to ride a road glide today?"), "today", "extracts today from text");
assert.equal(resolveNamedSchedulingDay(null, "I am off tomorrow"), "tomorrow", "extracts tomorrow from text");
assert.equal(resolveNamedSchedulingDay(null, "I'll come by Friday"), "friday", "extracts a weekday from text");

// Out of scope (deferred soft/event scope) → null, so the caller keeps the original prompt.
assert.equal(
  resolveNamedSchedulingDay("june 20th", "I signed up for the June 20th event"),
  null,
  "a month-date is out of scope (returns null)"
);
assert.equal(
  resolveNamedSchedulingDay(null, "I want to test ride the Road Glide"),
  null,
  "no day named → null"
);

// 2) The reply: with a day → acknowledge it, ask time-of-day, do NOT re-ask the day.
const withDay = buildTestRideInitReply("2026 Road Glide", "tomorrow");
assert.ok(/tomorrow/i.test(withDay), "acknowledges the named day");
assert.ok(!/what day/i.test(withDay), "does NOT re-ask the day");
assert.ok(/morning or afternoon/i.test(withDay), "asks the time-of-day instead");

const weekday = buildTestRideInitReply("Street Glide", "monday");
assert.ok(/Monday/.test(weekday) && !/what day/i.test(weekday), "weekday acknowledged (capitalized), not re-asked");

// Without a day → the original prompt (correct when no day was given; change is purely additive).
const noDay = buildTestRideInitReply("2026 Road Glide", null);
assert.ok(/what day and time works best/i.test(noDay), "no day given → original prompt");

// 3) Source guard: BOTH test-ride-init sites (live + regenerate) route through the helper.
const index = fs.readFileSync("services/api/src/index.ts", "utf8");
const calls = (index.match(/buildTestRideInitReply\(/g) || []).length;
assert.ok(calls >= 2, `both paths must use buildTestRideInitReply (live + regen); found ${calls}`);

console.log("PASS test ride day re-ask eval");
