/**
 * Sibling-variant scope for inventory watches (Joe, 2026-07-04).
 *
 * A strict base-model watch ("Road Glide") deliberately does NOT fire on a distinct
 * same-family sibling ("Road Glide Special/ST/Limited" — the PR #129 trim guard). But
 * silence isn't the only option: when a same-family sibling lands during the watch, the
 * agent should ASK ONCE whether the customer is open to variants — the answer (read by
 * parseWatchScopeWithLLM + decideWatchScopeTurn) either broadens the watch
 * (openToOtherTrims) or pins it base-only, and we never re-ask.
 *
 * Cross-FAMILY units are never siblings and never prompt the ask: "Road Glide 3" is a
 * TRIKE, not a "Road Glide" variant (see modelFamily.trikeClassConflict).
 *
 * This is the PURE eligibility decision for the ASK side; the engines compute the
 * signals (matcher outputs + watch state) and apply the side effects. Decision-table
 * pinned by watch_sibling_scope:eval.
 *
 * FAIL DIRECTION: unsure => none. An unwanted proactive text is worse than silence —
 * the fire path is untouched either way, so a skipped ask costs nothing but the
 * opportunity.
 */

export type WatchSiblingScopeAskInput = {
  /** The watch has a usable model label. */
  hasWatchModel: boolean;
  /** watch.status !== "paused". */
  watchActive: boolean;
  /** The unit's model contains/extends the watched model (modelMatches directional). */
  unitMatchesWatchDirectionally: boolean;
  /** The unit is a DISTINCT trim sibling (unitIsDistinctModelFromWatch) — i.e. exactly
   *  the case the strict fire guard blocks. A non-distinct unit fires normally instead. */
  unitIsDistinctTrim: boolean;
  /** modelFamily.trikeClassConflict(unit, watch) — cross form-factor, never a sibling. */
  trikeClassConflict: boolean;
  /** The watch already fires on variants — nothing to ask. */
  openToOtherTrims: boolean;
  /** We already asked (watch.siblingScopeAskedAt) — never re-ask. */
  alreadyAsked: boolean;
  /** The customer already said base-only (watch.siblingScopeDeclinedAt). */
  declined: boolean;
  /** A watch notification went out inside the rate window (24h) — don't pile on. */
  notifiedRecently: boolean;
};

export type WatchSiblingScopeAskDecision =
  | { kind: "ask_scope" }
  | { kind: "none"; reason: string };

export function decideWatchSiblingScopeAsk(
  input: WatchSiblingScopeAskInput
): WatchSiblingScopeAskDecision {
  if (!input.hasWatchModel) return { kind: "none", reason: "no_watch_model" };
  if (!input.watchActive) return { kind: "none", reason: "watch_paused" };
  if (input.trikeClassConflict) return { kind: "none", reason: "cross_family" };
  if (!input.unitMatchesWatchDirectionally) return { kind: "none", reason: "unrelated_model" };
  if (!input.unitIsDistinctTrim) return { kind: "none", reason: "not_a_sibling" };
  if (input.openToOtherTrims) return { kind: "none", reason: "already_open" };
  if (input.declined) return { kind: "none", reason: "declined" };
  if (input.alreadyAsked) return { kind: "none", reason: "already_asked" };
  if (input.notifiedRecently) return { kind: "none", reason: "notified_recently" };
  return { kind: "ask_scope" };
}
