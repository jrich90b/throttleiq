/**
 * Call-attempt follow-up cadence eval. A staff outbound call that does NOT
 * reach the customer (voicemail / no answer) must not resolve the lead — it
 * stays on the follow-up cadence and the open task shows the next attempt
 * number ("2nd attempt") until the customer is actually reached. A real
 * two-way conversation resolves and stands the agent down.
 *
 * Origin: Merton Kreps +17165503586 (2026-06-13). Joe called from the chat
 * window; the call hit voicemail but the transcript ("Please leave your
 * message for" / "Mert Platts.") was misread as a connected call, so the lead
 * was marked engaged/contacted and stopped following up.
 */
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "call-attempt-eval-"));
process.env.DATA_DIR = tmpDir;

const { isLikelyVoicemailTranscript } = await import("../services/api/src/domain/engagement.ts");
const {
  ordinalLabel,
  nextContactAttemptLabel,
  registerMissedContactAttempt,
  registerContactReached
} = await import("../services/api/src/domain/conversationStore.ts");

let passed = 0;
const fail: string[] = [];
function check(name: string, fn: () => void) {
  try {
    fn();
    passed += 1;
    console.log(`PASS ${name}`);
  } catch (e: any) {
    fail.push(`${name}: ${e?.message ?? e}`);
    console.log(`FAIL ${name}: ${e?.message ?? e}`);
  }
}

// --- Voicemail detection ---------------------------------------------------
const mertonVoicemail = [
  "Customer: Please leave your message for",
  "Customer: Mert Platts.",
  "Joe Hartrich: Hey, Martin. How are you doing? It's, Joe at American Harley Davidson.",
  "Joe Hartrich: I saw it, I got a prequalification that came through.",
  "Joe Hartrich: Give me a callback at this number when you get a chance. We'll be here today till three.",
  "Joe Hartrich: Thanks, Martin. Bye."
].join("\n");

const realConversation = [
  "Joe Hartrich: Hey Mert, it's Joe at American Harley. Got your prequal, what are you looking at?",
  "Customer: Yeah I'm interested in a Road Glide, wondering what you have in stock right now.",
  "Joe Hartrich: We've got a couple, want to come take a look this week?",
  "Customer: Sure, I can swing by Saturday afternoon if that works."
].join("\n");

check("Merton's voicemail is detected as a voicemail (the bug)", () => {
  assert.equal(isLikelyVoicemailTranscript(mertonVoicemail), true);
});

check("a real two-way conversation is NOT a voicemail", () => {
  assert.equal(isLikelyVoicemailTranscript(realConversation), false);
});

check("empty transcript counts as not-contacted (voicemail)", () => {
  assert.equal(isLikelyVoicemailTranscript(""), true);
});

check("classic 'person you are trying to reach is not available' voicemail", () => {
  assert.equal(
    isLikelyVoicemailTranscript("Customer: The person you are trying to reach is not available. Customer: At the tone please record your message."),
    true
  );
});

check("a short customer name fragment alone does not prove a live conversation", () => {
  // name fragment ("John Smith.") + voicemail phrasing must stay a voicemail
  assert.equal(
    isLikelyVoicemailTranscript("Customer: Please leave your message for\nCustomer: John Smith.\nAgent: Hi there, calling you back."),
    true
  );
});

// --- Ordinal + attempt labels ----------------------------------------------
check("ordinalLabel handles st/nd/rd/th and teens", () => {
  assert.equal(ordinalLabel(1), "1st");
  assert.equal(ordinalLabel(2), "2nd");
  assert.equal(ordinalLabel(3), "3rd");
  assert.equal(ordinalLabel(4), "4th");
  assert.equal(ordinalLabel(11), "11th");
  assert.equal(ordinalLabel(12), "12th");
  assert.equal(ordinalLabel(13), "13th");
  assert.equal(ordinalLabel(21), "21st");
  assert.equal(ordinalLabel(22), "22nd");
});

// --- Contact attempt tracking ----------------------------------------------
check("registerMissedContactAttempt increments and labels the NEXT attempt", () => {
  const conv: any = { id: "+1" };
  const a1 = registerMissedContactAttempt(conv);
  assert.equal(a1, 1, "first miss -> 1 attempt logged");
  assert.equal(conv.contact.lastOutcome, "no_answer");
  assert.equal(nextContactAttemptLabel(conv), "2nd attempt", "after one voicemail the task shows 2nd attempt");
  const a2 = registerMissedContactAttempt(conv);
  assert.equal(a2, 2);
  assert.equal(nextContactAttemptLabel(conv), "3rd attempt");
});

check("registerContactReached records reachedAt and preserves the attempt count", () => {
  const conv: any = { id: "+2" };
  registerMissedContactAttempt(conv);
  registerContactReached(conv);
  assert.ok(conv.contact.reachedAt, "reachedAt set when the customer is reached");
  assert.equal(conv.contact.lastOutcome, "reached");
  assert.equal(conv.contact.attempts, 1, "attempt history kept");
});

