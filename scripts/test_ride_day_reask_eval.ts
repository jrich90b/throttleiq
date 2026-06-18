/**
 * Day-aware scheduling re-ask eval (deterministic — no LLM, no browser).
 *
 * Pins the "requested_day_reasked" answer-correctness fix: when a customer names a day in an
 * active-scheduling turn, the agent acknowledges that day and asks the time-of-day instead of
 * re-asking "what day?". Origin: the answer_correctness audit flagged the agent re-asking a day
 * the appointment-timing parser had already captured — the reply paths gated on the legacy
 * detectSchedulingSignals (blind to a bare day with no time) instead of the parser.
 *
 * Coverage: (a) the test-ride-init reply (buildTestRideInitReply) used by the live, regenerate,
 * AND test-ride-inventory-selection sites; (b) the general "what day and time works…" re-ask
 * (makeSchedulingReaskDayAware) used by the deterministic availability answer (both paths). Plus a
 * fail-direction SCOPE guard: decline/conflict re-asks stay day-blind (the named day there is the
 * one that does NOT work). All assertions exercise the pure reply builders + a source guard that
 * both paths route through the helpers.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  buildTestRideInitReply,
  makeSchedulingReaskDayAware,
  resolveNamedSchedulingDay
} from "../services/api/src/domain/testRideDayAwareReply.ts";

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

// 4) General scheduling re-ask (makeSchedulingReaskDayAware) — replay fixtures: a named day is
//    acknowledged and only the TIME is asked; no day → the base reply is unchanged (additive).
const REASK_FIXTURES: { name: string; inbound: string; base: string; expect: RegExp }[] = [
  {
    name: "availability answer + 'tomorrow'",
    inbound: "is the road glide available? I'm off tomorrow",
    base: "Yes — 2026 Road Glide — https://x is available right now. Let me know what day and time works for you to stop in.",
    expect: /let me know what time tomorrow works for you to stop in/i
  },
  {
    name: "availability answer + weekday",
    inbound: "is it available, I could come Friday",
    base: "Yes — Street Glide is available right now. Let me know what day and time works for you to stop in.",
    expect: /what time Friday works for you to stop in/
  }
];
for (const fx of REASK_FIXTURES) {
  const reply = makeSchedulingReaskDayAware(fx.base, resolveNamedSchedulingDay(null, fx.inbound));
  assert.ok(fx.expect.test(reply), `${fx.name}: should ack the day + ask the time — got: ${reply}`);
  assert.ok(!/what day and time works/i.test(reply), `${fx.name}: must NOT re-ask the day`);
}
// No day named → base reply unchanged (purely additive).
const availNoDayBase = "Yes — Road Glide is available right now. Let me know what day and time works for you to stop in.";
assert.equal(
  makeSchedulingReaskDayAware(availNoDayBase, resolveNamedSchedulingDay(null, "is the road glide available?")),
  availNoDayBase,
  "no day named → base reply unchanged"
);

// 5) Source guard: all three test-ride-init sites (live + regen + inventory-selection) route
//    through buildTestRideInitReply, and the availability answer routes through the general helper.
const index = fs.readFileSync("services/api/src/index.ts", "utf8");
const initCalls = (index.match(/buildTestRideInitReply\(/g) || []).length;
assert.ok(
  initCalls >= 3,
  `test-ride-init sites (live + regen + inventory-selection) must use the helper; found ${initCalls}`
);
assert.ok(
  /makeSchedulingReaskDayAware\(/.test(index),
  "the availability answer must route through makeSchedulingReaskDayAware"
);

// 6) Fail-direction SCOPE guard: decline/conflict re-asks stay day-BLIND. There the named day is
//    the one that does NOT work ("I can't make it tomorrow"; rejecting offered slots), so it must
//    NOT be acknowledged — these literals stay verbatim, never rewritten to acknowledge a day.
assert.ok(
  /No problem — what day and time works better for you\?/.test(index),
  "schedule-conflict re-ask must stay day-blind (negated day)"
);
assert.ok(
  /If those times don't work, what day and time works for you\?/.test(index),
  "slot-offer-rejection re-ask must stay day-blind (negated/ambiguous day)"
);

console.log("PASS day-aware scheduling re-ask eval");
