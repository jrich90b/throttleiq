/**
 * Schedule-status-update reply builder (visit_commitment arm), lifted out of index.ts.
 *
 * Pure + dependency-free so the eval can exercise the REAL builder instead of a
 * hand-copy of it. schedule_day_capture:eval used to mirror this logic by hand and the
 * copy had already drifted (its weekday list carried 6 of the 20 words production
 * matches) — the same copy-drift class PR #432 fixed for the cadence-repeat eval.
 *
 * THE DAY IS A PARSED SLOT (Scott Hartrich +17167130279, Ref 11718, 2026-08-01).
 * "Thank you for you help today Stone. ... I will be in next week to sit down with you
 * and go over numbers" was answered "Perfect, you're set for today!" — the word "today"
 * was lifted out of the GRATITUDE clause while the appointment-timing parser had already
 * read requested.day = "next week" correctly. The parser was right and its answer was
 * thrown away, so the reply asserted a visit day the customer never named and never
 * offered a time for the day he did. Per AGENTS.md's fail-direction test this is a
 * MIGRATE, not a KEEP: pointing the extractor at the parsed day instead of raw prose
 * fails toward "what day and time works best?" — an ask, never a wrong assertion.
 */

export const SCHEDULE_MONTH_LABELS: Record<string, string> = {
  jan: "January", feb: "February", mar: "March", apr: "April", may: "May", jun: "June",
  jul: "July", aug: "August", sep: "September", sept: "September", oct: "October",
  nov: "November", dec: "December"
};

export function extractScheduleDayLabelFromContext(...texts: string[]): string {
  // Earlier texts win: a date in the customer's latest turn must beat a
  // weekday mentioned in our older outbound (Dominik 2026-06-11: "the June
  // 20th event so it'll be that day" lost to a generic day re-ask).
  for (const text of texts) {
    const t = String(text ?? "").toLowerCase();
    if (!t.trim()) continue;
    const monthDate = t.match(
      /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+(\d{1,2})(st|nd|rd|th)?\b/
    );
    if (monthDate) {
      const monthKey = monthDate[1].slice(0, 4) === "sept" ? "sept" : monthDate[1].slice(0, 3);
      const month = SCHEDULE_MONTH_LABELS[monthKey] ?? monthDate[1];
      return `${month} ${monthDate[2]}${monthDate[3] ?? ""}`;
    }
    const slashDate = t.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(?:\d{2}|\d{4}))?\b/);
    if (slashDate) return `${slashDate[1]}/${slashDate[2]}`;
    const weekday = t.match(
      /\b(today|tomorrow|monday|mon|tuesday|tue|tues|wednesday|wed|thursday|thu|thur|thurs|friday|fri|saturday|sat|sunday|sun)\b/
    );
    if (weekday) {
      const label = scheduleWeekdayLabel(weekday[1]);
      if (label) return label;
    }
  }
  return "";
}

export function scheduleWeekdayLabel(raw: string): string {
  const labels: Record<string, string> = {
    today: "today",
    tomorrow: "tomorrow",
    monday: "Monday",
    mon: "Monday",
    tuesday: "Tuesday",
    tue: "Tuesday",
    tues: "Tuesday",
    wednesday: "Wednesday",
    wed: "Wednesday",
    thursday: "Thursday",
    thu: "Thursday",
    thur: "Thursday",
    thurs: "Thursday",
    friday: "Friday",
    fri: "Friday",
    saturday: "Saturday",
    sat: "Saturday",
    sunday: "Sunday",
    sun: "Sunday"
  };
  return labels[raw] ?? "";
}

export const SCHEDULE_EVENT_COMMIT_RE = /\b(event|demo days?|open house|bike night|signed up)\b/i;
export const SCHEDULE_DAY_COMMIT_RE =
  /\b(it'?ll be|that day|that date|i'?ll (?:be|come|stop|swing)|works for me|that works|see you)\b/i;

export function buildScheduleContextStatusUpdateReply(
  inboundText: string,
  lastOutboundText: string,
  options: { parserVisitCommitment?: boolean; parserDay?: string | null } = {}
): { reply: string; dayLabel: string; dayCommitted: boolean; eventCommitted: boolean } {
  // PARSER-FIRST DAY AUTHORITY (Scott Hartrich 2026-08-01, see the docblock): when the
  // appointment-timing parser read a day for this turn, THAT string is the only day we
  // may assert — run it through the same label formatter (structured extraction over a
  // parsed slot, which AGENTS.md allows) instead of re-reading the customer's raw prose,
  // where an incidental "today"/"Saturday" in a thank-you or an aside becomes a visit
  // day. A vague timeframe the formatter can't resolve ("next week") yields "" and so
  // commits nothing — the turn falls to the time ask below.
  // FAIL-SAFE: a parser that returned NO day at all leaves the lexical read untouched,
  // so turns where inbound_reply_action fired without a timing parse are unchanged.
  const parserDay = String(options.parserDay ?? "").trim();
  const inboundDay = extractScheduleDayLabelFromContext(parserDay || inboundText);
  const dayLabel = inboundDay || extractScheduleDayLabelFromContext(lastOutboundText);
  const eventCommitted = !!inboundDay && SCHEDULE_EVENT_COMMIT_RE.test(inboundText);
  // Parser-first commitment (AGENTS.md "comprehend, never regex"): when the
  // inbound_reply_action parser recognized this turn as a visit/schedule-status
  // commitment and the customer named a day, the day is committed — regardless of
  // the event's name and without keyword-matching the commitment phrasing. This
  // replaces SCHEDULE_DAY_COMMIT_RE as the comprehension driver; the regex stays
  // only as a fallback for non-parser callers (e.g. the future-timeframe path).
  const parserCommitment = !!options.parserVisitCommitment && !!inboundDay;
  const dayCommitted =
    eventCommitted || parserCommitment || (!!inboundDay && SCHEDULE_DAY_COMMIT_RE.test(inboundText));
  if (eventCommitted || parserCommitment) {
    return {
      reply: `Perfect, you're set for ${inboundDay}! Come find us when you get here and we'll get you taken care of. If you want a set time that day, just text me one.`,
      dayLabel: inboundDay,
      dayCommitted,
      eventCommitted
    };
  }
  if (dayCommitted) {
    return {
      reply: `Perfect, ${inboundDay} it is. What time works best?`,
      dayLabel: inboundDay,
      dayCommitted,
      eventCommitted
    };
  }
  const timeQuestion = dayLabel ? `what time ${dayLabel} works best?` : "what day and time works best?";
  const prefix = /\b(?:sorry|my bad)\b/i.test(inboundText) ? "No worries" : "Sounds good";
  return { reply: `${prefix}, ${timeQuestion}`, dayLabel, dayCommitted, eventCommitted };
}
