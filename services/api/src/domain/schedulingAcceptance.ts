/**
 * "Sounds great!" — answering a customer who accepted our own open scheduling ask.
 *
 * THE MEASURED PROBLEM (booking funnel, 30 days to 2026-08-04): of 238 engaged sales leads, 136
 * were offered a time and only 41 booked. The largest recoverable bucket was `accepted_no_time`
 * — 18 leads who AGREED to come in and never got a time pinned. Real threads: Maurice
 * (+17164289392) answered "what day and time works best?" with "Sounds great!" and got the
 * stand-down line; Clifton (+17164792868) answered "text me what day works" with "Sounds good"
 * and the agent pivoted to an unrelated bike. A bare affirmative matched the lexical short-ack
 * sign-off test (`isShortAckNoReplyText`) and the turn died there.
 *
 * THE ANSWER, not just the recognition. Re-asking "what day works?" is what produced the loop in
 * the first place, so once the customer has said yes we stop asking open questions and name
 * CONCRETE times off the calendar. That is the whole point of the arm: turn an agreement into a
 * choice between two specific slots.
 *
 * Recognition lives in the customer-ack parser (`accept_scheduling_ask`) and the route decision in
 * `decideSchedulingTurn` — this module owns only the slot search and the copy, so both are
 * testable without the calendar or the LLM.
 */
import {
  generateCandidateSlots,
  pickSlotsForSalesperson,
  formatSlotLocal,
  expandBusyBlocks
} from "./schedulerEngine.js";
import { getAuthedCalendarClient, queryFreeBusy } from "./googleCalendar.js";
import { decideSchedulingTurn } from "./routeStateReducer.js";

/**
 * Both inbound paths ask THIS, so neither can drift: does the turn get concrete times because the
 * customer accepted our open ask? It is `decideSchedulingTurn` underneath — the one referee — with
 * the inputs this question actually depends on.
 */
export function shouldOfferTimesAfterAcceptance(args: {
  action?: string | null;
  scheduleDialogState: boolean;
  scheduleOfferContext: boolean;
}): boolean {
  return (
    decideSchedulingTurn({
      customerAckActionAccepted: true,
      customerAckAction: args.action ?? null,
      appointmentTimingAccepted: false,
      parserScheduleStatusUpdate: false,
      pricingOrPaymentsIntent: false,
      scheduleDialogState: args.scheduleDialogState,
      scheduleOfferContext: args.scheduleOfferContext
    }).kind === "offer_times_after_acceptance"
  );
}

export type AcceptedVisitSlot = {
  salespersonId: string;
  salespersonName: string;
  calendarId: string;
  start: string;
  end: string;
  startLocal: string;
  endLocal: string;
  appointmentType: string;
};

/**
 * The next open slots for the lead's preferred salesperson, with NO day filter — the customer
 * accepted without naming a day, so "next available" is the question.
 *
 * `busyBySalesperson` is passed in rather than fetched so the caller owns the calendar IO (and so
 * this stays testable). A salesperson missing from the map is treated as fully open, which is the
 * same fail-direction the existing day-scoped search takes when the calendar is unreachable: we
 * would rather offer a time and have staff move it than go silent on a customer who said yes.
 */
