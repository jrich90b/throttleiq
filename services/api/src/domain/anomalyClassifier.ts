/**
 * Anomaly CLASSIFIER — the "C" in the self-healing loop's DETECT → CLASSIFY → ACT
 * (docs/autonomous_coding_loop.md). Pure, deterministic: given one OutcomeAnomaly (from the unified
 * feed), decide its TIER + the action shape + whether it's auto-merge-eligible + whether Joe must be
 * notified. This is the AGENTS.md "Autonomous Self-Healing Loop" tier contract expressed as code, so the
 * classification is legible and eval-pinned rather than a judgment the model re-derives each run.
 *
 * Graduated autonomy: `autoMergeEligible` is false unless the anomaly's category has EARNED auto-merge
 * (passed in via graduatedCategories) — so v1 opens a PR + (when needed) notifies for everything; a
 * category flips to auto-merge only after its clean track record. The `ci:eval` gate is non-negotiable
 * regardless.
 *
 * Deterministic classification (no customer intent); read-only.
 */
import type { OutcomeAnomaly } from "./conversationOutcomeAudit.js";

export type AnomalyAction =
  | "reconcile_will_heal" // tier 0 — the 60s reconcile tick repairs it; no work order
  | "heal_regression" // a `healed` dimension that PERSISTED across runs — the heal has a gap (reviewed code fix)
  | "add_invariant_or_heal" // tier 1 — net-new STATE contradiction → fail-safe write-time guard / reconcile heal
  | "parser_fix_candidate" // tier 1 — COMPREHENSION miss → additive parser few-shot + replay fixture
  | "redraft_or_diagnose" // tier 1 — FEEDBACK (👎) → redraft; if recurring, a parser-first fix
  | "escalate"; // tier 2 — behavioral / judgment / unknown → PR + notify, never auto-merge

export type AnomalyClassification = {
  tier: 0 | 1 | 2;
  action: AnomalyAction;
  workOrder: boolean; // needs orchestrator action (false = reconcile auto-handles it)
  autoMergeEligible: boolean; // graduated autonomy — false unless the category has earned it
  notify: boolean; // surface to Joe — a behavioral/judgment call (Tier 2, comprehension, feedback)
  rationale: string;
};

/**
 * Stale-finding suppressor — the "never re-fix a ghost" guard for the anomaly feed.
 *
 * A detector keeps surfacing a finding until its triggering event ages out of the detector window —
 * even after the root cause is FIXED and DEPLOYED (a pre-fix send can never be retroactively logged; a
 * pre-fix draft was already replaced). Those stale findings inflate the work order and cost real triage
 * time (2026-06-30: all 23 crm_log_stale findings were pre-fix sends; the +17167506588 scheduling
 * cluster was already fixed by 6fb77dd2). This mirrors auto_loop_next_task's GUARDED_CHECK_EVALS — "a
 * check guarded by an eval in ci:eval is presumed fixed; remaining findings are historical."
 *
 * A finding is suppressed ONLY when ALL three hold (ANY uncertainty KEEPS it — fail-safe; we never hide
 * a finding we aren't sure is stale):
 *   1. its dimension is in the explicit DIMENSION_FIX_CUTOVERS ledger, AND
 *   2. that dimension's guarding eval is present in ci:eval (proves the fix is in the shipped code), AND
 *   3. the finding carries an occurredAt STRICTLY BEFORE the fix's commit date (provably pre-fix code;
 *      the commit→deploy window and anything after is KEPT — it may be a real post-fix regression).
 */
export type FixCutover = {
  eval: string; // the ci:eval entry that guards this dimension's fix
  committedAt: string; // ISO date the fix LANDED in main; events strictly before it are provably pre-fix
  commit?: string;
  note?: string;
};

// Ledger of dimensions whose root cause is fixed + eval-guarded. Add an entry ONLY when the fix is
// merged to main WITH an eval wired into ci:eval. Use the fix's COMMIT date (conservative: anything
// strictly before is provably pre-fix code; the commit→deploy window is kept, not suppressed).
export const DIMENSION_FIX_CUTOVERS: Record<string, FixCutover> = {
  crm_log_stale: {
    eval: "tlp_autosend_coverage:eval",
    committedAt: "2026-06-29",
    commit: "10b341fa",
    note: "auto-send paths wired to TLP logging (queueTlpLogForConversation)"
  }
};

