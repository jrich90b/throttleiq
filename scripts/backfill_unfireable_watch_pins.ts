/**
 * Backfill: widen ACTIVE inventory watches that carry a pin they can never match.
 *
 * WHY: a watch pin the catalog rules out makes the watch silently un-fireable — the customer was
 * told "I'll text you when one comes in" and then never hears anything. Two such pins: a model YEAR
 * that cannot exist, and a `new` CONDITION on a model no longer produced. The ADF intake path has
 * guarded both since 2026-07-21; the SMS context-note path (deriveContextNoteWatches, index.ts) did
 * not, and minted `{ Iron 883, 2022, condition: "new" }` on 2026-07-27 (+19518078554) and
 * 2026-07-17 (+19897006720) — the Iron 883 has been out of production since 2020, so no NEW one can
 * ever land. The code fix stops new ones; this repairs the records already on the store.
 *
 * WHAT: per conversation, run the SAME guard (`decideWatchPins`) over every ACTIVE watch and DROP
 * only the pins it proves un-matchable, then re-derive `exactness`. A drop only ever WIDENS a watch,
 * so coverage after the repair is >= coverage before it — no customer stops being watched for.
 * Untouched: paused watches, watches with no year/condition pin, and any model whose catalog status
 * is not a CONFIDENT "discontinued" (a resolve failure reads as "unknown" and changes nothing).
 * Idempotent — a repaired conversation proposes nothing on a second run.
 *
 * SAFETY: dry-run by default; --apply writes. Quiesce the API first (pm2 stop) and back up
 * conversations.json — the running service holds the store in memory and would clobber an in-place
 * edit — then restart so it reloads.
 *
 *   SELF-TEST: npx tsx scripts/backfill_unfireable_watch_pins.ts --self-test
 *   DRY RUN:   CONVERSATIONS_DB_PATH=/path/conversations.json npx tsx scripts/backfill_unfireable_watch_pins.ts
 *   APPLY:     CONVERSATIONS_DB_PATH=/path/conversations.json npx tsx scripts/backfill_unfireable_watch_pins.ts --apply
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { planBackfill, applyBackfill, renderBackfillReport } from "../services/api/src/domain/backfillRunner.ts";
import { decideWatchPins } from "../services/api/src/domain/watchYearPin.ts";
import type { DiscontinuationStatus } from "../services/api/src/domain/modelDiscontinuation.ts";

export type ModelStatusLookup = (model: string) => DiscontinuationStatus;

const activeWatches = (conv: any): any[] => {
  const list = Array.isArray(conv?.inventoryWatches) ? conv.inventoryWatches : [];
  if (list.length) return list;
  return conv?.inventoryWatch ? [conv.inventoryWatch] : [];
};

const describe = (w: any): string =>
  [
    w?.year ? String(w.year) : w?.yearMin && w?.yearMax ? `${w.yearMin}-${w.yearMax}` : "",
    w?.condition ? String(w.condition) : "",
    String(w?.model ?? "")
  ]
    .filter(Boolean)
    .join(" ");

/** Re-derive exactness from whatever pins survive — same ladder the creation sites use. */
function reExactness(w: any): void {
  if (w.yearMin && w.yearMax) w.exactness = "model_range";
  else if (w.year && (w.color || w.trim)) w.exactness = "exact";
  else if (w.year) w.exactness = "year_model";
  else w.exactness = "model_only";
}

/** Pure: the proposed repair for one conversation, or null when every active watch is fireable. */
export function correctUnfireableWatchPins(
  conv: any,
  statusOf: ModelStatusLookup,
  currentYear: number
): { summary: string; mutate: () => void } | null {
  const watches = activeWatches(conv).filter(w => w && w.status === "active");
  if (!watches.length) return null;

  const repairs: Array<{ watch: any; before: string; after: string }> = [];
  for (const watch of watches) {
    const hasYearPin = !!(watch.year || (watch.yearMin && watch.yearMax));
    if (!hasYearPin && !watch.condition) continue;
    const pins = decideWatchPins({
      year: watch.year ?? null,
      yearMin: watch.yearMin ?? null,
      yearMax: watch.yearMax ?? null,
      condition: watch.condition ?? null,
      modelStatus: statusOf(String(watch.model ?? "")),
      currentYear
    });
    if (!pins.droppedYearPin && !pins.droppedConditionPin) continue;
    const before = describe(watch);
    const after = describe({
      ...watch,
      year: pins.droppedYearPin ? undefined : watch.year,
      yearMin: pins.droppedYearPin ? undefined : watch.yearMin,
      yearMax: pins.droppedYearPin ? undefined : watch.yearMax,
      condition: pins.droppedConditionPin ? undefined : watch.condition
    });
    repairs.push({ watch, before, after });
  }
  if (!repairs.length) return null;

  const summary = repairs.map(r => `un-fireable watch widened: "${r.before}" -> "${r.after}"`).join("; ");
  return {
    summary,
    mutate: () => {
      for (const { watch } of repairs) {
        const pins = decideWatchPins({
          year: watch.year ?? null,
          yearMin: watch.yearMin ?? null,
          yearMax: watch.yearMax ?? null,
          condition: watch.condition ?? null,
          modelStatus: statusOf(String(watch.model ?? "")),
          currentYear
        });
        if (pins.droppedYearPin) {
          delete watch.year;
          delete watch.yearMin;
          delete watch.yearMax;
        }
        if (pins.droppedConditionPin) delete watch.condition;
        reExactness(watch);
      }
      // keep the singular mirror pointed at the same (now-repaired) record
      if (conv.inventoryWatch && Array.isArray(conv.inventoryWatches) && conv.inventoryWatches.length) {
        const mirrored = conv.inventoryWatches.find(
          (w: any) => String(w?.createdAt ?? "") === String(conv.inventoryWatch?.createdAt ?? "")
        );
        if (mirrored) conv.inventoryWatch = mirrored;
      }
    }
  };
}

