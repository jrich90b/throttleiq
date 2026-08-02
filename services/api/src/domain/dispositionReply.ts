// ---------------------------------------------------------------------------
// Customer-disposition closeout replies: what we say when a lead genuinely steps
// back. Extracted verbatim from index.ts (behavior-preserving move) alongside the
// scheduling-conflict fix — buildFriendlyReachOutClose is the exact line that
// wrongly closed William Indelicato +17163591526 mid-scheduling, and it belongs in
// a domain module where the guard that gates it can be read next to it.
//
// The caller now passes an already-normalized first name (index.ts owns
// normalizeDisplayCase) so this module stays pure and testable.
// ---------------------------------------------------------------------------
export function buildFriendlyReachOutClose(hasAppreciation: boolean): string {
  return hasAppreciation
    ? "I hear you, and I appreciate that. If anything changes down the road, just give me a shout."
    : "I hear you. If anything changes down the road, just give me a shout.";
}

export function buildCustomerDispositionReply(text: string, displayFirstName?: string | null): string {
  const textLower = String(text ?? "").toLowerCase();
  const firstName = displayFirstName || "";
  if (
    /\b(accident|broke|broken|rib|ribs|punctured|lung|hospital|surgery|injur(?:y|ed)|recovery|recovering)\b/i.test(
      textLower
    ) &&
    /\b(pass|hold off|not (?:able|going)|can(?:not|'t))\b/i.test(textLower)
  ) {
    return firstName
      ? `I’m sorry to hear that, ${firstName}. I’ll hold off on follow-up. Wishing you a smooth recovery.`
      : "I’m sorry to hear that. I’ll hold off on follow-up. Wishing you a smooth recovery.";
  }
  if (/\b(can\s+hold\s+off|hold off(?: for now)?)\b/i.test(textLower)) {
    return firstName
      ? `Ok ${firstName}, I’ll hold off. Thanks for the update.`
      : "Ok, I’ll hold off. Thanks for the update.";
  }
  if (/\b(i(?:'|’)?ll pass|i(?:'|’)?ll have to pass|i will pass|i will have to pass|have to pass(?: at this point| for now)?|pass man|pass for now|all set)\b/i.test(textLower)) {
    return firstName
      ? `Alright ${firstName}, thanks for the update. You have my number, just get a hold of me when you’re ready.`
      : "Alright, thanks for the update. You have my number, just get a hold of me when you’re ready.";
  }
  const hasBikeCompliment =
    /\b(beautiful|nice|great|awesome|amazing|love|like|clean|killer|badass|sweet)\b/i.test(textLower) &&
    /\b(bike|street glide|road glide|harley|motorcycle|ride)\b/i.test(textLower);
  return buildFriendlyReachOutClose(hasBikeCompliment);
}

/**
 * Never send the same disposition sign-off twice to the same lead. `normalize` is injected
 * (index.ts owns normalizeOutboundText) so this module stays free of handler imports.
 */
export function ensureUniqueDispositionReply(
  reply: string,
  conv: any,
  normalize: (text: string) => string
): string {
  const used = new Set(
    (conv?.messages ?? [])
      .filter((m: any) => m.direction === "out")
      .map((m: any) => normalize(m.body))
  );
  const base = String(reply ?? "").trim();
  if (base && !used.has(normalize(base))) return base;
  const fallbacks = [
    "I hear you. No worries at all. If things change later, reach out anytime.",
    "Totally get it. Thanks for being straight with me. If timing changes, I’m here.",
    "All good — thanks for the update. If things open up later, just text me."
  ];
  for (const fb of fallbacks) {
    if (!used.has(normalize(fb))) return fb;
  }
  return "No worries at all. If things change later, just text me.";
}
