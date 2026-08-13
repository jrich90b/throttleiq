/**
 * THE STORE IS CLOSED THEN. An invariant guard over any time we state as workable.
 *
 * PRODUCTION (all four actually SENT to customers):
 *   +17169822561  "around 1-2pm"                 -> "Sounds good. 1:00 AM can work."
 *   +17165155413  "the 9th after 1:30"           -> "Sounds good. 1:30 AM can work."
 *   +18153294306  "...also it's a 2022!"         -> "tomorrow at 8:22 PM works."   (a MODEL YEAR
 *                                                   read as 20:22)
 * Each was a different comprehension bug, and each was individually fixed in the parsers — a probe
 * against current code resolves "after 1:30" to 13:30, keeps the meridiem on "1-2pm", and no longer
 * reads "2022" as a time. So those three are stale.
 *
 * WHAT IS NOT STALE is that nothing ever CHECKED. The reply sites assert a clock time verbatim from
 * whatever the extractor produced, so the class survives every one of those point fixes — and it is
 * reachable today with no bug at all: a customer asking "how about 8pm?" gets
 * "Got it — 8:00 PM can work. Which day were you thinking?" when the store closes at 6, and
 * "Saturday 8:00 PM should work. Want me to lock that in?" when Saturday closes at 3.
 *
 * WHY DETERMINISTIC (AGENTS.md "deterministic only for … invariant guards"): opening hours are a
 * dealer FACT, not a reading of the customer. Nothing the customer could mean makes 8:00 PM a time
 * the store is open. This does not decide intent — the parsers still do that — it only refuses to
 * ASSERT a time that is impossible, which is the one thing no comprehension fix can guarantee.
 *
 * FAIL DIRECTION: on anything unknown — unparseable time, missing/empty hours config, a day we have
 * no entry for — this returns TRUE (state it). Silence and false "we're closed" replies are worse
 * than the rare off-hours echo, and an empty config must never turn the agent mute. It says NO only
 * when it positively knows the store is shut.
 *
 * BOOKING is already guarded elsewhere: `findExactSlotForSalesperson` (schedulerEngine) returns null
 * outside open hours, so an off-hours time could never actually reach the calendar. This closes the
 * conversational half — the half the customer reads.
 */

export type DayHours = { open?: string | null; close?: string | null } | null | undefined;
export type BusinessWeekHours = Record<string, DayHours> | null | undefined;

/** "09:00" -> 540. Returns null on anything it cannot read. */
export function parseClockMinutes(value: string | null | undefined): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(value ?? "").trim());
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return hour * 60 + minute;
}

/** Local calendar day ("2026-08-09") for an instant in a timezone. Pure; moved out of index.ts
 *  beside the closing-time helper that answers the same kind of question. */
export function dayKeyLocal(iso: string, tz: string): string {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).format(new Date(iso));
  } catch {
    return new Date(iso).toISOString().slice(0, 10);
  }
}

/**
 * Epoch ms at which we CLOSE on the business day an instant falls in — or null when that day has no
 * usable window, or the instant is outside it.
 *
 * Deliberately computed as an OFFSET from the instant itself (close-minutes minus the instant's own
 * local minutes) rather than by constructing a wall-clock time in a zone. That sidesteps every
 * timezone-arithmetic trap: the only assumption is that no DST transition falls between the instant
 * and closing on the same day, which no dealership schedule crosses.
 *
 * Used by the held-draft backstop so a "needs a human" flag lands while someone is still there.
 */
export function closingTimeMsForInstant(args: {
  atIso: string | null | undefined;
  timeZone: string;
  businessHours: BusinessWeekHours | null | undefined;
}): number | null {
  const atMs = Date.parse(String(args.atIso ?? ""));
  if (!Number.isFinite(atMs)) return null;
  let weekday = "";
  let hour = NaN;
  let minute = NaN;
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: args.timeZone,
      weekday: "long",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false
    }).formatToParts(new Date(atMs));
    weekday = String(parts.find(p => p.type === "weekday")?.value ?? "").toLowerCase();
    hour = Number(parts.find(p => p.type === "hour")?.value);
    minute = Number(parts.find(p => p.type === "minute")?.value);
  } catch {
    return null;
  }
  if (hour === 24) hour = 0; // some ICU builds render midnight as 24 under hour12:false
  if (!weekday || !Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  const window = openWindow((args.businessHours as any)?.[weekday]);
  if (!window) return null;
  const localMinutes = hour * 60 + minute;
  // Outside the day's window => the plain stale timer is right; there is no "before close" to beat.
  if (localMinutes < window.open || localMinutes >= window.close) return null;
  return atMs + (window.close - localMinutes) * 60_000;
}

