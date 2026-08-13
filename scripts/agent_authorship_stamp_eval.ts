/**
 * Agent authorship must survive an UNEDITED approval.
 *
 * `finalizeDraftAsSent` records `originalDraftBody` only when the rep CHANGED the text. So a draft
 * approved untouched became byte-identical to a message the rep typed from scratch, and every trace
 * that the agent wrote it was gone.
 *
 * MEASURED 2026-08-13, 45 days of the live store: 179 messages provably edited, 280 drafts never
 * sent as written, and **919 in the ambiguous bucket** — which in suggest mode is the most common
 * way an agent message reaches a customer. That made the one number that decides whether this
 * product saves labour or creates it unanswerable: the agent's work is used as written somewhere
 * between **24% and 79%** of the time.
 *
 * `authoredBy: "agent"` is now stamped unconditionally at the one door an approved draft passes
 * through. This eval EXECUTES that door — a source-text assertion could not prove the field is
 * actually written, and the whole point is a field that is written every time, not most times.
 *
 * Run: npx tsx scripts/agent_authorship_stamp_eval.ts
 */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-authorship-eval-"));
process.env.CONVERSATIONS_DB_PATH = path.join(tempDir, "conversations.json");

const { appendOutbound, finalizeDraftAsSent, getLatestPendingDraft, upsertConversationByLeadKey } =
  await import("../services/api/src/domain/conversationStore.ts");

const DRAFT = "Yes, the 2020 Iron 1200 (Stock U124-20) is available. What day works to stop in?";

// --- THE CASE THIS EXISTS FOR: approved UNEDITED still records agent authorship ---
{
  const conv = upsertConversationByLeadKey("+17165554101", "suggest");
  const draft = appendOutbound(conv, "salesperson", conv.leadKey, DRAFT, "draft_ai");
  assert.ok(draft, "pending draft stored");

  const fin = finalizeDraftAsSent(conv, draft!.id, DRAFT, "twilio", "SM_unedited", {
    userId: "u-scott",
    userName: "Scott Hartrich"
  });
  assert.equal(fin.usedDraft, true, "an unedited approval still consumes the draft");

  const sent = conv.messages.find(m => m.id === draft!.id)!;
  assert.equal(
    sent.authoredBy,
    "agent",
    "an UNEDITED approval must still be attributable to the agent — the whole point of the field"
  );
  assert.equal(
    sent.originalDraftBody,
    undefined,
    "…and originalDraftBody stays absent, because nothing changed (that is why the field was needed)"
  );
  assert.equal(sent.provider, "twilio", "the draft became a real sent message");
  assert.equal(sent.draftStatus, undefined, "…and is no longer pending");
  assert.equal(sent.actorUserId, "u-scott", "the human who approved it is still recorded");
}

// --- An EDITED approval keeps both signals: authorship AND the agent's original wording ---
{
  const conv = upsertConversationByLeadKey("+17165554102", "suggest");
  const draft = appendOutbound(conv, "salesperson", conv.leadKey, DRAFT, "draft_ai");
  const edited = "Yes, the Iron 1200 is here. What day works for you?";
  finalizeDraftAsSent(conv, draft!.id, edited, "twilio", "SM_edited", {
    userId: "u-scott",
    userName: "Scott Hartrich"
  });

  const sent = conv.messages.find(m => m.id === draft!.id)!;
  assert.equal(sent.authoredBy, "agent", "an edited approval is still agent-authored");
  // `includes`, not `equal`: appendOutbound legitimately appends the STOP footer to the first SMS
  // in a thread, so the stored draft is the agent's text plus that footer. Asserting exact bytes
  // here would pin an opt-out rule that has nothing to do with authorship.
  assert.ok(
    String(sent.originalDraftBody ?? "").includes("What day works to stop in?"),
    `…and the agent's original wording is preserved: ${sent.originalDraftBody}`
  );
  assert.notEqual(sent.body, DRAFT, "…while the customer got the human's version");
  // Both signals together are what make "how MUCH did they change it" answerable.
  assert.ok(
    sent.authoredBy === "agent" && typeof sent.originalDraftBody === "string",
    "edited sends carry BOTH fields, so rework depth stays measurable"
  );
}

// --- A message the rep typed from scratch is NOT marked as ours ---
// This is the discrimination the field buys. If appendOutbound ever started stamping it too, the
// bucket would be uncountable again in the other direction.
{
  const conv = upsertConversationByLeadKey("+17165554103", "suggest");
  const typed = appendOutbound(
    conv,
    "+17165550000",
    conv.leadKey,
    "Hey — give me a call when you get a sec.",
    "twilio"
  );
  assert.ok(typed, "staff-typed message stored");
  assert.equal(
    typed!.authoredBy,
    undefined,
    "a message that never came from a draft must NOT be attributed to the agent"
  );
}

// --- A rejected finalize marks nothing (the media-only guard path) ---
// finalizeDraftAsSent bails on an empty final body. It must not stamp authorship on the way out:
// the draft is still pending and the agent has not sent anything.
{
  const conv = upsertConversationByLeadKey("+17165554104", "suggest");
  const draft = appendOutbound(conv, "salesperson", conv.leadKey, DRAFT, "draft_ai");
  const fin = finalizeDraftAsSent(conv, draft!.id, "", "twilio", "MM_media_only", {
    userId: "u-scott",
    userName: "Scott Hartrich"
  });
  assert.equal(fin.usedDraft, false, "an empty final body does not consume the draft");
  const stillPending = conv.messages.find(m => m.id === draft!.id)!;
  assert.equal(
    stillPending.authoredBy,
    undefined,
    "a draft that was never sent carries no authorship stamp"
  );
  // A pending draft carries NO draftStatus (only "stale" is ever written), so pendingness is asked
  // of the store rather than assumed from a string that does not exist.
  const pending = getLatestPendingDraft(conv);
  assert.ok(pending && pending.id === draft!.id, "…and the draft is still pending");
}

// --- A stale draft cannot be finalized, and stamps nothing ---
{
  const conv = upsertConversationByLeadKey("+17165554105", "suggest");
  const draft = appendOutbound(conv, "salesperson", conv.leadKey, DRAFT, "draft_ai");
  const row = conv.messages.find(m => m.id === draft!.id)!;
  row.draftStatus = "stale";
  const fin = finalizeDraftAsSent(conv, draft!.id, DRAFT, "twilio", "SM_stale", {
    userId: "u-scott",
    userName: "Scott Hartrich"
  });
  assert.equal(fin.usedDraft, false, "a stale draft is never finalized");
  assert.equal(row.authoredBy, undefined, "…and never stamped");
}

console.log(
  "PASS agent authorship stamp eval (unedited approval attributable + edited keeps both signals + staff-typed unmarked + rejected finalizes stamp nothing)"
);
