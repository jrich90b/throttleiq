/**
 * Slot search + slot copy, moved out of index.ts alongside the accepted-visit arm
 * (schedulingAcceptance.ts) so every "what times can we offer?" answer lives together and is
 * testable without the handler. Pure moves — behavior is unchanged; see
 * `short_affirmative_acceptance:eval` for the day-scoped/next-available contrast.
 *
 * The two text predicates are INJECTED rather than moved: they chain into the wider
 * schedule-text stack in index.ts, and dragging that along would have made a behavior PR into a
 * refactor of it.
 */
import { generateCandidateSlots, pickSlotsForSalesperson, formatSlotLocal, expandBusyBlocks } from "./schedulerEngine.js";
import { dayKey } from "./schedulerConfig.js";
import { getAuthedCalendarClient, queryFreeBusy } from "./googleCalendar.js";

export type ScheduleWindowClauseDeps = {
  hasScheduleTimeSignal: (text: string | null | undefined) => boolean;
  hasRequestedScheduleWindowText: (text: string | null | undefined) => boolean;
};

export function buildRequestedDaySlotReply(slots: any[]): string | null {
  if (slots.length === 1) {
    return `I have ${slots[0].startLocal}. Does that work?`;
  }
  if (slots.length >= 2) {
    return `I have ${slots[0].startLocal} or ${slots[1].startLocal} — do either of those work?`;
  }
  return null;
}

export function extractRequestedScheduleWindowClauses(
  textRaw: string | null | undefined,
  deps: ScheduleWindowClauseDeps
): string[] {
  const text = String(textRaw ?? "").trim();
  if (!text) return [];
  const sentences = text
    .split(/(?<=[.!?])\s+/)
    .map(s => s.trim())
    .filter(Boolean);
  const sourceSentences = sentences.length ? sentences : [text];
  // today/tomorrow are real day anchors too — "tomorrow after 3" must resolve a window
  // clause (the Kody bound-offer path retries with the parser's normalized "tomorrow after 3"
  // phrase; without these tokens the clause extraction returned nothing and the turn
  // degraded to a vague deferral). parseRequestedDayTime already handles both tokens.
  const dayRe =
    /\b(today|tomorrow|monday|mon|tuesday|tue|tues|wednesday|wed|thursday|thu|thur|thurs|friday|fri|saturday|sat|sunday|sun)\b/gi;
  const clauses: string[] = [];
  for (const sentence of sourceSentences) {
    const matches = Array.from(sentence.matchAll(dayRe));
    if (!matches.length) continue;
    for (let i = 0; i < matches.length; i += 1) {
      const start = matches[i].index ?? 0;
      const end = i + 1 < matches.length ? matches[i + 1].index ?? sentence.length : sentence.length;
      const rawClause = sentence.slice(start, end).replace(/\bor\s*$/i, "").trim();
      const dayLabel = String(matches[i][0] ?? "").trim();
      const sentenceHasAllDay = /\b(?:free|available)?\s*all\s+day\b/i.test(sentence);
      const clause = sentenceHasAllDay && dayLabel ? `${dayLabel} any time` : rawClause;
      if (!clause) continue;
      if (!deps.hasScheduleTimeSignal(clause)) continue;
      if (!deps.hasRequestedScheduleWindowText(clause)) continue;
      if (!clauses.some(existing => existing.toLowerCase() === clause.toLowerCase())) {
        clauses.push(clause);
      }
    }
  }
  return clauses;
}

export async function findScheduleSlotsForRequestedDay(args: {
  cfg: any;
  preferredSalespeople: string[];
  conv: any;
  dayInfo: { day: string; date: Date };
  appointmentType: string;
}): Promise<any[]> {
  const cfg = args.cfg;
  const appointmentTypes = cfg.appointmentTypes ?? { inventory_visit: { durationMinutes: 60 } };
  const durationMinutes =
    appointmentTypes[args.appointmentType]?.durationMinutes ??
    appointmentTypes.inventory_visit?.durationMinutes ??
    60;
  const preferredSalespeople = args.preferredSalespeople;
  const salespeople = cfg.salespeople ?? [];
  if (!preferredSalespeople.length || !salespeople.length) return [];

  const candidatesByDay = generateCandidateSlots(cfg, new Date(), durationMinutes, 14);
  const requestedDayKey = dayKey(args.dayInfo.date, cfg.timezone);
  const dayPool = candidatesByDay.filter(d => dayKey(d.dayStart, cfg.timezone) === requestedDayKey);
  if (!dayPool.length) return [];

  let cal: any = null;
  try {
    cal = await getAuthedCalendarClient();
  } catch {
    cal = null;
  }

  const timeMin = new Date().toISOString();
  const timeMax = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();
  for (const salespersonId of preferredSalespeople) {
    const sp = salespeople.find((p: any) => p.id === salespersonId);
    if (!sp) continue;
    let expanded: { start: Date; end: Date }[] = [];
    if (cal) {
      try {
        const fb = await queryFreeBusy(cal, [sp.calendarId], timeMin, timeMax, cfg.timezone);
        const busy = (fb.calendars?.[sp.calendarId]?.busy ?? []) as any;
        expanded = expandBusyBlocks(busy, cfg.minGapBetweenAppointmentsMinutes ?? 60);
      } catch {
        expanded = [];
      }
    }
    const picked = pickSlotsForSalesperson(cfg, sp.id, sp.calendarId, dayPool, expanded, 2);
    if (picked.length > 0) {
      return picked.map((slot: any) => ({
        salespersonId: sp.id,
        salespersonName: sp.name,
        calendarId: sp.calendarId,
        start: slot.start,
        end: slot.end,
        startLocal: formatSlotLocal(slot.start, cfg.timezone),
        endLocal: formatSlotLocal(slot.end, cfg.timezone),
        appointmentType: args.appointmentType
      }));
    }
  }
  return [];
}
