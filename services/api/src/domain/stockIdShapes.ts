/**
 * Dealer-agnostic stock-number recognition.
 *
 * A dealer stock number has no universal format. American Harley's are letter-led with a dash
 * (T10-26, S9-25, U570-24); another dealer's could be five plain digits, or digits-dash-digits.
 * Hardcoding ANY shape is portability debt — the standing north-star question is "would this work
 * at a dealer we've never met?" (memory `north-star-readiness-bar`), and a shape assumption is
 * invisible to the AH-literal ratchet, so nothing else would catch it.
 *
 * So the shape is LEARNED from the dealer's own inventory feed, and only the genuinely universal
 * exclusions are hardcoded:
 *
 *   1. A phone number is not a stock number. Anywhere. (This is the bug that started this:
 *      "Itz 716-713-8288" yielded "716-713" — +17164233031, msg_30b26a65c146e_1777309569346.)
 *   2. A calendar date is not a stock number ("2026-04").
 *   3. A quantity or price range is not a stock number ("3-4 weeks", "10-15 thousand", "$12-15k").
 *
 * Fail-direction, in both halves:
 *   - No shapes learned yet (cold start, feed down, first boot) => fall back to the permissive
 *     legacy shape, still filtered by the three universal exclusions. So the phone-number defect
 *     stays fixed even with NO feed — the fix never depends on the feed being reachable.
 *   - A learned-shape miss on a real stock number => the turn falls through to the general
 *     composer, which still answers the customer conversationally. Soft.
 *   - The damaging direction is the over-fire (answering a question nobody asked while dropping
 *     what the customer said), and every rule here narrows, never widens.
 */

/** A learned stock-number shape: the run structure plus the observed length band. */
export type StockIdShape = {
  /** Run structure with lengths collapsed: "T10-26" and "U570-24" are both "A9-9". */
  mask: string;
  minLength: number;
  maxLength: number;
};

const CANDIDATE_RE = /[A-Z0-9]+(?:[-/_][A-Z0-9]+)*/gi;

/**
 * Collapse a token to its run structure: letter runs => "A", digit runs => "9", separators kept.
 * Lengths are deliberately dropped so one shape covers T10-26 / T144-26 / AB9-99 rather than
 * over-fitting to the exact ids in today's feed (a new unit must not read as unrecognized).
 */
export function stockIdMask(tokenRaw: string | null | undefined): string | null {
  const token = String(tokenRaw ?? "").trim();
  if (!token || !/[A-Z0-9]/i.test(token)) return null;
  if (!/^[A-Z0-9]+(?:[-/_][A-Z0-9]+)*$/i.test(token)) return null;
  let mask = "";
  let prev = "";
  for (const ch of token) {
    const kind = /[A-Z]/i.test(ch) ? "A" : /[0-9]/.test(ch) ? "9" : ch;
    if (kind === "A" || kind === "9") {
      if (kind !== prev) mask += kind;
    } else {
      mask += kind;
    }
    prev = kind;
  }
  return mask;
}

/** Learn the shapes this dealer actually uses from their own feed's stock ids. */
export function deriveStockIdShapes(stockIds: readonly (string | null | undefined)[]): StockIdShape[] {
  const byMask = new Map<string, { min: number; max: number }>();
  for (const raw of stockIds) {
    const token = String(raw ?? "").trim();
    if (!token) continue;
    const mask = stockIdMask(token);
    if (!mask) continue;
    const seen = byMask.get(mask);
    if (!seen) byMask.set(mask, { min: token.length, max: token.length });
    else {
      seen.min = Math.min(seen.min, token.length);
      seen.max = Math.max(seen.max, token.length);
    }
  }
  return [...byMask.entries()].map(([mask, band]) => ({
    mask,
    // Widen the band by one character each way: a dealer whose ids are all 6 chars today will
    // eventually stock a 7-char one, and an unrecognized real stock number is a miss.
    minLength: Math.max(1, band.min - 1),
    maxLength: band.max + 1
  }));
}

export function matchesKnownStockIdShape(tokenRaw: string, shapes: readonly StockIdShape[]): boolean {
  const token = String(tokenRaw ?? "").trim();
  const mask = stockIdMask(token);
  if (!mask) return false;
  return shapes.some(s => s.mask === mask && token.length >= s.minLength && token.length <= s.maxLength);
}

// --- Universal exclusions (true at every dealer) ---------------------------------------------

/** The run of digits/dashes/dots/spaces/parens surrounding a position, as seen by a human. */
function surroundingNumericRun(text: string, start: number, end: number): string {
  let from = start;
  let to = end;
  while (from > 0 && /[0-9()\-.\s+]/.test(text[from - 1]!)) from -= 1;
  while (to < text.length && /[0-9()\-.\s+]/.test(text[to]!)) to += 1;
  return text.slice(from, to);
}

/**
 * A North-American phone number, however the customer punctuated it: 716-713-8288,
 * (716) 713-8288, 716.713.8288, +1 716 713 8288. Judged on the SURROUNDING run, because the
 * candidate token is only ever a fragment of it.
 */
