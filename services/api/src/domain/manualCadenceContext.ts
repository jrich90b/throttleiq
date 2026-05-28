export type ManualOutboundCadenceContext =
  | {
      contextTag: "seller_photo_details_request";
      followUpReason: "seller_photo_details_request";
      confidence: number;
      reason: string;
    }
  | {
      contextTag: "manual_context_needed";
      followUpReason: "manual_context_needed";
      confidence: number;
      reason: string;
    };

function normalizeManualContextText(value: string | null | undefined): string {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[’]/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

export function isSparseManualConversationContext(conv: any): boolean {
  const leadSource = String(conv?.lead?.source ?? conv?.leadSource ?? "").trim();
  const bucket = String(conv?.classification?.bucket ?? "").trim();
  const cta = String(conv?.classification?.cta ?? "").trim();
  const inquiry = String(conv?.lead?.inquiry ?? conv?.lead?.notes ?? conv?.lead?.summary ?? "").trim();
  const hasInboundLeadContext = Array.isArray(conv?.messages)
    ? conv.messages.some((message: any) => {
        if (message?.direction !== "in") return false;
        const provider = String(message?.provider ?? "").toLowerCase();
        return provider === "sendgrid_adf" || provider === "web" || provider === "web_text";
      })
    : false;
  return !leadSource && !bucket && !cta && !inquiry && !hasInboundLeadContext;
}

export function detectManualOutboundCadenceContext(
  text: string | null | undefined,
  conv?: any
): ManualOutboundCadenceContext | null {
  const value = normalizeManualContextText(text);
  if (!value) return null;

  const dealerSendingInfo =
    /\b(i|we)\s+(?:can|will|'ll|am|are|could)\s+(?:send|text|shoot|forward)\s+(?:you\s+)?(?:some\s+)?(?:pics?|photos?|pictures?|details?|options?|list|inventory)\b/.test(
      value
    ) ||
    /\bhappy to send\b.*\b(?:list|options?|inventory|photos?|pictures?)\b/.test(value);
  const askCustomerToSend =
    /\b(?:send|shoot|text|forward|upload|drop)\b.{0,50}\b(?:pics?|photos?|pictures?|details?|info|information|vin|miles|mileage|odometer|payoff|title)\b/.test(
      value
    ) ||
    /\b(?:pics?|photos?|pictures?|details?|vin|miles|mileage|odometer|payoff|title)\b.{0,50}\b(?:over|to me|to us|when you can|whenever you can)\b/.test(
      value
    );
  const sellSubject =
    /\b(?:your|the)\s+(?:bike|motorcycle|harley|unit)\b/.test(value) ||
    /\b(?:sell|selling|buy(?:ing)? it|purchase it|appraisal|appraise|trade(?:-?in)?|value|offer)\b/.test(
      value
    );
  const detailBundle =
    /\b(?:pics?|photos?|pictures?)\b/.test(value) &&
    /\b(?:details?|info|vin|miles|mileage|odometer|payoff|title)\b/.test(value);

  if (!dealerSendingInfo && askCustomerToSend && (sellSubject || detailBundle)) {
    return {
      contextTag: "seller_photo_details_request",
      followUpReason: "seller_photo_details_request",
      confidence: sellSubject && detailBundle ? 0.93 : 0.84,
      reason: "manual_outbound_asks_customer_for_seller_bike_details"
    };
  }

  if (conv && isSparseManualConversationContext(conv)) {
    return {
      contextTag: "manual_context_needed",
      followUpReason: "manual_context_needed",
      confidence: 0.55,
      reason: "first_manual_outbound_sparse_context"
    };
  }

  return null;
}
