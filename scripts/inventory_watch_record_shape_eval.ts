/**
 * inventory_watch_record_shape:eval — two questions about what a watch RECORD looks like.
 *
 * (1) HOW SPECIFIC IS THIS WATCH? `inventoryWatch.exactness`. TEN places in index.ts each carried
 *     their own copy of the same three-rung ladder. They now all call
 *     `applyInventoryWatchExactness`, which asks `resolveInventoryWatchExactness`.
 * (2) THE LEGACY SINGULAR vs THE LIST. Two alert paths hand-wrote the same prefer-list /
 *     wrap-singular / backfill block. They now both call `applyInventoryWatchListNormalization`,
 *     which asks `resolveInventoryWatchListNormalization`.
 *
 * Both un-stackings are BEHAVIOR-PRESERVING and the load-bearing tables below are what prove it:
 * the ORIGINAL inline rules are re-encoded here and the referees must match on every input.
 * `decision_equivalence` cannot carry that proof — a brand-new referee has no baseline.
 *
 * MEASURED BEFORE WRITING THIS, and it is why the two exactness divergences are preserved rather
 * than fixed: **`exactness` has ZERO readers** anywhere in `services/api/src` or `apps/web`
 * (grep-verified). It is descriptive today. That makes the disagreements free to keep — and free
 * to get wrong the day something starts consuming them, which is why they are NAMED.
 *
 * D1 — THE MODEL-RANGE RUNG is present in only 3 of the 10 lanes; on the other 7 a year range
 *      falls through to model_only.
 * D2 — WHAT COUNTS AS DISTINGUISHING: 8 lanes accept a colour OR a trim; 2 accept a colour only,
 *      so the same trim-only watch reads `year_model` there and `exact` everywhere else.
 *
 * NOT a divergence, pinned as such: an explicitly EMPTY `inventoryWatches` array is NOT healed
 * from a stale singular. An empty list is a record that says "this lead has no watches" — it is
 * what `decideInventoryWatchDisarm`'s repair lanes deliberately store — and re-populating it
 * would resurrect a watch a disarm just took off.
 */
import assert from "node:assert/strict";

const { resolveInventoryWatchExactness, resolveInventoryWatchListNormalization } = await import(
  "../services/api/src/domain/routeStateReducer.ts"
);
const { applyInventoryWatchExactness, applyInventoryWatchListNormalization } = await import(
  "../services/api/src/domain/conversationStore.ts"
);
const { rankContention } = await import("../services/api/src/domain/stateWriterContention.ts");

let checks = 0;
const ok = (cond: unknown, msg: string) => {
  assert.ok(cond, msg);
  checks += 1;
};

// ---------------------------------------------------------------------------
// LOAD-BEARING TABLE 1: the four ORIGINAL exactness ladders, re-encoded verbatim.
// Counts read off the pre-un-stacking source (10 sites total):
//   range + (colour||trim)  x2   — the ADF multi-watch build, the context-note build
//   range + colour only     x1   — the manual-outbound seller list
//   (colour||trim), no range x6  — the live/regen watch builders
//   colour only, no range   x1   — the seller-intake list
// Each original ended WITHOUT an else, leaving the caller's `model_only` literal standing.
// ---------------------------------------------------------------------------
type W = { year?: number | null; yearMin?: number | null; yearMax?: number | null; color?: string | null; trim?: string | null };

const originalLadder = (
  w: W,
  recognisesYearRange: boolean,
  trimCountsAsDistinguishing: boolean
): string | null => {
  if (recognisesYearRange && w.yearMin && w.yearMax) return "model_range";
  if (trimCountsAsDistinguishing) {
    if (w.year && (w.color || w.trim)) return "exact";
  } else if (w.year && w.color) return "exact";
  if (w.year) return "year_model";
  return null; // no else in any original
};

const CASES: W[] = [];
for (const year of [null, 2023]) {
  for (const range of [
    { yearMin: null, yearMax: null },
    { yearMin: 2020, yearMax: 2024 },
    { yearMin: 2020, yearMax: null } // half a range — a shape the originals never guard for
  ]) {
    for (const color of [null, "Vivid Black"]) {
      for (const trim of [null, "CVO"]) {
        CASES.push({ year, color, trim, ...range });
      }
    }
  }
}

