/**
 * Reservation / pre-order intent (2026-06-15).
 *
 * Production miss (Nicholas Braun +17166286477): a customer asking to RESERVE a
 * limited-run 2026 Super Glide ("I would like to reserve one", "What do I have
 * to do to reserve one") had no matching intent, so it collapsed into the
 * inventory-WATCH path ("I'll let you know when it arrives") and a non-answer.
 *
 * Reservations at American Harley are STAFF-ONLY (Joe, 2026-06-15): the agent
 * never quotes deposit/allocation terms. It confirms the intent warmly and hands
 * off to the lead owner with a high-priority call task. This module owns the
 * deterministic safety-net detector + the safe handoff copy; the LLM
 * inbound_reply_action parser (`customer_reservation_request`) is the primary
 * path, this regex is the disabled/low-confidence fallback (routes to the SAME
 * handoff — an allowed manual-handoff fallback, never a semantic answer).
 */

// Narrow on purpose: "reserve/pre-order/hold one/deposit to hold" aimed at a
// UNIT, not "reserve a time/spot" (which is scheduling, owned elsewhere).
const RESERVE_TIME_RE = /\breserv\w*\s+(?:a\s+|an\s+|the\s+)?(?:time|spot|seat|slot|appointment|appt|table|date)\b/i;
const RESERVE_UNIT_RE =
  /\b(?:reserve|reserving|reservation|reserved|pre-?order|pre-?ordering)\b/i;
const HOLD_DEPOSIT_RE =
  /\b(?:put (?:a |down )?(?:a )?deposit|deposit (?:down )?to hold|(?:hold|lock) (?:one|it|mine|a build|a slot)(?: in)?)\b/i;

export function detectReservationRequestText(text: string): boolean {
  const t = String(text ?? "").toLowerCase();
  if (!t) return false;
  if (RESERVE_TIME_RE.test(t)) return false; // "reserve a time" is scheduling
  return RESERVE_UNIT_RE.test(t) || HOLD_DEPOSIT_RE.test(t);
}

export type ReservationHandoffArgs = {
  firstName?: string | null;
  ownerFirstName?: string | null;
  unitLabel?: string | null;
};

export function buildReservationHandoffReply(
  args: ReservationHandoffArgs
): { reply: string; todoSummary: string } {
  const name = String(args.firstName ?? "").trim() || "there";
  const owner = String(args.ownerFirstName ?? "").trim();
  const unit = String(args.unitLabel ?? "").trim() || "a unit";
  const who = owner || "someone on our team";
  // Staff-only handoff ack: warm, no deposit/allocation terms quoted, explicit
  // about who follows up (charter: handoffs to real staff are explicit). One
  // em-dash max; no banned filler.
  const reply = `Love it, ${name} — those limited runs move quick. I'll have ${who} reach out with exactly how to get one reserved for you.`;
  const todoSummary = `Customer wants to RESERVE ${unit} (limited run). Call with reservation steps.`;
  return { reply, todoSummary };
}
