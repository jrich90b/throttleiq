import { strict as assert } from "node:assert";
import fs from "node:fs";

/**
 * Sales-critical task reason eval — the money tasks (pricing / financing / availability)
 * must be classified for their color-coded reason badge + priority rail, while ordinary
 * follow-ups / notes / department tasks stay unbadged. Keyed on the backend's STRUCTURED
 * reason + derived action label, not raw customer text. Deterministic; no LLM.
 */

const { salesCriticalKind } = await import("../apps/web/src/app/lib/taskReason.ts");

const cases: Array<[any, string | null]> = [
  // pricing
  [{ reason: "pricing" }, "pricing"],
  [{ reason: "call", action: "Provide pricing or payment details." }, "pricing"],
  [{ reason: "call", action: "Call customer about a quote on the Road Glide." }, "pricing"],
  // financing
  [{ reason: "approval" }, "financing"],
  [{ reason: "payments" }, "financing"],
  // reason "manager" is a generic escalate-to-a-human, not a finance signal by itself (Joe
  // ruling 2026-07-09, Jessica Ornce +17167134728: a TRADE-review manager task badged
  // Financing). It still badges when its text carries real finance signals.
  [{ reason: "manager", action: "Discuss trade appraisal and next steps." }, null],
  [{ reason: "manager" }, null],
  [{ reason: "manager", action: "Business manager follow-up (credit app)." }, "financing"],
  [{ reason: "call", action: "Call customer to review financing and payment options." }, "financing"],
  [{ reason: "approval", action: "Business manager follow-up (credit app/prequal)." }, "financing"],
  // availability
  [{ reason: "call", action: "Call customer to confirm inventory and availability." }, "availability"],
  [{ reason: "call", action: "Confirm the Street Glide is in stock." }, "availability"],
  // NOT sales-critical
  [{ reason: "call", action: "Call customer to follow up on the Street Glide." }, null],
  [{ reason: "note", action: "Internal note (no customer follow-up)." }, null],
  [{ reason: "service", action: "Service department follow-up and scheduling." }, null],
  [{ reason: "parts", action: "Parts department follow-up." }, null],
  // Internal review / held-draft tasks are NOT customer buy-signals — never badged, even when their
  // summary/derived-action borrows inventory/pricing words from a guard name (Armando Cortes, 6/24).
  [
    {
      reason: "other",
      summary:
        "Review dealer ride outcome customer follow-up before sending. Draft guard blocked it: unsupported_inventory_hold_promise_guard.",
      action: "Verify inventory and follow up."
    },
    null
  ],
  [
    {
      reason: "other",
      summary:
        "Review customer follow-up before sending. Draft guard blocked it: unsupported_pricing_promise_guard.",
      action: "Provide pricing or payment details."
    },
    null
  ],
  [
    {
      reason: "other",
      summary: "Needs your reply — the AI couldn't answer this in context (stale_intent). Reply to the customer.",
      action: "Follow up with the customer."
    },
    null
  ],
  // ...but a GENUINE customer availability task (ordinary summary, not a review template) still badges.
  [
    { reason: "call", summary: "Customer asked if the Street Glide is in stock.", action: "Verify inventory and follow up." },
    "availability"
  ],
  // A SCHEDULING/booking task is not an inventory-availability buy-signal: "check availability" there
  // means the CALENDAR. The corrected deriver labels it a booking action, so it must NOT badge
  // Availability (Gary Busenlehner, 2026-06-27: a "schedule the visit … (check availability) … calendar"
  // task was wrongly badged Availability).
  [{ reason: "call", action: "Call customer to confirm a time and book the visit." }, null]
];

for (const [todo, expected] of cases) {
  const got = salesCriticalKind(todo);
  assert.equal(got, expected, `salesCriticalKind(${JSON.stringify(todo)}) => ${got}, expected ${expected}`);
}

