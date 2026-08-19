/**
 * The staff-authored outbound appointment parser's PROMPT (state mapping, rules, few-shots) and the
 * one helper that turns its output back into a day+time phrase the scheduler can resolve.
 *
 * WHY IT LIVES HERE. Two production misses on 2026-08-12 (John Kelly +17169902571, reported by the
 * operator twice inside four minutes) came from the same hole: the customer settles the DAY, the
 * staff reply settles only the TIME ("Ok sounds good John, see you around 3!" / "Ok 3:45 works!"),
 * and the parser returned `day: null` at 0.88 confidence — a clean `confirmed_booking` with nothing
 * `parseRequestedDayTime` can resolve, because that function returns null without a day token
 * (conversationStore.ts, `if (!dayToken) return null`). The booking then dies silently: no calendar
 * event, no appointment, no place in the booked funnel. Measured on the live store, ~10 staff
 * confirmations in 90d carry a clock time and no day, against 52 booked events in the same window.
 *
 * The day is a COMPREHENSION job — which day did this thread already agree on — so it belongs in the
 * parser's prompt, not in another keyword gate (CLAUDE.md rule 1). The composer below is the
 * structured-extraction half: it only re-attaches a day the parser itself returned.
 */

/** State mapping + rules, in prompt order. */
export const MANUAL_OUTBOUND_APPOINTMENT_PROMPT_RULES: string[] = [
  "State mapping:",
  "- confirmed_booking: staff clearly says the customer is scheduled, booked, set, or will be scheduled for a concrete day/time.",
  "- proposed_time: staff proposes a time but needs customer confirmation, especially phrases like 'if that works', 'would that work', 'let's shoot for'.",
  "- asks_for_time: staff asks the customer what day/time works.",
  "- slot_offer: staff offers one or more appointment slots and asks the customer to choose/confirm.",
  "- reschedule_request: staff asks to change/move an already booked appointment.",
  "- none: no appointment state should be changed.",
  "",
  "Rules:",
  "- Do not mark proposed_time as confirmed_booking.",
  "- 'if that works' means proposed_time unless the staff also says the customer already confirmed.",
  "- 'That works' alone is not a booking confirmation because it lacks the appointment details.",
  "- Keep time ranges like 11-12 or 4:30-5:00 as ranges.",
  "- Do not classify phone calls, inventory, parts, service, or pricing replies as appointment state.",
  "- Use empty strings for unknown requested.day and requested.time_text.",
  // The day-from-context rule. Bounded on purpose: carry a day the recent messages ALREADY settled,
  // never a day nobody named. An unresolvable confirmation books nothing at all, so the cost of
  // leaving it empty is a lost appointment, and the cost of guessing is a wrong-day appointment.
  "- If the staff message confirms a time but names no day, and the recent messages already settle which day it is (the customer said 'today', 'tomorrow', 'in 45 minutes', 'on my way', or named a weekday that is being confirmed), put that day in requested.day and start normalized_text with it.",
  "- Only carry a day the recent messages actually settle. If nothing in them names a day, leave requested.day empty rather than guessing.",
  "- normalized_text must include requested.day whenever requested.day is known.",
  "- confidence is 0 to 1."
];

/** Few-shots. The last three are the day-from-context production cases. */
export const MANUAL_OUTBOUND_APPOINTMENT_EXAMPLES: string[] = [
  'input: "Staff: I will schedule an inspection for the 12th at noon for you" output: {"state":"confirmed_booking","explicit_state":true,"requested":{"day":"12th","time_text":"noon","time_window":"exact"},"reference":"none","normalized_text":"12th at noon","confidence":0.96}',
  'input: "Staff: Hey Rafael, sorry, that would work ill schedule you in between 11-12 tomorrow" output: {"state":"confirmed_booking","explicit_state":true,"requested":{"day":"tomorrow","time_text":"between 11-12","time_window":"range"},"reference":"none","normalized_text":"tomorrow between 11-12","confidence":0.96}',
  'input: "Staff: I will have you meet with Giovanni tomorrow around 4:30-5:00" output: {"state":"confirmed_booking","explicit_state":true,"requested":{"day":"tomorrow","time_text":"around 4:30-5:00","time_window":"range"},"reference":"none","normalized_text":"tomorrow around 4:30-5:00","confidence":0.96}',
  'input: "Staff: Hey Jen, lets shoot for 9:30 if that works" output: {"state":"proposed_time","explicit_state":true,"requested":{"day":"","time_text":"9:30","time_window":"exact"},"reference":"none","normalized_text":"9:30 if that works","confidence":0.96}',
  'input: "Staff: I’ll schedule you in at 9:30 if that works" output: {"state":"proposed_time","explicit_state":true,"requested":{"day":"","time_text":"9:30","time_window":"exact"},"reference":"none","normalized_text":"9:30 if that works","confidence":0.95}',
  'input: "Staff: I have Thu, May 7, 9:30 AM or Thu, May 7, 11:30 AM — do either work?" output: {"state":"slot_offer","explicit_state":true,"requested":{"day":"Thu, May 7","time_text":"9:30 AM or 11:30 AM","time_window":"range"},"reference":"none","normalized_text":"Thu, May 7 9:30 AM or 11:30 AM","confidence":0.96}',
  'input: "Staff: What time tomorrow are you thinking?" output: {"state":"asks_for_time","explicit_state":true,"requested":{"day":"tomorrow","time_text":"","time_window":"unknown"},"reference":"none","normalized_text":"tomorrow","confidence":0.95}',
  'input: "Staff: We can reschedule that for next week" output: {"state":"reschedule_request","explicit_state":true,"requested":{"day":"next week","time_text":"","time_window":"unknown"},"reference":"last_appointment","normalized_text":"next week","confidence":0.92}',
  'input: "Staff: That works!" output: {"state":"none","explicit_state":false,"requested":{"day":"","time_text":"","time_window":"unknown"},"reference":"none","normalized_text":"","confidence":0.93}',
  'input: "Staff: Can you call me?" output: {"state":"none","explicit_state":false,"requested":{"day":"","time_text":"","time_window":"unknown"},"reference":"none","normalized_text":"","confidence":0.95}',
  'input: "Recent messages:\\nin: Oh okay I get out at 3 joe I should be able to stop today\\nStaff: Ok sounds good John, see you around 3!" output: {"state":"confirmed_booking","explicit_state":true,"requested":{"day":"today","time_text":"around 3","time_window":"range"},"reference":"none","normalized_text":"today around 3","confidence":0.9}',
  'input: "Recent messages:\\nin: I will most likely be there around 10am tomorrow if thats ok?\\nStaff: I’ll see you at 10:00 Am. Text me if anything changes." output: {"state":"confirmed_booking","explicit_state":true,"requested":{"day":"tomorrow","time_text":"10:00 AM","time_window":"exact"},"reference":"none","normalized_text":"tomorrow 10:00 AM","confidence":0.92}',
  'input: "Recent messages:\\nin: Do you have that Road Glide in stock?\\nStaff: Ok 3:45 works!" output: {"state":"confirmed_booking","explicit_state":true,"requested":{"day":"","time_text":"3:45","time_window":"exact"},"reference":"none","normalized_text":"3:45","confidence":0.85}'
];