function openWindow(day: DayHours): { open: number; close: number } | null {
  const open = parseClockMinutes(day?.open);
  const close = parseClockMinutes(day?.close);
  if (open == null || close == null || close <= open) return null;
  return { open, close };
}

/**
 * May we tell the customer this clock time works?
 *
 * With a `dayKey` ("saturday") the answer is that day's window. WITHOUT one — the
 * "which day were you thinking?" turn, where the time is floating — the bar is whether the time
 * could land inside ANY open day, because a time outside every window is impossible whatever day
 * they pick. A day we have no hours entry for is UNKNOWN, not closed (fail-direction above).
 */
export function mayStateTimeAsWorkable(args: {
  hour24: number | null | undefined;
  minute?: number | null;
  businessHours: BusinessWeekHours;
  dayKey?: string | null;
}): boolean {
  const hour24 = args.hour24;
  if (typeof hour24 !== "number" || !Number.isFinite(hour24) || hour24 < 0 || hour24 > 23) {
    return true; // unparseable => not our call
  }
  const minute = typeof args.minute === "number" && Number.isFinite(args.minute) ? args.minute : 0;
  if (minute < 0 || minute > 59) return true;
  const at = hour24 * 60 + minute;

  const hours = args.businessHours;
  if (!hours || typeof hours !== "object") return true; // no config => never go mute

  const dayKey = String(args.dayKey ?? "").trim().toLowerCase();
  if (dayKey) {
    if (!(dayKey in hours)) return true; // unknown day => unknown, not closed
    const win = openWindow(hours[dayKey]);
    // An entry that EXISTS but carries no usable window is a closed day — the closed-day copy is
    // the caller's job, but we must not assert a time on it.
    if (!win) return false;
    return at >= win.open && at < win.close;
  }

  const windows = Object.values(hours)
    .map(openWindow)
    .filter((w): w is { open: number; close: number } => !!w);
  if (!windows.length) return true; // no usable hours anywhere => no basis to refuse
  return windows.some(w => at >= w.open && at < w.close);
}

/** 540 -> "9:00 AM". */
function formatClock(minutes: number): string {
  const h24 = Math.floor(minutes / 60);
  const m = minutes % 60;
  const meridiem = h24 >= 12 ? "PM" : "AM";
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h12}:${String(m).padStart(2, "0")} ${meridiem}`;
}

/**
 * The reply for a turn that wants to say "<time> can work".
 *
 * Returns `preferred` untouched whenever the time is statable — which is the overwhelmingly common
 * case and includes every ambiguous or unknown input, so this is close to a no-op in normal use.
 * Only when the store is positively shut at that time does it swap in a reply that names the real
 * hours and re-asks, instead of asserting something impossible.
 */
export function statableTimeReply(
  token: string | null | undefined,
  businessHours: BusinessWeekHours,
  dayKey: string | null | undefined,
  preferred: string
): string {
  const clock = parseTimeTokenToClock(token);
  if (!clock) return preferred;
  if (mayStateTimeAsWorkable({ ...clock, businessHours, dayKey })) return preferred;
  return openHoursReAskSentence(businessHours) ?? preferred;
}

/**
 * The ONE sentence we use whenever we refuse to state a time: name the real hours and re-ask.
 * Defined once so every refusing site says the same thing — byte-identical to what
 * `statableTimeReply` has been sending since this guard shipped. Null when the config carries no
 * usable hours, which every caller must read as "keep today's copy" (fail direction above).
 */
export function openHoursReAskSentence(businessHours: BusinessWeekHours): string | null {
  const window = widestOpenWindow(businessHours);
  if (!window) return null;
  return `We're open ${formatClock(window.open)} to ${formatClock(window.close)} — what time in there works best for you?`;
}

