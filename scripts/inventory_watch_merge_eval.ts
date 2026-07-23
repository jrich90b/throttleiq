/**
 * Inventory-watch record merge eval. Pins `planInventoryWatchMerge`
 * (services/api/src/domain/inventoryWatchMerge.ts) so one customer want stays ONE watch record —
 * and, critically, so collapsing a duplicate can never shrink what we watch for.
 *
 * Production repro (+15857552622, Scott, 2026-07-22): a "used 2014-2016 Tri Glide" watch had already
 * asked the sibling-variant scope question at 13:55 and Scott ANSWERED it (openToOtherTrims=true).
 * At 15:28 a context note created a SECOND Tri Glide 2014-2016 record differing only by a $14-16k
 * band; because the "never re-ask" stamp lives on the record, the fresh one re-armed the ask and we
 * asked him the same question again at 16:20. Two more live pairs are pinned below (+17165011693
 * James, a narrowed budget; +17167992882 Craig, same want twice with/without a color).
 *
 * The safety property is the last section: for every unit in a grid, the merged list matches a
 * SUPERSET of what the pre-merge list matched. A collapse may only ever widen coverage, never
 * narrow it — a watch that fires too often is recoverable, a silent one is a broken promise.
 * Dealer-agnostic: model text, years, and prices only.
 */
import assert from "node:assert/strict";
import {
  planInventoryWatchMerge,
  compareWatchCoverage,
  type WatchMergeRecord,
  type WatchMergeNormalizers
} from "../services/api/src/domain/inventoryWatchMerge.ts";

const NORM: WatchMergeNormalizers = {
  model: v => String(v ?? "").toLowerCase().replace(/\s+/g, " ").trim(),
  condition: v => {
    const t = String(v ?? "").toLowerCase().trim();
    if (!t) return undefined;
    if (/(pre|used|owned)/.test(t)) return "used";
    if (/new/.test(t)) return "new";
    return undefined;
  }
};

const plan = (existing: WatchMergeRecord[], incoming: WatchMergeRecord[] = []) =>
  planInventoryWatchMerge({ existing, incoming, normalizers: NORM });

// ── THE PRODUCTION MISS (+15857552622). The refined record must NOT become a second watch, and the
//    kept record must carry the sibling-scope answer forward so we can never re-ask it.
const scottExisting: WatchMergeRecord = {
  model: "Tri Glide",
  yearMin: 2014,
  yearMax: 2016,
  make: "Harley-Davidson",
  condition: "used",
  status: "active",
  createdAt: "2026-07-05T14:47:42.137Z",
  siblingScopeAskedAt: "2026-07-22T13:55:17.950Z",
  siblingScopeAskModel: "Tri Glide Ultra",
  siblingScopeAskStockId: "U907-20",
  siblingScopeResolvedAt: "2026-07-22T14:59:29.908Z",
  openToOtherTrims: true
};
const scottIncoming: WatchMergeRecord = {
  model: "Tri Glide",
  yearMin: 2014,
  yearMax: 2016,
  make: "Harley-Davidson",
  condition: "used",
  minPrice: 14000,
  maxPrice: 16000,
  status: "active",
  createdAt: "2026-07-22T15:28:26.025Z",
  note: "context_note_watch"
};
const scott = plan([scottExisting], [scottIncoming]);
assert.equal(scott.merged.length, 1, "a narrowed repeat of a live want must not create a second watch");
assert.equal(scott.added.length, 0, "a want we are already watching for is not a new watch");
assert.equal(scott.merged[0].minPrice, undefined, "the BROADER (unbanded) record is the one kept");
assert.equal(
  scott.merged[0].siblingScopeAskedAt,
  "2026-07-22T13:55:17.950Z",
  "the sibling-scope ask stamp must survive the merge — this is what stops the re-ask"
);
assert.equal(scott.merged[0].openToOtherTrims, true, "the customer's answer survives the merge");
assert.equal(scott.merged[0].createdAt, "2026-07-05T14:47:42.137Z", "the watch keeps its true age");

// ── +17165011693 (James): "still a little rich for me, I'm looking 18 to 20" against a live
//    $15-20k trike watch. The narrower band is already covered — one record, coverage unchanged.
const james = plan(
  [{ model: "Tri Glide", condition: "used", minPrice: 15000, maxPrice: 20000, status: "active", createdAt: "2026-07-23T13:29:43.638Z" }],
  [{ model: "Tri Glide", condition: "used", minPrice: 18000, maxPrice: 20000, status: "active", createdAt: "2026-07-23T13:29:43.638Z" }]
);
assert.equal(james.merged.length, 1, "a narrowed budget refines the existing watch, it does not add one");
assert.equal(james.merged[0].minPrice, 15000, "keep the wider band — never stop watching what we already watched");

