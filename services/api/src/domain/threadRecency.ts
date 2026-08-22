/**
 * How old is this thread line? — the one question every prompt that shows a model a CONVERSATION
 * has to answer, and the one two of them were silently not answering.
 *
 * Extracted from `claudeDraftReview.ts` (2026-08-22) when the SECOND lane needed it. The reviewer
 * learned on 8/21 (`7ef1cb29`) that a thread rendered without dates reads as if it all happened
 * moments ago, so an undated "about 3pm" agreed days back resolves to TODAY. The quiet-thread nudge
 * had the identical defect and is structurally worse: it is the ONE composer that only ever fires
 * days after the thread went quiet, so the gap between "when it was said" and "now" is the whole
 * point of the lane — and it was the one piece of context the model never got.
 *
 * Pure, clock-free (every function takes `nowMs`) and dependency-free, so prompt surfaces can pin
 * their rendered output in an eval with no API key and no fake timers.
 *
 * ⚠️ WHY `timeZone` IS A PARAMETER AND NOT A DEFAULT. Measured 2026-08-22: the box runs UTC while
 * the dealership is in America/New_York, so host-local rendering stamps a message sent 11:52 AM ET
 * as "3:52 PM" — and, for anything sent after 8pm ET, lands it on the WRONG CALENDAR DAY, which is
 * the exact error class these stamps exist to prevent. It stays OPTIONAL because omitting it
 * reproduces host-local behaviour byte for byte, which is what keeps the reviewer's extraction
 * behaviour-preserving; new callers should always pass the dealer zone.
 */

/** `YYYY-MM-DD` for an instant, in the given zone (host-local when omitted). */
function calendarDayKey(ms: number, timeZone?: string): string {
  if (!timeZone) {
    const d = new Date(ms);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }
  // en-CA is ISO-ordered, so this is a sortable, subtractable day key in the dealer's zone.
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(
    new Date(ms)
  );
}

/**
 * CALENDAR-day difference, deliberately — not elapsed hours. "yesterday at 4pm" must not read as
 * "today" merely because only 20 hours have passed; staleness is what the model has to judge.
 */
export function describeThreadLineAge(atMs: number, nowMs: number, timeZone?: string): string {
  const dayMs = 24 * 60 * 60 * 1000;
  const asUtcMidnight = (key: string) => Date.parse(`${key}T00:00:00Z`);
  const days = Math.round((asUtcMidnight(calendarDayKey(nowMs, timeZone)) - asUtcMidnight(calendarDayKey(atMs, timeZone))) / dayMs);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  return `${days} days ago`;
}

/**
 * The parenthetical a thread line carries, e.g. ` (Mon Aug 18, 3 days ago)`. Returns "" when the
 * row has no usable timestamp, so a renderer can concatenate it unconditionally.
 */
export function formatThreadLineStamp(at: unknown, nowMs: number, timeZone?: string): string {
  const atMs = Date.parse(String(at ?? ""));
  if (!Number.isFinite(atMs)) return "";
  const when = new Date(atMs).toLocaleString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    ...(timeZone ? { timeZone } : {})
  });
  return ` (${when}, ${describeThreadLineAge(atMs, nowMs, timeZone)})`;
}
