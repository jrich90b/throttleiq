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
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  suppressStaleFindings,
  suppressAlreadyShippedEchoes,
  ECHO_SUPPRESSIBLE_DIMENSIONS,
  DIMENSION_FIX_CUTOVERS,
  type NamingCommit
} from "../services/api/src/domain/anomalyClassifier.ts";
import {
  CODE_STATE_DISPOSITIONS,
  DISPOSITIONS,
  dispositionBoundaryMs,
  isDisposition,
  occurrenceMsOf,
  parseDispositionLedgerPayload,
  partitionByDispositions,
  POLICY_DISPOSITIONS,
  upsertDisposition,
  type DispositionRecord
} from "../services/api/src/domain/dispositionLedger.ts";

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

// ── DISPOSITION LEDGER — the PERMANENT record (Joe 2026-07-30: "not show up again") ──
// The three passes above all expire (a cutover date, a commit grep, a 14-day window). This one is
// the explicit disposition a routine wrote, so it must never lapse — and must never eat a regression.
const dz = (over: Record<string, unknown> = {}) => ({
  convId: "+17162440763",
  leadKey: "+17162440763",
  dimension: "open_critic_finding",
  category: "discovery" as const,
  severity: "P2" as const,
  healed: false,
  detail: "ignored_customer_budget_constraint",
  occurredAt: "2026-07-28T12:00:00.000Z",
  ...over
});
const ledgerOf = (...recs: DispositionRecord[]) => new Map(recs.map(r => [r.key, r]));
const rec = (over: Partial<DispositionRecord> = {}): DispositionRecord => ({
  key: "+17162440763::open_critic_finding",
  disposition: "joe-ruled",
  at: "2026-07-29T18:00:00.000Z",
  by: "leadrider-morning-quality-routine",
  deployTs: null,
  note: null,
  ...over
});

// 15. POLICY disposition ("joe-ruled") suppresses the key permanently — no window, no expiry.
//     This is the exact 7/30 case: Derek's budget miss was ruled + built on 7/29 and still ranked
//     in the feed's top 8 the next morning.
{
  const { kept, suppressed, regressions } = partitionByDispositions([dz()], { ledger: ledgerOf(rec()) });
  assert.equal(kept.length, 0, "a joe-ruled key is suppressed");
  assert.equal(suppressed.length, 1);
  assert.equal(regressions.length, 0, "a policy disposition has no regression path");
  assert.match(suppressed[0].reason, /permanently suppressed/, "the reason says it is permanent");
}

// 16. POLICY disposition is TIMELESS: an occurrence years later is still the same non-defect.
//     Safe because the key is one conversation+dimension — a real rule regression shows up on
//     OTHER convIds, which carry no disposition.
{
  const { kept, suppressed } = partitionByDispositions([dz({ occurredAt: "2030-01-01T00:00:00.000Z" })], {
    ledger: ledgerOf(rec())
  });
  assert.equal(kept.length, 0, "a much-later occurrence of a policy-disposed key stays suppressed");
  assert.equal(suppressed.length, 1);
}

// 17. THE FAIL-SAFE EXCEPTION — a CODE-STATE disposition whose event postdates the fix deploy comes
//     back marked regression-of-disposed. A fix that didn't hold is never silently eaten.
{
  const r = rec({ disposition: "fixed", deployTs: "2026-07-29T20:00:00.000Z" });
  const { kept, suppressed, regressions } = partitionByDispositions(
    [dz({ occurredAt: "2026-07-30T09:00:00.000Z" })],
    { ledger: ledgerOf(r) }
  );
  assert.equal(suppressed.length, 0, "a post-deploy occurrence is NOT suppressed");
  assert.equal(kept.length, 0, "it is reported as a regression, not as an ordinary kept finding");
  assert.equal(regressions.length, 1, "it resurfaces as a regression");
  assert.match(regressions[0].reason, /regression-of-disposed/, "the marker names the class");
}

