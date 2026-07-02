/**
 * Archived-conversation bare-ack eval (pure store-level, no LLM).
 *
 * Pins the Joe-approved behavior (2026-07-02; Deborah Kranz-Mitchell, +17166280459): a
 * staff-ARCHIVED conversation must stay archived when the customer replies with a bare,
 * content-free acknowledgement ("Will do", "ok", 👍) — the archive was previously wiped by
 * appendInbound's blanket reopen. Everything else still reopens (fail-safe):
 *   - a real message/question reopens an archived conv
 *   - a media-bearing inbound reopens even with an ack caption
 *   - non-archive closes keep their existing semantics (a generic close still reopens on
 *     any inbound; sticky closes — sold/hold/post_sale — never reopen, unchanged)
 *
 * Run: npx tsx scripts/archived_ack_no_reopen_eval.ts
 */
import { strict as assert } from "node:assert";
import os from "node:os";
import * as path from "node:path";

process.env.CONVERSATIONS_DB_PATH = path.join(
  os.tmpdir(),
  `archived-ack-eval-${process.pid}.json`
);

const store = await import("../services/api/src/domain/conversationStore.ts");
const { appendInbound, isBareAckInboundText } = store as any;

let n = 0;
const eq = (a: unknown, b: unknown, m: string) => {
  assert.deepEqual(a, b, m);
  n++;
};

// --- 1) Bare-ack classifier: narrow by design. ---
for (const ack of ["Will do", "ok", "Okay.", "thanks!", "Thank you so much", "sounds good", "👍", "Have a great day!", "You too", "yep"]) {
  eq(isBareAckInboundText(ack), true, `"${ack}" is a bare ack`);
}
for (const real of [
  "Will do — but first, what's the OTD price?",
  "ok when are you open",
  "thanks, can you send photos?",
  "I changed my mind, still have it?",
  "", // empty is not an ack (nothing to hold on)
  "thanks for nothing" // sarcasm-adjacent, over 0 content words → not in the whitelist
]) {
  eq(isBareAckInboundText(real), false, `"${real}" must NOT count as a bare ack`);
}

// --- 2) Store behavior. ---
const mkArchived = (id: string) =>
  ({
    id,
    leadKey: id,
    status: "closed",
    closedAt: "2026-07-01T16:12:00.000Z",
    closedReason: "archive",
    messages: []
  }) as any;

const evt = (body: string, mediaUrls?: string[]) =>
  ({ from: "+15550001111", to: "+15550002222", body, receivedAt: "2026-07-01T16:15:00.000Z", provider: "twilio", providerMessageId: "SM1", mediaUrls }) as any;

// Archived + bare ack => stays archived.
{
  const conv = mkArchived("a1");
  appendInbound(conv, evt("Will do"));
  eq(conv.status, "closed", "archived conv stays closed on a bare ack");
  eq(conv.closedReason, "archive", "archive reason preserved");
  eq(conv.messages.length, 1, "the ack is still recorded");
}
// Archived + real question => reopens.
{
  const conv = mkArchived("a2");
  appendInbound(conv, evt("Actually — is the Low Rider still available?"));
  eq(conv.status, "open", "a real message reopens an archived conv");
  eq(conv.closedReason, undefined, "closedReason cleared on reopen");
}
// Archived + ack WITH media => reopens (a photo is content).
{
  const conv = mkArchived("a3");
  appendInbound(conv, evt("ok", ["https://media.example/1.jpg"]));
  eq(conv.status, "open", "media-bearing inbound reopens even with an ack caption");
}
// NON-archive generic close + bare ack => still reopens (existing semantics untouched).
{
  const conv = mkArchived("a4");
  conv.closedReason = "event_promo_no_cadence";
  appendInbound(conv, evt("ok"));
  eq(conv.status, "open", "non-archive closes keep the pre-existing reopen-on-any-inbound behavior");
}
// Sticky close (sold) + real message => stays closed (unchanged).
{
  const conv = mkArchived("a5");
  conv.closedReason = "sold";
  appendInbound(conv, evt("What oil should I use?"));
  eq(conv.status, "closed", "sticky closes still never auto-reopen (unchanged)");
}

console.log(`PASS archived-ack no-reopen eval (${n} assertions)`);
