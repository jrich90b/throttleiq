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
  | "overcommitted_availability_watch";

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
  const parts = t.split(/(?<=[.!?])\s+/);
  return normalizeText(parts[0] ?? t);
}

function hasPricingSignal(text: string): boolean {
  const t = String(text ?? "").toLowerCase();
  return /\b(apr|rate|rates|monthly|payment|payments|per month|term|months?|down payment|cash down|money down|put down|financing|finance|credit|specials?|deals?|incentives?)\b/.test(
    t
  );
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
    /\b(schedule|book|appointment|set a time|what day|what time|come in|stop by|works best)\b/.test(t) ||
    /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|today|tomorrow)\b/.test(t) ||
    /\b\d{1,2}(?::\d{2})?\s*(am|pm)\b/.test(t)
  );
}

function hasServiceSignal(text: string): boolean {
  const t = String(text ?? "").toLowerCase();
  return /\b(service|shop|repair|maintenance|oil change|inspection|warranty work|technician)\b/.test(t);
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

function hasModelHint(text: string): boolean {
  const t = String(text ?? "").toLowerCase();
  return /\b(street glide|road glide|tri glide|sportster|softail|fat bob|heritage|nightster|low rider|breakout|road king|electra glide|cvo|pan america|freewheeler|fury|switchback)\b/.test(
    t
  );
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
      return hasPricingSignal(first) || /\$\s?\d/.test(first);
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

export function evaluateTurnToneQuality(input: ToneEvalInput): ToneEvalResult {
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
