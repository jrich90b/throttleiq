import { GENERIC_AGENT_DISPLAY_NAME } from "./agentVoice.js";
import { advanceEveryReplySuppressed } from "./draftChannelRules.js";
import { isPlaceholderModel } from "./modelDeflection.js";
import { extractStockIdFromText, getLearnedStockIdShapes } from "./stockIdShapes.js";

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

/**
 * Does the live reminder/pause arm own this turn?
 *
 * "Reach out" carries no direction. A customer asking US to make contact ("can you reach out
 * when you get the chance") and a customer asking to be LEFT ALONE until later ("I'll reach out
 * when I'm looking again") use the same words, and the live arm read only the words: Adam
 * (+17164312108, 2026-08-08) asked Scott to call him and was answered "I'm here when you're
 * ready. Just reach out when the time is right." — with follow-up paused 90 days. That is the
 * exact inversion of what he asked for, and the hedge/deflect charter C1.5 forbids.
 *
 * Direction is comprehension, so the PARSER owns it (AGENTS.md "comprehend, never regex"). When
 * the turn's centralized route decision says this is an explicit callback request, the
 * reminder/pause arm must not claim the turn — the callback arm already mints the staff call
 * task and the composer writes the reply. Measured on the live store: of 38 inbound turns whose
 * words match the reminder gate, exactly ONE is a request for us to make contact.
 *
 * FAIL DIRECTION, both ways safe: a MISSED callback parse leaves today's behaviour untouched,
 * and a FALSE callback parse means we reply and do NOT pause — never a silent 90-day park.
 */
