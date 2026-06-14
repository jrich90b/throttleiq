export type RequestedScheduleWindowMode = "after" | "before" | "any_time" | "window" | "none";

function normalizeScheduleLabel(raw?: string | null): string {
  return String(raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/\b\w/g, c => c.toUpperCase());
}

function normalizeDayToken(raw?: string | null): string | null {
  const day = String(raw ?? "").trim();
  if (!day) return null;
  if (/^mon$/i.test(day)) return "Monday";
  if (/^tue|tues$/i.test(day)) return "Tuesday";
  if (/^wed$/i.test(day)) return "Wednesday";
  if (/^thu|thur|thurs$/i.test(day)) return "Thursday";
  if (/^fri$/i.test(day)) return "Friday";
  if (/^sat$/i.test(day)) return "Saturday";
  if (/^sun$/i.test(day)) return "Sunday";
  return normalizeScheduleLabel(day);
}

function dayTokenPattern(): RegExp {
  return /\b(today|tomorrow|monday|mon|tuesday|tue|tues|wednesday|wed|thursday|thu|thur|thurs|friday|fri|saturday|sat|sunday|sun|next week|this week)\b/i;
}

export function extractDayLabelFromText(textRaw: string | null | undefined): string | null {
  const text = String(textRaw ?? "");
  return normalizeDayToken(text.match(dayTokenPattern())?.[1]);
}

function wantsReminder(textRaw: string | null | undefined): boolean {
  const text = String(textRaw ?? "").toLowerCase();
  return /\b(remind|reminder|follow up|follow-up|check back|reach out|touch base)\b/i.test(text);
}

export function extractReminderFollowUpLabel(textRaw: string | null | undefined): string | null {
  const text = String(textRaw ?? "");
  const reminderDay = text.match(
    /\b(?:remind|reminder|follow up|follow-up|check back|reach out|touch base)\b[\s\S]{0,100}?\b(today|tomorrow|monday|mon|tuesday|tue|tues|wednesday|wed|thursday|thu|thur|thurs|friday|fri|saturday|sat|sunday|sun|next week|this week)\b/i
  )?.[1];
  return normalizeDayToken(reminderDay) ?? extractDayLabelFromText(textRaw);
}

export function isFollowUpReminderOnlyText(textRaw: string | null | undefined): boolean {
  const text = String(textRaw ?? "").toLowerCase();
  if (!text.trim()) return false;
  if (!wantsReminder(text)) return false;
  if (/\?/.test(text)) return false;
  if (
    /\b(what time|what day|which time|which day|appointment|appt|book|schedule|reschedule|set up|lock it in|come in|stop in|stop by|test ride|demo ride)\b/i.test(
      text
    )
  ) {
    return false;
  }
  return true;
}

export function buildFollowUpReminderOnlyReply(textRaw: string | null | undefined): string {
  const label = extractReminderFollowUpLabel(textRaw);
  return label ? `Sounds good — I’ll touch base ${label}.` : "Sounds good — I’ll touch base with you.";
}

export function isConditionalPickupPlanText(textRaw: string | null | undefined): boolean {
  const text = String(textRaw ?? "").toLowerCase().replace(/\s+/g, " ").trim();
  if (!text) return false;
  if (/[?]/.test(text)) return false;
  const conditional = /\b(if not|otherwise|if (?:it|that|this|they|we|you) (?:do(?:es)?n'?t|does not|isn'?t|is not)|if .* not)\b/.test(
    text
  );
  if (!conditional) return false;
  const futureSelf = /\b(?:i(?:'|’)?ll|i will|we(?:'|’)?ll|we will)\b/.test(text);
  const pickupOrVisit = /\b(?:pick(?:ing)? (?:it|them|the bike)? ?up|pickup|come (?:in|by|down|through)|stop (?:in|by)|swing (?:in|by))\b/.test(
    text
  );
  return futureSelf && pickupOrVisit && !!extractDayLabelFromText(text);
}

export function buildConditionalPickupPlanAck(textRaw: string | null | undefined): string | null {
  if (!isConditionalPickupPlanText(textRaw)) return null;
  const text = String(textRaw ?? "");
  const label = extractDayLabelFromText(text);
  const action = /\bpick(?:ing)? (?:it|them|the bike)? ?up|pickup\b/i.test(text)
    ? "picking it up"
    : "coming by";
  return label
    ? `Sounds good — just give me a heads up if you end up ${action} ${label}.`
    : `Sounds good — just give me a heads up if that ends up being the plan.`;
}

