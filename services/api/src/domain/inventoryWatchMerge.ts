/**
 * Inventory-watch record merge — pure.
 *
 * ONE customer want should be ONE watch record. Before this, `mergeInventoryWatches` (index.ts)
 * deduped on an EXACT field signature (model|year|range|condition|trim|color|price), so any
 * REFINEMENT of an existing want landed as a SECOND active record on the same model: the customer
 * narrows a budget ("actually 18-20k"), adds a year, or a second intake path fills in `color`, and
 * the conversation now carries two overlapping active watches.
 *
 * Production miss (+15857552622, Scott, 2026-07-22): a "used 2014-2016 Tri Glide" watch had already
 * asked the sibling-variant scope question at 13:55 ("open to Tri Glide Ultras too?") and the
 * customer ANSWERED (openToOtherTrims=true, resolved 14:59). At 15:28 a context note created a
 * SECOND Tri Glide 2014-2016 record that differed only by a $14-16k band. The sibling-scope ask is
 * stamped PER RECORD (`siblingScopeAskedAt`, "never re-ask"), so the fresh record re-armed it and at
 * 16:20 we asked Scott the exact same question again, 80 minutes after he answered it. Duplicate
 * records also split `lastNotifiedAt` bookkeeping and show the console two conflicting criteria.
 *
 * FAIL DIRECTION (the whole safety argument): a watch that fires too often is recoverable; a watch
 * that goes silent is a broken promise. So this NEVER shrinks coverage. Two records collapse only
 * when one provably matches a SUPERSET of what the other matches — every constraint the live
 * matcher applies (model, trim, make, color, condition, year, price band, monthly budget,
 * openToOtherTrims) must be broader-or-equal — and the BROADER record is the one kept. Anything
 * else (a different model, new-vs-used, non-nested year or price bands, a different color) stays a
 * separate record. Coverage after the merge is always >= coverage before it.
 *
 * Deterministic on purpose: this is how a side effect is WRITTEN to state, over already-extracted
 * structured fields — AGENTS.md allows deterministic here. Comprehension (what the customer wants)
 * stays upstream with the parsers; nothing in this file reads customer text.
 */

export type WatchMergeRecord = {
  model: string;
  year?: number;
  yearMin?: number;
  yearMax?: number;
  make?: string;
  condition?: string;
  color?: string;
  trim?: string;
  minPrice?: number;
  maxPrice?: number;
  monthlyBudget?: number;
  termMonths?: number;
  downPayment?: number;
  note?: string;
  exactness?: string;
  openToOtherTrims?: boolean;
  siblingScopeAskedAt?: string;
  siblingScopeDeclinedAt?: string;
  siblingScopeResolvedAt?: string;
  siblingScopeAskModel?: string;
  siblingScopeAskStockId?: string;
  status?: string;
  createdAt?: string;
  lastNotifiedAt?: string;
  lastNotifiedStockId?: string;
  lastNotifiedModel?: string;
  [key: string]: unknown;
};

export type WatchMergeNormalizers = {
  /** Canonical model text (index.ts passes its own normalizeModelText so aliases collapse the same way). */
  model: (value?: string | null) => string;
  /** "new" | "used" | undefined — undefined means UNCONSTRAINED, exactly as the live matcher reads it. */
  condition: (value?: string | null) => string | undefined;
};

export type WatchCoverage = "same" | "a_covers_b" | "b_covers_a" | "distinct";

const NEG_INF = Number.NEGATIVE_INFINITY;
const POS_INF = Number.POSITIVE_INFINITY;

