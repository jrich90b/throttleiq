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
 *     any inbound; SOLD/post_sale closes never reopen)
 *   - HOLD closes (unit/order/manual hold — a purchase in progress, NOT sold) reopen on a
 *     REAL customer message and stay closed only on a bare ack (Joe ruling 2026-07-16;
 *     David Miller +17163440581: closed-with-hold, texted "I am on my way" to pick up his
 *     held Street Glide, and the live deal stayed buried in the archived box)
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
// SOLD via sale.soldAt + real message => stays closed (sold bucket owns post-sale traffic).
{
  const conv = mkArchived("a6");
  conv.closedReason = "other";
  conv.sale = { soldAt: "2026-06-25T19:36:33.253Z" };
  appendInbound(conv, evt("Are you there today? Coming for the backrest."));
  eq(conv.status, "closed", "a sold deal (sale.soldAt) never auto-reopens");
}
// HOLD close + REAL message => REOPENS (Joe ruling 2026-07-16; the David Miller case).
{
  const conv = mkArchived("a7");
  conv.closedReason = "other";
  conv.hold = { key: "t36-25", stockId: "T36-25", reason: "unit_hold" };
  appendInbound(conv, evt("I am on my way to pick up the bike"));
  eq(conv.status, "open", "a real message reopens a hold deal (purchase in progress, not sold)");
  eq(conv.closedReason, undefined, "closedReason cleared on hold reopen");
}
// HOLD close + bare ack => stays closed (no content to act on).
{
  const conv = mkArchived("a8");
  conv.closedReason = "other";
  conv.hold = { key: "t36-25", stockId: "T36-25", reason: "unit_hold" };
  appendInbound(conv, evt("👍"));
  eq(conv.status, "closed", "a bare ack leaves a hold deal closed");
}
// HOLD via followUp.reason (unit_hold) + real message => reopens too.
{
  const conv = mkArchived("a9");
  conv.closedReason = "other";
  conv.followUp = { mode: "manual_handoff", reason: "unit_hold" };
  appendInbound(conv, evt("When can I come grab it?"));
  eq(conv.status, "open", "a followUp.reason hold reopens on a real message");
}
// HOLD + SOLD together => sold wins, stays closed.
{
  const conv = mkArchived("a10");
  conv.closedReason = "other";
  conv.hold = { key: "x", reason: "unit_hold" };
  conv.sale = { soldAt: "2026-06-25T19:36:33.253Z" };
  appendInbound(conv, evt("Quick question about the paperwork"));
  eq(conv.status, "closed", "sold outranks hold — a completed deal stays closed");
}

// --- 3) Clean-decline closeouts archive on the SAME terms (Joe ruling 2026-07-22). ---
// Mark Palmer (+17168304817) said "No thanks" on 7/21; the thread closed but a stray ack could
// still drag it back into the working inbox. A decline archives; a REAL customer SMS still reopens.
const { isDeclineCloseoutReason } = store as any;
for (const reason of [
  "not_interested",
  "customer_stepping_back",
  "customer_keep_current_bike",
  "customer_sell_on_own",
  "CUSTOMER_STEPPING_BACK" // case-insensitive
]) {
  eq(isDeclineCloseoutReason(reason), true, `"${reason}" is a clean-decline closeout reason`);
}
for (const reason of ["sold", "opt_out", "wrong_number", "unit_hold", "", null, undefined, "other"]) {
  eq(isDeclineCloseoutReason(reason), false, `"${reason}" must NOT count as a decline closeout`);
}
for (const reason of ["not_interested", "customer_stepping_back", "customer_keep_current_bike", "customer_sell_on_own"]) {
  // decline + bare ack => stays archived out of the inbox
  {
    const conv = mkArchived(`d-ack-${reason}`);
    conv.closedReason = reason;
    appendInbound(conv, evt("👍"));
    eq(conv.status, "closed", `a bare ack leaves a ${reason} decline archived`);
    eq(conv.closedReason, reason, `${reason} closedReason preserved`);
    eq(conv.messages.length, 1, "the ack is still recorded");
  }
  // decline + REAL customer SMS => reopens (the preserved rule Joe called out)
  {
    const conv = mkArchived(`d-real-${reason}`);
    conv.closedReason = reason;
    appendInbound(conv, evt("Changed my mind — is that Street Glide still there?"));
    eq(conv.status, "open", `a real customer SMS reopens a ${reason} decline`);
    eq(conv.closedReason, undefined, "closedReason cleared on reopen");
  }
}
// decline + media-bearing ack => reopens (media is content; fail-safe toward reopening)
{
  const conv = mkArchived("d-media");
  conv.closedReason = "not_interested";
  appendInbound(conv, evt("ok", ["https://example.test/pic.jpg"]));
  eq(conv.status, "open", "an attachment reopens a declined thread even with an ack caption");
}
// SOLD still outranks a decline reason — a completed deal never reopens.
{
  const conv = mkArchived("d-sold");
  conv.closedReason = "not_interested";
  conv.sale = { soldAt: "2026-06-25T19:36:33.253Z" };
  appendInbound(conv, evt("Quick question about the paperwork"));
  eq(conv.status, "closed", "sold outranks a decline reason");
}

console.log(`PASS archived-ack no-reopen eval (${n} assertions)`);