// 18. CODE-STATE, pre-deploy event → suppressed (the ordinary already-fixed echo).
{
  const r = rec({ disposition: "fixed", deployTs: "2026-07-29T20:00:00.000Z" });
  const { kept, suppressed, regressions } = partitionByDispositions(
    [dz({ occurredAt: "2026-07-28T09:00:00.000Z" })],
    { ledger: ledgerOf(r) }
  );
  assert.equal(kept.length, 0);
  assert.equal(regressions.length, 0);
  assert.equal(suppressed.length, 1, "an event before the deploy is a disposed echo");
}

// 19. BOUNDARY: deployTs beats `at` (routines usually dispose hours AFTER the deploy that fixed it),
//     and an event exactly AT the boundary is suppressed (strictly-after is a regression).
{
  const r = rec({ disposition: "fixed", at: "2026-07-30T18:00:00.000Z", deployTs: "2026-07-29T20:00:00.000Z" });
  assert.equal(dispositionBoundaryMs(r), Date.parse("2026-07-29T20:00:00.000Z"), "deployTs is the boundary, not `at`");
  const { suppressed, regressions } = partitionByDispositions([dz({ occurredAt: "2026-07-29T20:00:00.000Z" })], {
    ledger: ledgerOf(r)
  });
  assert.equal(regressions.length, 0, "an event exactly at the boundary is not a regression");
  assert.equal(suppressed.length, 1);
}

// 20. FAIL-SAFE: an undatable occurrence against a CODE-STATE disposition is KEPT — we cannot prove
//     it predates the fix, and the sibling passes fail the same way (never hide the unprovable).
{
  const r = rec({ disposition: "fixed", deployTs: "2026-07-29T20:00:00.000Z" });
  const { kept, suppressed } = partitionByDispositions([dz({ occurredAt: undefined })], { ledger: ledgerOf(r) });
  assert.equal(kept.length, 1, "no occurredAt + code-state disposition → keep");
  assert.equal(suppressed.length, 0);
}

// 20b. An OPERATOR REPORT is datable by `reportedAt` alone — the reported_issue source never sets
//      occurredAt (it is only an UPPER BOUND on the offending reply, deliberately kept separate at
//      the source). Before this, every code-state disposition on a reported_issue key suppressed
//      NOTHING: measured 2026-08-02, 23 such ledger records vs 65 findings still in the feed, and
//      this loop re-triaged 4 leads it had disposed 90 minutes earlier.
{
  const opReport = (over: Record<string, unknown> = {}) => ({
    convId: "+17169013675",
    leadKey: "+17169013675",
    dimension: "reported_issue",
    category: "feedback" as const,
    severity: "P2" as const,
    healed: false,
    detail: "operator-reported (cadence): purchase interest is 4-6 months, should be a long term cadence",
    reportedAt: "2026-07-16T21:41:04.399Z",
    ...over
  });
  const disposed = rec({
    key: "+17169013675::reported_issue",
    disposition: "fixed",
    deployTs: "2026-07-17T16:10:12.000Z"
  });

  const pre = partitionByDispositions([opReport()], { ledger: ledgerOf(disposed) });
  assert.equal(pre.suppressed.length, 1, "a report filed BEFORE the fix boundary is suppressed");
  assert.equal(pre.kept.length, 0);
  assert.equal(pre.regressions.length, 0);
  assert.match(
    pre.suppressed[0].reason,
    /2026-07-16T21:41:04\.399Z/,
    "the reason names the timestamp actually compared, not 'undefined'"
  );

  // FAIL-SAFE PRESERVED: an upper bound can only err by looking NEWER than the event, so a report
  // filed after the fix resurfaces as a regression rather than being eaten.
  const post = partitionByDispositions([opReport({ reportedAt: "2026-08-02T12:00:00.000Z" })], {
    ledger: ledgerOf(disposed)
  });
  assert.equal(post.regressions.length, 1, "a report filed AFTER the fix comes back as a regression");
  assert.equal(post.suppressed.length, 0, "a post-fix report is never suppressed");

  // A POLICY disposition stays timeless — it never depended on a date either way.
  const policy = partitionByDispositions([opReport({ reportedAt: "2030-01-01T00:00:00.000Z" })], {
    ledger: ledgerOf(rec({ key: "+17169013675::reported_issue", disposition: "no-action" }))
  });
  assert.equal(policy.suppressed.length, 1, "no-action suppresses regardless of the report date");
}

