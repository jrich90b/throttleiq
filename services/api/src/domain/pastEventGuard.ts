/**
 * Past-dated-event guard for PROACTIVE touches (Joe ruling 2026-07-22, built 7/23).
 *
 * Joe: "no follow-up may reference a dated event whose date has already passed." Trigger: the
 * 7/21 human-thread quiet nudge bumped Don Soto (+17167134185) with "circling back on the Taste
 * of Country pre-party invite… still planning to come by Saturday?" — the anchor it continued
 * was our own 6/xx blast inviting him to "our Taste of Country Pre-Party on Saturday June 20th
 * from 12pm-5pm". June 20 was five weeks gone. Draft mode caught it; nothing was sent.
 *
 * Root cause: a proactive bump anchors on where the thread left off but had NO staleness check
 * on a dated fact inside that anchor. This module is that check.
 *
 * BUCKET: deterministic STRUCTURED EXTRACTION of a calendar date literal (a date in text is a
 * format, not an intent) feeding a SIDE-EFFECT gate (send / don't send a proactive touch). It
 * deliberately does NOT try to classify "is this an event?" — that would be comprehension, and
 * comprehension belongs in a typed parser, never in a regex. It only answers "does this text
 * name a calendar day that is already behind us?".
 *
 * FAIL DIRECTION: SILENCE. A past date anywhere in the touch or in the anchor it was written
 * from suppresses the touch. Over-suppressing costs a little momentum on a thread that happens
 * to mention an old date; under-suppressing texts a customer an invitation to a party that
 * already happened. The proactive lanes this guards (human-thread nudge, cadence touches) all
 * declare silence as their own fail direction, so this matches them.
 */

export const PAST_EVENT_GUARD_DEFAULT_TIMEZONE = "America/New_York";

export type CalendarDay = { year: number; month: number; day: number };

const MONTHS: Record<string, number> = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12
};

const MONTH_NAME_ALTERNATION = Object.keys(MONTHS).sort((a, b) => b.length - a.length).join("|");

// "June 20", "Jun 20th", "June 20, 2026"
const MONTH_FIRST_RE = new RegExp(
  `\\b(${MONTH_NAME_ALTERNATION})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:\\s*,?\\s*(\\d{4}))?\\b`,
  "gi"
);
// "20th of June", "the 20th of June 2026"
const DAY_FIRST_RE = new RegExp(
  `\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+of\\s+(${MONTH_NAME_ALTERNATION})\\.?(?:\\s*,?\\s*(\\d{4}))?\\b`,
  "gi"
);
// "6/20", "6/20/26", "06/20/2026" — bounded so phone numbers, prices and fractions inside larger
// number runs don't get read as dates.
const NUMERIC_RE = /(?<![\d/$.-])(\d{1,2})\/(\d{1,2})(?:\/(\d{2}|\d{4}))?(?![\d/])/g;

const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function isPlausibleDay(month: number, day: number): boolean {
  if (!Number.isInteger(month) || month < 1 || month > 12) return false;
  if (!Number.isInteger(day) || day < 1) return false;
  return day <= DAYS_IN_MONTH[month - 1];
}

function normalizeYear(raw: string | undefined): number | null {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed) return null;
  const n = Number(trimmed);
  if (!Number.isFinite(n)) return null;
  if (trimmed.length === 4) return n;
  if (trimmed.length === 2) return 2000 + n;
  return null;
}

/** The dealer's CURRENT calendar day — "today" is a local-clock question, never a UTC one. */
export function calendarDayInTimeZone(
  nowMs: number,
  timeZone: string = PAST_EVENT_GUARD_DEFAULT_TIMEZONE
): CalendarDay {
  const at = new Date(Number.isFinite(nowMs) ? nowMs : Date.now());
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).formatToParts(at);
  } catch {
    parts = new Intl.DateTimeFormat("en-US", {
      timeZone: PAST_EVENT_GUARD_DEFAULT_TIMEZONE,
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).formatToParts(at);
  }
  const pick = (type: string) => Number(parts.find(p => p.type === type)?.value ?? NaN);
  const year = pick("year");
  const month = pick("month");
  const day = pick("day");
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
    return { year: at.getUTCFullYear(), month: at.getUTCMonth() + 1, day: at.getUTCDate() };
  }
  return { year, month, day };
}

function compareDays(a: CalendarDay, b: CalendarDay): number {
  if (a.year !== b.year) return a.year - b.year;
  if (a.month !== b.month) return a.month - b.month;
  return a.day - b.day;
}

/**
 * Every calendar day named in `text`, resolved against `today`. A date written without a year
 * resolves to the CURRENT year — which is exactly how a reader takes "Saturday June 20th" in a
 * thread: the June 20th of this year, i.e. the one that already happened.
 */
export function findReferencedCalendarDays(text: string, today: CalendarDay): CalendarDay[] {
  const src = String(text ?? "");
  if (!src.trim()) return [];
  const found: CalendarDay[] = [];
  const push = (month: number, day: number, year: number | null) => {
    if (!isPlausibleDay(month, day)) return;
    found.push({ year: year ?? today.year, month, day });
  };

  for (const m of src.matchAll(MONTH_FIRST_RE)) {
    push(MONTHS[String(m[1]).toLowerCase()], Number(m[2]), normalizeYear(m[3]));
  }
  for (const m of src.matchAll(DAY_FIRST_RE)) {
    push(MONTHS[String(m[2]).toLowerCase()], Number(m[1]), normalizeYear(m[3]));
  }
  for (const m of src.matchAll(NUMERIC_RE)) {
    push(Number(m[1]), Number(m[2]), normalizeYear(m[3]));
  }
  return found;
}

/**
 * TRUE when any of the supplied texts names a calendar day that is already behind us — i.e. a
 * proactive touch built from this material could invite the customer to something that already
 * happened. Callers pass BOTH the composed touch and the anchor messages it was written from:
 * the Don Soto miss carried no date in the bump itself ("still planning to come by Saturday?"),
 * only in the blast it was continuing.
 */
export function referencesPastDatedEvent(
  texts: Array<string | null | undefined>,
  opts: { nowMs?: number; timeZone?: string } = {}
): boolean {
  const today = calendarDayInTimeZone(
    Number.isFinite(opts.nowMs as number) ? (opts.nowMs as number) : Date.now(),
    opts.timeZone || PAST_EVENT_GUARD_DEFAULT_TIMEZONE
  );
  for (const text of texts ?? []) {
    for (const day of findReferencedCalendarDays(String(text ?? ""), today)) {
      if (compareDays(day, today) < 0) return true;
    }
  }
  return false;
}
