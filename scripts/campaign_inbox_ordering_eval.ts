/**
 * campaign_inbox_ordering_eval (pure store-level, no LLM)
 *
 * Pins the Joe-approved behavior (2026-07-15): a campaign SMS BROADCAST must NOT shove the
 * customer's thread to the top of the working Inbox. The Inbox sorts by `inboxActivityAt`
 * (last real 1:1 activity), not the generic `updatedAt`. So:
 *   - a real customer reply (appendInbound) advances inboxActivityAt  -> rises to the top
 *   - a normal staff/AI reply (appendOutbound) advances inboxActivityAt -> stays near the top
 *   - a campaign broadcast advances updatedAt but the broadcast caller FREEZES inboxActivityAt
 *     to its pre-send value -> the thread is tagged ("Campaign sent") without reordering the Inbox
 *   - the Inbox sort key falls back to updatedAt when inboxActivityAt is unset (older threads)
 *
 * The freeze step mirrors services/api/src/index.ts POST /contacts/broadcast exactly.
 *
 * Run: npx tsx scripts/campaign_inbox_ordering_eval.ts
 */
import { strict as assert } from "node:assert";
import os from "node:os";
import * as path from "node:path";

process.env.CONVERSATIONS_DB_PATH = path.join(os.tmpdir(), `campaign-inbox-ordering-eval-${process.pid}.json`);

const store = (await import("../services/api/src/domain/conversationStore.ts")) as any;
const { appendInbound, appendOutbound } = store;

let n = 0;
const ok = (cond: boolean, m: string) => {
  assert.ok(cond, m);
  n++;
};

const OLD = "2026-07-10T12:00:00.000Z";
const ms = (s?: string | null) => Date.parse(String(s ?? "")) || 0;

const mkConv = (id: string, extra: Record<string, unknown> = {}) =>
  ({
    id,
    leadKey: id,
    mode: "suggest",
    status: "open",
    createdAt: OLD,
    updatedAt: OLD,
    inboxActivityAt: OLD,
    lead: {},
    messages: [],
    ...extra
  }) as any;

// The Inbox sort key (mirrors useInboxSectionData.ts): last real activity, fallback to updatedAt.
const inboxSortMs = (c: any) => ms(c.inboxActivityAt ?? c.updatedAt);

// --- 1) A customer reply bumps the Inbox (inboxActivityAt advances past the old value). ---
const replied = mkConv("+15550000001");
appendInbound(replied, {
  from: "+15550000001",
  to: "+15550009999",
  body: "Yeah I'm still interested, what's the price?",
  receivedAt: new Date().toISOString(),
  provider: "twilio",
  providerMessageId: "SMreply1"
});
ok(ms(replied.inboxActivityAt) > ms(OLD), "customer reply advances inboxActivityAt");

// --- 2) A normal staff/AI reply bumps the Inbox too. ---
const staffReplied = mkConv("+15550000002");
appendOutbound(staffReplied, "+15550009999", "+15550000002", "Sure — it's $18,995 out the door. Want to come see it?", "twilio", "SMout1");
ok(ms(staffReplied.inboxActivityAt) > ms(OLD), "staff reply advances inboxActivityAt");
ok(ms(staffReplied.updatedAt) > ms(OLD), "staff reply advances updatedAt");

// --- 3) A campaign BROADCAST tags but does NOT bump the Inbox. ---
//     Replicate the POST /contacts/broadcast freeze exactly.
const blasted = mkConv("+15550000003");
const prevInboxActivityAt = String(blasted.inboxActivityAt ?? blasted.updatedAt ?? "").trim() || undefined;
appendOutbound(blasted, "+15550009999", "+15550000003", "Customer Cash on the Low Rider S & ST — $1,000 off through Aug 31. Reply STOP to opt out.", "twilio", "SMblast1");
blasted.campaignThread = { status: "linked_open", campaignName: "Customer Cash", lastSentAt: new Date().toISOString() };
blasted.updatedAt = new Date().toISOString();
blasted.inboxActivityAt = prevInboxActivityAt; // freeze
ok(ms(blasted.updatedAt) > ms(OLD), "broadcast advances updatedAt (Campaigns tab still orders by send)");
ok(ms(blasted.inboxActivityAt) === ms(OLD), "broadcast FREEZES inboxActivityAt (no Inbox reorder)");
ok(inboxSortMs(blasted) === ms(OLD), "blasted thread keeps its Inbox sort position");
ok(inboxSortMs(blasted) < ms(staffReplied.inboxActivityAt), "a real reply outranks a blasted thread in the Inbox");

// --- 4) After the blast, a real reply DOES re-bump the frozen thread to the top. ---
appendInbound(blasted, {
  from: "+15550000003",
  to: "+15550009999",
  body: "Oh nice, is the black one still available?",
  receivedAt: new Date().toISOString(),
  provider: "twilio",
  providerMessageId: "SMreply2"
});
ok(ms(blasted.inboxActivityAt) > ms(OLD), "a reply to a blasted thread re-bumps the Inbox");

// --- 5) Older threads with no inboxActivityAt fall back to updatedAt for sorting. ---
const legacy = { id: "+15550000004", leadKey: "+15550000004", updatedAt: "2026-07-14T09:00:00.000Z" } as any;
ok(inboxSortMs(legacy) === ms("2026-07-14T09:00:00.000Z"), "legacy thread (no inboxActivityAt) sorts by updatedAt");

console.log(`campaign_inbox_ordering_eval: OK (${n} checks)`);
