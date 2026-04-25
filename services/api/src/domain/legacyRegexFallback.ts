export function normalizeTimeToken(s: string): string {
  return s
    .toLowerCase()
    .replace(/\./g, "")
    .replace(/\s+/g, "")
    .replace(/^0+/, "");
}

export function extractTimeToken(msg: string): string | null {
  const s = String(msg ?? "").toLowerCase();
  const financeNumericContext =
    /\b(payment|monthly|per month|\/\s*mo|\/\s*month|down|down payment|apr|term|finance|financing|loan|loans?)\b/i
      .test(s) || /\b\d{2,3}\s*(month|months|mo)\b/i.test(s);

  // colon format: 9:30, 09:30, 9:30am, 9:30 am
  let m = s.match(/\b(\d{1,2})\s*:\s*(\d{2})\s*(am|pm)?\b/);
  if (m) {
    const hh = String(Number(m[1]));
    const mm = m[2];
    const ap = m[3] ?? "";
    return normalizeTimeToken(`${hh}:${mm}${ap}`);
  }

  // no-colon 3–4 digit: 930, 0930, 1030, 1230pm
  m = s.match(/(?:^|[^0-9])(\d{3,4})\s*(am|pm)?(?:$|[^0-9])/);
  if (m) {
    const digits = m[1];
    const ap = m[2] ?? "";
    const numeric = Number(digits);
    // Guardrail: model years like 2022/2026 should never be parsed as compact times.
    if (!ap && digits.length === 4 && Number.isFinite(numeric) && numeric >= 1900 && numeric <= 2099) {
      return null;
    }
    if (!ap && financeNumericContext) return null;
    const d = digits.padStart(4, "0");
    const hh = String(Number(d.slice(0, 2)));
    const mm = d.slice(2, 4);
    const token = normalizeTimeToken(`${hh}:${mm}${ap}`);
    console.log("[time-token] compact", { raw: digits, token });
    return token;
  }

  // hour-only: 1, 11, 1pm, 11am
  m = s.match(/\b(\d{1,2})\s*(am|pm)?\b/);
  if (m) {
    const hourNum = Number(m[1]);
    const hasMeridiem = !!m[2];
    // Prevent finance terms like "84 months" from being treated as a time.
    if (!hasMeridiem && /\b(month|months|mo|year|years|yr|yrs)\b/.test(s)) return null;
    if (!hasMeridiem && (hourNum < 1 || hourNum > 12)) return null;
    const hh = String(Number(m[1]));
    const ap = m[2] ?? "";
    return normalizeTimeToken(`${hh}:00${ap}`);
  }

  return null;
}

export function isPricingText(text: string): boolean {
  return /(price|otd|out the door|payment|monthly|down|apr|term|finance|credit|quote|lowest|best price|how low|low can (you|they) go)/i.test(
    String(text ?? "")
  );
}

export function isPaymentText(text: string): boolean {
  return /(monthly payment|what would it be a month|what would it be per month|how much down|money down|put (?:any )?money down|put down|to put down|no money down|zero down|\$0 down|\bapr\b|term|\b\d{2,3}\s*(month|months|mo)\b|\brun\s+(it|that|the numbers?)\s+for\s+\d{2,3}\b)/i.test(
    String(text ?? "")
  );
}

export function looksLikeTimeSelection(text: string): boolean {
  // Finance phrasing (e.g., "run it for 84 months") should never be treated as slot selection.
  if (isPaymentText(text)) return false;
  if (extractTimeToken(text)) return true;
  return /\b(first|second|earlier|later)\b/i.test(String(text ?? ""));
}

