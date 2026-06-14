export type ToneIntent =
  | "pricing_finance"
  | "availability"
  | "scheduling"
  | "service"
  | "parts"
  | "apparel"
  | "warranty"
  | "trade"
  | "status_update"
  | "general";

export type ToneIssueCode =
  | "intent_mismatch"
  | "question_not_answered_first"
  | "role_inconsistency"
  | "generic_model_reask"
  | "generic_day_reask"
  | "pushy_cta_on_ack"
  | "template_bloat"
  | "known_fact_conflict"
  | "overcommitted_availability_watch"
  | "redundant_current_bike_stock_count"
  | "appointment_status_answer_mismatch"
  | "adf_direct_ask_unanswered"
  | "post_sale_logistics_schedule_mismatch";

export type ToneIssue = {
  code: ToneIssueCode;
  weight: number;
  detail: string;
};

export type ToneEvalInput = {
  inboundText: string;
  outboundText: string;
};

export type ToneEvalResult = {
  intent: ToneIntent;
  score: number;
  pass: boolean;
  band: "excellent" | "good" | "needs_work" | "poor";
  issues: ToneIssue[];
  signals: {
    inboundIsQuestion: boolean;
    intentMatched: boolean;
    answeredQuestionFirst: boolean;
    roleConsistent: boolean;
    notPushy: boolean;
  };
};

export type AdfDirectAskKind =
  | "location"
  | "pricing"
  | "availability"
  | "scheduling"
  | "trade"
  | "service"
  | "parts"
  | "apparel"
  | "callback";

export type AdfDirectAskMiss = {
  kind: AdfDirectAskKind;
  detail: string;
};

export function normalizeText(input: unknown): string {
  return String(input ?? "").replace(/\s+/g, " ").trim();
}

function isShortAck(text: string): boolean {
  const t = normalizeText(text).toLowerCase();
  if (!t) return false;
  if (t.length > 80) return false;
  if (/[?]/.test(t)) return false;
  return /\b(ok|okay|k|kk|thanks|thank you|thx|ty|sounds good|sounds great|perfect|awesome|cool|great|will do|got it|yep|yup|sure)\b/.test(
    t
  );
}

function isQuestion(text: string): boolean {
  const t = normalizeText(text);
  if (!t) return false;
  if (t.includes("?")) return true;
  return /^(can|could|do|does|did|is|are|what|when|where|why|how|which)\b/i.test(t);
}

function firstSentence(text: string): string {
  const t = normalizeText(text);
  if (!t) return "";
  const parts = t.split(/(?<=[.!?])\s+/).map(p => normalizeText(p)).filter(Boolean);
  if (!parts.length) return "";

  const looksLikeIntro = (s: string): boolean => {
    const lower = s.toLowerCase();
    // Skip common greeting/identity openers so we evaluate whether the reply addressed the question promptly.
    // Examples: "Hi Joe, this is Brooke at ...", "Hi — this is ...", "Hello!"
    if (/^(hi|hello|hey)\b/.test(lower) && lower.length <= 160) return true;
    if (/^\bthis is\b/.test(lower) && lower.length <= 160) return true;
    if (/^(hi|hello|hey)\b.*\bthis is\b/.test(lower) && lower.length <= 200) return true;
    return false;
  };

  if (parts.length >= 2 && looksLikeIntro(parts[0] ?? "")) {
    return parts[1] ?? parts[0] ?? "";
  }
  return parts[0] ?? t;
}

function hasPricingSignal(text: string): boolean {
  // "Special" is a Harley model trim (Road Glide Special, Heritage Softail
  // Special), not a request for deals/specials. Strip the trim usage before
  // pricing detection so a plain test-ride lead for a "Special" isn't scored
  // as an unanswered pricing ask. Standalone "specials"/"deals" survive.
  const t = String(text ?? "")
    .toLowerCase()
    .replace(/\b(?:glide|softail)\s+special\b/g, " ");
  return /\b(price|pricing|quote|cost|msrp|otd|out[-\s]?the[-\s]?door|apr|rate|rates|monthly|payment|payments|per month|term|months?|down payment|cash down|money down|put down|financing|finance|credit|specials?|deals?|incentives?)\b/.test(
    t
  );
}