for (const recognisesYearRange of [true, false]) {
  for (const trimCountsAsDistinguishing of [true, false]) {
    for (const w of CASES) {
      const expected = originalLadder(w, recognisesYearRange, trimCountsAsDistinguishing);
      const got = resolveInventoryWatchExactness({
        ...w,
        recognisesYearRange,
        trimCountsAsDistinguishing
      }).exactness;
      ok(
        got === expected,
        `exactness(range=${recognisesYearRange},trim=${trimCountsAsDistinguishing}) on ` +
          `${JSON.stringify(w)}: expected ${expected}, got ${got}`
      );
    }
  }
}

// The applier must WRITE only when the ladder fires — an unfired ladder must leave the caller's
// `model_only` literal alone. This is the "no else" rule, and it is the one a tidy-up would break.
{
  const watch: any = { model: "Road Glide", exactness: "model_only" };
  applyInventoryWatchExactness(watch, { recognisesYearRange: true, trimCountsAsDistinguishing: true });
  ok(watch.exactness === "model_only", "an unfired ladder must not overwrite the caller's default");
  const pinned: any = { model: "Road Glide", year: 2023, trim: "CVO", exactness: "model_only" };
  applyInventoryWatchExactness(pinned, { recognisesYearRange: false, trimCountsAsDistinguishing: true });
  ok(pinned.exactness === "exact", "a year plus a trim must read exact on the eight trim-aware lanes");
  const colourOnly: any = { model: "Road Glide", year: 2023, trim: "CVO", exactness: "model_only" };
  applyInventoryWatchExactness(colourOnly, { recognisesYearRange: false, trimCountsAsDistinguishing: false });
  ok(
    colourOnly.exactness === "year_model",
    "D2 preserved: the two colour-only lanes must still read a trim-only watch as year_model"
  );
  applyInventoryWatchExactness(null, { recognisesYearRange: true, trimCountsAsDistinguishing: true });
  checks += 1; // a missing watch must be a no-op, not a crash
}

// D1 / D2 must stay NAMED on the decision, or a later reader cannot find them.
ok(
  typeof resolveInventoryWatchExactness({
    year: 2023,
    trim: "CVO",
    recognisesYearRange: false,
    trimCountsAsDistinguishing: false
  }).divergence === "string",
  "D2 must be named on a colour-only lane's exact-eligible decision"
);
ok(
  typeof resolveInventoryWatchExactness({
    yearMin: 2020,
    yearMax: 2024,
    recognisesYearRange: false,
    trimCountsAsDistinguishing: true
  }).divergence === "string",
  "D1 must be named when a lane ignores a year range"
);

// FAIL DIRECTION: the ladder must never read MORE specific than its evidence. An exactness that
// is too narrow would, the day something consumes it, alert a customer about fewer arrivals.
for (const w of CASES) {
  const d = resolveInventoryWatchExactness({ ...w, recognisesYearRange: true, trimCountsAsDistinguishing: true });
  if (d.exactness === "exact") {
    ok(!!w.year && (!!w.color || !!w.trim), `"exact" requires a year AND a distinguishing detail: ${JSON.stringify(w)}`);
  }
  if (d.exactness === "year_model") ok(!!w.year, `"year_model" requires a year: ${JSON.stringify(w)}`);
  if (d.exactness === "model_range") ok(!!w.yearMin && !!w.yearMax, `"model_range" requires both range ends`);
}

