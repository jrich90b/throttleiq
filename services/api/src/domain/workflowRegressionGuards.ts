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
