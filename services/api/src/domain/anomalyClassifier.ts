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
