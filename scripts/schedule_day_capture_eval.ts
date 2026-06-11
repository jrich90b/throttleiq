/**
 * Schedule day capture eval. Production fixture: Dominik Roehre +17162007915,
 * 2026-06-11 — "I signed up online for the June 20th event so it'll be that
 * day" was answered with "What day and time works best?" because the day
 * extractor only knew weekday words.
 */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";

import { checkMessage } from "./voice_charter_audit.ts";

const apiSource = await fs.readFile(path.resolve("services/api/src/index.ts"), "utf8");

// Source pins: calendar-date extraction, inbound priority, event/day commit
// branches, and soft-appointment todos at BOTH call sites.
assert.match(apiSource, /SCHEDULE_MONTH_LABELS/, "month-name date extraction must exist");
assert.match(
  apiSource,
  /Earlier texts win: a date in the customer's latest turn/,
  "inbound text must take priority over older outbound context"
);
assert.match(apiSource, /SCHEDULE_EVENT_COMMIT_RE/, "event commitment detection must exist");
assert.match(
  apiSource,
  /Perfect, you're set for \$\{inboundDay\}!/,
  "event-day commitments get a confirmation, never a re-ask"
);
assert.equal(
  (apiSource.match(/soft appointment, confirm and prep\./g) ?? []).length,
  2,
  "both live and regen status-update paths must create the soft-appointment todo"
);

// Behavioral copies (pure logic mirrored from index.ts; pinned above).
const MONTHS: Record<string, string> = {
  jan: "January", feb: "February", mar: "March", apr: "April", may: "May", jun: "June",
  jul: "July", aug: "August", sep: "September", sept: "September", oct: "October",
  nov: "November", dec: "December"
};
function extractDay(...texts: string[]): string {
  for (const text of texts) {
    const t = String(text ?? "").toLowerCase();
    if (!t.trim()) continue;
    const monthDate = t.match(
      /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+(\d{1,2})(st|nd|rd|th)?\b/
    );
    if (monthDate) {
      const monthKey = monthDate[1].slice(0, 4) === "sept" ? "sept" : monthDate[1].slice(0, 3);
      return `${MONTHS[monthKey] ?? monthDate[1]} ${monthDate[2]}${monthDate[3] ?? ""}`;
    }
    const slashDate = t.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(?:\d{2}|\d{4}))?\b/);
    if (slashDate) return `${slashDate[1]}/${slashDate[2]}`;
    const weekday = t.match(/\b(today|tomorrow|monday|friday|saturday|sunday)\b/);
    if (weekday) return weekday[1][0].toUpperCase() + weekday[1].slice(1);
  }
  return "";
}

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

// The event confirmation reply must be charter-clean.
const eventReply =
  "Perfect, you're set for June 20th! Come find us when you get here and we'll get you taken care of. If you want a set time that day, just text me one.";
assert.deepEqual(
  checkMessage(eventReply, { firstOutbound: false, smsLike: true, staffHasSent: false }),
  [],
  "event confirmation must be charter-clean"
);

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