// --- Voicemail -> staff task: the inventory-watch park ---------------------
// Operator report 2026-07-31, Mark Griffin +15416478489: "there is a watch on this. it should not
// have a task." He asked for a used 2023 Fat Bob, we armed a watch, the chase was stopped BECAUSE
// of that watch, then an outbound call hit voicemail and the generic 2nd-attempt arm minted a
// "Call customer (follow-up)" task anyway — a staff-inbox item with nothing for staff to do, which
// then escalated. The park is four-clause on purpose: once it fires, the watch is this lead's only
// remaining touch, so the two near-miss shapes below MUST still get their task.
const { decideVoicemailFollowUpTask } = await import(
  "../services/api/src/domain/routeStateReducer.ts"
);

const PARKED_ON_WATCH = {
  hasOpenFollowUpTask: false,
  activeInventoryWatchCount: 1,
  followUpMode: "holding_inventory",
  followUpReason: "inventory_watch"
} as const;

check("+15416478489 (the report): a watch-parked lead gets NO 2nd-attempt task", () => {
  const d = decideVoicemailFollowUpTask({ lane: "outbound_generic", ...PARKED_ON_WATCH });
  assert.equal(d.create, false);
  assert.equal(d.reason, "parked_on_inventory_watch");
});

check("+17162458986 shape: an active watch but mode=active STILL gets the task", () => {
  // A stale April watch sitting on an otherwise normal lead. A watch-only predicate would have
  // wrongly buried this one — the chase is not stopped for the watch, so the task is real work.
  const d = decideVoicemailFollowUpTask({
    lane: "outbound_generic",
    hasOpenFollowUpTask: false,
    activeInventoryWatchCount: 1,
    followUpMode: "active",
    followUpReason: "todo_pause"
  });
  assert.equal(d.create, true);
  assert.equal(d.reason, "created");
});

check("+15856048591 shape: holding_inventory with ZERO watches STILL gets the task", () => {
  // Held for a watch that no longer exists. A mode-only predicate would have buried it, and the
  // call task is the only thing keeping the lead alive.
  const d = decideVoicemailFollowUpTask({
    lane: "outbound_generic",
    hasOpenFollowUpTask: false,
    activeInventoryWatchCount: 0,
    followUpMode: "holding_inventory",
    followUpReason: "inventory_watch"
  });
  assert.equal(d.create, true);
});

check("an INBOUND voicemail is never parked — the customer called us", () => {
  const d = decideVoicemailFollowUpTask({ lane: "inbound_voicemail", ...PARKED_ON_WATCH });
  assert.equal(d.create, true);
});

check("the finance-handoff lane is never parked — its task IS the restarted cadence", () => {
  const d = decideVoicemailFollowUpTask({ lane: "outbound_finance_handoff", ...PARKED_ON_WATCH });
  assert.equal(d.create, true);
});

check("an existing open task still wins over everything (unchanged behaviour)", () => {
  for (const lane of ["inbound_voicemail", "outbound_finance_handoff", "outbound_generic"] as const) {
    const d = decideVoicemailFollowUpTask({
      lane,
      hasOpenFollowUpTask: true,
      activeInventoryWatchCount: 0,
      followUpMode: "active",
      followUpReason: "engaged"
    });
    assert.equal(d.create, false, lane);
    assert.equal(d.reason, "existing_open_task", lane);
  }
});

// --- Handler wiring (source pins) ------------------------------------------
const apiSrc = fs.readFileSync(new URL("../services/api/src/index.ts", import.meta.url), "utf8");

check("a reached call closes the call task; a miss does NOT", () => {
  assert.ok(
    apiSrc.includes('if (!inboundCall && contactedValue === "YES") {') &&
      /reached the customer[\s\S]{0,160}markOpenCallTodosDoneForCompletedVoiceAttempt/i.test(apiSrc),
    "call task only resolved on contacted=YES"
  );
});

check("outcome is registered up front for both reached and missed", () => {
  assert.ok(
    /if \(contactedValue === "YES"\) registerContactReached\(conv\);\s*\n\s*else registerMissedContactAttempt\(conv\);/.test(
      apiSrc
    ),
    "registerContactReached / registerMissedContactAttempt wired in the recording handler"
  );
});

check("the finance follow-up todo carries the attempt number", () => {
  assert.ok(
    apiSrc.includes("Call customer (follow-up) — ${nextContactAttemptLabel(conv)}:"),
    "follow-up call todo labels the next attempt"
  );
});

console.log(`\nCall-attempt cadence: ${passed} checks passed`);
if (fail.length) {
  console.error(`\n${fail.length} failures`);
  process.exit(1);
}
console.log("PASS call attempt cadence eval");
