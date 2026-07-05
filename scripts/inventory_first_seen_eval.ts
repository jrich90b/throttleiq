/**
 * Inventory first-seen reconcile eval (2026-06-28).
 *
 * Pins the arrival-tracking that lets the watch-fire-miss detector tell a genuine post-watch arrival
 * (a real cron miss) from a unit already in stock at watch-creation (intentionally never fired —
 * Joe's policy). Pure, no IO/LLM.
 *
 *  1) First reconcile => BASELINE: every unit recorded baseline:true @ epoch, nothing reported as an
 *     arrival (existing inventory never reads as a fresh arrival).
 *  2) A later NEW key on a trusted sweep => a genuine arrival (baseline:false @ now); prior entries
 *     untouched and still baseline.
 *  3) An already-seen key is NOT re-reported; firstSeenAt is never moved.
 *  4) A new key on an UNTRUSTED sweep (bulk-resync / feed artifact) => recorded baseline, NOT an arrival.
 *  5) Vanished keys are retained (a flaky feed blip does not re-mint a fresh arrival).
 *  6) Missing stockId/vin => deterministic year|model|color key; a same-key re-listing is not a new arrival.
 *  7) unitArrivedAfter: true only for a non-baseline unit first seen strictly after the watch.
 *
 * Run: npx tsx scripts/inventory_first_seen_eval.ts
 */
import assert from "node:assert/strict";
import {
  reconcileFirstSeen,
  unitArrivedAfter,
  FIRST_SEEN_BASELINE_AT
} from "../services/api/src/domain/inventoryFirstSeen.ts";

const T0 = "2026-06-01T00:00:00.000Z";
const T1 = "2026-06-10T00:00:00.000Z";
const T2 = "2026-06-11T00:00:00.000Z";

const feed0 = [
  { stockId: "STK100", model: "Street Glide", year: "2024", color: "Black" },
  { stockId: "STK200", model: "Road Glide", year: "2024", color: "Red" }
];

// 1) First reconcile => baseline, nothing arrives.
const r0 = reconcileFirstSeen({ prev: null, feedItems: feed0, arrivalsTrusted: true, now: T0 });
assert.equal(r0.isBaselineSweep, true, "first reconcile is a baseline sweep");
assert.deepEqual(r0.arrivedKeys, [], "baseline sweep reports no arrivals");
assert.equal(Object.keys(r0.next.entries).length, 2);
for (const k of Object.keys(r0.next.entries)) {
  assert.equal(r0.next.entries[k].baseline, true, `${k} seeded as baseline`);
  assert.equal(r0.next.entries[k].firstSeenAt, FIRST_SEEN_BASELINE_AT, `${k} baseline uses epoch sentinel`);
}

// 2) Later sweep with a NEW unit on a trusted diff => one genuine arrival.
const feed1 = [...feed0, { stockId: "STK300", model: "Low Rider S", year: "2026", color: "Gray" }];
const r1 = reconcileFirstSeen({ prev: r0.next, feedItems: feed1, arrivalsTrusted: true, now: T1 });
assert.equal(r1.isBaselineSweep, false, "second sweep is not baseline");
assert.deepEqual(r1.arrivedKeys, ["stk300"], "only the new key is a genuine arrival");
assert.equal(r1.next.entries["stk300"].baseline, false, "the arrival is not baseline");
assert.equal(r1.next.entries["stk300"].firstSeenAt, T1, "the arrival's firstSeenAt is the sweep time");
assert.equal(r1.next.entries["stk100"].baseline, true, "prior baseline unit stays baseline");
assert.equal(r1.next.entries["stk100"].firstSeenAt, FIRST_SEEN_BASELINE_AT, "prior firstSeenAt is never moved");

// 3) Identical sweep => nothing new; firstSeenAt unchanged.
const r2 = reconcileFirstSeen({ prev: r1.next, feedItems: feed1, arrivalsTrusted: true, now: T2 });
assert.deepEqual(r2.arrivedKeys, [], "an already-seen unit is not re-detected");
assert.equal(r2.next.entries["stk300"].firstSeenAt, T1, "an already-seen unit keeps its original firstSeenAt");

// 4) New unit on an UNTRUSTED sweep (bulk-resync) => recorded baseline, NOT an arrival.
const feed2 = [...feed1, { stockId: "STK400", model: "Fat Boy", year: "2025", color: "Blue" }];
const rUntrusted = reconcileFirstSeen({ prev: r1.next, feedItems: feed2, arrivalsTrusted: false, now: T2 });
assert.deepEqual(rUntrusted.arrivedKeys, [], "an untrusted sweep reports no arrivals");
assert.equal(rUntrusted.next.entries["stk400"].baseline, true, "untrusted-sweep new key is recorded baseline");

// 5) Vanished key is retained (flaky-feed blip must not re-mint a fresh arrival).
const feedShrunk = [feed0[0]]; // STK200/STK300 momentarily absent
const rShrunk = reconcileFirstSeen({ prev: r1.next, feedItems: feedShrunk, arrivalsTrusted: true, now: T2 });
assert.ok(rShrunk.next.entries["stk300"], "a vanished key is retained, not deleted");
const feedBack = feed1; // STK300 returns
const rBack = reconcileFirstSeen({ prev: rShrunk.next, feedItems: feedBack, arrivalsTrusted: true, now: T2 });
assert.deepEqual(rBack.arrivedKeys, [], "a unit that blipped out and returned is NOT a fresh arrival");
assert.equal(rBack.next.entries["stk300"].firstSeenAt, T1, "the returned unit keeps its original firstSeenAt");

// 6) Missing stockId/vin => deterministic year|model|color key; same-key re-listing is not new.
const noStock = [{ model: "Heritage Classic", year: "2020", color: "Green" }];
const rNoStock0 = reconcileFirstSeen({ prev: null, feedItems: noStock, arrivalsTrusted: true, now: T0 });
const key = Object.keys(rNoStock0.next.entries)[0];
assert.equal(key, "2020|heritage classic|green", "missing stock id falls back to a deterministic year|model|color key");
const rNoStock1 = reconcileFirstSeen({ prev: rNoStock0.next, feedItems: noStock, arrivalsTrusted: true, now: T1 });
assert.deepEqual(rNoStock1.arrivedKeys, [], "a same-key re-listing is not a new arrival");

// 7) unitArrivedAfter.
assert.equal(unitArrivedAfter(r1.next.entries["stk300"], T0), true, "arrived after the watch => true");
assert.equal(unitArrivedAfter(r1.next.entries["stk300"], T2), false, "arrived before the watch => false");
assert.equal(unitArrivedAfter(r0.next.entries["stk100"], T0), false, "baseline unit => false");
assert.equal(unitArrivedAfter(undefined, T0), false, "no entry => false");

console.log("PASS inventory first-seen eval");
