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

// A "Request a Quote" lead is a structured pricing ask — signalled by the ADF source label
// ("HD.com Request a Quote") or the mapped `request_a_quote` CTA, NOT by free-text keywords.
// The initial-ADF EMAIL always names pricing (its helpLine); the SMS must not drop the quote
// ask to a bare availability invite (adf_direct_ask_unanswered: pricing — Taliea Lloyd
// 2026-07-13). This is a source/CTA structured signal, so a deterministic check is correct.
export function isQuoteRequestSourceLead(args: {
  inferredCta?: string | null;
  leadSourceLower?: string | null;
}): boolean {
  if (args.inferredCta === "request_a_quote") return true;
  return /request a quote/i.test(String(args.leadSourceLower ?? ""));
}

// A pricing mention must not rewrite the CTA of a bucket that already DECIDED its own CTA.
// The ADF classifier applies its source/department branches first (trade-in, service, test ride,
// walk-in …) and then, as a blanket last step, promotes the CTA to `request_a_quote` whenever a
// pricing intent was detected anywhere in the inquiry text. For a TRAFFIC LOG WALK-IN that text is
// the STAFF's own note, not the customer speaking — same class as #332 (a walk-in note that
// mentions credit is not a credit-app lead) and #368 (a walk-in note judged as customer speech).
//
// Robert Czechowski (+17164808010, operator-reported 2026-08-03, "This shouldn't carry a pricing
// flag"): walk-in note "TRADING IN HIS 2017 STREET GLIDE. WE RAN THE FINANCING AND WE WILL SCHEDULE
// A TIME TO FINALIZE THE DEAL." The walk-in branch correctly routed him `in_store` / `contact_us`
// — a customer already in the store with financing run — and this blanket step then overwrote the
// CTA to `request_a_quote`, which is what `isQuoteRequestSourceLead` reads to force pricing copy.
//
// AGENTS.md bucket: STRUCTURED EXTRACTION / route gate — reads OUR OWN resolved bucket, never
// customer intent, so deterministic is correct. Fail direction is safe: an excluded bucket keeps the
// CTA its own branch chose (`contact_us`), so the reply opens as a general in-store follow-up
// instead of forcing a quote answer — no wrong claim, no lost lead. The failure being fixed (an
// in-store customer mid-deal treated as a fresh quote request) is the costly one.
export function shouldPricingIntentSetQuoteCta(inferredBucket?: string | null): boolean {
  const bucket = String(inferredBucket ?? "");
  if (bucket === "trade_in_sell") return false;
  if (bucket === "service") return false;
  if (bucket === "test_ride") return false;
  // The walk-in bucket: its CTA comes from a staff note about a customer who is already here.
  if (bucket === "in_store") return false;
  return true;
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