/**
 * Read a scheduler time token ("8:00pm", "8pm", "13:30") into a clock time.
 *
 * Returns null — meaning DO NOT JUDGE — whenever the token is ambiguous: a bare "1:30" with no
 * meridiem could be 1:30 AM or 1:30 PM, and the upstream parsers now resolve exactly that toward
 * business hours. Guessing 01:30 here would refuse a perfectly good 1:30 PM, so ambiguity is
 * handed back rather than resolved. Only an EXPLICIT meridiem, or an unambiguous 24-hour value,
 * is judged.
 */
export function parseTimeTokenToClock(
  token: string | null | undefined
): { hour24: number; minute: number } | null {
  const raw = String(token ?? "").trim().toLowerCase().replace(/\./g, "");
  if (!raw) return null;
  const m = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/.exec(raw);
  if (!m) return null;
  let hour = Number(m[1]);
  const minute = m[2] == null ? 0 : Number(m[2]);
  const meridiem = m[3];
  if (!Number.isFinite(hour) || !Number.isFinite(minute) || minute > 59) return null;
  if (meridiem) {
    if (hour < 1 || hour > 12) return null;
    if (meridiem === "pm" && hour !== 12) hour += 12;
    if (meridiem === "am" && hour === 12) hour = 0;
    return { hour24: hour, minute };
  }
  // No meridiem: only a 24-hour value (13-23, or 0) is unambiguous. 1-12 could be either half.
  if (hour === 0 || (hour >= 13 && hour <= 23)) return { hour24: hour, minute };
  return null;
}

/**
 * The widest open window across the week, for copy like "we're open 9:00-6:00". Null when the
 * config carries no usable hours at all.
 */
export function widestOpenWindow(
  businessHours: BusinessWeekHours
): { open: number; close: number } | null {
  if (!businessHours || typeof businessHours !== "object") return null;
  const windows = Object.values(businessHours)
    .map(openWindow)
    .filter((w): w is { open: number; close: number } => !!w);
  if (!windows.length) return null;
  return {
    open: Math.min(...windows.map(w => w.open)),
    close: Math.max(...windows.map(w => w.close))
  };
}


/**
 * MAY WE ASSERT THAT A CLOCK TIME FALLS INSIDE OUR OPEN HOURS?
 *
 * The hours-question doors don't just echo a time back as workable — they make a POSITIVE claim
 * about the store ("Saturday at 5:00 PM is during open hours"). Neither door checked anything
 * before saying it, and both are wrong in production:
 *
 *   +17169902571 (John Zimmerman, 2026-08-12; staff had to edit it out) — "what time are you guys
 *     open Intill 5pm ?" names NO day, so the label fell back to the literal string "that day" and
 *     the draft read "…Sat 9:00 AM–3:00 PM. that day at 5:00 PM is during open hours…" — a dangling
 *     reference, mid-message lowercase, claiming openness for a day nobody picked. On the Saturday
 *     named in that very sentence we shut at 3.
 *   "are you open saturday at 5pm?" — executed against the live config, today's code emits
 *     "Saturday at 5:00 PM is during open hours" while `mayStateTimeAsWorkable` says FALSE.
 *   "you open sunday at 11am?" — Sunday has no entry at all, and today's code still claims it.
 *
 * WHY THIS IS STRICTER THAN `mayStateTimeAsWorkable`. That guard answers "could this time work?",
 * so its documented fail direction is to STATE on anything unknown — an absent day is unknown
 * rather than closed, and a floating time is judged against ANY open day. Both readings are right
 * for an echo and wrong for an assertion: a claim we cannot substantiate must not be made at all.
 * So this one refuses unless the day is RESOLVED, has a POSITIVELY KNOWN window, and the time lands
 * inside it — delegating that last test to the invariant above so one window comparison governs
 * both, and leaving that invariant's own fail direction untouched for its other callers.
 *
 * FAIL DIRECTION: false ⇒ the caller says LESS (its no-time copy, or nothing). A refusal can only
 * ever remove a claim; it never asserts a closure, so it cannot turn the agent mute or wrong.
 */
