/**
 * Schedule day capture eval. Production fixture: Dominik Roehre +17162007915,
 * 2026-06-11 — "I signed up online for the June 20th event so it'll be that
 * day" was answered with "What day and time works best?" because the day
 * extractor only knew weekday words.
 */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";

import {
  SCHEDULE_EVENT_COMMIT_RE,
  SCHEDULE_MONTH_LABELS,
  buildScheduleContextStatusUpdateReply,
  extractScheduleDayLabelFromContext
} from "../services/api/src/domain/scheduleStatusReply.ts";
import { checkMessage } from "./voice_charter_audit.ts";

const apiSource = await fs.readFile(path.resolve("services/api/src/index.ts"), "utf8");

// The builder + day extractor now live in a pure domain module, so these are BEHAVIOUR
// assertions against production code rather than source pins over a hand-copy (the copy
// had drifted: its weekday list carried 6 of the 20 words production matches).
assert.equal(SCHEDULE_MONTH_LABELS.jun, "June", "month-name date extraction must exist");
assert.ok(SCHEDULE_EVENT_COMMIT_RE.test("I signed up for the open house"), "event commitment detection must exist");
assert.match(
  buildScheduleContextStatusUpdateReply("I signed up for the June 20th event", "").reply,
  /Perfect, you're set for June 20th!/,
  "event-day commitments get a confirmation, never a re-ask"
);
// The soft-appointment todo is consolidated into ONE shared helper (addSoftVisitStaffTask,
// Joe ruling 2026-07-19: the task is also DATED — due the visit day) called from every arm:
// status-update live+regen, future-timeframe live+regen, and the pure-soft-visit live+regen
// branches. One literal in the helper + >=6 call sites replaces the old 4 inline copies.
assert.equal(
  (apiSource.match(/soft appointment, confirm and prep\./g) ?? []).length,
  1,
  "the soft-appointment todo template must live ONLY in the shared addSoftVisitStaffTask helper"
);
assert.ok(
  (apiSource.match(/addSoftVisitStaffTask\(conv,/g) ?? []).length >= 6,
  "status-update, future-timeframe, and pure-soft-visit paths (live + regen) must all create the soft-appointment todo via the shared helper"
);

// Day commitments that arrive via the future-timeframe route get the same
// soft-appointment treatment, not a robotic cadence-pause ack (Nicholas Maly
// 2026-06-11: "I signed up on the Harley website for the June 20th thing"
// drew "I'll pause follow-up until june 20").
assert.equal(
  (apiSource.match(/future_timeframe_day_commit_ack/g) ?? []).length,
  2,
  "future-timeframe day-commit branch must exist in live and regen paths"
);
const NICHOLAS_TEXT = "I signed up on the Harley website for the June 20th thing";
assert.match(NICHOLAS_TEXT, /\b(event|demo days?|open house|bike night|signed up)\b/i, "event commit cue");

// The production extractor itself — no copy to drift.
const extractDay = extractScheduleDayLabelFromContext;

assert.equal(
  extractDay("I signed up online for the June 20th event so it'll be that day"),
  "June 20th",
  "Dominik's literal turn must extract the date"
);
assert.equal(extractDay("we could do 6/20 if that works"), "6/20");
assert.equal(extractDay("probably saturday"), "Saturday");
assert.equal(
  extractDay("I signed up for the June 20th event", "What day works best Friday?"),
  "June 20th",
  "inbound date beats outbound weekday"
);
assert.equal(extractDay("just checking in"), "");

// THE DAY IS A PARSED SLOT — Scott Hartrich +17167130279, Ref 11718, 2026-08-01.
// "Thank you for you help today Stone. ... I will be in next week to sit down with you and
// go over numbers" was answered "Perfect, you're set for today!": the word "today" was
// lifted out of the GRATITUDE clause while the appointment-timing parser had already read
// requested.day = "next week". The reply asserted a day he never named and never offered a
// time for the one he did. The parsed day is now the only day the assert branches may use.
const SCOTT_INBOUND =
  "Thank you for you help today Stone. I am really loving that street glide solo. I will be in next week to sit down with you and go over numbers";
const SCOTT_LAST_OUTBOUND =
  "Hi Scott — this is Stone at American Harley-Davidson. Thanks again for sitting down with me. I'll follow up with the numbers we discussed and next steps. Just so I've got it right, you're looking for a new Street Glide.";
assert.equal(
  extractDay(SCOTT_INBOUND),
  "today",
  "the raw-prose read is what went wrong: a thank-you supplies a visit day"
);
const scott = buildScheduleContextStatusUpdateReply(SCOTT_INBOUND, SCOTT_LAST_OUTBOUND, {
  parserVisitCommitment: true,
  parserDay: "next week"
});
assert.doesNotMatch(scott.reply, /you're set for/, "a vague parsed timeframe must never be asserted as a visit day");
assert.doesNotMatch(scott.reply, /today/, "the gratitude clause's 'today' must not reach the customer");
assert.equal(scott.dayLabel, "", "no day is committed, so the dated staff task and cadence re-anchor stay off");
assert.equal(scott.dayCommitted, false);
assert.match(scott.reply, /what day and time works best/, "an unresolvable day falls to the time ask");
assert.deepEqual(
  checkMessage(scott.reply, { firstOutbound: false, smsLike: true, staffHasSent: false }),
  [],
  "the ask must be charter-clean"
);

// Non-regression: a parsed day the formatter CAN resolve still confirms (Todd Herian
// +15673079691, "I will be there ... on Saturday"), and a turn whose parser returned NO
// day at all is byte-identical to the pre-fix lexical read (Dominik's event commitment).
const todd = buildScheduleContextStatusUpdateReply(
  "Ok I will be there for the taste of country pre party on Saturday",
  "",
  { parserVisitCommitment: true, parserDay: "saturday" }
);
assert.match(todd.reply, /Perfect, you're set for Saturday!/, "a resolvable parsed day still confirms");
assert.equal(todd.dayCommitted, true);
const dominik = buildScheduleContextStatusUpdateReply(
  "I signed up online for the June 20th event so it'll be that day",
  "",
  { parserVisitCommitment: true, parserDay: "" }
);
assert.match(
  dominik.reply,
  /Perfect, you're set for June 20th!/,
  "no parsed day at all leaves the lexical read untouched (fail-safe)"
);

// The event confirmation reply must be charter-clean.
const eventReply =
  "Perfect, you're set for June 20th! Come find us when you get here and we'll get you taken care of. If you want a set time that day, just text me one.";
assert.deepEqual(
  checkMessage(eventReply, { firstOutbound: false, smsLike: true, staffHasSent: false }),
  [],
  "event confirmation must be charter-clean"
);

// Year-rollover root cause (task #17): parsePauseUntil's month regex had no
// ordinal suffix in the day group, so "June 20th" failed the trailing \b,
// backtracked to a bare "june", defaulted to day 1, and the past-date guard
// parked Dominik's cadence at 2027-06-01T09:00Z via bumpCadenceNextDueAt.
assert.match(
  apiSource,
  /Day group must allow ordinal suffixes/,
  "parsePauseUntil ordinal fix must be documented at the regex"
);
assert.equal(
  (apiSource.match(/never the\s+(?:\/\/ )?same month next year/g) ?? []).length,
  2,
  "bare current-month mentions must stay in the current month in BOTH parsePauseUntil and parseFutureTimeframe"
);

// Behavioral copy of the fixed parsePauseUntil month branch.
const PAUSE_MONTHS: Record<string, number> = {
  jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2, apr: 3, april: 3,
  may: 4, jun: 5, june: 5, jul: 6, july: 6, aug: 7, august: 7, sep: 8, sept: 8, september: 8,
  oct: 9, october: 9, nov: 10, november: 10, dec: 11, december: 11
};
function pauseUntilFromMonth(text: string, base: Date): Date | null {
  const t = text.toLowerCase();
  const monthMatch = t.match(
    /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)(?:\s+(\d{1,2})(?:st|nd|rd|th)?)?\b/
  );
  if (!monthMatch) return null;
  const monthKey = monthMatch[1];
  const mayIsMonth =
    monthKey !== "may" ||
    /\bmay\s+\d{1,2}(?:st|nd|rd|th)?\b/.test(t) ||
    /\b(in|this|next|on|by|during|around|early|late)\s+may\b/.test(t);
  if (!mayIsMonth) return null;
  const m = PAUSE_MONTHS[monthKey];
  const day = monthMatch[2] ? Number(monthMatch[2]) : 1;
  const y = base.getFullYear();
  let d = new Date(y, m, day, 9, 0, 0, 0);
  if (d.getTime() <= base.getTime()) {
    d = !monthMatch[2] && m === base.getMonth()
      ? new Date(y, m + 1, 0, 9, 0, 0, 0)
      : new Date(y + 1, m, day, 9, 0, 0, 0);
  }
  return d;
}
const incidentBase = new Date(2026, 5, 11, 15, 25, 0);
const dominikUntil = pauseUntilFromMonth(
  "I signed up online for the June 20th event so it'll be that day",
  incidentBase
);
assert.equal(dominikUntil?.getFullYear(), 2026, "ordinal date must not roll a year");
assert.equal(dominikUntil?.getMonth(), 5);
assert.equal(dominikUntil?.getDate(), 20, "June 20th must capture day 20, not default to the 1st");
const bareJune = pauseUntilFromMonth("probably june for me", incidentBase);
assert.equal(bareJune?.getFullYear(), 2026, "bare current-month must stay in the current year");
assert.equal(bareJune?.getDate(), 30, "bare current-month resolves to end of month");
assert.equal(
  pauseUntilFromMonth("I may stop by sometime", incidentBase),
  null,
  "modal 'may' is not the month of May"
);
const inMay = pauseUntilFromMonth("probably in may", incidentBase);
assert.equal(inMay?.getFullYear(), 2027, "explicit past month legitimately rolls forward");
const december = pauseUntilFromMonth("not until december", incidentBase);
assert.equal(december?.getFullYear(), 2026, "future month stays in current year");
assert.equal(december?.getMonth(), 11);

// Committed-day cadence re-anchor pins.
assert.match(apiSource, /function reanchorCadenceForCommittedDay/, "cadence re-anchor must exist");
assert.equal(
  (apiSource.match(/reanchorCadenceForCommittedDay\(conv, statusUpdate\.dayLabel\)/g) ?? []).length,
  2,
  "both status-update paths must re-anchor the cadence on committed days"
);
assert.match(
  apiSource,
  /parked his cadence until June 2027/,
  "re-anchor documents the Dominik year-rollover incident"
);

console.log("PASS schedule day capture eval");
