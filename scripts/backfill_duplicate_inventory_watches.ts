/**
 * Backfill: collapse DUPLICATE inventory-watch records that the old exact-signature merge left behind.
 *
 * WHY: `mergeInventoryWatches` used to dedupe on an exact field signature, so every refinement of a
 * live want ("actually 18-20k", a year pin, a color filled in by a second intake path) became a
 * SECOND active watch on the same model. The code fix (domain/inventoryWatchMerge.ts) stops new ones;
 * this repairs the conversations already carrying them. Until it runs, those records keep splitting
 * per-record bookkeeping — the sibling-scope "never re-ask" stamp most of all (+15857552622 was
 * asked the same variants question twice on 2026-07-22 because the duplicate re-armed it).
 *
 * WHAT: per conversation, re-plan the watch list with the new merge. A record is only ever folded
 * into one that matches a SUPERSET of what it matched, so coverage after the repair is >= coverage
 * before it — no customer stops being watched for. Conversations with no redundant records are
 * untouched, and the repair is idempotent.
 *
 * SAFETY: dry-run by default; --apply writes. Quiesce the API first (pm2 stop) and back up
 * conversations.json — the running service holds the store in memory and would clobber an in-place
 * edit — then restart so it reloads.
 *
 *   SELF-TEST: npx tsx scripts/backfill_duplicate_inventory_watches.ts --self-test
 *   DRY RUN:   CONVERSATIONS_DB_PATH=/path/conversations.json npx tsx scripts/backfill_duplicate_inventory_watches.ts
 *   APPLY:     CONVERSATIONS_DB_PATH=/path/conversations.json npx tsx scripts/backfill_duplicate_inventory_watches.ts --apply
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { planBackfill, applyBackfill, renderBackfillReport } from "../services/api/src/domain/backfillRunner.ts";
import {
  planInventoryWatchMerge,
  type WatchMergeRecord,
  type WatchMergeNormalizers
} from "../services/api/src/domain/inventoryWatchMerge.ts";

const NORMALIZERS: WatchMergeNormalizers = {
  model: v => String(v ?? "").toLowerCase().replace(/\s+/g, " ").trim(),
  condition: v => {
    const t = String(v ?? "").toLowerCase().trim();
    if (!t) return undefined;
    if (/(pre|used|owned)/.test(t)) return "used";
    if (/new/.test(t)) return "new";
    return undefined;
  }
};

function describe(w: WatchMergeRecord): string {
  const bits = [
    w.year ? String(w.year) : w.yearMin && w.yearMax ? `${w.yearMin}-${w.yearMax}` : "",
    w.condition ? String(w.condition) : "",
    String(w.model ?? ""),
    w.color ? String(w.color) : "",
    w.minPrice || w.maxPrice ? `$${w.minPrice ?? 0}-${w.maxPrice ?? "?"}` : ""
  ];
  return bits.filter(Boolean).join(" ");
}

/** Pure: the proposed repair for one conversation, or null when its watch list is already clean. */
export function correctDuplicateWatches(conv: any): { summary: string; mutate: () => void } | null {
  const existing: WatchMergeRecord[] = Array.isArray(conv?.inventoryWatches) ? conv.inventoryWatches : [];
  if (existing.length < 2) return null;
  const plan = planInventoryWatchMerge({ existing, incoming: [], normalizers: NORMALIZERS });
  if (!plan.collapsed) return null;
  const summary =
    `${plan.collapsed} redundant watch record(s) folded: ` +
    `[${existing.map(describe).join(" | ")}] -> [${plan.merged.map(describe).join(" | ")}]`;
  return {
    summary,
    mutate: () => {
      conv.inventoryWatches = plan.merged;
      if (conv.inventoryWatch) conv.inventoryWatch = plan.merged[0];
    }
  };
}

// ── self-test (explicit --self-test only, so a no-flag run is the real dry-run) ──
if (process.argv.includes("--self-test")) {
  // The live +15857552622 pair: the refined record folds into the broader one and the sibling-scope
  // answer survives, so the collapsed watch can never re-ask what the customer already answered.
  const scott = {
    id: "+15857552622",
    inventoryWatch: { model: "Tri Glide", yearMin: 2014, yearMax: 2016, condition: "used", status: "active", createdAt: "2026-07-05T14:47:42.137Z", siblingScopeAskedAt: "2026-07-22T13:55:17.950Z", openToOtherTrims: true },
    inventoryWatches: [
      { model: "Tri Glide", yearMin: 2014, yearMax: 2016, condition: "used", status: "active", createdAt: "2026-07-05T14:47:42.137Z", siblingScopeAskedAt: "2026-07-22T13:55:17.950Z", openToOtherTrims: true },
      { model: "Tri Glide", yearMin: 2014, yearMax: 2016, condition: "used", minPrice: 14000, maxPrice: 16000, status: "active", createdAt: "2026-07-22T15:28:26.025Z" }
    ]
  };
  const change = correctDuplicateWatches(scott);
  assert.ok(change, "the duplicate pair is proposed for repair");
  change!.mutate();
  assert.equal(scott.inventoryWatches.length, 1, "one want, one record");
  assert.equal(scott.inventoryWatches[0].minPrice, undefined, "the broader (unbanded) record is kept");
  assert.equal(scott.inventoryWatches[0].siblingScopeAskedAt, "2026-07-22T13:55:17.950Z", "the ask stamp survives");
  assert.equal(scott.inventoryWatch.model, "Tri Glide", "the singular mirror is re-pointed at the kept record");
  assert.equal(correctDuplicateWatches(scott), null, "idempotent — a repaired conv proposes nothing");

  // Genuinely different wants are never merged away.
  const twoWants = {
    id: "+15550000000",
    inventoryWatches: [
      { model: "Iron 883", condition: "used", status: "active", createdAt: "a" },
      { model: "Iron 883", year: 2022, condition: "new", status: "active", createdAt: "b" }
    ]
  };
  assert.equal(correctDuplicateWatches(twoWants), null, "new-vs-used stay two records — nothing to repair");

  // A single watch, or none, is never touched.
  assert.equal(correctDuplicateWatches({ id: "x", inventoryWatches: [{ model: "Breakout", status: "active" }] }), null);
  assert.equal(correctDuplicateWatches({ id: "x" }), null);

  console.log("PASS backfill duplicate inventory watches (self-test: collapse, history carry, idempotent, scoped)");
  process.exit(0);
}

// ── real run ──
const apply = process.argv.includes("--apply");
const convPath =
  process.env.CONVERSATIONS_DB_PATH ||
  (process.env.DATA_DIR ? path.join(process.env.DATA_DIR, "conversations.json") : "");
if (!convPath || !fs.existsSync(convPath)) {
  console.error("Set CONVERSATIONS_DB_PATH (or DATA_DIR) to the conversations.json to repair.");
  process.exit(2);
}
const raw = JSON.parse(fs.readFileSync(convPath, "utf8"));
const conversations: any[] = Array.isArray(raw) ? raw : Array.isArray(raw?.conversations) ? raw.conversations : [];
const plan = planBackfill({ conversations, correct: correctDuplicateWatches });
console.log(renderBackfillReport(plan, { title: "duplicate inventory watches", applied: apply }));
if (apply && plan.changes.length) {
  const applied = applyBackfill(plan);
  fs.writeFileSync(convPath, JSON.stringify(raw, null, 2));
  console.log(`\nApplied ${applied} conversation(s) and persisted ${convPath}. Restart the API so it reloads the store.`);
} else if (!apply) {
  console.log("\n(dry-run — nothing written. Re-run with --apply after review.)");
}
