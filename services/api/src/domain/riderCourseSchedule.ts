/**
 * RIDER-COURSE CLASS SCHEDULE — per-class facts, and what to do when they go stale.
 *
 * THE PROBLEM (Joe, 2026-08-07). The school's enrollment record gives us the class DATE and nothing
 * else — no start time, no end time, no range location. Measured across every enrollment ADF in the
 * live store, the fields are: Enrollment Status, Course, Class Start Date, Payment Status, Accepted
 * Terms, Motivation, Riding History, Training Experience, Gender, Brand of Bike Owned, Future
 * Purchase Expectation/Brand. **A date, never a time.** So "what time does class start?" — the most
 * likely question an enrolled student asks — is unanswerable from anything we receive, and today the
 * agent answers course questions with the sign-up price.
 *
 * AND THE FACTS VARY BY CLASS. Joe: times "can vary by class". So does the range: the H-D listing
 * shows Maya's range at **Niagara Wheatfield High School, Sanborn NY** while the INITIAL meeting is
 * at the dealership. A single global answer is wrong for both.
 *
 * WHY A TABLE AND NOT A SCRAPE. The inventory catalog is not scraped — the website publishes an XML
 * feed built for it. The class schedule has no equivalent: it lives in a Harley-run JS app, and
 * americanharley-davidson.com returned 403 to every automated fetch attempted on 2026-08-07. A
 * screen-scraper against a human-facing page fails SILENTLY and keeps serving yesterday's times, and
 * the cost of that is a student arriving an hour late to a course they paid for. The listing shows
 * ~3 upcoming classes at a time, so the table is a few rows that change every few weeks.
 *
 * "WHAT IF IT CHANGES?" — the whole point of this module. Four defences, in order:
 *   1. **Rows expire by their own date.** A class in the past can never be quoted.
 *   2. **No matching row ⇒ hand off.** An unknown class is never answered from a neighbouring row.
 *   3. **A stale row STOPS ANSWERING.** If nobody has confirmed a row inside the staleness window,
 *      the agent hands off instead of asserting a time that may have moved. Silence plus a human is
 *      recoverable; a confidently wrong start time is not.
 *   4. **Missing fields never get filled in.** A row with a date but no times answers the location
 *      question and hands off the time question, rather than guessing.
 *
 * FAIL DIRECTION, everywhere: toward "a person will confirm". This module can only ever REPLACE a
 * hand-off with a fact it was given; it can never invent one.
 *
 * DETERMINISTIC ON PURPOSE, and allowed to be. Matching a student's own `Class Start Date` to a
 * configured row is structured extraction over two known fields — AGENTS.md's carve-out. Nothing
 * here reads customer prose; deciding that the customer ASKED about the schedule is the parser's
 * job (`enrolled_class_logistics`).
 *
 * Pinned by scripts/rider_course_schedule_eval.ts (ci:eval).
 */

/**
 * ONE SESSION — a single day of a class. Joe, 2026-08-07: class times "can vary by class", and they
 * vary WITHIN one too. A "New Rider Course - eCourse + Range" runs across days (the listing shows
 * Aug 22-23, Sat/Sun) and those days differ in BOTH hours and place: the initial meeting is at the
 * dealership, the range day is at Niagara Wheatfield High School. A single start/end/location per
 * class would be wrong for at least one of the days, which is exactly the kind of confident-and-wrong
 * answer this module exists to prevent.
 */
export type RiderCourseSession = {
  /** The day this session runs (e.g. "8/22/2026"). */
  date?: string | null;
  startTime?: string | null;
  endTime?: string | null;
  /** Where THIS day happens — the dealership, the range, wherever. */
  location?: string | null;
  /** Optional label for the day ("classroom", "range day 1"). */
  label?: string | null;
};

/** One upcoming class, as the dealer maintains it. */
export type RiderCourseClassRow = {
  /** The class START date — what the school's `Class Start Date` field carries (e.g. "8/15/2026"). */
  date?: string | null;
  /** Each day of the class, in order. The FIRST is where and when the student first shows up. */
  sessions?: ReadonlyArray<RiderCourseSession | null | undefined> | null;
  /** ISO stamp of when a human last confirmed this row. Absent = never confirmed = stale. */
  updatedAt?: string | null;
};

export type RiderCourseScheduleDecision = {
  kind: "answer" | "handoff";
  row: RiderCourseClassRow | null;
  /** Only the sessions carrying something usable — the caller states these and nothing else. */
  sessions: RiderCourseSession[];
  /** The day the student first shows up, when the table says so. */
  firstSession: RiderCourseSession | null;
  why: string;
};