// 20c. `occurredAt` always WINS: reportedAt is only the fallback for sources that omit the event.
{
  assert.equal(
    occurrenceMsOf({ occurredAt: "2026-07-01T00:00:00.000Z", reportedAt: "2026-07-20T00:00:00.000Z" }),
    Date.parse("2026-07-01T00:00:00.000Z"),
    "the true event time beats the upper bound"
  );
  assert.equal(
    occurrenceMsOf({ reportedAt: "2026-07-20T00:00:00.000Z" }),
    Date.parse("2026-07-20T00:00:00.000Z"),
    "reportedAt carries the date when the source omits occurredAt"
  );
  assert.ok(!Number.isFinite(occurrenceMsOf({})), "neither field ⇒ undatable ⇒ caller keeps the finding");
  assert.ok(
    !Number.isFinite(occurrenceMsOf({ occurredAt: "not-a-date", reportedAt: null })),
    "an unparseable pair stays undatable — never silently suppressed"
  );
}

// 21. FAIL-SAFE: no ledger, an empty ledger, or a different key suppresses NOTHING.
{
  assert.equal(partitionByDispositions([dz()], { ledger: null }).kept.length, 1, "no ledger → keep");
  assert.equal(partitionByDispositions([dz()], { ledger: new Map() }).kept.length, 1, "empty ledger → keep");
  assert.equal(
    partitionByDispositions([dz({ dimension: "held_draft_unresolved" })], { ledger: ledgerOf(rec()) }).kept.length,
    1,
    "the ledger is EXACT-KEY: a different dimension on the same conversation is untouched"
  );
}

// 22. PARSING is fail-safe: a malformed record is dropped (suppresses nothing) rather than trusted,
//     and a payload that isn't a ledger at all returns null. An unknown disposition word must never
//     silently suppress.
{
  assert.equal(parseDispositionLedgerPayload(null), null, "non-object payload → null");
  assert.equal(parseDispositionLedgerPayload({}), null, "payload without records → null");
  const parsed = parseDispositionLedgerPayload({
    version: 1,
    records: [
      rec(),
      { ...rec({ key: "+1999::x" }), disposition: "probably-fine" }, // unknown vocabulary
      { ...rec({ key: "+1888::x" }), at: "not-a-date" }, // undatable
      { ...rec({ key: "::" }) } // meaningless key would suppress by accident
    ]
  });
  assert.ok(parsed, "a well-formed ledger parses");
  assert.equal(parsed!.size, 1, "only the valid record survives; the three malformed ones are dropped");
  assert.ok(parsed!.has("+17162440763::open_critic_finding"));
}

// 23. NO FRESHNESS GUARD — unlike the PR-ledger export, an OLD disposition is still a disposition.
//     (That is the whole point: the inference passes expire, this one must not.)
{
  const ancient = parseDispositionLedgerPayload({ version: 1, updatedAt: "2020-01-01T00:00:00.000Z", records: [rec()] });
  assert.equal(ancient?.size, 1, "a years-old ledger still suppresses");
}

