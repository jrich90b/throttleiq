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
  findingKeyOf,
  findMergedPrsForFindingKey,
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

// --- COVERAGE CAP: a key shared by MORE findings than PRs cover suppresses NOTHING (2026-08-04) ---
// Production signal: Tony Mooradian +17165236994 filed two DISTINCT operator reports, both
// `reported_issue` — "Pricing was answered but the pricing flag still shows in the inbox" and
// "I don't think this one should have been closed". PR #507 fixed the first. The old exact-key
// match then dropped BOTH rows, so the wrongful-close report vanished from the work order.
{
  const TONY = "+17165236994";
  const tonyPrs: MergedPrSummary[] = [
    {
      number: 507,
      title: "the task-inbox Pricing badge expires when the price is actually answered",
      body: `landed\n${findingKeyMarker(`${TONY}::reported_issue`)}\n`,
      mergedAt: new Date(NOW - DAY).toISOString()
    }
  ];
  const tonyRows = [
    { convId: TONY, dimension: "reported_issue", tier: 2, action: "escalate", notify: true, detail: "operator-reported (task_inbox): Pricing was answered but the pricing flag still shows in the inbox" },
    { convId: TONY, dimension: "reported_issue", tier: 2, action: "escalate", notify: true, detail: "operator-reported (routing): I don’t think this one should have been closed" }
  ];
  const part2 = partitionWorkOrdersByLoopPr(tonyRows, { openPrs: [], mergedPrs: tonyPrs, nowMs: NOW });
  assert.equal(part2.suppressed.length, 0, "2 findings share the key but only 1 PR covers it → suppress NOTHING");
  assert.equal(part2.kept.length, 2, "both operator reports stay in the work order");
  assert.equal(part2.ambiguous.length, 2, "both are flagged as ambiguous coverage for manual triage");
  assert.deepEqual(part2.ambiguous[0].prNumbers, [507], "the covering PR is named so the digest can show it");
  assert.equal(part2.ambiguous[0].findingCount, 2, "ambiguity reports how many findings share the key");
  assert.equal(part2.ambiguous[0].prCount, 1, "…and how many PRs cover it");

  // A SECOND PR covering the same key restores suppression: coverage now accounts for both findings.
  const bothCovered = partitionWorkOrdersByLoopPr(tonyRows, {
    openPrs: [{ number: 611, title: "wrongful close", body: `fixes\n${findingKeyMarker(`${TONY}::reported_issue`)}\n` }],
    mergedPrs: tonyPrs,
    nowMs: NOW
  });
  assert.equal(bothCovered.suppressed.length, 2, "2 PRs for 2 same-key findings → both suppressed");
  assert.equal(bothCovered.ambiguous.length, 0, "no ambiguity once coverage matches the finding count");

  // Unchanged for the ordinary singleton case — one finding, one PR still dedups.
  const singleton = partitionWorkOrdersByLoopPr([tonyRows[0]], { openPrs: [], mergedPrs: tonyPrs, nowMs: NOW });
  assert.equal(singleton.suppressed.length, 1, "a lone finding with a covering PR is still suppressed");
  assert.equal(singleton.ambiguous.length, 0, "…and is not flagged ambiguous");

  // The payload surfaces the ambiguity so the digest can never silently swallow it.
  const amb = applyLedgerToPayload(
    { workOrders: tonyRows, workOrderCount: 2, byTier: { "0": 0, "1": 0, "2": 2 }, byAction: {}, notifyCount: 2, stop: false },
    { openPrs: [], mergedPrs: tonyPrs, nowMs: NOW }
  );
  assert.equal((amb.payload as any).workOrderCount, 2, "no work order is dropped on ambiguous coverage");
  assert.equal((amb.payload as any).ambiguousPrCoverageCount, 2, "payload carries the ambiguous-coverage count");
  assert.equal((amb.payload as any).ambiguousPrCoverage[1].dimension, "reported_issue", "…with the dimension for the digest line");
  assert.equal((amb.payload as any).stop, false, "work remains → stop:false");
}