/** Default staleness window. A row nobody has confirmed in this long stops answering. */
export const RIDER_COURSE_ROW_STALE_AFTER_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Normalise a date so "8/15/2026", "08/15/2026" and "2026-08-15" all compare equal. */
export function normalizeClassDate(value: string | null | undefined): string {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  const iso = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (iso) return `${Number(iso[2])}/${Number(iso[3])}/${Number(iso[1])}`;
  const us = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (us) {
    const year = Number(us[3]) < 100 ? 2000 + Number(us[3]) : Number(us[3]);
    return `${Number(us[1])}/${Number(us[2])}/${year}`;
  }
  return "";
}

/** Epoch ms for the START of that calendar day, or null when unreadable. */
function classDateMs(value: string): number | null {
  const parts = normalizeClassDate(value).split("/");
  if (parts.length !== 3) return null;
  const [m, d, y] = parts.map(Number);
  if (!Number.isFinite(m) || !Number.isFinite(d) || !Number.isFinite(y)) return null;
  const ms = Date.UTC(y, m - 1, d);
  return Number.isFinite(ms) ? ms : null;
}

const nonEmpty = (value: string | null | undefined): boolean => !!String(value ?? "").trim();

export function decideRiderCourseScheduleAnswer(input: {
  rows?: ReadonlyArray<RiderCourseClassRow | null | undefined> | null;
  /** The student's own class date, off their enrollment record. */
  studentClassDate?: string | null;
  nowMs: number;
  staleAfterDays?: number;
}): RiderCourseScheduleDecision {
  const none = (why: string): RiderCourseScheduleDecision => ({
    kind: "handoff",
    row: null,
    sessions: [],
    firstSession: null,
    why
  });

  const nowMs = Number(input?.nowMs);
  if (!Number.isFinite(nowMs)) return none("no usable clock");
  const rows = Array.isArray(input?.rows) ? input.rows : [];
  if (!rows.length) return none("no class schedule configured — a person confirms");

  const wanted = normalizeClassDate(input?.studentClassDate);
  if (!wanted) return none("no class date on this student's record — a person confirms");

  const match = rows.find(r => r && normalizeClassDate(r.date) === wanted) ?? null;
  // Defence 2: never answer from a neighbouring row.
  if (!match) return none("this student's class is not in the table — a person confirms");

  // Defence 1: a class that has already run is not a schedule question we answer.
  const dayMs = classDateMs(wanted);
  if (dayMs == null) return none("unreadable class date — a person confirms");
  if (nowMs >= dayMs + DAY_MS) return none("that class has already run — a person confirms");

  // Defence 3: an unconfirmed row stops answering rather than quoting a time that may have moved.
  const staleAfter = Number(input?.staleAfterDays ?? RIDER_COURSE_ROW_STALE_AFTER_DAYS);
  const windowDays = Number.isFinite(staleAfter) && staleAfter > 0 ? staleAfter : RIDER_COURSE_ROW_STALE_AFTER_DAYS;
  const confirmedMs = new Date(String(match.updatedAt ?? "")).getTime();
  if (!Number.isFinite(confirmedMs)) return none("row never confirmed by a human — a person confirms");
  if (nowMs - confirmedMs > windowDays * DAY_MS) {
    return none(`row not confirmed in ${windowDays} days — stale, so a person confirms`);
  }

  // Defence 4: keep only sessions carrying something worth saying, and never fill a blank.
  const rawSessions: RiderCourseSession[] = Array.isArray(match.sessions)
    ? (match.sessions.filter(Boolean) as RiderCourseSession[])
    : [];
  const sessions: RiderCourseSession[] = rawSessions.filter(
    (s: RiderCourseSession) => nonEmpty(s.startTime) || nonEmpty(s.location)
  );
  if (!sessions.length) return none("class has no usable session details — a person confirms");

  // The day they first show up: the session on the class start date, else the earliest we have.
  const dated: Array<{ s: RiderCourseSession; ms: number }> = sessions
    .map((s: RiderCourseSession) => ({ s, ms: classDateMs(String(s.date ?? "")) }))
    .filter((x): x is { s: RiderCourseSession; ms: number } => x.ms != null);
  dated.sort((a, b) => a.ms - b.ms);
  const firstSession: RiderCourseSession | null =
    dated.find(x => x.ms === dayMs)?.s ?? (dated.length ? dated[0].s : sessions[0]) ?? null;

  return {
    kind: "answer",
    row: match,
    sessions,
    firstSession: firstSession ?? null,
    why: "matched a confirmed class for this student, with per-day sessions"
  };
}
