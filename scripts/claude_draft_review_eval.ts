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
  CLAUDE_EMAIL_DRAFT_REVIEW_MAX_PER_TICK_DEFAULT,
  CLAUDE_REVIEW_BREAKER_COOLDOWN_MS_DEFAULT,
  CLAUDE_REVIEW_BREAKER_TRIP_AFTER_DEFAULT,
  buildClaudeDraftReviewSystemPrompt,
  claudeDraftReviewEnabled,
  claudeReviewBreakerIsOpen,
  claudeReviewBreakerSnapshot,
  draftIsMachineAuthored,
  emailDraftReviewHash,
  recordClaudeReviewSuccess,
  recordClaudeReviewTransportFailure,
  resetClaudeReviewBreaker,
  selectDraftsForClaudeReview,
  selectEmailDraftsForClaudeReview
} from "../services/api/src/domain/claudeDraftReview.ts";
import {
  appendOutbound,
  getLatestPendingDraft,
  saveOperatorDraft,
  upsertConversationByLeadKey
} from "../services/api/src/domain/conversationStore.ts";
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
// --- A CLOSED THREAD IS A SOLD CUSTOMER, NOT A DEAD ONE (2026-08-17) --------------------------
// Same category error as the mode gate above, one field over: `conv.status` names the LEAD's
// lifecycle, not the conversation's activity. The dominant closedReason is "sold", and sold
// customers keep texting about delivery, parts and service. MEASURED on the live store 8/17 14:35Z:
// 31 of 43 pending drafts sat on CLOSED threads and the reviewer opened none of them; only 12 sat on
// open threads. The draft that produced this: Brent +17169941544 (closed, closedReason "sold", bike
// picked up 8/15) thanked the store and asked to be called when his seat/tour pack/CarPlay module
// arrive — and the pending draft promised to watch for "the 2026 Road Glide you've got on order",
// two days AFTER he took delivery. Closing a lead does not hide its draft: the console pre-loads a
// pending draft into the send box, one tap from Send.
{
  const sold = conv({ status: "closed", closedReason: "sold" }, [CUSTOMER, FRESH_DRAFT]);
  const picks = selectDraftsForClaudeReview({ conversations: [sold], nowMs: NOW });
  assert.equal(picks.length, 1, "a machine draft on a SOLD/closed thread IS reviewed — closed names the lead, not the conversation");
  assert.equal(String(picks[0].draft.id), "m_draft");
  // The protections that actually bound this are authorship and freshness, NOT the lead's status —
  // so they must still hold on a closed thread. Without these, re-opening closed threads would
  // re-open the two holes the 8/16 authorship fix closed.
  const typedOnClosed = conv({ status: "closed" }, [CUSTOMER, { ...FRESH_DRAFT, actorUserName: "Scott Hartrich" }]);
  assert.equal(selectDraftsForClaudeReview({ conversations: [typedOnClosed], nowMs: NOW }).length, 0, "a PERSON's typed draft stays untouched on a closed thread too");
  const staleOnClosed = conv({ status: "closed" }, [CUSTOMER, { ...FRESH_DRAFT, at: new Date(NOW - 30 * 60 * MIN).toISOString() }]);
  assert.equal(selectDraftsForClaudeReview({ conversations: [staleOnClosed], nowMs: NOW }).length, 0, "the 24h ceiling still bounds closed threads — the old pile is not retro-reviewed");
  const ownRewriteOnClosed = conv({ status: "closed" }, [CUSTOMER, { ...FRESH_DRAFT, actorUserName: "Claude review" }]);
  assert.equal(selectDraftsForClaudeReview({ conversations: [ownRewriteOnClosed], nowMs: NOW }).length, 0, "the self-review loop guard survives on a closed thread");
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
  // Our own rewrite IS machine-written, and this says so honestly. What stops the rewrite-its-own-
  // rewrite loop is the selector's explicit guard, NOT a lie here. While this returned false the
  // guard was dead code: deleting it broke nothing and no eval failed.
  assert.equal(draftIsMachineAuthored({ actorUserName: "Claude review" }), true, "our own rewrite is machine-written — the loop is stopped by the explicit guard, not by mislabelling it");
  const autoRedraft = conv({ mode: "human" }, [CUSTOMER, { ...FRESH_DRAFT, actorUserName: "Auto-redraft (thumbs-down)" }]);
  assert.equal(selectDraftsForClaudeReview({ conversations: [autoRedraft], nowMs: NOW }).length, 1, "our own auto-redraft is reviewable on a human thread");
}

