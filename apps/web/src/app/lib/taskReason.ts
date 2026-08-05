// Sales-critical task reasons — the money tasks (a customer asking price, financing,
// or availability is a hot buy signal). We surface these as a color-coded reason badge
// + a priority accent so they pop in the Task Inbox and the conversation list.
//
// Keyed on the backend's STRUCTURED signals — the task `reason` (pricing / payments /
// approval / manager …) and the backend-derived `action` label — NOT raw customer text,
// so this stays in the structured-extraction lane. Fail-direction is cosmetic: a wrong
// badge only mis-colors a task, it never changes a customer reply.

export type SalesCriticalKind = "pricing" | "financing" | "availability";

const PRICING_RE = /\b(pricing|price|quote|out[- ]?the[- ]?door|otd|msrp)\b/i;
const FINANCING_RE =
  /\b(financ\w*|credit|prequal|pre-?qual|apr|payment options?|monthly payment|hdfs|business manager|down payment|lease|loan)\b/i;
const AVAILABILITY_RE = /\b(availab\w*|in[- ]?stock|inventory|on the lot)\b/i;

// Internal "review a blocked/held draft" tasks are NOT customer buy-signals — they're a system prompt
// for a rep to review the agent's OWN draft. Their summaries frequently borrow inventory/pricing words
// from a guard name (e.g. "unsupported_inventory_hold_promise_guard" -> action "Verify inventory and
// follow up"), which would otherwise mis-badge them as a hot customer availability/pricing request and
// pollute the sales-critical priority rail. (Armando Cortes, 2026-06-24: a guard-blocked dealer-ride-
// outcome review task was badged "Availability".)
const INTERNAL_REVIEW_RE =
  /(draft guard blocked|before sending|couldn'?t answer this in context|being fixed)/i;

export function salesCriticalKind(todo: any): SalesCriticalKind | null {
  // A system review/held-draft task is never a customer buy-signal — don't sales-badge it.
  if (INTERNAL_REVIEW_RE.test(String(todo?.summary ?? ""))) return null;
  const reason = String(todo?.reason ?? "").toLowerCase();
  // `action` is the backend-derived label (deriveTodoActionLabel), not raw customer text.
  const text = `${reason} ${String(todo?.action ?? "")}`.toLowerCase();
  if (reason === "pricing" || PRICING_RE.test(text)) return "pricing";
  // reason "manager" is a generic escalate-to-a-human, NOT a finance signal by itself —
  // Jessica Ornce (+17167134728, operator-reported 2026-07-09 "Why does this have financing
  // task?") had a TRADE-review manager task badged Financing purely because of its reason.
  // A manager task still badges financing when its text actually carries finance signals
  // (FINANCING_RE below); approval/payments stay unconditional (they ARE finance tasks).
  if (reason === "approval" || reason === "payments" || FINANCING_RE.test(text)) {
    return "financing";
  }
  if (AVAILABILITY_RE.test(text)) return "availability";
  // Parser-first fallback (Phase 3): when reason/action carry no signal, trust the backend's
  // salesTopicHint — the lead's PARSED classification CTA (request_a_quote / check_availability),
  // structured data, not text guessing. Covers the cadence-"call"-on-a-quote-lead miss
  // (+17169306602, operator-reported "Follow up task should be tagged with pricing").
  // Never applied to bookkeeping notes — a notice on a quote lead is not a buy signal.
  if (reason !== "note") {
    const hint = String(todo?.salesTopicHint ?? "");
    if (hint === "pricing" || hint === "financing" || hint === "availability") {
      return hint as SalesCriticalKind;
    }
  }
  return null;
}

/**
 * Does this task demand a FINANCE disposition — i.e. does its "Close" button become
 * "Outcome" and open the "Resolve Finance To Do" modal?
 *
 * Unlike salesCriticalKind above, whose fail-direction is cosmetic, this one changes what
 * the button DOES, so it is deliberately stricter about what counts as evidence: it reads
 * the task's `reason` and its `summary` (the promise/ask as it was actually recorded) and
 * NEVER the backend-derived `action` label.
 *
 * Curran Terblanche (+13105956498, operator-reported 2026-08-04 12:59Z: "This creates a
 * finance outcome when it was not a finance lead"). No finance signal existed anywhere on
 * that lead. The task was "Promised over text: check current availability, pricing, and
 * similar options" — and it became a finance task in two hops of our OWN words:
 *   1. deriveTodoActionLabel's inventory arm tests `check stock`/`inventory`/`verify`, so
 *      "check current availability" misses it and falls through to the pricing arm =>
 *      action "Provide pricing or payment details."
 *   2. this predicate then matched `\bpayment\b` — on the label WE just derived.
 * A derived label is our own words; a classifier that reads it is treating a regex's
 * output as if it were evidence. Same class as the reason-"manager" fix in
 * salesCriticalKind (Jessica Ornce +17167134728, Joe ruling 2026-07-09) — that one landed
 * on the BADGE only and never reached this predicate.
 *
 * FAIL DIRECTION: a false negative offers a plain "Close" on a genuine finance task (staff
 * still have the Update Lead… finance flow); a false positive demands a finance
 * disposition on a lead that never discussed money — the reported defect. So this fails
 * toward NOT claiming finance. APPROVAL_SUMMARY_RE therefore mirrors the finance
 * vocabulary deriveTodoActionLabel's own call arm keys on (`apr`, `monthly`), so a task
 * whose SUMMARY carries a real finance signal keeps the finance outcome it has today.
 */
const APPROVAL_SUMMARY_RE =
  /\b(credit|prequal|pre-qual|approval|financ\w*|payment|business manager|apr|monthly)\b/i;

export function isApprovalTodo(todo: any): boolean {
  const reason = String(todo?.reason ?? "").trim().toLowerCase();
  // reason + summary ONLY. `action` is deriveTodoActionLabel's output, not evidence.
  const text = [todo?.reason, todo?.summary].map(value => String(value ?? "")).join(" ");
  return (
    reason === "approval" ||
    reason === "payments" ||
    reason === "pricing" ||
    reason === "manager" ||
    APPROVAL_SUMMARY_RE.test(text)
  );
}

export const SALES_REASON_META: Record<
  SalesCriticalKind,
  { label: string; icon: "tag" | "creditCard" | "inventory"; variant: string }
> = {
  pricing: { label: "Pricing", icon: "tag", variant: "pricing" },
  financing: { label: "Financing", icon: "creditCard", variant: "financing" },
  availability: { label: "Availability", icon: "inventory", variant: "availability" }
};
