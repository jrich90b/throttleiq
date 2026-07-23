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

export const SALES_REASON_META: Record<
  SalesCriticalKind,
  { label: string; icon: "tag" | "creditCard" | "inventory"; variant: string }
> = {
  pricing: { label: "Pricing", icon: "tag", variant: "pricing" },
  financing: { label: "Financing", icon: "creditCard", variant: "financing" },
  availability: { label: "Availability", icon: "inventory", variant: "availability" }
};
