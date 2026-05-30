import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

type Check = {
  id: string;
  actual: unknown;
  expected: unknown;
};

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "internal-outbound-guard-eval-"));
process.env.CONVERSATIONS_DB_PATH = path.join(tempDir, "conversations.json");

const {
  addTodo,
  appendOutbound,
  getConversation,
  isInternalOutboundActionLogBody,
  listOpenTodos,
  upsertConversationByLeadKey
} = await import("../services/api/src/domain/conversationStore.ts");

function check(id: string, actual: unknown, expected: unknown): Check {
  return { id, actual, expected };
}

const conv = upsertConversationByLeadKey("+17165124027", "suggest");
appendOutbound(
  conv,
  "system",
  conv.leadKey,
  "Context note applied actions by Dealer ride outcome: context_note_follow_up_scheduled:Mon, Jun 1, 9:00 AM.",
  "human" as any
);
appendOutbound(conv, "salesperson", conv.leadKey, "Normal staff message to customer.", "human");
const internalTodo = addTodo(
  conv,
  "note",
  "Context note applied actions by Dealer ride outcome: context_note_follow_up_scheduled:Mon, Jun 1, 9:00 AM."
);

const reloaded = getConversation("+17165124027");
const messages = reloaded?.messages ?? [];
const checks: Check[] = [
  check(
    "context_note_action_log_detected",
    isInternalOutboundActionLogBody(
      "Context note applied actions by Dealer ride outcome: context_note_follow_up_scheduled:Mon, Jun 1, 9:00 AM."
    ),
    true
  ),
  check("internal_action_log_blocked", messages.some(m => /Context note applied actions/i.test(m.body)), false),
  check("internal_action_log_todo_blocked", internalTodo, null),
  check(
    "internal_action_log_open_todo_absent",
    listOpenTodos().some(todo => /Context note applied actions/i.test(todo.summary)),
    false
  ),
  check("normal_human_outbound_allowed", messages.some(m => m.body === "Normal staff message to customer."), true)
];

let passed = 0;
for (const c of checks) {
  const ok = JSON.stringify(c.actual) === JSON.stringify(c.expected);
  if (ok) passed += 1;
  console.log(
    `${ok ? "PASS" : "FAIL"} ${c.id} expected=${JSON.stringify(c.expected)} actual=${JSON.stringify(c.actual)}`
  );
}

if (passed !== checks.length) {
  console.error(`\n${checks.length - passed} failures out of ${checks.length} internal outbound guard checks`);
  process.exit(1);
}

console.log(`\nAll ${checks.length} internal outbound guard checks passed.`);
