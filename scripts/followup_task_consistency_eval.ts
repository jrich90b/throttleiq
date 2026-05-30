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
const issues = parsed.flagged?.[0]?.issues ?? [];
const checks = [
  ["one_conversation_flagged", parsed.summary.flaggedConversations, 1],
  ["duplicate_class_detected", issues.includes("duplicate_open_todos_same_class"), true],
  ["duplicate_summary_detected", issues.includes("duplicate_open_todos_same_summary"), true],
  ["active_cadence_with_open_followup_detected", issues.includes("active_cadence_with_open_followup_todo"), true]
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
