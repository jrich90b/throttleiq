export function extractAdfInquiryCandidates(raw?: string | null): string[] {
  const text = String(raw ?? "").trim();
  if (!text) return [];
  const embedded =
    text.match(/\byour inquiry\s*:\s*([^>]+)/i)?.[1]?.trim() ??
    text.match(/\binquiry\s*:\s*([^>]+)/i)?.[1]?.trim() ??
    "";
  return Array.from(new Set([text, embedded].filter(Boolean)));
}

export function isPriceOnlyInquiryText(text?: string | null): boolean {
  const t = String(text ?? "").trim();
  if (!t) return false;
  return /^(?:price|pricing|price\?|how much\??|(?:what(?:'s| is)?|what is|what's|what)\s+(?:the\s+)?(?:(?:sale|asking|list|listed|current|cash)\s+)?price\??|(?:sale|asking|list|listed|current|cash)\s+price\??)$/i.test(
    t
  );
}

export function shouldRouteRoom58PriceHandoff(args: {
  isInitialAdf: boolean;
  leadSourceLower: string;
  inquiryRaw: string;
  hasInventoryIdentifiers: boolean;
  pricingInquiryIntent: boolean;
}): boolean {
  if (!args.isInitialAdf) return false;
  if (!/room58/i.test(args.leadSourceLower) || !/request details/i.test(args.leadSourceLower)) return false;
  if (!args.hasInventoryIdentifiers) return false;
  if (!args.pricingInquiryIntent) return false;
  const candidates = extractAdfInquiryCandidates(args.inquiryRaw);
  return candidates.some(isPriceOnlyInquiryText);
}

export function shouldForceInitialTestRideSourceScheduleCopy(args: {
  isInitialAdf: boolean;
  inferredBucket?: string | null;
  inferredCta?: string | null;
  leadSourceLower?: string | null;
  draft?: string | null;
}): boolean {
  if (!args.isInitialAdf) return false;
  const source = String(args.leadSourceLower ?? "");
  const sourceIsTestRide = /\b(?:online\s+)?test\s+ride\b|\bdemo\s+ride\b|\bbook\s+test\s+ride\b/i.test(source);
  const classificationIsTestRide =
    args.inferredBucket === "test_ride" || args.inferredCta === "schedule_test_ride";
  if (!sourceIsTestRide && !classificationIsTestRide) return false;
  const draft = String(args.draft ?? "");
  return !/\b(test ride|demo ride|line up|schedule|book|appointment)\b/i.test(draft);
}