export type StaleSuppression = { anomaly: OutcomeAnomaly; reason: string };
export type StaleSuppressionResult = { kept: OutcomeAnomaly[]; suppressed: StaleSuppression[] };

export function suppressStaleFindings(
  anomalies: OutcomeAnomaly[],
  opts: { guardingEvals: ReadonlySet<string>; cutovers?: Record<string, FixCutover> }
): StaleSuppressionResult {
  const cutovers = opts.cutovers ?? DIMENSION_FIX_CUTOVERS;
  const kept: OutcomeAnomaly[] = [];
  const suppressed: StaleSuppression[] = [];
  for (const a of anomalies) {
    const cut = cutovers[String(a?.dimension ?? "")];
    if (!cut) {
      kept.push(a);
      continue; // dimension not in the ledger → keep
    }
    if (!opts.guardingEvals.has(cut.eval)) {
      kept.push(a);
      continue; // the fix is not proven in ci:eval (could be reverted) → keep
    }
    const eventMs = Date.parse(String(a?.occurredAt ?? ""));
    const cutMs = Date.parse(String(cut.committedAt));
    if (!Number.isFinite(eventMs) || !Number.isFinite(cutMs)) {
      kept.push(a);
      continue; // no resolvable event time → can't prove stale → keep
    }
    if (eventMs < cutMs) {
      suppressed.push({
        anomaly: a,
        reason: `stale: ${a.dimension} event ${a.occurredAt} predates fix ${cut.commit ?? cut.committedAt} (${cut.eval})`
      });
    } else {
      kept.push(a); // on/after the fix commit → could be a real post-fix regression → keep
    }
  }
  return { kept, suppressed };
}

// A fix commit on origin/main whose message NAMES a case (phone/customer/ticket). dateMs = commit date.
export type NamingCommit = { hash: string; subject: string; dateMs: number };

// Dimensions whose detector grades a FROZEN stored transcript (a past draft/reply/replay) — the record
// never changes, so a finding re-fires on every run even after its per-case fix ships, once that fix ages
// out of the 14-day merged-PR-ledger window (loopPrDedup). Only these are echo-suppressible. Operator/
// human signals (reported_issue, thumbs_down_action_request) are deliberately EXCLUDED: a commit naming
// the customer doesn't prove the operator's latest note is stale — a person may be reporting something new.
export const ECHO_SUPPRESSIBLE_DIMENSIONS: ReadonlySet<string> = new Set([
  "human_correction_material",
  "corpus_replay_judge_fail"
]);

/**
 * Already-shipped echo suppressor — the PERMANENT complement to the 14-day merged-PR-ledger window.
 *
 * WHY (2026-07-18): the PR-ledger dedup (loopPrDedup) stops suppressing a finding 14 days after its fix
 * PR merges (fail toward surfacing — a bug that reappears weeks later may be a regression). But the
 * frozen-transcript detectors above grade a record that never changes, so once that window lapses the
 * SAME already-shipped ghost re-fires forever (+12282200201 poker-chip → apparel, fixed by #148 on 7/2,
 * re-surfaced 7/18 with a pinned passing eval). This closes that gap without weakening regression
 * detection: it suppresses ONLY when a commit that NAMES the case landed STRICTLY AFTER the flagged event
 * — a genuine post-fix regression has a NEW event dated after the commit, so it is never hidden.
 *
 * Pure: the git-grep IO (commits naming a case) is injected via namingCommitsFor so this stays eval-pinned.
 * Fail-safe: no occurredAt, no naming commit, or the only naming commits predate the event → KEEP.
 */
