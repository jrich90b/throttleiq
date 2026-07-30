/**
 * When we tell a customer a human "will reach out", WHEN we say it happens has to be true.
 *
 * Production misses this fixed (all hand-corrected by staff before sending):
 *  - christopher killian (#11649) + Roger McCleskey (#11650), 2026-07-18: credit-app ADFs landed
 *    ~4:45pm on a SATURDAY (dealership closes 3pm). The draft promised finance would "reach out
 *    shortly"; staff deleted "shortly" on BOTH, 22 seconds apart.
 *  - David Boos (#11687): app landed 11:21pm Friday; Joe rewrote it to "reach out tomorrow when the
 *    dealership opens."
 *
 * "Shortly" after close is a promise we can't keep. But a naive "tomorrow" is its own bug: American
 * H-D is open Mon-Sat and CLOSED SUNDAY, so "tomorrow" said on a Saturday evening is wrong. So we
 * resolve the actual NEXT OPEN DAY from the dealer's configured hours.
 *
 * Pure + deterministic (a copy/timing guard, not comprehension) — pinned by staff_followup_timing:eval.
 */

import { getSchedulerConfig } from "./schedulerConfig.js";

export type BusinessDayHours = { open?: string | null; close?: string | null } | null | undefined;
/** Keyed by lowercase weekday name ("monday"…"sunday"), as scheduler_config.json stores it. */
export type BusinessWeekHours = Record<string, BusinessDayHours>;

export const WEEKDAY_NAMES = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday"
] as const;

function toMinutes(raw: unknown): number | null {
  const m = String(raw ?? "").trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const minutes = Number(m[1]) * 60 + Number(m[2]);
  return Number.isFinite(minutes) && minutes >= 0 && minutes < 24 * 60 ? minutes : null;
}

function dayHours(hours: BusinessWeekHours | null | undefined, dayIndex: number) {
  const key = WEEKDAY_NAMES[((dayIndex % 7) + 7) % 7];
  const entry = hours?.[key];
  const open = toMinutes(entry?.open);
  const close = toMinutes(entry?.close);
  if (open == null || close == null || close <= open) return null;
  return { open, close };
}

export function isDealershipOpenAt(args: {
  hours: BusinessWeekHours | null | undefined;
  dayIndex: number; // 0 = Sunday
  minutesSinceMidnight: number;
}): boolean {
  const today = dayHours(args.hours, args.dayIndex);
  if (!today) return false;
  return args.minutesSinceMidnight >= today.open && args.minutesSinceMidnight < today.close;
}

/**
 * The next day the dealership is open, as an offset in days from `dayIndex`.
 * 0 = still open (or opens later) today, 1 = tomorrow, … Returns null if the week has no open day.
 */
export function nextOpenDayOffset(args: {
  hours: BusinessWeekHours | null | undefined;
  dayIndex: number;
  minutesSinceMidnight: number;
}): number | null {
  const today = dayHours(args.hours, args.dayIndex);
  if (today && args.minutesSinceMidnight < today.close) return 0;
  for (let offset = 1; offset <= 7; offset += 1) {
    if (dayHours(args.hours, args.dayIndex + offset)) return offset;
  }
  return null;
}

function titleCase(word: string): string {
  return word ? word[0].toUpperCase() + word.slice(1) : word;
}

/**
 * The trailing timing phrase for "our finance team will reach out ___".
 *
 * - Open right now                         → "shortly" (unchanged; the promise is keepable)
 * - Closed, but we open again later today  → "shortly" (same-day, still fine)
 * - Closed, next open day is tomorrow      → "when we open tomorrow"
 * - Closed, next open day is further out   → "when we open Monday"
 * - Hours unknown/unconfigured             → "shortly" (FAIL-SAFE: keep today's wording rather than
 *                                            invent a schedule we can't verify)
 */
export function buildStaffFollowUpTimingPhrase(args: {
  hours: BusinessWeekHours | null | undefined;
  dayIndex: number;
  minutesSinceMidnight: number;
}): string {
  const hasAnyConfiguredDay = WEEKDAY_NAMES.some((_, i) => dayHours(args.hours, i));
  if (!hasAnyConfiguredDay) return "shortly";
  if (isDealershipOpenAt(args)) return "shortly";
  const offset = nextOpenDayOffset(args);
  if (offset == null) return "shortly";
  if (offset === 0) return "shortly";
  if (offset === 1) return "when we open tomorrow";
  const dayName = WEEKDAY_NAMES[((args.dayIndex + offset) % 7 + 7) % 7];
  return `when we open ${titleCase(dayName)}`;
}