function hasConcretePriceAnswerSignal(text: string): boolean {
  const t = normalizeText(text);
  const lower = t.toLowerCase();
  if (!t) return false;
  if (/\$\s?\d/.test(t)) return true;
  if (
    /\b(price|msrp|otd|out[-\s]?the[-\s]?door|listed|asking)\b/.test(lower) &&
    /\b\d{1,3}(?:,\d{3})*(?:\.\d{2})?\b/.test(lower)
  ) {
    return true;
  }
  return false;
}

function hasFinanceAnswerSignal(text: string): boolean {
  const t = String(text ?? "").toLowerCase();
  return /\b(apr|rate|rates|monthly|payment|payments|per month|term|months?|down payment|cash down|money down|put down|financing|finance|credit)\b/.test(
    t
  );
}

function looksLikePricingDeferral(text: string): boolean {
  const t = normalizeText(text).toLowerCase();
  if (!t) return false;
  if (hasConcretePriceAnswerSignal(t) || hasFinanceAnswerSignal(t)) return false;
  return /\b(pull|check|confirm|verify|get)\b/.test(t) && /\b(price|pricing|quote|numbers?)\b/.test(t);
}

function hasAvailabilitySignal(text: string): boolean {
  const t = String(text ?? "").toLowerCase();
  return /\b(in[-\s]?stock|available|availability|do you have|have any|any .* in[-\s]?stock|still there|still available|units? in stock)\b/.test(
    t
  );
}

function hasSchedulingSignal(text: string): boolean {
  const t = String(text ?? "").toLowerCase();
  return (
    /\b(schedule|book|appointment|set a time|what day|what time|come in|stop by|works best|test ride|testride|demo ride|demo[-\s]?ride)\b/.test(
      t
    ) ||
    /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|today|tomorrow)\b/.test(t) ||
    /\b\d{1,2}(?::\d{2})?\s*(am|pm)\b/.test(t)
  );
}

function hasServiceSignal(text: string): boolean {
  const t = String(text ?? "").toLowerCase();
  return /\b(service|shop|repair|maintenance|oil change|inspections?|warranty work|technician)\b/.test(t);
}

function hasPartsSignal(text: string): boolean {
  const t = String(text ?? "").toLowerCase();
  return /\b(parts?|part number|order a part|oem)\b/.test(t);
}

function hasApparelSignal(text: string): boolean {
  const t = String(text ?? "").toLowerCase();
  return /\b(apparel|clothing|helmet|jacket|gloves?|boots?|gear|merch)\b/.test(t);
}

function hasWarrantySignal(text: string): boolean {
  const t = String(text ?? "").toLowerCase();
  return /\b(warranty|coverage|factory warranty|limited warranty|2[- ]year)\b/.test(t);
}

function hasTradeSignal(text: string): boolean {
  const t = String(text ?? "").toLowerCase();
  return /\b(trade|trade[- ]in|payoff|lien|sell my bike|sell a bike for me|sell the bike for me|commission|consignment|equity)\b/.test(
    t
  );
}

function hasStatusUpdateSignal(text: string): boolean {
  const t = String(text ?? "").toLowerCase();
  return /\b(received|got|paperwork|dmv|notary|title|lien filed|i'?ll keep you posted|just wanted to update|update)\b/.test(
    t
  );
}

function hasCallbackSignal(text: string): boolean {
  const t = String(text ?? "").toLowerCase();
  return /\b(call me|give me a call|call back|callback|phone call|please call|contact me|reach out|text me|email me)\b/.test(
    t
  );
}

function hasModelHint(text: string): boolean {
  const t = String(text ?? "").toLowerCase();
  return /\b(street glide|road glide|tri glide|sportster|softail|fat bob|heritage|nightster|low rider|breakout|road king|electra glide|cvo|pan america|freewheeler|fury|switchback)\b/.test(
    t
  );
}