export function suppressAlreadyShippedEchoes(
  anomalies: OutcomeAnomaly[],
  opts: { namingCommitsFor: (a: OutcomeAnomaly) => NamingCommit[]; dimensions?: ReadonlySet<string> }
): StaleSuppressionResult {
  const dims = opts.dimensions ?? ECHO_SUPPRESSIBLE_DIMENSIONS;
  const kept: OutcomeAnomaly[] = [];
  const suppressed: StaleSuppression[] = [];
  for (const a of anomalies) {
    if (!dims.has(String(a?.dimension ?? ""))) {
      kept.push(a);
      continue; // out of scope → keep
    }
    const eventMs = Date.parse(String(a?.occurredAt ?? ""));
    if (!Number.isFinite(eventMs)) {
      kept.push(a);
      continue; // no event time → can't prove the graded reply predates a fix → keep
    }
    const naming = (opts.namingCommitsFor(a) ?? [])
      .filter(c => Number.isFinite(c.dateMs) && c.dateMs > eventMs)
      .sort((x, y) => x.dateMs - y.dateMs)[0];
    if (naming) {
      suppressed.push({
        anomaly: a,
        reason: `already shipped: ${a.dimension} event ${a.occurredAt} predates naming fix ${naming.hash} "${naming.subject}" (${new Date(naming.dateMs).toISOString()})`
      });
    } else {
      kept.push(a); // no commit names this case after the event → keep (may be live / a new regression)
    }
  }
  return { kept, suppressed };
}