export function mayClaimTimeIsDuringOpenHours(args: {
  dayKey: string | null | undefined;
  timeToken: string | null | undefined;
  businessHours: BusinessWeekHours;
}): boolean {
  const dayKey = String(args.dayKey ?? "").trim().toLowerCase();
  if (!dayKey) return false; // no day resolved => "that day" / "that time" refers to nothing
  const clock = parseTimeTokenToClock(args.timeToken);
  if (!clock) return false; // unreadable or ambiguous time => nothing to claim
  const hours = args.businessHours;
  if (!hours || typeof hours !== "object") return false;
  if (!openWindow((hours as any)[dayKey])) return false; // no entry / no usable window => unknown
  return mayStateTimeAsWorkable({ ...clock, businessHours: hours, dayKey });
}

/**
 * THE HOURS ANSWER ITSELF. Moved out of index.ts verbatim (same branch order, same wording) to sit
 * beside the hours it reads and the invariant that guards its tail below — reply COMPOSITION
 * belongs next to the policy it reads, and the handler keeps only the config fetch.
 *
 * The caller passes the day resolution (`resolveRequestedDay`) rather than the raw text, so the
 * day this names and the day the tail claims are one resolution, never two.
 */
export function buildBusinessHoursQuestionReplyText(args: {
  requestedDay: { day?: string | null; dayPhrase?: string | null };
  businessHours: BusinessWeekHours;
  country?: string | null;
}): string {
  const day = args.requestedDay?.day;
  const dayPhrase = args.requestedDay?.dayPhrase;
  if (day && dayPhrase) {
    const dayHours = (args.businessHours as any)?.[day];
    const open = parseClockMinutes(dayHours?.open);
    const close = parseClockMinutes(dayHours?.close);
    if (open != null && close != null) {
      return `Our hours ${dayPhrase} are ${formatClock(open)}–${formatClock(close)}.`;
    }
    return `We’re closed ${dayPhrase}.`;
  }
  const hoursLine = formatBusinessHoursForReply(args.businessHours as any, args.country ?? null);
  if (hoursLine) return `Our hours this week are ${hoursLine}.`;
  return "Our hours vary by day. What day are you thinking?";
}

/**
 * The appointment-context tail for the hours answer, gated by the claim guard above.
 *
 * Unclaimable ⇒ the hours line stands alone, which is byte-for-byte what staff sent by hand on the
 * turn that reported this (+17169902571). A closed-day reply is never decorated: the base line
 * already said we are shut, and a tail is only ever an ADDITION to it.
 */