export function isAdfInboundText(text: string): boolean {
  const t = String(text ?? "").toLowerCase();
  if (!t.trim()) return false;
  return (
    /\bweb lead\s*\(adf\)/.test(t) ||
    /\bphone log\s*\(adf\)/.test(t) ||
    (/^\s*source:\s/m.test(t) &&
      /^\s*ref:\s/m.test(t) &&
      /^\s*name:\s/m.test(t) &&
      /^\s*(?:inquiry|your inquiry|customer comments?|comments?):\s*/im.test(t))
  );
}

function extractAdfCustomerText(text: string): string {
  const raw = String(text ?? "");
  const marker = raw.match(/(?:^|\n)\s*(?:inquiry|your inquiry|customer comments?|comments?):\s*/i);
  if (!marker || marker.index == null) return normalizeText(raw);
  return normalizeText(raw.slice(marker.index + marker[0].length));
}

function uniqueAskKinds(kinds: AdfDirectAskKind[]): AdfDirectAskKind[] {
  return Array.from(new Set(kinds));
}

export function detectAdfDirectAsks(inboundText: string): AdfDirectAskKind[] {
  if (!isAdfInboundText(inboundText)) return [];
  const t = extractAdfCustomerText(inboundText).toLowerCase();
  if (!t) return [];

  const asks: AdfDirectAskKind[] = [];
  const hasQuestionShape =
    /[?]/.test(t) ||
    /\b(?:what|where|when|how|do|does|did|can|could|is|are|will|would|please|not sure)\b/.test(t);

  if (
    hasQuestionShape &&
    (/\bwhere\b[\s\S]{0,60}\b(?:located|location|address|are you|is this|is it|this is)\b/.test(t) ||
      /\b(?:what|where)\b[\s\S]{0,40}\b(?:address|location)\b/.test(t) ||
      /\b(?:located at|dealership address|your address|directions?)\b/.test(t))
  ) {
    asks.push("location");
  }
  if (hasPricingSignal(t)) asks.push("pricing");
  if (hasAvailabilitySignal(t)) asks.push("availability");
  if (
    /\b(preferred date|preferred time|test ride|testride|demo ride|demo[-\s]?ride|schedule|appointment|book|come in|stop in|stop by|when can i|can i come|available times?)\b/.test(
      t
    )
  ) {
    asks.push("scheduling");
  }
  if (hasTradeSignal(t)) asks.push("trade");
  if (hasServiceSignal(t)) asks.push("service");
  if (hasPartsSignal(t)) asks.push("parts");
  if (hasApparelSignal(t)) asks.push("apparel");
  if (hasCallbackSignal(t)) asks.push("callback");

  return uniqueAskKinds(asks);
}

