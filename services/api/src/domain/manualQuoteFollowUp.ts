import {
  applyManualCadenceRestart,
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

  setFollowUpMode(conv, "active", "manual_quote_delivered");
  // Does this lead keep its place in the follow-up sequence? One referee decides for all three
  // manual-outbound restart lanes — see decideManualCadenceRestart in routeStateReducer.ts.
  applyManualCadenceRestart(conv, {
    context: "manual_quote_delivered",
    kind: "engaged",
    nowIso: updatedAt,
    timeZone: timezone
  });
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