// --- regression-of-disposed is NEVER suppressed (2026-08-21, Paul Harrigan +17169467451) ---
{
  // The real row, from next.json generated 2026-08-20T08:55Z: the box RESTORED it because the key had
  // been disposed with a --deploy-ts boundary and the defect recurred after it. The local filter then
  // dropped it as "covered by PR #681 (merged)" — eating the one signal that says a fix did not hold.
  const KEY_CONV = "+17169467451";
  const regressionRow = {
    convId: KEY_CONV,
    dimension: "corpus_replay_judge_fail",
    tier: 1,
    regressionOfDisposed: true
  };
  const coveringPrs = [
    { number: 681, body: `finding-key: ${findingKeyMarker(findingKeyOf(KEY_CONV, "corpus_replay_judge_fail"))}`, mergedAt: new Date(NOW - DAY).toISOString() }
  ];
  // Sanity: the marker really does match, so the row WOULD have been dropped without the carve-out.
  assert.equal(
    findMergedPrsForFindingKey(coveringPrs, findingKeyOf(KEY_CONV, "corpus_replay_judge_fail"), { nowMs: NOW }).length,
    1,
    "the covering PR must match the key, or this eval proves nothing"
  );

  const part = partitionWorkOrdersByLoopPr([regressionRow], { openPrs: [], mergedPrs: coveringPrs, nowMs: NOW });
  assert.equal(part.kept.length, 1, "a regression-of-disposed row survives merged-PR coverage");
  assert.equal(part.suppressed.length, 0, "…and is not suppressed");
  assert.equal(part.regressionKept.length, 1, "…and is reported so the drop is visible, not silent");
  assert.equal(part.regressionKept[0].prNumbers[0], 681, "…naming the PR that claimed the key");

  // An OPEN PR is no different: the recurrence postdates whatever that PR claims.
  const openCover = partitionWorkOrdersByLoopPr([regressionRow], {
    openPrs: [{ number: 999, body: `finding-key: ${findingKeyMarker(findingKeyOf(KEY_CONV, "corpus_replay_judge_fail"))}` }],
    mergedPrs: [],
    nowMs: NOW
  });
  assert.equal(openCover.kept.length, 1, "an OPEN PR does not suppress a regression either");
  assert.equal(openCover.regressionKept.length, 1, "…and it is reported");

  // The flag is opt-in and strict: an ordinary row with the same key still suppresses normally, so
  // this carve-out cannot become a blanket "never dedup anything".
  const ordinary = partitionWorkOrdersByLoopPr(
    [{ convId: KEY_CONV, dimension: "corpus_replay_judge_fail", tier: 1 }],
    { openPrs: [], mergedPrs: coveringPrs, nowMs: NOW }
  );
  assert.equal(ordinary.kept.length, 0, "the same key WITHOUT the regression tag still suppresses");
  assert.equal(ordinary.regressionKept.length, 0, "…and reports no regression");

  const falsey = partitionWorkOrdersByLoopPr(
    [{ convId: KEY_CONV, dimension: "corpus_replay_judge_fail", regressionOfDisposed: false }],
    { openPrs: [], mergedPrs: coveringPrs, nowMs: NOW }
  );
  assert.equal(falsey.kept.length, 0, "regressionOfDisposed:false is not a carve-out");

  // And the payload the digest reads carries it.
  const out = applyLedgerToPayload(
    { workOrders: [regressionRow], workOrderCount: 1, byTier: { "0": 0, "1": 1, "2": 0 }, byAction: {}, notifyCount: 0, stop: false },
    { openPrs: [], mergedPrs: coveringPrs, nowMs: NOW }
  );
  assert.equal((out.payload as any).workOrderCount, 1, "the regression row stays in the filtered payload");
  assert.equal((out.payload as any).regressionKeptCount, 1, "payload carries the regression-kept count");
  assert.equal((out.payload as any).regressionKept[0].dimension, "corpus_replay_judge_fail", "…with the dimension for the digest line");
  assert.equal((out.payload as any).suppressedByOpenPrCount, 0, "…and nothing was recorded as suppressed");
}

// --- ledger FILE payload (the gh-less box's substitute for live gh) ---
{
  const { parseLoopPrLedgerPayload } = await import("../services/api/src/domain/loopPrDedup.ts");
  const fresh = parseLoopPrLedgerPayload(
    { generatedAt: new Date(NOW - DAY).toISOString(), openPrs: [{ number: 1, body: "x" }], mergedPrs: [{ number: 2, body: "y", mergedAt: new Date(NOW - DAY).toISOString() }] },
    { nowMs: NOW }
  );
  assert.ok(fresh && fresh.openPrs.length === 1 && fresh.mergedPrs.length === 1, "a fresh well-formed ledger file parses");
  assert.equal(
    parseLoopPrLedgerPayload({ generatedAt: new Date(NOW - 5 * DAY).toISOString(), openPrs: [], mergedPrs: [] }, { nowMs: NOW }),
    null,
    "a stale export (>3d) is rejected — old coverage data must not hide findings"
  );
  assert.equal(parseLoopPrLedgerPayload({ openPrs: [] }, { nowMs: NOW }), null, "missing generatedAt is rejected");
  assert.equal(parseLoopPrLedgerPayload("garbage", { nowMs: NOW }), null, "malformed payload is rejected");
  const filtered = parseLoopPrLedgerPayload(
    { generatedAt: new Date(NOW).toISOString(), openPrs: [{ number: 3 }, { nope: true }], mergedPrs: null },
    { nowMs: NOW }
  );
  assert.ok(filtered && filtered.openPrs.length === 1 && filtered.mergedPrs.length === 0, "rows without a PR number are dropped; missing lists default empty");
}

console.log("PASS loop_pr_ledger_suppression eval — exact-key open/merged suppression + coverage cap on shared keys + regression-of-disposed never suppressed + fail-safe keeps + payload recompute + box ledger-file freshness guard");
