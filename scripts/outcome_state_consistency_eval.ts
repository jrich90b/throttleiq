import fs from "node:fs";
import path from "node:path";

const sourcePath = path.join(process.cwd(), "services/api/src/index.ts");
const source = fs.readFileSync(sourcePath, "utf8");

function between(startNeedle: string, endNeedle: string): string {
  const start = source.indexOf(startNeedle);
  if (start < 0) return "";
  const end = source.indexOf(endNeedle, start + startNeedle.length);
  if (end < 0) return source.slice(start);
  return source.slice(start, end);
}

function countMatches(text: string, pattern: RegExp): number {
  return [...text.matchAll(pattern)].length;
}

const publicGetBlock = between('app.get("/public/appointment/outcome"', 'app.post("/public/appointment/outcome"');
const publicPostBlock = between('app.post("/public/appointment/outcome"', 'app.post("/public/appointment/outcome/transcribe"');
const headerOutcomeBlock = between(
  'app.post("/conversations/:id/appointment/outcome"',
  'app.post("/conversations/:id/followup-action"'
);
const todoDoneBlock = between('app.post("/todos/:convId/:todoId/done"', "function opsAnomalyDefaultTitle");
const financeHelperBlock = between("async function applyFinanceOutcomeStatusFromSignal", "async function maybePromptBusinessManagerFinanceOutcomeFallback");
const outcomeFollowUpBlock = between("function upsertOutcomeFollowUpTodo", "function buildAppointmentOutcomeRescheduleReply");

const checks = [
  [
    "public_outcome_form_uses_token_kind_for_appointment",
    publicGetBlock.includes("const isAppointmentOutcome = isAppointmentOutcomeTokenForConversation(conv, token);") &&
      !publicGetBlock.includes("const isAppointmentOutcome = !!conv.appointment")
  ],
  [
    "public_outcome_form_labels_dealer_ride_by_token",
    publicGetBlock.includes("const isDealerRideOutcome = isDealerRideOutcomeTokenForConversation(conv, token);") &&
      publicGetBlock.includes('? "dealer ride"')
  ],
  [
    "finance_helper_allows_suppressing_stale_appointment_sync",
    financeHelperBlock.includes("opts?: { syncAppointmentOutcome?: boolean }") &&
      countMatches(financeHelperBlock, /syncAppointmentOutcome && conv\.appointment/g) === 3
  ],
  [
    "public_appointment_finance_outcomes_use_finance_helper",
    publicPostBlock.includes('outcome === "financing_declined" || outcome === "financing_needs_info"') &&
      publicPostBlock.includes("applyFinanceOutcomeStatusFromSignal(") &&
      publicPostBlock.includes("syncAppointmentOutcome: isAppointmentOutcome")
  ],
  [
    "header_appointment_finance_outcomes_use_finance_helper",
    countMatches(headerOutcomeBlock, /applyFinanceOutcomeStatusFromSignal\(/g) >= 2 &&
      !headerOutcomeBlock.includes("await notifyBusinessManagerFinancingDeclined(conv, appointmentOutcomeNote")
  ],
  [
    "todo_dealer_ride_finance_outcome_does_not_sync_stale_appointment",
    todoDoneBlock.includes("syncAppointmentOutcome: !isDealerRideOutcomeTask") &&
      countMatches(todoDoneBlock, /applyFinanceOutcomeStatusFromSignal\(/g) >= 2
  ],
  [
    "approval_todo_not_approved_uses_finance_declined_cadence",
    todoDoneBlock.includes('outcomeValue === "not_approved"') &&
      todoDoneBlock.includes('String(existingTask?.reason ?? task.reason ?? "").trim().toLowerCase() === "approval"') &&
      todoDoneBlock.includes('`todo_outcome:${task?.id ?? existingTask?.id ?? conv.id}`') &&
      todoDoneBlock.includes("financeTodoOutcomeApplied = true") &&
      todoDoneBlock.includes("appointmentOutcomeMarkedSold || financeTodoOutcomeApplied")
  ],
  [
    "outcome_followup_todo_uses_exact_source_upsert",
    outcomeFollowUpBlock.includes("function upsertOutcomeFollowUpTodo") &&
      outcomeFollowUpBlock.includes('String(todo.sourceMessageId ?? "").trim() === sourceKey') &&
      outcomeFollowUpBlock.includes("{ skipMerge: true }") &&
      outcomeFollowUpBlock.includes("upsertOutcomeFollowUpTodo({")
  ]
] as const;

let passed = 0;
for (const [id, ok] of checks) {
  if (ok) passed += 1;
  console.log(`${ok ? "PASS" : "FAIL"} ${id}`);
}

if (passed !== checks.length) {
  console.error(`\n${checks.length - passed} outcome state consistency eval check(s) failed`);
  process.exit(1);
}

console.log(`\nAll ${checks.length} outcome state consistency eval checks passed.`);
