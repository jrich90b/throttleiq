/**
 * stale_finding_suppression:eval — pins suppressStaleFindings (anomalyClassifier.ts), the "never
 * re-fix a ghost" guard for the anomaly work order.
 *
 * A detector keeps surfacing a finding until its triggering event ages out of its window, even after
 * the root cause is fixed + deployed (2026-06-30: all 23 crm_log_stale findings were pre-fix sends that
 * can never be retroactively logged). The suppressor drops a finding ONLY when its dimension is in the
 * DIMENSION_FIX_CUTOVERS ledger, its guarding eval is in ci:eval, AND its occurredAt is strictly before
 * the fix commit date. ANY uncertainty keeps the finding (fail-safe — never hide a real one).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  suppressStaleFindings,
  DIMENSION_FIX_CUTOVERS
} from "../services/api/src/domain/anomalyClassifier.ts";

const a = (over: Record<string, unknown> = {}) => ({
  convId: "+1716",
  leadKey: "+1716",
  dimension: "crm_log_stale",
  category: "state" as const,
  severity: "P2" as const,
  healed: false,
  detail: "a sent outbound (2d ago) is newer than the last TLP log",
  ...over
});

const GUARDED = new Set(["tlp_autosend_coverage:eval"]); // pretend ci:eval contains the guarding eval

// 1. STALE: ledgered dimension + eval present + event strictly before the cutover → suppressed.
{
  const { kept, suppressed } = suppressStaleFindings([a({ occurredAt: "2026-06-28T14:00:00.000Z" })], {
    guardingEvals: GUARDED
  });
  assert.equal(kept.length, 0, "a pre-fix crm_log_stale send is suppressed");
  assert.equal(suppressed.length, 1, "the pre-fix send is recorded as suppressed");
  assert.match(suppressed[0].reason, /predates fix/, "the suppression reason explains it predates the fix");
}

// 2. KEPT: event ON/AFTER the cutover → a possible real post-fix regression, never suppressed.
{
  const { kept, suppressed } = suppressStaleFindings([a({ occurredAt: "2026-06-30T10:00:00.000Z" })], {
    guardingEvals: GUARDED
  });
  assert.equal(kept.length, 1, "a post-fix send is kept (could be a real regression)");
  assert.equal(suppressed.length, 0);
}

// 3. KEPT: no occurredAt → can't prove stale → keep (fail-safe).
{
  const { kept } = suppressStaleFindings([a({ occurredAt: undefined })], { guardingEvals: GUARDED });
  assert.equal(kept.length, 1, "a finding with no event time is kept");
}

// 4. KEPT: the guarding eval is NOT in ci:eval (fix not proven / could be reverted) → keep.
{
  const { kept } = suppressStaleFindings([a({ occurredAt: "2026-06-28T14:00:00.000Z" })], {
    guardingEvals: new Set<string>()
  });
  assert.equal(kept.length, 1, "without the guarding eval in ci:eval, even a pre-fix finding is kept");
}

// 5. KEPT: a dimension NOT in the ledger is never touched, however old.
{
  const { kept } = suppressStaleFindings(
    [a({ dimension: "held_draft_unresolved", occurredAt: "2020-01-01T00:00:00.000Z" })],
    { guardingEvals: GUARDED }
  );
  assert.equal(kept.length, 1, "a non-ledgered dimension is always kept");
}

// 6. BOUNDARY: an event exactly AT the cutover (not strictly before) is kept.
{
  const cut = DIMENSION_FIX_CUTOVERS["crm_log_stale"].committedAt; // "2026-06-29"
  const { kept } = suppressStaleFindings([a({ occurredAt: new Date(cut).toISOString() })], {
    guardingEvals: GUARDED
  });
  assert.equal(kept.length, 1, "an event exactly at the cutover is kept (strictly-before only)");
}

// 7. LEDGER INTEGRITY: every cutover's guarding eval must actually be wired into ci:eval — otherwise the
// suppressor silently never fires for that dimension (or, worse, a reverted fix would keep suppressing).
{
  const pkg = JSON.parse(fs.readFileSync(path.resolve("package.json"), "utf8"));
  const chain = String(pkg?.scripts?.["ci:eval"] ?? "");
  const ciEvals = new Set<string>();
  for (const m of chain.matchAll(/npm run ([\w:-]+)/g)) ciEvals.add(m[1]);
  for (const [dim, cut] of Object.entries(DIMENSION_FIX_CUTOVERS)) {
    assert.ok(ciEvals.has(cut.eval), `cutover for ${dim} names ${cut.eval}, which must be wired into ci:eval`);
    assert.ok(Number.isFinite(Date.parse(cut.committedAt)), `cutover for ${dim} must have a parseable committedAt`);
  }
}

// 8. WIRING: the detect script runs the suppressor on the merged feed before classifying.
{
  const detect = fs.readFileSync(path.resolve("scripts/anomaly_loop_detect.ts"), "utf8");
  assert.match(detect, /suppressStaleFindings\(anomalies, \{ guardingEvals: ciEvalScriptSet\(\) \}\)/, "detect must run the suppressor with the ci:eval set");
  assert.match(detect, /suppressedStaleCount/, "detect must report the suppressed count in the work order payload");
}

console.log("PASS stale-finding suppression eval (suppress pre-fix / keep uncertain / ledger integrity / wiring)");
