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
 * Pins (source-guard — the arm is inline wiring, not a pure decision fn):
 *  1. The terminus surfaces the task: addTodo("call", ..., conv.leadOwner, "followup") + records
 *     the route outcome, gated on !short-ack AND !watch-handled.
 *  2. It NEVER auto-drafts on this path (no publishLiveTwilioReply between the task and the
 *     empty-Response return).
 *  3. The watch-handled flag is declared and set inside the watch arm, so a watch-set turn does
 *     not double-task.
 *  4. The short-ack exclusion uses the canonical isShortAckText/isEmojiOnlyText helpers.
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

// 1b. Gated on NOT a short-ack AND NOT already handled as a watch.
assert.ok(armBlock.includes("!humanModeShortAck"), "the task is skipped for short-acks/reactions");
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

// 4. The short-ack exclusion uses the canonical comprehension-safe helpers, never a bespoke regex.
assert.ok(
  /const humanModeShortAck = isShortAckText\(humanModeText\) \|\| isEmojiOnlyText\(humanModeText\);/.test(apiIndex),
  "the short-ack gate reuses the canonical isShortAckText/isEmojiOnlyText helpers"
);

console.log(
  "PASS human-mode re-engagement eval — a substantive customer reply on a human-taken-over thread surfaces a 'needs YOUR reply' owner task (no auto-draft), and a watch-set turn does not double-task"
);