export function sitsInsidePhoneNumber(text: string, start: number, end: number): boolean {
  const run = surroundingNumericRun(text, start, end);
  const digits = run.replace(/\D/g, "");
  if (digits.length === 10) return true;
  return digits.length === 11 && digits.startsWith("1");
}

/** 2026-04 / 2026-04-27 / 04-27 — a date, not a unit. */
export function looksLikeCalendarDate(token: string): boolean {
  if (/^(?:19|20)\d{2}-\d{1,2}(?:-\d{1,2})?$/.test(token)) return true;
  return /^\d{1,2}-\d{1,2}-(?:19|20)\d{2}$/.test(token);
}

const RANGE_UNIT_RE =
  /^\s*(?:k\b|thousand|grand|dollars?|bucks|%|percent|weeks?|wks?|days?|months?|mos?|years?|yrs?|hours?|hrs?|miles?|mi\b|kms?|minutes?|mins?|pm\b|am\b)/i;

/**
 * "3-4 weeks", "10-15 thousand", "$12-15k", "2-3 months" — a quantity range. Recognised by the
 * unit that follows (or a currency symbol before), never by the number itself, so a dealer whose
 * stock numbers legitimately look like "12-345" keeps working.
 */
export function looksLikeQuantityRange(text: string, start: number, end: number): boolean {
  if (/[$£€]\s*$/.test(text.slice(Math.max(0, start - 2), start))) return true;
  return RANGE_UNIT_RE.test(text.slice(end, end + 12));
}

/** The permissive pre-2026-08 shape, used only until the dealer's feed has taught us theirs. */
function matchesLegacyFallbackShape(token: string): boolean {
  return /^[A-Z0-9]{1,5}-\d{1,4}$/i.test(token);
}

/**
 * Pull the dealer's stock number out of a message, if one is really there.
 *
 * `shapes` comes from the dealer's own feed (see the registry below). Empty => cold start, and the
 * legacy shape is used instead. Either way the universal exclusions apply.
 */
export function extractStockIdFromText(
  textRaw: string | null | undefined,
  shapes: readonly StockIdShape[]
): string | null {
  const text = String(textRaw ?? "");
  if (!text.trim()) return null;
  CANDIDATE_RE.lastIndex = 0;
  for (let m = CANDIDATE_RE.exec(text); m; m = CANDIDATE_RE.exec(text)) {
    const token = m[0];
    const start = m.index;
    const end = start + token.length;
    if (looksLikeCalendarDate(token)) continue;
    if (sitsInsidePhoneNumber(text, start, end)) continue;
    if (looksLikeQuantityRange(text, start, end)) continue;
    const recognized = shapes.length ? matchesKnownStockIdShape(token, shapes) : matchesLegacyFallbackShape(token);
    if (recognized) return token.toUpperCase();
  }
  return null;
}

// --- Registry ---------------------------------------------------------------------------------
// The only stateful part: the shapes last learned from a dealer's feed. Kept deliberately tiny and
// separate from the pure functions above so every rule stays unit-testable without a feed.
//
// KEYED BY DEALER, not global. A module-level singleton would work today (one process per dealer)
// and fail silently the moment two dealers share one — dealer A's feed would decide what counts as
// a stock number for dealer B. That is precisely the bug class this whole module exists to remove,
// so it is not left as a future problem. The dealer resolver is INJECTED rather than imported so
// this module stays dependency-free and testable without a store.

const shapesByDealer = new Map<string, StockIdShape[]>();
const UNSCOPED_DEALER = "__unscoped__";

let resolveDealerId: () => string = () => UNSCOPED_DEALER;

/** Wired once by inventoryFeed (which already resolves the dealer) to avoid an import cycle. */
export function setStockIdShapeDealerResolver(resolver: () => string): void {
  resolveDealerId = resolver;
}

function currentDealerKey(dealerId?: string | null): string {
  const explicit = String(dealerId ?? "").trim();
  if (explicit) return explicit;
  try {
    return String(resolveDealerId() ?? "").trim() || UNSCOPED_DEALER;
  } catch {
    return UNSCOPED_DEALER; // a resolver failure must fall back to cold start, never to another dealer
  }
}

/** Called whenever a dealer's inventory feed is parsed. A feed with no usable ids leaves the last set. */
export function learnStockIdShapesFromFeed(
  stockIds: readonly (string | null | undefined)[],
  dealerId?: string | null
): void {
  const derived = deriveStockIdShapes(stockIds);
  if (derived.length) shapesByDealer.set(currentDealerKey(dealerId), derived);
}

export function getLearnedStockIdShapes(dealerId?: string | null): StockIdShape[] {
  return shapesByDealer.get(currentDealerKey(dealerId)) ?? [];
}

/** Test-only: drop back to the cold-start state. */
export function resetLearnedStockIdShapes(): void {
  shapesByDealer.clear();
}