// ── +17167992882 (Craig): the same walk-in want written twice, once with a color. Colour narrows the
//    match, so the uncolored record is the keeper — and the pair collapses to one.
const craig = plan([
  { model: "Road King Special", condition: "used", status: "active", createdAt: "2026-07-20T18:51:27.843Z", note: "walk_in_explicit_watch" },
  { model: "Road King Special", make: "Harley-Davidson", color: "black", condition: "used", status: "active", createdAt: "2026-07-20T18:51:27.843Z", note: "walk_in_explicit_watch" }
]);
assert.equal(craig.merged.length, 1, "pre-existing duplicates collapse on the next write (self-heal)");
assert.equal(craig.merged[0].color, undefined, "a color pin narrows the watch — the unpinned record wins");
assert.equal(craig.collapsed, 1, "the collapse is reported");

// ── +19897006720 (jaimeet): a model-only USED watch covers the 2022 USED one, but the 2022 NEW watch
//    is a genuinely different want and must survive on its own.
const jaimeet = plan([
  { model: "Iron 883", condition: "used", status: "active", createdAt: "2026-07-17T02:39:32.815Z", lastNotifiedAt: "2026-07-22T16:30:14.879Z", lastNotifiedStockId: "U126-06" },
  { model: "Iron 883", year: 2022, condition: "used", status: "active", createdAt: "2026-07-17T02:56:48.252Z" },
  { model: "Iron 883", year: 2022, condition: "new", status: "active", createdAt: "2026-07-17T02:56:52.345Z" }
]);
assert.equal(jaimeet.merged.length, 2, "new-vs-used are different wants; only the used pair collapses");
assert.equal(jaimeet.merged[0].year, undefined, "the unpinned-year used watch is the keeper");
assert.equal(
  jaimeet.merged[0].lastNotifiedStockId,
  "U126-06",
  "the notification record survives, so we can't re-alert the same unit"
);
assert.equal(jaimeet.merged[1].condition, "new", "the NEW watch stays a separate record");

// ── A genuinely WIDER incoming want replaces the narrow one AND counts as a change worth announcing.
const widened = plan(
  [{ model: "Street Glide", year: 2021, condition: "used", status: "active", createdAt: "2026-06-20T15:04:25.620Z" }],
  [{ model: "Street Glide", condition: "used", status: "active", createdAt: "2026-06-20T21:12:09.638Z" }]
);
assert.equal(widened.merged.length, 1, "widening an existing want does not fork it");
assert.equal(widened.merged[0].year, undefined, "the widened coverage is what we store");
assert.equal(widened.added.length, 1, "a widened watch is a real change — the caller still announces it");
assert.equal(widened.merged[0].createdAt, "2026-06-20T15:04:25.620Z", "age comes from the original want");

// ── THE NON-MERGES. Everything that is not provably redundant stays its own record.
const distinctCases: Array<[string, WatchMergeRecord, WatchMergeRecord]> = [
  ["different models", { model: "Road Glide", status: "active" }, { model: "Street Glide", status: "active" }],
  ["new vs used", { model: "Breakout", condition: "new", status: "active" }, { model: "Breakout", condition: "used", status: "active" }],
  [
    "overlapping but non-nested price bands",
    { model: "Breakout", minPrice: 10000, maxPrice: 16000, status: "active" },
    { model: "Breakout", minPrice: 14000, maxPrice: 20000, status: "active" }
  ],
  [
    "non-nested year ranges",
    { model: "Road King", yearMin: 2012, yearMax: 2015, status: "active" },
    { model: "Road King", yearMin: 2016, yearMax: 2018, status: "active" }
  ],
  ["different colors", { model: "Breakout", color: "black", status: "active" }, { model: "Breakout", color: "red", status: "active" }],
  ["different trims", { model: "Road Glide", trim: "special", status: "active" }, { model: "Road Glide", trim: "limited", status: "active" }],
  [
    "an active and a paused copy — one of them was quieted on purpose",
    { model: "Breakout", condition: "used", status: "active" },
    { model: "Breakout", condition: "used", status: "paused" }
  ]
];
for (const [label, a, b] of distinctCases) {
  assert.equal(compareWatchCoverage(a, b, NORM), "distinct", `must stay separate wants: ${label}`);
  assert.equal(plan([a], [b]).merged.length, 2, `must stay two records: ${label}`);
}

