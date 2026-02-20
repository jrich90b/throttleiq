import { dayKey, type SchedulerConfig } from "./schedulerConfig.js";

type Slot = { salespersonId: string; calendarId: string; start: string; end: string };

function parseHM(hm: string) {
  const [h, m] = hm.split(":").map(Number);
  return { h, m };
}

function addMinutes(d: Date, mins: number) {
  return new Date(d.getTime() + mins * 60_000);
}

function clampStartTimes(cfg: SchedulerConfig, date: Date) {
  const dk = dayKey(date, cfg.timezone);
  const isSat = dk === "saturday";
  const win = isSat ? cfg.bookingWindows?.saturday : cfg.bookingWindows?.weekday;
  return (
    win ?? {
      earliestStart: "09:30",
      latestStart: "17:00"
    }
  );
}

function getOpenClose(cfg: SchedulerConfig, date: Date) {
  const dk = dayKey(date, cfg.timezone);
  const hours = cfg.businessHours?.[dk];
  return hours ?? { open: null, close: null };
}

function withinLeadTime(cfg: SchedulerConfig, slotStart: Date, now: Date) {
  const minStart = addMinutes(now, (cfg.minLeadTimeHours ?? 4) * 60);
  return slotStart.getTime() >= minStart.getTime();
}

function overlaps(aStart: Date, aEnd: Date, bStart: Date, bEnd: Date) {
  return aStart < bEnd && bStart < aEnd;
}

function getZonedParts(date: Date, timeZone: string) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  });
  const parts = fmt.formatToParts(date);
  const map: Record<string, string> = {};
  for (const p of parts) {
    if (p.type !== "literal") map[p.type] = p.value;
  }
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour: Number(map.hour),
    minute: Number(map.minute)
  };
}

export function localPartsToUtcDate(
  timeZone: string,
  requestedStartLocal: { year: number; month: number; day: number; hour24: number; minute: number }
) {
  const guess = new Date(
    Date.UTC(
      requestedStartLocal.year,
      requestedStartLocal.month - 1,
      requestedStartLocal.day,
      requestedStartLocal.hour24,
      requestedStartLocal.minute
    )
  );
  const guessedLocal = getZonedParts(guess, timeZone);
  const desiredLocalMs = Date.UTC(
    requestedStartLocal.year,
    requestedStartLocal.month - 1,
    requestedStartLocal.day,
    requestedStartLocal.hour24,
    requestedStartLocal.minute
  );
  const guessedLocalMs = Date.UTC(
    guessedLocal.year,
    guessedLocal.month - 1,
    guessedLocal.day,
    guessedLocal.hour,
    guessedLocal.minute
  );
  const diffMs = guessedLocalMs - desiredLocalMs;
  return new Date(guess.getTime() - diffMs);
}

export function expandBusyBlocks(busy: { start?: string; end?: string }[], padMinutes: number) {
  return busy
    .map(b => {
      const s = new Date(b.start!);
      const e = new Date(b.end!);
      return { start: addMinutes(s, -padMinutes), end: addMinutes(e, padMinutes) };
    })
    .filter(b => b.start && b.end);
}

export function generateCandidateSlots(cfg: SchedulerConfig, now: Date, durationMinutes: number, daysAhead = 14) {
  const slotsByDay: { dayStart: Date; candidates: { start: Date; end: Date }[] }[] = [];
  const baseParts = getZonedParts(now, cfg.timezone);
  const baseUtc = new Date(Date.UTC(baseParts.year, baseParts.month - 1, baseParts.day));

  for (let i = 0; i < daysAhead; i++) {
    const d = new Date(baseUtc);
    d.setUTCDate(baseUtc.getUTCDate() + i);
    const localDay = getZonedParts(d, cfg.timezone);
    const dayStart = localPartsToUtcDate(cfg.timezone, {
      year: localDay.year,
      month: localDay.month,
      day: localDay.day,
      hour24: 0,
      minute: 0
    });

    const { open, close } = getOpenClose(cfg, dayStart);
    if (!open || !close) continue; // closed day

    const win = clampStartTimes(cfg, dayStart);

    const openHM = parseHM(open);
    const closeHM = parseHM(close);
    const earliestHM = parseHM(win.earliestStart);
    const latestHM = parseHM(win.latestStart);

    const dayOpen = localPartsToUtcDate(cfg.timezone, {
      year: localDay.year,
      month: localDay.month,
      day: localDay.day,
      hour24: openHM.h,
      minute: openHM.m
    });
    const dayClose = localPartsToUtcDate(cfg.timezone, {
      year: localDay.year,
      month: localDay.month,
      day: localDay.day,
      hour24: closeHM.h,
      minute: closeHM.m
    });

    const earliest = localPartsToUtcDate(cfg.timezone, {
      year: localDay.year,
      month: localDay.month,
      day: localDay.day,
      hour24: earliestHM.h,
      minute: earliestHM.m
    });
    const latestStart = localPartsToUtcDate(cfg.timezone, {
      year: localDay.year,
      month: localDay.month,
      day: localDay.day,
      hour24: latestHM.h,
      minute: latestHM.m
    });

    // slot starts in 30-min increments
    const candidates: { start: Date; end: Date }[] = [];
    for (let t = earliest; t <= latestStart; t = addMinutes(t, 30)) {
      const end = addMinutes(t, durationMinutes);

      if (t < dayOpen) continue;
      if (end > dayClose) continue;
      if (!withinLeadTime(cfg, t, now)) continue;

      candidates.push({ start: new Date(t), end });
    }

    slotsByDay.push({ dayStart: new Date(dayStart), candidates });
  }

  return slotsByDay;
}