// ---------------------------------------------------------------------------
// LOAD-BEARING TABLE 2: the ORIGINAL list-vs-singular block, re-encoded verbatim.
//   const watches = conv.inventoryWatches?.length ? conv.inventoryWatches
//                 : conv.inventoryWatch ? [conv.inventoryWatch] : [];
//   if (!watches.length) continue;
//   if (!conv.inventoryWatches && conv.inventoryWatch) conv.inventoryWatches = [conv.inventoryWatch];
// ---------------------------------------------------------------------------
const A = { model: "Road Glide" } as any;
const B = { model: "Street Glide" } as any;
for (const shape of [
  { name: "populated list + singular", list: [A, B], singular: A, expectRead: 2, expectBackfill: false },
  { name: "populated list only", list: [A], singular: undefined, expectRead: 1, expectBackfill: false },
  { name: "absent list + singular (the heal)", list: undefined, singular: A, expectRead: 1, expectBackfill: true },
  { name: "EMPTY list + singular (deliberate non-heal)", list: [], singular: A, expectRead: 1, expectBackfill: false },
  { name: "empty list, no singular", list: [], singular: undefined, expectRead: 0, expectBackfill: false },
  { name: "nothing at all", list: undefined, singular: undefined, expectRead: 0, expectBackfill: false }
]) {
  const conv: any = { id: "c1" };
  if (shape.list !== undefined) conv.inventoryWatches = shape.list;
  if (shape.singular) conv.inventoryWatch = shape.singular;
  const { watches } = applyInventoryWatchListNormalization(conv);
  ok(
    watches.length === shape.expectRead,
    `${shape.name}: must read ${shape.expectRead} watch(es), read ${watches.length}`
  );
  const backfilled = shape.list === undefined && Array.isArray(conv.inventoryWatches);
  ok(
    backfilled === shape.expectBackfill,
    `${shape.name}: backfill must be ${shape.expectBackfill}, was ${backfilled}`
  );
}
// The one that matters most, stated on its own: an EMPTY list must survive a read untouched.
{
  const conv: any = { id: "c1", inventoryWatches: [], inventoryWatch: A };
  applyInventoryWatchListNormalization(conv);
  ok(
    Array.isArray(conv.inventoryWatches) && conv.inventoryWatches.length === 0,
    "an explicitly EMPTY list is a statement, not a gap — reading must not resurrect the stale singular"
  );
}

// ---------------------------------------------------------------------------
// WIRING: no unrefereed writer of `inventoryWatches` may survive.
// ---------------------------------------------------------------------------
{
  const fs = await import("node:fs");
  const path = await import("node:path");
  const root = path.resolve("services/api/src");
  const files: { path: string; text: string }[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules") walk(full);
      } else if (entry.name.endsWith(".ts")) {
        files.push({ path: path.relative(process.cwd(), full), text: fs.readFileSync(full, "utf8") });
      }
    }
  };
  walk(root);
  const ranked = rankContention(files, { minWrites: 1 });
  const entry = ranked.find(f => f.field === "inventoryWatches");
  ok(
    (entry?.writeSites ?? []).length > 0,
    "the analyzer must still see inventoryWatches writes at all — a zero count would make this vacuous"
  );
  ok(
    (entry?.unrefereedWriterSites ?? []).length === 0,
    "every inventoryWatches writer must ask a referee — unrefereed: " +
      (entry?.unrefereedWriterSites ?? []).map(s => `${s.file}:${s.line}`).join(", ")
  );
}

// ---------------------------------------------------------------------------
// Both referees must be REGISTERED, or the next un-stacking ships with no evidence for it.
// ---------------------------------------------------------------------------
{
  const { buildDecisionRegistry } = await import("../services/api/src/domain/decisionFingerprint.ts");
  const reducer = await import("../services/api/src/domain/routeStateReducer.ts");
  const registry = buildDecisionRegistry(reducer as any);
  for (const name of [
    "resolveInventoryWatchExactness",
    "resolveInventoryWatchListNormalization"
  ]) {
    ok(
      registry.some(e => (e.covers ?? []).includes(name)),
      `${name} must be sampled in buildDecisionRegistry`
    );
  }
  ok(
    registry.filter(e => e.name.startsWith("inventoryWatchExactness:")).length === 4,
    "all four exactness rule pairs must be sampled separately"
  );
  ok(
    registry.filter(e => e.name.startsWith("inventoryWatchListNormalization:")).length === 3,
    "the three list shapes — populated, absent, explicitly empty — must be sampled separately"
  );
}

console.log(`inventory_watch_record_shape:eval OK (${checks} checks)`);