export function isServiceStatusUpdateQuestionText(textRaw: string | null | undefined): boolean {
  const text = String(textRaw ?? "").toLowerCase().replace(/\s+/g, " ").trim();
  if (!text) return false;
  const asksUpdate = /\b(any updates?|update on|status|where (?:do )?we stand|where.*at|what(?:'s| is) going on|did .* hear|have .* heard)\b/.test(
    text
  );
  const serviceSignal = /\b(service|servicing|service department|servicing department|logged in|checked in|repair|inspection|work order|notice)\b/.test(
    text
  );
  const repairWorkQuestion =
    /\b(?:are|r|will|did|can|could|would)\s+(?:you|u|your|ur|you guys|u guys|service|the shop|they|techs?)\b[\s\S]{0,80}\b(?:replace|replacing|repair|fix|install|installed|look(?:ing)? at|work(?:ing)? on|diagnos(?:e|ing))\b/.test(
      text
    ) ||
    /\b(?:when|what day|which day)\b[\s\S]{0,60}\b(?:replace|replacing|repair|fix|install|work(?:ing)? on|diagnos(?:e|ing))\b/.test(
      text
    );
  const repairPartSignal = /\b(?:ignition\s+switch|switch|starter|battery|brakes?|tires?|clutch|throttle|fork|seal|leak|engine|transmission|primary|belt|sensor|code|check engine|key fob|fob|security)\b/.test(
    text
  );
  return (asksUpdate && serviceSignal) || (repairWorkQuestion && repairPartSignal);
}

export function buildServiceStatusUpdateHandoffReply(): string {
  return "Got it — I’ll check with service on the status and follow up.";
}

export type PurchaseDeliveryOperationalRequestKind =
  | "vin_request"
  | "lift_info_request"
  | "trade_status_request"
  | "callback_request"
  | "vehicle_weight_request"
  | "accessory_selection";

export function classifyPurchaseDeliveryOperationalRequestText(
  textRaw: string | null | undefined
): PurchaseDeliveryOperationalRequestKind | null {
  const text = String(textRaw ?? "")
    .toLowerCase()
    .replace(/[’]/g, "'")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return null;
  if (/\b(?:vin|vin\s*#|vehicle identification number)\b/.test(text)) return "vin_request";
  if (/\blift(?:\s+(?:info|information|details))?\b/.test(text)) return "lift_info_request";
  if (
    /\b(?:how many|what(?:'s| is))\b[\s\S]{0,50}\b(?:lbs?|pounds?)\b/.test(text) ||
    /\b(?:weight|weighs?|weigh)\b[\s\S]{0,60}\b(?:bike|motorcycle|unit|it|this)\b/.test(text) ||
    /\b(?:bike|motorcycle|unit|it|this)\b[\s\S]{0,60}\b(?:weight|weighs?|weigh|lbs?|pounds?)\b/.test(text)
  ) {
    return "vehicle_weight_request";
  }
  if (
    /\b(?:did|do|have|has|is|was|can)\b[\s\S]{0,50}\btrade\b[\s\S]{0,60}\b(?:done|complete|completed|finished|through|all set|approved|worked out|work out|go through|go thru)\b/.test(
      text
    ) ||
    /\btrade\s+(?:done|complete|completed|finished|through|all set|approved)\b/.test(text)
  ) {
    return "trade_status_request";
  }
  if (/\b(?:call me|give me a call|can you call|could you call|please call|ring me)\b/.test(text)) {
    return "callback_request";
  }
  if (
    /\b(?:that'?s the ones?|those are the ones?|that one|those ones|that'?s it|that is it)\b[\s\S]{0,80}\b(?:chrome|black|tip|tips|mufflers?|pipes?|exhaust|tabs?|tab performance|khrome|vance|hines|2\s*into\s*1|two\s+into\s+one)\b/.test(
      text
    )
  ) {
    return "accessory_selection";
  }
  return null;
}

export function isPurchaseDeliveryOperationalRequestText(textRaw: string | null | undefined): boolean {
  return classifyPurchaseDeliveryOperationalRequestText(textRaw) !== null;
}

export function buildPurchaseDeliveryOperationalRequestReply(
  kind: PurchaseDeliveryOperationalRequestKind,
  args: { vin?: string | null } = {}
): string {
  if (kind === "vin_request") {
    const vin = String(args.vin ?? "").trim();
    return vin ? `The VIN is ${vin}.` : "I’ll get the VIN for you and send it over.";
  }
  if (kind === "lift_info_request") {
    return "I’ll get the lift info for you and send it over.";
  }
  if (kind === "trade_status_request") {
    return "I’ll check whether the trade is complete and follow up.";
  }
  if (kind === "callback_request") {
    return "Got it — I’ll give you a call.";
  }
  if (kind === "vehicle_weight_request") {
    return "I’ll confirm the weight on the bike and send it over.";
  }
  return "Got it — I’ll note that choice and follow up with the next step.";
}

export function extractRequestedVehicleFactFieldsFromText(textRaw: string | null | undefined): string[] {
  const text = String(textRaw ?? "").toLowerCase();
  if (!text.trim()) return [];
  const fields: string[] = [];
  const add = (field: string) => {
    if (!fields.includes(field)) fields.push(field);
  };
  if (/\b(year|yr)\b/.test(text)) add("year");
  if (/\b(miles?|mileage|odometer)\b/.test(text)) add("mileage");
  if (/\b(price|priced|pricing|asking|cost|total|otd|out the door)\b/.test(text)) add("price");
  if (/\b(color|paint)\b/.test(text)) add("color");
  if (/\b(vin|stock)\b/.test(text)) add("stock/VIN");
  return fields;
}

function formatList(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

export function buildMultiVehicleFactFollowupReply(fields: string[]): string {
  const fieldText = formatList(fields);
  return fieldText
    ? `Got it — I’ll confirm the ${fieldText} on that bike and follow up shortly.`
    : "Got it — I’ll confirm the details on that bike and follow up shortly.";
}

export function formatServiceScheduleTimeLabel(
  timeTokenRaw: string | null | undefined,
  sourceTextRaw: string | null | undefined
): string {
  const source = String(sourceTextRaw ?? "").toLowerCase();
  const original = String(timeTokenRaw ?? "").trim();
  const raw = original.toLowerCase().replace(/\s+/g, "");
  const compact = raw.match(/^(\d{3,4})(am|pm)?$/i);
  const colon = raw.match(/^(\d{1,2}):(\d{2})(am|pm)?$/i);
  let hour = 0;
  let minute = "00";
  let meridiem = "";
  if (compact) {
    const digits = compact[1]!.padStart(4, "0");
    hour = Number(digits.slice(0, 2));
    minute = digits.slice(2, 4);
    meridiem = compact[2] ?? "";
  } else if (colon) {
    hour = Number(colon[1]);
    minute = colon[2] ?? "00";
    meridiem = colon[3] ?? "";
  } else {
    const hourOnly = raw.match(/^(\d{1,2})(am|pm)?$/i);
    if (!hourOnly) return original;
    hour = Number(hourOnly[1]);
    meridiem = hourOnly[2] ?? "";
  }
  if (!Number.isFinite(hour) || hour < 1 || hour > 12) return original;
  if (!meridiem) {
    if (/\b(afternoon|evening)\b/.test(source) || /\bafter\s+\d{1,2}(?::?\d{2})?\b/.test(source)) {
      meridiem = "pm";
    } else if (/\bmorning\b/.test(source)) {
      meridiem = hour === 12 ? "pm" : "am";
    } else {
      meridiem = hour >= 7 && hour <= 11 ? "am" : "pm";
    }
  }
  const suffix = meridiem.toLowerCase() === "am" ? "AM" : "PM";
  return `${hour}:${minute} ${suffix}`;
}

export function isServiceSchedulingAvailabilityRequestText(textRaw: string | null | undefined): boolean {
  const text = String(textRaw ?? "").toLowerCase().replace(/\s+/g, " ").trim();
  if (!text) return false;
  return /\b(appointment|appt|schedule|available|availability|openings?|anything|any time|time|after\s+\d{1,2}|before\s+\d{1,2}|morning|afternoon|evening)\b/.test(
    text
  );
}

export function isManualOutboundBookingConfirmationText(textRaw: string | null | undefined): boolean {
  const text = String(textRaw ?? "").toLowerCase();
  if (!text.trim()) return false;
  if (isManualOutboundTentativeScheduleOfferText(text)) return false;
  return (
    /\b(you(?:'|’)re|you are)\s+(all set|booked|confirmed)\b/i.test(text) ||
    /\b(booked for|confirmed for|appointment(?: is)? set|see you then|locked in)\b/i.test(text) ||
    /\b(?:i|we)\s*(?:'|’)?ll\s+(?:schedule|book|set(?:\s+up)?)\b[\s\S]{0,80}\b(?:for|on|at|in|between|from)\b/i.test(
      text
    ) ||
    /\b(?:i|we)\s+will\s+(?:schedule|book|set(?:\s+up)?)\b[\s\S]{0,80}\b(?:for|on|at|in|between|from)\b/i.test(
      text
    ) ||
    /\b(?:i|we)\s+will\s+have\s+you\s+meet\b[\s\S]{0,120}\b(?:today|tomorrow|monday|mon|tuesday|tue|wednesday|wed|thursday|thu|friday|fri|saturday|sat|sunday|sun)\b/i.test(
      text
    ) ||
    /\b(?:scheduled|booked|set(?:\s+up)?)\b[\s\S]{0,80}\b(?:for|on|at)\b/i.test(text)
  );
}

export function isManualOutboundTentativeScheduleOfferText(textRaw: string | null | undefined): boolean {
  const text = String(textRaw ?? "").toLowerCase().replace(/\s+/g, " ").trim();
  if (!text) return false;
  const hasScheduleSignal =
    /\b(today|tomorrow|monday|mon|tuesday|tue|wednesday|wed|thursday|thu|friday|fri|saturday|sat|sunday|sun)\b/i.test(
      text
    ) ||
    /\b\d{1,2}(?::\d{2})?\s*(?:am|pm)?\b/i.test(text) ||
    /\b(morning|afternoon|evening|noon)\b/i.test(text);
  if (!hasScheduleSignal) return false;
  return /\b(if\s+(that|this|it)\s+works?|if\s+(that|this|it)(?:'s| is)?\s+ok(?:ay)?|if\s+you\s+can\s+make\s+(that|this|it)\s+work|does\s+(that|this|it)\s+work)\b/i.test(
    text
  );
}

export function isBlockedCadencePersonalizationLineText(lineRaw: string | null | undefined): boolean {
  const line = String(lineRaw ?? "").trim();
  if (!line) return false;
  if (
    /\b(photo|photos|pic|pics|picture|pictures|image|images|video|walkaround|walk around)\b/i.test(line) &&
    /\b(helped|sent|attached|showed|shared|gave you|got those|came through|received)\b/i.test(line)
  ) {
    return true;
  }
  if (/\brecommendations?\b[\s\S]{0,80}\bhelped\b|\bhelped narrow your options\b/i.test(line)) {
    return true;
  }
  return false;
}

export function allowNoResponseSmallTalkAck(args: {
  smallTalk: boolean;
  financeSignal?: boolean;
  availabilitySignal?: boolean;
  schedulingSignal?: boolean;
  callbackSignal?: boolean;
}): boolean {
  if (!args.smallTalk) return false;
  return !(
    args.financeSignal ||
    args.availabilitySignal ||
    args.schedulingSignal ||
    args.callbackSignal
  );
}

export function allowComplimentOnlyReply(args: {
  complimentOnly: boolean;
  financeSignal?: boolean;
  availabilitySignal?: boolean;
  schedulingSignal?: boolean;
  callbackSignal?: boolean;
}): boolean {
  if (!args.complimentOnly) return false;
  return !(
    args.financeSignal ||
    args.availabilitySignal ||
    args.schedulingSignal ||
    args.callbackSignal
  );
}

export function isCloseoutSignoffNoResponseText(textRaw: string | null | undefined): boolean {
  const text = String(textRaw ?? "")
    .toLowerCase()
    .replace(/[.!]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return false;
  if (/[?]/.test(String(textRaw ?? ""))) return false;
  if (
    /\b(?:call|text|appointment|schedule|book|available|availability|price|pricing|payment|trade|inventory|stock|test ride|ride today|come in|stop in)\b/i.test(
      text
    )
  ) {
    return false;
  }
  return /^(?:talk soon|talk to you soon|talk with you soon|see you soon|catch you later|catch you soon|sounds good talk soon|ok talk soon|okay talk soon)$/.test(
    text
  );
}

export function isImmediateChatCallbackAvailabilityText(textRaw: string | null | undefined): boolean {
  const text = String(textRaw ?? "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return false;
  if (/\b(?:text|email)\b/.test(text) && /\b(?:only|instead|rather|prefer)\b/.test(text)) {
    return false;
  }
  if (/\b(?:don['’]?t|do not|no)\s+(?:call|phone)\b/.test(text)) return false;
  const availableNow =
    /\b(?:i(?:'|’)?m|i am|im)\s+(?:available|free|open)\b[\s\S]{0,80}\b(?:right now|now|currently)\b/.test(
      text
    ) ||
    /\b(?:available|free|open)\b[\s\S]{0,80}\b(?:right now|now|currently)\b/.test(text);
  const chatSignal = /\b(?:chat|talk|speak|hop on (?:a )?call|jump on (?:a )?call)\b/.test(text);
  return availableNow && chatSignal;
}

export function isExplicitCustomerCallbackRequestText(textRaw: string | null | undefined): boolean {
  const text = String(textRaw ?? "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return false;
  if (isCustomerReturningCallText(text)) return false;
  if (/\b(?:text|email)\b/.test(text) && /\b(?:only|instead|rather|prefer)\b/.test(text)) return false;
  if (/\b(?:don['’]?t|do not|no)\s+(?:call|phone)\b/.test(text)) return false;
  return (
    /\b(?:can|could|would|will)\s+you\s+(?:please\s+)?(?:give me a call|call me|phone me|ring me)\b/.test(
      text
    ) ||
    /\b(?:please\s+)?(?:give|shoot)\s+me\s+(?:a\s+)?call\b/.test(text) ||
    /\b(?:please\s+)?call\s+me(?:\s+back)?\b/.test(text) ||
    /\bhave\s+[\w .'-]{1,40}\s+call\s+me\b/.test(text)
  );
}

export function isDealershipLocationQuestionText(textRaw: string | null | undefined): boolean {
  const text = String(textRaw ?? "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return false;
  if (/\b(?:email|billing|shipping|mailing|home|my)\s+address\b/.test(text)) return false;
  return (
    /\bwhere\s+(?:are\s+you|is\s+(?:this|it|the\s+(?:dealership|store))|are\s+you\s+located)\b/.test(
      text
    ) ||
    /\bwhat(?:'s| is)?\s+(?:your|the)?\s*(?:store\s+|dealership\s+)?address\b/.test(text) ||
    /\bremind\s+me(?:\s+again)?\s+what\s+address\b/.test(text) ||
    /\b(?:what|which)\s+location\b/.test(text)
  );
}

/**
 * Parser-first visit-commitment precedence (AGENTS.md "Twilio conversations:
 * comprehend, never regex"). A recognized future-day VISIT COMMITMENT — what the
 * inbound_reply_action parser classifies as `schedule_context_status_update`
 * ("I'll be there Saturday for the show", "see you Saturday", "count me in for
 * Saturday") — confirms the committed day and must outrank the appointment-timing
 * / customer-ack ARRIVAL-WINDOW ack ("I'll check that time and follow up"), which
 * only fits a same-day, en-route ETA.
 *
 * This retires the old `isScheduleContextStatusUpdateText` regex: comprehension is
 * the parser's job, this is pure routing precedence. Production miss it fixes:
 * Todd Herian +15673079691, 2026-06-13 — after a Road Glide test-ride thread,
 * "Ok I will be there for the taste of country pre party on Saturday" was
 * downgraded to the arrival ack.
 *
 * It fires only inside an active schedule/visit context (so it can never hijack an
 * unrelated turn) and mirrors the schedule_context_status_update handler's own
 * guards, so suppressing the arrival ack always hands the turn to that handler.
 * This is the template for the remaining Twilio comprehension-guard migrations.
 */
export function scheduleStatusCommitmentOutranksArrivalAck(args: {
  parserScheduleStatusUpdate: boolean;
  scheduleDialogState: boolean;
  scheduleOfferContext: boolean;
}): boolean {
  return (
    !!args.parserScheduleStatusUpdate &&
    !!args.scheduleDialogState &&
    !!args.scheduleOfferContext
  );
}

export function isBusinessHoursQuestionText(textRaw: string | null | undefined): boolean {
  const text = String(textRaw ?? "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return false;
  const incidentalAfterHours =
    /\b(after|outside of|past)\s+(?:business\s+|store\s+)?hours?\b/.test(text) &&
    !/\b(?:what|when|how late|how long|until|til|till|open|opened|close|closed|closing|business hours|store hours)\b/.test(
      text.replace(/\b(after|outside of|past)\s+(?:business\s+|store\s+)?hours?\b/g, "")
    );
  if (incidentalAfterHours) return false;
  const hoursWordText = text.replace(/\b(?:after|outside of|past)\s+(?:business\s+|store\s+)?hours?\b/g, "");
  const hasQuestionShape =
    /[?]/.test(String(textRaw ?? "")) ||
    /\b(what|when|how late|how long|until|til|till|thru|through)\b/.test(text);
  const hasHoursWord = /\bhours?\b/.test(hoursWordText);
  const hasOpenClose =
    /\bopen(?:ed)?\b/.test(text) || /\bclos(?:e|ed|es|ing)\b/.test(text);
  const hasCloseTimePhrase =
    /\b(?:open|there)\s+(?:until|til|till|thru|through)\s+(?:when|what time|how late)\b/.test(text) ||
    /\b(?:until|til|till)\s+(?:when|what time|how late)\b/.test(text) ||
    /\bhow late\b[\s\S]{0,40}\b(?:open|there)\b/.test(text) ||
    /\bwhat time\b[\s\S]{0,40}\b(?:open|close|closed|closing)\b/.test(text) ||
    /\bwhen\b[\s\S]{0,40}\b(?:open|close|closed|closing)\b/.test(text);
  const hasOpeningHoursPhrase = /\b(opening hours|closing time|business hours|store hours)\b/.test(text);
  return hasOpeningHoursPhrase || hasCloseTimePhrase || (hasHoursWord && hasQuestionShape) || (hasOpenClose && hasQuestionShape);
}

export function getScheduleDayOptionsLabel(textRaw: string | null | undefined): string | null {
  const text = String(textRaw ?? "");
  if (!text.trim()) return null;
  const dayMatches = Array.from(
    text.matchAll(
      /\b(monday|mon|tuesday|tue|tues|wednesday|wed|thursday|thu|thur|thurs|friday|fri|saturday|sat|sunday|sun)\b/gi
    )
  );
  const dayMap: Record<string, string> = {
    mon: "Monday",
    monday: "Monday",
    tue: "Tuesday",
    tues: "Tuesday",
    tuesday: "Tuesday",
    wed: "Wednesday",
    wednesday: "Wednesday",
    thu: "Thursday",
    thur: "Thursday",
    thurs: "Thursday",
    thursday: "Thursday",
    fri: "Friday",
    friday: "Friday",
    sat: "Saturday",
    saturday: "Saturday",
    sun: "Sunday",
    sunday: "Sunday"
  };
  const orderedUnique: string[] = [];
  for (const match of dayMatches) {
    const label = dayMap[String(match[1] ?? "").toLowerCase()];
    if (label && !orderedUnique.includes(label)) orderedUnique.push(label);
  }
  if (orderedUnique.length < 2) return null;
  if (orderedUnique.length === 2) return `${orderedUnique[0]} or ${orderedUnique[1]}`;
  return `${orderedUnique.slice(0, -1).join(", ")}, or ${orderedUnique[orderedUnique.length - 1]}`;
}

function isWorkflowEmojiOnlyText(text: string): boolean {
  const t = String(text ?? "").trim();
  return t.length > 0 && /^[\p{Extended_Pictographic}\s]+$/u.test(t);
}

export function isShortAckNoReplyText(textRaw: string | null | undefined): boolean {
  const t = String(textRaw ?? "")
    .trim()
    .toLowerCase();
  if (!t) return false;
  if (isWorkflowEmojiOnlyText(t)) return true;
  if (t.length > 60) return false;
  if (/[?]/.test(t)) return false;
  // Day-part replies are scheduling language, not sign-offs: "Afternoon would
  // be great" (Al Davis 2026-06-06) matched "great" here and the turn was
  // silently dropped, so the Saturday-afternoon booking never happened.
  if (
    /\b(price|pricing|payment|monthly|apr|term|down payment|trade|trade in|service|parts|apparel|available|availability|in stock|stock|test ride|appointment|schedule|call|video|photos?|email|watch|morning|afternoon|evening)\b/i.test(
      t
    )
  ) {
    return false;
  }
  return /\b(thanks|thank you|thanks again|thx|ty|appreciate|got it|sounds good|sounds great|will do|ok|okay|k|kk|cool|perfect|great|all good|no problem|you bet|yep|yup|sure)\b/.test(
    t
  );
}

export function shouldRebaseWeekdayReplyToPriorNextWeek(
  inboundTextRaw: string | null | undefined,
  lastOutboundTextRaw: string | null | undefined
): boolean {
  const inbound = String(inboundTextRaw ?? "").toLowerCase();
  const lastOutbound = String(lastOutboundTextRaw ?? "").toLowerCase();
  if (!inbound.trim() || !lastOutbound.trim()) return false;
  if (!/\bnext week\b/.test(lastOutbound)) return false;
  if (!/\b(?:monday|mon|tuesday|tue|tues|wednesday|wed|thursday|thu|thur|thurs|friday|fri|saturday|sat|sunday|sun)\b/.test(inbound)) {
    return false;
  }
  if (/\b(?:next|this)\s+(?:monday|mon|tuesday|tue|tues|wednesday|wed|thursday|thu|thur|thurs|friday|fri|saturday|sat|sunday|sun)\b/.test(inbound)) {
    return false;
  }
  if (/\b(today|tomorrow)\b/.test(inbound)) return false;
  if (/\b\d{1,2}[/-]\d{1,2}\b/.test(inbound)) return false;
  if (/\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\s+\d{1,2}\b/.test(inbound)) {
    return false;
  }
  return true;
}

export function inferAcceptedScheduleDayFromReplyText(
  lastOutboundTextRaw: string | null | undefined
): string | null {
  const text = String(lastOutboundTextRaw ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return null;
  const chunks = String(lastOutboundTextRaw ?? "")
    .split(/[\r\n]+|(?<=[.!?])\s+/)
    .map(s => s.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  const acceptedSchedulePhrase =
    /\b(can work|works|schedule you in|what time|let me know what time|time were you thinking|time works)\b/i;
  const dayPattern =
    /\b(monday|mon|tuesday|tue|tues|wednesday|wed|thursday|thu|thur|thurs|friday|fri|saturday|sat|sunday|sun)\b/i;
  const match = chunks
    .filter(chunk => acceptedSchedulePhrase.test(chunk))
    .map(chunk => chunk.match(dayPattern))
    .find(Boolean);
  if (!match?.[1]) return null;
  const day = match[1].toLowerCase();
  const map: Record<string, string> = {
    mon: "Monday",
    monday: "Monday",
    tue: "Tuesday",
    tues: "Tuesday",
    tuesday: "Tuesday",
    wed: "Wednesday",
    wednesday: "Wednesday",
    thu: "Thursday",
    thur: "Thursday",
    thurs: "Thursday",
    thursday: "Thursday",
    fri: "Friday",
    friday: "Friday",
    sat: "Saturday",
    saturday: "Saturday",
    sun: "Sunday",
    sunday: "Sunday"
  };
  return map[day] ?? null;
}

export function hasExplicitCalendarDateForScheduleMemory(textRaw: string | null | undefined): boolean {
  const text = String(textRaw ?? "");
  if (!text.trim()) return false;
  if (
    /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d{1,2}(?:st|nd|rd|th)?\b/i.test(
      text
    ) ||
    /\b\d{1,2}(?:st|nd|rd|th)?\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\b/i.test(
      text
    )
  ) {
    return true;
  }
  const numericDate = /\b\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?\b/g;
  for (const match of text.matchAll(numericDate)) {
    const index = match.index ?? 0;
    const after = text.slice(index + match[0].length, index + match[0].length + 40).toLowerCase();
    const before = text.slice(Math.max(0, index - 25), index).toLowerCase();
    if (
      /\b(?:to\s+get|to\s+arrive|away|drive|traffic|pending|hour|hours|hr|hrs|minute|minutes|min|mins)\b/i.test(
        after
      ) ||
      /\b(?:about|around|roughly|approx|approximately)\s*$/i.test(before)
    ) {
      continue;
    }
    return true;
  }
  return false;
}

export function shouldSuppressInitialInventoryPhotoAppend(draftRaw: string | null | undefined): boolean {
  const draft = String(draftRaw ?? "");
  if (!draft.trim()) return false;
  return (
    /\b(?:i['’]?m|we['’]?re)\s+not\s+seeing\b[\s\S]{0,120}\bin\s+stock\b/i.test(draft) ||
    /\bnot\s+seeing\b[\s\S]{0,120}\bavailable\s+for\s+a\s+test\s+ride\b/i.test(draft) ||
    /\bdon['’]?t\s+want\s+to\s+book\b[\s\S]{0,120}\bbike\s+we\s+don['’]?t\s+have\b/i.test(draft) ||
    /\bdon['’]?t\s+want\s+to\s+schedule\b[\s\S]{0,120}\bbike\s+we\s+don['’]?t\s+currently\s+have\b/i.test(draft)
  );
}

export function shouldSuppressInitialAvailabilityLineAppend(draftRaw: string | null | undefined): boolean {
  const draft = String(draftRaw ?? "").toLowerCase();
  if (!draft.trim()) return false;
  return (
    /\bwhich model\b|\bwhat model\b|\btrim or color\b/i.test(draft) ||
    /\binterested in a test ride\b[\s\S]{0,120}\bwhat day works best\b/i.test(draft) ||
    /\btest ride\b[\s\S]{0,120}\bwhat day works best\b/i.test(draft) ||
    /\bi (?:just )?saw you wanted to learn more\b|\binterested in checking it out\b/i.test(draft) ||
    /\b(payment|monthly|apr|down payment|down|budget|finance|financing|credit app|credit application|term)\b/i.test(
      draft
    ) ||
    /\b(checking it out|come by|stop in|stop by|take a look|in stock|available|on hold|frees up|no longer available|sold)\b/i.test(
      draft
    )
  );
}

export function isHiringManagerInquiryText(textRaw: string | null | undefined): boolean {
  const text = String(textRaw ?? "").toLowerCase();
  if (!text.trim()) return false;
  if (/\b(prequal|pre-qualified|prequalified|credit app|credit application|finance application|approval|hdfs|coa)\b/i.test(text)) {
    return false;
  }
  return (
    /\b(hiring manager|manager (?:for|about) (?:hiring|jobs?|careers?|employment)|who (?:is|do i contact).{0,80}(?:hiring|jobs?|careers?|employment))\b/i.test(
      text
    ) ||
    /\b(apply for (?:a )?(?:job|position)|resume|job opening|job openings|career|careers|employment|hiring)\b/i.test(text)
  );
}

export function buildHiringManagerInquiryReply(): string {
  return "Thanks for reaching out. I’ll pass your message along and have the hiring manager follow up with you.";
}

export function isInventoryOnlineCompletenessQuestionText(textRaw: string | null | undefined): boolean {
  const text = String(textRaw ?? "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return false;
  return (
    /\b(?:all|everything|entire|full)\b[\s\S]{0,50}\b(?:inventory|bikes?|units?|motorcycles?)\b[\s\S]{0,50}\b(?:online|website|site|web|posted|listed)\b/i.test(
      text
    ) ||
    /\b(?:inventory|bikes?|units?|motorcycles?)\b[\s\S]{0,50}\b(?:all|everything|entire|full)\b[\s\S]{0,50}\b(?:online|website|site|web|posted|listed)\b/i.test(
      text
    ) ||
    /\b(?:inventory|bikes?|units?|motorcycles?)\b[\s\S]{0,50}\b(?:not\s+(?:on|listed\s+on|posted\s+on)\s+(?:the\s+)?(?:website|site|web)|not\s+(?:listed|posted)\s+online)\b/i.test(
      text
    ) ||
    /\b(?:do you|you guys|y'?all|u)\s+(?:have|got)\b[\s\S]{0,60}\b(?:not\s+(?:on|listed\s+on|posted\s+on)\s+(?:the\s+)?(?:website|site|web)|not\s+(?:listed|posted)\s+online)\b/i.test(
      text
    )
  );
}

export function buildInventoryOnlineCompletenessReply(): string {
  return "We do have some bikes here that may not be on the website yet. Is there a certain model you’re looking for?";
}

export function isRideChallengeLeadSignal(args: {
  leadSource?: string | null;
  inquiry?: string | null;
  journeyText?: string | null;
}): boolean {
  const source = String(args.leadSource ?? "");
  const inquiry = String(args.inquiry ?? "");
  const journey = String(args.journeyText ?? "");
  return (
    /ride challenge|challenge signup|miles challenge/i.test(source) ||
    /ride challenge|challenge signup|record your miles/i.test(journey) ||
    /ride challenge|challenge signup|record your miles/i.test(inquiry)
  );
}

export function hasRideChallengeSignupAcknowledgement(
  messages: Array<{ direction?: string | null; body?: string | null }> | null | undefined
): boolean {
  return (messages ?? []).some(m => {
    if (String(m?.direction ?? "").toLowerCase() !== "out") return false;
    const body = String(m?.body ?? "");
    return /\bthanks for signing up\b[\s\S]{0,120}\b(?:ride challenge|record your miles)\b/i.test(body);
  });
}

export function buildRideChallengeSignupReply(args: {
  firstName?: string | null;
  agentName?: string | null;
  dealerName?: string | null;
}): string {
  const firstName = String(args.firstName ?? "").trim() || "there";
  const agentName = String(args.agentName ?? "").trim() || "Alexandra";
  const dealerName = String(args.dealerName ?? "").trim() || "American Harley-Davidson";
  return (
    `Hi ${firstName} — this is ${agentName} at ${dealerName}. ` +
    "Thanks for signing up for this year's ride challenge. " +
    "Feel free to stop in and record your miles throughout the year. " +
    "Let us know if you need anything to keep your bike rolling through the challenge!"
  );
}

export function isDemoDayEventQuestionText(textRaw: string | null | undefined): boolean {
  const text = String(textRaw ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
  if (!text) return false;
  const hasDemoEvent =
    /\b(demo day|demo days|demo event|demo ride event|test ride days?|ride event|ride challenge|kawasaki demo)\b/i.test(
      text
    ) || /\bdemo\b[\s\S]{0,40}\b(kawasaki|event|day|days|ride)\b/i.test(text);
  if (!hasDemoEvent) return false;
  return (
    /\b(do you|are you|have|having|got|offer|sign(?:ing)? up|signup|signed up|let me know|when|if)\b/i.test(
      text
    ) || /\?/.test(text)
  );
}

export function isDealerLeadAppPostDemoRideAdfText(textRaw: string | null | undefined): boolean {
  return /\b(?:event name:\s*dealer test ride|demo bikes ridden|dealer lead app|lead app\s*-\s*type:\s*y)\b/i.test(
    String(textRaw ?? "")
  );
}

function extractDealerLeadAppDemoBikesRawValue(textRaw: string | null | undefined): string {
  const text = String(textRaw ?? "");
  if (!text) return "";
  const match = text.match(
    /\bdemo bikes ridden\s*:\s*([\s\S]*?)(?:\bemail opt-?in\s*:|\bphone opt-?in\s*:|\btext opt-?in\s*:|\bclient_id\s*:|$)/i
  );
  return String(match?.[1] ?? "").trim();
}

export function isDealerLeadAppNoDemoRideAdfText(textRaw: string | null | undefined): boolean {
  const rawValue = extractDealerLeadAppDemoBikesRawValue(textRaw);
  if (!rawValue) return false;
  const normalized = rawValue
    .replace(/[.\s-]+$/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  if (!normalized) return false;
  return /^(?:none|none recorded|no|n\/a|na|not applicable|not recorded)$/i.test(normalized);
}

export function isDealerLeadAppConfirmedDemoRideAdfText(textRaw: string | null | undefined): boolean {
  const text = String(textRaw ?? "");
  if (!text) return false;
  if (isDealerLeadAppNoDemoRideAdfText(text)) return false;
  if (/\bevent name:\s*dealer test ride\b/i.test(text)) return true;
  if (/\blead app\s*-\s*type:\s*y\b/i.test(text)) return true;
  return !!extractDealerLeadAppDemoBikesRawValue(text);
}

export function isDealerLeadAppWithoutConfirmedDemoRideAdfText(textRaw: string | null | undefined): boolean {
  const text = String(textRaw ?? "");
  if (!/\bdealer lead app\b/i.test(text)) return false;
  return !isDealerLeadAppConfirmedDemoRideAdfText(text);
}

function titleCaseDealerLeadAppToken(raw: string): string {
  const normalized = String(raw ?? "")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  if (!normalized) return "";
  return normalized.replace(/\b[a-z0-9]+(?:'[a-z]+)?\b/g, token => {
    if (/^hd$/i.test(token)) return "H-D";
    if (/^\d+$/.test(token)) return token;
    return token.charAt(0).toUpperCase() + token.slice(1);
  });
}

export function extractDealerLeadAppDemoBikeLabel(textRaw: string | null | undefined): string | null {
  if (isDealerLeadAppNoDemoRideAdfText(textRaw)) return null;
  const rawValue = extractDealerLeadAppDemoBikesRawValue(textRaw);
  if (!rawValue) return null;
  const parts = rawValue
    .split(/[,\n\r]+/)
    .map(part => titleCaseDealerLeadAppToken(part))
    .filter(Boolean);
  if (!parts.length) return null;
  const yearIndex = parts.findIndex(part => /^(?:19|20)\d{2}$/.test(part));
  const year = yearIndex >= 0 ? parts[yearIndex] : "";
  const labelParts = parts.filter((_, index) => index !== yearIndex);
  const label = [year, ...labelParts].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
  return label || null;
}

export function extractInventoryStockIdMention(textRaw: string | null | undefined): string | null {
  const match = String(textRaw ?? "").match(/\b[A-Z0-9]{1,5}-\d{1,4}\b/i);
  return match?.[0] ? match[0].toUpperCase() : null;
}

export function isStockNumberInventoryInterestText(textRaw: string | null | undefined): boolean {
  const text = String(textRaw ?? "");
  const stockId = extractInventoryStockIdMention(text);
  if (!stockId) return false;
  return (
    /\b(interested|looking|look at|checking|asking|ask about|want|like|love|available|availability|in stock|still there|still have|have|stock|bike|street glide|road glide|breakout|low rider|heritage|nightster|sportster|pan america|trike)\b/i.test(
      text
    ) || text.trim().toUpperCase() === stockId
  );
}

export function isAudioDemoStatusQuestionText(textRaw: string | null | undefined): boolean {
  const text = String(textRaw ?? "").toLowerCase();
  if (!text.trim()) return false;
  return (
    /\b(?:did you|get|got|have|find|hear back|any update)\b[\s\S]{0,80}\b(?:stereo|radio|audio|sound system|speakers?)\b/i.test(
      text
    ) ||
    /\b(?:stereo|radio|audio|sound system|speakers?)\b[\s\S]{0,80}\b(?:to hear|hear yet|listen|demo|update|status)\b/i.test(
      text
    )
  );
}

export function buildAudioDemoStatusReply(args?: { acceptedDay?: string | null; hasHumor?: boolean }): string {
  const acceptedDay = String(args?.acceptedDay ?? "").trim().toLowerCase();
  const opener = args?.hasHumor ? "Haha, gotcha — " : "";
  const dayClause = acceptedDay ? ` ${acceptedDay}` : "";
  const scheduleLine = acceptedDay
    ? ` What time${dayClause} works best?`
    : "";
  return `${opener}I’ll check on the stereo for you and follow up shortly.${scheduleLine}`.trim();
}

export function isInventoryBrowseLinkRequestText(textRaw: string | null | undefined): boolean {
  const text = String(textRaw ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
  if (!text) return false;

  const asksForExplicitLink =
    /\b(?:send|share|get|give|text)\b[\s\S]{0,40}\b(?:inventory|link|url|website|site|selection|list)\b/.test(
      text
    ) ||
    /\b(?:inventory|link|url|website|site|selection|list)\b[\s\S]{0,40}\b(?:send|share|get|give|text|browse|see|view|look at|check)\b/.test(
      text
    );
  if (asksForExplicitLink) return true;

  const asksForInventoryList =
    /\b(?:send|share|get|give|text|show)\b[\s\S]{0,40}\b(?:bikes?|units?)\b[\s\S]{0,40}\b(?:available|in stock|you have|on hand)\b/.test(
      text
    ) ||
    /\b(?:what|which)\b[\s\S]{0,20}\b(?:bikes?|units?)\b[\s\S]{0,40}\b(?:available|in stock|you have|on hand)\b/.test(
      text
    ) ||
    /\bwhat do you have\b/.test(text);

  return asksForInventoryList;
}

export function isDirectInventoryAvailabilityQuestionText(textRaw: string | null | undefined): boolean {
  const text = String(textRaw ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
  if (!text) return false;

  return (
    /\b(?:in[-\s]?stock|still in stock|stock)\b/.test(text) ||
    /\b(?:do you|do u|you guys|y'all|ya'll)\b[\s\S]{0,70}\b(?:have|got|carry)\b/.test(text) ||
    /\b(?:have|got)\s+any\b/.test(text) ||
    /\b(?:still|is it|is this|is that|this one|that one)\s+(?:one\s+)?available\b/.test(text) ||
    /\bavailability\b/.test(text) ||
    /\bwhat do you have\b/.test(text)
  );
}

export function isIncidentalInfoAcknowledgementText(textRaw: string | null | undefined): boolean {
  const text = String(textRaw ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
  if (!text) return false;
  const hasInfoThanks = /\b(?:thanks?|thank you)\b[\s\S]{0,40}\binfo(?:rmation)?\b/.test(text);
  if (!hasInfoThanks) return false;
  return !/\b(?:send|show|give|need|want|looking for|tell me|can you|could you|would you|specs?|details|more info|more information|information on|details on)\b/.test(
    text
  );
}

export function isRegenerateSchedulingLanguageText(textRaw: string | null | undefined): boolean {
  const text = String(textRaw ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
  if (!text) return false;
  return /\b(schedule|book|appointments?|appt|what time|what day|works for you|come in|stop by|stop in|today|tomorrow|this week|next week|later this month|this month|same time|that time|earlier|later)\b/i.test(
    text
  );
}

export function getBroadScheduleWindowLabel(textRaw: string | null | undefined): string | null {
  const text = String(textRaw ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
  if (!text) return null;
  if (/\blater this month\b/.test(text)) return "later this month";
  if (/\bthis month\b/.test(text)) return "this month";
  return null;
}

export function isNonComplimentLikePhraseText(textRaw: string | null | undefined): boolean {
  const text = String(textRaw ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
  if (!text) return false;
  return (
    /\blike i (?:said|mentioned|told you)\b/.test(text) ||
    /\b(?:ended up\s+)?bought\s+(?:a|an|one|the|another)?[\s\S]{0,90}\b(?:\d{4}|bike|motorcycle|harley|street glide|road glide|softail|sportster|low rider|heritage)\b/.test(
      text
    )
  );
}

export function isMediaProofStatusUpdateText(textRaw: string | null | undefined): boolean {
  const text = String(textRaw ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
  if (!text) return false;
  return (
    /\b(legit|proof|document|paperwork|insurance|binder|id card|driver'?s? license|drivers? license|title|registration|certified check|cashier'?s check|bank check)\b/.test(
      text
    ) ||
    /\b(here|sent|attached|uploading|adding)\b[\s\S]{0,40}\b(it|this|that|card|doc|document|photo|picture|image)\b/.test(
      text
    )
  );
}

export function isPurchaseDeliveryContextText(textRaw: string | null | undefined): boolean {
  const text = String(textRaw ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
  if (!text) return false;
  const hasDeliveryOrPurchaseSignal =
    /\b(pick(?:ing)? up|pickup|take delivery|delivery|deliver|sale (?:was )?finalized|sale finalized|finalize(?:d|ing)? (?:the )?(?:sale|deal)|buy(?:ing)? the bike|buy(?:ing)? it|purchas(?:e|ing)|taking it home)\b/.test(
      text
    ) ||
    /\b(loan(?:s)? finalized|loan(?:s)? approved|bank|insurance paperwork|insurance card|proof of insurance|title|registration|certified check|cashier'?s check)\b/.test(
      text
    ) ||
    /\b(i don'?t wanna miss out on (?:the )?bike|i do not want to miss out on (?:the )?bike|what time works for you today|get rolling on everything|everything lined up before you get here)\b/.test(
      text
    );
  if (!hasDeliveryOrPurchaseSignal) return false;
  const tradeOnly =
    /\b(trade appraisal|appraisal request|professional evaluation|evaluate (?:my|your|the) trade|pick your trade in up|pickup for (?:the )?trade)\b/.test(
      text
    ) && !/\b(loan(?:s)? finalized|insurance paperwork|pick up bike|pick up the bike|taking it home|delivery|certified check)\b/.test(text);
  return !tradeOnly;
}

export function isPurchaseDeliveryTimingText(textRaw: string | null | undefined): boolean {
  const text = String(textRaw ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
  if (!text) return false;
  return (
    /\b(early|mid|late)\s+(morning|afternoon|evening)(?:\s*ish)?\b/.test(text) ||
    /\b\d{1,2}(?::\d{2})?\s*(?:-|to|and|\/)\s*\d{1,2}(?::\d{2})?\s*(?:am|pm|o'?clock)?(?:\s*ish)?\b/.test(
      text
    ) ||
    /\b(?:around|about|approx(?:imately)?|close to)?\s*\d{1,2}(?::\d{2})?\s*(?:am|pm|o'?clock)(?:\s*ish)?\b/.test(
      text
    )
  );
}

export function shouldClearPickupStateForSchedulingReply(args: {
  inboundText?: string | null;
  lastOutboundText?: string | null;
  dialogState?: string | null;
}): boolean {
  const inbound = String(args.inboundText ?? "").toLowerCase();
  const lastOutbound = String(args.lastOutboundText ?? "").toLowerCase();
  const dialogState = String(args.dialogState ?? "").toLowerCase();
  if (!inbound.trim()) return false;
  if (/\b(pick[-\s]?up|pickup|come get|driver|tow|trailer)\b/i.test(inbound)) {
    return false;
  }
  const scheduleContext =
    /\b(schedule|appointment|test_ride|test ride|demo ride)\b/.test(dialogState) ||
    /\b(what time|what day|day and time|schedule you in|schedule|appointment|test ride|demo ride)\b/i.test(
      lastOutbound
    );
  if (!scheduleContext) return false;
  const scheduleReply =
    /\b(morning|afternoon|evening|today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i.test(
      inbound
    ) ||
    /\b\d{1,2}(?::\d{2})?\s*(?:am|pm)\b/i.test(inbound) ||
    /\bbetween\s+\d{1,2}(?::\d{2})?\s*(?:and|-|to)\s*\d{1,2}(?::\d{2})?\b/i.test(inbound) ||
    /\btext you when i leave\b/i.test(inbound);
  return scheduleReply;
}

type AvailabilityModelMention = {
  model?: string | null;
  index?: number | null;
};

function normalizeAvailabilityModelMentionText(textRaw: string | null | undefined): string {
  return String(textRaw ?? "")
    .toLowerCase()
    .replace(/\bstreet\s+glides\b/g, "street glide")
    .replace(/\broad\s+glides\b/g, "road glide")
    .replace(/\bbreakouts\b/g, "breakout")
    .replace(/\bsportsters\b/g, "sportster")
    .replace(/\bnightsters\b/g, "nightster")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// A model named as the customer's CURRENT/owned bike is not a request — it is
// the comparison or trade (Todd Herian 2026-06-13: "as long as it's a roadglide
// compared to my current ultra limited" had the agent offer Ultra Limiteds).
function isOwnedOrComparisonReference(before: string): boolean {
  return (
    // "compared to my current ___", "than my ___", "vs my ___", "against ___"
    /\b(?:compared\s+to|versus|vs\.?|than|over|against)\s+(?:my\s+)?(?:current\s+|old\s+|existing\s+)?$/.test(
      before
    ) ||
    // "my ___", "my current ___", "my old ___" (possessive, not "do you have")
    /\bmy\s+(?:current\s+|old\s+|existing\s+)?$/.test(before) ||
    // first-person ownership only — "i have/own/ride a ___" (never "you have a")
    /\bi\s+(?:currently\s+)?(?:ride|own|have|drive|got)\s+(?:a\s+|an\s+|my\s+)?$/.test(before) ||
    // "trading in my ___", "trade-in ___", "current ___"
    /\b(?:trading\s+in|trade\s*in|trading)\s+(?:my\s+|a\s+|an\s+)?(?:current\s+|old\s+)?$/.test(before) ||
    /\bcurrent\s+$/.test(before) ||
    /\b(lighter|smaller|bigger|larger|heavier|easier|more manageable)\b.{0,50}\bthan(?: the)?\s*$/.test(
      before
    )
  );
}

export function selectRequestedAvailabilityModelMentions(
  textRaw: string | null | undefined,
  candidates: AvailabilityModelMention[]
): string[] {
  const normalizedText = normalizeAvailabilityModelMentionText(textRaw);
  if (!normalizedText || !candidates.length) return [];
  const referenceFor = (candidate: AvailabilityModelMention): boolean => {
    const normalizedModel = normalizeAvailabilityModelMentionText(String(candidate.model ?? ""));
    if (!normalizedModel) return false;
    const index =
      typeof candidate.index === "number" && candidate.index >= 0
        ? candidate.index
        : normalizedText.indexOf(normalizedModel);
    const before = index >= 0 ? normalizedText.slice(Math.max(0, index - 80), index) : "";
    return isOwnedOrComparisonReference(before);
  };
  // Drop owned/comparison mentions up front so a single "my current X" never
  // becomes the requested model, even on the single-candidate fast path.
  const requestCandidates = candidates.filter(c => !referenceFor(c));
  if (!requestCandidates.length) return [];
  const hasAlternativeSignal =
    /\b(or|either|any|something|lighter|smaller|smaller than|lighter than)\b/.test(normalizedText);
  if (!hasAlternativeSignal && requestCandidates.length < 2) {
    return requestCandidates[0]?.model ? [String(requestCandidates[0].model)] : [];
  }

  const selected: string[] = [];
  const seen = new Set<string>();
  for (const candidate of requestCandidates) {
    const model = String(candidate.model ?? "").trim();
    if (!model) continue;
    const normalizedModel = normalizeAvailabilityModelMentionText(model);
    if (!normalizedModel) continue;
    if (seen.has(normalizedModel)) continue;
    seen.add(normalizedModel);
    selected.push(model);
  }
  return selected;
}

function normalizeCadenceModelTokens(value: string | null | undefined): string[] {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * Guard against a cadence claiming a held inventory unit the customer never
 * actually expressed interest in. Rhett Craft (2026-06-13): a generic "Road
 * Glide" lead was over-resolved by inventory search to a held "Road Glide 3 in
 * Iron Horse Metallic", and the cadence draft fabricated "you were interested
 * in the 2026 Road Glide 3" — the wrong, more-specific model, steering him off
 * the Road Glide Limited his salesperson was actually working.
 *
 * Only claim a specific held unit when the customer referenced that exact unit
 * (stock#/VIN) OR the unit's model introduces NO specificity the lead never
 * expressed (every token of the unit model must appear in the lead's expressed
 * model/description). A generic "Road Glide" must not become a specific "Road
 * Glide 3"/"Road Glide Limited"/"Road Glide ST".
 */
export function cadenceHeldUnitModelConsistentWithLead(args: {
  unitModel?: string | null;
  unitStockId?: string | null;
  unitVin?: string | null;
  leadModel?: string | null;
  leadDescription?: string | null;
  leadStockId?: string | null;
  leadVin?: string | null;
}): boolean {
  const unitTokens = normalizeCadenceModelTokens(args.unitModel);
  if (!unitTokens.length) return true; // no specific model to over-claim
  const unitStock = String(args.unitStockId ?? "").trim().toLowerCase();
  const unitVin = String(args.unitVin ?? "").trim().toLowerCase();
  const leadStock = String(args.leadStockId ?? "").trim().toLowerCase();
  const leadVin = String(args.leadVin ?? "").trim().toLowerCase();
  if (unitStock && unitStock === leadStock) return true; // customer referenced this exact unit
  if (unitVin && unitVin === leadVin) return true;
  const expressed = new Set<string>([
    ...normalizeCadenceModelTokens(args.leadModel),
    ...normalizeCadenceModelTokens(args.leadDescription)
  ]);
  if (!expressed.size) return false; // no expressed model -> never pin a specific unit
  return unitTokens.every(token => expressed.has(token));
}

function normalizeInventoryWatchModelPhrase(textRaw: string | null | undefined): string {
  return String(textRaw ?? "")
    .toLowerCase()
    .replace(/\biron\s*883\b/g, "iron 883")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function hasInventoryWatchConfirmationText(textRaw: string | null | undefined): boolean {
  const text = String(textRaw ?? "").toLowerCase();
  if (!text.trim()) return false;
  return /\b(keep(?:ing)? an eye out|watch for|let me know when|let me know if|lmk when|lmk if|notify me|text me when|text me if|if you get one|when you get one|as soon as one comes in)\b/.test(
    text
  );
}

export function hasPriorOutOfStockNoticeForModel(
  outboundTexts: Array<string | null | undefined>,
  modelLabelRaw: string | null | undefined
): boolean {
  const modelLabel = normalizeInventoryWatchModelPhrase(modelLabelRaw);
  if (!modelLabel) return false;
  return outboundTexts.some(raw => {
    const text = normalizeInventoryWatchModelPhrase(raw);
    if (!text.includes(modelLabel)) return false;
    return /\b(not seeing|do not see|don t see|don t have|do not have|no)\b/.test(text) &&
      /\b(in stock|available|right now)\b/.test(text);
  });
}

function formatPlainModelList(labelsRaw: Array<string | null | undefined>): string {
  const labels = labelsRaw.map(label => String(label ?? "").trim()).filter(Boolean);
  if (labels.length === 0) return "";
  if (labels.length === 1) return labels[0];
  if (labels.length === 2) return `${labels[0]} or ${labels[1]}`;
  return `${labels.slice(0, -1).join(", ")}, or ${labels[labels.length - 1]}`;
}

function articleForModelLabel(labelRaw: string | null | undefined): "a" | "an" {
  const label = String(labelRaw ?? "").trim();
  return /^[aeiou8]/i.test(label) ? "an" : "a";
}

export function buildAcknowledgedInventoryWatchReply(args: {
  watchModels: Array<string | null | undefined>;
  alternativeOptionLines?: Array<string | null | undefined>;
  alternativeModels?: Array<string | null | undefined>;
  otherRequestedModels?: Array<string | null | undefined>;
}): string {
  const watchModels = args.watchModels.map(label => String(label ?? "").trim()).filter(Boolean);
  const uniqueWatchModels = Array.from(new Set(watchModels));
  const watchList = formatPlainModelList(uniqueWatchModels);
  if (!watchList) return "Got it - I’ll keep an eye out and text you if one comes in.";

  const watchNoun =
    uniqueWatchModels.length === 1 ? `${articleForModelLabel(uniqueWatchModels[0])} ${watchList}` : watchList;
  const alternativeModels = Array.from(
    new Set((args.alternativeModels ?? []).map(label => String(label ?? "").trim()).filter(Boolean))
  ).filter(label => !uniqueWatchModels.includes(label));
  const otherRequestedModels = Array.from(
    new Set((args.otherRequestedModels ?? []).map(label => String(label ?? "").trim()).filter(Boolean))
  ).filter(label => !uniqueWatchModels.includes(label));
  const alternativeOptionLines = (args.alternativeOptionLines ?? [])
    .map(line => String(line ?? "").trim())
    .filter(Boolean);

  const base = `Got it - I’ll keep an eye out for ${watchNoun} and text you if one comes in.`;
  if (alternativeOptionLines.length) {
    return `${base} Current options available right now: ${alternativeOptionLines.join(" ")} If either one interests you, I can send photos or more details.`;
  }
  if (alternativeModels.length) {
    return `${base} I can also check current ${formatPlainModelList(alternativeModels)} options if you want.`;
  }
  if (otherRequestedModels.length) {
    return `${base} If ${formatPlainModelList(otherRequestedModels)} ${otherRequestedModels.length === 1 ? "is" : "are"} also in the mix, I can track that too.`;
  }
  return base;
}

export function isTimingOnlyFollowUpTopic(textRaw: string | null | undefined): boolean {
  const source = String(textRaw ?? "")
    .toLowerCase()
    .replace(/\b(?:sometime|some time|around|later)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!source) return false;
  return /^(?:today|tomorrow|next week|this week|next month|this month|monday|tuesday|wednesday|thursday|friday|saturday|sunday|in \d+ (?:days?|weeks?|months?))$/.test(
    source
  );
}

export function buildTimingAwareWalkInFollowUpLine(args: {
  base: string;
  followUpTopic?: string | null;
  modelLabel?: string | null;
}): string {
  const base = String(args.base ?? "").trim();
  const followUpTopic = String(args.followUpTopic ?? "").trim();
  const modelLabel = String(args.modelLabel ?? "").trim();
  if (!base || !followUpTopic) return base;
  if (isTimingOnlyFollowUpTopic(followUpTopic) && modelLabel && modelLabel !== "bike") {
    return `${base} I'll follow up ${followUpTopic} about the ${modelLabel}.`;
  }
  return `${base} I'll follow up about ${followUpTopic}.`;
}

export function isFactoryOrderTimingQuestionText(textRaw: string | null | undefined): boolean {
  const text = String(textRaw ?? "").toLowerCase();
  if (!text.trim()) return false;
  if (isUnlistedInventoryQuestionText(text)) return true;
  const asksIncomingAvailability =
    /\b(?:do you|do u|you guys|are you|will you|can you)\b[\s\S]{0,100}\b(?:have|get|gettin'?g|receive|order)\b[\s\S]{0,100}\b(?:coming in|incoming|inbound|on order|arriv(?:e|es|ing))\b/.test(
      text
    ) ||
    /\b(?:do you|do u|you guys|are you|will you|can you)\b[\s\S]{0,100}\b(?:coming in|incoming|inbound|on order|arriv(?:e|es|ing))\b/.test(
      text
    ) ||
    /\b(?:any|any more|anything|models?|bikes?|units?)\b[\s\S]{0,80}\b(?:coming in|incoming|inbound|on order|arriv(?:e|es|ing))\b/.test(
      text
    );
  if (asksIncomingAvailability && !/\b(?:i'?m|i am|i’ll|i will|we'?re|we are)\s+coming in\b/.test(text)) {
    return true;
  }
  const asksTiming =
    /\bhow\s+long\b/.test(text) ||
    /\bhow\s+soon\b/.test(text) ||
    /\b(?:eta|e\.t\.a\.)\b/.test(text) ||
    /\b(?:timeframe|timeline|wait|take)\b/.test(text);
  if (!asksTiming) return false;
  return (
    /\bfactory\b/.test(text) ||
    /\border(?:ed|ing)?\b/.test(text) ||
    /\ballocation\b/.test(text) ||
    /\binbound\b/.test(text) ||
    /\b(?:get|bring|locate)\s+(?:one|a|an|the|another)?\b[\s\S]{0,80}\b(?:in|here|from)\b/.test(text) ||
    /\bcome\s+in\b/.test(text) ||
    /\barriv(?:e|es|ed|ing|al)\b/.test(text)
  );
}

export function isUnlistedInventoryQuestionText(textRaw: string | null | undefined): boolean {
  const text = String(textRaw ?? "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return false;
  if (/\b(?:i'?m|i am|i’ll|i will|we'?re|we are)\s+(?:coming|going)\s+back\b/.test(text)) return false;
  return (
    /\b(?:anything|something|any|bikes?|units?|inventory|models?)\b[\s\S]{0,80}\b(?:in the back|out back|back room|backroom)\b/.test(
      text
    ) ||
    /\b(?:in the back|out back|back room|backroom)\b[\s\S]{0,80}\b(?:anything|something|any|bikes?|units?|inventory|models?|budget|price|payment|fit)\b/.test(
      text
    ) ||
    /\b(?:anything|something|any|bikes?|units?|inventory|models?)\b[\s\S]{0,80}\b(?:not\s+(?:listed|posted|online)|not\s+(?:on|up on)\s+(?:the\s+)?(?:website|site|web)|haven'?t\s+(?:listed|posted)|isn'?t\s+(?:listed|posted|online))\b/.test(
      text
    ) ||
    /\b(?:not\s+(?:listed|posted|online)|not\s+(?:on|up on)\s+(?:the\s+)?(?:website|site|web)|haven'?t\s+(?:listed|posted)|isn'?t\s+(?:listed|posted|online))\b[\s\S]{0,80}\b(?:anything|something|any|bikes?|units?|inventory|models?|budget|price|payment|fit)\b/.test(
      text
    )
  );
}

export function buildUnlistedInventoryHandoffReply(modelLabel?: string | null): string {
  const model = String(modelLabel ?? "").replace(/\s+/g, " ").trim();
  if (model) {
    return `I’ll take a look for anything not listed yet that fits what you’re after on the ${model} and follow up with you.`;
  }
  return "I’ll take a look for anything not listed yet that fits your budget and follow up with you.";
}

export function buildFactoryOrderTimingHandoffReply(modelLabel?: string | null): string {
  const model = String(modelLabel ?? "").replace(/\s+/g, " ").trim();
  if (model) {
    return `I’ll check on the status of the ${model} and follow up with you.`;
  }
  return "I’ll check on availability and timing and follow up with you.";
}

function normalizeComparableModelName(raw: string | null | undefined): string {
  return String(raw ?? "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\b(?:harley|davidson|harley davidson|motorcycle|motorcycles|bike|bikes|the|a|an)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function shouldCarryLeadYearForRequestedModel(
  requestedModel: string | null | undefined,
  leadModel: string | null | undefined
): boolean {
  const requested = normalizeComparableModelName(requestedModel);
  if (!requested) return true;
  const lead = normalizeComparableModelName(leadModel);
  if (!lead) return false;
  return requested === lead || requested.includes(lead) || lead.includes(requested);
}

export function cleanCatalogModelNameForDisplay(raw: string | null | undefined): string {
  const original = String(raw ?? "").replace(/\s+/g, " ").trim();
  if (!original) return "";
  const parts = original.split(/\s+/).filter(Boolean);
  if (!parts.length) return "";
  const isHarleyCodePrefix = (token: string): boolean =>
    /^(?:FL|FX|XL|XR|RH|RA|VR|XG|ELW)[A-Z0-9_-]*$/i.test(token) ||
    /^[A-Z]{1,4}\d[A-Z0-9_-]*$/i.test(token) ||
    (/^[A-Z0-9_-]{2,8}$/i.test(token) && /[A-Z]/i.test(token) && /\d/.test(token));
  let start = 0;
  if (parts[start] && isHarleyCodePrefix(parts[start])) {
    start += 1;
    while (parts[start] && /^[A-Z0-9_-]+$/i.test(parts[start]) && /\d/.test(parts[start])) {
      start += 1;
    }
  }
  const cleaned = parts.slice(start).join(" ").trim() || original;
  return cleaned
    .toLowerCase()
    .replace(/\banx\b/g, "anniversary")
    .replace(/\banv\b/g, "anniversary")
    .replace(/\b\w/g, c => c.toUpperCase());
}

export function catalogModelMentionMatchesText(textRaw: string | null | undefined, modelRaw: string | null | undefined): boolean {
  return scoreCatalogModelMention(textRaw, modelRaw) > 0;
}

function scoreCatalogModelMention(textRaw: string | null | undefined, modelRaw: string | null | undefined): number {
  const text = String(textRaw ?? "").toLowerCase();
  const model = String(modelRaw ?? "").trim();
  if (!text.trim() || !model) return 0;
  const display = cleanCatalogModelNameForDisplay(model).toLowerCase();
  const firstToken = model.split(/\s+/).filter(Boolean)[0] ?? "";
  const code = /^(?:FL|FX|XL|XR|RH|RA|VR|XG|ELW)[A-Z0-9_-]*$/i.test(firstToken) ? firstToken : "";
  const normalizePhrase = (value: string) =>
    value
      .toLowerCase()
      .replace(/[-_/]+/g, " ")
      .replace(/[^a-z0-9]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  const normalizedText = ` ${normalizePhrase(text)} `;
  const normalizedDisplay = normalizePhrase(display);
  if (normalizedDisplay && normalizedText.includes(` ${normalizedDisplay} `)) {
    return 10_000 + normalizedDisplay.length;
  }
  const normalizedCode = normalizePhrase(code);
  if (!normalizedCode || !normalizedText.includes(` ${normalizedCode} `)) return 0;
  if (/\b(anniversary|anx|anv)\b/i.test(display) && !/\b(anniversary|anx|anv)\b/i.test(text)) {
    return 100;
  }
  return 1_000 + normalizedDisplay.length;
}

export function pickCatalogModelLabelFromText(
  textRaw: string | null | undefined,
  models: Array<string | null | undefined>
): string {
  const scored = models
    .map(model => ({
      label: cleanCatalogModelNameForDisplay(model),
      score: scoreCatalogModelMention(textRaw, model)
    }))
    .filter(row => row.label && row.score > 0)
    .sort((a, b) => b.score - a.score || b.label.length - a.label.length);
  return scored[0]?.label ?? "";
}

export function isAccessoryCustomizationRequestText(textRaw: string | null | undefined): boolean {
  const text = String(textRaw ?? "").toLowerCase();
  if (!text.trim()) return false;

  const mentionsHandlebars =
    /\b(handle\s*bars?|handlebars?|handbars?|bars?)\b/i.test(text) &&
    !/\b(bar and shield|bar\s*&\s*shield)\b/i.test(text);
  const mentionsInstallAccessory =
    mentionsHandlebars ||
    /\b(heated\s+(?:handle\s*)?grips?|heated\s+seat|seat|seats|windshield|backrest|sissy\s+bar|tour[-\s]?pak|luggage|fairing|pipes?|exhaust)\b/i.test(
      text
    );
  if (!mentionsInstallAccessory) return false;

  return (
    /\b(can|could|would|are)\s+(?:you|u|we|the shop)\b[\s\S]{0,80}\b(change|swap|replace|install|put|do)\b/i.test(
      text
    ) ||
    /\b(change|swap|replace|install|put|do|add|added)\b[\s\S]{0,80}\b(handle\s*bars?|handlebars?|handbars?|bars?|heated\s+(?:handle\s*)?grips?|heated\s+seat|seat|seats|windshield|backrest|sissy\s+bar|tour[-\s]?pak|luggage|fairing|pipes?|exhaust)\b/i.test(
      text
    ) ||
    /\bnot\s+a\s+fan\b[\s\S]{0,80}\b(ones|these|those|stock|current)\b/i.test(text) ||
    /\b(heated\s+(?:handle\s*)?grips?|heated\s+seat|seat|seats|windshield|backrest|sissy\s+bar|tour[-\s]?pak|luggage|fairing|pipes?|exhaust)\b[\s\S]{0,60}\b(possibility|possible|available|option|doable)\b/i.test(
      text
    )
  );
}

export function buildAccessoryCustomizationReply(textRaw: string | null | undefined): string {
  const text = String(textRaw ?? "");
  const hasMediaReference =
    /\b(pic|pics|picture|photo|image|attached|sent|mms)\b/i.test(text) ||
    /\bnot\s+a\s+fan\s+of\s+the\s+ones\b/i.test(text);

  if (/\b(handle\s*bars?|handlebars?|handbars?|bars?)\b/i.test(text)) {
    return hasMediaReference
      ? "Yes — we can change the handlebars. The picture helps; I’ll have our team check the right bar setup, parts, and labor for that bike and follow up with options."
      : "Yes — we can change the handlebars. I’ll have our team check the right bar setup, parts, and labor for that bike and follow up with options.";
  }
  if (/\bheated\s+(?:handle\s*)?grips?\b/i.test(text)) {
    return "Yes — heated grips are possible. I’ll have our team check the right heated grip setup, parts, and labor for that bike and follow up with options.";
  }

  return "Yes — we can help with that customization. I’ll have our team check the right parts and labor for that bike and follow up with options.";
}

export function isTakeOffMilwaukeeEightEngineRequestText(textRaw: string | null | undefined): boolean {
  const text = String(textRaw ?? "");
  if (!text.trim()) return false;
  const hasM8 =
    /\b(?:m[\s-]?8|milwaukee[\s-]?eight)\b/i.test(text) ||
    /\b(?:114|117)\s*\/\s*(?:114|117)\b/i.test(text);
  const hasEngine =
    /\b(engine|motor|crate motor|take[-\s]?off|takeout|pull(?:ed|ing)?|yank(?:ed|ing)?|swap(?:ped|ping)?|upgrade)\b/i.test(
      text
    );
  const hasSourcingAsk =
    /\b(let me know|text me|call me|in the market|looking for|need|want|after one|if you get|if anyone)\b/i.test(
      text
    );
  return hasM8 && hasEngine && hasSourcingAsk;
}

export function buildTakeOffMilwaukeeEightEngineReply(): string {
  return "I got your note about looking for a take-off Milwaukee-Eight 114/117. I’ll have our parts team keep an eye out, and if one becomes available from an upgrade we’ll reach out.";
}

export function shouldTreatAdfAsWalkInContext(args: {
  leadSource?: string | null;
  priorWalkIn?: boolean | null;
  explicitWalkInLeadSource?: boolean | null;
  trafficLogPayloadHint?: boolean | null;
  walkInSignalHint?: boolean | null;
}): boolean {
  if (args.explicitWalkInLeadSource) return true;
  if (args.trafficLogPayloadHint && args.walkInSignalHint) return true;
  if (!args.priorWalkIn) return false;
  const source = String(args.leadSource ?? "").toLowerCase();
  if (/\b(test ride|book test ride|online test ride request)\b/i.test(source)) return false;
  if (
    /\b(marketplace|trade accelerator|value my trade|sell my bike|sell your bike|sell your vehicle)\b/i.test(
      source
    ) &&
    /\b(sell my bike|sell your bike|sell your vehicle|value my trade|trade accelerator)\b/i.test(source)
  ) {
    return false;
  }
  return true;
}

function escapeRegexLiteral(value: string): string {
  return String(value ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function shouldIgnoreAdfModelMismatchForTradeContext(args: {
  inquiry?: string | null;
  inquiryModel?: string | null;
}): boolean {
  const inquiry = String(args.inquiry ?? "");
  const model = String(args.inquiryModel ?? "").trim();
  if (!inquiry.trim() || !model) return false;

  const modelPattern = model
    .split(/\s+/)
    .filter(Boolean)
    .map(escapeRegexLiteral)
    .join("\\s+");
  if (!modelPattern) return false;

  const re = new RegExp(`\\b${modelPattern}\\b`, "ig");
  let match: RegExpExecArray | null;
  while ((match = re.exec(inquiry))) {
    const before = inquiry.slice(Math.max(0, match.index - 90), match.index);
    const after = inquiry.slice(match.index + match[0].length, match.index + match[0].length + 120);
    const window = `${before}${match[0]}${after}`;

    if (
      /\b(?:trade(?:\s|-)?in|trading|trade|apprais(?:e|al)|value)\b/i.test(window) &&
      (
        /\b(?:my|have|own)\b[\s\S]{0,70}\b(?:19|20)\d{2}\b/i.test(before) ||
        /\b(?:19|20)\d{2}\b[\s\S]{0,30}$/i.test(before) ||
        /^\W*(?:to\s+)?(?:trade(?:\s|-)?in|trade|trading|apprais(?:e|al)|value)\b/i.test(after)
      )
    ) {
      return true;
    }
  }

  return false;
}

export function resolveRequestedScheduleWindowMode(textRaw: string | null | undefined): RequestedScheduleWindowMode {
  const text = String(textRaw ?? "").toLowerCase();
  if (!text.trim()) return "none";
  const hasAfter = /\bafter\b/.test(text);
  if (hasAfter) return "after";
  if (/\bbefore\b/.test(text)) return "before";
  if (/\b(between|from|around|about|morning|afternoon|evening)\b/.test(text)) return "window";
  if (/\b(?:free|available)?\s*all\s+day\b/.test(text)) return "any_time";
  if (/\b(any\s*time|anytime)\b/.test(text)) return "any_time";
  return "none";
}

export type DayPartOnlyScheduleReplyParse = {
  dayPart: "morning" | "afternoon" | "evening";
  variant: "early" | "mid" | "late" | null;
  windowLabel: string;
  startHour24: number;
  startMinute: number;
  endHour24: number;
  endMinute: number;
};

const DAY_PART_ONLY_SCHEDULE_WINDOWS: Record<
  string,
  { startHour24: number; startMinute: number; endHour24: number; endMinute: number }
> = {
  morning: { startHour24: 9, startMinute: 0, endHour24: 12, endMinute: 0 },
  "early morning": { startHour24: 9, startMinute: 0, endHour24: 10, endMinute: 30 },
  "mid morning": { startHour24: 9, startMinute: 30, endHour24: 11, endMinute: 30 },
  "late morning": { startHour24: 10, startMinute: 30, endHour24: 12, endMinute: 0 },
  afternoon: { startHour24: 12, startMinute: 0, endHour24: 17, endMinute: 0 },
  "early afternoon": { startHour24: 12, startMinute: 0, endHour24: 14, endMinute: 0 },
  "mid afternoon": { startHour24: 13, startMinute: 30, endHour24: 15, endMinute: 30 },
  "late afternoon": { startHour24: 15, startMinute: 0, endHour24: 17, endMinute: 0 },
  evening: { startHour24: 17, startMinute: 0, endHour24: 23, endMinute: 59 },
  "early evening": { startHour24: 17, startMinute: 0, endHour24: 19, endMinute: 0 },
  "mid evening": { startHour24: 17, startMinute: 30, endHour24: 20, endMinute: 0 },
  "late evening": { startHour24: 19, startMinute: 0, endHour24: 23, endMinute: 59 }
};

/**
 * A bare day-part reply ("Afternoon would be great") after we offered a day
 * carries no day token and no clock time, so parseRequestedDayTime returns
 * null and no slots get offered (Al Davis +17163059906, 2026-06-06). This
 * parser owns ONLY that shape: a day-part with no day, date, time, or
 * competing intent in the message.
 */
export function parseDayPartOnlyScheduleReply(
  textRaw: string | null | undefined
): DayPartOnlyScheduleReplyParse | null {
  const text = String(textRaw ?? "")
    .toLowerCase()
    .replace(/[’]/g, "'")
    .replace(/\s+/g, " ")
    .trim();
  if (!text || text.length > 80) return null;
  if (/\d/.test(text)) return null;
  if (dayTokenPattern().test(text)) return null;
  // "tonight" pins the day to today, which belongs to the existing day+part path.
  if (/\b(tonight|tonite|weekend|noon|midday)\b/.test(text)) return null;
  if (
    /\b(call me|give me a call|price|pricing|payment|payments|trade|inventory|stock|available|availability|photo|photos|video|address|finance|financing|monthly|apr|service|parts)\b/.test(
      text
    )
  ) {
    return null;
  }
  const matches = Array.from(text.matchAll(/\b(?:(early|mid|late)[\s-]+)?(morning|afternoon|evening)s?\b/g));
  if (!matches.length) return null;
  const candidates: Array<{
    dayPart: "morning" | "afternoon" | "evening";
    variant: "early" | "mid" | "late" | null;
    positive: boolean;
  }> = [];
  for (const match of matches) {
    const idx = match.index ?? 0;
    const before = text.slice(Math.max(0, idx - 24), idx);
    const after = text.slice(idx + match[0].length, idx + match[0].length + 28);
    const negatedBefore =
      /\b(?:can'?t|cannot|can not|won'?t|not|no|don'?t|do not|doesn'?t|except|rather not)\s+(?:do\s+|in\s+the\s+|the\s+|an?\s+)?$/.test(
        before
      ) || /\b(?:i|we)\s+work(?:ing)?\s+(?:in\s+the\s+|the\s+)?$/.test(before);
    const negatedAfter =
      /^\s*(?:doesn'?t|don'?t|won'?t|isn'?t|aren'?t|no\s+good|not\b|won'?t\s+work)/.test(after);
    if (negatedBefore || negatedAfter) continue;
    const positive =
      /^\s*(?:would|could|should|will|all|usually|prob(?:ably)?)?\s*(?:work(?:s)?\b|sound(?:s)?\s+(?:good|great|perfect)|(?:would\s+|will\s+)?be\s+(?:great|good|perfect|fine|better|best|ideal)|is\s+(?:great|good|perfect|fine|better|best|ideal)|are\s+(?:better|best|good|great|fine|ideal))/.test(
        after
      ) || /\b(?:prefer|how about|maybe|let'?s do|let'?s say|i'?d say|go with)\s*(?:an?\s+|the\s+)?$/.test(before);
    candidates.push({
      dayPart: match[2] as "morning" | "afternoon" | "evening",
      variant: (match[1] as "early" | "mid" | "late" | undefined) ?? null,
      positive
    });
  }
  if (!candidates.length) return null;
  const positives = candidates.filter(c => c.positive);
  const pool = positives.length ? positives : candidates;
  // Two different day-parts with no preference cue ("morning or afternoon")
  // is ambiguous; let the normal flow ask.
  if (new Set(pool.map(c => c.dayPart)).size > 1) return null;
  const pick = pool[pool.length - 1];
  const windowLabel = pick.variant ? `${pick.variant} ${pick.dayPart}` : pick.dayPart;
  const window =
    DAY_PART_ONLY_SCHEDULE_WINDOWS[windowLabel] ?? DAY_PART_ONLY_SCHEDULE_WINDOWS[pick.dayPart];
  return {
    dayPart: pick.dayPart,
    variant: pick.variant,
    windowLabel,
    ...window
  };
}

const SCHEDULE_OFFER_MONTH_LABELS: Record<string, string> = {
  jan: "January", feb: "February", mar: "March", apr: "April", may: "May", jun: "June",
  jul: "July", aug: "August", sep: "September", oct: "October", nov: "November", dec: "December"
};

/**
 * The specific day our most recent outbound schedule message offered
 * ("...meet you Saturday. Do mornings or afternoons work better?"). Returns a
 * label parseRequestedDayTime understands ("Saturday", "June 20", "6/20").
 * "today"/"tomorrow" are relative to when the outbound was sent and may be
 * stale by reply time, so they are deliberately not carried.
 */
export function extractOfferedScheduleDayFromOutboundText(
  textRaw: string | null | undefined
): string | null {
  const text = String(textRaw ?? "").toLowerCase().replace(/\s+/g, " ").trim();
  if (!text) return null;
  const scheduleCue =
    /\b(?:meet you|meet up|come (?:in|by|down)|stop (?:in|by)|swing by|see you|visit|appointment|appt|schedule|test ride|demo ride|set (?:up )?a time|what time|time works|works? (?:best|better|for you)|lock (?:in|it in)|book|mornings? or afternoons?)\b/;
  if (!scheduleCue.test(text)) return null;
  const monthDate = text.match(
    /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b/
  );
  if (monthDate) {
    const month = SCHEDULE_OFFER_MONTH_LABELS[monthDate[1].slice(0, 3)];
    if (month) return `${month} ${monthDate[2]}`;
  }
  const slashDate = text.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(?:\d{2}|\d{4}))?\b/);
  if (slashDate) return `${slashDate[1]}/${slashDate[2]}`;
  const weekday = text.match(
    /\b(monday|mon|tuesday|tue|tues|wednesday|wed|thursday|thu|thur|thurs|friday|fri|saturday|sat|sunday|sun)\b/
  );
  if (weekday) return normalizeDayToken(weekday[1]);
  return null;
}

const DAY_PART_ONLY_SCHEDULE_DIALOG_STATES = new Set([
  "schedule_offer_sent",
  "schedule_request",
  "test_ride_offer_sent"
]);

export type DayPartOnlyScheduleResolution = {
  dayLabel: string;
  parse: DayPartOnlyScheduleReplyParse;
  /** Human label for replies/todos, e.g. "Saturday afternoon". */
  windowLabel: string;
  /** Text parseRequestedDayTime can pin to a concrete date, e.g. "Saturday at 12:00pm". */
  requestedText: string;
};

export function resolveDayPartOnlyScheduleReply(args: {
  inboundText: string | null | undefined;
  lastOutboundText: string | null | undefined;
  dialogState: string | null | undefined;
}): DayPartOnlyScheduleResolution | null {
  const state = String(args.dialogState ?? "").trim().toLowerCase();
  if (!DAY_PART_ONLY_SCHEDULE_DIALOG_STATES.has(state)) return null;
  const parse = parseDayPartOnlyScheduleReply(args.inboundText);
  if (!parse) return null;
  const dayLabel = extractOfferedScheduleDayFromOutboundText(args.lastOutboundText);
  if (!dayLabel) return null;
  const hour12 = parse.startHour24 % 12 === 0 ? 12 : parse.startHour24 % 12;
  const meridiem = parse.startHour24 >= 12 ? "pm" : "am";
  return {
    dayLabel,
    parse,
    windowLabel: `${dayLabel} ${parse.windowLabel}`,
    requestedText: `${dayLabel} at ${hour12}:${String(parse.startMinute).padStart(2, "0")}${meridiem}`
  };
}

export function buildHumanModeSchedulingDraft(args: {
  intent?: string | null;
  requestedDay?: string | null;
  requestedTime?: string | null;
  requestedLabel?: string | null;
  bookingUrl?: string | null;
}): string {
  const intent = String(args.intent ?? "").trim().toLowerCase();
  const day = String(args.requestedDay ?? "").trim();
  const time = String(args.requestedTime ?? "").trim();
  const requestedLabel = String(args.requestedLabel ?? "").trim();
  const bookingUrl = String(args.bookingUrl ?? "").trim();
  const isReschedule = intent === "reschedule";

  if (isReschedule) {
    if (!day && !time && bookingUrl) return `No worries — you can reschedule here: ${bookingUrl}`;
    if (day && !time) return `No worries — what time works best on ${day} to reschedule?`;
    if (requestedLabel || time) return "No worries — I’ll check that reschedule time and follow up.";
    return "No worries — what day and time works best to reschedule?";
  }

  if (intent === "availability") {
    if (day) return `I can help with that — what time on ${day} works best?`;
    return "I can help with that — what day works best?";
  }

  if (day && !time) return `Sounds good — what time on ${day} works best?`;
  if (requestedLabel || time) return "Sounds good — I’ll check that time and follow up.";
  return "Sounds good — what day and time works best?";
}

export function buildAppointmentRescheduleBookingLinkReply(args: {
  bookingUrl?: string | null;
  firstName?: string | null;
}): string {
  const bookingUrl = String(args.bookingUrl ?? "").trim();
  const firstName = String(args.firstName ?? "").trim();
  const intro = firstName ? `No problem, ${firstName} — ` : "No problem — ";
  if (bookingUrl) return `${intro}you can reschedule here: ${bookingUrl}`;
  return `${intro}what day and time works best to reschedule?`;
}

export function shouldSuppressVoiceCallbackTodoForAppointment(args: {
  callbackRequested?: boolean;
  bookingIntentAccepted?: boolean;
  bookingIntent?: string | null;
  requestedDay?: string | null;
  requestedTime?: string | null;
  requestedWindow?: string | null;
  parserSchedulingIntent?: boolean;
  effectiveTestRideIntent?: boolean;
  sourceText?: string | null;
}): boolean {
  if (!args.callbackRequested) return false;
  const day = String(args.requestedDay ?? "").trim();
  const time = String(args.requestedTime ?? "").trim();
  const window = String(args.requestedWindow ?? "").trim().toLowerCase();
  const hasUsableAppointmentTime = !!day && !!time && (window === "exact" || window === "range");
  if (!hasUsableAppointmentTime) return false;
  const bookingIntent = String(args.bookingIntent ?? "").trim().toLowerCase();
  const schedulingIntent =
    (args.bookingIntentAccepted && (bookingIntent === "schedule" || bookingIntent === "reschedule")) ||
    args.parserSchedulingIntent ||
    args.effectiveTestRideIntent;
  if (!schedulingIntent) return false;
  const source = String(args.sourceText ?? "").toLowerCase();
  const explicitSeparateCallback =
    /\b(call me back|give me a call|can you call me|could you call me|please call me|reach me|call after|call at|call later|follow up with me)\b/.test(
      source
    ) || /\b(when|what)\s+(time|day)\s+(can|should)\s+you\s+call\b/.test(source);
  return !explicitSeparateCallback;
}

export function isVisitPlanContextNoteText(textRaw: string | null | undefined): boolean {
  const text = String(textRaw ?? "").toLowerCase().replace(/\s+/g, " ").trim();
  if (!text) return false;
  const hasVisitPlan =
    /\b(?:agreed|planning|plans?|scheduled|set|confirmed|look forward)\b[\s\S]{0,80}\b(?:come|stop|swing|meet|meeting|seeing)\b/.test(
      text
    ) ||
    /\b(?:come|stop|swing)\s+(?:in|by|down|through)\b/.test(text) ||
    /\b(?:meeting|seeing)\s+(?:you|him|her|them|customer)\b/.test(text);
  if (!hasVisitPlan) return false;
  return /\b(today|tomorrow|monday|mon|tuesday|tue|wednesday|wed|thursday|thu|friday|fri|saturday|sat|sunday|sun|next week|this week|morning|afternoon|evening|noon|\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\b/.test(
    text
  );
}

export function isIncidentalTravelTimingContextNoteText(textRaw: string | null | undefined): boolean {
  const text = String(textRaw ?? "").toLowerCase().replace(/\s+/g, " ").trim();
  if (!text) return false;
  const hasTravelTiming =
    /\b(?:going|go(?:es)?|leav(?:e|ing)|away|out of town|on vacation|vacation|trip|travel(?:ing)?)\b[\s\S]{0,80}\b(?:end of (?:the )?month|next month|this month|next week|this week|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)\b/.test(
      text
    ) ||
    /\b(?:end of (?:the )?month|next month|this month|next week|this week|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)\b[\s\S]{0,80}\b(?:trip|travel(?:ing)?|vacation|out of town|away)\b/.test(
      text
    );
  if (!hasTravelTiming) return false;
  const explicitFollowUp =
    /\b(?:follow up|follow-up|check in|check-in|circle back|touch base|reach out|reconnect|call (?:him|her|them|me|customer)|text (?:him|her|them|me|customer)|remind)\b/.test(
      text
    );
  return !explicitFollowUp;
}

export function isCustomerReturningCallText(textRaw: string | null | undefined): boolean {
  const text = String(textRaw ?? "").toLowerCase().replace(/\s+/g, " ").trim();
  if (!text) return false;
  return (
    /\b(?:customer\s+)?(?:will|would|is going to|gonna|going to|plans? to)\s+call\s+(?:us|you|back)\b/.test(
      text
    ) ||
    /\bdo you mind if i give you a call (?:right )?back\b/.test(text) ||
    /\bi(?:'ll| will| can)?\s*give you a call (?:right )?back\b/.test(text) ||
    /\bi(?:'ll| will| can)?\s*call (?:you |us )?(?:right )?back\b/.test(text)
  );
}

export function buildMarketplaceSellMyBikeReviewReply(args: {
  bikeLabel?: string | null;
  firstName?: string | null;
  isInitialAdf?: boolean;
  agentName?: string | null;
  dealerName?: string | null;
}): string {
  const bikeLabel = String(args.bikeLabel ?? "").trim() || "your bike";
  const firstName = String(args.firstName ?? "").trim();
  if (args.isInitialAdf) {
    const agentName = String(args.agentName ?? "").trim() || "Brooke";
    const dealerName = String(args.dealerName ?? "").trim() || "American Harley-Davidson";
    return (
      `Thanks — I received the sell-my-bike details for ${bikeLabel}. ` +
      `This is ${agentName} at ${dealerName}. ` +
      "I’ll review the info and photos, then follow up with next steps."
    );
  }
  const intro = firstName ? `Thanks ${firstName} — ` : "Thanks — ";
  return (
    `${intro}I received the updated sell-my-bike details for ${bikeLabel}. ` +
    "I’ll review the info and photos, then follow up with next steps."
  );
}

export function isExternalDealerApprovalTransferQuestionText(text: string | null | undefined): boolean {
  const raw = String(text ?? "").trim();
  if (!raw) return false;
  const lower = raw.toLowerCase();
  const hasApproval = /\b(approved|approval|financ(?:e|ing)|credit\s*app(?:lication)?|pre[-\s]?qual(?:ified)?)\b/.test(
    lower
  );
  const hasOtherDealer =
    /\b(another|other|different)\s+(?:harley|harly|h-?d|dealer|store|dealership)\b/.test(lower) ||
    /\b(?:at|through|from)\s+[a-z0-9' -]{2,40}\s+(?:harley|harly|h-?d|dealer|store|dealership)\b/.test(lower);
  const hasTransferAsk =
    /\b(transfer|carry\s*over|good|valid|work|accepted?|honou?red?|count)\b/.test(lower) ||
    /\b(is|does|will|would|can)\b[\s\S]{0,80}\b(your|this|the)\s+(?:store|dealer|dealership)\b/.test(lower);
  return hasApproval && hasOtherDealer && hasTransferAsk;
}

export function buildExternalDealerApprovalTransferReply(creditAppUrl?: string | null): string {
  const url = String(creditAppUrl ?? "").trim();
  const base =
    "Yes — if that approval was through Harley-Davidson Financial Services, it can be used at our store. " +
    "We do still need you to complete a separate application for our dealership because Harley-Davidson does not transfer the application over to us. " +
    "It will not be another credit inquiry.";
  if (!url) {
    return `${base} I can send you the link to complete our store application.`;
  }
  return `${base}\n\n${url}`;
}
