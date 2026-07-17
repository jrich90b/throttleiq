// Promotion-audience suppression — the deterministic side-effect gate that keeps
// bulk promotions (SMS/email broadcasts) away from customers who should not get
// a sales pitch: someone who just bought, a deal on hold (deposit/unit on
// order), a lead closed as not-interested/opt-out, or a wrong number.
//
// This reads OUR OWN persisted state fields (status/closedReason/sale/hold/
// cadence reasons — all set by staff actions or centralized close/hold flows),
// NOT customer text, so deterministic matching is the correct tool here
// (AGENTS.md: deterministic for side effects + invariant guards).
//
// Fail direction: when a sold signal exists but the date is unknowable, we
// SUPPRESS (fail toward not-spamming a buyer, never toward sending). Skipping a
// promo is recoverable; texting "come buy a bike!" to last week's buyer is not.
//
// EVENT vs PROMOTION (Joe ruling 2026-07-16). A dealer_event blast ("bike night",
// "open house") is an invitation, not a pitch — it SHOULD reach a recent buyer, a
// deal on hold, and an in-play lead. So an event passes suppressDealStates=false +
// suppressEngagedLeads=false and only the do-not-contact states below still bite.
// A promotion ("$1,000 customer cash") passes both true. The two states that ALWAYS
// suppress, on either kind, are the suppressed-list equivalents: not_interested/
// opt-out and wrong_number — those aren't "in play", they're "do not text".

export type PromotionSuppressionReason =
  | "recently_sold"
  | "on_hold"
  | "not_interested"
  | "wrong_number"
  | "booked_appointment"
  | "active_conversation"
  | "active_deal";

export type PromotionAudienceConversation = {
  status?: string | null;
  closedAt?: string | null;
  closedReason?: string | null;
  sale?: { soldAt?: string | null } | null;
  hold?: unknown;
  followUp?: { reason?: string | null } | null;
  followUpCadence?: {
    kind?: string | null;
    pauseReason?: string | null;
    stopReason?: string | null;
  } | null;
  // Engagement signals (only read when suppressEngagedLeads is on — i.e. a PROMOTION blast).
  appointment?: { status?: string | null; whenIso?: string | null; bookedEventId?: string | null } | null;
  classification?: { bucket?: string | null } | null;
  /** Most recent CUSTOMER (inbound) message ISO — the caller derives it from conv.messages. */
  lastInboundAt?: string | null;
};

export type PromotionSuppressionOptions = {
  nowMs: number;
  /** Sold-within-this-window customers are excluded from promos. Default 90. */
  recentlySoldDays?: number;
  /**
   * Deal-state suppression — recently_sold + on_hold. True for a PROMOTION (don't pitch a bike to
   * someone who just bought one / has a deposit down). An EVENT blast passes FALSE: a bike-night
   * invite SHOULD reach a recent buyer and a deal on hold (Joe ruling 2026-07-16). Defaults TRUE so
   * every existing caller keeps its exact behavior.
   */
  suppressDealStates?: boolean;
  /**
   * Engagement-based suppression — skip a PROMOTION blast to a lead who is "in play": a booked
   * appointment, an active back-and-forth, or a deal/trade in progress. Applies to promotions ONLY;
   * an EVENT blast (dealer_event) still reaches these leads, so the caller passes false for events.
   * Default false so existing (non-campaign / event) callers keep their exact behavior.
   */
  suppressEngagedLeads?: boolean;
  /** "Active back-and-forth" window: a customer inbound within this many days = engaged. Default 7. */
  activeConversationDays?: number;
};

export type PromotionSuppressionDecision = {
  suppressed: boolean;
  reason?: PromotionSuppressionReason;
  /** Short human string for the audience-preview UI, e.g. "sold 12 days ago". */
  detail?: string;
};

export const DEFAULT_RECENTLY_SOLD_DAYS = 90;
export const DEFAULT_ACTIVE_CONVERSATION_DAYS = 7;

const DAY_MS = 86_400_000;

const HOLD_REASONS = new Set(["manual_hold", "unit_hold", "order_hold"]);

// A confirmed/booked appointment that is still upcoming — or ended within the last 2 days (they may
// have just attended) — means the lead is scheduled to talk to us; a mass promo lands as noise.
const APPOINTMENT_RECENT_GRACE_MS = 2 * DAY_MS;

function hasUpcomingBookedAppointment(
  conv: PromotionAudienceConversation,
  nowMs: number
): boolean {
  const appt = conv.appointment;
  if (!appt) return false;
  const status = String(appt.status ?? "").trim().toLowerCase();
  const booked = !!String(appt.bookedEventId ?? "").trim() || status === "confirmed" || status === "booked";
  if (!booked) return false;
  const whenMs = parseMs(appt.whenIso);
  // Booked but no readable time → fail toward suppressing (an appointment exists).
  if (whenMs == null) return true;
  return whenMs >= nowMs - APPOINTMENT_RECENT_GRACE_MS;
}

// "Mid trade or deal": a deal actively in progress (deposit/payoff/insurance/delivery →
// followUp.reason==="in_process_deal") OR an open trade-in/sell lead (they're selling, not shopping).
function hasActiveDealOrTrade(conv: PromotionAudienceConversation): boolean {
  if (String(conv.followUp?.reason ?? "").trim().toLowerCase() === "in_process_deal") return true;
  const bucket = String(conv.classification?.bucket ?? "").trim().toLowerCase();
  const status = String(conv.status ?? "").trim().toLowerCase();
  return bucket === "trade_in_sell" && status !== "closed";
}

