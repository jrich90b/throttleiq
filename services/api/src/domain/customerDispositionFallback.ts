// ---------------------------------------------------------------------------
// The DETERMINISTIC fallback read of a customer disposition — the keyword scan that runs only
// when the typed parser did not answer, plus the three signal helpers it is built from.
//
// Moved out of index.ts verbatim (behaviour-preserving) alongside the lost-sale closeout, for a
// reason worth writing down: `hasBoughtElsewhereDispositionSignalText` is the OTHER way a purchase
// gets read, and it routes to the ambiguous `customer_stepping_back` rather than to the new
// `customer_bought_elsewhere`. Whoever narrows that ambiguity next needs to read this scan and the
// typed parser side by side, so they now live one import apart instead of 4,000 lines apart.
//
// These are KEEPs under the AGENTS.md fail-direction test, not migration candidates: each one only
// ever ENABLES a closeout the parser declined to make, and removing one fails toward NOT closing.
// ---------------------------------------------------------------------------

export type CustomerDispositionDecision = {
  // "customer_deferred" is a genuine "not right now" (the parser's defer_no_window). It is kept
  // SEPARATE from customer_stepping_back because that reason is ambiguous — it also carries "I'll
  // pass", "can't afford it", and hasBoughtElsewhereDispositionSignalText ("I ended up buying a
  // 2016 in Ohio"). Flattening the two threw away the one distinction that decides whether this
  // lead is ever worth re-engaging (Joe ruling 2026-07-29). The dialogState stays
  // customer_stepping_back so every existing disengagement guard keys off it unchanged.
  //
  // "customer_bought_elsewhere" is an EXPLICIT purchase, read by the typed parser on a turn that
  // already reached a closeout (Joe, 2026-08-07). An OUTCOME: never re-pitched a bike.
  reason:
    | "customer_sell_on_own"
    | "customer_keep_current_bike"
    | "customer_stepping_back"
    | "customer_deferred"
    | "customer_bought_elsewhere";
  state: "customer_sell_on_own" | "customer_keep_current_bike" | "customer_stepping_back";
};

export function hasSellOnOwnSignal(text: string): boolean {
  const t = String(text ?? "").toLowerCase();
  return /\b(sell (it|my bike|my motorcycle|my ride) (on my own|myself)|sell (my bike|my motorcycle|my ride) myself)\b/i.test(
    t
  );
}

export function hasKeepCurrentBikeSignal(text: string): boolean {
  const t = String(text ?? "").toLowerCase();
  return /\b(keep (it|my bike|my motorcycle|my ride)|going to keep (it|my bike|my motorcycle|my ride)|gonna keep (it|my bike|my motorcycle|my ride)|just keep (it|my bike|my motorcycle|my ride))\b/i.test(
    t
  );
}

export function hasBoughtElsewhereDispositionSignalText(text: string | null | undefined): boolean {
  const lower = String(text ?? "")
    .toLowerCase()
    .replace(/[’]/g, "'")
    .replace(/\s+/g, " ")
    .trim();
  if (!lower) return false;
  const boughtVehicle =
    /\b(?:i|we|he|she|they)?\s*(?:ended up\s+)?bought\s+(?:a|an|one|the|another)?[\s\S]{0,90}\b(?:\d{4}|bike|motorcycle|harley|street glide|road glide|softail|sportster|low rider|heritage)\b/.test(
      lower
    ) || /\bbought\s+a\s+\d{4}\b/.test(lower);
  if (!boughtVehicle) return false;
  if (/\b(?:from|through)\s+(?:you|u|your|american|american h-?d|american harley|the dealership|your store)\b/.test(lower)) {
    return false;
  }
  return (
    /\b(?:elsewhere|somewhere else|another dealer|different dealer|private seller)\b/.test(lower) ||
    /\b(?:from|through)\s+(?!you\b|u\b|your\b|american\b|american h-?d\b|american harley\b|the dealership\b|your store\b)[a-z0-9][a-z0-9'.& -]{2,40}\b/.test(
      lower
    ) ||
    /\bin\s+(?!north tonawanda\b|buffalo\b|your store\b|the dealership\b)[a-z][a-z'. -]{2,35}\b/.test(lower)
  );
}

export function parseCustomerDispositionFallback(text: string): CustomerDispositionDecision | null {
  const lower = String(text ?? "").toLowerCase();
  if (hasSellOnOwnSignal(lower)) {
    return { reason: "customer_sell_on_own", state: "customer_sell_on_own" };
  }
  if (hasKeepCurrentBikeSignal(lower)) {
    return { reason: "customer_keep_current_bike", state: "customer_keep_current_bike" };
  }
  if (
    /\b(can(?:not|'t)\s+afford|too (expensive|high)|out of (my )?budget|can't do that right now|cannot do that right now|not in the budget|payments? (are|is) too high)\b/i.test(
      lower
    )
  ) {
    return { reason: "customer_stepping_back", state: "customer_stepping_back" };
  }
  if (
    /\b(hold off(?: for now)?|pass(?: for now| man)?|i(?:'|’)?ll pass|i(?:'|’)?ll have to pass|i will pass|i will have to pass|have to pass(?: at this point| for now)?)\b/i.test(
      lower
    )
  ) {
    return { reason: "customer_stepping_back", state: "customer_stepping_back" };
  }
  if (hasBoughtElsewhereDispositionSignalText(lower)) {
    return { reason: "customer_stepping_back", state: "customer_stepping_back" };
  }
  return null;
}