function text(value: unknown): string {
  return String(value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

function num(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * The year window the LIVE matcher enforces: an exact `year` and a `yearMin`+`yearMax` range are
 * ANDed (index.ts checks both), and a range only applies when BOTH ends are present.
 */
function yearWindow(w: WatchMergeRecord): [number, number] {
  let lo = NEG_INF;
  let hi = POS_INF;
  const exact = num(w.year);
  if (exact != null) {
    lo = Math.max(lo, exact);
    hi = Math.min(hi, exact);
  }
  const min = num(w.yearMin);
  const max = num(w.yearMax);
  if (min != null && max != null) {
    lo = Math.max(lo, min);
    hi = Math.min(hi, max);
  }
  return [lo, hi];
}

/**
 * Price is NOT a plain window: a banded watch rejects a unit with no usable price, an unbanded one
 * does not. So "no band" is strictly broader than any band, and two bands compare by containment.
 */
function priceWindow(w: WatchMergeRecord): { banded: boolean; lo: number; hi: number } {
  const min = num(w.minPrice);
  const max = num(w.maxPrice);
  const banded = min != null || max != null;
  return { banded, lo: min ?? NEG_INF, hi: max ?? POS_INF };
}

/** -1 = a narrower, 0 = equal, 1 = a broader, null = not comparable. */
function compareOptional(a: string, b: string): number | null {
  if (a === b) return 0;
  if (!a) return 1;
  if (!b) return -1;
  return null;
}

function compareWindow(a: [number, number], b: [number, number]): number | null {
  const aCoversB = a[0] <= b[0] && a[1] >= b[1];
  const bCoversA = b[0] <= a[0] && b[1] >= a[1];
  if (aCoversB && bCoversA) return 0;
  if (aCoversB) return 1;
  if (bCoversA) return -1;
  return null;
}

function comparePrice(a: WatchMergeRecord, b: WatchMergeRecord): number | null {
  const pa = priceWindow(a);
  const pb = priceWindow(b);
  if (!pa.banded && !pb.banded) return 0;
  if (!pa.banded) return 1;
  if (!pb.banded) return -1;
  return compareWindow([pa.lo, pa.hi], [pb.lo, pb.hi]);
}

/**
 * Monthly-budget matching runs an estimate that also depends on term/down payment, so two budgets
 * are only comparable when those inputs are identical; otherwise the records stay distinct.
 */
function compareMonthlyBudget(a: WatchMergeRecord, b: WatchMergeRecord): number | null {
  const ba = num(a.monthlyBudget);
  const bb = num(b.monthlyBudget);
  if (ba == null && bb == null) return 0;
  if (ba == null) return 1;
  if (bb == null) return -1;
  if (String(a.termMonths ?? "") !== String(b.termMonths ?? "")) return null;
  if (String(a.downPayment ?? "") !== String(b.downPayment ?? "")) return null;
  if (ba === bb) return 0;
  return ba > bb ? 1 : -1;
}

/**
 * How the two records' MATCH SETS relate. Every constraint the live matcher applies is compared;
 * one record only "covers" the other when it is broader-or-equal on ALL of them.
 */
export function compareWatchCoverage(
  a: WatchMergeRecord,
  b: WatchMergeRecord,
  norm: WatchMergeNormalizers
): WatchCoverage {
  if (!a?.model || !b?.model) return "distinct";
  // Same model text only — no model-hierarchy reasoning here (a "Road Glide" watch and a "Road Glide
  // Limited" watch are separate wants as far as this merge is concerned).
  if (norm.model(a.model) !== norm.model(b.model)) return "distinct";
  // Only ever merge records in the SAME state: an active + paused pair means something deliberately
  // quieted one of them (opt-out, closeout), and collapsing could resurrect or silence a watch.
  if (text(a.status || "active") !== text(b.status || "active")) return "distinct";

  const axes: (number | null)[] = [
    compareOptional(text(norm.condition(a.condition) ?? ""), text(norm.condition(b.condition) ?? "")),
    compareOptional(text(a.trim), text(b.trim)),
    compareOptional(text(a.make), text(b.make)),
    compareOptional(text(a.color), text(b.color)),
    compareWindow(yearWindow(a), yearWindow(b)),
    comparePrice(a, b),
    compareMonthlyBudget(a, b),
    // openToOtherTrims=true matches a SUPERSET (sibling trims fire too).
    compareOptional(a.openToOtherTrims ? "" : "strict", b.openToOtherTrims ? "" : "strict")
  ];

  if (axes.some(axis => axis == null)) return "distinct";
  const values = axes as number[];
  const aBroader = values.some(v => v > 0);
  const bBroader = values.some(v => v < 0);
  if (aBroader && bBroader) return "distinct";
  if (aBroader) return "a_covers_b";
  if (bBroader) return "b_covers_a";
  return "same";
}

function earliest(a?: string, b?: string): string | undefined {
  const av = String(a ?? "").trim();
  const bv = String(b ?? "").trim();
  if (!av) return bv || undefined;
  if (!bv) return av || undefined;
  return av <= bv ? av : bv;
}

function latest(a?: string, b?: string): string | undefined {
  const av = String(a ?? "").trim();
  const bv = String(b ?? "").trim();
  if (!av) return bv || undefined;
  if (!bv) return av || undefined;
  return av >= bv ? av : bv;
}

/**
 * Fold the DROPPED record's history into the record we keep. Constraint fields are never copied
 * (that could narrow the kept watch); only the per-record bookkeeping that must not be lost:
 *  - the sibling-scope ask/answer, so a collapsed duplicate can never re-ask a question the
 *    customer already answered (the +15857552622 miss),
 *  - openToOtherTrims (true wins — it only ever widens),
 *  - the newest notification record, so the "already told them about this unit" dedup still holds,
 *  - the earliest createdAt, so the watch keeps its true age.
 */
export function foldWatchHistory(keep: WatchMergeRecord, drop: WatchMergeRecord): WatchMergeRecord {
  const merged: WatchMergeRecord = { ...keep };
  merged.createdAt = earliest(keep.createdAt, drop.createdAt) ?? keep.createdAt;
  if (drop.openToOtherTrims) merged.openToOtherTrims = true;

  const askedAt = earliest(keep.siblingScopeAskedAt, drop.siblingScopeAskedAt);
  if (askedAt) {
    merged.siblingScopeAskedAt = askedAt;
    const source = keep.siblingScopeAskedAt === askedAt ? keep : drop;
    if (source.siblingScopeAskModel) merged.siblingScopeAskModel = source.siblingScopeAskModel;
    if (source.siblingScopeAskStockId) merged.siblingScopeAskStockId = source.siblingScopeAskStockId;
  }
  const declinedAt = earliest(keep.siblingScopeDeclinedAt, drop.siblingScopeDeclinedAt);
  if (declinedAt) merged.siblingScopeDeclinedAt = declinedAt;
  const resolvedAt = earliest(keep.siblingScopeResolvedAt, drop.siblingScopeResolvedAt);
  if (resolvedAt) merged.siblingScopeResolvedAt = resolvedAt;

  const notifiedAt = latest(keep.lastNotifiedAt, drop.lastNotifiedAt);
  if (notifiedAt) {
    merged.lastNotifiedAt = notifiedAt;
    const source = keep.lastNotifiedAt === notifiedAt ? keep : drop;
    if (source.lastNotifiedStockId) merged.lastNotifiedStockId = source.lastNotifiedStockId;
    if (source.lastNotifiedModel) merged.lastNotifiedModel = source.lastNotifiedModel;
  }
  if (!String(merged.note ?? "").trim() && String(drop.note ?? "").trim()) merged.note = drop.note;
  return merged;
}

export type WatchMergePlan = {
  /** The de-duplicated watch list to store. */
  merged: WatchMergeRecord[];
  /** Incoming wants that genuinely changed what we watch for (new want, or a WIDENED existing one). */
  added: WatchMergeRecord[];
  /** How many redundant records were folded away (pre-existing duplicates included). */
  collapsed: number;
};

function foldInto(list: WatchMergeRecord[], candidate: WatchMergeRecord, norm: WatchMergeNormalizers): {
  list: WatchMergeRecord[];
  record: WatchMergeRecord;
  changed: boolean;
  collapsed: number;
} {
  let working = candidate;
  let collapsed = 0;
  let widened = false;
  let slot = -1; // where the folded record lands — the position of the FIRST record it merged with,
  // so a merge never reshuffles the list (callers read merged[0] as the primary watch).
  const kept: WatchMergeRecord[] = [];
  for (const existing of list) {
    const relation = compareWatchCoverage(existing, working, norm);
    if (relation === "distinct") {
      kept.push(existing);
      continue;
    }
    collapsed++;
    if (slot < 0) slot = kept.length;
    if (relation === "b_covers_a") {
      // The candidate is BROADER: keep its coverage, carry the existing record's history forward.
      working = foldWatchHistory(working, existing);
      widened = true;
    } else {
      // The existing record already covers the candidate (or they are identical): keep the existing
      // coverage and fold anything the candidate carries into it.
      working = foldWatchHistory(existing, working);
    }
  }
  if (slot < 0) kept.push(working);
  else kept.splice(slot, 0, working);
  return { list: kept, record: working, changed: widened, collapsed };
}

/**
 * Merge `incoming` wants into `existing` records without ever losing match coverage.
 *
 * `added` is what the caller should treat as a real change (announce it, set dialog state): a
 * genuinely new want, or one that WIDENED an existing watch. A want already covered by a live watch
 * adds nothing — we are already watching for it — so it is folded in silently.
 */
export function planInventoryWatchMerge(args: {
  existing: WatchMergeRecord[];
  incoming: WatchMergeRecord[];
  normalizers: WatchMergeNormalizers;
}): WatchMergePlan {
  const norm = args.normalizers;
  let list: WatchMergeRecord[] = [];
  let collapsed = 0;

  // Self-heal first: an array that already carries duplicates (created before this merge existed)
  // collapses on the next write instead of accumulating forever.
  for (const watch of args.existing ?? []) {
    if (!watch?.model) continue;
    const folded = foldInto(list, watch, norm);
    list = folded.list;
    collapsed += folded.collapsed;
  }

  const added: WatchMergeRecord[] = [];
  for (const watch of args.incoming ?? []) {
    if (!watch?.model) continue;
    const before = list.length;
    const folded = foldInto(list, watch, norm);
    collapsed += folded.collapsed;
    list = folded.list;
    if (folded.list.length > before || folded.changed) added.push(folded.record);
  }

  return { merged: list, added, collapsed };
}
