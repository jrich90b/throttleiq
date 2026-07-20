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
  suppressAlreadyShippedEchoes,
  ECHO_SUPPRESSIBLE_DIMENSIONS,
  DIMENSION_FIX_CUTOVERS,
  type NamingCommit
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

// ── suppressAlreadyShippedEchoes — the permanent complement to the 14-day PR-ledger window ──
const hc = (over: Record<string, unknown> = {}) => ({
  convId: "+12282200201",
  leadKey: "+12282200201",
  dimension: "human_correction_material",
  category: "comprehension" as const,
  severity: "P2" as const,
  healed: false,
  detail: "staff materially corrected the AI draft (wrong_fact) — parts→apparel",
  occurredAt: "2026-07-02T02:00:00.000Z",
  ...over
});
const commit = (dateIso: string, subject = "Loop fix: human_correction_material (#148)"): NamingCommit => ({
  hash: "70a3dadb",
  subject,
  dateMs: Date.parse(dateIso)
});

// 9. STALE ECHO: a commit NAMES the case and postdates the flagged event → suppressed (the #148 poker-chip
//    case that re-fired on 2026-07-18 after its 14-day PR-ledger window lapsed).
{
  const { kept, suppressed } = suppressAlreadyShippedEchoes([hc()], {
    namingCommitsFor: () => [commit("2026-07-02T13:58:50.000Z")]
  });
  assert.equal(kept.length, 0, "a case named by a commit that postdates the event is an already-shipped echo");
  assert.equal(suppressed.length, 1);
  assert.match(suppressed[0].reason, /already shipped/, "reason marks it already shipped");
  assert.match(suppressed[0].reason, /70a3dadb/, "reason cites the naming commit");
}

// 10. KEPT (regression-safe): the flagged event is AFTER every naming commit → a possible post-fix
//     regression, never hidden.
{
  const { kept, suppressed } = suppressAlreadyShippedEchoes([hc({ occurredAt: "2026-07-10T00:00:00.000Z" })], {
    namingCommitsFor: () => [commit("2026-07-02T13:58:50.000Z")]
  });
  assert.equal(kept.length, 1, "an event AFTER the fix commit is kept (could be a real regression)");
  assert.equal(suppressed.length, 0);
}

// 11. KEPT: no naming commit at all → keep (fail toward surfacing).
{
  const { kept } = suppressAlreadyShippedEchoes([hc()], { namingCommitsFor: () => [] });
  assert.equal(kept.length, 1, "no commit names the case → keep");
}

// 12. KEPT: no occurredAt → can't prove the graded reply predates the fix → keep (fail-safe).
{
  const { kept } = suppressAlreadyShippedEchoes([hc({ occurredAt: undefined })], {
    namingCommitsFor: () => [commit("2026-07-02T13:58:50.000Z")]
  });
  assert.equal(kept.length, 1, "a finding with no event time is kept even when a commit names the case");
}

// 13. SCOPE: an out-of-scope dimension is never echo-suppressed, however clearly named/dated. Operator and
//     human signals must stay visible.
{
  const { kept } = suppressAlreadyShippedEchoes(
    [hc({ dimension: "reported_issue" }), hc({ dimension: "thumbs_down_action_request" })],
    { namingCommitsFor: () => [commit("2026-07-02T13:58:50.000Z")] }
  );
  assert.equal(kept.length, 2, "reported_issue / thumbs_down_action_request are out of echo scope → kept");
  assert.ok(
    !ECHO_SUPPRESSIBLE_DIMENSIONS.has("reported_issue"),
    "operator-reported is intentionally NOT echo-suppressible"
  );
  assert.ok(
    ECHO_SUPPRESSIBLE_DIMENSIONS.has("human_correction_material") &&
      ECHO_SUPPRESSIBLE_DIMENSIONS.has("corpus_replay_judge_fail"),
    "the frozen-transcript machine detectors ARE echo-suppressible"
  );
}

// 14. WIRING: the detect script runs the echo suppressor and reports its count in the payload.
{
  const detect = fs.readFileSync(path.resolve("scripts/anomaly_loop_detect.ts"), "utf8");
  assert.match(detect, /suppressAlreadyShippedEchoes\(/, "detect must run the already-shipped echo suppressor");
  assert.match(detect, /suppressedShippedEchoCount/, "detect must report the echo-suppressed count in the payload");
}

console.log(
  "PASS stale-finding suppression eval (suppress pre-fix / keep uncertain / ledger integrity / wiring + already-shipped echoes: named-fix-postdates-event / regression-safe / scope / wiring)"
);