// ── THE SAFETY PROPERTY: a merge may only ever WIDEN coverage.
// Mirrors the live matcher's non-model constraints (index.ts inventoryItemMatchesWatch): year,
// condition, price band (an unpriced unit never satisfies a banded watch), color, trim.
type Unit = { model: string; year: number | null; condition: string | null; price: number | null; color?: string; trim?: string };
function unitMatches(unit: Unit, w: WatchMergeRecord): boolean {
  if (NORM.model(unit.model) !== NORM.model(w.model)) return false;
  if (String(w.status ?? "active") === "paused") return false;
  if (w.year && String(unit.year ?? "") !== String(w.year)) return false;
  if (w.yearMin && w.yearMax) {
    const y = Number(unit.year ?? NaN);
    if (!Number.isFinite(y) || y < w.yearMin || y > w.yearMax) return false;
  }
  const want = NORM.condition(w.condition);
  if (want) {
    const have = NORM.condition(unit.condition);
    if (!have || have !== want) return false;
  }
  const hasMin = typeof w.minPrice === "number" && w.minPrice > 0;
  const hasMax = typeof w.maxPrice === "number" && w.maxPrice > 0;
  if (hasMin || hasMax) {
    if (unit.price == null || !(unit.price > 0)) return false;
    if (hasMin && unit.price < (w.minPrice as number)) return false;
    if (hasMax && unit.price > (w.maxPrice as number)) return false;
  }
  if (w.color && String(unit.color ?? "").toLowerCase() !== String(w.color).toLowerCase()) return false;
  if (w.trim && String(unit.trim ?? "").toLowerCase() !== String(w.trim).toLowerCase()) return false;
  return true;
}

const GRID: Unit[] = [];
for (const year of [2013, 2015, 2021, 2022, 2026]) {
  for (const condition of ["new", "used", null]) {
    for (const price of [12000, 15500, 19000, 28000, null]) {
      for (const color of ["black", "red"]) {
        GRID.push({ model: "Tri Glide", year, condition, price, color });
        GRID.push({ model: "Iron 883", year, condition, price, color });
      }
    }
  }
}

const LISTS: WatchMergeRecord[][] = [
  [scottExisting, scottIncoming],
  craig.merged.length ? [
    { model: "Road King Special", condition: "used", status: "active", createdAt: "a" },
    { model: "Road King Special", color: "black", condition: "used", status: "active", createdAt: "b" }
  ] : [],
  [
    { model: "Tri Glide", condition: "used", minPrice: 15000, maxPrice: 20000, status: "active", createdAt: "a" },
    { model: "Tri Glide", condition: "used", minPrice: 18000, maxPrice: 20000, status: "active", createdAt: "b" }
  ],
  [
    { model: "Iron 883", condition: "used", status: "active", createdAt: "a" },
    { model: "Iron 883", year: 2022, condition: "used", status: "active", createdAt: "b" },
    { model: "Iron 883", year: 2022, condition: "new", status: "active", createdAt: "c" }
  ],
  [
    { model: "Tri Glide", yearMin: 2014, yearMax: 2016, status: "active", createdAt: "a" },
    { model: "Tri Glide", year: 2015, condition: "used", status: "active", createdAt: "b" },
    { model: "Tri Glide", minPrice: 10000, maxPrice: 14000, status: "active", createdAt: "c" }
  ]
];

for (const [i, list] of LISTS.entries()) {
  if (!list.length) continue;
  const merged = planInventoryWatchMerge({ existing: list, incoming: [], normalizers: NORM }).merged;
  for (const unit of GRID) {
    const before = list.some(w => unitMatches(unit, w));
    const after = merged.some(w => unitMatches(unit, w));
    if (before && !after) {
      assert.fail(
        `merge LOST coverage (list ${i}): ${JSON.stringify(unit)} matched before the merge and not after`
      );
    }
  }
}

// Merging is idempotent — running it again changes nothing.
for (const list of LISTS) {
  if (!list.length) continue;
  const once = planInventoryWatchMerge({ existing: list, incoming: [], normalizers: NORM }).merged;
  const twice = planInventoryWatchMerge({ existing: once, incoming: [], normalizers: NORM });
  assert.equal(twice.collapsed, 0, "a merged list has nothing left to collapse");
  assert.deepEqual(twice.merged, once, "merging an already-merged list is a no-op");
}

console.log("inventory_watch_merge:eval OK");
