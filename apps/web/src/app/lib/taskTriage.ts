// Shared task/follow-up triage helpers — the one place that decides "how urgent
// is this task right now". Used by the side-rail badge, the Task Inbox buckets,
// and the conversation-list due chips so all three agree on overdue/today.

export type DueBucket = "overdue" | "today" | "this_week" | "later" | "no_date";

type TaskLike = {
  taskClass?: string | null;
  dueAt?: string | null;
  reminderAt?: string | null;
  appointmentWhenIso?: string | null;
};

const DAY_MS = 86_400_000;

function parseMs(value: unknown): number | null {
  const t = new Date(String(value ?? "").trim()).getTime();
  return Number.isFinite(t) ? t : null;
}

// Parse a date string ONLY when it yields a plausible task date. Guards against V8's
// year-less parse quirk: `new Date("Thu, Jul 2, 9:00 AM")` (a summary-derived label with no
// year) silently parses to the year 2001, which rendered a task as "9130 days ago" in the
// Task Inbox (Henry Cole, +17168618786, operator-reported 2026-07-01). A label that parses
// outside the sane window is a DISPLAY STRING, not a date — callers should fall back to
// showing it verbatim (or nothing), never do relative-date math on it.
export function parseSaneTaskDateMs(value: unknown, nowMs = Date.now()): number | null {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const t = new Date(raw).getTime();
  if (!Number.isFinite(t)) return null;
  const year = new Date(t).getFullYear();
  const nowYear = new Date(nowMs).getFullYear();
  // Anything before 2015 is presumed a year-less/garbage parse (the store predates nothing
  // older); allow 5 years of future scheduling headroom.
  if (year < 2015 || year > nowYear + 5) return null;
  return t;
}

// The single timestamp a task is sorted/triaged by. An appointment is anchored
// to its event time; everything else to its due time, then its reminder time.
export function taskEffectiveDueMs(todo: TaskLike | null | undefined): number | null {
  if (!todo) return null;
  const cls = String(todo.taskClass ?? "").toLowerCase();
  const appt = parseMs(todo.appointmentWhenIso);
  const due = parseMs(todo.dueAt);
  const reminder = parseMs(todo.reminderAt);
  if (cls === "appointment" && appt != null) return appt;
  if (due != null) return due;
  if (reminder != null) return reminder;
  if (appt != null) return appt;
  return null;
}

export function dueBucketFor(todo: TaskLike | null | undefined, nowMs: number): DueBucket {
  const due = taskEffectiveDueMs(todo);
  if (due == null) return "no_date";
  const now = new Date(nowMs);
  const endToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999).getTime();
  const endWeek = endToday + 7 * DAY_MS;
  if (due < nowMs) return "overdue";
  if (due <= endToday) return "today";
  if (due <= endWeek) return "this_week";
  return "later";
}

export const DUE_BUCKET_ORDER: DueBucket[] = ["overdue", "today", "this_week", "later", "no_date"];

export function dueBucketRank(bucket: DueBucket): number {
  const idx = DUE_BUCKET_ORDER.indexOf(bucket);
  return idx < 0 ? DUE_BUCKET_ORDER.length : idx;
}

export function dueBucketLabel(bucket: DueBucket): string {
  switch (bucket) {
    case "overdue":
      return "Overdue";
    case "today":
      return "Due today";
    case "this_week":
      return "This week";
    case "later":
      return "Later";
    default:
      return "No date";
  }
}

// Compact, human relative label for a chip: "3d ago", "yesterday", "today 2:30 PM",
// "tomorrow", "Thu", "Aug 4". Past-but-earlier-today reads as the bare time.
export function relativeDueLabel(dueMs: number, nowMs: number): string {
  const now = new Date(nowMs);
  const due = new Date(dueMs);
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startDue = new Date(due.getFullYear(), due.getMonth(), due.getDate()).getTime();
  const dayDiff = Math.round((startDue - startToday) / DAY_MS);
  const timeStr = due.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (dayDiff === 0) return dueMs < nowMs ? timeStr : `today ${timeStr}`;
  if (dayDiff === -1) return "yesterday";
  if (dayDiff < -1) return `${Math.abs(dayDiff)}d ago`;
  if (dayDiff === 1) return `tomorrow ${timeStr}`;
  if (dayDiff >= 2 && dayDiff <= 6) return due.toLocaleDateString([], { weekday: "short" });
  return due.toLocaleDateString([], { month: "short", day: "numeric" });
}

export type TriageCounts = { overdue: number; today: number; attention: number };

// Counts for the side-rail badge and the inbox "needs you today" strip. Counts
// tasks (not customers) so the badge tracks real workload.
export function summarizeTriage(todos: TaskLike[] | null | undefined, nowMs: number): TriageCounts {
  let overdue = 0;
  let today = 0;
  for (const t of todos ?? []) {
    const bucket = dueBucketFor(t, nowMs);
    if (bucket === "overdue") overdue += 1;
    else if (bucket === "today") today += 1;
  }
  return { overdue, today, attention: overdue + today };
}