export function formatSlotLocal(iso: string, timeZone: string): string {
  const d = new Date(iso);
  return d.toLocaleString("en-US", {
    timeZone,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  });
}

export function findExactSlotForSalesperson(
  cfg: SchedulerConfig,
  salespersonId: string,
  calendarId: string,
  requestedStartLocal: { year: number; month: number; day: number; hour24: number; minute: number },
  durationMinutes: number,
  expandedBusy: { start: Date; end: Date }[]
): Slot | null {
  const start = localPartsToUtcDate(cfg.timezone, requestedStartLocal);
  const end = addMinutes(start, durationMinutes);

  const { open, close } = getOpenClose(cfg, start);
  if (!open || !close) return null;

  const win = clampStartTimes(cfg, start);
  const openHM = parseHM(open);
  const closeHM = parseHM(close);
  const earliestHM = parseHM(win.earliestStart);
  const latestHM = parseHM(win.latestStart);

  const localDay = getZonedParts(start, cfg.timezone);
  const dayOpen = localPartsToUtcDate(cfg.timezone, {
    year: localDay.year,
    month: localDay.month,
    day: localDay.day,
    hour24: openHM.h,
    minute: openHM.m
  });
  const dayClose = localPartsToUtcDate(cfg.timezone, {
    year: localDay.year,
    month: localDay.month,
    day: localDay.day,
    hour24: closeHM.h,
    minute: closeHM.m
  });
  const earliest = localPartsToUtcDate(cfg.timezone, {
    year: localDay.year,
    month: localDay.month,
    day: localDay.day,
    hour24: earliestHM.h,
    minute: earliestHM.m
  });
  const latestStart = localPartsToUtcDate(cfg.timezone, {
    year: localDay.year,
    month: localDay.month,
    day: localDay.day,
    hour24: latestHM.h,
    minute: latestHM.m
  });

  const slotStartLocal = localPartsToUtcDate(cfg.timezone, {
    year: localDay.year,
    month: localDay.month,
    day: localDay.day,
    hour24: requestedStartLocal.hour24,
    minute: requestedStartLocal.minute
  });

  if (slotStartLocal < dayOpen) return null;
  if (slotStartLocal > latestStart) return null;
  if (end > dayClose) return null;

  const now = new Date();
  if (!withinLeadTime(cfg, slotStartLocal, now)) return null;

  const blocked = expandedBusy.some(b => overlaps(slotStartLocal, end, b.start, b.end));
  if (blocked) return null;

  return {
    salespersonId,
    calendarId,
    start: slotStartLocal.toISOString(),
    end: end.toISOString()
  };
}

export function pickSlotsForSalesperson(
  cfg: SchedulerConfig,
  salespersonId: string,
  calendarId: string,
  candidatesByDay: ReturnType<typeof generateCandidateSlots>,
  expandedBusy: { start: Date; end: Date }[],
  limit = 3
): Slot[] {
  const results: Slot[] = [];
  const gapMinutes = cfg.minGapBetweenAppointmentsMinutes ?? 60;

  function isTooCloseToChosen(start: Date, end: Date): boolean {
    for (const r of results) {
      const rs = new Date(r.start);
      const re = new Date(r.end);

      const rsPad = addMinutes(rs, -gapMinutes);
      const rePad = addMinutes(re, gapMinutes);

      if (overlaps(start, end, rsPad, rePad)) return true;
    }
    return false;
  }

  for (const day of candidatesByDay) {
    for (const c of day.candidates) {
      if (results.length >= limit) return results;

      const blocked = expandedBusy.some(b => overlaps(c.start, c.end, b.start, b.end));
      if (blocked) continue;
      if (isTooCloseToChosen(c.start, c.end)) continue;

      results.push({
        salespersonId,
        calendarId,
        start: c.start.toISOString(),
        end: c.end.toISOString()
      });
    }
  }

  return results;
}
