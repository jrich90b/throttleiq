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
/**
 * Repeat the walk-in's SPEC back to the customer (Joe ruling 2026-07-28 — Larry Godzich
 * +17164327329, 2026-07-27).
 *
 * Scott's Traffic Log Pro note read "Was in for the Back the Blue ride and was asking about
 * pre-owned trikes… Is looking for 2017-2020 Tri Glide in the $25,000 range (Step 2)", and the
 * whole first text back was "Thanks for stopping in today - I'll follow up about pre-owned
 * trikes." It was the day's only tone failure (65, intent_mismatch) — fluent, on-topic, and
 * blind to everything the salesperson actually wrote down.
 *
 * Built ONLY from the STRUCTURED slots the walk-in path already extracted (condition, year
 * range, model) — never from the note prose. That is the whole point of the guard below: a TLP
 * inquiry field is an internal staff log, so anything echoed to the customer has to come from a
 * parsed slot, not the sentence around it.
 *
 * The BUDGET is deliberately omitted even though it is extracted. A dollar figure in a walk-in
 * note is as likely to be a trade APPRAISAL as the customer's budget (the +17168638237 draft
 * that started this module parroted "($8000)" back), and no year/model recap is worth
 * re-opening that. Model and years are enough to prove we heard them.
 *
 * FAIL DIRECTION: purely additive copy that promises nothing — no watch, no callback, no
 * booking. With no model it returns "" and the tail is exactly today's line. Pinned by
 * walkin_internal_note_topic_guard:eval.
 */
export function buildWalkInSpecRecapClause(input: {
  modelLabel?: string | null;
  yearLabel?: string | null;
  condition?: "new" | "used" | null;
}): string {
  const model = String(input.modelLabel ?? "").trim();
  if (!model) return "";
  const years = String(input.yearLabel ?? "").trim();
  const condition = input.condition === "new" ? "new" : input.condition === "used" ? "pre-owned" : "";
  // Nothing beyond the model itself to confirm — the existing tail already names it.
  if (!years && !condition) return "";
  const spec = [condition, years, model].filter(Boolean).join(" ");
  return `Just so I've got it right — you're looking for a ${spec}.`;
}

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