// ── self-test (explicit --self-test only, so a no-flag run is the real dry-run) ──
if (process.argv.includes("--self-test")) {
  const NOW = 2026;
  const status: ModelStatusLookup = model =>
    /iron 883|super glide/i.test(model) ? "discontinued" : "current";

  // THE PRODUCTION RECORD (+19518078554, 2026-07-27; same shape +19897006720, 2026-07-17): the
  // un-fireable `new` pin drops, the perfectly matchable 2022 year pin stays.
  const melanie = {
    id: "+19518078554",
    inventoryWatches: [
      { model: "Iron 883", status: "active", note: "initial_adf_unavailable_inventory", exactness: "model_only", condition: "used" },
      { model: "Iron 883", year: 2022, condition: "new", exactness: "year_model", status: "active", createdAt: "b", note: "context_note_watch" }
    ],
    inventoryWatch: { model: "Iron 883", year: 2022, condition: "new", exactness: "year_model", status: "active", createdAt: "b" }
  };
  const change = correctUnfireableWatchPins(melanie, status, NOW);
  assert.ok(change, "the un-fireable new-on-discontinued watch is proposed for repair");
  change!.mutate();
  assert.equal(melanie.inventoryWatches[1].condition, undefined, "the `new` pin is dropped");
  assert.equal(melanie.inventoryWatches[1].year, 2022, "the matchable 2022 year pin survives");
  assert.equal(melanie.inventoryWatches[1].exactness, "year_model", "exactness still reflects the surviving pin");
  assert.equal(melanie.inventoryWatches[0].condition, "used", "the sibling USED watch is untouched");
  assert.equal(correctUnfireableWatchPins(melanie, status, NOW), null, "idempotent — a repaired conv proposes nothing");

  // An impossible YEAR widens all the way back to model_only.
  const george = {
    id: "+18188420202",
    inventoryWatches: [{ model: "Iron 883", year: 2027, exactness: "year_model", status: "active" }]
  };
  const g = correctUnfireableWatchPins(george, status, NOW);
  assert.ok(g, "a post-discontinuation year pin is proposed for repair");
  g!.mutate();
  assert.equal(george.inventoryWatches[0].year, undefined, "the impossible year pin is dropped");
  assert.equal(george.inventoryWatches[0].exactness, "model_only", "exactness widens with the pin");

  // NOTHING ELSE MOVES. A current model, a used pin on a discontinued model, a paused record, and a
  // model whose status is unknown are all left exactly as they are.
  const untouched = {
    id: "+15550000000",
    inventoryWatches: [
      { model: "Street Glide", year: 2026, condition: "new", exactness: "year_model", status: "active" },
      { model: "Iron 883", year: 2015, condition: "used", exactness: "year_model", status: "active" },
      { model: "Iron 883", year: 2027, condition: "new", status: "paused" }
    ]
  };
  assert.equal(correctUnfireableWatchPins(untouched, status, NOW), null, "fireable + paused watches are never touched");
  assert.equal(
    correctUnfireableWatchPins(
      { id: "x", inventoryWatches: [{ model: "Mystery Model", year: 2027, condition: "new", status: "active" }] },
      () => "unknown",
      NOW
    ),
    null,
    "an unknown catalog status never drops a pin"
  );
  assert.equal(correctUnfireableWatchPins({ id: "x" }, status, NOW), null, "a conv with no watch proposes nothing");

  console.log("PASS backfill un-fireable watch pins (self-test: widen-only, exactness re-derived, idempotent, scoped)");
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

// Resolve each distinct watched model's catalog status ONCE, up front — planBackfill's predicate is
// sync. A resolve failure stays "unknown", which changes nothing.
const { resolveModelDiscontinuation } = await import("../services/api/src/domain/modelDiscontinuation.ts");
const statusByModel = new Map<string, DiscontinuationStatus>();
for (const conv of conversations) {
  for (const w of activeWatches(conv)) {
    if (!w || w.status !== "active") continue;
    if (!w.year && !(w.yearMin && w.yearMax) && !w.condition) continue;
    const key = String(w.model ?? "").trim().toLowerCase();
    if (!key || statusByModel.has(key)) continue;
    try {
      statusByModel.set(key, (await resolveModelDiscontinuation(String(w.model))).status);
    } catch (e) {
      console.warn(`[backfill] model status resolve failed for "${w.model}":`, (e as any)?.message ?? e);
      statusByModel.set(key, "unknown");
    }
  }
}
const statusOf: ModelStatusLookup = model => statusByModel.get(String(model ?? "").trim().toLowerCase()) ?? "unknown";
const currentYear = new Date().getFullYear();

const plan = planBackfill({
  conversations,
  correct: conv => correctUnfireableWatchPins(conv, statusOf, currentYear)
});
console.log(renderBackfillReport(plan, { title: "un-fireable watch pins", applied: apply }));
if (apply && plan.changes.length) {
  const applied = applyBackfill(plan);
  fs.writeFileSync(convPath, JSON.stringify(raw, null, 2));
  console.log(`\nApplied ${applied} conversation(s) and persisted ${convPath}. Restart the API so it reloads the store.`);
} else if (!apply) {
  console.log("\n(dry-run — nothing written. Re-run with --apply after review.)");
}
