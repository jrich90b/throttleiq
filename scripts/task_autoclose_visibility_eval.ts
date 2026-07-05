import { strict as assert } from "node:assert";
import os from "node:os";
import * as path from "node:path";
import fs from "node:fs";
import { promises as fsp } from "node:fs";

/**
 * Task auto-close VISIBILITY eval. So staff can see WHY a task did/didn't auto-close, the
 * fulfillment check's verdict (confidence + evidence + decision) is persisted on the task
 * (autoCloseCheck) and surfaced in the Task Inbox. Pins: the store mutator persists it, the
 * runner records it, GET /todos passes it through, and the card renders it. Deterministic.
 */

const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "autoclose-vis-eval-"));
process.env.CONVERSATIONS_DB_PATH = path.join(tmpDir, "conversations.json");

const store = await import("../services/api/src/domain/conversationStore.ts");
await store.whenConversationStoreReady();

const conv = store.createConversationForLeadKey("+17165550640");
const todo = store.addTodo(conv, "call", "Call customer about Road Glide availability");
assert.ok(todo, "addTodo created the task");

store.setTodoAutoCloseCheck(conv.id, todo!.id, {
  at: new Date().toISOString(),
  fulfilled: false,
  confidence: 0.62,
  evidence: "dealer only promised to follow up; objective not yet accomplished",
  decision: "below_confidence",
  channel: "sms"
});

const persisted = store.listOpenTodos().find(t => t.id === todo!.id);
assert.ok(persisted?.autoCloseCheck, "verdict persisted on the open task");
assert.equal(persisted!.autoCloseCheck!.confidence, 0.62, "confidence persisted");
assert.equal(persisted!.autoCloseCheck!.decision, "below_confidence", "decision persisted");
assert.ok(String(persisted!.autoCloseCheck!.evidence ?? "").length > 0, "evidence persisted");

// --- Source guards: runner records it, API passes it through, card renders it ---
const idx = fs.readFileSync("services/api/src/index.ts", "utf8");
assert.ok(/setTodoAutoCloseCheck\(conv\.id, task\.id/.test(idx), "the autoclose runner must persist the verdict");
// GET /todos spreads the raw task (so autoCloseCheck flows to the web) — guard the spread.
assert.ok(/\.\.\.t,\s*\n?\s*leadName/.test(idx.replace(/\r/g, "")), "GET /todos must spread the task (carries autoCloseCheck)");

const card = fs.readFileSync("apps/web/src/app/components/TaskInboxSection.tsx", "utf8");
assert.ok(
  /t\.autoCloseCheck/.test(card) && /lr-task-autoclose-check/.test(card),
  "the Task Inbox card must render the auto-close verdict"
);

await fsp.rm(tmpDir, { recursive: true, force: true });
console.log("task_autoclose_visibility:eval ok");
