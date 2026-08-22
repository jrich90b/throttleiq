/**
 * Disposition REPORT SCOPE eval — pins that disposing one report cannot silence its siblings.
 *
 * THE MISS THIS GUARDS (measured 2026-08-22, on the loop itself). The ledger key was
 * `convId::dimension` — a LEAD, not a FINDING — while a single lead routinely carries several
 * unrelated operator reports under one dimension. `+15307211080::reported_issue` held two, filed
 * seven minutes apart on 8/15:
 *
 *   (a) "customer said STOP but I don't see the lead going to the suppressed list"
 *       — VERIFIED CORRECT end to end: suppressions.json carries the record 4.7s after the STOP,
 *         followUpCadence.stopReason = opt_out, thread closed, nothing sent after.
 *   (b) "we don't have a 2025 street glide in stock"
 *       — a LIVE first-touch defect, never investigated.
 *
 * The loop disposed (a) `no-action` — a POLICY disposition, permanent, no undo — and wrote the split
 * into its own `--note` in the same breath: *"the second report on this same key is a DIFFERENT and
 * REAL defect … NOT disposed by this"*. The tool accepted it and printed "suppressed permanently".
 * (b) was silenced by a disposition whose own text said it must not be, and the only repair was
 * hand-editing dispositions.json (347 → 346) because there is no `undispose` subcommand.
 *
 * The morning routine had filed a memo about this exact key FOUR HOURS EARLIER, proposing "check the
 * feed for siblings first". That mitigation lost to an agent who had read it. Hence a key change and
 * a refusal, not a discipline.
 *
 * This eval EXECUTES act_runner against a synthetic report root (SKILL trap 3: a source-text
 * assertion cannot prove a script still runs). Clock-safe: no assertion depends on wall-clock time.
 *
 * Run: npx tsx scripts/disposition_report_scope_eval.ts
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const {
  dispositionKeyOf,
  findingKeyOfDispositionKey,
  isReportScopedKey,
  partitionByDispositions,
  reportScopeOf,
  restoreDisposedRegressions,
  withReportScope
} = await import("../services/api/src/domain/dispositionLedger.ts");
type DispositionRecord = import("../services/api/src/domain/dispositionLedger.ts").DispositionRecord;

// ---------------------------------------------------------------------------
// 1. The key itself.
// ---------------------------------------------------------------------------
assert.equal(dispositionKeyOf("+1555", "reported_issue"), "+1555::reported_issue", "no stamp ⇒ the legacy two-part key");
assert.equal(
  dispositionKeyOf("+1555", "reported_issue", "2026-08-15T12:24:00.000Z"),
  "+1555::reported_issue::2026-08-15T12:24:00.000Z",
  "a stamp appends a third component"
);
assert.equal(dispositionKeyOf("+1555", "reported_issue", "   "), "+1555::reported_issue", "a blank stamp must not leave a trailing separator");
assert.equal(isReportScopedKey("+1555::reported_issue"), false, "two parts is lead-scoped");
assert.equal(isReportScopedKey("+1555::reported_issue::2026-08-15T12:24:00.000Z"), true, "three parts is report-scoped");
assert.equal(
  findingKeyOfDispositionKey("+1555::reported_issue::2026-08-15T12:24:00.000Z"),
  "+1555::reported_issue",
  "a scoped key still knows which lead+dimension it belongs to"
);
assert.equal(findingKeyOfDispositionKey("+1555::reported_issue"), "+1555::reported_issue", "…and a legacy key is unchanged by the round trip");
assert.equal(
  withReportScope("+1555::reported_issue::2026-08-15T12:24:00.000Z", "2026-08-15T12:31:00.000Z"),
  "+1555::reported_issue::2026-08-15T12:31:00.000Z",
  "re-scoping replaces the stamp rather than stacking a fourth component"
);

// `firstSeenAt` is per-KEY, not per-report — using it would hand every sibling the same stamp and
// re-create the collision while looking solved. It must never become a scope.
assert.equal(reportScopeOf({ reportedAt: "2026-08-15T12:24:00.000Z", occurredAt: "2026-08-15T09:00:00.000Z" }), "2026-08-15T12:24:00.000Z", "reportedAt wins — it is the per-report instant");
assert.equal(reportScopeOf({ occurredAt: "2026-08-15T09:00:00.000Z" }), "2026-08-15T09:00:00.000Z", "occurredAt is the fallback for detector-minted findings");
assert.equal(reportScopeOf({ firstSeenAt: "2026-08-15T09:00:00.000Z" }), null, "firstSeenAt is per-KEY and must NEVER be used as a report scope");
assert.equal(reportScopeOf({ reportedAt: "not a date" }), null, "an unparseable stamp yields no scope — the finding then behaves exactly as it did before");
assert.equal(reportScopeOf(null), null, "and a missing finding claims nothing");

// ---------------------------------------------------------------------------
// 2. THE INCIDENT — the two real reports on +15307211080, as filed.
// ---------------------------------------------------------------------------
const STOP_REPORT = {
  convId: "+15307211080",
  dimension: "reported_issue",
  reportedAt: "2026-08-15T12:24:00.000Z",
  detail: "operator-reported (routing): Customer said stop but I don't see the lead going to the suppressed list"
};
const STOCK_REPORT = {
  convId: "+15307211080",
  dimension: "reported_issue",
  reportedAt: "2026-08-15T12:17:00.000Z",
  detail: "operator-reported (routing): We don't have a 2025 street glide in stock"
};
const rec = (key: string, disposition: DispositionRecord["disposition"], at: string): DispositionRecord => ({
  key,
  disposition,
  at,
  by: "agent-loop",
  deployTs: null,
  note: null
});

// The disposition the loop actually wrote, now report-scoped.
const scopedLedger = new Map<string, DispositionRecord>([
  [dispositionKeyOf(STOP_REPORT.convId, STOP_REPORT.dimension, STOP_REPORT.reportedAt), rec(dispositionKeyOf(STOP_REPORT.convId, STOP_REPORT.dimension, STOP_REPORT.reportedAt), "no-action", "2026-08-22T12:33:37.699Z")]
]);
const scoped = partitionByDispositions([STOP_REPORT, STOCK_REPORT], { ledger: scopedLedger });
assert.equal(scoped.suppressed.length, 1, "exactly the report that was verified is suppressed");
assert.equal(scoped.suppressed[0].anomaly, STOP_REPORT, "…and it is the STOP report, the one that was actually checked");
assert.deepEqual(scoped.kept, [STOCK_REPORT], "THE WHOLE POINT: the live stock-echo defect survives its sibling's disposition");
assert.ok(isReportScopedKey(scoped.suppressed[0].key), "the reason line cites the report-scoped key, not the lead");

// The pre-fix behaviour, kept as a regression guard: this is what silenced a live defect.
const leadScopedLedger = new Map<string, DispositionRecord>([
  ["+15307211080::reported_issue", rec("+15307211080::reported_issue", "no-action", "2026-08-22T12:33:37.699Z")]
]);
const leadScoped = partitionByDispositions([STOP_REPORT, STOCK_REPORT], { ledger: leadScopedLedger });
assert.equal(leadScoped.suppressed.length, 2, "a LEGACY two-part record still covers every report on the lead — all 346 existing records keep their exact meaning");
assert.equal(leadScoped.kept.length, 0, "…which is precisely the blast radius that made the incident possible, and why --all-reports must now be said out loud");

// Narrow beats broad when BOTH exist: the report-scoped record is the one cited for its own report.
const bothKey = dispositionKeyOf(STOP_REPORT.convId, STOP_REPORT.dimension, STOP_REPORT.reportedAt);
const bothLedger = new Map<string, DispositionRecord>([
  ["+15307211080::reported_issue", rec("+15307211080::reported_issue", "joe-ruled", "2026-08-01T00:00:00.000Z")],
  [bothKey, rec(bothKey, "no-action", "2026-08-22T12:33:37.699Z")]
]);
const both = partitionByDispositions([STOP_REPORT], { ledger: bothLedger });
assert.equal(both.suppressed[0]?.key, bothKey, "the narrow record wins the lookup");
assert.equal(both.suppressed[0]?.record.disposition, "no-action", "…and its verdict is the one reported, not the lead-wide one");

// FAIL DIRECTION: a finding carrying no usable stamp has no narrow key and behaves exactly as before.
const undated = { convId: "+15307211080", dimension: "reported_issue" };
assert.equal(
  partitionByDispositions([undated], { ledger: leadScopedLedger }).suppressed.length,
  1,
  "an undated finding still matches its lead-scoped record — report scoping never un-suppresses what already worked"
);
assert.equal(
  partitionByDispositions([undated], { ledger: scopedLedger }).kept.length,
  1,
  "…and an undated finding is never matched to a report-scoped record it cannot be proven to be"
);

// ---------------------------------------------------------------------------
// 3. The regression shield must not collapse two reports either.
//
// It deduped by lead+dimension, so ONE surviving report masked a regression on a DIFFERENT report of
// the same lead, and two genuine regressions collapsed into one restoration. Scoping by report can
// only ever restore MORE, which is this shield's declared fail direction.
// ---------------------------------------------------------------------------
const twoRegressions = restoreDisposedRegressions([], [STOP_REPORT, STOCK_REPORT]);
assert.equal(twoRegressions.restored.length, 2, "two regressions on one lead are two restorations, not one");
const maskedBySibling = restoreDisposedRegressions([STOP_REPORT], [STOCK_REPORT]);
assert.deepEqual(maskedBySibling.restored, [STOCK_REPORT], "a surviving report must not mask a regression on a DIFFERENT report of the same lead");
const trueDuplicate = restoreDisposedRegressions([STOP_REPORT], [STOP_REPORT]);
assert.equal(trueDuplicate.restored.length, 0, "…while the SAME report already present is still not restored twice");

// ---------------------------------------------------------------------------
// 4. EXECUTION — the CLI is where the incident happened, so the CLI is what must refuse.
// ---------------------------------------------------------------------------
const root = fs.mkdtempSync(path.join(os.tmpdir(), "disposition-report-scope-"));
const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
function run(args: string[]): { stdout: string; stderr: string; status: number } {
  const r = spawnSync("npx", ["tsx", path.join(repoRoot, "scripts", "act_runner.ts"), ...args], {
    encoding: "utf8",
    cwd: repoRoot,
    env: { ...process.env, REPORT_ROOT: root }
  });
  return { stdout: String(r.stdout ?? ""), stderr: String(r.stderr ?? ""), status: Number(r.status ?? 1) };
}
const ledgerPath = path.join(root, "anomaly_loop", "dispositions.json");
const ledgerKeys = (): string[] => {
  if (!fs.existsSync(ledgerPath)) return [];
  return (JSON.parse(fs.readFileSync(ledgerPath, "utf8")).records ?? []).map((r: any) => String(r.key));
};

// THE EXACT COMMAND THAT CAUSED THE INCIDENT. It must now refuse, and write nothing.
const refused = run(["dispose", "--key", "+15307211080::reported_issue", "--as", "no-action", "--by", "eval"]);
assert.equal(refused.status, 2, `a policy disposition with no stated scope must REFUSE\n${refused.stdout}${refused.stderr}`);
assert.match(refused.stderr, /REFUSING/, "…loudly");
assert.match(refused.stderr, /--report-at/, "…naming the flag that disposes one report");
assert.match(refused.stderr, /--all-reports/, "…and the flag that means you checked them all");
assert.deepEqual(ledgerKeys(), [], "a refused dispose writes NOTHING — a partial write would be the same permanent damage");

// `joe-ruled` is the other permanent kind and is gated identically.
assert.equal(run(["dispose", "--key", "+1555::reported_issue", "--as", "joe-ruled", "--by", "eval"]).status, 2, "joe-ruled is a policy disposition too");

// Contradictory and malformed scopes are refused rather than guessed at.
assert.equal(
  run(["dispose", "--key", "+1555::reported_issue", "--as", "no-action", "--report-at", "2026-08-15T12:24:00.000Z", "--all-reports"]).status,
  2,
  "--report-at and --all-reports contradict; refuse rather than pick one"
);
assert.equal(
  run(["dispose", "--key", "+1555::reported_issue", "--as", "no-action", "--report-at", "sometime last week"]).status,
  2,
  "an unparseable --report-at would silently widen the key back to the lead — refuse it"
);
assert.deepEqual(ledgerKeys(), [], "still nothing written");

// The narrow path: one report disposed, key carries the stamp, and the CLI SAYS what it silenced.
const narrow = run(["dispose", "--key", "+15307211080::reported_issue", "--as", "no-action", "--by", "eval", "--report-at", "2026-08-15T12:24:00.000Z"]);
assert.equal(narrow.status, 0, `--report-at must be accepted\n${narrow.stderr}`);
assert.deepEqual(ledgerKeys(), ["+15307211080::reported_issue::2026-08-15T12:24:00.000Z"], "the written key carries the report stamp");
assert.match(narrow.stdout, /scope: THIS REPORT ONLY/, "the CLI states the blast radius it just chose");
assert.match(narrow.stdout, /other reports on \+15307211080::reported_issue stay open/, "…and says explicitly that the siblings survive");

// The wide path stays available for someone who really did read every report — it just has to say so.
const wide = run(["dispose", "--key", "+17169941544::reported_issue", "--as", "no-action", "--by", "eval", "--all-reports"]);
assert.equal(wide.status, 0, `--all-reports must be accepted\n${wide.stderr}`);
assert.ok(ledgerKeys().includes("+17169941544::reported_issue"), "…and writes the legacy two-part key, unchanged");
assert.match(wide.stdout, /scope: EVERY report on \+17169941544::reported_issue, including any not yet filed/, "the wide choice is stated just as plainly");

// CODE-STATE dispositions are deliberately NOT gated: they carry a boundary, so a sibling filed
// after it returns as regression-of-disposed rather than being eaten. Gating them would add
// friction to the kind that is already safe.
const codeState = run(["dispose", "--key", "+17164233848::draft_review_rewrite", "--as", "fixed", "--by", "eval", "--deploy-ts", "2026-08-21T21:52:00.000Z"]);
assert.equal(codeState.status, 0, `a fixed/stale-echo disposition still needs no scope flag\n${codeState.stderr}`);
assert.ok(ledgerKeys().includes("+17164233848::draft_review_rewrite"), "…and writes the two-part key as it always did");
assert.match(codeState.stdout, /regression-of-disposed/, "…still announcing its revival boundary");

// `list` has to SHOW the stamp, or --report-at names a value the reader cannot find.
const feedDir = path.join(root, "anomaly_loop");
fs.mkdirSync(feedDir, { recursive: true });
fs.writeFileSync(
  path.join(feedDir, "next.json"),
  JSON.stringify({
    generatedAt: new Date().toISOString(),
    workOrders: [
      { ...STOCK_REPORT, tier: 2, action: "escalate", severity: "P2" },
      { convId: "+15307211080", dimension: "reported_issue", reportedAt: "2026-08-15T12:31:00.000Z", tier: 2, action: "escalate", severity: "P2", detail: "a third report on the same id" }
    ]
  })
);
const listed = run(["list"]);
assert.match(listed.stdout, /reported-at: 2026-08-15T12:17:00\.000Z/, "list prints the stamp --report-at needs");
assert.match(listed.stdout, /2 reports share this id — dispose by report, not by id/, "…and warns when an id covers more than one report, which is invisible otherwise");

fs.rmSync(root, { recursive: true, force: true });

console.log("disposition_report_scope_eval: PASS — one report disposed, its siblings survive; legacy keys unchanged; the CLI refuses an unstated scope");
