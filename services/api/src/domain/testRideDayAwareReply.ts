/**
 * Day-aware scheduling re-asks (the "requested_day_reasked" answer-correctness fix).
 *
 * When a customer names a day in an active-scheduling turn, the agent must ACKNOWLEDGE that day
 * and ask only for the time-of-day — never re-ask "what day?". The day is comprehended upstream
 * by the appointment-timing parser (requested.day); this module shapes the reply and resolves the
 * day label, preferring the parser's day and falling back to deterministic extraction (structured
 * extraction — allowed deterministic, the same idiom as extractYearSingle at the call sites).
 *
 * Two builders share the same day resolution: buildTestRideInitReply (test-ride init) and
 * makeSchedulingReaskDayAware (general "what day and time works…" re-asks — availability answer,
 * etc.). Both are purely additive: behavior only differs when a relative day is actually present.
 *
 * SCOPE: active-scheduling RELATIVE days only (today / tomorrow / weekday) where the named day is
 * the day the customer WANTS. Month-dates and soft-commitment / event-RSVP days (intent=none) are
 * out of scope (the resolver returns null for anything outside the relative-day set). Decline /
 * conflict re-asks ("I can't make it tomorrow", rejecting offered slots) are also out of scope —
 * there the named day is the one that does NOT work, so acknowledging it would be wrong; those
 * re-asks are intentionally left day-blind. Pinned by scripts/test_ride_day_reask_eval.ts.
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
 * Format a relative day for mid-sentence use: today/tomorrow stay lowercase, a weekday is
 * capitalized ("Monday"). Shared by the test-ride and general scheduling re-ask builders.
 */
function formatNamedDayWord(namedDayLabel: string): string {
  const d = String(namedDayLabel ?? "").trim();
  return d === "today" || d === "tomorrow" ? d : d.charAt(0).toUpperCase() + d.slice(1);
}

/**
 * The test-ride-init reply. With a named day → acknowledge it and ask the time-of-day.
 * Without one → the original "what day and time" prompt (correct when no day was given, so
 * this change is purely additive — behavior only differs when a day is actually present).
 */
export function buildTestRideInitReply(label: string, namedDayLabel: string | null): string {
  if (namedDayLabel) {
    return `Got it — I can line up the test ride on the ${label} for ${formatNamedDayWord(
      namedDayLabel
    )}. Morning or afternoon work better?`;
  }
  return `Got it — I can line up the test ride on the ${label}. What day and time works best?`;
}

/**
 * Make a generic "what day and time works…" scheduling re-ask day-aware: when the customer named
 * a relative day this turn, rewrite the re-ask to acknowledge that day and ask only the time
 * ("…what time tomorrow works…"). Returns the base reply unchanged when no day was named — purely
 * additive, the same idiom as buildTestRideInitReply (reply-shaping, not comprehension: the day
 * itself is resolved upstream by resolveNamedSchedulingDay).
 *
 * USE ONLY where the named day is the day the customer WANTS (active scheduling — availability /
 * test-ride / provide_new_time). Do NOT use in decline / conflict re-asks (see the module SCOPE
 * note): there the named day is the one that does NOT work.
 */
export function makeSchedulingReaskDayAware(baseReply: string, namedDayLabel: string | null): string {
  if (!namedDayLabel) return baseReply;
  return String(baseReply ?? "").replace(
    /\bwhat day and time works\b/i,
    `what time ${formatNamedDayWord(namedDayLabel)} works`
  );
}
