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
  return /^(price|pricing|price\?|what(?:'s| is)? the price\??|how much\??)$/i.test(t);
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
