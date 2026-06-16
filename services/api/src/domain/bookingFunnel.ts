/**
 * Booking funnel — pure, server-side measurement of the agent's core objective:
 * answer the customer, then move them to a booked appointment. Mirrors
 * pipelineFunnel.ts (pure functions over conversation state, testable without the API).
 *
 * Three things this answers that nothing else does today:
 *   1. OFFERED-A-TIME rate — of engaged leads, how often did the agent actually
 *      propose a time / visit / slots (not just answer the question and stop)?
 *   2. OFFER -> BOOK conversion — of leads offered a time, how many booked?
 *   3. WHERE LEADS LEAK — engaged-but-not-booked, bucketed by reason (never offered,
 *      offered-but-no-book, deferred by an active finance deal, handed to staff,
 *      waiting on inventory).
 *
 * Detecting "the agent offered a time" leans on STRUCTURED state first
 * (appointment / suggested slots / soft-visit window); the outbound-text regex is a
 * last-resort fallback that classifies OUR OWN sent copy — a measurement of what we
 * said, not comprehension of the customer (so it's allowed deterministic analysis).
 */
import { deriveLeadStage, type PipelineStage } from "./pipelineFunnel.js";

export type BookingLeak =
  | "booked" // converted to an appointment — not a leak
  | "closed_won" // sold — terminal success
  | "closed_lost" // closed without sale — terminal
  | "not_engaged" // no customer reply yet (ADF-only / silent)
  | "finance_pending" // booking deferred by an active finance/credit deal (by design)
  | "manual_handoff" // staff owns the conversation, not an agent-bookable leak
  | "holding_inventory" // waiting on stock — not ready to book
  | "offered_no_book" // agent offered a time, no booking resulted (the conversion leak)
  | "not_offered"; // engaged, but the agent never offered a time (the coverage leak)

export type BookingFunnelClass = {
  engaged: boolean;
  offered: boolean;
  booked: boolean;
  showed: boolean;
  stage: PipelineStage;
  leak: BookingLeak;
};

// Last-resort: did any of OUR OWN outbound propose a time / visit / slots?
const SCHEDULING_OFFER_OUTBOUND =
  /\b(what day and time|what time works|when works best|do any of these times|times work|line it up|set up a time|set a time|grab a time|book a time|find a time|come in|stop(?:ping)? by|swing by|schedule (?:a |an )?(?:visit|appointment|time)|available times|what day works)\b/i;

function hasCustomerInbound(conv: any): boolean {
  return (conv?.messages ?? []).some(
    (m: any) =>
      m?.direction === "in" &&
      (m?.provider === "twilio" || m?.provider === "web_widget") &&
      String(m?.body ?? "").trim()
  );
}

export function agentOfferedATime(conv: any): boolean {
  if (conv?.appointment?.bookedEventId) return true;
  const apptStatus = String(conv?.appointment?.status ?? "");
  if (apptStatus === "offered" || apptStatus === "booked" || apptStatus === "confirmed") return true;
  if (Array.isArray(conv?.scheduler?.lastSuggestedSlots) && conv.scheduler.lastSuggestedSlots.length > 0) return true;
  if (conv?.scheduleSoft) return true;
  return (conv?.messages ?? []).some(
    (m: any) =>
      m?.direction === "out" &&
      (m?.provider === "twilio" || m?.provider === "human" || m?.provider === "sendgrid" || m?.provider === "draft_ai") &&
      SCHEDULING_OFFER_OUTBOUND.test(String(m?.body ?? ""))
  );
}

function isBookedAppointment(conv: any, stage: PipelineStage): boolean {
  if (conv?.appointment?.bookedEventId) return true;
  const s = String(conv?.appointment?.status ?? "");
  if (s === "booked" || s === "confirmed") return true;
  return stage === "appointment" || stage === "showed";
}

export function classifyBookingFunnel(
  conv: any,
  opts: { openTodos?: Array<{ convId?: string; reason?: string; summary?: string }>; nowMs?: number } = {}
): BookingFunnelClass {
  const stage = deriveLeadStage(conv, opts);
  const engaged = hasCustomerInbound(conv);
  const offered = agentOfferedATime(conv);
  const booked = isBookedAppointment(conv, stage);
  const showed = stage === "showed";

  // Single mutually-exclusive bucket (terminal outcomes first, then the open leaks).
  let leak: BookingLeak;
  if (stage === "won") leak = "closed_won";
  else if (stage === "lost") leak = "closed_lost";
  else if (booked) leak = "booked";
  else if (!engaged) leak = "not_engaged";
  else if (stage === "finance") leak = "finance_pending";
  else if (String(conv?.followUp?.mode ?? "") === "manual_handoff") leak = "manual_handoff";
  else if (String(conv?.followUp?.mode ?? "") === "holding_inventory") leak = "holding_inventory";
  else if (offered) leak = "offered_no_book";
  else leak = "not_offered";

  return { engaged, offered, booked, showed, stage, leak };
}

export type BookingFunnelSummary = {
  population: number; // conversations in scope (window-filtered)
  engaged: number;
  offered: number;
  booked: number;
  showed: number;
  // Rates over ENGAGED leads (the meaningful denominator — they replied).
  offeredRatePct: number; // offered / engaged
  bookRatePct: number; // booked / engaged
  offerToBookPct: number; // booked / offered (the conversion the operator cares about)
  // Mutually-exclusive buckets (sum === population).
  leaks: Record<BookingLeak, number>;
};

export function buildBookingFunnelSummary(
  rows: BookingFunnelClass[]
): BookingFunnelSummary {
  const leaks: Record<BookingLeak, number> = {
    booked: 0,
    closed_won: 0,
    closed_lost: 0,
    not_engaged: 0,
    finance_pending: 0,
    manual_handoff: 0,
    holding_inventory: 0,
    offered_no_book: 0,
    not_offered: 0
  };
  let engaged = 0;
  let offered = 0;
  let booked = 0;
  let showed = 0;
  for (const r of rows) {
    leaks[r.leak] += 1;
    if (r.engaged) engaged += 1;
    if (r.offered && r.engaged) offered += 1;
    if (r.booked) booked += 1;
    if (r.showed) showed += 1;
  }
  const pct = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 1000) / 10 : 0);
  return {
    population: rows.length,
    engaged,
    offered,
    booked,
    showed,
    offeredRatePct: pct(offered, engaged),
    bookRatePct: pct(booked, engaged),
    offerToBookPct: pct(booked, offered),
    leaks
  };
}