// 24. upsert is IDEMPOTENT (one row per key) and never lets the boundary drift LATER on its own —
//     otherwise occurrences between the first and second disposal would stop counting as regressions.
{
  const first = upsertDisposition([], rec({ disposition: "fixed", at: "2026-07-29T18:00:00.000Z" }));
  const second = upsertDisposition(first, rec({ disposition: "fixed", at: "2026-07-30T18:00:00.000Z" }));
  assert.equal(second.length, 1, "re-disposing the same key updates in place (one record per key)");
  assert.equal(second[0].at, "2026-07-29T18:00:00.000Z", "the EARLIEST disposal time is kept");
  // An explicit deployTs IS allowed to move the boundary — that's a stated fact, not drift.
  const third = upsertDisposition(second, rec({ disposition: "fixed", deployTs: "2026-07-30T20:00:00.000Z" }));
  assert.equal(third[0].deployTs, "2026-07-30T20:00:00.000Z", "an explicit deployTs is recorded");
}

// 25. VOCABULARY integrity: every disposition is exactly one kind, and the two kinds cover them all.
{
  for (const d of DISPOSITIONS) {
    assert.ok(
      CODE_STATE_DISPOSITIONS.has(d) !== POLICY_DISPOSITIONS.has(d),
      `${d} must be exactly one of code-state / policy (kind decides whether a regression can revive it)`
    );
    assert.ok(isDisposition(d));
  }
  assert.ok(!isDisposition("fixed-ish"), "an unknown word is not a disposition");
  assert.equal(CODE_STATE_DISPOSITIONS.size + POLICY_DISPOSITIONS.size, DISPOSITIONS.length);
}

