/**
 * loop_pr_ledger_suppression:eval — pins the batch finding-key ledger suppression wired into
 * anomaly_loop_detect + loop_pr_ledger_filter (2026-07-09, "keys — wire it").
 *
 * Deterministic, no IO / no gh: exercises the PURE core (partitionWorkOrdersByLoopPr +
 * applyLedgerToPayload) with hand-built PR lists. Guards the fail-direction contract: only an
 * EXACT convId::dimension match on an OPEN or in-window MERGED loop PR is dropped; everything
 * else — no match, stale merge, malformed key, empty lists — is KEPT (never hide a live miss).
 */
import assert from "node:assert/strict";
import {
  findingKeyMarker,
  partitionWorkOrdersByLoopPr,
  type OpenPrSummary,
  type MergedPrSummary
} from "../services/api/src/domain/loopPrDedup.ts";
import { applyLedgerToPayload } from "./loop_pr_ledger_filter.ts";

const NOW = Date.parse("2026-07-09T15:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

const openPrs: OpenPrSummary[] = [
  { number: 176, title: "voice steering", body: `fixes it\n${findingKeyMarker("+111::reported_issue")}\n` }
];
const mergedPrs: MergedPrSummary[] = [
  { number: 148, title: "apparel dept", body: `landed\n${findingKeyMarker("+222::human_correction_material")}\n`, mergedAt: new Date(NOW - 2 * DAY).toISOString() },
  { number: 99, title: "old fix", body: `old\n${findingKeyMarker("+333::watch_fire_miss")}\n`, mergedAt: new Date(NOW - 30 * DAY).toISOString() }
];

const workOrders = [
  { convId: "+111", dimension: "reported_issue", tier: 2, action: "escalate", notify: true },        // → suppressed (open PR)
  { convId: "+222", dimension: "human_correction_material", tier: 1, action: "parser_fix_candidate", notify: true }, // → suppressed (merged, in window)
  { convId: "+333", dimension: "watch_fire_miss", tier: 1, action: "add_invariant_or_heal", notify: false },         // → KEPT (merge too old)
  { convId: "+444", dimension: "cadence_quality_suppressed", tier: 1, action: "parser_fix_candidate", notify: false },// → KEPT (no PR)
  { convId: "", dimension: "", tier: 2, action: "escalate", notify: true }                             // → KEPT (malformed key, fail-safe)
];

// --- partition ---
const part = partitionWorkOrdersByLoopPr(workOrders, { openPrs, mergedPrs, nowMs: NOW });
const suppressedKeys = part.suppressed.map(s => s.key).sort();
assert.deepEqual(suppressedKeys, ["+111::reported_issue", "+222::human_correction_material"], "only exact open/in-window-merged matches are suppressed");
assert.equal(part.kept.length, 3, "stale-merge + no-PR + malformed-key findings are all kept");
assert.equal(part.suppressed.find(s => s.key === "+111::reported_issue")?.state, "open", "open PR match reports state=open");
assert.equal(part.suppressed.find(s => s.key === "+222::human_correction_material")?.state, "merged", "in-window merged PR match reports state=merged");
assert.ok(part.kept.some(w => w.convId === "+333"), "a merge older than the window keeps the finding (fail toward surfacing)");
assert.ok(part.kept.some(w => w.convId === "" && w.dimension === ""), "a malformed key is never dedup'd");

// Fail-safe: no PR lists (gh unavailable → []) suppresses nothing.
const none = partitionWorkOrdersByLoopPr(workOrders, { openPrs: [], mergedPrs: [], nowMs: NOW });
assert.equal(none.suppressed.length, 0, "empty PR lists suppress nothing");
assert.equal(none.kept.length, workOrders.length, "empty PR lists keep every finding");

// --- payload recompute ---
const payload = {
  generatedAt: "2026-07-09T14:50:00Z",
  totalAnomalies: 5,
  rawAnomalyCount: 5,
  workOrders,
  workOrderCount: 5,
  byTier: { "0": 0, "1": 3, "2": 2 },
  byAction: { escalate: 2, parser_fix_candidate: 2, add_invariant_or_heal: 1 },
  notifyCount: 3,
  stop: false
};
const { payload: out } = applyLedgerToPayload(payload, { openPrs, mergedPrs, nowMs: NOW });
assert.equal((out as any).workOrderCount, 3, "workOrderCount recomputed over kept");
assert.equal((out as any).suppressedByOpenPrCount, 2, "two findings recorded as suppressed-by-open-pr");
assert.deepEqual((out as any).byTier, { "0": 0, "1": 2, "2": 1 }, "byTier recomputed over kept (dropped one T1 + one T2)");
assert.equal((out as any).notifyCount, 1, "notifyCount recomputed over kept (of +333/+444/malformed, only the malformed row has notify:true)");
assert.equal((out as any).stop, false, "still has work orders → stop:false");
assert.equal((out as any).totalAnomalies, 5, "raw feed totals are preserved (describe the pre-filter feed)");
assert.equal((out as any).suppressedByOpenPr.length, 2, "suppressed list carries both dropped findings");

// stop:true when everything is covered.
const allCovered = applyLedgerToPayload(
  { workOrders: [workOrders[0], workOrders[1]], workOrderCount: 2, byTier: { "0": 0, "1": 1, "2": 1 }, byAction: {}, notifyCount: 2, stop: false },
  { openPrs, mergedPrs, nowMs: NOW }
);
assert.equal((allCovered.payload as any).stop, true, "all work orders covered → stop:true");

console.log("PASS loop_pr_ledger_suppression eval — exact-key open/merged suppression + fail-safe keeps + payload recompute");
