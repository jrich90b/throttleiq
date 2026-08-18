/**
 * WHAT A RETURNING CUSTOMER'S NEW THREAD REMEMBERS ABOUT THE LAST ONE.
 *
 * Joe, 2026-08-18: *"how are we going to handle leads that are closed that may re-engage to buy
 * another bike or trade theirs in… without starting a double thread? That may get a little
 * confusing."*
 *
 * THE ROUTING IS ALREADY RIGHT AND IS NOT CHANGED HERE. A sold/held thread that receives an
 * explicit buying signal opens a NEW journey thread (`resolveInboundConversationForSms`,
 * `sendgridInbound`), gated by the typed `parseJourneyIntentWithLLM` at explicitRequest +
 * confidence >= 0.68. Audited 2026-08-18: it has fired **4 times and was correct 4 times** (three
 * triggered by a fresh lead form, one by *"Do u by chance have any used street glides?"*). Two
 * threads is the right model — a finished sale and a new shopping trip run on different clocks
 * (post-sale owner sequence vs the sales chase), and merging them risks overwriting the completed
 * sale record, which has bitten us before (a second sold signal wiped `conv.sale` and replayed
 * post_sale from day one).
 *
 * WHAT WAS ACTUALLY BROKEN IS AMNESIA. Christopher Szczesny's new thread (`+17169400722::2`)
 * carried his salesperson and NOTHING else: no record that he bought a 2021 Road Glide Special
 * from Scott four days earlier, no link to the 209-message thread next to it. That is why the
 * second thread reads as a confusing duplicate rather than an obvious new deal — an operator filed
 * exactly that ("Why did this create a new thread? We've already been conversing with this
 * customer"). It is also why a trade-in re-engagement is the costliest case: the bike they would
 * trade is recorded on the OTHER thread.
 *
 * TWO-PATH PARITY IS THE OTHER HALF. The two creation sites had already drifted: the SMS path
 * carried `leadOwner` AND the lead profile, while the ADF path — which produced THREE of the four
 * splits — carried only `leadOwner`. One helper now owns the whole carry-over so they cannot
 * disagree again.
 *
 * This module writes no messages and sends nothing; it copies facts onto a thread at creation.
 * Pinned by `prior_journey_carryover:eval`.
 */

/** The previous journey, as much of it as is worth showing a human at a glance. */
export type PriorJourneyRecord = {
  /** The thread this customer's previous journey lives on, so the console can link to it. */
  conversationId: string;
  /** Why that thread ended — "sold" is the case this exists for. */
  closedReason?: string;
  soldAt?: string;
  /** What they bought, already assembled for display ("2021 Harley-Davidson FLTRXS Road Glide Special"). */
  label?: string;
  soldByName?: string;
  stockId?: string;
  vin?: string;
  /** How much conversation is on the other thread — the "we have talked before" signal. */
  messageCount?: number;
};

type PriorLike = {
  id?: string;
  status?: string | null;
  closedReason?: string | null;
  messages?: unknown;
  sale?: {
    soldAt?: string;
    soldByName?: string;
    stockId?: string;
    vin?: string;
    label?: string;
    year?: string;
    make?: string;
    model?: string;
    trim?: string;
  } | null;
};

/** Assemble a display label from the sale's parts when it carries no pre-built one. */
function resolveSaleLabel(sale: PriorLike["sale"]): string | undefined {
  const explicit = String(sale?.label ?? "").trim();
  if (explicit) return explicit;
  const parts = [sale?.year, sale?.make, sale?.model, sale?.trim]
    .map(v => String(v ?? "").trim())
    .filter(Boolean);
  return parts.length ? parts.join(" ") : undefined;
}

/**
 * The record to stamp on a NEW journey thread, or null when the previous one has nothing worth
 * carrying.
 *
 * FAIL DIRECTION: return null rather than a half-empty record. Everything this produces is shown to
 * staff and (next slice) handed to the drafter as fact, so an invented or blank "previous purchase"
 * is worse than none — it would have the agent thank someone for a bike they never bought. A thread
 * with no id, or one that is neither closed-sold nor carrying a sale, yields null.
 */
export function buildPriorJourneyRecord(prior: PriorLike | null | undefined): PriorJourneyRecord | null {
  const conversationId = String(prior?.id ?? "").trim();
  if (!conversationId) return null;
  const sale = prior?.sale ?? null;
  const closedReason = String(prior?.closedReason ?? "").trim();
  const soldAt = String(sale?.soldAt ?? "").trim();
  // Something must actually have happened on the prior thread. A thread merely closed as
  // "not_interested" is not a previous PURCHASE and must not be presented as one.
  if (!soldAt && closedReason.toLowerCase() !== "sold") return null;
  const messages = Array.isArray(prior?.messages) ? (prior?.messages as unknown[]) : [];
  const record: PriorJourneyRecord = { conversationId };
  if (closedReason) record.closedReason = closedReason;
  if (soldAt) record.soldAt = soldAt;
  const label = resolveSaleLabel(sale);
  if (label) record.label = label;
  const soldByName = String(sale?.soldByName ?? "").trim();
  if (soldByName) record.soldByName = soldByName;
  const stockId = String(sale?.stockId ?? "").trim();
  if (stockId) record.stockId = stockId;
  const vin = String(sale?.vin ?? "").trim();
  if (vin) record.vin = vin;
  if (messages.length) record.messageCount = messages.length;
  return record;
}

/**
 * Everything a NEW journey thread inherits from the one it grew out of, in ONE place so the SMS and
 * ADF creation sites cannot drift again (they already had).
 *
 * Deliberately NOT inherited: the sale itself, the cadence, the appointment, the todos and the
 * messages. Those belong to the completed deal. The new thread starts clean and merely REMEMBERS.
 */
export function applyPriorJourneyCarryOver(
  created: {
    leadOwner?: unknown;
    lead?: unknown;
    priorJourney?: PriorJourneyRecord | null;
    status?: string;
    closedAt?: string;
    closedReason?: string;
  },
  prior: (PriorLike & { leadOwner?: unknown; lead?: Record<string, unknown> | null }) | null | undefined
): void {
  if (!created) return;
  created.leadOwner = prior?.leadOwner ? { ...(prior.leadOwner as Record<string, unknown>) } : undefined;
  if (prior?.lead) {
    // The walk-in comment is about a visit to the OLD deal; carrying it would have the agent
    // reference a showroom conversation that belongs to a bike they already own.
    created.lead = {
      ...prior.lead,
      walkInComment: undefined,
      walkInCommentCapturedAt: undefined,
      walkInCommentUsedAt: undefined
    };
  }
  created.priorJourney = buildPriorJourneyRecord(prior);
  created.status = "open";
  created.closedAt = undefined;
  created.closedReason = undefined;
}