const NO_REVIEW: Array<[string, any]> = [
  ["the reviewer's own rewrite (loop guard — actor \"Claude review\")", conv({}, [CUSTOMER, { ...FRESH_DRAFT, actorUserName: "Claude review" }])],
  ["the reviewer's own rewrite on a HUMAN thread (loop guard survives the mode change)", conv({ mode: "human" }, [CUSTOMER, { ...FRESH_DRAFT, actorUserName: "Claude review" }])],
  ["a person's typed draft on a human thread", conv({ mode: "human" }, [CUSTOMER, { ...FRESH_DRAFT, actorUserName: "Scott Hartrich" }])],
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
  // --- the CAPABILITY bar (Maxie Johnson +17166036684, 2026-08-19 16:45) --------------------
  // The money rule above only ever covered NUMBERS. This reviewer rejected a co-signer draft for
  // not answering "financing for bad credit or credit building", then answered it itself: "we do
  // work with lenders that specialize in bad credit". A capability is not a number, so nothing
  // forbade it — and reviewDraftWithClaude cannot see dealer_profile.json or the inventory feed,
  // so it had no way to check. On the money path the failure mode is a promise the customer
  // discovers in person after being declined.
  //
  // MEASURED on the real turn before shipping, 5 runs each at temperature 0:
  //   current prompt ....... 5/5 asserted a dealership credit capability
  //                          ("our finance team works with all kinds of credit situations")
  //   with these two rules . 0/5 — every run routed to the finance manager without
  //                          characterising what the dealership can do
  // That matches the reply Joe wrote by hand on the same thread at 16:54.
  //
  // ⚠️ The FIRST detector used to measure this scored the baseline 0/5, because it demanded the
  // words "lender"/"bad credit"/"program" — the one phrasing seen once. Every baseline run was in
  // fact making the same claim in softer words. Pinning the bug's TEXT instead of its CLASS is the
  // recurring trap; if you re-measure, detect the claim, not the sentence.
  assert.ok(
    prompt.includes("The same bar covers WHAT THE DEALERSHIP DOES"),
    "the no-invented-capability rule must stay — a program/lender/policy is not a number"
  );
  assert.ok(
    prompt.includes("never assert a program, partnership, lender"),
    "the rule must name what may not be asserted, not gesture at it"
  );
  assert.ok(
    prompt.includes("You cannot see the") && prompt.includes("dealer profile or the inventory feed"),
    "the reviewer must be told WHY it cannot know — it has neither source in context"
  );
  assert.ok(
    /ACKNOWLEDGES the question and says the right person will confirm/.test(prompt),
    "the prescribed repair is a hand-off; a reviewer may name a gap it cannot fill, never fill it"
  );
  assert.ok(
    prompt.includes("gets a hand-off to the finance manager, never"),
    "the bad-credit case is named outright — it is the production turn this rule exists for"
  );
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
  // The no-verdict path still returns the `keep` sentinel and still stops there. (It also counts a
  // transport failure toward the breaker now, so the shape is a block rather than a one-liner —
  // what matters is that it RETURNS before the verdict is read, never that it is one line.)
  const noVerdict = src0.slice(src0.indexOf("if (!parsed)"), src0.indexOf("const verdict = String(parsed?.verdict"));
  assert.ok(noVerdict.includes("return keep;"), "an unparseable reply is not a verdict — it must never read as ok");
  assert.ok(!noVerdict.includes('"ok"'), "and it must not manufacture an ok verdict on the way out");
}