// 26. WIRING: detect consults the ledger, reports both counts, and act_runner exposes the writer
//     every routine calls (ROUTINE_CONTRACT.md — "every routine records dispositions identically").
{
  const detect = fs.readFileSync(path.resolve("scripts/anomaly_loop_detect.ts"), "utf8");
  assert.match(detect, /partitionByDispositions\(/, "detect must run the disposition suppressor");
  assert.match(detect, /dispositions\.json/, "detect must read the box-side disposition ledger");
  assert.match(detect, /suppressedByDispositionCount/, "detect must report the disposition-suppressed count");
  assert.match(detect, /regressionOfDisposedCount/, "detect must report regressions of disposed findings");
  assert.match(detect, /regressionOfDisposed: true/, "a regression stays in the feed, tagged — never dropped");
  const runner = fs.readFileSync(path.resolve("scripts/act_runner.ts"), "utf8");
  assert.match(runner, /sub === "dispose"/, "act_runner must expose the `dispose` writer");
  assert.match(runner, /Refusing to write/, "a corrupt ledger must not be silently replaced by an empty one");
}

// 27. THE REGRESSION SHIELD — section 17's promise has to survive the FOUR suppression passes that
//     run after the ledger. They all match on `convId::dimension` alone, so they were eating the
//     very findings the ledger had just re-armed. Charles Desalvo +17168614216: Joe's "No sold
//     cadence" report (2026-08-03T12:32Z) was marked a regression and then dropped by the PR pass
//     against PR #470 — merged at 08:43 the same morning, FOUR HOURS before the report existed.
{
  const { restoreDisposedRegressions } = await import("../services/api/src/domain/dispositionLedger.ts");
  const { findingKeyOf } = await import("../services/api/src/domain/loopPrDedup.ts");
  const keyOf = (a: any) => findingKeyOf(a?.convId ?? null, a?.dimension ?? null);
  const regression = {
    convId: "+17168614216",
    dimension: "reported_issue",
    regressionOfDisposed: true,
    dispositionReason: "regression-of-disposed: event 2026-08-03T12:32:09.440Z postdates the fixed boundary"
  };
  const other = { convId: "+15550001111", dimension: "held_draft" };

  // The bug, exactly: a later pass dropped the regression.
  const eaten = restoreDisposedRegressions([other], [regression]);
  assert.equal(eaten.restored.length, 1, "a dropped regression must be put back");
  assert.equal(
    eaten.anomalies.filter(a => keyOf(a) === "+17168614216::reported_issue").length,
    1,
    "the restored regression must be in the feed exactly once"
  );
  assert.ok(
    eaten.anomalies.some(a => keyOf(a) === "+15550001111::held_draft"),
    "restoring must not disturb the findings that survived"
  );

  // No-op when the passes behaved — the shield must never duplicate a surviving finding.
  const untouched = restoreDisposedRegressions([other, regression], [regression]);
  assert.equal(untouched.restored.length, 0, "a regression already in the feed is not restored again");
  assert.equal(untouched.anomalies.length, 2, "the shield must not duplicate a surviving regression");

  // Two regressions on the SAME lead+dimension collapse to one key, as everything downstream assumes.
  const dupes = restoreDisposedRegressions([], [regression, { ...regression }]);
  assert.equal(dupes.anomalies.length, 1, "one key restores once, however many times it appears");

  // Nothing to shield ⇒ nothing changes.
  const none = restoreDisposedRegressions([other], []);
  assert.equal(none.restored.length, 0);
  assert.equal(none.anomalies.length, 1, "no regressions ⇒ the feed passes through untouched");
}

// 28. THE UNDATABLE DIMENSION. `open_critic_finding` carries NEITHER `occurredAt` NOR `reportedAt` —
//     its only datable field is the detector's own `firstSeenAt` — so every `fixed`/`stale-echo`
//     disposition on that dimension suppressed nothing and the row cycled forever. Measured
//     2026-08-06: +17165104578::open_critic_finding was disposed `fixed` with a deploy boundary, the
//     ledger accepted the record, and `act_runner list` returned the row on the very next read.
//
//     This section EXECUTES the real detector against a synthetic REPORT_ROOT rather than reading its
//     source, because the bug was never in the suppressor — it was in the ORDER: `firstSeenAt` is
//     stamped when findings are classified, which happens AFTER the ledger pass, so the ledger was
//     handed a row with no dates on it at all. A source-text assertion cannot see that.
{
  const day = 24 * 60 * 60 * 1000;
  const nowMs = Date.now(); // built relative to now — never a fixed date the calendar can turn red
  const iso = (ms: number) => new Date(ms).toISOString();
  const boundary = iso(nowMs - 5 * day);

  // Unit level first: firstSeenAt is the THIRD fallback and must never outrank a real event time.
  assert.equal(
    occurrenceMsOf({ firstSeenAt: "2026-07-01T00:00:00.000Z" }),
    Date.parse("2026-07-01T00:00:00.000Z"),
    "firstSeenAt dates a finding that carries nothing else"
  );
  assert.equal(
    occurrenceMsOf({ reportedAt: "2026-07-20T00:00:00.000Z", firstSeenAt: "2026-07-01T00:00:00.000Z" }),
    Date.parse("2026-07-20T00:00:00.000Z"),
    "reportedAt still beats firstSeenAt"
  );
  assert.equal(
    occurrenceMsOf({
      occurredAt: "2026-06-01T00:00:00.000Z",
      reportedAt: "2026-07-20T00:00:00.000Z",
      firstSeenAt: "2026-07-01T00:00:00.000Z"
    }),
    Date.parse("2026-06-01T00:00:00.000Z"),
    "the true event time still wins over both upper bounds"
  );
  assert.ok(
    !Number.isFinite(occurrenceMsOf({ firstSeenAt: "not-a-date" })),
    "an unparseable first-seen stamp stays undatable — never silently suppressed"
  );

  // --- the executing half: one run of scripts/anomaly_loop_detect.ts over a synthetic feed ---
  const critic = (convId: string) => ({
    convId,
    leadKey: convId,
    dimension: "open_critic_finding",
    category: "discovery" as const,
    severity: "P2" as const,
    healed: false,
    detail: "open-critic: promised_unit_not_in_stock — synthetic fixture"
  });
  const SUPPRESSED = "+15550000001"; // first seen BEFORE the fix boundary ⇒ must drop out
  const REGRESSION = "+15550000002"; // first seen AFTER  the fix boundary ⇒ must come back, tagged
  const CONTROL = "+15550000003"; // no prior stamp ⇒ undatable ⇒ must survive (fail-safe)
  const disposedFor = (convId: string) => ({
    key: `${convId}::open_critic_finding`,
    disposition: "fixed",
    at: boundary,
    by: "agent-loop",
    deployTs: boundary,
    note: "synthetic"
  });

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "disposition-firstseen-"));
  try {
    fs.mkdirSync(path.join(root, "outcome_audit"), { recursive: true });
    fs.mkdirSync(path.join(root, "anomaly_loop"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "outcome_audit", "latest.json"),
      JSON.stringify({ generatedAt: iso(nowMs), anomalies: [critic(SUPPRESSED), critic(REGRESSION), critic(CONTROL)] })
    );
    // The PRIOR run's first-seen ledger — the only place these findings are datable at all.
    fs.writeFileSync(
      path.join(root, "anomaly_loop", "prev_keys.json"),
      JSON.stringify({
        keys: [`${SUPPRESSED}::open_critic_finding`, `${REGRESSION}::open_critic_finding`],
        firstSeen: {
          [`${SUPPRESSED}::open_critic_finding`]: iso(nowMs - 10 * day),
          [`${REGRESSION}::open_critic_finding`]: iso(nowMs - 2 * day)
        }
      })
    );
    fs.writeFileSync(
      path.join(root, "anomaly_loop", "dispositions.json"),
      JSON.stringify({
        version: 1,
        updatedAt: iso(nowMs),
        records: [disposedFor(SUPPRESSED), disposedFor(REGRESSION), disposedFor(CONTROL)]
      })
    );

    execFileSync("npx", ["tsx", "scripts/anomaly_loop_detect.ts"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, REPORT_ROOT: root }
    });

    const out = JSON.parse(fs.readFileSync(path.join(root, "anomaly_loop", "next.json"), "utf8"));
    const survivors: string[] = JSON.parse(
      fs.readFileSync(path.join(root, "anomaly_loop", "prev_keys.json"), "utf8")
    ).keys;
    const suppressedIds = (out.suppressedByDisposition ?? []).map((s: any) => String(s.convId));
    const regressionIds = (out.regressionOfDisposed ?? []).map((r: any) => String(r.convId));

    assert.ok(
      suppressedIds.includes(SUPPRESSED),
      "THE BUG: a finding first seen before its fix boundary must be suppressed — an open_critic row carries no other date"
    );
    assert.ok(!survivors.includes(`${SUPPRESSED}::open_critic_finding`), "the suppressed key must leave the feed");

    assert.ok(
      regressionIds.includes(REGRESSION),
      "first seen AFTER the boundary is a regression-of-disposed, never a suppression"
    );
    assert.ok(!suppressedIds.includes(REGRESSION), "a regression must never be eaten as stale");

    // THE CONTROL, and the reason this section is not self-fulfilling: a key with no prior stamp is
    // undatable, so it must survive every pass. It also proves the two above dropped out because of
    // the ledger, and not because the detector discards this shape.
    assert.ok(
      !suppressedIds.includes(CONTROL) && !regressionIds.includes(CONTROL),
      "no prior first-seen stamp ⇒ undatable ⇒ never dated to now and never suppressed"
    );
    assert.ok(
      survivors.includes(`${CONTROL}::open_critic_finding`),
      "the undatable finding must still be in the feed — fail-safe: keep what you cannot prove is old"
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

console.log(
  "PASS stale-finding suppression eval (suppress pre-fix / keep uncertain / ledger integrity / wiring + already-shipped echoes: named-fix-postdates-event / regression-safe / scope / wiring + disposition ledger: permanent policy suppression / regression-of-disposed fail-safe / boundary / operator-report reportedAt fallback / parse+upsert fail-safety / vocabulary / wiring / regression shield vs the later suppression passes / undatable open_critic firstSeenAt fallback, detector EXECUTED)"
);
