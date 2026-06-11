/**
 * Persona continuity eval — voice charter: once staff sends as themselves,
 * the thread's voice is theirs; AI must not silently reintroduce Alexandra.
 */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "persona-continuity-eval-"));
process.env.CONVERSATIONS_DB_PATH = path.join(tempDir, "conversations.json");

const { appendOutbound, finalizeDraftAsSent, limitEmDashStyle, upsertConversationByLeadKey } =
  await import("../services/api/src/domain/conversationStore.ts");

// Staff freehand send locks the persona to that staff member.
const freehand = upsertConversationByLeadKey("+17165553001", "suggest");
appendOutbound(
  freehand,
  "salesperson",
  freehand.leadKey,
  "Hey Sam, it's Scott at American H-D. I'll work up numbers and text you today.",
  "twilio",
  "SM_eval_persona_1",
  undefined,
  { userId: "u-scott", userName: "Scott Hartrich" }
);
assert.equal(freehand.manualSender?.userName, "Scott Hartrich");
assert.equal(freehand.manualSender?.source, "manual_send");

// Sending an unedited Alexandra-signed draft does NOT lock the persona.
const alexandraSend = upsertConversationByLeadKey("+17165553002", "suggest");
appendOutbound(
  alexandraSend,
  "salesperson",
  alexandraSend.leadKey,
  "Hi Sam — this is Alexandra at American Harley-Davidson. Thanks for reaching out.",
  "twilio",
  "SM_eval_persona_2",
  undefined,
  { userId: "u-scott", userName: "Scott Hartrich" }
);
assert.equal(alexandraSend.manualSender, undefined, "Alexandra-signed sends must not lock persona");

// AI drafts never lock the persona.
const draftOnly = upsertConversationByLeadKey("+17165553003", "suggest");
appendOutbound(
  draftOnly,
  "salesperson",
  draftOnly.leadKey,
  "Hey Sam, want photos of the Road Glide?",
  "draft_ai"
);
assert.equal(draftOnly.manualSender, undefined, "drafts must not lock persona");

// An existing lock is never overwritten by a later sender.
const locked = upsertConversationByLeadKey("+17165553004", "suggest");
appendOutbound(locked, "salesperson", locked.leadKey, "Hey Sam, Joe here at American H-D.", "twilio", "SM_eval_persona_4a", undefined, {
  userId: "u-joe",
  userName: "Joe Hartrich"
});
appendOutbound(locked, "salesperson", locked.leadKey, "Following up on those numbers.", "twilio", "SM_eval_persona_4b", undefined, {
  userId: "u-stone",
  userName: "Stone Giuga"
});
assert.equal(locked.manualSender?.userName, "Joe Hartrich", "first staff sender keeps the thread voice");

// The edit-a-draft-and-send path locks too.
const viaDraft = upsertConversationByLeadKey("+17165553005", "suggest");
const pending = appendOutbound(
  viaDraft,
  "salesperson",
  viaDraft.leadKey,
  "Hey Sam, want photos of the Road Glide?",
  "draft_ai"
);
assert.ok(pending);
finalizeDraftAsSent(
  viaDraft,
  pending!.id,
  "Hey Sam, Scott here. The Road Glide is on the floor, want photos?",
  "twilio",
  "SM_eval_persona_5",
  { userId: "u-scott", userName: "Scott Hartrich" }
);
assert.equal(viaDraft.manualSender?.userName, "Scott Hartrich", "finalizeDraftAsSent must lock persona");

// Em-dash diet: at most the first em-dash survives deterministic tone.
assert.equal(
  limitEmDashStyle("Got it — photos today — numbers tomorrow — sound good?"),
  "Got it — photos today, numbers tomorrow, sound good?"
);
assert.equal(limitEmDashStyle("No em dashes here."), "No em dashes here.");
assert.equal(
  limitEmDashStyle("One dash — and that's fine."),
  "One dash — and that's fine."
);
const dashConv = upsertConversationByLeadKey("+17165553006", "suggest");
const dashMsg = appendOutbound(
  dashConv,
  "salesperson",
  dashConv.leadKey,
  "Quick update — the bike cleared service — pictures attached — let me know.",
  "twilio",
  "SM_eval_persona_6"
);
assert.ok(dashMsg);
assert.equal(
  (dashMsg!.body.match(/—/g) ?? []).length <= 1,
  true,
  `outbound should carry at most one em-dash, got: "${dashMsg!.body}"`
);

// resolveConversationAgentName must keep honoring the manualSender lock.
const apiSource = await fs.readFile(path.resolve("services/api/src/index.ts"), "utf8");
assert.match(
  apiSource,
  /const lockedNameRaw = String\(conv\?\.manualSender\?\.userName \?\? ""\)\.trim\(\);/,
  "agent-name resolution must keep the manualSender lock branch"
);
const llmSource = await fs.readFile(path.resolve("services/api/src/domain/llmDraft.ts"), "utf8");
assert.match(
  llmSource,
  /At most ONE em dash/,
  "main draft prompt must carry the em-dash charter rule"
);
assert.match(
  llmSource,
  /Never use these phrases: "if helpful"/,
  "main draft prompt must carry the banned-phrase charter rule"
);

console.log("PASS persona continuity + em-dash charter eval");