// --- The continuous-improvement wiring: every rewrite files a work order ---------------------
{
  const src = fs.readFileSync(path.resolve("services/api/src/domain/claudeDraftReview.ts"), "utf8");
  const rewriteBlock = src.slice(src.indexOf('verdict.verdict === "rewrite"'), src.indexOf("(conv as any).claudeDraftReview ="));
  assert.ok(rewriteBlock.includes("saveOperatorDraft"), "a rewrite supersedes via the operator-draft mechanism (draft-only, never a send)");
  assert.ok(rewriteBlock.includes("addOpsAnomaly"), "a rewrite ALWAYS files a work order for the repair loop — the instance heal becomes a class investigation");
  assert.ok(rewriteBlock.includes('actor: { userName: "Claude review" }'), "the superseding draft is attributed so staff know who wrote it");
}

// --- THE EMAIL LANE (2026-08-17) --------------------------------------------------------------
// `conv.emailDraft` is a live, sendable draft the console's Email tab renders and staff send
// verbatim — and nothing had ever reviewed one (227 conversations carry one; 95 still offered as
// sendable). It has no timestamp, no message id and (until this change) no author, so each SMS
// guard needed a working equivalent rather than a copy.
{
  const emailConv = (over: Record<string, unknown>) =>
    conv({ emailDraft: "Hi Dave,\nThanks for your credit application. Our finance team will reach out shortly.\nAlexandra", ...over }, [CUSTOMER]);

  assert.equal(selectEmailDraftsForClaudeReview({ conversations: [emailConv({})], nowMs: NOW }).length, 1, "a fresh machine-written email draft IS reviewed — the lane nobody was watching");

  // The DISPLAY referee decides what staff are offered; a draft it withholds needs no reviewer.
  assert.equal(selectEmailDraftsForClaudeReview({ conversations: [emailConv({ status: "closed" })], nowMs: NOW }).length, 0, "a suppressed (closed/sold) email draft is not reviewed — staff are not being offered it");
  assert.equal(selectEmailDraftsForClaudeReview({ conversations: [emailConv({ emailDraft: "   " })], nowMs: NOW }).length, 0, "an empty email draft is not reviewed");

  // Authorship: the email lane's equivalent of the SMS actor gate.
  assert.equal(selectEmailDraftsForClaudeReview({ conversations: [emailConv({ emailDraftActor: "Scott Hartrich" })], nowMs: NOW }).length, 0, "an email a PERSON typed is theirs — never rewritten");
  assert.equal(selectEmailDraftsForClaudeReview({ conversations: [emailConv({ emailDraftActor: "Claude review" })], nowMs: NOW }).length, 0, "the reviewer never re-reviews its own email rewrite (explicit loop guard)");

  // Freshness is proxied by THREAD activity: emailDraft has no `at` of its own, and conv.updatedAt
  // churns every ~60s from the cadence realign heal, so it can never be the signal.
  const coldThread = conv({ emailDraft: "Hi Dave,\nStill here when you're ready.\nAlexandra" }, [
    { ...CUSTOMER, at: new Date(NOW - 80 * 60 * MIN).toISOString() }
  ]);
  assert.equal(selectEmailDraftsForClaudeReview({ conversations: [coldThread], nowMs: NOW }).length, 0, "a dormant thread's email draft is out of scope — no timestamp means thread activity is the only freshness signal");

  // The receipt is a body HASH (no message id exists to key on).
  const reviewed = emailConv({});
  const hash = emailDraftReviewHash(String(reviewed.emailDraft));
  reviewed.claudeEmailDraftReview = { hash, verdict: "ok", at: "2026-08-15T11:00:00Z" };
  assert.equal(selectEmailDraftsForClaudeReview({ conversations: [reviewed], nowMs: NOW }).length, 0, "an already-stamped email draft is not reviewed twice");
  reviewed.emailDraft = String(reviewed.emailDraft) + " P.S. we also have the Road Glide.";
  assert.equal(selectEmailDraftsForClaudeReview({ conversations: [reviewed], nowMs: NOW }).length, 1, "…but an EDITED email draft is a new draft and comes back for review");

  const many = Array.from({ length: 6 }, (_, i) => emailConv({ id: `+1555100${i}` }));
  assert.equal(selectEmailDraftsForClaudeReview({ conversations: many, nowMs: NOW }).length, CLAUDE_EMAIL_DRAFT_REVIEW_MAX_PER_TICK_DEFAULT, "the email per-tick budget holds, separate from the SMS one so neither starves the other");
}