export function pickNextAvailableVisitSlots(args: {
  cfg: any;
  preferredSalespeople: string[];
  appointmentType: string;
  busyBySalesperson?: Record<string, { start: Date; end: Date }[]>;
  now?: Date;
  limit?: number;
}): AcceptedVisitSlot[] {
  const cfg = args.cfg;
  if (!cfg) return [];
  const salespeople = cfg.salespeople ?? [];
  if (!args.preferredSalespeople.length || !salespeople.length) return [];

  const appointmentTypes = cfg.appointmentTypes ?? { inventory_visit: { durationMinutes: 60 } };
  const durationMinutes =
    appointmentTypes[args.appointmentType]?.durationMinutes ??
    appointmentTypes.inventory_visit?.durationMinutes ??
    60;
  const limit = args.limit ?? 2;
  const candidatesByDay = generateCandidateSlots(cfg, args.now ?? new Date(), durationMinutes, 14);
  if (!candidatesByDay.length) return [];

  for (const salespersonId of args.preferredSalespeople) {
    const sp = salespeople.find((p: any) => p.id === salespersonId);
    if (!sp) continue;
    const busy = args.busyBySalesperson?.[sp.calendarId] ?? [];
    const picked = pickSlotsForSalesperson(cfg, sp.id, sp.calendarId, candidatesByDay, busy, limit);
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

/**
 * The reply. Two concrete times beat one open question — that is the entire behavior change, so
 * this NEVER returns an open "what day works?" string: with no slots it returns null and the
 * caller keeps its existing path rather than repeating the question that stranded the lead.
 *
 * Voice: same shape as the existing `buildRequestedDaySlotReply` ("I have X or Y…"), with no
 * gratitude lead-in — the customer just said "Sounds great!", and echoing it back reads as filler.
 */
export function buildAcceptedVisitTimeOffer(
  slots: { startLocal?: string | null }[] | null | undefined
): string | null {
  const labels = (slots ?? [])
    .map(s => String(s?.startLocal ?? "").trim())
    .filter(Boolean);
  if (labels.length >= 2) {
    return `I have ${labels[0]} or ${labels[1]} open — which works better?`;
  }
  if (labels.length === 1) {
    return `I have ${labels[0]} open. Does that work?`;
  }
  return null;
}

/**
 * The whole arm in one call: read the calendar, pick the next open slots, write the copy.
 * Returns `{slots: [], reply: null}` whenever we cannot name a real time, and the caller keeps
 * its existing path — this never invents a slot and never falls back to re-asking the open
 * question, because re-asking is the failure this exists to remove.
 *
 * `calendarClientFactory` / `freeBusy` are injectable so the eval can drive the whole path
 * (busy calendar, empty calendar, unreachable calendar) without Google.
 */
export async function resolveAcceptedVisitTimeOffer(args: {
  cfg: any;
  preferredSalespeople: string[];
  appointmentType: string;
  now?: Date;
  limit?: number;
  calendarClientFactory?: () => Promise<any>;
  freeBusy?: typeof queryFreeBusy;
}): Promise<{ slots: AcceptedVisitSlot[]; reply: string | null }> {
  const cfg = args.cfg;
  if (!cfg) return { slots: [], reply: null };
  const salespeople = cfg.salespeople ?? [];
  const busyBySalesperson: Record<string, { start: Date; end: Date }[]> = {};

  const calendarIds = args.preferredSalespeople
    .map(id => salespeople.find((p: any) => p.id === id)?.calendarId)
    .filter((id: any): id is string => !!id);

  if (calendarIds.length) {
    let cal: any = null;
    try {
      cal = await (args.calendarClientFactory ?? getAuthedCalendarClient)();
    } catch {
      cal = null; // unreachable calendar => treat as open (see fail-direction note above)
    }
    if (cal) {
      const timeMin = new Date(args.now ?? new Date()).toISOString();
      const timeMax = new Date(
        (args.now ?? new Date()).getTime() + 14 * 24 * 60 * 60 * 1000
      ).toISOString();
      try {
        const fb = await (args.freeBusy ?? queryFreeBusy)(
          cal,
          calendarIds,
          timeMin,
          timeMax,
          cfg.timezone
        );
        for (const calendarId of calendarIds) {
          const busy = (fb?.calendars?.[calendarId]?.busy ?? []) as any;
          busyBySalesperson[calendarId] = expandBusyBlocks(
            busy,
            cfg.minGapBetweenAppointmentsMinutes ?? 60
          );
        }
      } catch {
        // leave busyBySalesperson empty — same fail-direction as above
      }
    }
  }

  const slots = pickNextAvailableVisitSlots({
    cfg,
    preferredSalespeople: args.preferredSalespeople,
    appointmentType: args.appointmentType,
    busyBySalesperson,
    now: args.now,
    limit: args.limit
  });
  return { slots, reply: buildAcceptedVisitTimeOffer(slots) };
}
