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

function hasCreditApplicationContext(value: string, conv?: any): boolean {
  if (
    /\b(?:credit|finance|financing|hdfs|lender)\b/.test(value) ||
    /\b(?:credit|finance|financing)\s+(?:app|application)\b/.test(value) ||
    /\bapplication\b.{0,40}\b(?:submitted|approval|approved|pending|needs?|more info|information)\b/.test(value)
  ) {
    return true;
  }

  const followUpReason = String(conv?.followUp?.reason ?? "").trim().toLowerCase();
  if (/\b(?:credit_app|finance|financing|hdfs|prequal)\b/.test(followUpReason)) return true;
  if (
    conv?.classification?.bucket === "finance_prequal" ||
    conv?.classification?.cta === "hdfs_coa" ||
    conv?.classification?.cta === "prequalify"
  ) {
    return true;
  }
  if (String(conv?.financeOutcome?.status ?? "").trim()) return true;

  const leadText = [
    conv?.lead?.source,
    conv?.lead?.inquiry,
    conv?.lead?.notes,
    conv?.lead?.summary
  ]
    .map(part => String(part ?? "").toLowerCase())
    .join(" ");
  if (/\b(?:app id|credit app|credit application|finance application|prequal|hdfs)\b/.test(leadText)) {
    return true;
  }

  const historyText = Array.isArray(conv?.messages)
    ? conv.messages
        .slice(-12)
        .map((message: any) => String(message?.body ?? "").toLowerCase())
        .join(" ")
    : "";
  return /\b(?:app id|credit app|credit application|finance application|prequal|hdfs)\b/.test(historyText);
}

function financeDocsNeededTermPattern(): RegExp {
  return /\b(?:more info|more information|additional info|some info|docs?|documents?|paperwork|references?|pay stubs?|proof|co-?signer|items?|insurance cards?|insurance binder|binder|verification of insurance|driver'?s license|drivers license|license photo)\b/;
}

export function hasRecentContactedVoiceContext(conv?: any, maxAgeHours = 48): boolean {
  const voice = conv?.voiceContext ?? null;
  if (!voice?.contacted) return false;
  const updatedMs = Date.parse(String(voice?.updatedAt ?? ""));
  if (!Number.isFinite(updatedMs)) return false;
  return Date.now() - updatedMs <= Math.max(1, maxAgeHours) * 60 * 60 * 1000;
}

export function shouldHoldManualFinanceDocsForRecentVoiceContact(
  text: string | null | undefined,
  conv?: any
): boolean {
  if (!hasRecentContactedVoiceContext(conv)) return false;
  const value = normalizeManualContextText(text);
  if (!value) return false;
  if (!hasCreditApplicationContext(value, conv)) return false;
  const asksForCustomerDocs =
    /\b(?:need|needs|needed|will need|still need|require|requires|required|bring|provide|send|text|upload)\b/.test(
      value
    ) && financeDocsNeededTermPattern().test(value);
  return asksForCustomerDocs;
}

export function isManualOutboundCreditAppNeedsMoreInfoText(
  text: string | null | undefined,
  conv?: any
): boolean {
  const value = normalizeManualContextText(text);
  if (!value) return false;
  if (!hasCreditApplicationContext(value, conv)) return false;

  if (
    /\b(?:if|when)\s+you\s+need\b.{0,80}\b(?:more info|more information|additional info|details?)\b/.test(
      value
    ) ||
    /\byou\s+(?:need|want|wanted|asked for|were looking for)\b.{0,80}\b(?:more info|more information|additional info|details?)\b/.test(
      value
    )
  ) {
    return false;
  }

  const subjectNeedsInfo =
    new RegExp(
      "\\b(?:harley|hdfs|lender|finance(?: team| department| dept)?|credit|application|app|we|i|they)\\b.{0,90}\\b(?:need|needs|needed|still need|will need|require|requires|required|requested|asking for|looking for|waiting on|missing)\\b.{0,90}" +
        financeDocsNeededTermPattern().source
    ).test(
      value
    );
  const infoNeeded =
    new RegExp(
      financeDocsNeededTermPattern().source +
        ".{0,90}\\b(?:needed|required|missing|pending|for (?:your )?(?:credit|finance|financing) (?:app|application))\\b"
    ).test(
      value
    );

  return subjectNeedsInfo || infoNeeded;
}

export function isManualOutboundQuoteDeliveredText(
  text: string | null | undefined,
  opts?: { hasMedia?: boolean }
): boolean {
  const value = normalizeManualContextText(text);
  if (!value) return false;

  const futurePricingWork =
    /\b(?:i|we)\s+(?:will|'ll|am going to|are going to|can)\s+(?:get|work|put|get you|put together|confirm|check|send)\b.{0,90}\b(?:price|pricing|quote|numbers?|payment|estimate)\b/.test(
      value
    ) ||
    /\b(?:need|needs|needed)\s+(?:to\s+)?(?:confirm|check|work up|put together|get)\b.{0,90}\b(?:price|pricing|quote|numbers?|payment|estimate)\b/.test(
      value
    );
  const actualDeliveryCue =
    /\b(?:here'?s|here is|attached|sent over|sending over|i have it priced|we have it priced|priced at|quote on|numbers on|payment estimate|you(?:'d| would) (?:probably )?(?:be )?looking|payment would be|out[- ]the[- ]door|otd)\b/.test(
      value
    );
  const moneyOrPaymentCue =
    /\$\s*\d{2,}|\b\d{2,4}\s*(?:\/\s*mo|per month|monthly|mo\b)|\b\d{1,3}\s*k\s+down\b/.test(
      value
    );
  const pricingTerm =
    /\b(?:price|priced|pricing|quote|numbers?|payment|monthly|term|down|tax(?:es)?|dmv|registration|freight|dealer prep|out[- ]the[- ]door|otd|apr|mo)\b/.test(
      value
    );

  if (actualDeliveryCue && (pricingTerm || opts?.hasMedia)) return true;
  if (moneyOrPaymentCue && pricingTerm && !futurePricingWork) return true;

  return false;
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
