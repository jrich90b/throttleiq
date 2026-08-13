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

// 3. The watch-handled flag is declared once and set inside the watch arm (prevents double-tasking).
assert.ok(
  /let humanModeInventoryWatchHandled = false;/.test(apiIndex),
  "humanModeInventoryWatchHandled is declared (default false) in the human-mode block"
);
const watchArmStart = apiIndex.indexOf("if (humanModeWatchParserEligible && humanModeWatchHint) {");
assert.ok(watchArmStart >= 0, "the human-mode inventory-watch arm exists");
const watchArmHead = apiIndex.slice(watchArmStart, watchArmStart + 200);
assert.ok(
  watchArmHead.includes("humanModeInventoryWatchHandled = true;"),
  "the watch arm marks the turn handled so the terminus does not also task it"
);

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