export function isExplicitScheduleIntent(text: string): boolean {
  const t = String(text ?? "").toLowerCase();
  const scheduleWords =
    /\b(schedule|appointment|appt|book|reserve|set\s+up|come\s+in|stop\s+(in|by)|visit|test ride|demo ride)\b/i;
  const hoursQuestion =
    /\bhours?\b/i.test(t) ||
    /(what time.*open|what time.*close|when.*open|when.*close|opening hours|closing time)/i.test(t);
  if (hoursQuestion && !scheduleWords.test(t)) {
    return false;
  }
  // If they’re asking for a phone call, do not treat it as an appointment request.
  if (/\b(call|phone|call me|give me a call|reach me|reach out)\b/i.test(t) &&
      !scheduleWords.test(t)) {
    return false;
  }
  // Deferrals like "wait until warmer" shouldn't trigger scheduling.
  if (/\b(wait|later|not yet|not now|when (it'?s|it is) warmer|once (it'?s|it is) warmer|warmer)\b/i.test(t) &&
      !scheduleWords.test(t)) {
    return false;
  }
  if (looksLikeTimeSelection(t)) return true;
  if (scheduleWords.test(t)) {
    return true;
  }
  if (/\b(when|what time|what day|availability|available|openings|open)\b/i.test(t)) {
    return true;
  }
  // Day words only count as scheduling if paired with a time.
  if (/\b(today|tomorrow|next week|this week|next month|monday|mon|tuesday|tue|tues|wednesday|wed|thursday|thu|thur|thurs|friday|fri|saturday|sat|sunday|sun)\b/i.test(t) &&
      /\b(\d{1,2})(?::\d{2})?\s*(am|pm)?\b/i.test(t)) {
    return true;
  }
  return false;
}

export const SOFT_SCHEDULE_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;

export function detectSoftVisitIntent(text: string): boolean {
  const t = String(text ?? "").toLowerCase();
  const hasDayPart = /\b(morning|afternoon|evening|tonight|tonite)\b/i.test(t);
  const hasTime = /\b(\d{1,2})(?::\d{2})?\s*(am|pm)\b/i.test(t);
  if (hasTime) return false;
  if (isExplicitScheduleIntent(t)) return false;
  const hardConstraint =
    /\b(can'?t|cannot|can not|won'?t|unable|not able|have to work|working|stuck at work|something came up)\b/i;
  const rescheduleLike =
    /\b(make it|make it in|come in|stop in|stop by|visit|today|tomorrow|monday|mon|tuesday|tue|tues|wednesday|wed|thursday|thu|thur|thurs|friday|fri|saturday|sat|sunday|sun|this week|next week)\b/i;
  if (hardConstraint.test(t) && rescheduleLike.test(t)) return false;
  const visitVerb =
    /\b(come|stop|swing|drop|head|drive|ride|make it|make it in|get there|come up|come down|stop by|come by|come in)\b/i;
  if (!visitVerb.test(t)) return false;
  const softQualifier =
    /\b(might|maybe|probably|try|trying|hope|hoping|plan|planning|if i can|if i could|if possible|sometime|some time|soon|eventually|later|in a few|in a couple|a couple (days|weeks)|next week|next month|this week|this weekend|weekend)\b/i;
  const dayToken =
    /\b(today|tomorrow|monday|mon|tuesday|tue|tues|wednesday|wed|thursday|thu|thur|thurs|friday|fri|saturday|sat|sunday|sun|next week|this week|this weekend|weekend|next month)\b/i;
  if (hasDayPart && dayToken.test(t)) return false;
  return visitVerb.test(t) && (softQualifier.test(t) || dayToken.test(t));
}

export function detectSchedulingSignals(text: string) {
  const t = String(text ?? "").toLowerCase();
  const hasDayToken =
    /\b(today|tomorrow|monday|mon|tuesday|tue|tues|wednesday|wed|thursday|thu|thur|thurs|friday|fri|saturday|sat|sunday|sun|this week|next week|this weekend|weekend|next month)\b/i.test(
      t
    );
  const hasDayPart = /\b(morning|afternoon|evening|tonight|tonite)\b/i.test(t);
  const hasTimeWord = /\b(\d{1,2}):(\d{2})\s*(am|pm)?\b/i.test(t);
  const hasAtHour = /\b(?:at|for|around|by)\s*(\d{1,2})(?::\d{2})?\b(?!\s*\/)/i.test(t);
  const hasDayTime = hasDayToken && (hasTimeWord || hasAtHour);
  const softVisit = detectSoftVisitIntent(t);
  const explicit = softVisit ? false : isExplicitScheduleIntent(t);
  const hasDayOnlyAvailability =
    hasDayToken && /\b(availability|available|openings|open|time|times)\b/i.test(t);
  const hasDayOnlyRequest = !softVisit && hasDayToken && (explicit || hasDayPart) && !hasDayTime;
  return { explicit, hasDayTime: softVisit ? false : hasDayTime, hasDayOnlyAvailability, hasDayOnlyRequest, softVisit };
}

