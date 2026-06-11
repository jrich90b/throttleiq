/**
 * Manual send draft guard — a media-only send (empty final body) must never
 * consume a pending draft. Production incidents: Bailey +16077384120
 * 2026-06-10T18:15Z and Mustafa +17164368801 2026-05-11T16:11Z — staff sent
 * photos with the reply box prefilled; the draft text was wiped into
 * originalDraftBody and the media reference was dropped from the record.
 */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "manual-send-guard-eval-"));
process.env.CONVERSATIONS_DB_PATH = path.join(tempDir, "conversations.json");

const { appendOutbound, finalizeDraftAsSent, getLatestPendingDraft, upsertConversationByLeadKey } =
  await import("../services/api/src/domain/conversationStore.ts");

const conv = upsertConversationByLeadKey("+17165554001", "suggest");
const draft = appendOutbound(
  conv,
  "salesperson",
  conv.leadKey,
  "Yes, the 2020 Iron 1200 (Stock U124-20) is available right now. Let me know what day works to stop in.",
  "draft_ai"
);
assert.ok(draft, "pending draft stored");

// Media-only send: empty final body must NOT consume the draft.
const fin = finalizeDraftAsSent(conv, draft!.id, "", "twilio", "MM_eval_media_only", {
  userId: "u-scott",
  userName: "Scott Hartrich"
});
assert.equal(fin.usedDraft, false, "empty-body finalize must not consume the draft");
const stillPending = getLatestPendingDraft(conv);
assert.ok(stillPending && stillPending.id === draft!.id, "draft must remain pending");
assert.match(stillPending!.body, /Iron 1200/, "draft text must be intact");

// The caller's fallback path records the media message with its mediaUrls.
const mediaMsg = appendOutbound(
  conv,
  "+17165550000",
  conv.leadKey,
  "",
  "twilio",
  "MM_eval_media_only",
  ["https://example.com/uploads/photo1.jpg"],
  { userId: "u-scott", userName: "Scott Hartrich" }
);
assert.ok(mediaMsg, "media message recorded");
assert.deepEqual(mediaMsg!.mediaUrls, ["https://example.com/uploads/photo1.jpg"], "media preserved");

// A real text send afterwards still consumes the draft normally.
const fin2 = finalizeDraftAsSent(
  conv,
  draft!.id,
  "Yes, the 2020 Iron 1200 (Stock U124-20) is available right now. What day works to stop in?",
  "twilio",
  "SM_eval_real_send",
  { userId: "u-scott", userName: "Scott Hartrich" }
);
assert.equal(fin2.usedDraft, true, "non-empty finalize consumes the draft");
assert.equal(getLatestPendingDraft(conv), null, "no pending draft after real send");

console.log("PASS manual send draft guard eval");
