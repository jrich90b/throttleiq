/**
 * Model-discontinuation heuristic — pure decision. "Does this dealer still sell this model?"
 *
 * Signal (Joe's heuristic, validated against price_list_msrp_2026.json — Fat Bob = 0 entries):
 *   NOT confidently in the current MSRP catalog (family-level match) AND NOT in inventory => discontinued.
 * The inventory check is the carryover guard (a just-dropped model still on the floor stays available).
 *
 * FAIL DIRECTION: the dangerous error is a FALSE "discontinued" on a current model (kills a sale, wrong
 * info). So this is conservative — it only asserts "discontinued" when a model is clearly absent from
 * BOTH the catalog and inventory AND the catalog is fresh enough to trust. Anything borderline resolves
 * to "unknown" (the agent says "let me confirm", never a false claim).
 *
 * ITERATIONS: handled upstream by matching at family/model_name/model_code granularity (findModelInMsrp),
 * so "Fat Bob 114" -> Fat Bob family and "Low Rider" -> the Low Rider S/ST entries. Renames degrade
 * gracefully (offer the current alternative).
 *
 * STALENESS GUARD = the data-source seam: if the MSRP sheet's model year is too far behind the current
 * year, we can't trust "absent" to mean "discontinued" (the sheet just hasn't been updated) -> unknown.
 * This is exactly where a live catalog API would later replace the static sheet.
 */

export type DiscontinuationStatus = "available" | "current" | "discontinued" | "unknown";

/** scoreMatch returns 60+ for a real substring family/name match; below that is no confident match. */
export const MSRP_MATCH_MIN_SCORE = 60;

export type DiscontinuationDecision = { status: DiscontinuationStatus; reason: string };

export function decideModelDiscontinuation(input: {
  inInventory: boolean; // any matching unit currently in inventory
  msrpMatchScore: number; // best match score against the current MSRP catalog (findModelInMsrp)
  sheetModelYear: number; // the model year the MSRP sheet represents (MSRP_SHEET_MODEL_YEAR)
  currentYear: number; // the current calendar/model year
  minScore?: number;
  maxSheetAgeYears?: number; // how stale the sheet may be before we stop trusting "absent" (default 2)
}): DiscontinuationDecision {
  const min = input.minScore ?? MSRP_MATCH_MIN_SCORE;
  const maxAge = input.maxSheetAgeYears ?? 2;

  if (input.inInventory) return { status: "available", reason: "in_inventory" };
  if (input.msrpMatchScore >= min) return { status: "current", reason: "in_current_msrp_catalog" };

  // Not in inventory AND no confident catalog match.
  if (input.currentYear - input.sheetModelYear > maxAge) {
    return { status: "unknown", reason: "msrp_sheet_stale" }; // can't trust "absent" — sheet too old
  }
  if (input.msrpMatchScore > 0) {
    return { status: "unknown", reason: "borderline_msrp_match" }; // some overlap, below the bar — don't assert
  }
  return { status: "discontinued", reason: "absent_from_current_msrp_and_inventory" };
}

/** Convenience: only "discontinued" is safe to state as fact to the customer. */
export const isConfidentlyDiscontinued = (d: DiscontinuationDecision): boolean => d.status === "discontinued";
