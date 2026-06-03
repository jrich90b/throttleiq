export type DraftStateInvariantInput = {
  inboundText: string;
  draftText: string;
  followUpMode?: string | null;
  followUpReason?: string | null;
  dialogState?: string | null;
  classificationBucket?: string | null;
  classificationCta?: string | null;
  turnFinanceIntent?: boolean | null;
  turnAvailabilityIntent?: boolean | null;
  turnSchedulingIntent?: boolean | null;
  financeContextIntent?: boolean | null;
  shortAckIntent?: boolean | null;
};

export type DraftStateInvariantResult = {
  allow: boolean;
  draftText: string;
  reason?: string;
};

function isEmojiOnlyText(text: string): boolean {
  const t = String(text ?? "").trim();
  return t.length > 0 && /^[\p{Extended_Pictographic}\s]+$/u.test(t);
}

function isShortAckText(text: string): boolean {
  const t = String(text ?? "").trim().toLowerCase();
  if (!t) return false;
  if (isEmojiOnlyText(t)) return true;
  if (t.length > 60) return false;
  if (/[?]/.test(t)) return false;
  return /\b(thanks|thank you|thanks again|thx|ty|appreciate|got it|sounds good|sounds great|will do|ok|okay|k|kk|cool|perfect|great|all good|no problem|you bet|yep|yup|sure)\b/.test(
    t
  );
}

