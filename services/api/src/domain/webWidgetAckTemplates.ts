/**
 * Approved static ack templates for web-text-widget leads (AGENTS.md fallback policy:
 * a deterministic customer-facing fallback must be a NAMED approved template — never
 * regex-derived semantics). These are the "never go silent" acks for widget leads when
 * the LLM ack/draft path produces nothing.
 *
 * NO immediate-reply promise (Tom Bradsky +16054313150, 2026-07-04): a Parts web form
 * submitted mid-day on the July 4 holiday got the old template's "they'll text you
 * right back" — staff had to hand-edit the draft to "they'll text you back on Monday"
 * before sending (human_correction_material). The store can't keep an immediate-reply
 * promise made after hours, on holidays, or when the department is slammed, so these
 * templates commit to following up "as soon as they/I can" — always true, still warm.
 * Same reasoning applies to Sundays (store closed) and evening submissions.
 *
 * Fail direction: these fire only as fallbacks, and they fail toward a safe warm reply
 * (never silence, never a fabricated answer, and never a timing promise we may break).
 * Shared by BOTH the live /webhooks path and /conversations/:id/regenerate so the two
 * paths can't drift (route-parity law).
 */

/** Non-sales (Parts/Service/Apparel) department handoff ack — the static fallback
 * behind buildDepartmentHandoffAckWithLLM. */
export function buildDeptHandoffAckFallback(args: {
  firstName?: string | null;
  deptLabel?: string | null;
}): string {
  const firstName = String(args.firstName ?? "").trim();
  const deptLabel = String(args.deptLabel ?? "").trim() || "team";
  return `Hi ${firstName || "there"} — thanks for reaching out to our ${deptLabel} team. I've passed your message along and they'll get back to you as soon as they can.`;
}

/** Sales web-widget "never leave silence" ack — fires when no substantive draft was
 * built (e.g. a used unit with no posted price). Never guesses a price. */
export function buildWebTextWidgetSalesAckFallback(args: {
  firstName?: string | null;
  year?: unknown;
  model?: unknown;
}): string {
  const firstName = String(args.firstName ?? "").trim();
  const label = [String(args.year ?? "").trim(), String(args.model ?? "").trim()]
    .filter(Boolean)
    .join(" ")
    .trim();
  const lead = label ? `the ${label}` : "that";
  return `Hi ${firstName || "there"} — thanks for reaching out about ${lead}. Let me look into that for you and I'll get back to you as soon as I can.`;
}
