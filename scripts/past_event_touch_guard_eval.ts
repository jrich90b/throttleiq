/**
 * Past-dated-event guard eval (pure, no LLM) — Joe ruling 2026-07-22.
 *
 * "No follow-up may reference a dated event whose date has already passed." Production miss:
 * the 7/21 human-thread quiet nudge bumped Don Soto (+17167134185) with "circling back on the
 * Taste of Country pre-party invite… still planning to come by Saturday?" — the blast it was
 * continuing had invited him to "our Taste of Country Pre-Party on Saturday June 20th from
 * 12pm-5pm". Draft mode caught it.
 *
 * Pins:
 *   1) the pure detector (domain/pastEventGuard.ts) — past dates flag, future dates never do,
 *      dealer-clock boundaries hold, and number-shaped noise (phones, prices, times) doesn't
 *      get read as a date
 *   2) the exact Don Soto anchor + bump pair
 *   3) the wiring: the guard is applied in the human-thread nudge lane, the live cadence tick,
 *      and the regenerate cadence mirror (route parity)
 *
 * Run: npx tsx scripts/past_event_touch_guard_eval.ts
 */
import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import {
  calendarDayInTimeZone,
  findReferencedCalendarDays,
  referencesPastDatedEvent
} from "../services/api/src/domain/pastEventGuard.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

let n = 0;
const eq = (a: unknown, b: unknown, m: string) => {
  assert.deepEqual(a, b, m);
  n++;
};
const ok = (v: unknown, m: string) => {
  assert.ok(v, m);
  n++;
};

// Fixed "now": Thursday 2026-07-23, 14:00 ET (18:00 UTC).
const NOW = Date.parse("2026-07-23T18:00:00.000Z");

// --- 1) Dealer-clock "today". ---
{
  const today = calendarDayInTimeZone(NOW, "America/New_York");
  eq(today, { year: 2026, month: 7, day: 23 }, "dealer today is 2026-07-23 in ET");
  // 00:30 UTC on 7/24 is still 7/23 in ET — the guard must use the dealer's calendar, not UTC.
  const lateNight = calendarDayInTimeZone(Date.parse("2026-07-24T00:30:00.000Z"), "America/New_York");
  eq(lateNight, { year: 2026, month: 7, day: 23 }, "late-UTC still reads as the dealer's 7/23");
}

// --- 2) Date extraction. ---
{
  const today = { year: 2026, month: 7, day: 23 };
  eq(
    findReferencedCalendarDays("our Taste of Country Pre-Party on Saturday June 20th from 12pm-5pm", today),
    [{ year: 2026, month: 6, day: 20 }],
    "month-name + ordinal day extracts, year defaults to the current year"
  );
  eq(
    findReferencedCalendarDays("bike night Aug 14, 2026", today),
    [{ year: 2026, month: 8, day: 14 }],
    "explicit year is honored"
  );
  eq(
    findReferencedCalendarDays("the 20th of June", today),
    [{ year: 2026, month: 6, day: 20 }],
    "day-first phrasing extracts"
  );
  eq(
    findReferencedCalendarDays("open house 8/15", today),
    [{ year: 2026, month: 8, day: 15 }],
    "numeric M/D extracts"
  );
  eq(findReferencedCalendarDays("Feb 30th", today), [], "an impossible day is not a date");
  eq(findReferencedCalendarDays("13/40", today), [], "an impossible month/day is not a date");
  eq(
    findReferencedCalendarDays("call me at +17167134185 about the $21,999 Street Glide", today),
    [],
    "phone numbers and prices are not dates"
  );
  eq(
    findReferencedCalendarDays("we're here 12pm-5pm and the 2026 Heritage Classic just landed", today),
    [],
    "times and model years are not dates"
  );
}

// --- 3) The verdict: past flags, future never does. ---
{
  const opts = { nowMs: NOW, timeZone: "America/New_York" };
  ok(referencesPastDatedEvent(["Join us June 20th!"], opts), "a passed date flags");
  ok(referencesPastDatedEvent(["Ride out 7/22"], opts), "yesterday flags");
  eq(referencesPastDatedEvent(["See you 7/23"], opts), false, "TODAY is not past — today's event still stands");
  eq(referencesPastDatedEvent(["See you July 25th"], opts), false, "a future date does not flag");
  eq(referencesPastDatedEvent(["Demo days Aug 14, 2026"], opts), false, "a future dated event does not flag");
  ok(referencesPastDatedEvent(["Bike night March 3, 2025"], opts), "a past explicit year flags");
  eq(referencesPastDatedEvent(["Bike night March 3, 2027"], opts), false, "a future explicit year does not flag");
  eq(
    referencesPastDatedEvent(["Just checking in on the Heritage Classic — still interested?"], opts),
    false,
    "an ordinary dateless bump is untouched (no over-suppression)"
  );
  eq(referencesPastDatedEvent([], opts), false, "no texts => nothing to suppress");
  eq(referencesPastDatedEvent([null, undefined, ""], opts), false, "empty texts => nothing to suppress");
}

// --- 4) The Don Soto case, end to end. ---
{
  const opts = { nowMs: NOW, timeZone: "America/New_York" };
  const anchor =
    "Hi Don- This is Scott from American H-D. I wanted to invite you to our Taste of Country Pre-Party on Saturday June 20th from 12pm-5pm.";
  const bump =
    "Don — circling back on the Taste of Country pre-party invite and the Heritage Classic demo, still planning to come by Saturday?";
  eq(
    referencesPastDatedEvent([bump], opts),
    false,
    "the bump alone carries NO date — checking the composed text alone would have missed it"
  );
  ok(
    referencesPastDatedEvent([bump, anchor], opts),
    "bump + anchor together flag: this is why the nudge lane checks both"
  );
}

// --- 5) Wiring (route parity). ---
{
  const indexSrc = fs.readFileSync(path.join(repoRoot, "services/api/src/index.ts"), "utf8");
  ok(
    /import \{ referencesPastDatedEvent \} from "\.\/domain\/pastEventGuard\.js";/.test(indexSrc),
    "index.ts imports the shared guard (no local re-implementation)"
  );
  ok(
    indexSrc.includes("human_thread_nudge_past_event_suppressed"),
    "the human-thread nudge lane suppresses on a past-dated anchor"
  );
  ok(
    indexSrc.includes("[followup][past-event-guard]"),
    "the live cadence tick applies the guard before sending a proactive touch"
  );
  ok(
    /cadenceRegeneratedDraftRaw[\s\S]{0,400}referencesPastDatedEvent/.test(indexSrc),
    "the regenerate cadence mirror applies the SAME guard (route parity)"
  );
  const guardCount = (indexSrc.match(/referencesPastDatedEvent\(/g) ?? []).length;
  ok(guardCount >= 3, `all three proactive lanes are guarded (found ${guardCount})`);
}

console.log(`PASS past-dated-event touch guard eval (${n} assertions)`);