function looksLikeTruncatedDraft(text: string): boolean {
  const t = String(text ?? "").trim();
  if (t.length < 18) return false;
  const normalized = t.replace(/\s+/g, " ").trim();
  if (!normalized) return false;
  if (/[.!?)]["']?\s*$/.test(normalized)) return false;
  if (/\b(?:about\s+the|about|the|a|an|and|or|but|because|with|for|to|from|of|on|in|at|if|when|while|that|this|your|my|our|his|her|their|before|after|over|under|between|into|by|as)\s*$/i.test(normalized)) {
    return true;
  }
  if (/\b(?:you(?:'|’)?ll|you will|you(?:'|’)?re|you are)?\s*(?:be\s+)?in\s+good\s*$/i.test(normalized)) {
    return true;
  }
  if (/\band\s+(?:moves?|works?|takes?|does?|handles?|will|can|should)\s*$/i.test(normalized)) {
    return true;
  }
  if (/[,:;—-]\s*$/.test(normalized)) return true;
  return false;
}

function truncatedDraftFallback(input: Partial<DraftStateInvariantInput>, draftText = ""): string {
  const inboundText = String(input.inboundText ?? "").toLowerCase();
  const draftLower = String(draftText ?? "").toLowerCase();
  if (
    (!/[?]/.test(inboundText) &&
      /\b(all set|not looking|no longer looking|not interested|reach out|reached out|when i'?m ready|when i am ready)\b/.test(
        inboundText
      )) ||
    /\b(glad to hear it worked out|congrats|congratulations)\b/.test(draftLower)
  ) {
    return "Sounds good — thanks for the update.";
  }
  const bucket = String(input.classificationBucket ?? "").toLowerCase();
  const cta = String(input.classificationCta ?? "").toLowerCase();
  const reason = String(input.followUpReason ?? "").toLowerCase();
  if (
    /\b(parts?|service|apparel|motorclothes)\b/.test(inboundText) ||
    ["service", "parts", "apparel"].includes(bucket) ||
    /(service|parts|apparel)_request/.test(cta) ||
    /(service|parts|apparel|dealer_ride_no_purchase|credit_app|handoff:)/.test(reason)
  ) {
    return "I’ll have the right person check that and follow up shortly.";
  }
  return "I’ll check on that and follow up shortly.";
}

function looksLikeUnresolvedOtherInventoryDraft(text: string): boolean {
  const t = String(text ?? "").toLowerCase();
  if (!t.trim()) return false;
  const unresolvedOther =
    /\bharley[-\s]?davidson\s+other\b/.test(t) ||
    /\bnew\s+20\d{2}\s+harley[-\s]?davidson\s+other\b/.test(t);
  if (!unresolvedOther) return false;
  return /\b(not seeing|don['’]?t see|not finding|in stock|available|availability|have)\b/.test(t);
}

function unresolvedOtherInventoryFallback(input: Partial<DraftStateInvariantInput>): string {
  const inboundText = String(input.inboundText ?? "").toLowerCase();
  if (/\b(budget|range|under|below|around|about|max|maximum|bags|bagger|saddlebags?)\b/.test(inboundText)) {
    return "I’ll have the team check current options in your range with bags and follow up shortly.";
  }
  return "I’ll have the team check current options that fit what you’re asking for and follow up shortly.";
}

export function repairLikelyTruncatedDraftText(
  draftTextRaw: string,
  input: Partial<DraftStateInvariantInput> = {}
): { repaired: boolean; draftText: string } {
  const draftText = String(draftTextRaw ?? "").trim();
  if (!looksLikeTruncatedDraft(draftText)) return { repaired: false, draftText };
  return {
    repaired: true,
    draftText: truncatedDraftFallback(input, draftText)
  };
}

function looksLikeInventoryPromptDraft(text: string): boolean {
  const t = String(text ?? "").toLowerCase();
  if (!t.trim()) return false;
  return (
    /\b(which model are you (?:interested|leaning)|exact year\/color\/finish)\b/.test(t) ||
    /\b(happy to check inventory right now|specific year,?\s*color,?\s*or\s*trim|specific year\/color\/trim)\b/.test(
      t
    ) ||
    /\b(keep an eye out|watch for|text you as soon as one comes in|when one comes in)\b/.test(t) ||
    /\b(walkaround video|more photos?|a couple photos?)\b/.test(t) ||
    /\b(stop by to take a look|come check it out)\b/.test(t)
  );
}

function looksLikeDepartmentHandoffActionDraft(text: string): boolean {
  const t = String(text ?? "").toLowerCase();
  if (!t.trim()) return false;
  return (
    /\b(parts?|apparel|motorclothes|service)\s+(?:team|department|counter|advisor|writer)\b/.test(t) ||
    /\b(?:have|ask)\s+(?:our|the)\s+(?:parts?|apparel|motorclothes|service)\b/.test(t)
  );
}

function looksLikeSchedulingPromptDraft(text: string): boolean {
  const t = String(text ?? "").toLowerCase();
  if (!t.trim()) return false;
  return (
    /\b(what day and time works|what day works|what time works|what time were you thinking)\b/.test(t) ||
    /\b(are you looking to set a time|want me to lock that in|want me to book|do any of these times work)\b/.test(
      t
    ) ||
    /\b(appointment|schedule|book)\b/.test(t)
  );
}

function looksLikePricingPromptDraft(text: string): boolean {
  const t = String(text ?? "").toLowerCase();
  if (!t.trim()) return false;
  return (
    /\b(the price we have listed|ballpark|before taxes and fees|monthly payment|what monthly payment|what monthly|how much down|down payment|do you have a trade|60,?\s*72,?\s*or\s*84)\b/.test(
      t
    ) ||
    /\b(exact pricing|current price|pull (?:the )?(?:exact )?pricing|follow up with exact numbers)\b/.test(t) ||
    /\b(per month|\/mo|apr|financing)\b/.test(t)
  );
}

function hasAvailabilityTurnSignal(text: string): boolean {
  const t = String(text ?? "").toLowerCase();
  if (!t.trim()) return false;
  return /\b(in[-\s]?stock|available|availability|do you have|have any|any .* in[-\s]?stock|still there|still available)\b/.test(
    t
  );
}

function hasFreshInventoryInterestSignal(text: string): boolean {
  const t = String(text ?? "").toLowerCase();
  if (!t.trim()) return false;
  const hasShoppingVerb = /\b(looking for|lookin for|after|want|wanting|interested in|shopping for|trying to find)\b/.test(
    t
  );
  const hasBikeModel =
    /\b(cvo|road glide|street glide|pan america|breakout|low rider|fat boy|fat bob|heritage|sportster|nightster|softail|road king|tri glide|freewheeler)\b/.test(
      t
    );
  const hasYear = /\b20\d{2}\b/.test(t);
  return hasShoppingVerb && (hasBikeModel || hasYear);
}

function hasFinanceTurnSignal(text: string): boolean {
  const t = String(text ?? "").toLowerCase();
  if (!t.trim()) return false;
  return (
    /\b(apr|rate|rates|monthly|payment|payments|per month|down payment|how much down|put down|money down|cash down|term|months?|financing|finance|credit score|credit app|credit application|application)\b/.test(
      t
    ) ||
    /\bput\b[^.?!]{0,40}\bdown\b/.test(t) ||
    /\b(deal(?:s)?|finance special(?:s)?|special(?:s)?|promo(?:tion)?(?:s)?|offer(?:s)?|incentive(?:s)?|rebate(?:s)?|discount(?:s)?)\b/.test(
      t
    ) ||
    /\b(?:no|zero|\$?0)\s*(?:money\s*)?down\b/.test(t) ||
    /\b(?:don'?t|dont|do not)\s+(?:want|have)\s+to\s+put\s+(?:anything|any money|money)\s+down\b/.test(
      t
    ) ||
    /\b(?:under|below|around|about|stay under|keep (?:it|me)? under|max(?:imum)?)\s*\$?\s*\d{2,6}\s*(?:\/\s*mo|\/\s*month|per month|a month|monthly)\b/.test(
      t
    ) ||
    /\bcan you run (?:it|that|the numbers?) for\s+\d{2,3}\s*(?:months?|mo)?\b/.test(t) ||
    /\$\s?\d[\d,]*(?:\s*\/\s*(?:mo|month))?/.test(t) ||
    /\b\d{2,3}\s*(?:mo|month|months)\b/.test(t)
  );
}

function hasFinanceContext(input: DraftStateInvariantInput): boolean {
  const dialogState = String(input.dialogState ?? "").toLowerCase();
  const followUpReason = String(input.followUpReason ?? "").toLowerCase();
  const cta = String(input.classificationCta ?? "").toLowerCase();
  return (
    dialogState.startsWith("pricing_") ||
    dialogState.startsWith("payments_") ||
    /(^|:|\b)(pricing|payments?|finance|financing|credit|approval)\b/.test(followUpReason) ||
    /(^|:|\b)(ask_payment|payments?|finance|financing|credit|approval)\b/.test(cta)
  );
}

function hasExplicitFinanceActionSignal(text: string): boolean {
  const t = String(text ?? "").toLowerCase();
  if (!t.trim()) return false;
  return /\b(credit app|credit application|finance app|financing application|apply for (?:credit|financing)|fill out (?:a )?(?:credit|finance|financing) app)\b/.test(
    t
  );
}

function hasBareBudgetSignal(text: string): boolean {
  const t = String(text ?? "").toLowerCase();
  if (!t.trim()) return false;
  return /\b(?:under|below|around|about|stay under|keep (?:it|me)? under|max(?:imum)?)\s*\$?\s*\d{2,6}\b/.test(
    t
  );
}

function hasSchedulingTurnSignal(text: string): boolean {
  const t = String(text ?? "").toLowerCase();
  if (!t.trim()) return false;
  return (
    /\b(today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/.test(t) ||
    /\b\d{1,2}(?::\d{2})?\s*(?:am|pm)\b/.test(t) ||
    /\b(schedule|book|appointment|time works)\b/.test(t)
  );
}

function isAppointmentStatusQuestionText(text: string): boolean {
  const t = String(text ?? "").toLowerCase();
  if (!t.trim()) return false;
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

function looksLikeNewSchedulingAvailabilityDraft(text: string): boolean {
  const t = String(text ?? "").toLowerCase();
  if (!t.trim()) return false;
  return (
    /\bcheck available times\b/.test(t) ||
    /\bwhat (?:day|time) (?:works|would work|is best)\b/.test(t) ||
    /\bdo any of these times work\b/.test(t) ||
    /\bavailable times? for\b/.test(t)
  );
}

function isPostSalePropertyDropoffLogisticsText(text: string): boolean {
  const t = String(text ?? "").toLowerCase();
  if (!t.trim()) return false;
  const hasPostSaleItem = /\b(garage\s+keys?|keys?|key\s*ring|keyring|seat|back\s*seat|backseat|stock\s+(?:exhaust|pipes?|parts?)|take[-\s]?offs?)\b/.test(
    t
  );
  if (!hasPostSaleItem) return false;
  return /\b(drop(?:ping)? off|bring(?:ing)? by|stopping by|stop by|swing by|pick(?:ing)? up|pickup|grab|left|forgot|still have)\b/.test(
    t
  );
}

function looksLikeScheduleTimeCheckDraft(text: string): boolean {
  const t = String(text ?? "").toLowerCase();
  if (!t.trim()) return false;
  return (
    /\bcheck that time\b/.test(t) ||
    /\bcheck (?:the|that)?\s*(?:appointment|schedule|slot|availability)\b/.test(t) ||
    /\bwhat (?:day|time) (?:works|would work|is best)\b/.test(t)
  );
}

function hasAccessoryCustomizationTurnSignal(text: string): boolean {
  const t = String(text ?? "").toLowerCase();
  if (!t.trim()) return false;
  const mentionsHandlebars =
    /\b(handle\s*bars?|handlebars?|handbars?|bars?)\b/i.test(t) &&
    !/\b(bar and shield|bar\s*&\s*shield)\b/i.test(t);
  if (!mentionsHandlebars) return false;
  return (
    /\b(can|could|would|are)\s+(?:you|u|we|the shop)\b[\s\S]{0,80}\b(change|swap|replace|install|put|do)\b/i.test(
      t
    ) ||
    /\b(change|swap|replace|install|put|do)\b[\s\S]{0,80}\b(handle\s*bars?|handlebars?|handbars?|handbars?|bars?)\b/i.test(
      t
    ) ||
    /\bnot\s+a\s+fan\b[\s\S]{0,80}\b(ones|these|those|stock|current)\b/i.test(t)
  );
}

function isDepartmentHandoff(input: DraftStateInvariantInput): boolean {
  const bucket = String(input.classificationBucket ?? "").toLowerCase();
  const cta = String(input.classificationCta ?? "").toLowerCase();
  const reason = String(input.followUpReason ?? "").toLowerCase();
  return (
    ["service", "parts", "apparel"].includes(bucket) ||
    /(service|parts|apparel)_request/.test(cta) ||
    /(service|parts|apparel|dealer_ride_no_purchase|credit_app|handoff:)/.test(reason)
  );
}

export function applyDraftStateInvariants(
  input: DraftStateInvariantInput
): DraftStateInvariantResult {
  const draftText = String(input.draftText ?? "").trim();
  if (!draftText) {
    return { allow: false, draftText: "", reason: "empty_draft" };
  }
  const followUpMode = String(input.followUpMode ?? "").toLowerCase();
  const dialogState = String(input.dialogState ?? "").toLowerCase();
  const inboundText = String(input.inboundText ?? "");
  const truncationRepair = repairLikelyTruncatedDraftText(draftText, input);
  if (truncationRepair.repaired) {
    return {
      allow: true,
      draftText: truncationRepair.draftText,
      reason: "truncated_draft_repaired"
    };
  }
  if (looksLikeUnresolvedOtherInventoryDraft(draftText)) {
    return {
      allow: true,
      draftText: unresolvedOtherInventoryFallback(input),
      reason: "unresolved_inventory_entity_repaired"
    };
  }
  // Parser-first: do not activate invariant routing guards from regex fallbacks.
  const regexFallbackEnabled = false;
  const inventoryPrompt = looksLikeInventoryPromptDraft(draftText);
  const pricingPrompt = looksLikePricingPromptDraft(draftText);
  const schedulingPrompt = looksLikeSchedulingPromptDraft(draftText);
  const financeSignal =
    input.turnFinanceIntent === true
      ? true
      : input.turnFinanceIntent === false
        ? false
        : regexFallbackEnabled
          ? hasFinanceTurnSignal(inboundText)
          : false;
  const availabilitySignal =
    input.turnAvailabilityIntent === true
      ? true
      : input.turnAvailabilityIntent === false
        ? false
        : regexFallbackEnabled
          ? hasAvailabilityTurnSignal(inboundText)
          : false;
  const financeContextSignal =
    input.financeContextIntent === true
      ? true
      : input.financeContextIntent === false
        ? false
        : hasFinanceContext(input) &&
            (hasExplicitFinanceActionSignal(inboundText) ||
              (regexFallbackEnabled ? hasBareBudgetSignal(inboundText) : false));
  const schedulingSignal =
    input.turnSchedulingIntent === true
      ? true
      : input.turnSchedulingIntent === false
        ? false
        : regexFallbackEnabled
          ? hasSchedulingTurnSignal(inboundText)
          : false;
  const shortAckSignal =
    input.shortAckIntent === true
      ? true
      : input.shortAckIntent === false
        ? false
        : isShortAckText(inboundText);
  const financePriority = financeSignal || financeContextSignal;
  const accessoryCustomizationSignal = hasAccessoryCustomizationTurnSignal(inboundText);

  if (isAppointmentStatusQuestionText(inboundText) && looksLikeNewSchedulingAvailabilityDraft(draftText)) {
    return {
      allow: false,
      draftText: "",
      reason: "appointment_status_new_schedule_guard"
    };
  }

  if (isPostSalePropertyDropoffLogisticsText(inboundText) && looksLikeScheduleTimeCheckDraft(draftText)) {
    return {
      allow: false,
      draftText: "",
      reason: "post_sale_logistics_schedule_guard"
    };
  }

  if (shortAckSignal && inventoryPrompt) {
    return {
      allow: false,
      draftText: "",
      reason: "short_ack_no_action_guard"
    };
  }

  if (
    followUpMode === "manual_handoff" &&
    isDepartmentHandoff(input) &&
    inventoryPrompt &&
    !availabilitySignal &&
    !looksLikeDepartmentHandoffActionDraft(draftText)
  ) {
    return {
      allow: false,
      draftText: "",
      reason: "manual_handoff_inventory_prompt_guard"
    };
  }

  const pausedHealthRecoveryReengaged =
    dialogState === "followup_paused" &&
    String(input.followUpReason ?? "").toLowerCase() === "health_recovery_delay" &&
    hasFreshInventoryInterestSignal(inboundText);
  if (
    (dialogState === "followup_paused" || dialogState === "call_only") &&
    inventoryPrompt &&
    !pausedHealthRecoveryReengaged
  ) {
    return {
      allow: false,
      draftText: "",
      reason: "paused_state_inventory_prompt_guard"
    };
  }

  if (financePriority && inventoryPrompt) {
    return {
      allow: false,
      draftText: "",
      reason: "finance_priority_inventory_prompt_guard"
    };
  }

  if (financePriority && !schedulingSignal && schedulingPrompt) {
    return {
      allow: false,
      draftText: "",
      reason: "finance_priority_schedule_prompt_guard"
    };
  }

  if (accessoryCustomizationSignal && pricingPrompt) {
    return {
      allow: false,
      draftText: "",
      reason: "customization_priority_pricing_prompt_guard"
    };
  }

  if (availabilitySignal && !financeSignal && pricingPrompt) {
    return {
      allow: false,
      draftText: "",
      reason: "availability_priority_pricing_prompt_guard"
    };
  }

  if (
    availabilitySignal &&
    !financeSignal &&
    inventoryPrompt &&
    !/\b(still available|available right now|in stock right now|not seeing\b[^.]{0,80}\bin stock|checking availability|verify availability|confirm availability)\b/.test(
      draftText.toLowerCase()
    )
  ) {
    return {
      allow: false,
      draftText: "",
      reason: "availability_priority_inventory_prompt_guard"
    };
  }

  return { allow: true, draftText };
}
