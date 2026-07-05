/**
 * Operator draft endpoint eval.
 *
 * Pins the customer-reply operator skill's write path (2026-06-24): a human (or Claude acting as
 * one) saves a reviewed reply into the SAME console approval box the LLM pipeline uses, via
 * POST /conversations/:id/draft → saveOperatorDraft. The hard safety invariant: it stores a
 * reviewable DRAFT and NEVER sends — the console Send button stays the human gate.
 *
 * Layers:
 *  1) Behavioral (temp store): saveOperatorDraft supersedes the prior pending draft, shows the
 *     operator's verbatim text as THE pending draft, attributes the actor, and never produces a
 *     sent message. Re-saving supersedes again (no pile-up). Email sets emailDraft.
 *  2) Source guard: the endpoint exists, routes through saveOperatorDraft, requires a body, and the
 *     handler never touches the send path. The operator skill itself never targets /send.
 *
 * Run: npx tsx scripts/operator_draft_endpoint_eval.ts
 */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "operator-draft-eval-"));
process.env.CONVERSATIONS_DB_PATH = path.join(tempDir, "conversations.json");

const { appendOutbound, getLatestPendingDraft, saveOperatorDraft, upsertConversationByLeadKey } =
  await import("../services/api/src/domain/conversationStore.ts");

// --- 1) Behavioral coverage. ---
const conv = upsertConversationByLeadKey("+17165550199", "suggest");

// A looping pipeline draft is already in the box (the exact thing s R Gurajala kept getting).
const pipelineDraft = appendOutbound(
  conv,
  "salesperson",
  conv.leadKey,
  "Around $200/mo. Which bike are you looking at so I can run it correctly?",
  "draft_ai"
);
assert.ok(pipelineDraft, "pipeline draft seeded");

// Operator saves a real, reviewed reply.
const operatorText =
  "Absolutely! Since you're not after a cruiser: new 2026 Nightster ($10,299) or used 2022 Forty-Eight ($8,995). Want me to run real numbers?";
const saved = saveOperatorDraft(conv, {
  body: operatorText,
  channel: "sms",
  actor: { userId: "u-op", userName: "Operator" }
});
assert.equal(saved.channel, "sms");
// Stored verbatim (no draft-quality gate substitution). appendOutbound applies the same SMS
// compliance footer the pipeline's drafts get, so assert the operator text is the start, intact.
assert.ok(
  saved.draft.startsWith(operatorText),
  `operator text must be stored verbatim (got: ${JSON.stringify(saved.draft)})`
);

// The operator draft is now THE pending draft; the pipeline draft was superseded.
const pending = getLatestPendingDraft(conv);
assert.ok(pending, "a pending draft is present");
assert.match(pending!.body, /Nightster/, "the box shows the operator draft");
assert.equal(pipelineDraft!.draftStatus, "stale", "the prior pipeline draft was marked stale");
assert.equal(pending!.provider, "draft_ai", "the operator draft uses the draft_ai provider (shows in the box)");
assert.equal((pending as any).actorUserName, "Operator", "the operator draft is attributed");

// NEVER sends: no human/twilio/sendgrid (sent) message exists.
const sent = conv.messages.filter(
  m => m.direction === "out" && (m.provider === "twilio" || m.provider === "human" || m.provider === "sendgrid")
);
assert.equal(sent.length, 0, "saving a draft must NOT produce a sent message");

// Re-saving supersedes again — no duplicate pending drafts pile up.
saveOperatorDraft(conv, { body: "Updated: used 2013 Street Glide ($10,995) too.", channel: "sms" });
const pendingDrafts = conv.messages.filter(
  m => m.direction === "out" && m.provider === "draft_ai" && m.draftStatus !== "stale"
);
assert.equal(pendingDrafts.length, 1, "only one pending draft at a time");
assert.match(getLatestPendingDraft(conv)!.body, /Street Glide/, "the latest operator draft wins");

// Email channel sets emailDraft.
const emailConv = upsertConversationByLeadKey("+17165550288", "suggest");
saveOperatorDraft(emailConv, { body: "Thanks — options attached.", channel: "email" });
assert.equal(emailConv.emailDraft, "Thanks — options attached.", "email draft stored on emailDraft");

// --- 2) Source guards. ---
const api = fsSync.readFileSync("services/api/src/index.ts", "utf8");
const start = api.indexOf('app.post("/conversations/:id/draft"');
assert.ok(start > 0, "POST /conversations/:id/draft endpoint must exist");
const handler = api.slice(start, api.indexOf('app.post("/conversations/:id/draft/clear"'));
assert.ok(handler.length > 0 && handler.length < 4000, "draft handler region found");
assert.match(handler, /saveOperatorDraft\(/, "endpoint must route through saveOperatorDraft");
assert.match(handler, /Missing body/, "endpoint must require a body");
// The hard invariant: the draft endpoint never sends.
for (const sendToken of [/finalizeDraftAsSent\(/, /\/send\b/, /sendSmsViaTwilio|sendViaTwilio|sendEmail\(/]) {
  assert.ok(!sendToken.test(handler), `draft endpoint must NEVER call the send path (${sendToken})`);
}

// The operator skill helper must only ever write to /draft, never /send.
const opPath = path.resolve(".claude/skills/customer-reply/operator.ts");
if (fsSync.existsSync(opPath)) {
  const op = fsSync.readFileSync(opPath, "utf8");
  // Strip comments so the guard tests CODE, not the cautionary "never call /send" note.
  const opCode = op.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  assert.ok(!/\/send\b/.test(opCode), "operator skill code must never call the /send endpoint");
  assert.match(op, /\/conversations\/\$\{encodeURIComponent\(convId\)\}\/draft/, "operator skill posts to the draft-only route");
}

console.log("PASS operator draft endpoint eval (behavioral + never-sends source guard)");
