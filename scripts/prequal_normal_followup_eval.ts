/**
 * prequal_normal_followup:eval — pins Joe's 2026-07-09 ruling (+17163433504, Dylan Pennell):
 * a PRE-QUALIFICATION is not a credit application. A prequal ADF keeps its finance_prequal
 * routing identity (bucket/cta/ruleName drive the ack copy) but stays in the NORMAL flow:
 *   - no "approval" task demanding an outcome,
 *   - no payments_handoff dialog state,
 *   - no manual handoff / cadence stop,
 *   - the STANDARD follow-up cadence starts like any other lead.
 * Both digest voicemail complaints (+17163433504, +17166021492) were prequal leads with NO
 * cadence at all — the credit-app handoff had silenced them the moment they arrived.
 *
 * Fail-direction: a REAL credit app / HDFS COA keeps the full handoff treatment (approval
 * todo + manual_handoff + stop cadence) — pinned below so the split can't over-reach.
 * Source-guard style (same as call_only_lead_silence:eval / dealer_ride_initial_draft:eval).
 */
import fs from "node:fs";
import path from "node:path";

type Check = { id: string; actual: unknown; expected: unknown };
const check = (id: string, actual: unknown, expected: unknown): Check => ({ id, actual, expected });

const route = fs.readFileSync(path.join(process.cwd(), "services/api/src/routes/sendgridInbound.ts"), "utf8");

// --- classification helper: payments_handoff dialog state is credit-app-only ---
const clsStart = route.indexOf("const applyCreditLeadClassification");
const clsBlock = clsStart >= 0 ? route.slice(clsStart, clsStart + 1400) : "";
const dialogStateCreditOnly =
  /if \(!isPrequalLead\) \{\s*\n\s*conv\.dialogState = \{ name: "payments_handoff"/.test(clsBlock);

// --- pre-pass block: approval todo + handoff + cadence stop are credit-app-only ---
const preStart = route.indexOf("if (isCreditLead) {", clsStart);
const preBlock = preStart >= 0 ? route.slice(preStart, preStart + 900) : "";
const prePassSplit =
  preBlock.includes("if (!isPrequalLead) {") &&
  preBlock.includes('addTodo(conv, "approval"') &&
  preBlock.includes('setFollowUpMode(conv, "manual_handoff", "credit_app")') &&
  preBlock.includes('stopFollowUpCadence(conv, "manual_handoff")');

// --- terminal ack branch: prequal starts the standard cadence; credit app keeps the handoff ---
const termStart = route.indexOf("let ack = isPrequalLead");
const termBlock = termStart >= 0 ? route.slice(termStart, termStart + 3200) : "";
const prequalStartsCadence =
  termBlock.includes("if (isPrequalLead) {") &&
  /if \(!conv\.followUpCadence\?\.status && !conv\.appointment\?\.bookedEventId\) \{[\s\S]{0,220}startFollowUpCadence\(conv, new Date\(\)\.toISOString\(\), cfg\.timezone\);/.test(
    termBlock
  );
const prequalArmStart = termBlock.indexOf("if (isPrequalLead) {");
const prequalArmEnd = termBlock.indexOf("} else {", prequalArmStart);
const prequalArm = prequalArmStart >= 0 && prequalArmEnd > prequalArmStart ? termBlock.slice(prequalArmStart, prequalArmEnd) : "";
const prequalSkipsApprovalTodoAndHandoff =
  // inside the isPrequalLead arm (up to its else) there is no approval todo / manual handoff
  prequalArm.length > 0 && !prequalArm.includes('addTodo(conv, "approval"') && !prequalArm.includes("manual_handoff");
const creditAppKeepsHandoff =
  // ...and the else arm (real credit app) still carries all three.
  /\} else \{\s*\n\s*addTodo\(conv, "approval", event\.body \?\? "Credit application", event\.providerMessageId\);\s*\n\s*setFollowUpMode\(conv, "manual_handoff", "credit_app"\);\s*\n\s*stopFollowUpCadence\(conv, "manual_handoff"\);/.test(
    termBlock
  );
const prequalAckUnchanged = termBlock.includes("received your pre-qualification submission");

const checks: Check[] = [
  check("payments_handoff_dialog_state_is_credit_app_only", dialogStateCreditOnly, true),
  check("pre_pass_todo_and_handoff_are_credit_app_only", prePassSplit, true),
  check("prequal_terminal_branch_starts_standard_cadence", prequalStartsCadence, true),
  check("prequal_terminal_branch_has_no_approval_todo_or_handoff", prequalSkipsApprovalTodoAndHandoff, true),
  check("real_credit_app_keeps_full_handoff_treatment", creditAppKeepsHandoff, true),
  check("prequal_ack_copy_unchanged", prequalAckUnchanged, true)
];

const failures = checks.filter(c => JSON.stringify(c.actual) !== JSON.stringify(c.expected));
if (failures.length) {
  console.error("FAIL prequal_normal_followup eval:");
  for (const f of failures) console.error(`  - ${f.id}: expected ${JSON.stringify(f.expected)}, got ${JSON.stringify(f.actual)}`);
  process.exit(1);
}
console.log(`PASS prequal normal follow-up eval (${checks.length} assertions) — prequal keeps routing identity, runs the standard cadence, demands no outcome; real credit apps keep the handoff`);
