import { strict as assert } from "node:assert";
import fs from "node:fs";

/**
 * watch_prune:eval — pruneInventoryWatchesByModel removes garbage watches BY EXACT MODEL while keeping
 * the customer's real ones. Motivated by Peter Brand (+18579981156): a 4/17 bulk import created six
 * VIN-trim-code junk watches ("Fxst Bhlf Softail Standard" …) alongside his 3 real ones (Softail Slim,
 * 103 Softail Slim, Softail Standard). The staff DELETE endpoint clears ALL watches; this prunes only
 * the named junk. Matching is exact (case/space-insensitive), not a fragile heuristic — the caller
 * controls precisely what goes.
 */

const { pruneInventoryWatchesByModel } = await import("../services/api/src/domain/conversationStore.ts");

const peter = [
  { model: "103 Softail Slim" },
  { model: "Fxst Bhlf Softail Standard" },
  { model: "Fxst Bhlg Softail Standard" },
  { model: "Fxst Bhlh Softail Standard" },
  { model: "Fxst Bhlj Softail Standard" },
  { model: "Fxst Bhlk Softail Standard" },
  { model: "Fxst Bhll Softail Standard" },
  { model: "Softail Slim" },
  { model: "Softail Standard" }
] as any[];

const junk = [
  "Fxst Bhlf Softail Standard",
  "Fxst Bhlg Softail Standard",
  "Fxst Bhlh Softail Standard",
  "Fxst Bhlj Softail Standard",
  "Fxst Bhlk Softail Standard",
  "Fxst Bhll Softail Standard"
];

// Peter case: prune the 6 junk, keep the 3 real.
{
  const { kept, removed } = pruneInventoryWatchesByModel(peter, junk);
  assert.equal(removed, 6, "removes exactly the 6 junk watches");
  assert.deepEqual(kept.map((w: any) => w.model), ["103 Softail Slim", "Softail Slim", "Softail Standard"], "keeps the 3 real watches, order preserved");
}

// Exact match only — a real model is NEVER removed by a partial/related name.
{
  const { kept, removed } = pruneInventoryWatchesByModel(peter, ["Softail"]);
  assert.equal(removed, 0, "'Softail' does not partial-match 'Softail Slim' — exact only");
  assert.equal(kept.length, peter.length, "nothing removed on a non-exact model");
}

// Case / whitespace insensitive.
assert.equal(
  pruneInventoryWatchesByModel([{ model: "Softail Slim" }] as any, ["  softail slim  "]).removed,
  1,
  "matching is trimmed + case-insensitive"
);

// Fail-safe: empty removeModels is a no-op (never nukes the array).
{
  const { kept, removed } = pruneInventoryWatchesByModel(peter, []);
  assert.equal(removed, 0, "empty removeModels removes nothing");
  assert.equal(kept, peter, "returns the original array unchanged on empty input");
}
// Blank/whitespace-only entries are ignored (never match a blank model into oblivion).
assert.equal(pruneInventoryWatchesByModel(peter, ["", "   "]).removed, 0, "blank removeModels entries are ignored");

// Wiring: the internal endpoint exists, is worker-token gated, and does NOT trigger the watchlist.
const idx = fs.readFileSync("services/api/src/index.ts", "utf8");
const start = idx.indexOf('app.post("/internal/worker/watch-prune/:id"');
assert.ok(start >= 0, "watch-prune internal endpoint exists");
const block = idx.slice(start, start + 1600);
assert.match(block, /canUseWorkerInternal\(req\)/, "endpoint is worker-token gated");
assert.match(block, /pruneInventoryWatchesByModel/, "endpoint uses the pure prune helper");
assert.ok(!/processInventoryWatchlist/.test(block), "endpoint must NOT run the watchlist — pruning never notifies");

console.log("PASS watch_prune eval — surgical model-exact prune keeps real watches, never notifies");
