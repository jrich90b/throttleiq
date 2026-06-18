/**
 * Day-aware test-ride-init reply (the "requested_day_reasked" answer-correctness fix).
 *
 * When a customer names a day while selecting a bike for a test ride, the agent must
 * ACKNOWLEDGE that day and ask only for the time-of-day — never re-ask "what day?". The
 * day is comprehended upstream by the appointment-timing parser (requested.day); this
 * module shapes the reply and resolves the day label, preferring the parser's day and
 * falling back to deterministic extraction (structured extraction — allowed deterministic,
 * the same idiom as extractYearSingle at the call site).
 *
 * SCOPE: active-scheduling RELATIVE days only (today / tomorrow / weekday). Month-dates and
 * soft-commitment / event-RSVP days are intentionally out of scope here (the call site —
 * the test-ride-bike-selection block — already gates to an active scheduling turn, and the
 * resolver returns null for anything outside the relative-day set). Pinned by
 * scripts/test_ride_day_reask_eval.ts.
 */

const WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];

/**
 * The relative day the customer named this turn, or null. Prefers the appointment-timing
 * parser's captured day; falls back to deterministic extraction from the inbound text.
 * Returns only today/tomorrow/weekday — a month-date ("june 20th") or no-day yields null
 * (deferred soft/event scope), so the caller keeps the original prompt.
 */
export function resolveNamedSchedulingDay(parserDay: string | null | undefined, text: string): string | null {
  const fromParser = String(parserDay ?? "").trim().toLowerCase();
  if (fromParser === "today" || fromParser === "tomorrow" || WEEKDAYS.includes(fromParser)) {
    return fromParser;
  }
  const t = String(text ?? "").toLowerCase();
  if (/\btoday\b/.test(t)) return "today";
  if (/\btomorrow\b/.test(t)) return "tomorrow";
  for (const wd of WEEKDAYS) {
    if (new RegExp(`\\b${wd}\\b`).test(t)) return wd;
  }
  return null;
}

/**
 * The test-ride-init reply. With a named day → acknowledge it and ask the time-of-day.
 * Without one → the original "what day and time" prompt (correct when no day was given, so
 * this change is purely additive — behavior only differs when a day is actually present).
 */
export function buildTestRideInitReply(label: string, namedDayLabel: string | null): string {
  if (namedDayLabel) {
    const d = namedDayLabel.trim();
    const dayWord = d === "today" || d === "tomorrow" ? d : d.charAt(0).toUpperCase() + d.slice(1);
    return `Got it — I can line up the test ride on the ${label} for ${dayWord}. Morning or afternoon work better?`;
  }
  return `Got it — I can line up the test ride on the ${label}. What day and time works best?`;
}
