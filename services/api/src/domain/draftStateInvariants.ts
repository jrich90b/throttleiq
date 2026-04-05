export type DraftStateInvariantInput = {
  inboundText: string;
  draftText: string;
  followUpMode?: string | null;
  followUpReason?: string | null;
  dialogState?: string | null;
  classificationBucket?: string | null;
  classificationCta?: string | null;
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

function looksLikeInventoryPromptDraft(text: string): boolean {
  const t = String(text ?? "").toLowerCase();
  if (!t.trim()) return false;
  return (
    /\b(which model are you (?:interested|leaning)|exact year\/color\/finish)\b/.test(t) ||
    /\b(keep an eye out|watch for|text you as soon as one comes in|when one comes in)\b/.test(t) ||
    /\b(walkaround video|more photos?|a couple photos?)\b/.test(t) ||
    /\b(stop by to take a look|come check it out)\b/.test(t)
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

function hasFinanceTurnSignal(text: string): boolean {
  const t = String(text ?? "").toLowerCase();
  if (!t.trim()) return false;
  return (
    /\b(apr|rate|monthly|payment|payments|per month|down payment|put down|money down|cash down|term|months?|financing|finance|credit score)\b/.test(
      t
    ) ||
    /\$\s?\d[\d,]*(?:\s*\/\s*(?:mo|month))?/.test(t) ||
    /\b\d{2,3}\s*(?:mo|month|months)\b/.test(t)
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

function isDepartmentHandoff(input: DraftStateInvariantInput): boolean {
  const bucket = String(input.classificationBucket ?? "").toLowerCase();
  const cta = String(input.classificationCta ?? "").toLowerCase();
  const reason = String(input.followUpReason ?? "").toLowerCase();
  return (
    ["service", "parts", "apparel"].includes(bucket) ||
    /(service|parts|apparel)_request/.test(cta) ||
    /(service|parts|apparel|dealer_ride_no_purchase|credit_app|manual_appointment|handoff:)/.test(reason)
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
  const inventoryPrompt = looksLikeInventoryPromptDraft(draftText);
  const schedulingPrompt = looksLikeSchedulingPromptDraft(draftText);

  if (isShortAckText(inboundText) && inventoryPrompt) {
    return {
      allow: false,
      draftText: "",
      reason: "short_ack_no_action_guard"
    };
  }

  if (followUpMode === "manual_handoff" && isDepartmentHandoff(input) && inventoryPrompt) {
    return {
      allow: false,
      draftText: "",
      reason: "manual_handoff_inventory_prompt_guard"
    };
  }

  if ((dialogState === "followup_paused" || dialogState === "call_only") && inventoryPrompt) {
    return {
      allow: false,
      draftText: "",
      reason: "paused_state_inventory_prompt_guard"
    };
  }

  if (hasFinanceTurnSignal(inboundText) && inventoryPrompt) {
    return {
      allow: false,
      draftText: "",
      reason: "finance_priority_inventory_prompt_guard"
    };
  }

  if (hasFinanceTurnSignal(inboundText) && !hasSchedulingTurnSignal(inboundText) && schedulingPrompt) {
    return {
      allow: false,
      draftText: "",
      reason: "finance_priority_schedule_prompt_guard"
    };
  }

  return { allow: true, draftText };
}
