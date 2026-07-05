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

export type PromotionSuppressionReason =
  | "recently_sold"
  | "on_hold"
  | "not_interested"
  | "wrong_number";

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
};

export type PromotionSuppressionOptions = {
  nowMs: number;
  /** Sold-within-this-window customers are excluded from promos. Default 90. */
  recentlySoldDays?: number;
};

export type PromotionSuppressionDecision = {
  suppressed: boolean;
  reason?: PromotionSuppressionReason;
  /** Short human string for the audience-preview UI, e.g. "sold 12 days ago". */
  detail?: string;
};

export const DEFAULT_RECENTLY_SOLD_DAYS = 90;

const DAY_MS = 86_400_000;

const HOLD_REASONS = new Set(["manual_hold", "unit_hold", "order_hold"]);

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

  // 1) Sold — the "just bought a bike" case.
  if (isSoldConversation(conv)) {
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
  //    promo target.
  if (isOnHoldConversation(conv)) {
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

  return { suppressed: false };
}

export const PROMOTION_SUPPRESSION_REASON_LABELS: Record<PromotionSuppressionReason, string> = {
  recently_sold: "Recently sold",
  on_hold: "Deal on hold",
  not_interested: "Not interested / opted out",
  wrong_number: "Wrong number"
};
