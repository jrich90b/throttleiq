/**
 * Disengagement taper eval. A lead that never reached back (zero customer
 * inbound) must not be nudged through the full 13-step cadence. After
 * DISENGAGED_TAPER_AFTER_TOUCHES touches the cadence sends one graceful
 * close-out and ends. Origin: Michael Digiulio +17168660252 (2026-06-13) got
 * 10 unanswered touches across SMS, email, and a voicemail, still scheduled
 * for more, with two byte-identical sends. Joe set the threshold at 9 touches.
 *
 * Pure-function eval over the domain helpers — no live store, no LLM.
 */
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

// Point the store at a throwaway dir so importing conversationStore never
// writes into the repo checkout.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "taper-eval-"));
process.env.DATA_DIR = tmpDir;

const {
  DISENGAGED_TAPER_AFTER_TOUCHES,
  customerEngagedWithCadence,
  buildDisengagedCadenceCloseout,
  shouldSendDisengagedCloseout,
  advanceFollowUpCadence
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

const adfLead = { direction: "in", provider: "sendgrid_adf", body: "WEB LEAD (ADF) ..." };
const ourText = { direction: "out", provider: "twilio", body: "Hey Michael, just checking back." };
const ourVoicemail = { direction: "out", provider: "voice_transcript", body: "Customer: forwarded to voicemail" };
const customerReply = { direction: "in", provider: "twilio", body: "yeah still interested" };

const silentConv = (lastSentStep: number, kind = "engaged") => ({
  id: "+1",
  lead: { firstName: "Michael" },
  messages: [adfLead, ourText, ourText, ourVoicemail],
  followUpCadence: {
    status: "active",
    kind,
    stepIndex: lastSentStep + 1,
    lastSentStep,
    anchorAt: "2026-05-14T00:00:00.000Z"
  }
});

check("threshold is 9 touches (Joe's choice)", () => {
  assert.equal(DISENGAGED_TAPER_AFTER_TOUCHES, 9);
});

check("customerEngagedWithCadence false when only ADF lead + our outbound", () => {
  assert.equal(customerEngagedWithCadence(silentConv(9) as any), false);
});

check("customerEngagedWithCadence true once the customer texts back", () => {
  const c = silentConv(9) as any;
  c.messages.push(customerReply);
  assert.equal(customerEngagedWithCadence(c), true);
});

check("a voicemail we left does NOT count as engagement", () => {
  const c = { messages: [adfLead, ourVoicemail], followUpCadence: { kind: "engaged" } } as any;
  assert.equal(customerEngagedWithCadence(c), false);
});

check("close-out fires for a silent lead at the taper step", () => {
  assert.equal(shouldSendDisengagedCloseout(silentConv(9) as any, 10), true);
  assert.equal(shouldSendDisengagedCloseout(silentConv(8) as any, 9), true); // 9th->10th touch boundary
});

check("close-out does NOT fire before the threshold", () => {
  assert.equal(shouldSendDisengagedCloseout(silentConv(3) as any, 4), false);
  assert.equal(shouldSendDisengagedCloseout(silentConv(7) as any, 8), false);
});

check("close-out never fires for an engaged lead", () => {
  const c = silentConv(11) as any;
  c.messages.push(customerReply);
  assert.equal(shouldSendDisengagedCloseout(c, 12), false);
});

check("close-out never fires for post-sale / long-term cadences", () => {
  assert.equal(shouldSendDisengagedCloseout(silentConv(11, "post_sale") as any, 12), false);
  assert.equal(shouldSendDisengagedCloseout(silentConv(11, "long_term") as any, 12), false);
});

check("close-out copy is human, names the lead, invites re-engagement, no em-dash", () => {
  const text = buildDisengagedCadenceCloseout("Michael");
  assert.ok(text.includes("Michael"), "should greet by first name");
  assert.ok(/text me anytime/i.test(text), "should invite the customer to reach back");
  assert.ok(!text.includes("—"), "no em-dash (voice charter)");
  // banned-filler guard
  assert.ok(!/just checking in|i'm here if you need anything/i.test(text), "no banned filler");
  assert.ok(buildDisengagedCadenceCloseout("").includes("there"), "falls back to 'there' with no name");
});

check("advanceFollowUpCadence ENDS the cadence after the close-out touch for a silent lead", () => {
  const c = silentConv(8) as any; // about to send step 9 (the 10th touch / close-out)
  advanceFollowUpCadence(c, "America/New_York");
  assert.equal(c.followUpCadence.lastSentStep, 9, "recorded the close-out touch");
  assert.equal(c.followUpCadence.status, "completed", "cadence ends");
  assert.equal(c.followUpCadence.stopReason, "disengaged_taper");
  assert.equal(c.followUpCadence.nextDueAt, undefined, "nothing more scheduled");
});

check("advanceFollowUpCadence KEEPS GOING for an engaged lead at the same step", () => {
  const c = silentConv(8) as any;
  c.messages.push(customerReply);
  advanceFollowUpCadence(c, "America/New_York");
  assert.equal(c.followUpCadence.status, "active", "engaged lead keeps its cadence");
  assert.ok(c.followUpCadence.nextDueAt, "next touch still scheduled");
});

check("advanceFollowUpCadence does NOT taper a silent lead below threshold", () => {
  const c = silentConv(3) as any; // sending step 4 (5th touch)
  advanceFollowUpCadence(c, "America/New_York");
  assert.equal(c.followUpCadence.status, "active");
  assert.ok(c.followUpCadence.nextDueAt);
});

console.log(`\nDisengaged taper: ${passed} checks passed`);
if (fail.length) {
  console.error(`\n${fail.length} failures`);
  process.exit(1);
}
console.log("PASS disengaged taper eval");