/**
 * Minutes the dealership was actually OPEN between two instants (Joe ruling, 2026-07-30).
 *
 * "This draft has been waiting 7 hours" is a false alarm when 6 of those hours were the middle
 * of the night. A service ADF landed 2026-07-30 00:53 and was flagged stale by the 08:15 audit —
 * nobody is at the dealership at 1am, so the wall-clock rule made the stale-draft P1 permanently
 * unclearable in suggest mode, and with it the readiness bar's operability section. Measuring in
 * business time makes the alarm mean "staff are behind", which is the thing worth paging about.
 *
 * Walks forward one local day-segment at a time and intersects each with that weekday's configured
 * open window, so closures and a short Saturday are respected without hardcoding any dealer's hours.
 * Returns 0 when the span is entirely outside business hours, and null when hours are unconfigured
 * (callers FAIL SAFE by falling back to wall-clock rather than silently suppressing an alarm).
 *
 * DST is approximated: a spring-forward/fall-back day is treated as 24h, so twice a year the count
 * can be off by up to an hour. Immaterial against a 30-minute threshold, and deliberately not worth
 * a timezone library here.
 */
export function businessMinutesBetween(args: {
  hours: BusinessWeekHours | null | undefined;
  timeZone: string;
  fromMs: number;
  toMs: number;
  /** Safety valve: stop walking after this many days (a very old draft is stale either way). */
  maxDays?: number;
}): number | null {
  const hasAnyConfiguredDay = WEEKDAY_NAMES.some((_, i) => dayHours(args.hours, i));
  if (!hasAnyConfiguredDay) return null;
  if (!Number.isFinite(args.fromMs) || !Number.isFinite(args.toMs)) return null;
  if (args.toMs <= args.fromMs) return 0;

  const DAY_MS = 24 * 60 * 60 * 1000;
  const maxDays = args.maxDays ?? 30;
  const hardStop = Math.min(args.toMs, args.fromMs + maxDays * DAY_MS);

  let total = 0;
  let cursor = args.fromMs;
  // Bounded by maxDays segments — one per local day — so a bad clock can't spin here.
  for (let guard = 0; guard <= maxDays + 1 && cursor < hardStop; guard += 1) {
    const { dayIndex, minutesSinceMidnight } = localClockParts(new Date(cursor), args.timeZone);
    const segmentEnd = Math.min(hardStop, cursor + (24 * 60 - minutesSinceMidnight) * 60_000);
    const today = dayHours(args.hours, dayIndex);
    if (today) {
      const startMin = minutesSinceMidnight;
      const endMin = startMin + (segmentEnd - cursor) / 60_000;
      total += Math.max(0, Math.min(today.close, endMin) - Math.max(today.open, startMin));
    }
    cursor = segmentEnd;
  }
  return Math.round(total);
}

/** Local weekday index (0=Sunday) + minutes since midnight for a timezone. */
export function localClockParts(now: Date, timeZone: string): { dayIndex: number; minutesSinceMidnight: number } {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "long",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  });
  const parts = Object.fromEntries(fmt.formatToParts(now).map(p => [p.type, p.value]));
  const dayIndex = WEEKDAY_NAMES.indexOf(String(parts.weekday ?? "").toLowerCase() as (typeof WEEKDAY_NAMES)[number]);
  const hour = Number(parts.hour ?? 0) % 24;
  const minute = Number(parts.minute ?? 0);
  return {
    dayIndex: dayIndex >= 0 ? dayIndex : 0,
    minutesSinceMidnight: (Number.isFinite(hour) ? hour : 0) * 60 + (Number.isFinite(minute) ? minute : 0)
  };
}

/**
 * The runtime wrapper both paths call (live ADF intake + /conversations/:id/regenerate), so the two
 * can't drift. Reads the dealer's configured hours; on ANY failure it returns "shortly" — today's
 * wording — rather than guessing at a schedule.
 */
export async function resolveStaffFollowUpTimingPhrase(now: Date = new Date()): Promise<string> {
  try {
    const cfg = await getSchedulerConfig();
    const { dayIndex, minutesSinceMidnight } = localClockParts(now, cfg.timezone || "America/New_York");
    return buildStaffFollowUpTimingPhrase({
      hours: cfg.businessHours as BusinessWeekHours,
      dayIndex,
      minutesSinceMidnight
    });
  } catch {
    return "shortly";
  }
}
