/**
 * "How far out is that?" — a pure reader for vague future timeframes ("next spring", "after the
 * holidays", "in a couple of months") used by the long-timeline cadence paths.
 *
 * Moved verbatim out of index.ts (2026-08-11) to fund the enough-info hand-off without raising the
 * size ceiling. It was already pure and already took its clock as a parameter — it reads no wall
 * clock of its own, which is what makes it safe to pin in an eval on any date.
 */
export function parseRelativeDurationCount(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const t = String(raw).trim().toLowerCase();
  const direct = Number(t);
  if (Number.isFinite(direct) && direct > 0) return direct;
  const wordMap: Record<string, number> = {
    one: 1,
    two: 2,
    three: 3,
    four: 4,
    five: 5,
    six: 6,
    seven: 7,
    eight: 8,
    nine: 9,
    ten: 10,
    couple: 2
  };
  return wordMap[t] ?? null;
}

export function parseRelativeDaysOrWeeks(text: string): { count: number; unit: "days" | "weeks" } | null {
  const t = String(text ?? "").toLowerCase();
  if (!t) return null;
  const m = t.match(
    /\b(?:in|for|about|around)\s+(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|couple)\s+(day|days|week|weeks|wk|wks)\b/
  );
  if (!m) return null;
  const count = parseRelativeDurationCount(m[1]);
  if (!count) return null;
  const unitRaw = m[2];
  const unit: "days" | "weeks" = /wk|week/.test(unitRaw) ? "weeks" : "days";
  return { count, unit };
}

export function computeMidWeekFollowUpDate(base: Date, weeksAhead: number): Date {
  const d = new Date(base);
  // Mid-week target (Wednesday 10:30) so "in N weeks" lands in the middle of that week.
  const daysFromMonday = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - daysFromMonday + weeksAhead * 7 + 2);
  d.setHours(10, 30, 0, 0);
  return d;
}

export function parseFutureTimeframe(text: string, base: Date): { label: string; until?: Date } | null {
  const t = text.toLowerCase();

  if (/\bnext\s+year\b/.test(t)) {
    const d = new Date(base.getFullYear() + 1, 0, 1, 9, 0, 0, 0);
    return { label: "next year", until: d };
  }

  if (/\bnext\s+season\b/.test(t)) {
    const d = new Date(base.getFullYear() + 1, 2, 1, 9, 0, 0, 0);
    return { label: "next season", until: d };
  }

  const relative = parseRelativeDaysOrWeeks(t);
  if (relative) {
    if (relative.unit === "days") {
      const days = relative.count;
      return {
        label: `in ${days} day${days === 1 ? "" : "s"}`,
        until: new Date(base.getTime() + days * 24 * 60 * 60 * 1000)
      };
    }
    const weeks = relative.count;
    return {
      label: `in ${weeks} week${weeks === 1 ? "" : "s"}`,
      until: computeMidWeekFollowUpDate(base, weeks)
    };
  }

  if (/\bnext week\b/.test(t)) {
    return { label: "next week", until: computeMidWeekFollowUpDate(base, 1) };
  }

  if (/\bnext month\b/.test(t)) {
    return { label: "next month", until: new Date(base.getTime() + 30 * 24 * 60 * 60 * 1000) };
  }

  const monthMap: Record<string, number> = {
    jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2, apr: 3, april: 3,
    may: 4, jun: 5, june: 5, jul: 6, july: 6, aug: 7, august: 7, sep: 8, sept: 8, september: 8,
    oct: 9, october: 9, nov: 10, november: 10, dec: 11, december: 11
  };
  const explicitMonthDay = t.match(
    /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s*(\d{4}))?\b/
  );
  if (explicitMonthDay) {
    const month = monthMap[explicitMonthDay[1]];
    const day = Number(explicitMonthDay[2]);
    if (Number.isFinite(month) && Number.isFinite(day) && day >= 1 && day <= 31) {
      const explicitYear = explicitMonthDay[3] ? Number(explicitMonthDay[3]) : null;
      let year = explicitYear ?? base.getFullYear();
      let d = new Date(year, month, day, 9, 0, 0, 0);
      if (!explicitYear && d.getTime() <= base.getTime()) {
        d = new Date(year + 1, month, day, 9, 0, 0, 0);
      }
      const label = `${explicitMonthDay[1]} ${day}`;
      return { label, until: d };
    }
  }
  const monthMatch = t.match(
    /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/
  );
  if (monthMatch) {
    const monthKey = monthMatch[1];
    if (monthKey === "may") {
      const explicitMonth =
        /\bmay\s+\d{1,2}(?:st|nd|rd|th)?\b/.test(t) ||
        /\b(in|this|next|on|by|during|around|early|late)\s+may\b/.test(t);
      if (!explicitMonth) return null;
    }
    const month = monthMap[monthKey];
    const year = base.getFullYear();
    let d = new Date(year, month, 1, 9, 0, 0, 0);
    if (d.getTime() <= base.getTime()) {
      // A bare mention of the current month means later this month, never the
      // same month next year (the Dominik 2027 parking class of bug).
      d = month === base.getMonth()
        ? new Date(year, month + 1, 0, 9, 0, 0, 0)
        : new Date(year + 1, month, 1, 9, 0, 0, 0);
    }
    return { label: monthKey, until: d };
  }

  const seasonMatch = t.match(/\b(this\s+|next\s+)?(spring|summer|fall|autumn|winter)\b/);
  if (seasonMatch) {
    const season = seasonMatch[2];
    const seasonMap: Record<string, number> = {
      spring: 2,
      summer: 5,
      fall: 8,
      autumn: 8,
      winter: 11
    };
    const month = seasonMap[season];
    const year = base.getFullYear();
    let d = new Date(year, month, 1, 9, 0, 0, 0);
    if (seasonMatch[1]?.trim().startsWith("next")) {
      d = new Date(year + 1, month, 1, 9, 0, 0, 0);
      return { label: `next ${season}`, until: d };
    }
    if (d.getTime() <= base.getTime()) d = new Date(year + 1, month, 1, 9, 0, 0, 0);
    return { label: seasonMatch[1] ? `this ${season}` : season, until: d };
  }

  return null;
}
