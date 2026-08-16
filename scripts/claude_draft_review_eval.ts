/**
 * claude_draft_review:eval — pins Joe's instant second opinion (ruled 2026-08-14 late evening:
 * "monitor and fix if a message is generated that does not make sense — not our LLM in the
 * system — as a last safety net, so I don't have to flag it" + "what if I don't want it to take
 * a half hour to fix a draft?").
 *
 * Claude (a different model family than the OpenAI pipeline) reviews each new pending draft on
 * the minute lane; a clearly-wrong draft is superseded in the approval box via saveOperatorDraft
 * (attributed "Claude review"; staff still approve; nothing ever sends itself), and EVERY rewrite
 * files a work order into the ops-anomaly store so the repair loop turns the instance heal into a
 * class fix (Joe: "will a work order get queued so the agent can continuously improve?" — yes,
 * by construction, pinned here).
 *
 * The LLM verdict itself is not asserted here (judge-vote lessons, #596/#708) — what is pinned:
 * the SELECTION (who gets reviewed), the fail directions, the load-bearing prompt rules, the
 * work-order wiring, and the three-point lane registration.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  CLAUDE_DRAFT_REVIEW_MAX_PER_TICK_DEFAULT,
  CLAUDE_DRAFT_REVIEW_TOOL_SCHEMA,
  buildClaudeDraftReviewSystemPrompt,
  claudeDraftReviewEnabled,
  draftIsMachineAuthored,
  selectDraftsForClaudeReview
} from "../services/api/src/domain/claudeDraftReview.ts";
import { WORKER_MINUTE_LANE_TASKS, WORKER_TICK_TASKS } from "../services/api/src/domain/workerTasks.ts";
import { WORKER_SCHEDULES } from "../services/worker/src/config.ts";

const NOW = Date.UTC(2026, 7, 15, 12, 0, 0);
const MIN = 60_000;

// --- Selection table (executed against real-shaped conversations) ---------------------------
// getLatestPendingDraft semantics come from the store itself: only a draft_ai row NEWER than the
// last real send is pending; superseded/ghost rows never reach review.
function conv(overrides: Record<string, unknown>, messages: Array<Record<string, unknown>>) {
  return { id: String(overrides.id ?? "+15550001111"), leadKey: "+15550001111", mode: "suggest", status: undefined, messages, ...overrides } as any;
}
const CUSTOMER = { direction: "in", provider: "twilio", body: "What is the OTD price on the Road Glide and can I see it Saturday?", at: new Date(NOW - 10 * MIN).toISOString(), id: "m_in" };
const FRESH_DRAFT = { direction: "out", provider: "draft_ai", body: "Great question — I'll get right back to you!", at: new Date(NOW - 5 * MIN).toISOString(), id: "m_draft" };

{
  const picks = selectDraftsForClaudeReview({ conversations: [conv({}, [CUSTOMER, FRESH_DRAFT])], nowMs: NOW });
  assert.equal(picks.length, 1, "a fresh unreviewed pending draft on an agent-mode thread is selected");
  assert.equal(String(picks[0].draft.id), "m_draft");
}
// --- THE GATE IS AUTHORSHIP, NOT THREAD OWNERSHIP (2026-08-16) -------------------------------
// This used to skip every `mode: "human"` thread because "the human owns the words". True of a draft
// a human TYPED; false of the rows actually there. MEASURED on the live store: since 8/1, 52
// machine-written drafts landed on human-mode threads vs 55 everywhere else — about half of all
// machine-drafted volume — and human threads carried 0 reviewer receipts vs 9. Real defects went
// unreviewed there, including a draft telling Igor +17164442120 "I saw you want to do the Jumpstart
// experience" on a thread where he has never sent a single message.
{
  const picks = selectDraftsForClaudeReview({ conversations: [conv({ mode: "human" }, [CUSTOMER, FRESH_DRAFT])], nowMs: NOW });
  assert.equal(picks.length, 1, "a MACHINE-written draft on a human-owned thread IS reviewed — nobody owns those words");
}
{
  // The same measurement found 3 of 46 human-thread drafts carried a person's name on the SAME
  // `provider: "draft_ai"` row. Keying on the provider — the obvious fix — would have handed a
  // human's own words to an automatic rewriter. This is the assertion that forbids that.
  const typed = conv({ mode: "human" }, [CUSTOMER, { ...FRESH_DRAFT, actorUserName: "Joe Hartrich" }]);
  assert.equal(selectDraftsForClaudeReview({ conversations: [typed], nowMs: NOW }).length, 0, "a draft a PERSON typed is never reviewed, on a human-mode thread");
  const typedSuggest = conv({ mode: "suggest" }, [CUSTOMER, { ...FRESH_DRAFT, actorUserName: "Joe Hartrich" }]);
  assert.equal(selectDraftsForClaudeReview({ conversations: [typedSuggest], nowMs: NOW }).length, 0, "…and not on a suggest thread either — authorship, not mode");
}
{
  // The predicate itself, executed. Fail direction: an unrecognised actor reads as a PERSON.
  assert.equal(draftIsMachineAuthored({}), true, "no actor => machine-written");
  assert.equal(draftIsMachineAuthored({ actorUserName: "  " }), true, "blank actor => machine-written");
  assert.equal(draftIsMachineAuthored({ actorUserName: "Auto-redraft (thumbs-down)" }), true, "our own auto-redraft is machine-written");
  assert.equal(draftIsMachineAuthored({ actorUserName: "Joe Hartrich" }), false, "a named person is not machine-written");
  assert.equal(draftIsMachineAuthored({ actorUserName: "Some New Rep" }), false, "an UNKNOWN actor reads as a person — never rewrite words we cannot prove we wrote");
  const autoRedraft = conv({ mode: "human" }, [CUSTOMER, { ...FRESH_DRAFT, actorUserName: "Auto-redraft (thumbs-down)" }]);
  assert.equal(selectDraftsForClaudeReview({ conversations: [autoRedraft], nowMs: NOW }).length, 1, "our own auto-redraft is reviewable on a human thread");
}

const NO_REVIEW: Array<[string, any]> = [
  ["the reviewer's own rewrite (loop guard — actor \"Claude review\")", conv({}, [CUSTOMER, { ...FRESH_DRAFT, actorUserName: "Claude review" }])],
  ["the reviewer's own rewrite on a HUMAN thread (loop guard survives the mode change)", conv({ mode: "human" }, [CUSTOMER, { ...FRESH_DRAFT, actorUserName: "Claude review" }])],
  ["a person's typed draft on a human thread", conv({ mode: "human" }, [CUSTOMER, { ...FRESH_DRAFT, actorUserName: "Scott Hartrich" }])],
  ["closed conversation", conv({ status: "closed" }, [CUSTOMER, FRESH_DRAFT])],
  ["already stamped for this draft", conv({ claudeDraftReview: { messageId: "m_draft", verdict: "ok", at: "2026-08-15T11:00:00Z" } }, [CUSTOMER, FRESH_DRAFT])],
  ["no pending draft (customer message is newest)", conv({}, [CUSTOMER])],
  ["draft superseded by a real send (not pending)", conv({}, [CUSTOMER, FRESH_DRAFT, { direction: "out", provider: "twilio", body: "sent reply", at: new Date(NOW - 2 * MIN).toISOString(), id: "m_sent" }])],
  ["draft older than the 24h ceiling", conv({}, [CUSTOMER, { ...FRESH_DRAFT, at: new Date(NOW - 30 * 60 * MIN).toISOString() }])],
  ["undatable draft (leave it alone)", conv({}, [CUSTOMER, { ...FRESH_DRAFT, at: "not-a-date" }])],
  ["empty draft body", conv({}, [CUSTOMER, { ...FRESH_DRAFT, body: "  " }])]
];
for (const [label, c] of NO_REVIEW) {
  const picks = selectDraftsForClaudeReview({ conversations: [c], nowMs: NOW });
  assert.equal(picks.length, 0, `${label} must NOT be selected`);
}
{
  // The per-tick cap bounds spend; a re-stamped draft frees the slot next tick.
  const many = Array.from({ length: 10 }, (_, i) =>
    conv({ id: `+1555000${i}` }, [CUSTOMER, { ...FRESH_DRAFT, id: `d_${i}` }])
  );
  const picks = selectDraftsForClaudeReview({ conversations: many, nowMs: NOW });
  assert.equal(picks.length, CLAUDE_DRAFT_REVIEW_MAX_PER_TICK_DEFAULT, "the per-tick cap holds");
}

// --- Fail directions and the kill switch -----------------------------------------------------
{
  const envBefore = { flag: process.env.CLAUDE_DRAFT_REVIEW_ENABLED, key: process.env.ANTHROPIC_API_KEY };
  process.env.CLAUDE_DRAFT_REVIEW_ENABLED = "0";
  process.env.ANTHROPIC_API_KEY = "test-key";
  assert.equal(claudeDraftReviewEnabled(), false, "CLAUDE_DRAFT_REVIEW_ENABLED=0 is the kill switch");
  process.env.CLAUDE_DRAFT_REVIEW_ENABLED = "1";
  process.env.ANTHROPIC_API_KEY = "";
  assert.equal(claudeDraftReviewEnabled(), false, "no ANTHROPIC_API_KEY ⇒ the pass stands down silently");
  process.env.ANTHROPIC_API_KEY = "test-key";
  assert.equal(claudeDraftReviewEnabled(), true, "flag on + key present ⇒ enabled");
  if (envBefore.flag === undefined) delete process.env.CLAUDE_DRAFT_REVIEW_ENABLED; else process.env.CLAUDE_DRAFT_REVIEW_ENABLED = envBefore.flag;
  if (envBefore.key === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = envBefore.key;
}

// --- The load-bearing prompt rules, pinned by EXECUTING the builder --------------------------
{
  const prompt = buildClaudeDraftReviewSystemPrompt();
  assert.ok(prompt.includes("NEVER drop a concrete fact"), "the 41-deleted-times lesson is a hard rule");
  assert.ok(prompt.includes("Dropping a real time slot is a regression, not a fix"), "times are named explicitly");
  assert.ok(prompt.includes("NEVER invent a price, rate, payment figure"), "no invented money figures");
  assert.ok(prompt.includes("When unsure: verdict \"ok\""), "uncertainty keeps the pipeline's draft");
  assert.ok(prompt.includes("check EVERY question in their last message"), "multi-intent coverage is part of clearly-wrong");
  assert.ok(prompt.includes("Reply STOP to opt out"), "the compliance footer is preserved on rewrite");
  assert.ok(/ONE question that moves/.test(prompt), "the advancing-question charter rule (C1.7) rides along");
}
{
  const schema = CLAUDE_DRAFT_REVIEW_TOOL_SCHEMA as any;
  assert.deepEqual(schema.properties.verdict.enum, ["ok", "rewrite"], "binary verdict — no third state to drift into");
  assert.deepEqual(schema.required, ["verdict", "reason", "fixed_draft"], "reason is mandatory (it feeds the work order)");
}

// --- Unavailable is NOT ok: no stamp, distinct outcome (the 2026-08-15 fire-drill lesson —
// an empty-credit API key stamped obvious nonsense "reviewed-ok" and the dead net looked alive) --
{
  const src0 = fs.readFileSync(path.resolve("services/api/src/domain/claudeDraftReview.ts"), "utf8");
  assert.ok(src0.includes('"claude_draft_review_unavailable"'), "API failure records its own outcome — a dead net must be loudly visible");
  const unavailBlock = src0.slice(src0.indexOf('verdict.reason === "review_unavailable"'), src0.indexOf('verdict.verdict === "rewrite"'));
  assert.ok(unavailBlock.includes("continue;"), "an unavailable review NEVER stamps the draft — it stays eligible for retry when the service recovers");
  assert.ok(src0.includes("if (!parsed) return keep;"), "an unparseable reply is not a verdict — it must never read as ok");
}

// --- The continuous-improvement wiring: every rewrite files a work order ---------------------
{
  const src = fs.readFileSync(path.resolve("services/api/src/domain/claudeDraftReview.ts"), "utf8");
  const rewriteBlock = src.slice(src.indexOf('verdict.verdict === "rewrite"'), src.indexOf("(conv as any).claudeDraftReview ="));
  assert.ok(rewriteBlock.includes("saveOperatorDraft"), "a rewrite supersedes via the operator-draft mechanism (draft-only, never a send)");
  assert.ok(rewriteBlock.includes("addOpsAnomaly"), "a rewrite ALWAYS files a work order for the repair loop — the instance heal becomes a class investigation");
  assert.ok(rewriteBlock.includes('actor: { userName: "Claude review" }'), "the superseding draft is attributed so staff know who wrote it");
}

// --- Three-point lane registration (a task missing anywhere silently never runs) -------------
assert.ok((WORKER_TICK_TASKS as readonly string[]).includes("claude-draft-review"), "registered tick task");
assert.ok((WORKER_MINUTE_LANE_TASKS as readonly string[]).includes("claude-draft-review"), "on the API minute lane");
const minuteSchedule = WORKER_SCHEDULES.find(s => s.cron === "* * * * *");
assert.ok(minuteSchedule && minuteSchedule.tasks.includes("claude-draft-review"), "on the worker minute schedule");

console.log("PASS claude_draft_review:eval — selection table (1 review + 8 holds + cap), kill switch, prompt rules, work-order wiring, 3-point lane registration");
