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

/**
 * The returning-customer FACT handed to the drafter, or "none".
 *
 * Joe, 2026-08-18, on the same thread as the console pill: today the agent would greet a customer
 * with 209 messages and a bike in his garage as a stranger, because the new journey thread has no
 * outbound yet and the prompt's "First outbound message: yes" is the only signal it has.
 *
 * This states FACTS and two prohibitions; it deliberately writes no copy. The composer already has
 * the voice charter and Joe's rulings — what it lacked was the knowledge. The two prohibitions are
 * the ones a first-contact framing would otherwise produce: introducing yourself to someone you
 * sold a bike to, and asking what they ride when it is on the invoice.
 *
 * FAIL DIRECTION: "none" unless we hold a real sale record. Everything here is asserted to a
 * customer as true, so a blank or guessed purchase is worse than silence — it would have the agent
 * thank somebody for a bike they never bought. `buildPriorJourneyRecord` already refuses to build a
 * record without a sale; this refuses to render one without a bike NAME.
 */
export function buildPriorJourneyDraftFact(prior: PriorJourneyRecord | null | undefined): string {
  const label = String(prior?.label ?? "").trim();
  if (!prior || !label) return "none";
  const bits = [`This customer has ALREADY BOUGHT from us: ${label}`];
  const soldAt = String(prior.soldAt ?? "").trim();
  if (soldAt) {
    const ms = Date.parse(soldAt);
    if (Number.isFinite(ms)) bits.push(`purchased ${new Date(ms).toISOString().slice(0, 10)}`);
  }
  const seller = String(prior.soldByName ?? "").trim();
  if (seller) bits.push(`sold by ${seller}`);
  const count = typeof prior.messageCount === "number" ? prior.messageCount : 0;
  if (count > 0) bits.push(`${count} earlier messages on their previous thread`);
  return [
    bits.join("; ") + ".",
    "This is a RETURNING customer opening a NEW purchase or trade — not a first contact.",
    "Do NOT introduce yourself or the dealership as if you have never spoken.",
    "Do NOT ask what they currently ride: the bike above is theirs and is the likely trade-in."
  ].join(" ");
}

/**
 * BACKFILL: the re-engagement threads that already existed when the carry-over shipped.
 *
 * `applyPriorJourneyCarryOver` stamps `priorJourney` at thread CREATION, so it is forward-only —
 * the classic residue ([[forward-only-class-fixes-leave-permanent-residue]]). Measured 2026-08-18,
 * all FOUR live re-engagement threads read `priorJourney: MISSING`, including `+17169400722::2`,
 * the open one, whose base thread records a 2021 Road Glide Special. Without this the pill and the
 * drafter fact never appear for the customers who prompted the build.
 *
 * Pure SELECTION so the eval can execute it; the caller does the writing. Idempotent by
 * construction: a thread that already carries a record is skipped, so this converges to zero work
 * after the first boot and stays there (new threads are stamped at creation).
 *
 * HOW A THREAD FINDS ITS PREVIOUS ONE: the re-engagement id is `<base>::<n>` (`buildConversationId`),
 * so the base thread is the id before the separator. That is the same derivation the console shows,
 * and it needs no new index.
 *
 * FAIL DIRECTION: skip, never guess. No `::`, no base thread, a base thread with no sale, or a
 * record that `buildPriorJourneyRecord` refuses to build ⇒ the thread is left exactly as it is. A
 * missing pill is invisible; a pill claiming a bike somebody never bought is a lie to a customer.
 */
export function selectPriorJourneyBackfills<
  T extends { id?: string; priorJourney?: PriorJourneyRecord | null }
>(conversations: readonly T[]): Array<{ conversation: T; record: PriorJourneyRecord }> {
  const rows = Array.isArray(conversations) ? conversations : [];
  const byId = new Map<string, T>();
  for (const c of rows) {
    const id = String((c as PriorLike)?.id ?? "").trim();
    if (id) byId.set(id, c);
  }
  const out: Array<{ conversation: T; record: PriorJourneyRecord }> = [];
  for (const conv of rows) {
    if (conv?.priorJourney) continue; // already stamped — idempotent
    const id = String(conv?.id ?? "").trim();
    const sep = id.indexOf("::");
    if (sep <= 0) continue; // not a re-engagement thread
    const base = byId.get(id.slice(0, sep));
    if (!base) continue;
    const record = buildPriorJourneyRecord(base as PriorLike);
    if (!record) continue; // base thread records no sale — say nothing
    out.push({ conversation: conv, record });
  }
  return out;
}
