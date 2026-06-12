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

console.log("PASS approximate time booking eval");
