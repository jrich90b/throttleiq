/**
 * inbox_stale_draft_preview:eval (universal, deterministic) — runs inside ci:eval.
 *
 * Joe ruling 2026-07-20 (Peter Meredith +17168303999): a STALE never-sent draft was surfacing
 * as the inbox row's "latest message", rendering like a real send and inflating the operator's
 * read of the thread (the flagged "I'll check that time and follow up" was a thumbs-downed
 * draft that never went out). The row preview must skip stale drafts — on the server list
 * builder (pickInboxPreviewMessage in listConversations) AND in the web client's optimistic
 * lastMessage mirrors. The transcript views already filter stale (pre-existing behavior).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { pickInboxPreviewMessage } from "../services/api/src/domain/conversationStore.ts";

const sent = (body: string) => ({ provider: "twilio", draftStatus: undefined, body });
const staleDraft = (body: string) => ({ provider: "draft_ai", draftStatus: "stale", body });
const pendingDraft = (body: string) => ({ provider: "draft_ai", draftStatus: "pending", body });
const call = (body: string) => ({ provider: "voice_call", draftStatus: undefined, body });

// (a) The Peter reproduction: a stale draft at the tail must NOT be the preview.
const peter = [sent("If you'd rather just stop in, tell me what day works."), staleDraft("Want me to keep looking for you?")];
assert.equal(
  (pickInboxPreviewMessage(peter) as any)?.body,
  "If you'd rather just stop in, tell me what day works.",
  "a trailing stale draft must never be the inbox preview"
);

// (b) A PENDING draft is actionable (awaiting approval) and stays previewable.
assert.equal(
  (pickInboxPreviewMessage([sent("hi"), pendingDraft("Draft awaiting approval")]) as any)?.body,
  "Draft awaiting approval",
  "a pending draft is actionable and remains the preview"
);

// (c) Calls are skipped as before; a call after a real send doesn't take the preview.
assert.equal(
  (pickInboxPreviewMessage([sent("real send"), call("call recording")]) as any)?.body,
  "real send"
);

// (d) Degenerate threads: only stale/call messages fall back to the raw last (row not empty);
// empty list => null.
assert.equal((pickInboxPreviewMessage([staleDraft("only a stale draft")]) as any)?.body, "only a stale draft");
assert.equal(pickInboxPreviewMessage([]), null);
assert.equal(pickInboxPreviewMessage(undefined), null);

// (e) Source guards: the server list builder uses the helper; the web client's optimistic
// lastMessage mirrors filter stale before picking; the transcript views keep their stale
// filters (regression pins for the pre-existing behavior).
{
  const store = readFileSync("services/api/src/domain/conversationStore.ts", "utf8");
  assert.match(store, /export function pickInboxPreviewMessage/, "the preview picker must exist");
  const listStart = store.indexOf("export function listConversations()");
  assert.ok(listStart >= 0, "listConversations must exist");
  assert.match(
    store.slice(listStart, listStart + 3500),
    /pickInboxPreviewMessage\(c\.messages\)/,
    "listConversations must build lastMessage via pickInboxPreviewMessage"
  );

  const page = readFileSync("apps/web/src/app/page.tsx", "utf8");
  const mirrorFilters = (page.match(/draftStatus !== "stale"/g) ?? []).length;
  assert.ok(
    mirrorFilters >= 3,
    `page.tsx must filter stale drafts in the transcript AND both optimistic lastMessage mirrors (found ${mirrorFilters})`
  );

  const detail = readFileSync("apps/web/src/app/conversations/[id]/page.tsx", "utf8");
  assert.match(
    detail,
    /draftStatus !== "stale"/,
    "the conversation detail transcript must keep filtering stale drafts"
  );
}

console.log("inbox_stale_draft_preview_eval passed");
