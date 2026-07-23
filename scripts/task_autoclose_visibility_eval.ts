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

// --- "Likely done" band (Phase 1b): fulfilled just under the 0.85 floor is presented as
// "probably already handled — confirm & close", not as ordinary undone work (Curtis
// +17163812367: fulfilled at 0.82 sat identical to fresh tasks). Pure helper + card wiring. ---
{
  const { isLikelyDoneTask, LIKELY_DONE_MIN_CONFIDENCE } = await import("../apps/web/src/app/lib/taskTriage.ts");
  assert.equal(LIKELY_DONE_MIN_CONFIDENCE, 0.7, "band floor: below 0.70 the judge is guessing");
  const mk = (over: any) => ({ status: "open", autoCloseCheck: { fulfilled: true, confidence: 0.82, decision: "below_confidence", ...over } });
  assert.equal(isLikelyDoneTask(mk({})), true, "fulfilled at 0.82 under the floor => likely done (the Curtis case)");
  assert.equal(isLikelyDoneTask(mk({ confidence: 0.6 })), false, "0.60 is below the band floor => ordinary work");
  assert.equal(isLikelyDoneTask(mk({ fulfilled: false })), false, "not-fulfilled verdicts never enter the band");
  assert.equal(isLikelyDoneTask(mk({ decision: "closed" })), false, "an actually-closed decision is not 'likely done'");
  assert.equal(isLikelyDoneTask({ status: "done", autoCloseCheck: { fulfilled: true, confidence: 0.82, decision: "below_confidence" } }), false, "done tasks are out of scope");
  assert.equal(isLikelyDoneTask({ status: "open" }), false, "no verdict => no band");
  assert.ok(/isLikelyDoneTask\(t\)/.test(card), "the card must branch on the likely-done helper");
  assert.ok(/Probably already handled/.test(card), "the card must say it in plain language");
  assert.ok(/Confirm &amp; close|Confirm & close/.test(card), "the card must offer a one-click confirm-close");
}

// --- Bookkeeping-note TTL (Phase 1b): whitelisted informational notices retire after the TTL;
// actionable notes are NEVER swept (whitelist, not blacklist — fail toward noise, never toward
// losing work). reason=note is autoclose-ineligible so these had NO other closer. ---
{
  const NOW = new Date("2026-07-23T12:00:00.000Z");
  const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString();
  const note = (summary: string, createdAt: string, over: any = {}) =>
    ({ reason: "note", status: "open", summary, createdAt, ...over }) as any;
  assert.equal(
    store.shouldRetireBookkeepingNotice(note("Business manager outcome prompt sent to Scott.", daysAgo(10)), NOW),
    true,
    "a 10-day-old 'prompt sent' notice retires (prod had four, two exact duplicates)"
  );
  assert.equal(
    store.shouldRetireBookkeepingNotice(note("Customer plans pickup/delivery arrival On my way.", daysAgo(8)), NOW),
    true,
    "an 8-day-old arrival heads-up retires (the visit long since happened)"
  );
  assert.equal(
    store.shouldRetireBookkeepingNotice(note("Salesperson SMS failed for Scott: send_failed.", daysAgo(3)), NOW),
    false,
    "a young notice stays visible (TTL not reached)"
  );
  assert.equal(
    store.shouldRetireBookkeepingNotice(note("Josh texted a photo of a bike they like. Open the image, identify the bike, and reply.", daysAgo(40)), NOW),
    false,
    "an ACTIONABLE note is never swept, no matter how old (whitelist-only)"
  );
  assert.equal(
    store.shouldRetireBookkeepingNotice(note("Business manager outcome prompt sent to Scott.", daysAgo(10), { status: "done" }), NOW),
    false,
    "done tasks are out of scope"
  );
  assert.equal(
    store.shouldRetireBookkeepingNotice(note("Business manager outcome prompt sent to Scott.", daysAgo(10), { reason: "call" }), NOW),
    false,
    "only reason=note is in scope"
  );
  assert.ok(/shouldRetireBookkeepingNotice\(t, now\)/.test(idx), "the reconcile tick must run the TTL sweep");
}

await fsp.rm(tmpDir, { recursive: true, force: true });
console.log("task_autoclose_visibility:eval ok (verdict surfacing + likely-done band + bookkeeping-note TTL)");
