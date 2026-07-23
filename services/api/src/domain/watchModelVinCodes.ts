/**
 * Strip leading HD VIN factory-codes off a watch model label (2026-07-11).
 *
 * Some inventory watches were stored with a VIN-decoded model string — the raw HD VIN model code +
 * trim code glued in front of the friendly name:
 *   "Xl1200x 1lc3 Forty-Eight"        -> "Forty-Eight"
 *   "Fxst Bhlf Softail Standard"      -> "Softail Standard"
 *   "Fxsts Bllj Softail Springer"     -> "Softail Springer"
 *   "1hha Vrscdx Night Rod Special"   -> "Night Rod Special"
 * Systemic across ~7 leads (one had ~20). The pure garbage never matched real inventory; a VIN-PREFIXED
 * real model still matched on the friendly part (Naveen got a correct Forty-Eight alert), and the
 * family-ambiguous ones drafted mismatched notifications. This normalizes the string at the source
 * (wired into canonicalizeWatchModelLabel, the shared chokepoint for every watch-creation path).
 *
 * DETERMINISTIC structured-extraction cleanup (AGENTS.md-allowed); reads no customer intent.
 *
 * FAIL-SAFE: strips a LEADING token only when it is a VIN code AND at least one token follows (never
 * reduces a single-token model to empty — protects real code-shaped model NAMES like "XG500"/"XG750"),
 * and stops at the first clean, human-readable token (a real model name never starts with a VIN code).
 */

// A VIN factory-code token: a letter+digit code ("Xl1200x", "1lc3", "Fxstsse2"), a vowelless letter
// cluster ("Fxst", "Bhlf", "Vrscd", "Ggvx", "Fxstc"), an HD model-code prefix that happens to carry a
// vowel ("Flstsci", "Fxstsse"), or a token with an underscore ("Fxds_conv"). Real model-name words
// ("Softail", "Street", "Glide", "Road", "Iron", "Boy") never match.
function isVinCodeToken(tok: string): boolean {
  const t = String(tok ?? "").trim();
  if (!t) return false;
  if (t.includes("_")) return true;
  const hasLetter = /[a-z]/i.test(t);
  const hasDigit = /\d/.test(t);
  if (hasLetter && hasDigit) return true; // Xl1200x, 1lc3, Fxstsse2
  // All-letters from here.
  if (hasLetter && !hasDigit) {
    const vowelless = !/[aeiou]/i.test(t);
    if (vowelless && t.length >= 3) return true; // Fxst, Bhlf, Vrscd, Ggvx, Fxstc, Fxd
    // HD model-code prefix (FX/FL/VR) that carries a vowel, e.g. Flstsci, Fxstsse — a real friendly
    // model name never starts with these designation prefixes.
    if (/^(fx|fl|vr)[a-z]{3,}$/i.test(t)) return true;
  }
  return false;
}

export function stripLeadingVinCodes(model: string | null | undefined): string {
  const raw = String(model ?? "").trim();
  if (!raw) return "";
  const tokens = raw.split(/\s+/);
  let i = 0;
  // Strip leading VIN-code tokens, but always keep at least the final token.
  while (i < tokens.length - 1 && isVinCodeToken(tokens[i])) i++;
  const result = tokens.slice(i).join(" ").trim();
  return result || raw; // never return empty
}

/**
 * Strip a leading MAKE name off a watch model label (2026-07-23). ADF/lead vehicle model fields
 * sometimes arrive with the make glued in front ("HARLEY-DAVIDSON Street Glide", +17165600980's
 * held-guard watch) — the make already lives in the watch's own `make` field, so keeping it in the
 * model both blocks matching (feed unit models never carry the make) and made the outcome audit
 * read the watch as "more specific" than the unit it correctly notified (phantom
 * watch_fired_wrong_model). Deterministic structured-extraction cleanup of our own intake format.
 *
 * FAIL-SAFE: only a LEADING make token is removed, and a label that IS just the make is returned
 * unchanged (never empty). No real H-D model name starts with "Harley"/"H-D", so a genuine model
 * is never touched.
 */
const LEADING_MAKE_NAME_RE = /^(?:harley[\s._-]*davidson|harley|h[\s._-]?d)\b[\s:,._-]*/i;
export function stripLeadingMakeName(model: string | null | undefined): string {
  const raw = String(model ?? "").trim();
  if (!raw) return "";
  const stripped = raw.replace(LEADING_MAKE_NAME_RE, "").trim();
  return stripped || raw; // never return empty
}

/**
 * Drop make + OEM/VIN-code junk tokens ANYWHERE in a watch model label, for SPECIFICITY COMPARISON
 * only (the outcome audit's watch_fired_wrong_model check). Stored watches hold feed lines like
 * "Flhtcutg 1mad Tri Glide Ultra" (OEM model code + paint code + friendly name, +17166021492):
 * against a notified unit "Tri Glide Ultra" the junk made the watch look STRICTLY more specific,
 * firing a phantom wrong-model anomaly for a fire that was exactly right.
 *
 * READ-TIME, detector-only: never used for matching, notifications, or customer-facing text.
 * FAIL-SAFE: over-stripping can only make the audit compare on fewer tokens (fewer phantom flags);
 * a REAL trim regression ("Street Glide Special" fired on a base "Street Glide") is built from
 * plain model words this filter never touches, so it still flags. Never returns empty (falls back
 * to the make-stripped input).
 */
export function stripWatchModelJunkTokens(model: string | null | undefined): string {
  const raw = stripLeadingMakeName(model);
  if (!raw) return "";
  const kept = raw.split(/\s+/).filter(tok => !isVinCodeToken(tok));
  const result = kept.join(" ").trim();
  return result || raw; // never return empty
}

/**
 * Clean existing watches in place: strip VIN codes off each model, then collapse the duplicates the
 * cleaning creates (e.g. six "Fxst Bhl_ Softail Standard" all become "Softail Standard"). Dedup key is
 * model + condition + year-band + price-band; the survivor keeps a lastNotifiedAt if any duplicate had
 * one (never re-notify a unit we already told them about). Pure; the caller persists + never notifies.
 */
export function normalizeWatchModelsVin<T extends { model?: string | null; condition?: string | null; year?: number | null; yearMin?: number | null; yearMax?: number | null; minPrice?: number | null; maxPrice?: number | null; lastNotifiedAt?: string | null }>(
  watches: T[]
): { watches: T[]; changedModels: number; removedDuplicates: number } {
  if (!Array.isArray(watches) || !watches.length) return { watches: watches ?? [], changedModels: 0, removedDuplicates: 0 };
  let changedModels = 0;
  const cleaned = watches.map(w => {
    const next = stripLeadingVinCodes(w?.model);
    if (next && next !== String(w?.model ?? "")) {
      changedModels += 1;
      return { ...w, model: next };
    }
    return w;
  });
  const norm = (v: unknown) => String(v ?? "").trim().toLowerCase();
  const keyOf = (w: T) =>
    [norm(w.model), norm(w.condition), w.year ?? "", w.yearMin ?? "", w.yearMax ?? "", w.minPrice ?? "", w.maxPrice ?? ""].join("|");
  const byKey = new Map<string, T>();
  for (const w of cleaned) {
    const k = keyOf(w);
    const prior = byKey.get(k);
    if (!prior) {
      byKey.set(k, w);
    } else if (!prior.lastNotifiedAt && w.lastNotifiedAt) {
      byKey.set(k, w); // prefer the copy that carries a notify record
    }
  }
  const deduped = [...byKey.values()];
  return { watches: deduped, changedModels, removedDuplicates: cleaned.length - deduped.length };
}