function parseMs(value: unknown): number | null {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const ms = new Date(raw).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function isSoldConversation(conv: PromotionAudienceConversation): boolean {
  if (conv.sale?.soldAt) return true;
  if (String(conv.followUpCadence?.kind ?? "").trim().toLowerCase() === "post_sale") return true;
  const status = String(conv.status ?? "").trim().toLowerCase();
  const closedReason = String(conv.closedReason ?? "").trim().toLowerCase();
  return status === "closed" && /\bsold\b/.test(closedReason);
}

function isOnHoldConversation(conv: PromotionAudienceConversation): boolean {
  return (
    HOLD_REASONS.has(String(conv.followUpCadence?.pauseReason ?? "")) ||
    HOLD_REASONS.has(String(conv.followUpCadence?.stopReason ?? "")) ||
    HOLD_REASONS.has(String(conv.followUp?.reason ?? "")) ||
    !!conv.hold
  );
}

export function evaluatePromotionSuppression(
  conv: PromotionAudienceConversation | null | undefined,
  opts: PromotionSuppressionOptions
): PromotionSuppressionDecision {
  if (!conv) return { suppressed: false };

  const recentlySoldDays =
    Number.isFinite(opts.recentlySoldDays) && (opts.recentlySoldDays as number) >= 0
      ? (opts.recentlySoldDays as number)
      : DEFAULT_RECENTLY_SOLD_DAYS;
  // Deal states bite on a promotion (and on every legacy caller); an EVENT invite reaches them.
  const suppressDealStates = opts.suppressDealStates !== false;

  // 1) Sold — the "just bought a bike" case.
  if (suppressDealStates && isSoldConversation(conv)) {
    const soldMs = parseMs(conv.sale?.soldAt) ?? parseMs(conv.closedAt);
    if (soldMs == null) {
      // Sold signal without a usable date: fail toward suppressing.
      return { suppressed: true, reason: "recently_sold", detail: "sold (date unknown)" };
    }
    const daysAgo = Math.max(0, Math.floor((opts.nowMs - soldMs) / DAY_MS));
    if (daysAgo <= recentlySoldDays) {
      return {
        suppressed: true,
        reason: "recently_sold",
        detail: daysAgo === 0 ? "sold today" : `sold ${daysAgo}d ago`
      };
    }
    // Past the window: a prior buyer is a legitimate promo audience again.
    return { suppressed: false };
  }

  // 2) Deal on hold — deposit down / unit on order; they're mid-purchase, not a
  //    promo target. (An event invite still reaches them.)
  if (suppressDealStates && isOnHoldConversation(conv)) {
    return { suppressed: true, reason: "on_hold", detail: "deal on hold" };
  }

  // 3) Closed for a reason that means "do not pitch me": not interested,
  //    opt-out (belt-and-suspenders with the suppression list), wrong number.
  const status = String(conv.status ?? "").trim().toLowerCase();
  if (status === "closed") {
    const closedReason = String(conv.closedReason ?? "").trim().toLowerCase();
    if (/wrong[\s_-]?(number|contact)/.test(closedReason)) {
      return { suppressed: true, reason: "wrong_number", detail: "closed: wrong number" };
    }
    if (/not[\s_-]?interested/.test(closedReason) || /opt[\s_-]?out/.test(closedReason)) {
      return { suppressed: true, reason: "not_interested", detail: `closed: ${closedReason}` };
    }
  }

  // 4) Engagement-based suppression — PROMOTION blasts only (an event blast reaches these leads).
  //    A lead who is "in play" — booked appointment, active back-and-forth, or a deal/trade in
  //    progress — should not get a generic promo mid-engagement (Joe ruling 2026-07-16). Reads our
  //    own persisted state (appointment / classification / last inbound), so deterministic is correct.
  if (opts.suppressEngagedLeads) {
    const activeDays =
      Number.isFinite(opts.activeConversationDays) && (opts.activeConversationDays as number) >= 0
        ? (opts.activeConversationDays as number)
        : DEFAULT_ACTIVE_CONVERSATION_DAYS;

    if (hasUpcomingBookedAppointment(conv, opts.nowMs)) {
      return { suppressed: true, reason: "booked_appointment", detail: "has a booked appointment" };
    }
    // Active back-and-forth = the CUSTOMER replied to us within the window (their inbound, not our
    // cadence) — so a dormant lead we've merely been nudging still gets the promo.
    const lastInboundMs = parseMs(conv.lastInboundAt);
    if (lastInboundMs != null && opts.nowMs - lastInboundMs <= activeDays * DAY_MS) {
      const daysAgo = Math.max(0, Math.floor((opts.nowMs - lastInboundMs) / DAY_MS));
      return {
        suppressed: true,
        reason: "active_conversation",
        detail: daysAgo === 0 ? "replied today" : `replied ${daysAgo}d ago`
      };
    }
    if (hasActiveDealOrTrade(conv)) {
      return { suppressed: true, reason: "active_deal", detail: "deal or trade in progress" };
    }
  }

  return { suppressed: false };
}

export const PROMOTION_SUPPRESSION_REASON_LABELS: Record<PromotionSuppressionReason, string> = {
  recently_sold: "Recently sold",
  on_hold: "Deal on hold",
  not_interested: "Not interested / opted out",
  wrong_number: "Wrong number",
  booked_appointment: "Has a booked appointment",
  active_conversation: "In an active conversation",
  active_deal: "Deal or trade in progress"
};