export function businessHoursOpenClaimTail(args: {
  reply: string | null | undefined;
  dayKey: string | null | undefined;
  dayLabel: string | null | undefined;
  timeToken: string | null | undefined;
  timeLabel: string;
  businessHours: BusinessWeekHours;
}): string {
  const reply = String(args.reply ?? "").trim();
  if (!reply || /^we[’']?re closed\b/i.test(reply)) return reply;
  if (!args.dayLabel || !args.timeLabel) return reply;
  if (
    !mayClaimTimeIsDuringOpenHours({
      dayKey: args.dayKey,
      timeToken: args.timeToken,
      businessHours: args.businessHours
    })
  ) {
    return reply;
  }
  return `${reply} ${args.dayLabel} at ${args.timeLabel} is during open hours, but I still need to check appointment availability before locking it in.`;
}

/**
 * Did the form leave the time OPEN? ("", "anytime", "flexible", …) — i.e. there is no concrete time
 * to state, so nothing for the hours invariant to judge. Was a hand-maintained copy in BOTH
 * index.ts and routes/sendgridInbound.ts; it belongs beside the invariant that now reads it.
 */
export function isOpenPreferredTime(value: string | null | undefined): boolean {
  const raw = String(value ?? "").trim();
  return !raw || /^(any|anytime|flexible|open|no preference|n\/a|na)$/i.test(raw);
}

/** "8:00 Pm" -> "8:00 PM". The other half of the same mirrored pair. */
export function formatPreferredTimeForReply(value: string | null | undefined): string {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  return raw.replace(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i, (_m, hour, minute, meridiem) => {
    const suffix = String(meridiem).toUpperCase();
    return `${hour}${minute ? `:${minute}` : ""} ${suffix}`;
  });
}

/**
 * THE LEAD FORM'S OWN TIME, echoed back as a slot we promise to line up.
 *
 * `+16397209755` (lakshya, 2026-07-15, Room58 "Book test ride", ref 11632) is why these two exist.
 * The form carried `preferredDate: "7/22/2026"` / `preferredTime: "8:00 Pm"` and the ack read
 * "I have Wednesday, July 22 at 8:00 Pm noted. I'll confirm availability and get that lined up."
 * — SENT on SMS at 10:07 and again by email at 13:28. We close at 6. Nothing was misread: the
 * customer really did pick 8:00 PM on a web form that let them. The reply sites simply restated the
 * field verbatim, so the two guarded sites (`Got it — X can work`, `X should work. Want me to lock
 * that in?`) never saw it. Same invariant, third door.
 *
 * The tail for the "I have <date> [at <time>] noted" reply shape. Statable time => today's copy,
 * byte for byte. Positively shut => keep the date, drop the impossible time, and re-ask with the
 * real hours. No usable hours config => the plain re-ask, i.e. today's no-time copy.
 */
export function preferredDateTimeNotedTail(args: {
  dateLabel: string;
  preferredTime: string | null | undefined;
  businessHours: BusinessWeekHours;
}): string {
  const raw = String(args.preferredTime ?? "").trim();
  const time = isOpenPreferredTime(raw) ? "" : raw;
  if (time && mayStateTokenAsWorkable(time, args.businessHours)) {
    return `I have ${args.dateLabel} at ${time} noted. I’ll confirm availability and get that lined up.`;
  }
  const reAsk = (time ? openHoursReAskSentence(args.businessHours) : null) ?? "What time works best for you?";
  return `I have ${args.dateLabel} noted. ${reAsk}`;
}

/**
 * The same invariant for reply shapes that only INTERPOLATE the time and have no re-ask to offer
 * (the Jumpstart ack). Returns the time text when we may state it, "" when the store is positively
 * shut — so the clause degrades to the date-only wording that already exists beside it.
 */
export function statablePreferredTimeText(
  token: string | null | undefined,
  businessHours: BusinessWeekHours
): string {
  const raw = String(token ?? "").trim();
  if (!raw) return "";
  return mayStateTokenAsWorkable(raw, businessHours) ? raw : "";
}

/** Token-level convenience for the reply sites: unreadable/ambiguous tokens are never refused. */
export function mayStateTokenAsWorkable(
  token: string | null | undefined,
  businessHours: BusinessWeekHours,
  dayKey?: string | null
): boolean {
  const clock = parseTimeTokenToClock(token);
  if (!clock) return true;
  return mayStateTimeAsWorkable({ ...clock, businessHours, dayKey });
}

/**
 * The customer-facing hours line ("Mon-Fri 9:00 AM-6:00 PM, Sat 9:00 AM-3:00 PM"). Moved here
 * from index.ts with the guard: hours formatting and the hours invariant belong together.
 * Output is byte-identical to the old index-local version (its formatTime12h and formatClock agree
 * on every valid HH:MM).
 */
export function formatBusinessHoursForReply(
  hours?: Record<string, any> | null,
  country?: string | null
): string | null {
  if (!hours) return null;
  const dayOrder = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
  const entries = dayOrder
    .map(day => ({ day, open: hours?.[day]?.open, close: hours?.[day]?.close }))
    .filter(d => d.open && d.close);
  if (!entries.length) return null;

  const use12h = !country || ["us", "usa", "ca", "can", "canada"].includes(country.toLowerCase());

  const groups: Array<{ start: number; end: number; open: string; close: string }> = [];
  for (let i = 0; i < entries.length; i++) {
    const { open, close } = entries[i];
    const prev = groups[groups.length - 1];
    if (prev && prev.open === open && prev.close === close && prev.end === i - 1) {
      prev.end = i;
    } else {
      groups.push({ start: i, end: i, open, close });
    }
  }

  const label = (idx: number) =>
    entries[idx].day.slice(0, 3).replace(/^\w/, c => c.toUpperCase());
  return groups
    .map(g => {
      const dayLabel = g.start === g.end ? label(g.start) : `${label(g.start)}–${label(g.end)}`;
      const openM = parseClockMinutes(g.open);
      const open = use12h && openM != null ? formatClock(openM) : g.open;
      const closeM = parseClockMinutes(g.close);
      const close = use12h && closeM != null ? formatClock(closeM) : g.close;
      return `${dayLabel} ${open}–${close}`;
    })
    .join(", ");
}

