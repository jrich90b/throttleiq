export function isLogisticsProgressUpdateText(text: string): boolean {
  const t = String(text ?? "").toLowerCase();
  if (!t.trim()) return false;
  const hasProgress =
    /\b(receive|received|get it|got it|arrives?|arrival|once i (?:get|receive)|as soon as i (?:get|receive))\b/.test(
      t
    ) ||
    /\b(dmv|registration|register|title|plate|paperwork)\b/.test(t);
  const hasDeliveryReadyUpdate =
    /\b(?:bike|motorcycle|unit|ride|it)\b[\s\S]{0,80}\b(?:ready|done|finished|complete|completed)\b/.test(t) ||
    /\b(?:ready|done|finished|complete|completed)\b[\s\S]{0,80}\b(?:bike|motorcycle|unit|ride|it)\b/.test(t);
  const hasDeliveryTimingContext =
    /\b(?:before|by|on|around|after)\b[\s\S]{0,60}\b(?:today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|juneteenth|june|july|august|september|october|november|december|\d{1,2}(?:st|nd|rd|th)?)\b/.test(
      t
    ) ||
    /\b(?:today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|juneteenth|june|july|august|september|october|november|december|\d{1,2}(?:st|nd|rd|th)?)\b[\s\S]{0,60}\b(?:ready|done|finished|complete|completed)\b/.test(
      t
    );
  const hasDealerTimeUpdate =
    /\bplease let (?:him|her|them|the team|sales|service|parts|your guy|your guys) know\b[\s\S]{0,80}\b(?:got time|has time|have time|no rush|not a rush)\b/.test(
      t
    ) ||
    /\b(?:got time|has time|have time|no rush|not a rush)\b[\s\S]{0,80}\bplease let (?:him|her|them|the team|sales|service|parts|your guy|your guys) know\b/.test(
      t
    );
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
    (hasDeliveryReadyUpdate && hasDeliveryTimingContext) ||
    hasDealerTimeUpdate ||
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

const CREDIT_APP_ADF_RE = /\bApp ID:\s*\d|\bHDFS COA\b/i;
const ACTIVE_DEAL_ADF_WINDOW_DAYS = 14;

/**
 * Active-deal closeout blocker: a conversation with live financing signals must
 * never be auto-archived by a disposition parse, no matter how confident.
 * Production incident 2026-06-11: Dave Batka +17169982451 - credit application
 * submitted 3 hours earlier, open credit-approval task, "Showed / finance needs
 * more info" outcome - closed as customer_sell_on_own (0.9) nine seconds after
 * texting "I am going to take care of the pipes myself".
 */
export function hasActiveDealCloseoutBlockers(
  conv: any,
  opts: { openTodos?: Array<{ convId?: string; reason?: string; summary?: string }> ; nowMs?: number } = {}
): boolean {
  const nowMs = opts.nowMs ?? Date.now();
  const todos = Array.isArray(opts.openTodos) ? opts.openTodos : [];
  const convId = String(conv?.id ?? "");
  const hasCreditTodo = todos.some(
    t =>
      String(t?.convId ?? "") === convId &&
      (String(t?.reason ?? "") === "approval" || /\bcredit\b/i.test(String(t?.summary ?? "")))
  );
  if (hasCreditTodo) return true;
  const windowMs = ACTIVE_DEAL_ADF_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  const hasRecentCreditAdf = (conv?.messages ?? []).some((m: any) => {
    if (m?.direction !== "in" || m?.provider !== "sendgrid_adf") return false;
    if (!CREDIT_APP_ADF_RE.test(String(m?.body ?? ""))) return false;
    const atMs = Date.parse(String(m?.at ?? ""));
    return Number.isFinite(atMs) && nowMs - atMs <= windowMs;
  });
  if (hasRecentCreditAdf) return true;
  const outcomeNote = String(conv?.appointment?.staffNotify?.outcome?.note ?? "");
  const outcomeAtMs = Date.parse(String(conv?.appointment?.staffNotify?.outcome?.updatedAt ?? ""));
  if (
    /\bfinance|credit\b/i.test(outcomeNote) &&
    Number.isFinite(outcomeAtMs) &&
    nowMs - outcomeAtMs <= 30 * 24 * 60 * 60 * 1000
  ) {
    return true;
  }
  return false;
}

export function shouldSuppressDispositionCloseout(
  conv: any,
  text: string,
  opts: { openTodos?: Array<{ convId?: string; reason?: string; summary?: string }> } = {}
): boolean {
  if (hasActiveDealCloseoutBlockers(conv, opts)) return true;
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

export function isDealerLocationQuestionText(text: string | null | undefined): boolean {
  const t = String(text ?? "")
    .toLowerCase()
    .replace(/[’]/g, "'")
    .replace(/\s+/g, " ")
    .trim();
  if (!t) return false;
  if (/\b(?:my|their|his|her|customer|pickup|pick up|street)\s+address\b/.test(t)) return false;
  return (
    /\bwhere\s+(?:are|r)\s+(?:you|y'all|you guys)\b/.test(t) ||
    /\bwhere\s+(?:is|'s)\s+(?:the\s+)?(?:dealership|dealer|store|shop|location)\b/.test(t) ||
    /\bwhere\s+(?:are|is|'s)\s+(?:you\s+)?located\b/.test(t) ||
    /\bwhere\s+(?:is|'s)\s+(?:this|that|the\s+(?:bike|motorcycle|unit|vehicle))\s+located\b/.test(t) ||
    /\bwhere\s+(?:this|that|the\s+(?:bike|motorcycle|unit|vehicle))\s+(?:is|'s)\s+located\b/.test(t) ||
    /\bwhat\s+(?:is|'s)?\s*(?:your|the|this|that)?\s*(?:store\s+|dealer\s+|dealership\s+)?address\b/.test(t) ||
    /\bwhat\s+address\s+(?:is\s+)?(?:this|that|there|are\s+you\s+at|you\s+at)\b/.test(t) ||
    /\bwhat\s+location\b/.test(t) ||
    /\baddress\s+(?:is\s+)?(?:this|that|there|are\s+you\s+at|you\s+at)\b/.test(t)
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
    ) ||
    /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|wed|thu|fri|sat|sun)\b[\s\S]{0,60}\b(?:at|around|about|before|after|morning|afternoon|evening|\d{1,2}(?::?\d{2})?\s*(?:am|pm)?)\b/.test(
      t
    );
  const hasActiveBuyingSignal =
    /\b(ready to buy|pull the trigger|i want (it|that bike)|i['’]?m interested|interested in|want to move forward)\b/.test(
      t
    );
  return hasAvailabilityAsk || hasSchedulingAsk || hasActiveBuyingSignal || isDealerLocationQuestionText(t);
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

export function isDealerTransactionPolicyParserAccepted(parsed: {
  explicitRequest?: boolean;
  intent?: string | null;
  asksRiderToRiderFinancing?: boolean;
  asksPrivateSellerFacilitation?: boolean;
  asksExternalDealerFacilitation?: boolean;
  confidence?: number;
} | null): boolean {
  const confidenceMin = Number(process.env.LLM_DEALER_TRANSACTION_POLICY_CONFIDENCE_MIN ?? 0.74);
  const confidence =
    typeof parsed?.confidence === "number" && Number.isFinite(parsed.confidence) ? parsed.confidence : 0;
  const hasActionableFlag =
    !!parsed?.asksRiderToRiderFinancing ||
    !!parsed?.asksPrivateSellerFacilitation ||
    !!parsed?.asksExternalDealerFacilitation;
  return !!parsed?.explicitRequest && parsed?.intent !== "none" && hasActionableFlag && confidence >= confidenceMin;
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
  responseControlNotInterested?: boolean;
  openTodos?: Array<{ convId?: string; reason?: string; summary?: string }>;
}): boolean {
  const { conv, text, parsedAccepted, hasDecision, responseControlNotInterested } = args;
  if (!hasDecision) return false;
  if (shouldSuppressDispositionCloseout(conv, text, { openTodos: args.openTodos })) return false;
  if (parsedAccepted) return true;
  // Parser-first closeout: allow fallback only when the dedicated response-control parser
  // independently classified the turn as not interested.
  if (responseControlNotInterested) return true;
  // Default to parser-first for closeout transitions; regex fallback can be re-enabled explicitly.
  return process.env.ALLOW_DISPOSITION_REGEX_FALLBACK === "1";
}