function hasLocationAnswerSignal(text: string): boolean {
  const t = normalizeText(text).toLowerCase();
  if (!t) return false;
  return (
    /\b(?:located at|located in|address is|we(?:'re| are) at|our location|dealership is at|directions?)\b/.test(t) ||
    /\b\d{2,6}\s+[a-z0-9.'-]+(?:\s+[a-z0-9.'-]+){0,5}\s+(?:ave|avenue|st|street|rd|road|blvd|boulevard|dr|drive|ln|lane|hwy|highway|pkwy|parkway|way|ct|court)\b/.test(
      t
    )
  );
}

function hasPricingAnswerOrHandoffSignal(text: string): boolean {
  const t = normalizeText(text).toLowerCase();
  return (
    hasConcretePriceAnswerSignal(text) ||
    hasFinanceAnswerSignal(text) ||
    looksLikePricingDeferral(text) ||
    /\b(?:published price|sale price|asking price|price in the inventory feed|confirm (?:cost|price|pricing)|pricing details|cost details|quote)\b/.test(
      t
    )
  );
}

function hasAvailabilityAnswerOrHandoffSignal(text: string): boolean {
  const t = normalizeText(text).toLowerCase();
  return (
    hasAvailabilitySignal(text) ||
    /\b(?:not seeing|i'?m seeing|we (?:do )?have|we don'?t have|sold|available|availability|in stock|out of stock|confirm availability|check availability)\b/.test(
      t
    )
  );
}

function hasSchedulingAnswerOrHandoffSignal(text: string): boolean {
  const t = normalizeText(text).toLowerCase();
  return (
    hasSchedulingSignal(text) ||
    /\b(?:preferred (?:date|time)|test ride|demo ride|appointment|schedule|book|confirm (?:that|the time)|lock that in|available times?)\b/.test(
      t
    )
  );
}

function outboundAnswersAdfAsk(kind: AdfDirectAskKind, outboundText: string): boolean {
  const t = normalizeText(outboundText);
  switch (kind) {
    case "location":
      return hasLocationAnswerSignal(t);
    case "pricing":
      return hasPricingAnswerOrHandoffSignal(t);
    case "availability":
      return hasAvailabilityAnswerOrHandoffSignal(t);
    case "scheduling":
      return hasSchedulingAnswerOrHandoffSignal(t);
    case "trade":
      return hasTradeSignal(t) || /\b(?:trade value|appraisal|trade-in value|value your trade)\b/i.test(t);
    case "service":
      return hasServiceSignal(t) || /\bservice department\b/i.test(t);
    case "parts":
      return hasPartsSignal(t) || /\bparts department\b/i.test(t);
    case "apparel":
      return hasApparelSignal(t) || /\bapparel department\b/i.test(t);
    case "callback":
      return hasCallbackSignal(t) || /\b(?:call|phone|contact|reach out|text|email)\b/i.test(t);
    default:
      return false;
  }
}

export function detectAdfDirectAskMisses(inboundText: string, outboundText: string): AdfDirectAskMiss[] {
  const asks = detectAdfDirectAsks(inboundText);
  if (!asks.length) return [];
  return asks
    .filter(kind => !outboundAnswersAdfAsk(kind, outboundText))
    .map(kind => ({
      kind,
      detail: `ADF customer asked about ${kind}, but outbound did not address it`
    }));
}

export function detectPrimaryIntent(inboundText: string): ToneIntent {
  const text = normalizeText(inboundText);
  if (!text) return "general";
  if (hasServiceSignal(text)) return "service";
  if (hasPartsSignal(text)) return "parts";
  if (hasApparelSignal(text)) return "apparel";
  if (hasSchedulingSignal(text)) return "scheduling";
  if (hasAvailabilitySignal(text)) return "availability";
  if (hasWarrantySignal(text)) return "warranty";
  if (hasPricingSignal(text)) return "pricing_finance";
  if (hasTradeSignal(text)) return "trade";
  if (hasStatusUpdateSignal(text) || isShortAck(text)) return "status_update";
  return "general";
}

function outboundMatchesIntent(intent: ToneIntent, outboundText: string): boolean {
  const text = normalizeText(outboundText);
  const t = text.toLowerCase();
  switch (intent) {
    case "pricing_finance":
      return hasPricingSignal(text) || /\$\s?\d/.test(text);
    case "availability":
      return (
        hasAvailabilitySignal(text) ||
        /\bnot seeing\b/.test(t) ||
        (/\bwe (?:do )?have\b/.test(t) && /\b(in stock|available|unit|units|one|two|three|any)\b/.test(t))
      );
    case "scheduling":
      return hasSchedulingSignal(text);
    case "service":
      return hasServiceSignal(text) || /\bservice department\b/i.test(text);
    case "parts":
      return hasPartsSignal(text);
    case "apparel":
      return hasApparelSignal(text);
    case "warranty":
      return hasWarrantySignal(text);
    case "trade":
      return hasTradeSignal(text) || /\bpayoff\b/i.test(text);
    case "status_update":
      return /\b(thanks|thank you|sounds good|perfect|got it|keep me posted|i'?m here if you need anything|appreciate)\b/i.test(
        text
      );
    case "general":
    default:
      return true;
  }
}

function firstSentenceMatchesIntent(intent: ToneIntent, outboundText: string): boolean {
  const first = firstSentence(outboundText);
  if (!first) return false;
  switch (intent) {
    case "pricing_finance":
      // For pricing questions, treat "I'll check/pull pricing" as a deferral, not an answer.
      if (looksLikePricingDeferral(first)) return false;
      return hasConcretePriceAnswerSignal(first) || hasFinanceAnswerSignal(first);
    case "availability":
      return (
        hasAvailabilitySignal(first) ||
        /\bnot seeing\b/i.test(first) ||
        (/\bwe (?:do )?have\b/i.test(first) && /\b(in stock|available|unit|units|one|two|three|any)\b/i.test(first))
      );
    case "scheduling":
      return hasSchedulingSignal(first) || /\b(works|time|day)\b/i.test(first);
    case "service":
      return hasServiceSignal(first) || /\bservice\b/i.test(first);
    case "parts":
      return hasPartsSignal(first) || /\bparts\b/i.test(first);
    case "apparel":
      return hasApparelSignal(first) || /\b(apparel|gear|clothing)\b/i.test(first);
    case "warranty":
      return hasWarrantySignal(first);
    case "trade":
      return hasTradeSignal(first);
    case "status_update":
      return /\b(thanks|sounds good|perfect|got it|keep me posted)\b/i.test(first);
    case "general":
    default:
      return /\b(yes|no|sounds good|happy to|thanks)\b/i.test(first);
  }
}

function hasRoleInconsistency(outboundText: string): boolean {
  const t = normalizeText(outboundText).toLowerCase();
  const thisIsCount = (t.match(/\bthis is\b/g) || []).length;
  if (thisIsCount > 1) return true;
  return /\bthis is [^.?!]+\.\s*this is\b/i.test(t);
}

function isPushyForAck(inboundText: string, intent: ToneIntent, outboundText: string): boolean {
  const inb = normalizeText(inboundText);
  const out = normalizeText(outboundText).toLowerCase();
  if (!(intent === "status_update" || isShortAck(inb))) return false;
  return /\b(stop by|come in|book|schedule|set a time|what day works|what time works)\b/.test(out);
}

function hasTemplateBloat(inboundText: string, outboundText: string): boolean {
  const out = normalizeText(outboundText).toLowerCase();
  const inb = normalizeText(inboundText);
  let hits = 0;
  if (/\bif you(?:'d| would) like,? you can stop by\b/.test(out)) hits += 1;
  if (/\b(i can|i'?ll) text you as soon as one comes in\b/.test(out)) hits += 1;
  if (/\bwhich model are you (interested|leaning)\b/.test(out)) hits += 1;
  if (/\bwant me to keep an eye out\b/.test(out)) hits += 1;
  if (out.length > 420) hits += 1;
  if (hasModelHint(inb) && /\bwhich model are you\b/.test(out)) hits += 1;
  return hits >= 2;
}

function hasGenericModelReask(inboundText: string, outboundText: string): boolean {
  if (!hasModelHint(inboundText)) return false;
  return /\bwhich model are you (interested|leaning)\b/i.test(outboundText);
}

function hasDayHint(text: string): boolean {
  const t = String(text ?? "").toLowerCase();
  return /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|today|tomorrow)\b/.test(t);
}

function hasGenericDayReask(inboundText: string, outboundText: string): boolean {
  if (!hasDayHint(inboundText)) return false;
  return /\bwhat day (?:and time )?(?:works|work|would work)|what time works best\b/i.test(outboundText);
}

function hasKnownFactConflict(inboundText: string, outboundText: string): boolean {
  const inbound = normalizeText(inboundText).toLowerCase();
  const outbound = normalizeText(outboundText).toLowerCase();
  if (/\bnight rod\b/.test(inbound) && /\bmid controls?\b/.test(inbound)) {
    return (
      !/\bstreet rod\b/.test(outbound) &&
      (/\bnight rods?\b.*\bmid controls?\b/.test(outbound) ||
        /\bmid controls?\b.*\bnight rods?\b/.test(outbound) ||
        /\bcheck on night rods?\b/.test(outbound))
    );
  }
  return false;
}

function hasOvercommittedAvailabilityWatch(inboundText: string, outboundText: string): boolean {
  const inbound = normalizeText(inboundText).toLowerCase();
  const outbound = normalizeText(outboundText).toLowerCase();
  return (
    /\b(service records?|service history|battery|tires?|tire age)\b/.test(inbound) &&
    /\bif .*still available\b|\bearly may\b/.test(inbound) &&
    /\bkeep an eye on availability\b/.test(outbound)
  );
}

function hasRedundantCurrentBikeStockCount(inboundText: string, outboundText: string): boolean {
  const inbound = normalizeText(inboundText).toLowerCase();
  const outbound = normalizeText(outboundText).toLowerCase();
  return (
    /\b(photo|photos|pic|pics|picture|pictures|beat up|condition|shape|rough|clean)\b/.test(inbound) &&
    /\bwe do have 1\b.*\bin stock\b.*\bwant photos or details\b/.test(outbound)
  );
}

function isAppointmentStatusQuestionText(text: string): boolean {
  const t = normalizeText(text).toLowerCase();
  if (!t) return false;
  const hasQuestion = /[?]/.test(t) || /\b(is|are|am|do|does|what|when|who)\b/.test(t);
  if (!hasQuestion) return false;
  return (
    /\b(?:my|our)\s+(?:appointment|appt)\b/.test(t) ||
    /\b(?:is|are|am)\s+(?:my|our|we|i)\b[\s\S]{0,40}\b(?:appointment|appt|still\s+(?:on|set|good)|confirmed)\b/.test(
      t
    ) ||
    /\b(?:are\s+we|am\s+i)\s+still\s+(?:on|set|good)\b/.test(t) ||
    /\bwhat\s+time\b[\s\S]{0,40}\b(?:appointment|appt)\b/.test(t) ||
    /\bwho\s+(?:am\s+i|are\s+we|is\s+it)\s+(?:with|seeing)\b/.test(t)
  );
}

function hasNewSchedulingAvailabilityLanguage(text: string): boolean {
  const t = normalizeText(text).toLowerCase();
  if (!t) return false;
  return (
    /\bcheck available times\b/.test(t) ||
    /\bwhat (?:day|time) (?:works|would work|is best)\b/.test(t) ||
    /\bdo any of these times work\b/.test(t) ||
    /\bavailable times? for\b/.test(t)
  );
}

function isPostSalePropertyDropoffLogisticsText(text: string): boolean {
  const t = normalizeText(text).toLowerCase();
  if (!t) return false;
  const hasItem = /\b(garage\s+keys?|keys?|key\s*ring|keyring|seat|back\s*seat|backseat|stock\s+(?:exhaust|pipes?|parts?)|take[-\s]?offs?)\b/.test(
    t
  );
  if (!hasItem) return false;
  return /\b(drop(?:ping)? off|bring(?:ing)? by|stopping by|stop by|swing by|pick(?:ing)? up|pickup|grab|left|forgot|still have)\b/.test(
    t
  );
}

function hasScheduleTimeCheckLanguage(text: string): boolean {
  const t = normalizeText(text).toLowerCase();
  if (!t) return false;
  return (
    /\bcheck that time\b/.test(t) ||
    /\bcheck (?:the|that)?\s*(?:appointment|schedule|slot|availability)\b/.test(t) ||
    /\bwhat (?:day|time) (?:works|would work|is best)\b/.test(t)
  );
}

export function evaluateTurnToneQuality(input: ToneEvalInput): ToneEvalResult {
  const rawInboundText = String(input.inboundText ?? "");
  const inboundText = normalizeText(input.inboundText);
  const outboundText = normalizeText(input.outboundText);
  const intent = detectPrimaryIntent(inboundText);
  const inboundIsQuestion = isQuestion(inboundText);
  const intentMatched = outboundMatchesIntent(intent, outboundText);
  const answeredQuestionFirst = inboundIsQuestion ? firstSentenceMatchesIntent(intent, outboundText) : true;
  const roleConsistent = !hasRoleInconsistency(outboundText);
  const notPushy = !isPushyForAck(inboundText, intent, outboundText);
  const genericModelReask = hasGenericModelReask(inboundText, outboundText);
  const genericDayReask = hasGenericDayReask(inboundText, outboundText);
  const templateBloat = hasTemplateBloat(inboundText, outboundText);
  const knownFactConflict = hasKnownFactConflict(inboundText, outboundText);
  const overcommittedAvailabilityWatch = hasOvercommittedAvailabilityWatch(inboundText, outboundText);
  const redundantCurrentBikeStockCount = hasRedundantCurrentBikeStockCount(inboundText, outboundText);
  const appointmentStatusAnswerMismatch =
    isAppointmentStatusQuestionText(inboundText) && hasNewSchedulingAvailabilityLanguage(outboundText);
  const postSaleLogisticsScheduleMismatch =
    isPostSalePropertyDropoffLogisticsText(inboundText) && hasScheduleTimeCheckLanguage(outboundText);
  const adfDirectAskMisses = detectAdfDirectAskMisses(rawInboundText, outboundText);

  const issues: ToneIssue[] = [];
  let score = 100;

  if (!intentMatched) {
    issues.push({
      code: "intent_mismatch",
      weight: 35,
      detail: "outbound does not match inbound intent"
    });
    score -= 35;
  }
  if (!answeredQuestionFirst) {
    issues.push({
      code: "question_not_answered_first",
      weight: 20,
      detail: "question was not answered in the first sentence"
    });
    score -= 20;
  }
  if (!roleConsistent) {
    issues.push({
      code: "role_inconsistency",
      weight: 20,
      detail: "multiple conflicting self-identification phrases found"
    });
    score -= 20;
  }
  if (genericModelReask) {
    issues.push({
      code: "generic_model_reask",
      weight: 15,
      detail: "asked for model again even though inbound already included model context"
    });
    score -= 15;
  }
  if (genericDayReask) {
    issues.push({
      code: "generic_day_reask",
      weight: 15,
      detail: "asked for the day again even though inbound already included a day"
    });
    score -= 15;
  }
  if (!notPushy) {
    issues.push({
      code: "pushy_cta_on_ack",
      weight: 15,
      detail: "added schedule/in-store CTA on an update/ack turn"
    });
    score -= 15;
  }
  if (templateBloat) {
    issues.push({
      code: "template_bloat",
      weight: 10,
      detail: "contains repeated template language and low-specificity phrasing"
    });
    score -= 10;
  }
  if (knownFactConflict) {
    issues.push({
      code: "known_fact_conflict",
      weight: 35,
      detail: "outbound conflicts with a known product fact"
    });
    score -= 35;
  }
  if (overcommittedAvailabilityWatch) {
    issues.push({
      code: "overcommitted_availability_watch",
      weight: 15,
      detail: "promised availability monitoring when customer primarily asked for records"
    });
    score -= 15;
  }
  if (redundantCurrentBikeStockCount) {
    issues.push({
      code: "redundant_current_bike_stock_count",
      weight: 20,
      detail: "restated the current bike as a stock count instead of answering detail/photo request"
    });
    score -= 20;
  }
  if (appointmentStatusAnswerMismatch) {
    issues.push({
      code: "appointment_status_answer_mismatch",
      weight: 35,
      detail: "answered an existing appointment-status question as a new scheduling availability request"
    });
    score -= 35;
  }
  if (postSaleLogisticsScheduleMismatch) {
    issues.push({
      code: "post_sale_logistics_schedule_mismatch",
      weight: 35,
      detail: "answered post-sale key/item drop-off logistics as an appointment scheduling time check"
    });
    score -= 35;
  }
  if (adfDirectAskMisses.length) {
    const missedKinds = adfDirectAskMisses.map(m => m.kind).join(", ");
    const weight = Math.min(50, 30 + Math.max(0, adfDirectAskMisses.length - 1) * 10);
    issues.push({
      code: "adf_direct_ask_unanswered",
      weight,
      detail: `ADF direct ask not addressed: ${missedKinds}`
    });
    score -= weight;
  }

  score = Math.max(0, Math.min(100, score));
  const band: ToneEvalResult["band"] =
    score >= 90 ? "excellent" : score >= 75 ? "good" : score >= 60 ? "needs_work" : "poor";

  return {
    intent,
    score,
    pass: score >= 75,
    band,
    issues,
    signals: {
      inboundIsQuestion,
      intentMatched,
      answeredQuestionFirst,
      roleConsistent,
      notPushy
    }
  };
}