export function followUpReminderPauseClaimsTurn(
  textRaw: string | null | undefined,
  callbackRequested: boolean,
  locationQuestion: boolean
): boolean {
  if (callbackRequested || locationQuestion) return false;
  return wantsReminder(textRaw);
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

// Did the DEALER proactively ask the customer WHEN they're coming in / arriving (a visit-time
// check-in), e.g. Scott → Bobby: "what time you planned on coming in this afternoon?". When our own
// last outbound is this, the customer's ensuing time answer ("1 or 2", "whatever works") is a VISIT
// confirmation handled by the scheduling cluster — NOT a customer-initiated service request, so the
// service-scheduling handoff must defer (else a sticky service-classified lead gets "I'll have SERVICE
// check availability" for a plain visit time — Bobby Kindred, 2026-06-25). Reads OUR text (the dealer's
// framing), not the customer's intent, so it's a deterministic context gate, not comprehension. Fail
// direction safe: deferring routes a visit-time reply to the scheduling cluster (confirm/offer a time)
// instead of the service deflection.
export function isDealerVisitTimeCheckInText(textRaw: string | null | undefined): boolean {
  const text = String(textRaw ?? "").toLowerCase().replace(/\s+/g, " ").trim();
  if (!text) return false;
  const arrival =
    /\b(com(?:e|ing)\s+in|com(?:e|ing)\s+by|stop(?:ping)?\s+(?:in|by)|head(?:ing)?\s+(?:in|over)|swing(?:ing)?\s+by|get\s+here|be\s+(?:here|there|in)|plan(?:ned|ning)?\s+on)\b/;
  return (
    (/\bwhat time\b/.test(text) && (arrival.test(text) || /\bworks?\b/.test(text))) ||
    (/\bwhen\b/.test(text) && arrival.test(text)) ||
    /\bwhat time (?:are you|will you be|do you|did you|should we expect you|are we (?:looking|expecting))\b/.test(text) ||
    /\bwhat time (?:works|is good|did you (?:want|have in mind))\b/.test(text)
  );
}

/**
 * The check-in above, AND it did not itself name the service department — the exact pair the
 * service-scheduling handoff defers on. Kept here (not inline in index.ts) so the two callers that
 * hand it to `decideServiceSchedulingHandoffTurn` and the ones that apply it as a hard gate all
 * read the SAME predicate.
 *
 * The `service` word test is doing two different jobs, and only one of them is legitimate: it is a
 * fine deterministic read of whether OUR OWN framing was explicitly a service check-in, but it is
 * NOT a competent judge of whether the visit IS one. A post-sale repair booked in plain English
 * ("let me know when you want to bring it in and we can put a new sticker on the bike") never says
 * the word — Edward Trouse +17166281539, operator-reported 2026-08-01, whose "Probably around 4pm"
 * was booked as a SALES appointment. That judgement now belongs to the typed visit-purpose parser
 * via the referee; this predicate only reports what our framing literally said.
 */
export function isDealerVisitTimeCheckInWithoutServiceText(textRaw: string | null | undefined): boolean {
  const text = String(textRaw ?? "");
  return isDealerVisitTimeCheckInText(text) && !/\bservice\b/i.test(text);
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

/**
 * The compliment-only reply, in ONE place, judged by the SAME C1.7 referee the composer uses.
 *
 * MEASURED 2026-08-13 against the live store: this template has fired exactly TWICE across 852
 * conversations, and BOTH times the customer had already BOUGHT the bike they were complimenting.
 * +17169570162 tapped a ❤️ on his post-sale thank-you the day after taking delivery of a Road
 * Glide Special and was AUTO-SENT "I can send more photos or a walkaround video" — for the bike in
 * his garage. +17169086716 wrote "Enjoyed the ride home.. hoping to put some miles on the Deadwood
 * nxt week" and drew the same offer; Joe deleted the clause by hand, sent "Glad you like it!", and
 * filed the report: "should have not asked follow up questions. if you look the bike is already
 * sold."
 *
 * So the shopping offer is not a fallback that occasionally lands wrong — its entire measured
 * population is owners. Charter C1.7's `alreadyPurchased` exception is decided in CODE and binds
 * our deterministic templates exactly as it binds the LLM composer, so the warmth stays and the
 * push goes. The suppressed wording is Joe's own from that thread. Asking the shared referee (not
 * a second `!!conv.sale` test) is what stops this drifting from the composer, and it carries the
 * booked-appointment and hardship exceptions for free.
 */
export function buildComplimentOnlyReply(args?: {
  suppression?: {
    needsEmpathy?: boolean | null;
    dispositionClosing?: boolean | null;
    alreadyPurchased?: boolean | null;
    appointment?: unknown;
  };
}): string {
  const warmth = "Glad you like it!";
  if (advanceEveryReplySuppressed(args?.suppression ?? {})) return warmth;
  return `${warmth} I can send more photos or a walkaround video. Anything specific you want to see?`;
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

/**
 * Cheap COST hint (not comprehension — parseBusinessHoursQuestionWithLLM owns the verdict, this
 * only decides whether that parser is worth calling): the customer asking whether WE are around
 * at some time, phrased without an hours word. Mirrors the sanctioned hasManualPromiseHint
 * pattern; over-matching costs one parser call and nothing else.
 *
 * isBusinessHoursQuestionText is a strict subset by construction, so the hint can never be
 * narrower than what already routes today.
 */
export function hasBusinessHoursQuestionHint(textRaw: string | null | undefined): boolean {
  const text = String(textRaw ?? "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return false;
  if (isBusinessHoursQuestionText(textRaw)) return true;
  const asksSomething =
    /[?]/.test(String(textRaw ?? "")) ||
    /\b(what|when|how|are|is|do|does|did|can|could|will|would|any)\b/.test(text);
  if (!asksSomething) return false;
  // "you/your" followed closely by an around-ness word. The proximity window is what keeps
  // "do you have any Road Glides available?" (inventory, 4 words away) from paying for a call,
  // while "are you guys available weekends?" and "what is your availability like?" both hint.
  const asksIfWeAreAround =
    /\b(?:you|u|ya|yall|y'all|your|ur)\b(?:\s+(?:guys|all|folks|team))?\s+(?:[a-z']+\s+){0,2}(?:open|available|availability|around|working|work|there|in)\b/.test(
      text
    ) || /\b(?:your|ur)\s+(?:availability|schedule)\b/.test(text);
  return asksIfWeAreAround;
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

/**
 * The one question BOTH inbound paths ask before the lexical sign-off test above is allowed to
 * end a turn: did the customer-ack parser read this as accepting something WE left pending?
 *
 * `isShortAckNoReplyText` stays exactly as it is — it is a KEEP-class safety gate (remove it and
 * we fail toward answering every "thanks"). What it cannot do is look at OUR previous message,
 * and a bare affirmative carries no meaning without it. So the parser outranks it in the cases it
 * provably gets wrong, and nowhere else:
 *  - `accept_scheduling_ask` — "Sounds great!" to "what day works?" (#535, 18 stranded leads).
 *  - `accept_offer_of_information` — "That would be great" to "I can send current incentives"
 *    (+16076549423, 2026-06-09). MEASURED 2026-08-07: recognising this in the parser alone was
 *    INERT. Replayed on the parser branch the turn still produced NO draft, because this gate
 *    fires on the word "great" and only exempted `accept_scheduling_ask`. The customer said yes
 *    to our own offer and got ten days of cadence and nothing else.
 *
 * Deliberately a CLOSED list of parser actions, not a general "parser wins" rule: an action outside
 * the pair leaves the word list in charge, which is the safe direction.
 *
 * ## THE SUB-FLOOR (Joe, 2026-08-07 — his call, asked and answered)
 *
 * Shipping the pair above was not enough. Replayed 6x against the deployed build, Michael's turn
 * produced a reply ONCE: the parser named `accept_offer_of_information` on 6 probes of 8 — the
 * comprehension is right — but reported confidence 0.53-0.78, and the acceptance rule every other
 * consumer uses needs >= 0.74. So the system understood him and then went quiet anyway.
 *
 * Joe chose the narrow fix over lowering the global floor: an UNCERTAIN parse is enough to DECLINE
 * AUTO-SILENCING, and nothing else. `accepted` (the full 0.74 bar) is untouched and still governs
 * every state write, every booking, and the offer-times arm — a sub-floor parse can only ever stop
 * this one gate from ending the turn, after which the ordinary draft path runs and staff approve it.
 *
 * WHY 0.5 IS SAFE, measured before it was written: 25 real sign-off turns from the live store — a
 * short ack whose previous DELIVERED outbound was a COMMITMENT or a plain thank-you, never an open
 * ask — were run through the parser. It named an accept action on **0 of 25**, at every candidate
 * bar down to 0.40. The ACTION LABEL is what discriminates a sign-off from an acceptance; the
 * confidence number is the model hedging about a case it has already read correctly. 0.5 keeps a
 * genuinely confused parse (below half) on the silent side.
 *
 * FAIL DIRECTION. Over-fire: a draft appears in the approval queue for someone who was signing off,
 * and staff discard it — prod is suggest mode, so nothing reaches a customer unreviewed. Under-fire:
 * a customer who said yes to our own offer hears nothing, ever. Joe weighed those and picked this.
 */
export const SHORT_ACK_SIGN_OFF_SUBFLOOR = 0.5;

export function parserAcceptanceDeclinesAutoSilence(args: {
  accepted: boolean;
  action?: string | null;
  confidence?: number | null;
  subFloor?: number | null;
}): boolean {
  if (args.action !== "accept_scheduling_ask" && args.action !== "accept_offer_of_information") {
    return false;
  }
  if (args.accepted) return true;
  const subFloor = typeof args.subFloor === "number" ? args.subFloor : SHORT_ACK_SIGN_OFF_SUBFLOOR;
  const confidence = typeof args.confidence === "number" ? args.confidence : 0;
  return confidence >= subFloor;
}

/**
 * The whole gate, so BOTH inbound paths ask ONE function and neither can drift: should this turn
 * end right here as a sign-off? Twilio only — the lexical test is SMS shorthand and was never
 * meant for ADF or widget bodies, which is why both call sites already checked the provider.
 */
export function shouldEndTurnAsShortAckSignOff(args: {
  provider?: string | null;
  text?: string | null;
  accepted: boolean;
  action?: string | null;
  confidence?: number | null;
}): boolean {
  if (args.provider !== "twilio") return false;
  if (!isShortAckNoReplyText(args.text)) return false;
  return !parserAcceptanceDeclinesAutoSilence({
    accepted: args.accepted,
    action: args.action,
    confidence: args.confidence
  });
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

/**
 * The advancing question that closes a finance-submission acknowledgement (charter C1.7).
 *
 * The prequal/credit acks are hardcoded templates, so the salesperson arm that went live on
 * 2026-08-08 — every reply ends with one question that advances the lead — could not reach them:
 * it acts on the LLM draft path only. Measured over the 30 days to 2026-08-08: 16 credit/prequal
 * ADF acks went out ending in a statement, on the warmest first-touch traffic we get, and the ONE
 * that asked anything was Joe's own hand-edit of exactly this template on 8/7 — he replaced
 * "I'll have our finance team reach out shortly to review options" with "What bike do you have
 * your eye on?". This function is that edit, generalized.
 *
 * The question never ASSERTS what the customer told us (charter C1.4: an ADF form field is not the
 * customer speaking), so a lead-record model is asked about, never attributed — which is also why
 * the known-bike form is an either/or rather than "still the X?".
 *
 * Placeholder detection goes through the existing `isPlaceholderModel` referee rather than a second
 * local rule. It is load-bearing here, not decoration: measured over the 30 days to 2026-08-08, all
 * 41 finance acks carried a lead vehicle but 7 of them read "Harley-Davidson Full Line" — and Joe's
 * own hand-edit was on one of these placeholder leads, which is precisely why he asked which bike.
 */
export function buildFinanceAckAdvancingQuestion(bikeLabelRaw?: string | null): string {
  const bike = String(bikeLabelRaw ?? "").trim();
  if (!bike || isPlaceholderModel(bike)) return "What bike do you have your eye on?";
  return `Are you looking at the ${bike}, or open to a couple of options?`;
}

/**
 * The C1.7 question for a finance ack whose copy ALREADY names the bike (the orchestrator's older
 * "thanks for your interest in the 2025 Road Glide" shape). Re-asking which bike there would read as
 * if we hadn't listened, so the advancing move is the visit — a choice of two, both of which are a
 * visit, which is what the offered-a-time funnel metric measures.
 */
export function buildFinanceAckVisitQuestion(): string {
  return "Do you want to come see it this week, or is the weekend easier?";
}

/**
 * The C1.7 question for a composed reply that may not have named a single unit — the multi-intent
 * answer (availability / price / trade, in any combination). Sibling of the finance-ack question
 * above, and deliberately a near-copy of it, with one difference that is the whole point: no "it".
 *
 * "Come see IT" needs an antecedent. In the finance ack the copy always names the bike one sentence
 * earlier, so "it" lands. Here the reply can be trade-only ("For the trade value, we can start with
 * an estimate…"), where the customer's bike is the only thing "it" could bind to and the sentence
 * inverts into an invitation to come look at their own motorcycle. Mike Wolf's turn
 * (+17164323990, 2026-08-07) is exactly that shape — price plus trade, and he had already SEEN the
 * new bike ("I've already seen one"). So the ask is the visit itself, still a choice of two, which
 * is what C1.7 prefers and what the offered-a-time funnel metric counts.
 */
export function buildVisitAdvanceQuestion(): string {
  return "Do you want to swing by this week, or is the weekend easier?";
}

export type FinanceSubmissionAckArgs = {
  /** A pre-qualification submission reads differently from a submitted credit application. */
  kind: "prequal" | "credit_app";
  /** Prequal only: the stage ladder's line, which replaces the generic advancing question. */
  stageAsk?: string | null;
  /** Has the customer received anything from us yet? Drives BOTH the wording and the intro. */
  introduce: boolean;
  firstName?: string | null;
  /** Hours-aware next-open phrase — "shortly" after close is a promise we can't keep. */
  when: string;
  /** Optional intro prefix (the live ADF lane applies its own prefix afterwards instead). */
  intro?: string | null;
  /** Lead-record model, already normalized by the caller; blank when we don't know one. */
  bikeLabel?: string | null;
  /**
   * The C1.7 exceptions, judged by the SAME referee the composer uses
   * (`advanceEveryReplySuppressed`) rather than a second rule that could drift from it. Suppressed
   * means DO NOT PUSH: the ack stays the plain statement it has always been.
   */
  suppression?: {
    needsEmpathy?: boolean | null;
    dispositionClosing?: boolean | null;
    alreadyPurchased?: boolean | null;
    appointment?: unknown;
  };
};

/**
 * ONE builder for the finance-submission ack, called by the live ADF lane
 * (routes/sendgridInbound.ts) and the regenerate lane (index.ts). It used to be two hand-maintained
 * copies of the same six-variant ternary, which is how the live lane and the regenerate lane drift.
 */
export function buildFinanceSubmissionAck(args: FinanceSubmissionAckArgs): string {
  const firstName = String(args.firstName ?? "").trim();
  const intro = String(args.intro ?? "");
  const body =
    args.kind === "prequal"
      ? args.introduce
        ? `Thanks — I received your pre-qualification submission. I’ll have our finance team reach out ${args.when} to review options.`
        : firstName
          ? `Thanks ${firstName} — we just received your pre-qualification submission. Our finance team will reach out ${args.when} to review options and next steps.`
          : `Thanks — we just received your pre-qualification submission. Our finance team will reach out ${args.when} to review options and next steps.`
      : args.introduce
        ? `Thanks — I received your credit application. I’ll have our finance team reach out ${args.when}.`
        : firstName
          ? `Thanks ${firstName} — we just received your online credit application. Our finance team will reach out ${args.when} to go over options.`
          : `Thanks — we just received your online credit application. Our finance team will reach out ${args.when} to go over options.`;
  if (advanceEveryReplySuppressed(args.suppression ?? {})) return `${intro}${body}`;
  // A PREQUAL lead gets its stage from the ladder (Joe, 2026-08-11): which bike, then the budget,
  // then the visit, then the application. `stageAsk` is that line, already decided and recorded by
  // applyPrequalStageReply. Credit-application leads keep the original question — Joe's directive
  // was about pre-qualification, and there are only 3 credit apps in 90 days to reason from.
  const stageAsk = String(args.stageAsk ?? "").trim();
  if (stageAsk) return `${intro}${body} ${stageAsk}`;
  return `${intro}${body} ${buildFinanceAckAdvancingQuestion(args.bikeLabel)}`;
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

// Has this conversation already produced a customer-facing outbound (agent draft or a
// human/staff send)? If so, a new ADF lead-ref landing on it must NOT re-introduce the
// agent — AGENTS.md "do not repeat introductions after the first outbound." Structured
// check over message history (direction + provider), not comprehension.
export function hasPriorCustomerFacingOutbound(
  messages:
    | Array<{ direction?: string | null; provider?: string | null; body?: string | null }>
    | null
    | undefined
): boolean {
  return (messages ?? []).some(m => {
    if (String(m?.direction ?? "").toLowerCase() !== "out") return false;
    const provider = String(m?.provider ?? "").toLowerCase();
    if (provider !== "draft_ai" && provider !== "twilio" && provider !== "sendgrid" && provider !== "sendgrid_adf") {
      return false;
    }
    return String(m?.body ?? "").trim().length > 0;
  });
}

export function buildRideChallengeSignupReply(args: {
  firstName?: string | null;
  agentName?: string | null;
  dealerName?: string | null;
  // True when the conversation already has prior customer-facing outbound (e.g. a salesperson
  // is mid-deal and a Ride Challenge ADF arrives on the same thread). Drop the intro so the
  // agent never re-introduces itself on an established conversation (persona_reintro charter miss).
  established?: boolean;
}): string {
  const firstName = String(args.firstName ?? "").trim() || "there";
  const agentName = String(args.agentName ?? "").trim() || GENERIC_AGENT_DISPLAY_NAME;
  const dealerName = String(args.dealerName ?? "").trim() || "American Harley-Davidson";
  const intro = args.established ? "" : `Hi ${firstName} — this is ${agentName} at ${dealerName}. `;
  return (
    `${intro}` +
    "Thanks for signing up for this year's ride challenge. " +
    "Feel free to stop in and record your miles throughout the year. " +
    "Let us know if you need anything to keep your bike rolling through the challenge!"
  );
}

// The 9/15 wrap-up touch (Joe ruling 2026-08-21: "generate a draft on the 15th").
// Mirrors the signup ack's promise ("stop in and record your miles") — the wrap-up asks for
// the FINAL reading. Deterministic template; deliberately NO agent intro: every recipient
// already got the signup ack on this thread, so re-introducing would be the persona_reintro
// charter miss (C1.2a). Invents nothing — no prize, no deadline beyond the event itself.
export function buildRideChallengeWrapUpReply(args: { firstName?: string | null }): string {
  const firstName = String(args.firstName ?? "").trim();
  const greeting = firstName ? `Hi ${firstName} — ` : "Hi — ";
  return (
    `${greeting}this year's ride challenge is wrapping up! ` +
    "Stop in when you get a chance so we can record your final mileage. " +
    "We'd love to hear how far you rode this season."
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

/**
 * Harley's INVENTORY TAXONOMY buckets — not model names. The Dealer Lead App writes its demo-bike
 * field as `YEAR,CATEGORY,MODEL` ("2026,CRUISER,BREAKOUT"), so the middle token is a shelf label the
 * dealer's website groups bikes under, never something a person says out loud. Nobody at a dealership
 * says "the 2026 Touring Street Glide"; they say "the 2026 Street Glide".
 */
const DEALER_LEAD_APP_CATEGORY_TOKENS = new Set([
  "touring",
  "grand american touring",
  "cruiser",
  "trike",
  "sport",
  "sportster",
  "street",
  "softail",
  "dyna",
  "cvo",
  "adventure",
  "adventure touring",
  "electric",
  "livewire"
]);

/**
 * Drop the taxonomy bucket from a demo-bike label, but ONLY when a real model name is left standing.
 *
 * The exception that forces the rule: "2015,SPORTSTER,1200 CUSTOM". Here the family word IS the name
 * — "the 2015 Sportster 1200 Custom" is how a dealer says it, while "the 2015 1200 Custom" is not a
 * bike. So the bucket stays whenever the model that follows it leads with a number, which is exactly
 * the displacement-style naming (1200 Custom, 883, 500) that needs the family word to make sense.
 *
 * Fail direction is deliberately toward KEEPING the word: a slightly clunky label is a cosmetic
 * blemish, a label with the model stripped out names the wrong bike (or no bike at all).
 */
function stripDealerLeadAppCategoryToken(labelParts: string[]): string[] {
  if (labelParts.length < 2) return labelParts;
  const [first, second] = labelParts;
  if (!DEALER_LEAD_APP_CATEGORY_TOKENS.has(String(first ?? "").trim().toLowerCase())) return labelParts;
  if (/^\d/.test(String(second ?? "").trim())) return labelParts;
  return labelParts.slice(1);
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
  const labelParts = stripDealerLeadAppCategoryToken(parts.filter((_, index) => index !== yearIndex));
  const label = [year, ...labelParts].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
  return label || null;
}

// Structured extraction (deterministic, AGENTS.md-allowed): pull a dealer stock number token out of
// a message. The SHAPE is learned from the dealer's own inventory feed rather than hardcoded — see
// stockIdShapes.ts for why (an "our stock numbers start with a letter" rule is an American Harley
// fact, not a universal one, and the AH-literal ratchet cannot see a shape assumption). Only the
// universal exclusions are fixed: a phone number, a calendar date, and a quantity range are not
// stock numbers at any dealer. Those alone fix the defect that started this — "Itz 716-713-8288"
// yielding "716-713" (+17164233031, msg_30b26a65c146e_1777309569346) — with or without a feed.
export function extractInventoryStockIdMention(textRaw: string | null | undefined): string | null {
  return extractStockIdFromText(textRaw, getLearnedStockIdShapes());
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
  // When the customer referenced a SPECIFIC unit (stock#/VIN) and the held/sold unit is a
  // DIFFERENT specific unit, never claim it — even if the model matches. Origin: Jason
  // Roorda's lead was the Snake Venom Street Glide Special U889-21, but a held same-model
  // unit (Gauntlet Gray U886-21) passed the model-token check, so the follow-up wrongly
  // said "you were interested in the Gauntlet Gray … on hold." A different stock# of the
  // same model is not the customer's bike. (Exact matches already returned true above.)
  const leadIsUnitSpecific = !!leadStock || !!leadVin;
  const unitIsSpecific = !!unitStock || !!unitVin;
  if (leadIsUnitSpecific && unitIsSpecific) return false;
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

/**
 * Whole-word "did the customer actually name this model this turn?" test, with plural
 * tolerance ("any sportsters" references Sportster). Same invariant the model-authority
 * relevance guard enforces — never act on a model the customer didn't reference — exposed
 * for the deterministic watch-label resolver, which was still doing a bare substring test.
 * Plural handling mirrors modelFamily.ts's familyPlural.
 */
export function catalogModelReferencedInTurnText(
  textRaw: string | null | undefined,
  modelRaw: string | null | undefined
): boolean {
  if (catalogModelMentionMatchesText(textRaw, modelRaw)) return true;
  const model = String(modelRaw ?? "").trim();
  if (!model || /s$/i.test(model)) return false;
  return catalogModelMentionMatchesText(textRaw, `${model}s`);
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

const ADF_FINANCE_APPLICATION_RE =
  /\b(hdfs|hdfs\s*coa|coa|credit\s*app(?:lication)?|finance\s*app(?:lication)?|pre[-\s]?qual(?:ify|ified)?)\b/i;
const ADF_FINANCE_APP_ID_RE = /\bapp\s*id\s*:/i;

/**
 * Does this ADF carry a genuine FINANCE-APPLICATION context (a real credit app / COA / prequal)?
 *
 * Trigger (Brent Marshall +17169941544, operator-reported 2026-07-29 — "Just because credit
 * application is mentioned in a walk in lead it['s not] considered a credit application lead"): a
 * Traffic Log Pro lead whose staff-written Inquiry read "Looking for a 2026 Road Glide in Dark
 * Billiard gray with black motor. Told him we have one coming in but not till late August and we
 * would need to redo credit application" was classified a CREDIT-APP lead. That set
 * bucket=finance_prequal / cta=hdfs_coa, a payments_handoff dialog state, an approval todo, a
 * manual handoff and a STOPPED cadence — and the first draft told him "Thanks — I received your
 * credit application." He had submitted nothing; he asked about a bike.
 *
 * Root cause: the finance-context test read the ADF's free `Inquiry`/comment text. On a Traffic
 * Log Pro payload that field is the dealership's OWN CRM log, written by STAFF about the customer
 * ("Told him …", "Robert came in …", "I gave him book values …", "(Step 2)") — an internal note,
 * not the customer's words. Reading routing intent out of it is the same bug class as the walk-in
 * budget leak that created buildWalkInSpecRecapClause (Joe ruling 2026-07-28 #4).
 *
 * So on a Traffic Log Pro payload, finance context is read ONLY from STRUCTURED evidence:
 *  - the lead SOURCE — vendor metadata that names a real credit product outright ("HDFS COA
 *    Online", "Marketplace - Rider to Rider Credit App"); and
 *  - the TLP `App ID:` field, which exists only when an application actually posted.
 * Free prose still counts on every NON-TLP ADF (web forms, marketplace, dealer site), where the
 * inquiry text really is the customer talking. Non-TLP behavior is unchanged.
 *
 * BUCKET: deterministic STRUCTURED EXTRACTION (which vendor field is present / what the Source
 * says) feeding a ROUTING + SIDE-EFFECT gate (handoff, approval todo, cadence stop). It makes no
 * judgment about what the customer MEANT — that stays with the typed parsers.
 *
 * FAIL DIRECTION: toward the normal, live sales thread. A miss now means a lead whose staff note
 * mentions financing gets an ordinary draft and a running cadence — visible and recoverable. The
 * old behavior failed the other way: a false "I got your application", a manual handoff and a
 * stopped cadence silently killed a live bike inquiry. Every genuine application still routes,
 * because it arrives with its own Source or an `App ID:`.
 */
export function hasAdfFinanceApplicationContext(args: {
  leadSource?: string | null;
  /** Free-prose fields (comment / inquiry / raw inquiry / raw body) — customer words on non-TLP ADFs. */
  proseTexts?: (string | null | undefined)[];
  /** Fields searched for the structured `App ID:` marker (comment / inquiry / raw inquiry). */
  appIdTexts?: (string | null | undefined)[];
  trafficLogPayloadHint?: boolean | null;
  walkInSignalHint?: boolean | null;
}): boolean {
  // The Source is vendor metadata on every provider — always trustworthy.
  if (ADF_FINANCE_APPLICATION_RE.test(String(args.leadSource ?? ""))) return true;
  const isTrafficLogPayload = !!args.trafficLogPayloadHint;
  if (!isTrafficLogPayload) {
    const prose = (args.proseTexts ?? []).filter(Boolean).join(" ");
    if (ADF_FINANCE_APPLICATION_RE.test(prose)) return true;
  }
  if (isTrafficLogPayload && !args.walkInSignalHint) {
    const appIdText = (args.appIdTexts ?? []).filter(Boolean).join(" ");
    if (ADF_FINANCE_APP_ID_RE.test(appIdText)) return true;
  }
  return false;
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
    const agentName = String(args.agentName ?? "").trim() || GENERIC_AGENT_DISPLAY_NAME;
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

/**
 * Did this lead already put a credit application in with US?
 *
 * Structured extraction off the lead record — no LLM, no guessing at the customer's words. The
 * dealer-specific credit-app invite is only useful to someone who has NOT applied here yet; a
 * customer who arrived on our own credit-application lead source has one on file already, so
 * inviting them to "complete our store application" reads as if we lost their paperwork.
 *
 * FAIL DIRECTION (deliberately conservative — only strong signals count): a false NEGATIVE just
 * appends the store link the way we always have (today's behavior, harmless). A false POSITIVE
 * withholds a link someone actually needed, so this returns true only when the lead record says
 * plainly that the application came to us.
 */
export function hasOwnCreditApplicationOnFile(
  conv?: {
    classification?: { bucket?: string | null; cta?: string | null } | null;
    lead?: { source?: string | null; inquiry?: string | null } | null;
  } | null
): boolean {
  const cta = String(conv?.classification?.cta ?? "").trim().toLowerCase();
  if (cta === "hdfs_coa") return true;
  const source = String(conv?.lead?.source ?? "").trim().toLowerCase();
  if (
    source.includes("apply for credit") ||
    source.includes("coa online") ||
    source.includes("hdfs coa") ||
    source.includes("credit application")
  ) {
    return true;
  }
  const bucket = String(conv?.classification?.bucket ?? "").trim().toLowerCase();
  const inquiry = String(conv?.lead?.inquiry ?? "");
  return bucket === "finance_prequal" && /\bapp\s*id\b/i.test(inquiry);
}

/**
 * Answer the question that was ASKED: an HDFS approval is portable across Harley dealers.
 *
 * Pins finding `+17162605541::human_correction_material` (production turn 2026-07-19T01:01:48Z).
 * The customer asked "hi does that apply to any harley dealer" and this builder answered only
 * about OUR store ("it can be used at our store … complete a separate application for our
 * dealership"), so the general question went unanswered and Joe corrected it by hand 12h later:
 * "you can use it at any Harley dealer. If you found a bike at another dealership, your HDFS
 * approval should work there too, you would just have to put an application in with that dealer
 * so they have access to your open application."
 *
 * Every fact the old copy carried is kept — it just leads with the portable answer instead of
 * the store-centric one, and it drops the redundant apply-here link for a customer whose
 * application we already hold. The reply must not depend on the paragraph break: the outbound
 * body observed in production had the "\n\n" flattened to a single space.
 */
export function buildExternalDealerApprovalTransferReply(
  creditAppUrl?: string | null,
  conv?: Parameters<typeof hasOwnCreditApplicationOnFile>[0]
): string {
  const url = String(creditAppUrl ?? "").trim();
  const base =
    "Yes — an approval through Harley-Davidson Financial Services is good at any Harley dealer, not just us. " +
    "Each dealership does have to put in its own application so they can pull up your open approval, " +
    "and that isn't another credit inquiry.";
  if (hasOwnCreditApplicationOnFile(conv)) {
    return `${base} We already have your application on file here.`;
  }
  if (!url) {
    return `${base} I can send you the link to complete our store application.`;
  }
  return `${base}\n\n${url}`;
}

// ---------------------------------------------------------------------------
// PRE-QUALIFICATION STAGE LADDER — the copy (Joe, 2026-08-11). The DECISION is
// decidePrequalTurn in routeStateReducer.ts; this file only says the words.
//
// Deterministic, not LLM-composed, for the same reason the finance ack is: the credit-application
// line carries a customer-facing URL, and a link the model invents is a link that 404s. The two
// qualifying questions are deterministic to keep all four stages in one readable place.
//
// Every one is a CHOICE OF TWO where a choice is fair. Joe, 2026-08-07: an either/or is easier to
// answer from a phone than an open question, and every answer qualifies the lead further.
// ---------------------------------------------------------------------------

/** Stage 1 — only ever reached when the lead's bike is missing or a catch-all (isPlaceholderModel). */
export function buildPrequalBikeAsk(): string {
  return "To get you the right numbers — which bike are you looking at?";
}

/**
 * Stage 2 — the gap the measurement found: budget captured on ZERO of 27 prequal leads in 90 days.
 *
 * Asks for a MONTHLY payment, not a purchase price. That is the number a pre-qualified buyer
 * actually has in mind, it is the one `paymentBudgetContext` already stores, and it does not require
 * the customer to know what anything costs. It names no figure of our own — quoting money is not
 * this ladder's job.
 */
export function buildPrequalBudgetAsk(bikeLabelRaw?: string | null): string {
  const bike = String(bikeLabelRaw ?? "").trim();
  const on = bike && !isPlaceholderModel(bike) ? ` on the ${bike}` : "";
  return `Do you have a monthly payment in mind${on}, or would it help to see what a few options look like?`;
}

/** Stage 3 — the appointment try. A visit is the goal; give one concrete shape to say yes to. */
export function buildPrequalVisitAsk(): string {
  return "Want to come take a look this week, or is the weekend easier?";
}

/**
 * Stage 4 — the fallback, and the only one that is not a question.
 *
 * Reached when the customer told us coming in is not their path, or after two invitations with no
 * booking. It hands them the dealer's real application and keeps the door open without pushing.
 * Returns null when there is no real URL: we never fabricate a link, and the caller falls back to
 * inviting them in (decidePrequalTurn already prefers offer_visit in that case).
 */
export function buildPrequalCreditAppLine(creditAppUrlRaw?: string | null): string | null {
  const url = String(creditAppUrlRaw ?? "").trim();
  if (!/^https?:\/\//i.test(url)) return null;
  return `No problem — you can get pre-approved right from your phone here: ${url}. Once it's in, I'll follow up with what you qualify for.`;
}

/** The copy for a stage. `null` means "this stage has nothing to say" and the caller leaves the draft alone. */
export function buildPrequalStageLine(args: {
  stage: string;
  bikeLabel?: string | null;
  creditAppUrl?: string | null;
  /** When the lender's soft check did not clear, the application line explains WHY it is the move. */
  prequalResult?: PrequalSubmissionResult;
}): string | null {
  switch (args.stage) {
    case "ask_bike":
      return buildPrequalBikeAsk();
    case "ask_budget":
      return buildPrequalBudgetAsk(args.bikeLabel);
    case "offer_visit":
      return buildPrequalVisitAsk();
    case "send_credit_app":
      return args.prequalResult === "not_cleared"
        ? buildPrequalNotClearedCreditAppLine(args.creditAppUrl)
        : buildPrequalCreditAppLine(args.creditAppUrl);
    default:
      return null;
  }
}

/**
 * What the LENDER already told us about a pre-qualification lead.
 *
 * A `Marketplace - Prequal` ADF carries its own verdict in the inquiry field, and the lender prints
 * the next step right beside it:
 *
 *   "PreQual: N, PreQualified Amount; $0  Please note non-prequalified customers can still be
 *    considered for approval with a completed credit application."
 *
 * Deterministic on purpose, and AGENTS.md allows exactly this: it is STRUCTURED EXTRACTION from a
 * MACHINE RECORD, not comprehension of customer prose. `PreQual:` is a field the lender emits in a
 * fixed shape — reading it with a parser would be paying an LLM to read a form field, and would make
 * a hard fact probabilistic.
 *
 * MEASURED across all 42 prequal leads (2026-08-11): 15 say N, 5 say Y, 22 carry no PreQual field at
 * all (older/other feeds). So `unknown` is the COMMONEST answer and must behave exactly as today —
 * this reader may only ever ADD information, never take the benefit of the doubt away.
 *
 * We never read the AMOUNT. What someone was pre-qualified for is a money figure and none of this
 * ladder's business.
 */
export type PrequalSubmissionResult = "cleared" | "not_cleared" | "unknown";

export function readPrequalSubmissionResult(inquiryRaw?: string | null): PrequalSubmissionResult {
  const text = String(inquiryRaw ?? "");
  if (!text.trim()) return "unknown";
  const match = /\bPreQual\s*:\s*([A-Za-z]+)/i.exec(text);
  if (!match) return "unknown";
  const value = match[1].trim().toUpperCase();
  if (value === "N" || value === "NO") return "not_cleared";
  if (value === "Y" || value === "YES") return "cleared";
  return "unknown";
}

/**
 * The credit-application line for a lead whose SOFT CHECK did not clear.
 *
 * ⚠️ It must never state the customer's credit outcome back to them. Adverse-action notice is the
 * LENDER's job, not ours, and "you weren't approved" is both a compliance surface and a rotten text
 * to receive. What it says instead is true, non-judgmental, and is the lender's OWN wording from the
 * form: a pre-qual is a soft check; a completed application is what produces a real answer.
 */
export function buildPrequalNotClearedCreditAppLine(creditAppUrlRaw?: string | null): string | null {
  const url = String(creditAppUrlRaw ?? "").trim();
  if (!/^https?:\/\//i.test(url)) return null;
  // The visit door stays OPEN. Skipping straight past the appointment on the 15-of-42 leads whose
  // soft check did not clear would trade a booking for an application, and booking is the number the
  // business is actually judged on. Same shape as the older buildFinanceAppInviteLine: the link, then
  // a low-pressure "or come in" — no question, so it never breaks "one question, never two".
  return `That pre-qual is only a soft check — a full application is what gets you a real answer, and you can do it right from your phone here: ${url}. Or stop in and we'll run it with you.`;
}

/**
 * The pre-qualification ladder's stage, said as a GOAL for the composer rather than as a sentence to
 * copy (Joe, 2026-08-11 — the follow-up-turn half of the flow).
 *
 * The first touch uses the fixed line (`buildPrequalStageLine`): it is an acknowledgement, there is
 * no customer turn to answer yet, and a deterministic ack is the right shape. Every turn AFTER that
 * hands the composer a goal instead, for two reasons Joe named:
 *  - the customer may say something unpredictable, and only the composer can answer THAT and still
 *    steer back;
 *  - a fixed sentence sent twice is the exact repetition he asked us to avoid.
 *
 * `send_credit_app` deliberately returns NULL: that stage carries a URL, a customer-facing link must
 * never be LLM-composed, and it is delivered deterministically instead.
 */
export function buildPrequalStageGoal(stage: string, bikeLabelRaw?: string | null): string | null {
  const bike = String(bikeLabelRaw ?? "").trim();
  switch (stage) {
    case "ask_bike":
      return "find out which bike they actually want — the lead form only gave a catch-all, so nothing else can be priced until you know";
    case "ask_budget":
      return bike && !isPlaceholderModel(bike)
        ? `find out what monthly payment they have in mind on the ${bike}. Ask about a MONTHLY payment, never a purchase price, and never name a figure of your own`
        : "find out what monthly payment they have in mind. Ask about a MONTHLY payment, never a purchase price, and never name a figure of your own";
    case "offer_visit":
      return "get them in the door — name a specific day and a rough time they can say yes to";
    default:
      return null;
  }
}