export function hasPrimaryIntentBeyondWatch(text: string): boolean {
  const t = String(text ?? "").toLowerCase();
  if (!t.trim()) return false;
  const productInfoIntent =
    /\b(tell me more|know more|more about|learn more|details?|information|info|tell me about)\b/.test(
      t
    );
  const schedulingSignals = detectSchedulingSignals(t);
  if (
    schedulingSignals.explicit ||
    schedulingSignals.hasDayTime ||
    schedulingSignals.hasDayOnlyAvailability ||
    schedulingSignals.hasDayOnlyRequest
  ) {
    return true;
  }
  if (/\b\d{2,3}\s*(month|months|mo)\b/.test(t)) return true;
  if (/\brun\s+(it|that|the numbers?)\s+for\s+\d{2,3}\b/.test(t)) return true;
  if (isPaymentText(t) || isDownPaymentQuestion(t)) return true;
  if (productInfoIntent) return true;
  return (
    /\b(price|pricing|otd|monthly|apr|term|trade|trade in|appraisal|finance|financing|credit app|credit application|apply|application|schedule|book|appointment|test ride|available|availability|in stock|how many|what do you have|other options|another option|photos?|video|walkaround|specs?|engine|weight|stop in|come in|come by|stop by|look at)\b/.test(
      t
    ) ||
    /\b(do you have|what do you have|any .* in[-\s]?stock)\b/.test(t)
  );
}

