export function isLogisticsProgressUpdateText(text: string): boolean {
  const t = String(text ?? "").toLowerCase();
  if (!t.trim()) return false;
  const hasProgress =
    /\b(receive|received|get it|got it|arrives?|arrival|once i (?:get|receive)|as soon as i (?:get|receive))\b/.test(
      t
    ) ||
    /\b(dmv|registration|register|title|plate|paperwork)\b/.test(t);
  const hasDeferredFollowUp = /\b(let you know|get back to you|reach out)\b/.test(t);
  return hasProgress && hasDeferredFollowUp;
}

export function hasPostSaleOrOwnershipContext(conv: any): boolean {
  return (
    conv?.closedReason === "sold" ||
    !!conv?.sale?.soldAt ||
    conv?.followUp?.mode === "post_sale"
  );
}

export function shouldSuppressDispositionCloseout(conv: any, text: string): boolean {
  if (isLogisticsProgressUpdateText(text)) return true;
  if (!hasPostSaleOrOwnershipContext(conv)) return false;
  const t = String(text ?? "").toLowerCase();
  return (
    /\b(let you know|get back to you|reach out)\b/.test(t) &&
    /\b(dmv|registration|register|title|plate|paperwork|receive|received)\b/.test(t)
  );
}

export function isDispositionParserAccepted(parsed: {
  explicitDisposition?: boolean;
  disposition?: string | null;
  confidence?: number;
} | null): boolean {
  const confidenceMin = Number(process.env.LLM_CUSTOMER_DISPOSITION_CONFIDENCE_MIN ?? 0.74);
  const confidence =
    typeof parsed?.confidence === "number" && Number.isFinite(parsed.confidence) ? parsed.confidence : 0;
  return !!parsed?.explicitDisposition && parsed?.disposition !== "none" && confidence >= confidenceMin;
}

export function isResponseControlParserAccepted(parsed: {
  explicitRequest?: boolean;
  intent?: string | null;
  confidence?: number;
} | null): boolean {
  const confidenceMin = Number(process.env.LLM_RESPONSE_CONTROL_CONFIDENCE_MIN ?? 0.75);
  const confidence =
    typeof parsed?.confidence === "number" && Number.isFinite(parsed.confidence) ? parsed.confidence : 0;
  return !!parsed?.explicitRequest && parsed?.intent !== "none" && confidence >= confidenceMin;
}

export function canApplyDispositionCloseout(args: {
  conv: any;
  text: string;
  parsedAccepted: boolean;
  hasDecision: boolean;
}): boolean {
  const { conv, text, parsedAccepted, hasDecision } = args;
  if (!hasDecision) return false;
  if (shouldSuppressDispositionCloseout(conv, text)) return false;
  if (parsedAccepted) return true;
  // Default to parser-first for closeout transitions; regex fallback can be re-enabled explicitly.
  return process.env.ALLOW_DISPOSITION_REGEX_FALLBACK === "1";
}
