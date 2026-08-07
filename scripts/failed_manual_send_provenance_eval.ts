/**
 * Failed staff-send provenance eval (pure, no LLM).
 *
 * A SEND THAT NEVER LEFT MUST NOT LOOK LIKE A MESSAGE THE CUSTOMER GOT.
 *
 * Maya Iversen (+15854782032), 2026-08-07T01:15:58Z. A deploy was mid-`npm ci`, the twilio library
 * could not lazily resolve `dayjs`, and the staff Send threw. The catch recorded the attempt so the
 * rep would still see it — with `appendOutbound`, which leaves no marker. The contract established
 * by the 8/3 triage is **absent marker = delivered**, so her thread showed a sent message. She never
 * received it, and nothing in the console said so. It was found only because a rep happened to be
 * looking at the screen when the error popup appeared.
 *
 * `appendUndeliveredOutbound` already existed for six other fallback sites. The staff Send button —
 * the one a human actually clicks — was the seventh, and it was never wired up. It also cannot use
 * that helper, because it must keep the rep's ACTOR STAMP (what identifies a staff-authored reply
 * everywhere else), so the row is marked in place instead.
 *
 * Run: npx tsx scripts/failed_manual_send_provenance_eval.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  appendOutbound,
  markOutboundUndelivered,
  recordFailedManualSend
} from "../services/api/src/domain/conversationStore.ts";

const conv = (): any => ({ id: "+15854782032", leadKey: "+15854782032", messages: [] });

// --- 1) A failed send is recorded AND stamped undelivered. ---
const a = conv();
const res = recordFailedManualSend(a, {
  to: "+15854782032",
  body: "Hey Maya, it's Alexandra over at American Harley-Davidson.",
  actor: { userId: "u_1", userName: "Scott" }
});
assert.equal(a.messages.length, 1, "the rep must still see the attempt in the thread");
assert.equal(a.messages[0].direction, "out");
assert.equal(
  a.messages[0].delivered,
  false,
  "THE BUG: a send the carrier never accepted must not read as delivered"
);
assert.equal(res.message?.delivered, false, "the helper returns the row it stamped");

// The rep's identity survives — it is what marks a staff-authored reply everywhere else.
assert.equal(a.messages[0].actorUserName, "Scott", "the actor stamp must be preserved on a failed send");

// No carrier id, because there was no carrier acceptance.
assert.ok(!a.messages[0].providerMessageId, "a failed send has no provider message id");

// --- 2) A SUCCESSFUL send is untouched — absent marker still means delivered. ---
const b = conv();
appendOutbound(b, "dealership", "+15854782032", "delivered text", "twilio", "SM123", undefined, {
  userId: "u_1",
  userName: "Scott"
});
assert.equal(
  b.messages[0].delivered,
  undefined,
  "a real send must NOT be stamped — history needs no migration and absent still means delivered"
);
assert.equal(b.messages[0].providerMessageId, "SM123");

// --- 3) The marker targets the right row when a draft was finalized. ---
const c = conv();
c.messages.push({ id: "draft_1", direction: "out", provider: "draft_ai", body: "pending draft" });
recordFailedManualSend(c, { draftId: "draft_1", to: "+15854782032", body: "edited body", actor: { userName: "Scott" } });
const draftRow = c.messages.find((m: any) => m.id === "draft_1");
assert.equal(draftRow.delivered, false, "when the draft was used, THAT row is the one that must be stamped");
assert.equal(c.messages.filter((m: any) => m.direction === "out").length, 1, "no duplicate row is appended");

// --- 4) markOutboundUndelivered is defensive, not destructive. ---
assert.equal(markOutboundUndelivered({ messages: [] } as any), null, "nothing to stamp ⇒ null, no throw");
const d = conv();
d.messages.push({ id: "in_1", direction: "in", body: "customer text" });
assert.equal(markOutboundUndelivered(d), null, "an inbound is never stamped undelivered");
assert.equal(d.messages[0].delivered, undefined, "the inbound is left alone");

// --- 5) The send handler must go through it. ---
const index = fs.readFileSync("services/api/src/index.ts", "utf8");
assert.ok(
  index.includes("recordFailedManualSend"),
  "the staff Send catch must record failures through the shared helper"
);
assert.ok(
  !/catch[\s\S]{0,400}Log the attempted send as human so rep still sees it[\s\S]{0,200}appendOutbound\(/.test(index),
  "the old bare-append catch is back — a failed send would read as delivered again"
);

console.log(
  "PASS failed manual send provenance eval — failed send stamped undelivered, actor preserved, successful send untouched, handler wired"
);
