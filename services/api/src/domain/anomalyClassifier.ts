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

export function classifyOutcomeAnomaly(
  anomaly: Pick<OutcomeAnomaly, "category" | "dimension" | "healed" | "severity">,
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
