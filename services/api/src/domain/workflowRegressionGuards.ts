export type RequestedScheduleWindowMode = "after" | "before" | "any_time" | "window" | "none";

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
  if (
    /\b(price|pricing|payment|monthly|apr|term|down payment|trade|trade in|service|parts|apparel|available|availability|in stock|stock|test ride|appointment|schedule|call|video|photos?|email|watch)\b/i.test(
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
  return /\blike i (?:said|mentioned|told you)\b/.test(text);
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

export function selectRequestedAvailabilityModelMentions(
  textRaw: string | null | undefined,
  candidates: AvailabilityModelMention[]
): string[] {
  const normalizedText = normalizeAvailabilityModelMentionText(textRaw);
  if (!normalizedText || !candidates.length) return [];
  const hasAlternativeSignal =
    /\b(or|either|any|something|lighter|smaller|smaller than|lighter than)\b/.test(normalizedText);
  if (!hasAlternativeSignal && candidates.length < 2) {
    return candidates[0]?.model ? [String(candidates[0].model)] : [];
  }

  const selected: string[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const model = String(candidate.model ?? "").trim();
    if (!model) continue;
    const normalizedModel = normalizeAvailabilityModelMentionText(model);
    if (!normalizedModel) continue;
    const index =
      typeof candidate.index === "number" && candidate.index >= 0
        ? candidate.index
        : normalizedText.indexOf(normalizedModel);
    const before = index >= 0 ? normalizedText.slice(Math.max(0, index - 80), index) : "";
    const isComparisonReference =
      /\b(lighter|smaller|bigger|larger|heavier|easier|more manageable)\b.{0,50}\bthan(?: the)?\s*$/.test(
        before
      );
    if (isComparisonReference) continue;
    if (seen.has(normalizedModel)) continue;
    seen.add(normalizedModel);
    selected.push(model);
  }
  return selected;
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
  if (/\b(any\s*time|anytime)\b/.test(text)) return "any_time";
  return "none";
}
