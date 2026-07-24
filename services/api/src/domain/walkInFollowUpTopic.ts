/**
 * Traffic Log Pro walk-in follow-up topic guard.
 *
 * A TLP ADF "Inquiry" field is frequently an INTERNAL staff log written ABOUT the customer
 * ("gave him trade in value on his 2018 Heritage that was here for inspection ($8000) (Step 2)"),
 * not a customer-stated follow-up topic. `extractTrafficLogProFollowUpTopic` lifts a topic out of
 * that field via an `about/on/with/regarding X` regex and the walk-in tail drops it verbatim into
 * the customer's FIRST text — which parroted an internal appraisal figure and third-person notes
 * back to the customer (+17168638237, 2026-07-22; the generated draft read "…I'll follow up about
 * his 2018 Heritage that was here for inspection ($8000)").
 *
 * This is a deterministic OUTPUT-safety guard (AGENTS.md: invariant/safety gates may be
 * deterministic — this never reads customer INTENT, it refuses to echo staff-log text). When the
 * extracted topic reads like an internal note — a dollar appraisal figure, a third-person reference
 * to the customer, or an internal-process phrase (appraisal / here-for-inspection / trade-in value /
 * "gave him") — reject it so the tail falls back to the generic "Thanks for stopping in today" line.
 * Fail-direction is safe: worst case we drop a legitimate topic and send the warm generic line; we
 * never leak internal specifics into a customer-facing message. Pinned by
 * walkin_internal_note_topic_guard:eval.
 */
export function isInternalNoteFollowUpTopic(topic: string | null | undefined): boolean {
  const raw = String(topic ?? "").trim();
  if (!raw) return false;
  const t = raw.toLowerCase();
  // A specific dollar figure — an internal appraisal/price, never echoed in a first-touch.
  if (/\$\s?\d/.test(raw)) return true;
  // Third-person reference to the customer — staff writing ABOUT them ("his 2018 Heritage").
  // A customer naming their OWN follow-up topic would not say "his/her".
  if (/\b(?:his|him|her|hers)\b/.test(t)) return true;
  // Internal-process phrasing a customer wouldn't use to name their own follow-up topic.
  if (
    /\bhere for inspection\b|\bfor inspection\b|\btrade[- ]?in value\b|\bapprais(?:al|ed|e)\b|\bgave (?:him|her|them)\b/.test(
      t
    )
  ) {
    return true;
  }
  return false;
}
