/**
 * Intent-handled human-mode exclusion eval.
 *
 * WHAT BROKE (2026-08-12, Rich Retzlaff +17168640008). Joe left a thumbs-down note asking for a
 * specific wording. A person typed that exact sentence and sent it 42 seconds later. The nightly
 * intent-handled judge then graded the person's sentence as an agent comprehension miss and it
 * arrived in `next.json` as a Tier-1 `intent_unaddressed` work order. BOTH of that night's two
 * findings were this class, and over 30 days 225 of 323 judged turns were human-mode threads.
 *
 * THE RULE. `conv.mode === "human"` is manual takeover: `/conversations/:id/regenerate` returns
 * `human_override` and the inbound handler's human-mode branch sends nothing, so an outbound that
 * reached the customer there is a person's own words. Every sibling scorer already skips those
 * turns (tone/reply-coverage `c5ae6e32`, `open_critic_human_send_exclusion:eval`,
 * `corpus_replay_human_mode_silence:eval`); this judge was the one that never got the guard.
 *
 * WHAT THIS PINS, and why it EXECUTES rather than greps: a source-text assertion cannot prove the
 * selector still calls the predicate (`scripts/` is outside tsc). So this runs the real
 * `selectIntentJudgeCandidates` over a synthetic store and asserts WHICH turns survive — in
 * particular that the agent's own words stay graded on a human-owned thread, which is the failure
 * mode a blanket thread-level skip would introduce.
 *
 * Clock-safe: every timestamp is built relative to now.
 */
import assert from "node:assert/strict";

import { isHumanModeStaffReply } from "../services/api/src/domain/scoringExclusions.ts";
import { selectIntentJudgeCandidates } from "./intent_handled_audit.ts";

// ---------------------------------------------------------------- the predicate

assert.equal(
  isHumanModeStaffReply({ conversationMode: "human", reply: { provider: "twilio" } }),
  true,
  "a staff send on a human-owned thread is not agent output"
);
assert.equal(
  isHumanModeStaffReply({ conversationMode: "HUMAN", reply: { provider: "sendgrid" } }),
  true,
  "mode comparison must be case-insensitive"
);
assert.equal(
  isHumanModeStaffReply({ conversationMode: "human", reply: { provider: "human" } }),
  true,
  "provider human on a human-owned thread is a person's words"
);
assert.equal(
  isHumanModeStaffReply({ conversationMode: "human", reply: { provider: "draft_ai" } }),
  false,
  "a live agent draft is agent output no matter who owns the thread"
);
assert.equal(
  isHumanModeStaffReply({ conversationMode: "human", reply: { provider: "twilio", authoredBy: "agent" } }),
  false,
  "an APPROVED agent draft (authoredBy agent) stays graded on a human-owned thread"
);
assert.equal(
  isHumanModeStaffReply({ conversationMode: "suggest", reply: { provider: "twilio" } }),
  false,
  "suggest mode is the agent's own lane — never skipped by this rule"
);
assert.equal(
  isHumanModeStaffReply({ conversationMode: undefined, reply: { provider: "twilio" } }),
  false,
  "an unset mode must not skip anything (fail toward grading)"
);
assert.equal(
  isHumanModeStaffReply({ conversationMode: "human", reply: null }),
  false,
  "no reply, nothing to exclude"
);
// The marker that records who clicked Send is NOT the discriminator: an approved-unedited agent
// draft carries actorUserId too, so keying on it would blind the judge to the most common way an
// agent message reaches a customer in suggest mode.
assert.equal(
  isHumanModeStaffReply({
    conversationMode: "suggest",
    reply: { provider: "twilio", authoredBy: "agent" }
  } as any),
  false,
  "suggest-mode agent sends stay graded"
);

// ------------------------------------------------------- the selector, executed

const now = Date.now();
const t = (minutesAgo: number) => new Date(now - minutesAgo * 60_000).toISOString();

const convs = [
  {
    // Production shape: the staff-typed reply the judge filed a Tier-1 miss against.
    id: "human_owned",
    mode: "human",
    messages: [
      { direction: "in", provider: "twilio", at: t(60), body: "I listed it for $12000 and dropped it to $10800 and have a few reach out now" },
      { direction: "out", provider: "twilio", at: t(55), body: "Ok, Let me know how you make out! Scott will be in tomorrow if you want to touch base with him." }
    ]
  },
  {
    // A live agent draft on a human-owned thread: still the agent's words, still graded.
    id: "human_owned_agent_draft",
    mode: "human",
    messages: [
      { direction: "in", provider: "twilio", at: t(50), body: "What do I have to do to reserve one" },
      { direction: "out", provider: "draft_ai", at: t(49), body: "I'll keep this tied to the 2026 Other trade and let you know when it's here." }
    ]
  },
  {
    // An APPROVED agent draft on a human-owned thread: authoredBy survives the send.
    id: "human_owned_approved_draft",
    mode: "human",
    messages: [
      { direction: "in", provider: "twilio", at: t(45), body: "Is the Road Glide still available?" },
      { direction: "out", provider: "twilio", authoredBy: "agent", at: t(44), body: "It is — want to come see it this week?" }
    ]
  },
  {
    // The ordinary suggest-mode turn this audit exists to grade. Untouched.
    id: "suggest_owned",
    mode: "suggest",
    messages: [
      { direction: "in", provider: "twilio", at: t(40), body: "What's the out-the-door price on the Street Glide?" },
      { direction: "out", provider: "twilio", at: t(39), body: "I'll keep an eye out and let you know when something comes in." }
    ]
  }
];

const { candidates, eligibleTotal, staffOwnedSkipped } = selectIntentJudgeCandidates(convs, {
  windowStartMs: now - 24 * 60 * 60 * 1000
});
const ids = candidates.map(c => c.convId).sort();
const expected = ["human_owned_agent_draft", "human_owned_approved_draft", "suggest_owned"];
assert.deepEqual(ids, expected, `judged turns should be ${JSON.stringify(expected)}, got ${JSON.stringify(ids)}`);
assert.equal(ids.includes("human_owned"), false, "the staff-typed reply must never reach the judge");
assert.equal(staffOwnedSkipped, 1, `staffOwnedSkipped should be 1, got ${staffOwnedSkipped}`);
assert.equal(eligibleTotal, 3, `an excluded turn is not eligible either; expected 3, got ${eligibleTotal}`);

// The exclusion must be COUNTED, not silent — the report line is how a future run notices the
// judge went quiet because the store went human-mode rather than because the agent got better.
assert.ok(
  Number.isInteger(staffOwnedSkipped),
  "selectIntentJudgeCandidates must return how many staff-owned turns it removed"
);

console.log("PASS intent-handled human-mode exclusion eval");
