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

/**
 * Render a watch's year constraint as customer-facing text.
 *
 * A "range" whose min equals its max is not a range — it is one year that reached the slot twice.
 * `extractYearRangeFromText` returns `{min, max}` whenever a text mentions two or more 20xx years
 * (sendgridInbound.ts), and an ADF routinely repeats the same year ("Year: 2026 … 2026 Sportster S"),
 * so `{min: 2026, max: 2026}` is the ordinary shape. Rendered naively it reaches the customer as
 * "I'm not seeing a 2026-2026 Sportster S in stock right now" — caught in the 2026-07-28 offline
 * replay sweep on two ADF test-ride leads (Sanjeev Goms 08610167776, Justin Holmes +16785960725).
 *
 * Presentation only: the stored watch keeps its yearMin/yearMax, so matching, `exactness`, and
 * every fire path are byte-for-byte unchanged. A degenerate range collapses to the single year it
 * always meant; an inverted one is ordered rather than printed backwards.
 *
 * A year slot can also arrive carrying a NON-year — `year: 0` is the shape the watch-creation paths
 * use for "no year was stated", and `String(0)` is a non-empty string, so the old truthiness test
 * printed it. Joshua Ricksgers (+17162512324, 2026-08-04T17:15:25Z) was drafted *"I'll keep an eye
 * out for 0 Street Glide Special in silver flux/black fuse"* off a watch whose own `exactness` read
 * `model_only` — the record already said there was no year constraint while the label claimed one.
 * So every year the label reads is checked for PLAUSIBILITY, not merely for being non-blank.
 *
 * FAIL DIRECTION: worst case this drops a year word from a label the customer reads, never a
 * constraint the matcher applies — it cannot widen a watch, close a lead, or suppress a send. The
 * stored `year`/`yearMin`/`yearMax` are untouched, so matching, `exactness` and every fire path stay
 * byte-for-byte identical; an implausible year degrades to the model-only sentence the watch always
 * meant. Pinned by `watch_field_hygiene:eval`.
 */
// A watchable model year, not an arbitrary number. Bounds are deliberately loose — this exists to
// reject placeholders and junk (0, NaN, a VIN fragment, a stock number), never to referee whether a
// real year is one we happen to stock.
const PLAUSIBLE_WATCH_YEAR_MIN = 1900;
const PLAUSIBLE_WATCH_YEAR_MAX = 2100;

function plausibleWatchYearText(value: number | string | null | undefined): string {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  const n = Number(raw);
  if (!Number.isInteger(n)) return ""; // NaN, 20.5, "" → not a year
  if (n < PLAUSIBLE_WATCH_YEAR_MIN || n > PLAUSIBLE_WATCH_YEAR_MAX) return "";
  return raw;
}

export function formatWatchYearLabel(watch: {
  year?: number | string | null;
  yearMin?: number | string | null;
  yearMax?: number | string | null;
}): string {
  const single = plausibleWatchYearText(watch.year);
  if (single) return single;
  const min = plausibleWatchYearText(watch.yearMin);
  const max = plausibleWatchYearText(watch.yearMax);
  // A half-open bound ("2019 or newer") is deliberately unlabelled: printing the one end we have
  // reads to the customer as an EXACT year, which is a stronger claim than the watch makes.
  if (!min || !max) return "";
  if (min === max) return min;
  const lo = Number(min);
  const hi = Number(max);
  if (Number.isFinite(lo) && Number.isFinite(hi) && lo > hi) return `${max}-${min}`;
  return `${min}-${max}`;
}

/**
 * Drop a watch colour that NO unit in the matched set actually carries.
 *
 * The mirror of `narrowUnitsByColorFinish` (inventoryFeed.ts, #494 `ec09d078`), which already
 * established the rule on the PRICE reader: *"a stated colour/finish that matches no unit returns
 * the unnarrowed set, so a colour we do not stock degrades to the model's honest range rather than
 * to silence."* The availability/watch lane never got the equivalent, and Rick Williamson Sr.
 * (+17168609581) is the bill: a watch for a *blue* Road Glide 3 against three units in Iron Horse
 * Metallic, Dark Billiard Gray and Vivid Black. The matcher hard-rejects on colour, so the watch
 * was stored, read "active" in the console, and could never fire — the exact failure this module
 * was built for, one field further along than `sanitizeWatchColorValue` can see. That helper
 * catches junk SHAPES ("(Step 2)", digits, brackets); a well-formed colour word that simply is not
 * in the feed passes it untouched.
 *
 * Deterministic is correct here and AGENTS.md allows it: this reads OUR OWN inventory records, and
 * never customer language to decide intent. It is an invariant guard, not comprehension.
 *
 * FAIL DIRECTION — load-bearing, and subtractive only:
 *  - It may only DROP a colour nothing carries. It never widens a colour we do stock (that would
 *    hand the customer a bike in the wrong paint) and never touches model, year, or price.
 *  - An empty or failed feed read PRESERVES the colour. "I could not see the inventory" must never
 *    be read as "we have none in that colour" — that would silently strip a real constraint.
 *  - Removing the guard fails toward telling a customer we have nothing when we have three, and
 *    arming a promise we can never keep. Fail-unsafe ⇒ it stays.
 *
 * Colour equality routes through the caller-supplied `unitCarriesColor` so this keeps ONE
 * definition of "does this unit match that colour" — the same discipline #494 used for models,
 * rather than minting a second notion here. Pinned by `watch_field_hygiene:eval`.
 */
export function dropUnstockedWatchColor<T extends { color?: string | null }>(
  watch: T,
  units: ReadonlyArray<{ color?: string | null }>,
  unitCarriesColor: (unitColor: string, wantedColor: string) => boolean
): T {
  const wanted = String(watch.color ?? "").trim();
  if (!wanted) return watch;
  // No units to compare against — an unread feed is not evidence of absence.
  if (!units.length) return watch;
  const stocked = units.some(u => {
    const unitColor = String(u.color ?? "").trim();
    return unitColor ? unitCarriesColor(unitColor, wanted) : false;
  });
  return stocked ? watch : ({ ...watch, color: undefined } as T);
}

/** Apply both repairs to a watch-shaped record in place-safe fashion. */
export function applyWatchFieldHygiene<T extends { model?: string | null; trim?: string | null; color?: string | null }>(
  watch: T
): T {
  const { model, trim } = foldModelWordTrimIntoModel({ model: watch.model, trim: watch.trim });
  const color = sanitizeWatchColorValue(watch.color);
  return { ...watch, model, trim, color } as T;
}