export function classifyOutcomeAnomaly(
  anomaly: Pick<
    OutcomeAnomaly,
    "category" | "dimension" | "healed" | "severity" | "correctedSendWasProactive"
  >,
  opts: { persistent?: boolean; graduatedCategories?: Set<string> } = {}
): AnomalyClassification {
  const graduated = opts.graduatedCategories?.has(anomaly.dimension) ?? false;

  // An OPERATOR-REPORTED issue (a rep clicked "Report issue" with a note) is an explicit human
  // judgment call across ANY turn dimension (routing/cadence/appointment/task/handoff/other). It is
  // the strongest "this was wrong + here's why" signal, but it's unconfirmed by construction and the
  // fix could be behavioral — so it is ALWAYS Tier 2 (escalate, notify, never auto-merge): the loop
  // drafts an approve-first PR using the operator's note as the fix steering, the operator merges.
  if (anomaly.dimension === "reported_issue") {
    return {
      tier: 2,
      action: "escalate",
      workOrder: true,
      autoMergeEligible: false,
      notify: true,
      rationale: "operator-reported issue (carries the note) → diagnose + approve-first PR; never auto-merge"
    };
  }

  // A thumbs-down NOTE that turned out to be a STAFF INSTRUCTION for a live customer ("book him in at
  // 9:30", "tell him we have the muffler") — not a code defect. Nothing to fix in the agent; a PERSON
  // must act. Always Tier 2, notify, never a code change: it lands in the morning digest's staff-action
  // lane so the customer stops waiting. (decideThumbsDownNoteRouting = staff_action.)
  if (anomaly.dimension === "thumbs_down_action_request") {
    return {
      tier: 2,
      action: "escalate",
      workOrder: true,
      autoMergeEligible: false,
      notify: true,
      rationale: "thumbs-down note is a staff instruction for a live customer → surface to a human; not a code fix"
    };
  }

  // CRM (TLP) integration anomalies. crm_update_error = a Playwright/browser-automation FAILURE
  // (selector drift, login, launch timeout) that left the dealer's CRM stale. crm_log_stale = a real
  // send that never even ATTEMPTED a CRM log (an auto-send path not wired to the logger) — the
  // coverage-gap blind spot. Both are INTEGRATION-wiring diagnoses, NOT parser few-shots and NOT
  // reconcile heals, and never an auto-mergeable code change → ALWAYS Tier 2 (escalate, notify, never
  // auto-merge): the loop opens an approve-first PR (or surfaces the runtime cause), the operator decides.
  // Corpus replay flywheel findings (offline sandbox sweep of the deployed code). A REGRESSION
  // (a turn that previously passed, failing on a materially changed draft) means a merged change
  // broke customer-facing behavior — always Tier 2, escalate + notify (rollback is a judgment
  // call). A judge-major miss on a never-passed turn is a comprehension-gap candidate: Tier 1
  // parser_fix_candidate (fixture/few-shot work), auto-merge only via the category ladder like
  // every other Tier-1 class. A replay ERROR is harness/integration diagnosis — Tier 2.
  if (anomaly.dimension === "corpus_replay_regression" || anomaly.dimension === "corpus_replay_error") {
    return {
      tier: 2,
      action: "escalate",
      workOrder: true,
      autoMergeEligible: false,
      notify: true,
      rationale:
        anomaly.dimension === "corpus_replay_regression"
          ? "offline sweep: a previously-passing turn now fails on a changed draft — a merged change likely regressed it; diagnose + approve-first"
          : "offline sweep errored on this turn — harness/integration diagnosis, never auto-merge"
    };
  }
  if (anomaly.dimension === "corpus_replay_judge_fail") {
    return {
      tier: 1,
      action: "parser_fix_candidate",
      workOrder: true,
      autoMergeEligible: graduated,
      notify: false,
      rationale: "offline sweep: judged wrong-intent/unaddressed draft — parser fixture/few-shot candidate (graduated ladder applies)"
    };
  }

  if (anomaly.dimension === "crm_update_error" || anomaly.dimension === "crm_log_stale") {
    const why =
      anomaly.dimension === "crm_log_stale"
        ? "a real send was not logged to CRM with no failure recorded → wire the auto-send path to the TLP logger"
        : "CRM/TLP Playwright update failed → diagnose the integration (selector drift / login / timeout)";
    return {
      tier: 2,
      action: "escalate",
      workOrder: true,
      autoMergeEligible: false,
      notify: true,
      rationale: `${why}; approve-first, never auto-merge`
    };
  }

  // MDF assistant (Ansira co-op portal runner) failures — the Playwright/CDP runner blocked, hung, or
  // fell back because the portal didn't load. Like the CRM cases this is an INTEGRATION/ops diagnosis
  // (ansira-form-sync selector resync / restart the CDP Chrome / re-login the H-DNet session), never a
  // parser fix or auto-heal → ALWAYS Tier 2 (escalate, notify, never auto-merge).
  if (anomaly.dimension === "mdf_assistant_failure" || anomaly.dimension === "mdf_assistant_stuck") {
    return {
      tier: 2,
      action: "escalate",
      workOrder: true,
      autoMergeEligible: false,
      notify: true,
      rationale:
        "MDF assistant (Ansira portal runner) failed/stuck → diagnose the integration (form change → ansira-form-sync / CDP Chrome down / H-DNet session expired); approve-first, never auto-merge"
    };
  }

  // Google credential expiry (calendar / support mail / personal mail). Like the MDF and CRM cases this
  // is an INTEGRATION/ops action — re-consent, and then publish the OAuth app (or move to a service
  // account with domain-wide delegation) so 7-day refresh tokens stop killing it weekly. It CANNOT be
  // auto-fixed: re-consent requires a human signed into Google, so an auto-merge could never resolve it.
  // Always Tier 2. Worth surfacing loudly — these sat dead for ~8 weeks precisely because nothing did.
  if (
    anomaly.dimension === "google_integration_expired" ||
    anomaly.dimension === "google_integration_expiring" ||
    anomaly.dimension === "google_integration_disconnected"
  ) {
    return {
      tier: 2,
      action: "escalate",
      workOrder: true,
      autoMergeEligible: false,
      notify: true,
      rationale:
        "Google credentials expired/expiring → a human must re-consent (/integrations/google/start); permanent fix is publishing the OAuth app or a service account with domain-wide delegation. Approve-first, never auto-merge"
    };
  }

  // A `healed` dimension that re-appears across runs means the reconcile heal isn't actually fixing it —
  // a gap in the heal logic (e.g. the single/array inventory-watch leak the loop caught 6/25). That's a
  // reviewed code fix, not a transient → escalate. Seen once, it's just the tick that hasn't run yet.
  if (anomaly.healed) {
    if (opts.persistent) {
      return {
        tier: 2,
        action: "heal_regression",
        workOrder: true,
        autoMergeEligible: false,
        notify: true,
        rationale: `${anomaly.dimension} persists despite a reconcile heal — the heal has a gap; needs a reviewed code fix`
      };
    }
    return {
      tier: 0,
      action: "reconcile_will_heal",
      workOrder: false,
      autoMergeEligible: false,
      notify: false,
      rationale: `${anomaly.dimension} is repaired by the 60s reconcile tick; no work order`
    };
  }

  switch (anomaly.category) {
    case "state":
      // A net-new STATE contradiction with no heal yet → a fail-safe write-time guard / reconcile heal.
      // Deterministic + fail-direction-safe = Tier 1, not behavioral → no Joe notify.
      return {
        tier: 1,
        action: "add_invariant_or_heal",
        workOrder: true,
        autoMergeEligible: graduated,
        notify: false,
        rationale: `net-new state contradiction (${anomaly.dimension}) → fail-safe write-time guard / reconcile heal`
      };
    case "comprehension":
      // A staff correction to an UNPROMPTED send is not a comprehension miss: there was no customer
      // turn in front of the draft to parse. Steering it as "add a parser few-shot" sends the loop
      // hunting a parser that cannot exist — on +17164368801 the corrected text was a cadence-ladder
      // template fired 25s after a live call, and the real fix was a post-call cadence breather
      // (#229). Same tier/action ladder (still a Tier-1 comprehension work order), corrected steering.
      if (anomaly.dimension === "human_correction_material" && anomaly.correctedSendWasProactive === true) {
        return {
          tier: 1,
          action: "parser_fix_candidate",
          workOrder: true,
          autoMergeEligible: graduated,
          notify: true,
          rationale: `${anomaly.dimension} on a PROACTIVE send (no customer turn behind the draft) → fix the proactive copy or what GATED the send (cadence ladder / trigger), NOT a parser few-shot; not reply-draft reproducible`
        };
      }
      // The draft judge HELD this turn and persisted its diagnosis (frame + steering) → an additive
      // parser few-shot + replay fixture. Customer-facing → notify Joe even as a Tier-1 candidate.
      return {
        tier: 1,
        action: "parser_fix_candidate",
        workOrder: true,
        autoMergeEligible: graduated,
        notify: true,
        rationale: `${anomaly.dimension} → additive parser few-shot + replay fixture (held verdict carries the fix steering); customer-facing → notify`
      };
    case "feedback":
      return {
        tier: 1,
        action: "redraft_or_diagnose",
        workOrder: true,
        autoMergeEligible: graduated,
        notify: true,
        rationale: `${anomaly.dimension} → redraft + diagnose; if the class recurs, a parser-first fix`
      };
    case "discovery":
      // Net 3 open-critic finding — a model-proposed gap class we have NO detector for yet. It is
      // UNCONFIRMED by construction, so ALWAYS escalate (Tier 2, notify, never auto-merge): Joe confirms
      // the class, then it earns a real detector + eval. This is how unknown-unknowns enter the loop.
      return {
        tier: 2,
        action: "escalate",
        workOrder: true,
        autoMergeEligible: false,
        notify: true,
        rationale: `${anomaly.dimension} → open-critic discovery (unconfirmed new class) → escalate for review, then turn into a detector + eval`
      };
    default:
      // Unknown shape → the conservative default is Tier 2 (escalate). Never auto-act on something we
      // can't classify.
      return {
        tier: 2,
        action: "escalate",
        workOrder: true,
        autoMergeEligible: false,
        notify: true,
        rationale: "unknown anomaly category → escalate (conservative default)"
      };
  }
}

