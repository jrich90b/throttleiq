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

check("close-out never puts words in a silent customer's mouth (Joe ruling 2026-07-29, Syed John)", () => {
  const text = buildDisengagedCadenceCloseout("Syed");
  // This branch fires ONLY when customerEngagedWithCadence is false — nobody here has told us
  // anything — so any frame implying the customer asked for space/time is fabricated by
  // construction. Syed had even taken Giovanni's call two days before he got the old copy.
  for (const fabricated of [
    /no rush/i,
    /take your time/i,
    /whenever you.?re ready/i,
    /when the time is right/i,
    /you mentioned/i,
    /sounds like you/i,
    /since you.?re not ready/i
  ]) {
    assert.ok(!fabricated.test(text), `close-out must not imply the customer asked for space (${fabricated})`);
  }
  // It must still say WHY we're stopping (our reason) and keep the door open.
  assert.ok(/pause|stop/i.test(text), "names that we are backing off");
  assert.ok(/text me anytime/i.test(text), "door stays open");
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

// ---------------------------------------------------------------------------
// The close-out is not graded by the value-add cadence rubric.
//
// The cadence-quality judge asks "does this proactive touch carry a concrete
// reason to reach out?". A deliberate sign-off can never answer yes, so the
// judge verdicted `suppress` on it ~100% of the time it saw one: 26 live
// American Harley threads 2026-07-13..07-30, of which 25 were then GHOSTED —
// the cadence ended with NO close-out at all, which is precisely the silent
// drop-off this taper exists to replace. The sibling deterministic VALUE gate
// already excludes the close-out (`!disengagedCloseoutActive`); the LLM gate
// was the one proactive-touch gate in that loop that did not.
// ---------------------------------------------------------------------------
const apiSrc = fs.readFileSync(
  new URL("../services/api/src/index.ts", import.meta.url),
  "utf8"
);

check("the cadence-quality judge returns NO OPINION for the close-out class", () => {
  const fn = apiSrc.slice(apiSrc.indexOf("async function runCadenceQualityJudgeShadow("));
  assert.ok(fn.length > 0, "runCadenceQualityJudgeShadow must exist");
  const body = fn.slice(0, fn.indexOf("const verdict = await judgeCadenceQualityWithLLM"));
  assert.ok(
    /opts\?\.messageClass === "disengaged_closeout"\s*\)?\s*return null;/.test(body),
    "the close-out class must short-circuit BEFORE the LLM judge call (otherwise the false-positive cadence_quality_suppressed row is still written)"
  );
});

check("BOTH cadence-judge call sites scope the message class off disengagedCloseoutActive", () => {
  const calls = apiSrc.match(/runCadenceQualityJudgeShadow\((?:[^;]|\n){0,400}?\)/g) ?? [];
  const callSites = calls.filter((c) => !c.startsWith("runCadenceQualityJudgeShadow(\n  conv: any"));
  assert.equal(callSites.length, 2, `expected exactly 2 call sites, found ${callSites.length}`);
  for (const site of callSites) {
    assert.ok(
      /messageClass:\s*disengagedCloseoutActive\s*\?\s*"disengaged_closeout"\s*:\s*"value_add"/.test(site),
      `call site must pass the class derived from disengagedCloseoutActive: ${site.slice(0, 160)}`
    );
  }
});

check("a suppressed proactive touch still ENDS the taper (never re-queues the lead)", () => {
  // The enforce branch advances the cadence and skips the send. Whether the
  // close-out sent or was held, the sequence must terminate identically — a
  // future change must not turn suppression into "try this lead again later".
  const c = silentConv(8) as any;
  advanceFollowUpCadence(c, "America/New_York");
  assert.equal(c.followUpCadence.status, "completed", "suppressed touch still completes the cadence");
  assert.equal(c.followUpCadence.stopReason, "disengaged_taper");
  assert.equal(c.followUpCadence.nextDueAt, undefined, "no re-queue — we do not go back to pestering");
});

// ---------------------------------------------------------------------------
// A REAL PHONE CONVERSATION COUNTS AS ENGAGEMENT (Joe ruling 2026-07-30, option B).
//
// Voice rows are all direction "out" because WE placed the call, so a customer who genuinely
// talked to a salesperson still read as "never responded" and could be tapered with "I'll pause my
// check-ins here". Syed John (+12065383753) got that two days after taking Giovanni's call.
// Measured on the live store before the fix: 35 tapered leads, 26 with call activity, but only 3
// with a genuine two-way conversation — the widening is deliberately tiny.
// ---------------------------------------------------------------------------
const { voiceCallCountsAsEngagement, hasParticipatedVoiceCall, VOICE_PARTICIPATION_MIN_CONFIDENCE } =
  await import("../services/api/src/domain/conversationStore.ts");

const spokeOnCall = {
  direction: "out",
  provider: "voice_transcript",
  body: "Customer: I'm good. Where are you from?",
  customerSpokeOnCall: true
};

check("a parser-confirmed live call marks the lead engaged", () => {
  const c = silentConv(DISENGAGED_TAPER_AFTER_TOUCHES) as any;
  c.messages = [adfLead, ourText, spokeOnCall];
  assert.equal(hasParticipatedVoiceCall(c), true);
  assert.equal(customerEngagedWithCadence(c), true, "Syed talked to Gio — that is engagement");
  assert.equal(
    shouldSendDisengagedCloseout(c, DISENGAGED_TAPER_AFTER_TOUCHES),
    false,
    "a lead who actually spoke with us must not get the disengagement close-out"
  );
});

check("an unstamped voicemail still tapers (the other 23 of 26)", () => {
  const c = silentConv(DISENGAGED_TAPER_AFTER_TOUCHES) as any;
  c.messages = [adfLead, ourText, ourVoicemail];
  assert.equal(hasParticipatedVoiceCall(c), false);
  assert.equal(customerEngagedWithCadence(c), false, "a voicemail is not a conversation");
  assert.equal(shouldSendDisengagedCloseout(c, DISENGAGED_TAPER_AFTER_TOUCHES), true);
});

check("a stamped call keeps the cadence running instead of completing it", () => {
  const c = silentConv(8) as any;
  c.messages.push(spokeOnCall);
  advanceFollowUpCadence(c, "America/New_York");
  assert.equal(c.followUpCadence.status, "active", "a lead who spoke with us keeps its cadence");
  assert.notEqual(c.followUpCadence.stopReason, "disengaged_taper");
});

// The stamp gate: ONLY a high-confidence, explicitly live two-way conversation qualifies.
check("voiceCallCountsAsEngagement accepts a confident live conversation", () => {
  assert.equal(
    voiceCallCountsAsEngagement({ customerParticipated: true, outcome: "live_conversation", confidence: 0.96 }),
    true
  );
  assert.equal(
    voiceCallCountsAsEngagement({
      customerParticipated: true,
      outcome: "live_conversation",
      confidence: VOICE_PARTICIPATION_MIN_CONFIDENCE
    }),
    true,
    "the floor is inclusive"
  );
});

check("every uncertain or non-conversation read fails toward NOT engaged", () => {
  // Fail direction: a false positive keeps texting someone who never answered, so anything short
  // of a confident live conversation must resolve to false — i.e. today's behavior.
  const cases: [string, any][] = [
    ["no parse (parser off or errored)", null],
    ["voicemail", { customerParticipated: false, outcome: "voicemail", confidence: 0.94 }],
    ["no answer", { customerParticipated: false, outcome: "no_answer", confidence: 0.95 }],
    ["IVR / hold loop", { customerParticipated: false, outcome: "ivr_or_system", confidence: 0.93 }],
    ["unclear", { customerParticipated: true, outcome: "unclear", confidence: 0.99 }],
    ["low confidence", { customerParticipated: true, outcome: "live_conversation", confidence: 0.6 }],
    ["missing confidence", { customerParticipated: true, outcome: "live_conversation" }],
    // The answering-machine trap: the transcript labels it "Customer:" and it SOUNDS conversational,
    // but participated=false. A loose read of participation alone would wrongly engage this lead.
    [
      "answering-machine greeting in the customer's own voice",
      { customerParticipated: false, outcome: "voicemail", confidence: 0.9 }
    ]
  ];
  for (const [label, parse] of cases) {
    assert.equal(voiceCallCountsAsEngagement(parse), false, `${label} => not engagement`);
  }
});

// Source pin: the "was this a real conversation?" call is the PARSER's, never a keyword test, and
// the sync engagement read only consults the stamped structured state.
check("participation is parser-decided and stamped at ingest", () => {
  const apiSrc = fs.readFileSync(path.resolve("services/api/src/index.ts"), "utf8");
  assert.ok(
    /parseVoiceCallParticipationWithLLM\(\{/.test(apiSrc),
    "the voice ingest must ask the typed parser whether the customer took part"
  );
  assert.ok(
    /voiceCallCountsAsEngagement\(voiceParticipation\)/.test(apiSrc),
    "the pure gate decides whether the parse is strong enough to stamp"
  );
  const storeSrc = fs.readFileSync(
    path.resolve("services/api/src/domain/conversationStore.ts"),
    "utf8"
  );
  const fnIdx = storeSrc.indexOf("export function customerEngagedWithCadence");
  assert.ok(fnIdx > 0, "the engagement read must exist");
  const fnBody = storeSrc.slice(fnIdx, storeSrc.indexOf("\n}", fnIdx));
  assert.ok(
    /hasParticipatedVoiceCall\(conv\)/.test(fnBody),
    "engagement reads the stamp, staying pure and sync"
  );
  assert.ok(
    !/voicemail|no answer|transcript/i.test(fnBody),
    "no keyword test may leak into the engagement read — that judgement belongs to the parser"
  );
});

// LLM arm: the whole ruling rests on the parser separating a real conversation from an
// answering-machine greeting recorded in the customer's OWN voice. Pinned against 8 REAL
// production call records (scripts/fixtures/voice_participation_fixtures.json), including the
// three genuine conversations (Faith, Devin, Syed) and the traps that fooled the generated
// summaries. Runs only with a key + LLM_ENABLED.
if (process.env.LLM_ENABLED === "1" && process.env.OPENAI_API_KEY) {
  const { parseVoiceCallParticipationWithLLM } = await import(
    "../services/api/src/domain/llmDraft.ts"
  );
  const fixtures = JSON.parse(
    fs.readFileSync(path.resolve("scripts/fixtures/voice_participation_fixtures.json"), "utf8")
  ) as { leadKey: string; expectEngagement: boolean; transcript: string }[];
  let correct = 0;
  for (const f of fixtures) {
    const parse = await parseVoiceCallParticipationWithLLM({ text: f.transcript });
    const got = voiceCallCountsAsEngagement(parse);
    check(`voice participation: ${f.leadKey} => ${f.expectEngagement ? "engaged" : "not engaged"}`, () => {
      assert.equal(
        got,
        f.expectEngagement,
        `expected ${f.expectEngagement}, got ${got} (outcome=${parse?.outcome} conf=${parse?.confidence})`
      );
    });
    if (got === f.expectEngagement) correct += 1;
  }
  console.log(`  voice-participation LLM arm: ${correct}/${fixtures.length} real call records correct`);
}

console.log(`\nDisengaged taper: ${passed} checks passed`);
if (fail.length) {
  console.error(`\n${fail.length} failures`);
  process.exit(1);
}
console.log("PASS disengaged taper eval");