// --- EXECUTED, not asserted-by-source: the two guards that would silently rot ------------------
// #721 shipped inert because its eval asserted that a CALL happened and never what it was called
// WITH. Both of these run the real store.
{
  // 1) THE LOOP GUARD. The receipt must record what is STORED AFTER the pass. Stamping the hash of
  //    the text we REVIEWED would leave our own rewrite unstamped, and the next tick would review
  //    it, rewrite it, and repeat — one API call a minute, forever.
  const original = "Hi Dave,\nOur finance team will reach out shortly.\nAlexandra";
  const rewritten = "Hi Dave,\nYou're approved — Scott will call today to finish up.\nAlexandra";
  assert.notEqual(emailDraftReviewHash(original), emailDraftReviewHash(rewritten), "a rewrite changes the hash, so the OLD hash cannot stamp the NEW text");
  const loopConv = conv({ emailDraft: rewritten, emailDraftActor: null }, [CUSTOMER]);
  loopConv.claudeEmailDraftReview = { hash: emailDraftReviewHash(original), verdict: "rewrite", at: "2026-08-17T14:00:00Z" };
  assert.equal(selectEmailDraftsForClaudeReview({ conversations: [loopConv], nowMs: NOW }).length, 1, "PROOF the stale-hash bug would loop: stamping the reviewed text leaves our own rewrite selectable");
  loopConv.claudeEmailDraftReview = { hash: emailDraftReviewHash(rewritten), verdict: "rewrite", at: "2026-08-17T14:00:00Z" };
  assert.equal(selectEmailDraftsForClaudeReview({ conversations: [loopConv], nowMs: NOW }).length, 0, "stamping the STORED text closes the loop");
}
{
  // 2) THE CROSS-CHANNEL GUARD. saveOperatorDraft discards pending drafts before it reaches the
  //    email branch, so an email fix would mark a perfectly good pending SMS draft stale.
  const c = upsertConversationByLeadKey("+17165550377", "suggest");
  appendOutbound(c, "salesperson", c.leadKey, "Saturday at 10 works — see you then!", "draft_ai");
  assert.ok(getLatestPendingDraft(c), "SMS draft seeded");
  saveOperatorDraft(c, {
    body: "Hi Dave,\nCorrected email.\nAlexandra",
    channel: "email",
    actor: { userName: "Claude review" },
    keepPendingDraftsOnOtherChannel: true
  });
  assert.ok(getLatestPendingDraft(c), "an EMAIL fix must NOT discard the pending SMS draft — the appointment time survives");
  assert.equal(String(c.emailDraft), "Hi Dave,\nCorrected email.\nAlexandra", "the email draft was actually replaced");
  assert.equal(String((c as any).emailDraftActor), "Claude review", "the email rewrite is attributed, which is also what stops it being re-reviewed");

  // The default is unchanged: a human operator taking the thread over still supersedes both.
  const c2 = upsertConversationByLeadKey("+17165550388", "suggest");
  appendOutbound(c2, "salesperson", c2.leadKey, "Saturday at 10 works — see you then!", "draft_ai");
  saveOperatorDraft(c2, { body: "Hi Dave,\nMine now.\nScott", channel: "email", actor: { userName: "Scott Hartrich" } });
  assert.equal(getLatestPendingDraft(c2), null, "default behaviour is untouched — an operator's email still supersedes the SMS draft");
  assert.equal(String((c2 as any).emailDraftActor), "Scott Hartrich", "an operator's email draft is stamped with their name, putting it out of the reviewer's reach");
}
{
  // The email rewrite files a work order and never reaches across channels.
  const src = fs.readFileSync(path.join(process.cwd(), "services/api/src/domain/claudeDraftReview.ts"), "utf8");
  const emailBlock = src.slice(src.indexOf("for (const { conv, draft, hash } of emailPicks)"), src.indexOf("(conv as any).claudeEmailDraftReview ="));
  assert.ok(emailBlock.includes("keepPendingDraftsOnOtherChannel: true"), "the email rewrite must not discard the other channel's draft");
  assert.ok(emailBlock.includes("addOpsAnomaly"), "an email rewrite files a work order too — the instance heal becomes a class investigation");
  // The receipt must hash what is STORED. DERIVED, not spelled: this line used to pin
  // `emailDraftReviewHash(verdict.fixedDraft)` literally, and that spelling went stale the moment
  // the stored body became a guarded copy of the rewrite (the charter C1.2a post-check,
  // `enforceNoReintroduction`). Whatever expression the lane SAVES as the body is the one it must
  // hash — hashing anything else leaves our own rewrite unstamped and re-reviewed once a minute.
  const savedEmailBody = /saveOperatorDraft\(conv, \{\s*body: ([A-Za-z0-9_.]+),/.exec(emailBlock)?.[1] ?? "";
  assert.ok(savedEmailBody, "the email rewrite must save a body");
  assert.ok(
    emailBlock.includes(`emailDraftReviewHash(${savedEmailBody})`),
    "the receipt stamps the STORED text, not the reviewed text"
  );
}

// --- THE BREAKER (measured 2026-08-20: 587 doomed calls in one day) --------------------------
// The account ran dry at ~11:34Z and this per-minute lane retried regardless: 446 SMS attempts over
// 15 drafts (135 on ONE draft) + 141 email attempts over 3. No backoff, no cap, no give-up. The
// expensive half is not the noise — it is that every queued retry becomes a REAL PAID CALL the
// moment the balance is topped up. Executed, not read.
{
  const T0 = Date.parse("2026-08-20T11:34:00.000Z");
  const MIN = 60_000;
  resetClaudeReviewBreaker();

  assert.equal(claudeReviewBreakerIsOpen(T0), false, "a healthy lane is never held");
  // Below the trip point the lane keeps trying — a one-minute blip must not silence the reviewer.
  for (let i = 1; i < CLAUDE_REVIEW_BREAKER_TRIP_AFTER_DEFAULT; i += 1) {
    recordClaudeReviewTransportFailure(T0 + i * MIN);
    assert.equal(claudeReviewBreakerIsOpen(T0 + i * MIN), false, `still trying after ${i} failure(s)`);
  }
  // The Nth consecutive transport failure trips it.
  recordClaudeReviewTransportFailure(T0 + CLAUDE_REVIEW_BREAKER_TRIP_AFTER_DEFAULT * MIN);
  const tripAtMs = T0 + CLAUDE_REVIEW_BREAKER_TRIP_AFTER_DEFAULT * MIN;
  assert.equal(claudeReviewBreakerIsOpen(tripAtMs), true, "the Nth consecutive transport failure holds the lane");
  assert.equal(claudeReviewBreakerIsOpen(tripAtMs + MIN), true, "and it stays held a minute later");

  // THE MEASUREMENT THAT MOTIVATED IT: 135 retries on one draft over the real outage window becomes
  // one probe per cooldown. Replay the actual 7h35m (11:34Z -> 19:09Z) minute by minute.
  resetClaudeReviewBreaker();
  let paidCalls = 0;
  for (let m = 0; m <= 455; m += 1) {
    const now = T0 + m * MIN;
    if (claudeReviewBreakerIsOpen(now)) continue; // held: no request is built, nothing is spent
    paidCalls += 1;
    recordClaudeReviewTransportFailure(now); // the account is dry — every attempt fails
  }
  // 456 minutes of dead service. Before: 456 attempts on this lane (the live log recorded 446).
  console.log(`   breaker: a 456-minute outage costs ${paidCalls} calls instead of 456`);
  assert.ok(paidCalls <= 40, `a 7h35m outage must cost tens of calls, not hundreds — got ${paidCalls}`);
  assert.ok(paidCalls >= 5, `it must keep probing, not go silent forever — got ${paidCalls}`);

  // Recovery: a real verdict proves the service is alive and clears everything, so the very next
  // draft is reviewed normally. Without this the top-up would not un-stick the lane until a deploy.
  resetClaudeReviewBreaker();
  let openedAt = T0;
  for (let i = 0; i < CLAUDE_REVIEW_BREAKER_TRIP_AFTER_DEFAULT; i += 1) {
    openedAt = T0 + i * MIN; // the LAST of these is the failure that trips it
    recordClaudeReviewTransportFailure(openedAt);
  }
  assert.equal(claudeReviewBreakerIsOpen(openedAt), true, "held after the trip");
  // Cooldown elapses -> exactly one probe is let through...
  const afterCooldown = openedAt + CLAUDE_REVIEW_BREAKER_COOLDOWN_MS_DEFAULT + MIN;
  assert.equal(claudeReviewBreakerIsOpen(afterCooldown), false, "the cooldown lets one probe through");
  // ...and if THAT probe fails, it re-opens immediately rather than letting a storm back in.
  recordClaudeReviewTransportFailure(afterCooldown);
  assert.equal(claudeReviewBreakerIsOpen(afterCooldown), true, "a failed probe re-holds the lane at once");
  // ...whereas a verdict closes it for good.
  recordClaudeReviewSuccess();
  assert.equal(claudeReviewBreakerIsOpen(afterCooldown), false, "a verdict re-opens the lane");
  assert.equal(claudeReviewBreakerSnapshot().consecutiveFailures, 0, "a verdict clears the failure run");
  resetClaudeReviewBreaker();
}
{
  const src = fs.readFileSync(path.join(process.cwd(), "services/api/src/domain/claudeDraftReview.ts"), "utf8");
  const fn = src.slice(src.indexOf("export async function reviewDraftWithClaude"), src.indexOf("export async function processClaudeDraftReview"));
  // The breaker must answer BEFORE the request is built — a check after the call saves nothing.
  const breakerIdx = fn.indexOf("claudeReviewBreakerIsOpen(");
  assert.ok(breakerIdx > 0, "reviewDraftWithClaude consults the breaker");
  assert.ok(breakerIdx < fn.indexOf("anthropicMessagesRequest("), "the breaker answers before the paid request is built");
  // Only TRANSPORT failures count. A reviewer that answers "ok" is a live service, not a failure —
  // counting verdicts would hold the lane during perfectly healthy quiet periods.
  assert.ok(fn.includes("recordClaudeReviewSuccess()"), "a verdict clears the breaker");
  assert.ok(
    fn.indexOf("recordClaudeReviewSuccess()") < fn.indexOf('const verdict = String(parsed?.verdict'),
    "the reset happens as soon as the service ANSWERS, before the verdict is even read"
  );
  // THE PROPERTY THIS MUST NOT BREAK (PR #711): a held call returns the same `keep` every other
  // failure returns, so the caller still records *_unavailable and leaves the draft UNSTAMPED for
  // the 4-hourly human backstop. Cutting the call must never cut the visibility.
  assert.ok(
    fn.includes("if (claudeReviewBreakerIsOpen(args.nowMs ?? Date.now())) return keep;"),
    "a held call returns the SAME keep sentinel — it must stay unstamped and still be reported unavailable"
  );
  const proc = src.slice(src.indexOf("export async function processClaudeDraftReview"));
  assert.equal(
    (proc.match(/deps\.recordOutcome\("claude_(?:email_)?draft_review_unavailable"/g) ?? []).length,
    2,
    "both channels still report unavailable — a held lane must read as DOWN, never as quiet"
  );
}

// --- Three-point lane registration (a task missing anywhere silently never runs) -------------
assert.ok((WORKER_TICK_TASKS as readonly string[]).includes("claude-draft-review"), "registered tick task");
assert.ok((WORKER_MINUTE_LANE_TASKS as readonly string[]).includes("claude-draft-review"), "on the API minute lane");
const minuteSchedule = WORKER_SCHEDULES.find(s => s.cron === "* * * * *");
assert.ok(minuteSchedule && minuteSchedule.tasks.includes("claude-draft-review"), "on the worker minute schedule");

console.log("PASS claude_draft_review:eval — SMS selection table (4 review-cases incl. sold/closed + 9 holds + cap) + EMAIL selection table, executed loop guard + cross-channel guard, kill switch, prompt rules, work-order wiring, 3-point lane registration, breaker replayed over the real 2026-08-20 outage");
