/**
 * Task Inbox Phase-2 UX eval (task-hygiene program, Joe 7/22-23).
 *
 * The UX audit found staff couldn't trust the task list at a glance: no view of what the
 * customer said, no signal that someone already replied, ancient overdue burying today's
 * work, and no bulk actions. Pins the three pure pieces + the surface wiring:
 *   1. buildTodoConversationContext (store) — last-inbound preview (ADF blobs preview as
 *      their Inquiry), and repliedSinceTaskAt only for a REAL outbound AFTER task creation.
 *   2. isStaleOverdueTask (web lib) — overdue >14d demotes; fresh work never does.
 *   3. groupTasksForDigest / digestAttentionCount — stale items trail the digest and stop
 *      inflating "N need you today".
 *   4. Source guards — GET /todos projects the fields; the card renders the context line,
 *      replied chip, bulk bar, and stale section; the digest renders the Older group.
 *
 * Run: npx tsx scripts/task_inbox_context_eval.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.CONVERSATIONS_DB_PATH =
  process.env.CONVERSATIONS_DB_PATH || path.join(os.tmpdir(), `task-inbox-context-eval-${Date.now()}.json`);
const { buildTodoConversationContext } = await import("../services/api/src/domain/conversationStore.ts");
const { isStaleOverdueTask, STALE_OVERDUE_AFTER_DAYS } = await import("../apps/web/src/app/lib/taskTriage.ts");
const { groupTasksForDigest, digestAttentionCount } = await import("../apps/web/src/app/lib/morningDigest.ts");

const NOW = new Date("2026-07-23T15:00:00.000Z");
const NOW_MS = NOW.getTime();
const iso = (d: number) => new Date(NOW_MS - d * 86_400_000).toISOString();

// ── 1) Row context (pure, store) ──
{
  const conv = {
    messages: [
      { direction: "in", provider: "twilio", body: "What would my   out the door price be?", at: iso(3) },
      { direction: "out", provider: "draft_ai", body: "draft never sent", at: iso(2.5) },
      { direction: "out", provider: "twilio", body: "It lists at $17,995.", at: iso(1) }
    ]
  } as any;
  const ctx = buildTodoConversationContext(conv, { createdAt: iso(2) } as any);
  assert.equal(ctx.lastInboundPreview, "What would my out the door price be?", "preview = last customer message, whitespace collapsed");
  assert.equal(ctx.repliedSinceTaskAt, iso(1), "a REAL outbound after the task sets the replied signal");
  const ctxBefore = buildTodoConversationContext(conv, { createdAt: iso(0.5) } as any);
  assert.equal(ctxBefore.repliedSinceTaskAt, null, "an outbound BEFORE the task never counts as replied-since");
  const draftOnly = buildTodoConversationContext(
    { messages: [conv.messages[0], conv.messages[1]] } as any,
    { createdAt: iso(2) } as any
  );
  assert.equal(draftOnly.repliedSinceTaskAt, null, "an unsent draft is not a reply");
}
{
  const adf = {
    messages: [
      {
        direction: "in",
        provider: "sendgrid_adf",
        body: "WEB LEAD (ADF)\nSource: Room58\nRef: 11663\nName: George Khoury\nInquiry:\n2027 883",
        at: iso(2)
      }
    ]
  } as any;
  const ctx = buildTodoConversationContext(adf, { createdAt: iso(1) } as any);
  assert.equal(ctx.lastInboundPreview, "2027 883", "an ADF blob previews as its human Inquiry, not the routing header");
  const bare = buildTodoConversationContext(
    { messages: [{ direction: "in", provider: "sendgrid_adf", body: "WEB LEAD (ADF)\nSource: X\nInquiry:", at: iso(2) }] } as any,
    { createdAt: iso(1) } as any
  );
  assert.equal(bare.lastInboundPreview, "New web lead (no written inquiry)", "an inquiry-less ADF says so instead of dumping metadata");
  assert.equal(buildTodoConversationContext(null, null).lastInboundPreview, null, "no conversation => no preview");
}

// ── 2) Stale-overdue demotion (pure, web lib) ──
assert.equal(STALE_OVERDUE_AFTER_DAYS, 14, "stale threshold: two weeks past due");
assert.equal(isStaleOverdueTask({ dueAt: iso(20) } as any, NOW_MS), true, "20d past due => stale (demote)");
assert.equal(isStaleOverdueTask({ dueAt: iso(3) } as any, NOW_MS), false, "3d past due => still live overdue (tops the list)");
assert.equal(isStaleOverdueTask({ dueAt: new Date(NOW_MS + 3_600_000).toISOString() } as any, NOW_MS), false, "due later today is not stale");
assert.equal(isStaleOverdueTask({} as any, NOW_MS), false, "no due date => not stale (stays in no_date, never demoted as stale)");

// ── 3) Digest: stale trails, header count excludes it ──
{
  const fresh = { id: "a", dueAt: iso(1), summary: "call today" };
  const ancient = { id: "b", dueAt: iso(40), summary: "ancient overdue" };
  const groups = groupTasksForDigest([ancient, fresh], NOW_MS);
  assert.equal(groups[0].tasks[0].id, "a", "fresh overdue leads the digest");
  const last = groups[groups.length - 1];
  assert.equal(last.stale, true, "the stale group trails");
  assert.equal(last.tasks[0].id, "b", "the ancient item lives in the trailing group");
  assert.equal(digestAttentionCount([ancient, fresh], NOW_MS), 1, "'N need you today' counts the fresh one only");
}

// ── 4) Source guards ──
const idx = fs.readFileSync("services/api/src/index.ts", "utf8");
assert.match(idx, /buildTodoConversationContext\(conv, t\)/, "GET /todos must project the row context");
assert.match(idx, /lastInboundPreview: conversationContext\.lastInboundPreview/, "preview field projected");
assert.match(idx, /repliedSinceTaskAt: conversationContext\.repliedSinceTaskAt/, "replied-since field projected");

const card = fs.readFileSync("apps/web/src/app/components/TaskInboxSection.tsx", "utf8");
assert.match(card, /Customer said:/, "card renders the customer-said context line");
assert.match(card, /Replied since/, "card renders the replied chip");
assert.match(card, /lr-task-bulk-bar/, "card renders the bulk action bar");
assert.match(card, /Stale — still relevant\?/, "card renders the demoted stale section");
assert.match(card, /todoInboxSection\(t\) !== "appointment"/, "appointment tasks are excluded from bulk selection (outcome flow owns their close)");

const digest = fs.readFileSync("apps/web/src/app/components/MorningDigestModal.tsx", "utf8");
assert.match(digest, /Older — worth a review/, "digest renders the trailing Older group");

console.log("PASS task inbox context eval (row context + replied signal + stale demotion + digest ordering + surface wiring)");
