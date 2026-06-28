/**
 * Promised-unit-not-in-stock detector (read-only, deterministic).
 *
 * Open-critic class (promised_unit_not_in_stock): an outbound asserts that a SPECIFIC unit is on the
 * lot and ready to show / test-ride ("I still have that Road Glide Limited available for you to take
 * for a test ride", "come in to go over the 2022 Heritage Classic") when the conversation has NO
 * specific pinned unit backing it — the model is only the lead's stated interest or trade target, not
 * a reserved stock unit. That over-promises availability and erodes trust when the customer comes in.
 *
 * This is a DETECTOR (converts the probabilistic open-critic finding into a cheap, repeatable,
 * eval-pinned signal — the loop-contract first step before an enforcement guard). It analyzes OUR OWN
 * outbound text (a deterministic output-safety check, not customer comprehension) and is conservative:
 * it flags only a clear specific-unit availability assertion on a lead with no pinned unit. The reusable
 * primitive `leadHasPinnedSpecificUnit` is what an eventual hold/suppress guard will gate on.
 */

// A SPECIFIC pinned unit = a real stock reference we can stand behind: a stock id / VIN on the lead
// vehicle, an active hold, or a recommended/persisted unit. "new_model_interest" / a trade target /
// a bare model string is NOT a pinned unit.
export function leadHasPinnedSpecificUnit(conv: any): boolean {
  const nonEmpty = (v: unknown) => !!String(v ?? "").trim();
  const v = conv?.lead?.vehicle ?? {};
  if (nonEmpty(v.stockId) || nonEmpty(v.vin)) return true;
  if (nonEmpty(conv?.hold?.stockId) || nonEmpty(conv?.hold?.vin)) return true;
  const recs = Array.isArray(conv?.recommendedUnits) ? conv.recommendedUnits : [];
  if (recs.some((u: any) => nonEmpty(u?.stockId) || nonEmpty(u?.vin))) return true;
  const watches = [
    conv?.inventoryWatch,
    ...(Array.isArray(conv?.inventoryWatches) ? conv.inventoryWatches : [])
  ];
  if (watches.some((w: any) => nonEmpty(w?.lastNotifiedStockId))) return true; // we matched a real unit before
  return false;
}

// High-precision: OUR outbound implies a SPECIFIC reserved/available unit ready to show or test-ride.
// Deliberately narrow — validated against the live store (2026-06-28) to drop the noisy classes:
//  - generic invites ("Happy to line up a test ride whenever works") — no specific claim;
//  - HEDGED general availability ("we still have ONE available for a test ride") — claims the MODEL
//    is generally in stock, not a specific reserved unit (indefinite "one", not "that/the");
//  - "come in to … go over the NUMBERS/paperwork/financing" — an admin/finance invite, not a unit.
// A call-recording / voicemail transcript is skipped entirely (it is not an outbound assertion).
const SPECIFIC_AVAILABILITY_ASSERTION_PATTERNS: RegExp[] = [
  // "I/we (still) have that/the/your/this <unit> available" — a DEFINITE specific unit on hand.
  /\b(?:i|we)\b[^.?!]{0,60}\b(?:still\s+)?have\s+(?:that|the|your|this)\b[^.?!]{0,40}\bavailable\b/i,
  // "come (in/by) … go over / check out / take a look at the/that/your <unit>" — but NOT the
  // numbers/paperwork/financing (a finance/admin invite is fine and common after a credit approval).
  /\bcome\b[^.?!]{0,50}\b(?:go over|check(?:ing)?\s+out|take a look at)\b\s+(?:the|that|your)\s+(?!numbers?\b|number\b|details?\b|paperwork\b|pricing\b|price\b|financ\w*\b|option\w*\b|deal\b|figures?\b)\w/i
];

// Call-recording / voicemail transcripts are logged as outbound but are not agent assertions.
function looksLikeCallTranscript(text: string): boolean {
  return /\bthank you for calling\b|\bpress one\b|\byour call has been forwarded\b|\bat the tone\b|^\s*Customer:/i.test(text);
}

export function assertsSpecificUnitAvailability(text: string | null | undefined): boolean {
  const t = String(text ?? "");
  if (!t.trim() || looksLikeCallTranscript(t)) return false;
  return SPECIFIC_AVAILABILITY_ASSERTION_PATTERNS.some(re => re.test(t));
}

export type PromisedUnitFinding = {
  flagged: true;
  reason: string;
  excerpt: string;
};

/**
 * Flag a single outbound that over-promises a specific unit's availability while the conversation has
 * no pinned unit. Returns null when it's safe (either no specific assertion, or a real pinned unit
 * backs it). Fail-direction = do NOT flag unless BOTH conditions hold (conservative detector).
 */
export function detectPromisedUnitNotInStock(args: {
  conv: any;
  outboundText: string | null | undefined;
}): PromisedUnitFinding | null {
  const text = String(args.outboundText ?? "").trim();
  if (!text) return null;
  if (!assertsSpecificUnitAvailability(text)) return null;
  if (leadHasPinnedSpecificUnit(args.conv)) return null; // a real pinned unit backs the claim
  return {
    flagged: true,
    reason: "asserts a specific unit is available/ready to show, but the lead has no pinned stock unit",
    excerpt: text.slice(0, 180)
  };
}