/**
 * Was this finding graded against code that has since been replaced?
 *
 * WHY (2026-07-31 loop tick): the corpus-replay flywheel measures the DEPLOYED build, but its
 * findings only carry `occurredAt` — the time the sweep RAN, which says nothing about the code
 * version it judged. On 2026-07-30 the 05:00Z sweep graded commit f1b7131a; by 23:49Z that day
 * 29 commits had merged AND deployed (incl. #360, which fixes one of the very turns the sweep
 * flagged). All 30 replay findings still ranked at the TOP of next.json as fresh Tier-1/2 work,
 * so every routine re-triaged verdicts rendered against code nobody is running. `occurredAt`
 * cannot express this: the sweep is genuinely recent, its VERDICT is not.
 *
 * This does NOT suppress — a superseded grade is unproven, not disproven, and most such findings
 * are real. It only marks the verdict as untrustworthy so ranking can prefer findings measured
 * against what is actually running (see rankSupersededGradeLast).
 *
 * Fail-direction (toward surfacing): unknown is never superseded. A missing/blank grade commit,
 * a missing deployed commit, or equal commits → false → the finding keeps its full rank. We only
 * demote when we can positively prove the grade is stale.
 */
export function isSupersededGrade(input: {
  gradedAtCommit?: string | null;
  deployedCommit?: string | null;
}): boolean {
  const graded = String(input?.gradedAtCommit ?? "").trim();
  const deployed = String(input?.deployedCommit ?? "").trim();
  if (!graded || !deployed) return false;
  // Compare on the shorter length so an abbreviated sha and a full sha still match.
  const n = Math.min(graded.length, deployed.length);
  if (n < 7) return false; // too short to identify a commit — refuse to judge
  return graded.slice(0, n).toLowerCase() !== deployed.slice(0, n).toLowerCase();
}

