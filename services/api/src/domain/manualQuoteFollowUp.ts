import {
  computeFollowUpDueAt,
  FOLLOW_UP_DAY_OFFSETS,
  setFollowUpMode,
  type Conversation
} from "./conversationStore.js";
import { isManualOutboundQuoteDeliveredText } from "./manualCadenceContext.js";

const PRICE_CONFIRM_REASONS = new Set(["price_confirm", "room58_price_confirm"]);

export function isManualPriceConfirmHandoff(conv: Pick<Conversation, "followUp"> | null | undefined): boolean {
  const mode = String(conv?.followUp?.mode ?? "").trim().toLowerCase();
  const reason = String(conv?.followUp?.reason ?? "").trim().toLowerCase();
  return mode === "manual_handoff" && PRICE_CONFIRM_REASONS.has(reason);
}

export function activateManualQuoteDeliveredFollowUp(
  conv: Conversation,
  outboundBody: string | null | undefined,
  opts?: {
    channel?: "sms" | "email" | null;
    hasMedia?: boolean;
    nowIso?: string;
    timezone?: string;
  }
): boolean {
  if (!isManualPriceConfirmHandoff(conv)) return false;
  if (!isManualOutboundQuoteDeliveredText(outboundBody, { hasMedia: opts?.hasMedia })) return false;
  if (conv.status === "closed" || conv.followUpCadence?.kind === "post_sale") return false;
  if (String(conv.contactPreference ?? "").trim().toLowerCase() === "call_only") return false;

  const updatedAt = String(opts?.nowIso ?? "").trim() || new Date().toISOString();
  const timezone = String(opts?.timezone ?? "").trim() || "America/New_York";
  const existingCadence = conv.followUpCadence ?? null;
  const reuseExistingQuoteCadence =
    existingCadence?.status === "active" &&
    String(existingCadence?.contextTag ?? "").trim().toLowerCase() === "manual_quote_delivered";
  const anchorAt = reuseExistingQuoteCadence
    ? String(existingCadence?.anchorAt ?? "").trim() || updatedAt
    : updatedAt;

  setFollowUpMode(conv, "active", "manual_quote_delivered");
  conv.followUpCadence = {
    ...(existingCadence ?? {}),
    status: "active",
    anchorAt,
    nextDueAt:
      (reuseExistingQuoteCadence ? String(existingCadence?.nextDueAt ?? "").trim() : "") ||
      computeFollowUpDueAt(anchorAt, FOLLOW_UP_DAY_OFFSETS[0], timezone),
    stepIndex:
      reuseExistingQuoteCadence && Number.isFinite(Number(existingCadence?.stepIndex))
        ? Math.max(0, Number(existingCadence?.stepIndex))
        : 0,
    kind: "engaged",
    contextTag: "manual_quote_delivered",
    contextTagUpdatedAt: updatedAt,
    pausedUntil: undefined,
    pauseReason: undefined,
    stopReason: undefined,
    scheduleInviteCount: existingCadence?.scheduleInviteCount ?? 0,
    scheduleMuted: existingCadence?.scheduleMuted ?? false
  };
  conv.manualContext = {
    status: "inferred",
    contextTag: "manual_quote_delivered",
    followUpReason: "manual_quote_delivered",
    source: "manual_outbound",
    channel: opts?.channel ?? null,
    confidence: 0.88,
    reason: "manual_outbound_quote_delivered_from_price_confirm",
    updatedAt
  };
  return true;
}
