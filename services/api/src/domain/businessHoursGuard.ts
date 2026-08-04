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
  const window = widestOpenWindow(businessHours);
  if (!window) return preferred;
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

