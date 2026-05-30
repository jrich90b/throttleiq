import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "followup-task-consistency-eval-"));
const storePath = path.join(tempDir, "conversations.json");

const now = new Date().toISOString();
const store = {
  version: 1,
  conversations: [
    {
      id: "conv_double",
      leadKey: "+17160000001",
      mode: "suggest",
      status: "open",
      updatedAt: now,
      lead: { firstName: "Double", lastName: "Followup", leadRef: "D1" },
      followUp: { mode: "active", updatedAt: now },
      followUpCadence: { status: "active", kind: "standard", nextDueAt: now },
      messages: []
    },
    {
      id: "conv_clean",
      leadKey: "+17160000002",
      mode: "suggest",
      status: "open",
      updatedAt: now,
      lead: { firstName: "Clean", lastName: "Lead", leadRef: "C1" },
      followUp: { mode: "active", updatedAt: now },
      followUpCadence: { status: "active", kind: "standard", nextDueAt: now },
      messages: []
    },
    {
      id: "conv_staff_task",
      leadKey: "+17160000003",
      mode: "suggest",
      status: "open",
      updatedAt: now,
      lead: { firstName: "Staff", lastName: "Task", leadRef: "S1" },
      followUp: { mode: "active", updatedAt: now },
      followUpCadence: { status: "active", kind: "standard", nextDueAt: now },
      messages: []
    }
  ],
  todos: [
    {
      id: "todo_1",
      convId: "conv_double",
      leadKey: "+17160000001",
      reason: "call",
      taskClass: "followup",
      summary: "Call customer (follow-up): confirm next steps.",
      status: "open",
      createdAt: now
    },
    {
      id: "todo_2",
      convId: "conv_double",
      leadKey: "+17160000001",
      reason: "call",
      taskClass: "followup",
      summary: "Call customer (follow-up): confirm next steps.",
      status: "open",
      createdAt: now
    },
    {
      id: "todo_staff",
      convId: "conv_staff_task",
      leadKey: "+17160000003",
      reason: "call",
      taskClass: "followup",
      summary: "Dealer ride follow-up needed: thank customer, confirm how to proceed, and update lead status.",
      status: "open",
      createdAt: now
    }
  ],
  questions: []
};

fs.writeFileSync(storePath, JSON.stringify(store, null, 2));

const result = spawnSync(
  process.execPath,
  ["./node_modules/.bin/tsx", "scripts/followup_task_consistency_audit.ts", "--conversations", storePath],
  { cwd: process.cwd(), encoding: "utf8" }
);

if (result.status !== 0) {
  console.error(result.stdout);
  console.error(result.stderr);
  process.exit(result.status ?? 1);
}

const parsed = JSON.parse(result.stdout);
const byId = new Map<string, any>((parsed.flagged ?? []).map((row: any) => [String(row.id), row]));
const doubleIssues = byId.get("conv_double")?.issues ?? [];
const staffIssues = byId.get("conv_staff_task")?.issues ?? [];
const checks = [
  ["two_conversations_flagged", parsed.summary.flaggedConversations, 2],
  ["duplicate_class_detected", doubleIssues.includes("duplicate_open_todos_same_class"), true],
  ["duplicate_summary_detected", doubleIssues.includes("duplicate_open_todos_same_summary"), true],
  ["stale_cadence_generated_followup_detected", doubleIssues.includes("stale_cadence_generated_followup_todo"), true],
  ["staff_followup_conflict_detected", staffIssues.includes("active_cadence_with_open_staff_followup_todo"), true]
] as const;

let passed = 0;
for (const [id, actual, expected] of checks) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) passed += 1;
  console.log(`${ok ? "PASS" : "FAIL"} ${id} expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`);
}

if (passed !== checks.length) {
  console.error(`\n${checks.length - passed} follow-up task consistency eval check(s) failed`);
  process.exit(1);
}

console.log(`\nAll ${checks.length} follow-up task consistency eval checks passed.`);
