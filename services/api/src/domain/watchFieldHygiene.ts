/**
 * Inventory-watch field hygiene (Joe ruling, 2026-07-22 #3 — +17167992882).
 *
 * Staff reported a watch that "will never trigger": the word "Special" had landed in the watch's
 * `trim` field and the Traffic-Log-Pro step tag "(Step 2)" had landed in its `color`. Both were
 * right — the matcher tests `trim` against the unit's MODEL string and `color` against the unit's
 * COLOR, so `"road glide".includes("special")` and `"vivid black".includes("step 2")` are both
 * permanently false. The watch is stored, looks active in the console, and can never fire.
 *
 * Two distinct defects, two distinct repairs:
 *
 * 1. A TLP step tag (or any similar operational marker) is junk that the customer never said.
 *    Dropping it costs no specificity — the customer expressed no color — so the watch simply
 *    stops carrying an impossible constraint.
 *
 * 2. "Special" is NOT junk: the customer really did ask for a Road Glide Special. It is in the
 *    wrong FIELD. Deleting it would widen the watch to every base Road Glide and re-create the
 *    wrong-model notification this repo just fixed elsewhere, so the model word is FOLDED INTO
 *    the model label instead of dropped. "Road Glide" + trim "special" becomes model
 *    "Road Glide Special" with no trim; "Road Glide Special" + trim "special" just drops the
 *    now-redundant trim.
 *
 * Deterministic structured-extraction cleanup, which AGENTS.md allows (this reads slot VALUES the
 * parser already produced — it never reads customer language to decide intent).
 *
 * FAIL DIRECTION: folding preserves the customer's specificity, so the watch can only become
 * MATCHABLE, never less accurate. The junk-color drop widens a watch that could not fire at all;
 * the model constraint still bounds it. Pinned by `watch_field_hygiene:eval`.
 */

/** Model words that name a DISTINCT model, not a trim. Mirrors DISTINCT_MODEL_TOKENS (inventoryFeed). */
const MODEL_WORD_TRIMS = new Set(["limited", "special", "st", "cvo", "ultra", "classic"]);

function tokens(value: string | null | undefined): string[] {
  return String(value ?? "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/**
 * Reject a watch color value that is operational junk rather than a color the customer named.
 *
 * Catches the Traffic-Log-Pro step tags that reach the watch through the walk-in / semantic paths
 * ("(Step 2)", "Step 6"), plus the general shape of that class: a color phrase never contains a
 * digit and never carries bracketing punctuation. Returns undefined for junk, the value otherwise.
 */
export function sanitizeWatchColorValue(color: string | null | undefined): string | undefined {
  const raw = String(color ?? "").trim();
  if (!raw) return undefined;
  const lower = raw.toLowerCase();
  // The literal production shape first, so the intent stays readable.
  if (/\bstep\s*\d+\b/.test(lower)) return undefined;
  // A real color/finish phrase carries no digits and no brackets ("vivid black", "dark billiard
  // gray", "black trim"). Anything that does is a lifted form field or step marker, not a color.
  if (/\d/.test(lower)) return undefined;
  if (/[()\[\]{}<>]/.test(raw)) return undefined;
  return raw;
}

/**
 * Move a MODEL-word trim ("special", "limited", "ultra", "cvo", "classic", "st") out of `trim` and
 * into the model label, where the matcher can actually use it. A finish trim ("chrome", "black
 * trim") is left exactly as-is — that is a separate, still-open class.
 */
export function foldModelWordTrimIntoModel(input: {
  model?: string | null;
  trim?: string | null;
}): { model: string | undefined; trim: string | undefined } {
  const model = String(input.model ?? "").trim();
  const trim = String(input.trim ?? "").trim();
  if (!trim) return { model: model || undefined, trim: undefined };

  const trimTokens = tokens(trim);
  // Only fold a trim that is ENTIRELY model words — "chrome trim" and "black" stay put.
  const isModelWordTrim = trimTokens.length > 0 && trimTokens.every(t => MODEL_WORD_TRIMS.has(t));
  if (!isModelWordTrim) return { model: model || undefined, trim: trim || undefined };

  if (!model) {
    // A model word with no model to attach it to is not a watchable target on its own.
    return { model: undefined, trim: undefined };
  }
  const modelTokens = new Set(tokens(model));
  const missing = trimTokens.filter(t => !modelTokens.has(t));
  if (!missing.length) {
    // Already carried by the model label — the trim was pure redundancy blocking every match.
    return { model, trim: undefined };
  }
  const folded = `${model} ${missing.map(t => (t === "st" || t === "cvo" ? t.toUpperCase() : t.charAt(0).toUpperCase() + t.slice(1))).join(" ")}`;
  return { model: folded, trim: undefined };
}

/** Apply both repairs to a watch-shaped record in place-safe fashion. */
export function applyWatchFieldHygiene<T extends { model?: string | null; trim?: string | null; color?: string | null }>(
  watch: T
): T {
  const { model, trim } = foldModelWordTrimIntoModel({ model: watch.model, trim: watch.trim });
  const color = sanitizeWatchColorValue(watch.color);
  return { ...watch, model, trim, color } as T;
}
