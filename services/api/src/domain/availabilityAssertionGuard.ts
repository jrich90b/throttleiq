/**
 * Availability-assertion guard — pure. "May we tell this customer that the unit we found is
 * available?" Answer-side sibling of the watch pin guards in `watchYearPin.ts`.
 *
 * An availability answer is a FACTUAL CLAIM about the bike the customer asked about. If the
 * customer asks about a 2027 883 and the only 883 on the lot is a 2006, "Yes — the 2006 Sportster
 * 883 Low is available right now" is technically true about the 2006 and completely wrong as an
 * answer: the customer hears "yes, we have what you asked for."
 *
 * Production miss (+18188420202, George Khoury, 2026-07-21 — the same lead `watchYearPin.ts`
 * documents): the Room58 ADF carried structured `Year: 2022` with the free-text inquiry "2027 883".
 * `resolveInitialAdfInventoryStatus` looks the model up WITH the year first; when that finds
 * nothing it retries with the year dropped, then rebuilds the reply label from the MATCHED unit's
 * year — so a 2027 ask answered "the 2006 ... is available right now", 21 years off. The
 * SMS/regen answer path already keeps its era constraint (`resolveDeterministicAvailabilityReply`,
 * index.ts), so this closes the initial-ADF path to the same invariant.
 *
 * FAIL DIRECTION: purely SUBTRACTIVE — this can only ever downgrade a false "yes" into the honest
 * "I'm not seeing that one; want me to keep an eye out?" that the path already emits. It never goes
 * silent, never closes a lead, never suppresses a side effect (the out-of-stock branch still offers
 * to watch). Retiring it returns to asserting off-year units; it cannot invent a new failure.
 *
 * Deterministic on purpose: this is an invariant guard over a STRUCTURED value (a model year) that
 * the parser already extracted correctly — AGENTS.md allows deterministic for invariant guards.
 * Comprehension (which bike the customer means) stays upstream in the typed parsers; nothing here
 * reads customer language.
 */

/**
 * Model years drift by one against the calendar and against how people talk about a bike (a
 * "2022 Iron 883" and the 2021 sitting next to it are the same motorcycle to a buyer), so a
 * one-year gap still answers the question. Anything wider is a different bike and gets the honest
 * miss instead. Mirrors the lookahead tolerance in `watchYearPin.ts`.
 */
export const AVAILABILITY_YEAR_TOLERANCE = 1;

export type AvailabilityAssertionDecision = {
  assert: boolean;
  reason: string;
};

export function decideAvailabilityAssertion(input: {
  requestedYear?: number | null;
  requestedYearMin?: number | null;
  requestedYearMax?: number | null;
  itemYear?: number | null;
  tolerance?: number;
}): AvailabilityAssertionDecision {
  const usable = (v: number | null | undefined): number | null =>
    typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null;

  const requestedYear = usable(input.requestedYear);
  const yearMin = usable(input.requestedYearMin);
  const yearMax = usable(input.requestedYearMax);
  const itemYear = usable(input.itemYear);
  const tolerance =
    typeof input.tolerance === "number" && Number.isFinite(input.tolerance) && input.tolerance >= 0
      ? input.tolerance
      : AVAILABILITY_YEAR_TOLERANCE;

  const hasConstraint = requestedYear != null || yearMin != null || yearMax != null;

  // No year in the ask — a model-only question ("do you have any Road Glides?") is answered by any
  // year, exactly as before. Behavior preserved.
  if (!hasConstraint) {
    return { assert: true, reason: "no_year_requested" };
  }

  // A constraint we cannot check against is not a constraint we may ignore. Mirrors the era filter
  // in resolveDeterministicAvailabilityReply, which drops unknown-year units when an era was asked
  // for: better an honest "not seeing it" than an unverifiable "yes".
  if (itemYear == null) {
    return { assert: false, reason: "item_year_unknown" };
  }

  // A range ask ("early 2000s", "2015 or newer") is satisfied only from inside the range.
  if (yearMin != null || yearMax != null) {
    if (yearMin != null && itemYear < yearMin) {
      return { assert: false, reason: "item_year_below_requested_range" };
    }
    if (yearMax != null && itemYear > yearMax) {
      return { assert: false, reason: "item_year_above_requested_range" };
    }
    return { assert: true, reason: "item_year_within_requested_range" };
  }

  if (requestedYear != null && Math.abs(itemYear - requestedYear) > tolerance) {
    return { assert: false, reason: "item_year_outside_tolerance" };
  }
  return { assert: true, reason: "item_year_within_tolerance" };
}
