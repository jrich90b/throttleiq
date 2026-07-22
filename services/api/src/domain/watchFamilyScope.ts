/**
 * Watch family-umbrella scope.
 *
 * A "family umbrella" watch is one the customer set on a whole family — "Sportster", "Street Glide",
 * "Trike" — and it is SUPPOSED to collect every variant in that family. A watch on a specific model
 * that happens to live in a family — "Sportster S", "Iron 883", "Street Glide Special" — is not an
 * umbrella, and must only ever fire on that model.
 *
 * The engine's family detector (`detectGenericWatchFamilyLabel`, index.ts) is a CONTAINS matcher for
 * its specific-model branches, so it labels "Sportster S" and "Iron 883" as the `sportster` family.
 * Inside `inventoryItemMatchesWatch` that had two compounding effects: the family match turned true
 * against any Sportster-family unit, AND a truthy family id switched OFF the forward distinct-model
 * guard. Five leads in the 2026-07-22 sweep were texted about a bike they never asked for — a
 * customer who wanted a 2022 Iron 883 got a 2006 Sportster 883 Low (+15164197791, +12399612259,
 * +18728882220, +19897006720, +17705967891).
 *
 * This module holds the gate that decides whether a label really is the umbrella. It lives in
 * `domain/` (rather than inline in index.ts) so the eval can exercise the real predicate instead of
 * regex-matching the source — the exact gap that let the umbrella bypass survive the last round of
 * watch fixtures. Pinned by `watch_model_match:eval`.
 */

/**
 * Split on ANY non-alphanumeric run, not just whitespace: real lead labels arrive as
 * "HARLEY-DAVIDSON Street Glide", and a whitespace-only split leaves "harley-davidson" as one
 * token that the make-token filter below can't see. That single token is enough to make a
 * genuine umbrella look specific, so the split has to happen first.
 */
function modelNameTokens(value: string | null | undefined): string[] {
  return String(value ?? "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map(t => t.trim())
    .filter(Boolean);
}

function stripModelMakeTokens(tokens: string[]): string[] {
  return tokens.filter(token => token !== "harley" && token !== "davidson");
}

/**
 * Does `watchModel` name the family itself, rather than a specific model inside it?
 *
 * `familyId` doubles as the family's own token list — "street_glide" -> ["street", "glide"]. Every
 * meaningful token in the watch label must be one of those; make tokens ("Harley-Davidson") and a
 * model year are ignored, since neither adds model specificity.
 *
 * FAIL DIRECTION: callers use this to NARROW matching, so a false negative here only ever costs a
 * notification (which `watch_fire_miss` re-surfaces, and which the one-time sibling-scope ask and
 * `openToOtherTrims` already cover). A false positive would text a customer about the wrong bike —
 * the failure the dealer actually sees. Written to fail toward "not an umbrella".
 */
export function watchLabelIsBareFamilyUmbrella(
  watchModel: string | null | undefined,
  familyId: string | null | undefined
): boolean {
  if (!familyId) return false;
  const familyTokens = new Set(String(familyId).split("_").filter(Boolean));
  if (!familyTokens.size) return false;
  const tokens = stripModelMakeTokens(modelNameTokens(watchModel)).filter(
    token => !/^(19|20)\d{2}$/.test(token)
  );
  if (!tokens.length) return false;
  return tokens.every(token => familyTokens.has(token));
}