// --- Source guards: both surfaces consume the classifier ---
const taskInbox = fs.readFileSync("apps/web/src/app/components/TaskInboxSection.tsx", "utf8");
assert.ok(/salesCriticalKind\(/.test(taskInbox), "TaskInboxSection must classify reason for the badge");
assert.ok(/lr-task-card--priority/.test(taskInbox), "TaskInboxSection must apply the priority rail");

const inbox = fs.readFileSync("apps/web/src/app/components/InboxSection.tsx", "utf8");
assert.ok(/salesCriticalKind\(/.test(inbox), "InboxSection row chip must be reason-aware");

// The badge reads the backend-derived action label. deriveTodoActionLabel must classify a scheduling
// task as a BOOKING action BEFORE the inventory/availability branch — otherwise "check availability"
// (calendar) is mislabeled "confirm inventory and availability" and trips the Availability badge.
const apiIndex = fs.readFileSync("services/api/src/index.ts", "utf8");
const schedIdx = apiIndex.indexOf('Call customer to confirm a time and book the visit.');
const invIdx = apiIndex.indexOf('Call customer to confirm inventory and availability.');
assert.ok(schedIdx > 0, "deriveTodoActionLabel must have a scheduling/booking action label");
assert.ok(schedIdx < invIdx, "the scheduling branch must precede the inventory/availability branch in deriveTodoActionLabel");

// PARSER-FIRST HINT FALLBACK (Phase 3, +17169306602 "Follow up task should be tagged with
// pricing"): when reason/action carry no signal, the badge trusts the backend's salesTopicHint —
// the lead's PARSED classification CTA — instead of staying blank. Structured data, no new regex.
const hintCases: Array<[any, string | null]> = [
  [{ reason: "call", action: "Call customer (follow-up)", salesTopicHint: "pricing" }, "pricing"],
  [{ reason: "call", action: "Call customer (follow-up)", salesTopicHint: "availability" }, "availability"],
  // The hint is a FALLBACK only — an explicit reason/action signal still wins.
  [{ reason: "pricing", action: "", salesTopicHint: "availability" }, "pricing"],
  // Bookkeeping notes never badge, hint or not (a notice on a quote lead is not a buy signal).
  [{ reason: "note", action: "", salesTopicHint: "pricing" }, null],
  // Junk/unknown hints are ignored; no hint stays unbadged.
  [{ reason: "call", action: "Call customer (follow-up)", salesTopicHint: "banana" }, null],
  [{ reason: "call", action: "Call customer (follow-up)" }, null]
];
for (const [todo, expected] of hintCases) {
  const got = salesCriticalKind(todo);
  assert.equal(got, expected, `hint fallback: salesCriticalKind(${JSON.stringify(todo)}) => ${got}, expected ${expected}`);
}
// Source guard: GET /todos projects the hint (the derivation itself is pinned BEHAVIORALLY below,
// which replaced a source-text pin on the old inline `classificationCta === "request_a_quote"`).
assert.match(apiIndex, /salesTopicHint/, "GET /todos must project salesTopicHint");

// THE HINT EXPIRES WHEN THE PRICE IS ANSWERED (operator, 2026-07-25, Tony Mooradian
// +17165236994: "Pricing was answered but the pricing flag still shows in the inbox").
// `classification.cta` is stamped once at intake and never changes, so the Phase-3 fallback above
// made a lead's ORIGIN badge every later task forever — his SCHEDULING task wore a Pricing chip two
// months after Scott quoted $20,995. The CTA opens the topic; a delivered quote closes it.
const { resolveSalesTopicHint, hasDeliveredQuote } = await import(
  "../services/api/src/domain/salesTopicHint.ts"
);

const quoteLead = (messages: any[], followUp?: any) => ({
  classification: { cta: "request_a_quote" },
  followUp,
  messages
});

// Tony's real thread: the ADF quote request, then the dealer's actual answer.
const TONY_QUOTE_REPLY =
  "Hi Tony — This is Scott from American H-D. We are currently servicing the bike and that is " +
  "why there are no pictures or price posted on the website. We plan on asking $20,995 once its " +
  "ready for the floor";

const hintDerivationCases: Array<[string, any, string | null]> = [
  ["quote lead, nothing quoted yet → the badge is right", quoteLead([]), "pricing"],
  [
    "quote lead, dealer already quoted it (+17165236994) → the topic is closed",
    quoteLead([{ direction: "out", body: TONY_QUOTE_REPLY }]),
    null
  ],
  [
    "the referee already flipped follow-up to manual_quote_delivered",
    quoteLead([], { mode: "active", reason: "manual_quote_delivered" }),
    null
  ],
  [
    "inbound customer text mentioning a price is NOT us answering",
    quoteLead([{ direction: "in", body: "Can you do $18,000 out the door?" }]),
    "pricing"
  ],
  [
    "a promo BLAST carrying a dollar figure is not an answer to this lead's question",
    quoteLead([
      {
        direction: "out",
        body: "Save $4,000 on select 2026 models this weekend at American H-D. Reply STOP to opt out."
      }
    ]),
    "pricing"
  ],
  [
    "a quote we recorded but never actually sent leaves the topic open",
    quoteLead([{ direction: "out", body: TONY_QUOTE_REPLY, delivered: false }]),
    "pricing"
  ],
  // Availability leads are unchanged by this fix, and an unclassified lead never gets a hint.
  ["availability CTA is untouched", { classification: { cta: "check_availability" } }, "availability"],
  ["no CTA → no hint", { classification: {} }, null],
  ["no classification at all → no hint", {}, null]
];
for (const [label, conv, expected] of hintDerivationCases) {
  const got = resolveSalesTopicHint(conv);
  assert.equal(got, expected, `salesTopicHint: ${label} => ${got}, expected ${expected}`);
}

// End-to-end, the production chain: a quote-origin lead whose price was answered must leave its
// generic scheduling task UNBADGED — the exact chip the operator reported.
const tonyConv = quoteLead([{ direction: "out", body: TONY_QUOTE_REPLY }]);
const tonySchedulingTask = {
  reason: "call",
  action: "Call customer to confirm a time and book the visit.",
  summary: "Schedule the visit for Tony — a time was discussed but nothing is booked.",
  salesTopicHint: resolveSalesTopicHint(tonyConv)
};
assert.equal(
  salesCriticalKind(tonySchedulingTask),
  null,
  "+17165236994: a scheduling task on a lead we already quoted must not wear a Pricing badge"
);
// ...and the same task on a lead we have NOT quoted still gets the badge #257 added.
assert.equal(
  salesCriticalKind({ ...tonySchedulingTask, salesTopicHint: resolveSalesTopicHint(quoteLead([])) }),
  "pricing",
  "an unanswered quote request must still badge the follow-up task"
);
assert.equal(hasDeliveredQuote(quoteLead([])), false, "no outbound quote => not delivered");

console.log("task_reason_badge:eval ok (incl. salesTopicHint fallback + quote-answered expiry)");
