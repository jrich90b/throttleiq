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

export function salesCriticalKind(todo: any): SalesCriticalKind | null {
  const reason = String(todo?.reason ?? "").toLowerCase();
  // `action` is the backend-derived label (deriveTodoActionLabel), not raw customer text.
  const text = `${reason} ${String(todo?.action ?? "")}`.toLowerCase();
  if (reason === "pricing" || PRICING_RE.test(text)) return "pricing";
  if (
    reason === "approval" ||
    reason === "payments" ||
    reason === "manager" ||
    FINANCING_RE.test(text)
  ) {
    return "financing";
  }
  if (AVAILABILITY_RE.test(text)) return "availability";
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