type ManualOutboundRequestedFields = {
  requested?: { day?: string | null; timeText?: string | null } | null;
  normalizedText?: string | null;
} | null;

// Day-ish words only. A bare number is NOT one of them — "around 3" is a time, and reading it as
// the 3rd is how a day-less phrase would sneak past this check and keep the bug alive.
const DAY_WORDS =
  /\b(today|tonight|tomorrow|monday|mon|tuesday|tue|tues|wednesday|wed|thursday|thu|thur|thurs|friday|fri|saturday|sat|sunday|sun|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|\d{1,2}(?:st|nd|rd|th)\b)/i;

/**
 * The phrase `parseRequestedDayTime` is asked to resolve. `normalized_text` is preferred because it
 * reads like a sentence, but a normalization that dropped the day is exactly the miss this module
 * exists for — so when the parser DID name a day and the normalized phrase does not carry one, the
 * day goes back on the front. Structured extraction over the parser's own output: it never invents
 * a day the parser did not return.
 */
export function composeManualOutboundRequestedPhrase(parsed: ManualOutboundRequestedFields): string {
  const day = String(parsed?.requested?.day ?? "").trim();
  const time = String(parsed?.requested?.timeText ?? "").trim();
  const normalized = String(parsed?.normalizedText ?? "").trim();
  if (day && normalized && !DAY_WORDS.test(normalized)) return `${day} ${normalized}`.trim();
  return normalized || [day, time].filter(Boolean).join(" ").trim();
}

// ── The lexical cue set that guards this parser ──────────────────────────────────────────────────
// Moved verbatim out of the `reconcileManualOutboundState` body in index.ts (2026-08-18). These are
// NOT comprehension — the typed parser above owns what a staff message MEANS. They are the fail-safe
// gates AROUND it (AGENTS.md: a gate whose removal makes us fail toward doing the side-effect is a
// KEEP), and they belong beside the parser they guard, where an eval can reach them. Every one is
// byte-identical to the inline regex it replaces; renaming them would have been a behaviour change.

/** Staff explicitly asked to MOVE an existing appointment. */
export function manualOutboundHasRescheduleWording(lower: string): boolean {
  return /\b(reschedule|re-?schedule|change (?:the )?time|move (?:it|me)?|another time|different time|push (?:it )?back|later time|earlier time)\b/i.test(lower);
}

/** Appointment-ish vocabulary of any kind. */
export function manualOutboundHasScheduleKeyword(text: string): boolean {
  return /\b(schedule|book|appointment|appt|reschedule|availability|available|stop by|stop in|come in|see you|works)\b/i.test(text);
}

/** A day is named somewhere in the message. */
export function manualOutboundHasDayToken(text: string): boolean {
  return /\b(today|tomorrow|monday|mon|tuesday|tue|wednesday|wed|thursday|thu|friday|fri|saturday|sat|sunday|sun|next week|this week|this weekend|weekend)\b/i.test(text);
}

/** A clock time or a part of the day is named somewhere in the message. */
export function manualOutboundHasTimeToken(text: string): boolean {
  return /\b(\d{1,2}(:\d{2})?\s*(am|pm)\b|morning|afternoon|evening|night|noon|midnight)\b/i.test(text);
}

/** Two or more explicit clock times joined by or/either — staff offered a choice of slots. */
export function manualOutboundOffersMultipleTimeChoices(text: string, lower: string): boolean {
  const explicitTimeMentions = text.match(/\b\d{1,2}(?::\d{2})?\s*(?:am|pm)\b/gi) ?? [];
  return explicitTimeMentions.length >= 2 && /\b(or|either)\b/i.test(lower);
}

/** The message asks something rather than states it. */
export function manualOutboundAsksScheduleQuestion(text: string, lower: string): boolean {
  return /\?/.test(text) || /\b(would|could|can|do|does|are|is|what|which|when)\b/i.test(lower);
}
