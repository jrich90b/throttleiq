/**
 * Stale "needs reply" / held-flag reconcile eval (2026-06-25).
 *
 * A conversation flagged "the AI couldn't answer this in context" (conv.draftHeld) must drop the flag
 * once a real reply (human/twilio/sendgrid) has gone out — else the inbox shows "needs reply" forever
 * (s R Gurajala: a reply sent at 01:39 left the flag from 01:37 stuck). Pins both the reconcile heal
 * (the cron auto-check) and the finalizeDraftAsSent send-chokepoint clear, plus the wiring.
 *
 * Run: npx tsx scripts/stale_held_flag_heal_eval.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.CONVERSATIONS_DB_PATH =
  process.env.CONVERSATIONS_DB_PATH || path.join(os.tmpdir(), `stale-held-eval-${Date.now()}.json`);
const { appendOutbound, finalizeDraftAsSent, healStaleHeldFlag, upsertConversationByLeadKey } =
  await import("../services/api/src/domain/conversationStore.ts");

// --- 1) Reconcile heal: reply AFTER the hold => clear; otherwise keep. ---
const conv = upsertConversationByLeadKey("+17165550601", "suggest");
appendOutbound(conv, "salesperson", conv.leadKey, "Here are the links.", "twilio");
const replyAt = Date.parse(String(conv.messages[conv.messages.length - 1].at));

// STALE: held timestamp is BEFORE the sent reply => heal it.
(conv as any).draftHeld = {
  at: new Date(replyAt - 60_000).toISOString(),
  reason: "context_fidelity_out_of_context",
  heldKind: "context_fidelity"
};
assert.equal(healStaleHeldFlag(conv), true, "a hold that predates a real reply is healed");
assert.equal((conv as any).draftHeld, null, "the flag is cleared");

// NOT stale: held came AFTER the last reply (a fresh hold) => keep it.
(conv as any).draftHeld = { at: new Date(replyAt + 60_000).toISOString(), reason: "x", heldKind: "context_fidelity" };
assert.equal(healStaleHeldFlag(conv), false, "a hold newer than the last reply is kept");
assert.ok((conv as any).draftHeld, "fresh hold preserved");

// A pending draft_ai (NOT a sent reply) does not count as 'replied' — keep the hold.
const conv2 = upsertConversationByLeadKey("+17165550602", "suggest");
appendOutbound(conv2, "salesperson", conv2.leadKey, "draft only", "draft_ai");
(conv2 as any).draftHeld = { at: new Date(Date.now() - 60_000).toISOString(), reason: "x", heldKind: "context_fidelity" };
assert.equal(healStaleHeldFlag(conv2), false, "a draft_ai is not a real reply — hold kept");

// No hold => nothing to heal.
const conv3 = upsertConversationByLeadKey("+17165550603", "suggest");
assert.equal(healStaleHeldFlag(conv3), false, "no held flag => no-op");

// --- 2) Send chokepoint: finalizeDraftAsSent (console "Send" of a pending draft) clears the flag. ---
const conv4 = upsertConversationByLeadKey("+17165550604", "suggest");
const draft = appendOutbound(conv4, "salesperson", conv4.leadKey, "Sounds good — what time works?", "draft_ai")!;
(conv4 as any).draftHeld = { at: new Date().toISOString(), reason: "context_fidelity_out_of_context", heldKind: "context_fidelity" };
const fin = finalizeDraftAsSent(conv4, draft.id, "Sounds good — what time works?", "twilio", "SMxyz", { userName: "Joe" });
assert.equal(fin.usedDraft, true, "the draft was sent");
assert.equal((conv4 as any).draftHeld, null, "sending the draft cleared the held flag");

// --- 3) Source guards: heal exported + wired in the cron reconcile; send chokepoint clears. ---
const store = fs.readFileSync("services/api/src/domain/conversationStore.ts", "utf8");
assert.match(store, /export function healStaleHeldFlag/, "heal is exported");
const api = fs.readFileSync("services/api/src/index.ts", "utf8");
assert.match(api, /if \(healStaleHeldFlag\(conv\)\)/, "the maintenance reconcile runs the heal (cron auto-check)");
assert.match(api, /stale_held_flag_heal/, "route outcome recorded for the heal");

console.log("PASS stale held-flag heal eval (reconcile + send-chokepoint clear + wiring)");
