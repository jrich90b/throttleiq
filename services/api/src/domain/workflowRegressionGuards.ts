export type RequestedScheduleWindowMode = "after" | "before" | "any_time" | "window" | "none";

export function isManualOutboundBookingConfirmationText(textRaw: string | null | undefined): boolean {
  const text = String(textRaw ?? "").toLowerCase();
  if (!text.trim()) return false;
  return (
    /\b(you(?:'|’)re|you are)\s+(all set|booked|confirmed)\b/i.test(text) ||
    /\b(booked for|confirmed for|appointment(?: is)? set|see you then|locked in)\b/i.test(text) ||
    /\b(?:i|we)\s*(?:'|’)?ll\s+(?:schedule|book|set(?:\s+up)?)\b[\s\S]{0,80}\b(?:for|on|at)\b/i.test(
      text
    ) ||
    /\b(?:i|we)\s+will\s+(?:schedule|book|set(?:\s+up)?)\b[\s\S]{0,80}\b(?:for|on|at)\b/i.test(
      text
    ) ||
    /\b(?:scheduled|booked|set(?:\s+up)?)\b[\s\S]{0,80}\b(?:for|on|at)\b/i.test(text)
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
  return (
    /\b(hiring manager|manager (?:for|about) (?:hiring|jobs?|careers?|employment)|who (?:is|do i contact).{0,80}(?:hiring|jobs?|careers?|employment))\b/i.test(
      text
    ) ||
    /\b(apply|application|resume|job opening|job openings|career|careers|employment|hiring)\b/i.test(text)
  );
}

export function buildHiringManagerInquiryReply(): string {
  return "Thanks for reaching out. I’ll pass your message along and have the hiring manager follow up with you.";
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
  if (!mentionsHandlebars) return false;

  return (
    /\b(can|could|would|are)\s+(?:you|u|we|the shop)\b[\s\S]{0,80}\b(change|swap|replace|install|put|do)\b/i.test(
      text
    ) ||
    /\b(change|swap|replace|install|put|do)\b[\s\S]{0,80}\b(handle\s*bars?|handlebars?|handbars?|bars?)\b/i.test(
      text
    ) ||
    /\bnot\s+a\s+fan\b[\s\S]{0,80}\b(ones|these|those|stock|current)\b/i.test(text)
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

  return "Yes — we can help with that customization. I’ll have our team check the right parts and labor for that bike and follow up with options.";
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
