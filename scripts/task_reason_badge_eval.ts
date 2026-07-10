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

console.log("task_reason_badge:eval ok");