export function isDownPaymentQuestion(text: string): boolean {
  const t = String(text ?? "").toLowerCase();
  if (!t.trim()) return false;
  return (
    /\b(how much|what(?:'s| is)|amount|do i have to|will i have to|can i)\b[^?]*\b(down|down payment|put down|put money down|money down|deposit|dp|zero down|\$0 down)\b/.test(
      t
    ) ||
    /\b(down payment|put down|put money down|money down|deposit|dp|zero down|\$0 down|no money down)\b/.test(
      t
    )
  );
}

export function isExplicitAvailabilityQuestion(text: string): boolean {
  const t = String(text ?? "").toLowerCase();
  if (!t.trim()) return false;
  return (
    /\b(do you have|do u have|you have any|have any|any .* in[-\s]?stock|in[-\s]?stock|availability|available|how many do you have|how many in stock|any others)\b/.test(
      t
    ) ||
    /\bwhat do you have\b/.test(t)
  );
}

export function isOtherInventoryRequestText(text: string): boolean {
  const lower = String(text ?? "").toLowerCase();
  if (!lower.trim()) return false;
  return (
    /\b(any|what|do you have|got)\s+(other|another|different|more)\b/i.test(lower) ||
    (/\b(other|another|different|else|more)\b/i.test(lower) &&
      /\b(in[-\s]?stock|available|availability|options?|ones|units|bikes)\b/i.test(lower))
  );
}

export type RoutePrioritySignalsInput = {
  text: string;
  conv: any;
  lastOutboundText?: string | null;
  pricingOrPaymentsIntent?: boolean;
  llmPricingOrPaymentsIntentRaw?: boolean;
  explicitAvailabilityIntentExtra?: boolean;
  explicitFinanceTermIntent?: boolean;
  schedulingSignalsExtra?: {
    explicit?: boolean;
    hasDayTime?: boolean;
    hasDayOnlyAvailability?: boolean;
    hasDayOnlyRequest?: boolean;
  };
};

export type RoutePrioritySignals = {
  availabilitySignals: {
    inventoryCountQuestion: boolean;
    explicitAvailabilityAsk: boolean;
    shouldLookupAvailability: boolean;
  };
  schedulingSignals: ReturnType<typeof detectSchedulingSignals>;
  deterministicAvailabilityLookup: boolean;
  availabilityIntentOverride: boolean;
  otherInventoryRequest: boolean;
  currentTurnFinanceSignal: boolean;
  financePriorityRaw: boolean;
  pricingHistoryBleedGuard: boolean;
  financePriorityOverride: boolean;
  schedulePriorityOverride: boolean;
};

export function resolveRoutePrioritySignals(input: RoutePrioritySignalsInput): RoutePrioritySignals {
  const text = String(input.text ?? "");
  const textLower = text.toLowerCase();
  const availabilityExplicit = !!input.explicitAvailabilityIntentExtra;
  const schedulingSignalsBase = detectSchedulingSignals(text);
  const schedulingSignals = {
    ...schedulingSignalsBase,
    explicit:
      schedulingSignalsBase.explicit ||
      !!input.schedulingSignalsExtra?.explicit,
    hasDayTime:
      schedulingSignalsBase.hasDayTime ||
      !!input.schedulingSignalsExtra?.hasDayTime,
    hasDayOnlyAvailability:
      schedulingSignalsBase.hasDayOnlyAvailability ||
      !!input.schedulingSignalsExtra?.hasDayOnlyAvailability,
    hasDayOnlyRequest:
      schedulingSignalsBase.hasDayOnlyRequest ||
      !!input.schedulingSignalsExtra?.hasDayOnlyRequest
  };
  const explicitAvailabilityFromText = isExplicitAvailabilityQuestion(text);
  const inventoryCountQuestion =
    /\bhow many\b[\w\s-]{0,30}\b(in[-\s]?stock|do you have|available|units|bikes|ones)\b/i.test(
      textLower
    ) || /\bhow many\s+(?:do you have|in[-\s]?stock)\b/i.test(textLower);
  const otherInventoryRequest = isOtherInventoryRequestText(text);
  const explicitAvailabilityAsk =
    availabilityExplicit ||
    explicitAvailabilityFromText ||
    inventoryCountQuestion ||
    otherInventoryRequest;
  const schedulePriorityRaw =
    schedulingSignals.explicit ||
    schedulingSignals.hasDayTime ||
    schedulingSignals.hasDayOnlyAvailability ||
    schedulingSignals.hasDayOnlyRequest;
  const fallbackFinanceSignal = isPricingText(text) || isPaymentText(text);
  const currentTurnFinanceSignal =
    !!input.pricingOrPaymentsIntent || !!input.explicitFinanceTermIntent || fallbackFinanceSignal;
  const shouldLookupAvailability =
    explicitAvailabilityAsk && !currentTurnFinanceSignal && !schedulePriorityRaw;
  const availabilitySignals = {
    inventoryCountQuestion,
    explicitAvailabilityAsk,
    shouldLookupAvailability
  };
  const deterministicAvailabilityLookup = shouldLookupAvailability;
  const availabilityIntentOverride = explicitAvailabilityAsk;
  const financePriorityRaw = currentTurnFinanceSignal;
  const pricingHistoryBleedGuard =
    !!input.llmPricingOrPaymentsIntentRaw &&
    explicitAvailabilityAsk &&
    !fallbackFinanceSignal &&
    !input.explicitFinanceTermIntent;
  const financePriorityOverride =
    financePriorityRaw && !availabilityIntentOverride && !schedulePriorityRaw;
  const schedulePriorityOverride = schedulePriorityRaw && !currentTurnFinanceSignal;

  return {
    availabilitySignals,
    schedulingSignals,
    deterministicAvailabilityLookup,
    availabilityIntentOverride,
    otherInventoryRequest,
    currentTurnFinanceSignal,
    financePriorityRaw,
    pricingHistoryBleedGuard,
    financePriorityOverride,
    schedulePriorityOverride
  };
}
