/**
 * Anomaly classifier eval (2026-06-25) — Phase 3.
 *
 * Pins classifyOutcomeAnomaly (the AGENTS.md "Autonomous Self-Healing Loop" tier contract as code):
 * every (category, healed, persistent) combination maps to the right TIER + action + notify + auto-merge
 * eligibility, and the conservative default is Tier 2 (escalate). This is what keeps the loop's
 * classification legible and non-drifting instead of a per-run model judgment.
 *
 * Run: npx tsx scripts/anomaly_classifier_eval.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  classifyOutcomeAnomaly,
  isReportGradeStale,
  isSupersededGrade,
  rankSupersededGradeLast,
  refreshSupersededGrades
} from "../services/api/src/domain/anomalyClassifier.ts";

const A = (over: any) => ({ category: "state", dimension: "x", healed: false, severity: "P2", ...over });
let n = 0;
const check = (cls: any, exp: any, msg: string) => {
  for (const k of Object.keys(exp)) assert.equal(cls[k], exp[k], `${msg}: ${k} expected ${exp[k]}, got ${cls[k]}`);
  n++;
};

// --- healed: tier 0 when transient; ESCALATE when it persists (the reconcile heal has a gap). ---
check(classifyOutcomeAnomaly(A({ healed: true, dimension: "watch_active_on_closed" }), { persistent: false }),
  { tier: 0, action: "reconcile_will_heal", workOrder: false, notify: false }, "healed + transient => tier 0, no work order");
check(classifyOutcomeAnomaly(A({ healed: true, dimension: "watch_active_on_closed" }), { persistent: true }),
  { tier: 2, action: "heal_regression", workOrder: true, notify: true, autoMergeEligible: false }, "healed + PERSISTENT => escalate (heal gap)");

// --- net-new STATE contradiction (no heal yet): Tier 1 fail-safe, NOT behavioral (no Joe notify). ---
check(classifyOutcomeAnomaly(A({ category: "state", healed: false, dimension: "appointment_confirmed_no_event" })),
  { tier: 1, action: "add_invariant_or_heal", workOrder: true, notify: false, autoMergeEligible: false }, "state net-new => tier 1 invariant, no notify");

// --- graduated category flips auto-merge eligibility on (still Tier 1). ---
check(classifyOutcomeAnomaly(A({ category: "state", healed: false, dimension: "appointment_confirmed_no_event" }),
  { graduatedCategories: new Set(["appointment_confirmed_no_event"]) }),
  { tier: 1, autoMergeEligible: true }, "graduated category => auto-merge eligible");

// --- COMPREHENSION (held draft): Tier 1 parser fix, customer-facing => notify. ---
check(classifyOutcomeAnomaly(A({ category: "comprehension", healed: false, dimension: "held_draft_unresolved" })),
  { tier: 1, action: "parser_fix_candidate", workOrder: true, notify: true }, "comprehension => parser fix candidate + notify");

// --- FEEDBACK (👎): Tier 1 redraft/diagnose => notify. ---
check(classifyOutcomeAnomaly(A({ category: "feedback", healed: false, dimension: "negative_feedback" })),
  { tier: 1, action: "redraft_or_diagnose", workOrder: true, notify: true }, "feedback => redraft/diagnose + notify");

// --- Net 3 discovery (open-critic): an unconfirmed model-proposed class => ALWAYS Tier 2 escalate. ---
check(classifyOutcomeAnomaly(A({ category: "discovery", healed: false, dimension: "open_critic_finding" })),
  { tier: 2, action: "escalate", workOrder: true, notify: true, autoMergeEligible: false }, "discovery => escalate (unconfirmed new class)");
// Even if its dimension somehow graduated, a discovery never auto-merges (it's unconfirmed by construction).
check(classifyOutcomeAnomaly(A({ category: "discovery", healed: false, dimension: "open_critic_finding" }),
  { graduatedCategories: new Set(["open_critic_finding"]) } as any),
  { tier: 2, action: "escalate", autoMergeEligible: false }, "discovery never auto-merges even if graduated");

// --- Corpus replay flywheel (offline sweep): a REGRESSION or harness ERROR => Tier 2 escalate;
//     a judge-fail on a never-passed turn => Tier 1 parser fixture candidate (ladder applies). ---
check(classifyOutcomeAnomaly(A({ category: "reply", healed: false, dimension: "corpus_replay_regression" })),
  { tier: 2, action: "escalate", workOrder: true, notify: true, autoMergeEligible: false }, "corpus_replay_regression => escalate (merged change likely regressed it)");
check(classifyOutcomeAnomaly(A({ category: "reply", healed: false, dimension: "corpus_replay_error" })),
  { tier: 2, action: "escalate", workOrder: true, notify: true, autoMergeEligible: false }, "corpus_replay_error => escalate (harness diagnosis)");
check(classifyOutcomeAnomaly(A({ category: "reply", healed: false, dimension: "corpus_replay_judge_fail" })),
  { tier: 1, action: "parser_fix_candidate", workOrder: true, notify: false, autoMergeEligible: false }, "corpus_replay_judge_fail => tier 1 parser fixture candidate, ungraduated no auto-merge");
check(classifyOutcomeAnomaly(A({ category: "reply", healed: false, dimension: "corpus_replay_judge_fail" }),
  { graduatedCategories: new Set(["corpus_replay_judge_fail"]) }),
  { tier: 1, autoMergeEligible: true }, "corpus_replay_judge_fail graduates like any Tier-1 category");
// A regression NEVER auto-merges, graduated or not.
check(classifyOutcomeAnomaly(A({ category: "reply", healed: false, dimension: "corpus_replay_regression" }),
  { graduatedCategories: new Set(["corpus_replay_regression"]) }),
  { tier: 2, autoMergeEligible: false }, "corpus_replay_regression never auto-merges even if graduated");

// --- CRM/TLP update error: an integration failure => ALWAYS Tier 2 escalate, never auto-merge. ---
check(classifyOutcomeAnomaly(A({ category: "state", healed: false, dimension: "crm_update_error" })),
  { tier: 2, action: "escalate", workOrder: true, notify: true, autoMergeEligible: false }, "crm_update_error => escalate (diagnose integration)");
// Even graduated, a CRM integration error never auto-merges (the fix is a connector diagnosis).
check(classifyOutcomeAnomaly(A({ category: "state", healed: false, dimension: "crm_update_error" }),
  { graduatedCategories: new Set(["crm_update_error"]) }),
  { tier: 2, action: "escalate", autoMergeEligible: false }, "crm_update_error never auto-merges even if graduated");

// --- CRM log STALE (coverage-gap blind spot): an integration-wiring diagnosis => Tier 2 escalate. ---
check(classifyOutcomeAnomaly(A({ category: "state", healed: false, dimension: "crm_log_stale" })),
  { tier: 2, action: "escalate", workOrder: true, notify: true, autoMergeEligible: false }, "crm_log_stale => escalate (wire the auto-send path)");
check(classifyOutcomeAnomaly(A({ category: "state", healed: false, dimension: "crm_log_stale" }),
  { graduatedCategories: new Set(["crm_log_stale"]) }),
  { tier: 2, action: "escalate", autoMergeEligible: false }, "crm_log_stale never auto-merges even if graduated");

// --- conservative default: an unknown category => Tier 2 escalate. ---
check(classifyOutcomeAnomaly(A({ category: "mystery", healed: false } as any)),
  { tier: 2, action: "escalate", workOrder: true, notify: true, autoMergeEligible: false }, "unknown category => escalate");

// --- Source guards: the DETECT script uses the classifier + persistence + writes the work order. ---
const det = fs.readFileSync("scripts/anomaly_loop_detect.ts", "utf8");
assert.match(det, /classifyOutcomeAnomaly\(a, \{ persistent, graduatedCategories \}\)/, "DETECT classifies each anomaly with persistence + graduation");
assert.match(det, /reports\/anomaly_loop\/next\.json|"anomaly_loop", "next\.json"/, "DETECT writes the work order");
assert.match(det, /prevKeys\.has\(keyOf\(a\)\)/, "DETECT computes persistence vs the prior run");
assert.match(det, /stop: workOrders\.length === 0/, "DETECT emits stop:true when healthy");
n += 4;

// --- Suppression ORDER: the disposition ledger is the only non-inferential pass, so it must run
//     BEFORE the three guesses (a cutover date, a commit grep, a merged-PR window) — both so a
//     disposed finding can't be re-derived as fresh and so the costly passes see a smaller feed. ---
{
  const posDisposition = det.indexOf("partitionByDispositions(");
  const posStale = det.indexOf("suppressStaleFindings(anomalies");
  const posEcho = det.indexOf("suppressAlreadyShippedEchoes(");
  const posReproduce = det.indexOf("partitionByReproduceConfirm(");
  assert.ok(posDisposition > 0, "DETECT must run the disposition-ledger pass");
  assert.ok(posDisposition < posStale, "the disposition ledger runs before the stale-cutover guess");
  assert.ok(posDisposition < posEcho, "the disposition ledger runs before the commit-name guess");
  assert.ok(posDisposition < posReproduce, "the disposition ledger runs before the costly re-replay pass");
  // rawAnomalyCount must be captured BEFORE any suppression, or the report understates what was filtered.
  assert.ok(det.indexOf("const rawAnomalyCount") < posDisposition, "rawAnomalyCount is captured before suppression");
  n += 5;
}


// --- SUPERSEDED GRADE (2026-07-31): an offline sweep's verdict is only as current as the build it
//     graded. `occurredAt` cannot express this — the 2026-07-30 05:00Z sweep was hours old and
//     entirely superseded by the 23:49Z deploy, yet all 30 of its findings ranked top of next.json.
//     These pins hold the fail-direction: we demote ONLY on positive proof, never on uncertainty. ---
{
  assert.equal(isSupersededGrade({ gradedAtCommit: "f1b7131ace4d", deployedCommit: "cfd2c382aa11" }), true,
    "a different graded commit is superseded");
  assert.equal(isSupersededGrade({ gradedAtCommit: "cfd2c382aa11", deployedCommit: "cfd2c382aa11" }), false,
    "the same commit is not superseded");
  // Abbreviated vs full sha must still match, or every sweep would look superseded.
  assert.equal(isSupersededGrade({ gradedAtCommit: "cfd2c382", deployedCommit: "cfd2c382aa1189ff" }), false,
    "an abbreviated sha matching the deployed sha is not superseded");
  assert.equal(isSupersededGrade({ gradedAtCommit: "CFD2C382", deployedCommit: "cfd2c382aa1189ff" }), false,
    "sha comparison is case-insensitive");
  // Fail-direction: unknown is NEVER superseded, so a finding is never demoted on missing data.
  assert.equal(isSupersededGrade({ gradedAtCommit: null, deployedCommit: "cfd2c382" }), false,
    "a missing graded commit keeps full rank");
  assert.equal(isSupersededGrade({ gradedAtCommit: "cfd2c382", deployedCommit: null }), false,
    "a missing deployed commit keeps full rank");
  assert.equal(isSupersededGrade({ gradedAtCommit: "  ", deployedCommit: "cfd2c382" }), false,
    "a blank graded commit keeps full rank");
  assert.equal(isSupersededGrade({ gradedAtCommit: "abc", deployedCommit: "cfd2c382" }), false,
    "a too-short sha is not enough to judge — keep full rank");
  n += 8;

  // Ordering: superseded sorts AFTER current, and equal states are a no-op tiebreak (so the
  // existing tier/severity order is untouched for everything else).
  assert.equal(rankSupersededGradeLast({ gradeSuperseded: true }, { gradeSuperseded: false }) > 0, true,
    "superseded sorts after current");
  assert.equal(rankSupersededGradeLast({ gradeSuperseded: false }, { gradeSuperseded: true }) < 0, true,
    "current sorts before superseded");
  assert.equal(rankSupersededGradeLast({ gradeSuperseded: false }, { gradeSuperseded: false }), 0,
    "two current findings keep their prior order");
  assert.equal(rankSupersededGradeLast({}, {}), 0, "absent annotation is a no-op tiebreak");
  n += 4;
}

// --- The wiring: DETECT must ANNOTATE + RANK, and must never suppress on a superseded grade. ---
{
  const d = fs.readFileSync("scripts/anomaly_loop_detect.ts", "utf8");
  assert.match(d, /gradeSuperseded = isSupersededGrade\(/, "DETECT annotates each finding with gradeSuperseded");
  assert.match(d, /rankSupersededGradeLast\(/, "DETECT applies the superseded tiebreak to the work-order sort");
  assert.match(d, /supersededGradeCount/, "DETECT reports how many findings carry a superseded grade");
  // The tiebreak must come LAST — tier and severity still decide first.
  const sortSrc = d.slice(d.indexOf("const workOrders = classified"), d.indexOf("const byAction"));
  assert.ok(sortSrc.indexOf("TIER_RANK") < sortSrc.indexOf("rankSupersededGradeLast"), "tier outranks the grade tiebreak");
  assert.ok(sortSrc.indexOf("SEV_RANK") < sortSrc.indexOf("rankSupersededGradeLast"), "severity outranks the grade tiebreak");
  // A superseded grade must never remove a finding from the feed.
  assert.ok(!/supersededGrade[\s\S]{0,200}anomalies\.length = 0/.test(d), "a superseded grade never suppresses findings");
  n += 6;
}

// --- READ-TIME GRADE STALENESS (2026-07-31): DETECT froze `gradeSuperseded` at generation, but
//     next.json is READ for hours afterward by four routines. On 2026-07-31 DETECT ran at 08:55Z
//     (deployed === graded === e3a1e4ea), #378 deployed at 13:32Z, and at 14:39Z the feed still
//     advertised supersededGradeCount: 0 while its top three Tier-1 orders were the out-of-stock
//     dead-ends #378 had just fixed. These pins hold the read-time re-check and its fail-direction. ---
{
  // A report generated against a build that is no longer deployed is stale...
  assert.equal(isReportGradeStale({ reportDeployedCommit: "e3a1e4ea4ea2", currentDeployedCommit: "355e7c0a4912" }), true,
    "a report graded before the current deploy is stale");
  assert.equal(isReportGradeStale({ reportDeployedCommit: "355e7c0a4912", currentDeployedCommit: "355e7c0a4912" }), false,
    "a report graded against the running build is current");
  // ...and the same fail-direction as isSupersededGrade: unknown is never stale.
  assert.equal(isReportGradeStale({ reportDeployedCommit: null, currentDeployedCommit: "355e7c0a4912" }), false,
    "an unknown report commit is not proof of staleness");
  assert.equal(isReportGradeStale({ reportDeployedCommit: "355e7c0a4912", currentDeployedCommit: null }), false,
    "an unresolvable current commit never demotes real work");
  n += 4;

  // The re-annotation demotes but NEVER drops, and never re-ranks beyond the partition.
  const orders = [
    { convId: "a", tier: 2, gradedAtCommit: "e3a1e4ea4ea2" },
    { convId: "b", tier: 2, gradedAtCommit: "355e7c0a4912" },
    { convId: "c", tier: 1, gradedAtCommit: "355e7c0a4912" }
  ];
  const refreshed = refreshSupersededGrades(orders, "355e7c0a4912");
  assert.equal(refreshed.length, orders.length, "a superseded grade never removes a finding from the feed");
  assert.deepEqual(refreshed.map(o => o.convId), ["b", "c", "a"],
    "pre-deploy grades sort last; the rest keep DETECT's tier order (stable partition)");
  assert.equal(refreshed.find(o => o.convId === "a")?.gradeSuperseded, true, "the pre-deploy grade is marked");
  assert.equal(refreshed.find(o => o.convId === "b")?.gradeSuperseded, false, "a current grade is left alone");

  // Monotonic: a demotion DETECT already proved must survive an unresolvable current commit,
  // or an unreadable repo would promote verdicts about code nobody runs back to the top.
  const kept = refreshSupersededGrades([{ convId: "d", gradedAtCommit: "abc123def", gradeSuperseded: true }], null);
  assert.equal(kept[0]?.gradeSuperseded, true, "an existing superseded mark is never cleared");
  // Unknown current commit demotes nothing new.
  const untouched = refreshSupersededGrades([{ convId: "e", gradedAtCommit: "e3a1e4ea4ea2" }], null);
  assert.equal(untouched[0]?.gradeSuperseded, false, "no current commit → nothing newly demoted");
  n += 6;
}

// --- The consumer: act_runner must re-check at READ time, warn, and carry it into the brief. ---
{
  const ar = fs.readFileSync("scripts/act_runner.ts", "utf8");
  assert.match(ar, /isReportGradeStale\(/, "act_runner re-checks report staleness at read time");
  assert.match(ar, /refreshSupersededGrades\(/, "act_runner re-annotates work orders against the deployed commit");
  assert.match(ar, /rev-parse", "HEAD"/, "act_runner resolves the CURRENTLY deployed commit itself");
  // The warning must reach both the operator AND the brief the coding agent actually works from.
  assert.match(ar, /GRADE SUPERSEDED/, "the superseded state is surfaced, not silent");
  assert.match(ar, /staleBanner/, "the fix brief carries the reproduce-first warning");
  // prep --top must select from the RE-SORTED orders, or it hands over a pre-deploy verdict.
  const prepSrc = ar.slice(ar.indexOf('if (sub === "prep")'), ar.indexOf('if (sub === "open-pr")'));
  assert.match(prepSrc, /const report = loadReport\(\)/, "prep loads the staleness-aware report");
  assert.match(prepSrc, /warnIfReportStale\(report\)/, "prep warns before handing over a work order");
  // Fail-safe: read-time staleness must never suppress a finding.
  assert.ok(!/refreshSupersededGrades[\s\S]{0,300}\.filter\(\s*\w*\s*=>\s*!\w*\.gradeSuperseded/.test(ar),
    "act_runner never filters findings out on a superseded grade");
  n += 8;

  // The disposition ledger has the same generation-vs-read gap: the 13:10 tick disposed two keys
  // that were still the top Tier-1 orders in the 08:55 feed at 14:39. act_runner must re-apply it
  // at read time, reusing DETECT's pure function so the semantics cannot drift apart.
  assert.match(ar, /partitionByDispositions\(/, "act_runner re-applies the disposition ledger at read time");
  assert.match(ar, /parseDispositionLedgerPayload\(/, "act_runner reads the ledger through the shared parser");
  // Regressions must survive the read-time pass — a disposition may never eat a real regression.
  assert.match(ar, /regressionOfDisposed/, "a regression-of-disposed order stays in the queue");
  const ledgerSrc = ar.slice(ar.indexOf("function applyLedgerAtReadTime"), ar.indexOf("function loadReport"));
  assert.match(ledgerSrc, /part\.regressions/, "read-time ledger keeps regressions rather than dropping them");
  // Fail-direction: an unreadable or absent ledger suppresses NOTHING.
  assert.equal((ledgerSrc.match(/return \{ kept: orders, suppressed: 0, regressions: 0 \}/g) ?? []).length, 3,
    "a missing, unparseable, or empty ledger keeps every work order");
  n += 5;
}

// --- The producer: the flywheel must stamp the commit it graded, and omit it when unknown. ---
{
  const fw = fs.readFileSync("scripts/corpus_replay_flywheel.ts", "utf8");
  assert.match(fw, /gradedAtCommit\?: string/, "FlywheelFinding carries the graded commit");
  assert.match(fw, /buildFindings\(scores, confirmedRegressions, atIso, flag\("graded-at-commit"\)\)/,
    "the flywheel passes the graded commit through from its flag");
  const ny = fs.readFileSync("scripts/corpus_replay_nightly.ts", "utf8");
  assert.match(ny, /"--graded-at-commit", headCommit/, "the nightly stamps the deployed commit it replayed against");
  n += 3;
}

console.log(`PASS anomaly classifier eval (${n} assertions)`);