/**
 * Sort comparator fragment: within an otherwise equal rank, a finding whose grade is superseded
 * sorts AFTER one graded against the running code. Returns 0 when both agree, so callers can chain
 * it behind their existing tier/severity keys without changing any other ordering.
 */
export function rankSupersededGradeLast(
  a: { gradeSuperseded?: boolean | null },
  b: { gradeSuperseded?: boolean | null }
): number {
  return Number(Boolean(a?.gradeSuperseded)) - Number(Boolean(b?.gradeSuperseded));
}

/**
 * Was the WHOLE report graded against a build that is no longer deployed?
 *
 * WHY (2026-07-31 loop tick): isSupersededGrade above closed the sweep→DETECT gap, but the very
 * same hole reopens between DETECT and READ. next.json is generated ONCE and then consumed for
 * hours by four routines (the 2h loop, agent-watch 9:07, anomaly-review 10:30, morning 7:30).
 * Today DETECT ran at 08:55Z when deployed === graded === e3a1e4ea, froze `gradeSuperseded: false`
 * onto every order, and #378 then deployed at 13:32Z. At 14:39Z the feed still advertised
 * `supersededGradeCount: 0` while its top three Tier-1 orders were the out-of-stock dead-ends #378
 * had just fixed — two of them (08610167776, +16785960725) named in #378's own commit message.
 *
 * A frozen `false` is worse than no annotation at all: it reads as positive proof the verdict is
 * current. So consumers must re-evaluate against the commit deployed NOW, not the one recorded at
 * generation time.
 *
 * Fail-direction (toward surfacing, identical to isSupersededGrade): unknown is never stale, so an
 * unresolvable commit on either side leaves the report at full trust rather than demoting real work.
 */
export function isReportGradeStale(input: {
  reportDeployedCommit?: string | null;
  currentDeployedCommit?: string | null;
}): boolean {
  return isSupersededGrade({
    gradedAtCommit: input?.reportDeployedCommit,
    deployedCommit: input?.currentDeployedCommit
  });
}

/**
 * Re-annotate work orders at READ time against the currently deployed commit, then float the
 * still-current findings to the top.
 *
 * Monotonic on purpose: a grade DETECT already proved superseded stays superseded even if the
 * current commit can't be resolved now. We only ever add the demotion, never clear one — clearing
 * would promote a verdict about code nobody runs back to the top of somebody's work queue.
 *
 * The sort key is ONLY the superseded tiebreak. Array#sort is stable, so DETECT's tier/severity
 * ordering survives untouched inside each partition; this re-partitions, it does not re-rank. And
 * as everywhere else in this file: nothing is suppressed — a superseded grade is unproven, not
 * disproven, so the finding stays in the feed, just below work measured against the running build.
 */
export function refreshSupersededGrades<
  T extends { gradedAtCommit?: string | null; gradeSuperseded?: boolean | null }
>(orders: readonly T[], currentDeployedCommit?: string | null): T[] {
  return (orders ?? [])
    .map(o => ({
      ...o,
      gradeSuperseded:
        Boolean(o?.gradeSuperseded) ||
        isSupersededGrade({ gradedAtCommit: o?.gradedAtCommit, deployedCommit: currentDeployedCommit })
    }))
    .sort(rankSupersededGradeLast);
}
