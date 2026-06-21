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
  [{ reason: "manager" }, "financing"],
  [{ reason: "call", action: "Call customer to review financing and payment options." }, "financing"],
  [{ reason: "approval", action: "Business manager follow-up (credit app/prequal)." }, "financing"],
  // availability
  [{ reason: "call", action: "Call customer to confirm inventory and availability." }, "availability"],
  [{ reason: "call", action: "Confirm the Street Glide is in stock." }, "availability"],
  // NOT sales-critical
  [{ reason: "call", action: "Call customer to follow up on the Street Glide." }, null],
  [{ reason: "note", action: "Internal note (no customer follow-up)." }, null],
  [{ reason: "service", action: "Service department follow-up and scheduling." }, null],
  [{ reason: "parts", action: "Parts department follow-up." }, null]
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

console.log("task_reason_badge:eval ok");
