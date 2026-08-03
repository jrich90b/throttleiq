/**
 * Undelivered-outbound provenance eval (pure, no LLM).
 *
 * Pins the 8/3 wiring-triage F1: six fallback sites recorded a customer-facing outbound that was
 * NEVER SENT (send failure / missing Twilio or SendGrid credentials) as provider "human" — the
 * same tag a rep's hand-typed console SMS gets. Four consumers then believed a human was driving
 * the thread: the agent intro was skipped on the customer's REAL first received message, the
 * draft judge graded against ghost text, the proactive cadence benched itself to draft-only for
 * 14 days off its own failed touch, and an email reply routed as "reply to a salesperson".
 *
 * The fix stamps those rows `delivered: false` via appendUndeliveredOutbound (provider stays
 * "human" so the duplicate-outbound suppressors keep matching), and the receipt-answering
 * consumers skip the marker. Absent marker = delivered, so history needs no migration and a
 * consumer that misses the memo fails toward the pre-fix behavior, never worse.
 *
 * Run: npx tsx scripts/undelivered_outbound_provenance_eval.ts
 */
import { strict as assert } from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.CONVERSATIONS_DB_PATH = path.join(
  os.tmpdir(),
  `undelivered-provenance-eval-${process.pid}.json`
);

const {
  hasCustomerReceivedOutbound,
  keepCustomerReceivedOutbounds,
  hasRecentDeliveredHumanOutbound
} = await import("../services/api/src/domain/agentVoice.ts");
const { appendUndeliveredOutbound } = await import("../services/api/src/domain/conversationStore.ts");
const { shouldSuppressCadenceAck } = await import("../services/api/src/domain/cadenceAckGate.ts");

const NOW = Date.parse("2026-08-03T16:00:00.000Z");
const RECENT = "2026-08-01T12:00:00.000Z"; // 2 days before NOW, inside every window

const deliveredHuman = { direction: "out", provider: "human", at: RECENT, body: "hi" };
const undeliveredHuman = { direction: "out", provider: "human", at: RECENT, body: "hi", delivered: false };
const inbound = { direction: "in", provider: "twilio", at: RECENT, body: "hello" };

// --- 1) "Has the customer heard from us?" answers NO for an undelivered row. ---

assert.equal(hasCustomerReceivedOutbound([deliveredHuman]), true, "a real human send counts");
assert.equal(
  hasCustomerReceivedOutbound([undeliveredHuman]),
  false,
  "an undelivered fallback row must NOT count as received — counting it skips the intro on the " +
    "customer's real first message"
);
assert.equal(
  hasCustomerReceivedOutbound([undeliveredHuman, deliveredHuman]),
  true,
  "one real send among fallbacks still counts"
);

const kept = keepCustomerReceivedOutbounds([inbound, undeliveredHuman, deliveredHuman]);
assert.equal(kept.length, 2, "the undelivered row is dropped; the inbound and the real send stay");
assert.ok(kept.includes(inbound as any) && kept.includes(deliveredHuman as any));

// --- 2) The cadence's "a rep is driving" check ignores its own failed touches. ---

assert.equal(
  hasRecentDeliveredHumanOutbound([deliveredHuman], NOW),
  true,
  "a real recent human send benches the cadence"
);
assert.equal(
  hasRecentDeliveredHumanOutbound([undeliveredHuman], NOW),
  false,
  "the cadence's own unsendable fallback must NOT bench the cadence for 14 days"
);
assert.equal(
  hasRecentDeliveredHumanOutbound(
    [{ ...deliveredHuman, at: "2026-07-01T00:00:00.000Z" }],
    NOW
  ),
  false,
  "outside the 14-day window is not recent"
);

// --- 3) The pause/resume ack gate ignores undelivered rows too. ---

assert.equal(
  shouldSuppressCadenceAck({ messages: [{ ...deliveredHuman, at: new Date(NOW - 60_000).toISOString() }] } as any, NOW),
  true,
  "a human send a minute ago suppresses the ack"
);
assert.equal(
  shouldSuppressCadenceAck(
    { messages: [{ ...undeliveredHuman, at: new Date(NOW - 60_000).toISOString() }] } as any,
    NOW
  ),
  false,
  "an undelivered fallback a minute ago must not suppress the ack"
);

// --- 4) The writer stamps the marker (and only the wrapper's rows carry it). ---

const conv: any = { id: "t", leadKey: "t", mode: "suggest", messages: [] };
const row = appendUndeliveredOutbound(conv, "salesperson", "+17165550100", "could not send this");
assert.ok(row, "appendUndeliveredOutbound must return the appended row");
assert.equal(row?.provider, "human", "provider stays 'human' so duplicate suppressors keep matching");
assert.equal(row?.delivered, false, "the row must be stamped delivered: false");
assert.equal(
  hasCustomerReceivedOutbound(conv.messages),
  false,
  "end to end: the recorded fallback does not read as something the customer received"
);

// --- 5) Source pins: the six fallback sites use the wrapper; genuine sends don't. ---

const api = fs.readFileSync("services/api/src/index.ts", "utf8");
const wrapperCalls = api.match(/appendUndeliveredOutbound\(conv,/g) ?? [];
assert.equal(
  wrapperCalls.length,
  6,
  `all six unsendable-fallback sites must use appendUndeliveredOutbound; found ${wrapperCalls.length}`
);
// Every remaining direct "human" append must carry a real actor (a genuine staff console send).
// A new actor-less "human" append is, by construction, an undelivered fallback that skipped the
// wrapper — this pin makes that a gate failure instead of a silent regression.
const directHuman = api.match(/appendOutbound\([^)]*"human"[^)]*\)/g) ?? [];
for (const call of directHuman) {
  assert.ok(
    /actorForOutbound/.test(call),
    `a direct provider-"human" appendOutbound without an actor looks like an undelivered fallback ` +
      `that skipped the wrapper — use appendUndeliveredOutbound instead: ${call.slice(0, 90)}`
  );
}
assert.ok(directHuman.length >= 2, "the two genuine console-send sites remain direct");

const sendgrid = fs.readFileSync("services/api/src/routes/sendgridInbound.ts", "utf8");
assert.ok(
  /lastOutbound\.provider === "human" && lastOutbound\.delivered !== false/.test(sendgrid),
  "isReplyToSalespersonEmailThread must not treat an undelivered fallback as a salesperson thread"
);

console.log("PASS undelivered_outbound_provenance_eval — 18 checks");
