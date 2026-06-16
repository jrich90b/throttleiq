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
  | "not_offered" // engaged, but the agent never offered a time (the coverage leak)
  | "not_sales"; // NOT a sales-intent lead — must never be asked to book (ride challenge, event RSVP, rental, hiring, rider course). Excluded from the funnel.

export type BookingFunnelClass = {
  salesIntent: boolean;
  engaged: boolean;
  offered: boolean;
  booked: boolean;
  showed: boolean;
  stage: PipelineStage;
  leak: BookingLeak;
};

// Is this lead actually shopping for a bike (so "answer -> offer a time" applies), or a
// non-sales contact that must NEVER be asked to book a sales appointment? Non-sales =
// Ride Challenge entry, event RSVP, rental, hiring/careers, rider-course question,
// SERVICE or PARTS request, a non-sales text-widget inquiry (which classifies as
// service/parts), or a Dealer Lead App demo-ride that ended in NO PURCHASE
// (followUp.reason "dealer_ride_no_purchase"/"dealer_ride_lost" — they already came in
// and passed, so don't push another sales appointment).
//
// Keyed on the system's OWN structured classification (classification.bucket/cta), the
// handler-set followUp.reason, and the structured ADF lead source — NOT free customer text
// (so it stays inside the "structured extraction is allowed" lane). High-precision exclusion:
// a misclassification only drops a lead from the metric (under-count), never a customer reply.
// Caveat: an RSVP/challenge/no-purchase lead who later genuinely shops may stay tagged
// non-sales and be undercounted — acceptable for a metric; revisit if the volume matters.
const NON_SALES_BUCKET = /^(event_promo|service|parts)$/i;
const NON_SALES_FOLLOWUP_REASON =
  /ride_challenge|hiring_manager|rider_course|eagle.?rider|rental|service_request|service_dept|parts_request|parts_dept|dealer_ride_no_purchase|dealer_ride_lost/i;
const NON_SALES_SOURCE =
  /ride challenge|event rsvp|national event|rolling rsvp|eagle.?rider|careers|hiring|service department|parts department/i;

export function isSalesIntentLead(conv: any): boolean {
  const cls = conv?.classification ?? {};
  const bucket = String(cls.bucket ?? "").toLowerCase();
  const cta = String(cls.cta ?? "").toLowerCase();
  if (NON_SALES_BUCKET.test(bucket) || cta === "event_rsvp") return false; // event RSVP / service / parts
  if (NON_SALES_FOLLOWUP_REASON.test(String(conv?.followUp?.reason ?? ""))) return false; // challenge / hiring / rider course / rental / DLA no-purchase
  if (NON_SALES_SOURCE.test(String(conv?.lead?.source ?? ""))) return false;
  return true;
}

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
  const salesIntent = isSalesIntentLead(conv);
  const engaged = hasCustomerInbound(conv);
  const offered = agentOfferedATime(conv);
  const booked = isBookedAppointment(conv, stage);
  const showed = stage === "showed";

  // Single mutually-exclusive bucket. Non-sales leads are filtered out FIRST — they must
  // never be asked to book, so they don't count as a leak. Then terminal outcomes, then the
  // open leaks.
  let leak: BookingLeak;
  if (!salesIntent) leak = "not_sales";
  else if (stage === "won") leak = "closed_won";
  else if (stage === "lost") leak = "closed_lost";
  else if (booked) leak = "booked";
  else if (!engaged) leak = "not_engaged";
  else if (stage === "finance") leak = "finance_pending";
  else if (String(conv?.followUp?.mode ?? "") === "manual_handoff") leak = "manual_handoff";
  else if (String(conv?.followUp?.mode ?? "") === "holding_inventory") leak = "holding_inventory";
  else if (offered) leak = "offered_no_book";
  else leak = "not_offered";

  return { salesIntent, engaged, offered, booked, showed, stage, leak };
}

export type BookingFunnelSummary = {
  population: number; // all conversations in scope (window-filtered)
  notSales: number; // excluded — never asked to book (ride challenge / RSVP / rental / hiring / …)
  salesPopulation: number; // population - notSales
  engaged: number; // SALES-intent leads where the customer replied (the funnel denominator)
  offered: number;
  booked: number;
  showed: number;
  // Rates over SALES-intent ENGAGED leads (the meaningful denominator — they replied AND want a bike).
  offeredRatePct: number; // offered / engaged
  bookRatePct: number; // booked / engaged
  offerToBookPct: number; // booked / offered (the conversion the operator cares about)
  // Mutually-exclusive buckets (sum === population). not_sales holds the excluded leads.
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
    not_offered: 0,
    not_sales: 0
  };
  let notSales = 0;
  let engaged = 0;
  let offered = 0;
  let booked = 0;
  let showed = 0;
  for (const r of rows) {
    leaks[r.leak] += 1;
    if (!r.salesIntent) {
      notSales += 1;
      continue; // non-sales leads never count toward the offer/book funnel
    }
    if (r.engaged) engaged += 1;
    if (r.offered && r.engaged) offered += 1;
    if (r.booked) booked += 1;
    if (r.showed) showed += 1;
  }
  const pct = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 1000) / 10 : 0);
  return {
    population: rows.length,
    notSales,
    salesPopulation: rows.length - notSales,
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
