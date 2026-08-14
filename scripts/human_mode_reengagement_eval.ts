/**
 * human_mode_reengagement:eval — pins the Logan Hazel class (Joe, 2026-07-17, +12109976639).
 *
 * A staff member took the thread over (manual takeover → conv.mode="human"), which correctly
 * SUPPRESSES the auto-draft. But Logan then texted a substantive re-engagement — "trade my 2020
 * Breakout toward a Road Glide and cover the difference" + "look at the newer models" — and the
 * live /webhooks/twilio human-mode branch produced NO draft AND NO task: nothing in the inbox but
 * the activity bump, so a hot lead silently stalled.
 *
 * The fix: at the human-mode block terminus (the fall-through empty-Response return), when the
 * inbound is substantive (not a short-ack/reaction — opt-out and disposition closeouts already
 * returned above) and was not already surfaced as an inventory watch, hand the lead OWNER a
 * "needs YOUR reply" follow-up task — mirroring owner_thread_step_back. This is a deterministic
 * side-effect (AGENTS.md permits deterministic side-effects/state) and fail-safe by direction: a
 * redundant task is cheap; the current false-negative drops the lead. addTodo merges by
 * (conv, open, "followup") so repeat inbounds refresh one task instead of stacking.
 *
 * WHICH TURNS COUNT AS "SUBSTANTIVE" — Joe ruled 2026-08-13: the BARE reading, not the wide one.
 *
 * Until then the exclusion was `isShortAckText`, a word list that asks only "does a courtesy word
 * appear anywhere in a short sentence?". It swallowed whole messages that happened to end politely,
 * and on a thread a rep already owns that means the rep is told nothing at all. Measured on the live
 * store the day of the ruling: 39 human-mode inbound turns in 44 days (~0.9/day) were short-ack but
 * NOT bare, and they include
 *
 *   "Ok. Friday. Afternoon"                                (a day + day-part — a soft commitment)
 *   "Found a better offer. Thanks"                         (a lost sale, +13105956498)
 *   "Oh okay I get out at 3 joe I should be able to stop today"
 *   "Joe, theirs 62,500 miles on it. Thanks"               (an appraisal fact we asked for)
 *
 * plus courteous sign-offs ("Not a problem, sir thank you") that will now also raise a task. That
 * cost is bounded and was accepted deliberately: `taskFulfillmentAutoClose` closes a
 * "needs YOUR reply" task the moment the rep's next outbound goes out (43 ever / 0 open, median
 * close 2.7 min), and addTodo merges by (conv, open, "followup") so repeats refresh one row.
 *
 * The gate is now `!humanModeDispositionShortAck` — isBareAcknowledgementText, which requires that
 * NOTHING be left once courtesy words and filler are stripped. "Awesome" and "Ok thanks" stay
 * silent (+17169400722, PR #695); anything carrying content reaches the owner. The two PARSER
 * eligibility gates above keep the wide `humanModeShortAck`: they are cost gates deciding whether
 * to spend an LLM call, and widening those buys nothing.
 *
 * Pins (source-guard — the arm is inline wiring, not a pure decision fn):
 *  1. The terminus surfaces the task: addTodo("call", ..., conv.leadOwner, "followup") + records
 *     the route outcome, gated on !BARE-ack AND !watch-handled.
 *  2. It NEVER auto-drafts on this path (no publishLiveTwilioReply between the task and the
 *     empty-Response return).
 *  3. The watch-handled flag is declared and set inside the watch arm, so a watch-set turn does
 *     not double-task.
 *  4. The ack exclusion uses the canonical helpers, never a bespoke regex — and the TASK gate reads
 *     the bare one while the parser cost gates keep the wide one. Both halves are pinned, because
 *     collapsing them back into one predicate is exactly how this regresses.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { decideHumanModeWatchClaim } from "../services/api/src/domain/humanModeWatchClaim.ts";

const apiIndex = fs.readFileSync(path.join(process.cwd(), "services/api/src/index.ts"), "utf8");

// --- Locate the human-mode re-engagement backstop terminus block ---
const anchor = "Human-mode re-engagement backstop: staff has the wheel";
const armStart = apiIndex.indexOf(anchor);
assert.ok(armStart >= 0, "the human-mode re-engagement backstop comment anchor is present at the terminus");
// Bound the block to the fall-through empty-Response return that closes the human-mode branch.
const afterAnchor = apiIndex.slice(armStart);
const returnIdx = afterAnchor.indexOf("<Response></Response>");
assert.ok(returnIdx >= 0, "the backstop is followed by the fall-through empty-Response return");
const armBlock = afterAnchor.slice(0, returnIdx + 200);

// 1. Surfaces a call/followup task to the OWNER + records the route outcome.
assert.ok(
  /addTodo\(\s*conv,\s*"call",[\s\S]{0,400}"followup"/.test(armBlock),
  "the terminus hands the OWNER a call/followup task"
);
assert.ok(armBlock.includes("conv.leadOwner"), "the task is assigned to the lead owner");
assert.ok(armBlock.includes("event.providerMessageId"), "the task carries the inbound message id (addTodo merge/source key)");
assert.ok(/needs YOUR reply/i.test(armBlock), "the task summary flags it needs the owner's reply");
assert.ok(
  armBlock.includes('recordRouteOutcome("live", "human_mode_reengagement_reply_needed"'),
  "the arm records the human_mode_reengagement_reply_needed route outcome"
);

// 1b. Gated on NOT a BARE ack AND NOT already handled as a watch. The wide predicate here would
// swallow "Ok. Friday. Afternoon" and tell the rep nothing (Joe, 2026-08-13).
assert.ok(
  armBlock.includes("!humanModeDispositionShortAck"),
  "the task is skipped only for BARE acks/reactions, not any short polite sentence"
);
assert.ok(
  !armBlock.includes("!humanModeShortAck"),
  "the wide short-ack predicate must not gate the owner task — it hides substantive turns"
);
assert.ok(
  armBlock.includes("!humanModeInventoryWatchHandled"),
  "the task is skipped when the turn was already surfaced as an inventory watch"
);
assert.ok(
  armBlock.includes('event.provider === "twilio"'),
  "the backstop is scoped to the twilio (SMS) inbound path"
);

// 2. It NEVER auto-drafts on this path — the human takeover must not be overridden by the AI.
assert.ok(
  !armBlock.includes("publishLiveTwilioReply"),
  "the human-mode backstop creates a task only — it never composes/sends a customer-facing reply"
);

// 3. The watch-handled flag is set on the PARSER-LED CLAIM, never on the eligibility hint.
//
// Until 2026-08-14 this pin asserted the flag was set in the arm HEAD — which pinned the bug:
// the hint's "thread has a watch at all" leg meant every message from a watch-carrying customer
// was marked "already surfaced as a watch", and the reply-needed backstop below never fired
// (Rick Williamson +17168609581: a pure finance question mid-negotiation, 16h of silence; 24
// human-mode threads carried a watch; the reply-needed outcome fired for NOBODY 7/25→8/14).
// The claim decision is decideHumanModeWatchClaim (domain/humanModeWatchClaim.ts), executed
// below as a decision table; these source pins hold the WIRING to it.
assert.ok(
  /let humanModeInventoryWatchHandled = false;/.test(apiIndex),
  "humanModeInventoryWatchHandled is declared (default false) in the human-mode block"
);
const watchArmStart = apiIndex.indexOf("if (humanModeWatchParserEligible && humanModeWatchHint) {");
assert.ok(watchArmStart >= 0, "the human-mode inventory-watch arm exists");
const watchArmHead = apiIndex.slice(watchArmStart, watchArmStart + 600);
assert.ok(
  !watchArmHead.includes("humanModeInventoryWatchHandled = true;"),
  "the watch arm must NOT mark the turn handled at hint time — that silences the reply-needed backstop for every watch-carrying thread"
);
const watchClaimIdx = apiIndex.indexOf("const humanModeWatchIntent = decideHumanModeWatchClaim({");
assert.ok(watchClaimIdx >= 0, "the watch arm asks decideHumanModeWatchClaim for the claim verdict");
const watchClaimBlock = apiIndex.slice(watchClaimIdx, watchClaimIdx + 700);
assert.ok(
  /if \(humanModeWatchIntent\) \{\s*\n\s*humanModeInventoryWatchHandled = true;/.test(watchClaimBlock),
  "the handled flag is set exactly when the claim verdict is true — the branch that actually writes watch state"
);

// 3b. The claim decision itself, EXECUTED (Rick's shape must not be claimed).
{
  // Rick +17168609581: finance question, no bike named — semantic parse reads no watch action.
  assert.equal(
    decideHumanModeWatchClaim({
      demoDayQuestion: false,
      semanticWatchAction: "none",
      inboundParserWatchAcknowledgement: false,
      semanticConfident: true,
      fallbackAllowed: true,
      watchConfirmationText: false
    }),
    false,
    "a turn the parser read as NO watch action is not claimed — the reply-needed backstop must fire (Rick +17168609581)"
  );
  // The mere existence of a watch on the thread is NOT an input to the claim at all — the
  // interface has no such field, which is the point. A watch-set turn IS claimed:
  assert.equal(
    decideHumanModeWatchClaim({
      demoDayQuestion: false,
      semanticWatchAction: "set_watch",
      inboundParserWatchAcknowledgement: false,
      semanticConfident: true,
      fallbackAllowed: false,
      watchConfirmationText: false
    }),
    true,
    "a parser-read set_watch turn is claimed (no double task)"
  );
  assert.equal(
    decideHumanModeWatchClaim({
      demoDayQuestion: false,
      semanticWatchAction: "none",
      inboundParserWatchAcknowledgement: true,
      semanticConfident: false,
      fallbackAllowed: false,
      watchConfirmationText: false
    }),
    true,
    "an inbound-reply-action watch acknowledgement is claimed"
  );
  assert.equal(
    decideHumanModeWatchClaim({
      demoDayQuestion: false,
      semanticWatchAction: "none",
      inboundParserWatchAcknowledgement: false,
      semanticConfident: false,
      fallbackAllowed: true,
      watchConfirmationText: true
    }),
    true,
    "the audited low-confidence fallback confirmation lane still claims"
  );
  assert.equal(
    decideHumanModeWatchClaim({
      demoDayQuestion: false,
      semanticWatchAction: "none",
      inboundParserWatchAcknowledgement: false,
      semanticConfident: true,
      fallbackAllowed: true,
      watchConfirmationText: true
    }),
    false,
    "a CONFIDENT no-watch parse outranks the deterministic confirmation text (comprehend, never regex)"
  );
  assert.equal(
    decideHumanModeWatchClaim({
      demoDayQuestion: true,
      semanticWatchAction: "set_watch",
      inboundParserWatchAcknowledgement: true,
      semanticConfident: true,
      fallbackAllowed: true,
      watchConfirmationText: true
    }),
    false,
    "demo-day questions are never the watch arm's turn"
  );
}

// 4. The ack exclusions use the canonical comprehension-safe helpers, never a bespoke regex, and
//    the two families stay SEPARATE: the wide predicate is a cost gate for the parsers, the bare
//    one gates the owner's task. `humanModeShortAck` still exists and still folds the bare reading
//    in, so a bare turn skips the parser spend too — it just no longer decides the task.
assert.ok(
  apiIndex.includes(
    "const humanModeShortAck = isShortAckText(humanModeText) || isEmojiOnlyText(humanModeText) || humanModeDispositionShortAck;"
  ),
  "the short-ack gate reuses the canonical isShortAckText/isEmojiOnlyText helpers plus the bare-ack reading"
);
// The parser cost gates keep the wide predicate — widening those buys nothing but LLM spend.
assert.ok(
  apiIndex.includes("!humanModeShortAck;"),
  "the parser eligibility gates still read the wide short-ack predicate"
);

console.log(
  "PASS human-mode re-engagement eval — a substantive customer reply on a human-taken-over thread surfaces a 'needs YOUR reply' owner task (no auto-draft), and a watch-set turn does not double-task"
);
