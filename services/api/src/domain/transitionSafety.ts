export function isLogisticsProgressUpdateText(text: string): boolean {
  const t = String(text ?? "").toLowerCase();
  if (!t.trim()) return false;
  const hasProgress =
    /\b(receive|received|get it|got it|arrives?|arrival|once i (?:get|receive)|as soon as i (?:get|receive))\b/.test(
      t
    ) ||
    /\b(dmv|registration|register|title|plate|paperwork)\b/.test(t);
  const hasDeferredFollowUp = /\b(let (?:me|you) know|get back to (?:me|you)|reach out|follow up)\b/.test(t);
  const hasTravelDeadline =
    /\b(?:start|star|starting|leave|leaving|head|heading|drive|driving|travel|traveling|travelling|on the road)\b[\s\S]{0,90}\b(?:today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|morning|afternoon|evening)\b/.test(
      t
    ) ||
    /\b(?:today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|morning|afternoon|evening)\b[\s\S]{0,90}\b(?:start|star|starting|leave|leaving|head|heading|drive|driving|travel|traveling|travelling|on the road)\b/.test(
      t
    );
  const hasArrivalProgress =
    /\b(?:on my way|on the way|en route|headed over|heading over|heading there|coming over|coming now)\b/.test(
      t
    ) ||
    /\b(?:be|being|make it|get|arrive)\s+there\b/.test(t);
  const hasArrivalTime =
    /\b(?:by|around|about|close to|before)?\s*\d{1,2}(?::?\d{2})?\s*(?:am|pm)?\b/.test(t) ||
    /\b(?:soon|shortly|in a few|right now)\b/.test(t);
  return (
    (hasProgress && hasDeferredFollowUp) ||
    (hasDeferredFollowUp && hasTravelDeadline) ||
    (hasArrivalProgress && hasArrivalTime)
  );
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
  if (isStructuredFinanceInfoText(text)) return true;
  if (isAffordabilityRideConfidenceObjectionText(text)) return true;
  if (hasCompetingActiveIntentText(text)) return true;
  if (!hasPostSaleOrOwnershipContext(conv)) return false;
  const t = String(text ?? "").toLowerCase();
  return (
    /\b(let you know|get back to you|reach out)\b/.test(t) &&
    /\b(dmv|registration|register|title|plate|paperwork|receive|received)\b/.test(t)
  );
}

function isStructuredFinanceInfoText(text: string): boolean {
  const t = String(text ?? "").toLowerCase();
  if (!t.trim()) return false;
  const hasMonthlyTarget =
    /\b(under|around|about|stay|no more than|max)\s*\$?\s*\d[\d,]*\s*(?:\/?\s*mo(?:nth)?|per\s*month|monthly)\b/.test(
      t
    ) ||
    /\$\s*\d[\d,]*\s*(?:\/?\s*mo(?:nth)?|per\s*month|monthly)\b/.test(t);
  const hasDownPaymentDetail =
    /\bi have\s+\$?\s*\d[\d,]*\s*(?:to\s*)?(?:put\s*)?down\b/.test(t) ||
    /\$\s*\d[\d,]*\s*(?:cash\s*)?down\b/.test(t) ||
    /\b(?:put|puts|putting)\s+\$?\s*\d[\d,]*\s*down\b/.test(t);
  const hasTermDetail = /\b(36|48|60|72|84)\s*months?\b/.test(t);
  const hasFinanceProgramDetail =
    /\b(apr|rate|interest|financing|finance special|specials?)\b/.test(t) &&
    /\$?\s*\d[\d,]*/.test(t);
  return hasMonthlyTarget || hasDownPaymentDetail || hasTermDetail || hasFinanceProgramDetail;
}

export function isAffordabilityRideConfidenceObjectionText(text: string): boolean {
  const t = String(text ?? "").toLowerCase();
  if (!t.trim()) return false;
  const hasAffordabilityConcern =
    /\b(can i afford|if i can afford|whether i can afford|trying to figure out if i can afford|afford it|budget|payment|payments|monthly|price|pricing)\b/.test(
      t
    );
  const hasRideConfidenceConcern =
    /\b(ride|rode|ridden|riding|motorcycle|bike)\b[\s\S]{0,80}\b(10\s*(?:yrs?|years?)|decade|long time|while|rusty|nervous|comfortable|confidence|again)\b/.test(
      t
    ) ||
    /\b(10\s*(?:yrs?|years?)|decade|long time|while|rusty|nervous|comfortable|confidence)\b[\s\S]{0,80}\b(ride|rode|ridden|riding|motorcycle|bike)\b/.test(
      t
    );
  return hasAffordabilityConcern && hasRideConfidenceConcern;
}

function hasCompetingActiveIntentText(text: string): boolean {
  const t = String(text ?? "").toLowerCase();
  if (!t.trim()) return false;
  const hasAvailabilityAsk =
    /\b(do you have|do u have|have any|any .* in[-\s]?stock|in[-\s]?stock|available|availability)\b/.test(
      t
    ) || /\bwhat do you have\b/.test(t);
  const hasSchedulingAsk =
    /\b(can i come in|stop by|come by|what day|what time|set up a time|book (a )?(time|appointment)|schedule (a )?(time|appointment)|works for you)\b/.test(
      t
    ) || /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|wed|thu|fri|sat|sun)\b/.test(t);
  const hasActiveBuyingSignal =
    /\b(ready to buy|pull the trigger|i want (it|that bike)|i['’]?m interested|interested in|want to move forward)\b/.test(
      t
    );
  return hasAvailabilityAsk || hasSchedulingAsk || hasActiveBuyingSignal;
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

export function isFirstTimeRiderGuidanceParserAccepted(parsed: {
  explicitRequest?: boolean;
  intent?: string | null;
  confidence?: number;
} | null): boolean {
  const confidenceMin = Number(process.env.LLM_FIRST_TIME_RIDER_GUIDANCE_CONFIDENCE_MIN ?? 0.74);
  const confidence =
    typeof parsed?.confidence === "number" && Number.isFinite(parsed.confidence) ? parsed.confidence : 0;
  return !!parsed?.explicitRequest && parsed?.intent !== "none" && confidence >= confidenceMin;
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

export function isResponseControlParserConfidentDecision(parsed: {
  intent?: string | null;
  confidence?: number;
} | null): boolean {
  const confidenceMin = Number(process.env.LLM_RESPONSE_CONTROL_CONFIDENCE_MIN ?? 0.75);
  const confidence =
    typeof parsed?.confidence === "number" && Number.isFinite(parsed.confidence) ? parsed.confidence : 0;
  return !!parsed?.intent && confidence >= confidenceMin;
}

export function isResponseControlNoResponseAccepted(parsed: {
  intent?: string | null;
  confidence?: number;
} | null): boolean {
  const confidenceMin = Number(process.env.LLM_RESPONSE_CONTROL_NO_RESPONSE_CONFIDENCE_MIN ?? 0.82);
  const confidence =
    typeof parsed?.confidence === "number" && Number.isFinite(parsed.confidence) ? parsed.confidence : 0;
  return parsed?.intent === "no_response" && confidence >= confidenceMin;
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
